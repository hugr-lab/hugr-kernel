// Package schema provides cached, lazy GraphQL schema introspection.
package schema

import (
	"container/list"
	"context"
	"fmt"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"

	"github.com/hugr-lab/hugr-kernel/internal/connection"
	"github.com/hugr-lab/hugr-kernel/internal/debug"
)

const (
	IntrospectionTTL = 10 * time.Minute
	DefaultTimeout   = 2 * time.Second
	MaxTypeCacheSize = 1000
)

// TypeRef represents a GraphQL type reference with wrapping.
type TypeRef struct {
	Name   *string  `json:"name"`
	Kind   string   `json:"kind"`
	OfType *TypeRef `json:"ofType"`
}

// UnwrapName returns the underlying named type, stripping NonNull/List wrappers.
func (t *TypeRef) UnwrapName() string {
	if t == nil {
		return ""
	}
	if t.Name != nil {
		return *t.Name
	}
	if t.OfType != nil {
		return t.OfType.UnwrapName()
	}
	return ""
}

// Format returns a human-readable type string like "[String!]!".
func (t *TypeRef) Format() string {
	if t == nil {
		return ""
	}
	switch t.Kind {
	case "NON_NULL":
		if t.OfType != nil {
			return t.OfType.Format() + "!"
		}
	case "LIST":
		if t.OfType != nil {
			return "[" + t.OfType.Format() + "]"
		}
	default:
		if t.Name != nil {
			return *t.Name
		}
	}
	return ""
}

type ArgInfo struct {
	Name         string  `json:"name"`
	Description  string  `json:"description"`
	Type         TypeRef `json:"type"`
	DefaultValue *string `json:"defaultValue"`
}

type FieldInfo struct {
	Name              string    `json:"name"`
	Description       string    `json:"description"`
	Type              TypeRef   `json:"type"`
	Args              []ArgInfo `json:"args"`
	IsDeprecated      bool      `json:"isDeprecated"`
	DeprecationReason string    `json:"deprecationReason"`
}

type EnumValue struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

type InputFieldInfo struct {
	Name         string  `json:"name"`
	Description  string  `json:"description"`
	Type         TypeRef `json:"type"`
	DefaultValue *string `json:"defaultValue"`
}

type TypeInfo struct {
	Name        string           `json:"name"`
	Kind        string           `json:"kind"`
	Description string           `json:"description"`
	Fields      []FieldInfo      `json:"fields"`
	EnumValues  []EnumValue      `json:"enumValues"`
	InputFields []InputFieldInfo `json:"inputFields"`
}

type DirectiveInfo struct {
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Locations   []string  `json:"locations"`
	Args        []ArgInfo `json:"args"`
}

type RootTypes struct {
	QueryType        *nameHolder `json:"queryType"`
	MutationType     *nameHolder `json:"mutationType"`
	SubscriptionType *nameHolder `json:"subscriptionType"`
}

type nameHolder struct {
	Name string `json:"name"`
}

type cacheEntry[T any] struct {
	value     T
	expiresAt time.Time
}

func (e *cacheEntry[T]) expired() bool {
	return time.Now().After(e.expiresAt)
}

// lruCache is a thread-safe LRU cache with TTL support.
type lruCache[T any] struct {
	mu       sync.Mutex
	capacity int
	items    map[string]*list.Element
	order    *list.List // front = most recently used
}

type lruEntry[T any] struct {
	key   string
	entry *cacheEntry[T]
}

func newLRUCache[T any](capacity int) *lruCache[T] {
	return &lruCache[T]{
		capacity: capacity,
		items:    make(map[string]*list.Element, capacity),
		order:    list.New(),
	}
}

// get returns the cached value if present and not expired.
func (c *lruCache[T]) get(key string) (T, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	elem, ok := c.items[key]
	if !ok {
		var zero T
		return zero, false
	}
	entry := elem.Value.(*lruEntry[T])
	if entry.entry.expired() {
		// Remove expired entry
		c.order.Remove(elem)
		delete(c.items, key)
		var zero T
		return zero, false
	}
	// Move to front (most recently used)
	c.order.MoveToFront(elem)
	return entry.entry.value, true
}

// put adds or updates a value in the cache, evicting LRU if at capacity.
func (c *lruCache[T]) put(key string, value T, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if elem, ok := c.items[key]; ok {
		// Update existing entry and move to front
		entry := elem.Value.(*lruEntry[T])
		entry.entry.value = value
		entry.entry.expiresAt = time.Now().Add(ttl)
		c.order.MoveToFront(elem)
		return
	}

	// Evict LRU if at capacity
	if c.order.Len() >= c.capacity {
		back := c.order.Back()
		if back != nil {
			evicted := back.Value.(*lruEntry[T])
			c.order.Remove(back)
			delete(c.items, evicted.key)
		}
	}

	elem := c.order.PushFront(&lruEntry[T]{
		key: key,
		entry: &cacheEntry[T]{
			value:     value,
			expiresAt: time.Now().Add(ttl),
		},
	})
	c.items[key] = elem
}

// clear removes all entries.
func (c *lruCache[T]) clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.items = make(map[string]*list.Element, c.capacity)
	c.order.Init()
}

// Client provides cached GraphQL schema introspection.
type Client struct {
	mu         sync.RWMutex
	typeCache  *lruCache[*TypeInfo]
	roots      *cacheEntry[*RootTypes]
	directives *cacheEntry[[]DirectiveInfo]
	ttl        time.Duration
	sfGroup    singleflight.Group
}

func NewClient() *Client {
	return &Client{
		typeCache: newLRUCache[*TypeInfo](MaxTypeCacheSize),
		ttl:       IntrospectionTTL,
	}
}

// Invalidate clears all caches.
func (c *Client) Invalidate() {
	c.typeCache.clear()
	c.mu.Lock()
	defer c.mu.Unlock()
	c.roots = nil
	c.directives = nil
}

// GetTypeFields returns the fields of the named type.
func (c *Client) GetTypeFields(ctx context.Context, conn *connection.Connection, typeName string) ([]FieldInfo, error) {
	ti, err := c.GetType(ctx, conn, typeName)
	if err != nil {
		return nil, err
	}
	if ti == nil {
		return nil, nil
	}
	return ti.Fields, nil
}

// GetType returns full type info, using cache when available.
func (c *Client) GetType(ctx context.Context, conn *connection.Connection, typeName string) (*TypeInfo, error) {
	// Check LRU cache first
	if val, ok := c.typeCache.get(typeName); ok {
		return val, nil
	}

	// Use singleflight to deduplicate concurrent requests for the same type
	key := "type:" + typeName
	v, err, _ := c.sfGroup.Do(key, func() (any, error) {
		// Double-check cache after winning the singleflight race
		if val, ok := c.typeCache.get(typeName); ok {
			return val, nil
		}

		resp, err := conn.Query(ctx, typeQuery, map[string]any{"name": typeName})
		if err != nil {
			return nil, fmt.Errorf("introspection query failed: %w", err)
		}
		defer resp.Close()
		if resp.Err() != nil {
			return nil, fmt.Errorf("introspection error: %w", resp.Err())
		}

		var ti TypeInfo
		if err := resp.ScanData("__type", &ti); err != nil {
			debug.Printf("[schema] ScanData __type failed for %s: %v", typeName, err)
			return nil, nil
		}

		c.typeCache.put(typeName, &ti, c.ttl)
		return &ti, nil
	})
	if err != nil {
		return nil, err
	}
	if v == nil {
		return nil, nil
	}
	return v.(*TypeInfo), nil
}

// GetRootTypes returns the root type names (Query, Mutation, Subscription).
func (c *Client) GetRootTypes(ctx context.Context, conn *connection.Connection) (*RootTypes, error) {
	c.mu.RLock()
	if c.roots != nil && !c.roots.expired() {
		val := c.roots.value
		c.mu.RUnlock()
		return val, nil
	}
	c.mu.RUnlock()

	// Use singleflight to deduplicate concurrent requests
	v, err, _ := c.sfGroup.Do("roots", func() (any, error) {
		// Double-check cache
		c.mu.RLock()
		if c.roots != nil && !c.roots.expired() {
			val := c.roots.value
			c.mu.RUnlock()
			return val, nil
		}
		c.mu.RUnlock()

		resp, err := conn.Query(ctx, rootTypesQuery, nil)
		if err != nil {
			return nil, err
		}
		defer resp.Close()
		if resp.Err() != nil {
			return nil, resp.Err()
		}

		var roots RootTypes
		if err := resp.ScanData("__schema", &roots); err != nil {
			return nil, err
		}

		c.mu.Lock()
		c.roots = &cacheEntry[*RootTypes]{value: &roots, expiresAt: time.Now().Add(c.ttl)}
		c.mu.Unlock()

		return &roots, nil
	})
	if err != nil {
		return nil, err
	}
	return v.(*RootTypes), nil
}

// GetDirectives returns all schema directives.
func (c *Client) GetDirectives(ctx context.Context, conn *connection.Connection) ([]DirectiveInfo, error) {
	c.mu.RLock()
	if c.directives != nil && !c.directives.expired() {
		val := c.directives.value
		c.mu.RUnlock()
		return val, nil
	}
	c.mu.RUnlock()

	// Use singleflight to deduplicate concurrent requests
	v, err, _ := c.sfGroup.Do("directives", func() (any, error) {
		// Double-check cache
		c.mu.RLock()
		if c.directives != nil && !c.directives.expired() {
			val := c.directives.value
			c.mu.RUnlock()
			return val, nil
		}
		c.mu.RUnlock()

		resp, err := conn.Query(ctx, directivesQuery, nil)
		if err != nil {
			return nil, err
		}
		defer resp.Close()
		if resp.Err() != nil {
			return nil, resp.Err()
		}

		// Parse __schema.directives
		var schemaResult struct {
			Directives []DirectiveInfo `json:"directives"`
		}
		if err := resp.ScanData("__schema", &schemaResult); err != nil {
			return nil, err
		}
		dirs := schemaResult.Directives

		c.mu.Lock()
		c.directives = &cacheEntry[[]DirectiveInfo]{value: dirs, expiresAt: time.Now().Add(c.ttl)}
		c.mu.Unlock()

		return dirs, nil
	})
	if err != nil {
		return nil, err
	}
	if v == nil {
		return nil, nil
	}
	return v.([]DirectiveInfo), nil
}

// ResolveFieldPath walks a field path (e.g., ["core", "catalog", "types"])
// starting from the appropriate root type (Query or Mutation), resolving each field's return type.
// operationType should be "query", "mutation", "subscription", or "" (defaults to query).
func (c *Client) ResolveFieldPath(ctx context.Context, conn *connection.Connection, path []string, operationType string) (*TypeInfo, string, error) {
	currentType := "Query"

	// Get root type name based on operation type
	roots, err := c.GetRootTypes(ctx, conn)
	if err == nil && roots != nil {
		switch operationType {
		case "mutation":
			if roots.MutationType != nil {
				currentType = roots.MutationType.Name
			}
		case "subscription":
			if roots.SubscriptionType != nil {
				currentType = roots.SubscriptionType.Name
			}
		default:
			if roots.QueryType != nil {
				currentType = roots.QueryType.Name
			}
		}
	}

	for _, fieldName := range path {
		fields, err := c.GetTypeFields(ctx, conn, currentType)
		if err != nil {
			return nil, currentType, err
		}
		found := false
		for _, f := range fields {
			if f.Name == fieldName {
				nextType := f.Type.UnwrapName()
				if nextType == "" {
					return nil, currentType, nil
				}
				currentType = nextType
				found = true
				break
			}
		}
		if !found {
			return nil, currentType, nil
		}
	}

	ti, err := c.GetType(ctx, conn, currentType)
	return ti, currentType, err
}

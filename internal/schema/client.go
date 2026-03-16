// Package schema provides cached, lazy GraphQL schema introspection.
package schema

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/hugr-lab/hugr-kernel/internal/connection"
)

const (
	IntrospectionTTL = 30 * time.Minute
	DefaultTimeout   = 2 * time.Second
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
	Name              string  `json:"name"`
	Description       string  `json:"description"`
	Type              TypeRef `json:"type"`
	Args              []ArgInfo `json:"args"`
	IsDeprecated      bool   `json:"isDeprecated"`
	DeprecationReason string `json:"deprecationReason"`
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

// Client provides cached GraphQL schema introspection.
type Client struct {
	mu         sync.RWMutex
	typeCache  map[string]*cacheEntry[*TypeInfo]
	roots      *cacheEntry[*RootTypes]
	directives *cacheEntry[[]DirectiveInfo]
	ttl        time.Duration
}

func NewClient() *Client {
	return &Client{
		typeCache: make(map[string]*cacheEntry[*TypeInfo]),
		ttl:       IntrospectionTTL,
	}
}

// Invalidate clears all caches.
func (c *Client) Invalidate() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.typeCache = make(map[string]*cacheEntry[*TypeInfo])
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
	c.mu.RLock()
	if entry, ok := c.typeCache[typeName]; ok && !entry.expired() {
		c.mu.RUnlock()
		return entry.value, nil
	}
	c.mu.RUnlock()

	// Fetch from server
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
		log.Printf("[schema] ScanData __type failed for %s: %v", typeName, err)
		return nil, nil
	}

	c.mu.Lock()
	c.typeCache[typeName] = &cacheEntry[*TypeInfo]{value: &ti, expiresAt: time.Now().Add(c.ttl)}
	c.mu.Unlock()

	return &ti, nil
}

// GetRootTypes returns the root type names (Query, Mutation, Subscription).
func (c *Client) GetRootTypes(ctx context.Context, conn *connection.Connection) (*RootTypes, error) {
	c.mu.RLock()
	if c.roots != nil && !c.roots.expired() {
		c.mu.RUnlock()
		return c.roots.value, nil
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
}

// GetDirectives returns all schema directives.
func (c *Client) GetDirectives(ctx context.Context, conn *connection.Connection) ([]DirectiveInfo, error) {
	c.mu.RLock()
	if c.directives != nil && !c.directives.expired() {
		c.mu.RUnlock()
		return c.directives.value, nil
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
	raw := resp.DataPart("__schema")
	if raw == nil {
		return nil, nil
	}
	schemaMap, ok := raw.(map[string]any)
	if !ok {
		return nil, nil
	}
	dirsRaw, ok := schemaMap["directives"]
	if !ok {
		return nil, nil
	}

	// Re-marshal and unmarshal to get typed directives
	b, err := json.Marshal(dirsRaw)
	if err != nil {
		return nil, err
	}
	var dirs []DirectiveInfo
	if err := json.Unmarshal(b, &dirs); err != nil {
		return nil, err
	}

	c.mu.Lock()
	c.directives = &cacheEntry[[]DirectiveInfo]{value: dirs, expiresAt: time.Now().Add(c.ttl)}
	c.mu.Unlock()

	return dirs, nil
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

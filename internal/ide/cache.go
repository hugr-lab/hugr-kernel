package ide

import (
	"crypto/sha256"
	"encoding/hex"
	"sync"
	"time"
)

const (
	defaultCacheTTL  = 10 * time.Minute
	defaultCacheSize = 10000
)

type cacheEntry struct {
	data      any
	expiresAt time.Time
}

// Cache is a connection-scoped LRU cache for schema projections.
type Cache struct {
	mu      sync.RWMutex
	entries map[string]*cacheEntry
	maxSize int
	ttl     time.Duration
}

// NewCache creates a new cache with default settings.
func NewCache() *Cache {
	return &Cache{
		entries: make(map[string]*cacheEntry),
		maxSize: defaultCacheSize,
		ttl:     defaultCacheTTL,
	}
}

// cacheKey builds a cache key from connection name and query hash.
func cacheKey(connectionName, query string, vars map[string]any) string {
	h := sha256.New()
	h.Write([]byte(connectionName))
	h.Write([]byte("|"))
	h.Write([]byte(query))
	// Variables are not hashed for simplicity — completion queries use fixed variables.
	return hex.EncodeToString(h.Sum(nil))[:32]
}

// Get retrieves a cached value. Returns nil if not found or expired.
func (c *Cache) Get(connectionName, query string, vars map[string]any) any {
	key := cacheKey(connectionName, query, vars)
	c.mu.RLock()
	entry, ok := c.entries[key]
	c.mu.RUnlock()
	if !ok {
		return nil
	}
	if time.Now().After(entry.expiresAt) {
		c.mu.Lock()
		delete(c.entries, key)
		c.mu.Unlock()
		return nil
	}
	return entry.data
}

// Set stores a value in the cache.
func (c *Cache) Set(connectionName, query string, vars map[string]any, data any) {
	key := cacheKey(connectionName, query, vars)
	c.mu.Lock()
	defer c.mu.Unlock()

	// Evict oldest entries if at capacity
	if len(c.entries) >= c.maxSize {
		c.evictOldest()
	}

	c.entries[key] = &cacheEntry{
		data:      data,
		expiresAt: time.Now().Add(c.ttl),
	}
}

// InvalidateConnection removes all cached entries for a given connection.
func (c *Cache) InvalidateConnection(connectionName string) {
	c.mu.Lock()
	defer c.mu.Unlock()

	// Since keys are hashed, we can't filter by connection efficiently.
	// For simplicity, clear the entire cache on connection change.
	c.entries = make(map[string]*cacheEntry)
}

// InvalidateAll clears the entire cache.
func (c *Cache) InvalidateAll() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries = make(map[string]*cacheEntry)
}

// evictOldest removes the oldest 10% of entries. Must be called with mu held.
func (c *Cache) evictOldest() {
	toEvict := len(c.entries) / 10
	if toEvict < 1 {
		toEvict = 1
	}
	var oldest []string
	var oldestTimes []time.Time
	for k, v := range c.entries {
		if len(oldest) < toEvict {
			oldest = append(oldest, k)
			oldestTimes = append(oldestTimes, v.expiresAt)
			continue
		}
		for i, t := range oldestTimes {
			if v.expiresAt.Before(t) {
				oldest[i] = k
				oldestTimes[i] = v.expiresAt
				break
			}
		}
	}
	for _, k := range oldest {
		delete(c.entries, k)
	}
}

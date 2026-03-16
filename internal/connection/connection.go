package connection

import (
	"context"
	"fmt"
	"sync"

	"github.com/hugr-lab/query-engine/client"
	"github.com/hugr-lab/query-engine/types"
)

// AuthMode represents the authentication mode for a connection.
type AuthMode string

const (
	AuthPublic  AuthMode = "public"
	AuthAPIKey  AuthMode = "apikey"
	AuthBearer  AuthMode = "bearer"
	AuthOIDC    AuthMode = "oidc"
)

// Connection represents a named Hugr endpoint with its configuration.
type Connection struct {
	Name     string
	URL      string
	AuthMode AuthMode

	mu      sync.Mutex
	client  *client.Client
	options []client.Option
}

// NewConnection creates a new connection with the given name and URL.
func NewConnection(name, url string) *Connection {
	return &Connection{
		Name:     name,
		URL:      url,
		AuthMode: AuthPublic,
		client:   client.NewClient(url),
	}
}

// Query executes a GraphQL query with the given variables.
func (c *Connection) Query(ctx context.Context, query string, vars map[string]any) (*types.Response, error) {
	c.mu.Lock()
	cl := c.client
	c.mu.Unlock()
	if cl == nil {
		return nil, fmt.Errorf("connection %q not initialized", c.Name)
	}
	return cl.Query(ctx, query, vars)
}

// recreateClient rebuilds the client with current options. Must be called with mu held.
func (c *Connection) recreateClient() {
	c.client = client.NewClient(c.URL, c.options...)
}

// SetAPIKey sets the API key auth mode and recreates the client.
func (c *Connection) SetAPIKey(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.AuthMode = AuthAPIKey
	c.options = []client.Option{client.WithApiKey(key)}
	c.recreateClient()
}

// SetBearerToken sets the bearer auth mode and recreates the client.
func (c *Connection) SetBearerToken(token string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.AuthMode = AuthBearer
	c.options = []client.Option{client.WithToken(token)}
	c.recreateClient()
}

// SetAuthMode sets the authentication mode without recreating the client.
// Used when mode is set first, then credentials are provided separately.
func (c *Connection) SetAuthMode(mode AuthMode) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.AuthMode = mode
}

// SetPublic clears auth and recreates the client.
func (c *Connection) SetPublic() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.AuthMode = AuthPublic
	c.options = nil
	c.recreateClient()
}

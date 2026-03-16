package connection

import (
	"context"
	"fmt"

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
	Client   *client.Client
	Options  []client.Option
}

// NewConnection creates a new connection with the given name and URL.
func NewConnection(name, url string) *Connection {
	c := &Connection{
		Name:     name,
		URL:      url,
		AuthMode: AuthPublic,
	}
	c.Client = client.NewClient(url)
	return c
}

// Query executes a GraphQL query with the given variables.
func (c *Connection) Query(ctx context.Context, query string, vars map[string]any) (*types.Response, error) {
	if c.Client == nil {
		return nil, fmt.Errorf("connection %q not initialized", c.Name)
	}
	return c.Client.Query(ctx, query, vars)
}

// recreateClient rebuilds the client with current options.
func (c *Connection) recreateClient() {
	c.Client = client.NewClient(c.URL, c.Options...)
}

// SetAPIKey sets the API key auth mode and recreates the client.
func (c *Connection) SetAPIKey(key string) {
	c.AuthMode = AuthAPIKey
	c.Options = []client.Option{client.WithApiKey(key)}
	c.recreateClient()
}

// SetBearerToken sets the bearer auth mode and recreates the client.
func (c *Connection) SetBearerToken(token string) {
	c.AuthMode = AuthBearer
	c.Options = []client.Option{client.WithToken(token)}
	c.recreateClient()
}

// SetPublic clears auth and recreates the client.
func (c *Connection) SetPublic() {
	c.AuthMode = AuthPublic
	c.Options = nil
	c.recreateClient()
}

package connection

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"sync"
	"time"

	"github.com/hugr-lab/query-engine/client"
	"github.com/hugr-lab/query-engine/types"
)

// DefaultTimeout is the default HTTP client timeout for Hugr queries.
// Override per-connection via Connection.Timeout before first query.
const DefaultTimeout = 5 * time.Minute

// AuthMode represents the authentication mode for a connection.
type AuthMode string

const (
	AuthPublic     AuthMode = "public"
	AuthAPIKey     AuthMode = "apikey"
	AuthBearer     AuthMode = "bearer"
	AuthBrowser    AuthMode = "browser"
	AuthOIDC       AuthMode = "oidc"
	AuthHub AuthMode = "hub"
)

// Connection represents a named Hugr endpoint with its configuration.
type Connection struct {
	Name     string
	URL      string
	AuthMode AuthMode
	Managed  bool // Hub-managed connection, read-only for users
	Timeout  time.Duration

	// Browser auth token fields (in-memory cache, loaded from connections.json)
	accessToken string
	expiresAt   time.Time
	configPath  string // path to connections.json for re-reading on expiry

	mu      sync.Mutex
	client  *client.Client
	options []client.Option
}

// NewConnection creates a new connection with the given name and URL.
func NewConnection(name, url string) *Connection {
	c := &Connection{
		Name:     name,
		URL:      url,
		AuthMode: AuthPublic,
		Timeout:  DefaultTimeout,
	}
	c.client = client.NewClient(url, client.WithTimeout(c.Timeout))
	return c
}

// Query executes a GraphQL query with the given variables.
func (c *Connection) Query(ctx context.Context, query string, vars map[string]any) (*types.Response, error) {
	c.mu.Lock()
	mode := c.AuthMode
	c.mu.Unlock()

	// For browser/hub auth, check token expiry before executing
	if mode == AuthBrowser || mode == AuthHub {
		c.mu.Lock()
		hasToken := c.accessToken != ""
		needsRefresh := !hasToken || time.Until(c.expiresAt) < 5*time.Second
		c.mu.Unlock()

		if needsRefresh {
			if err := c.RefreshBrowserToken(); err != nil {
				if !hasToken {
					return nil, fmt.Errorf("not authenticated — please login via the connection manager UI")
				}
				return nil, fmt.Errorf("session expired — please re-login via the connection manager UI")
			}
		}
	}

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
	opts := append([]client.Option{client.WithTimeout(c.Timeout)}, c.options...)
	c.client = client.NewClient(c.URL, opts...)
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

// SetBrowserToken sets the browser auth mode with a cached access token.
func (c *Connection) SetBrowserToken(accessToken string, expiresAt time.Time, configPath string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.AuthMode = AuthBrowser
	c.accessToken = accessToken
	c.expiresAt = expiresAt
	c.configPath = configPath
	c.options = []client.Option{client.WithToken(accessToken)}
	c.recreateClient()
}

// RefreshBrowserToken re-reads connections.json and updates the in-memory token
// if a newer one is available. Returns an error if the token is still expired.
func (c *Connection) RefreshBrowserToken() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.configPath == "" {
		return fmt.Errorf("no config path set for connection %q", c.Name)
	}

	data, err := os.ReadFile(c.configPath)
	if err != nil {
		return fmt.Errorf("read config: %w", err)
	}

	var cfg struct {
		Connections []struct {
			Name   string `json:"name"`
			Tokens *struct {
				AccessToken string `json:"access_token"`
				ExpiresAt   int64  `json:"expires_at"`
			} `json:"tokens"`
		} `json:"connections"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return fmt.Errorf("parse config: %w", err)
	}

	for _, conn := range cfg.Connections {
		if conn.Name == c.Name && conn.Tokens != nil {
			newExpiry := time.Unix(conn.Tokens.ExpiresAt, 0)
			if newExpiry.After(c.expiresAt) || conn.Tokens.AccessToken != c.accessToken {
				c.accessToken = conn.Tokens.AccessToken
				c.expiresAt = newExpiry
				c.options = []client.Option{client.WithToken(c.accessToken)}
				c.recreateClient()
				log.Printf("Refreshed browser token for %q, expires at %s", c.Name, c.expiresAt.Format(time.RFC3339))
			}
			if time.Until(c.expiresAt) < 5*time.Second {
				return fmt.Errorf("session expired for connection %q, please re-login", c.Name)
			}
			return nil
		}
	}

	return fmt.Errorf("connection %q not found in config or has no tokens", c.Name)
}

// ExpiresAt returns the token expiry time for browser connections.
func (c *Connection) ExpiresAt() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.expiresAt
}

// IsAuthenticated returns true if the connection has a valid non-expired token.
// For browser connections, re-reads connections.json if the in-memory token is expired.
func (c *Connection) IsAuthenticated() bool {
	c.mu.Lock()
	mode := c.AuthMode
	hasToken := c.accessToken != ""
	valid := hasToken && time.Until(c.expiresAt) > 0
	c.mu.Unlock()

	if mode != AuthBrowser {
		return mode != AuthPublic
	}

	if valid {
		return true
	}

	// Token expired in memory — try re-reading from file
	if err := c.RefreshBrowserToken(); err != nil {
		return false
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	return c.accessToken != "" && time.Until(c.expiresAt) > 0
}

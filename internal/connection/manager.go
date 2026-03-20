package connection

import (
	"fmt"
	"sync"
	"time"
)

// Manager manages the set of connections and tracks the default.
type Manager struct {
	connections  map[string]*Connection
	defaultName  string
	queryTimeout time.Duration
	mu           sync.RWMutex
}

// NewManager creates a new connection manager.
func NewManager() *Manager {
	return &Manager{
		connections:  make(map[string]*Connection),
		queryTimeout: DefaultTimeout,
	}
}

// SetQueryTimeout sets the timeout for all new connections.
func (m *Manager) SetQueryTimeout(d time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.queryTimeout = d
}

// Add creates and registers a new connection. The first connection becomes the default.
func (m *Manager) Add(name, url string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	conn := NewConnection(name, url)
	conn.Timeout = m.queryTimeout
	conn.recreateClient()
	m.connections[name] = conn
	if m.defaultName == "" {
		m.defaultName = name
	}
}

// Remove deletes a connection by name.
func (m *Manager) Remove(name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, ok := m.connections[name]; !ok {
		return fmt.Errorf("connection %q not found", name)
	}
	delete(m.connections, name)
	if m.defaultName == name {
		m.defaultName = ""
		for n := range m.connections {
			m.defaultName = n
			break
		}
	}
	return nil
}

// Get returns a connection by name.
func (m *Manager) Get(name string) (*Connection, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	conn, ok := m.connections[name]
	if !ok {
		return nil, fmt.Errorf("connection %q not found. Available: %s", name, m.listNames())
	}
	return conn, nil
}

// GetDefault returns the default connection, or nil if none configured.
func (m *Manager) GetDefault() *Connection {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if m.defaultName == "" {
		return nil
	}
	return m.connections[m.defaultName]
}

// SetDefault changes the default connection.
func (m *Manager) SetDefault(name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, ok := m.connections[name]; !ok {
		return fmt.Errorf("connection %q not found. Available: %s", name, m.listNames())
	}
	m.defaultName = name
	return nil
}

// List returns all connections as a slice.
func (m *Manager) List() []*Connection {
	m.mu.RLock()
	defer m.mu.RUnlock()

	conns := make([]*Connection, 0, len(m.connections))
	for _, c := range m.connections {
		conns = append(conns, c)
	}
	return conns
}

// DefaultName returns the name of the current default connection.
func (m *Manager) DefaultName() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.defaultName
}

// Count returns the number of connections.
func (m *Manager) Count() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.connections)
}

func (m *Manager) listNames() string {
	names := ""
	for n := range m.connections {
		if names != "" {
			names += ", "
		}
		names += n
	}
	if names == "" {
		return "(none)"
	}
	return names
}

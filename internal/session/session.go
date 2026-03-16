package session

import (
	"encoding/json"
	"fmt"
	"sync"
)

// Session holds kernel execution context for the lifetime of the kernel process.
type Session struct {
	ID             string
	Variables      map[string]any
	executionCount int
	mu             sync.Mutex
}

// NewSession creates a new session with the given ID.
func NewSession(id string) *Session {
	return &Session{
		ID:        id,
		Variables: make(map[string]any),
	}
}

// NextExecutionCount increments and returns the execution count.
func (s *Session) NextExecutionCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.executionCount++
	return s.executionCount
}

// SetVars parses a JSON string and merges the resulting map into session variables.
func (s *Session) SetVars(jsonStr string) error {
	var vars map[string]any
	if err := json.Unmarshal([]byte(jsonStr), &vars); err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, v := range vars {
		s.Variables[k] = v
	}
	return nil
}

// ShowVars returns the current session variables as a formatted JSON string.
func (s *Session) ShowVars() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.Variables) == 0 {
		return "No session variables set."
	}
	data, err := json.MarshalIndent(s.Variables, "", "  ")
	if err != nil {
		return fmt.Sprintf("Error formatting variables: %v", err)
	}
	return string(data)
}

// ClearVars removes all session variables.
func (s *Session) ClearVars() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Variables = make(map[string]any)
}

// GetVariables returns a copy of the current session variables.
func (s *Session) GetVariables() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	vars := make(map[string]any, len(s.Variables))
	for k, v := range s.Variables {
		vars[k] = v
	}
	return vars
}

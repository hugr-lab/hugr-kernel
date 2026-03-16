package meta

import (
	"context"
	"fmt"
	"strings"
)

// CommandResult holds the output of a meta command.
type CommandResult struct {
	Text string
	JSON any
}

// CommandFunc is the signature for meta command handlers.
type CommandFunc func(ctx context.Context, cmd ParsedCommand) (*CommandResult, error)

// Registry manages meta command registration and dispatch.
type Registry struct {
	commands map[string]CommandFunc
}

// NewRegistry creates a new meta command registry.
func NewRegistry() *Registry {
	return &Registry{
		commands: make(map[string]CommandFunc),
	}
}

// Register adds a command handler to the registry.
func (r *Registry) Register(name string, fn CommandFunc) {
	r.commands[strings.ToLower(name)] = fn
}

// Dispatch parses cell code and executes any meta commands found.
// Returns the combined result and any remaining GraphQL body.
func (r *Registry) Dispatch(ctx context.Context, code string) ([]*CommandResult, string, error) {
	commands := Parse(code)
	if len(commands) == 0 {
		return nil, code, nil
	}

	var results []*CommandResult
	var graphqlBody string

	for _, cmd := range commands {
		fn, ok := r.commands[cmd.Name]
		if !ok {
			available := r.availableCommands()
			return nil, "", fmt.Errorf("unknown command :%s. Available commands: %s", cmd.Name, available)
		}

		result, err := fn(ctx, cmd)
		if err != nil {
			return nil, "", err
		}
		if result != nil {
			results = append(results, result)
		}

		// setvars consumes its body as JSON input, not as a GraphQL query
		if cmd.Body != "" && cmd.Name != "setvars" {
			graphqlBody = cmd.Body
		}
	}

	return results, graphqlBody, nil
}

func (r *Registry) availableCommands() string {
	names := make([]string, 0, len(r.commands))
	for name := range r.commands {
		names = append(names, ":"+name)
	}
	return strings.Join(names, ", ")
}

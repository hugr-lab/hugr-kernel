package meta

import (
	"strings"
)

// ParsedCommand represents a parsed meta command from cell input.
type ParsedCommand struct {
	Name string
	Args string
	Body string // remaining content after the command line (for GraphQL)
}

// IsMeta returns true if the code starts with a ':' meta command prefix.
func IsMeta(code string) bool {
	trimmed := strings.TrimSpace(code)
	return len(trimmed) > 0 && trimmed[0] == ':'
}

// Parse extracts meta commands and any remaining GraphQL body from cell input.
// A cell may contain one or more meta commands (one per line), optionally followed
// by a GraphQL query. The :setvars command consumes all remaining lines as JSON.
func Parse(code string) []ParsedCommand {
	lines := strings.Split(code, "\n")
	var commands []ParsedCommand

	i := 0
	for i < len(lines) {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			i++
			continue
		}

		if line[0] != ':' {
			// Not a meta command — remaining lines are GraphQL body
			body := strings.TrimSpace(strings.Join(lines[i:], "\n"))
			if len(commands) > 0 && body != "" {
				commands[len(commands)-1].Body = body
			}
			break
		}

		cmd := parseCommandLine(line)

		// :setvars consumes all remaining lines as JSON body
		if cmd.Name == "setvars" {
			remaining := strings.TrimSpace(strings.Join(lines[i+1:], "\n"))
			cmd.Body = remaining
			commands = append(commands, cmd)
			return commands
		}

		commands = append(commands, cmd)
		i++
	}

	return commands
}

func parseCommandLine(line string) ParsedCommand {
	// Remove the ':' prefix
	line = strings.TrimPrefix(line, ":")
	parts := strings.SplitN(line, " ", 2)
	cmd := ParsedCommand{
		Name: strings.ToLower(parts[0]),
	}
	if len(parts) > 1 {
		cmd.Args = strings.TrimSpace(parts[1])
	}
	return cmd
}

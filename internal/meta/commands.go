package meta

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/hugr-lab/hugr-kernel/internal/connection"
	"github.com/hugr-lab/hugr-kernel/internal/renderer"
	"github.com/hugr-lab/hugr-kernel/internal/session"
)

// RegisterCommands registers all meta commands into the registry.
func RegisterCommands(reg *Registry, sess *session.Session, cm *connection.Manager, startTime time.Time) {
	// Connection management
	reg.Register("connect", connectCommand(cm))
	reg.Register("use", useCommand(cm))
	reg.Register("connections", connectionsCommand(cm))

	// Authentication
	reg.Register("auth", authCommand(cm))
	reg.Register("key", keyCommand(cm))
	reg.Register("token", tokenCommand(cm))
	reg.Register("login", loginCommand(cm))
	reg.Register("logout", logoutCommand(cm))

	// Session variables
	reg.Register("setvars", setvarsCommand(sess))
	reg.Register("showvars", showvarsCommand(sess))
	reg.Register("clearvars", clearvarsCommand(sess))

	// Output modifiers
	reg.Register("json", jsonCommand())

	// Observability
	reg.Register("status", statusCommand(sess, cm, startTime))
	reg.Register("whoami", whoamiCommand(cm))
}

func connectCommand(cm *connection.Manager) CommandFunc {
	return func(ctx context.Context, cmd ParsedCommand) (*CommandResult, error) {
		parts := strings.SplitN(cmd.Args, " ", 2)
		if len(parts) < 2 {
			return nil, fmt.Errorf("usage: :connect <name> <url>")
		}
		name := parts[0]
		url := parts[1]
		cm.Add(name, url)
		isDefault := ""
		if cm.DefaultName() == name {
			isDefault = " (default)"
		}
		return &CommandResult{
			Text: fmt.Sprintf("Connected: %s → %s%s", name, url, isDefault),
		}, nil
	}
}

func useCommand(cm *connection.Manager) CommandFunc {
	return func(ctx context.Context, cmd ParsedCommand) (*CommandResult, error) {
		name := strings.TrimSpace(cmd.Args)
		if name == "" {
			return nil, fmt.Errorf("usage: :use <name>")
		}
		if cmd.Body != "" {
			if _, err := cm.Get(name); err != nil {
				return nil, err
			}
			return nil, nil
		}
		if err := cm.SetDefault(name); err != nil {
			return nil, err
		}
		return &CommandResult{
			Text: fmt.Sprintf("Default connection set to: %s", name),
		}, nil
	}
}

func connectionsCommand(cm *connection.Manager) CommandFunc {
	return func(ctx context.Context, cmd ParsedCommand) (*CommandResult, error) {
		conns := cm.List()
		if len(conns) == 0 {
			return &CommandResult{Text: "No connections configured."}, nil
		}

		defaultName := cm.DefaultName()
		columns := []string{"Name", "URL", "Auth", "Default"}
		rows := make([][]string, len(conns))
		for i, c := range conns {
			def := ""
			if c.Name == defaultName {
				def = "*"
			}
			rows[i] = []string{c.Name, c.URL, string(c.AuthMode), def}
		}

		return &CommandResult{
			Text: renderer.RenderTable(columns, rows),
			JSON: map[string]any{
				"connections": conns,
				"default":     defaultName,
			},
		}, nil
	}
}

func authCommand(cm *connection.Manager) CommandFunc {
	return func(ctx context.Context, cmd ParsedCommand) (*CommandResult, error) {
		mode := strings.TrimSpace(cmd.Args)
		if mode == "" {
			return nil, fmt.Errorf("usage: :auth <mode> (public, apikey, bearer, oidc)")
		}

		conn := cm.GetDefault()
		if conn == nil {
			return nil, fmt.Errorf("no connection configured")
		}

		switch connection.AuthMode(mode) {
		case connection.AuthPublic:
			conn.SetPublic()
		case connection.AuthAPIKey, connection.AuthBearer, connection.AuthOIDC:
			conn.AuthMode = connection.AuthMode(mode)
		default:
			return nil, fmt.Errorf("unknown auth mode: %s. Use: public, apikey, bearer, oidc", mode)
		}

		return &CommandResult{
			Text: fmt.Sprintf("Auth mode set to: %s for %s", mode, conn.Name),
		}, nil
	}
}

func keyCommand(cm *connection.Manager) CommandFunc {
	return func(ctx context.Context, cmd ParsedCommand) (*CommandResult, error) {
		key := strings.TrimSpace(cmd.Args)
		if key == "" {
			return nil, fmt.Errorf("usage: :key <api-key>")
		}

		conn := cm.GetDefault()
		if conn == nil {
			return nil, fmt.Errorf("no connection configured")
		}
		if conn.AuthMode != connection.AuthAPIKey {
			return nil, fmt.Errorf("set auth mode first: :auth apikey")
		}

		conn.SetAPIKey(key)

		return &CommandResult{
			Text: fmt.Sprintf("API key set for: %s", conn.Name),
		}, nil
	}
}

func tokenCommand(cm *connection.Manager) CommandFunc {
	return func(ctx context.Context, cmd ParsedCommand) (*CommandResult, error) {
		token := strings.TrimSpace(cmd.Args)
		if token == "" {
			return nil, fmt.Errorf("usage: :token <bearer-token>")
		}

		conn := cm.GetDefault()
		if conn == nil {
			return nil, fmt.Errorf("no connection configured")
		}
		if conn.AuthMode != connection.AuthBearer {
			return nil, fmt.Errorf("set auth mode first: :auth bearer")
		}

		conn.SetBearerToken(token)

		return &CommandResult{
			Text: fmt.Sprintf("Bearer token set for: %s", conn.Name),
		}, nil
	}
}

func loginCommand(cm *connection.Manager) CommandFunc {
	return func(ctx context.Context, cmd ParsedCommand) (*CommandResult, error) {
		name := strings.TrimSpace(cmd.Args)
		if name == "" {
			return nil, fmt.Errorf("usage: :login <connection>")
		}

		conn, err := cm.Get(name)
		if err != nil {
			return nil, err
		}
		if conn.AuthMode != connection.AuthOIDC {
			return nil, fmt.Errorf("connection %q is not configured for OIDC. Run: :auth oidc", name)
		}

		// TODO: Implement OIDC browser flow
		return &CommandResult{
			Text: fmt.Sprintf("OIDC login not yet implemented for: %s", name),
		}, nil
	}
}

func logoutCommand(cm *connection.Manager) CommandFunc {
	return func(ctx context.Context, cmd ParsedCommand) (*CommandResult, error) {
		name := strings.TrimSpace(cmd.Args)
		if name == "" {
			return nil, fmt.Errorf("usage: :logout <connection>")
		}

		conn, err := cm.Get(name)
		if err != nil {
			return nil, err
		}

		conn.SetPublic()

		return &CommandResult{
			Text: fmt.Sprintf("Logged out from: %s", name),
		}, nil
	}
}

func setvarsCommand(sess *session.Session) CommandFunc {
	return func(ctx context.Context, cmd ParsedCommand) (*CommandResult, error) {
		body := strings.TrimSpace(cmd.Body)
		if body == "" {
			body = strings.TrimSpace(cmd.Args)
		}
		if body == "" {
			return nil, fmt.Errorf("usage: :setvars followed by JSON on next lines")
		}

		if err := sess.SetVars(body); err != nil {
			return nil, fmt.Errorf("failed to set variables: %w", err)
		}

		return &CommandResult{
			Text: fmt.Sprintf("Variables set.\n%s", sess.ShowVars()),
		}, nil
	}
}

func showvarsCommand(sess *session.Session) CommandFunc {
	return func(ctx context.Context, cmd ParsedCommand) (*CommandResult, error) {
		return &CommandResult{
			Text: sess.ShowVars(),
			JSON: sess.GetVariables(),
		}, nil
	}
}

func clearvarsCommand(sess *session.Session) CommandFunc {
	return func(ctx context.Context, cmd ParsedCommand) (*CommandResult, error) {
		sess.ClearVars()
		return &CommandResult{
			Text: "Session variables cleared.",
		}, nil
	}
}

func statusCommand(sess *session.Session, cm *connection.Manager, startTime time.Time) CommandFunc {
	return func(ctx context.Context, cmd ParsedCommand) (*CommandResult, error) {
		uptime := time.Since(startTime).Round(time.Second)
		vars := sess.GetVariables()

		text := fmt.Sprintf(
			"Hugr GraphQL Kernel v0.1.0\n"+
				"Session: %s\n"+
				"Uptime: %s\n"+
				"Connections: %d\n"+
				"Variables: %d",
			sess.ID, uptime, cm.Count(), len(vars),
		)

		return &CommandResult{
			Text: text,
			JSON: map[string]any{
				"version":     "0.1.0",
				"session_id":  sess.ID,
				"uptime_sec":  int(uptime.Seconds()),
				"connections": cm.Count(),
				"variables":   len(vars),
			},
		}, nil
	}
}

func whoamiCommand(cm *connection.Manager) CommandFunc {
	return func(ctx context.Context, cmd ParsedCommand) (*CommandResult, error) {
		conn := cm.GetDefault()
		if conn == nil {
			return &CommandResult{Text: "No connection configured."}, nil
		}

		return &CommandResult{
			Text: fmt.Sprintf("Connection: %s\nAuth mode: %s", conn.Name, conn.AuthMode),
			JSON: map[string]any{
				"connection": conn.Name,
				"auth_mode":  string(conn.AuthMode),
			},
		}, nil
	}
}

// jsonCommand is a modifier flag — it returns nil so no display_data is emitted,
// but its presence in the parsed commands signals JSON output mode to the kernel.
func jsonCommand() CommandFunc {
	return func(ctx context.Context, cmd ParsedCommand) (*CommandResult, error) {
		return nil, nil
	}
}

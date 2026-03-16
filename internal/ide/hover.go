package ide

import (
	"context"
	"fmt"
	"strings"

	"github.com/hugr-lab/hugr-kernel/internal/connection"
)

// HoverInfo returns hover documentation for the token at the cursor position.
// Returns (found, plainText, markdown, error).
func HoverInfo(ctx context.Context, schema *SchemaClient, conn *connection.Connection, cursorCtx *CursorContext) (bool, string, string, error) {
	if cursorCtx.Prefix == "" {
		return false, "", "", nil
	}

	// Resolve the parent type to look up the field
	typeName, err := resolveTypeAtPath(ctx, schema, conn, cursorCtx.Path)
	if err != nil {
		return false, "", "", err
	}
	if typeName == "" {
		typeName = "Query"
	}

	// If we're hovering over a field name in a selection set
	if cursorCtx.Kind == ContextSelectionSet || cursorCtx.Kind == ContextArgument {
		return hoverField(ctx, schema, conn, typeName, cursorCtx.Prefix)
	}

	// If hovering over a directive
	if cursorCtx.Kind == ContextDirective && cursorCtx.DirectiveName != "" {
		return hoverDirective(ctx, schema, conn, cursorCtx.DirectiveName)
	}

	return false, "", "", nil
}

func hoverField(ctx context.Context, schema *SchemaClient, conn *connection.Connection, typeName, fieldName string) (bool, string, string, error) {
	typeInfo, err := schema.TypeInfo(ctx, conn, typeName)
	if err != nil {
		return false, "", "", err
	}
	if typeInfo == nil {
		return false, "", "", nil
	}

	fields, _ := typeInfo["fields"].([]any)
	for _, f := range fields {
		fm, ok := f.(map[string]any)
		if !ok {
			continue
		}
		if getString(fm, "name") != fieldName {
			continue
		}

		name := getString(fm, "name")
		typeStr := formatTypeRef(fm["type"])
		desc := getString(fm, "description")
		deprecated := false
		if v, ok := fm["isDeprecated"].(bool); ok {
			deprecated = v
		}
		deprecationReason := getString(fm, "deprecationReason")

		// Build args summary
		var argLines []string
		if args, ok := fm["args"].([]any); ok {
			for _, a := range args {
				am, ok := a.(map[string]any)
				if !ok {
					continue
				}
				argName := getString(am, "name")
				argType := formatTypeRef(am["type"])
				argDesc := getString(am, "description")
				line := fmt.Sprintf("  %s: %s", argName, argType)
				if argDesc != "" {
					line += " — " + argDesc
				}
				argLines = append(argLines, line)
			}
		}

		// Plain text
		plain := fmt.Sprintf("%s: %s", name, typeStr)
		if desc != "" {
			plain += "\n" + desc
		}

		// Markdown
		md := fmt.Sprintf("### `%s`: `%s`\n", name, typeStr)
		if desc != "" {
			md += "\n" + desc + "\n"
		}
		if deprecated {
			md += "\n**Deprecated**"
			if deprecationReason != "" {
				md += ": " + deprecationReason
			}
			md += "\n"
		}
		if len(argLines) > 0 {
			md += "\n**Arguments**:\n" + strings.Join(argLines, "\n") + "\n"
		}
		md += fmt.Sprintf("\n**Type**: %s", typeName)

		return true, plain, md, nil
	}

	return false, "", "", nil
}

func hoverDirective(ctx context.Context, schema *SchemaClient, conn *connection.Connection, directiveName string) (bool, string, string, error) {
	// Query introspection for directives
	query := `{ __schema { directives { name description locations args { name type { name } description } isRepeatable } } }`
	data, err := schema.queryResult(ctx, conn, query, nil)
	if err != nil {
		return false, "", "", err
	}

	directives := extractPath(data, "__schema", "directives")
	items, _ := directives.([]any)
	for _, d := range items {
		dm, ok := d.(map[string]any)
		if !ok {
			continue
		}
		if getString(dm, "name") != directiveName {
			continue
		}

		name := getString(dm, "name")
		desc := getString(dm, "description")

		var locations []string
		if locs, ok := dm["locations"].([]any); ok {
			for _, l := range locs {
				if s, ok := l.(string); ok {
					locations = append(locations, s)
				}
			}
		}

		plain := fmt.Sprintf("@%s", name)
		if desc != "" {
			plain += "\n" + desc
		}

		md := fmt.Sprintf("### `@%s`\n", name)
		if desc != "" {
			md += "\n" + desc + "\n"
		}
		if len(locations) > 0 {
			md += "\n**Locations**: " + strings.Join(locations, ", ") + "\n"
		}

		return true, plain, md, nil
	}

	return false, "", "", nil
}

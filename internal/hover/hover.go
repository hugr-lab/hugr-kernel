// Package hover provides GraphQL inspect/hover functionality.
package hover

import (
	"context"
	"fmt"
	"strings"

	"github.com/hugr-lab/hugr-kernel/internal/completion"
	"github.com/hugr-lab/hugr-kernel/internal/connection"
	"github.com/hugr-lab/hugr-kernel/internal/debug"
	"github.com/hugr-lab/hugr-kernel/internal/schema"
)

// Result contains hover information.
type Result struct {
	Found    bool
	Markdown string
	Plain    string
}

// Inspector provides hover/inspect functionality.
type Inspector struct {
	Schema *schema.Client
}

func NewInspector(sc *schema.Client) *Inspector {
	return &Inspector{Schema: sc}
}

// Inspect returns hover information for the token at the cursor position.
func (ins *Inspector) Inspect(ctx context.Context, conn *connection.Connection, code string, cursorPos int) *Result {
	token, start, end := extractToken(code, cursorPos)
	if token == "" {
		return nil
	}
	_ = start
	_ = end

	cctx := completion.ResolveCursorContext(code, cursorPos)
	if cctx == nil {
		return nil
	}
	debug.Printf("[hover] token=%q pos=%d kind=%d path=%v parentField=%q argName=%q inputPath=%v",
		token, cursorPos, cctx.Kind, cctx.FieldPath, cctx.ParentField, cctx.ArgumentName, cctx.InputPath)

	switch cctx.Kind {
	case completion.ContextSelectionSet:
		return ins.inspectField(ctx, conn, cctx.FieldPath, token, cctx.OperationType)
	case completion.ContextArgument:
		return ins.inspectArgument(ctx, conn, cctx.FieldPath, cctx.ParentField, token, cctx.OperationType)
	case completion.ContextArgumentValue:
		return ins.inspectArgumentValue(ctx, conn, cctx, token)
	default:
		// Try field lookup as fallback
		return ins.inspectField(ctx, conn, cctx.FieldPath, token, cctx.OperationType)
	}
}

func (ins *Inspector) inspectField(ctx context.Context, conn *connection.Connection, path []string, fieldName string, opType string) *Result {
	ti, typeName, err := ins.Schema.ResolveFieldPath(ctx, conn, path, opType)
	if err != nil || ti == nil {
		return nil
	}

	for _, f := range ti.Fields {
		if f.Name == fieldName {
			md := fmt.Sprintf("### `%s`: `%s`\n", f.Name, f.Type.Format())
			plain := fmt.Sprintf("%s: %s", f.Name, f.Type.Format())

			if f.Description != "" {
				md += "\n" + f.Description + "\n"
				plain += "\n" + f.Description
			}

			if len(f.Args) > 0 {
				var argStrs []string
				for _, a := range f.Args {
					argStrs = append(argStrs, fmt.Sprintf("%s: %s", a.Name, a.Type.Format()))
				}
				md += "\n**Arguments**: " + strings.Join(argStrs, ", ") + "\n"
			}

			md += "\n**Type**: " + typeName

			if f.IsDeprecated && f.DeprecationReason != "" {
				md += "\n\n**Deprecated**: " + f.DeprecationReason
			}

			return &Result{Found: true, Markdown: md, Plain: plain}
		}
	}
	return nil
}

func (ins *Inspector) inspectArgument(ctx context.Context, conn *connection.Connection, path []string, parentField, argName string, opType string) *Result {
	ti, _, err := ins.Schema.ResolveFieldPath(ctx, conn, path, opType)
	if err != nil || ti == nil {
		return nil
	}

	for _, f := range ti.Fields {
		if f.Name == parentField {
			for _, a := range f.Args {
				if a.Name == argName {
					md := fmt.Sprintf("### `%s`: `%s`\n", a.Name, a.Type.Format())
					plain := fmt.Sprintf("%s: %s", a.Name, a.Type.Format())
					if a.Description != "" {
						md += "\n" + a.Description + "\n"
						plain += "\n" + a.Description
					}
					if a.DefaultValue != nil {
						md += fmt.Sprintf("\n**Default**: `%s`", *a.DefaultValue)
					}
					return &Result{Found: true, Markdown: md, Plain: plain}
				}
			}
		}
	}
	return nil
}

// inspectArgumentValue handles hover for tokens inside argument values, including
// nested input objects like filter: {name: {eq: ...}}.
func (ins *Inspector) inspectArgumentValue(ctx context.Context, conn *connection.Connection, cctx *completion.CursorContext, token string) *Result {
	ti, _, err := ins.Schema.ResolveFieldPath(ctx, conn, cctx.FieldPath, cctx.OperationType)
	if err != nil || ti == nil {
		return nil
	}

	for _, f := range ti.Fields {
		if f.Name != cctx.ParentField {
			continue
		}

		// Walk the input path to find the correct input type
		if len(cctx.InputPath) > 0 {
			// Prepend ArgumentName to InputPath — inspectInputPath expects
			// the full path starting with the argument name
			fullPath := append([]string{cctx.ArgumentName}, cctx.InputPath...)
			return ins.inspectInputPath(ctx, conn, f.Args, fullPath, token)
		}

		// No input path — check all args' types for the token
		if cctx.ArgumentName != "" {
			for _, arg := range f.Args {
				if arg.Name == cctx.ArgumentName {
					return ins.inspectInputField(ctx, conn, arg.Type.UnwrapName(), token)
				}
			}
		}

		// Fallback: check all args
		for _, arg := range f.Args {
			result := ins.inspectInputField(ctx, conn, arg.Type.UnwrapName(), token)
			if result != nil {
				return result
			}
		}
		break
	}
	return nil
}

// inspectInputPath walks through nested input types to find hover info for the token.
func (ins *Inspector) inspectInputPath(ctx context.Context, conn *connection.Connection, args []schema.ArgInfo, inputPath []string, token string) *Result {
	if len(inputPath) == 0 {
		return nil
	}

	// First element is the argument name
	argName := inputPath[0]
	var currentTypeName string
	for _, arg := range args {
		if arg.Name == argName {
			currentTypeName = arg.Type.UnwrapName()
			break
		}
	}
	if currentTypeName == "" {
		return nil
	}

	// Walk remaining path through input fields
	for _, fieldName := range inputPath[1:] {
		ti, err := ins.Schema.GetType(ctx, conn, currentTypeName)
		if err != nil || ti == nil {
			return nil
		}
		found := false
		for _, f := range ti.InputFields {
			if f.Name == fieldName {
				currentTypeName = f.Type.UnwrapName()
				found = true
				break
			}
		}
		if !found {
			return nil
		}
	}

	return ins.inspectInputField(ctx, conn, currentTypeName, token)
}

// inspectInputField looks up a token in the input type's fields or enum values.
func (ins *Inspector) inspectInputField(ctx context.Context, conn *connection.Connection, typeName string, token string) *Result {
	if typeName == "" {
		return nil
	}

	ti, err := ins.Schema.GetType(ctx, conn, typeName)
	if err != nil || ti == nil {
		return nil
	}

	// Check input fields
	for _, field := range ti.InputFields {
		if field.Name == token {
			md := fmt.Sprintf("### `%s`: `%s`\n", field.Name, field.Type.Format())
			plain := fmt.Sprintf("%s: %s", field.Name, field.Type.Format())
			if field.Description != "" {
				md += "\n" + field.Description + "\n"
				plain += "\n" + field.Description
			}
			if field.DefaultValue != nil {
				md += fmt.Sprintf("\n**Default**: `%s`", *field.DefaultValue)
			}
			md += "\n**Input type**: " + typeName
			return &Result{Found: true, Markdown: md, Plain: plain}
		}
	}

	// Check enum values
	for _, ev := range ti.EnumValues {
		if ev.Name == token {
			md := fmt.Sprintf("### `%s`\n", ev.Name)
			plain := ev.Name
			if ev.Description != "" {
				md += "\n" + ev.Description + "\n"
				plain += "\n" + ev.Description
			}
			md += "\n**Enum**: " + typeName
			return &Result{Found: true, Markdown: md, Plain: plain}
		}
	}

	return nil
}

// extractToken finds the identifier token at or near the cursor position.
func extractToken(code string, pos int) (token string, start, end int) {
	if pos > len(code) {
		pos = len(code)
	}

	// Find start of token
	start = pos
	for start > 0 && isIdentChar(code[start-1]) {
		start--
	}

	// Find end of token
	end = pos
	for end < len(code) && isIdentChar(code[end]) {
		end++
	}

	if start == end {
		return "", 0, 0
	}
	return code[start:end], start, end
}

func isIdentChar(ch byte) bool {
	return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_'
}

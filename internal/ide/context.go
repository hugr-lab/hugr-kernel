package ide

import (
	"strings"

	"github.com/vektah/gqlparser/v2/ast"
	"github.com/vektah/gqlparser/v2/lexer"
)

// ResolveContext analyzes the token stream up to cursorPos and returns the cursor context.
func ResolveContext(code string, cursorPos int) *CursorContext {
	if cursorPos > len(code) {
		cursorPos = len(code)
	}

	// Extract the text before cursor
	before := code[:cursorPos]

	ctx := &CursorContext{
		Kind: ContextSelectionSet,
	}

	// Tokenize everything before cursor
	src := &ast.Source{Input: before}
	lex := lexer.New(src)

	type scope struct {
		kind      ContextKind
		typeName  string
		fieldName string
		directive string
	}

	var stack []scope
	var lastNames []string // recent Name tokens
	var prevToken lexer.Token

	for {
		tok, err := lex.ReadToken()
		if err != nil {
			break
		}

		switch tok.Kind {
		case lexer.BraceL: // {
			// Opening selection set — push new scope
			typeName := ""
			fieldName := ""
			if len(lastNames) > 0 {
				fieldName = lastNames[len(lastNames)-1]
			}
			stack = append(stack, scope{
				kind:      ContextSelectionSet,
				typeName:  typeName,
				fieldName: fieldName,
			})
			lastNames = nil

		case lexer.BraceR: // }
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}

		case lexer.ParenL: // (
			// Opening arguments
			fieldName := ""
			if len(lastNames) > 0 {
				fieldName = lastNames[len(lastNames)-1]
			}
			stack = append(stack, scope{
				kind:      ContextArgument,
				fieldName: fieldName,
			})
			lastNames = nil

		case lexer.ParenR: // )
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}

		case lexer.At: // @
			// Directive context
			ctx.Kind = ContextDirective
			ctx.Prefix = ""
			continue

		case lexer.Name:
			if prevToken.Kind == lexer.At {
				ctx.DirectiveName = tok.Value
			}
			lastNames = append(lastNames, tok.Value)

		case lexer.Colon:
			// After arg name: value expected
			if len(stack) > 0 && stack[len(stack)-1].kind == ContextArgument {
				// Argument value context
			}
		}

		prevToken = tok
	}

	// Build path from the field names in the stack
	var path []string
	for _, s := range stack {
		if s.fieldName != "" {
			path = append(path, s.fieldName)
		}
	}
	ctx.Path = path
	ctx.Depth = len(stack)

	// Determine current context from stack
	if len(stack) > 0 {
		top := stack[len(stack)-1]
		ctx.Kind = top.kind
		ctx.FieldName = top.fieldName
	}

	// Extract prefix — the partial word being typed at cursor
	ctx.Prefix = extractPrefix(before)

	// If we just typed @, it's a directive context
	trimmed := strings.TrimRight(before, " \t\n\r")
	if len(trimmed) > 0 && trimmed[len(trimmed)-1] == '@' {
		ctx.Kind = ContextDirective
		ctx.Prefix = ""
	} else if ctx.Kind == ContextDirective && ctx.Prefix != "" {
		// Keep directive context with prefix
	}

	return ctx
}

// extractPrefix returns the partial identifier being typed at the end of the text.
func extractPrefix(text string) string {
	// Walk backwards from end, collecting word characters
	i := len(text) - 1
	for i >= 0 {
		c := text[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' {
			i--
			continue
		}
		break
	}
	return text[i+1:]
}

// ResolveParentTypeName resolves the parent type name for completion.
// It walks the field path through the schema to find the type at the cursor position.
// Returns "Query" for root level, or the resolved type name.
func ResolveParentTypeName(path []string) string {
	if len(path) == 0 {
		return "Query"
	}
	// The parent type needs to be resolved by the schema client
	// by walking the path through introspection.
	// For now, return a hint that the caller should resolve.
	return ""
}

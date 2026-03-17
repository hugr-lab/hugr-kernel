// Package completion provides GraphQL cursor context resolution and completion.
package completion

// ContextKind identifies what kind of completion is needed.
type ContextKind int

const (
	ContextUnknown ContextKind = iota
	ContextSelectionSet  // Inside { }, need field names
	ContextArgument      // Inside ( ), need argument names
	ContextArgumentValue // After argName:, need values (or inside input object {})
	ContextDirective     // After @, need directive names
	ContextDirectiveArg  // Inside @directive( ), need directive arg names
	ContextVariable      // After $, need variable names
	ContextTopLevel      // At document root
)

// CursorContext describes the editing context at a cursor position.
type CursorContext struct {
	Kind          ContextKind
	FieldPath     []string // path from root, e.g., ["core", "catalog"]
	Prefix        string   // partial token typed so far
	ParentField   string   // for arguments: which field the args belong to
	DirectiveName string   // for directive args: which directive
	Depth         int      // brace nesting depth
	OperationType string   // "query", "mutation", "subscription", or "" for anonymous query
	ArgumentName  string   // which argument is being filled (e.g., "filter")
	InputPath     []string // nesting path within input objects (e.g., ["name"] for filter.name)
}

// ResolveCursorContext analyzes code at cursorPos and determines
// the completion context using AST parsing via gqlparser.
// It parses the full code first (for complete structure), then falls back
// to truncated parsing if the full parse doesn't yield sufficient context.
func ResolveCursorContext(code string, cursorPos int) *CursorContext {
	if cursorPos > len(code) {
		cursorPos = len(code)
	}

	// Try full code first — gives complete AST structure even when
	// cursor is mid-edit (e.g., inside nested args with syntax errors before cursor)
	fullDoc := SafeParse(code)
	ctx := ResolveFromAST(fullDoc, code, cursorPos)

	// If full parse gave a useful context (not just top-level/selection-set with no path),
	// use it. Otherwise try truncated parse for incomplete input.
	if ctx != nil && (ctx.Kind != ContextSelectionSet || len(ctx.FieldPath) > 0) {
		// Re-extract prefix from text before cursor (full parse may include tokens after cursor)
		ctx.Prefix = extractPrefix(code[:cursorPos], cursorPos)
		return ctx
	}

	// Fallback: parse truncated text (handles typing mid-expression)
	text := code[:cursorPos]
	truncDoc := SafeParse(text)
	truncCtx := ResolveFromAST(truncDoc, text, cursorPos)
	if truncCtx != nil {
		return truncCtx
	}
	return ctx
}

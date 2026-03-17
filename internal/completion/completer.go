package completion

import (
	"context"
	"strings"

	"github.com/hugr-lab/hugr-kernel/internal/connection"
	"github.com/hugr-lab/hugr-kernel/internal/debug"
	"github.com/hugr-lab/hugr-kernel/internal/schema"
)

const MaxCompletions = 15

// Item represents a single completion suggestion.
type Item struct {
	Label         string `json:"label"`
	Kind          string `json:"kind"`
	Detail        string `json:"detail"`
	Documentation string `json:"documentation"`
	InsertText    string `json:"insertText"`
}

// Result contains completion items and cursor range.
type Result struct {
	Items       []Item
	CursorStart int
	CursorEnd   int
}

// Completer provides GraphQL autocompletion.
type Completer struct {
	Schema *schema.Client
}

func NewCompleter(sc *schema.Client) *Completer {
	return &Completer{Schema: sc}
}

// Complete returns completion items for the given code and cursor position.
// variableNames is the list of session variable names available for $-completion.
func (c *Completer) Complete(ctx context.Context, conn *connection.Connection, code string, cursorPos int, variableNames []string) *Result {
	cctx := ResolveCursorContext(code, cursorPos)
	if cctx == nil {
		debug.Printf("[completion] context is nil for pos=%d", cursorPos)
		return nil
	}
	debug.Printf("[completion] pos=%d kind=%d path=%v prefix=%q parentField=%q argName=%q inputPath=%v op=%q",
		cursorPos, cctx.Kind, cctx.FieldPath, cctx.Prefix, cctx.ParentField, cctx.ArgumentName, cctx.InputPath, cctx.OperationType)

	var items []Item

	switch cctx.Kind {
	case ContextSelectionSet:
		items = c.completeFields(ctx, conn, cctx)
	case ContextArgument:
		items = c.completeArguments(ctx, conn, cctx)
	case ContextDirective:
		items = c.completeDirectives(ctx, conn, cctx)
	case ContextArgumentValue:
		items = c.completeArgumentValues(ctx, conn, cctx)
	case ContextDirectiveArg:
		items = c.completeDirectiveArgs(ctx, conn, cctx)
	case ContextVariable:
		items = completeVariables(cctx, variableNames)
	case ContextTopLevel:
		items = c.completeTopLevel(cctx)
	default:
		return nil
	}

	// Filter by prefix
	if cctx.Prefix != "" {
		prefix := strings.ToLower(cctx.Prefix)
		filtered := items[:0]
		for _, it := range items {
			if strings.HasPrefix(strings.ToLower(it.Label), prefix) {
				filtered = append(filtered, it)
			}
		}
		items = filtered
	}

	if len(items) > MaxCompletions {
		items = items[:MaxCompletions]
	}

	if len(items) == 0 {
		return nil
	}

	cursorStart := cursorPos - len(cctx.Prefix)
	return &Result{
		Items:       items,
		CursorStart: cursorStart,
		CursorEnd:   cursorPos,
	}
}

func (c *Completer) completeFields(ctx context.Context, conn *connection.Connection, cctx *CursorContext) []Item {
	ti, typeName, err := c.Schema.ResolveFieldPath(ctx, conn, cctx.FieldPath, cctx.OperationType)
	if err != nil {
		debug.Printf("[completion] resolve path %v: %v", cctx.FieldPath, err)
		return nil
	}
	if ti == nil {
		debug.Printf("[completion] type not found for path %v (last: %s)", cctx.FieldPath, typeName)
		return nil
	}

	items := make([]Item, 0, len(ti.Fields))
	for _, f := range ti.Fields {
		items = append(items, Item{
			Label:         f.Name,
			Kind:          "Field",
			Detail:        f.Type.Format(),
			Documentation: f.Description,
			InsertText:    f.Name,
		})
	}
	return items
}

func (c *Completer) completeArguments(ctx context.Context, conn *connection.Connection, cctx *CursorContext) []Item {
	if cctx.ParentField == "" {
		return nil
	}

	// Resolve the type at the current path (the parent of the field with args)
	ti, _, err := c.Schema.ResolveFieldPath(ctx, conn, cctx.FieldPath, cctx.OperationType)
	if err != nil || ti == nil {
		return nil
	}

	// Find the field
	for _, f := range ti.Fields {
		if f.Name == cctx.ParentField {
			items := make([]Item, 0, len(f.Args))
			for _, arg := range f.Args {
				items = append(items, Item{
					Label:         arg.Name,
					Kind:          "Argument",
					Detail:        arg.Type.Format(),
					Documentation: arg.Description,
					InsertText:    arg.Name + ": ",
				})
			}
			return items
		}
	}
	return nil
}

func (c *Completer) completeArgumentValues(ctx context.Context, conn *connection.Connection, cctx *CursorContext) []Item {
	if cctx.ParentField == "" {
		return nil
	}

	// Resolve the type at the current path to find the field and its argument types
	ti, _, err := c.Schema.ResolveFieldPath(ctx, conn, cctx.FieldPath, cctx.OperationType)
	if err != nil || ti == nil {
		return nil
	}

	// Find the field to get its args
	for _, f := range ti.Fields {
		if f.Name != cctx.ParentField {
			continue
		}

		// If we have InputPath, walk through the input types to find the right level
		if len(cctx.InputPath) > 0 {
			// Prepend ArgumentName to InputPath — completeInputPath expects
			// the full path starting with the argument name
			fullPath := append([]string{cctx.ArgumentName}, cctx.InputPath...)
			return c.completeInputPath(ctx, conn, f.Args, fullPath)
		}

		// If we have ArgumentName, complete the specific argument's type
		if cctx.ArgumentName != "" {
			for _, arg := range f.Args {
				if arg.Name == cctx.ArgumentName {
					return c.completeInputType(ctx, conn, arg.Type.UnwrapName())
				}
			}
			return nil
		}

		// No specific argument — show all arg type fields
		var items []Item
		for _, arg := range f.Args {
			items = append(items, c.completeInputType(ctx, conn, arg.Type.UnwrapName())...)
		}
		return items
	}
	return nil
}

// completeInputPath walks through nested input types following the path.
// e.g., for path=["filter"], it finds the "filter" arg type's input fields.
// For path=["filter","name"], it finds filter type, then name field's type, and returns its fields.
func (c *Completer) completeInputPath(ctx context.Context, conn *connection.Connection, args []schema.ArgInfo, inputPath []string) []Item {
	ti, err := schema.ResolveInputType(ctx, c.Schema, conn, args, inputPath)
	if err != nil || ti == nil {
		return nil
	}
	return c.completeInputTypeFromInfo(ti)
}

// completeInputType returns completion items for the fields/values of an input type.
func (c *Completer) completeInputType(ctx context.Context, conn *connection.Connection, typeName string) []Item {
	if typeName == "" {
		return nil
	}

	ti, err := c.Schema.GetType(ctx, conn, typeName)
	if err != nil || ti == nil {
		return nil
	}

	return c.completeInputTypeFromInfo(ti)
}

// completeInputTypeFromInfo returns completion items from an already-resolved TypeInfo.
func (c *Completer) completeInputTypeFromInfo(ti *schema.TypeInfo) []Item {
	switch ti.Kind {
	case "INPUT_OBJECT":
		items := make([]Item, 0, len(ti.InputFields))
		for _, field := range ti.InputFields {
			items = append(items, Item{
				Label:         field.Name,
				Kind:          "Field",
				Detail:        field.Type.Format(),
				Documentation: field.Description,
				InsertText:    field.Name + ": ",
			})
		}
		return items
	case "ENUM":
		items := make([]Item, 0, len(ti.EnumValues))
		for _, ev := range ti.EnumValues {
			items = append(items, Item{
				Label:         ev.Name,
				Kind:          "EnumValue",
				Detail:        ti.Name,
				Documentation: ev.Description,
				InsertText:    ev.Name,
			})
		}
		return items
	}
	return nil
}

func completeVariables(cctx *CursorContext, variableNames []string) []Item {
	items := make([]Item, 0, len(variableNames))
	for _, name := range variableNames {
		items = append(items, Item{
			Label:      name,
			Kind:       "Variable",
			Detail:     "session variable",
			InsertText: name,
		})
	}
	return items
}

func (c *Completer) completeDirectives(ctx context.Context, conn *connection.Connection, cctx *CursorContext) []Item {
	dirs, err := c.Schema.GetDirectives(ctx, conn)
	if err != nil {
		return nil
	}
	items := make([]Item, 0, len(dirs))
	for _, d := range dirs {
		items = append(items, Item{
			Label:         d.Name,
			Kind:          "Directive",
			Detail:        "",
			Documentation: d.Description,
			InsertText:    d.Name,
		})
	}
	return items
}

func (c *Completer) completeDirectiveArgs(ctx context.Context, conn *connection.Connection, cctx *CursorContext) []Item {
	if cctx.DirectiveName == "" {
		return nil
	}
	dirs, err := c.Schema.GetDirectives(ctx, conn)
	if err != nil {
		return nil
	}
	for _, d := range dirs {
		if d.Name == cctx.DirectiveName {
			items := make([]Item, 0, len(d.Args))
			for _, arg := range d.Args {
				items = append(items, Item{
					Label:         arg.Name,
					Kind:          "Argument",
					Detail:        arg.Type.Format(),
					Documentation: arg.Description,
					InsertText:    arg.Name + ": ",
				})
			}
			return items
		}
	}
	return nil
}

func (c *Completer) completeTopLevel(cctx *CursorContext) []Item {
	keywords := []struct{ label, detail string }{
		{"query", "Query operation"},
		{"mutation", "Mutation operation"},
		{"subscription", "Subscription operation"},
		{"fragment", "Fragment definition"},
		{"{", "Anonymous query"},
	}
	items := make([]Item, 0, len(keywords))
	for _, kw := range keywords {
		items = append(items, Item{
			Label:      kw.label,
			Kind:       "Keyword",
			Detail:     kw.detail,
			InsertText: kw.label,
		})
	}
	return items
}

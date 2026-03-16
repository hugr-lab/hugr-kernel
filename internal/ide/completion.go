package ide

import (
	"context"
	"strings"

	"github.com/hugr-lab/hugr-kernel/internal/connection"
)

const (
	defaultCompletionLimit = 20
	maxCompletionLimit     = 50
)

// Complete returns completion items based on the cursor context.
func Complete(ctx context.Context, schema *SchemaClient, conn *connection.Connection, cursorCtx *CursorContext) ([]CompletionItem, error) {
	switch cursorCtx.Kind {
	case ContextSelectionSet:
		return completeFields(ctx, schema, conn, cursorCtx)
	case ContextArgument:
		return completeArguments(ctx, schema, conn, cursorCtx)
	case ContextDirective:
		return completeDirectives(ctx, schema, conn, cursorCtx)
	default:
		return nil, nil
	}
}

// completeFields returns field completions for the current selection set.
func completeFields(ctx context.Context, schema *SchemaClient, conn *connection.Connection, cursorCtx *CursorContext) ([]CompletionItem, error) {
	// Resolve parent type by walking the path through introspection
	typeName, err := resolveTypeAtPath(ctx, schema, conn, cursorCtx.Path)
	if err != nil {
		return nil, err
	}
	if typeName == "" {
		typeName = "Query"
	}

	// Try catalog fields first (richer metadata), fall back to introspection
	items, err := schema.FieldsForType(ctx, conn, typeName, cursorCtx.Prefix, defaultCompletionLimit)
	if err != nil || len(items) == 0 {
		// Fallback: use introspection for the type
		items, err = fieldsFromIntrospection(ctx, schema, conn, typeName, cursorCtx.Prefix)
		if err != nil {
			return nil, err
		}
	}

	return items, nil
}

// completeArguments returns argument completions for the current field.
func completeArguments(ctx context.Context, schema *SchemaClient, conn *connection.Connection, cursorCtx *CursorContext) ([]CompletionItem, error) {
	if cursorCtx.FieldName == "" {
		return nil, nil
	}

	// Resolve parent type
	parentPath := cursorCtx.Path
	if len(parentPath) > 0 {
		parentPath = parentPath[:len(parentPath)-1]
	}
	typeName, err := resolveTypeAtPath(ctx, schema, conn, parentPath)
	if err != nil {
		return nil, err
	}
	if typeName == "" {
		typeName = "Query"
	}

	items, err := schema.ArgumentsForField(ctx, conn, typeName, cursorCtx.FieldName)
	if err != nil {
		return nil, err
	}

	// Filter by prefix
	if cursorCtx.Prefix != "" {
		var filtered []CompletionItem
		for _, item := range items {
			if hasPrefix(item.Label, cursorCtx.Prefix) {
				filtered = append(filtered, item)
			}
		}
		return filtered, nil
	}

	return items, nil
}

// completeDirectives returns directive completions.
func completeDirectives(ctx context.Context, schema *SchemaClient, conn *connection.Connection, cursorCtx *CursorContext) ([]CompletionItem, error) {
	return schema.DirectivesForLocation(ctx, conn, cursorCtx.Prefix)
}

// resolveTypeAtPath walks the field path through introspection to find the type at the given position.
func resolveTypeAtPath(ctx context.Context, schema *SchemaClient, conn *connection.Connection, path []string) (string, error) {
	if len(path) == 0 {
		return "Query", nil
	}

	currentType := "Query"
	for _, fieldName := range path {
		typeInfo, err := schema.TypeInfo(ctx, conn, currentType)
		if err != nil {
			return currentType, err
		}
		if typeInfo == nil {
			return currentType, nil
		}

		fields, _ := typeInfo["fields"].([]any)
		found := false
		for _, f := range fields {
			fm, ok := f.(map[string]any)
			if !ok {
				continue
			}
			if getString(fm, "name") != fieldName {
				continue
			}
			// Extract the base type name from the type chain
			typeName := resolveBaseTypeName(fm["type"])
			if typeName != "" {
				currentType = typeName
				found = true
			}
			break
		}
		if !found {
			return currentType, nil
		}
	}

	return currentType, nil
}

// resolveBaseTypeName extracts the base type name from a GraphQL type introspection result.
func resolveBaseTypeName(typeData any) string {
	m, ok := typeData.(map[string]any)
	if !ok {
		return ""
	}

	name := getString(m, "name")
	if name != "" {
		return name
	}

	// Unwrap NON_NULL and LIST wrappers
	if ofType, ok := m["ofType"]; ok {
		return resolveBaseTypeName(ofType)
	}

	return ""
}

// fieldsFromIntrospection gets fields for a type via introspection when catalog is unavailable.
func fieldsFromIntrospection(ctx context.Context, schema *SchemaClient, conn *connection.Connection, typeName, prefix string) ([]CompletionItem, error) {
	typeInfo, err := schema.TypeInfo(ctx, conn, typeName)
	if err != nil {
		return nil, err
	}
	if typeInfo == nil {
		return nil, nil
	}

	fields, _ := typeInfo["fields"].([]any)
	var items []CompletionItem
	for _, f := range fields {
		fm, ok := f.(map[string]any)
		if !ok {
			continue
		}
		name := getString(fm, "name")
		if prefix != "" && !hasPrefix(name, prefix) {
			continue
		}

		typStr := formatTypeRef(fm["type"])
		items = append(items, CompletionItem{
			Label:         name,
			Kind:          CompletionField,
			Detail:        typStr,
			Documentation: getString(fm, "description"),
			InsertText:    name,
		})

		if len(items) >= defaultCompletionLimit {
			break
		}
	}
	return items, nil
}

// formatTypeRef formats a GraphQL type reference into a string like "String!", "[Int]", etc.
func formatTypeRef(typeData any) string {
	m, ok := typeData.(map[string]any)
	if !ok {
		return ""
	}

	kind := getString(m, "kind")
	name := getString(m, "name")

	switch kind {
	case "NON_NULL":
		inner := formatTypeRef(m["ofType"])
		return inner + "!"
	case "LIST":
		inner := formatTypeRef(m["ofType"])
		return "[" + inner + "]"
	default:
		if name != "" {
			return name
		}
		return strings.ToLower(kind)
	}
}

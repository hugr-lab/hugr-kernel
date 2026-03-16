package ide

import (
	"context"
	"errors"
	"strings"

	"github.com/hugr-lab/hugr-kernel/internal/connection"
	"github.com/vektah/gqlparser/v2/ast"
	"github.com/vektah/gqlparser/v2/gqlerror"
	"github.com/vektah/gqlparser/v2/parser"
)

// Validate parses and validates a GraphQL query, returning diagnostics.
func Validate(ctx context.Context, schema *SchemaClient, conn *connection.Connection, code string) []Diagnostic {
	if conn == nil || strings.TrimSpace(code) == "" {
		return nil
	}

	// Parse the query
	src := &ast.Source{Input: code}
	doc, parseErr := parser.ParseQuery(src)
	if parseErr != nil {
		// Convert parse error to diagnostic
		var gqlErr *gqlerror.Error
		if errors.As(parseErr, &gqlErr) && len(gqlErr.Locations) > 0 {
			return []Diagnostic{{
				Severity:    SeverityError,
				Message:     gqlErr.Message,
				StartLine:   gqlErr.Locations[0].Line - 1,
				StartColumn: gqlErr.Locations[0].Column - 1,
				EndLine:     gqlErr.Locations[0].Line - 1,
				EndColumn:   gqlErr.Locations[0].Column,
				Code:        "parse_error",
			}}
		}
		return []Diagnostic{{
			Severity: SeverityError,
			Message:  parseErr.Error(),
			Code:     "parse_error",
		}}
	}

	var diagnostics []Diagnostic

	// Walk the parsed document and validate against the schema
	for _, op := range doc.Operations {
		diags := validateSelectionSet(ctx, schema, conn, op.SelectionSet, "Query", code)
		diagnostics = append(diagnostics, diags...)
	}

	return diagnostics
}

// validateSelectionSet recursively validates selection sets against the schema.
func validateSelectionSet(ctx context.Context, schema *SchemaClient, conn *connection.Connection, selections ast.SelectionSet, typeName string, code string) []Diagnostic {
	if len(selections) == 0 {
		return nil
	}

	// Fetch the type info to validate fields
	typeInfo, err := schema.TypeInfo(ctx, conn, typeName)
	if err != nil || typeInfo == nil {
		return nil // Can't validate without type info
	}

	fields, _ := typeInfo["fields"].([]any)
	fieldMap := make(map[string]map[string]any)
	for _, f := range fields {
		fm, ok := f.(map[string]any)
		if !ok {
			continue
		}
		fieldMap[getString(fm, "name")] = fm
	}

	var diagnostics []Diagnostic

	for _, sel := range selections {
		field, ok := sel.(*ast.Field)
		if !ok {
			continue
		}

		// Skip __typename
		if field.Name == "__typename" {
			continue
		}

		fieldDef, exists := fieldMap[field.Name]
		if !exists {
			diagnostics = append(diagnostics, Diagnostic{
				Severity:    SeverityError,
				Message:     "Unknown field '" + field.Name + "' on type '" + typeName + "'",
				StartLine:   field.Position.Line - 1,
				StartColumn: field.Position.Column - 1,
				EndLine:     field.Position.Line - 1,
				EndColumn:   field.Position.Column - 1 + len(field.Name),
				Code:        "unknown_field",
			})
			continue
		}

		// Check if field returns an object type but has no selection set
		fieldTypeName := resolveBaseTypeName(fieldDef["type"])
		if fieldTypeName != "" && len(field.SelectionSet) == 0 {
			// Check if the type is an object (has fields)
			childType, _ := schema.TypeInfo(ctx, conn, fieldTypeName)
			if childType != nil {
				kind := getString(childType, "kind")
				if kind == "OBJECT" || kind == "INTERFACE" || kind == "UNION" {
					diagnostics = append(diagnostics, Diagnostic{
						Severity:    SeverityError,
						Message:     "Field '" + field.Name + "' of type '" + fieldTypeName + "' must have a selection of subfields",
						StartLine:   field.Position.Line - 1,
						StartColumn: field.Position.Column - 1,
						EndLine:     field.Position.Line - 1,
						EndColumn:   field.Position.Column - 1 + len(field.Name),
						Code:        "missing_selection_set",
					})
				}
			}
		}

		// Validate arguments
		if args, ok := fieldDef["args"].([]any); ok && len(args) > 0 {
			argMap := make(map[string]map[string]any)
			for _, a := range args {
				am, ok := a.(map[string]any)
				if !ok {
					continue
				}
				argMap[getString(am, "name")] = am
			}

			// Check for unknown arguments
			for _, arg := range field.Arguments {
				if _, exists := argMap[arg.Name]; !exists {
					diagnostics = append(diagnostics, Diagnostic{
						Severity:    SeverityError,
						Message:     "Unknown argument '" + arg.Name + "' on field '" + field.Name + "'",
						StartLine:   arg.Position.Line - 1,
						StartColumn: arg.Position.Column - 1,
						EndLine:     arg.Position.Line - 1,
						EndColumn:   arg.Position.Column - 1 + len(arg.Name),
						Code:        "unknown_argument",
					})
				}
			}

			// Check for missing required arguments
			providedArgs := make(map[string]bool)
			for _, arg := range field.Arguments {
				providedArgs[arg.Name] = true
			}
			for argName, argDef := range argMap {
				argTypeStr := formatTypeRef(argDef["type"])
				if strings.HasSuffix(argTypeStr, "!") && !providedArgs[argName] {
					if getString(argDef, "defaultValue") == "" {
						diagnostics = append(diagnostics, Diagnostic{
							Severity:    SeverityWarning,
							Message:     "Missing required argument '" + argName + "' on field '" + field.Name + "'",
							StartLine:   field.Position.Line - 1,
							StartColumn: field.Position.Column - 1,
							EndLine:     field.Position.Line - 1,
							EndColumn:   field.Position.Column - 1 + len(field.Name),
							Code:        "missing_required_argument",
						})
					}
				}
			}
		}

		// Recurse into selection set
		if len(field.SelectionSet) > 0 && fieldTypeName != "" {
			childDiags := validateSelectionSet(ctx, schema, conn, field.SelectionSet, fieldTypeName, code)
			diagnostics = append(diagnostics, childDiags...)
		}
	}

	return diagnostics
}

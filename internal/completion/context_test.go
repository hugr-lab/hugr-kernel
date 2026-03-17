package completion

import (
	"fmt"
	"testing"
)

func TestResolveCursorContext(t *testing.T) {
	tests := []struct {
		name      string
		code      string
		wantKind  ContextKind
		wantPath  []string
		wantPF    string // ParentField
		wantArg   string // ArgumentName
		wantInput []string // InputPath
		wantOp    string // OperationType
		wantPfx   string // Prefix
	}{
		{
			name:     "field after args with input objects",
			code:     "{\n    core{\n        data_sources(filter: {name: {eq: \"tf\"}} ){\n            name",
			wantKind: ContextSelectionSet,
			wantPath: []string{"core", "data_sources"},
			wantPfx:  "name",
		},
		{
			name:     "inside input object filter",
			code:     "{\n    core{\n        data_sources(filter: {na",
			wantKind: ContextArgumentValue,
			wantPF:   "data_sources",
			wantPfx:  "na",
		},
		{
			name:     "nested input object",
			code:     "{\n    core{\n        data_sources(filter: {name: {e",
			wantKind: ContextArgumentValue,
			wantPF:   "data_sources",
			wantPfx:  "e",
		},
		{
			name:     "mutation operation type",
			code:     "mutation {\n    core {\n        upsert_data_source(input: {na",
			wantKind: ContextArgumentValue,
			wantOp:   "mutation",
			wantPF:   "upsert_data_source",
			wantPfx:  "na",
		},
		{
			name:     "variable context",
			code:     "{\n    core{\n        data_sources(filter: $",
			wantKind: ContextVariable,
			wantPF:   "data_sources",
		},
		{
			name:     "arg value after colon with space",
			code:     "{\n    core{\n        data_sources(filter: ",
			wantKind: ContextArgumentValue,
			wantPF:   "data_sources",
			wantArg:  "filter",
		},
		{
			name:     "simple field completion",
			code:     "{\n    core {\n        ",
			wantKind: ContextSelectionSet,
			wantPath: []string{"core"},
		},
		{
			name:     "argument name",
			code:     "{\n    core{\n        data_sources(fi",
			wantKind: ContextArgument,
			wantPF:   "data_sources",
			wantPfx:  "fi",
		},
		{
			name:     "enum value in input object",
			code:     "{\n    core{\n        catalog{\n            catalogs(order_by: [{direction: A",
			wantKind: ContextArgumentValue,
			wantPF:   "catalogs",
			wantArg:  "order_by",
			wantInput: []string{"direction"},
			wantPfx:  "A",
		},
		{
			name:     "field name in list of input objects",
			code:     "{\n    core{\n        catalog{\n            catalogs(order_by: [{fi",
			wantKind: ContextArgumentValue,
			wantPF:   "catalogs",
			wantArg:  "order_by",
			wantPfx:  "fi",
		},
		{
			name:     "nested input inside list value",
			code:     "{\n    core{\n        catalog{\n            catalogs(order_by: [{direction: ",
			wantKind: ContextArgumentValue,
			wantPF:   "catalogs",
			wantArg:  "order_by",
			wantInput: []string{"direction"},
		},
		{
			name:     "empty list value",
			code:     "{\n    core{\n        catalog{\n            catalogs(order_by: [",
			wantKind: ContextArgumentValue,
			wantPF:   "catalogs",
			wantArg:  "order_by",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := ResolveCursorContext(tt.code, len(tt.code))
			if ctx == nil {
				t.Fatal("got nil context")
			}
			if ctx.Kind != tt.wantKind {
				t.Errorf("Kind: got %d, want %d", ctx.Kind, tt.wantKind)
			}
			if tt.wantPath != nil && fmt.Sprint(ctx.FieldPath) != fmt.Sprint(tt.wantPath) {
				t.Errorf("FieldPath: got %v, want %v", ctx.FieldPath, tt.wantPath)
			}
			if tt.wantPF != "" && ctx.ParentField != tt.wantPF {
				t.Errorf("ParentField: got %q, want %q", ctx.ParentField, tt.wantPF)
			}
			if tt.wantArg != "" && ctx.ArgumentName != tt.wantArg {
				t.Errorf("ArgumentName: got %q, want %q", ctx.ArgumentName, tt.wantArg)
			}
			if tt.wantOp != "" && ctx.OperationType != tt.wantOp {
				t.Errorf("OperationType: got %q, want %q", ctx.OperationType, tt.wantOp)
			}
			if tt.wantPfx != "" && ctx.Prefix != tt.wantPfx {
				t.Errorf("Prefix: got %q, want %q", ctx.Prefix, tt.wantPfx)
			}
			if tt.wantInput != nil && fmt.Sprint(ctx.InputPath) != fmt.Sprint(tt.wantInput) {
				t.Errorf("InputPath: got %v, want %v", ctx.InputPath, tt.wantInput)
			}
		})
	}
}

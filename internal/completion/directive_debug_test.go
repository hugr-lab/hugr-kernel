package completion

import (
	"fmt"
	"strings"
	"testing"
)

func TestDirectiveContextDebug(t *testing.T) {
	code := `{
  core{
    catalog{
      types(filter: {name: {eq: "Function"}}) @cache(ttl: 60){
        name
        catalog
        hugr_type
        fields{
          name
          catalog
          hugr_type
          field_type
        }
      }
      fields(filter: {type_name: {eq: "Query"}}){
        name
        catalog
        field_type
        hugr_type
      }
    }
  }
}`

	tests := []struct {
		label    string
		pos      int
		wantKind ContextKind
	}{
		{"@cache name", indexOf(code, "cache("), ContextDirective},
		{"ttl inside @cache", indexOf(code, "ttl:"), ContextDirectiveArg},
		{"name after @cache", indexOfNth(code, "name", 2), ContextSelectionSet},
		{"catalog after @cache", indexOfNth(code, "catalog", 2), ContextSelectionSet},
		{"hugr_type after @cache", indexOfNth(code, "hugr_type", 1), ContextSelectionSet},
		{"name in nested fields", indexOfNth(code, "name", 3), ContextSelectionSet},
		{"field_type", indexOf(code, "field_type"), ContextSelectionSet},
		{"name in 2nd fields", indexOfNth(code, "\n        name", 2) + 9, ContextSelectionSet},
		{"hugr_type in 2nd", indexOfNth(code, "hugr_type", 3), ContextSelectionSet},
	}

	for _, tt := range tests {
		ctx := ResolveCursorContext(code, tt.pos)
		kindStr := kindName(ctx.Kind)
		t.Logf("%-30s pos=%-4d kind=%-20s path=%v dir=%q arg=%q prefix=%q",
			tt.label, tt.pos, kindStr, ctx.FieldPath, ctx.DirectiveName, ctx.ArgumentName, ctx.Prefix)
		if ctx.Kind != tt.wantKind {
			t.Errorf("%s: got kind=%s, want %s", tt.label, kindStr, kindName(tt.wantKind))
		}
	}
}

func indexOf(s, sub string) int {
	i := strings.Index(s, sub)
	if i < 0 {
		return -1
	}
	return i
}

func indexOfNth(s, sub string, n int) int {
	offset := 0
	for count := 0; count < n; count++ {
		i := strings.Index(s[offset:], sub)
		if i < 0 {
			return -1
		}
		if count == n-1 {
			return offset + i + 1 // position inside the token
		}
		offset += i + len(sub)
	}
	return -1
}

func kindName(k ContextKind) string {
	switch k {
	case ContextSelectionSet:
		return "SelectionSet"
	case ContextArgument:
		return "Argument"
	case ContextArgumentValue:
		return "ArgumentValue"
	case ContextDirective:
		return "Directive"
	case ContextDirectiveArg:
		return "DirectiveArg"
	case ContextVariable:
		return "Variable"
	case ContextTopLevel:
		return "TopLevel"
	default:
		return fmt.Sprintf("Kind(%d)", k)
	}
}

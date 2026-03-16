package completion

import (
	"github.com/vektah/gqlparser/v2/ast"
	"github.com/vektah/gqlparser/v2/parser"
)

// SafeParse parses potentially incomplete GraphQL input.
// Returns partial AST even on error (ParseQuery guarantees non-nil return).
func SafeParse(code string) *ast.QueryDocument {
	src := &ast.Source{Input: code, Name: "cell"}
	doc, _ := parser.ParseQuery(src)
	return doc
}

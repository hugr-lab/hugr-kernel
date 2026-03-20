package completion

import (
	"github.com/vektah/gqlparser/v2/ast"
)

// ResolveFromAST walks the parsed AST to determine cursor context.
func ResolveFromAST(doc *ast.QueryDocument, code string, cursorPos int) *CursorContext {
	if doc == nil {
		return &CursorContext{Kind: ContextTopLevel}
	}

	prefix := extractPrefix(code, cursorPos)

	// Check if cursor is after @ (directive context)
	if isDirectiveContext(code, cursorPos, prefix) {
		ctx := &CursorContext{
			Kind:   ContextDirective,
			Prefix: prefix,
		}
		if op := findOperationAtCursor(doc, cursorPos); op != nil {
			ctx.OperationType = opTypeString(op.Operation)
			ctx.FieldPath = collectFieldPath(op.SelectionSet, cursorPos)
		}
		return ctx
	}

	// Find the operation containing the cursor
	op := findOperationAtCursor(doc, cursorPos)
	if op == nil {
		if frag := findFragmentAtCursor(doc, cursorPos); frag != nil {
			return resolveInSelectionSet(frag.SelectionSet, code, cursorPos, prefix, "", nil)
		}
		return &CursorContext{Kind: ContextTopLevel, Prefix: prefix}
	}

	opType := opTypeString(op.Operation)
	return resolveInSelectionSet(op.SelectionSet, code, cursorPos, prefix, opType, nil)
}

func opTypeString(op ast.Operation) string {
	s := string(op)
	if s == "query" || s == "mutation" || s == "subscription" {
		return s
	}
	return ""
}

func findOperationAtCursor(doc *ast.QueryDocument, cursorPos int) *ast.OperationDefinition {
	var best *ast.OperationDefinition
	for _, op := range doc.Operations {
		if op.Position != nil && op.Position.Start <= cursorPos {
			if best == nil || op.Position.Start > best.Position.Start {
				best = op
			}
		}
	}
	return best
}

func findFragmentAtCursor(doc *ast.QueryDocument, cursorPos int) *ast.FragmentDefinition {
	for _, frag := range doc.Fragments {
		if frag.Position != nil && frag.Position.Start <= cursorPos {
			return frag
		}
	}
	return nil
}

// collectFieldPath walks selection sets to build the field path to the cursor.
// Only includes fields whose selection set contains the cursor (i.e., cursor is inside their { }).
func collectFieldPath(ss ast.SelectionSet, cursorPos int) []string {
	var path []string
	for {
		field := findDeepestField(ss, cursorPos)
		if field == nil {
			break
		}
		if len(field.SelectionSet) == 0 {
			// Field has no selection set — cursor might be on it or in its args
			break
		}
		path = append(path, field.Name)
		ss = field.SelectionSet
	}
	return path
}

// findDeepestField finds the last field in the selection set whose position is before cursor.
func findDeepestField(ss ast.SelectionSet, cursorPos int) *ast.Field {
	var best *ast.Field
	for _, sel := range ss {
		field, ok := sel.(*ast.Field)
		if !ok || field.Position == nil {
			continue
		}
		if field.Position.Start <= cursorPos {
			best = field
		}
	}
	return best
}

// resolveInSelectionSet recursively determines cursor context.
func resolveInSelectionSet(ss ast.SelectionSet, code string, cursorPos int, prefix string, opType string, parentPath []string) *CursorContext {
	field := findDeepestField(ss, cursorPos)

	if field == nil {
		return &CursorContext{
			Kind:          ContextSelectionSet,
			FieldPath:     copySlice(parentPath),
			Prefix:        prefix,
			Depth:         len(parentPath) + 1,
			OperationType: opType,
		}
	}

	// Check if cursor is inside this field's arguments (either parsed or empty parens)
	if len(field.Arguments) > 0 {
		if ctx := resolveInFieldArgs(field, code, cursorPos, prefix, opType, parentPath); ctx != nil {
			return ctx
		}
	} else if ctx := resolveInEmptyArgs(field, code, cursorPos, prefix, opType, parentPath); ctx != nil {
		return ctx
	}

	// Check if cursor is inside a directive on this field
	if ctx := resolveInDirective(field, code, cursorPos, prefix, opType, parentPath); ctx != nil {
		return ctx
	}

	// Check if field has a selection set and cursor is inside it
	if len(field.SelectionSet) > 0 {
		// Only recurse if cursor is past the field name (and any arguments).
		// If cursor is still on the field name, stay in parent context for hover.
		fieldEnd := fieldNameEnd(field, code)
		if cursorPos > fieldEnd {
			newPath := append(copySlice(parentPath), field.Name)
			return resolveInSelectionSet(field.SelectionSet, code, cursorPos, prefix, opType, newPath)
		}
	}

	// Field has no selection set — check if there's a { in the text after this field
	// (incomplete parse where parser didn't create a selection set)
	if hasOpenBraceAfterField(code, field, cursorPos) {
		newPath := append(copySlice(parentPath), field.Name)
		return &CursorContext{
			Kind:          ContextSelectionSet,
			FieldPath:     newPath,
			Prefix:        prefix,
			Depth:         len(newPath) + 1,
			OperationType: opType,
		}
	}

	// Cursor is on the field itself — selection set completion in parent
	return &CursorContext{
		Kind:          ContextSelectionSet,
		FieldPath:     copySlice(parentPath),
		Prefix:        prefix,
		Depth:         len(parentPath) + 1,
		OperationType: opType,
	}
}

// resolveInEmptyArgs handles the case where cursor is inside parentheses but
// the parser didn't create any Argument nodes (empty parens or incomplete input).
func resolveInEmptyArgs(field *ast.Field, code string, cursorPos int, prefix string, opType string, path []string) *CursorContext {
	// Scan from after field name to find '('
	parenPos := -1
	for i := field.Position.Start + len(field.Name); i < len(code) && i < cursorPos+1; i++ {
		if code[i] == '(' {
			parenPos = i
			break
		}
		// Stop at '{' — we've passed into selection set
		if code[i] == '{' {
			return nil
		}
	}
	if parenPos < 0 || cursorPos <= parenPos {
		return nil
	}

	// Find matching close paren
	closeParen := findMatchingCloseParen(code, parenPos)
	if closeParen >= 0 && cursorPos > closeParen {
		return nil // cursor is after the arguments
	}

	// Cursor is between ( and ) with no parsed args — argument name context
	return &CursorContext{
		Kind:          ContextArgument,
		FieldPath:     copySlice(path),
		Prefix:        prefix,
		ParentField:   field.Name,
		Depth:         len(path) + 1,
		OperationType: opType,
	}
}

// resolveInFieldArgs handles argument context resolution using the AST.
func resolveInFieldArgs(field *ast.Field, code string, cursorPos int, prefix string, opType string, path []string) *CursorContext {
	// The parser captured arguments. Check if cursor is within the argument area.
	// We need to determine if cursor is between ( and ) for this field.
	firstArg := field.Arguments[0]
	lastArg := field.Arguments[len(field.Arguments)-1]

	if firstArg.Position == nil || lastArg.Position == nil {
		return nil
	}

	// The argument starts at or after the open paren. If cursor is before the first arg's position,
	// it might be before the args entirely.
	// Find the open paren
	parenPos := -1
	for i := field.Position.Start + len(field.Name); i < len(code) && i < firstArg.Position.Start; i++ {
		if code[i] == '(' {
			parenPos = i
			break
		}
	}
	if parenPos < 0 || cursorPos <= parenPos {
		return nil
	}

	// Find closing paren
	closeParen := findMatchingCloseParen(code, parenPos)
	if closeParen >= 0 && cursorPos > closeParen {
		return nil // cursor is after the arguments
	}

	// We're inside the arguments.
	// Check which specific argument context we're in.
	// The parser gives us one argument per detected "name:" or "name: value" pattern.

	// For the last arg (or only arg), check its type/position
	lastArgForCursor := lastArg
	for _, arg := range field.Arguments {
		if arg.Position != nil && arg.Position.Start <= cursorPos {
			lastArgForCursor = arg
		}
	}

	arg := lastArgForCursor

	// Check if cursor is on the argument name itself (before the colon).
	// If so, this is an argument name context (for hover/completion of arg names).
	if arg.Position != nil && cursorPos <= arg.Position.Start+len(arg.Name) {
		// Cursor is within the arg name text
		if !hasColonBetween(code, arg.Position.Start, cursorPos) {
			return &CursorContext{
				Kind:          ContextArgument,
				FieldPath:     copySlice(path),
				Prefix:        prefix,
				ParentField:   field.Name,
				Depth:         len(path) + 1,
				OperationType: opType,
			}
		}
	}

	// If the arg has no value, it could be:
	// 1. An arg name being typed (parser interpreted partial text as an arg with enum value)
	// 2. A colon followed by incomplete value
	if arg.Value == nil {
		// "filter: " — arg name captured, no value yet. Cursor is after colon.
		return &CursorContext{
			Kind:          ContextArgumentValue,
			FieldPath:     copySlice(path),
			Prefix:        prefix,
			ParentField:   field.Name,
			ArgumentName:  arg.Name,
			Depth:         len(path) + 1,
			OperationType: opType,
		}
	}

	// Check if arg.Value indicates a variable ($)
	if arg.Value.Kind == ast.Variable || (len(prefix) > 0 && prefix[0] == '$') {
		return &CursorContext{
			Kind:          ContextVariable,
			FieldPath:     copySlice(path),
			Prefix:        trimDollar(prefix),
			ParentField:   field.Name,
			Depth:         len(path) + 1,
			OperationType: opType,
		}
	}

	// ObjectValue — inside input object
	if arg.Value.Kind == ast.ObjectValue {
		inputPath := buildInputPath(arg.Value, cursorPos)
		return &CursorContext{
			Kind:          ContextArgumentValue,
			FieldPath:     copySlice(path),
			Prefix:        prefix,
			ParentField:   field.Name,
			ArgumentName:  arg.Name,
			InputPath:     inputPath,
			Depth:         len(path) + 1,
			OperationType: opType,
		}
	}

	// ListValue — e.g. order_by: [{direction: ASC}]
	if arg.Value.Kind == ast.ListValue {
		inputPath := buildInputPathInList(arg.Value, cursorPos)
		return &CursorContext{
			Kind:          ContextArgumentValue,
			FieldPath:     copySlice(path),
			Prefix:        prefix,
			ParentField:   field.Name,
			ArgumentName:  arg.Name,
			InputPath:     inputPath,
			Depth:         len(path) + 1,
			OperationType: opType,
		}
	}

	// If the arg has a value with Kind == EnumValue and its raw matches the prefix,
	// the parser likely interpreted an incomplete arg name as a value.
	// e.g., "data_sources(fi" → parser creates Arg{Name:"fi", Value:{Kind:EnumValue, Raw:"fi"}}
	// But from our debug: it's Arg{Name:"fi"} with Value present.
	// Actually from debug: Arg: "fi" kind=7 raw="fi" — this is an arg name being typed.
	// The parser creates an arg with the partial name and treats the prefix as the value.
	// This means we're actually in ContextArgument.
	if arg.Value.Kind == ast.EnumValue && arg.Value.Raw == prefix && !hasColonBetween(code, arg.Position.Start, cursorPos) {
		return &CursorContext{
			Kind:          ContextArgument,
			FieldPath:     copySlice(path),
			Prefix:        prefix,
			ParentField:   field.Name,
			Depth:         len(path) + 1,
			OperationType: opType,
		}
	}

	// Default: argument value context
	return &CursorContext{
		Kind:          ContextArgumentValue,
		FieldPath:     copySlice(path),
		Prefix:        prefix,
		ParentField:   field.Name,
		ArgumentName:  arg.Name,
		Depth:         len(path) + 1,
		OperationType: opType,
	}
}

// buildInputPath walks through nested ObjectValues in the AST to find the path to cursor.
func buildInputPath(val *ast.Value, cursorPos int) []string {
	if val == nil || val.Kind != ast.ObjectValue || len(val.Children) == 0 {
		return nil
	}

	// Find the child closest to cursor, skipping spurious empty-name children
	// that the parser creates for partial input.
	var lastChild *ast.ChildValue
	for _, child := range val.Children {
		if child.Position != nil && child.Position.Start <= cursorPos && child.Name != "" {
			lastChild = child
		}
	}

	if lastChild == nil {
		return nil
	}

	// Check if cursor is still on the child's name (before the colon).
	// If so, don't include it in the path — the caller needs to look up
	// this name in the current type.
	if lastChild.Position != nil && cursorPos <= lastChild.Position.Start+len(lastChild.Name) {
		return nil
	}

	// If this child has an ObjectValue, recurse
	if lastChild.Value != nil && lastChild.Value.Kind == ast.ObjectValue {
		sub := buildInputPath(lastChild.Value, cursorPos)
		return append([]string{lastChild.Name}, sub...)
	}

	// If this child has a ListValue, find the list element containing cursor
	if lastChild.Value != nil && lastChild.Value.Kind == ast.ListValue {
		sub := buildInputPathInList(lastChild.Value, cursorPos)
		return append([]string{lastChild.Name}, sub...)
	}

	// The child is a leaf value (scalar, enum, etc.) — include it in the path
	// so the completer can resolve the field's type for value completion
	// (e.g., direction: ASC → path=["direction"] → resolve to OrderDirection ENUM)
	return []string{lastChild.Name}
}

// buildInputPathInList walks through list elements to find the one containing cursor,
// then recurses into it as an ObjectValue.
func buildInputPathInList(listVal *ast.Value, cursorPos int) []string {
	if listVal == nil || len(listVal.Children) == 0 {
		return nil
	}

	// List children are unnamed; find the one closest to cursor
	var bestChild *ast.ChildValue
	for _, child := range listVal.Children {
		if child.Value != nil && child.Value.Position != nil && child.Value.Position.Start <= cursorPos {
			bestChild = child
		}
	}

	if bestChild == nil || bestChild.Value == nil {
		return nil
	}

	// If it's an ObjectValue, recurse into it
	if bestChild.Value.Kind == ast.ObjectValue {
		return buildInputPath(bestChild.Value, cursorPos)
	}

	return nil
}

// resolveInDirective checks if the cursor is inside a directive's arguments on a field.
// e.g., @cache(ttl: 60) or @skip(if: true)
func resolveInDirective(field *ast.Field, code string, cursorPos int, prefix string, opType string, path []string) *CursorContext {
	// Find @directive( pattern in the text between field args end and cursor position
	argsEnd := field.Position.Start + len(field.Name)
	if len(field.Arguments) > 0 {
		for i := field.Position.Start; i < len(code) && i < cursorPos; i++ {
			if code[i] == '(' {
				cp := findMatchingCloseParen(code, i)
				if cp >= 0 {
					argsEnd = cp + 1
				}
				break
			}
		}
	}

	// Scan from argsEnd to cursorPos only — we're looking for a directive
	// that the cursor is currently inside of.
	scanStart := argsEnd
	for scanStart < cursorPos {
		// Find @
		atPos := -1
		for i := scanStart; i < cursorPos; i++ {
			if code[i] == '@' {
				atPos = i
				break
			}
			if code[i] == '{' {
				return nil // hit selection set
			}
		}
		if atPos < 0 {
			return nil
		}

		// Extract directive name after @
		nameStart := atPos + 1
		nameEnd := nameStart
		for nameEnd < len(code) && isIdentByte(code[nameEnd]) {
			nameEnd++
		}
		if nameEnd == nameStart {
			scanStart = nameEnd + 1
			continue
		}
		dirName := code[nameStart:nameEnd]

		// Find the opening paren of directive args
		parenPos := -1
		for i := nameEnd; i < len(code); i++ {
			if code[i] == '(' {
				parenPos = i
				break
			}
			if !isWhitespaceByte(code[i]) {
				break // directive has no args
			}
		}

		if parenPos < 0 || cursorPos <= parenPos {
			// No args parens or cursor is before them
			scanStart = nameEnd
			continue
		}

		// Find closing paren
		closeParen := findMatchingCloseParen(code, parenPos)
		if closeParen >= 0 && cursorPos > closeParen {
			// Cursor is after this directive's args, check next directive
			scanStart = closeParen + 1
			continue
		}

		// Cursor is inside @directive( ... )
		argName := ""
		hasColon := false
		for _, dir := range field.Directives {
			if dir.Name == dirName {
				for _, arg := range dir.Arguments {
					if arg.Position != nil && arg.Position.Start <= cursorPos {
						argName = arg.Name
						if hasColonBetween(code, arg.Position.Start, cursorPos) {
							hasColon = true
						}
					}
				}
				break
			}
		}

		if hasColon && argName != "" {
			return &CursorContext{
				Kind:          ContextDirectiveArg,
				FieldPath:     copySlice(path),
				Prefix:        prefix,
				DirectiveName: dirName,
				ArgumentName:  argName,
				Depth:         len(path) + 1,
				OperationType: opType,
			}
		}

		return &CursorContext{
			Kind:          ContextDirectiveArg,
			FieldPath:     copySlice(path),
			Prefix:        prefix,
			DirectiveName: dirName,
			Depth:         len(path) + 1,
			OperationType: opType,
		}
	}

	return nil
}

// extractPrefix scans backward from cursorPos to find the partial token being typed.
func extractPrefix(code string, cursorPos int) string {
	start := cursorPos
	for start > 0 {
		ch := code[start-1]
		if isIdentByte(ch) || ch == '$' {
			start--
		} else {
			break
		}
	}
	return code[start:cursorPos]
}

func isIdentByte(ch byte) bool {
	return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_'
}

func isDirectiveContext(code string, cursorPos int, prefix string) bool {
	checkPos := cursorPos - len(prefix) - 1
	if checkPos >= 0 && code[checkPos] == '@' {
		return true
	}
	if prefix == "" && cursorPos > 0 && code[cursorPos-1] == '@' {
		return true
	}
	return false
}

func findMatchingCloseParen(code string, parenPos int) int {
	depth := 0
	for i := parenPos; i < len(code); i++ {
		switch code[i] {
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				return i
			}
		case '"':
			i++
			for i < len(code) && code[i] != '"' {
				if code[i] == '\\' {
					i++
				}
				i++
			}
		}
	}
	return -1
}

func hasOpenBraceAfterField(code string, field *ast.Field, cursorPos int) bool {
	startPos := field.Position.Start + len(field.Name)
	if len(field.Arguments) > 0 {
		// Find the closing paren after arguments
		for i := field.Position.Start; i < len(code) && i < cursorPos; i++ {
			if code[i] == '(' {
				cp := findMatchingCloseParen(code, i)
				if cp >= 0 {
					startPos = cp + 1
				}
				break
			}
		}
	}
	for i := startPos; i < cursorPos && i < len(code); i++ {
		if code[i] == '{' {
			return true
		}
	}
	return false
}

// fieldNameEnd returns the position just after the field name and any arguments.
// For `data_sources(filter: {...})` it returns the position after `)`.
// For `name` it returns the position after the name.
func fieldNameEnd(field *ast.Field, code string) int {
	end := field.Position.Start + len(field.Name)
	// Look for '(' after field name — either parsed args or empty parens
	for i := end; i < len(code); i++ {
		ch := code[i]
		if ch == '(' {
			cp := findMatchingCloseParen(code, i)
			if cp >= 0 {
				return cp + 1
			}
			return i // unclosed paren
		}
		if ch == '{' || ch == '}' || ch == '\n' {
			break // hit selection set or line end before any parens
		}
		if !isWhitespaceByte(ch) {
			break
		}
	}
	return end
}

func isWhitespaceByte(ch byte) bool {
	return ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n'
}

func hasColonBetween(code string, start, end int) bool {
	for i := start; i < end && i < len(code); i++ {
		if code[i] == ':' {
			return true
		}
	}
	return false
}

func trimDollar(s string) string {
	if len(s) > 0 && s[0] == '$' {
		return s[1:]
	}
	return s
}

func copySlice(s []string) []string {
	if len(s) == 0 {
		return nil
	}
	cp := make([]string, len(s))
	copy(cp, s)
	return cp
}

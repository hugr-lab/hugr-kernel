package renderer

import (
	"fmt"
	"strings"
)

// RenderTable formats columns and rows as a plain text ASCII table.
func RenderTable(columns []string, rows [][]string) string {
	if len(columns) == 0 {
		return ""
	}

	// Calculate column widths
	widths := make([]int, len(columns))
	for i, col := range columns {
		widths[i] = len(col)
	}
	for _, row := range rows {
		for i, cell := range row {
			if i < len(widths) && len(cell) > widths[i] {
				widths[i] = len(cell)
			}
		}
	}

	var buf strings.Builder

	// Separator line
	separator := "+"
	for _, w := range widths {
		separator += strings.Repeat("-", w+2) + "+"
	}

	// Header
	buf.WriteString(separator + "\n")
	buf.WriteString("|")
	for i, col := range columns {
		buf.WriteString(fmt.Sprintf(" %-*s |", widths[i], col))
	}
	buf.WriteString("\n")
	buf.WriteString(separator + "\n")

	// Rows
	for _, row := range rows {
		buf.WriteString("|")
		for i := range columns {
			cell := ""
			if i < len(row) {
				cell = row[i]
			}
			buf.WriteString(fmt.Sprintf(" %-*s |", widths[i], cell))
		}
		buf.WriteString("\n")
	}

	buf.WriteString(separator)
	return buf.String()
}

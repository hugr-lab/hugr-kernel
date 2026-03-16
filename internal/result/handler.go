package result

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/apache/arrow-go/v18/arrow/memory"
	"github.com/hugr-lab/query-engine/types"
)

// ArrowURLProvider provides Arrow streaming URLs.
type ArrowURLProvider interface {
	BaseURL() string
	ArrowURL(queryID string, totalRows int64) string
}

// PartDef describes a single result part for viewer metadata.
type PartDef struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"`
	Title    string       `json:"title"`
	ArrowURL string       `json:"arrow_url,omitempty"`
	Rows     int64        `json:"rows,omitempty"`
	Columns  []ColumnDef  `json:"columns,omitempty"`
	DataSize int64        `json:"data_size_bytes,omitempty"`
	Data     any          `json:"data,omitempty"`
	Errors   []ErrorDef   `json:"errors,omitempty"`
}

// ColumnDef describes a column in an Arrow result part.
type ColumnDef struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// ErrorDef describes a GraphQL error.
type ErrorDef struct {
	Message    string   `json:"message"`
	Path       []string `json:"path,omitempty"`
	Extensions any      `json:"extensions,omitempty"`
}

// ViewerMetadata is the MIME-typed payload for display_data messages.
// Includes backward-compatible flat fields from the first Arrow part
// so the existing DuckDB kernel widget can render without modification.
type ViewerMetadata struct {
	Parts       []PartDef `json:"parts"`
	BaseURL     string    `json:"base_url"`
	QueryTimeMs int64     `json:"query_time_ms"`

	// Backward-compatible flat fields (from first Arrow part)
	QueryID      string      `json:"query_id,omitempty"`
	ArrowURL     string      `json:"arrow_url,omitempty"`
	Rows         int64       `json:"rows,omitempty"`
	Columns      []ColumnDef `json:"columns,omitempty"`
	DataSizeBytes int64      `json:"data_size_bytes,omitempty"`
}

// Handler processes Hugr responses into viewer metadata.
type Handler struct {
	spool       *Spool
	arrowServer ArrowURLProvider
}

// NewHandler creates a result handler.
func NewHandler(spool *Spool, arrowServer ArrowURLProvider) *Handler {
	return &Handler{
		spool:       spool,
		arrowServer: arrowServer,
	}
}

// HandleResponse walks the Hugr response, classifies parts, spools Arrow data,
// and builds viewer metadata. Returns the metadata and a text/plain fallback.
func (h *Handler) HandleResponse(resp *types.Response, queryID string, queryTimeMs int64) (*ViewerMetadata, string, error) {
	if resp == nil {
		return nil, "No results.", nil
	}

	var parts []PartDef
	var textParts []string

	// Process errors
	if len(resp.Errors) > 0 {
		var errors []ErrorDef
		for _, e := range resp.Errors {
			ed := ErrorDef{Message: e.Message}
			if e.Path != nil {
				for _, p := range e.Path {
					ed.Path = append(ed.Path, fmt.Sprintf("%v", p))
				}
			}
			if e.Extensions != nil {
				ed.Extensions = e.Extensions
			}
			errors = append(errors, ed)
		}
		parts = append(parts, PartDef{
			ID:     "errors",
			Type:   "error",
			Title:  "Errors",
			Errors: errors,
		})
		for _, e := range resp.Errors {
			textParts = append(textParts, fmt.Sprintf("Error: %s", e.Message))
		}
	}

	// Walk data recursively
	partIndex := 0
	if resp.Data != nil {
		h.walkData("data", resp.Data, queryID, &partIndex, &parts, &textParts)
	}

	// Walk extensions — single part for all extensions
	if resp.Extensions != nil && len(resp.Extensions) > 0 {
		parts = append(parts, PartDef{
			ID:    "extensions",
			Type:  "json",
			Title: "extensions",
			Data:  resp.Extensions,
		})
		data, _ := json.MarshalIndent(resp.Extensions, "", "  ")
		textParts = append(textParts, fmt.Sprintf("[extensions]\n%s", string(data)))
	}

	if len(parts) == 0 {
		return nil, "No results.", nil
	}

	textFallback := strings.Join(textParts, "\n\n")

	if h.arrowServer == nil {
		return nil, textFallback, nil
	}

	metadata := &ViewerMetadata{
		Parts:       parts,
		BaseURL:     h.arrowServer.BaseURL(),
		QueryTimeMs: queryTimeMs,
	}

	// Populate backward-compatible flat fields from the first Arrow part
	for _, p := range parts {
		if p.Type == "arrow" && p.ArrowURL != "" {
			metadata.QueryID = p.ID
			metadata.ArrowURL = p.ArrowURL
			metadata.Rows = p.Rows
			metadata.Columns = p.Columns
			metadata.DataSizeBytes = p.DataSize
			break
		}
	}

	return metadata, textFallback, nil
}

func (h *Handler) walkData(prefix string, data map[string]any, queryID string, partIndex *int, parts *[]PartDef, textParts *[]string) {
	for key, val := range data {
		path := prefix + "." + key
		// Title = path relative to "data." prefix
		title := strings.TrimPrefix(path, "data.")
		switch v := val.(type) {
		case types.ArrowTable:
			partID := fmt.Sprintf("%s_%d", queryID, *partIndex)
			*partIndex++
			part, text := h.handleArrowPart(path, title, partID, v)
			if part != nil {
				*parts = append(*parts, *part)
			}
			if text != "" {
				*textParts = append(*textParts, text)
			}

		case *types.JsonValue:
			jsonStr := string(*v)
			var parsed any
			if err := json.Unmarshal([]byte(jsonStr), &parsed); err != nil {
				parsed = jsonStr
			}
			*parts = append(*parts, PartDef{
				ID:    path,
				Type:  "json",
				Title: title,
				Data:  parsed,
			})
			*textParts = append(*textParts, fmt.Sprintf("[%s]\n%s", title, jsonStr))

		case map[string]any:
			// Nested object — recurse
			h.walkData(path, v, queryID, partIndex, parts, textParts)

		default:
			// Other scalar/JSON values
			*parts = append(*parts, PartDef{
				ID:    path,
				Type:  "json",
				Title: title,
				Data:  val,
			})
			data, _ := json.MarshalIndent(val, "", "  ")
			*textParts = append(*textParts, fmt.Sprintf("[%s]\n%s", title, string(data)))
		}
	}
}

func (h *Handler) handleArrowPart(path, title, partID string, table types.ArrowTable) (*PartDef, string) {
	records, err := table.Records()
	if err != nil {
		log.Printf("arrow records error for %s: %v", path, err)
		return nil, fmt.Sprintf("[%s] Error reading Arrow data: %v", title, err)
	}
	if len(records) == 0 {
		return &PartDef{
			ID:    path,
			Type:  "arrow",
			Title: title,
			Rows:  0,
		}, fmt.Sprintf("[%s] (no rows)", title)
	}

	// Flatten complex types (Struct→dot-separated columns, List/Map/Union→JSON strings)
	// so Perspective viewer can display them correctly.
	if types.NeedsFlatten(records[0].Schema()) {
		mem := memory.DefaultAllocator
		for i, rec := range records {
			flat := types.FlattenRecord(rec, mem)
			rec.Release()
			records[i] = flat
		}
	}

	// Calculate total rows
	var totalRows int64
	for _, rec := range records {
		totalRows += rec.NumRows()
	}

	// Extract column definitions from schema
	schema := records[0].Schema()
	columns := make([]ColumnDef, schema.NumFields())
	for i, field := range schema.Fields() {
		columns[i] = ColumnDef{
			Name: field.Name,
			Type: field.Type.String(),
		}
	}

	// Spool to disk
	if h.spool != nil {
		sw, err := h.spool.NewStreamWriter(partID)
		if err != nil {
			log.Printf("spool create error for %s: %v", path, err)
		} else {
			for _, rec := range records {
				if err := sw.Write(rec); err != nil {
					log.Printf("spool write error for %s: %v", path, err)
					break
				}
			}
			sw.Close()

			if err := h.spool.Cleanup(); err != nil {
				log.Printf("spool cleanup error: %v", err)
			}
		}
	}

	// Release records
	for _, rec := range records {
		rec.Release()
	}

	part := &PartDef{
		ID:      path,
		Type:    "arrow",
		Title:   title,
		Rows:    totalRows,
		Columns: columns,
	}

	if h.arrowServer != nil && h.spool != nil {
		part.ArrowURL = h.arrowServer.ArrowURL(partID, totalRows)
		if info, err := os.Stat(h.spool.Path(partID)); err == nil {
			part.DataSize = info.Size()
		}
	}

	// Text fallback: column names + row count
	colNames := make([]string, len(columns))
	for i, c := range columns {
		colNames[i] = c.Name
	}
	text := fmt.Sprintf("[%s] %d rows, columns: %s", title, totalRows, strings.Join(colNames, ", "))

	return part, text
}

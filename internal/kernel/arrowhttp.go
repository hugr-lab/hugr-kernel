package kernel

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/apache/arrow-go/v18/arrow"
	"github.com/apache/arrow-go/v18/arrow/array"
	"github.com/apache/arrow-go/v18/arrow/ipc"
	"github.com/apache/arrow-go/v18/arrow/memory"
	"github.com/hugr-lab/duckdb-kernel/pkg/geoarrow"
	"github.com/hugr-lab/hugr-kernel/internal/result"
)

// corsOrigin returns the CORS origin from HUGR_KERNEL_CORS_ORIGIN env var, defaulting to "*".
func corsOrigin() string {
	if v := os.Getenv("HUGR_KERNEL_CORS_ORIGIN"); v != "" {
		return v
	}
	return "*"
}

const maxArrowRows = 5_000_000

// ArrowServer serves Arrow IPC files over HTTP directly from the spool.
type ArrowServer struct {
	spool    *result.Spool
	listener net.Listener
	server   *http.Server
}

// NewArrowServer creates and starts an HTTP server on a random port.
func NewArrowServer(sp *result.Spool) (*ArrowServer, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("listen: %w", err)
	}

	as := &ArrowServer{
		spool:    sp,
		listener: ln,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/arrow", as.handleArrow)
	mux.HandleFunc("/arrow/stream", as.handleArrowStream)
	mux.HandleFunc("/spool/delete", as.handleSpoolDelete)
	mux.HandleFunc("/spool/pin", as.handleSpoolPin)
	mux.HandleFunc("/spool/unpin", as.handleSpoolUnpin)
	mux.HandleFunc("/spool/is_pinned", as.handleSpoolIsPinned)

	// Serve perspective static files if available.
	if exePath, err := os.Executable(); err == nil {
		staticDir := filepath.Join(filepath.Dir(exePath), "static", "perspective")
		if info, err := os.Stat(staticDir); err == nil && info.IsDir() {
			fs := http.StripPrefix("/static/perspective/", http.FileServer(http.Dir(staticDir)))
			mux.Handle("/static/perspective/", fs)
			log.Printf("Serving perspective static files from %s", staticDir)
		}
	}

	// Wrap all handlers with CORS (required for VS Code webview)
	as.server = &http.Server{
		Handler:      addCORS(mux),
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 5 * time.Minute,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		if err := as.server.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("arrow http server error: %v", err)
		}
	}()

	log.Printf("Arrow HTTP server listening on %s", ln.Addr().String())
	return as, nil
}

// Port returns the port the server is listening on.
func (as *ArrowServer) Port() int {
	return as.listener.Addr().(*net.TCPAddr).Port
}

// Close shuts down the HTTP server.
func (as *ArrowServer) Close() error {
	return as.server.Close()
}

// BaseURL returns the base URL of the Arrow HTTP server.
func (as *ArrowServer) BaseURL() string {
	return fmt.Sprintf("http://127.0.0.1:%d", as.Port())
}

// ArrowURL returns the URL for fetching the given query's Arrow data.
func (as *ArrowServer) ArrowURL(queryID string, totalRows int64) string {
	if totalRows > maxArrowRows {
		return fmt.Sprintf(
			"http://127.0.0.1:%d/arrow/stream?q=%s&limit=%d&total=%d",
			as.Port(), queryID, maxArrowRows, totalRows,
		)
	}
	return fmt.Sprintf("http://127.0.0.1:%d/arrow/stream?q=%s", as.Port(), queryID)
}

func (as *ArrowServer) handleArrow(w http.ResponseWriter, r *http.Request) {
	queryID := r.URL.Query().Get("q")
	if queryID == "" {
		http.Error(w, "missing q parameter", http.StatusBadRequest)
		return
	}

	path := as.spool.FindPath(queryID)
	if path == "" {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/vnd.apache.arrow.stream")
	w.Header().Set("Access-Control-Allow-Origin", corsOrigin())
	as.streamRawFile(w, path)
}

func (as *ArrowServer) handleArrowStream(w http.ResponseWriter, r *http.Request) {
	queryID := r.URL.Query().Get("q")
	if queryID == "" {
		http.Error(w, "missing q parameter", http.StatusBadRequest)
		return
	}

	limit := 0
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}

	wantGeoArrow := r.URL.Query().Get("geoarrow") == "1"
	columnsParam := r.URL.Query().Get("columns")

	reader, closer, err := as.spool.OpenReader(queryID)
	if err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "not found", http.StatusNotFound)
		} else {
			http.Error(w, err.Error(), http.StatusInternalServerError)
		}
		return
	}
	defer closer.Close()
	defer reader.Release()

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Access-Control-Allow-Origin", corsOrigin())

	flusher, canFlush := w.(http.Flusher)
	schema := reader.Schema()

	// Detect geometry columns: native GeoArrow (already converted) + WKB (fallback).
	geoIndices := detectNativeGeoColumns(schema)
	wkbCols := geoarrow.DetectGeometryColumns(schema) // WKB that wasn't converted in pipeline

	// Build column projection set
	var projectCols map[string]bool
	if columnsParam != "" {
		projectCols = make(map[string]bool)
		for _, col := range strings.Split(columnsParam, ",") {
			col = strings.TrimSpace(col)
			if col != "" {
				projectCols[col] = true
			}
		}
	}

	written := 0
	for reader.Next() {
		rec := reader.RecordBatch()
		rows := int(rec.NumRows())

		writeRec := rec
		last := false
		sliced := false

		if limit > 0 && written+rows > limit {
			need := limit - written
			if need <= 0 {
				break
			}
			writeRec = rec.NewSlice(0, int64(need))
			sliced = true
			rows = need
			last = true
		}

		if wantGeoArrow {
			// Fallback: convert any remaining WKB columns that weren't
			// converted in the pipeline (e.g. LargeBinary).
			for _, gc := range wkbCols {
				if gc.Format != "WKB" {
					continue
				}
				converted, _, err := geoarrow.ConvertBatch(writeRec, gc, 0, memory.DefaultAllocator)
				if err != nil {
					log.Printf("geoarrow fallback convert error for %s: %v", gc.Name, err)
					continue
				}
				if converted != writeRec {
					if sliced {
						writeRec.Release()
					}
					writeRec = converted
					sliced = true
				}
			}
		} else {
			// Replace all geometry columns (native + WKB) with "{geometry}".
			allGeo := geoIndices
			for _, gc := range wkbCols {
				allGeo = append(allGeo, gc.Index)
			}
			if len(allGeo) > 0 {
				replaced := replaceGeoColumnsByIndex(writeRec, allGeo)
				if replaced != nil {
					if sliced {
						writeRec.Release()
					}
					writeRec = replaced
					sliced = true
				}
			}
		}

		// Apply column projection
		if len(projectCols) > 0 {
			projected := projectRecord(writeRec, projectCols)
			if projected != nil {
				if sliced {
					writeRec.Release()
				}
				writeRec = projected
				sliced = true
			}
		}

		var buf bytes.Buffer
		w2 := ipc.NewWriter(&buf, ipc.WithSchema(writeRec.Schema()))
		if err := w2.Write(writeRec); err != nil {
			if sliced {
				writeRec.Release()
			}
			log.Printf("arrow stream: write batch error: %v", err)
			break
		}
		w2.Close()

		if sliced {
			writeRec.Release()
		}

		chunk := buf.Bytes()
		lenBuf := make([]byte, 4)
		binary.LittleEndian.PutUint32(lenBuf, uint32(len(chunk)))
		if _, err := w.Write(lenBuf); err != nil {
			break
		}
		if _, err := w.Write(chunk); err != nil {
			break
		}

		if canFlush {
			flusher.Flush()
		}

		written += rows
		if last {
			break
		}
	}

	// Zero-length terminator
	w.Write([]byte{0, 0, 0, 0})
	if canFlush {
		flusher.Flush()
	}
}

// queryParam extracts the query ID from either "q" or "query_id" parameter.
func queryParam(r *http.Request) string {
	if q := r.URL.Query().Get("q"); q != "" {
		return q
	}
	return r.URL.Query().Get("query_id")
}

// handleSpoolDelete deletes a spool file from both volatile and persistent storage.
func (as *ArrowServer) handleSpoolDelete(w http.ResponseWriter, r *http.Request) {
	queryID := queryParam(r)
	if queryID == "" {
		http.Error(w, "missing q parameter", http.StatusBadRequest)
		return
	}
	errVolatile := as.spool.Remove(queryID)
	errPinned := as.spool.Unpin(queryID)
	if errVolatile != nil && errPinned != nil {
		if os.IsNotExist(errVolatile) {
			http.Error(w, "not found", http.StatusNotFound)
		} else {
			http.Error(w, errVolatile.Error(), http.StatusInternalServerError)
		}
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"status": "ok"})
}

// handleSpoolPin pins (persists) a spool file.
func (as *ArrowServer) handleSpoolPin(w http.ResponseWriter, r *http.Request) {
	queryID := queryParam(r)
	if queryID == "" {
		http.Error(w, "missing q parameter", http.StatusBadRequest)
		return
	}
	if err := as.spool.Pin(queryID); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"status": "ok", "pinned": true})
}

// handleSpoolUnpin removes a pinned result.
func (as *ArrowServer) handleSpoolUnpin(w http.ResponseWriter, r *http.Request) {
	queryID := queryParam(r)
	if queryID == "" {
		http.Error(w, "missing q parameter", http.StatusBadRequest)
		return
	}
	if err := as.spool.Unpin(queryID); err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "not found", http.StatusNotFound)
		} else {
			http.Error(w, err.Error(), http.StatusInternalServerError)
		}
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"status": "ok", "pinned": false})
}

// handleSpoolIsPinned checks if a result is pinned.
func (as *ArrowServer) handleSpoolIsPinned(w http.ResponseWriter, r *http.Request) {
	queryID := queryParam(r)
	if queryID == "" {
		http.Error(w, "missing q parameter", http.StatusBadRequest)
		return
	}
	pinned := as.spool.IsPinned(queryID)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"pinned": pinned})
}

func (as *ArrowServer) streamRawFile(w http.ResponseWriter, path string) {
	f, err := os.Open(path)
	if err != nil {
		log.Printf("arrow: open error: %v", err)
		return
	}
	defer f.Close()

	if info, err := f.Stat(); err == nil {
		w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	}

	if _, err := io.Copy(w, f); err != nil {
		log.Printf("arrow: copy error: %v", err)
	}
}

// detectNativeGeoColumns finds columns with native GeoArrow extension types
// (geoarrow.multipoint, geoarrow.multilinestring, geoarrow.multipolygon, etc.)
// in a schema. Returns their indices.
func detectNativeGeoColumns(schema *arrow.Schema) []int {
	var indices []int
	for i, f := range schema.Fields() {
		if f.Metadata.Len() == 0 {
			continue
		}
		idx := f.Metadata.FindKey("ARROW:extension:name")
		if idx < 0 {
			continue
		}
		ext := f.Metadata.Values()[idx]
		if strings.HasPrefix(ext, "geoarrow.") || strings.HasPrefix(ext, "ogc.") {
			indices = append(indices, i)
		}
	}
	return indices
}

// replaceGeoColumnsByIndex replaces geometry columns (by index) with "{geometry}" strings.
func replaceGeoColumnsByIndex(rec arrow.RecordBatch, geoIndices []int) arrow.RecordBatch {
	if len(geoIndices) == 0 {
		return nil
	}
	numRows := int(rec.NumRows())
	geoSet := make(map[int]bool, len(geoIndices))
	for _, idx := range geoIndices {
		geoSet[idx] = true
	}

	fields := make([]arrow.Field, len(rec.Schema().Fields()))
	copy(fields, rec.Schema().Fields())
	cols := make([]arrow.Array, rec.NumCols())

	var strArrays []arrow.Array // track for release
	for i := 0; i < int(rec.NumCols()); i++ {
		if geoSet[i] {
			bldr := array.NewStringBuilder(memory.DefaultAllocator)
			origCol := rec.Column(i)
			for j := 0; j < numRows; j++ {
				if origCol.IsNull(j) {
					bldr.AppendNull()
				} else {
					bldr.Append("{geometry}")
				}
			}
			strArr := bldr.NewArray()
			bldr.Release()
			cols[i] = strArr
			strArrays = append(strArrays, strArr)
			fields[i] = arrow.Field{
				Name:     fields[i].Name,
				Type:     arrow.BinaryTypes.String,
				Nullable: true,
			}
		} else {
			cols[i] = rec.Column(i)
		}
	}

	meta := rec.Schema().Metadata()
	newSchema := arrow.NewSchema(fields, &meta)
	newRec := array.NewRecordBatch(newSchema, cols, int64(numRows))

	for _, arr := range strArrays {
		arr.Release()
	}

	return newRec
}

// projectRecord selects only the named columns from a record batch.
func projectRecord(rec arrow.RecordBatch, cols map[string]bool) arrow.RecordBatch {
	schema := rec.Schema()
	var indices []int
	for i, f := range schema.Fields() {
		if cols[f.Name] {
			indices = append(indices, i)
		}
	}
	if len(indices) == 0 || len(indices) == len(schema.Fields()) {
		return nil // no projection needed
	}

	fields := make([]arrow.Field, len(indices))
	arrays := make([]arrow.Array, len(indices))
	for i, idx := range indices {
		fields[i] = schema.Field(idx)
		arrays[i] = rec.Column(idx)
	}
	meta := schema.Metadata()
	newSchema := arrow.NewSchema(fields, &meta)
	return array.NewRecordBatch(newSchema, arrays, rec.NumRows())
}

func addCORS(h http.Handler) http.Handler {
	origin := corsOrigin()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		h.ServeHTTP(w, r)
	})
}

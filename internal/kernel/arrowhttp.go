package kernel

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/apache/arrow-go/v18/arrow/ipc"
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

	// Serve perspective static files if available.
	if exePath, err := os.Executable(); err == nil {
		staticDir := filepath.Join(filepath.Dir(exePath), "static", "perspective")
		if info, err := os.Stat(staticDir); err == nil && info.IsDir() {
			fs := http.StripPrefix("/static/perspective/", http.FileServer(http.Dir(staticDir)))
			mux.Handle("/static/perspective/", addCORS(fs))
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

	path := as.spool.Path(queryID)
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "not found", http.StatusNotFound)
		} else {
			http.Error(w, err.Error(), http.StatusInternalServerError)
		}
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

		var buf bytes.Buffer
		w2 := ipc.NewWriter(&buf, ipc.WithSchema(schema))
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

func addCORS(h http.Handler) http.Handler {
	origin := corsOrigin()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		h.ServeHTTP(w, r)
	})
}

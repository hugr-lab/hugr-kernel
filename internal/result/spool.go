package result

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/apache/arrow-go/v18/arrow"
	"github.com/apache/arrow-go/v18/arrow/ipc"
)

const (
	DefaultMaxSize = 2 * 1024 * 1024 * 1024 // 2 GB
	DefaultTTL     = 24 * time.Hour
)

// Spool manages temporary Arrow IPC files with TTL-based cleanup and disk limits.
// Uses a flat directory (no session nesting) so results survive browser reload.
type Spool struct {
	Dir           string
	PersistentDir string // for pinned results (no TTL)
	MaxSize       int64
	TTL           time.Duration
}

// NewSpool creates a result spool in a flat directory under /tmp/hugr-kernel/.
// The sessionID parameter is kept for API compatibility but not used in directory structure.
func NewSpool(_ string) (*Spool, error) {
	dir := spoolDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create spool dir: %w", err)
	}

	sp := &Spool{
		Dir:     dir,
		MaxSize: envInt64("HUGR_KERNEL_SPOOL_MAX_SIZE", DefaultMaxSize),
		TTL:     envDuration("HUGR_KERNEL_SPOOL_TTL", DefaultTTL),
	}

	// Run initial cleanup
	sp.Cleanup()

	return sp, nil
}

func spoolDir() string {
	if v := os.Getenv("HUGR_KERNEL_SPOOL_DIR"); v != "" {
		return v
	}
	return filepath.Join(os.TempDir(), "hugr-kernel")
}

// SetPersistentDir sets the persistent storage for pinned results.
// Typically {notebook_dir}/.hugr-results/
func (s *Spool) SetPersistentDir(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create persistent dir: %w", err)
	}
	// Auto-create .gitignore
	gitignore := filepath.Join(dir, ".gitignore")
	if _, err := os.Stat(gitignore); os.IsNotExist(err) {
		os.WriteFile(gitignore, []byte("*.arrow\n"), 0o644)
	}
	s.PersistentDir = dir
	return nil
}

// StreamWriter writes Arrow record batches to an IPC streaming file with LZ4 compression.
type StreamWriter struct {
	w *ipc.Writer
	f *os.File
}

// NewStreamWriter creates a streaming IPC writer for the given query.
func (s *Spool) NewStreamWriter(queryID string) (*StreamWriter, error) {
	path := s.Path(queryID)
	f, err := os.Create(path)
	if err != nil {
		return nil, fmt.Errorf("create spool file: %w", err)
	}
	return &StreamWriter{f: f}, nil
}

// Write writes a single record batch to the IPC stream.
func (sw *StreamWriter) Write(rec arrow.Record) error {
	if sw.w == nil {
		sw.w = ipc.NewWriter(sw.f,
			ipc.WithSchema(rec.Schema()),
			ipc.WithLZ4(),
		)
	}
	return sw.w.Write(rec)
}

// Close flushes and closes the IPC stream and underlying file.
func (sw *StreamWriter) Close() error {
	var errs []error
	if sw.w != nil {
		if err := sw.w.Close(); err != nil {
			errs = append(errs, err)
		}
	}
	if sw.f != nil {
		if err := sw.f.Close(); err != nil {
			errs = append(errs, err)
		}
	}
	if len(errs) > 0 {
		return errs[0]
	}
	return nil
}

// OpenReader opens a streaming IPC reader for the given query.
// Checks persistent dir first (pinned), then volatile spool.
func (s *Spool) OpenReader(queryID string) (*ipc.Reader, io.Closer, error) {
	// Check persistent dir first
	if s.PersistentDir != "" {
		path := filepath.Join(s.PersistentDir, filepath.Base(queryID)+".arrow")
		if f, err := os.Open(path); err == nil {
			r, err := ipc.NewReader(f)
			if err != nil {
				f.Close()
			} else {
				return r, f, nil
			}
		}
	}

	path := s.Path(queryID)
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	r, err := ipc.NewReader(f)
	if err != nil {
		f.Close()
		return nil, nil, err
	}
	return r, f, nil
}

// Path returns the Arrow IPC file path for a given query ID (volatile spool only).
func (s *Spool) Path(queryID string) string {
	return filepath.Join(s.Dir, filepath.Base(queryID)+".arrow")
}

// FindPath returns the path to the spool file, checking persistent dir first.
// Returns empty string if the file doesn't exist in either location.
func (s *Spool) FindPath(queryID string) string {
	if s.PersistentDir != "" {
		p := filepath.Join(s.PersistentDir, filepath.Base(queryID)+".arrow")
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	p := s.Path(queryID)
	if _, err := os.Stat(p); err == nil {
		return p
	}
	return ""
}

// Exists checks if a spool file exists for the given query ID.
func (s *Spool) Exists(queryID string) bool {
	if _, err := os.Stat(s.Path(queryID)); err == nil {
		return true
	}
	if s.PersistentDir != "" {
		path := filepath.Join(s.PersistentDir, filepath.Base(queryID)+".arrow")
		if _, err := os.Stat(path); err == nil {
			return true
		}
	}
	return false
}

// Remove deletes a single spool file by query ID.
func (s *Spool) Remove(queryID string) error {
	return os.Remove(s.Path(queryID))
}

// Pin copies a volatile spool file to the persistent directory.
func (s *Spool) Pin(queryID string) error {
	if s.PersistentDir == "" {
		return fmt.Errorf("no persistent directory configured")
	}
	src := s.Path(queryID)
	dst := filepath.Join(s.PersistentDir, filepath.Base(queryID)+".arrow")

	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("open source: %w", err)
	}
	defer in.Close()

	out, err := os.Create(dst)
	if err != nil {
		return fmt.Errorf("create destination: %w", err)
	}
	defer out.Close()

	if _, err := io.Copy(out, in); err != nil {
		os.Remove(dst)
		return fmt.Errorf("copy: %w", err)
	}
	if err := out.Sync(); err != nil {
		os.Remove(dst)
		return fmt.Errorf("sync: %w", err)
	}
	return nil
}

// Unpin removes a result from the persistent directory.
func (s *Spool) Unpin(queryID string) error {
	if s.PersistentDir == "" {
		return fmt.Errorf("no persistent directory configured")
	}
	path := filepath.Join(s.PersistentDir, filepath.Base(queryID)+".arrow")
	return os.Remove(path)
}

// IsPinned checks if a result is in the persistent directory.
func (s *Spool) IsPinned(queryID string) bool {
	if s.PersistentDir == "" {
		return false
	}
	path := filepath.Join(s.PersistentDir, filepath.Base(queryID)+".arrow")
	_, err := os.Stat(path)
	return err == nil
}

// Cleanup removes files exceeding TTL, then enforces the disk size limit.
func (s *Spool) Cleanup() error {
	entries, err := os.ReadDir(s.Dir)
	if err != nil {
		return fmt.Errorf("read spool dir: %w", err)
	}

	type fileInfo struct {
		path    string
		modTime time.Time
		size    int64
	}

	var files []fileInfo
	now := time.Now()

	// Pass 1: remove expired files, collect remaining
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".arrow") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		path := filepath.Join(s.Dir, entry.Name())

		if now.Sub(info.ModTime()) > s.TTL {
			_ = os.Remove(path) // ignore if already deleted by another kernel
			continue
		}

		files = append(files, fileInfo{path: path, modTime: info.ModTime(), size: info.Size()})
	}

	// Pass 2: enforce size limit by removing oldest files first
	sort.Slice(files, func(i, j int) bool {
		return files[i].modTime.After(files[j].modTime)
	})

	var totalSize int64
	for _, f := range files {
		totalSize += f.size
	}

	for i := len(files) - 1; i >= 0 && totalSize > s.MaxSize; i-- {
		_ = os.Remove(files[i].path) // ignore if already deleted by another kernel
		totalSize -= files[i].size
	}

	return nil
}

// Destroy removes the entire spool directory.
// NOTE: Not called on kernel exit — files survive restart for session recovery.
func (s *Spool) Destroy() error {
	// Don't destroy volatile spool on exit — results survive browser reload
	return nil
}

// helpers

func envInt64(key string, def int64) int64 {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	var n int64
	if _, err := fmt.Sscanf(v, "%d", &n); err == nil && n > 0 {
		return n
	}
	return def
}

func envDuration(key string, def time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err == nil && d > 0 {
		return d
	}
	return def
}

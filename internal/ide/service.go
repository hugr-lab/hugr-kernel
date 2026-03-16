package ide

import (
	"context"
	"log"

	"github.com/hugr-lab/hugr-kernel/internal/connection"
)

// Service is the main IDE layer service providing completion, hover, diagnostics, and explorer.
type Service struct {
	Schema  *SchemaClient
	Cache   *Cache
	ConnMgr *connection.Manager
}

// NewService creates a new IDE service.
func NewService(connMgr *connection.Manager) *Service {
	cache := NewCache()
	return &Service{
		Schema:  NewSchemaClient(cache),
		Cache:   cache,
		ConnMgr: connMgr,
	}
}

// Complete returns completion items for the given code and cursor position.
func (s *Service) Complete(ctx context.Context, code string, cursorPos int) ([]CompletionItem, int, int, error) {
	conn := s.ConnMgr.GetDefault()
	if conn == nil {
		return nil, 0, 0, nil
	}

	cursorCtx := ResolveContext(code, cursorPos)

	items, err := Complete(ctx, s.Schema, conn, cursorCtx)
	if err != nil {
		log.Printf("ide: completion error (graceful): %v", err)
		return nil, cursorPos, cursorPos, nil
	}

	// Calculate cursor_start and cursor_end for the prefix being replaced
	cursorStart := cursorPos - len(cursorCtx.Prefix)
	cursorEnd := cursorPos

	return items, cursorStart, cursorEnd, nil
}

// Hover returns hover documentation for the given code and cursor position.
func (s *Service) Hover(ctx context.Context, code string, cursorPos int) (bool, string, string, error) {
	conn := s.ConnMgr.GetDefault()
	if conn == nil {
		return false, "", "", nil
	}

	cursorCtx := ResolveContext(code, cursorPos)
	found, plain, md, err := HoverInfo(ctx, s.Schema, conn, cursorCtx)
	if err != nil {
		log.Printf("ide: hover error (graceful): %v", err)
		return false, "", "", nil
	}
	return found, plain, md, nil
}

// Validate returns diagnostics for the given GraphQL query.
func (s *Service) Validate(ctx context.Context, code string) []Diagnostic {
	conn := s.ConnMgr.GetDefault()
	if conn == nil {
		return nil
	}
	return Validate(ctx, s.Schema, conn, code)
}

// InvalidateCache clears all cached data (call on connection/auth change).
func (s *Service) InvalidateCache() {
	s.Cache.InvalidateAll()
}

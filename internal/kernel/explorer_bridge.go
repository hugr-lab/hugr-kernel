package kernel

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/hugr-lab/hugr-kernel/internal/ide"
)

// explorerBridge implements ExplorerHandler by delegating to the IDE service.
type explorerBridge struct {
	service *ide.Service
}

func newExplorerBridge(svc *ide.Service) *explorerBridge {
	return &explorerBridge{service: svc}
}

func (b *explorerBridge) HandleConnections(w http.ResponseWriter, r *http.Request) {
	conns := b.service.ListConnections(r.Context())
	writeExplorerJSON(w, map[string]any{"connections": conns})
}

func (b *explorerBridge) HandleLogical(w http.ResponseWriter, r *http.Request) {
	nodes, err := b.service.ListDataSources(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if nodes == nil {
		nodes = []ide.ExplorerNode{}
	}
	writeExplorerJSON(w, map[string]any{"nodes": nodes})
}

func (b *explorerBridge) HandleLogicalChildren(w http.ResponseWriter, r *http.Request) {
	nodeID := r.URL.Query().Get("id")
	search := r.URL.Query().Get("search")
	if nodeID == "" {
		http.Error(w, "missing id parameter", http.StatusBadRequest)
		return
	}
	nodes, err := b.service.ListChildren(r.Context(), nodeID, search)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if nodes == nil {
		nodes = []ide.ExplorerNode{}
	}
	writeExplorerJSON(w, map[string]any{"nodes": nodes})
}

func (b *explorerBridge) HandleSchema(w http.ResponseWriter, r *http.Request) {
	kindFilter := r.URL.Query().Get("kind")
	search := r.URL.Query().Get("search")
	limit := 50
	offset := 0
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	if v := r.URL.Query().Get("offset"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			offset = n
		}
	}

	nodes, total, err := b.service.ListSchemaTypes(r.Context(), kindFilter, search, limit, offset)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if nodes == nil {
		nodes = []ide.ExplorerNode{}
	}
	writeExplorerJSON(w, map[string]any{"nodes": nodes, "total": total})
}

func (b *explorerBridge) HandleSchemaChildren(w http.ResponseWriter, r *http.Request) {
	nodeID := r.URL.Query().Get("id")
	if nodeID == "" {
		http.Error(w, "missing id parameter", http.StatusBadRequest)
		return
	}
	nodes, err := b.service.ListSchemaTypeChildren(r.Context(), nodeID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if nodes == nil {
		nodes = []ide.ExplorerNode{}
	}
	writeExplorerJSON(w, map[string]any{"nodes": nodes})
}

func (b *explorerBridge) HandleDetail(w http.ResponseWriter, r *http.Request) {
	nodeID := r.URL.Query().Get("id")
	if nodeID == "" {
		http.Error(w, "missing id parameter", http.StatusBadRequest)
		return
	}
	detail, err := b.service.GetEntityDetail(r.Context(), nodeID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	writeExplorerJSON(w, detail)
}

func (b *explorerBridge) HandleSearch(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query().Get("q")
	scope := r.URL.Query().Get("scope")
	limit := 20
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}

	nodes, err := b.service.SearchExplorer(r.Context(), query, scope, limit)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if nodes == nil {
		nodes = []ide.ExplorerNode{}
	}
	writeExplorerJSON(w, map[string]any{"results": nodes})
}

func writeExplorerJSON(w http.ResponseWriter, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", corsOrigin())
	json.NewEncoder(w).Encode(data)
}

package kernel

import (
	"context"
	"log"
	"sync"

	"github.com/hugr-lab/hugr-kernel/internal/ide"
)

const commTargetExplorer = "hugr.explorer"

// commRegistry tracks active comm channels.
type commRegistry struct {
	mu    sync.RWMutex
	comms map[string]string // comm_id -> target_name
}

func newCommRegistry() *commRegistry {
	return &commRegistry{
		comms: make(map[string]string),
	}
}

func (cr *commRegistry) register(commID, targetName string) {
	cr.mu.Lock()
	defer cr.mu.Unlock()
	cr.comms[commID] = targetName
}

func (cr *commRegistry) unregister(commID string) {
	cr.mu.Lock()
	defer cr.mu.Unlock()
	delete(cr.comms, commID)
}

func (cr *commRegistry) target(commID string) (string, bool) {
	cr.mu.RLock()
	defer cr.mu.RUnlock()
	t, ok := cr.comms[commID]
	return t, ok
}

// handleCommOpen processes a comm_open message from the frontend.
func (k *Kernel) handleCommOpen(ctx context.Context, msg *Message) {
	commID, _ := msg.Content["comm_id"].(string)
	targetName, _ := msg.Content["target_name"].(string)

	if commID == "" || targetName != commTargetExplorer {
		// Silently ignore unknown targets — don't send comm_close back,
		// as JupyterLab doesn't expect it for comms it didn't register.
		log.Printf("comm_open: ignoring unknown target %q for comm %s", targetName, commID)
		return
	}

	k.commReg.register(commID, targetName)
	log.Printf("comm_open: registered comm %s for target %s", commID, targetName)
	// No echo needed — the frontend already has the comm open.
}

// handleCommMsg processes a comm_msg message from the frontend.
func (k *Kernel) handleCommMsg(ctx context.Context, msg *Message) {
	commID, _ := msg.Content["comm_id"].(string)
	if commID == "" {
		return
	}

	target, ok := k.commReg.target(commID)
	if !ok {
		log.Printf("comm_msg: unknown comm_id %s", commID)
		return
	}

	if target != commTargetExplorer {
		log.Printf("comm_msg: unsupported target %s for comm %s", target, commID)
		return
	}

	data, _ := msg.Content["data"].(map[string]any)
	if data == nil {
		return
	}

	reqType, _ := data["type"].(string)
	requestID, _ := data["request_id"].(string)

	responseData := k.dispatchCommRequest(ctx, reqType, data)
	responseData["type"] = "response"
	responseData["request_type"] = reqType
	if requestID != "" {
		responseData["request_id"] = requestID
	}

	reply := NewMessage(msg, "comm_msg")
	reply.Content = map[string]any{
		"comm_id": commID,
		"data":    responseData,
	}
	if err := k.sendIOPub(reply); err != nil {
		log.Printf("send comm_msg response error: %v", err)
	}
}

// handleCommClose processes a comm_close message from the frontend.
func (k *Kernel) handleCommClose(msg *Message) {
	commID, _ := msg.Content["comm_id"].(string)
	if commID == "" {
		return
	}
	k.commReg.unregister(commID)
	log.Printf("comm_close: unregistered comm %s", commID)
}

// dispatchCommRequest routes a comm request to the appropriate handler and returns the response data.
func (k *Kernel) dispatchCommRequest(ctx context.Context, reqType string, data map[string]any) map[string]any {
	switch reqType {
	case "connections":
		return k.commConnections(ctx)
	case "logical_roots":
		return k.commLogicalRoots(ctx)
	case "modules":
		return k.commModules(ctx)
	case "schema_roots":
		return k.commSchemaRoots(ctx)
	case "logical_children":
		id, _ := data["id"].(string)
		search, _ := data["search"].(string)
		return k.commLogicalChildren(ctx, id, search)
	case "schema_types":
		kind, _ := data["kind"].(string)
		search, _ := data["search"].(string)
		limit := intFromAny(data["limit"], 50)
		offset := intFromAny(data["offset"], 0)
		return k.commSchemaTypes(ctx, kind, search, limit, offset)
	case "schema_children":
		id, _ := data["id"].(string)
		return k.commSchemaChildren(ctx, id)
	case "detail":
		id, _ := data["id"].(string)
		return k.commDetail(ctx, id)
	case "search":
		q, _ := data["q"].(string)
		scope, _ := data["scope"].(string)
		limit := intFromAny(data["limit"], 20)
		return k.commSearch(ctx, q, scope, limit)
	case "add_connection":
		name, _ := data["name"].(string)
		url, _ := data["url"].(string)
		return k.commAddConnection(name, url)
	case "remove_connection":
		name, _ := data["name"].(string)
		return k.commRemoveConnection(name)
	case "set_default":
		name, _ := data["name"].(string)
		return k.commSetDefault(name)
	default:
		return map[string]any{"error": "unknown request type: " + reqType}
	}
}

func (k *Kernel) commConnections(ctx context.Context) map[string]any {
	conns := k.ide.ListConnections(ctx)
	return map[string]any{"connections": conns}
}

func (k *Kernel) commLogicalRoots(ctx context.Context) map[string]any {
	nodes, err := k.ide.ListDataSources(ctx)
	if err != nil {
		return map[string]any{"error": err.Error()}
	}
	if nodes == nil {
		nodes = []ide.ExplorerNode{}
	}
	return map[string]any{"nodes": nodes}
}

func (k *Kernel) commLogicalChildren(ctx context.Context, id, search string) map[string]any {
	if id == "" {
		return map[string]any{"error": "missing id parameter"}
	}
	nodes, err := k.ide.ListChildren(ctx, id, search)
	if err != nil {
		return map[string]any{"error": err.Error()}
	}
	if nodes == nil {
		nodes = []ide.ExplorerNode{}
	}
	return map[string]any{"nodes": nodes}
}

func (k *Kernel) commSchemaTypes(ctx context.Context, kind, search string, limit, offset int) map[string]any {
	nodes, total, err := k.ide.ListSchemaTypes(ctx, kind, search, limit, offset)
	if err != nil {
		return map[string]any{"error": err.Error()}
	}
	if nodes == nil {
		nodes = []ide.ExplorerNode{}
	}
	return map[string]any{"nodes": nodes, "total": total}
}

func (k *Kernel) commSchemaChildren(ctx context.Context, id string) map[string]any {
	if id == "" {
		return map[string]any{"error": "missing id parameter"}
	}
	nodes, err := k.ide.ListSchemaTypeChildren(ctx, id)
	if err != nil {
		return map[string]any{"error": err.Error()}
	}
	if nodes == nil {
		nodes = []ide.ExplorerNode{}
	}
	return map[string]any{"nodes": nodes}
}

func (k *Kernel) commDetail(ctx context.Context, id string) map[string]any {
	if id == "" {
		return map[string]any{"error": "missing id parameter"}
	}
	detail, err := k.ide.GetEntityDetail(ctx, id)
	if err != nil {
		return map[string]any{"error": err.Error()}
	}
	return map[string]any{"detail": detail}
}

func (k *Kernel) commSearch(ctx context.Context, q, scope string, limit int) map[string]any {
	nodes, err := k.ide.SearchExplorer(ctx, q, scope, limit)
	if err != nil {
		return map[string]any{"error": err.Error()}
	}
	if nodes == nil {
		nodes = []ide.ExplorerNode{}
	}
	return map[string]any{"results": nodes}
}

func (k *Kernel) commAddConnection(name, url string) map[string]any {
	if name == "" || url == "" {
		return map[string]any{"error": "name and url are required"}
	}
	k.connManager.Add(name, url)
	k.ide.InvalidateCache()
	return map[string]any{"ok": true}
}

func (k *Kernel) commRemoveConnection(name string) map[string]any {
	if name == "" {
		return map[string]any{"error": "name is required"}
	}
	if err := k.connManager.Remove(name); err != nil {
		return map[string]any{"error": err.Error()}
	}
	k.ide.InvalidateCache()
	return map[string]any{"ok": true}
}

func (k *Kernel) commSetDefault(name string) map[string]any {
	if name == "" {
		return map[string]any{"error": "name is required"}
	}
	if err := k.connManager.SetDefault(name); err != nil {
		return map[string]any{"error": err.Error()}
	}
	return map[string]any{"ok": true}
}

func (k *Kernel) commModules(ctx context.Context) map[string]any {
	nodes, err := k.ide.ListModules(ctx)
	if err != nil {
		return map[string]any{"error": err.Error()}
	}
	if nodes == nil {
		nodes = []ide.ExplorerNode{}
	}
	return map[string]any{"nodes": nodes}
}

func (k *Kernel) commSchemaRoots(ctx context.Context) map[string]any {
	nodes, err := k.ide.SchemaRoots(ctx)
	if err != nil {
		return map[string]any{"error": err.Error()}
	}
	if nodes == nil {
		nodes = []ide.ExplorerNode{}
	}
	return map[string]any{"nodes": nodes}
}

// intFromAny extracts an integer from an any value (handles float64 from JSON).
func intFromAny(v any, defaultVal int) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	default:
		return defaultVal
	}
}

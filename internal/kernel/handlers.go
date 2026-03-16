package kernel

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/hugr-lab/hugr-kernel/internal/connection"
	"github.com/hugr-lab/hugr-kernel/internal/ide"
	"github.com/hugr-lab/hugr-kernel/internal/meta"
	"github.com/hugr-lab/hugr-kernel/internal/result"
)

const (
	KernelVersion = "0.1.0"
)

func (k *Kernel) handleShellMessage(ctx context.Context, msg *Message) {
	k.publishStatus(msg, "busy")
	defer k.publishStatus(msg, "idle")

	switch msg.Header.MsgType {
	case "kernel_info_request":
		k.handleKernelInfoRequest(msg)
	case "execute_request":
		k.handleExecuteRequest(ctx, msg)
	case "is_complete_request":
		k.handleIsCompleteRequest(msg)
	case "complete_request":
		k.handleCompleteRequest(msg)
	case "inspect_request":
		k.handleInspectRequest(msg)
	case "comm_open":
		k.handleCommOpen(ctx, msg)
	case "comm_msg":
		k.handleCommMsg(ctx, msg)
	case "comm_close":
		k.handleCommClose(msg)
	default:
		log.Printf("unhandled shell message type: %s", msg.Header.MsgType)
	}
}

func (k *Kernel) handleKernelInfoRequest(msg *Message) {
	reply := NewMessage(msg, "kernel_info_reply")
	content := map[string]any{
		"protocol_version":       ProtocolVersion,
		"implementation":         "hugr-kernel",
		"implementation_version": KernelVersion,
		"language_info": map[string]any{
			"name":           "graphql",
			"version":        "",
			"mimetype":       "application/graphql",
			"file_extension": ".graphql",
		},
		"banner": fmt.Sprintf("Hugr GraphQL Kernel v%s", KernelVersion),
		"status": "ok",
	}
	if k.arrowServer != nil {
		content["hugr_base_url"] = k.arrowServer.BaseURL()
	}
	reply.Content = content
	if err := k.sendMessage(k.shellSocket, reply); err != nil {
		log.Printf("send kernel_info_reply error: %v", err)
	}
}

func (k *Kernel) handleExecuteRequest(ctx context.Context, msg *Message) {
	code, _ := msg.Content["code"].(string)
	code = strings.TrimSpace(code)

	execCount := k.session.NextExecutionCount()

	// Publish execute_input
	inputMsg := NewMessage(msg, "execute_input")
	inputMsg.Content = map[string]any{
		"code":            code,
		"execution_count": execCount,
	}
	if err := k.sendIOPub( inputMsg); err != nil {
		log.Printf("send execute_input error: %v", err)
	}

	// Empty input
	if code == "" {
		k.sendExecuteOK(msg, execCount)
		return
	}

	// Check for meta commands
	if meta.IsMeta(code) {
		// Detect per-query :use override and :json flag
		parsed := meta.Parse(code)
		var useOverride string
		var jsonMode bool
		for _, cmd := range parsed {
			if cmd.Name == "use" && cmd.Body != "" {
				useOverride = strings.TrimSpace(cmd.Args)
			}
			if cmd.Name == "json" {
				jsonMode = true
			}
		}

		results, graphqlBody, err := k.metaReg.Dispatch(ctx, code)
		if err != nil {
			k.sendExecuteError(msg, execCount, err)
			return
		}

		// Emit display_data for meta command results
		for _, r := range results {
			k.sendDisplayData(msg, r)
		}

		// If there's a GraphQL body after meta commands, execute it
		if graphqlBody != "" {
			k.publishDiagnostics(ctx, msg, graphqlBody)
			k.executeGraphQL(ctx, msg, execCount, graphqlBody, useOverride, jsonMode)
			return
		}

		k.sendExecuteOK(msg, execCount)
		return
	}

	// Publish diagnostics before execution
	k.publishDiagnostics(ctx, msg, code)

	// Plain GraphQL query
	k.executeGraphQL(ctx, msg, execCount, code, "", false)
}

func (k *Kernel) executeGraphQL(ctx context.Context, msg *Message, execCount int, query string, connOverride string, jsonMode bool) {
	var conn *connection.Connection
	if connOverride != "" {
		var err error
		conn, err = k.connManager.Get(connOverride)
		if err != nil {
			k.sendExecuteError(msg, execCount, err)
			return
		}
	} else {
		conn = k.connManager.GetDefault()
	}
	if conn == nil {
		k.sendExecuteError(msg, execCount, fmt.Errorf("no connection configured. Use :connect <name> <url> to add one"))
		return
	}

	// Only inject session variables if the query declares variables (contains '$')
	var vars map[string]any
	if strings.Contains(query, "$") {
		vars = k.session.GetVariables()
	}

	// Execute query
	queryID := uuid.New().String()
	queryStart := time.Now()
	resp, err := conn.Query(ctx, query, vars)
	queryTimeMs := time.Since(queryStart).Milliseconds()
	if err != nil {
		k.sendExecuteError(msg, execCount, fmt.Errorf("query error: %w", err))
		return
	}
	defer resp.Close()

	// JSON mode: marshal the response and send through our custom MIME renderer
	if jsonMode {
		jsonBytes, err := json.Marshal(resp)
		if err != nil {
			k.sendExecuteError(msg, execCount, fmt.Errorf("json marshal error: %w", err))
			return
		}
		var jsonData any
		if err := json.Unmarshal(jsonBytes, &jsonData); err != nil {
			k.sendExecuteError(msg, execCount, fmt.Errorf("json unmarshal error: %w", err))
			return
		}
		prettyBytes, _ := json.MarshalIndent(jsonData, "", "  ")

		metadata := map[string]any{
			"query_time_ms": queryTimeMs,
			"parts": []map[string]any{
				{
					"id":    "json",
					"type":  "json",
					"title": "result",
					"data":  jsonData,
				},
			},
		}

		displayMsg := NewMessage(msg, "display_data")
		displayMsg.Content = map[string]any{
			"data": map[string]any{
				"text/plain":                          string(prettyBytes),
				"application/vnd.hugr.result+json": metadata,
			},
			"metadata":  map[string]any{},
			"transient": map[string]any{},
		}
		if err := k.sendIOPub( displayMsg); err != nil {
			log.Printf("send display_data error: %v", err)
		}
		k.sendExecuteOK(msg, execCount)
		return
	}

	// Process multipart response
	handler := result.NewHandler(k.spool, k.arrowServer)
	metadata, textFallback, err := handler.HandleResponse(resp, queryID, queryTimeMs)
	if err != nil {
		k.sendExecuteError(msg, execCount, fmt.Errorf("result processing error: %w", err))
		return
	}

	if metadata != nil {
		data := map[string]any{
			"text/plain": textFallback,
		}
		if metadata != nil {
			data["application/vnd.hugr.result+json"] = metadata
		}

		displayMsg := NewMessage(msg, "display_data")
		displayMsg.Content = map[string]any{
			"data":      data,
			"metadata":  map[string]any{},
			"transient": map[string]any{},
		}
		if err := k.sendIOPub( displayMsg); err != nil {
			log.Printf("send display_data error: %v", err)
		}
	} else if textFallback != "" {
		displayMsg := NewMessage(msg, "display_data")
		displayMsg.Content = map[string]any{
			"data":      map[string]any{"text/plain": textFallback},
			"metadata":  map[string]any{},
			"transient": map[string]any{},
		}
		if err := k.sendIOPub( displayMsg); err != nil {
			log.Printf("send display_data error: %v", err)
		}
	}

	k.sendExecuteOK(msg, execCount)
}

func (k *Kernel) sendDisplayData(msg *Message, r *meta.CommandResult) {
	if r == nil {
		return
	}
	data := map[string]any{}
	if r.Text != "" {
		data["text/plain"] = r.Text
	}
	if r.JSON != nil {
		data["application/json"] = r.JSON
	}
	if len(data) == 0 {
		return
	}
	displayMsg := NewMessage(msg, "display_data")
	displayMsg.Content = map[string]any{
		"data":      data,
		"metadata":  map[string]any{},
		"transient": map[string]any{},
	}
	if err := k.sendIOPub( displayMsg); err != nil {
		log.Printf("send display_data error: %v", err)
	}
}

func (k *Kernel) sendExecuteOK(msg *Message, execCount int) {
	reply := NewMessage(msg, "execute_reply")
	reply.Content = map[string]any{
		"status":          "ok",
		"execution_count": execCount,
	}
	if err := k.sendMessage(k.shellSocket, reply); err != nil {
		log.Printf("send execute_reply error: %v", err)
	}
}

func (k *Kernel) sendExecuteError(msg *Message, execCount int, execErr error) {
	errMsg := NewMessage(msg, "error")
	errMsg.Content = map[string]any{
		"ename":     "ExecutionError",
		"evalue":    execErr.Error(),
		"traceback": []string{execErr.Error()},
	}
	if err := k.sendIOPub( errMsg); err != nil {
		log.Printf("send error error: %v", err)
	}

	reply := NewMessage(msg, "execute_reply")
	reply.Content = map[string]any{
		"status":          "error",
		"execution_count": execCount,
		"ename":           "ExecutionError",
		"evalue":          execErr.Error(),
		"traceback":       []string{execErr.Error()},
	}
	if err := k.sendMessage(k.shellSocket, reply); err != nil {
		log.Printf("send execute_reply error: %v", err)
	}
}

func (k *Kernel) handleIsCompleteRequest(msg *Message) {
	reply := NewMessage(msg, "is_complete_reply")
	reply.Content = map[string]any{
		"status": "complete",
	}
	if err := k.sendMessage(k.shellSocket, reply); err != nil {
		log.Printf("send is_complete_reply error: %v", err)
	}
}

func (k *Kernel) handleCompleteRequest(msg *Message) {
	code, _ := msg.Content["code"].(string)
	cursorPos := 0
	if v, ok := msg.Content["cursor_pos"].(float64); ok {
		cursorPos = int(v)
	}

	ctx := context.Background()
	items, cursorStart, cursorEnd, err := k.ide.Complete(ctx, code, cursorPos)
	if err != nil {
		log.Printf("completion error: %v", err)
	}

	var matches []string
	var richItems []any
	for _, item := range items {
		matches = append(matches, item.Label)
		richItems = append(richItems, map[string]any{
			"label":         item.Label,
			"kind":          item.Kind,
			"detail":        item.Detail,
			"documentation": item.Documentation,
			"insertText":    item.InsertText,
		})
	}
	if matches == nil {
		matches = []string{}
	}

	metadata := map[string]any{}
	if len(richItems) > 0 {
		metadata["_hugr_completions"] = richItems
	}

	reply := NewMessage(msg, "complete_reply")
	reply.Content = map[string]any{
		"status":       "ok",
		"matches":      matches,
		"cursor_start": cursorStart,
		"cursor_end":   cursorEnd,
		"metadata":     metadata,
	}
	if err := k.sendMessage(k.shellSocket, reply); err != nil {
		log.Printf("send complete_reply error: %v", err)
	}
}

func (k *Kernel) handleInspectRequest(msg *Message) {
	code, _ := msg.Content["code"].(string)
	cursorPos := 0
	if v, ok := msg.Content["cursor_pos"].(float64); ok {
		cursorPos = int(v)
	}

	ctx := context.Background()
	found, plain, markdown, err := k.ide.Hover(ctx, code, cursorPos)
	if err != nil {
		log.Printf("inspect error: %v", err)
	}

	data := map[string]any{}
	if found {
		data["text/plain"] = plain
		data["text/markdown"] = markdown
	}

	reply := NewMessage(msg, "inspect_reply")
	reply.Content = map[string]any{
		"status":   "ok",
		"found":    found,
		"data":     data,
		"metadata": map[string]any{},
	}
	if err := k.sendMessage(k.shellSocket, reply); err != nil {
		log.Printf("send inspect_reply error: %v", err)
	}
}

func (k *Kernel) publishDiagnostics(ctx context.Context, msg *Message, code string) {
	diagnostics := k.ide.Validate(ctx, code)
	if diagnostics == nil {
		diagnostics = []ide.Diagnostic{}
	}

	diagItems := make([]any, len(diagnostics))
	for i, d := range diagnostics {
		diagItems[i] = map[string]any{
			"severity":    d.Severity,
			"message":     d.Message,
			"startLine":   d.StartLine,
			"startColumn": d.StartColumn,
			"endLine":     d.EndLine,
			"endColumn":   d.EndColumn,
			"code":        d.Code,
		}
	}

	displayMsg := NewMessage(msg, "display_data")
	displayMsg.Content = map[string]any{
		"data": map[string]any{
			"application/vnd.hugr.diagnostics+json": map[string]any{
				"diagnostics": diagItems,
			},
		},
		"metadata":  map[string]any{},
		"transient": map[string]any{},
	}
	if err := k.sendIOPub(displayMsg); err != nil {
		log.Printf("send diagnostics error: %v", err)
	}
}

func (k *Kernel) handleShutdownRequest(msg *Message) {
	restart, _ := msg.Content["restart"].(bool)

	reply := NewMessage(msg, "shutdown_reply")
	reply.Content = map[string]any{
		"status":  "ok",
		"restart": restart,
	}
	if err := k.sendMessage(k.controlSocket, reply); err != nil {
		log.Printf("send shutdown_reply error: %v", err)
	}

	k.cancel()
}


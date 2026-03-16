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
	"github.com/hugr-lab/hugr-kernel/internal/meta"
	"github.com/hugr-lab/hugr-kernel/internal/renderer"
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
	if err := k.sendMessage(k.iopubSocket, inputMsg); err != nil {
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
			k.executeGraphQL(ctx, msg, execCount, graphqlBody, useOverride, jsonMode)
			return
		}

		k.sendExecuteOK(msg, execCount)
		return
	}

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
		var jsonData any
		jsonBytes, err := json.MarshalIndent(resp, "", "  ")
		if err != nil {
			k.sendExecuteError(msg, execCount, fmt.Errorf("json marshal error: %w", err))
			return
		}
		json.Unmarshal(jsonBytes, &jsonData)

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
				"text/plain":                          string(jsonBytes),
				"application/vnd.hugr.result+json": metadata,
			},
			"metadata":  map[string]any{},
			"transient": map[string]any{},
		}
		if err := k.sendMessage(k.iopubSocket, displayMsg); err != nil {
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
		metaJSON, _ := json.Marshal(metadata)
		log.Printf("viewer metadata JSON: %s", string(metaJSON))

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
		if err := k.sendMessage(k.iopubSocket, displayMsg); err != nil {
			log.Printf("send display_data error: %v", err)
		}
	} else if textFallback != "" {
		displayMsg := NewMessage(msg, "display_data")
		displayMsg.Content = map[string]any{
			"data":      map[string]any{"text/plain": textFallback},
			"metadata":  map[string]any{},
			"transient": map[string]any{},
		}
		if err := k.sendMessage(k.iopubSocket, displayMsg); err != nil {
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
	if err := k.sendMessage(k.iopubSocket, displayMsg); err != nil {
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
	if err := k.sendMessage(k.iopubSocket, errMsg); err != nil {
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
	reply := NewMessage(msg, "complete_reply")
	reply.Content = map[string]any{
		"status":       "ok",
		"matches":      []string{},
		"cursor_start": 0,
		"cursor_end":   0,
		"metadata":     map[string]any{},
	}
	if err := k.sendMessage(k.shellSocket, reply); err != nil {
		log.Printf("send complete_reply error: %v", err)
	}
}

func (k *Kernel) handleInspectRequest(msg *Message) {
	reply := NewMessage(msg, "inspect_reply")
	reply.Content = map[string]any{
		"status":   "ok",
		"found":    false,
		"data":     map[string]any{},
		"metadata": map[string]any{},
	}
	if err := k.sendMessage(k.shellSocket, reply); err != nil {
		log.Printf("send inspect_reply error: %v", err)
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

// SetConnectionOverride allows per-query connection override from :use command.
func (k *Kernel) SetConnectionOverride(name string) {
	// This is used by the :use meta command for per-query overrides
	// The actual implementation connects via the connection manager
}

// renderTextFallback creates a text/plain representation using ASCII table.
func renderTextFallback(columns []string, rows [][]string) string {
	return renderer.RenderTable(columns, rows)
}

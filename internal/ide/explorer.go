package ide

import (
	"context"
	"fmt"
	"strings"

	"github.com/hugr-lab/hugr-kernel/internal/connection"
)

// ListConnections returns connection status for all configured connections.
func (s *Service) ListConnections(ctx context.Context) []ConnectionStatus {
	conns := s.ConnMgr.List()
	defaultName := s.ConnMgr.DefaultName()

	var result []ConnectionStatus
	for _, conn := range conns {
		cs := ConnectionStatus{
			Name:   conn.Name,
			URL:    conn.URL,
			Active: conn.Name == defaultName,
		}
		if cs.Active {
			if v, err := s.Schema.Version(ctx, conn); err == nil {
				cs.Version = v
			}
			if info, err := s.Schema.NodeInfo(ctx, conn); err == nil && info != nil {
				if cm, ok := info["cluster_mode"].(bool); ok {
					cs.ClusterMode = cm
				}
				if nr, ok := info["node_role"].(string); ok {
					cs.NodeRole = nr
				}
			}
		}
		result = append(result, cs)
	}
	return result
}

// ListDataSources returns root-level explorer nodes (data sources).
func (s *Service) ListDataSources(ctx context.Context) ([]ExplorerNode, error) {
	conn := s.ConnMgr.GetDefault()
	if conn == nil {
		return nil, nil
	}

	ds, err := s.Schema.DataSources(ctx, conn)
	if err != nil {
		return nil, err
	}

	var nodes []ExplorerNode
	for _, d := range ds {
		name := getString(d, "name")
		nodes = append(nodes, ExplorerNode{
			ID:          "ds:" + name,
			Label:       name,
			Kind:        NodeDataSource,
			Description: getString(d, "description"),
			HasChildren: true,
			Metadata: map[string]any{
				"type":   getString(d, "type"),
				"prefix": getString(d, "prefix"),
			},
		})
	}
	return nodes, nil
}

// ListModules returns top-level modules (no dot in name).
func (s *Service) ListModules(ctx context.Context) ([]ExplorerNode, error) {
	conn := s.ConnMgr.GetDefault()
	if conn == nil {
		return nil, nil
	}

	modules, err := s.Schema.CatalogModules(ctx, conn, nil)
	if err != nil {
		return nil, err
	}

	var nodes []ExplorerNode
	for _, m := range modules {
		moduleName := getString(m, "name")
		// Top-level modules don't contain dots
		if strings.Contains(moduleName, ".") {
			continue
		}
		nodes = append(nodes, ExplorerNode{
			ID:          "mod:" + moduleName,
			Label:       moduleName,
			Kind:        NodeModule,
			Description: getString(m, "description"),
			HasChildren: true,
		})
	}
	return nodes, nil
}

// ListChildren returns children of a given explorer node.
func (s *Service) ListChildren(ctx context.Context, nodeID string, search string) ([]ExplorerNode, error) {
	conn := s.ConnMgr.GetDefault()
	if conn == nil {
		return nil, nil
	}

	parts := strings.SplitN(nodeID, ":", 2)
	if len(parts) != 2 {
		return nil, fmt.Errorf("invalid node ID: %s", nodeID)
	}

	kind, name := parts[0], parts[1]

	switch kind {
	case "mod":
		return s.listModuleContents(ctx, conn, name, search)
	default:
		return nil, nil
	}
}

func (s *Service) listModuleContents(ctx context.Context, conn *connection.Connection, moduleName, search string) ([]ExplorerNode, error) {
	var nodes []ExplorerNode

	// Get submodules
	allModules, err := s.Schema.CatalogModules(ctx, conn, nil)
	if err != nil {
		return nil, err
	}
	prefix := moduleName + "."
	for _, m := range allModules {
		name := getString(m, "name")
		if !strings.HasPrefix(name, prefix) {
			continue
		}
		// Only direct children (one level deeper)
		remainder := name[len(prefix):]
		if strings.Contains(remainder, ".") {
			continue
		}
		if search != "" && !hasPrefix(remainder, search) {
			continue
		}
		nodes = append(nodes, ExplorerNode{
			ID:          "mod:" + name,
			Label:       remainder,
			Kind:        NodeModule,
			Description: getString(m, "description"),
			HasChildren: true,
		})
	}

	// Get types (tables, views, functions) in this module
	types, err := s.Schema.CatalogTypes(ctx, conn, map[string]any{
		"module": map[string]any{"eq": moduleName},
	}, 100)
	if err != nil {
		return nil, err
	}

	for _, t := range types {
		name := getString(t, "name")
		hugrType := getString(t, "hugr_type")
		if search != "" && !hasPrefix(name, search) {
			continue
		}

		nodeKind := NodeTable
		switch hugrType {
		case "view":
			nodeKind = NodeView
		case "function", "mutation_function":
			nodeKind = NodeFunction
		}

		nodes = append(nodes, ExplorerNode{
			ID:          fmt.Sprintf("%s:%s", strings.ToLower(string(nodeKind)[:3]), name),
			Label:       name,
			Kind:        nodeKind,
			Description: getString(t, "description"),
			HasChildren: false,
			Metadata: map[string]any{
				"hugrType": hugrType,
				"catalog":  getString(t, "catalog"),
			},
		})
	}

	return nodes, nil
}

// SchemaRoots returns root operation types for the schema tree.
func (s *Service) SchemaRoots(ctx context.Context) ([]ExplorerNode, error) {
	conn := s.ConnMgr.GetDefault()
	if conn == nil {
		return nil, nil
	}

	roots, err := s.Schema.SchemaRoots(ctx, conn)
	if err != nil {
		return nil, err
	}

	var nodes []ExplorerNode
	for _, r := range roots {
		name := getString(r, "name")
		label := getString(r, "label")
		nodes = append(nodes, ExplorerNode{
			ID:          "type:" + name,
			Label:       label,
			Kind:        NodeType,
			Description: name,
			HasChildren: true,
			Metadata: map[string]any{
				"graphqlKind": "OBJECT",
				"rootType":    true,
			},
		})
	}
	return nodes, nil
}

// ListSchemaTypes returns GraphQL schema types for the schema explorer.
func (s *Service) ListSchemaTypes(ctx context.Context, kindFilter, search string, limit, offset int) ([]ExplorerNode, int, error) {
	conn := s.ConnMgr.GetDefault()
	if conn == nil {
		return nil, 0, nil
	}

	types, total, err := s.Schema.SchemaTypes(ctx, conn, strings.ToUpper(kindFilter), search, limit, offset)
	if err != nil {
		return nil, 0, err
	}

	var nodes []ExplorerNode
	for _, t := range types {
		nodes = append(nodes, ExplorerNode{
			ID:          "type:" + getString(t, "name"),
			Label:       getString(t, "name"),
			Kind:        NodeType,
			Description: getString(t, "description"),
			HasChildren: true,
			Metadata: map[string]any{
				"graphqlKind": getString(t, "kind"),
			},
		})
	}
	return nodes, total, nil
}

// ListSchemaTypeChildren returns fields/enum values of a schema type.
// Fields that return object types have hasChildren=true with returnTypeName in metadata.
func (s *Service) ListSchemaTypeChildren(ctx context.Context, nodeID string) ([]ExplorerNode, error) {
	conn := s.ConnMgr.GetDefault()
	if conn == nil {
		return nil, nil
	}

	typeName := strings.TrimPrefix(nodeID, "type:")
	typeInfo, err := s.Schema.TypeInfo(ctx, conn, typeName)
	if err != nil || typeInfo == nil {
		return nil, err
	}

	var nodes []ExplorerNode

	// Fields
	if fields, ok := typeInfo["fields"].([]any); ok {
		for _, f := range fields {
			fm, ok := f.(map[string]any)
			if !ok {
				continue
			}
			name := getString(fm, "name")
			typeStr := formatTypeRef(fm["type"])
			baseName, baseKind := unwrapType(fm["type"])
			expandable := baseKind == "OBJECT" || baseKind == "INTERFACE" || baseKind == "UNION"

			nodes = append(nodes, ExplorerNode{
				ID:          fmt.Sprintf("field:%s.%s", typeName, name),
				Label:       name,
				Kind:        NodeField,
				Description: typeStr,
				HasChildren: expandable,
				Metadata: map[string]any{
					"type":           typeStr,
					"returnTypeName": baseName,
				},
			})
		}
	}

	// Input fields
	if inputFields, ok := typeInfo["inputFields"].([]any); ok {
		for _, f := range inputFields {
			fm, ok := f.(map[string]any)
			if !ok {
				continue
			}
			name := getString(fm, "name")
			typeStr := formatTypeRef(fm["type"])
			nodes = append(nodes, ExplorerNode{
				ID:          fmt.Sprintf("field:%s.%s", typeName, name),
				Label:       name,
				Kind:        NodeField,
				Description: typeStr,
				HasChildren: false,
			})
		}
	}

	// Enum values
	if enumValues, ok := typeInfo["enumValues"].([]any); ok {
		for _, ev := range enumValues {
			evm, ok := ev.(map[string]any)
			if !ok {
				continue
			}
			name := getString(evm, "name")
			nodes = append(nodes, ExplorerNode{
				ID:          fmt.Sprintf("enum:%s.%s", typeName, name),
				Label:       name,
				Kind:        NodeEnumValue,
				Description: getString(evm, "description"),
			})
		}
	}

	return nodes, nil
}

// SearchExplorer searches across explorer entities.
func (s *Service) SearchExplorer(ctx context.Context, query, scope string, limit int) ([]ExplorerNode, error) {
	conn := s.ConnMgr.GetDefault()
	if conn == nil {
		return nil, nil
	}

	if limit <= 0 {
		limit = 20
	}

	switch scope {
	case "schema":
		types, _, err := s.Schema.SchemaTypes(ctx, conn, "", query, limit, 0)
		if err != nil {
			return nil, err
		}
		var nodes []ExplorerNode
		for _, t := range types {
			nodes = append(nodes, ExplorerNode{
				ID:          "type:" + getString(t, "name"),
				Label:       getString(t, "name"),
				Kind:        NodeType,
				Description: getString(t, "description"),
			})
		}
		return nodes, nil

	default: // "logical"
		filter := map[string]any{}
		if query != "" {
			filter["name"] = map[string]any{"like": query + "%"}
		}
		types, err := s.Schema.CatalogTypes(ctx, conn, filter, limit)
		if err != nil {
			return nil, err
		}
		var nodes []ExplorerNode
		for _, t := range types {
			hugrType := getString(t, "hugr_type")
			nodeKind := NodeTable
			switch hugrType {
			case "view":
				nodeKind = NodeView
			case "function", "mutation_function":
				nodeKind = NodeFunction
			}
			nodes = append(nodes, ExplorerNode{
				ID:          fmt.Sprintf("%s:%s", strings.ToLower(string(nodeKind)[:3]), getString(t, "name")),
				Label:       getString(t, "name"),
				Kind:        nodeKind,
				Description: getString(t, "description"),
				Metadata: map[string]any{
					"module": getString(t, "module"),
				},
			})
		}
		return nodes, nil
	}
}

// unwrapType extracts the base type name and kind from a GraphQL type reference,
// stripping NonNull and List wrappers.
func unwrapType(typeRef any) (name string, kind string) {
	m, ok := typeRef.(map[string]any)
	if !ok {
		return "", ""
	}
	if n := getString(m, "name"); n != "" {
		return n, getString(m, "kind")
	}
	return unwrapType(m["ofType"])
}

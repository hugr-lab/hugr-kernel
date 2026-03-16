package ide

import (
	"context"
	"encoding/json"
	"fmt"
	"log"

	"github.com/hugr-lab/hugr-kernel/internal/connection"
)

// SchemaClient provides lazy schema projection queries against a Hugr endpoint.
type SchemaClient struct {
	cache *Cache
}

// NewSchemaClient creates a new schema client with caching.
func NewSchemaClient(cache *Cache) *SchemaClient {
	return &SchemaClient{cache: cache}
}

// queryResult executes a GraphQL query and returns the parsed JSON data.
func (s *SchemaClient) queryResult(ctx context.Context, conn *connection.Connection, query string, vars map[string]any) (map[string]any, error) {
	// Check cache
	if cached := s.cache.Get(conn.Name, query, vars); cached != nil {
		if m, ok := cached.(map[string]any); ok {
			return m, nil
		}
	}

	resp, err := conn.Query(ctx, query, vars)
	if err != nil {
		return nil, fmt.Errorf("schema query: %w", err)
	}
	defer resp.Close()

	// Marshal and unmarshal to get plain map[string]any
	raw, err := json.Marshal(resp)
	if err != nil {
		return nil, fmt.Errorf("marshal response: %w", err)
	}
	var result struct {
		Data   map[string]any `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, fmt.Errorf("unmarshal response: %w", err)
	}
	if len(result.Errors) > 0 {
		return nil, fmt.Errorf("graphql error: %s", result.Errors[0].Message)
	}

	if result.Data != nil {
		s.cache.Set(conn.Name, query, vars, result.Data)
	}
	return result.Data, nil
}

// FieldsForType returns field completions for a given parent type.
func (s *SchemaClient) FieldsForType(ctx context.Context, conn *connection.Connection, typeName string, prefix string, limit int) ([]CompletionItem, error) {
	query := `query($filter: core_catalog_fields_filter, $limit: Int) {
		core { catalog { fields(filter: $filter, limit: $limit) {
			name description field_type field_type_name hugr_type is_pk ordinal
		} } }
	}`
	filter := map[string]any{"type_name": map[string]any{"eq": typeName}}
	if prefix != "" {
		filter["name"] = map[string]any{"like": prefix + "%"}
	}
	vars := map[string]any{"filter": filter, "limit": limit}

	data, err := s.queryResult(ctx, conn, query, vars)
	if err != nil {
		return nil, err
	}

	fields := extractPath(data, "core", "catalog", "fields")
	items, _ := fields.([]any)
	var result []CompletionItem
	for _, f := range items {
		fm, ok := f.(map[string]any)
		if !ok {
			continue
		}
		result = append(result, CompletionItem{
			Label:         getString(fm, "name"),
			Kind:          CompletionField,
			Detail:        getString(fm, "field_type"),
			Documentation: getString(fm, "description"),
			InsertText:    getString(fm, "name"),
		})
	}
	return result, nil
}

// ArgumentsForField returns argument completions for a given type+field.
func (s *SchemaClient) ArgumentsForField(ctx context.Context, conn *connection.Connection, typeName, fieldName string) ([]CompletionItem, error) {
	query := `query($filter: core_catalog_arguments_filter) {
		core { catalog { arguments(filter: $filter) {
			name description arg_type arg_type_name is_non_null default_value
		} } }
	}`
	vars := map[string]any{
		"filter": map[string]any{
			"type_name":  map[string]any{"eq": typeName},
			"field_name": map[string]any{"eq": fieldName},
		},
	}

	data, err := s.queryResult(ctx, conn, query, vars)
	if err != nil {
		return nil, err
	}

	args := extractPath(data, "core", "catalog", "arguments")
	items, _ := args.([]any)
	var result []CompletionItem
	for _, a := range items {
		am, ok := a.(map[string]any)
		if !ok {
			continue
		}
		detail := getString(am, "arg_type")
		if getBool(am, "is_non_null") {
			detail += " (required)"
		}
		if dv := getString(am, "default_value"); dv != "" {
			detail += " = " + dv
		}
		result = append(result, CompletionItem{
			Label:         getString(am, "name"),
			Kind:          CompletionArgument,
			Detail:        detail,
			Documentation: getString(am, "description"),
			InsertText:    getString(am, "name") + ": ",
		})
	}
	return result, nil
}

// DirectivesForLocation returns directive completions via introspection.
func (s *SchemaClient) DirectivesForLocation(ctx context.Context, conn *connection.Connection, prefix string) ([]CompletionItem, error) {
	query := `{ __schema { directives { name description locations args { name type { name } } isRepeatable } } }`
	data, err := s.queryResult(ctx, conn, query, nil)
	if err != nil {
		return nil, err
	}

	directives := extractPath(data, "__schema", "directives")
	items, _ := directives.([]any)
	var result []CompletionItem
	for _, d := range items {
		dm, ok := d.(map[string]any)
		if !ok {
			continue
		}
		name := getString(dm, "name")
		if prefix != "" && len(name) >= len(prefix) && name[:len(prefix)] != prefix {
			continue
		}
		result = append(result, CompletionItem{
			Label:         name,
			Kind:          CompletionDirective,
			Detail:        "directive",
			Documentation: getString(dm, "description"),
			InsertText:    "@" + name,
		})
	}
	return result, nil
}

// TypeInfo fetches a single type by name via introspection.
func (s *SchemaClient) TypeInfo(ctx context.Context, conn *connection.Connection, typeName string) (map[string]any, error) {
	query := `query($name: String!) {
		__type(name: $name) {
			name kind description
			fields { name description type { name kind ofType { name kind ofType { name } } }
				args { name description type { name kind ofType { name } } defaultValue }
				isDeprecated deprecationReason }
			inputFields { name description type { name kind ofType { name } } defaultValue }
			enumValues { name description isDeprecated deprecationReason }
		}
	}`
	data, err := s.queryResult(ctx, conn, query, map[string]any{"name": typeName})
	if err != nil {
		return nil, err
	}
	typeData := extractPath(data, "__type")
	if m, ok := typeData.(map[string]any); ok {
		return m, nil
	}
	return nil, nil
}

// Version queries the Hugr node version.
func (s *SchemaClient) Version(ctx context.Context, conn *connection.Connection) (string, error) {
	query := `{ function { core { version { version } } } }`
	data, err := s.queryResult(ctx, conn, query, nil)
	if err != nil {
		log.Printf("ide: version query failed: %v", err)
		return "", err
	}
	version := extractPath(data, "function", "core", "version", "version")
	if v, ok := version.(string); ok {
		return v, nil
	}
	return "", nil
}

// NodeInfo queries full node info.
func (s *SchemaClient) NodeInfo(ctx context.Context, conn *connection.Connection) (map[string]any, error) {
	query := `{ function { core { info { version build_date cluster_mode node_role node_name } } } }`
	data, err := s.queryResult(ctx, conn, query, nil)
	if err != nil {
		return nil, err
	}
	info := extractPath(data, "function", "core", "info")
	if m, ok := info.(map[string]any); ok {
		return m, nil
	}
	return nil, nil
}

// DataSources queries available data sources.
func (s *SchemaClient) DataSources(ctx context.Context, conn *connection.Connection) ([]map[string]any, error) {
	query := `{ core { data_sources { name type description prefix } } }`
	data, err := s.queryResult(ctx, conn, query, nil)
	if err != nil {
		return nil, err
	}
	ds := extractPath(data, "core", "data_sources")
	items, _ := ds.([]any)
	var result []map[string]any
	for _, item := range items {
		if m, ok := item.(map[string]any); ok {
			result = append(result, m)
		}
	}
	return result, nil
}

// CatalogModules queries catalog modules.
func (s *SchemaClient) CatalogModules(ctx context.Context, conn *connection.Connection, filter map[string]any) ([]map[string]any, error) {
	query := `query($filter: core_catalog_modules_filter) {
		core { catalog { modules(filter: $filter) {
			name description query_root mutation_root function_root mut_function_root
		} } }
	}`
	vars := map[string]any{"filter": filter}
	data, err := s.queryResult(ctx, conn, query, vars)
	if err != nil {
		return nil, err
	}
	mods := extractPath(data, "core", "catalog", "modules")
	items, _ := mods.([]any)
	var result []map[string]any
	for _, item := range items {
		if m, ok := item.(map[string]any); ok {
			result = append(result, m)
		}
	}
	return result, nil
}

// CatalogTypes queries catalog types (tables, views, etc).
func (s *SchemaClient) CatalogTypes(ctx context.Context, conn *connection.Connection, filter map[string]any, limit int) ([]map[string]any, error) {
	query := `query($filter: core_catalog_types_filter, $limit: Int) {
		core { catalog { types(filter: $filter, limit: $limit) {
			name kind description hugr_type module catalog
		} } }
	}`
	vars := map[string]any{"filter": filter, "limit": limit}
	data, err := s.queryResult(ctx, conn, query, vars)
	if err != nil {
		return nil, err
	}
	types := extractPath(data, "core", "catalog", "types")
	items, _ := types.([]any)
	var result []map[string]any
	for _, item := range items {
		if m, ok := item.(map[string]any); ok {
			result = append(result, m)
		}
	}
	return result, nil
}

// CatalogFields queries catalog fields for a type.
func (s *SchemaClient) CatalogFields(ctx context.Context, conn *connection.Connection, filter map[string]any, limit int) ([]map[string]any, error) {
	query := `query($filter: core_catalog_fields_filter, $limit: Int) {
		core { catalog { fields(filter: $filter, limit: $limit) {
			type_name name description field_type field_type_name hugr_type catalog is_pk ordinal
		} } }
	}`
	vars := map[string]any{"filter": filter, "limit": limit}
	data, err := s.queryResult(ctx, conn, query, vars)
	if err != nil {
		return nil, err
	}
	fields := extractPath(data, "core", "catalog", "fields")
	items, _ := fields.([]any)
	var result []map[string]any
	for _, item := range items {
		if m, ok := item.(map[string]any); ok {
			result = append(result, m)
		}
	}
	return result, nil
}

// SchemaTypes queries all types via introspection grouped for schema explorer.
func (s *SchemaClient) SchemaTypes(ctx context.Context, conn *connection.Connection, kindFilter, prefix string, limit, offset int) ([]map[string]any, int, error) {
	query := `{ __schema { types { name kind description } } }`
	data, err := s.queryResult(ctx, conn, query, nil)
	if err != nil {
		return nil, 0, err
	}

	types := extractPath(data, "__schema", "types")
	items, _ := types.([]any)

	var filtered []map[string]any
	for _, t := range items {
		tm, ok := t.(map[string]any)
		if !ok {
			continue
		}
		name := getString(tm, "name")
		// Skip internal types
		if len(name) > 0 && name[0] == '_' {
			continue
		}
		if kindFilter != "" && getString(tm, "kind") != kindFilter {
			continue
		}
		if prefix != "" && !hasPrefix(name, prefix) {
			continue
		}
		filtered = append(filtered, tm)
	}

	total := len(filtered)
	if offset > 0 && offset < len(filtered) {
		filtered = filtered[offset:]
	}
	if limit > 0 && len(filtered) > limit {
		filtered = filtered[:limit]
	}

	return filtered, total, nil
}

// DataObjectQueries queries query paths for a data object type.
func (s *SchemaClient) DataObjectQueries(ctx context.Context, conn *connection.Connection, typeName string) ([]map[string]any, error) {
	query := `query($filter: core_catalog_data_object_queries_filter) {
		core { catalog { data_object_queries(filter: $filter) {
			type_name name query_type
		} } }
	}`
	vars := map[string]any{"filter": map[string]any{"type_name": map[string]any{"eq": typeName}}}
	data, err := s.queryResult(ctx, conn, query, vars)
	if err != nil {
		return nil, err
	}
	queries := extractPath(data, "core", "catalog", "data_object_queries")
	items, _ := queries.([]any)
	var result []map[string]any
	for _, item := range items {
		if m, ok := item.(map[string]any); ok {
			result = append(result, m)
		}
	}
	return result, nil
}

// ModuleIntro queries module intro (operations summary).
func (s *SchemaClient) ModuleIntro(ctx context.Context, conn *connection.Connection, moduleName string) ([]map[string]any, error) {
	query := `query($filter: core_catalog_module_intro_filter) {
		core { catalog { module_intro(filter: $filter) {
			module type_type type_name field_name field_description hugr_type catalog
		} } }
	}`
	vars := map[string]any{"filter": map[string]any{"module": map[string]any{"eq": moduleName}}}
	data, err := s.queryResult(ctx, conn, query, vars)
	if err != nil {
		return nil, err
	}
	intro := extractPath(data, "core", "catalog", "module_intro")
	items, _ := intro.([]any)
	var result []map[string]any
	for _, item := range items {
		if m, ok := item.(map[string]any); ok {
			result = append(result, m)
		}
	}
	return result, nil
}

// Helper: extract nested path from map
func extractPath(data map[string]any, keys ...string) any {
	var current any = data
	for _, key := range keys {
		m, ok := current.(map[string]any)
		if !ok {
			return nil
		}
		current = m[key]
	}
	return current
}

// Helper: get string from map
func getString(m map[string]any, key string) string {
	v, _ := m[key].(string)
	return v
}

// Helper: get bool from map
func getBool(m map[string]any, key string) bool {
	v, _ := m[key].(bool)
	return v
}

// SchemaRoots returns root operation types (Query, Mutation, Subscription).
func (s *SchemaClient) SchemaRoots(ctx context.Context, conn *connection.Connection) ([]map[string]any, error) {
	query := `{ __schema { queryType { name } mutationType { name } subscriptionType { name } } }`
	data, err := s.queryResult(ctx, conn, query, nil)
	if err != nil {
		return nil, err
	}
	schema := extractPath(data, "__schema")
	m, ok := schema.(map[string]any)
	if !ok {
		return nil, nil
	}
	var roots []map[string]any
	for _, key := range []string{"queryType", "mutationType", "subscriptionType"} {
		if t, ok := m[key].(map[string]any); ok && t != nil {
			if name := getString(t, "name"); name != "" {
				label := key[:len(key)-4] // "queryType" -> "query", etc.
				roots = append(roots, map[string]any{"name": name, "label": label})
			}
		}
	}
	return roots, nil
}

// Helper: case-insensitive prefix check
func hasPrefix(s, prefix string) bool {
	if len(s) < len(prefix) {
		return false
	}
	for i := 0; i < len(prefix); i++ {
		a, b := s[i], prefix[i]
		if a >= 'A' && a <= 'Z' {
			a += 32
		}
		if b >= 'A' && b <= 'Z' {
			b += 32
		}
		if a != b {
			return false
		}
	}
	return true
}

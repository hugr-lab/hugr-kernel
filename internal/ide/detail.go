package ide

import (
	"context"
	"fmt"
	"strings"

	"github.com/hugr-lab/hugr-kernel/internal/connection"
)

// GetEntityDetail returns detailed metadata for a given explorer node.
func (s *Service) GetEntityDetail(ctx context.Context, nodeID string) (*EntityDetail, error) {
	conn := s.ConnMgr.GetDefault()
	if conn == nil {
		return nil, fmt.Errorf("no active connection")
	}

	parts := strings.SplitN(nodeID, ":", 2)
	if len(parts) != 2 {
		return nil, fmt.Errorf("invalid node ID: %s", nodeID)
	}

	prefix, name := parts[0], parts[1]

	switch prefix {
	case "ds":
		return s.detailDataSource(ctx, conn, name)
	case "mod":
		return s.detailModule(ctx, conn, name)
	case "tab":
		return s.detailTable(ctx, conn, name)
	case "vie":
		return s.detailView(ctx, conn, name)
	case "fun":
		return s.detailFunction(ctx, conn, name)
	case "type":
		return s.detailGraphQLType(ctx, conn, name)
	case "field":
		return s.detailGraphQLField(ctx, conn, name)
	default:
		return nil, fmt.Errorf("unknown entity kind: %s", prefix)
	}
}

func (s *Service) detailDataSource(ctx context.Context, conn *connection.Connection, name string) (*EntityDetail, error) {
	sources, err := s.Schema.DataSources(ctx, conn)
	if err != nil {
		return nil, err
	}

	var ds map[string]any
	for _, src := range sources {
		if getString(src, "name") == name {
			ds = src
			break
		}
	}
	if ds == nil {
		return nil, fmt.Errorf("data source not found: %s", name)
	}

	detail := &EntityDetail{
		ID:          "ds:" + name,
		Kind:        NodeDataSource,
		Name:        name,
		Description: getString(ds, "description"),
	}

	// Source metadata
	detail.Sections = append(detail.Sections, DetailSection{
		Title:   "Properties",
		Kind:    SectionTable,
		Columns: []string{"Property", "Value"},
		Rows: [][]string{
			{"Type", getString(ds, "type")},
			{"Prefix", getString(ds, "prefix")},
		},
	})

	// List modules belonging to this data source
	modules, err := s.Schema.CatalogModules(ctx, conn, nil)
	if err == nil && len(modules) > 0 {
		var modNames []string
		for _, m := range modules {
			modName := getString(m, "name")
			if !strings.Contains(modName, ".") {
				modNames = append(modNames, modName)
			}
		}
		if len(modNames) > 0 {
			detail.Sections = append(detail.Sections, DetailSection{
				Title: "Modules",
				Kind:  SectionList,
				Items: modNames,
			})
		}
	}

	return detail, nil
}

func (s *Service) detailModule(ctx context.Context, conn *connection.Connection, name string) (*EntityDetail, error) {
	// Get module info
	modules, err := s.Schema.CatalogModules(ctx, conn, map[string]any{
		"name": map[string]any{"eq": name},
	})
	if err != nil {
		return nil, err
	}

	var mod map[string]any
	if len(modules) > 0 {
		mod = modules[0]
	}

	detail := &EntityDetail{
		ID:   "mod:" + name,
		Kind: NodeModule,
		Name: name,
	}
	if mod != nil {
		detail.Description = getString(mod, "description")
	}

	// Module intro — summarizes the operations in this module
	intro, err := s.Schema.ModuleIntro(ctx, conn, name)
	if err == nil && len(intro) > 0 {
		var rows [][]string
		for _, item := range intro {
			rows = append(rows, []string{
				getString(item, "field_name"),
				getString(item, "hugr_type"),
				getString(item, "type_type"),
				getString(item, "field_description"),
			})
		}
		detail.Sections = append(detail.Sections, DetailSection{
			Title:   "Operations",
			Kind:    SectionTable,
			Columns: []string{"Field", "Hugr Type", "Type", "Description"},
			Rows:    rows,
		})
	}

	// List submodules
	allModules, err := s.Schema.CatalogModules(ctx, conn, nil)
	if err == nil {
		prefix := name + "."
		var subMods []string
		for _, m := range allModules {
			mName := getString(m, "name")
			if strings.HasPrefix(mName, prefix) {
				remainder := mName[len(prefix):]
				if !strings.Contains(remainder, ".") {
					subMods = append(subMods, remainder)
				}
			}
		}
		if len(subMods) > 0 {
			detail.Sections = append(detail.Sections, DetailSection{
				Title: "Submodules",
				Kind:  SectionList,
				Items: subMods,
			})
		}
	}

	// List types (tables/views/functions) in this module
	types, err := s.Schema.CatalogTypes(ctx, conn, map[string]any{
		"module": map[string]any{"eq": name},
	}, 100)
	if err == nil && len(types) > 0 {
		var rows [][]string
		for _, t := range types {
			rows = append(rows, []string{
				getString(t, "name"),
				getString(t, "hugr_type"),
				getString(t, "description"),
			})
		}
		detail.Sections = append(detail.Sections, DetailSection{
			Title:   "Types",
			Kind:    SectionTable,
			Columns: []string{"Name", "Hugr Type", "Description"},
			Rows:    rows,
		})
	}

	return detail, nil
}

func (s *Service) detailTable(ctx context.Context, conn *connection.Connection, name string) (*EntityDetail, error) {
	detail := &EntityDetail{
		ID:   "tab:" + name,
		Kind: NodeTable,
		Name: name,
	}

	// Get type info
	types, err := s.Schema.CatalogTypes(ctx, conn, map[string]any{
		"name": map[string]any{"eq": name},
	}, 1)
	if err == nil && len(types) > 0 {
		detail.Description = getString(types[0], "description")
	}

	// Columns (fields)
	fields, err := s.Schema.CatalogFields(ctx, conn, map[string]any{
		"type_name": map[string]any{"eq": name},
	}, 200)
	if err == nil && len(fields) > 0 {
		var rows [][]string
		for _, f := range fields {
			pk := ""
			if getBool(f, "is_pk") {
				pk = "PK"
			}
			rows = append(rows, []string{
				getString(f, "name"),
				getString(f, "field_type"),
				pk,
				getString(f, "description"),
			})
		}
		detail.Sections = append(detail.Sections, DetailSection{
			Title:   "Columns",
			Kind:    SectionTable,
			Columns: []string{"Name", "Type", "PK", "Description"},
			Rows:    rows,
		})
	}

	// Query paths and mutations
	queries, err := s.Schema.DataObjectQueries(ctx, conn, name)
	if err == nil && len(queries) > 0 {
		var queryPaths []string
		var mutations []string
		for _, q := range queries {
			qName := getString(q, "name")
			qType := getString(q, "query_type")
			if qType == "mutation" {
				mutations = append(mutations, qName)
			} else {
				queryPaths = append(queryPaths, qName)
			}
		}
		if len(queryPaths) > 0 {
			detail.Sections = append(detail.Sections, DetailSection{
				Title: "Query Paths",
				Kind:  SectionList,
				Items: queryPaths,
			})
		}
		if len(mutations) > 0 {
			detail.Sections = append(detail.Sections, DetailSection{
				Title: "Mutations",
				Kind:  SectionList,
				Items: mutations,
			})
		}
	}

	return detail, nil
}

func (s *Service) detailView(ctx context.Context, conn *connection.Connection, name string) (*EntityDetail, error) {
	detail := &EntityDetail{
		ID:   "vie:" + name,
		Kind: NodeView,
		Name: name,
	}

	types, err := s.Schema.CatalogTypes(ctx, conn, map[string]any{
		"name": map[string]any{"eq": name},
	}, 1)
	if err == nil && len(types) > 0 {
		detail.Description = getString(types[0], "description")
	}

	// Columns
	fields, err := s.Schema.CatalogFields(ctx, conn, map[string]any{
		"type_name": map[string]any{"eq": name},
	}, 200)
	if err == nil && len(fields) > 0 {
		var rows [][]string
		for _, f := range fields {
			rows = append(rows, []string{
				getString(f, "name"),
				getString(f, "field_type"),
				getString(f, "description"),
			})
		}
		detail.Sections = append(detail.Sections, DetailSection{
			Title:   "Columns",
			Kind:    SectionTable,
			Columns: []string{"Name", "Type", "Description"},
			Rows:    rows,
		})
	}

	// Query paths
	queries, err := s.Schema.DataObjectQueries(ctx, conn, name)
	if err == nil && len(queries) > 0 {
		var paths []string
		for _, q := range queries {
			paths = append(paths, getString(q, "name"))
		}
		if len(paths) > 0 {
			detail.Sections = append(detail.Sections, DetailSection{
				Title: "Query Paths",
				Kind:  SectionList,
				Items: paths,
			})
		}
	}

	return detail, nil
}

func (s *Service) detailFunction(ctx context.Context, conn *connection.Connection, name string) (*EntityDetail, error) {
	detail := &EntityDetail{
		ID:   "fun:" + name,
		Kind: NodeFunction,
		Name: name,
	}

	types, err := s.Schema.CatalogTypes(ctx, conn, map[string]any{
		"name": map[string]any{"eq": name},
	}, 1)
	if err == nil && len(types) > 0 {
		detail.Description = getString(types[0], "description")
	}

	// Function fields (return info)
	fields, err := s.Schema.CatalogFields(ctx, conn, map[string]any{
		"type_name": map[string]any{"eq": name},
	}, 50)
	if err == nil && len(fields) > 0 {
		var rows [][]string
		for _, f := range fields {
			rows = append(rows, []string{
				getString(f, "name"),
				getString(f, "field_type"),
				getString(f, "description"),
			})
		}
		detail.Sections = append(detail.Sections, DetailSection{
			Title:   "Return Fields",
			Kind:    SectionTable,
			Columns: []string{"Name", "Type", "Description"},
			Rows:    rows,
		})
	}

	// Arguments — look up via introspection since catalog arguments need type+field
	typeInfo, err := s.Schema.TypeInfo(ctx, conn, name)
	if err == nil && typeInfo != nil {
		if schemaFields, ok := typeInfo["fields"].([]any); ok {
			for _, sf := range schemaFields {
				sfm, ok := sf.(map[string]any)
				if !ok {
					continue
				}
				if args, ok := sfm["args"].([]any); ok && len(args) > 0 {
					var rows [][]string
					for _, a := range args {
						am, ok := a.(map[string]any)
						if !ok {
							continue
						}
						typeStr := formatTypeRef(am["type"])
						rows = append(rows, []string{
							getString(am, "name"),
							typeStr,
							getString(am, "description"),
						})
					}
					detail.Sections = append(detail.Sections, DetailSection{
						Title:   fmt.Sprintf("Arguments (%s)", getString(sfm, "name")),
						Kind:    SectionTable,
						Columns: []string{"Name", "Type", "Description"},
						Rows:    rows,
					})
				}
			}
		}
	}

	return detail, nil
}

func (s *Service) detailGraphQLType(ctx context.Context, conn *connection.Connection, name string) (*EntityDetail, error) {
	typeInfo, err := s.Schema.TypeInfo(ctx, conn, name)
	if err != nil {
		return nil, err
	}
	if typeInfo == nil {
		return nil, fmt.Errorf("type not found: %s", name)
	}

	detail := &EntityDetail{
		ID:          "type:" + name,
		Kind:        NodeType,
		Name:        name,
		Description: getString(typeInfo, "description"),
	}

	kind := getString(typeInfo, "kind")
	detail.Sections = append(detail.Sections, DetailSection{
		Title:   "Properties",
		Kind:    SectionTable,
		Columns: []string{"Property", "Value"},
		Rows: [][]string{
			{"Kind", kind},
		},
	})

	// Fields
	if fields, ok := typeInfo["fields"].([]any); ok && len(fields) > 0 {
		var rows [][]string
		for _, f := range fields {
			fm, ok := f.(map[string]any)
			if !ok {
				continue
			}
			typeStr := formatTypeRef(fm["type"])
			deprecated := ""
			if getBool(fm, "isDeprecated") {
				deprecated = getString(fm, "deprecationReason")
				if deprecated == "" {
					deprecated = "deprecated"
				}
			}
			rows = append(rows, []string{
				getString(fm, "name"),
				typeStr,
				deprecated,
				getString(fm, "description"),
			})
		}
		detail.Sections = append(detail.Sections, DetailSection{
			Title:   "Fields",
			Kind:    SectionTable,
			Columns: []string{"Name", "Type", "Deprecated", "Description"},
			Rows:    rows,
		})
	}

	// Input fields
	if inputFields, ok := typeInfo["inputFields"].([]any); ok && len(inputFields) > 0 {
		var rows [][]string
		for _, f := range inputFields {
			fm, ok := f.(map[string]any)
			if !ok {
				continue
			}
			typeStr := formatTypeRef(fm["type"])
			rows = append(rows, []string{
				getString(fm, "name"),
				typeStr,
				getString(fm, "defaultValue"),
				getString(fm, "description"),
			})
		}
		detail.Sections = append(detail.Sections, DetailSection{
			Title:   "Input Fields",
			Kind:    SectionTable,
			Columns: []string{"Name", "Type", "Default", "Description"},
			Rows:    rows,
		})
	}

	// Enum values
	if enumValues, ok := typeInfo["enumValues"].([]any); ok && len(enumValues) > 0 {
		var rows [][]string
		for _, ev := range enumValues {
			evm, ok := ev.(map[string]any)
			if !ok {
				continue
			}
			deprecated := ""
			if getBool(evm, "isDeprecated") {
				deprecated = getString(evm, "deprecationReason")
				if deprecated == "" {
					deprecated = "deprecated"
				}
			}
			rows = append(rows, []string{
				getString(evm, "name"),
				deprecated,
				getString(evm, "description"),
			})
		}
		detail.Sections = append(detail.Sections, DetailSection{
			Title:   "Enum Values",
			Kind:    SectionTable,
			Columns: []string{"Value", "Deprecated", "Description"},
			Rows:    rows,
		})
	}

	return detail, nil
}

func (s *Service) detailGraphQLField(ctx context.Context, conn *connection.Connection, fullName string) (*EntityDetail, error) {
	// fullName is "TypeName.fieldName"
	dotIdx := strings.LastIndex(fullName, ".")
	if dotIdx < 0 {
		return nil, fmt.Errorf("invalid field ID: %s", fullName)
	}
	typeName := fullName[:dotIdx]
	fieldName := fullName[dotIdx+1:]

	typeInfo, err := s.Schema.TypeInfo(ctx, conn, typeName)
	if err != nil {
		return nil, err
	}
	if typeInfo == nil {
		return nil, fmt.Errorf("type not found: %s", typeName)
	}

	fields, _ := typeInfo["fields"].([]any)
	var fieldDef map[string]any
	for _, f := range fields {
		fm, ok := f.(map[string]any)
		if !ok {
			continue
		}
		if getString(fm, "name") == fieldName {
			fieldDef = fm
			break
		}
	}
	if fieldDef == nil {
		return nil, fmt.Errorf("field not found: %s.%s", typeName, fieldName)
	}

	typeStr := formatTypeRef(fieldDef["type"])
	detail := &EntityDetail{
		ID:          "field:" + fullName,
		Kind:        NodeField,
		Name:        fieldName,
		Description: getString(fieldDef, "description"),
	}

	props := [][]string{
		{"Parent Type", typeName},
		{"Return Type", typeStr},
	}
	if getBool(fieldDef, "isDeprecated") {
		props = append(props, []string{"Deprecated", getString(fieldDef, "deprecationReason")})
	}
	detail.Sections = append(detail.Sections, DetailSection{
		Title:   "Properties",
		Kind:    SectionTable,
		Columns: []string{"Property", "Value"},
		Rows:    props,
	})

	// Arguments
	if args, ok := fieldDef["args"].([]any); ok && len(args) > 0 {
		var rows [][]string
		for _, a := range args {
			am, ok := a.(map[string]any)
			if !ok {
				continue
			}
			argType := formatTypeRef(am["type"])
			rows = append(rows, []string{
				getString(am, "name"),
				argType,
				getString(am, "defaultValue"),
				getString(am, "description"),
			})
		}
		detail.Sections = append(detail.Sections, DetailSection{
			Title:   "Arguments",
			Kind:    SectionTable,
			Columns: []string{"Name", "Type", "Default", "Description"},
			Rows:    rows,
		})
	}

	return detail, nil
}

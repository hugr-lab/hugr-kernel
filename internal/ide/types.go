package ide

// ContextKind identifies the type of cursor position in a GraphQL document.
type ContextKind int

const (
	ContextUnknown ContextKind = iota
	ContextSelectionSet
	ContextArgument
	ContextArgumentValue
	ContextDirective
	ContextDirectiveArgument
	ContextVariable
	ContextInputObjectField
)

// CursorContext represents the resolved cursor position within a GraphQL document.
type CursorContext struct {
	Kind           ContextKind
	ParentTypeName string   // GraphQL type name of the enclosing scope
	FieldName      string   // Current field name (if inside arguments)
	DirectiveName  string   // Current directive name (if inside directive args)
	Prefix         string   // Text typed so far at cursor position
	Depth          int      // Nesting depth
	Path           []string // Field path from root to cursor
}

// CompletionItemKind identifies the type of completion item.
type CompletionItemKind string

const (
	CompletionField     CompletionItemKind = "Field"
	CompletionArgument  CompletionItemKind = "Argument"
	CompletionDirective CompletionItemKind = "Directive"
	CompletionType      CompletionItemKind = "Type"
	CompletionVariable  CompletionItemKind = "Variable"
	CompletionEnumValue CompletionItemKind = "EnumValue"
)

// CompletionItem is a suggestion returned in complete_reply.
type CompletionItem struct {
	Label         string             `json:"label"`
	Kind          CompletionItemKind `json:"kind"`
	Detail        string             `json:"detail"`
	Documentation string             `json:"documentation"`
	InsertText    string             `json:"insertText"`
	SortPriority  int                `json:"sortPriority,omitempty"`
}

// DiagnosticSeverity represents the severity of a diagnostic.
type DiagnosticSeverity string

const (
	SeverityError   DiagnosticSeverity = "Error"
	SeverityWarning DiagnosticSeverity = "Warning"
	SeverityInfo    DiagnosticSeverity = "Info"
)

// Diagnostic is a validation error tied to a document range.
type Diagnostic struct {
	Severity    DiagnosticSeverity `json:"severity"`
	Message     string             `json:"message"`
	StartLine   int                `json:"startLine"`
	StartColumn int                `json:"startColumn"`
	EndLine     int                `json:"endLine"`
	EndColumn   int                `json:"endColumn"`
	Code        string             `json:"code"`
}

// ExplorerNodeKind identifies the type of explorer tree node.
type ExplorerNodeKind string

const (
	NodeDataSource ExplorerNodeKind = "DataSource"
	NodeModule     ExplorerNodeKind = "Module"
	NodeTable      ExplorerNodeKind = "Table"
	NodeView       ExplorerNodeKind = "View"
	NodeFunction   ExplorerNodeKind = "Function"
	NodeType       ExplorerNodeKind = "Type"
	NodeDirective  ExplorerNodeKind = "Directive"
	NodeField      ExplorerNodeKind = "Field"
	NodeEnumValue  ExplorerNodeKind = "EnumValue"
)

// ExplorerNode is a tree element for logical or schema explorer.
type ExplorerNode struct {
	ID          string           `json:"id"`
	Label       string           `json:"label"`
	Kind        ExplorerNodeKind `json:"kind"`
	Description string           `json:"description"`
	HasChildren bool             `json:"hasChildren"`
	ParentID    string           `json:"parentId,omitempty"`
	Metadata    map[string]any   `json:"metadata,omitempty"`
}

// DetailSectionKind identifies the rendering style of a detail section.
type DetailSectionKind string

const (
	SectionTable DetailSectionKind = "Table"
	SectionList  DetailSectionKind = "List"
	SectionText  DetailSectionKind = "Text"
	SectionCode  DetailSectionKind = "Code"
)

// DetailSection is a section within an entity detail modal.
type DetailSection struct {
	Title   string            `json:"title"`
	Kind    DetailSectionKind `json:"kind"`
	Columns []string          `json:"columns,omitempty"` // For Table kind
	Rows    [][]string        `json:"rows,omitempty"`    // For Table kind
	Items   []string          `json:"items,omitempty"`   // For List kind
	Content string            `json:"content,omitempty"` // For Text/Code kind
}

// EntityDetail is full metadata for detail modal display.
type EntityDetail struct {
	ID              string           `json:"id"`
	Kind            ExplorerNodeKind `json:"kind"`
	Name            string           `json:"name"`
	Description     string           `json:"description"`
	LongDescription string           `json:"longDescription,omitempty"`
	Sections        []DetailSection  `json:"sections"`
}

// ConnectionStatus represents a connection in the explorer header.
type ConnectionStatus struct {
	Name        string `json:"name"`
	URL         string `json:"url"`
	Active      bool   `json:"active"`
	Version     string `json:"version,omitempty"`
	ClusterMode bool   `json:"cluster_mode,omitempty"`
	NodeRole    string `json:"node_role,omitempty"`
}

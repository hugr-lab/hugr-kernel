/**
 * Schema tree section with lazy-loading introspection.
 *
 * Renders a collapsible tree of the GraphQL schema (Query, Mutation,
 * Subscription root types) with on-demand field/arg/enum expansion
 * powered by __type introspection queries that include Hugr extensions
 * (hugr_type, catalog, module).
 *
 * Tasks: T008, T009
 */

import { HugrClient } from '../hugrClient';
import { escapeHtml } from '../utils';
import { kindIcon, hugrTypeIcon, kindColor, hugrTypeColor, HUGR_TYPE_LABELS } from './icons';

// ---------------------------------------------------------------------------
// Node interface
// ---------------------------------------------------------------------------

export interface SchemaTreeNode {
  id: string;
  label: string;
  returnType: string;
  kind: 'root' | 'field' | 'arg' | 'input_field' | 'enum_value';
  typeName?: string;
  typeKind?: string;
  hugrType?: string;
  catalog?: string;
  module?: string;
  description?: string;
  defaultValue?: string;
  expanded: boolean;
  children: SchemaTreeNode[] | null;
  loading: boolean;
  depth: number;
  /** Whether return-type fields have been loaded for a field node. */
  _returnTypeLoaded?: boolean;
}

// ---------------------------------------------------------------------------
// Introspection type wrapper result
// ---------------------------------------------------------------------------

interface UnwrappedType {
  name: string;
  kind: string;
  displayType: string;
}

// ---------------------------------------------------------------------------
// Introspection queries
// ---------------------------------------------------------------------------

const ROOTS_QUERY = `{
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
  }
}`;

function typeQuery(typeName: string): string {
  return `{
  __type(name: ${JSON.stringify(typeName)}) {
    name kind description hugr_type catalog module
    fields {
      name description hugr_type catalog
      type { name kind ofType { name kind ofType { name kind ofType { name kind } } } }
      args {
        name description defaultValue
        type { name kind ofType { name kind ofType { name kind } } }
      }
    }
    inputFields {
      name description defaultValue
      type { name kind ofType { name kind ofType { name kind } } }
    }
    enumValues { name description }
    interfaces { name }
    possibleTypes { name }
  }
}`;
}

// ---------------------------------------------------------------------------
// Helper: unwrap NonNull / List wrappers
// ---------------------------------------------------------------------------

function unwrapType(typeObj: any): UnwrappedType {
  if (!typeObj) {
    return { name: 'Unknown', kind: 'SCALAR', displayType: 'Unknown' };
  }

  // Base case: named type (has a name, no ofType needed)
  if (typeObj.name) {
    return { name: typeObj.name, kind: typeObj.kind, displayType: typeObj.name };
  }

  // Wrapper types
  const inner = unwrapType(typeObj.ofType);

  if (typeObj.kind === 'NON_NULL') {
    return { name: inner.name, kind: inner.kind, displayType: `${inner.displayType}!` };
  }
  if (typeObj.kind === 'LIST') {
    return { name: inner.name, kind: inner.kind, displayType: `[${inner.displayType}]` };
  }

  return inner;
}

// ---------------------------------------------------------------------------
// Unique ID counter
// ---------------------------------------------------------------------------

let _nextId = 0;
function nextId(): string {
  return `stn-${_nextId++}`;
}

// ---------------------------------------------------------------------------
// SchemaTreeSection
// ---------------------------------------------------------------------------

export class SchemaTreeSection {
  private _container: HTMLElement;
  private _onShowDetail: (typeName: string) => void;
  private _client: HugrClient | null = null;
  private _roots: SchemaTreeNode[] = [];
  private _error: string | null = null;
  private _activeTooltips: HTMLElement[] = [];
  private _activeTimers: ReturnType<typeof setTimeout>[] = [];

  constructor(container: HTMLElement, onShowDetail: (typeName: string) => void) {
    this._container = container;
    this._onShowDetail = onShowDetail;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  setClient(client: HugrClient | null): void {
    this._cleanupTooltips();
    this._client = client;
    this._roots = [];
    this._error = null;
    if (client) {
      this.loadRoots();
    } else {
      this._renderTree();
    }
  }

  // -----------------------------------------------------------------------
  // Load root types
  // -----------------------------------------------------------------------

  async loadRoots(): Promise<void> {
    if (!this._client) {
      return;
    }

    this._error = null;
    this._roots = [];
    this._renderLoading();

    try {
      const res = await this._client.query(ROOTS_QUERY);

      if (res.errors && res.errors.length > 0) {
        this._error = res.errors.map(e => e.message).join('; ');
        this._renderTree();
        return;
      }

      const schema = res.data?.__schema;
      if (!schema) {
        this._error = 'No schema data returned';
        this._renderTree();
        return;
      }

      const rootEntries: Array<{ label: string; name: string }> = [];
      if (schema.queryType?.name) {
        rootEntries.push({ label: 'Query', name: schema.queryType.name });
      }
      if (schema.mutationType?.name) {
        rootEntries.push({ label: 'Mutation', name: schema.mutationType.name });
      }
      if (schema.subscriptionType?.name) {
        rootEntries.push({ label: 'Subscription', name: schema.subscriptionType.name });
      }

      this._roots = rootEntries.map(entry => ({
        id: nextId(),
        label: entry.label,
        returnType: '',
        kind: 'root' as const,
        typeName: entry.name,
        typeKind: 'OBJECT',
        expanded: false,
        children: null,
        loading: false,
        depth: 0,
      }));

      this._renderTree();
    } catch (err: any) {
      this._error = err?.message ?? 'Failed to load schema roots';
      this._renderTree();
    }
  }

  // -----------------------------------------------------------------------
  // Expand / collapse a node
  // -----------------------------------------------------------------------

  private async _expandNode(node: SchemaTreeNode): Promise<void> {
    // For field nodes that already have args pre-loaded but haven't yet
    // fetched return-type children, we need to load them lazily.
    if (node.kind === 'field' && node.children !== null && !node._returnTypeLoaded) {
      // First expansion: toggle open, then load return type fields
      if (!node.expanded) {
        node.expanded = true;
        this._renderTree();
        await this._loadReturnTypeFields(node);
        return;
      }
      // Already expanded — just toggle
      node.expanded = false;
      this._renderTree();
      return;
    }

    // Already loaded — just toggle
    if (node.children !== null) {
      node.expanded = !node.expanded;
      this._renderTree();
      return;
    }

    // Need to load children
    if (!this._client || !node.typeName) {
      return;
    }

    node.loading = true;
    node.expanded = true;
    this._renderTree();

    try {
      const res = await this._client.query(typeQuery(node.typeName));

      if (res.errors && res.errors.length > 0) {
        node.children = [];
        node.loading = false;
        this._renderTree();
        return;
      }

      const typeData = res.data?.__type;
      if (!typeData) {
        node.children = [];
        node.loading = false;
        this._renderTree();
        return;
      }

      node.children = this._buildChildren(typeData, node.depth + 1);
      node.loading = false;
      this._renderTree();
    } catch {
      node.children = [];
      node.loading = false;
      this._renderTree();
    }
  }

  /**
   * Load return type's fields for a field node and append them as children.
   * This enables subquery exploration: expanding a field shows both its
   * args and the fields of its return type (if OBJECT/INTERFACE).
   */
  private async _loadReturnTypeFields(node: SchemaTreeNode): Promise<void> {
    if (!this._client || !node.typeName) {
      node._returnTypeLoaded = true;
      return;
    }

    const returnKind = node.typeKind;
    if (returnKind !== 'OBJECT' && returnKind !== 'INTERFACE') {
      node._returnTypeLoaded = true;
      return;
    }

    node.loading = true;
    this._renderTree();

    try {
      const res = await this._client.query(typeQuery(node.typeName));
      const typeData = res.data?.__type;

      if (typeData && (typeData.kind === 'OBJECT' || typeData.kind === 'INTERFACE')) {
        const fieldChildren = this._buildFieldChildren(typeData.fields ?? [], node.depth + 1);
        if (!node.children) {
          node.children = [];
        }
        node.children.push(...fieldChildren);
      }
    } catch {
      // Silently fail — args are still visible
    }

    node._returnTypeLoaded = true;
    node.loading = false;
    this._renderTree();
  }

  // -----------------------------------------------------------------------
  // Build child nodes from introspection result
  // -----------------------------------------------------------------------

  private _buildChildren(typeData: any, depth: number): SchemaTreeNode[] {
    const kind: string = typeData.kind;

    if (kind === 'OBJECT' || kind === 'INTERFACE') {
      return this._buildFieldChildren(typeData.fields ?? [], depth);
    }

    if (kind === 'INPUT_OBJECT') {
      return this._buildInputFieldChildren(typeData.inputFields ?? [], depth);
    }

    if (kind === 'ENUM') {
      return (typeData.enumValues ?? []).map((ev: any) => ({
        id: nextId(),
        label: ev.name,
        returnType: '',
        kind: 'enum_value' as const,
        description: ev.description ?? undefined,
        expanded: false,
        children: null,
        loading: false,
        depth,
      }));
    }

    // SCALAR, UNION, etc. — no children
    return [];
  }

  private _buildFieldChildren(fields: any[], depth: number): SchemaTreeNode[] {
    const nodes: SchemaTreeNode[] = [];

    for (const field of fields) {
      const unwrapped = unwrapType(field.type);
      const fieldNode: SchemaTreeNode = {
        id: nextId(),
        label: field.name,
        returnType: unwrapped.displayType,
        kind: 'field',
        typeName: unwrapped.name,
        typeKind: unwrapped.kind,
        hugrType: field.hugr_type ?? undefined,
        catalog: field.catalog ?? undefined,
        description: field.description ?? undefined,
        expanded: false,
        children: null,
        loading: false,
        depth,
      };

      // If the field has args, pre-create an args group
      const args: any[] = field.args ?? [];
      const hasArgs = args.length > 0;
      const returnTypeExpandable =
        unwrapped.kind === 'OBJECT' || unwrapped.kind === 'INTERFACE';

      if (hasArgs || returnTypeExpandable) {
        if (fieldNode.children === null) {
          fieldNode.children = [];
        }
        if (hasArgs) {
          const argChildren = this._buildArgChildren(args, depth + 2);
          const argsGroup: SchemaTreeNode = {
            id: nextId(),
            label: `args (${args.length})`,
            returnType: '',
            kind: 'arg',
            expanded: false,
            children: argChildren,
            loading: false,
            depth: depth + 1,
          };
          fieldNode.children.push(argsGroup);
        }
        // Mark that return type fields have NOT been loaded yet;
        // they will be fetched lazily when the node is first expanded.
        if (returnTypeExpandable) {
          fieldNode._returnTypeLoaded = false;
        }
      }

      nodes.push(fieldNode);
    }

    return nodes;
  }

  private _buildArgChildren(args: any[], depth: number): SchemaTreeNode[] {
    return args.map((arg: any) => {
      const unwrapped = unwrapType(arg.type);
      const isExpandable =
        unwrapped.kind === 'INPUT_OBJECT' || unwrapped.kind === 'ENUM';

      return {
        id: nextId(),
        label: arg.name,
        returnType: unwrapped.displayType,
        kind: 'arg' as const,
        typeName: unwrapped.name,
        typeKind: unwrapped.kind,
        description: arg.description ?? undefined,
        defaultValue: arg.defaultValue ?? undefined,
        expanded: false,
        children: isExpandable ? null : [],
        loading: false,
        depth,
      };
    });
  }

  private _buildInputFieldChildren(inputFields: any[], depth: number): SchemaTreeNode[] {
    return inputFields.map((field: any) => {
      const unwrapped = unwrapType(field.type);
      const isExpandable =
        unwrapped.kind === 'INPUT_OBJECT' || unwrapped.kind === 'ENUM';

      return {
        id: nextId(),
        label: field.name,
        returnType: unwrapped.displayType,
        kind: 'input_field' as const,
        typeName: unwrapped.name,
        typeKind: unwrapped.kind,
        description: field.description ?? undefined,
        defaultValue: field.defaultValue ?? undefined,
        expanded: false,
        children: isExpandable ? null : [],
        loading: false,
        depth,
      };
    });
  }

  // -----------------------------------------------------------------------
  // Refresh a node
  // -----------------------------------------------------------------------

  private _refreshNode(node: SchemaTreeNode): void {
    node.children = null;
    node.expanded = false;
    node.loading = false;
    node._returnTypeLoaded = undefined;
    this._expandNode(node);
  }

  // -----------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------

  private _renderLoading(): void {
    this._container.innerHTML =
      '<div class="hugr-schema-tree-loading" style="padding:8px;color:var(--jp-ui-font-color2, #888);">' +
      'Loading schema\u2026</div>';
  }

  private _renderTree(): void {
    this._container.innerHTML = '';

    if (this._error) {
      const errDiv = document.createElement('div');
      errDiv.className = 'hugr-schema-tree-error';
      errDiv.style.cssText = 'padding:8px;color:var(--jp-error-color1, #d32f2f);font-size:12px;';
      errDiv.textContent = this._error;
      this._container.appendChild(errDiv);
      return;
    }

    if (this._roots.length === 0 && this._client) {
      const emptyDiv = document.createElement('div');
      emptyDiv.style.cssText = 'padding:8px;color:var(--jp-ui-font-color2, #888);font-size:12px;';
      emptyDiv.textContent = 'No schema loaded';
      this._container.appendChild(emptyDiv);
      return;
    }

    if (!this._client) {
      const noConn = document.createElement('div');
      noConn.style.cssText = 'padding:8px;color:var(--jp-ui-font-color2, #888);font-size:12px;';
      noConn.textContent = 'No connection selected';
      this._container.appendChild(noConn);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const root of this._roots) {
      this._renderNodeRecursive(root, fragment);
    }
    this._container.appendChild(fragment);
  }

  private _renderNodeRecursive(
    node: SchemaTreeNode,
    parent: DocumentFragment | HTMLElement
  ): void {
    const row = this._createNodeRow(node);
    parent.appendChild(row);

    if (node.loading) {
      const loadingRow = document.createElement('div');
      loadingRow.className = 'hugr-schema-tree-row';
      loadingRow.style.cssText =
        `padding:2px 4px 2px ${(node.depth + 1) * 16 + 20}px;` +
        'color:var(--jp-ui-font-color2, #888);font-size:11px;font-style:italic;';
      loadingRow.textContent = 'Loading\u2026';
      parent.appendChild(loadingRow);
    }

    if (node.expanded && node.children) {
      for (const child of node.children) {
        this._renderNodeRecursive(child, parent);
      }
    }
  }

  private _createNodeRow(node: SchemaTreeNode): HTMLElement {
    const row = document.createElement('div');
    row.className = 'hugr-schema-tree-row';
    row.dataset.nodeId = node.id;
    row.style.cssText =
      `display:flex;align-items:center;padding:2px 4px 2px ${node.depth * 16}px;` +
      'cursor:pointer;font-size:12px;line-height:20px;white-space:nowrap;' +
      'border-radius:3px;';

    // Hover effect
    row.addEventListener('mouseenter', () => {
      row.style.backgroundColor = 'var(--jp-layout-color2, #f0f0f0)';
    });
    row.addEventListener('mouseleave', () => {
      row.style.backgroundColor = '';
    });

    // -- Expand arrow --
    const arrow = document.createElement('span');
    arrow.style.cssText =
      'display:inline-flex;align-items:center;justify-content:center;' +
      'width:16px;height:16px;flex-shrink:0;font-size:10px;' +
      'color:var(--jp-ui-font-color2, #888);user-select:none;';

    const isLeaf = this._isLeaf(node);
    if (isLeaf) {
      arrow.innerHTML = '&nbsp;';
    } else {
      arrow.textContent = node.expanded ? '\u25BC' : '\u25B6';
    }
    row.appendChild(arrow);

    // -- Icon --
    const iconSpan = document.createElement('span');
    iconSpan.style.cssText =
      'display:inline-flex;align-items:center;width:18px;height:16px;flex-shrink:0;margin-right:4px;';
    iconSpan.innerHTML = this._getNodeIcon(node);
    row.appendChild(iconSpan);

    // -- Label --
    const labelSpan = document.createElement('span');
    labelSpan.style.cssText = 'flex-shrink:0;color:var(--jp-ui-font-color1, #333);';
    labelSpan.textContent = node.label;
    row.appendChild(labelSpan);

    // -- Return type (with hover tooltip) --
    if (node.returnType) {
      const typeSpan = document.createElement('span');
      typeSpan.className = 'hugr-st-type-ref';
      typeSpan.textContent = node.returnType;
      // Extract base type name (strip [], !)
      const baseTypeName = node.returnType.replace(/[\[\]!]/g, '').trim();
      if (baseTypeName) {
        typeSpan.style.cursor = 'pointer';
        typeSpan.addEventListener('click', (e) => {
          e.stopPropagation();
          this._onShowDetail(baseTypeName);
        });
        this._attachTypeTooltip(typeSpan, baseTypeName);
      }
      row.appendChild(typeSpan);
    }

    // -- Default value (for arg / input_field nodes) --
    if (node.defaultValue !== undefined && node.defaultValue !== null) {
      const defaultSpan = document.createElement('span');
      defaultSpan.style.cssText =
        'margin-left:4px;color:var(--jp-ui-font-color2, #888);font-size:11px;flex-shrink:0;';
      defaultSpan.textContent = `= ${node.defaultValue}`;
      row.appendChild(defaultSpan);
    }

    // -- HugrType badge --
    if (node.hugrType) {
      const badge = document.createElement('span');
      const bgColor = hugrTypeColor(node.hugrType);
      const badgeLabel = HUGR_TYPE_LABELS[node.hugrType] ?? node.hugrType;
      badge.style.cssText =
        `margin-left:6px;padding:0 4px;border-radius:3px;font-size:10px;` +
        `line-height:16px;background:${bgColor}22;color:${bgColor};flex-shrink:0;`;
      badge.textContent = badgeLabel;
      row.appendChild(badge);
    }

    // -- Spacer --
    const spacer = document.createElement('span');
    spacer.style.cssText = 'flex:1 1 auto;min-width:8px;';
    row.appendChild(spacer);

    // -- Info button (for types that have a typeName) --
    if (node.typeName && node.kind !== 'arg') {
      const infoBtn = document.createElement('span');
      infoBtn.className = 'hugr-schema-tree-info';
      infoBtn.style.cssText =
        'display:inline-flex;align-items:center;justify-content:center;' +
        'width:18px;height:18px;flex-shrink:0;cursor:pointer;' +
        'border-radius:3px;font-size:12px;opacity:0.5;' +
        'color:var(--jp-ui-font-color2, #888);';
      infoBtn.textContent = '\u2139';
      infoBtn.title = `Show details for ${escapeHtml(node.typeName)}`;
      infoBtn.addEventListener('mouseenter', () => {
        infoBtn.style.opacity = '1';
        infoBtn.style.backgroundColor = 'var(--jp-layout-color3, #ddd)';
      });
      infoBtn.addEventListener('mouseleave', () => {
        infoBtn.style.opacity = '0.5';
        infoBtn.style.backgroundColor = '';
      });
      infoBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (node.typeName) {
          this._onShowDetail(node.typeName);
        }
      });
      row.appendChild(infoBtn);
    }

    // -- Refresh button (any expandable node) --
    if (!isLeaf) {
      const refreshBtn = document.createElement('span');
      refreshBtn.className = 'hugr-schema-tree-refresh';
      refreshBtn.style.cssText =
        'display:inline-flex;align-items:center;justify-content:center;' +
        'width:18px;height:18px;flex-shrink:0;cursor:pointer;' +
        'border-radius:3px;font-size:12px;opacity:0.5;margin-left:2px;' +
        'color:var(--jp-ui-font-color2, #888);';
      refreshBtn.textContent = '\u21BB';
      refreshBtn.title = 'Refresh';
      refreshBtn.addEventListener('mouseenter', () => {
        refreshBtn.style.opacity = '1';
        refreshBtn.style.backgroundColor = 'var(--jp-layout-color3, #ddd)';
      });
      refreshBtn.addEventListener('mouseleave', () => {
        refreshBtn.style.opacity = '0.5';
        refreshBtn.style.backgroundColor = '';
      });
      refreshBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._refreshNode(node);
      });
      row.appendChild(refreshBtn);
    }

    // -- Row click: expand/collapse --
    if (!isLeaf) {
      row.addEventListener('click', () => {
        this._expandNode(node);
      });
    }

    return row;
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private _isLeaf(node: SchemaTreeNode): boolean {
    // Enum values are always leaves
    if (node.kind === 'enum_value') {
      return true;
    }
    // Field nodes that still need to load return type fields are not leaves
    if (node.kind === 'field' && node._returnTypeLoaded === false) {
      return false;
    }
    // If children is an empty array, it's a leaf (SCALAR or no-children type)
    if (Array.isArray(node.children) && node.children.length === 0) {
      return true;
    }
    // Fields/args pointing to SCALAR with no args children
    if (
      node.typeKind === 'SCALAR' &&
      (node.children === null || node.children.length === 0)
    ) {
      return true;
    }
    return false;
  }

  private _getNodeIcon(node: SchemaTreeNode): string {
    // Use hugrType icon when available
    if (node.hugrType) {
      return hugrTypeIcon(node.hugrType);
    }

    // Root nodes: use kind icon for OBJECT
    if (node.kind === 'root') {
      return kindIcon('OBJECT');
    }

    // Args group node (the "args (N)" node)
    if (node.kind === 'arg' && node.children !== null && node.label.startsWith('args')) {
      return '<span style="font-size:11px;color:var(--jp-ui-font-color2, #888);">()</span>';
    }

    // Use typeKind icon if available
    if (node.typeKind) {
      return kindIcon(node.typeKind);
    }

    // Enum values: use ENUM icon
    if (node.kind === 'enum_value') {
      return kindIcon('ENUM');
    }

    return kindIcon('SCALAR');
  }

  /**
   * Attach a hover tooltip to a type-reference span.
   * Shows kind icon + description on hover, with a "Search" link
   * that navigates to the Types tab.
   */
  private _attachTypeTooltip(el: HTMLElement, typeName: string): void {
    let tooltip: HTMLDivElement | null = null;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;

    const show = () => {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      if (tooltip) return;

      tooltip = document.createElement('div');
      tooltip.className = 'hugr-type-tooltip';
      tooltip.innerHTML = `<span class="hugr-type-tooltip-loading">Loading…</span>`;

      const rect = el.getBoundingClientRect();
      tooltip.style.left = `${rect.left}px`;
      tooltip.style.top = `${rect.bottom + 4}px`;
      document.body.appendChild(tooltip);
      this._activeTooltips.push(tooltip);

      // Prevent tooltip from disappearing when hovering over it
      tooltip.addEventListener('mouseenter', () => {
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      });
      tooltip.addEventListener('mouseleave', () => {
        hide();
      });

      // Fetch type info
      if (this._client) {
        const query = `{ __type(name: ${JSON.stringify(typeName)}) { name kind description } }`;
        this._client.query(query).then((resp) => {
          if (!tooltip) return;
          const t = resp.data?.__type;
          if (t) {
            const icon = kindIcon(t.kind || '');
            const desc = t.description ? escapeHtml(t.description) : '<em>No description</em>';
            tooltip.innerHTML =
              `<div class="hugr-type-tooltip-header">${icon} <strong>${escapeHtml(t.name)}</strong> <span class="hugr-type-tooltip-kind">${escapeHtml(t.kind)}</span></div>` +
              `<div class="hugr-type-tooltip-desc">${desc}</div>` +
              `<div class="hugr-type-tooltip-actions"><a class="hugr-type-tooltip-search" data-search="${escapeHtml(typeName)}">Search in Types</a></div>`;
            const searchLink = tooltip.querySelector('.hugr-type-tooltip-search');
            if (searchLink) {
              searchLink.addEventListener('click', (e) => {
                e.preventDefault();
                hide();
                // Dispatch search event on the explorer root
                el.dispatchEvent(new CustomEvent('hugr-types-search', {
                  bubbles: true,
                  detail: { query: typeName }
                }));
              });
            }
          } else {
            tooltip.innerHTML = `<em>${escapeHtml(typeName)}</em> not found`;
          }
        }).catch(() => {
          if (tooltip) {
            tooltip.innerHTML = `<em>Error loading type info</em>`;
          }
        });
      }
    };

    const hide = () => {
      const timer = setTimeout(() => {
        if (tooltip && tooltip.parentNode) {
          tooltip.parentNode.removeChild(tooltip);
          const idx = this._activeTooltips.indexOf(tooltip);
          if (idx >= 0) this._activeTooltips.splice(idx, 1);
        }
        tooltip = null;
        hideTimer = null;
      }, 200);
      hideTimer = timer;
      this._activeTimers.push(timer);
    };

    el.addEventListener('mouseenter', show);
    el.addEventListener('mouseleave', hide);
  }

  private _cleanupTooltips(): void {
    for (const timer of this._activeTimers) {
      clearTimeout(timer);
    }
    this._activeTimers = [];
    for (const el of this._activeTooltips) {
      if (el.parentNode) {
        el.parentNode.removeChild(el);
      }
    }
    this._activeTooltips = [];
  }
}

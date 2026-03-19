/**
 * Icon path helpers and type mappings for the Hugr Explorer.
 *
 * Returns Uri paths to SVG files in resources/icons/ for use with
 * VS Code TreeItem.iconPath.
 */
import * as vscode from 'vscode';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Icon file mapping: GraphQL kind → SVG filename
// ---------------------------------------------------------------------------

const KIND_ICON_FILES: Record<string, string> = {
  OBJECT: 'kind-object.svg',
  INPUT_OBJECT: 'kind-input.svg',
  ENUM: 'kind-enum.svg',
  SCALAR: 'kind-scalar.svg',
  INTERFACE: 'kind-interface.svg',
  UNION: 'kind-union.svg',
};

// ---------------------------------------------------------------------------
// Icon file mapping: Hugr type → SVG filename
// ---------------------------------------------------------------------------

const HUGR_TYPE_ICON_FILES: Record<string, string> = {
  module: 'hugr-module.svg',
  table: 'hugr-table.svg',
  view: 'hugr-view.svg',
  filter: 'hugr-filter.svg',
  filter_list: 'hugr-filter-list.svg',
  data_input: 'hugr-data-input.svg',
  join_queries: 'hugr-join-queries.svg',
  spatial_queries: 'hugr-spatial-queries.svg',
  h3_data: 'hugr-h3.svg',
  h3_aggregate: 'hugr-h3-aggregate.svg',
  submodule: 'hugr-submodule.svg',
  select: 'hugr-select.svg',
  select_one: 'hugr-select-one.svg',
  aggregate: 'hugr-aggregate.svg',
  bucket_agg: 'hugr-bucket-agg.svg',
  function: 'hugr-function.svg',
  join: 'hugr-join.svg',
  spatial: 'hugr-spatial.svg',
  jq: 'hugr-jq.svg',
  mutation_insert: 'hugr-mutation-insert.svg',
  mutation_update: 'hugr-mutation-update.svg',
  mutation_delete: 'hugr-mutation-delete.svg',
  extra_field: 'hugr-extra-field.svg',
};

// ---------------------------------------------------------------------------
// Kind labels
// ---------------------------------------------------------------------------

export const KIND_LABELS: Record<string, string> = {
  OBJECT: 'OBJ',
  INPUT_OBJECT: 'INPUT',
  ENUM: 'ENUM',
  SCALAR: 'SCALAR',
  INTERFACE: 'IFACE',
  UNION: 'UNION',
};

// ---------------------------------------------------------------------------
// HugrType labels
// ---------------------------------------------------------------------------

export const HUGR_TYPE_LABELS: Record<string, string> = {
  module: 'Module',
  table: 'Table',
  view: 'View',
  filter: 'Filter',
  filter_list: 'Filters',
  data_input: 'Input',
  join_queries: 'Join Q',
  spatial_queries: 'Spatial Q',
  h3_data: 'H3',
  h3_aggregate: 'H3 Agg',
  submodule: 'Sub',
  select: 'Select',
  select_one: 'Sel One',
  aggregate: 'Agg',
  bucket_agg: 'Bucket',
  function: 'Func',
  join: 'Join',
  spatial: 'Spatial',
  jq: 'JQ',
  mutation_insert: 'Insert',
  mutation_update: 'Update',
  mutation_delete: 'Delete',
  extra_field: 'Extra',
};

// ---------------------------------------------------------------------------
// Cached extension URI
// ---------------------------------------------------------------------------

let _extensionUri: vscode.Uri | null = null;

export function setExtensionUri(uri: vscode.Uri): void {
  _extensionUri = uri;
}

function iconUri(filename: string): vscode.Uri {
  if (!_extensionUri) {
    throw new Error('Extension URI not set — call setExtensionUri() first');
  }
  return vscode.Uri.joinPath(_extensionUri, 'resources', 'icons', filename);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the icon path for a GraphQL introspection kind.
 * Used as TreeItem.iconPath.
 */
export function kindIconPath(kind: string): vscode.Uri | vscode.ThemeIcon {
  const file = KIND_ICON_FILES[kind];
  if (file) {
    return iconUri(file);
  }
  return new vscode.ThemeIcon('symbol-misc');
}

/**
 * Returns the icon path for a Hugr type classification.
 * Used as TreeItem.iconPath.
 */
export function hugrTypeIconPath(hugrType: string): vscode.Uri | vscode.ThemeIcon {
  const file = HUGR_TYPE_ICON_FILES[hugrType];
  if (file) {
    return iconUri(file);
  }
  return new vscode.ThemeIcon('symbol-misc');
}

/**
 * Returns a label for a GraphQL introspection kind.
 */
export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/**
 * Returns a label for a Hugr type classification.
 */
export function hugrTypeLabel(hugrType: string): string {
  return HUGR_TYPE_LABELS[hugrType] ?? hugrType;
}

// ---------------------------------------------------------------------------
// Type unwrapping utility
// ---------------------------------------------------------------------------

export interface UnwrappedType {
  displayType: string;
  baseName: string;
  kind: string;
}

/**
 * Recursively unwrap NON_NULL / LIST wrappers from an introspection type
 * reference to extract the base type name, kind, and a display string
 * (e.g., "[Person]!", "String!", "[Int!]!").
 */
export function unwrapType(typeRef: any): UnwrappedType {
  if (!typeRef) {
    return { displayType: 'Unknown', baseName: 'Unknown', kind: 'SCALAR' };
  }

  if (typeRef.name) {
    return { displayType: typeRef.name, baseName: typeRef.name, kind: typeRef.kind };
  }

  const inner = unwrapType(typeRef.ofType);

  if (typeRef.kind === 'NON_NULL') {
    return { displayType: `${inner.displayType}!`, baseName: inner.baseName, kind: inner.kind };
  }
  if (typeRef.kind === 'LIST') {
    return { displayType: `[${inner.displayType}]`, baseName: inner.baseName, kind: inner.kind };
  }

  return inner;
}

// ---------------------------------------------------------------------------
// Inline SVG strings (for webview HTML rendering)
// ---------------------------------------------------------------------------

const KIND_COLORS: Record<string, string> = {
  OBJECT: '#4a90d9',
  INPUT_OBJECT: '#d98c4a',
  ENUM: '#5aad5a',
  SCALAR: '#8c8c8c',
  INTERFACE: '#9b6abf',
  UNION: '#4aad9b',
};

const HUGR_TYPE_COLORS: Record<string, string> = {
  module: '#6b7ec2',
  table: '#4a90d9',
  view: '#5a7fbf',
  filter: '#ad6b4a',
  filter_list: '#ad6b4a',
  data_input: '#d98c4a',
  join_queries: '#9b6abf',
  spatial_queries: '#4aad7a',
  h3_data: '#d95a7a',
  h3_aggregate: '#c24a6b',
  submodule: '#6b7ec2',
  select: '#4a90d9',
  select_one: '#5a7fbf',
  aggregate: '#ad8c4a',
  bucket_agg: '#ad8c4a',
  function: '#8c6abf',
  join: '#9b6abf',
  spatial: '#4aad7a',
  jq: '#7a8c4a',
  mutation_insert: '#5aad5a',
  mutation_update: '#d9a84a',
  mutation_delete: '#d95a5a',
  extra_field: '#8c8c8c',
};

function letterCircleSvg(letter: string, color: string): string {
  const fontSize = letter.length > 1 ? '7' : '9';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">` +
    `<circle cx="8" cy="8" r="7" fill="none" stroke="${color}" stroke-width="1.5"/>` +
    `<text x="8" y="11.5" text-anchor="middle" font-family="sans-serif" font-size="${fontSize}" font-weight="600" fill="${color}">${letter}</text>` +
    `</svg>`;
}

const KIND_INLINE_SVGS: Record<string, string> = {
  OBJECT: letterCircleSvg('O', KIND_COLORS.OBJECT),
  INPUT_OBJECT: letterCircleSvg('I', KIND_COLORS.INPUT_OBJECT),
  ENUM: letterCircleSvg('E', KIND_COLORS.ENUM),
  SCALAR: letterCircleSvg('S', KIND_COLORS.SCALAR),
  INTERFACE: letterCircleSvg('If', KIND_COLORS.INTERFACE),
  UNION: letterCircleSvg('U', KIND_COLORS.UNION),
};

const FALLBACK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">` +
  `<circle cx="8" cy="8" r="6" fill="none" stroke="#8c8c8c" stroke-width="1.2"/>` +
  `<circle cx="8" cy="8" r="1.5" fill="#8c8c8c"/>` +
  `</svg>`;

/**
 * Returns an inline SVG string for a GraphQL kind (for use in webview HTML).
 */
export function kindIconSvg(kind: string): string {
  return KIND_INLINE_SVGS[kind] ?? FALLBACK_SVG;
}

/**
 * Returns a CSS color for a GraphQL kind.
 */
export function kindColor(kind: string): string {
  return KIND_COLORS[kind] ?? '#8c8c8c';
}

/**
 * Returns a CSS color for a Hugr type.
 */
export function hugrTypeColor(hugrType: string): string {
  return HUGR_TYPE_COLORS[hugrType] ?? '#8c8c8c';
}

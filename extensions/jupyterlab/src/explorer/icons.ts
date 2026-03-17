/**
 * SVG icon definitions for GraphQL schema explorer.
 *
 * All icons are 16x16 inline SVGs designed to work on both light and dark
 * JupyterLab themes (medium-saturation colors).
 */

// ---------------------------------------------------------------------------
// Color palettes
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
  // type-level
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
  // field-level
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
  // type-level
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
  // field-level
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
// Helper: letter-in-circle SVG (used for GraphQL kind icons)
// ---------------------------------------------------------------------------

function letterCircle(letter: string, color: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">` +
    `<circle cx="8" cy="8" r="7" fill="none" stroke="${color}" stroke-width="1.5"/>` +
    `<text x="8" y="11.5" text-anchor="middle" font-family="sans-serif" ` +
    `font-size="${letter.length > 1 ? '7' : '9'}" font-weight="600" fill="${color}">${letter}</text>` +
    `</svg>`
  );
}

// ---------------------------------------------------------------------------
// Kind icons (GraphQL introspection kinds)
// ---------------------------------------------------------------------------

const KIND_ICONS: Record<string, string> = {
  OBJECT: letterCircle('O', KIND_COLORS.OBJECT),
  INPUT_OBJECT: letterCircle('I', KIND_COLORS.INPUT_OBJECT),
  ENUM: letterCircle('E', KIND_COLORS.ENUM),
  SCALAR: letterCircle('S', KIND_COLORS.SCALAR),
  INTERFACE: letterCircle('If', KIND_COLORS.INTERFACE),
  UNION: letterCircle('U', KIND_COLORS.UNION),
};

// ---------------------------------------------------------------------------
// HugrType icons — simple geometric 16x16 SVGs
// ---------------------------------------------------------------------------

function svgWrap(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">${inner}</svg>`;
}

const HUGR_TYPE_ICONS: Record<string, string> = {
  // --- type-level ---

  // module: folder shape
  module: svgWrap(
    `<path d="M2 4h5l1-1.5h6v10H2z" fill="none" stroke="${HUGR_TYPE_COLORS.module}" stroke-width="1.3" stroke-linejoin="round"/>`
  ),

  // table: grid
  table: svgWrap(
    `<rect x="2" y="2" width="12" height="12" rx="1" fill="none" stroke="${HUGR_TYPE_COLORS.table}" stroke-width="1.3"/>` +
    `<line x1="2" y1="6" x2="14" y2="6" stroke="${HUGR_TYPE_COLORS.table}" stroke-width="1"/>` +
    `<line x1="2" y1="10" x2="14" y2="10" stroke="${HUGR_TYPE_COLORS.table}" stroke-width="1"/>` +
    `<line x1="7" y1="6" x2="7" y2="14" stroke="${HUGR_TYPE_COLORS.table}" stroke-width="1"/>`
  ),

  // view: eye shape
  view: svgWrap(
    `<ellipse cx="8" cy="8" rx="6" ry="4" fill="none" stroke="${HUGR_TYPE_COLORS.view}" stroke-width="1.3"/>` +
    `<circle cx="8" cy="8" r="2" fill="${HUGR_TYPE_COLORS.view}"/>`
  ),

  // filter: funnel
  filter: svgWrap(
    `<polygon points="2,3 14,3 9,9 9,13 7,13 7,9" fill="none" stroke="${HUGR_TYPE_COLORS.filter}" stroke-width="1.3" stroke-linejoin="round"/>`
  ),

  // filter_list: funnel with lines
  filter_list: svgWrap(
    `<polygon points="2,3 14,3 9,9 9,13 7,13 7,9" fill="none" stroke="${HUGR_TYPE_COLORS.filter_list}" stroke-width="1.2" stroke-linejoin="round"/>` +
    `<line x1="3" y1="5.5" x2="13" y2="5.5" stroke="${HUGR_TYPE_COLORS.filter_list}" stroke-width="0.8"/>`
  ),

  // data_input: arrow into box
  data_input: svgWrap(
    `<rect x="6" y="2" width="8" height="12" rx="1" fill="none" stroke="${HUGR_TYPE_COLORS.data_input}" stroke-width="1.3"/>` +
    `<polyline points="2,8 7,8" fill="none" stroke="${HUGR_TYPE_COLORS.data_input}" stroke-width="1.3"/>` +
    `<polyline points="5,5.5 7.5,8 5,10.5" fill="none" stroke="${HUGR_TYPE_COLORS.data_input}" stroke-width="1.3" stroke-linejoin="round"/>`
  ),

  // join_queries: two overlapping circles (venn)
  join_queries: svgWrap(
    `<circle cx="6" cy="8" r="4.5" fill="none" stroke="${HUGR_TYPE_COLORS.join_queries}" stroke-width="1.3"/>` +
    `<circle cx="10" cy="8" r="4.5" fill="none" stroke="${HUGR_TYPE_COLORS.join_queries}" stroke-width="1.3"/>`
  ),

  // spatial_queries: pin / location marker
  spatial_queries: svgWrap(
    `<path d="M8 1.5C5.5 1.5 3.5 3.5 3.5 6c0 3.5 4.5 8.5 4.5 8.5s4.5-5 4.5-8.5c0-2.5-2-4.5-4.5-4.5z" fill="none" stroke="${HUGR_TYPE_COLORS.spatial_queries}" stroke-width="1.3"/>` +
    `<circle cx="8" cy="6" r="1.5" fill="${HUGR_TYPE_COLORS.spatial_queries}"/>`
  ),

  // h3_data: hexagon
  h3_data: svgWrap(
    `<polygon points="8,1.5 13.5,4.75 13.5,11.25 8,14.5 2.5,11.25 2.5,4.75" fill="none" stroke="${HUGR_TYPE_COLORS.h3_data}" stroke-width="1.3" stroke-linejoin="round"/>`
  ),

  // h3_aggregate: hexagon with sigma
  h3_aggregate: svgWrap(
    `<polygon points="8,1.5 13.5,4.75 13.5,11.25 8,14.5 2.5,11.25 2.5,4.75" fill="none" stroke="${HUGR_TYPE_COLORS.h3_aggregate}" stroke-width="1.2" stroke-linejoin="round"/>` +
    `<text x="8" y="11" text-anchor="middle" font-family="sans-serif" font-size="8" font-weight="600" fill="${HUGR_TYPE_COLORS.h3_aggregate}">\u03A3</text>`
  ),

  // --- field-level ---

  // submodule: small folder
  submodule: svgWrap(
    `<path d="M3 5h4l1-1h5v8H3z" fill="none" stroke="${HUGR_TYPE_COLORS.submodule}" stroke-width="1.2" stroke-linejoin="round"/>`
  ),

  // select: list with arrow
  select: svgWrap(
    `<line x1="4" y1="4" x2="12" y2="4" stroke="${HUGR_TYPE_COLORS.select}" stroke-width="1.3"/>` +
    `<line x1="4" y1="8" x2="12" y2="8" stroke="${HUGR_TYPE_COLORS.select}" stroke-width="1.3"/>` +
    `<line x1="4" y1="12" x2="12" y2="12" stroke="${HUGR_TYPE_COLORS.select}" stroke-width="1.3"/>` +
    `<polyline points="2,7 4,8 2,9" fill="none" stroke="${HUGR_TYPE_COLORS.select}" stroke-width="1"/>`
  ),

  // select_one: single row highlight
  select_one: svgWrap(
    `<rect x="2" y="6" width="12" height="4" rx="1" fill="none" stroke="${HUGR_TYPE_COLORS.select_one}" stroke-width="1.3"/>` +
    `<line x1="4" y1="3" x2="12" y2="3" stroke="${HUGR_TYPE_COLORS.select_one}" stroke-width="0.8" stroke-dasharray="2,1"/>` +
    `<line x1="4" y1="13" x2="12" y2="13" stroke="${HUGR_TYPE_COLORS.select_one}" stroke-width="0.8" stroke-dasharray="2,1"/>`
  ),

  // aggregate: sigma symbol in box
  aggregate: svgWrap(
    `<rect x="2" y="2" width="12" height="12" rx="1.5" fill="none" stroke="${HUGR_TYPE_COLORS.aggregate}" stroke-width="1.3"/>` +
    `<text x="8" y="11.5" text-anchor="middle" font-family="sans-serif" font-size="9" font-weight="600" fill="${HUGR_TYPE_COLORS.aggregate}">\u03A3</text>`
  ),

  // bucket_agg: bucket / cylinder with sigma
  bucket_agg: svgWrap(
    `<ellipse cx="8" cy="4" rx="5" ry="2" fill="none" stroke="${HUGR_TYPE_COLORS.bucket_agg}" stroke-width="1.2"/>` +
    `<line x1="3" y1="4" x2="3" y2="12" stroke="${HUGR_TYPE_COLORS.bucket_agg}" stroke-width="1.2"/>` +
    `<line x1="13" y1="4" x2="13" y2="12" stroke="${HUGR_TYPE_COLORS.bucket_agg}" stroke-width="1.2"/>` +
    `<ellipse cx="8" cy="12" rx="5" ry="2" fill="none" stroke="${HUGR_TYPE_COLORS.bucket_agg}" stroke-width="1.2"/>`
  ),

  // function: f(x) style
  function: svgWrap(
    `<rect x="1.5" y="2" width="13" height="12" rx="2" fill="none" stroke="${HUGR_TYPE_COLORS.function}" stroke-width="1.2"/>` +
    `<text x="8" y="11.5" text-anchor="middle" font-family="sans-serif" font-size="9" font-weight="600" fill="${HUGR_TYPE_COLORS.function}">f</text>`
  ),

  // join: two arrows merging
  join: svgWrap(
    `<polyline points="2,4 8,8 14,4" fill="none" stroke="${HUGR_TYPE_COLORS.join}" stroke-width="1.3" stroke-linejoin="round"/>` +
    `<line x1="8" y1="8" x2="8" y2="14" stroke="${HUGR_TYPE_COLORS.join}" stroke-width="1.3"/>`
  ),

  // spatial: compass / crosshair
  spatial: svgWrap(
    `<circle cx="8" cy="8" r="5.5" fill="none" stroke="${HUGR_TYPE_COLORS.spatial}" stroke-width="1.2"/>` +
    `<line x1="8" y1="1" x2="8" y2="4" stroke="${HUGR_TYPE_COLORS.spatial}" stroke-width="1.2"/>` +
    `<line x1="8" y1="12" x2="8" y2="15" stroke="${HUGR_TYPE_COLORS.spatial}" stroke-width="1.2"/>` +
    `<line x1="1" y1="8" x2="4" y2="8" stroke="${HUGR_TYPE_COLORS.spatial}" stroke-width="1.2"/>` +
    `<line x1="12" y1="8" x2="15" y2="8" stroke="${HUGR_TYPE_COLORS.spatial}" stroke-width="1.2"/>` +
    `<circle cx="8" cy="8" r="1.5" fill="${HUGR_TYPE_COLORS.spatial}"/>`
  ),

  // jq: curly braces
  jq: svgWrap(
    `<text x="8" y="12" text-anchor="middle" font-family="monospace" font-size="11" font-weight="700" fill="${HUGR_TYPE_COLORS.jq}">{}</text>`
  ),

  // mutation_insert: plus in circle
  mutation_insert: svgWrap(
    `<circle cx="8" cy="8" r="6" fill="none" stroke="${HUGR_TYPE_COLORS.mutation_insert}" stroke-width="1.3"/>` +
    `<line x1="5" y1="8" x2="11" y2="8" stroke="${HUGR_TYPE_COLORS.mutation_insert}" stroke-width="1.5"/>` +
    `<line x1="8" y1="5" x2="8" y2="11" stroke="${HUGR_TYPE_COLORS.mutation_insert}" stroke-width="1.5"/>`
  ),

  // mutation_update: pencil / edit
  mutation_update: svgWrap(
    `<path d="M2.5 13.5l1-4L11 2l2.5 2.5-7.5 7.5z" fill="none" stroke="${HUGR_TYPE_COLORS.mutation_update}" stroke-width="1.3" stroke-linejoin="round"/>` +
    `<line x1="9.5" y1="3.5" x2="12" y2="6" stroke="${HUGR_TYPE_COLORS.mutation_update}" stroke-width="1"/>`
  ),

  // mutation_delete: minus in circle
  mutation_delete: svgWrap(
    `<circle cx="8" cy="8" r="6" fill="none" stroke="${HUGR_TYPE_COLORS.mutation_delete}" stroke-width="1.3"/>` +
    `<line x1="5" y1="8" x2="11" y2="8" stroke="${HUGR_TYPE_COLORS.mutation_delete}" stroke-width="1.5"/>`
  ),

  // extra_field: dotted circle with dot
  extra_field: svgWrap(
    `<circle cx="8" cy="8" r="6" fill="none" stroke="${HUGR_TYPE_COLORS.extra_field}" stroke-width="1.2" stroke-dasharray="2,2"/>` +
    `<circle cx="8" cy="8" r="1.5" fill="${HUGR_TYPE_COLORS.extra_field}"/>`
  ),
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const FALLBACK_ICON = svgWrap(
  `<circle cx="8" cy="8" r="6" fill="none" stroke="#8c8c8c" stroke-width="1.2"/>` +
  `<circle cx="8" cy="8" r="1.5" fill="#8c8c8c"/>`
);

/**
 * Returns an inline SVG string for a GraphQL introspection kind.
 */
export function kindIcon(kind: string): string {
  return KIND_ICONS[kind] ?? FALLBACK_ICON;
}

/**
 * Returns an inline SVG string for a HugrType (type-level or field-level).
 */
export function hugrTypeIcon(hugrType: string): string {
  return HUGR_TYPE_ICONS[hugrType] ?? FALLBACK_ICON;
}

/**
 * Returns a CSS color string for a GraphQL introspection kind.
 */
export function kindColor(kind: string): string {
  return KIND_COLORS[kind] ?? '#8c8c8c';
}

/**
 * Returns a CSS color string for a HugrType.
 */
export function hugrTypeColor(hugrType: string): string {
  return HUGR_TYPE_COLORS[hugrType] ?? '#8c8c8c';
}

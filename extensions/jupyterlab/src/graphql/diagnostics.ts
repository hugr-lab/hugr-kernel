/**
 * GraphQL diagnostics renderer for JupyterLab.
 *
 * Listens for cell outputs with MIME type `application/vnd.hugr.diagnostics+json`,
 * parses the diagnostics array, and renders CodeMirror 6 decorations (underlines
 * with severity-appropriate colors).
 *
 * Diagnostic shape from kernel:
 *   { severity, message, startLine, startColumn, endLine, endColumn, code? }
 *
 * Severity colors:
 *   - Error   -> red
 *   - Warning -> orange
 *   - Info    -> blue
 *
 * Usage:
 *   import { createDiagnosticsExtension } from './graphql/diagnostics.js';
 *   editor.dispatch({ effects: setDiagnostics.of(items) });
 */

import {
  Decoration,
  type DecorationSet,
  EditorView,
  type ViewUpdate,
  hoverTooltip,
  type Tooltip,
} from '@codemirror/view';
import {
  StateField,
  StateEffect,
  type Extension,
  RangeSetBuilder,
} from '@codemirror/state';

/** A single diagnostic item as emitted by the hugr-kernel. */
export interface HugrDiagnostic {
  severity: 'Error' | 'Warning' | 'Info';
  message: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  code?: string;
}

/** MIME type the kernel uses for diagnostic output. */
export const DIAGNOSTICS_MIME = 'application/vnd.hugr.diagnostics+json';

/**
 * CSS classes for severity-colored underlines.
 * The actual styles are injected via a theme extension below.
 */
const SEVERITY_CLASS: Record<string, string> = {
  Error: 'cm-hugr-diag-error',
  Warning: 'cm-hugr-diag-warning',
  Info: 'cm-hugr-diag-info',
};

/** State effect used to push new diagnostics into the editor. */
export const setDiagnostics = StateEffect.define<HugrDiagnostic[]>();

/**
 * Converts a line/column pair (1-based) to an absolute document offset.
 * Returns -1 if the position is out of range.
 */
function posToOffset(
  doc: { line(n: number): { from: number; length: number }; lines: number },
  line: number,
  col: number,
): number {
  if (line < 1 || line > doc.lines) return -1;
  const lineObj = doc.line(line);
  const offset = lineObj.from + Math.max(0, col - 1);
  return Math.min(offset, lineObj.from + lineObj.length);
}

/**
 * Builds a DecorationSet from an array of diagnostics.
 */
function buildDecorations(
  diagnostics: HugrDiagnostic[],
  doc: EditorView['state']['doc'],
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();

  // Sort by start position so RangeSetBuilder receives them in order.
  const sorted = [...diagnostics].sort((a, b) => {
    const aPos = posToOffset(doc, a.startLine, a.startColumn);
    const bPos = posToOffset(doc, b.startLine, b.startColumn);
    return aPos - bPos;
  });

  for (const diag of sorted) {
    const from = posToOffset(doc, diag.startLine, diag.startColumn);
    const to = posToOffset(doc, diag.endLine, diag.endColumn);
    if (from < 0 || to < 0 || from >= to) continue;

    const cls = SEVERITY_CLASS[diag.severity] ?? SEVERITY_CLASS.Info;
    builder.add(
      from,
      to,
      Decoration.mark({ class: cls, attributes: { 'data-hugr-diag': diag.message } }),
    );
  }

  return builder.finish();
}

/**
 * State field that stores the current set of diagnostic decorations.
 */
const diagnosticsField = StateField.define<{
  items: HugrDiagnostic[];
  decorations: DecorationSet;
}>({
  create() {
    return { items: [], decorations: Decoration.none };
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setDiagnostics)) {
        return {
          items: effect.value,
          decorations: buildDecorations(effect.value, tr.state.doc),
        };
      }
    }
    // If the document changed, remap decorations.
    if (tr.docChanged) {
      return {
        items: value.items,
        decorations: value.decorations.map(tr.changes),
      };
    }
    return value;
  },
  provide(field) {
    return EditorView.decorations.from(field, (val) => val.decorations);
  },
});

/**
 * Hover tooltip that shows the diagnostic message when the cursor
 * is over an underlined range.
 */
const diagnosticTooltip = hoverTooltip((view, pos) => {
  const { items } = view.state.field(diagnosticsField);
  const doc = view.state.doc;

  for (const diag of items) {
    const from = posToOffset(doc, diag.startLine, diag.startColumn);
    const to = posToOffset(doc, diag.endLine, diag.endColumn);
    if (pos >= from && pos <= to) {
      return {
        pos: from,
        end: to,
        above: true,
        create(): { dom: HTMLElement } {
          const dom = document.createElement('div');
          dom.className = 'cm-hugr-diag-tooltip';
          const severity = document.createElement('strong');
          severity.textContent = diag.severity;
          dom.appendChild(severity);
          dom.appendChild(document.createTextNode(': ' + diag.message));
          if (diag.code) {
            const code = document.createElement('span');
            code.className = 'cm-hugr-diag-code';
            code.textContent = ` [${diag.code}]`;
            dom.appendChild(code);
          }
          return { dom };
        },
      } satisfies Tooltip;
    }
  }
  return null;
});

/**
 * Theme extension providing CSS for diagnostic underlines and tooltips.
 */
const diagnosticTheme = EditorView.baseTheme({
  '.cm-hugr-diag-error': {
    textDecoration: 'underline wavy red',
    textUnderlineOffset: '3px',
  },
  '.cm-hugr-diag-warning': {
    textDecoration: 'underline wavy orange',
    textUnderlineOffset: '3px',
  },
  '.cm-hugr-diag-info': {
    textDecoration: 'underline wavy #3b82f6',
    textUnderlineOffset: '3px',
  },
  '.cm-hugr-diag-tooltip': {
    padding: '4px 8px',
    fontSize: '13px',
    fontFamily: 'var(--jp-code-font-family, monospace)',
    maxWidth: '500px',
  },
  '.cm-hugr-diag-code': {
    opacity: '0.7',
    fontSize: '12px',
  },
});

/**
 * Parses a raw diagnostics output (from cell MIME data) into typed items.
 *
 * @param data - The raw JSON value from the `application/vnd.hugr.diagnostics+json` output.
 * @returns An array of HugrDiagnostic items.
 */
export function parseDiagnostics(data: unknown): HugrDiagnostic[] {
  if (!Array.isArray(data)) return [];
  return data.filter(
    (d) =>
      typeof d === 'object' &&
      d !== null &&
      typeof d.severity === 'string' &&
      typeof d.message === 'string' &&
      typeof d.startLine === 'number',
  ) as HugrDiagnostic[];
}

/**
 * Creates a CodeMirror 6 extension that provides diagnostic underlines
 * and hover tooltips.
 *
 * To push diagnostics into the editor, dispatch:
 *   view.dispatch({ effects: setDiagnostics.of(parsedItems) })
 *
 * @returns A CodeMirror Extension array.
 */
export function createDiagnosticsExtension(): Extension {
  return [diagnosticsField, diagnosticTooltip, diagnosticTheme];
}

/**
 * GraphQL hover provider for JupyterLab.
 *
 * On mouse hover over code, sends an `inspect_request` to the hugr-kernel
 * and renders the `text/markdown` payload from `inspect_reply` as a tooltip.
 *
 * Hover requests are debounced by 200 ms to avoid excessive kernel traffic.
 *
 * Usage:
 *   import { createHoverExtension } from './graphql/hover.js';
 *   const ext = createHoverExtension(() => kernel);
 */

import { hoverTooltip, type Tooltip, EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

/**
 * Kernel interface expected by the hover provider.
 * Minimal subset of the Jupyter kernel API.
 */
export interface InspectKernel {
  requestInspect(content: {
    code: string;
    cursor_pos: number;
    detail_level: number;
  }): Promise<{
    content: {
      status: string;
      found: boolean;
      data?: Record<string, string>;
      metadata?: Record<string, unknown>;
    };
  }>;
}

/**
 * Simple Markdown-to-HTML converter for tooltip content.
 * Handles headings, bold, italic, inline code, code blocks, and paragraphs.
 * For richer rendering, a full Markdown library can be substituted.
 */
function markdownToHtml(md: string): string {
  let html = md
    // Fenced code blocks
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
      return `<pre><code>${escapeHtml(code.trimEnd())}</code></pre>`;
    })
    // Inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Headings (### before ## before #)
    .replace(/^### (.+)$/gm, '<strong>$1</strong><br/>')
    .replace(/^## (.+)$/gm, '<strong>$1</strong><br/>')
    .replace(/^# (.+)$/gm, '<strong>$1</strong><br/>')
    // Bold and italic
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Line breaks
    .replace(/\n\n/g, '<br/><br/>')
    .replace(/\n/g, '<br/>');

  return html;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Theme for hover tooltips.
 */
const hoverTheme = EditorView.baseTheme({
  '.cm-hugr-hover-tooltip': {
    padding: '8px 12px',
    maxWidth: '600px',
    maxHeight: '400px',
    overflowY: 'auto',
    fontSize: '13px',
    lineHeight: '1.5',
    fontFamily: 'var(--jp-ui-font-family, sans-serif)',
  },
  '.cm-hugr-hover-tooltip code': {
    fontFamily: 'var(--jp-code-font-family, monospace)',
    backgroundColor: 'var(--jp-layout-color2, #f0f0f0)',
    padding: '1px 4px',
    borderRadius: '3px',
    fontSize: '12px',
  },
  '.cm-hugr-hover-tooltip pre': {
    margin: '4px 0',
    padding: '8px',
    backgroundColor: 'var(--jp-layout-color2, #f0f0f0)',
    borderRadius: '4px',
    overflowX: 'auto',
  },
});

/**
 * Creates a CodeMirror 6 extension that shows hover tooltips
 * using `inspect_request` / `inspect_reply` from the kernel.
 *
 * @param getKernel - Callback returning the active kernel, or null.
 * @returns A CodeMirror Extension.
 */
export function createHoverExtension(
  getKernel: () => InspectKernel | null,
): Extension {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastRequestPos = -1;

  const tooltip = hoverTooltip(
    async (view, pos): Promise<Tooltip | null> => {
      const kernel = getKernel();
      if (!kernel) return null;

      // Debounce: cancel pending request and wait 200 ms.
      if (debounceTimer) clearTimeout(debounceTimer);
      lastRequestPos = pos;

      await new Promise<void>((resolve) => {
        debounceTimer = setTimeout(resolve, 200);
      });

      // If the user moved to a different position during debounce, abort.
      if (lastRequestPos !== pos) return null;

      const code = view.state.doc.toString();

      try {
        const reply = await kernel.requestInspect({
          code,
          cursor_pos: pos,
          detail_level: 0,
        });

        if (
          reply.content.status !== 'ok' ||
          !reply.content.found ||
          !reply.content.data
        ) {
          return null;
        }

        const markdown = reply.content.data['text/markdown'];
        if (!markdown) return null;

        // Find the word boundaries around the hover position.
        const wordAt = view.state.wordAt(pos);
        const from = wordAt?.from ?? pos;
        const to = wordAt?.to ?? pos;

        return {
          pos: from,
          end: to,
          above: true,
          create(): { dom: HTMLElement } {
            const dom = document.createElement('div');
            dom.className = 'cm-hugr-hover-tooltip';
            dom.innerHTML = markdownToHtml(markdown);
            return { dom };
          },
        } satisfies Tooltip;
      } catch {
        // Kernel disconnected or request failed; no tooltip.
        return null;
      }
    },
    { hoverTime: 200 },
  );

  return [tooltip, hoverTheme];
}

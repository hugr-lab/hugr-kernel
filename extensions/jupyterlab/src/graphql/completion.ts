/**
 * GraphQL completion provider for JupyterLab.
 *
 * Intercepts `complete_reply` messages from the hugr-kernel and extracts
 * completion items from `metadata._hugr_completions`. Each item carries
 * {label, kind, detail, documentation, insertText} and is mapped to a
 * CodeMirror 6 completion entry with appropriate icons.
 *
 * Usage:
 *   import { createCompletionProvider } from './graphql/completion.js';
 *   editor.dispatch({ effects: StateEffect.appendConfig.of(createCompletionProvider(kernel)) });
 */

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';

/** Shape of a single completion item sent by the hugr-kernel. */
export interface HugrCompletionItem {
  label: string;
  kind: string;
  detail?: string;
  documentation?: string;
  insertText?: string;
}

/**
 * Maps hugr-kernel completion kinds to CodeMirror completion types.
 * CodeMirror uses these to pick an icon in the completion popup.
 */
const KIND_MAP: Record<string, string> = {
  Field: 'property',
  Type: 'type',
  Directive: 'keyword',
  Argument: 'variable',
  EnumValue: 'enum',
  Fragment: 'class',
  Variable: 'variable',
  Keyword: 'keyword',
};

/**
 * Adapts a hugr-kernel completion item to a CodeMirror completion entry.
 */
function toCompletion(item: HugrCompletionItem, pos: number): Completion {
  return {
    label: item.label,
    type: KIND_MAP[item.kind] ?? 'text',
    detail: item.detail,
    info: item.documentation,
    apply: item.insertText ?? item.label,
  };
}

/**
 * Kernel interface expected by the completion provider.
 * This is a minimal subset of the Jupyter kernel API.
 */
export interface CompletionKernel {
  requestComplete(content: {
    code: string;
    cursor_pos: number;
  }): Promise<{
    content: {
      status: string;
      cursor_start: number;
      cursor_end: number;
      matches: string[];
      metadata?: Record<string, unknown>;
    };
  }>;
}

/**
 * Creates a CodeMirror 6 autocompletion extension that fetches completions
 * from the hugr-kernel via `complete_request` / `complete_reply`.
 *
 * Completion requests are debounced by 150 ms to avoid flooding the kernel
 * while the user is still typing.
 *
 * @param getKernel - Callback that returns the active kernel, or null.
 * @returns A CodeMirror Extension providing autocompletion.
 */
export function createCompletionProvider(
  getKernel: () => CompletionKernel | null,
): Extension {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  async function completionSource(
    ctx: CompletionContext,
  ): Promise<CompletionResult | null> {
    const kernel = getKernel();
    if (!kernel) return null;

    // Only trigger after an explicit character or when invoked explicitly.
    if (!ctx.explicit && !ctx.matchBefore(/\w+$/)) return null;

    // Debounce: wait 150 ms after the last keystroke.
    if (debounceTimer) clearTimeout(debounceTimer);
    await new Promise<void>((resolve) => {
      debounceTimer = setTimeout(resolve, 150);
    });

    // If the completion was cancelled during the debounce, bail out.
    if (ctx.aborted) return null;

    const code = ctx.state.doc.toString();
    const cursorPos = ctx.pos;

    try {
      const reply = await kernel.requestComplete({
        code,
        cursor_pos: cursorPos,
      });

      if (reply.content.status !== 'ok') return null;

      const hugrItems =
        (reply.content.metadata?._hugr_completions as HugrCompletionItem[]) ??
        [];

      if (hugrItems.length === 0) {
        // Fall back to the plain matches array if no structured items.
        if (reply.content.matches.length === 0) return null;
        return {
          from: reply.content.cursor_start,
          options: reply.content.matches.map((m) => ({ label: m })),
        };
      }

      return {
        from: reply.content.cursor_start,
        options: hugrItems.map((item) =>
          toCompletion(item, reply.content.cursor_start),
        ),
      };
    } catch {
      // Kernel may have restarted or disconnected; silently ignore.
      return null;
    }
  }

  return autocompletion({
    override: [completionSource],
    activateOnTyping: true,
  });
}

/**
 * CM6 autocompletion source using kernel.requestComplete().
 *
 * Includes request cancellation: when a new completion is requested,
 * the previous pending request is abandoned (its result is ignored).
 */
import { CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete';
import { ISessionContext } from '@jupyterlab/apputils';

let _sessionContext: ISessionContext | null = null;
let _requestSeq = 0;  // monotonic sequence number for cancellation

export function setCompletionSessionContext(ctx: ISessionContext | null): void {
  _sessionContext = ctx;
}

export async function graphqlCompletionSource(context: CompletionContext): Promise<CompletionResult | null> {
  if (!_sessionContext?.session?.kernel) return null;

  const kernel = _sessionContext.session.kernel;
  const code = context.state.doc.toString();
  const pos = context.pos;

  // Only complete if there's a word (2+ chars) being typed, or explicit trigger
  const word = context.matchBefore(/[a-zA-Z_]\w*/);
  if (!word && !context.explicit) return null;
  if (word && !context.explicit && word.text.length < 1) return null;

  // Cancel any previous pending request by incrementing sequence
  const mySeq = ++_requestSeq;

  try {
    const reply = await kernel.requestComplete({ code, cursor_pos: pos });

    // If a newer request was issued while we waited, discard this result
    if (mySeq !== _requestSeq) return null;

    const content = reply.content as any;
    if (content.status !== 'ok') return null;

    const hugrCompletions = content.metadata?._hugr_completions || [];
    const completions: Completion[] = hugrCompletions.map((item: any) => ({
      label: item.label,
      type: item.kind?.toLowerCase() || 'property',
      detail: item.detail || '',
      info: item.documentation || undefined,
      apply: item.insertText || item.label,
    }));

    return {
      from: content.cursor_start ?? (word?.from ?? pos),
      options: completions,
    };
  } catch (e) {
    console.debug('Completion request failed', e);
    return null;
  }
}

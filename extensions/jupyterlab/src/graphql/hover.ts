/**
 * CM6 hover tooltip using kernel.requestInspect().
 */
import { EditorView, Tooltip } from '@codemirror/view';
import { ISessionContext } from '@jupyterlab/apputils';

let _hoverSessionContext: ISessionContext | null = null;

export function setHoverSessionContext(ctx: ISessionContext | null): void {
  _hoverSessionContext = ctx;
}

export async function graphqlHoverSource(
  view: EditorView,
  pos: number,
  side: -1 | 1
): Promise<Tooltip | null> {
  if (!_hoverSessionContext?.session?.kernel) return null;

  const kernel = _hoverSessionContext.session.kernel;
  const code = view.state.doc.toString();

  try {
    const reply = await kernel.requestInspect({ code, cursor_pos: pos, detail_level: 0 });
    const content = reply.content as any;
    if (!content.found) return null;

    const markdown = content.data?.['text/markdown'] || content.data?.['text/plain'] || '';
    if (!markdown) return null;

    return {
      pos,
      above: true,
      create() {
        const dom = document.createElement('div');
        dom.className = 'hugr-hover-tooltip';
        dom.innerHTML = markdownToHtml(markdown);
        return { dom };
      },
    };
  } catch (e) {
    return null;
  }
}

function markdownToHtml(md: string): string {
  // Simple markdown conversion for hover
  return md
    .replace(/### `(.+?)`: `(.+?)`/g, '<strong>$1</strong>: <code>$2</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

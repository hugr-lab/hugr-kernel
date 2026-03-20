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

        // Make hugr-type: and hugr-directive: links clickable
        dom.addEventListener('click', (e) => {
          const target = e.target as HTMLElement;
          const typeAnchor = target.closest('a[href^="hugr-type:"]') as HTMLAnchorElement | null;
          if (typeAnchor) {
            e.preventDefault();
            e.stopPropagation();
            const typeName = typeAnchor.getAttribute('href')!.replace('hugr-type:', '');
            dom.dispatchEvent(
              new CustomEvent('hugr-types-search', {
                bubbles: true,
                detail: { query: typeName },
              })
            );
            return;
          }
          const dirAnchor = target.closest('a[href^="hugr-directive:"]') as HTMLAnchorElement | null;
          if (dirAnchor) {
            e.preventDefault();
            e.stopPropagation();
            const dirName = dirAnchor.getAttribute('href')!.replace('hugr-directive:', '');
            dom.dispatchEvent(
              new CustomEvent('hugr-directive-search', {
                bubbles: true,
                detail: { query: dirName },
              })
            );
          }
        });

        return { dom };
      },
    };
  } catch (e) {
    return null;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function markdownToHtml(md: string): string {
  // Escape HTML entities first to prevent XSS, then apply markdown transforms
  return escapeHtml(md)
    // Markdown links: [`text`](hugr-type:X) or [text](hugr-type:X)
    .replace(/\[`(.+?)`\]\((hugr-type:[^)]+)\)/g,
      '<a href="$2" class="hugr-type-link"><code>$1</code></a>')
    .replace(/\[(.+?)\]\((hugr-type:[^)]+)\)/g,
      '<a href="$2" class="hugr-type-link">$1</a>')
    // Directive links: [`@name`](hugr-directive:X)
    .replace(/\[`(.+?)`\]\((hugr-directive:[^)]+)\)/g,
      '<a href="$2" class="hugr-type-link"><code>$1</code></a>')
    .replace(/\[(.+?)\]\((hugr-directive:[^)]+)\)/g,
      '<a href="$2" class="hugr-type-link">$1</a>')
    // Headings: ### text → <strong>
    .replace(/^### (.+)$/gm, '<strong>$1</strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

/**
 * DirectivesListSection — renders the list of GraphQL directives
 * from the introspection schema, with expandable argument details
 * and links to the directive detail modal.
 */
import { HugrClient } from '../hugrClient';
import { escapeHtml } from '../utils';
import { showDirectiveDetail } from './detailModal';

interface DirectiveInfo {
  name: string;
  description: string;
  locations: string[];
  isRepeatable: boolean;
  args: {
    name: string;
    typeName: string;
    defaultValue: string | null;
    description: string;
  }[];
  expanded: boolean;
}

const DIRECTIVES_QUERY = `{
  __schema {
    directives {
      name description locations isRepeatable
      args {
        name description defaultValue
        type { name kind ofType { name kind ofType { name kind } } }
      }
    }
  }
}`;

/**
 * Recursively unwrap NON_NULL / LIST wrappers to produce a display string
 * like "Boolean!", "[String]!", "[Int!]!" etc.
 */
function unwrapType(
  typeObj: { name?: string | null; kind?: string; ofType?: any } | null
): string {
  if (!typeObj) {
    return '';
  }
  if (typeObj.kind === 'NON_NULL') {
    return unwrapType(typeObj.ofType) + '!';
  }
  if (typeObj.kind === 'LIST') {
    return '[' + unwrapType(typeObj.ofType) + ']';
  }
  return typeObj.name || '';
}

export class DirectivesListSection {
  private _container: HTMLElement;
  private _client: HugrClient | null = null;
  private _directives: DirectiveInfo[] = [];
  private _loading = false;

  constructor(container: HTMLElement) {
    this._container = container;
  }

  setClient(client: HugrClient | null): void {
    this._client = client;
    this._loadDirectives();
  }

  /**
   * Scroll to and expand a directive by name.
   */
  scrollToDirective(name: string): void {
    const header = this._container.querySelector(
      `.hugr-dir-header[data-name="${name}"]`
    ) as HTMLElement | null;
    if (header) {
      // Expand the directive
      header.click();
      // Scroll into view
      header.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Brief highlight
      header.classList.add('hugr-dir-highlight');
      setTimeout(() => header.classList.remove('hugr-dir-highlight'), 1500);
    }
  }

  private async _loadDirectives(): Promise<void> {
    if (!this._client) {
      this._directives = [];
      this._render();
      return;
    }

    this._loading = true;
    this._render();

    try {
      const resp = await this._client.query(DIRECTIVES_QUERY);
      const rawDirectives: any[] =
        resp.data?.__schema?.directives || [];

      this._directives = rawDirectives.map((d: any) => ({
        name: d.name || '',
        description: d.description || '',
        locations: d.locations || [],
        isRepeatable: !!d.isRepeatable,
        args: (d.args || []).map((a: any) => ({
          name: a.name || '',
          typeName: unwrapType(a.type),
          defaultValue:
            a.defaultValue != null ? String(a.defaultValue) : null,
          description: a.description || '',
        })),
        expanded: false,
      }));
    } catch {
      this._directives = [];
    } finally {
      this._loading = false;
      this._render();
    }
  }

  private _render(): void {
    this._container.innerHTML = '';

    if (this._loading) {
      this._container.textContent = 'Loading directives...';
      return;
    }

    if (this._directives.length === 0) {
      this._container.textContent = 'No directives available';
      return;
    }

    const list = document.createElement('div');
    list.className = 'hugr-directives-list';

    for (const dir of this._directives) {
      const item = document.createElement('div');
      item.className = 'hugr-dir-item';

      // Header
      const header = document.createElement('div');
      header.className = 'hugr-dir-header';
      header.setAttribute('data-name', dir.name);

      const expandSpan = document.createElement('span');
      expandSpan.className = 'hugr-st-expand';
      expandSpan.textContent = dir.expanded ? '\u25BC' : '\u25B6';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'hugr-dir-name';
      nameSpan.textContent = '@' + dir.name;

      const descSpan = document.createElement('span');
      descSpan.className = 'hugr-dir-desc';
      descSpan.innerHTML = escapeHtml(dir.description);

      const actions = document.createElement('div');
      actions.className = 'hugr-st-actions';

      const infoBtn = document.createElement('button');
      infoBtn.className = 'hugr-st-btn';
      infoBtn.title = 'Details';
      infoBtn.innerHTML = '\u2139';
      infoBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this._client) {
          showDirectiveDetail(this._client, dir.name);
        }
      });

      actions.appendChild(infoBtn);
      header.appendChild(expandSpan);
      header.appendChild(nameSpan);
      header.appendChild(descSpan);
      header.appendChild(actions);

      // Args section
      const argsDiv = document.createElement('div');
      argsDiv.className = 'hugr-dir-args';
      argsDiv.style.display = dir.expanded ? '' : 'none';

      for (const arg of dir.args) {
        const argRow = document.createElement('div');
        argRow.className = 'hugr-dir-arg';

        const argName = document.createElement('span');
        argName.className = 'hugr-dir-arg-name';
        argName.textContent = arg.name;

        const argType = document.createElement('span');
        argType.className = 'hugr-dir-arg-type';
        argType.textContent = arg.typeName;

        argRow.appendChild(argName);
        argRow.appendChild(document.createTextNode(': '));
        argRow.appendChild(argType);

        if (arg.defaultValue !== null) {
          const argDefault = document.createElement('span');
          argDefault.className = 'hugr-dir-arg-default';
          argDefault.innerHTML = ' = ' + escapeHtml(arg.defaultValue);
          argRow.appendChild(argDefault);
        }

        argsDiv.appendChild(argRow);
      }

      // Toggle handler
      header.addEventListener('click', () => {
        dir.expanded = !dir.expanded;
        expandSpan.textContent = dir.expanded ? '\u25BC' : '\u25B6';
        argsDiv.style.display = dir.expanded ? '' : 'none';
      });

      item.appendChild(header);
      item.appendChild(argsDiv);
      list.appendChild(item);
    }

    this._container.appendChild(list);
  }
}

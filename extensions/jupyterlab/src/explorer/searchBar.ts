/**
 * Search bar component with debounced input.
 */
import { Widget } from '@lumino/widgets';

export class SearchBar extends Widget {
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _callback: ((query: string) => void) | null = null;
  private _debounceMs: number;

  constructor(options: { placeholder?: string; debounceMs?: number } = {}) {
    super();
    this._debounceMs = options.debounceMs ?? 300;
    this.addClass('hugr-search-bar');
    this.node.innerHTML = `
      <div class="hugr-search-container">
        <input type="text" class="hugr-search-input" placeholder="${options.placeholder || 'Search...'}" />
        <button class="hugr-search-clear" style="display:none">✕</button>
      </div>
    `;

    const input = this.node.querySelector('.hugr-search-input') as HTMLInputElement;
    const clearBtn = this.node.querySelector('.hugr-search-clear') as HTMLButtonElement;

    input?.addEventListener('input', () => {
      const query = input.value;
      clearBtn.style.display = query ? '' : 'none';
      this._debounce(() => this._callback?.(query));
    });

    clearBtn?.addEventListener('click', () => {
      input.value = '';
      clearBtn.style.display = 'none';
      this._callback?.('');
    });
  }

  set onChange(callback: (query: string) => void) {
    this._callback = callback;
  }

  private _debounce(fn: () => void): void {
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(fn, this._debounceMs);
  }
}

/**
 * Reusable search bar widget for Hugr explorers.
 *
 * Provides a text input with debounced search (300ms) and a clear button.
 * Used by both the logical explorer and the schema explorer.
 */

import { Widget } from '@lumino/widgets';

export class SearchBar extends Widget {
  private input: HTMLInputElement;
  private clearBtn: HTMLButtonElement;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private onSearch: (query: string) => void;

  constructor(options: {
    placeholder?: string;
    onSearch: (query: string) => void;
  }) {
    super();
    this.addClass('hugr-search-bar');
    this.onSearch = options.onSearch;

    // Build DOM
    const wrapper = document.createElement('div');
    wrapper.className = 'hugr-search-wrapper';

    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.className = 'hugr-search-input';
    this.input.placeholder = options.placeholder ?? 'Search...';
    this.input.addEventListener('input', () => this.handleInput());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.clear();
      }
    });

    this.clearBtn = document.createElement('button');
    this.clearBtn.className = 'hugr-search-clear';
    this.clearBtn.textContent = '\u2715'; // multiplication sign (x)
    this.clearBtn.title = 'Clear search';
    this.clearBtn.style.display = 'none';
    this.clearBtn.addEventListener('click', () => this.clear());

    wrapper.appendChild(this.input);
    wrapper.appendChild(this.clearBtn);
    this.node.appendChild(wrapper);
  }

  /** Current search query value. */
  get query(): string {
    return this.input.value.trim();
  }

  /** Programmatically clear the search bar and fire callback. */
  clear(): void {
    this.input.value = '';
    this.clearBtn.style.display = 'none';
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.onSearch('');
  }

  private handleInput(): void {
    const value = this.input.value.trim();
    this.clearBtn.style.display = value.length > 0 ? 'inline-block' : 'none';

    // Debounce: wait 300ms after last keystroke
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.onSearch(value);
    }, 300);
  }
}

/**
 * Detail modal for Hugr explorer nodes.
 *
 * Opens a modal dialog showing entity detail fetched from the
 * CommClient.detail() endpoint. Renders sections based on
 * their kind: Table, List, Text, or Code.
 */

import { CommClient, EntityDetail, DetailSection } from '../commClient.js';

/* ========== helpers ========== */

function esc(text: unknown): string {
  const el = document.createElement('span');
  el.textContent = String(text ?? '');
  return el.innerHTML;
}

/* ========== section renderers ========== */

function renderTableSection(section: DetailSection): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'hugr-detail-table-wrap';

  if (!section.columns || !section.rows || section.rows.length === 0) {
    wrapper.innerHTML = '<div class="hugr-empty">(no data)</div>';
    return wrapper;
  }

  const table = document.createElement('table');
  table.className = 'hugr-table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const col of section.columns) {
    const th = document.createElement('th');
    th.textContent = col;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const row of section.rows) {
    const tr = document.createElement('tr');
    for (const cell of row) {
      const td = document.createElement('td');
      td.textContent = cell;
      td.title = cell;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrapper.appendChild(table);
  return wrapper;
}

function renderListSection(section: DetailSection): HTMLElement {
  const ul = document.createElement('ul');
  ul.className = 'hugr-detail-list';
  for (const item of section.items ?? []) {
    const li = document.createElement('li');
    li.textContent = item;
    ul.appendChild(li);
  }
  if ((section.items ?? []).length === 0) {
    ul.innerHTML = '<li class="hugr-empty">(empty)</li>';
  }
  return ul;
}

function renderTextSection(section: DetailSection): HTMLElement {
  const p = document.createElement('p');
  p.className = 'hugr-detail-text';
  p.textContent = section.content ?? '';
  return p;
}

function renderCodeSection(section: DetailSection): HTMLElement {
  const pre = document.createElement('pre');
  pre.className = 'hugr-detail-code';
  const code = document.createElement('code');
  code.textContent = section.content ?? '';
  pre.appendChild(code);
  return pre;
}

function renderSection(section: DetailSection): HTMLElement {
  const container = document.createElement('div');
  container.className = 'hugr-detail-section';

  const title = document.createElement('h3');
  title.className = 'hugr-detail-section-title';
  title.textContent = section.title;
  container.appendChild(title);

  switch (section.kind) {
    case 'Table':
      container.appendChild(renderTableSection(section));
      break;
    case 'List':
      container.appendChild(renderListSection(section));
      break;
    case 'Text':
      container.appendChild(renderTextSection(section));
      break;
    case 'Code':
      container.appendChild(renderCodeSection(section));
      break;
    default:
      container.appendChild(renderTextSection(section));
  }

  return container;
}

/* ========== modal chrome ========== */

function showModal(title: string, content: HTMLElement): void {
  const overlay = document.createElement('div');
  overlay.className = 'hugr-modal-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'hugr-modal';

  const header = document.createElement('div');
  header.className = 'hugr-modal-header';

  const titleEl = document.createElement('span');
  titleEl.className = 'hugr-modal-title';
  titleEl.textContent = title;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'hugr-modal-close';
  closeBtn.textContent = '\u2715';
  closeBtn.addEventListener('click', () => overlay.remove());

  header.appendChild(titleEl);
  header.appendChild(closeBtn);

  const body = document.createElement('div');
  body.className = 'hugr-modal-body';
  body.appendChild(content);

  dialog.appendChild(header);
  dialog.appendChild(body);
  overlay.appendChild(dialog);

  // Close on backdrop click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  // Close on Escape key
  const handleEscape = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      overlay.remove();
      document.removeEventListener('keydown', handleEscape);
    }
  };
  document.addEventListener('keydown', handleEscape);

  document.body.appendChild(overlay);
}

/* ========== public API ========== */

/**
 * Fetch entity detail from the explorer API and display it in a modal.
 *
 * @param client - CommClient instance
 * @param nodeId - The explorer node ID to fetch detail for
 */
export async function showDetailModal(
  client: CommClient,
  nodeId: string,
): Promise<void> {
  // Show loading modal immediately
  const loadingContent = document.createElement('div');
  loadingContent.innerHTML = '<div class="hugr-loading">Loading...</div>';

  // We'll build the real content and replace it
  const contentContainer = document.createElement('div');
  contentContainer.className = 'hugr-detail-content';
  contentContainer.appendChild(loadingContent);

  showModal('Loading...', contentContainer);

  try {
    const detail: EntityDetail = await client.detail(nodeId);

    // Update the modal title (find the title element in the DOM)
    const titleEl = document.querySelector(
      '.hugr-modal-overlay:last-child .hugr-modal-title',
    );
    if (titleEl) {
      titleEl.textContent = `${detail.name} (${detail.kind})`;
    }

    // Build content
    contentContainer.innerHTML = '';

    // Description
    if (detail.description) {
      const desc = document.createElement('p');
      desc.className = 'hugr-detail-description';
      desc.textContent = detail.description;
      contentContainer.appendChild(desc);
    }

    // Long description
    if (detail.longDescription) {
      const longDesc = document.createElement('p');
      longDesc.className = 'hugr-detail-long-description';
      longDesc.textContent = detail.longDescription;
      contentContainer.appendChild(longDesc);
    }

    // Sections
    for (const section of detail.sections) {
      contentContainer.appendChild(renderSection(section));
    }

    if (detail.sections.length === 0 && !detail.description) {
      contentContainer.innerHTML =
        '<div class="hugr-empty">No detail information available.</div>';
    }
  } catch (err: any) {
    contentContainer.innerHTML =
      `<div class="hugr-error">Error loading detail: ${esc(err.message)}</div>`;
  }
}

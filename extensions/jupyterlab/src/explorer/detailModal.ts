/**
 * Detail modal widget for entity information.
 */
import { Widget } from '@lumino/widgets';
import { CommClient } from '../commClient';

export class DetailModal extends Widget {
  private _commClient: CommClient;

  constructor(commClient: CommClient) {
    super();
    this.id = 'hugr-detail-modal';
    this._commClient = commClient;
    this.addClass('hugr-detail-modal');
    this.title.label = 'Detail';
    this.title.closable = true;
  }

  async showDetail(nodeId: string): Promise<void> {
    try {
      const resp = await this._commClient.request('detail', { node_id: nodeId });
      const detail = (resp as any).detail || {};
      this._renderDetail(detail);
    } catch (e) {
      this.node.innerHTML = '<p>Failed to load details</p>';
    }
  }

  private _renderDetail(detail: any): void {
    const name = detail.name || detail.id || 'Unknown';
    const kind = detail.kind || '';
    const desc = detail.description || '';

    let html = `<div class="hugr-detail">
      <h3>${name} <span class="hugr-detail-kind">${kind}</span></h3>
      ${desc ? `<p>${desc}</p>` : ''}
    `;

    const sections = detail.sections || [];
    for (const section of sections) {
      html += `<h4>${section.title}</h4>`;

      if (section.kind === 'Table' && section.columns && section.rows) {
        html += '<table class="hugr-detail-table"><thead><tr>';
        for (const col of section.columns) {
          html += `<th>${col}</th>`;
        }
        html += '</tr></thead><tbody>';
        for (const row of section.rows) {
          html += '<tr>';
          for (const cell of row) {
            html += `<td>${cell ?? ''}</td>`;
          }
          html += '</tr>';
        }
        html += '</tbody></table>';
      } else if (section.kind === 'List' && section.items) {
        html += '<ul>';
        for (const item of section.items) {
          html += `<li>${item}</li>`;
        }
        html += '</ul>';
      } else if (section.kind === 'Text' && section.content) {
        html += `<p>${section.content}</p>`;
      } else if (section.kind === 'Code' && section.content) {
        html += `<pre><code>${section.content}</code></pre>`;
      }
    }

    html += '</div>';
    this.node.innerHTML = html;
  }
}

import type { NoteRelatedRecordView } from './note-reader.js';
import { e } from '../template.js';

export interface CommitmentRelatedView {
  more: boolean;
  records: ReadonlyArray<NoteRelatedRecordView & {
    expanded: boolean; previewing: boolean; status?: string; subtitle?: string; preview_error?: string;
    preview?: { title: string; fields: ReadonlyArray<readonly [string, string]>; notice: string };
  }>;
}
const kindLabel = (kind: NoteRelatedRecordView['kind']): string => ({ contact: 'Contact', project: 'Project', task: 'Task' })[kind];
const button = (action: string, key: string, label: string, extra = '') => `<button type="button" class="work-entity-dialog-cancel" data-action="${action}-commitment-related" data-commitment-related-key="${e(key)}" data-commitment-focus="related-${action}:${e(key)}"${extra}>${label}</button>`;

export const renderCommitmentRelated = (view?: CommitmentRelatedView): string => {
  if (!view?.records.length) return '';
  return `<details class="work-entity-commitment-related" data-commitment-section="related"><summary>Related records</summary>
    <ul class="commitment-related-list">${view.records.map((row, index) => {
      const kind = kindLabel(row.kind), blocked = row.opening ? ' disabled aria-busy="true"' : '';
      const previewId = `commitment-related-preview-${index}`;
      return `<li class="commitment-related-row" data-commitment-related-row="${e(row.key)}">
        <h3 tabindex="-1" data-commitment-heading="${e(row.key)}" data-commitment-focus="related-heading:${e(row.key)}">${e(row.label)}</h3><p class="commitment-related-meta">${e(kind)}${row.status ? ` · ${e(row.status === 'Status unconfirmed' ? row.status : `Saved status: ${row.status}`)}` : ''}${row.subtitle ? ` · ${e(row.subtitle)}` : ''}${row.state === 'loading' ? ' · Loading…' : ''}</p>
        ${row.message ? `<p role="status">${e(row.message)}</p>` : ''}
        <div class="commitment-related-actions">${row.state === 'ready' ? button('preview', row.key, row.previewing ? 'Checking…' : row.expanded ? 'Hide preview' : 'Preview', `${blocked} aria-expanded="${row.expanded}" aria-controls="${previewId}" aria-label="Preview ${e(kind.toLowerCase())} ${e(row.label)}"`)
          + button('open', row.key, row.opening && !row.previewing ? 'Opening…' : 'Open', `${blocked}${row.can_open === false ? ' disabled' : ''} aria-label="Open ${e(kind.toLowerCase())} ${e(row.label)}"`) : ''}
        ${row.state === 'missing' || row.state === 'unavailable' ? button('retry', row.key, 'Try again', ` aria-label="Try ${e(kind.toLowerCase())} ${e(row.label)} again"`) : ''}</div>
        ${row.expanded ? `<section class="commitment-related-preview" id="${previewId}" role="region" aria-label="${kind} preview" tabindex="-1" data-commitment-related-preview="${e(row.key)}" data-commitment-focus="related-panel:${e(row.key)}">
          ${button('close-preview', row.key, 'Close preview')}
          ${row.preview_error ? `<p role="status">${e(row.preview_error)}</p>` : row.preview ? `<h4>${e(row.preview.title)}</h4><dl>${row.preview.fields.map(([label, value]) => `<div><dt>${e(label)}</dt><dd>${e(value)}</dd></div>`).join('')}</dl>
            ${row.preview.notice ? `<p role="status">${e(row.preview.notice)}</p>` : ''}` : `<p role="status">${row.state === 'loading' || row.opening || row.previewing ? 'Loading saved details…' : 'Preview unavailable. Try this record again.'}</p>`}
        </section>` : ''}
      </li>`;
    }).join('')}</ul>${view.more ? '<button type="button" class="work-entity-dialog-cancel" data-action="more-commitment-related" data-commitment-focus="related-more">More related records</button>' : ''}
  </details>`;
};

/** Checklist block — status-keyed items with detail text.
 *
 *  The colored ring around each item (via `.checklist-item.checklist-{status}`
 *  CSS) carries the primary signal; the inner glyph is redundancy.
 *  Items whose detail exceeds 80 chars collapse into a `<details>`
 *  expander. The inline `check` / `x` SVGs mirror the canonical
 *  glyphs in `@recued/ui-shared`'s icons module so the renderer
 *  package stays self-contained. */

import { e } from './escape.js';
import { renderBlockEmpty, renderBlockError } from './block-error.js';
import { renderActionGroupInline } from './action.js';
import { renderBlockLabel } from './label.js';
import type { ChecklistData } from './types.js';

const CHECK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2.5" stroke-linecap="round" ' +
  'stroke-linejoin="round" role="img" aria-label="Success" class="icon icon-xs">' +
  '<title>Success</title><polyline points="5 12 10 17 19 6"/></svg>';

const X_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2.5" stroke-linecap="round" ' +
  'stroke-linejoin="round" role="img" aria-label="Issue" class="icon icon-xs">' +
  '<title>Issue</title><line x1="6" y1="6" x2="18" y2="18"/>' +
  '<line x1="18" y1="6" x2="6" y2="18"/></svg>';

const renderChecklistIcon = (status: string | undefined): string => {
  if (status === 'ok') return CHECK_SVG;
  if (status === 'issue') return X_SVG;
  return '';
};

export const renderChecklistBlock = (data: unknown, label?: string): string => {
  if (!data || typeof data !== 'object') return renderBlockError('checklist', 'invalid data');
  const d = data as Partial<ChecklistData>;
  const items = Array.isArray(d.items) ? d.items : [];
  if (items.length === 0) return renderBlockEmpty('checklist');

  return `
    <div class="block checklist-block">
      ${
        // The authored section `label` takes the heading slot; `to_checklist`'s own
        // `data.title` is the fallback it has always been. Checklist is the one kind that
        // already had a heading of its own, so an ignored `label` here would print nothing
        // while every sibling kind honoured it — the same silence, one kind deep.
        renderBlockLabel(label) || (d.title ? `<h3 class="block-title">${e(String(d.title))}</h3>` : '')
      }
      <ul class="checklist">
        ${items
          .map(
            (item) => `
          <li class="checklist-item checklist-${e(String(item.status ?? 'null'))}">
            <span class="check-icon">${renderChecklistIcon(item.status)}</span>
            <div class="check-body">
              <div class="check-label">${e(String(item.label ?? ''))}</div>
              ${item.detail
                ? String(item.detail).length > 80
                  ? `<details class="check-detail-expand"><summary class="check-detail">${e(String(item.detail).slice(0, 77))}...</summary><p>${e(String(item.detail))}</p></details>`
                  : `<div class="check-detail">${e(String(item.detail))}</div>`
                : ''}
              ${Array.isArray(item.actions)
                ? renderActionGroupInline(item.actions)
                : item.action !== undefined
                  ? renderActionGroupInline(item.action)
                  : ''}
            </div>
          </li>
        `,
          )
          .join('')}
      </ul>
    </div>
  `;
};

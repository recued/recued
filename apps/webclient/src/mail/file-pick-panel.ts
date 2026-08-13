/** D-172 P2 — the compose route's file chooser.
 *
 *  The attachment picker in the dialog renders what is ALREADY attached and
 *  fires `mail-compose-attachment-add`; it deliberately owns no browser,
 *  because a shared UI package must not know how this host reads the owner's
 *  files. This is that browser, for the `#mail` route.
 *
 *  ⛔ THE ID PROJECTION IS NOT REDONE HERE. `data.mirror.search(kind:'files')`
 *  returns a collection-QUALIFIED entity id, so a CAS hit arrives as
 *  `file:file:<id>` — the outer `file:` is the qualifier, the inner one is
 *  part of every durable `data.file` record id. Stripping the wrong one hands
 *  a recipe an id that resolves to nothing. `fileRefOptionsFromMirrorResults`
 *  (D-200) already encodes that rule and is reused verbatim rather than
 *  reimplemented — a second copy is how the two drift.
 *
 *  ⚠ Size is NOT available from mirror search. The chips therefore render
 *  "size unknown" rather than a guessed number, and the over-cap mark cannot
 *  fire for a file chosen here. That is a real limitation, not an oversight:
 *  the server still drops + warns on an over-cap attachment, so the outcome is
 *  correct, just discovered later than it would be with a size-bearing read. */

import { fileRefOptionsFromMirrorResults } from '../recipes/file-ref-picker.js';
import type { MailComposeAttachment } from '@recued/contracts';

export const FILE_PICK_PANEL_ATTR = 'data-recued-mail-file-pick';
export const FILE_PICK_OPTION_ATTR = 'data-recued-mail-file-option';
export const FILE_PICK_CONFIRM_ATTR = 'data-recued-mail-file-confirm';
export const FILE_PICK_CANCEL_ATTR = 'data-recued-mail-file-cancel';
export const FILE_PICK_SEARCH_ATTR = 'data-recued-mail-file-search';

/** `data.mirror.search` narrowed to the one kind this panel reads. */
export type MirrorFileSearchCaller = (args: {
  kind: 'files';
  query: string;
  limit?: number;
}) => Promise<{ results?: ReadonlyArray<unknown> }>;

const esc = (s: string): string =>
  s.replace(/[&<>"']/gu, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** Read the owner's file inventory as compose-attachment display metadata. */
export const listComposeFiles = async (
  search: MirrorFileSearchCaller,
  query = '',
): Promise<MailComposeAttachment[]> => {
  const res = await search({ kind: 'files', query, limit: 50 });
  return fileRefOptionsFromMirrorResults(res.results ?? []).map((o) => ({
    id: o.id,
    filename: o.label,
  }));
};

export const FILE_PICK_STYLES = `
[${FILE_PICK_PANEL_ATTR}] {
  position: fixed; inset: 0; z-index: 1200;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.45);
}
[${FILE_PICK_PANEL_ATTR}] .file-pick-dialog {
  background: var(--rx-bg, var(--surface)); color: var(--rx-fg, var(--fg));
  border-radius: 8px; padding: 16px; width: min(520px, 90vw);
  max-height: 80vh; display: flex; flex-direction: column; gap: 10px;
}
[${FILE_PICK_PANEL_ATTR}] .file-pick-list {
  list-style: none; margin: 0; padding: 0; overflow: auto;
  display: flex; flex-direction: column; gap: 4px;
}
[${FILE_PICK_PANEL_ATTR}] .file-pick-row { display: flex; align-items: center; gap: 8px; }
[${FILE_PICK_PANEL_ATTR}] .file-pick-actions {
  display: flex; justify-content: flex-end; gap: 8px;
}
[${FILE_PICK_PANEL_ATTR}] .file-pick-empty { margin: 0; color: var(--rx-muted, var(--fg-muted)); }
`;

/** Open the chooser. Resolves with the selected `data.file` record ids, or an
 *  empty array if the owner cancelled — the caller treats both the same, which
 *  is why cancel is not an error. */
export const openFilePickPanel = (
  doc: Document,
  files: ReadonlyArray<MailComposeAttachment>,
  alreadyAttached: ReadonlyArray<string>,
): Promise<readonly string[]> =>
  new Promise((resolve) => {
    const host = doc.createElement('div');
    host.setAttribute(FILE_PICK_PANEL_ATTR, '');

    const attached = new Set(alreadyAttached);
    const selectable = files.filter((f) => !attached.has(f.id));

    host.innerHTML = `
      <div class="file-pick-dialog" role="dialog" aria-modal="true" aria-label="Attach files">
        ${selectable.length === 0
          ? `<p class="file-pick-empty">${files.length === 0
            ? 'No files in your warehouse yet. Upload one from Data → Files.'
            : 'Every file in your warehouse is already attached.'}</p>`
          : `<ul class="file-pick-list">${selectable
            .map((f) => `<li class="file-pick-row">
              <label>
                <input type="checkbox" ${FILE_PICK_OPTION_ATTR}="${esc(f.id)}" />
                <span>${esc(f.filename)}</span>
              </label>
            </li>`)
            .join('')}</ul>`}
        <div class="file-pick-actions">
          <button type="button" ${FILE_PICK_CANCEL_ATTR}>Cancel</button>
          <button type="button" ${FILE_PICK_CONFIRM_ATTR}${selectable.length === 0 ? ' disabled' : ''}>Attach</button>
        </div>
      </div>
    `;

    let settled = false;
    const close = (ids: readonly string[]): void => {
      if (settled) return;
      settled = true;
      host.remove();
      resolve(ids);
    };

    host.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(`[${FILE_PICK_CANCEL_ATTR}]`) !== null) {
        close([]);
        return;
      }
      if (target.closest(`[${FILE_PICK_CONFIRM_ATTR}]`) !== null) {
        const ids = Array.from(
          host.querySelectorAll<HTMLInputElement>(`[${FILE_PICK_OPTION_ATTR}]`),
        )
          .filter((el) => el.checked)
          .map((el) => el.getAttribute(FILE_PICK_OPTION_ATTR) ?? '')
          .filter((id) => id.length > 0);
        close(ids);
        return;
      }
      // Backdrop dismiss — same `target === currentTarget` discipline the
      // compose dialog uses, so a click on a checkbox does not close the panel.
      if (target === host) close([]);
    });

    doc.body.appendChild(host);
  });

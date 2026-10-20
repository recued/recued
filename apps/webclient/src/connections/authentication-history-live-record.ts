import { authenticationHistoryExportRecord, authenticationHistoryEntryType, authenticationHistoryEntryOutcome, authenticationHistoryPrivateExport,
  AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES, type AuthenticationHistoryEntry, type AuthenticationHistoryExportEntry, type AuthenticationHistoryExportMode } from '@recued/contracts';
import { downloadAuthenticationHistory } from './authentication-history-export.js';
import { createAuthenticationHistoryRecordActions } from './authentication-history-record-actions.js';
import type { PreparedAuthenticationHistoryRecordDownload } from './authentication-history-saved-file.js';

const freeze = (value: unknown): void => {
  if (!value || typeof value !== 'object') return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
};

/** Capture one public entry from a live page. Pagination is not source-report
 * metadata: no timestamp, source position, scope or completeness is invented. */
export const prepareAuthenticationHistoryLiveRecord = (value: unknown, mode: AuthenticationHistoryExportMode): PreparedAuthenticationHistoryRecordDownload => {
  if (mode !== 'aliases' && mode !== 'full') throw new Error('Invalid record privacy mode.');
  const record = authenticationHistoryExportRecord(value);
  if (!record) throw new Error('Invalid saved history record.');
  const full: AuthenticationHistoryExportEntry = { type: authenticationHistoryEntryType(record), outcome: authenticationHistoryEntryOutcome(record), record };
  // The existing alias projector takes a report. This internal carrier supplies
  // no identity context and is discarded; only its one entry can leave here.
  const entry = mode === 'full' ? full : authenticationHistoryPrivateExport({ format: 'recued.connection-history', version: 1,
    exported_at: 0, scope: { kind: 'all' }, filters: {}, retention_days: 90, finished_record_limit: 10000, complete: true,
    evidence: 'retained_local_observations', current_authentication: 'not_checked', entry_count: 1, entries: [full] }).entries[0]!;
  const json = JSON.stringify(entry); const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES) throw new Error('History record is too large.');
  freeze(entry);
  return Object.freeze({ entry, json, bytes, count: 1, representation: mode,
    filename: 'recued-connection-history-' + (mode === 'aliases' ? 'aliases-' : '') + 'record-' + entry.type + '.json' });
};

/** Stable, lazy disclosures keep local exports independent of whole-report RPCs
 * and unrelated renders. Row replacement, closing and privacy changes retire
 * their action groups, including delayed clipboard feedback. */
export const createAuthenticationHistoryLiveRecords = (deps: {
  document: Document; mode(): AuthenticationHistoryExportMode; active(control: HTMLElement): boolean;
  previewId: string; preview(value: PreparedAuthenticationHistoryRecordDownload, origin: HTMLElement, recordId: string): void;
  download?(filename: string, json: string): void;
}) => {
  const doc = deps.document;
  const views = new Map<AuthenticationHistoryEntry, { element: HTMLDetailsElement; summary: HTMLElement; reset(): void }>();
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const element = doc.createElement(tag); if (text !== undefined) element.textContent = text; return element;
  };
  const append = (parent: HTMLElement, row: AuthenticationHistoryEntry): void => {
    let view = views.get(row);
    if (!view) {
      const element = node('details'); element.setAttribute('data-history-live-record', row.id);
      const summary = node('summary', 'Export this record'); element.appendChild(summary);
      let content: HTMLElement | undefined; let epoch = 0;
      const reset = (): void => {
        const old = content; const focused = doc.activeElement; const ownedFocus = old?.contains(focused);
        epoch++; if (old) element.removeChild(old); content = undefined;
        if (element.open) {
          content = node('div'); element.appendChild(content);
          const selectedMode = deps.mode(); const version = epoch;
          content.appendChild(node('p', selectedMode === 'aliases'
            ? 'Privacy mode (aliases). Names, IDs and fingerprints become aliases for this record file only. Matching aliases in separate files do not establish a link. Dates, providers and outcomes remain. Review before sharing.'
            : 'Names and IDs (local use). This record includes saved account and app labels, names and IDs. Keep it for local use.'));
          try {
            const prepared = prepareAuthenticationHistoryLiveRecord(row, selectedMode);
            const active = (control: HTMLElement): boolean => version === epoch && views.get(row)?.element === element
              && selectedMode === deps.mode() && element.open && element.contains(control) && deps.active(control);
            const preview = node('button', 'Preview this record'); preview.type = 'button'; preview.setAttribute('data-history-live-control', 'preview');
            preview.setAttribute('aria-controls', deps.previewId); preview.setAttribute('aria-label', 'Preview this record: ' + prepared.entry.type + ' · ' + prepared.entry.record.id);
            const error = node('p'); error.hidden = true; error.setAttribute('role', 'alert'); error.setAttribute('data-history-live-preview', 'error');
            preview.addEventListener('click', event => {
              if (!active(preview) || preview.disabled) return;
              if (event.detail > 0 && (doc.activeElement === summary || doc.activeElement === doc.body)) preview.focus({ preventScroll: true });
              if (!active(preview) || preview.disabled) return;
              error.textContent = ''; error.hidden = true;
              try { deps.preview(prepared, preview, row.id); }
              catch { if (active(preview)) { error.textContent = 'This record preview could not be opened. You can still copy or download the record.'; error.hidden = false; } }
            });
            content.appendChild(preview); content.appendChild(error);
            content.appendChild(createAuthenticationHistoryRecordActions({ document: doc, entry: prepared.entry, file: { filename: prepared.filename }, origin: summary,
              context: 'live history', active, download: deps.download ?? ((filename, json) => downloadAuthenticationHistory(doc, filename, json)),
              help: 'Contains this complete saved entry as JSON, including its type and recorded outcome, in the selected export privacy mode. Credentials and raw provider errors are omitted. Source snapshot details are unknown. References may point outside this entry. Current vendor access is not checked.' }).element);
          } catch {
            const error = node('p', 'This record could not be prepared within the supported format and 8 MiB limit. Try Privacy mode (aliases) for a large record, or refresh history and update the server.');
            error.setAttribute('role', 'alert'); content.appendChild(error);
          }
        }
        if (ownedFocus && deps.active(summary) && (doc.activeElement === focused || doc.activeElement === doc.body || !doc.activeElement?.isConnected)) summary.focus({ preventScroll: true });
      };
      element.addEventListener('toggle', () => { if (views.get(row)?.element === element && deps.active(element) && element.open !== !!content) reset(); });
      view = { element, summary, reset }; views.set(row, view);
    }
    parent.appendChild(view.element);
  };
  return { append, recordId: (control: HTMLElement): string | undefined => {
      for (const [row, view] of views) if (view.element.contains(control)) return row.id;
      return undefined;
    },
    focusTarget: (id: string, preferred?: HTMLElement): HTMLElement | undefined => {
      for (const [row, view] of views) if (row.id === id && deps.active(view.summary)) {
        return preferred && view.element.open && view.element.contains(preferred) && deps.active(preferred) ? preferred : view.summary;
      }
      return undefined;
    },
    retain: (rows: readonly AuthenticationHistoryEntry[]): void => { const retained = new Set(rows); for (const row of views.keys()) if (!retained.has(row)) views.delete(row); },
    privacyChanged: (): void => { for (const view of views.values()) view.reset(); },
    dispose: (): void => { views.clear(); } };
};

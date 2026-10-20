import { isAuthenticationHistoryExport, authenticationHistoryExportReport, authenticationHistoryPrivateExport, authenticationIncidentScope, authenticationIncidentHistoryFilters,
  AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES, type AuthenticationHistoryExportQuery, type AuthenticationHistoryExportMode,
  type AuthenticationHistoryExport, type AuthenticationHistoryPrivateExport } from '@recued/contracts';

type Snapshot<T> = T extends readonly (infer U)[] ? readonly Snapshot<U>[] : T extends object ? { readonly [K in keyof T]: Snapshot<T[K]> } : T;
export interface PreparedAuthenticationHistoryDownload {
  readonly filename: string; readonly json: string; readonly count: number; readonly bytes: number;
  readonly report: Snapshot<AuthenticationHistoryExport | AuthenticationHistoryPrivateExport>;
}
const freezeSnapshot = (value: unknown): void => {
  if (!value || typeof value !== 'object') return;
  for (const child of Object.values(value)) freezeSnapshot(child);
  Object.freeze(value);
};

class HistoryDownloadError extends Error {
  constructor(readonly code: 'download_unavailable' | 'payload_too_large') {
    super(code === 'payload_too_large' ? 'History export is too large.' : 'File downloads are unavailable.');
  }
}

/** Validate completeness and the selected scope/filters before allowing a download.
 * Reapply the public-field allowlist even to an otherwise valid newer reply. */
export const prepareAuthenticationHistoryDownload = (value: unknown, query: AuthenticationHistoryExportQuery, mode: AuthenticationHistoryExportMode = 'full'): PreparedAuthenticationHistoryDownload => {
  if ((mode !== 'full' && mode !== 'aliases') || !isAuthenticationHistoryExport(value)
    || JSON.stringify(authenticationIncidentScope(value.scope)) !== JSON.stringify(authenticationIncidentScope(query.scope))
    || JSON.stringify(authenticationIncidentHistoryFilters(value.filters)) !== JSON.stringify(authenticationIncidentHistoryFilters(query.filters))) {
    throw new Error('Invalid history export.');
  }
  const report = mode === 'aliases' ? authenticationHistoryPrivateExport(value) : authenticationHistoryExportReport(value); const json = JSON.stringify(report);
  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES) throw new HistoryDownloadError('payload_too_large');
  freezeSnapshot(report);
  return Object.freeze({ filename: 'recued-connection-history-' + (mode === 'aliases' ? 'aliases-' : '') + new Date(report.exported_at).toISOString().replace(/[:.]/g, '-') + '.json', json, count: report.entry_count, bytes, report });
};

const downloadHistoryFile = (doc: Document, filename: string, content: string, type: string): void => {
  const view = doc.defaultView;
  if (!view?.URL?.createObjectURL || !view.URL.revokeObjectURL || !view.Blob || !doc.body) throw new HistoryDownloadError('download_unavailable');
  let href: string | undefined; let anchor: HTMLAnchorElement | undefined;
  try {
    href = view.URL.createObjectURL(new view.Blob([content], { type }));
    anchor = doc.createElement('a'); anchor.href = href; anchor.download = filename; anchor.hidden = true;
    doc.body.appendChild(anchor); anchor.click();
  } catch { throw new HistoryDownloadError('download_unavailable'); }
  finally { anchor?.remove(); if (href !== undefined) { const url = href; setTimeout(() => view.URL.revokeObjectURL(url), 1000); } }
};

export const downloadAuthenticationHistory = (doc: Document, filename: string, json: string): void =>
  downloadHistoryFile(doc, filename, json, 'application/json;charset=utf-8');

export const downloadAuthenticationHistoryText = (doc: Document, filename: string, text: string): void =>
  downloadHistoryFile(doc, filename, text, 'text/plain;charset=utf-8');

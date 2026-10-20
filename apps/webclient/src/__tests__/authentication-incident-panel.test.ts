import { prepareAuthenticationHistorySupportTimeline } from '../connections/authentication-history-support-timeline.js';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticationIncidentHistoryPage, AuthenticationIncidentHistoryCaller, AuthenticationIncidentScope, AuthenticationRepairAction, AuthenticationRenewalHistory, AuthenticationAccessVerification, AuthenticationIncidentHistoryFilters,
  AuthenticationHistoryExportCaller, AuthenticationHistoryExport } from '@recued/contracts';
import { prepareAuthenticationHistoryLiveRecord } from '../connections/authentication-history-live-record.js';
import { prepareAuthenticationHistoryDownload, downloadAuthenticationHistory, downloadAuthenticationHistoryText } from '../connections/authentication-history-export.js';
import { compareAuthenticationHistorySnapshots } from '../connections/authentication-history-comparison.js';
import { prepareAuthenticationHistoryComparisonSummary } from '../connections/authentication-history-comparison-summary.js';
import { prepareAuthenticationHistoryComparisonPair } from '../connections/authentication-history-comparison-pair.js';
import { openAuthenticationHistoryFile } from '../connections/authentication-history-saved-file.js';
import { createAuthenticationHistoryRelatedBundles, prepareAuthenticationHistoryRelatedDownload } from '../connections/authentication-history-related-bundle.js';
import { authenticationHistoryRecordContext, prepareAuthenticationHistoryContextRecord } from '../connections/authentication-history-record-context.js';
import { authenticationHistoryExportReport, authenticationHistoryEntryType, authenticationHistoryEntryOutcome, AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES } from '@recued/contracts';
import { authenticationIncidentHistoryHref, renderAuthenticationManagement } from '@recued/ui-shared';
import { parseConnectionsIncidentHistory, parseConnectionsIncidentHistoryView } from '../connections/connections-navigation.js';
import { parseShellRoute } from '../shell/route.js';
import { createAuthenticationIncidentPanel } from '../connections/authentication-incident-panel.js';
import { createAuthenticationHistoryPreview } from '../connections/authentication-history-preview.js';
import type { OAuthAppsCaller } from '../settings/oauth-apps-panel.js';

type TestEvent = { preventDefault(): void; detail: number; key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean };
class Element {
  children: Element[] = []; attrs = new Map<string, string>(); listeners = new Map<string, (event: TestEvent) => void>();
  textContent = ''; className = ''; type = ''; disabled = false; hidden = false; open = false; value = ''; selectionStart: number | null = null; selectionEnd: number | null = null;
  focus?: (options?: FocusOptions) => void;
  get firstChild(): Element | null { return this.children[0] ?? null; }
  appendChild(child: Element): void { this.children.push(child); }
  removeChild(child: Element): void { this.children.splice(this.children.indexOf(child), 1); }
  setAttribute(key: string, value: string): void { this.attrs.set(key, value); }
  removeAttribute(key: string): void { this.attrs.delete(key); }
  getAttribute(key: string): string | null { return this.attrs.get(key) ?? null; }
  contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)); }
  addEventListener(key: string, fn: (event: TestEvent) => void): void { this.listeners.set(key, fn); }
  fire(key: string, detail = 0, keyboard: Partial<Pick<TestEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey'>> = {}): void {
    this.listeners.get(key)?.({ preventDefault() {}, detail, key: '', altKey: false, ctrlKey: false, metaKey: false, ...keyboard });
  }
  click(): void { if (!this.disabled) this.fire('click'); }
  setSelectionRange(start: number, end: number): void { this.selectionStart = start; this.selectionEnd = end; }
  text(): string { return this.textContent + ' ' + this.children.map(child => child.text()).join(' '); }
  find(key: string, value: string): Element | undefined { return this.attrs.get(key) === value ? this : this.children.map(c => c.find(key, value)).find(Boolean); }
  querySelector(selector: string): Element | null {
    const match = /^\[([^=]+)="([^"]+)"\]$/.exec(selector); return match ? this.find(match[1]!, match[2]!) ?? null : null;
  }
  querySelectorAll(selector: string): Element[] {
    const match = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector); if (!match) return [];
    return this.children.flatMap(child => [...(child.attrs.has(match[1]!) && (match[2] === undefined || child.attrs.get(match[1]!) === match[2]) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
}
// Inline spans and marks do not insert the block separators used by text().
const literalText = (element: Element): string => element.textContent + element.children.map(literalText).join('');
const page = (scope: AuthenticationIncidentScope = { kind: 'connection', name: 'work' }): AuthenticationIncidentHistoryPage => ({ scope, observed_at: 200, retention_days: 90,
  incidents: [{ id: '12345678-1234-4123-8123-123456789abc', status: 'retired', started_at: 100, last_problem_at: 150, history_started_at: 100, ended_at: 200,
    retirement_reason: 'authentication_changed', currently_reported: false, level: 'rejected', events_truncated: false, details_truncated: false,
    events: [{ kind: 'opened', at: 100, level: 'rejected' }, { kind: 'retired', at: 200, level: 'rejected' }],
    group: { id: 'a'.repeat(64), kind: 'account', label: '<script>Work</script>', authentication: 'direct_oauth', connection_names: ['work'],
      issues: [], uses: [{ kind: 'pack', id: 'sheet', label: 'Sheets' }], targets: [{ kind: 'connection', name: 'work' }], usage_available: false } }] });
const mount = (call?: AuthenticationIncidentHistoryCaller, scope: AuthenticationIncidentScope = { kind: 'connection', name: 'work' }, shortcuts?: { filters?: AuthenticationIncidentHistoryFilters; renewal?: OAuthAppsCaller; navigate?(hash: string): void; verify?: import('../settings/managed-oauth-panel.js').ManagedOAuthCaller;
  exportHistory?: AuthenticationHistoryExportCaller; download?(filename: string, json: string): void; downloadText?(filename: string, text: string): void }) => {
  const host = new Element(); const body = new Element();
  const doc = { body, activeElement: body, createElement: () => {
    const element = new Element(); element.focus = () => { doc.activeElement = element; }; return element;
  } };
  const panel = createAuthenticationIncidentPanel({ document: doc as unknown as Document,
    scope, ...(call ? { call } : {}), ...shortcuts }); panel.mount(host as unknown as HTMLElement); return { host, panel, doc };
};

const historyExport = (scope: AuthenticationIncidentScope = page().scope, count = 68): AuthenticationHistoryExport => ({ format: 'recued.connection-history', version: 1,
  exported_at: 300, scope, filters: {}, retention_days: 90, finished_record_limit: 10000, complete: true, evidence: 'retained_local_observations', current_authentication: 'not_checked',
  entry_count: count, entries: Array.from({ length: count }, (_, n) => ({ type: 'incident', outcome: 'retired', record: { ...page().incidents[0]!, id: String(n).padStart(8, '0') + '-1234-4123-8123-123456789abc' } })) });

const savePreview = (f: ReturnType<typeof mount>): void => { f.host.find('data-history-preview-control', 'download')!.click(); };
const searchPreview = (f: ReturnType<typeof mount>, text: string): void => {
  const input = f.host.find('data-history-preview-search', 'query')!; input.value = text; input.fire('input');
  f.host.find('data-history-preview-search', 'form')!.fire('submit');
};
const copyBrowser = (f: ReturnType<typeof mount>, navigator: object = {}) => {
  let selected: Element | undefined;
  const range = { selectNodeContents: vi.fn((element: Element) => { selected = element; }) };
  const selection = { anchorNode: null as Element | null, focusNode: null as Element | null, anchorOffset: 0, focusOffset: 0,
    removeAllRanges: vi.fn(), addRange: vi.fn(() => { selection.anchorNode = selected ?? null; selection.focusNode = selected ?? null; selection.anchorOffset = 0; selection.focusOffset = selected?.textContent.length ?? 0; }),
    setBaseAndExtent: vi.fn((anchor: Element, start: number, focus: Element, end: number) => { selection.anchorNode = anchor; selection.anchorOffset = start; selection.focusNode = focus; selection.focusOffset = end; }) };
  const view = { navigator, getSelection: () => selection }; Object.assign(f.doc, { defaultView: view, createRange: () => range });
  return { range, selection, view, selected: () => selected };
};
const settleCopy = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

describe('complete connection history download', () => {
  it('defaults to file-local aliases, omits names and applied search text, and leaves source data unchanged', async () => {
    const filters = { search: 'Work' }; const value = { ...historyExport(), filters }; const before = JSON.stringify(value); const download = vi.fn();
    const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value);
    const f = mount(async () => ({ ...page(), filters }), page().scope, { filters, exportHistory, download }); await f.panel.whenLoaded();
    const mode = f.host.find('data-history-export-mode', 'privacy')!;
    expect(mode.value).toBe('aliases'); expect(f.host.text()).toContain('Preview export'); expect(f.host.text()).toContain('Review the file before sharing');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded();
    expect(exportHistory).toHaveBeenCalledExactlyOnceWith({ scope: page().scope, filters });
    expect(download).not.toHaveBeenCalled(); expect(f.host.find('data-history-preview', 'report')!.text()).not.toMatch(/work|Work|sheet|Sheets|script/); savePreview(f);
    const [filename, json] = download.mock.calls[0]!; const result = JSON.parse(json);
    expect(filename).toMatch(/^recued-connection-history-aliases-1970-01-01T.*\.json$/);
    expect(result).toMatchObject({ format: 'recued.connection-history.aliases', alias_scope: 'this_file', entry_count: 68,
      scope: { kind: 'connection', name: 'connection-1' }, filters: { search_applied: true } });
    expect(result.entries.every((e: { record: { group: { connection_names: string[] } } }) => e.record.group.connection_names[0] === result.scope.name)).toBe(true);
    expect(json).not.toMatch(/work|Work|sheet|Sheets|script|"search"|123456789abc|a{64}/);
    expect(JSON.stringify(value)).toBe(before); expect(f.panel.hasDraft()).toBe(false); f.panel.dispose();
  });
  it('pins privacy mode during a pending download and preserves the selected mode and focus on history refresh', async () => {
    let finish!: (value: AuthenticationHistoryExport) => void; const download = vi.fn();
    const f = mount(async () => page(), page().scope, { exportHistory: () => new Promise(resolve => { finish = resolve; }), download }); await f.panel.whenLoaded();
    const mode = f.host.find('data-history-export-mode', 'privacy')!; mode.value = 'full'; mode.fire('change');
    expect(f.host.text()).toContain('Keep these files for local use'); mode.focus!(); await f.panel.refresh();
    expect(f.host.find('data-history-export-mode', 'privacy')).toBe(mode); expect(f.doc.activeElement).toBe(mode); expect(mode.value).toBe('full');
    f.host.find('data-history-export', 'preview')!.click(); expect(mode.disabled).toBe(true);
    // A scripted change while disabled cannot change the captured download mode.
    mode.value = 'aliases'; mode.fire('change'); finish(historyExport()); await f.panel.whenLoaded(); savePreview(f);
    expect(JSON.parse(download.mock.calls[0]![1]).format).toBe('recued.connection-history'); expect(mode.value).toBe('full'); expect(mode.disabled).toBe(false);
    mode.value = 'aliases'; mode.fire('change'); expect(f.host.text()).not.toContain('Download requested'); expect(f.host.text()).toContain('Preview export'); f.panel.dispose();
    const next = mount(async () => page(), page().scope, { exportHistory: async () => historyExport(), download }); await next.panel.whenLoaded();
    expect(next.host.find('data-history-export-mode', 'privacy')!.value).toBe('aliases'); next.panel.dispose();
  });
  it('enforces the final byte cap without falling back to a named report; named export needs an explicit choice', async () => {
    const value = historyExport(page().scope, 100);
    for (const entry of value.entries) {
      if (!('group' in entry.record)) throw Error();
      entry.record.group.targets = Array.from({ length: 2048 }, () => ({ kind: 'connection', name: 'x' }));
    }
    expect(new TextEncoder().encode(prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'full').json).byteLength).toBeLessThan(AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES);
    expect(() => prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'aliases')).toThrow('History export is too large');
    const download = vi.fn(); const f = mount(async () => page(), page().scope, { exportHistory: async () => value, download }); await f.panel.whenLoaded();
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded();
    expect(download).not.toHaveBeenCalled(); expect(f.host.text()).toContain('Narrow the applied filters');
    const mode = f.host.find('data-history-export-mode', 'privacy')!; expect(mode.value).toBe('aliases'); expect(mode.disabled).toBe(false);
    mode.value = 'full'; mode.fire('change'); expect(f.host.text()).not.toContain('Narrow the applied filters');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); savePreview(f);
    expect(download).toHaveBeenCalledTimes(1); expect(JSON.parse(download.mock.calls[0]![1]).format).toBe('recued.connection-history'); f.panel.dispose();
  });
  it.each([downloadAuthenticationHistory, downloadAuthenticationHistoryText])('releases a temporary download URL when the browser refuses %s and reports a local download failure', save => {
    vi.useFakeTimers();
    try {
      const revokeObjectURL = vi.fn(); const remove = vi.fn();
      const doc = { defaultView: { URL: { createObjectURL: vi.fn(() => 'blob:local-export'), revokeObjectURL }, Blob }, body: { appendChild: vi.fn() },
        createElement: () => ({ click: () => { throw new Error('private-browser-marker'); }, remove }) };
      let caught: unknown;
      try { save(doc as unknown as Document, 'history.txt', '{}'); } catch (error) { caught = error; }
      expect(caught).toMatchObject({ code: 'download_unavailable' }); expect(String(caught)).not.toContain('private-browser-marker'); expect(remove).toHaveBeenCalledTimes(1);
      vi.runAllTimers(); expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:local-export');
    } finally { vi.useRealTimers(); }
  });
  it.each(['json', 'text'] as const)('downloads exact UTF-8 %s bytes with the right file type and releases its temporary anchor and URL', async kind => {
    vi.useFakeTimers();
    try {
      const raw = 'Saved observations 🚀\nÉcole <script>literal</script>', blobs: Blob[] = [], revokeObjectURL = vi.fn(), remove = vi.fn(), click = vi.fn();
      const anchor = { href: '', download: '', hidden: false, click, remove };
      const doc = { defaultView: { URL: { createObjectURL: vi.fn((blob: Blob) => { blobs.push(blob); return 'blob:local-summary'; }), revokeObjectURL }, Blob },
        body: { appendChild: vi.fn() }, createElement: () => anchor };
      const filename = kind === 'json' ? 'history.json' : 'summary.txt';
      (kind === 'json' ? downloadAuthenticationHistory : downloadAuthenticationHistoryText)(doc as unknown as Document, filename, raw);
      expect(blobs).toHaveLength(1); expect(blobs[0]!.type).toBe((kind === 'json' ? 'application/json' : 'text/plain') + ';charset=utf-8');
      expect(await blobs[0]!.text()).toBe(raw); expect(blobs[0]!.size).toBe(new TextEncoder().encode(raw).byteLength);
      expect(anchor).toMatchObject({ href: 'blob:local-summary', download: filename, hidden: true }); expect(click).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledOnce();
      expect(revokeObjectURL).not.toHaveBeenCalled(); vi.advanceTimersByTime(1000); expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:local-summary');
    } finally { vi.useRealTimers(); }
  });
  it('enforces the byte limit on the actual UTF-8 file, including a report exactly at the limit', () => {
    const incident = page().incidents[0]!;
    incident.group.uses = Array.from({ length: 5000 }, (_, n) => ({ kind: 'pack', id: 'use-' + n, label: n ? 'x' : 'é' }));
    const value: AuthenticationHistoryExport = { ...historyExport(page().scope, 0), entry_count: 1, entries: [{ type: 'incident', outcome: 'retired', record: incident }] };
    let missing = AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES - new TextEncoder().encode(JSON.stringify(authenticationHistoryExportReport(value))).byteLength;
    for (const use of incident.group.uses) { const add = Math.min(missing, 2048 - use.label.length); use.label += 'x'.repeat(add); missing -= add; }
    expect(missing).toBe(0);
    const prepared = prepareAuthenticationHistoryDownload(value, { scope: value.scope });
    expect(new TextEncoder().encode(prepared.json).byteLength).toBe(AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES);
    incident.group.uses.at(-1)!.label += 'x';
    expect(() => prepareAuthenticationHistoryDownload(value, { scope: value.scope })).toThrow('History export is too large');
  });
  it('does not replace history controls or disclosure state while preparing an export', async () => {
    let finish!: (value: AuthenticationHistoryExport) => void;
    const f = mount(async () => page(), page().scope, { exportHistory: () => new Promise(resolve => { finish = resolve; }), download: vi.fn() }); await f.panel.whenLoaded();
    const field = f.host.find('data-history-filter', 'search')!; const refresh = f.host.find('data-incident-action', 'refresh')!;
    f.host.find('data-history-export', 'preview')!.click(); expect(f.host.find('data-history-filter', 'search')).toBe(field); expect(f.host.find('data-incident-action', 'refresh')).toBe(refresh);
    finish(historyExport()); await f.panel.whenLoaded(); expect(f.host.find('data-history-filter', 'search')).toBe(field); expect(f.host.find('data-incident-action', 'refresh')).toBe(refresh); f.panel.dispose();
  });
  it('exports all matching retained rows with applied filters, independently of the loaded page and unapplied edits', async () => {
    const filters = { search: 'Work', type: 'incident' as const, outcome: 'retired' as const }; const value = { ...historyExport(), filters };
    Object.assign(value, { client_secret: 'private-marker' }); Object.assign(value.entries[0]!.record, { access_token: 'private-marker' });
    const call = vi.fn<AuthenticationIncidentHistoryCaller>(async () => ({ ...page(), filters, next_cursor: 'older' }));
    const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value); const download = vi.fn();
    const f = mount(call, page().scope, { filters, exportHistory, download }); await f.panel.whenLoaded();
    const mode = f.host.find('data-history-export-mode', 'privacy')!; mode.value = 'full'; mode.fire('change');
    expect(exportHistory).not.toHaveBeenCalled(); f.host.find('data-history-filter', 'search')!.value = 'unapplied'; f.host.find('data-history-filter', 'search')!.fire('input');
    const button = f.host.find('data-history-export', 'preview')!; button.focus!(); button.click(); await f.panel.whenLoaded();
    expect(exportHistory).toHaveBeenCalledExactlyOnceWith({ scope: page().scope, filters }); expect(call).toHaveBeenCalledTimes(1);
    expect(download).not.toHaveBeenCalled(); savePreview(f);
    expect(download).toHaveBeenCalledTimes(1); const [filename, json] = download.mock.calls[0]!;
    expect(filename).toMatch(/^recued-connection-history-1970-01-01T.*\.json$/); expect(JSON.parse(json).entries).toHaveLength(68);
    expect(json).not.toContain('private-marker'); expect(f.host.text()).toContain('Download requested: 68 matching retained entries');
    expect(f.host.find('data-history-filter', 'search')!.value).toBe('unapplied'); expect(f.doc.activeElement.textContent).toBe('History export preview');
    expect(f.panel.hasInFlightWork()).toBe(false); expect(f.panel.hasDraft()).toBe(false); f.panel.dispose();
  });
  it('starts only one pending export, keeps history usable and does not steal focus from another control', async () => {
    let finish!: (value: AuthenticationHistoryExport) => void;
    const exportHistory = vi.fn<AuthenticationHistoryExportCaller>(() => new Promise(resolve => { finish = resolve; })); const download = vi.fn();
    const f = mount(async () => page(), page().scope, { exportHistory, download }); await f.panel.whenLoaded();
    f.host.find('data-history-export', 'preview')!.click(); f.host.find('data-history-export', 'preview')!.fire('click');
    expect(exportHistory).toHaveBeenCalledTimes(1); expect(f.host.find('data-history-export', 'preview')!.disabled).toBe(true);
    const field = f.host.find('data-history-filter', 'search')!; field.value = 'draft'; field.fire('input'); field.focus!(); field.setSelectionRange(2, 2);
    finish(historyExport()); await f.panel.whenLoaded(); expect(download).not.toHaveBeenCalled(); savePreview(f); expect(download).toHaveBeenCalledTimes(1);
    expect(f.doc.activeElement).toBe(f.host.find('data-history-filter', 'search')); expect(f.doc.activeElement.selectionStart).toBe(2); f.panel.dispose();
  });
  it('discards an export reply after leaving the history view', async () => {
    let finish!: (value: AuthenticationHistoryExport) => void; const download = vi.fn();
    const f = mount(async () => page(), page().scope, { exportHistory: () => new Promise(resolve => { finish = resolve; }), download }); await f.panel.whenLoaded();
    f.host.find('data-history-export', 'preview')!.click(); f.panel.dispose(); finish(historyExport()); await f.panel.whenLoaded(); expect(download).not.toHaveBeenCalled();
  });
  it('discards a pending export after local filter changes even if the owner returns to the original selection', async () => {
    let finish!: (value: AuthenticationHistoryExport) => void; const download = vi.fn();
    const call = vi.fn<AuthenticationIncidentHistoryCaller>(async query => ({ ...page(), ...(query.filters ? { filters: query.filters } : {}) }));
    const f = mount(call, page().scope, { exportHistory: () => new Promise(resolve => { finish = resolve; }), download }); await f.panel.whenLoaded();
    f.host.find('data-history-export', 'preview')!.click(); const field = f.host.find('data-history-filter', 'search')!; field.value = 'Work'; field.fire('input');
    f.host.find('aria-label', 'Filter connection history')!.fire('submit'); await f.panel.refresh();
    f.host.find('data-history-filter-action', 'clear')!.click(); await f.panel.refresh();
    finish(historyExport()); await f.panel.whenLoaded(); expect(download).not.toHaveBeenCalled(); expect(call.mock.calls.map(([q]) => q.filters)).toEqual([undefined, { search: 'Work' }, undefined]); f.panel.dispose();
  });
  it.each(['older server', 'partial', 'wrong scope', 'wrong filters', 'duplicate', 'mismatched outcome'])(
    'does not download an unconfirmed report: %s', async issue => {
      const value = historyExport(); let reply: unknown = value;
      if (issue === 'older server') reply = page();
      if (issue === 'partial') Object.assign(value, { complete: false });
      if (issue === 'wrong scope') value.scope = { kind: 'all' };
      if (issue === 'wrong filters') value.filters = { search: 'Work' };
      if (issue === 'duplicate') value.entries[1] = value.entries[0]!;
      if (issue === 'mismatched outcome') value.entries[0]!.outcome = 'passed';
      const download = vi.fn(); const f = mount(async () => page(), page().scope, { exportHistory: async () => reply as AuthenticationHistoryExport, download });
      await f.panel.whenLoaded(); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded();
      expect(download).not.toHaveBeenCalled(); expect(f.host.text()).toContain('No partial report was prepared'); expect(f.host.find('data-history-export', 'preview')!.disabled).toBe(false); f.panel.dispose();
    });
  it('allows an empty complete report and safely handles export limits, unavailable downloads and retries', async () => {
    const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockRejectedValueOnce({ code: 'payload_too_large', message: 'private-marker' }).mockResolvedValue(historyExport(page().scope, 0));
    const download = vi.fn(); const f = mount(async () => page(), page().scope, { exportHistory, download }); await f.panel.whenLoaded();
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); expect(f.host.text()).toContain('Narrow the applied filters'); expect(f.host.text()).not.toContain('private-marker');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); savePreview(f); expect(download).toHaveBeenCalledTimes(1); expect(JSON.parse(download.mock.calls[0]![1]).entry_count).toBe(0); f.panel.dispose();
    const noBrowser = mount(async () => page(), page().scope, { exportHistory }); await noBrowser.panel.whenLoaded(); noBrowser.host.find('data-history-export', 'preview')!.click(); await noBrowser.panel.whenLoaded(); savePreview(noBrowser);
    expect(noBrowser.host.text()).toContain('This browser could not start the file download'); expect(noBrowser.host.text()).not.toContain('Download requested'); noBrowser.panel.dispose();
  });
  it('offers an explicit unavailable state without a caller and validates the selected filters at the download boundary', async () => {
    const f = mount(async () => page()); await f.panel.whenLoaded(); expect(f.host.find('data-history-export', 'preview')!.disabled).toBe(true); expect(f.host.text()).toContain('Complete history export is unavailable'); f.panel.dispose();
    expect(() => prepareAuthenticationHistoryDownload(historyExport(), { scope: { kind: 'all' } })).toThrow('Invalid history export');
  });
  it('pages a frozen snapshot and downloads its exact bytes after source changes and history refresh', async () => {
    const value = historyExport(); const expected = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'aliases');
    const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value); const download = vi.fn();
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page()); const f = mount(call, value.scope, { exportHistory, download }); await f.panel.whenLoaded();
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); expect(download).not.toHaveBeenCalled();
    const preview = f.host.find('data-history-preview', 'report')!; expect(preview.querySelectorAll('[data-history-preview-record]')).toHaveLength(20);
    const next = preview.find('data-history-preview-control', 'next')!; next.click(); next.focus!();
    expect(preview.text()).toContain('Records 21–40 of 68'); const save = preview.find('data-history-preview-control', 'download');
    value.entries.pop(); value.entry_count--; value.exported_at = 999;
    await f.panel.refresh(); expect(f.host.find('data-history-preview', 'report')).toBe(preview); expect(f.doc.activeElement).toBe(next);
    expect(preview.text()).toContain('Records 21–40 of 68'); expect(preview.find('data-history-preview-control', 'download')).toBe(save);
    savePreview(f); savePreview(f); expect(download.mock.calls).toEqual([[expected.filename, expected.json], [expected.filename, expected.json]]);
    expect(exportHistory).toHaveBeenCalledTimes(1); expect(call).toHaveBeenCalledTimes(2); f.panel.dispose();
  });
  it('freezes all prepared fields without freezing or retaining mutable server objects', () => {
    const value = historyExport(); const prepared = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'full');
    expect(Object.isFrozen(prepared)).toBe(true); expect(Object.isFrozen(prepared.report.entries[0]!.record)).toBe(true);
    if (!('group' in prepared.report.entries[0]!.record)) throw Error();
    expect(Object.isFrozen(prepared.report.entries[0]!.record.group.uses)).toBe(true);
    value.entries[0]!.record.started_at = 101; expect(prepared.report.entries[0]!.record.started_at).toBe(100);
    expect(JSON.stringify(prepared.report)).toBe(prepared.json); expect(prepared.bytes).toBe(new TextEncoder().encode(prepared.json).byteLength);
  });
  it.each(['aliases', 'full'] as const)('shows timeline event timestamps in UTC without changing the %s download', async mode => {
    const value = historyExport(page().scope, 1); const expected = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode); const download = vi.fn();
    const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = mode; privacy.fire('change');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded();
    const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle');
    const events = entry.find('data-history-preview-field', 'events')!; events.open = true; events.fire('toggle');
    expect(events.text()).toContain('1970-01-01T00:00:00.100Z'); expect(events.text()).toContain('1970-01-01T00:00:00.200Z');
    expect(events.text()).toContain('Event time (UTC)');
    expect(entry.text()).toContain('Problem reported in saved observation'); expect(entry.text()).not.toContain('Problem reported at capture');
    savePreview(f); expect(download).toHaveBeenCalledExactlyOnceWith(expected.filename, expected.json); f.panel.dispose();
  });
  it('invalidates old download controls on privacy changes, close and disposal', async () => {
    const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(historyExport()); const download = vi.fn();
    const f = mount(async () => page(), page().scope, { exportHistory, download }); await f.panel.whenLoaded();
    const mode = f.host.find('data-history-export-mode', 'privacy')!; mode.value = 'full'; mode.fire('change');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded();
    const oldSave = f.host.find('data-history-preview-control', 'download')!;
    mode.value = 'aliases'; mode.fire('change'); oldSave.click(); expect(download).not.toHaveBeenCalled(); expect(f.host.find('data-history-preview', 'report')!.hidden).toBe(true);
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); const privateSave = f.host.find('data-history-preview-control', 'download')!;
    f.host.find('data-history-preview-control', 'close')!.click(); privateSave.click(); expect(download).not.toHaveBeenCalled();
    expect(f.doc.activeElement).toBe(f.host.find('data-history-export', 'preview')); expect(f.panel.hasDraft()).toBe(false);
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); const lastSave = f.host.find('data-history-preview-control', 'download')!;
    f.panel.dispose(); lastSave.click(); expect(download).not.toHaveBeenCalled(); expect(exportHistory).toHaveBeenCalledTimes(3);
  });
  it('clears the previous snapshot before a failed rebuild and retries downloads without requesting another snapshot', async () => {
    const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValueOnce(historyExport()).mockRejectedValueOnce(new Error('private-marker')).mockResolvedValue(historyExport());
    const download = vi.fn().mockImplementationOnce(() => { throw Error('private-marker'); }); const f = mount(async () => page(), page().scope, { exportHistory, download }); await f.panel.whenLoaded();
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); const oldSave = f.host.find('data-history-preview-control', 'download')!;
    f.host.find('data-history-export', 'preview')!.click(); oldSave.click(); await f.panel.whenLoaded(); expect(download).not.toHaveBeenCalled();
    expect(f.host.find('data-history-preview', 'report')!.hidden).toBe(true); expect(f.host.text()).not.toContain('private-marker');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); savePreview(f);
    expect(f.host.text()).toContain('This preview is still available'); expect(f.host.text()).not.toContain('private-marker');
    savePreview(f); expect(download).toHaveBeenCalledTimes(2); expect(download.mock.calls[0]).toEqual(download.mock.calls[1]); expect(exportHistory).toHaveBeenCalledTimes(3); f.panel.dispose();
  });
  it('lazily pages nested details and displays every allowed field without raw provider or credential data', async () => {
    const value = historyExport(page().scope, 1); const record = value.entries[0]!.record; if (!('group' in record)) throw Error();
    record.group.uses = Array.from({ length: 45 }, (_, n) => ({ kind: 'pack', id: 'pack-' + n, label: '<script>Pack ' + n + '</script>' }));
    Object.assign(record, { access_token: 'private-marker', raw_error: 'private-marker' });
    const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download: vi.fn() }); await f.panel.whenLoaded();
    const mode = f.host.find('data-history-export-mode', 'privacy')!; mode.value = 'full'; mode.fire('change');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); const preview = f.host.find('data-history-preview', 'report')!;
    expect(preview.find('data-history-preview-field', 'group')).toBeUndefined(); const entry = preview.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle');
    const group = entry.find('data-history-preview-field', 'group')!; group.open = true; group.fire('toggle'); const uses = group.find('data-history-preview-field', 'uses')!;
    uses.open = true; uses.fire('toggle'); expect(uses.text()).toContain('Items 1–20 of 45'); expect(uses.text()).not.toContain('<script>Pack 20');
    uses.find('data-history-preview-control', 'array-next')!.click(); expect(uses.text()).toContain('Items 21–40 of 45');
    uses.find('data-history-preview-control', 'array-next')!.click(); expect(uses.text()).toContain('<script>Pack 44</script>'); expect(uses.text()).toContain('Items 41–45 of 45');
    uses.find('data-history-preview-control', 'array-previous')!.click(); expect(uses.text()).toContain('Items 21–40 of 45'); expect(preview.text()).not.toContain('private-marker'); f.panel.dispose();
  });
  it.each(['aliases', 'full'] as const)('searches every %s snapshot record while preserving drafts, refreshed state and exact download bytes', async mode => {
    const value = historyExport(); const expected = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode); const download = vi.fn();
    const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value); const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page());
    const f = mount(call, value.scope, { exportHistory, download }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = mode; privacy.fire('change');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded();
    const input = f.host.find('data-history-preview-search', 'query')!; input.value = '  ' + expected.report.entries[53]!.record.id.toUpperCase() + '  '; input.fire('input'); input.focus!();
    expect(f.host.find('data-history-preview', 'report')!.querySelectorAll('[data-history-preview-record]')).toHaveLength(20);
    f.host.find('data-history-preview-search', 'form')!.fire('submit');
    expect(f.host.text()).toContain('Matching records 1–1 of 1 (68 in snapshot)'); expect(f.host.find('data-history-preview-record', '53')).toBeDefined();
    const applied = f.host.find('data-history-preview-search', 'applied')!; expect(applied.textContent).toContain(expected.report.entries[53]!.record.id.toUpperCase());
    expect(f.host.text()).toContain('Download this preview (JSON) includes all 68 snapshot records'); expect(f.host.text()).toContain('Record and related-history downloads use their stated contents'); expect(f.doc.activeElement).toBe(input);
    input.value = 'not applied'; input.fire('input'); await f.panel.refresh();
    expect(f.host.find('data-history-preview-search', 'query')).toBe(input); expect(input.value).toBe('not applied'); expect(f.doc.activeElement).toBe(input);
    expect(applied.textContent).toContain(expected.report.entries[53]!.record.id.toUpperCase()); expect(applied.textContent).not.toContain('not applied');
    expect(f.host.find('data-history-preview-record', '53')).toBeDefined(); savePreview(f);
    searchPreview(f, 'no matching saved value'); expect(f.host.text()).toContain('No records match this preview search');
    expect(f.host.find('data-history-preview', 'report')!.querySelectorAll('[data-history-preview-record]')).toHaveLength(0);
    expect(f.host.find('data-history-preview-control', 'next')!.disabled).toBe(true); savePreview(f);
    f.host.find('data-history-preview-control', 'search-clear')!.click(); expect(input.value).toBe(''); expect(f.doc.activeElement).toBe(input);
    expect(applied.hidden).toBe(true); expect(applied.textContent).toBe('');
    expect(f.host.text()).toContain('Records 1–20 of 68'); expect(f.panel.hasDraft()).toBe(false); expect(f.panel.hasInFlightWork()).toBe(false);
    expect(download.mock.calls).toEqual([[expected.filename, expected.json], [expected.filename, expected.json]]);
    expect(exportHistory).toHaveBeenCalledTimes(1); expect(call).toHaveBeenCalledTimes(2); f.panel.dispose();
  });
  it('matches literal Unicode text inside unopened nested pages using only the captured values', async () => {
    const value = historyExport(page().scope, 2); const record = value.entries[1]!.record; if (!('group' in record)) throw Error();
    record.group = { ...record.group, uses: Array.from({ length: 45 }, (_, n) => ({ kind: 'pack', id: 'pack-' + n,
      label: n === 44 ? 'Café [100%_].* "report" \\ 44' : 'Other ' + n })) };
    const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download: vi.fn() }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); record.group.uses[44]!.label = 'Later source value';
    expect(f.host.find('data-history-preview-field', 'group')).toBeUndefined();
    searchPreview(f, 'CAFE\u0301 [100%_].* "report" \\ 44');
    expect(f.host.text()).toContain('Matching records 1–1 of 1 (2 in snapshot)'); expect(f.host.find('data-history-preview-record', '1')).toBeDefined();
    searchPreview(f, 'Later source value'); expect(f.host.text()).toContain('No records match this preview search');
    searchPreview(f, '.*'); expect(f.host.text()).toContain('Matching records 1–1 of 1 (2 in snapshot)');
    searchPreview(f, '.*missing'); expect(f.host.text()).toContain('No records match this preview search');
    searchPreview(f, '1970-01-01T00:00:00.200Z'); expect(f.host.text()).toContain('Matching records 1–2 of 2 (2 in snapshot)'); f.panel.dispose();
  });
  it.each(['aliases', 'full'] as const)('searches saved export type codes and displayed wording in %s mode without changing the file', async mode => {
    const check: AuthenticationAccessVerification = { id: 'verify-12345678-1234-4123-8123-123456789abc', selection: { kind: 'group', id: 'a'.repeat(64) },
      status: 'completed', started_at: 130, finished_at: 140, targets_truncated: false, usage_available: true, uses: [],
      results: [{ id: '3'.repeat(64), label: 'Work API', target: { kind: 'connection', name: 'work' }, authentication_revision: '4'.repeat(64), current: 'yes', checks: [{ kind: 'api_read', status: 'passed' }] }] };
    const value = historyExport(page().scope, 1); value.entries.unshift({ type: 'verification', outcome: 'passed', record: check }); value.entry_count = 2;
    const expected = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode); const download = vi.fn();
    const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value);
    const f = mount(async () => page(), value.scope, { exportHistory, download }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = mode; privacy.fire('change');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded();
    for (const [query, index] of [['verification', '0'], ['Access check', '0'], ['passed', '0'], ['Recorded check passed', '0'],
      ['incident', '1'], ['retired', '1'], ['Closed without confirmed recovery', '1']] as const) {
      searchPreview(f, query);
      expect(f.host.find('data-history-preview', 'report')!.querySelectorAll('[data-history-preview-record]').map(row => row.getAttribute('data-history-preview-record')), query).toEqual([index]);
      if (query === 'verification' || query === 'passed') {
        const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle'); const path = [query === 'verification' ? 'type' : 'outcome'];
        const view = entry.find('data-history-preview-match-path', JSON.stringify(path))!; view.click();
        const target = entry.find('data-history-preview-path', JSON.stringify(path))!; expect(f.doc.activeElement).toBe(target);
        expect(literalText(target)).toContain(query === 'verification' ? 'Access check (verification)' : 'Recorded check passed (passed)');
        entry.find('data-history-preview-control', 'return-matches')!.click(); expect(f.doc.activeElement).toBe(view);
      }
    }
    savePreview(f); expect(download).toHaveBeenCalledExactlyOnceWith(expected.filename, expected.json); expect(exportHistory).toHaveBeenCalledTimes(1); f.panel.dispose();
  });
  it.each(['aliases', 'full'] as const)('searches recorded codes and visible labels without indexing private source fields in %s mode', async mode => {
    const value = historyExport(page().scope, 1); const record = value.entries[0]!.record; if (!('group' in record)) throw Error();
    record.group = { ...record.group, issues: [{ id: '9'.repeat(64), code: 'credential_rejected', message: 'raw-provider-private-marker' }] };
    Object.assign(record, { access_token: 'credential-private' });
    const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download: vi.fn() }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = mode; privacy.fire('change');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded();
    for (const query of ['credential_rejected', 'Credential rejected', 'Closed without confirmed recovery', 'authentication_changed', 'Authentication changed']) {
      searchPreview(f, query); expect(f.host.text()).toContain('Matching records 1–1 of 1 (1 in snapshot)');
    }
    for (const query of ['raw-provider-private-marker', 'credential-private']) {
      searchPreview(f, query); expect(f.host.text()).toContain('No records match this preview search');
    }
    searchPreview(f, 'Work'); expect(f.host.text()).toContain(mode === 'full' ? 'Matching records 1–1 of 1 (1 in snapshot)' : 'No records match this preview search');
    f.panel.dispose();
  });
  it('retains the last matching view after an oversized search and makes old search controls inert after clearing or replacing a snapshot', async () => {
    const value = historyExport(); const download = vi.fn();
    const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download }); await f.panel.whenLoaded();
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'incident-54');
    const input = f.host.find('data-history-preview-search', 'query')!; const form = f.host.find('data-history-preview-search', 'form')!;
    const clear = f.host.find('data-history-preview-control', 'search-clear')!;
    searchPreview(f, 'x'.repeat(129)); expect(f.host.text()).toContain('Use 128 characters or fewer'); expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(f.host.find('data-history-preview-record', '53')).toBeDefined(); savePreview(f); expect(JSON.parse(download.mock.calls[0]![1]).entry_count).toBe(68);
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change');
    input.value = 'changed old query'; form.fire('submit'); clear.click(); expect(f.host.find('data-history-preview', 'report')!.hidden).toBe(true);
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, value.entries[60]!.record.id);
    form.fire('submit'); clear.click(); expect(f.host.find('data-history-preview-record', '60')).toBeDefined();
    const currentForm = f.host.find('data-history-preview-search', 'form')!; f.panel.dispose(); currentForm.fire('submit');
    expect(download).toHaveBeenCalledTimes(1);
  });
  it.each(['aliases', 'full'] as const)('opens the matching field on a late nested page in %s mode and keeps its captured value through refresh', async mode => {
    const value = historyExport(page().scope, 1); const record = value.entries[0]!.record; if (!('group' in record)) throw Error();
    record.group = { ...record.group, uses: Array.from({ length: 45 }, (_, index) => ({ kind: 'pack', id: 'pack-' + index,
      label: index === 44 ? 'Café [100%_].* target' : 'Other pack ' + index })) };
    const expected = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode); const saved = expected.report.entries[0]!.record;
    if (!('group' in saved)) throw Error(); const query = mode === 'aliases' ? saved.group.uses[44]!.id : 'CAFE\u0301 [100%_].* target';
    const path = ['record', 'group', 'uses', 44, mode === 'aliases' ? 'id' : 'label']; const download = vi.fn();
    const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value); const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page());
    const f = mount(call, value.scope, { exportHistory, download }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = mode; privacy.fire('change');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); record.group.uses[44]!.label = 'Later source value';
    searchPreview(f, query); const entry = f.host.find('data-history-preview-record', '0')!;
    expect(entry.text()).toContain('1 matching field'); expect(entry.text()).toContain('Group › Uses › Item 45');
    expect(entry.find('data-history-preview-field', 'group')).toBeUndefined(); entry.open = true; entry.fire('toggle');
    const view = entry.find('data-history-preview-match-path', JSON.stringify(path))!; expect(view).toBeDefined();
    expect(entry.find('data-history-preview-field', 'uses')).toBeUndefined(); view.click();
    const group = entry.find('data-history-preview-field', 'group')!; const uses = entry.find('data-history-preview-field', 'uses')!;
    expect(group.open).toBe(true); expect(uses.open).toBe(true); expect(uses.text()).toContain('Items 41–45 of 45');
    const target = entry.find('data-history-preview-path', JSON.stringify(path))!; expect(f.doc.activeElement).toBe(target);
    expect(target.getAttribute('data-history-preview-match-target')).toBe('true'); expect(target.getAttribute('aria-label')).toContain('Group › Uses › Item 45');
    expect(target.text()).toContain(mode === 'aliases' ? saved.group.uses[44]!.id : 'Café [100%_].* target');
    expect(entry.find('data-history-preview-path', JSON.stringify(['record', 'group', 'uses', 0, 'id']))).toBeUndefined();
    group.fire('toggle'); uses.fire('toggle'); expect(uses.text()).toContain('Items 41–45 of 45');
    await f.panel.refresh(); expect(f.doc.activeElement).toBe(target); expect(f.host.find('data-history-preview-path', JSON.stringify(path))).toBe(target);
    uses.find('data-history-preview-control', 'array-previous')!.click(); expect(uses.text()).toContain('Items 21–40 of 45'); view.click();
    expect(uses.text()).toContain('Items 41–45 of 45'); expect(f.doc.activeElement).not.toBe(target);
    expect(f.doc.activeElement.getAttribute('data-history-preview-path')).toBe(JSON.stringify(path)); expect(target.getAttribute('data-history-preview-match-target')).toBe('false');
    expect(entry.text()).not.toContain('Later source value'); if (mode === 'aliases') expect(entry.find('data-history-preview-matches', 'fields')!.text()).not.toMatch(/Café|Other pack|Later source|Work/);
    savePreview(f); expect(download).toHaveBeenCalledExactlyOnceWith(expected.filename, expected.json); expect(exportHistory).toHaveBeenCalledTimes(1); expect(call).toHaveBeenCalledTimes(2); f.panel.dispose();
  });
  it('counts a field once when its name and repeated values match, and moves the selection between fields', async () => {
    const value = historyExport(page().scope, 1); const record = value.entries[0]!.record; if (!('group' in record)) throw Error();
    record.group = { ...record.group, label: 'Label label LABEL', uses: [{ kind: 'pack', id: 'sheet', label: 'Sheets' }] };
    const expected = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'full'); const download = vi.fn();
    const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value);
    const f = mount(async () => page(), value.scope, { exportHistory, download }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'label');
    const entry = f.host.find('data-history-preview-record', '0')!; expect(entry.text()).toContain('2 matching fields'); entry.open = true; entry.fire('toggle');
    const matches = entry.find('data-history-preview-matches', 'fields')!; expect(matches.querySelectorAll('[data-history-preview-match-path]')).toHaveLength(2);
    expect(matches.text()).toMatch(/Group ›\s+Label\s+· Field name and value/); expect(matches.text()).toMatch(/Group › Uses › Item 1 ›\s+Label\s+· Field name/);
    expect(matches.querySelectorAll('[data-history-preview-highlight="match"]').map(mark => mark.textContent)).toEqual(['Label', 'Label', 'label', 'LABEL', 'Label']);
    const firstPath = ['record', 'group', 'label']; const secondPath = ['record', 'group', 'uses', 0, 'label'];
    entry.find('data-history-preview-match-path', JSON.stringify(firstPath))!.click(); const first = f.doc.activeElement;
    expect(first.querySelectorAll('[data-history-preview-value-highlight="display"]').map(mark => mark.textContent)).toEqual(['Label', 'label', 'LABEL']);
    entry.find('data-history-preview-match-path', JSON.stringify(secondPath))!.click();
    expect(first.getAttribute('data-history-preview-match-target')).toBe('false'); expect(f.doc.activeElement).toBe(entry.find('data-history-preview-path', JSON.stringify(secondPath)));
    expect(literalText(first)).toBe('Label label LABEL'); expect(first.querySelectorAll('[data-history-preview-value-highlight]')).toHaveLength(0);
    expect(f.doc.activeElement.querySelectorAll('[data-history-preview-value-highlight]')).toHaveLength(0);
    expect(f.host.find('data-history-preview-hits', 'navigation')).toBeUndefined();
    expect(f.host.find('data-history-preview-saved-value', 'literal')).toBeUndefined(); expect(f.host.text()).toContain('The field name matches this search.');
    expect(entry.querySelectorAll('[data-history-preview-match-target="true"]')).toHaveLength(1);
    expect(matches.text()).toContain('Matching fields 1–2 of 2'); savePreview(f);
    expect(download).toHaveBeenCalledExactlyOnceWith(expected.filename, expected.json); expect(exportHistory).toHaveBeenCalledTimes(1); f.panel.dispose();
  });
  it.each(['aliases', 'full'] as const)('returns from a late saved field to its original button and preserves refresh, query and nested pages in %s mode', async mode => {
    const value = historyExport(page().scope, 1); const record = value.entries[0]!.record; if (!('group' in record)) throw Error();
    record.group = { ...record.group, uses: Array.from({ length: 45 }, (_, index) => ({ kind: 'pack', id: 'pack-' + index, label: 'Pack ' + index })) };
    const expected = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode); const saved = expected.report.entries[0]!.record; if (!('group' in saved)) throw Error();
    const query = mode === 'aliases' ? saved.group.uses[44]!.id : 'Pack 44'; const path = ['record', 'group', 'uses', 44, mode === 'aliases' ? 'id' : 'label'];
    const download = vi.fn(); const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value); const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page());
    const f = mount(call, value.scope, { exportHistory, download }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = mode; privacy.fire('change');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, query);
    const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle');
    expect(entry.find('data-history-preview-control', 'return-matches')).toBeUndefined();
    const view = entry.find('data-history-preview-match-path', JSON.stringify(path))!; view.click();
    const target = entry.find('data-history-preview-path', JSON.stringify(path))!; const back = entry.find('data-history-preview-control', 'return-matches')!;
    const mark = target.find('data-history-preview-value-highlight', 'display')!; expect(mark.textContent).toBe(mode === 'aliases' ? saved.group.uses[44]!.id : 'Pack 44');
    expect(target.contains(back)).toBe(true); expect(back.getAttribute('aria-label')).toContain('Item 45'); expect(target.getAttribute('aria-label')).not.toContain('Return to matching fields');
    const input = f.host.find('data-history-preview-search', 'query')!; input.value = 'Unapplied draft'; back.focus!(); await f.panel.refresh();
    expect(f.doc.activeElement).toBe(back); expect(entry.find('data-history-preview-control', 'return-matches')).toBe(back); back.click();
    expect(target.find('data-history-preview-value-highlight', 'display')).toBe(mark);
    expect(f.doc.activeElement).toBe(view); expect(input.value).toBe('Unapplied draft'); expect(entry.text()).toContain('Matching fields 1–1 of 1');
    expect(entry.find('data-history-preview-field', 'uses')!.text()).toContain('Items 41–45 of 45'); expect(target.getAttribute('data-history-preview-match-target')).toBe('true');
    expect(f.host.text()).toContain('Returned to matching fields: Group');
    if (mode === 'aliases') expect(back.getAttribute('aria-label')).not.toMatch(/Pack|Work|pack-44/);
    savePreview(f); expect(download).toHaveBeenCalledExactlyOnceWith(expected.filename, expected.json); expect(exportHistory).toHaveBeenCalledTimes(1); expect(call).toHaveBeenCalledTimes(2); f.panel.dispose();
  });
  it('restores the originating match page and focuses a fresh button without changing the nested field page', async () => {
    const value = historyExport(page().scope, 1); const record = value.entries[0]!.record; if (!('group' in record)) throw Error();
    record.group = { ...record.group, uses: Array.from({ length: 45 }, (_, index) => ({ kind: 'pack', id: 'pack-' + index, label: 'Pack ' + index })) };
    const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download: vi.fn() }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'Label');
    const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle');
    const next = entry.find('data-history-preview-control', 'matches-next')!; while (!next.disabled) next.click();
    const path = ['record', 'group', 'uses', 44, 'label']; const original = entry.find('data-history-preview-match-path', JSON.stringify(path))!; original.click();
    const back = entry.find('data-history-preview-control', 'return-matches')!; const target = entry.find('data-history-preview-path', JSON.stringify(path))!;
    entry.find('data-history-preview-control', 'matches-previous')!.click(); expect(entry.text()).toContain('Matching fields 41–45 of 46'); back.click();
    const restored = entry.find('data-history-preview-match-path', JSON.stringify(path))!; expect(restored).not.toBe(original); expect(f.doc.activeElement).toBe(restored);
    expect(entry.text()).toContain('Matching fields 46–46 of 46'); expect(entry.find('data-history-preview-field', 'uses')!.text()).toContain('Items 41–45 of 45');
    expect(entry.find('data-history-preview-path', JSON.stringify(path))).toBe(target); original.click(); expect(f.doc.activeElement).toBe(restored);
    entry.find('data-history-preview-field', 'uses')!.find('data-history-preview-control', 'array-previous')!.click();
    expect(entry.find('data-history-preview-control', 'return-matches')).toBeUndefined(); const focused = f.doc.activeElement; back.click(); expect(f.doc.activeElement).toBe(focused); f.panel.dispose();
  });
  it.each([
    ['array', 'return', 'programmatic'], ['array', 'field', 'programmatic'], ['array', 'draft', 'programmatic'],
    ['records', 'return', 'programmatic'], ['records', 'field', 'programmatic'], ['records', 'draft', 'programmatic'],
    ['array', 'return', 'pointer'], ['array', 'field', 'pointer'], ['array', 'draft', 'pointer'],
    ['records', 'return', 'pointer'], ['records', 'field', 'pointer'], ['records', 'draft', 'pointer'],
  ] as const)('keeps focus in context during %s paging from %s focus with %s activation', async (paging, focus, activation) => {
    const value = historyExport(page().scope, 25); const record = value.entries[0]!.record; if (!('group' in record)) throw Error();
    record.group = { ...record.group, uses: Array.from({ length: 45 }, (_, index) => ({ kind: 'pack', id: 'pack-' + index, label: 'Pack ' + index })) };
    const expected = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'full'); const download = vi.fn();
    const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value);
    const f = mount(async () => page(), value.scope, { exportHistory, download }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'Label');
    const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle');
    const path = JSON.stringify(['record', 'group', 'uses', 0, 'label']); entry.find('data-history-preview-match-path', path)!.click();
    const back = entry.find('data-history-preview-control', 'return-matches')!; const target = entry.find('data-history-preview-path', path)!;
    const input = f.host.find('data-history-preview-search', 'query')!; input.value = 'Unapplied draft';
    (focus === 'return' ? back : focus === 'field' ? target : input).focus!();
    const uses = entry.find('data-history-preview-field', 'uses')!;
    const range = paging === 'array' ? uses.children.find(child => child.getAttribute('role') === 'status')! : f.host.find('data-history-preview-range', 'records')!;
    const pager = paging === 'array' ? uses.find('data-history-preview-control', 'array-next')! : f.host.find('data-history-preview-control', 'next')!;
    if (activation === 'pointer') {
      if (focus === 'draft') back.focus!(); pager.fire('pointerdown');
      if (focus === 'draft') input.focus!(); else f.doc.activeElement = f.doc.body;
      pager.fire('click', 1);
    } else pager.click();
    expect(f.doc.activeElement === (focus === 'draft' ? input : range)).toBe(true); expect(input.value).toBe('Unapplied draft');
    expect(f.host.find('data-history-preview-control', 'return-matches')).toBeUndefined(); const current = f.doc.activeElement; back.click(); expect(f.doc.activeElement).toBe(current);
    savePreview(f); expect(download).toHaveBeenCalledExactlyOnceWith(expected.filename, expected.json); expect(exportHistory).toHaveBeenCalledTimes(1); f.panel.dispose();
  });
  it('keeps one return control across records and ignores the replaced control', async () => {
    const value = historyExport(page().scope, 2); const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download: vi.fn() }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'Label');
    const path = JSON.stringify(['record', 'group', 'label']); const first = f.host.find('data-history-preview-record', '0')!; first.open = true; first.fire('toggle'); first.find('data-history-preview-match-path', path)!.click();
    const old = first.find('data-history-preview-control', 'return-matches')!; const second = f.host.find('data-history-preview-record', '1')!; second.open = true; second.fire('toggle');
    const view = second.find('data-history-preview-match-path', path)!; view.click(); const focused = f.doc.activeElement;
    expect(f.host.querySelectorAll('[data-history-preview-control="return-matches"]')).toHaveLength(1); expect(first.find('data-history-preview-control', 'return-matches')).toBeUndefined();
    old.click(); expect(f.doc.activeElement).toBe(focused); second.find('data-history-preview-control', 'return-matches')!.click(); expect(f.doc.activeElement).toBe(view); f.panel.dispose();
  });
  it.each(['query', 'privacy', 'close', 'new snapshot', 'record page', 'dispose'] as const)('makes the return control inert after %s changes the selected view', async phase => {
    const value = historyExport(); const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value); const download = vi.fn();
    const f = mount(async () => page(), value.scope, { exportHistory, download }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'Label');
    const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle');
    entry.find('data-history-preview-match-path', JSON.stringify(['record', 'group', 'label']))!.click(); const back = entry.find('data-history-preview-control', 'return-matches')!;
    if (phase === 'query') searchPreview(f, 'retired');
    else if (phase === 'privacy') { privacy.value = 'aliases'; privacy.fire('change'); }
    else if (phase === 'close') f.host.find('data-history-preview-control', 'close')!.click();
    else if (phase === 'new snapshot') { f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); }
    else if (phase === 'record page') f.host.find('data-history-preview-control', 'next')!.click();
    else f.panel.dispose();
    const focused = f.doc.activeElement; const calls = exportHistory.mock.calls.length; back.fire('click');
    expect(f.doc.activeElement).toBe(focused); expect(exportHistory).toHaveBeenCalledTimes(calls); expect(download).not.toHaveBeenCalled();
    expect(f.host.find('data-history-preview-control', 'return-matches')).toBeUndefined(); f.panel.dispose();
  });
  it.each(['aliases', 'full'] as const)('opens the same saved scalar for raw and readable timestamp, boolean and reason searches in %s mode', async mode => {
    const value = historyExport(page().scope, 1); const expected = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode); const download = vi.fn();
    const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value);
    const f = mount(async () => page(), value.scope, { exportHistory, download }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = mode; privacy.fire('change');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded();
    for (const [query, key, rendered] of [['150', 'last_problem_at', '1970-01-01T00:00:00.150Z'], ['1970-01-01T00:00:00.150Z', 'last_problem_at', '1970-01-01T00:00:00.150Z'],
      ['false', 'currently_reported', 'No'], ['No', 'currently_reported', 'No'], ['authentication_changed', 'retirement_reason', 'Authentication changed'], ['Authentication changed', 'retirement_reason', 'Authentication changed']] as const) {
      searchPreview(f, query); const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle');
      const path = ['record', key]; const view = entry.find('data-history-preview-match-path', JSON.stringify(path)); expect(view, query).toBeDefined(); view!.click();
      expect(f.doc.activeElement).toBe(entry.find('data-history-preview-path', JSON.stringify(path))); expect(literalText(f.doc.activeElement)).toContain(rendered);
      expect(f.host.find('data-history-preview-search', 'query')!.value).toBe(query);
    }
    savePreview(f); expect(download).toHaveBeenCalledExactlyOnceWith(expected.filename, expected.json); expect(exportHistory).toHaveBeenCalledTimes(1); f.panel.dispose();
  });
  it('pages matching fields without mounting all hits and opens the last hit while keeping its match page', async () => {
    const value = historyExport(page().scope, 1); const record = value.entries[0]!.record; if (!('group' in record)) throw Error();
    record.group = { ...record.group, uses: Array.from({ length: 45 }, (_, index) => ({ kind: 'pack', id: 'pack-' + index, label: 'Pack ' + index })) };
    const download = vi.fn(); const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'label');
    const entry = f.host.find('data-history-preview-record', '0')!; expect(entry.text()).toContain('46 matching fields'); entry.open = true; entry.fire('toggle');
    expect(entry.querySelectorAll('[data-history-preview-match-path]')).toHaveLength(5); expect(entry.text()).toContain('Matching fields 1–5 of 46');
    const oldView = entry.find('data-history-preview-control', 'match-field')!; const next = entry.find('data-history-preview-control', 'matches-next')!;
    while (!next.disabled) { next.focus!(); next.click(); }
    expect(entry.querySelectorAll('[data-history-preview-match-path]')).toHaveLength(1); expect(entry.text()).toContain('Matching fields 46–46 of 46');
    expect(f.doc.activeElement).toBe(entry.find('data-history-preview-match-range', 'fields')); next.fire('click'); expect(entry.text()).toContain('Matching fields 46–46 of 46');
    oldView.click(); expect(entry.find('data-history-preview-match-target', 'true')).toBeUndefined();
    const path = ['record', 'group', 'uses', 44, 'label']; entry.find('data-history-preview-match-path', JSON.stringify(path))!.click();
    expect(f.doc.activeElement).toBe(entry.find('data-history-preview-path', JSON.stringify(path))); expect(entry.text()).toContain('Matching fields 46–46 of 46');
    await f.panel.refresh(); expect(entry.text()).toContain('Matching fields 46–46 of 46');
    savePreview(f); expect(JSON.parse(download.mock.calls[0]![1]).entry_count).toBe(1); f.panel.dispose();
  });
  it.each([
    ['İ\u0f73', 'İ\u0f73', 'Unrelated'],
    ['¨', '¨', 'q\u0308'],
  ] as const)('keeps the applied raw query %s aligned with matching-field counts and highlights', async (query, label, otherLabel) => {
    const value = historyExport(page().scope, 1); const record = value.entries[0]!.record; if (!('group' in record)) throw Error();
    record.group = { ...record.group, label, uses: [{ kind: 'pack', id: 'sheet', label: otherLabel }] };
    const expected = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'full'); const download = vi.fn();
    const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, query);
    const entry = f.host.find('data-history-preview-record', '0')!; expect(entry.text()).toContain('1 matching field'); entry.open = true; entry.fire('toggle');
    const matches = entry.find('data-history-preview-matches', 'fields')!;
    expect(matches.querySelectorAll('[data-history-preview-match-path]')).toHaveLength(1);
    expect(matches.querySelectorAll('[data-history-preview-highlight="match"]').map(mark => mark.textContent)).toEqual([label]);
    const path = ['record', 'group', 'label']; matches.find('data-history-preview-match-path', JSON.stringify(path))!.click();
    expect(f.doc.activeElement).toBe(entry.find('data-history-preview-path', JSON.stringify(path))); expect(f.doc.activeElement.text()).toContain(label);
    const draft = f.host.find('data-history-preview-search', 'query')!; draft.value = 'Unapplied'; await f.panel.refresh();
    expect(entry.text()).toContain('1 matching field'); expect(draft.value).toBe('Unapplied');
    savePreview(f); expect(download).toHaveBeenCalledExactlyOnceWith(expected.filename, expected.json); f.panel.dispose();
  });
  it('centers Unicode value previews on the highlighted match and shows the complete literal value at the chosen field', async () => {
    const value = historyExport(page().scope, 1); const record = value.entries[0]!.record; if (!('group' in record)) throw Error();
    const label = '🚀'.repeat(190) + '<img src="/unused" onerror="bad()"> tail-needle'; record.group = { ...record.group, label };
    const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download: vi.fn() }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'tail-needle');
    const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle');
    const matches = entry.find('data-history-preview-matches', 'fields')!;
    expect(matches.text()).not.toContain('🚀'.repeat(180)); expect(matches.text()).not.toContain('\ufffd'); expect(matches.text()).toContain('tail-needle');
    expect(matches.querySelectorAll('[data-history-preview-highlight="match"]').map(mark => mark.textContent)).toEqual(['tail-needle']);
    entry.find('data-history-preview-match-path', JSON.stringify(['record', 'group', 'label']))!.click();
    expect(literalText(f.doc.activeElement)).toContain(label); expect(f.doc.activeElement.getAttribute('data-history-preview-match-target')).toBe('true'); f.panel.dispose();
  });
  it('highlights every hit in the complete chosen value and preserves the literal snapshot through return and refresh', async () => {
    const value = historyExport(page().scope, 1); const record = value.entries[0]!.record; if (!('group' in record)) throw Error();
    const label = 'prefix '.repeat(140) + '<img src="/unused" onerror="bad()"> NeedLe middle NEEDLE ' + 'suffix '.repeat(90);
    record.group = { ...record.group, label, uses: [{ kind: 'pack', id: 'sheet', label: 'Other needle' }] };
    const expected = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'full'); const before = JSON.stringify(value); const download = vi.fn();
    const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value); const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page());
    const f = mount(call, value.scope, { exportHistory, download }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'needle');
    const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle');
    const path = JSON.stringify(['record', 'group', 'label']); const view = entry.find('data-history-preview-match-path', path)!; view.click();
    const target = f.doc.activeElement; const text = target.children[0]!; const marks = target.querySelectorAll('[data-history-preview-value-highlight="display"]');
    expect(literalText(text)).toBe(label); expect(marks.map(mark => mark.textContent)).toEqual(['NeedLe', 'NEEDLE']);
    expect(marks.every(mark => mark.getAttribute('tabindex') === null)).toBe(true); expect(target.getAttribute('aria-label')).not.toContain('Return to matching fields');
    const back = target.find('data-history-preview-control', 'return-matches')!; const input = f.host.find('data-history-preview-search', 'query')!;
    input.value = 'Unapplied draft'; back.focus!(); await f.panel.refresh();
    expect(f.doc.activeElement).toBe(back); expect(target.querySelectorAll('[data-history-preview-value-highlight="display"]')[0]).toBe(marks[0]);
    expect(input.value).toBe('Unapplied draft'); searchPreview(f, 'x'.repeat(129));
    expect(target.querySelectorAll('[data-history-preview-value-highlight="display"]')[0]).toBe(marks[0]); expect(f.host.text()).toContain('Use 128 characters or fewer');
    back.click(); expect(f.doc.activeElement).toBe(view); expect(literalText(text)).toBe(label);
    entry.find('data-history-preview-match-path', JSON.stringify(['record', 'group', 'uses', 0, 'label']))!.click();
    const current = f.doc.activeElement; expect(current.querySelectorAll('[data-history-preview-value-highlight="display"]').map(mark => mark.textContent)).toEqual(['needle']);
    expect(target.querySelectorAll('[data-history-preview-value-highlight]')).toHaveLength(0); expect(literalText(text)).toBe(label);
    expect(entry.querySelectorAll('[data-history-preview-control="return-matches"]')).toHaveLength(1); back.click(); expect(f.doc.activeElement).toBe(current);
    savePreview(f); expect(download).toHaveBeenCalledExactlyOnceWith(expected.filename, expected.json); expect(JSON.stringify(value)).toBe(before);
    expect(exportHistory).toHaveBeenCalledTimes(1); expect(call).toHaveBeenCalledTimes(2); f.panel.dispose();
  });
  it.each([
    ['Cafe\u0301', 'CAFÉ', 'Cafe\u0301'], ['oﬃce', 'FFI', 'ﬃ'], ['İ\u0f73', 'İ\u0f73', 'İ\u0f73'],
    ['ΟΣΟΣ', 'ΟΣ', 'ΟΣ'], ['👩‍👩‍👧‍👦', '👩', '👩‍👩‍👧‍👦'], ['ＡＢＣ', 'abc', 'ＡＢＣ'],
  ] as const)('highlights the original full-value characters of %s for the folded query %s', async (label, query, marked) => {
    const value = historyExport(page().scope, 1); const record = value.entries[0]!.record; if (!('group' in record)) throw Error(); record.group = { ...record.group, label };
    const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download: vi.fn() }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, query);
    const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle');
    const view = entry.find('data-history-preview-match-path', JSON.stringify(['record', 'group', 'label']))!; view.click(); const target = f.doc.activeElement;
    expect(literalText(target.children[0]!)).toBe(label); expect(target.querySelectorAll('[data-history-preview-value-highlight="display"]').map(mark => mark.textContent)).toEqual([marked]);
    expect(target.find('data-history-preview-saved-value', 'literal')).toBeUndefined(); expect(f.host.text()).toContain('Matching text is highlighted in the full value.');
    target.find('data-history-preview-control', 'return-matches')!.click(); expect(f.doc.activeElement).toBe(view); expect(literalText(target.children[0]!)).toBe(label); f.panel.dispose();
  });
  it.each([['false', 'currently_reported', 'No'], ['authentication_changed', 'retirement_reason', 'Authentication changed']] as const)(
    'shows the exact saved %s when the readable value does not contain the query', async (query, key, readable) => {
      const value = historyExport(page().scope, 1); const download = vi.fn(); const expected = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'full');
      const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download }); await f.panel.whenLoaded();
      const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change');
      f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, query);
      const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle'); const path = JSON.stringify(['record', key]);
      const view = entry.find('data-history-preview-match-path', path)!; view.click(); const target = f.doc.activeElement; const original = target.children[0]!;
      expect(literalText(original)).toBe(readable); expect(literalText(target.find('data-history-preview-saved-value', 'literal')!)).toBe('Saved value: ' + query);
      expect(target.querySelectorAll('[data-history-preview-value-highlight="saved"]').map(mark => mark.textContent)).toEqual([query]);
      expect(target.find('data-history-preview-hit-range', 'value')!.textContent).toBe('Hit 1 of 1');
      expect(target.find('data-history-preview-control', 'hit-previous')!.disabled).toBe(true); expect(target.find('data-history-preview-control', 'hit-next')!.disabled).toBe(true);
      expect(target.querySelectorAll('[data-history-preview-value-highlight="display"]')).toHaveLength(0); view.click();
      expect(target.querySelectorAll('[data-history-preview-saved-value]')).toHaveLength(1); expect(target.children[0]).toBe(original);
      expect(target.getAttribute('aria-label')).not.toContain('Return to matching fields'); expect(f.host.text()).toContain('Matching text is highlighted in the saved value.');
      searchPreview(f, readable); const next = f.host.find('data-history-preview-record', '0')!; next.open = true; next.fire('toggle'); next.find('data-history-preview-match-path', path)!.click();
      expect(f.doc.activeElement.find('data-history-preview-saved-value', 'literal')).toBeUndefined();
      expect(f.doc.activeElement.querySelectorAll('[data-history-preview-value-highlight="display"]').map(mark => mark.textContent)).toEqual([readable]);
      savePreview(f); expect(download).toHaveBeenCalledExactlyOnceWith(expected.filename, expected.json); f.panel.dispose();
    });
  it('restores a prior field accessibility label when its raw saved-value display is cleared', async () => {
    const value = historyExport(page().scope, 1); const expected = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'full'); const download = vi.fn();
    const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'false');
    const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle');
    const path = JSON.stringify(['record', 'currently_reported']); const first = entry.find('data-history-preview-path', path)!;
    const originalLabel = first.getAttribute('aria-label'); const view = entry.find('data-history-preview-match-path', path)!; view.click();
    expect(first.getAttribute('aria-label')).toContain('Matched field:');
    const secondPath = JSON.stringify(['record', 'events_truncated']); const second = entry.find('data-history-preview-path', secondPath)!;
    second.setAttribute('aria-label', 'Existing saved-field label'); entry.find('data-history-preview-match-path', secondPath)!.click();
    expect(first.getAttribute('aria-label')).toBe(originalLabel); expect(first.getAttribute('data-history-preview-match-target')).toBe('false');
    expect(first.find('data-history-preview-saved-value', 'literal')).toBeUndefined(); expect(literalText(first)).toBe('No');
    view.click(); expect(second.getAttribute('aria-label')).toBe('Existing saved-field label'); expect(second.find('data-history-preview-saved-value', 'literal')).toBeUndefined();
    expect(f.doc.activeElement).toBe(first); expect(first.getAttribute('aria-label')).toContain(': No. Saved value: false');
    savePreview(f); expect(download).toHaveBeenCalledExactlyOnceWith(expected.filename, expected.json); f.panel.dispose();
  });
  it('preserves a time element and its UTC date when only the saved timestamp matches', async () => {
    const value = historyExport(page().scope, 1); const record = value.entries[0]!.record; if (!('group' in record)) throw Error();
    const shift = 1_750_000_000_000; value.exported_at += shift;
    record.started_at += shift; record.history_started_at! += shift; record.last_problem_at! += shift; record.ended_at! += shift; for (const event of record.events) event.at += shift;
    const query = String(record.last_problem_at); const readable = new Date(record.last_problem_at!).toISOString();
    const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download: vi.fn() }); await f.panel.whenLoaded();
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, query);
    const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle'); const path = JSON.stringify(['record', 'last_problem_at']);
    const target = entry.find('data-history-preview-path', path)!; const time = target.children[0]!; entry.find('data-history-preview-match-path', path)!.click();
    expect(target.children[0]).toBe(time); expect(literalText(time)).toBe(readable); expect(time.getAttribute('datetime')).toBe(readable);
    expect(literalText(target.find('data-history-preview-saved-value', 'literal')!)).toBe('Saved value: ' + query);
    expect(target.querySelectorAll('[data-history-preview-value-highlight="saved"]').map(mark => mark.textContent)).toEqual([query]); f.panel.dispose();
  });
  it.each(['query', 'privacy', 'close', 'new snapshot', 'record page', 'array page', 'dispose'] as const)('removes selected full-value highlights after %s and ignores old field controls', async phase => {
    const value = historyExport(page().scope, 25); const record = value.entries[0]!.record; if (!('group' in record)) throw Error();
    record.group = { ...record.group, uses: Array.from({ length: 45 }, (_, n) => ({ kind: 'pack', id: 'pack-' + n, label: 'needle ' + n })) };
    for (const entry of value.entries) if ('group' in entry.record) entry.record.group = { ...entry.record.group, label: 'needle' };
    const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value); const download = vi.fn();
    const f = mount(async () => page(), value.scope, { exportHistory, download }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'needle');
    const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle');
    const path = JSON.stringify(phase === 'array page' ? ['record', 'group', 'uses', 0, 'label'] : ['record', 'group', 'label']);
    const view = entry.find('data-history-preview-match-path', path)!; view.click(); const target = f.doc.activeElement; const original = target.children[0]!;
    const before = literalText(original); const back = target.find('data-history-preview-control', 'return-matches')!;
    expect(target.querySelectorAll('[data-history-preview-value-highlight="display"]')).toHaveLength(1);
    if (phase === 'query') searchPreview(f, 'retired');
    else if (phase === 'privacy') { privacy.value = 'aliases'; privacy.fire('change'); }
    else if (phase === 'close') f.host.find('data-history-preview-control', 'close')!.click();
    else if (phase === 'new snapshot') { f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); }
    else if (phase === 'record page') f.host.find('data-history-preview-control', 'next')!.click();
    else if (phase === 'array page') entry.find('data-history-preview-field', 'uses')!.find('data-history-preview-control', 'array-next')!.click();
    else f.panel.dispose();
    const focused = f.doc.activeElement; const calls = exportHistory.mock.calls.length;
    // Array paging leaves the current match button available to reveal its field again.
    if (phase !== 'array page') view.click(); back.click();
    expect(f.doc.activeElement).toBe(focused); expect(f.host.querySelectorAll('[data-history-preview-value-highlight]')).toHaveLength(0);
    expect(f.host.find('data-history-preview-saved-value', 'literal')).toBeUndefined(); expect(exportHistory).toHaveBeenCalledTimes(calls); expect(download).not.toHaveBeenCalled();
    if (phase === 'query' || phase === 'record page' || phase === 'array page') { expect(literalText(original)).toBe(before); expect(original.querySelectorAll('[data-history-preview-value-highlight]')).toHaveLength(0); }
    f.panel.dispose();
  });
  it.each(['selected', 'another field', 'draft', 'return', 'query', 'privacy', 'close', 'dispose'] as const)(
    'guards the deferred hit scroll when focus or selection changes to %s', async phase => {
      const value = historyExport(page().scope, 1); const record = value.entries[0]!.record; if (!('group' in record)) throw Error();
      record.group = { ...record.group, label: 'needle', uses: [{ kind: 'pack', id: 'sheet', label: 'other needle' }] };
      const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download: vi.fn() }); await f.panel.whenLoaded();
      const frames: FrameRequestCallback[] = []; const scrolled: Element[] = []; const create = f.doc.createElement;
      Object.assign(f.doc, { defaultView: { requestAnimationFrame: (run: FrameRequestCallback) => frames.push(run) } });
      f.doc.createElement = () => { const element = create(); Object.assign(element, { scrollIntoView: () => { scrolled.push(element); } }); return element; };
      const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change');
      f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'needle');
      const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle');
      const view = entry.find('data-history-preview-match-path', JSON.stringify(['record', 'group', 'label']))!; view.click();
      expect(frames).toHaveLength(1); expect(scrolled).toEqual([f.doc.activeElement.find('data-history-preview-value-highlight', 'display')]);
      if (phase === 'another field') entry.find('data-history-preview-match-path', JSON.stringify(['record', 'group', 'uses', 0, 'label']))!.click();
      else if (phase === 'draft') f.host.find('data-history-preview-search', 'query')!.focus!();
      else if (phase === 'return') entry.find('data-history-preview-control', 'return-matches')!.click();
      else if (phase === 'query') searchPreview(f, 'retired');
      else if (phase === 'privacy') { privacy.value = 'aliases'; privacy.fire('change'); }
      else if (phase === 'close') f.host.find('data-history-preview-control', 'close')!.click();
      else if (phase === 'dispose') f.panel.dispose();
      const focused = f.doc.activeElement; const currentMark = focused.find('data-history-preview-value-highlight', 'display'); scrolled.length = 0;
      for (const frame of frames) frame(0);
      expect(scrolled).toEqual(phase === 'selected' || phase === 'another field' ? [currentMark] : []); expect(f.doc.activeElement).toBe(focused); f.panel.dispose();
    });
  it('navigates hits within one complete value and preserves the current hit, draft and controls through refresh and return', async () => {
    const value = historyExport(page().scope, 1); const record = value.entries[0]!.record; if (!('group' in record)) throw Error();
    const label = 'Needle ' + 'prefix '.repeat(70) + 'NEEDLE ' + 'suffix '.repeat(70) + 'needle'; record.group = { ...record.group, label };
    const before = JSON.stringify(value); const expected = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'full'); const download = vi.fn();
    const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value); const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page());
    const f = mount(call, value.scope, { exportHistory, download }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'needle');
    const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle'); const path = JSON.stringify(['record', 'group', 'label']);
    const view = entry.find('data-history-preview-match-path', path)!; view.click(); const target = f.doc.activeElement; const scalar = target.children[0]!;
    const navigation = target.find('data-history-preview-hits', 'navigation')!; const next = navigation.find('data-history-preview-control', 'hit-next')!;
    const previous = navigation.find('data-history-preview-control', 'hit-previous')!; const range = navigation.find('data-history-preview-hit-range', 'value')!;
    const marks = target.querySelectorAll('[data-history-preview-value-highlight="display"]'); expect(range.textContent).toBe('Hit 1 of 3'); expect(previous.disabled).toBe(true); expect(next.disabled).toBe(false);
    expect(marks.map(mark => mark.getAttribute('aria-current'))).toEqual(['true', null, null]); expect(f.doc.activeElement).toBe(target);
    next.focus!(); next.click(); expect(range.textContent).toBe('Hit 2 of 3'); expect(f.doc.activeElement).toBe(next);
    expect(marks.map(mark => mark.getAttribute('aria-current'))).toEqual(['false', 'true', null]); expect(literalText(scalar)).toBe(label);
    const draft = f.host.find('data-history-preview-search', 'query')!; draft.value = 'Unapplied hit draft'; await f.panel.refresh();
    expect(f.doc.activeElement).toBe(next); expect(target.find('data-history-preview-hits', 'navigation')).toBe(navigation); expect(range.textContent).toBe('Hit 2 of 3');
    target.find('data-history-preview-control', 'return-matches')!.click(); expect(f.doc.activeElement).toBe(view); expect(range.textContent).toBe('Hit 2 of 3'); expect(draft.value).toBe('Unapplied hit draft');
    next.focus!(); next.click(); expect(range.textContent).toBe('Hit 3 of 3'); expect(next.disabled).toBe(true); expect(f.doc.activeElement).toBe(range);
    next.fire('click'); expect(range.textContent).toBe('Hit 3 of 3'); previous.focus!(); previous.click(); expect(f.doc.activeElement).toBe(previous);
    previous.click(); expect(range.textContent).toBe('Hit 1 of 3'); expect(previous.disabled).toBe(true); expect(f.doc.activeElement).toBe(range);
    previous.fire('click'); expect(range.textContent).toBe('Hit 1 of 3'); expect(target.getAttribute('aria-label')).not.toMatch(/Previous hit|Next hit|Hit 1 of/);
    view.click(); const fresh = target.find('data-history-preview-hits', 'navigation')!; expect(fresh).not.toBe(navigation); expect(f.host.querySelectorAll('[data-history-preview-hits]')).toHaveLength(1);
    next.disabled = false; next.click(); expect(f.doc.activeElement).toBe(target); expect(fresh.find('data-history-preview-hit-range', 'value')!.textContent).toBe('Hit 1 of 3');
    savePreview(f); expect(download).toHaveBeenCalledExactlyOnceWith(expected.filename, expected.json); expect(JSON.stringify(value)).toBe(before);
    expect(exportHistory).toHaveBeenCalledTimes(1); expect(call).toHaveBeenCalledTimes(2); f.panel.dispose();
  });
  it.each([
    ['needleneedle', 'needle', ['needle', 'needle']], ['Cafe\u0301CAFÉ', 'café', ['Cafe\u0301', 'CAFÉ']], ['ﬃﬃ', 'FFI', ['ﬃ', 'ﬃ']],
    ['👩‍👩‍👧‍👦👩‍👩‍👧‍👦', '👩', ['👩‍👩‍👧‍👦', '👩‍👩‍👧‍👦']], ['ΟΣΟΣ ΟΣΟΣ', 'ΟΣ', ['ΟΣ', 'ΟΣ']], ['ＡＢＣＡＢＣ', 'abc', ['ＡＢＣ', 'ＡＢＣ']],
  ] as const)('navigates separate full-value hits in %s for the Unicode-equivalent query %s', async (label, query, expected) => {
    const value = historyExport(page().scope, 1); const record = value.entries[0]!.record; if (!('group' in record)) throw Error(); record.group = { ...record.group, label };
    const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download: vi.fn() }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change'); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, query);
    const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle'); entry.find('data-history-preview-match-path', JSON.stringify(['record', 'group', 'label']))!.click();
    const target = f.doc.activeElement; const marks = target.querySelectorAll('[data-history-preview-value-highlight="display"]'); expect(marks.map(mark => mark.textContent)).toEqual(expected);
    target.find('data-history-preview-control', 'hit-next')!.click(); expect(target.find('data-history-preview-hit-range', 'value')!.textContent).toBe('Hit 2 of 2');
    expect(marks.map(mark => mark.getAttribute('aria-current'))).toEqual(['false', 'true']); expect(literalText(target.children[0]!)).toBe(label); expect(f.doc.activeElement).toBe(target); f.panel.dispose();
  });
  it('navigates only the raw saved form when repeated raw hits are absent from readable words', async () => {
    const value = historyExport(page().scope, 1); const record = value.entries[0]!.record; if (!('retirement_reason' in record)) throw Error(); record.retirement_reason = 'use_removed_or_changed';
    const expected = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'full'); const download = vi.fn();
    const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change'); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, '_');
    const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle'); entry.find('data-history-preview-match-path', JSON.stringify(['record', 'retirement_reason']))!.click();
    const target = f.doc.activeElement; const original = target.children[0]!; const marks = target.querySelectorAll('[data-history-preview-value-highlight="saved"]');
    expect(marks.map(mark => mark.textContent)).toEqual(['_', '_', '_']); target.find('data-history-preview-control', 'hit-next')!.click();
    expect(target.find('data-history-preview-hit-range', 'value')!.textContent).toBe('Hit 2 of 3'); expect(marks[1]!.getAttribute('aria-current')).toBe('true');
    expect(literalText(original)).toBe('Use removed or changed'); expect(literalText(target.find('data-history-preview-saved-value', 'literal')!)).toBe('Saved value: use_removed_or_changed');
    expect(target.querySelectorAll('[data-history-preview-value-highlight="display"]')).toHaveLength(0); savePreview(f); expect(download).toHaveBeenCalledExactlyOnceWith(expected.filename, expected.json); f.panel.dispose();
  });
  it('retains the selected hit while match paging changes and return restores the originating field button', async () => {
    const value = historyExport(page().scope, 1); const record = value.entries[0]!.record; if (!('group' in record)) throw Error();
    record.group = { ...record.group, label: 'needle NEEDLE', uses: Array.from({ length: 45 }, (_, n) => ({ kind: 'pack', id: 'pack-' + n, label: 'needle ' + n })) };
    const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download: vi.fn() }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change'); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'needle');
    const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle'); const path = JSON.stringify(['record', 'group', 'label']);
    const view = entry.find('data-history-preview-match-path', path)!; view.click(); const target = f.doc.activeElement; target.find('data-history-preview-control', 'hit-next')!.click();
    const navigation = target.find('data-history-preview-hits', 'navigation')!; entry.find('data-history-preview-control', 'matches-next')!.click();
    expect(entry.text()).toContain('Matching fields 6–10 of 46'); expect(navigation.find('data-history-preview-hit-range', 'value')!.textContent).toBe('Hit 2 of 2');
    target.find('data-history-preview-control', 'return-matches')!.click(); expect(entry.text()).toContain('Matching fields 1–5 of 46');
    expect(f.doc.activeElement).toBe(entry.find('data-history-preview-match-path', path)); expect(f.doc.activeElement).not.toBe(view);
    expect(target.find('data-history-preview-hits', 'navigation')).toBe(navigation); expect(navigation.find('data-history-preview-hit-range', 'value')!.textContent).toBe('Hit 2 of 2'); f.panel.dispose();
  });
  it.each(['query', 'privacy', 'close', 'new snapshot', 'record page', 'array page', 'dispose'] as const)('discards hit controls after %s and prevents detached controls from changing their old position', async phase => {
    const value = historyExport(page().scope, 25); for (const entry of value.entries) if ('group' in entry.record) entry.record.group = { ...entry.record.group, label: 'needle needle' };
    const record = value.entries[0]!.record; if (!('group' in record)) throw Error(); record.group.uses = Array.from({ length: 45 }, (_, n) => ({ kind: 'pack', id: 'pack-' + n, label: 'needle needle ' + n }));
    const download = vi.fn(); const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value);
    const f = mount(async () => page(), value.scope, { exportHistory, download }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change'); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'needle');
    const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle');
    const path = JSON.stringify(phase === 'array page' ? ['record', 'group', 'uses', 0, 'label'] : ['record', 'group', 'label']); entry.find('data-history-preview-match-path', path)!.click();
    const target = f.doc.activeElement; const next = target.find('data-history-preview-control', 'hit-next')!; const range = target.find('data-history-preview-hit-range', 'value')!; expect(next.disabled).toBe(false);
    if (phase === 'query') searchPreview(f, 'retired');
    else if (phase === 'privacy') { privacy.value = 'aliases'; privacy.fire('change'); }
    else if (phase === 'close') f.host.find('data-history-preview-control', 'close')!.click();
    else if (phase === 'new snapshot') { f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); }
    else if (phase === 'record page') f.host.find('data-history-preview-control', 'next')!.click();
    else if (phase === 'array page') entry.find('data-history-preview-field', 'uses')!.find('data-history-preview-control', 'array-next')!.click();
    else f.panel.dispose();
    const focused = f.doc.activeElement; const calls = exportHistory.mock.calls.length; next.click(); expect(range.textContent).toBe('Hit 1 of 2'); expect(f.doc.activeElement).toBe(focused);
    expect(f.host.querySelectorAll('[data-history-preview-hits]')).toHaveLength(0); expect(exportHistory).toHaveBeenCalledTimes(calls); expect(download).not.toHaveBeenCalled(); f.panel.dispose();
  });
  it.each([
    ['next', 'pointer'], ['previous', 'pointer'], ['next', 'keyboard'], ['previous', 'keyboard'],
    ['next', 'field pointer'], ['previous', 'field pointer'],
    ['next', 'programmatic'], ['previous', 'programmatic'], ['next', 'cancelled pointer'], ['previous', 'cancelled pointer'],
    ['next', 'new draft'], ['previous', 'new draft'],
  ] as const)('preserves focus at the %s hit boundary with %s activation', async (direction, activation) => {
    const value = historyExport(page().scope, 1); const record = value.entries[0]!.record; if (!('group' in record)) throw Error(); record.group = { ...record.group, label: 'needle needle needle' };
    const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download: vi.fn() }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change'); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'needle');
    const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle'); entry.find('data-history-preview-match-path', JSON.stringify(['record', 'group', 'label']))!.click();
    const target = f.doc.activeElement; target.find('data-history-preview-control', 'hit-next')!.click();
    const control = target.find('data-history-preview-control', direction === 'next' ? 'hit-next' : 'hit-previous')!; const range = target.find('data-history-preview-hit-range', 'value')!;
    const draft = f.host.find('data-history-preview-search', 'query')!; draft.value = 'Unapplied draft'; control.focus!();
    if (activation !== 'keyboard') {
      control.fire('pointerdown'); if (activation === 'cancelled pointer') control.fire('pointercancel');
      if (activation === 'new draft') draft.focus!(); else f.doc.activeElement = activation === 'field pointer' ? target : f.doc.body;
    }
    control.fire('click', activation === 'pointer' || activation === 'field pointer' || activation === 'cancelled pointer' || activation === 'new draft' ? 1 : 0);
    expect(range.textContent).toBe(direction === 'next' ? 'Hit 3 of 3' : 'Hit 1 of 3'); expect(control.disabled).toBe(true);
    expect(f.doc.activeElement).toBe(activation === 'pointer' || activation === 'field pointer' || activation === 'keyboard' ? range : activation === 'new draft' ? draft : f.doc.body);
    expect(draft.value).toBe('Unapplied draft'); f.panel.dispose();
  });
  it.each(['next', 'previous'] as const)('keeps a focused %s button after a pointer click that stays between hit boundaries', async direction => {
    const value = historyExport(page().scope, 1); const record = value.entries[0]!.record; if (!('group' in record)) throw Error(); record.group = { ...record.group, label: 'needle needle needle needle' };
    const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download: vi.fn() }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change'); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'needle');
    const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle'); entry.find('data-history-preview-match-path', JSON.stringify(['record', 'group', 'label']))!.click();
    const target = f.doc.activeElement; const next = target.find('data-history-preview-control', 'hit-next')!; next.click(); if (direction === 'previous') next.click();
    const control = direction === 'next' ? next : target.find('data-history-preview-control', 'hit-previous')!;
    control.focus!(); control.fire('pointerdown'); f.doc.activeElement = target; control.fire('click', 1);
    expect(target.find('data-history-preview-hit-range', 'value')!.textContent).toBe(direction === 'next' ? 'Hit 3 of 4' : 'Hit 2 of 4');
    expect(control.disabled).toBe(false); expect(f.doc.activeElement).toBe(control); f.panel.dispose();
  });
  it.each(['field', 'button', 'range'] as const)('keeps a newer hit selection during the queued layout scroll with %s focus', async focus => {
    const value = historyExport(page().scope, 1); const record = value.entries[0]!.record; if (!('group' in record)) throw Error(); record.group = { ...record.group, label: focus === 'button' ? 'needle needle needle' : 'needle needle' };
    const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download: vi.fn() }); await f.panel.whenLoaded();
    const frames: FrameRequestCallback[] = []; const scrolled: Element[] = []; const create = f.doc.createElement;
    Object.assign(f.doc, { defaultView: { requestAnimationFrame: (run: FrameRequestCallback) => frames.push(run) } });
    f.doc.createElement = () => { const element = create(); Object.assign(element, { scrollIntoView: () => { scrolled.push(element); } }); return element; };
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change'); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'needle');
    const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle'); entry.find('data-history-preview-match-path', JSON.stringify(['record', 'group', 'label']))!.click();
    const target = f.doc.activeElement; const next = target.find('data-history-preview-control', 'hit-next')!; if (focus !== 'field') next.focus!(); next.click();
    const selected = target.querySelectorAll('[data-history-preview-value-highlight="display"]')[1]!; expect(scrolled.at(-1)).toBe(selected); scrolled.length = 0;
    const focused = f.doc.activeElement; for (const frame of frames) frame(0); expect(scrolled).toEqual(focus === 'field' ? [selected] : []); expect(f.doc.activeElement).toBe(focused); f.panel.dispose();
  });
  it.each(['aliases', 'full'] as const)('copies the captured %s scalar immediately during the click without adding labels or starting requests', async mode => {
    const value = historyExport(page().scope, 1); Object.assign(value.entries[0]!.record, { access_token: 'private-copy-marker' });
    const expected = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode); const saved = expected.report.entries[0]!.record.id;
    const download = vi.fn(); const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value); const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page());
    const write = vi.fn(function(this: { tag: string }, text: string) { expect(this.tag).toBe('bound clipboard'); return Promise.resolve(); });
    const f = mount(call, value.scope, { exportHistory, download }); await f.panel.whenLoaded(); copyBrowser(f, { clipboard: { tag: 'bound clipboard', writeText: write } });
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = mode; privacy.fire('change'); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded();
    value.entries[0]!.record.id = 'ffffffff-1234-4123-8123-123456789abc'; searchPreview(f, saved);
    const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle'); entry.find('data-history-preview-match-path', JSON.stringify(['record', 'id']))!.click();
    const target = f.doc.activeElement; const copy = target.find('data-history-preview-control', 'copy-value')!; expect(write).not.toHaveBeenCalled(); copy.focus!(); copy.click();
    expect(write).toHaveBeenCalledExactlyOnceWith(saved); expect(copy.getAttribute('aria-busy')).toBe('true'); expect(copy.getAttribute('aria-disabled')).toBe('true');
    copy.click(); expect(write).toHaveBeenCalledTimes(1); await settleCopy();
    expect(copy.getAttribute('aria-busy')).toBe('false'); expect(copy.getAttribute('aria-disabled')).toBe('false'); expect(f.doc.activeElement).toBe(copy);
    expect(target.find('data-history-preview-copy', 'status')!.textContent).toBe('Saved value copied.'); expect(target.getAttribute('aria-label')).not.toContain('Copy saved value');
    expect(f.host.find('data-history-preview-copy', 'manual-value')).toBeUndefined(); expect(write.mock.calls[0]![0]).not.toMatch(/private-copy-marker|Return to matching/);
    copy.click(); await settleCopy(); expect(write).toHaveBeenCalledTimes(2); expect(exportHistory).toHaveBeenCalledTimes(1); expect(call).toHaveBeenCalledTimes(1);
    savePreview(f); expect(download).toHaveBeenCalledExactlyOnceWith(expected.filename, expected.json); expect(f.panel.hasDraft()).toBe(false); expect(f.panel.hasInFlightWork()).toBe(false); f.panel.dispose();
  });
  it.each(['field', 'body'] as const)('keeps pointer copy focus after browser fallback to the %s so a delayed refusal can select the manual value', async fallback => {
    const value = historyExport(page().scope, 1); let reject!: (error: Error) => void;
    const write = vi.fn<(text: string) => Promise<void>>(() => new Promise((_resolve, no) => { reject = no; }));
    const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download: vi.fn() }); await f.panel.whenLoaded(); const browser = copyBrowser(f, { clipboard: { writeText: write } });
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'incident-1');
    const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle'); entry.find('data-history-preview-match-path', JSON.stringify(['record', 'id']))!.click();
    const target = f.doc.activeElement; const copy = target.find('data-history-preview-control', 'copy-value')!; f.doc.activeElement = fallback === 'field' ? target : f.doc.body;
    copy.fire('click', 1); expect(write).toHaveBeenCalledExactlyOnceWith('incident-1'); expect(f.doc.activeElement).toBe(copy);
    reject(Error('private-copy-error')); await settleCopy(); const manual = target.find('data-history-preview-copy', 'manual-value')!;
    expect(f.doc.activeElement).toBe(manual); expect(browser.selected()).toBe(manual); expect(manual.textContent).toBe('incident-1'); f.panel.dispose();
  });
  it('does not override a newer focused draft when a pointer copy click runs', async () => {
    const value = historyExport(page().scope, 1); let reject!: (error: Error) => void;
    const write = vi.fn<(text: string) => Promise<void>>(() => new Promise((_resolve, no) => { reject = no; }));
    const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download: vi.fn() }); await f.panel.whenLoaded(); const browser = copyBrowser(f, { clipboard: { writeText: write } });
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'incident-1');
    const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle'); entry.find('data-history-preview-match-path', JSON.stringify(['record', 'id']))!.click();
    const target = f.doc.activeElement; const copy = target.find('data-history-preview-control', 'copy-value')!;
    const draft = f.host.find('data-history-preview-search', 'query')!; draft.value = 'Unapplied draft'; draft.focus!(); copy.fire('click', 1);
    expect(f.doc.activeElement).toBe(draft); reject(Error('private-copy-error')); await settleCopy();
    expect(f.doc.activeElement).toBe(draft); expect(draft.value).toBe('Unapplied draft'); expect(browser.selection.addRange).not.toHaveBeenCalled();
    expect(target.find('data-history-preview-copy', 'manual-value')).toBeDefined(); f.panel.dispose();
  });
  it.each([
    ['No', ['record', 'currently_reported'], 'false'], ['1970-01-01T00:00:00.150Z', ['record', 'last_problem_at'], '150'],
    ['Authentication changed', ['record', 'retirement_reason'], 'authentication_changed'], ['incident', ['type'], 'incident'],
    ['Closed without confirmed recovery', ['outcome'], 'retired'], ['Label', ['record', 'group', 'label'], '  Cafe\u0301 🚀 <img onerror="bad()">  tail  '],
  ] as const)('copies the saved scalar for %s with its original code, number or Unicode text', async (query, path, raw) => {
    const value = historyExport(page().scope, 1); const record = value.entries[0]!.record; if (!('group' in record)) throw Error();
    if (path.at(-1) === 'label') record.group = { ...record.group, label: raw };
    const write = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(); const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download: vi.fn() }); await f.panel.whenLoaded(); copyBrowser(f, { clipboard: { writeText: write } });
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change'); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, query);
    const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle'); entry.find('data-history-preview-match-path', JSON.stringify(path))!.click();
    const target = f.doc.activeElement; target.find('data-history-preview-control', 'copy-value')!.click(); expect(write).toHaveBeenCalledExactlyOnceWith(raw); await settleCopy();
    expect(target.find('data-history-preview-copy', 'status')!.textContent).toBe('Saved value copied.'); f.panel.dispose();
  });
  it.each(['missing', 'clipboard getter', 'method getter', 'sync throw', 'rejection'] as const)('offers literal manual copy after %s without exposing clipboard errors or claiming a copy', async failure => {
    const value = historyExport(page().scope, 1); const record = value.entries[0]!.record; if (!('group' in record)) throw Error();
    const raw = '  Cafe\u0301 🚀 <script>literal</script>  tail  '; record.group = { ...record.group, label: raw };
    const write = vi.fn<(text: string) => Promise<void>>(() => { if (failure === 'sync throw') throw Error('private-clipboard-error'); return Promise.reject(Error('private-clipboard-error')); });
    const navigator: { clipboard?: object } = failure === 'missing' ? {} : { clipboard: { writeText: write } };
    if (failure === 'clipboard getter') Object.defineProperty(navigator, 'clipboard', { get: () => { throw Error('private-clipboard-error'); } });
    if (failure === 'method getter') Object.defineProperty(navigator.clipboard!, 'writeText', { get: () => { throw Error('private-clipboard-error'); } });
    const download = vi.fn(); const expected = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'full');
    const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download }); await f.panel.whenLoaded(); const browser = copyBrowser(f, navigator);
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change'); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'Label');
    const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle'); entry.find('data-history-preview-match-path', JSON.stringify(['record', 'group', 'label']))!.click();
    const target = f.doc.activeElement; const copy = target.find('data-history-preview-control', 'copy-value')!; copy.focus!(); copy.click(); await settleCopy();
    const manual = target.find('data-history-preview-copy', 'manual-value')!; expect(manual.textContent).toBe(raw); expect(manual.getAttribute('role')).toBe('textbox'); expect(manual.getAttribute('aria-readonly')).toBe('true');
    expect(f.doc.activeElement).toBe(manual); expect(browser.selected()).toBe(manual); expect(browser.selection.addRange).toHaveBeenCalledTimes(1);
    expect(f.host.text()).not.toContain('private-clipboard-error'); expect(target.find('data-history-preview-copy', 'status')!.textContent).not.toBe('Saved value copied.');
    expect(copy.getAttribute('aria-busy')).toBe('false'); target.find('data-history-preview-control', 'select-copy-value')!.click();
    manual.fire('keydown', 0, { key: 'a', metaKey: true }); manual.fire('keydown', 0, { key: 'A', ctrlKey: true }); expect(browser.selection.addRange).toHaveBeenCalledTimes(4);
    expect(write).toHaveBeenCalledTimes(failure === 'sync throw' || failure === 'rejection' ? 1 : 0); savePreview(f); expect(download).toHaveBeenCalledExactlyOnceWith(expected.filename, expected.json); f.panel.dispose();
  });
  it('copies a zero saved timestamp instead of treating it as an absent value', async () => {
    const value = historyExport(page().scope, 1); const record = value.entries[0]!.record; if (!('events' in record)) throw Error(); record.started_at = 0; record.history_started_at = 0; record.events[0]!.at = 0;
    const write = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(); const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download: vi.fn() }); await f.panel.whenLoaded(); copyBrowser(f, { clipboard: { writeText: write } });
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, '1970-01-01T00:00:00.000Z'); const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle');
    entry.find('data-history-preview-match-path', JSON.stringify(['record', 'started_at']))!.click(); f.doc.activeElement.find('data-history-preview-control', 'copy-value')!.click();
    expect(write).toHaveBeenCalledExactlyOnceWith('0'); await settleCopy(); f.panel.dispose();
  });
  it('leaves manual text available when the browser also refuses programmatic selection', async () => {
    const value = historyExport(page().scope, 1); const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download: vi.fn() }); await f.panel.whenLoaded(); copyBrowser(f);
    Object.assign(f.doc, { createRange: () => { throw Error('private-selection-error'); } }); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'incident-1');
    const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle'); entry.find('data-history-preview-match-path', JSON.stringify(['record', 'id']))!.click();
    const target = f.doc.activeElement; target.find('data-history-preview-control', 'copy-value')!.click(); const manual = target.find('data-history-preview-copy', 'manual-value')!;
    expect(manual.textContent).toBe('incident-1'); expect(f.doc.activeElement).toBe(manual); target.find('data-history-preview-control', 'select-copy-value')!.click();
    expect(f.host.text()).not.toContain('private-selection-error'); expect(target.find('data-history-preview-copy', 'status')!.textContent).not.toBe('Saved value copied.'); f.panel.dispose();
  });
  it('preserves pending copy and a partial manual selection through history refresh without changing the selected hit', async () => {
    const value = historyExport(page().scope, 1); const record = value.entries[0]!.record; if (!('group' in record)) throw Error(); record.group = { ...record.group, label: 'needle needle needle' };
    let reject!: (error: Error) => void; const write = vi.fn<(text: string) => Promise<void>>(() => new Promise((_resolve, no) => { reject = no; }));
    const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download: vi.fn() }); await f.panel.whenLoaded(); const browser = copyBrowser(f, { clipboard: { writeText: write } });
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change'); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'needle');
    const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle'); const path = JSON.stringify(['record', 'group', 'label']); entry.find('data-history-preview-match-path', path)!.click();
    const target = f.doc.activeElement; target.find('data-history-preview-control', 'hit-next')!.click(); const copy = target.find('data-history-preview-control', 'copy-value')!;
    copy.focus!(); copy.click(); await f.panel.refresh(); expect(f.doc.activeElement).toBe(copy); expect(copy.getAttribute('aria-busy')).toBe('true'); expect(write).toHaveBeenCalledTimes(1);
    reject(Error('private-clipboard-error')); await settleCopy(); const manual = target.find('data-history-preview-copy', 'manual-value')!; expect(f.doc.activeElement).toBe(manual);
    browser.selection.anchorNode = manual; browser.selection.focusNode = manual; browser.selection.anchorOffset = 2; browser.selection.focusOffset = 8;
    await f.panel.refresh(); expect(f.doc.activeElement).toBe(manual); expect(target.find('data-history-preview-copy', 'manual-value')).toBe(manual);
    expect(browser.selection.setBaseAndExtent).toHaveBeenLastCalledWith(manual, 2, manual, 8); expect(target.find('data-history-preview-hit-range', 'value')!.textContent).toBe('Hit 2 of 3'); f.panel.dispose();
  });
  it.each(['draft', 'return', 'hit control'] as const)('does not steal %s focus when a clipboard rejection opens manual copy', async focus => {
    const value = historyExport(page().scope, 1); let reject!: (error: Error) => void; const write = vi.fn<(text: string) => Promise<void>>(() => new Promise((_resolve, no) => { reject = no; }));
    const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download: vi.fn() }); await f.panel.whenLoaded(); copyBrowser(f, { clipboard: { writeText: write } });
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'incident-1');
    const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle'); const view = entry.find('data-history-preview-match-path', JSON.stringify(['record', 'id']))!; view.click();
    const target = f.doc.activeElement; const copy = target.find('data-history-preview-control', 'copy-value')!; copy.focus!(); copy.click();
    const other = focus === 'draft' ? f.host.find('data-history-preview-search', 'query')! : focus === 'hit control' ? target.find('data-history-preview-hit-range', 'value')! : view;
    if (focus === 'return') target.find('data-history-preview-control', 'return-matches')!.click(); else other.focus!();
    reject(Error('private-clipboard-error')); await settleCopy(); expect(f.doc.activeElement).toBe(other); expect(target.find('data-history-preview-copy', 'manual-value')).toBeDefined();
    target.find('data-history-preview-control', 'select-copy-value')!.click(); expect(f.doc.activeElement).toBe(target.find('data-history-preview-copy', 'manual-value')); f.panel.dispose();
  });
  it.each(['success', 'failure'] as const)('ignores a late clipboard %s after every snapshot or selected-field invalidation', async outcome => {
    for (const phase of ['query', 'privacy', 'close', 'new snapshot', 'record page', 'array page', 'another field', 'dispose']) {
      const value = historyExport(page().scope, 25); for (const entry of value.entries) if ('group' in entry.record) entry.record.group = { ...entry.record.group, label: 'needle' };
      const record = value.entries[0]!.record; if (!('group' in record)) throw Error(); record.group.uses = Array.from({ length: 45 }, (_, n) => ({ kind: 'pack', id: 'pack-' + n, label: 'needle ' + n }));
      let finish!: () => void; let reject!: (error: Error) => void; const write = vi.fn<(text: string) => Promise<void>>(() => new Promise((yes, no) => { finish = yes; reject = no; }));
      const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download: vi.fn() }); await f.panel.whenLoaded(); copyBrowser(f, { clipboard: { writeText: write } });
      const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change'); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'needle');
      const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle');
      const path = JSON.stringify(phase === 'array page' ? ['record', 'group', 'uses', 0, 'label'] : ['record', 'group', 'label']); entry.find('data-history-preview-match-path', path)!.click();
      const target = f.doc.activeElement; const oldCopy = target.find('data-history-preview-control', 'copy-value')!; const status = target.find('data-history-preview-copy', 'status')!; oldCopy.click();
      if (phase === 'query') searchPreview(f, 'retired');
      else if (phase === 'privacy') { privacy.value = 'aliases'; privacy.fire('change'); }
      else if (phase === 'close') f.host.find('data-history-preview-control', 'close')!.click();
      else if (phase === 'new snapshot') { f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); }
      else if (phase === 'record page') f.host.find('data-history-preview-control', 'next')!.click();
      else if (phase === 'array page') entry.find('data-history-preview-field', 'uses')!.find('data-history-preview-control', 'array-next')!.click();
      else if (phase === 'another field') entry.find('data-history-preview-match-path', JSON.stringify(['record', 'group', 'uses', 0, 'label']))!.click();
      else f.panel.dispose();
      const focused = f.doc.activeElement; if (outcome === 'success') finish(); else reject(Error('private-clipboard-error')); await settleCopy();
      expect(status.textContent, phase).toBe('Copying saved value…'); expect(f.doc.activeElement, phase).toBe(focused); expect(f.host.find('data-history-preview-copy', 'manual-value'), phase).toBeUndefined();
      oldCopy.click(); expect(write, phase).toHaveBeenCalledTimes(1); f.panel.dispose();
    }
  });
  it('keeps old idle copy and selection controls inert after another field is selected', async () => {
    const value = historyExport(page().scope, 1); const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download: vi.fn() }); await f.panel.whenLoaded(); copyBrowser(f);
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change'); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'Label');
    const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle'); entry.find('data-history-preview-match-path', JSON.stringify(['record', 'group', 'label']))!.click();
    const oldCopy = f.doc.activeElement.find('data-history-preview-control', 'copy-value')!; oldCopy.click(); const oldSelect = f.doc.activeElement.find('data-history-preview-control', 'select-copy-value') ?? entry.find('data-history-preview-control', 'select-copy-value')!;
    entry.find('data-history-preview-match-path', JSON.stringify(['record', 'group', 'uses', 0, 'label']))!.click(); const focused = f.doc.activeElement;
    const write = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(); copyBrowser(f, { clipboard: { writeText: write } }); oldCopy.click(); oldSelect.click();
    expect(write).not.toHaveBeenCalled(); expect(f.doc.activeElement).toBe(focused); expect(f.host.querySelectorAll('[data-history-preview-copy="controls"]')).toHaveLength(1); f.panel.dispose();
  });
  it('invalidates matching-field controls after a query change, privacy change, close and disposal', async () => {
    const value = historyExport(page().scope, 1); const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value); const download = vi.fn();
    const f = mount(async () => page(), value.scope, { exportHistory, download }); await f.panel.whenLoaded();
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'incident-1');
    let entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle'); const oldView = entry.find('data-history-preview-control', 'match-field')!;
    searchPreview(f, 'authentication_changed'); oldView.click(); expect(f.host.find('data-history-preview-match-target', 'true')).toBeUndefined();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change'); oldView.click();
    expect(f.host.find('data-history-preview', 'report')!.hidden).toBe(true);
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'authentication_changed');
    entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle'); const closingView = entry.find('data-history-preview-control', 'match-field')!;
    f.host.find('data-history-preview-control', 'close')!.click(); const focused = f.doc.activeElement; closingView.click(); expect(f.doc.activeElement).toBe(focused);
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'authentication_changed');
    entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle'); const disposedView = entry.find('data-history-preview-control', 'match-field')!;
    f.panel.dispose(); disposedView.click(); expect(download).not.toHaveBeenCalled(); expect(exportHistory).toHaveBeenCalledTimes(3);
  });
});

describe('connection incident history owner UI', () => {
  it.each(['initial read', 'refresh'] as const)('keeps focus on a chosen navigation link through a delayed %s', async phase => {
    let release!: (p: AuthenticationIncidentHistoryPage) => void; const call = vi.fn<AuthenticationIncidentHistoryCaller>();
    if (phase === 'refresh') call.mockResolvedValueOnce(page());
    call.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const f = mount(call); if (phase === 'refresh') { await f.panel.whenLoaded(); void f.panel.refresh(); }
    const href = '#connections/others/review-access/api/work'; f.host.find('href', href)!.focus!(); release(page()); await f.panel.whenLoaded();
    expect(f.doc.activeElement).toBe(f.host.find('href', href)); f.panel.dispose();
  });
  it('preserves the chosen occurrence when navigation destinations repeat in a history view', async () => {
    const data = page(); const token = renewal(); data.repairs = []; data.renewals = [token]; data.order = [token.id, data.incidents[0]!.id];
    let release!: (p: AuthenticationIncidentHistoryPage) => void;
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValueOnce(data).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const f = mount(call); await f.panel.whenLoaded(); const pending = f.panel.refresh(); const href = '#connections/others/review-access/api/work';
    const links = () => f.host.querySelectorAll('[href]').filter(link => link.getAttribute('href') === href);
    expect(links().length).toBeGreaterThanOrEqual(2); links()[1]!.focus!(); release(data); await pending;
    expect(f.doc.activeElement).toBe(links()[1]); f.panel.dispose();
  });
  it('applies canonical filters to initial reads, refresh and matching older pages', async () => {
    const filters = { search: ' Work ', type: 'incident' as const, outcome: 'retired' as const, from: '1970-01-01', through: '1970-01-01' };
    const applied = { ...filters, search: 'Work' }; const first = { ...page(), filters: applied, next_cursor: 'older' }; const next: AuthenticationIncidentHistoryPage = structuredClone(first); next.incidents[0]!.id = '22345678-1234-4123-8123-123456789abc'; delete next.next_cursor;
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValueOnce(first).mockResolvedValueOnce(next).mockResolvedValue(next);
    const f = mount(call, first.scope, { filters }); await f.panel.whenLoaded(); f.host.find('data-incident-action', 'older')!.click(); await f.panel.whenLoaded(); await f.panel.refresh();
    expect(call.mock.calls.map(([q]) => q)).toEqual([{ scope: first.scope, include_renewals: true, filters: applied }, { scope: first.scope, include_renewals: true, filters: applied, cursor: 'older' }, { scope: first.scope, include_renewals: true, filters: applied }]);
    expect(f.host.text()).toContain('Applied filters:'); expect(f.host.find('data-history-filter', 'from')!.value).toBe('1970-01-01');
    const all = f.host.find('href', '#connections/others/incident-history/filter/search/Work/type/incident/outcome/retired/from/1970-01-01/through/1970-01-01'); expect(all).toBeDefined(); f.panel.dispose();
  });
  it.each(['missing echo', 'wrong echo', 'wrong row'] as const)('refuses unconfirmed filter responses: %s', mode => {
    const data = page(); const filters = { type: 'incident' as const, outcome: 'retired' as const };
    if (mode !== 'missing echo') data.filters = mode === 'wrong echo' ? { type: 'repair' } : filters;
    if (mode === 'wrong row') { data.incidents[0]!.status = 'open'; delete data.incidents[0]!.ended_at; delete data.incidents[0]!.retirement_reason; data.incidents[0]!.currently_reported = true; data.incidents[0]!.events.splice(1); }
    const f = mount(async () => data, data.scope, { filters }); return f.panel.whenLoaded().then(() => {
      expect(f.host.text()).toContain('could not confirm these history filters'); expect(f.host.find('data-authentication-incident', data.incidents[0]!.id)).toBeUndefined(); f.panel.dispose();
    });
  });
  it('keeps search drafts local until explicit Apply and navigates with the full scope and fresh filter address', async () => {
    const call = vi.fn<AuthenticationIncidentHistoryCaller>(async () => page()); const navigate = vi.fn(); const f = mount(call, page().scope, { navigate }); await f.panel.whenLoaded();
    const search = f.host.find('data-history-filter', 'search')!; search.value = ' École / report '; search.fire('input');
    const type = f.host.find('data-history-filter', 'type')!; type.value = 'verification'; type.fire('change'); expect(call).toHaveBeenCalledTimes(1); expect(navigate).not.toHaveBeenCalled();
    f.host.find('aria-label', 'Filter connection history')!.fire('submit');
    expect(parseConnectionsIncidentHistoryView(parseShellRoute(navigate.mock.calls[0]![0]).segments)).toEqual({ scope: page().scope, filters: { search: 'École / report', type: 'verification' } });
    expect(call).toHaveBeenCalledTimes(1); f.panel.dispose();
  });
  it.each(['\u0344'.repeat(65), '\ud800', '\udfff'])('rejects a search that cannot round-trip through its saved address: %j', search => {
    const call = vi.fn<AuthenticationIncidentHistoryCaller>(async () => page()); const navigate = vi.fn(); const f = mount(call, page().scope, { navigate });
    return f.panel.whenLoaded().then(() => {
      const field = f.host.find('data-history-filter', 'search')!; field.value = search; field.fire('input'); f.host.find('aria-label', 'Filter connection history')!.fire('submit');
      expect(navigate).not.toHaveBeenCalled(); expect(call).toHaveBeenCalledTimes(1); expect(f.host.text()).toContain('Search text is too long or contains unsupported characters'); f.panel.dispose();
    });
  });
  it('rejects an inverted draft date range locally and Clear retains the selected scope', async () => {
    const data = { ...page(), filters: { type: 'incident' as const } }; const call = vi.fn<AuthenticationIncidentHistoryCaller>(async () => data); const navigate = vi.fn();
    const f = mount(call, data.scope, { filters: data.filters, navigate }); await f.panel.whenLoaded();
    for (const [key, value] of [['from', '2026-10-17'], ['through', '2026-10-01']]) { const input = f.host.find('data-history-filter', key!)!; input.value = value!; input.fire('input'); }
    f.host.find('aria-label', 'Filter connection history')!.fire('submit'); expect(navigate).not.toHaveBeenCalled(); expect(call).toHaveBeenCalledTimes(1); expect(f.host.text()).toContain('Choose a valid date range');
    f.host.find('data-history-filter-action', 'clear')!.click(); expect(navigate).toHaveBeenCalledExactlyOnceWith('#connections/others/incident-history/connection/work'); f.panel.dispose();
  });
  it('preserves an edited filter and its caret through a pending history refresh', async () => {
    let release!: (p: AuthenticationIncidentHistoryPage) => void; const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValueOnce(page()).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const f = mount(call); await f.panel.whenLoaded(); const refresh = f.panel.refresh();
    const search = f.host.find('data-history-filter', 'search')!; search.value = 'draft search'; search.fire('input'); search.selectionStart = 3; search.selectionEnd = 5; search.focus!();
    release(page()); await refresh; const replacement = f.host.find('data-history-filter', 'search')!;
    expect(replacement.value).toBe('draft search'); expect(f.doc.activeElement).toBe(replacement); expect([replacement.selectionStart, replacement.selectionEnd]).toEqual([3, 5]); f.panel.dispose();
  });
  it('compares a retained recheck directly in history using local reads without refreshing incident recovery', async () => {
    const original: AuthenticationAccessVerification = { id: 'verify-12345678-1234-4123-8123-123456789abc', selection: { kind: 'group', id: 'a'.repeat(64) }, status: 'completed', started_at: 100, finished_at: 110,
      results: [{ id: 'b'.repeat(64), target: { kind: 'connection', name: 'work' }, label: 'Work API', authentication_revision: 'c'.repeat(64), current: 'no', checks: [{ kind: 'api_read', status: 'failed', reason: 'access_rejected' }] }], targets_truncated: false, uses: [], usage_available: true };
    const recheck: AuthenticationAccessVerification = { ...structuredClone(original), id: 'verify-22345678-1234-4123-8123-123456789abc', selection: { kind: 'verification', id: original.id }, started_at: 120, finished_at: 130,
      results: original.results.map(r => ({ ...r, current: 'yes', checks: [{ kind: 'api_read', status: 'passed' }] })) };
    const data = page(); data.repairs = []; data.verifications = [recheck]; data.order = [recheck.id, data.incidents[0]!.id];
    const verify = vi.fn<import('../settings/managed-oauth-panel.js').ManagedOAuthCaller>(async request => {
      if (request.action !== 'authentication_access_status') throw Error('Unexpected mutation');
      return { action: request.action, verification: request.id === original.id ? original : recheck };
    });
    const call = vi.fn<AuthenticationIncidentHistoryCaller>(async () => data); const f = mount(call, data.scope, { verify }); await f.panel.whenLoaded();
    expect(verify).not.toHaveBeenCalled(); f.host.find('data-access-compare', recheck.id)!.click(); await f.panel.whenLoaded();
    expect(f.host.find('data-access-comparison', recheck.id)).toBeDefined(); expect(verify).toHaveBeenCalledTimes(2); expect(call).toHaveBeenCalledTimes(1);
    expect(data.incidents[0]!.status).toBe('retired'); await f.panel.refresh(); expect(f.host.find('data-access-comparison', recheck.id)).toBeUndefined(); f.panel.dispose();
  });
  const renewal = (): AuthenticationRenewalHistory => ({ id: 'renewal-12345678-1234-4123-8123-123456789abc', issuer: 'google', app_id: 'default', app_revision: 2,
    app_label: '<script>Work app</script>', started_at: 100, history_started_at: 180, finished_at: 150, status: 'completed', incomplete: true, references_incomplete: true,
    results: [{ id: 'e'.repeat(64), revision: 'f'.repeat(64), label: 'Work API', connections: ['work'], native_accounts: [], eligible: true, status: 'passed', current: 'no' },
      { id: '1'.repeat(64), revision: '2'.repeat(64), label: 'Work Mail', connections: [], native_accounts: [{ platform: 'mail', slug: 'work' }],
        eligible: true, status: 'unconfirmed', reason: 'not_selected', current: 'unknown' }] });
  it('offers an opaque access-review entry only for completed renewal history without starting checks', async () => {
    const v = renewal(); const data = page(); data.incidents = []; data.repairs = []; data.renewals = [v]; data.order = [v.id];
    const verify = vi.fn<import('../settings/managed-oauth-panel.js').ManagedOAuthCaller>();
    const f = mount(async () => data, data.scope, { verify }); await f.panel.whenLoaded();
    expect(f.host.find('data-renewal-verify-access', v.id)?.attrs.get('href')).toBe('#connections/others/verify-access/renewal/' + v.id);
    expect(verify).not.toHaveBeenCalled();
    v.status = 'checking'; delete v.finished_at; v.results[0]!.status = 'unconfirmed'; v.results[0]!.reason = 'not_checked';
    await f.panel.refresh(); expect(f.host.find('data-renewal-verify-access', v.id)).toBeUndefined(); expect(verify).not.toHaveBeenCalled(); f.panel.dispose();
  });
  it('opens only a freshly compared renewal repair and offers a new verification review', async () => {
    const v = renewal(); Object.assign(v.results[0]!, { status: 'failed', reason: 'grant_rejected', current: 'yes' });
    const data = page(); data.incidents = []; data.repairs = []; data.renewals = [v]; data.order = [v.id];
    const read = vi.fn<OAuthAppsCaller>(async () => ({ action: 'renewal_status', apps: [{ issuer: 'google', id: 'default', label: 'Work', client_id: 'client', revision: 2, has_secret: true }], renewal_verification: v }));
    const navigate = vi.fn(); const f = mount(async () => data, data.scope, { renewal: read, navigate }); await f.panel.whenLoaded();
    expect(read).not.toHaveBeenCalled(); expect(f.host.text()).toContain('Re-authorize API: work');
    f.host.find('data-renewal-shortcut', v.id + ':' + v.results[0]!.id + ':0')!.click(); await f.panel.whenLoaded();
    expect(read).toHaveBeenCalledExactlyOnceWith({ action: 'renewal_status', id: v.id });
    expect(navigate).toHaveBeenCalledExactlyOnceWith('#connections/others/review-access/api/work/from-renewal/google/default');
    f.host.find('data-renewal-shortcut', v.id + ':verify')!.click(); await f.panel.whenLoaded();
    expect(navigate).toHaveBeenLastCalledWith('#connections/others/oauth-apps/google/default/renewal'); f.panel.dispose();
  });
  it('retains history and blocks a stale repair without starting consent or renewal', async () => {
    const v = renewal(); Object.assign(v.results[0]!, { status: 'failed', reason: 'client_rejected', current: 'yes' });
    const data = page(); data.incidents = []; data.repairs = []; data.renewals = [v]; data.order = [v.id]; const fresh = structuredClone(v); fresh.results[0]!.current = 'unknown';
    const read = vi.fn<OAuthAppsCaller>(async () => ({ action: 'renewal_status', apps: [{ issuer: 'google', id: 'default', label: 'Work', client_id: 'client', revision: 2, has_secret: true }], renewal_verification: fresh }));
    const navigate = vi.fn(); const f = mount(async () => data, data.scope, { renewal: read, navigate }); await f.panel.whenLoaded();
    f.host.find('data-renewal-shortcut', v.id + ':' + v.results[0]!.id + ':0')!.click(); await f.panel.whenLoaded();
    expect(navigate).not.toHaveBeenCalled(); expect(f.host.text()).toContain('could not be compared'); expect(f.host.text()).toContain('Saved renewal results');
    expect(read.mock.calls.map(([r]) => r.action)).toEqual(['renewal_status']);
    await f.panel.refresh(); expect(f.host.text()).not.toContain('The app or authorization changed, or could not be compared.'); f.panel.dispose();
  });
  it('drops a pending shortcut when the owner leaves history', async () => {
    const v = renewal(); Object.assign(v.results[0]!, { status: 'failed', reason: 'grant_rejected', current: 'yes' });
    const data = page(); data.incidents = []; data.repairs = []; data.renewals = [v]; data.order = [v.id];
    let release!: (reply: Awaited<ReturnType<OAuthAppsCaller>>) => void;
    const read = vi.fn<OAuthAppsCaller>(() => new Promise(resolve => { release = resolve; })); const navigate = vi.fn();
    const f = mount(async () => data, data.scope, { renewal: read, navigate }); await f.panel.whenLoaded();
    f.host.find('data-renewal-shortcut', v.id + ':' + v.results[0]!.id + ':0')!.click(); const waiting = f.panel.whenLoaded(); f.panel.dispose();
    release({ action: 'renewal_status', apps: [{ issuer: 'google', id: 'default', label: 'Work', client_id: 'client', revision: 2, has_secret: true }], renewal_verification: v });
    await waiting; expect(navigate).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledTimes(1);
  });
  const repair = (): AuthenticationRepairAction => ({ id: 'repair-' + 'b'.repeat(64), action: 'reauthorize', status: 'applied', started_at: 110, finished_at: 120,
    from: { type: 'direct_oauth', app_id: 'work app' }, to: { type: 'broker', broker_profile_id: 'team', broker_account_id: 'chosen-account' }, targets: [{ kind: 'connection', name: 'work' }],
    targets_truncated: false, incidents: [{ id: page().incidents[0]!.id, group_id: 'a'.repeat(64), label: 'Work' }], incidents_truncated: false });
  const relatedFixture = (): AuthenticationHistoryExport => {
    const value = historyExport({ kind: 'all' }, 45); const shared = repair(); shared.incidents = [40, 41].map(index => ({ id: value.entries[index]!.record.id, group_id: 'a'.repeat(64), label: 'Work' }));
    const verification: AuthenticationAccessVerification = { id: 'verify-12345678-1234-4123-8123-123456789abc', selection: { kind: 'repair', id: shared.id }, status: 'completed', started_at: 130, finished_at: 140,
      targets_truncated: false, usage_available: true, uses: [], results: [{ id: '3'.repeat(64), label: 'Work API', target: { kind: 'connection', name: 'work' }, authentication_revision: '4'.repeat(64), current: 'yes', checks: [{ kind: 'api_read', status: 'passed' }] }] };
    const recheck: AuthenticationAccessVerification = { ...verification, id: 'verify-22345678-1234-4123-8123-123456789abc', selection: { kind: 'verification', id: verification.id } };
    for (const record of [shared, verification, recheck]) value.entries.push({ type: authenticationHistoryEntryType(record), outcome: authenticationHistoryEntryOutcome(record), record });
    value.entry_count = value.entries.length; return value;
  };
  const openRelated = (f: ReturnType<typeof mount>, index = 40): Element => {
    const entry = f.host.find('data-history-preview-record', String(index))!; entry.open = true; entry.fire('toggle');
    const related = entry.find('data-history-preview-related', 'bundle')!; related.open = true; related.fire('toggle'); related.fire('toggle'); return related;
  };
  const largeRelatedFixture = (): AuthenticationHistoryExport => {
    const value = relatedFixture(); const shared = value.entries[45]!.record; if (!('incidents' in shared)) throw Error();
    shared.incidents = value.entries.slice(0, 45).map(entry => ({ id: entry.record.id, group_id: 'a'.repeat(64), label: 'Work' })); return value;
  };
  const openRelatedBrowser = (f: ReturnType<typeof mount>, index = 40): Element => {
    const related = openRelated(f, index); const browser = related.find('data-history-preview-related', 'records')!; browser.open = true; browser.fire('toggle'); browser.fire('toggle'); return browser;
  };
  const searchRelated = (browser: Element, text: string): void => {
    const query = browser.find('data-history-preview-related-search', 'query')!; query.value = text; query.fire('input'); browser.find('data-history-preview-related-search', 'form')!.fire('submit');
  };
  const currentLinked = (browser: Element): Element | undefined => browser.querySelectorAll('[data-history-preview-related-linked="view"]').find(view => !view.hidden);
  const savedLink = (record: Element, type: string, id: string): Element => record.querySelectorAll('[data-history-preview-control="related-link"]').find(link => link.getAttribute('data-history-preview-link-target') === JSON.stringify([type, id]))!;
  const bundleCopyFixture = async (mode: 'aliases' | 'full' = 'aliases', filtered = true) => {
    const value = relatedFixture(); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode);
    const download = vi.fn(); const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page(value.scope)); const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value);
    const f = mount(call, value.scope, { exportHistory, download }); await f.panel.whenLoaded(); const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = mode; privacy.fire('change');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded();
    if (filtered) searchPreview(f, captured.report.entries[40]!.record.id); else { f.host.find('data-history-preview-control', 'next')!.click(); f.host.find('data-history-preview-control', 'next')!.click(); }
    const related = openRelated(f); const expected = prepareAuthenticationHistoryRelatedDownload(createAuthenticationHistoryRelatedBundles(captured)(40));
    return { f, value, captured, related, expected, copy: related.find('data-history-preview-control', 'copy-bundle')!, download, call, exportHistory };
  };
  const chooseHistoryFile = (f: ReturnType<typeof mount>, text: () => Promise<string>, name = 'saved-history.json', size = 4096): Element => {
    const input = f.host.find('data-history-file', 'input')!; Reflect.set(input, 'files', [{ name, size, text }]); input.focus!(); input.fire('change'); return input;
  };
  const editPastedHistory = (f: ReturnType<typeof mount>, text: string): Element => {
    f.host.find('data-history-paste', 'panel')!.open = true; const input = f.host.find('data-history-paste', 'text')!; input.value = text; input.fire('input'); return input;
  };
  const submitPastedHistory = (f: ReturnType<typeof mount>, text?: string): void => {
    if (text !== undefined) editPastedHistory(f, text); f.host.find('data-history-paste', 'open')!.focus!(); f.host.find('data-history-paste', 'form')!.fire('submit');
  };
  const singleRecordFixture = () => {
    const value = relatedFixture(); const item = renewal(); value.entries.push({ type: 'renewal', outcome: authenticationHistoryEntryOutcome(item), record: item }); value.entry_count++; return value;
  };
  const contextChoice = (row: Element, checked: boolean): Element => {
    const choice = row.find('data-history-preview-control', 'include-record-context')!; Reflect.set(choice, 'checked', checked); choice.focus!(); choice.fire('change'); return choice;
  };
  for (const source of ['file', 'paste'] as const) for (const mode of ['aliases', 'full'] as const) it.each(['incident', 'repair', 'verification', 'renewal'] as const)('copies, downloads and reopens a %s record with optional ' + mode + ' source context from ' + source, async kind => {
    const value = singleRecordFixture(); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode); const index = captured.report.entries.findIndex(entry => entry.type === kind); const entry = captured.report.entries[index]!;
    const expected = prepareAuthenticationHistoryContextRecord(entry, authenticationHistoryRecordContext(captured, index));
    const download = vi.fn(); const write = vi.fn().mockResolvedValue(undefined); const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page(value.scope)); const exportHistory = vi.fn<AuthenticationHistoryExportCaller>();
    const f = mount(call, value.scope, { exportHistory, download }); copyBrowser(f, { clipboard: { writeText: write } }); await f.panel.whenLoaded(); submitPastedHistory(f, captured.json);
    const local = f.host.find('data-history-preview', 'file')!; const query = local.find('data-history-preview-search', 'query')!; query.value = entry.record.id; local.find('data-history-preview-search', 'form')!.fire('submit');
    const row = local.find('data-history-preview-record', String(index))!; row.open = true; row.fire('toggle');
    const originalCopy = row.find('data-history-preview-control', 'copy-record')!; const originalSave = row.find('data-history-preview-control', 'download-record')!;
    expect(Reflect.get(row.find('data-history-preview-control', 'include-record-context')!, 'checked')).toBe(false);
    originalSave.click(); expect(download.mock.calls[0]![1]).toBe(JSON.stringify(entry));
    const choice = contextChoice(row, true); expect(f.doc.activeElement).toBe(choice); originalCopy.click(); originalSave.click(); expect(write).not.toHaveBeenCalled(); expect(download).toHaveBeenCalledOnce();
    row.find('data-history-preview-control', 'copy-record')!.click(); await settleCopy(); row.find('data-history-preview-control', 'download-record')!.click();
    expect(write).toHaveBeenLastCalledWith(expected.json); expect(download).toHaveBeenLastCalledWith(expected.filename, expected.json);
    await f.panel.refresh(); expect(row.find('data-history-preview-control', 'include-record-context')).toBe(choice); expect(Reflect.get(choice, 'checked')).toBe(true);
    if (source === 'file') chooseHistoryFile(f, async () => expected.json); else submitPastedHistory(f, expected.json); await f.panel.whenLoaded();
    expect(local.find('data-history-preview-record-context', 'included')!.textContent).toContain('Other records are not included'); expect(local.text()).toContain('Source position: ' + (index + 1) + ' of ' + captured.count);
    expect(local.find('data-history-preview-field', 'source_snapshot_details')).toBeDefined(); expect(local.find('data-history-preview-field', 'report_details')).toBeUndefined(); expect(local.text()).toContain('Source snapshot details are not searched');
    expect(f.host.find('data-history-file', 'status')!.textContent).toContain('1 saved record with source context');
    local.find('data-history-preview-control', 'download')!.click(); expect(download).toHaveBeenLastCalledWith(expected.filename, expected.json);
    const openedRow = local.find('data-history-preview-record', '0')!; openedRow.open = true; openedRow.fire('toggle');
    expect(openedRow.find('data-history-preview-related', 'bundle')).toBeUndefined(); expect(openedRow.find('data-history-preview-control', 'reference')).toBeUndefined();
    openedRow.find('data-history-preview-control', 'download-record')!.click(); expect(download.mock.calls.at(-1)).toEqual(['recued-opened-connection-history-record-' + kind + '.json', JSON.stringify(entry)]);
    contextChoice(openedRow, true); openedRow.find('data-history-preview-control', 'download-record')!.click(); expect(download).toHaveBeenLastCalledWith(expected.filename, expected.json);
    const search = local.find('data-history-preview-search', 'query')!; search.value = 'no-matching-saved-record'; local.find('data-history-preview-search', 'form')!.fire('submit'); local.find('data-history-preview-control', 'download')!.click();
    expect(download).toHaveBeenLastCalledWith(expected.filename, expected.json); expect(call).toHaveBeenCalledTimes(2); expect(exportHistory).not.toHaveBeenCalled(); f.panel.dispose();
  });
  for (const direction of ['add', 'remove'] as const) it.each(['success', 'failure'] as const)('invalidates an older pending copy after choosing to ' + direction + ' source context: %s', async outcome => {
    const value = singleRecordFixture(); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'aliases');
    let finish!: () => void; let reject!: (error: Error) => void; const write = vi.fn(() => new Promise<void>((yes, no) => { finish = yes; reject = no; })); const download = vi.fn();
    const f = mount(undefined, value.scope, { download }); copyBrowser(f, { clipboard: { writeText: write } }); await f.panel.whenLoaded(); submitPastedHistory(f, captured.json);
    const row = f.host.find('data-history-preview', 'file')!.find('data-history-preview-record', '0')!; row.open = true; row.fire('toggle'); if (direction === 'remove') contextChoice(row, true);
    const old = row.find('data-history-preview-control', 'copy-record')!; const oldSave = row.find('data-history-preview-control', 'download-record')!; old.focus!(); old.click();
    const choice = contextChoice(row, direction === 'add'); const current = row.find('data-history-preview-control', 'copy-record')!; expect(current).not.toBe(old);
    if (outcome === 'success') finish(); else reject(Error('private-copy-failure')); await settleCopy();
    expect(f.doc.activeElement).toBe(choice); expect(row.find('data-history-preview-copy', 'manual-record')).toBeUndefined(); expect(row.find('data-history-preview-copy', 'record-status')!.hidden).toBe(true);
    old.click(); oldSave.click(); expect(write).toHaveBeenCalledOnce(); expect(download).not.toHaveBeenCalled();
    row.find('data-history-preview-control', 'download-record')!.click(); const saved = JSON.parse(download.mock.calls[0]![1]); expect(saved.format).toBe(direction === 'add' ? 'recued.connection-history.record' : undefined); f.panel.dispose();
  });
  it('returns focus to the context choice when it retires a focused manual-copy field', async () => {
    const value = singleRecordFixture(); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'aliases'); const f = mount(); copyBrowser(f); await f.panel.whenLoaded(); submitPastedHistory(f, captured.json);
    const row = f.host.find('data-history-preview', 'file')!.find('data-history-preview-record', '0')!; row.open = true; row.fire('toggle'); row.find('data-history-preview-control', 'copy-record')!.click();
    const manual = row.find('data-history-preview-copy', 'manual-record')!; manual.focus!(); const select = row.find('data-history-preview-control', 'select-copy-record')!; const choice = row.find('data-history-preview-control', 'include-record-context')!;
    Reflect.set(choice, 'checked', true); choice.fire('change'); expect(f.doc.activeElement).toBe(choice); expect(row.contains(manual)).toBe(false); select.click(); expect(f.doc.activeElement).toBe(choice); f.panel.dispose();
  });
  for (const mode of ['aliases', 'full'] as const) it.each(['report', 'related bundle'] as const)('keeps the original ' + mode + ' context when exporting a record from a %s related browser', async input => {
    const value = relatedFixture(); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode); const bundle = createAuthenticationHistoryRelatedBundles(captured)(40); const records = input === 'report' ? captured.report.entries : bundle.report.entries;
    const download = vi.fn(); const f = mount(undefined, value.scope, { download }); await f.panel.whenLoaded(); submitPastedHistory(f, input === 'report' ? captured.json : prepareAuthenticationHistoryRelatedDownload(bundle).json);
    const local = f.host.find('data-history-preview', 'file')!; const rootIndex = records.findIndex(entry => entry.record.id === bundle.report.root.id); const query = local.find('data-history-preview-search', 'query')!; query.value = bundle.report.root.id; local.find('data-history-preview-search', 'form')!.fire('submit');
    const related = openRelated(f, rootIndex); const browser = related.find('data-history-preview-related', 'records')!; browser.open = true; browser.fire('toggle');
    const index = records.findIndex(entry => entry.type === 'repair'); const row = browser.find('data-history-preview-related-record', String(index))!; row.open = true; row.fire('toggle');
    row.find('data-history-preview-control', 'download-record')!.click(); expect(download.mock.calls.at(-1)![0]).toMatch(input === 'report' ? /-record-repair-46\.json$/ : /-record-repair\.json$/); expect(download.mock.calls.at(-1)![1]).toBe(JSON.stringify(records[index]));
    contextChoice(row, true); row.find('data-history-preview-control', 'download-record')!.click();
    const saved = JSON.parse(download.mock.calls.at(-1)![1]); expect(saved.entry).toEqual(records[index]); expect(saved.source_snapshot.entry_count).toBe(captured.count); expect(saved.source_snapshot).toEqual(bundle.report.source_snapshot);
    expect(saved.source_position).toBe(input === 'report' ? 46 : undefined); expect(saved.privacy_mode).toBe(mode);
    if (input === 'related bundle') expect(download.mock.calls.at(-1)![0]).toMatch(/-repair-with-context\.json$/); f.panel.dispose();
  });
  for (const mode of ['aliases', 'full'] as const) it.each(['incident', 'repair'] as const)('uses only a known source position for a bare %s filename from an opened ' + mode + ' related bundle', async kind => {
    const value = relatedFixture(); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode); const bundle = createAuthenticationHistoryRelatedBundles(captured)(40);
    const download = vi.fn(); const f = mount(undefined, value.scope, { download }); await f.panel.whenLoaded(); submitPastedHistory(f, prepareAuthenticationHistoryRelatedDownload(bundle).json);
    const local = f.host.find('data-history-preview', 'file')!; const index = bundle.report.entries.findIndex(entry => entry.type === kind); const entry = bundle.report.entries[index]!; const row = local.find('data-history-preview-record', String(index))!; row.open = true; row.fire('toggle');
    const pattern = kind === 'incident' ? /-record-incident-41\.json$/ : /-record-repair\.json$/;
    row.find('data-history-preview-control', 'download-record')!.click(); expect(download.mock.calls.at(-1)![0]).toMatch(pattern); expect(download.mock.calls.at(-1)![1]).toBe(JSON.stringify(entry));
    contextChoice(row, true); row.find('data-history-preview-control', 'download-record')!.click(); const context = JSON.parse(download.mock.calls.at(-1)![1]); expect(context.source_position).toBe(kind === 'incident' ? 41 : undefined);
    contextChoice(row, false); row.find('data-history-preview-control', 'download-record')!.click(); expect(download.mock.calls.at(-1)![0]).toMatch(pattern); expect(download.mock.calls.at(-1)![1]).toBe(JSON.stringify(entry)); f.panel.dispose();
  });
  it.each(['file', 'paste'] as const)('retains the selected record context and earlier preview after invalid %s replacement', async source => {
    const value = singleRecordFixture(); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'aliases'); const expected = prepareAuthenticationHistoryContextRecord(captured.report.entries[0]!, authenticationHistoryRecordContext(captured, 0));
    const f = mount(); await f.panel.whenLoaded(); submitPastedHistory(f, expected.json); const local = f.host.find('data-history-preview', 'file')!; const row = local.find('data-history-preview-record', '0')!; row.open = true; row.fire('toggle'); const choice = contextChoice(row, true);
    const query = local.find('data-history-preview-search', 'query')!; query.value = 'retained draft'; query.setSelectionRange(2, 6);
    const invalid = JSON.stringify({ ...expected.envelope, source_position: 0 }); if (source === 'file') chooseHistoryFile(f, async () => invalid); else submitPastedHistory(f, invalid); await f.panel.whenLoaded();
    expect(local.find('data-history-preview-record-context', 'included')).toBeDefined(); expect(row.find('data-history-preview-control', 'include-record-context')).toBe(choice); expect(Reflect.get(choice, 'checked')).toBe(true); expect([query.value, query.selectionStart, query.selectionEnd]).toEqual(['retained draft', 2, 6]); f.panel.dispose();
  });
  it('keeps bare record actions usable when adding context would exceed 8 MiB', async () => {
    const value = historyExport({ kind: 'all' }, 1); const record = value.entries[0]!.record; if (!('group' in record)) throw Error(); record.group.uses = Array.from({ length: 5000 }, (_, n) => ({ kind: 'pack', id: 'pack-' + n, label: 'x' }));
    let missing = AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES - prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'full').bytes;
    for (const use of record.group.uses) { const add = Math.min(missing, 2048 - use.label.length); use.label += 'x'.repeat(add); missing -= add; } expect(missing).toBe(0);
    const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'full'); const download = vi.fn(); const f = mount(undefined, value.scope, { download }); await f.panel.whenLoaded(); submitPastedHistory(f, captured.json);
    const row = f.host.find('data-history-preview', 'file')!.find('data-history-preview-record', '0')!; row.open = true; row.fire('toggle'); const copy = row.find('data-history-preview-control', 'copy-record')!; const choice = contextChoice(row, true);
    expect(Reflect.get(choice, 'checked')).toBe(false); expect(row.find('data-history-preview-record-context-error', 'record')!.textContent).toContain('8 MiB'); expect(row.find('data-history-preview-control', 'copy-record')).toBe(copy);
    row.find('data-history-preview-control', 'download-record')!.click(); expect(download.mock.calls[0]![1]).toBe(JSON.stringify(captured.report.entries[0])); f.panel.dispose();
  });
  for (const source of ['file', 'paste'] as const) for (const mode of ['aliases', 'full'] as const) it.each(['incident', 'repair', 'verification', 'renewal'] as const)('opens a %s record from ' + source + ' in ' + mode + ' format without inventing report context', async kind => {
    const value = singleRecordFixture(); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode); const entry = captured.report.entries.find(entry => entry.type === kind)!; const json = JSON.stringify(entry);
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page()); const exportHistory = vi.fn<AuthenticationHistoryExportCaller>(); const download = vi.fn(); const write = vi.fn().mockResolvedValue(undefined);
    const f = mount(call, page().scope, { exportHistory, download }); copyBrowser(f, { clipboard: { writeText: write } }); await f.panel.whenLoaded();
    if (source === 'file') chooseHistoryFile(f, async () => '\uFEFF' + JSON.stringify(entry, null, 2)); else submitPastedHistory(f, '\uFEFF' + JSON.stringify(entry, null, 2)); await f.panel.whenLoaded();
    const local = f.host.find('data-history-preview', 'file')!; expect(local.text()).toContain(source === 'file' ? 'Saved history record' : 'Pasted history record');
    expect(local.find('data-history-preview-search', 'form')!.getAttribute('aria-label')).toBe('Search saved history record');
    expect(local.find('data-history-preview-record-context', 'unknown')!.textContent).toContain('original privacy settings are unknown'); expect(local.text()).toContain('1 saved record.');
    expect(local.text()).not.toContain('Snapshot captured'); expect(local.text()).not.toContain('Privacy mode:'); expect(local.find('data-history-preview-field', 'report_details')).toBeUndefined();
    const row = local.find('data-history-preview-record', '0')!; row.open = true; row.fire('toggle'); expect(local.find('data-history-preview-related', 'bundle')).toBeUndefined();
    expect(row.find('data-history-preview-control', 'include-record-context')).toBeUndefined();
    expect(local.find('data-history-preview-control', 'reference')).toBeUndefined(); expect(local.text()).not.toContain('View referenced');
    row.find('data-history-preview-control', 'copy-record')!.click(); await settleCopy(); expect(write).toHaveBeenCalledExactlyOnceWith(json);
    local.find('data-history-preview-control', 'download')!.click(); row.find('data-history-preview-control', 'download-record')!.click();
    expect(download.mock.calls).toEqual(Array.from({ length: 2 }, () => ['recued-opened-connection-history-record-' + kind + '.json', json]));
    const query = local.find('data-history-preview-search', 'query')!; query.value = entry.record.id; local.find('data-history-preview-search', 'form')!.fire('submit'); expect(local.text()).toContain('saved record matches');
    query.value = 'not-a-matching-saved-record'; local.find('data-history-preview-search', 'form')!.fire('submit'); expect(local.text()).toContain('complete record is still included in the download');
    local.find('data-history-preview-control', 'download')!.click(); expect(download.mock.calls[2]![1]).toBe(json); expect(call).toHaveBeenCalledOnce(); expect(exportHistory).not.toHaveBeenCalled(); f.panel.dispose();
  });
  it.each(['aliases', 'full'] as const)('does not resolve self-references or turn a standalone %s record into a related report', async mode => {
    const value = singleRecordFixture(); const item = value.entries.find(entry => entry.type === 'verification')!.record as AuthenticationAccessVerification; item.selection = { kind: 'verification', id: item.id };
    const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode); const entry = captured.report.entries.find(entry => entry.type === 'verification')!; const f = mount(); await f.panel.whenLoaded(); submitPastedHistory(f, JSON.stringify(entry));
    const local = f.host.find('data-history-preview', 'file')!; const row = local.find('data-history-preview-record', '0')!; row.open = true; row.fire('toggle');
    expect(row.text()).toContain('Referenced record context is not included'); expect(row.find('data-history-preview-control', 'reference')).toBeUndefined(); expect(row.find('data-history-preview-related', 'bundle')).toBeUndefined(); f.panel.dispose();
  });
  it.each(['file', 'paste'] as const)('keeps a standalone record preview and its search draft after invalid %s replacements', async source => {
    const captured = prepareAuthenticationHistoryDownload(historyExport(page().scope, 1), { scope: page().scope }, 'aliases'); const entry = captured.report.entries[0]!; const f = mount(); await f.panel.whenLoaded(); submitPastedHistory(f, JSON.stringify(entry));
    const local = f.host.find('data-history-preview', 'file')!; const query = local.find('data-history-preview-search', 'query')!; query.value = 'Retained record search'; query.setSelectionRange(2, 8);
    if (source === 'file') chooseHistoryFile(f, async () => JSON.stringify({ ...entry, outcome: 'invented' })); else submitPastedHistory(f, JSON.stringify({ ...entry, outcome: 'invented' })); await f.panel.whenLoaded();
    expect(local.find('data-history-preview-search', 'query')).toBe(query); expect([query.value, query.selectionStart, query.selectionEnd]).toEqual(['Retained record search', 2, 8]); expect(local.text()).toContain('Pasted history record'); expect(f.host.find('data-history-file', 'error')!.hidden).toBe(false); f.panel.dispose();
  });
  it.each(['record first', 'report first'] as const)('replaces checked records and reports while invalidating old record actions: %s', async order => {
    const value = singleRecordFixture(); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'aliases'); const entry = captured.report.entries[0]!; const download = vi.fn(); const f = mount(undefined, page().scope, { download }); await f.panel.whenLoaded();
    submitPastedHistory(f, order === 'record first' ? JSON.stringify(entry) : captured.json); const local = f.host.find('data-history-preview', 'file')!; const old = local.find('data-history-preview-control', 'download')!;
    chooseHistoryFile(f, async () => order === 'record first' ? captured.json : JSON.stringify(entry)); await f.panel.whenLoaded(); const before = local.text(); old.click(); expect(local.text()).toBe(before); expect(download).not.toHaveBeenCalled();
    expect(local.find('data-history-preview-search', 'form')!.getAttribute('aria-label')).toBe(order === 'record first' ? 'Search history export preview' : 'Search saved history record');
    local.find('data-history-preview-control', 'download')!.click(); expect(download.mock.calls[0]![1]).toBe(order === 'record first' ? captured.json : JSON.stringify(entry)); f.panel.dispose();
  });
  it.each(['file', 'paste', 'live'] as const)('keeps newer focus and scroll intent when opening a %s preview redirects focus', async source => {
    const value = historyExport(page().scope, 1); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'aliases'); const f = mount(undefined, value.scope, { exportHistory: async () => value }); await f.panel.whenLoaded();
    const outside = f.host.find('data-history-filter', 'search')!; const scroll = vi.fn(); const create = f.doc.createElement;
    const label = source === 'paste' ? 'Pasted history JSON' : source === 'file' ? 'Saved history file' : 'History export preview';
    f.doc.createElement = () => {
      const node = create(); const focus = node.focus!;
      node.focus = options => { focus(options); if (node.textContent === label) outside.focus!({ preventScroll: true }); };
      Reflect.set(node, 'scrollIntoView', () => { if (node.textContent === label) scroll(); }); return node;
    };
    if (source === 'paste') submitPastedHistory(f, captured.json);
    else if (source === 'file') chooseHistoryFile(f, async () => captured.json);
    else {
      const open = f.host.find('data-history-export', 'preview')!; open.focus!(); open.click();
      // Native browsers blur the export button when it becomes disabled.
      f.doc.activeElement = f.doc.body;
    }
    await f.panel.whenLoaded(); expect(f.host.find('data-history-preview', source === 'live' ? 'report' : 'file')!.hidden).toBe(false); expect(f.doc.activeElement).toBe(outside); expect(scroll).not.toHaveBeenCalled(); f.panel.dispose();
  });
  it.each(['aliases', 'full'] as const)('opens %s pasted JSON only on explicit submit and keeps later edits out of its downloaded snapshot', async mode => {
    const value = historyExport({ kind: 'all' }); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode); const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page()); const exportHistory = vi.fn<AuthenticationHistoryExportCaller>(); const download = vi.fn();
    const f = mount(call, page().scope, { exportHistory, download }); const clipboard = vi.fn(() => { throw Error('clipboard must not be read'); }); copyBrowser(f, Object.defineProperty({}, 'clipboard', { get: clipboard })); await f.panel.whenLoaded();
    expect(f.host.find('data-history-paste', 'panel')!.open).toBe(false); expect(f.host.find('data-history-paste', 'open')!.disabled).toBe(true);
    const raw = '\uFEFF' + JSON.stringify(JSON.parse(captured.json), null, 2); const editor = editPastedHistory(f, raw); const local = f.host.find('data-history-preview', 'file')!; expect(local.hidden).toBe(true); expect(download).not.toHaveBeenCalled();
    submitPastedHistory(f); await f.panel.whenLoaded(); expect(local.hidden).toBe(false); expect(local.text()).toContain('Pasted history JSON'); expect(local.text()).toContain('Opened from pasted JSON.'); expect(local.text()).toContain('68 saved records in this JSON'); expect(local.find('data-history-preview-file', 'name')).toBeUndefined(); expect(local.contains(f.doc.activeElement)).toBe(true); expect(editor.value).toBe(raw);
    const query = local.find('data-history-preview-search', 'query')!; query.value = captured.report.entries[40]!.record.id; local.find('data-history-preview-search', 'form')!.fire('submit'); expect(local.text()).toContain('Matching records 1–1 of 1');
    editPastedHistory(f, '{unapplied edit'); local.find('data-history-preview-control', 'download')!.click(); expect(download.mock.calls[0]![1]).toBe(captured.json); expect(editor.value).toBe('{unapplied edit'); expect(call).toHaveBeenCalledOnce(); expect(exportHistory).not.toHaveBeenCalled(); expect(clipboard).not.toHaveBeenCalled(); f.panel.dispose();
  });
  it.each(['aliases', 'full'] as const)('preserves %s pasted bundle roots, aliases, limits and exact copy/download bytes', async mode => {
    const value = relatedFixture(); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode); const bundle = createAuthenticationHistoryRelatedBundles(captured)(40); const prepared = prepareAuthenticationHistoryRelatedDownload(bundle);
    const download = vi.fn(); const write = vi.fn().mockResolvedValue(undefined); const f = mount(undefined, page().scope, { download }); copyBrowser(f, { clipboard: { writeText: write } }); await f.panel.whenLoaded(); submitPastedHistory(f, prepared.json); await f.panel.whenLoaded();
    const local = f.host.find('data-history-preview', 'file')!; expect(local.text()).toContain('subset of the source snapshot'); expect(local.text()).toContain('5 saved records in this JSON'); const index = bundle.report.entries.findIndex(entry => entry.record.id === bundle.report.root.id); const row = local.find('data-history-preview-record', String(index))!; row.open = true; row.fire('toggle');
    const related = row.find('data-history-preview-related', 'bundle')!; related.open = true; related.fire('toggle'); related.find('data-history-preview-control', 'copy-bundle')!.click(); await settleCopy(); expect(write).toHaveBeenCalledExactlyOnceWith(prepared.json); related.find('data-history-preview-control', 'download-related')!.click(); expect(download.mock.calls[0]![1]).toBe(prepared.json);
    editPastedHistory(f, '{}'); local.find('data-history-preview-control', 'download')!.click(); expect(download.mock.calls[1]![1]).toBe(prepared.json); f.panel.dispose();
  });
  it.each(['file', 'paste'] as const)('keeps the earlier %s preview and navigation when pasted JSON is invalid', async source => {
    const captured = prepareAuthenticationHistoryDownload(historyExport(), { scope: page().scope }, 'aliases'); const f = mount(); await f.panel.whenLoaded(); if (source === 'file') chooseHistoryFile(f, async () => captured.json); else submitPastedHistory(f, captured.json); await f.panel.whenLoaded();
    const local = f.host.find('data-history-preview', 'file')!; local.find('data-history-preview-control', 'next')!.click(); const range = local.find('data-history-preview-range', 'records')!; const before = range.textContent; const query = local.find('data-history-preview-search', 'query')!; query.value = 'Kept review draft'; query.setSelectionRange(2, 5);
    submitPastedHistory(f, '{private-paste-error'); await f.panel.whenLoaded(); expect(local.hidden).toBe(false); expect(local.find('data-history-preview-range', 'records')).toBe(range); expect(range.textContent).toBe(before); expect([query.value, query.selectionStart, query.selectionEnd]).toEqual(['Kept review draft', 2, 5]);
    const editor = f.host.find('data-history-paste', 'text')!; expect(editor.value).toBe('{private-paste-error'); expect(editor.getAttribute('aria-invalid')).toBe('true'); const error = f.host.find('data-history-file', 'error')!; expect(error.textContent).toContain(source === 'file' ? 'earlier file remains open' : 'earlier JSON preview remains open'); expect(error.textContent).not.toContain('private-paste-error');
    editPastedHistory(f, captured.json); expect(error.hidden).toBe(true); expect(editor.getAttribute('aria-invalid')).toBe('false'); expect(local.find('data-history-preview-range', 'records')).toBe(range); f.panel.dispose();
  });
  it.each(['length', 'UTF-8 bytes'] as const)('refuses excessive pasted %s without replacing the valid preview or truncating the editor', async limit => {
    const captured = prepareAuthenticationHistoryDownload(historyExport(page().scope, 1), { scope: page().scope }, 'aliases'); const f = mount(); await f.panel.whenLoaded(); submitPastedHistory(f, captured.json); const local = f.host.find('data-history-preview', 'file')!; const before = local.text();
    const raw = limit === 'length' ? ' '.repeat(AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES + 1) : 'é'.repeat(AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES / 2 + 1); submitPastedHistory(f, raw); await f.panel.whenLoaded();
    expect(local.text()).toBe(before); expect(f.host.find('data-history-paste', 'text')!.value).toBe(raw); expect(f.host.find('data-history-file', 'error')!.textContent).toContain('8 MiB'); expect(f.host.find('data-history-paste', 'text')!.getAttribute('aria-invalid')).toBe('true'); f.panel.dispose();
  });
  it.each(['valid', 'invalid'] as const)('lets an explicit %s paste supersede a pending file read and discards either late outcome', async validity => {
    for (const outcome of ['resolve', 'reject']) {
      const first = prepareAuthenticationHistoryDownload(historyExport(page().scope, 1), { scope: page().scope }, 'aliases'); const second = prepareAuthenticationHistoryDownload(historyExport(page().scope, 2), { scope: page().scope }, 'aliases'); const f = mount(); await f.panel.whenLoaded(); submitPastedHistory(f, first.json);
      let finish!: (text: string) => void; let refuse!: () => void; chooseHistoryFile(f, () => new Promise((resolve, reject) => { finish = resolve; refuse = () => reject(Error('private-late-file')); }));
      submitPastedHistory(f, validity === 'valid' ? second.json : '{invalid'); await f.panel.whenLoaded(); expect(f.host.find('data-history-file', 'panel')!.getAttribute('aria-busy')).toBe('false'); const before = f.host.text(); const focus = f.doc.activeElement;
      if (outcome === 'resolve') finish(first.json); else refuse(); await settleCopy(); await f.panel.whenLoaded(); expect(f.host.text()).toBe(before); expect(f.doc.activeElement).toBe(focus); expect(f.host.text()).not.toContain('private-late-file'); f.panel.dispose();
    }
  });
  it('keeps an unapplied paste draft, focus and caret when a pending file completes', async () => {
    const captured = prepareAuthenticationHistoryDownload(historyExport(), { scope: page().scope }, 'aliases'); const f = mount(); await f.panel.whenLoaded(); let finish!: (text: string) => void; chooseHistoryFile(f, () => new Promise(resolve => { finish = resolve; }));
    const editor = editPastedHistory(f, '{unapplied paste draft'); editor.setSelectionRange(2, 8); editor.focus!(); finish(captured.json); await f.panel.whenLoaded(); expect(f.doc.activeElement).toBe(editor); expect([editor.value, editor.selectionStart, editor.selectionEnd]).toEqual(['{unapplied paste draft', 2, 8]); expect(f.host.find('data-history-preview', 'file')!.text()).toContain('Saved history file'); f.panel.dispose();
  });
  it.each(['close', 'clear'] as const)('returns to the retained paste editor after %s without changing the draft', async action => {
    const captured = prepareAuthenticationHistoryDownload(historyExport(page().scope, 1), { scope: page().scope }, 'aliases'); const f = mount(); await f.panel.whenLoaded(); submitPastedHistory(f, captured.json); const editor = editPastedHistory(f, '{next draft'); f.host.find('data-history-paste', 'panel')!.open = false;
    if (action === 'close') f.host.find('data-history-preview', 'file')!.find('data-history-preview-control', 'close')!.click(); else f.host.find('data-history-file', 'clear')!.click();
    expect(f.host.find('data-history-preview', 'file')!.hidden).toBe(true); expect(f.host.find('data-history-paste', 'panel')!.open).toBe(true); expect(editor.value).toBe('{next draft'); expect(f.doc.activeElement).toBe(editor); f.panel.dispose();
  });
  it('clears pasted text independently of the current preview and keeps its editor stable through history refresh', async () => {
    const captured = prepareAuthenticationHistoryDownload(historyExport(page().scope, 1), { scope: page().scope }, 'aliases'); const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page()); const f = mount(call); await f.panel.whenLoaded(); submitPastedHistory(f, captured.json); const local = f.host.find('data-history-preview', 'file')!; const before = local.text(); const editor = editPastedHistory(f, '{draft'); editor.setSelectionRange(1, 4); editor.focus!(); await f.panel.refresh();
    expect(f.host.find('data-history-paste', 'text')).toBe(editor); expect([editor.value, editor.selectionStart, editor.selectionEnd]).toEqual(['{draft', 1, 4]); expect(f.doc.activeElement).toBe(editor); f.host.find('data-history-paste', 'clear')!.click(); expect(editor.value).toBe(''); expect(local.text()).toBe(before); expect(f.host.find('data-history-paste', 'open')!.disabled).toBe(true); expect(f.doc.activeElement).toBe(editor); expect(call).toHaveBeenCalledTimes(2); f.panel.dispose();
  });
  it('keeps file errors when a paste draft is edited or cleared, and ignores old forms after disposal', async () => {
    const f = mount(); await f.panel.whenLoaded(); submitPastedHistory(f, '{invalid'); expect(f.host.find('data-history-file', 'error')!.hidden).toBe(false); chooseHistoryFile(f, async () => { throw Error('private-file-error'); }); await f.panel.whenLoaded(); const error = f.host.find('data-history-file', 'error')!; const before = error.textContent;
    const editor = editPastedHistory(f, 'draft'); f.host.find('data-history-paste', 'clear')!.click(); expect(error.hidden).toBe(false); expect(error.textContent).toBe(before); editPastedHistory(f, 'discarded draft'); const form = f.host.find('data-history-paste', 'form')!; f.panel.dispose(); expect(editor.value).toBe(''); const text = f.host.text(); const focus = f.doc.activeElement; editor.value = '{}'; form.fire('submit'); editor.fire('input'); expect(f.host.text()).toBe(text); expect(f.doc.activeElement).toBe(focus);
  });
  it.each(['aliases', 'full'] as const)('opens a %s saved file without a server export and keeps its searchable snapshot on refresh', async mode => {
    const value = historyExport({ kind: 'all' }); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode); const download = vi.fn(); const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page());
    const f = mount(call, page().scope, { download }); await f.panel.whenLoaded(); const read = vi.fn().mockResolvedValue(captured.json); chooseHistoryFile(f, read, '<saved history>.json'); await f.panel.whenLoaded();
    const local = f.host.find('data-history-preview', 'file')!; expect(local.hidden).toBe(false); expect(local.text()).toContain('Opened locally: <saved history>.json'); expect(local.text()).toContain('68 saved records in this file'); expect(local.text()).toContain('not authenticated evidence'); expect(local.text()).not.toContain('Verify access'); expect(read).toHaveBeenCalledOnce();
    local.find('data-history-preview-control', 'next')!.click(); expect(local.text()).toContain('Records 21–40 of 68'); const query = local.find('data-history-preview-search', 'query')!; query.value = captured.report.entries[40]!.record.id; local.find('data-history-preview-search', 'form')!.fire('submit'); expect(local.text()).toContain('Matching records 1–1 of 1');
    query.value = 'Unapplied local draft'; query.setSelectionRange(2, 8); query.focus!(); await f.panel.refresh(); expect(f.host.find('data-history-preview', 'file')).toBe(local); expect(f.doc.activeElement).toBe(query); expect([query.value, query.selectionStart, query.selectionEnd]).toEqual(['Unapplied local draft', 2, 8]);
    local.find('data-history-preview-control', 'download')!.click(); expect(download).toHaveBeenCalledOnce(); expect(download.mock.calls[0]![1]).toBe(captured.json); expect(call).toHaveBeenCalledTimes(2); expect(f.panel.hasDraft()).toBe(false); f.panel.dispose();
  });
  it.each(['aliases', 'full'] as const)('opens the original %s related bundle without widening its source scope or changing copied JSON', async mode => {
    const value = relatedFixture(); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode); const bundle = createAuthenticationHistoryRelatedBundles(captured)(40); const prepared = prepareAuthenticationHistoryRelatedDownload(bundle);
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page()); const exportHistory = vi.fn<AuthenticationHistoryExportCaller>(); const download = vi.fn(); const f = mount(call, page().scope, { exportHistory, download }); const write = vi.fn().mockResolvedValue(undefined); copyBrowser(f, { clipboard: { writeText: write } }); await f.panel.whenLoaded();
    chooseHistoryFile(f, async () => prepared.json); await f.panel.whenLoaded(); const local = f.host.find('data-history-preview', 'file')!; expect(local.text()).toContain('subset of the source snapshot'); expect(local.text()).toContain('5 saved records in this file');
    const rootIndex = bundle.report.entries.findIndex(entry => entry.record.id === bundle.report.root.id); const root = local.find('data-history-preview-record', String(rootIndex))!; root.open = true; root.fire('toggle'); const related = root.find('data-history-preview-related', 'bundle')!; related.open = true; related.fire('toggle');
    related.find('data-history-preview-control', 'copy-bundle')!.click(); await settleCopy(); expect(write).toHaveBeenCalledExactlyOnceWith(prepared.json); related.find('data-history-preview-control', 'download-related')!.click(); expect(download.mock.calls[0]![1]).toBe(prepared.json);
    const otherIndex = bundle.report.entries.findIndex(entry => entry.type === 'incident' && entry.record.id !== bundle.report.root.id); const other = local.find('data-history-preview-record', String(otherIndex))!; other.open = true; other.fire('toggle'); expect(other.find('data-history-preview-related', 'bundle')).toBeUndefined();
    expect(exportHistory).not.toHaveBeenCalled(); expect(call).toHaveBeenCalledOnce(); f.panel.dispose();
  });
  it('keeps local and live previews independent across privacy changes, close and clear', async () => {
    const value = historyExport(); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'aliases'); const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value); const f = mount(async () => page(), page().scope, { exportHistory }); await f.panel.whenLoaded();
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); const live = f.host.find('data-history-preview', 'report')!; chooseHistoryFile(f, async () => captured.json); await f.panel.whenLoaded(); const local = f.host.find('data-history-preview', 'file')!;
    expect(live.hidden).toBe(false); expect(local.hidden).toBe(false); const input = f.host.find('data-history-file', 'input')!; Reflect.set(input, 'files', []); input.fire('change'); expect(local.hidden).toBe(false);
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change'); expect(live.hidden).toBe(true); expect(local.hidden).toBe(false); expect(local.text()).toContain('Privacy mode: aliases');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); local.find('data-history-preview-control', 'close')!.click(); expect(local.hidden).toBe(true); expect(live.hidden).toBe(false); expect(f.doc.activeElement).toBe(input);
    chooseHistoryFile(f, async () => captured.json); await f.panel.whenLoaded(); f.host.find('data-history-file', 'clear')!.click(); expect(local.hidden).toBe(true); expect(live.hidden).toBe(false); expect(f.host.find('data-history-file', 'status')!.hidden).toBe(true); expect(exportHistory).toHaveBeenCalledTimes(2); f.panel.dispose();
  });
  it('keeps a valid file and its draft after malformed or unreadable replacements and rejects oversized files before reading', async () => {
    const captured = prepareAuthenticationHistoryDownload(historyExport(), { scope: page().scope }, 'aliases'); const f = mount(); await f.panel.whenLoaded(); chooseHistoryFile(f, async () => captured.json); await f.panel.whenLoaded(); const local = f.host.find('data-history-preview', 'file')!; const query = local.find('data-history-preview-search', 'query')!; query.value = 'Kept draft'; query.setSelectionRange(1, 4);
    for (const read of [async () => '{private-invalid-json', async () => { throw Error('private-file-read-error'); }]) {
      chooseHistoryFile(f, read); await f.panel.whenLoaded(); expect(local.hidden).toBe(false); expect(local.find('data-history-preview-search', 'query')).toBe(query); expect([query.value, query.selectionStart, query.selectionEnd]).toEqual(['Kept draft', 1, 4]); expect(f.host.find('data-history-file', 'error')!.textContent).toContain('earlier file remains open'); expect(f.host.text()).not.toContain('private-file-read-error'); expect(f.host.text()).not.toContain('private-invalid-json');
    }
    const read = vi.fn().mockResolvedValue(captured.json); chooseHistoryFile(f, read, 'large.json', AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES + 1); await f.panel.whenLoaded(); expect(read).not.toHaveBeenCalled(); expect(f.host.find('data-history-file', 'error')!.textContent).toContain('8 MiB'); expect(local.hidden).toBe(false); f.panel.dispose();
  });
  it.each(['replacement', 'clear', 'close', 'dispose'] as const)('discards a late file read after %s', async phase => {
    const first = prepareAuthenticationHistoryDownload(historyExport(page().scope, 1), { scope: page().scope }, 'aliases'); const second = prepareAuthenticationHistoryDownload(historyExport(page().scope, 2), { scope: page().scope }, 'aliases'); const f = mount(); await f.panel.whenLoaded();
    if (phase === 'close') { chooseHistoryFile(f, async () => first.json); await f.panel.whenLoaded(); }
    let finish!: (text: string) => void; const input = chooseHistoryFile(f, () => new Promise(resolve => { finish = resolve; }), 'slow.json');
    if (phase === 'replacement') { chooseHistoryFile(f, async () => second.json, 'newer.json'); await f.panel.whenLoaded(); }
    else if (phase === 'clear') f.host.find('data-history-file', 'clear')!.click(); else if (phase === 'close') f.host.find('data-history-preview', 'file')!.find('data-history-preview-control', 'close')!.click(); else f.panel.dispose();
    const before = f.host.text(); const focus = f.doc.activeElement; finish(first.json); await settleCopy(); await f.panel.whenLoaded(); expect(f.host.text()).toBe(before); expect(f.doc.activeElement).toBe(focus);
    if (phase === 'dispose') { input.fire('change'); await settleCopy(); expect(f.host.text()).toBe(before); } f.panel.dispose();
  });
  it('preserves newer live-filter focus and caret when a file finishes reading', async () => {
    const captured = prepareAuthenticationHistoryDownload(historyExport(), { scope: page().scope }, 'aliases'); const f = mount(); await f.panel.whenLoaded(); let finish!: (text: string) => void; chooseHistoryFile(f, () => new Promise(resolve => { finish = resolve; }));
    const draft = f.host.find('data-history-filter', 'search')!; draft.value = 'Newer server filter draft'; draft.setSelectionRange(3, 7); draft.focus!(); finish(captured.json); await f.panel.whenLoaded();
    expect(f.doc.activeElement).toBe(draft); expect([draft.value, draft.selectionStart, draft.selectionEnd]).toEqual(['Newer server filter draft', 3, 7]); expect(f.host.find('data-history-preview', 'file')!.hidden).toBe(false); f.panel.dispose();
  });
  it.each(['search', 'manual copy'] as const)('moves focus from a replaced file %s control to the new preview heading', async field => {
    const first = prepareAuthenticationHistoryDownload(historyExport(page().scope, 1), { scope: page().scope }, 'aliases'); const second = prepareAuthenticationHistoryDownload(historyExport(page().scope, 2), { scope: page().scope }, 'aliases');
    const f = mount(); await f.panel.whenLoaded(); copyBrowser(f); chooseHistoryFile(f, async () => first.json); await f.panel.whenLoaded();
    let finish!: (text: string) => void; chooseHistoryFile(f, () => new Promise(resolve => { finish = resolve; }), 'replacement.json'); const local = f.host.find('data-history-preview', 'file')!;
    let focused = local.find('data-history-preview-search', 'query')!;
    if (field === 'manual copy') { const row = local.find('data-history-preview-record', '0')!; row.open = true; row.fire('toggle'); const copy = row.find('data-history-preview-control', 'copy-record')!; copy.focus!(); copy.click(); focused = row.find('data-history-preview-copy', 'manual-record')!; }
    focused.focus!(); expect(f.doc.activeElement).toBe(focused); finish(second.json); await f.panel.whenLoaded();
    expect(local.text()).toContain('2 saved records in this file'); expect(local.contains(focused)).toBe(false); expect(local.contains(f.doc.activeElement)).toBe(true); expect(Reflect.get(f.doc.activeElement, 'id')).toBe(local.getAttribute('aria-labelledby')); f.panel.dispose();
  });
  it.each(['aliases', 'full'] as const)('copies the complete %s bundle only on request and keeps download bytes and navigation intact', async mode => {
    const x = await bundleCopyFixture(mode); const write = vi.fn(function(this: { tag: string }, _text: string) { expect(this.tag).toBe('bundle'); return Promise.resolve(); }); copyBrowser(x.f, { clipboard: { tag: 'bundle', writeText: write } });
    expect(x.related.find('data-history-preview-copy', 'manual-bundle')).toBeUndefined(); expect(x.copy.getAttribute('aria-label')).toContain(x.captured.report.entries[40]!.record.id);
    const browser = openRelatedBrowser(x.f); searchRelated(browser, 'Closed without confirmed recovery'); const row = browser.find('data-history-preview-related-record', '40')!; row.open = true; row.fire('toggle'); savedLink(row, 'repair', x.captured.report.entries[45]!.record.id).click(); const pane = currentLinked(browser)!;
    const draft = browser.find('data-history-preview-related-search', 'query')!; draft.value = 'Unapplied bundle draft'; draft.setSelectionRange(2, 7);
    x.copy.focus!(); x.copy.click(); await settleCopy(); expect(write).toHaveBeenCalledExactlyOnceWith(x.expected.json); expect(x.f.doc.activeElement).toBe(x.copy); expect(currentLinked(browser)).toBe(pane); expect([draft.value, draft.selectionStart, draft.selectionEnd]).toEqual(['Unapplied bundle draft', 2, 7]);
    expect(JSON.parse(write.mock.calls[0]![0])).toMatchObject({ format: 'recued.connection-history.related', privacy_mode: mode, entry_count: 5, current_authentication: 'not_checked', root: { id: x.captured.report.entries[40]!.record.id } });
    const save = x.related.find('data-history-preview-control', 'download-related')!; save.click(); expect(x.download).toHaveBeenCalledExactlyOnceWith(x.expected.filename, x.expected.json);
    expect(x.related.find('data-history-preview-copy', 'bundle-status')!.textContent).toBe('Related history JSON copied.'); expect(x.related.find('data-history-preview-related', 'status')!.textContent).toBe('Related history download requested.');
    x.value.entries.length = 1; await x.f.panel.refresh(); expect(x.related.find('data-history-preview-control', 'copy-bundle')).toBe(x.copy); x.copy.click(); await settleCopy(); expect(write).toHaveBeenLastCalledWith(x.expected.json);
    savePreview(x.f); expect(x.download).toHaveBeenLastCalledWith(x.captured.filename, x.captured.json); expect(x.call).toHaveBeenCalledTimes(2); expect(x.exportHistory).toHaveBeenCalledTimes(1); expect(x.f.panel.hasDraft()).toBe(false); x.f.panel.dispose();
  });
  it('does not serialize a bundle until its copy or download is explicitly requested', async () => {
    const value = relatedFixture(); const f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value }); await f.panel.whenLoaded(); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'incident-41');
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      const related = openRelated(f); const bundleCalls = () => stringify.mock.calls.filter(([value]) => value && typeof value === 'object' && value.format === 'recued.connection-history.related');
      expect(bundleCalls()).toHaveLength(0); const write = vi.fn().mockResolvedValue(undefined); copyBrowser(f, { clipboard: { writeText: write } }); related.find('data-history-preview-control', 'copy-bundle')!.click(); await settleCopy(); expect(bundleCalls()).toHaveLength(1); expect(write).toHaveBeenCalledTimes(1);
    } finally { stringify.mockRestore(); f.panel.dispose(); }
  });
  it.each(['missing', 'getter', 'method getter', 'throw', 'reject'] as const)('offers exact read-only bundle JSON after clipboard %s and supports explicit retry', async failure => {
    for (const mode of ['aliases', 'full'] as const) {
      const x = await bundleCopyFixture(mode); const navigator = {}; const clipboard = copyBrowser(x.f, navigator);
      const fail = () => { throw Error('private-bundle-copy-error'); };
      if (failure === 'getter') Object.defineProperty(navigator, 'clipboard', { configurable: true, get: fail });
      else if (failure === 'method getter') Object.defineProperty(navigator, 'clipboard', { configurable: true, value: Object.defineProperty({}, 'writeText', { get: fail }) });
      else if (failure !== 'missing') Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: failure === 'throw' ? fail : () => Promise.reject(Error('private-bundle-copy-error')) } });
      x.copy.focus!(); x.copy.click(); await settleCopy(); const manual = x.related.find('data-history-preview-copy', 'manual-bundle')!;
      expect(manual.textContent).toBe(x.expected.json); expect(manual.getAttribute('aria-readonly')).toBe('true'); expect(clipboard.selected()).toBe(manual); expect(x.f.doc.activeElement).toBe(manual); expect(x.related.text()).not.toContain('private-bundle-copy-error');
      const select = x.related.find('data-history-preview-control', 'select-copy-bundle')!; expect(select.getAttribute('aria-controls')).toBe(Reflect.get(manual, 'id')); select.click(); expect(clipboard.selected()).toBe(manual);
      manual.fire('keydown', 0, { key: 'a', ctrlKey: true }); expect(clipboard.selected()).toBe(manual);
      await x.f.panel.refresh(); expect(x.related.find('data-history-preview-copy', 'manual-bundle')).toBe(manual); const write = vi.fn().mockResolvedValue(undefined); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: write } });
      x.copy.click(); await settleCopy(); expect(write).toHaveBeenCalledExactlyOnceWith(x.expected.json); expect(x.related.find('data-history-preview-copy', 'bundle-status')!.textContent).toBe('Related history JSON copied.'); expect(x.download).not.toHaveBeenCalled(); x.f.panel.dispose();
    }
  });
  it.each(['resolve', 'reject'] as const)('preserves newer draft focus when a pending bundle copy %s', async outcome => {
    const x = await bundleCopyFixture(); let resolve!: () => void; let reject!: () => void; const write = vi.fn(() => new Promise<void>((ok, fail) => { resolve = ok; reject = () => fail(Error('private-pending-bundle')); })); const clipboard = copyBrowser(x.f, { clipboard: { writeText: write } });
    x.copy.focus!(); x.copy.click(); x.copy.click(); expect(write).toHaveBeenCalledTimes(1); expect(x.copy.getAttribute('aria-busy')).toBe('true');
    const draft = x.f.host.find('data-history-preview-search', 'query')!; draft.value = 'Newer bundle draft'; draft.setSelectionRange(2, 8); draft.focus!(); if (outcome === 'resolve') resolve(); else reject(); await settleCopy();
    expect(x.f.doc.activeElement).toBe(draft); expect([draft.value, draft.selectionStart, draft.selectionEnd]).toEqual(['Newer bundle draft', 2, 8]); expect(clipboard.selection.addRange).not.toHaveBeenCalled(); expect(x.copy.getAttribute('aria-busy')).toBe('false');
    expect(x.related.find('data-history-preview-copy', 'bundle-status')!.textContent).toBe(outcome === 'resolve' ? 'Related history JSON copied.' : 'This related history could not be copied. Select the JSON and copy it yourself.'); x.f.panel.dispose();
  });
  it.each(['aliases', 'full'] as const)('keeps %s bundle copy and download recovery independent while a copy is pending', async mode => {
    for (const outcome of ['resolve', 'reject']) {
      const x = await bundleCopyFixture(mode); let resolve!: () => void; let reject!: () => void;
      const write = vi.fn<(_text: string) => Promise<void>>(() => new Promise<void>((ok, fail) => { resolve = ok; reject = () => fail(Error('private-copy-recovery')); }));
      const clipboard = copyBrowser(x.f, { clipboard: { writeText: write } });
      x.copy.focus!(); x.copy.click();
      x.download.mockImplementationOnce(() => { throw Error('private-download-recovery'); });
      const save = x.related.find('data-history-preview-control', 'download-related')!; save.focus!(); save.click();
      const copyStatus = x.related.find('data-history-preview-copy', 'bundle-status')!; const downloadStatus = x.related.find('data-history-preview-related', 'status')!; const downloadError = x.related.find('data-history-preview-related', 'error')!;
      expect(x.copy.getAttribute('aria-busy')).toBe('true'); expect(copyStatus.textContent).toBe('Copying related history JSON…'); expect(downloadStatus.hidden).toBe(true); expect(downloadError.hidden).toBe(false); expect(downloadError.textContent).toContain('Copy related history as JSON');
      const failure = downloadError.textContent;
      if (outcome === 'resolve') resolve(); else reject(); await settleCopy();
      expect(x.f.doc.activeElement).toBe(save); expect(clipboard.selection.addRange).not.toHaveBeenCalled(); expect(x.copy.getAttribute('aria-busy')).toBe('false'); expect(downloadError.textContent).toBe(failure); expect(downloadError.hidden).toBe(false);
      const expectedStatus = outcome === 'resolve' ? 'Related history JSON copied.' : 'This related history could not be copied. Select the JSON and copy it yourself.';
      expect(copyStatus.textContent).toBe(expectedStatus);
      const manual = x.related.find('data-history-preview-copy', 'manual-bundle');
      if (outcome === 'reject') expect(manual!.textContent).toBe(x.expected.json); else expect(manual).toBeUndefined();
      save.click(); expect(x.download.mock.calls).toEqual([[x.expected.filename, x.expected.json], [x.expected.filename, x.expected.json]]); expect(downloadError.hidden).toBe(true); expect(downloadStatus.textContent).toBe('Related history download requested.'); expect(copyStatus.textContent).toBe(expectedStatus); expect(x.related.find('data-history-preview-copy', 'manual-bundle')).toBe(manual);
      write.mockResolvedValue(undefined); x.copy.click(); await settleCopy();
      expect(write.mock.calls).toEqual([[x.expected.json], [x.expected.json]]); expect(copyStatus.textContent).toBe('Related history JSON copied.'); expect(downloadStatus.textContent).toBe('Related history download requested.'); expect(x.related.text()).not.toContain('private-copy-recovery'); expect(x.related.text()).not.toContain('private-download-recovery'); expect(x.call).toHaveBeenCalledTimes(1); expect(x.exportHistory).toHaveBeenCalledTimes(1); x.f.panel.dispose();
    }
  });
  it.each(['focus', 'clipboard getter'] as const)('guards nested bundle copying during %s and permits the next explicit copy', async boundary => {
    const x = await bundleCopyFixture(); const write = vi.fn().mockResolvedValue(undefined); const navigator = {}; copyBrowser(x.f, navigator);
    let once = false; Object.defineProperty(navigator, 'clipboard', { get: () => { if (boundary === 'clipboard getter' && !once) { once = true; x.copy.click(); } return { writeText: write }; } });
    if (boundary === 'focus') { const focus = x.copy.focus!; x.copy.focus = () => { focus(); if (!once) { once = true; x.copy.click(); } }; }
    x.related.children[0]!.focus!(); x.copy.fire('click', 1); await settleCopy(); expect(write).toHaveBeenCalledExactlyOnceWith(x.expected.json); x.copy.click(); await settleCopy(); expect(write).toHaveBeenCalledTimes(2); x.f.panel.dispose();
  });
  it.each(['query', 'privacy', 'close', 'replacement', 'record page', 'dispose'])('discards late bundle copy replies and old controls after %s', async phase => {
    for (const outcome of ['resolve', 'reject']) {
      const x = await bundleCopyFixture('aliases', phase !== 'record page'); let resolve!: () => void; let reject!: () => void;
      const write = vi.fn(() => new Promise<void>((ok, fail) => { resolve = ok; reject = () => fail(Error('private-discarded-bundle')); })); copyBrowser(x.f, { clipboard: { writeText: write } }); x.copy.click(); const status = x.related.find('data-history-preview-copy', 'bundle-status')!;
      if (phase === 'query') searchPreview(x.f, 'retired'); else if (phase === 'privacy') { const mode = x.f.host.find('data-history-export-mode', 'privacy')!; mode.value = 'full'; mode.fire('change'); }
      else if (phase === 'close') x.f.host.find('data-history-preview-control', 'close')!.click(); else if (phase === 'replacement') { x.f.host.find('data-history-export', 'preview')!.click(); await x.f.panel.whenLoaded(); }
      else if (phase === 'record page') x.f.host.find('data-history-preview-control', 'previous')!.click(); else x.f.panel.dispose();
      const focus = x.f.doc.activeElement; const before = status.textContent; if (outcome === 'resolve') resolve(); else reject(); await settleCopy(); x.copy.click();
      expect(status.textContent).toBe(before); expect(x.f.doc.activeElement).toBe(focus); expect(write).toHaveBeenCalledTimes(1); expect(x.download).not.toHaveBeenCalled(); x.f.panel.dispose();
    }
  });
  it('isolates concurrent bundle copies, feedback, accessible names and manual fallback by root', async () => {
    const x = await bundleCopyFixture('aliases', false); const second = openRelated(x.f, 41); const other = second.find('data-history-preview-control', 'copy-bundle')!;
    const expected = prepareAuthenticationHistoryRelatedDownload(createAuthenticationHistoryRelatedBundles(x.captured)(41)); const replies: { resolve(): void; reject(): void }[] = [];
    const write = vi.fn(() => new Promise<void>((ok, fail) => { replies.push({ resolve: ok, reject: () => fail(Error('private-concurrent-bundle')) }); })); const clipboard = copyBrowser(x.f, { clipboard: { writeText: write } });
    x.copy.click(); other.focus!(); other.click(); expect(write.mock.calls).toEqual([[x.expected.json], [expected.json]]); expect(x.copy.getAttribute('aria-label')).not.toBe(other.getAttribute('aria-label'));
    replies[0]!.reject(); await settleCopy(); expect(x.f.doc.activeElement).toBe(other); expect(clipboard.selection.addRange).not.toHaveBeenCalled(); replies[1]!.resolve(); await settleCopy();
    expect(x.related.find('data-history-preview-copy', 'manual-bundle')!.textContent).toBe(x.expected.json); expect(second.find('data-history-preview-copy', 'bundle-status')!.textContent).toBe('Related history JSON copied.'); expect(x.copy.getAttribute('aria-describedby')).not.toBe(other.getAttribute('aria-describedby')); expect(x.download).not.toHaveBeenCalled(); x.f.panel.dispose();
  });
  it('does not dispatch clipboard access or manual text when bundle metadata exceeds the UTF-8 ceiling', async () => {
    const source = historyExport({ kind: 'all' }, 1); const root = source.entries[0]!.record; if (!('group' in root)) throw Error(); const shared = repair(); shared.incidents = [{ id: root.id, group_id: root.group.id, label: root.group.label }];
    const template = relatedFixture().entries[46]!.record; if (!('selection' in template)) throw Error();
    const checks = Array.from({ length: 1600 }, (_, n) => { const check = structuredClone(template); check.id = 'verify-' + (n + 1).toString(16).padStart(8, '0') + '-1234-4123-8123-123456789abc'; check.selection = { kind: 'repair', id: shared.id }; check.results[0]!.label = 'é'.repeat(2048); return check; });
    source.entries = [source.entries[0]!, ...[shared, ...checks].map(record => ({ type: authenticationHistoryEntryType(record), outcome: authenticationHistoryEntryOutcome(record), record }))]; source.entry_count = source.entries.length;
    let remaining = AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES - new TextEncoder().encode(JSON.stringify(authenticationHistoryExportReport(source))).byteLength; expect(remaining).toBeGreaterThan(0);
    for (const check of checks) { if (remaining <= 0) break; const use = { kind: 'pack' as const, id: 'p', label: 'x' }; const overhead = new TextEncoder().encode(JSON.stringify([use])).byteLength - 2; if (remaining < overhead) break; check.uses = [use]; remaining -= overhead; const more = Math.min(2047, remaining); use.label += 'x'.repeat(more); remaining -= more; }
    root.group.label += 'x'.repeat(remaining); const captured = prepareAuthenticationHistoryDownload(source, { scope: source.scope }, 'full'); expect(captured.bytes).toBe(AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES);
    const download = vi.fn(); const f = mount(async () => page(source.scope), source.scope, { exportHistory: async () => source, download }); await f.panel.whenLoaded(); const mode = f.host.find('data-history-export-mode', 'privacy')!; mode.value = 'full'; mode.fire('change'); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded();
    searchPreview(f, root.id); const related = openRelated(f, 0); const getter = vi.fn(); copyBrowser(f, Object.defineProperty({}, 'clipboard', { get: getter })); related.find('data-history-preview-control', 'copy-bundle')!.click();
    expect(getter).not.toHaveBeenCalled(); expect(related.find('data-history-preview-copy', 'manual-bundle')).toBeUndefined(); expect(related.find('data-history-preview-copy', 'bundle-status')!.textContent).toContain('8 MiB'); expect(related.find('data-history-preview-control', 'copy-bundle')!.getAttribute('aria-busy')).toBe('false');
    savePreview(f); expect(download).toHaveBeenCalledExactlyOnceWith(captured.filename, captured.json); f.panel.dispose();
  });
  it.each(['aliases', 'full'] as const)('copies and downloads complete %s related records with their original snapshot filenames', async mode => {
    const value = relatedFixture(); Object.assign(value.entries[40]!.record, { access_token: 'private-related-marker' });
    const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode); const download = vi.fn(); const write = vi.fn().mockResolvedValue(undefined);
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page(value.scope)); const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value);
    const f = mount(call, value.scope, { exportHistory, download }); copyBrowser(f, { clipboard: { writeText: write } }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = mode; privacy.fire('change'); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded();
    searchPreview(f, captured.report.entries[40]!.record.id); const browser = openRelatedBrowser(f); expect(browser.find('data-history-preview-control', 'copy-record')).toBeUndefined();
    const checkActions = async (owner: Element, index: number): Promise<void> => {
      const entry = captured.report.entries[index]!; const raw = JSON.stringify(entry); const filename = captured.filename.slice(0, -5) + '-record-' + entry.type + '-' + (index + 1) + '.json';
      const copy = owner.find('data-history-preview-control', 'copy-record')!; copy.focus!(); copy.click(); await settleCopy(); expect(write).toHaveBeenLastCalledWith(raw);
      const save = owner.find('data-history-preview-control', 'download-record')!; save.focus!(); save.click(); expect(download).toHaveBeenLastCalledWith(filename, raw); expect(f.doc.activeElement).toBe(save);
      expect(owner.find('data-history-preview-copy', 'record-status')!.textContent).toBe('Record JSON copied.'); expect(owner.find('data-history-preview-download', 'record-status')!.textContent).toBe('Record file download requested.');
      expect(copy.getAttribute('aria-label')).toContain('for incident ' + captured.report.entries[40]!.record.id); expect(raw).not.toContain('private-related-marker');
    };
    for (const index of [40, 41, 45, 46, 47]) { const row = browser.find('data-history-preview-related-record', String(index))!; row.open = true; row.fire('toggle'); await checkActions(row, index); }
    searchRelated(browser, 'Closed without confirmed recovery'); const row = browser.find('data-history-preview-related-record', '40')!; row.open = true; row.fire('toggle');
    const query = browser.find('data-history-preview-related-search', 'query')!; query.value = 'Unapplied record draft'; query.setSelectionRange(2, 7);
    const origin = savedLink(row, 'repair', captured.report.entries[45]!.record.id); origin.click(); const pane = currentLinked(browser)!; await checkActions(pane, 45);
    const copies = write.mock.calls.length; const files = download.mock.calls.length; row.find('data-history-preview-control', 'copy-record')!.click(); row.find('data-history-preview-control', 'download-record')!.click(); expect(write).toHaveBeenCalledTimes(copies); expect(download).toHaveBeenCalledTimes(files);
    pane.find('data-history-preview-control', 'related-reference-back')!.click(); expect(f.doc.activeElement).toBe(origin); expect(browser.find('data-history-preview-related-record', '40')).toBe(row); expect([query.value, query.selectionStart, query.selectionEnd]).toEqual(['Unapplied record draft', 2, 7]);
    pane.find('data-history-preview-control', 'copy-record')!.click(); pane.find('data-history-preview-control', 'download-record')!.click(); expect(write).toHaveBeenCalledTimes(copies); expect(download).toHaveBeenCalledTimes(files);
    const expectedBundle = prepareAuthenticationHistoryRelatedDownload(createAuthenticationHistoryRelatedBundles(captured)(40)); openRelated(f).find('data-history-preview-control', 'download-related')!.click(); expect(download).toHaveBeenLastCalledWith(expectedBundle.filename, expectedBundle.json);
    savePreview(f); expect(download).toHaveBeenLastCalledWith(captured.filename, captured.json); expect(call).toHaveBeenCalledTimes(1); expect(exportHistory).toHaveBeenCalledTimes(1); expect(f.panel.hasDraft()).toBe(false); f.panel.dispose();
  });
  it.each(['results', 'linked'] as const)('keeps %s record actions independent through download failure, retry and navigation', async location => {
    const value = relatedFixture(); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'aliases');
    const download = vi.fn().mockImplementationOnce(() => { throw Error('private-related-download-failure'); }); const write = vi.fn().mockResolvedValue(undefined);
    const f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value, download }); copyBrowser(f, { clipboard: { writeText: write } }); await f.panel.whenLoaded();
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, captured.report.entries[40]!.record.id); const browser = openRelatedBrowser(f); const row = browser.find('data-history-preview-related-record', '40')!; row.open = true; row.fire('toggle');
    if (location === 'linked') savedLink(row, 'repair', captured.report.entries[45]!.record.id).click(); const owner = location === 'linked' ? currentLinked(browser)! : row;
    const save = owner.find('data-history-preview-control', 'download-record')!; save.focus!(); save.click(); expect(owner.find('data-history-preview-download', 'record-error')!.hidden).toBe(false); expect(browser.text()).not.toContain('private-related-download-failure');
    owner.find('data-history-preview-control', 'copy-record')!.click(); await settleCopy(); save.click(); expect(download).toHaveBeenCalledTimes(2); expect(download.mock.calls[1]).toEqual(download.mock.calls[0]); expect(owner.find('data-history-preview-download', 'record-error')!.hidden).toBe(true); expect(owner.find('data-history-preview-copy', 'record-status')!.textContent).toBe('Record JSON copied.');
    const id = captured.report.entries[location === 'linked' ? 40 : 45]!.record.id; savedLink(owner, location === 'linked' ? 'incident' : 'repair', id).click(); currentLinked(browser)!.find('data-history-preview-control', 'related-reference-back')!.click();
    expect(owner.find('data-history-preview-control', 'download-record')).toBe(save); expect(owner.find('data-history-preview-download', 'record-status')!.textContent).toBe('Record file download requested.'); f.panel.dispose();
  });
  it.each(['results resolve', 'results reject', 'linked resolve', 'linked reject'] as const)('settles %s record copy while hidden and restores its exact status on Back', async variant => {
    const value = relatedFixture(); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'aliases'); const download = vi.fn();
    let resolve!: () => void; let reject!: (error: unknown) => void; const write = vi.fn(() => new Promise<void>((ok, fail) => { resolve = ok; reject = fail; }));
    const f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value, download }); const clipboard = copyBrowser(f, { clipboard: { writeText: write } }); await f.panel.whenLoaded();
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, captured.report.entries[40]!.record.id); const browser = openRelatedBrowser(f); const row = browser.find('data-history-preview-related-record', '40')!; row.open = true; row.fire('toggle');
    const linked = variant.startsWith('linked'); if (linked) savedLink(row, 'repair', captured.report.entries[45]!.record.id).click(); const owner = linked ? currentLinked(browser)! : row;
    const copy = owner.find('data-history-preview-control', 'copy-record')!; copy.focus!(); copy.click(); copy.click(); expect(write).toHaveBeenCalledTimes(1);
    const origin = savedLink(owner, linked ? 'incident' : 'repair', captured.report.entries[linked ? 40 : 45]!.record.id); origin.click(); const pane = currentLinked(browser)!; const focus = f.doc.activeElement;
    if (variant.endsWith('resolve')) resolve(); else reject(Error('private-related-copy-failure')); await settleCopy(); expect(copy.getAttribute('aria-busy')).toBe('false'); expect(f.doc.activeElement).toBe(focus); expect(clipboard.selection.addRange).not.toHaveBeenCalled();
    copy.click(); owner.find('data-history-preview-control', 'download-record')!.click(); expect(write).toHaveBeenCalledTimes(1); expect(download).not.toHaveBeenCalled();
    pane.find('data-history-preview-control', 'related-reference-back')!.click(); expect(f.doc.activeElement).toBe(origin); expect(owner.find('data-history-preview-control', 'copy-record')).toBe(copy);
    if (variant.endsWith('reject')) { const manual = owner.find('data-history-preview-copy', 'manual-record')!; expect(manual.textContent).toBe(JSON.stringify(captured.report.entries[linked ? 45 : 40])); owner.find('data-history-preview-control', 'select-copy-record')!.click(); expect(clipboard.selected()).toBe(manual); }
    else { expect(owner.find('data-history-preview-copy', 'record-status')!.textContent).toBe('Record JSON copied.'); copy.click(); expect(write).toHaveBeenCalledTimes(2); resolve(); await settleCopy(); }
    expect(browser.text()).not.toContain('private-related-copy-failure'); f.panel.dispose();
  });
  it.each(['results focus', 'results callback', 'linked focus', 'linked callback'] as const)('rejects nested %s record downloads and releases the guard for an explicit retry', async variant => {
    for (const refused of [false, true]) {
      const value = relatedFixture(); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'aliases');
      let save!: Element;
      const download = vi.fn().mockImplementationOnce(() => {
        if (variant.endsWith('callback')) save.click();
        if (refused) throw Error('private-nested-download');
      });
      const f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value, download }); await f.panel.whenLoaded();
      f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, captured.report.entries[40]!.record.id);
      const browser = openRelatedBrowser(f); const row = browser.find('data-history-preview-related-record', '40')!; row.open = true; row.fire('toggle');
      const linked = variant.startsWith('linked'); if (linked) savedLink(row, 'repair', captured.report.entries[45]!.record.id).click(); const owner = linked ? currentLinked(browser)! : row;
      save = owner.find('data-history-preview-control', 'download-record')!;
      if (variant.endsWith('focus')) { const focus = save.focus!; save.focus = () => { focus(); save.click(); }; }
      const disclosure = linked ? owner.find('data-history-preview-linked-record', '45')! : row; disclosure.children[0]!.focus!(); save.fire('click', 1);
      expect(download).toHaveBeenCalledTimes(1); expect(owner.find('data-history-preview-download', 'record-error')!.hidden).toBe(!refused); expect(browser.text()).not.toContain('private-nested-download');
      save.click(); expect(download).toHaveBeenCalledTimes(2); expect(download.mock.calls[1]).toEqual(download.mock.calls[0]);
      expect(owner.find('data-history-preview-download', 'record-error')!.hidden).toBe(true); expect(owner.find('data-history-preview-download', 'record-status')!.textContent).toBe('Record file download requested.'); f.panel.dispose();
    }
  });
  it.each(['results', 'linked'] as const)('cancels a %s record download when its focus handler opens another view', async location => {
    const value = relatedFixture(); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'aliases'); const download = vi.fn();
    const f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value, download }); await f.panel.whenLoaded(); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, captured.report.entries[40]!.record.id);
    const browser = openRelatedBrowser(f); const row = browser.find('data-history-preview-related-record', '40')!; row.open = true; row.fire('toggle'); if (location === 'linked') savedLink(row, 'repair', captured.report.entries[45]!.record.id).click(); const owner = location === 'linked' ? currentLinked(browser)! : row;
    const next = savedLink(owner, location === 'linked' ? 'incident' : 'repair', captured.report.entries[location === 'linked' ? 40 : 45]!.record.id); const save = owner.find('data-history-preview-control', 'download-record')!; const focus = save.focus!; save.focus = () => { focus(); next.click(); };
    const disclosure = location === 'linked' ? owner.find('data-history-preview-linked-record', '45')! : row;
    disclosure.children[0]!.focus!(); save.fire('click', 1); expect(download).not.toHaveBeenCalled(); expect(owner.find('data-history-preview-download', 'record-status')!.hidden).toBe(true); f.panel.dispose();
  });
  it.each(['aliases', 'full'] as const)('follows typed links beyond the related %s search and restores the exact results, draft, caret and focus', async mode => {
    const value = largeRelatedFixture(); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode); const download = vi.fn();
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page(value.scope)); const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value); const f = mount(call, value.scope, { exportHistory, download }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = mode; privacy.fire('change'); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); const mainQuery = captured.report.entries[40]!.record.id; searchPreview(f, mainQuery);
    const browser = openRelatedBrowser(f); searchRelated(browser, 'Closed without confirmed recovery'); const next = browser.find('data-history-preview-control', 'related-next')!; next.click(); next.click();
    const row = browser.find('data-history-preview-related-record', '40')!; row.open = true; row.fire('toggle'); const origin = savedLink(row, 'repair', captured.report.entries[45]!.record.id); expect(origin.getAttribute('data-history-preview-link-direction')).toBe('referenced_by');
    const range = browser.find('data-history-preview-related', 'record-range')!; const rangeText = range.textContent; const query = browser.find('data-history-preview-related-search', 'query')!; query.value = 'Unapplied related draft'; query.setSelectionRange(2, 8); const applied = browser.find('data-history-preview-related-search', 'applied')!.textContent;
    origin.focus!(); origin.click(); const pane = currentLinked(browser)!; expect(pane).toBeDefined(); expect(pane.find('data-history-preview-linked-record', '45')).toBeDefined(); expect(pane.text()).toContain('outside your related search'); expect(f.doc.activeElement).toBe(pane.find('data-history-preview-related-linked', 'heading'));
    expect(range.hidden).toBe(true); expect(browser.find('data-history-preview-related-search', 'form')!.hidden).toBe(true); expect(range.textContent).toBe(rangeText); expect(f.host.find('data-history-preview-search', 'query')!.value).toBe(mainQuery);
    browser.find('data-history-preview-control', 'related-search-clear')!.click(); next.click(); browser.find('data-history-preview-related-search', 'form')!.fire('submit'); expect(range.textContent).toBe(rangeText); expect(query.value).toBe('Unapplied related draft');
    await f.panel.refresh(); expect(currentLinked(browser)).toBe(pane); expect(query.selectionStart).toBe(2); browser.open = false; browser.fire('toggle'); browser.open = true; browser.fire('toggle'); expect(currentLinked(browser)).toBe(pane);
    pane.find('data-history-preview-control', 'related-reference-back')!.click(); expect(currentLinked(browser)).toBeUndefined(); expect(range.hidden).toBe(false); expect(range.textContent).toBe(rangeText); expect(browser.find('data-history-preview-related-search', 'applied')!.textContent).toBe(applied);
    expect(browser.find('data-history-preview-related-record', '40')).toBe(row); expect(row.open).toBe(true); expect(f.doc.activeElement).toBe(origin); expect([query.value, query.selectionStart, query.selectionEnd]).toEqual(['Unapplied related draft', 2, 8]);
    const bundle = prepareAuthenticationHistoryRelatedDownload(createAuthenticationHistoryRelatedBundles(captured)(40)); openRelated(f).find('data-history-preview-control', 'download-related')!.click(); expect(download).toHaveBeenLastCalledWith(bundle.filename, bundle.json); savePreview(f); expect(download).toHaveBeenLastCalledWith(captured.filename, captured.json);
    expect(call).toHaveBeenCalledTimes(2); expect(exportHistory).toHaveBeenCalledTimes(1); expect(f.panel.hasDraft()).toBe(false); f.panel.dispose();
  });
  it.each(['aliases', 'full'] as const)('keeps %s link pages and record details intact through multiple hops and Back', async mode => {
    const value = largeRelatedFixture(); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode); const f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = mode; privacy.fire('change'); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); const browser = openRelatedBrowser(f, 0); const root = browser.find('data-history-preview-related-record', '0')!; root.open = true; root.fire('toggle'); savedLink(root, 'repair', captured.report.entries[45]!.record.id).click();
    const first = currentLinked(browser)!; const target = first.find('data-history-preview-linked-record', '45')!; const links = target.find('data-history-preview-related-links', 'records')!; const next = links.find('data-history-preview-control', 'related-links-next')!; expect(links.querySelectorAll('[data-history-preview-control="related-link"]')).toHaveLength(20); next.click(); next.focus!(); next.click();
    const range = links.find('data-history-preview-related-link-range', 'records')!; expect(range.textContent).toBe('Saved links 41–46 of 46'); expect(f.doc.activeElement).toBe(range); const origin = savedLink(target, 'incident', captured.report.entries[41]!.record.id); expect(origin.getAttribute('data-history-preview-link-direction')).toBe('references');
    const incidents = target.find('data-history-preview-field', 'incidents')!; incidents.open = true; incidents.fire('toggle'); incidents.find('data-history-preview-control', 'array-next')!.click(); expect(incidents.text()).toContain('Items 21–40 of 45'); origin.click();
    const second = currentLinked(browser)!; expect(second).not.toBe(first); expect(first.hidden).toBe(true); expect(second.find('data-history-preview-linked-record', '41')).toBeDefined(); first.find('data-history-preview-control', 'related-reference-back')!.click(); expect(currentLinked(browser)).toBe(second);
    second.find('data-history-preview-control', 'related-reference-back')!.click(); expect(currentLinked(browser)).toBe(first); expect(f.doc.activeElement).toBe(origin); expect(range.textContent).toBe('Saved links 41–46 of 46'); expect(incidents.open).toBe(true); expect(incidents.text()).toContain('Items 21–40 of 45'); f.panel.dispose();
  });
  it.each(['resolve', 'reject'] as const)('settles an authorized hidden-view copy on %s, while hidden actions remain inactive', async outcome => {
    const value = largeRelatedFixture(); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'aliases'); const f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value });
    let resolve!: () => void; let reject!: (error: unknown) => void; const write = vi.fn(() => new Promise<void>((ok, fail) => { resolve = ok; reject = fail; })); const clipboard = copyBrowser(f, { clipboard: { writeText: write } }); await f.panel.whenLoaded(); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded();
    const browser = openRelatedBrowser(f, 0); searchRelated(browser, 'Incident'); const row = browser.find('data-history-preview-related-record', '0')!; row.open = true; row.fire('toggle'); const view = row.find('data-history-preview-match-path', JSON.stringify(['type']))!; view.click(); const selected = f.doc.activeElement;
    const copy = selected.find('data-history-preview-control', 'copy-value')!; copy.focus!(); copy.click(); savedLink(row, 'repair', captured.report.entries[45]!.record.id).click(); const pane = currentLinked(browser)!; const focus = f.doc.activeElement;
    if (outcome === 'resolve') resolve(); else reject(Error('private-copy-error')); await settleCopy(); expect(copy.getAttribute('aria-busy')).toBe('false'); expect(f.doc.activeElement).toBe(focus); copy.click(); view.click(); selected.find('data-history-preview-control', 'return-matches')!.click(); expect(write).toHaveBeenCalledTimes(1); expect(f.doc.activeElement).toBe(focus); expect(clipboard.selection.addRange).not.toHaveBeenCalled();
    pane.find('data-history-preview-control', 'related-reference-back')!.click(); expect(selected.getAttribute('data-history-preview-match-target')).toBe('true'); expect(row.find('data-history-preview-control', 'copy-value')).toBe(copy);
    if (outcome === 'resolve') { expect(row.text()).toContain('Saved value copied.'); copy.click(); expect(write).toHaveBeenCalledTimes(2); resolve(); await settleCopy(); }
    else {
      const manual = row.find('data-history-preview-copy', 'manual-value')!; expect(manual.textContent).toBe('incident'); const select = row.find('data-history-preview-control', 'select-copy-value')!; select.click(); expect(clipboard.selection.addRange).toHaveBeenCalledTimes(1);
      const focus = manual.focus!; const scroll = vi.fn(); Object.assign(manual, { scrollIntoView: scroll }); manual.focus = () => { focus(); savedLink(row, 'repair', captured.report.entries[45]!.record.id).click(); }; select.click();
      expect(currentLinked(browser)).toBeDefined(); expect(clipboard.selection.addRange).toHaveBeenCalledTimes(1); expect(scroll).not.toHaveBeenCalled();
    }
    expect(browser.text()).not.toContain('private-copy-error'); f.panel.dispose();
  });
  it.each(['focus', 'clipboard getter'] as const)('cancels a copy when %s hides or replaces its view before dispatch', async boundary => {
    for (const change of ['linked view', 'privacy', 'close'] as const) {
      const value = largeRelatedFixture(); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'aliases');
      const f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value });
      const write = vi.fn().mockResolvedValue(undefined); const navigator = {}; copyBrowser(f, navigator);
      await f.panel.whenLoaded(); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded();
      const browser = openRelatedBrowser(f, 0); searchRelated(browser, 'Incident'); const row = browser.find('data-history-preview-related-record', '0')!; row.open = true; row.fire('toggle');
      row.find('data-history-preview-match-path', JSON.stringify(['type']))!.click(); const selected = f.doc.activeElement; const copy = selected.find('data-history-preview-control', 'copy-value')!;
      const replace = (): void => {
        if (change === 'linked view') savedLink(row, 'repair', captured.report.entries[45]!.record.id).click();
        else if (change === 'privacy') { const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change'); }
        else f.host.find('data-history-preview-control', 'close')!.click();
      };
      const getter = vi.fn(() => { if (boundary === 'clipboard getter') replace(); return { writeText: write }; });
      Object.defineProperty(navigator, 'clipboard', { get: getter });
      if (boundary === 'focus') { const focus = copy.focus!; copy.focus = () => { focus(); replace(); }; }
      selected.focus!(); copy.fire('click', 1); await settleCopy();
      expect(write).not.toHaveBeenCalled(); expect(copy.getAttribute('aria-busy')).toBe('false');
      expect(getter).toHaveBeenCalledTimes(boundary === 'focus' ? 0 : 1);
      if (change === 'linked view') expect(currentLinked(browser)).toBeDefined();
      f.panel.dispose();
    }
  });
  it.each(['follow', 'back'] as const)('keeps %s atomic when hiding or removing a view invokes an old navigation control', async boundary => {
    const value = largeRelatedFixture(); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'aliases');
    const f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value }); await f.panel.whenLoaded();
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); const browser = openRelatedBrowser(f, 0);
    const row = browser.find('data-history-preview-related-record', '0')!; row.open = true; row.fire('toggle'); const origin = savedLink(row, 'repair', captured.report.entries[45]!.record.id);
    const items = browser.find('data-history-preview-related', 'record-list')!;
    if (boundary === 'follow') {
      let hidden = items.hidden; let once = false;
      Object.defineProperty(items, 'hidden', { get: () => hidden, set: (value: boolean) => { hidden = value; if (value && !once) { once = true; origin.click(); } } });
      origin.click();
    } else {
      origin.click(); const host = browser.find('data-history-preview-related', 'linked-views')!; const remove = host.removeChild.bind(host);
      let once = false; host.removeChild = node => { remove(node); if (!once) { once = true; origin.click(); } };
      currentLinked(browser)!.find('data-history-preview-control', 'related-reference-back')!.click();
      expect(currentLinked(browser)).toBeUndefined(); origin.click();
    }
    expect(browser.querySelectorAll('[data-history-preview-related-linked="view"]')).toHaveLength(1);
    currentLinked(browser)!.find('data-history-preview-control', 'related-reference-back')!.click();
    expect(currentLinked(browser)).toBeUndefined(); expect(browser.querySelectorAll('[data-history-preview-related-linked="view"]')).toHaveLength(1); expect(browser.find('data-history-preview-control', 'related-reference-forward')!.disabled).toBe(false);
    expect(items.hidden).toBe(false); expect(browser.find('data-history-preview-related-search', 'form')!.hidden).toBe(false); expect(f.doc.activeElement).toBe(origin);
    f.panel.dispose();
  });
  it('bounds cyclic navigation at 20 linked views and restores each exact origin on Back', async () => {
    const value = largeRelatedFixture(); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'aliases'); const f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value }); await f.panel.whenLoaded(); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); const browser = openRelatedBrowser(f, 0); const root = browser.find('data-history-preview-related-record', '0')!; root.open = true; root.fire('toggle');
    const origins: Element[] = [];
    for (let n = 0; n < 20; n++) { const record = n === 0 ? root : currentLinked(browser)!.find('data-history-preview-linked-record', n % 2 ? '45' : '0')!; const origin = savedLink(record, n % 2 ? 'incident' : 'repair', captured.report.entries[n % 2 ? 0 : 45]!.record.id); origins.push(origin); origin.click(); expect(browser.querySelectorAll('[data-history-preview-related-linked="view"]')).toHaveLength(n + 1); }
    const pane = currentLinked(browser)!; expect(pane.text()).toContain('20 linked records open'); const refused = pane.find('data-history-preview-control', 'related-link')!; expect(refused.disabled).toBe(true); refused.disabled = false; refused.click(); expect(currentLinked(browser)).toBe(pane); expect(browser.querySelectorAll('[data-history-preview-related-linked="view"]')).toHaveLength(20);
    for (let n = 19; n >= 0; n--) { const current = currentLinked(browser)!; current.find('data-history-preview-control', 'related-reference-back')!.click(); expect(f.doc.activeElement).toBe(origins[n]); }
    expect(currentLinked(browser)).toBeUndefined(); expect(root.open).toBe(true); f.panel.dispose();
  });
  it.each(['aliases', 'full'] as const)('keeps two %s bundles independent while following the same saved repair', async mode => {
    const value = largeRelatedFixture(); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode); const download = vi.fn(); const f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value, download }); await f.panel.whenLoaded(); const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = mode; privacy.fire('change'); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded();
    const first = openRelatedBrowser(f, 0); const second = openRelatedBrowser(f, 1); const panes: Element[] = [];
    for (const [n, browser] of [first, second].entries()) { searchRelated(browser, n === 0 ? 'Incident' : 'Closed without confirmed recovery'); const row = browser.find('data-history-preview-related-record', String(n))!; row.open = true; row.fire('toggle'); savedLink(row, 'repair', captured.report.entries[45]!.record.id).click(); panes.push(currentLinked(browser)!); }
    expect(panes[0]!.getAttribute('aria-label')).not.toBe(panes[1]!.getAttribute('aria-label')); panes[0]!.find('data-history-preview-control', 'related-links-next')!.click(); expect(panes[1]!.find('data-history-preview-related-link-range', 'records')!.textContent).toBe('Saved links 1–20 of 46');
    panes[0]!.find('data-history-preview-control', 'related-reference-back')!.click(); expect(currentLinked(first)).toBeUndefined(); expect(currentLinked(second)).toBe(panes[1]); expect(first.find('data-history-preview-related-search', 'query')!.value).toBe('Incident'); expect(second.find('data-history-preview-related-search', 'query')!.value).toBe('Closed without confirmed recovery');
    expect(f.host.find('data-history-preview-range', 'records')!.textContent).toBe('Records 1–20 of 48'); expect(f.host.find('data-history-preview-search', 'query')!.value).toBe('');
    for (const [n, browser] of [first, second].entries()) { browser.find('data-history-preview-control', 'related-return-download')!.click(); const save = openRelated(f, n).find('data-history-preview-control', 'download-related')!; expect(f.doc.activeElement).toBe(save); save.click(); const expected = prepareAuthenticationHistoryRelatedDownload(createAuthenticationHistoryRelatedBundles(captured)(n)); expect(download).toHaveBeenLastCalledWith(expected.filename, expected.json); }
    expect(currentLinked(second)).toBe(panes[1]); f.panel.dispose();
  });
  it.each(['aliases', 'full'] as const)('explains unavailable %s references without a lookup or a fabricated target', async mode => {
    const value = relatedFixture(); const shared = value.entries[45]!.record; if (!('incidents' in shared)) throw Error(); shared.incidents.push({ id: '99999999-1234-4123-8123-123456789abc', group_id: 'a'.repeat(64), label: 'Private missing' }); shared.incidents_truncated = true;
    const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode); const saved = captured.report.entries[45]!.record; if (!('incidents' in saved)) throw Error(); const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page(value.scope)); const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value); const f = mount(call, value.scope, { exportHistory }); await f.panel.whenLoaded(); const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = mode; privacy.fire('change'); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, captured.report.entries[40]!.record.id);
    const browser = openRelatedBrowser(f); const row = browser.find('data-history-preview-related-record', '40')!; row.open = true; row.fire('toggle'); savedLink(row, 'repair', saved.id).click(); const pane = currentLinked(browser)!; const links = pane.find('data-history-preview-related-links', 'records')!;
    expect(links.text()).toContain(saved.incidents[2]!.id); expect(links.text()).toContain('This referenced record is not included in the bundle. No lookup is made.'); expect(savedLink(links, 'incident', saved.incidents[2]!.id)).toBeUndefined(); expect(links.querySelectorAll('[data-history-preview-control="related-link"]')).toHaveLength(3); expect(pane.text()).not.toContain('Private missing'); expect(call).toHaveBeenCalledTimes(1); expect(exportHistory).toHaveBeenCalledTimes(1); f.panel.dispose();
  });
  it.each(['follow', 'back'] as const)('preserves newer focus and scroll chosen while %s changes the local view', async action => {
    const value = largeRelatedFixture(); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'aliases'); const f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value }); await f.panel.whenLoaded(); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); const browser = openRelatedBrowser(f, 0); const row = browser.find('data-history-preview-related-record', '0')!; row.open = true; row.fire('toggle'); const origin = savedLink(row, 'repair', captured.report.entries[45]!.record.id);
    const draft = f.host.find('data-history-preview-search', 'query')!; const redirect = () => { draft.value = 'Newer transition draft'; draft.setSelectionRange(2, 8); draft.focus!(); }; const scroll = vi.fn();
    if (action === 'follow') { const items = browser.find('data-history-preview-related', 'record-list')!; let hidden = items.hidden; Object.defineProperty(items, 'hidden', { get: () => hidden, set: (value: boolean) => { hidden = value; if (value) redirect(); } }); const create = f.doc.createElement; f.doc.createElement = () => Object.assign(create(), { scrollIntoView: scroll }); origin.focus!(); origin.click(); expect(currentLinked(browser)).toBeDefined(); }
    else { origin.click(); Object.assign(origin, { scrollIntoView: scroll }); const pane = currentLinked(browser)!; let hidden = pane.hidden; Object.defineProperty(pane, 'hidden', { get: () => hidden, set: (value: boolean) => { hidden = value; if (value) redirect(); } }); const back = currentLinked(browser)!.find('data-history-preview-control', 'related-reference-back')!; back.focus!(); back.click(); expect(currentLinked(browser)).toBeUndefined(); }
    expect(f.doc.activeElement).toBe(draft); expect([draft.value, draft.selectionStart, draft.selectionEnd]).toEqual(['Newer transition draft', 2, 8]); expect(scroll).not.toHaveBeenCalled(); f.panel.dispose();
  });
  it.each(['back', 'related query', 'preview query', 'privacy', 'close', 'new snapshot', 'parent page', 'dispose'])('keeps linked-view and hidden-source actions inert after %s', async phase => {
    const value = largeRelatedFixture(); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'aliases'); const download = vi.fn(); const f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value, download }); const write = vi.fn().mockResolvedValue(undefined); copyBrowser(f, { clipboard: { writeText: write } }); await f.panel.whenLoaded(); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded();
    const browser = openRelatedBrowser(f, 0); searchRelated(browser, 'I'); const row = browser.find('data-history-preview-related-record', '0')!; row.open = true; row.fire('toggle'); const origin = savedLink(row, 'repair', captured.report.entries[45]!.record.id); origin.click(); const pane = currentLinked(browser)!;
    pane.find('data-history-preview-match-path', JSON.stringify(['type']))!.click(); const copy = pane.find('data-history-preview-control', 'copy-value')!; const link = savedLink(pane, 'incident', captured.report.entries[0]!.record.id); const back = pane.find('data-history-preview-control', 'related-reference-back')!;
    const recordCopy = pane.find('data-history-preview-control', 'copy-record')!; const recordSave = pane.find('data-history-preview-control', 'download-record')!;
    if (phase === 'back' || phase === 'related query') { back.click(); if (phase === 'related query') searchRelated(browser, 'Access check'); } else if (phase === 'preview query') searchPreview(f, 'retired'); else if (phase === 'privacy') { const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change'); }
    else if (phase === 'close') f.host.find('data-history-preview-control', 'close')!.click(); else if (phase === 'new snapshot') { f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); } else if (phase === 'parent page') f.host.find('data-history-preview-control', 'next')!.click(); else f.panel.dispose();
    const focus = f.doc.activeElement; const count = browser.querySelectorAll('[data-history-preview-related-linked="view"]').length; copy.click(); recordCopy.click(); recordSave.click(); back.click(); link.click(); if (phase !== 'back') origin.click(); await settleCopy(); expect(f.doc.activeElement).toBe(focus); expect(write).not.toHaveBeenCalled(); expect(download).not.toHaveBeenCalled(); expect(browser.querySelectorAll('[data-history-preview-related-linked="view"]')).toHaveLength(count); f.panel.dispose();
  });
  const relatedForwardFixture = async (mode: 'aliases' | 'full' = 'aliases') => {
    const value = largeRelatedFixture(), captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode), download = vi.fn();
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page(value.scope)), exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value);
    const f = mount(call, value.scope, { exportHistory, download }); await f.panel.whenLoaded(); const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = mode; privacy.fire('change'); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded();
    const browser = openRelatedBrowser(f, 0), root = browser.find('data-history-preview-related-record', '0')!; root.open = true; root.fire('toggle'); const origin = savedLink(root, 'repair', captured.report.entries[45]!.record.id); origin.focus!(); origin.click();
    return { f, captured, browser, root, origin, first: currentLinked(browser)!, download, call, exportHistory };
  };
  const relatedBack = (browser: Element): void => { const control = currentLinked(browser)!.find('data-history-preview-control', 'related-reference-back')!; control.focus!(); control.click(); };
  const relatedForward = (browser: Element, inline = false): void => { const control = (inline ? currentLinked(browser)! : browser).find('data-history-preview-control', inline ? 'related-inline-forward' : 'related-reference-forward')!; control.focus!(); control.click(); };
  const filteredRelatedFixture = async (mode: 'aliases' | 'full' = 'aliases') => {
    const value = largeRelatedFixture(), failed = structuredClone(value.entries[46]!.record);
    if (!('selection' in failed)) throw Error('Expected access check');
    failed.id = 'verify-32345678-1234-4123-8123-123456789abc'; failed.results[0]!.checks = [{ kind: 'api_read', status: 'failed', reason: 'access_rejected' }];
    value.entries.push({ type: 'verification', outcome: 'failed', record: failed }); value.entry_count++;
    const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode), download = vi.fn();
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page(value.scope)), exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value);
    const f = mount(call, value.scope, { exportHistory, download }); await f.panel.whenLoaded(); const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = mode; privacy.fire('change'); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded();
    const browser = openRelatedBrowser(f, 0); return { f, value, captured, download, call, exportHistory, browser };
  };
  const filterRelated = (browser: Element, key: 'type' | 'outcome', value: string): Element => {
    const control = browser.find('data-history-preview-related-filter', key)!; control.value = value; control.focus!(); control.fire('change'); return control;
  };
  const relatedRange = (browser: Element): Element => browser.find('data-history-preview-related', 'record-range')!;
  it.each(['aliases', 'full'] as const)('filters %s related records by type and outcome while preserving complete downloads and original source positions', async mode => {
    const { f, browser, captured, download, call, exportHistory } = await filteredRelatedFixture(mode);
    const control = filterRelated(browser, 'type', 'verification'); filterRelated(browser, 'outcome', 'failed');
    expect(relatedRange(browser).textContent).toBe('Matching related records 1–1 of 1 (49 in bundle).'); expect(browser.querySelectorAll('[data-history-preview-related-record]').map(row => row.getAttribute('data-history-preview-related-record'))).toEqual(['48']);
    const row = browser.find('data-history-preview-related-record', '48')!; row.open = true; row.fire('toggle'); expect(row.children[0]!.textContent).toMatch(/^1\. Access check · Failed/); contextChoice(row, true); row.find('data-history-preview-control', 'download-record')!.click();
    expect(JSON.parse(download.mock.calls[0]![1])).toMatchObject({ entry: captured.report.entries[48], source_position: 49, source_snapshot: { entry_count: 49 } });
    const bundle = prepareAuthenticationHistoryRelatedDownload(createAuthenticationHistoryRelatedBundles(captured)(0)); f.host.find('data-history-preview-control', 'download-related')!.click(); expect(download).toHaveBeenLastCalledWith(bundle.filename, bundle.json); savePreview(f); expect(download).toHaveBeenLastCalledWith(captured.filename, captured.json);
    expect(control.getAttribute('aria-label')).toBe('Record type for incident ' + captured.report.entries[0]!.record.id); expect(control.getAttribute('aria-describedby')!.split(' ')).toHaveLength(4);
    expect(exportHistory).toHaveBeenCalledOnce(); expect(call).toHaveBeenCalledOnce(); expect(f.panel.hasDraft()).toBe(false); expect(f.panel.hasInFlightWork()).toBe(false); f.panel.dispose();
  });
  it('combines type, outcome and applied text without silently clearing an incompatible choice', async () => {
    const { f, browser, captured } = await filteredRelatedFixture(); filterRelated(browser, 'type', 'verification'); filterRelated(browser, 'outcome', 'failed'); searchRelated(browser, captured.report.entries[48]!.record.id);
    expect(browser.querySelectorAll('[data-history-preview-related-record]')).toHaveLength(1); filterRelated(browser, 'type', 'repair');
    expect(browser.find('data-history-preview-related-filter', 'outcome')!.value).toBe('failed'); expect(relatedRange(browser).textContent).toContain('No related records match this search and these filters.');
    browser.find('data-history-preview-control', 'related-search-clear')!.click(); expect(browser.find('data-history-preview-related-filter', 'type')!.value).toBe('repair'); expect(relatedRange(browser).textContent).toContain('No related records match these filters.');
    browser.find('data-history-preview-control', 'related-filter-clear')!.click(); expect(relatedRange(browser).textContent).toBe('Related records 1–20 of 49'); expect(browser.find('data-history-preview-related-search', 'applied')!.hidden).toBe(true); f.panel.dispose();
  });
  it.each(['draft', 'invalid draft'] as const)('applies filter changes to the last search while retaining the %s, caret and validation', async kind => {
    const { f, browser } = await filteredRelatedFixture(); searchRelated(browser, 'Access check');
    const input = browser.find('data-history-preview-related-search', 'query')!; input.value = kind === 'draft' ? 'not yet searched' : 'x'.repeat(129); input.setSelectionRange(2, 6); input.fire('input'); if (kind === 'invalid draft') browser.find('data-history-preview-related-search', 'form')!.fire('submit');
    filterRelated(browser, 'type', 'verification'); const outcome = filterRelated(browser, 'outcome', 'failed'); expect(f.doc.activeElement).toBe(outcome); expect(relatedRange(browser).textContent).toContain('1–1 of 1 (49 in bundle)');
    expect(browser.find('data-history-preview-related-search', 'applied')!.textContent).toContain('Applied related search: “Access check”. Record type: Access check. Recorded outcome: Failed.');
    expect(input.value).toBe(kind === 'draft' ? 'not yet searched' : 'x'.repeat(129)); expect([input.selectionStart, input.selectionEnd]).toEqual([2, 6]); expect(input.getAttribute('aria-invalid')).toBe(kind === 'draft' ? 'false' : 'true');
    const clear = browser.find('data-history-preview-control', 'related-filter-clear')!; clear.focus!(); clear.click(); expect(f.doc.activeElement).toBe(clear); expect(relatedRange(browser).textContent).toContain('1–3 of 3 (49 in bundle)'); expect(input.value).toBe(kind === 'draft' ? 'not yet searched' : 'x'.repeat(129)); expect(input.getAttribute('aria-invalid')).toBe(kind === 'draft' ? 'false' : 'true'); f.panel.dispose();
  });
  it('resets to the first filtered page, keeps saved order and does not change available choices', async () => {
    const { f, browser } = await filteredRelatedFixture(); const type = browser.find('data-history-preview-related-filter', 'type')!, outcome = browser.find('data-history-preview-related-filter', 'outcome')!;
    expect(type.children.map(option => option.value)).toEqual(['', 'incident', 'repair', 'verification']); expect(outcome.children.map(option => option.value)).toEqual(['', 'retired', 'applied', 'failed', 'passed']);
    browser.find('data-history-preview-control', 'related-next')!.click(); browser.find('data-history-preview-control', 'related-next')!.click(); filterRelated(browser, 'type', 'incident'); expect(relatedRange(browser).textContent).toBe('Matching related records 1–20 of 45 (49 in bundle).');
    const next = browser.find('data-history-preview-control', 'related-next')!; next.focus!(); next.click(); next.click(); expect(relatedRange(browser).textContent).toBe('Matching related records 41–45 of 45 (49 in bundle).'); expect(f.doc.activeElement).toBe(relatedRange(browser)); expect(browser.querySelectorAll('[data-history-preview-related-record]').map(row => row.getAttribute('data-history-preview-related-record'))).toEqual(['40', '41', '42', '43', '44']);
    filterRelated(browser, 'outcome', 'failed'); expect(relatedRange(browser).textContent).toContain('No related records match these filters.'); expect(type.children.map(option => option.value)).toEqual(['', 'incident', 'repair', 'verification']); expect(outcome.children.map(option => option.value)).toEqual(['', 'retired', 'applied', 'failed', 'passed']); f.panel.dispose();
  });
  it.each(['with criteria', 'without criteria'] as const)('keeps immediate filters outside the text form and restores their visibility %s after Back and Forward', async state => {
    const { f, browser, captured } = await filteredRelatedFixture(); const filtered = state === 'with criteria';
    if (filtered) { searchRelated(browser, 'Access check'); filterRelated(browser, 'type', 'verification'); filterRelated(browser, 'outcome', 'failed'); }
    const form = browser.find('data-history-preview-related-search', 'form')!, group = browser.find('data-history-preview-related-filter', 'controls')!, applied = browser.find('data-history-preview-related-search', 'applied')!;
    const type = browser.find('data-history-preview-related-filter', 'type')!, outcome = browser.find('data-history-preview-related-filter', 'outcome')!, reset = browser.find('data-history-preview-control', 'related-filter-clear')!;
    expect([type, outcome, reset].some(control => form.contains(control))).toBe(false);
    const input = browser.find('data-history-preview-related-search', 'query')!; input.value = 'x'.repeat(129); input.setSelectionRange(2, 7); form.fire('submit');
    filterRelated(browser, 'type', '__proto__'); const filterError = browser.find('data-history-preview-related-filter', 'error')!, before = relatedRange(browser).textContent;
    const row = browser.find('data-history-preview-related-record', filtered ? '48' : '0')!; row.open = true; row.fire('toggle'); savedLink(row, 'repair', captured.report.entries[45]!.record.id).click();
    expect([form.hidden, group.hidden, applied.hidden]).toEqual([true, true, true]); form.fire('submit'); type.fire('change'); reset.click(); expect(relatedRange(browser).textContent).toBe(before);
    relatedBack(browser); relatedForward(browser); relatedBack(browser);
    expect([form.hidden, group.hidden, applied.hidden, filterError.hidden]).toEqual([false, false, !filtered, false]); expect(relatedRange(browser).textContent).toBe(before);
    expect([type.value, outcome.value]).toEqual(filtered ? ['verification', 'failed'] : ['', '']); expect(input.value).toHaveLength(129); expect(input.getAttribute('aria-invalid')).toBe('true'); expect([input.selectionStart, input.selectionEnd]).toEqual([2, 7]); f.panel.dispose();
  });
  it('keeps filtered results and each linked view\'s captured criteria across Back, Forward and further links outside the filters', async () => {
    const { f, browser, captured } = await filteredRelatedFixture(); filterRelated(browser, 'type', 'incident'); filterRelated(browser, 'outcome', 'retired');
    const row = browser.find('data-history-preview-related-record', '0')!; row.open = true; row.fire('toggle'); savedLink(row, 'repair', captured.report.entries[45]!.record.id).click(); const first = currentLinked(browser)!;
    expect(first.text()).toContain('Related filters used when this view opened: Record type: Incident. Recorded outcome: Closed without confirmed recovery.'); expect(first.text()).toContain('This record was outside those related filters when this view opened.'); relatedBack(browser);
    filterRelated(browser, 'type', 'verification'); filterRelated(browser, 'outcome', 'passed'); relatedForward(browser); expect(currentLinked(browser)).toBe(first); expect(first.text()).not.toContain('Related filters used when this view opened: Record type: Access check.');
    const links = first.find('data-history-preview-related-links', 'records')!; links.find('data-history-preview-control', 'related-links-next')!.click(); links.find('data-history-preview-control', 'related-links-next')!.click();
    savedLink(first, 'verification', captured.report.entries[46]!.record.id).click(); const second = currentLinked(browser)!; expect(second.text()).toContain('Related filters used when this view opened: Record type: Incident.'); expect(second.text()).toContain('This record was outside those related filters when this view opened.');
    relatedBack(browser); relatedBack(browser); expect(browser.find('data-history-preview-related-filter', 'type')!.value).toBe('verification'); expect(browser.find('data-history-preview-related-filter', 'outcome')!.value).toBe('passed'); expect(relatedRange(browser).textContent).toBe('Matching related records 1–2 of 2 (49 in bundle).'); expect(f.doc.activeElement).toBe(relatedRange(browser)); relatedForward(browser); expect(currentLinked(browser)).toBe(first); f.panel.dispose();
  });
  it('keeps two bundle filters independent through refresh and disclosure collapse', async () => {
    const { f, browser } = await filteredRelatedFixture(); const other = openRelatedBrowser(f, 1); filterRelated(browser, 'type', 'verification'); filterRelated(browser, 'outcome', 'failed'); filterRelated(other, 'type', 'repair');
    await f.panel.refresh(); browser.open = false; browser.fire('toggle'); browser.open = true; browser.fire('toggle'); expect(relatedRange(browser).textContent).toContain('1–1 of 1 (49 in bundle)'); expect(relatedRange(other).textContent).toContain('1–1 of 1 (49 in bundle)'); expect(browser.find('data-history-preview-related-filter', 'outcome')!.value).toBe('failed'); expect(other.find('data-history-preview-related-filter', 'outcome')!.value).toBe(''); expect(other.find('data-history-preview-related-filter', 'type')!.value).toBe('repair'); f.panel.dispose();
  });
  it.each(['resolve', 'reject'] as const)('retires a filtered-out record\'s controls and delayed copy on %s', async outcome => {
    const { f, browser, captured, download } = await filteredRelatedFixture(); filterRelated(browser, 'type', 'verification'); filterRelated(browser, 'outcome', 'failed'); const row = browser.find('data-history-preview-related-record', '48')!; row.open = true; row.fire('toggle');
    let finish!: () => void, reject!: (error: Error) => void; const write = vi.fn(() => new Promise<void>((resolve, fail) => { finish = resolve; reject = fail; })); copyBrowser(f, { clipboard: { writeText: write } }); const copy = row.find('data-history-preview-control', 'copy-record')!, status = row.find('data-history-preview-copy', 'record-status')!, staleSave = row.find('data-history-preview-control', 'download-record')!; copy.click(); const oldStatus = status.textContent;
    const selected = filterRelated(browser, 'outcome', 'passed'); copy.click(); staleSave.click(); if (outcome === 'resolve') finish(); else reject(Error('private-old-filter-copy')); await settleCopy();
    expect(write).toHaveBeenCalledOnce(); expect(status.textContent).toBe(oldStatus); expect(download).not.toHaveBeenCalled(); expect(f.doc.activeElement).toBe(selected); expect(relatedRange(browser).textContent).toContain('1–2 of 2 (49 in bundle)'); savePreview(f); expect(download).toHaveBeenCalledExactlyOnceWith(captured.filename, captured.json); f.panel.dispose();
  });
  it('replaces a Forward branch through filtered results and retires its pending feedback', async () => {
    const { f, browser, captured } = await filteredRelatedFixture(); const row = browser.find('data-history-preview-related-record', '0')!; row.open = true; row.fire('toggle'); savedLink(row, 'repair', captured.report.entries[45]!.record.id).click(); const first = currentLinked(browser)!;
    let reject!: (error: Error) => void; const write = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; })); copyBrowser(f, { clipboard: { writeText: write } }); first.find('data-history-preview-control', 'copy-record')!.click(); const status = first.find('data-history-preview-copy', 'record-status')!, before = status.textContent; relatedBack(browser);
    filterRelated(browser, 'type', 'verification'); filterRelated(browser, 'outcome', 'failed'); const selected = browser.find('data-history-preview-related-record', '48')!; selected.open = true; selected.fire('toggle'); savedLink(selected, 'repair', captured.report.entries[45]!.record.id).click(); const replacement = currentLinked(browser)!; expect(replacement).not.toBe(first); expect(browser.contains(first)).toBe(false); expect(replacement.text()).toContain('Related filters used when this view opened: Record type: Access check. Recorded outcome: Failed.');
    reject(Error('private-retired-branch')); await settleCopy(); expect(status.textContent).toBe(before); expect(browser.find('data-history-preview-control', 'related-reference-forward')!.disabled).toBe(true); expect(write).toHaveBeenCalledOnce(); f.panel.dispose();
  });
  it('stops an older filter render if cleanup applies a newer outcome filter', async () => {
    const { f, browser } = await filteredRelatedFixture(); const items = browser.find('data-history-preview-related', 'record-list')!, remove = items.removeChild.bind(items); let changed = false;
    items.removeChild = child => { remove(child); if (!changed) { changed = true; filterRelated(browser, 'outcome', 'failed'); } };
    filterRelated(browser, 'type', 'incident'); expect(changed).toBe(true); expect(browser.find('data-history-preview-related-filter', 'type')!.value).toBe('incident'); expect(browser.find('data-history-preview-related-filter', 'outcome')!.value).toBe('failed'); expect(relatedRange(browser).textContent).toContain('No related records match these filters.'); expect(browser.querySelectorAll('[data-history-preview-related-record]')).toHaveLength(0); expect(browser.find('data-history-preview-related-search', 'applied')!.textContent).toBe('Record type: Incident. Recorded outcome: Failed.'); f.panel.dispose();
  });
  it('preserves a newer outside focus selected while filtering removes a record', async () => {
    const { f, browser } = await filteredRelatedFixture(); const outside = f.host.find('data-history-preview-search', 'query')!, items = browser.find('data-history-preview-related', 'record-list')!, remove = items.removeChild.bind(items), scroll = vi.fn(); Object.assign(relatedRange(browser), { scrollIntoView: scroll }); items.removeChild = child => { remove(child); outside.focus!(); };
    filterRelated(browser, 'type', 'repair'); expect(f.doc.activeElement).toBe(outside); expect(scroll).not.toHaveBeenCalled(); expect(relatedRange(browser).textContent).toContain('1–1 of 1 (49 in bundle)'); f.panel.dispose();
  });
  it.each(['type', 'outcome'] as const)('rejects an unknown %s selection without changing results or exposing it in an error', async key => {
    const { f, browser } = await filteredRelatedFixture(); filterRelated(browser, 'type', 'verification'); filterRelated(browser, 'outcome', 'failed'); const before = relatedRange(browser).textContent; const control = filterRelated(browser, key, '__proto__');
    expect(relatedRange(browser).textContent).toBe(before); expect(control.value).toBe(key === 'type' ? 'verification' : 'failed'); const error = browser.find('data-history-preview-related-filter', 'error')!; expect(error.hidden).toBe(false); expect(error.textContent).not.toContain('__proto__'); filterRelated(browser, key, key === 'type' ? 'verification' : 'failed'); expect(error.hidden).toBe(true); f.panel.dispose();
  });
  it.each(['preview query', 'privacy', 'close', 'new snapshot', 'parent page', 'dispose'] as const)('leaves retired related filter controls inert after %s', async phase => {
    const { f, browser, download, call, exportHistory } = await filteredRelatedFixture(); filterRelated(browser, 'type', 'verification'); filterRelated(browser, 'outcome', 'failed'); const before = relatedRange(browser).textContent;
    if (phase === 'preview query') searchPreview(f, 'no records'); else if (phase === 'privacy') { const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change'); } else if (phase === 'close') f.host.find('data-history-preview-control', 'close')!.click(); else if (phase === 'new snapshot') { f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); } else if (phase === 'parent page') f.host.find('data-history-preview-control', 'next')!.click(); else f.panel.dispose();
    const calls = [call.mock.calls.length, exportHistory.mock.calls.length], focus = f.doc.activeElement; const type = browser.find('data-history-preview-related-filter', 'type')!, outcome = browser.find('data-history-preview-related-filter', 'outcome')!; type.value = 'incident'; type.fire('change'); outcome.value = 'retired'; outcome.fire('change'); browser.find('data-history-preview-control', 'related-filter-clear')!.click();
    expect(relatedRange(browser).textContent).toBe(before); expect(f.doc.activeElement).toBe(focus); expect([call.mock.calls.length, exportHistory.mock.calls.length]).toEqual(calls); expect(download).not.toHaveBeenCalled(); f.panel.dispose();
  });
  it.each(['normal', 'new criteria'] as const)('keeps related pointer reset focus and scroll owned during cleanup: %s', async action => {
    const { f, browser } = await filteredRelatedFixture(); filterRelated(browser, 'type', 'verification'); filterRelated(browser, 'outcome', 'failed'); const row = browser.find('data-history-preview-related-record', '48')!; row.open = true; row.fire('toggle');
    const reset = browser.find('data-history-preview-control', 'related-filter-clear')!, range = relatedRange(browser), copy = row.find('data-history-preview-control', 'copy-record')!, scroll = vi.fn(); Object.assign(range, { scrollIntoView: scroll }); let changed = false;
    const focus = range.focus!; if (action === 'new criteria') range.focus = options => { focus(options); if (changed) return; changed = true; const type = browser.find('data-history-preview-related-filter', 'type')!, outcome = browser.find('data-history-preview-related-filter', 'outcome')!; type.value = 'verification'; type.fire('change'); outcome.value = 'passed'; outcome.fire('change'); };
    copy.focus!(); reset.fire('pointerdown'); f.doc.activeElement = f.doc.body; reset.fire('click', 1); expect(f.doc.activeElement).toBe(range);
    if (action === 'normal') { expect(range.textContent).toBe('Related records 1–20 of 49'); expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: 'nearest' }); }
    else { expect(changed).toBe(true); expect(range.textContent).toBe('Matching related records 1–2 of 2 (49 in bundle).'); expect(scroll).not.toHaveBeenCalled(); } f.panel.dispose();
  });
  it('offers only the saved type and outcome in a one-record bundle, and an empty reset leaves open details intact', async () => {
    const value = historyExport({ kind: 'all' }, 1), f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value }); await f.panel.whenLoaded(); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); const browser = openRelatedBrowser(f, 0), row = browser.find('data-history-preview-related-record', '0')!; row.open = true; row.fire('toggle');
    expect(browser.find('data-history-preview-related-filter', 'type')!.children.map(option => option.value)).toEqual(['', 'incident']); expect(browser.find('data-history-preview-related-filter', 'outcome')!.children.map(option => option.value)).toEqual(['', 'retired']); browser.find('data-history-preview-control', 'related-filter-clear')!.click(); expect(browser.find('data-history-preview-related-record', '0')).toBe(row); expect(row.open).toBe(true); filterRelated(browser, 'type', 'incident'); filterRelated(browser, 'outcome', 'retired'); expect(relatedRange(browser).textContent).toBe('Matching related records 1–1 of 1 (1 in bundle).'); expect(browser.find('data-history-preview-control', 'related-next')).toBeUndefined(); f.panel.dispose();
  });
  it.each(['results', 'linked'] as const)('uses visible %s fallback focus when the retained origin cannot be focused after Forward', async location => {
    const { f, captured, browser, root, origin, first } = await relatedForwardFixture();
    let link = origin, record = root;
    if (location === 'linked') {
      link = savedLink(first, 'incident', captured.report.entries[0]!.record.id); link.focus!(); link.click();
      record = first.find('data-history-preview-linked-record', '45')!;
    }
    relatedBack(browser); record.open = false; record.fire('toggle');
    // Native focus on a button inside closed details does nothing.
    const unavailable = vi.fn(); link.focus = unavailable;
    relatedForward(browser); const target = location === 'results' ? browser.find('data-history-preview-related', 'record-range')! : first.find('data-history-preview-related-linked', 'heading')!;
    const scroll = vi.fn(); Object.assign(target, { scrollIntoView: scroll }); relatedBack(browser);
    expect(unavailable).toHaveBeenCalledExactlyOnceWith({ preventScroll: true }); expect(f.doc.activeElement).toBe(target); expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: 'nearest' });
    expect(record.open).toBe(false); expect(browser.find('data-history-preview-related-navigation', 'records')!.text()).toContain('The earlier link is no longer shown.');
    expect(browser.find('data-history-preview-control', 'related-reference-forward')!.disabled).toBe(false); f.panel.dispose();
  });
  it.each(['newer focus', 'closed preview'] as const)('does not use Back fallback when an origin focus attempt selects %s', async change => {
    const { f, browser, origin } = await relatedForwardFixture(); relatedBack(browser); relatedForward(browser);
    const outside = f.host.find('data-history-preview-search', 'query')!, range = browser.find('data-history-preview-related', 'record-range')!, scroll = vi.fn(); Object.assign(range, { scrollIntoView: scroll });
    origin.focus = () => { if (change === 'newer focus') outside.focus!(); else f.host.find('data-history-preview-control', 'close')!.click(); };
    relatedBack(browser); expect(scroll).not.toHaveBeenCalled();
    if (change === 'newer focus') { expect(f.doc.activeElement).toBe(outside); expect(browser.find('data-history-preview-related-navigation', 'records')!.text()).not.toContain('The earlier link is no longer shown.'); }
    else expect(f.host.find('data-history-preview', 'report')!.hidden).toBe(true);
    f.panel.dispose();
  });
  it.each(['aliases', 'full'] as const)('restores the exact %s linked view on Forward, including nested pages, copy fallback and source context', async mode => {
    const { f, captured, browser, first, download } = await relatedForwardFixture(mode); const clipboard = copyBrowser(f);
    const incidents = first.find('data-history-preview-field', 'incidents')!; incidents.open = true; incidents.fire('toggle'); incidents.find('data-history-preview-control', 'array-next')!.click(); const links = first.find('data-history-preview-related-links', 'records')!; links.find('data-history-preview-control', 'related-links-next')!.click(); links.find('data-history-preview-control', 'related-links-next')!.click();
    contextChoice(first, true); first.find('data-history-preview-control', 'copy-record')!.click(); const manual = first.find('data-history-preview-copy', 'manual-record')!; expect(manual).toBeDefined(); relatedBack(browser);
    expect(first.hidden).toBe(true); expect(currentLinked(browser)).toBeUndefined(); expect(browser.find('data-history-preview-control', 'related-history-back')!.disabled).toBe(true); relatedForward(browser);
    expect(currentLinked(browser)).toBe(first); expect(f.doc.activeElement).toBe(first.find('data-history-preview-related-linked', 'heading')); expect(incidents.open).toBe(true); expect(incidents.text()).toContain('Items 21–40 of 45'); expect(links.text()).toContain('Saved links 41–46 of 46'); expect(first.find('data-history-preview-copy', 'manual-record')).toBe(manual);
    first.find('data-history-preview-control', 'select-copy-record')!.click(); expect(clipboard.selected()).toBe(manual); first.find('data-history-preview-control', 'download-record')!.click(); const saved = JSON.parse(download.mock.calls[0]![1]); expect(saved.entry).toEqual(captured.report.entries[45]); expect(saved.source_position).toBe(46); expect(saved.source_snapshot.entry_count).toBe(48); expect(saved.privacy_mode).toBe(mode);
    expect(browser.find('data-history-preview-control', 'related-reference-forward')!.disabled).toBe(true); expect(first.find('data-history-preview-control', 'related-inline-forward')!.disabled).toBe(true); expect(browser.find('data-history-preview-control', 'related-reference-forward')!.getAttribute('aria-label')).toContain('Forward to next record for incident '); f.host.find('data-history-preview-control', 'download')!.click(); expect(download.mock.calls[1]![1]).toBe(captured.json); f.panel.dispose();
  });
  it('walks multiple retained views forward in order while hidden controls stay inactive', async () => {
    const { f, captured, browser, first, download } = await relatedForwardFixture(); const link = savedLink(first, 'incident', captured.report.entries[0]!.record.id); link.click(); const second = currentLinked(browser)!; relatedBack(browser); relatedBack(browser);
    first.find('data-history-preview-control', 'related-reference-back')!.click(); first.find('data-history-preview-control', 'download-record')!.click(); expect(download).not.toHaveBeenCalled(); expect(currentLinked(browser)).toBeUndefined(); relatedForward(browser); expect(currentLinked(browser)).toBe(first); expect(browser.find('data-history-preview-related-navigation', 'records')!.text()).toContain('1 next step.');
    relatedForward(browser, true); expect(currentLinked(browser)).toBe(second); expect(browser.querySelectorAll('[data-history-preview-related-linked="view"]')).toHaveLength(2); expect(browser.find('data-history-preview-control', 'related-reference-forward')!.disabled).toBe(true); f.panel.dispose();
  });
  it.each(['search', 'page', 'invalid draft'] as const)('keeps Forward after changing the results %s, and returns to the current results without losing the new view', async change => {
    const { f, browser, first } = await relatedForwardFixture('full'); relatedBack(browser); const query = browser.find('data-history-preview-related-search', 'query')!;
    if (change === 'search') searchRelated(browser, 'no saved forward match'); else if (change === 'page') browser.find('data-history-preview-control', 'related-next')!.click(); else { query.value = 'x'.repeat(129); query.setSelectionRange(2, 7); browser.find('data-history-preview-related-search', 'form')!.fire('submit'); }
    const range = browser.find('data-history-preview-related', 'record-range')!, text = range.textContent, draft = query.value; relatedForward(browser); expect(currentLinked(browser)).toBe(first); relatedBack(browser);
    expect(query.value).toBe(draft); expect(range.textContent).toBe(text); if (change === 'invalid draft') { expect(query.getAttribute('aria-invalid')).toBe('true'); expect(query.selectionStart).toBe(2); } else { expect(f.doc.activeElement).toBe(range); expect(browser.find('data-history-preview-related-navigation', 'records')!.text()).toContain('earlier link is no longer shown'); } f.panel.dispose();
  });
  it('keeps each linked view\'s applied field search after a different results search is applied', async () => {
    const { f, browser, captured } = await relatedForwardFixture('full'); relatedBack(browser); searchRelated(browser, 'Incident'); const root = browser.find('data-history-preview-related-record', '0')!; root.open = true; root.fire('toggle'); savedLink(root, 'repair', captured.report.entries[45]!.record.id).click(); const first = currentLinked(browser)!;
    relatedBack(browser); searchRelated(browser, 'Access check'); relatedForward(browser); expect(currentLinked(browser)).toBe(first); expect(first.text()).toContain('Search used for these saved fields: “Incident”'); savedLink(first, 'incident', captured.report.entries[0]!.record.id).click(); expect(currentLinked(browser)!.text()).toContain('Search used for these saved fields: “Incident”'); relatedBack(browser); relatedBack(browser); expect(browser.find('data-history-preview-related-search', 'query')!.value).toBe('Access check'); f.panel.dispose();
  });
  it.each(['results', 'linked'] as const)('replaces the Forward branch after a new link from %s and retires its old controls and pending copy', async source => {
    const { f, captured, browser, first, origin, download } = await relatedForwardFixture(); let reject!: (error: unknown) => void; const write = vi.fn(() => new Promise<void>((_, no) => { reject = no; })); copyBrowser(f, { clipboard: { writeText: write } });
    const old = source === 'linked' ? (savedLink(first, 'incident', captured.report.entries[0]!.record.id).click(), currentLinked(browser)!) : first;
    const copy = old.find('data-history-preview-control', 'copy-record')!, status = old.find('data-history-preview-copy', 'record-status')!; copy.focus!(); copy.click(); relatedBack(browser);
    if (source === 'results') origin.click(); else savedLink(first, 'incident', captured.report.entries[1]!.record.id).click(); const current = currentLinked(browser)!, focus = f.doc.activeElement; reject(Error('private-discarded-forward')); await settleCopy(); copy.click(); old.find('data-history-preview-control', 'download-record')!.click(); old.find('data-history-preview-control', 'related-reference-back')!.click();
    expect(browser.contains(old)).toBe(false); expect(currentLinked(browser)).toBe(current); expect(write).toHaveBeenCalledOnce(); expect(download).not.toHaveBeenCalled(); expect(status.textContent).toBe('Copying record JSON…'); expect(f.doc.activeElement).toBe(focus); expect(browser.text()).not.toContain('private-discarded-forward'); expect(browser.find('data-history-preview-control', 'related-reference-forward')!.disabled).toBe(true); f.panel.dispose();
  });
  it.each(['resolve', 'reject'] as const)('settles a retained future-view copy on %s without stealing focus, then reveals it on Forward', async outcome => {
    const { f, browser, first } = await relatedForwardFixture(); let resolve!: () => void, reject!: (error: unknown) => void; const write = vi.fn(() => new Promise<void>((yes, no) => { resolve = yes; reject = no; })); const clipboard = copyBrowser(f, { clipboard: { writeText: write } }); const copy = first.find('data-history-preview-control', 'copy-record')!;
    copy.focus!(); copy.click(); relatedBack(browser); const focus = f.doc.activeElement; if (outcome === 'resolve') resolve(); else reject(Error('private-future-copy')); await settleCopy(); expect(f.doc.activeElement).toBe(focus); expect(clipboard.selection.addRange).not.toHaveBeenCalled(); expect(copy.getAttribute('aria-busy')).toBe('false'); copy.click(); expect(write).toHaveBeenCalledOnce(); relatedForward(browser);
    expect(currentLinked(browser)).toBe(first); if (outcome === 'resolve') expect(first.find('data-history-preview-copy', 'record-status')!.textContent).toBe('Record JSON copied.'); else { const manual = first.find('data-history-preview-copy', 'manual-record')!; first.find('data-history-preview-control', 'select-copy-record')!.click(); expect(clipboard.selected()).toBe(manual); } expect(browser.text()).not.toContain('private-future-copy'); f.panel.dispose();
  });
  it('shares the twenty retained linked-view slots across both directions and releases the future on a new branch', async () => {
    const { f, browser, captured, root, first } = await relatedForwardFixture();
    for (let n = 1; n < 20; n++) savedLink(currentLinked(browser)!, n % 2 ? 'incident' : 'repair', captured.report.entries[n % 2 ? 0 : 45]!.record.id).click();
    for (let n = 0; n < 20; n++) relatedBack(browser); expect(currentLinked(browser)).toBeUndefined(); expect(browser.querySelectorAll('[data-history-preview-related-linked="view"]')).toHaveLength(20); expect(browser.find('data-history-preview-related-navigation', 'records')!.text()).toContain('20 next steps.');
    for (let n = 0; n < 20; n++) relatedForward(browser); expect(browser.querySelectorAll('[data-history-preview-related-linked="view"]')).toHaveLength(20); expect(currentLinked(browser)!.text()).toContain('20 linked records open'); for (let n = 0; n < 20; n++) relatedBack(browser);
    savedLink(root, 'repair', captured.report.entries[45]!.record.id).click(); expect(browser.querySelectorAll('[data-history-preview-related-linked="view"]')).toHaveLength(1); expect(browser.contains(first)).toBe(false); expect(browser.find('data-history-preview-control', 'related-reference-forward')!.disabled).toBe(true); f.panel.dispose();
  });
  it.each(['preview query', 'privacy', 'close', 'new snapshot', 'parent page', 'dispose'])('retires both directions and future controls when the bundle owner changes through %s', async phase => {
    const { f, browser, first, download } = await relatedForwardFixture(); relatedBack(browser); const forward = browser.find('data-history-preview-control', 'related-reference-forward')!;
    if (phase === 'preview query') searchPreview(f, 'no main preview match'); else if (phase === 'privacy') { const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change'); } else if (phase === 'close') f.host.find('data-history-preview-control', 'close')!.click(); else if (phase === 'new snapshot') { f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); } else if (phase === 'parent page') f.host.find('data-history-preview-control', 'next')!.click(); else f.panel.dispose();
    const focus = f.doc.activeElement; forward.click(); first.find('data-history-preview-control', 'related-reference-back')!.click(); first.find('data-history-preview-control', 'download-record')!.click(); expect(f.doc.activeElement).toBe(focus); expect(download).not.toHaveBeenCalled(); f.panel.dispose();
  });
  it('keeps two bundle Forward trails and their results independent through refresh and disclosure collapse', async () => {
    const { f, browser: first, captured, first: pane } = await relatedForwardFixture(); const second = openRelatedBrowser(f, 1), root = second.find('data-history-preview-related-record', '1')!; root.open = true; root.fire('toggle'); savedLink(root, 'repair', captured.report.entries[45]!.record.id).click(); const secondPane = currentLinked(second)!; relatedBack(first); await f.panel.refresh(); first.open = false; first.fire('toggle'); first.open = true; first.fire('toggle'); relatedForward(first);
    expect(currentLinked(first)).toBe(pane); expect(currentLinked(second)).toBe(secondPane); relatedBack(first); expect(currentLinked(second)).toBe(secondPane); f.panel.dispose();
  });
  it.each(['related-reference-forward', 'related-inline-forward'])('preserves a newer outside focus selected before pointer activation of %s', async key => {
    const { f, browser, first, captured } = await relatedForwardFixture(); savedLink(first, 'incident', captured.report.entries[0]!.record.id).click(); const next = currentLinked(browser)!; relatedBack(browser); const control = (key === 'related-inline-forward' ? first : browser).find('data-history-preview-control', key)!, outside = f.host.find('data-history-preview-search', 'query')!; Reflect.set(outside, 'isConnected', true);
    first.find('data-history-preview-related-linked', 'heading')!.focus!(); control.fire('pointerdown'); outside.focus!(); control.fire('click', 1); expect(currentLinked(browser)).toBe(next); expect(f.doc.activeElement).toBe(outside); f.panel.dispose();
  });
  it.each(['related-reference-forward', 'related-inline-forward'])('focuses the retained heading on a normal pointer activation of %s', async key => {
    const { f, browser, first, captured } = await relatedForwardFixture(); savedLink(first, 'incident', captured.report.entries[0]!.record.id).click(); const next = currentLinked(browser)!; relatedBack(browser); const control = (key === 'related-inline-forward' ? first : browser).find('data-history-preview-control', key)!;
    first.find('data-history-preview-related-linked', 'heading')!.focus!(); control.fire('pointerdown'); control.fire('click', 1); expect(f.doc.activeElement).toBe(next.find('data-history-preview-related-linked', 'heading')); f.panel.dispose();
  });
  it('preserves a newer focus chosen when the last shared Forward button is disabled', async () => {
    const { f, browser, first } = await relatedForwardFixture(); relatedBack(browser); const forward = browser.find('data-history-preview-control', 'related-reference-forward')!, outside = f.host.find('data-history-preview-search', 'query')!; let disabled = forward.disabled;
    Object.defineProperty(forward, 'disabled', { get: () => disabled, set: value => { disabled = value; if (value && f.doc.activeElement === forward) outside.focus!(); } }); relatedForward(browser); expect(currentLinked(browser)).toBe(first); expect(f.doc.activeElement).toBe(outside); f.panel.dispose();
  });
  it('guards Forward and Back against reentry while a retained view is being revealed', async () => {
    const { f, browser, first } = await relatedForwardFixture(); relatedBack(browser); let hidden = first.hidden, attempted = false; Object.defineProperty(first, 'hidden', { get: () => hidden, set: value => { hidden = value; if (!value && !attempted) { attempted = true; browser.find('data-history-preview-control', 'related-history-back')!.click(); browser.find('data-history-preview-control', 'related-reference-forward')!.click(); } } });
    relatedForward(browser); expect(attempted).toBe(true); expect(currentLinked(browser)).toBe(first); expect(browser.querySelectorAll('[data-history-preview-related-linked="view"]')).toHaveLength(1); expect(browser.find('data-history-preview-control', 'related-reference-forward')!.disabled).toBe(true); f.panel.dispose();
  });
  const relatedNavigationFixture = async (kind: 'matches' | 'array' | 'hits') => {
    const value = largeRelatedFixture(); const record = value.entries[0]!.record; if (!('group' in record)) throw Error();
    record.group.label = 'Needle needle NEEDLE'; record.group.uses = Array.from({ length: 45 }, (_, n) => ({ kind: 'pack', id: 'pack-' + n, label: 'Saved use ' + n }));
    const f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value }); await f.panel.whenLoaded(); const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); const browser = openRelatedBrowser(f, 0); searchRelated(browser, kind === 'matches' ? 'Kind' : kind === 'array' ? 'Uses' : 'Needle');
    const row = browser.find('data-history-preview-related-record', '0')!; row.open = true; row.fire('toggle');
    if (kind !== 'matches') row.find('data-history-preview-match-path', JSON.stringify(kind === 'array' ? ['record', 'group', 'uses'] : ['record', 'group', 'label']))!.click();
    const owner = kind === 'matches' ? row.find('data-history-preview-matches', 'fields')! : kind === 'array' ? row.find('data-history-preview-field', 'uses')! : row.find('data-history-preview-hits', 'navigation')!;
    const range = kind === 'array' ? owner.children.find(child => child.getAttribute('role') === 'status')! : owner.find(kind === 'matches' ? 'data-history-preview-match-range' : 'data-history-preview-hit-range', kind === 'matches' ? 'fields' : 'value')!;
    const next = owner.find('data-history-preview-control', kind === 'matches' ? 'matches-next' : kind === 'array' ? 'array-next' : 'hit-next')!;
    return { ...f, browser, row, owner, range, next };
  };
  it.each(['matches', 'array', 'hits'] as const)('preserves a newer draft and its scroll position when a related %s pager disables during blur', async kind => {
    const f = await relatedNavigationFixture(kind); const draft = f.browser.find('data-history-preview-related-search', 'query')!; const scroll = vi.fn(); Object.assign(f.range, { scrollIntoView: scroll });
    for (const mark of f.row.querySelectorAll('[data-history-preview-value-highlight]')) Object.assign(mark, { scrollIntoView: scroll });
    let disabled = f.next.disabled; Object.defineProperty(f.next, 'disabled', { get: () => disabled, set: (value: boolean) => { const boundary = value && !disabled; disabled = value; if (boundary) { draft.value = 'Newer related draft'; draft.setSelectionRange(2, 8); draft.focus!(); } } });
    while (!f.next.disabled) { scroll.mockClear(); f.next.focus!(); f.next.click(); }
    expect(f.doc.activeElement).toBe(draft); expect([draft.value, draft.selectionStart, draft.selectionEnd]).toEqual(['Newer related draft', 2, 8]); expect(scroll).not.toHaveBeenCalled(); f.panel.dispose();
  });
  it.each(['matches', 'array'] as const)('reveals the focused range at a related %s paging boundary', async kind => {
    const f = await relatedNavigationFixture(kind); const scroll = vi.fn(); Object.assign(f.range, { scrollIntoView: scroll });
    while (!f.next.disabled) { f.next.focus!(); f.next.click(); }
    expect(f.doc.activeElement).toBe(f.range); expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: 'nearest' }); f.panel.dispose();
  });
  it.each(['matches', 'array', 'hits'] as const)('does not scroll an old related %s range after its focus handler chooses a newer field', async kind => {
    const f = await relatedNavigationFixture(kind); const draft = f.host.find('data-history-preview-search', 'query')!; const scroll = vi.fn(); Object.assign(f.range, { scrollIntoView: scroll });
    for (const mark of f.row.querySelectorAll('[data-history-preview-value-highlight]')) Object.assign(mark, { scrollIntoView: scroll });
    const focus = f.range.focus!; f.range.focus = () => { focus(); draft.value = 'Newer focused field'; draft.setSelectionRange(3, 9); draft.focus!(); };
    while (!f.next.disabled) { scroll.mockClear(); f.next.focus!(); f.next.click(); }
    expect(f.doc.activeElement).toBe(draft); expect(scroll).not.toHaveBeenCalled(); f.panel.dispose();
  });
  it.each(['view', 'return'] as const)('preserves newer focus and avoids scrolling the old destination during related %s navigation', async action => {
    const f = await relatedNavigationFixture('hits'); const draft = f.browser.find('data-history-preview-related-search', 'query')!;
    const view = f.row.find('data-history-preview-match-path', JSON.stringify(['record', 'group', 'label']))!; const target = f.row.find('data-history-preview-path', JSON.stringify(['record', 'group', 'label']))!;
    const destination = action === 'view' ? target : view; const focus = destination.focus!; destination.focus = () => { focus(); draft.value = 'Newer navigation draft'; draft.focus!(); };
    const scroll = vi.fn(); Object.assign(destination, { scrollIntoView: scroll }); const create = f.doc.createElement; f.doc.createElement = () => Object.assign(create(), { scrollIntoView: scroll });
    if (action === 'view') view.click(); else target.find('data-history-preview-control', 'return-matches')!.click();
    expect(f.doc.activeElement).toBe(draft); expect(scroll).not.toHaveBeenCalled(); f.panel.dispose();
  });
  it.each(['aliases', 'full'] as const)('previews and opens the exact late related %s field without changing the parent search or download bytes', async mode => {
    const value = largeRelatedFixture(); const record = value.entries[40]!.record; if (!('group' in record)) throw Error();
    const label = 'x'.repeat(200) + ' Café ＡＢＣ ﬃ [a.*] <img src=x> ' + 'z'.repeat(200);
    record.group.uses = Array.from({ length: 45 }, (_, i) => ({ kind: 'pack', id: 'unique-pack-' + i, label: i === 44 ? label : 'Other ' + i }));
    const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode); const saved = captured.report.entries[40]!.record; if (!('group' in saved)) throw Error();
    const query = mode === 'aliases' ? saved.group.uses[44]!.id : 'CAFÉ abc FFI [a.*]'; const path = ['record', 'group', 'uses', 44, mode === 'aliases' ? 'id' : 'label'];
    const download = vi.fn(); const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value); const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page(value.scope));
    const f = mount(call, value.scope, { exportHistory, download }); const write = vi.fn().mockResolvedValue(undefined); copyBrowser(f, { clipboard: { writeText: write } }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = mode; privacy.fire('change'); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded();
    record.group.uses[44]!.label = 'Later source mutation'; const parentQuery = saved.id; searchPreview(f, parentQuery); const browser = openRelatedBrowser(f); searchRelated(browser, query);
    const row = browser.find('data-history-preview-related-record', '40')!; expect(row.children[0]!.text()).toContain('1 matching field. First: Group › Uses › Item 45'); expect(row.children).toHaveLength(1);
    row.open = true; row.fire('toggle'); const matches = row.find('data-history-preview-matches', 'fields')!; expect(matches.querySelectorAll('[data-history-preview-match-path]')).toHaveLength(1);
    if (mode === 'full') { expect(matches.text()).toContain('…'); expect(matches.querySelectorAll('[data-history-preview-highlight="match"]').map(literalText)).toContain('Café ＡＢＣ ﬃ [a.*]'); }
    else expect(matches.text()).not.toMatch(/Café|unique-pack|Other|<img/);
    expect(row.find('data-history-preview-field', 'uses')).toBeUndefined(); const view = matches.find('data-history-preview-match-path', JSON.stringify(path))!; expect(view.getAttribute('aria-label')).toContain(saved.id); view.click();
    const target = row.find('data-history-preview-path', JSON.stringify(path))!; expect(f.doc.activeElement).toBe(target); expect(row.find('data-history-preview-field', 'uses')!.text()).toContain('Items 41–45 of 45');
    expect(row.find('data-history-preview-path', JSON.stringify(['record', 'group', 'uses', 0, 'id']))).toBeUndefined(); expect(target.getAttribute('data-history-preview-match-target')).toBe('true');
    expect(target.querySelectorAll('[data-history-preview-value-highlight="display"]').map(literalText)).toEqual([mode === 'aliases' ? saved.group.uses[44]!.id : 'Café ＡＢＣ ﬃ [a.*]']);
    target.find('data-history-preview-control', 'copy-value')!.click(); await settleCopy(); expect(write).toHaveBeenCalledExactlyOnceWith(mode === 'aliases' ? saved.group.uses[44]!.id : label);
    const input = browser.find('data-history-preview-related-search', 'query')!; input.value = 'Unapplied draft'; input.setSelectionRange(2, 8); await f.panel.refresh(); expect(f.doc.activeElement).toBe(target);
    target.find('data-history-preview-control', 'return-matches')!.click(); expect(f.doc.activeElement).toBe(view); expect([input.value, input.selectionStart, input.selectionEnd]).toEqual(['Unapplied draft', 2, 8]);
    expect(f.host.find('data-history-preview-search', 'query')!.value).toBe(parentQuery); expect(browser.text()).not.toContain('Later source mutation'); expect(f.panel.hasDraft()).toBe(false);
    openRelated(f).find('data-history-preview-control', 'download-related')!.click(); const expected = prepareAuthenticationHistoryRelatedDownload(createAuthenticationHistoryRelatedBundles(captured)(40)); expect(download).toHaveBeenLastCalledWith(expected.filename, expected.json);
    savePreview(f); expect(download).toHaveBeenLastCalledWith(captured.filename, captured.json); expect(exportHistory).toHaveBeenCalledTimes(1); expect(call).toHaveBeenCalledTimes(2); f.panel.dispose();
  });
  it('pages related matching fields, restores their original match page and opens field-name-only container hits', async () => {
    const value = largeRelatedFixture(); const record = value.entries[0]!.record; if (!('group' in record)) throw Error(); record.group.uses = Array.from({ length: 45 }, (_, i) => ({ kind: 'pack', id: 'pack-' + i, label: 'Other' }));
    const f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value }); await f.panel.whenLoaded(); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); const browser = openRelatedBrowser(f, 0); searchRelated(browser, 'Kind');
    const row = browser.find('data-history-preview-related-record', '0')!; row.open = true; row.fire('toggle'); const matches = row.find('data-history-preview-matches', 'fields')!; const next = matches.find('data-history-preview-control', 'matches-next')!;
    for (let i = 0; i < 9; i++) next.click(); const path = ['record', 'group', 'uses', 44, 'kind']; const view = matches.find('data-history-preview-match-path', JSON.stringify(path))!; const originalRange = matches.find('data-history-preview-match-range', 'fields')!.textContent; expect(originalRange).toMatch(/^Matching fields 46–[0-9]+ of [0-9]+$/); expect(view).toBeDefined(); view.click();
    const target = row.find('data-history-preview-path', JSON.stringify(path))!; expect(target.querySelectorAll('[data-history-preview-value-highlight]')).toHaveLength(0); expect(browser.find('data-history-preview-related', 'match-notice')!.textContent).toContain('field name matches');
    const back = row.find('data-history-preview-control', 'return-matches')!; matches.find('data-history-preview-control', 'matches-previous')!.click(); expect(matches.find('data-history-preview-match-range', 'fields')!.textContent).toMatch(/^Matching fields 41–45 of [0-9]+$/); back.click();
    const restored = matches.find('data-history-preview-match-path', JSON.stringify(path))!; expect(restored).not.toBe(view); expect(f.doc.activeElement).toBe(restored); expect(matches.find('data-history-preview-match-range', 'fields')!.textContent).toBe(originalRange);
    searchRelated(browser, 'Uses'); const container = browser.find('data-history-preview-related-record', '0')!; container.open = true; container.fire('toggle'); container.find('data-history-preview-match-path', JSON.stringify(['record', 'group', 'uses']))!.click();
    const disclosure = container.find('data-history-preview-field', 'uses')!; expect(disclosure.open).toBe(true); expect(f.doc.activeElement).toBe(disclosure.children[0]); expect(disclosure.children[0]!.contains(container.find('data-history-preview-control', 'return-matches')!)).toBe(false); f.panel.dispose();
  });
  it.each(['¨', '̈́', 'CAFÉ'])('keeps the original related query through Unicode field matching and highlights for %s', async query => {
    const value = largeRelatedFixture(); const record = value.entries[0]!.record; if (!('group' in record)) throw Error(); record.group.label = 'Saved ¨ ̈́ Cafe\u0301 text';
    const f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value }); await f.panel.whenLoaded(); const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change'); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded();
    const browser = openRelatedBrowser(f, 0); searchRelated(browser, query); const row = browser.find('data-history-preview-related-record', '0')!; row.open = true; row.fire('toggle');
    const view = row.find('data-history-preview-match-path', JSON.stringify(['record', 'group', 'label']))!; expect(view).toBeDefined(); view.click(); const target = f.doc.activeElement; expect(target.querySelectorAll('[data-history-preview-value-highlight]')).not.toHaveLength(0);
    searchRelated(browser, 'x'.repeat(129)); expect(f.doc.activeElement).toBe(target); expect(row.find('data-history-preview-match-target', 'true')).toBe(target); expect(browser.find('data-history-preview-related-record', '0')).toBe(row);
    target.find('data-history-preview-control', 'return-matches')!.click(); expect(f.doc.activeElement).toBe(view); f.panel.dispose();
  });
  it('discards a late related value-copy refusal after the local search removes its field', async () => {
    const value = largeRelatedFixture(); const f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value }); let reject!: (error: unknown) => void;
    const write = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; })); const clipboard = copyBrowser(f, { clipboard: { writeText: write } }); await f.panel.whenLoaded(); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded();
    const browser = openRelatedBrowser(f, 0); searchRelated(browser, 'Incident'); const row = browser.find('data-history-preview-related-record', '0')!; row.open = true; row.fire('toggle'); row.find('data-history-preview-match-path', JSON.stringify(['type']))!.click();
    const copy = row.find('data-history-preview-control', 'copy-value')!; copy.focus!(); copy.click(); expect(write).toHaveBeenCalledExactlyOnceWith('incident'); searchRelated(browser, 'Access check'); const input = browser.find('data-history-preview-related-search', 'query')!; input.focus!();
    reject(Error('private-copy-refusal')); await settleCopy(); expect(f.doc.activeElement).toBe(input); expect(browser.find('data-history-preview-copy', 'manual-value')).toBeUndefined(); expect(clipboard.selection.addRange).not.toHaveBeenCalled(); expect(browser.text()).not.toContain('private-copy-refusal'); f.panel.dispose();
  });
  it('keeps main navigation and two related matching-field return paths independent, including their accessible descriptions', async () => {
    const value = largeRelatedFixture(); const f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value }); await f.panel.whenLoaded(); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'Incident');
    const first = openRelatedBrowser(f, 0); const second = openRelatedBrowser(f, 1); const selected: Element[] = []; const origins: Element[] = [];
    for (const browser of [first, second]) { searchRelated(browser, 'Incident'); const row = browser.querySelectorAll('[data-history-preview-related-record]')[0]!; row.open = true; row.fire('toggle'); const view = row.find('data-history-preview-match-path', JSON.stringify(['type']))!; view.click(); selected.push(f.doc.activeElement); origins.push(view); }
    expect(selected[0]).not.toBe(selected[1]); expect(first.find('data-history-preview-control', 'return-matches')).toBeDefined(); expect(first.find('data-history-preview-control', 'return-matches')!.getAttribute('aria-label')).not.toBe(second.find('data-history-preview-control', 'return-matches')!.getAttribute('aria-label'));
    expect(selected[0]!.find('data-history-preview-control', 'hit-next')!.getAttribute('aria-describedby')).not.toBe(selected[1]!.find('data-history-preview-control', 'hit-next')!.getAttribute('aria-describedby'));
    const parent = f.host.find('data-history-preview-record', '0')!; const mainMatches = parent.children.find(child => child.getAttribute('data-history-preview-matches') === 'fields')!; mainMatches.find('data-history-preview-match-path', JSON.stringify(['type']))!.click(); expect(selected).not.toContain(f.doc.activeElement);
    for (const [i, browser] of [first, second].entries()) { browser.find('data-history-preview-control', 'return-matches')!.click(); expect(f.doc.activeElement).toBe(origins[i]); }
    searchRelated(first, 'unmatched'); expect(selected[0]!.getAttribute('data-history-preview-match-target')).toBe('false'); expect(selected[1]!.getAttribute('data-history-preview-match-target')).toBe('true'); second.find('data-history-preview-control', 'return-matches')!.click(); expect(f.doc.activeElement).toBe(origins[1]); f.panel.dispose();
  });
  it.each(['related query', 'related page', 'preview query', 'privacy', 'close', 'new snapshot', 'parent page', 'dispose'])('leaves detached related match, return, hit and copy controls inert after %s', async phase => {
    const value = largeRelatedFixture(); const f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value }); const write = vi.fn().mockResolvedValue(undefined); copyBrowser(f, { clipboard: { writeText: write } }); await f.panel.whenLoaded();
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); const browser = openRelatedBrowser(f, 0); searchRelated(browser, 'Incident'); const row = browser.find('data-history-preview-related-record', '0')!; row.open = true; row.fire('toggle'); const view = row.find('data-history-preview-match-path', JSON.stringify(['type']))!; view.click();
    const back = row.find('data-history-preview-control', 'return-matches')!; const copy = row.find('data-history-preview-control', 'copy-value')!; const hit = row.find('data-history-preview-control', 'hit-next')!;
    if (phase === 'related query') searchRelated(browser, 'Access check'); else if (phase === 'related page') browser.find('data-history-preview-control', 'related-next')!.click(); else if (phase === 'preview query') searchPreview(f, 'retired');
    else if (phase === 'privacy') { const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change'); } else if (phase === 'close') f.host.find('data-history-preview-control', 'close')!.click();
    else if (phase === 'new snapshot') { f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); } else if (phase === 'parent page') f.host.find('data-history-preview-control', 'next')!.click(); else f.panel.dispose();
    if (phase === 'related query' || phase === 'related page') { expect(browser.find('data-history-preview-related', 'match-notice')!.hidden).toBe(true); expect(browser.find('data-history-preview-related', 'match-notice')!.textContent).toBe(''); }
    const focused = f.doc.activeElement; view.click(); back.click(); copy.click(); hit.click(); row.fire('toggle'); await settleCopy(); expect(f.doc.activeElement, phase).toBe(focused); expect(write, phase).not.toHaveBeenCalled(); f.panel.dispose();
  });
  it.each(['aliases', 'full'] as const)('searches all prepared %s bundle fields with independent local pages and unchanged downloads', async mode => {
    const value = largeRelatedFixture(); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode); const bundle = createAuthenticationHistoryRelatedBundles(captured)(40); const prepared = prepareAuthenticationHistoryRelatedDownload(bundle);
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page(value.scope)); const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value); const download = vi.fn();
    const f = mount(call, value.scope, { exportHistory, download }); await f.panel.whenLoaded(); const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = mode; privacy.fire('change');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); const mainQuery = captured.report.entries[40]!.record.id; searchPreview(f, mainQuery); const browser = openRelatedBrowser(f);
    const query = browser.find('data-history-preview-related-search', 'query')!; expect(query.getAttribute('maxlength')).toBe('128'); expect(query.getAttribute('aria-label')).toContain(bundle.report.root.id);
    query.value = 'Closed without confirmed recovery'; query.fire('input'); expect(browser.find('data-history-preview-related', 'record-range')!.textContent).toBe('Related records 1–20 of 48');
    browser.find('data-history-preview-related-search', 'form')!.fire('submit'); const range = browser.find('data-history-preview-related', 'record-range')!; expect(range.textContent).toBe('Matching related records 1–20 of 45 (48 in bundle).');
    const next = browser.find('data-history-preview-control', 'related-next')!; next.focus!(); next.click(); next.click(); expect(range.textContent).toBe('Matching related records 41–45 of 45 (48 in bundle).'); expect(f.doc.activeElement).toBe(range);
    expect(browser.querySelectorAll('[data-history-preview-related-record]').map(row => row.getAttribute('data-history-preview-related-record'))).toEqual(['40', '41', '42', '43', '44']);
    expect(browser.find('data-history-preview-related-record', '40')!.text()).toContain('Selected incident'); expect(browser.find('data-history-preview-related', 'record-list')!.children.map(item => item.getAttribute('aria-setsize'))).toEqual(Array(5).fill('45'));
    for (const text of ['Access check', 'api_read', 'Authentication fingerprint', 'ＡＣＣＥＳＳ　ＣＨＥＣＫ']) {
      searchRelated(browser, text); expect(range.textContent).toBe('Matching related records 1–2 of 2 (48 in bundle).'); const rows = browser.querySelectorAll('[data-history-preview-related-record]');
      expect(rows.map(row => row.getAttribute('data-history-preview-related-record'))).toEqual(['46', '47']); expect(rows[0]!.children).toHaveLength(1); expect(rows[0]!.children[0]!.textContent).toMatch(/^1\. /);
    }
    expect(next.disabled).toBe(true); expect(browser.find('data-history-preview-control', 'related-previous')!.disabled).toBe(true);
    searchRelated(browser, '.*'); expect(range.textContent).toContain('No related records match this search'); expect(browser.querySelectorAll('[data-history-preview-related-record]')).toHaveLength(0);
    expect(range.textContent).toContain('all 48 records'); browser.find('data-history-preview-control', 'related-return-download')!.click(); const save = f.host.find('data-history-preview-control', 'download-related')!;
    expect(f.doc.activeElement).toBe(save); expect(download).not.toHaveBeenCalled(); save.click(); expect(download).toHaveBeenCalledExactlyOnceWith(prepared.filename, prepared.json); savePreview(f); expect(download).toHaveBeenLastCalledWith(captured.filename, captured.json);
    browser.find('data-history-preview-control', 'related-search-clear')!.click(); expect(f.doc.activeElement).toBe(query); expect(query.value).toBe(''); expect(range.textContent).toBe('Related records 1–20 of 48'); expect(browser.find('data-history-preview-related-search', 'applied')!.hidden).toBe(true);
    expect(f.host.find('data-history-preview-search', 'query')!.value).toBe(mainQuery); expect(f.host.find('data-history-preview-record', '40')).toBeDefined(); expect(exportHistory).toHaveBeenCalledTimes(1); expect(call).toHaveBeenCalledTimes(1); expect(f.panel.hasDraft()).toBe(false); expect(f.panel.hasInFlightWork()).toBe(false); f.panel.dispose();
  });
  it.each(['aliases', 'full'] as const)('searches closed %s saved details without exposing omitted names, secrets or records outside the bundle', async mode => {
    const value = largeRelatedFixture(); const last = value.entries[44]!.record; if (!('group' in last)) throw Error();
    last.group.uses = Array.from({ length: 45 }, (_, n) => ({ kind: 'pack', id: 'saved-pack-' + n, label: n === 44 ? 'Cafe\u0301 ＡＢＣ ﬃ [a.*]' : 'Other saved pack' })); Object.assign(last, { access_token: 'private-search-token' });
    const outside = historyExport(value.scope, 1).entries[0]!; outside.record.id = '99999999-1234-4123-8123-123456789abc'; value.entries.push(outside); value.entry_count++;
    const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode); const f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = mode; privacy.fire('change'); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, captured.report.entries[40]!.record.id);
    const browser = openRelatedBrowser(f); searchRelated(browser, ' CAFÉ abc FFI [a.*] '); const range = browser.find('data-history-preview-related', 'record-range')!;
    if (mode === 'full') {
      expect(range.textContent).toBe('Matching related records 1–1 of 1 (48 in bundle).'); const row = browser.find('data-history-preview-related-record', '44')!; expect(row.children).toHaveLength(1);
      row.open = true; row.fire('toggle'); const group = row.find('data-history-preview-field', 'group')!; group.open = true; group.fire('toggle'); const uses = group.find('data-history-preview-field', 'uses')!; uses.open = true; uses.fire('toggle');
      uses.find('data-history-preview-control', 'array-next')!.click(); uses.find('data-history-preview-control', 'array-next')!.click(); expect(uses.text()).toContain('Cafe\u0301 ＡＢＣ ﬃ [a.*]');
    } else expect(range.textContent).toContain('No related records match');
    for (const text of ['private-search-token', captured.report.entries[48]!.record.id]) { searchRelated(browser, text); expect(range.textContent).toContain('No related records match'); }
    searchRelated(browser, captured.report.entries[44]!.record.id); expect(browser.find('data-history-preview-related-record', '44')).toBeDefined(); expect(browser.text()).not.toContain('private-search-token');
    if (mode === 'aliases') expect(browser.text()).not.toMatch(/Cafe|saved-pack|123456789abc|Work/); f.panel.dispose();
  });
  it('keeps invalid related searches and newer drafts from changing applied results, and retains context on refresh and reopening', async () => {
    const value = largeRelatedFixture(); const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page(value.scope)); const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value);
    const f = mount(call, value.scope, { exportHistory }); await f.panel.whenLoaded(); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'incident-41'); const browser = openRelatedBrowser(f);
    searchRelated(browser, 'Closed without confirmed recovery'); browser.find('data-history-preview-control', 'related-next')!.click(); const row = browser.find('data-history-preview-related-record', '20')!; row.open = true; row.fire('toggle');
    const range = browser.find('data-history-preview-related', 'record-range')!; const query = browser.find('data-history-preview-related-search', 'query')!; searchRelated(browser, 'x'.repeat(129)); const error = browser.find('data-history-preview-related-search', 'error')!;
    expect(error.hidden).toBe(false); expect(error.textContent).toContain('128 characters'); expect(query.getAttribute('aria-invalid')).toBe('true'); expect(browser.find('data-history-preview-related-record', '20')).toBe(row); expect(row.open).toBe(true); expect(range.textContent).toBe('Matching related records 21–40 of 45 (48 in bundle).');
    query.value = 'Unapplied related draft'; query.fire('input'); query.focus!(); query.setSelectionRange(2, 8); expect(error.hidden).toBe(true); expect(query.getAttribute('aria-invalid')).toBe('false');
    value.entries.length = 1; await f.panel.refresh(); expect(f.doc.activeElement).toBe(query); expect([query.value, query.selectionStart, query.selectionEnd]).toEqual(['Unapplied related draft', 2, 8]); expect(browser.find('data-history-preview-related-record', '20')).toBe(row);
    browser.open = false; browser.fire('toggle'); browser.open = true; browser.fire('toggle'); expect(row.open).toBe(true); expect(range.textContent).toBe('Matching related records 21–40 of 45 (48 in bundle).'); expect(browser.find('data-history-preview-related-search', 'applied')!.textContent).toContain('Closed without confirmed recovery');
    const next = browser.find('data-history-preview-control', 'related-next')!; next.fire('pointerdown'); next.fire('click', 1); expect(f.doc.activeElement).toBe(query); expect(query.selectionStart).toBe(2); expect(range.textContent).toBe('Matching related records 41–45 of 45 (48 in bundle).');
    searchRelated(browser, 'x'.repeat(128)); expect(error.hidden).toBe(true); expect(range.textContent).toContain('No related records match'); searchRelated(browser, ' \t '); expect(range.textContent).toBe('Related records 1–20 of 48'); expect(browser.find('data-history-preview-related-search', 'applied')!.hidden).toBe(true);
    expect(call).toHaveBeenCalledTimes(2); expect(exportHistory).toHaveBeenCalledTimes(1); expect(f.panel.hasDraft()).toBe(false); f.panel.dispose();
  });
  it('reveals its related search input after clearing while respecting a newer focus destination', async () => {
    const value = largeRelatedFixture(); const f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value }); await f.panel.whenLoaded(); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'incident-41');
    const browser = openRelatedBrowser(f); searchRelated(browser, 'Access check'); const query = browser.find('data-history-preview-related-search', 'query')!; const scroll = vi.fn(); Object.assign(query, { scrollIntoView: scroll });
    const clear = browser.find('data-history-preview-control', 'related-search-clear')!; clear.focus!(); clear.click(); expect(f.doc.activeElement).toBe(query); expect(query.value).toBe(''); expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: 'nearest' });
    const mainQuery = f.host.find('data-history-preview-search', 'query')!; const originalFocus = query.focus!; query.focus = () => { mainQuery.value = 'Newer main preview draft'; mainQuery.setSelectionRange(2, 8); mainQuery.focus!(); };
    clear.focus!(); clear.click(); expect(f.doc.activeElement).toBe(mainQuery); expect([mainQuery.value, mainQuery.selectionStart, mainQuery.selectionEnd]).toEqual(['Newer main preview draft', 2, 8]); expect(scroll).toHaveBeenCalledTimes(1);
    query.focus = originalFocus; searchRelated(browser, 'Closed without confirmed recovery'); browser.find('data-history-preview-control', 'related-next')!.click(); const previous = browser.find('data-history-preview-control', 'related-previous')!;
    let disabled = previous.disabled; Object.defineProperty(previous, 'disabled', { get: () => disabled, set: (value: boolean) => { disabled = value; if (value) { mainQuery.value = 'Newer draft while clearing'; mainQuery.setSelectionRange(3, 9); mainQuery.focus!(); } } });
    previous.focus!(); clear.click(); expect(f.doc.activeElement).toBe(mainQuery); expect([mainQuery.value, mainQuery.selectionStart, mainQuery.selectionEnd]).toEqual(['Newer draft while clearing', 3, 9]); expect(scroll).toHaveBeenCalledTimes(1); expect(browser.find('data-history-preview-related', 'record-range')!.textContent).toBe('Related records 1–20 of 48'); f.panel.dispose();
  });
  it('preserves a newer related draft focused during a paging-boundary blur', async () => {
    const value = largeRelatedFixture(); const f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value }); await f.panel.whenLoaded(); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'incident-41');
    const browser = openRelatedBrowser(f); const next = browser.find('data-history-preview-control', 'related-next')!; next.click(); const query = browser.find('data-history-preview-related-search', 'query')!; const range = browser.find('data-history-preview-related', 'record-range')!; const scroll = vi.fn(); Object.assign(range, { scrollIntoView: scroll });
    let disabled = next.disabled; Object.defineProperty(next, 'disabled', { get: () => disabled, set: (value: boolean) => { disabled = value; if (value) { query.value = 'Newer related draft'; query.setSelectionRange(2, 8); query.focus!(); } } });
    next.focus!(); next.click(); expect(range.textContent).toBe('Related records 41–48 of 48'); expect(next.disabled).toBe(true); expect(f.doc.activeElement).toBe(query); expect([query.value, query.selectionStart, query.selectionEnd]).toEqual(['Newer related draft', 2, 8]); expect(scroll).not.toHaveBeenCalled(); f.panel.dispose();
  });
  it.each(['aliases', 'full'] as const)('keeps two %s related searches, pages and bundle downloads independent', async mode => {
    const value = largeRelatedFixture(); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode); const prepare = createAuthenticationHistoryRelatedBundles(captured); const download = vi.fn();
    const f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value, download }); await f.panel.whenLoaded(); const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = mode; privacy.fire('change');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); f.host.find('data-history-preview-control', 'next')!.click(); f.host.find('data-history-preview-control', 'next')!.click(); const first = openRelatedBrowser(f, 40); const second = openRelatedBrowser(f, 41);
    searchRelated(first, 'Access check'); searchRelated(second, 'Closed without confirmed recovery'); second.find('data-history-preview-control', 'related-next')!.click();
    expect(first.find('data-history-preview-related', 'record-range')!.textContent).toBe('Matching related records 1–2 of 2 (48 in bundle).'); expect(second.find('data-history-preview-related', 'record-range')!.textContent).toBe('Matching related records 21–40 of 45 (48 in bundle).');
    const firstInput = first.find('data-history-preview-related-search', 'query')!; const secondInput = second.find('data-history-preview-related-search', 'query')!; expect(firstInput.getAttribute('aria-describedby')).not.toBe(secondInput.getAttribute('aria-describedby'));
    for (const [browser, index] of [[first, 40], [second, 41]] as const) for (const key of ['related-search', 'related-search-clear']) expect(browser.find('data-history-preview-control', key)!.getAttribute('aria-label')).toContain(captured.report.entries[index]!.record.id);
    await f.panel.refresh(); expect(firstInput.value).toBe('Access check'); expect(secondInput.value).toBe('Closed without confirmed recovery');
    searchRelated(first, 'unmatched related query'); expect(second.find('data-history-preview-related', 'record-range')!.textContent).toContain('21–40'); first.find('data-history-preview-control', 'related-search-clear')!.click(); expect(secondInput.value).toBe('Closed without confirmed recovery');
    for (const [browser, index] of [[first, 40], [second, 41]] as const) {
      browser.find('data-history-preview-control', 'related-return-download')!.click(); const save = f.host.find('data-history-preview-record', String(index))!.find('data-history-preview-control', 'download-related')!; expect(f.doc.activeElement).toBe(save); save.click(); const expected = prepareAuthenticationHistoryRelatedDownload(prepare(index)); expect(download).toHaveBeenLastCalledWith(expected.filename, expected.json);
    }
    f.panel.dispose();
  });
  it('invalidates removed related rows on search and keeps detached search controls inert after their owner changes', async () => {
    for (const phase of ['related query', 'preview query', 'privacy', 'close', 'new snapshot', 'parent page', 'dispose']) {
      const value = largeRelatedFixture(); const download = vi.fn(); const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page(value.scope)); const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value);
      const f = mount(call, value.scope, { exportHistory, download }); await f.panel.whenLoaded(); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); f.host.find('data-history-preview-control', 'next')!.click(); f.host.find('data-history-preview-control', 'next')!.click(); const browser = openRelatedBrowser(f);
      const oldRow = browser.find('data-history-preview-related-record', '0')!;
      if (phase === 'related query') searchRelated(browser, 'Access check'); else if (phase === 'preview query') searchPreview(f, 'retired'); else if (phase === 'privacy') { const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change'); }
      else if (phase === 'close') f.host.find('data-history-preview-control', 'close')!.click(); else if (phase === 'new snapshot') { f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); }
      else if (phase === 'parent page') f.host.find('data-history-preview-control', 'previous')!.click(); else f.panel.dispose();
      oldRow.open = true; oldRow.fire('toggle'); expect(oldRow.children, phase).toHaveLength(1); const focused = f.doc.activeElement; const range = browser.find('data-history-preview-related', 'record-range')!; const text = range.textContent;
      if (phase !== 'related query') { searchRelated(browser, 'x'.repeat(129)); browser.find('data-history-preview-control', 'related-search-clear')!.click(); expect(range.textContent, phase).toBe(text); expect(browser.find('data-history-preview-related-search', 'error')!.hidden, phase).toBe(true); expect(f.doc.activeElement, phase).toBe(focused); }
      expect(download, phase).not.toHaveBeenCalled(); expect(exportHistory).toHaveBeenCalledTimes(phase === 'new snapshot' ? 2 : 1); expect(call).toHaveBeenCalledTimes(1); f.panel.dispose();
    }
  });
  it.each(['aliases', 'full'] as const)('browses the exact %s bundle locally with saved details, original order and complete stable downloads', async mode => {
    const value = largeRelatedFixture(); Object.assign(value.entries[0]!.record, { access_token: 'private-browse-token' });
    const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode); const bundle = createAuthenticationHistoryRelatedBundles(captured)(40); const prepared = prepareAuthenticationHistoryRelatedDownload(bundle);
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page(value.scope)); const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value); const download = vi.fn();
    const f = mount(call, value.scope, { exportHistory, download }); await f.panel.whenLoaded(); const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = mode; privacy.fire('change');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); const query = captured.report.entries[40]!.record.id; searchPreview(f, query);
    const related = openRelated(f); const browser = related.find('data-history-preview-related', 'records')!;
    expect(browser.text()).toContain('Browse related records (48)'); expect(browser.children[0]!.getAttribute('aria-label')).toContain('for incident ' + bundle.report.root.id); expect(browser.querySelectorAll('[data-history-preview-related-record]')).toHaveLength(0);
    browser.open = true; browser.fire('toggle'); browser.fire('toggle'); expect(browser.querySelectorAll('[data-history-preview-related-record]')).toHaveLength(20);
    expect(browser.find('data-history-preview-related', 'record-range')!.textContent).toBe('Related records 1–20 of 48');
    const rows = browser.querySelectorAll('[data-history-preview-related-record]'); expect(rows.map(row => row.getAttribute('data-history-preview-related-record'))).toEqual(Array.from({ length: 20 }, (_, n) => String(n)));
    const first = rows[0]!; expect(first.children).toHaveLength(1); expect(first.text()).toContain(captured.report.entries[0]!.record.id); first.open = true; first.fire('toggle'); first.fire('toggle');
    expect(first.children).toHaveLength(5); expect(first.find('data-history-preview-control', 'copy-record')).toBeDefined(); expect(first.find('data-history-preview-related-links', 'records')).toBeDefined(); expect(first.find('data-history-preview-path', JSON.stringify(['record', 'id']))!.text()).toContain(captured.report.entries[0]!.record.id);
    const group = first.find('data-history-preview-field', 'group')!; group.open = true; group.fire('toggle'); expect(first.text()).not.toContain('private-browse-token');
    if (mode === 'aliases') expect(browser.text()).not.toMatch(/<script>|123456789abc|Work/); else expect(first.text()).toContain('<script>Work</script>');
    const next = browser.find('data-history-preview-control', 'related-next')!; next.focus!(); next.click(); expect(f.doc.activeElement).toBe(next);
    expect(browser.find('data-history-preview-related', 'record-range')!.textContent).toBe('Related records 21–40 of 48'); next.click();
    const range = browser.find('data-history-preview-related', 'record-range')!; expect(range.textContent).toBe('Related records 41–48 of 48'); expect(next.disabled).toBe(true); expect(f.doc.activeElement).toBe(range);
    expect(browser.find('data-history-preview-related', 'record-list')!.children.map(item => item.getAttribute('aria-posinset'))).toEqual(Array.from({ length: 8 }, (_, n) => String(n + 41))); expect(browser.find('data-history-preview-related-record', '40')!.children[0]!.textContent).toMatch(/^41\. /);
    const selected = browser.find('data-history-preview-related-record', '40')!; expect(selected.text()).toContain('Selected incident'); selected.open = true; selected.fire('toggle');
    const savedRepair = browser.find('data-history-preview-related-record', '45')!; savedRepair.open = true; savedRepair.fire('toggle'); const incidents = savedRepair.find('data-history-preview-field', 'incidents')!; incidents.open = true; incidents.fire('toggle');
    incidents.find('data-history-preview-control', 'array-next')!.click(); expect(incidents.text()).toContain('Items 21–40 of 45'); expect(range.textContent).toBe('Related records 41–48 of 48');
    const savedCheck = browser.find('data-history-preview-related-record', '46')!; savedCheck.open = true; savedCheck.fire('toggle'); expect(savedCheck.find('data-history-preview-field', 'selection')).toBeDefined(); selected.children[0]!.focus!();
    const selectedFocus = f.doc.activeElement; value.entries.length = 1; await f.panel.refresh(); expect(f.doc.activeElement).toBe(selectedFocus);
    expect(f.host.find('data-history-preview-related', 'records')).toBe(browser); expect(selected.open).toBe(true); expect(range.textContent).toBe('Related records 41–48 of 48'); expect(incidents.text()).toContain('Items 21–40 of 45');
    browser.open = false; browser.fire('toggle'); browser.open = true; browser.fire('toggle'); expect(browser.querySelectorAll('[data-history-preview-related-record]')).toHaveLength(8);
    const returnButton = browser.find('data-history-preview-control', 'related-return-download')!; expect(returnButton.getAttribute('aria-label')).toContain(bundle.report.root.id); returnButton.click(); const save = related.find('data-history-preview-control', 'download-related')!; expect(f.doc.activeElement).toBe(save);
    expect(download).not.toHaveBeenCalled(); save.click(); expect(download).toHaveBeenCalledExactlyOnceWith(prepared.filename, prepared.json); savePreview(f); expect(download).toHaveBeenLastCalledWith(captured.filename, captured.json);
    expect(f.host.find('data-history-preview-search', 'query')!.value).toBe(query); expect(exportHistory).toHaveBeenCalledTimes(1); expect(call).toHaveBeenCalledTimes(2);
    expect(f.panel.hasDraft()).toBe(false); expect(f.panel.hasInFlightWork()).toBe(false); f.panel.dispose();
  });
  it('keeps main matching-field navigation separate from identical paths in browsed records', async () => {
    const value = largeRelatedFixture(); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'aliases'); const download = vi.fn();
    const f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value, download }); await f.panel.whenLoaded(); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded();
    searchPreview(f, captured.report.entries[40]!.record.id); const browser = openRelatedBrowser(f); const nested = browser.find('data-history-preview-related-record', '0')!; nested.open = true; nested.fire('toggle');
    const parent = f.host.find('data-history-preview-record', '40')!; parent.find('data-history-preview-match-path', JSON.stringify(['record', 'id']))!.click();
    expect(f.doc.activeElement.getAttribute('data-history-preview-path')).toBe(JSON.stringify(['record', 'id'])); expect(browser.contains(f.doc.activeElement)).toBe(false);
    expect(f.doc.activeElement.text()).toContain(captured.report.entries[40]!.record.id); expect(nested.open).toBe(true); expect(browser.find('data-history-preview-related', 'record-range')!.textContent).toBe('Related records 1–20 of 48'); f.panel.dispose();
  });
  it('shows a single-record bundle without paging controls and returns to its download without starting it', async () => {
    const value = historyExport({ kind: 'all' }, 1); const download = vi.fn(); const f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value, download }); await f.panel.whenLoaded();
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); const browser = openRelatedBrowser(f, 0);
    expect(browser.querySelectorAll('[data-history-preview-related-record]')).toHaveLength(1); expect(browser.find('data-history-preview-related', 'record-range')!.textContent).toBe('Related records 1–1 of 1');
    expect(browser.find('data-history-preview-control', 'related-next')).toBeUndefined(); expect(browser.find('data-history-preview-control', 'related-previous')).toBeUndefined();
    browser.find('data-history-preview-control', 'related-return-download')!.click(); expect(f.doc.activeElement).toBe(f.host.find('data-history-preview-control', 'download-related')); expect(download).not.toHaveBeenCalled(); f.panel.dispose();
  });
  it.each(['aliases', 'full'] as const)('keeps two %s bundle browsers independently named, paged and linked to their own download', async mode => {
    const value = largeRelatedFixture(); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode); const prepare = createAuthenticationHistoryRelatedBundles(captured);
    const firstFile = prepareAuthenticationHistoryRelatedDownload(prepare(40)); const secondFile = prepareAuthenticationHistoryRelatedDownload(prepare(41)); const download = vi.fn();
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page(value.scope)); const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value);
    const f = mount(call, value.scope, { exportHistory, download }); await f.panel.whenLoaded(); const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = mode; privacy.fire('change');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); f.host.find('data-history-preview-control', 'next')!.click(); f.host.find('data-history-preview-control', 'next')!.click();
    const first = openRelatedBrowser(f, 40); const second = openRelatedBrowser(f, 41); const next = first.find('data-history-preview-control', 'related-next')!;
    for (const [browser, index] of [[first, 40], [second, 41]] as const) for (const [key, label] of [['related-next', 'Next related records'], ['related-previous', 'Previous related records']] as const) {
      expect(browser.find('data-history-preview-control', key)!.getAttribute('aria-label')).toBe(label + ' for incident ' + captured.report.entries[index]!.record.id);
    }
    expect(next.getAttribute('aria-describedby')).not.toBe(second.find('data-history-preview-control', 'related-next')!.getAttribute('aria-describedby')); next.focus!(); next.click();
    expect(first.find('data-history-preview-related', 'record-range')!.textContent).toBe('Related records 21–40 of 48'); expect(second.find('data-history-preview-related', 'record-range')!.textContent).toBe('Related records 1–20 of 48');
    second.find('data-history-preview-control', 'related-return-download')!.click(); const secondSave = f.host.find('data-history-preview-record', '41')!.find('data-history-preview-control', 'download-related')!;
    expect(f.doc.activeElement).toBe(secondSave); expect(download).not.toHaveBeenCalled(); secondSave.click(); expect(download).toHaveBeenCalledExactlyOnceWith(secondFile.filename, secondFile.json);
    first.find('data-history-preview-control', 'related-return-download')!.click(); const firstSave = f.host.find('data-history-preview-record', '40')!.find('data-history-preview-control', 'download-related')!;
    expect(f.doc.activeElement).toBe(firstSave); firstSave.click(); expect(download).toHaveBeenLastCalledWith(firstFile.filename, firstFile.json); expect(firstFile.filename).not.toBe(secondFile.filename);
    await f.panel.refresh(); expect(f.doc.activeElement).toBe(firstSave); expect(first.find('data-history-preview-related', 'record-range')!.textContent).toBe('Related records 21–40 of 48'); expect(second.find('data-history-preview-related', 'record-range')!.textContent).toBe('Related records 1–20 of 48');
    expect(exportHistory).toHaveBeenCalledTimes(1); expect(call).toHaveBeenCalledTimes(2); expect(f.panel.hasDraft()).toBe(false); f.panel.dispose();
  });
  it('preserves pager focus at both bounds and a newer unapplied preview-search selection', async () => {
    const value = largeRelatedFixture(); const f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value }); await f.panel.whenLoaded(); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded();
    searchPreview(f, 'incident-41'); const browser = openRelatedBrowser(f); const next = browser.find('data-history-preview-control', 'related-next')!; const previous = browser.find('data-history-preview-control', 'related-previous')!;
    next.focus!(); next.click(); previous.focus!(); previous.click(); expect(previous.disabled).toBe(true); expect(f.doc.activeElement).toBe(browser.find('data-history-preview-related', 'record-range'));
    const query = f.host.find('data-history-preview-search', 'query')!; query.value = 'Unapplied browse draft'; query.setSelectionRange(2, 8); query.focus!(); next.fire('pointerdown'); next.fire('click', 1);
    expect(f.doc.activeElement).toBe(query); expect([query.value, query.selectionStart, query.selectionEnd]).toEqual(['Unapplied browse draft', 2, 8]); expect(browser.find('data-history-preview-related', 'record-range')!.textContent).toBe('Related records 21–40 of 48'); f.panel.dispose();
  });
  it('keeps discarded related rows and controls inert after local paging and parent lifetime changes', async () => {
    for (const phase of ['related page', 'query', 'privacy', 'close', 'new snapshot', 'parent page', 'dispose']) {
      const value = largeRelatedFixture(); const download = vi.fn(); const f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value, download }); await f.panel.whenLoaded();
      f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); f.host.find('data-history-preview-control', 'next')!.click(); f.host.find('data-history-preview-control', 'next')!.click(); const browser = openRelatedBrowser(f);
      const oldRow = browser.find('data-history-preview-related-record', '0')!; const next = browser.find('data-history-preview-control', 'related-next')!; const back = browser.find('data-history-preview-control', 'related-return-download')!;
      if (phase === 'related page') next.click(); else if (phase === 'query') searchPreview(f, 'retired'); else if (phase === 'privacy') { const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change'); }
      else if (phase === 'close') f.host.find('data-history-preview-control', 'close')!.click(); else if (phase === 'new snapshot') { f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); }
      else if (phase === 'parent page') f.host.find('data-history-preview-control', 'previous')!.click(); else f.panel.dispose();
      const focused = f.doc.activeElement; const savedRange = browser.find('data-history-preview-related', 'record-range')!.textContent; oldRow.open = true; oldRow.fire('toggle'); expect(oldRow.children, phase).toHaveLength(1);
      if (phase !== 'related page') { next.click(); back.click(); expect(browser.find('data-history-preview-related', 'record-range')!.textContent, phase).toBe(savedRange); expect(f.doc.activeElement, phase).toBe(focused); }
      expect(download, phase).not.toHaveBeenCalled(); f.panel.dispose();
    }
  });
  it.each(['aliases', 'full'] as const)('reviews and downloads linked %s history across closed pages and local search without another request', async mode => {
    const value = relatedFixture(); const expected = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode); const bundle = createAuthenticationHistoryRelatedBundles(expected)(40);
    const prepared = prepareAuthenticationHistoryRelatedDownload(bundle); const download = vi.fn(); const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page(value.scope));
    const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value); const f = mount(call, value.scope, { exportHistory, download }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = mode; privacy.fire('change'); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded();
    expect(download).not.toHaveBeenCalled(); expect(f.host.find('data-history-preview-control', 'download-related')).toBeUndefined(); searchPreview(f, expected.report.entries[40]!.record.id);
    const related = openRelated(f); expect(related.text()).toContain('5 saved records: 2 incidents · 1 repair · 2 access checks · 0 token renewals.');
    expect(related.text()).toContain('0 missing references'); expect(related.text()).toContain('Excluded or unrecorded links cannot be discovered'); expect(download).not.toHaveBeenCalled();
    expect(related.querySelectorAll('[data-history-preview-control="download-related"]')).toHaveLength(1);
    const save = related.find('data-history-preview-control', 'download-related')!; expect(save.getAttribute('aria-label')).toContain(expected.report.entries[40]!.record.id);
    const described = save.getAttribute('aria-describedby')!.split(' '); expect(described).toHaveLength(6); expect(described.some(id => id.endsWith('-related-limits'))).toBe(true);
    save.focus!(); save.click(); expect(download).toHaveBeenCalledExactlyOnceWith(prepared.filename, prepared.json);
    expect(related.find('data-history-preview-related', 'status')!.textContent).toBe('Related history download requested.'); expect(f.doc.activeElement).toBe(save);
    value.entries.length = 1; await f.panel.refresh(); expect(f.host.find('data-history-preview-control', 'download-related')).toBe(save); expect(f.doc.activeElement).toBe(save);
    save.click(); expect(download).toHaveBeenLastCalledWith(prepared.filename, prepared.json); savePreview(f); expect(download).toHaveBeenLastCalledWith(expected.filename, expected.json);
    expect(exportHistory).toHaveBeenCalledTimes(1); expect(call).toHaveBeenCalledTimes(2); expect(f.panel.hasDraft()).toBe(false); expect(f.panel.hasInFlightWork()).toBe(false); f.panel.dispose();
  });
  it('shows missing saved references and incomplete-detail counts in the bundle review and file', async () => {
    const value = relatedFixture(); const shared = value.entries[45]!.record; if (!('incidents' in shared)) throw Error(); shared.incidents.push(repair().incidents[0]!); shared.incidents_truncated = true;
    const download = vi.fn(); const f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value, download }); await f.panel.whenLoaded();
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); f.host.find('data-history-preview-control', 'next')!.click(); f.host.find('data-history-preview-control', 'next')!.click();
    const related = openRelated(f); expect(related.text()).toContain('1 missing reference · 1 record with saved incomplete-detail flags. Zero does not establish complete history.');
    expect(related.find('data-history-preview-field', 'missing_references')).toBeDefined(); related.find('data-history-preview-control', 'download-related')!.click();
    expect(JSON.parse(download.mock.calls[0]![1])).toMatchObject({ entry_count: 5, incomplete_record_count: 1, missing_reference_count: 1,
      missing_references: [{ from: { type: 'repair' }, to: { type: 'incident' }, reason: 'outside_snapshot' }] }); f.panel.dispose();
  });
  it.each(['aliases', 'full'] as const)('pages all missing %s references locally while the download retains the complete bundle', async mode => {
    const value = relatedFixture(); const shared = value.entries[45]!.record; if (!('incidents' in shared)) throw Error();
    shared.incidents = [shared.incidents[0]!, ...Array.from({ length: 63 }, (_, n) => ({ id: (n + 100).toString(16).padStart(8, '0') + '-1234-4123-8123-123456789abc', group_id: 'a'.repeat(64), label: 'Private missing account ' + n }))];
    const expected = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode); const bundle = createAuthenticationHistoryRelatedBundles(expected)(40); const prepared = prepareAuthenticationHistoryRelatedDownload(bundle);
    const download = vi.fn(); const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page(value.scope)); const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value);
    const f = mount(call, value.scope, { exportHistory, download }); await f.panel.whenLoaded(); const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = mode; privacy.fire('change');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, expected.report.entries[40]!.record.id); const related = openRelated(f);
    expect(related.text()).toContain('63 missing references'); const missing = related.find('data-history-preview-field', 'missing_references')!; missing.open = true; missing.fire('toggle');
    for (let offset = 0; offset < 63; offset += 20) {
      expect(missing.text()).toContain(`Items ${offset + 1}–${Math.min(offset + 20, 63)} of 63`);
      const target = missing.find('data-history-preview-field', 'to')!; target.open = true; target.fire('toggle'); expect(target.text()).toContain(bundle.report.missing_references[offset]!.to.id);
      if (offset < 60) missing.find('data-history-preview-control', 'array-next')!.click();
    }
    expect(missing.find('data-history-preview-control', 'array-next')!.disabled).toBe(true); related.find('data-history-preview-control', 'download-related')!.click();
    expect(download).toHaveBeenCalledExactlyOnceWith(prepared.filename, prepared.json); expect(JSON.parse(download.mock.calls[0]![1]).missing_references).toHaveLength(63);
    expect(call).toHaveBeenCalledTimes(1); expect(exportHistory).toHaveBeenCalledTimes(1); f.panel.dispose();
  });
  it('offers an exact retry with isolated feedback after a bundle download refusal', async () => {
    const value = relatedFixture(); const download = vi.fn().mockImplementationOnce(() => { throw Error('private-related-error'); });
    const f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value, download }); await f.panel.whenLoaded(); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded();
    searchPreview(f, 'incident-41'); const related = openRelated(f); const save = related.find('data-history-preview-control', 'download-related')!; save.focus!(); save.click();
    expect(related.find('data-history-preview-related', 'error')!.hidden).toBe(false); expect(related.find('data-history-preview-related', 'status')!.hidden).toBe(true); expect(f.host.text()).not.toContain('private-related-error');
    const entry = f.host.find('data-history-preview-record', '40')!; entry.find('data-history-preview-control', 'download-record')!.click();
    expect(related.find('data-history-preview-related', 'error')!.hidden).toBe(false); expect(entry.find('data-history-preview-download', 'record-status')!.textContent).toBe('Record file download requested.');
    save.click(); expect(download.mock.calls[2]).toEqual(download.mock.calls[0]); expect(related.find('data-history-preview-related', 'error')!.hidden).toBe(true);
    expect(related.find('data-history-preview-related', 'status')!.textContent).toBe('Related history download requested.'); f.panel.dispose();
  });
  it('preserves newer draft focus and selection during pointer activation of a bundle download', async () => {
    const value = relatedFixture(); const download = vi.fn(); const f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value, download }); await f.panel.whenLoaded();
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'incident-41'); const related = openRelated(f);
    const draft = f.host.find('data-history-preview-search', 'query')!; draft.value = 'unapplied draft'; draft.setSelectionRange(2, 6); draft.focus!(); related.find('data-history-preview-control', 'download-related')!.fire('click', 1);
    expect(f.doc.activeElement).toBe(draft); expect([draft.value, draft.selectionStart, draft.selectionEnd]).toEqual(['unapplied draft', 2, 6]); expect(download).toHaveBeenCalledTimes(1); f.panel.dispose();
  });
  it('keeps discarded bundle controls inert across record and preview lifetime changes', async () => {
    for (const phase of ['query', 'privacy', 'close', 'new snapshot', 'record page', 'dispose']) {
      const value = relatedFixture(); const download = vi.fn(); const f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value, download }); await f.panel.whenLoaded();
      f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); f.host.find('data-history-preview-control', 'next')!.click(); f.host.find('data-history-preview-control', 'next')!.click();
      const related = openRelated(f); const old = related.find('data-history-preview-control', 'download-related')!;
      if (phase === 'query') searchPreview(f, 'retired'); else if (phase === 'privacy') { const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change'); }
      else if (phase === 'close') f.host.find('data-history-preview-control', 'close')!.click(); else if (phase === 'new snapshot') { f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); }
      else if (phase === 'record page') f.host.find('data-history-preview-control', 'previous')!.click(); else f.panel.dispose();
      const focused = f.doc.activeElement; old.click(); expect(download, phase).not.toHaveBeenCalled(); expect(related.find('data-history-preview-related', 'status')!.textContent, phase).toBe(''); expect(f.doc.activeElement, phase).toBe(focused); f.panel.dispose();
    }
  });
  it.each(['return', 'throw'] as const)('ignores discarded bundle feedback when its download callback changes the view then %s', async outcome => {
    for (const phase of ['query', 'privacy', 'close', 'dispose']) {
      const value = relatedFixture(); let f!: ReturnType<typeof mount>; let chosen: Element | undefined; const download = vi.fn(() => {
        if (phase === 'query') { searchPreview(f, 'retired'); f.host.find('data-history-preview-search', 'query')!.focus!(); }
        else if (phase === 'privacy') { const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change'); privacy.focus!(); }
        else if (phase === 'close') f.host.find('data-history-preview-control', 'close')!.click(); else f.panel.dispose();
        chosen = f.doc.activeElement; if (outcome === 'throw') throw Error('private-related-error');
      });
      f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value, download }); await f.panel.whenLoaded(); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded();
      searchPreview(f, 'incident-41'); const related = openRelated(f); const old = related.find('data-history-preview-control', 'download-related')!; old.focus!(); old.click();
      expect(download, phase).toHaveBeenCalledTimes(1); expect(related.find('data-history-preview-related', 'status')!.textContent, phase).toBe(''); expect(related.find('data-history-preview-related', 'error')!.textContent, phase).toBe('');
      expect(f.doc.activeElement, phase).toBe(chosen); expect(f.host.text(), phase).not.toContain('private-related-error'); old.click(); expect(download, phase).toHaveBeenCalledTimes(1); f.panel.dispose();
    }
  });
  it.each(['aliases', 'full'] as const)('copies and downloads exactly one complete prepared %s JSON entry for every history kind without a search or another request', async mode => {
    const scope = { kind: 'all' } as const; const value = historyExport(scope, 1); const token = renewal();
    token.results = Array.from({ length: 32 }, (_, index) => ({ id: (index + 1).toString(16).padStart(64, '0'), revision: 'f'.repeat(64), label: 'Saved grant ' + index,
      connections: Array.from({ length: 45 }, (_, n) => 'nested-target-' + index + '-' + n), native_accounts: [], eligible: true, status: 'passed', current: 'no' }));
    const verification: AuthenticationAccessVerification = { id: 'verify-12345678-1234-4123-8123-123456789abc', selection: { kind: 'repair', id: repair().id }, status: 'completed', started_at: 130, finished_at: 140,
      targets_truncated: false, usage_available: true, uses: [], results: [{ id: '3'.repeat(64), label: 'Work API', target: { kind: 'connection', name: 'work' }, authentication_revision: '4'.repeat(64), current: 'yes', checks: [{ kind: 'api_read', status: 'passed' }] }] };
    for (const record of [repair(), verification, token]) value.entries.push({ type: authenticationHistoryEntryType(record), outcome: authenticationHistoryEntryOutcome(record), record }); value.entry_count = value.entries.length;
    Object.assign(value.entries[0]!.record, { access_token: 'private-record-copy' });
    const expected = prepareAuthenticationHistoryDownload(value, { scope }, mode); const download = vi.fn(); const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page(scope));
    const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value);
    const write = vi.fn(function(this: { tag: string }, _text: string) { expect(this.tag).toBe('clipboard'); return Promise.resolve(); });
    const f = mount(call, scope, { exportHistory, download }); await f.panel.whenLoaded(); copyBrowser(f, { clipboard: { tag: 'clipboard', writeText: write } });
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = mode; privacy.fire('change'); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded();
    expect(write).not.toHaveBeenCalled(); expect(f.host.find('data-history-preview-control', 'copy-record')).toBeUndefined();
    if ('group' in value.entries[0]!.record) value.entries[0]!.record.group.label = 'Later source label';
    for (let index = 0; index < expected.count; index++) {
      const entry = f.host.find('data-history-preview-record', String(index))!; entry.open = true; entry.fire('toggle'); entry.fire('toggle');
      expect(entry.querySelectorAll('[data-history-preview-copy="record-controls"]')).toHaveLength(1);
      const copy = entry.find('data-history-preview-control', 'copy-record')!; copy.focus!(); copy.click(); copy.click();
      expect(write).toHaveBeenCalledTimes(index + 1); const raw = write.mock.calls[index]![0];
      expect(raw).toBe(JSON.stringify(expected.report.entries[index])); expect(JSON.parse(raw)).toEqual(expected.report.entries[index]);
      expect(Object.keys(JSON.parse(raw))).toEqual(['type', 'outcome', 'record']); expect(raw).not.toMatch(/private-record-copy|Later source label|Copy record as JSON/);
      await settleCopy(); expect(entry.find('data-history-preview-copy', 'record-status')!.textContent).toBe('Record JSON copied.'); expect(f.doc.activeElement).toBe(copy);
      const save = entry.find('data-history-preview-control', 'download-record')!; save.focus!(); save.click();
      const filename = expected.filename.slice(0, -5) + '-record-' + expected.report.entries[index]!.type + '-' + (index + 1) + '.json';
      expect(download).toHaveBeenNthCalledWith(index + 1, filename, raw); expect(filename).toMatch(/^recued-connection-history-(?:aliases-)?1970-01-01T00-00-00-300Z-record-(?:incident|repair|verification|renewal)-[1-4]\.json$/);
      expect(entry.find('data-history-preview-download', 'record-status')!.textContent).toBe('Record file download requested.'); expect(f.doc.activeElement).toBe(save);
    }
    expect(exportHistory).toHaveBeenCalledTimes(1); expect(call).toHaveBeenCalledTimes(1); expect(download).toHaveBeenCalledTimes(expected.count);
    savePreview(f); expect(download).toHaveBeenLastCalledWith(expected.filename, expected.json); expect(f.panel.hasDraft()).toBe(false); expect(f.panel.hasInFlightWork()).toBe(false); f.panel.dispose();
  });
  it.each(['aliases', 'full'] as const)('keeps the %s record filename and bytes stable across local pages, preview search and history refresh', async mode => {
    const value = historyExport(page().scope, 45); const expected = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode); const raw = JSON.stringify(expected.report.entries[40]);
    const filename = expected.filename.slice(0, -5) + '-record-incident-41.json'; const download = vi.fn(); const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value);
    const f = mount(async () => page(), value.scope, { exportHistory, download }); await f.panel.whenLoaded(); const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = mode; privacy.fire('change');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); f.host.find('data-history-preview-control', 'next')!.click(); f.host.find('data-history-preview-control', 'next')!.click();
    let entry = f.host.find('data-history-preview-record', '40')!; entry.open = true; entry.fire('toggle'); const old = entry.find('data-history-preview-control', 'download-record')!; old.click();
    expect(download).toHaveBeenCalledExactlyOnceWith(filename, raw); value.entries[40]!.record.id = 'ffffffff-1234-4123-8123-123456789abc';
    searchPreview(f, expected.report.entries[40]!.record.id); old.click(); expect(download).toHaveBeenCalledTimes(1);
    entry = f.host.find('data-history-preview-record', '40')!; entry.open = true; entry.fire('toggle'); const save = entry.find('data-history-preview-control', 'download-record')!; save.focus!(); save.click();
    expect(download).toHaveBeenLastCalledWith(filename, raw); await f.panel.refresh(); expect(f.doc.activeElement).toBe(save); expect(entry.find('data-history-preview-control', 'download-record')).toBe(save);
    save.click(); expect(download).toHaveBeenLastCalledWith(filename, raw); expect(download).toHaveBeenCalledTimes(3); expect(exportHistory).toHaveBeenCalledTimes(1);
    savePreview(f); expect(download).toHaveBeenLastCalledWith(expected.filename, expected.json); f.panel.dispose();
  });
  it('allows an exact record download retry after refusal without exposing errors or disturbing record copy feedback', async () => {
    const value = historyExport(page().scope, 1); const expected = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'aliases');
    const raw = JSON.stringify(expected.report.entries[0]); const filename = expected.filename.slice(0, -5) + '-record-incident-1.json';
    const download = vi.fn().mockImplementationOnce(() => { throw Error('private-record-download-error'); }); const write = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
    const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value); const f = mount(async () => page(), value.scope, { exportHistory, download }); await f.panel.whenLoaded(); copyBrowser(f, { clipboard: { writeText: write } });
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle');
    const save = entry.find('data-history-preview-control', 'download-record')!; save.focus!(); save.click();
    expect(download).toHaveBeenCalledExactlyOnceWith(filename, raw); expect(entry.find('data-history-preview-download', 'record-error')!.hidden).toBe(false);
    expect(entry.find('data-history-preview-download', 'record-status')!.hidden).toBe(true); expect(f.host.text()).not.toContain('private-record-download-error'); expect(f.doc.activeElement).toBe(save);
    entry.find('data-history-preview-control', 'copy-record')!.click(); await settleCopy(); expect(write).toHaveBeenCalledExactlyOnceWith(raw);
    expect(entry.find('data-history-preview-copy', 'record-status')!.textContent).toBe('Record JSON copied.'); save.click();
    expect(download).toHaveBeenLastCalledWith(filename, raw); expect(download).toHaveBeenCalledTimes(2); expect(entry.find('data-history-preview-download', 'record-error')!.hidden).toBe(true);
    expect(entry.find('data-history-preview-download', 'record-status')!.textContent).toBe('Record file download requested.');
    expect(entry.find('data-history-preview-copy', 'record-status')!.textContent).toBe('Record JSON copied.'); expect(exportHistory).toHaveBeenCalledTimes(1); f.panel.dispose();
  });
  it.each(['return', 'throw'] as const)('leaves discarded record feedback untouched when the download callback changes the view and then %s', async outcome => {
    for (const phase of ['query', 'privacy', 'close', 'dispose']) {
      const value = historyExport(page().scope, 1); const expected = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'aliases');
      let f!: ReturnType<typeof mount>; let chosen: Element | undefined;
      const download = vi.fn<(filename: string, json: string) => void>(() => {
        if (phase === 'query') { searchPreview(f, 'retired'); f.host.find('data-history-preview-search', 'query')!.focus!(); }
        else if (phase === 'privacy') { const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.focus!(); privacy.value = 'full'; privacy.fire('change'); }
        else if (phase === 'close') f.host.find('data-history-preview-control', 'close')!.click(); else f.panel.dispose();
        chosen = f.doc.activeElement; if (outcome === 'throw') throw Error('private-download-context-error');
      });
      f = mount(async () => page(), value.scope, { exportHistory: async () => value, download }); await f.panel.whenLoaded(); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded();
      const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle'); const save = entry.find('data-history-preview-control', 'download-record')!;
      const status = entry.find('data-history-preview-download', 'record-status')!; const error = entry.find('data-history-preview-download', 'record-error')!; save.focus!(); save.click();
      expect(download, phase).toHaveBeenCalledExactlyOnceWith(expected.filename.slice(0, -5) + '-record-incident-1.json', JSON.stringify(expected.report.entries[0]));
      expect(status.textContent, phase).toBe(''); expect(status.hidden, phase).toBe(true); expect(error.textContent, phase).toBe(''); expect(error.hidden, phase).toBe(true);
      expect(f.doc.activeElement, phase).toBe(chosen); expect(f.host.text(), phase).not.toContain('private-download-context-error'); save.click(); expect(download, phase).toHaveBeenCalledTimes(1); f.panel.dispose();
    }
  });
  it('preserves a newer draft focus and selection during pointer activation of a record download', async () => {
    const value = historyExport(page().scope, 1); const expected = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'aliases'); const download = vi.fn();
    const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download }); await f.panel.whenLoaded(); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded();
    const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle'); const save = entry.find('data-history-preview-control', 'download-record')!;
    const draft = f.host.find('data-history-preview-search', 'query')!; draft.value = 'Unapplied download draft'; draft.setSelectionRange(2, 7); draft.focus!(); save.fire('click', 1);
    expect(f.doc.activeElement).toBe(draft); expect(draft.value).toBe('Unapplied download draft'); expect([draft.selectionStart, draft.selectionEnd]).toEqual([2, 7]);
    expect(download).toHaveBeenCalledExactlyOnceWith(expected.filename.slice(0, -5) + '-record-incident-1.json', JSON.stringify(expected.report.entries[0]));
    expect(entry.find('data-history-preview-download', 'record-status')!.textContent).toBe('Record file download requested.'); f.panel.dispose();
  });
  it('keeps download feedback separate for two opened records and for the full snapshot', async () => {
    const value = historyExport(page().scope, 2); const expected = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'aliases');
    const download = vi.fn<(filename: string, json: string) => void>((filename) => { if (filename.endsWith('-record-incident-1.json')) throw Error('private-download-error'); });
    const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download }); await f.panel.whenLoaded(); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded();
    const entries = [0, 1].map(index => f.host.find('data-history-preview-record', String(index))!);
    for (const entry of entries) { entry.open = true; entry.fire('toggle'); entry.find('data-history-preview-control', 'download-record')!.click(); }
    expect(entries[0]!.find('data-history-preview-download', 'record-error')!.hidden).toBe(false); expect(entries[0]!.find('data-history-preview-download', 'record-status')!.hidden).toBe(true);
    expect(entries[1]!.find('data-history-preview-download', 'record-error')!.hidden).toBe(true); expect(entries[1]!.find('data-history-preview-download', 'record-status')!.textContent).toBe('Record file download requested.');
    expect(download.mock.calls[1]![1]).toBe(JSON.stringify(expected.report.entries[1])); savePreview(f); expect(download).toHaveBeenLastCalledWith(expected.filename, expected.json);
    expect(entries[0]!.find('data-history-preview-download', 'record-error')!.hidden).toBe(false); f.panel.dispose();
  });
  it('keeps record downloads available after field changes and lazy array paging', async () => {
    const value = historyExport(page().scope, 1); const record = value.entries[0]!.record; if (!('group' in record)) throw Error(); record.group.label = 'needle';
    record.group.uses = Array.from({ length: 45 }, (_, index) => ({ kind: 'pack', id: 'pack-' + index, label: index === 0 ? 'needle' : 'other' }));
    const expected = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'full'); const download = vi.fn();
    const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download }); await f.panel.whenLoaded(); const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'needle'); const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle');
    const save = entry.find('data-history-preview-control', 'download-record')!; entry.find('data-history-preview-match-path', JSON.stringify(['record', 'group', 'label']))!.click();
    entry.find('data-history-preview-match-path', JSON.stringify(['record', 'group', 'uses', 0, 'label']))!.click(); entry.find('data-history-preview-field', 'uses')!.find('data-history-preview-control', 'array-next')!.click();
    expect(entry.find('data-history-preview-control', 'download-record')).toBe(save); save.click(); expect(download).toHaveBeenCalledExactlyOnceWith(expected.filename.slice(0, -5) + '-record-incident-1.json', JSON.stringify(expected.report.entries[0])); f.panel.dispose();
  });
  it('keeps discarded record download controls inert after record or snapshot invalidation', async () => {
    for (const phase of ['query', 'privacy', 'close', 'new snapshot', 'record page', 'dispose']) {
      const value = historyExport(page().scope, 25); const download = vi.fn(); const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download }); await f.panel.whenLoaded();
      f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle');
      const old = entry.find('data-history-preview-control', 'download-record')!; const status = entry.find('data-history-preview-download', 'record-status')!;
      if (phase === 'query') searchPreview(f, 'retired'); else if (phase === 'privacy') { const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change'); }
      else if (phase === 'close') f.host.find('data-history-preview-control', 'close')!.click(); else if (phase === 'new snapshot') { f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); }
      else if (phase === 'record page') f.host.find('data-history-preview-control', 'next')!.click(); else f.panel.dispose();
      const focused = f.doc.activeElement; old.click(); expect(download, phase).not.toHaveBeenCalled(); expect(status.textContent, phase).toBe(''); expect(f.doc.activeElement, phase).toBe(focused); f.panel.dispose();
    }
  });
  it.each(['missing', 'getter', 'method getter', 'throw', 'rejection'] as const)('offers exact readonly record JSON after clipboard %s and preserves manual selection through refresh', async failure => {
    const value = historyExport(page().scope, 1); const record = value.entries[0]!.record; if (!('group' in record)) throw Error(); record.group.label = '  Cafe\u0301 🚀 <script>literal</script>  ';
    const expected = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'full'); const raw = JSON.stringify(expected.report.entries[0]);
    const write = vi.fn<(text: string) => Promise<void>>(() => { if (failure === 'throw') throw Error('private-copy-error'); return Promise.reject(Error('private-copy-error')); });
    const navigator: { clipboard?: object } = failure === 'missing' ? {} : { clipboard: { writeText: write } };
    if (failure === 'getter') Object.defineProperty(navigator, 'clipboard', { get() { throw Error('private-copy-error'); } });
    if (failure === 'method getter') Object.defineProperty(navigator.clipboard!, 'writeText', { get() { throw Error('private-copy-error'); } });
    const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download: vi.fn() }); await f.panel.whenLoaded(); const browser = copyBrowser(f, navigator);
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change'); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded();
    const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle'); const copy = entry.find('data-history-preview-control', 'copy-record')!; copy.focus!(); copy.click(); await settleCopy();
    const manual = entry.find('data-history-preview-copy', 'manual-record')!; expect(manual.textContent).toBe(raw); expect(manual.getAttribute('aria-readonly')).toBe('true');
    expect(f.doc.activeElement).toBe(manual); expect(browser.selected()).toBe(manual); expect(f.host.text()).not.toContain('private-copy-error');
    expect(entry.find('data-history-preview-copy', 'record-status')!.textContent).not.toBe('Record JSON copied.');
    manual.fire('keydown', 0, { key: 'a', metaKey: true }); manual.fire('keydown', 0, { key: 'A', ctrlKey: true }); expect(browser.selection.addRange).toHaveBeenCalledTimes(3);
    browser.selection.anchorNode = manual; browser.selection.focusNode = manual; browser.selection.anchorOffset = 8; browser.selection.focusOffset = 2;
    await f.panel.refresh(); expect(f.doc.activeElement).toBe(manual); expect(entry.find('data-history-preview-copy', 'manual-record')).toBe(manual);
    expect(browser.selection.setBaseAndExtent).toHaveBeenLastCalledWith(manual, 8, manual, 2);
    const select = entry.find('data-history-preview-control', 'select-copy-record')!; select.click(); expect(browser.selected()).toBe(manual);
    const calls = write.mock.calls.length; privacy.value = 'aliases'; privacy.fire('change'); const focused = f.doc.activeElement; copy.click(); select.click();
    expect(write).toHaveBeenCalledTimes(calls); expect(f.doc.activeElement).toBe(focused); f.panel.dispose();
  });
  it.each(['success', 'failure'] as const)('keeps a pending record copy through field changes, lazy array paging and refresh, with independent scalar status on %s', async outcome => {
    const value = historyExport(page().scope, 1); const record = value.entries[0]!.record; if (!('group' in record)) throw Error(); record.group.label = 'needle';
    record.group.uses = Array.from({ length: 45 }, (_, n) => ({ kind: 'pack', id: 'pack-' + n, label: n === 0 ? 'needle' : 'other-' + n }));
    let resolve!: () => void; let reject!: (error: Error) => void;
    const write = vi.fn<(text: string) => Promise<void>>().mockImplementationOnce(() => new Promise((yes, no) => { resolve = yes; reject = no; })).mockResolvedValue();
    const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download: vi.fn() }); await f.panel.whenLoaded(); copyBrowser(f, { clipboard: { writeText: write } });
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change'); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'needle');
    const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle'); const copy = entry.find('data-history-preview-control', 'copy-record')!; copy.focus!(); copy.click();
    entry.find('data-history-preview-match-path', JSON.stringify(['record', 'group', 'label']))!.click(); const target = f.doc.activeElement;
    target.find('data-history-preview-control', 'copy-value')!.click(); await settleCopy(); expect(target.find('data-history-preview-copy', 'status')!.textContent).toBe('Saved value copied.');
    expect(entry.find('data-history-preview-copy', 'record-status')!.textContent).toBe('Copying record JSON…');
    entry.find('data-history-preview-match-path', JSON.stringify(['record', 'group', 'uses', 0, 'label']))!.click();
    entry.find('data-history-preview-field', 'uses')!.find('data-history-preview-control', 'array-next')!.click();
    await f.panel.refresh(); expect(entry.find('data-history-preview-control', 'copy-record')).toBe(copy); const focused = f.doc.activeElement;
    if (outcome === 'success') resolve(); else reject(Error('private-copy-error')); await settleCopy();
    expect(f.doc.activeElement).toBe(focused); expect(entry.find('data-history-preview-copy', 'record-status')!.textContent).toBe(outcome === 'success' ? 'Record JSON copied.' : 'This record could not be copied. Select the JSON and copy it yourself.');
    expect(JSON.parse(write.mock.calls[0]![0]).record.group.uses).toHaveLength(45); expect(write.mock.calls[1]![0]).toBe('needle'); f.panel.dispose();
  });
  it.each(['success', 'failure'] as const)('isolates concurrent record copies and preserves the other record manual selection after an out-of-order %s and retry', async outcome => {
    const value = historyExport(page().scope, 2); const expected = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'aliases');
    const pending: { yes(): void; no(error: Error): void }[] = [];
    const write = vi.fn<(text: string) => Promise<void>>(() => new Promise((yes, no) => { pending.push({ yes, no }); }));
    const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value); const download = vi.fn();
    const f = mount(async () => page(), value.scope, { exportHistory, download }); await f.panel.whenLoaded(); const browser = copyBrowser(f, { clipboard: { writeText: write } });
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded();
    const entries = [0, 1].map(index => f.host.find('data-history-preview-record', String(index))!);
    for (const entry of entries) { entry.open = true; entry.fire('toggle'); }
    const copies = entries.map(entry => entry.find('data-history-preview-control', 'copy-record')!);
    for (const copy of copies) { copy.focus!(); copy.click(); }
    expect(write.mock.calls.map(call => call[0])).toEqual(expected.report.entries.map(entry => JSON.stringify(entry)));
    if (outcome === 'success') pending[0]!.yes(); else pending[0]!.no(Error('private-copy-error')); await settleCopy();
    expect(copies[0]!.getAttribute('aria-busy')).toBe('false'); expect(copies[1]!.getAttribute('aria-busy')).toBe('true'); expect(f.doc.activeElement).toBe(copies[1]);
    pending[1]!.no(Error('private-copy-error')); await settleCopy(); const secondManual = entries[1]!.find('data-history-preview-copy', 'manual-record')!;
    expect(f.doc.activeElement).toBe(secondManual); expect(browser.selected()).toBe(secondManual);
    browser.selection.anchorNode = secondManual; browser.selection.focusNode = secondManual; browser.selection.anchorOffset = 8; browser.selection.focusOffset = 2;
    copies[0]!.click(); pending[2]!.no(Error('private-copy-error')); await settleCopy(); await f.panel.refresh();
    expect(f.doc.activeElement).toBe(secondManual); expect(browser.selection.setBaseAndExtent).toHaveBeenLastCalledWith(secondManual, 8, secondManual, 2);
    expect(secondManual.textContent).toBe(JSON.stringify(expected.report.entries[1])); expect(write.mock.calls[2]![0]).toBe(JSON.stringify(expected.report.entries[0]));
    const firstManual = entries[0]!.find('data-history-preview-copy', 'manual-record')!;
    const firstSelect = entries[0]!.find('data-history-preview-control', 'select-copy-record')!;
    expect(firstSelect.getAttribute('aria-controls')).not.toBe(entries[1]!.find('data-history-preview-control', 'select-copy-record')!.getAttribute('aria-controls')); firstSelect.click();
    expect(f.doc.activeElement).toBe(firstManual); expect(browser.selected()).toBe(firstManual); expect(exportHistory).toHaveBeenCalledTimes(1);
    savePreview(f); expect(download).toHaveBeenCalledExactlyOnceWith(expected.filename, expected.json); f.panel.dispose();
  });
  it.each(['success', 'failure'] as const)('ignores late record clipboard %s after discarding the record or snapshot', async outcome => {
    for (const phase of ['query', 'privacy', 'close', 'new snapshot', 'record page', 'dispose']) {
      const value = historyExport(page().scope, 25); let resolve!: () => void; let reject!: (error: Error) => void;
      const write = vi.fn<(text: string) => Promise<void>>(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
      const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download: vi.fn() }); await f.panel.whenLoaded(); copyBrowser(f, { clipboard: { writeText: write } });
      f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle');
      const old = entry.find('data-history-preview-control', 'copy-record')!; const status = entry.find('data-history-preview-copy', 'record-status')!; old.click();
      if (phase === 'query') searchPreview(f, 'retired'); else if (phase === 'privacy') { const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change'); }
      else if (phase === 'close') f.host.find('data-history-preview-control', 'close')!.click(); else if (phase === 'new snapshot') { f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); }
      else if (phase === 'record page') f.host.find('data-history-preview-control', 'next')!.click(); else f.panel.dispose();
      const focused = f.doc.activeElement; if (outcome === 'success') resolve(); else reject(Error('private-copy-error')); await settleCopy(); old.click();
      expect(status.textContent, phase).toBe('Copying record JSON…'); expect(f.doc.activeElement, phase).toBe(focused); expect(write, phase).toHaveBeenCalledTimes(1);
      expect(f.host.find('data-history-preview-copy', 'manual-record'), phase).toBeUndefined(); f.panel.dispose();
    }
  });
  it('reveals a matching primitive through two independently paged nested arrays', async () => {
    const token = renewal(); token.results = Array.from({ length: 32 }, (_, index) => ({ id: (index + 1).toString(16).padStart(64, '0'), revision: 'f'.repeat(64),
      label: 'Saved grant ' + index, connections: index === 24 ? Array.from({ length: 45 }, (_, n) => 'nested-target-' + n) : ['other-' + index],
      native_accounts: [], eligible: true, status: 'passed', current: 'no' }));
    const scope = { kind: 'all' } as const; const value = historyExport(scope, 0);
    value.entries = [{ type: authenticationHistoryEntryType(token), outcome: authenticationHistoryEntryOutcome(token), record: token }]; value.entry_count = 1;
    const expected = prepareAuthenticationHistoryDownload(value, { scope }, 'full'); const download = vi.fn();
    const f = mount(async () => page(scope), scope, { exportHistory: async () => value, download }); await f.panel.whenLoaded();
    const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'full'; privacy.fire('change');
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'nested-target-44');
    const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle');
    const path = ['record', 'results', 24, 'connections', 44]; entry.find('data-history-preview-match-path', JSON.stringify(path))!.click();
    const results = entry.find('data-history-preview-field', 'results')!; expect(results.open).toBe(true); expect(results.text()).toContain('Items 21–32 of 32');
    const connections = results.querySelectorAll('[data-history-preview-field="connections"]').find(node => node.open)!;
    expect(connections.text()).toContain('Items 41–45 of 45');
    const target = entry.find('data-history-preview-path', JSON.stringify(path))!; expect(f.doc.activeElement).toBe(target); expect(target.text()).toContain('nested-target-44');
    const mark = target.find('data-history-preview-value-highlight', 'display')!; expect(mark.textContent).toBe('nested-target-44');
    expect(entry.find('data-history-preview-path', JSON.stringify(['record', 'results', 0, 'connections']))).toBeUndefined();
    expect(entry.find('data-history-preview-path', JSON.stringify(['record', 'results', 24, 'connections', 0]))).toBeUndefined();
    entry.find('data-history-preview-control', 'return-matches')!.click(); expect(f.doc.activeElement).toBe(entry.find('data-history-preview-match-path', JSON.stringify(path)));
    expect(results.text()).toContain('Items 21–32 of 32'); expect(connections.text()).toContain('Items 41–45 of 45');
    expect(target.find('data-history-preview-value-highlight', 'display')).toBe(mark);
    savePreview(f); expect(download).toHaveBeenCalledExactlyOnceWith(expected.filename, expected.json); f.panel.dispose();
  });
  it('opens a matching container field without removing its summary from the normal tab order', async () => {
    const value = historyExport(page().scope, 1); const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download: vi.fn() }); await f.panel.whenLoaded();
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); searchPreview(f, 'Uses');
    const entry = f.host.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle'); const path = ['record', 'group', 'uses'];
    expect(entry.find('data-history-preview-matches', 'fields')!.querySelectorAll('[data-history-preview-highlight="match"]').map(mark => mark.textContent)).toEqual(['Uses']);
    entry.find('data-history-preview-match-path', JSON.stringify(path))!.click(); const uses = entry.find('data-history-preview-field', 'uses')!;
    expect(uses.open).toBe(true); expect(uses.text()).toContain('Items 1–1 of 1');
    expect(f.doc.activeElement).toBe(entry.find('data-history-preview-path', JSON.stringify(path))); expect(f.doc.activeElement.getAttribute('tabindex')).toBe('0');
    const summary = f.doc.activeElement; const back = entry.find('data-history-preview-control', 'return-matches')!;
    expect(summary.contains(back)).toBe(false); expect(uses.children[1]!.contains(back)).toBe(true); expect(uses.children[1]!.hidden).toBe(false);
    expect(uses.querySelectorAll('[data-history-preview-value-highlight]')).toHaveLength(0); expect(uses.find('data-history-preview-saved-value', 'literal')).toBeUndefined();
    expect(uses.find('data-history-preview-hits', 'navigation')).toBeUndefined();
    expect(uses.find('data-history-preview-copy', 'controls')).toBeUndefined();
    back.click(); expect(f.doc.activeElement).toBe(entry.find('data-history-preview-match-path', JSON.stringify(path))); expect(summary.getAttribute('tabindex')).toBe('0');
    f.panel.dispose();
  });
  it('previews all record kinds and follows exact source and incident references across preview pages', async () => {
    const value = historyExport(); const action = repair(); action.incidents[0]!.id = value.entries[40]!.record.id; const token = renewal();
    const check: AuthenticationAccessVerification = { id: 'verify-12345678-1234-4123-8123-123456789abc', selection: { kind: 'repair', id: action.id },
      status: 'completed', started_at: 130, finished_at: 140, targets_truncated: false, usage_available: true, uses: [],
      results: [{ id: '3'.repeat(64), label: 'Work API', target: { kind: 'connection', name: 'work' }, authentication_revision: '4'.repeat(64), current: 'yes', checks: [{ kind: 'api_read', status: 'passed' }] }] };
    const recheck: AuthenticationAccessVerification = { ...check, id: 'verify-22345678-1234-4123-8123-123456789abc', selection: { kind: 'verification', id: check.id } };
    value.entries = [recheck, check, token, action, ...value.entries.map(e => e.record)].map(record => ({ type: authenticationHistoryEntryType(record), outcome: authenticationHistoryEntryOutcome(record), record })); value.entry_count = value.entries.length;
    const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value); const f = mount(async () => page(), value.scope, { exportHistory, download: vi.fn() }); await f.panel.whenLoaded();
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); const preview = f.host.find('data-history-preview', 'report')!;
    expect(preview.text()).toContain('72 matching retained records'); expect(preview.text()).toContain('Token-renewal check');
    const prepared = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'aliases'); searchPreview(f, prepared.report.entries[0]!.record.id);
    const first = preview.find('data-history-preview-record', '0')!; first.open = true; first.fire('toggle'); first.find('data-history-preview-control', 'reference')!.click();
    expect(preview.find('data-history-preview-record', '1')!.open).toBe(true); expect(preview.text()).toContain('Preview search cleared to show the referenced record');
    expect(f.host.find('data-history-preview-search', 'query')!.value).toBe('');
    searchPreview(f, prepared.report.entries[1]!.record.id);
    const matchingSource = preview.find('data-history-preview-record', '0')!; matchingSource.open = true; matchingSource.fire('toggle');
    matchingSource.find('data-history-preview-control', 'reference')!.click(); expect(preview.find('data-history-preview-record', '1')!.open).toBe(true);
    expect(preview.text()).toContain('Matching records 1–2 of 2 (72 in snapshot)'); expect(f.host.find('data-history-preview-search', 'query')!.value).toBe(prepared.report.entries[1]!.record.id);
    f.host.find('data-history-preview-control', 'search-clear')!.click();
    searchPreview(f, prepared.report.entries[3]!.record.id);
    const repairEntry = preview.find('data-history-preview-record', '3')!; repairEntry.open = true; repairEntry.fire('toggle'); repairEntry.find('data-history-preview-control', 'reference')!.click();
    expect(preview.text()).toContain('Records 41–60 of 72'); expect(preview.find('data-history-preview-record', '44')!.open).toBe(true);
    expect(f.doc.activeElement.textContent).toContain('Incident'); expect(exportHistory).toHaveBeenCalledTimes(1); f.panel.dispose();
  });
  it('labels references absent from the selected snapshot and blocks boundary paging events', async () => {
    const action = repair(); const value = { ...historyExport(page().scope, 0), entry_count: 1,
      entries: [{ type: authenticationHistoryEntryType(action), outcome: authenticationHistoryEntryOutcome(action), record: action }] };
    const f = mount(async () => page(), value.scope, { exportHistory: async () => value, download: vi.fn() }); await f.panel.whenLoaded();
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); const preview = f.host.find('data-history-preview', 'report')!;
    preview.find('data-history-preview-control', 'previous')!.fire('click'); preview.find('data-history-preview-control', 'next')!.fire('click');
    expect(preview.text()).toContain('Records 1–1 of 1'); const entry = preview.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle');
    expect(entry.text()).toContain('Referenced record is not included in this snapshot'); expect(entry.find('data-history-preview-control', 'reference')).toBeUndefined(); f.panel.dispose();
  });
  it('renders renewal, access, repair and incident entries in one order with distinct evidence and counts', async () => {
    const data = page(); const token = renewal(); const action = repair();
    const check: AuthenticationAccessVerification = { id: 'verify-12345678-1234-4123-8123-123456789abc', selection: { kind: 'repair', id: action.id },
      started_at: 130, finished_at: 140, status: 'completed', results: [{ id: '3'.repeat(64), label: 'API read', target: { kind: 'connection', name: 'work' },
        authentication_revision: '4'.repeat(64), current: 'yes', checks: [{ kind: 'api_read', status: 'passed' }] }], targets_truncated: false, uses: [], usage_available: true };
    Object.assign(check, { app_revision: 2 }); Object.assign(data.incidents[0]!, { results: [], action: 'extra_server_field' });
    data.renewals = [token]; data.repairs = [action]; data.verifications = [check]; data.order = [token.id, check.id, action.id, data.incidents[0]!.id];
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(data); const { host, panel } = mount(call); await panel.whenLoaded();
    expect(host.find('data-authentication-renewal', token.id)).toBeDefined(); expect(host.find('data-authentication-verification', token.id)).toBeUndefined();
    const text = host.text(); expect(text).toContain('1 renewal check shown'); expect(text).toContain('1 access check shown');
    expect(text.indexOf('Token renewal verification')).toBeLessThan(text.indexOf('Access verification'));
    expect(text.indexOf('Access verification')).toBeLessThan(text.indexOf('Reauthorize'));
    for (const label of ['Added to history:', 'Superseded', 'could not be compared', 'excluded from the check', 'does not prove data access', 'Some local authorizations', 'Some account or file references were not recorded']) expect(text).toContain(label);
    expect(host.find('href', '#connections/mail/work')).toBeDefined();
    expect(call).toHaveBeenCalledOnce(); expect(call).toHaveBeenCalledWith({ scope: data.scope, include_renewals: true }); panel.dispose();
  });
  it('pages renewal-only results, refreshes saved progress and retains them after invalid replies', async () => {
    const first = renewal(); first.status = 'checking'; delete first.finished_at;
    first.results[0]!.status = 'unconfirmed'; first.results[0]!.reason = 'not_checked';
    const second = renewal(); second.id = 'renewal-22345678-1234-4123-8123-123456789abc';
    const base = { ...page(), incidents: [], repairs: [] };
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValueOnce({ ...base, renewals: [first], order: [first.id], next_cursor: 'older' })
      .mockResolvedValueOnce({ ...base, renewals: [second], order: [second.id] }).mockResolvedValueOnce({ ...base, renewals: [second], order: ['unknown'] });
    const { host, panel } = mount(call); await panel.whenLoaded(); expect(host.text()).toContain('running in the background');
    expect(host.text()).not.toContain('No incidents have been recorded'); host.find('data-incident-action', 'older')!.click(); await panel.whenLoaded();
    expect(host.text()).toContain('2 renewal checks shown'); expect(call.mock.calls[1]![0]).toMatchObject({ include_renewals: true, cursor: 'older' });
    await panel.refresh(); expect(host.text()).toContain('History could not be refreshed'); expect(host.find('data-authentication-renewal', first.id)).toBeDefined(); panel.dispose();
  });
  it('renders repair results and related-incident links in the server-provided history order', async () => {
    const data = page(); const action = repair(); data.repairs = [action]; data.order = [action.id, data.incidents[0]!.id];
    const { host, panel } = mount(async () => data); await panel.whenLoaded();
    expect(host.text()).toContain('Authentication updated'); expect(host.text()).toContain('Later successful operations are needed');
    expect(host.text()).toContain('1 repair action shown'); expect(host.text()).toContain('From: Recued direct OAuth'); expect(host.text()).toContain('Broker profile: team');
    expect(host.text()).toContain('Broker account: chosen-account');
    expect(host.text().indexOf('Reauthorize')).toBeLessThan(host.text().indexOf('<script>Work</script>'));
    expect(host.find('href', '#connections/others/incident-history/group/' + 'a'.repeat(64))).toBeDefined(); panel.dispose();
  });
  it('labels confirmed later operations separately and keeps unverified secret rotation explicit', async () => {
    const data = page(); data.incidents[0]!.status = 'recovered'; delete data.incidents[0]!.retirement_reason; data.incidents[0]!.events[1]!.kind = 'recovered';
    data.incidents[0]!.recovery_evidence = { earliest_at: 160, latest_at: 190 };
    const action = repair(); action.recovery_confirmed_at = 190; data.repairs = [action]; data.order = [action.id, data.incidents[0]!.id];
    const { host, panel } = mount(async () => data); await panel.whenLoaded(); expect(host.text()).toContain('Later successful operations recorded for every related incident');
    action.action = 'rotate_secret'; delete action.recovery_confirmed_at; await panel.refresh();
    expect(host.text()).toContain('Vendor access was not checked'); expect(host.text()).not.toContain('Later successful operations recorded for every related incident'); panel.dispose();
  });
  it('shows failed, interrupted and restart-pending repairs without claiming a saved change failed or access recovered', async () => {
    const data = page(); const action = repair(); action.status = 'failed'; action.reason = 'interrupted'; data.incidents = []; data.repairs = [action]; data.order = [action.id];
    const { host, panel } = mount(async () => data); await panel.whenLoaded(); expect(host.text()).toContain('Repair failed · Saved authentication kept');
    expect(host.text()).toContain('server stopped before the change was committed');
    action.status = 'applied'; delete action.reason; action.restart_required = true; await panel.refresh();
    expect(host.text()).toContain('collection restart still needs attention'); expect(host.text()).not.toContain('Repair failed'); panel.dispose();
  });
  it('pages repair-only history and retains actions when a later response has invalid order', async () => {
    const data = page(); data.incidents = []; const action = repair(); data.repairs = [action]; data.order = [action.id]; data.next_cursor = 'older';
    const invalid = { ...data, order: ['unknown'] };
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValueOnce(data).mockResolvedValueOnce(invalid);
    const { host, panel } = mount(call); await panel.whenLoaded(); expect(host.text()).not.toContain('No incidents have been recorded');
    expect(host.text()).toContain('Load older history'); host.find('data-incident-action', 'older')!.click(); await panel.whenLoaded();
    expect(host.text()).toContain('History could not be refreshed'); expect(host.find('data-authentication-repair', action.id)).toBeDefined(); panel.dispose();
  });
  it('shows historical impacts and retirement without claiming recovered access', async () => {
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page()); const { host, panel } = mount(call); await panel.whenLoaded();
    expect(call).toHaveBeenCalledWith({ scope: { kind: 'connection', name: 'work' }, include_renewals: true });
    expect(host.text()).toContain('Closed without confirmed recovery'); expect(host.text()).toContain('saved authentication changed');
    expect(host.text()).toContain('Pack: Sheets'); expect(host.text()).toContain('list of affected uses or problems may be incomplete');
    expect(host.text()).not.toContain('Later operations succeeded'); expect(host.find('data-authentication-incident', page().incidents[0]!.id)).toBeDefined(); panel.dispose();
  });
  it('distinguishes awaiting evidence from later verified operations', async () => {
    const waiting = page(); Object.assign(waiting.incidents[0]!, { status: 'open', currently_reported: false }); delete waiting.incidents[0]!.ended_at; delete waiting.incidents[0]!.retirement_reason;
    waiting.incidents[0]!.events[1]!.kind = 'awaiting_confirmation';
    const recovered = page(); Object.assign(recovered.incidents[0]!, { status: 'recovered' }); delete recovered.incidents[0]!.retirement_reason;
    recovered.incidents[0]!.events[1]!.kind = 'recovered';
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValueOnce(waiting).mockResolvedValueOnce(recovered);
    const { host, panel } = mount(call); await panel.whenLoaded(); expect(host.text()).toContain('Awaiting access evidence');
    await panel.refresh(); expect(host.text()).toContain('Successful operations recorded'); expect(host.text()).toContain('does not verify every permission'); panel.dispose();
  });
  it('paginates stored incidents and retains the previous page with a visible error when a refresh fails', async () => {
    const first = page(); first.next_cursor = 'page_two'; const second = page(); second.incidents[0]!.id = '22345678-1234-4123-8123-123456789abc';
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockRejectedValue(new Error('never-export-secret'));
    const { host, panel } = mount(call); await panel.whenLoaded(); host.find('data-incident-action', 'older')!.click(); await panel.whenLoaded();
    expect(call.mock.calls[1]![0].cursor).toBe('page_two'); expect(host.text()).toContain('2 incidents shown');
    await panel.refresh(); expect(host.text()).toContain('Earlier observations may be shown'); expect(host.text()).not.toContain('never-export');
    expect(host.find('data-authentication-incident', first.incidents[0]!.id)).toBeDefined(); panel.dispose();
  });
  it('ignores replies after disposal and rejects a wrong-scope or malformed page', async () => {
    let done!: (page: AuthenticationIncidentHistoryPage) => void;
    const { host, panel } = mount(() => new Promise(resolve => { done = resolve; })); const text = host.text(); panel.dispose(); done(page()); await panel.whenLoaded(); expect(host.text()).toBe(text);
    const wrong = mount(async () => page({ kind: 'all' })); await wrong.panel.whenLoaded(); expect(wrong.host.text()).toContain('History could not be refreshed'); wrong.panel.dispose();
    const invalid = mount(async () => ({ ...page(), retention_days: 1 })); await invalid.panel.whenLoaded(); expect(invalid.host.text()).toContain('History could not be refreshed'); invalid.panel.dispose();
  });
  it('handles empty history and an older server without claiming healthy vendor access', async () => {
    const empty = mount(async () => ({ ...page(), incidents: [] })); await empty.panel.whenLoaded(); expect(empty.host.text()).toContain('does not confirm vendor access'); empty.panel.dispose();
    expect(empty.host.text()).toContain('This server does not provide token-renewal history');
    const old = mount(); await old.panel.whenLoaded(); expect(old.host.text()).toContain('update the server'); old.panel.dispose();
  });
  it('labels an unknown historical last failure date without rejecting the incident or displaying an invalid date', async () => {
    const historical = page(); delete historical.incidents[0]!.last_problem_at;
    const { host, panel } = mount(async () => historical); await panel.whenLoaded();
    expect(host.text()).toContain('Last problem observed: Unknown'); expect(host.text()).not.toMatch(/Invalid Date|History could not be refreshed/); panel.dispose();
  });
  it.each(['refresh', 'older'])('restores keyboard focus to a live control after %s replaces the panel', async action => {
    const first = page(); first.next_cursor = 'older_page';
    const older = page(); older.next_cursor = 'last_page'; older.incidents[0]!.id = '22345678-1234-4123-8123-123456789abc';
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValueOnce(first).mockResolvedValue(action === 'older' ? older : first);
    const { host, panel, doc } = mount(call); await panel.whenLoaded();
    const oldControl = host.find('data-incident-action', action)!; oldControl.focus!(); oldControl.click(); await panel.whenLoaded();
    expect(doc.activeElement).toBe(host.find('data-incident-action', action)); expect(doc.activeElement).not.toBe(oldControl); panel.dispose();
  });
  it('does not move focus back into history when the user has focused another control while it loads', async () => {
    let finish!: (value: AuthenticationIncidentHistoryPage) => void;
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValueOnce(page()).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { host, panel, doc } = mount(call); await panel.whenLoaded(); const refresh = host.find('data-incident-action', 'refresh')!;
    refresh.focus!(); refresh.click(); const outside = new Element(); Object.assign(outside, { isConnected: true }); doc.activeElement = outside;
    finish(page()); await panel.whenLoaded(); expect(doc.activeElement).toBe(outside); panel.dispose();
  });
  it('keeps keyboard focus in the panel when the last older page removes its paging control', async () => {
    const first = page(); first.next_cursor = 'last_page';
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValueOnce(first).mockResolvedValueOnce({ ...page(), incidents: [] });
    const { host, panel, doc } = mount(call); await panel.whenLoaded(); const older = host.find('data-incident-action', 'older')!;
    older.focus!(); older.click(); await panel.whenLoaded();
    expect(host.find('data-incident-action', 'older')).toBeUndefined(); expect(doc.activeElement).toBe(host.find('data-incident-action', 'refresh')); panel.dispose();
  });
  it('round-trips non-secret history scopes and rejects unsupported or incomplete addresses', () => {
    for (const scope of [{ kind: 'all' }, { kind: 'connection', name: 'work' }, { kind: 'collection', platform: 'mail', slug: 'in box' },
      { kind: 'group', id: 'a'.repeat(64) }, { kind: 'file_source', source_id: 'google.work.file' }, { kind: 'oauth_apps' }] satisfies AuthenticationIncidentScope[]) {
      expect(parseConnectionsIncidentHistory(parseShellRoute(authenticationIncidentHistoryHref(scope)).segments)).toEqual(scope);
    }
    expect(parseConnectionsIncidentHistory(['others', 'incident-history', 'connection', '../work'])).toBeNull();
    expect(parseConnectionsIncidentHistory(['others', 'incident-history', 'collection', 'mail'])).toBeNull();
    const props = { prefix: 'connections' as const, action: 'reauthorize' as const, current: 'Direct OAuth', canChangeApp: true, canChangeMethod: true, historyScope: { kind: 'connection' as const, name: 'work' } };
    expect(renderAuthenticationManagement(props)).toContain('href="#connections/others/incident-history/connection/work"');
    expect(renderAuthenticationManagement({ ...props, busy: true })).not.toContain('href=');
  });

  const livePage = (): AuthenticationIncidentHistoryPage => {
    const value = singleRecordFixture(); const rows = ['incident', 'repair', 'verification', 'renewal'].map(kind => value.entries.find(entry => entry.type === kind)!.record);
    return { scope: value.scope, observed_at: 300, retention_days: 90, incidents: [rows[0] as import('@recued/contracts').AuthenticationIncident], repairs: [rows[1] as AuthenticationRepairAction],
      verifications: [rows[2] as AuthenticationAccessVerification], renewals: [rows[3] as AuthenticationRenewalHistory], order: rows.map(row => row.id) };
  };
  const openLive = (f: ReturnType<typeof mount>, id = page().incidents[0]!.id): Element => {
    const view = f.host.find('data-history-live-record', id)!; view.open = true; view.fire('toggle'); return view;
  };
  it.each(['aliases', 'full'] as const)('copies and downloads all four live record kinds in %s mode without whole-report support or extra RPCs', async mode => {
    const data = livePage(); const records = [...data.incidents, ...data.repairs!, ...data.verifications!, ...data.renewals!];
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(data); const download = vi.fn(); const write = vi.fn().mockResolvedValue(undefined);
    const f = mount(call, data.scope, { download }); copyBrowser(f, { clipboard: { writeText: write } }); await f.panel.whenLoaded();
    expect(f.host.querySelectorAll('[data-history-live-record]').length).toBe(4); expect(f.host.find('data-history-preview-control', 'copy-record')).toBeUndefined();
    expect(f.host.find('data-history-export', 'preview')!.disabled).toBe(true); const choice = f.host.find('data-history-export-mode', 'privacy')!;
    expect(choice.disabled).toBe(false); expect(choice.value).toBe('aliases'); choice.value = mode; choice.fire('change');
    const expected = records.map(record => prepareAuthenticationHistoryLiveRecord(record, mode)); data.incidents[0]!.group.label = 'Later private source mutation';
    for (let n = 0; n < records.length; n++) {
      const row = openLive(f, records[n]!.id); expect(row.text()).toContain(mode === 'aliases' ? 'separate files do not establish a link' : 'Keep it for local use');
      expect(row.find('data-history-preview-control', 'include-record-context')).toBeUndefined();
      const copy = row.find('data-history-preview-control', 'copy-record')!; const save = row.find('data-history-preview-control', 'download-record')!;
      copy.focus!(); copy.click(); await settleCopy(); save.focus!(); save.click();
      const raw = JSON.stringify(expected[n]!.entry); expect(write).toHaveBeenLastCalledWith(raw); expect(download).toHaveBeenLastCalledWith(expected[n]!.filename, raw);
      expect(f.doc.activeElement).toBe(save); expect(row.find('data-history-preview-download', 'record-status')!.textContent).toBe('Record file download requested.');
      expect(raw).not.toMatch(/Later private source mutation|exported_at|source_snapshot|source_position|access_token/);
      expect(row.text()).toContain('Current vendor access is not checked');
    }
    expect(call).toHaveBeenCalledOnce(); expect(download).toHaveBeenCalledTimes(4); expect(write).toHaveBeenCalledTimes(4); f.panel.dispose();
  });
  it('changes open live records in place, retains lazy closed rows and retires manual text and old actions on privacy changes', async () => {
    const data = livePage(); const download = vi.fn(); const f = mount(async () => data, data.scope, { download }); copyBrowser(f); await f.panel.whenLoaded();
    const row = openLive(f, data.incidents[0]!.id); const save = row.find('data-history-preview-control', 'download-record')!; const copy = row.find('data-history-preview-control', 'copy-record')!;
    copy.focus!(); copy.click(); const manual = row.find('data-history-preview-copy', 'manual-record')!; expect(f.doc.activeElement).toBe(manual);
    const choice = f.host.find('data-history-export-mode', 'privacy')!; choice.focus!(); choice.value = 'full'; choice.fire('change');
    expect(f.doc.activeElement).toBe(choice); expect(f.host.find('data-history-live-record', data.incidents[0]!.id)).toBe(row); expect(row.open).toBe(true);
    expect(row.find('data-history-preview-copy', 'manual-record')).toBeUndefined(); expect(row.text()).not.toContain('incident-1');
    copy.click(); save.click(); expect(download).not.toHaveBeenCalled(); row.find('data-history-preview-control', 'download-record')!.click();
    expect(JSON.parse(download.mock.calls[0]![1]).record.id).toBe(data.incidents[0]!.id);
    const other = f.host.find('data-history-live-record', data.repairs![0]!.id)!; expect(other.open).toBe(false); expect(other.find('data-history-preview-control', 'copy-record')).toBeUndefined(); f.panel.dispose();
  });
  for (const outcome of ['success', 'failure'] as const) it.each(['close', 'privacy', 'refresh', 'dispose'] as const)('ignores pending live copy '+ outcome +' after %s', async phase => {
    let resolve!: () => void; let reject!: (reason: Error) => void; const write = vi.fn(() => new Promise<void>((yes, no) => { resolve = yes; reject = no; }));
    const download = vi.fn(); const f = mount(async () => page(), page().scope, { download }); copyBrowser(f, { clipboard: { writeText: write } }); await f.panel.whenLoaded();
    const row = openLive(f); const copy = row.find('data-history-preview-control', 'copy-record')!; const save = row.find('data-history-preview-control', 'download-record')!;
    const status = row.find('data-history-preview-copy', 'record-status')!; copy.focus!(); copy.click(); expect(write).toHaveBeenCalledOnce();
    if (phase === 'close') { row.open = false; row.fire('toggle'); row.open = true; row.fire('toggle'); }
    else if (phase === 'privacy') { const choice = f.host.find('data-history-export-mode', 'privacy')!; choice.value = 'full'; choice.fire('change'); }
    else if (phase === 'refresh') await f.panel.refresh(); else f.panel.dispose();
    const focus = f.doc.activeElement; if (outcome === 'success') resolve(); else reject(Error('private-pending-error')); await settleCopy();
    copy.click(); save.click(); expect(write).toHaveBeenCalledOnce(); expect(download).not.toHaveBeenCalled(); expect(status.textContent).toBe('Copying record JSON…');
    expect(f.doc.activeElement).toBe(focus); expect(f.host.text()).not.toContain('private-pending-error'); expect(row.find('data-history-preview-copy', 'manual-record')).toBeUndefined(); f.panel.dispose();
  });
  it('keeps live disclosures and selected manual JSON through invalid draft and failed-refresh renders', async () => {
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValueOnce(page()).mockRejectedValue(Error('private-refresh-error'));
    const f = mount(call); const browser = copyBrowser(f); await f.panel.whenLoaded(); const row = openLive(f);
    row.find('data-history-preview-control', 'copy-record')!.focus!(); row.find('data-history-preview-control', 'copy-record')!.click();
    const manual = row.find('data-history-preview-copy', 'manual-record')!; const text = manual.textContent;
    const search = f.host.find('data-history-filter', 'search')!; search.value = 'x'.repeat(129); search.fire('input'); f.host.find('aria-label', 'Filter connection history')!.fire('submit');
    expect(f.doc.activeElement).toBe(manual); expect(browser.selection.setBaseAndExtent).toHaveBeenCalled(); expect(f.host.text()).toContain('Search text is too long');
    await f.panel.refresh(); expect(f.host.find('data-history-live-record', page().incidents[0]!.id)).toBe(row); expect(f.doc.activeElement).toBe(manual);
    expect(row.find('data-history-preview-copy', 'manual-record')).toBe(manual); expect(manual.textContent).toBe(text); expect(row.open).toBe(true);
    expect(f.host.text()).toContain('History could not be refreshed'); expect(f.host.text()).not.toContain('private-refresh-error'); f.panel.dispose();
  });
  it('keeps an earlier row export active while loading another page and retires a replaced row after success', async () => {
    const first: AuthenticationIncidentHistoryPage = { ...page(), next_cursor: 'older' }; const second = structuredClone(first); second.incidents[0]!.id = '22345678-1234-4123-8123-123456789abc'; delete second.next_cursor;
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValue(first);
    const download = vi.fn(); const f = mount(call, first.scope, { download }); await f.panel.whenLoaded(); const row = openLive(f); const save = row.find('data-history-preview-control', 'download-record')!;
    save.focus!(); f.host.find('data-incident-action', 'older')!.click(); await f.panel.whenLoaded(); expect(f.host.find('data-history-live-record', first.incidents[0]!.id)).toBe(row);
    expect(f.doc.activeElement).toBe(save); save.click(); expect(download).toHaveBeenCalledOnce(); expect(f.host.querySelectorAll('[data-history-live-record]').length).toBe(2);
    await f.panel.refresh(); save.click(); expect(download).toHaveBeenCalledOnce(); expect(f.host.find('data-history-live-record', first.incidents[0]!.id)).not.toBe(row); f.panel.dispose();
  });
  it('keeps repeated open toggle events from replacing a prepared live action group', async () => {
    const download = vi.fn(); const f = mount(async () => page(), page().scope, { download }); await f.panel.whenLoaded(); const row = openLive(f); const save = row.find('data-history-preview-control', 'download-record')!;
    row.fire('toggle'); expect(row.find('data-history-preview-control', 'download-record')).toBe(save); save.click(); expect(download).toHaveBeenCalledOnce(); f.panel.dispose();
  });
  it.each(['return', 'throw'] as const)('does not paint live download feedback after its callback changes privacy and %s', async outcome => {
    let f!: ReturnType<typeof mount>; const download = vi.fn(() => { const choice = f.host.find('data-history-export-mode', 'privacy')!; choice.value = 'full'; choice.focus!(); choice.fire('change'); if (outcome === 'throw') throw Error('private-callback-error'); });
    f = mount(async () => page(), page().scope, { download }); await f.panel.whenLoaded(); const row = openLive(f); const save = row.find('data-history-preview-control', 'download-record')!;
    const saved = row.find('data-history-preview-download', 'record-status')!; const error = row.find('data-history-preview-download', 'record-error')!; save.focus!(); save.click();
    expect(download).toHaveBeenCalledOnce(); expect(saved.hidden).toBe(true); expect(error.hidden).toBe(true); expect(f.doc.activeElement).toBe(f.host.find('data-history-export-mode', 'privacy')); expect(f.host.text()).not.toContain('private-callback-error'); save.click(); expect(download).toHaveBeenCalledOnce(); f.panel.dispose();
  });
  it('offers bounded download failure feedback, retry and manual copy on a live record', async () => {
    const download = vi.fn().mockImplementationOnce(() => { throw Error('private-download-error'); }); const f = mount(async () => page(), page().scope, { download }); copyBrowser(f); await f.panel.whenLoaded(); const row = openLive(f);
    const save = row.find('data-history-preview-control', 'download-record')!; save.focus!(); save.click(); expect(row.text()).toContain('This browser could not start the record download'); expect(f.doc.activeElement).toBe(save);
    save.click(); expect(download).toHaveBeenCalledTimes(2); expect(row.find('data-history-preview-download', 'record-error')!.hidden).toBe(true);
    const copy = row.find('data-history-preview-control', 'copy-record')!; copy.focus!(); copy.click(); const manual = row.find('data-history-preview-copy', 'manual-record')!;
    expect(f.doc.activeElement).toBe(manual); expect(manual.getAttribute('aria-readonly')).toBe('true'); expect(manual.textContent).toBe(download.mock.calls[1]![1]); expect(row.text()).not.toContain('private-download-error'); f.panel.dispose();
  });
  it('refuses an oversized full live entry locally while leaving its alias export and history usable', async () => {
    const data = page(); data.incidents[0]!.group.uses = Array.from({ length: 5000 }, (_, n) => ({ kind: 'pack', id: 'pack-' + n, label: 'x'.repeat(2048) }));
    const download = vi.fn(); const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(data); const f = mount(call, data.scope, { download }); await f.panel.whenLoaded();
    const choice = f.host.find('data-history-export-mode', 'privacy')!; choice.value = 'full'; choice.fire('change'); const row = openLive(f);
    expect(row.text()).toContain('8 MiB limit'); expect(row.find('data-history-preview-control', 'download-record')).toBeUndefined(); expect(f.host.find('data-authentication-incident', data.incidents[0]!.id)).toBeDefined();
    choice.value = 'aliases'; choice.fire('change'); row.find('data-history-preview-control', 'download-record')!.click(); expect(download).toHaveBeenCalledOnce(); expect(call).toHaveBeenCalledOnce(); f.panel.dispose();
  });

  it.each(['summary', 'download', 'manual'] as const)('returns focus from a replaced live %s control to the same saved record', async field => {
    let release!: (value: AuthenticationIncidentHistoryPage) => void; const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValueOnce(page()).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const f = mount(call); copyBrowser(f); await f.panel.whenLoaded(); const row = openLive(f); let control = row.children[0]!;
    if (field === 'download') control = row.find('data-history-preview-control', 'download-record')!;
    if (field === 'manual') { const copy = row.find('data-history-preview-control', 'copy-record')!; copy.focus!(); copy.click(); control = row.find('data-history-preview-copy', 'manual-record')!; }
    control.focus!(); const pending = f.panel.refresh(); expect(f.doc.activeElement).toBe(control); release(page()); await pending;
    const updated = f.host.find('data-history-live-record', page().incidents[0]!.id)!; expect(updated).not.toBe(row); expect(updated.open).toBe(false);
    expect(f.doc.activeElement).toBe(updated.children[0]); expect(updated.find('data-history-preview-control', 'download-record')).toBeUndefined(); f.panel.dispose();
  });
  it('returns focus to Refresh history when the focused live record no longer appears', async () => {
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValueOnce(page()).mockResolvedValue({ ...page(), incidents: [] });
    const f = mount(call); await f.panel.whenLoaded(); const row = openLive(f); row.find('data-history-preview-control', 'download-record')!.focus!(); await f.panel.refresh();
    expect(f.host.find('data-history-live-record', page().incidents[0]!.id)).toBeUndefined(); expect(f.doc.activeElement).toBe(f.host.find('data-incident-action', 'refresh')); f.panel.dispose();
  });
  it.each(['filter', 'external'] as const)('preserves newer %s focus when a live record is replaced', async choice => {
    let release!: (value: AuthenticationIncidentHistoryPage) => void; const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValueOnce(page()).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const f = mount(call); await f.panel.whenLoaded(); const row = openLive(f); row.find('data-history-preview-control', 'download-record')!.focus!(); const pending = f.panel.refresh();
    let chosen = f.host.find('data-history-filter', 'search')!;
    if (choice === 'external') { chosen = f.doc.createElement(); f.doc.body.appendChild(chosen); } chosen.focus!(); release(page()); await pending;
    expect(f.doc.activeElement).toBe(choice === 'filter' ? f.host.find('data-history-filter', 'search') : chosen); f.panel.dispose();
  });

  it('preserves newer focus chosen by a focus handler when returning to a replaced record', async () => {
    const f = mount(async () => page()); await f.panel.whenLoaded(); const row = openLive(f); row.find('data-history-preview-control', 'download-record')!.focus!();
    const outside = f.doc.createElement(); f.doc.body.appendChild(outside); const original = f.doc.createElement;
    f.doc.createElement = () => { const element = original(); const focus = element.focus!; element.focus = options => { focus(options); if (element.textContent === 'Export this record') outside.focus!(); }; return element; };
    await f.panel.refresh(); expect(f.doc.activeElement).toBe(outside); f.panel.dispose();
  });

  const openLivePreview = (f: ReturnType<typeof mount>, id = page().incidents[0]!.id) => {
    const row = openLive(f, id); const launch = row.find('data-history-live-control', 'preview')!; launch.focus!(); launch.click();
    return { row, launch, preview: f.host.find('data-history-preview', 'live-record')! };
  };
  const openLivePreviewEntry = (preview: Element): Element => { const entry = preview.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle'); return entry; };
  it.each(['aliases', 'full'] as const)('previews each live record kind as the exact %s download without another request or a full export caller', async mode => {
    const data = livePage(); const records = [...data.incidents, ...data.repairs!, ...data.verifications!, ...data.renewals!]; const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(data); const download = vi.fn(); const write = vi.fn().mockResolvedValue(undefined);
    for (const row of records) Object.assign(row, { access_token: 'private-preview-marker' });
    const expected = records.map(record => prepareAuthenticationHistoryLiveRecord(record, mode)); const f = mount(call, data.scope, { download }); copyBrowser(f, { clipboard: { writeText: write } }); await f.panel.whenLoaded();
    expect(f.host.find('data-history-preview', 'live-record')!.hidden).toBe(true); expect(f.host.find('data-history-live-control', 'preview')).toBeUndefined();
    const choice = f.host.find('data-history-export-mode', 'privacy')!; choice.value = mode; choice.fire('change'); data.incidents[0]!.group.label = 'Later private preview mutation';
    for (const [n, record] of records.entries()) {
      const { launch, preview } = openLivePreview(f, record.id); expect(preview.hidden).toBe(false); expect(launch.getAttribute('aria-controls')).toBe(Reflect.get(preview, 'id'));
      expect(preview.text()).toContain('Prepared locally from a loaded history record'); expect(preview.text()).toContain('Source snapshot details are unknown'); expect(preview.text()).toContain('Current vendor access was not checked');
      expect(preview.text()).not.toContain('Opened locally:'); expect(preview.text()).not.toContain('Opened from pasted JSON'); expect(preview.text()).not.toContain('original report is not included');
      expect(f.doc.activeElement?.textContent).toBe('History record preview'); const entry = openLivePreviewEntry(preview);
      expect(entry.find('data-history-preview-control', 'include-record-context')).toBeUndefined(); expect(entry.find('data-history-preview-related', 'bundle')).toBeUndefined();
      const copy = entry.find('data-history-preview-control', 'copy-record')!; copy.focus!(); copy.click(); await settleCopy(); entry.find('data-history-preview-control', 'download-record')!.click();
      expect(write).toHaveBeenLastCalledWith(expected[n]!.json); expect(download).toHaveBeenLastCalledWith(expected[n]!.filename, expected[n]!.json);
      preview.find('data-history-preview-control', 'download')!.click(); expect(download).toHaveBeenLastCalledWith(expected[n]!.filename, expected[n]!.json);
      expect(preview.text()).not.toMatch(/private-preview-marker|Later private preview mutation/); expect(f.host.find('data-history-preview', 'report')!.hidden).toBe(true);
    }
    expect(call).toHaveBeenCalledOnce(); expect(write).toHaveBeenCalledTimes(4); expect(download).toHaveBeenCalledTimes(8); f.panel.dispose();
  });
  it.each(['same row', 'closed row', 'refreshed row', 'removed row'] as const)('returns from the live preview to its %s source safely', async phase => {
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValueOnce(page()).mockResolvedValue(phase === 'removed row' ? { ...page(), incidents: [] } : page());
    const f = mount(call); await f.panel.whenLoaded(); const { row, launch, preview } = openLivePreview(f);
    if (phase === 'closed row') { row.open = false; row.fire('toggle'); }
    if (phase === 'refreshed row' || phase === 'removed row') await f.panel.refresh(); expect(preview.hidden).toBe(false);
    const close = preview.find('data-history-preview-control', 'close')!; close.focus!(); close.click(); expect(preview.hidden).toBe(true);
    const target = phase === 'same row' ? launch : phase === 'removed row' ? f.host.find('data-incident-action', 'refresh') : f.host.find('data-history-live-record', page().incidents[0]!.id)!.children[0];
    expect(f.doc.activeElement).toBe(target); f.panel.dispose();
  });
  it.each(['success', 'failure'] as const)('preserves a captured live preview, manual selection and its bytes through refresh %s', async outcome => {
    const next = page(); next.incidents[0]!.group.label = 'New loaded history label'; const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValueOnce(page());
    if (outcome === 'success') call.mockResolvedValue(next); else call.mockRejectedValue(Error('private-preview-refresh-error'));
    const download = vi.fn(); const f = mount(call, page().scope, { download }); const browser = copyBrowser(f); await f.panel.whenLoaded(); const { preview } = openLivePreview(f); const entry = openLivePreviewEntry(preview);
    const expected = prepareAuthenticationHistoryLiveRecord(page().incidents[0], 'aliases'); const copy = entry.find('data-history-preview-control', 'copy-record')!; copy.focus!(); copy.click(); const manual = entry.find('data-history-preview-copy', 'manual-record')!;
    expect(f.doc.activeElement).toBe(manual); await f.panel.refresh(); expect(f.doc.activeElement).toBe(manual); expect(browser.selection.setBaseAndExtent).toHaveBeenCalled(); expect(manual.textContent).toBe(expected.json);
    expect(preview.find('data-history-preview-record', '0')).toBe(entry); expect(preview.text()).not.toContain('New loaded history label'); preview.find('data-history-preview-control', 'download')!.click(); expect(download).toHaveBeenCalledExactlyOnceWith(expected.filename, expected.json);
    expect(f.host.text()).not.toContain('private-preview-refresh-error'); f.panel.dispose();
  });
  it.each(['aliases', 'full'] as const)('retires the old %s preview and delayed copy feedback when privacy changes', async mode => {
    let reject!: (reason: Error) => void; const write = vi.fn(() => new Promise<void>((_resolve, no) => { reject = no; })); const download = vi.fn(); const f = mount(async () => page(), page().scope, { download }); copyBrowser(f, { clipboard: { writeText: write } }); await f.panel.whenLoaded();
    const choice = f.host.find('data-history-export-mode', 'privacy')!; choice.value = mode; choice.fire('change'); const { preview } = openLivePreview(f); const old = openLivePreviewEntry(preview); const oldSave = old.find('data-history-preview-control', 'download-record')!; const oldCopy = old.find('data-history-preview-control', 'copy-record')!; const status = old.find('data-history-preview-copy', 'record-status')!;
    oldCopy.focus!(); oldCopy.click(); choice.focus!(); choice.value = mode === 'aliases' ? 'full' : 'aliases'; choice.fire('change'); expect(preview.hidden).toBe(true); expect(f.doc.activeElement).toBe(choice);
    reject(Error('private-preview-copy-error')); await settleCopy(); oldSave.click(); oldCopy.click(); expect(download).not.toHaveBeenCalled(); expect(write).toHaveBeenCalledOnce(); expect(status.textContent).toBe('Copying record JSON…');
    const opened = openLivePreview(f); const expected = prepareAuthenticationHistoryLiveRecord(page().incidents[0], choice.value as 'aliases' | 'full'); opened.preview.find('data-history-preview-control', 'download')!.click(); expect(download).toHaveBeenCalledExactlyOnceWith(expected.filename, expected.json); expect(f.host.text()).not.toContain('private-preview-copy-error'); f.panel.dispose();
  });
  it('returns retired live-preview focus to the row summary when privacy is changed without moving focus', async () => {
    const f = mount(async () => page()); copyBrowser(f); await f.panel.whenLoaded(); const { row, preview } = openLivePreview(f); const entry = openLivePreviewEntry(preview); const copy = entry.find('data-history-preview-control', 'copy-record')!; copy.focus!(); copy.click();
    const choice = f.host.find('data-history-export-mode', 'privacy')!; choice.value = 'full'; choice.fire('change'); expect(preview.hidden).toBe(true); expect(f.doc.activeElement).toBe(row.children[0]); f.panel.dispose();
  });
  it.each(['success', 'failure'] as const)('replaces a live snapshot without reviving the earlier pending copy %s', async outcome => {
    let resolve!: () => void; let reject!: (reason: Error) => void; const write = vi.fn(() => new Promise<void>((yes, no) => { resolve = yes; reject = no; })); const data = livePage(); const download = vi.fn(); const f = mount(async () => data, data.scope, { download }); copyBrowser(f, { clipboard: { writeText: write } }); await f.panel.whenLoaded();
    const first = openLivePreview(f, data.incidents[0]!.id); const old = openLivePreviewEntry(first.preview); const save = old.find('data-history-preview-control', 'download-record')!; const copy = old.find('data-history-preview-control', 'copy-record')!; const status = old.find('data-history-preview-copy', 'record-status')!; copy.focus!(); copy.click();
    const second = openLivePreview(f, data.repairs![0]!.id); const focused = f.doc.activeElement; if (outcome === 'success') resolve(); else reject(Error('private-replaced-preview-copy')); await settleCopy();
    save.click(); copy.click(); expect(download).not.toHaveBeenCalled(); expect(write).toHaveBeenCalledOnce(); expect(status.textContent).toBe('Copying record JSON…'); expect(f.doc.activeElement).toBe(focused);
    second.preview.find('data-history-preview-control', 'download')!.click(); const expected = prepareAuthenticationHistoryLiveRecord(data.repairs![0], 'aliases'); expect(download).toHaveBeenCalledExactlyOnceWith(expected.filename, expected.json); f.panel.dispose();
  });
  it('keeps whole-report and opened-file previews independent from the live-record preview', async () => {
    const value = historyExport(page().scope, 1); const exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value); const download = vi.fn(); const f = mount(async () => page(), page().scope, { exportHistory, download }); await f.panel.whenLoaded();
    f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); chooseHistoryFile(f, async () => JSON.stringify(value)); await f.panel.whenLoaded();
    const whole = f.host.find('data-history-preview', 'report')!; const saved = f.host.find('data-history-preview', 'file')!; const fullSave = whole.find('data-history-preview-control', 'download')!; const fileSave = saved.find('data-history-preview-control', 'download')!;
    const { preview } = openLivePreview(f); expect(whole.hidden).toBe(false); expect(saved.hidden).toBe(false); expect(preview.hidden).toBe(false);
    preview.find('data-history-preview-control', 'close')!.focus!(); preview.find('data-history-preview-control', 'close')!.click(); expect(whole.find('data-history-preview-control', 'download')).toBe(fullSave); expect(saved.find('data-history-preview-control', 'download')).toBe(fileSave);
    fullSave.click(); fileSave.click(); expect(download).toHaveBeenCalledTimes(2); expect(exportHistory).toHaveBeenCalledOnce(); f.panel.dispose();
  });
  it('opens a local record during a pending full export and preserves the newer preview focus', async () => {
    let release!: (value: AuthenticationHistoryExport) => void; const exportHistory = vi.fn<AuthenticationHistoryExportCaller>(() => new Promise(resolve => { release = resolve; })); const f = mount(async () => page(), page().scope, { exportHistory }); await f.panel.whenLoaded();
    f.host.find('data-history-export', 'preview')!.focus!(); f.host.find('data-history-export', 'preview')!.click(); const { preview } = openLivePreview(f); const focused = f.doc.activeElement; Reflect.set(focused!, 'isConnected', true); expect(preview.hidden).toBe(false);
    expect(f.host.find('data-history-export-mode', 'privacy')!.disabled).toBe(true); release(historyExport(page().scope, 1)); await f.panel.whenLoaded(); expect(f.doc.activeElement).toBe(focused); expect(preview.hidden).toBe(false); expect(f.host.find('data-history-preview', 'report')!.hidden).toBe(false); f.panel.dispose();
  });
  it.each(['privacy', 'close row', 'refresh', 'dispose'] as const)('keeps discarded live preview launchers inert after %s', async phase => {
    const f = mount(async () => page()); await f.panel.whenLoaded(); const row = openLive(f); const launch = row.find('data-history-live-control', 'preview')!;
    if (phase === 'privacy') { const choice = f.host.find('data-history-export-mode', 'privacy')!; choice.value = 'full'; choice.fire('change'); }
    else if (phase === 'close row') { row.open = false; row.fire('toggle'); } else if (phase === 'refresh') await f.panel.refresh(); else f.panel.dispose();
    const focused = f.doc.activeElement; launch.click(); expect(f.host.find('data-history-preview', 'live-record')!.hidden).toBe(true); expect(f.doc.activeElement).toBe(focused); f.panel.dispose();
  });
  it('keeps row copy/download usable after a bounded preview-open failure and permits retry', async () => {
    const download = vi.fn(); const f = mount(async () => page(), page().scope, { download }); await f.panel.whenLoaded(); const row = openLive(f); const launch = row.find('data-history-live-control', 'preview')!;
    const create = f.doc.createElement; let refuse = true; f.doc.createElement = () => { if (refuse) { refuse = false; throw Error('private-preview-render-error'); } return create(); }; launch.focus!(); launch.click();
    expect(row.find('data-history-live-preview', 'error')!.hidden).toBe(false); expect(row.text()).toContain('You can still copy or download the record'); expect(f.host.find('data-history-preview', 'live-record')!.hidden).toBe(true); expect(f.host.text()).not.toContain('private-preview-render-error');
    row.find('data-history-preview-control', 'download-record')!.click(); expect(download).toHaveBeenCalledOnce(); launch.focus!(); launch.click(); expect(row.find('data-history-live-preview', 'error')!.hidden).toBe(true); expect(f.host.find('data-history-preview', 'live-record')!.hidden).toBe(false); f.panel.dispose();
  });
  it('keeps the captured live entry downloadable after a local search has no matches', async () => {
    const download = vi.fn(); const f = mount(async () => page(), page().scope, { download }); await f.panel.whenLoaded(); const { preview } = openLivePreview(f); const entry = openLivePreviewEntry(preview); const old = entry.find('data-history-preview-control', 'download-record')!;
    const query = preview.find('data-history-preview-search', 'query')!; query.value = 'no-matching-record-value'; query.fire('input'); preview.find('data-history-preview-search', 'form')!.fire('submit');
    expect(preview.find('data-history-preview-record', '0')).toBeUndefined(); old.click(); expect(download).not.toHaveBeenCalled(); preview.find('data-history-preview-control', 'download')!.click(); const expected = prepareAuthenticationHistoryLiveRecord(page().incidents[0], 'aliases'); expect(download).toHaveBeenCalledExactlyOnceWith(expected.filename, expected.json); f.panel.dispose();
  });
  it('does not override focus redirected to another connected control while closing a live preview', async () => {
    const f = mount(async () => page()); await f.panel.whenLoaded(); const { preview } = openLivePreview(f); const close = preview.find('data-history-preview-control', 'close')!;
    const outside = f.doc.createElement(); Reflect.set(outside, 'isConnected', true); f.doc.body.appendChild(outside); close.focus!();
    // Redirect focus while the current close handler clears the preview.
    const original = preview.removeChild.bind(preview); preview.removeChild = child => { original(child); outside.focus!(); };
    close.click(); expect(f.doc.activeElement).toBe(outside); expect(preview.hidden).toBe(true); f.panel.dispose();
  });

  it('brings the source launcher into view after closing a captured preview', async () => {
    const f = mount(async () => page()); await f.panel.whenLoaded(); const { launch, preview } = openLivePreview(f); const scroll = vi.fn(); Reflect.set(launch, 'scrollIntoView', scroll);
    const close = preview.find('data-history-preview-control', 'close')!; close.focus!(); close.click(); expect(f.doc.activeElement).toBe(launch); expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: 'nearest' }); f.panel.dispose();
  });
  it('does not scroll the old source after a return-focus handler chooses a newer control', async () => {
    const f = mount(async () => page()); await f.panel.whenLoaded(); const { launch, preview } = openLivePreview(f); const scroll = vi.fn(); Reflect.set(launch, 'scrollIntoView', scroll);
    const outside = f.doc.createElement(); Reflect.set(outside, 'isConnected', true); f.doc.body.appendChild(outside); const original = launch.focus!; launch.focus = options => { original(options); outside.focus!(); };
    const close = preview.find('data-history-preview-control', 'close')!; close.focus!(); close.click(); expect(f.doc.activeElement).toBe(outside); expect(scroll).not.toHaveBeenCalled(); f.panel.dispose();
  });
  it.each(['start', 'finish'] as const)('preserves focus chosen during the %s of a history refresh with a captured preview', async phase => {
    let resolve!: (value: AuthenticationIncidentHistoryPage) => void;
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValueOnce(page()).mockImplementation(() => new Promise(done => { resolve = done; }));
    const f = mount(call); const browser = copyBrowser(f); await f.panel.whenLoaded(); const { preview } = openLivePreview(f);
    const entry = openLivePreviewEntry(preview); const copy = entry.find('data-history-preview-control', 'copy-record')!; copy.focus!(); copy.click();
    const manual = entry.find('data-history-preview-copy', 'manual-record')!;
    const outside = f.doc.createElement(); Reflect.set(outside, 'isConnected', true); f.doc.body.appendChild(outside);
    const remove = f.host.removeChild.bind(f.host); let redirect = phase === 'start';
    f.host.removeChild = child => { remove(child); if (redirect) { redirect = false; outside.focus!(); } };
    const pending = f.panel.refresh();
    if (phase === 'finish') { manual.focus!(); redirect = true; }
    browser.selection.setBaseAndExtent.mockClear();
    resolve(page()); await pending;
    expect(f.doc.activeElement).toBe(outside);
    expect(browser.selection.setBaseAndExtent).not.toHaveBeenCalled();
    expect(preview.hidden).toBe(false); expect(preview.find('data-history-preview-copy', 'manual-record')).toBe(manual); f.panel.dispose();
  });

  it.each(['query', 'submit', 'clear'] as const)('keeps the active %s control visible after a compact-record search collapses its inspector', async action => {
    const f = mount(async () => page()); await f.panel.whenLoaded(); const { preview } = openLivePreview(f); openLivePreviewEntry(preview);
    const query = preview.find('data-history-preview-search', 'query')!; const submit = preview.find('data-history-preview-control', 'search')!;
    const clear = preview.find('data-history-preview-control', 'search-clear')!; const fieldScroll = vi.fn(); const submitScroll = vi.fn();
    Reflect.set(query, 'scrollIntoView', fieldScroll); Reflect.set(submit, 'scrollIntoView', submitScroll);
    query.value = 'unmatched-record-audit'; const control = action === 'query' ? query : action === 'submit' ? submit : clear; control.focus!();
    if (action === 'clear') clear.click(); else preview.find('data-history-preview-search', 'form')!.fire('submit');
    expect(f.doc.activeElement).toBe(action === 'submit' ? submit : query);
    expect(action === 'submit' ? submitScroll : fieldScroll).toHaveBeenCalledExactlyOnceWith({ block: 'nearest' });
    expect(preview.find('data-history-preview-record', '0')?.open ?? false).toBe(false); f.panel.dispose();
  });
  it('does not scroll an old search field after its clear-focus handler chooses another control', async () => {
    const f = mount(async () => page()); await f.panel.whenLoaded(); const { preview } = openLivePreview(f); openLivePreviewEntry(preview);
    const query = preview.find('data-history-preview-search', 'query')!; const scroll = vi.fn(); Reflect.set(query, 'scrollIntoView', scroll);
    const outside = f.doc.createElement(); Reflect.set(outside, 'isConnected', true); f.doc.body.appendChild(outside);
    const focus = query.focus!; query.focus = options => { focus(options); outside.focus!(); };
    const clear = preview.find('data-history-preview-control', 'search-clear')!; clear.focus!(); clear.click();
    expect(f.doc.activeElement).toBe(outside); expect(scroll).not.toHaveBeenCalled(); f.panel.dispose();
  });

  it.each(['submit', 'newer focus'] as const)('owns pointer search focus while preserving %s after collapsing a compact inspector', async destination => {
    const f = mount(async () => page()); await f.panel.whenLoaded(); const { preview } = openLivePreview(f); openLivePreviewEntry(preview);
    const submit = preview.find('data-history-preview-control', 'search')!; const scroll = vi.fn(); Reflect.set(submit, 'scrollIntoView', scroll);
    const outside = f.doc.createElement(); Reflect.set(outside, 'isConnected', true); f.doc.body.appendChild(outside);
    if (destination === 'newer focus') { const focus = submit.focus!; submit.focus = options => { focus(options); outside.focus!(); }; }
    f.doc.activeElement = f.doc.body; submit.fire('click', 1); preview.find('data-history-preview-search', 'form')!.fire('submit');
    expect(f.doc.activeElement).toBe(destination === 'submit' ? submit : outside);
    if (destination === 'submit') expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: 'nearest' }); else expect(scroll).not.toHaveBeenCalled();
    f.panel.dispose();
  });

  const openSupport = (entry: Element): Element => {
    if (!entry.open) { entry.open = true; entry.fire('toggle'); }
    const timeline = entry.find('data-history-preview-support', 'timeline')!; timeline.open = true; timeline.fire('toggle'); return timeline;
  };
  it.each(['aliases', 'full'] as const)('copies the complete %s support timeline from saved related records even when preview search hides them', async mode => {
    const x = await bundleCopyFixture(mode); const write = vi.fn().mockResolvedValue(undefined); copyBrowser(x.f, { clipboard: { writeText: write } });
    const row = x.f.host.find('data-history-preview-record', '40')!; const timeline = openSupport(row); const copy = timeline.find('data-history-preview-control', 'copy-timeline')!;
    const expected = prepareAuthenticationHistorySupportTimeline({ bundle: createAuthenticationHistoryRelatedBundles(x.captured)(40) });
    copy.focus!(); copy.click(); await settleCopy(); expect(write).toHaveBeenCalledExactlyOnceWith(expected.text); expect(expected.records).toBe(5);
    expect(timeline.find('data-history-preview-copy', 'timeline-status')!.textContent).toBe('Support timeline copied.');
    expect(x.call).toHaveBeenCalledOnce(); expect(x.exportHistory).toHaveBeenCalledOnce(); expect(x.download).not.toHaveBeenCalled(); x.f.panel.dispose();
  });
  it.each(['aliases', 'full'] as const)('copies one live %s incident with an exact selectable fallback and no new request', async mode => {
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page()); const f = mount(call); copyBrowser(f); await f.panel.whenLoaded();
    const choice = f.host.find('data-history-export-mode', 'privacy')!; choice.value = mode; choice.fire('change'); const { preview } = openLivePreview(f);
    const row = openLivePreviewEntry(preview); const timeline = openSupport(row); const copy = timeline.find('data-history-preview-control', 'copy-timeline')!; copy.focus!(); copy.click();
    const saved = prepareAuthenticationHistoryLiveRecord(page().incidents[0], mode); const expected = prepareAuthenticationHistorySupportTimeline({ entry: saved.entry, representation: mode });
    const manual = timeline.find('data-history-preview-copy', 'manual-timeline')!; expect(manual.textContent).toBe(expected.text); expect(f.doc.activeElement).toBe(manual);
    expect(manual.getAttribute('aria-readonly')).toBe('true'); expect(manual.getAttribute('data-history-preview-copy-selection')).toBe('manual');
    expect(expected.text).toContain('Other records are not included'); expect(call).toHaveBeenCalledOnce(); f.panel.dispose();
  });
  for (const outcome of ['resolve', 'reject'] as const) it.each(['privacy', 'replacement', 'search', 'close', 'dispose'] as const)('retires delayed timeline copy '+outcome+' after %s without changing newer controls', async phase => {
    let resolve!: () => void; let reject!: (error: Error) => void; const write = vi.fn(() => new Promise<void>((a, b) => { resolve = a; reject = b; }));
    const f = mount(async () => page()); copyBrowser(f, { clipboard: { writeText: write } }); await f.panel.whenLoaded(); const { preview } = openLivePreview(f);
    const timeline = openSupport(openLivePreviewEntry(preview)); const copy = timeline.find('data-history-preview-control', 'copy-timeline')!; const status = timeline.find('data-history-preview-copy', 'timeline-status')!; copy.focus!(); copy.click();
    if (phase === 'privacy') { const mode = f.host.find('data-history-export-mode', 'privacy')!; mode.value = 'full'; mode.focus!(); mode.fire('change'); }
    else if (phase === 'replacement') openLivePreview(f);
    else if (phase === 'search') { const query = preview.find('data-history-preview-search', 'query')!; query.value = 'no-match-timeline-retirement'; query.focus!(); preview.find('data-history-preview-search', 'form')!.fire('submit'); }
    else if (phase === 'close') { const close = preview.find('data-history-preview-control', 'close')!; close.focus!(); close.click(); }
    else f.panel.dispose();
    const focused = f.doc.activeElement; if (outcome === 'resolve') resolve(); else reject(Error('private-timeline-clipboard-error')); await settleCopy(); copy.click();
    expect(write).toHaveBeenCalledOnce(); expect(status.textContent).toBe('Copying support timeline…'); expect(timeline.find('data-history-preview-copy', 'manual-timeline')).toBeUndefined();
    expect(f.doc.activeElement).toBe(focused); expect(f.host.text()).not.toContain('private-timeline-clipboard-error'); f.panel.dispose();
  });
  it.each(['root', 'other'] as const)('copies the selected '+ '%s' +' incident when an opened bundle contains multiple incidents', async selected => {
    const value = relatedFixture(); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'aliases'); const bundle = createAuthenticationHistoryRelatedBundles(captured)(40);
    const f = mount(); const write = vi.fn().mockResolvedValue(undefined); copyBrowser(f, { clipboard: { writeText: write } }); await f.panel.whenLoaded(); submitPastedHistory(f, JSON.stringify(bundle.report));
    const local = f.host.find('data-history-preview', 'file')!; const index = bundle.report.entries.findIndex(entry => entry.type === 'incident' && (selected === 'root' ? entry.record.id === bundle.report.root.id : entry.record.id !== bundle.report.root.id));
    const row = local.find('data-history-preview-record', String(index))!; const timeline = openSupport(row); timeline.find('data-history-preview-control', 'copy-timeline')!.click(); await settleCopy();
    const entry = bundle.report.entries[index]!; expect(write.mock.calls[0]![0]).toContain('Root incident: "' + entry.record.id + '"');
    expect(write.mock.calls[0]![0]).toContain(selected === 'root' ? 'Coverage: incident and records connected' : 'Coverage: one saved incident'); f.panel.dispose();
  });

  it.each(['aliases', 'full'] as const)('copies a standalone %s incident with its saved source context while preserving its original ID', async mode => {
    const value = relatedFixture(); const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode); const entry = captured.report.entries[40]!;
    const context = authenticationHistoryRecordContext(captured, 40); const file = prepareAuthenticationHistoryContextRecord(entry, context);
    const f = mount(); const write = vi.fn().mockResolvedValue(undefined); copyBrowser(f, { clipboard: { writeText: write } }); await f.panel.whenLoaded(); submitPastedHistory(f, file.json);
    const local = f.host.find('data-history-preview', 'file')!; const row = local.find('data-history-preview-record', '0')!; const timeline = openSupport(row);
    timeline.find('data-history-preview-control', 'copy-timeline')!.click(); await settleCopy();
    expect(write).toHaveBeenCalledExactlyOnceWith(prepareAuthenticationHistorySupportTimeline({ entry, representation: mode, context }).text);
    expect(write.mock.calls[0]![0]).toContain('Source position: 41.'); expect(write.mock.calls[0]![0]).toContain('Coverage: one saved incident'); f.panel.dispose();
  });

  it('keeps timeline preparation failures bounded and permits a manual-copy retry', async () => {
    const f = mount(async () => page()); copyBrowser(f); await f.panel.whenLoaded(); const { preview } = openLivePreview(f); const timeline = openSupport(openLivePreviewEntry(preview));
    const copy = timeline.find('data-history-preview-control', 'copy-timeline')!; const encode = vi.spyOn(TextEncoder.prototype, 'encode').mockImplementationOnce(() => { throw Error('private-timeline-preparation-error'); });
    try { copy.focus!(); copy.click(); } finally { encode.mockRestore(); }
    expect(timeline.find('data-history-preview-copy', 'timeline-status')!.textContent).toContain('must fit within 8 MiB'); expect(f.host.text()).not.toContain('private-timeline-preparation-error');
    expect(timeline.find('data-history-preview-copy', 'manual-timeline')).toBeUndefined(); copy.click(); expect(timeline.find('data-history-preview-copy', 'manual-timeline')!.textContent).toContain('Recued incident support timeline'); f.panel.dispose();
  });

  const comparisonJson = (value: AuthenticationHistoryExport, mode: 'full' | 'aliases' = 'full'): string => prepareAuthenticationHistoryDownload(value, { scope: value.scope, filters: value.filters }, mode).json;
  const comparisonFixture = async (size = 3, downloadText = vi.fn<(filename: string, text: string) => void>()) => {
    const first = historyExport({ kind: 'all' }, size), second = structuredClone(first); second.exported_at = 400;
    if (size === 3) {
      second.entries = [second.entries[1]!, second.entries[2]!, { ...second.entries[0]!, record: { ...second.entries[0]!.record, id: '00000003-1234-4123-8123-123456789abc' } }];
      (second.entries[0]!.record as import('@recued/contracts').AuthenticationIncident).group.label = '<img src="/private-comparison-image"> Changed account';
    } else for (const entry of second.entries) if ('group' in entry.record) entry.record.group.label = 'Changed account';
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page()); const download = vi.fn(); const f = mount(call, page().scope, { download, downloadText }); await f.panel.whenLoaded();
    submitPastedHistory(f, comparisonJson(first)); const panel = f.host.find('data-history-compare', 'panel')!; panel.open = true;
    panel.find('data-history-compare-control', 'baseline')!.click(); submitPastedHistory(f, comparisonJson(second));
    const compare = panel.find('data-history-compare-control', 'compare')!; compare.focus!(); compare.click();
    return { f, panel, first, second, call, download, downloadText };
  };
  it('compares captured Names and IDs reports locally and keeps one-sided inclusion distinct from recovery', async () => {
    const { f, panel, call, download } = await comparisonFixture();
    expect(panel.find('data-history-compare', 'results')!.hidden).toBe(false); expect(f.doc.activeElement).toBe(panel.find('data-history-compare', 'heading'));
    const counts = panel.find('data-history-compare', 'counts')!.textContent;
    expect(counts).toContain('Only in comparison: 1'); expect(counts).toContain('Changed saved data: 1'); expect(counts).toContain('Only in baseline: 1'); expect(counts).toContain('Same saved data: 1');
    expect(panel.text()).toContain('does not establish recovery, deletion or revoked access'); expect(panel.text()).toContain('cannot verify the source server or vendor account');
    expect(panel.find('data-history-compare', 'list')!.children).toHaveLength(3); expect(call).toHaveBeenCalledOnce(); expect(download).not.toHaveBeenCalled(); expect(f.panel.hasDraft()).toBe(false); f.panel.dispose();
  });
  it.each(['aliases', 'single', 'bundle'] as const)('keeps %s files browsable while explaining why they cannot be compared', async kind => {
    const f = mount(); await f.panel.whenLoaded(); const report = prepareAuthenticationHistoryDownload(historyExport({ kind: 'all' }, 1), { scope: { kind: 'all' } }, kind === 'aliases' ? 'aliases' : 'full');
    submitPastedHistory(f, kind === 'aliases' ? report.json : kind === 'single' ? JSON.stringify(report.report.entries[0]) : JSON.stringify(createAuthenticationHistoryRelatedBundles(report)(0).report));
    const panel = f.host.find('data-history-compare', 'panel')!; expect(panel.find('data-history-compare-control', 'baseline')!.disabled).toBe(true); expect(panel.find('data-history-compare-control', 'compare')!.disabled).toBe(true);
    expect(panel.find('data-history-compare', 'eligibility')!.textContent).toContain(kind === 'aliases' ? 'assigned separately' : 'complete history report');
    expect(f.host.find('data-history-preview', 'file')!.hidden).toBe(false); f.panel.dispose();
  });
  it.each(['baseline', 'comparison'] as const)('inspects the %s version with its exact saved entry, source position and report context', async side => {
    const { f, panel, first, second } = await comparisonFixture(); copyBrowser(f);
    const inspect = panel.find('data-history-compare-control', 'inspect-' + side + '-0')!; inspect.focus!(); inspect.click();
    const preview = panel.find('data-history-preview', 'comparison-record')!; expect(preview.hidden).toBe(false);
    const entry = preview.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle');
    entry.find('data-history-preview-control', 'copy-record')!.focus!(); entry.find('data-history-preview-control', 'copy-record')!.click();
    const source = prepareAuthenticationHistoryDownload(side === 'baseline' ? first : second, { scope: first.scope }); const position = side === 'baseline' ? 1 : 0;
    const expected = prepareAuthenticationHistoryContextRecord(source.report.entries[position]!, authenticationHistoryRecordContext(source, position));
    expect(entry.find('data-history-preview-copy', 'manual-record')!.textContent).toBe(JSON.stringify(source.report.entries[position]));
    const contextChoice = entry.find('data-history-preview-control', 'include-record-context')!; Reflect.set(contextChoice, 'checked', true); contextChoice.fire('change');
    entry.find('data-history-preview-control', 'copy-record')!.click(); expect(entry.find('data-history-preview-copy', 'manual-record')!.textContent).toBe(expected.json);
    f.doc.activeElement = f.doc.body; preview.find('data-history-preview-control', 'close')!.click(); expect(f.doc.activeElement).toBe(inspect); f.panel.dispose();
  });
  it('filters, searches and pages the complete captured comparison without changing its sources', async () => {
    const { f, panel, call, first, second } = await comparisonFixture(45); const original = JSON.stringify([first, second]);
    expect(panel.find('data-history-compare', 'list')!.children).toHaveLength(20); panel.find('data-history-compare-control', 'next')!.click(); expect(panel.find('data-history-compare', 'range')!.textContent).toContain('21–40 of 45');
    const query = panel.find('data-history-compare', 'query')!; query.value = second.entries[44]!.record.id; query.focus!();
    panel.querySelectorAll('[aria-label="Search snapshot comparison"]')[0]!.fire('submit'); expect(panel.find('data-history-compare', 'list')!.children).toHaveLength(1); expect(f.doc.activeElement).toBe(query);
    query.value = 'x'.repeat(201); panel.querySelectorAll('[aria-label="Search snapshot comparison"]')[0]!.fire('submit'); expect(panel.find('data-history-compare', 'search-error')!.textContent).toContain('200'); expect(panel.find('data-history-compare', 'list')!.children).toHaveLength(1);
    panel.find('data-history-compare-control', 'clear-search')!.click(); expect(panel.find('data-history-compare', 'list')!.children).toHaveLength(20);
    const filter = panel.find('data-history-compare', 'filter')!; filter.value = 'unchanged'; filter.fire('change'); expect(panel.find('data-history-compare', 'range')!.textContent).toContain('No saved records match');
    expect(JSON.stringify([first, second])).toBe(original); expect(call).toHaveBeenCalledOnce(); f.panel.dispose();
  });
  it('keeps the baseline and captured comparison through invalid reads, canceled selection, paste edits and live refresh', async () => {
    const { f, panel, call } = await comparisonFixture(); const oldList = panel.find('data-history-compare', 'list')!, before = oldList.text();
    chooseHistoryFile(f, async () => { throw Error('private-comparison-read-error'); }); await f.panel.whenLoaded();
    expect(oldList.text()).toBe(before); expect(panel.find('data-history-compare', 'results')!.hidden).toBe(false); expect(panel.text()).not.toContain('private-comparison-read-error');
    const input = f.host.find('data-history-file', 'input')!; Reflect.set(input, 'files', []); input.fire('change'); editPastedHistory(f, '{private-draft');
    await f.panel.refresh(); expect(panel.find('data-history-compare', 'list')).toBe(oldList); expect(oldList.text()).toBe(before); expect(call).toHaveBeenCalledTimes(2); f.panel.dispose();
  });
  it('disables pair changes during a file read and retires old result controls when the new report opens', async () => {
    const { f, panel, second } = await comparisonFixture(); const stale = panel.find('data-history-compare-control', 'inspect-baseline-0')!;
    let release!: (text: string) => void; chooseHistoryFile(f, () => new Promise(resolve => { release = resolve; }));
    expect(panel.find('data-history-compare-control', 'baseline')!.disabled).toBe(true); expect(panel.find('data-history-compare-control', 'compare')!.disabled).toBe(true);
    release(comparisonJson(second)); await f.panel.whenLoaded(); expect(panel.find('data-history-compare', 'results')!.hidden).toBe(true);
    stale.click(); expect(panel.find('data-history-preview', 'comparison-record')!.hidden).toBe(true); expect(panel.find('data-history-compare', 'baseline')!.text()).toContain('3 saved records'); f.panel.dispose();
  });
  it.each(['clear', 'close', 'dispose'] as const)('clears both captured reports on %s and ignores a late file result', async action => {
    const { f, panel, second } = await comparisonFixture(); let release!: (text: string) => void;
    chooseHistoryFile(f, () => new Promise(resolve => { release = resolve; })); const waiting = f.panel.whenLoaded();
    if (action === 'clear') f.host.find('data-history-file', 'clear')!.click(); else if (action === 'close') f.host.find('data-history-preview', 'file')!.find('data-history-preview-control', 'close')!.click(); else f.panel.dispose();
    release(comparisonJson(second)); await waiting; expect(panel.find('data-history-compare', 'results')!.hidden).toBe(true);
    expect(panel.find('data-history-compare-control', 'compare')!.disabled).toBe(true); if (action !== 'dispose') expect(panel.find('data-history-compare', 'baseline')!.text()).toContain('No baseline'); f.panel.dispose();
  });
  it.each(['filter', 'new report', 'clear baseline', 'dispose'] as const)('retires delayed comparison-record clipboard feedback after %s', async action => {
    const { f, panel, second } = await comparisonFixture(); let reject!: (err: Error) => void; const write = vi.fn(() => new Promise<void>((_, no) => { reject = no; })); copyBrowser(f, { clipboard: { writeText: write } });
    panel.find('data-history-compare-control', 'inspect-baseline-0')!.click(); const preview = panel.find('data-history-preview', 'comparison-record')!; const entry = preview.find('data-history-preview-record', '0')!; entry.open = true; entry.fire('toggle');
    const copy = entry.find('data-history-preview-control', 'copy-record')!; const status = entry.find('data-history-preview-copy', 'record-status')!; copy.focus!(); copy.click();
    if (action === 'filter') { const filter = panel.find('data-history-compare', 'filter')!; filter.value = 'unchanged'; filter.focus!(); filter.fire('change'); }
    else if (action === 'new report') submitPastedHistory(f, comparisonJson(second)); else if (action === 'clear baseline') panel.find('data-history-compare-control', 'clear')!.click(); else f.panel.dispose();
    const chosen = f.doc.activeElement; reject(Error('private-comparison-clipboard-error')); await settleCopy(); copy.click();
    expect(write).toHaveBeenCalledOnce(); expect(status.textContent).toBe('Copying record JSON…'); expect(f.doc.activeElement).toBe(chosen); expect(panel.text()).not.toContain('private-comparison-clipboard-error'); f.panel.dispose();
  });

  it('keeps empty comparison views distinct from equality of the captured reports', async () => {
    const { f, panel } = await comparisonFixture(45); expect(panel.find('data-history-compare', 'counts')!.textContent).toContain('Changed saved data: 45');
    const filter = panel.find('data-history-compare', 'filter')!; filter.value = 'unchanged'; filter.fire('change');
    const range = panel.find('data-history-compare', 'range')!;
    expect(range.textContent).toContain('Change the record filter or clear the ID search'); expect(range.textContent).not.toContain('reports are unchanged');
    expect(panel.find('data-history-compare', 'counts')!.textContent).toContain('Changed saved data: 45'); f.panel.dispose();
  });
  it.each(['baseline', 'comparison'] as const)('keeps comparison inspection failures local to the %s button and clears them on retry without erasing a search error', async side => {
    const { f, panel } = await comparisonFixture(); const inspect = panel.find('data-history-compare-control', 'inspect-' + side + '-0')!;
    const encode = vi.spyOn(TextEncoder.prototype, 'encode').mockImplementationOnce(() => { throw Error('private-comparison-inspection-error'); });
    try { inspect.focus!(); inspect.click(); } finally { encode.mockRestore(); }
    const feedback = panel.find('data-history-compare-inspection-error', side + '-0'); expect(feedback).toBeDefined();
    expect(feedback!.hidden).toBe(false); expect(feedback!.textContent).toContain(side === 'baseline' ? 'Baseline record' : 'Comparison record');
    expect(inspect.getAttribute('aria-describedby')).toBe(feedback!.getAttribute('id')); expect(panel.find('data-history-compare', 'error')!.hidden).toBe(true);
    const query = panel.find('data-history-compare', 'query')!; query.value = 'x'.repeat(201); panel.querySelectorAll('[aria-label="Search snapshot comparison"]')[0]!.fire('submit');
    const searchError = panel.find('data-history-compare', 'search-error')!; expect(searchError.hidden).toBe(false); expect(query.getAttribute('aria-describedby')).toBe(searchError.getAttribute('id'));
    inspect.focus!(); inspect.click(); expect(feedback!.hidden).toBe(true); expect(feedback!.textContent).toBe(''); expect(searchError.hidden).toBe(false); expect(query.getAttribute('aria-invalid')).toBe('true');
    expect(panel.find('data-history-preview', 'comparison-record')!.hidden).toBe(false); expect(panel.text()).not.toContain('private-comparison-inspection-error'); f.panel.dispose();
  });


  it('expands paired saved field values lazily with exact source positions, accessible scroll areas and literal nested text', async () => {
    const { f, panel, first, second, call, download } = await comparisonFixture();
    const field = panel.find('data-history-compare-field', '0-group')!; expect(field).toBeDefined(); expect(field.find('data-history-compare-field-value', 'baseline')).toBeUndefined();
    const toggle = field.children[0]!; toggle.focus!(); field.open = true; field.fire('toggle');
    const before = field.find('data-history-compare-field-value', 'baseline')!, after = field.find('data-history-compare-field-value', 'comparison')!;
    expect(JSON.parse(before.textContent)).toEqual((first.entries[1]!.record as import('@recued/contracts').AuthenticationIncident).group);
    expect(JSON.parse(after.textContent)).toEqual((second.entries[0]!.record as import('@recued/contracts').AuthenticationIncident).group);
    expect(after.textContent).toContain('<img src='); expect(field.text()).toContain('Record 2 in the baseline report.'); expect(field.text()).toContain('Record 1 in the comparison report.');
    for (const side of ['baseline', 'comparison'] as const) {
      const section = field.find('data-history-compare-field-side', side)!; const content = field.find('data-history-compare-field-value', side)!;
      expect(content.getAttribute('aria-labelledby')!.split(/\s+/)).toEqual([toggle.getAttribute('id'), section.children[0]!.getAttribute('id'), section.children[1]!.getAttribute('id')]);
      expect(content.getAttribute('tabindex')).toBe('0'); expect(content.getAttribute('role')).toBe('region');
    }
    expect(f.doc.activeElement).toBe(toggle); const count = field.children.length;
    field.open = false; field.fire('toggle'); field.open = true; field.fire('toggle'); expect(field.children).toHaveLength(count);
    expect(panel.find('data-history-compare-field', '1-group')).toBeUndefined(); expect(call).toHaveBeenCalledOnce(); expect(download).not.toHaveBeenCalled(); f.panel.dispose();
  });
  it.each(['baseline', 'comparison'] as const)('labels the optional field missing from the %s side without inventing a value or removal', async missing => {
    const { f, panel, first, second } = await comparisonFixture();
    const a = structuredClone(first), b = structuredClone(second); b.entries = structuredClone(a.entries);
    const record = (missing === 'baseline' ? a : b).entries[0]!.record; if (!('group' in record)) throw Error('Expected incident.'); delete record.last_problem_at;
    submitPastedHistory(f, comparisonJson(a)); panel.find('data-history-compare-control', 'baseline')!.click(); submitPastedHistory(f, comparisonJson(b)); panel.find('data-history-compare-control', 'compare')!.click();
    const field = panel.find('data-history-compare-field', '0-last_problem_at')!; field.open = true; field.fire('toggle');
    expect(field.find('data-history-compare-field-value', missing)!.textContent).toBe('Not saved in this report.');
    expect(field.find('data-history-compare-field-value', missing === 'baseline' ? 'comparison' : 'baseline')!.textContent).toBe('150');
    expect(panel.text()).toContain('does not prove removal'); f.panel.dispose();
  });
  it('keeps saved-value preparation failures local and retryable without hiding an unresolved search error', async () => {
    const { f, panel } = await comparisonFixture(); const field = panel.find('data-history-compare-field', '0-group')!;
    const query = panel.find('data-history-compare', 'query')!; query.value = 'x'.repeat(201); panel.querySelectorAll('[aria-label="Search snapshot comparison"]')[0]!.fire('submit');
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => { throw Error('private-field-preparation-error'); });
    try { field.open = true; field.fire('toggle'); } finally { stringify.mockRestore(); }
    const error = field.find('data-history-compare-field-error', '0-group')!; expect(error.hidden).toBe(false); expect(field.children[0]!.getAttribute('aria-describedby')).toBe(error.getAttribute('id'));
    expect(field.find('data-history-compare-field-value', 'baseline')).toBeUndefined(); expect(panel.text()).not.toContain('private-field-preparation-error');
    field.open = false; field.fire('toggle'); field.open = true; field.fire('toggle'); expect(error.hidden).toBe(true); expect(error.textContent).toBe('');
    expect(field.find('data-history-compare-field-value', 'baseline')).toBeDefined(); expect(panel.find('data-history-compare', 'search-error')!.hidden).toBe(false); expect(query.getAttribute('aria-invalid')).toBe('true'); f.panel.dispose();
  });
  it('keeps expanded saved values through live refresh and invalid native replacement', async () => {
    const { f, panel, call } = await comparisonFixture(); const field = panel.find('data-history-compare-field', '0-group')!;
    field.open = true; field.fire('toggle'); const value = field.find('data-history-compare-field-value', 'baseline')!, raw = value.textContent;
    await f.panel.refresh(); chooseHistoryFile(f, async () => '{private-invalid-field-source'); await f.panel.whenLoaded();
    expect(panel.find('data-history-compare-field', '0-group')).toBe(field); expect(field.open).toBe(true); expect(field.find('data-history-compare-field-value', 'baseline')).toBe(value); expect(value.textContent).toBe(raw);
    expect(call).toHaveBeenCalledTimes(2); expect(panel.text()).not.toContain('private-invalid-field-source'); f.panel.dispose();
  });
  it.each(['filter', 'page', 'new report', 'clear baseline', 'clear opened', 'close', 'dispose'] as const)('retires unopened saved-value disclosures after %s', async action => {
    const { f, panel, second } = await comparisonFixture(45); const stale = panel.find('data-history-compare-field', '0-group')!;
    if (action === 'filter') { const filter = panel.find('data-history-compare', 'filter')!; filter.value = 'unchanged'; filter.focus!(); filter.fire('change'); }
    else if (action === 'page') panel.find('data-history-compare-control', 'next')!.click();
    else if (action === 'new report') submitPastedHistory(f, comparisonJson(second));
    else if (action === 'clear baseline') panel.find('data-history-compare-control', 'clear')!.click();
    else if (action === 'clear opened') f.host.find('data-history-file', 'clear')!.click();
    else if (action === 'close') f.host.find('data-history-preview', 'file')!.find('data-history-preview-control', 'close')!.click();
    else f.panel.dispose();
    const chosen = f.doc.activeElement; stale.open = true; stale.fire('toggle');
    expect(stale.find('data-history-compare-field-value', 'baseline')).toBeUndefined(); expect(f.doc.activeElement).toBe(chosen); f.panel.dispose();
  });

  it('scrolls focused saved values with navigation keys while preserving modifiers, boundaries, external focus and retired controls', async () => {
    const { f, panel } = await comparisonFixture(); const field = panel.find('data-history-compare-field', '0-group')!; field.open = true; field.fire('toggle');
    const value = field.find('data-history-compare-field-value', 'comparison')!; Reflect.set(value, 'scrollHeight', 1000); Reflect.set(value, 'clientHeight', 200); Reflect.set(value, 'scrollTop', 0); value.focus!();
    const top = () => Reflect.get(value, 'scrollTop');
    const press = (key: string, modifiers: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {}) => {
      const preventDefault = vi.fn(), event = { preventDefault, detail: 0, key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...modifiers };
      value.listeners.get('keydown')!(event); return preventDefault;
    };
    expect(press('ArrowDown')).toHaveBeenCalledOnce(); expect(top()).toBe(40); press('PageDown'); expect(top()).toBe(200); press('PageUp'); expect(top()).toBe(40);
    press('End'); expect(top()).toBe(800); expect(press('ArrowDown')).not.toHaveBeenCalled(); expect(top()).toBe(800);
    press('Home'); expect(top()).toBe(0); expect(press('ArrowUp')).not.toHaveBeenCalled(); expect(top()).toBe(0);
    for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const) expect(press('ArrowDown', { [modifier]: true })).not.toHaveBeenCalled();
    expect(press('a')).not.toHaveBeenCalled(); expect(top()).toBe(0);
    field.open = false; expect(press('End')).not.toHaveBeenCalled(); expect(top()).toBe(0); field.open = true;
    f.doc.activeElement = f.doc.body; expect(press('End')).not.toHaveBeenCalled(); expect(top()).toBe(0);
    const filter = panel.find('data-history-compare', 'filter')!; filter.value = 'unchanged'; filter.fire('change'); value.focus!();
    expect(press('End')).not.toHaveBeenCalled(); expect(top()).toBe(0); f.panel.dispose();
  });

  it.each(['baseline', 'comparison'] as const)('names the %s saved-value region with its field and original source position', async side => {
    const { f, panel } = await comparisonFixture(); const field = panel.find('data-history-compare-field', '0-group')!; field.open = true; field.fire('toggle');
    const value = field.find('data-history-compare-field-value', side)!;
    const label = (value.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => panel.find('id', id)?.textContent ?? '').join(' ');
    expect(label).toContain('Group'); expect(label).toContain(side === 'baseline' ? 'Baseline saved value' : 'Comparison saved value');
    expect(label).toContain(side === 'baseline' ? 'Record 2 in the baseline report.' : 'Record 1 in the comparison report.'); f.panel.dispose();
  });

  it('copies every captured difference with source times and limits independently of table search and paging', async () => {
    const { f, panel, first, second, call, download } = await comparisonFixture(45); const write = vi.fn().mockResolvedValue(undefined); copyBrowser(f, { clipboard: { writeText: write } });
    const copy = panel.find('data-history-preview-control', 'copy-comparison')!; expect(copy).toBeDefined(); expect(write).not.toHaveBeenCalled();
    const query = panel.find('data-history-compare', 'query')!; query.value = second.entries[44]!.record.id; panel.querySelectorAll('[aria-label="Search snapshot comparison"]')[0]!.fire('submit');
    expect(panel.find('data-history-compare', 'list')!.children).toHaveLength(1); copy.focus!(); copy.click(); await settleCopy();
    expect(write).toHaveBeenCalledOnce(); const raw = write.mock.calls[0]![0] as string;
    expect(raw).toContain('Differences listed: 45.'); expect(raw).toContain(first.entries[0]!.record.id); expect(raw).toContain(second.entries[44]!.record.id);
    expect(raw).toContain('Baseline source\nCaptured (UTC): 1970-01-01T00:00:00.300Z'); expect(raw).toContain('Comparison source\nCaptured (UTC): 1970-01-01T00:00:00.400Z');
    expect(raw).toContain('finished-record limit: 10000'); expect(raw).toContain('"group" (Group)'); expect(raw).not.toContain('Changed account');
    expect(panel.find('data-history-preview-copy', 'comparison-status')!.textContent).toBe('Comparison summary copied.'); expect(call).toHaveBeenCalledOnce(); expect(download).not.toHaveBeenCalled(); f.panel.dispose();
  });
  it('keeps selectable literal comparison text, selection and focus through filter, paging and live history refresh', async () => {
    const { f, panel } = await comparisonFixture(45); const browser = copyBrowser(f);
    const copy = panel.find('data-history-preview-control', 'copy-comparison')!; copy.focus!(); copy.click();
    const manual = panel.find('data-history-preview-copy', 'manual-comparison')!, raw = manual.textContent;
    expect(raw).toContain('Recued saved history comparison summary'); expect(manual.getAttribute('role')).toBe('textbox'); expect(manual.getAttribute('aria-readonly')).toBe('true');
    expect(f.doc.activeElement).toBe(manual); expect(browser.selected()).toBe(manual);
    panel.find('data-history-compare-control', 'next')!.click(); expect(panel.find('data-history-preview-copy', 'manual-comparison')).toBe(manual); expect(manual.textContent).toBe(raw);
    panel.find('data-history-preview-control', 'select-copy-comparison')!.click(); const filter = panel.find('data-history-compare', 'filter')!; filter.value = 'unchanged'; filter.fire('change'); await f.panel.refresh();
    expect(panel.find('data-history-preview-copy', 'manual-comparison')).toBe(manual); expect(manual.textContent).toBe(raw); expect(f.doc.activeElement).toBe(manual); expect(browser.selected()).toBe(manual);
    browser.range.selectNodeContents.mockClear(); manual.fire('keydown', 0, { key: 'a', metaKey: true }); expect(browser.range.selectNodeContents).toHaveBeenCalledWith(manual);
    panel.find('data-history-preview-control', 'select-copy-comparison')!.click(); expect(browser.selected()).toBe(manual); f.panel.dispose();
  });
  for (const outcome of ['resolve', 'reject'] as const) it.each(['filter', 'page', 'search', 'refresh'] as const)('keeps pending whole-pair copy ' + outcome + ' valid through %s without taking newer focus', async action => {
    const { f, panel, second } = await comparisonFixture(45); let release!: () => void, reject!: (error: Error) => void;
    const write = vi.fn(() => new Promise<void>((yes, no) => { release = yes; reject = no; })); copyBrowser(f, { clipboard: { writeText: write } });
    const copy = panel.find('data-history-preview-control', 'copy-comparison')!; copy.focus!(); copy.click(); copy.click(); expect(write).toHaveBeenCalledOnce();
    if (action === 'filter') { const filter = panel.find('data-history-compare', 'filter')!; filter.value = 'unchanged'; filter.focus!(); filter.fire('change'); }
    else if (action === 'page') { const next = panel.find('data-history-compare-control', 'next')!; next.focus!(); next.click(); }
    else if (action === 'search') { const query = panel.find('data-history-compare', 'query')!; query.value = second.entries[44]!.record.id; query.focus!(); panel.querySelectorAll('[aria-label="Search snapshot comparison"]')[0]!.fire('submit'); }
    else { const refresh = f.host.find('data-incident-action', 'refresh')!; refresh.focus!(); await f.panel.refresh(); }
    const chosen = f.doc.activeElement; if (outcome === 'resolve') release(); else reject(Error('private-summary-copy-error')); await settleCopy();
    expect(f.doc.activeElement).toBe(chosen); expect(copy.getAttribute('aria-busy')).toBe('false');
    const status = panel.find('data-history-preview-copy', 'comparison-status')!;
    if (outcome === 'resolve') expect(status.textContent).toBe('Comparison summary copied.');
    else { expect(status.textContent).toContain('copy it yourself'); expect(panel.find('data-history-preview-copy', 'manual-comparison')!.textContent).toContain('Differences listed: 45.'); }
    expect(panel.text()).not.toContain('private-summary-copy-error'); f.panel.dispose();
  });
  for (const outcome of ['resolve', 'reject'] as const) it.each(['new report', 'clear baseline', 'clear opened', 'close', 'dispose'] as const)('retires comparison summary copy ' + outcome + ' and its old button after %s', async action => {
    const { f, panel, second } = await comparisonFixture(); let release!: () => void, reject!: (error: Error) => void;
    const write = vi.fn(() => new Promise<void>((yes, no) => { release = yes; reject = no; })); copyBrowser(f, { clipboard: { writeText: write } });
    const copy = panel.find('data-history-preview-control', 'copy-comparison')!, status = panel.find('data-history-preview-copy', 'comparison-status')!; copy.focus!(); copy.click();
    if (action === 'new report') submitPastedHistory(f, comparisonJson(second));
    else if (action === 'clear baseline') panel.find('data-history-compare-control', 'clear')!.click();
    else if (action === 'clear opened') f.host.find('data-history-file', 'clear')!.click();
    else if (action === 'close') f.host.find('data-history-preview', 'file')!.find('data-history-preview-control', 'close')!.click();
    else f.panel.dispose();
    const chosen = f.doc.activeElement; if (outcome === 'resolve') release(); else reject(Error('private-stale-summary-copy-error')); await settleCopy(); copy.click();
    expect(write).toHaveBeenCalledOnce(); expect(status.textContent).toBe('Copying comparison summary…'); expect(f.doc.activeElement).toBe(chosen);
    expect(panel.find('data-history-preview-copy', 'manual-comparison')).toBeUndefined(); expect(panel.text()).not.toContain('private-stale-summary-copy-error'); f.panel.dispose();
  });
  it('checks the captured pair again after a clipboard capability getter replaces the comparison', async () => {
    const { f, panel } = await comparisonFixture(); const write = vi.fn().mockResolvedValue(undefined);
    copyBrowser(f, { get clipboard() { panel.find('data-history-compare-control', 'clear')!.click(); return { writeText: write }; } });
    panel.find('data-history-preview-control', 'copy-comparison')!.click(); await settleCopy(); expect(write).not.toHaveBeenCalled(); expect(panel.find('data-history-preview-copy', 'manual-comparison')).toBeUndefined(); f.panel.dispose();
  });
  it('reports a bounded comparison preparation error and allows retry without hiding captured results or ID-search validation', async () => {
    const { f, panel } = await comparisonFixture(); copyBrowser(f); const query = panel.find('data-history-compare', 'query')!; query.value = 'x'.repeat(201); panel.querySelectorAll('[aria-label="Search snapshot comparison"]')[0]!.fire('submit');
    const copy = panel.find('data-history-preview-control', 'copy-comparison')!;
    const encode = vi.spyOn(TextEncoder.prototype, 'encode').mockImplementationOnce(() => { throw Error('private-summary-preparation-error'); });
    try { copy.focus!(); copy.click(); } finally { encode.mockRestore(); }
    expect(panel.find('data-history-preview-copy', 'comparison-status')!.textContent).toContain('must fit within 8 MiB'); expect(panel.find('data-history-preview-copy', 'manual-comparison')).toBeUndefined();
    expect(panel.text()).not.toContain('private-summary-preparation-error'); expect(panel.find('data-history-compare', 'results')!.hidden).toBe(false); expect(panel.find('data-history-compare', 'search-error')!.hidden).toBe(false);
    copy.click(); expect(panel.find('data-history-preview-copy', 'manual-comparison')!.textContent).toContain('Differences listed: 3.'); expect(query.getAttribute('aria-invalid')).toBe('true'); f.panel.dispose();
  });

  it('scrolls the focused manual comparison summary while preserving selection keys, boundaries and retired owners', async () => {
    const { f, panel } = await comparisonFixture(); const browser = copyBrowser(f); const copy = panel.find('data-history-preview-control', 'copy-comparison')!; copy.focus!(); copy.click();
    const manual = panel.find('data-history-preview-copy', 'manual-comparison')!, raw = manual.textContent;
    Reflect.set(manual, 'scrollHeight', 1200); Reflect.set(manual, 'clientHeight', 200); Reflect.set(manual, 'scrollTop', 0);
    const top = () => Reflect.get(manual, 'scrollTop');
    const press = (key: string, modifiers: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; defaultPrevented?: boolean } = {}) => {
      const preventDefault = vi.fn(), event = { preventDefault, detail: 0, key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, defaultPrevented: false, ...modifiers };
      manual.listeners.get('keydown')!(event); return preventDefault;
    };
    expect(press('ArrowDown')).toHaveBeenCalledOnce(); expect(top()).toBe(40); press('PageDown'); expect(top()).toBe(200); press('PageUp'); expect(top()).toBe(40);
    press('End'); expect(top()).toBe(1000); expect(press('ArrowDown')).not.toHaveBeenCalled(); press('Home'); expect(top()).toBe(0); expect(press('ArrowUp')).not.toHaveBeenCalled();
    for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey', 'defaultPrevented'] as const) expect(press('ArrowDown', { [modifier]: true })).not.toHaveBeenCalled();
    expect(press('x')).not.toHaveBeenCalled(); expect(top()).toBe(0); expect(manual.textContent).toBe(raw);
    browser.range.selectNodeContents.mockClear(); expect(press('a', { metaKey: true })).toHaveBeenCalledOnce(); expect(browser.range.selectNodeContents).toHaveBeenCalledWith(manual);
    panel.find('data-history-compare', 'query')!.focus!(); expect(press('End')).not.toHaveBeenCalled(); expect(top()).toBe(0);
    panel.find('data-history-compare-control', 'clear')!.click(); manual.focus!(); expect(press('End')).not.toHaveBeenCalled(); expect(top()).toBe(0); f.panel.dispose();
  });

  it('downloads the exact complete comparison text and saved-time filename through view changes, refresh and invalid replacement', async () => {
    const { f, panel, first, second, call, download, downloadText } = await comparisonFixture(45);
    const capture = compareAuthenticationHistorySnapshots(openAuthenticationHistoryFile(comparisonJson(first)), openAuthenticationHistoryFile(comparisonJson(second)));
    const expected = prepareAuthenticationHistoryComparisonSummary(capture), before = JSON.stringify([first, second]);
    const save = panel.find('data-history-compare-control', 'download-summary')!;
    expect(save.textContent).toBe('Download comparison summary (.txt)'); expect(downloadText).not.toHaveBeenCalled();
    expect(save.getAttribute('aria-describedby')!.split(' ')).toHaveLength(3);
    expect(panel.text()).toContain('Saved IDs and scope names are included; review before sharing');
    panel.find('data-history-compare-control', 'next')!.click();
    const filter = panel.find('data-history-compare', 'filter')!; filter.value = 'unchanged'; filter.fire('change');
    const query = panel.find('data-history-compare', 'query')!; query.value = second.entries[44]!.record.id; panel.querySelectorAll('[aria-label="Search snapshot comparison"]')[0]!.fire('submit');
    await f.panel.refresh(); submitPastedHistory(f, '{private-invalid-file'); save.focus!(); save.click();
    expect(downloadText).toHaveBeenCalledExactlyOnceWith(expected.filename, expected.text); expect(download).not.toHaveBeenCalled(); expect(call).toHaveBeenCalledTimes(2);
    expect(panel.find('data-history-compare', 'download-status')!.textContent).toContain('Download requested: 45 saved record differences.');
    expect(save.disabled).toBe(false); expect(save.getAttribute('aria-busy')).toBe('false'); expect(f.doc.activeElement).toBe(save);
    expect(JSON.stringify([first, second])).toBe(before); expect(f.panel.hasDraft()).toBe(false); f.panel.dispose();
  });
  it('keeps manual-copy text and selection intact when the same summary is downloaded', async () => {
    const { f, panel, downloadText } = await comparisonFixture(); const browser = copyBrowser(f);
    const copy = panel.find('data-history-preview-control', 'copy-comparison')!; copy.focus!(); copy.click();
    const manual = panel.find('data-history-preview-copy', 'manual-comparison')!, raw = manual.textContent;
    const save = panel.find('data-history-compare-control', 'download-summary')!; save.focus!(); save.click();
    expect(downloadText).toHaveBeenCalledOnce(); expect(downloadText.mock.calls[0]![1]).toBe(raw);
    expect(panel.find('data-history-preview-copy', 'manual-comparison')).toBe(manual); expect(browser.selected()).toBe(manual); expect(f.doc.activeElement).toBe(save); f.panel.dispose();
  });
  it.each(['new report', 'clear baseline', 'clear opened', 'close', 'dispose'] as const)('retires the old comparison download after %s', async action => {
    const { f, panel, second, downloadText } = await comparisonFixture(); const save = panel.find('data-history-compare-control', 'download-summary')!;
    const oldStatus = panel.find('data-history-compare', 'download-status')!;
    if (action === 'new report') { submitPastedHistory(f, comparisonJson(second)); panel.find('data-history-compare-control', 'compare')!.click(); }
    else if (action === 'clear baseline') panel.find('data-history-compare-control', 'clear')!.click();
    else if (action === 'clear opened') f.host.find('data-history-file', 'clear')!.click();
    else if (action === 'close') f.host.find('data-history-preview', 'file')!.find('data-history-preview-control', 'close')!.click();
    else f.panel.dispose();
    const focused = f.doc.activeElement; save.click(); expect(downloadText).not.toHaveBeenCalled(); expect(oldStatus.hidden).toBe(true); expect(f.doc.activeElement).toBe(focused);
    if (action === 'new report') { panel.find('data-history-compare-control', 'download-summary')!.click(); expect(downloadText).toHaveBeenCalledOnce(); }
    f.panel.dispose();
  });
  it('refuses partial summary downloads and permits retry while keeping the captured pair and ID validation', async () => {
    const { f, panel, downloadText } = await comparisonFixture(), save = panel.find('data-history-compare-control', 'download-summary')!;
    const query = panel.find('data-history-compare', 'query')!; query.value = 'x'.repeat(201); panel.querySelectorAll('[aria-label="Search snapshot comparison"]')[0]!.fire('submit');
    const encode = vi.spyOn(TextEncoder.prototype, 'encode').mockImplementationOnce(() => { throw Error('private-text-preparation-error'); });
    try { save.focus!(); save.click(); } finally { encode.mockRestore(); }
    expect(downloadText).not.toHaveBeenCalled(); expect(panel.find('data-history-compare', 'download-error')!.textContent).toContain('must fit within 8 MiB');
    expect(panel.find('data-history-compare', 'download-status')!.hidden).toBe(true); expect(panel.text()).not.toContain('private-text-preparation-error');
    expect(panel.find('data-history-compare', 'results')!.hidden).toBe(false); expect(query.getAttribute('aria-invalid')).toBe('true'); expect(f.doc.activeElement).toBe(save);
    save.click(); expect(downloadText).toHaveBeenCalledOnce(); expect(panel.find('data-history-compare', 'download-error')!.hidden).toBe(true); expect(query.getAttribute('aria-invalid')).toBe('true'); f.panel.dispose();
  });
  it('offers copy after a text-download refusal and retries without keeping a stale success message', async () => {
    const { f, panel, downloadText } = await comparisonFixture(), save = panel.find('data-history-compare-control', 'download-summary')!;
    save.click(); downloadText.mockImplementationOnce(() => { throw Error('private-browser-text-error'); }); save.focus!(); save.click();
    const error = panel.find('data-history-compare', 'download-error')!;
    expect(error.hidden).toBe(false); expect(error.textContent).toContain('use Copy comparison summary'); expect(error.getAttribute('role')).toBe('alert');
    expect(panel.find('data-history-compare', 'download-status')!.hidden).toBe(true); expect(panel.text()).not.toContain('private-browser-text-error');
    expect(f.doc.activeElement).toBe(save); expect(save.disabled).toBe(false); expect(save.getAttribute('aria-busy')).toBe('false');
    save.click(); expect(downloadText).toHaveBeenCalledTimes(3); expect(error.hidden).toBe(true); expect(panel.find('data-history-compare', 'download-status')!.hidden).toBe(false); f.panel.dispose();
  });
  it('uses the native text download by default and reports unavailable browser support without using the JSON callback', async () => {
    const download = vi.fn(), f = mount(undefined, page().scope, { download }); await f.panel.whenLoaded();
    submitPastedHistory(f, comparisonJson(historyExport({ kind: 'all' }, 0))); const panel = f.host.find('data-history-compare', 'panel')!;
    panel.find('data-history-compare-control', 'baseline')!.click(); submitPastedHistory(f, comparisonJson(historyExport({ kind: 'all' }, 0))); panel.find('data-history-compare-control', 'compare')!.click();
    panel.find('data-history-compare-control', 'download-summary')!.click();
    expect(panel.find('data-history-compare', 'download-error')!.textContent).toContain('could not start the text download'); expect(download).not.toHaveBeenCalled(); f.panel.dispose();
  });
  it('checks ownership after summary preparation replaces the comparison', async () => {
    const { f, panel, downloadText } = await comparisonFixture(), save = panel.find('data-history-compare-control', 'download-summary')!;
    const original = TextEncoder.prototype.encode, encode = vi.spyOn(TextEncoder.prototype, 'encode').mockImplementationOnce(function (this: TextEncoder, input) {
      panel.find('data-history-compare-control', 'clear')!.click(); return original.call(this, input);
    });
    try { save.click(); } finally { encode.mockRestore(); }
    expect(downloadText).not.toHaveBeenCalled(); expect(panel.find('data-history-compare', 'download-status')).toBeUndefined(); f.panel.dispose();
  });
  it.each(['return', 'throw'] as const)('blocks reentrant downloads and stale feedback when the download callback replaces the pair then %s', async outcome => {
    const { f, panel, second, downloadText } = await comparisonFixture(), save = panel.find('data-history-compare-control', 'download-summary')!;
    const status = panel.find('data-history-compare', 'download-status')!, error = panel.find('data-history-compare', 'download-error')!;
    downloadText.mockImplementationOnce(() => {
      expect(save.disabled).toBe(false); expect(save.getAttribute('aria-disabled')).toBe('true'); expect(save.getAttribute('aria-busy')).toBe('true');
      save.click(); submitPastedHistory(f, comparisonJson(second)); panel.find('data-history-compare-control', 'compare')!.click();
      if (outcome === 'throw') throw Error('private-retired-text-error');
    });
    save.click(); expect(downloadText).toHaveBeenCalledOnce(); expect(status.hidden).toBe(true); expect(error.hidden).toBe(true);
    expect(panel.find('data-history-compare', 'download-status')!.hidden).toBe(true); expect(panel.text()).not.toContain('private-retired-text-error');
    panel.find('data-history-compare-control', 'download-summary')!.click(); expect(downloadText).toHaveBeenCalledTimes(2); f.panel.dispose();
  });

  const comparisonPair = (first = historyExport({ kind: 'all' }, 3), second = historyExport({ kind: 'all' }, 3)) =>
    prepareAuthenticationHistoryComparisonPair(compareAuthenticationHistorySnapshots(openAuthenticationHistoryFile(comparisonJson(first)), openAuthenticationHistoryFile(comparisonJson(second))));
  it('saves both complete reports independently of row filters, ID search, paging, refresh and invalid replacement', async () => {
    const { f, panel, first, second, call, download, downloadText } = await comparisonFixture(45), expected = comparisonPair(first, second);
    const save = panel.find('data-history-compare-control', 'save-pair')!; expect(save).toBeDefined(); expect(download).not.toHaveBeenCalled();
    expect(panel.text()).toContain('including saved field values, account/app labels and source search text'); expect(panel.text()).toContain('Up to 8 MiB combined');
    panel.find('data-history-compare-control', 'next')!.click(); const filter = panel.find('data-history-compare', 'filter')!; filter.value = 'unchanged'; filter.fire('change');
    const query = panel.find('data-history-compare', 'query')!; query.value = second.entries[44]!.record.id; panel.querySelectorAll('[aria-label="Search snapshot comparison"]')[0]!.fire('submit');
    await f.panel.refresh(); submitPastedHistory(f, '{private-invalid-pair-source'); save.focus!(); save.click();
    expect(download).toHaveBeenCalledExactlyOnceWith(expected.filename, expected.json); expect(downloadText).not.toHaveBeenCalled(); expect(call).toHaveBeenCalledTimes(2);
    expect(JSON.parse(download.mock.calls[0]![1]).baseline.entries).toHaveLength(45); expect(JSON.parse(download.mock.calls[0]![1]).comparison.entries).toHaveLength(45);
    expect(panel.find('data-history-compare', 'pair-status')!.textContent).toContain('download requested'); expect(save.getAttribute('aria-busy')).toBe('false'); expect(save.disabled).toBe(false); expect(f.doc.activeElement).toBe(save); f.panel.dispose();
  });
  it.each(['file', 'paste'] as const)('restores a %s comparison pair automatically, keeps selected sides and re-saves the complete pair', async source => {
    const { f: original, first, second } = await comparisonFixture(); original.panel.dispose(); first.exported_at = 500; second.exported_at = 400;
    const saved = comparisonPair(first, second), call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page()), download = vi.fn(), f = mount(call, page().scope, { download }); await f.panel.whenLoaded();
    if (source === 'file') { chooseHistoryFile(f, async () => saved.json, 'private-pair-name.json', saved.bytes); await f.panel.whenLoaded(); }
    else submitPastedHistory(f, saved.json);
    const panel = f.host.find('data-history-compare', 'panel')!; expect(panel.open).toBe(true); expect(panel.find('data-history-compare', 'results')!.hidden).toBe(false);
    expect(panel.find('data-history-compare', 'counts')!.textContent).toContain('Changed saved data: 1'); expect(panel.find('data-history-compare', 'counts')!.textContent).toContain('Only in baseline: 1');
    expect(panel.find('data-history-compare', 'limits')!.textContent).toContain('earlier than the baseline'); expect(f.doc.activeElement).toBe(panel.find('data-history-compare', 'heading'));
    expect(f.host.find('data-history-file', 'status')!.textContent).toContain('Comparison pair restored: 3 baseline records and 3 comparison records');
    expect(f.host.find('data-history-file', 'status')!.textContent).toContain('file preview shows the comparison report'); expect(call).toHaveBeenCalledOnce(); expect(download).not.toHaveBeenCalled();
    const sourcePreview = f.host.find('data-history-preview', 'file')!, reportDownload = sourcePreview.find('data-history-preview-control', 'download')!;
    expect(sourcePreview.text()).toContain('Comparison report from saved pair'); expect(reportDownload.textContent).toBe('Download comparison report (JSON)');
    expect(sourcePreview.find('data-history-preview-comparison', 'source')!.textContent).toContain('contain only the comparison report');
    expect(reportDownload.getAttribute('aria-describedby')).toBeDefined(); expect(sourcePreview.text()).toContain('3 saved records in this comparison report');
    panel.find('data-history-compare-control', 'save-pair')!.click(); expect(download).toHaveBeenCalledExactlyOnceWith(saved.filename, saved.json); expect(download.mock.calls[0]![1]).not.toContain('private-pair-name.json');
    f.host.find('data-history-preview', 'file')!.find('data-history-preview-control', 'download')!.click(); expect(JSON.parse(download.mock.calls[1]![1])).toEqual(JSON.parse(comparisonJson(second)));
    f.panel.dispose();
  });
  it('retains incident, repair, verification and renewal fields and their saved source context in a reopened pair', async () => {
    const first = singleRecordFixture(), second = structuredClone(first); second.exported_at = 400;
    const saved = comparisonPair(first, second), download = vi.fn(), f = mount(undefined, page().scope, { download }); await f.panel.whenLoaded(); submitPastedHistory(f, saved.json);
    const panel = f.host.find('data-history-compare', 'panel')!; panel.find('data-history-compare-control', 'save-pair')!.click();
    expect(download).toHaveBeenCalledExactlyOnceWith(saved.filename, saved.json); const pair = JSON.parse(saved.json);
    expect(new Set(pair.baseline.entries.map((e: { type: string }) => e.type))).toEqual(new Set(['incident', 'repair', 'verification', 'renewal']));
    const filter = panel.find('data-history-compare', 'filter')!; filter.value = 'unchanged'; filter.fire('change');
    panel.find('data-history-compare-control', 'inspect-baseline-0')!.click(); const inspector = panel.find('data-history-preview', 'comparison-record')!;
    expect(inspector.hidden).toBe(false); inspector.find('data-history-preview-control', 'download')!.click();
    expect(JSON.parse(download.mock.calls[1]![1]).source_snapshot.exported_at).toBe(first.exported_at); expect(JSON.parse(download.mock.calls[1]![1]).entry).toEqual(pair.baseline.entries[0]); f.panel.dispose();
  });
  it.each(['file', 'paste'] as const)('preserves the current comparison and manual text after an invalid %s pair', async source => {
    const { f, panel, first, second } = await comparisonFixture(); copyBrowser(f); const saved = comparisonPair(first, second), invalid = JSON.parse(saved.json); invalid.comparison.entry_count++;
    const save = panel.find('data-history-compare-control', 'save-pair')!, copy = panel.find('data-history-preview-control', 'copy-comparison')!; copy.focus!(); copy.click();
    const manual = panel.find('data-history-preview-copy', 'manual-comparison')!, raw = manual.textContent;
    if (source === 'file') { chooseHistoryFile(f, async () => JSON.stringify(invalid)); await f.panel.whenLoaded(); } else submitPastedHistory(f, JSON.stringify(invalid));
    expect(panel.find('data-history-compare-control', 'save-pair')).toBe(save); expect(panel.find('data-history-preview-copy', 'manual-comparison')).toBe(manual); expect(manual.textContent).toBe(raw);
    expect(f.host.find('data-history-file', 'error')!.textContent).toContain('not a valid history export, comparison pair'); expect(panel.find('data-history-compare', 'results')!.hidden).toBe(false); f.panel.dispose();
  });
  it('lets the newest pair win over a late file read and preserves focus outside the replaced content', async () => {
    const early = comparisonPair(), a = historyExport({ kind: 'all' }, 1), b = structuredClone(a); a.exported_at = 600; b.exported_at = 700;
    const late = comparisonPair(a, b), f = mount(); await f.panel.whenLoaded(); let release!: (text: string) => void;
    chooseHistoryFile(f, () => new Promise<string>(resolve => { release = resolve; })); submitPastedHistory(f, late.json);
    const panel = f.host.find('data-history-compare', 'panel')!, outside = f.host.find('data-incident-action', 'refresh')!; outside.focus!(); release(early.json); await settleCopy();
    expect(f.host.find('data-history-file', 'status')!.textContent).toContain('1 baseline records and 1 comparison records'); expect(panel.find('data-history-compare', 'sources')!.text()).toContain('1970-01-01T00:00:00.700Z'); expect(f.doc.activeElement).toBe(outside); f.panel.dispose();
  });
  it.each(['clear pair', 'clear opened', 'close', 'dispose', 'new report', 'new pair'] as const)('retires old pair-save actions after %s', async action => {
    const { f, panel, first, second, download } = await comparisonFixture(), saved = comparisonPair(first, second), old = panel.find('data-history-compare-control', 'save-pair')!;
    if (action === 'clear pair') panel.find('data-history-compare-control', 'clear')!.click();
    else if (action === 'clear opened') f.host.find('data-history-file', 'clear')!.click();
    else if (action === 'close') f.host.find('data-history-preview', 'file')!.find('data-history-preview-control', 'close')!.click();
    else if (action === 'dispose') f.panel.dispose();
    else submitPastedHistory(f, action === 'new report' ? comparisonJson(second) : saved.json);
    old.click(); expect(download).not.toHaveBeenCalled();
    if (action === 'new pair') { panel.find('data-history-compare-control', 'save-pair')!.click(); expect(download).toHaveBeenCalledExactlyOnceWith(saved.filename, saved.json); }
    f.panel.dispose();
  });
  it('keeps the opened comparison report when clearing a restored baseline, and closes both sides with the main preview', async () => {
    const f = mount(); await f.panel.whenLoaded(); submitPastedHistory(f, comparisonPair().json); const panel = f.host.find('data-history-compare', 'panel')!;
    panel.find('data-history-compare-control', 'clear')!.click(); expect(panel.find('data-history-compare', 'results')!.hidden).toBe(true); expect(f.host.find('data-history-preview', 'file')!.hidden).toBe(false);
    expect(panel.find('data-history-compare-control', 'baseline')!.disabled).toBe(false); panel.find('data-history-compare-control', 'baseline')!.click();
    expect(panel.find('data-history-compare', 'baseline')!.text()).toContain('3 saved records');
    f.host.find('data-history-preview', 'file')!.find('data-history-preview-control', 'close')!.click(); expect(panel.find('data-history-compare-control', 'baseline')!.disabled).toBe(true); expect(panel.find('data-history-compare', 'baseline')!.text()).toContain('No baseline'); f.panel.dispose();
  });
  it.each(['file', 'paste'] as const)('clears the pair-source preview label when a normal report replaces it through %s', async source => {
    const download = vi.fn(), f = mount(undefined, page().scope, { download }); await f.panel.whenLoaded();
    const saved = comparisonPair(); submitPastedHistory(f, saved.json);
    let preview = f.host.find('data-history-preview', 'file')!; expect(preview.find('data-history-preview-control', 'download')!.textContent).toBe('Download comparison report (JSON)');
    const normal = comparisonJson(historyExport({ kind: 'all' }, 1));
    if (source === 'file') { chooseHistoryFile(f, async () => normal); await f.panel.whenLoaded(); } else submitPastedHistory(f, normal);
    preview = f.host.find('data-history-preview', 'file')!; const save = preview.find('data-history-preview-control', 'download')!;
    expect(preview.find('data-history-preview-comparison', 'source')).toBeUndefined(); expect(preview.text()).not.toContain('Comparison report from saved pair');
    expect(save.textContent).toBe('Download this preview (JSON)'); expect(save.getAttribute('aria-describedby')).toBeNull(); save.click();
    expect(JSON.parse(download.mock.calls[0]![1])).toEqual(JSON.parse(normal)); f.panel.dispose();
  });
  it('fails pair preparation without a partial download and permits retry while keeping ID-search validation', async () => {
    const { f, panel, download } = await comparisonFixture(), save = panel.find('data-history-compare-control', 'save-pair')!;
    const query = panel.find('data-history-compare', 'query')!; query.value = 'x'.repeat(201); panel.querySelectorAll('[aria-label="Search snapshot comparison"]')[0]!.fire('submit');
    const encode = vi.spyOn(TextEncoder.prototype, 'encode').mockImplementationOnce(() => { throw Error('private-pair-preparation-error'); });
    try { save.focus!(); save.click(); } finally { encode.mockRestore(); }
    expect(download).not.toHaveBeenCalled(); expect(panel.find('data-history-compare', 'pair-error')!.textContent).toContain('Both complete reports must fit within 8 MiB'); expect(panel.text()).not.toContain('private-pair-preparation-error');
    expect(save.getAttribute('aria-busy')).toBe('false'); expect(save.disabled).toBe(false); expect(f.doc.activeElement).toBe(save); save.click(); expect(download).toHaveBeenCalledOnce(); expect(panel.find('data-history-compare', 'pair-error')!.hidden).toBe(true); expect(query.getAttribute('aria-invalid')).toBe('true'); f.panel.dispose();
  });
  it('allows retry after a browser pair-download refusal and keeps clipboard controls independent', async () => {
    const { f, panel, download } = await comparisonFixture(); copyBrowser(f); panel.find('data-history-preview-control', 'copy-comparison')!.click();
    const manual = panel.find('data-history-preview-copy', 'manual-comparison')!, raw = manual.textContent, save = panel.find('data-history-compare-control', 'save-pair')!;
    download.mockImplementationOnce(() => { throw Error('private-pair-download-error'); }); save.focus!(); save.click();
    expect(panel.find('data-history-compare', 'pair-error')!.textContent).toContain('could not start the comparison pair download'); expect(panel.find('data-history-compare', 'pair-status')!.hidden).toBe(true); expect(panel.text()).not.toContain('private-pair-download-error');
    save.click(); expect(download).toHaveBeenCalledTimes(2); expect(panel.find('data-history-preview-copy', 'manual-comparison')).toBe(manual); expect(manual.textContent).toBe(raw); expect(f.doc.activeElement).toBe(save); f.panel.dispose();
  });
  it.each(['return', 'throw'] as const)('blocks reentrant pair saves and stale feedback after the download callback replaces the pair then %s', async outcome => {
    const { f, panel, first, second, download } = await comparisonFixture(), saved = comparisonPair(first, second), old = panel.find('data-history-compare-control', 'save-pair')!;
    const status = panel.find('data-history-compare', 'pair-status')!, error = panel.find('data-history-compare', 'pair-error')!;
    download.mockImplementationOnce(() => { expect(old.disabled).toBe(false); expect(old.getAttribute('aria-busy')).toBe('true'); old.click(); submitPastedHistory(f, saved.json); if (outcome === 'throw') throw Error('private-retired-pair-error'); });
    old.click(); expect(download).toHaveBeenCalledOnce(); expect(status.hidden).toBe(true); expect(error.hidden).toBe(true); expect(panel.find('data-history-compare', 'pair-status')!.hidden).toBe(true); expect(panel.text()).not.toContain('private-retired-pair-error');
    panel.find('data-history-compare-control', 'save-pair')!.click(); expect(download).toHaveBeenCalledTimes(2); f.panel.dispose();
  });

  it('swaps asymmetric inclusion counts, saved values and original positions while keeping the opened report in place', async () => {
    const { f, panel, first, second, call, download, downloadText } = await comparisonFixture(); second.entries.pop(); second.entry_count = second.entries.length;
    submitPastedHistory(f, comparisonJson(second)); panel.find('data-history-compare-control', 'compare')!.click();
    const original = JSON.stringify([first, second]), preview = f.host.find('data-history-preview', 'file')!, previewText = preview.text();
    const counts = panel.find('data-history-compare', 'counts')!; expect(counts.textContent).toContain('Only in comparison: 0'); expect(counts.textContent).toContain('Only in baseline: 1');
    const swap = panel.find('data-history-compare-control', 'swap')!; swap.focus!(); swap.click();
    expect(counts.textContent).toContain('Only in comparison: 1'); expect(counts.textContent).toContain('Only in baseline: 0'); expect(counts.textContent).toContain('Changed saved data: 1');
    expect(panel.find('data-history-compare', 'limits')!.textContent).toContain('earlier than the baseline'); expect(f.doc.activeElement).toBe(panel.find('data-history-compare', 'heading'));
    expect(panel.find('data-history-compare', 'limits')!.textContent).not.toContain('selected sides were not swapped'); expect(panel.find('data-history-compare', 'limits')!.textContent).toContain('Dates do not change the selected order.');
    expect(panel.find('data-history-compare', 'baseline')!.text()).toContain('2 saved records'); expect(panel.find('data-history-compare-control', 'compare')!.disabled).toBe(true);
    expect(panel.find('data-history-compare', 'eligibility')!.textContent).toContain('opened report is the selected baseline');
    const field = panel.find('data-history-compare-field', '1-group')!; field.open = true; field.fire('toggle');
    const before = field.find('data-history-compare-field-side', 'baseline')!, after = field.find('data-history-compare-field-side', 'comparison')!;
    expect(before.text()).toContain('Record 1 in the baseline report'); expect(after.text()).toContain('Record 2 in the comparison report');
    expect(JSON.parse(before.find('data-history-compare-field-value', 'baseline')!.textContent)).toEqual(JSON.parse(comparisonJson(second)).entries[0].record.group);
    expect(JSON.parse(after.find('data-history-compare-field-value', 'comparison')!.textContent)).toEqual(JSON.parse(comparisonJson(first)).entries[1].record.group);
    const reversed = compareAuthenticationHistorySnapshots(openAuthenticationHistoryFile(comparisonJson(second)), openAuthenticationHistoryFile(comparisonJson(first))), pair = prepareAuthenticationHistoryComparisonPair(reversed), summary = prepareAuthenticationHistoryComparisonSummary(reversed);
    panel.find('data-history-compare-control', 'save-pair')!.click(); panel.find('data-history-compare-control', 'download-summary')!.click();
    expect(download).toHaveBeenCalledExactlyOnceWith(pair.filename, pair.json); expect(downloadText).toHaveBeenCalledExactlyOnceWith(summary.filename, summary.text);
    expect(summary.text).not.toContain('Selected sides were not swapped.'); expect(summary.text).toContain('Dates do not change the selected order.');
    expect(f.host.find('data-history-preview', 'file')).toBe(preview); expect(preview.text()).toBe(previewText); preview.find('data-history-preview-control', 'download')!.click();
    expect(JSON.parse(download.mock.calls[1]![1])).toEqual(JSON.parse(comparisonJson(second))); expect(JSON.stringify([first, second])).toBe(original); expect(call).toHaveBeenCalledOnce(); expect(f.panel.hasDraft()).toBe(false); f.panel.dispose();
  });
  it.each(['file', 'paste'] as const)('reopens a swapped %s pair in its displayed order and restores the original pair after a second swap', async source => {
    const { f, panel, first, second, download } = await comparisonFixture(); first.exported_at = 500; second.exported_at = 400;
    const saved = comparisonPair(first, second), reversed = comparisonPair(second, first);
    if (source === 'file') { chooseHistoryFile(f, async () => saved.json, 'pair.json', saved.bytes); await f.panel.whenLoaded(); } else submitPastedHistory(f, saved.json);
    panel.find('data-history-compare-control', 'swap')!.click(); const sources = panel.find('data-history-compare', 'sources')!;
    expect(sources.children[0]!.text()).toContain('Original comparison report'); expect(sources.children[1]!.text()).toContain('Original baseline report');
    expect(panel.find('data-history-compare', 'limits')!.textContent).toContain('capture time is later');
    expect(f.host.find('data-history-preview-comparison', 'source')!.textContent).toContain('Swapping comparison sides keeps this opened report in place');
    panel.find('data-history-compare-control', 'save-pair')!.click(); expect(download).toHaveBeenLastCalledWith(reversed.filename, reversed.json);
    panel.find('data-history-compare-control', 'swap')!.click(); panel.find('data-history-compare-control', 'save-pair')!.click(); expect(download).toHaveBeenLastCalledWith(saved.filename, saved.json);
    expect(panel.find('data-history-compare', 'limits')!.textContent).toContain('earlier than the baseline');
    submitPastedHistory(f, reversed.json); panel.find('data-history-compare-control', 'save-pair')!.click(); expect(download).toHaveBeenLastCalledWith(reversed.filename, reversed.json); f.panel.dispose();
  });
  it('uses the swapped baseline for the next report and keeps pinning tied to the opened preview', async () => {
    const { f, panel, first, second, download } = await comparisonFixture(); panel.find('data-history-compare-control', 'swap')!.click();
    panel.find('data-history-compare-control', 'baseline')!.click(); expect(panel.find('data-history-compare', 'results')!.hidden).toBe(true);
    expect(panel.find('data-history-compare', 'baseline')!.text()).toContain(new Date(second.exported_at).toISOString()); expect(panel.find('data-history-compare', 'eligibility')!.textContent).not.toContain('swap the displayed sides');
    const third = structuredClone(first); third.exported_at = 600; submitPastedHistory(f, comparisonJson(third));
    panel.find('data-history-compare-control', 'compare')!.click(); panel.find('data-history-compare-control', 'save-pair')!.click();
    const expected = comparisonPair(second, third); expect(download).toHaveBeenLastCalledWith(expected.filename, expected.json);
    panel.find('data-history-compare-control', 'swap')!.click(); submitPastedHistory(f, comparisonJson(first)); panel.find('data-history-compare-control', 'compare')!.click(); panel.find('data-history-compare-control', 'save-pair')!.click();
    const next = comparisonPair(third, first); expect(download).toHaveBeenLastCalledWith(next.filename, next.json); f.panel.dispose();
  });
  it('resets comparison filters, ID validation and paging when the sides change', async () => {
    const { f, panel } = await comparisonFixture(45); panel.find('data-history-compare-control', 'next')!.click();
    expect(panel.find('data-history-compare', 'range')!.textContent).toContain('21–40 of 45');
    const filter = panel.find('data-history-compare', 'filter')!; filter.value = 'changed'; filter.fire('change');
    const query = panel.find('data-history-compare', 'query')!; query.value = 'x'.repeat(201); panel.querySelectorAll('[aria-label="Search snapshot comparison"]')[0]!.fire('submit');
    panel.find('data-history-compare-control', 'swap')!.click();
    expect(filter.value).toBe('differences'); expect(query.value).toBe(''); expect(query.getAttribute('aria-invalid')).toBe('false'); expect(panel.find('data-history-compare', 'search-error')!.hidden).toBe(true);
    expect(panel.find('data-history-compare', 'range')!.textContent).toContain('1–20 of 45'); expect(panel.find('data-history-compare-control', 'previous')!.disabled).toBe(true); f.panel.dispose();
  });
  it.each(['resolve', 'reject'] as const)('retires old inspection, values, downloads and pending copy %s on swap', async outcome => {
    const { f, panel, download, downloadText } = await comparisonFixture(); let release!: () => void, reject!: (error: Error) => void;
    const write = vi.fn(() => new Promise<void>((yes, no) => { release = yes; reject = no; })); copyBrowser(f, { clipboard: { writeText: write } });
    const inspect = panel.find('data-history-compare-control', 'inspect-baseline-0')!, field = panel.find('data-history-compare-field', '0-group')!, save = panel.find('data-history-compare-control', 'save-pair')!, text = panel.find('data-history-compare-control', 'download-summary')!, swap = panel.find('data-history-compare-control', 'swap')!;
    inspect.click(); const inspector = panel.find('data-history-preview', 'comparison-record')!; expect(inspector.hidden).toBe(false);
    const copy = panel.find('data-history-preview-control', 'copy-comparison')!, status = panel.find('data-history-preview-copy', 'comparison-status')!; copy.focus!(); copy.click(); swap.focus!(); swap.click();
    expect(inspector.hidden).toBe(true); const chosen = f.doc.activeElement; if (outcome === 'resolve') release(); else reject(Error('private-stale-swap-copy-error')); await settleCopy();
    inspect.click(); field.open = true; field.fire('toggle'); save.click(); text.click(); swap.click(); copy.click();
    expect(inspector.hidden).toBe(true); expect(field.find('data-history-compare-field-value', 'baseline')).toBeUndefined(); expect(write).toHaveBeenCalledOnce(); expect(status.textContent).toBe('Copying comparison summary…');
    expect(download).not.toHaveBeenCalled(); expect(downloadText).not.toHaveBeenCalled(); expect(f.doc.activeElement).toBe(chosen); expect(panel.text()).not.toContain('private-stale-swap-copy-error'); f.panel.dispose();
  });
  it('inspects the reversed source record with its exact saved entry and original report context', async () => {
    const { f, panel, first, second, download } = await comparisonFixture(); panel.find('data-history-compare-control', 'swap')!.click();
    panel.find('data-history-compare-control', 'inspect-baseline-1')!.click(); const inspector = panel.find('data-history-preview', 'comparison-record')!;
    inspector.find('data-history-preview-control', 'download')!.click(); const saved = JSON.parse(download.mock.calls[0]![1]);
    expect(saved.source_snapshot.exported_at).toBe(second.exported_at); expect(saved.source_position).toBe(1); expect(saved.entry).toEqual(JSON.parse(comparisonJson(second)).entries[0]);
    panel.find('data-history-compare-control', 'inspect-comparison-1')!.click(); inspector.find('data-history-preview-control', 'download')!.click(); const other = JSON.parse(download.mock.calls[1]![1]);
    expect(other.source_snapshot.exported_at).toBe(first.exported_at); expect(other.source_position).toBe(2); expect(other.entry).toEqual(JSON.parse(comparisonJson(first)).entries[1]); f.panel.dispose();
  });
  it('holds direction during replacement reads, resumes after a refusal and retires swap when a valid replacement opens', async () => {
    const { f, panel, second } = await comparisonFixture(); const swap = panel.find('data-history-compare-control', 'swap')!, sources = panel.find('data-history-compare', 'sources')!.text();
    let release!: (text: string) => void; chooseHistoryFile(f, () => new Promise(resolve => { release = resolve; })); expect(swap.disabled).toBe(true); swap.fire('click');
    expect(panel.find('data-history-compare', 'sources')!.text()).toBe(sources); release('{invalid-swap-replacement'); await f.panel.whenLoaded(); expect(swap.disabled).toBe(false); swap.click();
    const reversed = panel.find('data-history-compare', 'sources')!.text(); expect(reversed).not.toBe(sources);
    const stale = panel.find('data-history-compare-control', 'swap')!; chooseHistoryFile(f, () => new Promise(resolve => { release = resolve; })); release(comparisonJson(second)); await f.panel.whenLoaded(); stale.click();
    expect(panel.find('data-history-compare', 'results')!.hidden).toBe(true); expect(panel.find('data-history-compare-control', 'swap')).toBeUndefined(); f.panel.dispose();
  });
  it.each(['clear baseline', 'clear opened', 'close', 'dispose'] as const)('retires a swapped pair and its old swap action on %s', async action => {
    const { f, panel, download } = await comparisonFixture(); panel.find('data-history-compare-control', 'swap')!.click(); const stale = panel.find('data-history-compare-control', 'swap')!;
    if (action === 'clear baseline') panel.find('data-history-compare-control', 'clear')!.click();
    else if (action === 'clear opened') f.host.find('data-history-file', 'clear')!.click();
    else if (action === 'close') f.host.find('data-history-preview', 'file')!.find('data-history-preview-control', 'close')!.click(); else f.panel.dispose();
    stale.click(); expect(panel.find('data-history-compare', 'results')!.hidden).toBe(true); expect(download).not.toHaveBeenCalled();
    if (action === 'clear baseline') { expect(panel.find('data-history-compare', 'baseline')!.text()).toContain('No baseline'); expect(f.host.find('data-history-preview', 'file')!.hidden).toBe(false); }
    f.panel.dispose();
  });
  it('keeps swapped sources through history refresh, paste drafts and invalid replacement', async () => {
    const { f, panel, first, second, download } = await comparisonFixture(); panel.find('data-history-compare-control', 'swap')!.click(); const swap = panel.find('data-history-compare-control', 'swap')!;
    editPastedHistory(f, '{draft-after-swap'); await f.panel.refresh(); submitPastedHistory(f, '{invalid-after-swap');
    expect(panel.find('data-history-compare-control', 'swap')).toBe(swap); panel.find('data-history-compare-control', 'save-pair')!.click(); const expected = comparisonPair(second, first);
    expect(download).toHaveBeenCalledExactlyOnceWith(expected.filename, expected.json); f.panel.dispose();
  });

  it.each(['baseline', 'comparison'] as const)('opens the full %s comparison source for local search and complete download without changing the pair', async side => {
    const { f, panel, first, second, call, download } = await comparisonFixture(45), source = side === 'baseline' ? first : second, expected = JSON.parse(comparisonJson(source));
    copyBrowser(f); const query = panel.find('data-history-compare', 'query')!; query.value = second.entries[44]!.record.id; panel.querySelectorAll('[aria-label="Search snapshot comparison"]')[0]!.fire('submit');
    const range = panel.find('data-history-compare', 'range')!.textContent, current = f.host.find('data-history-preview', 'file')!, currentText = current.text();
    const open = panel.find('data-history-compare-control', 'open-' + side)!; expect(open.textContent).toBe('Open ' + side + ' report'); open.focus!(); open.click();
    const view = panel.find('data-history-preview', 'comparison-record')!; expect(view.hidden).toBe(false); expect(view.getAttribute('data-history-preview-layout')).toBe('report'); expect(f.doc.activeElement).toBe(view.children[0]);
    expect(view.children[0]!.textContent).toBe((side === 'baseline' ? 'Baseline' : 'Comparison') + ' source report'); expect(view.find('data-history-preview-comparison-source', side)!.textContent).toContain('Pasted history JSON');
    expect(view.text()).toContain('45 saved records in this ' + side + ' report'); expect(view.text()).toContain('Names and IDs'); expect(view.text()).toContain('Current vendor access was not checked');
    const search = view.find('data-history-preview-search', 'query')!; search.value = source.entries[44]!.record.id; view.find('data-history-preview-search', 'form')!.fire('submit');
    expect(view.querySelectorAll('[data-history-preview-record]')).toHaveLength(1); const save = view.find('data-history-preview-control', 'download')!;
    expect(save.textContent).toBe('Download ' + side + ' report (JSON)'); expect(save.getAttribute('aria-describedby')).toBeTruthy(); expect(view.find('data-history-preview-comparison', 'source-report')!.textContent).toContain('complete ' + side + ' report');
    save.focus!(); save.click(); expect(download).toHaveBeenCalledOnce(); expect(JSON.parse(download.mock.calls[0]![1])).toEqual(expected); expect(download.mock.calls[0]![0]).toContain('recued-history-' + side + '-report-'); expect(download.mock.calls[0]![0]).not.toMatch(/Pasted|Work|<script>/); expect(f.doc.activeElement).toBe(save);
    expect(panel.find('data-history-compare', 'range')!.textContent).toBe(range); expect(query.value).toBe(second.entries[44]!.record.id); expect(f.host.find('data-history-preview', 'file')).toBe(current); expect(current.text()).toBe(currentText);
    view.find('data-history-preview-control', 'close')!.click(); expect(f.doc.activeElement).toBe(open); expect(panel.find('data-history-compare', 'results')!.hidden).toBe(false);
    panel.find('data-history-compare-control', 'save-pair')!.click(); expect(JSON.parse(download.mock.calls[1]![1])).toEqual(JSON.parse(comparisonPair(first, second).json)); expect(call).toHaveBeenCalledOnce(); expect(f.panel.hasDraft()).toBe(false); f.panel.dispose();
  });
  it.each(['resolve', 'reject'] as const)('keeps a comparison source search, page and pending copy %s through comparison view changes', async outcome => {
    const { f, panel, first, call } = await comparisonFixture(45); let resolve!: () => void, reject!: (error: Error) => void;
    const write = vi.fn(() => new Promise<void>((yes, no) => { resolve = yes; reject = no; })); copyBrowser(f, { clipboard: { writeText: write } });
    panel.find('data-history-compare-control', 'open-baseline')!.click(); const view = panel.find('data-history-preview', 'comparison-record')!;
    view.find('data-history-preview-control', 'next')!.click(); const sourceRange = view.find('data-history-preview-range', 'records')!.textContent;
    panel.find('data-history-compare-control', 'next')!.click(); expect(view.find('data-history-preview-range', 'records')!.textContent).toBe(sourceRange);
    const query = view.find('data-history-preview-search', 'query')!; query.value = first.entries[44]!.record.id; view.find('data-history-preview-search', 'form')!.fire('submit');
    const record = view.find('data-history-preview-record', '44')!; expect(record).toBeDefined(); record.open = true; record.fire('toggle');
    const copy = record.find('data-history-preview-control', 'copy-record')!; copy.focus!(); copy.click(); const status = record.find('data-history-preview-copy', 'record-status')!;
    const filter = panel.find('data-history-compare', 'filter')!; filter.value = 'unchanged'; filter.focus!(); filter.fire('change');
    const comparisonQuery = panel.find('data-history-compare', 'query')!; comparisonQuery.value = 'x'.repeat(201); panel.querySelectorAll('[aria-label="Search snapshot comparison"]')[0]!.fire('submit'); await f.panel.refresh();
    expect(view.find('data-history-preview-record', '44')).toBe(record); expect(query.value).toBe(first.entries[44]!.record.id); expect(view.hidden).toBe(false);
    if (outcome === 'resolve') resolve(); else reject(Error('private-source-copy-refusal')); await settleCopy();
    if (outcome === 'resolve') expect(status.textContent).toContain('copied'); else expect(record.find('data-history-preview-copy', 'manual-record')!.textContent).toBe(JSON.stringify(JSON.parse(comparisonJson(first)).entries[44]));
    expect(f.doc.activeElement).toBe(filter); expect(panel.text()).not.toContain('private-source-copy-refusal'); expect(call).toHaveBeenCalledTimes(2); f.panel.dispose();
  });
  it.each(['file', 'paste'] as const)('opens both reports of a reopened %s comparison source pair and follows swapped roles', async source => {
    const { f, panel, first, second, download } = await comparisonFixture(), pair = comparisonPair(first, second); copyBrowser(f);
    if (source === 'file') { chooseHistoryFile(f, async () => pair.json, 'source-pair.json', pair.bytes); await f.panel.whenLoaded(); } else submitPastedHistory(f, pair.json);
    panel.find('data-history-compare-control', 'open-baseline')!.click(); const view = panel.find('data-history-preview', 'comparison-record')!; expect(view.find('data-history-preview-comparison-source', 'baseline')!.textContent).toContain('Original baseline report');
    const stale = view.find('data-history-preview-control', 'download')!; stale.click(); expect(JSON.parse(download.mock.calls[0]![1])).toEqual(JSON.parse(comparisonJson(first)));
    panel.find('data-history-compare-control', 'open-comparison')!.click(); expect(view.find('data-history-preview-comparison-source', 'comparison')!.textContent).toContain('Original comparison report'); stale.click(); expect(download).toHaveBeenCalledOnce();
    const oldOpen = panel.find('data-history-compare-control', 'open-baseline')!; panel.find('data-history-compare-control', 'swap')!.click(); expect(view.hidden).toBe(true); oldOpen.click(); expect(view.hidden).toBe(true);
    panel.find('data-history-compare-control', 'open-baseline')!.click(); expect(view.find('data-history-preview-comparison-source', 'baseline')!.textContent).toContain('Original comparison report');
    view.find('data-history-preview-control', 'download')!.click(); expect(JSON.parse(download.mock.calls[1]![1])).toEqual(JSON.parse(comparisonJson(second))); f.panel.dispose();
  });
  it.each(['swap', 'new report', 'new pair', 'clear baseline', 'main close', 'dispose'] as const)('retires comparison source controls and pending clipboard feedback after %s', async action => {
    const { f, panel, first, second, download } = await comparisonFixture(); let reject!: (error: Error) => void; const write = vi.fn(() => new Promise<void>((_, no) => { reject = no; })); copyBrowser(f, { clipboard: { writeText: write } });
    const oldOpen = panel.find('data-history-compare-control', 'open-baseline')!; oldOpen.click(); const view = panel.find('data-history-preview', 'comparison-record')!, save = view.find('data-history-preview-control', 'download')!;
    const record = view.find('data-history-preview-record', '0')!; record.open = true; record.fire('toggle'); const copy = record.find('data-history-preview-control', 'copy-record')!, status = record.find('data-history-preview-copy', 'record-status')!; copy.focus!(); copy.click();
    if (action === 'swap') panel.find('data-history-compare-control', 'swap')!.click(); else if (action === 'new report') submitPastedHistory(f, comparisonJson(second));
    else if (action === 'new pair') submitPastedHistory(f, comparisonPair(second, first).json); else if (action === 'clear baseline') panel.find('data-history-compare-control', 'clear')!.click();
    else if (action === 'main close') f.host.find('data-history-preview', 'file')!.find('data-history-preview-control', 'close')!.click(); else f.panel.dispose();
    const focus = f.doc.activeElement; reject(Error('private-stale-source-copy')); await settleCopy(); oldOpen.click(); save.click(); copy.click();
    expect(view.hidden).toBe(true); expect(write).toHaveBeenCalledOnce(); expect(download).not.toHaveBeenCalled(); expect(status.textContent).toBe('Copying record JSON…'); expect(f.doc.activeElement).toBe(focus); expect(panel.text()).not.toContain('private-stale-source-copy'); f.panel.dispose();
  });
  it('keeps a comparison source open during reads and invalid replacement, then closes it for a valid report', async () => {
    const { f, panel, first, second } = await comparisonFixture(); let release!: (text: string) => void; chooseHistoryFile(f, () => new Promise(resolve => { release = resolve; }));
    const open = panel.find('data-history-compare-control', 'open-baseline')!; expect(open.disabled).toBe(false); open.click(); const view = panel.find('data-history-preview', 'comparison-record')!, search = view.find('data-history-preview-search', 'query')!;
    search.value = first.entries[0]!.record.id; view.find('data-history-preview-search', 'form')!.fire('submit'); const before = view.text(); release('{private-invalid-source-file'); await f.panel.whenLoaded();
    expect(view.hidden).toBe(false); expect(view.text()).toBe(before); expect(panel.find('data-history-compare-control', 'open-baseline')).toBe(open); editPastedHistory(f, '{private-source-draft'); expect(view.text()).toBe(before);
    chooseHistoryFile(f, () => new Promise(resolve => { release = resolve; })); release(comparisonJson(second)); await f.panel.whenLoaded(); open.click(); expect(view.hidden).toBe(true); f.panel.dispose();
  });
  it('replaces a comparison source with record inspection and restores normal record lifecycle and labels', async () => {
    const { f, panel } = await comparisonFixture(); panel.find('data-history-compare-control', 'open-baseline')!.click(); const view = panel.find('data-history-preview', 'comparison-record')!;
    const old = view.find('data-history-preview-control', 'download')!; panel.find('data-history-compare-control', 'inspect-baseline-0')!.click();
    expect(view.getAttribute('data-history-preview-layout')).toBe('record'); expect(view.find('data-history-preview-comparison-source', 'baseline')).toBeUndefined(); expect(view.find('data-history-preview-comparison', 'source-report')).toBeUndefined(); expect(view.find('data-history-preview-control', 'download')!.textContent).toBe('Download this preview (JSON)');
    const filter = panel.find('data-history-compare', 'filter')!; filter.value = 'unchanged'; filter.fire('change'); expect(view.hidden).toBe(true); old.click(); expect(view.hidden).toBe(true); f.panel.dispose();
  });
  it.each(['return', 'throw'] as const)('guards a comparison source download against reentry and replacement followed by %s', async outcome => {
    const { f, panel, second, download } = await comparisonFixture(); panel.find('data-history-compare-control', 'open-baseline')!.click(); const view = panel.find('data-history-preview', 'comparison-record')!, save = view.find('data-history-preview-control', 'download')!;
    download.mockImplementationOnce(() => { save.click(); panel.find('data-history-compare-control', 'open-comparison')!.click(); if (outcome === 'throw') throw Error('private-source-download-refusal'); });
    save.focus!(); save.click(); expect(download).toHaveBeenCalledOnce(); expect(view.children[0]!.textContent).toBe('Comparison source report'); expect(view.text()).not.toMatch(/download requested|could not start|private-source-download-refusal/);
    view.find('data-history-preview-control', 'download')!.click(); expect(download).toHaveBeenCalledTimes(2); expect(JSON.parse(download.mock.calls[1]![1])).toEqual(JSON.parse(comparisonJson(second))); f.panel.dispose();
  });
  it('retains all record types and exact source context when browsing a complete comparison source report', async () => {
    const first = singleRecordFixture(), second = structuredClone(first); second.exported_at = 400; const download = vi.fn(), f = mount(undefined, page().scope, { download }); await f.panel.whenLoaded();
    submitPastedHistory(f, comparisonPair(first, second).json); const panel = f.host.find('data-history-compare', 'panel')!; panel.find('data-history-compare-control', 'open-baseline')!.click(); const view = panel.find('data-history-preview', 'comparison-record')!;
    expect(view.querySelectorAll('[data-history-preview-record]')).toHaveLength(Math.min(20, first.entry_count)); view.find('data-history-preview-control', 'download')!.click(); const saved = JSON.parse(download.mock.calls[0]![1]);
    expect(new Set(saved.entries.map((entry: { type: string }) => entry.type))).toEqual(new Set(['incident', 'repair', 'verification', 'renewal']));
    const position = saved.entries.findIndex((entry: { type: string }) => entry.type === 'renewal'); const query = view.find('data-history-preview-search', 'query')!; query.value = saved.entries[position].record.id; view.find('data-history-preview-search', 'form')!.fire('submit');
    const record = view.find('data-history-preview-record', String(position))!; record.open = true; record.fire('toggle'); const include = record.find('data-history-preview-control', 'include-record-context')!; Reflect.set(include, 'checked', true); include.fire('change'); record.find('data-history-preview-control', 'download-record')!.click();
    const context = JSON.parse(download.mock.calls[1]![1]); expect(context.source_position).toBe(position + 1); expect(context.source_snapshot.exported_at).toBe(first.exported_at); expect(context.entry).toEqual(saved.entries[position]); f.panel.dispose();
  });

  it('opens an empty complete comparison source without treating a lack of rows as an unavailable report', async () => {
    const { f, panel, first, download } = await comparisonFixture(0); panel.find('data-history-compare-control', 'open-baseline')!.click(); const view = panel.find('data-history-preview', 'comparison-record')!;
    expect(view.hidden).toBe(false); expect(view.text()).toContain('0 saved records in this baseline report'); expect(view.querySelectorAll('[data-history-preview-record]')).toHaveLength(0);
    view.find('data-history-preview-control', 'download')!.click(); expect(JSON.parse(download.mock.calls[0]![1])).toEqual(JSON.parse(comparisonJson(first))); expect(panel.find('data-history-compare', 'results')!.hidden).toBe(false); f.panel.dispose();
  });

  it.each(['baseline', 'comparison'] as const)('opens a %s comparison record at its original full-source position and returns without changing comparison drafts', async side => {
    const { f, panel, first, second, download, call } = await comparisonFixture(45); second.entries.reverse(); submitPastedHistory(f, comparisonPair(first, second).json);
    const rowIndex = side === 'baseline' ? 1 : 43, source = side === 'baseline' ? first : second;
    const query = panel.find('data-history-compare', 'query')!; query.value = second.entries[rowIndex]!.record.id; panel.querySelectorAll('[aria-label="Search snapshot comparison"]')[0]!.fire('submit');
    query.value = 'x'.repeat(201); panel.querySelectorAll('[aria-label="Search snapshot comparison"]')[0]!.fire('submit');
    const range = panel.find('data-history-compare', 'range')!.textContent, main = f.host.find('data-history-preview', 'file')!, mainText = main.text();
    const open = panel.find('data-history-compare-control', 'open-' + side + '-source-' + rowIndex)!; expect(open.textContent).toBe('Open ' + side + ' record in full source'); open.focus!(); open.click();
    const view = panel.find('data-history-preview', 'comparison-record')!, target = view.find('data-history-preview-record', '43')!;
    expect(view.children[0]!.textContent).toBe((side === 'baseline' ? 'Baseline' : 'Comparison') + ' source report'); expect(view.getAttribute('data-history-preview-layout')).toBe('report');
    expect(target.open).toBe(true); expect(target.getAttribute('data-history-preview-source-record')).toBe('true'); expect(f.doc.activeElement).toBe(target.children[0]); expect(target.children[0]!.getAttribute('aria-describedby')).toBeTruthy();
    expect(target.find('data-history-preview-source-position', '44')!.textContent).toContain('source record 44 of 45'); expect(view.find('data-history-preview-range', 'records')!.textContent).toContain('41–45');
    expect(view.find('data-history-preview-search', 'query')!.value).toBe(''); expect(view.querySelectorAll('[data-history-preview-record]')).toHaveLength(5);
    view.find('data-history-preview-control', 'download')!.click(); expect(JSON.parse(download.mock.calls[0]![1])).toEqual(JSON.parse(comparisonJson(source)));
    expect(panel.find('data-history-compare', 'range')!.textContent).toBe(range); expect(query.value).toBe('x'.repeat(201)); expect(query.getAttribute('aria-invalid')).toBe('true'); expect(main.text()).toBe(mainText);
    const back = target.find('data-history-preview-control', 'return-comparison')!; back.focus!(); back.click(); expect(view.hidden).toBe(true); expect(f.doc.activeElement).toBe(open); expect(panel.find('data-history-compare', 'source-return')!.hidden).toBe(true);
    back.click(); expect(f.doc.activeElement).toBe(open); open.click(); view.find('data-history-preview-control', 'close')!.focus!(); view.find('data-history-preview-control', 'close')!.click(); expect(f.doc.activeElement).toBe(open);
    panel.find('data-history-compare-control', 'open-' + side)!.click(); expect(view.find('data-history-preview-source-record', 'true')).toBeUndefined(); expect(view.find('data-history-preview-control', 'close')!.textContent).toBe('Close preview'); expect(view.find('data-history-preview-range', 'records')!.textContent).toContain('1–20');
    expect(query.value).toBe('x'.repeat(201)); expect(call).toHaveBeenCalledOnce(); expect(f.panel.hasDraft()).toBe(false); f.panel.dispose();
  });
  it('opens one-sided records only in the source that actually includes them', async () => {
    const { f, panel, download, first, second } = await comparisonFixture();
    expect(panel.find('data-history-compare-control', 'open-baseline-source-2')).toBeUndefined(); expect(panel.find('data-history-compare-control', 'open-comparison-source-3')).toBeUndefined();
    for (const [side, row, position, report] of [['comparison', 2, 2, second], ['baseline', 3, 0, first]] as const) {
      panel.find('data-history-compare-control', 'open-' + side + '-source-' + row)!.click(); const view = panel.find('data-history-preview', 'comparison-record')!;
      expect(view.find('data-history-preview-record', String(position))!.getAttribute('data-history-preview-source-record')).toBe('true'); view.find('data-history-preview-control', 'download')!.click(); expect(JSON.parse(download.mock.calls.at(-1)![1])).toEqual(JSON.parse(comparisonJson(report)));
    } f.panel.dispose();
  });
  it('retains exact entries and source contexts for every record type on both sides of a reopened and swapped pair', async () => {
    const first = singleRecordFixture(), second = structuredClone(first); second.exported_at = 400; second.entries.reverse(); const download = vi.fn(), f = mount(undefined, page().scope, { download }); await f.panel.whenLoaded();
    submitPastedHistory(f, comparisonPair(first, second).json); const panel = f.host.find('data-history-compare', 'panel')!; panel.find('data-history-compare-control', 'swap')!.click();
    const captured = compareAuthenticationHistorySnapshots(openAuthenticationHistoryFile(comparisonJson(second)), openAuthenticationHistoryFile(comparisonJson(first)));
    const filter = panel.find('data-history-compare', 'filter')!; filter.value = 'unchanged'; filter.fire('change');
    for (const type of ['incident', 'repair', 'verification', 'renewal'] as const) for (const side of ['baseline', 'comparison'] as const) {
      const rowIndex = captured.rows.findIndex(row => row.type === type), row = captured.rows[rowIndex]!, position = (side === 'baseline' ? row.baseline_index : row.comparison_index)!, source = captured[side];
      const query = panel.find('data-history-compare', 'query')!; query.value = row.id; panel.querySelectorAll('[aria-label="Search snapshot comparison"]')[0]!.fire('submit');
      panel.find('data-history-compare-control', 'open-' + side + '-source-' + rowIndex)!.click(); const view = panel.find('data-history-preview', 'comparison-record')!, target = view.find('data-history-preview-record', String(position))!;
      expect(target.open).toBe(true); expect(view.find('data-history-preview-comparison-source', side)!.textContent).toContain(side === 'baseline' ? 'Original comparison report' : 'Original baseline report');
      const include = target.find('data-history-preview-control', 'include-record-context')!; Reflect.set(include, 'checked', true); include.fire('change'); target.find('data-history-preview-control', 'download-record')!.click();
      const record = JSON.parse(download.mock.calls.at(-1)![1]); expect(record.source_position).toBe(position + 1); expect(record.source_snapshot.exported_at).toBe(source.report.exported_at); expect(record.entry).toEqual(source.report.entries[position]);
      target.find('data-history-preview-control', 'return-comparison')!.focus!(); target.find('data-history-preview-control', 'return-comparison')!.click(); expect(filter.value).toBe('unchanged'); expect(query.value).toBe(row.id);
    } f.panel.dispose();
  });
  it.each(['visible row', 'filtered out', 'another page'] as const)('keeps the source inspector through a comparison view change and returns to the %s', async change => {
    const { f, panel } = await comparisonFixture(45); const old = panel.find('data-history-compare-control', 'open-baseline-source-0')!; old.click(); const view = panel.find('data-history-preview', 'comparison-record')!, target = view.find('data-history-preview-record', '0')!;
    const filter = panel.find('data-history-compare', 'filter')!;
    if (change === 'another page') panel.find('data-history-compare-control', 'next')!.click(); else { filter.value = change === 'visible row' ? 'changed' : 'unchanged'; filter.fire('change'); }
    const range = panel.find('data-history-compare', 'range')!, text = range.textContent; expect(view.find('data-history-preview-record', '0')).toBe(target); const back = target.find('data-history-preview-control', 'return-comparison')!; back.focus!(); back.click();
    expect(view.hidden).toBe(true); expect(range.textContent).toBe(text); const current = panel.find('data-history-compare-control', 'open-baseline-source-0');
    expect(f.doc.activeElement).toBe(change === 'visible row' ? current : range); expect(panel.find('data-history-compare', 'source-return')!.hidden).toBe(change === 'visible row');
    if (change !== 'visible row') expect(panel.find('data-history-compare', 'source-return')!.textContent).toContain('outside this view');
    old.click(); expect(view.hidden).toBe(true); panel.find('data-history-compare-control', 'open-baseline')!.click(); expect(panel.find('data-history-compare', 'source-return')!.hidden).toBe(true); f.panel.dispose();
  });
  it('preserves newer outside focus when a source return is activated programmatically', async () => {
    const { f, panel } = await comparisonFixture(); panel.find('data-history-compare-control', 'open-baseline-source-0')!.click(); const view = panel.find('data-history-preview', 'comparison-record')!, back = view.find('data-history-preview-control', 'return-comparison')!;
    const query = panel.find('data-history-compare', 'query')!; Reflect.set(query, 'isConnected', true); query.focus!(); back.click(); expect(f.doc.activeElement).toBe(query); expect(view.hidden).toBe(true); f.panel.dispose();
  });
  it.each(['swap', 'new report', 'new pair', 'clear baseline', 'main close', 'dispose', 'pin'] as const)('retires record-to-source navigation and clipboard replies after %s', async action => {
    const { f, panel, first, second, download } = await comparisonFixture(); let reject!: (error: Error) => void; const write = vi.fn(() => new Promise<void>((_, no) => { reject = no; })); copyBrowser(f, { clipboard: { writeText: write } });
    const open = panel.find('data-history-compare-control', 'open-baseline-source-0')!; open.click(); const view = panel.find('data-history-preview', 'comparison-record')!, target = view.find('data-history-preview-record', '1')!;
    const back = target.find('data-history-preview-control', 'return-comparison')!, save = view.find('data-history-preview-control', 'download')!, copy = target.find('data-history-preview-control', 'copy-record')!, status = target.find('data-history-preview-copy', 'record-status')!; copy.focus!(); copy.click();
    if (action === 'swap') panel.find('data-history-compare-control', 'swap')!.click(); else if (action === 'new report') submitPastedHistory(f, comparisonJson(second)); else if (action === 'new pair') submitPastedHistory(f, comparisonPair(second, first).json);
    else if (action === 'clear baseline') panel.find('data-history-compare-control', 'clear')!.click(); else if (action === 'main close') f.host.find('data-history-preview', 'file')!.find('data-history-preview-control', 'close')!.click(); else if (action === 'pin') panel.find('data-history-compare-control', 'baseline')!.click(); else f.panel.dispose();
    const focus = f.doc.activeElement; reject(Error('private-retired-jump-copy')); await settleCopy(); open.click(); back.click(); save.click(); copy.click(); expect(view.hidden).toBe(true); expect(f.doc.activeElement).toBe(focus); expect(status.textContent).toBe('Copying record JSON…'); expect(write).toHaveBeenCalledOnce(); expect(download).not.toHaveBeenCalled(); f.panel.dispose();
  });
  it('replaces source search with an exact record jump and retires its return when single-record inspection opens', async () => {
    const { f, panel, first } = await comparisonFixture(45); panel.find('data-history-compare-control', 'open-baseline')!.click(); const view = panel.find('data-history-preview', 'comparison-record')!;
    view.find('data-history-preview-search', 'query')!.value = first.entries[44]!.record.id; view.find('data-history-preview-search', 'form')!.fire('submit');
    panel.find('data-history-compare-control', 'open-baseline-source-0')!.click(); expect(view.find('data-history-preview-search', 'query')!.value).toBe(''); expect(view.find('data-history-preview-record', '0')!.open).toBe(true);
    const back = view.find('data-history-preview-control', 'return-comparison')!; panel.find('data-history-compare-control', 'inspect-baseline-0')!.click(); expect(view.getAttribute('data-history-preview-layout')).toBe('record'); back.click(); expect(view.hidden).toBe(false);
    expect(view.find('data-history-preview-source-record', 'true')).toBeUndefined(); expect(view.find('data-history-preview-control', 'return-comparison')).toBeUndefined(); f.panel.dispose();
  });
  it('allows a captured record jump during a replacement read, preserves it on refusal and retires it on success', async () => {
    const { f, panel, second } = await comparisonFixture(); let release!: (text: string) => void; chooseHistoryFile(f, () => new Promise(resolve => { release = resolve; }));
    const open = panel.find('data-history-compare-control', 'open-baseline-source-0')!; expect(open.disabled).toBe(false); open.click(); const view = panel.find('data-history-preview', 'comparison-record')!, target = view.find('data-history-preview-record', '1')!;
    release('{invalid-jump-file'); await f.panel.whenLoaded(); expect(view.find('data-history-preview-record', '1')).toBe(target); chooseHistoryFile(f, () => new Promise(resolve => { release = resolve; })); release(comparisonJson(second)); await f.panel.whenLoaded(); open.click(); expect(view.hidden).toBe(true); f.panel.dispose();
  });
  it.each([-1, 0.5, 45, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid full-source record position %s before replacing an existing preview', async recordIndex => {
    const f = mount(); await f.panel.whenLoaded(); const view = createAuthenticationHistoryPreview({ document: f.doc as unknown as Document }); f.host.appendChild(view.element as unknown as Element);
    const source = prepareAuthenticationHistoryDownload(historyExport({ kind: 'all' }, 45), { scope: { kind: 'all' } }, 'full'); view.show(source, { source: 'comparison', side: 'baseline', label: 'Baseline' }); const element = view.element as unknown as Element, before = element.text();
    expect(() => view.show(source, { source: 'comparison', side: 'baseline', label: 'Baseline', recordIndex })).toThrow('included in this source report'); expect(element.text()).toBe(before); expect(view.hasSnapshot()).toBe(true); view.dispose(); f.panel.dispose();
  });
  it.each(['redirect', 'replace'] as const)('respects a newer focus or source choice made while a target summary focuses: %s', async action => {
    const { f, panel, second } = await comparisonFixture(); const nativeCreate = f.doc.createElement, outside = panel.find('data-history-compare', 'query')!, scrolls = vi.fn();
    f.doc.createElement = () => {
      const element = nativeCreate(), nativeFocus = element.focus!; element.focus = () => { nativeFocus(); if (element.getAttribute('aria-describedby')?.endsWith('-source-record')) {
        Reflect.set(element, 'scrollIntoView', scrolls);
        if (action === 'redirect') outside.focus!(); else submitPastedHistory(f, comparisonJson(second));
      } }; return element;
    };
    panel.find('data-history-compare-control', 'open-baseline-source-0')!.click(); const view = panel.find('data-history-preview', 'comparison-record')!;
    expect(scrolls).not.toHaveBeenCalled(); if (action === 'redirect') { expect(f.doc.activeElement).toBe(outside); expect(view.hidden).toBe(false); } else { expect(view.hidden).toBe(true); expect(panel.find('data-history-compare', 'results')!.hidden).toBe(true); }
    f.panel.dispose();
  });

  const sourceReferenceFixture = async () => {
    const first = singleRecordFixture(); const target = first.entries.find(entry => entry.type === 'verification' && 'selection' in entry.record && entry.record.selection.kind === 'repair')!;
    const origin = first.entries.find(entry => entry.type === 'verification' && 'selection' in entry.record && entry.record.selection.kind === 'verification')!;
    first.entries = first.entries.filter(entry => entry !== origin && entry !== target); first.entries.splice(31, 0, target); first.entries.splice(38, 0, origin);
    const second = structuredClone(first); second.exported_at = 400; for (const entry of second.entries) if (entry.type === 'verification' && 'results' in entry.record) for (const result of entry.record.results) result.label += ' comparison';
    const download = vi.fn(); const f = mount(undefined, page().scope, { download }); await f.panel.whenLoaded(); submitPastedHistory(f, comparisonPair(first, second).json);
    const panel = f.host.find('data-history-compare', 'panel')!, open = panel.find('data-history-compare-control', 'open-baseline-source-38')!; open.click(); const view = panel.find('data-history-preview', 'comparison-record')!;
    return { f, panel, view, first, second, origin, target, open, download };
  };
  it('follows a reference from the full source without losing source position, complete download or comparison return', async () => {
    const { f, panel, view, first, origin, target, open, download } = await sourceReferenceFixture(); const range = panel.find('data-history-compare', 'range')!.textContent;
    const sourceQuery = view.find('data-history-preview-search', 'query')!; sourceQuery.value = origin.record.id; view.find('data-history-preview-search', 'form')!.fire('submit');
    const source = view.find('data-history-preview-record', '38')!; source.open = true; source.fire('toggle'); const oldBack = source.find('data-history-preview-control', 'return-comparison')!; source.find('data-history-preview-control', 'reference')!.click();
    const record = view.find('data-history-preview-record', '31')!; expect(record.open).toBe(true); expect(f.doc.activeElement).toBe(record.children[0]); expect(sourceQuery.value).toBe(''); expect(panel.find('data-history-compare', 'range')!.textContent).toBe(range);
    contextChoice(record, true); record.find('data-history-preview-control', 'download-record')!.click(); const saved = JSON.parse(download.mock.calls[0]![1]); expect(saved.entry).toEqual(JSON.parse(comparisonJson(first)).entries[31]); expect(saved.entry.record.id).toBe(target.record.id); expect(saved.source_position).toBe(32); expect(saved.source_snapshot.entry_count).toBe(first.entry_count);
    view.find('data-history-preview-control', 'download')!.click(); expect(JSON.parse(download.mock.calls[1]![1])).toEqual(JSON.parse(comparisonJson(first))); oldBack.click(); expect(view.hidden).toBe(false);
    const close = view.find('data-history-preview-control', 'close')!; close.focus!(); close.click(); expect(f.doc.activeElement).toBe(open); expect(panel.find('data-history-compare', 'range')!.textContent).toBe(range); f.panel.dispose();
  });
  it.each(['redirect', 'replace'] as const)('retires reference rendering when a destination focus handler chooses to %s', async action => {
    const { f, panel, view, second, target } = await sourceReferenceFixture(); const create = f.doc.createElement, query = panel.find('data-history-compare', 'query')!, retiredScroll = vi.fn();
    f.doc.createElement = () => {
      const element = create(), nativeFocus = element.focus!; element.focus = () => { nativeFocus(); if (element.textContent.includes(target.record.id)) {
        Reflect.set(element, 'scrollIntoView', retiredScroll); if (action === 'redirect') query.focus!(); else submitPastedHistory(f, comparisonJson(second));
      } }; return element;
    };
    const reference = view.find('data-history-preview-record', '38')!.find('data-history-preview-control', 'reference')!; expect(() => reference.click()).not.toThrow(); expect(retiredScroll).not.toHaveBeenCalled();
    if (action === 'redirect') { expect(f.doc.activeElement).toBe(query); expect(view.find('data-history-preview-record', '31')!.open).toBe(true); }
    else { expect(view.hidden).toBe(true); expect(view.children).toHaveLength(0); expect(panel.find('data-history-compare', 'results')!.hidden).toBe(true); expect(f.host.find('data-history-preview', 'file')!.hidden).toBe(false); }
    reference.click(); f.panel.dispose();
  });
  it('clears a previous out-of-view return notice when a different comparison record is inspected', async () => {
    const { f, panel } = await comparisonFixture(45); panel.find('data-history-compare-control', 'open-baseline-source-0')!.click(); const view = panel.find('data-history-preview', 'comparison-record')!;
    panel.find('data-history-compare-control', 'next')!.click(); const close = view.find('data-history-preview-control', 'close')!; close.focus!(); close.click(); const notice = panel.find('data-history-compare', 'source-return')!; expect(notice.hidden).toBe(false);
    const inspect = panel.find('data-history-compare-control', 'inspect-baseline-20')!; inspect.click(); expect(view.getAttribute('data-history-preview-layout')).toBe('record'); expect(notice.hidden).toBe(true);
    view.find('data-history-preview-control', 'close')!.focus!(); view.find('data-history-preview-control', 'close')!.click(); expect(f.doc.activeElement).toBe(inspect); f.panel.dispose();
  });

  const trailRecord = (view: Element, index: number): Element => {
    const record = view.find('data-history-preview-record', String(index))!; record.open = true; record.fire('toggle'); return record;
  };
  const trailFollow = (view: Element, index: number): void => { trailRecord(view, index).find('data-history-preview-control', 'reference')!.click(); };
  const trailBack = (view: Element): void => { const back = view.find('data-history-preview-control', 'previous-record')!; back.focus!(); back.click(); };
  const trailForward = (view: Element, key = 'next-record'): void => { const forward = view.find('data-history-preview-control', key)!; forward.focus!(); forward.click(); };
  const reportFilterFixture = async (mode: 'full' | 'aliases' = 'full', source: 'export' | 'file' | 'paste' = 'export', transform?: (value: AuthenticationHistoryExport) => void) => {
    const value = singleRecordFixture(), failed = structuredClone(value.entries[46]!.record); if (!('selection' in failed)) throw Error('Expected access check');
    failed.id = 'verify-32345678-1234-4123-8123-123456789abc'; failed.results[0]!.checks = [{ kind: 'api_read', status: 'failed', reason: 'access_rejected' }];
    value.entries.push({ type: 'verification', outcome: 'failed', record: failed }); value.entry_count++; transform?.(value);
    const captured = prepareAuthenticationHistoryDownload(value, { scope: value.scope }, mode), download = vi.fn(), call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page(value.scope)), exportHistory = vi.fn<AuthenticationHistoryExportCaller>().mockResolvedValue(value);
    const f = mount(call, value.scope, { exportHistory, download }); await f.panel.whenLoaded();
    if (source === 'file') { chooseHistoryFile(f, async () => captured.json); await f.panel.whenLoaded(); } else if (source === 'paste') submitPastedHistory(f, captured.json);
    else { const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = mode; privacy.fire('change'); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); }
    const view = f.host.find('data-history-preview', source === 'export' ? 'report' : 'file')!; return { f, view, value, captured, download, call, exportHistory };
  };
  const reportFilter = (view: Element, key: 'type' | 'outcome', value: string): Element => { const control = view.find('data-history-preview-filter', key)!; control.value = value; control.focus!(); control.fire('change'); return control; };
  const reportSearch = (view: Element, text: string): void => { const query = view.find('data-history-preview-search', 'query')!; query.value = text; query.fire('input'); view.find('data-history-preview-search', 'form')!.fire('submit'); };
  const reportRange = (view: Element): string => view.find('data-history-preview-range', 'records')!.textContent;
  const moveHistoryRecord = (entry: AuthenticationHistoryExport['entries'][number], started: string): void => {
    const delta = Date.parse(started) - entry.record.started_at;
    entry.record = JSON.parse(JSON.stringify(entry.record, (key, value: unknown) => typeof value === 'number' && (key === 'at' || key.endsWith('_at')) ? value + delta : value)) as typeof entry.record;
  };
  const reportDateFixture = (mode: 'full' | 'aliases' = 'full', source: 'export' | 'file' | 'paste' = 'paste', transform?: (value: AuthenticationHistoryExport) => void) => reportFilterFixture(mode, source, value => {
    value.exported_at = Date.parse('2026-03-12T12:00:00Z');
    value.entries.forEach((entry, index) => moveHistoryRecord(entry, index < 45 ? ['2026-03-07T23:59:59.999Z', '2026-03-08T00:00:00Z', '2026-03-08T23:59:59.999Z'][index % 3]!
      : ['2026-03-07T12:00:00Z', '2026-03-08T12:00:00Z', '2026-03-09T00:00:00Z', '2026-03-08T18:00:00Z', '2026-03-08T20:00:00Z'][index - 45]!)); transform?.(value);
  });
  const draftReportDates = (view: Element, from: string, through: string): void => {
    for (const [key, value] of [['from', from], ['through', through]]) { const input = view.find('data-history-preview-date', key!)!; input.value = value!; input.fire('input'); }
  };
  const reportDates = (view: Element, from: string, through: string): void => { draftReportDates(view, from, through); view.find('data-history-preview-date', 'form')!.fire('submit'); };
  const reportIndices = (view: Element): number[] => view.querySelectorAll('[data-history-preview-record]').map(row => Number(row.getAttribute('data-history-preview-record')));
  for (const mode of ['aliases', 'full'] as const) it.each(['export', 'file', 'paste'] as const)('filters inclusive UTC dates in a ' + mode + ' %s report without changing source metadata or download bytes', async source => {
    const { f, view, captured, download, call, exportHistory } = await reportDateFixture(mode, source); reportDates(view, '2026-03-08', '2026-03-08');
    expect(reportRange(view)).toBe('Matching records 1–20 of 33 (50 in snapshot).'); expect(reportIndices(view)).toEqual(Array.from({ length: 30 }, (_, i) => i).filter(i => i % 3 !== 0));
    view.find('data-history-preview-control', 'next')!.click(); expect(reportRange(view)).toBe('Matching records 21–33 of 33 (50 in snapshot).'); expect(reportIndices(view)).toEqual([31, 32, 34, 35, 37, 38, 40, 41, 43, 44, 46, 48, 49]);
    const last = trailRecord(view, 49); contextChoice(last, true); last.find('data-history-preview-control', 'download-record')!.click(); const saved = JSON.parse(download.mock.calls.at(-1)![1] as string);
    expect(saved.source_position).toBe(50); expect(saved.source_snapshot.filters).toEqual(captured.report.filters); expect(saved.source_snapshot.entry_count).toBe(50);
    view.find('data-history-preview-control', 'download')!.click(); expect(download.mock.calls.at(-1)![1]).toBe(captured.json); expect(call).toHaveBeenCalledOnce(); expect(exportHistory).toHaveBeenCalledTimes(source === 'export' ? 1 : 0);
    expect(view.find('data-history-preview-search', 'applied')!.textContent).toContain('Started through (UTC, inclusive): 2026-03-08.'); f.panel.dispose();
  });
  it.each([
    ['', '2026-03-07', 16], ['2026-03-08', '', 34], ['2026-03-09', '2026-03-09', 1], ['2026-03-10', '2026-03-10', 0], ['', '', 50],
  ] as const)('supports UTC range from %s through %s with no local-time or snapshot-date inference', async (from, through, count) => {
    const { f, view } = await reportDateFixture(); reportDates(view, from, through); expect(reportIndices(view)).toHaveLength(Math.min(count, 20));
    if (count === 50) expect(reportRange(view)).toBe('Records 1–20 of 50'); else if (!count) expect(reportRange(view)).toContain('No records match these preview filters.'); else expect(reportRange(view)).toContain('of ' + count + ' (50 in snapshot)');
    f.panel.dispose();
  });
  it('combines applied dates with type, outcome and explicit text, while each reset keeps the other criteria', async () => {
    const { f, view, captured } = await reportDateFixture(); reportDates(view, '2026-03-08', '2026-03-08'); reportFilter(view, 'type', 'verification'); reportFilter(view, 'outcome', 'failed'); reportSearch(view, captured.report.entries[49]!.record.id);
    expect(reportIndices(view)).toEqual([49]); const query = view.find('data-history-preview-search', 'query')!; query.value = 'x'.repeat(129); query.setSelectionRange(2, 7); view.find('data-history-preview-search', 'form')!.fire('submit');
    draftReportDates(view, '2026-03-09', '2026-03-07'); view.find('data-history-preview-date', 'form')!.fire('submit'); expect(reportIndices(view)).toEqual([49]);
    view.find('data-history-preview-control', 'filter-clear')!.click(); expect(reportIndices(view)).toEqual([49]); expect(query.getAttribute('aria-invalid')).toBe('true'); expect(view.find('data-history-preview-date', 'error')!.hidden).toBe(false);
    view.find('data-history-preview-control', 'date-clear')!.click(); expect(reportIndices(view)).toEqual([49]); expect(query.value).toHaveLength(129); expect([query.selectionStart, query.selectionEnd]).toEqual([2, 7]); expect(query.getAttribute('aria-invalid')).toBe('true');
    view.find('data-history-preview-control', 'search-clear')!.click(); expect(reportRange(view)).toBe('Records 1–20 of 50'); expect(view.find('data-history-preview-search', 'applied')!.hidden).toBe(true); f.panel.dispose();
  });
  it.each(['reversed', 'incomplete native date', '2026-02-29', '2026-13-01', '2026-04-31', '26-03-08', '2026-3-08', '2026-03-08T00:00:00Z', '10000-01-01', '__proto__'] as const)('keeps earlier results for invalid local dates: %s', async invalid => {
    const { f, view } = await reportDateFixture(); reportDates(view, '2026-03-08', '2026-03-08'); const old = view.find('data-history-preview-record', '1');
    draftReportDates(view, invalid === 'reversed' ? '2026-03-09' : invalid === 'incomplete native date' ? '' : invalid, '2026-03-08'); const from = view.find('data-history-preview-date', 'from')!;
    if (invalid === 'incomplete native date') Reflect.set(from, 'validity', { valid: false, badInput: true });
    view.find('data-history-preview-date', 'form')!.fire('submit'); expect(view.find('data-history-preview-record', '1')).toBe(old); expect(reportRange(view)).toContain('of 33 (50 in snapshot)'); expect(from.getAttribute('aria-invalid')).toBe('true');
    const error = view.find('data-history-preview-date', 'error')!; expect(error.hidden).toBe(false); expect(error.textContent).not.toContain(invalid); expect(view.find('data-history-preview-search', 'applied')!.textContent).toContain('Started from (UTC, inclusive): 2026-03-08.');
    from.fire('input'); expect(error.hidden).toBe(true); expect(reportRange(view)).toContain('of 33 (50 in snapshot)'); f.panel.dispose();
  });
  it('accepts a real leap day and uses original start rather than finish, history-recording or export dates', async () => {
    const { f, view } = await reportDateFixture('full', 'paste', value => { moveHistoryRecord(value.entries[0]!, '2024-02-29T23:59:59.999Z'); value.entries[0]!.record.started_at = Date.parse('2024-02-29T23:59:59.999Z'); });
    reportDates(view, '2024-02-29', '2024-02-29'); expect(reportIndices(view)).toEqual([0]); reportDates(view, '2026-03-12', '2026-03-12'); expect(reportIndices(view)).toEqual([]); f.panel.dispose();
  });
  it('keeps date edits unapplied and separate from text submission, with accessible names and date error references', async () => {
    const { f, view } = await reportDateFixture(); reportSearch(view, 'Record or reference ID'); draftReportDates(view, '2026-03-08', '2026-03-08'); expect(reportRange(view)).toContain('of 50 (50 in snapshot)');
    const query = view.find('data-history-preview-search', 'query')!; query.value = 'unfinished text'; view.find('data-history-preview-date', 'form')!.fire('submit'); expect(reportRange(view)).toContain('of 33 (50 in snapshot)'); expect(query.value).toBe('unfinished text');
    for (const key of ['from', 'through']) { const input = view.find('data-history-preview-date', key)!; expect(input.type).toBe('date'); expect(input.getAttribute('aria-label')).toContain('UTC'); expect(input.getAttribute('aria-describedby')!.split(' ')).toHaveLength(4); }
    draftReportDates(view, '2026-03-09', '2026-03-09'); reportSearch(view, 'Record or reference ID'); expect(reportRange(view)).toContain('of 33 (50 in snapshot)'); view.find('data-history-preview-date', 'form')!.fire('submit'); expect(reportIndices(view)).toEqual([47]); f.panel.dispose();
  });
  it('preserves open details on unchanged date apply or empty reset and starts at the first page when the applied range changes', async () => {
    const { f, view } = await reportDateFixture(); const open = trailRecord(view, 0); view.find('data-history-preview-control', 'date-clear')!.click(); reportDates(view, '', ''); expect(view.find('data-history-preview-record', '0')).toBe(open);
    view.find('data-history-preview-control', 'next')!.click(); view.find('data-history-preview-control', 'next')!.click(); reportDates(view, '2026-03-08', '2026-03-08'); expect(reportRange(view)).toContain('1–20 of 33');
    const first = trailRecord(view, 1); reportDates(view, '2026-03-08', '2026-03-08'); expect(view.find('data-history-preview-record', '1')).toBe(first); f.panel.dispose();
  });
  it.each(['from', 'through'] as const)('clears only a blocking %s boundary for a saved reference, retaining compatible criteria and restoring the complete date view', async boundary => {
    const { f, view } = await reportDateFixture('full', 'paste', value => { if (boundary === 'through') moveHistoryRecord(value.entries[46]!, '2026-03-10T12:00:00Z'); });
    reportDates(view, '2026-03-09', '2026-03-09'); reportFilter(view, 'type', 'verification'); reportFilter(view, 'outcome', 'passed'); reportSearch(view, 'Record or reference ID'); const origin = trailRecord(view, 47);
    expect(origin.text()).toContain('outside the preview filters'); draftReportDates(view, '2026-03-10', '2026-03-08'); view.find('data-history-preview-date', 'form')!.fire('submit');
    const query = view.find('data-history-preview-search', 'query')!; query.value = 'x'.repeat(129); view.find('data-history-preview-search', 'form')!.fire('submit'); trailFollow(view, 47);
    expect(view.find('data-history-preview-record', '46')!.open).toBe(true); expect(view.find('data-history-preview-filter', 'type')!.value).toBe('verification'); expect(view.find('data-history-preview-filter', 'outcome')!.value).toBe('passed'); expect(query.value).toHaveLength(129);
    const applied = view.find('data-history-preview-search', 'applied')!; expect(applied.textContent).not.toContain('Started ' + boundary + ' (UTC'); expect(applied.textContent).toContain('Started ' + (boundary === 'from' ? 'through' : 'from') + ' (UTC, inclusive): 2026-03-09.');
    expect(view.find('data-history-preview-date', 'from')!.value).toBe('2026-03-10'); expect(view.find('data-history-preview-date', 'error')!.hidden).toBe(false);
    trailBack(view); expect(reportIndices(view)).toEqual([47]); expect(view.find('data-history-preview-date', 'error')!.textContent).toContain('start date must be on or before'); expect(view.find('data-history-preview-date', 'from')!.getAttribute('aria-invalid')).toBe('true'); expect(query.getAttribute('aria-invalid')).toBe('true');
    trailForward(view); expect(view.find('data-history-preview-record', '46')!.open).toBe(true); trailBack(view); reportDates(view, '2026-03-08', '2026-03-08'); trailForward(view); trailBack(view); expect(view.find('data-history-preview-search', 'applied')!.textContent).toContain('Started from (UTC, inclusive): 2026-03-08.'); expect(f.doc.activeElement).toBe(view.find('data-history-preview-range', 'records')); f.panel.dispose();
  });
  it.each(['from', 'through'] as const)('keeps actionable recovery for an incomplete native %s date after Back and a refused Apply', async key => {
    const { f, view } = await reportDateFixture(); reportDates(view, '2026-03-08', '2026-03-08'); const input = view.find('data-history-preview-date', key)!;
    let completeValue = input.value, incomplete = false;
    Object.defineProperty(input, 'value', { get: () => completeValue, set: (value: string) => { completeValue = value; incomplete = false; } });
    Object.defineProperty(input, 'validity', { get: () => ({ valid: !incomplete, badInput: incomplete }) });
    input.value = ''; incomplete = true; input.fire('input'); view.find('data-history-preview-date', 'form')!.fire('submit'); view.find('data-history-preview-control', 'next')!.click(); trailFollow(view, 49); trailBack(view);
    expect(reportRange(view)).toContain('of 33 (50 in snapshot)'); const error = view.find('data-history-preview-date', 'error')!; expect(error.textContent).toContain('Re-enter the incomplete date or choose Clear date range.');
    view.find('data-history-preview-date', 'form')!.fire('submit'); expect(reportRange(view)).toContain('of 33 (50 in snapshot)'); expect(input.getAttribute('aria-invalid')).toBe('true'); expect(error.textContent).toContain('Re-enter the incomplete date or choose Clear date range.');
    view.find('data-history-preview-control', 'date-clear')!.click(); expect(error.hidden).toBe(true); expect(reportRange(view)).toBe('Records 1–20 of 50');
    for (const end of ['from', 'through']) { const control = view.find('data-history-preview-date', end)!; expect(control.value).toBe(''); expect(control.getAttribute('aria-invalid')).toBe('false'); }
    reportDates(view, '2026-03-08', '2026-03-08'); expect(reportRange(view)).toContain('of 33 (50 in snapshot)'); expect(error.hidden).toBe(true); f.panel.dispose();
  });
  it('updates an untouched blocking date field for a saved reference without discarding the compatible end', async () => {
    const { f, view } = await reportDateFixture(); reportDates(view, '2026-03-09', '2026-03-09'); trailFollow(view, 47); expect(view.find('data-history-preview-date', 'from')!.value).toBe(''); expect(view.find('data-history-preview-date', 'through')!.value).toBe('2026-03-09');
    trailBack(view); expect(view.find('data-history-preview-date', 'from')!.value).toBe('2026-03-09'); f.panel.dispose();
  });
  it.each(['normal', 'outside focus', 'new date'] as const)('keeps date reset focus and scrolling owned during cleanup: %s', async action => {
    const { f, view } = await reportDateFixture(); reportDates(view, '2026-03-09', '2026-03-09'); const copy = trailRecord(view, 47).find('data-history-preview-control', 'copy-record')!, reset = view.find('data-history-preview-control', 'date-clear')!, range = view.find('data-history-preview-range', 'records')!, outside = f.host.find('data-history-export-mode', 'privacy')!, scroll = vi.fn(); Object.assign(range, { scrollIntoView: scroll });
    copy.focus!(); reset.fire('pointerdown'); f.doc.activeElement = f.doc.body; let changed = false; const focus = range.focus!;
    if (action === 'new date') range.focus = options => { focus(options); if (!changed) { changed = true; reportDates(view, '2026-03-08', '2026-03-08'); } };
    if (action === 'outside focus') outside.focus!(); reset.fire('click', 1);
    if (action === 'normal') { expect(f.doc.activeElement).toBe(range); expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: 'nearest' }); expect(reportRange(view)).toBe('Records 1–20 of 50'); }
    else { expect(scroll).not.toHaveBeenCalled(); if (action === 'outside focus') expect(f.doc.activeElement).toBe(outside); else expect(reportRange(view)).toContain('of 33 (50 in snapshot)'); } f.panel.dispose();
  });
  it.each(['refresh', 'replacement', 'close', 'dispose'] as const)('keeps date state on refresh and retires old date handlers on %s', async action => {
    const { f, view, captured, call } = await reportDateFixture(); reportDates(view, '2026-03-08', '2026-03-08'); draftReportDates(view, '2026-03-10', '2026-03-08'); view.find('data-history-preview-date', 'form')!.fire('submit');
    const form = view.find('data-history-preview-date', 'form')!, reset = view.find('data-history-preview-control', 'date-clear')!, input = view.find('data-history-preview-date', 'from')!, oldRange = view.find('data-history-preview-range', 'records')!, before = oldRange.textContent;
    if (action === 'refresh') { f.host.find('data-incident-action', 'refresh')!.click(); await f.panel.whenLoaded(); expect(oldRange.textContent).toBe(before); expect(input.value).toBe('2026-03-10'); expect(view.find('data-history-preview-date', 'error')!.hidden).toBe(false); expect(call).toHaveBeenCalledTimes(2); }
    else { if (action === 'replacement') submitPastedHistory(f, captured.json); else if (action === 'close') view.find('data-history-preview-control', 'close')!.click(); else f.panel.dispose(); const focus = f.doc.activeElement; input.value = ''; input.fire('input'); form.fire('submit'); reset.click(); expect(oldRange.textContent).toBe(before); expect(f.doc.activeElement).toBe(focus); if (action === 'replacement') expect(view.find('data-history-preview-date', 'from')!.value).toBe(''); }
    f.panel.dispose();
  });
  it('keeps related bundle membership and its own filters independent of report dates', async () => {
    const { f, view, captured, download } = await reportDateFixture(); reportDates(view, '2026-03-08', '2026-03-08'); reportSearch(view, captured.report.entries[40]!.record.id); const related = openRelated(f, 40); const browser = related.find('data-history-preview-related', 'records')!; browser.open = true; browser.fire('toggle');
    expect(browser.find('data-history-preview-related-filter', 'type')!.value).toBe(''); related.find('data-history-preview-control', 'download-related')!.click(); expect(download.mock.calls.at(-1)![1]).toBe(prepareAuthenticationHistoryRelatedDownload(createAuthenticationHistoryRelatedBundles(captured)(40)).json); f.panel.dispose();
  });
  for (const mode of ['aliases', 'full'] as const) it.each(['export', 'file', 'paste'] as const)('filters a ' + mode + ' %s report while preserving original source positions and exact complete downloads', async source => {
    const { f, view, captured, download, call, exportHistory } = await reportFilterFixture(mode, source); const type = reportFilter(view, 'type', 'verification'); reportFilter(view, 'outcome', 'failed');
    expect(reportRange(view)).toBe('Matching records 1–1 of 1 (50 in snapshot).'); expect(view.querySelectorAll('[data-history-preview-record]').map(row => row.getAttribute('data-history-preview-record'))).toEqual(['49']);
    const row = trailRecord(view, 49); contextChoice(row, true); row.find('data-history-preview-control', 'download-record')!.click(); expect(JSON.parse(download.mock.calls[0]![1])).toMatchObject({ entry: captured.report.entries[49], source_position: 50, source_snapshot: { entry_count: 50 } });
    view.find('data-history-preview-control', 'download')!.click(); expect(download.mock.calls[1]![1]).toBe(captured.json); expect(type.getAttribute('aria-describedby')!.split(' ')).toHaveLength(4); expect(view.find('data-history-preview-search', 'form')!.contains(type)).toBe(false);
    expect(call).toHaveBeenCalledOnce(); expect(exportHistory).toHaveBeenCalledTimes(source === 'export' ? 1 : 0); f.panel.dispose();
  });
  it('combines report type, outcome and applied text, keeps stable choices and clears text and filters independently', async () => {
    const { f, view, captured } = await reportFilterFixture(); const type = view.find('data-history-preview-filter', 'type')!, outcome = view.find('data-history-preview-filter', 'outcome')!;
    expect(type.children.map(option => option.value)).toEqual(['', 'incident', 'repair', 'verification', 'renewal']); expect(outcome.children.map(option => option.value)).toEqual(['', 'retired', 'applied', 'failed', 'passed', 'unconfirmed']);
    reportSearch(view, captured.report.entries[49]!.record.id); reportFilter(view, 'type', 'verification'); reportFilter(view, 'outcome', 'failed'); expect(reportRange(view)).toContain('1–1 of 1'); reportFilter(view, 'type', 'repair');
    expect(reportRange(view)).toContain('No records match this preview search and these filters.'); expect(outcome.value).toBe('failed'); view.find('data-history-preview-control', 'search-clear')!.click(); expect(type.value).toBe('repair'); expect(outcome.value).toBe('failed'); expect(reportRange(view)).toContain('No records match these preview filters.');
    view.find('data-history-preview-control', 'filter-clear')!.click(); expect(reportRange(view)).toBe('Records 1–20 of 50'); expect(view.find('data-history-preview-search', 'applied')!.hidden).toBe(true); expect(type.children.map(option => option.value)).toEqual(['', 'incident', 'repair', 'verification', 'renewal']); f.panel.dispose();
  });
  it.each(['valid', 'invalid'] as const)('keeps the %s unfinished query, caret and validation while applying and clearing report filters', async state => {
    const { f, view } = await reportFilterFixture(); reportSearch(view, 'Access check'); const query = view.find('data-history-preview-search', 'query')!; query.value = state === 'valid' ? 'unsubmitted draft' : 'x'.repeat(129); query.setSelectionRange(2, 7); query.fire('input'); if (state === 'invalid') view.find('data-history-preview-search', 'form')!.fire('submit');
    reportFilter(view, 'type', 'verification'); const outcome = reportFilter(view, 'outcome', 'failed'); expect(reportRange(view)).toContain('1–1 of 1'); expect(f.doc.activeElement).toBe(outcome); expect(view.find('data-history-preview-search', 'applied')!.textContent).toBe('Applied preview search: “Access check”. Record type: Access check. Recorded outcome: Failed.');
    const reset = view.find('data-history-preview-control', 'filter-clear')!; reset.focus!(); reset.click(); expect(f.doc.activeElement).toBe(reset); expect(reportRange(view)).toContain('1–3 of 3'); expect(query.value).toBe(state === 'valid' ? 'unsubmitted draft' : 'x'.repeat(129)); expect(query.getAttribute('aria-invalid')).toBe(state === 'valid' ? 'false' : 'true'); expect([query.selectionStart, query.selectionEnd]).toEqual([2, 7]); f.panel.dispose();
  });
  it('pages filtered report records in saved order and resets to the first matching page when criteria change', async () => {
    const { f, view } = await reportFilterFixture(); view.find('data-history-preview-control', 'next')!.click(); view.find('data-history-preview-control', 'next')!.click(); reportFilter(view, 'type', 'incident'); expect(reportRange(view)).toBe('Matching records 1–20 of 45 (50 in snapshot).');
    const next = view.find('data-history-preview-control', 'next')!; next.focus!(); next.click(); next.click(); expect(reportRange(view)).toBe('Matching records 41–45 of 45 (50 in snapshot).'); expect(f.doc.activeElement).toBe(view.find('data-history-preview-range', 'records')); expect(view.querySelectorAll('[data-history-preview-record]').map(row => row.getAttribute('data-history-preview-record'))).toEqual(['40', '41', '42', '43', '44']);
    reportFilter(view, 'outcome', 'failed'); expect(reportRange(view)).toContain('No records match these preview filters.'); reportFilter(view, 'outcome', 'retired'); expect(reportRange(view)).toContain('1–20 of 45'); f.panel.dispose();
  });
  it.each(['normal', 'outside focus', 'new filter'] as const)('keeps pointer reset focus owned during report cleanup: %s', async action => {
    const { f, view } = await reportFilterFixture(); reportFilter(view, 'type', 'verification'); reportFilter(view, 'outcome', 'failed'); const record = trailRecord(view, 49), copy = record.find('data-history-preview-control', 'copy-record')!;
    const reset = view.find('data-history-preview-control', 'filter-clear')!, range = view.find('data-history-preview-range', 'records')!, outside = f.host.find('data-history-export-mode', 'privacy')!, scroll = vi.fn(); Object.assign(range, { scrollIntoView: scroll });
    copy.focus!(); reset.fire('pointerdown'); f.doc.activeElement = f.doc.body;
    let changed = false; const focus = range.focus!; if (action === 'new filter') range.focus = options => { focus(options); if (!changed) { changed = true; reportFilter(view, 'type', 'verification'); reportFilter(view, 'outcome', 'passed'); } };
    if (action === 'outside focus') outside.focus!(); reset.fire('click', 1);
    if (action === 'normal') { expect(f.doc.activeElement).toBe(range); expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: 'nearest' }); expect(reportRange(view)).toBe('Records 1–20 of 50'); }
    else if (action === 'outside focus') { expect(f.doc.activeElement).toBe(outside); expect(scroll).not.toHaveBeenCalled(); }
    else { expect(changed).toBe(true); expect(f.doc.activeElement).toBe(view.find('data-history-preview-filter', 'outcome')); expect(scroll).not.toHaveBeenCalled(); expect(reportRange(view)).toBe('Matching records 1–2 of 2 (50 in snapshot).'); }
    f.panel.dispose();
  });
  it.each(['type', 'outcome'] as const)('preserves the compatible %s choice when a saved reference clears only the other filter', async compatible => {
    const { f, value } = await reportFilterFixture();
    if (compatible === 'type') { const target = value.entries[46]!.record; if (!('selection' in target)) throw Error('Expected access check'); target.results = structuredClone(target.results); target.results[0]!.checks = [{ kind: 'api_read', status: 'failed', reason: 'access_rejected' }]; value.entries[46]!.outcome = 'failed'; }
    else { const target = value.entries[45]!.record; if (!('incidents' in target)) throw Error('Expected repair'); target.status = 'failed'; target.reason = 'interrupted'; value.entries[45]!.outcome = 'failed'; }
    submitPastedHistory(f, prepareAuthenticationHistoryDownload(value, { scope: value.scope }, 'full').json); const view = f.host.find('data-history-preview', 'file')!; reportSearch(view, 'Record or reference ID'); reportFilter(view, 'type', 'verification'); reportFilter(view, 'outcome', compatible === 'type' ? 'passed' : 'failed');
    const input = view.find('data-history-preview-search', 'query')!; input.value = 'x'.repeat(129); view.find('data-history-preview-search', 'form')!.fire('submit'); trailFollow(view, compatible === 'type' ? 47 : 49);
    const target = compatible === 'type' ? 46 : 45; expect(view.find('data-history-preview-record', String(target))!.open).toBe(true); expect(view.find('data-history-preview-filter', 'type')!.value).toBe(compatible === 'type' ? 'verification' : ''); expect(view.find('data-history-preview-filter', 'outcome')!.value).toBe(compatible === 'type' ? '' : 'failed'); expect(input.value).toHaveLength(129); expect(input.getAttribute('aria-invalid')).toBe('true');
    trailBack(view); expect(view.find('data-history-preview-filter', 'type')!.value).toBe('verification'); expect(view.find('data-history-preview-filter', 'outcome')!.value).toBe(compatible === 'type' ? 'passed' : 'failed'); trailForward(view); expect(view.find('data-history-preview-record', String(target))!.open).toBe(true); f.panel.dispose();
  });
  it.each(['aliases', 'full'] as const)('builds a complete related bundle from a %s report despite parent filters and keeps child choices independent', async mode => {
    const { f, view, captured, download } = await reportFilterFixture(mode); reportFilter(view, 'type', 'incident'); reportFilter(view, 'outcome', 'retired'); reportSearch(view, captured.report.entries[40]!.record.id);
    const related = openRelated(f, 40), expected = prepareAuthenticationHistoryRelatedDownload(createAuthenticationHistoryRelatedBundles(captured)(40)); related.find('data-history-preview-control', 'download-related')!.click(); expect(download).toHaveBeenLastCalledWith(expected.filename, expected.json);
    const child = related.find('data-history-preview-related', 'records')!; child.open = true; child.fire('toggle'); expect(child.find('data-history-preview-related-filter', 'type')!.value).toBe(''); filterRelated(child, 'type', 'verification'); expect(view.find('data-history-preview-filter', 'type')!.value).toBe('incident'); expect(reportRange(view)).toContain('1–1 of 1'); expect(child.find('data-history-preview-related', 'record-range')!.textContent).toContain('1–3 of 3'); f.panel.dispose();
  });
  it('keeps captured export and opened report filters independent through live history refresh', async () => {
    const { f, view, captured } = await reportFilterFixture(); reportFilter(view, 'type', 'verification'); reportFilter(view, 'outcome', 'failed'); submitPastedHistory(f, captured.json); const file = f.host.find('data-history-preview', 'file')!; reportFilter(file, 'type', 'incident');
    await f.panel.refresh(); expect(reportRange(view)).toContain('1–1 of 1'); expect(reportRange(file)).toContain('1–20 of 45'); expect(view.find('data-history-preview-filter', 'outcome')!.value).toBe('failed'); expect(file.find('data-history-preview-filter', 'outcome')!.value).toBe(''); f.panel.dispose();
  });
  it.each(['type', 'outcome'] as const)('rejects unknown report %s choices without changing results or exposing supplied text', async key => {
    const { f, view } = await reportFilterFixture(); reportFilter(view, 'type', 'verification'); reportFilter(view, 'outcome', 'failed'); const before = reportRange(view), control = reportFilter(view, key, '__proto__'); expect(reportRange(view)).toBe(before); expect(control.value).toBe(key === 'type' ? 'verification' : 'failed'); const error = view.find('data-history-preview-filter', 'error')!; expect(error.hidden).toBe(false); expect(error.textContent).not.toContain('__proto__'); reportFilter(view, key, key === 'type' ? 'verification' : 'failed'); expect(error.hidden).toBe(true); f.panel.dispose();
  });
  it.each(['resolve', 'reject'] as const)('retires filtered report row controls and pending clipboard feedback on %s', async result => {
    const { f, view, download } = await reportFilterFixture(); reportFilter(view, 'type', 'verification'); reportFilter(view, 'outcome', 'failed'); const row = trailRecord(view, 49); let resolve!: () => void, reject!: (error: Error) => void; const write = vi.fn(() => new Promise<void>((done, fail) => { resolve = done; reject = fail; })); copyBrowser(f, { clipboard: { writeText: write } });
    const copy = row.find('data-history-preview-control', 'copy-record')!, save = row.find('data-history-preview-control', 'download-record')!, status = row.find('data-history-preview-copy', 'record-status')!; copy.click(); const before = status.textContent, selected = reportFilter(view, 'outcome', 'passed'); copy.click(); save.click(); if (result === 'resolve') resolve(); else reject(Error('private-discarded-row')); await settleCopy();
    expect(status.textContent).toBe(before); expect(write).toHaveBeenCalledOnce(); expect(download).not.toHaveBeenCalled(); expect(f.doc.activeElement).toBe(selected); expect(reportRange(view)).toContain('1–2 of 2'); f.panel.dispose();
  });
  it.each(['privacy', 'new export', 'close', 'dispose'] as const)('retires report filter handlers after %s', async phase => {
    const { f, view, call, exportHistory, download } = await reportFilterFixture(); reportFilter(view, 'type', 'verification'); reportFilter(view, 'outcome', 'failed'); const range = view.find('data-history-preview-range', 'records')!, before = range.textContent, type = view.find('data-history-preview-filter', 'type')!, reset = view.find('data-history-preview-control', 'filter-clear')!;
    if (phase === 'privacy') { const privacy = f.host.find('data-history-export-mode', 'privacy')!; privacy.value = 'aliases'; privacy.fire('change'); } else if (phase === 'new export') { f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); } else if (phase === 'close') view.find('data-history-preview-control', 'close')!.click(); else f.panel.dispose();
    const counts = [call.mock.calls.length, exportHistory.mock.calls.length], focus = f.doc.activeElement; type.value = 'incident'; type.fire('change'); reset.click(); expect([call.mock.calls.length, exportHistory.mock.calls.length]).toEqual(counts); expect(f.doc.activeElement).toBe(focus); expect(download).not.toHaveBeenCalled(); expect(range.textContent).toBe(before); f.panel.dispose();
  });
  it.each(['outcome', 'outside focus', 'replacement'] as const)('stops stale report filter cleanup when it causes %s', async action => {
    const { f, view, captured } = await reportFilterFixture('full', action === 'replacement' ? 'paste' : 'export'); const list = view.find('data-history-preview-list', 'records')!, remove = list.removeChild.bind(list), outside = f.host.find('data-history-filter', 'search') ?? f.host.find('data-history-export-mode', 'privacy')!; let acted = false;
    list.removeChild = child => { remove(child); if (acted) return; acted = true; if (action === 'outcome') reportFilter(view, 'outcome', 'failed'); else if (action === 'outside focus') outside.focus!(); else submitPastedHistory(f, prepareAuthenticationHistoryContextRecord(captured.report.entries[0]!, authenticationHistoryRecordContext(captured, 0)).json); };
    reportFilter(view, 'type', 'incident'); expect(acted).toBe(true); if (action === 'outcome') { expect(view.querySelectorAll('[data-history-preview-record]')).toHaveLength(0); expect(reportRange(view)).toContain('No records match these preview filters.'); } else if (action === 'outside focus') expect(f.doc.activeElement).toBe(outside); else { expect(view.getAttribute('data-history-preview-layout')).toBe('record'); expect(view.querySelectorAll('[data-history-preview-record]')).toHaveLength(1); } f.panel.dispose();
  });
  it.each(['empty', 'one'] as const)('offers stable choices in an %s report and leaves rows intact when resetting empty filters', async size => {
    const value = historyExport({ kind: 'all' }, size === 'empty' ? 0 : 1), f = mount(async () => page(value.scope), value.scope, { exportHistory: async () => value }); await f.panel.whenLoaded(); f.host.find('data-history-export', 'preview')!.click(); await f.panel.whenLoaded(); const view = f.host.find('data-history-preview', 'report')!; const row = size === 'one' ? trailRecord(view, 0) : undefined;
    expect(view.find('data-history-preview-filter', 'type')!.children.map(option => option.value)).toEqual(size === 'one' ? ['', 'incident'] : ['']); view.find('data-history-preview-control', 'filter-clear')!.click(); expect(view.find('data-history-preview-record', '0')).toBe(row); if (row) expect(row.open).toBe(true); f.panel.dispose();
  });
  it.each(['aliases', 'full'] as const)('keeps standalone %s records text-only and retires old full-report filters on replacement', async mode => {
    const { f, view, captured } = await reportFilterFixture(mode, 'paste'), old = view.find('data-history-preview-filter', 'type')!; reportFilter(view, 'type', 'verification'); const one = prepareAuthenticationHistoryContextRecord(captured.report.entries[49]!, authenticationHistoryRecordContext(captured, 49)); submitPastedHistory(f, one.json); expect(view.querySelectorAll('[data-history-preview-filter]')).toHaveLength(0); const before = view.text(); old.value = 'incident'; old.fire('change'); expect(view.text()).toBe(before); expect(view.getAttribute('data-history-preview-layout')).toBe('record'); f.panel.dispose();
  });
  it.each(['type', 'outcome', 'both', 'query and filters'] as const)('clears only blocking %s for a saved reference and restores criteria, drafts and validation through Back and Forward', async blocked => {
    const { f, view } = await reportFilterFixture(); const query = blocked === 'query and filters' ? 'Access check' : 'Work'; reportSearch(view, query);
    if (blocked !== 'outcome') reportFilter(view, 'type', 'verification'); if (blocked !== 'type') reportFilter(view, 'outcome', 'failed');
    const input = view.find('data-history-preview-search', 'query')!; input.value = 'x'.repeat(129); view.find('data-history-preview-search', 'form')!.fire('submit'); reportFilter(view, 'type', '__proto__'); trailFollow(view, 49);
    expect(view.find('data-history-preview-record', '45')!.open).toBe(true); expect([view.find('data-history-preview-filter', 'type')!.value, view.find('data-history-preview-filter', 'outcome')!.value]).toEqual(['', '']); expect(input.value).toBe(blocked === 'query and filters' ? '' : 'x'.repeat(129)); expect(input.getAttribute('aria-invalid')).toBe(blocked === 'query and filters' ? 'false' : 'true');
    trailBack(view); expect(view.find('data-history-preview-record', '49')!.open).toBe(true); expect(view.find('data-history-preview-search', 'applied')!.textContent).toContain('Applied preview search: “' + query + '”.'); expect(input.value).toHaveLength(129); expect(input.getAttribute('aria-invalid')).toBe('true'); expect(view.find('data-history-preview-filter', 'error')!.hidden).toBe(false);
    expect(view.find('data-history-preview-filter', 'type')!.value).toBe(blocked === 'outcome' ? '' : 'verification'); expect(view.find('data-history-preview-filter', 'outcome')!.value).toBe(blocked === 'type' ? '' : 'failed'); trailForward(view); expect(view.find('data-history-preview-record', '45')!.open).toBe(true); trailBack(view); expect(input.value).toHaveLength(129); f.panel.dispose();
  });
  it('keeps a compatible type, outcome and invalid draft when following a reference inside the criteria', async () => {
    const { f, view } = await reportFilterFixture(); reportSearch(view, 'Access check'); reportFilter(view, 'type', 'verification'); reportFilter(view, 'outcome', 'passed'); const input = view.find('data-history-preview-search', 'query')!; input.value = 'x'.repeat(129); view.find('data-history-preview-search', 'form')!.fire('submit'); trailFollow(view, 47); expect(view.find('data-history-preview-record', '46')!.open).toBe(true); expect(input.value).toHaveLength(129); expect(input.getAttribute('aria-invalid')).toBe('true'); expect(view.find('data-history-preview-filter', 'outcome')!.value).toBe('passed'); trailBack(view); expect(view.find('data-history-preview-record', '47')!.open).toBe(true); f.panel.dispose();
  });
  it('keeps changed report filters after Back in the Forward trail and uses a range when no selected record remains', async () => {
    const { f, view } = await reportFilterFixture(); reportFilter(view, 'type', 'verification'); reportFilter(view, 'outcome', 'failed'); trailFollow(view, 49); trailBack(view); reportFilter(view, 'outcome', 'passed'); trailForward(view); expect(view.find('data-history-preview-record', '45')!.open).toBe(true); trailBack(view);
    expect(view.find('data-history-preview-filter', 'type')!.value).toBe('verification'); expect(view.find('data-history-preview-filter', 'outcome')!.value).toBe('passed'); expect(reportRange(view)).toContain('1–2 of 2'); expect(f.doc.activeElement).toBe(view.find('data-history-preview-range', 'records')); f.panel.dispose();
  });
  it.each(['baseline', 'comparison'] as const)('filters a complete %s source locally without changing comparison results or its exact report download', async side => {
    const { f, panel, view, first, second, download } = await sourceReferenceFixture(); if (side === 'comparison') panel.find('data-history-compare-control', 'open-comparison-source-38')!.click(); const before = panel.find('data-history-compare', 'range')!.textContent;
    reportFilter(view, 'type', 'verification'); reportFilter(view, 'outcome', 'passed'); expect(reportRange(view)).toContain('1–2 of 2 (49 in snapshot)'); trailFollow(view, 38); trailBack(view); expect(view.find('data-history-preview-filter', 'type')!.value).toBe('verification'); view.find('data-history-preview-control', 'download')!.click(); expect(download.mock.calls.at(-1)![1]).toBe(comparisonJson(side === 'baseline' ? first : second)); expect(panel.find('data-history-compare', 'range')!.textContent).toBe(before); view.find('data-history-preview-control', 'close')!.click(); expect(view.hidden).toBe(true); f.panel.dispose();
  });

  it('restores the previous record with its applied search, unsent draft and exact source context', async () => {
    const { f, panel, view, first, origin, download } = await sourceReferenceFixture(); const query = view.find('data-history-preview-search', 'query')!, form = view.find('data-history-preview-search', 'form')!;
    query.value = '  ' + origin.record.id + '  '; form.fire('submit'); const record = trailRecord(view, 38), oldReference = record.find('data-history-preview-control', 'reference')!;
    query.value = 'unsent preview draft'; query.fire('input'); const comparisonRange = panel.find('data-history-compare', 'range')!.textContent; oldReference.click();
    expect(query.value).toBe(''); expect(view.find('data-history-preview-control', 'return-record')).toBeDefined(); expect(view.find('data-history-preview-navigation', 'records')!.text()).toContain('1 previous record.');
    trailBack(view); const restored = view.find('data-history-preview-record', '38')!; expect(restored.open).toBe(true); expect(restored).not.toBe(record); expect(f.doc.activeElement).toBe(restored.children[0]);
    expect(query.value).toBe('unsent preview draft'); expect(view.find('data-history-preview-search', 'applied')!.textContent).toContain(origin.record.id); expect(view.find('data-history-preview-range', 'records')!.textContent).toContain('Matching records 1–1 of 1');
    expect(view.find('data-history-preview-navigation', 'records')!.hidden).toBe(false); expect(view.find('data-history-preview-control', 'next-record')!.disabled).toBe(false); expect(panel.find('data-history-compare', 'range')!.textContent).toBe(comparisonRange);
    oldReference.click(); expect(view.find('data-history-preview-record', '38')).toBe(restored); contextChoice(restored, true); restored.find('data-history-preview-control', 'download-record')!.click();
    const saved = JSON.parse(download.mock.calls[0]![1]); expect(saved.source_position).toBe(39); expect(saved.entry).toEqual(JSON.parse(comparisonJson(first)).entries[38]);
    view.find('data-history-preview-control', 'download')!.click(); expect(JSON.parse(download.mock.calls[1]![1])).toEqual(JSON.parse(comparisonJson(first))); f.panel.dispose();
  });
  it('walks linked records backwards in order and restores pages after intervening searches and paging', async () => {
    const { f, view, first } = await sourceReferenceFixture(); const repair = first.entries.findIndex(entry => entry.type === 'repair');
    trailFollow(view, 38); trailFollow(view, 31); expect(view.find('data-history-preview-record', String(repair))!.open).toBe(true);
    const query = view.find('data-history-preview-search', 'query')!; query.value = 'no saved match'; view.find('data-history-preview-search', 'form')!.fire('submit');
    expect(view.querySelectorAll('[data-history-preview-record]')).toHaveLength(0); trailBack(view); expect(query.value).toBe(''); expect(view.find('data-history-preview-record', '31')!.open).toBe(true); expect(view.find('data-history-preview-range', 'records')!.textContent).toBe('Records 21–40 of 49');
    view.find('data-history-preview-control', 'previous')!.click(); const oldBack = view.find('data-history-preview-control', 'previous-record')!; trailBack(view);
    expect(view.find('data-history-preview-record', '38')!.open).toBe(true); expect(view.find('data-history-preview-range', 'records')!.textContent).toBe('Records 21–40 of 49'); expect(oldBack.disabled).toBe(true); f.panel.dispose();
  });
  it.each(['full', 'aliases'] as const)('restores saved links within a %s report opened from a file or paste without changing its bytes', async mode => {
    const { f, first, download } = await sourceReferenceFixture(); const checked = prepareAuthenticationHistoryDownload(first, { scope: first.scope }, mode);
    for (const source of ['file', 'paste'] as const) {
      if (source === 'file') { chooseHistoryFile(f, async () => checked.json); await f.panel.whenLoaded(); } else submitPastedHistory(f, checked.json);
      const view = f.host.find('data-history-preview', 'file')!; expect(view.find('data-history-preview-navigation', 'records')!.hidden).toBe(true); view.find('data-history-preview-control', 'next')!.click();
      trailFollow(view, 38); trailBack(view); trailForward(view); expect(view.find('data-history-preview-record', '31')!.open).toBe(true); trailBack(view); const restored = view.find('data-history-preview-record', '38')!; expect(restored.open).toBe(true); expect(restored.text()).toContain(checked.report.entries[38]!.record.id); expect(f.doc.activeElement).toBe(restored.children[0]);
      view.find('data-history-preview-control', 'download')!.click(); expect(download.mock.calls.at(-1)![1]).toBe(checked.json);
    }
    f.panel.dispose();
  });
  it('restores an invalid search draft without applying it or losing the earlier valid results', async () => {
    const { f, view, origin } = await sourceReferenceFixture(); const query = view.find('data-history-preview-search', 'query')!, form = view.find('data-history-preview-search', 'form')!;
    query.value = origin.record.id; form.fire('submit'); const original = trailRecord(view, 38); query.value = 'x'.repeat(129); form.fire('submit'); expect(query.getAttribute('aria-invalid')).toBe('true');
    original.find('data-history-preview-control', 'reference')!.click(); expect(query.getAttribute('aria-invalid')).toBe('false'); trailBack(view);
    expect(query.value).toHaveLength(129); expect(query.getAttribute('aria-invalid')).toBe('true'); expect(view.text()).toContain('Earlier preview results are unchanged.'); expect(view.querySelectorAll('[data-history-preview-record]')).toHaveLength(1); expect(view.find('data-history-preview-record', '38')!.open).toBe(true);
    query.value = 'corrected draft'; query.fire('input'); expect(query.getAttribute('aria-invalid')).toBe('false'); form.fire('submit'); expect(view.querySelectorAll('[data-history-preview-record]')).toHaveLength(0); f.panel.dispose();
  });
  it('bounds cyclic saved-link history to the last twenty steps and explains the discarded earlier steps', async () => {
    const { f, first } = await sourceReferenceFixture(); const target = first.entries[31]!.record; if (!('selection' in target)) throw Error('Expected access check'); target.selection = { kind: 'verification', id: first.entries[38]!.record.id };
    const origin = first.entries[38]!.record; if (!('results' in origin)) throw Error('Expected access check'); origin.results = structuredClone(origin.results); origin.results[0]!.label = 'Only first trail record';
    submitPastedHistory(f, comparisonJson(first)); const view = f.host.find('data-history-preview', 'file')!, query = view.find('data-history-preview-search', 'query')!;
    query.value = 'Only first trail record'; view.find('data-history-preview-search', 'form')!.fire('submit');
    for (let step = 0; step < 22; step++) trailFollow(view, step % 2 === 0 ? 38 : 31);
    expect(view.find('data-history-preview-navigation', 'records')!.text()).toContain('20 previous records.'); expect(view.text()).toContain('Earlier steps are no longer available.');
    for (let step = 0; step < 20; step++) trailBack(view);
    const back = view.find('data-history-preview-control', 'previous-record')!; expect(back.disabled).toBe(true); expect(view.find('data-history-preview-navigation', 'records')!.hidden).toBe(false); expect(view.text()).toContain('No previous records remain in this trail.'); expect(query.value).toBe('');
    expect(view.querySelectorAll('[data-history-preview-record]')).toHaveLength(20); const before = view.text(); back.click(); expect(view.text()).toBe(before);
    submitPastedHistory(f, comparisonJson(first)); expect(view.find('data-history-preview-navigation', 'records')!.hidden).toBe(true); f.panel.dispose();
  });
  it('retires departed record controls and pending copy feedback even after Back opens that same record again', async () => {
    const { f, view, download } = await sourceReferenceFixture(); let reject!: (error: Error) => void; const write = vi.fn(() => new Promise<void>((_, no) => { reject = no; })); copyBrowser(f, { clipboard: { writeText: write } });
    const original = trailRecord(view, 38), copy = original.find('data-history-preview-control', 'copy-record')!, save = original.find('data-history-preview-control', 'download-record')!, status = original.find('data-history-preview-copy', 'record-status')!;
    copy.focus!(); copy.click(); trailFollow(view, 38); const departed = view.find('data-history-preview-control', 'return-record')!; trailBack(view);
    const restored = view.find('data-history-preview-record', '38')!, focus = f.doc.activeElement; reject(Error('private-old-trail-copy')); await settleCopy(); copy.click(); save.click(); departed.click();
    expect(write).toHaveBeenCalledOnce(); expect(download).not.toHaveBeenCalled(); expect(status.textContent).toBe('Copying record JSON…'); expect(view.text()).not.toContain('private-old-trail-copy'); expect(f.doc.activeElement).toBe(focus); expect(restored).not.toBe(original); expect(restored.find('data-history-preview-copy', 'record-status')!.hidden).toBe(true); f.panel.dispose();
  });
  it.each(['close', 'swap', 'new report', 'new pair', 'clear baseline', 'main close', 'dispose'] as const)('retires the saved-record trail when its source is left through %s', async action => {
    const { f, panel, view, first, second } = await sourceReferenceFixture(); trailFollow(view, 38); trailFollow(view, 31); trailBack(view); const back = view.find('data-history-preview-control', 'previous-record')!, inline = view.find('data-history-preview-control', 'return-record')!, forward = view.find('data-history-preview-control', 'next-record')!, inlineForward = view.find('data-history-preview-control', 'forward-record')!;
    if (action === 'close') view.find('data-history-preview-control', 'close')!.click(); else if (action === 'swap') panel.find('data-history-compare-control', 'swap')!.click(); else if (action === 'new report') submitPastedHistory(f, comparisonJson(second));
    else if (action === 'new pair') submitPastedHistory(f, comparisonPair(first, second).json); else if (action === 'clear baseline') panel.find('data-history-compare-control', 'clear')!.click(); else if (action === 'main close') f.host.find('data-history-preview', 'file')!.find('data-history-preview-control', 'close')!.click(); else f.panel.dispose();
    const focus = f.doc.activeElement; back.click(); inline.click(); forward.click(); inlineForward.click(); expect(view.hidden).toBe(true); expect(view.children).toHaveLength(0); expect(f.doc.activeElement).toBe(focus); f.panel.dispose();
  });
  it('preserves the full-report trail during comparison changes and returns to the comparison range when its row is hidden', async () => {
    const { f, panel, view, origin } = await sourceReferenceFixture(); const query = view.find('data-history-preview-search', 'query')!; query.value = origin.record.id; view.find('data-history-preview-search', 'form')!.fire('submit'); trailFollow(view, 38);
    panel.find('data-history-compare-control', 'previous')!.click(); const filter = panel.find('data-history-compare', 'filter')!; filter.value = 'unchanged'; filter.fire('change'); trailBack(view);
    expect(query.value).toBe(origin.record.id); expect(view.find('data-history-preview-record', '38')!.open).toBe(true); const close = view.find('data-history-preview-control', 'close')!; close.focus!(); close.click(); expect(f.doc.activeElement).toBe(panel.find('data-history-compare', 'range')); expect(panel.find('data-history-compare', 'source-return')!.hidden).toBe(false); f.panel.dispose();
  });
  it.each(['redirect', 'replace', 'search'] as const)('respects a newer view or focus selected while the previous record is restored: %s', async action => {
    const { f, panel, view, first, second, origin } = await sourceReferenceFixture(); trailFollow(view, 38); const create = f.doc.createElement, outside = panel.find('data-history-compare', 'query')!, scroll = vi.fn(); let acted = false;
    f.doc.createElement = () => {
      const element = create(), focus = element.focus!; element.focus = () => { focus(); if (!acted && element.textContent.includes(origin.record.id)) {
        acted = true; Reflect.set(element, 'scrollIntoView', scroll);
        if (action === 'redirect') outside.focus!(); else if (action === 'replace') submitPastedHistory(f, comparisonJson(second));
        else { view.find('data-history-preview-search', 'query')!.value = first.entries[0]!.record.id; view.find('data-history-preview-search', 'form')!.fire('submit'); }
      } }; return element;
    };
    expect(() => trailBack(view)).not.toThrow(); expect(acted).toBe(true); expect(scroll).not.toHaveBeenCalled();
    if (action === 'redirect') { expect(f.doc.activeElement).toBe(outside); expect(view.find('data-history-preview-record', '38')!.open).toBe(true); }
    else if (action === 'replace') { expect(view.hidden).toBe(true); expect(view.children).toHaveLength(0); }
    else { expect(view.querySelectorAll('[data-history-preview-record]')).toHaveLength(1); expect(view.find('data-history-preview-record', '0')).toBeDefined(); }
    f.panel.dispose();
  });
  it('does not pop another saved step when a previous-record focus handler reenters Back', async () => {
    const { f, view, target } = await sourceReferenceFixture(); trailFollow(view, 38); trailFollow(view, 31); const create = f.doc.createElement, back = view.find('data-history-preview-control', 'previous-record')!; let reentered = false;
    f.doc.createElement = () => { const element = create(), focus = element.focus!; element.focus = () => { focus(); if (element.textContent.includes(target.record.id)) { reentered = true; back.click(); } }; return element; };
    trailBack(view); expect(reentered).toBe(true); expect(view.find('data-history-preview-record', '31')!.open).toBe(true); expect(view.find('data-history-preview-navigation', 'records')!.text()).toContain('1 previous record.'); expect(view.querySelectorAll('[data-history-preview-record]')).toHaveLength(20); f.panel.dispose();
  });
  it('keeps newer outside focus when Back is activated programmatically', async () => {
    const { f, panel, view } = await sourceReferenceFixture(); trailFollow(view, 38); const outside = panel.find('data-history-compare', 'query')!; Reflect.set(outside, 'isConnected', true); outside.focus!();
    view.find('data-history-preview-control', 'previous-record')!.click(); expect(f.doc.activeElement).toBe(outside); expect(view.find('data-history-preview-record', '38')!.open).toBe(true); f.panel.dispose();
  });
  it.each(['previous-record', 'return-record', 'next-record', 'forward-record'])('preserves newer outside focus selected during a pointer gesture on %s', async key => {
    const { f, panel, view } = await sourceReferenceFixture(); trailFollow(view, 38); const goingForward = key === 'next-record' || key === 'forward-record'; if (goingForward) trailBack(view); const back = view.find('data-history-preview-control', key)!, query = view.find('data-history-preview-search', 'query')!, outside = panel.find('data-history-compare', 'query')!;
    Reflect.set(outside, 'isConnected', true); query.focus!(); back.fire('pointerdown'); outside.focus!(); back.fire('click', 1);
    expect(view.find('data-history-preview-record', goingForward ? '31' : '38')!.open).toBe(true); expect(view.find('data-history-preview-navigation', 'records')!.hidden).toBe(false); expect(f.doc.activeElement).toBe(outside); f.panel.dispose();
  });
  it.each(['previous-record', 'return-record', 'next-record', 'forward-record'])('preserves a field selected again after pointer focus leaves %s', async key => {
    const { f, view } = await sourceReferenceFixture(); trailFollow(view, 38); const goingForward = key === 'next-record' || key === 'forward-record'; if (goingForward) trailBack(view); const back = view.find('data-history-preview-control', key)!, query = view.find('data-history-preview-search', 'query')!; Reflect.set(query, 'isConnected', true);
    query.focus!(); back.fire('pointerdown'); back.focus!(); back.fire('focus'); query.focus!(); back.fire('click', 1);
    expect(view.find('data-history-preview-record', goingForward ? '31' : '38')!.open).toBe(true); expect(f.doc.activeElement).toBe(query); f.panel.dispose();
  });
  it.each(['previous-record', 'return-record', 'next-record', 'forward-record'])('focuses the previous record when pointer activation keeps the earlier field focused on %s', async key => {
    const { f, view } = await sourceReferenceFixture(); trailFollow(view, 38); const goingForward = key === 'next-record' || key === 'forward-record'; if (goingForward) trailBack(view); const back = view.find('data-history-preview-control', key)!, query = view.find('data-history-preview-search', 'query')!; Reflect.set(query, 'isConnected', true);
    query.focus!(); back.fire('pointerdown'); back.fire('click', 1);
    expect(f.doc.activeElement).toBe(view.find('data-history-preview-record', goingForward ? '31' : '38')!.children[0]); f.panel.dispose();
  });
  it.each(['previous-record', 'return-record', 'next-record', 'forward-record'])('focuses the restored record when a pointer gesture on %s selects a control that will be removed', async key => {
    const { f, view } = await sourceReferenceFixture(); trailFollow(view, 38); const goingForward = key === 'next-record' || key === 'forward-record'; if (goingForward) trailBack(view); const back = view.find('data-history-preview-control', key)!, field = view.find('data-history-preview-record', goingForward ? '38' : '31')!.find('data-history-preview-control', 'include-record-context')!; Reflect.set(field, 'isConnected', true);
    view.find('data-history-preview-search', 'query')!.focus!(); back.fire('pointerdown'); back.focus!(); back.fire('focus'); field.focus!(); back.fire('click', 1);
    expect(view.contains(field)).toBe(false); expect(f.doc.activeElement).toBe(view.find('data-history-preview-record', goingForward ? '31' : '38')!.children[0]); f.panel.dispose();
  });
  it('restores Forward with the destination query, invalid draft, source context and complete report bytes', async () => {
    const { f, view, first, origin, target, download } = await sourceReferenceFixture(); const query = view.find('data-history-preview-search', 'query')!, form = view.find('data-history-preview-search', 'form')!;
    query.value = origin.record.id; form.fire('submit'); query.value = 'origin unsent draft'; trailFollow(view, 38);
    query.value = target.record.id; form.fire('submit'); query.value = 'x'.repeat(129); form.fire('submit'); const error = view.text(); trailBack(view);
    expect(query.value).toBe('origin unsent draft'); expect(view.find('data-history-preview-control', 'previous-record')!.disabled).toBe(true); expect(view.find('data-history-preview-control', 'next-record')!.disabled).toBe(false);
    trailForward(view, 'forward-record'); const restored = view.find('data-history-preview-record', '31')!;
    expect(restored.open).toBe(true); expect(f.doc.activeElement).toBe(restored.children[0]); expect(query.value).toHaveLength(129); expect(query.getAttribute('aria-invalid')).toBe('true'); expect(view.text()).toContain('Earlier preview results are unchanged.'); expect(error).toContain('Earlier preview results are unchanged.');
    expect(view.find('data-history-preview-search', 'applied')!.textContent).toContain(target.record.id); expect(view.find('data-history-preview-range', 'records')!.textContent).toContain('Matching records 1–2 of 2'); expect(view.find('data-history-preview-control', 'next-record')!.disabled).toBe(true);
    contextChoice(restored, true); restored.find('data-history-preview-control', 'download-record')!.click(); const record = JSON.parse(download.mock.calls[0]![1]); expect(record.entry).toEqual(JSON.parse(comparisonJson(first)).entries[31]); expect(record.source_position).toBe(32); expect(record.source_snapshot.entry_count).toBe(first.entry_count);
    view.find('data-history-preview-control', 'download')!.click(); expect(download.mock.calls[1]![1]).toBe(comparisonJson(first)); trailBack(view); expect(query.value).toBe('origin unsent draft'); f.panel.dispose();
  });
  it.each(['empty search', 'other record search', 'different page'] as const)('restores Forward to the actual saved view after %s without forcing a hidden target into view', async state => {
    const { f, view, first } = await sourceReferenceFixture(); trailFollow(view, 38); const query = view.find('data-history-preview-search', 'query')!, form = view.find('data-history-preview-search', 'form')!;
    if (state === 'different page') view.find('data-history-preview-control', 'previous')!.click(); else { query.value = state === 'empty search' ? 'no saved forward match' : first.entries[0]!.record.id; form.fire('submit'); }
    const range = view.find('data-history-preview-range', 'records')!.textContent, indices = view.querySelectorAll('[data-history-preview-record]').map(row => row.getAttribute('data-history-preview-record'));
    query.value = 'unsent destination draft'; trailBack(view); expect(view.find('data-history-preview-navigation', 'records')!.text()).toContain('No record was selected on that page.'); trailForward(view);
    expect(query.value).toBe('unsent destination draft'); expect(view.find('data-history-preview-range', 'records')!.textContent).toBe(range); expect(view.querySelectorAll('[data-history-preview-record]').map(row => row.getAttribute('data-history-preview-record'))).toEqual(indices); expect(view.find('data-history-preview-record', '31')).toBeUndefined(); expect(f.doc.activeElement).toBe(view.find('data-history-preview-range', 'records'));
    trailBack(view); expect(view.find('data-history-preview-record', '38')!.open).toBe(true); f.panel.dispose();
  });
  it('keeps Forward during a changed search and page, and captures that changed view for the next Back', async () => {
    const { f, view, origin } = await sourceReferenceFixture(); trailFollow(view, 38); trailBack(view); const query = view.find('data-history-preview-search', 'query')!;
    view.find('data-history-preview-control', 'next')!.click(); query.value = 'draft after Back'; expect(view.find('data-history-preview-control', 'next-record')!.disabled).toBe(false); trailForward(view);
    expect(view.find('data-history-preview-record', '31')!.open).toBe(true); trailBack(view); expect(query.value).toBe('draft after Back'); expect(view.find('data-history-preview-range', 'records')!.textContent).toBe('Records 41–49 of 49'); expect(f.doc.activeElement).toBe(view.find('data-history-preview-range', 'records'));
    query.value = origin.record.id; view.find('data-history-preview-search', 'form')!.fire('submit'); trailForward(view); trailBack(view); expect(query.value).toBe(origin.record.id); expect(view.find('data-history-preview-record', '38')!.open).toBe(false); f.panel.dispose();
  });
  it('discards the Forward branch only when another saved reference is followed', async () => {
    const { f, view, first } = await sourceReferenceFixture(); const repair = first.entries.findIndex(entry => entry.type === 'repair'); trailFollow(view, 38); trailFollow(view, 31); trailBack(view);
    expect(view.find('data-history-preview-control', 'next-record')!.disabled).toBe(false); trailFollow(view, 31);
    expect(view.find('data-history-preview-control', 'next-record')!.disabled).toBe(true); expect(view.find('data-history-preview-navigation', 'records')!.text()).toContain('2 previous records.'); expect(view.find('data-history-preview-record', String(repair))!.open).toBe(true);
    trailBack(view); trailForward(view); expect(view.find('data-history-preview-control', 'next-record')!.disabled).toBe(true); f.panel.dispose();
  });
  it('shares the twenty-step limit across Back and Forward, including repeated cycles and a new branch', async () => {
    const { f, first } = await sourceReferenceFixture(); const record = first.entries[31]!.record; if (!('selection' in record)) throw Error('Expected saved check'); record.selection = { kind: 'verification', id: first.entries[38]!.record.id };
    submitPastedHistory(f, comparisonJson(first)); const view = f.host.find('data-history-preview', 'file')!; view.find('data-history-preview-control', 'next')!.click();
    for (let n = 0; n < 23; n++) trailFollow(view, n % 2 === 0 ? 38 : 31);
    for (let n = 0; n < 20; n++) trailBack(view); expect(view.find('data-history-preview-control', 'previous-record')!.disabled).toBe(true); expect(view.find('data-history-preview-navigation', 'records')!.text()).toContain('20 next records.');
    for (let n = 0; n < 20; n++) trailForward(view); expect(view.find('data-history-preview-control', 'next-record')!.disabled).toBe(true); expect(view.find('data-history-preview-navigation', 'records')!.text()).toContain('20 previous records.');
    for (let n = 0; n < 10; n++) trailBack(view); trailFollow(view, 31); expect(view.find('data-history-preview-control', 'next-record')!.disabled).toBe(true); expect(view.find('data-history-preview-navigation', 'records')!.text()).toContain('11 previous records.');
    for (let n = 0; n < 11; n++) trailBack(view); expect(view.find('data-history-preview-control', 'previous-record')!.disabled).toBe(true); expect(view.text()).toContain('Earlier steps are no longer available.'); f.panel.dispose();
  });
  it('retires the old destination DOM and pending clipboard reply when Forward rebuilds that record', async () => {
    const { f, view, download } = await sourceReferenceFixture(); let reject!: (error: Error) => void; const write = vi.fn(() => new Promise<void>((_, no) => { reject = no; })); copyBrowser(f, { clipboard: { writeText: write } }); trailFollow(view, 38);
    const departed = trailRecord(view, 31), copy = departed.find('data-history-preview-control', 'copy-record')!, save = departed.find('data-history-preview-control', 'download-record')!, status = departed.find('data-history-preview-copy', 'record-status')!; copy.focus!(); copy.click();
    trailBack(view); const inline = view.find('data-history-preview-control', 'forward-record')!; trailForward(view); const focus = f.doc.activeElement; reject(Error('private-forward-copy')); await settleCopy(); copy.click(); save.click(); inline.click();
    expect(write).toHaveBeenCalledOnce(); expect(download).not.toHaveBeenCalled(); expect(status.textContent).toBe('Copying record JSON…'); expect(f.doc.activeElement).toBe(focus); expect(view.text()).not.toContain('private-forward-copy'); const restored = view.find('data-history-preview-record', '31')!; expect(restored).not.toBe(departed); expect(restored.find('data-history-preview-copy', 'record-status')!.hidden).toBe(true); f.panel.dispose();
  });
  it('preserves Forward across comparison view changes and rejected replacement JSON', async () => {
    const { f, panel, view } = await sourceReferenceFixture(); trailFollow(view, 38); trailBack(view); panel.find('data-history-compare-control', 'previous')!.click(); const filter = panel.find('data-history-compare', 'filter')!; filter.value = 'unchanged'; filter.fire('change');
    submitPastedHistory(f, '{invalid saved file'); expect(view.hidden).toBe(false); trailForward(view); expect(view.find('data-history-preview-record', '31')!.open).toBe(true); const close = view.find('data-history-preview-control', 'close')!; close.focus!(); close.click(); expect(f.doc.activeElement).toBe(panel.find('data-history-compare', 'range')); expect(panel.find('data-history-compare', 'source-return')!.hidden).toBe(false); f.panel.dispose();
  });
  it.each(['redirect', 'replace', 'search'] as const)('respects a newer view or focus while Forward restores a record: %s', async action => {
    const { f, panel, view, first, second, target } = await sourceReferenceFixture(); trailFollow(view, 38); trailBack(view); const create = f.doc.createElement, outside = panel.find('data-history-compare', 'query')!, scroll = vi.fn(); let acted = false;
    f.doc.createElement = () => { const element = create(), focus = element.focus!; element.focus = () => { focus(); if (!acted && element.textContent.includes(target.record.id)) { acted = true; Reflect.set(element, 'scrollIntoView', scroll); if (action === 'redirect') outside.focus!(); else if (action === 'replace') submitPastedHistory(f, comparisonJson(second)); else { view.find('data-history-preview-search', 'query')!.value = first.entries[0]!.record.id; view.find('data-history-preview-search', 'form')!.fire('submit'); } } }; return element; };
    expect(() => trailForward(view)).not.toThrow(); expect(acted).toBe(true); expect(scroll).not.toHaveBeenCalled();
    if (action === 'redirect') { expect(f.doc.activeElement).toBe(outside); expect(view.find('data-history-preview-record', '31')!.open).toBe(true); } else if (action === 'replace') { expect(view.hidden).toBe(true); expect(view.children).toHaveLength(0); } else { expect(view.querySelectorAll('[data-history-preview-record]')).toHaveLength(1); expect(view.find('data-history-preview-record', '0')).toBeDefined(); } f.panel.dispose();
  });
  it('guards both directions against reentry from a Forward destination focus handler', async () => {
    const { f, view, target } = await sourceReferenceFixture(); trailFollow(view, 38); trailFollow(view, 31); trailBack(view); trailBack(view); const create = f.doc.createElement; let reentered = false;
    f.doc.createElement = () => { const element = create(), focus = element.focus!; element.focus = () => { focus(); if (!reentered && element.textContent.includes(target.record.id)) { reentered = true; view.find('data-history-preview-control', 'previous-record')!.click(); view.find('data-history-preview-control', 'next-record')!.click(); } }; return element; };
    trailForward(view); expect(reentered).toBe(true); expect(view.find('data-history-preview-record', '31')!.open).toBe(true); expect(view.find('data-history-preview-navigation', 'records')!.text()).toContain('1 previous record.'); expect(view.find('data-history-preview-navigation', 'records')!.text()).toContain('1 next record.'); f.panel.dispose();
  });
  it('keeps newer connected outside focus when Forward is called programmatically', async () => {
    const { f, panel, view } = await sourceReferenceFixture(); trailFollow(view, 38); trailBack(view); const outside = panel.find('data-history-compare', 'query')!; Reflect.set(outside, 'isConnected', true); outside.focus!(); view.find('data-history-preview-control', 'next-record')!.click(); expect(f.doc.activeElement).toBe(outside); expect(view.find('data-history-preview-record', '31')!.open).toBe(true); f.panel.dispose();
  });
  it('uses the range for explicit preview focus after Forward restores an empty view', async () => {
    const { f, first } = await sourceReferenceFixture(), preview = createAuthenticationHistoryPreview({ document: f.doc as unknown as Document }); f.host.appendChild(preview.element as unknown as Element); const checked = prepareAuthenticationHistoryDownload(first, { scope: first.scope }, 'full'); preview.show(checked); const view = preview.element as unknown as Element;
    view.find('data-history-preview-control', 'next')!.click(); trailFollow(view, 38); view.find('data-history-preview-search', 'query')!.value = 'no saved forward result'; view.find('data-history-preview-search', 'form')!.fire('submit'); trailBack(view); trailForward(view); preview.focus(); expect(f.doc.activeElement).toBe(view.find('data-history-preview-range', 'records')); preview.dispose(); f.panel.dispose();
  });
  it.each(['full', 'aliases'] as const)('keeps original and unknown source positions distinct when Forward revisits a %s related subset', async mode => {
    const raw = relatedFixture(), captured = prepareAuthenticationHistoryDownload(raw, { scope: raw.scope }, mode), bundle = createAuthenticationHistoryRelatedBundles(captured)(40), savedBundle = prepareAuthenticationHistoryRelatedDownload(bundle);
    const download = vi.fn(), f = mount(undefined, raw.scope, { download }); await f.panel.whenLoaded(); submitPastedHistory(f, savedBundle.json); const view = f.host.find('data-history-preview', 'file')!;
    trailFollow(view, 4); trailBack(view); trailForward(view); const linked = view.find('data-history-preview-record', '3')!; contextChoice(linked, true); linked.find('data-history-preview-control', 'download-record')!.click();
    const unknown = JSON.parse(download.mock.calls[0]![1]); expect(unknown.entry).toEqual(bundle.report.entries[3]); expect(unknown.source_position).toBeUndefined(); expect(unknown.source_snapshot.entry_count).toBe(captured.count); expect(unknown.privacy_mode).toBe(mode);
    trailFollow(view, 3); trailFollow(view, 2); trailBack(view); trailForward(view); const root = view.find('data-history-preview-record', '0')!; contextChoice(root, true); root.find('data-history-preview-control', 'download-record')!.click(); const known = JSON.parse(download.mock.calls[1]![1]); expect(known.source_position).toBe(41); expect(known.entry).toEqual(bundle.report.entries[0]);
    view.find('data-history-preview-control', 'download')!.click(); expect(download.mock.calls[2]![1]).toBe(savedBundle.json); f.panel.dispose();
  });
  it.each(['redirect', 'search', 'replace'] as const)('stops an older Forward restore when range focus triggers %s', async action => {
    const { f, panel, view, first, second } = await sourceReferenceFixture(); trailFollow(view, 38); const query = view.find('data-history-preview-search', 'query')!; query.value = 'no saved range result'; view.find('data-history-preview-search', 'form')!.fire('submit'); trailBack(view);
    const range = view.find('data-history-preview-range', 'records')!, focus = range.focus!, scroll = vi.fn(), outside = panel.find('data-history-compare', 'query')!; let acted = false; Reflect.set(range, 'scrollIntoView', scroll);
    range.focus = () => { focus(); if (acted) return; acted = true; if (action === 'redirect') outside.focus!(); else if (action === 'replace') submitPastedHistory(f, comparisonJson(second)); else { query.value = first.entries[0]!.record.id; view.find('data-history-preview-search', 'form')!.fire('submit'); } };
    trailForward(view); expect(acted).toBe(true); expect(scroll).not.toHaveBeenCalled(); if (action === 'redirect') { expect(f.doc.activeElement).toBe(outside); expect(view.querySelectorAll('[data-history-preview-record]')).toHaveLength(0); } else if (action === 'replace') { expect(view.hidden).toBe(true); expect(view.children).toHaveLength(0); } else { expect(view.querySelectorAll('[data-history-preview-record]')).toHaveLength(1); expect(view.find('data-history-preview-record', '0')).toBeDefined(); } f.panel.dispose();
  });
  it.each(['back', 'forward'] as const)('preserves newer outside focus chosen when the last %s control is disabled', async direction => {
    const { f, panel, view } = await sourceReferenceFixture(); trailFollow(view, 38); if (direction === 'forward') trailBack(view);
    const key = direction === 'back' ? 'previous-record' : 'next-record', control = view.find('data-history-preview-control', key)!, outside = panel.find('data-history-compare', 'query')!; Reflect.set(outside, 'isConnected', true); let disabled = control.disabled, blurred = false;
    Object.defineProperty(control, 'disabled', { get: () => disabled, set: value => { disabled = value; if (value && f.doc.activeElement === control) { blurred = true; outside.focus!(); } } });
    control.focus!(); control.click(); expect(blurred).toBe(true); expect(view.find('data-history-preview-record', direction === 'back' ? '38' : '31')!.open).toBe(true); expect(f.doc.activeElement).toBe(outside); f.panel.dispose();
  });
  for (const direction of ['back', 'forward'] as const) it.each(['search', 'replace'] as const)('stops an older ' + direction + ' render when disabling its control starts a newer %s', async action => {
    const { f, view, first, second } = await sourceReferenceFixture(); trailFollow(view, 38); if (direction === 'forward') trailBack(view);
    const key = direction === 'back' ? 'previous-record' : 'next-record', control = view.find('data-history-preview-control', key)!, query = view.find('data-history-preview-search', 'query')!; let disabled = control.disabled, acted = false;
    Object.defineProperty(control, 'disabled', { get: () => disabled, set: value => { disabled = value; if (value && !acted && f.doc.activeElement === control) { acted = true; if (action === 'replace') submitPastedHistory(f, comparisonJson(second)); else { query.value = first.entries[0]!.record.id; view.find('data-history-preview-search', 'form')!.fire('submit'); } } } });
    control.focus!(); control.click(); expect(acted).toBe(true); if (action === 'replace') { expect(view.hidden).toBe(true); expect(view.children).toHaveLength(0); } else { expect(view.querySelectorAll('[data-history-preview-record]')).toHaveLength(1); expect(view.find('data-history-preview-record', '0')).toBeDefined(); expect(view.find('data-history-preview-range', 'records')!.textContent).toContain('Matching records 1–1 of 1'); } f.panel.dispose();
  });
  for (const direction of ['back', 'forward'] as const) it.each(['outside', 'search', 'replace'] as const)('preserves a newer choice made while retiring the ' + direction + ' record: %s', async action => {
    const { f, panel, view, first, second } = await sourceReferenceFixture(); trailFollow(view, 38); if (direction === 'forward') trailBack(view); const index = direction === 'back' ? '31' : '38', departing = view.find('data-history-preview-record', index)!, list = view.find('data-history-preview-list', 'records')!;
    const key = direction === 'back' ? 'return-record' : 'forward-record', control = departing.find('data-history-preview-control', key)!, outside = panel.find('data-history-compare', 'query')!, remove = list.removeChild.bind(list); Reflect.set(outside, 'isConnected', true); let acted = false;
    list.removeChild = child => { remove(child); if (child === departing && !acted) { acted = true; if (action === 'outside') outside.focus!(); else if (action === 'replace') submitPastedHistory(f, comparisonJson(second)); else { view.find('data-history-preview-search', 'query')!.value = first.entries[0]!.record.id; view.find('data-history-preview-search', 'form')!.fire('submit'); } } };
    control.focus!(); control.click(); expect(acted).toBe(true); if (action === 'outside') expect(f.doc.activeElement).toBe(outside); else if (action === 'replace') { expect(view.hidden).toBe(true); expect(view.children).toHaveLength(0); } else { expect(view.querySelectorAll('[data-history-preview-record]')).toHaveLength(1); expect(view.find('data-history-preview-record', '0')).toBeDefined(); } f.panel.dispose();
  });
  it.each(['back', 'forward'] as const)('keeps a newer focus owner when disabling %s before a range-only restore', async direction => {
    const { f, panel, view } = await sourceReferenceFixture(), query = view.find('data-history-preview-search', 'query')!, form = view.find('data-history-preview-search', 'form')!; trailFollow(view, 38);
    query.value = 'no saved audit match'; form.fire('submit'); trailBack(view); if (direction === 'back') { query.value = 'no saved second match'; form.fire('submit'); trailForward(view); }
    const control = view.find('data-history-preview-control', direction === 'back' ? 'previous-record' : 'next-record')!, outside = panel.find('data-history-compare', 'query')!; Reflect.set(outside, 'isConnected', true); let disabled = control.disabled, acted = false;
    Object.defineProperty(control, 'disabled', { get: () => disabled, set: value => { disabled = value; if (value && !acted && f.doc.activeElement === control) { acted = true; outside.focus!(); } } });
    control.focus!(); control.click(); expect(acted).toBe(true); expect(view.querySelectorAll('[data-history-preview-record]')).toHaveLength(0); expect(f.doc.activeElement).toBe(outside); f.panel.dispose();
  });
  it('starts a fresh trail when a prepared live export replaces another preview', async () => {
    const { f, first } = await sourceReferenceFixture(), preview = createAuthenticationHistoryPreview({ document: f.doc as unknown as Document }); f.host.appendChild(preview.element as unknown as Element);
    const checked = prepareAuthenticationHistoryDownload(first, { scope: first.scope }, 'full'); preview.show(checked); const view = preview.element as unknown as Element; view.find('data-history-preview-control', 'next')!.click(); trailFollow(view, 38); const oldBack = view.find('data-history-preview-control', 'previous-record')!;
    preview.show(checked); expect(view.find('data-history-preview-navigation', 'records')!.hidden).toBe(true); oldBack.click(); expect(view.find('data-history-preview-range', 'records')!.textContent).toBe('Records 1–20 of 49'); view.find('data-history-preview-control', 'next')!.click(); trailFollow(view, 38); trailBack(view); expect(view.find('data-history-preview-record', '38')!.open).toBe(true); preview.dispose(); f.panel.dispose();
  });
  it('keeps explicit preview focus on the linked record rather than its still-visible comparison origin', async () => {
    const { f, first } = await sourceReferenceFixture(), preview = createAuthenticationHistoryPreview({ document: f.doc as unknown as Document }); f.host.appendChild(preview.element as unknown as Element);
    const checked = prepareAuthenticationHistoryDownload(first, { scope: first.scope }, 'full'); preview.show(checked, { source: 'comparison', side: 'baseline', label: 'Captured baseline', recordIndex: 38 }); const view = preview.element as unknown as Element;
    trailFollow(view, 38); const target = view.find('data-history-preview-record', '31')!; f.doc.body.focus?.(); preview.focus(); expect(f.doc.activeElement).toBe(target.children[0]); trailBack(view); preview.focus(); expect(f.doc.activeElement).toBe(view.find('data-history-preview-record', '38')!.children[0]); preview.dispose(); f.panel.dispose();
  });
  it('does not offer a record trail for standalone records or missing source references', async () => {
    const { f, first } = await sourceReferenceFixture(); const checked = prepareAuthenticationHistoryDownload(first, { scope: first.scope }, 'full'); const one = prepareAuthenticationHistoryContextRecord(checked.report.entries[38]!, authenticationHistoryRecordContext(checked, 38)); submitPastedHistory(f, one.json);
    const view = f.host.find('data-history-preview', 'file')!; trailRecord(view, 0); expect(view.find('data-history-preview-navigation', 'records')).toBeUndefined(); expect(view.find('data-history-preview-control', 'reference')).toBeUndefined();
    const record = first.entries[38]!.record; if (!('selection' in record)) throw Error('Expected access check'); record.selection = { kind: 'verification', id: 'verify-12345678-1234-4123-8123-999999999999' };
    submitPastedHistory(f, comparisonJson(first)); view.find('data-history-preview-control', 'next')!.click(); const row = trailRecord(view, 38); expect(row.find('data-history-preview-control', 'reference')).toBeUndefined(); expect(row.text()).toContain('Referenced record is not included in this snapshot.'); expect(view.find('data-history-preview-navigation', 'records')!.hidden).toBe(true);
    f.panel.dispose();
  });

});

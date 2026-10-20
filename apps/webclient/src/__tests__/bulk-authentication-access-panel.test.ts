import { afterEach, describe, expect, it, vi } from 'vitest';
import { authenticationAccessRecheckResults, type AuthenticationAccessPreview, type AuthenticationAccessVerification, type AuthenticationRepairWorklist, type ManagedOAuthRequest, type ManagedOAuthResponse } from '@recued/contracts';
import { createBulkAuthenticationAccessPanel } from '../connections/bulk-authentication-access-panel.js';
import { createReconnectWorklistPanel } from '../settings/reconnect-worklist-panel.js';
import type { ManagedOAuthCaller } from '../settings/managed-oauth-panel.js';
import { PickerElement } from './helpers/file-download-picker-dom.js';

afterEach(() => vi.useRealTimers());
const a = 'a'.repeat(64), b = 'b'.repeat(64), api = '1'.repeat(64), mail = '2'.repeat(64), files = '3'.repeat(64);
const fixture = () => {
  const root = new PickerElement(); let active: PickerElement | null = null; let slow = false; let serial = 0; const rejected = new Set<string>();
  const doc = { get activeElement() { return active; }, createElement: () => { const n = new PickerElement(); n.focus = () => { active = n; }; return n; } } as unknown as Document;
  const data: AuthenticationRepairWorklist = { observed_at: 1000, unavailable: [], groups: [
    { id: a, kind: 'account', label: 'Work Google', authentication: 'direct_oauth', connection_names: ['sheets'], issues: [], uses: [], usage_available: true,
      targets: [{ kind: 'connection', name: 'sheets' }, { kind: 'collection', platform: 'mail', slug: 'work' }] },
    { id: b, kind: 'account', label: 'Work Files', authentication: 'broker', connection_names: ['files'], issues: [], uses: [], usage_available: true, targets: [{ kind: 'file_source', source_id: 'work.files' }] },
    { id: 'c'.repeat(64), kind: 'app', label: 'App group', authentication: 'direct_oauth', connection_names: [], issues: [], uses: [], usage_available: true, targets: [{ kind: 'oauth_apps' }] },
  ] };
  const targets: AuthenticationAccessPreview['targets'] = [
    { id: api, target: data.groups[0]!.targets[0]!, label: 'Sheets', authentication_revision: a, check: 'api_read', base_url: 'https://sheets.googleapis.com/v4' },
    { id: mail, target: data.groups[0]!.targets[1]!, label: 'Mail', authentication_revision: a, check: 'collection_read' },
    { id: files, target: data.groups[1]!.targets[0]!, label: 'Files', authentication_revision: b, check: 'file_metadata', file_connection: { name: 'files', updated_at: 7 } },
  ];
  const plans = new Map<string, AuthenticationAccessPreview>(); const jobs = new Map<string, AuthenticationAccessVerification>();
  const normal = async (args: ManagedOAuthRequest): Promise<ManagedOAuthResponse> => {
    if (args.action === 'authentication_access_retire') return { action: args.action };
    if (args.action === 'authentication_access_preview') {
      const p: AuthenticationAccessPreview = { id: args.selection.kind === 'verification' ? 'r'.repeat(40) + (plans.size + 1).toString().padStart(3, '0') : args.selection.id[0]!.repeat(43), fingerprint: a, expires_at: Date.now() + 600000, selection: args.selection,
        label: 'Selected account review', targets_truncated: false, usage_available: true, uses: [], targets: args.selection.kind === 'verification'
          ? targets.filter(t => authenticationAccessRecheckResults(jobs.get(args.selection.id)!).some(r => r.id === t.id)) : targets.filter(t => args.selection.id === a ? t.id !== files : t.id === files) };
      plans.set(p.id, p); return { action: args.action, preview: structuredClone(p) };
    }
    if (args.action === 'file_authentication_files') return { action: args.action, choices: { source_id: 'work.files', connection_name: 'files', updated_at: 7, available: true, max_bytes: 10485760,
      files: [{ remote_id: 'chosen', filename: 'Report.pdf', output_filename: 'Report.pdf', mode: 'download', mime_type: 'application/pdf' }] } };
    if (args.action === 'authentication_access_run') {
      const p = plans.get(args.review_id)!;
      const value: AuthenticationAccessVerification = { id: 'verify-' + (++serial).toString(16).padStart(8, '0') + '-1234-4123-8123-123456789abc',
        selection: p.selection, status: slow ? 'checking' : 'completed', started_at: 1000 + serial * 100, ...(slow ? {} : { finished_at: 1050 + serial * 100 }),
        targets_truncated: false, uses: [], usage_available: true, results: p.targets.filter(t => args.target_ids!.includes(t.id)).map(t => ({ id: t.id, target: t.target, label: t.label,
          authentication_revision: t.authentication_revision, current: 'yes', checks: slow ? [{ kind: t.check === 'unsupported' ? 'api_read' : t.check, status: 'unconfirmed', reason: 'not_checked' }]
            : [{ kind: t.check === 'unsupported' ? 'api_read' : t.check, status: rejected.has(t.id) ? 'failed' : 'passed', ...(rejected.has(t.id) ? { reason: 'access_rejected' as const } : {}) },
              ...(t.check === 'file_metadata' ? [args.choices.some(c => c.target_id === t.id && c.file_id) ? { kind: 'file_download' as const, status: 'passed' as const }
                : { kind: 'file_download' as const, status: 'unconfirmed' as const, reason: 'resource_required' as const }] : []),
              { kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' }] })) };
      jobs.set(value.id, value); return { action: args.action, verification: structuredClone(value) };
    }
    if (args.action === 'authentication_access_status') return { action: args.action, verification: structuredClone(jobs.get(args.id)!) };
    throw Error('Unexpected action');
  };
  const call = vi.fn<ManagedOAuthCaller>(normal); const read = vi.fn(async () => {
    const value = structuredClone(data);
    for (const g of value.groups.filter(g => g.kind === 'account')) g.access_summary = { selection: { kind: 'group', id: g.id }, observed_at: 3000, targets_truncated: false, lookup_incomplete: false,
      targets: targets.filter(t => g.targets.some(target => JSON.stringify(target) === JSON.stringify(t.target))).map(t => {
        const source = [...jobs.values()].reverse().find(job => job.results.some(r => r.id === t.id)); const result = source?.results.find(r => r.id === t.id);
        if (t.target.kind === 'oauth_apps') throw Error('Unexpected app target');
        return { id: t.id, target: t.target, label: t.label, state: result ? 'checked' as const : 'not_checked' as const,
          ...(source && result ? { latest: { id: source.id, selection: source.selection, status: source.status, started_at: source.started_at,
            ...(source.finished_at !== undefined ? { finished_at: source.finished_at } : {}), result } } : {}) };
      }) };
    return value;
  });
  const panel = createBulkAuthenticationAccessPanel({ document: doc, read, call }); panel.mount(root as unknown as HTMLElement);
  const action = (id: string) => { const found = root.querySelector('[data-bulk-access-action="' + id + '"]'); if (!found) throw Error('Missing action ' + id); return found; };
  const select = (id: string) => { const input = root.querySelector('[data-bulk-access-account="' + id + '"]')!; input.checked = true; input.fire('change'); };
  const requests = (id: string) => call.mock.calls.map(([r]) => r).filter(r => r.action === id);
  return { root, doc, data, targets, jobs, call, normal, read, panel, action, select, requests, slow: () => { slow = true; }, reject: (...ids: string[]) => { rejected.clear(); ids.forEach(id => rejected.add(id)); } };
};
describe('multiple-account access review', () => {
  it('lists healthy accounts, excludes app navigation groups and does not prepare or run on open', async () => {
    const f = fixture(); await f.panel.open(); expect(f.read).toHaveBeenCalledTimes(1); expect(f.call).not.toHaveBeenCalled();
    expect(f.root.querySelectorAll('[data-bulk-access-account]')).toHaveLength(2); expect(f.root.textContent).toContain('Recued direct OAuth'); expect(f.root.textContent).toContain('Broker sign-in');
    expect(f.action('review').disabled).toBe(true); f.select(a); expect(f.panel.hasDraft()).toBe(true); f.panel.dispose();
  });
  it('requires one review and explicit Run, with fresh API and chosen-file inputs', async () => {
    const f = fixture(); await f.panel.open(); f.select(a); f.select(b); f.action('review').click(); await f.panel.whenLoaded();
    expect(f.requests('authentication_access_preview')).toHaveLength(2); expect(f.requests('authentication_access_run')).toHaveLength(0);
    expect(f.doc.activeElement).toBe(f.action('run'));
    const input = f.root.querySelector('[data-bulk-access-url="' + api + '"]')!; expect(input.value).toBe(''); input.value = 'https://sheets.googleapis.com/v4/spreadsheets/chosen'; input.fire('input');
    expect(f.requests('file_authentication_files')).toHaveLength(0); f.action('file-' + files).click(); await Promise.resolve(); await Promise.resolve();
    const choice = f.root.querySelector('[data-file-download-picker-choice="chosen"]')!; expect(choice).not.toBeNull(); choice.checked = true; choice.fire('change');
    f.root.querySelector('[data-file-download-picker-action="verify"]')!.click(); await Promise.resolve(); f.action('run').click(); await f.panel.whenLoaded();
    const starts = f.requests('authentication_access_run'); expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject({ target_ids: [api, mail], choices: [{ target_id: api, url: 'https://sheets.googleapis.com/v4/spreadsheets/chosen' }] });
    expect(starts[1]).toMatchObject({ target_ids: [files], choices: [{ target_id: files, file_id: 'chosen' }] });
    expect(f.root.textContent).toContain('Chosen file download/export: Passed'); expect(f.root.textContent).toContain('Sending, editing and other writes: Unconfirmed');
    expect(f.panel.hasDraft()).toBe(false); expect(f.panel.busy()).toBe(false); f.panel.dispose();
  });
  it('stops queued accounts before allowing Close and leaves started checks in history', async () => {
    vi.useFakeTimers(); const f = fixture(); f.slow(); await f.panel.open(); f.select(a); f.select(b); f.action('review').click(); await f.panel.whenLoaded();
    f.action('run').click(); await f.panel.whenLoaded(); expect(f.panel.busy()).toBe(true); expect(f.action('close').disabled).toBe(true);
    f.action('stop').click(); expect(f.panel.busy()).toBe(false); expect(f.panel.hasDraft()).toBe(false); f.action('close').click();
    await vi.advanceTimersByTimeAsync(30000); expect(f.requests('authentication_access_run')).toHaveLength(1); expect(f.root.textContent).toBe(''); f.panel.dispose();
  });
  it('keeps keyboard focus in the review after Stop and after cancelling file selection', async () => {
    vi.useFakeTimers(); const f = fixture(); f.slow(); await f.panel.open(); f.select(b); f.action('review').click(); await f.panel.whenLoaded();
    f.action('file-' + files).focus(); f.action('file-' + files).click(); await Promise.resolve(); await Promise.resolve();
    f.root.querySelector('[data-file-download-picker-action="cancel"]')!.click(); await Promise.resolve();
    expect(f.doc.activeElement).toBe(f.action('file-' + files));
    f.action('run').click(); await f.panel.whenLoaded(); f.action('stop').focus(); f.action('stop').click();
    expect(f.doc.activeElement).toBe(f.root.querySelector('[data-bulk-access]')); f.panel.dispose();
  });
  it('clears resource choices when reviewing again and restores the selected account checkboxes', async () => {
    const f = fixture(); await f.panel.open(); f.select(a); f.action('review').click(); await f.panel.whenLoaded();
    const input = f.root.querySelector('[data-bulk-access-url="' + api + '"]')!; input.value = 'https://sheets.googleapis.com/v4/old'; input.fire('input');
    f.action('again').click(); await f.panel.whenLoaded(); expect(f.root.querySelector('[data-bulk-access-account="' + a + '"]')!.checked).toBe(true);
    f.action('review').click(); await f.panel.whenLoaded(); expect(f.root.querySelector('[data-bulk-access-url="' + api + '"]')!.value).toBe(''); f.panel.dispose();
  });
  it('ignores a late local account list after Close and hides private errors', async () => {
    const f = fixture(); let release!: (value: AuthenticationRepairWorklist) => void; f.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = f.panel.open(); f.action('close').click(); release(f.data); await pending; expect(f.root.textContent).toBe('');
    f.read.mockRejectedValueOnce(new Error('private-secret')); await f.panel.open(); expect(f.root.textContent).toContain('Saved accounts could not be read'); expect(f.root.textContent).not.toContain('private-secret'); f.panel.dispose();
  });
  it('does not offer an empty review after a selected-account refresh fails', async () => {
    const f = fixture(); await f.panel.open(); f.select(a); f.action('review').click(); await f.panel.whenLoaded();
    f.read.mockRejectedValueOnce(new Error('offline')); f.action('again').click(); await f.panel.whenLoaded();
    expect(f.root.querySelectorAll('[data-bulk-access-account]')).toHaveLength(0); expect(f.action('review').disabled).toBe(true);
    expect(f.root.textContent).toContain('0 selected.'); expect(f.panel.hasDraft()).toBe(false); f.panel.dispose();
  });
  it('offers the worklist entry without extra reads and exposes its navigation draft', async () => {
    const f = fixture(); f.panel.dispose(); f.root.textContent = '';
    const parent = createReconnectWorklistPanel({ document: f.doc, repairs: f.read, verify: f.call }); parent.mount(f.root as unknown as HTMLElement); await parent.whenLoaded();
    expect(f.read).toHaveBeenCalledTimes(1); f.root.querySelector('[data-reconnect-worklist-action="bulk-access"]')!.click(); await parent.whenLoaded();
    expect(f.read).toHaveBeenCalledTimes(2); f.select(a); expect(parent.hasDraft()).toBe(true); expect(parent.busy()).toBe(false); parent.dispose();
  });
  it('retains the open resource form and focused input through a parent refresh', async () => {
    const f = fixture(); f.panel.dispose(); f.root.textContent = '';
    const parent = createReconnectWorklistPanel({ document: f.doc, repairs: f.read, verify: f.call }); parent.mount(f.root as unknown as HTMLElement); await parent.whenLoaded();
    f.root.querySelector('[data-reconnect-worklist-action="bulk-access"]')!.click(); await parent.whenLoaded(); f.select(a); f.action('review').click(); await parent.whenLoaded();
    const input = f.root.querySelector('[data-bulk-access-url="' + api + '"]')!; input.value = 'https://sheets.googleapis.com/v4/chosen'; input.fire('input'); input.focus();
    await parent.refresh();
    expect(f.root.querySelector('[data-bulk-access-url="' + api + '"]')).toBe(input); expect(f.doc.activeElement).toBe(input);
    expect(input.value).toBe('https://sheets.googleapis.com/v4/chosen'); parent.dispose();
  });
});

const completedBatch = async () => {
  const f = fixture(); f.reject(api); await f.panel.open(); f.select(a); f.select(b); f.action('review').click(); await f.panel.whenLoaded();
  f.action('run').click(); await f.panel.whenLoaded(); return f;
};
describe('bulk saved-read recheck UI', () => {
  it('compares a finished recheck with its original after a batch completes, without starting more reads', async () => {
    const f = await completedBatch(); const originals = [...f.jobs.values()]; f.reject();
    f.action('recheck-results').click(); await f.panel.whenLoaded(); f.action('review').click(); await f.panel.whenLoaded();
    expect(f.root.querySelectorAll('[data-access-compare]')).toHaveLength(0); f.action('run').click(); await f.panel.whenLoaded();
    expect(f.root.querySelectorAll('[data-access-compare]')).toHaveLength(2);
    const reads = f.requests('authentication_access_status').length; const starts = f.requests('authentication_access_run').length;
    f.root.querySelector('[data-access-compare]')!.click(); await f.panel.whenLoaded();
    expect(f.root.querySelectorAll('[data-access-comparison]')).toHaveLength(1); expect(f.requests('authentication_access_status')).toHaveLength(reads + 2);
    expect(f.requests('authentication_access_run')).toHaveLength(starts); expect(f.root.textContent).toContain('Original and recheck results');
    expect([...f.jobs.values()].slice(0, 2)).toEqual(originals); f.action('close').click(); expect(f.root.textContent).toBe(''); f.panel.dispose();
  });
  it('offers authentication shortcuts only in completed outcomes, leaving historical disclosures read-only', async () => {
    const f = await completedBatch(); const location = { hash: '' }; Object.assign(f.doc, { defaultView: { location } });
    const shortcut = f.root.querySelectorAll('[data-access-repair-shortcut]').find(n => n.textContent === 'Review API authentication')!;
    expect(shortcut).toBeDefined(); const reads = f.requests('authentication_access_status').length;
    shortcut.click(); await f.panel.whenLoaded(); expect(location.hash).toBe('#connections/others/review-access/api/sheets/from-access/' + [...f.jobs.values()][0]!.id + '/' + api);
    expect(f.requests('authentication_access_status')).toHaveLength(reads + 1); expect(f.requests('authentication_access_run')).toHaveLength(2);
    f.action('recheck-results').click(); await f.panel.whenLoaded(); f.action('review').click(); await f.panel.whenLoaded();
    expect(f.root.textContent).toContain('Earlier saved check'); expect(f.root.querySelectorAll('[data-access-repair-shortcut]')).toHaveLength(0); f.panel.dispose();
  });
  it('keeps shortcuts out of active queues and enables finished rows after Stop', async () => {
    const f = fixture(); f.reject(api); await f.panel.open(); f.select(a); f.select(b); f.action('review').click(); await f.panel.whenLoaded();
    const normal = f.normal; f.call.mockImplementation(async args => {
      if (args.action === 'authentication_access_run' && f.requests('authentication_access_run').length === 2) throw Error('lost start reply');
      return normal(args);
    });
    f.action('run').click(); await f.panel.whenLoaded(); expect(f.root.textContent).toContain('paused');
    expect(f.root.querySelectorAll('[data-access-repair-shortcut]')).toHaveLength(0);
    f.action('stop').click(); expect(f.root.querySelectorAll('[data-access-repair-shortcut]')).toHaveLength(1); f.panel.dispose();
  });
  it('opens latest non-passing sources from a finished batch, reviews fresh choices and preserves earlier passes', async () => {
    const f = await completedBatch(); const original = structuredClone([...f.jobs.values()]);
    f.action('recheck-results').click(); await f.panel.whenLoaded(); expect(f.root.textContent).toContain('Recheck saved reads');
    expect(f.root.textContent).toContain('2 selected.'); expect(f.requests('authentication_access_run')).toHaveLength(2);
    f.action('review').click(); await f.panel.whenLoaded(); expect(f.requests('authentication_access_run')).toHaveLength(2);
    expect(f.doc.activeElement).toBe(f.action('run')); expect(f.root.textContent).toContain('Earlier saved check');
    const input = f.root.querySelector('[data-bulk-access-url="' + api + '"]')!; expect(input.value).toBe('');
    input.value = 'https://sheets.googleapis.com/v4/fresh'; input.fire('input');
    f.action('file-' + files).click(); await Promise.resolve(); await Promise.resolve();
    const file = f.root.querySelector('[data-file-download-picker-choice="chosen"]')!; file.checked = true; file.fire('change');
    f.root.querySelector('[data-file-download-picker-action="verify"]')!.click(); await Promise.resolve(); f.reject();
    f.action('run').click(); await f.panel.whenLoaded();
    const runs = f.requests('authentication_access_run'); expect(runs.slice(2).map(r => r.action === 'authentication_access_run' && r.target_ids)).toEqual([[api], [files]]);
    expect([...f.jobs.values()].slice(0, 2)).toEqual(original); expect([...f.jobs.values()].slice(2).map(r => r.selection)).toEqual(original.map(r => ({ kind: 'verification', id: r.id })));
    expect(f.root.querySelector('[data-bulk-access-action="recheck-results"]')).toBeNull(); f.panel.dispose();
  });
  it('reopens rechecks from the chooser after closing, with no automatic selection or run', async () => {
    const f = await completedBatch(); f.action('close').click(); await f.panel.open(); f.action('mode').click(); await f.panel.whenLoaded();
    expect(f.root.textContent).toContain('Recheck saved reads'); expect(f.root.textContent).toContain('0 selected.');
    expect(f.root.querySelectorAll('[data-bulk-access-account]')).toHaveLength(2); expect(f.action('review').disabled).toBe(true);
    expect(f.requests('authentication_access_run')).toHaveLength(2); f.panel.dispose();
  });
  it('clears API URLs and file choices when reviewing saved reads again', async () => {
    const f = await completedBatch(); f.action('recheck-results').click(); await f.panel.whenLoaded(); f.action('review').click(); await f.panel.whenLoaded();
    const input = f.root.querySelector('[data-bulk-access-url="' + api + '"]')!; input.value = 'https://sheets.googleapis.com/v4/old'; input.fire('input');
    f.action('again').click(); await f.panel.whenLoaded(); expect(f.root.textContent).toContain('2 selected.'); f.action('review').click(); await f.panel.whenLoaded();
    expect(f.root.querySelector('[data-bulk-access-url="' + api + '"]')!.value).toBe(''); expect(f.action('file-' + files).textContent).toBe('Choose a file'); f.panel.dispose();
  });
  it('reports missing latest evidence without falling back to older failures', async () => {
    const f = await completedBatch(); f.read.mockResolvedValueOnce({ observed_at: 4000, unavailable: [], groups: [{ ...f.data.groups[0]!,
      access_verification: [...f.jobs.values()][0]!, access_summary: { selection: { kind: 'group', id: a }, observed_at: 4000, targets_truncated: false, lookup_incomplete: true, targets: [] } }] });
    f.action('recheck-results').click(); await f.panel.whenLoaded(); expect(f.root.querySelectorAll('[data-bulk-access-account]')).toHaveLength(0);
    expect(f.root.textContent).toContain('Some latest saved checks are unavailable'); expect(f.action('review').disabled).toBe(true); f.panel.dispose();
  });
  it('stops unstarted rechecks without starting them after closing', async () => {
    vi.useFakeTimers(); const f = await completedBatch(); f.action('recheck-results').click(); await f.panel.whenLoaded(); f.action('review').click(); await f.panel.whenLoaded(); f.slow();
    f.action('run').click(); await f.panel.whenLoaded(); expect(f.panel.busy()).toBe(true); f.action('stop').click(); f.action('close').click();
    await vi.advanceTimersByTimeAsync(30000); expect(f.requests('authentication_access_run')).toHaveLength(3); expect(f.root.textContent).toBe(''); f.panel.dispose();
  });
  it.each(['passed', 'failed', 'checking'] as const)('refreshes the selected latest reads before review when another check has %s', async state => {
    const f = await completedBatch(); f.action('recheck-results').click(); await f.panel.whenLoaded();
    const source = [...f.jobs.values()][0]!; const newer = structuredClone(source); newer.id = 'verify-00000009-1234-4123-8123-123456789abc';
    newer.selection = { kind: 'verification', id: source.id }; newer.results = newer.results.filter(r => r.id === api);
    newer.results[0]!.checks = state === 'passed' ? [{ kind: 'api_read', status: 'passed' }] : [{ kind: 'api_read', status: state === 'failed' ? 'failed' : 'unconfirmed', reason: state === 'failed' ? 'access_rejected' : 'not_checked' }];
    if (state === 'checking') { newer.status = 'checking'; delete newer.finished_at; }
    f.jobs.set(newer.id, newer); const before = f.requests('authentication_access_preview').length;
    f.action('review').click(); await f.panel.whenLoaded();
    expect(f.root.textContent).toContain('Saved results changed'); expect(f.requests('authentication_access_preview')).toHaveLength(before);
    expect(f.root.textContent).toContain('1 selected.'); expect(f.requests('authentication_access_run')).toHaveLength(2);
    f.action('review').click(); await f.panel.whenLoaded(); expect(f.root.querySelector('[data-bulk-access-url="' + api + '"]')).toBeNull();
    f.action('run').click(); await f.panel.whenLoaded(); const last = f.requests('authentication_access_run').at(-1)!;
    expect(last).toMatchObject({ target_ids: [files] }); f.panel.dispose();
  });
  it('requires another review when the same selected source has fewer latest failed resources', async () => {
    const f = await completedBatch(); const source = [...f.jobs.values()][0]!;
    source.results.find(r => r.id === mail)!.checks = [{ kind: 'collection_read', status: 'failed', reason: 'access_rejected' }];
    f.action('recheck-results').click(); await f.panel.whenLoaded();
    const newer = structuredClone(source); newer.id = 'verify-00000009-1234-4123-8123-123456789abc'; newer.selection = { kind: 'verification', id: source.id };
    newer.results = newer.results.filter(r => r.id === api); newer.results[0]!.checks = [{ kind: 'api_read', status: 'passed' }]; f.jobs.set(newer.id, newer);
    f.action('review').click(); await f.panel.whenLoaded(); expect(f.root.textContent).toContain('Saved results changed'); expect(f.root.textContent).toContain('2 selected.');
    f.action('review').click(); await f.panel.whenLoaded(); f.action('run').click(); await f.panel.whenLoaded();
    expect(f.requests('authentication_access_run').slice(2).map(r => r.action === 'authentication_access_run' && r.target_ids)).toEqual([[mail], [files]]); f.panel.dispose();
  });
  it('retains expanded earlier results and their keyboard focus while polling saved progress', async () => {
    vi.useFakeTimers(); const f = await completedBatch(); f.action('recheck-results').click(); await f.panel.whenLoaded(); f.action('review').click(); await f.panel.whenLoaded();
    f.slow(); f.action('run').click(); await f.panel.whenLoaded();
    const earlier = () => f.root.querySelectorAll('[data-bulk-access-row]')[0]!.children.find(n => n.children[0]?.ownText === 'Earlier saved check')!;
    Reflect.set(earlier(), 'open', true); earlier().children[0]!.focus(); await vi.advanceTimersByTimeAsync(1500);
    expect(Reflect.get(earlier(), 'open')).toBe(true); expect(f.doc.activeElement).toBe(earlier().children[0]); f.panel.dispose();
  });
  it('does not prepare sources when the latest-list refresh fails and supports a local retry', async () => {
    const f = await completedBatch(); f.action('recheck-results').click(); await f.panel.whenLoaded(); const before = f.requests('authentication_access_preview').length;
    f.read.mockRejectedValueOnce(Error('private refresh failure')); f.action('review').click(); await f.panel.whenLoaded();
    expect(f.root.textContent).toContain('Saved results could not be refreshed'); expect(f.root.textContent).not.toContain('private refresh failure');
    expect(f.requests('authentication_access_preview')).toHaveLength(before); expect(f.panel.hasDraft()).toBe(true);
    f.action('review').click(); await f.panel.whenLoaded(); expect(f.requests('authentication_access_preview')).toHaveLength(before + 2); expect(f.requests('authentication_access_run')).toHaveLength(2); f.panel.dispose();
  });
  it('ignores a late latest-list refresh after Close and reopening the ordinary chooser', async () => {
    const f = await completedBatch(); f.action('recheck-results').click(); await f.panel.whenLoaded(); let release!: (value: AuthenticationRepairWorklist) => void;
    f.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })); f.action('review').click(); const pending = f.panel.whenLoaded();
    f.action('close').click(); await f.panel.open(); release(f.data); await pending;
    expect(f.root.querySelector('[data-bulk-access-mode="accounts"]')).not.toBeNull(); expect(f.root.textContent).toContain('0 selected.');
    expect(f.requests('authentication_access_preview')).toHaveLength(2); expect(f.requests('authentication_access_run')).toHaveLength(2); f.panel.dispose();
  });
});

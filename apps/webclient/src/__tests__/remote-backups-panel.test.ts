import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArchiveBackupHealthStatus, ArchiveBackupIntegrityStatus, ArchiveRemoteBackup, ArchiveRemoteDestination, ArchiveRestoreDrill, ArchiveUnattendedStatus, BackupWatchdogStatus } from '@recued/contracts';
import { mountRemoteBackups, type RemoteBackupsPorts } from '../settings/remote-backups-panel.js';
import { PickerElement } from './helpers/file-download-picker-dom.js';

const destination: ArchiveRemoteDestination = { connection_name: 'safe', destination_id: 'a'.repeat(64), bucket: 'backup-bucket', region: 'us-east-1', endpoint: 'https://s3.example.test', prefix: '' };
const receipt: ArchiveRemoteBackup = { operation_id: '12345678-1234-4234-8234-123456789abc', job_id: 'job-1', destination, object_key: 'recued-backups/example/archive', created_at: 1_700_000_000_000, state: 'verified', keep_last: 5, bytes: 8000, sha256: 'b'.repeat(64), verified_at: 1_700_000_000_001 };
const stage = `recued-upload-${'a'.repeat(32)}.recued.archive`;
const healthStatus: ArchiveBackupHealthStatus = { checked_at: 1_700_000_000_000, monitoring: 'active', destination, watched_since: 1,
  policy: { alerts_enabled: true, backup_max_age_hours: 36, recovery_max_age_days: 30 }, alerts: [], backup: { state: 'waiting', due_at: 1_700_100_000_000 }, recovery: { state: 'waiting', due_at: 1_700_200_000_000 } };
const integrityStatus: ArchiveBackupIntegrityStatus = { monitoring: 'active', destination, next_run_at: 1_700_100_000_000,
  policy: { enabled: true, schedule: { cadence: 'weekly', hour_utc: 3, minute_utc: 0, weekday_utc: 0 } } };
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); vi.useRealTimers(); });
const setup = async (overrides: Partial<RemoteBackupsPorts> = {}) => {
  // Match native node movement and document focus, which the small picker
  // fixture does not otherwise need to model.
  let focused: PickerElement | null = null;
  class Element extends PickerElement {
    parent: Element | undefined; tagName = '';
    get parentElement(): Element | undefined { return this.parent; }
    override appendChild(child: Element): Element { child.parent?.removeChild(child); super.appendChild(child); child.parent = this; return child; }
    override removeChild(child: Element): Element { super.removeChild(child); child.parent = undefined; return child; }
    override focus(): void { focused = this; }
  }
  const host = new Element();
  const document = { createElement: (tag: string) => { const node = new Element(); node.tagName = tag.toUpperCase(); return node; }, get activeElement() { return focused; } } as unknown as Document;
  const onRestore = vi.fn(() => true), retrieve = vi.fn(async () => ({ staged_name: stage }));
  const ports: RemoteBackupsPorts = { destinations: async () => ({ destinations: [destination] }), list: async () => ({ backups: [receipt] }), check: async () => ({ ...receipt, state: 'verifying' }), retrieve, ...overrides };
  const mounted = mountRemoteBackups({ host: host as unknown as HTMLElement, document, ports, onRestore }); disposals.push(() => mounted.dispose());
  const node = (attr: string) => { const value = host.querySelector(`[${attr}]`); if (!value) throw new Error(`Missing ${attr}`); return value; };
  await vi.waitFor(() => expect(host.querySelector('[data-remote-backup-check]')).not.toBeNull());
  return { host, document, node, mounted, onRestore, retrieve };
};
const preparePreview = async (h: Awaited<ReturnType<typeof setup>>) => {
  const button = h.node('data-remote-backup-restore'); button.focus(); button.click();
  await vi.waitFor(() => expect(button.textContent).toBe('Open restore preview')); return button;
};

describe('remote backup selection and restore continuity', () => {
  it('starts with extra tools closed and reveals review destinations without writing or losing drafts', async () => {
    const save = vi.fn(), h = await setup({ unattended: { get: async () => ({ configured: false }), save },
      health: { get: async () => healthStatus, save }, integrity: { get: async () => integrityStatus, save },
      drills: { list: async () => ({ drills: [] }), start: vi.fn(), cancel: vi.fn(), cleanup: vi.fn() } });
    const tools = h.host.querySelector('[data-backup-disclosure="tools"]')!, schedule = h.host.querySelector('[data-backup-disclosure="schedule"]')!;
    const storage = h.host.querySelector('[data-backup-disclosure="manual-storage"]')!;
    expect(tools.open).toBe(false); expect(schedule.open).toBe(false); expect(storage.open).toBe(false);
    expect(tools.contains(h.node('data-remote-backup-restore'))).toBe(false);
    expect(schedule.contains(h.node('data-unattended-status'))).toBe(false);
    h.mounted.focusReadinessItem('schedule'); expect(schedule.open).toBe(true); expect(h.document.activeElement).toBe(h.node('data-unattended-enabled'));
    const words = h.node('data-unattended-words'); words.value = 'synthetic draft key'; words.fire('input'); schedule.open = false;
    h.mounted.focusReadinessItem('integrity'); expect(tools.open).toBe(true); expect(h.document.activeElement).toBe(h.node('data-backup-integrity-enabled'));
    tools.open = false; await h.mounted.refresh();
    expect(tools.open).toBe(false); expect(schedule.open).toBe(false); expect(h.node('data-unattended-words')).toBe(words); expect(words.value).toBe('synthetic draft key');
    h.node('data-remote-backup-drill').click(); expect(tools.open).toBe(true); expect(h.document.activeElement).toBe(h.node('data-drill-words'));
    expect(save).not.toHaveBeenCalled(); expect(h.retrieve).not.toHaveBeenCalled(); expect(h.onRestore).not.toHaveBeenCalled();
  });

  it('surfaces hidden health and integrity problems and clears the notice only when every current result is healthy', async () => {
    let health = healthStatus, integrity = integrityStatus;
    const h = await setup({ health: { get: async () => health, save: vi.fn() }, integrity: { get: async () => integrity, save: vi.fn() } });
    const tools = h.host.querySelector('[data-backup-disclosure="tools"]')!, notice = h.node('data-backup-tools-attention');
    expect(notice).toHaveProperty('hidden', true);
    health = { ...healthStatus, backup: { state: 'due', due_at: 1 } }; integrity = { ...integrityStatus, monitoring: 'unavailable' };
    await h.mounted.refresh(); expect(notice).toHaveProperty('hidden', false); expect(tools.open).toBe(false);
    expect(tools.children[0]!.textContent).toContain('Needs attention');
    health = healthStatus; await h.mounted.refresh(); expect(notice).toHaveProperty('hidden', false);
    integrity = integrityStatus; await h.mounted.refresh(); expect(notice).toHaveProperty('hidden', true); expect(tools.open).toBe(false);
  });

  it('surfaces an unreadable tools status and keeps the disclosure choice while its refresh recovers', async () => {
    const get = vi.fn(async () => healthStatus), h = await setup({ health: { get, save: vi.fn() } });
    const tools = h.host.querySelector('[data-backup-disclosure="tools"]')!, notice = h.node('data-backup-tools-attention');
    get.mockRejectedValueOnce(new Error('private provider failure')); await h.mounted.refresh();
    expect(notice).toHaveProperty('hidden', false); expect(h.host.textContent).not.toContain('private provider failure');
    notice.children[1]!.focus(); notice.children[1]!.click(); expect(tools.open).toBe(true); expect(h.document.activeElement).toBe(tools.children[0]);
    notice.children[1]!.focus(); await h.mounted.refresh(); expect(notice).toHaveProperty('hidden', true); expect(tools.open).toBe(true);
    expect(h.document.activeElement).toBe(tools.children[0]);
  });

  it('exposes cleanup once without reopening details against owner intent on every refresh', async () => {
    const h = await setup({ list: async () => ({ backups: [{ ...receipt, state: 'unconfirmed', multipart_cleanup_pending: true }] }) });
    const details = h.node('data-remote-backup-details'); expect(details.open).toBe(true); details.open = false;
    await h.mounted.refresh(); expect(details.open).toBe(false); expect(h.node('data-remote-backup-cleanup-note')).toHaveProperty('hidden', false);
  });

  it('surfaces recovery cleanup and only the latest failed test, allowing a later passing test to clear the warning', async () => {
    const failed: ArchiveRestoreDrill = { operation_id: 'drill-1', backup_operation_id: receipt.operation_id, destination_id: destination.destination_id,
      archive_sha256: receipt.sha256!, archive_bytes: receipt.bytes!, started_at: 1, state: 'failed', issue: 'retrieval_failed' };
    let drills = [failed];
    const h = await setup({ drills: { list: async () => ({ drills }), start: vi.fn(), cancel: vi.fn(), cleanup: vi.fn() } });
    const notice = h.node('data-backup-tools-attention'); expect(notice).toHaveProperty('hidden', false);
    drills = [failed, { ...failed, operation_id: 'drill-2', started_at: 2, state: 'succeeded', issue: undefined }];
    await h.mounted.refresh(); expect(notice).toHaveProperty('hidden', true);
    drills = [{ ...failed, cleanup_pending: true }, drills[1]!]; await h.mounted.refresh(); expect(notice).toHaveProperty('hidden', false);
  });

  it.each(['finished', 'different_failure', 'stale_issue'] as const)('shows cleanup access guidance and an encoded connection link, then removes it after %s without losing focus', async outcome => {
    const denied: ArchiveRemoteBackup = { ...receipt, destination: { ...destination, connection_name: 'safe/archive #?' },
      state: 'unconfirmed', verified_at: undefined, multipart_cleanup_pending: true, multipart_cleanup_issue: 'permission_denied' };
    let backups = [denied]; const check = vi.fn<RemoteBackupsPorts['check']>(), h = await setup({ list: async () => ({ backups }), check });
    const link = h.node('data-remote-backup-cleanup-connection'), note = h.node('data-remote-backup-cleanup-note');
    expect(note.textContent).toContain('Storage denied access'); expect(note.textContent).toContain('permissions');
    expect(link).toHaveProperty('hidden', false); expect(link.getAttribute('href')).toBe('#connections/others/review-access/api/safe%2Farchive%20%23%3F');
    expect(link.textContent).toBe('Review storage connection'); link.focus(); await h.mounted.refresh();
    expect(h.node('data-remote-backup-cleanup-connection')).toBe(link); expect(h.document.activeElement).toBe(link);
    backups = [{ ...denied, multipart_cleanup_pending: outcome === 'different_failure' ? true : undefined,
      multipart_cleanup_issue: outcome === 'stale_issue' ? 'permission_denied' : undefined }];
    await h.mounted.refresh();
    expect(link).toHaveProperty('hidden', true); expect(link.getAttribute('href')).toBeNull(); expect(note.textContent).not.toContain('Storage denied access');
    expect(h.document.activeElement).toBe(h.node('data-remote-backup-check')); expect(h.node('data-remote-backup-restore').getAttribute('aria-disabled')).toBe('true');
    expect(check).not.toHaveBeenCalled(); expect(h.retrieve).not.toHaveBeenCalled(); expect(h.onRestore).not.toHaveBeenCalled();
  });

  it('shows pending upload cleanup through its check acknowledgment, then clears it without verifying the absent copy or moving focus', async () => {
    vi.useFakeTimers();
    const pending: ArchiveRemoteBackup = { ...receipt, state: 'unconfirmed', verified_at: undefined, issue: 'interrupted', multipart_cleanup_pending: true };
    let backups = [pending];
    const check = vi.fn(async () => ({ ...pending, state: 'verifying' as const }));
    const h = await setup({ list: async () => ({ backups }), check }), button = h.node('data-remote-backup-check');
    const row = h.host.querySelector(`[data-remote-backup-id="${receipt.operation_id}"]`)!, note = h.node('data-remote-backup-cleanup-note');
    expect(row.getAttribute('data-remote-backup-cleanup-pending')).toBe('true'); expect(h.host.textContent).toContain('Upload cleanup pending');
    expect(note).toHaveProperty('hidden', false); expect(note.textContent).toContain('cleanup is not confirmed');
    expect(button.textContent).toBe('Retry upload cleanup'); button.focus(); button.click();
    await vi.waitFor(() => expect(row.getAttribute('data-remote-backup-state')).toBe('verifying'));
    expect(row.getAttribute('data-remote-backup-cleanup-pending')).toBe('true'); expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(check).toHaveBeenCalledExactlyOnceWith({ operation_id: receipt.operation_id });
    backups = [{ ...pending, multipart_cleanup_pending: undefined, issue: 'verification_failed' }];
    await vi.advanceTimersByTimeAsync(250);
    expect(row.getAttribute('data-remote-backup-state')).toBe('unconfirmed'); expect(row.getAttribute('data-remote-backup-cleanup-pending')).toBe('false');
    expect(note).toHaveProperty('hidden', true); expect(note.textContent).toBe(''); expect(h.host.textContent).not.toContain('Upload cleanup pending');
    expect(button.textContent).toBe('Check stored copy'); expect(button.getAttribute('aria-disabled')).toBe('false');
    expect(h.node('data-remote-backup-restore').getAttribute('aria-disabled')).toBe('true');
    expect(h.node('data-remote-backup-check')).toBe(button); expect(h.document.activeElement).toBe(button);
    expect(h.retrieve).not.toHaveBeenCalled(); expect(h.onRestore).not.toHaveBeenCalled();
  });

  it('keeps cleanup pending after a lost check response and blocks another cleanup request until a successful status refresh', async () => {
    vi.useFakeTimers();
    const pending: ArchiveRemoteBackup = { ...receipt, state: 'unconfirmed', verified_at: undefined, multipart_cleanup_pending: true, multipart_cleanup_issue: 'permission_denied' };
    const list = vi.fn(async () => ({ backups: [pending] }));
    const check = vi.fn<RemoteBackupsPorts['check']>().mockRejectedValueOnce(new Error('private provider detail'))
      .mockResolvedValue({ ...pending, state: 'verifying' });
    const h = await setup({ list, check }), button = h.node('data-remote-backup-check');
    list.mockRejectedValueOnce(new Error('private status detail')); button.focus(); button.click();
    await vi.waitFor(() => expect(h.host.textContent).toContain('check could not be confirmed'));
    await vi.advanceTimersByTimeAsync(250); expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(h.host.textContent).toContain('Upload cleanup pending'); expect(h.node('data-remote-backup-cleanup-note')).toHaveProperty('hidden', false);
    expect(h.node('data-remote-backup-cleanup-note').textContent).toContain('Storage denied access');
    expect(h.node('data-remote-backup-cleanup-connection')).toHaveProperty('hidden', false);
    button.click(); expect(check).toHaveBeenCalledOnce();
    await h.mounted.refresh(); expect(button.getAttribute('aria-disabled')).toBe('false'); expect(button.textContent).toBe('Retry upload cleanup');
    button.click(); await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(h.node('data-remote-backup-cleanup-pending').getAttribute('data-remote-backup-state')).toBe('verifying'));
    expect(h.host.textContent).toContain('Upload cleanup pending'); expect(h.host.textContent).not.toContain('private provider detail');
    expect(h.host.textContent).not.toContain('private status detail'); expect(h.document.activeElement).toBe(button);
    expect(h.retrieve).not.toHaveBeenCalled(); expect(h.onRestore).not.toHaveBeenCalled();
  });

  it.each(['verified', 'unconfirmed'] as const)('keeps a newer copy check when an older %s history read finishes afterward', async state => {
    vi.useFakeTimers(); const initial = { ...receipt, state }, checked = { ...receipt, state: 'verifying' as const };
    const destinations = vi.fn(async () => ({ destinations: [destination] })), list = vi.fn(async () => ({ backups: [initial] }));
    const check = vi.fn(async () => checked), h = await setup({ destinations, list, check });
    let finish!: (value: { destinations: ArchiveRemoteDestination[] }) => void;
    destinations.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const reading = h.mounted.refresh(); await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    const button = h.node('data-remote-backup-check'), row = h.host.querySelector(`[data-remote-backup-id="${receipt.operation_id}"]`)!;
    button.focus(); button.click(); await vi.waitFor(() => expect(row.getAttribute('data-remote-backup-state')).toBe('verifying'));
    finish({ destinations: [destination] }); await reading;
    expect(row.getAttribute('data-remote-backup-state')).toBe('verifying'); expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(h.node('data-remote-backup-restore').getAttribute('aria-disabled')).toBe('true'); expect(h.document.activeElement).toBe(button);
    expect(check).toHaveBeenCalledOnce(); expect(h.retrieve).not.toHaveBeenCalled(); expect(h.onRestore).not.toHaveBeenCalled();
  });

  for (const oldFirst of [true, false]) for (const outcome of ['success', 'failure'] as const) {
    it(`coalesces one current history read around a check and an older ${outcome} read (old first: ${oldFirst})`, async () => {
      vi.useFakeTimers(); let backups = [receipt], finishCheck!: (value: ArchiveRemoteBackup) => void;
      let finishRead!: (value: { destinations: ArchiveRemoteDestination[] }) => void, failRead!: (error: Error) => void;
      const destinations = vi.fn(async () => ({ destinations: [destination] })), list = vi.fn(async () => ({ backups }));
      const check = vi.fn(() => new Promise<ArchiveRemoteBackup>(resolve => { finishCheck = resolve; })), h = await setup({ destinations, list, check });
      destinations.mockImplementationOnce(() => new Promise((resolve, reject) => { finishRead = resolve; failRead = reject; }));
      const reading = h.mounted.refresh(); await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
      const button = h.node('data-remote-backup-check'), row = h.host.querySelector(`[data-remote-backup-id="${receipt.operation_id}"]`)!;
      button.focus(); button.click(); await h.mounted.refresh(); await h.mounted.refresh();
      expect(h.node('data-remote-backups-refresh').textContent).toContain('Waiting'); expect(list).toHaveBeenCalledTimes(2);
      const settleRead = () => outcome === 'success' ? finishRead({ destinations: [destination] }) : failRead(new Error('private old read failure'));
      if (oldFirst) { settleRead(); await reading; expect(h.host.textContent).toContain('Checking the stored copy'); }
      finishCheck({ ...receipt, state: 'verifying' }); await vi.waitFor(() => expect(row.getAttribute('data-remote-backup-state')).toBe('verifying'));
      if (!oldFirst) { settleRead(); await reading; }
      expect(row.getAttribute('data-remote-backup-state')).toBe('verifying'); expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(list).toHaveBeenCalledTimes(2); expect(h.host.textContent).not.toContain('Storage choices and history could not be checked');
      backups = [{ ...receipt, verified_at: receipt.verified_at! + 1 }]; await vi.advanceTimersByTimeAsync(250);
      expect(list).toHaveBeenCalledTimes(3); expect(destinations).toHaveBeenCalledTimes(3); expect(check).toHaveBeenCalledOnce();
      expect(row.getAttribute('data-remote-backup-state')).toBe('verified'); expect(button.getAttribute('aria-disabled')).toBe('false');
      expect(h.node('data-remote-backups-refresh').getAttribute('aria-busy')).toBe('false'); expect(h.document.activeElement).toBe(button);
      expect(h.host.textContent).not.toContain('private old read failure'); expect(h.retrieve).not.toHaveBeenCalled();
    });
  }

  it.each(['rejected', 'mismatched', 'synchronous'] as const)('blocks retry of a %s check until a current history read succeeds', async mode => {
    vi.useFakeTimers(); const list = vi.fn(async () => ({ backups: [receipt] }));
    const check = vi.fn<RemoteBackupsPorts['check']>().mockImplementationOnce(() => {
      if (mode === 'synchronous') throw new Error('private check failure');
      return mode === 'mismatched' ? Promise.resolve({ ...receipt, operation_id: '22345678-1234-4234-8234-123456789abc' }) : Promise.reject(new Error('private check failure'));
    }).mockResolvedValue({ ...receipt, state: 'verifying' });
    const h = await setup({ list, check, drills: { list: async () => ({ drills: [] }), start: vi.fn(), cancel: vi.fn(), cleanup: vi.fn() } });
    list.mockRejectedValueOnce(new Error('private current read failure'));
    const button = h.node('data-remote-backup-check'); button.focus(); button.click();
    await vi.waitFor(() => expect(h.host.textContent).toContain('check could not be confirmed'));
    expect(button.getAttribute('aria-disabled')).toBe('true'); expect(h.node('data-remote-backup-restore').getAttribute('aria-disabled')).toBe('true');
    expect(h.node('data-remote-backup-drill').getAttribute('aria-disabled')).toBe('true');
    await vi.advanceTimersByTimeAsync(250); expect(h.node('data-remote-backups-status').textContent).toContain('could not be checked');
    expect(h.node('data-remote-backups-refresh').getAttribute('aria-busy')).toBe('false'); button.click(); button.click(); expect(check).toHaveBeenCalledOnce();
    await h.mounted.refresh(); expect(button.getAttribute('aria-disabled')).toBe('false'); expect(h.document.activeElement).toBe(button);
    expect(h.host.textContent).toContain('check could not be confirmed'); expect(h.host.textContent).not.toContain('private check failure'); expect(h.host.textContent).not.toContain('private current read failure');
    button.click(); await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(2)); expect(h.retrieve).not.toHaveBeenCalled(); expect(h.onRestore).not.toHaveBeenCalled();
  });

  it('keeps an already prepared local preview available while an uncertain check waits for fresh remote history', async () => {
    vi.useFakeTimers(); const check = vi.fn<RemoteBackupsPorts['check']>().mockRejectedValue(new Error('private check failure'));
    const h = await setup({ check }), preview = await preparePreview(h); h.node('data-remote-backup-check').click();
    await vi.waitFor(() => expect(h.host.textContent).toContain('check could not be confirmed'));
    expect(h.node('data-remote-backup-check').getAttribute('aria-disabled')).toBe('true'); expect(preview.getAttribute('aria-disabled')).toBe('false');
    preview.click(); expect(h.onRestore).toHaveBeenCalledExactlyOnceWith(stage); expect(h.retrieve).toHaveBeenCalledOnce(); expect(check).toHaveBeenCalledOnce();
    expect(h.host.textContent).toContain('check could not be confirmed');
  });

  it.each(['success', 'failure'] as const)('ignores a late %s check after leaving the route and does not schedule reconciliation', async outcome => {
    vi.useFakeTimers(); let finish!: (value: ArchiveRemoteBackup) => void, fail!: (error: Error) => void;
    const list = vi.fn(async () => ({ backups: [receipt] })), check = vi.fn(() => new Promise<ArchiveRemoteBackup>((resolve, reject) => { finish = resolve; fail = reject; }));
    const h = await setup({ list, check }), button = h.node('data-remote-backup-check'); button.click(); h.mounted.dispose(); const before = h.host.textContent;
    if (outcome === 'success') finish({ ...receipt, state: 'verifying' }); else fail(new Error('private late failure'));
    await vi.advanceTimersByTimeAsync(1_000); button.click(); expect(h.host.textContent).toBe(before);
    expect(list).toHaveBeenCalledOnce(); expect(check).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores an old check control after the current history removes its row', async () => {
    vi.useFakeTimers(); let backups = [receipt]; const check = vi.fn(async () => receipt);
    const h = await setup({ list: async () => ({ backups }), check }), button = h.node('data-remote-backup-check'); button.click();
    await vi.waitFor(() => expect(check).toHaveBeenCalledOnce()); backups = []; await vi.advanceTimersByTimeAsync(250);
    expect(h.host.querySelector('[data-remote-backup-check]')).toBeNull(); button.click(); expect(check).toHaveBeenCalledOnce();
  });

  it('waits for concurrent check requests on different rows before one reconciliation read', async () => {
    vi.useFakeTimers(); const other = { ...receipt, operation_id: '22345678-1234-4234-8234-123456789abc' };
    let backups = [receipt, other]; const finishes = new Map<string, (value: ArchiveRemoteBackup) => void>();
    const list = vi.fn(async () => ({ backups })), check = vi.fn<RemoteBackupsPorts['check']>(({ operation_id }) => new Promise(resolve => { finishes.set(operation_id, resolve); }));
    const h = await setup({ list, check }), first = h.node('data-remote-backup-check');
    const second = h.host.querySelector(`[data-remote-backup-id="${other.operation_id}"]`)!.querySelector('[data-remote-backup-check]')!;
    first.click(); second.click(); await h.mounted.refresh(); await h.mounted.refresh(); expect(list).toHaveBeenCalledOnce();
    finishes.get(receipt.operation_id)!({ ...receipt, state: 'verifying' }); await vi.advanceTimersByTimeAsync(250); expect(list).toHaveBeenCalledOnce();
    finishes.get(other.operation_id)!({ ...other, state: 'verifying' }); backups = backups.map(row => ({ ...row, state: 'verifying' }));
    await vi.advanceTimersByTimeAsync(250); expect(list).toHaveBeenCalledTimes(2); expect(check).toHaveBeenCalledTimes(2);
    expect(first.getAttribute('aria-disabled')).toBe('true'); expect(second.getAttribute('aria-disabled')).toBe('true');
  });

  it('expires restore preview readiness at its deadline without moving focus or requesting work', async () => {
    vi.useFakeTimers(); const h = await setup(), button = await preparePreview(h);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(button.textContent).toBe('Prepare a restore again'); expect(button.getAttribute('aria-disabled')).toBe('false');
    expect(h.node('data-remote-backup-preview-status').textContent).toContain('preparation expired');
    expect(h.node('data-remote-backup-restore')).toBe(button); expect(h.document.activeElement).toBe(button);
    expect(h.retrieve).toHaveBeenCalledOnce(); expect(h.onRestore).not.toHaveBeenCalled();
  });

  it('handles an expired Open click before requesting another preparation when the deadline timer has not run', async () => {
    vi.useFakeTimers(); const h = await setup(), button = await preparePreview(h);
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1); button.click();
    expect(h.retrieve).toHaveBeenCalledOnce(); expect(h.onRestore).not.toHaveBeenCalled();
    expect(button.textContent).toBe('Prepare a restore again'); expect(h.document.activeElement).toBe(button);
    button.click(); expect(h.retrieve).toHaveBeenCalledTimes(2); expect(h.onRestore).not.toHaveBeenCalled();
  });

  it('keeps the original preparation deadline through history refreshes and starts a new deadline only after explicit preparation', async () => {
    vi.useFakeTimers(); const h = await setup(), button = await preparePreview(h);
    await vi.advanceTimersByTimeAsync(120_000); await h.mounted.refresh(); expect(button.textContent).toBe('Open restore preview');
    await vi.advanceTimersByTimeAsync(180_000); expect(button.textContent).toBe('Prepare a restore again'); expect(h.retrieve).toHaveBeenCalledOnce();
    button.click(); await vi.waitFor(() => expect(button.textContent).toBe('Open restore preview'));
    expect(h.retrieve).toHaveBeenCalledTimes(2); expect(h.onRestore).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120_000); expect(button.textContent).toBe('Open restore preview');
    button.click(); expect(h.onRestore).toHaveBeenCalledExactlyOnceWith(stage);
    await vi.advanceTimersByTimeAsync(180_000); expect(button.textContent).toBe('Prepare a restore again'); expect(h.retrieve).toHaveBeenCalledTimes(2);
  });

  it.each(['elapsed', 'delayed timer'] as const)('refuses preparation of a pruned copy after preview expiry (%s)', async mode => {
    vi.useFakeTimers(); let backups = [receipt]; const h = await setup({ list: async () => ({ backups }) }), button = await preparePreview(h);
    backups = [{ ...receipt, state: 'pruned' }]; await h.mounted.refresh(); expect(button.textContent).toBe('Open restore preview');
    expect(button.getAttribute('aria-disabled')).toBe('false');
    if (mode === 'elapsed') await vi.advanceTimersByTimeAsync(5 * 60_000);
    else { vi.setSystemTime(Date.now() + 5 * 60_000 + 1); button.click(); }
    expect(button.textContent).toBe('Prepare a restore again'); expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(h.node('data-remote-backup-preview-status').textContent).toContain('no longer verified');
    button.click(); expect(h.retrieve).toHaveBeenCalledOnce(); expect(h.onRestore).not.toHaveBeenCalled(); expect(h.document.activeElement).toBe(button);
  });

  it('keeps copy-check progress and its focus when preview preparation expires', async () => {
    vi.useFakeTimers(); let finish!: (value: ArchiveRemoteBackup) => void;
    const check = vi.fn(() => new Promise<ArchiveRemoteBackup>(resolve => { finish = resolve; }));
    const h = await setup({ check }); await preparePreview(h); const control = h.node('data-remote-backup-check'); control.focus(); control.click();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.host.textContent).toContain('Checking the stored copy…'); expect(h.node('data-remote-backup-preview-status').textContent).toContain('preparation expired');
    expect(h.document.activeElement).toBe(control); expect(check).toHaveBeenCalledOnce(); expect(h.retrieve).toHaveBeenCalledOnce(); expect(h.onRestore).not.toHaveBeenCalled();
    finish({ ...receipt, state: 'unconfirmed' }); await vi.advanceTimersByTimeAsync(0);
    expect(h.node('data-remote-backup-preview-status').textContent).toContain('no longer verified');
  });

  it('expires multiple prepared copies at their separate deadlines without moving focus', async () => {
    vi.useFakeTimers(); const other = { ...receipt, operation_id: '22345678-1234-4234-8234-123456789abc' };
    const h = await setup({ list: async () => ({ backups: [receipt, other] }) }), first = await preparePreview(h);
    await vi.advanceTimersByTimeAsync(120_000);
    const second = h.host.querySelector(`[data-remote-backup-id="${other.operation_id}"]`)!.querySelector('[data-remote-backup-restore]')!;
    second.focus(); second.click(); await vi.waitFor(() => expect(second.textContent).toBe('Open restore preview'));
    await vi.advanceTimersByTimeAsync(180_000); expect(first.textContent).toBe('Prepare a restore again'); expect(second.textContent).toBe('Open restore preview');
    expect(h.document.activeElement).toBe(second); await vi.advanceTimersByTimeAsync(120_000);
    expect(second.textContent).toBe('Prepare a restore again'); expect(h.retrieve).toHaveBeenCalledTimes(2); expect(h.onRestore).not.toHaveBeenCalled();
  });

  it.each(['removal', 'disposal'] as const)('cancels preview expiry on row %s and ignores activation of the old button', async action => {
    vi.useFakeTimers(); let backups = [receipt]; const h = await setup({ list: async () => ({ backups }) }), button = await preparePreview(h);
    const status = h.node('data-remote-backup-preview-status');
    if (action === 'removal') { backups = []; await h.mounted.refresh(); } else h.mounted.dispose();
    const before = status.textContent; expect(vi.getTimerCount()).toBe(0); await vi.advanceTimersByTimeAsync(10 * 60_000); button.click();
    expect(status.textContent).toBe(before); expect(h.retrieve).toHaveBeenCalledOnce(); expect(h.onRestore).not.toHaveBeenCalled();
  });

  it('ignores a late retrieval for a removed row even when another row with the same identifier appears', async () => {
    vi.useFakeTimers(); let backups = [receipt], finish!: (value: { staged_name: string }) => void;
    const retrieve = vi.fn(() => new Promise<{ staged_name: string }>(resolve => { finish = resolve; }));
    const h = await setup({ list: async () => ({ backups }), retrieve }), original = h.node('data-remote-backup-restore'); original.click();
    backups = []; await h.mounted.refresh(); backups = [receipt]; await h.mounted.refresh(); const replacement = h.node('data-remote-backup-restore');
    expect(replacement).not.toBe(original); finish({ staged_name: stage }); await vi.advanceTimersByTimeAsync(0);
    expect(replacement.textContent).toBe('Prepare a restore'); expect(h.node('data-remote-backup-preview-status').textContent).toBe('');
    expect(vi.getTimerCount()).toBe(0); original.click(); expect(retrieve).toHaveBeenCalledOnce(); expect(h.onRestore).not.toHaveBeenCalled();
  });

  it('recovers from a synchronous retrieval failure and requires a separate action to open its successful retry', async () => {
    const retrieve = vi.fn<RemoteBackupsPorts['retrieve']>().mockImplementationOnce(() => { throw new Error('private provider failure'); })
      .mockResolvedValue({ staged_name: stage });
    const h = await setup({ retrieve }), button = h.node('data-remote-backup-restore'); button.click();
    await vi.waitFor(() => expect(h.node('data-remote-backup-preview-status').textContent).toContain('No restore was started'));
    expect(button.getAttribute('aria-disabled')).toBe('false'); expect(h.host.textContent).not.toContain('private provider failure');
    button.click(); await vi.waitFor(() => expect(button.textContent).toBe('Open restore preview'));
    expect(retrieve).toHaveBeenCalledTimes(2); expect(h.onRestore).not.toHaveBeenCalled(); button.click(); expect(h.onRestore).toHaveBeenCalledExactlyOnceWith(stage);
  });

  it.each(['pruned', 'missing', 'changed'] as const)('invalidates the recovery selection when refreshed history says the backup is %s', async issue => {
    let backups: ArchiveRemoteBackup[] = [receipt]; const start = vi.fn<NonNullable<RemoteBackupsPorts['drills']>['start']>();
    const h = await setup({ list: async () => ({ backups }), drills: { list: async () => ({ drills: [] }), start, cancel: vi.fn(), cleanup: vi.fn() } });
    h.node('data-remote-backup-drill').click(); await vi.waitFor(() => expect(h.node('data-drill-start').disabled).toBe(false));
    const words = h.node('data-drill-words'); words.value = 'synthetic unsent recovery words'; words.focus();
    backups = issue === 'missing' ? [] : [{ ...receipt, ...(issue === 'pruned' ? { state: 'pruned' as const } : { sha256: 'c'.repeat(64) }) }];
    await h.mounted.refresh(); expect(words.value).toBe(''); expect(words.disabled).toBe(true); expect(h.node('data-drill-start').disabled).toBe(true);
    expect(h.node('data-drill-selected').textContent).toContain(issue === 'missing' ? 'current history' : issue === 'pruned' ? 'no longer verified' : 'details changed');
    expect(h.document.activeElement).toBe(h.node('data-drill-selected')); h.node('data-drill-form').fire('submit');
    expect(start).not.toHaveBeenCalled(); expect(h.retrieve).not.toHaveBeenCalled(); expect(h.onRestore).not.toHaveBeenCalled();
  });

  it('preserves matching recovery drafts and focus through failed remote reads and updates only display metadata on recovery', async () => {
    const list = vi.fn(async () => ({ backups: [receipt] })), start = vi.fn<NonNullable<RemoteBackupsPorts['drills']>['start']>();
    const h = await setup({ list, drills: { list: async () => ({ drills: [] }), start, cancel: vi.fn(), cleanup: vi.fn() } });
    h.node('data-remote-backup-drill').click(); const words = h.node('data-drill-words'); words.value = 'synthetic unsent words'; words.focus();
    list.mockRejectedValueOnce(new Error('private read failure')); await h.mounted.refresh();
    expect(words.value).toBe('synthetic unsent words'); expect(h.document.activeElement).toBe(words);
    list.mockResolvedValueOnce({ backups: [{ ...receipt, destination: { ...destination, connection_name: 'renamed storage' } }] });
    await h.mounted.refresh(); expect(h.node('data-drill-selected').textContent).toContain('renamed storage');
    expect(words.value).toBe('synthetic unsent words'); expect(h.document.activeElement).toBe(words); expect(start).not.toHaveBeenCalled();
  });

  it('invalidates a selected copy as soon as an explicit stored-copy check changes it, before a history poll', async () => {
    const list = vi.fn(async () => ({ backups: [receipt] })), check = vi.fn(async () => ({ ...receipt, state: 'unconfirmed' as const }));
    const start = vi.fn<NonNullable<RemoteBackupsPorts['drills']>['start']>();
    const h = await setup({ list, check, drills: { list: async () => ({ drills: [] }), start, cancel: vi.fn(), cleanup: vi.fn() } });
    h.node('data-remote-backup-drill').click(); h.node('data-drill-words').value = 'synthetic unsent words';
    const control = h.node('data-remote-backup-check'); control.focus(); control.click();
    await vi.waitFor(() => expect(h.node('data-drill-words').disabled).toBe(true));
    expect(h.node('data-drill-words').value).toBe(''); expect(h.node('data-drill-selected').textContent).toContain('no longer verified');
    expect(h.document.activeElement).toBe(control); expect(list).toHaveBeenCalledOnce(); expect(check).toHaveBeenCalledOnce(); expect(start).not.toHaveBeenCalled();
  });

  it.each(['', '0', '31', '1.5'])('marks invalid manual retention %s and focuses its field before returning a target', async invalid => {
    const h = await setup(), select = h.node('data-remote-backup-destination'), keep = h.node('data-remote-backup-keep');
    select.value = 'safe'; select.fire('change'); keep.setAttribute('aria-describedby', 'retention-note'); keep.value = invalid; keep.fire('input');
    expect(keep.getAttribute('aria-invalid')).toBeNull();
    expect(() => h.mounted.target()).toThrow(); expect(keep.getAttribute('aria-invalid')).toBe('true');
    expect(h.document.activeElement).toBe(keep); expect(keep.getAttribute('aria-describedby')).toBe(`retention-note ${h.node('data-remote-backup-keep-error').id}`);
    keep.value = '3'; keep.fire('input'); expect(keep.getAttribute('aria-invalid')).toBeNull(); expect(keep.getAttribute('aria-describedby')).toBe('retention-note');
    expect(h.node('data-remote-backup-keep-error').textContent).toBe(''); expect(h.mounted.target()).toMatchObject({ destination_id: destination.destination_id, keep_last: 3 });
    expect(h.retrieve).not.toHaveBeenCalled(); expect(h.onRestore).not.toHaveBeenCalled();
  });

  it('identifies both invalid storage fields and focuses the changed destination first', async () => {
    let choices = [destination]; const h = await setup({ destinations: async () => ({ destinations: choices }) });
    const select = h.node('data-remote-backup-destination'), keep = h.node('data-remote-backup-keep'); select.value = 'safe'; select.fire('change');
    choices = [{ ...destination, destination_id: 'c'.repeat(64) }]; await h.mounted.refresh(); keep.value = '1.5'; keep.fire('input');
    expect(() => h.mounted.target()).toThrow(); expect(select.getAttribute('aria-invalid')).toBe('true'); expect(keep.getAttribute('aria-invalid')).toBe('true');
    expect(h.document.activeElement).toBe(select);
    select.value = 'safe'; select.fire('input'); expect(select.getAttribute('aria-invalid')).toBeNull(); expect(keep.getAttribute('aria-invalid')).toBe('true');
    expect(() => h.mounted.target()).toThrow('1 and 30'); expect(h.document.activeElement).toBe(keep);
    keep.value = '3'; keep.fire('change'); expect(keep.getAttribute('aria-invalid')).toBeNull();
    expect(h.mounted.target()).toMatchObject({ destination_id: 'c'.repeat(64), keep_last: 3 });
  });

  it('keeps a changed or removed destination explicit even when its stale option is reselected', async () => {
    let choices = [destination]; const h = await setup({ destinations: async () => ({ destinations: choices }) });
    const select = h.node('data-remote-backup-destination'); select.value = 'safe'; select.fire('change');
    choices = [{ ...destination, destination_id: 'c'.repeat(64) }]; await h.mounted.refresh();
    select.fire('input'); select.fire('change'); choices = []; await h.mounted.refresh();
    expect(select.value).toBe('stale:safe'); expect(() => h.mounted.target()).toThrow('select the destination again');
    select.value = ''; select.fire('change'); expect(select.getAttribute('aria-invalid')).toBeNull(); expect(h.mounted.target()).toBeUndefined();
  });

  it('clears observed storage errors on a read without moving focus or replacing field and error nodes', async () => {
    let choices = [destination]; const h = await setup({ destinations: async () => ({ destinations: choices }),
      unattended: { get: async () => ({ configured: false }), save: vi.fn() } });
    const select = h.node('data-remote-backup-destination'), keep = h.node('data-remote-backup-keep'); select.value = 'safe'; select.fire('change'); keep.value = '0';
    choices = [{ ...destination, destination_id: 'c'.repeat(64) }]; await h.mounted.refresh(); expect(() => h.mounted.target()).toThrow();
    const error = h.node('data-remote-backup-destination-error'), words = h.node('data-unattended-words'); words.value = 'synthetic unsubmitted draft'; words.focus();
    choices = [destination]; await h.mounted.refresh();
    expect(select.getAttribute('aria-invalid')).toBeNull(); expect(keep.getAttribute('aria-invalid')).toBe('true');
    expect(h.node('data-remote-backup-destination')).toBe(select); expect(h.node('data-remote-backup-destination-error')).toBe(error);
    expect(h.document.activeElement).toBe(words); expect(words.value).toBe('synthetic unsubmitted draft');
  });

  it('allows explicit local export with an invalid unused retention value and clears both field errors', async () => {
    let choices = [destination]; const h = await setup({ destinations: async () => ({ destinations: choices }) });
    const select = h.node('data-remote-backup-destination'), keep = h.node('data-remote-backup-keep'); select.value = 'safe'; select.fire('change'); keep.value = '0';
    choices = []; await h.mounted.refresh(); expect(() => h.mounted.target()).toThrow();
    select.value = ''; select.fire('input'); expect(h.mounted.target()).toBeUndefined();
    for (const field of [select, keep]) { expect(field.getAttribute('aria-invalid')).toBeNull(); expect(field.getAttribute('aria-describedby')).toBeNull(); }
    expect(keep.value).toBe('0'); expect(h.retrieve).not.toHaveBeenCalled();
  });

  it('ignores correction events and refuses targets after disposal', async () => {
    const h = await setup(); const select = h.node('data-remote-backup-destination'), keep = h.node('data-remote-backup-keep'); select.value = 'safe'; select.fire('change'); keep.value = '0';
    expect(() => h.mounted.target()).toThrow(); h.mounted.dispose(); const before = h.host.textContent;
    keep.value = '3'; keep.fire('input'); select.value = ''; select.fire('change'); await h.mounted.refresh();
    expect(h.host.textContent).toBe(before); expect(keep.getAttribute('aria-invalid')).toBe('true'); expect(() => h.mounted.target()).toThrow('Reload Backup');
  });

  it('keeps shared Refresh busy while a schedule status read is pending', async () => {
    let finish!: (value: ArchiveUnattendedStatus) => void;
    const get = vi.fn(() => new Promise<ArchiveUnattendedStatus>(resolve => { finish = resolve; }));
    const list = vi.fn(async () => ({ backups: [receipt] })), save = vi.fn();
    const h = await setup({ list, unattended: { get, save } }), refresh = h.node('data-remote-backups-refresh');
    expect(refresh.getAttribute('aria-busy')).toBe('true'); expect(refresh.textContent).toBe('Refreshing backup status…');
    refresh.focus(); refresh.click(); refresh.click(); expect(list).toHaveBeenCalledTimes(1);
    await h.mounted.refresh(); expect(list).toHaveBeenCalledTimes(2); expect(get).toHaveBeenCalledTimes(1);
    finish({ configured: false }); await vi.waitFor(() => expect(refresh.getAttribute('aria-busy')).toBe('false'));
    expect(h.document.activeElement).toBe(refresh); expect(save).not.toHaveBeenCalled();
    expect(h.node('data-unattended-last-refreshed').getAttribute('datetime')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('includes schedule polls in shared progress and clears progress after a failed read', async () => {
    vi.useFakeTimers(); let fail!: (error: Error) => void;
    const get = vi.fn(async (): Promise<ArchiveUnattendedStatus> => ({ configured: false }))
      .mockImplementationOnce(async () => ({ configured: false }))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const h = await setup({ unattended: { get, save: vi.fn() } }); await vi.advanceTimersByTimeAsync(10_000);
    const refresh = h.node('data-remote-backups-refresh'); expect(refresh.getAttribute('aria-busy')).toBe('true');
    refresh.focus(); fail(new Error('private schedule read')); await vi.advanceTimersByTimeAsync(0);
    expect(refresh.getAttribute('aria-busy')).toBe('false'); expect(h.document.activeElement).toBe(refresh);
    expect(h.node('data-unattended-refresh-status').textContent).toContain('Latest schedule status refresh failed.');
  });

  it('keeps shared Refresh busy until an uncertain schedule save is reconciled', async () => {
    const value: ArchiveUnattendedStatus = { configured: true, settings: { enabled: true, connection_name: destination.connection_name,
      destination_id: destination.destination_id, keep_last: 5, schedule: { cadence: 'daily', hour_utc: 2, minute_utc: 0, weekday_utc: 0 } } };
    let finish!: (value: ArchiveUnattendedStatus) => void;
    const get = vi.fn(async () => value).mockImplementationOnce(async () => value)
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const save = vi.fn(async () => { throw new Error('lost reply'); }), list = vi.fn(async () => ({ backups: [receipt] }));
    const h = await setup({ list, unattended: { get, save } });
    h.node('data-unattended-time').value = '03:30'; h.node('data-unattended-time').fire('input'); h.node('data-unattended-save').click();
    await vi.waitFor(() => expect(h.node('data-unattended-feedback').textContent).toContain('could not be confirmed'));
    const refresh = h.node('data-remote-backups-refresh'); expect(refresh.getAttribute('aria-busy')).toBe('true');
    refresh.focus(); refresh.click(); refresh.click(); expect(list).toHaveBeenCalledTimes(1);
    await h.mounted.refresh(); expect(list).toHaveBeenCalledTimes(2); expect(get).toHaveBeenCalledTimes(2);
    finish(value); await vi.waitFor(() => expect(refresh.getAttribute('aria-busy')).toBe('false'));
    expect(h.node('data-unattended-feedback').textContent).toContain('could not be confirmed'); expect(save).toHaveBeenCalledTimes(1);
  });

  it('reads schedule status even when remote history fails', async () => {
    const get = vi.fn(async (): Promise<ArchiveUnattendedStatus> => ({ configured: false }));
    const list = vi.fn(async () => ({ backups: [receipt] })), save = vi.fn();
    const h = await setup({ list, unattended: { get, save } }); list.mockRejectedValueOnce(new Error('private history failure'));
    await h.mounted.refresh(); expect(get).toHaveBeenCalledTimes(2); expect(save).not.toHaveBeenCalled();
    expect(h.node('data-remote-backups-status').textContent).toContain('could not be checked');
    expect(h.node('data-unattended-refresh-status').textContent).not.toContain('failed'); expect(h.host.textContent).not.toContain('private history');
  });

  it('keeps Refresh busy until the monitor read settles while history stays independent', async () => {
    let finish!: (value: BackupWatchdogStatus) => void;
    const get = vi.fn(() => new Promise<BackupWatchdogStatus>(resolve => { finish = resolve; }));
    const list = vi.fn(async () => ({ backups: [receipt] })), save = vi.fn();
    const h = await setup({ list, watchdog: { get, save } }), refresh = h.node('data-remote-backups-refresh');
    expect(refresh.getAttribute('aria-busy')).toBe('true');
    expect(refresh.textContent).toBe('Refreshing backup status…');
    refresh.focus(); refresh.click(); refresh.click(); expect(list).toHaveBeenCalledTimes(1);
    await h.mounted.refresh(); expect(list).toHaveBeenCalledTimes(2); expect(get).toHaveBeenCalledTimes(1);
    finish({ configured: false, enabled: false, state: 'not_configured' });
    await vi.waitFor(() => expect(refresh.getAttribute('aria-busy')).toBe('false'));
    expect(h.document.activeElement).toBe(refresh); expect(save).not.toHaveBeenCalled();
    expect(h.node('data-backup-watchdog-last-refreshed').getAttribute('datetime')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('includes an automatic monitor poll in shared progress and releases it after failure', async () => {
    vi.useFakeTimers();
    let fail!: (error: Error) => void;
    const value: BackupWatchdogStatus = { configured: false, enabled: false, state: 'not_configured' };
    const get = vi.fn(async () => value).mockImplementationOnce(async () => value)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const h = await setup({ watchdog: { get, save: vi.fn() } }); await vi.advanceTimersByTimeAsync(10_000);
    const refresh = h.node('data-remote-backups-refresh'); expect(refresh.getAttribute('aria-busy')).toBe('true');
    refresh.focus(); fail(new Error('private monitor read failure')); await vi.advanceTimersByTimeAsync(0);
    expect(refresh.getAttribute('aria-busy')).toBe('false'); expect(h.document.activeElement).toBe(refresh);
    expect(h.node('data-backup-watchdog-refresh-status').textContent).toContain('Latest monitor status refresh failed.');
  });

  it('waits for both status reads, exposes a failed read, and retries without a storage scan or write', async () => {
    let finishHealth!: (value: ArchiveBackupHealthStatus) => void, failIntegrity!: (error: Error) => void;
    const health = vi.fn(async () => healthStatus).mockImplementationOnce(() => new Promise(resolve => { finishHealth = resolve; }));
    const integrity = vi.fn(async () => integrityStatus).mockImplementationOnce(() => new Promise((_resolve, reject) => { failIntegrity = reject; }));
    const save = vi.fn(), check = vi.fn(), retrieve = vi.fn();
    const h = await setup({ health: { get: health, save }, integrity: { get: integrity, save }, check, retrieve });
    const refresh = h.node('data-remote-backups-refresh');
    finishHealth(healthStatus);
    await vi.waitFor(() => expect(h.host.querySelector('[data-backup-health-last-refreshed]')).not.toBeNull());
    expect(refresh.getAttribute('aria-busy')).toBe('true');
    failIntegrity(new Error('private provider path'));
    await vi.waitFor(() => expect(refresh.getAttribute('aria-busy')).toBe('false'));
    expect(h.node('data-backup-integrity-refresh-status').textContent).toContain('Latest status refresh failed.');
    expect(h.host.querySelector('[data-backup-integrity-last-refreshed]')).toBeNull();
    refresh.focus(); refresh.click();
    await vi.waitFor(() => expect(h.host.querySelector('[data-backup-integrity-last-refreshed]')).not.toBeNull());
    expect(health).toHaveBeenCalledTimes(2); expect(integrity).toHaveBeenCalledTimes(2);
    expect(h.document.activeElement).toBe(refresh); expect(h.host.textContent).not.toContain('private provider');
    expect(save).not.toHaveBeenCalled(); expect(check).not.toHaveBeenCalled(); expect(retrieve).not.toHaveBeenCalled();
  });

  it('reports a child poll in progress without blocking a new history read', async () => {
    vi.useFakeTimers();
    let finish!: (value: ArchiveBackupHealthStatus) => void;
    const get = vi.fn(async () => healthStatus).mockImplementationOnce(async () => healthStatus)
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const list = vi.fn(async () => ({ backups: [receipt] }));
    const h = await setup({ health: { get, save: vi.fn() }, list });
    await vi.advanceTimersByTimeAsync(10_000);
    const refresh = h.node('data-remote-backups-refresh');
    expect(get).toHaveBeenCalledTimes(2); expect(refresh.getAttribute('aria-busy')).toBe('true');
    await h.mounted.refresh(); expect(list).toHaveBeenCalledTimes(2); expect(get).toHaveBeenCalledTimes(2);
    finish(healthStatus); await vi.advanceTimersByTimeAsync(0);
    expect(refresh.getAttribute('aria-busy')).toBe('false');
  });

  it.each(['health', 'integrity'] as const)('keeps Refresh busy for a pending %s read while history stays independent', async kind => {
    let finish!: () => void;
    const list = vi.fn(async () => ({ backups: [receipt] }));
    const get = vi.fn(() => new Promise<ArchiveBackupHealthStatus & ArchiveBackupIntegrityStatus>(resolve => {
      finish = () => resolve({ ...healthStatus, ...integrityStatus, issue: undefined, policy: { ...healthStatus.policy, ...integrityStatus.policy } });
    }));
    const save = vi.fn(); const check = vi.fn();
    const h = await setup({ list, check, [kind]: { get, save } });
    const refresh = h.node('data-remote-backups-refresh');
    expect(get).toHaveBeenCalledTimes(1);
    expect(refresh.getAttribute('aria-disabled')).toBe('true');
    expect(refresh.getAttribute('aria-busy')).toBe('true');
    expect(refresh.textContent).toBe('Refreshing backup status…');
    refresh.focus(); refresh.click(); refresh.click();
    expect(list).toHaveBeenCalledTimes(1);
    await h.mounted.refresh();
    expect(list).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(1);
    finish();
    await vi.waitFor(() => expect(refresh.getAttribute('aria-busy')).toBe('false'));
    expect(refresh.textContent).toBe('Refresh backup status');
    expect(h.document.activeElement).toBe(refresh);
    expect(h.node(`data-backup-${kind}-last-refreshed`).getAttribute('datetime')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(save).not.toHaveBeenCalled(); expect(check).not.toHaveBeenCalled();
  });

  it('observes retention finishing after the replacement is already verified', async () => {
    vi.useFakeTimers();
    let backups: ArchiveRemoteBackup[] = [receipt, { ...receipt, operation_id: '22345678-1234-4234-8234-123456789abc', state: 'pruning' }];
    const list = vi.fn(async () => ({ backups }));
    const h = await setup({ list });
    expect(list).toHaveBeenCalledTimes(1);
    backups = [receipt, { ...backups[1]!, state: 'pruned' }];
    await vi.advanceTimersByTimeAsync(5000);
    expect(list).toHaveBeenCalledTimes(2);
    expect(h.host.querySelector('[data-remote-backup-state="pruned"]')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(15000);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('binds the displayed destination, refuses a changed choice, and keeps local export explicit', async () => {
    let choices = [destination];
    const h = await setup({ destinations: async () => ({ destinations: choices }) }); await h.mounted.refresh();
    expect(h.mounted.target()).toBeUndefined();
    const select = h.node('data-remote-backup-destination'); select.value = 'safe'; select.fire('change');
    expect(h.mounted.target()).toMatchObject({ connection_name: 'safe', destination_id: destination.destination_id, keep_last: 5 });
    const options = [...select.children]; await h.mounted.refresh(); expect(select.children).toEqual(options);
    choices = [{ ...destination, destination_id: 'c'.repeat(64), bucket: 'changed-bucket' }]; await h.mounted.refresh();
    expect(select.value).toBe('stale:safe'); expect(() => h.mounted.target()).toThrow('select the destination again');
    select.value = 'safe'; select.fire('change'); expect(h.mounted.target()?.destination_id).toBe('c'.repeat(64));
    h.node('data-remote-backup-keep').value = '0'; expect(() => h.mounted.target()).toThrow('1 and 30');
    select.value = ''; select.fire('change'); expect(h.mounted.target()).toBeUndefined();
  });

  it('keeps a focused history control attached when receipts refresh', async () => {
    let backups = [receipt]; const h = await setup({ list: async () => ({ backups }) }); await h.mounted.refresh();
    const button = h.node('data-remote-backup-check'); button.focus();
    backups = [{ ...receipt, operation_id: '22345678-1234-4234-8234-123456789abc' }, { ...receipt, retention_pending: true }];
    await h.mounted.refresh(); expect(h.node('data-remote-backup-check')).toBe(button); expect(h.document.activeElement).toBe(button);
    backups = []; await h.mounted.refresh(); expect(h.document.activeElement).toBe(h.node('data-remote-backups-refresh'));
  });

  it('requires a separate owner action after retrieval before opening the key form', async () => {
    let settle: (value: { staged_name: string }) => void = () => {};
    const h = await setup({ retrieve: () => new Promise(resolve => { settle = resolve; }) }); await h.mounted.refresh();
    const button = h.node('data-remote-backup-restore'); button.focus(); button.click();
    expect(button.getAttribute('aria-disabled')).toBe('true'); expect(h.onRestore).not.toHaveBeenCalled();
    settle({ staged_name: stage }); await vi.waitFor(() => expect(button.textContent).toBe('Open restore preview'));
    expect(h.onRestore).not.toHaveBeenCalled(); expect(h.document.activeElement).toBe(button);
    button.click(); expect(h.onRestore).toHaveBeenCalledExactlyOnceWith(stage);
  });

  it('does not navigate on a late retrieval after route disposal or on a malformed staged name', async () => {
    let settle: (value: { staged_name: string }) => void = () => {};
    const h = await setup({ retrieve: () => new Promise(resolve => { settle = resolve; }) }); await h.mounted.refresh();
    h.node('data-remote-backup-restore').click(); h.mounted.dispose(); settle({ staged_name: stage }); await Promise.resolve(); await Promise.resolve();
    expect(h.onRestore).not.toHaveBeenCalled();
    const invalid = await setup({ retrieve: async () => ({ staged_name: '../../other-file' }) }); await invalid.mounted.refresh();
    invalid.node('data-remote-backup-restore').click(); await vi.waitFor(() => expect(invalid.host.textContent).toContain('No restore was started'));
    expect(invalid.onRestore).not.toHaveBeenCalled();
  });
});

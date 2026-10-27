import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuditLogStore, createInMemoryCollection, type ActivityEntry, type AuditEntry } from '@recued/storage';
import { createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel,
  type Channel, type NotificationBlock, type NotificationSettings, type PendingAsk, type UiNotificationEvent } from '@recued/notification';
import type { ConnectionAuth, ConnectionRow, SavedOAuthApp, SourceRegistration } from '@recued/contracts';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createAuthenticationRepairSnapshot, type AuthenticationRepairSnapshot } from '../authentication-repair-worklist.js';
import { createAuthenticationAlertStore, AUTHENTICATION_ALERT_GRACE_MS } from '../authentication-alert-store.js';
import { createAuthenticationAlertRuntime, authenticationAlertMessage, authenticationRepairHash } from '../authentication-alert-runtime.js';
import { PUSH_GRACE_MS, STOP_GRACE_MS } from '../lifecycle/settle-within.js';
import type { CollectionInstanceRecord } from '../collections/instance-store.js';
import { initialFileSourceSyncState } from '../storage/file-source-sync-state.js';
import { connectionsAccountAddress, connectionsReviewAccessAddress, connectionsOAuthAppsAddress } from '../../../../apps/webclient/src/connections/connections-navigation.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
const clock = new Date(2026, 9, 16, 12).getTime();
const app = (): SavedOAuthApp => ({ id: 'default', issuer: 'microsoft', label: 'Work app', client_id: 'client', has_secret: true, revision: 1 });
const mailbox = (slug = 'inbox', platform: 'mail' | 'calendar' = 'mail'): CollectionInstanceRecord => ({
  slug, platform, adapter_type: 'graph', config: { account_slug: 'shared', account_email: 'owner@example.test' },
  auth_state: 'expired', last_synced_at: clock - 60_000, created_at: 1, updated_at: clock - 1,
  backfill_complete: true, caps: { read: 'yes', write: 'no', delete: 'no', watch: 'poll', mirror: 'disabled', auth: 'oauth', path_style: 'uri' },
});
const api = (name = 'sheets', status = 'auth_failed'): ConnectionRow => ({ pk: 'api/' + name, kind: 'api', name, display_name: name,
  enrolled_at: 1, updated_at: 2, config_json: '{"base_url":"https://sheets.googleapis.com/v4"}', auth_ciphertext: 'private-ciphertext',
  health_json: JSON.stringify({ status, last_probed_at: clock - 1, last_error: 'private provider secret' }) });
const fixture = (path = ':memory:') => {
  const db = new Database(path); cleanups.push(() => { if (db.open) db.close(); });
  let now = clock; let available = true; let locked = false; let readable = true;
  let auth: ConnectionAuth = { type: 'bearer', token: 'private-test-token' };
  const instances = [mailbox()]; const rows: ConnectionRow[] = []; const apps = [app()]; const sources: SourceRegistration[] = [];
  const file = initialFileSourceSyncState('drive.sheets.file');
  const fileStates = new Map<string, ReturnType<typeof initialFileSourceSyncState>>();
  const read = createAuthenticationRepairSnapshot({ connections: () => rows, decode: async (): Promise<ConnectionAuth> => {
    if (!readable) throw new Error('private credential read failed'); return auth;
  },
    instances: () => instances, apps: () => { if (!available) throw new Error('private inventory error'); return apps; }, sources: () => sources,
    fileState: id => fileStates.get(id) ?? file, connectionUses: () => ({ complete: true, uses: [{ kind: 'pack', id: 'sheet-pack', label: 'Sheet pack' },
      { kind: 'schedule', id: 'daily-sheet', label: 'Daily sheet' }] }), now: () => now });
  const activities = createSQLiteCollection<ActivityEntry>(db, 'authentication_alert_test_activities');
  const auditLog = createAuditLogStore(createInMemoryCollection<AuditEntry>(), activities);
  const store = createAuthenticationAlertStore(db); const notify = vi.fn<NotificationBlock['notify']>(async () => {});
  const runtime = createAuthenticationAlertRuntime({ store, read, auditLog, notifier: { notify }, canRun: () => !locked,
    getPublicBaseUrl: () => 'https://owner.example.test/' });
  cleanups.push(() => runtime.stop());
  return { db, instances, rows, apps, sources, file, fileStates, read, store, runtime, notify, activities, auditLog,
    setNow: (value: number) => { now = value; }, setAvailable: (value: boolean) => { available = value; }, setLocked: (value: boolean) => { locked = value; },
    setReadable: (value: boolean) => { readable = value; }, setAuth: (value: ConnectionAuth) => { auth = value; } };
};

describe('proactive authentication alerts through the passive inventory and durable owner history', () => {
  it('alerts on a rejected native sign-in once, with its real uses, repair link and no provider calls or secrets', async () => {
    const f = fixture(); const network = vi.spyOn(globalThis, 'fetch');
    await Promise.all([f.runtime.tick(), f.runtime.tick()]); await f.runtime.tick();
    expect(f.notify).toHaveBeenCalledTimes(1);
    expect(f.notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Connection access was rejected',
      text: expect.stringContaining('Mail: owner@example.test'), link_url: 'https://owner.example.test/#connections/mail/inbox' }),
    undefined, expect.objectContaining({ ui_link_url: '#connections/mail/inbox' }));
    expect(await f.activities.list()).toHaveLength(1);
    expect(JSON.stringify(f.notify.mock.calls)).not.toMatch(/private-|provider secret/); expect(network).not.toHaveBeenCalled();
    f.instances[0]!.updated_at = clock + 10; f.setNow(clock + 20); await f.runtime.tick();
    expect(f.notify).toHaveBeenCalledTimes(1);
  });

  it('retains deduplication across a real database close and reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'authentication-alerts-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'realm.db'); const first = fixture(path);
    await first.runtime.tick(); await first.runtime.stop(); first.db.close();
    const reopened = fixture(path); await reopened.runtime.tick();
    expect(reopened.notify).not.toHaveBeenCalled(); expect(await reopened.activities.list()).toHaveLength(1);
  });

  it('waits for a sustained unconfirmed problem and does not misdiagnose it as failed authentication', async () => {
    const f = fixture(); f.instances[0]!.auth_state = 'degraded';
    await f.runtime.tick(); expect(f.notify).not.toHaveBeenCalled();
    f.setNow(clock + AUTHENTICATION_ALERT_GRACE_MS - 1); await f.runtime.tick(); expect(f.notify).not.toHaveBeenCalled();
    f.setNow(clock + AUTHENTICATION_ALERT_GRACE_MS); await f.runtime.tick();
    expect(f.notify).toHaveBeenCalledTimes(1); expect(f.notify.mock.calls[0]![0]).toMatchObject({ title: 'Connection needs attention', text: expect.stringContaining('authentication cause is unconfirmed') });
    f.instances[0]!.auth_state = 'expired'; f.setNow(clock + AUTHENTICATION_ALERT_GRACE_MS + 1); await f.runtime.tick();
    expect(f.notify).toHaveBeenCalledTimes(2); expect(f.notify.mock.calls[1]![0].title).toBe('Connection access was rejected');
    await f.runtime.tick(); expect(f.notify).toHaveBeenCalledTimes(2);
  });

  it('restarts the grace period when an unconfirmed problem disappears before a new observation', async () => {
    const f = fixture(); f.instances[0]!.auth_state = 'degraded'; await f.runtime.tick();
    f.setNow(clock + 10 * 60_000); f.instances[0]!.auth_state = 'healthy'; await f.runtime.tick();
    f.setNow(clock + 16 * 60_000); f.instances[0]!.auth_state = 'degraded'; await f.runtime.tick();
    expect(f.notify).not.toHaveBeenCalled();
    f.setNow(clock + 31 * 60_000); await f.runtime.tick(); expect(f.notify).toHaveBeenCalledTimes(1);
  });

  it('cancels an undelivered rejection that changes diagnosis, then can still alert about the current sustained problem', async () => {
    const f = fixture(); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(f.auditLog, 'logActivity').mockRejectedValueOnce(new Error('private storage failure'));
    await f.runtime.tick(); expect(f.store.pending()[0]!.level).toBe('rejected');
    f.instances[0]!.auth_state = 'degraded'; f.setNow(clock + 1); await f.runtime.tick(); expect(f.store.pending()).toEqual([]);
    f.setNow(clock + AUTHENTICATION_ALERT_GRACE_MS); await f.runtime.tick();
    expect(f.notify).toHaveBeenCalledTimes(1); expect(f.notify.mock.calls[0]![0].title).toBe('Connection needs attention'); expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not report recovery on a credential edit, old sync, partial inventory, or locked vault', async () => {
    const f = fixture(); await f.runtime.tick();
    f.instances[0]!.auth_state = 'healthy'; f.setNow(clock + 100); await f.runtime.tick();
    expect(f.notify).toHaveBeenCalledTimes(1);
    f.instances[0]!.last_synced_at = clock + 100; f.setAvailable(false); await f.runtime.tick();
    expect(f.notify).toHaveBeenCalledTimes(1);
    f.setAvailable(true); f.setLocked(true); await f.runtime.tick(); expect(f.notify).toHaveBeenCalledTimes(1);
    f.setLocked(false); await f.runtime.tick();
    expect(f.notify).toHaveBeenCalledTimes(2); expect(f.notify.mock.calls[1]![0].title).toBe('Connection operation succeeded again');
    await f.runtime.tick(); expect(f.notify).toHaveBeenCalledTimes(2);
    f.instances[0]!.auth_state = 'expired'; f.instances[0]!.updated_at = clock + 101; f.setNow(clock + 101); await f.runtime.tick();
    expect(f.notify).toHaveBeenCalledTimes(3);
  });

  it('requires a later success from every failed use sharing the Microsoft sign-in', async () => {
    const f = fixture(); f.instances.push(mailbox('events', 'calendar')); await f.runtime.tick();
    expect(f.notify).toHaveBeenCalledTimes(1);
    f.setNow(clock + 100); f.instances[0]!.auth_state = 'healthy'; f.instances[0]!.last_synced_at = clock + 100;
    f.instances[1]!.auth_state = 'healthy'; await f.runtime.tick(); expect(f.notify).toHaveBeenCalledTimes(1);
    f.instances[1]!.last_synced_at = clock + 100; await f.runtime.tick(); expect(f.notify).toHaveBeenCalledTimes(2);
  });

  it('retains shared-account recovery requirements through a partial inventory while another use still fails', async () => {
    const f = fixture(); const calendar = mailbox('events', 'calendar'); f.instances.push(calendar); await f.runtime.tick();
    f.instances.splice(1); f.setAvailable(false); f.setNow(clock + 10); await f.runtime.tick();
    f.instances.push(calendar); f.setAvailable(true); f.setNow(clock + 100);
    for (const row of f.instances) { row.auth_state = 'healthy'; row.last_synced_at = clock + 100; }
    await f.runtime.tick();
    expect(f.notify).toHaveBeenCalledTimes(2); expect(f.notify.mock.calls[1]![0].title).toBe('Connection operation succeeded again');
  });

  it('does not create a second account alert when a credential becomes unreadable', async () => {
    const f = fixture(); f.instances.splice(0); f.rows.push(api());
    f.setAuth({ type: 'oauth2_refresh', native_credential_id: 'native-grant', client_id: 'client',
      refresh_token: 'private-refresh', token_endpoint: 'https://oauth.example.test/token' });
    await f.runtime.tick(); f.setReadable(false); await f.runtime.tick();
    expect(f.notify).toHaveBeenCalledTimes(1);
    f.setReadable(true); await f.runtime.tick(); expect(f.notify).toHaveBeenCalledTimes(1);
  });

  it('can deliver recovery after an episode has waited more than the closed-episode retention period', async () => {
    const f = fixture(); await f.runtime.tick();
    f.setNow(clock + 40 * 86_400_000); f.instances[0]!.auth_state = 'healthy';
    await f.runtime.tick(); expect(f.notify).toHaveBeenCalledTimes(1);
    f.instances[0]!.last_synced_at = clock + 40 * 86_400_000;
    await f.runtime.tick(); await f.runtime.tick();
    expect(f.notify).toHaveBeenCalledTimes(2); expect(f.store.pending()).toEqual([]);
  });

  it('retires removed or replaced uses without claiming that their vendor access recovered', async () => {
    const f = fixture(); await f.runtime.tick(); f.instances.splice(0); f.setNow(clock + 100); await f.runtime.tick();
    expect(f.notify).toHaveBeenCalledTimes(1); expect(f.store.pending()).toEqual([]);
    f.instances.push(mailbox('replacement')); await f.runtime.tick(); expect(f.notify).toHaveBeenCalledTimes(2);
    expect(f.notify.mock.calls.every(c => c[0].title === 'Connection access was rejected')).toBe(true);
  });

  it('needs an authenticated API observation, rather than a generic public-root reply, to report recovery', async () => {
    const f = fixture(); f.instances.splice(0); f.rows.push(api()); await f.runtime.tick();
    f.setNow(clock + 100); f.rows[0]!.health_json = JSON.stringify({ status: 'ok', last_probed_at: clock + 100 });
    await f.runtime.tick(); expect(f.notify).toHaveBeenCalledTimes(1);
    f.rows[0]!.health_json = JSON.stringify({ status: 'ok', last_probed_at: clock + 100, access_verified_at: clock + 100 });
    await f.runtime.tick(); expect(f.notify).toHaveBeenCalledTimes(2);
    expect(f.notify.mock.calls[0]![0].text).toContain('Schedule: Daily sheet');
    expect(f.notify.mock.calls[0]![2]?.ui_link_url).toBe('#connections/others/review-access/api/sheets');
  });

  it('uses a successful file sync as recovery evidence and keeps file-fetch diagnoses unconfirmed', async () => {
    const f = fixture(); f.instances.splice(0); f.rows.push(api('sheets', 'unknown'));
    f.sources.push({ id: f.file.source_id, source_label: 'Work files', source_kind: 'connection', top_tier_kind: 'file', write_capable: false, registered_at: 1, sync_posture: 'file_meta_ref' });
    f.file.degraded = true; f.file.last_error_code = 'fetch_policy'; f.file.last_error_message = 'private error'; f.file.last_sync_completed_at = clock - 1;
    await f.runtime.tick(); f.setNow(clock + AUTHENTICATION_ALERT_GRACE_MS); await f.runtime.tick();
    expect(f.notify.mock.calls[0]![0].title).toBe('Connection needs attention');
    expect(f.notify.mock.calls[0]![2]?.ui_link_url).toBe('#data/files/remote%3Adrive.sheets.file');
    f.file.degraded = false; f.file.last_error_code = null; await f.runtime.tick(); expect(f.notify).toHaveBeenCalledTimes(1);
    f.file.last_success_at = clock + AUTHENTICATION_ALERT_GRACE_MS; await f.runtime.tick(); expect(f.notify).toHaveBeenCalledTimes(2);
  });

  it('opens the failed Calendar rather than the healthy Mail use sharing its account', async () => {
    const f = fixture(); f.instances[0]!.auth_state = 'healthy'; f.instances.push(mailbox('events', 'calendar'));
    await f.runtime.tick();
    expect(f.notify).toHaveBeenCalledTimes(1);
    expect(f.notify.mock.calls[0]![2]?.ui_link_url).toBe('#connections/calendar/events');
  });

  it('opens the failed file source rather than another healthy source sharing its native grant', async () => {
    const f = fixture(); f.instances.splice(0); f.rows.push(api('healthy', 'unknown'), api('broken', 'unknown'));
    f.setAuth({ type: 'oauth2_refresh', native_credential_id: 'shared-file-grant', client_id: 'client',
      refresh_token: 'private-refresh', token_endpoint: 'https://oauth.example.test/token' });
    for (const name of ['healthy', 'broken']) {
      const state = initialFileSourceSyncState('drive.' + name + '.file');
      if (name === 'broken') { state.degraded = true; state.last_error_code = 'fetch_policy'; state.last_sync_completed_at = clock - 1; }
      f.fileStates.set(state.source_id, state);
      f.sources.push({ id: state.source_id, source_label: name + ' files', source_kind: 'connection', top_tier_kind: 'file',
        write_capable: false, registered_at: 1, sync_posture: 'file_meta_ref' });
    }
    await f.runtime.tick(); f.setNow(clock + AUTHENTICATION_ALERT_GRACE_MS); await f.runtime.tick();
    expect(f.notify).toHaveBeenCalledTimes(1);
    expect(f.notify.mock.calls[0]![2]?.ui_link_url).toBe('#data/files/remote%3Adrive.broken.file');
  });

  it('opens the rejected API alias even when its shared account has another file warning', async () => {
    const f = fixture(); f.instances.splice(0); f.rows.push(api('healthy', 'unknown'), api('broken'));
    f.setAuth({ type: 'oauth2_refresh', native_credential_id: 'shared-grant', client_id: 'client',
      refresh_token: 'private-refresh', token_endpoint: 'https://oauth.example.test/token' });
    f.sources.push({ id: 'drive.healthy.file', source_label: 'Files', source_kind: 'connection', top_tier_kind: 'file',
      write_capable: false, registered_at: 1, sync_posture: 'file_meta_ref' });
    f.file.degraded = true; f.file.last_error_code = 'fetch_policy'; f.file.last_sync_completed_at = clock - 1;
    await f.runtime.tick(); expect(f.notify).toHaveBeenCalledTimes(1);
    expect(f.notify.mock.calls[0]![2]?.ui_link_url).toBe('#connections/others/review-access/api/broken');
  });

  it('refreshes the repair destination when the failed use changes during history persistence', async () => {
    const f = fixture(); const calendar = mailbox('events', 'calendar'); calendar.auth_state = 'healthy'; f.instances.push(calendar);
    const persist = f.auditLog.logActivity.bind(f.auditLog); let changed = false;
    vi.spyOn(f.auditLog, 'logActivity').mockImplementation(async entry => {
      await persist(entry);
      if (!changed) { changed = true; f.instances[0]!.auth_state = 'healthy'; calendar.auth_state = 'expired'; }
    });
    await f.runtime.tick(); expect(f.notify).not.toHaveBeenCalled();
    await f.runtime.tick(); expect(f.notify).toHaveBeenCalledTimes(1);
    expect(f.notify.mock.calls[0]![2]?.ui_link_url).toBe('#connections/calendar/events');
    expect(await f.activities.list()).toHaveLength(1);
  });

  it('warns once at 30 days, 7 days and the recorded date; date changes do not assert access recovery', async () => {
    const f = fixture(); f.instances.splice(0); f.apps[0]!.secret_expires_on = '2026-11-15';
    await f.runtime.tick(); await f.runtime.tick(); expect(f.notify).toHaveBeenCalledTimes(1);
    f.setNow(new Date(2026, 10, 8, 12).getTime()); await f.runtime.tick(); expect(f.notify).toHaveBeenCalledTimes(2);
    f.setNow(new Date(2026, 10, 15, 12).getTime()); await f.runtime.tick(); await f.runtime.tick(); expect(f.notify).toHaveBeenCalledTimes(3);
    expect(f.notify.mock.calls[2]![0].title).toBe('Saved app secret expiry date reached');
    delete f.apps[0]!.secret_expires_on; await f.runtime.tick(); expect(f.notify).toHaveBeenCalledTimes(3);
    f.apps[0]!.secret_expires_on = '2026-12-01'; await f.runtime.tick(); expect(f.notify).toHaveBeenCalledTimes(4);
    expect(f.notify.mock.calls.every(c => !c[0].title?.includes('succeeded'))).toBe(true);
  });

  it('retries history persistence with the same id and attempts a claimed external push only once', async () => {
    const f = fixture(); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const persist = vi.spyOn(f.auditLog, 'logActivity').mockRejectedValueOnce(new Error('private persistence failure'));
    await f.runtime.tick(); const pending = f.store.pending()[0]!; expect(f.notify).not.toHaveBeenCalled();
    f.notify.mockRejectedValueOnce(new Error('private channel error')); await f.runtime.tick(); await f.runtime.tick();
    expect(f.notify).toHaveBeenCalledTimes(1); expect(persist.mock.calls[1]![0].activity_id).toBe(pending.id);
    expect(await f.activities.list()).toHaveLength(1); expect(f.store.pending()).toEqual([]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
  });

  it('rechecks a repair after yielding to history persistence and cancels its stale pending push', async () => {
    const f = fixture(); const persist = f.auditLog.logActivity.bind(f.auditLog);
    vi.spyOn(f.auditLog, 'logActivity').mockImplementation(async entry => {
      await persist(entry); f.instances[0]!.auth_state = 'healthy'; f.instances[0]!.last_synced_at = clock + 1; f.setNow(clock + 1);
    });
    await f.runtime.tick(); expect(f.notify).not.toHaveBeenCalled(); expect(f.store.pending()).toEqual([]);
  });

  it('refreshes a queued notice whose original repair target was removed from a shared account', async () => {
    const f = fixture(); f.instances.splice(0); f.rows.push(api('first'), api('second'));
    f.setAuth({ type: 'oauth2_refresh', native_credential_id: 'shared-grant', client_id: 'client',
      refresh_token: 'private-refresh', token_endpoint: 'https://oauth.example.test/token' });
    f.store.evaluate(await f.read()); f.rows.splice(0, 1); await f.runtime.tick();
    expect(f.notify).toHaveBeenCalledTimes(1);
    expect(f.notify.mock.calls[0]![2]?.ui_link_url).toBe('#connections/others/review-access/api/second');
    expect(f.notify.mock.calls[0]![0].text).toMatch(/^second:/);
  });

  it('does not push stale account details when the target changes during history persistence', async () => {
    const f = fixture(); f.instances.splice(0); f.rows.push(api('first'), api('second'));
    f.setAuth({ type: 'oauth2_refresh', native_credential_id: 'shared-grant', client_id: 'client',
      refresh_token: 'private-refresh', token_endpoint: 'https://oauth.example.test/token' });
    const persist = f.auditLog.logActivity.bind(f.auditLog); let changed = false;
    vi.spyOn(f.auditLog, 'logActivity').mockImplementation(async entry => {
      await persist(entry); if (!changed) { changed = true; f.rows.splice(0, 1); }
    });
    await f.runtime.tick(); expect(f.notify).not.toHaveBeenCalled();
    await f.runtime.tick(); expect(f.notify).toHaveBeenCalledTimes(1);
    expect(f.notify.mock.calls[0]![2]?.ui_link_url).toBe('#connections/others/review-access/api/second');
    expect(await f.activities.list()).toHaveLength(1);
  });

  it('keeps an unclaimed persisted notice through a failed recheck, without duplicating history', async () => {
    const f = fixture(); let fail = false; const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = createAuthenticationAlertRuntime({ store: f.store, auditLog: f.auditLog, notifier: { notify: f.notify },
      read: async () => { if (fail) throw new Error('private read failure'); const result = await f.read(); fail = true; return result; } });
    cleanups.push(() => runtime.stop()); await runtime.tick();
    expect(f.notify).not.toHaveBeenCalled(); expect(await f.activities.list()).toHaveLength(1);
    fail = false; await f.runtime.tick(); expect(f.notify).toHaveBeenCalledTimes(1); expect(await f.activities.list()).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('starts one worker, honors availability, and drains an in-flight read without a late notification', async () => {
    vi.useFakeTimers(); const f = fixture(); f.setLocked(true); f.runtime.start(); f.runtime.start();
    await vi.advanceTimersByTimeAsync(60_000); expect(f.notify).not.toHaveBeenCalled();
    f.setLocked(false); await vi.advanceTimersByTimeAsync(60_000); expect(f.notify).toHaveBeenCalledTimes(1);
    await f.runtime.stop(); await vi.advanceTimersByTimeAsync(120_000); expect(f.notify).toHaveBeenCalledTimes(1);
    let release!: (value: AuthenticationRepairSnapshot) => void;
    const runtime = createAuthenticationAlertRuntime({ store: f.store, auditLog: f.auditLog, notifier: { notify: f.notify },
      read: () => new Promise(resolve => { release = resolve; }) });
    const tick = runtime.tick(); const stopping = runtime.stop(); release(await f.read()); await Promise.all([tick, stopping]);
    expect(f.notify).toHaveBeenCalledTimes(1);
  });

  it('uses existing enabled notification channels and the persisted UI event, with no approval ask', async () => {
    const f = fixture(); const events: UiNotificationEvent[] = []; const remote = vi.fn();
    const settings = createNotificationSettingsStore(createInMemoryCollection<NotificationSettings>());
    const channel: Channel = { name: 'email', capability: 'landing-page', owns_llm_egress: false,
      deliverNotify: remote, deliverAsk: async () => {}, closeAsk: async () => {} };
    const asks = createInMemoryCollection<PendingAsk>();
    const block = createNotificationBlock({ askStore: createAskStore(asks), settingsStore: settings,
      channels: [createUiChannel({ busSink: e => { events.push(e); } }), channel] });
    const runtime = createAuthenticationAlertRuntime({ store: f.store, read: f.read, auditLog: f.auditLog, notifier: block });
    cleanups.push(() => runtime.stop()); await runtime.tick();
    expect(remote).not.toHaveBeenCalled(); expect(events[0]).toMatchObject({ kind: 'notification.notify', persisted_activity_id: expect.any(String),
      message: expect.objectContaining({ title: 'Connection access was rejected', link_url: '#connections/mail/inbox' }) });
    await settings.setChannelMode('email', { notification: true });
    f.instances[0]!.auth_state = 'healthy'; f.instances[0]!.last_synced_at = clock + 1; f.setNow(clock + 1); await runtime.tick();
    expect(remote).toHaveBeenCalledTimes(1); expect(await asks.list()).toEqual([]);
  });

  it('bounds each delivery batch and retains the remaining notices', async () => {
    const f = fixture(); f.instances.splice(0);
    for (let i = 0; i < 12; i++) f.rows.push(api('api-' + i));
    await f.runtime.tick(); expect(f.notify).toHaveBeenCalledTimes(10); expect(f.store.pending()).toHaveLength(2);
    await f.runtime.tick(); expect(f.notify).toHaveBeenCalledTimes(12); expect(f.store.pending()).toEqual([]);
  });

  it('cancels a queued recovery if its account is removed before delivery', async () => {
    const f = fixture(); await f.runtime.tick(); f.setNow(clock + 100);
    f.instances[0]!.auth_state = 'healthy'; f.instances[0]!.last_synced_at = clock + 100;
    f.store.evaluate(await f.read()); expect(f.store.pending()[0]!.kind).toBe('recovery');
    f.instances.splice(0); await f.runtime.tick();
    expect(f.store.pending()).toEqual([]); expect(f.notify).toHaveBeenCalledTimes(1);
  });

  it('does not let notices hidden by incomplete inventory starve currently observed problems', async () => {
    const f = fixture(); f.instances.splice(0);
    for (let i = 0; i < 12; i++) f.rows.push(api('api-' + String(i).padStart(2, '0')));
    f.store.evaluate(await f.read()); expect(f.store.pending()).toHaveLength(12);
    f.rows.splice(0, 10); f.setAvailable(false); await f.runtime.tick();
    expect(f.notify).toHaveBeenCalledTimes(2); expect(f.store.pending()).toHaveLength(10);
    f.setAvailable(true); await f.runtime.tick(); expect(f.store.pending()).toEqual([]);
  });
});

it('uses the webclient repair destinations and bounded copy on every channel', async () => {
  expect(authenticationRepairHash({ kind: 'connection', name: 'work' })).toBe(connectionsReviewAccessAddress('work').hash);
  expect(authenticationRepairHash({ kind: 'collection', platform: 'mail', slug: 'work / inbox' })).toBe(connectionsAccountAddress('mail', 'work / inbox').hash);
  expect(authenticationRepairHash({ kind: 'oauth_apps' })).toBe(connectionsOAuthAppsAddress().hash);
  expect(authenticationRepairHash({ kind: 'connection', name: 'bad/name' })).toBe('#connections');
  const f = fixture(); f.store.evaluate(await f.read()); const notice = f.store.pending()[0]!;
  notice.group.label = 'a\n'.repeat(1000); notice.group.uses = Array.from({ length: 8 }, (_, i) => ({ kind: 'pack', id: String(i), label: 'x'.repeat(1000) }));
  const described = authenticationAlertMessage(notice);
  expect(described.message.link_url).toBeUndefined(); expect(described.message.text.length).toBeLessThan(1300);
  expect(described.message.text).toContain('and 4 more');
});

/** ⛔ A drain step awaits the stop, with 5 s; a push goes to each channel in
 *  turn (15 s a messenger call, an email longer). */
describe('authentication alerts — stopping', () => {
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };

  it('waits no longer than the grace for local work, and the notice it left is sent after the restart', async () => {
    const f = fixture();
    const history = vi.spyOn(f.auditLog, 'logActivity').mockImplementationOnce(() => new Promise(() => {}));
    void f.runtime.tick();
    await vi.waitFor(() => expect(history).toHaveBeenCalledTimes(1));

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let stopped = false;
    const stopping = f.runtime.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS);
    await settle();
    vi.useRealTimers();
    expect(stopped).toBe(true);
    await stopping;
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.store.pending()).toHaveLength(1);

    const restarted = createAuthenticationAlertRuntime({ store: f.store, read: f.read, auditLog: f.auditLog, notifier: { notify: f.notify } });
    await restarted.tick();
    await restarted.stop();
    expect(f.notify).toHaveBeenCalledTimes(1);
  });

  it('gives a claimed push in flight the longer grace, then stops waiting: a claimed push is never replayed', async () => {
    const f = fixture();
    let release: (() => void) | undefined;
    f.notify.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    void f.runtime.tick();
    await vi.waitFor(() => expect(f.notify).toHaveBeenCalledTimes(1));
    expect(f.store.pending()).toEqual([]);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let stopped = false;
    const stopping = f.runtime.stop().then(() => { stopped = true; });
    // Longer than other work gets…
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS);
    await settle();
    expect(stopped).toBe(false);
    // …and no longer than its own grace: a drain step has 5 s.
    await vi.advanceTimersByTimeAsync(PUSH_GRACE_MS - STOP_GRACE_MS);
    await settle();
    vi.useRealTimers();
    expect(stopped).toBe(true);
    await stopping;
    release?.();
  });
});

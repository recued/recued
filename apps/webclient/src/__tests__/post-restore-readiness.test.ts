import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRestoreReadiness, mountPostRestoreReadiness, type RestoreReadinessPorts } from '../settings/post-restore-readiness.js';
import type { ArchiveImportReceiptController, ArchiveImportReceiptState } from '../settings/archive-import-receipt.js';
import type { WebclientConnectionStatus } from '../realtime/connection-status.js';
import { PickerElement } from './helpers/file-download-picker-dom.js';

const NOW = 1_000_000;
const destination = { connection_name: 'fixture', destination_id: 'current' };
const schedule = { cadence: 'daily', hour_utc: 2, minute_utc: 0, weekday_utc: 0 };
const snapshot = () => ({
  destinations: { destinations: [destination] },
  unattended: { configured: true, settings: { ...destination, enabled: true, keep_last: 5, schedule } },
  health: { checked_at: NOW, monitoring: 'active', destination, policy: { alerts_enabled: true }, alerts: [],
    backup: { state: 'current', created_at: NOW - 1000, due_at: NOW + 1000 },
    recovery: { state: 'current', finished_at: NOW - 1000, due_at: NOW + 1000 } },
  integrity: { monitoring: 'active', destination, policy: { enabled: true }, last_run: {
    destination_id: destination.destination_id, outcome: 'completed', total: 2, checked: 2, failed: 0, skipped: 0, finished_at: NOW - 500,
  } },
  watchdog: { configured: true, enabled: true, state: 'acknowledged', last_acknowledged_at: NOW - 50, drill: {
    phase: 'completed', current_configuration: true, started_at: NOW - 1000, resumed_at: NOW - 500,
    alert_reported_at: NOW - 600, ping_acknowledged_at: NOW - 300, finished_at: NOW - 200,
  } },
});
const row = (s: Parameters<typeof buildRestoreReadiness>[0], id: string) => buildRestoreReadiness(s, NOW).find(r => r.id === id)!;

describe('post-restore current readiness evidence', () => {
  it('keeps seven independent results and qualifies backup, scan, and owner-reported alert proof', () => {
    const rows = buildRestoreReadiness(snapshot(), NOW);
    expect(rows.map(r => r.state)).toEqual(Array(7).fill('ready'));
    expect(row(snapshot(), 'recovery').detail).toContain('earlier copy');
    expect(row(snapshot(), 'drill').detail).toContain('not independently verified');
  });
  it('does not promote an import, Passport, missing status, malformed fields, or raw provider text into readiness', () => {
    const invalid = { profile: 'migration_full', recovery: { backup_status: 'configured' }, completed: true, secret: 'https://private.example/token' };
    for (const value of [undefined, null, invalid, { configured: 'true' }, { monitoring: 'other', policy: {} }]) {
      const result = buildRestoreReadiness({ unattended: value, health: value, integrity: value, watchdog: value }, NOW);
      expect(result.every(r => r.state === 'unavailable')).toBe(true);
      expect(JSON.stringify(result)).not.toContain('private.example');
    }
  });
  it.each([
    [{ configured: false }, 'Set up unattended'],
    [{ configured: true, settings: { enabled: false } }, 'paused'],
    [{ configured: true, settings: { ...destination, enabled: true }, last_run: { outcome: 'failed', issue: 'setup_required' } }, 'backup key'],
    [{ configured: true, settings: { ...destination, enabled: true }, last_run: { outcome: 'failed' } }, 'latest backup'],
  ])('explains schedule action from fresh state %j', (unattended, copy) => {
    expect(row({ ...snapshot(), unattended }, 'schedule')).toMatchObject({ state: 'attention', detail: expect.stringContaining(copy) });
  });
  it('requires the current destination and enabled setup before using health or S3 passing claims', () => {
    for (const destinations of [undefined, { destinations: [] }, { destinations: [{ ...destination, destination_id: 'old' }] }]) {
      const value = { ...snapshot(), destinations };
      expect(row(value, 'schedule').state).toBe('attention');
      expect(row(value, 'backup').state).toBe('unavailable'); expect(row(value, 'recovery').state).toBe('unavailable');
      expect(row(value, 'integrity').state).toBe('attention');
    }
    expect(row({ ...snapshot(), unattended: { configured: false } }, 'backup').state).toBe('unavailable');
  });
  it.each(['paused', 'not_configured'])('does not reuse passing health claims when monitoring is %s', monitoring => {
    const value = snapshot(); value.health.monitoring = monitoring;
    for (const id of ['backup', 'recovery', 'alerts']) expect(row(value, id).state).toBe('attention');
  });
  it('distinguishes waiting, overdue, stale, future, and unavailable age evidence', () => {
    const value = snapshot(); value.health.backup.state = 'waiting'; value.health.recovery.state = 'due';
    expect(row(value, 'backup').state).toBe('waiting'); expect(row(value, 'recovery').state).toBe('attention');
    value.health.checked_at = NOW - 60_001; expect(row(value, 'backup').state).toBe('unavailable');
    value.health.checked_at = NOW + 1; expect(row(value, 'recovery').state).toBe('unavailable');
    value.health.checked_at = NOW; value.health.backup.state = 'current'; value.health.backup.due_at = NOW - 1;
    expect(row(value, 'backup').state).toBe('attention');
    value.health.backup.due_at = NOW + 1000; value.health.backup.created_at = NOW + 1;
    expect(row(value, 'backup').state).toBe('unavailable');
  });
  it.each([
    [{ outcome: 'completed', total: 0, checked: 0, failed: 0, skipped: 0 }, 'waiting', 'empty'],
    [{ outcome: 'completed', total: 2, checked: 1, failed: 0, skipped: 1 }, 'attention', 'partial'],
    [{ outcome: 'failed', total: 2, checked: 1, failed: 1, skipped: 0 }, 'attention', 'failed'],
    [{ outcome: 'running' }, 'waiting', 'progress'],
  ])('does not call an empty, partial, failed, or running scan a pass', (last_run, state, copy) => {
    expect(row({ ...snapshot(), integrity: { ...snapshot().integrity, last_run } }, 'integrity')).toMatchObject({ state, detail: expect.stringContaining(copy) });
  });
  it('preserves failed scan warnings when checks are disabled, and treats an unused optional check as off', () => {
    const value = snapshot(); value.integrity.policy.enabled = false;
    expect(row(value, 'integrity').state).toBe('optional');
    value.integrity.last_run.failed = 1; expect(row(value, 'integrity').state).toBe('attention');
    value.integrity.monitoring = 'unavailable'; expect(row(value, 'integrity').state).toBe('unavailable');
  });
  it('distinguishes health alert configuration and pending delivery from owner receipt', () => {
    const value = snapshot(); value.health.policy.alerts_enabled = false; expect(row(value, 'alerts').state).toBe('attention');
    expect(row({ ...snapshot(), health: { ...snapshot().health, alerts: [{ delivery: 'pending' }] } }, 'alerts').detail).toContain('waiting');
    expect(row(snapshot(), 'alerts').detail).toContain('do not prove a message reached you');
  });
  it.each(['not_configured', 'paused', 'blocked', 'failed', 'drill_paused', 'waiting', 'sending', 'unavailable', 'future'])('cannot turn monitor state %s into an acknowledged signal', state => {
    const w = { configured: state !== 'not_configured', enabled: !['not_configured', 'paused'].includes(state), state };
    expect(row({ watchdog: w }, 'monitor').state).not.toBe('ready');
  });
  it('rejects contradictory monitor flags, future pings, old pings, missing drill proof, and drills for old setups', () => {
    const value = snapshot(); value.watchdog.enabled = false;
    expect(row(value, 'monitor').state).toBe('unavailable'); expect(row(value, 'drill').state).toBe('unavailable');
    value.watchdog.enabled = true; value.watchdog.last_acknowledged_at = NOW + 1; expect(row(value, 'monitor').state).toBe('unavailable');
    value.watchdog.last_acknowledged_at = NOW - 300_001; expect(row(value, 'monitor').state).toBe('attention');
    value.watchdog.drill.current_configuration = false; expect(row(value, 'drill').state).toBe('attention');
    value.watchdog.drill.current_configuration = true; value.watchdog.drill.ping_acknowledged_at = NOW - 900;
    expect(row(value, 'drill').state).toBe('attention');
    expect(row({ ...snapshot(), watchdog: { ...snapshot().watchdog, drill: { current_configuration: true, phase: 'completed' } } }, 'drill').state).toBe('attention');
  });
});

class Element extends PickerElement { removeAttribute(name: string) { this.attrs.delete(name); } }
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); vi.useRealTimers(); });
const setup = (initial: ArchiveImportReceiptState | null = 'completed', ports?: RestoreReadinessPorts, timeoutMs?: number) => {
  const root = new Element(), document = { createElement: () => new Element() } as unknown as Document;
  let state = initial, connection: WebclientConnectionStatus = 'connected';
  const subscribers = new Set<() => void>(), connections = new Set<(value: WebclientConnectionStatus) => void>();
  const receipt: ArchiveImportReceiptController = { read: () => state, reviewOnBoot: false, wrapImport: call => call,
    refresh: () => {}, dismiss: () => {}, subscribe: cb => { subscribers.add(cb); return () => { subscribers.delete(cb); }; }, dispose: () => {} };
  const get = vi.fn<NonNullable<RestoreReadinessPorts['watchdog']>['get']>(async () => ({ configured: false, enabled: false, state: 'not_configured' }));
  const onReview = vi.fn();
  const dispose = mountPostRestoreReadiness({ host: root as unknown as HTMLElement, document, receipt,
    ports: ports ?? { watchdog: { get } }, connection: { status: () => connection, onStatus: cb => { connections.add(cb); return () => { connections.delete(cb); }; } },
    onReview, ...(timeoutMs === undefined ? {} : { timeoutMs }) }); disposals.push(dispose);
  const set = (next: ArchiveImportReceiptState | null) => { state = next; for (const cb of subscribers) cb(); };
  const node = (name: string) => root.querySelector(`[data-restore-readiness-${name}]`)!;
  return { root, get, set, node, dispose, onReview, connections, subscribers,
    connect: (next: WebclientConnectionStatus) => { connection = next; for (const cb of connections) cb(next); } };
};
describe('post-restore readiness lifecycle', () => {
  it.each([null, 'checking', 'preparing', 'waiting_for_restart', 'not_applied', 'recovery_required', 'unknown', 'unavailable'] as const)('does not read or show readiness for receipt %s', async state => {
    const h = setup(state); await Promise.resolve(); expect(h.get).not.toHaveBeenCalled(); expect(h.root.getAttribute('hidden')).toBe('');
    h.set('completed'); await vi.waitFor(() => expect(h.get).toHaveBeenCalledTimes(1)); expect(h.root.getAttribute('hidden')).toBeNull();
  });
  it('loads independently on confirmed completion, exposes explicit review and refresh, and unsubscribes on disposal', async () => {
    const h = setup(); await vi.waitFor(() => expect(h.node('status').textContent).toContain('Status read'));
    h.root.querySelector('[data-restore-readiness-review="monitor"]')!.click(); expect(h.onReview).toHaveBeenCalledWith('monitor');
    h.node('refresh').click(); await vi.waitFor(() => expect(h.get).toHaveBeenCalledTimes(2));
    h.dispose(); expect(h.subscribers.size).toBe(0); expect(h.connections.size).toBe(0);
  });
  it('bounds hanging reads, keeps other statuses available, and limits each source to one unresolved read', async () => {
    vi.useFakeTimers(); let reply!: (value: Awaited<ReturnType<NonNullable<RestoreReadinessPorts['watchdog']>['get']>>) => void;
    const get = vi.fn(() => new Promise<Awaited<ReturnType<NonNullable<RestoreReadinessPorts['watchdog']>['get']>>>(resolve => { reply = resolve; }));
    const h = setup('completed', { watchdog: { get }, unattended: { get: async () => ({ configured: false }) } }, 20);
    await vi.advanceTimersByTimeAsync(21); expect(h.node('status').textContent).toContain('Status read');
    expect(h.root.querySelector('[data-restore-readiness-item="monitor"]')!.getAttribute('data-restore-readiness-state')).toBe('unavailable');
    expect(h.root.querySelector('[data-restore-readiness-item="schedule"]')!.getAttribute('data-restore-readiness-state')).toBe('attention');
    h.node('refresh').click(); await vi.advanceTimersByTimeAsync(21); expect(get).toHaveBeenCalledTimes(1);
    reply({ configured: true, enabled: true, state: 'acknowledged', last_acknowledged_at: Date.now() }); await vi.advanceTimersByTimeAsync(0);
    expect(h.root.textContent).not.toContain('within the last five minutes');
  });
  it('drops old responses on a new receipt, disconnect, clear, and route disposal', async () => {
    let reply!: (value: Awaited<ReturnType<NonNullable<RestoreReadinessPorts['watchdog']>['get']>>) => void;
    const get = vi.fn(() => new Promise<Awaited<ReturnType<NonNullable<RestoreReadinessPorts['watchdog']>['get']>>>(resolve => { reply = resolve; }));
    const h = setup('completed', { watchdog: { get } }); await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    h.connect('offline'); expect(h.node('status').textContent).toContain('Connection lost');
    reply({ configured: true, enabled: true, state: 'acknowledged', last_acknowledged_at: Date.now() }); await Promise.resolve(); await Promise.resolve();
    expect(h.root.textContent).not.toContain('within the last five minutes');
    h.set('checking'); expect(h.root.getAttribute('hidden')).toBe(''); h.set(null); h.dispose();
    expect(h.root.textContent).not.toContain('within the last five minutes');
  });
  it('does not dispatch reads when the receipt is invalidated in the same turn', async () => {
    const h = setup(); h.set('checking'); await Promise.resolve(); await Promise.resolve(); expect(h.get).not.toHaveBeenCalled();
  });
  it('rejects the whole snapshot if the selected pair changes after individual status reads finish', async () => {
    const assertCurrentPair = vi.fn(async () => { throw new Error('private selected server details'); });
    const h = setup('completed', { assertCurrentPair, watchdog: { get: async () => ({ configured: true, enabled: true, state: 'acknowledged', last_acknowledged_at: Date.now() }) } });
    await vi.waitFor(() => expect(h.node('status').textContent).toContain('Status read'));
    expect(assertCurrentPair).toHaveBeenCalledTimes(1);
    expect(h.root.querySelector('[data-restore-readiness-item="monitor"]')!.getAttribute('data-restore-readiness-state')).toBe('unavailable');
    expect(h.root.textContent).not.toContain('private selected');
  });
  it.each(['checking', 'clear', 'dispose'] as const)('rejects a late passing read after %s', async action => {
    let reply!: (value: Awaited<ReturnType<NonNullable<RestoreReadinessPorts['watchdog']>['get']>>) => void;
    const get = vi.fn(() => new Promise<Awaited<ReturnType<NonNullable<RestoreReadinessPorts['watchdog']>['get']>>>(resolve => { reply = resolve; }));
    const h = setup('completed', { watchdog: { get } }); await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    if (action === 'dispose') h.dispose(); else h.set(action === 'clear' ? null : 'checking');
    reply({ configured: true, enabled: true, state: 'acknowledged', last_acknowledged_at: Date.now() });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.root.textContent).not.toContain('within the last five minutes');
  });
});

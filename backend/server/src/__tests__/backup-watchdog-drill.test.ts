import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isReservedLocalRpc, MCP_TOOL_CATALOG, type BackupWatchdogDrillStart, type ServerBackupHealthSnapshot, type ServerRpcRegistry } from '@recued/contracts';
import { createBackupWatchdog, backupWatchdogPath } from '../archive/backup-watchdog.js';
import { makeArchiveHandlers } from '../archive/archive-handler.js';
import { createRpcDispatcher } from '../rpc-dispatcher.js';
import * as durable from '../durable-fs.js';

const epoch = Date.UTC(2026, 9, 21), minute = 60_000;
const closes: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0).reverse()) await close(); });
const setup = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-alert-drill-')), dbPath = join(dir, 'server.db');
  closes.push(() => rmSync(dir, { force: true, recursive: true }));
  let at = epoch, canRun = true, locked = false;
  let evidence: ServerBackupHealthSnapshot = { age_ms: 0, monitoring: 'active', backup_state: 'current', recovery_test_state: 'current', integrity: { monitoring: 'paused', state: 'not_checked' } };
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response('OK'));
  const make = () => {
    const service = createBackupWatchdog({ dbPath, now: () => at, canRun: () => canRun, fetchImpl,
      getEncryptionKey: () => locked ? null : new Uint8Array(32).fill(17), readEvidence: () => evidence });
    closes.push(() => service.stop()); return service;
  };
  const service = make(), path = backupWatchdogPath(dbPath);
  await service.save({ enabled: true, ping_url: 'https://monitor.example/private-token' }); await service.tick();
  const input = (pause_minutes: BackupWatchdogDrillStart['pause_minutes'] = 10): BackupWatchdogDrillStart => ({
    operation_id: randomUUID(), configuration_revision: service.status().configuration_revision!, pause_minutes,
  });
  const update = (operation_id: string, action: 'confirm_alert' | 'cancel') => service.updateDrill({ operation_id, action });
  return { dir, service, path, make, input, update, fetchImpl, advance: (ms: number) => { at += ms; },
    healthy: (value: boolean) => { evidence = { ...evidence, backup_state: value ? 'current' : 'due' }; },
    canRun: (value: boolean) => { canRun = value; }, locked: (value: boolean) => { locked = value; } };
};

describe('guided monitor alert drill', () => {
  it('pauses durably without sending, never extends a repeated start, and resumes at the original deadline after restart', async () => {
    const h = await setup(), input = h.input();
    const started = h.service.startDrill(input); expect(started).toMatchObject({ state: 'drill_paused', drill: { phase: 'paused', pause_until: epoch + 10 * minute, current_configuration: true } });
    const raw = readFileSync(h.path, 'utf8'); expect(JSON.parse(raw).v).toBe(2); expect(raw).not.toContain('private-token');
    h.advance(9 * minute); h.service.startDrill(input); await h.service.tick();
    expect(readFileSync(h.path, 'utf8')).toBe(raw); expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    await h.service.stop(); const restarted = h.make(); await restarted.tick(); expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    h.advance(minute); expect(restarted.status().drill).toMatchObject({ phase: 'resuming', resumed_at: epoch + 10 * minute });
    expect(readFileSync(h.path, 'utf8')).toBe(raw); // A read never rewrites the deadline or performs work.
    await restarted.tick(); expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    expect(restarted.status().drill).toMatchObject({ phase: 'awaiting_confirmation', ping_acknowledged_at: epoch + 10 * minute });
    expect(restarted.status().drill?.alert_reported_at).toBeUndefined();
    restarted.updateDrill({ operation_id: input.operation_id, action: 'confirm_alert' });
    expect(restarted.status().drill?.phase).toBe('completed');
  });

  it('requires a fresh post-resumption acknowledgment after an owner report and records the report as a separate fact', async () => {
    const h = await setup(), input = h.input(); h.service.startDrill(input); h.advance(3 * minute);
    const reported = h.update(input.operation_id, 'confirm_alert');
    expect(reported.drill).toMatchObject({ phase: 'resuming', resumed_at: epoch + 3 * minute, alert_reported_at: epoch + 3 * minute });
    expect(reported.drill?.ping_acknowledged_at).toBeUndefined(); expect(reported.last_acknowledged_at).toBe(epoch);
    h.advance(minute); h.update(input.operation_id, 'confirm_alert');
    expect(h.service.status().drill?.alert_reported_at).toBe(epoch + 3 * minute);
    h.fetchImpl.mockResolvedValueOnce(new Response('rate limited')); await h.service.tick();
    expect(h.service.status().drill?.phase).toBe('resuming'); h.advance(minute); await h.service.tick();
    expect(h.service.status().drill).toMatchObject({ phase: 'completed', ping_acknowledged_at: epoch + 5 * minute, finished_at: epoch + 5 * minute });
    const raw = readFileSync(h.path, 'utf8'); h.service.startDrill(input); h.update(input.operation_id, 'confirm_alert');
    expect(readFileSync(h.path, 'utf8')).toBe(raw);
  });

  it('expires the pause without bypassing backup proof, vault, maintenance or drain gates', async () => {
    const h = await setup(), input = h.input(); h.service.startDrill(input); h.advance(10 * minute);
    h.healthy(false); await h.service.tick(); expect(h.service.status()).toMatchObject({ state: 'blocked', drill: { phase: 'resuming' } });
    h.healthy(true); h.canRun(false); await h.service.tick(); h.canRun(true);
    h.locked(true); await h.service.tick(); expect(h.service.status().issue).toBe('vault_unavailable');
    expect(h.fetchImpl).toHaveBeenCalledTimes(1); h.locked(false); await h.service.tick(); expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    await h.service.stop(); h.advance(minute); await h.service.tick(); expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    h.service.resume(); await h.service.tick(); expect(h.service.status().drill?.phase).toBe('awaiting_confirmation');
    h.update(input.operation_id, 'cancel'); expect(h.service.status().drill?.phase).toBe('cancelled');
  });

  it('cancels without a success claim, aborts pending pings, and rejects replies or actions from older drills', async () => {
    const h = await setup(), first = h.input(); h.service.startDrill(first); h.advance(10 * minute);
    let reply = (_: Response) => {}; h.fetchImpl.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
    const tick = h.service.tick(); await vi.waitFor(() => expect(h.fetchImpl).toHaveBeenCalledTimes(2));
    h.update(first.operation_id, 'cancel'); const cancelled = readFileSync(h.path, 'utf8');
    expect(h.fetchImpl.mock.calls[1]![1]!.signal?.aborted).toBe(true); reply(new Response('OK')); await tick;
    expect(readFileSync(h.path, 'utf8')).toBe(cancelled); expect(h.service.status().drill?.ping_acknowledged_at).toBeUndefined();
    h.update(first.operation_id, 'cancel'); expect(readFileSync(h.path, 'utf8')).toBe(cancelled);
    h.advance(minute); await h.service.tick(); const second = h.input(15); h.service.startDrill(second);
    expect(() => h.service.startDrill(first)).toThrow(); expect(() => h.update(first.operation_id, 'confirm_alert')).toThrow();
    expect(h.service.status().drill?.operation_id).toBe(second.operation_id);
  });

  it('supersedes open drills on any setup save and fences old starts, updates and late acknowledgments', async () => {
    const h = await setup(), input = h.input(); h.service.startDrill(input); h.advance(10 * minute);
    let reply = (_: Response) => {}; h.fetchImpl.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
    const tick = h.service.tick(); await vi.waitFor(() => expect(h.fetchImpl).toHaveBeenCalledTimes(2));
    await h.service.save({ enabled: true }); const raw = readFileSync(h.path, 'utf8'); reply(new Response('OK')); await tick;
    expect(readFileSync(h.path, 'utf8')).toBe(raw);
    expect(h.service.status().drill).toMatchObject({ phase: 'superseded', current_configuration: false });
    expect(() => h.service.startDrill(input)).toThrow(); expect(() => h.update(input.operation_id, 'cancel')).toThrow();
    await h.service.save({ enabled: false, forget: true }); expect(h.service.status()).toMatchObject({ state: 'not_configured', drill: { current_configuration: false } });
  });

  it('requires current configuration, healthy evidence and a recent acknowledgment with no active send', async () => {
    const h = await setup(); h.advance(2 * minute); expect(() => h.service.startDrill(h.input())).toThrow();
    await h.service.tick(); h.healthy(false); expect(() => h.service.startDrill(h.input())).toThrow(); h.healthy(true);
    h.canRun(false); expect(() => h.service.startDrill(h.input())).toThrow(); h.canRun(true);
    expect(() => h.service.startDrill({ ...h.input(), configuration_revision: randomUUID() })).toThrow();
    h.advance(minute); let reply = (_: Response) => {}; h.fetchImpl.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
    const tick = h.service.tick(); await vi.waitFor(() => expect(h.fetchImpl).toHaveBeenCalledTimes(3));
    expect(() => h.service.startDrill(h.input())).toThrow(); reply(new Response('OK')); await tick;
    h.service.startDrill(h.input()); expect(() => h.service.startDrill(h.input())).toThrow();
  });

  it('rejects closed-shape violations and cannot pause without a durable write', async () => {
    const h = await setup(), input = h.input(); const raw = readFileSync(h.path, 'utf8');
    for (const value of [{ ...input, pause_minutes: 0 }, { ...input, pause_minutes: 11 }, { ...input, operation_id: 'private' }, { ...input, recovery_words: 'private' }]) expect(() => h.service.startDrill(value)).toThrow();
    vi.spyOn(durable, 'writeFileAtomicSync').mockImplementationOnce(() => { throw new Error('private path'); });
    expect(() => h.service.startDrill(input)).toThrow('could not be saved'); expect(readFileSync(h.path, 'utf8')).toBe(raw);
    h.service.startDrill(input); const paused = readFileSync(h.path, 'utf8');
    expect(() => h.service.updateDrill({ operation_id: input.operation_id, action: 'confirm_alert', text: 'private' })).toThrow();
    vi.spyOn(durable, 'writeFileAtomicSync').mockImplementationOnce(() => { throw new Error('private path'); });
    expect(() => h.update(input.operation_id, 'cancel')).toThrow(); expect(readFileSync(h.path, 'utf8')).toBe(paused);
  });

  it('fails closed for malformed durable drill records and clock rollback without rewriting proof', async () => {
    const h = await setup(), input = h.input(); h.service.startDrill(input); const raw = readFileSync(h.path, 'utf8');
    const saved = JSON.parse(raw);
    for (const drill of [{ ...saved.drill, pause_until: epoch + 1 }, { ...saved.drill, phase: 'completed' }, { ...saved.drill, alert_reported_at: epoch }, { ...saved.drill, private: 'secret' }, { ...saved.drill, bound_revision: randomUUID() }]) {
      writeFileSync(h.path, JSON.stringify({ ...saved, drill })); await h.service.tick();
      expect(h.service.status().issue).toBe('settings_unavailable'); expect(() => h.update(input.operation_id, 'cancel')).toThrow();
    }
    writeFileSync(h.path, raw); h.advance(-1); await h.service.tick();
    expect(h.service.status().issue).toBe('clock_changed'); expect(() => h.update(input.operation_id, 'confirm_alert')).toThrow();
    expect(readFileSync(h.path, 'utf8')).toBe(raw); expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('exposes owner-only, activity-counting drill RPCs through the archive handler', async () => {
    const h = await setup(), { slice } = makeArchiveHandlers({ runtime: {} as never, dataPath: h.dir, backupWatchdog: h.service });
    const touchActivity = vi.fn(), dispatch = createRpcDispatcher<ServerRpcRegistry, never>(slice!.handlers, { touchActivity });
    const input = h.input(); expect((await dispatch('server.archive.watchdog.drill.start', { ...input }, {} as never)).ok).toBe(true);
    expect((await dispatch('server.archive.watchdog.drill.update', { operation_id: input.operation_id, action: 'cancel' }, {} as never)).ok).toBe(true);
    expect(touchActivity).toHaveBeenCalledTimes(2);
    for (const method of ['server.archive.watchdog.drill.start', 'server.archive.watchdog.drill.update']) { expect(isReservedLocalRpc(method)).toBe(true); expect(MCP_TOOL_CATALOG).not.toContain(method); }
    const absent = makeArchiveHandlers({ runtime: {} as never, dataPath: h.dir }).slice!;
    await expect(absent.handlers['server.archive.watchdog.drill.start']!({ ...input }, {} as never)).rejects.toMatchObject({ code: 'not_configured' });
  });
});

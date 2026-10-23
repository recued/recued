import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BACKUP_WATCHDOG_INTERVAL_MS, isReservedLocalRpc, MCP_TOOL_CATALOG, type ServerBackupHealthSnapshot, type ServerRpcRegistry } from '@recued/contracts';
import { createBackupWatchdog, backupWatchdogPath } from '../archive/backup-watchdog.js';
import { makeArchiveHandlers } from '../archive/archive-handler.js';
import { createRpcDispatcher } from '../rpc-dispatcher.js';
import { bootBackupWatchdog } from '../composition/data/scheduler/backup-watchdog/boot.js';
import { createBackgroundServiceRegistry } from '../composition/bin/wire-background-services.js';
import * as durable from '../durable-fs.js';

const epoch = Date.UTC(2026, 9, 21), url = 'https://monitor.example/secret-ping-token';
const closes: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0).reverse()) await close(); vi.useRealTimers(); });
const healthy = (): ServerBackupHealthSnapshot => ({ age_ms: 0, monitoring: 'active', backup_state: 'current', recovery_test_state: 'current', integrity: { monitoring: 'paused', state: 'not_checked' } });
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-watchdog-')), dbPath = join(dir, 'server.db');
  closes.push(() => rmSync(dir, { recursive: true, force: true }));
  let at = epoch, canRun = true, evidence = healthy(), locked = false;
  const rootKey = new Uint8Array(32).fill(67), readEvidence = vi.fn(() => structuredClone(evidence));
  const getEncryptionKey = vi.fn(() => locked ? null : Uint8Array.from(rootKey));
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response('OK'));
  const options = { dbPath, readEvidence, getEncryptionKey, fetchImpl, now: () => at, canRun: () => canRun };
  const make = () => { const service = createBackupWatchdog(options); closes.push(() => service.stop()); return service; };
  const service = make();
  return { dir, dbPath, path: backupWatchdogPath(dbPath), rootKey, service, make, options, fetchImpl, readEvidence, getEncryptionKey,
    advance: (ms = BACKUP_WATCHDOG_INTERVAL_MS) => { at += ms; }, evidence: (value: ServerBackupHealthSnapshot) => { evidence = value; },
    canRun: (value: boolean) => { canRun = value; }, locked: (value: boolean) => { locked = value; } };
};

describe('independent backup monitor sender', () => {
  it('is opt-in, seals its write-only URL and records only an acknowledged ping', async () => {
    const h = setup(); expect(h.service.status()).toEqual({ configured: false, enabled: false, state: 'not_configured' });
    await h.service.tick(); expect(existsSync(h.path)).toBe(false); expect(h.readEvidence).not.toHaveBeenCalled();
    await h.service.save({ enabled: true, ping_url: url }); expect(h.fetchImpl).not.toHaveBeenCalled();
    h.fetchImpl.mockImplementationOnce(async () => { h.advance(37); return new Response('OK\n'); });
    await h.service.tick();
    expect(h.service.status()).toMatchObject({ configured: true, enabled: true, state: 'acknowledged', last_attempt_at: epoch, last_acknowledged_at: epoch + 37 });
    expect(h.fetchImpl).toHaveBeenCalledWith(url, expect.objectContaining({ method: 'GET', redirect: 'error', body: undefined, signal: expect.any(AbortSignal) }));
    const text = readFileSync(h.path, 'utf8');
    for (const privateText of [url, 'secret-ping-token', Buffer.from(h.rootKey).toString('hex'), 'recoveryKey']) expect(text).not.toContain(privateText);
    expect(JSON.stringify(h.service.status())).not.toContain('secret-ping-token'); expect(statSync(h.path).mode & 0o777).toBe(0o600);
  });

  it('uses durable attempts to limit retries across restart and forgets the credential explicitly', async () => {
    const h = setup(); await h.service.save({ enabled: true, ping_url: url }); await h.service.tick();
    const restarted = h.make(); h.advance(BACKUP_WATCHDOG_INTERVAL_MS - 1); await restarted.tick(); expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    h.advance(1); await restarted.tick(); expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    await restarted.save({ enabled: false }); await restarted.tick(); expect(restarted.status()).toMatchObject({ configured: true, state: 'paused' });
    expect(readFileSync(h.path, 'utf8')).toContain('ciphertext');
    await restarted.save({ enabled: false, forget: true }); expect(restarted.status()).toEqual({ configured: false, enabled: false, state: 'not_configured' });
    expect(readFileSync(h.path, 'utf8')).not.toContain('ciphertext');
  });

  it('never pings on stale, missing, paused or overdue proof, or unproven enabled scans', async () => {
    const h = setup(); await h.service.save({ enabled: true, ping_url: url });
    const cases: ServerBackupHealthSnapshot[] = [
      { ...healthy(), age_ms: 120_000 }, { ...healthy(), monitoring: 'unavailable' }, { ...healthy(), monitoring: 'paused' },
      { ...healthy(), monitoring: 'not_configured' }, { ...healthy(), backup_state: 'waiting' }, { ...healthy(), backup_state: 'due' },
      { ...healthy(), recovery_test_state: 'due' }, { ...healthy(), recovery_test_state: 'unavailable' },
      ...(['running', 'not_checked', 'empty', 'failed', 'partial', 'unavailable'] as const).map(state => ({ ...healthy(), integrity: { monitoring: 'active' as const, state } })),
      { ...healthy(), integrity: { monitoring: 'paused', state: 'failed' } },
    ];
    for (const value of cases) { h.evidence(value); await h.service.tick(); expect(h.service.status().state).toBe('blocked'); }
    h.readEvidence.mockImplementationOnce(() => { throw new Error('private history'); }); await h.service.tick();
    expect(h.fetchImpl).not.toHaveBeenCalled();
    // Existing first-test grace remains valid, without claiming a passing test.
    h.evidence({ ...healthy(), recovery_test_state: 'waiting', integrity: { monitoring: 'active', state: 'completed' } });
    await h.service.tick(); expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid or credential-redirecting URLs without echoing their content', async () => {
    const h = setup();
    for (const bad of ['http://monitor.example/private', 'https://user:private@monitor.example/ping', 'https://monitor.example:444/private',
      'https://monitor.example/ping?private=secret', 'https://monitor.example/ping#private', '/private', 'file:///private', 'https://monitor.example/' + 'x'.repeat(2049)]) {
      await expect(h.service.save({ enabled: true, ping_url: bad })).rejects.toMatchObject({ code: 'invalid_args' });
      try { await h.service.save({ enabled: true, ping_url: bad }); } catch (error) { expect(String(error)).not.toContain('private'); }
    }
    await expect(h.service.save({ enabled: true })).rejects.toMatchObject({ code: 'invalid_args' });
    await expect(h.service.save({ enabled: true, ping_url: url, recoveryKey: 'private words' })).rejects.toMatchObject({ code: 'invalid_args' });
    await expect(h.service.save({ enabled: true, forget: true })).rejects.toMatchObject({ code: 'invalid_args' });
    expect(h.fetchImpl).not.toHaveBeenCalled(); expect(existsSync(h.path)).toBe(false);
  });

  it('rechecks fresh evidence after opening the URL so a pause or breach cannot admit a stale ping', async () => {
    const h = setup(); await h.service.save({ enabled: true, ping_url: url }); const raw = readFileSync(h.path, 'utf8');
    h.getEncryptionKey.mockImplementationOnce(() => { h.evidence({ ...healthy(), backup_state: 'due' }); return Uint8Array.from(h.rootKey); });
    await h.service.tick(); expect(h.fetchImpl).not.toHaveBeenCalled(); expect(readFileSync(h.path, 'utf8')).toBe(raw);
  });

  it('fails closed on damaged settings and refuses to replace the unreadable file', async () => {
    const h = setup();
    for (const text of ['{private', 'x'.repeat(8193), JSON.stringify({ v: 1, enabled: true })]) {
      writeFileSync(h.path, text); expect(h.service.status()).toMatchObject({ state: 'unavailable', issue: 'settings_unavailable' });
      await h.service.tick(); await expect(h.service.save({ enabled: false, forget: true })).rejects.toMatchObject({ code: 'not_configured' });
      expect(readFileSync(h.path, 'utf8')).toBe(text);
    }
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it('does not admit a request when its durable attempt cannot be saved', async () => {
    const h = setup(); await h.service.save({ enabled: true, ping_url: url });
    const raw = readFileSync(h.path, 'utf8'); vi.spyOn(durable, 'writeFileAtomicSync').mockImplementationOnce(() => { throw new Error('private path'); });
    await h.service.tick(); expect(h.fetchImpl).not.toHaveBeenCalled(); expect(readFileSync(h.path, 'utf8')).toBe(raw);
  });

  it('bounds vault errors and retries them only after the durable interval', async () => {
    const h = setup(); h.locked(true); await expect(h.service.save({ enabled: true, ping_url: url })).rejects.toMatchObject({ code: 'locked' });
    h.locked(false); await h.service.save({ enabled: true, ping_url: url }); h.locked(true); h.getEncryptionKey.mockClear();
    await h.service.tick(); expect(h.service.status()).toMatchObject({ state: 'failed', issue: 'vault_unavailable' });
    await h.make().tick(); expect(h.getEncryptionKey).toHaveBeenCalledTimes(1); expect(h.fetchImpl).not.toHaveBeenCalled();
    h.locked(false); h.advance(); await h.service.tick(); expect(h.service.status().state).toBe('acknowledged');
    h.advance(); h.locked(true); h.getEncryptionKey.mockClear(); await h.service.tick(); await h.make().tick();
    expect(h.getEncryptionKey).toHaveBeenCalledTimes(1);
  });

  it('requires the bounded OK response, including HTTP 200 not-found or rate-limit replies', async () => {
    const h = setup(); await h.service.save({ enabled: true, ping_url: url });
    for (const response of [new Response('not found'), new Response('rate limited'), new Response('OK', { status: 201 }), new Response('private provider body', { status: 500 }), new Response('x'.repeat(65))]) {
      h.fetchImpl.mockResolvedValueOnce(response); await h.service.tick();
      expect(h.service.status()).toMatchObject({ state: 'failed', issue: 'ping_failed' });
      expect(JSON.stringify(h.service.status())).not.toContain('private'); h.advance();
    }
    h.fetchImpl.mockRejectedValueOnce(new Error(url)); await h.service.tick();
    expect(JSON.stringify(h.service.status())).not.toContain('secret-ping-token'); h.advance();
    await h.service.tick(); expect(h.service.status().state).toBe('acknowledged');
  });

  it('rejects late acknowledgments after endpoint replacement or disable', async () => {
    const h = setup(); await h.service.save({ enabled: true, ping_url: url });
    let reply = (_value: Response) => {};
    h.fetchImpl.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
    const tick = h.service.tick(); await vi.waitFor(() => expect(h.fetchImpl).toHaveBeenCalledTimes(1));
    await h.service.tick(); expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    await h.service.save({ enabled: true, ping_url: 'https://other.example/new-private-token' });
    const replacement = readFileSync(h.path, 'utf8'); reply(new Response('OK')); await tick;
    expect(readFileSync(h.path, 'utf8')).toBe(replacement); expect(h.service.status().last_acknowledged_at).toBeUndefined();
    h.fetchImpl.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
    const second = h.service.tick(); await vi.waitFor(() => expect(h.fetchImpl).toHaveBeenCalledTimes(2));
    await h.service.save({ enabled: false }); const disabled = readFileSync(h.path, 'utf8'); reply(new Response('OK')); await second;
    expect(readFileSync(h.path, 'utf8')).toBe(disabled); expect(h.service.status().state).toBe('paused');
  });

  it('honors maintenance, drain, rebuild and clock rollback without new network work', async () => {
    const h = setup(); await h.service.save({ enabled: true, ping_url: url });
    const registry = createBackgroundServiceRegistry(), slot = bootBackupWatchdog({ registry, backupWatchdog: h.service })!;
    closes.push(() => registry.stopAll()); expect(slot.name).toBe('backup-watchdog');
    h.canRun(false); await h.service.tick(); expect(h.fetchImpl).not.toHaveBeenCalled(); h.canRun(true);
    await h.service.tick(); const raw = readFileSync(h.path, 'utf8'); h.advance(-1); await h.service.tick();
    expect(h.service.status()).toMatchObject({ state: 'unavailable', issue: 'clock_changed' }); expect(readFileSync(h.path, 'utf8')).toBe(raw);
    await registry.stopAll({ kind: 'scheduler' }); h.advance(120_000); await h.service.tick(); expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    slot.rebuild!(); await h.service.tick(); expect(h.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('registers idle-exempt owner reads and non-agent setup RPCs', async () => {
    const h = setup(), { slice } = makeArchiveHandlers({ runtime: {} as never, dataPath: h.dir, backupWatchdog: h.service });
    const touchActivity = vi.fn(), dispatch = createRpcDispatcher<ServerRpcRegistry, never>(slice!.handlers, { touchActivity });
    expect((await dispatch('server.archive.watchdog.get', {}, {} as never)).ok).toBe(true); expect(touchActivity).not.toHaveBeenCalled();
    expect((await dispatch('server.archive.watchdog.save', { enabled: true, ping_url: url }, {} as never)).ok).toBe(true); expect(touchActivity).toHaveBeenCalledTimes(1);
    for (const method of ['server.archive.watchdog.get', 'server.archive.watchdog.save']) { expect(isReservedLocalRpc(method)).toBe(true); expect(MCP_TOOL_CATALOG).not.toContain(method); }
    const absent = makeArchiveHandlers({ runtime: {} as never, dataPath: h.dir }).slice!;
    await expect(absent.handlers['server.archive.watchdog.get']!({}, {} as never)).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('aborts a real stalled response body on drain and refuses redirects without a second request', async () => {
    const h = setup(); let redirects = 0, seen = 0;
    const server = createServer((req, res) => {
      seen++;
      if (req.url === '/redirect') { res.writeHead(302, { location: '/private' }); res.end(); }
      else if (req.url === '/private') { redirects++; res.end('OK'); }
      else { res.writeHead(200); res.write('O'); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing listener');
    const base = `http://127.0.0.1:${address.port}`;
    closes.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const request = vi.fn<typeof fetch>((_target, init) => fetch(base + '/redirect', init));
    const service = createBackupWatchdog({ ...h.options, fetchImpl: request }); closes.push(() => service.stop());
    await service.save({ enabled: true, ping_url: url }); await service.tick(); expect(redirects).toBe(0); expect(service.status().state).toBe('failed');
    h.advance(); request.mockImplementation((_target, init) => fetch(base + '/stalled', init));
    const tick = service.tick(); await vi.waitFor(() => expect(seen).toBe(2));
    await service.stop(); await tick; expect(service.status().last_acknowledged_at).toBeUndefined();
  });
});

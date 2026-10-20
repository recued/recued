import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateRecoveryKey } from '@recued/crypto';
import { isReservedLocalRpc, MCP_TOOL_CATALOG, type ServerRpcRegistry } from '@recued/contracts';
import { makeArchiveHandlers, type ArchiveRuntime } from '../archive/archive-handler.js';
import { createRemoteBackups } from '../archive/remote-backups.js';
import { newExportPath } from '../archive/export-store.js';
import { createRpcDispatcher } from '../rpc-dispatcher.js';
import { remoteBackupLedgerPath } from '../archive/remote-backup-store.js';

const key = generateRecoveryKey().mnemonic;
const cleanup: string[] = [];
afterEach(async () => { for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true }); });
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-backup-rpc-')); cleanup.push(dir); mkdirSync(join(dir, 'exports'));
  const fingerprint = 'a'.repeat(64), destination = { connection_name: 'safe', destination_id: fingerprint, bucket: 'backup-bucket', region: 'us-east-1', endpoint: 'https://s3.example.test', prefix: '' };
  const options = { dbPath: join(dir, 'server.db'), destinations: () => [destination], describe: () => ({ destination, fingerprint }), resolve: async () => ({ destination, fingerprint,
    transport: { upload: async () => {}, verify: async () => ({ etag: '"synthetic-identity"' }), retrieve: async () => {}, remove: async () => {}, abort: async () => {} } }) };
  const remoteBackups = createRemoteBackups(options), path = newExportPath(dir, Date.now()); writeFileSync(path, Buffer.from('RECA encrypted test artifact'));
  const runExport = vi.fn(async () => ({ path, bytes_written: Buffer.byteLength('RECA encrypted test artifact'), expires_at: Date.now() + 60_000 }));
  const runtime: ArchiveRuntime = { canExport: () => ({ ok: true }), preflightExport: async () => ({ ok: true }), pruneExpiredExports: () => ({ deleted: [] }), runExport,
    readManifest: async () => { throw new Error('Unused read'); }, verifyRestoreRealm: async () => ({ realm: 'same', authorized: true }), runImport: async () => { throw new Error('No restore authorized'); } };
  const target = { operation_id: randomUUID(), connection_name: 'safe', destination_id: fingerprint, keep_last: 2 };
  return { dir, options, remoteBackups, runtime, runExport, target };
};
describe('owner remote archive RPC lifecycle', () => {
  it('does not use a remote job fallback as successful delivery when its history breaks', async () => {
    const h = setup(); let entered = () => {}, release = () => {};
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const resolve = h.options.resolve;
    h.options.resolve = async () => { const context = await resolve(); return { ...context,
      transport: { ...context.transport, upload: async () => { entered(); await gate; } } }; };
    const handlers = makeArchiveHandlers({ runtime: h.runtime, dataPath: h.dir, remoteBackups: h.remoteBackups });
    const start = await handlers.slice!.handlers['server.archive.export']!({ recoveryKey: key, remote: h.target }, {} as never); await started;
    writeFileSync(remoteBackupLedgerPath(h.options.dbPath), '{ broken history');
    try { await expect(handlers.slice!.handlers['server.archive.status']!({ job_id: start.job_id }, {} as never)).rejects.toThrow('Invalid remote backup history'); }
    finally { release(); }
    await vi.waitFor(() => expect(handlers.getJob(start.job_id)?.state).toBe('error'));
  });

  it('keeps local export status usable when remote history is unreadable', async () => {
    const h = setup();
    const { slice } = makeArchiveHandlers({ runtime: h.runtime, dataPath: h.dir, remoteBackups: h.remoteBackups });
    writeFileSync(remoteBackupLedgerPath(h.options.dbPath), '{ broken history');
    const start = await slice!.handlers['server.archive.export']!({ recoveryKey: key }, {} as never);
    await vi.waitFor(() => expect(h.runExport).toHaveBeenCalledTimes(1));
    await expect(slice!.handlers['server.archive.status']!({ job_id: start.job_id }, {} as never)).resolves.toMatchObject({ state: 'done' });
    expect(readFileSync(remoteBackupLedgerPath(h.options.dbPath), 'utf8')).toBe('{ broken history');
    await expect(slice!.handlers['server.archive.backups']!({}, {} as never)).rejects.toThrow('Invalid remote backup history');
    await expect(slice!.handlers['server.archive.export']!({ recoveryKey: key, remote: h.target }, {} as never)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('does not count automatic archive status and history refreshes as unlock activity', async () => {
    const touchActivity = vi.fn();
    const dispatch = createRpcDispatcher<ServerRpcRegistry, Record<string, never>>({ 'server.archive.destinations': async () => ({ destinations: [] }),
      'server.archive.backups': async () => ({ backups: [] }),
      'server.archive.status': async () => ({ state: 'running', bytes_written: 0, progress_pct: 0 }),
      'server.archive.import_status': async () => ({ status: 'unknown' }) }, { touchActivity });
    expect((await dispatch('server.archive.destinations', {}, {})).ok).toBe(true);
    expect((await dispatch('server.archive.backups', {}, {})).ok).toBe(true);
    expect((await dispatch('server.archive.status', { job_id: 'arx-123456' }, {})).ok).toBe(true);
    expect((await dispatch('server.archive.import_status', { operation_id: '12345678-1234-4234-8234-123456789abc' }, {})).ok).toBe(true);
    expect(touchActivity).not.toHaveBeenCalled();
  });
  it('reserves before asynchronous preflight and holds the shared export slot', async () => {
    const h = setup(); let release = () => {};
    h.runtime.preflightExport = () => new Promise(resolve => { release = () => resolve({ ok: true }); });
    const { slice } = makeArchiveHandlers({ runtime: h.runtime, dataPath: h.dir, remoteBackups: h.remoteBackups });
    const first = slice!.handlers['server.archive.export']!({ recoveryKey: key, remote: h.target }, {} as never);
    expect(h.remoteBackups.list()[0]?.state).toBe('preparing'); expect(h.runExport).not.toHaveBeenCalled();
    await expect(slice!.handlers['server.archive.export']!({ recoveryKey: key }, {} as never)).rejects.toMatchObject({ code: 'archive_export_in_progress' });
    release(); await first; await vi.waitFor(() => expect(h.remoteBackups.list()[0]?.state).toBe('verified'));
    expect(h.runExport).toHaveBeenCalledTimes(1);
  });

  it('returns the durable delivery result after the in-memory job map is replaced', async () => {
    const h = setup(), first = makeArchiveHandlers({ runtime: h.runtime, dataPath: h.dir, remoteBackups: h.remoteBackups });
    const start = await first.slice!.handlers['server.archive.export']!({ recoveryKey: key, remote: h.target }, {} as never);
    await vi.waitFor(() => expect(h.remoteBackups.list()[0]?.state).toBe('verified'));
    const restarted = makeArchiveHandlers({ runtime: h.runtime, dataPath: h.dir, remoteBackups: createRemoteBackups(h.options) });
    await expect(restarted.slice!.handlers['server.archive.status']!({ job_id: start.job_id }, {} as never)).resolves.toMatchObject({ state: 'done', remote_backup_id: h.target.operation_id });
    await expect(restarted.slice!.handlers['server.archive.export']!({ recoveryKey: key, remote: h.target }, {} as never)).rejects.toMatchObject({ code: 'conflict' });
    expect(h.runExport).toHaveBeenCalledTimes(1);
  });

  it('records refused preflight without exporting and keeps identifiers consumed', async () => {
    const h = setup(); h.runtime.preflightExport = async () => ({ ok: false, reason: 'synthetic full disk', need_bytes: 100, free_bytes: 0 });
    const { slice } = makeArchiveHandlers({ runtime: h.runtime, dataPath: h.dir, remoteBackups: h.remoteBackups });
    await expect(slice!.handlers['server.archive.export']!({ recoveryKey: key, remote: h.target }, {} as never)).rejects.toMatchObject({ code: 'insufficient_storage' });
    expect(h.remoteBackups.list()[0]).toMatchObject({ state: 'unconfirmed', issue: 'export_failed' }); expect(h.runExport).not.toHaveBeenCalled();
    await expect(slice!.handlers['server.archive.export']!({ recoveryKey: key, remote: h.target }, {} as never)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('keeps every archive control outside the agent MCP channel', () => {
    for (const method of ['server.archive.export', 'server.archive.destinations', 'server.archive.backups', 'server.archive.backup.check', 'server.archive.backup.retrieve']) {
      expect(isReservedLocalRpc(method)).toBe(true); expect(MCP_TOOL_CATALOG).not.toContain(method);
    }
  });
});

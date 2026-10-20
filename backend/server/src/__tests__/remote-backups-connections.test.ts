import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleConnectionEnroll, handleConnectionProbe } from '../connection-handler.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { createSqliteRemoteBackups, describeS3BackupConnection } from '../archive/remote-backups.js';
import { remoteBackupObjectKey } from '../archive/remote-backup-store.js';
import { newExportPath } from '../archive/export-store.js';
import { createRemoteBackupS3Fixture, REMOTE_FIXTURE_ACCESS, REMOTE_FIXTURE_SECRET } from './helpers/remote-backup-s3-fixture.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) await fn(); });
const setup = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-backup-connections-')); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const db = new Database(':memory:'); cleanup.push(() => { db.close(); }); const store = createConnectionStore(db);
  const s3 = await createRemoteBackupS3Fixture(); cleanup.push(() => s3.close());
  const key = new Uint8Array(32).fill(7); let unlocked = true;
  const deps = { store, getEncryptionKey: () => key };
  await handleConnectionEnroll(deps, { kind: 'api', name: 'safe', display_name: 'Safe storage',
    config: { vendor: 's3', bucket: 'backup-bucket', region: 'us-east-1', endpoint: s3.endpoint },
    auth: { type: 'basic', username: REMOTE_FIXTURE_ACCESS, password: REMOTE_FIXTURE_SECRET } });
  const service = createSqliteRemoteBackups({ db, dbPath: join(dir, 'server.db'), getKeys: () => ({ keyProvider: () => () => unlocked ? key : null }) });
  const reserve = () => {
    const target = service.destinations()[0]!; const id = randomUUID();
    service.reserve({ operation_id: id, connection_name: target.connection_name, destination_id: target.destination_id, keep_last: 2 }, `arx-${id.slice(0, 12)}`); return id;
  };
  const archive = () => { mkdirSync(join(dir, 'exports'), { recursive: true }); const path = newExportPath(dir, Date.now()); const bytes = Buffer.from('RECA synthetic ciphertext'); writeFileSync(path, bytes); return { path, bytes_written: bytes.length }; };
  return { db, store, s3, deps, service, reserve, archive, lock: () => { unlocked = false; } };
};

describe('S3 backup connection authority', () => {
  it('accepts a scoped key at the byte limit and refuses the next byte', async () => {
    const h = await setup(), id = randomUUID(), suffixBytes = Buffer.byteLength(remoteBackupObjectKey(id, id));
    const root = '/' + 'a'.repeat(1024 - suffixBytes - 1), row = { ...h.store.get('api', 'safe')!, subresource_path: root };
    const { destination } = describeS3BackupConnection(row);
    expect(Buffer.byteLength(remoteBackupObjectKey(id, id, destination.prefix))).toBe(1024);
    expect(() => describeS3BackupConnection({ ...row, subresource_path: root + 'a' })).toThrow('too long');
    expect(describeS3BackupConnection({ ...row, subresource_path: '/reports/2026-04' }).destination.prefix).toBe('reports/2026-04/');
  });

  it('rejects a malformed long scope without blocking the server event loop', async () => {
    const h = await setup(), row = { ...h.store.get('api', 'safe')!, subresource_path: '/' + 'a'.repeat(40) + '!' };
    const moduleUrl = pathToFileURL(join(import.meta.dirname, '../archive/remote-backups.ts')).href;
    const source = `import { describeS3BackupConnection } from ${JSON.stringify(moduleUrl)};
      process.on('message', row => { try { describeS3BackupConnection(row); process.send({ rejected: false }); } catch { process.send({ rejected: true }); } });
      process.send({ ready: true });`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    cleanup.push(() => { child.kill('SIGKILL'); });
    await new Promise<void>((resolve, reject) => {
      const startup = setTimeout(() => reject(new Error('Validation child did not start')), 25_000);
      child.once('error', reject);
      child.once('message', () => { clearTimeout(startup); resolve(); });
      child.once('exit', () => { clearTimeout(startup); reject(new Error('Validation child exited before ready')); });
    });
    const result = await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, 1500);
      child.once('message', value => { clearTimeout(timer); resolve(!!value && typeof value === 'object' && 'rejected' in value && value.rejected === true); });
      child.send(row);
    });
    expect(result).toBe(true);
  });

  it('checks the S3 bucket even when its file-source scope cannot be used for backups', async () => {
    const h = await setup(); h.db.prepare('UPDATE connections SET subresource_path=? WHERE name=?').run('/reports/2026 April', 'safe');
    expect(h.service.destinations()).toEqual([]);
    expect((await handleConnectionProbe(h.deps, { kind: 'api', name: 'safe' })).health.status).toBe('ok');
    expect(h.s3.calls.map(call => call.method)).toEqual(['HEAD']);
  });

  it('refuses a destination whose final generated key would exceed S3 limits', async () => {
    const h = await setup(); h.db.prepare('UPDATE connections SET subresource_path=? WHERE name=?').run('/' + 'a'.repeat(1000), 'safe');
    expect(h.service.destinations()).toEqual([]);
    expect(h.s3.calls).toHaveLength(0);
  });

  it('uses the canonical encrypted key pair for a signed probe and backup', async () => {
    const h = await setup();
    const row = h.store.get('api', 'safe')!; expect(row.auth_ciphertext).not.toContain(REMOTE_FIXTURE_SECRET);
    const result = await handleConnectionProbe(h.deps, { kind: 'api', name: 'safe' });
    expect(result.health.status).toBe('ok'); expect(h.s3.calls).toEqual([expect.objectContaining({ method: 'HEAD' })]);
    const id = h.reserve(); await h.service.publish(id, h.archive()); expect(h.service.list()[0]!.state).toBe('verified');
    expect(h.s3.calls.map(call => call.method)).toEqual(['HEAD', 'PUT', 'GET']);
  });

  it('requires an unlocked real connection key before sending any backup request', async () => {
    const h = await setup(), id = h.reserve(); h.lock();
    await expect(h.service.publish(id, h.archive())).rejects.toMatchObject({ code: 'remote_backup_unconfirmed' });
    expect(h.s3.calls).toHaveLength(0); expect(h.service.list()[0]).toMatchObject({ state: 'unconfirmed', issue: 'destination_unavailable' });
  });

  it('does not follow S3 probe redirects or expose provider bodies', async () => {
    const h = await setup(), resolveFetch = vi.fn<typeof fetch>(async () => new Response('private provider body', { status: 307, headers: { location: 'https://other.example.test' } }));
    const result = await handleConnectionProbe({ ...h.deps, resolveFetch }, { kind: 'api', name: 'safe' });
    expect(resolveFetch).toHaveBeenCalledTimes(1); expect(resolveFetch.mock.calls[0]?.[1]?.redirect).toBe('manual');
    expect(result.health).toMatchObject({ status: 'unreachable', last_error: 's3_bucket_unavailable' });
  });

  it('stops before readback when the live connection changes after upload', async () => {
    const h = await setup(), id = h.reserve(), original = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const reply = await original(url, init);
      if (init?.method === 'PUT') h.db.prepare('UPDATE connections SET config_json=? WHERE name=?').run(JSON.stringify({ vendor: 's3', bucket: 'different-bucket', region: 'us-east-1', endpoint: h.s3.endpoint }), 'safe');
      return reply;
    });
    await expect(h.service.publish(id, h.archive())).rejects.toMatchObject({ code: 'remote_backup_unconfirmed' });
    expect(h.s3.calls.map(call => call.method)).toEqual(['PUT']); expect(h.service.list()[0]).toMatchObject({ state: 'unconfirmed', issue: 'destination_unavailable' });
    expect(() => h.service.retrieve(id)).toThrow('Verify this remote backup');
  });
});

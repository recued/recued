import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArchiveRemoteDestination } from '@recued/contracts';
import { createRemoteBackups } from '../archive/remote-backups.js';
import { createRemoteBackupStore, remoteBackupLedgerPath } from '../archive/remote-backup-store.js';
import { createS3RemoteBackupTransport, RemoteBackupTransferError } from '../archive/remote-backup-s3.js';
import { newExportPath, EXPORT_TTL_MS } from '../archive/export-store.js';
import { createRemoteBackupS3Fixture, REMOTE_FIXTURE_ACCESS, REMOTE_FIXTURE_SECRET } from './helpers/remote-backup-s3-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const setup = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-backups-')), dbPath = join(dir, 'server.db');
  cleanup.push(() => rm(dir, { recursive: true, force: true })); mkdirSync(join(dir, 'exports'));
  const s3 = await createRemoteBackupS3Fixture(); cleanup.push(() => s3.close());
  const fingerprint = createHash('sha256').update(s3.endpoint).digest('hex');
  const destination: ArchiveRemoteDestination = { connection_name: 'backup', destination_id: fingerprint,
    bucket: 'backup-bucket', region: 'us-east-1', endpoint: s3.endpoint, prefix: '' };
  let current = true;
  const transport = createS3RemoteBackupTransport({ config: { access_key: REMOTE_FIXTURE_ACCESS, secret_key: REMOTE_FIXTURE_SECRET,
    bucket: destination.bucket, region: destination.region, endpoint: s3.endpoint },
    assertCurrent: () => { if (!current) throw new RemoteBackupTransferError('destination_unavailable'); } });
  const options = { dbPath, destinations: () => [destination], describe: () => ({ destination, fingerprint }),
    resolve: async () => ({ destination, fingerprint, transport }) };
  const service = createRemoteBackups(options);
  const reserve = (keep_last = 5) => {
    const id = randomUUID(), job = `arx-${randomUUID().slice(0, 12)}`;
    service.reserve({ operation_id: id, connection_name: destination.connection_name, destination_id: fingerprint, keep_last }, job); return { id, job };
  };
  const archive = (size = 8192) => {
    const path = newExportPath(dir, Date.now()), bytes = Buffer.concat([Buffer.from('RECA'), randomBytes(size)]);
    writeFileSync(path, bytes, { mode: 0o600 }); return { path, bytes, bytes_written: bytes.length, expires_at: Date.now() + EXPORT_TTL_MS };
  };
  return { dir, dbPath, s3, destination, fingerprint, service, options, reserve, archive, transport, setCurrent: (value: boolean) => { current = value; } };
};

describe('remote encrypted backup delivery', () => {
  it('never reinstates an older policy while the newer verified copy is being checked', async () => {
    const h = await setup(), a = h.reserve(5); await h.service.publish(a.id, h.archive());
    const b = h.reserve(1); h.s3.faults.corruptRead = true;
    await expect(h.service.publish(b.id, h.archive())).rejects.toMatchObject({ code: 'remote_backup_unconfirmed' }); h.s3.faults.corruptRead = false;
    const c = h.reserve(3); await h.service.publish(c.id, h.archive());
    const keyC = h.service.list().find(row => row.operation_id === c.id)!.object_key;
    let release = () => {}, entered = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const verify = h.transport.verify;
    h.transport.verify = async (key, expected, identity) => { if (key === keyC) { entered(); await gate; } return verify(key, expected, identity); };
    h.service.check(c.id); await started;
    try {
      h.service.check(b.id); await vi.waitFor(() => expect(h.service.list().find(row => row.operation_id === b.id)?.state).toBe('verified'));
      expect(h.service.list().find(row => row.operation_id === a.id)?.state).toBe('verified');
    } finally { release(); }
    await vi.waitFor(() => expect(h.service.list().find(row => row.operation_id === c.id)?.state).toBe('verified'));
    expect(h.s3.objects.size).toBe(3);
  });

  it('stops an older cleanup between deletions after a newer verified policy takes over', async () => {
    const h = await setup(), a = h.reserve(5); await h.service.publish(a.id, h.archive());
    const b = h.reserve(5); await h.service.publish(b.id, h.archive());
    const keyB = h.service.list().find(row => row.operation_id === b.id)!.object_key;
    const c = h.reserve(1); h.s3.faults.corruptRead = true;
    await expect(h.service.publish(c.id, h.archive())).rejects.toMatchObject({ code: 'remote_backup_unconfirmed' });
    h.s3.faults.corruptRead = false;
    let release = () => {}, entered = () => {}, completed = () => {};
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const finished = new Promise<void>(resolve => { completed = resolve; });
    const remove = h.transport.remove; let held = false;
    h.transport.remove = async (key, identity) => {
      if (key === keyB && !held) {
        held = true; entered(); await blocked;
        try { await remove(key, identity); } finally { completed(); }
      } else await remove(key, identity);
    };
    h.service.check(c.id); await started;
    const d = h.reserve(3); await h.service.publish(d.id, h.archive());
    expect(h.service.list().find(row => row.operation_id === a.id)?.state).toBe('verified');
    release(); await finished; await new Promise<void>(resolve => setImmediate(resolve));
    expect(h.service.list().find(row => row.operation_id === a.id)?.state).toBe('verified');
    expect(h.s3.objects.size).toBe(3);
  });

  it('streams a multipart archive, reads it back, and retains secret-free durable evidence', async () => {
    const h = await setup(), op = h.reserve(), archive = h.archive(10 * 1024 * 1024);
    await h.service.publish(op.id, archive);
    const view = h.service.list()[0]!;
    expect(view.state).toBe('verified'); expect(view.bytes).toBe(archive.bytes.length);
    expect(view.sha256).toBe(createHash('sha256').update(archive.bytes).digest('hex'));
    expect(createHash('sha256').update(h.s3.objects.get(view.object_key)!.bytes).digest('hex')).toBe(view.sha256);
    expect(h.s3.uploads.size).toBe(0); expect(h.s3.calls.filter(c => c.method === 'PUT')).toHaveLength(2);
    const saved = readFileSync(remoteBackupLedgerPath(h.dbPath), 'utf8');
    expect(saved).not.toContain(REMOTE_FIXTURE_ACCESS); expect(saved).not.toContain(REMOTE_FIXTURE_SECRET);
    expect(statSync(remoteBackupLedgerPath(h.dbPath)).mode & 0o777).toBe(0o600);
    expect(h.service.status(op.job)).toMatchObject({ state: 'done', remote_backup_id: op.id });
    expect(createRemoteBackups(h.options).list()[0]!.state).toBe('verified');
  });

  it('resolves a lost PUT reply by reading the same object without another upload', async () => {
    const h = await setup(), op = h.reserve(), archive = h.archive(); h.s3.faults.losePutReply = true;
    await h.service.publish(op.id, archive);
    expect(h.service.list()[0]!.state).toBe('verified');
    expect(h.s3.calls.filter(c => c.method === 'PUT')).toHaveLength(1);
    expect(h.s3.calls.filter(c => c.method === 'GET')).toHaveLength(1);
  });

  it('reconciles a lost multipart completion reply without uploading the parts again', async () => {
    const h = await setup(), op = h.reserve(); h.s3.faults.loseCompleteReply = true;
    await h.service.publish(op.id, h.archive(9 * 1024 * 1024));
    expect(h.service.list()[0]!.state).toBe('verified'); expect(h.s3.calls.filter(c => c.method === 'PUT')).toHaveLength(2);
    expect(h.s3.uploads.size).toBe(0); expect(h.s3.objects.size).toBe(1);
  });

  it('does not trust an ETag or delete an old copy when readback bytes are wrong', async () => {
    const h = await setup(), first = h.reserve(1); await h.service.publish(first.id, h.archive());
    const second = h.reserve(1); h.s3.faults.corruptRead = true;
    await expect(h.service.publish(second.id, h.archive())).rejects.toMatchObject({ code: 'remote_backup_unconfirmed' });
    expect(h.service.list()[0]).toMatchObject({ state: 'unconfirmed', issue: 'verification_failed' });
    expect(h.s3.objects.size).toBe(2); expect(h.s3.calls.filter(c => c.method === 'DELETE')).toHaveLength(0);
    h.s3.faults.corruptRead = false; h.service.check(second.id);
    await vi.waitFor(() => expect(h.service.list().find(row => row.operation_id === first.id)?.state).toBe('pruned'));
    expect(h.service.list()[0]!.state).toBe('verified'); expect(h.s3.objects.size).toBe(1);
  });

  it('rejects an HTTP 200 multipart Error and reclaims its unfinished parts', async () => {
    const h = await setup(), op = h.reserve(); h.s3.faults.completeError = true;
    await expect(h.service.publish(op.id, h.archive(9 * 1024 * 1024))).rejects.toMatchObject({ code: 'remote_backup_unconfirmed' });
    expect(h.service.list()[0]!.state).toBe('unconfirmed'); expect(h.s3.objects.size).toBe(0); expect(h.s3.uploads.size).toBe(0);
  });

  it('uses conditional retention and preserves a changed object and unrelated bucket contents', async () => {
    const h = await setup(), first = h.reserve(1); await h.service.publish(first.id, h.archive());
    const oldKey = h.service.list()[0]!.object_key;
    h.s3.objects.set('unrelated.recued.archive', { bytes: Buffer.from('unrelated'), etag: '"unrelated"' });
    h.s3.beforeDelete(key => { if (key === oldKey) h.s3.objects.set(key, { bytes: Buffer.from('changed externally'), etag: '"changed"' }); });
    const second = h.reserve(1); await h.service.publish(second.id, h.archive());
    expect(h.service.list()[0]).toMatchObject({ state: 'verified', retention_pending: true });
    expect(h.s3.objects.get(oldKey)?.bytes.toString()).toBe('changed externally'); expect(h.s3.objects.has('unrelated.recued.archive')).toBe(true);
    expect(h.service.list().find(row => row.operation_id === first.id)?.state).toBe('pruning');
  });

  it('does not send another request after its connection changes', async () => {
    const h = await setup(), op = h.reserve(); h.setCurrent(false);
    await expect(h.service.publish(op.id, h.archive())).rejects.toMatchObject({ code: 'remote_backup_unconfirmed' });
    expect(h.s3.calls).toHaveLength(0); expect(h.service.list()[0]!.state).toBe('unconfirmed');
  });

  it('stages only verified retrieved bytes and reuses them without an import or another download', async () => {
    const h = await setup(), op = h.reserve(), archive = h.archive(); await h.service.publish(op.id, archive);
    const staged = await h.service.retrieve(op.id);
    expect(staged.staged_name).toMatch(/^recued-upload-[a-f0-9]{32}\.recued\.archive$/u);
    expect(readFileSync(join(h.dir, 'exports', staged.staged_name))).toEqual(archive.bytes);
    const reads = h.s3.calls.filter(c => c.method === 'GET').length;
    expect(await h.service.retrieve(op.id)).toEqual(staged); expect(h.s3.calls.filter(c => c.method === 'GET')).toHaveLength(reads);
  });

  it('repairs a damaged owned cache only with a newly verified download', async () => {
    const h = await setup(), op = h.reserve(), archive = h.archive(); await h.service.publish(op.id, archive);
    const staged = await h.service.retrieve(op.id), path = join(h.dir, 'exports', staged.staged_name);
    writeFileSync(path, 'damaged cache'); h.s3.faults.corruptRead = true;
    await expect(h.service.retrieve(op.id)).rejects.toMatchObject({ code: 'remote_backup_unconfirmed' });
    expect(readFileSync(path, 'utf8')).toBe('damaged cache');
    h.s3.faults.corruptRead = false; expect(await h.service.retrieve(op.id)).toEqual(staged);
    expect(readFileSync(path)).toEqual(archive.bytes);
  });

  it('reconciles a saved retention intent only after checking the retained copy again', async () => {
    const h = await setup(), first = h.reserve(1); await h.service.publish(first.id, h.archive());
    h.s3.faults.denyDelete = true; const second = h.reserve(1); await h.service.publish(second.id, h.archive());
    expect(h.service.list()[0]).toMatchObject({ state: 'verified', retention_pending: true });
    const putCount = h.s3.calls.filter(c => c.method === 'PUT').length, callCount = h.s3.calls.length;
    const rebooted = createRemoteBackups(h.options); expect(h.s3.calls).toHaveLength(callCount);
    h.s3.faults.denyDelete = false; rebooted.check(second.id);
    await vi.waitFor(() => expect(rebooted.list().find(row => row.operation_id === first.id)?.state).toBe('pruned'));
    expect(rebooted.list()[0]?.retention_pending).toBeUndefined(); expect(h.s3.objects.size).toBe(1);
    expect(h.s3.calls.filter(c => c.method === 'PUT')).toHaveLength(putCount);
  });

  it('leaves no usable staged restore when the remote copy fails verification', async () => {
    const h = await setup(), op = h.reserve(); await h.service.publish(op.id, h.archive()); h.s3.faults.corruptRead = true;
    await expect(h.service.retrieve(op.id)).rejects.toMatchObject({ code: 'remote_backup_unconfirmed' });
    const { readdirSync } = await import('node:fs'); expect(readdirSync(join(h.dir, 'exports')).filter(name => name.startsWith('recued-upload-'))).toEqual([]);
    h.s3.faults.corruptRead = false; expect((await h.service.retrieve(op.id)).staged_name).toBeTruthy();
  });

  it('keeps a pre-restart reservation uncertain and refuses to reuse its identity', async () => {
    const h = await setup(), op = h.reserve(); const rebooted = createRemoteBackups(h.options);
    expect(rebooted.list()[0]).toMatchObject({ state: 'unconfirmed', issue: 'interrupted' }); expect(h.s3.calls).toHaveLength(0);
    expect(() => rebooted.reserve({ operation_id: op.id, connection_name: 'backup', destination_id: h.fingerprint, keep_last: 1 }, `arx-${randomUUID().slice(0, 12)}`)).toThrow('already in use');
    expect(h.service.status(op.job)?.state).toBe('error');
  });

  it('refuses malformed or full history instead of resetting it or recycling an id', async () => {
    const h = await setup(); const path = remoteBackupLedgerPath(h.dbPath), store = createRemoteBackupStore(h.dbPath, { maxEntries: 1 });
    const first = h.reserve(); expect(() => store.reserve({ operation_id: randomUUID(), job_id: `arx-${randomUUID().slice(0, 12)}`,
      destination: h.destination, fingerprint: h.fingerprint, keep_last: 1 })).toThrow('full');
    const before = readFileSync(path, 'utf8'); const poisoned = JSON.parse(before);
    poisoned.backups[0].object_key = 'unrelated-owner-object'; writeFileSync(path, JSON.stringify(poisoned));
    expect(() => h.service.list()).toThrow('Invalid remote backup receipt'); expect(() => h.service.check(first.id)).toThrow();
    expect(h.s3.calls).toHaveLength(0); expect(readFileSync(path, 'utf8')).toContain('unrelated-owner-object');
  });

  it('binds the displayed storage destination before reserving or sending a backup', async () => {
    const h = await setup();
    expect(() => h.service.reserve({ operation_id: randomUUID(), connection_name: 'backup', destination_id: 'a'.repeat(64), keep_last: 1 }, 'arx-abcdef123456')).toThrow('destination changed');
    expect(existsSync(remoteBackupLedgerPath(h.dbPath))).toBe(false); expect(h.s3.calls).toHaveLength(0);
  });
});

import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArchiveRemoteDestination } from '@recued/contracts';
import { createRemoteBackups } from '../archive/remote-backups.js';
import { createRemoteBackupStore, remoteBackupLedgerPath } from '../archive/remote-backup-store.js';
import { createS3RemoteBackupTransport, RemoteBackupCleanupDeniedError, RemoteBackupTransferError } from '../archive/remote-backup-s3.js';
import { archiveStagingName, newExportPath, EXPORT_TTL_MS } from '../archive/export-store.js';
import { createRemoteBackupS3Fixture, REMOTE_FIXTURE_ACCESS, REMOTE_FIXTURE_SECRET,
  REMOTE_FIXTURE_REPLACEMENT_ACCESS, REMOTE_FIXTURE_REPLACEMENT_SECRET } from './helpers/remote-backup-s3-fixture.js';

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
  it.each(['clean', 'corrupt', 'interrupted'] as const)('uses repaired S3 credentials for cleanup and verified retrieval after a %s first download', async firstDownload => {
    const h = await setup(), prior = h.reserve(1), previous = h.archive(); await h.service.publish(prior.id, previous);
    const priorKey = h.service.receipt(prior.id).object_key, op = h.reserve(1);
    const reached = h.s3.holdNextPartAcknowledgement(), publishing = h.service.publish(op.id, h.archive(9 * 1024 * 1024));
    try {
      const accepted = await reached; h.setCurrent(false); h.s3.releasePartAcknowledgement();
      await expect(publishing).rejects.toMatchObject({ code: 'remote_backup_unconfirmed' });
      h.setCurrent(true); h.s3.faults.rejectAbort = true; h.s3.faults.abortRejectionStatus = 403;
      const denied = createRemoteBackups(h.options); await denied.recheck(op.id, new AbortController().signal);
      expect(denied.receipt(op.id)).toMatchObject({ state: 'unconfirmed', multipart_cleanup_pending: true, multipart_cleanup_issue: 'permission_denied' });
      const writes = h.s3.calls.filter(call => call.method === 'PUT' || call.method === 'POST').length;
      h.s3.replaceCredentials();
      await expect(h.transport.abort(accepted.key, accepted.upload_id)).rejects.toBeInstanceOf(RemoteBackupCleanupDeniedError);
      expect(h.s3.multipartAborts).toHaveLength(1); expect(h.s3.uploads.get(accepted.upload_id)!.parts.size).toBe(1);
      const transport = createS3RemoteBackupTransport({ config: { access_key: REMOTE_FIXTURE_REPLACEMENT_ACCESS, secret_key: REMOTE_FIXTURE_REPLACEMENT_SECRET,
        bucket: h.destination.bucket, region: h.destination.region, endpoint: h.s3.endpoint }, assertCurrent: () => {} });
      const options = { ...h.options, resolve: async () => ({ destination: h.destination, fingerprint: h.fingerprint, transport }) };
      const calls = h.s3.calls.length, repaired = createRemoteBackups(options); expect(h.s3.calls).toHaveLength(calls);
      expect(repaired.receipt(op.id).multipart_cleanup_issue).toBe('permission_denied');
      h.s3.faults.rejectAbort = false; await repaired.recheck(op.id, new AbortController().signal);
      expect(repaired.receipt(op.id)).toMatchObject({ operation_id: op.id, object_key: accepted.key, state: 'unconfirmed', issue: 'verification_failed' });
      expect(repaired.receipt(op.id).multipart_cleanup_pending).toBeUndefined(); expect(repaired.receipt(op.id).multipart_cleanup_issue).toBeUndefined();
      expect(createRemoteBackupStore(h.dbPath).get(op.id)?.multipart_id).toBeUndefined(); expect(h.s3.uploads.size).toBe(0);
      expect(h.s3.multipartAborts).toEqual([
        { key: accepted.key, upload_id: accepted.upload_id, existed: true, status: 403, rejected: true },
        { key: accepted.key, upload_id: accepted.upload_id, existed: true, status: 204, replacement_credentials: true },
      ]);
      await createRemoteBackups(options).recheck(op.id, new AbortController().signal);
      expect(h.s3.multipartAborts).toHaveLength(2); expect(h.s3.calls.filter(call => call.method === 'DELETE')).toHaveLength(3);
      expect(h.s3.calls.filter(call => call.method === 'PUT' || call.method === 'POST')).toHaveLength(writes);
      expect(h.s3.objects.size).toBe(1); expect(h.s3.objects.get(priorKey)?.bytes.equals(previous.bytes)).toBe(true);
      expect(repaired.receipt(prior.id).state).toBe('verified');
      const ledger = readFileSync(remoteBackupLedgerPath(h.dbPath), 'utf8'), view = JSON.stringify(repaired.receipt(op.id));
      const stagedName = archiveStagingName(`remote-backup:${prior.id}`), stagedPath = join(h.dir, 'exports', stagedName);
      expect(existsSync(stagedPath)).toBe(false);
      const reads = h.s3.calls.filter(call => call.method === 'GET' && call.key === priorKey).length;
      const rebooted = createRemoteBackups(options);
      if (firstDownload !== 'clean') {
        h.s3.faults.corruptRead = firstDownload === 'corrupt';
        const held = firstDownload === 'interrupted' ? h.s3.holdNextReadAfterPrefix() : undefined;
        const work = expect(rebooted.retrieve(prior.id)).rejects.toMatchObject({ code: 'remote_backup_unconfirmed' });
        if (held) {
          const prefix = await held; expect(prefix.replacement_credentials).toBe(true); expect(prefix.key).toBe(priorKey);
          expect(prefix.prefix_bytes).toBeGreaterThan(0); expect(prefix.prefix_bytes).toBeLessThan(prefix.total_bytes);
          await vi.waitFor(() => {
            const partial = readdirSync(join(h.dir, 'exports')).find(name => name.startsWith(`.${stagedName}.`) && name.endsWith('.partial'));
            expect(partial).toBeDefined(); expect(statSync(join(h.dir, 'exports', partial!)).size).toBe(prefix.prefix_bytes);
          });
          h.s3.interruptHeldRead();
        }
        await work;
        expect(existsSync(stagedPath)).toBe(false);
        expect(readdirSync(join(h.dir, 'exports')).filter(name => name.startsWith(`.${stagedName}.`) && name.endsWith('.partial'))).toEqual([]);
        expect(readFileSync(remoteBackupLedgerPath(h.dbPath), 'utf8')).toBe(ledger); expect(rebooted.receipt(prior.id).state).toBe('verified');
        expect(h.s3.objects.get(priorKey)?.bytes.equals(previous.bytes)).toBe(true);
        h.s3.faults.corruptRead = false;
      }
      const retrieved = await rebooted.retrieve(prior.id), expectedReads = firstDownload === 'clean' ? 1 : 2;
      expect(retrieved.staged_name).toBe(stagedName); expect(readFileSync(stagedPath).equals(previous.bytes)).toBe(true);
      const downloaded = h.s3.calls.filter(call => call.method === 'GET' && call.key === priorKey).slice(reads);
      expect(downloaded).toHaveLength(expectedReads); expect(downloaded.every(call => call.replacement_credentials === true)).toBe(true);
      expect(readFileSync(remoteBackupLedgerPath(h.dbPath), 'utf8')).toBe(ledger);
      expect(await rebooted.retrieve(prior.id)).toEqual(retrieved);
      expect(h.s3.calls.filter(call => call.method === 'GET' && call.key === priorKey)).toHaveLength(reads + expectedReads);
      expect(h.s3.calls.filter(call => call.method === 'PUT' || call.method === 'POST')).toHaveLength(writes);
      expect(h.s3.calls.filter(call => call.method === 'DELETE')).toHaveLength(3);
      for (const secret of [REMOTE_FIXTURE_ACCESS, REMOTE_FIXTURE_SECRET, REMOTE_FIXTURE_REPLACEMENT_ACCESS, REMOTE_FIXTURE_REPLACEMENT_SECRET]) {
        expect(ledger).not.toContain(secret); expect(view).not.toContain(secret);
      }
      expect(view).not.toContain(accepted.upload_id);
    } finally { h.s3.interruptHeldRead(); h.s3.releasePartAcknowledgement(); await publishing.catch(() => {}); }
  });

  it.each([503, 403] as const)('keeps the same multipart ID after HTTP %i abort rejections, retries after reboot, and preserves its verified predecessor', async status => {
    const h = await setup(), prior = h.reserve(1), previous = h.archive(); await h.service.publish(prior.id, previous);
    const priorKey = h.service.receipt(prior.id).object_key, op = h.reserve(1);
    const reached = h.s3.holdNextPartAcknowledgement(), publishing = h.service.publish(op.id, h.archive(9 * 1024 * 1024));
    try {
      const accepted = await reached; h.setCurrent(false); h.s3.releasePartAcknowledgement();
      await expect(publishing).rejects.toMatchObject({ code: 'remote_backup_unconfirmed' });
      expect(h.service.receipt(op.id).multipart_cleanup_pending).toBe(true);
      expect(JSON.stringify(h.service.receipt(op.id)).includes(accepted.upload_id)).toBe(false);
      const partHash = createHash('sha256').update(h.s3.uploads.get(accepted.upload_id)!.parts.get(1)!).digest('hex');
      const writes = h.s3.calls.filter(call => call.method === 'PUT' || call.method === 'POST').length;
      h.setCurrent(true); h.s3.faults.rejectAbort = true; h.s3.faults.abortRejectionStatus = status;
      const first = createRemoteBackups(h.options); await first.recheck(op.id, new AbortController().signal);
      expect(first.receipt(op.id)).toMatchObject({ state: 'unconfirmed', issue: 'verification_failed' });
      expect(first.receipt(op.id).multipart_cleanup_pending).toBe(true);
      expect(first.receipt(op.id).multipart_cleanup_issue).toBe(status === 403 ? 'permission_denied' : undefined);
      expect(first.receipt(op.id)).not.toHaveProperty('multipart_id');
      expect(readFileSync(remoteBackupLedgerPath(h.dbPath), 'utf8')).not.toContain('multipart_cleanup_pending');
      expect(createRemoteBackupStore(h.dbPath).get(op.id)?.multipart_id === accepted.upload_id).toBe(true);
      const rejected = { key: accepted.key, upload_id: accepted.upload_id, existed: true, rejected: true, status };
      const rejectedAttempts = [rejected];
      expect(h.s3.multipartAborts).toEqual([rejected]);
      expect(h.s3.uploads.size).toBe(1); expect(h.s3.objects.has(accepted.key)).toBe(false);
      expect(createHash('sha256').update(h.s3.uploads.get(accepted.upload_id)!.parts.get(1)!).digest('hex')).toBe(partHash);
      const calls = h.s3.calls.length, rebooted = createRemoteBackups(h.options); expect(h.s3.calls).toHaveLength(calls);
      expect(rebooted.receipt(op.id).multipart_cleanup_pending).toBe(true);
      expect(rebooted.receipt(op.id).multipart_cleanup_issue).toBe(status === 403 ? 'permission_denied' : undefined);
      if (status === 403) {
        await rebooted.recheck(op.id, new AbortController().signal);
        expect(rebooted.receipt(op.id)).toMatchObject({ state: 'unconfirmed', issue: 'verification_failed', multipart_cleanup_pending: true });
        expect(rebooted.receipt(op.id).verified_at).toBeUndefined();
        expect(createRemoteBackupStore(h.dbPath).get(op.id)?.multipart_id === accepted.upload_id).toBe(true);
        expect(h.s3.multipartAborts).toEqual([rejected, rejected]);
        expect(h.s3.uploads.size).toBe(1); expect(h.s3.uploads.get(accepted.upload_id)!.parts.size).toBe(1);
        expect(createHash('sha256').update(h.s3.uploads.get(accepted.upload_id)!.parts.get(1)!).digest('hex')).toBe(partHash);
        expect(h.s3.objects.get(priorKey)?.bytes.equals(previous.bytes)).toBe(true);
        expect(h.s3.calls.filter(call => call.method === 'PUT' || call.method === 'POST')).toHaveLength(writes);
        expect(h.s3.calls.filter(call => call.method === 'DELETE')).toHaveLength(2);
        expect(rebooted.receipt(op.id).multipart_cleanup_issue).toBe('permission_denied'); rejectedAttempts.push(rejected);
        h.s3.faults.abortRejectionStatus = 503; await rebooted.recheck(op.id, new AbortController().signal);
        expect(rebooted.receipt(op.id)).toMatchObject({ state: 'unconfirmed', multipart_cleanup_pending: true });
        expect(rebooted.receipt(op.id).multipart_cleanup_issue).toBeUndefined();
        expect(createRemoteBackupStore(h.dbPath).get(op.id)?.multipart_cleanup_issue).toBeUndefined();
        expect(createRemoteBackupStore(h.dbPath).get(op.id)?.multipart_id === accepted.upload_id).toBe(true);
        rejectedAttempts.push({ ...rejected, status: 503 });
        expect(h.s3.multipartAborts).toEqual(rejectedAttempts);
      }
      h.s3.faults.rejectAbort = false; await rebooted.recheck(op.id, new AbortController().signal);
      expect(rebooted.receipt(op.id)).toMatchObject({ state: 'unconfirmed', issue: 'verification_failed' });
      expect(rebooted.receipt(op.id).multipart_cleanup_pending).toBeUndefined();
      expect(rebooted.receipt(op.id).multipart_cleanup_issue).toBeUndefined();
      expect(createRemoteBackupStore(h.dbPath).get(op.id)?.multipart_cleanup_issue).toBeUndefined();
      expect(readFileSync(remoteBackupLedgerPath(h.dbPath), 'utf8')).not.toContain('multipart_cleanup_pending');
      expect(createRemoteBackupStore(h.dbPath).get(op.id)?.multipart_id).toBeUndefined(); expect(h.s3.uploads.size).toBe(0);
      expect(h.s3.multipartAborts).toEqual([
        ...rejectedAttempts,
        { key: accepted.key, upload_id: accepted.upload_id, existed: true, status: 204 },
      ]);
      await createRemoteBackups(h.options).recheck(op.id, new AbortController().signal);
      expect(h.s3.multipartAborts).toHaveLength(rejectedAttempts.length + 1); expect(h.s3.objects.size).toBe(1);
      expect(h.s3.objects.get(priorKey)?.bytes.equals(previous.bytes)).toBe(true); expect(h.service.receipt(prior.id).state).toBe('verified');
      expect(h.s3.calls.filter(call => call.method === 'PUT' || call.method === 'POST')).toHaveLength(writes);
      expect(h.s3.calls.filter(call => call.method === 'DELETE')).toHaveLength(rejectedAttempts.length + 1);
    } finally { h.s3.releasePartAcknowledgement(); await publishing.catch(() => {}); }
  });

  it('classifies an abort access denial separately from a denied object read without retaining provider details', async () => {
    const privateBody = 'provider-private-response-and-upload-id';
    const transport = createS3RemoteBackupTransport({ config: { access_key: REMOTE_FIXTURE_ACCESS, secret_key: REMOTE_FIXTURE_SECRET,
      bucket: 'backup-bucket', region: 'us-east-1', endpoint: 'http://127.0.0.1:1' }, assertCurrent: () => {},
      fetchImpl: async () => new Response(privateBody, { status: 403 }) });
    const aborted = await transport.abort('owned-object', 'private-upload-id').catch(error => error as unknown);
    expect(aborted).toBeInstanceOf(RemoteBackupCleanupDeniedError); expect(String(aborted)).not.toContain(privateBody);
    const read = await transport.verify('owned-object', { bytes: 4, sha256: 'a'.repeat(64) }).catch(error => error as unknown);
    expect(read).toBeInstanceOf(RemoteBackupTransferError); expect(read).not.toBeInstanceOf(RemoteBackupCleanupDeniedError);
    expect(read).toMatchObject({ kind: 'verification_failed' }); expect(String(read)).not.toContain(privateBody);
  });

  it.each([
    { issue: 'raw provider error', multipart: true }, { issue: true, multipart: true }, { issue: 'permission_denied', multipart: false },
  ])('refuses an invalid saved cleanup reason $issue with multipart $multipart', async ({ issue, multipart }) => {
    const h = await setup(), op = h.reserve(), path = remoteBackupLedgerPath(h.dbPath), ledger = JSON.parse(readFileSync(path, 'utf8'));
    ledger.backups[0].multipart_cleanup_issue = issue;
    if (multipart) ledger.backups[0].multipart_id = 'private-upload-id';
    writeFileSync(path, JSON.stringify(ledger));
    expect(() => h.service.receipt(op.id)).toThrow('Invalid remote backup receipt'); expect(h.s3.calls).toHaveLength(0);
  });

  it('holds an accepted multipart part before any complete object exists, then releases the original upload', async () => {
    const h = await setup(), op = h.reserve(), archive = h.archive(9 * 1024 * 1024);
    const reached = h.s3.holdNextPartAcknowledgement();
    expect(() => h.s3.holdNextPartAcknowledgement()).toThrow('Only one');
    const publishing = h.service.publish(op.id, archive);
    try {
      const accepted = await reached, upload = h.s3.uploads.get(accepted.upload_id)!;
      expect(accepted.part_number).toBe(1); expect(upload.key).toBe(accepted.key); expect(upload.parts.size).toBe(1);
      const part = upload.parts.get(1)!; expect(part.length).toBe(8 * 1024 * 1024);
      expect(part.equals(archive.bytes.subarray(0, part.length))).toBe(true); expect(h.s3.objects.size).toBe(0);
      const saved = createRemoteBackupStore(h.dbPath).get(op.id)!;
      expect(saved.state).toBe('uploading'); expect(saved.multipart_id === accepted.upload_id).toBe(true);
      expect(h.service.receipt(op.id).multipart_cleanup_pending).toBeUndefined();
      expect(h.s3.calls.some(call => call.method === 'GET')).toBe(false);
      h.s3.releasePartAcknowledgement(); await publishing;
      expect(h.service.receipt(op.id).state).toBe('verified'); expect(h.s3.uploads.size).toBe(0);
      expect(h.service.receipt(op.id).multipart_cleanup_pending).toBeUndefined();
      expect(h.s3.objects.get(accepted.key)?.bytes.equals(archive.bytes)).toBe(true); expect(h.s3.multipartAborts).toHaveLength(0);
    } finally { h.s3.releasePartAcknowledgement(); await publishing.catch(() => {}); }
  });

  it('aborts the saved unfinished upload on recheck, preserves its verified predecessor, and never repeats the abort after reboot', async () => {
    const h = await setup(), prior = h.reserve(1), previous = h.archive(); await h.service.publish(prior.id, previous);
    const priorKey = h.service.receipt(prior.id).object_key, op = h.reserve(1);
    const reached = h.s3.holdNextPartAcknowledgement(), publishing = h.service.publish(op.id, h.archive(9 * 1024 * 1024));
    try {
      const accepted = await reached; h.setCurrent(false); h.s3.releasePartAcknowledgement();
      await expect(publishing).rejects.toMatchObject({ code: 'remote_backup_unconfirmed' });
      expect(h.s3.uploads.size).toBe(1); expect(h.s3.objects.size).toBe(1); expect(h.s3.multipartAborts).toHaveLength(0);
      const writes = h.s3.calls.filter(call => call.method === 'PUT' || call.method === 'POST').length;
      h.setCurrent(true); const rebooted = createRemoteBackups(h.options);
      expect((await rebooted.recheck(op.id, new AbortController().signal))?.state).toBe('unconfirmed');
      expect(rebooted.receipt(op.id).issue).toBe('verification_failed'); expect(h.s3.uploads.size).toBe(0);
      expect(createRemoteBackupStore(h.dbPath).get(op.id)?.multipart_id).toBeUndefined();
      expect(h.s3.multipartAborts).toEqual([{ key: accepted.key, upload_id: accepted.upload_id, existed: true, status: 204 }]);
      await createRemoteBackups(h.options).recheck(op.id, new AbortController().signal);
      expect(h.s3.multipartAborts).toHaveLength(1); expect(h.s3.objects.size).toBe(1);
      expect(h.s3.objects.get(priorKey)?.bytes.equals(previous.bytes)).toBe(true); expect(h.service.receipt(prior.id).state).toBe('verified');
      expect(h.s3.calls.filter(call => call.method === 'PUT' || call.method === 'POST')).toHaveLength(writes);
      expect(h.s3.calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
    } finally { h.s3.releasePartAcknowledgement(); await publishing.catch(() => {}); }
  });

  it.each([
    { label: 'PUT', bytes: 8192, multipart: false },
    { label: 'multipart completion', bytes: 9 * 1024 * 1024, multipart: true },
  ])('holds the $label reply after storing signed ciphertext and releases the original publish', async ({ bytes, multipart }) => {
    const h = await setup(), op = h.reserve(), archive = h.archive(bytes);
    const reached = h.s3.holdNextObjectAcknowledgement();
    expect(() => h.s3.holdNextObjectAcknowledgement()).toThrow('Only one');
    const publishing = h.service.publish(op.id, archive);
    try {
      const accepted = await reached;
      expect(accepted.multipart).toBe(multipart); expect(h.s3.objects.get(accepted.key)?.bytes.equals(archive.bytes)).toBe(true);
      expect(h.s3.uploads.size).toBe(0); expect(h.service.list()[0]).toMatchObject({ state: 'uploading', object_key: accepted.key });
      expect(h.s3.calls.some(call => call.method === 'GET')).toBe(false);
      const writes = h.s3.calls.filter(call => call.method === 'PUT' || call.method === 'POST').length;
      h.s3.releaseObjectAcknowledgement(); await publishing;
      expect(h.service.list()[0]?.state).toBe('verified'); expect(h.s3.objects.size).toBe(1);
      expect(h.s3.calls.filter(call => call.method === 'PUT' || call.method === 'POST')).toHaveLength(writes);
      expect(h.s3.calls.filter(call => call.method === 'GET')).toHaveLength(1);
    } finally { h.s3.releaseObjectAcknowledgement(); await publishing.catch(() => {}); }
  });

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

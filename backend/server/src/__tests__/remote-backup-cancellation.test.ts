import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportArchive } from '../archive/archive-export.js';
import { createS3RemoteBackupTransport } from '../archive/remote-backup-s3.js';
import { STOP_GRACE_MS } from '../lifecycle/settle-within.js';
import type { BlobStore } from '../storage/blob-store.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const config = { access_key: 'synthetic-access', secret_key: 'synthetic-secret', bucket: 'backup-bucket', region: 'us-east-1' };
const bytes = Buffer.from('RECA synthetic encrypted archive fixture');
const expected = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };

describe('remote drill download cancellation', () => {
  for (const phase of ['headers', 'body'] as const) it(`aborts a real stalled HTTP ${phase} read before cleanup can begin`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'drill-download-abort-')), path = join(dir, 'backup.recued.archive');
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    let entered = () => {}, closed = false;
    const requested = new Promise<void>(resolve => { entered = resolve; });
    const server = createServer((_req, res) => {
      res.on('close', () => { closed = true; });
      if (phase === 'body') { res.writeHead(200, { 'content-length': bytes.length }); res.write(bytes.subarray(0, 4)); }
      entered(); // Deliberately withhold the remaining response until abort.
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
    const transport = createS3RemoteBackupTransport({ config: { ...config, endpoint: `http://127.0.0.1:${address.port}` }, assertCurrent() {} });
    const controller = new AbortController();
    const result = transport.retrieve('exact-object', path, expected, undefined, controller.signal).then(() => null, (error: unknown) => error);
    await requested;
    if (phase === 'body') await vi.waitFor(() => expect(existsSync(path) && statSync(path).size === 4).toBe(true));
    controller.abort(); expect(await result).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(closed).toBe(true));
    // The caller may now reclaim the private directory; no reader is pending.
    rmSync(dir, { recursive: true, force: true }); expect(existsSync(dir)).toBe(false);
  });

  it('does not resolve credentials or send a pre-cancelled request', async () => {
    const fetchImpl = vi.fn<typeof fetch>(), assertCurrent = vi.fn();
    const transport = createS3RemoteBackupTransport({ config, assertCurrent, fetchImpl });
    const controller = new AbortController(); controller.abort();
    await expect(transport.retrieve('exact-object', '/unused', expected, undefined, controller.signal)).rejects.toThrow();
    expect(assertCurrent).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// A server stopping mid-backup aborts the transfer instead of waiting out the
// 30-minute request deadline: a drain step has 5 s, and the process exits
// after the drain regardless.
describe('backup upload cancellation at stop', () => {
  const listen = async (handler: Parameters<typeof createServer>[1]) => {
    const server = createServer(handler);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
    return `http://127.0.0.1:${address.port}`;
  };
  const archive = (body: Buffer) => {
    const dir = mkdtempSync(join(tmpdir(), 'backup-upload-abort-')), path = join(dir, 'backup.recued.archive');
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(path, body);
    return { path, expected: { bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') } };
  };

  it('aborts a PUT the provider never answers', async () => {
    const { path, expected: sent } = archive(bytes);
    const methods: string[] = []; let entered = () => {}, closed = false;
    const requested = new Promise<void>(resolve => { entered = resolve; });
    const endpoint = await listen((req, res) => {
      methods.push(req.method ?? ''); res.on('close', () => { closed = true; });
      req.resume(); entered(); // Never answers.
    });
    const transport = createS3RemoteBackupTransport({ config: { ...config, endpoint }, assertCurrent() {} });
    const controller = new AbortController();
    const result = transport.upload('exact-object', path, sent, () => {}, controller.signal).then(() => null, (error: unknown) => error);
    await requested;
    const started = performance.now(); controller.abort();
    expect(await result).toBeInstanceOf(Error);
    expect(performance.now() - started).toBeLessThan(STOP_GRACE_MS);
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(methods).toEqual(['PUT']);
  });

  it('aborts a multipart upload mid-part, sends no cleanup, and keeps the upload id for a later check', async () => {
    // One byte over the 5 MiB part minimum: two parts.
    const { path, expected: sent } = archive(Buffer.alloc(5 * 1024 * 1024 + 1, 0x41));
    const methods: string[] = []; let entered = () => {};
    const requested = new Promise<void>(resolve => { entered = resolve; });
    const endpoint = await listen((req, res) => {
      methods.push(req.method ?? '');
      if (req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end('<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>'); return;
      }
      if (req.method === 'PUT') { req.resume(); entered(); return; } // Part 1 is never answered.
      res.writeHead(204); res.end();
    });
    const transport = createS3RemoteBackupTransport({ config: { ...config, endpoint }, assertCurrent() {}, partBytes: 5 * 1024 * 1024 });
    const ids: (string | null)[] = [], controller = new AbortController();
    const result = transport.upload('exact-object', path, sent, id => { ids.push(id); }, controller.signal).then(() => null, (error: unknown) => error);
    await requested;
    const started = performance.now(); controller.abort();
    expect(await result).toBeInstanceOf(Error);
    expect(performance.now() - started).toBeLessThan(STOP_GRACE_MS);
    // ⛔ The cleanup DELETE would hold the stop for as long as the provider
    // takes to answer it. The recorded id is what lets a later check clean up.
    expect(methods).toEqual(['POST', 'PUT']);
    expect(ids).toEqual(['upload-1']);
  });

  it('cancels an export mid-stream and commits nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'backup-export-abort-')), dbPath = join(dir, 'realm.db');
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const db = new Database(dbPath); cleanup.push(() => { if (db.open) db.close(); });
    db.exec("CREATE TABLE example (value TEXT); INSERT INTO example VALUES ('original')");
    const controller = new AbortController(), blob = Buffer.from('blob');
    // The stop lands while the export reads its first blob: after the database
    // snapshot and its record, before the archive is complete.
    const blobs: BlobStore = {
      root: dir, encrypted: false,
      put: async () => 'unused', get: async () => blob, has: async () => true, delete: async () => {},
      sizeOf: async () => blob.length, sweepOrphans: async () => 0, totalBytes: async () => blob.length,
      getStream: async () => { controller.abort(); return Readable.from([blob]); },
    };
    const dest = join(dir, 'exports', 'backup.recued.archive');
    await expect(exportArchive({ destPath: dest, recoveryKey: Buffer.alloc(32, 0x5a), db, producerVersion: '0.2.0',
      blobs, blobHashes: ['a'.repeat(64)], signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(existsSync(dest)).toBe(false);
    // Neither the partial archive nor the database snapshot is left behind.
    expect(readdirSync(join(dir, 'exports'))).toEqual([]);
    expect(readdirSync(dir).filter(name => !name.startsWith('realm.db') && name !== 'exports')).toEqual([]);
  });
});

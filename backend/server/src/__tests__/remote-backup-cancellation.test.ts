import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createS3RemoteBackupTransport } from '../archive/remote-backup-s3.js';

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

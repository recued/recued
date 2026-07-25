/** M4 archive download — frame codec + streaming pump service.
 *
 *  Covers the `/ws/download` server half end-to-end against a fake sink:
 *    - `decodeDownloadStart` / `parseDownloadControlFrame` never throw + reject
 *      malformed frames.
 *    - the service streams a generated export file in order + acks
 *      `download_complete` with the exact size (multi-chunk, deferred-flush).
 *    - it CONFINES the name to a generated export under `exports/` (a path /
 *      traversal in `name` is basename'd to a non-generated name → refused, and
 *      never reads outside the dir).
 *    - error paths: bad_request, invalid_name, not_found, mid-stream read/send
 *      failure, and a client that closes mid-stream (abandon, no complete).
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  decodeDownloadStart,
  parseDownloadControlFrame,
} from '@recued/contracts';
import {
  createWebclientDownloadService,
  DOWNLOAD_CHUNK_BYTES,
  type DownloadSink,
} from '../download/webclient-download-service.js';
import { EXPORT_TTL_MS, exportsDir, newExportPath } from '../archive/export-store.js';

// ────────────────────────────────────────────────────────────────
// Frame codec
// ────────────────────────────────────────────────────────────────

describe('download-frame codec', () => {
  it('decodes a valid download_start', () => {
    const r = decodeDownloadStart(JSON.stringify({ type: 'download_start', req_id: 'r1', name: 'x.recued.archive' }));
    expect(r).toEqual({ ok: true, frame: { type: 'download_start', req_id: 'r1', name: 'x.recued.archive' } });
  });

  it('rejects malformed / incomplete start frames without throwing', () => {
    expect(decodeDownloadStart('not json').ok).toBe(false);
    expect(decodeDownloadStart('123').ok).toBe(false);
    expect(decodeDownloadStart('null').ok).toBe(false);
    expect(decodeDownloadStart(JSON.stringify({ type: 'wrong', req_id: 'r', name: 'n' })).ok).toBe(false);
    expect(decodeDownloadStart(JSON.stringify({ type: 'download_start', req_id: '', name: 'n' })).ok).toBe(false);
    expect(decodeDownloadStart(JSON.stringify({ type: 'download_start', req_id: 'r', name: '' })).ok).toBe(false);
    expect(decodeDownloadStart(JSON.stringify({ type: 'download_start', req_id: 'r' })).ok).toBe(false);
  });

  it('parses server control frames + ignores non-control', () => {
    expect(parseDownloadControlFrame(JSON.stringify({ type: 'download_complete', req_id: 'r', size_bytes: 42 })))
      .toEqual({ type: 'download_complete', req_id: 'r', size_bytes: 42 });
    expect(parseDownloadControlFrame(JSON.stringify({ type: 'download_error', req_id: 'r', reason: 'not_found' })))
      .toEqual({ type: 'download_error', req_id: 'r', reason: 'not_found' });
    expect(parseDownloadControlFrame(JSON.stringify({ type: 'download_error', reason: 'bad_request' })))
      .toEqual({ type: 'download_error', reason: 'bad_request' });
    expect(parseDownloadControlFrame('garbage')).toBeNull();
    expect(parseDownloadControlFrame(JSON.stringify({ type: 'download_start', req_id: 'r', name: 'n' }))).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// Streaming pump service
// ────────────────────────────────────────────────────────────────

interface FakeSink {
  binary: Buffer[];
  control: string[];
  sink: DownloadSink;
}

/** A fake DownloadSink. `deferFlush` invokes the send callback on a later tick
 *  (simulating async ws flush) so the test exercises the await-based pacing.
 *  `closeAfter`/`failAt` are 1-based chunk indices. */
const makeSink = (opts: { deferFlush?: boolean; closeAfter?: number; failAt?: number } = {}): FakeSink => {
  const binary: Buffer[] = [];
  const control: string[] = [];
  let open = true;
  let n = 0;
  const sink: DownloadSink = {
    isOpen: () => open,
    sendBinary: (chunk, cb) => {
      n += 1;
      const idx = n;
      const run = (): void => {
        if (opts.failAt === idx) { cb(new Error('send failed')); return; }
        binary.push(Buffer.from(chunk));
        if (opts.closeAfter === idx) open = false;
        cb();
      };
      if (opts.deferFlush) setImmediate(run); else run();
    },
    sendControl: (frame) => { control.push(frame); },
  };
  return { binary, control, sink };
};

const parseLastControl = (s: FakeSink) =>
  s.control.length ? parseDownloadControlFrame(s.control[s.control.length - 1]) : null;

interface Harness { dataPath: string; close(): void; }

const newHarness = (): Harness => {
  const dataPath = mkdtempSync(join(tmpdir(), 'dl-svc-'));
  mkdirSync(exportsDir(dataPath), { recursive: true });
  return { dataPath, close() { rmSync(dataPath, { recursive: true, force: true }); } };
};

let h: Harness;
afterEach(() => { h?.close(); });

const start = (name: string, req_id = 'req1'): string =>
  JSON.stringify({ type: 'download_start', req_id, name });

describe('webclient download service', () => {
  it('streams a multi-chunk export in order + acks download_complete with the size', async () => {
    h = newHarness();
    const path = newExportPath(h.dataPath, 1_700_000_000_000);
    const body = Buffer.alloc(Math.floor(DOWNLOAD_CHUNK_BYTES * 2.5));
    for (let i = 0; i < body.length; i++) body[i] = (i * 7 + 3) & 0xff;
    writeFileSync(path, body);

    const svc = createWebclientDownloadService({ dataPath: h.dataPath });
    const s = makeSink({ deferFlush: true }); // async flush → exercises pacing
    await svc.handleStart(start(basename(path)), s.sink);

    expect(s.binary.length).toBeGreaterThan(1); // genuinely multi-chunk
    expect(Buffer.concat(s.binary).equals(body)).toBe(true); // ordered + complete
    expect(parseLastControl(s)).toEqual({ type: 'download_complete', req_id: 'req1', size_bytes: body.length });
  });

  it('refuses a name that is not a generated export', async () => {
    h = newHarness();
    const svc = createWebclientDownloadService({ dataPath: h.dataPath });
    const s = makeSink();
    await svc.handleStart(start('arbitrary-file.txt'), s.sink);
    expect(s.binary).toHaveLength(0);
    expect(parseLastControl(s)).toEqual({ type: 'download_error', req_id: 'req1', reason: 'invalid_name' });
  });

  it('confines a path-traversal name to its basename (refused, never escapes exports/)', async () => {
    h = newHarness();
    // Plant a real file OUTSIDE exports/ that the traversal would target.
    writeFileSync(join(h.dataPath, 'secret.txt'), 'top secret');
    const svc = createWebclientDownloadService({ dataPath: h.dataPath });
    const s = makeSink();
    await svc.handleStart(start('../../secret.txt'), s.sink);
    expect(s.binary).toHaveLength(0); // never streamed the outside file
    expect(parseLastControl(s)).toEqual({ type: 'download_error', req_id: 'req1', reason: 'invalid_name' });
  });

  it('reports not_found for a generated name with no file on disk', async () => {
    h = newHarness();
    const name = basename(newExportPath(h.dataPath, 1_700_000_000_000));
    const svc = createWebclientDownloadService({ dataPath: h.dataPath });
    const s = makeSink();
    await svc.handleStart(start(name), s.sink);
    expect(parseLastControl(s)).toEqual({ type: 'download_error', req_id: 'req1', reason: 'not_found' });
  });

  it('refuses + reclaims an export past its TTL (the download-by boundary)', async () => {
    h = newHarness();
    const path = newExportPath(h.dataPath, 1_700_000_000_000);
    writeFileSync(path, Buffer.alloc(1024, 1));
    // Backdate the file's mtime to ~epoch and use an injected `now` just past
    // EXPORT_TTL_MS — deterministically expired, no wall-clock dependence.
    utimesSync(path, new Date(1000), new Date(1000));
    const svc = createWebclientDownloadService({
      dataPath: h.dataPath,
      now: () => EXPORT_TTL_MS + 2000,
    });
    const s = makeSink();
    await svc.handleStart(start(basename(path)), s.sink);
    expect(parseLastControl(s)).toEqual({ type: 'download_error', req_id: 'req1', reason: 'not_found' });
    expect(s.binary).toHaveLength(0); // never streamed
    expect(existsSync(path)).toBe(false); // reclaimed (matches archive.status)
  });

  it('reports bad_request for a malformed start frame', async () => {
    h = newHarness();
    const svc = createWebclientDownloadService({ dataPath: h.dataPath });
    const s = makeSink();
    await svc.handleStart('not even json', s.sink);
    expect(parseLastControl(s)).toEqual({ type: 'download_error', reason: 'bad_request' });
  });

  it('reports read_error when a send fails mid-stream', async () => {
    h = newHarness();
    const path = newExportPath(h.dataPath, 1_700_000_000_000);
    writeFileSync(path, Buffer.alloc(DOWNLOAD_CHUNK_BYTES * 2, 9));
    const svc = createWebclientDownloadService({ dataPath: h.dataPath });
    const s = makeSink({ failAt: 1 });
    await svc.handleStart(start(basename(path)), s.sink);
    expect(parseLastControl(s)).toEqual({ type: 'download_error', req_id: 'req1', reason: 'read_error' });
  });

  it('abandons quietly (no complete) when the client closes mid-stream', async () => {
    h = newHarness();
    const path = newExportPath(h.dataPath, 1_700_000_000_000);
    writeFileSync(path, Buffer.alloc(DOWNLOAD_CHUNK_BYTES * 3, 1));
    const svc = createWebclientDownloadService({ dataPath: h.dataPath });
    const s = makeSink({ closeAfter: 1 });
    await svc.handleStart(start(basename(path)), s.sink);
    expect(s.binary.length).toBe(1); // stopped after the close
    expect(s.control).toHaveLength(0); // no complete, no error
  });
});

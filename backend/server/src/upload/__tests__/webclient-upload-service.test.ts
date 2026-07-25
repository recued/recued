/** D-172 resumable uploads — webclient upload service (server-half) tests.
 *
 *  Drives the WEBCLIENT consumer end-to-end headless (the design's P1 goal):
 *  the control plane (create / probe / finalize / delete) + the binary
 *  `/ws/upload` data plane (`handleChunkFrame` over real `encodeUploadChunkFrame`
 *  frames) over a real chunk-core + a real CAS BlobStore + a real
 *  InboundFileCollection. Pins: the happy path lands a `data.file.received`
 *  record with `origin: 'webclient_upload'`; resume via probe; SCOPE ISOLATION
 *  (a wrong-scope caller can never probe/finalize/delete/chunk another scope's
 *  upload, and a wrong-scope probe doesn't leak existence); malformed-frame +
 *  checksum + offset-conflict acks; create rejections; finalize-incomplete; the
 *  TTL sweeper. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import {
  encodeUploadChunkFrame,
  type UploadChunkAck,
} from '@recued/contracts';

import { createBlobStore, type BlobStore } from '../../storage/blob-store.js';
import {
  createInboundFileCollection,
  type InboundFileCollection,
} from '../../collections/file/inbound-file-collection.js';
import {
  createWebclientUploadService,
  type WebclientUploadService,
} from '../webclient-upload-service.js';

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

const SCOPE_A = 'instance_a';
const SCOPE_B = 'instance_b';
const TTL = 60_000;

let dir: string;
let db: Database.Database;
let blobs: BlobStore;
let files: InboundFileCollection;
let service: WebclientUploadService;
let clock: number;
let idCounter: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'upload-svc-'));
  db = new Database(':memory:');
  blobs = createBlobStore(join(dir, 'cas'));
  files = createInboundFileCollection({
    db,
    blobs,
    gate: createStorageGate({
      quota: 100 * 1024 * 1024,
      reservePct: 10,
      surface: 'collection:file:received',
    }),
    bus: createWarehouseEventBus(),
    slug: 'received',
    now: () => clock,
  });
  clock = 1_000_000;
  idCounter = 0;
  service = createWebclientUploadService({
    db,
    blobs,
    uploadsRoot: join(dir, 'upload_blobs'),
    inboundFileCollection: files,
    now: () => clock,
    mintUploadId: () => `up_${++idCounter}`,
    sizeCapBytes: 1_000_000,
    ttlMs: TTL,
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Create under scope A, returning the upload_id. */
const createA = async (
  body: Buffer,
  over: { filename?: string; mime?: string; scope?: string } = {},
): Promise<string> => {
  const res = await service.create({
    scope_key: over.scope ?? SCOPE_A,
    filename: over.filename ?? 'photo.bin',
    declared_size: body.length,
    mime_reported: over.mime ?? 'application/octet-stream',
  });
  if (res.status !== 'created') throw new Error(`create rejected: ${res.reason}`);
  return res.upload_id;
};

/** Push `slice` at `offset` over the binary frame path under `scope`. */
const sendChunk = (
  upload_id: string,
  offset: number,
  slice: Buffer,
  over: { scope?: string; checksum?: string; req?: string } = {},
): Promise<UploadChunkAck> => {
  const frame = encodeUploadChunkFrame(
    {
      req_id: over.req ?? `r_${offset}`,
      upload_id,
      offset,
      ...(over.checksum !== undefined ? { checksum: over.checksum } : {}),
    },
    slice,
  );
  return service.handleChunkFrame(over.scope ?? SCOPE_A, frame);
};

describe('webclient upload service — happy path', () => {
  it('create -> chunk -> finalize lands a data.file.received record (origin webclient_upload)', async () => {
    const body = Buffer.from('hello resumable webclient upload world');
    const upload_id = await createA(body, { filename: 'note.txt', mime: 'text/plain' });

    const ack = await sendChunk(upload_id, 0, body, { checksum: sha(body) });
    expect(ack).toMatchObject({ type: 'upload_ack', ok: true, offset: body.length, complete: true });

    const fin = await service.finalize({ scope_key: SCOPE_A, upload_id });
    expect(fin.status).toBe('finalized');
    if (fin.status !== 'finalized') throw new Error('unreachable');
    expect(fin.content_hash).toBe(sha(body));
    expect(fin.size_bytes).toBe(body.length);

    const record = files.get(fin.record_id);
    expect(record).not.toBeNull();
    expect(record!.hot_fields.origin).toBe('webclient_upload');
    expect(record!.hot_fields.filename).toBe('note.txt');
    expect(record!.hot_fields.mime_type).toBe('text/plain');
    expect(record!.hot_fields.size).toBe(body.length);
    expect(record!.storage_ref).toEqual({ kind: 'cas', blob_hash: sha(body) });
    // The bytes are really in the CAS + readable back.
    const round = await files.readBytes(fin.record_id);
    expect(round.bytes.equals(body)).toBe(true);
  });

  it('multi-chunk with a resume probe in the middle', async () => {
    const body = Buffer.from('A'.repeat(500) + 'B'.repeat(500));
    const upload_id = await createA(body);

    const a1 = await sendChunk(upload_id, 0, body.subarray(0, 400));
    expect(a1).toMatchObject({ ok: true, offset: 400, complete: false });

    // Resume probe — must report the persisted offset for the SAME file identity.
    const probe = service.probe({
      scope_key: SCOPE_A,
      upload_id,
      filename: 'photo.bin',
      declared_size: body.length,
    });
    expect(probe).toEqual({ resumable: true, offset: 400, complete: false });

    const a2 = await sendChunk(upload_id, 400, body.subarray(400));
    expect(a2).toMatchObject({ ok: true, offset: body.length, complete: true });

    const fin = await service.finalize({ scope_key: SCOPE_A, upload_id });
    expect(fin.status).toBe('finalized');
    if (fin.status !== 'finalized') throw new Error('unreachable');
    expect((await files.readBytes(fin.record_id)).bytes.equals(body)).toBe(true);
  });
});

describe('webclient upload service — scope isolation', () => {
  it('a wrong-scope caller cannot chunk / probe / finalize / delete another scope upload', async () => {
    const body = Buffer.from('private bytes');
    const upload_id = await createA(body);

    // chunk from scope B → forbidden (not even the offset is leaked).
    const chunkB = await sendChunk(upload_id, 0, body, { scope: SCOPE_B });
    expect(chunkB).toEqual({ type: 'upload_ack', req_id: 'r_0', ok: false, reason: 'forbidden' });

    // probe from scope B → not_found (SAME response as a missing upload: no leak).
    expect(
      service.probe({ scope_key: SCOPE_B, upload_id, filename: 'photo.bin', declared_size: body.length }),
    ).toEqual({ resumable: false, reason: 'not_found' });

    // finalize / delete from scope B → gone / not deleted.
    expect(await service.finalize({ scope_key: SCOPE_B, upload_id })).toEqual({ status: 'gone', reason: 'not_found' });
    expect(await service.delete({ scope_key: SCOPE_B, upload_id })).toEqual({ deleted: false });

    // The session is untouched — scope A still completes.
    const okA = await sendChunk(upload_id, 0, body);
    expect(okA).toMatchObject({ ok: true, complete: true });
    expect((await service.finalize({ scope_key: SCOPE_A, upload_id })).status).toBe('finalized');
  });

  it('a wrong-scope probe of a NON-existent upload is indistinguishable from a wrong-scope probe of a real one', async () => {
    const body = Buffer.from('xyz');
    const real = await createA(body);
    const missing = service.probe({ scope_key: SCOPE_B, upload_id: 'up_does_not_exist', filename: 'photo.bin', declared_size: 3 });
    const wrongScope = service.probe({ scope_key: SCOPE_B, upload_id: real, filename: 'photo.bin', declared_size: 3 });
    expect(missing).toEqual(wrongScope);
  });
});

describe('webclient upload service — frame + chunk error acks', () => {
  it('a malformed frame acks upload_error without throwing', async () => {
    const ack = await service.handleChunkFrame(SCOPE_A, Buffer.from([1, 2, 3]));
    expect(ack.type).toBe('upload_error');
  });

  it('a checksum mismatch acks checksum_mismatch (retry in place)', async () => {
    const body = Buffer.from('checksum me');
    const upload_id = await createA(body);
    const ack = await sendChunk(upload_id, 0, body, { checksum: sha(Buffer.from('WRONG')) });
    expect(ack).toMatchObject({ type: 'upload_ack', ok: false, reason: 'checksum_mismatch' });
    // The offset did not advance — a re-send at 0 still works.
    const good = await sendChunk(upload_id, 0, body, { checksum: sha(body) });
    expect(good).toMatchObject({ ok: true, complete: true });
  });

  it('an out-of-order chunk acks offset_conflict carrying the real persisted offset', async () => {
    const body = Buffer.from('0123456789');
    const upload_id = await createA(body);
    await sendChunk(upload_id, 0, body.subarray(0, 4)); // offset -> 4
    const conflict = await sendChunk(upload_id, 9, body.subarray(9)); // wrong offset
    expect(conflict).toMatchObject({ type: 'upload_ack', ok: false, reason: 'offset_conflict', offset: 4 });
  });

  it('a chunk for an unknown upload_id acks not_found (under the caller scope)', async () => {
    const ack = await sendChunk('up_nope', 0, Buffer.from('x'));
    expect(ack).toMatchObject({ ok: false, reason: 'forbidden' }); // ownedSession miss = forbidden, no existence leak
  });
});

describe('webclient upload service — create rejections + finalize states', () => {
  it('rejects an over-cap declared_size', async () => {
    const res = await service.create({
      scope_key: SCOPE_A,
      filename: 'big.bin',
      declared_size: 2_000_000, // > sizeCapBytes 1_000_000
      mime_reported: 'application/octet-stream',
    });
    expect(res).toEqual({ status: 'rejected', reason: 'size_cap_exceeded' });
  });

  it('rejects an invalid declared_size', async () => {
    const res = await service.create({
      scope_key: SCOPE_A,
      filename: 'bad.bin',
      declared_size: -5,
      mime_reported: 'application/octet-stream',
    });
    expect(res).toEqual({ status: 'rejected', reason: 'invalid_declared_size' });
  });

  it('finalize before all bytes arrive returns pending/incomplete with the offset', async () => {
    const body = Buffer.from('half and half');
    const upload_id = await createA(body);
    await sendChunk(upload_id, 0, body.subarray(0, 4));
    const fin = await service.finalize({ scope_key: SCOPE_A, upload_id });
    expect(fin).toEqual({ status: 'pending', reason: 'incomplete', offset: 4 });
  });

  it('delete reaps the session (a subsequent probe is not_found)', async () => {
    const body = Buffer.from('to be deleted');
    const upload_id = await createA(body);
    expect(await service.delete({ scope_key: SCOPE_A, upload_id })).toEqual({ deleted: true });
    expect(
      service.probe({ scope_key: SCOPE_A, upload_id, filename: 'photo.bin', declared_size: body.length }),
    ).toEqual({ resumable: false, reason: 'not_found' });
  });

  it('a second finalize after success is gone/not_found (the row was reaped)', async () => {
    const body = Buffer.from('once');
    const upload_id = await createA(body);
    await sendChunk(upload_id, 0, body);
    expect((await service.finalize({ scope_key: SCOPE_A, upload_id })).status).toBe('finalized');
    expect(await service.finalize({ scope_key: SCOPE_A, upload_id })).toEqual({ status: 'gone', reason: 'not_found' });
  });
});

describe('webclient upload service — capacity-bounded effective cap (D-172 size-cap alignment)', () => {
  // A service whose effective per-create cap is `min(sizeCapBytes, capacity())`,
  // mirroring the compose-collection-context wiring (capacity = the finalize
  // surface's `available` = quota - reserve). The default `service` above has no
  // `availableBytes`, so the static policy cap alone applies there.
  const serviceWithCapacity = (
    capacity: () => number,
    sizeCapBytes = 1_000_000,
  ): WebclientUploadService =>
    createWebclientUploadService({
      db,
      blobs,
      uploadsRoot: join(dir, 'upload_blobs_cap'),
      inboundFileCollection: files,
      now: () => clock,
      mintUploadId: () => `cap_${++idCounter}`,
      sizeCapBytes,
      availableBytes: capacity,
      ttlMs: TTL,
    });

  const createSized = (svc: WebclientUploadService, declared_size: number) =>
    svc.create({
      scope_key: SCOPE_A,
      filename: 'sized.bin',
      declared_size,
      mime_reported: 'application/octet-stream',
    });

  it('rejects a file larger than the surface capacity even when under the policy cap', async () => {
    const svc = serviceWithCapacity(() => 400_000); // capacity < the 1 MiB policy cap
    expect((await createSized(svc, 300_000)).status).toBe('created');
    expect(await createSized(svc, 500_000)).toEqual({
      status: 'rejected',
      reason: 'size_cap_exceeded',
    });
  });

  it('still enforces the static policy cap when the surface capacity is large', async () => {
    const svc = serviceWithCapacity(() => 50 * 1024 * 1024); // 50 MiB capacity
    expect(await createSized(svc, 2_000_000)).toEqual({
      status: 'rejected',
      reason: 'size_cap_exceeded', // > the 1 MiB policy cap
    });
  });

  it('a zero-capacity surface rejects any non-empty upload', async () => {
    const svc = serviceWithCapacity(() => 0);
    expect(await createSized(svc, 1)).toEqual({
      status: 'rejected',
      reason: 'size_cap_exceeded',
    });
  });

  it('re-reads the capacity on every create (a reconfigured smaller quota tightens the cap)', async () => {
    let capacity = 400_000;
    const svc = serviceWithCapacity(() => capacity);
    expect((await createSized(svc, 300_000)).status).toBe('created');
    capacity = 200_000; // the surface quota was reconfigured smaller
    expect(await createSized(svc, 300_000)).toEqual({
      status: 'rejected',
      reason: 'size_cap_exceeded',
    });
  });

  it('the per-file ceiling is the surface CAPACITY, independent of current usage', async () => {
    // Mirrors the compose-collection-context thunk: capacity = gate.info().available.
    const gate = createStorageGate({
      quota: 100 * 1024 * 1024, // reserve = max(10 MiB, 10%) = 10 MiB → available 90 MiB
      reservePct: 10,
      surface: 'collection:file:received',
    });
    const svc = serviceWithCapacity(() => gate.info().available, 1024 * 1024 * 1024);
    // A 50 MiB file fits the 90 MiB capacity...
    expect((await createSized(svc, 50 * 1024 * 1024)).status).toBe('created');
    // ...and STILL fits after 85 MiB is already stored — the ceiling is the
    // capacity (90 MiB), NOT the live headroom (5 MiB). Total-storage pressure
    // is the gate's accounting job (the ingest path accounts, never rejects),
    // not this per-file admission check.
    gate.setUsed(85 * 1024 * 1024);
    expect((await createSized(svc, 50 * 1024 * 1024)).status).toBe('created');
    // A file larger than the surface capacity is always rejected.
    expect(await createSized(svc, 95 * 1024 * 1024)).toEqual({
      status: 'rejected',
      reason: 'size_cap_exceeded',
    });
  });
});

describe('webclient upload service — sweep', () => {
  it('sweepExpired reaps a session past its TTL', async () => {
    const body = Buffer.from('abandon me');
    const upload_id = await createA(body);
    // still live before TTL
    let swept = await service.sweepExpired({ now: clock + 1 });
    expect(swept.reaped).toBe(0);
    // past TTL → reaped
    swept = await service.sweepExpired({ now: clock + TTL + 1 });
    expect(swept.reaped).toBe(1);
    // gone afterwards
    expect(
      service.probe({ scope_key: SCOPE_A, upload_id, filename: 'photo.bin', declared_size: body.length, now: clock + TTL + 2 }),
    ).toEqual({ resumable: false, reason: 'not_found' });
  });
});

/** D-172 resumable uploads — shared chunk-core tests.
 *
 *  Drives the core through real fs + a real CAS BlobStore + a real in-memory
 *  upload-session store (no mocks for the dangerous parts). Pins the lifecycle,
 *  the crash-correctness truncate-to-offset rule, fail-closed expiry, the
 *  offset-as-truth conflicts, the disk caps, checksum, and finalize idempotency. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { createBlobStore, type BlobStore } from '../../storage/blob-store.js';
import {
  createUploadSessionStore,
  type UploadSessionStore,
} from '../../storage/upload-session-store.js';
import {
  createUploadChunkCore,
  type UploadChunkCore,
  type UploadCorePolicy,
  type UploadFinalizeInput,
  type UploadCreateInput,
  type CreateUploadChunkCoreOptions,
} from '../upload-chunk-core.js';

const sha = (s: string | Buffer): string =>
  createHash('sha256').update(s).digest('hex');

const TTL = 60_000;
let dir: string;
let db: Database.Database;
let store: UploadSessionStore;
let blobs: BlobStore;
let clock: number;
let idCounter: number;
let finalizeCalls: UploadFinalizeInput[];

interface Fin {
  blob_id: string;
}

const recordingPolicy = (): UploadCorePolicy<Fin> => ({
  async finalize(input) {
    finalizeCalls.push(input);
    return { blob_id: `blob_${input.content_hash.slice(0, 8)}` };
  },
});

const makeCore = (
  policy: UploadCorePolicy<Fin> = recordingPolicy(),
  over: Partial<CreateUploadChunkCoreOptions<Fin>> = {},
): UploadChunkCore<Fin> =>
  createUploadChunkCore<Fin>({
    store,
    blobs,
    uploadsRoot: join(dir, 'uploads'),
    policy,
    ttlMs: TTL,
    now: () => clock,
    mintUploadId: () => `up_${++idCounter}`,
    ...over,
  });

/** create + push every byte of `body` then finalize; returns the finalize result. */
const fullUpload = async (
  core: UploadChunkCore<Fin>,
  body: string,
  over: Partial<UploadCreateInput> = {},
) => {
  const created = await core.create({
    scope_kind: 'reception',
    scope_key: 'ep_1',
    filename: 'f.bin',
    declared_size: Buffer.byteLength(body),
    mime_reported: 'application/octet-stream',
    size_cap_bytes: 1_000_000,
    ...over,
  });
  if (!created.ok) throw new Error(`create failed: ${created.reason}`);
  const buf = Buffer.from(body);
  if (buf.length > 0) {
    const r = await core.chunk({ upload_id: created.upload_id, expected_offset: 0, bytes: buf });
    if (!r.ok) throw new Error(`chunk failed: ${r.reason}`);
  }
  return { upload_id: created.upload_id, fin: await core.finalize({ upload_id: created.upload_id }) };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'upload-core-'));
  db = new Database(':memory:');
  store = createUploadSessionStore(db);
  blobs = createBlobStore(join(dir, 'cas'));
  clock = 1_900_000_000_000;
  idCounter = 0;
  finalizeCalls = [];
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('full lifecycle', () => {
  it('create → chunk×2 → finalize stores the exact bytes + reaps transport state', async () => {
    const core = makeCore();
    const created = await core.create({
      scope_kind: 'reception',
      scope_key: 'ep_1',
      filename: 'f.bin',
      declared_size: 11,
      mime_reported: 'text/plain',
      size_cap_bytes: 1_000_000,
    });
    expect(created).toEqual({ ok: true, upload_id: 'up_1', offset: 0 });

    const c1 = await core.chunk({ upload_id: 'up_1', expected_offset: 0, bytes: Buffer.from('hello ') });
    expect(c1).toEqual({ ok: true, offset: 6, complete: false });
    const c2 = await core.chunk({ upload_id: 'up_1', expected_offset: 6, bytes: Buffer.from('world') });
    expect(c2).toEqual({ ok: true, offset: 11, complete: true });

    const fin = await core.finalize({ upload_id: 'up_1' });
    expect(fin.ok).toBe(true);

    // Bytes are content-addressed under the streamed sha256.
    expect(finalizeCalls).toHaveLength(1);
    expect(finalizeCalls[0]!.content_hash).toBe(sha('hello world'));
    expect(finalizeCalls[0]!.size_bytes).toBe(11);
    expect(finalizeCalls[0]!.head_bytes.toString()).toBe('hello world'.slice(0, 16));
    const stored = await blobs.get(sha('hello world'));
    expect(stored?.toString()).toBe('hello world');

    // Transport state reaped: session gone, scratch unlinked.
    expect(store.get('up_1')).toBeNull();
    expect(existsSync(join(dir, 'uploads', 'up_1'))).toBe(false);
  });

  it('handles a 0-byte declared file (finalize immediately, empty head)', async () => {
    const core = makeCore();
    const { fin } = await fullUpload(core, '');
    expect(fin.ok).toBe(true);
    expect(finalizeCalls[0]!.content_hash).toBe(sha(Buffer.alloc(0)));
    expect(finalizeCalls[0]!.head_bytes).toHaveLength(0);
    expect(finalizeCalls[0]!.size_bytes).toBe(0);
  });

  it('forwards finalize_context to the policy', async () => {
    const core = makeCore();
    const created = await core.create({
      scope_kind: 'webclient', scope_key: 'owner_1', filename: 'a', declared_size: 1,
      mime_reported: 'text/plain', size_cap_bytes: 100,
    });
    if (!created.ok) throw new Error('create');
    await core.chunk({ upload_id: created.upload_id, expected_offset: 0, bytes: Buffer.from('x') });
    await core.finalize({ upload_id: created.upload_id, finalize_context: { pii: 'sealed' } });
    expect(finalizeCalls[0]!.finalize_context).toEqual({ pii: 'sealed' });
  });

  it('streams a 3+ chunk upload, probe reports complete pre-finalize, and hashes the full bytes', async () => {
    const core = makeCore();
    const body = Buffer.from('0123456789abcdefXYZ'); // 19 bytes (> 16-byte head)
    const created = await core.create({
      scope_kind: 'reception', scope_key: 'ep_1', filename: 'multi.bin',
      declared_size: body.length, mime_reported: 'application/octet-stream', size_cap_bytes: 1000,
    });
    if (!created.ok) throw new Error('create');
    const chunks = [body.subarray(0, 5), body.subarray(5, 13), body.subarray(13)];
    let offset = 0;
    for (const ch of chunks) {
      const next = offset + ch.length;
      expect(await core.chunk({ upload_id: 'up_1', expected_offset: offset, bytes: ch }))
        .toEqual({ ok: true, offset: next, complete: next === body.length });
      offset = next;
    }
    // A finished-but-unfinalized session probes complete:true.
    expect(core.probe({ upload_id: 'up_1', filename: 'multi.bin', declared_size: body.length }))
      .toEqual({ ok: true, offset: body.length, complete: true });
    await core.finalize({ upload_id: 'up_1' });
    expect(finalizeCalls[0]!.content_hash).toBe(sha(body));
    expect(finalizeCalls[0]!.head_bytes.toString()).toBe('0123456789abcdef'); // first 16
    expect((await blobs.get(sha(body)))?.toString()).toBe(body.toString());
  });
});

describe('create — disk caps + validation', () => {
  const base = {
    scope_kind: 'reception' as const, scope_key: 'ep_1', filename: 'f', mime_reported: 'text/plain',
  };

  it('rejects declared_size over size_cap_bytes', async () => {
    const core = makeCore();
    const r = await core.create({ ...base, declared_size: 2000, size_cap_bytes: 1000 });
    expect(r).toEqual({ ok: false, reason: 'size_cap_exceeded' });
  });

  it('rejects a negative / non-integer declared_size', async () => {
    const core = makeCore();
    expect((await core.create({ ...base, declared_size: -1, size_cap_bytes: 1000 })).ok).toBe(false);
    expect((await core.create({ ...base, declared_size: 1.5, size_cap_bytes: 1000 })).ok).toBe(false);
    const neg = await core.create({ ...base, declared_size: -1, size_cap_bytes: 1000 });
    expect(neg).toEqual({ ok: false, reason: 'invalid_declared_size' });
  });

  it('enforces the concurrent-per-scope cap', async () => {
    const core = makeCore(recordingPolicy(), { maxConcurrentPerScope: 2 });
    expect((await core.create({ ...base, declared_size: 10, size_cap_bytes: 1000 })).ok).toBe(true);
    expect((await core.create({ ...base, declared_size: 10, size_cap_bytes: 1000 })).ok).toBe(true);
    const third = await core.create({ ...base, declared_size: 10, size_cap_bytes: 1000 });
    expect(third).toEqual({ ok: false, reason: 'too_many_sessions' });
    // A different scope is unaffected.
    expect((await core.create({ ...base, scope_key: 'ep_2', declared_size: 10, size_cap_bytes: 1000 })).ok).toBe(true);
  });

  it('enforces the global pending-bytes cap (sum of declared_size)', async () => {
    const core = makeCore(recordingPolicy(), { maxPendingBytes: 1000 });
    expect((await core.create({ ...base, declared_size: 700, size_cap_bytes: 1000 })).ok).toBe(true);
    const over = await core.create({ ...base, scope_key: 'ep_2', declared_size: 400, size_cap_bytes: 1000 });
    expect(over).toEqual({ ok: false, reason: 'pending_bytes_exceeded' });
    // Exactly filling the budget is allowed.
    expect((await core.create({ ...base, scope_key: 'ep_3', declared_size: 300, size_cap_bytes: 1000 })).ok).toBe(true);
  });

  it('runs the policy guardCreate after the core caps and maps reject → rejected', async () => {
    const policy: UploadCorePolicy<Fin> = {
      guardCreate: () => ({ ok: false, detail: 'rate_limited' }),
      finalize: async (i) => ({ blob_id: i.content_hash }),
    };
    const core = makeCore(policy);
    const r = await core.create({ ...base, declared_size: 10, size_cap_bytes: 1000 });
    expect(r).toEqual({ ok: false, reason: 'rejected', detail: 'rate_limited' });
    // Nothing persisted when the gate rejects.
    expect(store.sumActivePendingBytes({ now: clock })).toBe(0);
  });

  it('allows declared_size === size_cap (inclusive) through the guard, rejects cap+1 before it', async () => {
    const guardCalls: unknown[] = [];
    const policy: UploadCorePolicy<Fin> = {
      guardCreate: (input) => { guardCalls.push(input); return { ok: true }; },
      finalize: async (i) => ({ blob_id: i.content_hash }),
    };
    const core = makeCore(policy);
    const atCap = await core.create({ ...base, declared_size: 1000, size_cap_bytes: 1000, now: clock + 123 });
    expect(atCap).toEqual({ ok: true, upload_id: 'up_1', offset: 0 });
    // The guard runs on the allow path and receives the resolved create context.
    expect(guardCalls).toEqual([{ scope_kind: 'reception', scope_key: 'ep_1', declared_size: 1000, now: clock + 123 }]);
    // cap+1 is rejected by the core BEFORE the guard is consulted.
    const overCap = await core.create({ ...base, scope_key: 'ep_2', declared_size: 1001, size_cap_bytes: 1000 });
    expect(overCap).toEqual({ ok: false, reason: 'size_cap_exceeded' });
    expect(guardCalls).toHaveLength(1);
  });
});

describe('chunk — offset-as-truth + validation', () => {
  const mk = async (core: UploadChunkCore<Fin>, size = 100) => {
    const c = await core.create({
      scope_kind: 'reception', scope_key: 'ep_1', filename: 'f', declared_size: size,
      mime_reported: 'text/plain', size_cap_bytes: 1000,
    });
    if (!c.ok) throw new Error('create');
    return c.upload_id;
  };

  it('rejects a non-contiguous offset with the real persisted offset', async () => {
    const core = makeCore();
    const id = await mk(core);
    await core.chunk({ upload_id: id, expected_offset: 0, bytes: Buffer.from('abcd') });
    // stale (thinks it is at 0) and skip-ahead both conflict, offset unchanged.
    expect(await core.chunk({ upload_id: id, expected_offset: 0, bytes: Buffer.from('xx') }))
      .toEqual({ ok: false, reason: 'offset_conflict', offset: 4 });
    expect(await core.chunk({ upload_id: id, expected_offset: 50, bytes: Buffer.from('xx') }))
      .toEqual({ ok: false, reason: 'offset_conflict', offset: 4 });
    expect(store.get(id)!.offset_bytes).toBe(4);
  });

  it('rejects an overflow past declared_size', async () => {
    const core = makeCore();
    const id = await mk(core, 5);
    const r = await core.chunk({ upload_id: id, expected_offset: 0, bytes: Buffer.from('toolong!') });
    expect(r).toEqual({ ok: false, reason: 'overflow' });
    expect(store.get(id)!.offset_bytes).toBe(0);
  });

  it('rejects an empty chunk and one over chunkMaxBytes', async () => {
    const core = makeCore(recordingPolicy(), { chunkMaxBytes: 4 });
    const id = await mk(core);
    expect(await core.chunk({ upload_id: id, expected_offset: 0, bytes: Buffer.alloc(0) }))
      .toEqual({ ok: false, reason: 'empty_chunk' });
    expect(await core.chunk({ upload_id: id, expected_offset: 0, bytes: Buffer.from('12345') }))
      .toEqual({ ok: false, reason: 'chunk_too_large' });
  });

  it('verifies a per-chunk checksum and leaves the offset untouched on mismatch', async () => {
    const core = makeCore();
    const id = await mk(core);
    const bad = await core.chunk({ upload_id: id, expected_offset: 0, bytes: Buffer.from('abc'), checksum: 'deadbeef' });
    expect(bad).toEqual({ ok: false, reason: 'checksum_mismatch' });
    expect(store.get(id)!.offset_bytes).toBe(0);
    const good = await core.chunk({ upload_id: id, expected_offset: 0, bytes: Buffer.from('abc'), checksum: sha('abc') });
    expect(good).toEqual({ ok: true, offset: 3, complete: false });
  });

  it('returns not_found for an unknown session', async () => {
    const core = makeCore();
    expect(await core.chunk({ upload_id: 'ghost', expected_offset: 0, bytes: Buffer.from('x') }))
      .toEqual({ ok: false, reason: 'not_found' });
  });

  it('a conflicting chunk does NOT touch the scratch (the early offset-check guards the write)', async () => {
    // Would catch a regression that dropped the pre-write offset check: a stale
    // chunk at offset 0 (stored=3) must not truncate/overwrite the scratch.
    const core = makeCore();
    const created = await core.create({
      scope_kind: 'reception', scope_key: 'ep_1', filename: 'f', declared_size: 6,
      mime_reported: 'text/plain', size_cap_bytes: 1000,
    });
    if (!created.ok) throw new Error('create');
    await core.chunk({ upload_id: 'up_1', expected_offset: 0, bytes: Buffer.from('abc') });
    expect(await core.chunk({ upload_id: 'up_1', expected_offset: 0, bytes: Buffer.from('ZZZ') }))
      .toEqual({ ok: false, reason: 'offset_conflict', offset: 3 });
    // The scratch is untouched → the upload completes to the real bytes.
    await core.chunk({ upload_id: 'up_1', expected_offset: 3, bytes: Buffer.from('def') });
    await core.finalize({ upload_id: 'up_1' });
    expect(finalizeCalls[0]!.content_hash).toBe(sha('abcdef'));
  });
});

describe('concurrent chunks at the same offset (per-upload lock)', () => {
  it('serializes a same-offset race: exactly one wins, the scratch is never interleaved', async () => {
    const core = makeCore();
    const created = await core.create({
      scope_kind: 'reception', scope_key: 'ep_1', filename: 'f', declared_size: 3,
      mime_reported: 'application/octet-stream', size_cap_bytes: 1000,
    });
    if (!created.ok) throw new Error('create');
    // Fire two full-size chunks at offset 0 concurrently.
    const [a, b] = await Promise.all([
      core.chunk({ upload_id: 'up_1', expected_offset: 0, bytes: Buffer.from('AAA') }),
      core.chunk({ upload_id: 'up_1', expected_offset: 0, bytes: Buffer.from('BBB') }),
    ]);
    const oks = [a, b].filter((r) => r.ok);
    const conflicts = [a, b].filter((r) => !r.ok && r.reason === 'offset_conflict');
    expect(oks).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(store.get('up_1')!.offset_bytes).toBe(3);

    // Finalize: content is exactly the WINNER's 3 bytes — never a corrupt mix.
    await core.finalize({ upload_id: 'up_1' });
    const stored = await blobs.get(finalizeCalls[0]!.content_hash);
    expect(['AAA', 'BBB']).toContain(stored?.toString());
    expect(stored).toHaveLength(3);
  });

  it('serializes concurrently-fired CONTIGUOUS chunks so both commit in arrival order', async () => {
    // Without the lock the second (offset 5) would conflict on the stale offset 0.
    const core = makeCore();
    await core.create({
      scope_kind: 'reception', scope_key: 'ep_1', filename: 'f.bin', declared_size: 10,
      mime_reported: 'application/octet-stream', size_cap_bytes: 1000,
    });
    const [first, second] = await Promise.all([
      core.chunk({ upload_id: 'up_1', expected_offset: 0, bytes: Buffer.from('hello') }),
      core.chunk({ upload_id: 'up_1', expected_offset: 5, bytes: Buffer.from('world') }),
    ]);
    expect(first).toEqual({ ok: true, offset: 5, complete: false });
    expect(second).toEqual({ ok: true, offset: 10, complete: true });
    await core.finalize({ upload_id: 'up_1' });
    expect((await blobs.get(sha('helloworld')))?.toString()).toBe('helloworld');
  });

  it('serializes delete behind an in-flight chunk for the same upload', async () => {
    const core = makeCore();
    await core.create({
      scope_kind: 'reception', scope_key: 'ep_1', filename: 'f.bin', declared_size: 3,
      mime_reported: 'application/octet-stream', size_cap_bytes: 1000,
    });
    const [chunked, deleted] = await Promise.all([
      core.chunk({ upload_id: 'up_1', expected_offset: 0, bytes: Buffer.from('abc') }),
      core.delete('up_1'),
    ]);
    expect(chunked).toEqual({ ok: true, offset: 3, complete: true });
    expect(deleted).toEqual({ ok: true });
    expect(store.get('up_1')).toBeNull();
    expect(existsSync(join(dir, 'uploads', 'up_1'))).toBe(false);
  });
});

describe('crash-correctness — truncate-to-offset', () => {
  it('discards an un-acked tail (bytes written but offset not persisted) on the re-sent chunk', async () => {
    const core = makeCore();
    const created = await core.create({
      scope_kind: 'reception', scope_key: 'ep_1', filename: 'f', declared_size: 6,
      mime_reported: 'text/plain', size_cap_bytes: 1000,
    });
    if (!created.ok) throw new Error('create');
    await core.chunk({ upload_id: 'up_1', expected_offset: 0, bytes: Buffer.from('abc') });

    // Simulate a crash mid-next-chunk: bytes hit the scratch but advanceOffset
    // never ran → scratch is LONGER than the persisted offset (3).
    appendFileSync(join(dir, 'uploads', 'up_1'), 'GARBAGE');
    expect(readFileSync(join(dir, 'uploads', 'up_1')).toString()).toBe('abcGARBAGE');
    expect(store.get('up_1')!.offset_bytes).toBe(3);

    // The re-sent real chunk truncates back to 3 and overwrites the un-acked tail.
    const r = await core.chunk({ upload_id: 'up_1', expected_offset: 3, bytes: Buffer.from('def') });
    expect(r).toEqual({ ok: true, offset: 6, complete: true });
    await core.finalize({ upload_id: 'up_1' });
    expect(finalizeCalls[0]!.content_hash).toBe(sha('abcdef'));
    expect((await blobs.get(sha('abcdef')))?.toString()).toBe('abcdef');
  });

  it('re-creates a lost empty scratch at offset 0', async () => {
    const core = makeCore();
    await core.create({
      scope_kind: 'reception', scope_key: 'ep_1', filename: 'f', declared_size: 3,
      mime_reported: 'text/plain', size_cap_bytes: 1000,
    });
    rmSync(join(dir, 'uploads', 'up_1')); // lost before the first chunk
    const r = await core.chunk({ upload_id: 'up_1', expected_offset: 0, bytes: Buffer.from('abc') });
    expect(r).toEqual({ ok: true, offset: 3, complete: true });
  });

  it('returns scratch_missing when the scratch is lost mid-stream', async () => {
    const core = makeCore();
    await core.create({
      scope_kind: 'reception', scope_key: 'ep_1', filename: 'f', declared_size: 6,
      mime_reported: 'text/plain', size_cap_bytes: 1000,
    });
    await core.chunk({ upload_id: 'up_1', expected_offset: 0, bytes: Buffer.from('abc') });
    rmSync(join(dir, 'uploads', 'up_1')); // lost after offset advanced past 0
    const r = await core.chunk({ upload_id: 'up_1', expected_offset: 3, bytes: Buffer.from('def') });
    expect(r).toEqual({ ok: false, reason: 'scratch_missing' });
  });
});

describe('fail-closed expiry (the step-1 deferral, enforced at the core)', () => {
  it('probe / chunk / finalize on an expired session return expired (never resurrect)', async () => {
    const core = makeCore();
    const created = await core.create({
      scope_kind: 'reception', scope_key: 'ep_1', filename: 'f', declared_size: 6,
      mime_reported: 'text/plain', size_cap_bytes: 1000,
    });
    if (!created.ok) throw new Error('create');
    await core.chunk({ upload_id: 'up_1', expected_offset: 0, bytes: Buffer.from('abc') });
    const expiresAt = store.get('up_1')!.expires_at;

    clock = expiresAt; // now === expires_at is expired (strict >)
    expect(core.probe({ upload_id: 'up_1', filename: 'f', declared_size: 6 }))
      .toEqual({ ok: false, reason: 'expired' });
    expect(await core.chunk({ upload_id: 'up_1', expected_offset: 3, bytes: Buffer.from('def') }))
      .toEqual({ ok: false, reason: 'expired' });
    expect(await core.finalize({ upload_id: 'up_1' })).toEqual({ ok: false, reason: 'expired' });
    // Not resurrected — expiry unchanged, offset unchanged.
    expect(store.get('up_1')!.expires_at).toBe(expiresAt);
    expect(store.get('up_1')!.offset_bytes).toBe(3);
  });
});

describe('probe', () => {
  it('reports offset + complete and bumps expiry for an active client', async () => {
    const core = makeCore();
    await core.create({
      scope_kind: 'reception', scope_key: 'ep_1', filename: 'f', declared_size: 6,
      mime_reported: 'text/plain', size_cap_bytes: 1000,
    });
    await core.chunk({ upload_id: 'up_1', expected_offset: 0, bytes: Buffer.from('abc') });
    const before = store.get('up_1')!.expires_at;
    clock += 5_000;
    expect(core.probe({ upload_id: 'up_1', filename: 'f', declared_size: 6 }))
      .toEqual({ ok: true, offset: 3, complete: false });
    expect(store.get('up_1')!.expires_at).toBe(clock + TTL);
    expect(store.get('up_1')!.expires_at).toBeGreaterThan(before);
  });

  it('rejects a file-identity mismatch and an unknown id', async () => {
    const core = makeCore();
    await core.create({
      scope_kind: 'reception', scope_key: 'ep_1', filename: 'f', declared_size: 6,
      mime_reported: 'text/plain', size_cap_bytes: 1000, fingerprint: 'fp1',
    });
    expect(core.probe({ upload_id: 'up_1', filename: 'OTHER', declared_size: 6 }))
      .toEqual({ ok: false, reason: 'file_mismatch' });
    expect(core.probe({ upload_id: 'up_1', filename: 'f', declared_size: 999 }))
      .toEqual({ ok: false, reason: 'file_mismatch' });
    expect(core.probe({ upload_id: 'up_1', filename: 'f', declared_size: 6, fingerprint: 'fp2' }))
      .toEqual({ ok: false, reason: 'file_mismatch' });
    expect(core.probe({ upload_id: 'ghost', filename: 'f', declared_size: 6 }))
      .toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('finalize — incomplete + idempotency', () => {
  it('rejects finalize before the bytes are complete', async () => {
    const core = makeCore();
    await core.create({
      scope_kind: 'reception', scope_key: 'ep_1', filename: 'f', declared_size: 6,
      mime_reported: 'text/plain', size_cap_bytes: 1000,
    });
    await core.chunk({ upload_id: 'up_1', expected_offset: 0, bytes: Buffer.from('abc') });
    expect(await core.finalize({ upload_id: 'up_1' })).toEqual({ ok: false, reason: 'incomplete', offset: 3 });
  });

  it('persists the session when the policy throws, so finalize is retryable', async () => {
    let attempts = 0;
    const policy: UploadCorePolicy<Fin> = {
      async finalize(input) {
        attempts++;
        if (attempts === 1) throw new Error('warehouse down');
        return { blob_id: input.content_hash };
      },
    };
    const core = makeCore(policy);
    await core.create({
      scope_kind: 'reception', scope_key: 'ep_1', filename: 'f', declared_size: 3,
      mime_reported: 'text/plain', size_cap_bytes: 1000,
    });
    await core.chunk({ upload_id: 'up_1', expected_offset: 0, bytes: Buffer.from('abc') });

    await expect(core.finalize({ upload_id: 'up_1' })).rejects.toThrow('warehouse down');
    // Session + scratch survive for the retry.
    expect(store.get('up_1')).not.toBeNull();
    expect(existsSync(join(dir, 'uploads', 'up_1'))).toBe(true);

    const retry = await core.finalize({ upload_id: 'up_1' });
    expect(retry.ok).toBe(true);
    expect(store.get('up_1')).toBeNull();
    expect(existsSync(join(dir, 'uploads', 'up_1'))).toBe(false);
  });

  it('returns not_found when finalize is re-called after success', async () => {
    const core = makeCore();
    const { upload_id, fin } = await fullUpload(core, 'abc');
    expect(fin.ok).toBe(true);
    expect(await core.finalize({ upload_id })).toEqual({ ok: false, reason: 'not_found' });
  });

  it('reaps the row + returns not_found if a complete session lost its scratch (no uncaught ENOENT)', async () => {
    const core = makeCore();
    await core.create({
      scope_kind: 'reception', scope_key: 'ep_1', filename: 'f', declared_size: 3,
      mime_reported: 'text/plain', size_cap_bytes: 1000,
    });
    await core.chunk({ upload_id: 'up_1', expected_offset: 0, bytes: Buffer.from('abc') });
    rmSync(join(dir, 'uploads', 'up_1')); // scratch vanished after completion
    expect(await core.finalize({ upload_id: 'up_1' })).toEqual({ ok: false, reason: 'not_found' });
    expect(store.get('up_1')).toBeNull(); // dangling row reaped
  });
});

describe('delete + sweepExpired', () => {
  it('delete reaps scratch + session, second delete is not_found', async () => {
    const core = makeCore();
    await core.create({
      scope_kind: 'reception', scope_key: 'ep_1', filename: 'f', declared_size: 6,
      mime_reported: 'text/plain', size_cap_bytes: 1000,
    });
    expect(existsSync(join(dir, 'uploads', 'up_1'))).toBe(true);
    expect(await core.delete('up_1')).toEqual({ ok: true });
    expect(store.get('up_1')).toBeNull();
    expect(existsSync(join(dir, 'uploads', 'up_1'))).toBe(false);
    expect(await core.delete('up_1')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('sweepExpired reaps only sessions past expires_at and unlinks their scratch', async () => {
    const core = makeCore();
    await core.create({ scope_kind: 'reception', scope_key: 'ep_1', filename: 'a', declared_size: 6, mime_reported: 'text/plain', size_cap_bytes: 1000 });
    await core.create({ scope_kind: 'reception', scope_key: 'ep_1', filename: 'b', declared_size: 6, mime_reported: 'text/plain', size_cap_bytes: 1000 });
    clock += TTL + 1; // both expired
    await core.create({ scope_kind: 'reception', scope_key: 'ep_1', filename: 'c', declared_size: 6, mime_reported: 'text/plain', size_cap_bytes: 1000 }); // fresh

    const res = await core.sweepExpired({ now: clock });
    expect(res.reaped).toBe(2);
    expect([...res.upload_ids].sort()).toEqual(['up_1', 'up_2']);
    expect(existsSync(join(dir, 'uploads', 'up_1'))).toBe(false);
    expect(existsSync(join(dir, 'uploads', 'up_2'))).toBe(false);
    expect(store.get('up_3')).not.toBeNull();
    expect(existsSync(join(dir, 'uploads', 'up_3'))).toBe(true);
  });

  it('orphan backstop: reaps a row-less scratch file but never a live session scratch', async () => {
    const core = makeCore();
    // A live session (row + scratch) that must survive the orphan scan.
    await core.create({ scope_kind: 'reception', scope_key: 'ep_1', filename: 'live', declared_size: 6, mime_reported: 'text/plain', size_cap_bytes: 1000 });
    // A stray scratch with no session row (the finalize/delete crash residual).
    writeFileSync(join(dir, 'uploads', 'orphan_xyz'), 'leaked');

    const res = await core.sweepExpired({ now: clock });
    expect(res.orphans).toBe(1);
    expect(existsSync(join(dir, 'uploads', 'orphan_xyz'))).toBe(false);
    // The live session's scratch is untouched (its row guards it).
    expect(store.get('up_1')).not.toBeNull();
    expect(existsSync(join(dir, 'uploads', 'up_1'))).toBe(true);
  });
});

describe('construction guard', () => {
  it('throws when the BlobStore lacks putFile (streaming required)', () => {
    const noPutFile = { ...blobs, putFile: undefined } as unknown as BlobStore;
    expect(() => makeCore(recordingPolicy(), { blobs: noPutFile })).toThrow(/putFile/);
  });
});

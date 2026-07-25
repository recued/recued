/** M4b.1 — archive-upload service (server-half) tests.
 *
 *  Drives the no-SSH migrate UPLOAD → STAGE flow headless: the control plane
 *  (create / probe / finalize / delete) + the binary `/ws/archive-upload` data
 *  plane (`handleChunkFrame` over real `encodeUploadChunkFrame` frames) over a
 *  real chunk-core + the real `upload_session` store — with NO BlobStore (the
 *  point: the archive is staged to a path, never the CAS). Pins:
 *    - finalize STAGES the RAW uploaded bytes to `exports/<archiveStagingName>`
 *      (byte-identical, NOT re-encrypted into the CAS), reaps the scratch, and
 *      returns the import-resolvable `staged_name`;
 *    - the staged name is import-resolvable but invisible to the export GC /
 *      download (`isArchiveStagingName` yes, `isGeneratedExportName` no);
 *    - resume via probe; scope isolation; size cap; offset-conflict / incomplete;
 *    - CONCURRENT finalizes each keep their OWN valid staged file (the Codex
 *      single-slot-race regression guard — there is no eviction to race);
 *    - the TTL sweep reclaims staged archives past their window, leaving fresh
 *      ones + generated exports + user files untouched. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { encodeUploadChunkFrame, type UploadChunkAck } from '@recued/contracts';

import {
  createArchiveUploadService,
  type ArchiveUploadService,
} from '../archive-upload-service.js';
import {
  archiveStagingName,
  exportsDir,
  isArchiveStagingName,
  isGeneratedExportName,
  newExportPath,
} from '../export-store.js';

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

const SCOPE_A = 'instance_a';
const SCOPE_B = 'instance_b';
const TTL = 60_000;
const STAGING_TTL = 120_000;

let dir: string;
let db: Database.Database;
let service: ArchiveUploadService;
let clock: number;
let idCounter: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'arx-upload-svc-'));
  db = new Database(':memory:');
  clock = 1_000_000;
  idCounter = 0;
  service = createArchiveUploadService({
    db,
    uploadsRoot: join(dir, 'upload_blobs'),
    dataPath: dir,
    now: () => clock,
    mintUploadId: () => `up_${++idCounter}`,
    sizeCapBytes: 1_000_000,
    ttlMs: TTL,
    stagingTtlMs: STAGING_TTL,
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const create = async (
  body: Buffer,
  over: { filename?: string; scope?: string } = {},
): Promise<string> => {
  const res = await service.create({
    scope_key: over.scope ?? SCOPE_A,
    filename: over.filename ?? 'backup.recued.archive',
    declared_size: body.length,
  });
  if (res.status !== 'created') throw new Error(`create rejected: ${res.reason}`);
  return res.upload_id;
};

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

const stagedPath = (upload_id: string): string =>
  join(exportsDir(dir), archiveStagingName(upload_id));

describe('archive upload service — stage-to-path happy path', () => {
  it('create -> chunk -> finalize stages the RAW bytes under exports/ (no CAS, scratch reaped)', async () => {
    const body = Buffer.from('RECUED-ARCHIVE-ciphertext-blob-' + 'x'.repeat(500));
    const upload_id = await create(body);

    const ack = await sendChunk(upload_id, 0, body, { checksum: sha(body) });
    expect(ack).toMatchObject({ type: 'upload_ack', ok: true, offset: body.length, complete: true });

    const fin = await service.finalize({ scope_key: SCOPE_A, upload_id });
    expect(fin.status).toBe('finalized');
    if (fin.status !== 'finalized') throw new Error('unreachable');

    // The staged name is server-minted, deterministic, and import-resolvable.
    expect(fin.staged_name).toBe(archiveStagingName(upload_id));
    expect(fin.size_bytes).toBe(body.length);
    // Invisible to the export GC + /ws/download (their filter), visible to the
    // staging sweep + resolveImportPath (relative basename under exports/).
    expect(isArchiveStagingName(fin.staged_name)).toBe(true);
    expect(isGeneratedExportName(fin.staged_name)).toBe(false);

    // The staged file holds the RAW uploaded bytes — byte-identical, NOT
    // re-encrypted into a CAS blob (the whole reason for the materialize seam).
    const onDisk = readFileSync(join(exportsDir(dir), fin.staged_name));
    expect(onDisk.equals(body)).toBe(true);

    // No CAS was created (the service got no BlobStore); only exports/ exists.
    expect(existsSync(join(dir, 'cas'))).toBe(false);

    // The scratch was reaped (hardlink → core unlink; the inode survives via the
    // staging name), and the session is consumed.
    expect(existsSync(join(dir, 'upload_blobs', upload_id))).toBe(false);
    // A SECOND finalize is IDEMPOTENT: the session is gone, but the staged
    // archive (deterministic name from the unguessable upload_id) survives, so a
    // lost finalize RESPONSE is recovered WITHOUT re-uploading.
    const second = await service.finalize({ scope_key: SCOPE_A, upload_id });
    expect(second).toEqual({
      status: 'finalized',
      staged_name: archiveStagingName(upload_id),
      size_bytes: body.length,
    });
  });

  it('multi-chunk with a resume probe in the middle', async () => {
    const body = Buffer.from('A'.repeat(400) + 'B'.repeat(400));
    const upload_id = await create(body);

    const a1 = await sendChunk(upload_id, 0, body.subarray(0, 300));
    expect(a1).toMatchObject({ ok: true, offset: 300, complete: false });

    const probe = service.probe({
      scope_key: SCOPE_A,
      upload_id,
      filename: 'backup.recued.archive',
      declared_size: body.length,
    });
    expect(probe).toEqual({ resumable: true, offset: 300, complete: false });

    const a2 = await sendChunk(upload_id, 300, body.subarray(300));
    expect(a2).toMatchObject({ ok: true, offset: body.length, complete: true });

    const fin = await service.finalize({ scope_key: SCOPE_A, upload_id });
    if (fin.status !== 'finalized') throw new Error('unreachable');
    expect(readFileSync(stagedPath(upload_id)).equals(body)).toBe(true);
  });
});

describe('archive upload service — idempotent finalize recovery (lost response)', () => {
  it('re-finalize once the staged archive is swept returns gone', async () => {
    const body = Buffer.from('ciphertext-' + 'y'.repeat(200));
    const upload_id = await create(body);
    await sendChunk(upload_id, 0, body, { checksum: sha(body) });
    expect((await service.finalize({ scope_key: SCOPE_A, upload_id })).status).toBe('finalized');

    // Recovery survives only while the staged file does — simulate the staging
    // TTL sweep removing it, after which re-finalize is genuinely gone.
    rmSync(stagedPath(upload_id));
    const after = await service.finalize({ scope_key: SCOPE_A, upload_id });
    expect(after).toEqual({ status: 'gone', reason: 'not_found' });
  });

  it('finalize of an unknown upload_id is gone (no staged file to recover)', async () => {
    const res = await service.finalize({ scope_key: SCOPE_A, upload_id: 'up_never_existed' });
    expect(res).toEqual({ status: 'gone', reason: 'not_found' });
  });
});

describe('archive upload service — scope isolation', () => {
  it('a wrong-scope caller cannot chunk / probe / finalize / delete another scope upload', async () => {
    const body = Buffer.from('private archive bytes');
    const upload_id = await create(body);

    const chunkB = await sendChunk(upload_id, 0, body, { scope: SCOPE_B });
    expect(chunkB).toEqual({ type: 'upload_ack', req_id: 'r_0', ok: false, reason: 'forbidden' });

    const probeB = service.probe({
      scope_key: SCOPE_B,
      upload_id,
      filename: 'backup.recued.archive',
      declared_size: body.length,
    });
    expect(probeB).toEqual({ resumable: false, reason: 'not_found' });

    const finB = await service.finalize({ scope_key: SCOPE_B, upload_id });
    expect(finB).toEqual({ status: 'gone', reason: 'not_found' });

    const delB = await service.delete({ scope_key: SCOPE_B, upload_id });
    expect(delB).toEqual({ deleted: false });

    // Scope A still owns it — nothing was disturbed.
    await sendChunk(upload_id, 0, body, { checksum: sha(body) });
    const finA = await service.finalize({ scope_key: SCOPE_A, upload_id });
    expect(finA.status).toBe('finalized');
  });
});

describe('archive upload service — rejections + control', () => {
  it('rejects a declared_size over the per-file cap', async () => {
    const res = await service.create({
      scope_key: SCOPE_A,
      filename: 'huge.recued.archive',
      declared_size: 1_000_001,
    });
    expect(res).toEqual({ status: 'rejected', reason: 'size_cap_exceeded' });
  });

  // M5 S3 — the free-disk statfs pre-flight (before any bytes). A `freeBytesOf`
  // seam makes the real temp dir's (huge) free space deterministic.
  const svcWithFreeBytes = (freeBytesOf: (path: string) => number): ArchiveUploadService =>
    createArchiveUploadService({
      db,
      uploadsRoot: join(dir, 'upload_blobs'),
      dataPath: dir,
      now: () => clock,
      mintUploadId: () => `up_${++idCounter}`,
      sizeCapBytes: 1_000_000_000, // raise the cap so the DISK check is the one under test
      ttlMs: TTL,
      stagingTtlMs: STAGING_TTL,
      freeBytesOf,
    });

  it('M5 S3 — refuses insufficient_disk when free space cannot fit declared_size + restore headroom', async () => {
    const svc = svcWithFreeBytes(() => 1000); // 1000 bytes free
    // 500 * ARCHIVE_RESTORE_DISK_FACTOR (2.5) = 1250 > 1000 free → refuse.
    const res = await svc.create({
      scope_key: SCOPE_A,
      filename: 'big.recued.archive',
      declared_size: 500,
    });
    expect(res.status).toBe('rejected');
    if (res.status === 'rejected') {
      expect(res.reason).toBe('insufficient_disk');
      expect(res.detail).toMatch(/free to restore/);
    }
  });

  it('M5 S3 — sufficient free disk proceeds to created', async () => {
    const svc = svcWithFreeBytes(() => 1_000_000); // ample
    const res = await svc.create({
      scope_key: SCOPE_A,
      filename: 'ok.recued.archive',
      declared_size: 500,
    });
    expect(res.status).toBe('created');
  });

  it('M5 S3 — a statfs-unsupported filesystem gates OPEN (create proceeds)', async () => {
    const svc = svcWithFreeBytes(() => {
      throw new Error('ENOTSUP: statfs unsupported');
    });
    const res = await svc.create({
      scope_key: SCOPE_A,
      filename: 'nofs.recued.archive',
      declared_size: 500,
    });
    expect(res.status).toBe('created');
  });

  it('offset conflict reports the real persisted offset', async () => {
    const body = Buffer.from('z'.repeat(200));
    const upload_id = await create(body);
    await sendChunk(upload_id, 0, body.subarray(0, 100));
    const conflict = await sendChunk(upload_id, 50, body.subarray(50, 100));
    expect(conflict).toMatchObject({ ok: false, reason: 'offset_conflict', offset: 100 });
  });

  it('finalize before complete is pending/incomplete; delete reaps the session + scratch', async () => {
    const body = Buffer.from('q'.repeat(200));
    const upload_id = await create(body);
    await sendChunk(upload_id, 0, body.subarray(0, 100));

    const pending = await service.finalize({ scope_key: SCOPE_A, upload_id });
    expect(pending).toEqual({ status: 'pending', reason: 'incomplete', offset: 100 });

    expect(existsSync(join(dir, 'upload_blobs', upload_id))).toBe(true);
    const del = await service.delete({ scope_key: SCOPE_A, upload_id });
    expect(del).toEqual({ deleted: true });
    expect(existsSync(join(dir, 'upload_blobs', upload_id))).toBe(false);
    // No staging file was ever written (never finalized).
    expect(existsSync(stagedPath(upload_id))).toBe(false);
  });
});

describe('archive upload service — concurrent finalize (single-slot-race regression)', () => {
  it('two concurrent finalizes each keep their OWN valid staged file (no eviction race)', async () => {
    const bodyA = Buffer.from('archive-A-' + 'a'.repeat(300));
    const bodyB = Buffer.from('archive-B-' + 'b'.repeat(300));
    const idA = await create(bodyA);
    const idB = await create(bodyB, { scope: SCOPE_A }); // same scope, 2 sessions

    await sendChunk(idA, 0, bodyA);
    await sendChunk(idB, 0, bodyB);

    // Finalize both ~simultaneously — the prior single-slot eviction would have
    // let one clobber the other's staged file. Per-upload staging paths + no
    // eviction means both survive with valid, distinct staged_names.
    const [finA, finB] = await Promise.all([
      service.finalize({ scope_key: SCOPE_A, upload_id: idA }),
      service.finalize({ scope_key: SCOPE_A, upload_id: idB }),
    ]);
    if (finA.status !== 'finalized' || finB.status !== 'finalized') {
      throw new Error('both should finalize');
    }
    expect(finA.staged_name).not.toBe(finB.staged_name);
    expect(readFileSync(join(exportsDir(dir), finA.staged_name)).equals(bodyA)).toBe(true);
    expect(readFileSync(join(exportsDir(dir), finB.staged_name)).equals(bodyB)).toBe(true);
  });
});

describe('archive upload service — staged-archive TTL sweep', () => {
  it('prunes staged archives past the TTL, keeps fresh ones + exports + user files', async () => {
    // finalize STAMPS the staged file's mtime to the service clock (`clock`), so
    // the sweep can be driven purely off the injected clock — no real-time race.
    const body = Buffer.from('stale-archive-' + 's'.repeat(300));
    const upload_id = await create(body);
    await sendChunk(upload_id, 0, body);
    const fin = await service.finalize({ scope_key: SCOPE_A, upload_id });
    if (fin.status !== 'finalized') throw new Error('unreachable');
    expect(existsSync(stagedPath(upload_id))).toBe(true);

    // A generated export + a hand-placed user restore file, stamped OLD (mtime-
    // eligible for reaping) — so the fact they SURVIVE proves name-shape, not
    // mtime, is what protects them.
    const genExport = newExportPath(dir, clock);
    writeFileSync(genExport, Buffer.from('an export'));
    const userFile = join(exportsDir(dir), 'my-restore.recued.archive');
    writeFileSync(userFile, Buffer.from('user placed'));
    const old = new Date(clock - STAGING_TTL - 1000);
    utimesSync(genExport, old, old);
    utimesSync(userFile, old, old);

    // now just BEFORE clock+TTL → nothing reaped (the staged mtime is `clock`).
    let r = await service.sweepExpired({ now: clock + STAGING_TTL - 1 });
    expect(r.staged_reaped).toBe(0);
    expect(existsSync(stagedPath(upload_id))).toBe(true);

    // now PAST clock+TTL → only the staged archive is reaped (export + user file
    // survive despite being equally / more old — protected by name-shape).
    r = await service.sweepExpired({ now: clock + STAGING_TTL + 1 });
    expect(r.staged_reaped).toBe(1);
    expect(existsSync(stagedPath(upload_id))).toBe(false);
    expect(existsSync(genExport)).toBe(true);
    expect(existsSync(userFile)).toBe(true);
    expect(readdirSync(exportsDir(dir)).sort()).toEqual(
      ['my-restore.recued.archive', genExport.split('/').pop()!].sort(),
    );
  });

  it('staged TTL is measured from finalize, not the (possibly stale) scratch mtime', async () => {
    // A slow / paused upload, or a complete-but-not-yet-finalized session, whose
    // last chunk landed long before finalize: force the SCRATCH inode mtime far
    // into the past. A bare hardlink would INHERIT this mtime, so the next sweep
    // would reap the just-staged archive before the user imports it.
    const body = Buffer.from('delayed-finalize-' + 'd'.repeat(300));
    const upload_id = await create(body);
    await sendChunk(upload_id, 0, body);
    const scratch = join(dir, 'upload_blobs', upload_id);
    const staleScratch = new Date(clock - STAGING_TTL * 4); // ~4 TTLs old
    utimesSync(scratch, staleScratch, staleScratch);

    const fin = await service.finalize({ scope_key: SCOPE_A, upload_id });
    if (fin.status !== 'finalized') throw new Error('unreachable');

    // A sweep well within the TTL measured FROM FINALIZE keeps it — the stamp
    // restarted the staging clock at finalize, overriding the stale scratch
    // mtime. (Without the stamp this sweep would reap the fresh staged archive.)
    const r = await service.sweepExpired({ now: clock + STAGING_TTL - 1 });
    expect(r.staged_reaped).toBe(0);
    expect(existsSync(stagedPath(upload_id))).toBe(true);
  });
});

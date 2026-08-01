/** Boot reclaim + owner-only creation for the three inbound plaintext scratch
 *  trees (`upload_blobs`, `drop_blobs/_tmp`, `messenger_media_tmp`).
 *
 *  What these pin: a hard kill strands user plaintext on the volume whose whole
 *  point is ciphertext, nothing else sweeps these three trees, and while a file
 *  is alive it must not be readable by other local accounts. */

import { Readable } from 'node:stream';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DROP_BLOB_SCRATCH_SUBPATH,
  MESSENGER_MEDIA_SCRATCH_DIRNAME,
  UPLOAD_SCRATCH_DIRNAME,
  reclaimInboundScratch,
  totalInboundScratchReclaimed,
} from '../upload/inbound-scratch.js';
import { createUploadChunkCore } from '../upload/upload-chunk-core.js';
import {
  createUploadSessionStore,
  type UploadSession,
} from '../storage/upload-session-store.js';
import { writeDropBlobStream } from '../ports/reception/drop-blob-storage.js';
import { createEncryptedBlobStore } from '../storage/blob-store.js';
import { openDatabase } from '../open-database.js';

const SERVER_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const dirs: string[] = [];
const freshDir = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), label));
  dirs.push(dir);
  return dir;
};

/** Permission bits only — `statSync().mode` carries the file type too. */
const modeOf = (path: string): number => statSync(path).mode & 0o777;

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('inbound scratch — owner-only creation', () => {
  it('creates the resumable-upload scratch tree and file owner-only', async () => {
    const dataPath = freshDir('inbound-upload-mode-');
    const db = await openDatabase(join(dataPath, 'realm.db'));
    const store = createUploadSessionStore(db);
    const uploadsRoot = join(dataPath, UPLOAD_SCRATCH_DIRNAME);
    const core = createUploadChunkCore({
      store,
      blobs: createEncryptedBlobStore(join(dataPath, 'blobs'), () => Buffer.alloc(32, 7)),
      uploadsRoot,
      policy: { finalize: async () => 'done' },
    });

    const created = await core.create({
      scope_kind: 'webclient',
      scope_key: 'owner',
      filename: 'secret.pdf',
      declared_size: 5,
      mime_reported: 'application/pdf',
      size_cap_bytes: 1024,
    });
    expect(created.ok).toBe(true);
    const upload_id = (created as { upload_id: string }).upload_id;

    expect(modeOf(uploadsRoot)).toBe(0o700);
    expect(modeOf(join(uploadsRoot, upload_id))).toBe(0o600);

    // The mid-stream re-create at offset 0 goes through a second writeFile.
    rmSync(join(uploadsRoot, upload_id));
    const chunked = await core.chunk({
      upload_id,
      expected_offset: 0,
      bytes: Buffer.from('abcde'),
    });
    expect(chunked.ok).toBe(true);
    expect(modeOf(join(uploadsRoot, upload_id))).toBe(0o600);

    db.close();
  });

  it('creates the reception drop scratch tree and file owner-only', async () => {
    const dataPath = freshDir('inbound-drop-mode-');
    const dropRoot = join(dataPath, 'drop_blobs');
    const tmpDir = join(dropRoot, '_tmp');
    let observed: number | undefined;

    // The scratch is unlinked as soon as the CAS write lands, so sample its
    // mode from inside the stream rather than after the call returns.
    const source = Readable.from(
      (async function* () {
        yield Buffer.from('%PDF-1.4 visitor upload');
        // Hold EOF until createWriteStream's asynchronous open has materialised
        // the file. Sampling immediately after `yield` races that open under a
        // busy full-suite worker and observes an empty directory even though the
        // eventual file is correctly owner-only.
        for (let attempt = 0; attempt < 100 && observed === undefined; attempt++) {
          const names = readdirSync(tmpDir);
          if (names.length > 0) observed = modeOf(join(tmpDir, names[0]!));
          if (observed === undefined) {
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        }
      })(),
    );

    await writeDropBlobStream(source, {
      drop_blobs_root: dropRoot,
      blobs: createEncryptedBlobStore(join(dataPath, 'blobs'), () => Buffer.alloc(32, 9)),
      size_cap_bytes: 1024 * 1024,
    });

    expect(modeOf(tmpDir)).toBe(0o700);
    expect(observed).toBe(0o600);
  });
});

describe('inbound scratch — the sweep and the writers name the same trees', () => {
  // The sweep is silent when it points at the wrong directory: it reports zero
  // reclaimed, which is indistinguishable from a clean data dir. Each root's
  // name is duplicated at a wiring site the sweep cannot import from, so the
  // pairing is asserted against the source instead.
  const wiringSource = (relPath: string): string =>
    readFileSync(join(SERVER_SRC, relPath), 'utf8');

  it('resolves to the documented on-disk layout', () => {
    expect(UPLOAD_SCRATCH_DIRNAME).toBe('upload_blobs');
    expect(DROP_BLOB_SCRATCH_SUBPATH).toBe(join('drop_blobs', '_tmp'));
    expect(MESSENGER_MEDIA_SCRATCH_DIRNAME).toBe('messenger_media_tmp');
  });

  it('matches the directory each wiring site hands its writer', () => {
    expect(wiringSource('serve/compose-collection-context.ts')).toContain(
      `'${UPLOAD_SCRATCH_DIRNAME}'`,
    );
    expect(wiringSource('composition/bin/wire-reception-substrate.ts')).toContain(
      `'${UPLOAD_SCRATCH_DIRNAME}'`,
    );
    expect(wiringSource('composition/bin/wire-reception-substrate.ts')).toContain(
      `'drop_blobs'`,
    );
    expect(wiringSource('serve/compose-listeners.ts')).toContain(
      `'${MESSENGER_MEDIA_SCRATCH_DIRNAME}'`,
    );
  });
});

describe('inbound scratch — boot reclaim', () => {
  it('reclaims stranded single-request scratch in both transient trees', () => {
    const dataPath = freshDir('inbound-reclaim-');
    // Literal paths, not the module's own constants — a test that lays its
    // fixtures down wherever the constant points cannot notice the constant
    // moving.
    const dropTmp = join(dataPath, 'drop_blobs', '_tmp');
    const media = join(dataPath, 'messenger_media_tmp');
    mkdirSync(dropTmp, { recursive: true });
    mkdirSync(media, { recursive: true });
    writeFileSync(join(dropTmp, 'ba5eba11-dead-beef'), 'visitor pdf');
    writeFileSync(join(media, 'slack-media-abc'), 'voice note');
    writeFileSync(join(media, 'telegram-media-def'), 'photo');

    const reclaimed = reclaimInboundScratch(dataPath);

    expect(reclaimed.drop_blobs).toBe(1);
    expect(reclaimed.messenger_media).toBe(2);
    expect(totalInboundScratchReclaimed(reclaimed)).toBe(3);
    expect(readdirSync(dropTmp)).toEqual([]);
    expect(readdirSync(media)).toEqual([]);
  });

  it('leaves the CAS and the durable drop tree alone', () => {
    const dataPath = freshDir('inbound-reclaim-scope-');
    const casObject = join(dataPath, 'blobs', 'objects', 'ab');
    const dropMonth = join(dataPath, 'drop_blobs', '2026', '07');
    mkdirSync(casObject, { recursive: true });
    mkdirSync(dropMonth, { recursive: true });
    writeFileSync(join(casObject, 'cdef.bin'), 'ciphertext');
    writeFileSync(join(dropMonth, 'stored'), 'landed blob');

    reclaimInboundScratch(dataPath);

    expect(existsSync(join(casObject, 'cdef.bin'))).toBe(true);
    expect(existsSync(join(dropMonth, 'stored'))).toBe(true);
  });

  it('reports zero and never throws on a data dir with no scratch trees', () => {
    const dataPath = freshDir('inbound-reclaim-empty-');
    expect(reclaimInboundScratch(dataPath)).toEqual({
      upload_blobs: 0,
      drop_blobs: 0,
      messenger_media: 0,
    });
  });

  it('skips the resumable-upload tree entirely without a session lookup', () => {
    const dataPath = freshDir('inbound-reclaim-noskip-');
    const uploads = join(dataPath, UPLOAD_SCRATCH_DIRNAME);
    mkdirSync(uploads, { recursive: true });
    writeFileSync(join(uploads, 'deadbeef'), 'half an upload');

    // Reclaiming blind would destroy a session the client can still resume.
    expect(reclaimInboundScratch(dataPath).upload_blobs).toBe(0);
    expect(existsSync(join(uploads, 'deadbeef'))).toBe(true);
  });

  it('reclaims row-less upload scratch and keeps what a live session owns', () => {
    const dataPath = freshDir('inbound-reclaim-uploads-');
    const uploads = join(dataPath, UPLOAD_SCRATCH_DIRNAME);
    mkdirSync(uploads, { recursive: true });
    writeFileSync(join(uploads, 'live-session'), 'resumable');
    writeFileSync(join(uploads, 'orphan-a'), 'crash residue');
    writeFileSync(join(uploads, 'orphan-b'), 'crash residue');

    const reclaimed = reclaimInboundScratch(dataPath, {
      uploadSessions: {
        get: (upload_id) =>
          upload_id === 'live-session' ? ({ upload_id } as UploadSession) : null,
      },
    });

    expect(reclaimed.upload_blobs).toBe(2);
    expect(readdirSync(uploads)).toEqual(['live-session']);
  });

  it('reclaims an orphan the housekeeping sweeper would still be holding', async () => {
    // The TTL sweeper's fs-scan backstop skips anything younger than the 6h
    // session TTL, so a crash orphan sits there until a much later cycle — and
    // not at all while housekeeping is paused. The boot pass is what closes it.
    const dataPath = freshDir('inbound-reclaim-fresh-orphan-');
    const db = await openDatabase(join(dataPath, 'realm.db'));
    const store = createUploadSessionStore(db);
    const uploadsRoot = join(dataPath, UPLOAD_SCRATCH_DIRNAME);
    const core = createUploadChunkCore({
      store,
      blobs: createEncryptedBlobStore(join(dataPath, 'blobs'), () => Buffer.alloc(32, 3)),
      uploadsRoot,
      policy: { finalize: async () => 'done' },
    });

    const created = await core.create({
      scope_kind: 'webclient',
      scope_key: 'owner',
      filename: 'secret.pdf',
      declared_size: 5,
      mime_reported: 'application/pdf',
      size_cap_bytes: 1024,
    });
    const upload_id = (created as { upload_id: string }).upload_id;
    // Crash between the row delete and the scratch unlink.
    store.delete(upload_id);

    const swept = await core.sweepExpired();
    expect(swept.orphans).toBe(0);
    expect(existsSync(join(uploadsRoot, upload_id))).toBe(true);

    expect(reclaimInboundScratch(dataPath, { uploadSessions: store }).upload_blobs).toBe(1);
    expect(existsSync(join(uploadsRoot, upload_id))).toBe(false);

    db.close();
  });
});

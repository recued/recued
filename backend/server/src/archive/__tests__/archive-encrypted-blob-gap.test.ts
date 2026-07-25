/* D-198 follow-on / archive blob-encryption — REGRESSION ANCHOR (now FIXED).
 *
 * Originally documented the CONFIRMED break: the archive blob path was a keyless
 * passthrough (export streamed on-disk ciphertext; restore asserted
 * written===hash), so an ENCRYPTED blob did NOT round-trip. The fix lands in
 * three phases (internal design notes): Phase 2 makes the export
 * carry PLAINTEXT (decrypt-on-export), Phase 3 makes restore RE-ENCRYPT each
 * blob into its posture-routed target store under the RESTORED realm's key —
 * `putFile` content-addresses over the plaintext, so written===hash holds again
 * and the blob decrypts back to the original.
 *
 * This test now asserts that FIXED behavior at the restore-overlay seam (the
 * full export→restore round-trip lives in archive-blob-encryption-phase3-restore
 * .test.ts). */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { createBlobStore } from '../../storage/blob-store.js';
import { overlaySingleBlobFile } from '../archive-restore.js';

const dirs: string[] = [];
const mkdir = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const pathFor = (root: string, hash: string): string =>
  join(root, 'objects', hash.slice(0, 2), `${hash.slice(2)}.bin`);

describe('archive encrypted-blob round-trip (Phase 2 plaintext + Phase 3 re-encrypt)', () => {
  it('an encrypted blob NOW round-trips — plaintext in the archive, re-encrypted on restore', async () => {
    // What Phase 2's decrypt-on-export puts in the archive: the PLAINTEXT (the
    // importer delivers it to a restore temp; here we stand that temp in).
    const plaintext = randomBytes(100_000); // > 64 KB → CAS
    const hash = sha(plaintext); // the archive's blob name = sha256(plaintext)
    const tmp = join(mkdir('plaintext-'), 'blob.bin');
    writeFileSync(tmp, plaintext);

    // Phase 3 restore overlays it into the ENCRYPTED target (e.g. cache_blobs)
    // under the RESTORED realm's key. putFile re-hashes over the plaintext, so
    // written === hash holds — no ARCHIVE_RESTORE_BLOB_HASH_MISMATCH.
    const destRoot = mkdir('restore-dest-');
    const restoredKey = randomBytes(32);
    const encTarget = createBlobStore(destRoot, { getEncryptionKey: () => restoredKey });
    await expect(overlaySingleBlobFile(encTarget, hash, tmp)).resolves.toBeUndefined();

    // The restored blob decrypts (under the restored key) back to the original…
    expect((await encTarget.get(hash))!.equals(plaintext)).toBe(true);
    // …and is genuinely CIPHERTEXT at rest (re-encrypted, not passed through).
    expect(readFileSync(pathFor(destRoot, hash)).equals(plaintext)).toBe(false);
  });

  it('sanity: a PLAINTEXT (keyless) blob still round-trips into a keyless target', async () => {
    const plaintext = randomBytes(100_000);
    const hash = sha(plaintext);
    const tmp = join(mkdir('plain-src-'), 'blob.bin');
    writeFileSync(tmp, plaintext);

    const destRoot = mkdir('plain-dest-');
    const keyless = createBlobStore(destRoot);
    await expect(overlaySingleBlobFile(keyless, hash, tmp)).resolves.toBeUndefined();
    // Keyless: on-disk == plaintext == hash.
    expect(sha(readFileSync(pathFor(destRoot, hash)))).toBe(hash);
  });
});

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeypair, sign } from '@recued/release';
import {
  discardStaged,
  preserveAndSwap,
  restoreSnapshot,
  rollbackSwap,
  verifyArtifactFile,
  writeStagedSig,
  SIG_SIDECAR_SUFFIX,
} from '../update/binary-apply-executor.js';

const dir = (): string => mkdtempSync(join(tmpdir(), 'recued-apply-'));
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

describe('verifyArtifactFile (fail-closed, I-2)', () => {
  const setup = () => {
    const d = dir();
    const file = join(d, 'recued-new');
    const bytes = Buffer.from('a fake binary payload');
    writeFileSync(file, bytes);
    const kp = generateKeypair();
    const sig = sign({ content: bytes, secretSeed: kp.secretSeed, keyId: kp.keyId, trustedComment: 'recued 1.4.2 linux-x64' });
    return { file, bytes, kp, sig };
  };

  it('passes with a correct sha256 + valid signature', () => {
    const { file, bytes, kp, sig } = setup();
    expect(verifyArtifactFile({ filePath: file, sha256: sha256(bytes), sig, trustedPubkey: kp.publicKeyText }))
      .toEqual({ ok: true });
  });

  it('fails on a sha256 mismatch (before touching the signature)', () => {
    const { file, kp, sig } = setup();
    const r = verifyArtifactFile({ filePath: file, sha256: 'deadbeef', sig, trustedPubkey: kp.publicKeyText });
    expect(r).toMatchObject({ ok: false, reason: 'sha256 mismatch' });
  });

  it('fails on a wrong-key signature', () => {
    const { file, bytes, sig } = setup();
    const other = generateKeypair();
    const r = verifyArtifactFile({ filePath: file, sha256: sha256(bytes), sig, trustedPubkey: other.publicKeyText });
    expect(r.ok).toBe(false);
  });

  it('fails closed with no trusted key', () => {
    const { file, bytes, sig } = setup();
    expect(verifyArtifactFile({ filePath: file, sha256: sha256(bytes), sig, trustedPubkey: '' }))
      .toMatchObject({ ok: false, reason: 'no trusted release key' });
  });

  it('fails when the artifact is missing', () => {
    const { kp, sig } = setup();
    expect(verifyArtifactFile({ filePath: join(dir(), 'nope'), sha256: 'x', sig, trustedPubkey: kp.publicKeyText }))
      .toMatchObject({ ok: false, reason: 'artifact missing' });
  });
});

describe('preserveAndSwap / rollbackSwap', () => {
  it('preserves current as recued.old then swaps the staged in, and rolls back', () => {
    const d = dir();
    const binary = join(d, 'recued');
    const old = join(d, 'recued.old');
    const staged = join(d, 'recued.new');
    writeFileSync(binary, 'v1');
    writeFileSync(staged, 'v2');

    preserveAndSwap(staged, binary, old);
    expect(readFileSync(binary, 'utf8')).toBe('v2');
    expect(readFileSync(old, 'utf8')).toBe('v1');
    expect(existsSync(staged)).toBe(false);

    rollbackSwap(old, binary);
    expect(readFileSync(binary, 'utf8')).toBe('v1');
    expect(existsSync(old)).toBe(false);
  });

  it('overwrites a stale recued.old on a second apply', () => {
    const d = dir();
    const binary = join(d, 'recued');
    const old = join(d, 'recued.old');
    writeFileSync(old, 'ancient');
    writeFileSync(binary, 'v1');
    const staged = join(d, 'recued.new');
    writeFileSync(staged, 'v2');
    preserveAndSwap(staged, binary, old);
    expect(readFileSync(old, 'utf8')).toBe('v1');
  });

  it('carries the signature sidecar through swap + rollback (thin launcher re-verify)', () => {
    const d = dir();
    const binary = join(d, 'recued');
    const old = join(d, 'recued.old');
    const staged = join(d, 'recued.new');
    writeFileSync(binary, 'v1');
    writeFileSync(`${binary}${SIG_SIDECAR_SUFFIX}`, 'sig-v1');
    writeFileSync(staged, 'v2');
    writeStagedSig(staged, 'sig-v2');

    preserveAndSwap(staged, binary, old);
    expect(readFileSync(`${binary}${SIG_SIDECAR_SUFFIX}`, 'utf8')).toBe('sig-v2'); // new sig live
    expect(readFileSync(`${old}${SIG_SIDECAR_SUFFIX}`, 'utf8')).toBe('sig-v1');    // old sig preserved
    expect(existsSync(`${staged}${SIG_SIDECAR_SUFFIX}`)).toBe(false);

    rollbackSwap(old, binary);
    expect(readFileSync(`${binary}${SIG_SIDECAR_SUFFIX}`, 'utf8')).toBe('sig-v1'); // old sig restored
    expect(existsSync(`${old}${SIG_SIDECAR_SUFFIX}`)).toBe(false);
  });

  it('swap without sidecars still works (binary channel — no sig persisted)', () => {
    const d = dir();
    const binary = join(d, 'recued');
    const old = join(d, 'recued.old');
    const staged = join(d, 'recued.new');
    writeFileSync(binary, 'v1');
    writeFileSync(staged, 'v2');
    preserveAndSwap(staged, binary, old); // no sidecars present → no-op sidecar moves
    expect(readFileSync(binary, 'utf8')).toBe('v2');
    expect(existsSync(`${binary}${SIG_SIDECAR_SUFFIX}`)).toBe(false);
  });

  it('rollbackSwap throws with no recued.old', () => {
    const d = dir();
    expect(() => rollbackSwap(join(d, 'recued.old'), join(d, 'recued'))).toThrow(/no recued.old/);
  });

  it('recovers the current binary if the staged move fails (never left empty)', () => {
    const d = dir();
    const binary = join(d, 'recued');
    const old = join(d, 'recued.old');
    writeFileSync(binary, 'v1');
    // a staged path that does not exist → the second rename throws
    expect(() => preserveAndSwap(join(d, 'missing-staged'), binary, old)).toThrow();
    // current binary must be restored, not lost
    expect(existsSync(binary)).toBe(true);
    expect(readFileSync(binary, 'utf8')).toBe('v1');
  });
});

describe('restoreSnapshot / discardStaged', () => {
  it('restores the snapshot over the live db and clears stale WAL/SHM sidecars', () => {
    const d = dir();
    const snap = join(d, 'pre.db');
    const live = join(d, 'live.db');
    writeFileSync(snap, 'snapshot-bytes');
    writeFileSync(live, 'mutated-bytes');
    // Stale post-migration WAL sidecars beside the live db — a plain copy-over
    // would leave these for SQLite to replay onto the restored (old-schema) file.
    writeFileSync(`${live}-wal`, 'migrated-wal-frames');
    writeFileSync(`${live}-shm`, 'shm-index');
    restoreSnapshot(snap, live, (from, to) => copyFileSync(from, to));
    expect(readFileSync(live, 'utf8')).toBe('snapshot-bytes'); // pre-migration bytes restored
    expect(existsSync(`${live}-wal`)).toBe(false); // stale WAL dropped
    expect(existsSync(`${live}-shm`)).toBe(false); // stale SHM dropped
    expect(existsSync(`${live}.restoring`)).toBe(false); // staging temp renamed away
  });

  it('restoreSnapshot throws when the snapshot is gone', () => {
    const d = dir();
    expect(() => restoreSnapshot(join(d, 'nope.db'), join(d, 'live.db'), () => {})).toThrow(/snapshot missing/);
  });

  it('restoreSnapshot fails CLOSED (throws, no swap) when a WAL sidecar cannot be removed', () => {
    const d = dir();
    const snap = join(d, 'pre.db');
    const live = join(d, 'live.db');
    writeFileSync(snap, 'snapshot-bytes');
    writeFileSync(live, 'mutated-bytes');
    // A directory where the -wal file would be → rmSync(file) fails with a
    // non-ENOENT error; the restore must NOT then swap the snapshot over the live
    // db (that would strand a real WAL beside an old-schema main file).
    mkdirSync(`${live}-wal`);
    expect(() => restoreSnapshot(snap, live, (from, to) => copyFileSync(from, to))).toThrow();
    expect(readFileSync(live, 'utf8')).toBe('mutated-bytes'); // live db untouched — fail closed
  });

  it('discardStaged removes a temp file and tolerates absence', () => {
    const d = dir();
    const staged = join(d, 'recued.new');
    writeFileSync(staged, 'x');
    discardStaged(staged);
    expect(existsSync(staged)).toBe(false);
    expect(() => discardStaged(join(d, 'gone'))).not.toThrow();
  });
});

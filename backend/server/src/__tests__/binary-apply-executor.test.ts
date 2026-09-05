import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeypair, sign } from '@recued/release';
import Database from 'better-sqlite3';
import {
  completeSnapshotReceiptEpochAfterKeyedOpen,
  defaultDownload,
  discardStaged,
  preserveAndSwap,
  restoreSnapshot,
  rollbackSwap,
  verifyArtifactFile,
  writeStagedSig,
  SIG_SIDECAR_SUFFIX,
  UpdateArtifactTooLargeError,
  reconcileInterruptedPairSwap,
  reconcileSnapshotReceiptEpochBeforeOpen,
  restoreWebclientBundle,
  snapshotReceiptEpochMarkerPath,
  dropApplyAside,
} from '../update/binary-apply-executor.js';
import { WEBCLIENT_ABSENT_MARKER } from '../update/webclient-sync.js';

const dir = (): string => mkdtempSync(join(tmpdir(), 'recued-apply-'));
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

describe('defaultDownload transport boundaries', () => {
  it('refuses a cross-origin redirect before downloading from the new origin', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, {
      status: 307,
      headers: { location: 'https://collector.invalid/artifact' },
    }));
    const staged = join(dir(), 'recued.staged');

    await expect(defaultDownload(
      'https://releases.recued.com/recued',
      staged,
      { fetchImpl },
    )).rejects.toThrow(/redirect refused/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
    expect(existsSync(staged)).toBe(false);
  });

  it('stops a lengthless response once it crosses the artifact byte ceiling', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(3));
      },
      cancel() {
        cancelled = true;
      },
    });
    const staged = join(dir(), 'recued.staged');

    await expect(defaultDownload(
      'https://releases.recued.com/recued',
      staged,
      { fetchImpl: async () => new Response(body), maxBytes: 4 },
    )).rejects.toBeInstanceOf(UpdateArtifactTooLargeError);
    await vi.waitFor(() => expect(cancelled).toBe(true));
    discardStaged(staged);
  });

  it('keeps the deadline active while the artifact body stalls', async () => {
    vi.useFakeTimers();
    try {
      let observedSignal: AbortSignal | undefined;
      const staged = join(dir(), 'recued.staged');
      const pending = defaultDownload(
        'https://releases.recued.com/recued',
        staged,
        {
          timeoutMs: 20,
          fetchImpl: async (_input, init) => {
            observedSignal = init?.signal ?? undefined;
            const body = new ReadableStream<Uint8Array>({
              start(controller) {
                const abort = (): void => {
                  const error = new Error('aborted');
                  error.name = 'AbortError';
                  controller.error(error);
                };
                if (observedSignal?.aborted) abort();
                else observedSignal?.addEventListener('abort', abort, { once: true });
              },
            });
            return new Response(body);
          },
        },
      );
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });

      await vi.advanceTimersByTimeAsync(20);
      await rejected;
      expect(observedSignal?.aborted).toBe(true);
      discardStaged(staged);
    } finally {
      vi.useRealTimers();
    }
  });
});

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
  // ── D-178 S1 rev 2 item 4 — the exe and its native addon move TOGETHER ──
  // A new binary against the old `.node` is an N-API ABI mismatch that fails at
  // the first database open — past the swap, where the only net left is the
  // boot-failure counter, and that net only works if the revert restores BOTH.
  const withSidecar = () => {
    const d = dir();
    const binary = join(d, 'recued');
    const old = join(d, 'recued.old');
    const staged = join(d, 'recued.staged');
    mkdirSync(join(d, 'lib'), { recursive: true });
    const sidecar = {
      stagedPath: join(d, 'addon.staged'),
      livePath: join(d, 'lib', 'better_sqlite3.node'),
      oldPath: join(d, 'lib', 'better_sqlite3.node.old'),
    };
    writeFileSync(binary, 'OLD-EXE');
    writeFileSync(sidecar.livePath, 'OLD-ADDON');
    writeFileSync(staged, 'NEW-EXE');
    writeFileSync(sidecar.stagedPath, 'NEW-ADDON');
    return { d, binary, old, staged, sidecar };
  };

  it('⛔ barriers the staged bytes, preserved generation, executable promotion, and addon promotion in order', () => {
    const t = withSidecar();
    writeFileSync(`${t.staged}${SIG_SIDECAR_SUFFIX}`, 'NEW-EXE-SIG');
    writeFileSync(`${t.sidecar.stagedPath}${SIG_SIDECAR_SUFFIX}`, 'NEW-ADDON-SIG');
    const syncedFiles: string[] = [];
    const barriers: Array<{
      dir: string;
      liveExe: string | null;
      oldExe: string | null;
      stagedExe: string | null;
      liveAddon: string | null;
      oldAddon: string | null;
    }> = [];
    const read = (path: string): string | null =>
      existsSync(path) ? readFileSync(path, 'utf8') : null;

    preserveAndSwap(t.staged, t.binary, t.old, t.sidecar, {
      fsyncFile: (path) => { syncedFiles.push(path); },
      fsyncDir: (path) => {
        barriers.push({
          dir: path,
          liveExe: read(t.binary),
          oldExe: read(t.old),
          stagedExe: read(t.staged),
          liveAddon: read(t.sidecar.livePath),
          oldAddon: read(t.sidecar.oldPath),
        });
      },
    });

    expect(syncedFiles).toEqual(expect.arrayContaining([
      t.staged,
      `${t.staged}${SIG_SIDECAR_SUFFIX}`,
      t.sidecar.stagedPath,
      `${t.sidecar.stagedPath}${SIG_SIDECAR_SUFFIX}`,
    ]));
    expect(barriers).toEqual(expect.arrayContaining([
      expect.objectContaining({ liveExe: null, oldExe: 'OLD-EXE', liveAddon: null, oldAddon: 'OLD-ADDON' }),
      expect.objectContaining({ liveExe: 'NEW-EXE', oldExe: 'OLD-EXE', liveAddon: null }),
      expect.objectContaining({ liveExe: 'NEW-EXE', oldExe: 'OLD-EXE', liveAddon: 'NEW-ADDON', oldAddon: 'OLD-ADDON' }),
    ]));
  });

  it('⛔ a FAILED rollback leaves a CONSISTENT pair, never a mixed one', () => {
    // The finding: `rollbackSwap` restored the exe and then the addon with
    // nothing between them, so a failure at the addon left the OLD exe paired
    // with the NEW addon — the exact ABI mismatch the rollback exists to escape,
    // produced by the rollback itself. It could not be fixed by reordering:
    // both renames OVERWRITE, so after either one the replaced file is gone.
    //
    // Injection: the addon's directory is made unwritable, so the transaction
    // fails while moving the current pair aside. Whatever the failure, the two
    // files on disk must come from the SAME generation.
    //
    // ⚠ Skipped as root, where mode bits are not enforced — and skipped LOUDLY
    // rather than silently passing, because "no failure injected" and "the
    // failure was handled" look identical from a green test.
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      expect.soft(true, 'running as root: mode-bit injection is a no-op here').toBe(true);
      return;
    }
    const t = withSidecar();
    // Stage a completed apply: NEW pair live, OLD pair preserved beside it.
    preserveAndSwap(t.staged, t.binary, t.old, t.sidecar);
    expect(readFileSync(t.binary, 'utf8')).toBe('NEW-EXE');
    expect(readFileSync(t.sidecar.livePath, 'utf8')).toBe('NEW-ADDON');

    const libDir = join(t.d, 'lib');
    chmodSync(libDir, 0o500);
    try {
      expect(() => rollbackSwap(t.old, t.binary, t.sidecar)).toThrow();
      // Unwound to the PRE-ROLLBACK state: both halves new, and paired.
      expect(readFileSync(t.binary, 'utf8'), 'the exe must be unwound').toBe('NEW-EXE');
      expect(readFileSync(t.sidecar.livePath, 'utf8'), 'the addon is untouched').toBe('NEW-ADDON');
      // And the rollback target must survive for a retry.
      expect(readFileSync(t.old, 'utf8')).toBe('OLD-EXE');
    } finally {
      chmodSync(libDir, 0o700);
    }
  });

  it('a failed rollback unwinds BOTH detached signatures with their files', () => {
    const t = withSidecar();
    writeFileSync(`${t.binary}.minisig`, 'OLD-EXE-SIG');
    writeFileSync(`${t.sidecar.livePath}.minisig`, 'OLD-ADDON-SIG');
    writeFileSync(`${t.staged}.minisig`, 'NEW-EXE-SIG');
    writeFileSync(`${t.sidecar.stagedPath}.minisig`, 'NEW-ADDON-SIG');
    preserveAndSwap(t.staged, t.binary, t.old, t.sidecar);

    // A non-empty directory survives the stale-aside best-effort unlink and
    // makes the addon displacement fail after the executable pair was parked.
    const blocker = `${t.sidecar.livePath}.rollback-aside`;
    mkdirSync(blocker, { recursive: true });
    writeFileSync(join(blocker, 'blocker'), 'x');
    expect(() => rollbackSwap(t.old, t.binary, t.sidecar)).toThrow();

    expect(readFileSync(t.binary, 'utf8')).toBe('NEW-EXE');
    expect(readFileSync(`${t.binary}.minisig`, 'utf8')).toBe('NEW-EXE-SIG');
    expect(readFileSync(t.sidecar.livePath, 'utf8')).toBe('NEW-ADDON');
    expect(readFileSync(`${t.sidecar.livePath}.minisig`, 'utf8')).toBe('NEW-ADDON-SIG');
    expect(readFileSync(t.old, 'utf8')).toBe('OLD-EXE');
    expect(readFileSync(`${t.old}.minisig`, 'utf8')).toBe('OLD-EXE-SIG');
    expect(readFileSync(t.sidecar.oldPath, 'utf8')).toBe('OLD-ADDON');
    expect(readFileSync(`${t.sidecar.oldPath}.minisig`, 'utf8')).toBe('OLD-ADDON-SIG');
  });

  it('unwinds the executable when parking its detached signature fails', () => {
    const t = withSidecar();
    writeFileSync(`${t.binary}.minisig`, 'OLD-EXE-SIG');
    writeFileSync(`${t.staged}.minisig`, 'NEW-EXE-SIG');
    preserveAndSwap(t.staged, t.binary, t.old, t.sidecar);

    // The executable rename succeeds first. A non-empty directory at the
    // signature-aside path then makes its companion rename fail; the move flag
    // must already describe the executable that is no longer live.
    const blocker = `${t.binary}.rollback-aside.minisig`;
    mkdirSync(blocker, { recursive: true });
    writeFileSync(join(blocker, 'blocker'), 'x');
    expect(() => rollbackSwap(t.old, t.binary, t.sidecar)).toThrow();

    expect(readFileSync(t.binary, 'utf8')).toBe('NEW-EXE');
    expect(readFileSync(`${t.binary}.minisig`, 'utf8')).toBe('NEW-EXE-SIG');
    expect(readFileSync(t.old, 'utf8')).toBe('OLD-EXE');
    expect(readFileSync(`${t.old}.minisig`, 'utf8')).toBe('OLD-EXE-SIG');
  });

  it('⛔ a rollback reverts the WEBCLIENT BUNDLE with the binary', () => {
    // An apply REPLACES the unpacked bundle, and the rollback had no webclient
    // awareness at all — so reverting to the previous server left the NEWER UI in
    // front of it, talking to it. Neither half expects that pairing and nothing
    // tested it.
    const t = withSidecar();
    const wc = join(t.d, 'webclient');
    mkdirSync(wc, { recursive: true });
    writeFileSync(join(wc, 'index.html'), 'NEW-UI');
    mkdirSync(`${wc}.old`, { recursive: true });
    writeFileSync(join(`${wc}.old`, 'index.html'), 'OLD-UI');

    preserveAndSwap(t.staged, t.binary, t.old, t.sidecar);
    rollbackSwap(t.old, t.binary, t.sidecar, wc);

    expect(readFileSync(t.binary, 'utf8')).toBe('OLD-EXE');
    expect(readFileSync(join(wc, 'index.html'), 'utf8'), 'the UI must follow the server')
      .toBe('OLD-UI');
    expect(existsSync(`${wc}.old`), 'the backup is consumed').toBe(false);
  });

  it('a rollback with no bundle backup leaves the UI alone rather than removing it', () => {
    // A binaries-only release, or an install that never synced one. Deleting the
    // live bundle because there is nothing to put back would turn a working UI
    // into a 404 for no reason.
    const t = withSidecar();
    const wc = join(t.d, 'webclient');
    mkdirSync(wc, { recursive: true });
    writeFileSync(join(wc, 'index.html'), 'ONLY-UI');
    preserveAndSwap(t.staged, t.binary, t.old, t.sidecar);
    rollbackSwap(t.old, t.binary, t.sidecar, wc);
    expect(readFileSync(join(wc, 'index.html'), 'utf8')).toBe('ONLY-UI');
  });

  it('a SUCCESSFUL rollback leaves no aside files behind', () => {
    const t = withSidecar();
    preserveAndSwap(t.staged, t.binary, t.old, t.sidecar);
    rollbackSwap(t.old, t.binary, t.sidecar);
    expect(readFileSync(t.binary, 'utf8')).toBe('OLD-EXE');
    expect(readFileSync(t.sidecar.livePath, 'utf8')).toBe('OLD-ADDON');
    expect(existsSync(`${t.binary}.rollback-aside`), 'exe aside cleaned up').toBe(false);
    expect(existsSync(`${t.sidecar.livePath}.rollback-aside`), 'addon aside cleaned up').toBe(false);
  });

  it('⛔ a failure while PRESERVING the addon still leaves a live executable', () => {
    // Fault injection at the exact window the compensation used to miss. The exe
    // is renamed away first; `restorePreserved` was declared BELOW this whole
    // block, so a throw here left NO LIVE EXECUTABLE and nothing able to put it
    // back — the server was gone, and the failure looked like a failed update.
    //
    // A non-empty DIRECTORY at the addon's `.old` path used to make the `rmSync`
    // of the stale backup throw. That injection stopped injecting anything once
    // the prior generation began being MOVED ASIDE rather than deleted: renaming
    // a directory to a free path succeeds, so the blocker was simply carried out
    // of the way and the apply ran to completion. Occupying the aside slot too
    // restores the fault — every escape route from the preserve step is blocked,
    // which is what this arm is actually about.
    const t = withSidecar();
    for (const p of [t.sidecar.oldPath, `${t.sidecar.oldPath}.apply-aside`]) {
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, 'blocker'), 'x');
    }

    expect(() => preserveAndSwap(t.staged, t.binary, t.old, t.sidecar)).toThrow();

    expect(existsSync(t.binary), 'the live executable must still be there').toBe(true);
    expect(readFileSync(t.binary, 'utf8'), 'and must be the ORIGINAL one').toBe('OLD-EXE');
    expect(readFileSync(t.sidecar.livePath, 'utf8'), 'the addon is untouched').toBe('OLD-ADDON');
  });

  it('a STALE `.old` directory no longer wedges the apply — it is carried aside', () => {
    // ⚠ A BEHAVIOUR CHANGE, PINNED. Before the prior generation was set aside, a
    // non-empty directory left at `.old` by an interrupted run made the next
    // apply throw at the `rmSync` — an install that could not update until
    // somebody cleaned up by hand. Moving it instead of deleting it happens to
    // clear that too, and an improvement nobody wrote down is one the next
    // change quietly reverses.
    const t = withSidecar();
    mkdirSync(t.old, { recursive: true });
    writeFileSync(join(t.old, 'blocker'), 'x');
    preserveAndSwap(t.staged, t.binary, t.old, t.sidecar);
    expect(readFileSync(t.binary, 'utf8'), 'the apply completed').toBe('NEW-EXE');
  });

  it('swaps the exe AND the addon as a set', () => {
    const t = withSidecar();
    preserveAndSwap(t.staged, t.binary, t.old, t.sidecar);
    expect(readFileSync(t.binary, 'utf8')).toBe('NEW-EXE');
    expect(readFileSync(t.sidecar.livePath, 'utf8')).toBe('NEW-ADDON');
    // both previous halves preserved as the rollback target
    expect(readFileSync(t.old, 'utf8')).toBe('OLD-EXE');
    expect(readFileSync(t.sidecar.oldPath, 'utf8')).toBe('OLD-ADDON');
  });

  it('⛔ rollback restores the addon too, not just the exe', () => {
    // Restoring the old exe next to the NEW addon is the SAME ABI mismatch that
    // caused the rollback: it would report success and still not open a database.
    const t = withSidecar();
    preserveAndSwap(t.staged, t.binary, t.old, t.sidecar);
    rollbackSwap(t.old, t.binary, t.sidecar);
    expect(readFileSync(t.binary, 'utf8')).toBe('OLD-EXE');
    expect(readFileSync(t.sidecar.livePath, 'utf8')).toBe('OLD-ADDON');
  });

  it('leaves NO half-applied state when the addon swap fails', () => {
    // The crash window with no owner: the boot-health gate cannot see a partial
    // apply until the next boot, and by then the staged file is gone.
    const t = withSidecar();
    // Make the addon rename fail by removing the staged addon after the exe
    // stage — the same shape as a mid-swap crash or a cross-device move.
    rmSync(t.sidecar.stagedPath);
    expect(() => preserveAndSwap(t.staged, t.binary, t.old, t.sidecar)).toThrow();
    // Everything back as it was: old exe live, old addon live.
    expect(readFileSync(t.binary, 'utf8')).toBe('OLD-EXE');
    expect(readFileSync(t.sidecar.livePath, 'utf8')).toBe('OLD-ADDON');
  });

  it('still works with no sidecar at all (docker-thin / pre-sidecar installs)', () => {
    const t = withSidecar();
    preserveAndSwap(t.staged, t.binary, t.old);
    expect(readFileSync(t.binary, 'utf8')).toBe('NEW-EXE');
    // untouched — an install without a managed sidecar must not have one invented
    expect(readFileSync(t.sidecar.livePath, 'utf8')).toBe('OLD-ADDON');
  });

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
    expect(existsSync(snapshotReceiptEpochMarkerPath(live))).toBe(true);
  });

  it('rotates and durably clears a completed restore only on the keyed-open handle', () => {
    const d = dir();
    const snap = join(d, 'pre.db');
    const live = join(d, 'live.db');
    const source = new Database(snap);
    source.exec(`CREATE TABLE gated_action_receipts (
      key TEXT NOT NULL PRIMARY KEY,
      data TEXT NOT NULL
    )`);
    source.prepare('INSERT INTO gated_action_receipts (key, data) VALUES (?, ?)').run(
      'restored-action',
      JSON.stringify({ change_seq: 9 }),
    );
    source.close();
    const current = new Database(live);
    current.exec('CREATE TABLE current_state (value TEXT)');
    current.close();

    restoreSnapshot(snap, live, (from, to) => copyFileSync(from, to));
    expect(reconcileSnapshotReceiptEpochBeforeOpen(live)).toBe('rotation_pending');
    const pendingJournal = readFileSync(snapshotReceiptEpochMarkerPath(live), 'utf8');
    const restored = new Database(live);
    let firstEpoch = '';
    try {
      expect(completeSnapshotReceiptEpochAfterKeyedOpen(live, restored)).toBe(true);
      const clock = restored.prepare(`
        SELECT value, floor, epoch
          FROM gated_action_change_sequence
         WHERE singleton = 1
      `).get() as { value: number; floor: number; epoch: string };
      expect(clock.value).toBe(10);
      expect(clock.floor).toBe(10);
      expect(clock.epoch).toMatch(/^[0-9a-f-]{36}$/);
      firstEpoch = clock.epoch;
    } finally {
      restored.close();
    }
    expect(existsSync(snapshotReceiptEpochMarkerPath(live))).toBe(false);
    // Model a kill after the checkpoint became durable but before marker
    // deletion: retry rotates once more, preserving monotonicity and safety.
    writeFileSync(snapshotReceiptEpochMarkerPath(live), pendingJournal, 'utf8');
    const retry = new Database(live);
    try {
      expect(completeSnapshotReceiptEpochAfterKeyedOpen(live, retry)).toBe(true);
      const clock = retry.prepare(`
        SELECT value, floor, epoch
          FROM gated_action_change_sequence
         WHERE singleton = 1
      `).get() as { value: number; floor: number; epoch: string };
      expect(clock.value).toBe(11);
      expect(clock.floor).toBe(11);
      expect(clock.epoch).not.toBe(firstEpoch);
    } finally {
      retry.close();
    }
    const reopened = new Database(live);
    try {
      expect(completeSnapshotReceiptEpochAfterKeyedOpen(live, reopened)).toBe(false);
    } finally {
      reopened.close();
    }
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
    expect(reconcileSnapshotReceiptEpochBeforeOpen(live)).toBe('unchanged');
    expect(existsSync(snapshotReceiptEpochMarkerPath(live))).toBe(false);
  });

  it('keeps rotation pending when a partial sidecar removal may rewind WAL state', () => {
    const d = dir();
    const snap = join(d, 'pre.db');
    const live = join(d, 'live.db');
    writeFileSync(snap, 'snapshot-bytes');
    writeFileSync(live, 'mutated-bytes');
    writeFileSync(`${live}-wal`, 'migrated-wal-frames');
    mkdirSync(`${live}-shm`);

    expect(() => restoreSnapshot(snap, live, (from, to) => copyFileSync(from, to))).toThrow();
    expect(existsSync(`${live}-wal`)).toBe(false);
    expect(existsSync(`${live}.restoring`)).toBe(true);
    expect(reconcileSnapshotReceiptEpochBeforeOpen(live)).toBe('rotation_pending');
    expect(existsSync(snapshotReceiptEpochMarkerPath(live))).toBe(true);
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

/** ⛔⛔⛔ THE SWAP IS EXCEPTION-SAFE AND WAS NOT PROCESS-DEATH SAFE. `rollbackSwap`
 *  unwinds in memory, and a SIGKILL takes the unwind with it. These reproduce each
 *  crash point by leaving the exact file set the kill would leave, and assert the
 *  recovery reaches a PAIRED install — the property, not the steps. */
// ⛔⛔ A ROLLBACK MUST NOT LEAVE THE INSTALL WITH NO ADDON AT ALL. The live addon
// was displaced unconditionally and the preserved one restored ONLY if it existed,
// so an install with a live addon and no `.old` had its only copy moved aside and
// then DELETED at commit — the reverted exe died at its first database open.
//
// ⚠ REACHABLE, NOT THEORETICAL: `install.sh` places the addon with no `.old`, and
// an apply of a release whose manifest carries no sidecar preserves none. A
// rollback of THAT apply is exactly this shape.
describe('rollbackSwap with nothing preserved to restore', () => {
  it('leaves the live addon in place rather than deleting it', () => {
    const d = dir();
    const binary = join(d, 'recued');
    const old = join(d, 'recued.old');
    mkdirSync(join(d, 'lib'), { recursive: true });
    const sidecar = {
      stagedPath: join(d, 'addon.staged'),
      livePath: join(d, 'lib', 'better_sqlite3.node'),
      oldPath: join(d, 'lib', 'better_sqlite3.node.old'),
    };
    writeFileSync(binary, 'NEW-EXE');
    writeFileSync(old, 'OLD-EXE');
    writeFileSync(sidecar.livePath, 'THE-ONLY-ADDON');   // …and no `.old` beside it

    rollbackSwap(old, binary, sidecar);

    expect(readFileSync(binary, 'utf8')).toBe('OLD-EXE');
    expect(
      existsSync(sidecar.livePath),
      'the only addon on the volume must survive a rollback that had none preserved',
    ).toBe(true);
    expect(readFileSync(sidecar.livePath, 'utf8')).toBe('THE-ONLY-ADDON');
  });
});

describe('reconcileInterruptedPairSwap', () => {
  /** A volume mid-rollback: the new pair live, the previous pair preserved. */
  const staged = () => {
    const d = dir();
    const binary = join(d, 'recued');
    const old = join(d, 'recued.old');
    mkdirSync(join(d, 'lib'), { recursive: true });
    const sidecar = {
      stagedPath: join(d, 'addon.staged'),
      livePath: join(d, 'lib', 'better_sqlite3.node'),
      oldPath: join(d, 'lib', 'better_sqlite3.node.old'),
    };
    writeFileSync(binary, 'NEW-EXE');
    writeFileSync(sidecar.livePath, 'NEW-ADDON');
    writeFileSync(old, 'OLD-EXE');
    writeFileSync(sidecar.oldPath, 'OLD-ADDON');
    return { d, binary, old, sidecar };
  };

  it('is a no-op on a healthy install', () => {
    const t = staged();
    expect(reconcileInterruptedPairSwap(t.old, t.binary, t.sidecar)).toEqual({ action: 'none' });
    expect(readFileSync(t.binary, 'utf8')).toBe('NEW-EXE');
    expect(readFileSync(t.sidecar.livePath, 'utf8')).toBe('NEW-ADDON');
  });

  it('⛔ repairs an apply killed after parking `.old` but before moving current', () => {
    const t = staged();
    renameSync(t.old, `${t.old}.apply-aside`);
    renameSync(t.sidecar.oldPath, `${t.sidecar.oldPath}.apply-aside`);

    expect(reconcileInterruptedPairSwap(t.old, t.binary, t.sidecar))
      .toEqual({ action: 'completed' });
    expect(readFileSync(t.binary, 'utf8')).toBe('NEW-EXE');
    expect(readFileSync(t.old, 'utf8')).toBe('OLD-EXE');
    expect(readFileSync(t.sidecar.livePath, 'utf8')).toBe('NEW-ADDON');
    expect(readFileSync(t.sidecar.oldPath, 'utf8')).toBe('OLD-ADDON');
  });

  it('⛔ repairs an apply killed after preserving current but before staged lands', () => {
    const t = staged();
    renameSync(t.old, `${t.old}.apply-aside`);
    renameSync(t.binary, t.old);
    renameSync(t.sidecar.oldPath, `${t.sidecar.oldPath}.apply-aside`);
    renameSync(t.sidecar.livePath, t.sidecar.oldPath);

    expect(reconcileInterruptedPairSwap(t.old, t.binary, t.sidecar))
      .toEqual({ action: 'completed' });
    expect(readFileSync(t.binary, 'utf8')).toBe('NEW-EXE');
    expect(readFileSync(t.old, 'utf8')).toBe('OLD-EXE');
    expect(readFileSync(t.sidecar.livePath, 'utf8')).toBe('NEW-ADDON');
    expect(readFileSync(t.sidecar.oldPath, 'utf8')).toBe('OLD-ADDON');
    expect(reconcileInterruptedPairSwap(t.old, t.binary, t.sidecar))
      .toEqual({ action: 'none' });
  });

  it('⛔ keeps the outgoing signature when killed between payload and signature renames', () => {
    const t = staged();
    writeFileSync(`${t.binary}${SIG_SIDECAR_SUFFIX}`, 'NEW-EXE-SIG');
    writeFileSync(`${t.old}${SIG_SIDECAR_SUFFIX}`, 'OLD-EXE-SIG');
    renameSync(t.old, `${t.old}.apply-aside`);
    renameSync(`${t.old}${SIG_SIDECAR_SUFFIX}`, `${t.old}${SIG_SIDECAR_SUFFIX}.apply-aside`);
    renameSync(t.binary, t.old);
    // SIGKILL here: NEW-EXE is at `.old`, but its signature is still at live.

    expect(reconcileInterruptedPairSwap(t.old, t.binary, t.sidecar))
      .toEqual({ action: 'completed' });
    expect(readFileSync(t.binary, 'utf8')).toBe('NEW-EXE');
    expect(readFileSync(`${t.binary}${SIG_SIDECAR_SUFFIX}`, 'utf8')).toBe('NEW-EXE-SIG');
    expect(readFileSync(t.old, 'utf8')).toBe('OLD-EXE');
    expect(readFileSync(`${t.old}${SIG_SIDECAR_SUFFIX}`, 'utf8')).toBe('OLD-EXE-SIG');
  });

  it('⛔ finishes an apply killed after the staged executable lands but before its addon', () => {
    const t = staged();
    const stagedBinary = `${t.binary}.staged`;
    renameSync(t.old, `${t.old}.apply-aside`);
    renameSync(t.binary, t.old);
    renameSync(t.sidecar.oldPath, `${t.sidecar.oldPath}.apply-aside`);
    renameSync(t.sidecar.livePath, t.sidecar.oldPath);
    writeFileSync(stagedBinary, 'TARGET-EXE');
    writeFileSync(`${stagedBinary}${SIG_SIDECAR_SUFFIX}`, 'TARGET-EXE-SIG');
    renameSync(stagedBinary, t.binary);
    writeFileSync(t.sidecar.stagedPath, 'TARGET-ADDON');
    writeFileSync(`${t.sidecar.stagedPath}${SIG_SIDECAR_SUFFIX}`, 'TARGET-ADDON-SIG');

    expect(reconcileInterruptedPairSwap(t.old, t.binary, t.sidecar))
      .toEqual({ action: 'completed' });
    expect(readFileSync(t.binary, 'utf8')).toBe('TARGET-EXE');
    expect(readFileSync(`${t.binary}${SIG_SIDECAR_SUFFIX}`, 'utf8')).toBe('TARGET-EXE-SIG');
    expect(readFileSync(t.sidecar.livePath, 'utf8')).toBe('TARGET-ADDON');
    expect(readFileSync(`${t.sidecar.livePath}${SIG_SIDECAR_SUFFIX}`, 'utf8'))
      .toBe('TARGET-ADDON-SIG');
    expect(readFileSync(t.old, 'utf8')).toBe('NEW-EXE');
    expect(readFileSync(`${t.old}.apply-aside`, 'utf8')).toBe('OLD-EXE');
    expect(readFileSync(t.sidecar.oldPath, 'utf8')).toBe('NEW-ADDON');
    expect(readFileSync(`${t.sidecar.oldPath}.apply-aside`, 'utf8')).toBe('OLD-ADDON');
    expect(reconcileInterruptedPairSwap(t.old, t.binary, t.sidecar))
      .toEqual({ action: 'none' });
  });

  // ⛔⛔ THE WINDOW THAT WEDGES AN INSTALL: the exe half committed, so `recued.old`
  // is CONSUMED, and the addon is still parked. The next start execs an old binary
  // with no addon, dies at the first database open, and has nothing to revert to.
  it('finishes a rollback killed between the two restores', () => {
    const t = staged();
    writeFileSync(`${t.old}.apply-aside`, 'TWO-BIN-GENERATIONS-BACK');
    writeFileSync(`${t.sidecar.oldPath}.apply-aside`, 'TWO-ADDON-GENERATIONS-BACK');
    // The kill state: exe restored, `recued.old` gone, addon parked aside.
    renameSync(t.binary, `${t.binary}.rollback-aside`);
    renameSync(t.sidecar.livePath, `${t.sidecar.livePath}.rollback-aside`);
    renameSync(t.old, t.binary);

    expect(reconcileInterruptedPairSwap(t.old, t.binary, t.sidecar)).toEqual({ action: 'completed' });
    expect(readFileSync(t.binary, 'utf8')).toBe('OLD-EXE');
    expect(readFileSync(t.sidecar.livePath, 'utf8'), 'the pair must be one generation')
      .toBe('OLD-ADDON');
    expect(readFileSync(t.old, 'utf8'), 'the prior rollback target is promoted too')
      .toBe('TWO-BIN-GENERATIONS-BACK');
    expect(readFileSync(t.sidecar.oldPath, 'utf8'))
      .toBe('TWO-ADDON-GENERATIONS-BACK');
    expect(existsSync(`${t.binary}.rollback-aside`)).toBe(false);
    expect(existsSync(`${t.sidecar.livePath}.rollback-aside`)).toBe(false);
  });

  // ⛔ AND THE EARLIER WINDOW, which is the one a naive "restore what is missing"
  // recovery gets wrong: the exe was displaced but not yet replaced, so the NEW
  // addon is still live. Restoring only the exe would pair an OLD binary with a
  // NEW addon — the ABI mismatch the rollback exists to escape.
  it('finishes a rollback killed before the addon was displaced', () => {
    const t = staged();
    renameSync(t.binary, `${t.binary}.rollback-aside`);

    expect(reconcileInterruptedPairSwap(t.old, t.binary, t.sidecar)).toEqual({ action: 'completed' });
    expect(readFileSync(t.binary, 'utf8')).toBe('OLD-EXE');
    expect(readFileSync(t.sidecar.livePath, 'utf8')).toBe('OLD-ADDON');
  });

  // Nothing preserved to restore, and the live addon parked: put it back. A guess,
  // but one that can OPEN A DATABASE, and no addon at all cannot.
  it('returns the displaced addon when nothing was preserved', () => {
    const t = staged();
    rmSync(t.sidecar.oldPath);
    renameSync(t.binary, `${t.binary}.rollback-aside`);
    renameSync(t.sidecar.livePath, `${t.sidecar.livePath}.rollback-aside`);
    renameSync(t.old, t.binary);

    expect(reconcileInterruptedPairSwap(t.old, t.binary, t.sidecar)).toEqual({ action: 'completed' });
    expect(readFileSync(t.sidecar.livePath, 'utf8')).toBe('NEW-ADDON');
  });

  it('only sweeps asides left by a rollback that had already committed', () => {
    const t = staged();
    // Committed: old pair live, nothing preserved, but the final unlink was lost.
    rmSync(t.old); rmSync(t.sidecar.oldPath);
    writeFileSync(t.binary, 'OLD-EXE');
    writeFileSync(t.sidecar.livePath, 'OLD-ADDON');
    writeFileSync(`${t.binary}.rollback-aside`, 'NEW-EXE');

    expect(reconcileInterruptedPairSwap(t.old, t.binary, t.sidecar)).toEqual({ action: 'cleaned' });
    expect(readFileSync(t.binary, 'utf8'), 'a committed rollback must not be re-done').toBe('OLD-EXE');
    expect(readFileSync(t.sidecar.livePath, 'utf8')).toBe('OLD-ADDON');
    expect(existsSync(`${t.binary}.rollback-aside`)).toBe(false);
  });

  it('⛔ finishes signature moves when a rollback dies after the payload renames', () => {
    const t = staged();
    writeFileSync(`${t.binary}${SIG_SIDECAR_SUFFIX}`, 'NEW-EXE-SIG');
    writeFileSync(`${t.old}${SIG_SIDECAR_SUFFIX}`, 'OLD-EXE-SIG');
    writeFileSync(`${t.sidecar.livePath}${SIG_SIDECAR_SUFFIX}`, 'NEW-ADDON-SIG');
    writeFileSync(`${t.sidecar.oldPath}${SIG_SIDECAR_SUFFIX}`, 'OLD-ADDON-SIG');
    renameSync(t.binary, `${t.binary}.rollback-aside`);
    renameSync(t.sidecar.livePath, `${t.sidecar.livePath}.rollback-aside`);
    renameSync(t.old, t.binary);
    renameSync(t.sidecar.oldPath, t.sidecar.livePath);

    expect(reconcileInterruptedPairSwap(t.old, t.binary, t.sidecar))
      .toEqual({ action: 'completed' });
    expect(readFileSync(`${t.binary}${SIG_SIDECAR_SUFFIX}`, 'utf8')).toBe('OLD-EXE-SIG');
    expect(readFileSync(`${t.sidecar.livePath}${SIG_SIDECAR_SUFFIX}`, 'utf8'))
      .toBe('OLD-ADDON-SIG');
  });

  it('⛔ completes post-rollback promotion of the parked prior generation', () => {
    const t = staged();
    // R3 was displaced, R2 was already restored, and R1 is still parked because
    // the process died before rollbackSwap promoted `.apply-aside` into `.old`.
    rmSync(t.old);
    writeFileSync(t.binary, 'R2-EXE');
    writeFileSync(`${t.binary}.rollback-aside`, 'R3-EXE');
    writeFileSync(`${t.old}.apply-aside`, 'R1-EXE');
    writeFileSync(`${t.old}.minisig.apply-aside`, 'R1-EXE-SIG');

    rmSync(t.sidecar.oldPath);
    writeFileSync(t.sidecar.livePath, 'R2-ADDON');
    writeFileSync(`${t.sidecar.livePath}.rollback-aside`, 'R3-ADDON');
    writeFileSync(`${t.sidecar.oldPath}.apply-aside`, 'R1-ADDON');
    writeFileSync(`${t.sidecar.oldPath}.minisig.apply-aside`, 'R1-ADDON-SIG');

    expect(reconcileInterruptedPairSwap(t.old, t.binary, t.sidecar)).toEqual({ action: 'completed' });
    expect(readFileSync(t.binary, 'utf8')).toBe('R2-EXE');
    expect(readFileSync(t.old, 'utf8')).toBe('R1-EXE');
    expect(readFileSync(`${t.old}.minisig`, 'utf8')).toBe('R1-EXE-SIG');
    expect(readFileSync(t.sidecar.livePath, 'utf8')).toBe('R2-ADDON');
    expect(readFileSync(t.sidecar.oldPath, 'utf8')).toBe('R1-ADDON');
    expect(readFileSync(`${t.sidecar.oldPath}.minisig`, 'utf8')).toBe('R1-ADDON-SIG');
    const debris = [t.d, join(t.d, 'lib')].flatMap((parent) =>
      readdirSync(parent).filter((name) => name.includes('apply-aside') || name.includes('rollback-aside')),
    );
    expect(debris).toEqual([]);
  });

  it('is idempotent', () => {
    const t = staged();
    renameSync(t.binary, `${t.binary}.rollback-aside`);
    renameSync(t.sidecar.livePath, `${t.sidecar.livePath}.rollback-aside`);
    renameSync(t.old, t.binary);
    reconcileInterruptedPairSwap(t.old, t.binary, t.sidecar);
    expect(reconcileInterruptedPairSwap(t.old, t.binary, t.sidecar)).toEqual({ action: 'none' });
    expect(readFileSync(t.binary, 'utf8')).toBe('OLD-EXE');
    expect(readFileSync(t.sidecar.livePath, 'utf8')).toBe('OLD-ADDON');
  });
});

/** ⛔ `restoreWebclientBundle` — the disk-backed undo used by rollback.
 *
 *  Lifted out of `rollbackSwap` so the apply's abort branches run the SAME move
 *  the rollback does, rather than a second copy of it. Its safety condition is
 *  the caller's, not its own: `<dir>.old` outlives a successful apply, so a full
 *  restore belongs only to a confirmed binary rollback. An aside-only state is
 *  self-describing and repairs the rollback chain without touching live. */
describe('restoreWebclientBundle', () => {
  const bundle = (): { dir: string; live: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-wc-restore-'));
    const live = join(dir, 'webclient');
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, 'index.html'), 'NEW-UI');
    return { dir, live };
  };

  it('puts the displaced bundle back over the live one', () => {
    const { dir, live } = bundle();
    try {
      mkdirSync(`${live}.old`, { recursive: true });
      writeFileSync(join(`${live}.old`, 'index.html'), 'OLD-UI');
      expect(restoreWebclientBundle(live)).toBe(true);
      expect(readFileSync(join(live, 'index.html'), 'utf8')).toBe('OLD-UI');
      expect(existsSync(`${live}.old`), 'the backup is consumed, not duplicated').toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reports false and changes nothing when there is no backup', () => {
    const { dir, live } = bundle();
    try {
      expect(restoreWebclientBundle(live)).toBe(false);
      expect(readFileSync(join(live, 'index.html'), 'utf8')).toBe('NEW-UI');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('is a no-op for an unconfigured webclient dir rather than throwing', () => {
    // The port is optional; an install with no bundle directory must not turn a
    // best-effort UI move into an exception inside the commit callback.
    expect(restoreWebclientBundle(undefined)).toBe(false);
    expect(restoreWebclientBundle('')).toBe(false);
  });
});

/** ⛔⛔ A FAILED APPLY MUST NOT COST THE ROLLBACK TARGET.
 *
 *  `preserveAndSwap` dropped the existing `recued.old` before the staged rename,
 *  and its compensation restores the LIVE binary without restoring what used to
 *  be behind it. So an apply that FAILED left the install on its current release
 *  with no rollback target at all — the safety net removed by the run that most
 *  needed it to survive. Probed directly at the time:
 *  `{live: "R2", rollbackTargetExists: false}`. */
describe('preserveAndSwap keeps the generation behind the one it displaces', () => {
  const install = (): { dir: string; bin: string; old: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-generations-'));
    const bin = join(dir, 'recued');
    const old = join(dir, 'recued.old');
    writeFileSync(bin, 'R2', { mode: 0o755 });
    writeFileSync(old, 'R1', { mode: 0o755 });
    return { dir, bin, old };
  };

  it('⛔ THE AUDIT PROBE: a failed swap leaves R2 live AND R1 recoverable', () => {
    const { dir, bin, old } = install();
    try {
      // A staged path that does not exist — the rename throws, which is the real
      // "the swap failed" shape. (Renaming a DIRECTORY onto a free path SUCCEEDS,
      // so injecting failure that way injects none at all.)
      expect(() => preserveAndSwap(join(dir, 'recued.staged'), bin, old)).toThrow();
      expect(readFileSync(bin, 'utf8'), 'the live binary comes back').toBe('R2');
      expect(existsSync(old), 'and so does the rollback target').toBe(true);
      expect(readFileSync(old, 'utf8')).toBe('R1');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('⛔ a SUCCESSFUL swap KEEPS the aside — the operation is not over yet', () => {
    // ⛔⛔ THE LIFETIME IS THE OPERATION, NOT THE SWAP. This arm asserted the
    // opposite while the aside was dropped on a successful rename, which covered
    // a failed SWAP and not a failed BOOT — and the apply is TWO-PHASE, so it
    // commits on the next healthy start. Between the two, an auto-revert consumes
    // `recued.old` and would leave the previous release with no rollback target:
    // the same loss, one phase later.
    const { dir, bin, old } = install();
    try {
      writeFileSync(join(dir, 'recued.staged'), 'R3');
      preserveAndSwap(join(dir, 'recued.staged'), bin, old);
      expect(readFileSync(bin, 'utf8')).toBe('R3');
      expect(readFileSync(old, 'utf8')).toBe('R2');
      expect(
        readFileSync(`${old}.apply-aside`, 'utf8'),
        'R1 waits until the release that displaced it proves it starts',
      ).toBe('R1');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('and the boot-time commit drops it — exactly one generation is kept', () => {
    // The arm that stops the longer lifetime becoming a leak. At most one
    // rollback target is kept by design; a third would make `recued.old`
    // ambiguous to every reader of it, and each is a whole binary on disk.
    const { dir, bin, old } = install();
    try {
      writeFileSync(join(dir, 'recued.staged'), 'R3');
      preserveAndSwap(join(dir, 'recued.staged'), bin, old);
      dropApplyAside(old);
      expect(readdirSync(dir).filter((f) => f.includes('.apply-aside'))).toEqual([]);
      expect(readFileSync(old, 'utf8'), 'and the real rollback target is untouched').toBe('R2');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('boot-time commit clears the older webclient aside but keeps the rollback target', () => {
    const { dir, old } = install();
    const webclient = join(dir, 'webclient');
    try {
      mkdirSync(`${webclient}.apply-aside`, { recursive: true });
      mkdirSync(`${webclient}.old`, { recursive: true });
      writeFileSync(join(`${webclient}.old`, WEBCLIENT_ABSENT_MARKER), '1\n');
      dropApplyAside(old, undefined, webclient);
      expect(existsSync(`${webclient}.apply-aside`)).toBe(false);
      expect(existsSync(join(`${webclient}.old`, WEBCLIENT_ABSENT_MARKER))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('⛔⛔ THE RESIDUAL: a revert BEFORE the commit restores R2 *and* R1 behind it', () => {
    // The swap succeeded, the boot did not, and the auto-revert puts R2 back by
    // CONSUMING `recued.old`. Without promoting the parked generation the install
    // lands on R2 with nothing to roll back to — which is where this whole
    // finding started, reached through the revert instead of a failed rename.
    const { dir, bin, old } = install();
    try {
      writeFileSync(join(dir, 'recued.staged'), 'R3');
      preserveAndSwap(join(dir, 'recued.staged'), bin, old);
      rollbackSwap(old, bin);
      expect(readFileSync(bin, 'utf8'), 'the previous release is live again').toBe('R2');
      expect(existsSync(old), 'and it has a rollback target once more').toBe(true);
      expect(readFileSync(old, 'utf8'), 'the pre-apply state, exactly').toBe('R1');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a rollback of a COMMITTED release finds nothing parked — the promote is a no-op', () => {
    // What makes the promote safe on the owner-driven path: the boot-time commit
    // already dropped the aside, so a rollback of a release that actually started
    // behaves exactly as it did before.
    const { dir, bin, old } = install();
    try {
      writeFileSync(join(dir, 'recued.staged'), 'R3');
      preserveAndSwap(join(dir, 'recued.staged'), bin, old);
      dropApplyAside(old);
      rollbackSwap(old, bin);
      expect(readFileSync(bin, 'utf8')).toBe('R2');
      expect(existsSync(old), 'no third generation appears from nowhere').toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('and the ADDON generation survives the same failure', () => {
    // A rollback that restores the old exe beside the NEW addon is the ABI
    // mismatch in reverse, so the addon's rollback target matters exactly as
    // much as the binary's.
    const { dir, bin, old } = install();
    try {
      const live = join(dir, 'better_sqlite3.node');
      const oldAddon = join(dir, 'better_sqlite3.node.old');
      writeFileSync(live, 'ADDON-R2');
      writeFileSync(oldAddon, 'ADDON-R1');
      writeFileSync(`${live}.minisig`, 'ADDON-R2-SIG');
      writeFileSync(`${oldAddon}.minisig`, 'ADDON-R1-SIG');
      expect(() => preserveAndSwap(join(dir, 'recued.staged'), bin, old, {
        livePath: live, oldPath: oldAddon, stagedPath: join(dir, 'addon.staged'),
      })).toThrow();
      expect(readFileSync(live, 'utf8')).toBe('ADDON-R2');
      expect(readFileSync(oldAddon, 'utf8'), 'the addon rollback target too').toBe('ADDON-R1');
      expect(readFileSync(`${live}.minisig`, 'utf8')).toBe('ADDON-R2-SIG');
      expect(readFileSync(`${oldAddon}.minisig`, 'utf8'), 'and its detached signature too')
        .toBe('ADDON-R1-SIG');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('⛔ keeps the add-on signature with every parked and restored generation', () => {
    const { dir, bin, old } = install();
    try {
      const live = join(dir, 'better_sqlite3.node');
      const oldAddon = join(dir, 'better_sqlite3.node.old');
      const stagedAddon = join(dir, 'addon.staged');
      const stagedBin = join(dir, 'recued.staged');
      writeFileSync(live, 'ADDON-R2');
      writeFileSync(`${live}${SIG_SIDECAR_SUFFIX}`, 'SIG-R2');
      writeFileSync(oldAddon, 'ADDON-R1');
      writeFileSync(`${oldAddon}${SIG_SIDECAR_SUFFIX}`, 'SIG-R1');
      writeFileSync(stagedBin, 'R3');
      writeFileSync(stagedAddon, 'ADDON-R3');
      writeFileSync(`${stagedAddon}${SIG_SIDECAR_SUFFIX}`, 'SIG-R3');
      const sidecar = { livePath: live, oldPath: oldAddon, stagedPath: stagedAddon };

      preserveAndSwap(stagedBin, bin, old, sidecar);
      expect(readFileSync(`${live}${SIG_SIDECAR_SUFFIX}`, 'utf8')).toBe('SIG-R3');
      expect(readFileSync(`${oldAddon}${SIG_SIDECAR_SUFFIX}`, 'utf8')).toBe('SIG-R2');
      expect(readFileSync(`${oldAddon}${SIG_SIDECAR_SUFFIX}.apply-aside`, 'utf8')).toBe('SIG-R1');

      rollbackSwap(old, bin, sidecar);
      expect(readFileSync(`${live}${SIG_SIDECAR_SUFFIX}`, 'utf8')).toBe('SIG-R2');
      expect(readFileSync(`${oldAddon}${SIG_SIDECAR_SUFFIX}`, 'utf8')).toBe('SIG-R1');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

/** The bundle half of the same loss. `syncWebclientBundle` cleared `<dir>.old`
 *  before downloading, so an apply that synced and then ABORTED restored the
 *  previous bundle and left the release behind it with no rollback UI. */
describe('restoreWebclientBundle completes the undo', () => {
  it('⛔ promotes the parked generation once `.old` has been consumed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-wc-generations-'));
    const live = join(dir, 'webclient');
    try {
      for (const [p, body] of [[live, 'UI-R3'], [`${live}.old`, 'UI-R2'], [`${live}.apply-aside`, 'UI-R1']] as const) {
        mkdirSync(p, { recursive: true });
        writeFileSync(join(p, 'index.html'), body);
      }
      expect(restoreWebclientBundle(live)).toBe(true);
      expect(readFileSync(join(live, 'index.html'), 'utf8'), 'R2 goes live').toBe('UI-R2');
      expect(
        readFileSync(join(`${live}.old`, 'index.html'), 'utf8'),
        'and R1 becomes its rollback target again — the pre-apply state',
      ).toBe('UI-R1');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('⛔ an aside-only rollback rebuilds `.old` without replacing the live UI', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-wc-aside-only-'));
    const live = join(dir, 'webclient');
    try {
      mkdirSync(live, { recursive: true });
      writeFileSync(join(live, 'index.html'), 'UI-R2');
      mkdirSync(`${live}.apply-aside`, { recursive: true });
      writeFileSync(join(`${live}.apply-aside`, 'index.html'), 'UI-R1');
      expect(restoreWebclientBundle(live)).toBe(true);
      expect(readFileSync(join(live, 'index.html'), 'utf8')).toBe('UI-R2');
      expect(readFileSync(join(`${live}.old`, 'index.html'), 'utf8')).toBe('UI-R1');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('⛔ restores an absent prior bundle after a first-install promotion restarts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-wc-absent-'));
    const live = join(dir, 'webclient');
    try {
      mkdirSync(live, { recursive: true });
      writeFileSync(join(live, 'index.html'), 'UI-R3');
      mkdirSync(`${live}.old`, { recursive: true });
      writeFileSync(join(`${live}.old`, WEBCLIENT_ABSENT_MARKER), '1\n');
      expect(restoreWebclientBundle(live)).toBe(true);
      expect(existsSync(live), 'R2 had no UI, so rollback restores absence').toBe(false);
      expect(existsSync(`${live}.old`)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

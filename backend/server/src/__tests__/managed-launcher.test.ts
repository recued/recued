import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { generateKeypair, sign } from '@recued/release';
import {
  decideLaunch,
  runLauncher,
  readFailureCount,
  incrementFailureCount,
  resetFailureCount,
  revertToOld,
  recordLedgerRevert,
  seedIfAbsent,
  verifyBinarySignature,
  verifyPayloadSignature,
  addonPathFor,
  ADDON_RELATIVE_PATH,
  LAUNCHER_VERSION,
  BOOT_FAILURE_THRESHOLD,
  type LaunchInput,
} from '../launcher/managed-launcher.js';

const base = (over: Partial<LaunchInput> = {}): LaunchInput => ({
  currentExists: true,
  currentVerified: true,
  oldExists: true,
  oldVerified: true,
  failureCount: 0,
  threshold: BOOT_FAILURE_THRESHOLD,
  ...over,
});

describe('decideLaunch', () => {
  it('execs a healthy current binary', () => {
    expect(decideLaunch(base())).toEqual({ action: 'exec-current' });
  });

  it('reverts to old when current is over the failure threshold', () => {
    const d = decideLaunch(base({ failureCount: BOOT_FAILURE_THRESHOLD }));
    expect(d.action).toBe('revert-and-exec-old');
  });

  it('reverts when the current binary fails verification', () => {
    const d = decideLaunch(base({ currentVerified: false }));
    expect(d.action).toBe('revert-and-exec-old');
    if (d.action === 'revert-and-exec-old') expect(d.reason).toMatch(/verification/);
  });

  it('reverts when the current binary is missing', () => {
    const d = decideLaunch(base({ currentExists: false }));
    expect(d.action).toBe('revert-and-exec-old');
  });

  it('runs current as last resort when over threshold but no verified fallback', () => {
    expect(decideLaunch(base({ failureCount: 5, oldExists: false }))).toEqual({ action: 'exec-current' });
    expect(decideLaunch(base({ failureCount: 5, oldVerified: false }))).toEqual({ action: 'exec-current' });
  });

  it('refuses when nothing is runnable', () => {
    const d = decideLaunch(base({ currentExists: false, oldExists: false }));
    expect(d.action).toBe('refuse');
  });

  it('refuses when current is unverified and there is no verified old', () => {
    const d = decideLaunch(base({ currentVerified: false, oldVerified: false }));
    expect(d.action).toBe('refuse');
  });
});

describe('failure counter sidecar', () => {
  it('reads 0 for a missing/corrupt file, increments, and resets', () => {
    const d = mkdtempSync(join(tmpdir(), 'launcher-ctr-'));
    const p = join(d, 'boot-failures.json');
    expect(readFailureCount(p)).toBe(0);
    expect(incrementFailureCount(p)).toBe(1);
    expect(incrementFailureCount(p)).toBe(2);
    expect(readFailureCount(p)).toBe(2);
    resetFailureCount(p);
    expect(readFailureCount(p)).toBe(0);
  });

  it('preserves a server-keyed release_identity across increment', () => {
    const d = mkdtempSync(join(tmpdir(), 'launcher-ctr2-'));
    const p = join(d, 'boot-failures.json');
    writeFileSync(p, JSON.stringify({ count: 1, release_identity: 'stable:1.4.2' }), 'utf8');
    incrementFailureCount(p);
    const o = JSON.parse(readFileSync(p, 'utf8')) as { count: number; release_identity: string };
    expect(o).toEqual({ count: 2, release_identity: 'stable:1.4.2' });
  });
});

describe('verifyBinarySignature', () => {
  it('returns true with no pinned key (pre-GA bypass)', () => {
    const d = mkdtempSync(join(tmpdir(), 'launcher-vrf-'));
    const bin = join(d, 'recued');
    writeFileSync(bin, 'x');
    expect(verifyBinarySignature(bin, '')).toBe(true);
  });

  it('returns false when a sig sidecar is missing under a real key', () => {
    const d = mkdtempSync(join(tmpdir(), 'launcher-vrf2-'));
    const bin = join(d, 'recued');
    writeFileSync(bin, 'x');
    expect(verifyBinarySignature(bin, 'RWQ-some-key')).toBe(false);
  });
});

// ── D-178 item 6 — the launcher verifies the WHOLE payload ────────────────
//    The re-verify exists because the data volume is mutable and outside the
//    image's trust boundary. Checking only the exe leaves the EASIER attack
//    open: `lib/better_sqlite3.node` is dlopen'd into the server's own address
//    space, so swapping it is native code execution with all of the server's
//    privileges, without touching the file that was being checked.
describe('verifyPayloadSignature — exe AND addon', () => {
  const kp = generateKeypair();
  const signBytes = (content: Buffer): string =>
    sign({ content, secretSeed: kp.secretSeed, keyId: kp.keyId, trustedComment: 'test' });

  /** A volume with a validly-signed exe, plus whatever the case needs. */
  const volume = (): { bin: string; addon: string } => {
    const d = mkdtempSync(join(tmpdir(), 'launcher-payload-'));
    const bin = join(d, 'recued');
    const body = Buffer.from('EXE BYTES');
    writeFileSync(bin, body);
    writeFileSync(`${bin}.minisig`, signBytes(body));
    return { bin, addon: addonPathFor(bin) };
  };
  const putAddon = (addon: string, body: Buffer, sig?: string): void => {
    mkdirSync(dirname(addon), { recursive: true });
    writeFileSync(addon, body);
    if (sig !== undefined) writeFileSync(`${addon}.minisig`, sig);
  };

  it('accepts a volume with NO addon — a pre-sidecar install must still boot', () => {
    // Refusing here would brick every docker-thin install created before the
    // sidecar existed, on the very upgrade meant to fix them.
    const { bin, addon } = volume();
    expect(verifyPayloadSignature(bin, addon, kp.publicKeyText)).toBe(true);
  });

  it('accepts a validly-signed addon', () => {
    const { bin, addon } = volume();
    const body = Buffer.from('ADDON BYTES');
    putAddon(addon, body, signBytes(body));
    expect(verifyPayloadSignature(bin, addon, kp.publicKeyText)).toBe(true);
  });

  it('⛔ rejects a TAMPERED addon even though the exe verifies', () => {
    const { bin, addon } = volume();
    putAddon(addon, Buffer.from('EVIL NATIVE CODE'), signBytes(Buffer.from('ADDON BYTES')));
    expect(verifyBinarySignature(bin, kp.publicKeyText)).toBe(true); // exe is fine…
    expect(verifyPayloadSignature(bin, addon, kp.publicKeyText)).toBe(false); // …payload is not
  });

  it('⛔ rejects an addon with no signature at all', () => {
    // "Present but unsigned" is the shape an attacker who cannot sign produces.
    const { bin, addon } = volume();
    putAddon(addon, Buffer.from('UNSIGNED ADDON'));
    expect(verifyPayloadSignature(bin, addon, kp.publicKeyText)).toBe(false);
  });

  it('bypasses everything with no pinned key (pre-GA), like the exe check', () => {
    const { bin, addon } = volume();
    putAddon(addon, Buffer.from('whatever'));
    expect(verifyPayloadSignature(bin, addon, '')).toBe(true);
  });

  it('⛔ pairs the OLD exe with the OLD addon, not the live one', () => {
    // `dirname('<bin>/recued.old')` is still `<bin>`, so DERIVING the addon path
    // from the old exe yields the LIVE addon — and the rollback candidate would
    // be pronounced verified against the very addon it is rolling away from.
    // The caller passes `<addon>.old` explicitly; this pins that it matters.
    const { bin, addon } = volume();
    const old = `${bin}.old`;
    const oldBody = Buffer.from('OLD EXE');
    writeFileSync(old, oldBody);
    writeFileSync(`${old}.minisig`, signBytes(oldBody));
    // Live addon: valid. Old addon: tampered.
    const liveBody = Buffer.from('LIVE ADDON');
    putAddon(addon, liveBody, signBytes(liveBody));
    putAddon(`${addon}.old`, Buffer.from('CORRUPT OLD ADDON'), signBytes(Buffer.from('OLD ADDON')));

    expect(verifyPayloadSignature(old, `${addon}.old`, kp.publicKeyText)).toBe(false);
    // Derived-from-the-old-exe would have consulted the LIVE addon and passed:
    expect(verifyPayloadSignature(old, addonPathFor(old), kp.publicKeyText)).toBe(true);
  });
});

describe('⛔ launcher/server addon-path lockstep', () => {
  it('addonPathFor agrees with what the server actually swaps', async () => {
    // The launcher duplicates this path (I-9: it imports nothing from the server
    // bundle). Two independent derivations of one on-disk location — drift means
    // the launcher seeds, verifies and reverts a file the binary never loads,
    // and nothing else would notice.
    const { buildApplyOrchestratorDeps } = await import('../update/release-config.js');
    const binDir = mkdtempSync(join(tmpdir(), 'launcher-lockstep-'));
    const binaryPath = join(binDir, 'recued');
    const deps = buildApplyOrchestratorDeps({
      db: new Database(':memory:'),
      releaseCheckDeps: { trustedPubkey: 'PUB' } as never,
      requestRestart: () => {},
      isQuiesced: () => true,
      env: { RECUED_DISTRIBUTION_CHANNEL: 'binary' },
      binaryPath,
      dataDir: binDir,
    });
    const serverLivePath = deps!.ports.stagedLibPath!.replace(/\.staged$/, '');
    expect(addonPathFor(binaryPath)).toBe(serverLivePath);
    expect(serverLivePath.endsWith(ADDON_RELATIVE_PATH)).toBe(true);
  });
});

describe('revertToOld', () => {
  it('moves old binary + sig sidecar into the current path', () => {
    const d = mkdtempSync(join(tmpdir(), 'launcher-rev-'));
    const cur = join(d, 'recued');
    const old = join(d, 'recued.old');
    writeFileSync(cur, 'NEW');
    writeFileSync(`${cur}.minisig`, 'newsig');
    writeFileSync(old, 'OLD');
    writeFileSync(`${old}.minisig`, 'oldsig');
    revertToOld(cur, old);
    expect(readFileSync(cur, 'utf8')).toBe('OLD');
    expect(readFileSync(`${cur}.minisig`, 'utf8')).toBe('oldsig');
    expect(existsSync(old)).toBe(false);
  });

  it('⛔ reverts the ADDON with the exe, sig and all', () => {
    // Restoring only the executable pairs it with the addon of the release being
    // abandoned — the same N-API ABI mismatch that fails at the first database
    // open. The revert would "succeed" and the container still could not serve.
    const d = mkdtempSync(join(tmpdir(), 'launcher-rev-addon-'));
    const cur = join(d, 'recued');
    const old = `${cur}.old`;
    const addon = addonPathFor(cur);
    mkdirSync(dirname(addon), { recursive: true });
    writeFileSync(cur, 'NEW');
    writeFileSync(`${cur}.minisig`, 'newsig');
    writeFileSync(old, 'OLD');
    writeFileSync(`${old}.minisig`, 'oldsig');
    writeFileSync(addon, 'NEW-ADDON');
    writeFileSync(`${addon}.minisig`, 'new-addon-sig');
    writeFileSync(`${addon}.old`, 'OLD-ADDON');
    writeFileSync(`${addon}.old.minisig`, 'old-addon-sig');

    revertToOld(cur, old);

    expect(readFileSync(addon, 'utf8')).toBe('OLD-ADDON');
    expect(readFileSync(`${addon}.minisig`, 'utf8')).toBe('old-addon-sig');
    expect(existsSync(`${addon}.old`)).toBe(false);
  });

  it('leaves the live addon alone on a pre-sidecar volume (no .old addon)', () => {
    const d = mkdtempSync(join(tmpdir(), 'launcher-rev-nolib-'));
    const cur = join(d, 'recued');
    const old = `${cur}.old`;
    writeFileSync(cur, 'NEW');
    writeFileSync(old, 'OLD');
    expect(() => revertToOld(cur, old)).not.toThrow();
    expect(readFileSync(cur, 'utf8')).toBe('OLD');
  });
});

describe('seedIfAbsent', () => {
  it('copies the baked binary + sig onto an empty volume, and is a no-op when present', () => {
    const seedDir = mkdtempSync(join(tmpdir(), 'launcher-seed-src-'));
    const volDir = mkdtempSync(join(tmpdir(), 'launcher-seed-vol-'));
    const seed = join(seedDir, 'recued');
    writeFileSync(seed, 'SEED');
    writeFileSync(`${seed}.minisig`, 'seedsig');
    const cur = join(volDir, 'recued');

    expect(seedIfAbsent(cur, volDir, seed)).toBe(true);
    expect(readFileSync(cur, 'utf8')).toBe('SEED');
    expect(readFileSync(`${cur}.minisig`, 'utf8')).toBe('seedsig');

    // already-present binary (possibly self-updated past the baked seed) wins
    writeFileSync(cur, 'UPDATED');
    expect(seedIfAbsent(cur, volDir, seed)).toBe(false);
    expect(readFileSync(cur, 'utf8')).toBe('UPDATED');
  });

  it('is a no-op with no seed configured', () => {
    const volDir = mkdtempSync(join(tmpdir(), 'launcher-seed-none-'));
    expect(seedIfAbsent(join(volDir, 'recued'), volDir, undefined)).toBe(false);
  });

  it('⛔ seeds the ADDON beside the exe, sig and all', () => {
    // First boot is the worst place to get this wrong: there is no `.old` to
    // revert to, so an exe seeded without its addon just burns the three
    // boot-failure attempts and halts.
    const seedDir = mkdtempSync(join(tmpdir(), 'launcher-seed-addon-src-'));
    const volDir = mkdtempSync(join(tmpdir(), 'launcher-seed-addon-vol-'));
    const seed = join(seedDir, 'recued');
    const seedAddon = join(seedDir, ...ADDON_RELATIVE_PATH.split('/'));
    writeFileSync(seed, 'SEED');
    writeFileSync(`${seed}.minisig`, 'seedsig');
    mkdirSync(dirname(seedAddon), { recursive: true });
    writeFileSync(seedAddon, 'SEED-ADDON');
    writeFileSync(`${seedAddon}.minisig`, 'seed-addon-sig');
    const cur = join(volDir, 'recued');

    expect(seedIfAbsent(cur, volDir, seed)).toBe(true);

    const addon = addonPathFor(cur);
    expect(readFileSync(addon, 'utf8')).toBe('SEED-ADDON');
    expect(readFileSync(`${addon}.minisig`, 'utf8')).toBe('seed-addon-sig');
  });

  it('still seeds when the image bakes no addon (pre-sidecar image)', () => {
    const seedDir = mkdtempSync(join(tmpdir(), 'launcher-seed-noaddon-src-'));
    const volDir = mkdtempSync(join(tmpdir(), 'launcher-seed-noaddon-vol-'));
    const seed = join(seedDir, 'recued');
    writeFileSync(seed, 'SEED');
    const cur = join(volDir, 'recued');
    expect(seedIfAbsent(cur, volDir, seed)).toBe(true);
    expect(existsSync(addonPathFor(cur))).toBe(false);
  });
});

describe('recordLedgerRevert', () => {
  it('appends an apply_reverted terminal for the in-flight apply (un-wedges the server lock)', async () => {
    const { createUpdateLedger } = await import('../update/update-ledger.js');
    const d = mkdtempSync(join(tmpdir(), 'launcher-ledger-'));
    const p = join(d, 'updates.log');
    const ledger = createUpdateLedger(p);
    ledger.append({
      id: 'a', kind: 'apply_started', at: 1, from_version: '1.3.0', to_version: '1.4.2',
      channel: 'stable', trigger: 'auto', release_identity: 'stable:1.4.2', migration: false,
    });
    ledger.append({
      id: 'b', kind: 'apply_staged', at: 2, from_version: '1.3.0', to_version: '1.4.2',
      channel: 'stable', trigger: 'auto', release_identity: 'stable:1.4.2', migration: false,
    });

    recordLedgerRevert(p, 'boot health failed', 99);

    const all = createUpdateLedger(p).readAll();
    const terminal = all.find((e) => e.kind === 'apply_reverted');
    expect(terminal).toBeDefined();
    expect(terminal!.release_identity).toBe('stable:1.4.2');
    expect(terminal!.trigger).toBe('revert');
  });

  it('is a no-op when nothing is in flight (server already recorded the terminal)', async () => {
    const { createUpdateLedger } = await import('../update/update-ledger.js');
    const d = mkdtempSync(join(tmpdir(), 'launcher-ledger2-'));
    const p = join(d, 'updates.log');
    const ledger = createUpdateLedger(p);
    ledger.append({
      id: 'a', kind: 'apply_started', at: 1, from_version: '1.3.0', to_version: '1.4.2',
      channel: 'stable', trigger: 'auto', release_identity: 'stable:1.4.2', migration: false,
    });
    ledger.append({
      id: 'b', kind: 'apply_committed', at: 2, from_version: '1.3.0', to_version: '1.4.2',
      channel: 'stable', trigger: 'auto', release_identity: 'stable:1.4.2', migration: false,
    });
    recordLedgerRevert(p, 'x', 99);
    expect(createUpdateLedger(p).readAll().filter((e) => e.kind === 'apply_reverted')).toHaveLength(0);
  });
});

describe('runLauncher loop', () => {
  const writeBin = (dir: string, name: string, content = 'bin') => writeFileSync(join(dir, name), content);

  it('execs the current binary and returns 0 on a clean exit', async () => {
    const d = mkdtempSync(join(tmpdir(), 'launcher-run-'));
    writeBin(d, 'recued');
    const runBinary = vi.fn(async (_p: string, _a: string[], _e: NodeJS.ProcessEnv) => 0);
    const code = await runLauncher({ binDir: d, pubkey: '', args: ['--db', 'x'], runBinary, crashBackoffMs: 0, log: () => {} });
    expect(code).toBe(0);
    expect(runBinary).toHaveBeenCalledOnce();
    // child env carries the launcher version + docker-thin supervisor
    const env = runBinary.mock.calls[0]![2];
    expect(env.RECUED_LAUNCHER_VERSION).toBe(String(LAUNCHER_VERSION));
    expect(env.RECUED_SUPERVISOR_MODE).toBe('docker-thin');
  });

  it('re-execs on restart-intent (exit 3) without counting a failure', async () => {
    const d = mkdtempSync(join(tmpdir(), 'launcher-run2-'));
    writeBin(d, 'recued');
    let n = 0;
    const runBinary = vi.fn(async () => (n++ === 0 ? 3 : 0));
    const code = await runLauncher({ binDir: d, pubkey: '', args: [], runBinary, crashBackoffMs: 0, log: () => {} });
    expect(code).toBe(0);
    expect(runBinary).toHaveBeenCalledTimes(2);
    expect(readFailureCount(join(d, 'boot-failures.json'))).toBe(0);
  });

  it('counts crashes then auto-reverts to old at the threshold', async () => {
    const d = mkdtempSync(join(tmpdir(), 'launcher-run3-'));
    writeBin(d, 'recued', 'NEW');
    writeBin(d, 'recued.old', 'OLD');
    // crash on the NEW binary every time; once reverted to OLD, exit clean.
    const runBinary = vi.fn(async (binPath: string) =>
      readFileSync(binPath, 'utf8') === 'NEW' ? 1 : 0,
    );
    const code = await runLauncher({ binDir: d, pubkey: '', args: [], runBinary, crashBackoffMs: 0, log: () => {} });
    expect(code).toBe(0);
    // 3 crashes of NEW (count hits threshold) → revert → OLD exits clean
    expect(readFileSync(join(d, 'recued'), 'utf8')).toBe('OLD');
    expect(runBinary).toHaveBeenCalledTimes(BOOT_FAILURE_THRESHOLD + 1);
  });

  it('halts (exit 0) on lock-held (exit 4)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'launcher-run4-'));
    writeBin(d, 'recued');
    const runBinary = vi.fn(async () => 4);
    const code = await runLauncher({ binDir: d, pubkey: '', args: [], runBinary, crashBackoffMs: 0, log: () => {} });
    expect(code).toBe(0);
    expect(runBinary).toHaveBeenCalledOnce();
  });

  it('refuses (exit 1) when no binary is present', async () => {
    const d = mkdtempSync(join(tmpdir(), 'launcher-run5-'));
    const runBinary = vi.fn(async () => 0);
    const code = await runLauncher({ binDir: d, pubkey: '', args: [], runBinary, crashBackoffMs: 0, log: () => {} });
    expect(code).toBe(1);
    expect(runBinary).not.toHaveBeenCalled();
  });
});

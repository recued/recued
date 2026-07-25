import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

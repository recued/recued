/** `recued status` says why the last start failed.
 *
 *  ⛔ WHY THIS EXISTS. A server started by autostart has no terminal (the
 *  macOS LaunchAgent sets no `StandardErrorPath`; systemd keeps it in a
 *  journal), so a start that fails — a passphrase-sealed key file whose
 *  service lacks `RECUED_IDENTITY_PASSPHRASE` is the common one — left `recued
 *  status` answering only "stopped" (raised by the owner, 2026-10-07).
 *
 *  The unit half drives the record directly; the end-to-end half runs the real
 *  CLI: `serve` on a passphrase-sealed realm with no passphrase, then
 *  `status` on the same realm. */

import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  LAST_START_ERROR_FILE,
  clearLastStartError,
  lastStartErrorLines,
  lastStartErrorPath,
  markStartedListening,
  readLastStartError,
  recordLastStartError,
  resetLastStartErrorForTests,
} from '../cli/last-start-error.js';
import { createFileServerKeyStore, flushFileServerKeyStore } from '../keys/file-store.js';
import { ensureServerIdentityKeys } from '../keys/index.js';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const binPath = join(repoRoot, 'backend/server/src/bin.ts');
const serverTsconfigPath = join(repoRoot, 'backend/server/tsconfig.json');

let dir: string | undefined;
const makeTmp = (): string => (dir = mkdtempSync(join(tmpdir(), 'recued-last-start-')));

afterEach(() => {
  resetLastStartErrorForTests();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('the last start error — the record', () => {
  it('is kept beside the database, read back, and said with its age and version', () => {
    const dbPath = join(makeTmp(), 'recued-server.db');
    recordLastStartError(dbPath, { at: 1_000, version: '26.10.7', message: 'boom' });
    expect(lastStartErrorPath(dbPath)).toBe(join(dir!, LAST_START_ERROR_FILE));
    const read = readLastStartError(dbPath);
    expect(read).toEqual({ at: 1_000, version: '26.10.7', message: 'boom' });
    expect(lastStartErrorLines(read!, 1_000 + 3 * 60_000)).toEqual([
      '  Its last start failed (3 min ago, 26.10.7):',
      '    boom',
    ]);
  });

  it('is cleared once a start listens — and a later throw is not recorded as a failed start', () => {
    const dbPath = join(makeTmp(), 'recued-server.db');
    recordLastStartError(dbPath, { at: 1, version: 'v', message: 'earlier failure' });
    markStartedListening(dbPath);
    expect(readLastStartError(dbPath)).toBeNull();
    recordLastStartError(dbPath, { at: 2, version: 'v', message: 'a crash while running' });
    expect(existsSync(lastStartErrorPath(dbPath))).toBe(false);
  });

  it('is cleared when a new attempt begins — and that attempt can still record its own', () => {
    const dbPath = join(makeTmp(), 'recued-server.db');
    recordLastStartError(dbPath, { at: 1, version: 'v', message: 'the attempt before' });
    clearLastStartError(dbPath);
    expect(readLastStartError(dbPath)).toBeNull();
    recordLastStartError(dbPath, { at: 2, version: 'v', message: 'this attempt' });
    expect(readLastStartError(dbPath)?.message).toBe('this attempt');
  });

  it('reads a malformed record as none', () => {
    const dbPath = join(makeTmp(), 'recued-server.db');
    writeFileSync(lastStartErrorPath(dbPath), '{"at":"yesterday"}');
    expect(readLastStartError(dbPath)).toBeNull();
  });
});

const freePort = async (): Promise<number> => {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
};

// ⛔ THESE BOOTS OWN THEIR INSTALL, OR THEY FIGHT THE REST OF THE SUITE. On the
// default (`binary`) channel `serve` first claims the host-wide update lease,
// keyed on `process.execPath` — under tsx, the Node runtime every test shares —
// and a second concurrent boot exits 4 ("an update is in progress"). These
// boots made `bin-router.test.ts`'s serve test red in a full run (efc76a52e).
// ⚠ The `source` channel was not enough: it stops a boot CLAIMING the lease, not
// READING it. `serve` checks the lease again once the realm is claimed, on every
// channel, and this boot exited 4 while bin-router's held it (2 of 2 runs,
// 2026-10-09). On `docker-thin` the binary is `RECUED_BIN_DIR/recued`, so a bin
// dir in the realm makes the lease this install's own, as `d-261-boot.test.ts`
// does. What is under test here — the start error and `status` — does not
// depend on the channel.
// ⚠ Since `updateLeasePathForInstall` (2026-10-09) an unpackaged boot on the default
// channel neither claims nor reads that lease (`unpackaged-update-lease.test.ts`);
// the bin dir stays because a boot that owns its install is the safe default.
const runBin = (realm: string, args: string[], env: Record<string, string | undefined>) => {
  const binDir = join(realm, 'bin');
  mkdirSync(binDir, { recursive: true });
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', binPath, ...args],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: serverTsconfigPath,
        RECUED_DISTRIBUTION_CHANNEL: 'docker-thin',
        RECUED_BIN_DIR: binDir,
        ...env,
      },
      timeout: 60_000,
    },
  );
};

describe('the last start error — end to end through the real CLI', () => {
  it('a passphrase-sealed realm started without its passphrase: serve fails, and status says why', async () => {
    const realm = makeTmp();
    const dbPath = join(realm, 'recued-server.db');
    // A key file sealed with a passphrase, as a first boot with
    // RECUED_IDENTITY_PASSPHRASE set leaves it.
    const store = await createFileServerKeyStore({
      filePath: join(realm, 'recued-server-identity.json'),
      passphrase: 'correct-horse-battery-staple',
      argon2_params: { t: 1, m: 1024, p: 1 },
    });
    ensureServerIdentityKeys(store);
    await flushFileServerKeyStore(store);
    const port = String(await freePort());
    const noPassphrase = { RECUED_IDENTITY_PASSPHRASE: undefined };

    const served = runBin(realm, ['serve', '--db', dbPath, '--port', port], noPassphrase);
    expect(served.status, served.stderr).toBe(1);
    expect(served.stderr).toMatch(/sealed with a passphrase, and RECUED_IDENTITY_PASSPHRASE is not set/);
    expect(readLastStartError(dbPath)?.message).toMatch(/RECUED_IDENTITY_PASSPHRASE is not set/);

    const status = runBin(realm, ['status', '--db', dbPath, '--port', port], noPassphrase);
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain('Status: stopped');
    expect(status.stdout).toMatch(/Its last start failed \(just now, /);
    expect(status.stdout).toMatch(/RECUED_IDENTITY_PASSPHRASE is not set/);
  }, 120_000);

  it('a later attempt that fails WITHOUT an error leaves no stale explanation behind', async () => {
    // ⛔ Without the clear at start, status would go on blaming the passphrase
    // after the owner fixed it and the server died of something else.
    const realm = makeTmp();
    const dbPath = join(realm, 'recued-server.db');
    recordLastStartError(dbPath, { at: Date.now() - 60_000, version: 'v', message: 'RECUED_IDENTITY_PASSPHRASE is not set' });
    const port = String(await freePort());

    // `--pair-code-ttl` is refused with an exit code, not a throw.
    const served = runBin(realm, ['serve', '--db', dbPath, '--port', port, '--pair-code-ttl', 'bogus'], {});
    expect(served.status, served.stderr).toBe(1);

    const status = runBin(realm, ['status', '--db', dbPath, '--port', port], {});
    expect(status.stdout).toContain('Status: stopped');
    expect(status.stdout).not.toMatch(/last start failed/);
  }, 120_000);

  it('an autostart whose realm database cannot be opened: status says so', async () => {
    const realm = makeTmp();
    const dbPath = join(realm, 'recued-server.db');
    writeFileSync(dbPath, 'this is not a sqlite database at all, it is garbage');
    const port = String(await freePort());

    const served = runBin(realm, ['serve', '--db', dbPath, '--port', port, '--require-enrolled'], {});
    expect(served.status, served.stderr).toBe(1);
    expect(served.stderr).toContain('cannot open the realm database');

    const status = runBin(realm, ['status', '--db', dbPath, '--port', port], {});
    expect(status.stdout).toMatch(/Its last start failed \(just now, /);
    expect(status.stdout).toContain(`cannot open the realm database ${dbPath}`);
  }, 120_000);
});

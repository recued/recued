// The update lease of an install that has no executable of its own.
//
// ⛔ THE DEFAULT CHANNEL KEYED AN UNPACKAGED INSTALL'S LEASE ON THE OWNER'S NODE.
// `RECUED_DISTRIBUTION_CHANNEL` defaults to `binary`, and on `binary` the lease is
// `dirname(process.execPath)/recued-update.lock`. For a source checkout, an npm install or the
// Homebrew formula that is the folder holding Node: under a system Node, a root-owned folder
// the server cannot write as its own user, so the boot died on a bare EACCES before its banner;
// and one file for every unpackaged install on that Node, so one install's lease stopped
// another from starting. Nothing updates such an install in place — the apply builder and the
// CLI verbs refuse it — so its boot neither takes nor reads a lease.
//
// The boots run under a CLONE of this Node in a folder the test owns: the only way to put
// something beside a runtime's `execPath` without touching the machine's real Node.

import { spawn } from 'node:child_process';
import {
  chmodSync,
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { updateLeasePathForInstall } from '../update/install-paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const binPath = join(repoRoot, 'backend/server/src/bin.ts');
const serverTsconfigPath = join(repoRoot, 'backend/server/tsconfig.json');

let tmp: string | undefined;
let readOnlyDir: string | undefined;

afterEach(() => {
  // A read-only folder cannot be emptied, so it is made writable before the removal.
  if (readOnlyDir) chmodSync(readOnlyDir, 0o755);
  readOnlyDir = undefined;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

const makeTmp = (): string => {
  tmp = mkdtempSync(join(tmpdir(), 'recued-unpackaged-lease-'));
  return tmp;
};

/** This Node, cloned into `dir`. `COPYFILE_FICLONE` shares the blocks where the filesystem
 *  can (APFS, btrfs, XFS: measured 0.08 s for a 121 MB Node) and copies where it cannot. */
const cloneNodeInto = (dir: string): string => {
  mkdirSync(dir, { recursive: true });
  const node = join(dir, 'node');
  copyFileSync(process.execPath, node, constants.COPYFILE_FICLONE);
  chmodSync(node, 0o755);
  return node;
};

const stopGroup = (pid: number | undefined, signal: NodeJS.Signals): void => {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
};

/** `serve` under `node` on the DEFAULT channel, stopped at its banner. */
const bootOnDefaultChannel = (node: string, dbPath: string): Promise<{
  booted: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}> => new Promise((done) => {
  const env: NodeJS.ProcessEnv = { ...process.env, TSX_TSCONFIG_PATH: serverTsconfigPath };
  // The default channel is the case under test, so nothing may name another one.
  delete env.RECUED_DISTRIBUTION_CHANNEL;
  delete env.RECUED_BIN_DIR;
  delete env.RECUED_SUPERVISOR_MODE;
  const child = spawn(node, ['--import', 'tsx', binPath, 'serve', '--db', dbPath, '--port', '0'], {
    cwd: repoRoot,
    detached: true,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let booted = false;
  // The three bounds of `bin-router.test.ts`'s banner boot, in its order: a cold boot under
  // tsx during a sweep is slow, and a hung one must still fail.
  const timeout = setTimeout(() => stopGroup(child.pid, 'SIGTERM'), 100_000);
  const forceStop = setTimeout(() => stopGroup(child.pid, 'SIGKILL'), 120_000);
  forceStop.unref();
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    if (!booted && stdout.includes('Recued Server') && stdout.includes('[listener] path listener bound')) {
      booted = true;
      stopGroup(child.pid, 'SIGTERM');
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  child.once('exit', (code) => {
    clearTimeout(timeout);
    clearTimeout(forceStop);
    done({ booted, code, stdout, stderr });
  });
});

const why = (r: { code: number | null; stderr: string }): string =>
  `exit ${String(r.code)}\n${r.stderr.slice(-2_000)}`;

describe('updateLeasePathForInstall', () => {
  const packaged = (): boolean => true;
  const unpackaged = (): boolean => false;
  const besideExecPath = join(dirname(process.execPath), 'recued-update.lock');

  it('has no lease for the binary channel run unpackaged, defaulted or named', () => {
    expect(updateLeasePathForInstall({}, unpackaged)).toBeNull();
    expect(updateLeasePathForInstall({ RECUED_DISTRIBUTION_CHANNEL: 'binary' }, unpackaged)).toBeNull();
  });

  it('keys the packaged binary on its own folder', () => {
    expect(updateLeasePathForInstall({}, packaged)).toBe(besideExecPath);
  });

  it('keys docker-thin on its bin dir: it runs under Node by design', () => {
    const env = { RECUED_DISTRIBUTION_CHANNEL: 'docker-thin', RECUED_BIN_DIR: join('/data', 'bin') };
    expect(updateLeasePathForInstall(env, unpackaged)).toBe(join('/data', 'bin', 'recued-update.lock'));
  });

  it('leaves the delegated channels where they were', () => {
    // Neither self-applies, so no server takes this lease; a CLI verb still claims it as its
    // database-admission gate, and a booting server still reads it.
    for (const channel of ['docker-baked', 'source']) {
      expect(updateLeasePathForInstall({ RECUED_DISTRIBUTION_CHANNEL: channel }, unpackaged))
        .toBe(besideExecPath);
    }
  });
});

describe('an unpackaged server on the default channel keeps no lease beside its Node', () => {
  it('boots when that Node sits in a folder it cannot write, and writes nothing there', async () => {
    const dir = makeTmp();
    const nodeDir = join(dir, 'node-bin');
    const node = cloneNodeInto(nodeDir);
    chmodSync(nodeDir, 0o555);
    readOnlyDir = nodeDir;

    const result = await bootOnDefaultChannel(node, join(dir, 'recued.db'));

    expect(result.stderr).not.toMatch(/EACCES/);
    expect(result.booted, why(result)).toBe(true);
    // ⚠ The listing as well as the boot: to root a 0555 folder is writable, so there only
    // this sees a lease taken.
    expect(readdirSync(nodeDir)).toEqual(['node']);
  }, 180_000);

  it("does not wait on another install's live lease beside the same Node", async () => {
    const dir = makeTmp();
    const nodeDir = join(dir, 'node-bin');
    const node = cloneNodeInto(nodeDir);
    // A LIVE holder — this test worker. A dead one reads as nobody anyway and would prove nothing.
    const foreign = { pid: process.pid, operation: 'apply', at: Date.now(), token: 'another-install' };
    const leasePath = join(nodeDir, 'recued-update.lock');
    writeFileSync(leasePath, JSON.stringify(foreign));

    const result = await bootOnDefaultChannel(node, join(dir, 'recued.db'));

    expect(`${result.stdout}${result.stderr}`).not.toMatch(/an update is in progress/);
    expect(result.booted, why(result)).toBe(true);
    expect(JSON.parse(readFileSync(leasePath, 'utf8'))).toEqual(foreign);
  }, 180_000);
});

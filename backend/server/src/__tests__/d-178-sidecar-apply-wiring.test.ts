/** D-178 S1 rev 2 item 4 — the native-sidecar apply wiring, COMPOSED.
 *
 *  `apply-orchestrator.test.ts` proves the orchestrator calls its ports, and
 *  `binary-apply-executor.test.ts` proves the executor moves files correctly.
 *  Neither proves the two are CONNECTED: the ports are closures built in
 *  `release-config.ts`, and a port that resolves the wrong path — or omits the
 *  sidecar argument entirely — satisfies both suites while shipping an exe that
 *  cannot open its database. This drives the real composed ports against real
 *  files on disk.
 *
 *  (The last D-178 wiring defect was exactly this shape: a publish gate that
 *  read correctly in isolation and left two channels with no task at all.)
 */

import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { buildApplyOrchestratorDeps } from '../update/release-config.js';
import type { ReleaseCheckDeps } from '../update/release-check.js';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'recued-sidecar-'));
  dirs.push(d);
  return d;
};

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const releaseCheckDeps = { trustedPubkey: 'PUB' } as unknown as ReleaseCheckDeps;

/** A composed apply-ports set over a real on-disk install layout:
 *    <bin>/recued
 *    <bin>/lib/better_sqlite3.node        (unless `seedAddon: false`) */
const install = (over: { env?: NodeJS.ProcessEnv; seedAddon?: boolean } = {}) => {
  const binDir = tmp();
  const dataDir = tmp();
  const binaryPath = join(binDir, 'recued');
  writeFileSync(binaryPath, 'OLD-EXE');
  const livePath = over.env?.RECUED_NATIVE_BINDING ?? join(binDir, 'lib', 'better_sqlite3.node');
  if (over.seedAddon !== false) {
    mkdirSync(dirname(livePath), { recursive: true });
    writeFileSync(livePath, 'OLD-ADDON');
  }
  const deps = buildApplyOrchestratorDeps({
    db: new Database(':memory:'),
    releaseCheckDeps,
    requestRestart: () => {},
    isQuiesced: () => true,
    env: { RECUED_DISTRIBUTION_CHANNEL: 'binary', ...over.env },
    binaryPath,
    dataDir,
  });
  if (!deps) throw new Error('expected apply deps on the binary channel');
  return { ports: deps.ports, binaryPath, livePath, binDir };
};

describe('D-178 item 4 — composed sidecar ports', () => {
  it('stages the addon beside where the SEA actually loads it', () => {
    const { ports, binDir } = install();
    // `open-database.ts` resolves `dirname(execPath)/lib/better_sqlite3.node`.
    // Staging anywhere else means the swap moves a file nothing ever reads.
    expect(ports.stagedLibPath).toBe(join(binDir, 'lib', 'better_sqlite3.node.staged'));
  });

  it('honours RECUED_NATIVE_BINDING — the same override open-database.ts reads', () => {
    // If the operator relocates the addon and the update swaps the DEFAULT path,
    // the new exe silently keeps loading the OLD addon: an ABI mismatch that
    // survives the update and looks like a healthy apply.
    const custom = join(tmp(), 'custom', 'sqlite.node');
    const { ports } = install({ env: { RECUED_NATIVE_BINDING: custom }, seedAddon: false });
    expect(ports.stagedLibPath).toBe(`${custom}.staged`);
  });

  it('⛔ preserveAndSwap(true) moves the exe AND the addon, preserving both', () => {
    const { ports, binaryPath, livePath } = install();
    writeFileSync(ports.stagedPath, 'NEW-EXE');
    writeFileSync(ports.stagedLibPath!, 'NEW-ADDON');

    ports.preserveAndSwap(true);

    expect(readFileSync(binaryPath, 'utf8')).toBe('NEW-EXE');
    expect(readFileSync(livePath, 'utf8')).toBe('NEW-ADDON');
    // Both halves of the rollback target survive — restoring only one would
    // reproduce the ABI mismatch the revert exists to escape.
    expect(readFileSync(`${binaryPath}.old`, 'utf8')).toBe('OLD-EXE');
    expect(readFileSync(`${livePath}.old`, 'utf8')).toBe('OLD-ADDON');
  });

  it('⛔ rollbackSwap restores the addon too — it always passes the paths', () => {
    // There is no apply context at rollback time (the addon being restored was
    // preserved by a PREVIOUS apply, possibly before a reboot). If the composed
    // port inferred "this install has a sidecar" from anything transient, the
    // restore would skip exactly when it matters.
    const { ports, binaryPath, livePath } = install();
    writeFileSync(ports.stagedPath, 'NEW-EXE');
    writeFileSync(ports.stagedLibPath!, 'NEW-ADDON');
    ports.preserveAndSwap(true);

    ports.rollbackSwap();

    expect(readFileSync(binaryPath, 'utf8')).toBe('OLD-EXE');
    expect(readFileSync(livePath, 'utf8')).toBe('OLD-ADDON');
  });

  it('journals the complete executable/addon rollback candidate before mutation', () => {
    const { ports, binaryPath, livePath } = install();
    writeFileSync(ports.stagedPath, 'NEW-EXE');
    writeFileSync(ports.stagedLibPath!, 'NEW-ADDON');
    ports.preserveAndSwap(true);

    ports.beginManualRollbackJournal!({
      operationId: 'manual-rollback',
      releaseIdentity: 'stable:2.0.0',
      fromVersion: '2.0.0',
      toVersion: '1.0.0',
      channel: 'stable',
      migration: false,
      restoredSnapshot: false,
    });

    expect(ports.inspectManualRollbackJournal!()?.journal).toMatchObject({
      previous_generation: [
        { path: `${binaryPath}.old`, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
        { path: `${binaryPath}.old.minisig`, sha256: null },
        { path: `${livePath}.old`, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
        { path: `${livePath}.old.minisig`, sha256: null },
      ],
    });
  });

  it('preserveAndSwap(false) leaves the live addon untouched', () => {
    // A release with no sidecar must not disturb the addon already installed —
    // and must not invent one from a leftover staged file.
    const { ports, binaryPath, livePath } = install();
    writeFileSync(ports.stagedPath, 'NEW-EXE');
    writeFileSync(ports.stagedLibPath!, 'STALE-FROM-AN-ABORTED-APPLY');

    ports.preserveAndSwap(false);

    expect(readFileSync(binaryPath, 'utf8')).toBe('NEW-EXE');
    expect(readFileSync(livePath, 'utf8')).toBe('OLD-ADDON');
  });

  it('discardStaged cleans the staged addon, not just the staged exe', () => {
    // A surviving staged addon is what makes the previous test's scenario real.
    const { ports } = install();
    writeFileSync(ports.stagedPath, 'x');
    writeFileSync(ports.stagedLibPath!, 'y');

    ports.discardStaged();

    expect(existsSync(ports.stagedPath)).toBe(false);
    expect(existsSync(ports.stagedLibPath!)).toBe(false);
  });

  it('the download port creates a missing lib/ dir before fetching', async () => {
    // An install predating the sidecar has no `lib/`. Without the mkdir the
    // download fails ENOENT, which the orchestrator reports as a DOWNLOAD
    // failure — sending the owner to debug the network for a local problem.
    const { ports, binDir } = install({ seedAddon: false });
    expect(existsSync(join(binDir, 'lib'))).toBe(false);

    // Connection-refused: the fetch is guaranteed to fail, so anything the dir
    // gained must have come from the mkdir that runs BEFORE it.
    await expect(ports.download('http://127.0.0.1:1/lib.node', ports.stagedLibPath!)).rejects.toThrow();

    expect(existsSync(join(binDir, 'lib'))).toBe(true);
  });
});

/** ⛔ THE PORT EXISTS ≠ THE PORT IS WIRED. `boot-reconcile` calls
 *  `ports.dropApplyAside?.()` optionally, so a composition root that forgot it
 *  leaves every behaviour test green and the install carrying a third generation
 *  forever — a whole extra binary on disk, and `recued.old` ambiguous to readers.
 *  Assert the real factory. */
describe('the real ports factory wires dropApplyAside', () => {
  it('drops the aside the swap parked, at the path the swap used', () => {
    const { ports, binaryPath } = install();
    const old = `${binaryPath}.old`;
    writeFileSync(old, 'R2');
    writeFileSync(`${old}.apply-aside`, 'R1');

    expect(ports.dropApplyAside, 'the port must be wired').toBeTypeOf('function');
    ports.dropApplyAside!();
    expect(existsSync(`${old}.apply-aside`), 'the parked generation is gone').toBe(false);
    expect(readFileSync(old, 'utf8'), 'and the real rollback target is untouched').toBe('R2');
  });

  it('wires the shared-target version probe and durable revert-journal ports', () => {
    const { ports } = install();
    expect(ports.installedVersion).toBeTypeOf('function');
    expect(ports.revertJournalMatchesCurrent).toBeTypeOf('function');
    expect(ports.dropRevertJournal).toBeTypeOf('function');
  });

  it('asks the executable occupying the real target path for its version', () => {
    const dataDir = tmp();
    const deps = buildApplyOrchestratorDeps({
      db: new Database(':memory:'),
      releaseCheckDeps,
      requestRestart: () => {},
      isQuiesced: () => true,
      env: { RECUED_DISTRIBUTION_CHANNEL: 'binary' },
      binaryPath: process.execPath,
      dataDir,
    });
    if (!deps) throw new Error('expected apply deps on the binary channel');
    expect(deps.ports.installedVersion?.()).toBe(process.version);
  });
});

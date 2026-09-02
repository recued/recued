/** ⛔⛔ WHO IS ALLOWED TO REPLACE THE DATABASE FILE — the ratchet for audit
 *  finding 1.
 *
 *  `restoreSnapshot` unlinks the -wal/-shm sidecars and renames a file over
 *  `dbPath`. That is safe ONLY with no handle open on it. Every caller violated
 *  that, and the failure is silent: the live handle keeps serving the unlinked
 *  inode and ACCEPTS WRITES that no later reader can see.
 *
 *  🔑 THE DANGER IS A NEW CALLER, not the ones that are fixed. Nothing about the
 *  function's shape tells you it has a precondition, and the fix is different in
 *  each of the three existing call sites — refuse in-process, close first, defer
 *  past the drain — so there is no single pattern to copy. A fourth caller
 *  written by someone who has not read this will look exactly like the three
 *  broken ones did.
 *
 *  So the SET of callers is pinned. Adding one is fine; adding one without
 *  saying how it satisfies the precondition is not. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '..');

/** Files allowed to CALL the restore, and how each one satisfies the
 *  precondition. A new entry needs a real answer in this column. */
const SANCTIONED = new Map<string, string>([
  ['bin.ts',
    'runs the retained manual-rollback recovery before importing serve-entry or opening SQLite'],
  ['update/binary-apply-executor.ts',
    'defines it, and `consumePendingSnapshotRestore` runs before any open'],
  ['update/apply-orchestrator.ts',
    'REFUSES when `holdsDatabaseOpen()` — fails closed on an unwired port'],
  ['update/boot-reconcile.ts',
    'DEFERS into the post-drain callback, after `close_db`'],
  ['update/release-config.ts',
    'builds the port; the call itself happens at one of the sites above'],
  ['update/realm-generation-snapshot.ts',
    'prepares a matching downgrade snapshot from composeStorageContext before the first database open'],
  ['update/supervised-boot-failure.ts',
    'runs in `recued.old` as a SEPARATE process after the payload has exited — '
    + 'nothing is open, and this verdict opens nothing itself'],
]);

const walk = (dir: string, acc: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      walk(p, acc);
    } else if (entry.endsWith('.ts')) acc.push(p);
  }
  return acc;
};

describe('callers of restoreSnapshot', () => {
  const callers = walk(SRC)
    .filter((f) => /(?:^|[^\w])restoreSnapshot\s*\(/.test(readFileSync(f, 'utf-8')))
    .map((f) => f.slice(SRC.length + 1))
    .sort();

  it('finds the call sites at all (the sweep itself works)', () => {
    // ⛔ A POSITIVE CONTROL. A rename or a regex slip would yield [], and every
    // assertion below would pass while guarding nothing.
    expect(callers.length).toBeGreaterThan(2);
    expect(callers).toContain('update/apply-orchestrator.ts');
  });

  it('every caller is sanctioned, with a stated reason it is safe', () => {
    const unsanctioned = callers.filter((f) => !SANCTIONED.has(f));
    expect(
      unsanctioned,
      unsanctioned.length > 0
        ? `${unsanctioned.join(', ')} calls restoreSnapshot, which REPLACES THE DATABASE `
          + `FILE and is unsafe with any handle open on it. Say how this caller guarantees `
          + `the database is closed, then add it to SANCTIONED with that reason.`
        : '',
    ).toEqual([]);
  });

  it('the orchestrator caller is still behind the holdsDatabaseOpen guard', () => {
    // The narrow behaviour the general ratchet cannot see: that the guard is
    // still THERE, not merely that the file is on the list.
    const src = readFileSync(join(SRC, 'update/apply-orchestrator.ts'), 'utf-8');
    expect(src).toMatch(/holdsDatabaseOpen\?\.\(\)\s*\?\?\s*true/);
  });
});

/** ⛔⛔ THE RECOVERY FOR A MISSING ADDON MUST NOT NEED THE ADDON. `open-database.ts`
 *  imports the native binding at MODULE INIT, so anything reachable from it dies
 *  on the missing file before a line of recovery could run — which is exactly the
 *  state an interrupted `rollbackSwap` leaves. `bin.ts` is the last point that
 *  still executes, and only because it statically imports none of that graph.
 *
 *  ⚠ ORDER, NOT PRESENCE. A call placed after the serve-entry import would look
 *  identical in a grep and never run when it matters. */
describe('the interrupted-swap recovery runs before the addon is loaded', () => {
  const binSrc = readFileSync(join(SRC, 'bin.ts'), 'utf-8');

  it('reconciles before serve-entry is imported', () => {
    const acquire = binSrc.indexOf('acquireUpdateLease({');
    const reconcile = binSrc.indexOf('reconcileInterruptedPairSwap(');
    const manualRecovery = binSrc.indexOf('recoverManualRollbackBeforeOpen({');
    const serveEntry = binSrc.indexOf("import('./serve-entry.js')");
    expect(acquire, 'bin.ts no longer takes the host lease before recovery').toBeGreaterThan(-1);
    expect(reconcile, 'bin.ts no longer reconciles an interrupted swap').toBeGreaterThan(-1);
    expect(manualRecovery, 'bin.ts no longer reconciles the database generation').toBeGreaterThan(-1);
    expect(serveEntry).toBeGreaterThan(-1);
    expect(acquire, 'the host lease must precede every recovery rename').toBeLessThan(reconcile);
    expect(reconcile, 'the recovery must precede the graph that loads the addon')
      .toBeLessThan(serveEntry);
    expect(reconcile, 'the binary pair decides which database generation wins')
      .toBeLessThan(manualRecovery);
    expect(manualRecovery, 'database recovery must precede the first SQLite import')
      .toBeLessThan(serveEntry);
  });

  it('holds the early lease until the realm has been claimed', () => {
    const lifecycleSrc = readFileSync(join(SRC, 'serve/compose-lifecycle.ts'), 'utf-8');
    const claim = lifecycleSrc.indexOf('lifecycle.lock.claim(');
    const release = lifecycleSrc.indexOf('releaseEarlyBootUpdateLease();');
    expect(claim).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(-1);
    expect(release, 'releasing before the realm claim re-opens the updater/boot race')
      .toBeGreaterThan(claim);
  });

  it('bin.ts still imports nothing that loads the native binding at init', () => {
    // The property that makes the placement work at all. `import type` is erased;
    // a VALUE import of any of these would pull the addon into bin.ts's own graph.
    const staticImports = [...binSrc.matchAll(/^import\s+(?!type)[^;]*?from\s+'([^']+)'/gm)]
      .map((m) => m[1]);
    expect(staticImports.length).toBeGreaterThan(2);
    for (const spec of staticImports) {
      expect(spec, `bin.ts statically imports ${spec}`).not.toMatch(/open-database|serve-entry|storage-context/);
    }
  });
});

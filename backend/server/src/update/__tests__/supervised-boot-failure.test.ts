import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createUpdateLedger, UPDATE_LEDGER_FILE } from '../update-ledger.js';
import { BOOT_FAILURE_COUNTER_FILE } from '../boot-failure-counter.js';
import {
  exitCodeFor,
  handleSupervisedBootFailure,
  recordLedgerRevert,
  REVERT_JOURNAL_SUFFIX,
  revertStagedRelease,
  SUPERVISED_GIVE_UP,
  SUPERVISED_RETRY_AFTER_BACKOFF,
  SUPERVISED_RETRY_NOW,
} from '../supervised-boot-failure.js';
import { realmSnapshotPath } from '../realm-generation-snapshot.js';

describe('supervised boot failure', () => {
  let dir: string;
  let binaryDir: string;
  let dataDir: string;

  const live = () => join(binaryDir, 'recued');
  const old = () => `${live()}.old`;
  const addon = () => join(binaryDir, 'lib', 'better_sqlite3.node');
  const counter = () => join(binaryDir, BOOT_FAILURE_COUNTER_FILE);
  const ledger = () => join(dataDir, UPDATE_LEDGER_FILE);
  const db = () => join(dataDir, 'recued-server.db');
  const snapshot = () => realmSnapshotPath(db());
  const webclient = () => join(dataDir, 'webclient');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'supervise-'));
    binaryDir = join(dir, 'bin');
    dataDir = join(dir, 'data');
    mkdirSync(join(binaryDir, 'lib'), { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(live(), 'BROKEN PAYLOAD', 'utf8');
    writeFileSync(addon(), 'NEW ADDON', 'utf8');
    // The realm the failed payload was serving. `migrated` stands for schema the
    // NEW release wrote; the snapshot below holds what was there before it.
    writeFileSync(db(), 'MIGRATED DB', 'utf8');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const withPrevious = (): void => {
    writeFileSync(old(), 'KNOWN-GOOD PAYLOAD', 'utf8');
    writeFileSync(`${addon()}.old`, 'OLD ADDON', 'utf8');
  };

  /** The pre-migration copy `runApply` takes before a migrating swap. */
  const withSnapshot = (): void => writeFileSync(snapshot(), 'PRE-MIGRATION DB', 'utf8');

  /** What a webclient-bearing release leaves behind: the new bundle live, the
   *  displaced generation at `<dir>.old` (`webclient-sync.ts`). */
  const withWebclient = (): void => {
    mkdirSync(webclient(), { recursive: true });
    writeFileSync(join(webclient(), 'index.html'), 'NEW UI', 'utf8');
    mkdirSync(`${webclient()}.old`, { recursive: true });
    writeFileSync(join(`${webclient()}.old`, 'index.html'), 'OLD UI', 'utf8');
  };

  /** ⛔⛔ THE WINDOWS SHAPE, WHICH NOTHING COVERED. `install.ps1` lays the
   *  executable down as `recued.exe`, so the staged pair is
   *  `recued.exe` / `recued.exe.old`. The revert took a DIRECTORY and appended a
   *  hard-coded `recued`, so on every Windows install it looked for `recued.old`,
   *  found nothing, answered "no previous binary" and left the NEW executable
   *  live — the rollback the CLI advertises could not run on the one platform
   *  whose installer has no supervisor to fall back on.
   *
   *  ⚠ THIS IS A PATH-SHAPE TEST, NOT A PLATFORM TEST. It runs on the host we
   *  have; what it pins is that the name comes from the CALLER rather than from a
   *  constant, which is the property that was wrong. The existing tests all pass
   *  `recued`, so every one of them passed while Windows was broken. */
  const failExe = (exitCode = 127, env: NodeJS.ProcessEnv = {}) =>
    handleSupervisedBootFailure({
      binaryPath: join(binaryDir, 'recued.exe'), dbPath: db(), exitCode, env, log: () => {},
    });

  const fail = (exitCode = 127, env: NodeJS.ProcessEnv = {}) =>
    handleSupervisedBootFailure({ binaryPath: join(binaryDir, 'recued'), dbPath: db(), exitCode, env, log: () => {} });

  /** What the ledger looks like after an apply staged a release and exited 3 for
   *  the restart — the only state in which an outer supervisor ever sees a
   *  failing payload. Without an apply in flight there is nothing to terminate,
   *  and `recordLedgerRevert` correctly writes nothing. */
  const withApplyInFlight = (migration = false): void => {
    writeFileSync(
      ledger(),
      `${JSON.stringify({
        id: 'a1',
        kind: 'apply_started',
        at: 1_000,
        from_version: '26.9.1',
        to_version: '26.9.2',
        channel: 'stable',
        trigger: 'manual',
        release_identity: 'stable:26.9.2',
        migration,
      })}\n`,
      'utf8',
    );
  };

  it('counts a failure below the threshold without touching the binary', () => {
    withPrevious();
    const outcome = fail();
    expect(outcome).toEqual({ action: 'counted', count: 1 });
    expect(exitCodeFor(outcome)).toBe(SUPERVISED_RETRY_AFTER_BACKOFF);
    expect(readFileSync(live(), 'utf8')).toBe('BROKEN PAYLOAD');
    expect(existsSync(ledger())).toBe(false);
  });

  it('reverts at the threshold and records a ledger terminal', () => {
    withPrevious();
    withApplyInFlight();   // a release is on trial — without this it must NOT revert
    expect(fail().action).toBe('counted');
    expect(fail().action).toBe('counted');
    const outcome = fail(127);

    expect(outcome).toEqual({ action: 'reverted', count: 3, restoredSnapshot: false });
    expect(exitCodeFor(outcome)).toBe(SUPERVISED_RETRY_NOW);
    // The known-good payload is live, and the addon reverted WITH it — an
    // executable paired with the abandoned release's addon fails at the first
    // database open, i.e. the revert "succeeds" and the server still cannot run.
    expect(readFileSync(live(), 'utf8')).toBe('KNOWN-GOOD PAYLOAD');
    expect(readFileSync(addon(), 'utf8')).toBe('OLD ADDON');
    // Non-migrating: the database is not a party to this revert.
    expect(readFileSync(db(), 'utf8')).toBe('MIGRATED DB');
    // One generation, consumed.
    expect(existsSync(old())).toBe(false);
    // Counter cleared, so the restored binary starts from zero.
    expect(existsSync(counter())).toBe(false);
  });

  it('⛔ reverts a Windows install, where the binary is recued.exe', () => {
    // The measured failure: with `recued.exe.old` present this answered
    // "refused: no previous binary (recued.old)" and left the new executable
    // live. Every other test in this file passes `recued`, so all of them stayed
    // green while the rollback was unavailable on Windows.
    const liveExe = join(binaryDir, 'recued.exe');
    writeFileSync(liveExe, 'NEW PAYLOAD', 'utf8');
    writeFileSync(`${liveExe}.old`, 'KNOWN-GOOD PAYLOAD', 'utf8');
    writeFileSync(`${addon()}.old`, 'OLD ADDON', 'utf8');
    withApplyInFlight();

    expect(failExe().action).toBe('counted');
    expect(failExe().action).toBe('counted');
    const outcome = failExe(127);

    expect(outcome).toEqual({ action: 'reverted', count: 3, restoredSnapshot: false });
    expect(readFileSync(liveExe, 'utf8')).toBe('KNOWN-GOOD PAYLOAD');
    expect(existsSync(`${liveExe}.old`)).toBe(false);
    // ⚠ AND IT DID NOT TOUCH THE EXTENSIONLESS `recued` the fixture also created.
    // The name came from the CALLER, which is the property that was wrong: the
    // old code would have reverted THIS file instead. (Asserting the file merely
    // does not exist would have been asserting the fixture — it is created in
    // `beforeEach` — which is how the first version of this line failed.)
    expect(readFileSync(live(), 'utf8')).toBe('BROKEN PAYLOAD');
  });

  // ⛔ Without this the restored binary boots, sees a staged release it is not
  // running, counts THAT as a failed boot and works toward an auto-revert whose
  // target this revert just consumed.
  it('the ledger terminal names the revert, so the restored binary is not left fighting a phantom apply', () => {
    withPrevious();
    withApplyInFlight();
    fail(); fail(); fail(126);

    const entries = readFileSync(ledger(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(entries).toHaveLength(2);
    const terminal = entries[1];
    expect(terminal.kind).toBe('apply_reverted');
    // It terminates THAT apply — a terminal for some other release would leave
    // the real one in flight and change nothing.
    expect(terminal.release_identity).toBe('stable:26.9.2');
    expect(String(terminal.detail)).toContain('never started');
    expect(String(terminal.detail)).toContain('126');
  });

  it('does not claim a revert when there is nothing to revert to', () => {
    withApplyInFlight();
    const outcome = fail(); const second = fail(); const third = fail();
    expect(outcome.action).toBe('counted');
    expect(second.action).toBe('counted');
    expect(third).toEqual({ action: 'no-rollback-target', count: 3 });
    expect(exitCodeFor(third)).toBe(SUPERVISED_GIVE_UP);
    // The in-flight apply is left in flight: no revert happened, so claiming a
    // terminal would release the lock on work that did not occur.
    expect(readFileSync(ledger(), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(readFileSync(live(), 'utf8')).toBe('BROKEN PAYLOAD');
  });

  // ⛔⛔ THE HAZARD: `recued.old` OUTLIVES THE UPDATE THAT CREATED IT. It is the
  // retained previous binary and stays on disk indefinitely after a successful,
  // COMMITTED update. So "there is something to revert to" is not remotely the
  // same question as "is a release on trial", and treating it as such means any
  // three consecutive non-zero exits — an unopenable realm, a permissions
  // change, a full disk — silently downgrade a binary that has been serving
  // happily for weeks and is not implicated in the failure at all.
  //
  // 🔑 The in-process counter never had this problem because it only counts a
  // release that is STAGED AND UNCOMMITTED. The supervisor exists to extend that
  // rule to a payload that cannot start — not to widen it.
  //
  // ⚠ Note `serve --require-enrolled` deliberately exits 0 on an unenrolled
  // realm, precisely so supervisors do not retry it, and an UNOPENABLE realm
  // deliberately exits non-zero so they do (`serve-entry.ts`). This is that
  // second, intentionally-retried case.
  it('never reverts when no apply is in flight, however many times the payload fails', () => {
    withPrevious();          // a stale `.old` from an update that committed long ago
    // No apply_started in the ledger: nothing is on trial.
    for (let i = 0; i < 6; i++) {
      const outcome = fail(1);
      expect(outcome.action).not.toBe('reverted');
    }
    expect(readFileSync(live(), 'utf8')).toBe('BROKEN PAYLOAD');
    expect(existsSync(old())).toBe(true);
  });

  it('reverts for the same failure once a release IS on trial', () => {
    // The discriminator is the ledger, and nothing else about the two cases
    // differs — same payload, same exit code, same `.old` on disk.
    withPrevious();
    withApplyInFlight();
    fail(1); fail(1);
    expect(fail(1).action).toBe('reverted');
  });

  // ⛔⛔ THE CASE THAT ONLY THIS SUPERVISOR SEES. A payload that starts, runs its
  // store DDL and dies before the listener is invisible to the in-process
  // boot-failure counter (which runs POST-listener), and the new binary skips its
  // own boot snapshot precisely because an apply is in flight. So if this revert
  // restores the binary alone, the old binary comes back on a MIGRATED database —
  // and the terminal it writes closes the operation, so the in-process auto-revert
  // that would have restored the snapshot can never run.
  it('restores the pre-migration snapshot with the binary when the failed release migrated', () => {
    withPrevious();
    withSnapshot();
    withApplyInFlight(true);
    fail(); fail();
    const outcome = fail(1);

    expect(outcome).toEqual({ action: 'reverted', count: 3, restoredSnapshot: true });
    expect(readFileSync(live(), 'utf8')).toBe('KNOWN-GOOD PAYLOAD');
    // The half that was missing: the old binary is not left on the new schema.
    expect(readFileSync(db(), 'utf8')).toBe('PRE-MIGRATION DB');
    const terminal = JSON.parse(readFileSync(ledger(), 'utf8').trim().split('\n')[1]);
    expect(terminal.kind).toBe('apply_reverted');
    expect(String(terminal.detail)).toContain('snapshot restored');
  });

  // ⛔⛔ FAIL CLOSED. Reverting the binary here manufactures the exact state the
  // snapshot exists to prevent — and it is WORSE than doing nothing, because the
  // swap consumes `recued.old` (so `decideRollback` then refuses for want of a
  // previous binary) and the terminal closes the apply. The recovery would be the
  // thing that made the install unrecoverable.
  it('refuses to revert a migrating release with no snapshot, and changes nothing', () => {
    withPrevious();
    withApplyInFlight(true);   // migrated…
    // …and no snapshot on disk.
    fail(); fail();
    const outcome = fail(1);

    expect(outcome).toEqual({
      action: 'revert-unsafe',
      count: 3,
      reason: 'release migrated the schema and no pre-migration snapshot exists',
    });
    expect(exitCodeFor(outcome)).toBe(SUPERVISED_GIVE_UP);
    // Every option the owner had is still on disk…
    expect(readFileSync(live(), 'utf8')).toBe('BROKEN PAYLOAD');
    expect(readFileSync(old(), 'utf8')).toBe('KNOWN-GOOD PAYLOAD');
    expect(readFileSync(db(), 'utf8')).toBe('MIGRATED DB');
    // …and the apply is still in flight, so nothing claims a recovery happened.
    expect(readFileSync(ledger(), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  // ⛔ The apply replaces the bundle and keeps the displaced one at
  // `<dir>.old` as its revert target (`webclient-sync.ts`). Reverting the server
  // without it leaves the NEWER UI talking to the OLDER binary — the pairing the
  // rpc rollback already reverts and this path did not.
  it('restores the webclient bundle the failed apply displaced', () => {
    withPrevious();
    withWebclient();
    withApplyInFlight();
    fail(); fail();
    expect(fail(1).action).toBe('reverted');

    expect(readFileSync(join(webclient(), 'index.html'), 'utf8')).toBe('OLD UI');
    expect(existsSync(`${webclient()}.old`)).toBe(false);
  });

  // The apply swapped the addon at `RECUED_NATIVE_BINDING`, so the revert has to
  // restore THAT file — the one the next boot resolves. Deriving the path a
  // second way (ignoring the override) restored a file nothing loads and left the
  // abandoned release's addon live.
  it('honours RECUED_NATIVE_BINDING when restoring the addon', () => {
    const overridden = join(dataDir, 'custom-binding.node');
    writeFileSync(overridden, 'NEW ADDON');
    writeFileSync(`${overridden}.old`, 'OLD ADDON');
    withPrevious();
    withApplyInFlight();
    const env = { RECUED_NATIVE_BINDING: overridden };
    fail(127, env); fail(127, env);
    expect(fail(1, env).action).toBe('reverted');

    expect(readFileSync(overridden, 'utf8')).toBe('OLD ADDON');
    // …and the conventional path was left alone, because it is not what loads.
    expect(readFileSync(addon(), 'utf8')).toBe('NEW ADDON');
  });

  it('keeps counting across separate supervisor invocations', () => {
    withPrevious();
    expect(fail().count).toBe(1);
    expect(fail().count).toBe(2);
    // The counter is a file precisely because each verdict is a fresh process.
    expect(JSON.parse(readFileSync(counter(), 'utf8')).count).toBe(2);
  });

  it('preserves the release identity the server keyed the counter with', () => {
    withPrevious();
    writeFileSync(counter(), JSON.stringify({ count: 1, release_identity: 'stable:26.9.9' }), 'utf8');
    fail();
    expect(JSON.parse(readFileSync(counter(), 'utf8'))).toEqual({
      count: 2,
      release_identity: 'stable:26.9.9',
    });
  });
});

/** The transaction both outer supervisors share. `handleSupervisedBootFailure`
 *  covers it for the binary channel's case (a release ON TRIAL); these are the
 *  cases only the `docker-thin` launcher reaches, where it reverts a current
 *  binary that is missing or fails its signature re-verify and NOTHING is in
 *  flight. */
describe('revertStagedRelease', () => {
  let dir: string;
  let binaryDir: string;
  let dataDir: string;
  const live = () => join(binaryDir, 'recued');
  const db = () => join(dataDir, 'recued-server.db');
  const snapshot = () => realmSnapshotPath(db());
  const ledger = () => join(dataDir, UPDATE_LEDGER_FILE);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'revert-'));
    binaryDir = join(dir, 'bin');
    dataDir = join(dir, 'data');
    mkdirSync(join(binaryDir, 'lib'), { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(live(), 'TAMPERED PAYLOAD', 'utf8');
    writeFileSync(`${live()}.old`, 'KNOWN-GOOD PAYLOAD', 'utf8');
    writeFileSync(db(), 'MIGRATED DB', 'utf8');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const revert = () => revertStagedRelease({
    binaryPath: join(binaryDir, 'recued'), dbPath: db(), reason: 'current binary failed signature verification', log: () => {},
  });

  /** ⛔ AN APPLY STILL IN FLIGHT — the supervised boot-failure case. The committed
   *  fixture below is the launcher's TAMPER case, where nothing is on trial and
   *  `recordLedgerRevert` correctly writes nothing; a test that asserted "no
   *  terminal was written" against it would pass however the code behaved. */
  const withInFlightMigratingRelease = (): void => {
    const l = createUpdateLedger(join(dataDir, UPDATE_LEDGER_FILE));
    for (const kind of ['apply_started', 'apply_staged'] as const) {
      l.append({
        id: kind, kind, at: 1, from_version: '26.9.1', to_version: '26.9.2',
        channel: 'stable', trigger: 'auto', release_identity: 'stable:26.9.2', migration: true,
      });
    }
  };

  const withCommittedMigratingRelease = (): void => {
    const l = createUpdateLedger(join(dataDir, UPDATE_LEDGER_FILE));
    for (const kind of ['apply_started', 'apply_staged', 'apply_committed'] as const) {
      l.append({
        id: kind, kind, at: 1, from_version: '26.9.1', to_version: '26.9.2',
        channel: 'stable', trigger: 'auto', release_identity: 'stable:26.9.2', migration: true,
      });
    }
  };

  // ⛔⛔ NOTHING IS IN FLIGHT, AND THE SCHEMA IS STILL MIGRATED. The launcher
  // reverts a binary that is missing or unverifiable — causes with no apply
  // attached — so reading only the IN-FLIGHT entry answers "did not migrate" and
  // swaps an old binary onto a migrated database. The release being downgraded is
  // the last COMMITTED one, which is the same derivation `runRollback` uses.
  it('restores the snapshot of the COMMITTED release when nothing is in flight', () => {
    withCommittedMigratingRelease();
    writeFileSync(snapshot(), 'PRE-MIGRATION DB', 'utf8');

    expect(revert()).toEqual({ status: 'reverted', restoredSnapshot: true });
    expect(readFileSync(live(), 'utf8')).toBe('KNOWN-GOOD PAYLOAD');
    expect(readFileSync(db(), 'utf8')).toBe('PRE-MIGRATION DB');
  });

  it('refuses that same case when the snapshot is gone', () => {
    withCommittedMigratingRelease();
    const outcome = revert();
    expect(outcome.status).toBe('refused');
    expect(readFileSync(live(), 'utf8')).toBe('TAMPERED PAYLOAD');
    expect(existsSync(`${live()}.old`)).toBe(true);
  });

  // ⛔⛔⛔ IT CLAIMS THE MUTEX NOW, rather than running inside the window it
  // protects. This path mutates the same set `recued update apply` does — binary,
  // addon, webclient, DATABASE — and took nothing, at the one moment nothing else
  // excludes it: the payload is dead, so the CLI's live-server check finds no
  // server and proceeds.
  it('refuses while another process holds the host-wide update lease', () => {
    withInFlightMigratingRelease();
    writeFileSync(snapshot(), 'PRE-MIGRATION DB', 'utf8');
    // ⚠ `process.ppid`: a LIVE pid that is not us. Our own would be re-entrant.
    writeFileSync(
      join(binaryDir, 'recued-update.lock'),
      JSON.stringify({ pid: process.ppid, operation: 'apply', at: 1, token: 't' }),
    );

    const outcome = revert();

    expect(outcome).toMatchObject({ status: 'busy' });
    // Nothing touched — not the binary, and above all not the database.
    expect(readFileSync(live(), 'utf8')).toBe('TAMPERED PAYLOAD');
    expect(readFileSync(db(), 'utf8')).toBe('MIGRATED DB');
  });

  it('takes and releases the lease around a successful revert', () => {
    withInFlightMigratingRelease();
    writeFileSync(snapshot(), 'PRE-MIGRATION DB', 'utf8');
    expect(revert()).toEqual({ status: 'reverted', restoredSnapshot: true });
    // ⛔ RELEASED, or the next actor on this host meets a lease whose holder is
    // gone — recoverable only by the stale-pid reclaim, which is a fallback and
    // not a plan.
    expect(existsSync(join(binaryDir, 'recued-update.lock'))).toBe(false);
  });

  // ⛔⛔⛔ THE HALF-DONE REVERT. The snapshot goes over the database first and the
  // binary swap comes last, so a swap that throws leaves the PREVIOUS database
  // under the FAILED release's binary. This used to record a terminal saying
  // "payload unchanged" — false about the database, and fatal, because every
  // automatic recovery is gated on a release still being on trial.
  //
  // ⚠ INJECTED WITH MODE BITS, so it is a no-op as root — and it says so rather
  // than passing quietly, because "no failure injected" and "the failure was
  // handled" are indistinguishable from a green test.
  it('does not close the operation when the swap fails after the database was restored', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      expect.soft(true, 'running as root: mode-bit injection is a no-op here').toBe(true);
      return;
    }
    withInFlightMigratingRelease();
    writeFileSync(snapshot(), 'PRE-MIGRATION DB', 'utf8');
    // A sidecar pair so `rollbackSwap` reaches the addon rename, inside a
    // directory it cannot write — the exe moves, the addon cannot, and it unwinds.
    const libDir = join(binaryDir, 'lib');
    writeFileSync(join(libDir, 'better_sqlite3.node'), 'NEW ADDON', 'utf8');
    writeFileSync(join(libDir, 'better_sqlite3.node.old'), 'OLD ADDON', 'utf8');
    chmodSync(libDir, 0o500);

    let outcome: ReturnType<typeof revertStagedRelease>;
    try {
      outcome = revert();
    } finally {
      chmodSync(libDir, 0o700);
    }

    // ⛔ THE OPERATION IS STILL OPEN, AND THIS ASSERTION GOES FIRST because it is
    // the consequence: the terminal is what retires `hasApplyInFlight`, and with
    // it every automatic retry. Asserting the outcome shape first would make the
    // regression read as a changed return value rather than a lost recovery.
    const kinds = readFileSync(ledger(), 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l) as { kind: string }).map((e) => e.kind);
    expect(
      kinds,
      'a half-done revert must not be terminalized: the terminal retires the only '
      + 'mechanism that would finish it, and this install is holding the previous '
      + 'database under the failed release\'s binary',
    ).not.toContain('apply_reverted');
    // The state the audit reproduced: old data, new binary.
    expect(readFileSync(db(), 'utf8')).toBe('PRE-MIGRATION DB');
    expect(readFileSync(live(), 'utf8')).toBe('TAMPERED PAYLOAD');
    expect(outcome).toMatchObject({ status: 'failed', databaseRestored: true });
  });

  // …and the retry the open operation exists to allow. The snapshot survives its
  // own restore, so redoing it is a no-op and only the swap has to succeed.
  it('completes on a retry once the swap can succeed', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      expect.soft(true, 'running as root: mode-bit injection is a no-op here').toBe(true);
      return;
    }
    withInFlightMigratingRelease();
    writeFileSync(snapshot(), 'PRE-MIGRATION DB', 'utf8');
    const libDir = join(binaryDir, 'lib');
    writeFileSync(join(libDir, 'better_sqlite3.node'), 'NEW ADDON', 'utf8');
    writeFileSync(join(libDir, 'better_sqlite3.node.old'), 'OLD ADDON', 'utf8');
    chmodSync(libDir, 0o500);
    try { revert(); } finally { chmodSync(libDir, 0o700); }

    expect(revert()).toEqual({ status: 'reverted', restoredSnapshot: true });
    expect(readFileSync(live(), 'utf8')).toBe('KNOWN-GOOD PAYLOAD');
    expect(readFileSync(db(), 'utf8')).toBe('PRE-MIGRATION DB');
  });

  it('⛔ a lost terminal append retries the receipt, not the physical rollback', () => {
    withInFlightMigratingRelease();
    writeFileSync(snapshot(), 'PRE-MIGRATION DB', 'utf8');
    // The generation behind the failed apply. A second physical swap would put
    // this R1 payload live, reproducing the audited two-generation rollback.
    writeFileSync(`${live()}.old.apply-aside`, 'TWO-GENERATIONS-BACK', 'utf8');

    const first = revertStagedRelease({
      binaryPath: live(),
      dbPath: db(),
      reason: 'boot failed',
      log: () => {},
      recordRevert: () => false,
    });
    expect(first).toEqual({ status: 'reverted', restoredSnapshot: true });
    expect(readFileSync(live(), 'utf8')).toBe('KNOWN-GOOD PAYLOAD');
    expect(readFileSync(`${live()}.old`, 'utf8')).toBe('TWO-GENERATIONS-BACK');
    expect(existsSync(`${live()}${REVERT_JOURNAL_SUFFIX}`)).toBe(true);

    const second = revert();
    expect(second).toEqual({ status: 'reverted', restoredSnapshot: true });
    expect(readFileSync(live(), 'utf8'), 'the retry must not consume R1').toBe('KNOWN-GOOD PAYLOAD');
    expect(readFileSync(`${live()}.old`, 'utf8')).toBe('TWO-GENERATIONS-BACK');
    expect(existsSync(`${live()}${REVERT_JOURNAL_SUFFIX}`)).toBe(false);
    expect(createUpdateLedger(ledger()).readAll().at(-1)?.kind).toBe('apply_reverted');
  });

  // ⚠ THE CASE THE ORIGINAL REASONING WAS WRITTEN FOR IS UNCHANGED. With no
  // snapshot in play `rollbackSwap` unwinds its own renames, so nothing was
  // written and closing the operation is honest — it is what keeps the binary
  // from fighting a phantom apply.
  it('still closes the operation when nothing was written', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      expect.soft(true, 'running as root: mode-bit injection is a no-op here').toBe(true);
      return;
    }
    // No migration ⇒ `decideRollback` says binary-swap ⇒ the database is untouched.
    const l = createUpdateLedger(join(dataDir, UPDATE_LEDGER_FILE));
    l.append({
      id: 'a1', kind: 'apply_started', at: 1, from_version: '26.9.1', to_version: '26.9.2',
      channel: 'stable', trigger: 'auto', release_identity: 'stable:26.9.2', migration: false,
    });
    const libDir = join(binaryDir, 'lib');
    writeFileSync(join(libDir, 'better_sqlite3.node'), 'NEW ADDON', 'utf8');
    writeFileSync(join(libDir, 'better_sqlite3.node.old'), 'OLD ADDON', 'utf8');
    chmodSync(libDir, 0o500);
    let outcome: ReturnType<typeof revertStagedRelease>;
    try { outcome = revert(); } finally { chmodSync(libDir, 0o700); }

    expect(outcome).toMatchObject({ status: 'failed', databaseRestored: false });
    const entries = readFileSync(ledger(), 'utf8').trim().split('\n')
      .map((l2) => JSON.parse(l2) as { kind: string; detail?: string });
    expect(entries.at(-1)?.kind).toBe('apply_reverted');
    expect(String(entries.at(-1)?.detail)).toContain('binary and database unchanged');
  });

  // ⛔⛔ NEITHER GUESS IS SAFE. `false` swaps onto a possibly-migrated schema;
  // `true` restores a snapshot that may predate a COMMITTED, working release —
  // which destroys data rather than merely downgrading a file. An unreadable
  // ledger is the one input that makes the question unanswerable.
  it('refuses when the ledger cannot be read at all, rather than guessing', () => {
    mkdirSync(join(dataDir, UPDATE_LEDGER_FILE));   // a directory: readAll throws
    const outcome = revert();
    expect(outcome).toMatchObject({ status: 'refused', noPreviousBinary: false });
    expect(outcome.status === 'refused' && outcome.reason).toMatch(/could not be read/);
    expect(readFileSync(live(), 'utf8')).toBe('TAMPERED PAYLOAD');
    expect(readFileSync(db(), 'utf8')).toBe('MIGRATED DB');
  });
});

describe('recordLedgerRevert', () => {
  it('appends an apply_reverted terminal for the in-flight apply (un-wedges the server lock)', async () => {
    const { createUpdateLedger } = await import('../update-ledger.js');
    const d = mkdtempSync(join(tmpdir(), 'supervise-ledger-'));
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
    const terminal = all.find((e: { kind: string }) => e.kind === 'apply_reverted');
    expect(terminal).toBeDefined();
    expect(terminal!.release_identity).toBe('stable:1.4.2');
    expect(terminal!.trigger).toBe('revert');
    expect(terminal!.recovery_source).toBe('outer-supervisor');
  });

  it('is a no-op when nothing is in flight (server already recorded the terminal)', async () => {
    const { createUpdateLedger } = await import('../update-ledger.js');
    const d = mkdtempSync(join(tmpdir(), 'supervise-ledger2-'));
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
    expect(createUpdateLedger(p).readAll().filter((e: { kind: string }) => e.kind === 'apply_reverted')).toHaveLength(0);
  });
});

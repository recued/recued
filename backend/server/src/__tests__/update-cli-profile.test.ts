import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ReleaseCheckResponse } from '@recued/contracts';
import {
  buildCliApplyDeps,
  buildUpdateApplyGuidance,
  resolveCliApplyOutcome,
  runUpdateProfile,
} from '../cli-context/update.js';
import { runningServerUpdateRemedy } from '../cli-context/update-profile-guards.js';
import { createUpdateLedger } from '../update/update-ledger.js';
import { buildReleaseCheckDeps } from '../update/release-config.js';
import { openDatabase } from '../open-database.js';
import { MANUAL_ROLLBACK_JOURNAL_FILE } from '../update/manual-rollback-journal.js';
import { acquireUpdateLease, updateLeasePathFor } from '../update/update-lease.js';

describe('recued update platform guidance', () => {
  const unusedCheck = {} as ReleaseCheckResponse;

  it('routes Windows binary owners to the stopped updater', () => {
    const check = buildUpdateApplyGuidance('binary', unusedCheck, 'win32');
    const running = runningServerUpdateRemedy('apply', 'win32');

    expect(check).toMatch(/Stop the Windows daemon/);
    expect(running).toMatch(/recued stop/);
    expect(running).toMatch(/recued update apply/);
    expect(`${check}\n${running}`).not.toMatch(/Settings/);
  });

  it('keeps the supervised webclient route on macOS and Linux', () => {
    expect(buildUpdateApplyGuidance('binary', unusedCheck, 'darwin'))
      .toMatch(/Settings → Updates/);
    expect(runningServerUpdateRemedy('rollback', 'linux'))
      .toMatch(/supervised server/);
  });
});

describe('runUpdateProfile (recued update)', () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recued-update-cli-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (sub?: string, ...extra: string[]) =>
    runUpdateProfile({
      args: ['update', ...(sub ? [sub] : []), ...extra, '--db', join(dir, 'recued.db')],
      serverVersion: '1.4.0',
      env: {
        ...process.env,
        RECUED_DISTRIBUTION_CHANNEL: 'binary',
        // ⛔ MUST stay pointed at a dead local port. Before the release key was
        // pinned (2026-07-31) the empty key short-circuited every check, so this
        // profile could not reach the network no matter what. With a real key
        // pinned the check RUNS — and without this override these cases would
        // make live HTTPS calls to releases.recued.com on every suite run.
        RECUED_RELEASE_MANIFEST_URL: 'http://127.0.0.1:1/manifest.json',
      },
    });

  it('default subcommand runs the check and reports the failure honestly, never throwing', async () => {
    // ⚠ REWRITTEN 2026-07-31 with the key pin. This asserted
    // `not available on this build yet` — the pre-GA `not-configured`
    // short-circuit, which a pinned build no longer takes.
    //
    // The INTENT is unchanged and is the whole point of the profile: the check
    // runs on EVERY install, prints the version/channel head, and reports what
    // happened instead of throwing. An unreachable feed is the cleanest way to
    // prove the reporting path offline.
    await expect(run()).resolves.toBeUndefined();
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(out).toMatch(/recued 1\.4\.0 \(stable channel\)/);
    expect(out).toMatch(/could not reach the release feed/);
    expect(process.exitCode).toBeUndefined();
  });

  it('`update check` is the explicit form of the default', async () => {
    await run('check');
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toMatch(
      /could not reach the release feed/,
    );
  });

  it('refuses before opening SQLite while a stopped rollback owns recovery', async () => {
    writeFileSync(join(dir, MANUAL_ROLLBACK_JOURNAL_FILE), '{}\n');

    await run('check');

    expect(errText()).toMatch(/requires pre-open recovery/);
    expect(errText()).toMatch(/Start the server once/);
    expect(existsSync(join(dir, 'recued.db'))).toBe(false);
    expect(process.exitCode).toBe(74);
  });

  // ⚠ REWRITTEN 2026-08-27. These asserted that apply/rollback were NOT CLI
  // verbs and merely pointed at the webclient. They are verbs now, for the
  // stopped server only — `update.apply` is an rpc over `/ws`, so a socket-layer
  // defect took the updater with it, and one did. What the CLI must never do is
  // half-apply, so the cases below are the two refusals that keep it honest.
  const errText = (): string => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

  it('`update apply` refuses when it is not the packaged binary + exit 2', async () => {
    // ⛔⛔ THE REFUSAL THAT PROTECTS THE OWNER'S NODE. The channel resolves
    // `binary` BY DEFAULT (including here), and on that channel the apply target
    // is `process.execPath` — which under vitest, a source checkout or an npm
    // install is the NODE RUNTIME. Without this the apply would preserve their
    // `node` as `node.old` and rename a Recued SEA over it.
    await run('apply');
    expect(errText()).toMatch(/not the packaged Recued binary/);
    // `\s+` because the message wraps between the two words.
    expect(errText()).toMatch(/node\s+executable itself/);
    // Tells them how to update the install they ACTUALLY have.
    expect(errText()).toMatch(/npm i -g @recued\/server@latest/);
    expect(process.exitCode).toBe(2);
  });

  it('`update rollback` is guarded by the same check', async () => {
    // Rollback swaps `.old` back over the same target, so it is exactly as
    // dangerous and must not be reachable when apply is not.
    await run('rollback');
    expect(errText()).toMatch(/not the packaged Recued binary/);
    expect(process.exitCode).toBe(2);
  });

  it('refuses a competing CLI lease before it creates or opens the realm database', async () => {
    const binDir = join(dir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const dbPath = join(dir, 'must-not-open.db');
    const lease = acquireUpdateLease({
      leasePath: updateLeasePathFor(join(binDir, 'recued')),
      operation: 'rollback',
      // A live pid other than this test process makes the production claim
      // refuse rather than taking its intentional same-process re-entrant path.
      currentPid: () => process.ppid,
      isAlive: () => true,
    });
    try {
      await runUpdateProfile({
        args: ['update', 'apply', '--db', dbPath],
        serverVersion: '1.4.0',
        env: {
          ...process.env,
          RECUED_DISTRIBUTION_CHANNEL: 'docker-thin',
          RECUED_BIN_DIR: binDir,
          RECUED_RELEASE_MANIFEST_URL: 'http://127.0.0.1:1/manifest.json',
        },
      });
    } finally {
      lease.release();
    }

    expect(errText()).toMatch(/Another update is already running/);
    expect(existsSync(dbPath), 'a losing CLI must never obtain a SQLite handle').toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('`--apply` is accepted as an alias for the subcommand', async () => {
    // The flag form is what people reach for after reading about it; silently
    // treating it as a plain `check` would report "up to date" and do nothing.
    await run(undefined, '--apply');
    expect(errText()).toMatch(/not the packaged Recued binary/);
    expect(process.exitCode).toBe(2);
  });

  it('refuses FIRST when a live server holds the realm, naming both restart routes', async () => {
    // The instance lock, not a pidfile: a foreground `recued serve` writes no
    // pidfile, which is the common case. `process.pid` is unambiguously alive.
    writeFileSync(
      join(dir, 'recued-server.lock'),
      JSON.stringify({ pid: process.pid, boot_at: 1, bind_port: 7717 }),
    );
    await run('apply');
    const err = errText();
    expect(err).toMatch(/server is running on this realm/i);
    expect(err).toContain(String(process.pid));
    // Both ways out — the one that restarts itself, and the one they control.
    expect(err).toMatch(/Settings → Updates/);
    expect(err).toMatch(/stop the server/i);
    // Ordering matters: this must beat the packaged-binary refusal, or an owner
    // with a live server is told the wrong thing about why it declined.
    expect(err).not.toMatch(/not the packaged Recued binary/);
    expect(process.exitCode).toBe(2);
  });

  it('a STALE lock does not block — a crashed server must not wedge recovery', async () => {
    // pid 0x7FFFFFFF is not a live process. If a stale lock refused, the one
    // path out of a crash-looping install would be closed.
    writeFileSync(
      join(dir, 'recued-server.lock'),
      JSON.stringify({ pid: 0x7fffffff, boot_at: 1, bind_port: 7717 }),
    );
    await run('apply');
    expect(errText()).toMatch(/not the packaged Recued binary/);
    expect(errText()).not.toMatch(/server is running on this realm/i);
  });

  it('an unknown subcommand errors with guidance + exit 2', async () => {
    await run('frobnicate');
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toMatch(/Unknown subcommand/);
    expect(process.exitCode).toBe(2);
  });
});

/** ⛔⛔ THE CLI APPLY PATH BROKE AND NOTHING CAUGHT IT.
 *
 *  `runApply` refuses an apply that would exit a RUNNING server into nothing.
 *  The port that says otherwise is OPTIONAL and fails CLOSED, and this command
 *  builds its own orchestrator deps — so omitting it did not crash, it silently
 *  refused every `recued update apply`. Found by the owner asking how many
 *  update paths exist, not by a test.
 *
 *  ⚠ WHY THIS STOPS AT THE COMPOSITION. Reaching `runApply` through the real
 *  command needs `resolveForApply()` to return `applyable`, which needs a
 *  manifest SIGNED against the pinned release pubkey. There is deliberately no
 *  skip-verify seam server-side and there should not be one — the security of
 *  self-update rests on that signature being unavoidable, which is worth more
 *  than the coverage an injectable trust root would buy. So these build the real
 *  ports and assert what they ANSWER; the signed half belongs to the release
 *  rehearsal, not the unit suite. */
describe('the CLI apply path opts out of the supervisor guard', () => {
  // Its own directory: this describe is a sibling of the command tests above,
  // not nested in them, so it cannot borrow their `dir`.
  let portsDir: string;
  beforeEach(() => {
    portsDir = mkdtempSync(join(tmpdir(), 'recued-cli-ports-'));
  });
  afterEach(() => {
    rmSync(portsDir, { recursive: true, force: true });
  });

  /** Set by the ports built below, exactly as `runUpdateProfile` captures it. */
  let captured: Promise<void> | null = null;

  const realPorts = async (): Promise<
    NonNullable<ReturnType<typeof buildCliApplyDeps>>
  > => {
    captured = null;
    const env = {
      ...process.env,
      RECUED_DISTRIBUTION_CHANNEL: 'binary',
      // Dead local port, same reason as the harness above: never touch the wire.
      RECUED_RELEASE_MANIFEST_URL: 'http://127.0.0.1:1/manifest.json',
    };
    const db = await openDatabase(join(portsDir, 'ports.db'));
    const releaseCheckDeps = buildReleaseCheckDeps({
      db,
      currentVersion: '1.4.0',
      env,
    });
    expect(releaseCheckDeps).toBeDefined();
    const deps = buildCliApplyDeps({
      db,
      releaseCheckDeps: releaseCheckDeps!,
      env,
      // The real CLI answers this from a flag it flips when it closes the db
      // before a rollback; here the handle is genuinely still open.
      holdsDatabaseOpen: () => true,
      // ⛔ THIS SUITE ASSERTS THE REAL PORTS OF A PACKAGED INSTALL. The shared
      // builder now refuses to build them when the process is not the SEA —
      // because the apply target would be the owner's node — so a test that did
      // not say which it is models nothing at all.
      isPackagedBinary: () => true,
      captureCommit: (committed) => { captured = committed; },
    });
    expect(deps).toBeDefined();
    return deps!;
  };

  it('reports the db as OPEN, which is what refuses an unsafe rollback', async () => {
    // The exact question `runRollback` asks before restoring a snapshot. These
    // are the REAL ports, so this is the composition answering, not a double.
    const deps = await realPorts();
    expect(deps.ports.holdsDatabaseOpen?.()).toBe(true);
  });

  it('answers that nothing will be stranded, so runApply does not refuse it', async () => {
    const deps = await realPorts();
    // The exact question `runApply` asks. `!== true` is what refuses.
    expect(deps.ports.supervisorWillRespawn?.()).toBe(true);
  });

  it('pairs that with a restart that hands off nothing — the offline contract', async () => {
    const deps = await realPorts();
    // If this ever became a real handoff, answering `true` above would start
    // promising a respawn nothing performs. The two only make sense together.
    expect(() => deps.ports.requestRestart()).not.toThrow();
  });

  // ⛔⛔⛔ `drainOk` ASKS WHETHER EVERYTHING THAT WRITES THIS REALM HAS STOPPED, and
  // this path answered a flat `true` on the strength of a check taken BEFORE a
  // resolve and a ~144 MB download. A server starting in that window made the
  // answer false without changing it, and the commit went on to snapshot and swap
  // underneath it. Boot now stands down while the lease is held, so the window is
  // already tiny; asking again here, immediately before the only step that
  // touches disk, is what makes it zero-width.
  it('answers the commit gate FALSE when a server appeared during the download', async () => {
    const deps = await realPorts();
    // The realm's instance lock, written by a live process — exactly what
    // `liveServerHolding` reads, at the path the serve path writes it to.
    writeFileSync(
      join(portsDir, 'recued-server.lock'),
      JSON.stringify({ pid: process.ppid, boot_at: 1, bind_port: 7717 }),
    );
    const commit = vi.fn(async () => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      deps.ports.requestRestart(commit);
      // Not "skip the commit": the apply must be TERMINATED, or its
      // `apply_started` wedges every future one. `false` is what does that.
      expect(commit).toHaveBeenCalledWith(false);
      expect(String(errSpy.mock.calls[0]?.[0])).toMatch(/started on this realm/);
      await captured;
    } finally {
      errSpy.mockRestore();
    }
  });

  // ⛔⛔ NOTHING TO HAND OFF TO IS NOT THE SAME AS NOTHING TO DO. `runApply` now
  // gives the snapshot + swap to this callback, because on a live server the only
  // moment writers have stopped is inside the restart drain. A CLI port that kept
  // ignoring it would have staged NOTHING — and on a migrating release, migrated
  // on the next boot with no snapshot to roll back to. Silently.
  it('RUNS the commit callback — the CLI is its own drain', async () => {
    const deps = await realPorts();
    const commit = vi.fn(async () => {});
    deps.ports.requestRestart(commit);
    // `true` is a fact here: `liveServerHolding` + the update lease already
    // proved nothing else holds this realm, and this process serves nothing.
    expect(commit).toHaveBeenCalledWith(true);
    // …and it is captured, so the caller can wait for it before reporting.
    expect(captured).not.toBeNull();
    await captured;
  });
});

describe('the CLI staged-rollout bypass is audited as confirmed', () => {
  it('maps either --yes or an affirmative TTY answer to clientConfirmed', () => {
    // A signed applyable manifest cannot be injected into the profile without
    // weakening the production trust root, so pin the composition seam itself.
    // Control flow reaches runApply out of cohort only after one of those two
    // explicit confirmations; the mapped fact must not disappear at the port.
    const source = readFileSync(resolve(import.meta.dirname, '../cli-context/update.ts'), 'utf8');
    expect(source).toContain(
      'rolloutBypass: { rolloutPct: resolved.rolloutPct, clientConfirmed: true }',
    );
  });
});

/** What the owner is TOLD after the commit callback has run. `runApply` answers
 *  `restarting` the moment it hands the snapshot + swap to that callback, so the
 *  return value alone cannot distinguish "staged, restart to finish it" from
 *  "the commit gave up and this install is still on the old release". */
describe('resolveCliApplyOutcome', () => {
  let ledgerDir: string;
  beforeEach(() => { ledgerDir = mkdtempSync(join(tmpdir(), 'recued-cli-outcome-')); });
  afterEach(() => { rmSync(ledgerDir, { recursive: true, force: true }); });

  const ledgerWith = (kinds: Array<{ kind: string; detail?: string }>) => {
    const ledger = createUpdateLedger(join(ledgerDir, 'updates.log'));
    let i = 0;
    for (const { kind, detail } of kinds) {
      ledger.append({
        id: `e${++i}`,
        kind: kind as never,
        at: i,
        from_version: '1.3.0',
        to_version: '1.4.2',
        channel: 'stable',
        trigger: 'manual',
        release_identity: 'stable:1.4.2',
        ...(detail === undefined ? {} : { detail }),
      });
    }
    return ledger;
  };

  const restarting = { status: 'restarting' as const, operationId: 'e1' };

  it('reports the staged apply when the commit left it in flight', () => {
    const ledger = ledgerWith([{ kind: 'apply_started' }, { kind: 'apply_staged' }]);
    expect(resolveCliApplyOutcome(restarting, ledger)).toEqual(restarting);
  });

  // ⛔ THE CASE THE RETURN VALUE CANNOT SEE. The commit ran after `runApply`
  // resolved, failed, and appended its own terminal — which is what resolves the
  // in-flight entry. Printing "Staged 1.3.0 → 1.4.2" here would send the owner to
  // restart into a release that was never swapped in.
  it('reports a FAILED commit, with the reason the commit itself recorded', () => {
    const ledger = ledgerWith([
      { kind: 'apply_started' },
      { kind: 'apply_reverted', detail: 'stage: disk full' },
    ]);
    expect(resolveCliApplyOutcome(restarting, ledger)).toEqual({
      status: 'stage-failed',
      detail: 'stage: disk full',
    });
  });

  it('leaves a non-restarting answer alone — those are decided before the commit', () => {
    const ledger = ledgerWith([]);
    const busy = { status: 'busy' as const };
    expect(resolveCliApplyOutcome(busy, ledger)).toEqual(busy);
  });
});

/** ⛔⛔ `recued update rollback` AFTER A STAGED UPDATE THAT NEVER BOOTED.
 *
 *  The CLI printed "stop it and run `recued update rollback`" for exactly this
 *  situation and the command could not do it: `rollbackContext()` only ever sees
 *  COMMITTED releases, so a staged release answered "Nothing to roll back"; and
 *  where a committed release DID exist, `runRollback` refused `busy` because the
 *  ledger still showed an apply in flight. On an unsupervised install nothing
 *  else recovers it either — no supervisor counts the failed boots — so the owner
 *  was left hand-restoring `recued.old`, which puts back the EXECUTABLE ALONE
 *  beside the new addon, the new webclient and a possibly-migrated database.
 *
 *  🔑 DRIVEN THROUGH THE REAL PROFILE, not the orchestrator, because the defect
 *  was in the wiring: every piece it needs already existed. */
describe('recued update rollback — a staged release that never committed', () => {
  let dir: string;
  let binDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recued-staged-rollback-'));
    binDir = join(dir, 'bin');
    mkdirSync(binDir, { recursive: true });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  /** The install as a staged-but-unbooted apply leaves it: NEW binary live, the
   *  previous one preserved beside it. */
  const stagedInstall = (): void => {
    writeFileSync(join(binDir, 'recued'), 'NEW-BINARY', { mode: 0o755 });
    writeFileSync(join(binDir, 'recued.old'), 'OLD-BINARY', { mode: 0o755 });
  };
  const ledgerWith = (kinds: string[], migration = false): void => {
    const ledger = createUpdateLedger(join(dir, 'updates.log'));
    let i = 0;
    for (const kind of kinds) {
      ledger.append({
        id: `e${++i}`,
        kind: kind as never,
        at: i,
        from_version: '1.3.0',
        to_version: '1.4.2',
        channel: 'stable',
        trigger: 'manual',
        release_identity: 'stable:1.4.2',
        migration,
      });
    }
  };
  const rollback = (serverVersion = '1.4.2') =>
    runUpdateProfile({
      args: ['update', 'rollback', '--db', join(dir, 'recued.db')],
      serverVersion,
      env: {
        ...process.env,
        // The one channel whose binary directory is env-derived, so a test can own
        // it. On `binary` the target is `process.execPath` — the test runner's own
        // node.
        RECUED_DISTRIBUTION_CHANNEL: 'docker-thin',
        RECUED_BIN_DIR: binDir,
        RECUED_RELEASE_MANIFEST_URL: 'http://127.0.0.1:1/manifest.json',
      },
    });
  const said = (): string =>
    [...logSpy.mock.calls, ...errSpy.mock.calls].map((c) => String(c[0])).join('\n');

  it('⛔ UNDOES IT — the previous binary comes back', async () => {
    stagedInstall();
    ledgerWith(['apply_started', 'apply_staged']);
    await rollback();
    expect(said(), 'this used to say "Nothing to roll back"').toContain('Abandoned the staged update');
    expect(readFileSync(join(binDir, 'recued'), 'utf-8'), 'the OLD binary must be live again')
      .toBe('OLD-BINARY');
  });

  it('⛔ and wins over a COMMITTED release, which used to make it answer `busy`', async () => {
    // With both, `rollbackContext()` returned the committed one and `runRollback`
    // then refused because the ledger still showed an apply in flight — so the
    // newest, broken thing was the one you could not undo.
    stagedInstall();
    ledgerWith(['apply_started', 'apply_staged', 'apply_committed', 'apply_started', 'apply_staged']);
    await rollback();
    expect(said()).toContain('Abandoned the staged update');
    expect(said()).not.toContain('already in flight');
    expect(readFileSync(join(binDir, 'recued'), 'utf-8')).toBe('OLD-BINARY');
  });

  it('does NOT take that path for an apply that never staged', async () => {
    // `apply_started` plus a process still reporting the FROM version means the
    // download/verify phase — unlike the lost-ledger window, disk independently
    // says the target pair was never swapped in.
    writeFileSync(join(binDir, 'recued'), 'OLD-BINARY', { mode: 0o755 });
    writeFileSync(join(binDir, 'recued.old'), 'OLDER-BINARY', { mode: 0o755 });
    ledgerWith(['apply_started']);
    await rollback('1.3.0');
    expect(said()).not.toContain('Abandoned the staged update');
    // ⛔ NAME THE PATH IT SHOULD HAVE TAKEN. Asserting only that the binary is
    // untouched passes just as well when the command bailed out early for an
    // unrelated reason, which would make this arm agree with a broken build.
    expect(said(), 'it must fall through to the ordinary rollback path')
      .toContain('Nothing to roll back');
    expect(readFileSync(join(binDir, 'recued'), 'utf-8'), 'the live binary must be untouched')
      .toBe('OLD-BINARY');
  });

  it('says so plainly when there is no previous binary to go back to', async () => {
    writeFileSync(join(binDir, 'recued'), 'NEW-BINARY', { mode: 0o755 });
    ledgerWith(['apply_started', 'apply_staged']);
    await rollback();
    expect(said()).toContain('recued.old');
    expect(process.exitCode, 'a refusal is a non-zero exit').not.toBe(0);
  });
});

/** ⚠ THE ADVICE AND THE COMMAND HAVE TO AGREE. The message told owners to run a
 *  command that could not work, and the note explaining why sat three lines
 *  below it. Pinned as text because no behaviour test reads console copy. */
describe('the post-apply advice', () => {
  const SRC = readFileSync(resolve(import.meta.dirname, '../cli-context/update.ts'), 'utf-8');

  it('no longer tells the owner to restore recued.old by hand', () => {
    // Restoring it puts back the EXECUTABLE ALONE, beside the new addon, the new
    // webclient and a migrated database — the skew the rollback transaction
    // exists to avoid. The file still uses `recued.old`; what is gone is offering
    // it as the owner's move.
    expect(SRC).not.toContain('restore the previous binary');
    expect(SRC).not.toContain('`recued.old` beside it.');
  });

  it('no longer says rollback works only AFTER the first boot', () => {
    expect(SRC).not.toContain('After it has started once');
  });
});

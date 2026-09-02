/** D-178 — the `recued update` CLI profile.
 *
 *  A standalone, channel-INDEPENDENT update CHECK from the terminal — the
 *  counterpart to the owner-device `update.check` rpc (the webclient surface).
 *  The D-178 model is "identifier-free check / channel-aware apply": the check
 *  works on EVERY install (binary, docker, source self-build) because it only
 *  fetches + verifies the signed manifest and resolves it locally. Whether the
 *  install can self-APPLY is a separate, channel-gated question — so this
 *  profile always offers the check and reports apply availability honestly
 *  rather than hiding the check on delegated channels.
 *
 *  Apply / rollback ARE CLI verbs now, for the STOPPED server only. The old
 *  reasoning — a standalone process cannot restart the running daemon — is
 *  still true, and this does not try: it refuses while a server holds the
 *  instance lock and points at the surface that CAN restart itself. On Windows,
 *  Startup is not a respawning supervisor, so the stopped CLI remains the
 *  supported path.
 *
 *  ⛔ WHY IT HAD TO EXIST. `update.apply` is an rpc, so it rides the WebSocket.
 *  A defect in the socket layer therefore takes the updater with it — and one
 *  did: a `ws` packaging bug shipped servers that booted, printed a pairing
 *  code, and could not be paired to at all, which left `curl | sh` as the only
 *  way out. The recovery path must not depend on the subsystem most likely to
 *  need recovering.
 *
 *  🔑 IT REUSES THE SERVER'S OWN MACHINERY rather than re-implementing the
 *  installer's. `runApply` stages, verifies fail-closed against the pinned key,
 *  preserves `recued.old`, and swaps atomically; the COMMIT half happens on the
 *  next boot through `boot-reconcile`. So a CLI apply gets the same
 *  crash-consistency and boot-failure rollback the in-app path has — which
 *  `curl | sh`, which simply overwrites the file, does not.
 *
 *  Standalone like the `audit` / `archive` profiles: open the db (for the
 *  rollout salt + anti-replay floor in `server_state`), build the check deps,
 *  run, print, close. Pre-GA (no trusted release key wired yet) the check
 *  resolves to `not-configured` and says so.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { acquireUpdateLease, updateLeasePathFor } from '../update/update-lease.js';
import { resolveUpdateBinaryPath } from '../update/release-config.js';
import { getArg, getFlag, parsePositionals } from '../cli/parse.js';
import { runningAsPackagedBinary } from '../packaged-binary.js';
import { deriveInFlightRelease, runApply, runRollback } from '../update/apply-orchestrator.js';
import type { UpdateLedger } from '../update/update-ledger.js';
import type { BootTrace } from '../cli/boot-trace.js';
import { openDatabase } from '../open-database.js';
import {
  buildApplyOrchestratorDeps,
  buildReleaseCheckDeps,
  resolveDistributionChannel,
} from '../update/release-config.js';
import { runReleaseCheck } from '../update/release-check.js';
import type { ReleaseCheckResponse } from '@recued/contracts';
import type { DistributionChannel } from '../update/update-mode-store.js';
import { resolveRealmDbPath } from '../realm-db-path.js';
import { manualRollbackJournalPathForDb } from '../update/manual-rollback-journal.js';
import {
  liveServerHolding,
  refuseUnpackagedBinaryUpdate,
  refuseWhileRunning,
} from './update-profile-guards.js';

export interface UpdateProfileOptions {
  args: string[];
  bootTrace?: BootTrace;
  serverVersion: string;
  env?: NodeJS.ProcessEnv;
}

/** Channels whose binary self-applies (mirrors release-config's
 *  `SELF_APPLY_CHANNELS`) — used only to phrase the apply guidance. */
const selfApplies = (channel: DistributionChannel): boolean =>
  channel === 'binary' || channel === 'docker-thin';

/** One line on HOW this install takes an available update, given its channel. */
export const buildUpdateApplyGuidance = (
  channel: DistributionChannel,
  res: ReleaseCheckResponse,
  platform: NodeJS.Platform = process.platform,
): string => {
  if (selfApplies(channel)) {
    if (channel === 'binary' && platform === 'win32') {
      return 'Stop the Windows daemon, then run: recued update apply';
    }
    // Both paths, in the order most owners want them. The webclient one is
    // still preferable when the server is up — it restarts itself; the CLI one
    // is what remains when it cannot be reached, which is exactly when an
    // owner is reading this in a terminal.
    return 'Apply it from the webclient (Settings → Updates), or stop the server and run: recued update apply';
  }
  if (channel === 'docker-baked') {
    return res.docker
      ? `Recreate this server from the signed manifest digest: ${res.docker.pull_ref}`
      : 'This install updates by re-pulling the digest-pinned image; this manifest did not declare one for docker-baked.';
  }
  if (channel === 'source') {
    return 'This is a source build — rebuild from the tagged release to update.';
  }
  return 'See the release notes to update this install.';
};

const printCheck = (res: ReleaseCheckResponse, channel: DistributionChannel): void => {
  const head = `recued ${res.current_version} (${res.channel} channel)`;
  switch (res.status) {
    case 'up-to-date':
      console.log(`${head} — up to date.`);
      return;
    case 'update-available': {
      const a = res.available!;
      console.log(`${head} — update available: ${a.version}${a.is_major ? ' (major)' : ''}.`);
      if (a.below_min_supported) console.log('  ⚠ Your version is below the minimum supported — updating is URGENT.');
      if (a.migration) console.log('  This release migrates the database on first boot (a snapshot is taken for rollback).');
      console.log(`  ${buildUpdateApplyGuidance(channel, res)}`);
      if (a.notes_url) console.log(`  Release notes: ${a.notes_url}`);
      return;
    }
    case 'not-configured':
      console.log(`${head} — update checks are not available on this build yet (no signing key).`);
      return;
    case 'launcher-outdated':
      console.log(`${head} — the launcher is too old to apply updates; update the launcher first.`);
      if (res.docker) console.log(`  Recreate from the signed manifest digest: ${res.docker.pull_ref}`);
      return;
    case 'replay':
      console.log(`${head} — the release feed served an older manifest than we've already seen (refused).`);
      return;
    case 'fetch-failed':
      console.log(`${head} — could not reach the release feed${res.detail ? `: ${res.detail}` : ''}.`);
      return;
    case 'bad-signature':
      console.log(`${head} — the release manifest failed signature verification${res.detail ? `: ${res.detail}` : ''}.`);
      return;
  }
};

/** ⛔⛔ WHY THIS VERB ASKS `runningAsPackagedBinary` — THE CHECK THAT KEEPS AN
 *  APPLY FROM OVERWRITING THE USER'S NODE. `resolveDistributionChannel`
 *  DEFAULTS TO `binary` when `RECUED_DISTRIBUTION_CHANNEL` is unset, and on that
 *  channel the apply target is `process.execPath`. Run this verb from a source
 *  checkout or an npm install and `process.execPath` is the NODE RUNTIME — so
 *  the apply would preserve the owner's `node` as `node.old` and rename a Recued
 *  SEA over `/usr/local/bin/node`, breaking every other thing on the machine
 *  that runs JavaScript. Measured on this dev box: channel resolved `binary`,
 *  execPath `/opt/homebrew/Cellar/node/25.9.0_1/bin/node`.
 *
 *  ⚠ NOT APPLIED TO `docker-thin`, which legitimately runs UNDER node while
 *  targeting `/data/bin/recued`. There the binary being swapped is not
 *  execPath at all, so this check would refuse a channel that is working
 *  correctly.
 *
 *  The predicate itself lives in `packaged-binary.ts` — `daemon.ts` needs the
 *  same answer to decide whether to re-execute itself or shell out to tsx, and
 *  two copies of "am I the SEA" is one copy too many. */

/** One y/N question on the terminal. Resolves false on EOF or anything that is
 *  not an explicit yes — the safe default for a gate whose whole purpose is to
 *  stop something happening by accident. */
const promptYesNo = async (question: string): Promise<boolean> => {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } catch {
    return false;
  } finally {
    rl.close();
  }
};

/** ⚠ SAYS "STAGED", NOT "UPDATED". `runApply` returns `restarting` because on
 *  the server that is what happens next; here nothing restarts, and the swap is
 *  only half the operation — `boot-reconcile` COMMITS it on the first
 *  successful boot and rolls it back automatically if the new binary fails to
 *  start. Reporting "updated" would claim a result that has not been reached,
 *  and the owner would have no reason to start the server. */
/** ⛔ `restarting` IS THE ACCEPTANCE, NOT THE OUTCOME. `runApply` hands the
 *  snapshot + swap to `requestRestart`'s callback and returns before it runs; on
 *  a live server that outcome rides the ledger and `update.progress`, but here
 *  there is a person reading stdout, and telling them "Staged 26.9.1 → 26.9.2"
 *  for a commit that failed is a lie they would only discover by starting a
 *  server still on the old release.
 *
 *  🔑 THE LEDGER ANSWERS IT. A failed commit appends its own terminal, and a
 *  terminal is exactly what resolves the in-flight entry — so "still in flight"
 *  means staged and awaiting the boot commit, and "resolved" means the commit
 *  gave up and said why. */
export const resolveCliApplyOutcome = (
  result: Awaited<ReturnType<typeof runApply>>,
  ledger: UpdateLedger,
): Awaited<ReturnType<typeof runApply>> =>
  result.status === 'restarting' && deriveInFlightRelease(ledger) === null
    ? { status: 'stage-failed', detail: lastLedgerDetail(ledger) }
    : result;

/** The `detail` of the newest ledger entry — the commit's own account of why it
 *  failed, so the CLI reports that rather than a generic "staging failed". */
const lastLedgerDetail = (ledger: UpdateLedger): string => {
  try {
    const entries = ledger.readAll();
    return entries[entries.length - 1]?.detail ?? 'the update could not be staged';
  } catch {
    return 'the update could not be staged';
  }
};

const printApply = (
  result: Awaited<ReturnType<typeof runApply>>,
  from: string,
  to: string,
  supervised: boolean,
): void => {
  switch (result.status) {
    case 'restarting':
      console.log(`Staged ${from} → ${to}.`);
      console.log('');
      console.log('  Start the server to complete it. The update commits on the first successful');
      // ⛔⛔ THIS USED TO PROMISE "and rolls back on its own if the new binary
      // fails to start", AND ON THIS CHANNEL THAT IS NOT TRUE. The boot-failure
      // counter is only ever incremented from the POST-LISTENER reconcile, which
      // by definition does not run when the binary fails to start — a new binary
      // that cannot load its addon, open its database, or bind its listener never
      // increments anything and never restores `recued.old`. It crash-loops.
      //
      // Automatic revert IS real on `docker-thin`, where an outer launcher
      // supervises the exec and can count what the child never reached. The
      // binary channel has no such outer process: systemd and launchd exec the
      // binary directly, so nothing survives its failure to observe it.
      //
      // ⚠ Saying it anyway is worse than saying nothing: it tells an owner to
      // walk away from a machine that will not recover. Until the binary channel
      // grows an equivalent supervisor, this says what actually happens and how
      // to get back.
      console.log('  boot.');
      console.log('');
      // ⛔⛔ THE COMMENT ABOVE ENDED "until the binary channel grows an equivalent
      // supervisor". It has one (D-178, 2026-08-31): `install.sh` writes
      // `recued-supervise` beside the binary and every generated unit execs it,
      // so a payload that never starts IS counted and IS reverted. But only when
      // the SERVICE starts it — an owner running `recued serve` by hand is still
      // the unsupervised case, and the promise has to say which is which rather
      // than becoming a blanket claim in the other direction.
      if (supervised) {
        console.log('  If it does NOT start, the service reverts to the previous binary after');
        console.log('  three failed starts and logs why. Started by hand instead, nothing');
        console.log('  supervises it — stop it and run `recued update rollback`.');
      } else {
        console.log('  If it does NOT start, nothing reverts it automatically on this install —');
        console.log('  stop it and run `recued update rollback`.');
      }
      // ⛔⛔ THIS PARAGRAPH USED TO SAY THE OPPOSITE, AND THE NOTE EXPLAINING WHY
      // SAT THREE LINES BELOW THE ADVICE THAT CONTRADICTED IT. It read: "After it
      // has started once, `recued update rollback` returns to the previous binary.
      // Before then, the previous one is preserved beside it as `recued.old`" —
      // i.e. do not roll back yet — while the branches above told the owner to do
      // exactly that. Both halves were right about the code and the code was
      // wrong: `rollbackContext()` sees only COMMITTED releases, so a staged
      // release answered "Nothing to roll back". Someone measured that, fixed the
      // trailing sentence, and left the advice. The command handles the staged
      // case now, so the advice is finally true and the caveat is gone.
      //
      // ⚠ `recued.old` IS NO LONGER OFFERED AS THE OWNER'S MOVE. Restoring it by
      // hand puts back the EXECUTABLE ALONE, beside the new addon, the new
      // webclient and a database the release may already have migrated — the
      // skew the rollback transaction exists to avoid. It is still there, and the
      // recovery paths still use it; it is not a step to hand to a person.
      console.log('  That undoes the staged update completely — binary, native addon, webclient');
      console.log('  and, if this release migrated, the pre-migration database snapshot.');
      return;
    case 'not-configured':
      console.error('No trusted release key is wired into this build — refusing to apply.');
      break;
    case 'insufficient-storage':
      console.error(`Not enough free space to apply safely: ${result.detail}`);
      break;
    case 'download-failed':
      console.error(`Download failed: ${result.detail}`);
      break;
    case 'verify-failed':
      // The one failure that is never a retry. Say so.
      console.error(`Signature or checksum verification FAILED: ${result.detail}`);
      console.error('Nothing was installed. Do not retry against the same source.');
      break;
    case 'stage-failed':
      console.error(`Could not stage the new binary: ${result.detail}`);
      break;
    case 'deferred':
      console.error(`Deferred: ${result.reason}`);
      break;
    case 'busy':
      console.error('Another update operation is already in flight for this realm.');
      break;
  }
  process.exitCode = 1;
};

const printRollback = (result: ReturnType<typeof runRollback>): void => {
  switch (result.status) {
    case 'rolled-back':
      console.log(result.recovery_pending
        ? 'Rollback committed; pre-open recovery will finish the binary swap.'
        : 'Rolled back to the previous binary.');
      if (result.restored_snapshot) {
        console.log('  The pre-migration database snapshot was restored as well.');
      }
      console.log('  Start the server to run on it again.');
      return;
    case 'refused':
      console.error(`Rollback refused: ${result.reason}`);
      break;
    case 'busy':
      console.error('Another update operation is already in flight for this realm.');
      break;
  }
  process.exitCode = 1;
};

/** Every non-applyable resolve, phrased for someone at a terminal. `up-to-date`
 *  is the ordinary case and is NOT an error exit — a scripted `update apply` in
 *  a loop should not fail simply because there was nothing to do. */
const printNotApplyable = (status: string, channel: string, detail?: string): void => {
  // ⛔⛔ THE DETAIL IS NOT DECORATION — `bad-signature` DOES NOT MEAN THE
  // SIGNATURE FAILED. `checkForRelease` returns it for a signature failure AND
  // for a manifest that is signed correctly but MALFORMED (`release-check.ts` —
  // "a signed-but-malformed manifest is an integrity problem, not a fetch one"),
  // with the actual cause only in `detail`. Dropping it told an operator whose
  // manifest was missing one numeric field that their release had failed
  // signature verification.
  //
  // 🔑 Measured 2026-08-31 while standing up a real-binary swap test against a
  // local feed: four consecutive runs reported a signature failure for four
  // different MISSING FIELDS, and the only way to see any of them was to run
  // `recued update` (the check path), which had printed the detail all along.
  // Two commands, same underlying result, one of them honest.
  const because = detail ? `: ${detail}` : '';
  switch (status) {
    case 'up-to-date':
      console.log('Already on the newest release for this channel.');
      return;
    case 'not-configured':
      console.log('No trusted release key is wired into this build; updates are unavailable.');
      return;
    case 'no-artifact':
      console.error(`The newest release publishes no binary for this platform (channel \`${channel}\`)${because}.`);
      break;
    case 'fetch-failed':
      // Do NOT name the default host: an operator on a staging or self-hosted
      // feed is then sent to check access to a machine they are not using.
      console.error(`Could not fetch the release manifest${because}.`);
      break;
    case 'bad-signature':
      console.error(`The release manifest was REJECTED — refusing to go further${because}.`);
      break;
    case 'replay':
      console.error(`The release feed went backwards (anti-replay floor); refusing to apply${because}.`);
      break;
    case 'launcher-outdated':
      console.error(`This install needs a newer launcher before it can take this release${because}.`);
      break;
    default:
      console.error(`Cannot apply: ${status}${because}`);
  }
  process.exitCode = 1;
};

/** The CLI's apply ports, lifted out of the command so they can be ASSERTED.
 *
 *  ⛔⛔ WHY THIS IS A NAMED FUNCTION AND NOT AN INLINE LITERAL. `runApply` refuses
 *  an apply that would exit a RUNNING server into nothing, and the port that says
 *  otherwise is OPTIONAL and fails CLOSED — so this command omitting it did not
 *  crash, it silently refused every `recued update apply`. Nothing caught that:
 *  no test in the repo reaches `runApply` through the CLI, because
 *  `resolveForApply()` must first return `applyable`, which needs a manifest
 *  SIGNED against the pinned release pubkey. There is deliberately no
 *  skip-verify seam server-side, and there should not be one — the whole security
 *  of self-update rests on that signature being unavoidable.
 *
 *  🔑 So the testable boundary is the COMPOSITION, not the network: a test builds
 *  these ports for real and asserts what they answer. That covers the thing that
 *  broke without putting an injectable trust root in the shipped binary.
 *
 *  ⚠ The two ports below are a PAIR and only make sense together: no restart to
 *  hand off to, therefore nothing that could be stranded. `refuseWhileRunning`
 *  above has already rejected the command if anything holds this realm's
 *  instance lock, so by here there is no server to lose. */
export const buildCliApplyDeps = (args: {
  db: Parameters<typeof buildApplyOrchestratorDeps>[0]['db'];
  releaseCheckDeps: Parameters<typeof buildApplyOrchestratorDeps>[0]['releaseCheckDeps'];
  env: NodeJS.ProcessEnv;
  /** Asked at CALL time, not build time — the rollback path closes the database
   *  between building these ports and using them, which is the entire point. */
  holdsDatabaseOpen: () => boolean;
  /** Threaded so a test can build the REAL ports for a packaged install without
   *  being a SEA. Production omits it and the shared builder asks `node:sea`. */
  isPackagedBinary?: () => boolean;
  /** Receives the apply's commit promise. `runApply` hands the snapshot + swap to
   *  `requestRestart`'s callback so a LIVE server does that work inside its drain;
   *  this path has no drain to wait for, so it runs the callback immediately and
   *  the caller awaits what it captures here before reporting. */
  captureCommit?: (committed: Promise<void>) => void;
}): ReturnType<typeof buildApplyOrchestratorDeps> =>
  buildApplyOrchestratorDeps({
    db: args.db,
    releaseCheckDeps: args.releaseCheckDeps,
    // Nothing to hand off to. The CLI *is* the process; the owner starts it
    // again themselves, with the invocation that knows their DB_PATH and cwd.
    //
    // ⛔ BUT THE CALLBACK STILL RUNS, AND `true` IS A FACT HERE RATHER THAN AN
    // OPTIMISM. `drainOk` asks one thing — has everything that writes this realm
    // stopped — and on this path `liveServerHolding` and the update lease already
    // proved nothing else holds it, while this process serves nothing. The quiet
    // moment a live server has to drain to reach is simply now. Ignoring the
    // callback instead would have been the silent failure: a migrating CLI apply
    // would take NO snapshot and leave the next boot to migrate with nothing to
    // roll back to.
    requestRestart: (onDrained) => {
      // ⛔⛔⛔ THE LAST LOOK, AT THE LAST MOMENT. `drainOk` asks one thing — has
      // everything that writes this realm stopped — and this path answered a flat
      // `true` on the strength of a check taken BEFORE a resolve and a ~144 MB
      // download, i.e. minutes earlier. A server starting in that window made the
      // answer false without changing it, and the commit went on to snapshot and
      // swap underneath it. Boot now stands down while this lease is held, so the
      // window is already tiny; asking again HERE, immediately before the only
      // step that touches disk, is what makes it zero-width rather than small.
      //
      // ⚠ `false` IS NOT A FAILURE OF THIS PROCESS. The commit changes nothing
      // and terminates the apply, which leaves the install exactly as it was and
      // the owner free to stop the server and retry.
      const holder = liveServerHolding(args.db.name);
      if (holder !== null) {
        console.error(
          `A Recued server started on this realm while the update was downloading `
          + `(pid ${holder.pid}, port ${holder.bind_port}). Nothing was installed — stop it and `
          + 'run this again.',
        );
      }
      args.captureCommit?.(Promise.resolve(onDrained?.(holder === null)));
    },
    // …and therefore nothing the supervisor guard could strand. See above.
    supervisorWillRespawn: () => true,
    // Trivially true: nothing is running on this realm. Only consulted for
    // `auto` triggers anyway; this path is always `manual`.
    isQuiesced: () => true,
    holdsDatabaseOpen: args.holdsDatabaseOpen,
    ...(args.isPackagedBinary === undefined ? {} : { isPackagedBinary: args.isPackagedBinary }),
    env: args.env,
  });

export async function runUpdateProfile(options: UpdateProfileOptions): Promise<void> {
  const env = options.env ?? process.env;
  const positionals = parsePositionals(options.args);
  const sub = positionals[1] ?? 'check';
  const dbPath = resolveRealmDbPath(getArg(options.args, 'db') ?? env.DB_PATH);

  // ⛔ A RETAINED MANUAL-ROLLBACK JOURNAL OWNS THE NEXT DATABASE OPEN. The
  // serve profile settles it before importing SQLite; this standalone profile
  // used to open the database first, so re-running `recued update` after a crash
  // could migrate or write the restored snapshot under the current binary before
  // recovery had chosen a generation. Refuse without opening anything and route
  // the owner through the pre-open reconciler.
  const retainedRollbackJournal = manualRollbackJournalPathForDb(dbPath);
  if (existsSync(retainedRollbackJournal)) {
    console.error(
      `A stopped-server rollback still requires pre-open recovery (${retainedRollbackJournal}).\n`
      + '  Start the server once; it will finish or safely refuse that recovery before opening\n'
      + '  the database. Then re-run this update command.',
    );
    process.exitCode = 74;
    return;
  }

  // `--apply` / `--rollback` accepted as aliases for the subcommands: the flag
  // form is what people reach for after reading about it, and accepting both
  // costs one line against a confusing "unknown subcommand" for a spelling.
  const wantsRollback = sub === 'rollback' || getFlag(options.args, 'rollback');
  const wantsApply = !wantsRollback && (sub === 'apply' || getFlag(options.args, 'apply'));

  if (wantsRollback) {
    // Direct callers get the same semantics as bin.ts. Production reaches this
    // preflight before importing this module so a broken native addon cannot
    // prevent it from running at all. Repeating the cheap ledger read here also
    // catches state that changed while the ordinary profile was being imported.
    const { tryRunStagedUpdateRollback } = await import('./update-staged-rollback.js');
    if (await tryRunStagedUpdateRollback(options)) return;
  }

  if (wantsApply || wantsRollback) {
    const verb = wantsRollback ? 'rollback' : 'apply';

    // ⛔ FIRST, BEFORE OPENING ANYTHING. A live server means we cannot finish
    // the job — swapping the file would leave the owner on the old process
    // believing it applied, which is the exact confusion `curl | sh` already
    // creates. Refuse loudly instead.
    const holder = liveServerHolding(dbPath);
    if (holder) {
      refuseWhileRunning(holder, verb);
      return;
    }
    // Refuse a source runtime before deriving/claiming a lease beside
    // `process.execPath`. Besides protecting Node from the later swap, this
    // avoids trying to create `recued-update.lock` in a system Node directory
    // that may be read-only and masking the useful diagnosis as lease failure.
    if (resolveDistributionChannel(env) === 'binary' && !runningAsPackagedBinary()) {
      refuseUnpackagedBinaryUpdate();
      return;
    }

    // The host lease is also the database-admission gate for mutating CLI
    // verbs. Taking it after `openDatabase()` left a losing second CLI holding
    // WAL/SHM handles while the winner replaced a rollback snapshot. A server
    // liveness glance cannot exclude another stopped CLI, so no SQLite handle
    // is admitted until this process owns the target-wide mutex.
    let db: Awaited<ReturnType<typeof openDatabase>> | null = null;
    // The rollback path closes this EARLY and on purpose — see the branch below.
    let dbClosed = true;
    let updateLease: { release: () => void } | null = null;
    try {
      // ⛔⛔ HELD ACROSS DATABASE ADMISSION + RESOLVE + DOWNLOAD + SWAP. The
      // canonical lease is keyed on the shared executable rather than the realm,
      // so two stopped CLIs cannot open one realm under another's file restore.
      const leasePath = updateLeasePathFor(resolveUpdateBinaryPath(env));
      try {
        updateLease = acquireUpdateLease({ leasePath, operation: verb });
      } catch (err) {
        const holder = (err as { holder?: { pid: number; operation: string } }).holder;
        console.error(
          holder
            ? `Another update is already running on this install (pid ${holder.pid}, ${holder.operation}).\n`
              + '  Wait for it to finish, or if that process is gone, remove:\n'
              + `    ${leasePath}`
            : 'Another update is already running on this install.',
        );
        process.exitCode = 1;
        return;
      }

      // Re-check the realm after winning exclusion: a server can start between
      // the first glance and this claim, but boot now contends on the same lease.
      const holderUnderLease = liveServerHolding(dbPath);
      if (holderUnderLease) {
        refuseWhileRunning(holderUnderLease, verb);
        return;
      }
      options.bootTrace?.markDbOpenAttempted('configured-db-path');
      db = await openDatabase(dbPath);
      dbClosed = false;
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      options.bootTrace?.mark('db-opened');

      const releaseCheckDeps = buildReleaseCheckDeps({
        db,
        currentVersion: options.serverVersion,
        env,
      });
      if (!releaseCheckDeps) {
        console.log('Updates are not supported on this platform.');
        return;
      }

      let applyCommitted: Promise<void> = Promise.resolve();
      const applyDeps = buildCliApplyDeps({
        db,
        releaseCheckDeps,
        env,
        // Asked at CALL time: the rollback branch closes the db between here and
        // there, which is exactly what makes the restore safe.
        holdsDatabaseOpen: () => !dbClosed,
        captureCommit: (committed) => { applyCommitted = committed; },
      });
      if (!applyDeps) {
        console.error(
          `This install cannot apply updates to itself (channel \`${resolveDistributionChannel(env)}\`).\n` +
            'Re-run the installer for your platform instead.',
        );
        process.exitCode = 2;
        return;
      }

      // ⛔ See `runningAsPackagedBinary`. The channel says `binary` by DEFAULT,
      // including from a source checkout, where the apply target would be the
      // owner's node runtime.

      if (wantsRollback) {
        const ctx = applyDeps.rollbackContext();
        if (!ctx) {
          console.log('Nothing to roll back — no previously committed update on this install.');
          return;
        }
        // ⛔⛔ CLOSE FIRST, AND CLOSE HERE. A `restore-snapshot` rollback replaces
        // the database FILE, and doing that under an open handle leaves this
        // process reading an unlinked inode and accepting writes that vanish
        // (reproduced 2026-08-31). `refuseWhileRunning` above already proved no
        // OTHER process holds this realm, so ours is the last handle — and it is
        // ours to drop. Everything the rollback still needs is file-level
        // (existsSync, renames, the JSONL ledger), and the db path was captured
        // when the ports were built.
        db.close();
        dbClosed = true;
        printRollback(runRollback(applyDeps.ports, ctx));
        return;
      }

      const resolved = await applyDeps.resolveForApply();
      if (resolved.status !== 'applyable') {
        printNotApplyable(
          resolved.status,
          resolveDistributionChannel(env),
          'detail' in resolved && typeof resolved.detail === 'string' ? resolved.detail : undefined,
        );
        return;
      }
      // ── I-4: a major bump is notify-only until explicitly forced ─────────
      // ⛔ THE RPC HAS ALWAYS REQUIRED `force` HERE AND THE CLI REQUIRED NOTHING,
      // so an in-cohort non-interactive `recued update apply` could cross a major
      // version that the web path refuses without a second, deliberate click.
      // Two actuators, one policy, enforced in one of them.
      if (resolved.isMajor && !getFlag(options.args, 'force')) {
        console.error(
          `Version ${resolved.toVersion} is a MAJOR update from ${resolved.fromVersion}.\n`
          + '  Major versions are never applied automatically (I-4). Re-run with --force to\n'
          + '  take it deliberately, after reading the release notes.',
        );
        process.exitCode = 1;
        return;
      }

      // ── Staged rollout: say so, and let a human decline ──────────────────
      // The spec calls an out-of-cohort manual apply "an EXPLICIT, confirmed,
      // audited act". It was none of the three: the wire did not carry
      // `rollout_pct`, nothing rendered cohort state, and `trigger: 'manual'` was
      // the whole record.
      //
      // ⚠ ASKED, NOT REFUSED — and that is deliberate, permanently. `rollout_pct` is 0 on the
      // live stable channel today, so EVERY install is outside the cohort; a hard
      // gate here would stop every owner from updating. So: state it, ask when a
      // human is there to answer, and audit it either way.
      if (!resolved.inRolloutCohort) {
        console.log(
          `This release is in staged rollout (${resolved.rolloutPct}%) and this install `
          + 'is not in the cohort yet.',
        );
        if (getFlag(options.args, 'yes')) {
          console.log('  --yes given — installing early and recording it as a bypass.');
        } else if (process.stdin.isTTY === true) {
          const answer = await promptYesNo('Install it anyway? [y/N] ');
          if (!answer) {
            console.log('Nothing installed. It will be offered automatically once the rollout reaches this install.');
            return;
          }
        } else {
          // ⛔ NO TERMINAL AND NO `--yes` IS A REFUSAL, NOT A PROCEED. This used
          // to print a note and carry on, which meant the one caller that CANNOT
          // be asked — cron, a pipeline — was the one that never confirmed
          // anything. The spec calls the bypass "an EXPLICIT, confirmed" act, and
          // a confirmation nobody can decline is neither.
          //
          // ⚠ THIS CAN BREAK AN EXISTING UNATTENDED UPDATE, and that is the
          // point: with `rollout_pct` at 0 every install is outside the cohort,
          // so an unattended `recued update apply` today IS an unreviewed early
          // adoption of every release. The flag is named in the message so the
          // fix is one word.
          console.error(
            'This release is in staged rollout and this install is not in the cohort. '
            + 'There is no terminal to confirm on, so nothing was installed.\n'
            + '  Pass --yes to take it early on purpose (it is recorded as a bypass), '
            + 'or wait for the rollout to reach this install.',
          );
          process.exitCode = 1;
          return;
        }
      }
      const result = await runApply(applyDeps.ports, {
        releaseIdentity: resolved.releaseIdentity,
        fromVersion: resolved.fromVersion,
        toVersion: resolved.toVersion,
        channel: resolved.channel,
        migration: resolved.migration,
        artifact: resolved.artifact,
        libArtifact: resolved.libArtifact,
        webclientArtifact: resolved.webclientArtifact,
        trigger: 'manual',
        ...(resolved.inRolloutCohort
          ? {}
          : { rolloutBypass: { rolloutPct: resolved.rolloutPct, clientConfirmed: true } }),
      });
      // ⛔ WAIT FOR THE COMMIT, THEN REPORT WHAT ACTUALLY HAPPENED. `restarting` is
      // now the ACCEPTANCE — the snapshot + swap run in the callback above, after
      // `runApply` has returned. On a live server that outcome rides the ledger
      // and `update.progress`; here there is a person reading stdout, so telling
      // them "Staged 26.9.1 → 26.9.2" for a commit that failed and terminated the
      // operation would be a plain lie, and one they would only discover by
      // starting a server that is still on the old release.
      await applyCommitted;
      const outcome = resolveCliApplyOutcome(result, applyDeps.ports.ledger);
      // Is there an outer supervisor beside the binary? `install.sh` writes
      // `recued-supervise` only when it arms a unit, so its presence is exactly
      // the question "will something count a payload that never starts".
      const supervised = existsSync(
        join(dirname(resolveUpdateBinaryPath(env)), 'recued-supervise'),
      );
      printApply(outcome, resolved.fromVersion, resolved.toVersion, supervised);
    } finally {
      // The rollback path closes early and on purpose; closing twice throws.
      if (db !== null && !dbClosed) db.close();
      updateLease?.release();
    }
    return;
  }
  if (sub !== 'check') {
    console.error(
      `Unknown subcommand \`recued update ${sub}\`.\n` +
        '  recued update            check for a newer release\n' +
        '  recued update apply      install it (server must be stopped)\n' +
        '  recued update rollback   go back to the previous binary',
    );
    process.exitCode = 2;
    return;
  }

  options.bootTrace?.markDbOpenAttempted('configured-db-path');
  const db = await openDatabase(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    options.bootTrace?.mark('db-opened');

    const deps = buildReleaseCheckDeps({ db, currentVersion: options.serverVersion, env });
    if (!deps) {
      console.log('Updates are not supported on this platform.');
      return;
    }
    const res = await runReleaseCheck(deps);
    printCheck(res, resolveDistributionChannel(env));
  } finally {
    db.close();
  }
}

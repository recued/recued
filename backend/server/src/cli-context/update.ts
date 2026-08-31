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
 *  instance lock and points at the surface that CAN restart itself
 *  (webclient → Settings → Updates).
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

import { dirname, join, resolve as resolvePath } from 'node:path';
import { getArg, getFlag, parsePositionals } from '../cli/parse.js';
import { runningAsPackagedBinary } from '../packaged-binary.js';
import { createInstanceLock, type LockInfo } from '../lifecycle/instance-lock.js';
import { runApply, runRollback } from '../update/apply-orchestrator.js';
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
const applyGuidance = (channel: DistributionChannel): string => {
  if (selfApplies(channel)) {
    // Both paths, in the order most owners want them. The webclient one is
    // still preferable when the server is up — it restarts itself; the CLI one
    // is what remains when it cannot be reached, which is exactly when an
    // owner is reading this in a terminal.
    return 'Apply it from the webclient (Settings → Updates), or stop the server and run: recued update apply';
  }
  if (channel === 'docker-baked') {
    return 'This install updates by re-pulling the pinned image — see the release notes for the new digest.';
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
      console.log(`  ${applyGuidance(channel)}`);
      if (a.notes_url) console.log(`  Release notes: ${a.notes_url}`);
      return;
    }
    case 'not-configured':
      console.log(`${head} — update checks are not available on this build yet (no signing key).`);
      return;
    case 'stale-feed':
      console.log(`${head} — the release feed is stale (past its freshness window). Not acting on it.`);
      return;
    case 'launcher-outdated':
      console.log(`${head} — the launcher is too old to apply updates; update the launcher first.`);
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

/** Is a live server holding this realm?
 *
 *  ⛔ THE INSTANCE LOCK, NOT A PIDFILE AND NOT `pgrep`. The daemon pidfile only
 *  exists when the server was started via `recued start`; a foreground
 *  `recued serve` — what the banner, the docs and the installer all tell owners
 *  to run — writes none, so a pidfile check reports "not running" for the
 *  common case. `pgrep` would see any process named `recued`, including one
 *  serving a DIFFERENT database, and does not exist on Windows.
 *
 *  The lock is written by the serve path itself
 *  (`compose-lifecycle.ts`: `dataPath = dirname(dbPath)`), so it answers the
 *  question actually being asked: is anything running on THE REALM I am about
 *  to update. Derived here the same way, from the same `dbPath`.
 *
 *  ⚠ `lifecycle.lock_file` exists in the config schema as an override and is
 *  read NOWHERE (verified 2026-08-27), so the fallback below is the only path
 *  production takes. If that setting is ever wired, this must honour it or the
 *  guard silently stops firing. */
const liveServerHolding = (dbPath: string): LockInfo | null => {
  const lockPath = join(dirname(resolvePath(dbPath)), 'recued-server.lock');
  const info = createInstanceLock({ lockPath }).inspect();
  if (!info) return null;
  return pidAlive(info.pid) ? info : null;
};

/** `process.kill(pid, 0)` liveness.
 *
 *  ⚠ EPERM MEANS ALIVE. The signal is refused because the process belongs to
 *  another user — which is precisely a case we must treat as running. Only
 *  ESRCH (no such process) means the lock is stale. Getting this backwards
 *  would let an apply proceed under a live server owned by someone else. */
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Refuse, and say which restart path this install actually has. */
const refuseWhileRunning = (holder: LockInfo, sub: string): void => {
  console.error(
    `A Recued server is running on this realm (pid ${holder.pid}, port ${holder.bind_port}).\n` +
      `\`recued update ${sub}\` swaps the binary on disk and cannot restart a live daemon, so it\n` +
      'refuses rather than leaving you on the old process believing it applied.\n' +
      '\n' +
      'Either:\n' +
      '  · let the server do it — webclient → Settings → Updates (it stages and restarts itself), or\n' +
      '  · stop the server, run this again, then start it the same way you started it.',
  );
  process.exitCode = 2;
};

/** ⚠ SAYS "STAGED", NOT "UPDATED". `runApply` returns `restarting` because on
 *  the server that is what happens next; here nothing restarts, and the swap is
 *  only half the operation — `boot-reconcile` COMMITS it on the first
 *  successful boot and rolls it back automatically if the new binary fails to
 *  start. Reporting "updated" would claim a result that has not been reached,
 *  and the owner would have no reason to start the server. */
const printApply = (result: Awaited<ReturnType<typeof runApply>>, from: string, to: string): void => {
  switch (result.status) {
    case 'restarting':
      console.log(`Staged ${from} → ${to}.`);
      console.log('');
      console.log('  Start the server to complete it. The update commits on the first successful');
      console.log('  boot, and rolls back on its own if the new binary fails to start.');
      // ⚠ NOT "undo it with rollback" — measured 2026-08-27, `rollbackContext()`
      // is null until the apply COMMITS on that first boot, so telling an owner
      // to roll back now sends them to "Nothing to roll back" and leaves them
      // believing the update cannot be undone.
      console.log('  After it has started once, `recued update rollback` returns to the previous');
      console.log('  binary. Before then, the previous one is preserved beside it as `recued.old`.');
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
      console.log('Rolled back to the previous binary.');
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
const printNotApplyable = (status: string, channel: string): void => {
  switch (status) {
    case 'up-to-date':
      console.log('Already on the newest release for this channel.');
      return;
    case 'not-configured':
      console.log('No trusted release key is wired into this build; updates are unavailable.');
      return;
    case 'no-artifact':
      console.error(`The newest release publishes no binary for this platform (channel \`${channel}\`).`);
      break;
    case 'fetch-failed':
      console.error('Could not fetch the release manifest. Check network access to releases.recued.com.');
      break;
    case 'bad-signature':
      console.error('The release manifest FAILED signature verification — refusing to go further.');
      break;
    case 'stale-feed':
      console.error('The release feed is stale (its freshness window has expired); refusing to apply.');
      break;
    case 'replay':
      console.error('The release feed went backwards (anti-replay floor); refusing to apply.');
      break;
    case 'launcher-outdated':
      console.error('This install needs a newer launcher before it can take this release.');
      break;
    default:
      console.error(`Cannot apply: ${status}`);
  }
  process.exitCode = 1;
};

export async function runUpdateProfile(options: UpdateProfileOptions): Promise<void> {
  const env = options.env ?? process.env;
  const positionals = parsePositionals(options.args);
  const sub = positionals[1] ?? 'check';
  const dbPath = resolveRealmDbPath(getArg(options.args, 'db') ?? env.DB_PATH);

  // `--apply` / `--rollback` accepted as aliases for the subcommands: the flag
  // form is what people reach for after reading about it, and accepting both
  // costs one line against a confusing "unknown subcommand" for a spelling.
  const wantsRollback = sub === 'rollback' || getFlag(options.args, 'rollback');
  const wantsApply = !wantsRollback && (sub === 'apply' || getFlag(options.args, 'apply'));

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

    options.bootTrace?.markDbOpenAttempted('configured-db-path');
    const db = await openDatabase(dbPath);
    try {
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

      const applyDeps = buildApplyOrchestratorDeps({
        db,
        releaseCheckDeps,
        // Nothing to hand off to. The CLI *is* the process, and we refused above
        // if a server were running — so there is no daemon whose lifetime we
        // could own. The owner starts it again themselves, with their own
        // invocation, which is the only one that knows their DB_PATH and cwd.
        requestRestart: () => {},
        // Trivially true: nothing is running on this realm. Only consulted for
        // `auto` triggers anyway; this path is always `manual`.
        isQuiesced: () => true,
        env,
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
      if (resolveDistributionChannel(env) === 'binary' && !runningAsPackagedBinary()) {
        console.error(
          'This is not the packaged Recued binary — it is running under Node (a source\n' +
            'checkout or an npm install), where the update target would be the node\n' +
            'executable itself. Refusing.\n' +
            '\n' +
            '  source checkout: git pull && npm ci && npm run build:server\n' +
            '  npm install:     npm i -g @recued/server@latest',
        );
        process.exitCode = 2;
        return;
      }

      if (wantsRollback) {
        const ctx = applyDeps.rollbackContext();
        if (!ctx) {
          console.log('Nothing to roll back — no previously committed update on this install.');
          return;
        }
        printRollback(runRollback(applyDeps.ports, ctx));
        return;
      }

      const resolved = await applyDeps.resolveForApply();
      if (resolved.status !== 'applyable') {
        printNotApplyable(resolved.status, resolveDistributionChannel(env));
        return;
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
      });
      printApply(result, resolved.fromVersion, resolved.toVersion);
    } finally {
      db.close();
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

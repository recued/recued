#!/usr/bin/env node
/** recued-server production router.
 *
 *  Keeps command/profile selection side-effect-light. Profile-specific
 *  boot work lives behind dynamic imports.
 */

import { setRole } from '@recued/contracts';
import { copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { classifyBootProfile, createBootTrace, type BootCommandProfile } from './cli/boot-trace.js';
import { FLAGS_WITH_VALUES, getArg, getFlag, parsePositionals } from './cli/parse.js';
import { SERVER_VERSION } from './server-version.js';

setRole('server');

const KNOWN_SUBCOMMANDS = new Set([
  'start',
  'stop',
  'status',
  'restart',
  'logs',
  'auth-status',
  'unlock',
  'lock',
  'pair',
  'audit',
  'llm',
  'archive',
  'update',
  'serve',
  // ⛔⛔ THESE THREE WERE DISPATCHED BELOW AND UNREACHABLE FROM THE CLI. A
  // subcommand missing from this set is `unknownSubcommand`, which forces
  // `help: true`, which makes `classifyBootProfile` answer 'none' — so the
  // `case` in the switch below can never be entered and the command silently
  // prints the help screen instead. Verified by running the built binary, not
  // by reading it: `recued recover-keyfile` printed help.
  //
  // 🔑 `recover-keyfile` is the D-212 emergency path, whose own profile comment
  // says it exists "because it must run when the server cannot boot" — so the
  // one command written for the worst day was the one that did not work. Same
  // shape as the `--token` note in `cli/parse.ts`: the context module was
  // correct and complete, and nothing upstream ever let a caller reach it.
  //
  // `cli-router-reachability.test.ts` now derives this set from the switch
  // itself, so the next one is caught without anybody remembering this comment.
  'recover-keyfile',
  'rotate-passphrase',
  'report-boot-failure',
  'revert-release',
  'self-test',
  'update-lease',
  'release-floor',
]);

const args = process.argv.slice(2);
const positionals = parsePositionals(args);
const subcommand = positionals[0];
const versionRequested = getFlag(args, 'version') || getFlag(args, 'v');
const helpRequested = getFlag(args, 'help') || getFlag(args, 'h');
const unknownSubcommand = subcommand !== undefined && !KNOWN_SUBCOMMANDS.has(subcommand);
const mcpRequested = getFlag(args, 'mcp');

const profile: BootCommandProfile = classifyBootProfile({
  subcommand,
  version: versionRequested,
  help: helpRequested || unknownSubcommand,
  mcp: mcpRequested,
});

const commandLabel = versionRequested
  ? '--version'
  : helpRequested
    ? '--help'
    : mcpRequested
      ? '--mcp'
      : (subcommand ?? 'serve');

const bootTrace = createBootTrace({
  entrypoint: 'bin',
  profile,
  command: commandLabel,
  env: process.env,
});
bootTrace.mark('cli-parsed');

const showHelp = async (): Promise<void> => {
  bootTrace.markImport('./commands/help.js');
  const { cmdHelp } = await import('./commands/help.js');
  cmdHelp();
};

const stripServeSubcommand = (inputArgs: string[]): string[] => {
  for (let i = 0; i < inputArgs.length; i++) {
    const arg = inputArgs[i];
    if (FLAGS_WITH_VALUES.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith('--')) continue;
    if (arg !== 'serve') return inputArgs;
    return [...inputArgs.slice(0, i), ...inputArgs.slice(i + 1)];
  }
  return inputArgs;
};

const failUnmigratedProfile = (name: BootCommandProfile): void => {
  console.error(
    `recued router has not migrated profile '${name}' yet.`,
  );
  process.exitCode = 1;
};

const dispatch = async (): Promise<void> => {
  bootTrace.mark('dispatch-start');

  if (versionRequested) {
    bootTrace.mark('dispatch-version');
    console.log(SERVER_VERSION);
    return;
  }

  if (helpRequested || unknownSubcommand) {
    bootTrace.mark('dispatch-help', unknownSubcommand ? commandLabel : undefined);
    await showHelp();
    return;
  }

  bootTrace.mark('dispatch-profile', profile);

  switch (profile) {
    case 'none':
      await showHelp();
      return;
    case 'serve': {
      // ⛔⛔⛔ BEFORE THE MODULE GRAPH THAT LOADS THE NATIVE ADDON. Both the
      // apply and rollback pair-swaps span several atomic renames; their in-memory
      // compensation disappears on SIGKILL or power loss. The recovery reads the
      // stable apply/rollback asides and finishes or unwinds the interrupted pair
      // before any code can try to load a missing or mismatched addon.
      //
      // 🔑 IT HAS TO RUN HERE AND NOWHERE DEEPER. `open-database.ts` imports the
      // native binding at MODULE INIT, so anything that imports it dies on the
      // missing file before a line of recovery could run. `bin.ts` statically
      // imports none of that graph, and the recovery is a leaf, so this is the
      // last point that still executes when the addon is gone.
      //
      // ⚠ Two `existsSync` calls on a healthy install; it does work only when a
      // rollback left its asides behind.
      bootTrace.markImport('./update/install-paths.js');
      const [
        { resolveUpdateBinaryPath },
        {
          reconcileInterruptedPairSwap,
          restoreSnapshot,
          rollbackCandidatePaths,
          rollbackSwap,
          sidecarPathsFor,
        },
        { clearWebclientApplyJournal },
        { acquireUpdateLease, updateLeasePathFor, UpdateLeaseHeldError },
        { installEarlyBootUpdateLease, releaseEarlyBootUpdateLease },
      ] =
        await Promise.all([
          import('./update/install-paths.js'),
          import('./update/binary-apply-executor.js'),
          import('./update/webclient-sync.js'),
          import('./update/update-lease.js'),
          import('./update/early-boot-update-lease.js'),
        ]);
      const binaryPath = resolveUpdateBinaryPath(process.env);
      let earlyBootLease;
      try {
        earlyBootLease = acquireUpdateLease({
          leasePath: updateLeasePathFor(binaryPath),
          operation: 'boot-reconcile',
        });
      } catch (err) {
        if (!(err instanceof UpdateLeaseHeldError)) throw err;
        console.error(
          `[recued] an update is in progress on this install (pid ${err.holder.pid}, `
          + `${err.holder.operation}) — not starting until it finishes.`,
        );
        process.exitCode = 4;
        return;
      }
      installEarlyBootUpdateLease(earlyBootLease);
      try {
        const sidecarPaths = sidecarPathsFor(binaryPath, process.env);
        const recovered = reconcileInterruptedPairSwap(
          `${binaryPath}.old`,
          binaryPath,
          sidecarPaths,
        );
        if (recovered.action !== 'none') {
          console.error(
            `[recued] reconciled an interrupted update swap (${recovered.action}) — `
            + 'the executable and native addon are paired again.',
          );
        }

        // ⛔ DATABASE RECOVERY MUST PRECEDE THE DATABASE MODULE GRAPH. A stopped
        // CLI rollback restores the snapshot before it swaps the binary. If it
        // dies between those steps, opening SQLite here would migrate/serve the
        // old snapshot under the current binary and erase the only safe point
        // at which its retained current-generation undo can be restored.
        //
        // Pair-swap recovery runs first because its exact live binary hash is
        // the transaction direction. Both recoveries share the host lease, and
        // this process exits when the previous pair won so it never continues
        // executing current in-memory bytes over an older on-disk install.
        const serveArgs = stripServeSubcommand(args);
        const [
          { resolveRealmDbPath },
          { realmSnapshotPath },
          { manualRollbackJournalTarget },
          { recoverManualRollbackBeforeOpen },
          { recoverAbortedWebclientBeforeServe },
          { createUpdateLedger, UPDATE_LEDGER_FILE },
          { webclientBundleDirForDataDir },
        ] = await Promise.all([
          import('./realm-db-path.js'),
          import('./update/realm-generation-snapshot.js'),
          import('./update/manual-rollback-journal.js'),
          import('./update/manual-rollback-recovery.js'),
          import('./update/preopen-webclient-recovery.js'),
          import('./update/update-ledger.js'),
          import('./webclient-bundle-loader.js'),
        ]);
        const dbPath = resolveRealmDbPath(
          getArg(serveArgs, 'db') ?? process.env.DB_PATH,
          // Resolution only: normal composition creates/announces a new realm.
          // Recovery must not mutate the filesystem before it knows whether a
          // retained journal forbids the boot.
          { mkdir: () => {}, note: () => {} },
        );
        const dataDir = dirname(resolve(dbPath));
        const webclientDir = webclientBundleDirForDataDir(
          dataDir,
          process.env.RECUED_WEBCLIENT_DIR,
        );
        const updateLedger = createUpdateLedger(join(dataDir, UPDATE_LEDGER_FILE));
        const manualRollbackTarget = manualRollbackJournalTarget({
          dataDir,
          dbPath,
          binaryPath,
          snapshotPath: realmSnapshotPath(dbPath),
          previousBinaryPath: `${binaryPath}.old`,
          previousGenerationPaths: rollbackCandidatePaths(
            `${binaryPath}.old`,
            sidecarPaths,
          ),
        });
        const manualRecovery = recoverManualRollbackBeforeOpen({
          target: manualRollbackTarget,
          ledger: updateLedger,
          restoreDatabase: (sourcePath, targetPath) =>
            restoreSnapshot(sourcePath, targetPath, (from, to) => copyFileSync(from, to)),
          completeRollbackSwap: () => {
            rollbackSwap(
              `${binaryPath}.old`,
              binaryPath,
              sidecarPaths,
              webclientDir,
            );
            clearWebclientApplyJournal(webclientDir);
          },
        });
        if (manualRecovery.action === 'refused') {
          console.error(
            `[recued] manual rollback recovery refused before database open: ${manualRecovery.reason}`,
          );
          console.error(`[recued] retained ${manualRollbackTarget.journalPath} for recovery.`);
          process.exitCode = 74;
          return;
        }
        if (manualRecovery.action === 'completed') {
          console.error(`[recued] ${manualRecovery.reason}; restarting on the previous release.`);
          process.exitCode = 75;
          return;
        }
        if (manualRecovery.action === 'aborted') {
          console.error(`[recued] ${manualRecovery.reason}; continuing on the current release.`);
        }
        // ⛔ BEFORE `serve-entry`: listener composition loads the verified bundle
        // into a closure. Recovering only in post-boot reconciliation changes the
        // disk but leaves this process serving the promoted, wrong-generation UI.
        const webclientRecovery = recoverAbortedWebclientBeforeServe({
          ledger: updateLedger,
          currentVersion: SERVER_VERSION,
          targetDir: webclientDir,
        });
        if (webclientRecovery.action === 'refused') {
          console.error(
            `[recued] aborted webclient recovery refused before serve: ${webclientRecovery.reason}`,
          );
          console.error(
            `[recued] retained the webclient apply journal for ${webclientRecovery.releaseIdentity}.`,
          );
          process.exitCode = 74;
          return;
        }
        if (webclientRecovery.action === 'recovered') {
          console.error(
            `[recued] restored the prior webclient before serving after aborted ${webclientRecovery.releaseIdentity}.`,
          );
        }
        bootTrace.markImport('./serve-entry.js');
        const { serve } = await import('./serve-entry.js');
        await serve(serveArgs);
      } finally {
        // Normal boot consumes this immediately after claiming the realm. This
        // fallback covers any failure before that handoff (including addon load).
        releaseEarlyBootUpdateLease();
      }
      return;
    }
    case 'pair': {
      bootTrace.markImport('./cli-context/pair.js');
      const { runPairProfile } = await import('./cli-context/pair.js');
      await runPairProfile({ args, bootTrace });
      return;
    }
    case 'audit': {
      bootTrace.markImport('./cli-context/audit.js');
      const { runAuditProfile } = await import('./cli-context/audit.js');
      await runAuditProfile({ args, bootTrace });
      return;
    }
    case 'llm': {
      bootTrace.markImport('./cli-context/llm.js');
      const { runLlmProfile } = await import('./cli-context/llm.js');
      await runLlmProfile({ args, bootTrace });
      return;
    }
    case 'mcp': {
      bootTrace.markImport('./cli-context/mcp.js');
      const { runMcpProfile } = await import('./cli-context/mcp.js');
      await runMcpProfile({ args, bootTrace });
      return;
    }
    case 'archive': {
      bootTrace.markImport('./cli-context/archive.js');
      const { runArchiveProfile } = await import('./cli-context/archive.js');
      await runArchiveProfile({ args, bootTrace, serverVersion: SERVER_VERSION });
      return;
    }
    case 'update': {
      // ⛔ STAGED ROLLBACK BEFORE THE SQLITE GRAPH. The release on trial may be
      // failing because its native addon cannot load on this host. Importing the
      // ordinary update profile first would load that exact component before the
      // owner-facing recovery command could put the previous pair back.
      const wantsRollback = positionals[1] === 'rollback' || getFlag(args, 'rollback');
      if (wantsRollback) {
        bootTrace.markImport('./cli-context/update-staged-rollback.js');
        const { tryRunStagedUpdateRollback } =
          await import('./cli-context/update-staged-rollback.js');
        if (await tryRunStagedUpdateRollback({
          args,
          bootTrace,
          env: process.env,
          serverVersion: SERVER_VERSION,
        })) return;
      }
      bootTrace.markImport('./cli-context/update.js');
      const { runUpdateProfile } = await import('./cli-context/update.js');
      await runUpdateProfile({
        args,
        bootTrace,
        serverVersion: SERVER_VERSION,
      });
      return;
    }
    case 'recover-keyfile': {
      bootTrace.markImport('./cli-context/recover-keyfile.js');
      const { runRecoverKeyfileProfile } = await import('./cli-context/recover-keyfile.js');
      await runRecoverKeyfileProfile({ args, bootTrace });
      return;
    }
    case 'report-boot-failure': {
      bootTrace.markImport('./cli-context/report-boot-failure.js');
      const { runReportBootFailureProfile } = await import('./cli-context/report-boot-failure.js');
      await runReportBootFailureProfile({ args, bootTrace });
      return;
    }
    case 'revert-release': {
      bootTrace.markImport('./cli-context/revert-release.js');
      const { runRevertReleaseProfile } = await import('./cli-context/revert-release.js');
      await runRevertReleaseProfile({ args, bootTrace });
      return;
    }
    case 'self-test': {
      bootTrace.markImport('./cli-context/self-test.js');
      const { runSelfTestProfile } = await import('./cli-context/self-test.js');
      await runSelfTestProfile({ args, bootTrace });
      return;
    }
    case 'update-lease': {
      bootTrace.markImport('./cli-context/update-lease.js');
      const { runUpdateLeaseProfile } = await import('./cli-context/update-lease.js');
      await runUpdateLeaseProfile({ args, bootTrace });
      return;
    }
    case 'release-floor': {
      bootTrace.markImport('./cli-context/release-floor.js');
      const { runReleaseFloorProfile } = await import('./cli-context/release-floor.js');
      await runReleaseFloorProfile({ args, bootTrace });
      return;
    }
    case 'rotate-passphrase': {
      bootTrace.markImport('./cli-context/rotate-passphrase.js');
      const { runRotatePassphraseProfile } = await import('./cli-context/rotate-passphrase.js');
      await runRotatePassphraseProfile({ args, bootTrace });
      return;
    }
    case 'daemon': {
      bootTrace.markImport('./cli-context/daemon.js');
      const { runDaemonProfile } = await import('./cli-context/daemon.js');
      await runDaemonProfile({ args, bootTrace });
      return;
    }
    case 'command':
      failUnmigratedProfile(profile);
      return;
  }
};

dispatch()
  .then(() => {
    bootTrace.finish('dispatch-complete');
  })
  .catch((e) => {
    bootTrace.finish('dispatch-error', e instanceof Error ? e.message : String(e));
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });

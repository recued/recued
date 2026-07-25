#!/usr/bin/env node
/** recued-server production router.
 *
 *  Keeps command/profile selection side-effect-light. Profile-specific
 *  boot work lives behind dynamic imports.
 */

import { setRole } from '@recued/contracts';
import { classifyBootProfile, createBootTrace, type BootCommandProfile } from './cli/boot-trace.js';
import { FLAGS_WITH_VALUES, getFlag, parsePositionals } from './cli/parse.js';
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
      bootTrace.markImport('./serve-entry.js');
      const { serve } = await import('./serve-entry.js');
      await serve(stripServeSubcommand(args));
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
      bootTrace.markImport('./cli-context/update.js');
      const { runUpdateProfile } = await import('./cli-context/update.js');
      await runUpdateProfile({ args, bootTrace, serverVersion: SERVER_VERSION });
      return;
    }
    case 'recover-keyfile': {
      bootTrace.markImport('./cli-context/recover-keyfile.js');
      const { runRecoverKeyfileProfile } = await import('./cli-context/recover-keyfile.js');
      await runRecoverKeyfileProfile({ args, bootTrace });
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

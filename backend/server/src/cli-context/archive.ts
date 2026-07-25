import { dirname } from 'node:path';
import { loadConfig, type Distribution } from '@recued/config';
import { getArg } from '../cli/parse.js';
import type { BootTrace } from '../cli/boot-trace.js';
import { cmdArchive } from '../commands/archive.js';

export interface ArchiveProfileOptions {
  args: string[];
  bootTrace?: BootTrace;
  env?: NodeJS.ProcessEnv;
  serverVersion?: string;
}

const stripArchiveGlobals = (args: string[]): string[] => {
  const out: string[] = [];
  let seenArchive = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--db' || arg === '--config') {
      i++;
      continue;
    }
    if (arg.startsWith('--db=') || arg.startsWith('--config=')) continue;

    if (!seenArchive) {
      if (arg === 'archive') seenArchive = true;
      continue;
    }
    out.push(arg);
  }
  return out;
};

export async function runArchiveProfile(options: ArchiveProfileOptions): Promise<void> {
  const env = options.env ?? process.env;
  const dbPath = getArg(options.args, 'db') ?? env.DB_PATH ?? './recued-server.db';
  const distribution: Distribution =
    (env.RECUED_DISTRIBUTION as Distribution | undefined) ?? 'source';
  const loadedConfig = loadConfig({
    distribution,
    configPath: getArg(options.args, 'config'),
    argv: options.args,
    env,
  });
  options.bootTrace?.mark('config-loaded', loadedConfig.source ? 'file' : 'defaults');

  const archiveArgs = stripArchiveGlobals(options.args);
  if (archiveArgs[0] === 'export') {
    options.bootTrace?.markDbOpenAttempted('archive-export');
  }

  await cmdArchive(
    {
      dbPath,
      configPath: loadedConfig.source,
      dataPath: dirname(dbPath),
      serverVersion: options.serverVersion ?? env.npm_package_version ?? '0.0.0',
    },
    archiveArgs,
  );
}

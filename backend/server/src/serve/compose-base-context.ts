import {
  createRuntimeConfigStore,
  loadConfig,
  type Distribution,
  type LoadResult,
  type RuntimeConfigStore,
} from '@recued/config';

import {
  classifyBootProfile,
  createBootTrace,
  type BootCommandProfile,
  type BootTrace,
} from '../cli/boot-trace.js';
import { getArg, parsePositionals } from '../cli/parse.js';
import { resolveBindPort } from '../cli/resolve-bind-port.js';

export interface BaseVaultQuotas {
  perPublisherBytes?: number;
  totalBytes?: number;
}

export interface BaseContext {
  args: string[];
  positionals: string[];
  subcommand: string | undefined;
  bootProfile: BootCommandProfile;
  bootTrace: BootTrace;
  dbPath: string;
  port: number;
  distribution: Distribution;
  loadedConfig: LoadResult;
  runtimeConfig: RuntimeConfigStore;
  vaultQuotas: BaseVaultQuotas;
}

export interface ComposeBaseContextOptions {
  env?: Record<string, string | undefined>;
  now?: () => number;
  traceSink?: (line: string) => void;
}

export const composeBaseContext = (
  inputArgs: string[],
  options: ComposeBaseContextOptions = {},
): BaseContext => {
  const env = options.env ?? process.env;
  const args = inputArgs;
  const positionals = parsePositionals(args);
  const subcommand = positionals[0];
  const bootProfile = classifyBootProfile({
    subcommand,
    version: false,
    help: false,
    mcp: false,
  });
  const bootTrace = createBootTrace({
    entrypoint: 'serve-entry',
    profile: bootProfile,
    command: subcommand ?? 'serve',
    env,
    ...(options.now ? { now: options.now } : {}),
    ...(options.traceSink ? { sink: options.traceSink } : {}),
  });
  bootTrace.mark('cli-parsed');

  const dbPath = getArg(args, 'db') ?? env.DB_PATH ?? './recued-server.db';
  const distribution: Distribution =
    (env.RECUED_DISTRIBUTION as Distribution | undefined) ?? 'source';
  const loadedConfig = loadConfig({
    distribution,
    configPath: getArg(args, 'config'),
    argv: args,
    env,
  });
  // Effective bind port honours config.toml `bind_port` (CLI --port/--bind-port
  // > $PORT > config/preset). With no CLI/$PORT override this already equals
  // loadedConfig.bootstrap.bind_port, so the bootstrap snapshot matches the bound
  // port. We deliberately do NOT write an override back onto loadedConfig: the
  // config-watcher reloads from the file alone (no argv/$PORT replay), so a
  // mutated baseline would diff against the file and flag a spurious restart.
  const port = resolveBindPort({ args, env, loaded: loadedConfig });
  const runtimeConfig = createRuntimeConfigStore(
    loadedConfig.runtime,
    loadedConfig.source ? { path: loadedConfig.source } : {},
  );
  bootTrace.mark('config-loaded', loadedConfig.source ? 'file' : 'defaults');

  const vaultQuotas: BaseVaultQuotas = {
    perPublisherBytes: runtimeConfig.get('vault.quota.per_publisher_bytes') as number,
    totalBytes: runtimeConfig.get('vault.quota.total_bytes') as number,
  };

  return {
    args,
    positionals,
    subcommand,
    bootProfile,
    bootTrace,
    dbPath,
    port,
    distribution,
    loadedConfig,
    runtimeConfig,
    vaultQuotas,
  };
};

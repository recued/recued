/** Main entry point — merges preset defaults, TOML file, env vars, and
 *  CLI flags into a single `LoadedConfig`. Precedence is top-to-bottom:
 *
 *    1. Schema defaults (runtime) + universal bootstrap template.
 *    2. Distribution preset overlay (binary / source / server).
 *    3. User's config.toml (when present).
 *    4. Env vars (`RECUED_*`).
 *    5. CLI flags (`--config`, `--bind-port`, ...).
 *
 *  Each layer supplies a partial patch; the loader merges with a simple
 *  spread, so later layers overwrite specific keys without disturbing
 *  the rest. */

import { readFileSync, existsSync } from 'node:fs';

import { parseCliOverrides } from './cli.js';
import { envConfigPath, envOverrides } from './env.js';
import { parseToml, ConfigValidationError } from './parse.js';
import { defaultConfigPath, defaultDataPath, expandDataPath, expandHome } from './paths.js';
import { BOOTSTRAP_TEMPLATE, presetOverlay } from './presets.js';
import { runtimeDefaults } from './schema.js';
import type {
  BootstrapConfig,
  LoadOptions,
  LoadedConfig,
  RuntimeConfig,
} from './types.js';

export interface LoadResult extends LoadedConfig {
  /** Unknown `runtime.*` keys encountered in the user config. Surfaced
   *  for logging — the loader itself never throws on them. */
  unknownKeys: string[];
  /** List of env var names that contributed overrides — useful when
   *  `--print-config` wants to annotate each field with its source. */
  envApplied: string[];
}

export const loadConfig = (opts: LoadOptions): LoadResult => {
  const env = opts.env ?? process.env;

  // 1. Schema defaults + universal bootstrap template.
  const runtime: RuntimeConfig = { ...runtimeDefaults() } as RuntimeConfig;
  const dataPathDefault = defaultDataPath({
    home: env.HOME,
    xdgDataHome: env.XDG_DATA_HOME,
    appData: env.APPDATA,
  });
  const bootstrap: BootstrapConfig = {
    data_path: dataPathDefault,
    ...BOOTSTRAP_TEMPLATE,
  };

  // 2. Distribution preset overlay.
  const preset = presetOverlay(opts.distribution);
  Object.assign(bootstrap, preset.bootstrap);
  Object.assign(runtime, preset.runtime);

  // 3. User config.toml. CLI flag > env var > OS default.
  const cli = parseCliOverrides(opts.argv ?? []);
  const configPath =
    cli.configPath ??
    opts.configPath ??
    envConfigPath(env) ??
    defaultConfigPath({
      home: env.HOME,
      xdgConfigHome: env.XDG_CONFIG_HOME,
      appData: env.APPDATA,
    });

  let source: string | null = null;
  let unknownKeys: string[] = [];
  const resolvedPath = expandHome(configPath, env.HOME ?? undefined);
  if (existsSync(resolvedPath)) {
    const text = readFileSync(resolvedPath, 'utf8');
    const { parsed, unknown } = parseToml(text);
    unknownKeys = unknown;
    if (parsed.bootstrap) Object.assign(bootstrap, parsed.bootstrap);
    if (parsed.runtime) Object.assign(runtime, parsed.runtime);
    source = resolvedPath;
  }

  // 4. Env vars.
  const envPatch = envOverrides(env);
  Object.assign(bootstrap, envPatch.bootstrap);
  Object.assign(runtime, envPatch.runtime);
  const envApplied = collectEnvNames(env);

  // 5. CLI flag overrides.
  Object.assign(bootstrap, cli.bootstrap);

  // Post-process: expand `{data_path}` in bootstrap paths AFTER all
  // overrides landed, so overriding data_path via env/CLI still
  // propagates into log_path.
  bootstrap.log_path = expandDataPath(bootstrap.log_path, bootstrap.data_path);

  return {
    bootstrap,
    runtime,
    source,
    distribution: opts.distribution,
    unknownKeys,
    envApplied,
  };
};

const collectEnvNames = (env: Record<string, string | undefined>): string[] => {
  const out: string[] = [];
  for (const name of Object.keys(env)) {
    if (name.startsWith('RECUED_BOOTSTRAP_') || name.startsWith('RECUED_RUNTIME_')) {
      out.push(name);
    }
  }
  return out;
};

export { ConfigValidationError };

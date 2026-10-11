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

import {
  renamedWebhookPortNotice,
  retiredSetting,
  type RetiredSetting,
} from './bootstrap-keys.js';
import { parseCliOverrides } from './cli.js';
import {
  envConfigPath,
  envOverrides,
  isLegacyWebhookPortEnv,
  matchBootstrapKey,
} from './env.js';
import { parseToml, ConfigValidationError } from './parse.js';
import { defaultConfigPath, expandHome } from './paths.js';
import { BOOTSTRAP_TEMPLATE, presetOverlay } from './presets.js';
import { RETIRED_RUNTIME_SETTINGS, runtimeDefaults } from './schema.js';
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
  /** Settings written OUTSIDE `[runtime]` / `[bootstrap]` that resolve to a
   *  REAL schema key — valid TOML that applies nothing. Each entry names the
   *  key and the table it belongs under. See `parseToml`. */
  misplacedKeys: string[];
  /** Removed `[bootstrap]` settings (`bootstrap-keys.ts`) and removed runtime
   *  settings (`RETIRED_RUNTIME_SETTINGS`) that the config file or the
   *  environment still sets — ignored, each with what does its job now, so boot
   *  can say so instead of letting them read as applied. */
  retiredSettings: RetiredSetting[];
  /** Settings used under an old name that still works — today `webhook_port`
   *  (file), `RECUED_BOOTSTRAP_WEBHOOK_PORT` (env) and `--webhook-port` (flag),
   *  all now `webhooks_enabled`. Each says how the value was read. */
  renamedSettings: RetiredSetting[];
  /** List of env var names that contributed overrides — useful when
   *  `--print-config` wants to annotate each field with its source. */
  envApplied: string[];
}

export const loadConfig = (opts: LoadOptions): LoadResult => {
  const env = opts.env ?? process.env;

  // 1. Schema defaults + universal bootstrap template.
  const runtime: RuntimeConfig = { ...runtimeDefaults() } as RuntimeConfig;
  const bootstrap: BootstrapConfig = { ...BOOTSTRAP_TEMPLATE };

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
  let misplacedKeys: string[] = [];
  const retiredSettings: RetiredSetting[] = [];
  const renamedSettings: RetiredSetting[] = [];
  const resolvedPath = expandHome(configPath, env.HOME ?? undefined);
  if (existsSync(resolvedPath)) {
    const text = readFileSync(resolvedPath, 'utf8');
    const { parsed, unknown, misplaced, retired, retiredRuntime, renamed } = parseToml(text);
    unknownKeys = unknown;
    misplacedKeys = misplaced;
    for (const key of retired) {
      const gone = retiredSetting(`bootstrap.${key}`, key);
      if (gone) retiredSettings.push(gone);
    }
    for (const key of retiredRuntime) {
      const replacement = RETIRED_RUNTIME_SETTINGS.get(key);
      if (replacement !== undefined) retiredSettings.push({ name: `runtime.${key}`, replacement });
    }
    for (const r of renamed) {
      renamedSettings.push(renamedWebhookPortNotice(`bootstrap.${r.key}`, r.port, r.overridden));
    }
    if (parsed.bootstrap) Object.assign(bootstrap, parsed.bootstrap);
    if (parsed.runtime) Object.assign(runtime, parsed.runtime);
    source = resolvedPath;
  }

  // 4. Env vars — BOOTSTRAP ONLY (2026-07-28).
  //
  // `runtime` is deliberately NOT patched from env any more. Env is applied
  // after the config file, so a `RECUED_RUNTIME_<KEY>` var overrode whatever
  // the owner had saved through Settings, on every boot — for ~64 keys that all
  // have a store and a UI control. Bootstrap stays because those fields are
  // needed before any store can be read, which is the one case env must win.
  const envPatch = envOverrides(env);
  Object.assign(bootstrap, envPatch.bootstrap);
  retiredSettings.push(...envPatch.retired);
  renamedSettings.push(...envPatch.renamed);
  const envApplied = collectEnvNames(env);

  // 5. CLI flag overrides.
  Object.assign(bootstrap, cli.bootstrap);
  renamedSettings.push(...cli.renamed);

  return {
    bootstrap,
    runtime,
    source,
    distribution: opts.distribution,
    unknownKeys,
    misplacedKeys,
    retiredSettings,
    renamedSettings,
    envApplied,
  };
};

/** Names of the env vars this load actually consulted — surfaced in
 *  `LoadedConfig.envApplied` for diagnostics.
 *
 *  `RECUED_RUNTIME_*` is deliberately NOT collected: it is no longer applied,
 *  so listing it would report an override that did not happen. A diagnostic
 *  that names an inert variable is worse than one that omits it. The same goes
 *  for a `RECUED_BOOTSTRAP_*` name that selects no live key — the removed ones
 *  are reported in `retiredSettings` instead. The renamed
 *  `RECUED_BOOTSTRAP_WEBHOOK_PORT` still applies, so it is listed. */
const collectEnvNames = (env: Record<string, string | undefined>): string[] => {
  const out: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (matchBootstrapKey(name) || isLegacyWebhookPortEnv(name)) out.push(name);
  }
  return out;
};

export { ConfigValidationError };

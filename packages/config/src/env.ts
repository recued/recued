/** Env-var overrides — BOOTSTRAP ONLY.
 *
 *  Single-field overrides use the shape `RECUED_BOOTSTRAP_<KEY>=value`, where
 *  KEY is a bootstrap field name (`RECUED_BOOTSTRAP_BIND_PORT`). Path overrides
 *  honor `RECUED_CONFIG` for the config file location.
 *
 *  ⛔ **`RECUED_RUNTIME_*` was REMOVED 2026-07-28. This is the gate that keeps
 *  the env surface small, and it is structural rather than a list.**
 *
 *  The scan used to accept `RECUED_RUNTIME_<KEY>` against every key of
 *  `RUNTIME_SCHEMA_MAP` — so ~64 env vars existed that appear NOWHERE in the
 *  source as `process.env.X`, invisible to any grep-built inventory, and
 *  **adding a runtime schema key silently minted another one**. Worse, the
 *  loader applies env AFTER the config file, so each one overrode a value the
 *  owner had saved through Settings, at every boot.
 *
 *  The split is the owner's rule made mechanical:
 *    · BOOTSTRAP — data_path / bind_host / bind_port / mcp_port / webhook_port
 *      / log_path. Genuinely boot-critical: needed BEFORE any store can be
 *      read, so env is the only channel that can carry them. Env wins. KEPT.
 *    · RUNTIME — every key has a store and a Settings control. That is user
 *      state, and env has no business overriding it. REMOVED.
 *
 *  ⇒ A new runtime schema key can no longer create an env var. Nothing shipped
 *  used the runtime half (the VPS image configures via `/etc/recued/config.toml`;
 *  the docker entrypoint sets only `RECUED_SUPERVISOR_MODE`).
 *
 *  Env values arrive as strings and need shape-aware coercion so a value like
 *  `"42"` lands as the number `42`. Coercion failures throw so a misconfigured
 *  env var crashes loud instead of silently defaulting. */

import { ConfigValidationError } from './parse.js';
import type { BootstrapConfig } from './types.js';

const BOOTSTRAP_PREFIX = 'RECUED_BOOTSTRAP_';

/** Config path override (independent from field overrides). */
export const envConfigPath = (
  env: Record<string, string | undefined> = process.env,
): string | undefined => {
  const v = env.RECUED_CONFIG;
  return v && v.length > 0 ? v : undefined;
};

const BOOTSTRAP_KEYS = new Set<keyof BootstrapConfig>([
  'data_path', 'bind_host', 'bind_port', 'mcp_port', 'webhook_port', 'log_path',
]);

const matchBootstrapKey = (tail: string): keyof BootstrapConfig | null => {
  const wanted = tail.toLowerCase();
  for (const key of BOOTSTRAP_KEYS) {
    if (key === wanted) return key;
  }
  return null;
};

/** Collect all env overrides into the `{ bootstrap, runtime }` patch
 *  shape. Ignores unrecognized `RECUED_*` env vars (extension/app-side
 *  code may also use the namespace). */
export const envOverrides = (
  env: Record<string, string | undefined> = process.env,
): { bootstrap: Partial<BootstrapConfig> } => {
  const bootstrap: Partial<BootstrapConfig> = {};

  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;

    if (name.startsWith(BOOTSTRAP_PREFIX)) {
      const tail = name.slice(BOOTSTRAP_PREFIX.length);
      const key = matchBootstrapKey(tail);
      if (!key) continue;
      assignBootstrapEnv(bootstrap, key, value);
      continue;
    }
  }

  return { bootstrap };
};


const assignBootstrapEnv = (
  bootstrap: Partial<BootstrapConfig>,
  key: keyof BootstrapConfig,
  raw: string,
): void => {
  switch (key) {
    case 'data_path':
    case 'bind_host':
    case 'log_path':
      bootstrap[key] = raw;
      return;
    case 'bind_port':
    case 'mcp_port':
    case 'webhook_port': {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 65535) {
        throw new ConfigValidationError(
          `RECUED_BOOTSTRAP_${key.toUpperCase()} must be an integer in [0, 65535] (got ${JSON.stringify(raw)})`,
          `bootstrap.${key}`,
        );
      }
      bootstrap[key] = n;
      return;
    }
  }
};

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
 *    · BOOTSTRAP — bind_port / webhooks_enabled. Genuinely boot-critical: needed
 *      BEFORE any store can be read, so env is the only channel that can carry
 *      them. Env wins. KEPT. (`RECUED_BOOTSTRAP_DATA_PATH`, `_LOG_PATH`,
 *      `_BIND_HOST` and `_MCP_PORT` went with their keys on 2026-10-09; one that
 *      is still set is reported in `retired`, never applied — `bootstrap-keys.ts`.
 *      `RECUED_BOOTSTRAP_WEBHOOK_PORT`, the old name of `_WEBHOOKS_ENABLED`, still
 *      applies and is reported in `renamed`.)
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

import {
  BOOTSTRAP_KEYS,
  LEGACY_WEBHOOK_PORT_KEY,
  renamedWebhookPortNotice,
  retiredSetting,
  type BootstrapKey,
  type RetiredSetting,
} from './bootstrap-keys.js';
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

/** The live key a `RECUED_BOOTSTRAP_<KEY>` name selects, case-insensitively. */
export const matchBootstrapKey = (envName: string): BootstrapKey | null => {
  if (!envName.startsWith(BOOTSTRAP_PREFIX)) return null;
  const wanted = envName.slice(BOOTSTRAP_PREFIX.length).toLowerCase();
  for (const key of BOOTSTRAP_KEYS) {
    if (key === wanted) return key;
  }
  return null;
};

/** True for the old name of `RECUED_BOOTSTRAP_WEBHOOKS_ENABLED`, which still applies. */
export const isLegacyWebhookPortEnv = (envName: string): boolean =>
  envName.startsWith(BOOTSTRAP_PREFIX)
  && envName.slice(BOOTSTRAP_PREFIX.length).toLowerCase() === LEGACY_WEBHOOK_PORT_KEY;

/** Collect all env overrides into the `{ bootstrap }` patch shape. Ignores
 *  unrecognized `RECUED_*` env vars (extension/app-side code may also use the
 *  namespace), except the removed bootstrap ones, which come back in `retired`
 *  so boot can say they did nothing, and the renamed one, which still applies
 *  and comes back in `renamed`. */
export const envOverrides = (
  env: Record<string, string | undefined> = process.env,
): { bootstrap: Partial<BootstrapConfig>; retired: RetiredSetting[]; renamed: RetiredSetting[] } => {
  const bootstrap: Partial<BootstrapConfig> = {};
  const retired: RetiredSetting[] = [];
  const renamed: RetiredSetting[] = [];
  let legacy: { name: string; port: number } | undefined;

  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!name.startsWith(BOOTSTRAP_PREFIX)) continue;

    const key = matchBootstrapKey(name);
    if (key) {
      assignBootstrapEnv(bootstrap, key, value);
      continue;
    }
    if (isLegacyWebhookPortEnv(name)) {
      legacy = { name, port: parsePortEnv(name, value) };
      continue;
    }
    const gone = retiredSetting(name, name.slice(BOOTSTRAP_PREFIX.length).toLowerCase());
    if (gone) retired.push(gone);
  }

  if (legacy) {
    const overridden = bootstrap.webhooks_enabled !== undefined;
    if (!overridden) bootstrap.webhooks_enabled = legacy.port > 0;
    renamed.push(renamedWebhookPortNotice(legacy.name, legacy.port, overridden));
  }

  return { bootstrap, retired, renamed };
};

const parsePortEnv = (name: string, raw: string): number => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new ConfigValidationError(
      `${name} must be an integer in [0, 65535] (got ${JSON.stringify(raw)})`,
      name,
    );
  }
  return n;
};


const assignBootstrapEnv = (
  bootstrap: Partial<BootstrapConfig>,
  key: BootstrapKey,
  raw: string,
): void => {
  switch (key) {
    case 'bind_port': {
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
    case 'webhooks_enabled': {
      const v = raw.trim().toLowerCase();
      if (v === 'true' || v === '1') bootstrap[key] = true;
      else if (v === 'false' || v === '0') bootstrap[key] = false;
      else {
        throw new ConfigValidationError(
          `RECUED_BOOTSTRAP_${key.toUpperCase()} must be true or false (got ${JSON.stringify(raw)})`,
          `bootstrap.${key}`,
        );
      }
      return;
    }
  }
};

/** Env-var overrides.
 *
 *  Single-field overrides use the shape `RECUED_<SECTION>_<KEY>=value`
 *  where SECTION is `BOOTSTRAP` or `RUNTIME` and KEY is the field name
 *  with dots replaced by underscores (`RECUED_RUNTIME_LLM_BUDGET`).
 *
 *  Path overrides honor `RECUED_CONFIG` for the config file location.
 *
 *  Env values arrive as strings and need shape-aware coercion so a value
 *  like `"42"` lands as the number `42` and `"true"` lands as boolean
 *  `true`. Coercion failures throw so misconfigured env vars crash loud
 *  instead of silently defaulting. */

import { RUNTIME_SCHEMA_MAP, getRuntimeSchemaEntry } from './schema.js';
import { ConfigValidationError } from './parse.js';
import type { BootstrapConfig, RuntimeConfig } from './types.js';

const RUNTIME_PREFIX = 'RECUED_RUNTIME_';
const BOOTSTRAP_PREFIX = 'RECUED_BOOTSTRAP_';

/** Config path override (independent from field overrides). */
export const envConfigPath = (
  env: Record<string, string | undefined> = process.env,
): string | undefined => {
  const v = env.RECUED_CONFIG;
  return v && v.length > 0 ? v : undefined;
};

/** Map the env var tail back to the schema key. Runtime fields use dots;
 *  env names use underscores — we unambiguously match against the
 *  schema's known key set. */
const matchRuntimeKey = (tail: string): string | null => {
  const wanted = tail.toLowerCase();
  for (const key of Object.keys(RUNTIME_SCHEMA_MAP)) {
    if (key.replace(/\./g, '_') === wanted) return key;
  }
  return null;
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
): { bootstrap: Partial<BootstrapConfig>; runtime: Partial<RuntimeConfig> } => {
  const bootstrap: Partial<BootstrapConfig> = {};
  const runtime: Partial<RuntimeConfig> = {};

  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;

    if (name.startsWith(RUNTIME_PREFIX)) {
      const tail = name.slice(RUNTIME_PREFIX.length);
      const key = matchRuntimeKey(tail);
      if (!key) continue;
      runtime[key] = coerceRuntime(key, value);
      continue;
    }

    if (name.startsWith(BOOTSTRAP_PREFIX)) {
      const tail = name.slice(BOOTSTRAP_PREFIX.length);
      const key = matchBootstrapKey(tail);
      if (!key) continue;
      assignBootstrapEnv(bootstrap, key, value);
      continue;
    }
  }

  return { bootstrap, runtime };
};

const coerceRuntime = (key: string, raw: string): string | number | boolean => {
  const entry = getRuntimeSchemaEntry(key);
  if (!entry) {
    throw new ConfigValidationError(`Unknown runtime key '${key}' in env override`, key);
  }
  switch (entry.type) {
    case 'boolean': {
      if (raw === 'true' || raw === '1') return true;
      if (raw === 'false' || raw === '0') return false;
      throw new ConfigValidationError(
        `RECUED_RUNTIME_${key.replace(/\./g, '_').toUpperCase()} must be true/false or 1/0 (got ${JSON.stringify(raw)})`,
        key,
      );
    }
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        throw new ConfigValidationError(
          `RECUED_RUNTIME_${key.replace(/\./g, '_').toUpperCase()} must be numeric (got ${JSON.stringify(raw)})`,
          key,
        );
      }
      if (entry.integer === true && !Number.isInteger(n)) {
        throw new ConfigValidationError(
          `${key} must be an integer (got ${n})`,
          key,
        );
      }
      if (entry.min !== undefined && n < entry.min) {
        throw new ConfigValidationError(
          `${key} must be >= ${entry.min} (got ${n})`,
          key,
        );
      }
      if (entry.max !== undefined && n > entry.max) {
        throw new ConfigValidationError(
          `${key} must be <= ${entry.max} (got ${n})`,
          key,
        );
      }
      return n;
    }
    case 'string':
      return raw;
    case 'enum': {
      if (!(entry.enum ?? []).includes(raw)) {
        throw new ConfigValidationError(
          `${key} must be one of ${(entry.enum ?? []).join(', ')} (got ${JSON.stringify(raw)})`,
          key,
        );
      }
      return raw;
    }
  }
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

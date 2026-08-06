/** TOML parsing + validation against the Phase A schema. */

import toml from '@iarna/toml';
import {
  getRuntimeSchemaEntry,
  runtimeDefaults,
} from './schema.js';
import type {
  BootstrapConfig,
  RuntimeConfig,
  RuntimeValue,
  ScalarSchemaEntry,
} from './types.js';

export interface ParsedToml {
  bootstrap: Partial<BootstrapConfig>;
  runtime: Partial<RuntimeConfig>;
}

export class ConfigValidationError extends Error {
  constructor(message: string, public readonly field: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

/** Bootstrap field names, for misplaced-key detection. Mirrors the closed set
 *  `assignBootstrap` accepts (and `env.ts`'s `BOOTSTRAP_KEYS`). */
const BOOTSTRAP_FIELDS: ReadonlySet<string> = new Set([
  'data_path', 'bind_host', 'bind_port', 'mcp_port', 'webhook_port', 'log_path',
]);

/** Parse a TOML string into the narrower `{ bootstrap, runtime }` shape.
 *
 *  Unknown top-level sections are preserved as-is in memory but ignored
 *  by the loader; this lets plugins or later phases add sections without
 *  the Phase A parser rejecting them. Unknown keys inside a recognized
 *  section are flagged via the returned `unknown` array — callers decide
 *  whether to warn or fail.
 *
 *  ⛔ `misplaced` exists because that tolerance has a sharp edge. A setting
 *  written OUTSIDE `[runtime]` — `"cloud.base_url" = …` at top level, or a
 *  `[cloud]` section — is valid TOML, resolves to a REAL schema key, applies
 *  NOTHING, and was reported by nothing: `unknown` only ever inspected keys
 *  already inside `[runtime]`, so a top-level key came back as clean as a
 *  correct file. Editing a config by hand and losing the `[runtime]` header is
 *  an easy slip, and the result is a server silently running on defaults — it
 *  cost a live-drive session hours (the server stayed on the production cloud
 *  URL, so its entitlement mint failed and Pro provisioning skipped, all
 *  without a single diagnostic).
 *
 *  Deliberately NARROW: only entries that resolve to a key the schema actually
 *  knows are reported. A genuinely unrecognised top-level section is still
 *  tolerated in silence, which is the plugin/forward-compat behaviour above. */
export const parseToml = (
  src: string,
): { parsed: ParsedToml; unknown: string[]; misplaced: string[] } => {
  let raw: Record<string, unknown>;
  try {
    raw = toml.parse(src) as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigValidationError(`Invalid TOML: ${message}`, '<file>');
  }

  const bootstrap: Partial<BootstrapConfig> = {};
  const runtime: Partial<RuntimeConfig> = {};
  const unknown: string[] = [];

  const bootRaw = isObject(raw.bootstrap) ? (raw.bootstrap as Record<string, unknown>) : {};
  for (const [key, value] of Object.entries(bootRaw)) {
    assignBootstrap(bootstrap, key, value);
  }

  const runRaw = isObject(raw.runtime) ? (raw.runtime as Record<string, unknown>) : {};
  for (const [key, value] of Object.entries(runRaw)) {
    const flat = flattenDotted(key, value);
    for (const [flatKey, flatVal] of flat) {
      const entry = getRuntimeSchemaEntry(flatKey);
      if (!entry) {
        unknown.push(`runtime.${flatKey}`);
        continue;
      }
      runtime[flatKey] = coerceAndValidate(entry, flatVal);
    }
  }

  // Everything OUTSIDE the two recognised tables. An unrecognised section is
  // fine (see the doc above); an entry resolving to a known schema key is a
  // setting the author meant to apply and which silently will not.
  const misplaced: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'bootstrap' || key === 'runtime') continue;
    for (const [flatKey] of flattenDotted(key, value)) {
      if (getRuntimeSchemaEntry(flatKey)) {
        misplaced.push(`${flatKey} → move under [runtime]`);
      } else if (BOOTSTRAP_FIELDS.has(flatKey)) {
        misplaced.push(`${flatKey} → move under [bootstrap]`);
      }
    }
  }

  return { parsed: { bootstrap, runtime }, unknown, misplaced };
};

/** Given a possibly-nested TOML key (native TOML dotted keys flatten
 *  into nested objects), re-expand into dotted flat keys so
 *  `"llm.budget" = 0` and `llm.budget = 0` both land as the same flat
 *  string. Quoted keys arrive already flat. */
const flattenDotted = (
  key: string,
  value: unknown,
  prefix = '',
): Array<[string, unknown]> => {
  const combined = prefix ? `${prefix}.${key}` : key;
  if (isObject(value)) {
    const out: Array<[string, unknown]> = [];
    for (const [k, v] of Object.entries(value)) {
      out.push(...flattenDotted(k, v, combined));
    }
    return out;
  }
  return [[combined, value]];
};

const assignBootstrap = (
  bootstrap: Partial<BootstrapConfig>,
  key: string,
  value: unknown,
): void => {
  switch (key) {
    case 'data_path':
    case 'bind_host':
    case 'log_path': {
      const s = assertString(value, `bootstrap.${key}`);
      (bootstrap as Record<string, unknown>)[key] = s;
      return;
    }
    case 'bind_port':
    case 'mcp_port':
    case 'webhook_port': {
      const n = assertPort(value, `bootstrap.${key}`);
      (bootstrap as Record<string, unknown>)[key] = n;
      return;
    }
    default:
      // Silently ignore unknown bootstrap keys — we treat the bootstrap
      // section as a closed set but don't want to break on future-minor
      // additions the running process doesn't yet know about.
      return;
  }
};

const coerceAndValidate = (
  entry: ScalarSchemaEntry,
  raw: unknown,
): RuntimeValue => {
  switch (entry.type) {
    case 'boolean':
      if (typeof raw !== 'boolean') {
        throw new ConfigValidationError(
          `runtime.${entry.key} expects boolean, got ${describeType(raw)}`,
          entry.key,
        );
      }
      return raw;
    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        throw new ConfigValidationError(
          `runtime.${entry.key} expects finite number, got ${describeType(raw)}`,
          entry.key,
        );
      }
      if (entry.integer === true && !Number.isInteger(raw)) {
        throw new ConfigValidationError(
          `runtime.${entry.key} must be an integer (got ${raw})`,
          entry.key,
        );
      }
      if (entry.min !== undefined && raw < entry.min) {
        throw new ConfigValidationError(
          `runtime.${entry.key} must be >= ${entry.min} (got ${raw})`,
          entry.key,
        );
      }
      if (entry.max !== undefined && raw > entry.max) {
        throw new ConfigValidationError(
          `runtime.${entry.key} must be <= ${entry.max} (got ${raw})`,
          entry.key,
        );
      }
      return raw;
    }
    case 'string': {
      if (typeof raw !== 'string') {
        throw new ConfigValidationError(
          `runtime.${entry.key} expects string, got ${describeType(raw)}`,
          entry.key,
        );
      }
      return raw;
    }
    case 'enum': {
      if (typeof raw !== 'string' || !(entry.enum ?? []).includes(raw)) {
        throw new ConfigValidationError(
          `runtime.${entry.key} must be one of ${(entry.enum ?? []).join(', ')} (got ${JSON.stringify(raw)})`,
          entry.key,
        );
      }
      return raw;
    }
  }
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const assertString = (value: unknown, field: string): string => {
  if (typeof value !== 'string') {
    throw new ConfigValidationError(
      `${field} expects string, got ${describeType(value)}`,
      field,
    );
  }
  return value;
};

const assertPort = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 65535) {
    throw new ConfigValidationError(
      `${field} must be an integer in [0, 65535] (got ${describeType(value)})`,
      field,
    );
  }
  return value;
};

const describeType = (v: unknown): string => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
};

/** Public helper — full runtime defaults as a fresh object, useful when
 *  callers need an all-fields-populated baseline. */
export { runtimeDefaults };

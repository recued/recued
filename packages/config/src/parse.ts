/** TOML parsing + validation against the Phase A schema. */

import toml from '@iarna/toml';
import {
  isBootstrapKey,
  LEGACY_WEBHOOK_PORT_KEY,
  RETIRED_BOOTSTRAP_SETTINGS,
} from './bootstrap-keys.js';
import {
  getRuntimeSchemaEntry,
  RETIRED_RUNTIME_SETTINGS,
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
 *  tolerated in silence, which is the plugin/forward-compat behaviour above.
 *
 *  `retired` names the removed `[bootstrap]` keys the file still sets
 *  (`bootstrap-keys.ts`), and `retiredRuntime` the removed runtime keys
 *  (`RETIRED_RUNTIME_SETTINGS`), wherever in the file they sit. They are
 *  ignored and never throw — not even for a value of the wrong type — because
 *  a file written by an older install must still boot.
 *
 *  `renamed` reports `webhook_port`, the old name of `webhooks_enabled`. It is
 *  still validated as the port number it always claimed to be and still read
 *  (non-zero = on), unless the file also sets `webhooks_enabled`, which wins. */
export const parseToml = (
  src: string,
): {
  parsed: ParsedToml;
  unknown: string[];
  misplaced: string[];
  retired: string[];
  retiredRuntime: string[];
  renamed: RenamedBootstrapKey[];
} => {
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
  const retired = new Set<string>();
  const retiredRuntime = new Set<string>();

  const bootRaw = isObject(raw.bootstrap) ? (raw.bootstrap as Record<string, unknown>) : {};
  let legacyWebhookPort: number | undefined;
  for (const [key, value] of Object.entries(bootRaw)) {
    if (RETIRED_BOOTSTRAP_SETTINGS.has(key)) {
      retired.add(key);
      continue;
    }
    if (key === LEGACY_WEBHOOK_PORT_KEY) {
      legacyWebhookPort = assertPort(value, `bootstrap.${key}`);
      continue;
    }
    assignBootstrap(bootstrap, key, value);
  }
  const renamed: RenamedBootstrapKey[] = [];
  if (legacyWebhookPort !== undefined) {
    const overridden = bootstrap.webhooks_enabled !== undefined;
    if (!overridden) bootstrap.webhooks_enabled = legacyWebhookPort > 0;
    renamed.push({ key: LEGACY_WEBHOOK_PORT_KEY, port: legacyWebhookPort, overridden });
  }

  const runRaw = isObject(raw.runtime) ? (raw.runtime as Record<string, unknown>) : {};
  for (const [key, value] of Object.entries(runRaw)) {
    const flat = flattenDotted(key, value);
    for (const [flatKey, flatVal] of flat) {
      const entry = getRuntimeSchemaEntry(flatKey);
      if (!entry) {
        if (RETIRED_RUNTIME_SETTINGS.has(flatKey)) retiredRuntime.add(flatKey);
        else unknown.push(`runtime.${flatKey}`);
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
      } else if (isBootstrapKey(flatKey)) {
        misplaced.push(`${flatKey} → move under [bootstrap]`);
      } else if (flatKey === LEGACY_WEBHOOK_PORT_KEY) {
        misplaced.push(`${flatKey} → write webhooks_enabled under [bootstrap]`);
      } else if (RETIRED_BOOTSTRAP_SETTINGS.has(flatKey)) {
        retired.add(flatKey);
      } else if (RETIRED_RUNTIME_SETTINGS.has(flatKey)) {
        retiredRuntime.add(flatKey);
      }
    }
  }

  return {
    parsed: { bootstrap, runtime },
    unknown,
    misplaced,
    retired: [...retired],
    retiredRuntime: [...retiredRuntime],
    renamed,
  };
};

/** A `[bootstrap]` key written under its old name — today only `webhook_port`. */
export interface RenamedBootstrapKey {
  key: string;
  /** The value as written. */
  port: number;
  /** True when the file also sets the new name, which won. */
  overridden: boolean;
}

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
    case 'bind_port':
      bootstrap.bind_port = assertPort(value, `bootstrap.${key}`);
      return;
    case 'webhooks_enabled':
      bootstrap.webhooks_enabled = assertBoolean(value, `bootstrap.${key}`);
      return;
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

const assertBoolean = (value: unknown, field: string): boolean => {
  if (typeof value !== 'boolean') {
    throw new ConfigValidationError(
      `${field} expects true or false, got ${describeType(value)}`,
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

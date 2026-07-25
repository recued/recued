/** Mutable runtime-config handle — pairs an in-memory view of the
 *  loaded TOML `[runtime]` section with schema-validated writes that
 *  persist back to the file.
 *
 *  Reads are synchronous for the recued-server's rpc hot path. Writes
 *  validate against `RUNTIME_SCHEMA` and atomically rewrite the TOML
 *  via `writeConfigField`. When no `path` is supplied (tests / ephemeral
 *  servers), writes stay in memory only. */

import { ConfigValidationError } from './parse.js';
import { getRuntimeSchemaEntry } from './schema.js';
import type { RuntimeConfig, RuntimeValue, ScalarSchemaEntry } from './types.js';
import { writeConfigField } from './write.js';

export interface RuntimeConfigStoreOptions {
  /** Absolute path of the TOML file. When omitted, writes are kept in
   *  memory only — useful for tests and ephemeral composition roots. */
  path?: string;
}

export type RuntimeConfigListener = (key: string, value: RuntimeValue) => void;

export interface RuntimeConfigStore {
  /** Current value. Returns the schema default when the key was never
   *  explicitly set and no TOML/env/CLI patch provided one. Throws for
   *  unknown keys so callers can distinguish "no value" from "bad key". */
  get(key: string): RuntimeValue;
  /** Validate + write. Throws `ConfigValidationError` on bad input.
   *  Persists to disk when `path` is set; memory-only otherwise. */
  set(key: string, value: RuntimeValue): void;
  /** Snapshot of the full runtime map. Useful for `server.getBootstrap`
   *  and preset-export callers. */
  snapshot(): RuntimeConfig;
  /** Subscribe to every `set` call — fires after validation + persist.
   *  Used by the Phase B gate registry to propagate quota / reserve
   *  changes to live gates without restart. Returns an unsubscribe fn. */
  onChange(listener: RuntimeConfigListener): () => void;
}

export const createRuntimeConfigStore = (
  initial: RuntimeConfig,
  opts: RuntimeConfigStoreOptions = {},
): RuntimeConfigStore => {
  const state: RuntimeConfig = { ...initial };
  const path = opts.path;
  const listeners = new Set<RuntimeConfigListener>();

  return {
    get(key) {
      const entry = getRuntimeSchemaEntry(key);
      if (!entry) {
        throw new ConfigValidationError(`Unknown runtime key '${key}'`, key);
      }
      return Object.prototype.hasOwnProperty.call(state, key)
        ? state[key]
        : (entry.default as RuntimeValue);
    },

    set(key, value) {
      const entry = getRuntimeSchemaEntry(key);
      if (!entry) {
        throw new ConfigValidationError(`Unknown runtime key '${key}'`, key);
      }
      validate(entry, value);
      state[key] = value;
      if (path) writeConfigField({ path, section: 'runtime', key, value });
      for (const listener of listeners) {
        try { listener(key, value); } catch (_err) { /* never break callers */ }
      }
    },

    snapshot() {
      return { ...state };
    },

    onChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
};

/** Schema validator — mirrors the checks in `write.ts::validateRuntime`
 *  so in-memory writes reject the same values a persisted write would. */
const validate = (entry: ScalarSchemaEntry, value: RuntimeValue): void => {
  switch (entry.type) {
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new ConfigValidationError(`${entry.key} expects boolean`, entry.key);
      }
      return;
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ConfigValidationError(`${entry.key} expects finite number`, entry.key);
      }
      if (entry.integer === true && !Number.isInteger(value)) {
        throw new ConfigValidationError(`${entry.key} must be an integer`, entry.key);
      }
      if (entry.min !== undefined && value < entry.min) {
        throw new ConfigValidationError(`${entry.key} must be >= ${entry.min}`, entry.key);
      }
      if (entry.max !== undefined && value > entry.max) {
        throw new ConfigValidationError(`${entry.key} must be <= ${entry.max}`, entry.key);
      }
      return;
    }
    case 'string':
      if (typeof value !== 'string') {
        throw new ConfigValidationError(`${entry.key} expects string`, entry.key);
      }
      return;
    case 'enum': {
      if (typeof value !== 'string' || !(entry.enum ?? []).includes(value)) {
        throw new ConfigValidationError(
          `${entry.key} must be one of ${(entry.enum ?? []).join(', ')}`,
          entry.key,
        );
      }
      return;
    }
  }
};

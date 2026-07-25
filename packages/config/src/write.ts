/** Atomic single-field writer — backs `server.setConfigField` and the
 *  interactive `recued-server config set` command. Reads the existing
 *  TOML (or starts from the distribution preset if absent), validates
 *  the requested change against the schema, writes a temp file next to
 *  the target, and renames in place. Never leaves a half-written file. */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import toml from '@iarna/toml';

import { ConfigValidationError } from './parse.js';
import { getRuntimeSchemaEntry } from './schema.js';
import type { RuntimeValue, ScalarSchemaEntry } from './types.js';

export interface WriteFieldOptions {
  /** Absolute path to the TOML file. Created if it doesn't exist. */
  path: string;
  /** Which section the field lives in. */
  section: 'bootstrap' | 'runtime';
  /** Dotted runtime key or bootstrap field name. */
  key: string;
  value: RuntimeValue;
}

/** Set one field in the config file. Throws `ConfigValidationError` if
 *  the value violates the schema. */
export const writeConfigField = (opts: WriteFieldOptions): void => {
  const existing = existsSync(opts.path)
    ? (toml.parse(readFileSync(opts.path, 'utf8')) as Record<string, unknown>)
    : {};

  if (opts.section === 'runtime') {
    const entry = getRuntimeSchemaEntry(opts.key);
    if (!entry) {
      throw new ConfigValidationError(`Unknown runtime key '${opts.key}'`, opts.key);
    }
    validateRuntime(entry, opts.value);
  }

  const section = isObject(existing[opts.section])
    ? (existing[opts.section] as Record<string, unknown>)
    : {};
  section[opts.key] = opts.value as unknown as
    string | number | boolean;
  existing[opts.section] = section;

  const serialized = toml.stringify(existing as Parameters<typeof toml.stringify>[0]);
  writeAtomic(opts.path, serialized);
};

const validateRuntime = (
  entry: ScalarSchemaEntry,
  value: RuntimeValue,
): void => {
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

const writeAtomic = (target: string, contents: string): void => {
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmp, contents, 'utf8');
  renameSync(tmp, target);
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

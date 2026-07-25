/** D-145 § A.7.8 (Amended 2026-05-26) — `enrichment_tunable_params`
 *  store.
 *
 *  Per-topic user-tunable parameters declared by the producer (closed
 *  list per topic) and surfaced in Settings → Housekeeping per-topic
 *  card alongside trust state + pool policy + MCP visibility. The
 *  store handles three operations:
 *
 *    - `readEffectiveParams(topic)` — full effective param set for one
 *      topic. Merges declared defaults with persisted overrides;
 *      callers always see a fully-populated `{ [name]: value }` map.
 *      Returns `{}` when the topic has no `tunable_params` declared.
 *
 *    - `writeParam(topic, name, value)` — validate against the
 *      declared spec (kind / bounds / enum membership), then upsert.
 *      Throws `tunable_param_invalid_*` on shape mismatch + the
 *      registry-load validator covers the declaration itself; this
 *      layer catches per-write user input.
 *
 *    - `resetParam(topic, name)` — delete the override row → effective
 *      value falls back to the declaration default on next read.
 *
 *  Canonical hash helper:
 *    - `computeTopicTunableParamsHash(topic, store)` returns a stable
 *      FNV-1a hex over the topic's effective values, sorted by param
 *      name. Producers fold this into their `tunable_params_hash` slot
 *      on `computeProducerVersionHash` so the cache-invalidation
 *      machinery flips rows stale when the user tunes any param.
 *
 *  Mirrors `trust-store.ts` shape: factory function returning typed
 *  CRUD methods, narrow surface area, no global state.
 *
 *  Spec: D-145 § A.7.8. */

import type Database from 'better-sqlite3';

import {
  D145_PRODUCER_DECLARATIONS,
  type EnrichmentTopic,
  type EnrichmentTunableParamSpec,
  type EnrichmentTunableParamValue,
} from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export type TunableParamsByTopic = Readonly<
  Record<string, EnrichmentTunableParamValue>
>;

export interface TunableParamsStore {
  /** Resolve the effective param map for one topic — declared defaults
   *  merged with persisted overrides. Returns `{}` when the topic has
   *  no `tunable_params` declared in its `EnrichmentDeclaration`. */
  readEffectiveParams(topic: EnrichmentTopic): TunableParamsByTopic;
  /** Resolve one effective param value. Returns the declared default
   *  when no override row exists; returns `undefined` when the topic
   *  doesn't declare this param at all. */
  readEffectiveParam(
    topic: EnrichmentTopic,
    param_name: string,
  ): EnrichmentTunableParamValue | undefined;
  /** Validate `value` against the declared spec for `(topic,
   *  param_name)`, then persist. Throws `tunable_param_invalid_*` on
   *  shape mismatch. */
  writeParam(
    topic: EnrichmentTopic,
    param_name: string,
    value: EnrichmentTunableParamValue,
    now: number,
  ): void;
  /** Drop the override row for `(topic, param_name)` — effective value
   *  reverts to the declared default on next read. Idempotent (no row
   *  → no-op). */
  resetParam(topic: EnrichmentTopic, param_name: string): void;
  /** Drop every override row for `topic`. Used by Settings "Reset all"
   *  per-topic. Idempotent. */
  resetTopic(topic: EnrichmentTopic): void;
}

// ────────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────────

export class TunableParamInvalidError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'TunableParamInvalidError';
  }
}

// ────────────────────────────────────────────────────────────────
// Declaration lookups
// ────────────────────────────────────────────────────────────────

/** Look up the `tunable_params` map declared by the topic's
 *  `EnrichmentDeclaration`. Returns `undefined` when the topic doesn't
 *  declare any tunables (most topics today). */
export const getDeclaredTunableParams = (
  topic: EnrichmentTopic,
): Readonly<Record<string, EnrichmentTunableParamSpec>> | undefined => {
  const decl = D145_PRODUCER_DECLARATIONS[topic];
  return decl?.tunable_params;
};

/** Look up one declared param spec. Returns `undefined` when the topic
 *  doesn't declare this param. */
export const getDeclaredTunableParamSpec = (
  topic: EnrichmentTopic,
  param_name: string,
): EnrichmentTunableParamSpec | undefined => {
  const params = getDeclaredTunableParams(topic);
  return params?.[param_name];
};

// ────────────────────────────────────────────────────────────────
// Per-write validation
// ────────────────────────────────────────────────────────────────

/** Validate `value` against `spec`. Returns `null` on success or an
 *  error code + message tuple on rejection. The store throws on this;
 *  the rpc layer maps it to a structured error. */
export const validateTunableParamWrite = (
  spec: EnrichmentTunableParamSpec,
  value: EnrichmentTunableParamValue,
): { code: string; message: string } | null => {
  if (spec.kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return {
        code: 'tunable_param_invalid_type',
        message: `expected finite number for kind: 'number'; got ${JSON.stringify(value)}`,
      };
    }
    if (value < spec.min || value > spec.max) {
      return {
        code: 'tunable_param_invalid_range',
        message: `value ${value} must lie within [min=${spec.min}, max=${spec.max}]`,
      };
    }
    return null;
  }
  // kind === 'enum'
  if (typeof value !== 'string') {
    return {
      code: 'tunable_param_invalid_type',
      message: `expected string for kind: 'enum'; got ${JSON.stringify(value)}`,
    };
  }
  if (!spec.enum_values.includes(value)) {
    return {
      code: 'tunable_param_invalid_enum',
      message: `value '${value}' must be a member of enum_values [${spec.enum_values.join(', ')}]`,
    };
  }
  return null;
};

// ────────────────────────────────────────────────────────────────
// Store factory
// ────────────────────────────────────────────────────────────────

interface PersistedRow {
  topic: string;
  param_name: string;
  value: string;
  updated_at: number;
}

const decodeValue = (raw: string): EnrichmentTunableParamValue | undefined => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed;
    if (typeof parsed === 'string') return parsed;
    return undefined;
  } catch {
    return undefined;
  }
};

export const createTunableParamsStore = (
  db: Database.Database,
): TunableParamsStore => {
  const selectByTopic = db.prepare(
    `SELECT topic, param_name, value, updated_at
       FROM enrichment_tunable_params WHERE topic = ?`,
  );
  const selectOne = db.prepare(
    `SELECT topic, param_name, value, updated_at
       FROM enrichment_tunable_params
       WHERE topic = ? AND param_name = ?`,
  );
  const upsert = db.prepare(
    `INSERT INTO enrichment_tunable_params (topic, param_name, value, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(topic, param_name) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`,
  );
  const deleteOne = db.prepare(
    `DELETE FROM enrichment_tunable_params WHERE topic = ? AND param_name = ?`,
  );
  const deleteByTopic = db.prepare(
    `DELETE FROM enrichment_tunable_params WHERE topic = ?`,
  );

  return {
    readEffectiveParams(topic) {
      const declared = getDeclaredTunableParams(topic);
      if (!declared) return {};
      // Start with declared defaults; overlay persisted overrides for
      // keys the declaration recognises (drop stray rows whose param
      // was removed from the declaration — forward-compat).
      const out: Record<string, EnrichmentTunableParamValue> = {};
      for (const [name, spec] of Object.entries(declared)) {
        out[name] = spec.default;
      }
      const rows = selectByTopic.all(topic) as PersistedRow[];
      for (const row of rows) {
        if (!(row.param_name in declared)) continue;
        const decoded = decodeValue(row.value);
        if (decoded === undefined) continue;
        // Defensive validation on read — guards against schema-drift
        // rows that the declaration would now reject. Falls back to
        // declared default rather than serving an invalid value.
        const spec = declared[row.param_name]!;
        const issue = validateTunableParamWrite(spec, decoded);
        if (issue) continue;
        out[row.param_name] = decoded;
      }
      return out;
    },

    readEffectiveParam(topic, param_name) {
      const spec = getDeclaredTunableParamSpec(topic, param_name);
      if (!spec) return undefined;
      const row = selectOne.get(topic, param_name) as PersistedRow | undefined;
      if (!row) return spec.default;
      const decoded = decodeValue(row.value);
      if (decoded === undefined) return spec.default;
      const issue = validateTunableParamWrite(spec, decoded);
      if (issue) return spec.default;
      return decoded;
    },

    writeParam(topic, param_name, value, now) {
      const spec = getDeclaredTunableParamSpec(topic, param_name);
      if (!spec) {
        throw new TunableParamInvalidError(
          'tunable_param_unknown',
          `topic '${topic}' does not declare tunable param '${param_name}'`,
        );
      }
      const issue = validateTunableParamWrite(spec, value);
      if (issue) {
        throw new TunableParamInvalidError(issue.code, issue.message);
      }
      upsert.run(topic, param_name, JSON.stringify(value), now);
    },

    resetParam(topic, param_name) {
      deleteOne.run(topic, param_name);
    },

    resetTopic(topic) {
      deleteByTopic.run(topic);
    },
  };
};

// ────────────────────────────────────────────────────────────────
// Canonical hash for `computeProducerVersionHash.tunable_params_hash`
// ────────────────────────────────────────────────────────────────

/** Stable canonical serialization of the topic's effective tunable
 *  param map. Sorted by param name; each entry serialized as
 *  `<name>=<JSON.stringify(value)>`; joined by `\x1f`. Returns `''`
 *  when the topic has no `tunable_params` declared — the producer-
 *  version-hash composer treats empty + undefined identically so this
 *  is byte-stable with the pre-amendment composition. */
export const canonicalizeEffectiveParams = (
  params: TunableParamsByTopic,
): string => {
  const keys = Object.keys(params).sort();
  if (keys.length === 0) return '';
  return keys
    .map((name) => `${name}=${JSON.stringify(params[name])}`)
    .join('\x1f');
};

/** FNV-1a hex over the canonical serialization. Returns `''` for an
 *  empty / undeclared topic so the producer-version-hash composer's
 *  backward-compat path applies. */
export const computeTopicTunableParamsHash = (
  topic: EnrichmentTopic,
  store: TunableParamsStore,
): string => {
  const params = store.readEffectiveParams(topic);
  const canonical = canonicalizeEffectiveParams(params);
  if (canonical.length === 0) return '';
  return `fnv1a:${fnv1a32Hex(canonical)}`;
};

// ────────────────────────────────────────────────────────────────
// FNV-1a — local copy (contracts→backend dep would invert the
// layering; matches `packages/contracts/src/enrichment-registry.ts`
// implementation byte-for-byte).
// ────────────────────────────────────────────────────────────────

const fnv1a32Hex = (str: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

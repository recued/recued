/** D-145 § A.7.8 (Amended 2026-05-26) — `tunable-params-store` tests.
 *
 *  Covers the storage substrate end-to-end:
 *    - Schema migration (idempotent, additive table)
 *    - readEffectiveParams: defaults-only when no override row; merges
 *      defaults with overrides; drops stray rows whose param was
 *      removed from the declaration; drops malformed JSON; drops
 *      drift-invalid values (defensive read-side validation)
 *    - readEffectiveParam: single-key variant; undefined when topic
 *      doesn't declare the param at all
 *    - writeParam: validates kind / bounds / enum membership; throws
 *      structured `TunableParamInvalidError` codes
 *    - resetParam / resetTopic: idempotent row deletion
 *    - validateTunableParamWrite pure cases (number / enum / type
 *      mismatch / bounds)
 *    - canonicalizeEffectiveParams: sorted-key stable serialization
 *    - computeTopicTunableParamsHash: empty → '' (backward compat),
 *      non-empty → fnv1a:<8-hex>, stable across reads, flips when
 *      override changes
 *
 *  Pilot topic: `project_stall_signal.stall_window_days`. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureHousekeepingSchema } from '../housekeeping/schema.js';
import {
  TunableParamInvalidError,
  canonicalizeEffectiveParams,
  computeTopicTunableParamsHash,
  createTunableParamsStore,
  getDeclaredTunableParamSpec,
  getDeclaredTunableParams,
  validateTunableParamWrite,
} from '../housekeeping/tunable-params-store.js';

// ────────────────────────────────────────────────────────────────
// Fixture infra
// ────────────────────────────────────────────────────────────────

let dir: string;
let db: Database.Database;
const NOW = 1_700_000_000_000;
const TOPIC = 'project_stall_signal';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-145-pa9-tunable-store-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  ensureHousekeepingSchema(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────
// Schema migration
// ────────────────────────────────────────────────────────────────

describe('ensureHousekeepingSchema — enrichment_tunable_params table', () => {
  it('creates enrichment_tunable_params with the (topic, param_name) primary key', () => {
    const cols = db
      .prepare(`PRAGMA table_info(enrichment_tunable_params)`)
      .all() as Array<{ name: string; notnull: number; pk: number }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(['param_name', 'topic', 'updated_at', 'value']);
    const pk = cols.filter((c) => c.pk > 0).map((c) => c.name).sort();
    expect(pk).toEqual(['param_name', 'topic']);
  });

  it('is idempotent — calling ensureHousekeepingSchema twice does not error', () => {
    expect(() => ensureHousekeepingSchema(db)).not.toThrow();
    expect(() => ensureHousekeepingSchema(db)).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────
// Declaration lookups
// ────────────────────────────────────────────────────────────────

describe('getDeclaredTunableParams / getDeclaredTunableParamSpec', () => {
  it('returns the declared map for project_stall_signal', () => {
    const params = getDeclaredTunableParams(TOPIC);
    expect(params).toBeDefined();
    expect(Object.keys(params!)).toEqual(['stall_window_days']);
  });

  it('returns undefined for topics without tunable_params declared', () => {
    expect(getDeclaredTunableParams('preferred_channel_by_contact')).toBeUndefined();
  });

  it('returns the spec for a known param', () => {
    const spec = getDeclaredTunableParamSpec(TOPIC, 'stall_window_days');
    expect(spec).toBeDefined();
    expect(spec!.kind).toBe('number');
    if (spec!.kind === 'number') {
      expect(spec!.default).toBe(14);
      expect(spec!.min).toBe(1);
      expect(spec!.max).toBe(730);
    }
  });

  it('returns undefined for an unknown param on a known topic', () => {
    expect(getDeclaredTunableParamSpec(TOPIC, 'no_such_param')).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// validateTunableParamWrite pure cases
// ────────────────────────────────────────────────────────────────

describe('validateTunableParamWrite — number kind', () => {
  const numericSpec = {
    kind: 'number' as const,
    default: 14,
    min: 1,
    max: 730,
    ui_label: 'x',
    ui_help: 'x',
  };

  it('accepts a value inside the bounds', () => {
    expect(validateTunableParamWrite(numericSpec, 90)).toBeNull();
  });

  it('accepts the min boundary', () => {
    expect(validateTunableParamWrite(numericSpec, 1)).toBeNull();
  });

  it('accepts the max boundary', () => {
    expect(validateTunableParamWrite(numericSpec, 730)).toBeNull();
  });

  it('rejects a value below min', () => {
    const issue = validateTunableParamWrite(numericSpec, 0);
    expect(issue?.code).toBe('tunable_param_invalid_range');
  });

  it('rejects a value above max', () => {
    const issue = validateTunableParamWrite(numericSpec, 1000);
    expect(issue?.code).toBe('tunable_param_invalid_range');
  });

  it('rejects NaN / Infinity', () => {
    expect(validateTunableParamWrite(numericSpec, Number.NaN)?.code).toBe(
      'tunable_param_invalid_type',
    );
    expect(validateTunableParamWrite(numericSpec, Number.POSITIVE_INFINITY)?.code).toBe(
      'tunable_param_invalid_type',
    );
  });

  it('rejects a string value when kind is number', () => {
    expect(validateTunableParamWrite(numericSpec, 'hello')?.code).toBe(
      'tunable_param_invalid_type',
    );
  });
});

describe('validateTunableParamWrite — enum kind', () => {
  const enumSpec = {
    kind: 'enum' as const,
    default: 'balanced',
    enum_values: ['conservative', 'balanced', 'aggressive'] as const,
    ui_label: 'x',
    ui_help: 'x',
  };

  it('accepts every declared enum value', () => {
    for (const v of enumSpec.enum_values) {
      expect(validateTunableParamWrite(enumSpec, v)).toBeNull();
    }
  });

  it('rejects an unknown enum value', () => {
    expect(validateTunableParamWrite(enumSpec, 'wild')?.code).toBe(
      'tunable_param_invalid_enum',
    );
  });

  it('rejects a number when kind is enum', () => {
    expect(validateTunableParamWrite(enumSpec, 42)?.code).toBe(
      'tunable_param_invalid_type',
    );
  });
});

// ────────────────────────────────────────────────────────────────
// Store — readEffectiveParams
// ────────────────────────────────────────────────────────────────

describe('TunableParamsStore.readEffectiveParams', () => {
  it('returns declared defaults when no override row exists', () => {
    const store = createTunableParamsStore(db);
    expect(store.readEffectiveParams(TOPIC)).toEqual({ stall_window_days: 14 });
  });

  it('returns {} when topic declares no tunable_params', () => {
    const store = createTunableParamsStore(db);
    expect(store.readEffectiveParams('preferred_channel_by_contact')).toEqual({});
  });

  it('overlays a persisted override on top of defaults', () => {
    const store = createTunableParamsStore(db);
    store.writeParam(TOPIC, 'stall_window_days', 90, NOW);
    expect(store.readEffectiveParams(TOPIC)).toEqual({ stall_window_days: 90 });
  });

  it('drops stray override rows whose param is not declared (forward-compat)', () => {
    const store = createTunableParamsStore(db);
    // Insert a stray row directly bypassing writeParam (simulates a
    // param that was once declared but later removed).
    db.prepare(
      `INSERT INTO enrichment_tunable_params (topic, param_name, value, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(TOPIC, 'long_gone_param', JSON.stringify(99), NOW);
    expect(store.readEffectiveParams(TOPIC)).toEqual({ stall_window_days: 14 });
  });

  it('falls back to default when persisted JSON is malformed', () => {
    const store = createTunableParamsStore(db);
    db.prepare(
      `INSERT INTO enrichment_tunable_params (topic, param_name, value, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(TOPIC, 'stall_window_days', '{not json', NOW);
    expect(store.readEffectiveParams(TOPIC)).toEqual({ stall_window_days: 14 });
  });

  it('falls back to default when persisted value drifts out of bounds (schema drift)', () => {
    const store = createTunableParamsStore(db);
    // Old row from when max was 1000; new declaration caps at 730.
    db.prepare(
      `INSERT INTO enrichment_tunable_params (topic, param_name, value, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(TOPIC, 'stall_window_days', JSON.stringify(900), NOW);
    expect(store.readEffectiveParams(TOPIC)).toEqual({ stall_window_days: 14 });
  });
});

// ────────────────────────────────────────────────────────────────
// Store — readEffectiveParam (single key)
// ────────────────────────────────────────────────────────────────

describe('TunableParamsStore.readEffectiveParam', () => {
  it('returns declared default when no override row', () => {
    const store = createTunableParamsStore(db);
    expect(store.readEffectiveParam(TOPIC, 'stall_window_days')).toBe(14);
  });

  it('returns the override value when present', () => {
    const store = createTunableParamsStore(db);
    store.writeParam(TOPIC, 'stall_window_days', 30, NOW);
    expect(store.readEffectiveParam(TOPIC, 'stall_window_days')).toBe(30);
  });

  it('returns undefined for an unknown param on a known topic', () => {
    const store = createTunableParamsStore(db);
    expect(store.readEffectiveParam(TOPIC, 'no_such_param')).toBeUndefined();
  });

  it('returns undefined for an unknown topic (no tunable_params declared)', () => {
    const store = createTunableParamsStore(db);
    expect(store.readEffectiveParam('preferred_channel_by_contact', 'x')).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// Store — writeParam
// ────────────────────────────────────────────────────────────────

describe('TunableParamsStore.writeParam', () => {
  it('persists a valid override', () => {
    const store = createTunableParamsStore(db);
    store.writeParam(TOPIC, 'stall_window_days', 30, NOW);
    expect(store.readEffectiveParam(TOPIC, 'stall_window_days')).toBe(30);
  });

  it('upserts on second write (last writer wins)', () => {
    const store = createTunableParamsStore(db);
    store.writeParam(TOPIC, 'stall_window_days', 30, NOW);
    store.writeParam(TOPIC, 'stall_window_days', 60, NOW + 1000);
    expect(store.readEffectiveParam(TOPIC, 'stall_window_days')).toBe(60);
  });

  it('rejects out-of-bounds values with tunable_param_invalid_range', () => {
    const store = createTunableParamsStore(db);
    expect(() => store.writeParam(TOPIC, 'stall_window_days', 1000, NOW))
      .toThrow(TunableParamInvalidError);
    try {
      store.writeParam(TOPIC, 'stall_window_days', 1000, NOW);
    } catch (e) {
      expect((e as TunableParamInvalidError).code).toBe('tunable_param_invalid_range');
    }
  });

  it('rejects wrong-typed values with tunable_param_invalid_type', () => {
    const store = createTunableParamsStore(db);
    try {
      store.writeParam(TOPIC, 'stall_window_days', 'thirty', NOW);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as TunableParamInvalidError).code).toBe('tunable_param_invalid_type');
    }
  });

  it('rejects unknown param name with tunable_param_unknown', () => {
    const store = createTunableParamsStore(db);
    try {
      store.writeParam(TOPIC, 'no_such_param', 1, NOW);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as TunableParamInvalidError).code).toBe('tunable_param_unknown');
    }
  });

  it('rejects unknown topic with tunable_param_unknown', () => {
    const store = createTunableParamsStore(db);
    try {
      store.writeParam('preferred_channel_by_contact', 'stall_window_days', 30, NOW);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as TunableParamInvalidError).code).toBe('tunable_param_unknown');
    }
  });
});

// ────────────────────────────────────────────────────────────────
// Store — resetParam / resetTopic
// ────────────────────────────────────────────────────────────────

describe('TunableParamsStore.resetParam / resetTopic', () => {
  it('resetParam reverts to declared default', () => {
    const store = createTunableParamsStore(db);
    store.writeParam(TOPIC, 'stall_window_days', 60, NOW);
    expect(store.readEffectiveParam(TOPIC, 'stall_window_days')).toBe(60);
    store.resetParam(TOPIC, 'stall_window_days');
    expect(store.readEffectiveParam(TOPIC, 'stall_window_days')).toBe(14);
  });

  it('resetParam is idempotent (no row → no-op)', () => {
    const store = createTunableParamsStore(db);
    expect(() => store.resetParam(TOPIC, 'stall_window_days')).not.toThrow();
    expect(store.readEffectiveParam(TOPIC, 'stall_window_days')).toBe(14);
  });

  it('resetTopic drops every override row for the topic', () => {
    const store = createTunableParamsStore(db);
    store.writeParam(TOPIC, 'stall_window_days', 60, NOW);
    store.resetTopic(TOPIC);
    expect(store.readEffectiveParam(TOPIC, 'stall_window_days')).toBe(14);
  });
});

// ────────────────────────────────────────────────────────────────
// canonicalizeEffectiveParams — sorted-key stable serialization
// ────────────────────────────────────────────────────────────────

describe('canonicalizeEffectiveParams', () => {
  it('returns empty string when no params', () => {
    expect(canonicalizeEffectiveParams({})).toBe('');
  });

  it('sorts keys alphabetically before serializing', () => {
    const a = canonicalizeEffectiveParams({ b: 2, a: 1, c: 3 });
    const b = canonicalizeEffectiveParams({ a: 1, b: 2, c: 3 });
    expect(a).toBe(b);
  });

  it('serializes numbers and strings via JSON.stringify', () => {
    const out = canonicalizeEffectiveParams({ days: 90, mode: 'balanced' });
    expect(out).toBe(`days=90\x1fmode="balanced"`);
  });

  it('different values produce different serializations', () => {
    const a = canonicalizeEffectiveParams({ x: 14 });
    const b = canonicalizeEffectiveParams({ x: 90 });
    expect(a).not.toBe(b);
  });
});

// ────────────────────────────────────────────────────────────────
// computeTopicTunableParamsHash — flips on tune; empty for undeclared
// ────────────────────────────────────────────────────────────────

describe('computeTopicTunableParamsHash', () => {
  it('returns empty string for a topic without tunable_params declared', () => {
    const store = createTunableParamsStore(db);
    expect(computeTopicTunableParamsHash('preferred_channel_by_contact', store)).toBe('');
  });

  it('returns fnv1a:<8-hex> for a topic with declared params (default state)', () => {
    const store = createTunableParamsStore(db);
    const hash = computeTopicTunableParamsHash(TOPIC, store);
    expect(hash).toMatch(/^fnv1a:[0-9a-f]{8}$/);
  });

  it('is stable across reads with no state change', () => {
    const store = createTunableParamsStore(db);
    const a = computeTopicTunableParamsHash(TOPIC, store);
    const b = computeTopicTunableParamsHash(TOPIC, store);
    expect(a).toBe(b);
  });

  it('flips when the user tunes a param', () => {
    const store = createTunableParamsStore(db);
    const baseline = computeTopicTunableParamsHash(TOPIC, store);
    store.writeParam(TOPIC, 'stall_window_days', 90, NOW);
    const tuned = computeTopicTunableParamsHash(TOPIC, store);
    expect(tuned).not.toBe(baseline);
  });

  it('returns to baseline after reset', () => {
    const store = createTunableParamsStore(db);
    const baseline = computeTopicTunableParamsHash(TOPIC, store);
    store.writeParam(TOPIC, 'stall_window_days', 90, NOW);
    expect(computeTopicTunableParamsHash(TOPIC, store)).not.toBe(baseline);
    store.resetParam(TOPIC, 'stall_window_days');
    expect(computeTopicTunableParamsHash(TOPIC, store)).toBe(baseline);
  });

  it('two distinct tuned values produce distinct hashes', () => {
    const store = createTunableParamsStore(db);
    store.writeParam(TOPIC, 'stall_window_days', 30, NOW);
    const a = computeTopicTunableParamsHash(TOPIC, store);
    store.writeParam(TOPIC, 'stall_window_days', 60, NOW + 1);
    const b = computeTopicTunableParamsHash(TOPIC, store);
    expect(a).not.toBe(b);
  });
});

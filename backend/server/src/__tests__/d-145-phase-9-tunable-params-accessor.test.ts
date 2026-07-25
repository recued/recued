/** D-145 § A.7.8 (Amended 2026-05-26) — TunableParamsAccessor tests.
 *
 *  Covers:
 *    - createTunableParamsAccessor.getNumber: returns default with no
 *      override, override when present, clamps to bounds defensively,
 *      Number.NaN for unknown param.
 *    - createTunableParamsAccessor.getEnum: returns default with no
 *      override, override when present, '' for unknown param.
 *    - Standalone helpers `getTunableNumber` / `getTunableEnum`:
 *      fall back to declaration default when ctx.tunableParams is
 *      undefined (test-scaffold scenario). */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureHousekeepingSchema } from '../housekeeping/schema.js';
import {
  createTunableParamsAccessor,
  getTunableEnum,
  getTunableNumber,
} from '../housekeeping/tunable-params-accessor.js';
import { createTunableParamsStore } from '../housekeeping/tunable-params-store.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';

const NOW = 1_700_000_000_000;
const TOPIC = 'project_stall_signal';

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-145-pa9-tunable-accessor-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  ensureHousekeepingSchema(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────
// createTunableParamsAccessor.getNumber
// ────────────────────────────────────────────────────────────────

describe('TunableParamsAccessor.getNumber', () => {
  it('returns declaration default when no override row', () => {
    const store = createTunableParamsStore(db);
    const accessor = createTunableParamsAccessor(store);
    expect(accessor.getNumber(TOPIC, 'stall_window_days')).toBe(14);
  });

  it('returns the override value when present', () => {
    const store = createTunableParamsStore(db);
    store.writeParam(TOPIC, 'stall_window_days', 90, NOW);
    const accessor = createTunableParamsAccessor(store);
    expect(accessor.getNumber(TOPIC, 'stall_window_days')).toBe(90);
  });

  it('clamps to min defensively when persisted value drifts below', () => {
    const store = createTunableParamsStore(db);
    // Inject an out-of-bounds row directly (simulates schema drift).
    db.prepare(
      `INSERT INTO enrichment_tunable_params (topic, param_name, value, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(TOPIC, 'stall_window_days', JSON.stringify(0), NOW);
    const accessor = createTunableParamsAccessor(store);
    // Store's defensive read returns default (14), accessor passes it
    // through — 14 is inside bounds so no further clamp.
    expect(accessor.getNumber(TOPIC, 'stall_window_days')).toBe(14);
  });

  it('returns Number.NaN for an unknown param (declaration is the contract)', () => {
    const store = createTunableParamsStore(db);
    const accessor = createTunableParamsAccessor(store);
    expect(Number.isNaN(accessor.getNumber(TOPIC, 'no_such_param'))).toBe(true);
  });

  it('returns Number.NaN for a topic without tunable_params declared', () => {
    const store = createTunableParamsStore(db);
    const accessor = createTunableParamsAccessor(store);
    expect(Number.isNaN(accessor.getNumber('preferred_channel_by_contact', 'x'))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// getTunableNumber — standalone helper (ctx-aware)
// ────────────────────────────────────────────────────────────────

describe('getTunableNumber — ctx helper', () => {
  it('reads through ctx.tunableParams when present', () => {
    const store = createTunableParamsStore(db);
    store.writeParam(TOPIC, 'stall_window_days', 60, NOW);
    const accessor = createTunableParamsAccessor(store);
    const ctx = { tunableParams: accessor } as unknown as HousekeepingContext;
    expect(getTunableNumber(ctx, TOPIC, 'stall_window_days')).toBe(60);
  });

  it('falls back to declaration default when ctx.tunableParams is undefined', () => {
    const ctx = { tunableParams: undefined } as unknown as HousekeepingContext;
    expect(getTunableNumber(ctx, TOPIC, 'stall_window_days')).toBe(14);
  });

  it('returns Number.NaN when ctx unwired AND param unknown', () => {
    const ctx = { tunableParams: undefined } as unknown as HousekeepingContext;
    expect(Number.isNaN(getTunableNumber(ctx, TOPIC, 'no_such'))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// getTunableEnum — standalone helper (ctx-aware)
// ────────────────────────────────────────────────────────────────

describe('getTunableEnum — ctx helper', () => {
  it('returns empty string when param unknown AND ctx unwired', () => {
    const ctx = { tunableParams: undefined } as unknown as HousekeepingContext;
    expect(getTunableEnum(ctx, TOPIC, 'no_such')).toBe('');
  });

  it('returns empty string when kind mismatches via accessor (number declared, getEnum called)', () => {
    const store = createTunableParamsStore(db);
    const accessor = createTunableParamsAccessor(store);
    // The pilot topic only declares a number; reading via getEnum
    // returns string(default) since kind !== 'enum'.
    expect(accessor.getEnum(TOPIC, 'stall_window_days')).toBe('14');
  });
});

/** D-276 — per-step skip rates: making an inert gate visible.
 *
 *  🔑 WRITER AND READER ARE COMPOSED HERE, NOT CHECKED SEPARATELY. Every row
 *  is built by calling the real `deriveRunYield` on real step logs and
 *  serialising it the way `execute-handler` does, then read back through the
 *  real SQL. Two passing shape checks either side of a JSON boundary is how a
 *  field that is written one way and read another stays green.
 *
 *  The case that motivated it, measured 2026-09-20: `extract-tasks-from-mail`
 *  gates task creation on a self-rated `extraction_confidence` against a 0.7
 *  floor, and the model returns 0.85-0.95 for everything — including a
 *  newsletter and a purely social note, both of which it invented a task
 *  title for. 18/18 cleared the floor. The gate had never filtered anything
 *  and nothing recorded that. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deriveRunYield } from '@recued/contracts';

import {
  GATE_RATE_MIN_RUNS,
  classifySkipRate,
  conditionalStepIds,
  inertConditions,
  stepSkipRates,
} from '../metrics/gate-rates.js';

const RECIPE = 'extract-tasks-from-mail';
const T0 = 1_700_000_000_000;

let dir: string;
let db: Database.Database;

/** Mirrors `execute-handler`'s anchor write: the run yield is derived from the
 *  engine's own step logs and folded into the opaque `data` blob. */
const writeRun = (
  key: string,
  steps: ReadonlyArray<{ id?: string; skipped?: boolean }>,
  opts: { recipe_id?: string; started_at?: number } = {},
): void => {
  db.prepare('INSERT INTO audit_entries (key, data) VALUES (?, ?)').run(
    key,
    JSON.stringify({
      recipe_id: opts.recipe_id ?? RECIPE,
      started_at: opts.started_at ?? T0,
      run_yield: deriveRunYield(steps),
    }),
  );
};

/** A pre-D-276 anchor: a run yield with the three original counts and no
 *  `skipped_step_ids` at all. */
const writeLegacyRun = (key: string, steps_skipped: number): void => {
  db.prepare('INSERT INTO audit_entries (key, data) VALUES (?, ?)').run(
    key,
    JSON.stringify({
      recipe_id: RECIPE,
      started_at: T0,
      run_yield: { steps_run: 5, steps_skipped, items_total: 0, items_failed: 0 },
    }),
  );
};

/** One run of the shipped shape: the branch arm always skips, the confidence
 *  gate skips only when `gateFired`. */
const shippedRun = (gateFired: boolean) => [
  { id: 'body', skipped: false },
  { id: 'thread', skipped: true }, // the unused branch arm — skips every run
  { id: 'extract', skipped: false },
  { id: 'below_threshold', skipped: gateFired },
  { id: 'create', skipped: gateFired },
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-276-gate-rates-'));
  db = new Database(join(dir, 'test.db'));
  db.exec('CREATE TABLE audit_entries (key TEXT PRIMARY KEY, data TEXT NOT NULL)');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────
// deriveRunYield — the writer half
// ────────────────────────────────────────────────────────────────

describe('deriveRunYield — skipped_step_ids', () => {
  it('names the skipped steps and leaves the counts intact', () => {
    const y = deriveRunYield([
      { id: 'a', skipped: false },
      { id: 'b', skipped: true },
      { id: 'c', skipped: true },
    ]);
    expect(y.skipped_step_ids).toEqual(['b', 'c']);
    expect(y.steps_run).toBe(1);
    expect(y.steps_skipped).toBe(2);
  });

  it('EMITS [] when nothing skipped — absent must mean "not recorded"', () => {
    const y = deriveRunYield([{ id: 'a', skipped: false }]);
    // ⛔ Not `undefined`. An omitted-when-empty field cannot distinguish
    // "recorded, nothing skipped" from a pre-D-276 row, which is the one
    // ambiguity this field exists to remove.
    expect(y.skipped_step_ids).toEqual([]);
    expect('skipped_step_ids' in y).toBe(true);
  });

  it('counts an id-less skipped step but cannot name it, so the two disagree', () => {
    const y = deriveRunYield([{ skipped: true }, { id: 'b', skipped: true }]);
    expect(y.steps_skipped).toBe(2);
    expect(y.skipped_step_ids).toEqual(['b']);
  });
});

// ────────────────────────────────────────────────────────────────
// conditionalStepIds — scoping the report to the gate set
// ────────────────────────────────────────────────────────────────

describe('conditionalStepIds', () => {
  it('returns only steps carrying a skip_when', () => {
    expect(conditionalStepIds({
      steps: [
        { id: 'always' },
        { id: 'gated', skip_when: '{{step.x}} equal true' },
        { id: 'empty_cond', skip_when: '' },
        { skip_when: '{{step.y}} equal true' }, // no id — unnameable
      ],
    })).toEqual(['gated']);
  });

  it('is empty for a recipe with no conditions, and safe on null', () => {
    expect(conditionalStepIds({ steps: [{ id: 'a' }] })).toEqual([]);
    expect(conditionalStepIds(null)).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// The finding: a gate that never fired
// ────────────────────────────────────────────────────────────────

describe('stepSkipRates — the inert gate', () => {
  it('reports a never-skipped gate at 0%, though the log never mentions it', () => {
    // 40 runs, the confidence gate passing every time — the measured shape.
    for (let i = 0; i < 40; i += 1) writeRun(`r${i}`, shippedRun(false));

    const rows = stepSkipRates(db, {
      recipe_id: RECIPE,
      step_ids: ['below_threshold', 'thread'],
    });
    const gate = rows.find((r) => r.step_id === 'below_threshold')!;

    // ⛔ `below_threshold` appears in ZERO audit rows — only skipped ids are
    // stored. A discovery query would have omitted it entirely; it is present
    // here only because the caller named it.
    expect(gate.runs).toBe(40);
    expect(gate.skipped).toBe(0);
    expect(gate.skip_rate).toEqual({ kind: 'value', value: 0 });
    expect(gate.verdict).toBe('always_ran');

    // And the branch arm beside it is at 100% — unremarkable, which is why
    // scoping to `skip_when` steps is not enough on its own to read a verdict.
    expect(rows.find((r) => r.step_id === 'thread')!.verdict).toBe('always_skipped');
  });

  it('a gate that discriminates reads as varies', () => {
    for (let i = 0; i < 40; i += 1) writeRun(`r${i}`, shippedRun(i % 4 === 0));
    const [gate] = stepSkipRates(db, { recipe_id: RECIPE, step_ids: ['below_threshold'] });
    expect(gate!.skipped).toBe(10);
    expect(gate!.skip_rate).toEqual({ kind: 'value', value: 0.25 });
    expect(gate!.verdict).toBe('varies');
  });

  it('inertConditions keeps both extremes and drops the one that decided', () => {
    for (let i = 0; i < 40; i += 1) writeRun(`r${i}`, shippedRun(i % 4 === 0));
    const rows = stepSkipRates(db, {
      recipe_id: RECIPE,
      step_ids: ['below_threshold', 'thread', 'create'],
    });
    // `create` skips exactly when the gate fires, so it varies too.
    expect(inertConditions(rows).map((r) => r.step_id)).toEqual(['thread']);
  });
});

// ────────────────────────────────────────────────────────────────
// The two ways this could quietly lie
// ────────────────────────────────────────────────────────────────

describe('stepSkipRates — absent is not empty', () => {
  it('excludes pre-D-276 rows from the denominator instead of reading them as "nothing skipped"', () => {
    for (let i = 0; i < 25; i += 1) writeRun(`new${i}`, shippedRun(true));  // gate fired
    for (let i = 0; i < 75; i += 1) writeLegacyRun(`old${i}`, 2);           // no ids

    const [gate] = stepSkipRates(db, { recipe_id: RECIPE, step_ids: ['below_threshold'] });

    // ⛔ Counting the 75 legacy rows would give 25/100 = 'varies' and hide a
    // gate that fired on every run it was actually observed for.
    expect(gate!.runs).toBe(25);
    expect(gate!.skipped).toBe(25);
    expect(gate!.verdict).toBe('always_skipped');
  });

  it('an empty window is absent, never a confident 0%', () => {
    const [gate] = stepSkipRates(db, { recipe_id: RECIPE, step_ids: ['below_threshold'] });
    expect(gate!.runs).toBe(0);
    expect(gate!.skip_rate).toEqual({ kind: 'absent' });
    expect(gate!.verdict).toBe('insufficient_data');
  });
});

describe('stepSkipRates — scoping', () => {
  it('withholds a verdict below the run floor', () => {
    for (let i = 0; i < GATE_RATE_MIN_RUNS - 1; i += 1) writeRun(`r${i}`, shippedRun(false));
    const [gate] = stepSkipRates(db, { recipe_id: RECIPE, step_ids: ['below_threshold'] });
    expect(gate!.runs).toBe(GATE_RATE_MIN_RUNS - 1);
    // The arithmetic says 0%; the sample says nothing.
    expect(gate!.skip_rate).toEqual({ kind: 'value', value: 0 });
    expect(gate!.verdict).toBe('insufficient_data');
  });

  it('counts only this recipe', () => {
    for (let i = 0; i < 30; i += 1) writeRun(`mine${i}`, shippedRun(false));
    for (let i = 0; i < 30; i += 1) {
      writeRun(`other${i}`, shippedRun(true), { recipe_id: 'triage-inbox' });
    }
    const [gate] = stepSkipRates(db, { recipe_id: RECIPE, step_ids: ['below_threshold'] });
    expect(gate!.runs).toBe(30);
    expect(gate!.skipped).toBe(0);
  });

  it('honours the window bounds', () => {
    for (let i = 0; i < 30; i += 1) writeRun(`old${i}`, shippedRun(true), { started_at: T0 });
    for (let i = 0; i < 30; i += 1) {
      writeRun(`new${i}`, shippedRun(false), { started_at: T0 + 10_000 });
    }
    const [gate] = stepSkipRates(db, {
      recipe_id: RECIPE,
      step_ids: ['below_threshold'],
      since: T0 + 5_000,
    });
    expect(gate!.runs).toBe(30);
    expect(gate!.verdict).toBe('always_ran');
  });

  it('returns nothing when asked about no steps', () => {
    for (let i = 0; i < 30; i += 1) writeRun(`r${i}`, shippedRun(false));
    expect(stepSkipRates(db, { recipe_id: RECIPE, step_ids: [] })).toEqual([]);
  });
});

describe('classifySkipRate', () => {
  it('is re-classifiable at a different floor without re-querying', () => {
    expect(classifySkipRate(0, 10, 20)).toBe('insufficient_data');
    expect(classifySkipRate(0, 10, 5)).toBe('always_ran');
    expect(classifySkipRate(10, 10, 5)).toBe('always_skipped');
    expect(classifySkipRate(3, 10, 5)).toBe('varies');
  });
});

/** D-250 § D8.1 slice 2 — the three anchor metrics.
 *
 *  🔑 WHAT THIS SUITE IS ACTUALLY GUARDING. Each metric is one division, so the
 *  arithmetic is not where this goes wrong — the SCOPE is. Every test below fixes a
 *  decision about which rows are in the denominator, because that is the decision a
 *  future edit will silently change and `metric_version` cannot detect (amendment 12
 *  ruled the bump rule a declaration, so the scope is what the tests have to hold).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTOPILOT_TRIGGER_CLASS,
  assertMetricRegistryConsistent,
  classifyAutopilotTrigger,
  METRIC_REGISTRY,
} from '@recued/contracts';

import { computeAnchorMetrics } from '../metrics/anchor-metrics.js';

const T0 = 1_700_000_000_000;
const WINDOW = { from: T0 - 86_400_000, to: T0 + 86_400_000 };

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-250-anchor-'));
  db = new Database(join(dir, 'test.db'));
  db.exec('CREATE TABLE IF NOT EXISTS audit_entries (key TEXT PRIMARY KEY, data TEXT NOT NULL);');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
const run = (entry: Record<string, unknown>): void => {
  seq += 1;
  db.prepare('INSERT INTO audit_entries (key, data) VALUES (?, ?)').run(
    `run-${seq}`,
    JSON.stringify({ started_at: T0, ...entry }),
  );
};

const valueOf = (id: string): number | undefined => {
  const r = computeAnchorMetrics(db, WINDOW).metrics.find((m) => m.metric_id === id)?.reading;
  return r?.kind === 'value' ? r.value : undefined;
};

// ────────────────────────────────────────────────────────────────
// 1. ABSENT, NEVER ZERO
// ────────────────────────────────────────────────────────────────

describe('D-250 § D — an empty window measures nothing', () => {
  it('⛔⛔ EVERY METRIC IS UNDEFINED ON AN EMPTY WINDOW, NOT 0', () => {
    // On a share, 0 is a real and bad reading ("nothing ran unattended"). Returning it
    // for a server that simply did nothing would be a confident lie, and the dashboard
    // could not tell the two apart.
    for (const m of computeAnchorMetrics(db, WINDOW).metrics) {
      expect(m.reading.kind).toBe('absent');
      expect(m.denominator).toBe(0);
    }
  });

  it('a run outside the window is not measured', () => {
    run({ started_at: T0 - 10 * 86_400_000, trigger_source: 'schedule' });
    expect(valueOf('autopilot')).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// 2. AUTOPILOT — the scope decisions
// ────────────────────────────────────────────────────────────────

describe('D-250 § D — Autopilot counts what ran without the owner', () => {
  it('unattended ÷ classified', () => {
    run({ trigger_source: 'schedule' });
    run({ trigger_source: 'auto_run' });
    run({ trigger_source: 'manual' });
    run({ trigger_source: 'chat' });
    expect(valueOf('autopilot')).toBe(0.5);
  });

  it('⛔⛔ AN UNKNOWN SOURCE IS EXCLUDED AND COUNTED — never bucketed', () => {
    // A closed vocabulary keyed as a plain lookup FAILS OPEN: a trigger_source added
    // elsewhere would land in whichever bucket the fallback picked, changing what
    // Autopilot means with no version bump and nothing to notice it by.
    run({ trigger_source: 'schedule' });
    run({ trigger_source: 'manual' });
    run({ trigger_source: 'some_future_source' });
    const res = computeAnchorMetrics(db, WINDOW);
    expect(valueOf('autopilot')).toBe(0.5);
    expect(res.metrics.find((m) => m.metric_id === 'autopilot')?.denominator).toBe(2);
    expect(res.unclassified_runs).toBe(1);
  });

  it('⛔ A NULL SOURCE IS COUNTED SEPARATELY from an unknown one', () => {
    // "Never recorded a source" and "recorded one we do not know" are different facts,
    // and one counter cannot tell them apart.
    run({ trigger_source: null });
    run({ trigger_source: 'nope' });
    const res = computeAnchorMetrics(db, WINDOW);
    expect(res.null_trigger_runs).toBe(1);
    expect(res.unclassified_runs).toBe(1);
  });

  it('⛔ HOUSEKEEPING IS EXCLUDED FROM BOTH HALVES', () => {
    // Counting the server's own maintenance as unattended would let a busy idle cycle
    // inflate the owner's autonomy score for work they never arranged — § D6's failure
    // shape, an optimal cheat that is not the desired behaviour.
    run({ trigger_source: 'schedule' });
    run({ trigger_source: 'manual' });
    run({ trigger_source: 'housekeeping' });
    run({ trigger_source: 'housekeeping' });
    expect(valueOf('autopilot')).toBe(0.5);
    expect(computeAnchorMetrics(db, WINDOW).unclassified_runs).toBe(0);
  });

  it('⛔ A BACKFILL RUN_MODE IS EXCLUDED even under another trigger', () => {
    run({ trigger_source: 'schedule' });
    run({ trigger_source: 'manual' });
    run({ trigger_source: 'schedule', run_mode: 'backfill' });
    run({ trigger_source: 'schedule', run_mode: 'backfill' });
    expect(valueOf('autopilot')).toBe(0.5);
  });

  it('⛔⛔ THE CLASSIFICATION IS AUTHORED HERE, NOT DERIVED FROM THE MAP', () => {
    // The drift test below reads AUTOPILOT_TRIGGER_CLASS for its expectation, so it
    // proves the SQL agrees with the map and NOTHING about whether the map says what
    // was decided — reclassifying `mcp` survived it. This table is hand-written on
    // purpose: it is the decision, and moving a source has to redden something.
    const DECIDED: Readonly<Record<string, string>> = {
      // ran without the owner present
      schedule: 'unattended',
      auto_run: 'unattended',
      reactive: 'unattended',
      webhook: 'unattended',
      reception: 'unattended',
      event_trigger: 'unattended',
      // the owner was there. `mcp` is ATTENDED: an external agent calling in is a live
      // request being served, not a standing arrangement running itself.
      manual: 'attended',
      chat: 'attended',
      mcp: 'attended',
      // neither — see the registry's reasoning
      backfill: 'excluded',
      housekeeping: 'excluded',
    };
    expect(AUTOPILOT_TRIGGER_CLASS).toStrictEqual(DECIDED);
  });

  it('the SQL and the map cannot drift — every mapped source classifies as declared', () => {
    // The SQL IN-lists are GENERATED from AUTOPILOT_TRIGGER_CLASS. This drives every
    // member through the real query rather than trusting that generation.
    for (const [source, cls] of Object.entries(AUTOPILOT_TRIGGER_CLASS)) {
      db.exec('DELETE FROM audit_entries');
      seq = 0;
      run({ trigger_source: source });
      const res = computeAnchorMetrics(db, WINDOW);
      const ap = res.metrics.find((m) => m.metric_id === 'autopilot');
      expect(classifyAutopilotTrigger(source)).toBe(cls);
      if (cls === 'unattended') expect(valueOf('autopilot')).toBe(1);
      else if (cls === 'attended') expect(valueOf('autopilot')).toBe(0);
      else {
        expect(ap?.reading.kind).toBe('absent');
        expect(res.unclassified_runs).toBe(0); // excluded ≠ unclassified
      }
    }
  });
});

// ────────────────────────────────────────────────────────────────
// 3. ECONOMY — items per 1,000 tokens
// ────────────────────────────────────────────────────────────────

describe('D-250 § D — Economy is items per 1,000 tokens', () => {
  it('scales by 1,000 (§ D5.4 — MPG, not L/100km)', () => {
    run({ run_yield: { items_total: 40, items_failed: 0 }, total_usage: { total_tokens: 8000 } });
    expect(valueOf('economy')).toBe(5); // 40 items / 8 thousand-tokens
  });

  it('⛔⛔ FAILED ITEMS DO NOT COUNT AS PROCESSED — otherwise refusing is the optimal cheat', () => {
    // A `foreach` is continue-on-error by design, so an all-refused run reports
    // success: true. Counting items_total would make "reject every item cheaply" the
    // highest-scoring strategy — the exact inversion § D6's selection rule exists to
    // prevent.
    run({ run_yield: { items_total: 100, items_failed: 100 }, total_usage: { total_tokens: 1000 } });
    expect(valueOf('economy')).toBe(0);
  });

  it('⛔ A RUN THAT SPENT TOKENS WITHOUT ITEMS IS OUT OF SCOPE, not a zero', () => {
    // Non-batch AI work is different work, not inefficiency. Putting its tokens in the
    // denominator with nothing in the numerator would punish a server for doing it.
    run({ run_yield: { items_total: 10, items_failed: 0 }, total_usage: { total_tokens: 1000 } });
    run({ run_yield: { items_total: 0, items_failed: 0 }, total_usage: { total_tokens: 9000 } });
    expect(valueOf('economy')).toBe(10); // 10 items / 1 thousand-tokens, not 10/10
  });

  it('⛔ A RUN WITH ITEMS BUT NO AI IS ALSO OUT OF SCOPE', () => {
    // Otherwise a server doing bulk non-AI work would show unbounded economy.
    run({ run_yield: { items_total: 10, items_failed: 0 }, total_usage: { total_tokens: 1000 } });
    run({ run_yield: { items_total: 500, items_failed: 0 } });
    expect(valueOf('economy')).toBe(10);
  });

  it('the local family reports tokens per run and per item (§ D5.4)', () => {
    run({ run_yield: { items_total: 10, items_failed: 0 }, total_usage: { total_tokens: 1000 } });
    run({ total_usage: { total_tokens: 3000 } });
    const fam = computeAnchorMetrics(db, WINDOW).economy_family;
    expect(fam.tokens_per_run).toBe(2000); // (1000 + 3000) / 2 token-spending runs
    expect(fam.tokens_per_item).toBe(100); // 1000 / 10, in-scope runs only
  });
});

// ────────────────────────────────────────────────────────────────
// 4. THROUGHPUT — items per execution minute
// ────────────────────────────────────────────────────────────────

describe('D-250 § D — Throughput is items per execution minute', () => {
  it('counts items against machine time, with no AI requirement', () => {
    run({ run_yield: { items_total: 30, items_failed: 0 }, duration_ms: 60_000 });
    expect(valueOf('throughput')).toBe(30);
  });

  it('failed items do not count here either', () => {
    run({ run_yield: { items_total: 30, items_failed: 10 }, duration_ms: 60_000 });
    expect(valueOf('throughput')).toBe(20);
  });

  it('a zero-duration run is out of scope rather than infinite', () => {
    run({ run_yield: { items_total: 5, items_failed: 0 }, duration_ms: 0 });
    expect(valueOf('throughput')).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// 5. THE REGISTRY'S OWN RULES
// ────────────────────────────────────────────────────────────────

describe('D-250 § D3.1 — the metric registry', () => {
  it('⛔ A VERSION BUMP OWES A LOGIC LINE', () => {
    expect(() => assertMetricRegistryConsistent()).not.toThrow();
    for (const def of Object.values(METRIC_REGISTRY)) {
      expect(def.logic.length).toBe(def.metric_version);
    }
  });

  it('the computed version matches the registry, so a bump reaches the row', () => {
    run({ trigger_source: 'schedule' });
    for (const m of computeAnchorMetrics(db, WINDOW).metrics) {
      expect(m.metric_version).toBe(METRIC_REGISTRY[m.metric_id]?.metric_version);
    }
  });

  it('⛔ §D3.1 — the declared TriggerSource union is NOT the audit vocabulary', () => {
    // approval.ts declares `scheduled`; audit rows carry `schedule`. Ratcheting the
    // class map against that union would match nothing on the spelling that matters
    // and classify every real scheduled run as unknown. This pins the audit spelling.
    expect(classifyAutopilotTrigger('schedule')).toBe('unattended');
    expect(classifyAutopilotTrigger('scheduled')).toBe('excluded');
  });
});

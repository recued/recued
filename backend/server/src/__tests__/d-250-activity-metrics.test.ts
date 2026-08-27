/** D-250 § D8.1 slice 3 — Toolmaker, Waved through, Creator and Burst.
 *
 *  🔑 THE SCOPE IS AGAIN WHERE THIS GOES WRONG, plus one thing slice 2 did not have:
 *  every field these metrics read lives inside `detail`, which is a JSON STRING nested
 *  in a JSON blob. A single `json_extract` returns the string and every predicate
 *  against it silently matches nothing — producing a confident zero, not an error. § 1
 *  exists to pin that.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ASKABLE_RISK_TIERS,
  BURST_IDLE_GAP_MS,
  GATEWAY_OP_ACTION,
  METRIC_REGISTRY,
  NON_ASKABLE_RISK_TIERS,
  RISK_TIERS,
} from '@recued/contracts';

import { computeActivityMetrics } from '../metrics/activity-metrics.js';

const T0 = 1_700_000_000_000;
const WINDOW = { from: T0 - 86_400_000, to: T0 + 30 * 86_400_000 };

let dir: string;
let db: Database.Database;
let seq = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-250-act-'));
  db = new Database(join(dir, 'test.db'));
  db.exec(
    'CREATE TABLE IF NOT EXISTS audit_activities (key TEXT PRIMARY KEY, data TEXT NOT NULL);',
  );
  seq = 0;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const activity = (action: string, timestamp: number, detail?: Record<string, unknown>): void => {
  seq += 1;
  db.prepare('INSERT INTO audit_activities (key, data) VALUES (?, ?)').run(
    `act-${seq}`,
    JSON.stringify({
      activity_id: `a${seq}`,
      timestamp,
      action,
      target: 'conn',
      // ⚠ STRINGIFIED, exactly as server-executor.ts writes it. A test that stored the
      // object would pass against a single-extract implementation the real writer
      // breaks — the double extract would then be untested.
      ...(detail ? { detail: JSON.stringify(detail) } : {}),
    }),
  );
};

const op = (detail: Record<string, unknown>, at = T0): void =>
  activity(GATEWAY_OP_ACTION, at, detail);

const read = (id: string) =>
  computeActivityMetrics(db, WINDOW).metrics.find((m) => m.metric_id === id)?.reading;
const num = (id: string): number | undefined => {
  const r = read(id);
  return r?.kind === 'value' ? r.value : undefined;
};

// ────────────────────────────────────────────────────────────────
// 1. THE DOUBLE EXTRACT
// ────────────────────────────────────────────────────────────────

describe('D-250 § D — detail is a JSON string inside a JSON blob', () => {
  it('⛔⛔ FIELDS INSIDE `detail` ARE READ, not silently missed', () => {
    // The single-extract bug returns the whole detail STRING, so every predicate
    // against a field inside it matches nothing and the metric reports a confident 0
    // rather than failing. This is the canary for that whole class.
    op({ risk_tier: 'write', recipe_id: 'alice/bench' });
    expect(num('toolmaker')).toBe(1);
    expect(num('creator')).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// 2. TOOLMAKER
// ────────────────────────────────────────────────────────────────

describe('D-250 § D — Toolmaker is composed ops ÷ all gateway ops', () => {
  it('counts a recipe_id in detail, not the activity column', () => {
    op({ risk_tier: 'read', recipe_id: 'alice/bench' });
    op({ risk_tier: 'read' });
    expect(num('toolmaker')).toBe(0.5);
  });

  it('⛔ A RECIPE_ID ON THE ACTIVITY COLUMN DOES NOT COUNT — the writer never sets it', () => {
    // server-executor.ts calls logActivity({activity_id, timestamp, action, target,
    // detail}) with NO top-level recipe_id. Reading the column would score every real
    // gateway op as uncomposed.
    seq += 1;
    db.prepare('INSERT INTO audit_activities (key, data) VALUES (?, ?)').run(
      `act-${seq}`,
      JSON.stringify({
        activity_id: 'col', timestamp: T0, action: GATEWAY_OP_ACTION,
        target: 'conn', recipe_id: 'alice/bench', detail: JSON.stringify({ risk_tier: 'read' }),
      }),
    );
    expect(num('toolmaker')).toBe(0);
  });

  it('⛔ NON-GATEWAY ACTIVITIES ARE NOT GATEWAY OPS', () => {
    // § D5.5: not chat_tool_call (one-per-invocation would make composing LOWER the
    // count) and not connection_api (the transport call — wrapper plus internals).
    op({ risk_tier: 'read', recipe_id: 'r' });
    activity('chat_tool_call', T0, { recipe_id: 'r' });
    activity('connection_api', T0, { recipe_id: 'r' });
    expect(computeActivityMetrics(db, WINDOW).metrics[0]?.denominator).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// 3. WAVED THROUGH — and the three-state reading
// ────────────────────────────────────────────────────────────────

describe('D-250 § D — Waved through measures work per decision', () => {
  it('askable ops ÷ approvals answered', () => {
    for (let i = 0; i < 10; i += 1) op({ risk_tier: 'write' });
    activity('approval_allow', T0);
    activity('approval_deny', T0);
    expect(num('waved_through')).toBe(5);
  });

  it('⛔⛔ ZERO DECISIONS WITH ASKABLE WORK IS UNBOUNDED — the BEST case, not absent', () => {
    // § D5.3: it must rank above every finite value. A nullable number cannot express
    // that, and a plain divide-by-zero would silently drop exactly the best periods —
    // the metric would punish the behaviour it exists to reward.
    for (let i = 0; i < 5; i += 1) op({ risk_tier: 'destructive' });
    expect(read('waved_through')?.kind).toBe('unbounded');
  });

  it('⛔ ZERO DECISIONS WITH NO ASKABLE WORK IS ABSENT, not unbounded', () => {
    // Nothing happened. Ranking an idle server above a delegating one would invert it.
    op({ risk_tier: 'read' });
    expect(read('waved_through')?.kind).toBe('absent');
  });

  it('read-tier ops are not askable', () => {
    op({ risk_tier: 'read' });
    op({ risk_tier: 'write' });
    activity('approval_allow', T0);
    expect(num('waved_through')).toBe(1);
  });

  it('⛔ AN UNKNOWN RISK TIER IS EXCLUDED AND COUNTED', () => {
    // A new tier is a TYPE ERROR in the registry, but a row written by a different
    // server version on a shared log is not, and must not silently join a bucket.
    op({ risk_tier: 'write' });
    op({ risk_tier: 'catastrophic' });
    activity('approval_allow', T0);
    const res = computeActivityMetrics(db, WINDOW);
    expect(res.unknown_risk_rows).toBe(1);
    expect(num('waved_through')).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// 4. CREATOR
// ────────────────────────────────────────────────────────────────

describe('D-250 § D — Creator counts what was made', () => {
  it('counts askable ops and is NOT publishable (§ D2)', () => {
    op({ risk_tier: 'write' });
    op({ risk_tier: 'destructive' });
    op({ risk_tier: 'read' });
    expect(num('creator')).toBe(2);
    expect(METRIC_REGISTRY.creator?.publishable).toBe(false);
  });

  it('absent rather than 0 when no gateway op ran at all', () => {
    expect(read('creator')?.kind).toBe('absent');
  });
});

// ────────────────────────────────────────────────────────────────
// 5. BURST — gap-bounded, no partition
// ────────────────────────────────────────────────────────────────

const chatOp = (at: number): void =>
  op({ risk_tier: 'read', execution_source: { channel: 'chat' } }, at);

describe('D-250 § D5.5 — Burst is the longest stretch, split only by time', () => {
  it('a gap longer than the idle gap ends the stretch', () => {
    chatOp(T0);
    chatOp(T0 + 1000);
    chatOp(T0 + 2000); // stretch of 3
    chatOp(T0 + BURST_IDLE_GAP_MS + 10_000);
    chatOp(T0 + BURST_IDLE_GAP_MS + 11_000); // stretch of 2
    expect(num('burst')).toBe(3);
  });

  it('a gap SHORTER than the idle gap keeps one stretch', () => {
    chatOp(T0);
    chatOp(T0 + BURST_IDLE_GAP_MS - 1000);
    chatOp(T0 + BURST_IDLE_GAP_MS + 1000);
    expect(num('burst')).toBe(3);
  });

  it('⛔⛔ CHANNELS DO NOT PARTITION — chat and messenger fold into ONE stretch', () => {
    // Amendment 15: "slack+telegram+discord+10 webclients ... and still be valid". The
    // optimal cheat is running that much genuinely parallel work, which is the desired
    // behaviour. Partitioning would quietly punish it.
    op({ risk_tier: 'read', execution_source: { channel: 'chat' } }, T0);
    op({ risk_tier: 'read', execution_source: { channel: 'messenger' } }, T0 + 100);
    op({ risk_tier: 'read', execution_source: { channel: 'messenger' } }, T0 + 200);
    expect(num('burst')).toBe(3);
  });

  it('⛔ NON-MODEL CHANNELS ARE EXCLUDED — cron and webhooks are not a burst', () => {
    chatOp(T0);
    op({ risk_tier: 'read', execution_source: { channel: 'schedule' } }, T0 + 100);
    op({ risk_tier: 'read', execution_source: { channel: 'webhook' } }, T0 + 200);
    op({ risk_tier: 'read' }, T0 + 300); // no execution_source at all
    expect(num('burst')).toBe(1);
  });

  it('absent when nothing model-initiated ran', () => {
    op({ risk_tier: 'read', execution_source: { channel: 'schedule' } });
    expect(read('burst')?.kind).toBe('absent');
  });

  it('⚠ IT IS A WINDOW OBSERVATION, NOT THE RECORD — the artifact store advances it', () => {
    // Burst is store: 'artifact'. If this returned "the record", a quiet week would
    // ERASE a standing best. The compute answers only for the window it was given.
    chatOp(T0);
    chatOp(T0 + 1000);
    const narrow = computeActivityMetrics(db, { from: T0 + 500, to: T0 + 5000 });
    const r = narrow.metrics.find((m) => m.metric_id === 'burst')?.reading;
    expect(r?.kind === 'value' ? r.value : undefined).toBe(1);
    expect(METRIC_REGISTRY.burst?.store).toBe('artifact');
  });
});

// ────────────────────────────────────────────────────────────────
// 6. THE ASKABLE SET IS AUTHORED
// ────────────────────────────────────────────────────────────────

describe('D-250 § D5.3 — the askable risk set', () => {
  it('⛔⛔ AUTHORED, NOT DERIVED — moving a tier has to redden something', () => {
    expect([...ASKABLE_RISK_TIERS]).toStrictEqual(['write', 'admin', 'destructive']);
    expect([...NON_ASKABLE_RISK_TIERS]).toStrictEqual(['read']);
  });

  it('the two halves cover RISK_TIERS exactly — no tier in both, none in neither', () => {
    // The compile-time ratchet already forbids "neither"; this pins "both" too, and
    // fails at runtime for anyone reading the suite rather than the type.
    const union = [...ASKABLE_RISK_TIERS, ...NON_ASKABLE_RISK_TIERS];
    expect(new Set(union).size).toBe(union.length);
    expect([...union].sort()).toStrictEqual([...RISK_TIERS].sort());
  });
});

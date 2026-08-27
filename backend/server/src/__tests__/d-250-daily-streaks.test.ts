/** D-250 § D5.3 — Hands off, and the two audit-derivable milestones.
 *
 *  🔑 EVERY CASE HERE IS ABOUT TIME, NOT ARITHMETIC. A streak is one `+1` — what makes
 *  it wrong is crediting the wrong DAY: today before it is over, a day the server was
 *  off, or the same day twice because the task ran twice.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUDIT_DERIVABLE_MILESTONES,
  assertMilestoneRegistryConsistent,
  MILESTONE_REGISTRY,
} from '@recued/contracts';

import { createMetricArtifactStore, type MetricArtifactStore } from '../metrics/artifact-store.js';
import {
  advanceDailyStreaks,
  dayIndex,
  HANDS_OFF_CURRENT_KEY,
  HANDS_OFF_LONGEST_KEY,
  MAX_CATCHUP_DAYS,
  CENTURY_RUNS,
  recipeRunsKey,
} from '../metrics/daily-streaks.js';

const DAY = 86_400_000;
const D0 = Math.floor(1_700_000_000_000 / DAY) * DAY;
/** Mid-morning, so "today" is genuinely incomplete. */
const at = (dayOffset: number, hour = 10): number => D0 + dayOffset * DAY + hour * 3_600_000;

let dir: string;
let db: Database.Database;
let art: MetricArtifactStore;
let seq = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-250-streak-'));
  db = new Database(join(dir, 'test.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_entries (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_activities (key TEXT PRIMARY KEY, data TEXT NOT NULL);
  `);
  art = createMetricArtifactStore(db);
  seq = 0;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const approvalOn = (dayOffset: number): void => {
  seq += 1;
  db.prepare('INSERT INTO audit_activities (key, data) VALUES (?, ?)').run(
    `ap${seq}`,
    JSON.stringify({ activity_id: `ap${seq}`, timestamp: at(dayOffset, 14), action: 'approval_allow', target: 'x' }),
  );
};

const runOn = (dayOffset: number, trigger: string): void => {
  seq += 1;
  db.prepare('INSERT INTO audit_entries (key, data) VALUES (?, ?)').run(
    `r${seq}`, JSON.stringify({ started_at: at(dayOffset, 9), trigger_source: trigger }),
  );
};

// ────────────────────────────────────────────────────────────────
// 1. ONLY COMPLETE DAYS COUNT
// ────────────────────────────────────────────────────────────────

describe('D-250 § D5.3 — a day is decidable only once it is over', () => {
  it('⛔⛔ TODAY IS NEVER FOLDED, however quiet it looks', () => {
    // Crediting today at 10am is a guess an approval at 4pm falsifies — and because the
    // streak feeds a RECORD, a wrong credit is permanent.
    const r = advanceDailyStreaks(db, art, at(1));
    expect(r.days_folded).toBe(0);
    expect(r.hands_off_current).toBe(0);
  });

  it('yesterday IS folded, once a prior fold exists', () => {
    advanceDailyStreaks(db, art, at(1)); // seeds the cursor at day-1... i.e. day 0
    const r = advanceDailyStreaks(db, art, at(2));
    expect(r.days_folded).toBe(1);
    expect(r.hands_off_current).toBe(1);
  });

  it('⛔ AN APPROVAL ANSWERED THAT DAY BREAKS THE STREAK', () => {
    advanceDailyStreaks(db, art, at(1));
    approvalOn(1);
    const r = advanceDailyStreaks(db, art, at(2));
    expect(r.hands_off_current).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// 2. ONCE PER DAY, NOT ONCE PER CYCLE
// ────────────────────────────────────────────────────────────────

describe('D-250 — the task runs many times a day; the streak advances once', () => {
  it('⛔⛔ THREE CYCLES IN ONE DAY ADVANCE THE STREAK BY ONE', () => {
    advanceDailyStreaks(db, art, at(1));
    advanceDailyStreaks(db, art, at(2, 1));
    advanceDailyStreaks(db, art, at(2, 9));
    const r = advanceDailyStreaks(db, art, at(2, 23));
    expect(r.hands_off_current).toBe(1);
    expect(r.days_folded).toBe(0); // the later two folded nothing
  });

  it('consecutive quiet days accumulate', () => {
    advanceDailyStreaks(db, art, at(1));
    for (let d = 2; d <= 6; d += 1) advanceDailyStreaks(db, art, at(d));
    expect(art.readCounter(HANDS_OFF_CURRENT_KEY)).toBe(5);
  });
});

// ────────────────────────────────────────────────────────────────
// 3. THE RECORD SURVIVES THE BREAK
// ────────────────────────────────────────────────────────────────

describe('D-250 slice 1 — current is a counter, longest is a record', () => {
  it('⛔⛔ A BROKEN STREAK RESETS CURRENT AND LEAVES LONGEST STANDING', () => {
    advanceDailyStreaks(db, art, at(1));
    for (let d = 2; d <= 6; d += 1) advanceDailyStreaks(db, art, at(d));
    expect(art.readRecord(HANDS_OFF_LONGEST_KEY)).toBe(5);
    approvalOn(6);
    advanceDailyStreaks(db, art, at(7));
    expect(art.readCounter(HANDS_OFF_CURRENT_KEY)).toBe(0);
    expect(art.readRecord(HANDS_OFF_LONGEST_KEY)).toBe(5);
  });
});

// ────────────────────────────────────────────────────────────────
// 4. A COVERAGE GAP
// ────────────────────────────────────────────────────────────────

describe('D-250 — a server that was OFF cannot verify the days it missed', () => {
  it('⛔⛔ A LONG GAP RESETS RATHER THAN CREDITING UNVERIFIABLE DAYS', () => {
    // The audit log evicts oldest-first, so "no approval rows that day" and "that day's
    // rows are gone" are the SAME observation. Crediting would mint a streak out of
    // missing data.
    advanceDailyStreaks(db, art, at(1));
    for (let d = 2; d <= 6; d += 1) advanceDailyStreaks(db, art, at(d));
    expect(art.readCounter(HANDS_OFF_CURRENT_KEY)).toBe(5);

    const r = advanceDailyStreaks(db, art, at(6 + MAX_CATCHUP_DAYS + 5));
    expect(r.reset_for_gap).toBe(true);
    // ⚠ 1, NOT 0 — and the difference is the point. The unverifiable days are DISCARDED,
    // then YESTERDAY is folded normally because it IS verifiable. So the owner is on day
    // one of a new run, not staring at a zero that implies they answered something.
    expect(r.hands_off_current).toBe(1);
    // ⚠ And the RECORD is untouched — the gap breaks the run, it does not erase history.
    expect(art.readRecord(HANDS_OFF_LONGEST_KEY)).toBe(5);
  });

  it('a SHORT gap is walked, because those days are still in the log', () => {
    advanceDailyStreaks(db, art, at(1));
    advanceDailyStreaks(db, art, at(2));
    const r = advanceDailyStreaks(db, art, at(5)); // days 2,3,4 all quiet
    expect(r.reset_for_gap).toBe(false);
    expect(r.hands_off_current).toBe(4);
  });
});

// ────────────────────────────────────────────────────────────────
// 5. MILESTONES
// ────────────────────────────────────────────────────────────────

describe('D-250 § D5.3 — milestones are a category with its own registry', () => {
  it('⛔ THE `detectable` MARKER EXISTS BECAUSE THE ALTERNATIVE IS INDISTINGUISHABLE', () => {
    // ⚠ AMENDED 2026-08-25. This used to pin three milestones as `call_site` — and two of
    // those classifications were WRONG (peer answers and accumulated run counts are both
    // derivable from rows the task already reads), while the third had no call site at
    // all and was removed. What survives is the property the field exists for: an
    // undetectable milestone renders exactly like an unearned one, so the registry has to
    // say which is which — and today nothing is undetectable.
    expect(Object.values(MILESTONE_REGISTRY).every((m) => m.source === 'audit_window')).toBe(true);
    expect(AUDIT_DERIVABLE_MILESTONES).toHaveLength(Object.keys(MILESTONE_REGISTRY).length);
  });

  it('first_zero_approval_day is earned on the first quiet complete day', () => {
    advanceDailyStreaks(db, art, at(1));
    const r = advanceDailyStreaks(db, art, at(2));
    expect(r.milestones_earned).toContain('first_zero_approval_day');
    expect(art.hasMilestone('first_zero_approval_day')).toBe(true);
  });

  it('⛔ IT IS EARNED ONCE — a later quiet day does not re-announce it', () => {
    advanceDailyStreaks(db, art, at(1));
    advanceDailyStreaks(db, art, at(2));
    const again = advanceDailyStreaks(db, art, at(3));
    expect(again.milestones_earned).toEqual([]);
  });

  it('first_unattended_week needs seven days AND real unattended work', () => {
    advanceDailyStreaks(db, art, at(1));
    for (let d = 1; d <= 8; d += 1) runOn(d, 'schedule');
    for (let d = 2; d <= 8; d += 1) advanceDailyStreaks(db, art, at(d));
    expect(art.hasMilestone('first_unattended_week')).toBe(true);
  });

  it('⛔⛔ AN IDLE SERVER DOES NOT EARN A WEEK ON AUTOPILOT', () => {
    // Rewarding "did nothing" would be § D6's failure exactly — an optimal cheat that
    // is not the desired behaviour. Zero attended runs is necessary, not sufficient.
    advanceDailyStreaks(db, art, at(1));
    for (let d = 2; d <= 12; d += 1) advanceDailyStreaks(db, art, at(d));
    expect(art.hasMilestone('first_unattended_week')).toBe(false);
    // ...while the quiet-day milestone IS earned, because that one is about decisions.
    expect(art.hasMilestone('first_zero_approval_day')).toBe(true);
  });

  it('⛔ ONE ATTENDED RUN BREAKS THE UNATTENDED WEEK', () => {
    advanceDailyStreaks(db, art, at(1));
    for (let d = 1; d <= 8; d += 1) runOn(d, 'schedule');
    runOn(4, 'manual');
    for (let d = 2; d <= 8; d += 1) advanceDailyStreaks(db, art, at(d));
    expect(art.hasMilestone('first_unattended_week')).toBe(false);
  });

  it('a version bump owes a logic line', () => {
    expect(() => assertMilestoneRegistryConsistent()).not.toThrow();
  });
});

describe('D-250 — day indexing', () => {
  it('dayIndex is UTC-aligned', () => {
    expect(dayIndex(D0)).toBe(dayIndex(D0 + DAY - 1));
    expect(dayIndex(D0 + DAY)).toBe(dayIndex(D0) + 1);
  });
});

// ────────────────────────────────────────────────────────────────
// 6. THE TWO MILESTONES THAT WERE "call_site" AND ARE NOT
// ────────────────────────────────────────────────────────────────

const peerAnsweredOn = (dayOffset: number): void => {
  seq += 1;
  db.prepare('INSERT INTO audit_activities (key, data) VALUES (?, ?)').run(
    `pa${seq}`,
    JSON.stringify({
      activity_id: `pa${seq}`, timestamp: at(dayOffset, 11),
      action: 'peer_ask_answered', target: 'peer-1',
    }),
  );
};

const recipeRunOn = (dayOffset: number, recipe_id: string): void => {
  seq += 1;
  db.prepare('INSERT INTO audit_entries (key, data) VALUES (?, ?)').run(
    `rr${seq}`,
    JSON.stringify({ started_at: at(dayOffset, 8), trigger_source: 'schedule', recipe_id }),
  );
};

describe('D-250 § D5.3 — first peer is the ANSWER, not the ask', () => {
  it('⛔⛔ EARNED ON `peer_ask_answered` — a working two-way relationship', () => {
    // There is no server-side "pairing" moment: a peer is a CONFIGURED CONNECTION, so a
    // config edit would have been the wrong thing to celebrate. An answer proves someone
    // else's server actually replied.
    advanceDailyStreaks(db, art, at(1));
    peerAnsweredOn(1);
    const r = advanceDailyStreaks(db, art, at(2));
    expect(r.milestones_earned).toContain('first_peer_paired');
  });

  it('an outbound ask alone does NOT earn it', () => {
    advanceDailyStreaks(db, art, at(1));
    seq += 1;
    db.prepare('INSERT INTO audit_activities (key, data) VALUES (?, ?)').run(
      'ask1', JSON.stringify({
        activity_id: 'ask1', timestamp: at(1, 11), action: 'peer_ask_received', target: 'p',
      }),
    );
    advanceDailyStreaks(db, art, at(2));
    expect(art.hasMilestone('first_peer_paired')).toBe(false);
  });

  it('it is earned once', () => {
    advanceDailyStreaks(db, art, at(1));
    peerAnsweredOn(1); peerAnsweredOn(2);
    advanceDailyStreaks(db, art, at(2));
    expect(advanceDailyStreaks(db, art, at(3)).milestones_earned).toEqual([]);
  });
});

describe('D-250 § D5.3 — Century ACCUMULATES, it does not count', () => {
  it('⛔⛔ THE TOTAL SURVIVES AUDIT EVICTION', () => {
    // A GROUP BY over the log measures "runs still RETAINED" — the log is quota'd and
    // evicts oldest-first — so the badge would un-earn itself as the log rolled. Here the
    // rows are DELETED after each day is folded, exactly as eviction would, and the total
    // must keep climbing.
    advanceDailyStreaks(db, art, at(1));
    for (let d = 2; d <= 5; d += 1) {
      for (let i = 0; i < 30; i += 1) recipeRunOn(d, 'alice/bench');
      advanceDailyStreaks(db, art, at(d + 1));
      db.exec('DELETE FROM audit_entries'); // the log rolled
    }
    expect(art.readCounter(recipeRunsKey('alice/bench'))).toBe(120);
    expect(art.hasMilestone('first_recipe_100_runs')).toBe(true);
  });

  it('⛔ NOT EARNED BELOW THE THRESHOLD', () => {
    advanceDailyStreaks(db, art, at(1));
    for (let i = 0; i < CENTURY_RUNS - 1; i += 1) recipeRunOn(1, 'alice/bench');
    advanceDailyStreaks(db, art, at(2));
    expect(art.readCounter(recipeRunsKey('alice/bench'))).toBe(CENTURY_RUNS - 1);
    expect(art.hasMilestone('first_recipe_100_runs')).toBe(false);
  });

  it('⛔ COUNTS PER RECIPE — two recipes at 60 do not add up to a century', () => {
    // "The first RECIPE to reach 100 runs", not "100 runs total". Summing across recipes
    // would award a badge for breadth while claiming depth.
    advanceDailyStreaks(db, art, at(1));
    for (let i = 0; i < 60; i += 1) { recipeRunOn(1, 'a/one'); recipeRunOn(1, 'b/two'); }
    advanceDailyStreaks(db, art, at(2));
    expect(art.readCounter(recipeRunsKey('a/one'))).toBe(60);
    expect(art.readCounter(recipeRunsKey('b/two'))).toBe(60);
    expect(art.hasMilestone('first_recipe_100_runs')).toBe(false);
  });

  it('a run with no recipe_id is not counted against any recipe', () => {
    advanceDailyStreaks(db, art, at(1));
    for (let i = 0; i < 200; i += 1) runOn(1, 'schedule');
    advanceDailyStreaks(db, art, at(2));
    expect(art.hasMilestone('first_recipe_100_runs')).toBe(false);
  });
});

describe('D-250 — first_pack_published was REMOVED, not left unearnable', () => {
  it('⛔⛔ IT IS GONE FROM THE REGISTRY', () => {
    // There is no server-side call site and there cannot be one: publishing goes from the
    // webclient/CLI to a Supabase edge function and the server only ever INSTALLS. A
    // badge that can never light up reads as a personal failure on an achievements
    // surface (§ D5.1) — worse than an absent one.
    expect(MILESTONE_REGISTRY.first_pack_published).toBeUndefined();
  });

  it('⛔ EVERY REMAINING MILESTONE IS DETECTABLE — no unearnable badges left', () => {
    expect(Object.values(MILESTONE_REGISTRY).every((m) => m.source === 'audit_window')).toBe(true);
    expect([...AUDIT_DERIVABLE_MILESTONES].sort()).toEqual([
      'first_peer_paired', 'first_recipe_100_runs', 'first_unattended_week',
      'first_zero_approval_day',
    ]);
  });
});

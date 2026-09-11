/** D-261 § 9.1 — the advisory sibling-automation note.
 *
 *  ## What is under test, and what deliberately is not
 *
 *  Not under test: that an approval on one schedule authorises another. It
 *  cannot — every preapproval identity keys on `schedule_id`, and that is
 *  asserted by the existing D-261 suites. This covers the SECOND-ORDER problem
 *  duplicates create: `advancePreapprovalOccurrence` detects intervening
 *  execution OF ONE TARGET, so a duplicate can fire the same action between
 *  prepare and decide and the review stays silent about it.
 *
 *  The note closes that by informing, never by ruling — the substrate cannot
 *  tell "duplicated by mistake" from "duplicated on purpose", because the two
 *  are identical in every recorded field. So the assertions below are as much
 *  about what the note REFUSES to claim as about when it appears. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  countSiblingAutomations,
  siblingAutomationNote,
} from '../preapproval-sibling-notes.js';

const DUE = 1_800_000_000_000;

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd261-sib-'));
  db = new Database(join(dir, 'test.db'));
  db.exec(`CREATE TABLE schedules (
    schedule_id TEXT NOT NULL PRIMARY KEY,
    recipe_id   TEXT NOT NULL,
    data        TEXT NOT NULL
  );
  CREATE INDEX schedules_recipe_idx ON schedules (recipe_id);`);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const seed = (
  schedule_id: string,
  over: { recipe_id?: string; enabled?: boolean; next_run_at?: number | null; dish_id?: string | null } = {},
): void => {
  const recipe_id = over.recipe_id ?? 'send-digest';
  db.prepare('INSERT INTO schedules (schedule_id, recipe_id, data) VALUES (?,?,?)').run(
    schedule_id,
    recipe_id,
    JSON.stringify({
      schedule_id,
      recipe_id,
      publisher_id: 'core',
      cron_expression: '0 9 * * *',
      enabled: over.enabled ?? true,
      created_at: 0,
      last_run_at: null,
      next_run_at: over.next_run_at === undefined ? DUE : over.next_run_at,
      last_status: null,
      last_error: null,
      ...(over.dish_id !== undefined && over.dish_id !== null ? { dish_id: over.dish_id } : {}),
    }),
  );
};

const sweep = (over: Partial<Parameters<typeof countSiblingAutomations>[1]> = {}): number =>
  countSiblingAutomations(db, {
    recipe_id: 'send-digest',
    target_schedule_id: 'S1',
    dish_id: null,
    due_at: DUE,
    ...over,
  });

describe('D-261 § 9.1 — when the note fires', () => {
  it('reports a duplicate: same recipe, same dish, same instant', () => {
    seed('S1');
    seed('S2');
    expect(sweep()).toBe(1);
    expect(siblingAutomationNote(db, {
      recipe_id: 'send-digest', target_schedule_id: 'S1', dish_id: null, due_at: DUE,
    })).toBe('1 other automation is also set to run this action at this time.');
  });

  it('pluralises', () => {
    seed('S1'); seed('S2'); seed('S3');
    expect(siblingAutomationNote(db, {
      recipe_id: 'send-digest', target_schedule_id: 'S1', dish_id: null, due_at: DUE,
    })).toBe('2 other automations are also set to run this action at this time.');
  });

  it('matches on the bound dish too', () => {
    seed('S1', { dish_id: 'dish_a' });
    seed('S2', { dish_id: 'dish_a' });
    expect(sweep({ dish_id: 'dish_a' })).toBe(1);
  });
});

describe('D-261 § 9.1 — when it stays silent', () => {
  it('never counts the target itself', () => {
    seed('S1');
    expect(sweep()).toBe(0);
  });

  it('a different instant is not a duplicate', () => {
    seed('S1'); seed('S2', { next_run_at: DUE + 60_000 });
    expect(sweep()).toBe(0);
  });

  it('a different recipe is not a duplicate', () => {
    seed('S1'); seed('OTHER', { recipe_id: 'send-invoice' });
    expect(sweep()).toBe(0);
  });

  it('a different dish is not a duplicate — the config differs', () => {
    seed('S1', { dish_id: 'dish_a' });
    seed('S2', { dish_id: 'dish_b' });
    expect(sweep({ dish_id: 'dish_a' })).toBe(0);
  });

  it('a disabled sibling will not fire ordinarily', () => {
    seed('S1'); seed('S2', { enabled: false });
    expect(sweep()).toBe(0);
  });

  it('a sibling with no next_run_at has no instant to match', () => {
    seed('S1'); seed('S2', { next_run_at: null });
    expect(sweep()).toBe(0);
  });

  it('a target with NO due instant skips the sweep — a trigger makes no time claim', () => {
    seed('S1'); seed('S2');
    // Would be 1 with a due_at. A trigger fires on an event, so "at this
    // time" is not a claim the note is entitled to make.
    //
    // ⚠ THIS PASSES VIA THE INSTANT COMPARISON, not via the `due_at === null`
    // short-circuit above it — measured: deleting that line left this test
    // green, because a number never equals null. The property is real and
    // worth pinning; just do not read this case as coverage OF that line.
    expect(sweep({ due_at: null })).toBe(0);
  });

  it('a corrupt row is skipped, not thrown on', () => {
    seed('S1');
    db.prepare('INSERT INTO schedules (schedule_id, recipe_id, data) VALUES (?,?,?)')
      .run('BAD', 'send-digest', '{not json');
    seed('S2');
    expect(sweep()).toBe(1);
  });
});

describe('D-261 § 9.1 — the limits the note is honest about', () => {
  it('UNDER-DETECTS two different dishes with identical config', () => {
    // ⛔ Pinned as a KNOWN limit, not an accident. The sweep matches on
    // `dish_id`, so two distinct dishes carrying byte-identical overlays are
    // the same action and go unreported. Under-detection is the safe
    // direction: a missed warning leaves the owner where they already are; a
    // false one would assert something never verified. Making this exact
    // means resolving `dispatch_hash` per sibling at a layer that can — this
    // assertion should FLIP, not be deleted, if that ever ships.
    seed('S1', { dish_id: 'dish_a' });
    seed('S2', { dish_id: 'dish_b' });
    expect(sweep({ dish_id: 'dish_a' })).toBe(0);
  });

  it('a sibling parked by its OWN preapproval is skipped to avoid double-counting', () => {
    // Parking stores `enabled: false` while the row still dispatches. Both
    // sides would otherwise warn about one pair; the parked side's own review
    // carries the mirror note.
    seed('S1'); seed('S2', { enabled: false });
    expect(sweep()).toBe(0);
  });
});

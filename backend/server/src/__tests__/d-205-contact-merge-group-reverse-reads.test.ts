/** D-205 #3.5 — the merge's REVERSE direction.
 *
 *  A merge does not move rows. It records an edge (`merged_into`) and leaves
 *  every row keyed on the address it was written under. That rescues the
 *  FORWARD direction (a stored ref → the surviving contact) and nothing else:
 *  a REVERSE read — "given this contact, find its rows" — asked for ONE address
 *  and silently missed everything the contact had absorbed.
 *
 *  Nothing was lost. It was unreachable from the survivor's key, which is worse
 *  than lost: every per-contact fact Recued computes still produced a confident
 *  number, over a fraction of the evidence, and the model states those numbers
 *  to the user as truth.
 *
 *  These tests pin the address set + the reverse reads that consume it. The
 *  load-bearing ones are the "before the fix this passed with the WRONG number"
 *  cases — each asserts a value that is only reachable by reading across the
 *  merge group, so reverting the expansion turns them red. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { contactAddressSet, contactDisplayName } from '../storage/contact-merge-graph.js';
import { createContactStore, type ContactStore } from '../storage/contact-store.js';
import { COMMITMENT_TABLE, TASK_TABLE } from '../storage/work-entity-store.js';
import { countTerminalCommitmentsForContact } from '../housekeeping/producers/commitment-followthrough-score.js';
import { countCompletedTasksForContact } from '../housekeeping/producers/task-completion-velocity.js';
import { computeDedupConfidence } from '../housekeeping/producers/task-duplicate-candidate.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

const SURVIVOR = 'bob.new@acme.com';
const LOSER = 'bob.old@acme.com';
const ELDEST = 'b.smith@acme.com'; // merged into LOSER, which merged into SURVIVOR
const STRANGER = 'carol@other.com';

let dir: string;
let db: Database.Database;
let contacts: ContactStore;

/** The producers only ever touch `ctx.db` + `ctx.now` on these paths. */
const ctx = (): HousekeepingContext =>
  ({ db, now: () => NOW }) as unknown as HousekeepingContext;

const addContact = (email: string): void => {
  contacts.observe(
    { email, name: email.split('@')[0]!, source: 'email_from', event_at: NOW },
    NOW,
  );
};

/** Record the merge EDGE the way `contact.merge.confirm` does — a tombstone on
 *  the loser, nothing moved. */
const mergeInto = (loser: string, survivor: string): void => {
  const row = contacts.get(loser);
  if (!row) throw new Error(`fixture: no contact ${loser}`);
  contacts.setMergedInto([row], survivor, NOW);
};

const addCommitment = (
  id: string,
  counterparty: string,
  lifecycle: string,
  state_changed_at: number,
): void => {
  db.prepare(
    `INSERT INTO ${COMMITMENT_TABLE}
       (id, direction, lifecycle_state, counterparty_contact_id, state_changed_at, sync_state)
     VALUES (?, 'inbound', ?, ?, ?, 'live')`,
  ).run(id, lifecycle, counterparty, state_changed_at);
};

const addCompletedTask = (id: string, assignee: string, completed_at: number): void => {
  db.prepare(
    `INSERT INTO ${TASK_TABLE}
       (id, done, completed_at, assigned_contact_id, sync_state)
     VALUES (?, 1, ?, ?, 'live')`,
  ).run(id, completed_at, assignee);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-205-merge-group-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  contacts = createContactStore(db);
  // Minimal work-entity tables — only the columns these producers read.
  db.exec(`
    CREATE TABLE ${COMMITMENT_TABLE} (
      id                       TEXT PRIMARY KEY,
      direction                TEXT NOT NULL,
      lifecycle_state          TEXT NOT NULL DEFAULT 'pending',
      counterparty_contact_id  TEXT,
      state_changed_at         INTEGER NOT NULL,
      sync_state               TEXT NOT NULL DEFAULT 'live',
      deleted_at               INTEGER
    );
    CREATE TABLE ${TASK_TABLE} (
      id                   TEXT PRIMARY KEY,
      done                 INTEGER NOT NULL DEFAULT 0,
      completed_at         INTEGER,
      assigned_contact_id  TEXT,
      sync_state           TEXT NOT NULL DEFAULT 'live',
      deleted_at           INTEGER
    );
  `);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────
// The address set
// ────────────────────────────────────────────────────────────────

describe('contactAddressSet — the merge graph', () => {
  it('an UNMERGED contact is its own whole set (every caller is behavior-identical at zero merges)', () => {
    addContact(SURVIVOR);
    expect(contactAddressSet(db, SURVIVOR)).toEqual([SURVIVOR]);
  });

  it('includes the SURVIVOR itself — the CTE seeds on `merged_into = ?` and can never return it', () => {
    addContact(SURVIVOR);
    addContact(LOSER);
    mergeInto(LOSER, SURVIVOR);
    // The bug this pins: `listMergedSourceEmails` alone returns ONLY [LOSER].
    // A caller that trusted engagement-store's old doc-comment ("survivor itself
    // is always included") would read the contact's whole history while omitting
    // the contact.
    expect(contactAddressSet(db, SURVIVOR)).toEqual([LOSER, SURVIVOR].sort());
  });

  it('is TRANSITIVE — with A→B→C, asking for C surfaces both A and B', () => {
    addContact(SURVIVOR);
    addContact(LOSER);
    addContact(ELDEST);
    mergeInto(ELDEST, LOSER);
    mergeInto(LOSER, SURVIVOR);
    expect(contactAddressSet(db, SURVIVOR)).toEqual([ELDEST, LOSER, SURVIVOR].sort());
  });

  it('FORWARD-RESOLVES a tombstone to the terminal survivor — never trust the id you were handed', () => {
    addContact(SURVIVOR);
    addContact(LOSER);
    addContact(ELDEST);
    mergeInto(ELDEST, LOSER);
    mergeInto(LOSER, SURVIVOR);
    // Handed a mid-chain tombstone, we must land on the TERMINAL survivor and
    // return the whole group — not stop at the first hop.
    expect(contactAddressSet(db, ELDEST)).toEqual([ELDEST, LOSER, SURVIVOR].sort());
  });

  it('never bleeds one contact into another', () => {
    addContact(SURVIVOR);
    addContact(LOSER);
    addContact(STRANGER);
    mergeInto(LOSER, SURVIVOR);
    expect(contactAddressSet(db, STRANGER)).toEqual([STRANGER]);
    expect(contactAddressSet(db, SURVIVOR)).not.toContain(STRANGER);
  });

  it('is DETERMINISTIC — an aggregate whose input set reorders flickers from identical data', () => {
    addContact(SURVIVOR);
    addContact(LOSER);
    addContact(ELDEST);
    mergeInto(ELDEST, SURVIVOR);
    mergeInto(LOSER, SURVIVOR);
    const first = contactAddressSet(db, SURVIVOR);
    for (let i = 0; i < 5; i += 1) {
      expect(contactAddressSet(db, SURVIVOR)).toEqual(first);
    }
    expect(first).toEqual([...first].sort());
  });

  it('TERMINATES on a corrupt redirect cycle instead of spinning', () => {
    addContact(SURVIVOR);
    addContact(LOSER);
    // Force a cycle the store's own guards would refuse — this is corruption,
    // and the walk must survive it rather than hang.
    db.prepare(`UPDATE contacts SET merged_into = ? WHERE email = ?`).run(LOSER, SURVIVOR);
    db.prepare(`UPDATE contacts SET merged_into = ? WHERE email = ?`).run(SURVIVOR, LOSER);
    const set = contactAddressSet(db, SURVIVOR);
    expect(set.length).toBeGreaterThan(0);
    expect(new Set(set).size).toBe(set.length); // no duplicates
  });

  it('an unknown address round-trips (callers canonicalize BEFORE creating a contact)', () => {
    expect(contactAddressSet(db, 'nobody@nowhere.com')).toEqual(['nobody@nowhere.com']);
  });

  describe('contactDisplayName — the resolved-name door (bench harvest)', () => {
    it('returns the contact row name', () => {
      addContact(SURVIVOR); // fixture names it after the local-part
      expect(contactDisplayName(db, SURVIVOR)).toBe('bob.new');
    });

    it('a TOMBSTONE address resolves to the SURVIVOR name — same walk as the address set', () => {
      addContact(SURVIVOR);
      addContact(LOSER);
      mergeInto(LOSER, SURVIVOR);
      expect(contactDisplayName(db, LOSER)).toBe('bob.new');
    });

    it('chains transitively (ELDEST → LOSER → SURVIVOR)', () => {
      addContact(SURVIVOR);
      addContact(LOSER);
      addContact(ELDEST);
      mergeInto(ELDEST, LOSER);
      mergeInto(LOSER, SURVIVOR);
      expect(contactDisplayName(db, ELDEST)).toBe('bob.new');
    });

    it('unknown address / unusable input → undefined, never fabricated', () => {
      expect(contactDisplayName(db, 'nobody@nowhere.com')).toBeUndefined();
      expect(contactDisplayName(db, 'not-an-email')).toBeUndefined();
    });

    it('a database with NO contacts table degrades to undefined', () => {
      const bare = new Database(join(dir, 'bare-name.db'));
      expect(contactDisplayName(bare, SURVIVOR)).toBeUndefined();
      bare.close();
    });
  });

  it('a database with NO contacts table degrades to the address itself', () => {
    const bare = new Database(join(dir, 'bare.db'));
    expect(contactAddressSet(bare, SURVIVOR)).toEqual([SURVIVOR]);
    bare.close();
  });
});

// ────────────────────────────────────────────────────────────────
// The reverse reads. These are the ones that were WRONG.
// ────────────────────────────────────────────────────────────────

describe('the reverse reads read across the merge group', () => {
  it('🔑 commitment_followthrough_score counts commitments on the ABSORBED address', () => {
    addContact(SURVIVOR);
    addContact(LOSER);

    // The person kept 3 promises under their old address and broke 1 under the
    // new one. Their true follow-through is 3/4.
    addCommitment('c1', LOSER, 'fulfilled', NOW - DAY);
    addCommitment('c2', LOSER, 'fulfilled', NOW - 2 * DAY);
    addCommitment('c3', LOSER, 'fulfilled', NOW - 3 * DAY);
    addCommitment('c4', SURVIVOR, 'cancelled', NOW - 4 * DAY);

    mergeInto(LOSER, SURVIVOR);

    const counts = countTerminalCommitmentsForContact(ctx(), SURVIVOR, NOW - 90 * DAY);

    // BEFORE the fix this returned { fulfilled: 0, terminal: 1 } — a 0% score,
    // stated as fact, for someone who keeps three promises out of four.
    expect(counts.terminal_count).toBe(4);
    expect(counts.fulfilled_count).toBe(3);
    expect(counts.latest_terminal_at).toBe(NOW - DAY);
  });

  it('🔑 task_completion_velocity counts tasks completed under the ABSORBED address', () => {
    addContact(SURVIVOR);
    addContact(LOSER);
    addCompletedTask('t1', LOSER, NOW - DAY);
    addCompletedTask('t2', LOSER, NOW - 2 * DAY);
    addCompletedTask('t3', SURVIVOR, NOW - 3 * DAY);
    mergeInto(LOSER, SURVIVOR);

    const counts = countCompletedTasksForContact(ctx(), SURVIVOR, NOW - 90 * DAY);

    // BEFORE: 1. A busy person read as idle.
    expect(counts.completed_count).toBe(3);
    expect(counts.latest_completed_at).toBe(NOW - DAY);
  });

  it('reads TRANSITIVELY — a three-way merge sees all three addresses', () => {
    addContact(SURVIVOR);
    addContact(LOSER);
    addContact(ELDEST);
    addCommitment('c1', ELDEST, 'fulfilled', NOW - DAY);
    addCommitment('c2', LOSER, 'fulfilled', NOW - 2 * DAY);
    addCommitment('c3', SURVIVOR, 'fulfilled', NOW - 3 * DAY);
    mergeInto(ELDEST, LOSER);
    mergeInto(LOSER, SURVIVOR);

    expect(
      countTerminalCommitmentsForContact(ctx(), SURVIVOR, NOW - 90 * DAY).terminal_count,
    ).toBe(3);
  });

  it('does NOT absorb a stranger — widening the read must not widen the identity', () => {
    addContact(SURVIVOR);
    addContact(LOSER);
    addContact(STRANGER);
    addCommitment('c1', LOSER, 'fulfilled', NOW - DAY);
    addCommitment('c2', STRANGER, 'fulfilled', NOW - DAY);
    mergeInto(LOSER, SURVIVOR);

    // 2 would mean the expansion leaked across contacts.
    expect(
      countTerminalCommitmentsForContact(ctx(), SURVIVOR, NOW - 90 * DAY).terminal_count,
    ).toBe(1);
    expect(
      countTerminalCommitmentsForContact(ctx(), STRANGER, NOW - 90 * DAY).terminal_count,
    ).toBe(1);
  });

  it('is unchanged at ZERO merges — this widens reads, it does not change them', () => {
    addContact(SURVIVOR);
    addCommitment('c1', SURVIVOR, 'fulfilled', NOW - DAY);
    addCommitment('c2', STRANGER, 'fulfilled', NOW - DAY);
    expect(
      countTerminalCommitmentsForContact(ctx(), SURVIVOR, NOW - 90 * DAY).terminal_count,
    ).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// Dedup banding — two ADDRESSES can be the same PERSON
// ────────────────────────────────────────────────────────────────

describe('task_duplicate_candidate bands across the merge group', () => {
  const focal = {
    title: 'Send the Q3 report',
    due_at: NOW,
    assigned_contact_id: SURVIVOR,
    parent_project_id: null,
  };
  const twin = {
    title: 'Send the Q3 report',
    due_at: NOW,
    assigned_contact_id: LOSER,
    parent_project_id: null,
  };

  it('🔑 the same task assigned under two addresses of ONE person bands as `exact`', () => {
    // Without the address set the pair is demoted out of `exact` on a raw string
    // compare — surfaced with the wrong confidence, for the very reason the two
    // records ARE the same person.
    expect(computeDedupConfidence(focal, twin, [LOSER, SURVIVOR])).toBe('exact');
  });

  it('without an address set, strict equality still governs (the pure function stays pure)', () => {
    expect(computeDedupConfidence(focal, twin)).not.toBe('exact');
  });

  it('two genuinely different assignees never band as `exact`', () => {
    const stranger = { ...twin, assigned_contact_id: STRANGER };
    expect(computeDedupConfidence(focal, stranger, [LOSER, SURVIVOR])).not.toBe('exact');
  });
});

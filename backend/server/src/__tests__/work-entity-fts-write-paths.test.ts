/** The `work.search` index — write-path completeness and match behaviour.
 *
 *  ⛔ THE WRITE-PATH SWEEP IS THE POINT OF THIS FILE. An unindexed record is
 *  invisible ONLY to `query`: the row exists, `work.read` serves it, lists show
 *  it, and nothing goes red. So the sweep drives all five writers through the
 *  real store and asserts each record is reachable by search — a sixth kind, or
 *  a new write path that skips `indexWorkEntity`, fails HERE rather than in the
 *  field. */

import { RECUED_BUILTIN_SOURCE_ID, WORK_ENTITY_KINDS } from '@recued/contracts';
import type { WorkEntityKind } from '@recued/contracts';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';

const NOW = 1_700_000_000_000;
let db: Database.Database;
let store: WorkEntityStore;

const src = (kind: WorkEntityKind): string => RECUED_BUILTIN_SOURCE_ID(kind);

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  ensureWorkEntitySchema(db);
  store = createWorkEntityStore(db);
  for (const kind of WORK_ENTITY_KINDS) {
    store.registerSource({
      id: src(kind),
      top_tier_kind: kind,
      source_kind: 'builtin',
      source_label: kind,
      write_capable: true,
      registered_at: NOW,
    });
  }
});

afterEach(() => { db.close(); });

/** Write one record of every kind, each carrying the same needle in its TITLE
 *  and a second needle in its long text (where the kind has one). */
const writeOnePerKind = (): void => {
  store.writeTask({
    id: 'k-task', source_id: src('task'), title: 'Peregrine ring 04',
    done: false, state: 'LOCAL_OPEN', body: 'Longform tessellation for the task.',
    created_at: NOW, updated_at: NOW,
  }, NOW);
  store.writeNote({
    id: 'k-note', source_id: src('note'), title: 'Peregrine ring 04',
    body: 'Longform tessellation for the note.',
    created_at: NOW, updated_at: NOW, last_user_action_at: NOW,
  }, NOW);
  store.writeProject({
    id: 'k-project', source_id: src('project'), title: 'Peregrine ring 04',
    description: 'Longform tessellation for the project.',
    created_at: NOW, updated_at: NOW,
  }, NOW);
  store.writeCommitment({
    id: 'k-commitment', source_id: src('commitment'), direction: 'outbound',
    statement: 'Peregrine ring 04 — longform tessellation for the commitment.',
    derivation: 'user_declared', created_at: NOW, updated_at: NOW,
  }, NOW);
  store.writeBooking({
    id: 'k-booking', source_id: src('booking'), title: 'Peregrine ring 04',
    slot_start_at: NOW, slot_end_at: NOW + 1, created_at: NOW, updated_at: NOW,
  }, NOW);
};

describe('work-entity FTS — write-path completeness', () => {
  it('⛔ EVERY kind is reachable by query after its own writer ran', () => {
    writeOnePerKind();
    for (const kind of WORK_ENTITY_KINDS) {
      expect(
        store.searchIdsByText(kind, 'Peregrine', 20),
        `kind '${kind}' wrote a record that search cannot reach — its write path is missing indexWorkEntity`,
      ).toEqual([`k-${kind}`]);
    }
  });

  it('the long-text column is indexed too, for every kind that has one', () => {
    writeOnePerKind();
    for (const kind of WORK_ENTITY_KINDS) {
      const hit = store.searchIdsByText(kind, 'tessellation', 20);
      // `booking` carries no long-text column at all — deliberate, per
      // WORK_ENTITY_LONG_TEXT_FIELD. Every other kind must match on it.
      if (kind === 'booking') expect(hit).toEqual([]);
      else expect(hit, `kind '${kind}' does not index its long text`).toEqual([`k-${kind}`]);
    }
  });

  it('an update REPLACES the indexed text rather than accumulating it', () => {
    store.writeNote({
      id: 'n1', source_id: src('note'), title: 'Kestrel ring 04',
      body: 'original body', created_at: NOW, updated_at: NOW, last_user_action_at: NOW,
    }, NOW);
    expect(store.searchIdsByText('note', 'original', 20)).toEqual(['n1']);
    store.writeNote({
      id: 'n1', source_id: src('note'), title: 'Kestrel ring 04',
      body: 'replacement body', created_at: NOW, updated_at: NOW + 1, last_user_action_at: NOW,
    }, NOW + 1);
    expect(store.searchIdsByText('note', 'replacement', 20)).toEqual(['n1']);
    // The old text must be GONE. `indexRecord` deletes-then-inserts; without the
    // delete the stale term keeps matching and edits never take effect in search.
    expect(store.searchIdsByText('note', 'original', 20)).toEqual([]);
  });

  it('a hard delete removes the index entry', () => {
    store.writeNote({
      id: 'n1', source_id: src('note'), title: 'Kestrel ring 04', body: 'x',
      created_at: NOW, updated_at: NOW, last_user_action_at: NOW,
    }, NOW);
    expect(store.searchIdsByText('note', 'Kestrel', 20)).toEqual(['n1']);
    store.deleteNote('n1');
    expect(store.searchIdsByText('note', 'Kestrel', 20)).toEqual([]);
  });

  it('the kind scope does not leak across kinds', () => {
    writeOnePerKind();
    // Every kind holds a record with the same needle; each scope must return
    // only its own. A key joined with anything but a dot would make the
    // `<kind>.` prefix match nothing and every search return empty.
    expect(store.searchIdsByText('note', 'Peregrine', 20)).toEqual(['k-note']);
    expect(store.searchIdsByText('task', 'Peregrine', 20)).toEqual(['k-task']);
  });
});

describe('work-entity FTS — match behaviour', () => {
  const seedRings = (): void => {
    for (let n = 1; n <= 12; n += 1) {
      const nn = String(n).padStart(2, '0');
      store.writeNote({
        id: `r${nn}`, source_id: src('note'), title: `Kestrel ring ${nn}`,
        body: `Ring ${nn}. Checkpoint cost: ${100 + n} units.`,
        created_at: NOW, updated_at: NOW, last_user_action_at: NOW,
      }, NOW);
    }
  };

  it('🔑 the live failure: the PLURAL now matches, which is what porter buys', () => {
    seedRings();
    // Measured 2026-09-05 against the shipped substring matcher: this returned 0
    // and a live model concluded the data lived outside its toolset.
    expect(store.searchIdsByText('note', 'Kestrel rings', 20)).toHaveLength(12);
  });

  it('word ORDER no longer matters', () => {
    seedRings();
    expect(store.searchIdsByText('note', 'ring 04 Kestrel', 20)).toEqual(['r04']);
  });

  it('AND semantics: every token must be present', () => {
    seedRings();
    // `Kestrel` is in all 12; `104` is only ring 04's cost. The conjunction
    // must narrow to one, not widen to twelve — the `loose` OR rung is
    // deliberately not used, and this is the assertion that pins that.
    expect(store.searchIdsByText('note', 'Kestrel 104', 20)).toEqual(['r04']);
    expect(store.searchIdsByText('note', 'Kestrel nonexistentterm', 20)).toEqual([]);
  });

  it('punctuation in a query cannot raise an FTS5 syntax error', () => {
    seedRings();
    // `toFtsMatch` quotes tokens and drops bare operators; without it these
    // throw `fts5: syntax error` out of the tool.
    for (const q of ['cost: 104', 'ring-04', 'AND OR NOT', 'a@b.c', '(((']) {
      expect(() => store.searchIdsByText('note', q, 20)).not.toThrow();
    }
  });

  it('⛔ a mid-word fragment NO LONGER matches — the one thing substring did that this does not', () => {
    seedRings();
    // Substring matched `estrel` inside `Kestrel`; a token index cannot. This
    // is a REAL narrowing and is asserted so it is a decision on record rather
    // than a surprise. The tool description states the token rule so a model
    // does not reach for fragments.
    expect(store.searchIdsByText('note', 'estrel', 20)).toEqual([]);
    // A leading fragment still works via the prefix operator.
    expect(store.searchIdsByText('note', 'Kestr*', 20)).toHaveLength(12);
  });

  it('🔑 reaches PAST the old 1000-row recency window', () => {
    // The previous implementation scanned `ORDER BY updated_at DESC LIMIT 1000`
    // and filtered in JS, so record 1001 was unfindable however exact the query.
    const OLD = NOW - 10_000_000;
    store.writeNote({
      id: 'ancient', source_id: src('note'), title: 'Ancient ledger',
      body: 'A note written long ago.',
      created_at: OLD, updated_at: OLD, last_user_action_at: OLD,
    }, OLD);
    for (let n = 0; n < 1200; n += 1) {
      store.writeNote({
        id: `bulk${n}`, source_id: src('note'), title: `Bulk ${n}`,
        body: 'filler', created_at: NOW + n, updated_at: NOW + n, last_user_action_at: NOW + n,
      }, NOW + n);
    }
    expect(store.searchIdsByText('note', 'Ancient ledger', 20)).toEqual(['ancient']);
  });
});

describe('work-entity FTS — the durable index and the scratch matcher are ONE rule', () => {
  /** The read-through half cannot use the durable index (live vendor records
   *  are never materialized), so it runs the same texts through a temp table.
   *  Two code paths, one rule — which is only true while this passes. */
  it('⛔ agree query-for-query, including the cases that motivated the change', () => {
    const rows = [
      { id: 'a', title: 'Kestrel ring 04', body: 'Ring 04. Checkpoint cost: 193 units.' },
      { id: 'b', title: 'Weekly report', body: 'Cancellation notes for the week.' },
      { id: 'c', title: 'Peregrine ledger', body: 'Unrelated prose about falcons.' },
    ];
    for (const r of rows) {
      store.writeNote({
        id: r.id, source_id: src('note'), title: r.title, body: r.body,
        created_at: NOW, updated_at: NOW, last_user_action_at: NOW,
      }, NOW);
    }
    const texts = rows.map((r) => `${r.title}\n${r.body}`);

    for (const q of [
      'Kestrel rings',        // the live failure — plural
      'rings',                // stem alone
      'ring 04 Kestrel',      // word order
      'weekly reports',       // plural on a second record
      'cancelling',           // a different inflection of a body word
      'Kestrel 193',          // AND across title and body
      'Kestrel Peregrine',    // AND that must match nothing
      'estrel',               // mid-word fragment — neither may match
      'Kestr*',               // prefix operator
      'cost: 193',            // punctuation
      '(((',                  // pure punctuation
      'falcons',              // body-only hit
    ]) {
      const durable = store.searchIdsByText('note', q, 20).sort();
      const scratch = store.matchTextsByQuery(texts, q)
        .map((i) => rows[i]!.id)
        .sort();
      expect(scratch, `paths disagree on ${JSON.stringify(q)}`).toEqual(durable);
    }
  });

  it('the scratch table leaves nothing in the database', () => {
    store.writeNote({
      id: 'n1', source_id: src('note'), title: 'Kestrel ring 04', body: 'x',
      created_at: NOW, updated_at: NOW, last_user_action_at: NOW,
    }, NOW);
    store.matchTextsByQuery(['Kestrel ring 04'], 'Kestrel');
    // `temp.` tables live in the temp schema, never the user's file.
    const inMain = db
      .prepare("SELECT name FROM main.sqlite_master WHERE name LIKE '%scratch%'")
      .all();
    expect(inMain).toEqual([]);
  });

  it('repeated calls do not accumulate rows from earlier ones', () => {
    const first = store.matchTextsByQuery(['Kestrel ring 04'], 'Kestrel');
    expect(first).toEqual([0]);
    // A stale row from the previous call would still match and shift indices.
    const second = store.matchTextsByQuery(['Peregrine ledger'], 'Kestrel');
    expect(second).toEqual([]);
    const third = store.matchTextsByQuery(['Peregrine ledger'], 'Peregrine');
    expect(third).toEqual([0]);
  });
});

describe('work-entity FTS — the MIGRATION path, which no write-path test reaches', () => {
  /** ⛔⛔ THIS SUITE EXISTS BECAUSE THE WRITE-PATH TESTS ABOVE PASSED 14/14 AND
   *  10/10 MUTATIONS WHILE THE REINDEX WALKER WAS BOTH DEAD AND BROKEN.
   *
   *  `reindexWorkEntityFts` runs ONLY on a migration — a changed tokenizer, a
   *  stale content format, or (now) a fresh index over a populated store. No
   *  test took any of those branches, so the walker was never executed once. It
   *  contained a `SELECT ... title` that is a hard `SqliteError` on
   *  `data_commitment`, which has no such column.
   *
   *  🔑 The lesson is the shape, not the typo: the write path and the migration
   *  path build the SAME index from DIFFERENT sources — a materialized entity
   *  versus raw SQL columns — so covering one proves nothing about the other. */

  const seedOnePerKind = (): void => {
    writeOnePerKind();
  };

  it('⛔ a fresh index over a POPULATED store is backfilled', () => {
    seedOnePerKind();
    // Simulate a server whose database predates the index: rows present, no
    // FTS table. This is every existing self-hosted install at upgrade.
    db.exec('DROP TABLE IF EXISTS work_entity_fts');
    ensureWorkEntitySchema(db);
    const store2 = createWorkEntityStore(db);
    for (const kind of WORK_ENTITY_KINDS) {
      expect(
        store2.searchIdsByText(kind, 'Peregrine', 20),
        `kind '${kind}' was not backfilled — every pre-existing ${kind} is unsearchable`,
      ).toEqual([`k-${kind}`]);
    }
  });

  it('⛔ COMMITMENT is the kind that breaks a naive walker — it has no title column', () => {
    // The walker reads raw columns; `data_commitment` stores its name in
    // `statement`. A `SELECT id, title, …` here is a hard SqliteError at BOOT.
    store.writeCommitment({
      id: 'c1', source_id: src('commitment'), direction: 'outbound',
      statement: 'Peregrine ring 04 — deliver the tessellation report.',
      derivation: 'user_declared', created_at: NOW, updated_at: NOW,
    }, NOW);
    db.exec('DROP TABLE IF EXISTS work_entity_fts');
    expect(() => ensureWorkEntitySchema(db)).not.toThrow();
    expect(createWorkEntityStore(db).searchIdsByText('commitment', 'tessellation', 20))
      .toEqual(['c1']);
  });

  it('an EMPTY store does not get a pointless backfill, and still works after', () => {
    // Nothing seeded. The backfill must not run (there is nothing to walk), and
    // writes after it must still index normally.
    db.exec('DROP TABLE IF EXISTS work_entity_fts');
    ensureWorkEntitySchema(db);
    const store2 = createWorkEntityStore(db);
    expect(store2.searchIdsByText('note', 'anything', 20)).toEqual([]);
    store2.writeNote({
      id: 'after', source_id: src('note'), title: 'Kestrel ring 04', body: 'x',
      created_at: NOW, updated_at: NOW, last_user_action_at: NOW,
    }, NOW);
    expect(store2.searchIdsByText('note', 'Kestrel', 20)).toEqual(['after']);
  });

  it('⛔ a POPULATED index is left alone — a re-boot does NOT re-walk the store', () => {
    seedOnePerKind();
    // ⚠ ASSERTING "SEARCH STILL WORKS" CANNOT CATCH THIS, and an earlier version
    // of this test did exactly that and passed against a mutant that re-walked
    // on every boot. A needless full walk is INVISIBLE from the outside: the
    // index ends up correct either way, only the cost differs.
    //
    // So the detector is a divergence the walk would REPAIR: delete one row from
    // the INDEX only, leaving the store row in place. A skipped backfill leaves
    // it missing; a walk brings it back. That is the one observable difference.
    db.prepare("DELETE FROM work_entity_fts WHERE key = 'note.k-note'").run();
    expect(createWorkEntityStore(db).searchIdsByText('note', 'Peregrine', 20)).toEqual([]);
    ensureWorkEntitySchema(db);
    expect(
      createWorkEntityStore(db).searchIdsByText('note', 'Peregrine', 20),
      'the backfill re-walked a populated store — it must run only when the index is EMPTY',
    ).toEqual([]);
    // …and the rest of the index is untouched, so the boot did nothing at all.
    expect(createWorkEntityStore(db).searchIdsByText('task', 'Peregrine', 20)).toEqual(['k-task']);
  });

  it('a TOKENIZER change rebuilds through the same walker', () => {
    seedOnePerKind();
    // Force `createFtsTable`'s tokenizerChanged branch by declaring the table
    // with a different tokenizer, then booting the real schema over it.
    db.exec('DROP TABLE IF EXISTS work_entity_fts');
    db.exec("CREATE VIRTUAL TABLE work_entity_fts USING fts5(key UNINDEXED, blob_text, tokenize='unicode61')");
    ensureWorkEntitySchema(db);
    const store2 = createWorkEntityStore(db);
    // Rebuilt AND under the porter tokenizer — the plural proves which one ran.
    expect(store2.searchIdsByText('note', 'Peregrines', 20)).toEqual(['k-note']);
  });
});

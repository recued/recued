/** D-250 § D4 — the publish grant: per-tag publication state the submit path checks.
 *
 *  🔑 THIS IS THE GRANT, AND IT IS DELIBERATELY NOT A `CONTRACT_GRANT_KIND`. That
 *  substrate authorizes an OPERATION at the gateway ("may this op run, and must it ask").
 *  § D4's grant answers a different question — **is this owner opted into publishing at
 *  all** — and § B3.4 already covers the approval half: a scheduled submission holds
 *  unless the owner mints a D-177 delegation rule, "their own automation authorising
 *  their own outbound send, which is precisely what that mechanism is for". Adding a
 *  seventh grant kind for an opt-in would also inherit the self-hosted deploy trap, where
 *  an older server ACCEPTS AND IGNORES an unknown kind rather than rejecting it — the
 *  grant would read as granted while enforcing nothing.
 *
 *  ⛔⛔ REVOKE DOES NOT DELETE, AND THAT IS THE WHOLE POINT. § C4: *"the withdrawal has to
 *  persist as STATE the submit path checks, not as an absence"*. § B3.3 rules "always
 *  send; let the board discard", so the submitting server keeps posting daily and has no
 *  idea a row was withdrawn — **a plain delete is re-created by tomorrow's batch and the
 *  participant silently reappears on a board they left.** Revoke moves the row to
 *  `withdrawing`; only the cloud's ack (§ B4.2) removes it.
 *
 *  ⚠ ONE PUBLICATION PER TAG, ERASING ACROSS ALL SEASONS (§ C4, 2026-08-25) — "a partial
 *  exit that leaves last season's rank standing is not leaving". So the key is the TAG,
 *  not the tag-and-season.
 */

import type Database from 'better-sqlite3';

export type PublicationState = 'active' | 'withdrawing';

/** ⛔⛔ EXACTLY ONE DEFINITION, MIRRORING THE CLOUD'S `boards_one_definition` AND THE WIRE.
 *  § D3.1a keys a board on `(tag, metric_id|recipe_id, season_id)`; this store only ever knew
 *  `metric_id`, which is why a recipe-defined board — an EVAL board, per § 9 answer 1 — could
 *  not be published to at all. The row could exist in the cloud and nothing local could ever
 *  name it.
 *  ⚠ A UNION, NOT TWO OPTIONAL FIELDS, so the call site cannot express both-or-neither. The
 *  wire refuses that pairing and the cloud's constraint refuses it; a type that permitted it
 *  here would move the failure to the far end of a once-daily batch. */
/** What a CALLER writes. `?: undefined` on the absent side so `grant({ tag, metric_id, season_id })`
 *  stays the obvious thing to type — nobody should have to pass an explicit null to say a
 *  recipe is not involved. */
export type PublicationDefinition =
  | { readonly metric_id: string; readonly recipe_id?: undefined }
  | { readonly recipe_id: string; readonly metric_id?: undefined };

/** ⛔⛔ WHAT THE STORE HOLDS, AND THE NULLS ARE EXPLICIT ON PURPOSE. SQLite returns null for an
 *  unset column, so a union written with `?: undefined` would type-check while the runtime
 *  value narrowed nothing — `undefined !== null` is true, and `if (p.recipe_id !== null)`
 *  would fall through for a metric publication. Spelling the absent side as `null` is what
 *  makes the discriminant REAL rather than documentary: the compiler then refuses any read of
 *  `p.metric_id` that has not first ruled the recipe case out. */
export type BoardPublication = {
  readonly tag: string;
  readonly season_id: string;
  readonly state: PublicationState;
  readonly granted_at: number;
  readonly withdrawn_at: number | null;
} & (
  | { readonly metric_id: string; readonly recipe_id: null }
  | { readonly metric_id: null; readonly recipe_id: string }
);

export interface BoardPublicationStore {
  /** The owner's explicit opt-in. Re-granting an existing tag updates what is published
   *  and CLEARS a pending withdrawal — the owner changed their mind before the ack. */
  grant(input: { tag: string; season_id: string } & PublicationDefinition, now: number): BoardPublication;
  /** ⛔ MOVES TO `withdrawing`; DOES NOT DELETE. Returns undefined if the tag was never
   *  published — revoking nothing is not an error, but it must not invent a row to
   *  withdraw, or the batch would carry a withdrawal for a board this server never
   *  joined. */
  revoke(tag: string, now: number): BoardPublication | undefined;
  /** The cloud confirmed the row is gone (§ B4.2's ack). ⛔ THE ONLY PATH THAT DELETES,
   *  and it refuses to act on an `active` row: an ack for a tag the owner has since
   *  re-published would otherwise silently un-publish it. */
  confirmWithdrawn(tag: string): boolean;
  get(tag: string): BoardPublication | undefined;
  list(): readonly BoardPublication[];
  /** What the next batch carries: every active publication, plus every withdrawal still
   *  waiting for its ack (§ C4 — it keeps riding the batch until confirmed). */
  pending(): readonly BoardPublication[];
}

/** ⛔⛔ A REBUILD, NOT AN `ALTER TABLE ADD COLUMN`, AND THE REASON IS THE PART THAT BITES.
 *  `CREATE TABLE IF NOT EXISTS` is a PERMANENT NO-OP on an install that already has the table
 *  — the exact shape that left `003_slack_links.sql` inert on production forever — so shipping
 *  a widened CREATE would change nothing for every existing server. And `ADD COLUMN`, the
 *  house pattern elsewhere, cannot relax `metric_id NOT NULL` nor add the XOR check: both are
 *  frozen at CREATE, the same freeze that made 041's kind widening inert until it dropped and
 *  re-added the constraint.
 *  ⚠ SAFE HERE IN A WAY IT WOULD NOT BE ON A SHARED DATABASE: this is one owner's local file,
 *  the copy is deterministic, and every existing row migrates unchanged with `recipe_id` null.
 *  ⚠ DETECTED BY COLUMN PRESENCE, NOT A VERSION FLAG — nothing here tracks schema versions, so
 *  the schema itself is the only honest thing to ask. */
export const ensurePublicationSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS board_publications (
      tag TEXT PRIMARY KEY,
      metric_id TEXT,
      recipe_id TEXT,
      season_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'withdrawing')),
      granted_at INTEGER NOT NULL,
      withdrawn_at INTEGER,
      CHECK ((metric_id IS NOT NULL) <> (recipe_id IS NOT NULL))
    );
  `);
  const cols = db.prepare('PRAGMA table_info(board_publications)').all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === 'recipe_id')) return;
  db.exec(`
    BEGIN;
    CREATE TABLE board_publications_new (
      tag TEXT PRIMARY KEY,
      metric_id TEXT,
      recipe_id TEXT,
      season_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'withdrawing')),
      granted_at INTEGER NOT NULL,
      withdrawn_at INTEGER,
      CHECK ((metric_id IS NOT NULL) <> (recipe_id IS NOT NULL))
    );
    INSERT INTO board_publications_new (tag, metric_id, recipe_id, season_id, state, granted_at, withdrawn_at)
      SELECT tag, metric_id, NULL, season_id, state, granted_at, withdrawn_at FROM board_publications;
    DROP TABLE board_publications;
    ALTER TABLE board_publications_new RENAME TO board_publications;
    COMMIT;
  `);
};

interface Row {
  tag: string;
  metric_id: string | null;
  recipe_id: string | null;
  season_id: string;
  state: PublicationState;
  granted_at: number;
  withdrawn_at: number | null;
}

/** ⛔ THE CHECK CONSTRAINT IS THE GUARANTEE; THIS IS WHERE IT BECOMES A TYPE. A row that
 *  satisfied neither side could only come from a database edited around the constraint, and
 *  returning it shaped as a publication would push the contradiction into every caller.
 *  ⚠ UNREACHABLE WHILE THE CHECK HOLDS, AND NO TEST COVERS THE THROW — verified by mutation:
 *  replacing it with a silent coercion stays green, because the only row that would reach it
 *  cannot be inserted. Reaching it would mean writing a fixture table without the constraint,
 *  which tests the fixture rather than this. Kept on the same terms as 045's own unreachable
 *  refusal: the constraint is the guarantee, this is what happens when the guarantee is wrong. */
const toPublication = (r: Row): BoardPublication => {
  const base = {
    tag: r.tag,
    season_id: r.season_id,
    state: r.state,
    granted_at: r.granted_at,
    withdrawn_at: r.withdrawn_at,
  };
  if (r.metric_id !== null && r.recipe_id === null) return { ...base, metric_id: r.metric_id, recipe_id: null };
  if (r.recipe_id !== null && r.metric_id === null) return { ...base, metric_id: null, recipe_id: r.recipe_id };
  throw new Error(`board_publications row "${r.tag}" names neither exactly one definition`);
};

export const createBoardPublicationStore = (db: Database.Database): BoardPublicationStore => {
  ensurePublicationSchema(db);
  const getStmt = db.prepare('SELECT * FROM board_publications WHERE tag = ?');
  const allStmt = db.prepare('SELECT * FROM board_publications ORDER BY tag');
  const put = db.prepare(
    `INSERT INTO board_publications (tag, metric_id, recipe_id, season_id, state, granted_at, withdrawn_at)
       VALUES (?, ?, ?, ?, 'active', ?, NULL)
       ON CONFLICT(tag) DO UPDATE SET
         metric_id = excluded.metric_id,
         recipe_id = excluded.recipe_id,
         season_id = excluded.season_id,
         state = 'active',
         withdrawn_at = NULL`,
  );
  const markWithdrawing = db.prepare(
    `UPDATE board_publications SET state = 'withdrawing', withdrawn_at = ? WHERE tag = ?`,
  );
  const del = db.prepare(
    `DELETE FROM board_publications WHERE tag = ? AND state = 'withdrawing'`,
  );

  const get = (tag: string): BoardPublication | undefined => {
    const row = getStmt.get(tag) as Row | undefined;
    return row === undefined ? undefined : toPublication(row);
  };

  return {
    grant(input, now) {
      // ⚠ `granted_at` keeps its ORIGINAL value on a re-grant — the ON CONFLICT clause
      // does not touch it. It answers "since when has this been published", and
      // re-stamping it on every edit would erase that.
      // ⚠ BOTH COLUMNS ARE ALWAYS BOUND, one of them to null — the union above guarantees
      // exactly one is present, and the CHECK refuses the row if that ever stops being true.
      put.run(input.tag, input.metric_id ?? null, input.recipe_id ?? null, input.season_id, now);
      return get(input.tag)!;
    },

    revoke(tag, now) {
      // ⚠ NO EXISTENCE GUARD, AND NONE IS NEEDED — proved by mutation. An UPDATE cannot
      // insert, so revoking an unjoined tag changes nothing and the read below returns
      // undefined on its own. A guard here would be an equivalent mutant: it reads as a
      // check while the SQL is what actually holds the property.
      markWithdrawing.run(now, tag);
      return get(tag);
    },

    confirmWithdrawn(tag) {
      // ⛔ THE `AND state = 'withdrawing'` IS LOAD-BEARING. An ack can arrive after the
      // owner re-published the same tag (they changed their mind inside one batch
      // interval); deleting on the ack alone would silently undo that re-publish, and
      // § B3.3's "always send" would not notice because the row is simply gone.
      return del.run(tag).changes > 0;
    },

    get,
    list: () => (allStmt.all() as Row[]).map(toPublication),
    // Both states ride the batch: active ones carry a score, withdrawing ones carry
    // § C4's `{unpublish: true}` until the ack lands.
    pending: () => (allStmt.all() as Row[]).map(toPublication),
  };
};

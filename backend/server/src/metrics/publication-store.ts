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

export interface BoardPublication {
  readonly tag: string;
  readonly metric_id: string;
  readonly season_id: string;
  readonly state: PublicationState;
  readonly granted_at: number;
  readonly withdrawn_at: number | null;
}

export interface BoardPublicationStore {
  /** The owner's explicit opt-in. Re-granting an existing tag updates what is published
   *  and CLEARS a pending withdrawal — the owner changed their mind before the ack. */
  grant(input: { tag: string; metric_id: string; season_id: string }, now: number): BoardPublication;
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

export const ensurePublicationSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS board_publications (
      tag TEXT PRIMARY KEY,
      metric_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'withdrawing')),
      granted_at INTEGER NOT NULL,
      withdrawn_at INTEGER
    );
  `);
};

interface Row {
  tag: string;
  metric_id: string;
  season_id: string;
  state: PublicationState;
  granted_at: number;
  withdrawn_at: number | null;
}

const toPublication = (r: Row): BoardPublication => ({
  tag: r.tag,
  metric_id: r.metric_id,
  season_id: r.season_id,
  state: r.state,
  granted_at: r.granted_at,
  withdrawn_at: r.withdrawn_at,
});

export const createBoardPublicationStore = (db: Database.Database): BoardPublicationStore => {
  ensurePublicationSchema(db);
  const getStmt = db.prepare('SELECT * FROM board_publications WHERE tag = ?');
  const allStmt = db.prepare('SELECT * FROM board_publications ORDER BY tag');
  const put = db.prepare(
    `INSERT INTO board_publications (tag, metric_id, season_id, state, granted_at, withdrawn_at)
       VALUES (?, ?, ?, 'active', ?, NULL)
       ON CONFLICT(tag) DO UPDATE SET
         metric_id = excluded.metric_id,
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
      put.run(input.tag, input.metric_id, input.season_id, now);
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

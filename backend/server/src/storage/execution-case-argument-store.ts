/** D-219 — CAPTURE-ONLY tool arguments for governed chat calls.
 *
 *  ⛔ **NOTHING READS THIS.** It exists so that a later decision about
 *  parameter-level lessons has raw material to decide over, and it is
 *  deliberately not wired to the compiler, the card, or any model-facing
 *  surface. Capturing and exposing are separate decisions; this is the first,
 *  and the second is not made.
 *
 *  ## Why VALUES, and not a hash (ruled 2026-07-28)
 *
 *  ⚠ **NOT for parameter preferences.** "The right contact was the second one"
 *  was the original justification and it is RETIRED: neither near-term consumer
 *  wants it. Card injection is SHAPE ONLY — the model has the prompt and derives
 *  its own arguments — and turning a case into a durable recipe wants a skeleton
 *  whose parameters the owner fills, not a recipient baked in from one past run
 *  (that is the "always CC Alice" error the contracts refuse).
 *
 *  What values are for is **reconstruction**. Real flows are
 *  `call1 → entity_shape → call2 → entity_shape → call3`: the interesting fact
 *  is not which contact was chosen but that call2's argument was FILLED FROM
 *  call1's output. Values retain the shape and the allocation — which value
 *  landed in which slot — and a hash retains neither; it answers same-or-
 *  different and nothing else. That is enough for the slice-8 retry
 *  discrimination and useless for building a re-run.
 *
 *  ⚠ Neither values nor a hash sit on the expensive lookup path: retrieval keys
 *  on request shape and case key, so this store costs nothing until something
 *  deliberately reads it.
 *
 *  ⛔ **NECESSARY BUT NOT SUFFICIENT for that reconstruction, and knowing why
 *  matters before anyone leans on it.** The binding lives between one call's
 *  RESULT and the next call's arguments, and results are deliberately not
 *  durable: `prior_tool_calls` exist only inside the live turn, and the chat
 *  store persists locators rather than content. So these rows show WHAT was
 *  passed, never WHERE IT CAME FROM. Recovering that needs the edge computed at
 *  dispatch time, while both halves are in memory — which is also the honest fix
 *  for `dependency_ordinals`, today a synthetic `ordinal - 1` chain.
 *
 *  ## What makes it safe to write
 *
 *  - **Sealed at rest** under the same chat sub-DEK as reports, observations and
 *    dissections. A locked vault means the capture is skipped, never stored raw.
 *  - **Captured at the D-214 registry wrapper**, the one seam every governed chat
 *    dispatch passes through with its arguments in hand. ⚠ That means the join
 *    to a compiled flow is BY ORDER WITHIN THE TURN — rows carry
 *    `(session_id, turn_id, tool_name, captured_at)`, and the compiler builds
 *    its steps from the same per-turn activity order. Chasing an exact
 *    `activity_id` would have meant instrumenting four separate audit sites in
 *    the orchestrator's hot path; the ordering is sufficient for the question
 *    this material exists to answer, and the imprecision is recorded rather
 *    than discovered later.
 *  - **In the privacy cascade.** `deleteRoot` / `deleteSession` remove these rows
 *    with everything else D-214 owns; a capture that outlived a forget request
 *    would be the worst possible version of this feature.
 *  - **Bounded.** Oversized payloads are truncated to a marker rather than
 *    stored, and `captured_at` backs an age pruner — this is a rolling buffer,
 *    not an archive. ⚠ That window is also the horizon a future
 *    argument-consuming slice can backfill from.
 */

import type Database from 'better-sqlite3';

import {
  openD214Json,
  sealD214Json,
  type D214KeyProvider,
} from './d214-sealed-json.js';

/** Hard ceiling for one captured argument payload. Beyond it the values are
 *  dropped and only the shape marker is kept: a single pathological call (a
 *  pasted document, an inlined attachment) must not turn a rolling buffer into
 *  the largest table in the database. */
export const EXECUTION_CASE_ARGUMENT_MAX_BYTES = 8 * 1024;

/** How long a captured payload lives. Long enough that a decision taken this
 *  quarter still has material to look at; short enough that this stays a buffer.
 *  ⚠ Shortening it shortens what any future backfill can see. */
export const EXECUTION_CASE_ARGUMENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface CapturedToolArguments {
  /** Row identity only — NOT the audit `activity_id`; see the header. */
  capture_id: string;
  session_id: string;
  turn_id: string;
  tool_name: string;
  captured_at: number;
  /** The dispatch arguments verbatim, or `{ truncated: true }` when the payload
   *  exceeded the ceiling. Never rendered anywhere today. */
  args: unknown;
}

export interface ExecutionCaseArgumentStore {
  /** Best-effort: returns false when the vault is locked or the row already
   *  exists, or when its turn/session has already entered the privacy cascade.
   *  A missed capture costs a future lesson, never a turn. */
  capture(input: CapturedToolArguments): Promise<boolean>;
  /** The only reader, and it exists for tests + a future consumer. */
  listForTurn(
    session_id: string,
    turn_id: string,
  ): Promise<CapturedToolArguments[]>;
  /** Privacy cascade — called with every (session, turn) of a deleted root. */
  deleteForTurns(
    turns: ReadonlyArray<{ session_id: string; turn_id: string }>,
  ): number;
  deleteForSession(session_id: string): number;
  /** Retention sweep. Returns how many rows went. */
  pruneOlderThan(before: number): number;
  count(): number;
}

export const ensureExecutionCaseArgumentSchema = (
  db: Database.Database,
): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_case_arguments (
      capture_id     TEXT PRIMARY KEY,
      session_id     TEXT NOT NULL,
      turn_id        TEXT NOT NULL,
      tool_name      TEXT NOT NULL,
      captured_at    INTEGER NOT NULL,
      args_encrypted TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_execution_case_arguments_turn
      ON execution_case_arguments (session_id, turn_id, captured_at);
    CREATE INDEX IF NOT EXISTS idx_execution_case_arguments_age
      ON execution_case_arguments (captured_at);
  `);
};

interface ArgumentRow {
  capture_id: string;
  session_id: string;
  turn_id: string;
  tool_name: string;
  captured_at: number;
  args_encrypted: string;
}

export const createExecutionCaseArgumentStore = (
  db: Database.Database,
  keyProvider?: D214KeyProvider,
): ExecutionCaseArgumentStore => {
  ensureExecutionCaseArgumentSchema(db);
  const insert = db.prepare(`
    INSERT INTO execution_case_arguments (
      capture_id, session_id, turn_id, tool_name, captured_at, args_encrypted
    ) VALUES (
      @capture_id, @session_id, @turn_id, @tool_name, @captured_at,
      @args_encrypted
    )
    ON CONFLICT (capture_id) DO NOTHING
  `);
  const selectForTurn = db.prepare(`
    SELECT capture_id, session_id, turn_id, tool_name, captured_at,
           args_encrypted
      FROM execution_case_arguments
     WHERE session_id = ? AND turn_id = ?
     ORDER BY captured_at ASC, capture_id ASC
  `);
  const removeForTurn = db.prepare(`
    DELETE FROM execution_case_arguments
     WHERE session_id = ? AND turn_id = ?
  `);
  const removeForSession = db.prepare(`
    DELETE FROM execution_case_arguments WHERE session_id = ?
  `);
  const removeOlderThan = db.prepare(`
    DELETE FROM execution_case_arguments WHERE captured_at < ?
  `);
  const countAll = db.prepare(
    'SELECT COUNT(*) AS count FROM execution_case_arguments',
  );
  // Runtime privacy tombstones close the async seal -> sync insert race. They
  // need not survive restart: an in-flight capture cannot survive the process
  // that owned its Promise. Keeping them in memory also avoids retaining a new
  // durable identifier set solely to remember already-forgotten identifiers.
  const forgottenSessions = new Set<string>();
  const forgottenTurns = new Map<string, Set<string>>();
  const isForgotten = (session_id: string, turn_id: string): boolean =>
    forgottenSessions.has(session_id)
    || forgottenTurns.get(session_id)?.has(turn_id) === true;
  const forgetTurn = (session_id: string, turn_id: string): void => {
    let turns = forgottenTurns.get(session_id);
    if (!turns) {
      turns = new Set<string>();
      forgottenTurns.set(session_id, turns);
    }
    turns.add(turn_id);
  };

  return {
    async capture(input) {
      if (isForgotten(input.session_id, input.turn_id)) return false;
      // ⚠ The ceiling is applied to the PLAINTEXT before sealing: the point is
      // to bound what is retained, and a ciphertext measurement would let an
      // arbitrarily large payload through whenever it compressed well.
      const serialized = JSON.stringify(input.args ?? null);
      const oversized =
        Buffer.byteLength(serialized ?? 'null', 'utf8')
        > EXECUTION_CASE_ARGUMENT_MAX_BYTES;
      let args_encrypted: string;
      try {
        args_encrypted = await sealD214Json(
          oversized ? { truncated: true } : (input.args ?? null),
          'case-arguments',
          input.capture_id,
          keyProvider,
        );
      } catch {
        // ⛔ A LOCKED VAULT SKIPS THE CAPTURE. `sealD214Json` throws
        // `D214VaultLockedError` rather than returning empty, and the only
        // alternative to skipping would be storing the arguments in the clear —
        // which is the one thing this store must never do. Losing the capture
        // costs a future lesson; the same trade the span anchor already makes.
        return false;
      }
      // `sealD214Json` yields. Forget can therefore commit while this capture
      // is encrypting; re-check immediately before the synchronous insert so a
      // pre-Forget dispatch cannot resurrect arguments afterward.
      if (isForgotten(input.session_id, input.turn_id)) return false;
      return insert.run({
        capture_id: input.capture_id,
        session_id: input.session_id,
        turn_id: input.turn_id,
        tool_name: input.tool_name,
        captured_at: input.captured_at,
        args_encrypted,
      }).changes === 1;
    },

    async listForTurn(session_id, turn_id) {
      const rows = selectForTurn.all(session_id, turn_id) as ArgumentRow[];
      return Promise.all(rows.map(async (row) => ({
        capture_id: row.capture_id,
        session_id: row.session_id,
        turn_id: row.turn_id,
        tool_name: row.tool_name,
        captured_at: row.captured_at,
        args: await openD214Json<unknown>(
          row.args_encrypted,
          'case-arguments',
          row.capture_id,
          keyProvider,
        ),
      })));
    },

    deleteForTurns(turns) {
      let removed = 0;
      const run = db.transaction(() => {
        for (const turn of turns) {
          removed += removeForTurn.run(turn.session_id, turn.turn_id).changes;
        }
      });
      run();
      // Mark only after the SQL transaction commits. JavaScript cannot
      // interleave an async capture between this synchronous commit and the
      // marks, while a failed delete must remain retryable rather than creating
      // an in-memory-only false success.
      for (const turn of turns) forgetTurn(turn.session_id, turn.turn_id);
      return removed;
    },

    deleteForSession(session_id) {
      const removed = removeForSession.run(session_id).changes;
      forgottenSessions.add(session_id);
      forgottenTurns.delete(session_id);
      return removed;
    },

    pruneOlderThan(before) {
      return removeOlderThan.run(before).changes;
    },

    count() {
      return (countAll.get() as { count: number }).count;
    },
  };
};

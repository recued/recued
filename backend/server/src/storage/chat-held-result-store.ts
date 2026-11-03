/** D-337 — the durable halves of a continuation, beside the chat's tables.
 *
 *  - **A held run's watch.** The owner's app chat keeps a row for every tool call, and a held
 *    run's settlement finds its conversation through it (`chat-run-settled-sink.ts`). A
 *    messenger or email chat keeps none, so a run held there is watched instead: its run, its
 *    conversation, the turn that made the call and the name the model called it by.
 *  - **A continuation's turn.** Each continuation queued, with the run it carries on from and
 *    the turn that made the call. The email door owes a continuation's answer through it, as a
 *    reply to that turn's request, and writes no fixed follow-up for a run that continued.
 *
 *  A leaf module: the chat's continuations and the email door both read it, and neither
 *  imports the other. */
import type Database from 'better-sqlite3';

/** A watch is kept this long: a run can wait for the owner's approval up to
 *  `preflight.stale_after_days` (30 by default), and the email door keeps its own as long. */
export const HELD_RUN_WATCH_KEEP_MS = 90 * 86_400_000;
/** A continuation's turn is kept as long: the email door's follow-ups are told by it. */
export const HELD_RESULT_TURN_KEEP_MS = HELD_RUN_WATCH_KEEP_MS;

export const ensureHeldResultSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_held_run_watches (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      called_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_held_result_turns (
      turn_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      origin_turn_id TEXT,
      created_at INTEGER NOT NULL,
      into_turn_id TEXT,
      answered_at INTEGER,
      acted_at INTEGER,
      retry_of TEXT,
      retry_due_at INTEGER,
      retry_attempt INTEGER
    );
    CREATE INDEX IF NOT EXISTS chat_held_result_turns_run ON chat_held_result_turns (run_id);
    -- Read by every turn of a conversation: what it was told, and what it still has to be.
    CREATE INDEX IF NOT EXISTS chat_held_result_turns_session ON chat_held_result_turns (session_id, created_at);
  `);
  // A table made before continuations were folded together and their answers kept.
  const columns = new Set((db.prepare('PRAGMA table_info(chat_held_result_turns)').all() as Array<{ name: string }>)
    .map((column) => column.name));
  if (!columns.has('into_turn_id')) db.exec('ALTER TABLE chat_held_result_turns ADD COLUMN into_turn_id TEXT');
  if (!columns.has('answered_at')) db.exec('ALTER TABLE chat_held_result_turns ADD COLUMN answered_at INTEGER');
  if (!columns.has('acted_at')) db.exec('ALTER TABLE chat_held_result_turns ADD COLUMN acted_at INTEGER');
  if (!columns.has('retry_of')) db.exec('ALTER TABLE chat_held_result_turns ADD COLUMN retry_of TEXT');
  if (!columns.has('retry_due_at')) db.exec('ALTER TABLE chat_held_result_turns ADD COLUMN retry_due_at INTEGER');
  if (!columns.has('retry_attempt')) db.exec('ALTER TABLE chat_held_result_turns ADD COLUMN retry_attempt INTEGER');
};

export interface HeldRunWatch {
  readonly run_id: string;
  readonly session_id: string;
  /** The turn that made the call. */
  readonly turn_id: string;
  /** The name the model called it by. */
  readonly tool_name: string;
  readonly called_at: number;
}

export interface HeldRunWatchStore {
  /** The first hold is kept: a run held again is the same call, still waiting. */
  watch(watch: HeldRunWatch): void;
  get(run_id: string): HeldRunWatch | undefined;
  /** Settled: the watch is done. */
  done(run_id: string): void;
}

export const createHeldRunWatchStore = (
  db: Database.Database,
  now: () => number = Date.now,
): HeldRunWatchStore => {
  ensureHeldResultSchema(db);
  const insert = db.prepare(`INSERT OR IGNORE INTO chat_held_run_watches
    (run_id, session_id, turn_id, tool_name, called_at) VALUES (?, ?, ?, ?, ?)`);
  const select = db.prepare(`SELECT run_id, session_id, turn_id, tool_name, called_at
    FROM chat_held_run_watches WHERE run_id = ?`);
  const remove = db.prepare('DELETE FROM chat_held_run_watches WHERE run_id = ?');
  const prune = db.prepare('DELETE FROM chat_held_run_watches WHERE called_at < ?');
  return {
    watch(watch) {
      prune.run(now() - HELD_RUN_WATCH_KEEP_MS);
      insert.run(watch.run_id, watch.session_id, watch.turn_id, watch.tool_name, watch.called_at);
    },
    get: (run_id) => select.get(run_id) as HeldRunWatch | undefined,
    done(run_id) { remove.run(run_id); },
  };
};

export interface HeldResultTurnStore {
  /** Record a continuation's turn. Called inside the queue's admission transaction
   *  (`ChatTurnQueue.submit`'s `beforeInsert`), so a turn admitted is a turn recorded.
   *  `origin_turn_id` is the turn that made the call; when that turn was itself a continuation,
   *  the turn of the request it answered is kept instead. */
  record(turn: {
    turn_id: string; session_id: string; run_id: string; origin_turn_id?: string;
    /** The interrupted continuation this turn runs again (`refold`). */
    retry_of?: string;
  }): void;
  /** Did this run's conversation continue? */
  continued(run_id: string): boolean;
  /** D-336 slice Q — the turn whose request a continuation's turn carries on, the first of its
   *  chain (`record` keeps it so); `undefined` for a turn that is no continuation. The claim
   *  linker counts such a turn as that one. */
  rootTurnOf?(turn_id: string): string | undefined;
  /** These continuations' turns were folded into another's (`ChatTurnQueue.fold`), which carries
   *  their runs on, and the calls one of them held as a run again (`refold`). Called inside the
   *  fold's transaction. */
  fold(turn_ids: readonly string[], into_turn_id: string): void;
  /** The model answered this continuation's turn (`ChatTurnAck.answered`): the runs it carried on,
   *  its own and those folded into it, have been told. */
  answered(turn_id: string): void;
  /** The runs the model has been told of in this conversation: a continuation it answered carried
   *  them, or the one running now does. A turn that failed (the queue still calls it completed)
   *  told it nothing. */
  delivered(session_id: string): ReadonlySet<string>;
  /** The continuation's turn began acting: it made a tool call. Run again after an interruption, it
   *  might repeat a step that ran, so it is not (`interrupted`). */
  acted(turn_id: string): void;
  /** The calls of this conversation whose continuation ended with no answer from the model (its
   *  model failed, or it was interrupted), recorded since `since`, newest first, at most `limit`.
   *  The conversation's next turn carries them (`told`). A turn that ran an interrupted one again
   *  is not one of them: the calls it carried are, by their own records. */
  untold(session_id: string, since: number, limit: number): ReadonlyArray<{ turn_id: string; run_id: string }>;
  /** These calls were told in another turn of their conversation. */
  told(turn_ids: readonly string[]): void;
  /** The continuations interrupted before their model answered (the server stopped in them),
   *  recorded since `since`, with whether they had begun acting and whether they were themselves
   *  a run again. */
  interrupted(since: number): ReadonlyArray<{
    turn_id: string; session_id: string; acted: boolean; retried: boolean;
    /** Every record it carries: its own, and any folded into it. */
    turns: readonly string[]; run_id: string; origin_turn_id?: string;
  }>;
  /** An interrupted continuation's calls are carried on by the turn that runs it again. Called
   *  inside that turn's admission. */
  refold(turn_id: string, into_turn_id: string): void;
  /** D-337 slice M — the calls this continuation's turn carried that are still untold, to try it
   *  again (its model did not answer): the records that are not a run again, whether it began
   *  acting, and its first record's run and origin. `undefined` when every call was told since
   *  (the conversation's next turn carried them) or the turn carried none. */
  unanswered(turn_id: string): {
    session_id: string; acted: boolean; turns: readonly string[]; run_id: string; origin_turn_id?: string;
  } | undefined;
  /** D-337 slice M — does this turn still carry a call no model was told of? Asked as a try again
   *  starts: one the conversation's next turn told meanwhile has nothing left to say. */
  untoldIn(turn_id: string): boolean;
  /** D-337 slice N — a try again of this continuation's turn waits until `due_at`, its wait
   *  `attempt` (`HELD_RESULT_RETRY_AFTER_MS`). Kept on the turn's own record, so a server started
   *  again picks the wait up where it was (`retriesDue`). */
  retryDue(turn_id: string, attempt: number, due_at: number): void;
  /** D-337 slice N — the tries again waiting, due since `since`: of a turn the queue ended
   *  (completed or failed) that still carries a call no model was told of and has not begun
   *  acting. A turn whose calls a try carries on since (`refold`) waits for nothing. */
  retriesDue(since: number): ReadonlyArray<{ turn_id: string; attempt: number; due_at: number }>;
}

export const createHeldResultTurnStore = (
  db: Database.Database,
  now: () => number = Date.now,
): HeldResultTurnStore => {
  ensureHeldResultSchema(db);
  const insert = db.prepare(`INSERT OR IGNORE INTO chat_held_result_turns
    (turn_id, session_id, run_id, origin_turn_id, created_at) VALUES (?, ?, ?, ?, ?)`);
  const select = db.prepare('SELECT 1 FROM chat_held_result_turns WHERE run_id = ? LIMIT 1');
  const prune = db.prepare('DELETE FROM chat_held_result_turns WHERE created_at < ?');
  // A turn folded in carries on what it held: a try again (`retry_of`) holds the calls it carries
  // by their own records, which go with it.
  const folded = db.prepare('UPDATE chat_held_result_turns SET into_turn_id = ? WHERE turn_id = ? OR into_turn_id = ?');
  const originOf = db.prepare('SELECT origin_turn_id FROM chat_held_result_turns WHERE turn_id = ?');
  const answer = db.prepare(`UPDATE chat_held_result_turns SET answered_at = ?
    WHERE (turn_id = ? OR into_turn_id = ?) AND answered_at IS NULL`);
  const answeredRuns = db.prepare(`SELECT run_id FROM chat_held_result_turns
    WHERE session_id = ? AND answered_at IS NOT NULL`);
  const act = db.prepare(`UPDATE chat_held_result_turns SET acted_at = ?
    WHERE (turn_id = ? OR into_turn_id = ?) AND acted_at IS NULL`);
  const tell = db.prepare('UPDATE chat_held_result_turns SET answered_at = ? WHERE turn_id = ? AND answered_at IS NULL');
  const refolded = db.prepare(`UPDATE chat_held_result_turns SET into_turn_id = ?
    WHERE COALESCE(into_turn_id, turn_id) = ? AND turn_id != ?`);
  const insertRetry = db.prepare('UPDATE chat_held_result_turns SET retry_of = ? WHERE turn_id = ?');
  const markDue = db.prepare('UPDATE chat_held_result_turns SET retry_due_at = ?, retry_attempt = ? WHERE turn_id = ?');
  const untoldInTurn = db.prepare(`SELECT 1 FROM chat_held_result_turns
    WHERE COALESCE(into_turn_id, turn_id) = ? AND retry_of IS NULL AND answered_at IS NULL LIMIT 1`);
  /** A statement over the queue's table, the chat's, made beside this one. Without it there are no
   *  turns to ask about. */
  const overQueue = <T>(read: () => T, none: T): T => {
    try { return read(); } catch { return none; }
  };
  /** Every record a turn carries (its own, and any folded or carried on into it), when the queue
   *  ended that turn (completed or failed: never one cancelled, still queued or running). */
  const carriedBy = (turn_id: string) => overQueue(() => db.prepare(`SELECT h.turn_id, h.session_id, h.run_id,
      h.origin_turn_id, h.acted_at, h.answered_at, h.retry_of
    FROM chat_held_result_turns h JOIN chat_turn_queue q ON q.turn_id = COALESCE(h.into_turn_id, h.turn_id)
    WHERE COALESCE(h.into_turn_id, h.turn_id) = ? AND q.status IN ('completed', 'failed')
    ORDER BY h.created_at, h.rowid`).all(turn_id), [] as unknown[]);
  return {
    record(turn) {
      const at = now();
      prune.run(at - HELD_RESULT_TURN_KEEP_MS);
      // ⛔ A call made in a continuation carries on the request that continuation answered. An
      // email chat's answer is a reply to that request, and only its turn has the email's receipt:
      // recorded as the continuation itself, the second answer in a chain was owed to no email
      // and never sent.
      const via = turn.origin_turn_id === undefined ? undefined
        : originOf.get(turn.origin_turn_id) as { origin_turn_id: string | null } | undefined;
      const origin = via?.origin_turn_id ?? turn.origin_turn_id ?? null;
      insert.run(turn.turn_id, turn.session_id, turn.run_id, origin, at);
      if (turn.retry_of !== undefined) insertRetry.run(turn.retry_of, turn.turn_id);
    },
    continued: (run_id) => select.get(run_id) !== undefined,
    rootTurnOf(turn_id) {
      return (originOf.get(turn_id) as { origin_turn_id: string | null } | undefined)?.origin_turn_id ?? undefined;
    },
    fold(turn_ids, into_turn_id) {
      for (const turn_id of turn_ids) folded.run(into_turn_id, turn_id, turn_id);
    },
    answered(turn_id) {
      answer.run(now(), turn_id, turn_id);
    },
    delivered(session_id) {
      const told = (answeredRuns.all(session_id) as Array<{ run_id: string }>).map((row) => row.run_id);
      // The continuation running now holds its calls in front of the model. The queue's table is
      // the chat's, made beside this one; without it there is no running turn to ask about.
      let running: string[] = [];
      try {
        running = (db.prepare(`SELECT h.run_id FROM chat_held_result_turns h
          JOIN chat_turn_queue q ON q.turn_id = COALESCE(h.into_turn_id, h.turn_id)
          WHERE h.session_id = ? AND q.status = 'running'`).all(session_id) as Array<{ run_id: string }>)
          .map((row) => row.run_id);
      } catch { /* no queue */ }
      return new Set([...told, ...running]);
    },
    acted(turn_id) {
      act.run(now(), turn_id, turn_id);
    },
    untold(session_id, since, limit) {
      return overQueue(() => db.prepare(`SELECT h.turn_id, h.run_id FROM chat_held_result_turns h
        JOIN chat_turn_queue q ON q.turn_id = COALESCE(h.into_turn_id, h.turn_id)
        WHERE h.session_id = ? AND h.answered_at IS NULL AND h.retry_of IS NULL AND h.created_at >= ?
          AND q.status IN ('completed', 'failed', 'interrupted')
        ORDER BY h.created_at DESC, h.rowid DESC LIMIT ?`).all(session_id, since, limit) as Array<{ turn_id: string; run_id: string }>, []);
    },
    told(turn_ids) {
      const at = now();
      for (const turn_id of turn_ids) tell.run(at, turn_id);
    },
    interrupted(since) {
      const rows = overQueue(() => db.prepare(`SELECT COALESCE(h.into_turn_id, h.turn_id) AS effective, h.turn_id,
          h.session_id, h.run_id, h.origin_turn_id, h.acted_at, h.retry_of
        FROM chat_held_result_turns h JOIN chat_turn_queue q ON q.turn_id = COALESCE(h.into_turn_id, h.turn_id)
        WHERE q.status = 'interrupted' AND h.answered_at IS NULL AND h.created_at >= ?
        ORDER BY h.created_at, h.rowid`).all(since) as Array<{
          effective: string; turn_id: string; session_id: string; run_id: string;
          origin_turn_id: string | null; acted_at: number | null; retry_of: string | null;
        }>, []);
      const groups = new Map<string, {
        turn_id: string; session_id: string; acted: boolean; retried: boolean;
        turns: string[]; run_id: string; origin_turn_id?: string;
      }>();
      for (const row of rows) {
        let group = groups.get(row.effective);
        if (group === undefined) {
          group = { turn_id: row.effective, session_id: row.session_id, acted: false, retried: false, turns: [], run_id: row.run_id };
          groups.set(row.effective, group);
        }
        if (row.acted_at !== null) group.acted = true;
        if (row.turn_id === row.effective) {
          if (row.retry_of !== null) group.retried = true;
          if (row.origin_turn_id !== null) group.origin_turn_id = row.origin_turn_id;
        }
        // The calls themselves are in the records that are not a run again.
        if (row.retry_of === null) group.turns.push(row.turn_id);
      }
      return [...groups.values()];
    },
    refold(turn_id, into_turn_id) {
      refolded.run(into_turn_id, turn_id, into_turn_id);
    },
    unanswered(turn_id) {
      const rows = carriedBy(turn_id) as Array<{
        turn_id: string; session_id: string; run_id: string; origin_turn_id: string | null;
        acted_at: number | null; answered_at: number | null; retry_of: string | null;
      }>;
      // The calls themselves are in the records that are not a run again; told, they are done.
      const calls = rows.filter((row) => row.retry_of === null);
      if (calls.length === 0 || calls.every((row) => row.answered_at !== null)) return undefined;
      const first = calls[0]!;
      return {
        session_id: first.session_id,
        // Its own record, or one folded in: a step it took may have run.
        acted: rows.some((row) => row.acted_at !== null),
        turns: calls.filter((row) => row.answered_at === null).map((row) => row.turn_id),
        run_id: first.run_id,
        ...(first.origin_turn_id !== null ? { origin_turn_id: first.origin_turn_id } : {}),
      };
    },
    retryDue(turn_id, attempt, due_at) {
      markDue.run(due_at, attempt, turn_id);
    },
    retriesDue(since) {
      return overQueue(() => db.prepare(`SELECT h.turn_id, h.retry_attempt AS attempt, h.retry_due_at AS due_at
        FROM chat_held_result_turns h JOIN chat_turn_queue q ON q.turn_id = h.turn_id
        WHERE h.retry_due_at IS NOT NULL AND h.retry_due_at >= ?
          AND q.status IN ('completed', 'failed')
          -- It still carries an untold call: a turn whose calls a try carries on carries none.
          AND EXISTS (SELECT 1 FROM chat_held_result_turns c WHERE COALESCE(c.into_turn_id, c.turn_id) = h.turn_id
            AND c.retry_of IS NULL AND c.answered_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM chat_held_result_turns a WHERE COALESCE(a.into_turn_id, a.turn_id) = h.turn_id
            AND a.acted_at IS NOT NULL)
        ORDER BY h.retry_due_at, h.rowid`).all(since) as Array<{ turn_id: string; attempt: number; due_at: number }>, []);
    },
    untoldIn(turn_id) {
      return untoldInTurn.get(turn_id) !== undefined;
    },
  };
};

/** D-234 § 234.4m — THE DEADLINE ACTUALLY FIRES.
 *
 *  ⛔⛔ WHAT THIS FIXES: `deadline_at` + `on_timeout: 'stop'` were validated,
 *  carried on the wire, and shown on the receiver's card — and NOTHING EVER
 *  ENDED THE RUN. `preflight-boot-sweep` counts `awaiting_peer` anchors and
 *  moves on; no timer, no housekeeping task, no sweeper existed. `'timed_out'`
 *  sat in `PEER_ASK_UNANSWERED_REASONS` with the whole return path already able
 *  to carry it and no producer anywhere. So an author declared a deadline, the
 *  peer was told there was one, and the run waited forever regardless.
 *
 *  🔑 That is assurance-shaped non-assurance — a promise the substrate makes and
 *  does not keep — which this codebase treats as worse than no promise at all.
 *  The fix is a producer, not a new concept: everything else already existed.
 *
 *  🔑🔑 NO `on_timeout` COLUMN IS NEEDED, AND THAT IS AN INVARIANT RATHER THAN A
 *  SHORTCUT. `validatePeerAskSpec` refuses `wait` WITH a deadline
 *  (`deadline_without_stop`) and `stop` WITHOUT one (`stop_without_deadline`),
 *  so `deadline_at` present ⟺ `on_timeout === 'stop'`. A row carrying no
 *  deadline is a deliberate wait-forever and must never be swept.
 *  ⚠ IF THAT VALIDATOR PAIR IS EVER RELAXED, THIS SWEEP STARTS ENDING RUNS WHOSE
 *  AUTHOR ASKED IT TO WAIT. Add the column at that moment, not after.
 *
 *  ⚠ THIS ACTS RATHER THAN REPORTS, so it is deliberately thin — the same posture
 *  `wire-exchange-retry` takes for the same reason. The only decision it makes is
 *  {@link isPeerAskExpired}, which is one comparison and is exported so it can be
 *  tested without a database.
 */
import type { PeerAskUnansweredReason } from '@recued/contracts';

import type { PeerAnswerStore } from './storage/peer-answer-store.js';
import type { PeerAskOutboxRow, PeerAskOutboxStore } from './storage/peer-ask-outbox-store.js';

/** ⚠ A deadline is user-scale — hours, days. Minute granularity is ample, and a
 *  tighter loop would only re-read the same rows. */
export const PEER_ASK_TIMEOUT_SWEEP_INTERVAL_MS = 60_000;

/** The `peer_contract_id` stamped on a timed-out answer.
 *
 *  ⛔ DELIBERATELY NOT `''` AND NOT A PLAUSIBLE ID. That field is audit-only
 *  ("recorded for the audit trail, never for matching"), and the honest value
 *  here is "nobody answered". An empty string is the third spelling of absent and
 *  reads as a bug; anything id-shaped would let a later reader believe a peer
 *  responded. The parentheses cannot occur in a real contract id. */
export const PEER_ASK_NO_ANSWERER = '(deadline — no peer answered)';

const TIMED_OUT: PeerAskUnansweredReason = 'timed_out';

export interface PeerAskTimeoutSweepDeps {
  readonly outbox: Pick<PeerAskOutboxStore, 'list' | 'close'>;
  readonly answers: Pick<PeerAnswerStore, 'record'>;
  /** Re-instantiate the held run past its gate. The gated step re-runs and
   *  `dispatchPeerAsk` finds the recorded non-answer — there is no injection
   *  path here for the same reason there is none in `peer-hold-resumer`. */
  readonly resume: (target: { run_id: string; gated_step_id: string }) => Promise<void>;
  readonly now?: () => number;
  readonly logActivity?: (row: { action: string; target: string; detail: string }) => void;
  readonly log?: (line: string) => void;
}

export interface PeerAskTimeoutSweepResult {
  /** Rows still open at the start of the tick. */
  readonly examined: number;
  /** Past their deadline. */
  readonly expired: number;
  /** Recorded as timed out AND handed to the resumer without throwing. */
  readonly resumed: number;
  /** Lost the race to a real answer that landed first — the run is already
   *  moving, and this sweep must not touch it. */
  readonly alreadyAnswered: number;
  /** Recorded, but the resume threw. The non-answer is durable; the run finds it
   *  on its next resume or at the next boot. */
  readonly failed: number;
}

/** Has this outstanding ask passed its deadline?
 *
 *  ⛔ `undefined` DEADLINE ⇒ NEVER. See the header: no deadline means
 *  `on_timeout: 'wait'`, which is an author saying "hold indefinitely". Written
 *  as an explicit `!== undefined` rather than a truthiness test so a deadline of
 *  0 — an epoch timestamp, absurd but expressible — expires rather than being
 *  read as absent. */
export const isPeerAskExpired = (
  row: Pick<PeerAskOutboxRow, 'deadline_at'>,
  now: number,
): boolean => row.deadline_at !== undefined && row.deadline_at <= now;

/** One pass over the outstanding asks. Safe to call concurrently with a real
 *  answer arriving — see the race note on `record` below. */
export const sweepExpiredPeerAsks = async (
  deps: PeerAskTimeoutSweepDeps,
): Promise<PeerAskTimeoutSweepResult> => {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => { console.info(line); });
  const at = now();
  const open = deps.outbox.list();
  let expired = 0;
  let resumed = 0;
  let alreadyAnswered = 0;
  let failed = 0;

  for (const row of open) {
    if (!isPeerAskExpired(row, at)) continue;
    expired += 1;

    // ⛔⛔ RECORD → CLOSE → RESUME, THE SAME ORDER `receiveAnswer` USES, AND THE
    // ORDER IS THE RACE GUARD. `answers.record` is first-write-wins: if the
    // peer's real answer landed a moment ago, this returns false and the sweep
    // leaves the run entirely alone — it is already being resumed by the answer
    // path, and a second resume would re-run a step that is already running.
    // ⚠ The converse is also correct: when the timeout wins, the peer's later
    // answer is refused `already_answered`. That is not a lost answer, it is a
    // deadline that passed — which is exactly what `on_timeout: 'stop'` asked
    // for, and the peer is told so rather than being silently ignored.
    const recorded = deps.answers.record({
      exchange_ref: row.exchange_ref,
      peer_contract_id: PEER_ASK_NO_ANSWERER,
      answered: false,
      unanswered_because: TIMED_OUT,
      at,
    });
    if (!recorded) {
      alreadyAnswered += 1;
      // ⚠ CLOSE IT ANYWAY. The conversation is over — the answer path closes the
      // row too, and if it has not yet, an open row here would advertise a
      // question that has been answered.
      deps.outbox.close(row.exchange_ref);
      continue;
    }

    deps.logActivity?.({
      action: 'peer_ask_timed_out',
      target: `${row.connection}/${row.label}`,
      detail: JSON.stringify({
        exchange_ref: row.exchange_ref,
        deadline_at: row.deadline_at,
        swept_at: at,
      }),
    });

    // ⚠ CLOSE BEFORE RESUME, matching `receiveAnswer`: the resumed step reads the
    // recorded answer and does not need the row. It also SELF-LIMITS this sweep —
    // a run whose anchor is missing or already terminal comes back `skipped` from
    // the resumer, and with the row already closed it is not re-swept every
    // minute forever.
    deps.outbox.close(row.exchange_ref);

    try {
      await deps.resume({ run_id: row.run_id, gated_step_id: row.gated_step_id });
      resumed += 1;
      log(`[peer-ask-timeout] ${row.exchange_ref.slice(0, 12)}… timed out; run resumed`);
    } catch (e) {
      // ⛔ ONE ROW'S FAILURE MUST NOT STOP THE SWEEP — the next row is a different
      // run, and one unresumable hold must not strand everyone behind it. The
      // non-answer IS recorded and durable either way; the held run finds it
      // whenever it next resumes, exactly as a real answer would.
      failed += 1;
      log(
        `[peer-ask-timeout] ${row.exchange_ref.slice(0, 12)}… recorded but resume failed: `
        + (e instanceof Error ? (e.stack ?? e.message) : String(e))
        + ' — the timeout IS recorded; the held run finds it on its next resume.',
      );
    }
  }

  return { examined: open.length, expired, resumed, alreadyAnswered, failed };
};

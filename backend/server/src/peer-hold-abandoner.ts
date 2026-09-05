/** D-234 § 234.4n — A HOLD WHOSE DISH IS GONE, AND THE COURTESY THAT GOES WITH IT.
 *
 *  ⛔⛔ WHY THIS EXISTS: NOTHING TERMINATES A HELD RUN. Checked all four
 *  candidates before writing a line —
 *    - `execution.kill` (D-181) works over the IN-FLIGHT registry, and a durable
 *      pause retires a run from that list the instant the engine returns
 *      (`completeRun`'s own comment names the pause path). A hold is precisely a
 *      run that has stopped, so kill has nothing to target.
 *    - `dishes.delete` deletes the dish row and clears its context. It does not
 *      touch the outbox, the checkpoint, or the anchor.
 *    - `dishes.update { enabled: false }` gates future firing only.
 *    - `ProcessRetireReason` is bookkeeping, and nothing in the tree assigns it.
 *  ⇒ You can delete a dish while your question sits on someone else's screen, and
 *  the hold outlives the dish that created it. That is how held runs accumulate.
 *
 *  🔑🔑 A SWEEP, NOT A HOOK ON `dishes.delete`, AND THE OWNER'S WORDS ARE THE
 *  ARGUMENT: dishes disappear "due to any reasons". A delete hook catches exactly
 *  one reason and is silent about every other route a dish can stop existing —
 *  an uninstall, a group detach, a restore from a backup taken before it, a bug.
 *  The sweep asks the only question that matters and gets the same answer in all
 *  of them: is the dish that owns this hold still there?
 *
 *  ⛔ IT DOES NOT RESUME. Every other path out of a hold re-runs the gated step;
 *  this one deliberately does not. The owner deleted the dish — its recipe must
 *  not go on to send mail, write records, or spend money on the strength of a
 *  decision to remove it. The anchor is retired terminal and the remaining steps
 *  never execute.
 *
 *  🔑 THE COURTESY NOTICE IS NOT A RECALL, AND THE DISTINCTION IS THE DESIGN.
 *  A peer ask is a LETTER: once sent it cannot be unsent. Gmail's famous feature
 *  is a SEND DELAY, not a retraction; the thing that reaches into another
 *  mailbox is Exchange recall, which works only inside one organisation and
 *  fails openly outside it — which is exactly our case, always. So this promises
 *  nothing: it tells the peer "I stopped waiting", best effort, and the local
 *  termination happens whether or not that lands.
 *  ⇒ What it buys is the only thing worth buying: their attention. A card for a
 *  question nobody is waiting on gets read, considered, and answered, and the
 *  answer bounces. That is a person's time spent on nothing.
 *
 *  ⛔ IT REPORTS NOTHING ABOUT THEIR STATE, deliberately. A withdrawal that came
 *  back "too late, they already read it" would hand the asker new information
 *  about someone else's attention — a surveillance channel dressed as a
 *  confirmation. The result is discarded; only failures are logged, locally.
 */
import { buildAuditEntry } from '@recued/storage';
import type { AuditEntry, AuditLogStore } from '@recued/storage';
import { isEphemeralDishId } from '@recued/contracts';
import type { Dish, RecipeError } from '@recued/contracts';

import type { PeerAskOutboxRow, PeerAskOutboxStore } from './storage/peer-ask-outbox-store.js';
import type { PeerAnswerRecord, PeerAnswerStore } from './storage/peer-answer-store.js';
import type { GatedActionStore } from './gated-action-store.js';
import { settleLocallyEndedPeerDeliveryReceipt } from './peer-ask-delivery-recovery.js';

/** Durable ownership marker for the local, terminal abandon transition. It is
 * not an authenticated peer answer and must never enter the resume path. */
export const PEER_HOLD_ABANDONER = '__peer_hold_abandoner__' as const;

export type PeerHoldAbandonmentClaim = PeerAnswerRecord & {
  readonly peer_contract_id: typeof PEER_HOLD_ABANDONER;
  readonly answered: false;
  readonly unanswered_because: 'withdrawn';
};

export const isPeerHoldAbandonmentClaim = (
  answer: PeerAnswerRecord | null,
): answer is PeerHoldAbandonmentClaim => answer !== null
  && answer.peer_contract_id === PEER_HOLD_ABANDONER
  && answer.answered === false
  && answer.unanswered_because === 'withdrawn';

export interface PeerHoldAbandonDeps {
  readonly outbox: Pick<PeerAskOutboxStore, 'list' | 'close'>;
  /** First-write-wins ownership shared with real answers and timeouts. */
  readonly answers: Pick<PeerAnswerStore, 'record' | 'get'>;
  readonly gatedActions?: Pick<
    GatedActionStore,
    'get' | 'finish' | 'confirmPeerHandoff'
  >;
  readonly auditLog: Pick<AuditLogStore, 'get' | 'append'>;
  /** `null` ⇒ the dish is gone. ⚠ Must be the LIVE store, not a snapshot: a
   *  cached list taken at boot would abandon holds whose dish was recreated. */
  readonly dishes: { get(dish_id: string): Dish | null };
  /** Best-effort courtesy notice. Rejections are swallowed by the caller — see
   *  the header; this is a letter, not a recall. Absent ⇒ no notice is sent and
   *  the local termination is unchanged, which is the honest posture for a host
   *  with no way to reach peers. */
  readonly notifyWithdrawn?: (row: PeerAskOutboxRow) => Promise<void>;
  readonly now?: () => number;
  readonly logActivity?: (row: { action: string; target: string; detail: string }) => void;
  readonly log?: (line: string) => void;
}

export interface PeerHoldAbandonResult {
  readonly examined: number;
  /** Holds whose owning dish no longer exists. */
  readonly orphaned: number;
  /** Retired terminal (the anchor was rewritten). */
  readonly abandoned: number;
  /** The courtesy notice was accepted by the peer's server. */
  readonly noticed: number;
  /** The notice could not be delivered. ⚠ NOT a failure of this sweep — the
   *  local hold is gone either way; the peer simply keeps a stale card. */
  readonly noticeFailed: number;
}

/** Is this hold orphaned — i.e. does its run belong to a dish that is gone?
 *
 *  ⛔⛔ THREE DISTINCT NOs, AND COLLAPSING ANY OF THEM ABANDONS A LIVE RUN:
 *    - no anchor        → we cannot tell whose it is. Leave it; the retention
 *                         sweep owns genuinely orphaned rows.
 *    - no `dish_id`     → an ad-hoc run (an inline recipe, a drive, a chat
 *                         invocation) that never had a dish. It cannot be
 *                         orphaned BY one, and treating "no dish" as "dish gone"
 *                         would abandon every dishless hold on the server.
 *    - dish still there → the ordinary case.
 *  ⚠ Only the third state is a decision; the first two are refusals to decide. */
export const isOrphanedHold = (
  anchor: AuditEntry | null,
  dishes: { get(dish_id: string): Dish | null },
): boolean => {
  if (anchor === null) return false;
  const dish_id = anchor.dish_id;
  if (typeof dish_id !== 'string' || dish_id === '') return false;
  // ⛔⛔⛔ AN EPHEMERAL DISH ID WAS NEVER IN THE STORE, SO IT ALWAYS LOOKS
  // DELETED. A manual `execute` mints `dsh:eph:<run_id>` for AUDIT ATTRIBUTION
  // ONLY — nothing is ever persisted under it. The first cut of this sweep read
  // that as "the dish is gone" and abandoned every ordinary manual run's hold,
  // seconds after it was raised.
  //
  // ⚠ THE UNIT TESTS COULD NOT SEE IT. They model two states — a dish that is
  // there and a dish that is not — and this is a THIRD: an id that is real,
  // well-formed, attributable, and was never a row. It took a live drive, where
  // it reddened two sections that had nothing to do with dishes: a peer's answer
  // arrived to find the hold already gone, and a deadline had nothing left to
  // expire. 🔑 Neither failure named a dish anywhere in its message.
  if (isEphemeralDishId(dish_id)) return false;
  return dishes.get(dish_id) === null;
};

/** The terminal anchor that retires the hold.
 *
 *  ⚠ SAME `run_id`, WHICH IS THE WHOLE MECHANISM — `append` is INSERT OR REPLACE
 *  on the run id, so this rewrites the `awaiting_peer` row in one write. Mirrors
 *  `checkpoint-retention`'s expiry entry and `preflight-resumer`'s deny: the
 *  historical `recipe_hash` is kept (nothing was re-attempted), the duration
 *  spans original start → now, and the `checkpoint_id` / `ask_id` pairing fields
 *  are dropped because there is nothing left to pair with. */
const buildAbandonEntry = (
  anchor: AuditEntry,
  row: PeerAskOutboxRow,
  nowMs: number,
): AuditEntry => {
  const err: RecipeError = {
    error_id: `peer-hold-abandoned-${nowMs.toString(36)}-${row.run_id}`,
    code: 'RECIPE_HOLD_ABANDONED',
    message:
      `This run was waiting on a peer's answer at step '${row.gated_step_id}', and `
      + `the dish that started it no longer exists. The wait was abandoned; the `
      + `recipe's remaining steps did not run.`,
    severity: 'error',
    source: {
      recipe_id: anchor.recipe_id,
      step_id: row.gated_step_id,
      ingredient_slug: null,
    },
    details: {
      exchange_ref: row.exchange_ref,
      connection: row.connection,
      label: row.label,
      ...(anchor.dish_id !== undefined ? { dish_id: anchor.dish_id } : {}),
    },
    timestamp: new Date(nowMs).toISOString(),
    retryable: false,
  };
  return buildAuditEntry({
    recipe_id: anchor.recipe_id,
    recipe_hash: anchor.recipe_hash,
    commit_status: 'failed',
    duration_ms: Math.max(0, nowMs - anchor.started_at),
    errors: [err],
    config_snapshot: { ...anchor.config_snapshot },
    trigger_url: anchor.trigger_url ?? null,
    trigger_source: anchor.trigger_source ?? null,
    instance_id: anchor.instance_id ?? null,
    run_id: row.run_id,
    now: nowMs,
    ...(anchor.dish_id !== undefined ? { dish_id: anchor.dish_id } : {}),
    ...(anchor.recipe_insight_id !== undefined
      ? { recipe_insight_id: anchor.recipe_insight_id }
      : {}),
    ...(anchor.process_id ? { process_id: anchor.process_id } : {}),
    ...(anchor.run_mode ? { run_mode: anchor.run_mode } : {}),
    ...(anchor.execution_source ? { execution_source: anchor.execution_source } : {}),
    ...(anchor.correlation_id ? { correlation_id: anchor.correlation_id } : {}),
  });
};

export const abandonOrphanedPeerHolds = async (
  deps: PeerHoldAbandonDeps,
): Promise<PeerHoldAbandonResult> => {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => { console.info(line); });
  const at = now();
  const open = deps.outbox.list();
  let orphaned = 0;
  let abandoned = 0;
  let noticed = 0;
  let noticeFailed = 0;

  for (const row of open) {
    const anchor = await deps.auditLog.get(row.run_id);
    if (!isOrphanedHold(anchor, deps.dishes)) continue;
    orphaned += 1;

    // Claim the conversation in the SAME first-write-wins store used by answers
    // and deadlines. The audit read above yields, so the peer may have answered
    // since `list()`; only the winner may retire the anchor.
    const claimed = deps.answers.record({
      exchange_ref: row.exchange_ref,
      peer_contract_id: PEER_HOLD_ABANDONER,
      answered: false,
      unanswered_because: 'withdrawn',
      at,
    });
    if (!claimed) {
      const existing = deps.answers.get(row.exchange_ref);
      // A previous abandonment may have claimed successfully and then lost the
      // audit write. Retry that transition; every other answer owns the run.
      if (existing?.peer_contract_id !== PEER_HOLD_ABANDONER
        || existing.unanswered_because !== 'withdrawn') continue;
    }

    await settleLocallyEndedPeerDeliveryReceipt(
      row,
      'abandoned',
      deps.gatedActions,
    );

    // Audit BEFORE deleting the live row. If this write fails, the next sweep
    // sees the outbox row and retries; the durable withdrawal claim prevents a
    // late peer answer from racing in meanwhile.
    await deps.auditLog.append(buildAbandonEntry(anchor!, row, at));
    deps.outbox.close(row.exchange_ref);
    abandoned += 1;

    deps.logActivity?.({
      action: 'peer_ask_abandoned',
      target: `${row.connection}/${row.label}`,
      detail: JSON.stringify({
        exchange_ref: row.exchange_ref,
        run_id: row.run_id,
        dish_id: anchor!.dish_id ?? null,
      }),
    });
    log(
      `[peer-hold-abandon] ${row.exchange_ref.slice(0, 12)}… dish `
      + `${String(anchor!.dish_id)} is gone; hold retired`,
    );

    if (deps.notifyWithdrawn === undefined) continue;
    try {
      await deps.notifyWithdrawn(row);
      noticed += 1;
    } catch (e) {
      // ⚠ A FAILED NOTICE IS NOT A FAILED SWEEP. The peer keeps a stale card and
      // their eventual answer bounces — which is exactly what happens with a
      // letter nobody is waiting on, and is the model rather than a defect.
      noticeFailed += 1;
      log(
        `[peer-hold-abandon] ${row.exchange_ref.slice(0, 12)}… withdrawal notice `
        + `did not reach ${row.connection}: `
        + (e instanceof Error ? e.message : String(e))
        + ' — the local hold is gone; their card is stale.',
      );
    }
  }

  return { examined: open.length, orphaned, abandoned, noticed, noticeFailed };
};

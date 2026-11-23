/** D-329 — a chat's held Tier-1 write, once its hold settles.
 *
 *  A Tier-1 write the chat proposes (`calendar.create`, `work.update`, …) is held as a raw op
 *  is (`holdTier1Call`): its ask goes to every approval channel, and answering it anywhere
 *  runs the call or refuses it. Nothing in the conversation is waiting for that answer, so
 *  this is where the conversation hears it:
 *
 *  - **The card.** The proposal resolves (approved, or cancelled on a refusal), its approval
 *    is spent, and its execution receipt is recorded, then broadcast as the plan-linked
 *    lifecycle events the card already reads.
 *  - **The reply.** One assistant message in the session it was asked in, in the email
 *    door's words (`mailChatFollowUpText`). The session's own delivery carries it: the web
 *    app shows it, a Telegram or Slack chat is sent it (`chat_messenger_commit`), an email
 *    chat is answered by email (`mail_chat_answer_owed`).
 *
 *  ⛔ NOT AS A TOOL ROW. `createChatRunSettledSink` writes the result half of a held tool
 *  call, and a held write has no call half: its first half is the card. The wire routes a
 *  run here first and skips the sink when this claims it.
 *
 *  ⚠ THE REPLY WAITS FOR THE TURN'S ANSWER. The ask is raised while the turn is still
 *  running, so an owner quick to approve on their phone settles the write before the model
 *  has said it asked; "done" would then reach a messenger before "I've asked for your
 *  approval". The reply is written once the turn's answer is linked to the plan, or after
 *  `HELD_WRITE_REPLY_WAIT_MS` (a turn that failed has no answer to wait for). In memory: a
 *  restart inside that window loses the reply, never the outcome on the card. */

import {
  captureResourceReview,
  isChatDispatchReason,
  isExecutionSource,
  isGatedActionTerminal,
  KIND_GRANT_OPTION_ID,
  TRIGGER_PREAPPROVAL_OPTION_ID,
  tier1CallTitle,
  type ChatDispatchReason,
  type ResourceReviewHooks,
  type ChatMessage,
  type ChatPlanExecutionReceipt,
  type ChatPlanMade,
  type ChatPlanProposal,
  type Checkpoint,
  type ExecutionSource,
  type RecuedServerSignature,
} from '@recued/contracts';
import {
  isPreflightApprovalKind,
  PREFLIGHT_GATHERED_HANDLER_KIND,
  preflightAskHolds,
  type planApproval,
} from '@recued/gateway';
import type { NotificationBlock } from '@recued/notification';
import type { AuditEntry, CheckpointStore } from '@recued/storage';

import type { ChatBroadcastEmitter, ChatOrchestratorDeps } from './chat-orchestrator.js';
import type { ExecuteHandlerDeps } from './execute-handler.js';
import { holdTier1Call, type RawOpDispatchDeps } from './raw-op-dispatch.js';
import { withResourceReview } from './resource-review.js';
import { reviewedLocalMutationKind } from './storage/ordinary-local-mutation-receipts.js';
import { mailChatFollowUpText, mailChatRunOutcome } from './mail-chat-door/follow-ups.js';
import type { PreflightRunSettled } from './preflight-resumer.js';
import type { ChatStore } from './storage/chat-store.js';
import { declinedActionWords, withDeclinedAction } from './chat-rolling-brief.js';
import type { HeldResultContinuation, HeldResultOutcome } from './chat-held-results.js';
import type { GatedActionStore } from './gated-action-store.js';

/** How long a settled write's reply waits for its turn's answer. */
export const HELD_WRITE_REPLY_WAIT_MS = 120_000;
const HELD_WRITE_REPLY_POLL_MS = 2_000;

/** One reply per proposal, so a settlement told twice writes once. */
export const heldWriteReplyId = (plan_id: string): string => `held-write:${plan_id}`;

/** What a hold that expired unanswered settles with (retention's `onRawOpExpired`, and its
 *  `onExpired` for a held recipe run). */
export const HELD_WRITE_EXPIRED_MESSAGE =
  'Its approval expired before anyone answered it, so nothing ran.';

/** The reply when a held write's approval expired: no one said no, no one answered in time. */
export const heldWriteExpiredText = (title: string | undefined): string =>
  `${title === undefined
    ? 'The action that waited for your approval'
    : `The action that waited for your approval, "${title}",`} expired before anyone answered it, `
  + 'so it was not done. Ask again if you still want it.';

const isExpiredSettlement = (settled: PreflightRunSettled): boolean =>
  settled.result !== null && typeof settled.result === 'object'
  && (settled.result as { expired?: unknown }).expired === true;

/** What retention tells the chat when a raw-op hold expired unanswered: a settlement that
 *  says `expired`, so a held write's card lapses rather than reading as an approval that
 *  failed. `undefined` for anything that is not a raw-op hold. */
export const expiredHoldSettlement = (checkpoint: Checkpoint, ts: number): PreflightRunSettled | undefined => {
  const raw = checkpoint.raw_op;
  if (raw === undefined) return undefined;
  return {
    execution_source: raw.execution_source,
    run_id: checkpoint.run_id,
    tool_name: raw.op_id,
    result: { success: false, expired: true, message: HELD_WRITE_EXPIRED_MESSAGE },
    ts,
  };
};

/** D-337 slice R — the same for a held recipe run, from the record retention writes when it
 *  expires one (its `onExpired`). Before, nothing settled such a run: its conversation never
 *  heard, its call kept "waiting to hear back", and the model's next turn read it as pending.
 *  Shaped as the resumer's refusal is (the originating `execution_source`, carried onto the
 *  expiry's record from the paused one; the recipe as `tool_name`). `undefined` for a run no
 *  source started. */
export const expiredRunSettlement = (entry: AuditEntry, ts: number): PreflightRunSettled | undefined =>
  entry.execution_source === undefined ? undefined : {
    execution_source: entry.execution_source,
    run_id: entry.run_id,
    tool_name: entry.recipe_id,
    result: { success: false, expired: true, message: HELD_WRITE_EXPIRED_MESSAGE },
    ts,
  };

/** Codes a resume refuses with before anything ran, which are not dispatch reasons: the
 *  card says it was not done rather than that it may not have finished. */
const resumeRefusalReason = (code: unknown): ChatDispatchReason =>
  isChatDispatchReason(code) ? code : typeof code === 'string' ? 'channel_denied' : 'execution_error';

export interface HeldChatWritesDeps {
  readonly plans: Pick<
    planApproval.PlanApprovalStore,
    'resolve' | 'markConsumed' | 'recordExecution' | 'findByHoldRun' | 'answerMessageId' | 'lapseHold'
  >;
  /** The note's read and write are optional: a store without them notes no declined write (`withDeclinedAction`). */
  readonly chatStore: Pick<ChatStore, 'appendMessage'> & Partial<Pick<ChatStore, 'readSessionBrief' | 'writeSessionBrief'>>;
  readonly broadcast: ChatBroadcastEmitter;
  readonly signature: RecuedServerSignature;
  readonly now?: () => number;
  /** Test seam for the reply's wait. */
  readonly schedule?: (run: () => void, ms: number) => void;
  /** D-337 — continue the conversation with the write's outcome, as an AI app would. `true` once
   *  a continuation is queued; the fixed reply below is then not written. */
  readonly continueConversation?: (continuation: HeldResultContinuation) => Promise<boolean>;
}

export interface HeldChatWrites {
  /** Settle a run if it is a chat's held write. `true` when it was one, so the run is not
   *  also written as a tool call's result. */
  settle(settled: PreflightRunSettled): Promise<boolean>;
}

/** D-336 slice Q — what a held write that ran made, from its result: the contact a
 *  `contact.write` added, or the note a `memory.write` saved. A change of a contact makes none. */
const madeBy = (tool: string, settledResult: unknown): ChatPlanMade | undefined => {
  const result = (settledResult as { result?: unknown } | null | undefined)?.result;
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const made = result as Record<string, unknown>;
  if (tool === 'contact.write' && made.added === true && typeof made.target_id === 'string' && made.target_id !== ''
    && typeof made.name === 'string') {
    return { kind: 'contact', target_id: made.target_id, name: made.name };
  }
  if (tool === 'memory.write' && typeof made.memory_id === 'string' && made.memory_id !== '') {
    return { kind: 'memory', memory_id: made.memory_id };
  }
  return undefined;
};

export const createHeldChatWrites = (deps: HeldChatWritesDeps): HeldChatWrites => {
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? ((run: () => void, ms: number) => {
    setTimeout(run, ms).unref?.();
  });
  const emit = (event: Parameters<ChatBroadcastEmitter['emit']>[0]): void => {
    try { deps.broadcast.emit(event); } catch { /* observability only */ }
  };

  const writeReply = async (
    plan: ChatPlanProposal,
    content: string,
    source: ExecutionSource,
  ): Promise<void> => {
    const message: Parameters<ChatStore['appendMessage']>[0] = {
      id: heldWriteReplyId(plan.plan_id),
      session_id: plan.session_id,
      role: 'assistant',
      content,
      target_server: 'self',
      picker_at_send: { display_name: 'self', signature: deps.signature },
      model_used: { provider: 'recued', model_id: 'approval-follow-up' },
      execution_source: source,
      turn_id: plan.turn_id,
      ts: now(),
    };
    let written: ChatMessage;
    try {
      written = await deps.chatStore.appendMessage(message);
    } catch (error) {
      // Written already (a settlement told twice), or the vault locked: the card carries
      // the outcome either way.
      console.warn(`[chat] held write reply for plan ${plan.plan_id} was not written`, error);
      return;
    }
    emit({ kind: 'chat.message_complete', session_id: plan.session_id, turn_id: plan.turn_id, final: written });
  };

  const replyOnceAnswered = (
    plan: ChatPlanProposal,
    content: string,
    source: ExecutionSource,
  ): void => {
    const deadline = now() + HELD_WRITE_REPLY_WAIT_MS;
    const attempt = async (): Promise<void> => {
      let answered: string | undefined;
      try {
        answered = await deps.plans.answerMessageId?.(plan.plan_id);
      } catch {
        answered = undefined;
      }
      // No link to wait for (a store that cannot say) counts as answered.
      if (answered !== undefined || deps.plans.answerMessageId === undefined || now() >= deadline) {
        await writeReply(plan, content, source);
        return;
      }
      schedule(() => { void attempt(); }, HELD_WRITE_REPLY_POLL_MS);
    };
    void attempt();
  };

  /** D-337 — the conversation continues with the outcome; the fixed reply is the fallback. The
   *  owner's own conversations: the app's chat, a messenger or an email chat. */
  const continueOrReply = async (
    plan: ChatPlanProposal,
    settled: PreflightRunSettled,
    outcome: HeldResultOutcome,
    title: string | undefined,
    source: ExecutionSource,
    reply: string,
  ): Promise<void> => {
    // Which conversations go on is the continuation's to decide (the owner's own, by source).
    if (deps.continueConversation !== undefined) {
      const continued = await deps.continueConversation({
        source,
        session_id: plan.session_id,
        turn_id: plan.turn_id,
        run_id: settled.run_id,
        tool_name: plan.tool,
        tier: plan.tier,
        args: plan.args,
        outcome,
        ...(outcome === 'ran' || outcome === 'failed' ? { result: settled.result } : {}),
        ...(title !== undefined ? { title } : {}),
        called_at: plan.created_at,
        settled_at: settled.ts,
      }).catch(() => false);
      if (continued) return;
    }
    replyOnceAnswered(plan, reply, source);
  };

  const settle = async (settled: PreflightRunSettled): Promise<boolean> => {
    let plan: ChatPlanProposal | undefined;
    try {
      plan = await deps.plans.findByHoldRun?.(settled.run_id);
    } catch (error) {
      console.error(`[chat] held write lookup failed for run ${settled.run_id}`, error);
      return false;
    }
    if (plan === undefined) return false;
    // D-343 — replaced by a newer version: withdrawn with nothing run and no one's answer, so
    // nothing more is said of it (a deny that won the race to its ask settles here too).
    if (plan.hold?.replaced_at !== undefined) return true;
    const at = now();
    const title = tier1CallTitle(plan.tool, plan.args);
    const source = isExecutionSource(settled.execution_source) ? settled.execution_source : undefined;
    if (isExpiredSettlement(settled)) {
      // Nothing ran: the card says it expired, and the chat hears it, as a refusal is told.
      try {
        const lapsed = await deps.plans.lapseHold?.(plan.plan_id, settled.run_id, at);
        if (lapsed !== undefined && lapsed.status !== plan.status) {
          emit({ kind: 'chat.plan_resolved', session_id: plan.session_id, turn_id: plan.turn_id, plan: lapsed });
        }
      } catch (error) {
        console.error(`[chat] held write expiry for plan ${plan.plan_id} was not recorded`, error);
      }
      if (source !== undefined) {
        await continueOrReply(plan, settled, 'expired', title, source, heldWriteExpiredText(title));
      }
      return true;
    }
    const { outcome, detail } = mailChatRunOutcome(settled);
    try {
      if (outcome === 'denied') {
        const resolved = plan.status === 'proposed'
          ? await deps.plans.resolve(plan.plan_id, 'cancelled', at)
          : plan;
        if (resolved !== undefined && resolved.status !== plan.status) {
          emit({ kind: 'chat.plan_resolved', session_id: plan.session_id, turn_id: plan.turn_id, plan: resolved });
        }
        // The owner said no: the conversation's note keeps it, so a later "Continue." does not reopen it. In its
        // own try: the refusal above is already durable, and a note that cannot be updated is not a failed one.
        try {
          const stored = await deps.chatStore.readSessionBrief?.(plan.session_id);
          const noted = stored === undefined || stored === null ? null : withDeclinedAction(stored, declinedActionWords(plan.tool, title, plan.args));
          if (noted !== null) await deps.chatStore.writeSessionBrief?.(plan.session_id, noted);
        } catch (error) {
          console.error(`[chat] the declined write for plan ${plan.plan_id} was not noted`, error);
        }
      } else {
        const approved = plan.status === 'proposed'
          ? await deps.plans.resolve(plan.plan_id, 'approved', at)
          : plan;
        if (approved !== undefined && approved.status !== plan.status) {
          emit({ kind: 'chat.plan_resolved', session_id: plan.session_id, turn_id: plan.turn_id, plan: approved });
        }
        // Spent, then settled: a receipt records only the dispatch that consumed it.
        await deps.plans.markConsumed(plan.plan_id, at, plan.turn_id);
        const result = (settled.result ?? {}) as Record<string, unknown>;
        const run = { run_id: settled.run_id };
        const made = outcome === 'succeeded' ? madeBy(plan.tool, settled.result) : undefined;
        const receipt: ChatPlanExecutionReceipt = outcome === 'succeeded'
          ? {
              status: 'completed', turn_id: plan.turn_id, result_ref: heldWriteReplyId(plan.plan_id),
              ...(made !== undefined ? { made } : {}), ...run,
            }
          : outcome === 'interrupted'
            ? { status: 'unknown', turn_id: plan.turn_id }
            : {
                status: 'failed',
                turn_id: plan.turn_id,
                reason: resumeRefusalReason(result.code),
                ...(detail !== undefined ? { detail } : {}),
                ...run,
              };
        await deps.plans.recordExecution?.(plan.plan_id, receipt);
        emit(receipt.status === 'completed'
          ? {
              kind: 'chat.tool_call_completed', session_id: plan.session_id, turn_id: plan.turn_id,
              tool_name: plan.tool, tier: plan.tier, plan_id: plan.plan_id, run_id: settled.run_id,
              status: 'ok', result_ref: receipt.result_ref,
            }
          : {
              kind: 'chat.tool_call_completed', session_id: plan.session_id, turn_id: plan.turn_id,
              tool_name: plan.tool, tier: plan.tier, plan_id: plan.plan_id,
              status: 'error',
              reason: receipt.status === 'failed' ? receipt.reason : 'execution_error',
              ...(detail !== undefined ? { detail } : {}),
            });
      }
    } catch (error) {
      // The write's outcome is already durable on its hold; the card catches up on reload.
      console.error(`[chat] held write settlement for plan ${plan.plan_id} was not recorded`, error);
    }
    if (source !== undefined) {
      let content = mailChatFollowUpText(outcome, title, detail);
      if (outcome === 'succeeded' && plan.tool === 'schedule.run_prompt') {
        const envelope = settled.result as { result?: { session_id?: unknown } } | undefined;
        const session = envelope?.result?.session_id;
        if (typeof session === 'string' && session.length > 0) {
          content += `\n\n[Open scheduled conversation](#chat/session/${encodeURIComponent(session)})`;
        }
      }
      await continueOrReply(plan, settled,
        outcome === 'succeeded' ? 'ran' : outcome === 'denied' ? 'refused' : 'failed',
        title, source, content);
    }
    return true;
  };

  return { settle };
};

/** How many answered holds the card's answerer remembers: far more than are answered at
 *  once, and few enough that a long uptime keeps it small. */
const ANSWERED_KEPT = 1000;

/** The answers a held write's card gives its ask: yes once, yes with the second answer the ask
 *  offers (`allow_offered`), or no. The second answer is the trigger's standing pre-approval on a
 *  scheduled run's write (D-341, "Always allow for this scheduled prompt"), or the kind grant on
 *  the owner's own chat's write (D-177 N.15, "Allow in this chat"); a hold offers one
 *  at most, and its card shows it as `hold.always_allow`. */
export type HeldPlanAskOption = 'approve' | 'allow_offered' | 'deny';

/** D-177 §N.15.9 (1c-b) — what the card's answer says beside its option. `edited`: the yes carries
 *  the owner's change to the call, which a round's one approval of several refuses (`ignored`).
 *  `together`: told the runs of every hold a round's one approval answered, the asked one's
 *  included, so each one's card is answered with it. */
export interface HeldPlanAnswerOptions {
  readonly edited?: boolean;
  readonly together?: (run_ids: readonly string[]) => void;
}

/** The second answers a held write's ask can offer beside Approve, in the order tried. */
const SECOND_ANSWERS = [TRIGGER_PREAPPROVAL_OPTION_ID, KIND_GRANT_OPTION_ID] as const;

/** D-329 — the chat card's answer to its held write's ask, over the notification block,
 *  given as the owner's answer from the app (`via: 'ui'`) like the approval cards'. The ask
 *  is found by the hold's run on every call, never kept: a boot re-raise mints a new one.
 *  `expired` — no ask is out because the hold expired unanswered (`holdExpired`, read off
 *  the hold's receipt), and the card was never told. Any other missing ask is `no_ask`.
 *  `beforeApprove` (D-336 slice E: the owner's change to the call) runs once the ask is found
 *  open, just before it is approved; a throw leaves it unanswered.
 *  `allow_trigger` (D-341) approves with the trigger's standing pre-approval the ask offers
 *  (`ChatPlanProposal.hold.always_allow`): `ignored`, with nothing run first, when the open ask
 *  offers none.
 *
 *  ⛔ ONE ANSWER AT A TIME PER HOLD (audit 2026-11-01). Finding the ask open, the owner's
 *  change (the hold's checkpoint, then the proposal, or the checkpoint taken back) and the
 *  answer are one step. Two cards answering at once each found the ask open, and the second's
 *  change and its taking back landed between the first's and its answer: the card said "Edit
 *  on device A" and memory saved the agent's words. Now the second finds the ask answered.
 *  The holds answered here are kept (the newest `ANSWERED_KEPT`): an ask whose handler has
 *  finished leaves the unresolved list, and the second would otherwise read as one not
 *  raised yet ("not ready yet; try again"). */
export const createHeldPlanAskAnswerer = (
  block: Pick<NotificationBlock, 'listUnresolvedAsks' | 'submitAnswer'>,
  holdExpired?: (run_id: string) => Promise<boolean>,
) => {
  const answering = new Map<string, Promise<void>>();
  const answered = new Set<string>();
  const answerOnce = async (
    run_id: string,
    option: HeldPlanAskOption,
    beforeApprove?: () => Promise<void>,
    opts?: HeldPlanAnswerOptions,
  ): Promise<'answered' | 'closed' | 'ignored' | 'no_ask' | 'expired'> => {
    if (answered.has(run_id)) return 'closed';
    // Its own ask, or (D-177 §N.15.9) its round's one approval, which lists every hold it answers.
    const ask = (await block.listUnresolvedAsks()).find((candidate) =>
      isPreflightApprovalKind(candidate.handler_kind)
      && preflightAskHolds(candidate).some((hold) => hold.run_id === run_id));
    if (ask === undefined) {
      return holdExpired !== undefined && await holdExpired(run_id) ? 'expired' : 'no_ask';
    }
    if (ask.status !== 'open') return 'closed';
    // An approval of several takes no change to one of them; its card offers none.
    const gathered = ask.handler_kind === PREFLIGHT_GATHERED_HANDLER_KIND;
    if (gathered && opts?.edited === true) return 'ignored';
    // The second answer is the one the open ask offers; an ask offering none ignores it.
    const answer = option === 'allow_offered'
      ? SECOND_ANSWERS.find((id) => ask.options.some((offered) => offered.id === id))
      : option;
    if (answer === undefined) return 'ignored';
    if (answer !== 'deny') await beforeApprove?.();
    const outcome = await block.submitAnswer({ ask_id: ask.ask_id, option: answer, via: 'ui' });
    if (outcome === 'answered') {
      const runs = preflightAskHolds(ask).flatMap((hold) => (hold.run_id !== undefined ? [hold.run_id] : []));
      for (const run of runs.length > 0 ? runs : [run_id]) answered.add(run);
      while (answered.size > ANSWERED_KEPT) answered.delete(answered.values().next().value!);
      if (gathered) opts?.together?.(runs);
    }
    return outcome;
  };
  return async (
    run_id: string,
    option: HeldPlanAskOption,
    beforeApprove?: () => Promise<void>,
    opts?: HeldPlanAnswerOptions,
  ): Promise<'answered' | 'closed' | 'ignored' | 'no_ask' | 'expired'> => {
    const turn = (answering.get(run_id) ?? Promise.resolve()).then(() => answerOnce(run_id, option, beforeApprove, opts));
    const settled = turn.then(() => {}, () => {});
    answering.set(run_id, settled);
    try {
      return await turn;
    } finally {
      if (answering.get(run_id) === settled) answering.delete(run_id);
    }
  };
};

/** D-329 — the chat gate's hold (`ChatOrchestratorDeps.holdTier1Write`): a Tier-1 write held
 *  as a write raw op is (its checkpoint, the receipt, the ask every approval channel shows),
 *  under the run id its proposal was stored with, and correlated to the proposal. Only "the
 *  approval substrate is not wired" means nothing was written. */
export const createHoldTier1Write = (
  getDeps: () => RawOpDispatchDeps | undefined,
): NonNullable<ChatOrchestratorDeps['holdTier1Write']> =>
  async ({ tool, args, plan_id, run_id, session_id, turn_id, execution_source, contract_snapshot, value_labels, memory_conflicts, change_in_chat, defer_ask }) => {
    const deps = getDeps();
    if (deps === undefined) return { held: false, reason: 'execute_deps_unavailable' };
    const outcome = await holdTier1Call(deps, {
      tool,
      args,
      executionSource: execution_source,
      ...(contract_snapshot !== undefined ? { contractSnapshot: contract_snapshot } : {}),
      correlationId: plan_id,
      runId: run_id,
      sessionId: session_id,
      ...(turn_id !== undefined ? { turnId: turn_id } : {}),
      ...(value_labels !== undefined ? { valueLabels: value_labels } : {}),
      ...(memory_conflicts !== undefined ? { memoryConflicts: memory_conflicts } : {}),
      ...(change_in_chat !== undefined ? { changeInChat: change_in_chat } : {}),
      ...(defer_ask !== undefined ? { deferAsk: defer_ask } : {}),
    });
    if (outcome.kind !== 'held') {
      return { held: false, reason: outcome.kind === 'ask' ? 'approval_not_wired' : outcome.kind };
    }
    // D-177 §N.15.9 (1c-b) — kept for its round's one approval: no ask is out yet.
    if (outcome.gathered === true) return { held: true, gathered: true };
    return outcome.approval_channels !== undefined
      ? { held: true, approval_channels: outcome.approval_channels }
      : { held: true };
  };

/** A held write, approved (the execute deps' `runApprovedTier1Write`): run as a write approved
 *  on its card runs. Its proposal is approved and spent first, then the call runs under its
 *  reviewed change and a receipt for the proposal (`runLocalMutation`), so its card offers
 *  Undo. Before, an approved hold ran the call bare and kept no receipt: the owner's own
 *  chats, which always hold, could undo none of their changes. A call that changes nothing
 *  Recued can undo, or a proposal that cannot be spent, runs as before; the settlement records
 *  the outcome either way, on a proposal already spent changing nothing. ⚠ Reviewed, the change
 *  is refused when its record changed since it was proposed, as a card's is. */
export const createRunApprovedTier1Write = (deps: {
  readonly plans: Pick<planApproval.PlanApprovalStore, 'findByHoldRun' | 'resolve' | 'consumeForDispatch' | 'runLocalMutation'>;
  readonly getResourceReview: () => ResourceReviewHooks | undefined;
  readonly broadcast: ChatBroadcastEmitter;
  readonly now?: () => number;
}): NonNullable<ExecuteHandlerDeps['runApprovedTier1Write']> => async (call, dispatch) => {
  const now = deps.now ?? Date.now;
  const plan = await deps.plans.findByHoldRun?.(call.run_id);
  const review = plan?.resource_review;
  if (plan === undefined || plan.tool !== call.tool || review === undefined
    || reviewedLocalMutationKind(review) === null || deps.plans.runLocalMutation === undefined) return dispatch();
  const at = now();
  if (plan.status === 'proposed') {
    const approved = await deps.plans.resolve(plan.plan_id, 'approved', at);
    if (approved?.status === 'approved') {
      try {
        deps.broadcast.emit({ kind: 'chat.plan_resolved', session_id: plan.session_id, turn_id: plan.turn_id, plan: approved });
      } catch { /* observability only */ }
    }
  }
  const spent = await deps.plans.consumeForDispatch(plan.plan_id, at, plan.turn_id);
  if (spent === undefined) return dispatch();
  return withResourceReview(review, () => {
    captureResourceReview(deps.getResourceReview(), call.tool, call.args, review, true);
    return deps.plans.runLocalMutation!(plan.plan_id, plan.turn_id, call.source, call.validate, dispatch);
  });
};

/** D-329 — the chat's run-settled sink: a held write settles here, onto its card and its
 *  reply, and never also as a tool call's result row (it has no call row to pair with). */
export const settleChatRun = (
  heldWrites: HeldChatWrites,
  toolRowSink: (settled: PreflightRunSettled) => Promise<void>,
  /** D-337 — a run held in the owner's messenger or email chat, which keeps no tool-call row:
   *  `true` when it was one (`createWatchedRunSettlement`). */
  watchedRuns?: (settled: PreflightRunSettled) => Promise<boolean>,
) => async (settled: PreflightRunSettled): Promise<void> => {
  if (await heldWrites.settle(settled)) return;
  if (watchedRuns !== undefined && await watchedRuns(settled)) return;
  await toolRowSink(settled);
};

/** D-329 — did this hold expire unanswered? Its checkpoint is gone and its receipt is
 *  `cancelled`, which is what retention's staleness guard leaves (a refusal leaves `denied`,
 *  a run its outcome). Anything it cannot read is "no": the card then waits, never lies. */
export const createHoldExpiredReader = (deps: {
  readonly checkpointStore?: Pick<CheckpointStore, 'listByRun'>;
  readonly gatedActionStore?: Pick<GatedActionStore, 'getBySubject'>;
}) => async (run_id: string): Promise<boolean> => {
  if (deps.checkpointStore === undefined || deps.gatedActionStore === undefined) return false;
  try {
    if ((await deps.checkpointStore.listByRun(run_id)).length > 0) return false;
    return (await deps.gatedActionStore.getBySubject(run_id, 'raw_op'))?.status === 'cancelled';
  } catch {
    return false;
  }
};

/** D-343 (the owner, 2026-11-14: "a way for model to ... chat more about it tuning the content
 *  before settling") — what a withdrawn approval says beneath what it asked, where its message can
 *  still be changed (Telegram, Slack). */
export const HELD_WRITE_REPLACED_NOTE = 'Replaced by a newer version.';

/** D-343 — withdraw a held write a newer version of the same call replaced before it was answered:
 *  its ask closed everywhere with `HELD_WRITE_REPLACED_NOTE`, its receipt cancelled (so an approval
 *  that still arrives runs nothing, and a restart does not ask again), its plan cancelled with
 *  `hold.replaced_at`, its checkpoint gone. As an expiry is, in that order, and never a refusal:
 *  no continuation, no fixed reply, no write rule or chain counts it as a no.
 *  `'raced'` when an answer got there first (it settles as answered), or when its ask is a round's
 *  one approval of several writes, which this one cannot take back alone. */
export const createHeldWriteWithdrawal = (deps: {
  readonly block: Pick<NotificationBlock, 'listUnresolvedAsks' | 'cancelAsk'>;
  readonly checkpointStore: Pick<CheckpointStore, 'listByRun' | 'delete'>;
  readonly gatedActionStore: Pick<GatedActionStore, 'getBySubject' | 'finish'>;
  readonly plans: Pick<planApproval.PlanApprovalStore, 'replaceHold'>;
  readonly emit?: ChatBroadcastEmitter['emit'];
  readonly now?: () => number;
}) => async (plan: ChatPlanProposal): Promise<'withdrawn' | 'raced'> => {
  const run_id = plan.hold?.run_id;
  if (run_id === undefined || plan.status !== 'proposed' || plan.hold?.group !== undefined) return 'raced';
  const ask = (await deps.block.listUnresolvedAsks()).find((candidate) =>
    isPreflightApprovalKind(candidate.handler_kind) && preflightAskHolds(candidate).some((hold) => hold.run_id === run_id));
  if (ask !== undefined) {
    if (ask.status !== 'open' || preflightAskHolds(ask).length > 1) return 'raced';
    if (await deps.block.cancelAsk(ask.ask_id, { note: HELD_WRITE_REPLACED_NOTE }) !== 'cancelled') return 'raced';
  }
  const action = await deps.gatedActionStore.getBySubject(run_id, 'raw_op');
  if (action !== null && !isGatedActionTerminal(action.status)) {
    await deps.gatedActionStore.finish(action.action_ref, {
      status: 'cancelled',
      status_message: 'A newer version replaced it before it was answered; nothing ran.',
      result: { code: 'REPLACED', replaced: true },
      observed: { items: 1, succeeded: 0, failed: 0 },
    });
  }
  const replaced = await deps.plans.replaceHold?.(plan.plan_id, run_id, (deps.now ?? Date.now)());
  if (replaced !== undefined && replaced.status !== plan.status) {
    try { deps.emit?.({ kind: 'chat.plan_resolved', session_id: plan.session_id, turn_id: plan.turn_id, plan: replaced }); }
    catch { /* observability only */ }
  }
  for (const checkpoint of await deps.checkpointStore.listByRun(run_id).catch(() => [])) {
    await deps.checkpointStore.delete(checkpoint.checkpoint_id).catch(() => { /* retention collects it */ });
  }
  return 'withdrawn';
};

/** D-343 — after a day's record is held, the conversation's earlier record for the SAME day still
 *  waiting for the owner is replaced by it: there is always one record of a day to approve, the
 *  latest, however long the owner talks it over. (`onTier1Held`, after the new hold is raised.) */
export const createDayRecordReplacer = (deps: {
  readonly plans: Pick<planApproval.PlanApprovalStore, 'findByHoldRun' | 'listPending'>;
  readonly withdraw: (plan: ChatPlanProposal) => Promise<'withdrawn' | 'raced'>;
}) => async (call: { tool: string; args: Record<string, unknown>; run_id: string }): Promise<void> => {
  if (call.tool !== 'episode.record' || typeof call.args.day !== 'string') return;
  const held = await deps.plans.findByHoldRun?.(call.run_id);
  if (held === undefined) return;
  for (const earlier of await deps.plans.listPending(held.session_id)) {
    const args = earlier.args !== null && typeof earlier.args === 'object' ? earlier.args as Record<string, unknown> : undefined;
    if (earlier.tool !== 'episode.record' || earlier.hold === undefined || earlier.hold.run_id === call.run_id
      || earlier.status !== 'proposed' || args?.day !== call.args.day) continue;
    try { await deps.withdraw(earlier); }
    catch (error) { console.error(`[chat] replacing the earlier record of ${String(call.args.day)} failed`, error); }
  }
};

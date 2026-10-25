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
  isChatDispatchReason,
  isExecutionSource,
  isTier1ToolName,
  TIER1_TOOL_GUIDE,
  type ChatDispatchReason,
  type ChatMessage,
  type ChatPlanExecutionReceipt,
  type ChatPlanProposal,
  type Checkpoint,
  type ExecutionSource,
  type RecuedServerSignature,
} from '@recued/contracts';
import { PREFLIGHT_HANDLER_KIND, type planApproval } from '@recued/gateway';
import type { NotificationBlock } from '@recued/notification';
import type { CheckpointStore } from '@recued/storage';

import type { ChatBroadcastEmitter, ChatOrchestratorDeps } from './chat-orchestrator.js';
import { holdTier1Call, type RawOpDispatchDeps } from './raw-op-dispatch.js';
import { mailChatFollowUpText, mailChatRunOutcome } from './mail-chat-door/follow-ups.js';
import type { PreflightRunSettled } from './preflight-resumer.js';
import type { ChatStore } from './storage/chat-store.js';
import type { GatedActionStore } from './gated-action-store.js';

/** How long a settled write's reply waits for its turn's answer. */
export const HELD_WRITE_REPLY_WAIT_MS = 120_000;
const HELD_WRITE_REPLY_POLL_MS = 2_000;

/** One reply per proposal, so a settlement told twice writes once. */
export const heldWriteReplyId = (plan_id: string): string => `held-write:${plan_id}`;

/** What a hold that expired unanswered settles with (retention's `onRawOpExpired`). */
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

/** Codes a resume refuses with before anything ran, which are not dispatch reasons: the
 *  card says it was not done rather than that it may not have finished. */
const resumeRefusalReason = (code: unknown): ChatDispatchReason =>
  isChatDispatchReason(code) ? code : typeof code === 'string' ? 'channel_denied' : 'execution_error';

export interface HeldChatWritesDeps {
  readonly plans: Pick<
    planApproval.PlanApprovalStore,
    'resolve' | 'markConsumed' | 'recordExecution' | 'findByHoldRun' | 'answerMessageId' | 'lapseHold'
  >;
  readonly chatStore: Pick<ChatStore, 'appendMessage'>;
  readonly broadcast: ChatBroadcastEmitter;
  readonly signature: RecuedServerSignature;
  readonly now?: () => number;
  /** Test seam for the reply's wait. */
  readonly schedule?: (run: () => void, ms: number) => void;
}

export interface HeldChatWrites {
  /** Settle a run if it is a chat's held write. `true` when it was one, so the run is not
   *  also written as a tool call's result. */
  settle(settled: PreflightRunSettled): Promise<boolean>;
}

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

  const settle = async (settled: PreflightRunSettled): Promise<boolean> => {
    let plan: ChatPlanProposal | undefined;
    try {
      plan = await deps.plans.findByHoldRun?.(settled.run_id);
    } catch (error) {
      console.error(`[chat] held write lookup failed for run ${settled.run_id}`, error);
      return false;
    }
    if (plan === undefined) return false;
    const at = now();
    const title = isTier1ToolName(plan.tool) ? TIER1_TOOL_GUIDE[plan.tool].title : undefined;
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
      if (source !== undefined) replyOnceAnswered(plan, heldWriteExpiredText(title), source);
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
        const receipt: ChatPlanExecutionReceipt = outcome === 'succeeded'
          ? { status: 'completed', turn_id: plan.turn_id, result_ref: heldWriteReplyId(plan.plan_id), ...run }
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
      replyOnceAnswered(plan, mailChatFollowUpText(outcome, title, detail), source);
    }
    return true;
  };

  return { settle };
};

/** D-329 — the chat card's answer to its held write's ask, over the notification block,
 *  given as the owner's answer from the app (`via: 'ui'`) like the approval cards'. The ask
 *  is found by the hold's run on every call, never kept: a boot re-raise mints a new one.
 *  `expired` — no ask is out because the hold expired unanswered (`holdExpired`, read off
 *  the hold's receipt), and the card was never told. Any other missing ask is `no_ask`. */
export const createHeldPlanAskAnswerer = (
  block: Pick<NotificationBlock, 'listUnresolvedAsks' | 'submitAnswer'>,
  holdExpired?: (run_id: string) => Promise<boolean>,
) => async (
  run_id: string,
  option: 'approve' | 'deny',
): Promise<'answered' | 'closed' | 'ignored' | 'no_ask' | 'expired'> => {
  const ask = (await block.listUnresolvedAsks()).find((candidate) =>
    candidate.handler_kind === PREFLIGHT_HANDLER_KIND && candidate.handler_payload.run_id === run_id);
  if (ask === undefined) {
    return holdExpired !== undefined && await holdExpired(run_id) ? 'expired' : 'no_ask';
  }
  if (ask.status !== 'open') return 'closed';
  return block.submitAnswer({ ask_id: ask.ask_id, option, via: 'ui' });
};

/** D-329 — the chat gate's hold (`ChatOrchestratorDeps.holdTier1Write`): a Tier-1 write held
 *  as a write raw op is (its checkpoint, the receipt, the ask every approval channel shows),
 *  under the run id its proposal was stored with, and correlated to the proposal. Only "the
 *  approval substrate is not wired" means nothing was written. */
export const createHoldTier1Write = (
  getDeps: () => RawOpDispatchDeps | undefined,
): NonNullable<ChatOrchestratorDeps['holdTier1Write']> =>
  async ({ tool, args, plan_id, run_id, session_id, execution_source, contract_snapshot }) => {
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
    });
    return outcome.kind === 'held'
      ? { held: true }
      : { held: false, reason: outcome.kind === 'ask' ? 'approval_not_wired' : outcome.kind };
  };

/** D-329 — the chat's run-settled sink: a held write settles here, onto its card and its
 *  reply, and never also as a tool call's result row (it has no call row to pair with). */
export const settleChatRun = (
  heldWrites: HeldChatWrites,
  toolRowSink: (settled: PreflightRunSettled) => Promise<void>,
) => async (settled: PreflightRunSettled): Promise<void> => {
  if (await heldWrites.settle(settled)) return;
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

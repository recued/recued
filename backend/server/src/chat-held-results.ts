/** D-337 — an answered approval continues the conversation, as it does over MCP.
 *
 *  The owner: "it should be exactly like mcp, approval result reach model, because it continues
 *  the context and work in progress. and triggers the next action". An AI app reads a held call's
 *  outcome through `recued_actionStatus` and carries on; until this, a call held in the owner's
 *  own chat settled outside any turn, and the model only heard its state on the owner's next
 *  message, never its result (D-259: a late result stays outside model recall).
 *
 *  So when a call held in one of the owner's own conversations settles (it ran, the owner refused
 *  it, it failed, or its approval expired), a `held_result` turn is queued in that conversation's
 *  own order (D-265). The turn's row is Recued's record of the answer ("Approved: Add a calendar
 *  event"), stored as `system`, never as the owner's words; the model opens holding the call and
 *  its outcome as if it had just returned (`ChatTurnInput.held_results`), and the result reaches it
 *  through the turn's wire seam like any tool result.
 *
 *  The owner, again: "all channels should behave the same, if I ask from telegram/email to execute
 *  a job requires running recipe, I should get back the same result". So the app's chat, a
 *  messenger chat and an email chat all carry on, for a held write, a held recipe run and a held
 *  pack operation alike. A messenger or email chat keeps no tool-call rows, so a run held there
 *  is watched when it is held (`watchHeldRunsIn`), and found again when it settles
 *  (`createWatchedRunSettlement`). Spec: D-337. */
import {
  MAIL_CHAT_DOOR_VENDOR,
  truncateUtf8,
  type ChatDispatchReason,
  type ChatPriorToolCall,
  type ExecutionSource,
  type RecuedServerSignature,
  type ToolTier,
} from '@recued/contracts';
import { createHash } from 'node:crypto';
import type { ChatBroadcastEmitter, ChatTurnAck, ChatTurnInput } from './chat-orchestrator.js';
import { isNonTerminalToolResult } from './chat-tool-call-context.js';
import type { ChatTurnQueue } from './chat-turn-queue.js';
import type { QueuedChatCommand } from './storage/chat-turn-queue-store.js';
import { HELD_WRITE_EXPIRED_MESSAGE, heldWriteExpiredText } from './chat-held-writes.js';
import { conversationCarriesOn, isOwnMessengerSource } from './chat-carries-on.js';
import { mailChatFollowUpText, mailChatRunOutcome } from './mail-chat-door/follow-ups.js';
import type { PreflightRunSettled } from './preflight-resumer.js';
import { projectRunResultForAgent } from './run-result-agent-projection.js';
import type { ChatStore } from './storage/chat-store.js';
import type { HeldResultTurnStore, HeldRunWatch, HeldRunWatchStore } from './storage/chat-held-result-store.js';

export const HELD_RESULT_QUEUE_FAMILY = 'held_result';

/** A result larger than this reaches the model cut, with a note saying so: the queue keeps it,
 *  encrypted, until its turn runs, and the queue refuses a command over 1 MB. */
export const HELD_RESULT_MAX_RESULT_BYTES = 128 * 1024;

/** Approvals answered together carry the conversation on once. A continuation about to run
 *  waits until none other has been queued behind it for this long, and folds those in: Approve
 *  pressed on three cards in a row is one answer, not three. */
export const HELD_RESULT_GATHER_QUIET_MS = 1_500;
/** However many keep coming, it waits no longer than this. */
export const HELD_RESULT_GATHER_MAX_MS = 6_000;

/** A continuation interrupted (the server stopped in it), or one no model answered, is taken up
 *  again only this long after it was queued: past it, the work it was part of has moved on. */
export const HELD_RESULT_RECOVERY_WINDOW_MS = 7 * 86_400_000;
/** A conversation's next turn carries at most this many calls no model was told of. */
export const HELD_RESULT_CARRY_MAX = 5;
/** The first line of the record when an interrupted continuation runs again. */
export const HELD_RESULT_RESUMED_LINE = 'Carried on after Recued restarted:';
/** D-337 slice M — a continuation no model answered is tried again on its own after each of these
 *  waits, counted from the try before, until a model answers it: a model back within them carries
 *  the work on with no message from anyone. A try whose model fails again before it acts is quiet
 *  (`held_retry`). Past the last, the conversation's next turn carries the calls (§7.10). Slice N:
 *  a wait is kept on its turn's record, and a server started again picks it up where it was. */
export const HELD_RESULT_RETRY_AFTER_MS: readonly number[] = [2 * 60_000, 15 * 60_000, 2 * 3_600_000];
/** The first line of the record when a continuation no model answered is tried again and answered.
 *  ⚠ Model-facing too (the turn's message) — see `chat-prompt-optimization-log.md`. */
export const HELD_RESULT_RETRIED_LINE = 'Carried on after the AI could not answer:';

const strings = (value: unknown): string[] => (Array.isArray(value)
  ? value.filter((line): line is string => typeof line === 'string' && line.length > 0)
  : []);
const heldCalls = (command: QueuedChatCommand): unknown[] => (Array.isArray(command.input.held_results)
  ? command.input.held_results
  : []);

export type HeldResultOutcome = 'ran' | 'refused' | 'failed' | 'expired';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** One settled call, as the conversation it was held in continues with it. */
export interface HeldResultContinuation {
  readonly session_id: string;
  /** The turn that made the call: the continuation joins its lineage (D-214). */
  readonly turn_id?: string;
  readonly run_id: string;
  readonly tool_name: string;
  readonly tier: ToolTier;
  /** What the model sent, when it is known (a held write's plan keeps it). */
  readonly args?: unknown;
  readonly outcome: HeldResultOutcome;
  /** What the call returned: the result the model reads when it ran, the failure when not. */
  readonly result?: unknown;
  /** When the model made the call, and when it settled. */
  readonly called_at: number;
  readonly settled_at: number;
  /** The conversation's source. A Telegram or an email chat's continuation runs as that
   *  conversation, so what it holds next is asked of it; absent ⇒ the owner's app chat. */
  readonly source?: ExecutionSource;
  /** The action in the owner's words ("Add a calendar event"). */
  readonly title?: string;
}

export interface HeldResultContinuations {
  /** Queue the conversation's continuation for one settled call. `true` once it is queued, so
   *  the caller skips its fixed reply; `false` when it was not, and the reply stays. */
  continueWith(continuation: HeldResultContinuation): Promise<boolean>;
}

/** What became of a settled call, as its continuation tells it. A refusal and an expiry first:
 *  neither ran (an expiry settles as retention's `expiredHoldSettlement` words it, `expired:
 *  true`). Then the host's own word when it gave one, else the result's. */
export const heldResultOutcomeOf = (
  settled: Pick<PreflightRunSettled, 'result' | 'state'>,
): HeldResultOutcome => {
  const result = isRecord(settled.result) ? settled.result : {};
  if (result.denied === true) return 'refused';
  if (result.expired === true) return 'expired';
  const succeeded = settled.state !== undefined ? settled.state === 'succeeded' : result.success === true;
  return succeeded ? 'ran' : 'failed';
};

/** Recued's record of the answer, the continuation turn's row. */
export const heldResultRecord = (outcome: HeldResultOutcome, title: string | undefined): string => {
  const what = title ?? 'the action that waited for your approval';
  switch (outcome) {
    case 'ran': return `Approved: ${what}.`;
    case 'refused': return `You said no: ${what}.`;
    case 'failed': return `Approved, but it did not go through: ${what}.`;
    case 'expired': return `No one answered in time: ${what}.`;
  }
};

/** Cut a result that would not fit, saying so, rather than dropping it. */
const boundedResult = (result: unknown): unknown => {
  let text: string;
  try {
    text = JSON.stringify(result) ?? 'null';
  } catch {
    return { note: 'The result could not be read.' };
  }
  if (Buffer.byteLength(text) <= HELD_RESULT_MAX_RESULT_BYTES) return result;
  return {
    truncated: true,
    note: `The result was ${String(Buffer.byteLength(text))} bytes; this is its start.`,
    start: truncateUtf8(text, HELD_RESULT_MAX_RESULT_BYTES / 2),
  };
};

/** What the call returned, in the form a call that returned in its own turn takes
 *  (`priorToolCallEntry`): a tool's result, a held pack operation's, or a held run's. */
const returned = (
  result: unknown,
): { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly reason: ChatDispatchReason; readonly detail?: string } => {
  if (isRecord(result) && typeof result.ok === 'boolean') {
    if (result.ok) return { ok: true, result: result.result };
    return {
      ok: false,
      reason: typeof result.reason === 'string' ? result.reason as ChatDispatchReason : 'execution_error',
      ...(typeof result.detail === 'string' ? { detail: result.detail } : {}),
    };
  }
  if (isRecord(result) && result.kind === 'completed' && 'result' in result) {
    return { ok: true, result: result.result };
  }
  if (isRecord(result) && typeof result.success === 'boolean') {
    const projected = projectRunResultForAgent(result as unknown as Parameters<typeof projectRunResultForAgent>[0]);
    return result.success
      ? { ok: true, result: projected }
      : { ok: false, reason: 'execution_error', detail: JSON.stringify(projected).slice(0, 2000) };
  }
  return { ok: true, result };
};

/** What the model reads for a held call the owner said no to: it did not run.
 *  ⚠ Model-facing string — see `chat-prompt-optimization-log.md`. */
export const HELD_RESULT_REFUSED_DETAIL = 'The owner said no to it, so it did not run.';

/** The settled call as the model reads it among the turn's opening tool calls. */
export const heldResultCall = (continuation: HeldResultContinuation): ChatPriorToolCall => {
  const call = {
    tool_name: continuation.tool_name,
    tier: continuation.tier,
    args: continuation.args,
    started_at: continuation.called_at,
    completed_at: continuation.settled_at,
  };
  if (continuation.outcome === 'refused') {
    return { ...call, status: 'error', reason: 'plan_cancelled', detail: HELD_RESULT_REFUSED_DETAIL };
  }
  if (continuation.outcome === 'expired') {
    return { ...call, status: 'error', reason: 'plan_cancelled', detail: HELD_WRITE_EXPIRED_MESSAGE };
  }
  const outcome = returned(continuation.result);
  return outcome.ok
    ? { ...call, status: 'ok', result: boundedResult(outcome.result) }
    : {
        ...call,
        status: 'error',
        reason: outcome.reason,
        ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
      };
};

// Which conversations carry on is one rule, read by the held-call projections too.
export { isOwnMessengerSource } from './chat-carries-on.js';

/** Recued's own line for a settled call, as its fallback says it when no conversation carries on
 *  (the door's follow-up and D-329's reply). A continuation whose model does not answer gives the
 *  owner this instead: in a Telegram or an email chat, where Recued's record of the answer never
 *  goes, its failure would otherwise be all they heard. */
export const heldResultFallback = (continuation: HeldResultContinuation): string => {
  switch (continuation.outcome) {
    case 'ran': return mailChatFollowUpText('succeeded', continuation.title);
    case 'refused': return mailChatFollowUpText('denied', continuation.title);
    case 'expired': return heldWriteExpiredText(continuation.title);
    case 'failed': {
      const { detail } = mailChatRunOutcome({ result: continuation.result, state: 'failed' });
      return mailChatFollowUpText('failed', continuation.title, detail);
    }
  }
};

export const createHeldResultContinuations = (deps: {
  readonly queue: Pick<ChatTurnQueue, 'submit' | 'register' | 'routing'>
    & Partial<Pick<ChatTurnQueue, 'lastAdmitted' | 'fold' | 'commandOf' | 'whenRecovered'>>;
  readonly runTurn: (input: ChatTurnInput) => Promise<ChatTurnAck>;
  /** Each continuation's turn, recorded as it is admitted: the email door owes its answer, and
   *  writes no fixed follow-up for its run, through it. One folded into another is recorded so. */
  readonly turns?: Pick<HeldResultTurnStore, 'record'>
    & Partial<Pick<HeldResultTurnStore, 'fold' | 'answered' | 'acted' | 'interrupted' | 'refold' | 'unanswered' | 'untoldIn'
      | 'retryDue' | 'retriesDue'>>;
  /** Tell a messenger or email chat Recued's own lines, outside any turn: an interrupted
   *  continuation that is not run again (`createHeldRunReply`). */
  readonly note?: (note: {
    readonly session_id: string; readonly turn_id: string; readonly content: string; readonly source: ExecutionSource;
  }) => Promise<void>;
  /** How long a continuation waits for others answered with it. */
  readonly gather?: { readonly quiet_ms: number; readonly max_ms: number };
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** A continuation's turn has ended. The email door sends its answer then, as it does after its
   *  own turns: its idle look would take up to 15 s. */
  readonly afterTurn?: (ended: { readonly session_id: string; readonly source?: ExecutionSource }) => void;
  /** Run this after `ms` (a try again, `HELD_RESULT_RETRY_AFTER_MS`). An unref'd timer by default:
   *  the wait is kept on the turn's record (`retryDue`), and a server started again schedules it
   *  anew (`retriesDue`). `run` never rejects. */
  readonly later?: (run: () => Promise<void>, ms: number) => void;
}): HeldResultContinuations => {
  const gather = deps.gather ?? { quiet_ms: HELD_RESULT_GATHER_QUIET_MS, max_ms: HELD_RESULT_GATHER_MAX_MS };
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); }));
  const now = deps.now ?? Date.now;
  const later = deps.later ?? ((run: () => Promise<void>, ms: number) => { setTimeout(() => { void run(); }, ms).unref?.(); });
  /** The continuations queued right behind this one, once a moment has passed with none new. */
  const gatherBehind = async (turn: string, assertActive: () => void): Promise<QueuedChatCommand[]> => {
    const queue = deps.queue;
    if (queue.lastAdmitted === undefined || queue.fold === undefined) return [];
    const deadline = now() + gather.max_ms;
    for (;;) {
      const last = queue.lastAdmitted(turn, HELD_RESULT_QUEUE_FAMILY);
      const wait = Math.min(last === undefined ? 0 : last + gather.quiet_ms - now(), deadline - now());
      if (wait <= 0) break;
      await sleep(wait);
      assertActive();
    }
    return queue.fold(turn, HELD_RESULT_QUEUE_FAMILY, (taken) => {
      deps.turns?.fold?.(taken, turn);
      return undefined;
    });
  };
  /** D-337 slice M — submit a try again of `turn`, holding the calls of `group` (each record's
   *  command), as a quiet turn (`held_retry`), its `attempt + 1`-th. Its record, and the calls now
   *  its own, in its admission. `resumed`: a run again of a try the server stopped in (slice N). */
  const submitTry = async (
    turn: string,
    group: { readonly session_id: string; readonly run_id: string; readonly turns: readonly string[] },
    attempt: number,
    resumed = false,
  ): Promise<void> => {
    const turns = deps.turns;
    const queue = deps.queue;
    if (turns?.refold === undefined || queue.commandOf === undefined) return;
    const commands: QueuedChatCommand[] = [];
    for (const turn_id of group.turns) {
      const command = await queue.commandOf(turn_id).catch(() => undefined);
      if (command !== undefined && heldCalls(command).length > 0) commands.push(command);
    }
    if (commands.length === 0) return;
    const first = commands[0]!;
    const source = first.input.held_source;
    const origin = first.input.continuation_of_turn_id;
    await queue.submit({
      family: HELD_RESULT_QUEUE_FAMILY,
      session_id: group.session_id,
      message: [HELD_RESULT_RETRIED_LINE, ...commands.map((command) => command.message)].join('\n'),
      input: {
        held_results: commands.flatMap(heldCalls),
        // No lines of Recued's own: the owner had each call's the first time.
        held_retry: true,
        held_retry_attempt: attempt + 1,
        ...(resumed ? { held_retry_resumed: true } : {}),
        ...(typeof origin === 'string' && origin.length > 0 ? { continuation_of_turn_id: origin } : {}),
        ...(isOwnMessengerSource(source) ? { held_source: source } : {}),
      },
      comparison: { retry_of: turn },
    }, `held-result-retry:${turn}`, undefined, (turn_id) => {
      // ⛔ In the admission transaction: its record, and the calls it tries again now its own.
      turns.record({
        turn_id,
        session_id: group.session_id,
        run_id: group.run_id,
        ...(typeof origin === 'string' && origin.length > 0 ? { origin_turn_id: origin } : {}),
        retry_of: turn,
      });
      turns.refold!(turn, turn_id);
      return undefined;
    });
  };
  /** D-337 slice M — try a continuation no model answered again, holding every call it carried
   *  that is still untold, as a quiet turn (`held_retry`): its record is written only once its
   *  model answers or acts. Not when every call was told since (the conversation's next turn
   *  carried them), and not when it had begun acting: a step it took may have run. */
  const retryUnanswered = async (turn: string, attempt: number): Promise<void> => {
    const turns = deps.turns;
    if (turns?.unanswered === undefined) return;
    try {
      const group = turns.unanswered(turn);
      if (group === undefined || group.acted) return;
      await submitTry(turn, group, attempt);
    } catch (error) {
      console.warn(`[chat] the continuation ${turn} was not tried again`, error);
    }
  };
  /** D-337 slice N — the tries waiting in this process, by the turn each tries again: one wait a
   *  turn, however often the server's recovery looks (`restoreRetries`). */
  const waiting = new Set<string>();
  const schedule = (turn: string, attempt: number, ms: number): void => {
    if (waiting.has(turn)) return;
    waiting.add(turn);
    later(async () => {
      waiting.delete(turn);
      await retryUnanswered(turn, attempt);
    }, Math.max(0, ms));
  };
  /** After the wait for this try, if there is one left. Slice N: kept on the turn's record too. */
  const retryLater = (turn: string, attempt: number): void => {
    const wait = HELD_RESULT_RETRY_AFTER_MS[attempt];
    if (wait === undefined || deps.turns?.unanswered === undefined) return;
    try { deps.turns.retryDue?.(turn, attempt, now() + wait); } catch (error) {
      console.warn(`[chat] the wait to try continuation ${turn} again was not kept`, error);
    }
    schedule(turn, attempt, wait);
  };
  /** D-337 slice N — the tries that were waiting when the server stopped: each waits what is left
   *  of its wait, or runs at once when that is over. */
  const restoreRetries = (): void => {
    const turns = deps.turns;
    if (turns?.retriesDue === undefined || turns.unanswered === undefined) return;
    try {
      for (const due of turns.retriesDue(now() - HELD_RESULT_RECOVERY_WINDOW_MS)) {
        schedule(due.turn_id, due.attempt, due.due_at - now());
      }
    } catch (error) {
      console.warn('[chat] the tries waiting were not picked up', error);
    }
  };

  deps.queue.register(HELD_RESULT_QUEUE_FAMILY, async (command, turn, assertActive, complete) => {
    const own = command.input.held_results;
    if (!Array.isArray(own) || own.length === 0) throw new Error('A held result turn has no result.');
    // D-337 slice M — a try again whose calls were told meanwhile (the conversation's next turn
    // carried them while it waited in the queue) has nothing left to say.
    const retrying = command.input.held_retry === true;
    if (retrying && deps.turns?.untoldIn?.(turn) === false) return { turn_id: turn };
    const attempt = typeof command.input.held_retry_attempt === 'number' ? command.input.held_retry_attempt : 0;
    // A try again gathers none behind it: a continuation's first answer is never quiet.
    const folded = retrying ? [] : await gatherBehind(turn, assertActive);
    const held = [...own, ...folded.flatMap((next) => (Array.isArray(next.input.held_results) ? next.input.held_results : []))];
    const fallbacks = [command, ...folded].flatMap((next) => (Array.isArray(next.input.held_fallbacks)
      ? next.input.held_fallbacks.filter((line): line is string => typeof line === 'string' && line.length > 0)
      : []));
    const origin = command.input.continuation_of_turn_id;
    const source = command.input.held_source;
    let answered = false;
    try {
      const ack = await deps.runTurn({
        session_id: command.session_id,
        // Recued's record of each answer, one a line.
        message: [command.message, ...folded.map((next) => next.message)].join('\n'),
        picker_state: { current: 'self' },
        model_routing_snapshot: deps.queue.routing(command.session_id),
        held_results: held as ChatPriorToolCall[],
        ...(fallbacks.length > 0 ? { held_fallback: fallbacks.join('\n') } : {}),
        ...(retrying ? { held_retry: true as const } : {}),
        // Its next step may run from here: interrupted after this, it is not run again.
        held_acted: () => {
          try { deps.turns?.acted?.(turn); } catch (error) {
            console.warn(`[chat] continuation ${turn} acting was not recorded`, error);
          }
        },
        ...(isOwnMessengerSource(source) ? { held_source: source } : {}),
        ...(typeof origin === 'string' && origin.length > 0 ? { continuation_of_turn_id: origin } : {}),
        queue_turn_id: turn,
        assert_active: assertActive,
        complete_turn: complete,
      });
      // Told: the chat's next turns need not list these calls again (`chat-waited-calls-context.ts`).
      if (ack.answered === true) {
        answered = true;
        try { deps.turns?.answered?.(turn); } catch (error) {
          console.warn(`[chat] the answer of continuation ${turn} was not recorded`, error);
        }
      }
      return ack;
    } finally {
      try {
        deps.afterTurn?.({ session_id: command.session_id, ...(isOwnMessengerSource(source) ? { source } : {}) });
      } catch { /* the door's idle look still sends it */ }
      // D-337 slice M — no model answered it: tried again on its own, after a wait.
      if (!answered) retryLater(turn, attempt);
    }
  });

  /** D-337 §7.9 — the continuations the server stopped in. One that had not begun acting runs
   *  again, once, holding every call it carried (its answer was never given: `interrupted` takes
   *  only those). One that had begun, or was already a run again, is not: a step it took may have
   *  run, and a second run could take it twice. A messenger or email chat, where Recued's record
   *  never goes, is told what became of each call instead; the conversation's next turn carries
   *  them to the model (`createCarriedHeldResults`). */
  let recovering = false;
  const recoverInterrupted = async (): Promise<void> => {
    const turns = deps.turns;
    const queue = deps.queue;
    if (recovering || turns?.interrupted === undefined || turns.refold === undefined || queue.commandOf === undefined) return;
    recovering = true;
    try {
      for (const group of turns.interrupted(now() - HELD_RESULT_RECOVERY_WINDOW_MS)) {
        const commands: QueuedChatCommand[] = [];
        for (const turn_id of group.turns) {
          const command = await queue.commandOf(turn_id).catch(() => undefined);
          if (command !== undefined && heldCalls(command).length > 0) commands.push(command);
        }
        if (commands.length === 0) continue;
        const first = commands[0]!;
        const source = first.input.held_source;
        const fallbacks = commands.flatMap((command) => strings(command.input.held_fallbacks));
        if (group.acted || group.retried) {
          // D-337 slice N — a quiet try the server stopped in before it acted runs again once, as
          // that try: the owner had each call's outcome the first time, so nothing is told. One
          // that was itself such a run again is left to the conversation's next turn.
          const own = group.acted ? undefined : await queue.commandOf(group.turn_id).catch(() => undefined);
          if (own?.input.held_retry === true) {
            if (own.input.held_retry_resumed !== true) {
              const attempt = typeof own.input.held_retry_attempt === 'number' ? own.input.held_retry_attempt : 1;
              await submitTry(group.turn_id, group, attempt - 1, true).catch((error: unknown) => {
                console.warn(`[chat] the stopped try ${group.turn_id} was not run again`, error);
              });
            }
            continue;
          }
          if (isOwnMessengerSource(source) && fallbacks.length > 0) {
            await deps.note?.({ session_id: group.session_id, turn_id: group.turn_id, content: fallbacks.join('\n'), source })
              .catch(() => { /* told already: one note a continuation */ });
          }
          continue;
        }
        const origin = first.input.continuation_of_turn_id;
        await queue.submit({
          family: HELD_RESULT_QUEUE_FAMILY,
          session_id: group.session_id,
          message: [HELD_RESULT_RESUMED_LINE, ...commands.map((command) => command.message)].join('\n'),
          input: {
            held_results: commands.flatMap(heldCalls),
            held_fallbacks: fallbacks,
            ...(typeof origin === 'string' && origin.length > 0 ? { continuation_of_turn_id: origin } : {}),
            ...(isOwnMessengerSource(source) ? { held_source: source } : {}),
          },
          comparison: { retry_of: group.turn_id },
        }, `held-result-retry:${group.turn_id}`, undefined, (turn_id) => {
          // ⛔ In the admission transaction: its record, and the interrupted one's calls now its own.
          turns.record({
            turn_id,
            session_id: group.session_id,
            run_id: group.run_id,
            ...(typeof origin === 'string' && origin.length > 0 ? { origin_turn_id: origin } : {}),
            retry_of: group.turn_id,
          });
          turns.refold!(group.turn_id, turn_id);
          return undefined;
        }).catch((error: unknown) => {
          console.warn(`[chat] the interrupted continuation ${group.turn_id} was not run again`, error);
        });
      }
    } catch (error) {
      console.warn('[chat] interrupted continuations were not looked at', error);
    } finally {
      recovering = false;
    }
  };
  deps.queue.whenRecovered?.(() => {
    restoreRetries();
    void recoverInterrupted();
  });

  return {
    async continueWith(continuation) {
      // The owner's own conversations only: the app's chat (a scheduled one too), a messenger chat
      // or an email chat.
      const source = continuation.source;
      if (source !== undefined && !conversationCarriesOn(source)) return false;
      try {
        await deps.queue.submit({
          family: HELD_RESULT_QUEUE_FAMILY,
          session_id: continuation.session_id,
          message: heldResultRecord(continuation.outcome, continuation.title),
          input: {
            held_results: [heldResultCall(continuation)],
            // What the owner is told if the continuation's model does not answer.
            held_fallbacks: [heldResultFallback(continuation)],
            ...(continuation.turn_id !== undefined ? { continuation_of_turn_id: continuation.turn_id } : {}),
            ...(isOwnMessengerSource(continuation.source) ? { held_source: continuation.source } : {}),
          },
          // One continuation per settled call: a settlement told twice is one turn.
          comparison: { run_id: continuation.run_id },
        }, `held-result:${continuation.run_id}`, undefined, (turn_id) => {
          // ⛔ In the admission transaction: a turn admitted is a turn recorded, or neither.
          deps.turns?.record({
            turn_id,
            session_id: continuation.session_id,
            run_id: continuation.run_id,
            ...(continuation.turn_id !== undefined ? { origin_turn_id: continuation.turn_id } : {}),
          });
          return undefined;
        });
        return true;
      } catch (error) {
        console.warn(`[chat] continuing after run ${continuation.run_id} was not queued; its reply stands`, error);
        return false;
      }
    },
  };
};

/** What a conversation's next turn opens holding: the calls whose continuation no model answered
 *  (D-337 §7.10). */
export interface CarriedHeldResults {
  readonly calls: readonly ChatPriorToolCall[];
  readonly run_ids: ReadonlySet<string>;
  /** The model answered the turn that carried them: they are told. */
  told(): void;
}

/** D-337 §7.10 — a continuation its model did not answer (it failed, or was interrupted and not run
 *  again) left its calls untold. The conversation's next turn, whoever starts it, carries them in
 *  front of the model, as if they had just returned, so the work they were part of goes on there.
 *  The newest `HELD_RESULT_CARRY_MAX`, from the last `HELD_RESULT_RECOVERY_WINDOW_MS`. */
export const createCarriedHeldResults = (deps: {
  readonly turns: Pick<HeldResultTurnStore, 'untold' | 'told'>;
  readonly queue: Pick<ChatTurnQueue, 'commandOf'>;
  readonly now?: () => number;
}) => async (session_id: string): Promise<CarriedHeldResults | undefined> => {
  const now = deps.now ?? Date.now;
  const rows = deps.turns.untold(session_id, now() - HELD_RESULT_RECOVERY_WINDOW_MS, HELD_RESULT_CARRY_MAX);
  const calls: ChatPriorToolCall[] = [];
  const run_ids = new Set<string>();
  const own: string[] = [];
  // Oldest first, as they settled.
  for (const row of [...rows].reverse()) {
    const command = await deps.queue.commandOf(row.turn_id).catch(() => undefined);
    const held = command === undefined ? [] : heldCalls(command);
    if (held.length === 0) continue;
    calls.push(...(held as ChatPriorToolCall[]));
    run_ids.add(row.run_id);
    own.push(row.turn_id);
  }
  if (calls.length === 0) return undefined;
  return {
    calls,
    run_ids,
    told: () => {
      try { deps.turns.told(own); } catch (error) {
        console.warn(`[chat] calls carried in ${session_id} were not recorded as told`, error);
      }
    },
  };
};

/** Watch the runs held in the owner's own messenger and email chats (D-337): the orchestrator
 *  tells each held run where it was held, and only those conversations' are kept. The app's chat
 *  keeps its tool-call rows instead (`chat-run-settled-sink.ts`). */
export const watchHeldRunsIn = (store: Pick<HeldRunWatchStore, 'watch'>) => ({
  watch(watch: HeldRunWatch & { readonly source: ExecutionSource }): void {
    if (!isOwnMessengerSource(watch.source)) return;
    store.watch({
      run_id: watch.run_id,
      session_id: watch.session_id,
      turn_id: watch.turn_id,
      tool_name: watch.tool_name,
      called_at: watch.called_at,
    });
  },
});

/** A messenger chat's fixed reply when its conversation could not carry on: Recued's line, as a
 *  held write's is (`chat-held-writes.ts`), written in the turn that made the call so the chat's
 *  delivery sends it. One per run. */
export const createHeldRunReply = (deps: {
  readonly chatStore: Pick<ChatStore, 'appendMessage'>;
  readonly signature: RecuedServerSignature;
  readonly broadcast: ChatBroadcastEmitter;
  readonly now?: () => number;
}) => async (watch: HeldRunWatch, content: string, source: ExecutionSource): Promise<void> => {
  const written = await deps.chatStore.appendMessage({
    id: `held-run-reply:${createHash('sha256').update(watch.run_id).digest('hex').slice(0, 32)}`,
    session_id: watch.session_id,
    role: 'assistant',
    content,
    target_server: 'self',
    picker_at_send: { display_name: 'self', signature: deps.signature },
    model_used: { provider: 'recued', model_id: 'approval-follow-up' },
    execution_source: source,
    turn_id: watch.turn_id,
    ts: (deps.now ?? Date.now)(),
  });
  try {
    deps.broadcast.emit({ kind: 'chat.message_complete', session_id: watch.session_id, turn_id: watch.turn_id, final: written });
  } catch { /* observability only */ }
};

/** D-337 — a run held in the owner's messenger or email chat settles: that conversation carries
 *  on from it, as the app's chat does from a held call's row (`chat-run-settled-sink.ts`). `true`
 *  when it was a run watched there, so nothing else settles it.
 *
 *  When no continuation is queued, a messenger chat hears Recued's fixed line, as for a held
 *  write; an email chat's fixed follow-up is the email door's own (`follow-ups.ts`), so none is
 *  written here. */
export const createWatchedRunSettlement = (deps: {
  readonly watches: Pick<HeldRunWatchStore, 'get' | 'done'>;
  readonly continueWith: HeldResultContinuations['continueWith'];
  /** The run's recipe, as the owner knows it (`recipeToolTitle`). */
  readonly toolTitle?: (tool_name: string) => string | undefined;
  readonly reply?: (watch: HeldRunWatch, content: string, source: ExecutionSource) => Promise<void>;
}) => async (settled: PreflightRunSettled): Promise<boolean> => {
  // Held again (a second approval): it has not settled.
  if (isNonTerminalToolResult(settled.result)) return false;
  const source = settled.execution_source;
  if (!isOwnMessengerSource(source)) return false;
  let watch: HeldRunWatch | undefined;
  try {
    watch = deps.watches.get(settled.run_id);
  } catch (error) {
    console.warn(`[chat] the watch for run ${settled.run_id} could not be read`, error);
    return false;
  }
  if (watch === undefined) return false;
  const titleOf = (tool_name: string): string | undefined => {
    try { return deps.toolTitle?.(tool_name); } catch { return undefined; }
  };
  const title = titleOf(settled.tool_name) ?? titleOf(watch.tool_name);
  const outcome = heldResultOutcomeOf(settled);
  const continued = await deps.continueWith({
    source,
    session_id: watch.session_id,
    turn_id: watch.turn_id,
    run_id: settled.run_id,
    tool_name: watch.tool_name,
    tier: 2,
    outcome,
    ...(outcome === 'ran' || outcome === 'failed' ? { result: settled.result } : {}),
    ...(title !== undefined ? { title } : {}),
    called_at: watch.called_at,
    settled_at: settled.ts,
  }).catch(() => false);
  if (!continued && source.vendor !== MAIL_CHAT_DOOR_VENDOR && deps.reply !== undefined) {
    const { outcome: told, detail } = mailChatRunOutcome(settled);
    try {
      await deps.reply(watch, mailChatFollowUpText(told, title, detail), source);
    } catch (error) {
      console.warn(`[chat] the reply for run ${settled.run_id} was not written`, error);
    }
  }
  try { deps.watches.done(settled.run_id); } catch { /* pruned with its age */ }
  return true;
};

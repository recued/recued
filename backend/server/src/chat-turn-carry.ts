/** D-347 (2026-11-07) — a turn's results ride raw to the next turns until the context nears its limit.
 *  The owner: "closing brief only trigger at context window tail say such as 80%, so we have a turn
 *  brief which targeted to prevent exceeding context window, and closing brief at high threshold".
 *
 *  The closing fold ran after every turn that did tool work (`chat-turn-executor.ts`): 15 s median after
 *  the answer, up to 124 s over 112 measured runs, and the conversation's next message waited for it,
 *  since a turn ends when its message is stored. It existed to carry the turn's results to later
 *  turns: a turn opens with the brief, and the 3-row tail holds no tool results. Now the results
 *  themselves ride to the next turn, as prior calls after the brief (so after the system prompt and
 *  the catalog, whose cached prefix they leave alone), until the next turn's packet would reach
 *  {@link CLOSING_FOLD_SHARE} of the turn's input budget. Then the closing fold runs, as before, and
 *  the mid-turn fold still runs whenever a turn's own results near a KNOWN budget (inside a turn no window is
 *  assumed: 2026-11-20, browser task P).
 *
 *  ⛔ What never rides raw, and so still folds as before:
 *  - a recall's results (`memory.search`, `recall.search`): their content is bound to its own turn's
 *    `recall_context`, and outliving that turn is the cross-session bleed its guard exists to stop;
 *  - anything bearing a PII alias: the carry is durable, and after a restart the alias ledger is
 *    rebuilt, so `pii.Person1` could name someone else (the brief's own rule, `stripAliasBearing`);
 *  - a call whose outcome is still to come (held for the owner, a plan awaiting approval, not asked
 *    yet): its outcome reaches a later turn as a held call's does, and riding raw it would read as done
 *    (measured: a proposed send rode to the next turn, and the model answered "sent" without sending);
 *  - a write (a call the registry classifies `write`): the closing brief records a completed act at once
 *    (`completed`), the record that stopped a model doing an act again, and a turn that changed something
 *    keeps that as before;
 *  - a source read (`work.read`, `situation.query`, `document.read`, `document.search`): its result is a
 *    cited source the next turn re-validates against the source, through the brief's carry; riding raw
 *    it would present an earlier read as current;
 *  - the host's own notes (`context.brief`, `context.mail_work_evidence`), which are not results. */
import { partitionPriorToolCalls, type ChatPriorToolCall } from '@recued/contracts';
import { isNonTerminalToolResult } from './chat-tool-call-context.js';

/** The share of the turn's input budget the next packet may reach before the closing fold runs. */
export const CLOSING_FOLD_SHARE = 0.8;

/** With no window learned for the turn's model, the budget the threshold is taken against, in estimated
 *  tokens. A window is learned from an endpoint's first refusal for size (`resolveChatInputTokenBudget`),
 *  and until then every trim in chat is inert, so most servers have none. Slice C found the first cut
 *  (the carry alone capped at 24,000) folding every turn that read three pages, as before D-347. 80% of
 *  this is 102,400 estimated, about 51,000 real tokens at the 4 characters a token these packets measure;
 *  an endpoint smaller than that overflows inside a turn first, which teaches its window. ⚠ The carry's
 *  threshold only: inside a turn no window is assumed (`chat-turn-executor.ts`, 2026-11-20). */
export const UNLEARNED_BUDGET_TOKENS = 128_000;

/** Estimated tokens for a length of text: the same characters ÷ 2 the fold's arithmetic uses. */
export const estimatedTokens = (chars: number): number => Math.floor(chars / 2);

export interface NextPacket {
  readonly catalogTokens: number;
  readonly overheadTokens: number;
  readonly tailTokens: number;
  readonly briefTokens: number;
  readonly carried: readonly ChatPriorToolCall[];
}

/** The next turn's packet, opening with `carried`, in estimated tokens. */
export const nextPacketTokens = (packet: NextPacket): number => packet.catalogTokens + packet.overheadTokens
  + packet.tailTokens + packet.briefTokens + estimatedTokens(JSON.stringify(packet.carried).length);

/** The size at which the closing fold runs: {@link CLOSING_FOLD_SHARE} of the input budget, or of
 *  {@link UNLEARNED_BUDGET_TOKENS} when none is known. */
export const closingFoldLimit = (budgetTokens: number | undefined): number => CLOSING_FOLD_SHARE
  * (budgetTokens !== undefined && Number.isFinite(budgetTokens) ? budgetTokens : UNLEARNED_BUDGET_TOKENS);

/** Whether the next turn's packet would reach the closing limit, so the turn should close with a fold
 *  rather than a carry. */
export const closingFoldDue = (input: NextPacket & { readonly budgetTokens: number | undefined }): boolean =>
  nextPacketTokens(input) >= closingFoldLimit(input.budgetTokens);

/** The reads whose results are cited sources, re-validated against the source each turn: the tools an
 *  answer's sources are taken from (`answerSourceCitations`, `chat-source-citations.ts`). */
export const SOURCE_READ_TOOLS: ReadonlySet<string> = new Set(['work.read', 'situation.query', 'document.read', 'document.search']);

/** A call whose outcome is still to come: held, awaiting an approval or a peer, or not asked yet. */
export const isPendingCall = (call: ChatPriorToolCall): boolean =>
  call.reason === 'awaiting_approval' || (call.reason as string | undefined) === 'not_asked_yet'
  || isNonTerminalToolResult(call.result) || isNonTerminalToolResult({ result: call.result });

/** Why `calls` cannot ride raw, the first that holds: a recall's result, a write, a source read, a call
 *  still to come, a PII alias; `null` when they can. A host note is left out without counting against
 *  them. The turn's brief trail records it (`carry_refused:<reason>`). */
export type CarryRefusal = 'recall' | 'write' | 'source_read' | 'pending' | 'alias';
export const carryRefusal = (
  calls: readonly ChatPriorToolCall[],
  hasAlias: (text: string) => boolean,
  isWrite: (tool_name: string) => boolean = () => false,
): CarryRefusal | null => {
  const results = calls.filter((call) => !call.tool_name.startsWith('context.'));
  if (partitionPriorToolCalls(results).recall.length > 0) return 'recall';
  if (results.some((call) => isWrite(call.tool_name))) return 'write';
  if (results.some((call) => SOURCE_READ_TOOLS.has(call.tool_name))) return 'source_read';
  if (results.some(isPendingCall)) return 'pending';
  if (results.some((call) => hasAlias(JSON.stringify(call)))) return 'alias';
  return null;
};

/** Whether `calls` can ride raw ({@link carryRefusal} finds no reason they cannot). */
export const carryIsAllowed = (
  calls: readonly ChatPriorToolCall[],
  hasAlias: (text: string) => boolean,
  isWrite: (tool_name: string) => boolean = () => false,
): boolean => carryRefusal(calls, hasAlias, isWrite) === null;

/** The calls a carry holds: the turn's results, without the host's own notes. */
export const carriedResults = (calls: readonly ChatPriorToolCall[]): ChatPriorToolCall[] =>
  calls.filter((call) => !call.tool_name.startsWith('context.'));

const isPriorToolCall = (value: unknown): value is ChatPriorToolCall => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const call = value as Record<string, unknown>;
  return typeof call.tool_name === 'string' && !call.tool_name.startsWith('context.')
    && (call.status === 'ok' || call.status === 'error')
    && typeof call.started_at === 'number' && typeof call.completed_at === 'number'
    && (call.tier === 1 || call.tier === 2 || call.tier === 3);
};

/** A stored carry read back: its calls, or none when it does not read as a carry. ⚠ Unreadable reads as
 *  empty, as an unreadable brief reads as no brief: the turn then runs on the brief alone. */
export const parseStoredCarry = (raw: unknown): ChatPriorToolCall[] =>
  Array.isArray(raw) && raw.every(isPriorToolCall) ? raw : [];

/** D-137 P3 § A.11 — Plan-approval substrate.
 *
 *  Writes (any tool that modifies state — `mail.send`, `deal.update`,
 *  `calendar.create`, write-capable recipes) get the propose →
 *  confirm plan-approval pattern:
 *
 *    1. AI proposes a plan (tool name, instance, arguments) without
 *       executing.
 *    2. Plan rendered to Mary for confirmation (tool + description +
 *       target instance + resolved arguments + estimated effect).
 *    3. Mary confirms / edits / cancels.
 *    4. On confirm, the tool executes.
 *
 *  Why writes get this and reads don't: AI getting reads slightly
 *  wrong is annoying; AI sending email from the wrong account or
 *  updating the wrong deal is damaging. Asymmetric stakes warrant
 *  asymmetric friction.
 *
 *  This module ships the **substrate**:
 *
 *    - `requiresPlanApproval(entry)` — pure predicate over a
 *      `ToolEntry`'s classification + optional risk_tier. Tier 1
 *      reads always pass through; Tier 1 `'write'` classifications
 *      always gate; Tier 2 entries gate iff a write-class
 *      `risk_tier` (`'write'` / `'admin'` / `'destructive'`; recipe
 *      manifest convention from D-145 PB14 + D-148 vault gates);
 *      Tier 3 entries gate iff their `destructive_hint` is
 *      `true` OR Mary's per-tool classification is `'write'`.
 *    - `buildPlanProposal(args)` — pure constructor that mints a
 *      proposal record with stable id + audit envelope.
 *    - `PlanApprovalStore` — sync-or-async seam for the production durable
 *      store and narrow embeddings; `createPlanApprovalStore()` is the
 *      synchronous in-memory implementation used by tests.
 *
 *  The chat orchestrator's `dispatchTool` consults the store before
 *  dispatching writes (precedence order):
 *
 *    - SAME-TURN cancelled plan → return `plan_cancelled` without
 *      dispatching or re-proposing.
 *    - Consumable approval (`findApprovedForDispatch` hit) → atomic
 *      `consumeForDispatch` + proceed to dispatch.
 *    - Otherwise → mint a proposal (or re-emit the same turn's
 *      still-proposed one), persist, emit `chat.plan_proposed`,
 *      return `awaiting_approval`.
 *
 *  The rpc handlers (`chat.plan.approve` / `chat.plan.cancel`) flip
 *  the state and emit `chat.plan_resolved` so paired clients re-
 *  render. Resumption of the dispatch happens at the next user turn
 *  (the agent re-issues the tool call; the gate finds the approved
 *  plan + proceeds) — the user-driven re-issue path, deliberately
 *  NOT automatic resume: it's the substrate-minimal shape, keeps the
 *  orchestrator loop oblivious to plan state, and matches the
 *  re-run-over-resume flow philosophy.
 *
 *  Consumption semantics (the cross-turn closure): approval lands
 *  AFTER the proposing turn ends (the turn completed with
 *  `awaiting_approval`), so the re-issue necessarily carries a NEW
 *  turn_id. `findApprovedForDispatch` therefore matches approvals on
 *  `(session_id, tool, args_hash)` — turn-AGNOSTIC, args-hash-bound
 *  to exactly the reviewed payload — while `findLatest` keeps the
 *  4-tuple for the same-turn state machine (proposed re-emit
 *  coherence; cancelled terminality, which stays turn-scoped per the
 *  `plan_cancelled` contract: a later turn's re-issue after a cancel
 *  mints a fresh proposal). Three guards bound the widened match:
 *
 *    - SINGLE-USE — the gate stamps `consumed_at` at the dispatch
 *      decision (before the dispatch runs: a failed dispatch spends
 *      the approval too — the retry re-proposes loudly rather than
 *      silently re-running on a stale grant). One approve = one
 *      execution; an approval is never a standing grant.
 *    - TTL — consumable within `PLAN_APPROVAL_CONSUMPTION_TTL_MS`
 *      of `resolved_at`. Bounds the window where an old approval
 *      can fire without a fresh card.
 *    - args_hash — unchanged from the Codex P3 fold; different args
 *      never inherit an approval.
 *
 *  Each row carries `created_at` / `resolved_at` / `consumed_at` so callers
 *  can age-out abandoned plans without re-scanning every pending row. */

import { createHash } from 'node:crypto';
import type {
  ChatPlanExecutionReceipt,
  ChatPlanProposal,
  ChatPlanRecord,
  ChatPlanStatus,
  ToolEntry,
} from '@recued/contracts';

/** § A.11 — stable content hash of dispatch args. SHA-256 over a
 *  canonical-key JSON serialisation; first 16 hex chars (96-bit
 *  collision space — comfortable for per-turn dispatch counts).
 *  Pure; same args ⇒ same hash regardless of property insertion
 *  order. Codex P3 review P1 fold #2 — load-bearing for the
 *  approval-binding security invariant. */
export const computePlanArgsHash = (args: unknown): string => {
  const canonical = canonicalJsonStringify(args);
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
};

/** Canonical JSON: object keys sorted; arrays preserve order;
 *  numbers / strings / booleans / null serialised verbatim;
 *  undefined elided (matches `JSON.stringify` semantics for object
 *  values). Functions / symbols / etc. coerce to `null` so the
 *  hash never depends on non-serialisable shapes. */
const canonicalJsonStringify = (value: unknown): string => {
  if (value === null) return 'null';
  if (value === undefined) return 'null';
  const t = typeof value;
  if (t === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  }
  if (t === 'string' || t === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJsonStringify(v)).join(',')}]`;
  }
  if (t === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJsonStringify(v)}`)
      .join(',')}}`;
  }
  return 'null';
};

/** § A.11 — how long an approval stays consumable after Mary grants
 *  it (`resolved_at` + TTL). The flow this bounds: approve the card →
 *  type the follow-up message that makes the agent re-issue the tool
 *  — seconds to minutes. 15 minutes is generous for that while
 *  keeping the exposure short: past the TTL the approval is inert
 *  and the re-issue proposes a fresh card. Defense-in-depth on top
 *  of single-use + args_hash binding, not the primary guard. */
export const PLAN_APPROVAL_CONSUMPTION_TTL_MS = 15 * 60 * 1000;

/** § A.11 — risk tiers that count as "write-class" for plan-approval
 *  gating. Lockstep with the canonical `RiskTier` taxonomy in
 *  `packages/contracts/src/ingredient.ts`. The `'read'` tier is the
 *  only non-gated value; everything else writes (or worse) and pauses
 *  behind the approval card.
 *
 *  Codex P3 review P2 fold — the prior predicate keyed on
 *  `risk_tier === 'review'` (a literal that doesn't exist in the
 *  recipe / ingredient taxonomy), so any unknown-classified Tier 2
 *  recipe with a real write tier (`'write'` / `'admin'` /
 *  `'destructive'`) silently bypassed the gate once the store was
 *  wired. The closed list below mirrors the actual taxonomy and is
 *  the single source of truth for the gate-decision. */
export const PLAN_APPROVAL_WRITE_RISK_TIERS: ReadonlySet<string> = new Set([
  'write',
  'admin',
  'destructive',
]);

/** § A.11 — pure predicate. Returns `true` iff dispatching the tool
 *  with the given args MUST route through plan-approval before
 *  executing. The orchestrator's `dispatchTool` calls this BEFORE
 *  handler invocation.
 *
 *  Ladder:
 *
 *    - `classification: 'read'` → always false (reads never gate).
 *    - `classification: 'write'` → always true.
 *    - `classification: 'unknown'` → true iff the entry carries a
 *      write-class `risk_tier` (`'write'` / `'admin'` /
 *      `'destructive'`) OR a Tier 3 `destructive_hint: true`. This
 *      is the `recipe.run` + Tier 3 passthrough path: `recipe.run`
 *      is `'unknown'` at the registry level because the underlying
 *      recipe may be either; the registry's Tier 2 projection
 *      surfaces the resolved recipe's `risk_tier` here so the gate
 *      gets the real signal.
 *
 *  Pure; no I/O, no clock. */
export const requiresPlanApproval = (entry: ToolEntry): boolean => {
  if (entry.classification === 'read') return false;
  if (entry.classification === 'write') return true;
  // 'unknown' — gate iff the entry carries a write-shaped hint.
  if (
    typeof entry.risk_tier === 'string'
    && PLAN_APPROVAL_WRITE_RISK_TIERS.has(entry.risk_tier)
  ) {
    return true;
  }
  if (entry.destructive_hint === true) return true;
  return false;
};

/** § A.11 — pure constructor. Builds the canonical proposal record
 *  from dispatch context. Caller threads in the mint + clock so
 *  tests stay deterministic. */
export interface BuildPlanProposalArgs {
  session_id: string;
  turn_id: string;
  /** Optional lineage for a user-sent verify-before-retry turn. */
  retry_of_plan_id?: string;
  tool: string;
  tier: 1 | 2 | 3;
  classification: 'read' | 'write' | 'unknown';
  args: unknown;
  /** Optional target-instance hint (multi-instance scope per § A.11
   *  "Picker integration"). Single-instance scopes leave undefined;
   *  the renderer defaults the instance silently. */
  target_instance?: string;
  mintId: () => string;
  now: () => number;
}

export const buildPlanProposal = (
  args: BuildPlanProposalArgs,
): ChatPlanProposal => ({
  plan_id: args.mintId(),
  session_id: args.session_id,
  turn_id: args.turn_id,
  ...(args.retry_of_plan_id !== undefined
    ? { retry_of_plan_id: args.retry_of_plan_id }
    : {}),
  tool: args.tool,
  tier: args.tier,
  classification: args.classification,
  args: args.args,
  args_hash: computePlanArgsHash(args.args),
  ...(args.target_instance !== undefined
    ? { target_instance: args.target_instance }
    : {}),
  status: 'proposed',
  created_at: args.now(),
});

/** § A.11 — storage seam shared by the chat orchestrator, approval RPCs, and
 * session snapshot recovery. Production implements it over SQLite; the
 * default factory below remains a synchronous in-memory test implementation. */
export type MaybePromise<T> = T | Promise<T>;

export interface PlanApprovalStore {
  /** Lookup by `plan_id`. Returns the current state OR undefined. */
  get(plan_id: string): MaybePromise<ChatPlanProposal | undefined>;
  /** List every pending plan for a session. Used by the renderer to
   *  paint the per-session "you have N writes awaiting approval"
   *  banner. Ordered by `created_at` ascending. */
  listPending(
    session_id: string,
  ): MaybePromise<ReadonlyArray<ChatPlanProposal>>;
  /** Durable approval-inbox snapshot across every Chat session. Optional for
   * narrow stores; production and the default store provide it. Pending rows
   * with unavailable reviewed payloads remain as non-executable records. */
  listPendingRecords?(): MaybePromise<ReadonlyArray<ChatPlanRecord>>;
  /** Look up the latest plan for `(session_id, turn_id, tool,
   *  args_hash)` — the SAME-TURN state machine: proposed re-emit
   *  coherence + cancelled terminality (both deliberately
   *  turn-scoped; cross-turn approval consumption goes through
   *  `findApprovedForDispatch`). Codex P3 review P1 fold #2: the
   *  4-tuple binds the lookup to the *exact* args Mary reviewed,
   *  not just the (session, turn, tool) tuple. Without `args_hash`
   *  matching, an approval for `mail.send({ to: alice })` could
   *  authorize `mail.send({ to: attacker })` in the same turn.
   *  Returns undefined when no matching plan exists for the given
   *  args hash. */
  findLatest(
    session_id: string,
    turn_id: string,
    tool: string,
    args_hash: string,
  ): MaybePromise<ChatPlanProposal | undefined>;
  /** § A.11 cross-turn consumption lookup — the latest plan that is
   *  `'approved'`, NOT yet consumed, and approved within
   *  `PLAN_APPROVAL_CONSUMPTION_TTL_MS` of `now`, matched on
   *  `(session_id, tool, args_hash)` — turn-AGNOSTIC, because the
   *  approval necessarily lands after the proposing turn ended and
   *  the re-issue carries a new turn_id. "Latest" = greatest
   *  `resolved_at` (most recent approval intent). The caller MUST
   *  pair a hit with atomic `consumeForDispatch` at the dispatch decision —
   *  matching alone does not spend the approval. */
  findApprovedForDispatch(
    session_id: string,
    tool: string,
    args_hash: string,
    now: number,
  ): MaybePromise<ChatPlanProposal | undefined>;
  /** Stamp `consumed_at` on an approved plan — the single-use spend.
   *  Returns the updated record; undefined when the plan is missing
   *  or not `'approved'`. Idempotent: an already-consumed plan keeps
   *  its original stamp (first spend wins). */
  markConsumed(
    plan_id: string,
    consumed_at: number,
    execution_turn_id?: string,
  ): MaybePromise<ChatPlanProposal | undefined>;
  /** Atomic dispatch spend. Unlike idempotent `markConsumed`, returns
   * undefined when another caller already consumed the approval or it expired
   * before this exact spend. Production uses this to prevent two concurrent
   * dispatchers from sharing one grant. */
  consumeForDispatch(
    plan_id: string,
    consumed_at: number,
    execution_turn_id: string,
  ): MaybePromise<ChatPlanProposal | undefined>;
  /** Persist a proposed plan. An existing `plan_id` remains unchanged so an
   * id collision cannot replace already-reviewed arguments. */
  put(plan: ChatPlanProposal): MaybePromise<void>;
  /** Flip status to `approved` / `cancelled`. Returns the updated
   *  record OR `undefined` when no such plan exists. Subsequent
   *  status flips on a resolved plan are no-ops (resolved plans are
   *  terminal). */
  resolve(
    plan_id: string,
    status: 'approved' | 'cancelled',
    resolved_at: number,
  ): MaybePromise<ChatPlanProposal | undefined>;
  /** Durable recovery list for `chat.session.get`. Optional for narrow test
   * stores; production provides it. */
  listForSession?(
    session_id: string,
  ): MaybePromise<ReadonlyArray<ChatPlanRecord>>;
  /** Link every plan proposed by a completed turn to its assistant message. */
  linkTurnToMessage?(
    session_id: string,
    turn_id: string,
    message_id: string,
  ): MaybePromise<void>;
  /** Persist the post-consumption execution truth before broadcasting it.
   * Implementations must refuse unknown/unconsumed plan ids and must not
   * regress a terminal receipt to `running` or change the execution turn
   * established by the atomic spend. */
  recordExecution?(
    plan_id: string,
    execution: ChatPlanExecutionReceipt,
  ): MaybePromise<ChatPlanExecutionReceipt | undefined>;
}

/** Concrete default store stays synchronous for unit tests and lightweight
 * embeddings. Production wires the SQLite-backed implementation. */
export interface SynchronousPlanApprovalStore extends PlanApprovalStore {
  get(plan_id: string): ChatPlanProposal | undefined;
  listPending(session_id: string): ReadonlyArray<ChatPlanProposal>;
  listPendingRecords(): ReadonlyArray<ChatPlanRecord>;
  findLatest(
    session_id: string,
    turn_id: string,
    tool: string,
    args_hash: string,
  ): ChatPlanProposal | undefined;
  findApprovedForDispatch(
    session_id: string,
    tool: string,
    args_hash: string,
    now: number,
  ): ChatPlanProposal | undefined;
  markConsumed(
    plan_id: string,
    consumed_at: number,
    execution_turn_id?: string,
  ): ChatPlanProposal | undefined;
  consumeForDispatch(
    plan_id: string,
    consumed_at: number,
    execution_turn_id: string,
  ): ChatPlanProposal | undefined;
  put(plan: ChatPlanProposal): void;
  resolve(
    plan_id: string,
    status: 'approved' | 'cancelled',
    resolved_at: number,
  ): ChatPlanProposal | undefined;
  listForSession(session_id: string): ReadonlyArray<ChatPlanRecord>;
  linkTurnToMessage(
    session_id: string,
    turn_id: string,
    message_id: string,
  ): void;
  recordExecution(
    plan_id: string,
    execution: ChatPlanExecutionReceipt,
  ): ChatPlanExecutionReceipt | undefined;
}

/** § A.11 — default in-memory store factory. */
export const createPlanApprovalStore = (): SynchronousPlanApprovalStore => {
  const byPlanId = new Map<string, ChatPlanProposal>();
  const messageIdByPlanId = new Map<string, string>();
  const executionByPlanId = new Map<string, ChatPlanExecutionReceipt>();

  const get = (plan_id: string): ChatPlanProposal | undefined =>
    byPlanId.get(plan_id);

  const listPending = (session_id: string): ReadonlyArray<ChatPlanProposal> => {
    const out: ChatPlanProposal[] = [];
    for (const plan of byPlanId.values()) {
      if (plan.session_id !== session_id) continue;
      if (plan.status !== 'proposed') continue;
      out.push(plan);
    }
    out.sort((a, b) => a.created_at - b.created_at);
    return out;
  };

  const findLatest = (
    session_id: string,
    turn_id: string,
    tool: string,
    args_hash: string,
  ): ChatPlanProposal | undefined => {
    let latest: ChatPlanProposal | undefined;
    for (const plan of byPlanId.values()) {
      if (plan.session_id !== session_id) continue;
      if (plan.turn_id !== turn_id) continue;
      if (plan.tool !== tool) continue;
      // Codex P3 review P1 fold #2 — load-bearing: only return a
      // plan whose args_hash matches the current dispatch. A
      // dispatch with different args mints a fresh proposal even
      // when an approved plan exists for the same (session, turn,
      // tool) tuple.
      if (plan.args_hash !== args_hash) continue;
      // `>=` so a created_at tie prefers the LATER-inserted row.
      // Same-tuple multi-row became possible with single-use
      // consumption (a spent approval + the fresh re-proposal can
      // share a fixed-clock timestamp); "latest" must mean the
      // fresh one.
      if (!latest || plan.created_at >= latest.created_at) {
        latest = plan;
      }
    }
    return latest;
  };

  const findApprovedForDispatch = (
    session_id: string,
    tool: string,
    args_hash: string,
    now: number,
  ): ChatPlanProposal | undefined => {
    let latest: ChatPlanProposal | undefined;
    for (const plan of byPlanId.values()) {
      if (plan.session_id !== session_id) continue;
      if (plan.tool !== tool) continue;
      if (plan.args_hash !== args_hash) continue;
      if (plan.status !== 'approved') continue;
      if (plan.consumed_at !== undefined) continue;
      // TTL gates on approval freshness (`resolved_at` = the approve
      // instant). A hand-seeded approved row without `resolved_at`
      // falls back to `created_at` rather than being silently
      // unmatchable; a negative age (caller clock behind the approve
      // stamp) passes — only genuinely stale approvals drop.
      const approvedAt = plan.resolved_at ?? plan.created_at;
      if (now - approvedAt > PLAN_APPROVAL_CONSUMPTION_TTL_MS) continue;
      // `>=` mirrors findLatest — an approvedAt tie prefers the
      // later-inserted row (most recent approval intent).
      if (!latest || approvedAt >= (latest.resolved_at ?? latest.created_at)) {
        latest = plan;
      }
    }
    return latest;
  };

  const markConsumed = (
    plan_id: string,
    consumed_at: number,
    execution_turn_id?: string,
  ): ChatPlanProposal | undefined => {
    const existing = byPlanId.get(plan_id);
    if (!existing) return undefined;
    if (existing.status !== 'approved') return undefined;
    // First spend wins — an already-consumed plan keeps its stamp.
    if (existing.consumed_at !== undefined) return existing;
    const next: ChatPlanProposal = { ...existing, consumed_at };
    byPlanId.set(plan_id, next);
    if (execution_turn_id !== undefined) {
      executionByPlanId.set(plan_id, {
        status: 'running',
        turn_id: execution_turn_id,
      });
    }
    return next;
  };

  const put = (plan: ChatPlanProposal): void => {
    if (byPlanId.has(plan.plan_id)) return;
    if (plan.retry_of_plan_id !== undefined) {
      const origin = byPlanId.get(plan.retry_of_plan_id);
      const execution = executionByPlanId.get(plan.retry_of_plan_id);
      const retryableFailure =
        execution?.status === 'failed'
        && execution.reason !== 'run_cancelled';
      if (
        origin === undefined
        || origin.session_id !== plan.session_id
        || origin.status !== 'approved'
        || origin.consumed_at === undefined
        || (execution?.status !== 'unknown' && !retryableFailure)
      ) {
        throw new Error(
          `plan-approval: invalid retry origin ${plan.retry_of_plan_id}`,
        );
      }
    }
    byPlanId.set(plan.plan_id, plan);
  };

  const consumeForDispatch = (
    plan_id: string,
    consumed_at: number,
    execution_turn_id: string,
  ): ChatPlanProposal | undefined => {
    const existing = byPlanId.get(plan_id);
    if (!existing || existing.status !== 'approved') return undefined;
    if (existing.consumed_at !== undefined) return undefined;
    const approvedAt = existing.resolved_at ?? existing.created_at;
    if (
      consumed_at - approvedAt > PLAN_APPROVAL_CONSUMPTION_TTL_MS
    ) return undefined;
    return markConsumed(plan_id, consumed_at, execution_turn_id);
  };

  const resolve = (
    plan_id: string,
    status: 'approved' | 'cancelled',
    resolved_at: number,
  ): ChatPlanProposal | undefined => {
    const existing = byPlanId.get(plan_id);
    if (!existing) return undefined;
    // Terminal-status guard — resolved plans don't flip.
    if (existing.status !== 'proposed') return existing;
    const next: ChatPlanProposal = {
      ...existing,
      status: status as ChatPlanStatus,
      resolved_at,
    };
    byPlanId.set(plan_id, next);
    return next;
  };

  const listForSession = (
    session_id: string,
  ): ReadonlyArray<ChatPlanRecord> =>
    Array.from(byPlanId.values())
      .filter((plan) => plan.session_id === session_id)
      .sort((left, right) => left.created_at - right.created_at)
      .map((plan) => ({
        plan,
        ...(messageIdByPlanId.has(plan.plan_id)
          ? { message_id: messageIdByPlanId.get(plan.plan_id)! }
          : {}),
        ...(executionByPlanId.has(plan.plan_id)
          ? { execution: executionByPlanId.get(plan.plan_id)! }
          : {}),
        payload_available: true,
      }));

  const listPendingRecords = (): ReadonlyArray<ChatPlanRecord> =>
    Array.from(byPlanId.values())
      .filter((plan) => plan.status === 'proposed')
      .sort((left, right) =>
        left.created_at !== right.created_at
          ? left.created_at - right.created_at
          : left.plan_id.localeCompare(right.plan_id),
      )
      .map((plan) => ({
        plan,
        ...(messageIdByPlanId.has(plan.plan_id)
          ? { message_id: messageIdByPlanId.get(plan.plan_id)! }
          : {}),
        payload_available: true,
      }));

  const linkTurnToMessage = (
    session_id: string,
    turn_id: string,
    message_id: string,
  ): void => {
    for (const plan of byPlanId.values()) {
      if (plan.session_id === session_id && plan.turn_id === turn_id) {
        messageIdByPlanId.set(plan.plan_id, message_id);
      }
    }
  };

  const recordExecution = (
    plan_id: string,
    execution: ChatPlanExecutionReceipt,
  ): ChatPlanExecutionReceipt | undefined => {
    const plan = byPlanId.get(plan_id);
    if (plan?.consumed_at === undefined) return undefined;
    const current = executionByPlanId.get(plan_id);
    if (
      current !== undefined
      && current.turn_id !== execution.turn_id
    ) return undefined;
    if (
      current !== undefined
      && current.status !== 'running'
    ) return current;
    executionByPlanId.set(plan_id, execution);
    return execution;
  };

  return {
    get,
    listPending,
    findLatest,
    findApprovedForDispatch,
    markConsumed,
    consumeForDispatch,
    put,
    resolve,
    listPendingRecords,
    listForSession,
    linkTurnToMessage,
    recordExecution,
  };
};

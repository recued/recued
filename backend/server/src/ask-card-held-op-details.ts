/** D-270 — the approval CARD's read of one held op's resolved arguments.
 *
 *  The sibling of `createAskLandingDetailResolver`, and it exists because that
 *  one is fenced for a threat this surface does not have.
 *
 *  ⛔⛔ WHY A SIBLING AND NOT A FLAG ON THE ORIGINAL. `findReceptionHoldItem`
 *  returns null for a NON-RECEPTION hold — *"the fence that keeps an AI agent's
 *  held MCP write off a URL-bearer page."* That is exactly right for `/ask`,
 *  whose whole credential is an unguessable URL. The card is a PAIRED client
 *  with a real identity, so the threat does not exist there — and inheriting the
 *  fence anyway would render details for reception holds and **nothing at all
 *  for an agent's held write**, which is the approval an owner most needs the
 *  values of. The richest surface would show least, for a reason that does not
 *  apply to it.
 *
 *  ⛔ Relaxing the existing function with a boolean was the wrong shape: it
 *  would widen the URL-bearer page along with the card the first time someone
 *  passed the flag from the wrong composition. Two functions put the difference
 *  in threat model at the call site, where it is read.
 *
 *  🔑🔑 AND THE REAL FENCE IS NOT THE ORIGIN — IT IS THE ALLOWLIST. Only the
 *  operation's pack-declared `editable_args` keys (D-170 N.7, resolved through
 *  the SAME `resolveArgEditSchema` seam the reception path uses) are ever
 *  projected. The raw held args are never enumerated, which matters because a
 *  checkpoint retains its call's args UN-REDACTED by design and a
 *  `RawOpCheckpoint`'s `op_args` are frozen AS DISPATCHED. ⇒ a value reaches
 *  this card only because a pack author declared that field reviewable, and that
 *  declaration is the thing that was reviewed.
 *
 *  ⛔ READ-ONLY, AND `editable` IS NEVER PASSED. The card has no submit path for
 *  edits (owner ruling 2026-09-13: the link owns editing), and the landing
 *  resolver's own warning says why a control the submit path cannot honour is
 *  the worst of both — *"the owner retimes the slot, approves, and the original
 *  value lands."*
 *
 *  Spec: D-270. */

import { PREFLIGHT_HANDLER_KIND } from '@recued/gateway';
import type { ArgEditSchema, Checkpoint, ServerPendingAskDetail } from '@recued/contracts';
import type { AuditEntry } from '@recued/storage';
import type { PendingAsk } from '@recued/notification';

import { buildAskLandingDetails } from './ask-landing-held-op-details.js';
import { defaultReviewDetails } from './ask-card-default-details.js';
import { holdCoversSeveralItems } from './foreach-approval-items.js';
// ⛔ THE OPERATION ID IS IMPORTED, NOT RE-DERIVED. It selects the
// `editable_args` allowlist, so a second copy drifting would have the card and
// the `/ask` page resolving different allowlists for the same hold.
import { heldOperationId } from './reception-inbox-handler.js';

export interface AskCardDetailResolverDeps {
  /** Held checkpoint by id (= `PendingAsk.handler_payload.checkpoint_id`). */
  readonly getCheckpoint: (checkpoint_id: string) => Promise<Checkpoint | null>;
  /** The run anchor, for the `awaiting_approval` gate and the operation id. */
  readonly getAnchor: (run_id: string) => Promise<AuditEntry | null>;
  /** SHARED SEAM (N.6) — the operation's editable-args allowlist. The SAME
   *  resolver the reception path binds, deliberately: the allowlist is the
   *  fence, so a second implementation of it would be a second fence. */
  readonly resolveArgEditSchema: (
    operation_id: string,
    prefilled_args: Record<string, unknown>,
  ) => ArgEditSchema;
  /** LIVE member count for a batch-registered ask. ⛔ Read at RESOLVE time,
   *  never stamped: an `open` batch ACCUMULATES members, so a count captured
   *  earlier goes stale in the one direction that matters. Absent ⇒ every
   *  batched ask resolves to null, which is the fail-closed floor. */
  readonly getBatch?: (
    batch_id: string,
  ) => Promise<{ readonly members: readonly unknown[] } | null>;
  /** IANA zone every `datetime` row renders in and NAMES. */
  readonly timeZone?: string;
  /** The installed action's `request_schema`, for the rows of an action whose
   *  pack declares no reviewable fields (`ask-card-default-details.ts`). Absent
   *  ⇒ such an action shows no block, the behaviour before the default. */
  readonly lookupRequestSchema?: (operation_id: string) => unknown;
}

const resolveDefaultTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

/** The held call's current arguments, covering BOTH checkpoint shapes.
 *
 *  ⚠ The reception resolver reads only the recipe-step shape and says why — a
 *  raw-op door checkpoint *"never reaches here"*. This resolver is reached by
 *  exactly the holds that one refuses, so it must read both or the agent case
 *  it exists for resolves to `{}` and renders nothing.
 *
 *  `arg_overrides` last: a hold the owner already edited through the link
 *  carries its edits there, and the card must show what will ACTUALLY run
 *  rather than what was originally proposed. */
const heldArgs = (checkpoint: Checkpoint): Record<string, unknown> => {
  const raw = (checkpoint as { raw_op?: { op_args?: unknown } }).raw_op;
  const base = raw?.op_args !== undefined
    ? asRecord(raw.op_args)
    : asRecord(
      (() => {
        const id = checkpoint.gated_step_id;
        if (id === undefined) return undefined;
        const step = asRecord(checkpoint.step_state?.[id]);
        return step.input ?? step.args;
      })(),
    );
  const overrides = asRecord(
    (checkpoint as { arg_overrides?: unknown }).arg_overrides,
  );
  return Object.keys(overrides).length > 0 ? { ...base, ...overrides } : base;
};

/** Build the card's `resolveDetails` closure.
 *
 *  Returns null — **no block, and the card renders exactly as it did before** —
 *  for every ask whose rows cannot be honestly resolved. Each null is a distinct
 *  fact, and none of them earns copy (owner ruling: *"it should just default as
 *  normal ask because that's honestly out of current capacity"*):
 *
 *    - not a `gateway.preflight` ask — it holds no operation at all;
 *    - a MULTI-MEMBER batched ask — one `checkpoint_id` covers N members, so
 *      rendering "the" args would show one member's values as though they were
 *      the whole approval. The prose already enumerates a batch's items;
 *    - a held `foreach` step with items still to come — the same thing inside
 *      one checkpoint: its approval covers them all, and the prose lists them;
 *    - no `checkpoint_id`, an unknown checkpoint, a missing anchor, or a run no
 *      longer `awaiting_approval`;
 *    - an operation whose allowlist is empty — nothing is declared reviewable,
 *      so there is nothing this block may honestly show.
 *
 *  ⛔ AND NEVER A PARTIAL BLOCK. `buildAskLandingDetails` emits one row per
 *  ALLOWLIST field, so the set is the allowlist or it is nothing. Four rows
 *  where five values exist is a lie about completeness: absent sends the owner
 *  to the link, partial tells them they have already read it. */
export const createAskCardDetailResolver = (
  deps: AskCardDetailResolverDeps,
): ((ask: PendingAsk) => Promise<readonly ServerPendingAskDetail[] | null>) => {
  const timeZone = deps.timeZone ?? resolveDefaultTimeZone();
  return async (ask: PendingAsk): Promise<readonly ServerPendingAskDetail[] | null> => {
    if (ask.handler_kind !== PREFLIGHT_HANDLER_KIND) return null;
    const batch_id = ask.handler_payload.batch_id;
    if (batch_id !== undefined) {
      // Fail closed on every uncertainty: a non-string id, no reader wired, a
      // throwing or missing row, or more than one member.
      if (typeof batch_id !== 'string' || batch_id.length === 0) return null;
      if (deps.getBatch === undefined) return null;
      let row: { readonly members: readonly unknown[] } | null;
      try {
        row = await deps.getBatch(batch_id);
      } catch {
        return null;
      }
      if (row === null || row.members.length !== 1) return null;
    }
    const checkpoint_id = ask.handler_payload.checkpoint_id;
    if (typeof checkpoint_id !== 'string' || checkpoint_id.length === 0) return null;
    let checkpoint: Checkpoint | null;
    let anchor: AuditEntry | null;
    try {
      checkpoint = await deps.getCheckpoint(checkpoint_id);
      if (checkpoint === null) return null;
      anchor = await deps.getAnchor(checkpoint.run_id);
    } catch {
      // A store that cannot answer renders no block. It must never fail the
      // whole `pending_asks` read — the owner losing the ask list because a
      // detail could not resolve is strictly worse than losing the detail.
      return null;
    }
    if (anchor === null) return null;
    // ⛔ A HELD FOREACH IS SEVERAL CALLS. One approval runs every remaining item
    // of the step (the engine's "remaining same-target aggregate"), and the
    // prose lists them all; this block would show the ONE item the run paused
    // on as though it were the whole approval — the multi-member batch rule
    // above, for the same reason. Found live: Details named one recipient of a
    // mail-out that went to everyone. A chunked gate covers its one item only.
    if (holdCoversSeveralItems(checkpoint)) return null;
    // ⚠ THE SAME GATE THE RECEPTION LOOKUP APPLIES, kept because it is about the
    // HOLD and not about the transport: a run that is no longer awaiting
    // approval has nothing held, so its "what will happen" is already history.
    if (anchor.commit_status !== 'awaiting_approval') return null;
    const args = heldArgs(checkpoint);
    const operation_id = heldOperationId(anchor, checkpoint);
    let arg_schema: ArgEditSchema;
    let shown = args;
    try {
      arg_schema = deps.resolveArgEditSchema(operation_id, args);
      // A pack that declared nothing reviewable still says what the call will
      // change: the action's own declared fields, secrets hidden. Display only.
      if (arg_schema.fields.length === 0 && deps.lookupRequestSchema !== undefined) {
        const fallback = defaultReviewDetails(deps.lookupRequestSchema(operation_id), args);
        if (fallback === null) return null;
        arg_schema = { fields: fallback.fields };
        shown = fallback.args;
      }
    } catch {
      return null;
    }
    const built = buildAskLandingDetails(
      { args: shown, arg_schema, proposed_action: '' },
      { timeZone },
    );
    return built.details.length > 0
      ? built.details.map((d) => ({ label: d.label, value: d.value }))
      : null;
  };
};

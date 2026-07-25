/** D-145 PB3 — `approval.request` primitive.
 *
 *  Per § B.1 row 9 + § B.1.2 rule 7 (`approval.request` is
 *  synchronous — engine pauses; user responds via webclient surface;
 *  engine resumes with the response). D-113 approval substrate.
 *
 *  Synchronous semantics: the primitive's `execute()` does NOT return
 *  until the adapter resolves the user's response. The adapter is
 *  responsible for emitting an `ApprovalRequest` to the webclient
 *  surface + awaiting an `ApprovalResponse`. PB3 keeps the adapter
 *  interface narrow — `request(...)` returns the typed response or
 *  throws on cancellation / timeout.
 *
 *  Dry Run discipline (§ B.5.4): when `ctx.preview === true`, the
 *  primitive records `preview_no_op` and synthesizes an
 *  auto-approved response so downstream primitives can dry-run their
 *  own preview behavior. The orchestrator would stamp the same on
 *  the persisted plan and surface the divergence; no live caller
 *  wires that flow yet.
 *
 *  Privacy: `args_summary` carries approval-kind + reason — never
 *  raw payload bytes.
 *
 *  Spec: § B.1 + § B.1.2 + § B.5.4 + D-113. */

import {
  buildPrimitiveCall,
  projectErrorClass,
  resolveMintCallId,
  resolveNow,
  type EnginePrimitive,
  type PrimitiveExecuteContext,
  type PrimitiveExecuteResult,
} from './types.js';

export const APPROVAL_DECISIONS = ['approved', 'declined', 'cancelled', 'timeout'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];
export const APPROVAL_DECISION_SET: ReadonlySet<ApprovalDecision> = new Set(APPROVAL_DECISIONS);

export interface ApprovalRequest {
  /** Closed-list discriminator per D-113 approval substrate. PB3
   *  keeps the kind open; D-113 closure pins the list at substrate
   *  level. */
  kind: string;
  /** User-facing reason copy. Localized at the surface layer. */
  reason: string;
  /** Per-approval payload — opaque to the primitive. */
  payload?: unknown;
  /** Per-approval timeout in ms. Adapter MUST honor; on expiration
   *  the response is `decision: 'timeout'`. */
  timeout_ms?: number;
}

export interface ApprovalResponse {
  decision: ApprovalDecision;
  /** Optional user-supplied note (e.g. user reason for decline). */
  user_note?: string;
  /** Adapter-stamped epoch — when the user responded (or when the
   *  timeout fired). */
  responded_at: number;
}

export interface ApprovalAdapter {
  request(request: ApprovalRequest): Promise<ApprovalResponse>;
}

export interface ApprovalRequestPrimitiveDeps {
  adapter: ApprovalAdapter;
}

export interface ApprovalRequestPrimitiveInput extends ApprovalRequest {}
export interface ApprovalRequestPrimitiveOutput extends ApprovalResponse {}

const summarizeRequest = (req: ApprovalRequest): string =>
  `kind=${req.kind} reason_len=${req.reason.length}${req.timeout_ms !== undefined ? ` timeout_ms=${req.timeout_ms}` : ''}`;

export const createApprovalRequestPrimitive = (
  deps: ApprovalRequestPrimitiveDeps,
): EnginePrimitive<ApprovalRequestPrimitiveInput, ApprovalRequestPrimitiveOutput> => {
  return {
    primitive: 'approval.request',
    async execute(input, ctx): Promise<PrimitiveExecuteResult<ApprovalRequestPrimitiveOutput>> {
      const now = resolveNow(ctx);
      const mintId = resolveMintCallId(ctx);
      const started_at = now();
      const call_id = mintId();

      // PB13 Dry Run: synthesize an approved response without
      // surfacing the prompt. No live caller wires the actual
      // preview UX yet.
      if (ctx.preview) {
        const completedAt = now();
        const synthetic: ApprovalResponse = {
          decision: 'approved',
          responded_at: completedAt,
          user_note: 'preview_auto_approved',
        };
        return {
          result: synthetic,
          call: buildPrimitiveCall({
            primitive: 'approval.request',
            call_id,
            args_summary: `preview ${summarizeRequest(input)}`,
            outcome_summary: 'preview auto-approved',
            status: 'preview_no_op',
            started_at,
            duration_ms: completedAt - started_at,
            ...(ctx.intent_id !== undefined ? { intent_id: ctx.intent_id } : {}),
          }),
        };
      }

      try {
        const response = await deps.adapter.request(input);
        const completedAt = now();
        if (!APPROVAL_DECISION_SET.has(response.decision)) {
          return {
            result: response,
            call: buildPrimitiveCall({
              primitive: 'approval.request',
              call_id,
              args_summary: summarizeRequest(input),
              outcome_summary: `error unknown_decision ${response.decision}`,
              status: 'error',
              started_at,
              duration_ms: completedAt - started_at,
              ...(ctx.intent_id !== undefined ? { intent_id: ctx.intent_id } : {}),
            }),
          };
        }
        const status =
          response.decision === 'approved'
            ? 'ok'
            : response.decision === 'cancelled' || response.decision === 'declined'
              ? 'cancelled'
              : 'timeout';
        return {
          result: response,
          call: buildPrimitiveCall({
            primitive: 'approval.request',
            call_id,
            args_summary: summarizeRequest(input),
            outcome_summary: `decision=${response.decision}${response.user_note ? ' user_note_present' : ''}`,
            status,
            started_at,
            duration_ms: completedAt - started_at,
            ...(ctx.intent_id !== undefined ? { intent_id: ctx.intent_id } : {}),
          }),
        };
      } catch (e) {
        const completedAt = now();
        const errClass = projectErrorClass(e);
        return {
          result: {
            decision: 'cancelled',
            responded_at: completedAt,
            user_note: errClass,
          },
          call: buildPrimitiveCall({
            primitive: 'approval.request',
            call_id,
            args_summary: summarizeRequest(input),
            outcome_summary: `error ${errClass}`,
            status: 'error',
            started_at,
            duration_ms: completedAt - started_at,
            ...(ctx.intent_id !== undefined ? { intent_id: ctx.intent_id } : {}),
          }),
        };
      }
    },
  };
};

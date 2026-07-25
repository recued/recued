/** D-145 PB3 — `bridge.dispatch` primitive.
 *
 *  Per § B.1 row 7 + § B.1.2 rule 6 (`bridge.dispatch` runs only after
 *  `capacity_spec` confirms `bridge_online + ingredient_installed +
 *  logged_in + (annotation_present or annotation_not_required)` for
 *  the specific intent that needs the bridge). Server-issued
 *  per-step DOM command via D-148 BridgeCommand protocol.
 *
 *  D-148 § A.1.4 BridgeStateProbe / BridgeCommand protocol is an
 *  outstanding dep — PB1 ships a stub interface. PB3 wires the
 *  primitive against an `BridgeCommandAdapter` interface so once
 *  D-148 § A.1.4 lands, the production composer drops in the real
 *  adapter without touching primitive code.
 *
 *  Dry Run discipline (§ B.5.4): when `ctx.preview === true`, the
 *  primitive records `preview_no_op` status WITHOUT calling the
 *  adapter — actuating a DOM command is the canonical mutation.
 *
 *  Privacy: `args_summary` carries command-kind + ingredient-slug —
 *  never raw selectors or DOM payload.
 *
 *  Spec: § B.1 + § B.1.2 + D-148 § A.1.4. */

import {
  buildPrimitiveCall,
  projectAdapterDetailForAudit,
  projectErrorClass,
  resolveMintCallId,
  resolveNow,
  type EnginePrimitive,
  type PrimitiveExecuteContext,
  type PrimitiveExecuteResult,
} from './types.js';

export interface BridgeCommand {
  /** Closed-list command kind per D-148 protocol. PB3 keeps the
   *  field open; D-148 § A.1.4 closure pins the list. */
  kind: string;
  /** Target ingredient slug (`facebook-profile-reader`,
   *  `webchat-gemini`, etc.). */
  ingredient_slug: string;
  /** Per-command payload — opaque to the primitive. */
  payload?: unknown;
  /** Optional bridge instance id for multi-bridge environments. */
  bridge_instance_id?: string;
  /** Per-command timeout in ms. Adapter MUST honor; on expiration
   *  the result returns `success: false` with an audit-friendly
   *  detail. */
  timeout_ms?: number;
}

export interface BridgeCommandResult {
  success: boolean;
  /** Adapter-specific result payload. PB7 broker is responsible for
   *  content-class gating before any of this reaches AI / memory. */
  result?: unknown;
  /** Audit-friendly detail string — never raw payload bytes. */
  detail?: string;
  /** True when the bridge connection dropped mid-execution. The
   *  orchestrator (PB13 + PB15) treats this as `capacity_gap_mid_run`
   *  per § B.15.4. */
  bridge_disconnected?: boolean;
}

export interface BridgeCommandAdapter {
  dispatch(command: BridgeCommand): Promise<BridgeCommandResult>;
}

export interface BridgeDispatchPrimitiveDeps {
  adapter: BridgeCommandAdapter;
}

export interface BridgeDispatchPrimitiveInput extends BridgeCommand {}
export interface BridgeDispatchPrimitiveOutput extends BridgeCommandResult {}

const summarizeCommand = (cmd: BridgeCommand): string =>
  `kind=${cmd.kind} ingredient=${cmd.ingredient_slug}${cmd.bridge_instance_id ? ` bridge=${cmd.bridge_instance_id}` : ''}`;

export const createBridgeDispatchPrimitive = (
  deps: BridgeDispatchPrimitiveDeps,
): EnginePrimitive<BridgeDispatchPrimitiveInput, BridgeDispatchPrimitiveOutput> => {
  return {
    primitive: 'bridge.dispatch',
    async execute(input, ctx): Promise<PrimitiveExecuteResult<BridgeDispatchPrimitiveOutput>> {
      const now = resolveNow(ctx);
      const mintId = resolveMintCallId(ctx);
      const started_at = now();
      const call_id = mintId();

      // PB13 Dry Run: skip the adapter, record preview_no_op.
      if (ctx.preview) {
        const completedAt = now();
        return {
          result: { success: true, detail: 'preview_no_op' },
          call: buildPrimitiveCall({
            primitive: 'bridge.dispatch',
            call_id,
            args_summary: `preview ${summarizeCommand(input)}`,
            outcome_summary: 'preview no actuation',
            status: 'preview_no_op',
            started_at,
            duration_ms: completedAt - started_at,
            ...(ctx.intent_id !== undefined ? { intent_id: ctx.intent_id } : {}),
          }),
        };
      }

      try {
        const result = await deps.adapter.dispatch(input);
        const completedAt = now();
        const status = result.bridge_disconnected
          ? 'capacity_gap_mid_run'
          : result.success
            ? 'ok'
            : 'error';
        const safeDetail = projectAdapterDetailForAudit(result.detail);
        return {
          result,
          call: buildPrimitiveCall({
            primitive: 'bridge.dispatch',
            call_id,
            args_summary: summarizeCommand(input),
            outcome_summary: `success=${result.success} disconnected=${result.bridge_disconnected ? 'yes' : 'no'}${safeDetail ? ` detail=${safeDetail}` : ''}`,
            status,
            started_at,
            duration_ms: completedAt - started_at,
            ...(ctx.intent_id !== undefined ? { intent_id: ctx.intent_id } : {}),
          }),
        };
      } catch (e) {
        const completedAt = now();
        return {
          result: { success: false, detail: projectErrorClass(e) },
          call: buildPrimitiveCall({
            primitive: 'bridge.dispatch',
            call_id,
            args_summary: summarizeCommand(input),
            outcome_summary: `error ${projectErrorClass(e)}`,
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

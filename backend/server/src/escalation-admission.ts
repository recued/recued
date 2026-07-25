/** D-192 — the shared CHANNEL-POSTURE half of caller-triggered vendor
 *  escalation admission, extracted from the work-entity read tools so
 *  the CRM S3 live-escalation leg (chat-tool-handlers) runs the SAME
 *  posture over the SAME core (`admitCatalogOpForSource`) — one home,
 *  two escalation families, no drift.
 *
 *  A caller-triggered escalation (a chat / mcp_wire dispatch reaching a
 *  live vendor read outside the gated invoke spine) never traverses the
 *  op-admission gate on its own, so BOTH families must consult it here.
 *  Channel posture (the admission-seam rules, `120761d0`):
 *
 *   - `mcp_wire` — requires the threaded `execution_source` + the
 *     per-token `ContractSnapshot` + the admission gate; ANY of them
 *     missing ⇒ refused (admission that cannot run never admits —
 *     fail-closed for producer gaps / dbless harnesses).
 *   - owner chat — a threaded source runs the same core snapshot-less
 *     (reads admit under the owner ceiling; the D-188 pause + an
 *     explicit owner-contract op revoke still gate). NO source
 *     (producer gap) ⇒ admitted ungated — the pre-seam owner posture.
 *   - a contract-BEARING source WITHOUT its paired snapshot cannot be
 *     evaluated (`evaluatePreflightAdmission` THROWS on it by design)
 *     ⇒ honest refusal, never an exception through the tool.
 *
 *  Deliberately NO catalog-slug aliasing into `allowed_tools` on this
 *  path (the raw-op caller's preamble): a `work.*` / `*.search` wire
 *  grant is a MIRROR-read grant, not a reach-the-vendor grant — a door
 *  escalates only when its contract already allows the BACKING catalog
 *  tool. The dead-bound-contract kill-switch needs no special casing:
 *  `buildMcpContractSnapshot` collapses a dead contract's
 *  `allowed_tools` to `[]` → `tool_not_in_contract`.
 *
 *  The decision is TYPED, not worded: each family renders refusals in
 *  its own register — the work-entity tools surface named model-facing
 *  copies (`escalation_errors` — the model explicitly requested live
 *  detail), the CRM leg keeps its silent-graceful keep-the-mirror
 *  posture (escalation is freshness-driven, never model-requested; the
 *  served result stays honest via `synced_at` + `filter_applied`). */

import type {
  ChatDispatchContext,
  ExecutionSource,
  IngredientManifest,
  AdmissionDenyCode,
} from '@recued/contracts';
import { executionSourceHasContract } from '@recued/contracts';

import { admitCatalogOpForSource } from './raw-op-dispatch.js';
import type { OpAdmissionGate } from './op-admission-gate.js';

/** The caller identity threaded into every escalated vendor invoke:
 *  the dispatch ctx's `execution_source` verbatim + the honest trigger
 *  origin (mirrors `channelTriggerSource` in chat-tool-handlers) + the
 *  intent-burst correlation id (an mcp source's `tool_call_id`,
 *  mirroring raw-op dispatch; a chat source groups by its own
 *  `turn_id`). */
export interface EscalationOrigin {
  execution_source?: ExecutionSource;
  trigger_source: 'mcp' | 'chat';
  correlation_id?: string;
}

export const escalationOrigin = (ctx: ChatDispatchContext): EscalationOrigin => {
  const source = ctx.execution_source;
  return {
    ...(source !== undefined ? { execution_source: source } : {}),
    trigger_source: ctx.channel === 'mcp_wire' ? 'mcp' : 'chat',
    ...(source !== undefined && source.channel === 'mcp'
      ? { correlation_id: source.tool_call_id }
      : {}),
  };
};

/** The resolved catalog binding an escalation admission is judged on —
 *  each family resolves it its own way (work-entity: the declared
 *  Source's `prepareWorkEntitySourceTargetedRead`; CRM: the
 *  connection's operation profile + the `${entity}.search` op-key
 *  convention). */
export interface SourceEscalationBinding {
  catalogSlug: string;
  manifest: IngredientManifest;
  /** The SHORT `operations`-map key (`task.read`, `deal.search`) —
   *  resolved to the DECLARED `operation_id` inside the core. */
  operation: string;
}

export type SourceEscalationRefusal =
  /** External dispatch missing its source / snapshot / admission gate
   *  — admission cannot run, so it never admits. */
  | { kind: 'external_unevaluable' }
  /** A contract-bearing source without its paired snapshot (producer
   *  gap — the core would throw; refuse honestly instead). */
  | { kind: 'contracted_unevaluable' }
  /** D-188 master pause (must never read as a grant problem). */
  | { kind: 'server_paused' }
  /** An `ask` verdict — a serve-only escalation spine cannot hold for
   *  approval. */
  | { kind: 'requires_approval'; detail: string }
  /** A structural deny (`tool_not_in_contract` / `op_not_granted` /
   *  scope fence / …). */
  | { kind: 'denied'; code: AdmissionDenyCode; detail: string };

export type SourceEscalationAdmission =
  | { admitted: true }
  | { admitted: false; refusal: SourceEscalationRefusal };

/** Run the shared per-dispatch catalog-op admission for one prepared
 *  escalation under the dispatch ctx's channel posture (module doc).
 *  Verdict mapping: `admit` proceeds; `server_paused` stays its own
 *  kind (the caller's wording must keep pause reading as pause); `ask`
 *  is a refusal on every escalation spine (no checkpoint to hold on);
 *  any other deny is structural. */
export const admitSourceCatalogEscalation = (
  gate: Pick<OpAdmissionGate, 'isFrozenByPause' | 'isOpGranted'> | undefined,
  ctx: ChatDispatchContext,
  binding: SourceEscalationBinding,
): SourceEscalationAdmission => {
  const external = ctx.channel === 'mcp_wire';
  const source = ctx.execution_source;
  const snapshot = ctx.contract_snapshot;
  if (source === undefined) {
    return external
      ? { admitted: false, refusal: { kind: 'external_unevaluable' } }
      : { admitted: true };
  }
  if (external && (snapshot === undefined || gate === undefined)) {
    return { admitted: false, refusal: { kind: 'external_unevaluable' } };
  }
  if (snapshot === undefined && executionSourceHasContract(source)) {
    return { admitted: false, refusal: { kind: 'contracted_unevaluable' } };
  }
  const decision = admitCatalogOpForSource(gate, {
    catalogSlug: binding.catalogSlug,
    manifest: binding.manifest,
    operation: binding.operation,
    executionSource: source,
    ...(snapshot !== undefined ? { contractSnapshot: snapshot } : {}),
  });
  if (decision.verdict === 'admit') return { admitted: true };
  if (decision.verdict === 'deny' && decision.code === 'server_paused') {
    return { admitted: false, refusal: { kind: 'server_paused' } };
  }
  if (decision.verdict === 'ask') {
    return {
      admitted: false,
      refusal: { kind: 'requires_approval', detail: decision.detail },
    };
  }
  return {
    admitted: false,
    refusal: { kind: 'denied', code: decision.code, detail: decision.detail },
  };
};

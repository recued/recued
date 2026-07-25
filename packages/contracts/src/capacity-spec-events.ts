/** D-145 PB1 — capacity_spec audit + transparency event-kind constants.
 *
 *  Separated from `capacity-spec.ts` so consumers that only need the
 *  emit-side type aliases don't pull every type-level export. Also
 *  the place where the two new `ActivityAction` codes are mirrored
 *  for downstream consumers that don't depend on `@recued/storage`
 *  (e.g. UI shared label maps, MCP-facing audit projections).
 *
 *  Spec: D-145 § B.4.4.
 *  Design draft: D-145. */

import type {
  CapacityAuditParams,
  CapacityKind,
  CapacityRemediationAction,
  CapacityRemediationVisibility,
} from './capacity-spec.js';

// ── ActivityAction codes (mirrored from packages/storage/src/audit.ts) ─

export const CAPACITY_AUDIT_OK_ACTION = 'capacity_check.ok' as const;
export const CAPACITY_AUDIT_GAP_ACTION = 'capacity_check.gap' as const;

export const CAPACITY_AUDIT_ACTIONS: ReadonlyArray<
  typeof CAPACITY_AUDIT_OK_ACTION | typeof CAPACITY_AUDIT_GAP_ACTION
> = [CAPACITY_AUDIT_OK_ACTION, CAPACITY_AUDIT_GAP_ACTION];

export type CapacityAuditAction = (typeof CAPACITY_AUDIT_ACTIONS)[number];

// ── Audit detail (JSON-stringified into ActivityEntry.detail) ───────

export type CapacityFailureKind = 'gap' | 'probe_error';

export interface CapacityCheckAuditDetail {
  walk_id: string;
  run_id?: string;
  intent_id?: string;
  primitive?: string;
  recipe_id?: string;
  /** capacityKey(req) for every check. */
  capacity_keys: string[];
  cache_hits: number;
  cache_misses: number;
  // Gap-only fields:
  gap_kind?: CapacityKind;
  gap_key?: string;
  /** Redacted per § N.7. */
  gap_params?: CapacityAuditParams;
  remediation_action?: CapacityRemediationAction;
  remediation_visibility?: CapacityRemediationVisibility;
  /** Distinguishes capability gap from probe-error path. */
  failure_kind?: CapacityFailureKind;
}

// ── Transparency event ──────────────────────────────────────────────

export const CAPACITY_TRANSPARENCY_GAP_EVENT_KIND = 'capacity_check.gap' as const;
export type CapacityTransparencyEventKind = typeof CAPACITY_TRANSPARENCY_GAP_EVENT_KIND;

/** Emitted ONLY when result is gap AND remediation.visibility ===
 *  'user_visible'. PB7 will register a renderer; PB1 emits the typed
 *  event into a (PB7-supplied) emitter. */
export interface CapacityCheckGapTransparencyEvent {
  kind: CapacityTransparencyEventKind;
  walk_id: string;
  primitive?: string;
  gap_kind: CapacityKind;
  gap_key: string;
  /** Same redaction as audit. */
  gap_params: CapacityAuditParams;
  remediation: {
    action: CapacityRemediationAction;
    user_facing_copy: string;
    cta_path?: string;
  };
}

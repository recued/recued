/** D-145 PB7 — D-120 audit emission shape per transparency event.
 *
 *  Per § B.8.7.1 — same events feed two consumers with different
 *  shapes:
 *
 *    - Chat-log render — Recued voice template output (the
 *      `render_text` field in `TransparencyEventEnvelope`).
 *    - Audit-log full payload (D-120) — raw structured event for
 *      replay / debug / benchmark / compliance, plus a render-clean
 *      preview so the audit reader can show "what the user saw" at
 *      that moment.
 *
 *  The audit-log payload is the audit-table row's `detail` field. The
 *  composer builds it once per event and passes it to the D-120
 *  audit emitter at the same time it emits the chat-log envelope. The
 *  two surfaces are kept structurally distinct (per § B.8.7.1 table)
 *  but composed from the same source event so they never drift.
 *
 *  Spec: § B.8.2.1 + § B.8.7.1. */

import type { TransparencyEvent } from './events.js';
import type {
  TransparencyEventEnvelope,
  TransparencyRedactionTier,
} from './redaction.js';

// ── PB7.5.1 — Audit detail payload shape ────────────────────────────

/** Audit-row detail per transparency event. The D-120 audit table
 *  carries these as JSON-stringified `ActivityEntry.detail`. The audit
 *  consumer (`packages/server-audit/`) reads the structured fields for
 *  replay; the audit-log UI re-renders the Recued voice template at
 *  read time using `event` + the locale-pinned template registry. */
export interface TransparencyAuditDetail {
  /** Raw event — closed-taxonomy union member. The audit log preserves
   *  the full payload so future analysis can re-render with updated
   *  templates / fix display bugs without losing data. */
  readonly event: TransparencyEvent;
  /** Redaction tier as it was emitted to the chat-log. The audit log
   *  preserves the resolved tier (not the default) so a "show me what
   *  I would have seen if Settings were X" recompute is possible from
   *  audit alone. */
  readonly chat_log_redaction: TransparencyRedactionTier;
  /** Wall-clock emission timestamp mirrored from the wire envelope. */
  readonly emitted_at: number;
  /** D-120 plan id / run id linkage when the engine passes one at
   *  compose time. Allows the audit reader to scope events to a
   *  specific RecuedPlan run. */
  readonly run_id?: string;
  /** D-120 source attribution — closed-list discriminator for the
   *  origin of this event. `'ai_emitted'` for events lifted from
   *  AIOutput; `'engine_brokering'` for events emitted directly from
   *  primitive-call sites or from the D-164 prompt-cache main-turn
   *  assembly (`engine.gate_short_circuit` / `engine.catalog_-
   *  assembled`); `'failure'` for § B.15 truthful-failure events;
   *  `'orchestration'` for § B.6 multi-turn / fixed-slot events. The
   *  composer stamps this from `TRANSPARENCY_EVENT_CLASS_FOR_KIND` so
   *  audit consumers can filter by source without re-parsing the kind. */
  readonly source: TransparencyAuditSource;
}

/** Closed-list source of a transparency event for audit attribution.
 *  Mirror of `TransparencyEventClass` — same four-element list (D-164
 *  P6.7 retired `'two_stage'` alongside the Stage 1 / Stage 2 events). */
export const TRANSPARENCY_AUDIT_SOURCES = [
  'ai_emitted',
  'engine_brokering',
  'failure',
  'orchestration',
] as const;
export type TransparencyAuditSource = (typeof TRANSPARENCY_AUDIT_SOURCES)[number];
export const TRANSPARENCY_AUDIT_SOURCE_SET: ReadonlySet<TransparencyAuditSource> =
  new Set(TRANSPARENCY_AUDIT_SOURCES);

// ── PB7.5.2 — Audit-row activity action constants ───────────────────

/** ActivityAction code mirrored from `packages/storage/src/audit.ts`
 *  for downstream consumers that don't depend on `@recued/storage`
 *  (e.g. UI shared label maps, MCP-facing audit projections). PB7
 *  emits one row per envelope under this single action; the row's
 *  detail discriminates by `event.kind` + `source`. */
export const TRANSPARENCY_STREAM_AUDIT_ACTION = 'transparency_stream' as const;
export type TransparencyStreamAuditAction = typeof TRANSPARENCY_STREAM_AUDIT_ACTION;

// ── PB7.5.3 — Audit detail builder ──────────────────────────────────

/** Build the audit-row detail from a composed envelope. Pure — no IO.
 *  The composer calls this once per event and hands the result to the
 *  D-120 audit emitter. Round-trip:
 *
 *    chat-log:   envelope.render_text      → user reads
 *    audit-log:  TransparencyAuditDetail   → JSON-stringify into
 *                                            ActivityEntry.detail
 *
 *  `source` is inferred from the kind via the class registry; callers
 *  may pass `run_id` to link the row back to the plan in flight. */
export const buildTransparencyAuditDetail = (
  envelope: TransparencyEventEnvelope,
  source: TransparencyAuditSource,
  run_id?: string,
): TransparencyAuditDetail => ({
  event: envelope.event,
  chat_log_redaction: envelope.redaction,
  emitted_at: envelope.emitted_at,
  source,
  ...(run_id !== undefined ? { run_id } : {}),
});

// ── PB7.5.4 — Substrate self-check ──────────────────────────────────

export const assertTransparencyAuditInvariants = (): void => {
  const sourceLength = TRANSPARENCY_AUDIT_SOURCES.length as number;
  if (sourceLength === 0) {
    throw new Error('TRANSPARENCY_AUDIT_SOURCES must be non-empty');
  }
  if (TRANSPARENCY_AUDIT_SOURCE_SET.size !== sourceLength) {
    throw new Error('TRANSPARENCY_AUDIT_SOURCES contains duplicates');
  }
  const actionLength = TRANSPARENCY_STREAM_AUDIT_ACTION.length as number;
  if (actionLength === 0) {
    throw new Error('TRANSPARENCY_STREAM_AUDIT_ACTION must be non-empty');
  }
};

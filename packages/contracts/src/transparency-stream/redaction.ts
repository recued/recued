/** D-145 PB7 — per-event redaction tier (§ B.8.2.1).
 *
 *  Each transparency event flows to two surfaces with different
 *  shapes (per § B.8.7.1):
 *
 *    - Chat-log render (user-facing narrative) — Recued voice template
 *      output, possibly bucketed counts, redacted free-text.
 *    - Audit-log full payload (D-120) — raw structured fields for
 *      replay / debug / benchmark / compliance.
 *
 *  The wire envelope carries a 3-tier render redaction signal:
 *
 *    - `'none'`        — fully visible; render as-is.
 *    - `'summary_only'` — render summary; full detail behind click-to-
 *                         expand affordance.
 *    - `'hidden'`       — don't render to user surface at all (still
 *                         emitted to audit log).
 *
 *  Per-kind defaults below land into the registry the composer reads.
 *  Settings (per § B.8.9) can override per-kind / per-redaction-tier;
 *  the wire envelope reflects the final resolved tier.
 *
 *  Spec: § B.8.2.1 + § B.8.7.1. */

import type {
  TransparencyEvent,
  TransparencyEventKind,
} from './events.js';
import { TRANSPARENCY_EVENT_KINDS } from './events.js';

// ── PB7.2.1 — Redaction tier enum ───────────────────────────────────

export const TRANSPARENCY_REDACTION_TIERS = [
  'none',
  'summary_only',
  'hidden',
] as const;
export type TransparencyRedactionTier =
  (typeof TRANSPARENCY_REDACTION_TIERS)[number];
export const TRANSPARENCY_REDACTION_TIER_SET: ReadonlySet<TransparencyRedactionTier> =
  new Set(TRANSPARENCY_REDACTION_TIERS);

/** Render priority — lowest renders most info; the visibility filter
 *  uses this to decide whether `summary_only` renders when the user
 *  has set a max-tier preference. `hidden` is the suppression case. */
export const TRANSPARENCY_REDACTION_TIER_PRIORITY: Readonly<
  Record<TransparencyRedactionTier, number>
> = Object.freeze({
  none: 0,
  summary_only: 1,
  hidden: 2,
});

// ── PB7.2.2 — Per-kind default redaction registry ───────────────────

/** § B.8.4 — initial default-visibility table mapped to redaction
 *  tiers. Several event kinds default to `'hidden'` because § B.8.4
 *  marks them as "silent by default" — engine still emits to audit but
 *  the user-facing chat surface omits them unless the user opts in.
 *
 *  Two `'summary_only'` defaults: `context_omitted` (renders only on
 *  click-to-expand) and `ai_call` (visible-on-reasoning-tier policy is
 *  enforced by the composer; default tier here is summary so the chat
 *  surface gets a one-line "thinking..." cue without round/token
 *  detail unless expanded). */
export const TRANSPARENCY_DEFAULT_REDACTION_FOR_KIND: Readonly<
  Record<TransparencyEventKind, TransparencyRedactionTier>
> = Object.freeze({
  // AI-emitted ─ visible by default per § B.8.4.
  'extraction.detected': 'none',
  'extraction.saved': 'none',
  'extraction.queued_for_confirm': 'none',
  'extraction.skipped_low_confidence': 'none',
  'resolution.alias': 'none',
  'resolution.contact_created_mention_only': 'none',
  'resolution.network_domain_inferred': 'none',
  'pattern.observation': 'none',
  'drift.signal': 'none',
  'action.completed': 'none',
  'action.failed': 'none',
  // § B.8.4 — silent by default (too noisy unless opted in).
  'cascade.fired': 'hidden',
  // Engine-brokering ─ § B.8.4 silent / summary defaults.
  'capacity_check.ok': 'hidden',
  'capacity_check.gap': 'none',
  memory_lookup: 'none',
  // § B.8.4 — surfaces only on click-to-expand.
  context_omitted: 'summary_only',
  // § B.8.4 — silent by default in non-Quiet mode for fast tier;
  // visible for reasoning tier. The composer's
  // `applyAiCallTierPolicy` (engine side) widens to `'none'` when
  // tier === 'reasoning'.
  ai_call: 'summary_only',
  bridge_dispatch: 'none',
  approval_request: 'none',
  identity_resolution: 'none',
  // D-160 O-5 — payload is pre-redacted to the MCP-safe SI projection:
  // action kinds, booleans, tiers, redirect id, and conflict ids only.
  standing_instruction_applied: 'none',
  // D-164 P6.7 — prompt-cache main-turn assembly. Audit-only by
  // default; users who want a render-time cue opt in via the
  // engine_brokering per-class toggle + lower the max-redaction-tier.
  'engine.gate_short_circuit': 'hidden',
  'engine.catalog_assembled': 'hidden',
  // Failure semantics ─ § B.8.2 user-must-see.
  'ai_call.malformed': 'none',
  'ai_call.giving_up_malformed': 'none',
  standing_instruction_conflict: 'none',
  'privacy.hard_fail': 'none',
  capacity_gap_mid_run: 'none',
  'cost_ceiling.demoted': 'none',
  'cost_ceiling.halted': 'none',
  'engine.budget_exceeded': 'none',
  // PB7 follow-on — payload is two closed enums (reason / site), no PII.
  'engine.decoder_unavailable': 'none',
  // Ack-before-run — bare kind, no payload at all; nothing to redact.
  'engine.turn_failed': 'none',
  // § B.6 orchestration — engine-internal cooperation; default summary
  // so the chat surface gets a one-line cue ("round 2..."). Audit log
  // carries the full structured event regardless.
  'recued.multi_turn.round_started': 'summary_only',
  'recued.multi_turn.round_completed': 'summary_only',
  'recued.multi_turn.loop_terminated': 'summary_only',
  // D-137 Trio #E follow-on — per-turn token aggregate. Summary-only
  // by default (chat surface gets a "12k tokens used this turn" cue);
  // benchmark + billing surfaces read the structured payload via the
  // audit row regardless of redaction tier.
  'recued.token_usage': 'summary_only',
  // § B.6.8 — fixed-slot drift is a substrate-flagged ingredient bug
  // ("dropped"); render visible so the user sees the substrate
  // protecting them from a drifting alternative.
  fixed_slot_drift: 'none',
});

/** Convenience accessor — maps a kind to its default redaction tier. */
export const defaultRedactionForKind = (
  kind: TransparencyEventKind,
): TransparencyRedactionTier => TRANSPARENCY_DEFAULT_REDACTION_FOR_KIND[kind];

// ── PB7.2.3 — Wire envelope shape ───────────────────────────────────

/** § B.8.2.1 — the wire shape transparency consumers see. Composer
 *  emits one envelope per event; chat-log renderer reads `event` +
 *  `redaction` and renders via `renderTransparencyTemplate(event)`;
 *  audit emitter reads `event` (raw) + `provenance_ref` + `emitted_at`.
 *
 *  Spec § B.8.2.1 verbatim shape — render text is computed at render
 *  time from the closed event payload + the locale-pinned template
 *  registry (`templates.ts`), NOT carried on the wire. This keeps the
 *  envelope locale-portable: a single emission can render in EN at
 *  the chat-log surface and ES at an alternate consumer reading the
 *  same plan IR. */
export interface TransparencyEventEnvelope {
  /** The raw event — closed-taxonomy discriminated union. */
  readonly event: TransparencyEvent;
  /** Final resolved redaction tier per § B.8.2.1. */
  readonly redaction: TransparencyRedactionTier;
  /** D-120 audit row id. The composer populates this when the engine
   *  passes a `provenance_ref` at compose time; otherwise omitted. The
   *  chat-log renderer uses it for click-to-expand → audit-log
   *  cross-link. */
  readonly provenance_ref?: string;
  /** Wall-clock emission timestamp (ms since epoch). Composer stamps
   *  this once; chat-log renderer + audit emitter read the same value
   *  so cross-surface correlation lands. Per spec § B.8.2.1 wire
   *  shape. */
  readonly emitted_at: number;
}

// ── PB7.2.4 — Substrate self-check ──────────────────────────────────

/** Defensive runtime check — every kind has a default redaction;
 *  every redaction value is in the closed list; tier priority covers
 *  every tier with unique values. */
export const assertTransparencyRedactionInvariants = (): void => {
  const tierLength = TRANSPARENCY_REDACTION_TIERS.length as number;
  if (tierLength === 0) {
    throw new Error('TRANSPARENCY_REDACTION_TIERS must be non-empty');
  }
  if (TRANSPARENCY_REDACTION_TIER_SET.size !== tierLength) {
    throw new Error('TRANSPARENCY_REDACTION_TIERS contains duplicates');
  }
  for (const kind of TRANSPARENCY_EVENT_KINDS) {
    const tier = TRANSPARENCY_DEFAULT_REDACTION_FOR_KIND[kind];
    if (!TRANSPARENCY_REDACTION_TIER_SET.has(tier)) {
      throw new Error(
        `TRANSPARENCY_DEFAULT_REDACTION_FOR_KIND['${kind}'] = '${tier}' is not in TRANSPARENCY_REDACTION_TIERS`,
      );
    }
  }
  const registryKinds = Object.keys(TRANSPARENCY_DEFAULT_REDACTION_FOR_KIND);
  if (registryKinds.length !== TRANSPARENCY_EVENT_KINDS.length) {
    throw new Error(
      `TRANSPARENCY_DEFAULT_REDACTION_FOR_KIND has ${registryKinds.length} entries; expected ${TRANSPARENCY_EVENT_KINDS.length}`,
    );
  }
  // Tier priority must include every tier with unique values.
  const seen = new Set<number>();
  for (const tier of TRANSPARENCY_REDACTION_TIERS) {
    const p = TRANSPARENCY_REDACTION_TIER_PRIORITY[tier];
    if (!Number.isFinite(p)) {
      throw new Error(
        `TRANSPARENCY_REDACTION_TIER_PRIORITY['${tier}'] not finite`,
      );
    }
    if (seen.has(p)) {
      throw new Error(
        `TRANSPARENCY_REDACTION_TIER_PRIORITY duplicate priority ${p} for '${tier}'`,
      );
    }
    seen.add(p);
  }
};

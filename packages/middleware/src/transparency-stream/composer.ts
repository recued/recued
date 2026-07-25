/** D-145 PB7 — Transparency Stream composer (UNIFIED).
 *
 *  Per § B.8.2 + § B.8.2.1 + § B.8.7.1. Single composer pipeline:
 *
 *    1. Validate event shape against the closed taxonomy
 *       (`validateTransparencyEvent`). Halts cleanly with a closed-
 *       list issue when invalid — caller halts the surrounding plan
 *       step rather than emitting garbage to chat or audit.
 *
 *    2. Resolve redaction tier: start at the per-kind default
 *       (`defaultRedactionForKind`) → caller-side override (when
 *       passed) → Settings filter (`applyVisibilityPolicy`).
 *
 *    3. Apply the main-turn tier-policy overlay for `ai_call`:
 *       reasoning-tier widens to `'none'` per § B.8.4 baseline so the
 *       user sees long-running reasoning calls (the default
 *       `summary_only` only fits fast / mid).
 *
 *    4. Stamp `emitted_at`. Engine clock is the substrate's wall-
 *       time source so audit replay correlates against primitive_call
 *       `started_at` fields. Caller may override (test fixtures).
 *
 *    5. Emit one `TransparencyEventEnvelope` per call. Pure — no IO,
 *       no side effects.
 *
 *  D-120 audit emission is a separate step: the caller maps the
 *  envelope through `buildTransparencyAuditDetail` and hands the
 *  result to the audit emitter. Composer does NOT touch storage; it
 *  is a pure shape-translation layer.
 *
 *  Spec: § B.8.2 + § B.8.2.1 + § B.8.4 + § B.8.7.1 + § B.8.9. */

import {
  applyVisibilityPolicy,
  buildTransparencyAuditDetail,
  classForTransparencyEventKind,
  defaultRedactionForKind,
  DEFAULT_TRANSPARENCY_STREAM_SETTINGS,
  renderTransparencyTemplate,
  type TransparencyAuditDetail,
  type TransparencyAuditSource,
  type TransparencyEvent,
  type TransparencyEventEnvelope,
  type TransparencyEventValidationIssue,
  type TransparencyRedactionTier,
  type TransparencyStreamSettings,
  validateTransparencyEvent,
} from '@recued/contracts';

// ── PB7.E.1 — Composer issue taxonomy ───────────────────────────────

/** Closed-list composer issue kinds. PB7 ratchet pins membership. */
export const TRANSPARENCY_COMPOSER_ISSUE_KINDS = [
  /** `validateTransparencyEvent` raised one or more issues — the wire
   *  envelope can't be safely emitted. Caller halts the surrounding
   *  step or routes the malformed event to a debug-only channel. */
  'event_invalid',
] as const;
export type TransparencyComposerIssueKind =
  (typeof TRANSPARENCY_COMPOSER_ISSUE_KINDS)[number];
export const TRANSPARENCY_COMPOSER_ISSUE_KIND_SET: ReadonlySet<TransparencyComposerIssueKind> =
  new Set(TRANSPARENCY_COMPOSER_ISSUE_KINDS);

export interface TransparencyComposerIssue {
  readonly kind: TransparencyComposerIssueKind;
  readonly detail: TransparencyEventValidationIssue;
}

// ── PB7.E.2 — Compose entrypoint ────────────────────────────────────

export interface ComposeTransparencyEventInput {
  /** Raw event from the AI provider's `events[]` mapping or the
   *  primitive-call site. Closed taxonomy enforced via the validator. */
  readonly event: unknown;
  /** Caller's user Settings — defaults to
   *  `DEFAULT_TRANSPARENCY_STREAM_SETTINGS` when omitted (test
   *  fixtures, internal engine paths that don't touch user policy). */
  readonly settings?: TransparencyStreamSettings;
  /** Caller-side tier override before Settings filter — engine paths
   *  that already know they want to suppress / surface a particular
   *  emission set this. § B.8.4 reasoning-tier `ai_call` widening uses
   *  this. When omitted the per-kind default applies. */
  readonly redaction_override?: TransparencyRedactionTier;
  /** D-120 audit row id linkage. Composer threads it through to the
   *  envelope; chat-log click-to-expand → audit-log cross-link. */
  readonly provenance_ref?: string;
  /** Wall-clock ms since epoch — defaults to `Date.now()` so audit
   *  replay correlates against primitive_call timestamps. Test fixtures
   *  override for deterministic snapshots. */
  readonly now?: () => number;
}

export interface ComposeTransparencyEventResult {
  readonly envelope?: TransparencyEventEnvelope;
  readonly issues: ReadonlyArray<TransparencyComposerIssue>;
}

/** § B.8.2 — pure composer pass for a single event.
 *
 *  Halts on the first validation failure — emits an empty envelope +
 *  the closed-list issue. Caller decides whether to drop, route to a
 *  debug-only sink, or escalate to a plan-level halt.
 *
 *  Pure / deterministic — no IO, no side effects. The audit emit is
 *  a separate downstream call (see `buildTransparencyAuditDetail`). */
export const composeTransparencyEvent = (
  input: ComposeTransparencyEventInput,
): ComposeTransparencyEventResult => {
  const issues: TransparencyComposerIssue[] = [];

  const eventIssues = validateTransparencyEvent(input.event);
  for (const detail of eventIssues) {
    issues.push({ kind: 'event_invalid', detail });
  }
  if (issues.length > 0) {
    return { issues };
  }

  // Validator narrowed the input — safe to assert as the closed union.
  const event = input.event as TransparencyEvent;

  // Step 2 + 3 — resolve redaction tier with the per-kind default,
  // caller override, and the ai_call main-turn tier-policy overlay
  // (§ B.8.4).
  const baseline =
    input.redaction_override ?? defaultRedactionForKind(event.kind);
  const overlayed = applyMainTurnTierPolicyOverlay(event, baseline);

  // Step 4 — Settings filter (master toggle / per-class / per-domain
  // / per-tier). The filter may downshift the tier to `'hidden'`.
  const settings = input.settings ?? DEFAULT_TRANSPARENCY_STREAM_SETTINGS;
  const finalTier = applyVisibilityPolicy(event, overlayed, settings);

  // Step 5 — stamp wall-time + emit.
  const now = input.now ?? Date.now;
  const envelope: TransparencyEventEnvelope = {
    event,
    redaction: finalTier,
    emitted_at: now(),
    ...(input.provenance_ref !== undefined
      ? { provenance_ref: input.provenance_ref }
      : {}),
  };

  return { envelope, issues: [] };
};

// ── PB7.E.3 — ai_call main-turn tier-policy overlay (§ B.8.4) ────────

/** § B.8.4 — `ai_call` is silent by default in non-Quiet mode for
 *  fast tier; visible for reasoning tier. The base default in
 *  `defaultRedactionForKind` is `summary_only`; this main-turn
 *  tier-policy overlay widens to `'none'` when tier === 'reasoning' so
 *  long-running reasoning calls surface in the chat. Other tiers stay
 *  at the baseline. */
const applyMainTurnTierPolicyOverlay = (
  event: TransparencyEvent,
  baseline: TransparencyRedactionTier,
): TransparencyRedactionTier => {
  if (event.kind !== 'ai_call') return baseline;
  if (event.tier === 'reasoning' && baseline === 'summary_only') {
    return 'none';
  }
  return baseline;
};

// ── PB7.E.4 — Audit emission convenience ────────────────────────────

/** Compose + render audit detail in one call. Convenience for the
 *  common case where an engine site emits a transparency event AND
 *  wants the matching audit-row payload. Caller passes the audit
 *  emitter separately (the composer is pure and never touches IO). */
export const composeTransparencyEventWithAudit = (
  input: ComposeTransparencyEventInput,
  run_id?: string,
): {
  readonly envelope?: TransparencyEventEnvelope;
  readonly audit?: TransparencyAuditDetail;
  readonly issues: ReadonlyArray<TransparencyComposerIssue>;
} => {
  const { envelope, issues } = composeTransparencyEvent(input);
  if (envelope === undefined) return { issues };
  const source: TransparencyAuditSource = classForTransparencyEventKind(
    envelope.event.kind,
  );
  const audit = buildTransparencyAuditDetail(envelope, source, run_id);
  return { envelope, audit, issues };
};

// ── PB7.E.5 — Render passthrough (chat-log surface) ─────────────────

/** Render a wire envelope to its Recued-voiced inline text. The
 *  chat-log renderer calls this; the audit-log UI calls it at read
 *  time when re-rendering a stored event. Empty string is the signal
 *  for "renders nothing" (silent kinds + hidden tier).
 *
 *  Per § B.8.2.1: `'hidden'` tier → no render text (audit-only).
 *  `'summary_only'` → render the template; the chat surface decides
 *  whether to gate behind click-to-expand based on the tier. */
export const renderTransparencyEnvelope = (
  envelope: TransparencyEventEnvelope,
): string => {
  if (envelope.redaction === 'hidden') return '';
  return renderTransparencyTemplate(envelope.event);
};

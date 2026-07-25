/** D-145 PB6 — closed extraction-event taxonomy + confidence-tier
 *  dispatch primitives.
 *
 *  Per § B.7.1 + § B.7.7. PB2 shipped an open `ExtractionEvent
 *  { kind: string; payload?: unknown }` envelope on the plan IR so the
 *  rest of the substrate could be built around the field. PB6 widens
 *  to the closed taxonomy in § B.7.1:
 *
 *    type ExtractionEventKind =
 *      | 'extraction.purchase' | 'extraction.plan' | 'extraction.commitment'
 *      | 'extraction.task'     | 'extraction.note' | 'extraction.preference'
 *      | 'extraction.commitment_status_check'
 *      | 'resolution.alias' | 'resolution.contact_created_mention_only'
 *      | 'resolution.network_domain_inferred';
 *
 *  And widens the per-event shape to:
 *
 *    interface ExtractionEvent {
 *      kind: ExtractionEventKind;
 *      confidence: number;            // 0..1
 *      args: Record<string, unknown>;
 *      source_message_id?: string;    // per-event undo + grouping
 *      subject_contact_id?: string;   // PB11 Person-Specific Automation
 *    }
 *
 *  PB6 also ships the confidence-tier dispatch primitives (§ B.7.7):
 *  high (≥ 0.85) → auto-save + render; medium (0.6..0.85) → queue for
 *  confirmation; low (< 0.6) → annotate source message only. The
 *  `dispatchKindForConfidence` helper is the single source of truth so
 *  every consumer (composer, undo registry, confirmation queue, audit
 *  emitter) reads the same thresholds.
 *
 *  Closed-list ratchets pin the taxonomy + the dispatch list + the
 *  threshold constants so adding a kind / drifting a threshold needs a
 *  substrate D-spec change. Composer / engine-side wiring lives in
 *  `packages/engine/src/ai-output/`.
 *
 *  Spec: § B.7.1 + § B.7.7 + § B.7.8 + § B.7.9 + § B.7.10 + § B.7.11. */

// ── PB6.1 — ExtractionEventKind (10 closed entries) ──────────────────

/** Closed list of extraction event kinds AI providers may emit in the
 *  parallel `events[]` AIOutput surface. Two semantic groups:
 *
 *    `extraction.*` — durable facts the user expressed (commitments,
 *      tasks, plans, notes, purchases, preferences, status checks).
 *      The composer-ordering rule places extractions AFTER resolutions
 *      that may introduce the entities they reference (§ B.7.8 rule 1).
 *
 *    `resolution.*` — identity-graph augmentations (alias resolved,
 *      mention-only contact stub created, network domain inferred).
 *      The composer-ordering rule places resolutions BEFORE extractions
 *      so a downstream `extraction.commitment` referencing the just-
 *      resolved contact reads coherently.
 *
 *  Order matters at runtime: `EXTRACTION_EVENT_KIND_ORDER` enumerates
 *  composer ordering priorities (§ B.7.8) — resolutions before
 *  extractions before derived effects. PB6's composer reads it. */
export const EXTRACTION_EVENT_KINDS = [
  // extraction.* — durable user-expressed facts
  'extraction.purchase',
  'extraction.plan',
  'extraction.commitment',
  'extraction.task',
  'extraction.note',
  'extraction.preference',
  'extraction.commitment_status_check',
  // resolution.* — identity-graph augmentations
  'resolution.alias',
  'resolution.contact_created_mention_only',
  'resolution.network_domain_inferred',
] as const;
export type ExtractionEventKind = (typeof EXTRACTION_EVENT_KINDS)[number];
export const EXTRACTION_EVENT_KIND_SET: ReadonlySet<ExtractionEventKind> = new Set(
  EXTRACTION_EVENT_KINDS,
);

/** Membership test — the single boundary check for parsed-JSON paths
 *  (AI provider outputs land as `unknown`; the composer narrows via
 *  this guard before stamping `ExtractionEvent`). */
export const isExtractionEventKind = (
  value: unknown,
): value is ExtractionEventKind =>
  typeof value === 'string' &&
  EXTRACTION_EVENT_KIND_SET.has(value as ExtractionEventKind);

// ── PB6.2 — Closed-list event class for ordering rules (§ B.7.8) ─────

/** Closed list of composer-ordering classes. § B.7.8 rule:
 *
 *    1. Resolutions before extractions that reference them
 *    2. Extractions before derived effects
 *    3. Stable order for same-class events (preserves AI-returned order)
 *
 *  Lower priority = renders earlier. `derived_effect` is a
 *  forward-compat slot for cascade events that route through the same
 *  surface (e.g. recipe-cascade events that hang off extractions) —
 *  none are emitted yet. PB6 itself only emits `resolution` +
 *  `extraction`. */
export const EXTRACTION_EVENT_CLASSES = [
  'resolution',
  'extraction',
  'derived_effect',
] as const;
export type ExtractionEventClass = (typeof EXTRACTION_EVENT_CLASSES)[number];
export const EXTRACTION_EVENT_CLASS_SET: ReadonlySet<ExtractionEventClass> = new Set(
  EXTRACTION_EVENT_CLASSES,
);

/** Composer ordering priority. The composer's stable sort reads this
 *  to satisfy § B.7.8 rule 1 + rule 2; tie-breaker is original AI-
 *  returned order (rule 3). */
export const EXTRACTION_EVENT_CLASS_PRIORITY: Readonly<
  Record<ExtractionEventClass, number>
> = Object.freeze({
  resolution: 0,
  extraction: 1,
  derived_effect: 2,
});

/** Map a kind to its composer class. The dispatch table is the
 *  substrate's single source of truth — adding a kind requires adding
 *  the class entry + the ratchet test pinning membership. */
export const classForExtractionEventKind = (
  kind: ExtractionEventKind,
): ExtractionEventClass => {
  if (kind.startsWith('resolution.')) return 'resolution';
  if (kind.startsWith('extraction.')) return 'extraction';
  // No `derived_effect` PB6-emitted kinds yet — closed-list exhaustive
  // case kept for forward compat (widens once cascade kinds land).
  throw new Error(`unknown extraction event class for kind: ${kind}`);
};

// ── PB6.3 — Confidence-tier dispatch (§ B.7.7) ───────────────────────

/** Closed list of dispatch decisions per § B.7.7. The composer reads
 *  the helper below; downstream consumers (undo registry, confirmation
 *  queue, audit emitter) discriminate on this list to route the event
 *  correctly. Adding a dispatch kind requires a substrate D-spec
 *  change. */
export const EVENT_DISPATCH_KINDS = [
  /** ≥ HIGH_CONFIDENCE_FLOOR — engine auto-saves the entity + renders
   *  the inline thought line in the Transparency Stream. */
  'auto_save',
  /** [MEDIUM_CONFIDENCE_FLOOR, HIGH_CONFIDENCE_FLOOR) — engine queues
   *  the event for user confirmation; render inline as "added to your
   *  review queue"; no entity write until the user confirms. */
  'queue_for_confirm',
  /** < MEDIUM_CONFIDENCE_FLOOR — engine annotates the source message
   *  only (no entity write, very softly rendered or hidden). */
  'annotate_only',
] as const;
export type EventDispatchKind = (typeof EVENT_DISPATCH_KINDS)[number];
export const EVENT_DISPATCH_KIND_SET: ReadonlySet<EventDispatchKind> = new Set(
  EVENT_DISPATCH_KINDS,
);

/** § B.7.7 high-confidence floor. ≥ 0.85 → auto-save. Substrate
 *  constant — drifting requires a substrate D-spec change. */
export const HIGH_CONFIDENCE_FLOOR = 0.85;

/** § B.7.7 medium-confidence floor. ∈ [0.6, 0.85) → queue for
 *  confirmation. Below this floor → annotate only. */
export const MEDIUM_CONFIDENCE_FLOOR = 0.6;

/** Map a confidence value to its dispatch kind. Inputs outside [0, 1]
 *  clamp to closest tier (NaN / negative → annotate_only;
 *  > 1 → auto_save). The substrate prefers under-claim over panic. */
export const dispatchKindForConfidence = (
  confidence: number,
): EventDispatchKind => {
  if (!Number.isFinite(confidence)) return 'annotate_only';
  if (confidence >= HIGH_CONFIDENCE_FLOOR) return 'auto_save';
  if (confidence >= MEDIUM_CONFIDENCE_FLOOR) return 'queue_for_confirm';
  return 'annotate_only';
};

// ── PB6.4 — Multi-event noise control (§ B.7.10) ─────────────────────

/** § B.7.10: "If a single message produces 6+ events, the inline
 *  thought stream collapses to a single summary line." Substrate
 *  constant — drifting requires a substrate D-spec change. The
 *  composer's `applyNoiseControl` reads this to decide between inline
 *  + collapsed-summary rendering. */
export const MULTI_EVENT_COLLAPSE_THRESHOLD = 6;

// ── PB6.5 — Closed-list typed event shape ────────────────────────────

/** § B.7.1 — closed extraction event shape. PB2 ship'ed an open
 *  envelope; PB6 narrows the union via `kind` + carries `confidence` +
 *  `args` + optional `source_message_id` (per-event undo + grouping;
 *  § B.7.9 + § B.7.11) + optional `subject_contact_id` (PB11 Person-
 *  Specific Automation trigger). */
export interface ExtractionEvent {
  /** Closed-list discriminator. */
  readonly kind: ExtractionEventKind;
  /** ∈ [0, 1] — caller's confidence. The dispatch tier helper clamps
   *  on out-of-range / NaN inputs; the runtime validator
   *  (`validateExtractionEventConfidence`) hard-fails on bad data
   *  before it reaches the composer. */
  readonly confidence: number;
  /** Event-class-specific positional payload. Closed `Record` shape;
   *  per-kind args contracts live in PB7's transparency-stream
   *  templates (kind-specific slot substitution). PB6 carries the
   *  bag verbatim. */
  readonly args: Readonly<Record<string, unknown>>;
  /** Source chat message id — required for per-event undo (§ B.7.9)
   *  + confirmation-queue batching (§ B.7.11) when present.
   *  Optional — AI providers may emit events untethered to a single
   *  message (e.g. cascade events post-action); composer routes those
   *  through the inline path without batching. */
  readonly source_message_id?: string;
  /** Subject contact id — when present + the kind is one PB11's
   *  `contact_topic_mention` watcher fires on, PB11 dispatches the
   *  per-contact `personal_recipes` chain. PB6 just carries the
   *  field; PB11 reads it. */
  readonly subject_contact_id?: string;
}

/** Closed-list rejection reasons emitted by
 *  `validateExtractionEventConfidence`. Composer / orchestrator pins
 *  the membership; ratchet test asserts the count. */
export const EXTRACTION_EVENT_VALIDATION_KINDS = [
  /** `kind` is not in `EXTRACTION_EVENT_KINDS`. */
  'unknown_kind',
  /** `confidence` is not a finite number. */
  'confidence_not_finite',
  /** `confidence` is finite but outside [0, 1]. */
  'confidence_out_of_range',
] as const;
export type ExtractionEventValidationKind =
  (typeof EXTRACTION_EVENT_VALIDATION_KINDS)[number];
export const EXTRACTION_EVENT_VALIDATION_KIND_SET: ReadonlySet<ExtractionEventValidationKind> =
  new Set(EXTRACTION_EVENT_VALIDATION_KINDS);

export interface ExtractionEventValidationIssue {
  readonly kind: ExtractionEventValidationKind;
  readonly detail?: string;
}

/** Validate a parsed event's `kind` + `confidence`. Returns a closed-
 *  list issue array (empty = valid). `args` shape contracts are PB7's
 *  job (per-kind slot validation); PB6 only owns the substrate's two
 *  load-bearing fields.
 *
 *  Codex P2 fold (2026-05-10) — accepts `unknown` because callers
 *  feed parsed AI provider output directly (an `events[]` array can
 *  contain `null` from a malformed JSON response). The substrate's
 *  shape gate must NEVER throw on bad input — every malformed shape
 *  surfaces as a closed-list issue so the orchestrator can stamp the
 *  malformed-AI-output halt path uniformly. */
export const validateExtractionEvent = (
  event: unknown,
): ReadonlyArray<ExtractionEventValidationIssue> => {
  const issues: ExtractionEventValidationIssue[] = [];
  // Untrusted-input guard — null / non-object inputs emit two
  // structural issues (mirroring the kind + confidence floor of a
  // valid event). The composer catches every shape problem at the
  // gate without throwing.
  if (event === null || typeof event !== 'object') {
    issues.push({ kind: 'unknown_kind', detail: String(event) });
    issues.push({
      kind: 'confidence_not_finite',
      detail: String(event),
    });
    return issues;
  }
  const e = event as { kind?: unknown; confidence?: unknown };
  if (!isExtractionEventKind(e.kind)) {
    issues.push({ kind: 'unknown_kind', detail: String(e.kind) });
  }
  if (!Number.isFinite(e.confidence)) {
    issues.push({
      kind: 'confidence_not_finite',
      detail: String(e.confidence),
    });
  } else if ((e.confidence as number) < 0 || (e.confidence as number) > 1) {
    issues.push({
      kind: 'confidence_out_of_range',
      detail: String(e.confidence),
    });
  }
  return issues;
};

// ── PB6.6 — Substrate self-check ─────────────────────────────────────

/** Defensive runtime check — every closed-list constant is non-empty
 *  + frozen + members are unique + thresholds are ordered. The
 *  orchestrator can call this at boot; PB6 ratchet asserts on the
 *  same invariants. */
export const assertExtractionEventInvariants = (): void => {
  const checkClosedList = <T extends string>(
    name: string,
    list: ReadonlyArray<T>,
    set: ReadonlySet<T>,
  ): void => {
    const length = list.length as number;
    if (length === 0) {
      throw new Error(`${name} must be non-empty`);
    }
    if (set.size !== length) {
      throw new Error(`${name} contains duplicates`);
    }
  };
  checkClosedList(
    'EXTRACTION_EVENT_KINDS',
    EXTRACTION_EVENT_KINDS,
    EXTRACTION_EVENT_KIND_SET,
  );
  checkClosedList(
    'EXTRACTION_EVENT_CLASSES',
    EXTRACTION_EVENT_CLASSES,
    EXTRACTION_EVENT_CLASS_SET,
  );
  checkClosedList(
    'EVENT_DISPATCH_KINDS',
    EVENT_DISPATCH_KINDS,
    EVENT_DISPATCH_KIND_SET,
  );
  checkClosedList(
    'EXTRACTION_EVENT_VALIDATION_KINDS',
    EXTRACTION_EVENT_VALIDATION_KINDS,
    EXTRACTION_EVENT_VALIDATION_KIND_SET,
  );
  // Per-class priority must include every class with a unique
  // numeric value; lowest renders first.
  const seen = new Set<number>();
  for (const cls of EXTRACTION_EVENT_CLASSES) {
    const p = EXTRACTION_EVENT_CLASS_PRIORITY[cls];
    if (!Number.isFinite(p)) {
      throw new Error(`EXTRACTION_EVENT_CLASS_PRIORITY['${cls}'] not finite`);
    }
    if (seen.has(p)) {
      throw new Error(
        `EXTRACTION_EVENT_CLASS_PRIORITY duplicate priority ${p} for '${cls}'`,
      );
    }
    seen.add(p);
  }
  // Threshold ordering — high > medium > 0.
  if (
    !(
      HIGH_CONFIDENCE_FLOOR > MEDIUM_CONFIDENCE_FLOOR &&
      MEDIUM_CONFIDENCE_FLOOR > 0 &&
      HIGH_CONFIDENCE_FLOOR <= 1
    )
  ) {
    throw new Error(
      'confidence floor ordering invariant violated: 0 < MEDIUM_CONFIDENCE_FLOOR < HIGH_CONFIDENCE_FLOOR ≤ 1',
    );
  }
  // Collapse threshold sanity — must be ≥ 2 (collapse only useful when
  // there's something to collapse).
  if (
    !Number.isInteger(MULTI_EVENT_COLLAPSE_THRESHOLD) ||
    MULTI_EVENT_COLLAPSE_THRESHOLD < 2
  ) {
    throw new Error(
      `MULTI_EVENT_COLLAPSE_THRESHOLD must be integer ≥ 2 (got ${MULTI_EVENT_COLLAPSE_THRESHOLD})`,
    );
  }
};

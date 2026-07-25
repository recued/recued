/** D-145 PB14 — Correction Learning primitive (contracts).
 *
 *  Per § B.14. Every undo / edit / merge / alias correction / rejected
 *  extraction / "don't use this context" event becomes a typed engine
 *  signal. The substrate ships:
 *
 *    1. A closed 9-kind taxonomy (§ B.14.1) — every shape AI providers
 *       or UI surfaces can emit through the substrate.
 *    2. A row shape `CorrectionEventRow` matching the SQLite table
 *       (§ B.14.2). Per-pair only — no cross-cloud sync (D-097 /
 *       D-168); never returned via MCP responses (per-pair private
 *       vocabulary).
 *    3. Pure helpers (`buildCorrectionSummary`, threshold +
 *       context-shaping projections) consumed by the engine at three
 *       decision points (§ B.14.3): pre-flight context shaping;
 *       extraction confidence re-calibration; AI synthesis prompt
 *       augmentation.
 *    4. Closed-list ratchet constants (durable kinds, retention
 *       window, threshold ladder) so substrate behavior is pinned at
 *       CI time.
 *
 *  Privacy invariants (§ B.14.4):
 *    - `correction_events` rows are per-pair only — substrate refuses
 *      cloud-sync wiring (`correction-events-per-pair-only.ratchet`).
 *    - Raw correction payloads referencing aliases / platform_ids /
 *      standing_instruction text are NEVER emitted to the AI packet —
 *      only the redacted aggregate summary from `buildCorrectionSummary`
 *      ever reaches `ai.synthesize`.
 *    - MCP visibility default-off; per-token override unsupported —
 *      `correction_events` is structurally never serialized through
 *      MCP responses.
 *
 *  Compaction (§ B.14.4):
 *    - Housekeeping prunes events with `event_at < now - 1y` EXCEPT
 *      kinds in `CORRECTION_EVENT_DURABLE_KINDS` (contact_merged,
 *      standing_instruction_added) which retain indefinitely.
 *
 *  Spec: `docs/d-145-spec.md` § B.14. */

import type { ExtractionEventKind } from './extraction-events.js';
import { isExtractionEventKind } from './extraction-events.js';

// ── PB14.1 — Closed-list correction event kinds (9 kinds) ───────────

/** § B.14.1 — closed 9-kind taxonomy. Every kind has a typed payload
 *  shape (see `CorrectionEvent` union below). Adding a kind requires
 *  substrate D-spec work + ratchet entry. */
export const CORRECTION_EVENT_KINDS = [
  'extraction_undone',
  'extraction_edited',
  'alias_corrected',
  'contact_merged',
  'rejected_extraction',
  'context_marked_omit',
  'plan_outcome_corrected',
  'standing_instruction_added',
  'transparency_event_dismissed',
] as const;
export type CorrectionEventKind = (typeof CORRECTION_EVENT_KINDS)[number];
export const CORRECTION_EVENT_KIND_SET: ReadonlySet<CorrectionEventKind> = new Set(
  CORRECTION_EVENT_KINDS,
);

/** Boundary check for parsed-JSON paths (UI surfaces / rpc inputs land
 *  as `unknown`; the store narrows via this guard before insert). */
export const isCorrectionEventKind = (value: unknown): value is CorrectionEventKind =>
  typeof value === 'string' &&
  CORRECTION_EVENT_KIND_SET.has(value as CorrectionEventKind);

// ── PB14.2 — Correction scope closed list ───────────────────────────

/** § B.14.1 + § B.14.2 — closed-list scope. The row's `scope` column
 *  must be one of these values; the per-payload `for_scope` mirror
 *  on `context_marked_omit` / `transparency_event_dismissed` reuses
 *  the same vocabulary, narrowed per kind.
 *
 *  Scope semantics drive § B.14.3 step 1 (pre-flight bias):
 *    - `this_request` — never persists beyond the issuing request;
 *      pre-flight skips these (they're inert by next turn).
 *    - `this_contact` — applies when current request involves the
 *      same contact_id; requires `subject_contact_id` populated on
 *      the payload.
 *    - `global` — always applies.
 *    - `this_session` — applies within the same chat session; pre-
 *      flight skips after the session ends (not load-bearing for
 *      AI packet bias; mostly transparency UI). */
export const CORRECTION_EVENT_SCOPES = [
  'this_request',
  'this_contact',
  'global',
  'this_session',
] as const;
export type CorrectionEventScope = (typeof CORRECTION_EVENT_SCOPES)[number];
export const CORRECTION_EVENT_SCOPE_SET: ReadonlySet<CorrectionEventScope> = new Set(
  CORRECTION_EVENT_SCOPES,
);

export const isCorrectionEventScope = (value: unknown): value is CorrectionEventScope =>
  typeof value === 'string' &&
  CORRECTION_EVENT_SCOPE_SET.has(value as CorrectionEventScope);

// ── PB14.3 — Per-kind payload shapes ────────────────────────────────

/** § B.14.1 reason vocabulary for `extraction_undone`. Drives § B.14.3
 *  step 2 (extraction-confidence re-calibration): only the
 *  `'low_confidence_should_have_skipped'` reason raises auto-save
 *  thresholds. Adding a value here is a substrate D-spec change. */
export const EXTRACTION_UNDONE_REASONS = [
  'wrong_class',
  'wrong_args',
  'unwanted',
  'low_confidence_should_have_skipped',
] as const;
export type ExtractionUndoneReason = (typeof EXTRACTION_UNDONE_REASONS)[number];
export const EXTRACTION_UNDONE_REASON_SET: ReadonlySet<ExtractionUndoneReason> = new Set(
  EXTRACTION_UNDONE_REASONS,
);

/** § B.14.1 D-138 attribution channels for `contact_merged`. */
export const CONTACT_MERGE_CHANNELS = ['d138_auto', 'user_initiated'] as const;
export type ContactMergeChannel = (typeof CONTACT_MERGE_CHANNELS)[number];
export const CONTACT_MERGE_CHANNEL_SET: ReadonlySet<ContactMergeChannel> = new Set(
  CONTACT_MERGE_CHANNELS,
);

/** § B.14.1 closed-list user-feedback vocabulary for
 *  `plan_outcome_corrected`. Drives § B.14.3 step 3 (correction-
 *  summary projection) — every feedback label maps to a flat
 *  aggregate counter key in `buildCorrectionSummary`. */
export const PLAN_OUTCOME_USER_FEEDBACK = [
  'wrong_action',
  'wrong_tone',
  'too_chatty',
  'too_terse',
  'right_action_wrong_args',
] as const;
export type PlanOutcomeUserFeedback = (typeof PLAN_OUTCOME_USER_FEEDBACK)[number];
export const PLAN_OUTCOME_USER_FEEDBACK_SET: ReadonlySet<PlanOutcomeUserFeedback> = new Set(
  PLAN_OUTCOME_USER_FEEDBACK,
);

/** § B.14.1 — per-kind payload union. Each kind's payload carries the
 *  fields needed for engine consumption + Settings UI rendering. The
 *  `kind` discriminator narrows the union; the row's `payload_blob`
 *  column stores the kind-specific fields excluding `kind` itself
 *  (which is the dedicated `kind` column on the row). */
export type CorrectionEvent =
  | {
      kind: 'extraction_undone';
      extraction_event_id: string;
      /** Which extraction kind the user undid (helps the re-calibration
       *  function bucket per fact_type). Optional — UI may emit it from
       *  the original event; substrate doesn't require it for storage
       *  but threshold re-calibration ignores undones missing this. */
      fact_type?: ExtractionEventKind;
      reason?: ExtractionUndoneReason;
    }
  | {
      kind: 'extraction_edited';
      extraction_event_id: string;
      /** What the user corrected the args to. Free-shape per AI provider;
       *  substrate stores opaque. */
      corrected_args: Readonly<Record<string, unknown>>;
      fact_type?: ExtractionEventKind;
    }
  | {
      kind: 'alias_corrected';
      reference: string;
      original_contact_id: string;
      corrected_contact_id: string;
    }
  | {
      kind: 'contact_merged';
      loser_contact_id: string;
      survivor_contact_id: string;
      via: ContactMergeChannel;
    }
  | {
      kind: 'rejected_extraction';
      extraction_event_id: string;
      fact_type?: ExtractionEventKind;
    }
  | {
      kind: 'context_marked_omit';
      source_ref: string;
      for_scope: CorrectionEventScope;
      /** Required when for_scope === 'this_contact'; ignored otherwise.
       *  The pre-flight bias function (§ B.14.3 step 1) filters
       *  per-contact corrections against the current request's
       *  subject contact via this field. */
      contact_id?: string;
    }
  | {
      kind: 'plan_outcome_corrected';
      plan_id: string;
      user_feedback: PlanOutcomeUserFeedback;
    }
  | {
      kind: 'standing_instruction_added';
      instruction_id: string;
      /** When the SI was added in response to a correction, the
       *  substrate links them so Settings UI can render the chain. */
      derived_from_correction?: string;
    }
  | {
      kind: 'transparency_event_dismissed';
      /** The dismissed transparency event class (closed list per PB7);
       *  PB7's `TransparencyEvent['kind']` widens this surface. The
       *  substrate stores opaque so PB7's closed list can evolve
       *  without churning the contracts. */
      event_kind: string;
      for_scope: 'this_session' | 'global';
    };

// ── PB14.4 — Row shape (SQLite) ─────────────────────────────────────

/** § B.14.2 — SQLite row shape. `payload_blob` is the kind-specific
 *  payload from `CorrectionEvent` MINUS the discriminator `kind`
 *  (`kind` is hoisted to its own column for the partial-index path).
 *
 *  Per-pair only — no cross-cloud sync (D-097 / D-168); never
 *  returned via MCP. The substrate enforces this by construction (no
 *  rpc emits rows through any cloud surface). */
export interface CorrectionEventRow {
  /** Substrate-generated UUID. Stable across retries. */
  readonly id: string;
  /** Ingestion time (Unix ms). When Recued recorded the correction. */
  readonly ts: number;
  /** Event time (Unix ms) — when the user actually issued the
   *  correction. D-120 P7.5 bistemporal alignment: pre-flight bias
   *  + threshold re-calibration window read `event_at`, not `ts`. */
  readonly event_at: number;
  readonly kind: CorrectionEventKind;
  /** Opaque JSON-encoded body. The substrate stores `CorrectionEvent`
   *  union minus the `kind` discriminator. */
  readonly payload_blob: Readonly<Record<string, unknown>>;
  /** Plan correlation (when the correction relates to a RecuedPlan). */
  readonly source_plan_id?: string;
  /** Extraction-event correlation (when the correction relates to a
   *  specific extraction event from a prior plan's events[] array). */
  readonly source_extraction_event_id?: string;
  /** Closed-list scope. The row's `scope` column drives § B.14.3
   *  step 1 (pre-flight bias) — `'global'` always applies;
   *  `'this_contact'` applies when the payload's `contact_id`
   *  matches the current request's subject contact. */
  readonly scope: CorrectionEventScope;
}

// ── PB14.5 — Closed-list validation issues ──────────────────────────

/** Validator issues — every membership check has a matching closed-
 *  list kind so the ratchet pins the surface. */
export const CORRECTION_EVENT_VALIDATION_ISSUE_KINDS = [
  /** `kind` missing / not in CORRECTION_EVENT_KINDS. */
  'kind_invalid',
  /** `scope` missing / not in CORRECTION_EVENT_SCOPES. */
  'scope_invalid',
  /** `id` missing / not a string / empty. */
  'id_invalid',
  /** `ts` or `event_at` missing / not finite / negative. */
  'timestamp_invalid',
  /** `payload_blob` missing / not an object. */
  'payload_invalid',
  /** Per-kind required field missing or wrong-typed. Detail carries
   *  the field name. */
  'payload_field_invalid',
  /** A reason / via / user_feedback / for_scope value is not in its
   *  closed list. */
  'closed_list_violation',
] as const;
export type CorrectionEventValidationIssueKind =
  (typeof CORRECTION_EVENT_VALIDATION_ISSUE_KINDS)[number];
export const CORRECTION_EVENT_VALIDATION_ISSUE_KIND_SET: ReadonlySet<CorrectionEventValidationIssueKind> =
  new Set(CORRECTION_EVENT_VALIDATION_ISSUE_KINDS);

export interface CorrectionEventValidationIssue {
  readonly kind: CorrectionEventValidationIssueKind;
  readonly detail?: string;
  /** When the issue is on a specific payload field, the field name. */
  readonly field?: string;
}

export class CorrectionEventValidationError extends Error {
  readonly code = 'CORRECTION_EVENT_VALIDATION_ERROR' as const;
  constructor(public readonly issues: ReadonlyArray<CorrectionEventValidationIssue>) {
    super(
      `correction_event failed validation: ${issues
        .map((i) => `${i.kind}${i.field ? `@${i.field}` : ''}`)
        .join(', ')}`,
    );
    this.name = 'CorrectionEventValidationError';
  }
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const isFiniteNonNegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Per-kind payload validator. Returns an issue list (empty = valid).
 *  Pure; never throws. The store calls this at insert time before the
 *  SQLite write — invalid rows are rejected at the substrate boundary. */
export const validateCorrectionEventPayload = (
  kind: CorrectionEventKind,
  payload: Readonly<Record<string, unknown>>,
): ReadonlyArray<CorrectionEventValidationIssue> => {
  const issues: CorrectionEventValidationIssue[] = [];
  const stringField = (field: string): void => {
    if (!isNonEmptyString(payload[field])) {
      issues.push({ kind: 'payload_field_invalid', field, detail: String(payload[field]) });
    }
  };
  const closedListField = <T extends string>(
    field: string,
    set: ReadonlySet<T>,
  ): void => {
    const value = payload[field];
    if (!isNonEmptyString(value) || !set.has(value as T)) {
      issues.push({ kind: 'closed_list_violation', field, detail: String(value) });
    }
  };
  switch (kind) {
    case 'extraction_undone':
      stringField('extraction_event_id');
      if (payload.reason !== undefined) {
        if (
          typeof payload.reason !== 'string' ||
          !EXTRACTION_UNDONE_REASON_SET.has(payload.reason as ExtractionUndoneReason)
        ) {
          issues.push({ kind: 'closed_list_violation', field: 'reason', detail: String(payload.reason) });
        }
      }
      if (payload.fact_type !== undefined && !isExtractionEventKind(payload.fact_type)) {
        issues.push({ kind: 'closed_list_violation', field: 'fact_type', detail: String(payload.fact_type) });
      }
      break;
    case 'extraction_edited':
      stringField('extraction_event_id');
      if (!isPlainObject(payload.corrected_args)) {
        issues.push({ kind: 'payload_field_invalid', field: 'corrected_args', detail: String(payload.corrected_args) });
      }
      if (payload.fact_type !== undefined && !isExtractionEventKind(payload.fact_type)) {
        issues.push({ kind: 'closed_list_violation', field: 'fact_type', detail: String(payload.fact_type) });
      }
      break;
    case 'alias_corrected':
      stringField('reference');
      stringField('original_contact_id');
      stringField('corrected_contact_id');
      break;
    case 'contact_merged':
      stringField('loser_contact_id');
      stringField('survivor_contact_id');
      closedListField('via', CONTACT_MERGE_CHANNEL_SET);
      break;
    case 'rejected_extraction':
      stringField('extraction_event_id');
      if (payload.fact_type !== undefined && !isExtractionEventKind(payload.fact_type)) {
        issues.push({ kind: 'closed_list_violation', field: 'fact_type', detail: String(payload.fact_type) });
      }
      break;
    case 'context_marked_omit':
      stringField('source_ref');
      closedListField('for_scope', CORRECTION_EVENT_SCOPE_SET);
      // contact_id required when for_scope === 'this_contact'.
      if (payload.for_scope === 'this_contact' && !isNonEmptyString(payload.contact_id)) {
        issues.push({
          kind: 'payload_field_invalid',
          field: 'contact_id',
          detail: 'required when for_scope === \'this_contact\'',
        });
      }
      break;
    case 'plan_outcome_corrected':
      stringField('plan_id');
      closedListField('user_feedback', PLAN_OUTCOME_USER_FEEDBACK_SET);
      break;
    case 'standing_instruction_added':
      stringField('instruction_id');
      if (
        payload.derived_from_correction !== undefined &&
        !isNonEmptyString(payload.derived_from_correction)
      ) {
        issues.push({
          kind: 'payload_field_invalid',
          field: 'derived_from_correction',
          detail: String(payload.derived_from_correction),
        });
      }
      break;
    case 'transparency_event_dismissed':
      stringField('event_kind');
      // for_scope narrows to 'this_session' | 'global' on this kind
      // (not the full 4-scope list). The closed-list check uses a
      // narrowed set built inline.
      if (payload.for_scope !== 'this_session' && payload.for_scope !== 'global') {
        issues.push({
          kind: 'closed_list_violation',
          field: 'for_scope',
          detail: String(payload.for_scope),
        });
      }
      break;
  }
  return issues;
};

/** Validate a full row (envelope + payload). Pure; never throws.
 *  Empty array = valid. */
export const validateCorrectionEventRow = (
  row: unknown,
): ReadonlyArray<CorrectionEventValidationIssue> => {
  const issues: CorrectionEventValidationIssue[] = [];
  if (!isPlainObject(row)) {
    issues.push({ kind: 'payload_invalid', detail: 'row must be an object' });
    return issues;
  }
  const r = row as Record<string, unknown>;
  if (!isNonEmptyString(r.id)) {
    issues.push({ kind: 'id_invalid', detail: String(r.id) });
  }
  if (!isFiniteNonNegative(r.ts)) {
    issues.push({ kind: 'timestamp_invalid', field: 'ts', detail: String(r.ts) });
  }
  if (!isFiniteNonNegative(r.event_at)) {
    issues.push({ kind: 'timestamp_invalid', field: 'event_at', detail: String(r.event_at) });
  }
  if (!isCorrectionEventKind(r.kind)) {
    issues.push({ kind: 'kind_invalid', detail: String(r.kind) });
  }
  if (!isCorrectionEventScope(r.scope)) {
    issues.push({ kind: 'scope_invalid', detail: String(r.scope) });
  }
  if (!isPlainObject(r.payload_blob)) {
    issues.push({ kind: 'payload_invalid', detail: String(r.payload_blob) });
  }
  if (
    r.source_plan_id !== undefined &&
    r.source_plan_id !== null &&
    !isNonEmptyString(r.source_plan_id)
  ) {
    issues.push({ kind: 'payload_field_invalid', field: 'source_plan_id', detail: String(r.source_plan_id) });
  }
  if (
    r.source_extraction_event_id !== undefined &&
    r.source_extraction_event_id !== null &&
    !isNonEmptyString(r.source_extraction_event_id)
  ) {
    issues.push({
      kind: 'payload_field_invalid',
      field: 'source_extraction_event_id',
      detail: String(r.source_extraction_event_id),
    });
  }
  // Per-kind payload validation only if envelope passed; otherwise
  // the per-kind validator can't read kind/payload.
  if (isCorrectionEventKind(r.kind) && isPlainObject(r.payload_blob)) {
    const perKind = validateCorrectionEventPayload(r.kind, r.payload_blob);
    for (const issue of perKind) issues.push(issue);
    // Codex P2 fold (2026-05-10) — substrate-level scope canonicality.
    // Kinds that carry `for_scope` in the payload MUST have the row's
    // `scope` column agree, so the store-side scope-filter queries and
    // the engine-side hook (which reads `row.scope` as canonical) can
    // never disagree. Without this gate, a parsed-JSON path could
    // persist a row scoped `this_request` at the row level but
    // `global` in the payload — store filters would skip it (correct),
    // but a hook reading payload.for_scope would apply it (wrong).
    // The row.scope column is canonical; the payload field is mirror.
    if (
      (r.kind === 'context_marked_omit' || r.kind === 'transparency_event_dismissed') &&
      isCorrectionEventScope(r.scope)
    ) {
      const payloadForScope = (r.payload_blob as Record<string, unknown>).for_scope;
      if (
        typeof payloadForScope === 'string' &&
        payloadForScope.length > 0 &&
        payloadForScope !== r.scope
      ) {
        issues.push({
          kind: 'closed_list_violation',
          field: 'for_scope',
          detail: `payload.for_scope '${payloadForScope}' must equal row.scope '${r.scope}'`,
        });
      }
    }
  }
  return issues;
};

/** Throwing variant for storage paths. */
export const assertValidCorrectionEventRow = (row: unknown): void => {
  const issues = validateCorrectionEventRow(row);
  if (issues.length > 0) throw new CorrectionEventValidationError(issues);
};

// ── PB14.6 — Durable-kind list (compaction exception) ──────────────

/** § B.14.4 — kinds the housekeeping pruner retains indefinitely
 *  even past the 1-year window. `contact_merged` is durable substrate
 *  state — D-138's merge ledger needs the audit row alive for replay.
 *  `standing_instruction_added` is the persistent link between an SI
 *  + the correction that motivated it; deleting it breaks Settings UI
 *  provenance. */
export const CORRECTION_EVENT_DURABLE_KINDS: ReadonlyArray<CorrectionEventKind> = [
  'contact_merged',
  'standing_instruction_added',
];
export const CORRECTION_EVENT_DURABLE_KIND_SET: ReadonlySet<CorrectionEventKind> = new Set(
  CORRECTION_EVENT_DURABLE_KINDS,
);

/** Default retention window in ms (1 year per § B.14.4). The
 *  housekeeping task computes `cutoff = now - this` and prunes
 *  non-durable kinds with `event_at < cutoff`. */
export const CORRECTION_EVENT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

// ── PB14.7 — Engine consumption: threshold re-calibration constants ─

/** § B.14.3 step 2 — stepwise threshold ladder for extraction confidence
 *  re-calibration. Defaults: auto-save threshold starts at 0.85;
 *  re-calibration raises stepwise to 0.90 then 0.95 (capped) per ≥3
 *  `extraction_undone: { reason: 'low_confidence_should_have_skipped' }`
 *  events for the same fact_type in the recent window. The converse
 *  (rejected_extraction ≥3 lowering the threshold) walks the ladder
 *  in reverse.
 *
 *  The substrate ships the ladder as a closed array; the engine reads
 *  it once + binary-searches. Adjusting the ladder is a substrate
 *  D-spec change. */
export const EXTRACTION_THRESHOLD_LADDER: ReadonlyArray<number> = [0.85, 0.9, 0.95];

/** Minimum count of same-direction corrections to trigger a threshold
 *  step. Mirrors § B.14.3 step 2's `≥ 3 times` floor. */
export const EXTRACTION_THRESHOLD_TRIGGER_COUNT = 3;

/** Recency window for threshold re-calibration. `event_at` events
 *  outside this window don't count toward the trigger. */
export const EXTRACTION_THRESHOLD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// ── PB14.8 — Correction summary (AI packet field) ───────────────────

/** § B.14.3 step 3 — `correction_summary` AI-packet field shape. Flat
 *  key→count projection so the AI sees aggregate patterns ("user
 *  recently corrected 4 too_chatty plans") without ever seeing raw
 *  correction payloads (which may reference alias text or social
 *  context per § B.14.4). The substrate enforces flat-shape by
 *  construction — `buildCorrectionSummary` returns
 *  `Record<string, number>` and the AI packet composer (which no
 *  live caller wires yet) treats it as opaque metadata. */
export type CorrectionSummary = Readonly<Record<string, number>>;

// ── PB14.9 — Substrate self-check ───────────────────────────────────

/** Defensive runtime check — every closed list is non-empty + frozen
 *  + unique. The orchestrator calls this at boot; ratchet asserts on
 *  the same invariants.
 *
 *  Length comparisons go through a `number` widening so TS doesn't
 *  narrow the literal-tuple `length` to its compile-time value
 *  (mirrors the pattern in `personal-recipes.ts` +
 *  `extraction-events.ts`). */
export const assertCorrectionEventInvariants = (): void => {
  const kindLen = CORRECTION_EVENT_KINDS.length as number;
  if (kindLen === 0) throw new Error('CORRECTION_EVENT_KINDS must be non-empty');
  if (CORRECTION_EVENT_KIND_SET.size !== kindLen) {
    throw new Error('CORRECTION_EVENT_KINDS contains duplicates');
  }
  const scopeLen = CORRECTION_EVENT_SCOPES.length as number;
  if (scopeLen === 0) throw new Error('CORRECTION_EVENT_SCOPES must be non-empty');
  if (CORRECTION_EVENT_SCOPE_SET.size !== scopeLen) {
    throw new Error('CORRECTION_EVENT_SCOPES contains duplicates');
  }
  const reasonLen = EXTRACTION_UNDONE_REASONS.length as number;
  if (reasonLen === 0) throw new Error('EXTRACTION_UNDONE_REASONS must be non-empty');
  if (EXTRACTION_UNDONE_REASON_SET.size !== reasonLen) {
    throw new Error('EXTRACTION_UNDONE_REASONS contains duplicates');
  }
  const channelLen = CONTACT_MERGE_CHANNELS.length as number;
  if (channelLen === 0) throw new Error('CONTACT_MERGE_CHANNELS must be non-empty');
  if (CONTACT_MERGE_CHANNEL_SET.size !== channelLen) {
    throw new Error('CONTACT_MERGE_CHANNELS contains duplicates');
  }
  const feedbackLen = PLAN_OUTCOME_USER_FEEDBACK.length as number;
  if (feedbackLen === 0) throw new Error('PLAN_OUTCOME_USER_FEEDBACK must be non-empty');
  if (PLAN_OUTCOME_USER_FEEDBACK_SET.size !== feedbackLen) {
    throw new Error('PLAN_OUTCOME_USER_FEEDBACK contains duplicates');
  }
  const issueLen = CORRECTION_EVENT_VALIDATION_ISSUE_KINDS.length as number;
  if (issueLen === 0) throw new Error('CORRECTION_EVENT_VALIDATION_ISSUE_KINDS must be non-empty');
  if (CORRECTION_EVENT_VALIDATION_ISSUE_KIND_SET.size !== issueLen) {
    throw new Error('CORRECTION_EVENT_VALIDATION_ISSUE_KINDS contains duplicates');
  }
  const durableLen = CORRECTION_EVENT_DURABLE_KINDS.length as number;
  if (durableLen === 0) throw new Error('CORRECTION_EVENT_DURABLE_KINDS must be non-empty');
  if (CORRECTION_EVENT_DURABLE_KIND_SET.size !== durableLen) {
    throw new Error('CORRECTION_EVENT_DURABLE_KINDS contains duplicates');
  }
  // Durable kinds must all be valid CorrectionEventKinds.
  for (const k of CORRECTION_EVENT_DURABLE_KINDS) {
    if (!CORRECTION_EVENT_KIND_SET.has(k)) {
      throw new Error(`CORRECTION_EVENT_DURABLE_KINDS contains unknown kind: ${k}`);
    }
  }
  // Threshold ladder must be ascending in (0, 1).
  for (let i = 0; i < EXTRACTION_THRESHOLD_LADDER.length; i++) {
    const v = EXTRACTION_THRESHOLD_LADDER[i];
    if (typeof v !== 'number' || !(v > 0 && v < 1)) {
      throw new Error(`EXTRACTION_THRESHOLD_LADDER[${i}] must be in (0, 1)`);
    }
    if (i > 0 && v <= EXTRACTION_THRESHOLD_LADDER[i - 1]) {
      throw new Error(`EXTRACTION_THRESHOLD_LADDER must be strictly ascending`);
    }
  }
  if (!(EXTRACTION_THRESHOLD_TRIGGER_COUNT > 0)) {
    throw new Error('EXTRACTION_THRESHOLD_TRIGGER_COUNT must be > 0');
  }
  if (!(EXTRACTION_THRESHOLD_WINDOW_MS > 0)) {
    throw new Error('EXTRACTION_THRESHOLD_WINDOW_MS must be > 0');
  }
  if (!(CORRECTION_EVENT_RETENTION_MS > 0)) {
    throw new Error('CORRECTION_EVENT_RETENTION_MS must be > 0');
  }
};

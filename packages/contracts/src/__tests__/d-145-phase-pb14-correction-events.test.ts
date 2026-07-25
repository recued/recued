/** D-145 PB14 — Correction Learning contract tests.
 *
 *  Covers PB14.1-PB14.9 against § B.14.
 *
 *  Slices:
 *    - Closed-list discipline (9 kinds / 4 scopes / undone reasons /
 *      merge channels / user feedback / validation issue kinds /
 *      durable kinds).
 *    - Substrate self-check (`assertCorrectionEventInvariants`).
 *    - Membership predicates (`isCorrectionEventKind` /
 *      `isCorrectionEventScope`).
 *    - Per-kind payload validator coverage.
 *    - Row envelope validator coverage.
 *    - Durable-kind subset is well-formed (every entry in
 *      CORRECTION_EVENT_KINDS).
 *    - Ladder + window + retention constants well-formed.
 *
 *  Spec: D-145 § B.14. */

import { describe, expect, it } from 'vitest';

import {
  CONTACT_MERGE_CHANNELS,
  CONTACT_MERGE_CHANNEL_SET,
  CORRECTION_EVENT_DURABLE_KINDS,
  CORRECTION_EVENT_DURABLE_KIND_SET,
  CORRECTION_EVENT_KIND_SET,
  CORRECTION_EVENT_KINDS,
  CORRECTION_EVENT_RETENTION_MS,
  CORRECTION_EVENT_SCOPE_SET,
  CORRECTION_EVENT_SCOPES,
  CORRECTION_EVENT_VALIDATION_ISSUE_KIND_SET,
  CORRECTION_EVENT_VALIDATION_ISSUE_KINDS,
  CorrectionEventValidationError,
  EXTRACTION_THRESHOLD_LADDER,
  EXTRACTION_THRESHOLD_TRIGGER_COUNT,
  EXTRACTION_THRESHOLD_WINDOW_MS,
  EXTRACTION_UNDONE_REASON_SET,
  EXTRACTION_UNDONE_REASONS,
  PLAN_OUTCOME_USER_FEEDBACK,
  PLAN_OUTCOME_USER_FEEDBACK_SET,
  assertCorrectionEventInvariants,
  assertValidCorrectionEventRow,
  isCorrectionEventKind,
  isCorrectionEventScope,
  validateCorrectionEventPayload,
  validateCorrectionEventRow,
  type CorrectionEventKind,
  type CorrectionEventRow,
} from '../index.js';

const FIXED_NOW = 1_715_000_000_000;

const baseRow = (patch: Partial<CorrectionEventRow> = {}): CorrectionEventRow => ({
  id: 'correction-row-1',
  ts: FIXED_NOW,
  event_at: FIXED_NOW,
  kind: 'extraction_undone',
  payload_blob: { extraction_event_id: 'evt-1' },
  scope: 'global',
  ...patch,
});

// ── PB14.1 — Closed-list discipline ─────────────────────────────────

describe('PB14 closed lists', () => {
  it('CORRECTION_EVENT_KINDS contains exactly the 9 spec kinds', () => {
    expect(CORRECTION_EVENT_KINDS).toEqual([
      'extraction_undone',
      'extraction_edited',
      'alias_corrected',
      'contact_merged',
      'rejected_extraction',
      'context_marked_omit',
      'plan_outcome_corrected',
      'standing_instruction_added',
      'transparency_event_dismissed',
    ]);
  });

  it('CORRECTION_EVENT_KIND_SET has the same membership', () => {
    expect(CORRECTION_EVENT_KIND_SET.size).toBe(CORRECTION_EVENT_KINDS.length);
    for (const kind of CORRECTION_EVENT_KINDS) {
      expect(CORRECTION_EVENT_KIND_SET.has(kind)).toBe(true);
    }
  });

  it('CORRECTION_EVENT_SCOPES contains the 4 spec scopes', () => {
    expect(CORRECTION_EVENT_SCOPES).toEqual([
      'this_request',
      'this_contact',
      'global',
      'this_session',
    ]);
    expect(CORRECTION_EVENT_SCOPE_SET.size).toBe(4);
  });

  it('EXTRACTION_UNDONE_REASONS matches the spec set', () => {
    expect(EXTRACTION_UNDONE_REASONS).toEqual([
      'wrong_class',
      'wrong_args',
      'unwanted',
      'low_confidence_should_have_skipped',
    ]);
    expect(EXTRACTION_UNDONE_REASON_SET.size).toBe(4);
  });

  it('CONTACT_MERGE_CHANNELS matches the D-138 channels', () => {
    expect(CONTACT_MERGE_CHANNELS).toEqual(['d138_auto', 'user_initiated']);
    expect(CONTACT_MERGE_CHANNEL_SET.size).toBe(2);
  });

  it('PLAN_OUTCOME_USER_FEEDBACK matches the spec set', () => {
    expect(PLAN_OUTCOME_USER_FEEDBACK).toEqual([
      'wrong_action',
      'wrong_tone',
      'too_chatty',
      'too_terse',
      'right_action_wrong_args',
    ]);
    expect(PLAN_OUTCOME_USER_FEEDBACK_SET.size).toBe(5);
  });

  it('CORRECTION_EVENT_VALIDATION_ISSUE_KINDS is non-empty + unique', () => {
    expect(CORRECTION_EVENT_VALIDATION_ISSUE_KINDS.length).toBeGreaterThan(0);
    expect(CORRECTION_EVENT_VALIDATION_ISSUE_KIND_SET.size).toBe(
      CORRECTION_EVENT_VALIDATION_ISSUE_KINDS.length,
    );
  });

  it('CORRECTION_EVENT_DURABLE_KINDS is the 2-entry compaction exception list', () => {
    expect(CORRECTION_EVENT_DURABLE_KINDS).toEqual([
      'contact_merged',
      'standing_instruction_added',
    ]);
    expect(CORRECTION_EVENT_DURABLE_KIND_SET.size).toBe(2);
  });

  it('durable-kind list members are all valid CorrectionEventKinds', () => {
    for (const k of CORRECTION_EVENT_DURABLE_KINDS) {
      expect(CORRECTION_EVENT_KIND_SET.has(k)).toBe(true);
    }
  });

  it('retention window is 1 year', () => {
    expect(CORRECTION_EVENT_RETENTION_MS).toBe(365 * 24 * 60 * 60 * 1000);
  });

  it('extraction threshold ladder is the 0.85/0.90/0.95 ascending', () => {
    expect(EXTRACTION_THRESHOLD_LADDER).toEqual([0.85, 0.9, 0.95]);
  });

  it('extraction threshold trigger count is 3', () => {
    expect(EXTRACTION_THRESHOLD_TRIGGER_COUNT).toBe(3);
  });

  it('extraction threshold window is 30 days', () => {
    expect(EXTRACTION_THRESHOLD_WINDOW_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

// ── PB14.2 — Substrate self-check ───────────────────────────────────

describe('PB14 substrate self-check', () => {
  it('assertCorrectionEventInvariants passes on the shipped registry', () => {
    expect(() => assertCorrectionEventInvariants()).not.toThrow();
  });
});

// ── PB14.3 — Membership predicates ──────────────────────────────────

describe('PB14 membership predicates', () => {
  it('isCorrectionEventKind matches every closed-list entry', () => {
    for (const kind of CORRECTION_EVENT_KINDS) {
      expect(isCorrectionEventKind(kind)).toBe(true);
    }
    expect(isCorrectionEventKind('not_a_kind')).toBe(false);
    expect(isCorrectionEventKind(null)).toBe(false);
    expect(isCorrectionEventKind(42)).toBe(false);
  });

  it('isCorrectionEventScope matches every closed-list entry', () => {
    for (const scope of CORRECTION_EVENT_SCOPES) {
      expect(isCorrectionEventScope(scope)).toBe(true);
    }
    expect(isCorrectionEventScope('garbage')).toBe(false);
    expect(isCorrectionEventScope(undefined)).toBe(false);
  });
});

// ── PB14.4 — Per-kind payload validator ─────────────────────────────

describe('PB14 per-kind payload validator', () => {
  it('extraction_undone — minimal valid payload passes', () => {
    expect(
      validateCorrectionEventPayload('extraction_undone', {
        extraction_event_id: 'evt-1',
      }),
    ).toEqual([]);
  });

  it('extraction_undone — known reason passes', () => {
    expect(
      validateCorrectionEventPayload('extraction_undone', {
        extraction_event_id: 'evt-1',
        reason: 'low_confidence_should_have_skipped',
      }),
    ).toEqual([]);
  });

  it('extraction_undone — unknown reason flagged', () => {
    const issues = validateCorrectionEventPayload('extraction_undone', {
      extraction_event_id: 'evt-1',
      reason: 'mysterious',
    });
    expect(issues.some((i) => i.kind === 'closed_list_violation' && i.field === 'reason')).toBe(true);
  });

  it('extraction_undone — missing extraction_event_id flagged', () => {
    const issues = validateCorrectionEventPayload('extraction_undone', {});
    expect(issues.some((i) => i.field === 'extraction_event_id')).toBe(true);
  });

  it('extraction_edited — requires corrected_args object', () => {
    const issues = validateCorrectionEventPayload('extraction_edited', {
      extraction_event_id: 'evt-1',
      corrected_args: 'not an object',
    });
    expect(issues.some((i) => i.field === 'corrected_args')).toBe(true);
  });

  it('alias_corrected — requires reference + original + corrected', () => {
    expect(
      validateCorrectionEventPayload('alias_corrected', {
        reference: 'Bob',
        original_contact_id: 'c1',
        corrected_contact_id: 'c2',
      }),
    ).toEqual([]);
    expect(
      validateCorrectionEventPayload('alias_corrected', {
        reference: 'Bob',
        original_contact_id: 'c1',
      }).some((i) => i.field === 'corrected_contact_id'),
    ).toBe(true);
  });

  it('contact_merged — unknown via channel flagged', () => {
    const issues = validateCorrectionEventPayload('contact_merged', {
      loser_contact_id: 'c1',
      survivor_contact_id: 'c2',
      via: 'rogue_channel',
    });
    expect(issues.some((i) => i.kind === 'closed_list_violation' && i.field === 'via')).toBe(true);
  });

  it('contact_merged — d138_auto channel passes', () => {
    expect(
      validateCorrectionEventPayload('contact_merged', {
        loser_contact_id: 'c1',
        survivor_contact_id: 'c2',
        via: 'd138_auto',
      }),
    ).toEqual([]);
  });

  it('rejected_extraction — minimal payload passes', () => {
    expect(
      validateCorrectionEventPayload('rejected_extraction', {
        extraction_event_id: 'evt-2',
      }),
    ).toEqual([]);
  });

  it('context_marked_omit — for_scope=this_contact requires contact_id', () => {
    const issues = validateCorrectionEventPayload('context_marked_omit', {
      source_ref: 'data.social.facebook',
      for_scope: 'this_contact',
    });
    expect(issues.some((i) => i.field === 'contact_id')).toBe(true);
    expect(
      validateCorrectionEventPayload('context_marked_omit', {
        source_ref: 'data.social.facebook',
        for_scope: 'this_contact',
        contact_id: 'c-bob',
      }),
    ).toEqual([]);
  });

  it('context_marked_omit — global scope does not need contact_id', () => {
    expect(
      validateCorrectionEventPayload('context_marked_omit', {
        source_ref: 'data.social.x',
        for_scope: 'global',
      }),
    ).toEqual([]);
  });

  it('plan_outcome_corrected — unknown feedback flagged', () => {
    const issues = validateCorrectionEventPayload('plan_outcome_corrected', {
      plan_id: 'plan-1',
      user_feedback: 'meh',
    });
    expect(issues.some((i) => i.field === 'user_feedback')).toBe(true);
  });

  it('plan_outcome_corrected — too_chatty feedback passes', () => {
    expect(
      validateCorrectionEventPayload('plan_outcome_corrected', {
        plan_id: 'plan-1',
        user_feedback: 'too_chatty',
      }),
    ).toEqual([]);
  });

  it('standing_instruction_added — minimal payload passes', () => {
    expect(
      validateCorrectionEventPayload('standing_instruction_added', {
        instruction_id: 'si-1',
      }),
    ).toEqual([]);
  });

  it('transparency_event_dismissed — only this_session / global allowed', () => {
    expect(
      validateCorrectionEventPayload('transparency_event_dismissed', {
        event_kind: 'engine.catalog_assembled',
        for_scope: 'this_request',
      }).some((i) => i.field === 'for_scope'),
    ).toBe(true);
    expect(
      validateCorrectionEventPayload('transparency_event_dismissed', {
        event_kind: 'engine.catalog_assembled',
        for_scope: 'this_session',
      }),
    ).toEqual([]);
  });
});

// ── PB14.5 — Row envelope validator ─────────────────────────────────

describe('PB14 row envelope validator', () => {
  it('valid row passes both validators', () => {
    expect(validateCorrectionEventRow(baseRow())).toEqual([]);
    expect(() => assertValidCorrectionEventRow(baseRow())).not.toThrow();
  });

  it('missing id is flagged', () => {
    const issues = validateCorrectionEventRow(baseRow({ id: '' as unknown as string }));
    expect(issues.some((i) => i.kind === 'id_invalid')).toBe(true);
  });

  it('non-finite ts is flagged', () => {
    const issues = validateCorrectionEventRow(baseRow({ ts: NaN as unknown as number }));
    expect(issues.some((i) => i.kind === 'timestamp_invalid' && i.field === 'ts')).toBe(true);
  });

  it('negative event_at is flagged', () => {
    const issues = validateCorrectionEventRow(baseRow({ event_at: -1 }));
    expect(issues.some((i) => i.kind === 'timestamp_invalid' && i.field === 'event_at')).toBe(true);
  });

  it('unknown kind is flagged', () => {
    const issues = validateCorrectionEventRow(
      baseRow({ kind: 'not_a_kind' as unknown as CorrectionEventKind }),
    );
    expect(issues.some((i) => i.kind === 'kind_invalid')).toBe(true);
  });

  it('unknown scope is flagged', () => {
    const row = { ...baseRow(), scope: 'mystery' as unknown as CorrectionEventRow['scope'] };
    const issues = validateCorrectionEventRow(row);
    expect(issues.some((i) => i.kind === 'scope_invalid')).toBe(true);
  });

  it('non-object payload_blob is flagged', () => {
    const issues = validateCorrectionEventRow({
      ...baseRow(),
      payload_blob: 'not an object' as unknown as Record<string, unknown>,
    });
    expect(issues.some((i) => i.kind === 'payload_invalid')).toBe(true);
  });

  it('assertValidCorrectionEventRow throws CorrectionEventValidationError on bad row', () => {
    expect(() =>
      assertValidCorrectionEventRow({ ...baseRow(), kind: 'bogus' } as unknown as CorrectionEventRow),
    ).toThrow(CorrectionEventValidationError);
  });

  it('row with non-object input is flagged', () => {
    const issues = validateCorrectionEventRow(null);
    expect(issues.some((i) => i.kind === 'payload_invalid')).toBe(true);
  });

  it('source_plan_id and source_extraction_event_id may be omitted', () => {
    const row = baseRow();
    expect(row.source_plan_id).toBeUndefined();
    expect(row.source_extraction_event_id).toBeUndefined();
    expect(validateCorrectionEventRow(row)).toEqual([]);
  });

  it('source_plan_id non-string is flagged', () => {
    const issues = validateCorrectionEventRow({
      ...baseRow(),
      source_plan_id: 42 as unknown as string,
    });
    expect(issues.some((i) => i.field === 'source_plan_id')).toBe(true);
  });

  it('source_extraction_event_id null is permitted (sqlite-friendly)', () => {
    const issues = validateCorrectionEventRow({
      ...baseRow(),
      source_extraction_event_id: null as unknown as undefined,
    });
    expect(issues).toEqual([]);
  });
});

// ── Codex P2 fold — scope canonicality validator ───────────────────

describe('PB14 Codex P2 fold — scope canonicality', () => {
  it('context_marked_omit row.scope must equal payload.for_scope', () => {
    const issues = validateCorrectionEventRow({
      ...baseRow(),
      kind: 'context_marked_omit',
      scope: 'this_request',
      payload_blob: {
        source_ref: 'data.social.x',
        for_scope: 'global', // disagrees with row.scope
      },
    });
    expect(
      issues.some((i) => i.kind === 'closed_list_violation' && i.field === 'for_scope'),
    ).toBe(true);
  });

  it('context_marked_omit row.scope === payload.for_scope passes', () => {
    expect(
      validateCorrectionEventRow({
        ...baseRow(),
        kind: 'context_marked_omit',
        scope: 'global',
        payload_blob: {
          source_ref: 'data.social.x',
          for_scope: 'global',
        },
      }),
    ).toEqual([]);
  });

  it('transparency_event_dismissed row.scope must equal payload.for_scope', () => {
    const issues = validateCorrectionEventRow({
      ...baseRow(),
      kind: 'transparency_event_dismissed',
      scope: 'global',
      payload_blob: {
        event_kind: 'engine.catalog_assembled',
        for_scope: 'this_session', // disagrees with row.scope
      },
    });
    expect(
      issues.some((i) => i.kind === 'closed_list_violation' && i.field === 'for_scope'),
    ).toBe(true);
  });

  it('non-for_scope-carrying kinds are not constrained', () => {
    // extraction_undone has no for_scope field — the validator must
    // not invent a constraint on these rows.
    expect(
      validateCorrectionEventRow({
        ...baseRow(),
        kind: 'extraction_undone',
        scope: 'this_request',
        payload_blob: { extraction_event_id: 'evt-1' },
      }),
    ).toEqual([]);
  });
});


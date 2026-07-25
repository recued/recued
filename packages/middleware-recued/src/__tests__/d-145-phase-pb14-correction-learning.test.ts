/** D-145 PB14 — Correction Learning engine consumption tests.
 *
 *  Covers PB14.10-PB14.12 (the three pure engine hooks):
 *
 *    Hook 1 — `computeContextShapingBiases`
 *      - global scope → bias emitted
 *      - this_contact + matching contact_id → bias emitted
 *      - this_contact + mismatched contact_id → no bias
 *      - this_request / this_session → never apply
 *      - dedupe by source_ref (newest wins)
 *      - reason_detail format `derived_from_correction:<id>`
 *
 *    Hook 2 — `computeExtractionThresholdAdjustment`
 *      - default base 0.85 with no corrections → 0.85
 *      - ≥ 3 extraction_undone (low_confidence_should_have_skipped)
 *        for fact_type in window → step up to 0.90
 *      - already at 0.90 + ≥ 3 more → 0.95 (cap)
 *      - already at 0.95 + ≥ 3 more → still 0.95 (cap)
 *      - ≥ 3 rejected_extraction for fact_type → step down to 0.85
 *        (or floor)
 *      - different fact_type corrections don't affect this fact_type
 *      - corrections outside 30d window don't count
 *      - both undone + rejected ≥ 3 → undone wins (safer direction)
 *      - corrections without fact_type are ignored
 *
 *    Hook 3 — `buildCorrectionSummary`
 *      - plan_outcome_corrected too_chatty count → bumped key
 *      - alias_corrected per contact_id → keyed by corrected_contact_id
 *      - extraction_undone aggregate counter bumped
 *      - rejected_extraction aggregate counter bumped
 *      - raw payload bodies NEVER copied into summary keys (privacy
 *        invariant)
 *      - corrections older than the window are excluded
 *      - kinds outside the projection map are ignored (no spurious keys)
 *
 *  Spec: `docs/d-145-spec.md` § B.14.3 (steps 1-3). */

import { describe, expect, it } from 'vitest';

import type {
  CorrectionEventRow,
  ExtractionEventKind,
} from '@recued/contracts';
import { EXTRACTION_THRESHOLD_WINDOW_MS } from '@recued/contracts';

import {
  buildCorrectionSummary,
  computeContextShapingBiases,
  computeExtractionThresholdAdjustment,
  DEFAULT_EXTRACTION_AUTO_SAVE_THRESHOLD,
} from '../correction-learning/index.js';

// ── Helpers ─────────────────────────────────────────────────────────

const NOW = 1_715_000_000_000;

let rowSeq = 0;
const row = (
  patch: Partial<CorrectionEventRow> & { kind: CorrectionEventRow['kind'] },
): CorrectionEventRow => {
  rowSeq += 1;
  return {
    id: `correction-${rowSeq}`,
    ts: NOW,
    event_at: NOW,
    payload_blob: {},
    scope: 'global',
    ...patch,
  };
};

// ── Hook 1 — pre-flight context shaping ─────────────────────────────

describe('PB14 Hook 1 — computeContextShapingBiases', () => {
  it('emits a bias for a global-scope context_marked_omit', () => {
    const result = computeContextShapingBiases({
      rows: [
        row({
          kind: 'context_marked_omit',
          payload_blob: { source_ref: 'data.social.facebook', for_scope: 'global' },
        }),
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0].source_ref).toBe('data.social.facebook');
    expect(result[0].reason_code).toBe('permission_scope');
    expect(result[0].content_stored).toBe(false);
    expect(result[0].reason_detail.startsWith('derived_from_correction:')).toBe(true);
  });

  it('this_contact scope applies when contact_id matches current request', () => {
    const result = computeContextShapingBiases({
      rows: [
        row({
          kind: 'context_marked_omit',
          payload_blob: {
            source_ref: 'data.social.x',
            for_scope: 'this_contact',
            contact_id: 'bob-id',
          },
        }),
      ],
      current_contact_id: 'bob-id',
    });
    expect(result).toHaveLength(1);
  });

  it('this_contact scope does not apply when contact_id mismatches', () => {
    const result = computeContextShapingBiases({
      rows: [
        row({
          kind: 'context_marked_omit',
          scope: 'this_contact',
          payload_blob: {
            source_ref: 'data.social.x',
            for_scope: 'this_contact',
            contact_id: 'bob-id',
          },
        }),
      ],
      current_contact_id: 'alice-id',
    });
    expect(result).toEqual([]);
  });

  it('this_contact without current_contact_id never applies', () => {
    const result = computeContextShapingBiases({
      rows: [
        row({
          kind: 'context_marked_omit',
          scope: 'this_contact',
          payload_blob: {
            source_ref: 'data.social.x',
            for_scope: 'this_contact',
            contact_id: 'bob-id',
          },
        }),
      ],
    });
    expect(result).toEqual([]);
  });

  it('this_request and this_session are inert across requests', () => {
    const result = computeContextShapingBiases({
      rows: [
        row({
          kind: 'context_marked_omit',
          scope: 'this_request',
          payload_blob: {
            source_ref: 'data.social.x',
            for_scope: 'this_request',
          },
        }),
        row({
          kind: 'context_marked_omit',
          scope: 'this_session',
          payload_blob: {
            source_ref: 'data.social.y',
            for_scope: 'this_session',
          },
        }),
      ],
    });
    expect(result).toEqual([]);
  });

  it('dedupes by source_ref — only the first (newest) bias is emitted', () => {
    // Caller passes newest-first per idx_correction_kind_time.
    const result = computeContextShapingBiases({
      rows: [
        row({
          id: 'newer',
          kind: 'context_marked_omit',
          payload_blob: { source_ref: 'data.social.x', for_scope: 'global' },
        }),
        row({
          id: 'older',
          kind: 'context_marked_omit',
          payload_blob: { source_ref: 'data.social.x', for_scope: 'global' },
        }),
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0].reason_detail).toContain('newer');
  });

  it('non-context_marked_omit kinds are skipped', () => {
    const result = computeContextShapingBiases({
      rows: [
        row({ kind: 'extraction_undone', payload_blob: { extraction_event_id: 'evt-1' } }),
        row({
          kind: 'plan_outcome_corrected',
          payload_blob: { plan_id: 'plan-1', user_feedback: 'too_chatty' },
        }),
      ],
    });
    expect(result).toEqual([]);
  });

  it('malformed source_ref is skipped (defensive)', () => {
    const result = computeContextShapingBiases({
      rows: [
        row({
          kind: 'context_marked_omit',
          payload_blob: { source_ref: '', for_scope: 'global' },
        }),
        row({
          kind: 'context_marked_omit',
          payload_blob: { source_ref: 42, for_scope: 'global' },
        }),
      ],
    });
    expect(result).toEqual([]);
  });

  it('unknown row.scope is skipped (defensive — parsed-JSON drift guard)', () => {
    // The contracts validator rejects unknown scopes at insert time;
    // this guard is a defense-in-depth for parsed-JSON paths where the
    // substrate validator hasn't run (e.g. direct rpc body parsing
    // that skipped the row validator). The hook's `else` branch maps
    // any non-this_contact, non-global to "skip".
    const result = computeContextShapingBiases({
      rows: [
        {
          ...row({
            kind: 'context_marked_omit',
            payload_blob: { source_ref: 'data.social.x', for_scope: 'global' },
          }),
          scope: 'rogue' as unknown as 'global',
        },
      ],
    });
    expect(result).toEqual([]);
  });

  // Codex P2 fold (2026-05-10) — row.scope is canonical; if a parsed-
  // JSON path persists a row with `scope='this_request'` but
  // payload's for_scope='global', the hook must trust the row column
  // (store-side scope-filter queries also read the column).
  it('reads row.scope as canonical, not payload.for_scope', () => {
    const result = computeContextShapingBiases({
      rows: [
        row({
          kind: 'context_marked_omit',
          scope: 'this_request', // row column wins
          payload_blob: { source_ref: 'data.social.x', for_scope: 'global' },
        }),
      ],
    });
    expect(result).toEqual([]);
  });

  it('row.scope=global yields a bias regardless of payload.for_scope drift', () => {
    const result = computeContextShapingBiases({
      rows: [
        row({
          kind: 'context_marked_omit',
          scope: 'global',
          payload_blob: { source_ref: 'data.social.x', for_scope: 'this_request' },
        }),
      ],
    });
    expect(result).toHaveLength(1);
  });

  it('row.scope=this_contact requires payload contact_id + current_contact_id match', () => {
    const matching = computeContextShapingBiases({
      rows: [
        row({
          kind: 'context_marked_omit',
          scope: 'this_contact',
          payload_blob: {
            source_ref: 'data.social.x',
            for_scope: 'this_contact',
            contact_id: 'bob-id',
          },
        }),
      ],
      current_contact_id: 'bob-id',
    });
    expect(matching).toHaveLength(1);
    const mismatched = computeContextShapingBiases({
      rows: [
        row({
          kind: 'context_marked_omit',
          scope: 'this_contact',
          payload_blob: {
            source_ref: 'data.social.x',
            for_scope: 'this_contact',
            contact_id: 'bob-id',
          },
        }),
      ],
      current_contact_id: 'alice-id',
    });
    expect(mismatched).toEqual([]);
  });
});

// ── Hook 2 — extraction confidence re-calibration ───────────────────

describe('PB14 Hook 2 — computeExtractionThresholdAdjustment', () => {
  const FACT: ExtractionEventKind = 'extraction.commitment';

  it('default base returns 0.85 with no corrections', () => {
    expect(
      computeExtractionThresholdAdjustment({
        rows: [],
        fact_type: FACT,
        now: NOW,
      }),
    ).toBe(0.85);
    expect(DEFAULT_EXTRACTION_AUTO_SAVE_THRESHOLD).toBe(0.85);
  });

  const undoneRow = (overrides: Partial<CorrectionEventRow> = {}): CorrectionEventRow =>
    row({
      kind: 'extraction_undone',
      payload_blob: {
        extraction_event_id: `e-${rowSeq + 1}`,
        fact_type: FACT,
        reason: 'low_confidence_should_have_skipped',
      },
      ...overrides,
    });

  it('≥ 3 extraction_undone (low_confidence) in window → 0.90', () => {
    expect(
      computeExtractionThresholdAdjustment({
        rows: [undoneRow(), undoneRow(), undoneRow()],
        fact_type: FACT,
        now: NOW,
      }),
    ).toBe(0.9);
  });

  it('< 3 extraction_undone → stays at base', () => {
    expect(
      computeExtractionThresholdAdjustment({
        rows: [undoneRow(), undoneRow()],
        fact_type: FACT,
        now: NOW,
      }),
    ).toBe(0.85);
  });

  it('already at 0.90 + 3 more undone → 0.95 (cap)', () => {
    expect(
      computeExtractionThresholdAdjustment({
        rows: [undoneRow(), undoneRow(), undoneRow()],
        fact_type: FACT,
        now: NOW,
        base_threshold: 0.9,
      }),
    ).toBe(0.95);
  });

  it('already at 0.95 + 3 more undone → still 0.95 (cap)', () => {
    expect(
      computeExtractionThresholdAdjustment({
        rows: [undoneRow(), undoneRow(), undoneRow()],
        fact_type: FACT,
        now: NOW,
        base_threshold: 0.95,
      }),
    ).toBe(0.95);
  });

  it('≥ 3 rejected_extraction in window → step down', () => {
    const rejected = (): CorrectionEventRow =>
      row({
        kind: 'rejected_extraction',
        payload_blob: { extraction_event_id: `e-${rowSeq + 1}`, fact_type: FACT },
      });
    expect(
      computeExtractionThresholdAdjustment({
        rows: [rejected(), rejected(), rejected()],
        fact_type: FACT,
        now: NOW,
        base_threshold: 0.9,
      }),
    ).toBe(0.85);
  });

  it('rejected_extraction at base → stays at base (floor)', () => {
    const rejected = (): CorrectionEventRow =>
      row({
        kind: 'rejected_extraction',
        payload_blob: { extraction_event_id: `e-${rowSeq + 1}`, fact_type: FACT },
      });
    expect(
      computeExtractionThresholdAdjustment({
        rows: [rejected(), rejected(), rejected()],
        fact_type: FACT,
        now: NOW,
        base_threshold: 0.85,
      }),
    ).toBe(0.85);
  });

  it('different fact_type corrections do not influence this fact_type', () => {
    const otherFact: ExtractionEventKind = 'extraction.preference';
    expect(
      computeExtractionThresholdAdjustment({
        rows: [
          undoneRow({ payload_blob: { extraction_event_id: 'x', fact_type: otherFact, reason: 'low_confidence_should_have_skipped' } }),
          undoneRow({ payload_blob: { extraction_event_id: 'y', fact_type: otherFact, reason: 'low_confidence_should_have_skipped' } }),
          undoneRow({ payload_blob: { extraction_event_id: 'z', fact_type: otherFact, reason: 'low_confidence_should_have_skipped' } }),
        ],
        fact_type: FACT,
        now: NOW,
      }),
    ).toBe(0.85);
  });

  it('corrections outside 30d window are excluded', () => {
    const oldUndone = (): CorrectionEventRow =>
      row({
        kind: 'extraction_undone',
        event_at: NOW - EXTRACTION_THRESHOLD_WINDOW_MS - 1,
        payload_blob: {
          extraction_event_id: `e-${rowSeq + 1}`,
          fact_type: FACT,
          reason: 'low_confidence_should_have_skipped',
        },
      });
    expect(
      computeExtractionThresholdAdjustment({
        rows: [oldUndone(), oldUndone(), oldUndone()],
        fact_type: FACT,
        now: NOW,
      }),
    ).toBe(0.85);
  });

  it('undone + rejected both ≥ 3 → undone wins (safer direction)', () => {
    const rejected = (): CorrectionEventRow =>
      row({
        kind: 'rejected_extraction',
        payload_blob: { extraction_event_id: `e-${rowSeq + 1}`, fact_type: FACT },
      });
    expect(
      computeExtractionThresholdAdjustment({
        rows: [
          undoneRow(),
          undoneRow(),
          undoneRow(),
          rejected(),
          rejected(),
          rejected(),
        ],
        fact_type: FACT,
        now: NOW,
        base_threshold: 0.9,
      }),
    ).toBe(0.95);
  });

  it('undone events without low_confidence reason do NOT count', () => {
    expect(
      computeExtractionThresholdAdjustment({
        rows: [
          undoneRow({ payload_blob: { extraction_event_id: 'a', fact_type: FACT, reason: 'wrong_args' } }),
          undoneRow({ payload_blob: { extraction_event_id: 'b', fact_type: FACT, reason: 'wrong_class' } }),
          undoneRow({ payload_blob: { extraction_event_id: 'c', fact_type: FACT, reason: 'unwanted' } }),
        ],
        fact_type: FACT,
        now: NOW,
      }),
    ).toBe(0.85);
  });

  it('corrections without fact_type are ignored', () => {
    expect(
      computeExtractionThresholdAdjustment({
        rows: [
          row({ kind: 'extraction_undone', payload_blob: { extraction_event_id: 'a', reason: 'low_confidence_should_have_skipped' } }),
          row({ kind: 'extraction_undone', payload_blob: { extraction_event_id: 'b', reason: 'low_confidence_should_have_skipped' } }),
          row({ kind: 'extraction_undone', payload_blob: { extraction_event_id: 'c', reason: 'low_confidence_should_have_skipped' } }),
        ],
        fact_type: FACT,
        now: NOW,
      }),
    ).toBe(0.85);
  });

  it('off-ladder base_threshold snaps to nearest lower rung before walking', () => {
    expect(
      computeExtractionThresholdAdjustment({
        rows: [undoneRow(), undoneRow(), undoneRow()],
        fact_type: FACT,
        now: NOW,
        base_threshold: 0.88, // between 0.85 and 0.9 → snaps down to 0.85, then walks → 0.9
      }),
    ).toBe(0.9);
  });
});

// ── Hook 3 — AI synthesis prompt augmentation ──────────────────────

describe('PB14 Hook 3 — buildCorrectionSummary', () => {
  it('plan_outcome_corrected too_chatty bumps tone_too_chatty_recent_corrections', () => {
    const summary = buildCorrectionSummary({
      rows: [
        row({
          kind: 'plan_outcome_corrected',
          payload_blob: { plan_id: 'p1', user_feedback: 'too_chatty' },
        }),
        row({
          kind: 'plan_outcome_corrected',
          payload_blob: { plan_id: 'p2', user_feedback: 'too_chatty' },
        }),
      ],
      now: NOW,
    });
    expect(summary['tone_too_chatty_recent_corrections']).toBe(2);
  });

  it('alias_corrected keys by corrected_contact_id (NOT raw alias text)', () => {
    const summary = buildCorrectionSummary({
      rows: [
        row({
          kind: 'alias_corrected',
          payload_blob: {
            reference: 'Bob @ Workday', // raw text — must NOT appear in keys
            original_contact_id: 'c-bob-wrong',
            corrected_contact_id: 'c-bob-right',
          },
        }),
        row({
          kind: 'alias_corrected',
          payload_blob: {
            reference: 'Bobby',
            original_contact_id: 'c-bob-wrong',
            corrected_contact_id: 'c-bob-right',
          },
        }),
      ],
      now: NOW,
    });
    expect(summary['wrong_alias_corrections_for_c-bob-right']).toBe(2);
    // Privacy invariant — raw alias text never reaches the summary.
    for (const key of Object.keys(summary)) {
      expect(key.includes('Bob @ Workday')).toBe(false);
      expect(key.includes('Bobby')).toBe(false);
    }
  });

  it('extraction_undone aggregate counter bumped', () => {
    const summary = buildCorrectionSummary({
      rows: [
        row({ kind: 'extraction_undone', payload_blob: { extraction_event_id: 'e1' } }),
        row({ kind: 'extraction_undone', payload_blob: { extraction_event_id: 'e2' } }),
      ],
      now: NOW,
    });
    expect(summary['recent_extraction_undones']).toBe(2);
  });

  it('rejected_extraction aggregate counter bumped', () => {
    const summary = buildCorrectionSummary({
      rows: [
        row({ kind: 'rejected_extraction', payload_blob: { extraction_event_id: 'e1' } }),
      ],
      now: NOW,
    });
    expect(summary['recent_rejected_extractions']).toBe(1);
  });

  it('rows outside the recency window are excluded', () => {
    const summary = buildCorrectionSummary({
      rows: [
        row({
          kind: 'plan_outcome_corrected',
          event_at: NOW - EXTRACTION_THRESHOLD_WINDOW_MS - 1,
          payload_blob: { plan_id: 'p1', user_feedback: 'too_chatty' },
        }),
      ],
      now: NOW,
    });
    expect(summary['tone_too_chatty_recent_corrections']).toBeUndefined();
  });

  it('kinds outside the projection map produce no spurious keys', () => {
    const summary = buildCorrectionSummary({
      rows: [
        row({
          kind: 'contact_merged',
          payload_blob: { loser_contact_id: 'a', survivor_contact_id: 'b', via: 'd138_auto' },
        }),
        row({
          kind: 'standing_instruction_added',
          payload_blob: { instruction_id: 'si-1' },
        }),
        row({
          kind: 'transparency_event_dismissed',
          payload_blob: { event_kind: 'engine.catalog_assembled', for_scope: 'this_session' },
        }),
      ],
      now: NOW,
    });
    expect(Object.keys(summary)).toEqual([]);
  });

  it('returns a frozen object (immutable contract)', () => {
    const summary = buildCorrectionSummary({ rows: [], now: NOW });
    expect(Object.isFrozen(summary)).toBe(true);
  });

  it('window override controls inclusion window', () => {
    const summary = buildCorrectionSummary({
      rows: [
        row({
          kind: 'plan_outcome_corrected',
          event_at: NOW - 2 * EXTRACTION_THRESHOLD_WINDOW_MS,
          payload_blob: { plan_id: 'p1', user_feedback: 'too_chatty' },
        }),
      ],
      now: NOW,
      window_ms: 3 * EXTRACTION_THRESHOLD_WINDOW_MS,
    });
    expect(summary['tone_too_chatty_recent_corrections']).toBe(1);
  });

  it('alias_corrected with missing corrected_contact_id is silently skipped', () => {
    const summary = buildCorrectionSummary({
      rows: [
        row({
          kind: 'alias_corrected',
          payload_blob: {
            reference: 'Bobby',
            original_contact_id: 'c-old',
            corrected_contact_id: '',
          },
        }),
      ],
      now: NOW,
    });
    expect(Object.keys(summary)).toEqual([]);
  });
});

// ── Privacy invariant — Hook 3 redaction at AI-packet time ─────────

describe('PB14 privacy — buildCorrectionSummary projection redacts', () => {
  it('alias_corrected raw `reference` text never reaches summary keys or values', () => {
    const summary = buildCorrectionSummary({
      rows: [
        row({
          kind: 'alias_corrected',
          payload_blob: {
            reference: 'super-secret-alias-text-that-must-not-leak',
            original_contact_id: 'c1',
            corrected_contact_id: 'c2',
          },
        }),
      ],
      now: NOW,
    });
    const serialized = JSON.stringify(summary);
    expect(serialized.includes('super-secret-alias-text-that-must-not-leak')).toBe(false);
  });

  it('standing_instruction_added body text never reaches summary keys or values', () => {
    const summary = buildCorrectionSummary({
      rows: [
        row({
          kind: 'standing_instruction_added',
          payload_blob: {
            instruction_id: 'si-1',
            body_text: 'secret-policy-body-text-that-must-not-leak',
          },
        }),
      ],
      now: NOW,
    });
    const serialized = JSON.stringify(summary);
    expect(serialized.includes('secret-policy-body-text-that-must-not-leak')).toBe(false);
  });
});

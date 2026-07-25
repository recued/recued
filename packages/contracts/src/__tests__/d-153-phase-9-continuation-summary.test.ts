/** D-153 P9 - Continuation summary substrate.
 *
 *  Pins the pure contracts from packages/contracts/src/continuation-summary.ts:
 *  closed source/trigger/reason lists, summary-row narrowing, current-summary
 *  precedence, constructors, lazy trigger decisions, and summarizer output
 *  narrowing.
 *
 *  Spec: docs/d-153-spec.md lines 587-597. */

import { describe, expect, it } from 'vitest';

import {
  CONTINUATION_SUMMARY_SOURCES,
  CONTINUATION_SUMMARY_TEXT_MAX_BYTES,
  SUMMARIZE_DECISION_REASONS,
  SUMMARIZE_TRIGGER_OCCASIONS,
  applyUserEditToContinuationSummary,
  buildCognitionSummary,
  evaluateSummarizeTrigger,
  isContinuationSummary,
  isContinuationSummarySource,
  isHandoffSummarizationResult,
  isSummarizeDecisionReason,
  isSummarizeTriggerOccasion,
  selectCurrentContinuationSummary,
  type ContinuationSummary,
  type ContinuationSummarySource,
  type SummarizeDecisionReason,
  type SummarizeTriggerOccasion,
} from '../index.js';

const EXPECTED_CONTINUATION_SUMMARY_SOURCES: readonly ContinuationSummarySource[] = [
  'cognition',
  'user_edit',
] as const;

const EXPECTED_SUMMARIZE_TRIGGER_OCCASIONS: readonly SummarizeTriggerOccasion[] = [
  'continuation',
  'session_close',
] as const;

const EXPECTED_SUMMARIZE_DECISION_REASONS: readonly SummarizeDecisionReason[] = [
  'continuation_first_load',
  'summary_already_exists',
  'lazy_deferral',
] as const;

const makeCognitionSummary = (
  overrides: Partial<ContinuationSummary> = {},
): ContinuationSummary => ({
  summary_id: 'summary-cognition-1',
  channel_session_id: 'channel-1',
  summary_text: 'cognition handoff',
  source: 'cognition',
  created_at: 1_000,
  cognition_session_id: 'cognition-1',
  ...overrides,
});

const makeUserEditSummary = (
  overrides: Partial<ContinuationSummary> = {},
): ContinuationSummary => ({
  summary_id: 'summary-user-edit-1',
  channel_session_id: 'channel-1',
  summary_text: 'user edited handoff',
  source: 'user_edit',
  created_at: 2_000,
  ...overrides,
});

const withoutField = (
  summary: ContinuationSummary,
  field: keyof ContinuationSummary,
): Record<string, unknown> => {
  const copy = { ...summary } as Record<string, unknown>;
  delete copy[field];
  return copy;
};

describe('D-153 P9 - closed lists and predicates', () => {
  it('CONTINUATION_SUMMARY_SOURCES is the exact two-source closed list', () => {
    expect(CONTINUATION_SUMMARY_SOURCES).toEqual(
      EXPECTED_CONTINUATION_SUMMARY_SOURCES,
    );
  });

  it('isContinuationSummarySource accepts every closed-list value', () => {
    for (const source of EXPECTED_CONTINUATION_SUMMARY_SOURCES) {
      expect(isContinuationSummarySource(source)).toBe(true);
    }
  });

  it('isContinuationSummarySource rejects unknown strings and non-strings', () => {
    for (const value of ['invalid', '', 0, null, undefined]) {
      expect(isContinuationSummarySource(value)).toBe(false);
    }
  });

  it('pins CONTINUATION_SUMMARY_TEXT_MAX_BYTES to 16 KiB', () => {
    expect(CONTINUATION_SUMMARY_TEXT_MAX_BYTES).toBe(16_384);
  });

  it('SUMMARIZE_TRIGGER_OCCASIONS is the exact two-occasion closed list', () => {
    expect(SUMMARIZE_TRIGGER_OCCASIONS).toEqual(
      EXPECTED_SUMMARIZE_TRIGGER_OCCASIONS,
    );
  });

  it('isSummarizeTriggerOccasion accepts every closed-list value', () => {
    for (const occasion of EXPECTED_SUMMARIZE_TRIGGER_OCCASIONS) {
      expect(isSummarizeTriggerOccasion(occasion)).toBe(true);
    }
  });

  it('isSummarizeTriggerOccasion rejects unknown strings and non-strings', () => {
    for (const value of ['invalid', 'session-close', '', 0, null, undefined]) {
      expect(isSummarizeTriggerOccasion(value)).toBe(false);
    }
  });

  it('SUMMARIZE_DECISION_REASONS is the exact three-reason closed list', () => {
    expect(SUMMARIZE_DECISION_REASONS).toEqual(
      EXPECTED_SUMMARIZE_DECISION_REASONS,
    );
  });

  it('isSummarizeDecisionReason accepts every closed-list value', () => {
    for (const reason of EXPECTED_SUMMARIZE_DECISION_REASONS) {
      expect(isSummarizeDecisionReason(reason)).toBe(true);
    }
  });

  it('isSummarizeDecisionReason rejects unknown strings and non-strings', () => {
    for (const value of ['invalid', 'already_exists', '', 0, null, undefined]) {
      expect(isSummarizeDecisionReason(value)).toBe(false);
    }
  });
});

describe('D-153 P9 - isContinuationSummary', () => {
  it('accepts a valid cognition row with cognition provenance', () => {
    expect(isContinuationSummary(makeCognitionSummary())).toBe(true);
  });

  it('accepts a valid user_edit row without cognition provenance', () => {
    expect(isContinuationSummary(makeUserEditSummary())).toBe(true);
  });

  it('accepts an empty summary_text string', () => {
    expect(isContinuationSummary(makeCognitionSummary({ summary_text: '' }))).toBe(
      true,
    );
  });

  it('rejects an empty summary_id', () => {
    expect(isContinuationSummary(makeCognitionSummary({ summary_id: '' }))).toBe(
      false,
    );
  });

  it('rejects an empty channel_session_id', () => {
    expect(isContinuationSummary(makeCognitionSummary({
      channel_session_id: '',
    }))).toBe(false);
  });

  it('rejects an unknown source', () => {
    expect(isContinuationSummary({
      ...makeCognitionSummary(),
      source: 'manual',
    })).toBe(false);
  });

  it('rejects non-finite created_at values', () => {
    for (const created_at of [
      Number.POSITIVE_INFINITY,
      Number.NaN,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(isContinuationSummary(makeCognitionSummary({ created_at }))).toBe(
        false,
      );
    }
  });

  it('rejects a cognition row missing cognition_session_id', () => {
    expect(isContinuationSummary(
      withoutField(makeCognitionSummary(), 'cognition_session_id'),
    )).toBe(false);
  });

  it('rejects a cognition row with an empty cognition_session_id', () => {
    expect(isContinuationSummary(makeCognitionSummary({
      cognition_session_id: '',
    }))).toBe(false);
  });

  it('rejects a user_edit row carrying cognition_session_id', () => {
    expect(isContinuationSummary({
      ...makeUserEditSummary(),
      cognition_session_id: 'cognition-1',
    })).toBe(false);
  });

  it('rejects non-object, null, and array values', () => {
    for (const value of [undefined, null, 'summary', 42, true, []]) {
      expect(isContinuationSummary(value)).toBe(false);
    }
  });
});

describe('D-153 P9 - selectCurrentContinuationSummary', () => {
  it('returns undefined for an empty array', () => {
    expect(selectCurrentContinuationSummary([], 'channel-1')).toBeUndefined();
  });

  it('returns undefined when no row matches channel_session_id', () => {
    expect(selectCurrentContinuationSummary([
      makeCognitionSummary({ channel_session_id: 'channel-other' }),
    ], 'channel-1')).toBeUndefined();
  });

  it('filters to rows for the requested channel_session_id', () => {
    const requested = makeCognitionSummary({
      summary_id: 'requested',
      channel_session_id: 'channel-1',
      created_at: 100,
    });
    const otherChannel = makeUserEditSummary({
      summary_id: 'other-channel',
      channel_session_id: 'channel-2',
      created_at: 9_999,
    });

    expect(selectCurrentContinuationSummary([
      otherChannel,
      requested,
    ], 'channel-1')).toBe(requested);
  });

  it('selects user_edit over cognition even when cognition has a later created_at', () => {
    const cognition = makeCognitionSummary({
      summary_id: 'later-cognition',
      created_at: 9_999,
    });
    const userEdit = makeUserEditSummary({
      summary_id: 'earlier-user-edit',
      created_at: 100,
    });

    expect(selectCurrentContinuationSummary([cognition, userEdit], 'channel-1')).toBe(
      userEdit,
    );
  });

  it('selects the later created_at among rows with the same source', () => {
    const older = makeUserEditSummary({
      summary_id: 'older-edit',
      created_at: 100,
    });
    const newer = makeUserEditSummary({
      summary_id: 'newer-edit',
      created_at: 200,
    });

    expect(selectCurrentContinuationSummary([newer, older], 'channel-1')).toBe(
      newer,
    );
  });

  it('uses lower summary_id code-point as the same-source timestamp tie-break', () => {
    const higherId = makeUserEditSummary({
      summary_id: 'b',
      created_at: 100,
    });
    const lowerId = makeUserEditSummary({
      summary_id: 'a',
      created_at: 100,
    });

    expect(selectCurrentContinuationSummary([higherId, lowerId], 'channel-1')).toBe(
      lowerId,
    );
  });

  it('selects each channel independently in a multi-channel array', () => {
    const channelOneCognition = makeCognitionSummary({
      summary_id: 'channel-1-cognition',
      channel_session_id: 'channel-1',
      created_at: 9_999,
    });
    const channelOneEdit = makeUserEditSummary({
      summary_id: 'channel-1-edit',
      channel_session_id: 'channel-1',
      created_at: 100,
    });
    const channelTwoOlderEdit = makeUserEditSummary({
      summary_id: 'channel-2-older-edit',
      channel_session_id: 'channel-2',
      created_at: 200,
    });
    const channelTwoNewerEdit = makeUserEditSummary({
      summary_id: 'channel-2-newer-edit',
      channel_session_id: 'channel-2',
      created_at: 300,
    });

    const summaries = [
      channelOneCognition,
      channelTwoOlderEdit,
      channelOneEdit,
      channelTwoNewerEdit,
    ];

    expect(selectCurrentContinuationSummary(summaries, 'channel-1')).toBe(
      channelOneEdit,
    );
    expect(selectCurrentContinuationSummary(summaries, 'channel-2')).toBe(
      channelTwoNewerEdit,
    );
  });
});

describe('D-153 P9 - buildCognitionSummary', () => {
  it('builds a valid cognition summary with exact metadata and provenance', () => {
    const summary = buildCognitionSummary({
      summary_id: 'summary-built',
      channel_session_id: 'channel-built',
      summary_text: 'built handoff',
      cognition_session_id: 'cognition-built',
      created_at: 1_234,
    });

    expect(summary).toEqual({
      summary_id: 'summary-built',
      channel_session_id: 'channel-built',
      summary_text: 'built handoff',
      source: 'cognition',
      created_at: 1_234,
      cognition_session_id: 'cognition-built',
    });
    expect(isContinuationSummary(summary)).toBe(true);
  });
});

describe('D-153 P9 - applyUserEditToContinuationSummary', () => {
  it('builds a valid user_edit summary from params without mutating the prior row', () => {
    const prior = makeCognitionSummary({
      summary_id: 'prior-summary',
      channel_session_id: 'prior-channel',
      summary_text: 'prior handoff',
      created_at: 1_000,
      cognition_session_id: 'prior-cognition',
    });
    const before = { ...prior };

    const summary = applyUserEditToContinuationSummary(prior, {
      summary_id: 'edited-summary',
      summary_text: 'edited handoff',
      created_at: 2_000,
    });

    expect(summary).toEqual({
      summary_id: 'edited-summary',
      channel_session_id: 'prior-channel',
      summary_text: 'edited handoff',
      source: 'user_edit',
      created_at: 2_000,
    });
    expect(summary).not.toHaveProperty('cognition_session_id');
    expect(prior).toEqual(before);
    expect(isContinuationSummary(summary)).toBe(true);
  });
});

describe('D-153 P9 - evaluateSummarizeTrigger', () => {
  it('defers session_close with no current summary', () => {
    expect(evaluateSummarizeTrigger('session_close', undefined)).toEqual({
      should_summarize: false,
      reason: 'lazy_deferral',
    });
  });

  it('defers session_close with a defined current summary', () => {
    expect(evaluateSummarizeTrigger('session_close', makeCognitionSummary()))
      .toEqual({
        should_summarize: false,
        reason: 'lazy_deferral',
      });
  });

  it('skips continuation when a current summary already exists', () => {
    expect(evaluateSummarizeTrigger('continuation', makeCognitionSummary()))
      .toEqual({
        should_summarize: false,
        reason: 'summary_already_exists',
      });
  });

  it('summarizes continuation on first load when no current summary exists', () => {
    expect(evaluateSummarizeTrigger('continuation', undefined)).toEqual({
      should_summarize: true,
      reason: 'continuation_first_load',
    });
  });

  it('keeps should_summarize equivalent to continuation_first_load for every branch', () => {
    for (const [occasion, currentSummary] of [
      ['session_close', undefined],
      ['session_close', makeCognitionSummary()],
      ['continuation', makeCognitionSummary()],
      ['continuation', undefined],
    ] as const) {
      const evaluation = evaluateSummarizeTrigger(occasion, currentSummary);

      expect(evaluation.should_summarize).toBe(
        evaluation.reason === 'continuation_first_load',
      );
    }
  });
});

describe('D-153 P9 - isHandoffSummarizationResult', () => {
  it('accepts a result with non-empty summary_text', () => {
    expect(isHandoffSummarizationResult({ summary_text: 'hello' })).toBe(true);
  });

  it('accepts a result with empty summary_text', () => {
    expect(isHandoffSummarizationResult({ summary_text: '' })).toBe(true);
  });

  it('rejects an object missing summary_text', () => {
    expect(isHandoffSummarizationResult({ text: 'hello' })).toBe(false);
  });

  it('rejects a result whose summary_text is not a string', () => {
    expect(isHandoffSummarizationResult({ summary_text: 42 })).toBe(false);
  });

  it('rejects null, non-object, and array values', () => {
    for (const value of [undefined, null, 'result', 42, true, []]) {
      expect(isHandoffSummarizationResult(value)).toBe(false);
    }
  });
});

/** D-160 P2 -- first-party middleware adapters.
 *
 *  These tests pin the adapter contracts, not the relocated D-145 helpers
 *  themselves: exact middleware ids, lifecycle hook presence, state slot
 *  writes via the exported state keys, prompt contributions for prompt
 *  adapters, and faithful no-op behavior for snapshot-driven adapters.
 */

import { describe, expect, it } from 'vitest';
import {
  createCapacity,
  type OutStream,
  type PromptDraft,
  type PromptPart,
  type TurnContext,
  type TurnResult,
} from '@recued/middleware';
import type {
  CorrectionEventRow,
  ExtractionEvent,
  PersonalRecipeEntry,
} from '@recued/contracts';

import {
  CONFIDENCE_SHAPE_CANDIDATES_STATE_KEY,
  CONFIDENCE_SHAPE_RESULT_STATE_KEY,
  confidenceShapeMiddleware,
} from '../confidence-shape/middleware.js';
import {
  CORRECTION_LEARNING_EVENTS_STATE_KEY,
  CORRECTION_LEARNING_SUMMARY_STATE_KEY,
  correctionLearningMiddleware,
} from '../correction-learning/middleware.js';
import {
  PERSONAL_RECIPES_INPUT_STATE_KEY,
  PERSONAL_RECIPES_MATCHES_STATE_KEY,
  personalRecipesMiddleware,
} from '../personal-recipes/middleware.js';
import {
  SCOPE_SEARCH_INPUT_STATE_KEY,
  SCOPE_SEARCH_RESULT_STATE_KEY,
  scopeSearchMiddleware,
} from '../scope-search/middleware.js';

const NOW = Date.UTC(2026, 4, 21, 15, 0, 0);

const outStream = (): OutStream => ({
  async token(): Promise<void> {},
  async note(): Promise<void> {},
  async message(): Promise<void> {},
  async done(): Promise<void> {},
  delivered: () => 0,
});

const promptDraft = (source: string): PromptDraft => {
  const parts: PromptPart[] = [];
  return {
    contribute(part: { role: 'system' | 'context'; text: string }): void {
      parts.push({ source, ...part });
    },
    parts(): readonly PromptPart[] {
      return parts;
    },
  };
};

const userEntry = (text = 'please email Bob about travel'): TurnContext['history'][number] => ({
  session_id: 'session-1',
  surface: 'chat',
  role: 'user',
  text,
  ts: NOW,
});

const turnContext = (
  middlewareId: string,
  patch: Partial<TurnContext> = {},
): TurnContext => ({
  session_id: 'session-1',
  surface: 'chat',
  turn_index: 0,
  turn_id: 'turn-0',
  history: [userEntry()],
  prompt: promptDraft(middlewareId),
  interjections: [],
  capacity: createCapacity(),
  out: outStream(),
  state: new Map<string, unknown>(),
  resolve(): void {},
  ...patch,
});

const turnResult = (patch: Partial<TurnResult> = {}): TurnResult => ({
  session_id: 'session-1',
  surface: 'chat',
  turn_index: 0,
  turn_id: 'turn-0',
  resolved_without_ai: false,
  output: { text: 'assistant answer' },
  history: [userEntry()],
  capacity: createCapacity(),
  out: outStream(),
  state: new Map<string, unknown>(),
  requestContinue(): void {},
  signalDone(): void {},
  ...patch,
});

let correctionSeq = 0;
const correctionRow = (
  patch: Partial<CorrectionEventRow> & { kind: CorrectionEventRow['kind'] },
): CorrectionEventRow => {
  correctionSeq += 1;
  return {
    id: `correction-${correctionSeq}`,
    ts: NOW,
    event_at: NOW,
    scope: 'global',
    payload_blob: {},
    ...patch,
  };
};

const personalRecipeEntry = (
  patch: Partial<PersonalRecipeEntry> = {},
): PersonalRecipeEntry => ({
  recipe_id: 'pub/remind-mary-about-travel',
  topic: 'travel',
  enabled: true,
  created_at: NOW,
  ...patch,
});

const extractionEvent = (patch: Partial<ExtractionEvent> = {}): ExtractionEvent => ({
  kind: 'extraction.plan',
  confidence: 0.92,
  args: { topic: 'travel' },
  subject_contact_id: 'mary-id',
  ...patch,
});

// D-164 P6.5 retired the `D-160 P2 twoStageMiddleware` block: the two-stage
// substrate is deleted (`packages/middleware-recued/src/two-stage/` gone) and
// chat consolidated onto `@recued/middleware-prompt-cache`. The prompt-cache
// adapter contract is ratcheted by its own package's tests
// (`packages/middleware-recued/prompt-cache/src/__tests__/`); the absence of
// the two-stage adapter from this five-adapter bundle is ratcheted by
// `d-160-phase-2-registry-integration.test.ts` (the
// `D-164 P6.5 two-stage substrate absent` block).

describe('D-160 P2 confidenceShapeMiddleware', () => {
  it('exports the exact middleware id', () => {
    expect(confidenceShapeMiddleware.id).toBe('confidence-shape');
  });

  it('exposes the update lifecycle hook', () => {
    expect(confidenceShapeMiddleware.update).toEqual(expect.any(Function));
  });

  it('classifies scored candidates and writes the result state', () => {
    const ctx = turnResult();
    ctx.state.set(CONFIDENCE_SHAPE_CANDIDATES_STATE_KEY, [
      { record: { id: 'alice' }, score: 0.92 },
      { record: { id: 'bob' }, score: 0.4 },
    ]);

    confidenceShapeMiddleware.update?.(ctx);

    expect(ctx.state.get(CONFIDENCE_SHAPE_RESULT_STATE_KEY)).toMatchObject({
      pattern: 1,
      top: { id: 'alice' },
      alternatives: [{ id: 'bob' }],
      measures: {
        candidate_count: 2,
        top_score: 0.92,
      },
    });
  });

  it('produces Pattern 4 without a candidates snapshot', () => {
    const ctx = turnResult();

    confidenceShapeMiddleware.update?.(ctx);

    expect(ctx.state.get(CONFIDENCE_SHAPE_RESULT_STATE_KEY)).toEqual({
      pattern: 4,
      measures: {
        candidate_count: 0,
        top_score: null,
        top_margin: null,
        mean_score: null,
      },
    });
  });
});

describe('D-160 P2 correctionLearningMiddleware', () => {
  it('exports the exact middleware id', () => {
    expect(correctionLearningMiddleware.id).toBe('correction-learning');
  });

  it('exposes the prompt lifecycle hook', () => {
    expect(correctionLearningMiddleware.prompt).toEqual(expect.any(Function));
  });

  it('writes the correction summary state and contributes a PromptPart', () => {
    const ctx = turnContext(correctionLearningMiddleware.id);
    ctx.state.set(CORRECTION_LEARNING_EVENTS_STATE_KEY, {
      now: NOW,
      rows: [
        correctionRow({
          kind: 'plan_outcome_corrected',
          payload_blob: { plan_id: 'plan-1', user_feedback: 'too_chatty' },
        }),
      ],
    });

    correctionLearningMiddleware.prompt?.(ctx);

    expect(ctx.state.get(CORRECTION_LEARNING_SUMMARY_STATE_KEY)).toEqual({
      tone_too_chatty_recent_corrections: 1,
    });
    expect(ctx.prompt.parts()).toEqual([
      expect.objectContaining({
        source: 'correction-learning',
        role: 'context',
        text: expect.stringContaining('tone_too_chatty_recent_corrections=1'),
      }),
    ]);
  });

  it('faithfully no-ops without a correction snapshot', () => {
    const ctx = turnContext(correctionLearningMiddleware.id);

    correctionLearningMiddleware.prompt?.(ctx);

    expect(ctx.state.has(CORRECTION_LEARNING_SUMMARY_STATE_KEY)).toBe(false);
    expect(ctx.prompt.parts()).toEqual([]);
  });
});

describe('D-160 P2 personalRecipesMiddleware', () => {
  it('exports the exact middleware id', () => {
    expect(personalRecipesMiddleware.id).toBe('personal-recipes');
  });

  it('exposes the update lifecycle hook', () => {
    expect(personalRecipesMiddleware.update).toEqual(expect.any(Function));
  });

  it('writes dispatched personal-recipe matches to state', () => {
    const ctx = turnResult();
    ctx.state.set(PERSONAL_RECIPES_INPUT_STATE_KEY, {
      events: [extractionEvent()],
      lookupPersonalRecipes: (contactId: string) =>
        contactId === 'mary-id' ? [personalRecipeEntry()] : [],
    });

    personalRecipesMiddleware.update?.(ctx);

    expect(ctx.state.get(PERSONAL_RECIPES_MATCHES_STATE_KEY)).toEqual({
      matches: [
        {
          recipe_id: 'pub/remind-mary-about-travel',
          contact_id: 'mary-id',
          topic: 'travel',
          trigger: {
            kind: 'contact_topic_mention',
            contact_id: 'mary-id',
            topic: 'travel',
          },
          source_event_kind: 'extraction.plan',
          source_event_index: 0,
        },
      ],
      skipped: [],
    });
  });

  it('faithfully no-ops without a dispatch snapshot', () => {
    const ctx = turnResult();

    personalRecipesMiddleware.update?.(ctx);

    expect(ctx.state.has(PERSONAL_RECIPES_MATCHES_STATE_KEY)).toBe(false);
  });
});

describe('D-160 P2 scopeSearchMiddleware', () => {
  it('exports the exact middleware id', () => {
    expect(scopeSearchMiddleware.id).toBe('scope-search');
  });

  it('exposes the async prompt lifecycle hook', () => {
    expect(scopeSearchMiddleware.prompt).toEqual(expect.any(Function));
  });

  it('writes fan-out output state', async () => {
    const ctx = turnContext(scopeSearchMiddleware.id);
    ctx.state.set(SCOPE_SEARCH_INPUT_STATE_KEY, {
      args: { query: 'alice' },
      sources: [
        {
          id: 'local',
          query: async (args: { query: string }) => [
            { record: { name: 'Alice', query: args.query }, score: 0.8 },
          ],
        },
      ],
    });

    await scopeSearchMiddleware.prompt?.(ctx);

    expect(ctx.state.get(SCOPE_SEARCH_RESULT_STATE_KEY)).toEqual({
      candidates: [
        {
          source: 'local',
          record: { name: 'Alice', query: 'alice' },
          score: 0.8,
        },
      ],
    });
  });

  it('contributes a PromptPart when fan-out runs', async () => {
    const ctx = turnContext(scopeSearchMiddleware.id);
    ctx.state.set(SCOPE_SEARCH_INPUT_STATE_KEY, {
      args: { query: 'alice' },
      sources: [
        {
          id: 'local',
          query: async (args: { query: string }) => [
            { record: { name: 'Alice', query: args.query }, score: 0.8 },
          ],
        },
      ],
    });

    await scopeSearchMiddleware.prompt?.(ctx);

    expect(ctx.prompt.parts().length).toBeGreaterThan(0);
  });

  it('faithfully no-ops without a scope-search snapshot', async () => {
    const ctx = turnContext(scopeSearchMiddleware.id);

    await scopeSearchMiddleware.prompt?.(ctx);

    expect(ctx.state.has(SCOPE_SEARCH_RESULT_STATE_KEY)).toBe(false);
  });
});

/** D-164 P6b/c -- contracts cognition-residue deletion ratchets. */

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CLASSIFICATION_INTENT_KINDS,
  D150BenchSupport,
  NARROWING_REASON_CODES,
  type AIOutput,
  type ClassificationIntentKind,
  type ContextSelectionTrace,
  type NarrowingReasonCode,
  type ToolCall,
} from '@recued/contracts';
import type * as Contracts from '@recued/contracts';

const readSource = (relativePath: string): string =>
  readFileSync(path.resolve(__dirname, relativePath), 'utf8');

const expectAbsent = (source: string, symbols: ReadonlyArray<string>): void => {
  for (const symbol of symbols) {
    expect(source).not.toContain(symbol);
  }
};

describe('D-164 P6b/c -- deleted contract cognition surfaces stay deleted', () => {
  it('[D-164 P6b/c] packages/contracts/src/cognition.ts stays deleted', () => {
    // mutate: restore packages/contracts/src/cognition.ts -> this assertion fails.
    expect(existsSync(path.resolve(__dirname, '../cognition.ts'))).toBe(false);
  });

  it('[D-164 P6b/c] ai-output.ts excludes cognition output and placeholder fields', () => {
    // mutate: restore AIOutput.cognition_diff, ToolCall.item_id_ref, or placeholder helpers -> this assertion fails.
    expectAbsent(readSource('../ai-output.ts'), [
      'cognition_diff',
      'COGNITION_PLACEHOLDER_PREFIX',
      'isCognitionPlaceholderRef',
      'item_id_ref',
    ]);
  });

  it('[D-164 P6.6] stage1.ts stays deleted (P6.6 contracts cleanup retired the file)', () => {
    // mutate: restore packages/contracts/src/stage1.ts -> this assertion fails.
    expect(existsSync(path.resolve(__dirname, '../stage1.ts'))).toBe(false);
  });

  it('[D-164 P6b/c] plan and D-150 mirror exclude cognition intents and trace counters', () => {
    // mutate: restore plan/D-150 cognition intents, state_filter, or cognition_items_* trace fields -> this assertion fails.
    expectAbsent(readSource('../recued-plan.ts'), [
      'cognition_create',
      'cognition_update',
      'cognition_items_considered',
      'cognition_items_selected',
      'cognition_items_dropped',
      'state_filter',
    ]);
    expectAbsent(readSource('../d-150-bench-support.ts'), [
      'cognition_create',
      'cognition_update',
      'cognition_items_considered',
      'cognition_items_selected',
      'cognition_items_dropped',
      'state_filter',
    ]);
  });

  it('[D-164 P6b/c] contract barrel and tier strategy do not re-expose cognition routing', () => {
    // mutate: re-export ./cognition.js or restore cognition_create/update tier cases -> this assertion fails.
    expectAbsent(readSource('../index.ts'), [
      "from './cognition.js'",
      'COGNITION_PLACEHOLDER_PREFIX',
      'CognitionStateSummary',
      'truncateCognitionName',
    ]);
    expectAbsent(readSource('../tier-strategy.ts'), [
      'cognition_create',
      'cognition_update',
    ]);
  });

  it('[D-164 P6.6] chat.ts (the migrated surface) carries no cognition fields', () => {
    // Codex P6.6 impl-review MAJOR Q2 fold — D-164 P6.6 migrated
    // `STAGE2_TOOL_LOOP_CAP` → `CHAT_MAIN_TURN_TOOL_LOOP_CAP` +
    // `Stage1ChatMessage` → `ChatTailMessage` from the retired
    // `stage1.ts` into `chat.ts`. The cognition-residue grep now needs
    // to cover that migrated surface, otherwise a regression that adds
    // a `cognition_state_summary` / `cognition_refs` field to (say)
    // `ChatTailMessage` would pass undetected.
    expectAbsent(readSource('../chat.ts'), [
      'cognition_state_summary',
      'cognition_refs',
      'truncateCognitionName',
      'CognitionStateSummary',
    ]);
  });

  it('[D-164 P6b/c] closed-list cardinalities stay at post-cognition counts', () => {
    // mutate: restore state_filter, cognition_create, or cognition_update -> this assertion fails.
    // D-164 P6.6 retired STAGE1_VALIDATION_ISSUE_KINDS alongside stage1.ts;
    // the surviving cardinalities are the only ones still gated here.
    expect(NARROWING_REASON_CODES).toHaveLength(9);
    expect(CLASSIFICATION_INTENT_KINDS).toHaveLength(5);
    expect(D150BenchSupport.NARROWING_REASON_CODES).toHaveLength(9);
    expect(D150BenchSupport.CLASSIFICATION_INTENT_KINDS).toHaveLength(5);
  });

  it('[D-164 P6b/c] deleted cognition contract fields and types stay type-invalid', () => {
    // mutate: restore deleted cognition contract types or fields -> one @ts-expect-error becomes unused.
    // @ts-expect-error D-164 P6b/c deleted the Cognition barrel type.
    type _NoCognition = Contracts.Cognition;
    // @ts-expect-error D-164 P6b/c deleted the CognitionStateSummary barrel type.
    type _NoCognitionStateSummary = Contracts.CognitionStateSummary;
    // Codex P6.6 impl-review MAJOR Q7 fold — D-164 P6.6 deleted
    // `stage1.ts`; reintroducing the PB17 substrate names as aliases
    // from any contract file should stay type-invalid via the barrel.
    // Type-level only — `Contracts` was imported as `type * as`, so
    // runtime reads would `ReferenceError`. The @ts-expect-error
    // comments are the load-bearing assertions; one of them becoming
    // unused (because the type / value resolves) fails the build.
    // @ts-expect-error D-164 P6.6 deleted the Stage1Input barrel type.
    type _NoStage1Input = Contracts.Stage1Input;
    // @ts-expect-error D-164 P6.6 deleted the Stage1Output barrel type.
    type _NoStage1Output = Contracts.Stage1Output;
    // @ts-expect-error D-164 P6.6 deleted the Stage1ChatMessage barrel type (migrated to ChatTailMessage).
    type _NoStage1ChatMessage = Contracts.Stage1ChatMessage;
    // @ts-expect-error D-164 P6.6 deleted STAGE1_VALIDATION_ISSUE_KINDS from the barrel.
    type _NoStage1ValidationIssueKinds = typeof Contracts.STAGE1_VALIDATION_ISSUE_KINDS;
    // @ts-expect-error D-164 P6.6 deleted STAGE2_TOOL_LOOP_CAP (migrated to CHAT_MAIN_TURN_TOOL_LOOP_CAP).
    type _NoStage2ToolLoopCap = typeof Contracts.STAGE2_TOOL_LOOP_CAP;
    // @ts-expect-error D-164 P6.6 retired CHAT_STAGE2_INGREDIENT_SLUG (renamed to CHAT_MAIN_TURN_INGREDIENT_SLUG).
    type _NoChatStage2IngredientSlug = typeof Contracts.CHAT_STAGE2_INGREDIENT_SLUG;
    // @ts-expect-error D-164 P6.6 retired the ChatStage1ForceLayer alias (renamed to ChatForceLayer).
    type _NoChatStage1ForceLayer = Contracts.ChatStage1ForceLayer;

    const aiOutputWithCognitionDiff: AIOutput = {
      response: 'ok',
      events: [],
      tool_calls: [],
      // @ts-expect-error D-164 P6b/c deleted AIOutput.cognition_diff.
      cognition_diff: { ops: [] },
    };
    const toolCallWithItemRef: ToolCall = {
      tool: 'send-email',
      args: {},
      // @ts-expect-error D-164 P6b/c deleted ToolCall.item_id_ref.
      item_id_ref: 'item1',
    };
    const traceWithCognitionCounts: ContextSelectionTrace = {
      recipe_candidates_considered: 0,
      recipe_candidates_selected: [],
      recipe_candidates_dropped: [],
      commitment_context_pulled: false,
      commitment_rows_count: 0,
      // D-164 P6.7 — `stage1_*` fields retired; catalog-assembly
      // snapshot (Open Q1 (b)) carries the post-Stage-1 audit shape.
      catalog_section_counts: {},
      catalog_short_circuited: false,
      // @ts-expect-error D-164 P6b/c deleted ContextSelectionTrace cognition_items_* fields.
      cognition_items_considered: 0,
    };
    // @ts-expect-error D-164 P6b/c deleted cognition_create from ClassificationIntentKind.
    const deletedIntent: ClassificationIntentKind = 'cognition_create';
    // @ts-expect-error D-164 P6b/c deleted state_filter from NarrowingReasonCode.
    const deletedReason: NarrowingReasonCode = 'state_filter';

    expect(aiOutputWithCognitionDiff.response).toBe('ok');
    expect(toolCallWithItemRef.tool).toBe('send-email');
    expect(traceWithCognitionCounts.catalog_short_circuited).toBe(false);
    expect([deletedIntent, deletedReason]).toEqual([
      'cognition_create',
      'state_filter',
    ]);
  });
});

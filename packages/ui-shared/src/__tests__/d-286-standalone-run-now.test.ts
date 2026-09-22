/** D-286 — a standalone enrichment task's *Run now* button.
 *
 *  ⛔ WHAT WAS BROKEN. `runNowDisabled = !enrichment || trustState === 'off'`,
 *  and `getEnrichmentInfo` answered only for producers registered through
 *  `buildEnrichmentProducerTask` (they need a walker). A STANDALONE task —
 *  registered directly, no walker — got `undefined`, so its button was
 *  disabled forever: 26 of 74 rows, measured in a live paired browser, with
 *  trust reading `auto`. `confidence_drift_signal` is one, so the owner could
 *  not ask for a fresh drift check even after seeing the banner.
 *
 *  ⛔ AND THE OBVIOUS FIX WAS A WORSE BUG. Filling the gap with
 *  `token_estimate_per_record: 0` makes the preview call the task
 *  DETERMINISTIC, and five AI-surface standalone tasks declare no estimate at
 *  all — the confirm dialog would have offered "pure SQL aggregation, no token
 *  cost" for a producer that fires AI calls. So absence is now modelled as
 *  absence: `is_ai_surface` states the fact, and the two numbers are optional
 *  with absent meaning UNKNOWN. */

import { describe, expect, it } from 'vitest';
import { isAiSurfaceEnrichment, type HousekeepingEnrichmentInfo } from '@recued/contracts';

import {
  computeHousekeepingCostPreview,
  initialHousekeepingRunNowDialogState,
  renderHousekeepingRunNowConfirmDialog,
} from '../server-settings/housekeeping/index.js';

const dialogFor = (enrichment: HousekeepingEnrichmentInfo): string =>
  renderHousekeepingRunNowConfirmDialog({
    state: { ...initialHousekeepingRunNowDialogState(), task_id: 'enrichment.topic_cluster' },
    task: {
      meta: {
        id: 'enrichment.topic_cluster',
        description: 'Topic clusters',
        interruptible: true,
        kind: 'enrichment',
      },
      enrichment,
    },
  });

describe('D-286 — isAiSurfaceEnrichment, the one derivation', () => {
  it('prefers the stated fact over the token count', () => {
    // The case that broke: AI-surface, no estimate. The old derivation read
    // this as deterministic.
    expect(isAiSurfaceEnrichment({ is_ai_surface: true })).toBe(true);
    expect(isAiSurfaceEnrichment({ is_ai_surface: false, token_estimate_per_record: 0 })).toBe(false);
  });

  it('falls back to tokens > 0 when the fact is absent, so an old payload keeps its meaning', () => {
    expect(isAiSurfaceEnrichment({ token_estimate_per_record: 600 })).toBe(true);
    expect(isAiSurfaceEnrichment({ token_estimate_per_record: 0 })).toBe(false);
  });

  it('is false for a row with no producer info at all', () => {
    expect(isAiSurfaceEnrichment(undefined)).toBe(false);
  });
});

describe('D-286 — the cost preview never invents a number', () => {
  const preview = (info: HousekeepingEnrichmentInfo) =>
    computeHousekeepingCostPreview({ enrichment: info });

  it('an AI task with no estimate is NOT deterministic', () => {
    // ⛔ The dialog branches on this. Getting it wrong prints "pure SQL
    // aggregation, no token cost" above a button that spends tokens.
    const p = preview({ is_ai_surface: true });
    expect(p.deterministic).toBe(false);
    expect(p.ai_required).toBe(true);
  });

  it('omits the total when the record count is unknown, rather than reporting 0', () => {
    const p = preview({ is_ai_surface: true, token_estimate_per_record: 600 });
    expect(p.estimated_tokens).toBeUndefined();
    expect(p.estimated_cost_usd).toBeUndefined();
  });

  it('still computes a total when both halves are known', () => {
    const p = preview({
      is_ai_surface: true,
      token_estimate_per_record: 600,
      source_collection_count: 50,
    });
    expect(p.estimated_tokens).toBe(30_000);
  });

  it('a deterministic task needs no count — zero is a real zero', () => {
    const p = preview({ is_ai_surface: false, token_estimate_per_record: 0 });
    expect(p.deterministic).toBe(true);
    expect(p.estimated_tokens).toBe(0);
    expect(p.ai_required).toBe(false);
  });

  it('carries the AI-path warning through even with nothing to price', () => {
    // The owner still has to be told AI is unreachable; losing that with the
    // estimate would trade one silent failure for another.
    const p = preview({
      is_ai_surface: true,
      ai_path_available: false,
      ai_path_reason: 'no_byok_no_freepool',
    });
    expect(p.ai_path_available).toBe(false);
    expect(p.ai_path_reason).toBe('no_byok_no_freepool');
  });
});

describe('D-286 — what the confirm dialog actually says', () => {
  // ⛔ The live drive could only reach the AI-BLOCKED branch (the bench seed
  // has no LLM configured), so the available-AI copy is pinned here instead of
  // being assumed from the branch beside it.
  it('an AI task with no estimate is never called deterministic', () => {
    const html = dialogFor({ is_ai_surface: true, ai_path_available: true });
    expect(html).not.toContain('pure SQL aggregation');
    expect(html).not.toContain('no token cost');
    // With AI reachable the dialog takes the spend branch, whose phrasing is
    // "will fire AI calls" — "needs an AI call" belongs to the blocked branch.
    expect(html).toContain('will fire AI calls');
  });

  it('says the cost is not knowable instead of quoting a number it does not have', () => {
    const html = dialogFor({ is_ai_surface: true, ai_path_available: true });
    expect(html).toContain('not known ahead of the run');
    expect(html).not.toContain('~0 tokens');
  });

  it('hedges the record count rather than printing "0 source records"', () => {
    const html = dialogFor({ is_ai_surface: false, token_estimate_per_record: 0 });
    expect(html).toContain('its source records');
    expect(html).not.toContain('0 source records');
  });

  it('still quotes real numbers when it has them', () => {
    const html = dialogFor({
      is_ai_surface: true,
      token_estimate_per_record: 600,
      source_collection_count: 50,
      ai_path_available: true,
    });
    expect(html).toContain('30,000 tokens');
    expect(html).toContain('50 source records');
  });
});

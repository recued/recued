/** D-139 Phase 5 — AI-surface canary producer tests.
 *
 *  Covers the two new producers landed at P5:
 *    - `engagement_sentiment_trend` (tone trajectory)
 *    - `next_best_action` (action recommendation)
 *
 *  Test discipline:
 *    - Pure-helper tests for `filterRowsFor*` / `buildPrompt` /
 *      `buildValue` — exercise the registry-declared evidence-quality
 *      acceptance fields without spinning up the LLM.
 *    - Validator tests for `validate*ClassifyOutput` — closed-set
 *      enforcement on AI output shape.
 *    - Integration tests for `processOne*` — mock LLM via
 *      `ctx.llmWithMeta`; assert dedup probe + cross-pool model_id
 *      invalidation + body-text safety in persisted value.
 *
 *  Spec: D-139 § A.9.2 + § A.9.5 + § P5 acceptance. */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  ENGAGEMENT_SENTIMENT_MAX_KEY_PHRASES,
  ENGAGEMENT_SENTIMENT_MAX_KEY_PHRASE_CHARS,
  NEXT_BEST_ACTION_MAX_RATIONALE_CHARS,
  type Authorship,
  type CoverageMetadata,
  type DedupeConfidence,
  type Direction,
  type EngagementLifecycleState,
  type EngagementRow,
  type EngagementSentimentTrendValue,
  type EngagementVendor,
  type NextBestActionValue,
} from '@recued/contracts';

import {
  ENGAGEMENT_SENTIMENT_AUTHORED_BY,
  ENGAGEMENT_SENTIMENT_BODY_PREVIEW_CHARS,
  ENGAGEMENT_SENTIMENT_MIN_SAMPLE,
  ENGAGEMENT_SENTIMENT_TOPIC,
  ENGAGEMENT_SENTIMENT_WINDOW_MS,
  buildSentimentPrompt,
  buildSentimentValue,
  composeSentimentSourceHash,
  filterRowsForSentiment,
  processOneSentimentTrend,
  resolveSentimentTrendLayer,
  truncateSentimentBodyPreview,
  validateSentimentClassifyOutput,
} from '../housekeeping/engagement-aggregates/engagement-sentiment-trend.js';
import {
  NEXT_BEST_ACTION_AUTHORED_BY,
  NEXT_BEST_ACTION_BODY_LEAK_FALLBACK_RATIONALE,
  NEXT_BEST_ACTION_BODY_PREVIEW_CHARS,
  NEXT_BEST_ACTION_MIN_SAMPLE,
  NEXT_BEST_ACTION_TOPIC,
  NEXT_BEST_ACTION_VALIDITY_MS,
  NEXT_BEST_ACTION_WINDOW_MS,
  buildNextBestActionPrompt,
  buildNextBestActionValue,
  composeNextBestActionSourceHash,
  containsBodyExcerpt,
  filterRowsForNextBestAction,
  processOneNextBestAction,
  resolveNextBestActionLayer,
  truncateNextBestActionBodyPreview,
  validateNextBestActionClassifyOutput,
} from '../housekeeping/engagement-aggregates/next-best-action.js';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

const FIXED_NOW = 1_714_867_200_000;
const day = 24 * 60 * 60 * 1000;

const EMPTY_COVERAGE: CoverageMetadata = {
  sources_connected: ['connection.api.hubspot.email'],
  sources_unavailable: [],
  sources_stale: [],
  sources_degraded: [],
  row_counts: {},
  last_source_event_at: 0,
};

const buildRow = (overrides: Partial<EngagementRow> = {}): EngagementRow => ({
  connection_id: 'acme-hubspot',
  target_id: 'hubspot_email_1',
  vendor: 'hubspot' as EngagementVendor,
  entity: 'email',
  meta: {},
  mirror_blob_hash: null,
  authorship: 'user' as Authorship,
  direction: 'outbound' as Direction,
  dedupe_confidence: 'none' as DedupeConfidence,
  lifecycle_state: 'point_in_time' as EngagementLifecycleState,
  event_at: FIXED_NOW - 1 * day,
  vendor_created_at: FIXED_NOW - 1 * day,
  vendor_modified_at: FIXED_NOW - 1 * day,
  ingested_at: FIXED_NOW - 1 * day,
  body_state: 'inline_body',
  body_inline: 'Looking forward to next week.',
  ...overrides,
});

// ────────────────────────────────────────────────────────────────
// engagement_sentiment_trend — pure helpers
// ────────────────────────────────────────────────────────────────

describe('D-139 P5 — sentiment filter applies registry acceptance fields', () => {
  it('accepts user authorship + point_in_time lifecycle + inline_body', () => {
    expect(filterRowsForSentiment([buildRow()])).toHaveLength(1);
  });
  it('rejects crm_automation authorship (per Pass-4 evidence-quality default)', () => {
    expect(filterRowsForSentiment([buildRow({ authorship: 'crm_automation' })])).toHaveLength(0);
  });
  it('rejects system_process authorship', () => {
    expect(filterRowsForSentiment([buildRow({ authorship: 'system_process' })])).toHaveLength(0);
  });
  it('rejects pending lifecycle_state (not yet evidence)', () => {
    expect(filterRowsForSentiment([buildRow({ lifecycle_state: 'pending' })])).toHaveLength(0);
  });
  it('rejects scheduled lifecycle_state', () => {
    expect(filterRowsForSentiment([buildRow({ lifecycle_state: 'scheduled' })])).toHaveLength(0);
  });
  it('rejects no_answer + failed lifecycle (substrate evidence default)', () => {
    expect(filterRowsForSentiment([buildRow({ lifecycle_state: 'no_answer' })])).toHaveLength(0);
    expect(filterRowsForSentiment([buildRow({ lifecycle_state: 'failed' })])).toHaveLength(0);
  });
  it('rejects null event_at (touch has not happened)', () => {
    expect(filterRowsForSentiment([buildRow({ event_at: null })])).toHaveLength(0);
  });
  it('accepts truncated_inline body_state (sentiment-specific override per § A.3)', () => {
    expect(
      filterRowsForSentiment([buildRow({ body_state: 'truncated_inline', body_inline: 'short pre…' })]),
    ).toHaveLength(1);
  });
  it('accepts mail_link + calendar_link body_states', () => {
    expect(filterRowsForSentiment([buildRow({ body_state: 'mail_link' })])).toHaveLength(1);
    expect(filterRowsForSentiment([buildRow({ body_state: 'calendar_link' })])).toHaveLength(1);
  });
  it('rejects body_state none (no body to read tone from)', () => {
    expect(filterRowsForSentiment([buildRow({ body_state: 'none' })])).toHaveLength(0);
  });
});

describe('D-139 P5 — sentiment body preview truncation', () => {
  it('returns empty when body_inline missing (mail_link / calendar_link rows)', () => {
    expect(truncateSentimentBodyPreview(buildRow({ body_state: 'mail_link', body_inline: undefined }))).toBe('');
  });
  it('returns the body verbatim when within cap', () => {
    expect(truncateSentimentBodyPreview(buildRow({ body_inline: 'short note' }))).toBe('short note');
  });
  it('truncates with ellipsis at the per-row cap', () => {
    const long = 'a'.repeat(ENGAGEMENT_SENTIMENT_BODY_PREVIEW_CHARS + 50);
    const out = truncateSentimentBodyPreview(buildRow({ body_inline: long }));
    expect(out.length).toBe(ENGAGEMENT_SENTIMENT_BODY_PREVIEW_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('D-139 P5 — sentiment prompt composition', () => {
  it('includes deal target_id + count + per-row vendor/entity/authorship/direction', () => {
    const rows: EngagementRow[] = [
      buildRow({ target_id: 'r1', body_inline: 'reply A' }),
      buildRow({ target_id: 'r2', body_inline: 'reply B' }),
    ];
    const prompt = buildSentimentPrompt('hubspot_deal_47291', rows);
    expect(prompt).toContain('hubspot_deal_47291');
    expect(prompt).toContain('2 touches');
    expect(prompt).toContain('hubspot/email');
    expect(prompt).toContain('authorship=user');
    expect(prompt).toContain('direction=outbound');
    expect(prompt).toContain('reply A');
    expect(prompt).toContain('reply B');
  });
  it('sorts rows by event_at ascending (oldest first)', () => {
    const oldRow = buildRow({ event_at: FIXED_NOW - 30 * day, body_inline: 'OLDEST' });
    const newRow = buildRow({ event_at: FIXED_NOW - 1 * day, body_inline: 'NEWEST' });
    const prompt = buildSentimentPrompt('d', [newRow, oldRow]);
    expect(prompt.indexOf('OLDEST')).toBeLessThan(prompt.indexOf('NEWEST'));
  });
});

describe('D-139 P5 — sentiment value composition (no body text leaks)', () => {
  it('builds a warming value from a happy AI output', () => {
    const v = buildSentimentValue(
      { category: 'warming', confidence: 0.8, reasoning: 'fast replies', key_phrases: ['fast_replies', 'positive_phrasing'] },
      6,
      FIXED_NOW,
    );
    expect(v.tone).toBe('warming');
    expect(v.score).toBeCloseTo(0.6 * 0.8, 5);
    expect(v.key_phrases).toEqual(['fast_replies', 'positive_phrasing']);
    expect(v.samples).toBe(6);
    expect(v.cursor_at).toBe(FIXED_NOW);
  });
  it('clamps to insufficient_signal below MIN_SAMPLE regardless of LLM output', () => {
    const v = buildSentimentValue(
      { category: 'warming', confidence: 1, reasoning: '', key_phrases: ['x'] },
      ENGAGEMENT_SENTIMENT_MIN_SAMPLE - 1,
      0,
    );
    expect(v.tone).toBe('insufficient_signal');
    expect(v.score).toBe(0);
  });
  it('strips body-shaped over-long key_phrases tokens', () => {
    const longBodyToken = 'a'.repeat(ENGAGEMENT_SENTIMENT_MAX_KEY_PHRASE_CHARS + 1);
    const v = buildSentimentValue(
      {
        category: 'cooling',
        confidence: 0.5,
        reasoning: '',
        key_phrases: ['ok_token', longBodyToken, 'another_ok'],
      },
      5,
      0,
    );
    expect(v.key_phrases).toEqual(['ok_token', 'another_ok']);
  });
  it('caps key_phrases at ENGAGEMENT_SENTIMENT_MAX_KEY_PHRASES even when LLM returns more', () => {
    const tooMany = Array.from(
      { length: ENGAGEMENT_SENTIMENT_MAX_KEY_PHRASES + 5 },
      (_, i) => `tok${i}`,
    );
    const v = buildSentimentValue(
      { category: 'steady', confidence: 0.5, reasoning: '', key_phrases: tooMany },
      5,
      0,
    );
    expect(v.key_phrases.length).toBe(ENGAGEMENT_SENTIMENT_MAX_KEY_PHRASES);
  });
  it('drops empty / whitespace-only key phrases', () => {
    const v = buildSentimentValue(
      { category: 'steady', confidence: 0.3, reasoning: '', key_phrases: ['', '  ', 'real_token'] },
      5,
      0,
    );
    expect(v.key_phrases).toEqual(['real_token']);
  });
  it('produced value passes the registry validator (round-trip safety)', () => {
    const v: EngagementSentimentTrendValue = buildSentimentValue(
      { category: 'volatile', confidence: 0.4, reasoning: '', key_phrases: ['mixed_signals'] },
      4,
      FIXED_NOW,
    );
    expect(ENRICHMENT_REGISTRY.engagement_sentiment_trend.value_schema!(v).ok).toBe(true);
  });
  it('rejects out-of-range confidence by clamping baseline × confidence math', () => {
    const v = buildSentimentValue(
      { category: 'cooling', confidence: 5, reasoning: '', key_phrases: [] },
      4,
      0,
    );
    // confidence clamped to [0, 1] inside buildSentimentValue → -0.6 max
    expect(v.score).toBeGreaterThanOrEqual(-1);
    expect(v.score).toBeLessThanOrEqual(0);
  });
});

describe('D-139 P5 — sentiment validator rejects malformed AI output', () => {
  it('rejects out-of-set category', () => {
    expect(() =>
      validateSentimentClassifyOutput({ category: 'glowing', confidence: 0.5, reasoning: 'x' }),
    ).toThrow(/engagement_sentiment_trend_output_invalid/);
  });
  it('rejects non-numeric confidence', () => {
    expect(() =>
      validateSentimentClassifyOutput({ category: 'steady', confidence: 'high', reasoning: 'x' }),
    ).toThrow(/engagement_sentiment_trend_output_invalid/);
  });
  it('rejects null', () => {
    expect(() => validateSentimentClassifyOutput(null)).toThrow(
      /engagement_sentiment_trend_output_invalid/,
    );
  });
  it('accepts a well-formed output with optional key_phrases', () => {
    const out = validateSentimentClassifyOutput({
      category: 'warming',
      confidence: 0.8,
      reasoning: 'fast replies',
      key_phrases: ['phrase_a', 'phrase_b'],
    });
    expect(out.category).toBe('warming');
    expect(out.key_phrases).toEqual(['phrase_a', 'phrase_b']);
  });
});

// ────────────────────────────────────────────────────────────────
// next_best_action — pure helpers
// ────────────────────────────────────────────────────────────────

describe('D-139 P5 — next-best-action filter applies registry acceptance fields', () => {
  it('accepts user authorship + point_in_time + inline_body', () => {
    expect(filterRowsForNextBestAction([buildRow()])).toHaveLength(1);
  });
  it('rejects truncated_inline body_state (NBA needs full body context)', () => {
    expect(
      filterRowsForNextBestAction([buildRow({ body_state: 'truncated_inline', body_inline: 'short prev' })]),
    ).toHaveLength(0);
  });
  it('rejects body_state none', () => {
    expect(filterRowsForNextBestAction([buildRow({ body_state: 'none' })])).toHaveLength(0);
  });
  it('rejects crm_automation + system_process authorship', () => {
    expect(filterRowsForNextBestAction([buildRow({ authorship: 'crm_automation' })])).toHaveLength(0);
    expect(filterRowsForNextBestAction([buildRow({ authorship: 'system_process' })])).toHaveLength(0);
  });
  it('rejects null event_at', () => {
    expect(filterRowsForNextBestAction([buildRow({ event_at: null })])).toHaveLength(0);
  });
});

describe('D-139 P5 — next-best-action body preview', () => {
  it('truncates with ellipsis at the wider per-row cap', () => {
    const long = 'a'.repeat(NEXT_BEST_ACTION_BODY_PREVIEW_CHARS + 100);
    const out = truncateNextBestActionBodyPreview(buildRow({ body_inline: long }));
    expect(out.length).toBe(NEXT_BEST_ACTION_BODY_PREVIEW_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('D-139 P5 — next-best-action prompt composition', () => {
  it('includes deal id + per-row authorship/direction + body preview', () => {
    const prompt = buildNextBestActionPrompt('hubspot_deal_47291', [
      buildRow({ body_inline: 'recap of the call' }),
    ]);
    expect(prompt).toContain('hubspot_deal_47291');
    expect(prompt).toContain('recap of the call');
    expect(prompt).toContain('1 touches');
    expect(prompt).toContain('authorship=user');
  });
});

describe('D-139 P5 — next-best-action value composition', () => {
  it('builds a wait value with rationale + valid_until_at', () => {
    const v = buildNextBestActionValue(
      { category: 'wait', confidence: 0.6, reasoning: 'Prospect set a follow-up for next week.' },
      4,
      FIXED_NOW - 1 * day,
      FIXED_NOW,
      [],
    );
    expect(v.action).toBe('wait');
    expect(v.confidence).toBe(0.6);
    expect(v.rationale).toBe('Prospect set a follow-up for next week.');
    expect(v.samples).toBe(4);
    expect(v.computed_at).toBe(FIXED_NOW);
    expect(v.valid_until_at).toBe(FIXED_NOW + NEXT_BEST_ACTION_VALIDITY_MS);
    expect(v.cursor_at).toBe(FIXED_NOW - 1 * day);
  });
  it('clamps to no_action below MIN_SAMPLE regardless of LLM output', () => {
    const v = buildNextBestActionValue(
      { category: 'send_email', confidence: 1, reasoning: 'x' },
      NEXT_BEST_ACTION_MIN_SAMPLE - 1,
      0,
      FIXED_NOW,
      [],
    );
    expect(v.action).toBe('no_action');
    expect(v.confidence).toBe(0);
  });
  it('emits "No qualifying engagements" rationale when zero samples', () => {
    const v = buildNextBestActionValue(
      { category: 'wait', confidence: 0, reasoning: '' },
      0,
      0,
      FIXED_NOW,
      [],
    );
    expect(v.rationale).toBe('No qualifying engagements in the window.');
  });
  it('truncates over-long rationale to the registry char cap', () => {
    const longRationale = 'r'.repeat(NEXT_BEST_ACTION_MAX_RATIONALE_CHARS + 50);
    const v = buildNextBestActionValue(
      { category: 'investigate', confidence: 0.5, reasoning: longRationale },
      5,
      0,
      FIXED_NOW,
      [],
    );
    expect(v.rationale.length).toBe(NEXT_BEST_ACTION_MAX_RATIONALE_CHARS);
    expect(v.rationale.endsWith('…')).toBe(true);
  });
  it('clamps confidence into [0, 1]', () => {
    const v = buildNextBestActionValue(
      { category: 'wait', confidence: 1.5, reasoning: '' },
      4,
      0,
      FIXED_NOW,
      [],
    );
    expect(v.confidence).toBe(1);
    const v2 = buildNextBestActionValue(
      { category: 'wait', confidence: -0.3, reasoning: '' },
      4,
      0,
      FIXED_NOW,
      [],
    );
    expect(v2.confidence).toBe(0);
  });
  it('produced value passes the registry validator (round-trip safety)', () => {
    const v: NextBestActionValue = buildNextBestActionValue(
      { category: 'send_email', confidence: 0.7, reasoning: 'Stalled thread.' },
      5,
      FIXED_NOW,
      FIXED_NOW,
      [],
    );
    expect(ENRICHMENT_REGISTRY.next_best_action.value_schema!(v).ok).toBe(true);
  });
});

describe('D-139 P5 — next-best-action validator rejects malformed AI output', () => {
  it('rejects out-of-set category', () => {
    expect(() =>
      validateNextBestActionClassifyOutput({ category: 'cold_call', confidence: 0.5, reasoning: 'x' }),
    ).toThrow(/next_best_action_output_invalid/);
  });
  it('rejects non-numeric confidence', () => {
    expect(() =>
      validateNextBestActionClassifyOutput({ category: 'wait', confidence: 'high', reasoning: 'x' }),
    ).toThrow(/next_best_action_output_invalid/);
  });
  it('rejects null', () => {
    expect(() => validateNextBestActionClassifyOutput(null)).toThrow(
      /next_best_action_output_invalid/,
    );
  });
  it('accepts a well-formed output', () => {
    const out = validateNextBestActionClassifyOutput({
      category: 'send_email',
      confidence: 0.7,
      reasoning: 'follow-up needed',
    });
    expect(out.category).toBe('send_email');
  });
});

// ────────────────────────────────────────────────────────────────
// Integration — processOne* with mocked LLM
// ────────────────────────────────────────────────────────────────

describe('D-139 P5 — processOneSentimentTrend integration', () => {
  let dir: string;
  let db: Database.Database;
  let store: EnrichmentStore;
  let now = FIXED_NOW;
  let llmCalls: Array<{ manifest: unknown; input: Record<string, unknown> }>;
  let llmResponses: unknown[];
  let llmModelId = 'groq:llama-3-70b';

  const ctx = (): HousekeepingContext => ({
    db,
    bus: {
      emit: () => undefined,
      subscribe: () => () => undefined,
      dispose: () => undefined,
    } as never,
    enrichmentStore: store,
    recipeStore: {} as never,
    now: () => now,
    emitAuditRow: () => undefined,
    llm: vi.fn(async (manifest, input) => {
      llmCalls.push({ manifest, input });
      if (llmResponses.length === 0) {
        throw new Error('no llm response queued');
      }
      return llmResponses.shift();
    }),
    llmWithMeta: vi.fn(async (manifest, input) => {
      llmCalls.push({ manifest, input });
      if (llmResponses.length === 0) {
        throw new Error('no llm response queued');
      }
      return { result: llmResponses.shift(), model_id: llmModelId };
    }),
    resolveLLMModelId: vi.fn(async () => llmModelId),
  });

  const buildInput = (rows: EngagementRow[]) => ({
    rows,
    scope: 'connection.api.hubspot.deal' as const,
    target_id: 'hubspot_deal_47291',
    coverage: EMPTY_COVERAGE,
    source_record_hash: 'fnv1a:hubspot_deal_47291_anchor',
    as_of: now,
    now,
    forceLayer: 'free' as const,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd-139-p5-sentiment-'));
    db = new Database(join(dir, 'test.db'));
    db.pragma('journal_mode = WAL');
    store = createEnrichmentStore(db);
    now = FIXED_NOW;
    llmCalls = [];
    llmResponses = [];
    llmModelId = 'groq:llama-3-70b';
  });

  afterEach(() => {
    store.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a tombstone row when input has nothing accepted (Codex P2 fold)', async () => {
    const result = await processOneSentimentTrend(
      ctx(),
      buildInput([buildRow({ authorship: 'system_process' })]),
    );
    expect(result.produced).toBe(true);
    expect(llmCalls).toHaveLength(0);
    const persisted = store.list({
      topic: ENGAGEMENT_SENTIMENT_TOPIC,
      scope: 'connection.api.hubspot.deal',
      target_id: 'hubspot_deal_47291',
      authored_by: ENGAGEMENT_SENTIMENT_AUTHORED_BY,
    });
    expect((persisted[0]!.value as { tone: string }).tone).toBe('insufficient_signal');
  });

  it('skips automation rows BEFORE LLM call (no token spent) — tombstones', async () => {
    const rows = [
      buildRow({ authorship: 'crm_automation', target_id: 'r1' }),
      buildRow({ authorship: 'system_process', target_id: 'r2' }),
    ];
    const result = await processOneSentimentTrend(ctx(), buildInput(rows));
    expect(result.produced).toBe(true); // tombstone written
    expect(llmCalls).toHaveLength(0); // critical: no token spent on automation rows
  });

  it('skips pending lifecycle rows BEFORE LLM call — tombstones', async () => {
    const rows = [
      buildRow({ lifecycle_state: 'pending', target_id: 'r1' }),
      buildRow({ lifecycle_state: 'scheduled', target_id: 'r2' }),
    ];
    const result = await processOneSentimentTrend(ctx(), buildInput(rows));
    expect(result.produced).toBe(true); // tombstone written
    expect(llmCalls).toHaveLength(0); // critical: no token spent on pending rows
  });

  it('classifies a deal and writes a sentiment row at the deal scope', async () => {
    const rows = [
      buildRow({ event_at: FIXED_NOW - 10 * day, target_id: 'r1', body_inline: 'first reply' }),
      buildRow({ event_at: FIXED_NOW - 5 * day, target_id: 'r2', body_inline: 'second reply' }),
      buildRow({ event_at: FIXED_NOW - 1 * day, target_id: 'r3', body_inline: 'third reply' }),
    ];
    llmResponses.push({
      category: 'warming',
      confidence: 0.8,
      reasoning: 'replies are getting faster',
      key_phrases: ['fast_replies'],
    });
    const result = await processOneSentimentTrend(ctx(), buildInput(rows));
    expect(result.produced).toBe(true);
    const persisted = store.list({
      topic: ENGAGEMENT_SENTIMENT_TOPIC,
      scope: 'connection.api.hubspot.deal',
      target_id: 'hubspot_deal_47291',
      authored_by: ENGAGEMENT_SENTIMENT_AUTHORED_BY,
    });
    expect(persisted).toHaveLength(1);
    const value = persisted[0]!.value as EngagementSentimentTrendValue;
    expect(value.tone).toBe('warming');
    expect(value.samples).toBe(3);
    expect(value.cursor_at).toBe(FIXED_NOW - 1 * day);
  });

  it('threads the LLM force_layer + categories', async () => {
    const rows = [
      buildRow({ event_at: FIXED_NOW - 10 * day, target_id: 'r1' }),
      buildRow({ event_at: FIXED_NOW - 5 * day, target_id: 'r2' }),
      buildRow({ event_at: FIXED_NOW - 1 * day, target_id: 'r3' }),
    ];
    llmResponses.push({ category: 'steady', confidence: 0.5, reasoning: 'x' });
    await processOneSentimentTrend(ctx(), buildInput(rows));
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]!.input['llm.force_layer']).toBe('free');
    expect(llmCalls[0]!.input['llm.categories']).toEqual([
      'warming',
      'steady',
      'cooling',
      'volatile',
      'insufficient_signal',
    ]);
  });

  it('persisted value never carries raw body text — body lives only in prompt', async () => {
    const sensitiveBody = 'Internal: deal champion reaffirmed budget approval Wednesday.';
    const rows = [
      buildRow({ event_at: FIXED_NOW - 10 * day, target_id: 'r1', body_inline: sensitiveBody }),
      buildRow({ event_at: FIXED_NOW - 5 * day, target_id: 'r2', body_inline: sensitiveBody }),
      buildRow({ event_at: FIXED_NOW - 1 * day, target_id: 'r3', body_inline: sensitiveBody }),
    ];
    // LLM smuggles body content into key_phrases attempting to leak.
    llmResponses.push({
      category: 'warming',
      confidence: 0.9,
      reasoning: 'short reasoning',
      key_phrases: [sensitiveBody, 'ok_short_token'],
    });
    await processOneSentimentTrend(ctx(), buildInput(rows));
    const persisted = store.list({
      topic: ENGAGEMENT_SENTIMENT_TOPIC,
      scope: 'connection.api.hubspot.deal',
      target_id: 'hubspot_deal_47291',
      authored_by: ENGAGEMENT_SENTIMENT_AUTHORED_BY,
    });
    const value = persisted[0]!.value as EngagementSentimentTrendValue;
    // Body content stripped; only the short token survived.
    expect(value.key_phrases).toEqual(['ok_short_token']);
    // Verify nothing in the persisted row carries the body.
    const stringified = JSON.stringify(value);
    expect(stringified).not.toContain('budget approval Wednesday');
    // But the prompt did include it (defense in depth).
    expect(JSON.stringify(llmCalls[0]!.input)).toContain(sensitiveBody);
  });

  it('dedup steady-state cost zero — re-running on unchanged rows hits dedup', async () => {
    const rows = [
      buildRow({ event_at: FIXED_NOW - 10 * day, target_id: 'r1', vendor_modstamp: 'mod_1' }),
      buildRow({ event_at: FIXED_NOW - 5 * day, target_id: 'r2', vendor_modstamp: 'mod_2' }),
      buildRow({ event_at: FIXED_NOW - 1 * day, target_id: 'r3', vendor_modstamp: 'mod_3' }),
    ];
    llmResponses.push({ category: 'warming', confidence: 0.8, reasoning: 'first call' });
    const ctxInst = ctx();
    const first = await processOneSentimentTrend(ctxInst, buildInput(rows));
    expect(first.produced).toBe(true);
    expect(llmCalls).toHaveLength(1);

    // Re-run on identical rows — should hit dedup probe before LLM.
    const second = await processOneSentimentTrend(ctxInst, buildInput(rows));
    expect(second.produced).toBe(false);
    expect(second.reason).toBe('dedup_hit');
    // No second LLM call.
    expect(llmCalls).toHaveLength(1);
  });

  it('cross-pool invalidation — switching model_id forces recompute', async () => {
    const rows = [
      buildRow({ event_at: FIXED_NOW - 10 * day, target_id: 'r1', vendor_modstamp: 'mod_1' }),
      buildRow({ event_at: FIXED_NOW - 5 * day, target_id: 'r2', vendor_modstamp: 'mod_2' }),
      buildRow({ event_at: FIXED_NOW - 1 * day, target_id: 'r3', vendor_modstamp: 'mod_3' }),
    ];
    llmResponses.push({ category: 'warming', confidence: 0.8, reasoning: 'first call' });
    const ctxInst = ctx();
    await processOneSentimentTrend(ctxInst, buildInput(rows));
    expect(llmCalls).toHaveLength(1);

    // Switch the resolved model_id (simulating free→BYOK pool flip).
    llmModelId = 'anthropic:claude-haiku-4-5';
    llmResponses.push({ category: 'cooling', confidence: 0.4, reasoning: 'second call' });
    const second = await processOneSentimentTrend(ctxInst, buildInput(rows));
    expect(second.produced).toBe(true);
    expect(llmCalls).toHaveLength(2);
  });

  it('returns no_llm when ctx.llmWithMeta is unwired', async () => {
    const ctxNoLlm: HousekeepingContext = {
      ...ctx(),
      llmWithMeta: undefined,
    };
    const rows = [
      buildRow({ event_at: FIXED_NOW - 10 * day, target_id: 'r1' }),
      buildRow({ event_at: FIXED_NOW - 5 * day, target_id: 'r2' }),
      buildRow({ event_at: FIXED_NOW - 1 * day, target_id: 'r3' }),
    ];
    const result = await processOneSentimentTrend(ctxNoLlm, buildInput(rows));
    expect(result.produced).toBe(false);
    expect(result.reason).toBe('no_llm');
  });

  it('resolveSentimentTrendLayer defaults to any when no trustStore', () => {
    expect(resolveSentimentTrendLayer(ctx(), undefined)).toBe('any');
  });
});

describe('D-139 P5 — processOneNextBestAction integration', () => {
  let dir: string;
  let db: Database.Database;
  let store: EnrichmentStore;
  let now = FIXED_NOW;
  let llmCalls: Array<{ manifest: unknown; input: Record<string, unknown> }>;
  let llmResponses: unknown[];
  let llmModelId = 'groq:llama-3-70b';

  const ctx = (): HousekeepingContext => ({
    db,
    bus: {
      emit: () => undefined,
      subscribe: () => () => undefined,
      dispose: () => undefined,
    } as never,
    enrichmentStore: store,
    recipeStore: {} as never,
    now: () => now,
    emitAuditRow: () => undefined,
    llm: vi.fn(async (manifest, input) => {
      llmCalls.push({ manifest, input });
      if (llmResponses.length === 0) {
        throw new Error('no llm response queued');
      }
      return llmResponses.shift();
    }),
    llmWithMeta: vi.fn(async (manifest, input) => {
      llmCalls.push({ manifest, input });
      if (llmResponses.length === 0) {
        throw new Error('no llm response queued');
      }
      return { result: llmResponses.shift(), model_id: llmModelId };
    }),
    resolveLLMModelId: vi.fn(async () => llmModelId),
  });

  const buildInput = (rows: EngagementRow[]) => ({
    rows,
    scope: 'connection.api.hubspot.deal' as const,
    target_id: 'hubspot_deal_47291',
    coverage: EMPTY_COVERAGE,
    source_record_hash: 'fnv1a:hubspot_deal_47291_anchor',
    as_of: now,
    now,
    forceLayer: 'free' as const,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd-139-p5-nba-'));
    db = new Database(join(dir, 'test.db'));
    db.pragma('journal_mode = WAL');
    store = createEnrichmentStore(db);
    now = FIXED_NOW;
    llmCalls = [];
    llmResponses = [];
    llmModelId = 'groq:llama-3-70b';
  });

  afterEach(() => {
    store.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips truncated_inline body rows BEFORE LLM call — tombstones (NBA needs full body)', async () => {
    const rows = [
      buildRow({ body_state: 'truncated_inline', body_inline: 'pre…', target_id: 'r1' }),
    ];
    const result = await processOneNextBestAction(ctx(), buildInput(rows));
    expect(result.produced).toBe(true); // tombstone written
    expect(llmCalls).toHaveLength(0); // critical: no token spent
  });

  it('classifies a deal and writes an action row', async () => {
    const rows = [
      buildRow({ event_at: FIXED_NOW - 5 * day, target_id: 'r1' }),
      buildRow({ event_at: FIXED_NOW - 1 * day, target_id: 'r2' }),
    ];
    llmResponses.push({
      category: 'send_email',
      confidence: 0.7,
      reasoning: 'Last touch was a question that needs a follow-up.',
    });
    const result = await processOneNextBestAction(ctx(), buildInput(rows));
    expect(result.produced).toBe(true);
    const persisted = store.list({
      topic: NEXT_BEST_ACTION_TOPIC,
      scope: 'connection.api.hubspot.deal',
      target_id: 'hubspot_deal_47291',
      authored_by: NEXT_BEST_ACTION_AUTHORED_BY,
    });
    expect(persisted).toHaveLength(1);
    const value = persisted[0]!.value as NextBestActionValue;
    expect(value.action).toBe('send_email');
    expect(value.confidence).toBe(0.7);
    expect(value.samples).toBe(2);
  });

  it('persisted value never carries raw body text — only short rationale', async () => {
    const sensitiveBody = 'Internal: champion noted purchase approval will arrive Friday.';
    const rows = [
      buildRow({ event_at: FIXED_NOW - 5 * day, target_id: 'r1', body_inline: sensitiveBody }),
      buildRow({ event_at: FIXED_NOW - 1 * day, target_id: 'r2', body_inline: sensitiveBody }),
    ];
    llmResponses.push({
      category: 'wait',
      confidence: 0.6,
      reasoning: sensitiveBody, // LLM tries to smuggle body content via reasoning.
    });
    await processOneNextBestAction(ctx(), buildInput(rows));
    const persisted = store.list({
      topic: NEXT_BEST_ACTION_TOPIC,
      scope: 'connection.api.hubspot.deal',
      target_id: 'hubspot_deal_47291',
      authored_by: NEXT_BEST_ACTION_AUTHORED_BY,
    });
    const value = persisted[0]!.value as NextBestActionValue;
    // Rationale capped at the registry char limit — long body strings
    // get truncated at the producer.
    expect(value.rationale.length).toBeLessThanOrEqual(NEXT_BEST_ACTION_MAX_RATIONALE_CHARS);
    // Defense in depth: body did flow through the prompt path.
    expect(JSON.stringify(llmCalls[0]!.input)).toContain(sensitiveBody);
  });

  it('dedup steady-state cost zero', async () => {
    const rows = [
      buildRow({ event_at: FIXED_NOW - 5 * day, target_id: 'r1', vendor_modstamp: 'mod_1' }),
      buildRow({ event_at: FIXED_NOW - 1 * day, target_id: 'r2', vendor_modstamp: 'mod_2' }),
    ];
    llmResponses.push({ category: 'wait', confidence: 0.5, reasoning: 'first' });
    const ctxInst = ctx();
    await processOneNextBestAction(ctxInst, buildInput(rows));
    expect(llmCalls).toHaveLength(1);
    const second = await processOneNextBestAction(ctxInst, buildInput(rows));
    expect(second.reason).toBe('dedup_hit');
    expect(llmCalls).toHaveLength(1);
  });

  it('cross-pool invalidation — switching model_id forces recompute', async () => {
    const rows = [
      buildRow({ event_at: FIXED_NOW - 5 * day, target_id: 'r1', vendor_modstamp: 'mod_1' }),
      buildRow({ event_at: FIXED_NOW - 1 * day, target_id: 'r2', vendor_modstamp: 'mod_2' }),
    ];
    llmResponses.push({ category: 'wait', confidence: 0.5, reasoning: 'first' });
    const ctxInst = ctx();
    await processOneNextBestAction(ctxInst, buildInput(rows));
    expect(llmCalls).toHaveLength(1);
    llmModelId = 'anthropic:claude-haiku-4-5';
    llmResponses.push({ category: 'investigate', confidence: 0.4, reasoning: 'second' });
    const second = await processOneNextBestAction(ctxInst, buildInput(rows));
    expect(second.produced).toBe(true);
    expect(llmCalls).toHaveLength(2);
  });

  it('returns no_llm when llmWithMeta is unwired', async () => {
    const ctxNoLlm: HousekeepingContext = { ...ctx(), llmWithMeta: undefined };
    const rows = [
      buildRow({ event_at: FIXED_NOW - 5 * day, target_id: 'r1' }),
      buildRow({ event_at: FIXED_NOW - 1 * day, target_id: 'r2' }),
    ];
    const result = await processOneNextBestAction(ctxNoLlm, buildInput(rows));
    expect(result.reason).toBe('no_llm');
  });

  it('resolveNextBestActionLayer defaults to any when no trustStore', () => {
    expect(resolveNextBestActionLayer(ctx(), undefined)).toBe('any');
  });
});

// ────────────────────────────────────────────────────────────────
// D-139 P5 Codex review fold-back — body-leak guard, zero-row
// tombstone, window enforcement, evidence-aware fingerprint
// ────────────────────────────────────────────────────────────────

describe('D-139 P5 — Codex P1 fold-back: body-excerpt detection in NBA rationale', () => {
  it('containsBodyExcerpt detects 30-char overlap from a body sentence', () => {
    const row = buildRow({ body_inline: 'Champion confirmed budget approval will arrive Friday.' });
    expect(containsBodyExcerpt('Champion confirmed budget approval will arrive', [row])).toBe(true);
  });
  it('containsBodyExcerpt is whitespace + case insensitive', () => {
    const row = buildRow({ body_inline: 'Champion confirmed budget approval will arrive Friday.' });
    expect(
      containsBodyExcerpt(
        'CHAMPION   CONFIRMED   BUDGET   APPROVAL   WILL    ARRIVE',
        [row],
      ),
    ).toBe(true);
  });
  it('containsBodyExcerpt returns false when rationale is unrelated meta-description', () => {
    const row = buildRow({ body_inline: 'Champion confirmed budget approval will arrive Friday.' });
    expect(
      containsBodyExcerpt('Send a follow-up email; last touch was 4 days ago.', [row]),
    ).toBe(false);
  });
  it('containsBodyExcerpt returns false on short rationale (under 30 chars)', () => {
    const row = buildRow({ body_inline: 'Champion confirmed budget approval will arrive Friday.' });
    expect(containsBodyExcerpt('Send a note.', [row])).toBe(false);
  });
  it('containsBodyExcerpt returns false when row has no body_inline', () => {
    const row = buildRow({ body_state: 'mail_link', body_inline: undefined });
    expect(
      containsBodyExcerpt('Champion confirmed budget approval will arrive', [row]),
    ).toBe(false);
  });
  it('buildNextBestActionValue replaces body-leaking rationale with safe fallback', () => {
    const sensitiveBody = 'Champion confirmed budget approval will arrive Friday.';
    const row = buildRow({ body_inline: sensitiveBody });
    const v = buildNextBestActionValue(
      {
        category: 'wait',
        confidence: 0.7,
        reasoning: sensitiveBody, // LLM echoes a body sentence under the 200-char cap
      },
      4,
      0,
      FIXED_NOW,
      [row],
    );
    expect(v.action).toBe('wait');
    expect(v.confidence).toBe(0.7);
    expect(v.rationale).toBe(NEXT_BEST_ACTION_BODY_LEAK_FALLBACK_RATIONALE);
  });
  it('buildNextBestActionValue passes through legitimate meta-rationale', () => {
    const row = buildRow({ body_inline: 'Looking forward to next week.' });
    const v = buildNextBestActionValue(
      { category: 'wait', confidence: 0.6, reasoning: 'Last touch was 3 days ago; await response.' },
      4,
      0,
      FIXED_NOW,
      [row],
    );
    expect(v.rationale).toBe('Last touch was 3 days ago; await response.');
  });
});

describe('D-139 P5 — Codex P2 fold-back: window enforcement', () => {
  it('filterRowsForSentiment rejects rows older than window_cutoff_at', () => {
    const recent = buildRow({ event_at: FIXED_NOW - 30 * day, target_id: 'recent' });
    const ancient = buildRow({ event_at: FIXED_NOW - 200 * day, target_id: 'ancient' });
    const cutoff = FIXED_NOW - ENGAGEMENT_SENTIMENT_WINDOW_MS;
    const filtered = filterRowsForSentiment([recent, ancient], cutoff);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.target_id).toBe('recent');
  });
  it('filterRowsForSentiment with no cutoff (legacy path) accepts ancient rows', () => {
    const ancient = buildRow({ event_at: FIXED_NOW - 200 * day });
    expect(filterRowsForSentiment([ancient])).toHaveLength(1);
  });
  it('filterRowsForNextBestAction rejects rows older than window_cutoff_at', () => {
    const recent = buildRow({ event_at: FIXED_NOW - 30 * day, target_id: 'recent' });
    const ancient = buildRow({ event_at: FIXED_NOW - 200 * day, target_id: 'ancient' });
    const cutoff = FIXED_NOW - NEXT_BEST_ACTION_WINDOW_MS;
    const filtered = filterRowsForNextBestAction([recent, ancient], cutoff);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.target_id).toBe('recent');
  });
});

describe('D-139 P5 — Codex P2 fold-back: evidence-aware source hash', () => {
  it('composeSentimentSourceHash flips when authorship reclassifies without modstamp change', () => {
    const a = buildRow({ authorship: 'user', vendor_modstamp: 'mod_1' });
    const b = buildRow({ authorship: 'crm_user', vendor_modstamp: 'mod_1' });
    expect(composeSentimentSourceHash(a)).not.toBe(composeSentimentSourceHash(b));
  });
  it('composeSentimentSourceHash flips when body_inline becomes available without modstamp change', () => {
    const a = buildRow({ body_state: 'mail_link', body_inline: undefined, vendor_modstamp: 'mod_1' });
    const b = buildRow({ body_state: 'inline_body', body_inline: 'now visible', vendor_modstamp: 'mod_1' });
    expect(composeSentimentSourceHash(a)).not.toBe(composeSentimentSourceHash(b));
  });
  it('composeSentimentSourceHash flips when lifecycle_state reclassifies', () => {
    const a = buildRow({ lifecycle_state: 'point_in_time', vendor_modstamp: 'mod_1' });
    const b = buildRow({ lifecycle_state: 'completed', vendor_modstamp: 'mod_1' });
    expect(composeSentimentSourceHash(a)).not.toBe(composeSentimentSourceHash(b));
  });
  it('composeNextBestActionSourceHash flips on body content rewrite (mirror_blob fetch)', () => {
    const a = buildRow({ body_inline: 'first body', vendor_modstamp: 'mod_1' });
    const b = buildRow({ body_inline: 'rewritten body after mirror_blob fetch', vendor_modstamp: 'mod_1' });
    expect(composeNextBestActionSourceHash(a)).not.toBe(composeNextBestActionSourceHash(b));
  });
  it('composeSentimentSourceHash is stable on identical rows (steady-state dedup)', () => {
    const r1 = buildRow({ vendor_modstamp: 'mod_1', body_inline: 'same' });
    const r2 = buildRow({ vendor_modstamp: 'mod_1', body_inline: 'same' });
    expect(composeSentimentSourceHash(r1)).toBe(composeSentimentSourceHash(r2));
  });
});

describe('D-139 P5 — Codex P2 fold-back: zero-row tombstone (sentiment)', () => {
  let dir: string;
  let db: Database.Database;
  let store: EnrichmentStore;
  let now = FIXED_NOW;
  let llmCalls: Array<{ manifest: unknown; input: Record<string, unknown> }>;
  let llmResponses: unknown[];

  const ctx = (): HousekeepingContext => ({
    db,
    bus: {
      emit: () => undefined,
      subscribe: () => () => undefined,
      dispose: () => undefined,
    } as never,
    enrichmentStore: store,
    recipeStore: {} as never,
    now: () => now,
    emitAuditRow: () => undefined,
    llm: vi.fn(async (manifest, input) => {
      llmCalls.push({ manifest, input });
      if (llmResponses.length === 0) {
        throw new Error('no llm response queued');
      }
      return llmResponses.shift();
    }),
    llmWithMeta: vi.fn(async (manifest, input) => {
      llmCalls.push({ manifest, input });
      if (llmResponses.length === 0) {
        throw new Error('no llm response queued');
      }
      return { result: llmResponses.shift(), model_id: 'groq:llama-3-70b' };
    }),
    resolveLLMModelId: vi.fn(async () => 'groq:llama-3-70b'),
  });

  const buildInput = (rows: EngagementRow[]) => ({
    rows,
    scope: 'connection.api.hubspot.deal' as const,
    target_id: 'hubspot_deal_47291',
    coverage: EMPTY_COVERAGE,
    source_record_hash: 'fnv1a:hubspot_deal_47291_anchor',
    as_of: now,
    now,
    forceLayer: 'free' as const,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd-139-p5-tombstone-'));
    db = new Database(join(dir, 'test.db'));
    db.pragma('journal_mode = WAL');
    store = createEnrichmentStore(db);
    now = FIXED_NOW;
    llmCalls = [];
    llmResponses = [];
  });

  afterEach(() => {
    store.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes an insufficient_signal row when zero qualifying rows (no LLM call)', async () => {
    const result = await processOneSentimentTrend(ctx(), buildInput([]));
    expect(result.produced).toBe(true);
    expect(llmCalls).toHaveLength(0);
    const persisted = store.list({
      topic: ENGAGEMENT_SENTIMENT_TOPIC,
      scope: 'connection.api.hubspot.deal',
      target_id: 'hubspot_deal_47291',
      authored_by: ENGAGEMENT_SENTIMENT_AUTHORED_BY,
    });
    expect(persisted).toHaveLength(1);
    const value = persisted[0]!.value as { tone: string; samples: number };
    expect(value.tone).toBe('insufficient_signal');
    expect(value.samples).toBe(0);
  });

  it('zero-row tombstone re-runs hit dedup (no second write)', async () => {
    const ctxInst = ctx();
    const first = await processOneSentimentTrend(ctxInst, buildInput([]));
    expect(first.produced).toBe(true);
    const second = await processOneSentimentTrend(ctxInst, buildInput([]));
    expect(second.produced).toBe(false);
    expect(second.reason).toBe('dedup_hit');
  });

  it('previously-populated → zero-row transition writes the tombstone', async () => {
    const ctxInst = ctx();
    // First cycle — populated.
    const populatedRows = [
      buildRow({ event_at: FIXED_NOW - 10 * day, target_id: 'r1' }),
      buildRow({ event_at: FIXED_NOW - 5 * day, target_id: 'r2' }),
      buildRow({ event_at: FIXED_NOW - 1 * day, target_id: 'r3' }),
    ];
    llmResponses.push({ category: 'warming', confidence: 0.8, reasoning: 'fast replies' });
    await processOneSentimentTrend(ctxInst, buildInput(populatedRows));
    // Second cycle — zero qualifying. Tombstone replaces fresh chain.
    const second = await processOneSentimentTrend(ctxInst, buildInput([]));
    expect(second.produced).toBe(true);
    const fresh = store.list({
      topic: ENGAGEMENT_SENTIMENT_TOPIC,
      scope: 'connection.api.hubspot.deal',
      target_id: 'hubspot_deal_47291',
      authored_by: ENGAGEMENT_SENTIMENT_AUTHORED_BY,
      fresh_only: true,
    });
    const value = fresh[0]!.value as { tone: string; samples: number };
    expect(value.tone).toBe('insufficient_signal');
    expect(value.samples).toBe(0);
  });
});

describe('D-139 P5 — Codex P2 fold-back: zero-row tombstone (NBA)', () => {
  let dir: string;
  let db: Database.Database;
  let store: EnrichmentStore;
  let now = FIXED_NOW;
  let llmCalls: Array<{ manifest: unknown; input: Record<string, unknown> }>;
  let llmResponses: unknown[];

  const ctx = (): HousekeepingContext => ({
    db,
    bus: {
      emit: () => undefined,
      subscribe: () => () => undefined,
      dispose: () => undefined,
    } as never,
    enrichmentStore: store,
    recipeStore: {} as never,
    now: () => now,
    emitAuditRow: () => undefined,
    llm: vi.fn(async (manifest, input) => {
      llmCalls.push({ manifest, input });
      if (llmResponses.length === 0) throw new Error('no llm response queued');
      return llmResponses.shift();
    }),
    llmWithMeta: vi.fn(async (manifest, input) => {
      llmCalls.push({ manifest, input });
      if (llmResponses.length === 0) throw new Error('no llm response queued');
      return { result: llmResponses.shift(), model_id: 'groq:llama-3-70b' };
    }),
    resolveLLMModelId: vi.fn(async () => 'groq:llama-3-70b'),
  });

  const buildInput = (rows: EngagementRow[]) => ({
    rows,
    scope: 'connection.api.hubspot.deal' as const,
    target_id: 'hubspot_deal_47291',
    coverage: EMPTY_COVERAGE,
    source_record_hash: 'fnv1a:hubspot_deal_47291_anchor',
    as_of: now,
    now,
    forceLayer: 'free' as const,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd-139-p5-nba-tombstone-'));
    db = new Database(join(dir, 'test.db'));
    db.pragma('journal_mode = WAL');
    store = createEnrichmentStore(db);
    now = FIXED_NOW;
    llmCalls = [];
    llmResponses = [];
  });

  afterEach(() => {
    store.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a no_action row when zero qualifying rows (no LLM call)', async () => {
    const result = await processOneNextBestAction(ctx(), buildInput([]));
    expect(result.produced).toBe(true);
    expect(llmCalls).toHaveLength(0);
    const persisted = store.list({
      topic: NEXT_BEST_ACTION_TOPIC,
      scope: 'connection.api.hubspot.deal',
      target_id: 'hubspot_deal_47291',
      authored_by: NEXT_BEST_ACTION_AUTHORED_BY,
    });
    const value = persisted[0]!.value as { action: string; samples: number };
    expect(value.action).toBe('no_action');
    expect(value.samples).toBe(0);
  });

  it('NBA zero-row tombstone re-runs hit dedup', async () => {
    const ctxInst = ctx();
    await processOneNextBestAction(ctxInst, buildInput([]));
    const second = await processOneNextBestAction(ctxInst, buildInput([]));
    expect(second.produced).toBe(false);
    expect(second.reason).toBe('dedup_hit');
  });

  it('NBA persisted body-leak fallback rationale survives integration write', async () => {
    const ctxInst = ctx();
    const sensitiveBody = 'Champion confirmed approval will land on the budget side this week.';
    const rows = [
      buildRow({ event_at: FIXED_NOW - 5 * day, target_id: 'r1', body_inline: sensitiveBody }),
      buildRow({ event_at: FIXED_NOW - 1 * day, target_id: 'r2', body_inline: sensitiveBody }),
    ];
    // LLM echoes a 30+ char body excerpt verbatim in reasoning under the 200-char cap.
    llmResponses.push({
      category: 'wait',
      confidence: 0.6,
      reasoning: 'Champion confirmed approval will land on the budget side',
    });
    await processOneNextBestAction(ctxInst, buildInput(rows));
    const persisted = store.list({
      topic: NEXT_BEST_ACTION_TOPIC,
      scope: 'connection.api.hubspot.deal',
      target_id: 'hubspot_deal_47291',
      authored_by: NEXT_BEST_ACTION_AUTHORED_BY,
    });
    const value = persisted[0]!.value as { action: string; rationale: string };
    expect(value.action).toBe('wait');
    expect(value.rationale).toBe(NEXT_BEST_ACTION_BODY_LEAK_FALLBACK_RATIONALE);
  });
});

describe('D-139 P5 — Codex P2 fold-back: window enforcement integration', () => {
  let dir: string;
  let db: Database.Database;
  let store: EnrichmentStore;
  let now = FIXED_NOW;
  let llmCalls: Array<{ manifest: unknown; input: Record<string, unknown> }>;
  let llmResponses: unknown[];

  const ctx = (): HousekeepingContext => ({
    db,
    bus: {
      emit: () => undefined,
      subscribe: () => () => undefined,
      dispose: () => undefined,
    } as never,
    enrichmentStore: store,
    recipeStore: {} as never,
    now: () => now,
    emitAuditRow: () => undefined,
    llm: vi.fn(),
    llmWithMeta: vi.fn(async (manifest, input) => {
      llmCalls.push({ manifest, input });
      if (llmResponses.length === 0) throw new Error('no llm response queued');
      return { result: llmResponses.shift(), model_id: 'groq:llama-3-70b' };
    }),
    resolveLLMModelId: vi.fn(async () => 'groq:llama-3-70b'),
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd-139-p5-window-'));
    db = new Database(join(dir, 'test.db'));
    db.pragma('journal_mode = WAL');
    store = createEnrichmentStore(db);
    now = FIXED_NOW;
    llmCalls = [];
    llmResponses = [];
  });

  afterEach(() => {
    store.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('processOneSentimentTrend rejects ancient rows (over 60d) at the window cutoff', async () => {
    const ancient = [
      buildRow({ event_at: FIXED_NOW - 200 * day, target_id: 'a1' }),
      buildRow({ event_at: FIXED_NOW - 300 * day, target_id: 'a2' }),
      buildRow({ event_at: FIXED_NOW - 400 * day, target_id: 'a3' }),
    ];
    const result = await processOneSentimentTrend(ctx(), {
      rows: ancient,
      scope: 'connection.api.hubspot.deal',
      target_id: 'hubspot_deal_47291',
      coverage: EMPTY_COVERAGE,
      source_record_hash: 'fnv1a:hubspot_deal_47291_anchor',
      as_of: now,
      now,
      forceLayer: 'free' as const,
    });
    // Ancient rows filtered out → tombstone path → no LLM call.
    expect(result.produced).toBe(true);
    expect(llmCalls).toHaveLength(0);
    const persisted = store.list({
      topic: ENGAGEMENT_SENTIMENT_TOPIC,
      scope: 'connection.api.hubspot.deal',
      target_id: 'hubspot_deal_47291',
      authored_by: ENGAGEMENT_SENTIMENT_AUTHORED_BY,
    });
    const value = persisted[0]!.value as { tone: string; samples: number };
    expect(value.tone).toBe('insufficient_signal');
    expect(value.samples).toBe(0);
  });

  it('processOneNextBestAction rejects ancient rows at the window cutoff', async () => {
    const ancient = [
      buildRow({ event_at: FIXED_NOW - 200 * day, target_id: 'a1' }),
    ];
    const result = await processOneNextBestAction(ctx(), {
      rows: ancient,
      scope: 'connection.api.hubspot.deal',
      target_id: 'hubspot_deal_47291',
      coverage: EMPTY_COVERAGE,
      source_record_hash: 'fnv1a:hubspot_deal_47291_anchor',
      as_of: now,
      now,
      forceLayer: 'free' as const,
    });
    expect(result.produced).toBe(true);
    expect(llmCalls).toHaveLength(0);
    const persisted = store.list({
      topic: NEXT_BEST_ACTION_TOPIC,
      scope: 'connection.api.hubspot.deal',
      target_id: 'hubspot_deal_47291',
      authored_by: NEXT_BEST_ACTION_AUTHORED_BY,
    });
    const value = persisted[0]!.value as { action: string; samples: number };
    expect(value.action).toBe('no_action');
    expect(value.samples).toBe(0);
  });
});

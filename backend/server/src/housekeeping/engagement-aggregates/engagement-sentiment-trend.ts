/** D-139 P5 — `engagement_sentiment_trend` AI-surface producer.
 *
 *  Tone trajectory across a deal's recent engagement window. Folds
 *  qualifying engagement rows (filtered per the topic's registry-
 *  declared evidence-quality acceptance fields) into an AI-derived
 *  closed-bucket tone read + score in [-1, 1] + up to 5 short
 *  key-phrase tokens.
 *
 *  Pass-4 evidence-quality consumption defaults are declared on the
 *  `engagement_sentiment_trend` registry entry as substrate contracts
 *  rather than baked into producer code (P5 substrate widening over
 *  the P3/P4 inline-comment pattern):
 *
 *    - `body_state_acceptance`: ['mail_link', 'calendar_link',
 *      'inline_body', 'truncated_inline'] — tone-from-preview is
 *      partial-but-useful so we accept truncated inline.
 *    - `authorship_acceptance`: ['user', 'crm_user', 'unknown'] —
 *      skip `'crm_automation'` + `'system_process'` (tracking-pixel
 *      rows + workflow auto-logs are tonally meaningless).
 *    - `lifecycle_state_acceptance`: ['point_in_time', 'completed'] —
 *      pending tasks + scheduled meetings + cancelled / failed /
 *      no-answer rows are activity records, not tone evidence.
 *    - `dedupe_acceptance`: 'exact_only' — probable-twin pairs
 *      counted as separate touches; never collapse into one tone
 *      signal.
 *
 *  Producer input fingerprint: `aggregate_window_fold` over the
 *  qualifying rows' `source_record_hash` set + the producer's 60d
 *  read window. Cross-pool invalidation flows through
 *  `runAIProducer`'s probe-model_id check at call time.
 *
 *  Output value-shape invariants (Pass-3 R3.6):
 *    - NO raw body text in `value`. Producer composes `key_phrases`
 *      as ≤ 5 tokens × ≤ 64 chars each — registry validator caps
 *      both count + per-token length so a misbehaving LLM can't
 *      smuggle body excerpts through.
 *    - Coverage metadata caller-supplied per § A.9.3.
 *    - `samples` count + `cursor_at` (max source `vendor_modified_at`)
 *      so consumers can reason about sample density + freshness.
 *
 *  Production cycle wiring is deferred — same shape as the P3/P4
 *  pure-compute producers in this directory. The pure-compute +
 *  prompt-builder + producer-entry-point split lets per-piece tests
 *  exercise the substrate without setting up the full housekeeping
 *  cycle; integration wiring lands when the engagement-aggregate
 *  reactive harness ships.
 *
 *  Spec: D-139 § A.9.2 + § A.9.5 + § P5 acceptance. */

import {
  ENRICHMENT_REGISTRY,
  ENGAGEMENT_SENTIMENT_MAX_KEY_PHRASES,
  ENGAGEMENT_SENTIMENT_MAX_KEY_PHRASE_CHARS,
  computeProducerVersionHash,
  type Authorship,
  type BodyState,
  type CoverageMetadata,
  type EngagementLifecycleState,
  type EngagementRow,
  type EngagementSentimentTone,
  type EngagementSentimentTrendValue,
  type EnrichmentScope,
  type EnrichmentTopic,
  type IngredientManifest,
} from '@recued/contracts';
import type { ForceLayer } from '@recued/llm';

import { fnv1aHex } from '../../data/hubspot/_fnv1a.js';
import { runAIProducer } from '../ai-producer-wrapper.js';
import type { HousekeepingContext } from '../registry.js';
import {
  isByokAllowedForBackground,
  type TrustStore,
} from '../trust-store.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Topic + scope. */
export const ENGAGEMENT_SENTIMENT_TOPIC: EnrichmentTopic =
  'engagement_sentiment_trend';
export const ENGAGEMENT_SENTIMENT_AUTHORED_BY =
  'system.housekeeping.engagement_sentiment_trend';

/** Producer's read window in milliseconds. Mirrors the registry's
 *  `aggregate_window_ms` declaration so the input fingerprint folds
 *  the same window the producer actually reads. */
export const ENGAGEMENT_SENTIMENT_WINDOW_MS =
  60 * 24 * 60 * 60 * 1000;

/** Per-row body preview cap in chars. Keeps prompt size bounded
 *  regardless of body length; enough context to read tone but not
 *  enough to leak full message content via the LLM provider's
 *  audit log. */
export const ENGAGEMENT_SENTIMENT_BODY_PREVIEW_CHARS = 300;

/** Hard cap on rows folded per call. Larger samples don't materially
 *  improve tone reads but cost tokens linearly. */
export const ENGAGEMENT_SENTIMENT_MAX_ROWS = 30;

/** Min sample density floor — below this, tone bucket reverts to
 *  `'insufficient_signal'`. */
export const ENGAGEMENT_SENTIMENT_MIN_SAMPLE = 3;

/** Per-call token estimate. ~600 input (30 rows × ~15 token preview
 *  each + prompt scaffolding) + ~100 output (categorical bucket +
 *  score + ≤ 5 phrase tokens). Aligns with `summary` (~250) but
 *  slightly higher because of the multi-row fold. */
export const ENGAGEMENT_SENTIMENT_TOKEN_ESTIMATE = 700;

// ────────────────────────────────────────────────────────────────
// AI manifest + prompt scaffolding
// ────────────────────────────────────────────────────────────────

/** Inline `IngredientManifest` matching `community/ingredients/ai-classify.json`.
 *  Same shape `lifecycle_stage_inferred*` producers use — once a
 *  fourth call site ships we'll extract a shared kernel-manifest
 *  table. */
const aiClassifyManifest: IngredientManifest = {
  slug: 'ai-classify',
  name: 'AI Classifier',
  description:
    'Picks one category from a provided list that best fits the input data.',
  author: 'recued-core',
  kind: 'ai',
  category: 'ai',
  risk_tier: 'read',
  version: 1,
  tags: ['ai', 'classification'],
  input: {
    'llm.data': null,
    'llm.categories': null,
    'llm.context': null,
    'llm.model_hint': null,
  },
  output: {
    category: 'category',
    confidence: 'confidence',
    reasoning: 'reasoning',
  },
};

const SENTIMENT_CLASSIFY_CONTEXT =
  "Read the recent engagement evidence and classify the deal's tone trajectory. " +
  'warming: the most recent activity shows clearer interest than the older activity (faster replies, positive phrasing, more meetings landed, deal-progression questions). ' +
  'steady: tone is consistent across the window, neither warming nor cooling. ' +
  'cooling: the most recent activity shows less interest than older activity (slower or no replies, hedging language, meetings cancelled or rescheduled, fewer questions). ' +
  'volatile: tone whiplashes within the window — strong positive engagement followed by strong cooling, or vice versa. ' +
  'insufficient_signal: less than three substantive touches in the window OR every touch is too short / too generic to read tone from. ' +
  'When the trend is ambiguous between adjacent buckets, prefer steady. Tone judgement should weight the most recent third of the window more heavily.';

// ────────────────────────────────────────────────────────────────
// Pure helpers (testable without LLM)
// ────────────────────────────────────────────────────────────────

const ACCEPTABLE_BODY_STATES: ReadonlySet<BodyState> = new Set(
  ENRICHMENT_REGISTRY.engagement_sentiment_trend
    .body_state_acceptance ?? [],
);
const ACCEPTABLE_AUTHORSHIPS: ReadonlySet<Authorship> = new Set(
  ENRICHMENT_REGISTRY.engagement_sentiment_trend.authorship_acceptance ?? [],
);
const ACCEPTABLE_LIFECYCLE_STATES: ReadonlySet<EngagementLifecycleState> =
  new Set(
    ENRICHMENT_REGISTRY.engagement_sentiment_trend
      .lifecycle_state_acceptance ?? [],
  );

/** Filter rows per the registry-declared acceptance fields + the
 *  producer's declared aggregate window. Pure / testable. Producers
 *  call this BEFORE composing the prompt so the LLM never sees rows
 *  the topic explicitly skips.
 *
 *  Codex P2 fold-back (window enforcement): when `window_cutoff_at` is
 *  supplied, rows with `event_at < window_cutoff_at` are rejected so
 *  ancient touches can't satisfy the sample floor despite the
 *  registry's `aggregate_window_ms: 60d`. */
export const filterRowsForSentiment = (
  rows: ReadonlyArray<EngagementRow>,
  window_cutoff_at?: number,
): EngagementRow[] => {
  const out: EngagementRow[] = [];
  for (const row of rows) {
    if (row.event_at === null) continue;
    if (window_cutoff_at !== undefined && row.event_at < window_cutoff_at) continue;
    if (!ACCEPTABLE_AUTHORSHIPS.has(row.authorship)) continue;
    if (!ACCEPTABLE_LIFECYCLE_STATES.has(row.lifecycle_state)) continue;
    // Body-state gate: if `body_state_acceptance` lists the row's body
    // state we accept it; rows with unaccepted states are still useful
    // for the sample-density count but the prompt builder won't render
    // their body preview. Producer keeps them in the qualifying set so
    // `samples` reflects evidence count, not just bodies-with-text.
    if (!ACCEPTABLE_BODY_STATES.has(row.body_state)) continue;
    out.push(row);
  }
  return out;
};

/** Compose the per-row source-record hash fed into the
 *  aggregate_window_fold fingerprint. Includes substrate-derived
 *  evidence fields so the dedup probe correctly invalidates when
 *  body content / authorship / lifecycle / direction reclassifies
 *  WITHOUT a vendor_modstamp change (Codex P2 fold-back).
 *
 *  Composition is order-stable + deterministic — a single field
 *  change flips the per-row hash which flips the
 *  aggregate_window_fold fingerprint which forces recompute. */
export const composeSentimentSourceHash = (row: EngagementRow): string => {
  const modstamp = row.vendor_modstamp ?? String(row.vendor_modified_at);
  // Body-content hash — captures redaction / availability changes
  // (body becoming truncated_inline → inline_body or vice versa, body
  // being rewritten by mirror_blob fetch, etc).
  const body_content_hash = fnv1aHex(row.body_inline ?? '');
  const composed = [
    row.connection_id,
    row.target_id,
    modstamp,
    row.authorship,
    row.direction,
    row.lifecycle_state,
    row.body_state,
    body_content_hash,
  ].join('\x1f');
  return `fnv1a:${fnv1aHex(composed)}`;
};

/** Truncate a body preview to the per-row cap. Returns an empty string
 *  when the row's body isn't inline (mail_link / calendar_link rows
 *  carry no body text in the substrate). */
export const truncateSentimentBodyPreview = (row: EngagementRow): string => {
  const body = row.body_inline;
  if (typeof body !== 'string') return '';
  const trimmed = body.trim();
  if (trimmed.length === 0) return '';
  if (trimmed.length <= ENGAGEMENT_SENTIMENT_BODY_PREVIEW_CHARS) return trimmed;
  return `${trimmed.slice(0, ENGAGEMENT_SENTIMENT_BODY_PREVIEW_CHARS - 1)}…`;
};

/** Compose the prompt body fed to `ai-classify`. Pure / testable.
 *  Prompt enumerates the qualifying rows in event_at-ascending order
 *  (oldest first → newest last) so the LLM can read trajectory; each
 *  row contributes vendor + entity + authorship + direction + a
 *  truncated body preview (when available). */
export const buildSentimentPrompt = (
  deal_target_id: string,
  rows: ReadonlyArray<EngagementRow>,
): string => {
  const lines: string[] = [];
  lines.push(`Deal: ${deal_target_id}`);
  lines.push(`Engagement window: ${rows.length} touches (oldest first)`);
  lines.push('');
  // Sort ascending by event_at — non-null guaranteed by filter.
  const sorted = [...rows].sort(
    (a, b) => (a.event_at as number) - (b.event_at as number),
  );
  // Cap the prompt size — older rows fold into "[...n earlier touches
  // omitted...]" if we exceed the row cap.
  const head = sorted.slice(
    Math.max(0, sorted.length - ENGAGEMENT_SENTIMENT_MAX_ROWS),
  );
  if (head.length < sorted.length) {
    lines.push(
      `[${sorted.length - head.length} earlier touches omitted — only the most recent ${ENGAGEMENT_SENTIMENT_MAX_ROWS} folded]`,
    );
  }
  for (const row of head) {
    const at = new Date(row.event_at as number).toISOString();
    const preview = truncateSentimentBodyPreview(row);
    lines.push(
      `- [${at}] ${row.vendor}/${row.entity} authorship=${row.authorship} direction=${row.direction}` +
        (preview.length > 0 ? `: ${preview}` : ''),
    );
  }
  return lines.join('\n');
};

/** Validated AI output. */
export interface SentimentClassifyOutput {
  category: EngagementSentimentTone;
  confidence: number;
  reasoning: string;
  /** Optional — LLM may include short tokens in the reasoning slot;
   *  producer extracts them. Distinct from the validated reasoning
   *  string. Empty when the LLM didn't include any. */
  key_phrases?: ReadonlyArray<string>;
}

const SENTIMENT_TONES_SET: ReadonlySet<string> = new Set([
  'warming',
  'steady',
  'cooling',
  'volatile',
  'insufficient_signal',
]);

/** Validate top-level ai-classify output for the sentiment topic. */
export const validateSentimentClassifyOutput = (
  raw: unknown,
): SentimentClassifyOutput => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      'engagement_sentiment_trend_output_invalid: ai-classify returned non-object',
    );
  }
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.category !== 'string' ||
    !SENTIMENT_TONES_SET.has(obj.category)
  ) {
    throw new Error(
      `engagement_sentiment_trend_output_invalid: ai-classify returned out-of-set category '${String(obj.category)}'`,
    );
  }
  if (typeof obj.confidence !== 'number' || !Number.isFinite(obj.confidence)) {
    throw new Error(
      'engagement_sentiment_trend_output_invalid: ai-classify returned non-numeric confidence',
    );
  }
  if (typeof obj.reasoning !== 'string') {
    throw new Error(
      'engagement_sentiment_trend_output_invalid: ai-classify returned non-string reasoning',
    );
  }
  // Pull optional key_phrases if the LLM provided them; default empty.
  let key_phrases: ReadonlyArray<string> | undefined;
  if (Array.isArray(obj.key_phrases)) {
    const arr = obj.key_phrases.filter(
      (v): v is string => typeof v === 'string',
    );
    key_phrases = arr;
  }
  return {
    category: obj.category as EngagementSentimentTone,
    confidence: obj.confidence,
    reasoning: obj.reasoning,
    ...(key_phrases !== undefined ? { key_phrases } : {}),
  };
};

/** Snake_case lowercase token regex — same shape as PROMPT_BIAS_HINT_RE
 *  in `@recued/contracts`. Rejects body-shaped strings (which contain
 *  spaces / capitals / punctuation) even when their length falls
 *  under the per-token char cap. */
const SNAKE_CASE_TOKEN_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/** Compose the persisted enrichment value from the validated AI
 *  result. Producer-side guards enforce `key_phrases` shape (snake_case
 *  lowercase tokens) + length + count caps so body content can't leak
 *  through even when the LLM tries; registry-side validator
 *  double-checks at upsert. Score derives from category (closed
 *  bucket → fixed continuous value), optionally adjusted by AI
 *  confidence. */
export const buildSentimentValue = (
  ai_result: SentimentClassifyOutput,
  samples: number,
  cursor_at: number,
): EngagementSentimentTrendValue => {
  // Filter + cap key phrases. Strips entries that:
  //   - are empty / whitespace-only
  //   - exceed the per-token char cap
  //   - fail the snake_case regex (defense against body-shaped strings)
  const phrases: string[] = [];
  if (ai_result.key_phrases !== undefined) {
    for (const phrase of ai_result.key_phrases) {
      const cleaned = phrase.trim();
      if (cleaned.length === 0) continue;
      if (cleaned.length > ENGAGEMENT_SENTIMENT_MAX_KEY_PHRASE_CHARS) continue;
      if (!SNAKE_CASE_TOKEN_RE.test(cleaned)) continue;
      phrases.push(cleaned);
      if (phrases.length >= ENGAGEMENT_SENTIMENT_MAX_KEY_PHRASES) break;
    }
  }
  // Map category → score. Closed bucket → fixed continuous mid-point;
  // confidence pulls toward zero when low. Below-floor sample → score 0.
  let score: number;
  if (samples < ENGAGEMENT_SENTIMENT_MIN_SAMPLE) {
    score = 0;
  } else {
    let baseline: number;
    switch (ai_result.category) {
      case 'warming':
        baseline = 0.6;
        break;
      case 'steady':
        baseline = 0;
        break;
      case 'cooling':
        baseline = -0.6;
        break;
      case 'volatile':
        baseline = 0;
        break;
      case 'insufficient_signal':
      default:
        baseline = 0;
        break;
    }
    const confidence = Math.max(0, Math.min(1, ai_result.confidence));
    score = baseline * confidence;
  }
  // Final tone — substrate clamps to `'insufficient_signal'` when
  // sample density falls below the floor regardless of LLM output.
  const tone: EngagementSentimentTone =
    samples < ENGAGEMENT_SENTIMENT_MIN_SAMPLE
      ? 'insufficient_signal'
      : ai_result.category;
  return {
    tone,
    score,
    key_phrases: phrases,
    samples,
    cursor_at,
  };
};

/** Resolve effective `ForceLayer` for the AI call. Mirrors the
 *  HubSpot/Salesforce lifecycle-stage pattern — per-topic trust +
 *  pool policy gate. */
export const resolveSentimentTrendLayer = (
  ctx: HousekeepingContext,
  trustStore: TrustStore | undefined,
): ForceLayer => {
  if (!trustStore) return 'any';
  const trust = trustStore.read(ENGAGEMENT_SENTIMENT_TOPIC, true);
  const byokAllowed = isByokAllowedForBackground(ctx.db);
  if (!byokAllowed) return 'free';
  if (trust.pool_policy === 'free_only') return 'free';
  if (trust.pool_policy === 'byok_only') return 'byok';
  return 'any';
};

// ────────────────────────────────────────────────────────────────
// Producer version hash
// ────────────────────────────────────────────────────────────────

const PRODUCER_CODE_HASH = 'engagement_sentiment_trend:1';
const PROMPT_TEMPLATE_HASH = 'engagement_sentiment_classify_v1';
const ADAPTER_VERSION = '@recued/llm@1.0.0';

const baseProducerVersionHash = computeProducerVersionHash({
  producer_code_hash: PRODUCER_CODE_HASH,
  model_id: '',
  prompt_template_hash: PROMPT_TEMPLATE_HASH,
  adapter_version: ADAPTER_VERSION,
  consumed_ingredients_versions: [{ slug: 'ai-classify', version: '1' }],
});

export const ENGAGEMENT_SENTIMENT_PRODUCER_VERSION_HASH =
  baseProducerVersionHash;

// ────────────────────────────────────────────────────────────────
// Producer entry point
// ────────────────────────────────────────────────────────────────

export interface EngagementSentimentProducerInput {
  /** Engagement rows scoped to the deal — caller pre-edges-walks. */
  rows: ReadonlyArray<EngagementRow>;
  /** Deal scope — `connection.api.hubspot.deal` /
   *  `connection.api.salesforce.opportunity`. */
  scope: EnrichmentScope;
  /** Deal's platform-reference target_id (e.g. `hubspot_deal_47291`). */
  target_id: string;
  /** Coverage metadata composed by the caller per § A.9.3. */
  coverage: CoverageMetadata;
  /** Stable hash of the deal's anchor row (deal meta or canonical
   *  row id). Flows through to `source_record_hash` on the
   *  enrichment row. */
  source_record_hash: string;
  /** Effective `as_of` for the input fingerprint composition. */
  as_of: number;
  /** Wall-clock now() in unix-ms. Distinct from `as_of` so tests can
   *  pin clock independently of fingerprint anchoring. */
  now: number;
  /** Pre-resolved `ForceLayer`. */
  forceLayer: ForceLayer;
  /** Optional pre-computed event_at for the producer's bistemporal
   *  stamp — defaults to the freshest qualifying row's `event_at`. */
  event_at?: number | null;
}

/** Pure producer entry point. Pre-filters rows per acceptance fields
 *  + the registry-declared aggregate window, composes prompt, calls
 *  `runAIProducer` (which handles dedup probe + trust gate + LLM
 *  call + upsert + bistemporal stamping), and persists the scalar
 *  value.
 *
 *  Codex P2 fold-back (zero-row tombstone): when no rows qualify
 *  (filter rejects everything OR the deal genuinely has no recent
 *  engagement), the producer writes a zero-sample
 *  `'insufficient_signal'` row so a previously-non-empty deal that
 *  later goes silent doesn't leave a stale fresh-chain head visible.
 *  The fingerprint for the zero-row case is anchored to the deal
 *  target_id (per_record_source_hash) so steady-state empty cycles
 *  hit dedup and don't churn writes.
 *
 *  Returns the runAIProducer outcome shape so callers can roll up
 *  `produced` / `skipped_dedup` / `skipped_trust` counters. */
export const processOneSentimentTrend = async (
  ctx: HousekeepingContext,
  input: EngagementSentimentProducerInput,
): Promise<{
  produced: boolean;
  reason?: 'no_llm' | 'dedup_hit' | 'skipped_trust' | 'no_qualifying_rows';
}> => {
  if (!ctx.llmWithMeta) return { produced: false, reason: 'no_llm' };

  const window_cutoff_at = input.as_of - ENGAGEMENT_SENTIMENT_WINDOW_MS;
  const filtered = filterRowsForSentiment(input.rows, window_cutoff_at);

  if (filtered.length === 0) {
    // Zero-sample tombstone path — write an `'insufficient_signal'`
    // row so the previously-fresh chain head doesn't stay visible
    // when evidence disappears. Codex P2 fold-back. Fingerprint
    // anchors on the deal's source_record_hash (per_record degenerate)
    // so the fingerprint stays stable across cycles when the deal
    // has zero qualifying engagements — steady-state dedup hits.
    return await writeSentimentTombstone(ctx, input);
  }

  // Cursor: max vendor_modified_at across the qualifying set.
  let cursor_at = 0;
  let freshest_event_at = 0;
  const source_record_hashes: string[] = [];
  for (const row of filtered) {
    if (row.vendor_modified_at > cursor_at) cursor_at = row.vendor_modified_at;
    if ((row.event_at as number) > freshest_event_at) {
      freshest_event_at = row.event_at as number;
    }
    // Codex P2 fold-back — fingerprint includes substrate-derived
    // evidence fields (authorship + direction + lifecycle + body
    // state + body content) alongside the modstamp so the dedup probe
    // correctly invalidates when local substrate logic reclassifies
    // a row WITHOUT a vendor_modstamp change.
    source_record_hashes.push(composeSentimentSourceHash(row));
  }

  const llmInput = {
    'llm.data': buildSentimentPrompt(input.target_id, filtered),
    'llm.categories': ['warming', 'steady', 'cooling', 'volatile', 'insufficient_signal'],
    'llm.context': SENTIMENT_CLASSIFY_CONTEXT,
    'llm.model_hint': 'fast',
    'llm.force_layer': input.forceLayer,
  };

  const outcome = await runAIProducer({
    ctx,
    topic: ENGAGEMENT_SENTIMENT_TOPIC,
    scope: input.scope,
    target_id: input.target_id,
    authored_by: ENGAGEMENT_SENTIMENT_AUTHORED_BY,
    source_record_hash: input.source_record_hash,
    inputFingerprint: {
      kind: 'aggregate_window_fold',
      source_record_hashes,
      window_ms: ENGAGEMENT_SENTIMENT_WINDOW_MS,
      as_of: input.as_of,
      effective_topic_config: '',
    },
    producer_version_hash: baseProducerVersionHash,
    ingredient_slug: 'ai-classify',
    eventClock: {
      event_at:
        input.event_at !== undefined
          ? input.event_at
          : freshest_event_at > 0
            ? freshest_event_at
            : null,
    },
    manifest: aiClassifyManifest,
    llmInput,
    // D-167 — no `sourceRecordData`: this is a fan-in producer whose egressing
    // PII (engagement body previews) lives across the many `filtered` evidence
    // rows under the engagement-entity scope, not in one structured record at
    // `input.scope` (the deal). The multi-record seed pass now exists
    // (`wrapHousekeepingCtxForFanIn` in `enrichment-pii-egress.ts`): when this
    // producer registers, alias it by pre-wrapping `ctx` over the `filtered`
    // evidence rows against their engagement-entity scope and passing that
    // wrapped ctx in — still no `sourceRecordData` (the single-record seam
    // would only no-op on the deal record). topic_cluster wires this pattern
    // today; this producer is inert until registered, so the wiring is deferred.
    validate: validateSentimentClassifyOutput,
    buildValue: (ai_result) =>
      buildSentimentValue(ai_result, filtered.length, cursor_at),
    token_estimate: ENGAGEMENT_SENTIMENT_TOKEN_ESTIMATE,
  });

  if (outcome.status === 'computed') return { produced: true };
  if (outcome.status === 'dedup_hit') {
    return { produced: false, reason: 'dedup_hit' };
  }
  return { produced: false, reason: 'skipped_trust' };
};

/** Zero-sample tombstone writer — Codex P2 fold-back. Persists an
 *  `'insufficient_signal'` row when the deal has no qualifying
 *  engagements so a previously-populated fresh-chain head doesn't
 *  stay visible. Bypasses the LLM (no token cost) but still
 *  participates in the dedup probe via `per_record_source_hash`
 *  fingerprint anchored on the deal's source_record_hash. Steady-
 *  state empty cycles hit dedup and don't write. */
const writeSentimentTombstone = async (
  ctx: HousekeepingContext,
  input: EngagementSentimentProducerInput,
): Promise<{ produced: boolean; reason?: 'dedup_hit' }> => {
  // Probe dedup directly — same shape as runAIProducer's probe but
  // tailored to the per-record degenerate fingerprint.
  const fingerprintHash = `fnv1a:${fnv1aHex(`zero_sample\x1f${input.source_record_hash}`)}`;
  const existing = ctx.enrichmentStore.list({
    topic: ENGAGEMENT_SENTIMENT_TOPIC,
    scope: input.scope,
    target_id: input.target_id,
    authored_by: ENGAGEMENT_SENTIMENT_AUTHORED_BY,
    fresh_only: true,
    limit: 1,
  });
  const hit = existing.find(
    (r) =>
      r.input_fingerprint_hash === fingerprintHash &&
      r.producer_version_hash === baseProducerVersionHash,
  );
  if (hit) return { produced: false, reason: 'dedup_hit' };

  const value: EngagementSentimentTrendValue = {
    tone: 'insufficient_signal',
    score: 0,
    key_phrases: [],
    samples: 0,
    cursor_at: 0,
  };
  const now = ctx.now();
  // Honest "no event_at" for the zero-row tombstone — there's no
  // freshest qualifying engagement to anchor on. Caller-supplied
  // event_at hint passes through when explicit (number); null /
  // undefined fall through to the upsert-side default.
  const tombstoneEventAt =
    typeof input.event_at === 'number' ? input.event_at : undefined;
  ctx.enrichmentStore.upsert({
    topic: ENGAGEMENT_SENTIMENT_TOPIC,
    scope: input.scope,
    target_id: input.target_id,
    value,
    authored_by: ENGAGEMENT_SENTIMENT_AUTHORED_BY,
    source_record_hash: input.source_record_hash,
    ingredient_slug: 'ai-classify',
    model_id: '',
    ...(tombstoneEventAt !== undefined ? { event_at: tombstoneEventAt } : {}),
    as_of: now,
    producer_version_hash: baseProducerVersionHash,
    input_fingerprint_hash: fingerprintHash,
  });
  return { produced: true };
};

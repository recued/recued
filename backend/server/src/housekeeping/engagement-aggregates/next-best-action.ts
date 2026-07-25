/** D-139 P5 — `next_best_action` AI-surface producer.
 *
 *  Recommendation derived from a deal's recent engagement context.
 *  Closed-bucket action enum (`send_email` / `schedule_meeting` /
 *  `wait` / `investigate` / `escalate` / `review_contact` /
 *  `no_action`) + confidence ∈ [0, 1] + ≤ 200-char rationale.
 *
 *  Pass-4 evidence-quality consumption defaults declared on the
 *  `next_best_action` registry entry. Filters tighter than sentiment:
 *
 *    - `body_state_acceptance`: ['mail_link', 'calendar_link',
 *      'inline_body'] — full body context required (no
 *      'truncated_inline'); the LLM otherwise hallucinates
 *      "schedule meeting" on every deal with a one-line preview.
 *    - `authorship_acceptance`: ['user', 'crm_user', 'unknown'] —
 *      automation/system_process rows are tonally meaningless for
 *      action recommendation.
 *    - `lifecycle_state_acceptance`: ['point_in_time', 'completed'] —
 *      pending tasks + scheduled meetings are activity records, not
 *      evidence the rep should act on yet.
 *    - `dedupe_acceptance`: 'exact_only' — probable-twin pairs are
 *      separate touches.
 *
 *  Producer input fingerprint: `aggregate_window_fold` over
 *  qualifying rows + 60d producer read window. Topic is `time_bound`
 *  with `lifecycle_policy: 'historical'`; `valid_until_at` carries
 *  the producer-declared freshness horizon (24h post-compute by
 *  default — recompute_cadence) so consumer recipes can gate on
 *  freshness explicitly.
 *
 *  Output value-shape invariants (Pass-3 R3.6):
 *    - NO raw body text in `value`. `rationale` is a short
 *      one-sentence explanation (≤ 200 chars); registry validator
 *      caps the length so the LLM can't smuggle body excerpts.
 *    - Coverage caller-supplied per § A.9.3.
 *
 *  Production cycle wiring deferred — same as the sentiment producer
 *  + the P3/P4 deterministic siblings; integration lands when the
 *  engagement-aggregate reactive harness ships.
 *
 *  Spec: D-139 § A.9.2 + § A.9.5 + § P5 acceptance. */

import {
  ENRICHMENT_REGISTRY,
  NEXT_BEST_ACTIONS,
  NEXT_BEST_ACTION_MAX_RATIONALE_CHARS,
  computeProducerVersionHash,
  type Authorship,
  type BodyState,
  type CoverageMetadata,
  type EngagementLifecycleState,
  type EngagementRow,
  type EnrichmentScope,
  type EnrichmentTopic,
  type IngredientManifest,
  type NextBestAction,
  type NextBestActionValue,
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

export const NEXT_BEST_ACTION_TOPIC: EnrichmentTopic = 'next_best_action';
export const NEXT_BEST_ACTION_AUTHORED_BY =
  'system.housekeeping.next_best_action';

/** Producer's read window in milliseconds. Mirrors registry's
 *  `aggregate_window_ms` so the input fingerprint folds the same
 *  window the producer reads. */
export const NEXT_BEST_ACTION_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

/** Per-row body preview cap. Same shape as sentiment but at a wider
 *  cap because action recommendation needs more body context. */
export const NEXT_BEST_ACTION_BODY_PREVIEW_CHARS = 400;

/** Hard cap on rows folded per call. */
export const NEXT_BEST_ACTION_MAX_ROWS = 30;

/** Min sample density floor. Below this → `'no_action'`. */
export const NEXT_BEST_ACTION_MIN_SAMPLE = 2;

/** Producer-declared freshness horizon — 24h post-compute. Mirrors
 *  the registry's `recompute_cadence: '24h'`. */
export const NEXT_BEST_ACTION_VALIDITY_MS = 24 * 60 * 60 * 1000;

/** Per-call token estimate. ~700 input + ~150 output (longer
 *  rationale than sentiment). */
export const NEXT_BEST_ACTION_TOKEN_ESTIMATE = 850;

// ────────────────────────────────────────────────────────────────
// AI manifest + prompt scaffolding
// ────────────────────────────────────────────────────────────────

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

const NBA_CLASSIFY_CONTEXT =
  "Read the recent engagement evidence and pick the rep's best next action. " +
  'send_email: the rep should send an outbound mail (e.g. follow-up after stalled thread, response to a question). ' +
  'schedule_meeting: the deal warrants a meeting (mutual interest signaled, evaluation needs deeper conversation). ' +
  'wait: the prospect is mid-evaluation or has set an explicit deadline; rep should not push. ' +
  'investigate: signals are mixed and the rep needs more information before acting (silence after high engagement, conflicting messages from different contacts). ' +
  'escalate: the deal is at risk and needs leadership attention (commitments missed, multiple cancellations, churn signals). ' +
  'review_contact: the contact data looks stale or the wrong person — verify the relationship before any further action. ' +
  'no_action: insufficient signal to recommend any action OR the deal is already on a clear path that needs no rep intervention. ' +
  'When uncertain, prefer wait over investigate, and investigate over escalate — conservative by design. ' +
  'Provide rationale as ONE short sentence (≤ 200 chars).';

// ────────────────────────────────────────────────────────────────
// Pure helpers (testable without LLM)
// ────────────────────────────────────────────────────────────────

const ACCEPTABLE_BODY_STATES: ReadonlySet<BodyState> = new Set(
  ENRICHMENT_REGISTRY.next_best_action.body_state_acceptance ?? [],
);
const ACCEPTABLE_AUTHORSHIPS: ReadonlySet<Authorship> = new Set(
  ENRICHMENT_REGISTRY.next_best_action.authorship_acceptance ?? [],
);
const ACCEPTABLE_LIFECYCLE_STATES: ReadonlySet<EngagementLifecycleState> =
  new Set(ENRICHMENT_REGISTRY.next_best_action.lifecycle_state_acceptance ?? []);

/** Filter rows per the registry-declared acceptance fields + the
 *  producer's declared aggregate window. NBA's body-state acceptance
 *  is tighter than sentiment's — rejects `'truncated_inline'` so the
 *  LLM gets full body context. Pure / testable.
 *
 *  Codex P2 fold-back (window enforcement): when `window_cutoff_at` is
 *  supplied, rows with `event_at < window_cutoff_at` are rejected so
 *  ancient touches can't satisfy the sample floor despite the
 *  registry's `aggregate_window_ms: 60d`. */
export const filterRowsForNextBestAction = (
  rows: ReadonlyArray<EngagementRow>,
  window_cutoff_at?: number,
): EngagementRow[] => {
  const out: EngagementRow[] = [];
  for (const row of rows) {
    if (row.event_at === null) continue;
    if (window_cutoff_at !== undefined && row.event_at < window_cutoff_at) continue;
    if (!ACCEPTABLE_AUTHORSHIPS.has(row.authorship)) continue;
    if (!ACCEPTABLE_LIFECYCLE_STATES.has(row.lifecycle_state)) continue;
    if (!ACCEPTABLE_BODY_STATES.has(row.body_state)) continue;
    out.push(row);
  }
  return out;
};

/** Compose the per-row source-record hash fed into the NBA's
 *  aggregate_window_fold fingerprint. Codex P2 fold-back — includes
 *  substrate-derived evidence fields so the dedup probe correctly
 *  invalidates when body content / authorship / lifecycle / direction
 *  reclassifies WITHOUT a vendor_modstamp change. */
export const composeNextBestActionSourceHash = (row: EngagementRow): string => {
  const modstamp = row.vendor_modstamp ?? String(row.vendor_modified_at);
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

// ────────────────────────────────────────────────────────────────
// Body-content leak detection — Codex P1 fold-back
// ────────────────────────────────────────────────────────────────

/** Min substring length used by `containsBodyExcerpt` to flag a
 *  rationale as carrying source body text. 30 chars catches
 *  multi-word phrases that would clearly originate from the body
 *  while staying under the 200-char rationale cap. */
export const NEXT_BEST_ACTION_BODY_LEAK_MIN_OVERLAP_CHARS = 30;

const normalizeForLeakCheck = (s: string): string =>
  s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Detect whether `rationale` carries a substantial verbatim
 *  excerpt from any of the qualifying rows' body content. The LLM
 *  is instructed to write a meta-description of the recommendation,
 *  NOT to quote the body — but a misbehaving LLM may echo a body
 *  sentence under the registry's 200-char rationale cap. The cap
 *  alone doesn't catch this; the substring overlap check does.
 *
 *  Algorithm: for each qualifying row's body content, slide a
 *  30-char window across the normalised rationale and check whether
 *  that window appears in the normalised body. Any hit → leak.
 *
 *  Pure / testable / O(rationale.length × rows × body.length). */
export const containsBodyExcerpt = (
  rationale: string,
  rows: ReadonlyArray<EngagementRow>,
): boolean => {
  const normalisedRationale = normalizeForLeakCheck(rationale);
  if (normalisedRationale.length < NEXT_BEST_ACTION_BODY_LEAK_MIN_OVERLAP_CHARS) {
    return false;
  }
  for (const row of rows) {
    if (typeof row.body_inline !== 'string') continue;
    const normalisedBody = normalizeForLeakCheck(row.body_inline);
    if (normalisedBody.length < NEXT_BEST_ACTION_BODY_LEAK_MIN_OVERLAP_CHARS) continue;
    const windowSize = NEXT_BEST_ACTION_BODY_LEAK_MIN_OVERLAP_CHARS;
    for (let i = 0; i <= normalisedRationale.length - windowSize; i++) {
      const window = normalisedRationale.slice(i, i + windowSize);
      if (normalisedBody.includes(window)) return true;
    }
  }
  return false;
};

/** Generic safe rationale used when the LLM-produced rationale
 *  failed the body-excerpt leak check. Producer-side fallback —
 *  recipe + UI consumers see the bucket + confidence + this generic
 *  string + sample count. */
export const NEXT_BEST_ACTION_BODY_LEAK_FALLBACK_RATIONALE =
  'Recommendation derived from recent engagement evidence; rationale withheld to avoid surfacing source body content.';

/** Truncate a body preview at the per-row cap. Same shape as the
 *  sentiment producer's helper but at a wider cap. */
export const truncateNextBestActionBodyPreview = (row: EngagementRow): string => {
  const body = row.body_inline;
  if (typeof body !== 'string') return '';
  const trimmed = body.trim();
  if (trimmed.length === 0) return '';
  if (trimmed.length <= NEXT_BEST_ACTION_BODY_PREVIEW_CHARS) return trimmed;
  return `${trimmed.slice(0, NEXT_BEST_ACTION_BODY_PREVIEW_CHARS - 1)}…`;
};

/** Compose the NBA prompt body. Same shape as the sentiment prompt
 *  but with a different framing in the header. */
export const buildNextBestActionPrompt = (
  deal_target_id: string,
  rows: ReadonlyArray<EngagementRow>,
): string => {
  const lines: string[] = [];
  lines.push(`Deal: ${deal_target_id}`);
  lines.push(`Engagement window: ${rows.length} touches (oldest first)`);
  lines.push('');
  const sorted = [...rows].sort(
    (a, b) => (a.event_at as number) - (b.event_at as number),
  );
  const head = sorted.slice(
    Math.max(0, sorted.length - NEXT_BEST_ACTION_MAX_ROWS),
  );
  if (head.length < sorted.length) {
    lines.push(
      `[${sorted.length - head.length} earlier touches omitted — only the most recent ${NEXT_BEST_ACTION_MAX_ROWS} folded]`,
    );
  }
  for (const row of head) {
    const at = new Date(row.event_at as number).toISOString();
    const preview = truncateNextBestActionBodyPreview(row);
    lines.push(
      `- [${at}] ${row.vendor}/${row.entity} authorship=${row.authorship} direction=${row.direction}` +
        (preview.length > 0 ? `: ${preview}` : ''),
    );
  }
  return lines.join('\n');
};

/** Validated AI output. */
export interface NextBestActionClassifyOutput {
  category: NextBestAction;
  confidence: number;
  reasoning: string;
}

const NEXT_BEST_ACTION_SET: ReadonlySet<string> = new Set(NEXT_BEST_ACTIONS);

export const validateNextBestActionClassifyOutput = (
  raw: unknown,
): NextBestActionClassifyOutput => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      'next_best_action_output_invalid: ai-classify returned non-object',
    );
  }
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.category !== 'string' ||
    !NEXT_BEST_ACTION_SET.has(obj.category)
  ) {
    throw new Error(
      `next_best_action_output_invalid: ai-classify returned out-of-set category '${String(obj.category)}'`,
    );
  }
  if (typeof obj.confidence !== 'number' || !Number.isFinite(obj.confidence)) {
    throw new Error(
      'next_best_action_output_invalid: ai-classify returned non-numeric confidence',
    );
  }
  if (typeof obj.reasoning !== 'string') {
    throw new Error(
      'next_best_action_output_invalid: ai-classify returned non-string reasoning',
    );
  }
  return {
    category: obj.category as NextBestAction,
    confidence: obj.confidence,
    reasoning: obj.reasoning,
  };
};

/** Compose the persisted enrichment value. Producer caps `rationale`
 *  at the registry-declared char limit so body-shaped strings can't
 *  leak through; substrate clamps to `'no_action'` when sample
 *  density falls below the floor.
 *
 *  Codex P1 fold-back — LEAK DETECTION. The 200-char rationale cap
 *  catches LONG body excerpts but a body sentence under 200 chars
 *  could still smuggle source content through this slot. `rows` is
 *  threaded through so `containsBodyExcerpt` can detect verbatim
 *  echoes via 30-char window overlap; on detection, the rationale
 *  is replaced with a safe generic message
 *  (`NEXT_BEST_ACTION_BODY_LEAK_FALLBACK_RATIONALE`). The `action`
 *  + `confidence` survive — they're closed-set / scalar and don't
 *  carry body content. */
export const buildNextBestActionValue = (
  ai_result: NextBestActionClassifyOutput,
  samples: number,
  cursor_at: number,
  now: number,
  rows: ReadonlyArray<EngagementRow>,
): NextBestActionValue => {
  // Substrate floor — below the sample density threshold the LLM
  // cannot have meaningful evidence; force 'no_action' regardless of
  // what it returned. Confidence collapses to 0 too.
  if (samples < NEXT_BEST_ACTION_MIN_SAMPLE) {
    return {
      action: 'no_action',
      confidence: 0,
      rationale:
        samples === 0
          ? 'No qualifying engagements in the window.'
          : 'Insufficient engagement evidence for a recommendation.',
      samples,
      valid_until_at: now + NEXT_BEST_ACTION_VALIDITY_MS,
      computed_at: now,
      cursor_at,
    };
  }
  // Trim the rationale to the registry's char cap. Even if the LLM
  // honored the prompt, producer enforces here so we never persist
  // body-shaped strings.
  let rationale = ai_result.reasoning.trim();
  if (rationale.length > NEXT_BEST_ACTION_MAX_RATIONALE_CHARS) {
    rationale = `${rationale.slice(0, NEXT_BEST_ACTION_MAX_RATIONALE_CHARS - 1)}…`;
  }
  // Codex P1 fold-back — body-leak guard. If the rationale carries a
  // 30-char verbatim window from any qualifying row's body, replace
  // with the safe generic message. Defense in depth on top of the
  // 200-char cap.
  if (containsBodyExcerpt(rationale, rows)) {
    rationale = NEXT_BEST_ACTION_BODY_LEAK_FALLBACK_RATIONALE;
  }
  const confidence = Math.max(0, Math.min(1, ai_result.confidence));
  return {
    action: ai_result.category,
    confidence,
    rationale,
    samples,
    valid_until_at: now + NEXT_BEST_ACTION_VALIDITY_MS,
    computed_at: now,
    cursor_at,
  };
};

/** Resolve effective `ForceLayer` per the per-topic trust + pool
 *  policy. Mirrors the sentiment + lifecycle-stage pattern. */
export const resolveNextBestActionLayer = (
  ctx: HousekeepingContext,
  trustStore: TrustStore | undefined,
): ForceLayer => {
  if (!trustStore) return 'any';
  const trust = trustStore.read(NEXT_BEST_ACTION_TOPIC, true);
  const byokAllowed = isByokAllowedForBackground(ctx.db);
  if (!byokAllowed) return 'free';
  if (trust.pool_policy === 'free_only') return 'free';
  if (trust.pool_policy === 'byok_only') return 'byok';
  return 'any';
};

// ────────────────────────────────────────────────────────────────
// Producer version hash
// ────────────────────────────────────────────────────────────────

const PRODUCER_CODE_HASH = 'next_best_action:1';
const PROMPT_TEMPLATE_HASH = 'next_best_action_classify_v1';
const ADAPTER_VERSION = '@recued/llm@1.0.0';

const baseProducerVersionHash = computeProducerVersionHash({
  producer_code_hash: PRODUCER_CODE_HASH,
  model_id: '',
  prompt_template_hash: PROMPT_TEMPLATE_HASH,
  adapter_version: ADAPTER_VERSION,
  consumed_ingredients_versions: [{ slug: 'ai-classify', version: '1' }],
});

export const NEXT_BEST_ACTION_PRODUCER_VERSION_HASH = baseProducerVersionHash;

// ────────────────────────────────────────────────────────────────
// Producer entry point
// ────────────────────────────────────────────────────────────────

export interface NextBestActionProducerInput {
  rows: ReadonlyArray<EngagementRow>;
  scope: EnrichmentScope;
  target_id: string;
  coverage: CoverageMetadata;
  source_record_hash: string;
  as_of: number;
  now: number;
  forceLayer: ForceLayer;
  /** Optional pre-computed event_at — defaults to the freshest
   *  qualifying row's `event_at`. */
  event_at?: number | null;
}

/** Pure producer entry point. Codex P2 fold-backs:
 *  - Window enforcement — pre-filter rejects rows older than
 *    `as_of - WINDOW_MS` so ancient touches can't satisfy the
 *    sample floor.
 *  - Zero-row tombstone — when filtering rejects everything, write
 *    a `'no_action'` row instead of returning early so a previously-
 *    populated deal that goes silent doesn't leave a stale fresh-
 *    chain head visible.
 *  - Fingerprint includes substrate-derived evidence fields so the
 *    dedup probe correctly invalidates on local reclassification. */
export const processOneNextBestAction = async (
  ctx: HousekeepingContext,
  input: NextBestActionProducerInput,
): Promise<{
  produced: boolean;
  reason?: 'no_llm' | 'dedup_hit' | 'skipped_trust' | 'no_qualifying_rows';
}> => {
  if (!ctx.llmWithMeta) return { produced: false, reason: 'no_llm' };

  const window_cutoff_at = input.as_of - NEXT_BEST_ACTION_WINDOW_MS;
  const filtered = filterRowsForNextBestAction(input.rows, window_cutoff_at);

  if (filtered.length === 0) {
    return await writeNextBestActionTombstone(ctx, input);
  }

  let cursor_at = 0;
  let freshest_event_at = 0;
  const source_record_hashes: string[] = [];
  for (const row of filtered) {
    if (row.vendor_modified_at > cursor_at) cursor_at = row.vendor_modified_at;
    if ((row.event_at as number) > freshest_event_at) {
      freshest_event_at = row.event_at as number;
    }
    source_record_hashes.push(composeNextBestActionSourceHash(row));
  }

  const llmInput = {
    'llm.data': buildNextBestActionPrompt(input.target_id, filtered),
    'llm.categories': [...NEXT_BEST_ACTIONS],
    'llm.context': NBA_CLASSIFY_CONTEXT,
    'llm.model_hint': 'fast',
    'llm.force_layer': input.forceLayer,
  };

  const outcome = await runAIProducer({
    ctx,
    topic: NEXT_BEST_ACTION_TOPIC,
    scope: input.scope,
    target_id: input.target_id,
    authored_by: NEXT_BEST_ACTION_AUTHORED_BY,
    source_record_hash: input.source_record_hash,
    inputFingerprint: {
      kind: 'aggregate_window_fold',
      source_record_hashes,
      window_ms: NEXT_BEST_ACTION_WINDOW_MS,
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
    validate: validateNextBestActionClassifyOutput,
    buildValue: (ai_result) =>
      buildNextBestActionValue(
        ai_result,
        filtered.length,
        cursor_at,
        input.now,
        filtered,
      ),
    token_estimate: NEXT_BEST_ACTION_TOKEN_ESTIMATE,
  });

  if (outcome.status === 'computed') return { produced: true };
  if (outcome.status === 'dedup_hit') {
    return { produced: false, reason: 'dedup_hit' };
  }
  return { produced: false, reason: 'skipped_trust' };
};

/** Zero-sample tombstone writer — Codex P2 fold-back. Persists a
 *  `'no_action'` row when the deal has no qualifying engagements so
 *  a previously-populated fresh-chain head doesn't stay visible.
 *  Bypasses the LLM (no token cost) but participates in the dedup
 *  probe via a per-record fingerprint anchored on the deal's
 *  source_record_hash — steady-state empty cycles dedup. */
const writeNextBestActionTombstone = async (
  ctx: HousekeepingContext,
  input: NextBestActionProducerInput,
): Promise<{ produced: boolean; reason?: 'dedup_hit' }> => {
  const fingerprintHash = `fnv1a:${fnv1aHex(`zero_sample\x1f${input.source_record_hash}`)}`;
  const existing = ctx.enrichmentStore.list({
    topic: NEXT_BEST_ACTION_TOPIC,
    scope: input.scope,
    target_id: input.target_id,
    authored_by: NEXT_BEST_ACTION_AUTHORED_BY,
    fresh_only: true,
    limit: 1,
  });
  const hit = existing.find(
    (r) =>
      r.input_fingerprint_hash === fingerprintHash &&
      r.producer_version_hash === baseProducerVersionHash,
  );
  if (hit) return { produced: false, reason: 'dedup_hit' };

  const now = ctx.now();
  const value: NextBestActionValue = {
    action: 'no_action',
    confidence: 0,
    rationale: 'No qualifying engagements in the window.',
    samples: 0,
    valid_until_at: now + NEXT_BEST_ACTION_VALIDITY_MS,
    computed_at: now,
    cursor_at: 0,
  };
  const tombstoneEventAt =
    typeof input.event_at === 'number' ? input.event_at : undefined;
  ctx.enrichmentStore.upsert({
    topic: NEXT_BEST_ACTION_TOPIC,
    scope: input.scope,
    target_id: input.target_id,
    value,
    authored_by: NEXT_BEST_ACTION_AUTHORED_BY,
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

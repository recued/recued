/** D-129 P6 — `lifecycle_stage_inferred` enrichment producer.
 *
 *  AI-classified normalised lifecycle stage per HubSpot contact. The
 *  user's HubSpot `lifecyclestage` field is portal-defined and often
 *  drifts away from observed behaviour ("our HubSpot says lead, but
 *  this person has been in weekly customer-success meetings for 6
 *  months"). The producer infers a normalised stage from a deterministic
 *  prompt assembled from contact `meta` + Recued local
 *  `behavioral_signature` + (when available) `role` enrichments,
 *  surfacing the gap so the user can clean up their CRM.
 *
 *  AI surface: `'chat'` — `ai-classify` against the closed
 *  `LIFECYCLE_STAGES` set. `ForceLayer` resolved from the per-topic
 *  trust + pool_policy store via the same shape `topic_cluster` uses.
 *  `emits_confidence: true` opts the topic into D-133 PSI drift
 *  detection.
 *
 *  Substrate: same DISTINCT-target_id walk as the deterministic P6
 *  siblings — first-row materialisation is upstream substrate concern;
 *  tests seed rows.
 *
 *  Algorithm:
 *
 *    1. `SELECT DISTINCT target_id` for HubSpot contact scope.
 *    2. For each contact, parse `meta.email` (canonical join key) +
 *       `meta.lifecycle_stage` (HubSpot's setting, surfaced in the
 *       prompt as the existing label being fact-checked).
 *    3. Look up `data.enrichment.contact.<email>.behavioral_signature`
 *       to get rolling activity counts (mail / meetings 30d / 90d,
 *       reply latency).
 *    4. Look up `data.enrichment.contact.<email>.role` (when present)
 *       for the contact's role category — useful for the "evangelist
 *       vs. customer" boundary.
 *    5. Build the prompt: short narrative of the signals + ask for
 *       classification into `LIFECYCLE_STAGES`.
 *    6. Call `ctx.llm(aiClassifyManifest, input)` with the resolved
 *       force layer.
 *    7. Validate output (`category` ∈ `LIFECYCLE_STAGES`, `confidence`
 *       in [0, 1], `reasoning` is a string). Throw on shape failure
 *       so the harness's per-task error counter trips correctly.
 *    8. Compose value with up to 5 short signal tokens.
 *    9. Upsert with meta passthrough.
 *
 *  When no `behavioral_signature` exists for the contact's email, the
 *  producer still runs but with thinner signal — recipes filtering on
 *  `confidence` can ignore low-confidence inferences. The
 *  `lifecyclestage` from HubSpot itself is always part of the prompt
 *  so the LLM has at least one anchor.
 *
 *  Token cost: ~250 per record. Same magnitude as `purpose` /
 *  `company` / `role` AI producers.
 *
 *  Spec: `docs/d-129-spec.md` §A.6 + §Phase 6 + load-bearing
 *  decision §3 (cross-source join via canonical email). */

import {
  ENRICHMENT_REGISTRY,
  LIFECYCLE_STAGES,
  computeHousekeepingMetaTags,
  computeProducerVersionHash,
  type EnrichmentMeta,
  type EnrichmentTopic,
  type HousekeepingCursor,
  type HousekeepingStepResult,
  type IngredientManifest,
  type LifecycleStage,
  type LifecycleStageInferredValue,
} from '@recued/contracts';
import type { ForceLayer } from '@recued/llm';

import { runAIProducer } from '../ai-producer-wrapper.js';
import type {
  HousekeepingContext,
  HousekeepingTaskInstance,
} from '../registry.js';
import {
  isByokAllowedForBackground,
  type TrustStore,
} from '../trust-store.js';
import { canonicalOne } from './_email-addresses.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Per-record token estimate. ~200 input (the assembled prompt is
 *  short — signal counts + category list) + ~50 output (single short
 *  category + confidence + one-sentence reasoning). Same magnitude as
 *  `purpose` / `role` to keep D-133 PSI baselines comparable across
 *  AI-classify producers. */
export const LIFECYCLE_STAGE_TOKEN_ESTIMATE = 250;

/** Hard cap on contacts walked per cycle. AI-surface; runs on Run-Now
 *  + (after user promotes trust to `'auto'`) idle cycles. Cap protects
 *  against runaway token spend on large HubSpot portals. */
export const LIFECYCLE_STAGE_MAX_CONTACTS_PER_CYCLE = 1000;

/** Max signal tokens written into the value's `signals` array. */
const MAX_SIGNAL_TOKENS = 5;

export const LIFECYCLE_STAGE_AUTHORED_BY = 'system.housekeeping.lifecycle_stage_inferred';
export const LIFECYCLE_STAGE_TOPIC: EnrichmentTopic = 'lifecycle_stage_inferred';
export const LIFECYCLE_STAGE_SOURCE_SCOPE = 'connection.api.hubspot.contact' as const;

// ────────────────────────────────────────────────────────────────
// AI manifest + prompt
// ────────────────────────────────────────────────────────────────

/** Inline `IngredientManifest` matching `community/ingredients/ai-classify.json`.
 *  Same shape `purpose` / `action_items` use; once a third call site
 *  ships we'll extract a shared kernel-manifest table. */
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

/** Closed-set guard on the classifier output. Stays here rather than
 *  in contracts so the producer can fail loudly on out-of-set output
 *  without depending on the registry's permissive `value_schema`. */
const LIFECYCLE_STAGE_SET: ReadonlySet<string> = new Set(LIFECYCLE_STAGES);

const isLifecycleStage = (v: unknown): v is LifecycleStage =>
  typeof v === 'string' && LIFECYCLE_STAGE_SET.has(v);

/** Selection guidance pinned in `llm.context`. Encodes the boundaries
 *  between adjacent stages so the LLM picks deterministically rather
 *  than landing on the prompt's first / last category by default. */
const LIFECYCLE_CLASSIFY_CONTEXT =
  'Pick the lifecycle stage that best matches the contact\'s OBSERVED behaviour, not the HubSpot label provided. ' +
  'subscriber: passive recipient with no two-way activity. ' +
  'lead: limited inbound but no replies / meetings. ' +
  'mql: replied to mail or attended a meeting at least once. ' +
  'sql: multiple two-way exchanges or recurring meetings. ' +
  'opportunity: high-cadence two-way activity sustained over weeks. ' +
  'customer: recurring business engagement (weekly+ meetings or sustained 30d activity). ' +
  'evangelist: customer with explicit referral / promotion signals (weighted toward role:executive or signal of advocacy). ' +
  'When in doubt between adjacent stages, pick the lower one and lower the confidence.';

// ────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────

export interface LifecycleSignalBundle {
  email: string;
  hubspot_lifecycle_stage: string | null;
  /** From `behavioral_signature` — windowed mail volume (default 30d).
   *  Renamed from `mail_count_30d` at D-136 P3 follow-up. */
  mail_count_window: number | null;
  /** From `behavioral_signature` — windowed meeting count (default 30d).
   *  Renamed from `meeting_count_30d` at D-136 P3 follow-up. */
  meeting_count_window: number | null;
  mean_reply_latency_ms: number | null;
  /** From `role`. */
  role_category: string | null;
}

/** Compose the prompt body the LLM classifies on. Pure / testable. */
export const buildLifecyclePrompt = (signals: LifecycleSignalBundle): string => {
  const lines: string[] = [];
  lines.push(`Contact: ${signals.email}`);
  if (signals.hubspot_lifecycle_stage !== null) {
    lines.push(`HubSpot lifecyclestage (current label, may be stale): ${signals.hubspot_lifecycle_stage}`);
  } else {
    lines.push('HubSpot lifecyclestage: <not set>');
  }
  if (signals.mail_count_window !== null) {
    lines.push(`Mail volume in trailing window: ${signals.mail_count_window}`);
  }
  if (signals.meeting_count_window !== null) {
    lines.push(`Meeting count in trailing window: ${signals.meeting_count_window}`);
  }
  if (signals.mean_reply_latency_ms !== null) {
    const hours = Math.round(signals.mean_reply_latency_ms / 3_600_000);
    lines.push(`Mean reply latency: ${hours}h`);
  }
  if (signals.role_category !== null) {
    lines.push(`Role category (inferred): ${signals.role_category}`);
  }
  return lines.join('\n');
};

/** Build short signal tokens reflecting which inputs drove the
 *  classification. Used in `value.signals` so recipes can gate on
 *  presence without re-running the producer. */
export const buildLifecycleSignalTokens = (
  signals: LifecycleSignalBundle,
): string[] => {
  const out: string[] = [];
  if (signals.hubspot_lifecycle_stage !== null) {
    out.push(`hubspot_label:${signals.hubspot_lifecycle_stage}`);
  }
  if (signals.mail_count_window !== null && signals.mail_count_window > 0) {
    out.push(`mail_window:${signals.mail_count_window}`);
  }
  if (signals.meeting_count_window !== null && signals.meeting_count_window > 0) {
    out.push(`meetings_window:${signals.meeting_count_window}`);
  }
  if (signals.role_category !== null) {
    out.push(`role:${signals.role_category}`);
  }
  if (out.length === 0) out.push('no_observable_signal');
  return out.slice(0, MAX_SIGNAL_TOKENS);
};

/** Resolve effective `ForceLayer` for the AI call. Mirrors
 *  `topic_cluster`'s helper — duplicated until a third standalone AI
 *  task lands and triggers extraction per the codebase's
 *  third-caller convention. */
export const resolveLifecycleStageLayer = (
  ctx: HousekeepingContext,
  trustStore: TrustStore | undefined,
): ForceLayer => {
  if (!trustStore) return 'any';
  const trust = trustStore.read(LIFECYCLE_STAGE_TOPIC, true);
  const byokAllowed = isByokAllowedForBackground(ctx.db);
  if (!byokAllowed) return 'free';
  if (trust.pool_policy === 'free_only') return 'free';
  if (trust.pool_policy === 'byok_only') return 'byok';
  return 'any';
};

// ────────────────────────────────────────────────────────────────
// Storage helpers
// ────────────────────────────────────────────────────────────────

interface ContactWalkRow {
  target_id: string;
  meta_json: string | null;
}

const listContactTargetIds = (ctx: HousekeepingContext): ContactWalkRow[] => {
  const rows = ctx.db
    .prepare(
      `SELECT target_id, MAX(meta) AS meta_json
         FROM data_enrichment
        WHERE scope = ?
          AND target_id IS NOT NULL
          AND meta IS NOT NULL
        GROUP BY target_id
        LIMIT ?`,
    )
    .all(
      LIFECYCLE_STAGE_SOURCE_SCOPE,
      LIFECYCLE_STAGE_MAX_CONTACTS_PER_CYCLE,
    ) as Array<{ target_id: string; meta_json: string | null }>;
  return rows;
};

interface ContactMetaShape {
  snapshot_at: number;
  snapshot_hash: string;
  email?: unknown;
  lifecycle_stage?: unknown;
}

const parseContactMeta = (meta_json: string | null): ContactMetaShape | null => {
  if (meta_json === null) return null;
  try {
    return JSON.parse(meta_json) as ContactMetaShape;
  } catch {
    return null;
  }
};

const readBehavioralSignature = (
  ctx: HousekeepingContext,
  email: string,
): {
  mail_count_window: number | null;
  meeting_count_window: number | null;
  mean_reply_latency_ms: number | null;
} => {
  const rows = ctx.enrichmentStore.list({
    topic: 'behavioral_signature',
    scope: 'contact',
    target_id: email,
    limit: 1,
  });
  if (rows.length === 0) {
    return {
      mail_count_window: null,
      meeting_count_window: null,
      mean_reply_latency_ms: null,
    };
  }
  const v = rows[0]!.value as Record<string, unknown>;
  const num = (k: string): number | null => {
    const x = v[k];
    return typeof x === 'number' && Number.isFinite(x) ? x : null;
  };
  return {
    mail_count_window: num('mail_count_window'),
    meeting_count_window: num('meeting_count_window'),
    mean_reply_latency_ms: num('mean_reply_latency_ms'),
  };
};

const readRoleCategory = (
  ctx: HousekeepingContext,
  email: string,
): string | null => {
  const rows = ctx.enrichmentStore.list({
    topic: 'role',
    scope: 'contact',
    target_id: email,
    limit: 1,
  });
  if (rows.length === 0) return null;
  const v = rows[0]!.value as Record<string, unknown>;
  const cat = v.category;
  return typeof cat === 'string' ? cat : null;
};

// ────────────────────────────────────────────────────────────────
// Cycle
// ────────────────────────────────────────────────────────────────

/** Validated AI output. Producer throws on shape failure to surface
 *  via the per-task error counter. */
interface ClassifyOutput {
  category: LifecycleStage;
  confidence: number;
  reasoning: string;
}

const isClassifyOutput = (v: unknown): v is ClassifyOutput => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  if (!isLifecycleStage(obj.category)) return false;
  if (typeof obj.confidence !== 'number' || !Number.isFinite(obj.confidence)) return false;
  if (typeof obj.reasoning !== 'string') return false;
  return true;
};

/** D-136 P3 — producer-version hash. Composed once at module load
 *  from the producer's code identity + ingredient identity. Bumps
 *  whenever this file changes (`PRODUCER_CODE_HASH` literal moves) or
 *  the prompt template / category list changes (`PROMPT_TEMPLATE_HASH`
 *  literal moves). The actual `model_id` is captured at LLM-call time
 *  via `ctx.llmWithMeta` and threaded through the upsert; per spec
 *  §A.3 + audit §20.2 this is what makes cross-pool PSI invalidation
 *  meaningful (Groq free pool vs Anthropic BYOK produce distinct
 *  `model_id`s and therefore distinct `producer_version_hash` rows).
 *
 *  Why hand-rolled string literals: the contracts package is dep-free
 *  so we don't run a build-time AST hasher over the producer source.
 *  Producer revisions bump these literals manually as part of the PR
 *  diff — same convention HubSpot/Salesforce reconcilers use for
 *  `producer_version`. The model_id slot is empty here because the
 *  per-call resolution happens inside the wrapper; the persisted row's
 *  `model_id` column captures the actual provider+model. */
const PRODUCER_CODE_HASH = 'lifecycle_stage_inferred:1';
const PROMPT_TEMPLATE_HASH = 'lifecycle_classify_v1';
const ADAPTER_VERSION = '@recued/llm@1.0.0';

const baseProducerVersionHash = computeProducerVersionHash({
  producer_code_hash: PRODUCER_CODE_HASH,
  // Empty `model_id` here — the wrapper would in principle re-fold model
  // identity into a per-call hash, but D-136 P3 keeps producer-version
  // orthogonal to model resolution: the row's `model_id` column carries
  // the resolved id, and dedup probes match on both
  // `(input_fingerprint_hash, producer_version_hash)`. Cross-model
  // distinction lives on `model_id` directly.
  model_id: '',
  prompt_template_hash: PROMPT_TEMPLATE_HASH,
  adapter_version: ADAPTER_VERSION,
  consumed_ingredients_versions: [{ slug: 'ai-classify', version: '1' }],
});

/** D-136 P3 — extract `event_at` from the platform record's snapshot
 *  clock (audit §20.2 fix). HubSpot reconciler stamps `meta.snapshot_at`
 *  on every contact row when refreshing the platform-reference scope;
 *  the inferred lifecycle stage is anchored to that snapshot, NOT the
 *  producer's compute time. Falls back to null when the meta is absent
 *  — the wrapper uses `ctx.now()` as a defensible default + the harness
 *  logs the gap. */
const extractContactEventAt = (meta: ContactMetaShape | null): number | null => {
  if (meta === null) return null;
  return typeof meta.snapshot_at === 'number' ? meta.snapshot_at : null;
};

/** One contact's worth of work — exposed for direct test access so
 *  per-record paths can be exercised without setting up the full
 *  cycle. Throws when the AI output shape is malformed.
 *
 *  D-136 P3 — replaces the legacy direct-`ctx.enrichmentStore.upsert`
 *  path with `runAIProducer` so dedup probe + bistemporal stamping
 *  + model_id capture flow correctly. The audit §20.2 corruption
 *  (`event_at: ctx.now()`) is fixed by sourcing `event_at` from
 *  `meta.snapshot_at`; the wrapper threads it through. */
export const processOneContact = async (
  ctx: HousekeepingContext,
  contact: ContactWalkRow,
  forceLayer: ForceLayer,
): Promise<{
  produced: boolean;
  reason?: 'no_meta' | 'no_email' | 'no_llm' | 'dedup_hit' | 'skipped_trust';
}> => {
  const meta = parseContactMeta(contact.meta_json);
  if (meta === null) return { produced: false, reason: 'no_meta' };
  if (typeof meta.email !== 'string' || meta.email.length === 0) {
    return { produced: false, reason: 'no_email' };
  }
  if (!ctx.llmWithMeta) return { produced: false, reason: 'no_llm' };

  const email = canonicalOne(meta.email);
  const hubspot_label = typeof meta.lifecycle_stage === 'string' ? meta.lifecycle_stage : null;
  const sig = readBehavioralSignature(ctx, email);
  const role_category = readRoleCategory(ctx, email);

  const signals: LifecycleSignalBundle = {
    email,
    hubspot_lifecycle_stage: hubspot_label,
    mail_count_window: sig.mail_count_window,
    meeting_count_window: sig.meeting_count_window,
    mean_reply_latency_ms: sig.mean_reply_latency_ms,
    role_category,
  };

  const llmInput = {
    'llm.data': buildLifecyclePrompt(signals),
    'llm.categories': [...LIFECYCLE_STAGES],
    'llm.context': LIFECYCLE_CLASSIFY_CONTEXT,
    'llm.model_hint': 'fast',
    'llm.force_layer': forceLayer,
  };

  // D-136 P3 — `source_record_hash` anchors the dedup probe in the
  // per-record degenerate. `meta.snapshot_hash` already covers
  // contact-record content + lifecycle-stage label changes per the
  // HubSpot reconciler convention; an upstream content shift bumps
  // this hash and forces recompute.
  const source_record_hash = meta.snapshot_hash;

  const outcome = await runAIProducer({
    ctx,
    topic: LIFECYCLE_STAGE_TOPIC,
    scope: LIFECYCLE_STAGE_SOURCE_SCOPE,
    target_id: contact.target_id,
    authored_by: LIFECYCLE_STAGE_AUTHORED_BY,
    source_record_hash,
    inputFingerprint: {
      kind: 'per_record_source_hash',
      source_record_hash,
    },
    producer_version_hash: baseProducerVersionHash,
    ingredient_slug: 'ai-classify',
    eventClock: { event_at: extractContactEventAt(meta) },
    manifest: aiClassifyManifest,
    llmInput,
    // D-167 — seed the alias ledger from the signal bundle. `signals.email`
    // is the canonicalised address that `buildLifecyclePrompt` flattens into
    // `llm.data` (`Contact: <email>`), so seeding the egressed value lets the
    // wrapper alias it before the contact email leaves for a free-pool / cloud
    // model. Scope `connection.api.hubspot.contact` resolves the contact
    // privacy schema's `email` tag.
    sourceRecordData: signals,
    validate: (raw): ClassifyOutput => {
      if (!isClassifyOutput(raw)) {
        throw new Error(
          `lifecycle_stage_inferred_output_invalid: ai-classify returned non-conformant shape or out-of-set stage for contact '${contact.target_id}'`,
        );
      }
      return raw;
    },
    buildValue: (result): LifecycleStageInferredValue => ({
      stage: result.category,
      reasoning: result.reasoning,
      signals: buildLifecycleSignalTokens(signals),
      computed_at: ctx.now(),
    }),
    meta: meta as EnrichmentMeta,
    token_estimate: LIFECYCLE_STAGE_TOKEN_ESTIMATE,
  });

  if (outcome.status === 'computed') return { produced: true };
  if (outcome.status === 'dedup_hit') return { produced: false, reason: 'dedup_hit' };
  return { produced: false, reason: 'skipped_trust' };
};

export const runLifecycleStageInferredCycle = async (
  ctx: HousekeepingContext,
): Promise<{ produced: number; skipped: number }> => {
  const forceLayer = resolveLifecycleStageLayer(ctx, ctx.trustStore);
  const contacts = listContactTargetIds(ctx);
  let produced = 0;
  let skipped = 0;
  for (const contact of contacts) {
    const out = await processOneContact(ctx, contact, forceLayer);
    if (out.produced) produced += 1;
    else skipped += 1;
  }
  return { produced, skipped };
};

// ────────────────────────────────────────────────────────────────
// Task instance
// ────────────────────────────────────────────────────────────────

export const lifecycleStageInferredTask: HousekeepingTaskInstance = {
  meta: {
    id: 'enrichment.lifecycle_stage_inferred',
    description:
      'AI-classified normalised lifecycle stage per HubSpot contact — surfaces the gap when HubSpot lifecyclestage drifts from observed engagement.',
    interruptible: true,
    kind: 'enrichment',
    tags: computeHousekeepingMetaTags({
      def: ENRICHMENT_REGISTRY.lifecycle_stage_inferred,
      isAiSurface: true,
    }),
  },
  topic: LIFECYCLE_STAGE_TOPIC,
  is_ai_surface: true,

  async step(
    ctx: HousekeepingContext,
    _cursor: HousekeepingCursor,
    _budget_ms: number,
  ): Promise<HousekeepingStepResult> {
    await runLifecycleStageInferredCycle(ctx);
    return { status: 'complete', cursor: { kind: 'complete' } };
  },
};

export const lifecycleStageInferredTokenEstimate = (): number =>
  LIFECYCLE_STAGE_TOKEN_ESTIMATE;

export const lifecycleStageInferredScopeReadDeclaration = [
  {
    collection: 'data.enrichment.connection.api.hubspot.contact',
    sample_field_paths: ['meta.email', 'meta.lifecycle_stage'],
  },
  {
    collection: 'data.enrichment.contact',
    sample_field_paths: [
      'behavioral_signature.mail_count_window',
      'behavioral_signature.meeting_count_window',
      'behavioral_signature.mean_reply_latency_ms',
      'role.category',
    ],
  },
] as const;

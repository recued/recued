/** D-130 P6 — `lifecycle_stage_inferred_salesforce` enrichment producer.
 *
 *  AI-classified normalised lifecycle stage per Salesforce contact.
 *  Parallel topic to D-129's HubSpot-flavored `lifecycle_stage_inferred`
 *  per spec § decision 11 — Salesforce's lifecycle vocabulary
 *  (`Lead` / `Prospect` / `Customer` / `Prior Customer` / `Partner` /
 *  `Other`) doesn't map cleanly onto HubSpot's 7-stage model
 *  (`subscriber` / `lead` / `mql` / `sql` / `opportunity` / `customer` /
 *  `evangelist`), so closing the enum is vendor-specific. The
 *  topic-level shape is otherwise identical: producer infers a
 *  normalised stage from a deterministic prompt assembled from contact
 *  `meta` + Recued local `behavioral_signature` + (when available)
 *  `role` enrichments. Surfaces drift between Salesforce's
 *  user-defined lifecycle setting and observed engagement.
 *
 *  AI surface: `'chat'` — `ai-classify` against the closed
 *  `SALESFORCE_LIFECYCLE_STAGES` set. `ForceLayer` resolved from the
 *  per-topic trust + pool_policy store via the same shape
 *  `lifecycle_stage_inferred` uses. `emits_confidence: true` opts the
 *  topic into D-133 PSI drift detection.
 *
 *  Source scope: `connection.api.salesforce.contact` exclusively. The
 *  parallel `lifecycle_stage_inferred` topic walks
 *  `connection.api.hubspot.contact`. Both producers can run on the
 *  same Recued instance when the user has both vendors enrolled.
 *
 *  Salesforce-specific prompt context: Salesforce's lifecycle is
 *  user-defined per org but the canonical pre-config follows
 *  `Lead → Prospect → Customer → Prior Customer` with `Partner`
 *  orthogonal. The classifier context narrative encodes this so the
 *  LLM picks deterministically. The HubSpot producer's stage
 *  guidance is preserved verbatim where the boundaries are similar
 *  ("subscriber" maps roughly onto "Lead with no two-way activity";
 *  "evangelist" doesn't have a clean Salesforce analogue and falls
 *  to "Other" with low confidence).
 *
 *  Substrate: same DISTINCT-target_id walk as the deterministic
 *  cross-vendor siblings — first-row materialisation is upstream
 *  substrate concern; tests seed rows.
 *
 *  Token cost: ~250 per record. Same magnitude as the HubSpot
 *  variant + `purpose` / `company` / `role` AI producers.
 *
 *  Spec: D-130 §A.6 + §Phase 6 + decision 11
 *  (parallel topic per vendor). */

import {
  ENRICHMENT_REGISTRY,
  SALESFORCE_LIFECYCLE_STAGES,
  computeHousekeepingMetaTags,
  computeProducerVersionHash,
  type EnrichmentMeta,
  type EnrichmentTopic,
  type HousekeepingCursor,
  type HousekeepingStepResult,
  type IngredientManifest,
  type LifecycleStageInferredSalesforceValue,
  type SalesforceLifecycleStage,
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

/** Per-record token estimate. ~200 input + ~50 output. Aligns with
 *  the HubSpot variant for D-133 PSI baseline comparability across
 *  AI-classify producers. */
export const LIFECYCLE_STAGE_SALESFORCE_TOKEN_ESTIMATE = 250;

/** Hard cap on contacts walked per cycle. AI-surface; runs on Run-Now
 *  + (after user promotes trust to `'auto'`) idle cycles. Cap protects
 *  against runaway token spend on large Salesforce orgs. */
export const LIFECYCLE_STAGE_SALESFORCE_MAX_CONTACTS_PER_CYCLE = 1000;

/** Max signal tokens written into the value's `signals` array. */
const MAX_SIGNAL_TOKENS = 5;

export const LIFECYCLE_STAGE_SALESFORCE_AUTHORED_BY =
  'system.housekeeping.lifecycle_stage_inferred_salesforce';
export const LIFECYCLE_STAGE_SALESFORCE_TOPIC: EnrichmentTopic =
  'lifecycle_stage_inferred_salesforce';
export const LIFECYCLE_STAGE_SALESFORCE_SOURCE_SCOPE =
  'connection.api.salesforce.contact' as const;

// ────────────────────────────────────────────────────────────────
// AI manifest + prompt
// ────────────────────────────────────────────────────────────────

/** Inline `IngredientManifest` matching `community/ingredients/ai-classify.json`.
 *  Same shape the HubSpot producer uses; once a third call site ships
 *  we'll extract a shared kernel-manifest table. */
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
const SALESFORCE_LIFECYCLE_STAGE_SET: ReadonlySet<string> =
  new Set(SALESFORCE_LIFECYCLE_STAGES);

const isSalesforceLifecycleStage = (v: unknown): v is SalesforceLifecycleStage =>
  typeof v === 'string' && SALESFORCE_LIFECYCLE_STAGE_SET.has(v);

/** Selection guidance pinned in `llm.context`. Encodes Salesforce-
 *  specific stage boundaries so the LLM picks deterministically.
 *  Salesforce's vocabulary is user-defined per org but follows the
 *  pre-config `Lead → Prospect → Customer → Prior Customer` ladder
 *  with `Partner` orthogonal. */
const LIFECYCLE_CLASSIFY_CONTEXT =
  "Pick the lifecycle stage that best matches the contact's OBSERVED behaviour, not the Salesforce label provided. " +
  'lead: limited inbound but no replies / meetings — analogous to subscriber-or-lead in other CRMs. ' +
  'prospect: replied to mail or attended meetings — interest qualified, not yet bought. ' +
  'customer: recurring business engagement (weekly+ meetings or sustained 30d activity). ' +
  'prior_customer: previously a customer, no recent activity (≥ 90d quiet) and Salesforce stage indicates churned / inactive. ' +
  'partner: alliance / channel / referral relationship — non-buying engagement at sustained cadence (use sparingly; defaults to Other when ambiguous). ' +
  'other: catch-all when none of the above fits — typically internal contacts, vendors, or roles outside the buying journey. ' +
  'When in doubt between adjacent stages, pick the lower one and lower the confidence. ' +
  // D-278 zero-anchor, tied to the catch-all this vocabulary already has.
  'Use a confidence of 0 when you fall back to other because none of the stages fits.';

// ────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────

export interface SalesforceLifecycleSignalBundle {
  email: string;
  salesforce_lifecycle_stage: string | null;
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
export const buildSalesforceLifecyclePrompt = (
  signals: SalesforceLifecycleSignalBundle,
): string => {
  const lines: string[] = [];
  lines.push(`Contact: ${signals.email}`);
  if (signals.salesforce_lifecycle_stage !== null) {
    lines.push(`Salesforce lifecycle (current label, may be stale): ${signals.salesforce_lifecycle_stage}`);
  } else {
    lines.push('Salesforce lifecycle: <not set>');
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
export const buildSalesforceLifecycleSignalTokens = (
  signals: SalesforceLifecycleSignalBundle,
): string[] => {
  const out: string[] = [];
  if (signals.salesforce_lifecycle_stage !== null) {
    out.push(`salesforce_label:${signals.salesforce_lifecycle_stage}`);
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

/** Resolve effective `ForceLayer` for the AI call. Mirrors the
 *  HubSpot variant — both topics share the per-topic trust + pool
 *  policy gate. */
export const resolveSalesforceLifecycleStageLayer = (
  ctx: HousekeepingContext,
  trustStore: TrustStore | undefined,
): ForceLayer => {
  if (!trustStore) return 'any';
  const trust = trustStore.read(LIFECYCLE_STAGE_SALESFORCE_TOPIC, true);
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
      LIFECYCLE_STAGE_SALESFORCE_SOURCE_SCOPE,
      LIFECYCLE_STAGE_SALESFORCE_MAX_CONTACTS_PER_CYCLE,
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
  category: SalesforceLifecycleStage;
  confidence: number;
  reasoning: string;
}

const isClassifyOutput = (v: unknown): v is ClassifyOutput => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  if (!isSalesforceLifecycleStage(obj.category)) return false;
  if (typeof obj.confidence !== 'number' || !Number.isFinite(obj.confidence)) return false;
  if (typeof obj.reasoning !== 'string') return false;
  return true;
};

/** D-136 P3 — producer-version hash. Mirrors the HubSpot variant —
 *  bumps whenever this file's `PRODUCER_CODE_HASH` literal moves or
 *  the prompt template / category list changes. The Salesforce
 *  category set diverges from HubSpot's so the prompt template hash
 *  is independent (Lead/Prospect/Customer/Prior Customer/Partner/Other
 *  vocabulary). */
const PRODUCER_CODE_HASH = 'lifecycle_stage_inferred_salesforce:1';
const PROMPT_TEMPLATE_HASH = 'lifecycle_classify_salesforce_v1';
const ADAPTER_VERSION = '@recued/llm@1.0.0';

const baseProducerVersionHash = computeProducerVersionHash({
  producer_code_hash: PRODUCER_CODE_HASH,
  model_id: '',
  prompt_template_hash: PROMPT_TEMPLATE_HASH,
  adapter_version: ADAPTER_VERSION,
  consumed_ingredients_versions: [{ slug: 'ai-classify', version: '1' }],
});

/** D-136 P3 — extract `event_at` from the platform record's snapshot
 *  clock (audit §20.2 fix). Salesforce reconciler stamps
 *  `meta.snapshot_at` on every contact row when refreshing the
 *  platform-reference scope; the inferred lifecycle stage is anchored
 *  to that snapshot, NOT the producer's compute time. */
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
 *  `meta.snapshot_at`. */
export const processOneSalesforceContact = async (
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
  const salesforce_label = typeof meta.lifecycle_stage === 'string' ? meta.lifecycle_stage : null;
  const sig = readBehavioralSignature(ctx, email);
  const role_category = readRoleCategory(ctx, email);

  const signals: SalesforceLifecycleSignalBundle = {
    email,
    salesforce_lifecycle_stage: salesforce_label,
    mail_count_window: sig.mail_count_window,
    meeting_count_window: sig.meeting_count_window,
    mean_reply_latency_ms: sig.mean_reply_latency_ms,
    role_category,
  };

  const llmInput = {
    'llm.data': buildSalesforceLifecyclePrompt(signals),
    'llm.categories': [...SALESFORCE_LIFECYCLE_STAGES],
    'llm.context': LIFECYCLE_CLASSIFY_CONTEXT,
    'llm.model_hint': 'fast',
    'llm.force_layer': forceLayer,
  };

  const source_record_hash = meta.snapshot_hash;

  const outcome = await runAIProducer({
    ctx,
    topic: LIFECYCLE_STAGE_SALESFORCE_TOPIC,
    scope: LIFECYCLE_STAGE_SALESFORCE_SOURCE_SCOPE,
    target_id: contact.target_id,
    authored_by: LIFECYCLE_STAGE_SALESFORCE_AUTHORED_BY,
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
    // is the canonicalised address that `buildSalesforceLifecyclePrompt`
    // flattens into `llm.data` (`Contact: <email>`), so seeding the egressed
    // value lets the wrapper alias it before the contact email leaves for a
    // free-pool / cloud model. Scope `connection.api.salesforce.contact`
    // resolves the contact privacy schema's `email` tag.
    sourceRecordData: signals,
    validate: (raw): ClassifyOutput => {
      if (!isClassifyOutput(raw)) {
        throw new Error(
          `lifecycle_stage_inferred_salesforce_output_invalid: ai-classify returned non-conformant shape or out-of-set stage for contact '${contact.target_id}'`,
        );
      }
      return raw;
    },
    buildValue: (result): LifecycleStageInferredSalesforceValue => ({
      stage: result.category,
      reasoning: result.reasoning,
      signals: buildSalesforceLifecycleSignalTokens(signals),
      computed_at: ctx.now(),
    }),
    meta: meta as EnrichmentMeta,
    token_estimate: LIFECYCLE_STAGE_SALESFORCE_TOKEN_ESTIMATE,
  });

  if (outcome.status === 'computed') return { produced: true };
  if (outcome.status === 'dedup_hit') return { produced: false, reason: 'dedup_hit' };
  return { produced: false, reason: 'skipped_trust' };
};

export const runLifecycleStageInferredSalesforceCycle = async (
  ctx: HousekeepingContext,
): Promise<{ produced: number; skipped: number }> => {
  const forceLayer = resolveSalesforceLifecycleStageLayer(ctx, ctx.trustStore);
  const contacts = listContactTargetIds(ctx);
  let produced = 0;
  let skipped = 0;
  for (const contact of contacts) {
    const out = await processOneSalesforceContact(ctx, contact, forceLayer);
    if (out.produced) produced += 1;
    else skipped += 1;
  }
  return { produced, skipped };
};

// ────────────────────────────────────────────────────────────────
// Task instance
// ────────────────────────────────────────────────────────────────

export const lifecycleStageInferredSalesforceTask: HousekeepingTaskInstance = {
  meta: {
    id: 'enrichment.lifecycle_stage_inferred_salesforce',
    description:
      'AI-classified normalised lifecycle stage per Salesforce contact — surfaces the gap when Salesforce lifecycle drifts from observed engagement.',
    interruptible: true,
    kind: 'enrichment',
    tags: computeHousekeepingMetaTags({
      def: ENRICHMENT_REGISTRY.lifecycle_stage_inferred_salesforce,
      isAiSurface: true,
    }),
  },
  topic: LIFECYCLE_STAGE_SALESFORCE_TOPIC,
  is_ai_surface: true,

  async step(
    ctx: HousekeepingContext,
    _cursor: HousekeepingCursor,
    _budget_ms: number,
  ): Promise<HousekeepingStepResult> {
    await runLifecycleStageInferredSalesforceCycle(ctx);
    return { status: 'complete', cursor: { kind: 'complete' } };
  },
};

export const lifecycleStageInferredSalesforceTokenEstimate = (): number =>
  LIFECYCLE_STAGE_SALESFORCE_TOKEN_ESTIMATE;

export const lifecycleStageInferredSalesforceScopeReadDeclaration = [
  {
    collection: 'data.enrichment.connection.api.salesforce.contact',
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

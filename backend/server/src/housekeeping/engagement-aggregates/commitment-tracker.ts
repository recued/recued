/** D-139 P6.B / D-192 email flagship — `commitment_tracker` extraction
 *  producer (the fan-in math).
 *
 *  Extracts commitments people made ("you said you'd send X by Friday")
 *  from a contact's engagement bodies (per-type CRM email / meeting /
 *  note / call / task engagements) and folds them into the per-contact
 *  `commitment_tracker` enrichment row. This is the EMAIL flagship's
 *  extraction engine (D-192): the extracted commitments feed proposals
 *  through the `commitment-propose` gate (slice E3) instead of remaining
 *  enrichment-only facts.
 *
 *  This file is the PURE producer — it folds a `ReadonlyArray<
 *  EngagementsResolverRow>` gathered by the caller (the same posture as
 *  `next-best-action.ts`), so it is testable without the resolver /
 *  walk wiring. The standalone task that walks contact platform-reference
 *  rows, gathers each contact's engagements via
 *  `resolveEngagementsForContact`, applies the multi-record PII fan-in
 *  wrap, and registers into `STANDALONE_TASKS` lands in slice E2b — this
 *  producer is inert (imported only by tests) until then, exactly like
 *  the P5 `next_best_action` / `engagement_sentiment_trend` siblings.
 *
 *  Pass-4 evidence-quality consumption defaults (declared on the
 *  `commitment_tracker` registry entry, tighter than sentiment):
 *    - `body_state_acceptance`: ['inline_body'] — full body context
 *      required (truncated previews drop the very fragment the promise
 *      lives in);
 *    - `authorship_acceptance`: ['user', 'crm_user', 'unknown'] —
 *      automation / system_process rows can't make commitments;
 *    - `lifecycle_state_acceptance`: ['point_in_time', 'completed'] —
 *      pending / scheduled / cancelled / failed rows have no
 *      commitment-bearing body.
 *
 *  Output value-shape safety (Pass-3 R3.6 + § P6.B):
 *    - each commitment's `text` clamps to `COMMITMENT_TEXT_MAX_CHARS`
 *      (200) — a short paraphrase, never a body excerpt; the cap is the
 *      body-leak defense (no verbatim-window guard: a promise paraphrase
 *      legitimately overlaps its sentence, unlike NBA's rationale);
 *    - `actor_email` is shape-validated (rejects body-shaped strings);
 *    - `evidence_links` is REQUIRED per commitment (invariant 1: no
 *      evidence, no commitment) — a commitment whose source engagement
 *      can't be resolved is DROPPED (fail-closed);
 *    - `commitments[]` caps at `COMMITMENT_TRACKER_COMMITMENTS_MAX` (50).
 *
 *  v1 deliberately does NOT populate `due_at`: the LLM cannot reliably
 *  resolve relative phrasing ("by Friday") without a trusted clock, and
 *  the deadline is the owner's to set at approval (the F1 posture —
 *  `promised_for_at` defaults absent). Extraction over warehouse
 *  `mail` / `calendar` / `memory` (beyond CRM engagement bodies) is a
 *  documented follow-on; v1 scopes to the D-139 engagement surface the
 *  pack's body-content grant covers.
 *
 *  Spec: D-139 § P6.B + D-192
 *  § Relationship to D-139's `crm-commitment-tracker`. */

import {
  COMMITMENT_ACTOR_EMAIL_MAX_CHARS,
  COMMITMENT_ACTOR_EMAIL_MIN_CHARS,
  COMMITMENT_ACTOR_EMAIL_RE,
  COMMITMENT_EVIDENCE_LINKS_MAX,
  COMMITMENT_TEXT_MAX_CHARS,
  COMMITMENT_TRACKER_COMMITMENTS_MAX,
  ENRICHMENT_REGISTRY,
  computeProducerVersionHash,
  type Authorship,
  type BodyState,
  type CommitmentEvidenceLink,
  type CommitmentEvidenceSource,
  type CommitmentTrackerValue,
  type CoverageMetadata,
  type EngagementLifecycleState,
  type EngagementsResolverRow,
  type EnrichmentScope,
  type EnrichmentTopic,
  type IngredientManifest,
  type TrackedCommitment,
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

export const COMMITMENT_TRACKER_TOPIC: EnrichmentTopic = 'commitment_tracker';
export const COMMITMENT_TRACKER_AUTHORED_BY =
  'system.housekeeping.commitment_tracker';

/** Producer read window (ms). 90d mirrors the D-139 "real touch"
 *  default — commitments older than a quarter are stale evidence. */
export const COMMITMENT_TRACKER_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/** Hard cap on engagement rows folded into one extraction call. Bounds
 *  token spend + keeps the indexed prompt tractable; the freshest rows
 *  win (a contact with hundreds of touches folds the most recent 40). */
export const COMMITMENT_TRACKER_MAX_ROWS = 40;

/** Per-row body preview cap in the prompt. Wider than sentiment/NBA —
 *  a commitment phrase can sit deep in a mail body — but still bounded
 *  so one long thread can't blow the context window. */
export const COMMITMENT_TRACKER_BODY_PREVIEW_CHARS = 1200;

/** Minimum extraction confidence to persist a commitment. Below this the
 *  commitment is dropped (no low-confidence rows). The registry comment
 *  references this floor but never defined the constant — it lives here
 *  because it is a producer-side filter, not a stored contract. */
export const COMMITMENT_TRACKER_MIN_CONFIDENCE = 0.5;

/** Confidence assigned when the LLM omits one (ai-extract returns free
 *  shape). Deliberately mid-range — an extracted-but-unscored commitment
 *  is a proposal the owner reviews, not an auto-mint. */
export const COMMITMENT_TRACKER_DEFAULT_CONFIDENCE = 0.7;

/** Per-call token estimate. ~1000 input (indexed engagement bodies) +
 *  ~200 structured output (commitment array). Larger than the classify
 *  producers — extraction folds full bodies. */
export const COMMITMENT_TRACKER_TOKEN_ESTIMATE = 1200;

/** Producer-declared freshness horizon — mirrors registry
 *  `recompute_cadence: '24h'`. */
export const COMMITMENT_TRACKER_VALIDITY_MS = 24 * 60 * 60 * 1000;

// ────────────────────────────────────────────────────────────────
// AI manifest + prompt scaffolding
// ────────────────────────────────────────────────────────────────

/** Inline `IngredientManifest` matching `community/ingredients/ai-extract.json`
 *  — the array-output extraction path `action_items` uses. */
const aiExtractManifest: IngredientManifest = {
  slug: 'ai-extract',
  name: 'AI Field Extractor',
  description:
    'Extracts requested structured fields from the input data.',
  author: 'recued-core',
  kind: 'ai',
  category: 'ai',
  risk_tier: 'read',
  version: 1,
  tags: ['ai', 'extraction'],
  input: {
    'llm.data': null,
    'llm.fields': null,
    'llm.model_hint': null,
  },
  output: {
    extracted: 'dynamic_fields_per_llm_fields_input',
  },
};

/** Extraction instruction pinned in the prompt. Written for
 *  substrate-support discipline (D-132 free-pool + local models): a
 *  closed shape, an explicit "explicit only" rule, and the index-back
 *  reference that lets the producer bind each commitment to its source
 *  engagement deterministically (no source ⇒ dropped). */
export const COMMITMENT_EXTRACT_INSTRUCTION =
  'Each engagement below is numbered [n] with its sender and direction. '
  + 'Extract every EXPLICIT commitment a person made — a concrete promise to do a '
  + 'specific thing (send a document, follow up, schedule, deliver, pay). '
  + 'Return a JSON array under the field "commitments"; each element is '
  + '{ "index": <the [n] of the engagement the promise appears in>, '
  + '"actor": "<email of the person who made the promise>", '
  + '"text": "<a short paraphrase of the promise, <= 200 chars, NOT a quote of the body>" }. '
  + 'Only explicit promises — never infer, never speculate, never invent a commitment from a '
  + 'greeting or a question. If an engagement contains no promise, skip it. '
  + 'If there are no commitments, return an empty array.';

// ────────────────────────────────────────────────────────────────
// Acceptance filter (registry-declared, tighter than sentiment)
// ────────────────────────────────────────────────────────────────

const ACCEPTABLE_BODY_STATES: ReadonlySet<BodyState> = new Set(
  ENRICHMENT_REGISTRY.commitment_tracker.body_state_acceptance ?? [],
);
const ACCEPTABLE_AUTHORSHIPS: ReadonlySet<Authorship> = new Set(
  ENRICHMENT_REGISTRY.commitment_tracker.authorship_acceptance ?? [],
);
const ACCEPTABLE_LIFECYCLE_STATES: ReadonlySet<EngagementLifecycleState> =
  new Set(ENRICHMENT_REGISTRY.commitment_tracker.lifecycle_state_acceptance ?? []);

/** Filter rows per the registry acceptance + the producer window. Pure /
 *  testable. Mirrors `filterRowsForNextBestAction`. */
export const filterRowsForCommitmentTracker = (
  rows: ReadonlyArray<EngagementsResolverRow>,
  window_cutoff_at?: number,
): EngagementsResolverRow[] => {
  const out: EngagementsResolverRow[] = [];
  for (const row of rows) {
    if (row.event_at === null) continue;
    if (window_cutoff_at !== undefined && row.event_at < window_cutoff_at) continue;
    if (row.deleted_at !== undefined) continue;
    if (!ACCEPTABLE_AUTHORSHIPS.has(row.authorship)) continue;
    if (!ACCEPTABLE_LIFECYCLE_STATES.has(row.lifecycle_state)) continue;
    if (!ACCEPTABLE_BODY_STATES.has(row.body_state)) continue;
    if (typeof row.body_inline !== 'string' || row.body_inline.trim().length === 0) continue;
    out.push(row);
  }
  return out;
};

/** Map an engagement `(vendor, entity)` to the closed
 *  `CommitmentEvidenceSource` family. Unknown pairs return undefined —
 *  the caller drops the commitment (can't cite a source family). */
export const engagementEvidenceSource = (
  row: EngagementsResolverRow,
): CommitmentEvidenceSource | undefined => {
  const key = `${row.vendor}:${row.entity}`;
  switch (key) {
    case 'hubspot:email':
      return 'engagement_email';
    case 'hubspot:meeting':
      return 'engagement_meeting';
    case 'hubspot:note':
      return 'engagement_note';
    case 'hubspot:call':
      return 'engagement_call';
    case 'hubspot:task':
    case 'salesforce:task':
      return 'engagement_task';
    case 'salesforce:event':
      return 'engagement_event';
    case 'salesforce:email_message':
      return 'engagement_email_message';
    case 'salesforce:voice_call':
      return 'engagement_voice_call';
    case 'salesforce:call_history':
      return 'engagement_call_history';
    default:
      return undefined;
  }
};

/** Sender email surfaced in the prompt header for a row. Producers read
 *  `meta.from` / `meta.sender` when the projector populated it; falls
 *  back to a direction label so the LLM still has an attribution anchor. */
const rowSenderHint = (row: EngagementsResolverRow): string => {
  const from = row.meta.from ?? row.meta.sender ?? row.meta.from_email;
  if (typeof from === 'string' && from.length > 0) return from;
  return `(${row.direction})`;
};

const truncateBodyPreview = (row: EngagementsResolverRow): string => {
  const body = row.body_inline;
  if (typeof body !== 'string') return '';
  const trimmed = body.trim();
  if (trimmed.length <= COMMITMENT_TRACKER_BODY_PREVIEW_CHARS) return trimmed;
  return `${trimmed.slice(0, COMMITMENT_TRACKER_BODY_PREVIEW_CHARS - 1)}…`;
};

/** Compose the indexed extraction prompt. Rows are the FRESHEST
 *  `COMMITMENT_TRACKER_MAX_ROWS`, oldest-first, each numbered so the LLM
 *  can index a commitment back to its source engagement. Returns
 *  `{ prompt, indexed }` — `indexed` is the row array the validator maps
 *  `index` back through (same slice + order). */
export const buildCommitmentPrompt = (
  subject_email: string,
  rows: ReadonlyArray<EngagementsResolverRow>,
): { prompt: string; indexed: EngagementsResolverRow[] } => {
  const sorted = [...rows].sort(
    (a, b) => (a.event_at as number) - (b.event_at as number),
  );
  const indexed = sorted.slice(
    Math.max(0, sorted.length - COMMITMENT_TRACKER_MAX_ROWS),
  );
  const lines: string[] = [];
  lines.push(`Contact: ${subject_email}`);
  lines.push(`Engagements: ${indexed.length} (oldest first)`);
  lines.push('');
  indexed.forEach((row, i) => {
    const at = new Date(row.event_at as number).toISOString();
    lines.push(
      `[${i}] ${at} ${row.vendor}/${row.entity} from=${rowSenderHint(row)} direction=${row.direction}`,
    );
    const preview = truncateBodyPreview(row);
    if (preview.length > 0) lines.push(preview);
    lines.push('');
  });
  return { prompt: lines.join('\n'), indexed };
};

// ────────────────────────────────────────────────────────────────
// Output validation → TrackedCommitment[]
// ────────────────────────────────────────────────────────────────

/** Actor-email shape guard. Uses the EXACT same strict check the
 *  registry's `CommitmentTrackerSchema` applies at upsert
 *  (`COMMITMENT_ACTOR_EMAIL_RE` + the length bounds) so a commitment
 *  that survives validation here can never fail the schema at upsert —
 *  a looser guard would let a malformed address (e.g. a comma-joined
 *  multi-address) through, and the schema failure would then reject the
 *  WHOLE value (losing every otherwise-valid commitment) instead of
 *  dropping the one bad row (codex MEDIUM). Fail-closed per commitment. */
const isActorEmailShape = (v: unknown): v is string =>
  typeof v === 'string'
  && v.length >= COMMITMENT_ACTOR_EMAIL_MIN_CHARS
  && v.length <= COMMITMENT_ACTOR_EMAIL_MAX_CHARS
  && COMMITMENT_ACTOR_EMAIL_RE.test(v);

interface RawCommitment {
  index: number;
  actor: string;
  text: string;
  /** Always populated by `parseRawCommitment` — the LLM value clamped
   *  to [0, 1], or `COMMITMENT_TRACKER_DEFAULT_CONFIDENCE` when omitted. */
  confidence: number;
}

const parseRawCommitment = (v: unknown): RawCommitment | null => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const obj = v as Record<string, unknown>;
  if (typeof obj.index !== 'number' || !Number.isInteger(obj.index)) return null;
  if (!isActorEmailShape(obj.actor)) return null;
  if (typeof obj.text !== 'string' || obj.text.trim().length === 0) return null;
  const confidence =
    typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)
      ? Math.max(0, Math.min(1, obj.confidence))
      : COMMITMENT_TRACKER_DEFAULT_CONFIDENCE;
  return { index: obj.index, actor: obj.actor, text: obj.text, confidence };
};

/** Content-hash a commitment for stable dedup across re-extraction:
 *  the paraphrase + its primary source id. Re-running the producer on
 *  the same evidence yields the same `commitment_id`. */
export const composeCommitmentId = (text: string, source_id: string): string =>
  `ct_${fnv1aHex(`${text}\x1f${source_id}`)}`;

/** Per-row content hash folded into the fan-in fingerprint's version
 *  slot. Includes the vendor modstamp AND the substrate-derived evidence
 *  fields (body content, authorship, direction, lifecycle, body_state)
 *  so the dedup probe correctly RE-EXTRACTS when a row's BODY changes or
 *  it reclassifies WITHOUT a `vendor_modstamp` bump — a modstamp-only
 *  version would silently keep the stale extraction (codex MEDIUM;
 *  mirrors NBA's `composeNextBestActionSourceHash`). */
export const composeCommitmentRowHash = (row: EngagementsResolverRow): string => {
  const modstamp = row.vendor_modstamp ?? String(row.vendor_modified_at);
  const composed = [
    modstamp,
    row.authorship,
    row.direction,
    row.lifecycle_state,
    row.body_state,
    fnv1aHex(row.body_inline ?? ''),
  ].join('\x1f');
  return `fnv1a:${fnv1aHex(composed)}`;
};

/** Validate + bind the extraction output. Every surviving commitment
 *  carries exactly one evidence link (its source engagement); a
 *  commitment whose `index` doesn't resolve to a folded row, whose actor
 *  is not email-shaped, whose source family is unknown, or whose
 *  confidence is below the floor is DROPPED (fail-closed — invariant 1).
 *  `indexed` MUST be the same slice `buildCommitmentPrompt` returned. */
export const validateCommitmentExtraction = (
  raw: unknown,
  indexed: ReadonlyArray<EngagementsResolverRow>,
  now: number,
): TrackedCommitment[] => {
  const obj =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const list = Array.isArray(obj.commitments) ? obj.commitments : [];
  const seen = new Set<string>();
  const out: TrackedCommitment[] = [];
  for (const entry of list) {
    const parsed = parseRawCommitment(entry);
    if (parsed === null) continue;
    if (parsed.confidence < COMMITMENT_TRACKER_MIN_CONFIDENCE) continue;
    const row = indexed[parsed.index];
    if (row === undefined) continue; // hallucinated / out-of-range index
    const source = engagementEvidenceSource(row);
    if (source === undefined) continue; // can't cite a source family
    const text = parsed.text.trim().slice(0, COMMITMENT_TEXT_MAX_CHARS);
    if (text.length === 0) continue;
    const source_id = row.target_id;
    const commitment_id = composeCommitmentId(text, source_id);
    if (seen.has(commitment_id)) continue; // dedup
    seen.add(commitment_id);
    const link: CommitmentEvidenceLink = {
      source,
      source_id,
      source_at: row.event_at ?? row.vendor_modified_at,
    };
    out.push({
      commitment_id,
      text,
      status: 'pending',
      actor_email: parsed.actor,
      evidence_links: [link].slice(0, COMMITMENT_EVIDENCE_LINKS_MAX),
      extracted_at: now,
      confidence: parsed.confidence,
    });
    if (out.length >= COMMITMENT_TRACKER_COMMITMENTS_MAX) break;
  }
  return out;
};

/** Compose the persisted per-contact value. */
export const buildCommitmentTrackerValue = (
  subject_email: string,
  subject_name: string | undefined,
  commitments: ReadonlyArray<TrackedCommitment>,
  samples: number,
  cursor_at: number,
  now: number,
): CommitmentTrackerValue => ({
  ...(subject_name !== undefined ? { name: subject_name } : {}),
  entity: subject_email,
  commitments,
  samples,
  cursor_at,
  computed_at: now,
});

// ────────────────────────────────────────────────────────────────
// Trust → ForceLayer (mirrors NBA / lifecycle-stage)
// ────────────────────────────────────────────────────────────────

export const resolveCommitmentTrackerLayer = (
  ctx: HousekeepingContext,
  trustStore: TrustStore | undefined,
): ForceLayer => {
  if (!trustStore) return 'any';
  const trust = trustStore.read(COMMITMENT_TRACKER_TOPIC, true);
  const byokAllowed = isByokAllowedForBackground(ctx.db);
  if (!byokAllowed) return 'free';
  if (trust.pool_policy === 'free_only') return 'free';
  if (trust.pool_policy === 'byok_only') return 'byok';
  return 'any';
};

// ────────────────────────────────────────────────────────────────
// Producer version hash
// ────────────────────────────────────────────────────────────────

const PRODUCER_CODE_HASH = 'commitment_tracker:1';
const PROMPT_TEMPLATE_HASH = 'commitment_extract_v1';
const ADAPTER_VERSION = '@recued/llm@1.0.0';

const baseProducerVersionHash = computeProducerVersionHash({
  producer_code_hash: PRODUCER_CODE_HASH,
  model_id: '',
  prompt_template_hash: PROMPT_TEMPLATE_HASH,
  adapter_version: ADAPTER_VERSION,
  consumed_ingredients_versions: [{ slug: 'ai-extract', version: '1' }],
});

export const COMMITMENT_TRACKER_PRODUCER_VERSION_HASH = baseProducerVersionHash;

// ────────────────────────────────────────────────────────────────
// Producer entry point
// ────────────────────────────────────────────────────────────────

export interface CommitmentTrackerProducerInput {
  rows: ReadonlyArray<EngagementsResolverRow>;
  /** Contact platform-reference scope the row lands under. */
  scope: EnrichmentScope;
  /** Contact platform-reference target id (the walk key). */
  target_id: string;
  /** Canonical contact email — the perspective subject (`value.entity`). */
  subject_email: string;
  /** Resolved contact name when available (`value.name`). */
  subject_name?: string;
  /** Resolver coverage (composed by the caller). */
  coverage: CoverageMetadata;
  /** Stable anchor hash for the cross-cycle skip rule. */
  source_record_hash: string;
  as_of: number;
  now: number;
  forceLayer: ForceLayer;
  /** Optional pre-computed event_at; defaults to the freshest row's. */
  event_at?: number | null;
}

/** Pure producer entry point. Folds the contact's qualifying engagement
 *  bodies into one extraction call and upserts the per-contact
 *  `commitment_tracker` row. Returns the outcome discriminator (mirrors
 *  `processOneNextBestAction`). Zero qualifying rows → an empty
 *  `commitments[]` tombstone so a contact that goes quiet doesn't leave
 *  a stale fresh-chain head. */
export const processOneCommitmentTracker = async (
  ctx: HousekeepingContext,
  input: CommitmentTrackerProducerInput,
): Promise<{
  produced: boolean;
  reason?: 'no_llm' | 'dedup_hit' | 'skipped_trust';
}> => {
  const window_cutoff_at = input.as_of - COMMITMENT_TRACKER_WINDOW_MS;
  const filtered = filterRowsForCommitmentTracker(input.rows, window_cutoff_at);

  // Zero qualifying engagements — write an empty-commitments row WITHOUT
  // an LLM call. This runs BEFORE the no-LLM guard (codex HIGH): the
  // tombstone is deterministic, so a contact that had commitments and
  // goes silent must get its stale fresh-chain head cleared even when the
  // AI path is unavailable — gating it behind `llmWithMeta` would leave a
  // stale prior commitment live whenever AI is unconfigured.
  if (filtered.length === 0) {
    return writeCommitmentTrackerTombstone(ctx, input);
  }

  if (!ctx.llmWithMeta) return { produced: false, reason: 'no_llm' };

  let cursor_at = 0;
  let freshest_event_at = 0;
  for (const row of filtered) {
    if (row.vendor_modified_at > cursor_at) cursor_at = row.vendor_modified_at;
    if ((row.event_at as number) > freshest_event_at) {
      freshest_event_at = row.event_at as number;
    }
  }

  const { prompt, indexed } = buildCommitmentPrompt(input.subject_email, filtered);

  // `perspective_fan_in` fingerprint (registry-declared): one {id,
  // version} pair per folded engagement so any body / modstamp change
  // flips the hash and forces re-extraction. The field names read
  // enrichment_row_id / producer_version_hash, but the composition only
  // needs a stable id + a version that moves — the engagement's
  // target_id + vendor modstamp serve exactly that.
  const upstream = indexed.map((row) => ({
    enrichment_row_id: `${row.connection_id}\x1f${row.target_id}`,
    producer_version_hash: composeCommitmentRowHash(row),
  }));

  const llmInput = {
    'llm.data': `${COMMITMENT_EXTRACT_INSTRUCTION}\n\n${prompt}`,
    'llm.fields': ['commitments'],
    'llm.model_hint': 'fast',
    'llm.force_layer': input.forceLayer,
  };

  const outcome = await runAIProducer({
    ctx,
    topic: COMMITMENT_TRACKER_TOPIC,
    scope: input.scope,
    target_id: input.target_id,
    authored_by: COMMITMENT_TRACKER_AUTHORED_BY,
    source_record_hash: input.source_record_hash,
    inputFingerprint: {
      kind: 'perspective_fan_in',
      upstream,
      // STABLE `as_of` (codex HIGH) — the freshest source modstamp
      // (`cursor_at`), NOT `input.as_of` (= ctx.now()). A moving `as_of`
      // would flip the dedup hash every cycle and re-extract (+ re-bill)
      // an unchanged contact every housekeeping interval. The `upstream`
      // row hashes already carry the real invalidation signal (a changed
      // body / modstamp / reclassification), and `cursor_at` moves only
      // when new activity arrives — so unchanged engagements dedup, matching
      // the sibling lifecycle-stage's stable `per_record_source_hash`.
      as_of: cursor_at,
      effective_topic_config: '',
    },
    producer_version_hash: baseProducerVersionHash,
    ingredient_slug: 'ai-extract',
    eventClock: {
      event_at:
        input.event_at !== undefined
          ? input.event_at
          : freshest_event_at > 0
            ? freshest_event_at
            : null,
    },
    manifest: aiExtractManifest,
    llmInput,
    // No `sourceRecordData`: this is a fan-in producer whose egressing
    // PII (engagement bodies / sender emails) lives across many rows, not
    // one structured record. The caller (the E2b task) pre-wraps `ctx`
    // with `wrapHousekeepingCtxForFanIn` over the folded rows; the
    // single-record seam here would only no-op on the contact record.
    validate: (raw): TrackedCommitment[] =>
      validateCommitmentExtraction(raw, indexed, input.now),
    buildValue: (commitments): CommitmentTrackerValue =>
      buildCommitmentTrackerValue(
        input.subject_email,
        input.subject_name,
        commitments,
        // `samples` = rows actually FOLDED into the extraction call (the
        // freshest-window `indexed`), not every qualifying row — honest
        // about what the computation saw when `filtered` exceeds the cap.
        indexed.length,
        cursor_at,
        input.now,
      ),
    meta: { snapshot_at: input.as_of, snapshot_hash: input.source_record_hash },
    token_estimate: COMMITMENT_TRACKER_TOKEN_ESTIMATE,
  });

  if (outcome.status === 'computed') return { produced: true };
  if (outcome.status === 'dedup_hit') return { produced: false, reason: 'dedup_hit' };
  return { produced: false, reason: 'skipped_trust' };
};

/** Zero-sample tombstone — persists an empty-commitments row when the
 *  contact has no qualifying engagements, bypassing the LLM. Anchored on
 *  a zero-sample fingerprint so steady-state quiet contacts dedup and
 *  don't re-write every cycle. Mirrors `writeNextBestActionTombstone`. */
const writeCommitmentTrackerTombstone = (
  ctx: HousekeepingContext,
  input: CommitmentTrackerProducerInput,
): { produced: boolean; reason?: 'dedup_hit' } => {
  const fingerprintHash = `fnv1a:${fnv1aHex(`zero_sample\x1f${input.source_record_hash}`)}`;
  const existing = ctx.enrichmentStore.list({
    topic: COMMITMENT_TRACKER_TOPIC,
    scope: input.scope,
    target_id: input.target_id,
    authored_by: COMMITMENT_TRACKER_AUTHORED_BY,
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
  const value = buildCommitmentTrackerValue(
    input.subject_email,
    input.subject_name,
    [],
    0,
    0,
    now,
  );
  const tombstoneEventAt =
    typeof input.event_at === 'number' ? input.event_at : undefined;
  ctx.enrichmentStore.upsert({
    topic: COMMITMENT_TRACKER_TOPIC,
    scope: input.scope,
    target_id: input.target_id,
    value,
    authored_by: COMMITMENT_TRACKER_AUTHORED_BY,
    source_record_hash: input.source_record_hash,
    ingredient_slug: 'ai-extract',
    model_id: '',
    ...(tombstoneEventAt !== undefined ? { event_at: tombstoneEventAt } : {}),
    as_of: now,
    producer_version_hash: baseProducerVersionHash,
    input_fingerprint_hash: fingerprintHash,
  });
  return { produced: true };
};

/** D-192 email flagship E2b — the `commitment_tracker` standalone task.
 *
 *  The dispatch shell around the pure producer (`commitment-tracker.ts`):
 *  walks the contact platform-reference rows, gathers each contact's
 *  engagement bodies via the ctx's `resolveContactEngagements` closure,
 *  applies the multi-record PII fan-in wrap, and runs the extraction. This
 *  is what makes `commitment_tracker` actually RUN — the topic had a
 *  contract + pack + recipes but no live producer until this landed.
 *
 *  DECLARATION-DRIVEN walk (owner design call): the contact scopes are
 *  resolved from the live vendor registry via `scopesForCrmAlias('contact',
 *  registry)`, NOT a hardcoded `['connection.api.hubspot.contact', …]`
 *  list — so Pipedrive's `entity:'person' crm_alias:'contact'` + any
 *  pack CRM join automatically. Same idiom the D-192 F1 deal capture uses.
 *
 *  Registered in `STANDALONE_TASKS`; runs on Run-Now + (after the user
 *  promotes the topic's D-132 trust to `'auto'`) idle cycles. Manual trust
 *  default (AI-surface) means it stays inert until the user opts in.
 *
 *  Spec: `docs/d-192-spec.md` § Relationship to D-139's
 *  `crm-commitment-tracker`. */

import {
  CONNECTION_VENDOR_ENTITIES,
  ENRICHMENT_REGISTRY,
  computeHousekeepingMetaTags,
  scopesForCrmAlias,
  type Authorship,
  type CommitmentTrackerValue,
  type DedupeAcceptance,
  type EngagementLifecycleState,
  type EngagementsResolverArgs,
  type EnrichmentScope,
  type HousekeepingCursor,
  type HousekeepingStepResult,
  type TrackedCommitment,
} from '@recued/contracts';

import { wrapHousekeepingCtxForFanIn } from '../enrichment-pii-egress.js';
import type {
  HousekeepingContext,
  HousekeepingTaskInstance,
} from '../registry.js';
import {
  COMMITMENT_TRACKER_AUTHORED_BY,
  COMMITMENT_TRACKER_TOPIC,
  COMMITMENT_TRACKER_WINDOW_MS,
  processOneCommitmentTracker,
  resolveCommitmentTrackerLayer,
} from './commitment-tracker.js';

/** Hard cap on contacts walked per (scope, cycle). AI-surface — the cap
 *  bounds token spend on large CRM portals; the producer additionally
 *  bounds folded engagement rows per contact. */
export const COMMITMENT_TRACKER_MAX_CONTACTS_PER_CYCLE = 500;

/** Registry acceptance, resolved once — passed to the resolver so it
 *  pre-filters (the producer re-applies them + adds the `body_state`
 *  gate the resolver args don't carry). */
const ACCEPTED_AUTHORSHIP =
  (ENRICHMENT_REGISTRY.commitment_tracker.authorship_acceptance ?? []) as readonly Authorship[];
const ACCEPTED_LIFECYCLE =
  (ENRICHMENT_REGISTRY.commitment_tracker.lifecycle_state_acceptance ?? []) as readonly EngagementLifecycleState[];
const ACCEPTED_DEDUPE =
  (ENRICHMENT_REGISTRY.commitment_tracker.dedupe_acceptance ?? 'exact_only') as DedupeAcceptance;

interface ContactWalkRow {
  target_id: string;
  meta_json: string | null;
}

interface ContactMetaShape {
  email?: unknown;
  name?: unknown;
  snapshot_at?: unknown;
  snapshot_hash?: unknown;
}

const parseContactMeta = (meta_json: string | null): ContactMetaShape | null => {
  if (meta_json === null) return null;
  try {
    return JSON.parse(meta_json) as ContactMetaShape;
  } catch {
    return null;
  }
};

/** Read a contact's freshly-upserted `commitment_tracker` commitments back
 *  from the enrichment store (E3 — the funnel input). The producer just
 *  wrote the chain-head row; `fresh_only` + limit 1 fetches it. The store
 *  returns `value` already parsed. Empty (tombstone / missing) ⇒ []. */
const readFreshCommitments = (
  ctx: HousekeepingContext,
  scope: EnrichmentScope,
  target_id: string,
): readonly TrackedCommitment[] => {
  const rows = ctx.enrichmentStore.list({
    topic: COMMITMENT_TRACKER_TOPIC,
    scope,
    target_id,
    authored_by: COMMITMENT_TRACKER_AUTHORED_BY,
    fresh_only: true,
    limit: 1,
  });
  const value = rows[0]?.value as CommitmentTrackerValue | undefined;
  return value?.commitments ?? [];
};

/** DISTINCT-target_id walk over one contact platform-reference scope in
 *  `data_enrichment` (mirrors the lifecycle-stage sibling, parameterized
 *  by scope so the cross-vendor roster iterates it). */
const listContactTargetIds = (
  ctx: HousekeepingContext,
  scope: string,
): ContactWalkRow[] =>
  ctx.db
    .prepare(
      `SELECT target_id, MAX(meta) AS meta_json
         FROM data_enrichment
        WHERE scope = ?
          AND target_id IS NOT NULL
          AND meta IS NOT NULL
        GROUP BY target_id
        LIMIT ?`,
    )
    .all(scope, COMMITMENT_TRACKER_MAX_CONTACTS_PER_CYCLE) as ContactWalkRow[];

/** One contact's worth of work — gather engagements → fan-in wrap →
 *  producer. Exposed for direct test access. */
export const processOneCommitmentTrackerContact = async (
  ctx: HousekeepingContext,
  scope: EnrichmentScope,
  contact: ContactWalkRow,
  forceLayer: ReturnType<typeof resolveCommitmentTrackerLayer>,
): Promise<{ produced: boolean; reason?: 'no_meta' | 'no_email' | 'no_resolver' }> => {
  const resolve = ctx.resolveContactEngagements;
  if (resolve === undefined) return { produced: false, reason: 'no_resolver' };
  const meta = parseContactMeta(contact.meta_json);
  if (meta === null) return { produced: false, reason: 'no_meta' };
  if (typeof meta.email !== 'string' || meta.email.length === 0) {
    return { produced: false, reason: 'no_email' };
  }
  const email = meta.email;
  const now = ctx.now();

  const args: EngagementsResolverArgs = {
    email,
    since: now - COMMITMENT_TRACKER_WINDOW_MS,
    authorship: ACCEPTED_AUTHORSHIP,
    lifecycle_state: ACCEPTED_LIFECYCLE,
    dedupe_acceptance: ACCEPTED_DEDUPE,
  };
  const result = resolve(args);
  const rows = result.engagements;

  // Fan-in PII wrap over the gathered rows BEFORE the LLM call (the
  // producer omits the single-record seed for exactly this reason). Fail-
  // open: no-op until engagement privacy schemas wire.
  const fanInCtx = wrapHousekeepingCtxForFanIn(ctx, scope, rows);

  const out = await processOneCommitmentTracker(fanInCtx, {
    rows,
    scope,
    target_id: contact.target_id,
    subject_email: email,
    ...(typeof meta.name === 'string' && meta.name.length > 0 ? { subject_name: meta.name } : {}),
    coverage: result.coverage,
    source_record_hash:
      typeof meta.snapshot_hash === 'string' && meta.snapshot_hash.length > 0
        ? meta.snapshot_hash
        : `commitment_tracker:${contact.target_id}`,
    as_of: now,
    now,
    forceLayer,
    event_at: typeof meta.snapshot_at === 'number' ? meta.snapshot_at : null,
  });

  // E3 — funnel the contact's CURRENT commitments to held commitment-propose
  // runs. Run EVERY cycle, NOT only on a fresh produce (codex HIGH): the funnel
  // dedups on commitment_id, so an already-proposed commitment is a cheap
  // ledger-probe skip — and a commitment produced while the fire runtime was
  // still down, or whose prior fire HARD-FAILED (the funnel released the claim),
  // gets retried here. Gating on `out.produced` would strand it: a dedup-hit
  // cycle writes nothing, so the produce path never revisits it, yet no claim
  // exists to block a re-proposal. Reading the fresh row + probing the ledger
  // each cycle is bounded (one indexed row read + O(1) PK probes per commitment)
  // and only runs once the AI-surface trust is promoted. Best-effort: the
  // enrichment row is already durable — a funnel failure must not unwind it.
  if (ctx.commitmentProposalFunnel !== undefined) {
    try {
      const commitments = readFreshCommitments(ctx, scope, contact.target_id);
      if (commitments.length > 0) {
        await ctx.commitmentProposalFunnel({ subject_email: email, commitments });
      }
    } catch {
      /* proposal funnel is best-effort — the produced row stands */
    }
  }
  return { produced: out.produced };
};

/** The cycle — walk every declared + WRITABLE contact scope, run each
 *  contact up to the per-cycle cap. */
export const runCommitmentTrackerCycle = async (
  ctx: HousekeepingContext,
): Promise<{ produced: number; skipped: number }> => {
  // Not wired (dbless / pre-wire) ⇒ the task no-ops.
  if (ctx.resolveContactEngagements === undefined) return { produced: 0, skipped: 0 };

  const forceLayer = resolveCommitmentTrackerLayer(ctx, ctx.trustStore);
  const registry = ctx.resolveVendorRegistry?.() ?? CONNECTION_VENDOR_ENTITIES;
  // Walk only scopes the topic can actually WRITE (codex MEDIUM): a candidate whose
  // upsert would reject AFTER the resolve + LLM call wastes tokens on an
  // un-persistable row. D-192 S4c3b relaxes the prior STATIC `valid_scopes`
  // intersection (which skipped every pack vendor) to the store's
  // `isScopeSupported` — true for the static valid_scopes AND for a pack
  // `crm_alias:'contact'` scope now writable via the live registry (S4b), so a
  // Dynamics (or any pack) contact scope is tracked, not skipped.
  const scopes = [...scopesForCrmAlias('contact', registry)].filter(
    (s) => ctx.enrichmentStore.isScopeSupported('commitment_tracker', s),
  );

  let produced = 0;
  let skipped = 0;
  // Per-CYCLE cap (codex MEDIUM) — bounds total LLM spend across ALL contact
  // scopes, not per-scope (500×N-vendors would blow the intended ceiling).
  let processed = 0;
  for (const scope of scopes) {
    if (processed >= COMMITMENT_TRACKER_MAX_CONTACTS_PER_CYCLE) break;
    // The `connection.api.<vendor>.<entity>` scopes `scopesForCrmAlias`
    // composes are platform-reference EnrichmentScopes by construction.
    const enrichmentScope = scope as EnrichmentScope;
    for (const contact of listContactTargetIds(ctx, scope)) {
      if (processed >= COMMITMENT_TRACKER_MAX_CONTACTS_PER_CYCLE) break;
      processed += 1;
      // Per-contact guard: one contact's resolve / LLM / upsert failure must
      // not abort the cross-vendor cycle.
      try {
        const out = await processOneCommitmentTrackerContact(ctx, enrichmentScope, contact, forceLayer);
        if (out.produced) produced += 1;
        else skipped += 1;
      } catch {
        skipped += 1;
      }
    }
  }
  return { produced, skipped };
};

export const commitmentTrackerTask: HousekeepingTaskInstance = {
  meta: {
    id: 'enrichment.commitment_tracker',
    description:
      'Extracts commitments people made from a contact\'s mail / CRM engagement bodies '
      + '(the D-192 email flagship extraction engine). Feeds the commitment-propose funnel.',
    interruptible: true,
    kind: 'enrichment',
    tags: computeHousekeepingMetaTags({
      def: ENRICHMENT_REGISTRY.commitment_tracker,
      isAiSurface: true,
    }),
  },
  topic: COMMITMENT_TRACKER_TOPIC,
  is_ai_surface: true,

  async step(
    ctx: HousekeepingContext,
    _cursor: HousekeepingCursor,
    _budget_ms: number,
  ): Promise<HousekeepingStepResult> {
    await runCommitmentTrackerCycle(ctx);
    return { status: 'complete', cursor: { kind: 'complete' } };
  },
};

/** D-139 § A.9.2b — the `out_of_band_engagement` task.
 *
 *  The last of the twelve D-139 topics to get a producer, because it is the
 *  only one whose inputs span three substrates: local mail, CRM engagements,
 *  and the deal's contact fan-out. It therefore does NOT ride
 *  `buildRecordAggregateTask` — that shell exists for kernels shaped
 *  `{rows, coverage, now} → {value, coverage}`, and forcing this one through
 *  it would mean optional hooks every other caller pays for.
 *
 *  Shape: build the outbound-mail index ONCE per cycle, then per deal gather
 *  its CRM email rows (slice 2's record resolver) plus its contacts'
 *  confidence, and run the kernel.
 *
 *  ⛔ WHY THIS TOPIC WAS BLOCKED, and what unblocked it: the kernel's
 *  quadruple fallback matches on `meta.subject_hash`, which NO reconciler
 *  wrote — so the matcher returned false on every real row and every mail the
 *  Message-ID path missed would have been reported as a CRM visibility gap.
 *  Both email reconcilers now stamp it via the shared `engagementSubjectHash`
 *  (ec8f55872), and the Message-ID index normalises bracketing on both sides.
 *  Wiring this before those two fixes would have shipped a producer whose
 *  headline claim — "your CRM is missing this work" — was false by
 *  construction.
 *
 *  Spec: D-139 § A.9.2b. */

import {
  ENRICHMENT_REGISTRY,
  computeHousekeepingMetaTags,
  type EnrichmentMeta,
  type EnrichmentScope,
  type EnrichmentTopic,
  type HousekeepingCursor,
  type HousekeepingStepResult,
} from '@recued/contracts';

import { enrichmentProducerAuthoredBy } from '../enrichment-producer.js';
import type { HousekeepingContext, HousekeepingTaskInstance } from '../registry.js';
import {
  assertCycleProducedSomething,
  listRecordTargetIds,
  parseMeta,
  resolveWalkableScopes,
  type CycleOutcome,
} from './_record-aggregate-task.js';
import {
  computeOutOfBandEngagement,
  OUT_OF_BAND_WINDOW_MS,
} from './out-of-band-engagement.js';
import {
  buildContactConfidence,
  buildOutboundMailIndex,
  OUT_OF_BAND_CONTACTS_PER_DEAL,
  type OutboundMailIndex,
} from './out-of-band-gather.js';

export const OUT_OF_BAND_TOPIC: EnrichmentTopic = 'out_of_band_engagement';
export const OUT_OF_BAND_AUTHORED_BY = enrichmentProducerAuthoredBy(OUT_OF_BAND_TOPIC);

/** Deals walked per cycle. Deterministic and zero-token, so this bounds
 *  cycle wall-clock rather than spend. */
export const OUT_OF_BAND_MAX_DEALS_PER_CYCLE = 500;

/** One deal's worth of work. Exported for direct test access. */
export const processOneOutOfBandDeal = (
  ctx: HousekeepingContext,
  mailIndex: OutboundMailIndex,
  scope: EnrichmentScope,
  record: { target_id: string; meta_json: string | null },
): boolean => {
  const resolve = ctx.resolveRecordEngagements;
  const listContacts = ctx.listDealContacts;
  if (resolve === undefined || listContacts === undefined) return false;
  const now = ctx.now();

  // `cap + 1` so a truncated contact set is DETECTABLE rather than silently
  // partial — a deal whose contacts overflow would otherwise under-report
  // its gap and look like good news.
  const contacts = listContacts(
    record.target_id,
    OUT_OF_BAND_CONTACTS_PER_DEAL + 1,
  );
  const truncated = contacts.length > OUT_OF_BAND_CONTACTS_PER_DEAL;
  const contactEmails = truncated
    ? contacts.slice(0, OUT_OF_BAND_CONTACTS_PER_DEAL)
    : contacts;

  const resolved = resolve({
    scope,
    target_id: record.target_id,
    since: now - OUT_OF_BAND_WINDOW_MS,
  });
  // The kernel filters entity + direction itself; handing it the deal's
  // whole engagement set keeps that decision in one place.
  const crm_email_rows = resolved.engagements;

  // Mail addressed to ANY of the deal's contacts. Deduped by identity —
  // one mail to three deal contacts is one mail, not three.
  const seen = new Set<string>();
  const mail_rows = [];
  for (const email of contactEmails) {
    for (const mail of mailIndex.get(email) ?? []) {
      const key = `${mail.message_id ?? ''}\x1f${mail.from_email}\x1f${mail.sent_at}\x1f${mail.subject_hash}`;
      if (seen.has(key)) continue;
      seen.add(key);
      mail_rows.push(mail);
    }
  }

  const coverage = truncated
    ? {
        ...resolved.coverage,
        // ⚠ An honest degradation rather than a silently partial answer.
        // `sources_degraded` is what § A.9.3 exists for: the agent reading
        // this row needs to know the count was computed over a capped
        // contact set, or it will read a low number as "no gap".
        sources_degraded: [
          ...resolved.coverage.sources_degraded,
          {
            source: scope,
            reason: 'association_rescan_pending' as const,
            since: now,
            detail: `deal contact set truncated at ${OUT_OF_BAND_CONTACTS_PER_DEAL}`,
          },
        ],
      }
    : resolved.coverage;

  const out = computeOutOfBandEngagement({
    mail_rows,
    crm_email_rows,
    contact_confidence: buildContactConfidence(ctx.db, {
      deal_target_id: record.target_id,
      contact_emails: contactEmails,
    }),
    coverage,
    now,
  });

  const meta = parseMeta(record.meta_json);
  ctx.enrichmentStore.upsert({
    topic: OUT_OF_BAND_TOPIC,
    scope,
    target_id: record.target_id,
    value: out.value as unknown as Record<string, unknown>,
    authored_by: OUT_OF_BAND_AUTHORED_BY,
    event_at: now,
    ...(meta !== null ? { meta: meta as EnrichmentMeta } : {}),
  });
  return true;
};

export const runOutOfBandCycle = (ctx: HousekeepingContext): CycleOutcome => {
  const scopes = resolveWalkableScopes(ctx, OUT_OF_BAND_TOPIC, 'deal');
  // ⛔ Both deps required. Without the contact reader every deal resolves an
  // EMPTY contact set, every mail lookup misses, and the producer writes
  // `out_of_band_count: 0` — "no visibility gap" asserted from having not
  // looked. Exactly the fabrication shape this whole arc removed.
  if (scopes === null || ctx.listDealContacts === undefined) {
    return { produced: 0, skipped: 0, failed: 0, firstError: null };
  }

  // ⛔ ONCE PER CYCLE. `data.mail` is one table per enrolled account, so a
  // per-deal build would repeat the same scan for every deal on the portal.
  const mailIndex = buildOutboundMailIndex(ctx.db, {
    since: ctx.now() - OUT_OF_BAND_WINDOW_MS,
  });

  let produced = 0;
  let skipped = 0;
  let failed = 0;
  let firstError: string | null = null;
  let processed = 0;
  for (const scope of scopes) {
    if (processed >= OUT_OF_BAND_MAX_DEALS_PER_CYCLE) break;
    const remaining = OUT_OF_BAND_MAX_DEALS_PER_CYCLE - processed;
    for (const record of listRecordTargetIds(ctx, scope, remaining)) {
      processed += 1;
      try {
        if (processOneOutOfBandDeal(ctx, mailIndex, scope, record)) produced += 1;
        else skipped += 1;
      } catch (error) {
        failed += 1;
        if (firstError === null) {
          firstError = error instanceof Error ? error.message : String(error);
        }
      }
    }
  }
  return { produced, skipped, failed, firstError };
};

export const outOfBandEngagementTask: HousekeepingTaskInstance = {
  meta: {
    id: `enrichment.${OUT_OF_BAND_TOPIC}`,
    description:
      'Outbound mail to a deal\'s contacts that never landed as a CRM engagement — the visibility gap. Deterministic; zero token cost.',
    interruptible: true,
    kind: 'enrichment',
    tags: computeHousekeepingMetaTags({
      def: ENRICHMENT_REGISTRY.out_of_band_engagement,
      isAiSurface: false,
    }),
  },
  topic: OUT_OF_BAND_TOPIC,
  is_ai_surface: false,

  // eslint-disable-next-line @typescript-eslint/require-await
  async step(
    ctx: HousekeepingContext,
    _cursor: HousekeepingCursor,
    _budget_ms: number,
  ): Promise<HousekeepingStepResult> {
    assertCycleProducedSomething(`enrichment.${OUT_OF_BAND_TOPIC}`, runOutOfBandCycle(ctx));
    return { status: 'complete', cursor: { kind: 'complete' } };
  },
};

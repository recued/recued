/** D-134 Phase 2 — declarative housekeeping registration tables.
 *
 *  Replaces the ~85-line block of manual `registerHousekeepingTask(...)`
 *  calls in `bin.ts` with two arrays:
 *
 *    - `STANDALONE_TASKS` — pre-built `HousekeepingTaskInstance`
 *      instances. The bin iterates and calls `registerHousekeepingTask`
 *      on each. Covers the four deterministic core tasks plus every
 *      standalone enrichment task (Shape B derived-entity, connection-
 *      scope trio, drift signal).
 *
 *    - `PER_RECORD_PRODUCERS` — `(producer, walker_kind)` pairs for
 *      enrichment producers that ride the per-record harness. The bin
 *      maps `walker_kind` to a concrete walker (mail-thread / mail-body
 *      / contact / calendar) at construction time and silently skips
 *      entries whose walker is unavailable (test scaffolding without a
 *      contact store still ships every other producer unaffected).
 *
 *  Adding a producer post-D-134 is:
 *    1. Create the producer file under `producers/<topic>.ts`.
 *    2. Add a line to one of the arrays below.
 *    3. Add `tags: [...]` to the registry entry in
 *       `packages/contracts/src/enrichment-registry.ts`.
 *    4. Test file as usual.
 *
 *  No `bin.ts` edit. The chip filter automatically picks up the new
 *  tag the next time the panel renders.
 *
 *  Spec: `docs/d-134-spec.md` §A.3. */

import { auditCompactionTask } from './tasks/audit-compaction.js';
import { cacheEvictionBeyondTtlTask } from './tasks/cache-eviction-beyond-ttl.js';
import { linkDiscoveryTask } from './tasks/link-discovery.js';
import { deterministicRiskPatternsTask } from './tasks/deterministic-risk-patterns.js';
import { lifecycleQueueDrainTask } from './tasks/lifecycle-queue-drain.js';
import { llmResultCacheGcTask } from './tasks/llm-result-cache-gc.js';

import { confidenceDriftSignalTask } from './producers/confidence-drift-signal.js';
import { topicClusterTask } from './producers/topic_cluster.js';
import { workingGroupTask } from './producers/working_group.js';
import { organizationTask } from './producers/organization.js';
import { semanticClusterTask } from './producers/semantic_cluster.js';
import { connectionHealthTrendTask } from './producers/connection_health_trend.js';
import { connectionLastUsedPatternTask } from './producers/connection_last_used_pattern.js';
import { connectionOptimalBatchSizeTask } from './producers/connection_optimal_batch_size.js';
import { attributionSignalTask } from './producers/attribution-signal.js';
import { engagementScorePerContactTask } from './producers/engagement-score-per-contact.js';
import { lifecycleStageInferredTask } from './producers/lifecycle-stage-inferred.js';
import { lifecycleStageInferredSalesforceTask } from './producers/lifecycle-stage-inferred-salesforce.js';
import { commitmentTrackerTask } from './engagement-aggregates/commitment-tracker-task.js';
import { sourceFreshnessDegradationTask } from './producers/source-freshness-degradation.js';

import { threadSignalsProducer } from './producers/thread-signals.js';
import { summaryProducer } from './producers/summary.js';
import { purposeProducer } from './producers/purpose.js';
import { actionItemsProducer } from './producers/action-items.js';
import { embeddingProducer } from './producers/embedding.js';
import { behavioralSignatureProducer } from './producers/behavioral_signature.js';
import { replyPatternsProducer } from './producers/reply_patterns.js';
import { attendeePatternsProducer } from './producers/attendee_patterns.js';
import { meetingFrequencyProducer } from './producers/meeting_frequency.js';
import { companyProducer } from './producers/company.js';
import { roleProducer } from './producers/role.js';
import { preferredChannelByContactProducer } from './producers/preferred-channel-by-contact.js';
import { outboundCommitmentOverdueCountProducer } from './producers/outbound-commitment-overdue-count.js';
import { commitmentImbalanceProducer } from './producers/commitment-imbalance.js';
import { commitmentFollowthroughScoreProducer } from './producers/commitment-followthrough-score.js';
import { taskCompletionVelocityProducer } from './producers/task-completion-velocity.js';
import { commitmentReliabilityBandProducer } from './producers/commitment-reliability-band.js';
import { openLoopPressureProducer } from './producers/open-loop-pressure.js';
import { openLoopPressureProjectProducer } from './producers/open-loop-pressure-project.js';
import { noteRelevanceDecayProducer } from './producers/note-relevance-decay.js';
import { taskDuplicateCandidateProducer } from './producers/task-duplicate-candidate.js';
import { projectNextActionGapProducer } from './producers/project-next-action-gap.js';
import { projectStallSignalProducer } from './producers/project-stall-signal.js';
import { projectVelocityProducer } from './producers/project-velocity.js';
import { taskSignalDensityPerThreadProducer } from './producers/task-signal-density-per-thread.js';
import { preparationNotesProducer } from './producers/preparation_notes.js';
import { relatedThreadsProducer } from './producers/related_threads.js';
import { transcriptProducer } from './producers/transcript.js';
import { captionProducer } from './producers/caption.js';
import { extractedTextProducer } from './producers/extracted_text.js';

import type { HousekeepingTaskInstance } from './registry.js';
import type { HousekeepingEnrichmentProducer } from './enrichment-producer.js';

/** Standalone tasks — registered directly via
 *  `registerHousekeepingTask(task)`. Order matches the housekeeping
 *  panel's render order (core first, then enrichment). */
export const STANDALONE_TASKS: ReadonlyArray<HousekeepingTaskInstance> = [
  // ── Core deterministic maintenance (D-123 P3) ────────────
  auditCompactionTask,
  cacheEvictionBeyondTtlTask,
  linkDiscoveryTask,
  deterministicRiskPatternsTask,
  // ── D-145 § A.7.10 LLM result cache GC (PA9.6 follow-on) ──
  // Sweeps `llm_result_cache` for rows whose `result_path` no longer
  // resolves to an enrichment row. The lookup hot-path lazy-deletes
  // on access, but one-shot cache entries the engine never re-queries
  // would otherwise accumulate. No-op when the cache store isn't
  // wired (dbless harnesses, fresh boots before PA9.6 substrate).
  llmResultCacheGcTask,
  // ── D-136 P5b lifecycle queue drain ──────────────────────
  lifecycleQueueDrainTask,
  // ── D-133 confidence drift detection ────────────────────
  confidenceDriftSignalTask,
  // ── D-131 Shape B derived-entity producers ──────────────
  topicClusterTask,
  workingGroupTask,
  organizationTask,
  semanticClusterTask,
  // ── D-131 connection-scope trio ─────────────────────────
  connectionHealthTrendTask,
  connectionLastUsedPatternTask,
  connectionOptimalBatchSizeTask,
  // ── D-129 P6 HubSpot-flavored topics ────────────────────
  attributionSignalTask,
  engagementScorePerContactTask,
  lifecycleStageInferredTask,
  // ── D-130 P6 Salesforce-flavored lifecycle topic ────────
  // (`attribution_signal` + `engagement_score_per_contact` are
  // cross-vendor — HubSpot tasks above walk both scopes per
  // D-130 P6 spec § A.6 widening.)
  lifecycleStageInferredSalesforceTask,
  // ── D-192 email flagship — commitment extraction (cross-vendor,
  // declaration-driven contact walk; self-checks ctx.resolveContactEngagements) ──
  commitmentTrackerTask,
  // ── D-145 PA9 standalone — per-Source health (scenario id) ──
  // Per-Source row keyed on `source_registry.id`. Reads source_registry
  // + connections + work-entity tables; engine consumes for omission
  // decisions on degraded Sources. Gated on `ctx.workEntityStore`
  // presence at cycle time (the task self-checks rather than the
  // walker registry gating it the way per-record producers are).
  sourceFreshnessDegradationTask,
];

/** Walker discriminator for per-record producers. The bin maps each
 *  kind to a concrete walker instance:
 *    - `mail-thread`  → body-blind mail walker (thread-level fields only)
 *    - `mail-body`    → body-aware mail walker (re-derives on body change)
 *    - `contact`      → contact-scope walker
 *    - `calendar`     → calendar-scope walker
 *    - `file`         → file-scope walker (`data.file.*` records)
 *    - `note`         → note-scope walker (D-145 PA9; reads `data_note`
 *                       monotonic id-cursor for `note_relevance_decay`)
 *    - `task`         → task-scope walker (D-145 PA9; reads `data_task`
 *                       monotonic id-cursor for `task_duplicate_candidate`)
 *    - `project`      → project-scope walker (D-145 PA9; reads
 *                       `data_project` monotonic id-cursor for
 *                       `project_next_action_gap` + `project_stall_signal`;
 *                       producers read child task / note / commitment
 *                       timestamps directly via `ctx.db`)
 *
 *  Closed list — adding a new kind requires updating the bin's walker
 *  map exhaustively. */
export type PerRecordWalkerKind =
  | 'mail-thread'
  | 'mail-body'
  | 'contact'
  | 'calendar'
  | 'file'
  | 'note'
  | 'task'
  | 'project';

export interface PerRecordProducerEntry {
  producer: HousekeepingEnrichmentProducer<unknown>;
  walker_kind: PerRecordWalkerKind;
  /** D-145 PA9 — multi-scope task-id substrate. Optional suffix
   *  threaded into `buildEnrichmentProducerTask` so a single
   *  `EnrichmentTopic` can be served by N producers across N
   *  `source_scope` values without colliding on the
   *  `housekeeping_state` row key (`enrichment.${topic}`).
   *
   *  Convention: equal to `producer.source_scope`. Only set when
   *  another entry in this array shares the same `producer.topic`. The
   *  (topic, source_scope) ratchet across `PER_RECORD_PRODUCERS`
   *  asserts every multi-scope topic has unique scopes per producer. */
  task_id_suffix?: string;
}

/** Per-record enrichment producers — registered via
 *  `buildEnrichmentProducerTask({ producer, walker })`. The bin
 *  resolves `walker_kind` against its constructed walker registry +
 *  silently skips entries whose walker is unavailable (preserves the
 *  pre-D-134 nullness-guard for contact / calendar walkers).
 *
 *  Order is registration order — the bin's `clear()` then iterate
 *  pattern guards against drift between boots. */
export const PER_RECORD_PRODUCERS: ReadonlyArray<PerRecordProducerEntry> = [
  // mail-thread (body-blind)
  { producer: threadSignalsProducer as HousekeepingEnrichmentProducer<unknown>, walker_kind: 'mail-thread' },
  { producer: taskSignalDensityPerThreadProducer as HousekeepingEnrichmentProducer<unknown>, walker_kind: 'mail-thread' },
  // mail-body (body-aware)
  { producer: summaryProducer as HousekeepingEnrichmentProducer<unknown>, walker_kind: 'mail-body' },
  { producer: purposeProducer as HousekeepingEnrichmentProducer<unknown>, walker_kind: 'mail-body' },
  { producer: actionItemsProducer as HousekeepingEnrichmentProducer<unknown>, walker_kind: 'mail-body' },
  { producer: embeddingProducer as HousekeepingEnrichmentProducer<unknown>, walker_kind: 'mail-body' },
  // contact-scope
  { producer: behavioralSignatureProducer as HousekeepingEnrichmentProducer<unknown>, walker_kind: 'contact' },
  { producer: replyPatternsProducer as HousekeepingEnrichmentProducer<unknown>, walker_kind: 'contact' },
  { producer: attendeePatternsProducer as HousekeepingEnrichmentProducer<unknown>, walker_kind: 'contact' },
  { producer: meetingFrequencyProducer as HousekeepingEnrichmentProducer<unknown>, walker_kind: 'contact' },
  { producer: companyProducer as HousekeepingEnrichmentProducer<unknown>, walker_kind: 'contact' },
  { producer: roleProducer as HousekeepingEnrichmentProducer<unknown>, walker_kind: 'contact' },
  { producer: preferredChannelByContactProducer as HousekeepingEnrichmentProducer<unknown>, walker_kind: 'contact' },
  { producer: outboundCommitmentOverdueCountProducer as HousekeepingEnrichmentProducer<unknown>, walker_kind: 'contact' },
  { producer: commitmentImbalanceProducer as HousekeepingEnrichmentProducer<unknown>, walker_kind: 'contact' },
  { producer: commitmentFollowthroughScoreProducer as HousekeepingEnrichmentProducer<unknown>, walker_kind: 'contact' },
  { producer: commitmentReliabilityBandProducer as HousekeepingEnrichmentProducer<unknown>, walker_kind: 'contact' },
  { producer: openLoopPressureProducer as HousekeepingEnrichmentProducer<unknown>, walker_kind: 'contact' },
  { producer: taskCompletionVelocityProducer as HousekeepingEnrichmentProducer<unknown>, walker_kind: 'contact' },
  // calendar-scope
  { producer: preparationNotesProducer as HousekeepingEnrichmentProducer<unknown>, walker_kind: 'calendar' },
  { producer: relatedThreadsProducer as HousekeepingEnrichmentProducer<unknown>, walker_kind: 'calendar' },
  // file-scope
  { producer: transcriptProducer as HousekeepingEnrichmentProducer<unknown>, walker_kind: 'file' },
  { producer: captionProducer as HousekeepingEnrichmentProducer<unknown>, walker_kind: 'file' },
  { producer: extractedTextProducer as HousekeepingEnrichmentProducer<unknown>, walker_kind: 'file' },
  // note-scope
  { producer: noteRelevanceDecayProducer as HousekeepingEnrichmentProducer<unknown>, walker_kind: 'note' },
  // task-scope
  { producer: taskDuplicateCandidateProducer as HousekeepingEnrichmentProducer<unknown>, walker_kind: 'task' },
  // project-scope
  { producer: projectNextActionGapProducer as HousekeepingEnrichmentProducer<unknown>, walker_kind: 'project' },
  { producer: projectStallSignalProducer as HousekeepingEnrichmentProducer<unknown>, walker_kind: 'project' },
  { producer: projectVelocityProducer as HousekeepingEnrichmentProducer<unknown>, walker_kind: 'project' },
  // D-145 PA9 multi-scope task-id substrate — `open_loop_pressure`
  // already lands per-contact above (task id `enrichment.open_loop_pressure`
  // for back-compat with persisted state); the per-project companion
  // adds `task_id_suffix: 'project'` so its scheduler-level task id
  // becomes `enrichment.open_loop_pressure.project` and the two
  // producers don't collide on the `housekeeping_state` row. Storage
  // rows are already scope-separated via the `(topic, scope,
  // target_id, authored_by)` uniqueness gate.
  {
    producer: openLoopPressureProjectProducer as HousekeepingEnrichmentProducer<unknown>,
    walker_kind: 'project',
    task_id_suffix: 'project',
  },
];

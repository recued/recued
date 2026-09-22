/** D-123 — Housekeeping execution-mode public surface for `bin.ts`. */

export { ensureHousekeepingSchema } from './schema.js';
export {
  createHousekeepingConfigStore,
  type HousekeepingConfigStore,
  type HousekeepingConfigWriteInput,
} from './config-store.js';
export {
  createHousekeepingStateStore,
  type HousekeepingStateStore,
  type HousekeepingStateUpdate,
} from './state-store.js';
export {
  createHousekeepingRegistry,
  registerHousekeepingTask,
  unregisterHousekeepingTask,
  getHousekeepingTask,
  listHousekeepingTasks,
  topoSortHousekeepingTasks,
  clearDefaultHousekeepingRegistry,
  type HousekeepingRegistry,
  type HousekeepingTaskInstance,
  type HousekeepingContext,
  type HousekeepingAuditRow,
  type HousekeepingInvalidateHint,
  type HousekeepingInvalidateReason,
} from './registry.js';
export {
  createEngineBusySignal,
  type EngineBusySignal,
  type EngineBusySignalDeps,
} from './engine-busy-signal.js';
export {
  createHousekeepingInvalidator,
  type HousekeepingInvalidator,
  type HousekeepingInvalidatorDeps,
} from './invalidation.js';
export {
  createHousekeepingScheduler,
  shouldFireCycle,
  inCustomWindow,
  isEligibleForIdleCycle,
  type HousekeepingScheduler,
  type CreateHousekeepingSchedulerOptions,
} from './scheduler.js';

// D-123 Phase 3 — initial deterministic core task set. Each task
// is exported as a registered-shaped instance; bin.ts (P7) calls
// `registerHousekeepingTask` against each in turn before
// constructing the scheduler.
export {
  auditCompactionTask,
  AUDIT_COMPACTION_WINDOW_MS,
} from './tasks/audit-compaction.js';
export {
  cacheEvictionBeyondTtlTask,
} from './tasks/cache-eviction-beyond-ttl.js';
export {
  linkDiscoveryTask,
  linkDiscoveryAnnotationId,
  LINK_DISCOVERY_ANNOTATION_KEY,
  LINK_DISCOVERY_AUTHORED_BY,
  LINK_DISCOVERY_THRESHOLD,
  LINK_DISCOVERY_WINDOW_MS,
} from './tasks/link-discovery.js';
export {
  deterministicRiskPatternsTask,
  deterministicRiskAnnotationId,
  RISK_PATTERN_ANNOTATION_KEY,
  RISK_PATTERN_AUTHORED_BY,
  RISK_PATTERN_FAILURE_THRESHOLD,
  RISK_PATTERN_TARGET_COLLECTION,
  RISK_PATTERN_WINDOW_MS,
} from './tasks/deterministic-risk-patterns.js';

// D-123 Phase 4 — Enrichment producer harness + canary. Producers
// register through `buildEnrichmentProducerTask({ producer, walker })`
// just like core tasks do; bin.ts (P7) wires the source-walker
// registry against the live `CollectionRegistry`.
export {
  buildEnrichmentProducerTask,
  enrichmentProducerAuthoredBy,
  HOUSEKEEPING_AUTHORED_BY_PREFIX,
  HOUSEKEEPING_DEFAULT_BATCH_SIZE,
  HOUSEKEEPING_STALE_SWEEP_BATCH_SIZE,
  type BuildEnrichmentProducerTaskOptions,
  type EnrichmentProducerOutput,
  type HousekeepingEnrichmentProducer,
} from './enrichment-producer.js';
export {
  createMailSourceWalker,
  createCalendarSourceWalker,
  createFileSourceWalker,
  createContactSourceWalker,
  createNoteSourceWalker,
  createTaskSourceWalker,
  createProjectSourceWalker,
  createSourceWalkerRegistry,
  createTestSourceWalkerRegistry,
  hashMailRecordWithBody,
  hashCalendarRecord,
  hashFileRecord,
  hashContactRecord,
  hashNoteRecord,
  hashTaskRecord,
  hashProjectRecord,
  type AnySourceWalker,
  type CreateMailSourceWalkerOptions,
  type CreateCalendarSourceWalkerOptions,
  type SourceCollectionWalker,
  type SourceRecord,
  type SourceWalkerRegistry,
  type SourceWalkerDeps,
} from './source-walkers.js';
export {
  threadSignalsProducer,
  type ThreadSignalsValue,
} from './producers/thread-signals.js';
export { summaryProducer } from './producers/summary.js';
export { purposeProducer, PURPOSE_CATEGORIES, PURPOSE_CONTEXT, type PurposeCategory } from './producers/purpose.js';
export {
  actionItemsProducer,
  MAX_ITEMS_PER_BODY,
  type ActionItem,
  type ActionItemsValue,
} from './producers/action-items.js';
export {
  embeddingProducer,
  MAX_EMBED_INPUT_CHARS,
  vectorToBuffer,
} from './producers/embedding.js';
export {
  behavioralSignatureProducer,
  BEHAVIORAL_SIGNATURE_WINDOW_MS,
} from './producers/behavioral_signature.js';
export {
  replyPatternsProducer,
  REPLY_PATTERNS_WINDOW_MS,
  P95_MIN_SAMPLE_COUNT,
  percentile as nearestRankPercentile,
} from './producers/reply_patterns.js';
export {
  attendeePatternsProducer,
  ATTENDEE_PATTERNS_WINDOW_MS,
  MAX_TOP_CO_ATTENDEES,
} from './producers/attendee_patterns.js';
export {
  meetingFrequencyProducer,
  categorizeTrend as categorizeMeetingFrequencyTrend,
  MEETING_FREQUENCY_WINDOW_30D_MS,
  MEETING_FREQUENCY_WINDOW_90D_MS,
  TREND_MIN_COMBINED_SAMPLE,
  TREND_BASELINE_FLOOR_PER_MONTH,
  TREND_ACCEL_THRESHOLD,
  TREND_DECEL_THRESHOLD,
} from './producers/meeting_frequency.js';
export {
  preferredChannelByContactProducer,
  decidePreferredChannel,
  countMailMentionsInWindow as countMailMentionsForPreferredChannelInWindow,
  countCalendarMentionsInWindow as countCalendarMentionsForPreferredChannelInWindow,
  PREFERRED_CHANNEL_WINDOW_MS,
  PREFERRED_CHANNEL_SAMPLE_FLOOR,
  PREFERRED_CHANNEL_DOMINANT_THRESHOLD,
  type ChannelKey as PreferredChannelKey,
} from './producers/preferred-channel-by-contact.js';
export {
  outboundCommitmentOverdueCountProducer,
  countOutboundCommitmentsForContact,
  type CommitmentCountRow as OutboundCommitmentOverdueCountRow,
} from './producers/outbound-commitment-overdue-count.js';
export {
  commitmentImbalanceProducer,
  decideCommitmentImbalanceSignal,
  countCommitmentsByDirectionForContact,
  COMMITMENT_IMBALANCE_WINDOW_MS,
  COMMITMENT_IMBALANCE_SAMPLE_FLOOR,
  COMMITMENT_IMBALANCE_DOMINANT_RATIO,
  type CommitmentDirectionCounts,
} from './producers/commitment-imbalance.js';
export {
  commitmentFollowthroughScoreProducer,
  computeFollowthroughConfidence,
  countTerminalCommitmentsForContact,
  COMMITMENT_FOLLOWTHROUGH_SCORE_WINDOW_MS,
  COMMITMENT_FOLLOWTHROUGH_SCORE_SAMPLE_FLOOR,
  COMMITMENT_FOLLOWTHROUGH_SCORE_CONFIDENCE_SATURATION,
  COMMITMENT_FOLLOWTHROUGH_SCORE_PRODUCER_VERSION_HASH,
  type FollowthroughTerminalCounts,
} from './producers/commitment-followthrough-score.js';
export {
  commitmentReliabilityBandProducer,
  decideCommitmentReliabilityBand,
  readFollowthroughScoreForContact,
  COMMITMENT_RELIABILITY_BAND_RELIABLE_THRESHOLD,
  COMMITMENT_RELIABILITY_BAND_MIXED_THRESHOLD,
  COMMITMENT_RELIABILITY_BAND_SAMPLE_FLOOR,
  type FollowthroughScoreRead,
} from './producers/commitment-reliability-band.js';
export {
  openLoopPressureProducer,
  aggregateOpenCommitmentsForContact,
  aggregateOpenTasksForContact,
  aggregateUnreadMailsForContact,
  computeAgeDays,
  computePressureScore,
  OPEN_LOOP_PRESSURE_SATURATION_DAYS,
  type PendingItemAggregate,
} from './producers/open-loop-pressure.js';
export {
  openLoopPressureProjectProducer,
  aggregateOpenCommitmentsForProject,
  aggregateOpenTasksForProject,
} from './producers/open-loop-pressure-project.js';
export {
  taskCompletionVelocityProducer,
  computeVelocityConfidence,
  countCompletedTasksForContact,
  TASK_COMPLETION_VELOCITY_WINDOW_DAYS,
  TASK_COMPLETION_VELOCITY_WINDOW_MS,
  TASK_COMPLETION_VELOCITY_SAMPLE_FLOOR,
  TASK_COMPLETION_VELOCITY_CONFIDENCE_SATURATION,
  TASK_COMPLETION_VELOCITY_PRODUCER_VERSION_HASH,
  type CompletedTaskCounts,
} from './producers/task-completion-velocity.js';
export {
  projectVelocityProducer,
  computeProjectVelocityConfidence,
  countCompletedTasksForProject,
  PROJECT_VELOCITY_WINDOW_DAYS,
  PROJECT_VELOCITY_WINDOW_MS,
  PROJECT_VELOCITY_SAMPLE_FLOOR,
  PROJECT_VELOCITY_CONFIDENCE_SATURATION,
  PROJECT_VELOCITY_PRODUCER_VERSION_HASH,
  type ProjectCompletedTaskCounts,
} from './producers/project-velocity.js';
export {
  noteRelevanceDecayProducer,
  computeNoteDecayScore,
  readLatestUserAccessForNote,
  NOTE_RELEVANCE_DECAY_WINDOW_MS,
  NOTE_RELEVANCE_USER_ACCESS_KINDS,
} from './producers/note-relevance-decay.js';
export {
  taskDuplicateCandidateProducer,
  computeDedupConfidence,
  matchTaskAgainstCrossSourceCandidates,
  normalizeTaskTitle,
  selectStrongestBand,
  TASK_DUPLICATE_CANDIDATE_LIMIT,
  TASK_DUPLICATE_EXACT_DUE_WINDOW_MS,
  TASK_DUPLICATE_PROBABLE_DUE_WINDOW_MS,
  TASK_DUPLICATE_LOW_PREFIX_LEN,
  type DedupeFields as TaskDedupeFields,
} from './producers/task-duplicate-candidate.js';
export {
  projectNextActionGapProducer,
  computeGapSignals,
  countOpenTasksForProject,
  countPendingCommitmentsForProject,
  countRecentNotesForProject,
  PROJECT_NEXT_ACTION_GAP_RECENT_NOTE_WINDOW_MS,
  PROJECT_NEXT_ACTION_GAP_SIGNALS,
  type ProjectNextActionGapSignal,
} from './producers/project-next-action-gap.js';
export {
  projectStallSignalProducer,
  composeStallSignals,
  effectiveLastActivity,
  maxTaskActivityForProject,
  maxCommitmentActivityForProject,
  maxNoteActivityForProject,
  resolveProducerVersionHash as resolveProjectStallSignalProducerVersionHash,
  PROJECT_STALL_SIGNAL_DEFAULT_WINDOW_DAYS,
  PROJECT_STALL_SIGNAL_WINDOW_MS,
  PROJECT_STALL_SIGNAL_TOKENS,
  type ProjectStallSignalToken,
} from './producers/project-stall-signal.js';
export {
  taskSignalDensityPerThreadProducer,
  computeTaskSignalDensity,
  countMailSiblingsInThread,
  countTasksLinkedToThread,
  threadIdOfMail,
} from './producers/task-signal-density-per-thread.js';
export {
  TunableParamInvalidError,
  canonicalizeEffectiveParams,
  computeTopicTunableParamsHash,
  createTunableParamsStore,
  getDeclaredTunableParamSpec,
  getDeclaredTunableParams,
  validateTunableParamWrite,
  type TunableParamsByTopic,
  type TunableParamsStore,
} from './tunable-params-store.js';
export {
  createTunableParamsAccessor,
  getTunableEnum,
  getTunableNumber,
  type TunableParamsAccessor,
} from './tunable-params-accessor.js';
export {
  composeEnrichmentPath,
  createLlmResultCacheStore,
  hashEnrichmentResult,
  hashLlmInput,
  parseEnrichmentPath,
  readEnrichmentValueFromPath,
  type LlmResultCacheEntry,
  type LlmResultCacheRow,
  type LlmResultCacheStats,
  type LlmResultCacheStore,
  type LlmResultCacheTopicStats,
  type ParsedEnrichmentPath,
} from './llm-result-cache-store.js';
export {
  sourceFreshnessDegradationTask,
  sourceFreshnessDegradationTokenEstimate,
  sourceFreshnessDegradationScopeReadDeclaration,
  runSourceFreshnessDegradationCycle,
  sweepStaleSourceFreshnessRows,
  detectDegradationReasons,
  reasonsFromConnectionHealth,
  parseConnectionHealth,
  parseConnectionSourceRef,
  appendUniqueReason,
  computeLastSeenAtForSource,
  findConnectionByName,
  getConnectionByKindAndName,
  SOURCE_FRESHNESS_DEGRADATION_AUTHORED_BY,
  SOURCE_FRESHNESS_DEGRADATION_TOPIC,
  SOURCE_FRESHNESS_DEGRADATION_TOKEN_ESTIMATE,
  SOURCE_FRESHNESS_DEGRADATION_MAX_SOURCES,
  type ConnectionLookupRow as SourceFreshnessConnectionLookupRow,
  type ParsedConnectionSourceRef,
} from './producers/source-freshness-degradation.js';
export {
  companyProducer,
  domainToCompanyName,
  extractDomain as extractContactEmailDomain,
  FREE_MAIL_DOMAINS,
  MAX_COMPANY_NAME_CHARS,
  MIN_BODY_CHARS as COMPANY_MIN_BODY_CHARS,
  CONFIDENCE_FREE_MAIL as COMPANY_CONFIDENCE_FREE_MAIL,
  CONFIDENCE_DOMAIN_ONLY as COMPANY_CONFIDENCE_DOMAIN_ONLY,
  CONFIDENCE_SIGNATURE_PARSE as COMPANY_CONFIDENCE_SIGNATURE_PARSE,
} from './producers/company.js';
export {
  roleProducer,
  categorizeRole,
  MAX_TITLE_CHARS as ROLE_MAX_TITLE_CHARS,
  ROLE_MIN_BODY_CHARS,
  ROLE_CONFIDENCE_SIGNATURE_PARSE,
} from './producers/role.js';
export {
  preparationNotesProducer,
  composeCorpus as composePreparationNotesCorpus,
  extractAttendeeEmails as extractPreparationNotesAttendeeEmails,
  PREPARATION_NOTES_MIN_CORPUS_CHARS,
  PREPARATION_NOTES_TOKEN_ESTIMATE,
  PREPARATION_NOTES_CONFIDENCE,
  PREPARATION_NOTES_PAST_GRACE_MS,
  PREPARATION_NOTES_MAX_SNIPPETS_PER_PARTICIPANT,
  PREPARATION_NOTES_MAX_CHARS_PER_SNIPPET,
  PREPARATION_NOTES_MAIL_LOOKBACK_MS,
} from './producers/preparation_notes.js';
export {
  relatedThreadsProducer,
  extractAttendeeEmails as extractRelatedThreadsAttendeeEmails,
  findCandidateThreads as findRelatedThreadCandidates,
  partitionDeterministic as partitionRelatedThreadCandidates,
  composeTieBreakCorpus as composeRelatedThreadsTieBreakCorpus,
  RELATED_THREADS_TOKEN_ESTIMATE,
  RELATED_THREADS_CONFIDENCE,
  RELATED_THREADS_PAST_GRACE_MS,
  RELATED_THREADS_MAIL_LOOKBACK_MS,
  RELATED_THREADS_MAX_CANDIDATES,
  MAX_RELATED_THREADS,
  RELATED_THREADS_MIN_DETERMINISTIC_MESSAGES,
  type CandidateThread,
} from './producers/related_threads.js';
export { transcriptProducer } from './producers/transcript.js';
export { captionProducer } from './producers/caption.js';
export { extractedTextProducer } from './producers/extracted_text.js';
export {
  confidenceDriftSignalTask,
  driftTransitionFires,
  computeWindowsForTopic,
  processOneTopic as processOneConfidenceDriftTopic,
  MIN_SAMPLE_COUNT_RECENT,
  MIN_SAMPLE_COUNT_BASELINE,
  RECENT_WINDOW_MS as DRIFT_RECENT_WINDOW_MS,
  BASELINE_WINDOW_MS as DRIFT_BASELINE_WINDOW_MS,
  CONFIDENCE_DRIFT_AUTHORED_BY,
  CONFIDENCE_DRIFT_TOPIC,
  // D-136 P4 — closed-list helper exposed for unit tests of the
  // drift-as-input substrate.
} from './producers/confidence-drift-signal.js';
export {
  workingGroupTask,
  workingGroupTokenEstimate,
  workingGroupScopeReadDeclaration,
  runWorkingGroupCycle,
  scanRecentEvents as scanRecentCalendarEventsForWorkingGroup,
  groupByAttendeeSet,
  filterAndCapGroups,
  assembleGroup as assembleWorkingGroup,
  sweepStaleGroups as sweepStaleWorkingGroups,
  extractParticipantSet,
  composeAttendeeKey,
  deriveDerivedEntityId as deriveWorkingGroupId,
  WORKING_GROUP_AUTHORED_BY,
  WORKING_GROUP_TOPIC,
  CALENDAR_LOOKBACK_MS as WORKING_GROUP_CALENDAR_LOOKBACK_MS,
  MAX_EVENTS_SCANNED as WORKING_GROUP_MAX_EVENTS_SCANNED,
  MAX_GROUPS as WORKING_GROUP_MAX_GROUPS,
  MIN_ATTENDEES_PER_EVENT as WORKING_GROUP_MIN_ATTENDEES_PER_EVENT,
  MIN_RECURRENCE_PER_GROUP as WORKING_GROUP_MIN_RECURRENCE_PER_GROUP,
  ID_HASH_PREFIX_LEN as WORKING_GROUP_ID_HASH_PREFIX_LEN,
  TOKEN_ESTIMATE_PER_CYCLE as WORKING_GROUP_TOKEN_ESTIMATE,
  type CandidateGroup as WorkingGroupCandidate,
} from './producers/working_group.js';
export {
  topicClusterTask,
  topicClusterTokenEstimate,
  topicClusterScopeReadDeclaration,
  runTopicClusterCycle,
  scanRecentMail as scanRecentMailForTopicCluster,
  groupByThread as groupMailByThread,
  clusterThreads,
  capClusters,
  pickThemeTokens,
  composeLabellingCorpus as composeTopicClusterCorpus,
  deriveDerivedEntityId as deriveTopicClusterId,
  assembleCluster as assembleTopicCluster,
  sweepStaleClusters as sweepStaleTopicClusters,
  resolveTopicClusterLayer,
  normaliseSubject,
  tokeniseSubject,
  jaccard,
  trimTopicName,
  TOPIC_CLUSTER_AUTHORED_BY,
  TOPIC_CLUSTER_TOPIC,
  CONFIDENCE_TOPIC_CLUSTER,
  TOKEN_ESTIMATE_PER_CYCLE as TOPIC_CLUSTER_TOKEN_ESTIMATE,
  MAIL_LOOKBACK_MS as TOPIC_CLUSTER_MAIL_LOOKBACK_MS,
  MAX_MESSAGES_SCANNED as TOPIC_CLUSTER_MAX_MESSAGES_SCANNED,
  MAX_CLUSTERS as TOPIC_CLUSTER_MAX_CLUSTERS,
  MIN_THREADS_PER_CLUSTER as TOPIC_CLUSTER_MIN_THREADS_PER_CLUSTER,
  JACCARD_THRESHOLD as TOPIC_CLUSTER_JACCARD_THRESHOLD,
  THEME_TOKEN_COUNT as TOPIC_CLUSTER_THEME_TOKEN_COUNT,
  ID_HASH_PREFIX_LEN as TOPIC_CLUSTER_ID_HASH_PREFIX_LEN,
  type ThreadAtom as TopicClusterThreadAtom,
  type ProducedCluster as ProducedTopicCluster,
} from './producers/topic_cluster.js';
export {
  organizationTask,
  organizationTokenEstimate,
  organizationScopeReadDeclaration,
  runOrganizationCycle,
  scanRecentContacts as scanRecentContactsForOrganization,
  groupContactsByDomain,
  filterAndCapOrgs,
  assembleOrg as assembleOrganization,
  sweepStaleOrgs as sweepStaleOrganizations,
  deriveDerivedEntityId as deriveOrganizationId,
  ORGANIZATION_AUTHORED_BY,
  ORGANIZATION_TOPIC,
  CONTACT_LOOKBACK_MS as ORGANIZATION_CONTACT_LOOKBACK_MS,
  MAX_CONTACTS_SCANNED as ORGANIZATION_MAX_CONTACTS_SCANNED,
  MAX_ORGS as ORGANIZATION_MAX_ORGS,
  MIN_CONTACTS_PER_ORG as ORGANIZATION_MIN_CONTACTS_PER_ORG,
  ID_HASH_PREFIX_LEN as ORGANIZATION_ID_HASH_PREFIX_LEN,
  TOKEN_ESTIMATE_PER_CYCLE as ORGANIZATION_TOKEN_ESTIMATE,
  type CandidateOrg as OrganizationCandidate,
} from './producers/organization.js';
export {
  semanticClusterTask,
  semanticClusterTokenEstimate,
  semanticClusterScopeReadDeclaration,
  runSemanticClusterCycle,
  scanEmbeddings as scanEmbeddingsForSemanticCluster,
  pickDominantModelGroup as pickDominantModelGroupForSemanticCluster,
  clusterByCosineSimilarity,
  capClusters as capSemanticClusters,
  assembleCluster as assembleSemanticCluster,
  sweepStaleClusters as sweepStaleSemanticClusters,
  deriveDerivedEntityId as deriveSemanticClusterId,
  cosineSimilarity,
  decodeVector as decodeSemanticClusterVector,
  encodeCentroid as encodeSemanticClusterCentroid,
  computeCentroid as computeSemanticClusterCentroid,
  avgIntraSimilarity,
  SEMANTIC_CLUSTER_AUTHORED_BY,
  SEMANTIC_CLUSTER_TOPIC,
  COSINE_THRESHOLD as SEMANTIC_CLUSTER_COSINE_THRESHOLD,
  MAX_EMBEDDINGS_SCANNED as SEMANTIC_CLUSTER_MAX_EMBEDDINGS_SCANNED,
  MAX_CLUSTERS as SEMANTIC_CLUSTER_MAX_CLUSTERS,
  MIN_MAILS_PER_CLUSTER as SEMANTIC_CLUSTER_MIN_MAILS_PER_CLUSTER,
  ID_HASH_PREFIX_LEN as SEMANTIC_CLUSTER_ID_HASH_PREFIX_LEN,
  TOKEN_ESTIMATE_PER_CYCLE as SEMANTIC_CLUSTER_TOKEN_ESTIMATE,
  type ScannedEmbedding as SemanticClusterScannedEmbedding,
  type CandidateCluster as SemanticClusterCandidate,
} from './producers/semantic_cluster.js';
export {
  connectionHealthTrendTask,
  connectionHealthTrendTokenEstimate,
  connectionHealthTrendScopeReadDeclaration,
  runConnectionHealthTrendCycle,
  scanEnrolledConnections,
  collectActivitiesForConnection,
  computeHealthTrendValue,
  sweepStaleHealthTrendRows,
  composeFreshKey as composeConnectionHealthTrendFreshKey,
  percentile as connectionHealthTrendPercentile,
  CONNECTION_HEALTH_TREND_AUTHORED_BY,
  CONNECTION_HEALTH_TREND_TOPIC,
  CONNECTION_HEALTH_TREND_WINDOW_MS,
  CONNECTION_HEALTH_TREND_P50_MIN_SAMPLE_COUNT,
  CONNECTION_HEALTH_TREND_P95_MIN_SAMPLE_COUNT,
  CONNECTION_HEALTH_TREND_TOKEN_ESTIMATE,
  MAX_CONNECTIONS_SCANNED as CONNECTION_HEALTH_TREND_MAX_CONNECTIONS_SCANNED,
  SCOPE_FOR_CONNECTION_KIND as CONNECTION_HEALTH_TREND_SCOPE_FOR_KIND,
} from './producers/connection_health_trend.js';
export {
  connectionLastUsedPatternTask,
  connectionLastUsedPatternTokenEstimate,
  connectionLastUsedPatternScopeReadDeclaration,
  runConnectionLastUsedPatternCycle,
  computeLastUsedPatternValue,
  sweepStaleLastUsedPatternRows,
  emptyHourHistogram,
  CONNECTION_LAST_USED_PATTERN_AUTHORED_BY,
  CONNECTION_LAST_USED_PATTERN_TOPIC,
  CONNECTION_LAST_USED_PATTERN_WINDOW_MS,
  CONNECTION_LAST_USED_PATTERN_TOKEN_ESTIMATE,
  MAX_RECIPES_IN_BREAKOUT,
} from './producers/connection_last_used_pattern.js';
export {
  connectionOptimalBatchSizeTask,
  connectionOptimalBatchSizeTokenEstimate,
  connectionOptimalBatchSizeScopeReadDeclaration,
  runConnectionOptimalBatchSizeCycle,
  computeOptimalBatchSizeValue,
  sweepStaleOptimalBatchSizeRows,
  CONNECTION_OPTIMAL_BATCH_SIZE_AUTHORED_BY,
  CONNECTION_OPTIMAL_BATCH_SIZE_TOPIC,
  CONNECTION_OPTIMAL_BATCH_SIZE_WINDOW_MS,
  CONNECTION_OPTIMAL_BATCH_SIZE_TOKEN_ESTIMATE,
  CONNECTION_OPTIMAL_BATCH_SIZE_P50_MIN_SAMPLE_COUNT,
  CONNECTION_OPTIMAL_BATCH_SIZE_P95_MIN_SAMPLE_COUNT,
  CONNECTION_OPTIMAL_BATCH_SIZE_RECOMMENDATION_MIN_SAMPLE,
  CONNECTION_OPTIMAL_BATCH_SIZE_DURATION_BUDGET_MULT,
  SUPPORTED_KINDS as CONNECTION_OPTIMAL_BATCH_SIZE_SUPPORTED_KINDS,
} from './producers/connection_optimal_batch_size.js';
export {
  percentile as nearestRankPercentileShared,
} from './producers/_stats.js';
export {
  attributionSignalTask,
  attributionSignalTokenEstimate,
  attributionSignalScopeReadDeclaration,
  runAttributionSignalCycle,
  runAttributionSignalCycleForScope,
  decideAttribution,
  buildSignalTokens as buildAttributionSignalTokens,
  resolveOwnerMailbox as resolveAttributionOwnerMailbox,
  tallyWindowActivity as tallyAttributionWindowActivity,
  ATTRIBUTION_SIGNAL_AUTHORED_BY,
  ATTRIBUTION_SIGNAL_TOPIC,
  ATTRIBUTION_SIGNAL_SOURCE_SCOPE,
  ATTRIBUTION_SIGNAL_SOURCE_SCOPES,
  ATTRIBUTION_WINDOW_MS,
  ATTRIBUTION_MAX_DEALS_PER_CYCLE,
  ATTRIBUTION_SIGNAL_TOKEN_ESTIMATE,
  type AttributionWindowTally,
  type AttributionSignalSourceScope,
} from './producers/attribution-signal.js';
export {
  engagementScorePerContactTask,
  engagementScorePerContactTokenEstimate,
  engagementScorePerContactScopeReadDeclaration,
  runEngagementScoreCycle,
  runEngagementScoreCycleForScope,
  decayScore as engagementDecayScore,
  volumeScore as engagementVolumeScore,
  decideTrajectory as decideEngagementTrajectory,
  composeEngagementValue,
  ENGAGEMENT_SCORE_AUTHORED_BY,
  ENGAGEMENT_SCORE_TOPIC,
  ENGAGEMENT_SCORE_SOURCE_SCOPE,
  engagementScoreSourceScopes,
  ENGAGEMENT_SCORE_TOKEN_ESTIMATE,
  ENGAGEMENT_RECENT_WINDOW_MS,
  ENGAGEMENT_BASELINE_WINDOW_MS,
  ENGAGEMENT_HUBSPOT_HALF_LIFE_MS,
  ENGAGEMENT_RECENCY_HALF_LIFE_MS,
  ENGAGEMENT_LOCAL_VOLUME_CAP,
  ENGAGEMENT_TRAJECTORY_RISING_RATIO,
  ENGAGEMENT_TRAJECTORY_FALLING_RATIO,
  ENGAGEMENT_TRAJECTORY_MIN_SAMPLE,
  ENGAGEMENT_HUBSPOT_CAP,
  ENGAGEMENT_LOCAL_CAP,
  ENGAGEMENT_RECENCY_CAP,
  ENGAGEMENT_MAX_CONTACTS_PER_CYCLE,
  type EngagementWindowTally,
} from './producers/engagement-score-per-contact.js';
export {
  lifecycleStageInferredTask,
  lifecycleStageInferredTokenEstimate,
  lifecycleStageInferredScopeReadDeclaration,
  runLifecycleStageInferredCycle,
  processOneContact as processOneLifecycleStageContact,
  buildLifecyclePrompt,
  buildLifecycleSignalTokens,
  resolveLifecycleStageLayer,
  LIFECYCLE_STAGE_AUTHORED_BY,
  LIFECYCLE_STAGE_TOPIC,
  LIFECYCLE_STAGE_SOURCE_SCOPE,
  LIFECYCLE_STAGE_TOKEN_ESTIMATE,
  LIFECYCLE_STAGE_MAX_CONTACTS_PER_CYCLE,
  type LifecycleSignalBundle,
} from './producers/lifecycle-stage-inferred.js';
export {
  lifecycleStageInferredSalesforceTask,
  lifecycleStageInferredSalesforceTokenEstimate,
  lifecycleStageInferredSalesforceScopeReadDeclaration,
  runLifecycleStageInferredSalesforceCycle,
  processOneSalesforceContact as processOneLifecycleStageSalesforceContact,
  buildSalesforceLifecyclePrompt,
  buildSalesforceLifecycleSignalTokens,
  resolveSalesforceLifecycleStageLayer,
  LIFECYCLE_STAGE_SALESFORCE_AUTHORED_BY,
  LIFECYCLE_STAGE_SALESFORCE_TOPIC,
  LIFECYCLE_STAGE_SALESFORCE_SOURCE_SCOPE,
  LIFECYCLE_STAGE_SALESFORCE_TOKEN_ESTIMATE,
  LIFECYCLE_STAGE_SALESFORCE_MAX_CONTACTS_PER_CYCLE,
  type SalesforceLifecycleSignalBundle,
} from './producers/lifecycle-stage-inferred-salesforce.js';
export {
  collectConnectionActivities,
  ACTION_FOR_CONNECTION_KIND,
  type ParsedConnectionAuditRow,
} from './producers/_audit-activities.js';
export {
  composeConnectionFreshKey,
  KIND_FOR_CONNECTION_SCOPE,
  type EnrolledConnection,
} from './producers/_connection-records.js';
export type {
  HousekeepingLlmExecute,
  HousekeepingLlmExecuteWithMeta,
  HousekeepingEmbedExecute,
  HousekeepingTranscribe,
} from './registry.js';
export {
  probeAiPathAvailability,
  probeEmbeddingsPathAvailability,
  type AiPathAvailability,
  type AiPathReason,
  type EmbeddingsPathAvailability,
  type EmbeddingsPathReason,
} from './ai-availability.js';
export {
  createTrustStore,
  isAiPaused,
  isByokAllowedForBackground,
  appendTaskErrorEntry,
  readTaskErrorHistory,
  type TrustStore,
} from './trust-store.js';

// D-134 Phase 2 — declarative registration tables. `bin.ts` iterates
// these instead of calling `registerHousekeepingTask` 25 times by hand.
export {
  STANDALONE_TASKS,
  PER_RECORD_PRODUCERS,
  type PerRecordWalkerKind,
  type PerRecordProducerEntry,
} from './registration.js';

// D-128 Phase 2 — Reconciliation harness for platform-reference
// scopes. Vendor Ds (D-129 HubSpot, D-130 Salesforce) implement
// `VendorReconciler` and register one task per `(reconciler,
// connection_name)` pair via `buildVendorReconciliationTask`. D-128
// ships zero registered reconcilers; the harness + registry surface
// is the substrate.
export {
  buildVendorReconciliationTask,
  reconciliationTaskId,
  readMetaFromRow,
  type SlimRecord,
  type WebhookProcessor,
  type WebhookSlimEvent,
  type ReconciliationCadence,
  type VendorReconciler,
  type ConnectionLookup,
  type BuildVendorReconciliationTaskInput,
} from './reconciliation/vendor-reconciler.js';
export {
  createReconcilerRegistry,
  registerVendorReconciler,
  getVendorReconciler,
  getVendorReconcilerByVendorEntity,
  listVendorReconcilers,
  listVendorReconcilersByVendor,
  clearDefaultReconcilerRegistry,
  type ReconcilerRegistry,
} from './reconciliation/reconciler-registry.js';

// D-136 §A.3 — Producer wrapper. Custom-cycle AI producers
// (`lifecycle_stage_inferred*`, `topic_cluster`, etc.) route their
// dedup probe + trust gate + LLM call + upsert through this wrapper
// so the discipline (zero-cost steady-state cycles + cross-pool
// model_id capture + bistemporal `event_at` stamping) is enforced
// consistently. Per-record producers ride the harness's per-record
// path in `enrichment-producer.ts` instead.
export {
  runAIProducer,
  type RunAIProducerInput,
  type AIProducerOutcome,
  type AIProducerEventClock,
} from './ai-producer-wrapper.js';

// D-128 Phase 3 — Webhook funnel + recipient endpoint.
// Vendor-specific verifier + slim-record producer (`WebhookProcessor`
// on each `VendorReconciler`) routes inbound payloads into the same
// synthetic-event pipeline as the cycle. The cycle becomes the
// catch-up safety net rather than the primary update channel for
// vendors that opt in.
export {
  createWebhookFunnel,
  WEBHOOK_DEDUP_RING_MAX_ENTRIES,
  type WebhookFunnelDeps,
  type WebhookFunnelInput,
  type WebhookFunnelResult,
  type WebhookFunnelHandler,
  type ConnectionConfigLookup,
} from './reconciliation/webhook-funnel.js';

// Runtime constants
export { OPS, UNARY_OPS } from './conditions.js';
export { NS } from './namespaces.js';
export {
  ERR, ERROR_MESSAGES, defaultErrorMessage,
  ERROR_ATTRIBUTION, OWNER_ATTRIBUTED_ERROR_CODES,
  isChoiceAttributableFailure, isEnvironmentOnlyFailure,
} from './errors.js';
export type { ErrorAttribution } from './errors.js';
export { FORMAT_HINTS, TARGET_SCOPE, ESCAPE_HINTS, isRefHint } from './values.js';
export { MIN_TTL } from './vault.js';

// Utility functions
export { isRef, hasInterpolation, parseCondition, stepType } from './values.js';
export { resolveRef, resolveValue, resolveDeep, formatHint, interpolationText, collectRefs, walkPath } from './resolve.js';
export { escapeSoqlStringLiteral, soqlQuotedLiteral, soqlLikeOperand } from './soql.js';
export {
  isClosedRequestSchema,
  closedRequestSchemaDefinitionIssues,
  closedRequestSchemaViolation,
  isFileRefArgumentValue,
  FILE_REF_JSON_SCHEMA,
  projectClosedRequestSchemaForJsonSchema,
} from './closed-request-schema.js';

// Types — conditions
export type { ConditionOp, Condition } from './conditions.js';

// Types — namespaces
export type { Namespace } from './namespaces.js';

// Types — errors
export type { RecipeErrorCode, ErrorSeverity, RecipeError } from './errors.js';
// D-268 — how hard to stop an unattended automation that just failed. Splits the
// `environment` attribution bucket by "will waiting help", which is the only
// bucket ERROR_ATTRIBUTION does not already determine.
export type {
  AutomationFailureBasis,
  AutomationFailureDisposition,
  AutomationStopPoint,
} from './automation-failure-policy.js';
export {
  ENVIRONMENT_RETRY_POLICY,
  classifyAutomationFailure,
} from './automation-failure-policy.js';

// Types — steps
export type { RecipeSimulationInput, RecipeSimulationRequest, RecipeSimulationResult, SimulatedStep } from './recipe-simulation.js';
export type { StepType, BaseStep, TransformStep, IngredientStep, GuardStep, CanonicalOpStep, RecipeStep, PrefetchStep, PrefetchOpStep, CacheFreshness, StepOptions, StepMeta, StepFailureKind } from './steps.js';
export { isPrefetchOpStep } from './steps.js';

// Connection-agnostic op dispatch — resolver I/O types + the op-step guard +
// the registry-sourced canonical field-mapping helper (slice 2).
export {
  isCanonicalOpStep,
  CANONICAL_CRM_VERBS,
  CANONICAL_FILTER_OPERATORS,
  CANONICAL_UNARY_FILTER_OPERATORS,
  entityFieldsFromRegistry,
  crmFieldPackTypeConforms,
  vendorEntitiesFromComposition,
} from './connection-agnostic.js';
export { parseMailDraftId, parseMailDraftContent, parseMailDraftCreate, parseMailDraftGet, parseMailDraftUpdate, parseMailDraftDelete, parseMailDraftList,
  type MailDraft, type MailDraftContent, type MailDraftSummary, type MailDraftCreateRequest, type MailDraftUpdateRequest, type MailDraftDeleteRequest } from './mail-drafts.js';

export type {
  PackResolutionContext,
  ResolvedBinding,
  CanonicalCrmVerb,
  CanonicalFilterOperator,
  CanonicalFilterCondition,
  CanonicalFilterOrGroups,
  CanonicalFilter,
  CanonicalSortSpec,
  CanonicalSearchArgs,
} from './connection-agnostic.js';

// Types — recipe
export type {
  RecipeMetadata, VariableDefault, DataOutputSection, FilterOutputSection,
  RecordFieldsOutputSection, ResolvedRecordField, ResolvedRecordFieldsDescriptor,
  TableOutputSection, ResolvedRecordColumn, ResolvedRecordColumnsDescriptor,
  TableEditSpec, ResolvedTableEditDescriptor, OutputTableEditInvocation,
  TableAppendedColumn, TableColumnControl,
  OutputSection, OutputType, RecipeOutput, RecipeExchangeOutput, ResolvedFilterDescriptor,
  ResolvedOutputSection, OutputFilterInvocation, RecipeInvocation,
  RecipeOutputAction, RecipeDefinition,
  RecipeEventTrigger, OnFailureBinding,
  UndeclaredConfigOrigin, UndeclaredConfigArgument, UndeclaredConfigArgumentDetails,
} from './recipe.js';
export {
  ALLOW_UPGRADE_VARIABLE,
  OUTPUT_TYPES,
  TABLE_COLUMN_CONTROLS,
  tableColumnInputType,
  recipeOutputSections,
  FILTER_CONFIG_KEY_NOT_ALLOWED,
  FILTER_INVOCATION_STALE,
  FILTER_INVOCATION_FORBIDDEN,
} from './recipe.js';
export {
  UNDECLARED_CONFIG_ARGUMENT,
  undeclaredConfigArguments,
  undeclaredConfigArgumentMessage,
} from './recipe.js';
export {
  entityFieldsFromMetaFields,
  entityFieldsFromRecordsSnapshot,
  isResolvedRecordFieldsDescriptor,
  isResolvedRecordColumnsDescriptor,
  recordFieldLabel,
  recordFieldsSource,
  resolveRecordFields,
  resolveRecordColumns,
  NUMERIC_FIELD_KINDS,
} from './record-fields.js';
export type { EntityFieldDeclaration } from './record-fields.js';


// D-207 3d·6d — the general reception form/recipe pair binding (split out of
// D-200's direct-checkout module). Every paired public form binds through
// these shapes; they carry no Seller-row, transaction, or hosted-URL
// authority; v2 may pin one navigation-only local offer id.
export {
  RECEPTION_PAIR_VERSION,
  RECEPTION_SELLER_ASSOCIATION_PAIR_VERSION,
  RECEPTION_SCHEDULING_PAIR_VERSION,
  RECEPTION_PAIR_REVISION_PREFIX,
  RECEPTION_SELLER_ASSOCIATION_PAIR_REVISION_PREFIX,
  RECEPTION_SCHEDULING_PAIR_REVISION_PREFIX,
  RECEPTION_PAIR_FORM_ID_MAX_LENGTH,
  RECEPTION_PAIR_RECIPE_ID_MAX_LENGTH,
  isReceptionPairRevision,
  isReceptionPairBinding,
  isReceptionFormPairBinding,
  isReceptionSchedulingPairBinding,
  receptionPairBindingEquals,
  receptionPairBinding,
  receptionSchedulingPairBinding,
} from './reception-pair-binding.js';
export type {
  ReceptionPairBindingInput,
  ReceptionSchedulingPairBindingInput,
  ReceptionPairBinding,
  ReceptionFormPairBinding,
  ReceptionPlainPairBinding,
  ReceptionSellerAssociationPairBinding,
  ReceptionSchedulingPairBinding,
} from './reception-pair-binding.js';

// D-200 payment-profile residue — fulfillment workflow identity, kept while
// the paid-document pack still ships (install coordination + the historical
// state-row key the review-admission check reads).
export {
  PAID_DOCUMENT_FULFILLMENT_BUNDLE_KEY,
  PAID_DOCUMENT_CHECKOUT_CREATE_IDEMPOTENCY_SUFFIX,
  isPaidDocumentFulfillmentSubmissionId,
  paidDocumentDirectCheckoutSellerAssociation,
} from './paid-document-direct-checkout.js';

// D-200 Slice 6g.9 — owner-selected local claim configuration lives in the
// exact saved recipe source, so the pair revision pins deployment locators and
// an optional v2 Seller offer association without row or transaction authority.
export {
  PAID_DOCUMENT_DIRECT_CHECKOUT_CONFIGURATION_METADATA_KEY,
  PAID_DOCUMENT_DIRECT_CHECKOUT_CONFIGURATION_VERSION,
  PAID_DOCUMENT_DIRECT_CHECKOUT_SELLER_ASSOCIATION_CONFIGURATION_VERSION,
  PAID_DOCUMENT_CHECKOUT_MIN_EXPIRY_WINDOW_MS,
  PAID_DOCUMENT_CHECKOUT_MAX_EXPIRY_WINDOW_MS,
  PAID_DOCUMENT_CHECKOUT_URL_PLACEHOLDER,
  PAID_DOCUMENT_TEMPLATE_MAX_BYTES,
  PAID_DOCUMENT_AI_DRAFT_KEY,
  PAID_DOCUMENT_AI_DRAFT_MAX_CHARS,
  resolvePaidDocumentDirectCheckoutClaimConfiguration,
} from './paid-document-direct-checkout-config.js';
export {
  REVIEW_CRITERIA_MAX,
  REVIEW_CRITERIA_METADATA_KEY,
  REVIEW_CRITERION_KEY_MAX,
  readReviewCriteria,
  type ReviewCriteriaDeclaration,
  type ReviewCriterion,
} from './review-criteria-config.js';
export type {
  PaidDocumentDirectCheckoutClaimConfiguration,
  PaidDocumentDirectCheckoutLegacyClaimConfiguration,
  PaidDocumentDirectCheckoutSellerAssociationClaimConfiguration,
  PaidDocumentDirectCheckoutClaimConfigurationResolution,
  PaidDocumentFulfillmentTemplateState,
} from './paid-document-direct-checkout-config.js';

// D-220 Slice A1 — a recipe's declared contract with the intake form it is
// paired to. The names are read by static path, so they are a contract; this
// makes the claim machine-checkable at authoring and at wiring.
export {
  RECIPE_FORM_FIELD_NOTE_MAX,
  RECIPE_FORM_FIELDS_COUNT_MAX,
  FORM_FIELD_VALUE_SHAPE,
  validateRecipeFormFields,
  collectFormValueRefs,
  collectWholeFormRecordRefs,
  evaluateFormFieldContract,
  formResponseTriggerFormScope,
  recipeFormResponseScope,
} from './recipe-form-fields.js';
export type {
  RecipeFormFieldRequirement,
  RecipeFormFieldsValidationCode,
  RecipeFormFieldsValidationFailure,
  FormFieldContractMismatchCode,
  FormFieldContractMismatch,
  FormFieldContractVerdict,
  FormFieldContractFormView,
  FormResponseTriggerFormScope,
} from './recipe-form-fields.js';

// D-200 Slices 6g.3/6g.10/6g.11 — paired-client authoring/readiness wire shapes.
// Bind names only current local sources and an observed row token; core derives
// the revision and source-proves the recipe-pinned claim configuration.
export {
  RECEPTION_INTAKE_RECIPE_PAIR_CLAIM_CONFIGURATION_BLOCKER_CODES,
} from './reception-intake-recipe-pair.js';
export type {
  ReceptionIntakeRecipePairStatus,
  ReceptionIntakeRecipePairClaimConfigurationBlockerCode,
  ReceptionIntakeRecipePairClaimConfigurationReadiness,
  ReceptionIntakeRecipePairClaimConfigurationAuthoring,
  ReceptionIntakeRecipePairView,
  ReceptionIntakeRecipePairGetInput,
  ReceptionIntakeRecipePairGetResult,
  ReceptionIntakeRecipePairBindInput,
  ReceptionIntakeRecipePairBindResult,
  // D-207 slice 1c — the door minted alongside the pair (the ACCESS half).
  ReceptionDoorBindView,
  ReceptionDoorRefusalReason,
  ReceptionIntakeRecipePairConfigureInput,
  ReceptionIntakeRecipePairConfigureResult,
  ReceptionIntakeRecipePairClearInput,
  ReceptionIntakeRecipePairClearResult,
} from './reception-intake-recipe-pair.js';

// D-200 Slice 6g.14 — paired-client exact-submission Checkout recovery.

// D-201 Slice 0 — portable trusted-profile registry, pack/local requirement
// grammar, binding-aware triggers, and durable wire shapes.  Server verifier
// functions / request bytes / secrets deliberately do not live in contracts.
export {
  WEBHOOK_MECHANISM_KINDS,
  WEBHOOK_REGISTRATION_MODES,
  WEBHOOK_TRANSPORT_ASSURANCES,
  WEBHOOK_SOURCE_TRUTH_POLICIES,
  WEBHOOK_DECODER_KINDS,
  WEBHOOK_ENVIRONMENTS,
  WEBHOOK_ENVIRONMENT_POLICIES,
  WEBHOOK_DECODED_PAYLOAD_ACCESS,
  WEBHOOK_PROFILE_FIELD_KINDS,
  WEBHOOK_PROFILE_FIELD_SOURCES,
  WEBHOOK_DEDUPLICATION_IDENTITY_KINDS,
  WEBHOOK_PROFILE_IDS,
  WEBHOOK_PROFILE_REGISTRY,
  WEBHOOK_BINDING_RE,
  WEBHOOK_CONNECTION_SLOT_RE,
  WEBHOOK_EVENT_TYPE_RE,
  WEBHOOK_PROFILE_ID_RE,
  MAX_WEBHOOK_REQUIREMENTS,
  MAX_WEBHOOK_PROFILES_PER_REQUIREMENT,
  MAX_WEBHOOK_EVENT_TYPES_PER_REQUIREMENT,
  MAX_WEBHOOK_TRIGGERS,
  MAX_WEBHOOK_EVENT_TYPES_PER_TRIGGER,
  MAX_WEBHOOK_INGRESS_DISPLAY_NAME_LENGTH,
  MAX_WEBHOOK_REGISTRATION_TARGET_KIND_LENGTH,
  MAX_WEBHOOK_REGISTRATION_TARGET_KEY_LENGTH,
  MAX_WEBHOOK_CREDENTIAL_VALUE_BYTES,
  MAX_WEBHOOK_CREDENTIAL_TOTAL_BYTES,
  MAX_ACTIVE_WEBHOOK_CREDENTIAL_VERSIONS,
  MAX_WEBHOOK_DELIVERY_PAGE_SIZE,
  WEBHOOK_REJECTED_DELIVERY_REASON_CODES,
  isWebhookProfileId,
  webhookProfile,
  webhookProfileAcceptsEventType,
  webhookProfileRequiresPairedConnection,
  validateWebhookProfileRegistry,
  validateWebhookRequirement,
  validateWebhookRequirements,
  validateRecipeWebhookTrigger,
  validateRecipeWebhookTriggers,
  validateWebhookTriggerBindings,
} from './webhook-profiles.js';
export type {
  WebhookMechanismKind,
  WebhookRegistrationMode,
  WebhookTransportAssurance,
  WebhookSourceTruthPolicy,
  WebhookDecoderKind,
  WebhookEnvironment,
  WebhookEnvironmentPolicy,
  WebhookDecodedPayloadAccess,
  WebhookProfileFieldKind,
  WebhookProfileFieldSource,
  WebhookDeduplicationIdentityKind,
  WebhookDeduplicationIdentity,
  WebhookDeduplicationPolicy,
  WebhookProfileId,
  WebhookProfileField,
  WebhookEventTypeCatalog,
  WebhookProfileDescriptor,
  PackWebhookRequirement,
  RecipeWebhookRequirement,
  RecipeWebhookTrigger,
  WebhookContractIssue,
  WebhookRegistrationState,
  WebhookIntakeState,
  WebhookRegistrationTarget,
  WebhookIngressRecord,
  WebhookCredentialVersionView,
  WebhookIngressReadinessBlocker,
  WebhookIngressReadinessView,
  WebhookIngressHealthStatus,
  WebhookIngressHealthView,
  WebhookIngressView,
  WebhookProfileRuntimeCapabilityView,
  WebhookIngressListResponse,
  WebhookIngressCreateRequest,
  WebhookIngressUpdateRequest,
  WebhookIngressCredentialWriteRequest,
  WebhookIngressCredentialWriteResponse,
  WebhookIngressCredentialRetireRequest,
  WebhookIngressManualConfirmRequest,
  WebhookIngressRegistrationReconcileRequest,
  WebhookIngressEnableRequest,
  WebhookIngressDisableRequest,
  WebhookIngressTestDeliveryRequest,
  WebhookIngressTestDeliveryResponse,
  WebhookIngressRetireRequest,
  WebhookDeliveryListCursor,
  WebhookDeliveryListRequest,
  WebhookDeliveryGetRequest,
  WebhookDeliveryEventGetRequest,
  WebhookDeliverySummaryView,
  WebhookDeliveryEventSummaryView,
  WebhookDeliveryDetailView,
  WebhookDeliveryListResponse,
  WebhookDeliveryEventPayloadView,
  WebhookRejectedDeliveryReasonCode,
  WebhookRejectedDeliveryListCursor,
  WebhookRejectedDeliveryListRequest,
  WebhookRejectedDeliverySummaryView,
  WebhookRejectedDeliveryListResponse,
  WebhookDeliveryRetentionPruneRequest,
  WebhookDeliveryRetentionPruneResult,
  WebhookDeliveryRetentionPruneResponse,
  WebhookConsumerBindingRecord,
  WebhookIngressBindingSelection,
  LocalRecipeWebhookStatus,
  LocalRecipeWebhookDoorStatus,
  AcceptedWebhookDeliveryRecord,
  AcceptedWebhookEventRecord,
  WebhookTriggerContext,
} from './webhook-profiles.js';
export {
  WEBHOOK_OWNER_PROFILE_SETTINGS,
  webhookOwnerProfileSettings,
  webhookOwnerTextForEnvironment,
} from './webhook-owner-profile-settings.js';
export type {
  WebhookOwnerEnvironmentText,
  WebhookOwnerRegistrationTargetKind,
  WebhookOwnerRegistrationTargetSettings,
  WebhookOwnerProfileSettings,
} from './webhook-owner-profile-settings.js';

// D-182 §10 step 8 / R1 — the recipe-runnability DISCLOSURE wire shape: a recipe's
// status + the synthesized per-family detail the webclient install/uninstall
// disclosure renders. The backend `recipe.runnability` handler fills them from the
// R1 verb-split; `@recued/contracts` owns them so the rpc + broadcast reference them
// without importing a backend module.
export type {
  RunnabilityStatus,
  DependencyResolution,
  RunnabilityResult,
  RecipeRunnabilityEntry,
  RunnabilityTransition,
} from './recipe-runnability.js';

// D-122 Phase 4.5 — time-relative-watcher sweeper cadence.
export { TIME_RELATIVE_SWEEP_MS } from './backfill.js';

// D-122 Phase 4.5 — enrichment substrate registry.
export {
  ENRICHMENT_REGISTRY,
  ALL_ENRICHMENT_SIDECARS,
  ALL_ENRICHMENT_POLICIES,
  isEnrichmentTopic,
  getEnrichmentDefinition,
  enrichmentTopicsForScope,
  confidenceEmittingEnrichmentTopics,
  resolveEnrichmentTrustDefault,
  resolveEnrichmentPoolPolicyDefault,
  assertEnrichmentTrustDefaults,
  // D-136 — lifecycle / temporal-class / identity-aggregation gates
  validateLifecycleDefinition,
  assertEnrichmentLifecycleDefaults,
  // D-136 §A.3 — producer-version hash composition
  computeProducerVersionHash,
  // D-136 §A.3 — input-fingerprint hash composition
  computeInputFingerprintHash,
  // D-136 §A.14 — compression-class + prompt-bias annotations
  ALL_COMPRESSION_CLASSES,
  PROMPT_BIAS_HINT_RE,
  // D-136 §A.13.5 — MCP read-exposure annotation
  ALL_MCP_EXPOSURE_POLICIES,
  resolveMCPExposure,
  isMCPPrivateTopic,
  // D-136 §A.14.4 — coverage-quality threshold + cadence helper
  DEFAULT_COVERAGE_QUALITY_THRESHOLD,
  ALL_COVERAGE_QUALITY_BANDS,
  resolveCoverageQualityThreshold,
  cadenceToMs,
  // D-136 §A.9 — kernel `enrichment-upsert` writer mode
  ENRICHMENT_UPSERT_MODES,
  ENRICHMENT_PINNED_AUTHOR_PREFIX,
  // D-136 §A.11 — quality-vote substrate closed lists
  ENRICHMENT_VOTE_KINDS,
  ENRICHMENT_VOTE_SOURCES,
  ALL_ENRICHMENT_SCOPES,
  CONNECTION_ENRICHMENT_SCOPES,
  WORK_ENTITY_ENRICHMENT_SCOPES,
  isEnrichmentScope,
  isPlatformReferenceScope,
  composeEnrichmentScope,
  composeVendorEntityScope,
  parseVendorEntityScope,
  composePlatformRecordTargetId,
  composeConnectionTargetIdPrefix,
  // D-134 — tag substrate
  RECOMMENDED_TAG_NAMESPACES,
  parseEnrichmentTag,
  assertEnrichmentTagShape,
  assertRegistryTagShapes,
  deriveStandardEnrichmentTags,
  collectEnrichmentTags,
  computeHousekeepingMetaTags,
} from './enrichment-registry.js';
export type {
  EnrichmentDefinition,
  EnrichmentShape,
  EnrichmentPolicy,
  EnrichmentScope,
  EnrichmentClosedScope,
  EnrichmentNamespace,
  EnrichmentSidecar,
  EnrichmentProducerKind,
  EnrichmentRecomputeCadence,
  // D-136 — lifecycle types
  TemporalClass,
  IdentityAggregation,
  LifecyclePolicy,
  AggregateWindowAxis,
  IdentityExtractor,
  InputFingerprintComposition,
  // D-136 §A.14 — quality-discrimination annotations
  CompressionClass,
  // D-136 §A.13.5 — MCP read-exposure annotation
  MCPExposurePolicy,
  // D-136 §A.14.4 — coverage-quality band
  CoverageQuality,
  // D-136 §A.9 — kernel `enrichment-upsert` writer mode
  EnrichmentUpsertMode,
  // D-136 §A.11 — quality-vote substrate closed lists
  EnrichmentVoteKind,
  EnrichmentVoteSource,
  // D-136 §A.3 — producer-version hash inputs
  ProducerVersionHashInput,
  // D-136 §A.3 — input-fingerprint hash inputs (closed-list discriminator)
  InputFingerprintHashInput,
  EnrichmentValueValidator,
  EnrichmentTopic,
  EnrichmentTag,
  ParsedEnrichmentTag,
  RecommendedTagNamespace,
  ContactTimelineRollupValue,
  CalendarEventRollupValue,
  MeetingRescheduleValue,
  ThreadSignalsValue,
  TranscriptValue,
  CaptionValue,
  ExtractedTextValue,
  EmbeddingValue,
  BehavioralSignatureValue,
  ReplyPatternsValue,
  AttendeePatternsValue,
  AttendeeCoOccurrence,
  MeetingFrequencyValue,
  CompanyValue,
  RoleValue,
  RoleCategory,
  PreparationNotesValue,
  RelatedThread,
  RelatedThreadRelevance,
  RelatedThreadsValue,
  TopicCluster,
  WorkingGroupValue,
  OrganizationValue,
  EntityRef,
  SuggestDirective,
  EnrichmentResult,
  SemanticClusterValue,
  ConnectionHealthTrendValue,
  ConnectionLastUsedPatternRecipeBreakout,
  ConnectionLastUsedPatternValue,
  ConnectionOptimalBatchSizeValue,
  // D-128 P4 — platform-reference reserved topics
  DealHealthScoreValue,
  DealVelocitySignalValue,
  DealVelocity,
  EngagementScorePerContactValue,
  // D-139 P1a.1 — engagement substrate canary
  EngagementSilenceDurationValue,
  // D-139 P3 — deterministic deal-level enrichments
  EngagementVelocitySignalValue,
  EngagementVelocityTrajectory,
  InboundOutboundRatioValue,
  InboundOutboundBucket,
  LastMeaningfulTouchValue,
  // D-139 P4 — cross-entity enrichments
  MeetingToFollowupLagValue,
  MeetingFollowupLagBucket,
  OutOfBandEngagementValue,
  AccountEngagementBreadthValue,
  AccountBreadthBucket,
  AccountReentrySignalValue,
  ChampionDealCountValue,
  ChampionDealBucket,
  MultiAccountContactValue,
  // D-139 P5 — AI-surface canaries
  EngagementSentimentTrendValue,
  EngagementSentimentTone,
  NextBestActionValue,
  NextBestAction,
  // D-139 P6.B — `commitment_tracker` post-substrate canary
  CommitmentTrackerValue,
  TrackedCommitment,
  CommitmentEvidenceLink,
  CommitmentStatus,
  CommitmentEvidenceSource,
  // D-129 P6 — HubSpot-flavored topics
  LifecycleStage,
  LifecycleStageInferredValue,
  AttributionSource,
  AttributionSignalValue,
  // D-130 P6 — Salesforce-flavored lifecycle topic
  SalesforceLifecycleStage,
  LifecycleStageInferredSalesforceValue,
} from './enrichment-registry.js';
export {
  ROLE_CATEGORIES,
  LIFECYCLE_STAGES,
  ATTRIBUTION_SOURCES,
  SALESFORCE_LIFECYCLE_STAGES,
  // D-139 P3 — deterministic deal-level enrichments
  ENGAGEMENT_VELOCITY_TRAJECTORIES,
  INBOUND_OUTBOUND_BUCKETS,
  // D-139 P4 — cross-entity enrichments
  MEETING_FOLLOWUP_LAG_BUCKETS,
  ACCOUNT_BREADTH_BUCKETS,
  CHAMPION_DEAL_BUCKETS,
  // D-139 P5 — AI-surface canaries
  ENGAGEMENT_SENTIMENT_TONES,
  ENGAGEMENT_SENTIMENT_MAX_KEY_PHRASES,
  ENGAGEMENT_SENTIMENT_MAX_KEY_PHRASE_CHARS,
  NEXT_BEST_ACTIONS,
  NEXT_BEST_ACTION_MAX_RATIONALE_CHARS,
  // D-139 P6.B — `commitment_tracker` post-substrate canary
  COMMITMENT_STATUSES,
  COMMITMENT_EVIDENCE_SOURCES,
  COMMITMENT_TEXT_MAX_CHARS,
  COMMITMENT_EVIDENCE_FILENAME_MAX_CHARS,
  COMMITMENT_EVIDENCE_VENDOR_URL_MAX_CHARS,
  COMMITMENT_EVIDENCE_SOURCE_ID_MAX_CHARS,
  COMMITMENT_EVIDENCE_LINKS_MAX,
  COMMITMENT_TRACKER_COMMITMENTS_MAX,
  COMMITMENT_ACTOR_EMAIL_MIN_CHARS,
  COMMITMENT_ACTOR_EMAIL_MAX_CHARS,
  COMMITMENT_ACTOR_EMAIL_RE,
} from './enrichment-registry.js';

// D-128 — platform-reference enrichment substrate (`meta` snapshot column).
export {
  PLATFORM_REFERENCE_META_MAX_BYTES,
  PLATFORM_REFERENCE_DEFAULT_CADENCE,
  PLATFORM_REFERENCE_BATCH_SIZE,
  PLATFORM_REFERENCE_DELETE_DETECT_CADENCE,
  PLATFORM_REFERENCE_WEBHOOK_REPLAY_WINDOW_MS,
  MetaSnapshotTooLargeError,
  assertEnrichmentMetaShape,
  serializeEnrichmentMeta,
  deserializeEnrichmentMeta,
} from './enrichment-meta.js';
export type { EnrichmentMeta } from './enrichment-meta.js';

// D-123 — Housekeeping execution-mode contracts.
export {
  HOUSEKEEPING_MIN_TASK_BUDGET_MS,
  HOUSEKEEPING_IDLE_PROBE_MS,
  HOUSEKEEPING_AGGRESSIVE_IDLE_THRESHOLD_MS,
  HOUSEKEEPING_CONFIG_PRIMARY_KEY,
  LLM_RESULT_CACHE_GC_TASK_ID,
  OWNER_METRICS_COMPUTE_TASK_ID,
  HOUSEKEEPING_CYCLE_BUDGET_MIN_MS,
  HOUSEKEEPING_CYCLE_BUDGET_MAX_MS,
  HOUSEKEEPING_DISABLE_AFTER_FAILURES,
  HOUSEKEEPING_AUTO_RETRY_AFTER_MS,
  HOUSEKEEPING_DEFAULT_PRESET,
  HOUSEKEEPING_PRESET_DEFAULTS,
} from './housekeeping.js';
export type {
  HousekeepingPreset,
  HousekeepingCursor,
  HousekeepingYieldReason,
  HousekeepingStepResult,
  HousekeepingTaskKind,
  HousekeepingTaskMeta,
  HousekeepingConfigRow,
  HousekeepingLastStatus,
  HousekeepingStateRow,
  HousekeepingPerTaskResult,
  HousekeepingCycleResult,
  HousekeepingEnrichmentInfo,
  HousekeepingScopeReadEntry,
  HousekeepingTaskStatus,
} from './housekeeping.js';

// D-132 — Per-topic trust state + pool policy.
export {
  TRUST_DEFAULT_AI,
  TRUST_DEFAULT_DETERMINISTIC,
  POOL_POLICY_DEFAULT,
  MANUAL_RUN_THRESHOLD,
  PAUSE_DURATIONS_MS,
  PAUSE_UNTIL_RESUME_TIMESTAMP,
  TRUST_ERROR_HISTORY_SIZE,
  ALL_ENRICHMENT_TRUST_STATES,
  ALL_ENRICHMENT_POOL_POLICIES,
} from './enrichment-trust.js';
export type {
  EnrichmentTrustState,
  EnrichmentPoolPolicy,
  EnrichmentTrustRow,
  HousekeepingErrorEntry,
} from './enrichment-trust.js';

// D-133 — Confidence drift detection (PSI on AI-surface producers).
export {
  PSI_BIN_COUNT,
  PSI_THRESHOLD_MODERATE,
  PSI_THRESHOLD_SIGNIFICANT,
  PSI_LAPLACE_EPSILON,
  ALL_DRIFT_SEVERITIES,
  computeConfidenceHistogram,
  computePSI,
  psiSeverity,
} from './psi.js';
export type {
  DriftSeverity,
  DriftWindow,
  ConfidenceDriftSignal,
} from './psi.js';

// D-122 Phase 4 — bulk-install pack manifest.
export {
  BULK_INSTALL_PACK_VERSION,
  BULK_PACK_INSTALL_PERMISSION,
  BULK_PACK_MAX_RECIPES,
  // D-139 P6.B — post-substrate canary fields
  BULK_PACK_BODY_VISIBILITY_GRANT_KEYS,
  BULK_PACK_MAX_BODY_VISIBILITY_GRANTS,
  isBulkPackManifest,
  isHttpsRepoUrl,
  parseBulkPackManifest,
  // D-165 app-pack v2 — contents[] / dependencies[] substrate.
  BULK_PACK_MANIFEST_VERSION_V2,
  SUPPORTED_BULK_PACK_MANIFEST_VERSIONS,
  BULK_PACK_MAX_CONTENTS,
  PACK_KINDS, isPackKind,
  // Add-a-pack (2026-06-30) — install provenance (marketplace vs local import).
  PACK_INSTALL_SOURCES, isPackInstallSource,
  PACK_SERVICE_KINDS, isPackServiceKind,
  PACK_CONTENT_KINDS, PACK_INGREDIENT_ROLES, PACK_CHANNEL_CAPABILITIES,
  PACK_DEPENDENCY_KINDS,
  normalizeBulkPackInstallPlan,
  // D-182 — the dot-free slug shape (shared by op-model + the authoring validators).
  SLUG_RE,
  // D-182 §7.1 — install grant dialog selection.
  INSTALL_ACCESS_TIERS, INSTALL_SCOPE_WHO,
  isInstallGrantSelection, isInstallAudienceSelection,
  // Install-vs-browse marker on the apex install-manifest fetch (shared by the
  // server-side sender and the D-180 SSR worker that reads it).
  INSTALL_MANIFEST_MARKER_HEADER,
} from './bulk-pack.js';
// Storable-encoding gate — strings Postgres jsonb cannot hold (lone surrogates,
// raw NUL). Shared by the publish validators, the authoring gate, and the
// community corpus guard so the walk cannot drift between them.
export {
  findUnstorableStrings,
  describeUnstorable,
  UNSTORABLE_FINDING_LIMIT,
} from './storable-encoding.js';
export type { UnstorableFinding, UnstorableKind } from './storable-encoding.js';

export type {
  BulkPackManifest,
  BulkPackRecipeRef,
  BulkPackIssue,
  BulkPackParseResult,
  // D-139 P6.B — post-substrate canary fields
  BulkPackBodyVisibilityGrantKey,
  // D-145 PA10 follow-on — engine result mirror for `packs.install` rpc
  BulkPackInstallEntryLike,
  BulkPackInstallResultLike,
  // D-145 PA10 follow-on — `packs.list` rpc surface
  PackListEntry,
  PacksListResult,
  // D-259 — `packs.unrunnable` rpc surface
  UnrunnablePackRow,
  PacksUnrunnableResult,
  // Add-a-pack (2026-07-01) — `packs.resolveBySlug` manifest-preview result
  PacksResolveResult,
  // D-145 PA10 follow-on Slice B — `packs.uninstall` rpc result
  BulkPackUninstallResultLike,
  // D-165 app-pack v2 — contents[] / dependencies[] substrate.
  BulkPackManifestVersion,
  PackKind, PackInstallSource,
  PackServiceKind, PackContentKind, PackIngredientRole, PackChannelCapability,
  PackDependencyKind,
  PackContentRef, PackRecipeContentRef, PackIngredientContentRef,
  PackOperationGroupContentRef, PackChannelBindingContentRef, PackPolicyContentRef,
  PackCompositionContentRef,
  // D-220 Slice B — a pack-shipped `intake_form` template, by value.
  PackReceptionTemplateContentRef,
  // D-182 §7.1 — install grant dialog selection.
  InstallGrantSelection, InstallAudienceSelection, InstallAccessTier, InstallScopeWho,
  CompositionIngredient, CompositionSurface, CompositionAuthModel,
  OperationRow, EntityFieldRow,
  PackDependency, PackIngredientDependency, PackPackDependency,
  PackInstallPlan,
} from './bulk-pack.js';

// D-195 — verify the directly named workflow-install pack against its existing
// BulkPackManifest recipe pins. No parallel bundle manifest is introduced.
export {
  extractBulkPackRecipeRefs,
  resolveRecipeBundleInstallPack,
} from './recipe-bundle-install.js';
export type {
  RecipeBundleCatalogPack,
  RecipeBundleCatalogRecipe,
  RecipeBundlePackResolution,
  RecipeBundleRecipeRef,
} from './recipe-bundle-install.js';

// D-194 — pack-driven connection enrollment: the `connection_requirements[]`
// manifest descriptor (validated first-party-only on `BulkPackManifest`), its
// shape validator (shared with the fallback self-check), and the legacy
// compile-time fallback for pre-migration manifests.
export {
  CONNECTION_AUTH_DESCRIPTOR_TYPES,
  BULK_PACK_MAX_CONNECTION_REQUIREMENTS,
  validateConnectionRequirementShape,
  CONNECTION_REQUIREMENT_SEED,
  getSeededConnectionRequirements,
  // D-194 step 2 — endpoint match / candidate lookup (§3).
  endpointHost,
  findEndpointCandidates,
} from './connection-requirements.js';
export type {
  ConnectionRequirement,
  ConnectionAuthDescriptor,
  ConnectionAuthDescriptorType,
  EndpointCandidate,
} from './connection-requirements.js';

// D-182 — Uniform Op-Step & Ingredient Model: two-tier op addressing, the one
// recipe op-step shape, `depends_on`, the two pack authoring tables
// (`IngredientRow` + `PackOperationRow`), and the per-kind preflight handler
// registry. The D-182 Table-B row is barrel-named `PackOperationRow` (its
// in-module + spec name is `OperationRow`) to avoid clobbering the wide-blast-
// radius legacy D-170 composition `OperationRow` above; the migration slice
// (§10 step 4) deletes the legacy and renames this to `OperationRow`.
export * from './op-model.js';

// D-182 — Kernel op registry + R1 verb-split runnability (Tier-K side): the
// kernel domain registry (closed kinds + the crm/acct canonical conventions
// with their `required_connection_kind`), the canonical-verb split + kernel-
// defined verb→risk/approval, and the pure `kernelOpRunnability` gatherer
// (wired on top of the crm_alias/acct_alias registry via
// `conventionFamilyForVendor`).
export * from './kernel-ops.js';

// D-182 — Kernel op registry (slice 3a): the per-op enumeration of the Tier-K
// closed-kind kernel ops (`core.<domain>.<op>`) → backing ingredient slug +
// kernel-defined risk/approval, an addressing + policy layer over the kernel
// ingredient files. Composes with `kernel-ops.ts` (every op's domain must be a
// registered closed-kind domain).
export * from './kernel-op-registry.js';

// D-116 — Kitchen "Test trigger" shared shapes.
export type {
  RedactedVaultValue,
  TriggerTestInputValue,
  TriggerTestResult,
  TriggerTestRequest,
  TriggerTestResponse,
} from './trigger-test.js';

// D-115 — reactive recipes (auto_run + trigger_steps + circuit breaker).
export type {
  AutoRunSpec,
  TriggerOutput,
  CircuitBreakerState,
  AutoRunStatusEntry,
  ProcessRetireReason,
} from './reactive.js';
// Reactive-substrate slice 1 — cron preset catalog + display formatters
// (moved from `@recued/scheduler` so client surfaces can import them
// without crossing the D-148 P12 role boundary; scheduler re-exports).
export {
  CRON_PRESETS,
  buildCronFromInterval,
  describeCron,
} from './cron-presets.js';
// D-266 — owner-declared missed-schedule policy. Same boundary reason
// as the cron presets above: the picker lives on clients, the decision
// runs in `@recued/scheduler`.
export {
  MISSED_SCHEDULE_POLICIES,
  DEFAULT_MISSED_SCHEDULE_POLICY,
  MISSED_SCHEDULE_POLICY_COPY,
  isMissedSchedulePolicy,
  type MissedSchedulePolicy,
} from './missed-schedule-policy.js';
export {
  AUTO_RUN_EXTENSION_FLOOR_MS,
  AUTO_RUN_SERVER_FLOOR_MS,
  CIRCUIT_BREAKER_THRESHOLD,
  WAIT_TRANSFORM_MAX_MS,
  TRIGGER_TEST_DEDUPE_MS,
  TEMPLATE_TAG_PREFIX,
} from './reactive.js';

// Types — ingredients
export type {
  IngredientCategory, RiskTier, ModelHint, IngredientSource, IngredientManifest,
  IngredientKind,
  // D-210 step 3 — provenance write-target declaration
  IngredientWriteTarget,
  WebChatTab, LLMRequirements,
  // D-136 §A.4 — regen-policy types
  RegenPolicy, RegenInputInvariant, RegenDeterminism, RegenTrigger,
} from './ingredient.js';
export {
  isLocalIngredient, isKernelManifest, isServiceManifest, KERNEL_AUTHOR, GENERATED_PACK_PUBLISHER,
  INGREDIENT_KINDS, KIND_ALLOWED_TIERS,
  // D-203 — canonical RiskTier ladder / rank / label (single source of truth)
  RISK_TIERS, RISK_TIER_SET, isRiskTier, RISK_TIER_RANK, RISK_TIER_LABELS, riskTierLabel,
  // D-136 §A.4 — regen-policy closed lists
  REGEN_TRIGGERS, REGEN_DETERMINISMS, REGEN_INPUT_INVARIANTS,
} from './ingredient.js';
export type { ValueHintType, ValueHint } from './value-hint.js';
export { VALUE_HINT_KEYS } from './value-hint.js';
// D-223 § 7.2 — the seam where "may this publisher declare X" is answered.
export {
  FIRST_PARTY_PUBLISHER,
  publisherMayDeclare,
  reservedCapabilityMessage,
  type ReservedPackCapability,
} from './publisher-trust.js';
// D-223 — connection hints: a publisher may pre-fill a visible, editable field.
export {
  APPLICABLE_GUIDE_FIELD_KEYS,
  BULK_PACK_MAX_CONNECTION_HINTS,
  HTTPS_GUIDE_FIELD_KEYS,
  RESERVED_CONNECTION_REQUIREMENT_CELLS,
  canApplyConnectionSetupGuideSuggestion,
  isPrivateHost,
  validateConnectionHintShape,
  type ConnectionHint,
} from './connection-hints.js';

// D-125 / request signing — the auth shape whose credential is COMPUTED per
// request, and the CLOSED registry of schemes that may compute it. A pack names
// a scheme; it never describes what gets signed.
export {
  CONNECTION_SIGNING_SCHEMES,
  applyRequestSignature,
  isConnectionSigningScheme,
  requestSignatureSecrets,
  type ConnectionSigningScheme,
  type RequestSignatureAuth,
  type SignableRequest,
  type SignatureHeaders,
} from './connection-signing.js';

// D-165 P0 — provider-catalog seed (minimal): catalog-form detection +
// per-connection operation-profile policy resolution + gateway audit shape.
export type {
  OperationRiskTier, OperationApproval, AuthorizationProvenance,
  OperationBoundWebhookDeclaration,
  OperationSpec, OperationGroupSpec,
  // D-165 P3.path-picker (Slice 3) — per-operation path-scope contract.
  PathScopeContract, PathScopeCheck,
  ProviderDefaultPolicy, ConnectionOperationProfile,
  CatalogVerdict, CatalogDenyReason, CatalogOperationResolution, GatewayCallAudit,
  // D-211 §2 — the owner's replace-if-present override ruling ({risk?, approval?}).
  OwnerOverridePolicy,
  // D-165 follow-on — operation-group grant view (user-facing grant rpc).
  OperationGroupGrantState, OperationGroupGrantView,
  // D-165 P2 — full catalog policy shape (enums + compound-op + metadata).
  MediaKind, CatalogKind, OperationIdempotency, GroupGrantDefault,
  GroupUpgradeBehavior, SubOperationSpec, OperationRequestMetadata,
  OperationArgsDsl,
  // D-165 P2 — surfaces / auth / execution-binding substrate.
  ProviderSurfaces, ProviderApiSurface, ProviderConnectorSurface,
  ProviderNotificationSurface,
  AuthSpec, OAuth2Spec, OAuth2TokenType, ApiKeySpec, ApiKeySlot,
  SignedRequestSpec, NoAuthSpec, SchemaSourceRef,
  ApiExecutionBinding, RestExecutionBinding, RestResponseCaptureSpec, RestResponseJsonSpec, RestRequestJsonSpec, GraphQLExecutionBinding, McpExecutionBinding,
  WebhookExecutionBinding, QueueSubscriptionBinding, PushChannelBinding,
  ConnectorRuntimeSpec, ConnectorLifecycleSpec, ConnectorExecutionBinding,
  ConnectorMethodBinding, CliArgvTemplateEntry, CliInvocationCwdSpec, CliMethodBinding, CliInputMaterializeSpec,
  CliProgressSpec, D259CliProgressSpec,
  CliHeartbeatProgressSpec, CliFileGrowthProgressSpec,
  CliProgressAdapter,
  CliOutputCaptureSpec, CliDetachedMarkerCompletion,
  // The three `CliOutputCaptureSpec` arms. `dir_arg` is the historical
  // engine-owned output dir; `from_input_arg` captures the file the tool edited
  // in place at its materialized input path; `from_stdout` streams what the tool
  // PRINTED to an engine-owned file — the arm that lets a stdout-only filter
  // (csvgrep, ripgrep, jq) read a warehouse file at all.
  CliOutputDirCaptureSpec, CliOutputInPlaceCaptureSpec, CliOutputStdoutCaptureSpec,
  CliDetachedCancelSpec, CliDetachedJobSpec, CliDetachedSupervisionSpec,
  LegacyCliDetachedSupervisionSpec, ReadyCliDetachedSupervisionSpec,
  ConnectorEventSpec,
  ApiTransport, McpPackReviewRow, AuthKind, OAuth2Flow, CallbackUrlStrategy, OAuthScopeSeparator,
  RestMethod, GraphQLOperationType, QueueKind, ApiExecutionBindingKind,
  ConnectorTransport, ConnectorWireProtocol, ConnectorAuthMethod,
  ReconnectPolicy, ConnectorExecutionBindingKind, CliStdinHandling,
  CliOutputShape, CliDetachedMode, CliDetachedCompletionKind,
  CliDetachedCancelKind,
  // D-185 Slice 2 / D-200 — cli output backing and exact file-ref carriers.
  CliOutputStorage, TempFileRef, PinnedCasFileRef,
  // Connection-agnostic op dispatch (NEXT-1) — catalog-declared search dialect;
  // (write-verb reverse projection) — catalog-declared write body dialect;
  // (pagination) — catalog-declared cursor-follow dialect.
  SearchStyle, WriteStyle, PaginationStyle,
  OperationPaginationStyle, OperationPaginationPlacement,
  OperationPaginationPageSize, OperationPaginationCondition,
  OperationPaginationCursorSource, OperationPaginationCursorTarget,
  BodyCursorPaginationSpec, NextPathPaginationSpec,
  LinkHeaderPaginationSpec, OperationPaginationSpec,
  // D-192 #8g — the four added follower styles.
  QueryTokenPaginationSpec, OffsetPaginationSpec,
  GraphqlRelayPaginationSpec, SinglePagePaginationSpec,
  // D-187 policy-matrix retirement (slice 3) — the op-risk stage-trust ceiling enum.
  TrustCeiling,
  // D-271 — per-op "the pinned document cannot prove this" declaration.
  OpenApiAbsentReason, OpenApiAbsentDeclaration,
} from './ingredient-catalog.js';
export {
  isCatalogForm, resolveCatalogOperationPolicy, resolveCliReachabilityPolicy, isRiskTierAtMost,
  // Capture-arm narrowing. Both validators and the executor discriminate
  // through these helpers rather than sniffing keys.
  isInPlaceCapture, isStdoutCapture, isD259CliProgressSpec,
  isReadyCliDetachedSupervisionSpec,
  CLI_PROGRESS_ADAPTERS,
  // D-209 §1.3 — the op-risk APPROVAL FLOOR (the single source the runtime clamp +
  // the composition/manifest authoring validators derive from). D-211 §2 adds
  // `clampToFloor` — the owner-override clamp (write-gate + fail-closed resolve) —
  // plus the ONE canonical approval vocabulary (ordered list + membership guard)
  // every consumer derives from instead of hand-copying the closed list.
  RISK_APPROVAL_FLOOR, approvalFloorForRisk, isApprovalBelowRiskFloor, clampToFloor,
  OPERATION_APPROVALS, isOperationApproval,
  // D-187 policy-matrix retirement (slice 3) — the op-risk APPROVAL replacement for the
  // (channel × actor) matrix: simple-form op-risk base + the stage-trust ceiling RELAX.
  resolveSimpleFormOperationPolicy, applyTrustCeiling,
  // D-182 §7 — shared cli tool-key derivation (the Local-tools grid universe deriver).
  cliToolFromConnectorRuntime, CLI_SYSTEM_BINARY_PREFIX,
  // D-182 §8 — door-exposability invariant: cli/service are never raw door tools.
  isExternallyExposableIngredient,
  // D-182 §8 — the canonical cli detector (the cli-half of the above); only cli
  // has the §7.2 reachability auth path, so the door-cli snapshot admit gates on it.
  isCliIngredient,
  // D-165 P3.path-picker (Slice 3) — pure path-scope enforcement helper.
  checkPathScope,
  // D-177 catalog open mode — one op's authority-bearing arg paths (the
  // never-exclude floor AND the open-projection guard set; one source of
  // truth for the publish-gate validator + the runtime walk closure).
  collectOperationAuthorityPaths,
  // D-177 N.2 — the op's api-binding path template (its `{{token}}` params are
  // authority-bearing target selectors), fed to `collectOperationAuthorityPaths`.
  operationPathTemplate,
  CONNECTION_GATEWAY_AUDIT_SOURCE,
  // D-165 P2 — closed-list guards + numeric policy bounds (shared by the
  // strict validator AND the runtime gateway's cache/timeout resolution).
  MEDIA_KINDS, isMediaKind, CATALOG_KINDS, isCatalogKind,
  OPERATION_IDEMPOTENCIES, isOperationIdempotency,
  GROUP_GRANT_DEFAULTS, isGroupGrantDefault,
  GROUP_UPGRADE_BEHAVIORS, isGroupUpgradeBehavior,
  CATALOG_DEFAULT_TIMEOUT_MS, CATALOG_MIN_OP_TIMEOUT_MS,
  CATALOG_OP_TIMEOUT_MULTIPLIER, CATALOG_REST_TIMEOUT_SOFT_CAP_MS,
  CATALOG_MAX_DEFAULT_TIMEOUT_MS, CATALOG_DEFAULT_CACHE_TTL_MS,
  CATALOG_MAX_CACHE_TTL_MS, CATALOG_CACHE_OUTLIER_MULTIPLIER,
  // D-165 P2 — surface/auth/binding closed-list arrays + guards + connector
  // lifecycle numeric bounds (shared by the strict validator AND a future
  // runtime gateway dispatch / connector supervisor).
  API_TRANSPORTS, isApiTransport, AUTH_KINDS, isAuthKind,
  OAUTH2_FLOWS, CALLBACK_URL_STRATEGIES, REST_METHODS, GRAPHQL_OPERATION_TYPES,
  // D-165 RUNTIME — per-queue poll-timeout ceilings + schema-source pin format.
  QUEUE_POLL_TIMEOUT_CAP_MS, CATALOG_SCHEMA_SOURCE_SHA256_REGEX,
  QUEUE_KINDS, API_EXECUTION_BINDING_KINDS, isApiExecutionBindingKind,
  REALTIME_API_BINDING_KINDS, isRealtimeApiBindingKind,
  CONNECTOR_TRANSPORTS, CONNECTOR_WIRE_PROTOCOLS, isConnectorWireProtocol,
  CONNECTOR_AUTH_METHODS, RECONNECT_POLICIES, CONNECTOR_EXECUTION_BINDING_KINDS,
  CLI_STDIN_HANDLINGS, CLI_OUTPUT_SHAPES,
  // D-185 Slice 2 / D-200 — backing list + temp/content-pinned ref guards.
  CLI_OUTPUT_STORAGES, isTempFileRef, isPinnedCasFileRef,
  CLI_DETACHED_MODES, CLI_DETACHED_COMPLETION_KINDS, CLI_DETACHED_CANCEL_KINDS,
  CATALOG_CONNECTOR_INVOKE_TIMEOUT_CAP_MS, CATALOG_CONNECTOR_STARTUP_TIMEOUT_CAP_MS,
  CATALOG_CONNECTOR_SHUTDOWN_TIMEOUT_CAP_MS, CATALOG_CONNECTOR_IDLE_DISCONNECT_MIN_MS,
  CATALOG_CONNECTOR_AUTH_WAIT_TIMEOUT_CAP_MS,
  // D-165 RUNTIME #4 — vendor → catalog-slug registry (multi-catalog grants;
  // shared by the server boot seed + grant rpcs + webclient grant panel).
  HUBSPOT_CATALOG_SLUG, SALESFORCE_CATALOG_SLUG, PIPEDRIVE_CATALOG_SLUG,
  EXA_CATALOG_SLUG, CATALOG_VENDOR_SLUGS,
  catalogSlugForVendor,
  // Connection-agnostic op dispatch (NEXT-1) — catalog-declared search dialect;
  // (write-verb reverse projection) — catalog-declared write body dialect;
  // (pagination) — catalog-declared cursor-follow dialect + walk-all ceilings.
  SEARCH_STYLES, isSearchStyle, WRITE_STYLES, isWriteStyle,
  PAGINATION_STYLES, isPaginationStyle,
  OPERATION_PAGINATION_STYLES, isOperationPaginationStyle,
  OPERATION_PAGINATION_PLACEMENTS, isOperationPaginationPlacement,
  PAGINATION_MAX_RECORDS, PAGINATION_MAX_PAGES,
  // D-271 — the closed reason list for an unprovable-by-construction op.
  OPENAPI_ABSENT_REASONS, OPENAPI_ABSENT_REASON_SET,
} from './ingredient-catalog.js';

// D-165 §"Contract namespace" / D-166 foundation — schema-driven contract
// storage substrate: schema-entry shapes + dispatch-role / merge-rule
// vocabularies + D-165's 5 composite_keys entries + self-consistency validator.
export type {
  DispatchRole, MergeRule, WriteableBy, CompositeKeySchema, ValueShape,
  ContractSchemaRegistry, ContractSchemaIssue, ContractSchemaIssueCode,
  ContractWriteIssue, ContractWriteIssueCode,
} from './contract-schema.js';
export {
  DISPATCH_ROLES, isDispatchRole, INVENTORY_DISPATCH_ROLES, isInventoryRole,
  MERGE_RULES, isMergeRule,
  WRITEABLE_BY, isWriteableBy, D165_CONTRACT_SCHEMA, validateContractSchemaRegistry,
  validateContractWrite,
} from './contract-schema.js';
// D-166 contract_definition — `contract_id` lifecycle: typed shapes + pure
// predicates (`contractLifecycleState` / `isContractActive` / `contractScopeMatches`).
// The store mint/use/expire/revoke ops + the use-resolution gating consume these.
export type {
  ContractScope, DoorExecutionPolicy, ContractDefinition, ContractLifecycleState,
  ContractScopeContext,
  MintContractRequest, ContractDefinitionView,
  ContractListRequest, ContractListResponse,
  BoundRecipeRef, SessionGrantBatchMember,
  ContractGrantKind,
  // D-187 §6 (step 7) — the level-1 door-type axis + the in-place edit rpc request.
  DoorType, AuthorableDoorType, DerivedDoorType, SetContractDoorTypesRequest,
  // D-186 Slice C — session-grant live-control surface DTOs.
  SessionGrantView, SessionGrantPermits,
  SessionGrantListRequest, SessionGrantListResponse, SessionGrantRevokeRequest,
} from './contract-definition.js';
export {
  CONTRACT_DEFINITION_SCOPE,
  // D-187 AMENDMENT (grant-foundation slice 3) — the canonical owner-contract id +
  // the bind/mint reserved-owner fence. Hoisted from the backend grant store so the
  // server gate and the D-174 webclient grant UI share one source of truth.
  OWNER_CONTRACT_ID, isReservedOwnerContractId,
  PUBLIC_CONTRACT_ID, isReservedPublicContractId,
  contractLifecycleState, isContractActive, contractScopeMatches,
  contractScopeAdmitsConnection,
  CONTRACT_GRANT_KINDS, isContractGrantKind, isStandingContractDefinition,
  isCustomerContractGrantKind,
  // D-202 — the quality-delegation grant-kind discriminator (second axis).
  isQualityDelegation,
  // D-187 §6 (step 7) — the level-1 door-type vocabulary + gate predicate.
  DOOR_TYPES,
  AUTHORABLE_DOOR_TYPES, isDoorType, contractPermitsDoorType,
  // D-209 Task 3 — the derived (mint-only) partition of DOOR_TYPES + the
  // explicit-membership classifier every owner surface shares.
  DERIVED_DOOR_TYPES, derivedDoorType,
} from './contract-definition.js';
// D-177 P2 — the N.4 session-grant match predicate (pure). A session grant is a
// `contract_definition` row with `grant_kind: 'session'`, consumed at the
// Gateway's ask-branch (never policy-merged — D2); the server-side resolver +
// the commit Gateway's `sessionGrants` seam evaluate this predicate per ask.
// D-177 N.13 (P6a) — the delegation-rule arm of the same predicate: a
// `grant_kind: 'delegation'` row (ladder-6 standing rule) is scope-bound
// instead of session-bound, `write`-only in v1, exact/open modes only —
// consumed at the same ask-branch, inert until P6c mints one.
export type { SessionGrantMatchContext, ScopedSenderCandidate } from './session-grant.js';
export {
  DELEGATION_RULE_MAX_USES,
  DELEGATION_RULE_RISK_TIERS,
  DELEGATION_RULE_TTL_MS,
  SESSION_GRANT_RISK_TIERS,
  matchesDelegationRule,
  matchesSessionGrant,
  isDoorMatchContext,
  scopedContainmentAdmits,
  // D-177 N.11 rule 5 (slice D) — the gate-side destination extraction (5.d
  // email shape only, 5.i.3) + the structurally-bound path exemption list.
  SCOPED_STRUCTURAL_AUTHORITY_PATHS,
  extractScopedDestinationEmails,
} from './session-grant.js';
// D-202 — Quality Delegation: the PURE second-axis vocabulary. The coarse
// (recipe, op)-grain quality matcher (sibling of `matchesDelegationRule`), the
// Switch A/B kill-switch as a gate-override, and the three-conjunct send gate
// (`authorization ∧ per-region quality ∧ whole-document`). Slice 0 ships the
// degenerate single-node case; the region model + reason-code taxonomy are
// reserved (§14). The store mint + gate wiring + #contracts surface consume these.
export type {
  QualityVerdictReason,
  QualityRegion,
  QualityDelegationMatchContext,
  QualityGateSwitches,
  QualityGateSwitchStatus,
  AuthorizationVerdict,
  QualitySendVerdict,
  ThreeConjunctReason,
  ThreeConjunctResult,
  ThreeConjunctGateInputs,
} from './quality-delegation.js';
export {
  QUALITY_DELEGATION_GRANT_KIND,
  QUALITY_VERDICT_REASONS,
  reasonTrainsQuality,
  matchesQualityDelegation,
  NO_QUALITY_GATE_PAUSE,
  authorizationDelegationPaused,
  qualityDelegationPaused,
  evaluateThreeConjunctGate,
} from './quality-delegation.js';
// D-202 task 4a / D-211 Slice 3 — compose the captured pre-lift authorization
// conjunct with the quality three-conjunct gate.
export { resolveQualityGateDecision } from './quality-gate-decision.js';
export type { QualityGateDecisionInputs } from './quality-gate-decision.js';
// D-196 Seller Economy — seller settings/tier/customer/usage substrate shapes.
export type {
  SellerLifecycleSource,
  SellerAccessState,
  SellerCustomerCloseReason,
  SellerOfferKind,
  SellerOfferPricingKind,
  SellerOfferState,
  SellerOffer,
  SellerOfferEnsureResult,
  SellerOfferFulfillmentAttachResult,
  SellerOfferStateTransitionRequest,
  SellerOfferStateTransitionResult,
  SellerOfferStateTransitionResponse,
  SellerUsageKind,
  SellerUsagePeriodGranularity,
  SellerSettings,
  SellerTier,
  SellerTierPublic,
  SellerCustomer,
  SellerCustomerUsageRollup,
  SellerOverviewReadinessKey,
  SellerOverviewReadinessState,
  SellerOverviewReadinessItem,
  SellerOverviewCounts,
  SellerOverviewLlmGateway,
  SellerOverview,
  SellerSettingsUpdateRequest,
  SellerSettingsUpdateResponse,
  SellerManualTierUpsertRequest,
  SellerTierUsagePolicyRequest,
  SellerTierUsagePolicyResponse,
  SellerManualTierUpsertResponse,
  SellerCreatePassTierRequest,
  SellerCreatePassTierResponse,
  SellerManualCustomerIssueRequest,
  SellerCustomerClaim,
  SellerCustomerClaimEmailDelivery,
  SellerManualCustomerIssueResponse,
  SellerManualCustomerTargetRequest,
  SellerManualCustomerExtendRequest,
  SellerManualCustomerExtendResponse,
  SellerManualCustomerSwapTierRequest,
  SellerManualCustomerSwapTierResponse,
  SellerManualCustomerCloseRequest,
  SellerManualCustomerCloseResponse,
  SellerManualCustomerReissueTokenRequest,
  SellerManualCustomerReissueTokenResponse,
  SellerManualTierBulkAdjustRequest,
  SellerManualTierBulkAdjustResponse,
  SellerStripeSynchronizeRequest,
  SellerStripeSynchronizeResponse,
  SellerProviderSource,
  SellerProviderTierSynchronizeRequest,
  SellerProviderTierSynchronizeResponse,
  SellerAcknowledgeLlmGatewayPaidRequest,
  SellerAcknowledgeLlmGatewayPaidResponse,
  SellerCustomerIssueOutcome,
} from './seller.js';
// The reusable convergent-write primitive the seller pack's paired procedural
// recipes are built on (extracted 2026-07-27). Adopt this rather than re-typing
// `'created' | 'extended'` at a new site.
export type { ConvergentWriteResult } from './convergent-write.js';
export { CONVERGENT_WRITE_RESULTS } from './convergent-write.js';
export {
  SELLER_OFFER_KINDS,
  SELLER_OFFER_ID_MAX_LENGTH,
  SELLER_OFFER_PRICING_KINDS,
  SELLER_OFFER_PRICING_REQUIRES_AMOUNT,
  sellerOfferPricingRequiresAmount,
  SELLER_OFFER_STATES,
  SELLER_OFFER_STATE_TRANSITIONS,
  SELLER_LIFECYCLE_SOURCES,
  SELLER_DEFAULT_DOOR_ID,
  SELLER_RETIRED_LIFECYCLE_SOURCES,
  SELLER_ACCESS_STATES,
  SELLER_CUSTOMER_CLOSE_REASONS,
  SELLER_USAGE_KINDS,
  SELLER_USAGE_PERIOD_GRANULARITIES,
  isSellerLifecycleSource,
  isSellerOfferId,
  toPublicSellerTier,
  isSellerOfferKind,
  isSellerOfferPricingKind,
  isSellerOfferState,
  isSellerOfferStateTransitionAllowed,
  isSellerAccessState,
  isSellerCustomerCloseReason,
  isSellerUsageKind,
  isSellerUsagePeriodGranularity,
  LLM_GATEWAY_PAID_ACK_VERSION,
  isLlmGatewayPaidAcknowledged,
} from './seller.js';
// D-196 consolidation (2026-09-03) — the ONE seller provider registry. Server
// tables, readiness, the Settings form, the corpus ratchets, and the recipe
// generator's parity test all derive from it.
export {
  SELLER_PROVIDERS,
  SELLER_PROVIDER_SOURCES,
  SELLER_PROVIDER_LIVE_STATUS_ALIASES,
  isSellerProviderSource,
  sellerProviderFor,
} from './seller-providers.js';
export type {
  SellerProviderSpec,
  SellerProviderTierIdentity,
} from './seller-providers.js';

// D-207 §4.2–4.3 — `core.seller.order`, the money leg.
export type {
  SellerOrder,
  SellerOrderPhase,
  SellerOrderEvidencePhase,
  SellerOrderBucket,
  SellerOrderOriginKind,
  SellerOrderKeyParts,
  SellerOrderCheckoutCorrelation,
  // D-207 slice 3d — the VERIFIED artifact pin (a `data.file` record id does not
  // determine its bytes; the ref can be repointed under an approved order).
  SellerOrderArtifactPinRefusal,
  SellerOrderArtifactPinResult,
  SellerOrderCasFileReader,
  // D-207 order-is-the-lifecycle — the owner list surface (`server.seller.listOrders`).
  SellerListOrdersRequest,
  SellerListOrdersResponse,
} from './seller-order.js';
// D-207 slice 3d — the outbound send CLAIM: the general no-resend fence. The
// provider lookup was already general; the durable pre-dispatch record was not.
export type { MailSendClaim, MailSendClaimStatus } from './mail.js';
export {
  MAIL_SEND_CLAIM_STATUSES,
  MAIL_SEND_CLAIM_SETTLED_STATUSES,
  isMailSendClaimStatus,
  isMailSendClaimSettled,
  mailSentReconciliationQueryFor,
} from './mail.js';
export {
  SELLER_ORDER_PHASES,
  SELLER_ORDER_EVIDENCE_PHASES,
  SELLER_ORDER_BUCKETS,
  SELLER_ORDER_PHASE_BUCKET,
  SELLER_ORDER_PHASE_TRANSITIONS,
  SELLER_ORDER_PRE_PAYMENT_PHASES,
  SELLER_ORDER_ORIGIN_KINDS,
  SELLER_ORDER_KEY_PREFIX,
  SELLER_ORDER_KEY_MAX_LENGTH,
  SELLER_ORDER_HANDLE_PREFIX,
  SELLER_ORDER_HANDLE_BYTES,
  SELLER_ORDER_CHECKOUT_IDEMPOTENCY_SUFFIX,
  SELLER_ORDER_PROVIDER_IDEMPOTENCY_KEY_MAX_LENGTH,
  SELLER_ORDER_LIST_DEFAULT_LIMIT,
  SELLER_ORDER_LIST_MAX_LIMIT,
  clampSellerOrderListLimit,
  isSellerOrderPhase,
  isSellerOrderEvidencePhase,
  isSellerOrderTransitionOpTarget,
  isSellerOrderTransitionAllowed,
  isSellerOrderOriginKind,
  isSellerOrderOriginRef,
  isSellerOrderKey,
  isSellerOrderHandle,
  sellerOrderBucket,
  sellerOrderKey,
  sellerOrderKeyParts,
  sellerOrderCheckoutCorrelation,
  verifySellerOrderArtifactPin,
} from './seller-order.js';
// D-177 N.11 rule 5 (rev 10) — the `'scoped'` session-scope overlay's closed
// source vocabulary (v1 = `'forwarded_item_sender'` only).
export { SCOPED_GRANT_SOURCES } from './contract-definition.js';
export type { ScopedGrantSource } from './contract-definition.js';
// D-177 P3/P4 — the mint surface: the mint-side envelope context, the N.6
// cell-defaults shape + the per-cell seed values (P4 moved chat's onto the
// seeded cell; P5 seeded the other two attended ask-channels — the constants
// double as the resolver's no-row fallback + the put-path floor, kept in
// lockstep through SESSION_GRANT_DEFAULT_SEEDS), the N.5 offer resolver (P4:
// reads the baseline cell through the optional `scan`), the fail-closed row
// reader, and the canonical-lattice projection the floor guard ranks with.
export type {
  SessionGrantDefaults,
  SessionGrantMintContext,
  SessionGrantOffer,
} from './session-grant.js';
export {
  CHAT_SESSION_GRANT_DEFAULTS,
  MCP_SESSION_GRANT_DEFAULTS,
  MESSENGER_SESSION_GRANT_DEFAULTS,
  REACTIVE_SESSION_GRANT_DEFAULTS,
  RECEPTION_SESSION_GRANT_DEFAULTS,
  SCHEDULE_SESSION_GRANT_DEFAULTS,
  SESSION_GRANT_DEFAULT_SEEDS,
  resolveSessionGrantOffer,
  seededSessionGrantDefaults,
} from './session-grant.js';
// D-177 N.13 (P6b) — staged-trust suggestion vocabulary: the N.13 aggregation
// key + canonical key hash, the suggestion row/snapshot/evidence shapes, the
// pure key derivation + threshold evaluation the housekeeping learner runs,
// and the learner's task id / scope / threshold constants. Pure throughout —
// the gate hot path imports nothing from here (N.9.8).
export type {
  DelegationRuleSuggestionEvidence,
  DelegationRuleSuggestionKey,
  DelegationRuleSuggestionRow,
  DelegationRuleSuggestionSnapshot,
  DelegationRuleSuggestionState,
} from './delegation-suggestion.js';
export {
  DELEGATION_RULE_SUGGESTION_SCAN_TASK_ID,
  DELEGATION_RULE_SUGGESTION_SCOPE,
  DELEGATION_SUGGEST_LOOKBACK_MS,
  DELEGATION_SUGGEST_SAMPLE_CONTRACT_IDS_MAX,
  DELEGATION_SUGGEST_THRESHOLD,
  delegationRuleMintPlanFromSnapshot,
  delegationRuleSuggestionKeyHash,
  deriveDelegationRuleSuggestionKey,
  evaluateDelegationRuleSuggestionGroup,
} from './delegation-suggestion.js';
// D-202 — quality-delegation suggest→accept vocab (the accept-side mint-plan +
// row/snapshot/key). The suggestion SOURCE (learner) is Slice 1.
export type {
  QualityDelegationSuggestionKey,
  QualityDelegationSuggestionSnapshot,
  QualityDelegationSuggestionEvidence,
  QualityDelegationSuggestionState,
  QualityDelegationSuggestionRow,
} from './quality-delegation-suggestion.js';
export {
  QUALITY_DELEGATION_SUGGESTION_SCAN_TASK_ID,
  QUALITY_DELEGATION_SUGGESTION_SCOPE,
  qualityDelegationSuggestionKeyHash,
  qualityDelegationMintPlanFromSnapshot,
} from './quality-delegation-suggestion.js';
// D-202 Slice 1 — the reject-driven quality LEARNER's durable verdict signal +
// pure derivation (key projection, suppression-join key, reject-driven threshold).
export type { QualityDelegationSignal } from './quality-delegation-signal.js';
export {
  QUALITY_DELEGATION_SIGNAL_SCOPE,
  QUALITY_DELEGATION_SUGGEST_THRESHOLD,
  QUALITY_DELEGATION_SUGGEST_LOOKBACK_MS,
  QUALITY_DELEGATION_SUGGEST_SAMPLE_REFS_MAX,
  qualityDelegationSignalKey,
  deriveQualityDelegationKeyFromGrant,
  evaluateQualityDelegationSuggestionGroup,
} from './quality-delegation-signal.js';
// D-177 N.11 rule 5 (5.c, slice C) — the scoped-grant proposal vocabulary:
// the deterministic closed-4-tuple utterance parser, the suggestion row
// shape (separate kind — never the delegation store, 5.i.2), the canonical
// key hash, the tighten-only code-constant bounds, and the rule-7 sentence.
export type {
  ScopedGrantSuggestionRow,
  ScopedGrantSuggestionSnapshot,
  ScopedGrantUtteranceParse,
} from './scoped-grant-suggestion.js';
export {
  SCOPED_GRANT_EXCERPT_MAX_CHARS,
  SCOPED_GRANT_MAX_USES_CEILING,
  SCOPED_GRANT_MAX_USES_DEFAULT,
  SCOPED_GRANT_SUGGESTION_SCOPE,
  SCOPED_GRANT_TTL_MS_CEILING,
  SCOPED_GRANT_TTL_MS_DEFAULT,
  parseScopedGrantUtterance,
  renderScopedGrantSentence,
  scopedGrantSuggestionKeyHash,
  stripEmbeddedContent,
} from './scoped-grant-suggestion.js';
// D-177 P5b — open-ended session grants (N.11): the taint-propagation
// provenance walker (run at the commit Gateway off the host's recipe+stores
// closure), the normative `open_projection` structure + its fail-closed
// stored-row validation (the N.4 'open' arm reads it), the wire-authority
// baseline shared with the `hash_exclude_args` publish gate (one authority
// set, two consumers — N.2), and the ask-rendering preview.
export type {
  ComputeOpenProjectionArgs,
  OpenOriginClass,
  OpenProjection,
  OpenProjectionArg,
  OpenProjectionComputation,
  OpenProjectionPreview,
  OpenProjectionRefusal,
  OpenProjectionRoot,
} from './open-projection.js';
export {
  OPEN_PINNED_ORIGINS,
  OPEN_PREVIEW_MAX_LINES,
  OPEN_PROJECTION_MAX_BYTES,
  OPEN_PROJECTION_MAX_NODES,
  OPEN_TAINTED_ORIGINS,
  WIRE_AUTHORITY_ARG_PATHS,
  computeOpenProjection,
  isOpenProjectionRefusal,
  isWellFormedOpenProjection,
} from './open-projection.js';
// D-177 read-gating analog — per-door read-collection grant (the read-side
// twin of N.12: the timeline meta-tool bypasses the per-dispatch scope gate,
// so the gateway derives the readable-collection enum from the door's
// `scope_restrictions` — the SAME axis the ingredient gate uses — and the read
// executor filters. Empty restrictions = admit-all (the tool gate is the
// fail-closed backstop); ingredient reads already gated via deriveDispatchScope.
// Vector search is a separate plane (enrichment topics, D-136 MCP visibility).
export {
  READABLE_COLLECTIONS,
  isReadableCollection,
  scopeRestrictionsFromReadableCollections,
  SCOPE_FENCE_KEEP_PATTERNS,
} from './read-collection-grant.js';
export type { ReadableCollection } from './read-collection-grant.js';
// Grant-foundation slice 3a (D-187 amendment 693b7d03) — the unified grant-entry
// id taxonomy (op / collection / topic) the physical grant store keys on + both
// R22 transpose UIs read. Pure: typed formatters + syntactic prefix classifier.
export {
  GRANT_ENTRY_KINDS,
  COLLECTION_GRANT_PREFIX,
  TOPIC_GRANT_PREFIX,
  RESERVED_GRANT_ENTRY_PREFIXES,
  DECLARED_OPERATION_ID_RESERVED_PREFIXES,
  collectionGrantEntry,
  topicGrantEntry,
  opGrantEntry,
  peerLabelGrantEntry,
  PEER_LABEL_GRANT_PREFIX,
  KERNEL_GRANT_PREFIX,
  PRIMITIVE_GRANT_PREFIX,
  primitiveGrantEntry,
  INGREDIENT_GRANT_PREFIX,
  declaredOperationIdReservedPrefix,
  classifyGrantEntry,
  parseGrantEntry,
  isOpGrantEntry,
  isCollectionGrantEntry,
  isTopicGrantEntry,
  // D-247 D1 — the fifth kind.
  RECIPE_GRANT_PREFIX,
  recipeGrantEntry,
  isRecipeGrantEntry,
} from './grant-entry.js';
export type { GrantEntryKind, ParsedGrantEntry } from './grant-entry.js';
// Grant-foundation slice 3 — the pure grant-resolution rule (`explicit ?? authorDefault`)
// + the `verb-op ∧ entry` read gate. Both decoupled from store + registry (booleans in).
// Slice 3b — the OWNER-default-only sensitive-surface set + its author-default override.
export {
  resolveGrantEntry,
  isGrantedReadAdmissible,
  OWNER_DEFAULT_ONLY_GRANT_ENTRIES,
  isOwnerDefaultOnlyEntry,
  isGeneratedPackOpEntry,
  ownerOnlyAdjustedAuthorDefault,
} from './grant-resolve.js';
// D-177 P5a — batched approval (N.10): the channel-resolved origin unit, the
// one reviewable payload shape, the durable batch-ask row vocabulary
// (`open | closing | answered`), and the pure rendering helpers. The store
// lives in `@recued/storage`; the join/answer flow in `backend/server`.
export type {
  BatchAskKey,
  BatchAskMember,
  BatchAskRecord,
  BatchAskState,
  BatchedApprovalItem,
  BatchedApprovalPayload,
  OriginUnit,
  OriginUnitKind,
} from './batched-approval.js';
export {
  BATCH_ARGS_PREVIEW_MAX_BYTES,
  BATCH_ASK_MAX_MEMBERS,
  BATCH_ASK_RENDER_MAX_ITEMS,
  BATCH_GRANT_TTL_MS,
  batchAskKeyMatches,
  deriveOriginUnit,
  projectBatchedApprovalPayload,
  renderBatchItemsBlock,
  summarizeArgsPreview,
} from './batched-approval.js';
// D-166 override-write path — rpc DTOs + pure wire normalizer for the
// `collection.contract.*` family that authors `contract.override.*` rows (the
// editable tightening layer the Slice 4d.4 catalog gateway reads).
export type {
  OverrideRiskCeiling, OverridePolicyInput, OverrideView,
  CatalogOperationView, CatalogIngredientView,
} from './contract-override.js';
export {
  OVERRIDE_SCOPE, overrideRowValue, isEmptyOverridePolicy,
  catalogIngredientViews,
} from './contract-override.js';
// D-211 — global owner replacements for pack operation defaults. Separate from
// actor-scoped contract.override tightening by construction.
export type {
  OwnerOperationPolicyInput, OwnerOperationView,
  OwnerOperationSpecView, OwnerOperationIngredientView,
  OwnerOperationUpdateReviewItem,
} from './owner-operation-override.js';
export {
  OWNER_OPERATION_SCOPE, ownerOperationRowValue,
  isEmptyOwnerOperationPolicy, readOwnerOperationOverride,
  ownerOperationIngredientViews, operationSpecHash, isOperationSpecHash,
} from './owner-operation-override.js';
// D-166 §"Merge algebra formalization" — the pure contract-policy merge engine
// (field lattices + applyMergeRule + composeRows + wouldLoosen). composeForRole
// dispatcher + tightening_only write-enforcement consume these in a later slice.
export type {
  FieldDomain, StricterDirection, FieldLattice,
  ContractMergeRow, MergeConflict, ComposeResult,
} from './contract-merge.js';
export {
  FIELD_LATTICES, ContractMergeError,
  applyMergeRule, composeRows, wouldLoosen,
} from './contract-merge.js';
// D-166 Slice 4a — value_shape → canonical policy-field projection. Bridges the
// D-165 value_shape storage names onto the FIELD_LATTICES canonical names so the
// dispatcher (4b) + tightening_only write-enforcement (4c) feed projected rows
// straight into composeRows / wouldLoosen.
export type {
  PolicyProjection, PolicyProjectionIssue, PolicyProjectionIssueCode,
} from './contract-project.js';
export {
  POLICY_PROJECTIONS, isPolicyValueShape, projectToPolicyFields,
  validatePolicyProjections,
} from './contract-project.js';
// D-166 Slice 4b — composeForRole dispatcher (pure; injected scan). Gathers a
// role's contributing scopes, scans rows for a ResolutionContext, projects (4a)
// + folds (Slice 3) policy roles, returns the row set for inventory roles. The
// 4d gateway slice supplies the real scan over ContractStore.
export type {
  ResolutionContext, ContractRowLike, ScanFn, RoleComposition,
  // D-166 Slice 4d.2 — per-role field ownership + merge + resolution projection.
  MergedRolePolicy, RoleOwnershipIssue, RoleOwnershipIssueCode,
} from './contract-dispatch.js';
export {
  composeForRole,
  // D-166 Slice 4d.2 — resolves the 4b deferred P2 (per-role field ownership).
  ROLE_OWNED_FIELDS, mergeRoleResults, projectToResolution, validateRoleOwnership,
} from './contract-dispatch.js';

// D-119 Phase 15 — execution scope (recipe + ingredient install gate).
// D-126 Phase 1.2 — DeviceClass + kindToScope per-kind lookup.
export type { ExecutionScope, DeviceClass } from './execution-scope.js';
export {
  ALL_EXECUTION_SCOPES,
  ALL_DEVICE_CLASSES,
  kindToScope,
  isValidExecutionScope,
  isExecutionScopeSubset,
  sortExecutionScope,
  deriveIngredientScope,
  deriveExecutionScope,
  effectiveExecutionScope,
  executionScopeLabel,
} from './execution-scope.js';

// Types — vault
export type { VaultRow } from './vault.js';
export type { FormatHint, EscapeHint, RefHint } from './values.js';
export type { NamespaceStores } from './resolve.js';

// Types — cache (wire shape; runtime bits live in @recued/cache)
export type { CacheEntry } from './cache.js';

// Types — approval (staged trust + background consent)
export type {
  TriggerSource,
  ApprovalDecision, ApprovalRequest, ApprovalResponse, RecipeTrustState, TrustLevel,
  SessionApproval, BackgroundConsent, PendingAction,
} from './approval.js';
export { TRUST_THRESHOLDS, SESSION_LIMITS } from './approval.js';

// D-113 — Multi-surface approval channels + gossip protocol.
export type {
  ApprovalPermission,
  ApprovalExtensionChannel, ApprovalSlackChannel,
  ApprovalTelegramChannel, ApprovalEmailChannel,
  ApprovalChannelConfig,
  SlackChannelHandle, TelegramChannelHandle,
  ApprovalPendingRecord, ApprovalResolutionKind, ApprovalResolutionRecord,
  WorkerDispatchKind, WorkerDispatchPayload, WorkerDispatch,
  ApprovalListPayload, ApprovalStatusPayload, ApprovalActionPayload,
  ApprovalChannelVerifyPayload,
  DispatchCallback,
  EncryptedBlob,
  HeartbeatApprovalsPayload, HeartbeatBindings,
} from './approval.js';
export {
  HEARTBEAT_INTERVAL_STEADY_MS, HEARTBEAT_INTERVAL_BURST_MS,
  HEARTBEAT_BURST_DURATION_MS,
  PAIR_TTL_MS, ITEM_TTL_MS, OWNER_GRACE_WINDOW_MS,
  DISPATCH_EXPIRY_MS, ROUTING_TABLE_ENTRY_TTL_MS,
  RECENT_RESOLVED_WINDOW_EXT_MS,
  CHAT_CHANNEL_DEFAULT_TTL_MS, EMAIL_CHANNEL_DEFAULT_TTL_MS,
} from './approval.js';

// D-114 — Unified cloud→instance dispatch (encrypted-payload kinds).
export type {
  RunRecipePlaintext, CronRecipePlaintext, RecipeBackfillPlaintext,
  ReactiveRecipePlaintext, ChatMessageRelayPlaintext, AdminCommandPlaintext,
  EncryptedDispatchPlaintext,
} from './approval.js';
export {
  DISPATCH_RESULT_TTL_SEC, DISPATCH_PENDING_TTL_SEC,
  DISPATCH_TELEGRAM_TTL_SEC, CHAT_MESSAGE_RELAY_TTL_MS,
} from './approval.js';

// Types — recipe updates
export type { UpdateInfo, UpdateRecord } from './update.js';

// Types — installation records and health
export type {
  RecipeStatus, InstalledRecipeRecord, InstalledIngredientRecord,
  RecipeHealthStatus, RecipeHealthCheck, UpdateImpact,
} from './installation.js';

// D-170 — ingredient-authoring install / uninstall rpc wire types.
export type {
  AuthoringValidationIssue,
  IngredientInstalled,
  IngredientInstallArgs,
  IngredientInstallResult,
  IngredientUninstallArgs,
  IngredientUninstallResult,
  // N.4 / N.15 — draft store + test-before-save preview wire types.
  IngredientDraft,
  IngredientDraftSummary,
  IngredientDraftSaveArgs,
  IngredientDraftSaveResult,
  IngredientDraftGetArgs,
  IngredientDraftGetResult,
  IngredientDraftListResult,
  IngredientDraftDeleteArgs,
  IngredientDraftDeleteResult,
  CompositionDecomposeArgs,
  CompositionDecomposeResult,
  CompositionDecomposeArtifacts,
  CompositionReviewArtifactShape,
  CompositionReviewOperationFamily,
  CompositionReviewFieldPrivacy,
  CompositionReviewCounts,
  CompositionReviewSummary,
  CompositionReviewView,
  IngredientSaveAsNewArgs,
  IngredientSavedAsNew,
  IngredientSaveAsNewResult,
  IngredientPreviewArgs,
  IngredientPreviewResult,
  IngredientPreviewTarget,
  IngredientPreviewExecution,
  IngredientPreviewFieldMapping,
  IngredientPreviewSkipReason,
} from './ingredient-authoring-rpc.js';
export {
  INGREDIENT_DRAFT_MAX_BYTES,
  INGREDIENT_DRAFT_MAX_COUNT,
  INGREDIENT_PREVIEW_MAX_OUTPUT_BYTES,
} from './ingredient-authoring-rpc.js';

// Types — entitlements (Pro gating)
export type { Tier, Entitlement, EntitlementProvider } from './entitlements.js';
export { isPro, isAnonymous, isExpired } from './entitlements.js';

// Vault scoping
export { scopedVaultKey, publisherForIngredient, isValidVaultScope } from './scope.js';

// D-119 Phase 12 — Canonical record system fields (`_id` + `_collection`).
export type {
  CanonicalRecord,
  CanonicalCollectionName,
  CanonicalSystemField,
} from './canonical-record.js';
export {
  CANONICAL_SYSTEM_FIELDS,
  isCanonicalSystemField,
  extractCanonicalRef,
  stampCanonicalFields,
} from './canonical-record.js';

// D-119 Phase 13 — Annotation + Link warehouse collections.
export type {
  Annotation,
  AnnotationFilter,
  AnnotationSearchQuery,
  AnnotationSearchMatch,
  Link,
  LinkFilter,
} from './annotation.js';

// D-120 — Memory + provenance substrate constants + provenance link
// taxonomy (engine-emitted; distinct from the D-119 Phase 13 `Link`
// warehouse collection above).
export {
  MEMORY_RETENTION_DEFAULT_DAYS,
  MEMORY_READ_PERMISSION,
  ENRICHMENT_WRITE_PERMISSION,
  CONNECTION_READ_PERMISSION_PREFIX,
  isConnectionReadPermission,
  AUDIT_OUTPUT_STRING_MAX,
  RECIPE_INSIGHT_FLATTENED_MAX_BYTES,
  CONTEXT_RECIPE_MAX_BYTES,
  MEMORY_DATA_SUBNAMESPACE,
  AUDIT_DATA_SUBNAMESPACE,
  MEMORY_DATA_ALIAS_SUBNAMESPACE,
  AUDIT_READ_PERMISSION,
  memoryDataPermissionFor,
  MEMORY_DATA_SUBNAMESPACES,
  isMemoryDataSubnamespace,
  RUN_MODES,
  DEFAULT_RUN_MODE,
  MANUAL_TRIGGER_RUN_MODE,
  isRunMode,
  TIMELINE_AXES,
  TIMELINE_AXIS_DEFAULT,
  isTimelineAxis,
} from './memory.js';
export type { RunMode, TimelineAxis } from './memory.js';
// D-153 P1 — Commit substrate (audit rows graduate into commits).
export {
  COMMIT_KINDS,
  isCommitKind,
  COMMIT_STATUSES,
  isCommitStatus,
  TERMINAL_COMMIT_STATUSES,
  isTerminalCommitStatus,
  ACTORS,
  isActor,
  executionSourceContractId,
  executionSourceHasContract,
  STDIO_MCP_TOKEN_ID,
  isDelegatedMcpToken,
  isDoorDispatchSource,
  renderActorLabel,
  CHANNELS,
  isChannel,
  isExecutionSource,
  isContractSnapshot,
  standingClosureAdmits,
  STANDING_CLOSURE_RISK_TIERS,
  MAX_DISPATCH_DEPTH,
  nextDispatchDepth,
  isCommit,
  RUN_ANCHOR_STATUSES,
  isRunAnchorStatus,
  isHeldRunAnchorStatus,
  RUN_DEGRADATIONS,
  isRunDegradation,
} from './commits.js';
export type {
  CommitKind,
  CommitStatus,
  Actor,
  ActorLabel,
  Channel,
  ExecutionSource,
  ContractSnapshot,
  Commit,
  RunAnchorStatus,
  RunDegradation,
} from './commits.js';
// D-177 P1 — the canonical action-identity primitive (ActionEnvelope view +
// the two stamped hashes + the op-level volatile-exclusion validator).
export {
  canonicalArgHash,
  projectResolvedArgs,
  validateHashExcludeArgs,
} from './action-envelope.js';
export type {
  ActionEnvelope,
  ArgHashes,
  HashExcludeArgs,
  HashExcludeViolation,
  HashExcludeViolationReason,
  HashExcludeValidation,
} from './action-envelope.js';
// D-161 Part B (P1) — the `origin_actor` provenance facet. Propagates
// the one D-153 actor model into the data substrate (warehouse / memory
// / links / enrichment rows) as a write-time provenance stamp.
export {
  SYSTEM_ORIGIN,
  originProvenanceFromSource,
  originProvenanceFromOptionalSource,
  originProvenanceFromActor,
  isOriginProvenance,
  // D-177 N.11 rule 1 — write-surface facet + stored-cleanliness predicate.
  ORIGIN_SURFACES,
  isOriginSurface,
  isUserCleanStoredRow,
} from './origin-provenance.js';
export type {
  OriginProvenance,
  OriginSurface,
  StoredRowProvenance,
} from './origin-provenance.js';
// D-161 Part B (P2) — input-provenance trust axis. The per-producer
// provenance-filter that reads the P1 `origin_actor` stamp to decide
// whether a source row is safe to process — distinct from D-132's
// `enrichment_trust` (I-8), conservative `user_self`+`system` default.
export {
  DEFAULT_ORIGIN_ACCEPTANCE,
  resolveOriginAcceptance,
  isOriginActorAccepted,
  readSourceOriginActor,
} from './input-provenance.js';
// D-161 Part B (P3) — timeline / Memory actor lanes. The consumer-side
// read of the P1 `origin_actor` stamp: the aggregate "Recent activity"
// feed foregrounds `user_self`+`system` and treats `contracted_user`/
// `anonymous` as a filterable lane (reachable, never dropped — I-7).
// O-2 settled as a general `origin_actor` filter facet, not a fixed
// three-lane enum (I-6: propagate the one actor model).
export {
  TIMELINE_DEFAULT_ORIGIN_ACTORS,
  originActorPassesTimelineFilter,
  sanitizeTimelineOriginFilter,
} from './timeline-lanes.js';
// D-161 Part B (P4) — provenance-honesty attribution. The last phase:
// when an outside-actor row surfaces it renders attributed ("agent X,
// under contract Y, asserted this" / "visitor-derived"), never as the
// user's own knowledge (I-10). O-3 settled as RENDER, not store — a
// derived view over the P1/P2 origin facet + the commit's existing
// `contract_snapshot` (N.8); first-person rows produce `undefined`,
// keeping the gold path byte-identical (I-9).
export {
  renderProvenanceAttribution,
  agentIdFromSource,
  provenanceAttributionFromSource,
  isProvenanceAttribution,
} from './provenance-attribution.js';
export type {
  ProvenanceAttribution,
  ProvenanceAttributionKind,
  ProvenanceAttributionInput,
} from './provenance-attribution.js';
// D-157 P1 — preflight checkpoint substrate. The resumable state a
// preflight-gated run is re-instantiated from; contracts ship the
// shape + guard, `@recued/storage` ships the `CheckpointStore`.
export { isCheckpoint } from './checkpoint.js';
export type {
  Checkpoint,
  PreflightApprovedTarget,
  PreflightCheckpointContext,
} from './checkpoint.js';
export type {
  ForeachCheckpointProgress,
  ForeachCheckpointResult,
} from './foreach-checkpoint.js';
export { hashForeachCheckpointSource } from './foreach-checkpoint.js';
// D-157 P1 — preflight pause signal. Thrown from an `ingredientExecutor`
// when the policy matrix yields `'ask'`; the engine catches it distinctly
// from a normal step error, snapshots `step.*`, and ends the run with
// `awaiting_approval` (P1 slice 3). The gateway wrapper raises it on a
// real `ask` (P1 slice 4); test fixtures raise it in slice 3 unit tests.
export {
  PREFLIGHT_REQUIRED_SIGNAL_NAME,
  PreflightRequiredSignal,
  isPreflightRequiredSignal,
} from './preflight-signal.js';
export type {
  PreflightSignalDetails,
  PreflightOverrideOffer,
} from './preflight-signal.js';
// D-153 / D-187 — admission-decision primitives: the AdmissionDecision shape +
// the scope fence (the matrix merge/tool-gate were retired with the matrix).
export {
  ADMISSION_DENY_CODES,
  isAdmissionDenyCode,
  evaluateScopeRestrictions,
  matchScopePattern,
  deriveDispatchScope,
} from './policy-enforcement.js';
export type {
  AdmissionDenyCode,
  AdmissionDecision,
  AdmissionVerdict,
  ToolUnderEvaluation,
} from './policy-enforcement.js';
// D-187 policy-matrix retirement (slice 4) — the op-risk × stage-trust APPROVAL bridge
// the four matrix chokepoints call instead of admitWithPolicyMatrix. Also the new home
// of the outbound-send slug set + lift (relocated from policy-matrix-dispatch.ts's
// now-deleted escalateOutboundSend — the send-approval promise survives the matrix).
export {
  admitByOpRisk,
  // D-202 task 4a — the authorization conjunct: op-risk under the ceiling with the
  // quality-review (outbound-send / commitment-proposal) lifts stripped.
  admitByOpRiskWithoutQualityLifts,
  admitContractToolAccess,
  resolveTrustCeiling,
  CONTRACT_LESS_TRUST_CEILING,
  CONTRACTED_DEFAULT_TRUST_CEILING,
  OUTBOUND_SEND_INGREDIENT_SLUGS,
  isOutboundSendSlug,
  // D-192 F1 — the all-actor commitment-proposal approval lift.
  COMMITMENT_PROPOSAL_INGREDIENT_SLUGS,
  isCommitmentProposalSlug,
} from './op-risk-admission.js';
// D-153 P3 — Cancellation grace window + compensating-commit substrate.
export {
  DEFAULT_GRACE_WINDOW_MS,
  MAX_GRACE_WINDOW_MS,
  manifestSupportsGraceCancel,
  getEffectiveGraceWindowMs,
  CANCELLATION_ISSUE_CODES,
  isCancellationIssueCode,
  validateCancellationManifest,
  isCompensatingCommit,
  GRACE_WINDOW_OUTCOMES,
  isGraceWindowOutcome,
  createInMemoryGraceWindowStore,
} from './cancellation.js';
export type {
  CancellationIssueCode,
  CancellationIssue,
  GraceWindowOutcome,
  GraceWindowEntry,
  GraceCancelResult,
  GraceWindowStore,
} from './cancellation.js';
// D-153 P5 — Linked sessions + reverse index (predecessor-tree
// substrate + descendant discovery).
export {
  SESSION_LAYERS,
  isSessionLayer,
  isSessionNode,
  isLinkedSession,
  SESSION_LINK_ISSUE_CODES,
  isSessionLinkIssueCode,
  validateSessionLinks,
  buildSessionReverseIndex,
  discoverDescendants,
} from './linked-sessions.js';
export type {
  SessionLayer,
  SessionNode,
  SessionLinkIssueCode,
  SessionLinkIssue,
  SessionReverseIndex,
  DescendantDiscovery,
} from './linked-sessions.js';
// D-153 P6 — Cut models per channel (cut-authority registry +
// active-tree-aware debounce + plan-completion + scheduling classifier).
export {
  CUT_AUTHORITIES,
  isCutAuthority,
  CHANNEL_CUT_MODELS,
  lookupCutModel,
  resolveCutAuthority,
  assertCutModelInvariants,
  isTreeActive,
  isTreeQuiescent,
  FRESH_DEBOUNCE_STATE,
  evaluateDebounceCut,
  evaluatePlanCompletionCut,
  SCHEDULING_CLASSES,
  isSchedulingClass,
  classifyChildScheduling,
  isDerivedSession,
} from './cut-models.js';
export type {
  CutAuthority,
  ChannelCutModel,
  ActiveTreeState,
  DebounceTrackerState,
  DebounceCutEvaluation,
  SchedulingClass,
} from './cut-models.js';
// D-153 P7 — Routing classifier + lifecycle states (lifecycle state
// machine + pre-commit input pool + message routing + classifier API).
export {
  SESSION_LIFECYCLE_STATES,
  isSessionLifecycleState,
  isTerminalLifecycleState,
  LIFECYCLE_TRANSITIONS,
  canTransitionLifecycle,
  INPUT_POOL_MAX_MESSAGES,
  INPUT_POOL_WINDOW_MS,
  INPUT_POOL_COMMIT_REASONS,
  isInputPoolCommitReason,
  openInputPool,
  evaluateInputPool,
  MESSAGE_ROUTINGS,
  isMessageRouting,
  MESSAGE_ROUTING_BY_STATE,
  resolveMessageRouting,
  ROUTING_DISPOSITIONS,
  isRoutingDisposition,
  isRoutingClassification,
  ROUTING_EFFECTS,
  lookupRoutingEffect,
  assertSessionRoutingInvariants,
} from './session-routing.js';
export type {
  SessionLifecycleState,
  InputPoolCommitReason,
  InputPoolState,
  InputPoolEvaluation,
  MessageRouting,
  RoutingDisposition,
  RoutingClassifierInput,
  RoutingClassification,
  RoutingClassifier,
  RoutingEffect,
} from './session-routing.js';
// D-153 P9 — Continuation memory entities (summary memory-entity shape +
// lazy-summarize trigger + user-edit affordance + handoff-summarizer API).
export {
  CONTINUATION_SUMMARY_SOURCES,
  isContinuationSummarySource,
  CONTINUATION_SUMMARY_TEXT_MAX_BYTES,
  isContinuationSummary,
  selectCurrentContinuationSummary,
  buildCognitionSummary,
  applyUserEditToContinuationSummary,
  SUMMARIZE_TRIGGER_OCCASIONS,
  isSummarizeTriggerOccasion,
  SUMMARIZE_DECISION_REASONS,
  isSummarizeDecisionReason,
  evaluateSummarizeTrigger,
  isHandoffSummarizationResult,
} from './continuation-summary.js';
export type {
  ContinuationSummarySource,
  ContinuationSummary,
  SummarizeTriggerOccasion,
  SummarizeDecisionReason,
  SummarizeTriggerEvaluation,
  HandoffSummarizationInput,
  HandoffSummarizationResult,
  HandoffSummarizer,
} from './continuation-summary.js';
export {
  LINK_KINDS,
  isLinkKind,
  SIDECAR_COLLECTIONS,
  isSidecarCollection,
  shouldLink,
  parseDataEntityRef,
} from './links.js';
export type {
  LinkKind,
  LinkEmissionRule,
  AccessKind,
  EntityTouch,
  EmittedLink,
} from './links.js';

// D-120 Phase 5 — `data.timeline()` MCP primitive shapes.
export {
  TIMELINE_DEFAULT_LIMIT,
  TIMELINE_MAX_LIMIT,
  TIMELINE_SOURCES,
  isTimelineSource,
  parseTimelineEntityId,
  formatTimelineEntityId,
  encodeTimelineCursor,
  decodeTimelineCursor,
  timelineEntryKey,
  clampTimelineLimit,
  MIRROR_SEARCH_KINDS,
  isMirrorSearchKind,
} from './mcp.js';
export type {
  TimelineSource,
  TimelineRequest,
  TimelineEntry,
  TimelineResponse,
  TimelineRollup,
  TimelineCursor,
  MirrorSearchKind,
  MirrorSearchRequest,
  MirrorSearchResult,
  MirrorSearchResponse,
} from './mcp.js';

// D-136 §A.13 P7.D — MCP consumer surface (swarm-agent affordances).
export {
  VECTOR_SEARCH_DEFAULT_LIMIT,
  VECTOR_SEARCH_MAX_LIMIT,
  VECTOR_SEARCH_DEFAULT_THRESHOLD,
  clampVectorSearchLimit,
} from './mcp.js';
export type {
  MCPEnrichmentReadResult,
  EnrichmentReadRpcInput,
  EnrichmentReadRpcOutput,
  // D-136 §A.14.5 — fall-through hint shape
  EnrichmentReadFallThroughHint,
  RegistryDescribeTopicEntry,
  RegistryDescribeRpcOutput,
  VectorSimilaritySearchRpcInput,
  VectorSimilaritySearchRpcOutput,
  MCPBudgetExceededError,
} from './mcp.js';

// D-119 Phase 14 — Per-collection display schema (Warehouse explorer).
export type {
  CollectionDetailRenderer,
  CollectionDisplaySchema,
} from './collection-display.js';
export {
  COLLECTION_DISPLAY_SCHEMAS,
  isCanonicalCollection,
  getCollectionDisplaySchema,
  readDisplayField,
} from './collection-display.js';
export {
  MAX_ANNOTATION_VALUE_BYTES,
  ANNOTATION_INLINE_CUTOFF_BYTES,
  isStalenessStamped,
  isAnnotationStale,
  annotationDedupeKey,
  linkRoleKey,
} from './annotation.js';

// D-121 Phase 1 — `data.contact` warehouse collection.
export type {
  ContactRecord,
  ContactSource,
  ContactObservedSource,
  ContactImportRowSource,
  ParsedAddress,
  // D-138 P1 — cross-platform reconciliation delta
  PlatformIdEntry,
  MailingAddress,
  ContactMergeCandidate,
  ContactMatchField,
  ContactCompanySource,
  NicknameAliasSet,
  ContactMergeRpcMethod,
  // D-138 P3 — housekeeping scan + A.10 prompt store
  ContactMergeScanMode,
  RemergePromptResolution,
  RemergePromptRecord,
} from './contact.js';
export {
  CONTACT_MATERIALIZE_BATCH_SIZE,
  canonicalizeEmail,
  parseAddress,
  splitAddressList,
  fallbackDisplayName,
  // D-205 #5 — the ContactSources an IMPORT stamps (observe refuses them; the C-2
  // cutover backfill skips them; only these may be stamped on a created row).
  CONTACT_IMPORT_ROW_SOURCES,
  CONTACT_IMPORT_ROW_SOURCE_SET,
  isContactImportRowSource,
  // D-138 P1
  CONTACT_MATCH_FIELDS,
  CONTACT_MATCH_MIN_FIELDS,
  COMPANY_DOMAIN_INFERENCE_MAX_DISTINCT_COMPANIES,
  CONTACT_REDIRECT_CHAIN_LIMIT,
  CONTACT_MERGE_RPC_METHODS,
  NICKNAME_ALIASES,
  resolveContactIdentity,
  // D-138 P3
  CONTACT_MERGE_CANDIDATE_SCAN_TASK_ID,
} from './contact.js';

// Metadata-only, zero-AI relationship projection used by deterministic recipes.
export {
  CONTACT_BUSINESS_CONTEXT_COVERAGE,
  CONTACT_BUSINESS_CONTEXT_LEVELS,
  CONTACT_BUSINESS_RELATIONSHIP_FAMILIES,
} from './contact-business-context.js';
export type {
  ContactBusinessContextCoverage,
  ContactBusinessContextLevel,
  ContactBusinessRelationshipSummary,
  ContactBusinessRelationshipFamily,
  ContactBusinessIdentitySummary,
  ContactBusinessContextResult,
} from './contact-business-context.js';

// D-192 C-2 (Stance 2) — the contact contribution-projection substrate: the
// C-2a source-priority ladder + the projection resolver + the
// `contact_attribute` kind vocabulary. Pure + storage-free; the stores and the
// materializer consume `resolveContribution`.
export type {
  ContactContributionSource,
  ContactAttributeKind,
  ContactContribution,
  ContactAttributeRecord,
  ContactAttributeInput,
  ContactSourceBlobRecord,
  ContactSourceBlobInput,
  ContactFieldProvenance,
  ContactProjectionProvenance,
  ContactContributionView,
} from './contact-contribution.js';
export {
  CONTACT_CONTRIBUTION_SOURCES,
  CONTACT_CONTRIBUTION_SOURCE_SET,
  CONTACT_CONTRIBUTION_SOURCE_PRIORITY,
  isContactContributionSource,
  contactContributionRank,
  CONTACT_ATTRIBUTE_KINDS,
  CONTACT_ATTRIBUTE_KIND_SET,
  isContactAttributeKind,
  // ⚠ `company` → `org`, `mailing_address` → `address`. Any surface reading
  // per-field provenance for a merge-review column MUST go through this table —
  // a lookup by the column name silently misses exactly those two.
  CONTACT_MATCH_FIELD_CONTRIBUTION_KIND,
  CONTACT_SOURCE_ID_MANUAL,
  CONTACT_SOURCE_ID_DERIVED,
  resolveContribution,
  resolveContributionsByKind,
  // C-2b — legacy provenance → ladder rung (the backfill AND the live write
  // paths rank through these; there is no flat `legacy` rung).
  contactSourceToContributionRung,
  companySourceToContributionRung,
  contributionSourceIdForRung,
} from './contact-contribution.js';

// D-145 PA8 — Contact identity extensions (`identity_status` +
// `network_domain` + `contact_alias` table + `resolveContactReference`).
export type {
  ContactIdentityStatus,
  NetworkDomain,
  ContactAliasKind,
  ContactAliasPlatform,
  ContactAliasSource,
  ContactAliasRecord,
  ContactAliasInput,
  ContactAliasMcpExposure,
  ContactReference,
  ContactReferenceContext,
  ContactReferenceResolution,
  ContactReferenceLookups,
} from './contact-identity.js';
export {
  CONTACT_IDENTITY_STATUSES,
  CONTACT_IDENTITY_STATUS_SET,
  isContactIdentityStatus,
  DEFAULT_CONTACT_IDENTITY_STATUS,
  NETWORK_DOMAINS,
  NETWORK_DOMAIN_SET,
  isNetworkDomain,
  sanitizeNetworkDomains,
  CONTACT_ALIAS_KINDS,
  CONTACT_ALIAS_KIND_SET,
  isContactAliasKind,
  CONTACT_ALIAS_PLATFORMS,
  CONTACT_ALIAS_PLATFORM_SET,
  isContactAliasPlatform,
  CONTACT_ALIAS_SOURCES,
  CONTACT_ALIAS_SOURCE_SET,
  isContactAliasSource,
  normalizeAliasPattern,
  validateContactAliasInput,
  ContactIdentityValidationError,
  resolveContactReference,
  CONTACT_ALIAS_MCP_EXPOSURE,
  CONTACT_ALIAS_SYNC_TRANSPORTS,
  aliasIncomingOutranks,
} from './contact-identity.js';

// D-138 Phase 1 — MCP tool-catalog ratchet (Reviewer #12).
export type { McpToolName } from './mcp-tool-catalog.js';
export {
  MCP_TOOL_CATALOG,
  MCP_TOOL_CATALOG_SET,
  MCP_INGREDIENT_TOOL_PREFIX,
  MCP_RESERVED_RPC_PREFIXES,
  isMcpToolName,
  isReservedLocalRpc,
} from './mcp-tool-catalog.js';

// D-138 Phase 1 — predicate match + canonicalization helpers.
export type {
  ContactMatchResult,
  MailingAddressInput,
} from './contact-match.js';
export {
  evaluateContactMatch,
  canonicalizePhone,
  resolvePhoneCountryCode,
  canonicalizeMailingAddress,
  deriveNameKey,
  deriveAddressZipCountryKey,
  deriveCompanyNorm,
  canonicalPairKey,
  isPairRejected,
  levenshtein,
} from './contact-match.js';

// D-192 messenger flagship (M2) — canonical tag/mention/content matcher.
export type {
  MessageMatchKind,
  MessageContentMatchMode,
  MessageTagPattern,
  MessageMentionPattern,
  MessageContentPattern,
  MessageMatchPattern,
  MessageProjection,
  MessageMatch,
  MessageTokens,
} from './message-match.js';
export {
  MESSAGE_MATCH_KINDS,
  MESSAGE_MATCH_KIND_SET,
  MESSAGE_CONTENT_MATCH_MODES,
  MESSAGE_CONTENT_MATCH_MODE_SET,
  MESSAGE_MATCH_MAX_PATTERNS,
  MESSAGE_MATCH_PATTERN_VALUE_MAX,
  MESSAGE_MATCH_TEXT_SCAN_MAX,
  MESSAGE_MATCH_CONFIG_KEY,
  tokenizeMessageText,
  matchMessage,
  messageMatches,
  validateMessageMatchPattern,
  validateMessageMatchPatterns,
} from './message-match.js';

// D-138 Phase 5 — upstream-merge outbox substrate.
export type {
  UpstreamMergeVendor,
  UpstreamMergeObjectType,
  UpstreamMergeState,
  UpstreamMergeEvent,
  UpstreamMergeIdempotencyInput,
  UpstreamMergeVendorPair,
  UpstreamMergeOutboxRow,
  UpstreamMergeError,
  UpstreamMergeApprovalBridge,
  UpstreamMergeRpcMethod,
  UpstreamMergeDescribeRequest,
  UpstreamMergeDescribeResponse,
  UpstreamMergeFieldOutcome,
  UpstreamMergeRequestInput,
  UpstreamMergeRequestResponse,
  UpstreamMergeRetryInput,
  UpstreamMergeRetryResponse,
  UpstreamMergeDiscardInput,
  UpstreamMergeDiscardResponse,
  UpstreamMergeListInput,
  UpstreamMergeListResponse,
  UpstreamMergeFailedEventDetail,
} from './upstream-merge.js';
export {
  UPSTREAM_MERGE_VENDORS,
  UPSTREAM_MERGE_DISPATCHABLE_OBJECT_TYPES,
  UPSTREAM_MERGE_STATES,
  UPSTREAM_MERGE_RETRY_BUDGET,
  UPSTREAM_MERGE_RETRY_BACKOFF_BASE_MS,
  UPSTREAM_MERGE_RETRY_BACKOFF_CAP_MS,
  UPSTREAM_MERGE_RPC_METHODS,
  isUpstreamMergeDispatchable,
  isUpstreamMergeTerminal,
  isUpstreamMergeRecoverable,
  nextUpstreamMergeState,
  upstreamMergeBackoffMs,
  computeUpstreamMergeIdempotencyKey,
} from './upstream-merge.js';

// D-121 Phase 5 — cloud-mediated pairing flow (path 2).
export {
  PAIRING_CODE_CHARSET,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_REGEX,
  DEFAULT_SUBSCRIPTIONS,
} from './pairing.js';

// D-121 Phase 6 — realtime broadcast bus.
export {
  ALL_BROADCAST_EVENT_KINDS,
  BROADCAST_EVENT_KIND_SET,
  DEFAULT_EVENT_RING_SIZE,
} from './events.js';
export type {
  ServerEvent,
  BroadcastEventKind,
  SubscribeRequest,
  SubscribeAck,
} from './events.js';

// D-125 Phase 1.1 — connection substrate (mcp / api / notification).
export {
  CONNECTION_API_TIMEOUT_MS,
  OAUTH2_REFRESH_LEAD_MS,
  MCP_CLIENT_IDLE_TIMEOUT_MS,
  ENRICHMENT_TRUST_MIN_DEFAULT,
  CONNECTION_CREDENTIAL_ROTATION_ATTEMPT_ID_REGEX,
  CONNECTION_CREDENTIAL_SAFE_STOP_TOKEN_REGEX,
  connectionCredentialRejectionCorrection,
  connectionCredentialRejectionTriage,
  // D-177 P2b — kernel MCP-tool dispatch surfaces (chat Tier-3 routing).
  CONNECTION_DIRECT_SLUG,
  CONNECTION_MCP_READ_SLUG,
  CONNECTION_MCP_WRITE_SLUG,
  NOTIFICATION_SUBTYPES,
} from './connection.js';
export type {
  ConnectionKind,
  NotificationSubtype,
  McpTransport,
  ConnectionAuth,
  HeaderAuthEntry,
  BodyFieldAuthEntry,
  HeaderAuthIssue,
  ConnectionRecord,
  ConnectionHealth,
  McpPushCapability,
  ConnectionCredentialVerification,
  ConnectionCredentialCorrectionFieldKey,
  ConnectionCredentialRejectionCorrection,
  ConnectionCredentialRejectionTriage,
  ConnectionCredentialRejectionTriageFieldKey,
  ConnectionCredentialRejectionResolution,
  ConnectionCredentialRejectionTriageStage,
  ConnectionCredentialRotationFailureReason,
  ConnectionCredentialRotationOutcome,
  ConnectionCredentialRotationActivity,
  ConnectionCredentialRotationSafeStop,
  ConnectionCredentialRotationSafeStopSummary,
  ConnectionCredentialPostSafeStopVerificationSummary,
  ConnectionCredentialRotationSafeStopAcknowledgement,
  ConnectionView,
  ConnectionStore,
} from './connection.js';

// D-125 Phase 1.2 — storage row + projection helpers.
export {
  // Generic auth→bearer-token seam — the single place auth-type knowledge
  // lives; vendor reconcilers call this instead of pattern-matching auth.type.
  resolveBearerAccessToken,
  // Shared credential-destination gate used by browser preflight and the
  // authoritative server enrollment/update/OAuth-start paths.
  isValidOAuthEndpointUrl,
  // D-218 — the CLOSED auth-type vocabulary, compile-checked against the
  // `ConnectionAuth` union in both directions. Every consumer that used to keep
  // its own copy (the descriptor list, the enrollment form, the handler's
  // enrollable set) now derives from this one.
  CONNECTION_AUTH_TYPES,
  // D-192 CORE #6 make-live — the same seam for the messenger SEND path, so the
  // enroll gate and every generic outbound path agree on what a chat-transport
  // credential is. Replaces two hand-rolled `auth.type !== 'bearer'` checks that
  // silently dropped anything else.
  resolveMessengerSendToken,
  connectionRowKey,
  connectionViewFromRow,
  connectionStoreFromRows,
  // D-NNN multi-header — shared header-auth array validation (proto-safe; used by
  // enrollment validation + every adapter/handler apply site).
  validateHeaderAuthEntries,
  describeHeaderAuthIssue,
  validateBodyFieldAuthEntries,
  describeBodyFieldAuthIssue,
  MAX_HEADER_AUTH_ENTRIES,
  // granted-scopes — shared row-column parse (view + server-side record decode).
  parseGrantedScopesJson,
  // D-128 P3 — inbound-verification secrets (webhook_secret) are
  // stored alongside non-secret config but stripped from the view.
  CONNECTION_INBOUND_SECRET_FIELDS,
  readConnectionInboundSecret,
  // D-165 P3.path-picker — sub-resource scope canonicalization.
  SUBRESOURCE_PATH_MAX_LEN,
  canonicalizeSubresourcePath,
} from './connection.js';
export type {
  ConnectionRow,
  ConnectionDataPurgeSummary,
  ConnectionAuthType,
} from './connection.js';

// granted-scope coverage — pure helpers bridging pack `required_scopes` to a
// connection's vendor-granted `granted_scopes` (pack-readiness reuse-vs-reauth).
export {
  requiredScopesByConnection,
  declaredConnectionSlots,
  unionRequiredScopesForConnection,
  scopeCoverage,
  UNECHOED_AUTHORIZATION_SCOPES,
} from './connection-scope-coverage.js';
export type { ScopeCoverage } from './connection-scope-coverage.js';

// D-128 Phase 4 — vendor-entity registry. Empty at D-128; vendor Ds
// (D-129 HubSpot, D-130 Salesforce) populate. Validator gates
// platform-reference enrichment scope references against this list.
export {
  CONNECTION_VENDOR_ENTITIES,
  HUBSPOT_DEAL_PROPERTIES,
  HUBSPOT_CONTACT_PROPERTIES,
  HUBSPOT_COMPANY_PROPERTIES,
  HUBSPOT_EMAIL_PROPERTIES,
  HUBSPOT_MEETING_PROPERTIES,
  HUBSPOT_NOTE_PROPERTIES,
  HUBSPOT_CALL_PROPERTIES,
  HUBSPOT_TASK_PROPERTIES,
  SALESFORCE_OPPORTUNITY_FIELDS,
  SALESFORCE_CONTACT_FIELDS,
  SALESFORCE_ACCOUNT_FIELDS,
  getVendorEntityForScope,
  getVendorEntityByVendorEntity,
  getVendorEntityByCrmAlias,
  getVendorEntityByAcctAlias,
  scopesForCrmAlias,
  canonicalCrmFieldSet,
  CANONICAL_CRM_FIELD_SCHEMA,
  // D-206 — the declared relationships on a crm_alias. A resolver reads THIS
  // rather than hardcoding `'contact_id'`.
  crmRefFields,
  canonicalCrmField,
  crmFieldTypeConforms,
  canonicalCrmFieldTypeLabel,
  requiredCanonicalCrmFields,
  crmEntityConformanceIssues,
  listRegisteredVendors,
  assertConnectionVendorEntityShape,
  assertConnectionVendorEntityValid,
  assertConnectionVendorRegistry,
  buildConnectionVendorEntity,
  CRM_ALIAS_VALUES,
  ACCT_ALIAS_VALUES,
  // D-192 engagement facet
  ENGAGEMENT_CAPABILITY_VALUES,
  ENGAGEMENT_SYNC_KINDS,
  assertEngagementFacetShape,
  assertEngagementRegistryInvariants,
  isDeclaredEngagementEntity,
  vendorHasEngagement,
  engagementEntitiesForVendor,
  engagementSyncKind,
  engagementDailyBudget,
  DATE_GRANULARITIES,
  isDateGranularity,
  FIELD_DERIVATION_KINDS,
  fieldDerivationInputPaths,
  fieldDerivationPrimaryPath,
} from './connection-vendors.js';
export type {
  ConnectionVendorEntity,
  ConnectionVendorEntityMetaField,
  ConnectionVendorEntityMetaFieldType,
  CanonicalCrmField,
  CanonicalCrmFieldType,
  CrmAlias,
  AcctAlias,
  // D-192 engagement facet
  EngagementEntityFacet,
  EngagementCapability,
  EngagementSyncKind,
  DateGranularity,
  FieldDerivation,
} from './connection-vendors.js';

// D-254 slice 1 — the inverse of `composePlatformRecordTargetId`. The composer
// shipped without one, so no caller could recover WHICH CONNECTION a platform
// record came from; `matchCrmAlias` recovers the `<vendor>_<entity>_` prefix
// only. This is the routing primitive the pack-op path needs.
export {
  CONNECTION_NAME_REGEX,
  parsePlatformRecordTargetId,
  isPlatformRecordTargetId,
  PlatformRecordIdError,
  routePlatformRecordOperationArgs,
  stampPlatformRecordIds,
} from './platform-record-id.js';
export type {
  PlatformRecordTargetId,
  PlatformRecordIdErrorCode,
  PlatformRecordRouting,
} from './platform-record-id.js';

// D-192 M1 — messenger (chat transport) vendor declaration registry. The
// canonical-vocabulary half of the taxonomy §0 rule (mirrors the
// connection-vendor registry); a new messenger vendor is one entry + an
// adapter leaf, never a `switch(vendor)`.
export {
  MESSENGER_SURFACES,
  MESSENGER_SURFACE_SET,
  MESSENGER_INGRESS_MODES,
  MESSENGER_PRINCIPAL_CONFIG_KEY,
  MESSENGER_INGRESS_MODE_SET,
  MESSENGER_INGRESS_MODE_CONFIG_KEY,
  MESSENGER_VERIFICATIONS,
  MESSENGER_VERIFICATION_SET,
  MESSENGER_PLATFORM_ID_SOURCES,
  MESSENGER_PLATFORM_ID_SOURCE_SET,
  MESSENGER_AUTH_KINDS,
  MESSENGER_AUTH_KIND_SET,
  // D-192 CORE #6 make-live — auth KIND (the vendor's credential model) →
  // the stored `ConnectionAuth` shapes it can actually be enrolled + sent with.
  // The single authority the enroll gate and the send seam both read.
  MESSENGER_AUTH_KIND_CONNECTION_TYPES,
  MESSENGER_VENDOR_SLUGS,
  MESSENGER_PROBE_METHODS,
  MESSENGER_PROBE_METHOD_SET,
  MESSENGER_PROBE_AUTH_PLACEMENTS,
  MESSENGER_PROBE_AUTH_PLACEMENT_SET,
  MESSENGER_PROBE_TOKEN_PLACEHOLDER,
  MESSENGER_VENDOR_DECLARATIONS,
  assertMessengerVendorDeclarationShape,
  assertMessengerVendorDeclarationValid,
  assertMessengerVendorRegistry,
  buildMessengerVendorDeclaration,
  getMessengerVendorDeclaration,
  messengerVendorSupportsIngressMode,
  resolveMessengerConnectionIngressMode,
  resolveMessengerConnectionRoles,
  resolveMessengerVendorRoles,
  listMessengerVendors,
  isDeclaredMessengerVendor,
} from './messenger-vendors.js';
export type {
  MessengerSurface,
  MessengerIngressMode,
  MessengerVerification,
  MessengerPlatformIdSource,
  MessengerAuthKind,
  MessengerVendorSlug,
  MessengerProbeMethod,
  MessengerProbeAuthPlacement,
  MessengerIngress,
  MessengerRecipient,
  MessengerIdentity,
  MessengerProjection,
  MessengerHealthProbe,
  MessengerVendorDeclaration,
} from './messenger-vendors.js';

// D-129 Phase 7 — cosmetic read-side alias for platform-reference
// enrichment refs. Both runtime resolver and recipe validator route
// alias-form refs through `tryRewriteVendorEnrichmentAlias` so the
// canonical D-128 storage path sees both shapes uniformly.
export {
  RESERVED_DATA_SUBNAMESPACES,
  matchVendorEnrichmentAlias,
  tryRewriteVendorEnrichmentAlias,
  assertNoVendorPrefixClash,
} from './connection-vendor-aliases.js';
export type { VendorEnrichmentAliasMatch } from './connection-vendor-aliases.js';

// D-130 Phase 7 — cross-vendor `data.crm.*` resolver. Sister of the
// D-129 P7 vendor alias, one level higher: dispatches across CRM
// vendors via the registry's `crm_alias` annotation + the
// `<full_target_id>`'s vendor-prefix discriminator. Both runtime
// resolver and recipe validator route alias-form refs through
// `tryRewriteCrmAlias` so the canonical D-128 storage path sees all
// three shapes (canonical / vendor alias / cross-vendor alias)
// uniformly.
export {
  matchCrmAlias,
  tryRewriteCrmAlias,
} from './connection-vendor-crm-aliases.js';
export type { CrmAliasMatch } from './connection-vendor-crm-aliases.js';

// D-192 unit-3 — LIVE vendor registry injection for the pure read-side
// alias resolvers (the D-129 vendor alias + D-130 cross-vendor crm alias).
// Server composition sets a `() => liveVendorRegistry(store)` thunk so a
// pack-declared CRM's `data.crm.*` / `data.<vendor>.*` refs rewrite; unbound
// (client / test) falls back to the frozen builtin — byte-identical.
export {
  setVendorAliasRegistryResolver,
  activeVendorAliasRegistry,
} from './vendor-alias-registry.js';

// D-192 S4b follow-on — the shared per_record scope-support check (static
// valid_scopes OR a live-registry pack-vendor crm_alias-family scope), used by
// the enrichment STORE write gate + the recipe VALIDATOR so they can't drift.
export {
  isEnrichmentScopeSupported,
} from './enrichment-scope-support.js';

// D-129 Phase 1 — vendor provider registry. Sibling to
// CONNECTION_VENDOR_ENTITIES — entities cover reconciliation shape per
// (vendor, entity); providers cover enrollment shape per vendor (OAuth,
// scopes, webhook conventions). One entry per first-party vendor;
// HubSpot at D-129, Salesforce at D-130.
export {
  CONNECTION_VENDOR_PROVIDERS,
  CONNECTION_SANDBOX_FLAG_VALUES,
  HUBSPOT_OAUTH_SCOPES,
  HUBSPOT_API_BASE,
  HUBSPOT_OAUTH_AUTHORIZE_URL,
  HUBSPOT_OAUTH_TOKEN_URL,
  HUBSPOT_OAUTH_INTROSPECT_URL,
  HUBSPOT_WEBHOOK_SIGNATURE_HEADER,
  HUBSPOT_DEFAULT_RECONCILIATION_CADENCE,
  SALESFORCE_API_VERSION,
  SALESFORCE_API_BASE_PLACEHOLDER,
  SALESFORCE_OAUTH_SCOPES,
  SALESFORCE_OAUTH_AUTHORIZE_URL_PRODUCTION,
  SALESFORCE_OAUTH_TOKEN_URL_PRODUCTION,
  SALESFORCE_OAUTH_AUTHORIZE_URL_SANDBOX,
  SALESFORCE_OAUTH_TOKEN_URL_SANDBOX,
  SALESFORCE_WEBHOOK_SIGNATURE_HEADER,
  SALESFORCE_PUSHTOPIC_NAMES,
  SALESFORCE_ENTITY_NAMES,
  SALESFORCE_PUSHTOPIC_CHANNEL_PREFIX,
  SALESFORCE_SOBJECT_ID_PREFIXES,
  SALESFORCE_COMETD_PATH,
  SALESFORCE_SOAP_PARTNER_PATH,
  SALESFORCE_PUSHTOPIC_API_VERSION,
  SALESFORCE_DEFAULT_RECONCILIATION_CADENCE,
  PIPEDRIVE_OAUTH_SCOPES,
  PIPEDRIVE_API_BASE,
  PIPEDRIVE_OAUTH_AUTHORIZE_URL,
  PIPEDRIVE_OAUTH_TOKEN_URL,
  PIPEDRIVE_WEBHOOK_SIGNATURE_HEADER,
  PIPEDRIVE_DEFAULT_RECONCILIATION_CADENCE,
  // D-139 P1b — Salesforce engagement constants
  SALESFORCE_ENGAGEMENT_ENTITY_NAMES,
  SALESFORCE_RELATIONSHIP_ENTITY_NAMES,
  SALESFORCE_ALL_ENGAGEMENT_ENTITIES,
  SALESFORCE_ENGAGEMENT_SOBJECT_NAMES,
  SALESFORCE_ENGAGEMENT_SOBJECT_ID_PREFIXES,
  SALESFORCE_ENGAGEMENT_PUSHTOPIC_NAMES,
  SALESFORCE_TASK_FIELDS,
  SALESFORCE_EVENT_FIELDS,
  SALESFORCE_EMAIL_MESSAGE_FIELDS,
  SALESFORCE_VOICE_CALL_FIELDS,
  SALESFORCE_CALL_HISTORY_FIELDS,
  SALESFORCE_TASK_RELATION_FIELDS,
  SALESFORCE_EVENT_RELATION_FIELDS,
  SALESFORCE_EMAIL_MESSAGE_RELATION_FIELDS,
  getVendorProvider,
  listVendorProviders,
  resolveVendorOAuthEndpoints,
  resolveVendorOAuthRuntimeBase,
  composeRealmBaseUrl,
  buildGenericVendorProvider,
  GENERIC_OAUTH_VENDOR,
  assertConnectionVendorProviderShape,
  assertConnectionVendorProviderValid,
  assertConnectionVendorProviderRegistry,
  QUICKBOOKS_OAUTH_SCOPES,
  QUICKBOOKS_OAUTH_AUTHORIZE_URL,
  QUICKBOOKS_OAUTH_TOKEN_URL,
  QUICKBOOKS_API_BASE_PRODUCTION,
  QUICKBOOKS_API_BASE_SANDBOX,
  QUICKBOOKS_REALM_PATH_TEMPLATE,
  QUICKBOOKS_API_BASE_PLACEHOLDER,
  QUICKBOOKS_WEBHOOK_SIGNATURE_HEADER,
  QUICKBOOKS_DEFAULT_RECONCILIATION_CADENCE,
  // SMB-finance slice 3 — Google Drive (storage-gdrive)
  GOOGLE_OAUTH_SCOPES,
  GOOGLE_OAUTH_AUTHORIZE_URL,
  GOOGLE_OAUTH_TOKEN_URL,
  GOOGLE_DRIVE_API_BASE,
  GOOGLE_OAUTH_AUTHORIZE_PARAMS,
  GOOGLE_WEBHOOK_SIGNATURE_HEADER,
  GOOGLE_DEFAULT_RECONCILIATION_CADENCE,
  // D-192 file SOURCE family — Dropbox (files-dropbox)
  DROPBOX_OAUTH_SCOPES,
  DROPBOX_OAUTH_AUTHORIZE_URL,
  DROPBOX_OAUTH_TOKEN_URL,
  DROPBOX_API_BASE,
  DROPBOX_OAUTH_AUTHORIZE_PARAMS,
  DROPBOX_WEBHOOK_SIGNATURE_HEADER,
  DROPBOX_DEFAULT_RECONCILIATION_CADENCE,
  // D-192 file SOURCE family — OneDrive (Microsoft Graph)
  MICROSOFT_GRAPH_API_BASE,
  ONEDRIVE_OAUTH_SCOPES,
  ONEDRIVE_WEBHOOK_SIGNATURE_HEADER,
  ONEDRIVE_DEFAULT_RECONCILIATION_CADENCE,
  // D-192 file SOURCE family — Box (/2.0/events)
  BOX_API_BASE,
  BOX_OAUTH_SCOPES,
  BOX_OAUTH_AUTHORIZE_URL,
  BOX_OAUTH_TOKEN_URL,
  BOX_WEBHOOK_SIGNATURE_HEADER,
  BOX_DEFAULT_RECONCILIATION_CADENCE,
  // D-192 file SOURCE family — SharePoint (Microsoft Graph document library)
  SHAREPOINT_OAUTH_SCOPES,
  SHAREPOINT_WEBHOOK_SIGNATURE_HEADER,
  SHAREPOINT_DEFAULT_RECONCILIATION_CADENCE,
  AUTHORIZE_PARAM_RESERVED_KEYS,
} from './connection-vendor-providers.js';
export type {
  ConnectionVendorProvider,
  ConnectionSandboxFlag,
  VendorOAuthConfig,
  VendorOAuthRuntimeBaseConfig,
  VendorOAuthRuntimeBaseResolution,
  RealmBaseConfig,
  SalesforceEntityName,
  SalesforceEngagementEntityName,
  SalesforceRelationshipEntityName,
} from './connection-vendor-providers.js';

// D-139 P1a.1 — Engagement evidence-quality contracts + row/edge schemas.
export {
  AUTHORSHIP_VALUES,
  AUTHORSHIP_SET,
  isAuthorship,
  DIRECTION_VALUES,
  DIRECTION_SET,
  isDirection,
  DEDUPE_CONFIDENCE_VALUES,
  DEDUPE_CONFIDENCE_SET,
  isDedupeConfidence,
  DEDUPE_ACCEPTANCE_VALUES,
  DEDUPE_ACCEPTANCE_SET,
  isDedupeAcceptance,
  DEDUPE_MATCH_KEY_VALUES,
  ENGAGEMENT_LIFECYCLE_STATE_VALUES,
  ENGAGEMENT_LIFECYCLE_STATE_SET,
  isEngagementLifecycleState,
  DEFAULT_ENGAGEMENT_LIFECYCLE_EVIDENCE_STATES,
  BODY_STATE_VALUES,
  BODY_STATE_SET,
  isBodyState,
  ENGAGEMENT_EDGE_TYPE_VALUES,
  ENGAGEMENT_EDGE_TYPE_SET,
  isEngagementEdgeType,
  SOURCE_DEGRADATION_REASON_VALUES,
  SOURCE_DEGRADATION_REASON_SET,
  isSourceDegradationReason,
  ENGAGEMENT_VENDOR_VALUES,
  ENGAGEMENT_DEDUPE_CANDIDATES_PER_ROW_CAP,
  ENGAGEMENT_INBOUND_EVENT_REPLAY_WINDOW_MS,
  ENGAGEMENT_ASSOCIATION_RESCAN_WINDOW_MS,
  RECONCILER_PAGE_CAP_PER_INVOCATION,
  ENGAGEMENT_RESOLVER_DEFAULT_WINDOW_MS,
  ENGAGEMENT_RESOLVER_DEFAULT_PAGE_SIZE,
  ENGAGEMENT_RESOLVER_MAX_PAGE_SIZE,
  ENGAGEMENT_BODY_CONTENT_REGISTRY_KEY,
  ENGAGEMENT_LIST_REGISTRY_KEY,
  CRM_COMMITMENT_TRACKER_LAUNCH_FLAG,
} from './engagement-evidence.js';
export type {
  Authorship,
  Direction,
  DedupeConfidence,
  DedupeAcceptance,
  DedupeMatchKey,
  EngagementLifecycleState,
  BodyState,
  EngagementEdgeType,
  SourceDegradationReason,
  EngagementVendor,
  AttachmentMeta,
  CoverageMetadata,
  CoverageStaleEntry,
  CoverageDegradedEntry,
} from './engagement-evidence.js';

export {
  ENGAGEMENT_EDGE_TARGET_KIND_VALUES,
  isEngagementEdgeTargetKind,
  ENGAGEMENT_INBOUND_DELIVERY_PATH_VALUES,
  isEngagementInboundDeliveryPath,
  DEDUPE_RESOLUTION_STATE_VALUES,
  projectEngagementRowForMCP,
  encodeEngagementsCursor,
  decodeEngagementsCursor,
  engagementSubjectHash,
} from './engagement.js';
export type {
  EngagementRow,
  EngagementEdge,
  EngagementEdgeTargetKind,
  EngagementInboundEventLedgerRow,
  EngagementInboundDeliveryPath,
  EngagementDedupeCandidateRow,
  EngagementDedupeCandidateProjection,
  DedupeResolutionState,
  EngagementsResolverArgs,
  EngagementsResolverFilters,
  EngagementsForRecordArgs,
  EngagementsResolverRow,
  EngagementsResolverResult,
  EngagementsResolverCursor,
  MCPEngagementRowProjection,
  EngagementCapabilityFlags,
  EngagementDeletionProvenance,
} from './engagement.js';

// D-139 P2 — Connection-page UX rpc surfaces.
export {
  RATE_CONTROL_STATE_VALUES,
  RATE_CONTROL_STATE_SET,
  isRateControlStateValue,
} from './engagement-rpc.js';
export type {
  RateControlStateValue,
  EngagementHealthRow,
  EngagementHealthRequest,
  EngagementHealthResponse,
  EngagementRelationshipCapability,
  ReprobeEngagementCapabilitiesRequest,
  ReprobeEngagementCapabilitiesResponse,
} from './engagement-rpc.js';

// D-119 Phase 5 — UI device-scope router.
export {
  DEVICE_SCOPE_LOCAL_ID,
  DEFAULT_DEVICE_SCOPE,
  parseDeviceScope,
  serializeDeviceScope,
  deviceScopeEquals,
  deviceScopeTabs,
  deviceScopeHasSettings,
  deviceScopeIsLimitedView,
} from './device-scope.js';
export type { DeviceScope, DeviceScopeTab } from './device-scope.js';

// D-119 — Recipe-bundle schema + decentralized-install helpers.
export {
  isRecipeBundle,
  deriveVaultScope,
  vaultScopeKey,
  normalizeUrlForVaultScope,
  canonicalBundleBytes,
  verifyBundleSignature,
  detectVaultScopeCollision,
} from './bundle.js';
export type {
  BundleSignature,
  RecipeBundle,
  VaultScope,
  InstallSource,
  NonRemoteInstallSource,
  RemoteBundleInstallDescriptor,
  RemoteBundleInstallSource,
  RedirectResolvedBundleUrl,
  FetchedRemoteBundle,
  BundleSignatureStatus,
  BundleSignatureResult,
  PubkeyTrustState,
  PubkeyResolver,
  VaultScopeLookup,
  VaultScopeCollision,
} from './bundle.js';

// Runtime role
export { ROLE, setRole } from './role.js';
export type { RuntimeRole } from './role.js';

// Token budget thresholds
export { DEFAULT_BUDGET_THRESHOLDS, checkBudgetStatus } from './budget.js';
export type { BudgetThresholds, BudgetStatus } from './budget.js';

// D-112 — Engine-wide locked input keys + wildcard shape helpers.
export {
  ENGINE_LOCKED_INPUT_KEYS,
  WILDCARD_SUFFIX,
  isLockedInputKey,
  isWildcardMarker,
  wildcardPrefix,
  matchesWildcard,
} from './locked-input-keys.js';
export type { LockedInputKey } from './locked-input-keys.js';

// Content policy (marketplace publishing safety)
export type { ContentIssue } from './content-policy.js';
export type { RecipeBundleKeyParts, RecipeBundleSharedState } from './content-policy.js';
export {
  RESERVED_HANDLES,
  canonicalizePublisher,
  validatePublisherHandle,
  validateTextContent,
  validateTags,
  validateSlug,
  parseRecipeBundleKey,
  RECIPE_BUNDLE_SHARED_STATES,
  isRecipeBundleSharedState,
  sanitizeRecipeBundleKey,
  recipeBundleSharedPrefix,
  isRecipeBundleSharedRowKeySegment,
  recipeBundleSharedKey,
  validateRecipeBundleKey,
  validateRecipeBundlePublisher,
  validateRecipeContent,
  validateIngredientContent,
  AUTHORIZED_TEMPLATE_PUBLISHERS,
  stripUnauthorizedTemplateTags,
  parseTemplateVertical,
} from './content-policy.js';

// §5 recipe-publish policy — the binding-free `core-` kernel capability namespace.
export {
  CORE_SLUG_PREFIX,
  isCoreSlug,
  stripCorePrefix,
  CORE_CAPABILITY_SLUGS,
  isCoreCapabilitySlug,
} from './core-pack.js';

// D-168: SYNC_OBJECTS substrate retired. `sync_transport` on
// `contract.*` composite_keys is now the sole declaration surface for
// sync policy (see D-166 §"Per-scope sync policy").

// Pair-scoped instance preferences (pair-rpc/storage path; no SYNC_OBJECTS registry).
export {
  INSTANCE_PREFS,
  DEFAULT_INSTANCE_PREFS,
  applyPrefsPatch,
  sanitizePrefsPatch,
  getPref,
  VOICE_SPEAK_MODES,
} from './prefs.js';
export type { InstancePrefKey, InstancePrefs, InstancePrefSpec, InstancePrefValue, VoiceSpeakMode } from './prefs.js';

// D-269 step 1 — the server's own timezone (declared, or followed on a laptop
// install). The single source every wall-clock surface resolves through.
export {
  canonicalizeIanaZone,
  isValidIanaZone,
  resolveServerTimeZone,
  isServerTimeZoneConfigured,
  DEFAULT_SERVER_TIME_ZONE_MODE,
} from './server-timezone.js';
export type {
  ServerTimeZoneMode,
  ServerTimeZoneSetting,
  ServerTimeZoneGetResponse,
  ServerTimeZoneSetRequest,
  ServerTimeZoneSetResponse,
} from './server-timezone.js';

// D-269 step 2 — the per-kind notification policy (anchored kinds only).
export {
  NOTIFICATION_ANCHORED_KINDS,
  NOTIFICATION_KIND_DEFAULT_OFFSET_MS,
  NOTIFICATION_KIND_MIN_OFFSET_MS,
  NOTIFICATION_KIND_MAX_OFFSET_MS,
  isNotificationAnchoredKind,
  isValidNotificationOffsetMs,
  defaultNotificationKindPolicy,
} from './notification-kind-policy.js';
export type {
  NotificationAnchoredKind,
  NotificationKindPolicy,
  NotificationKindPolicyGetResponse,
  NotificationKindPolicySetRequest,
  NotificationKindPolicySetResponse,
} from './notification-kind-policy.js';

// D-269 step 3 — quiet hours: one window, per person, consulted by delivery.
export {
  QUIET_HOURS_APPLIES_TO,
  MINUTES_PER_DAY,
  DEFAULT_QUIET_HOURS_FROM_MINUTE,
  DEFAULT_QUIET_HOURS_TO_MINUTE,
  defaultQuietHoursPolicy,
  isValidQuietHoursMinute,
  localMinuteOfDay,
  isMinuteWithinWindow,
  isWithinQuietHours,
  canArmQuietHours,
  shouldSuppressForQuietHours,
  mayHoldAskForQuietHours,
  QUIET_HOURS_APPROVAL_IS_NOT_RECOMMENDED,
  resolveQuietHoursOccurrence,
  buildQuietHoursDigest,
  isQuietHoursDigestEmpty,
  renderQuietHoursDigest,
} from './quiet-hours.js';
export type {
  QuietHoursAppliesTo,
  QuietHoursPolicy,
  QuietHoursGetResponse,
  QuietHoursSetRequest,
  QuietHoursSetResponse,
  QuietHoursOccurrence,
  QuietHoursDigest,
  QuietHoursDigestItem,
} from './quiet-hours.js';

// D-269 step 3 follow-on — zoned wall clock, shared by the server sweep and the
// client's quiet-hours preview (which cannot import from `backend/`).
export { zonedWallClockToEpochMs, zoneOffsetMsAt, cronZoneFor } from './zoned-wall-clock.js';

// Phase B — pressure details (heartbeat + server.getStatus shared shape).
export {
  STORAGE_STATE_RANK,
  formatPressureBytes,
  pressureSurfaceRows,
  worstStorageState,
} from './pressure.js';
export type { PressureSurfaceRow } from './pressure.js';
export type {
  PressureDetails,
  PressureSurfaceDetail,
  StorageState,
} from './pressure.js';

// Phase C — lifecycle + supervisor (heartbeat + getLifecycleState shared shape).
export {
  DRAIN_STEP_NAMES,
  LIFECYCLE_STATE_RANK,
  isLifecycleAcceptingRpc,
  computeUptimeSeconds,
} from './lifecycle.js';
export type {
  LifecycleState,
  DrainIntent,
  DrainStepName,
  DrainState,
  LifecycleLastCrash,
  SupervisorMode,
  ResolvedSupervisorMode,
  LifecycleStatus,
} from './lifecycle.js';

// D-188 / the un-supervised-update guard — VALUES, so a separate export: both
// the webclient's Restart gate and the server's apply guard ask this one list.
export { SUPERVISOR_MODES_THAT_RESPAWN, supervisorWillRespawn } from './lifecycle.js';

// Phase D — warehouse collections (mail / file / webhook shared shape).
export type {
  CollectionPlatform,
  CollectionRecord,
  CollectionListQuery,
  CollectionSearchQuery,
  CollectionSearchMatch,
  CollectionSearchGroup,
  CollectionState,
  CollectionHealth,
  // Phase 7 (D-110) — capability model + instance rows.
  FileCollectionCaps,
  CollectionAuthState,
  FileAdapterType,
  CollectionInstanceRow,
  // D-117 — calendar caps live on the same instance row as the file
  // caps; consumers narrow on `platform`.
  CollectionCaps,
  // Phase 7 — `file-stat` output shape.
  FileRecordStat,
  // D-117 — calendar health narrow variant.
  CalendarCollectionHealth,
  // D-236 — source freshness returned alongside the records of the read
  // that consumed the source.
  CollectionSourceFreshness,
  CollectionSourceFreshnessEntry,
} from './collections.js';

// D-236 — source freshness: the derivation + its default threshold. Value
// exports (the type rides in the block above).
export {
  COLLECTION_SOURCE_STALE_AFTER_MS,
  deriveCollectionSourceFreshness,
  collectionSourceFreshnessOf,
  collectionSourceFreshnessFanOut,
} from './collections.js';

// D-117 — calendar warehouse types.
export {
  CALENDAR_EXPANSION_PAST_DAYS_DEFAULT,
  CALENDAR_EXPANSION_FUTURE_DAYS_DEFAULT,
  CALENDAR_POLL_SECONDS_DEFAULT,
  CALENDAR_STARTING_SOON_DEFAULT_MINUTES,
  CALENDAR_WATCHER_CURSOR_PREFIX,
  CALENDAR_RETENTION_DAYS_DEFAULT,
  CALENDAR_QUOTA_BYTES_DEFAULT,
  CalendarAdapterError,
} from './calendar.js';
export type {
  CanonicalEvent,
  CalendarRecordHotFields,
  CalendarCollectionCaps,
  CalendarRecordStat,
  CalendarWatcherItem,
  CalendarAdapterErrorCode,
} from './calendar.js';

// D-118 — service platform types (`data.service.*`).
export {
  SERVICE_INSTALL_KINDS,
  SERVICE_CHECK_KINDS,
  SERVICE_EVENT_NAMES,
  SERVICE_RESTART_POLICIES,
  SERVICE_TEMPLATE_OS,
  SERVICE_STARTUP_GRACE_MS_DEFAULT,
  SERVICE_HEALTH_CHECK_INTERVAL_MS_FLOOR,
  SERVICE_INVOKE_STDOUT_CAP_BYTES,
  SERVICE_MIN_DISK_FREE_BYTES_DEFAULT,
  SERVICE_QUOTA_BYTES_DEFAULT,
  SERVICE_CONSECUTIVE_CRASHES_MAX,
  SERVICE_RESTART_BACKOFF_MS,
  SERVICE_CWD_SUBDIR,
} from './service.js';
export type {
  ServiceInstallKind,
  ServiceCheckKind,
  ServiceCheckSpec,
  ServiceEventName,
  ServiceRestartPolicy,
  ServiceTemplateOS,
  ServiceState,
  ServiceHealthState,
  ServiceCollectionCaps,
  ServiceStatus,
  ServiceCollectionHealth,
  ServiceAuditEvent,
  ServiceCheckResult,
  ServiceEnrollInput,
  ServiceEnrollOutput,
  ServiceInstallOutput,
  ServiceUpgradeOutput,
  ServiceUninstallOutput,
  ServiceInstanceListRow,
  ServiceInstanceList,
  ServiceTemplateConfigField,
  ServiceTemplateListRow,
  ServiceTemplateListInput,
  ServiceTemplateList,
} from './service.js';

// Phase G — event triggers (D-109).
export type {
  EventTriggerId,
  EventTriggerPattern,
  EventTriggerOrigin,
  EventTrigger,
  TriggerDispatchContext,
  TriggerEventPayload,
} from './triggers.js';

// Poll-manager / G6 — watch substrate (reactive-automation design § 3).
export type {
  WatchKey,
  WatchStatusEntry,
  WatchSourceMechanism,
  WatchSourceStatusEntry,
} from './watch.js';
export {
  watchKeyOf,
  parseWatchDemandFromPattern,
  WATCH_MIN_POLL_INTERVAL_MS,
  WATCH_DEFAULT_POLL_INTERVAL_MS,
  WATCH_ERROR_CAP,
  CONNECTION_API_POLL_SOURCE_ID,
  MCP_RESOURCE_POLL_SOURCE_ID,
  MCP_RESOURCE_WATCH_PLATFORM,
  MCP_RESOURCE_WATCH_VENDOR,
  encodeMcpResourceUri,
  decodeMcpResourceUri,
  parseMcpResourceWatchDemand,
  mcpResourceEventScope,
  DOM_WATCH_POLL_SOURCE_ID,
  DOM_WATCH_PLATFORM,
  DOM_WATCH_VENDOR,
  DOM_WATCH_CONNECTION,
  encodeDomWatchTarget,
  decodeDomWatchTarget,
  parseDomWatchDemand,
  domWatchEventScope,
  DOM_WATCH_BUS_PREFIX,
  isUnmatchableDomWatchPattern,
  MESSENGER_EVENT_PLATFORM,
  RECEPTION_EVENT_PLATFORM,
} from './watch.js';

// Supervision feature — cli-daemon keep-alive `supervision.*` rpc wire types.
export type {
  SupervisionMode,
  SupervisedDaemonReadiness,
  SupervisionSetRequest,
  SupervisionDaemonRow,
  SupervisionListResponse,
  SupervisionStatusRequest,
} from './supervision.js';

// D-179 P1 — dishes (execution instances); P3 — dish groups.
export type { Dish, DishGroup, DishLastRun, DishRunRow } from './dish.js';
export {
  DISH_ID_PREFIX,
  DISH_GROUP_ID_PREFIX,
  EPHEMERAL_DISH_ID_PREFIX,
  ephemeralDishId,
  isEphemeralDishId,
} from './dish.js';

// Reactive authoring sugar — the canonical `on:` subscriber form
// (design § 3/§ 4 compile-down).
export type {
  TriggerSugarVerb,
  ParsedTriggerOn,
  CompiledTriggerSubscription,
  TriggerDispatchFilter,
} from './trigger-sugar.js';
export {
  TRIGGER_SUGAR_VERBS,
  TRIGGER_SUGAR_VERB_TO_KIND,
  MESSENGER_ON_SHORTHAND,
  RECEPTION_ON_SHORTHAND,
  FORM_RESPONSE_ON_SHORTHAND,
  parseTriggerOn,
  whereToDispatchFilter,
  compileTriggerSugarEntry,
  matchesTriggerDispatchFilter,
  validateRecipeEventTriggerEntry,
} from './trigger-sugar.js';
export {
  ELEMENT_ON_SHORTHAND,
  isDomWatchTriggerEntry,
} from './dom-watch-trigger.js';

// Entity-targeting rule (design § 8) — targeted-without-target warn+block,
// the one rule set the run modal + server execute guard share.
export type {
  TargetRequirement,
  RecipeTargeting,
  TargetAssessment,
} from './recipe-targeting.js';
export {
  deriveRecipeTargeting,
  assessRunTargets,
  buildTargetRequiredMessage,
} from './recipe-targeting.js';

// Auto-PII static flow trace (design § 7) — per-transform PII-flow rules +
// the install-time taint trace + the `pii_untraced` flag + the auto-injection
// plan for contracted ai-* steps.
export type {
  PiiTaintKind,
  PiiPathProfile,
  PiiSourceClassifier,
  PiiEgressVerdict,
  PiiUncoveredPath,
  PiiEgressFinding,
  PiiUntracedStep,
  RecipePiiTrace,
  PiiFlowRule,
  PiiFieldInjection,
  PiiInjectionGap,
  AutoPiiInjectionPlan,
  RecipePiiPostureLine,
  RecipePiiPostureSummary,
  RecipePiiDisclosureEntry,
} from './recipe-pii-trace.js';
export {
  PII_FLOW_RULES,
  PII_LIST_SEGMENT,
  tracePiiFlow,
  deriveAutoPiiFieldInjections,
  recipePiiPostureHasContent,
} from './recipe-pii-trace.js';

// D-119 follow-on + D-221 prerequisite — typed `context.*` field shapes and
// the trusted execution-source → recipe-caller projection.
export {
  contextCallerFromExecutionSource,
  installContextCaller,
} from './context.js';
export type { ContextCaller, ContextServer } from './context.js';

// D-120 Phase 4.5 — `context.recipe.*` durability shape.
export type { ContextRecipe } from './context.js';

// Phase G — archive rpc shared shapes (D-109).
export type {
  ArchiveImportRebind,
  ArchiveJobStatus,
  ArchiveManifest,
  ArchiveRealmRelation,
  ArchiveSchemaCompat,
} from './archive.js';

// Phase G — activity labels (D-109).
export { ACTIVITY_LABELS, resolveActivityLabel } from './activity-labels.js';
export type { KnownActivityAction } from './activity-labels.js';

// D-127 — mail-send substrate constants + audit shape.
// D-145 PA7 — mail_message canonical-schema constants.
export {
  MAIL_SEND_AUDIT_RECIPIENT_REDACTION_THRESHOLD,
  MAIL_RECONCILIATION_ID_HEADER,
  MAIL_RECONCILIATION_ID_MAX_LENGTH,
  MAIL_SENT_RECONCILIATION_MAX_WINDOW_MS,
  isMailReconciliationId,
  MAIL_MESSAGE_SUBJECT_MAX,
  MAIL_MESSAGE_REF_CONTACT,
  MAIL_MESSAGE_REF_FILE,
  MAIL_MESSAGE_REF_MESSAGE,
  MAIL_MESSAGE_REF_SOURCE,
  // D-172 P2 — the send-side attachment cap, shared with the compose UI so an
  // over-cap file is marked before send rather than warned about after.
  MAIL_SEND_ATTACHMENT_MAX_BYTES,
  MAIL_SEND_ATTACHMENT_OVERSIZE_WARNING,
  // D-239 — mail write-back. The error class is a runtime value (thrown by
  // the providers, `instanceof`-checked at the dispatcher), so it exports
  // here rather than in the type-only block below.
  MailAdapterError,
} from './mail.js';
export type {
  MailAdapterErrorCode,
  MailMoveDestination,
  MailMoveOutcome,
  MailMutationResult,
  MailSendAuditDetail,
  MailSentAttachmentReconciliationMatch,
  MailSentAttachmentReconciliationQuery,
  MailSentEnvelopeReconciliationMatch,
  MailSentEnvelopeReconciliationQuery,
  MailSentReconciliationMatch,
  MailSentReconciliationQuery,
  MailSentReconciliationResult,
} from './mail.js';

// Phase G — server status pill (D-109).
export {
  HEARTBEAT_STALE_MS,
  SERVER_HEARTBEAT_INTERVAL_MS,
  computePillState,
  formatPillUptime,
} from './server-pill.js';
export type {
  ServerHeartbeatSnapshot,
  PillState,
  PillLabel,
  PillDot,
} from './server-pill.js';

// D-148 § A.8 — Key Material Taxonomy.
export {
  KEY_CLASSES,
  KEY_OPS,
  KEY_CAPABILITIES,
  isKeyClass,
  isKeyOp,
  assertKeyCapable,
  isKeyCapable,
  KeyCapabilityError,
  HIGH_ASSURANCE_AUDIT_KINDS,
  isHighAssuranceAuditKind,
} from './keys.js';
export type {
  KeyClass,
  KeyOp,
  SubDEKDomain as D148SubDEKDomain,
  KeyHealthEntry,
  KeyHealthBundle,
} from './keys.js';

// D-148 § A.6 + § A.7 — Path layout + Public Exposure (Amendment 2026-05-11).
export {
  TELEGRAM_SUPPORTED_PORTS,
  isTelegramSupportedPort,
  isAcknowledgementWellFormed,
  PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE,
  isValidPublicMcpAcknowledgementPhrase,
  NETWORK_ERROR_CODES,
  // D-148 Wave 3 — path-routing substrate (Amendment 2026-05-11)
  PATH_ROLES,
  PATH_FOR_ROLE,
  matchesPathRole,
  EXPOSURE_PRESETS,
  EXPOSURE_PRESET_PATH_MAP,
  WS_LOCKOUT_DISCONNECT_PHRASE,
  WS_LOCKOUT_DISABLE_PHRASE,
  WS_LOCKOUT_PHRASES,
  DEFAULT_PATH_RESOLUTION,
  applyPreset,
  applyPathResolution,
  deriveLabel,
  requiredWsLockoutPhrase,
  isValidWsLockoutPhrase,
  requiresPublicMcpAcknowledgementForResolution,
  anyPathLan,
  anyPathPublic,
  // D-148 Wave 3 sub-phase 2 — TLSDomainStore + multi-domain SNI
  TLS_DOMAIN_CERT_SOURCES,
  isTLSDomainCertSource,
  isFleetIssuedTlsDomainSource,
  TLS_CERT_MIN_VALIDITY_MS,
  matchesSANForDomain,
  validateTLSDomainUpload,
  // D-148 follow-up #7 — bare-302 root redirect substrate
  ROOT_REDIRECT_TARGET,
  isProDdnsHost,
  // R26.2 Delta 2 — apex (`GET /`) serving mode
  ROOT_APEX_MODES,
  DEFAULT_ROOT_APEX_MODE,
  isRootApexMode,
  // D-176 — multi-domain DDNS zone registry + canonical mapping
  DDNS_ZONES,
  defaultDdnsZone,
  enabledDdnsZones,
  zoneByLabel,
  resolveProDdnsHost,
  hostnameForHandle,
} from './network.js';

// D-152 P0 — multi-hostname registry substrate.
export {
  HOSTNAME_CERT_SOURCES,
  HOSTNAME_VERIFICATION_METHODS,
  HOSTNAME_OWNERSHIP_STATUSES,
  HOSTNAME_CERT_PROVISIONING_STATES,
  HOSTNAME_TLS_TOPOLOGIES,
  HOSTNAME_LISTENER_PORTS,
  isHostnameCertSource,
  isHostnameVerificationMethod,
  isHostnameOwnershipStatus,
  isHostnameCertProvisioningState,
  isHostnameTlsTopology,
  isHostnameListenerPort,
  tlsTopologyForHostnameCertSource,
  isFleetIssuedCertSource,
  isSingleLabelProDdnsHostname,
  normalizeHostname,
  projectHostname,
  canBindHostname,
} from './hostname.js';
export type {
  HostnameCertSource,
  HostnameVerificationMethod,
  HostnameOwnershipStatus,
  HostnameCertProvisioningState,
  HostnameTlsTopology,
  HostnameListenerPort,
  HostnameCertChainMetadata,
  HostnameStorageRow,
  HostnameProjection,
  HostnameListResponse,
  HostnameGetRequest,
  HostnameGetResponse,
  HostnameAddRequest,
  HostnameUpdateRequest,
  HostnameMutationResponse,
  HostnameRemoveRequest,
  HostnameRemoveResponse,
  HostnameOwnershipProofInput,
  HostnameOwnershipProofFailureCode,
  HostnameOwnershipProofResult,
} from './hostname.js';

// D-235 P1 — bring-your-own-domain enrolment + preflight.
export {
  ACME_CHALLENGE_LABEL,
  ACME_ROTATION_CAS,
  CAA_ISSUER_CRITICAL_FLAG,
  CUSTOM_DOMAIN_PREFLIGHT_CHECKS,
  CUSTOM_DOMAIN_PREFLIGHT_STATUSES,
  CUSTOM_DOMAIN_PREFLIGHT_CODES,
  CUSTOM_DOMAIN_ISSUANCE_BLOCKERS,
  CUSTOM_DOMAIN_MAX_PER_SERVER,
  CUSTOM_DOMAIN_DELEGATION_STATES,
  CUSTOM_DOMAIN_DELEGATION_URGENCIES,
  evaluateCustomDomainIssuanceEligibility,
  isCustomDomainIssuanceBlocker,
  isCustomDomainDelegationState,
  customDomainDelegationUrgency,
  delegationStateFromPreflight,
  normalizeDnsName,
  acmeChallengeName,
  customDomainDelegationTarget,
  caaIssuerDomain,
  caaClimbNames,
  isLikelyZoneApex,
  relativeDnsName,
  evaluateCaaForRotation,
  evaluateCustomDomainPreflight,
  isCustomDomainPreflightStatus,
  isCustomDomainPreflightCode,
} from './custom-domain.js';
export type {
  AcmeRotationCa,
  CaaRecord,
  CaaEvaluation,
  CustomDomainPreflightCheck,
  CustomDomainPreflightStatus,
  CustomDomainPreflightCode,
  CustomDomainDnsObservation,
  CustomDomainPreflightCheckResult,
  CustomDomainPreflightResult,
  CustomDomainPreflightRequest,
  CustomDomainPreflightResponse,
  CustomDomainIssuanceBlocker,
  CustomDomainIssuanceDecision,
  CustomDomainIssuanceReadinessRequest,
  CustomDomainIssuanceReadinessResponse,
  CustomDomainDelegationState,
  CustomDomainDelegationUrgency,
} from './custom-domain.js';

// D-152 P1 — free diagnostic suite substrate.
export {
  DIAGNOSTIC_KINDS,
  DIAGNOSTIC_STATUSES,
  DIAGNOSTIC_PORT_OUTCOMES,
  DIAGNOSTIC_NAT_CLASSES,
  DIAGNOSTIC_OWNERSHIP_PROOF_METHODS,
  DIAGNOSTIC_ALLOWED_PORTS,
  DIAGNOSTIC_ACCOUNT_RATE_LIMIT_PER_HOUR,
  DIAGNOSTIC_TARGET_RATE_LIMIT_PER_MINUTE,
  isDiagnosticKind,
  isDiagnosticAllowedPort,
  isDiagnosticOwnershipProofMethod,
} from './diagnostic.js';
export type {
  DiagnosticKind,
  DiagnosticStatus,
  DiagnosticPortOutcome,
  DiagnosticNatClass,
  DiagnosticOwnershipProofMethod,
  DiagnosticAllowedPort,
  DiagnosticRequest,
  DiagnosticPayload,
  DiagnosticResult,
  DiagnosticResponse,
  DiagnosticErrorCode,
} from './diagnostic.js';

// D-152 § A.16 — LAN-only self-hosted webclient bundle substrate.
export {
  WEBCLIENT_PATH_PREFIX,
  WEBCLIENT_BUNDLE_MANIFEST_FILENAME,
  WEBCLIENT_BUNDLE_VERIFY_ERROR_CODES,
  WEBCLIENT_BUNDLE_PATH_REGEX,
  WEBCLIENT_BUNDLE_SHA256_REGEX,
  verifyWebclientBundle,
} from './webclient-bundle.js';
export type {
  WebclientBundleManifest,
  WebclientBundleBuildAttestation,
  WebclientBundleManifestEntry,
  WebclientBundleFile,
  WebclientBundleVerifyErrorCode,
  WebclientBundleVerifyOk,
  WebclientBundleVerifyErr,
  WebclientBundleVerifyIssue,
  WebclientBundleVerifyResult,
} from './webclient-bundle.js';
export type {
  PublicMcpAcknowledgement,
  PinnedCertState,
  NetworkErrorCode,
  // D-148 Wave 3 — path-routing substrate (Amendment 2026-05-11)
  PathRole,
  PathResolution,
  ExposurePreset,
  DerivedPresetLabel,
  ExposureState,
  WsLockoutPhrase,
  // R26.2 Delta 2 — apex (`GET /`) serving mode
  RootApexMode,
  // D-148 Wave 3 sub-phase 2 — TLSDomainStore + multi-domain SNI
  TLSDomainCertSource,
  TLSDomainCertChain,
  TLSDomainCertListEntry,
  TLSDomainUploadInput,
  TLSDomainUploadResult,
  TLSDomainUploadIssue,
  TLSDomainUploadValidation,
  TLSDomainUploadVerifiers,
  TLSDomainStore,
  PinnedDomainCertState,
  // D-176 — multi-domain DDNS zone registry
  DdnsZone,
  // R27 delta-B — user-initiated DDNS pause/resume pair-RPC shapes
  DdnsEnabledStatus,
  DdnsSetEnabledRequest,
  // LAN-URL kickstart — server's locally-reachable URLs (loopback + LAN)
  LocalServerUrl,
  NetworkLocalUrlsResponse,
} from './network.js';

// Total-record builder — replaces the `{} as Record<Union, V>` accumulator that
// silenced the missing-key check at eight sites. See the module for why it is a
// proof rather than a tidier assertion.
export { totalRecord } from './total-record.js';

// D-148 § A.11 P7 — rotation + exposure-changed event substrate.
export {
  ROTATION_OPS,
  ROTATION_OP_KEY_CLASS,
  ROTATION_ERROR_CODES,
  isRotationOp,
  // R26.4 Delta 3 — key.rotate / key.health surface
  KEY_ROTATE_OPS,
} from './d-148-rotation.js';
export type {
  RotationOp,
  RotationErrorCode,
  RotationResult,
  KeyRotationEvent,
  // R26.4 Delta 3 — key.rotate request + key.health view
  KeyRotateRequest,
  RotationAvailability,
  KeyHealthView,
  ExposureChangedEvent,
  CertRotationNotice,
  CertRotationRevertedEvent,
  // D-148 Wave 3 sub-phase 2 — multi-domain rotation event variants
  CertDomainRotationNotice,
  CertDomainRotationRevertedEvent,
  RotationOrExposureEvent,
} from './d-148-rotation.js';

// D-148 § A.9 — Server Passport.
export {
  SERVER_PASSPORT_VERSION,
  SERVER_PASSPORT_PROFILES,
  PASSPORT_REASON_MAX_BYTES,
  projectServerPassport,
  canonicalJSONStringify,
  stripPassportSignature,
  canonicalPassportSigningPayload,
} from './passport.js';
export type {
  ServerPassport,
  ServerPassportProfile,
  ServerPassportIdentityBlock,
  ServerPassportNetworkBlock,
  ServerPassportPathEntry,
  ServerPassportClientEntry,
  ServerCapabilityProfile,
  ServerPassportRecoveryBlock,
  ServerPassportExportOptions,
  ServerPassportClientSummary,
  ServerCapabilityProfileRedacted,
  ServerPassportRecoveryRedacted,
  KeyHealthBundleRedacted,
  ServerPassportSupportRedacted,
  ServerPassportProjection,
  ServerPassportHistoryEntry,
  ServerPassportHistoryListArgs,
  ServerPassportImportCommitResult,
} from './passport.js';

// D-149 P1 — Public Reception substrate (closed-list contracts).
export {
  RECEPTION_ENDPOINT_KINDS,
  RECEPTION_ENDPOINT_KIND_SET,
  isReceptionEndpointKind,
  RECEPTION_PAIR_CONSUMER,
  isReceptionPairableKind,
} from './reception.js';
// D-210 step 2a — the reception record's owner-facing read projection.
export {
  RECEPTION_RECORD_KINDS,
  RECEPTION_RECORD_KIND_SET,
  RECEPTION_RECORD_LIST_LIMIT_DEFAULT,
  RECEPTION_RECORD_LIST_LIMIT_MAX,
  isReceptionRecordKind,
} from './reception-record.js';
export type {
  ReceptionBookingRecordSummary,
  ReceptionRecordKind,
  ReceptionRecordListInput,
  ReceptionRecordListResult,
  ReceptionRecordResolution,
  ReceptionRecordSummary,
  ReceptionSubmissionRecordSummary,
} from './reception-record.js';
// D-240 § D11 — the per-record viewback revoke rpc.
export {
  RECEPTION_LOOKUP_REVOKE_ERROR_CODES,
} from './reception-lookup-revoke.js';
export type {
  ReceptionLookupRevokeInput,
  ReceptionLookupRevokeResult,
  ReceptionLookupRevokeErrorCode,
} from './reception-lookup-revoke.js';
// D-210 Appendix B — the on-the-go `/reception/manage` reschedule-link mint rpc.
export type {
  ReceptionManageMintInput,
  ReceptionManageMintResult,
} from './reception-manage.js';
export {
  RECEPTION_HIGH_ASSURANCE_AUDIT_KINDS,
  RECEPTION_HIGH_ASSURANCE_AUDIT_KIND_SET,
  isReceptionHighAssuranceAuditKind,
  RECEPTION_TABLES,
  RECEPTION_TABLE_SET,
  // D-210 A.8 slice 4b — the merged submission table's outcome vocabulary.
  RECEPTION_SUBMISSION_PROCESSING_OUTCOMES,
  RECEPTION_SUBMISSION_PROCESSING_OUTCOME_SET,
  outcomesForRecordKind,
} from './reception.js';
export type {
  ReceptionEndpointKind,
  ReceptionHighAssuranceAuditKind,
  ReceptionTableName,
  ReceptionSubmissionRecordKind,
} from './reception.js';

// D-149 P3 — `public_endpoint_registry` rpc + source-query allowlist
// + per-IP rate-limit substrate. Registry rpc contracts mirror the
// `ServerRpcRegistry` slot extensions in `rpc/server-registry.ts`.
export {
  SOURCE_QUERY_KINDS,
  SOURCE_QUERY_KIND_SET,
  isSourceQueryKind,
  SOURCE_QUERY_KINDS_PERMITTED_PER_PACKET_KIND,
  isSourceQueryPermittedFor,
  parseSourceQueryRef,
} from './reception-source-query.js';
export type {
  SourceQueryRef,
  SourceQueryKind,
  SourceQueryValidationCode,
  SourceQueryValidationFailure,
  SourceQueryValidationResult,
} from './reception-source-query.js';
export {
  RECEPTION_RATE_BUCKET_KINDS,
  RECEPTION_RATE_BUCKET_KIND_SET,
  RECEPTION_RATE_LIMIT_DEFAULTS,
} from './reception-rate-limit.js';
export type {
  ReceptionRateBucketKind,
  ReceptionRateLimitWindow,
  ReceptionRateLimitConfig,
  ReceptionRateLimitDecision,
} from './reception-rate-limit.js';
export {
  RECEPTION_PER_KIND_EXPIRY_MAX_MS,
  RECEPTION_ACCESS_ACTIONS,
  RECEPTION_ACCESS_OUTCOMES,
  RECEPTION_ACCESS_ACTION_SET,
  RECEPTION_ACCESS_OUTCOME_SET,
  RECEPTION_RPC_METHODS,
  RECEPTION_RPC_METHOD_SET,
  RECEPTION_RPC_ERROR_CODES,
  RECEPTION_RPC_ERROR_CODE_SET,
  RECEPTION_ENDPOINT_KIND_TO_PACKET_KIND,
} from './reception-registry.js';
export type {
  PacketDeclaration,
  EndpointSummary,
  AccessLogEntry,
  ReceptionAccessAction,
  ReceptionAccessOutcome,
  ReceptionEndpointsListFilter,
  ReceptionEndpointsListResult,
  ReceptionEndpointPreviewInput,
  ReceptionEndpointPreviewResult,
  ReceptionEndpointCreateInput,
  ReceptionEndpointCreateResult,
  ReceptionEndpointRotateReason,
  ReceptionEndpointRotateInput,
  ReceptionEndpointRotateResult,
  ReceptionEndpointMutationInput,
  ReceptionEndpointRevokeInput,
  ReceptionEndpointExtendInput,
  ReceptionEndpointAccessLogInput,
  ReceptionEndpointAccessLogResult,
  ReceptionEmergencyDisableAllInput,
  ReceptionEmergencyDisableAllResult,
  ReceptionRpcMethodName,
  ReceptionRpcErrorCode,
  // D-149 P12 § A.20.5 — Abuse Inbox rpc shapes.
  ReceptionIpBlockEntry,
  ReceptionAbuseInboxListInput,
  ReceptionAbuseInboxListResult,
  ReceptionAbuseInboxBanIpInput,
  ReceptionAbuseInboxBanIpResult,
  ReceptionAbuseInboxUnbanIpInput,
  ReceptionAbuseInboxUnbanIpResult,
  // D-149 follow-on § A.10 — Templates browser rpc result.
  ReceptionTemplateListResult,
  // D-151 P2 — intent-first Compose proposal rpc.
  ReceptionComposeProposeInput,
  ReceptionComposeProposeResult,
} from './reception-registry.js';

// D-196 S3 — reusable HTTPS navigation element for Reception pages/forms.
export {
  RECEPTION_LINK_BUTTON_LABEL_MAX,
  RECEPTION_LINK_BUTTON_URL_MAX,
  RECEPTION_LINK_BUTTON_DESCRIPTION_MAX,
  isReceptionLinkButtonUrl,
  validateReceptionLinkButton,
  selectValidReceptionLinkButtons,
} from './reception-link-button.js';
export type {
  ReceptionLinkButton,
  ReceptionLinkButtonValidationCode,
  ReceptionLinkButtonValidationFailure,
} from './reception-link-button.js';

// D-207 slice 3c — the order as the visitor's page may see it. Carries the CSPRNG
// `order_handle` and NEVER the guessable `order_key` (F7).
export {
  RECEPTION_CHECKOUT_REFERENCE_PARAM,
  receptionCheckoutUrl,
  buildReceptionOrderContext,
} from './reception-order-context.js';
export type {
  ReceptionOrderContext,
  ReceptionOrderContextRefusal,
  ReceptionOrderContextResult,
} from './reception-order-context.js';

// D-149 P4 — reception_page singleton config (closed-list contracts).
export {
  RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
  RECEPTION_PAGE_STATIC_PATH_PREFIX,
  RECEPTION_PAGE_DISPLAY_NAME_MAX,
  RECEPTION_PAGE_TAGLINE_MAX,
  RECEPTION_PAGE_RESPONSE_TIME_ESTIMATE_MAX,
  RECEPTION_PAGE_TZ_LABEL_MAX,
  RECEPTION_PAGE_CUSTOM_LINK_LABEL_MAX,
  RECEPTION_PAGE_CUSTOM_LINKS_MAX,
  RECEPTION_PAGE_LINK_BUTTONS_MAX,
  RECEPTION_PAGE_AVATAR_URL_MAX,
  RECEPTION_PAGE_URL_SCHEMES_ALLOWED,
  RECEPTION_PAGE_URL_SCHEME_SET,
  RECEPTION_PAGE_PLACEHOLDER_TEXT,
  isReceptionPageUrlAllowed,
  validateReceptionPageConfig,
  // D-210 Phase C — inbox device-fanout mode.
  RECEPTION_INBOX_FANOUT_MODES,
  resolveReceptionInboxFanoutMode,
} from './reception-page-config.js';
export type {
  ReceptionInboxFanoutMode,
  ReceptionPageConfig,
  ReceptionPageDisplayOverrides,
  ReceptionPageCustomLink,
  ReceptionPageConfigValidationCode,
  ReceptionPageConfigValidationFailure,
  ReceptionPageGetResult,
  ReceptionPageUpsertInput,
  ReceptionPageUpsertResult,
} from './reception-page-config.js';

// D-149 P6 § A.5.3 — intake_form per-endpoint config + submission input.
export {
  INTAKE_FORM_DISPLAY_NAME_MAX,
  INTAKE_FORM_INSTRUCTIONS_MAX,
  INTAKE_FORM_SUCCESS_MESSAGE_MAX,
  INTAKE_FORM_SUBMIT_BUTTON_LABEL_MAX,
  INTAKE_FORM_TEMPLATE_VERSION_MAX,
  INTAKE_FORM_FIELD_NAME_MAX,
  INTAKE_FORM_FIELD_LABEL_MAX,
  INTAKE_FORM_FIELD_ENUM_VALUE_MAX,
  INTAKE_FORM_FIELD_ENUM_VALUE_COUNT_MAX,
  INTAKE_FORM_FIELDS_COUNT_MAX,
  INTAKE_FORM_VISITOR_TEXT_MAX,
  INTAKE_FORM_VISITOR_TEXTAREA_MAX,
  INTAKE_FORM_VISITOR_EMAIL_MAX,
  INTAKE_FORM_VISITOR_ARRAY_ITEMS_MAX,
  INTAKE_FORM_RATE_LIMIT_PER_IP_DEFAULT,
  INTAKE_FORM_RATE_LIMIT_PER_IP_MIN,
  INTAKE_FORM_RATE_LIMIT_PER_IP_MAX,
  INTAKE_FORM_HONEYPOT_FIELDS_MAX,
  INTAKE_FORM_DOMAIN_ALLOWLIST_MAX,
  INTAKE_FORM_DOMAIN_ALLOWLIST_ENTRY_MAX,
  INTAKE_FORM_TARGET_KINDS,
  INTAKE_FORM_TARGET_KIND_SET,
  // D-210 A.7.1 — the record-a-fact / track-a-state axis.
  RECEPTION_DESTINATION_TIERS,
  destinationTier,
  // D-210 WS3 — the calendar / contact destination mappings.
  CALENDAR_MAPPING_INSTANT_FIELD_TYPES,
  INTAKE_FORM_CALENDAR_DURATION_MINUTES_MIN,
  INTAKE_FORM_CALENDAR_DEFAULT_DURATION_MINUTES,
  INTAKE_FORM_CALENDAR_DURATION_MINUTES_MAX,
  INTAKE_FORM_LOCAL_DATETIME_RE,
  INTAKE_FORM_VISITOR_FIELD_REQUIREMENTS,
  INTAKE_FORM_VISITOR_FIELD_REQUIREMENT_SET,
  INTAKE_FORM_SUBMISSION_PROCESSING_OUTCOMES,
  INTAKE_FORM_SUBMISSION_PROCESSING_OUTCOME_SET,
  INTAKE_FORM_DEFAULT_SUBMIT_BUTTON_LABEL,
  INTAKE_FORM_DEFAULT_SUCCESS_MESSAGE,
  validateIntakeFormConfig,
  validateIntakeFormSubmission,
} from './intake-form-config.js';
export type {
  IntakeFormConfig,
  IntakeFormConfigField,
  IntakeFormSubmissionProcessingRule,
  IntakeFormAntiSpamConfig,
  IntakeFormVisitorFieldRequirement,
  IntakeFormVisitorFieldRequirements,
  IntakeFormTargetKind,
  ReceptionDestinationTier,
  IntakeFormCalendarMapping,
  IntakeFormContactMapping,
  IntakeFormConfigValidationCode,
  IntakeFormConfigValidationFailure,
  IntakeFormSubmissionInput,
  IntakeFormSubmissionValidationCode,
  IntakeFormSubmissionValidationFailure,
  IntakeFormSubmissionProcessingOutcome,
} from './intake-form-config.js';

// Accepted free-form intake responses. Reception review promotes into this
// canonical data shape; downstream entity creation remains optional.
export {
  FORM_RESPONSE_EVENT_PLATFORM,
  FORM_RESPONSE_EVENT_SLUG,
  FORM_RESPONSE_EVENT_ENTITY_TYPE,
  FORM_RESPONSE_CREATED_EVENT_PATTERN,
  // D-210 A.7.1 — the lifecycle that makes form_response a tier-2 destination.
  FORM_RESPONSE_LIFECYCLE_STATES,
  FORM_RESPONSE_DEFAULT_LIFECYCLE_STATE,
  FORM_RESPONSE_LIFECYCLE_STATE_SET,
} from './form-response.js';
export type {
  FormResponse,
  FormResponseLifecycleState,
  FormResponseVisitor,
  FormResponseTriggerRecord,
  AcceptFormResponseInput,
  AcceptFormResponseResult,
  FormResponseListCursor,
  FormResponseListQuery,
  FormResponseListItem,
  FormResponseListRpcResponse,
  FormResponseGetRpcRequest,
  FormResponseGetRpcResponse,
  FormResponseSetStateRpcRequest,
  FormResponseSetStateRpcResponse,
  FormResponseUpdateRpcRequest,
  FormResponseUpdateRpcResponse,
  FormResponseExportFormat,
  FormResponseExportRpcRequest,
  FormResponseExportRpcResponse,
} from './form-response.js';

// D-149 P11 § A.10 — pre-built intake_form templates (Foundation pack
// expansion) + the template → IntakeFormConfig conversion bridge.
export {
  INTAKE_FORM_TEMPLATE_REFS,
  INTAKE_FORM_TEMPLATE_REF_SET,
  isIntakeFormTemplateRef,
  INTAKE_FORM_TEMPLATE_NAME_MAX,
  INTAKE_FORM_TEMPLATE_DESCRIPTION_MAX,
  INTAKE_FORM_TEMPLATE_VERSION_RE,
  INTAKE_FORM_TEMPLATE_ANTI_SPAM_DEFAULT_KEYS,
  INTAKE_FORM_TEMPLATE_ANTI_SPAM_DEFAULT_KEY_SET,
  validateIntakeFormTemplate,
  // D-220 Slice B — the ref-independent half, shared with pack templates.
  validateIntakeFormTemplateBody,
  intakeFormConfigFromTemplate,
  parseIntakeFormTemplate,
} from './intake-form-template.js';
export type {
  IntakeFormTemplateRef,
  IntakeFormTemplateAntiSpamDefaults,
  IntakeFormTemplateBody,
  IntakeFormTemplate,
  IntakeFormTemplateValidationCode,
  IntakeFormTemplateValidationFailure,
  IntakeFormConfigFromTemplateOptions,
  IntakeFormTemplateParseResult,
} from './intake-form-template.js';

// D-220 Slice B — pack-shippable `intake_form` templates: the `pack:` ref
// grammar, the safety-matrix clamp, the validator / parser, and the wire
// shapes `reception.template.list` carries for them.
export {
  PACK_INTAKE_FORM_TEMPLATE_REF_PREFIX,
  PACK_INTAKE_FORM_TEMPLATE_REF_MAX,
  PACK_INTAKE_FORM_TEMPLATE_REF_RE,
  parsePackIntakeFormTemplateRef,
  isPackIntakeFormTemplateRef,
  packIntakeFormTemplateRef,
  PACK_INTAKE_FORM_TEMPLATE_VISITOR_PII_CEILING,
  PACK_INTAKE_FORM_TEMPLATE_FORBIDDEN_FIELD_NAMES,
  PACK_INTAKE_FORM_TEMPLATE_FIELD_TYPES,
  PACK_INTAKE_FORM_TEMPLATE_RATE_LIMIT_CEILING,
  PACK_INTAKE_FORM_TEMPLATE_TARGET_KINDS,
  PACK_INTAKE_FORM_TEMPLATE_SAFETY_MATRIX,
  packTemplateFieldNameMatchesForbidden,
  inferPackTemplateVisitorPiiClass,
  validatePackIntakeFormTemplate,
  parsePackIntakeFormTemplate,
} from './pack-intake-form-template.js';
export type {
  PackIntakeFormTemplateRef,
  ParsedPackIntakeFormTemplateRef,
  PackIntakeFormTemplate,
  PackIntakeFormTemplateOwner,
  PackIntakeFormTemplateSafetyMatrix,
  PackIntakeFormTemplateValidationCode,
  PackIntakeFormTemplateValidationFailure,
  PackIntakeFormTemplateParseResult,
  PackReceptionTemplateListing,
  PackReceptionTemplateUnavailable,
} from './pack-intake-form-template.js';

// D-151 — pre-built scheduling_link + reception_page config templates
// (the non-intake half of the Reception Templates browser) + the
// template → per-kind config conversion bridge.
export {
  SCHEDULING_LINK_TEMPLATE_REFS,
  RECEPTION_PAGE_TEMPLATE_REFS,
  DROP_LINK_TEMPLATE_REFS,
  APPROVAL_LINK_TEMPLATE_REFS,
  RECEPTION_CONFIG_TEMPLATE_REFS,
  RECEPTION_CONFIG_TEMPLATE_REF_SET,
  RECEPTION_CONFIG_TEMPLATE_REF_KIND,
  isReceptionConfigTemplateRef,
  RECEPTION_CONFIG_TEMPLATE_NAME_MAX,
  RECEPTION_CONFIG_TEMPLATE_DESCRIPTION_MAX,
  RECEPTION_CONFIG_TEMPLATE_VERSION_RE,
  validateReceptionConfigTemplate,
  schedulingLinkConfigFromTemplate,
  receptionPageConfigFromTemplate,
  dropLinkConfigFromTemplate,
  approvalLinkConfigFromTemplate,
  receptionConfigFromTemplate,
  parseReceptionConfigTemplate,
} from './reception-config-template.js';
export type {
  SchedulingLinkTemplateRef,
  ReceptionPageTemplateRef,
  DropLinkTemplateRef,
  ApprovalLinkTemplateRef,
  ReceptionConfigTemplateRef,
  ReceptionConfigTemplateKind,
  ReceptionPageTemplateConfig,
  SchedulingLinkTemplate,
  ReceptionPageTemplate,
  DropLinkTemplate,
  ApprovalLinkTemplate,
  ReceptionConfigTemplate,
  ReceptionConfigTemplateValidationCode,
  ReceptionConfigTemplateValidationFailure,
  ReceptionConfigFromTemplateOptions,
  ReceptionConfigTemplateSeed,
  ReceptionConfigTemplateParseResult,
} from './reception-config-template.js';

// D-149 P12 § A.20 — visitor-facing UX features (Launch Wizard /
// View-As-Visitor Preview / Visitor Receipt / Endpoint Share Cards /
// Abuse Inbox / Per-Endpoint Safety Labels / Public Trust Footer).
export {
  TRUST_FOOTER_DEPLOYMENT_MODES,
  TRUST_FOOTER_DEPLOYMENT_MODE_SET,
  buildTrustFooter,
  SAFETY_LABEL_KINDS,
  SAFETY_LABEL_KIND_SET,
  SAFETY_LABEL_EMOJI,
  buildSafetyLabels,
  SHARE_CARD_CHANNELS,
  SHARE_CARD_CHANNEL_SET,
  buildShareCards,
  ABUSE_INBOX_SIGNAL_KINDS,
  ABUSE_INBOX_SIGNAL_KIND_SET,
  ABUSE_INBOX_DEFAULT_CLUSTER_THRESHOLD,
  ABUSE_INBOX_DEFAULT_WINDOW_MS,
  ABUSE_INBOX_KEY_DELIMITER,
  RECEPTION_IP_BLOCKED_REJECTION_REASON,
  classifyAbuseSignal,
  abuseInboxBlockKey,
  buildAbuseInbox,
  buildVisitorReceipt,
  PACKET_STRIPPED_FIELDS_RATIONALE,
  RECEPTION_KIND_TOKEN_MODE,
  RECEPTION_KIND_AUDIT_MODE,
  RECEPTION_PRIVACY_INVARIANT_LABELS,
  buildViewAsVisitorPanel,
  LAUNCH_WIZARD_STEPS,
  LAUNCH_WIZARD_STEP_SET,
  RECEPTION_RECOMMENDED_EXPOSURE_PROFILE,
  LAUNCH_WIZARD_DROP_CONFIG_ID,
  validateLaunchWizardInput,
  buildLaunchWizardPlan,
} from './reception-visitor-ux.js';
export {
  VISITOR_RECEIPT_VIA_VALUES,
  VISITOR_RECEIPT_VIA_SET,
  VISITOR_RECEIPT_DEFAULT_VIA,
  validateVisitorReceiptConfig,
} from './visitor-receipt-config.js';
export type {
  VisitorReceiptVia,
  VisitorReceiptConfig,
  VisitorReceiptConfigValidationCode,
  VisitorReceiptConfigValidationFailure,
} from './visitor-receipt-config.js';
// D-240 — submitter viewback config (spec D-240).
export {
  VISITOR_LOOKUP_MODES,
  VISITOR_LOOKUP_MODE_SET,
  isVisitorLookupMode,
  VISITOR_LOOKUP_MODES_PERMITTED_PER_RECORD_KIND,
  VISITOR_LOOKUP_COMPLETABLE_TARGET_KINDS,
  VISITOR_LOOKUP_COMPLETABLE_TARGET_KIND_SET,
  VISITOR_LOOKUP_ANCHOR_FIELD_TYPES,
  VISITOR_LOOKUP_ANCHOR_FIELD_TYPE_SET,
  VISITOR_LOOKUP_MIN_TTL_MS,
  VISITOR_LOOKUP_MAX_TTL_MS,
  VISITOR_LOOKUP_ABSOLUTE_CEILING_MS,
  VISITOR_LOOKUP_DEFAULT_TTL_MS,
  VISITOR_LOOKUP_DEFAULT_GRACE_MS,
  VISITOR_LOOKUP_CONFIG_VALIDATION_CODES,
  VISITOR_LOOKUP_SUPPORTED_MODES,
  VISITOR_LOOKUP_SUPPORTED_MODE_SET,
  validateVisitorLookupConfig,
  resolveVisitorLookupExpiry,
  parseVisitorLookupAnchor,
} from './visitor-lookup-config.js';
export type {
  VisitorLookupMode,
  VisitorLookupSupportedMode,
  VisitorLookupExpiry,
  VisitorLookupExpiryInputs,
  VisitorLookupExpiryResolution,
  VisitorLookupConfig,
  VisitorLookupValidationContext,
  VisitorLookupConfigValidationCode,
  VisitorLookupConfigValidationFailure,
} from './visitor-lookup-config.js';
export type {
  TrustFooterDeploymentMode,
  TrustFooterInput,
  SafetyLabelKind,
  SafetyLabel,
  SafetyLabelsInput,
  ShareCardChannel,
  ShareCard,
  ShareCardsInput,
  AbuseInboxSignalKind,
  AbuseInboxRow,
  AbuseInboxSummary,
  AbuseInboxInput,
  VisitorReceiptFieldEcho,
  VisitorReceipt,
  VisitorReceiptInput,
  ViewAsVisitorFieldRow,
  ViewAsVisitorInvariantRow,
  ViewAsVisitorPanel,
  ViewAsVisitorInput,
  LaunchWizardStepId,
  LaunchWizardEndpointDraft,
  LaunchWizardInput,
  LaunchWizardPlan,
  LaunchWizardValidationCode,
  LaunchWizardValidationFailure,
} from './reception-visitor-ux.js';

// D-149 P7 § A.5.4 — drop_link per-endpoint config + upload input.
export {
  DROP_LINK_SIZE_CAP_HARD_MAX_BYTES,
  DROP_LINK_SIZE_CAP_MIN_BYTES,
  DROP_LINK_SIZE_CAP_DEFAULT_BYTES,
  DROP_LINK_EXPIRY_DAYS_MAX,
  DROP_LINK_EXPIRY_DAYS_MIN,
  DROP_LINK_EXPIRY_DAYS_DEFAULT,
  DROP_LINK_MAX_UPLOADS_PER_DAY_MAX,
  DROP_LINK_MAX_UPLOADS_PER_DAY_MIN,
  DROP_LINK_MAX_UPLOADS_PER_DAY_DEFAULT,
  DROP_LINK_DISPLAY_NAME_MAX,
  DROP_LINK_INSTRUCTIONS_MAX,
  DROP_LINK_SUCCESS_MESSAGE_MAX,
  DROP_LINK_SUBMIT_BUTTON_LABEL_MAX,
  DROP_LINK_VISITOR_NAME_MAX,
  DROP_LINK_VISITOR_EMAIL_MAX,
  DROP_LINK_VISITOR_DESCRIPTION_MAX,
  DROP_LINK_VISITOR_FILENAME_MAX,
  DROP_LINK_ALLOWED_MIME_TYPES,
  DROP_LINK_ALLOWED_MIME_TYPE_SET,
  DROP_LINK_ALLOWED_MIME_TYPES_PER_CONFIG_MAX,
  DROP_LINK_PROCESSING_OUTCOMES,
  DROP_LINK_PROCESSING_OUTCOME_SET,
  DROP_LINK_SCAN_STATUSES,
  DROP_LINK_SCAN_STATUS_SET,
  DROP_LINK_DOMAIN_ALLOWLIST_MAX,
  DROP_LINK_DOMAIN_ALLOWLIST_ENTRY_MAX,
  DROP_LINK_DEFAULT_SUCCESS_MESSAGE,
  DROP_LINK_DEFAULT_SUBMIT_BUTTON_LABEL,
  validateDropLinkConfig,
  validateDropLinkUpload,
} from './drop-link-config.js';
export type {
  DropLinkConfig,
  DropLinkContactScoping,
  DropLinkOnUploadConfig,
  DropLinkAllowedMimeType,
  DropLinkProcessingOutcome,
  DropLinkScanStatus,
  DropLinkConfigValidationCode,
  DropLinkConfigValidationFailure,
  DropLinkUploadInput,
  DropLinkUploadValidationCode,
  DropLinkUploadValidationFailure,
} from './drop-link-config.js';

// D-149 P9 § A.5.6 — status_link per-endpoint config.
export {
  STATUS_LINK_EXPIRY_DAYS_MAX,
  STATUS_LINK_EXPIRY_DAYS_MIN,
  STATUS_LINK_EXPIRY_DAYS_DEFAULT,
  STATUS_LINK_DISPLAY_NAME_MAX,
  STATUS_LINK_CAPTION_MAX,
  STATUS_LINK_REFRESH_INTERVAL_SECONDS_MIN,
  STATUS_LINK_REFRESH_INTERVAL_SECONDS_MAX,
  STATUS_LINK_REFRESH_INTERVAL_SECONDS_DEFAULT,
  STATUS_LINK_DEFAULT_CAPTION,
  validateStatusLinkConfig,
} from './status-link-config.js';
export type {
  StatusLinkConfig,
  StatusLinkRefreshPolicy,
  StatusLinkConfigValidationCode,
  StatusLinkConfigValidationFailure,
} from './status-link-config.js';

// D-149 P8 § A.5.5 — approval_link per-endpoint config + consume input.
export {
  APPROVAL_LINK_EXPIRY_DAYS_MAX,
  APPROVAL_LINK_EXPIRY_DAYS_MIN,
  APPROVAL_LINK_EXPIRY_DAYS_DEFAULT,
  APPROVAL_LINK_DISPLAY_NAME_MAX,
  APPROVAL_LINK_PROMPT_MAX,
  APPROVAL_LINK_CONTEXT_SUMMARY_MAX,
  APPROVAL_LINK_SUCCESS_MESSAGE_MAX,
  APPROVAL_LINK_SUBMIT_BUTTON_LABEL_MAX,
  APPROVAL_LINK_OPTION_LABEL_MAX,
  APPROVAL_LINK_OPTION_DESCRIPTION_MAX,
  APPROVAL_LINK_OPTION_ID_MAX,
  APPROVAL_LINK_OPTIONS_MIN,
  APPROVAL_LINK_OPTIONS_MAX,
  APPROVAL_LINK_VISITOR_NAME_MAX,
  APPROVAL_LINK_VISITOR_EMAIL_MAX,
  APPROVAL_LINK_VISITOR_ANSWER_MAX,
  APPROVAL_LINK_VISITOR_COMMENT_MAX,
  APPROVAL_LINK_DEFAULT_SUBMIT_BUTTON_LABEL,
  APPROVAL_LINK_DEFAULT_SUCCESS_MESSAGE,
  APPROVAL_LINK_ON_APPROVE_ACTIONS,
  APPROVAL_LINK_ON_APPROVE_ACTION_SET,
  APPROVAL_LINK_SUPPORTED_ON_APPROVE_ACTIONS,
  APPROVAL_LINK_WRITE_ONLY_REFUSAL_CODES,
  APPROVAL_LINK_WRITE_ONLY_REFUSAL_CODE_SET,
  APPROVAL_LINK_SUPPORTED_ON_APPROVE_ACTION_SET,
  APPROVAL_LINK_DEFAULT_ON_APPROVE_ACTION,
  APPROVAL_LINK_PROCESSING_OUTCOMES,
  APPROVAL_LINK_PROCESSING_OUTCOME_SET,
  validateApprovalLinkConfig,
  validateApprovalLinkConsume,
  formatApprovalLinkConsumedOutcome,
} from './approval-link-config.js';
export type {
  ApprovalLinkConfig,
  ApprovalLinkOnActionConfig,
  ApprovalLinkOnApproveAction,
  ApprovalLinkSupportedOnApproveAction,
  ApprovalLinkProcessingOutcome,
  ApprovalLinkConfigValidationCode,
  ApprovalLinkConfigValidationFailure,
  ApprovalLinkConsumeInput,
  ApprovalLinkConsumeValidationCode,
  ApprovalLinkConsumeValidationFailure,
  ApprovalLinkConsumedOutcome,
} from './approval-link-config.js';

// D-149 P5 § A.5.2 — scheduling_link per-endpoint config + booking input.
export {
  SCHEDULING_LINK_DURATION_OPTION_MINUTES_ALLOWED,
  SCHEDULING_LINK_DURATION_OPTION_MINUTES_SET,
  SCHEDULING_LINK_MIN_ADVANCE_NOTICE_HOURS_MAX,
  SCHEDULING_LINK_MAX_LEAD_TIME_DAYS_MAX,
  SCHEDULING_LINK_MAX_BOOKINGS_PER_DAY_MAX,
  SCHEDULING_LINK_DISPLAY_NAME_MAX,
  SCHEDULING_LINK_INSTRUCTIONS_MAX,
  SCHEDULING_LINK_SUCCESS_MESSAGE_MAX,
  SCHEDULING_LINK_TZ_MAX,
  SCHEDULING_LINK_NOTIFY_VISITOR_SENDER_MAX,
  SCHEDULING_LINK_VISITOR_NAME_MAX,
  SCHEDULING_LINK_VISITOR_EMAIL_MAX,
  SCHEDULING_LINK_VISITOR_PHONE_MAX,
  SCHEDULING_LINK_VISITOR_TOPIC_MAX,
  SCHEDULING_LINK_VISITOR_NOTES_MAX,
  SCHEDULING_LINK_BOOKING_PROCESSING_OUTCOMES,
  SCHEDULING_LINK_BOOKING_PROCESSING_OUTCOME_SET,
  validateSchedulingLinkConfig,
  validateSchedulingLinkBooking,
  isSchedulingLinkVisitorFieldRequirements,
  SCHEDULING_LINK_VISITOR_FIELD_NAMES,
} from './scheduling-link-config.js';
export type {
  SchedulingLinkConfig,
  SchedulingLinkExplicitWindow,
  SchedulingLinkAvailableWindowDefinition,
  SchedulingLinkOnBookingConfig,
  SchedulingLinkConfigValidationCode,
  SchedulingLinkConfigValidationFailure,
  SchedulingLinkBookingInput,
  SchedulingLinkBookingValidationCode,
  SchedulingLinkBookingValidationFailure,
  SchedulingLinkBookingProcessingOutcome,
} from './scheduling-link-config.js';

// D-137 P1 — AI Chat substrate (closed-list contracts).
export {
  TOOL_TIERS,
  TOOL_TIER_SET,
  isToolTier,
  TIER1_TOOL_NAMES,
  TIER1_TOOL_NAME_SET,
  isTier1ToolName,
  TIER1_TOPIC_TAGS,
  TIER1_CLASSIFICATIONS,
  TIER1_CONCURRENCY_SAFE,
  TIER1_TOOL_DESCRIPTORS,
  TIER1_TOOL_ENTITY,
  CHAT_DISPATCH_CHANNELS,
  CHAT_DISPATCH_CHANNEL_SET,
  isChatDispatchChannel,
  CHAT_DISPATCH_REASONS,
  CHAT_DISPATCH_REASON_SET,
  isChatDispatchReason,
  CHAT_MODEL_ROUTING_LAYERS,
  CHAT_MODEL_ROUTING_LAYER_SET,
  isChatModelRoutingLayer,
  CHAT_MODEL_SOURCE_IDS,
  CHAT_MODEL_SOURCE_ID_SET,
  isChatModelSourceId,
  CHAT_CATALOG_DELIVERY_MODES,
  isChatCatalogDeliveryMode,
  CHAT_CATALOG_SMART_DEFAULT_BY_SOURCE,
  CHAT_MODEL_HINTS,
  CHAT_MODEL_HINT_SET,
  isChatModelHint,
  CHAT_PICKER_SELF,
  CHAT_MESSAGE_ROLES,
  CHAT_MESSAGE_ROLE_SET,
  isChatMessageRole,
  CHAT_DATA_DIAGNOSIS_RELATIONSHIPS,
  CHAT_DATA_DIAGNOSIS_RELATIONSHIP_SET,
  isChatDataDiagnosisRelationship,
  CHAT_DATA_DIAGNOSIS_INTENTS,
  CHAT_DATA_DIAGNOSIS_INTENT_SET,
  isChatDataDiagnosisIntent,
  CHAT_DATA_DIAGNOSIS_RESOLUTION_STATUSES,
  CHAT_DATA_DIAGNOSIS_RESOLUTION_STATUS_SET,
  isChatDataDiagnosisResolutionStatus,
  CHAT_RPC_METHODS,
  CHAT_RPC_METHOD_SET,
  isChatRpcMethod,
  CHAT_BROADCAST_EVENT_KINDS,
  CHAT_BROADCAST_EVENT_KIND_SET,
  isChatBroadcastEventKind,
  CHAT_HISTORY_WINDOW,
  CHAT_HISTORY_WINDOW_MAX,
  CHAT_SESSION_CHANGED_FIELDS,
  CHAT_SESSION_CHANGED_FIELD_SET,
  isChatSessionChangedField,
  CHAT_TABLES,
  CHAT_TABLE_SET,
  // D-137 W2.2 — Mary's per-kind catalog scope
  SAFE_DEFAULT_CHAT_CATALOG_KINDS,
  DEFAULT_CHAT_CATALOG_SCOPE,
  computeKindGatedTier2Names,
  CHAT_TOOL_CATALOG_SCOPE_VALIDATION_ISSUE_CODES,
  validateChatToolCatalogScopeInput,
  // D-137 W2.3 — Tier 3 (connection.mcp.*) catalog substrate
  TIER3_TOOL_CLASSIFICATIONS,
  TIER3_TOOL_CLASSIFICATION_SET,
  isTier3ToolClassification,
  buildDefaultConnectionMcpAnnotation,
  formatTier3ToolName,
  CONNECTION_MCP_ANNOTATION_VALIDATION_ISSUE_CODES,
  validateConnectionMcpAnnotationInput,
  // D-137 W2.4 § A.14 — chat-agent model routing helpers
  chatModelLayerToForceLayer,
  isLocalSlotBaseUrl,
  // D-164 P6.3 — chat main-turn kernel manifest + tool-loop cap
  CHAT_MAIN_TURN_INGREDIENT_SLUG,
  CHAT_MAIN_TURN_TOOL_LOOP_CAP,
  CHAT_MAIN_TURN_DISCOVERY_ROUND_CAP,
  modelTierToModelHint,
  // D-167 (recall path) — recall-tool classification + prior-tool-call partition
  NON_RETAINABLE_RECALL_TOOL_NAMES,
  MEMORY_RECALL_TOOL_NAMES,
  partitionPriorToolCalls,
  RECALL_RECEIPT_RESULT,
  recallMatchCount,
  toRecallReceipt,
  withRecallReceipts,
  // D-137 P2 § A.4 — Server-side read consolidation
  SCOPE_SEARCH_SOURCE_IDS,
  SCOPE_SEARCH_SOURCE_ID_SET,
  isScopeSearchSourceId,
  SCOPE_SEARCH_TOOL_SOURCES,
  // D-137 P3 § A.5 + § A.11 — confidence-shape dispatch + plan-approval
  CHAT_CONFIDENCE_PATTERNS,
  CHAT_PLAN_STATUSES,
  CHAT_PLAN_STATUS_SET,
  isChatPlanStatus,
  // D-137 P4 § A.7 + § A.7.1 — Picker entry substrate
  // D-137 P5 § A.9 — Inbound MCP token grants substrate
  MCP_INBOUND_CONCURRENCY_LADDER,
  MCP_INBOUND_CONCURRENCY_TIER_SET,
  isMcpInboundConcurrencyTier,
  MCP_INBOUND_TOKEN_DEFAULT_EXPIRY_MS,
  MCP_INBOUND_TOKEN_PREFIX,
  // D-225 auto-mint — the raw-op wire prefix, shared with the loopback filter.
  RAW_OP_TOOL_PREFIX,
  CANONICAL_OP_TOOL_PREFIX,
  buildDefaultMcpInboundTokenGrants,
  isMcpInboundTokenActive,
  isMcpInboundTokenToolAuthorized,
  summarizeMcpInboundTokenCapability,
  MCP_INBOUND_TOKEN_VALIDATION_ISSUE_CODES,
  validateMcpInboundTokenInput,
  validateInboundTokenChatModeUpdate,
  // D-177 N.11 rule 5 (5.f) — the role→contributor server stamp
  contributorForChatRole,
} from './chat.js';
export type {
  ToolTier,
  Tier1ToolName,
  ToolEntry,
  Tier1ToolDescriptor,
  ChatDispatchChannel,
  ChatDispatchContext,
  ChatDispatchReason,
  ChatDispatchResult,
  ChatRunHeld,
  InternalToolRegistry,
  ChatModelRoutingLayer,
  ChatModelSourceId,
  ChatCatalogDeliveryMode,
  ChatModelHint,
  ChatPickerSelf,
  ChatPickerTarget,
  RecuedServerSignature,
  ChatSession,
  ChatMessageRole,
  // D-177 N.11 rule 5 (5.f) — contributor stamp on chat session items
  ChatSessionContributor,
  ChatToolCall,
  ChatPriorToolCall,
  ChatProvenanceRef,
  ChatMessageAttachment,
  ChatDataDiagnosisRelationship,
  ChatDataDiagnosisIntent,
  ChatDataDiagnosisResolutionStatus,
  ChatDataDiagnosisResolution,
  ChatDataDiagnosisRequest,
  ChatDataDiagnosisContext,
  ChatMessage,
  ChatReplyReference,
  ChatMessageReply,
  ChatEgressPacket,
  ChatSessionSummary,
  ChatRpcMethod,
  ChatBroadcastEventKind,
  ChatHistoryCursor,
  ChatMessageSearchRequest,
  ChatMessageSearchMatch,
  ChatMessageSearchResult,
  ChatSessionGetRequest,
  ChatSessionChangedField,
  ChatTableName,
  // D-137 W2.2 — Mary's per-kind catalog scope
  ChatToolCatalogScopeState,
  ChatToolCatalogScopeValidationIssueCode,
  ChatToolCatalogScopeValidationIssue,
  // D-137 W2.3 — Tier 3 (connection.mcp.*) catalog substrate
  Tier3ToolClassification,
  McpToolDescriptor,
  ConnectionMcpToolOverride,
  ConnectionMcpAnnotationState,
  ConnectionMcpAnnotationValidationIssueCode,
  ConnectionMcpAnnotationValidationIssue,
  ValidatedConnectionMcpAnnotationInput,
  // D-137 P5 § A.7.1 + § A.10 — chat-mode metadata on connection annotation
  ConnectionMcpChatMode,
  ConnectionMcpChatModeSessionCap,
  // D-137 P5 § A.9 — Inbound MCP token grants substrate
  McpInboundConcurrencyTier,
  McpInboundTokenChatMode,
  McpInboundTokenRecord,
  IssuedMcpInboundToken,
  McpInboundTokenCapabilitySummary,
  McpInboundTokenValidationIssueCode,
  McpInboundTokenValidationIssue,
  ValidatedMcpInboundTokenInput,
  // D-137 W2.4 § A.14 — chat-agent model routing helpers
  ChatForceLayer,
  // D-164 P6.3 — chat main-turn tail-message shape
  ChatTailMessage,
  // D-137 P2 § A.4 — Server-side read consolidation
  ScopeSearchSourceId,
  ScopeSearchCandidate,
  ScopeSearchPartialFailure,
  ScopeSearchResult,
  ChatContactCandidate,
  ChatDealCandidate,
  ChatAccountCandidate,
  CrmConnectionFreshness,
  // D-137 P4 § A.7 + § A.7.1 — Picker entry substrate
  // D-137 P3 § A.5 — confidence-shape dispatch envelope
  ChatConfidencePattern,
  ChatConfidenceMeasures,
  ChatConfidenceShape,
  ChatConfidenceEnvelope,
  ChatRecipeFallbackSuggestion,
  // D-137 P3 § A.11 — plan-approval substrate
  ChatPlanStatus,
  ChatPlanProposal,
  ChatPlanExecutionReceipt,
  ChatPlanRecord,
} from './chat.js';

// D-137 Trio #E — per-call token usage telemetry.
export { aggregateTokenUsageReports } from './token-usage-report.js';
export type { TokenUsageReport, TokenUsageAttribution } from './token-usage-report.js';

// D-148 § A.10 — Reachability Doctor.
export {
  REACHABILITY_RECOMMENDATION_CODES,
  FREE_REACHABILITY_PROBE_RATE_LIMIT_PER_HOUR,
  FREE_REACHABILITY_TARGET_RATE_LIMIT_PER_MINUTE,
} from './reachability.js';
export type {
  ReachabilityReport,
  ReachabilityRecommendationCode,
  ReachabilityNetworkBlock,
  ReachabilityDnsBlock,
  ReachabilityTlsBlock,
  ReachabilityHandshakeTest,
  ReachabilityPathEntry,
  ReachabilityReceptionSpecific,
  ReachabilityHmacTest,
  ReachabilityWebhookEntry,
  ReachabilityBridgeEntry,
  ReachabilityWebclientEntry,
  ReachabilityRecommendation,
  ReachabilityPerDomainTlsEntry,
  CloudProbeRequest,
  CloudProbeResponse,
  ProbeTargetKind,
  ProbeTarget,
  ProbeTargetResult,
} from './reachability.js';

// D-176 — authoritative-write DNS provider seam + canonical hostname row.
export type {
  DnsAddressType,
  DnsAddressRecord,
  AuthoritativeDnsProvider,
  HostnameProviderState,
  HostnameRow,
} from './ddns-provider.js';

// D-176 Phase 2 — apply-agent wire protocol (cloud provider ↔ VPS agent).
export {
  DNS_APPLY_PATHS,
  DNS_APPLY_HEALTH_PATH,
  DNS_APPLY_TIMESTAMP_HEADER,
  DNS_APPLY_SIGNATURE_HEADER,
  DNS_APPLY_MAX_SKEW_MS,
  signDnsApplyRequest,
  verifyDnsApplyRequest,
  type DnsApplyRRsetRequest,
  type DnsApplyRemoveRequest,
  type DnsZoneStateRequest,
  type DnsZoneStateResponse,
  type DnsZoneRebuildRequest,
  type DnsZoneRebuildResponse,
  type DnsAcmeChallengeRequest,
  type DnsApplyOkResponse,
  type DnsApplyErrorResponse,
  type DnsApplyVerifyResult,
} from './dns-apply-protocol.js';

// D-148 § A.3 — Browser Bridge.
export {
  BRIDGE_ACTIONS,
  BRIDGE_SURFACE_KINDS,
  BRIDGE_ERROR_CODES,
  BRIDGE_COMMAND_DEFAULT_TIMEOUT_MS,
  BRIDGE_COMMAND_MAX_TIMEOUT_MS,
  BRIDGE_MAX_QUEUE_DEPTH,
  BRIDGE_IDEMPOTENCY_TTL_MS,
  BRIDGE_ALLOWED_CHROME_PERMISSIONS,
  BRIDGE_PROHIBITED_CHROME_PERMISSIONS,
  BRIDGE_LOCAL_STORAGE_FIELDS,
  isPatternWithinGrantedOrigins,
  isCommandWithinIngredientGrant,
  isValidChromeMatchPattern,
  BRIDGE_REVIEW_DOCUMENT_LIMIT,
  isBridgeDocumentIdentity,
} from './bridge.js';
export type {
  BridgeAction,
  BridgeSurfaceKind,
  BridgeIngredientRef,
  BridgeIngredientGrant,
  BridgeCommand,
  BridgeDocumentIdentity,
  BridgeErrorCode,
  BridgeResultStatus,
  BridgeResult,
  BridgeCancelCommand,
  BridgeWireEnvelope,
  BridgeFromBridgeWireEnvelope,
  BridgeQueueState,
  ServerToBridgeNotification,
  BridgeClickAction,
  BridgeCapacityGap,
  AggregateCapacityGap,
  BridgeCapacityRemediationAction,
  BridgeCapacityRemediation,
  BridgeCapabilityProfile,
} from './bridge.js';

// D-145 PB8 / PC1 — Bridge platform classification (publishing-vs-
// messaging marketplace validator substrate).
export {
  FORBIDDEN_SURFACE_KINDS,
  FORBIDDEN_SURFACE_KIND_SET,
  PUBLISHING_PLATFORMS,
  MESSAGING_PLATFORMS_REJECTED,
  AUTHORING_PLATFORMS,
  READING_PLATFORMS,
  MESSAGING_DOMAIN_BLOCKLIST,
  MESSAGING_SELECTOR_BLOCKLIST,
  MIXED_SURFACE_DOMAINS,
  MIXED_SURFACE_DOMAIN_SET,
} from './bridge-platforms.js';

// D-145 PB8 — Social-graph intelligence addon (contracts).
export {
  SOCIAL_PLATFORMS,
  SOCIAL_PLATFORM_SET,
  SOCIAL_ALIAS_KIND,
  SOCIAL_PLATFORM_INGREDIENT_SLUG,
  SOCIAL_PLATFORM_LOGIN_SITE,
  SOCIAL_CONTENT_CLASSES,
  SOCIAL_CONTENT_CLASS_SET,
  SOCIAL_CLASS_REQUIRED_POLICIES,
  detectSocialClassPolicyDrift,
  SOCIAL_ALIAS_RESOLUTION_DECISIONS,
  SOCIAL_ALIAS_RESOLUTION_DECISION_SET,
  SOCIAL_ALIAS_AUTO_CONFIRM_FLOOR,
  SOCIAL_ALIAS_REJECT_FLOOR,
} from './social-graph.js';
export type {
  SocialPlatform,
  SocialAliasKind,
  SocialContentClass,
  SocialBridgePost,
  SocialBridgeFetchResult,
  SocialDerivedSummary,
  SocialAliasResolutionDecision,
} from './social-graph.js';

// D-148 § A.4 — Thin Webclient contract.
export {
  WEBCLIENT_LOCAL_STORAGE_FIELDS,
  WEBCLIENT_PROFILE_STORAGE_FIELDS,
  WEBCLIENT_SNAPSHOT_SURFACES,
  WEBCLIENT_FORBIDDEN_IMPORT_PREFIXES,
  WEBCLIENT_INDEXED_DB_NAME,
  WEBCLIENT_OBJECT_STORES,
  APPROVAL_NONCE_ERROR_CODES,
  APPROVAL_NONCE_TTL_MS,
  APPROVAL_AUTO_DENY_DEFAULT_MS,
  PASSPORT_FETCH_PREVIOUS_VALID_WINDOW_MS,
  isWebclientSnapshotSurface,
} from './webclient.js';
export type {
  WebclientLocalStorage,
  WebclientLocalKey,
  WebclientServerProfile,
  WebclientTokenRecord,
  WebclientPairMetadata,
  WebclientCertPinState,
  WebclientSnapshotSurface,
  WebclientStateSnapshot,
  ApprovalNonceEnvelope,
  ApprovalResponseWire,
  ApprovalNonceErrorCode,
  WebclientInternalStepEntry,
} from './webclient.js';

// D-148 § A.5.6 — handle governance (DDNS-zone reservations +
// Unicode-confusable detection + P8 reservation/change/transfer
// state machine).
export {
  D148_RESERVED_HANDLES,
  D148_HANDLE_REGEX,
  D148_HANDLE_MIN_LENGTH,
  D148_HANDLE_MAX_LENGTH,
  computeHandleSkeleton,
  canonicalizeHandle,
  findConfusableHandle,
  validateHandle,
  HANDLE_RPC_REPLAY_WINDOW_MS,
  HANDLE_ABUSE_REPORT_DETAIL_MAX_BYTES,
  HANDLE_ABUSE_KINDS,
  isHandleAbuseKind,
  HANDLE_SUBSCRIPTION_STATES,
  isHandleSubscriptionState,
  HANDLE_RPC_ERROR_CODES,
} from './handle.js';
export type {
  HandleValidationCode,
  HandleValidationIssue,
  HandleValidationOptions,
  HandleValidationResult,
  HandleSubscriptionState,
  HandleHistoryEntry,
  HandleHistoryReason,
  HandleAbuseKind,
  HandleReserveRequest,
  HandleReserveResponse,
  HandleChangeRequest,
  HandleChangeResponse,
  HandleTransferRequest,
  HandleTransferResponse,
  HandleAbuseReportRequest,
  HandleAbuseReportResponse,
  HandleRpcErrorCode,
} from './handle.js';

// D-148 § A.5.3 / § A.6.5 — Pro auth rpc surface (server-side
// persistence of the `pro_subscription_token`; binds the ACME
// factory's `ProAuthResolver`). Minting is external (Stripe per
// § A.13 future).
export {
  PRO_AUTH_RPC_ERROR_CODES,
  PRO_AUTH_TOKEN_MAX_BYTES,
  PRO_AUTH_TOKEN_MIN_BYTES,
} from './d148-pro-auth.js';
export type {
  ProAuthRpcErrorCode,
  ProAuthenticateRequest,
  ProAuthenticateResponse,
  ProSignOutRequest,
  ProSignOutResponse,
  ProCurrentRequest,
  ProCurrentResponse,
} from './d148-pro-auth.js';


// D-148 § A.5 / § A.12 / § A.14 — Cloud API wire shapes (P5).
export {
  DDNS_UPDATE_RATE_LIMIT_PER_HOUR,
  DDNS_PAUSE_REPLAY_WINDOW_MS,
  DDNS_PAUSE_RATE_LIMIT_PER_HOUR,
  ACME_ISSUE_CERT_RATE_LIMIT_PER_DAY,
  ACME_REPLAY_WINDOW_MS,
  OAUTH_STATE_TOKEN_REPLAY_WINDOW_MS,
  OAUTH_CLOUD_CALLBACK_URL,
  vendorOAuthRedirectChoices,
  canonicalizeServerPublicUrl,
  CLOUD_LOG_ALLOWED_FIELDS,
  CLOUD_PATH_FAMILIES,
  isCloudPathFamily,
  CERT_RENEWAL_OVERDUE_DEGRADED_REASON,
  OPERATOR_ABUSE_ACTIONS,
  OPERATOR_ABUSE_REPLAY_WINDOW_MS,
} from './cloud-api.js';
export type {
  DdnsUpdateRequest,
  DdnsUpdateResponse,
  DdnsErrorCode,
  DdnsPauseRequest,
  DdnsPauseResponse,
  DdnsPauseErrorCode,
  AcmeIssueCertRequest,
  AcmeIssueCertResponse,
  AcmeErrorCode,
  ReachabilityErrorCode,
  OauthStateTokenPayload,
  OauthStateTokenWire,
  OauthCallbackErrorCode,
  CloudLogField,
  CloudPathFamily,
  OperatorAbuseAction,
  OperatorAbuseRequest,
  OperatorAbuseResponse,
  OperatorAbuseErrorCode,
} from './cloud-api.js';

// D-174 Slice 2b — foundational-lane OAuth substrate (Mail + Calendar).
export {
  GOOGLE_AUTHORIZE_URL,
  MICROSOFT_AUTHORIZE_URL,
  MICROSOFT_TOKEN_URL,
  GOOGLE_TOKEN_URL,
  GMAIL_READONLY_SCOPE,
  GMAIL_SEND_SCOPE,
  GOOGLE_USERINFO_EMAIL_SCOPE,
  GCAL_SCOPE,
  GRAPH_MAIL_READ_SCOPE,
  GRAPH_MAIL_SEND_SCOPE,
  GRAPH_CALENDAR_SCOPE,
  GRAPH_OFFLINE_SCOPE,
  GRAPH_USER_READ_SCOPE,
  GRAPH_FILES_READ_SCOPE,
  GRAPH_FILES_READWRITE_SCOPE,
  GRAPH_SITES_READ_ALL_SCOPE,
  GRAPH_SITES_READWRITE_ALL_SCOPE,
  gmailScopes,
  graphMailScopes,
  gcalScopes,
  graphCalendarScopes,
  buildMailAuthorizeUrl,
  buildCalendarAuthorizeUrl,
  OAUTH_OPENER_RELAY_PARAM,
  OAUTH_OPENER_RELAY_VALUE,
  OAUTH_OPENER_RELAY_STATE_PREFIX,
  OAUTH_OPENER_ORIGIN_PARAM,
  OAUTH_CLOUD_CALLBACK_ORIGIN,
  WEBCLIENT_OAUTH_CALLBACK_PATH,
  isLoopbackOrigin,
  alternateOAuthCallbackUrl,
  oauthCallbackUrlForPwa,
  pickOAuthCallbackHost,
  isOpenerRelayCallback,
  readOpenerRelayTarget,
  buildOpenerRelayRedirectUri,
  OPENER_RELAY_MESSAGE_KIND,
  OAUTH_APP_ISSUERS,
  oauthAppIssuerForProvider,
} from './foundational-oauth.js';
export type {
  MailOAuthProvider,
  CalendarOAuthAdapter,
  AuthorizeUrlParams,
  OpenerRelayMessage,
  OAuthAppIssuer,
  OAuthAppConfigStatus,
  OAuthAppConfigSnapshot,
  SetOAuthAppConfigArgs,
  ClearOAuthAppConfigArgs,
} from './foundational-oauth.js';

// D-148 substrate-wide constants.
export {
  CERT_ROTATION_NOTICE_LEAD_TIME_MS,
  CERT_ROTATION_OVERLAP_MS,
  CERT_RENEWAL_LEAD_TIME_MS,
  CERT_RENEWAL_USER_WARNING_LEAD_TIME_MS,
  DDNS_UPDATE_REPLAY_WINDOW_MS,
  DDNS_UPDATE_INTERVAL_MS,
  DDNS_POLL_INTERVAL_MS,
  HANDLE_GRACE_PERIOD_MS,
  HANDLE_SUBSCRIPTION_GRACE_DAYS,
  HANDLE_SUBSCRIPTION_GRACE_MS,
  HANDLE_OLD_REDIRECT_WINDOW_MS,
  HANDLE_CHANGE_REDIRECT_WINDOW_MS,
  WEBCLIENT_STATE_SNAPSHOT_TTL_MS,
  TLS_RENEWAL_IMMINENT_DAYS,
  TLS_RENEWAL_OVERDUE_DAYS,
  BRIDGE_KEEPALIVE_INTERVAL_MS,
  BRIDGE_ALARMS_PERIOD_MIN,
  WEBHOOK_BODY_MAX_BYTES,
  WEBHOOK_GLOBAL_RATE_LIMIT_RPS,
  WS_PER_TOKEN_RATE_LIMIT_RPS,
  MCP_PER_TOKEN_RATE_LIMIT_RPM,
} from './d148-constants.js';

// Rpc wire types — registry + typed conn shape (see ./rpc/).
export {
  RpcError,
  SERVER_RPC_METHODS,
  SERVER_RPC_METHOD_SET,
  createPendingMap,
  composeHandlers,
  handlerSlice,
  AUDIT_EXPORT_MAX_PAGE_SIZE,
  AUDIT_EXPORT_DEFAULT_PAGE_SIZE,
  AUDIT_EXPORT_BYTES_PER_ENTRY,
  presetToBounds,
  clampAuditExportPageSize,
  MEMORY_LIST_MAX_PAGE_SIZE,
  MEMORY_LIST_DEFAULT_PAGE_SIZE,
} from './rpc/index.js';
export type {
  RpcMethodSpec,
  RpcRegistry,
  RpcRequest,
  RpcResponse,
  Conn,
  NoArgMethods,
  RpcMiddleware,
  RpcCallOptions,
  ServerRpcRegistry,
  ServerAuthState,
  ServerAuthMigrationStatus,
  ServerSchedule,
  ServerMissedRunEntry,
  ServerMissedRunReport,
  RecipeRunFacts,
  ServerExecuteResponse,
  ServerMigrationResult,
  ServerRecipeListEntry,
  ServerPendingApproval,
  ServerApprovalResolveResult,
  ServerApprovalSubscriptionEvent,
  ServerConfigField,
  ServerConfigValue,
  ServerLlmPrompt,
  ServerLlmProbeDiagnosis,
  ServerLlmUsageResponse,
  ServerLlmUsageSource,
  ServerLlmProbeResult,
  ServerLlmPromptSurface,
  ServerLlmMessageRole,
  ServerLlmCallerSystemPolicy,
  ServerPairedDevice,
  ServerSystemStatus,
  ServerRecentExecution,
  ServerRecentNotification,
  ServerPendingAsk,
  ServerPendingAskDetail,
  SharedCompareAndSetResult,
  SharedListEntry,
  SharedReadResult,
  SharedSearchMatch,
  ServerBootstrapView,
  ServerBootstrapStageResult,
  ServerStatus,
  ServerPressureReclaimResult,
  TlsDomainUploadErrorDetails,
  RpcHandler,
  HandlerRegistry,
  CompleteHandlerRegistry,
  PendingEntry,
  PendingMap,
  HandlerSlice,
  AnyHandlerSlice,
  ComposedHandlers,
  AuditExportFormat,
  AuditExportPreset,
  AuditExportRequest,
  AuditExportEstimate,
  AuditExportEnvelope,
  AuditExportPage,
  AuditExportEntry,
  MemoryListRequest,
  MemoryListEntry,
  MemoryListResponse,
  MemoryGetRequest,
  MemoryGetResponse,
  MemoryCreateRequest,
  MemoryUpdateRequest,
  MemoryMutationResult,
  MemoryDeleteRequest,
  MemoryDeleteResult,
  MemoryImportEntry,
  MemoryImportRequest,
  MemoryImportResult,
} from './rpc/index.js';

// D-145 PA1 — canonical work entities (task / note / commitment / project)
// + Source primitive types + canonical schemas. Substrate-managed
// top_tier_kinds with uniform Source-row-identity columns per § A.1.6.
export {
  WORK_ENTITY_KINDS,
  WORK_ENTITY_KIND_SET,
  isWorkEntityKind,
  SYNC_STATES,
  SYNC_STATE_SET,
  CONFLICT_POLICIES,
  CONFLICT_POLICY_SET,
  TASK_PRIORITIES,
  TASK_PRIORITY_SET,
  TASK_TITLE_MAX,
  TASK_IDEMPOTENCY_KEY_MAX,
  TASK_IDEMPOTENCY_ID_PREFIX,
  isTaskIdempotencyKey,
  taskIdFromIdempotencyKey,
  TASK_STATE_MAX,
  NOTE_TITLE_MAX,
  NOTE_ACCESS_KINDS,
  NOTE_ACCESS_KIND_SET,
  COMMITMENT_DIRECTIONS,
  COMMITMENT_DIRECTION_SET,
  COMMITMENT_LIFECYCLE_STATES,
  COMMITMENT_LIFECYCLE_STATE_SET,
  COMMITMENT_DUE_STATUSES,
  COMMITMENT_DUE_STATUS_SET,
  COMMITMENT_EXPIRY_POLICIES,
  COMMITMENT_EXPIRY_POLICY_SET,
  COMMITMENT_DERIVATIONS,
  COMMITMENT_DERIVATION_SET,
  COMMITMENT_STATEMENT_MAX,
  COMMITMENT_CURRENCY_REGEX,
  COMMITMENT_AMOUNT_REGEX,
  PROJECT_STATES,
  PROJECT_STATE_SET,
  PROJECT_TITLE_MAX,
  PROJECT_HIERARCHY_MAX_DEPTH,
  // D-210 — booking: the canonical mutable business reservation, including
  // its own agreed slot and lifecycle.
  BOOKING_LIFECYCLE_STATES,
  BOOKING_LIFECYCLE_STATE_SET,
  BOOKING_DEFAULT_LIFECYCLE_STATE,
  BOOKING_TITLE_MAX,
  COMMITMENT_FULFILL_FROM_STATES,
  COMMITMENT_CANCEL_FROM_STATES,
  COMMITMENT_FULFILL_ALLOWED_EXPIRY_POLICIES,
  // D-145 PA4 — reactive trigger constants
  WORK_ENTITY_BUS_PLATFORM,
  WORK_ENTITY_BUS_ENTITY_TYPE,
  WORK_ENTITY_DERIVED_EVENT_KINDS,
  WORK_ENTITY_DUE_SOON_WINDOW_MS,
  composeWorkEntityBusPath,
  // D-192 F1 — commitment evidence (canonical entry + caps)
  COMMITMENT_EVIDENCE_KINDS,
  COMMITMENT_EVIDENCE_KIND_SET,
  COMMITMENT_EVIDENCE_DECLARABLE_KINDS,
  COMMITMENT_EVIDENCE_DECLARABLE_KIND_SET,
  COMMITMENT_EVIDENCE_RESERVED_KINDS,
  COMMITMENT_EVIDENCE_BLOB_MAX_BYTES,
  // D-192 email flagship — mail evidence entry (caps + source families)
  COMMITMENT_MAIL_EVIDENCE_SNIPPET_MAX,
  COMMITMENT_MAIL_EVIDENCE_SOURCES,
  COMMITMENT_MAIL_EVIDENCE_SOURCE_SET,
  // D-192 messenger flagship — message evidence entry (snippet cap)
  COMMITMENT_MESSAGE_EVIDENCE_SNIPPET_MAX,
} from './work-entities.js';
export type {
  WorkEntityKind,
  SyncState,
  ConflictPolicy,
  SourceRowIdentity,
  WorkEntityPendingWrite,
  Task,
  TaskPriority,
  Note,
  NoteAccessKind,
  NoteAccessLedgerEntry,
  Commitment,
  CommitmentDirection,
  CommitmentLifecycleState,
  CommitmentDueStatus,
  CommitmentExpiryPolicy,
  CommitmentDerivation,
  CommitmentEvidenceKind,
  CommitmentEvidenceDeclarableKind,
  CommitmentEvidenceEntry,
  CommitmentEvidenceBase,
  CommitmentCrmFieldEvidence,
  CommitmentMailEvidence,
  CommitmentMailEvidenceSource,
  CommitmentMessageEvidence,
  MonetaryValue,
  Project,
  ProjectState,
  Booking,
  BookingLifecycleState,
  BookingHistoryEntry,
  BookingHistorySummary,
  WorkEntity,
  SourceSelectInput,
  TaskCreateInput,
  TaskUpdateInput,
  TaskDeleteInput,
  TaskMarkDoneInput,
  NoteCreateInput,
  NoteUpdateInput,
  NoteDeleteInput,
  CommitmentCreateInput,
  CommitmentUpdateInput,
  CommitmentFulfillInput,
  CommitmentCancelInput,
  ProjectCreateInput,
  ProjectUpdateInput,
  ProjectArchiveInput,
  BookingCreateInput,
  BookingUpdateInput,
  TaskWriteOutput,
  NoteWriteOutput,
  CommitmentWriteOutput,
  ProjectWriteOutput,
  BookingWriteOutput,
  WorkEntityDeleteOutput,
  WorkEntityDerivedEventKind,
} from './work-entities.js';

// D-174 #22 — Data warehouse pair-RPC request/response shapes
// (work_entity.{list,get,upsert,delete}). The webclient Data route (D11)
// talks these over the pair-WS-rpc channel; mirrors the `contact.*`
// warehouse-CRUD family. `data.timeline` reuses TimelineRequest/Response.
export type {
  WorkEntityListRpcRequest,
  WorkEntityListRpcResponse,
  WorkEntityGetRpcRequest,
  WorkEntityGetRpcResponse,
  WorkEntityUpsertRpcRequest,
  WorkEntityUpsertRpcResponse,
  WorkEntityDeleteRpcRequest,
  WorkEntityDeleteRpcResponse,
} from './work-entity-rpc.js';

// D-174 Runs/Audit pair-RPC request/response shapes
// (`execution.list` + `execution.get`). The webclient Runs route reads
// these over the paired WS-rpc channel; the detail projection is redacted
// (no audit config snapshot / raw checkpoint state).
export type {
  PolicyResult,
  ExecutionListCursor,
  RunOrigin,
  RunProvenanceLink,
  RunFeedRow,
  ExecutionListQuery,
  ExecutionListResponse,
  ExecutionGetRequest,
  RunAuditSummary,
  RunYield,
  RunApprovalCheckpoint,
  RunApprovalOutcome,
  RunApprovalSummary,
  RunGatewayCallDecision,
  RunGatewayCallTraceEntry,
  RunGatewaySummary,
  RunDetail,
  ExecutionGetResponse,
} from './execution-rpc.js';

// D-237 P2 — the run-yield derivation. Value export (the type rides above).
// `runYieldIsTotalRefusal` is the shared reading of that yield: one definition
// for the owner-facing notice, the reactive predicate and the case compiler, so
// three surfaces cannot drift into three different ideas of "produced nothing".
export { deriveRunYield, runYieldIsTotalRefusal } from './execution-rpc.js';
export {
  runIsAuditExemptRender,
  NON_DISPATCHING_STEP_TYPES,
  AUDIT_EXEMPT_CHANNEL,
  type AuditExemptionInput,
} from './audit-exemption.js';

export {
  SOURCE_TOP_TIER_KINDS,
  SOURCE_TOP_TIER_KIND_SET,
  SOURCE_KINDS,
  SOURCE_KIND_SET,
  SOURCE_SYNC_POSTURES,
  SOURCE_SYNC_POSTURE_SET,
  RECUED_BUILTIN_SOURCE_ID,
  CONNECTION_SOURCE_ID,
  isSourceTopTierKind,
  isSourceKind,
  isSourceSyncPosture,
  isWorkEntitySourceKind,
} from './source-primitive.js';
export type { SourceRegistration, SourceTopTierKind, SourceKind, SourceSyncPosture } from './source-primitive.js';
export type { RemoteFailureKind } from './source-primitive.js';
// D-234 § 234.4 — the remote hold: asking a peer's OWNER a question.
export {
  PEER_ANSWER_REQUIRED_SIGNAL_NAME,
  PEER_ASK_BODY_MAX,
  PEER_ASK_LABEL_MAX,
  PEER_ASK_OPTION_ID_MAX,
  PEER_ASK_OPTION_LABEL_MAX,
  PEER_ASK_OPTIONS_MAX,
  PEER_ASK_QUESTION_MAX,
  PEER_ASK_SPEC_ERRORS,
  PEER_ASK_TIMEOUT_ACTIONS,
  PEER_ASK_UNANSWERED_REASONS,
  PEER_ASK_NOTE_PROMPTS,
  PEER_ASK_VIA,
  PeerAnswerRequiredSignal,
  isPeerAnswerRequiredSignal,
  isPeerAskTimeoutAction,
  isPeerAskUnansweredReason,
  isPeerAskNotePrompt,
  isPeerAskVia,
  normalizePeerAskVia,
  parsePeerAnswer,
  validatePeerAskSpec,
} from './peer-ask.js';
export type {
  PeerAnswer,
  PeerAskOption,
  PeerAskSpec,
  PeerAskSpecError,
  PeerAskTimeoutAction,
  PeerAskUnansweredReason,
  PeerAskNotePrompt,
  PeerAskVia,
} from './peer-ask.js';
export type {
  ExchangeDeliveryStatus, ExchangeStatusRow, ExchangeStatusReport,
} from './source-primitive.js';
export { deriveExchangeStatus, planExchangeRetry } from './source-primitive.js';
// D-234 § 234.2 — unsolicited faces the ceiling; solicited is admitted by our own
// record of having solicited it.
export { isSolicitedReply } from './source-primitive.js';
export type { ExchangeCorrelationRow } from './source-primitive.js';
export type { ExchangeRetryRow, ExchangeRetryPlan } from './source-primitive.js';
export {
  EXCHANGE_RETRY_MAX_ATTEMPTS, EXCHANGE_RETRY_BASE_MS,
} from './source-primitive.js';
export { EXCHANGE_ENVELOPE_KEYS, isExchangeEnvelopeKey } from './recipe.js';
export type { ConnectionDispatchOutcome } from './connection.js';
export { MCP_PEER_CONTRACT_CONFIG_KEY, diagnosePeerBinding } from './connection.js';
// D-234 § 234.1 — the receiver's ceiling. Local by construction (the sender's
// half, `callback_op`, is already on the wire), so it does not touch the held
// handshake.
export {
  MCP_PEER_ADMISSION_CONFIG_KEY,
  EXCHANGE_ADMISSION_WILDCARD,
  resolveExchangeAdmission,
  invalidExchangeAdmissionEntries,
  peerAdmissionIdentity,
} from './connection.js';
export type { ExchangeAdmission, PeerAdmissionDecision } from './connection.js';
export type { PeerBindingStatus, PeerBindingDiagnosis } from './connection.js';
export {
  foldConnectionDispatchHealth,
  effectiveConnectionHealth,
  CONNECTION_HEALTH_FRESH_MS,
} from './connection.js';
export {
  REMOTE_FAILURE_KINDS,
  isRemoteFailureKind,
  isRetryableRemoteFailure,
} from './source-primitive.js';
// D-232 § 30 — the exchange receipt, lifted out of the engine so storage (which
// cannot import the engine) and the server can both speak it. `@recued/engine`
// re-exports the type so existing imports keep resolving.
export type { ExchangeAcknowledgement } from './source-primitive.js';
export {
  parsePeerExchangeAck,
  EXCHANGE_PEER_REASON_MAX,
} from './source-primitive.js';

export {
  FILE_META_FILENAME_MAX,
  FILE_META_PATH_MAX,
  FILE_META_STRING_MAX,
  validateFileMetaProjection,
  isFileMetaProjection,
} from './file-meta.js';
export type { FileMetaProjection } from './file-meta.js';

export {
  FILE_LIST_MODES,
  FILE_LIST_MODE_SET,
  FILE_CURSOR_KINDS,
  FILE_CURSOR_KIND_SET,
  FILE_AUTH_KINDS,
  FILE_AUTH_KIND_SET,
  FILE_VENDOR_DECLARATIONS,
  assertFileVendorDeclarationShape,
  assertFileVendorDeclarationValid,
  buildFileVendorDeclaration,
  assertFileVendorRegistry,
  getFileVendorDeclaration,
  listFileVendors,
  isDeclaredFileVendor,
} from './file-vendors.js';
export type {
  FileListMode,
  FileCursorKind,
  FileAuthKind,
  FileList,
  FileProjection,
  FileScope,
  FileVendorDeclaration,
} from './file-vendors.js';

// D-192 C-2 slice 5 — the contact SOURCE family's declaration registry (the
// `file-vendors.ts` sibling). Carries the FACTS the shared contact sync dispatches
// on — the C-2a trust rung, the miss policy, the join key, and `supplies` (what a
// vendor can actually contribute; a PROMISE slice 6 verifies). Deliberately NOT a
// field map derived from `CONNECTION_VENDOR_ENTITIES.meta_fields` — see the module
// header for why that derive fails silently on 4 of 8 canonical fields.
export {
  CONTACT_IMPORT_SCOPES,
  CONTACT_IMPORT_SCOPE_SET,
  CONTACT_IMPORT_RUNGS,
  CONTACT_IMPORT_RUNG_SET,
  CONTACT_MATCH_KEY_KINDS,
  CONTACT_MATCH_KEY_KIND_SET,
  CONTACT_SOURCE_DECLARATIONS,
  assertContactSourceDeclarationShape,
  assertContactSourceDeclarationValid,
  assertContactSourceVendorBinding,
  buildContactSourceDeclaration,
  assertContactSourceRegistry,
  assertContactSourceRegistryBinding,
  getContactSourceDeclaration,
  listContactSourceVendors,
  isDeclaredContactSourceVendor,
} from './contact-sources.js';
export type {
  ContactImportScope,
  ContactImportRung,
  ContactMatchKeyKind,
  ContactSupplies,
  ContactSourceDeclaration,
  // D-205 #2c — per-Source health, as `contact.source.list` returns it. The cycle
  // counts live in contracts (not the store) because they now cross the wire.
  ContactSourceCycleCounts,
  ContactSourceHealth,
  ContactImportCandidate,
  ContactImportFileChange,
  ContactImportFilePlan,
} from './contact-sources.js';

// D-192 slice 6 — the `import_scope` escape hatch (Fork A): a user-declared
// path glob/prefix that scopes a file mirror to a subtree. Pure derive/compile
// helpers; the per-vendor prefix pushdown lives in the backend adapter leaf.
export {
  IMPORT_SCOPE_GLOB_MAX,
  normalizeScopePath,
  deriveScopePrefix,
  buildImportScope,
  parseImportScopeConfig,
  compileImportScope,
} from './import-scope.js';
export type { ImportScope, CompiledImportScope } from './import-scope.js';

// D-192 P1 — declared work-entity Source sync contract (declaration +
// fail-closed validation only; no runtime Source registration yet).
export {
  WORK_ENTITY_SOURCE_DECLARABLE_KINDS,
  WORK_ENTITY_SOURCE_DECLARABLE_KIND_SET,
  WORK_ENTITY_SOURCE_LANDING_CONTRACTS,
  getWorkEntitySourceLandingContract,
  isWorkEntitySourceDeclarableKind,
  WORK_ENTITY_CONTRACT_SOURCE_KINDS,
  WORK_ENTITY_CONTRACT_SOURCE_SURFACES,
  WORK_ENTITY_CONTRACT_SOURCE_TRANSPORT,
  WORK_ENTITY_SYNC_MODES,
  WORK_ENTITY_SOURCE_POSTURES,
  WORK_ENTITY_SYNC_DEPTHS,
  WORK_ENTITY_TOMBSTONE_KINDS,
  WORK_ENTITY_LIST_ROW_KINDS,
  WORK_ENTITY_LIST_HYDRATION_MAX_ROWS_PER_CYCLE,
  WORK_ENTITY_LIST_SCOPES,
  WORK_ENTITY_VERSION_KINDS,
  WORK_ENTITY_CURSOR_KINDS,
  WORK_ENTITY_CONDITIONAL_WRITE_KINDS,
  WORK_ENTITY_CONFLICT_RESOLUTIONS,
  WORK_ENTITY_PAIRING_MODES,
  WORK_ENTITY_LOOKUP_KEYS,
  WORK_ENTITY_RELATIONSHIP_TARGETS,
  WORK_ENTITY_RELATIONSHIP_TARGET_SET,
  WORK_ENTITY_REMOTE_WHEN_REASONS,
  WORK_ENTITY_REMOTE_WHEN_REASON_SET,
  WORK_ENTITY_OP_SLOTS,
  WORK_ENTITY_WRITE_OP_SLOTS,
  WORK_ENTITY_SOURCE_CANONICAL_FIELDS,
  WORK_ENTITY_SOURCE_REQUIRED_CANONICAL,
  WORK_ENTITY_SOURCE_DERIVABLE_CANONICAL,
  WORK_ENTITY_SOURCE_COALESCABLE_CANONICAL,
  WORK_ENTITY_SOURCE_TRANSFORMABLE_CANONICAL,
  WORK_ENTITY_CANONICAL_DERIVE_KINDS,
  WORK_ENTITY_CANONICAL_TRANSFORM_FNS,
  WORK_ENTITY_SOURCE_RELATIONSHIP_LOCAL_FIELDS,
  WORK_ENTITY_PREVIEW_DEFAULT_MAX_CHARS,
  WORK_ENTITY_PREVIEW_HARD_MAX_CHARS,
  WORK_ENTITY_EXTENSION_BLOB_MAX_BYTES,
  WORK_ENTITY_EXTENSION_SCALAR_MAX_CHARS,
  WORK_ENTITY_EXTENSION_ARRAY_MAX_ITEMS,
  WORK_ENTITY_EXTENSION_MAX_DEPTH,
  WORK_ENTITY_EXTENSION_MAX_ENTRIES,
  WORK_ENTITY_SOURCE_FRESHNESS_STATES,
  WORK_ENTITY_TARGETED_OP_SLOTS,
  WORK_ENTITY_DATE_CANONICAL_FIELDS,
  WORK_ENTITY_WRITE_TRANSFORM_KINDS,
  WORK_ENTITY_WRITE_DATE_FORMATS,
  WORK_ENTITY_DEPENDENCY_RESOLVE_MODES,
} from './work-entity-sources.js';
export type {
  WorkEntitySourceDeclarableKind,
  WorkEntitySourceLandingContract,
  WorkEntityContractSourceKind,
  WorkEntitySyncMode,
  WorkEntitySourcePosture,
  WorkEntitySyncDepth,
  WorkEntityTombstoneKind,
  WorkEntityListRowKind,
  WorkEntityListScope,
  WorkEntityVersionKind,
  WorkEntityCursorKind,
  WorkEntityConditionalWriteKind,
  WorkEntityConflictResolution,
  WorkEntityPairingMode,
  WorkEntityLookupKey,
  WorkEntityRelationshipTarget,
  WorkEntityRemoteWhenReason,
  WorkEntityOpSlot,
  WorkEntitySourceContractSource,
  WorkEntitySourceRemoteVersion,
  WorkEntitySourceRemote,
  WorkEntitySourceOps,
  WorkEntityTargetedOpSlot,
  WorkEntitySourceOpBinding,
  WorkEntitySourceOpBindings,
  WorkEntitySourceCursor,
  WorkEntitySourceSync,
  WorkEntitySourceWildQueryPolicy,
  WorkEntitySourceReadResolution,
  WorkEntitySourceFreshnessState,
  WorkEntitySourceFreshness,
  WorkEntitySourcePreviewField,
  WorkEntityCanonicalDeriveKind,
  WorkEntityCanonicalTransformFn,
  WorkEntityCanonicalDerivation,
  WorkEntityCanonicalNumberEquals,
  WorkEntityCanonicalTransformDerivation,
  WorkEntitySourceProjection,
  WorkEntitySourceRelationship,
  WorkEntitySourceWritePolicy,
  WorkEntityWriteTransformKind,
  WorkEntityWriteDateFormat,
  WorkEntityWriteVocabTransform,
  WorkEntityWriteDateFormatTransform,
  WorkEntityWriteTransform,
  WorkEntityConfigArgBinding,
  WorkEntityCreateArgBinding,
  WorkEntitySourceDependency,
  WorkEntitySourceDependencyBind,
  WorkEntitySourceDependencyArgFrom,
  WorkEntityDependencyResolveMode,
  WorkEntitySourceDeclaration,
} from './work-entity-sources.js';

// Tool-boundary work-entity identity. Generic reads emit a versioned qualified
// id; generic writes resolve it through the mirror, while a provider operation
// validates its exact Source/connection before unwrapping the native id.
export {
  QUALIFIED_WORK_ENTITY_ID_VERSION,
  QUALIFIED_WORK_ENTITY_ID_PREFIX,
  QualifiedWorkEntityIdError,
  qualifyWorkEntityId,
  parseQualifiedWorkEntityId,
  routeQualifiedWorkEntityOperationArgs,
} from './work-entity-qualified-id.js';
export type {
  QualifiedWorkEntityIdentityKind,
  QualifiedWorkEntityId,
  QualifiedWorkEntityIdErrorCode,
  QualifiedWorkEntityOperationRouting,
} from './work-entity-qualified-id.js';

// D-192 Slice 7 — the transitive container-read admission, shared by the gate
// (`deriveAllowedOperations`) and the consent-disclosure UIs so they can't drift.
export {
  deriveDependencyReadAdmissions,
  derivePerOpDependencyReads,
} from './work-entity-dependency-admission.js';
export type {
  DependencyReadAdmission,
  DeriveDependencyReadAdmissionsInput,
} from './work-entity-dependency-admission.js';

// D-192 F1 — commitment-evidence declarations (a catalog manifest's
// `commitment_evidence` array). NOT a Source — one qualifying signal =
// one immutable evidence snapshot + one HELD commitment-create
// proposal; approval mints. Canonical evidence ENTRY shapes live with
// the Commitment row contract in work-entities.js (exported above).
export {
  COMMITMENT_EVIDENCE_CAPTURE_EVENTS,
  COMMITMENT_EVIDENCE_CAPTURE_EVENT_SET,
  COMMITMENT_EVIDENCE_COUNTERPARTY_RESOLVERS,
  COMMITMENT_EVIDENCE_DECLARABLE_COUNTERPARTY_RESOLVERS,
  COMMITMENT_EVIDENCE_DECLARABLE_COUNTERPARTY_RESOLVER_SET,
  COMMITMENT_EVIDENCE_STATEMENT_TEMPLATE_MAX_CHARS,
  COMMITMENT_EVIDENCE_TEMPLATE_PLACEHOLDER,
} from './commitment-evidence.js';
export type {
  CommitmentEvidenceCaptureEvent,
  CommitmentEvidenceCounterpartyResolver,
  CommitmentEvidenceCrmFieldSource,
  CommitmentEvidenceDeclaration,
} from './commitment-evidence.js';

// D-192 P5 — work-graph relationship edges (`work_entity_edge`): the
// scoped relationship substrate over the closed target set. Fresh thin
// table (i-vs-ii fork resolved — never an overload of the D-119 `link`
// store); contact targets keyed on stable `contact_id`.
export {
  workEntityContactEdgeKey,
  workEntityCrmEdgeKey,
  workEntityWorkEdgeKey,
  workEntityLocalEdgeKey,
  workEntityRefEdgeKey,
  WORK_ENTITY_EDGE_RERESOLVE_BATCH,
} from './work-entity-edges.js';
export type {
  WorkEntityEdge,
  WorkEntityEdgeWrite,
  WorkEntityEdgeView,
} from './work-entity-edges.js';

export {
  CANONICAL_SCHEMAS,
  getCanonicalSchema,
  TASK_SCHEMA,
  NOTE_SCHEMA,
  COMMITMENT_SCHEMA,
  PROJECT_SCHEMA,
  MAIL_MESSAGE_SCHEMA,
} from './canonical-schemas/index.js';
export type {
  CanonicalSchema,
  CanonicalField,
  CanonicalFieldType,
  CanonicalRelationship,
  CanonicalRelationshipCardinality,
  CanonicalIndex,
} from './canonical-schemas/index.js';

// D-145 PA7 — mail-compose substrate (types, state machine,
// reply-context derivation, dispatch payload).
export type {
  MailComposeMode,
  MailComposeValues,
  MailComposeDialogState,
  MailComposeState,
  MailReplyContext,
  MailSenderSourceOption,
  MailComposeAiAction,
  MailComposeRewriteAction,
  MailComposeAttachment,
  ComposeDispatchMode,
  ComposeDispatchResult,
  ComposeMailSendPayload,
  NormalizedMailSend,
  ComposeDispatchHooks,
  ComposeRewriteRecipeInput,
} from './mail-compose/index.js';
export {
  MAIL_COMPOSE_MODES,
  normalizeMailSend,
  EMPTY_MAIL_COMPOSE_VALUES,
  MAIL_COMPOSE_AI_ACTIONS,
  MAIL_COMPOSE_REWRITE_ACTIONS,
  MAIL_COMPOSE_MAX_ATTACHMENTS,
  initialMailComposeState,
  openCreateComposeTransition,
  openReplyComposeTransition,
  setComposeValuesTransition,
  addComposeAttachmentsTransition,
  removeComposeAttachmentTransition,
  setComposeErrorsTransition,
  setComposeSubmittingTransition,
  setComposeSubmitErrorTransition,
  closeComposeTransition,
  forceCloseComposeTransition,
  composeDialog,
  addReReplyPrefix,
  deriveReplyValues,
  composeStateToSendPayload,
  composePayloadToSendRecipeConfig,
  SAVE_COMPOSED_DRAFT_TO_MAILBOX_RECIPE_ID,
  SEND_COMPOSED_MAIL_RECIPE_ID,
  composeRewriteRecipeConfig,
  REWRITE_COMPOSED_MAIL_RECIPE_ID,
} from './mail-compose/index.js';

// D-145 PA5 — form renderer substrate (types, generators, validators).
// Slice 2a (D-145 § B.11.7 follow-on) widens the typed-input registry
// with two composition primitives (`object` + `discriminated_union`),
// adds the matching nested-content array slots, and ships `show_if`
// for declarative conditional visibility — the surfaces below pick
// up the new exports.
export {
  FORM_FIELD_TYPES,
  isFormFieldType,
  fieldTypesInRegistry,
  formFromCanonicalSchema,
  formFromCanonicalSchemaWithExtension,
  humanizeName,
  BUILTIN_VALIDATORS,
  evaluateShowIf,
  resolveDiscriminatedVariant,
  validateField,
  validateForm,
} from './form-renderer/index.js';
export type {
  DiscriminatedUnionVariant,
  FieldValidationError,
  FieldValidator,
  FormCompositionFieldType,
  FormDefinition,
  FormField,
  FormFieldOrigin,
  FormFieldType,
  ShowIfCondition,
  SourceExtensionField,
  SourceExtensionSchema,
  ValidationHooks,
} from './form-renderer/index.js';

// D-145 PA6 — work-entity page substrate (per-kind nav + Source dropdown
// + list/search filter + create/edit dialog state machine).
export {
  COMMITMENT_LIFECYCLE_LIST_ORDER,
  PROJECT_STATE_LIST_ORDER,
  SOURCE_DROPDOWN_ALL_LABEL,
  SOURCE_DROPDOWN_ALL_VALUE,
  WORK_ENTITY_NAV,
  WORK_ENTITY_NAV_ORDER,
  applySearchTransition,
  buildSourceDropdownOptions,
  closeDialogTransition,
  dropdownIdToSelectedSourceId,
  entityToFormValues,
  filterAndSortEntities,
  filterEntitiesBySearch,
  initialWorkEntityPageState,
  openCreateDialogTransition,
  openEditDialogTransition,
  resolveCreateDialogSourceId,
  selectKindTransition,
  selectSourceTransition,
  selectedSourceIdToDropdownId,
  setDialogErrorsTransition,
  setDialogSourceTransition,
  setDialogSubmitErrorTransition,
  setDialogSubmittingTransition,
  setDialogValuesTransition,
  sortEntitiesByDefault,
  workEntityNavSpec,
  workEntityNavSpecsInOrder,
} from './work-entity-page/index.js';
export type {
  SourceDropdownOption,
  WorkEntityIconName,
  WorkEntityListRow,
  WorkEntityListSortDirection,
  WorkEntityListSortSpec,
  WorkEntityListViewProps,
  WorkEntityNavSpec,
  WorkEntityPageDialogState,
  WorkEntityPageDialogStateCreate,
  WorkEntityPageDialogStateEdit,
  WorkEntityPageState,
  WorkEntityPageStateInit,
} from './work-entity-page/index.js';

// D-145 PA9 — Enrichment evidence contract (16-field declaration shape).
// D-145 § A.7.8 (Amended 2026-05-26) — optional 17th `tunable_params`
// field surfaced via EnrichmentTunableParamSpec + EnrichmentTunableParamUnit.
export type {
  EnrichmentDeclaration,
  DeclarationTemporalClass,
  DeclarationIdentityAggregation,
  ConfidenceKind,
  CoveragePosture,
  PrivacyClass,
  DeclarationWindow,
  DeclarationWindowKind,
  DeclarationProducerKind,
  D145ProducerTopic,
  D145WorkEntityProducerTopic,
  D145EngineReliabilityProducerTopic,
  EnrichmentTunableParamSpec,
  EnrichmentTunableParamUnit,
  EnrichmentTunableParamValue,
} from './enrichment-declaration.js';
export {
  DECLARATION_TEMPORAL_CLASSES,
  DECLARATION_TEMPORAL_CLASS_SET,
  isDeclarationTemporalClass,
  DECLARATION_IDENTITY_AGGREGATIONS,
  DECLARATION_IDENTITY_AGGREGATION_SET,
  isDeclarationIdentityAggregation,
  CONFIDENCE_KINDS,
  CONFIDENCE_KIND_SET,
  isConfidenceKind,
  COVERAGE_POSTURES,
  COVERAGE_POSTURE_SET,
  isCoveragePosture,
  PRIVACY_CLASSES,
  PRIVACY_CLASS_SET,
  isPrivacyClass,
  DECLARATION_WINDOW_KINDS,
  DECLARATION_WINDOW_KIND_SET,
  isDeclarationWindowKind,
  DECLARATION_PRODUCER_KINDS,
  DECLARATION_PRODUCER_KIND_SET,
  isDeclarationProducerKind,
  PSI_SAMPLE_FLOOR_MINIMUM,
  PSI_ELIGIBLE_TEMPORAL_CLASSES,
  D145_WORK_ENTITY_PRODUCER_TOPICS,
  D145_ENGINE_RELIABILITY_PRODUCER_TOPICS,
  D145_PRODUCER_TOPICS,
  D145_PRODUCER_TOPIC_SET,
  isD145ProducerTopic,
  D145_PSI_ELIGIBLE_PRODUCER_TOPICS,
  D145_PSI_ELIGIBLE_PRODUCER_TOPIC_SET,
  isD145PsiEligibleProducerTopic,
  validateEnrichmentDeclaration,
  assertEnrichmentDeclaration,
  EnrichmentDeclarationError,
  ENRICHMENT_TUNABLE_PARAM_UNITS,
  ENRICHMENT_TUNABLE_PARAM_UNIT_SET,
  isEnrichmentTunableParamUnit,
  ENRICHMENT_TUNABLE_PARAM_KEY_RE,
} from './enrichment-declaration.js';
export {
  D145_PRODUCER_DECLARATIONS,
  validateD145ProducerDeclarations,
  assertD145ProducerDeclarations,
  COMMITMENT_FOLLOWTHROUGH_SCORE_DECLARATION,
  COMMITMENT_IMBALANCE_DECLARATION,
  OUTBOUND_COMMITMENT_OVERDUE_COUNT_DECLARATION,
  TASK_COMPLETION_VELOCITY_DECLARATION,
  TASK_SIGNAL_DENSITY_PER_THREAD_DECLARATION,
  PROJECT_STALL_SIGNAL_DECLARATION,
  PROJECT_VELOCITY_DECLARATION,
  NOTE_RELEVANCE_DECAY_DECLARATION,
  OPEN_LOOP_PRESSURE_DECLARATION,
  COMMITMENT_RELIABILITY_BAND_DECLARATION,
  PREFERRED_CHANNEL_BY_CONTACT_DECLARATION,
  PROJECT_NEXT_ACTION_GAP_DECLARATION,
  TASK_DUPLICATE_CANDIDATE_DECLARATION,
  SOURCE_FRESHNESS_DEGRADATION_DECLARATION,
} from './enrichment-declarations/index.js';

// D-145 PA9 — Per-producer value-shape exports.
export type {
  PsiEligibleScoreValue,
  CommitmentImbalanceValue,
  CommitmentImbalanceSignal,
  OutboundCommitmentOverdueCountValue,
  TaskSignalDensityValue,
  ProjectStallSignalValue,
  NoteRelevanceDecayValue,
  OpenLoopPressureValue,
  CommitmentReliabilityBand,
  CommitmentReliabilityBandValue,
  PreferredChannel,
  PreferredChannelByContactValue,
  ProjectNextActionGapValue,
  TaskDedupeConfidence,
  TaskDuplicateCandidateValue,
  SourceFreshnessDegradationValue,
} from './enrichment-registry.js';
export {
  COMMITMENT_IMBALANCE_SIGNALS,
  COMMITMENT_RELIABILITY_BANDS,
  PREFERRED_CHANNELS,
  TASK_DEDUPE_CONFIDENCES,
} from './enrichment-registry.js';

// D-145 PB1 — capacity_spec substrate (contracts).
export {
  CAPACITY_KINDS,
  CAPACITY_KIND_SET,
  POOL_KINDS,
  POOL_KIND_SET,
  CAPACITY_REMEDIATION_ACTIONS,
  CAPACITY_REMEDIATION_ACTION_SET,
  CAPACITY_PROBE_FAILURE_DETAILS,
  CAPACITY_PROBE_FAILURE_DETAIL_SET,
  CAPACITY_INVALIDATION_TOPICS,
  CAPACITY_INVALIDATION_TOPIC_SET,
  CAPACITY_CACHE_POLICIES,
  CACHEABLE_CAPACITY_KINDS,
  CAPACITY_SPEC_VALIDATION_ISSUE_KINDS,
  IDENTITY_BEARING_FIELDS,
  capacityKey,
  capacityKeyForAudit,
  capacityParamsForAudit,
  validateCapacitySpec,
  assertValidCapacitySpec,
  resolveRemediationEntry,
  isCapacityProbeFailure,
  CapacitySpecValidationError,
} from './capacity-spec.js';
export type {
  CapacityKind,
  PoolKind,
  CapacityRequirement,
  CapacityRemediation,
  CapacityRemediationAction,
  CapacityRemediationVisibility,
  CapacitySpec,
  CapacityCheck,
  CapacityWalkCorrelation,
  CapacityCheckResult,
  CapacityProbeFailure,
  CapacityProbeFailureDetail,
  CapacityProbeResult,
  CapacityAuditParams,
  CapacityCachePolicy,
  CapacityInvalidationTopic,
  CapacityInvalidationPayload,
  CapacityInvalidationSubscription,
  CapacityInvalidationSource,
  CapacitySpecValidationIssueKind,
  CapacitySpecValidationIssue,
} from './capacity-spec.js';

export {
  CAPACITY_AUDIT_OK_ACTION,
  CAPACITY_AUDIT_GAP_ACTION,
  CAPACITY_AUDIT_ACTIONS,
  CAPACITY_TRANSPARENCY_GAP_EVENT_KIND,
} from './capacity-spec-events.js';
export type {
  CapacityAuditAction,
  CapacityFailureKind,
  CapacityCheckAuditDetail,
  CapacityTransparencyEventKind,
  CapacityCheckGapTransparencyEvent,
} from './capacity-spec-events.js';

// ── D-145 PB2 — RecuedPlan IR ───────────────────────────────────────

export {
  RECUED_PRIMITIVES,
  RECUED_PRIMITIVE_SET,
  PRIMITIVE_CALL_STATUSES,
  PRIMITIVE_CALL_STATUS_SET,
  OMISSION_REASON_CODES,
  OMISSION_REASON_CODE_SET,
  CONTEXT_CONTENT_CLASSES,
  CONTEXT_CONTENT_CLASS_SET,
  CONTEXT_PERSIST_POLICIES,
  CONTEXT_PERSIST_POLICY_SET,
  CONTEXT_CLASS_PERSIST_POLICIES,
  PLAN_STATUSES,
  PLAN_STATUS_SET,
  FAILURE_CLASSES,
  FAILURE_CLASS_SET,
  NARROWING_REASON_CODES,
  NARROWING_REASON_CODE_SET,
  CLASSIFICATION_INTENT_KINDS,
  CLASSIFICATION_INTENT_KIND_SET,
  CONTEXT_BREADTHS,
  MODEL_TIERS,
  MODEL_TIER_SET,
  RECUED_PLAN_MEMORY_KIND,
  REDACTED_USER_REQUEST_MARKER,
  RECUED_PLAN_VALIDATION_ISSUE_KINDS,
  RecuedPlanValidationError,
  validateRecuedPlan,
  assertValidRecuedPlan,
  appendPrimitiveCall,
  appendOmittedItem,
  appendIncludedContext,
  appendTransparencyEvent,
  appendExtractionEvent,
  appendProvenanceLink,
  appendCapacityCheck,
  redactUserRequest,
  stripPlanSignatureFields,
} from './recued-plan.js';
export type {
  RecuedPrimitive,
  PrimitiveCallStatus,
  PrimitiveCall,
  ContentStoredFalse,
  OmissionReasonCode,
  OmittedItem,
  ContextContentClass,
  ContextPersistPolicy,
  ContextItem,
  PlanStatus,
  FailureClass,
  NarrowingReasonCode,
  ClassificationIntentKind,
  ContextBreadth,
  ContextSelectionTrace,
  ContextSelectionToolsTrace,
  ProvenanceLink,
  AuditPolicy,
  ModelTier,
  RecuedPlan,
  RecuedPlanValidationIssueKind,
  RecuedPlanValidationIssue,
} from './recued-plan.js';

// D-150 — dependency-free internal benchmarks extraction support facade.
// Namespaced to avoid shadowing the canonical RecuedPlan/contact exports
// above while giving extraction tooling one explicit allowlist target.
export * as D150BenchSupport from './d-150-bench-support.js';

// ── D-145 PB3 — RecuedRequest entry-point shape ─────────────────────

export {
  RECUED_REQUEST_SURFACES,
  RECUED_REQUEST_SURFACE_SET,
  RECUED_REQUEST_VALIDATION_ISSUE_KINDS,
  RecuedRequestValidationError,
  validateRecuedRequest,
  assertValidRecuedRequest,
} from './recued-request.js';
export type {
  RecuedRequestSurface,
  ClassificationIntent,
  RecuedRequest,
  RecuedRequestValidationIssueKind,
  RecuedRequestValidationIssue,
} from './recued-request.js';

// ── D-145 PB4 — tier strategy substrate ─────────────────────────────

export {
  TIER_RANK,
  TIER_BY_RANK,
  TIER_PACKET_BUDGETS,
  TIER_LATENCY_CEILINGS,
  TIER_ESTIMATED_COST_CENTS,
  highestTier,
  lowestTier,
  tierAtLeast,
  nextLowerTier,
  clampToBounds,
  downgradeIfOverBudget,
  assertTierStrategyInvariants,
} from './tier-strategy.js';
export type {
  TierPacketBudget,
  TierLatencyCeiling,
  SiTierBounds,
  TierBudget,
  SelectSynthesisTierResult,
  DowngradeResult,
} from './tier-strategy.js';

// ── D-145 PB5 — AI-cooperative substrate ────────────────────────────

export {
  FIXED_SLOT_INVARIANT_VIOLATION_KINDS,
  FIXED_SLOT_INVARIANT_VIOLATION_KIND_SET,
  MULTI_TURN_EVENT_KINDS,
  MULTI_TURN_EVENT_KIND_SET,
  MULTI_TURN_TERMINATION_REASONS,
  MULTI_TURN_TERMINATION_REASON_SET,
  AI_COOPERATIVE_VALIDATOR_ISSUE_KINDS,
  AI_COOPERATIVE_VALIDATOR_ISSUE_KIND_SET,
  AI_COOPERATIVE_OPT_OUT_RATIONALE_MIN_CHARS,
  assertAiCooperativeInvariants,
} from './ai-cooperative.js';
export type {
  ActionRequest,
  ActionResult,
  FixedSlotInvariantViolationKind,
  FixedSlotInvariantViolation,
  MultiTurnEventKind,
  MultiTurnTerminationReason,
  ProcessedActionResult,
  AiCooperativeManifestDeclaration,
  AiCooperativeValidatorIssueKind,
} from './ai-cooperative.js';

// ── D-145 PB6 — closed extraction-event taxonomy + AIOutput ─────────

export {
  EXTRACTION_EVENT_KINDS,
  EXTRACTION_EVENT_KIND_SET,
  EXTRACTION_EVENT_CLASSES,
  EXTRACTION_EVENT_CLASS_SET,
  EXTRACTION_EVENT_CLASS_PRIORITY,
  EVENT_DISPATCH_KINDS,
  EVENT_DISPATCH_KIND_SET,
  EXTRACTION_EVENT_VALIDATION_KINDS,
  EXTRACTION_EVENT_VALIDATION_KIND_SET,
  HIGH_CONFIDENCE_FLOOR,
  MEDIUM_CONFIDENCE_FLOOR,
  MULTI_EVENT_COLLAPSE_THRESHOLD,
  isExtractionEventKind,
  classForExtractionEventKind,
  dispatchKindForConfidence,
  validateExtractionEvent,
  assertExtractionEventInvariants,
} from './extraction-events.js';
export type {
  ExtractionEvent,
  ExtractionEventKind,
  ExtractionEventClass,
  EventDispatchKind,
  ExtractionEventValidationKind,
  ExtractionEventValidationIssue,
} from './extraction-events.js';

export {
  AI_OUTPUT_VALIDATION_KINDS,
  AI_OUTPUT_VALIDATION_KIND_SET,
  validateAIOutput,
  coerceAIOutput,
  assertAIOutputInvariants,
} from './ai-output.js';
export type {
  ToolCall,
  AIOutput,
  AIOutputValidationKind,
  AIOutputValidationIssue,
} from './ai-output.js';

// ── D-145 PB7 — Transparency Stream substrate (UNIFIED) ─────────────

export {
  TRANSPARENCY_EVENT_KINDS,
  TRANSPARENCY_EVENT_KIND_SET,
  TRANSPARENCY_EVENT_CLASSES,
  TRANSPARENCY_EVENT_CLASS_SET,
  TRANSPARENCY_EVENT_CLASS_FOR_KIND,
  TRANSPARENCY_EVENT_VALIDATION_KINDS,
  TRANSPARENCY_EVENT_VALIDATION_KIND_SET,
  TRANSPARENCY_DRIFT_SEVERITIES,
  TRANSPARENCY_BRIDGE_STATUSES,
  TRANSPARENCY_PRIVACY_VIOLATION_CLASSES,
  TRANSPARENCY_COST_HALT_REASONS,
  TRANSPARENCY_DECODER_UNAVAILABLE_REASONS,
  TRANSPARENCY_DECODER_UNAVAILABLE_SITES,
  TRANSPARENCY_MULTI_TURN_ROUND_OUTCOMES,
  TRANSPARENCY_MULTI_TURN_TERMINATION_REASONS,
  TRANSPARENCY_FIXED_SLOT_VIOLATION_KINDS,
  TRANSPARENCY_STANDING_INSTRUCTION_CONFLICT_KINDS,
  TRANSPARENCY_REDACTION_TIERS,
  TRANSPARENCY_REDACTION_TIER_SET,
  TRANSPARENCY_REDACTION_TIER_PRIORITY,
  TRANSPARENCY_DEFAULT_REDACTION_FOR_KIND,
  TRANSPARENCY_TEMPLATES_EN,
  TRANSPARENCY_AUDIT_SOURCES,
  TRANSPARENCY_AUDIT_SOURCE_SET,
  TRANSPARENCY_STREAM_AUDIT_ACTION,
  DEFAULT_TRANSPARENCY_STREAM_SETTINGS,
  isTransparencyEventKind,
  classForTransparencyEventKind,
  validateTransparencyEvent,
  assertTransparencyEventInvariants,
  defaultRedactionForKind,
  assertTransparencyRedactionInvariants,
  renderTransparencyTemplate,
  assertTransparencyTemplatesComplete,
  applyVisibilityPolicy,
  transparencyStreamSettingsFromPrefs,
  withVisibleClasses,
  withEnabled,
  withMaxRedactionTier,
  withHiddenNetworkDomain,
  assertTransparencySettingsInvariants,
  buildTransparencyAuditDetail,
  assertTransparencyAuditInvariants,
} from './transparency-stream/index.js';
export type {
  TransparencyEvent,
  TransparencyEventKind,
  TransparencyEventClass,
  TransparencyEventValidationKind,
  TransparencyEventValidationIssue,
  TransparencyDriftSeverity,
  TransparencyBridgeStatus,
  TransparencyPrivacyViolationClass,
  TransparencyCostHaltReason,
  TransparencyDecoderUnavailableReason,
  TransparencyDecoderUnavailableSite,
  TransparencyMultiTurnRoundOutcome,
  TransparencyMultiTurnTerminationReason,
  TransparencyFixedSlotViolationKind,
  TransparencyStandingInstructionConflictKind,
  TransparencyRedactionTier,
  TransparencyEventEnvelope,
  TransparencyStreamSettings,
  TransparencyClassVisibility,
  TransparencyMaxRedactionTier,
  TransparencyAuditDetail,
  TransparencyAuditSource,
  TransparencyStreamAuditAction,
} from './transparency-stream/index.js';

// ── D-163 Slice C — Notifications rpc payload types ─────────────────

export {
  NOTIFICATION_VERIFICATION_PHRASE_MAX_LENGTH,
  NOTIFICATION_CHANNEL_NAMES,
  NOTIFICATION_DELIVERY_CHANNELS,
  NOTIFICATION_CREDENTIAL_CHANNELS,
  // D-192 — the THREE axes (notify / approve / converse), declared per channel.
  // Chat transports derive theirs from the messenger registry; ui/bridge/email are
  // literal. Replaces the hand-spelled `if (channel === 'bridge') return false` that
  // used to live inside the shared gates.
  CHANNEL_ROLES,
  CHANNEL_ROLE_AXES,
} from './notifications.js';
export type {
  NotificationBridgeModeRow,
  NotificationBridgeRow,
  NotificationChannelCapability,
  NotificationChannelModeRow,
  ChannelRoles,
  NotificationChannelName,
  NotificationChannelToggleView,
  NotificationCredentialChannel,
  NotificationDeliveryChannel,
  NotificationRemoteChannelName,
  NotificationSetBridgeModeResult,
  NotificationSetChannelResult,
  NotificationSetVerificationPhraseResult,
  NotificationSettingsRow,
} from './notifications.js';

// ── D-145 PB11 — Person-Specific Automation primitive ───────────────

export {
  PERSONAL_RECIPE_VALIDATION_ISSUE_KINDS,
  PERSONAL_RECIPE_VALIDATION_ISSUE_KIND_SET,
  PERSONAL_RECIPE_TOPIC_ARG_FIELDS,
  PERSONAL_RECIPE_EVENT_SKIP_REASONS,
  PERSONAL_RECIPE_EVENT_SKIP_REASON_SET,
  PersonalRecipeValidationError,
  validatePersonalRecipeEntry,
  validatePersonalRecipesBlob,
  assertValidPersonalRecipesBlob,
  normalizeTopic,
  resolveEventTopics,
  eventSkipReason,
  matchesPersonalRecipeEntry,
  assertPersonalRecipeInvariants,
} from './personal-recipes.js';
export type {
  PersonalRecipeEntry,
  PersonalRecipeValidationIssueKind,
  PersonalRecipeValidationIssue,
  PersonalRecipeTopicArgField,
  PersonalRecipeEventSkipReason,
} from './personal-recipes.js';

// D-145 PB11 — contact_topic_mention trigger (Person-Specific Automation).
export type {
  ContactTopicMentionTrigger,
  ContactTopicMentionDispatchContext,
} from './triggers.js';
export { isContactTopicMentionTrigger } from './triggers.js';

// ── D-145 PB14 — Correction Learning primitive ──────────────────────

export {
  CORRECTION_EVENT_KINDS,
  CORRECTION_EVENT_KIND_SET,
  CORRECTION_EVENT_SCOPES,
  CORRECTION_EVENT_SCOPE_SET,
  EXTRACTION_UNDONE_REASONS,
  EXTRACTION_UNDONE_REASON_SET,
  CONTACT_MERGE_CHANNELS,
  CONTACT_MERGE_CHANNEL_SET,
  PLAN_OUTCOME_USER_FEEDBACK,
  PLAN_OUTCOME_USER_FEEDBACK_SET,
  CORRECTION_EVENT_VALIDATION_ISSUE_KINDS,
  CORRECTION_EVENT_VALIDATION_ISSUE_KIND_SET,
  CORRECTION_EVENT_DURABLE_KINDS,
  CORRECTION_EVENT_DURABLE_KIND_SET,
  CORRECTION_EVENT_RETENTION_MS,
  EXTRACTION_THRESHOLD_LADDER,
  EXTRACTION_THRESHOLD_TRIGGER_COUNT,
  EXTRACTION_THRESHOLD_WINDOW_MS,
  CorrectionEventValidationError,
  isCorrectionEventKind,
  isCorrectionEventScope,
  validateCorrectionEventPayload,
  validateCorrectionEventRow,
  assertValidCorrectionEventRow,
  assertCorrectionEventInvariants,
} from './correction-events.js';
export type {
  CorrectionEventKind,
  CorrectionEventScope,
  ExtractionUndoneReason,
  ContactMergeChannel,
  PlanOutcomeUserFeedback,
  CorrectionEvent,
  CorrectionEventRow,
  CorrectionEventValidationIssueKind,
  CorrectionEventValidationIssue,
  CorrectionSummary,
} from './correction-events.js';

// D-164 P6d — PB16 cognition substrate (working memory surface)
// retired. The contracts file `cognition.ts` was deleted; this barrel
// no longer re-exports cognition shapes.

// ── D-145 PB12 — Peer-Recued Preview primitive (`redacted_packet`) ──

export {
  REDACTED_PACKET_KINDS,
  REDACTED_PACKET_KIND_SET,
  S2S_PREVIEW_PACKET_KINDS,
  S2S_PREVIEW_PACKET_KIND_SET,
  isS2SPreviewPacketKind,
  PACKET_FIELDS_VISIBLE,
  REDACTED_PACKET_DEFAULT_TTL_MS,
  REDACTED_PACKET_MIN_TTL_MS,
  REDACTED_PACKET_MAX_TTL_MS,
  REDACTED_PACKET_VALIDATION_ISSUE_KINDS,
  REDACTED_PACKET_VALIDATION_ISSUE_KIND_SET,
  REDACTED_PACKET_ACCESS_TOKEN_MAX_LENGTH,
  RedactedPacketValidationError,
  computeFreeWindows,
  redactCounterpartyName,
  relativizeTimestamp,
  isVisibleField,
  isPacketExpired,
  validateAccessToken,
  buildRedactedPacket,
  assertRedactedPacketInvariants,
  // D-149 P2 reception substrate constants
  RECEPTION_PAGE_PREFERRED_CONTACT_METHODS,
  RECEPTION_PAGE_PREFERRED_CONTACT_METHOD_SET,
  SCHEDULING_LINK_VISITOR_FIELD_REQUIREMENTS,
  SCHEDULING_LINK_VISITOR_FIELD_REQUIREMENT_SET,
  INTAKE_FORM_VISITOR_FIELD_TYPES,
  INTAKE_FORM_VISITOR_FIELD_TYPE_SET,
  DROP_LINK_VISITOR_FIELD_REQUIREMENTS,
  DROP_LINK_VISITOR_FIELD_REQUIREMENT_SET,
  APPROVAL_LINK_ACTION_KINDS,
  APPROVAL_LINK_ACTION_KIND_SET,
  STATUS_LINK_PROJECTION_KINDS,
  STATUS_LINK_PROJECTION_KIND_SET,
  STATUS_PROJECTION_FIELDS_VISIBLE,
} from './redacted-packets.js';
export type {
  RedactedPacketKind,
  S2SPreviewPacketKind,
  RedactedPacket,
  RedactedPacketRawByKind,
  RedactedPacketPayloadByKind,
  RedactedPacketValidationIssueKind,
  RedactedPacketValidationIssue,
  RedactedPacketAuditEmitter,
  RedactedPacketBuildAuditEvent,
  RedactedPacketAccessAuditEvent,
  AvailabilityRawCalendarEvent,
  AvailabilityRawInput,
  FreeWindow,
  ProjectStatusRawInput,
  CommitmentSummaryRawInput,
  ContactCardRawInput,
  EventPlanRawInput,
  ItineraryRawInput,
  ItineraryLegRawInput,
  BuildRedactedPacketOptions,
  S2SPreviewBuildRequest,
  S2SPreviewBuildResponse,
  S2SPreviewConsumeRequest,
  S2SPreviewConsumeResponse,
  // D-149 P2 reception substrate types
  ReceptionPagePacketRawInput,
  ReceptionPagePreferredContactMethod,
  ReceptionPageSectionConfig,
  ReceptionPageLinkedEndpoints,
  ReceptionPageCtaButton,
  SchedulingLinkPacketRawInput,
  SchedulingLinkVisitorFieldRequirement,
  SchedulingLinkVisitorFieldRequirements,
  IntakeFormPacketRawInput,
  IntakeFormDefinitionView,
  IntakeFormVisitorFieldType,
  IntakeFormVisitorField,
  DropLinkPacketRawInput,
  DropLinkVisitorFieldRequirement,
  DropLinkVisitorFieldRequirements,
  ApprovalLinkPacketRawInput,
  ApprovalLinkActionKind,
  ApprovalLinkOption,
  ApprovalLinkVisitorFieldConstraints,
  ApprovalLinkContextRaw,
  StatusLinkPacketRawInput,
  StatusLinkProjectionKind,
} from './redacted-packets.js';

// D-164 P6.6 retired the D-145 PB17 Stage 1 classifier contracts
// (`packages/contracts/src/stage1.ts` deleted); P6.7 retired the
// matching transparency event kinds (`engine.stage1_classified` /
// `engine.stage2_composed` / `engine.context_filtered` /
// `engine.stage1_fallback`) and their `TransparencyStage1FallbackReason`
// / `TRANSPARENCY_STAGE1_FALLBACK_REASONS` enum, replacing them with
// the prompt-cache main-turn kinds `engine.gate_short_circuit` and
// `engine.catalog_assembled` (re-exported above with the rest of the
// transparency-stream barrel).

// ── D-162 — Batch mode for contracted ai-* ingredients ──────────────

export {
  BATCH_CAPABLE_AI_SLUGS,
  BATCH_CAPABLE_AI_SLUG_SET,
  isBatchCapableAISlug,
  AI_RESULT_FIELDS,
  isAIBatchMode,
} from './ai-batch.js';
export type {
  BatchCapableAISlug,
  AIBatchEntry,
} from './ai-batch.js';
export {
  ENTITY_FIELD_PRIVACY_KINDS,
  LEDGER_KINDS,
  isEntityFieldPrivacy,
  isLedgerKind,
  ALIAS_REF_SCHEME,
  composeAliasRef,
  parseAliasRef,
  normalizePiiFields,
  // D-167 E.1 — entity-marker privacy: the inline `__entity` marker key shared
  // by the stamp / resolve / strip seams.
  PII_ENTITY_MARKER_KEY,
} from './pii-alias.js';
export type {
  EntityFieldPrivacy,
  LedgerKind,
  AliasScope,
  RedactionMode,
  RestorePolicy,
  AliasFirstObserved,
  RedactionAliasEntry,
  // § 7 follow-on — the durable run-ledger snapshot a D-157 Checkpoint
  // carries (pii-ledger-in-checkpoint).
  PiiLedgerStoreSnapshot,
  RedactionSummary,
  PiiAliasableData,
  PiiFieldTag,
  // D-167 E.1 — entity-marker privacy declaration (operation-free).
  EntityPrivacyTag,
  PiiProtectInput,
  PiiProtectOutput,
  PiiRestoreInput,
  PiiRestoreOutput,
  AliasResolutionRequirement,
  AliasLookupRequest,
} from './pii-alias.js';

// D-165 — entity-schema ingredient input (vendor → canonical mapping +
// MetaField.privacy D-167 catalog tag).
export {
  PROJECTION_MODES,
  ENTITY_SCHEMA_MODES,
  META_FIELD_TYPES,
  isProjectionMode,
  isEntitySchemaMode,
  isMetaFieldType,
  assertEntitySchemaIngredientShape,
  assertEntitySchemaIngredientValid,
} from './entity-schema.js';
export type {
  ProjectionMode,
  EntitySchemaMode,
  MetaFieldType,
  MetaField,
  EntitySchemaTargetId,
  EntitySchemaSourceOperation,
  EntitySchemaSourceOperations,
  EntitySchemaIngredientInput,
} from './entity-schema.js';
export * from './compose/index.js';
export type { ArgEditField, CanonicalWorkflowTemplate } from './bulk-pack.js';
export * from './reception-inbox.js';
// D-175 P5 — recued.com account ↔ server binding contract (exchange
// request/response, secret-free summary, pair-RPC req/resp, audit kinds).
export * from './account-binding.js';
// D-175 P8 — Pro convenience status contract (secret-free per-item
// {handle, ddns, acme} states for the `pro_convenience.status` pair-RPC).
export * from './pro-convenience.js';
// D-178 — Release & Update substrate, `update.check` rpc projection.
export * from './release-update.js';
// D-182 §7.2 — per-contract cli-tool reachability vocabulary (the Local-tools
// grid + install-dialog substrate the gateway cli stage reads; F1 RESOLVED).
export * from './cli-reachability.js';
// D-182 §7.2 — owner-only `cli.reachability.*` grid rpc wire shapes (the surface
// that authors the per-contract cli reachability allowlist).
export * from './cli-reachability-rpc.js';
// D-182 — cli executor failure classification (CliFailureDetail carrier +
// reason→RecipeErrorCode mapping); replaces the NETWORK_ERROR mislabel so a cli
// failure reads honestly through the step error / Runs feed / chat errors[].
export * from './cli-failure.js';
// D-192 Slice 6b — work-entity container-pick carrier (ContainerPickDetail +
// isContainerPickDetail). Survives the engine seam like CliFailureDetail so the
// chat/MCP create path can raise a D-158 pick ask instead of losing the choice
// set to a generic step error.
export * from './container-pick.js';
// D-192 Slice 6c — work-entity create-plan carrier (CreatePlanDetail +
// PlannedDependencyCreate + isCreatePlanDetail). Survives the engine seam so a
// decide-then-execute container create surfaces one create-plan confirm.
export * from './create-plan.js';
// D-181 Slice 2 — long-op execution lanes (ExecutionLane / CallClass /
// callClassForKind / ProgressContract) + the LaneGovernor port + no-op governor.
export * from './execution-lane.js';
export * from './lane-governor.js';
// D-181 Slice 3 — progress-based stall detection (pure decision core +
// run-origin classification + per-kind progress-contract defaults).
export * from './stall-detection.js';
// D-181 Slice 4 — live active-list + kill control surface (ActiveExecutionEntry /
// LaneStatus / KillDescriptor / HeavyOpErrorCategory / LiveControlCapability +
// the `execution.{active,kill,cancel,promote}` rpc shapes).
export * from './execution-control.js';
export * from './chat-tool-call.js';
// Durable operation-scoped approval outcomes. A recipe run may own several;
// one approval group may cover several receipts.
export * from './gated-action.js';
// D-214 execution cases — request → flow precedent, harvested at the governed
// boundary and fed back as ADVISORY evidence (OutcomeReport / RequestShape /
// FlowPattern / ExecutionCase / ExecutionCaseCard / CaseCandidateSource).
// Nothing here gates or permits; `outcome.report` is chat-only and is
// deliberately NOT a kernel op — no OPS entry, no contract toggle, no grant.
export * from './execution-case.js';
// D-221 — installed/runtime contract for the fixed, core-owned Records
// substrate. Pack authoring remains the existing composition schema.
export * from './records.js';
// D-226 — the shared aggregation evaluator (one implementation, two callers).
export * from './records-aggregate.js';
// D-226 — the declared reverse read (roots + select on the entity).
export * from './records-root-projection.js';
// D-172 resumable uploads — webclient binary-WS transport contract (chunk-frame
// codec + ack shape + the `upload.{create,probe,finalize,delete}` rpc shapes).
export * from './upload-frame.js';
// M4 archive download — webclient binary-WS `/ws/download` transport contract
// (single-shot control frames: download_start / complete / error).
export * from './download-frame.js';
// M4b.1 archive upload — `server.archive.upload.*` control-plane rpc shapes (the
// chunk BYTES reuse the generic `upload-frame.ts` wire format; finalize STAGES
// the assembled archive under `exports/` for `server.archive.import`).
export * from './archive-upload.js';

// D-148 § A.2.1 follow-on — the WS bearer's `Sec-WebSocket-Protocol` carrier.
// Three surfaces must agree byte for byte (webclient + Bridge encode, server
// decodes) and a disagreement fails closed, so the codec is shared, not copied.
export * from './ws-subprotocol.js';
export type { RecipeDefinition as Recipe } from './recipe.js';
export {
  PURE_WORKFLOW_STEP_KINDS,
  classifyPureWorkflowStep,
  isPureWorkflowRecipe,
  recipeTrustStateForPureWorkflow,
} from './approval.js';
export type { PureWorkflowStepKind } from './approval.js';

// Epoch normalisation for recent timestamps — the single decider of
// unix-ms vs unix-seconds. See recent-date.ts for why the window is bounded.
export {
  toRecentMs,
  RECENT_MS_MIN,
  RECENT_MS_MAX,
  RECENT_S_MIN,
  RECENT_S_MAX,
} from './recent-date.js';

// T3-AUD-1 — free-tier data-use disclosure. Pure lookup + one shared notice
// builder, in contracts (not `@recued/llm`) because the surfaces that must say
// it are CLIENTS: the webclient has no `@recued/llm` dependency and should not
// gain one for a table — that package carries adapters and executor code with
// no business in a browser bundle. Same placement rationale as
// `messenger-vendors.ts`: vendor facts the whole tree reads live here.
export {
  resolveFreePoolDataUse, freePoolDataUseNotice,
} from './free-pool-data-use.js';
export type {
  FreePoolDataUse, FreePoolDataUseTerms,
} from './free-pool-data-use.js';

// ────────────────────────────────────────────────────────────────
// D-250 § D — owner metrics
// ────────────────────────────────────────────────────────────────
export {
  METRIC_REGISTRY,
  ANCHOR_METRIC_IDS,
  ACTIVITY_METRIC_IDS,
  AUTOPILOT_TRIGGER_CLASS,
  GATEWAY_OP_ACTION,
  ASKABLE_RISK_TIERS,
  NON_ASKABLE_RISK_TIERS,
  BURST_CHANNELS,
  BURST_IDLE_GAP_MS,
  METRIC_ABSENT,
  METRIC_UNBOUNDED,
  metricValue,
  metricRatio,
  classifyAutopilotTrigger,
  assertMetricRegistryConsistent,
} from './metric-registry.js';
export {
  MILESTONE_REGISTRY,
  AUDIT_DERIVABLE_MILESTONES,
  assertMilestoneRegistryConsistent,
} from './milestone-registry.js';
export type { MilestoneDefinition, MilestoneSource } from './milestone-registry.js';
export type {
  MetricReadOutput,
  MetricReadEntry,
  MetricArtifactEntry,
  MetricMilestoneEntry,
  MetricPublicationEntry,
  MetricSubmitSkipReason,
} from './metric-rpc.js';
export type {
  MetricDefinition,
  MetricShape,
  MetricStore,
  MetricDirection,
  MetricReading,
  AnchorMetricId,
  ActivityMetricId,
  AutopilotClass,
} from './metric-registry.js';
export * from './date-compute.js';
export * from './searchable-score.js';
export * from './saved-data-views.js';
export * from './records-view.js';
export * from './task-data-view.js';
export * from './preapproval.js';
export * from './operation-phrase.js';

export * from './chat-turn-queue.js';
export * from './file-lifecycle.js';
export * from './chat-delivery.js';
export * from './chat-history-filters.js';

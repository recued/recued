/** D-121 Phase 3 — `@recued/ui-shared` root barrel.
 *
 *  Most consumers import from a subpath (`@recued/ui-shared/primitives`,
 *  `@recued/ui-shared/top-bar`, etc.); this root re-export exists so
 *  callers that want a one-liner can grab the canonical surface in
 *  one statement. */

export * from './template.js';
export * from './date-time.js';
export * from './icon-render.js';
export * as Icons from './icons.generated.js';
export * from './action-dispatcher.js';
export * from './field-dispatcher.js';
export * from './recovery-grid-field-handler.js';
export * from './recovery-words.js';
export * from './variable-widgets.js';
export * from './output-filter.js';
export * from './file-ref-array.js';
export * from './record-ref-variable.js';
export * from './config-editor-overlay.js';
export * as Primitives from './primitives/index.js';
export * as TopBar from './top-bar/index.js';
export * as ServerPill from './server-pill/index.js';
export * from './runtime/adapters.js';
export * from './events/dispatcher.js';
// D-122 Phase 4 — Bulk-install pack dialog.
export {
  renderBulkPackDialog,
  type BulkPackConnectionNeed,
  type BulkPackFileSlugNeed,
  type BulkPackDialogRecipe,
  type BulkPackDialogState,
  type BulkPackPermission,
  type BulkPackRecipeCost,
} from './install/bulk-pack-dialog.js';
// D-122 Phase 4 — Bulk-install pack flow orchestrator.
export {
  runBulkPackInstall,
  type BulkPackFlowAdapters,
  type BulkPackFlowResult,
  type DialogOutcome,
  type PackAuditEvent,
  type PackCostEstimate,
  type PackRecipeCost,
  type PackResolution,
} from './install/bulk-pack-flow.js';
// R2 build step 4 — pack install/uninstall runnability disclosure copy
// (shared by the #recipes route + the Settings → Packs panel).
export {
  installDisclosureBlocks,
  runnabilityDisclosureLines,
  uninstallDisclosureBlocks,
  type PackDisclosureBlock,
  type PackDisclosureItem,
  type PackDisclosureKind,
} from './install/pack-runnability-disclosure.js';
// D-122 Phase 6 — Marketplace surfacing (recipe card, filter chips, pack page).
export {
  renderRecipeCard,
  renderMarketplaceFilterChips,
  toggleMarketplaceFilter,
  renderPackPage,
  DEFAULT_MARKETPLACE_FILTER_CHIPS,
  type RecipeCardState,
  type RecipeCardTriggerKind,
  type RecipeCardPackMembership,
  type MarketplaceFilterChip,
  type MarketplaceFilterChipsState,
  type PackPageState,
  type PackPageCostSummary,
} from './marketplace/index.js';
// D-125 Phase 7 — Settings → Connections page.
export {
  renderConnectionsPage,
  connectionFormValidationIssue,
  connectionFormValidationSummary,
  connectionFormValidationShouldAnnounce,
  connectionCredentialRegenerationAdminHandoff,
  validateConnectionForm,
  CONNECTIONS_PAGE_STYLES,
  MCP_PACK_INSTALL_SCOPE_HOST_ATTR,
  initialConnectionsPageState,
  initialConnectionsDialogState,
  initialConnectionsSetupGuideState,
  canonicalizeConnectionSetupGuideUrl,
  buildConnectionSetupGuidePreview,
  connectionSetupGuideContextsMatch,
  canApplyConnectionSetupGuideSuggestion,
  connectionSetupGuideReturnTarget,
  connectionOAuthCredentialReadiness,
  connectionOAuthHttpsEndpointIssue,
  invalidatesConnectionOAuthResult,
  isConnectionOAuthLockedField,
  connectionRowKey,
  projectConnectionPayload,
  shouldPatchConnectionAuth,
  flattenConnectionViewIntoValues,
  resolveConnectionViewVendor,
  buildConnectionEditDialogPatch,
  type ConnectionsPageProps,
  type ConnectionsPostSafeStopProfileHandoff,
  type ConnectionFormValidationIssue,
  type ConnectionFormValidationSummary,
  type ConnectionsPageState,
  type ConnectionsDialogState,
  type ConnectionsDialogExternalChangeState,
  type ConnectionsDialogCredentialCorrectionState,
  type ConnectionsDialogStage,
  type ConnectionsServerUpdateTriage,
  type ConnectionsServerUpdateTriageReason,
  type ServerUpdateReceiptVerificationState,
  type ConnectionSetupGuideAuthType,
  type ConnectionSetupGuideConfidence,
  type ConnectionSetupGuideReturnTarget,
  type ConnectionSetupGuideRequest,
  type ConnectionSetupGuideResult,
  type ConnectionSetupGuidePreview,
  type ConnectionsSetupGuideStage,
  type ConnectionsSetupGuideState,
  type CanonicalConnectionSetupGuideUrl,
  type BuildConnectionSetupGuidePreviewResult,
  type ConnectionOAuthCredentialFieldKey,
  type ConnectionOAuthCredentialIssue,
  type ConnectionOAuthCredentialReadiness,
  type ConnectionOAuthCredentialRequirement,
  type ConnectionPayload,
  type ConnectionEditDialogPatch,
  applyConnectionHints,
  connectionHintSetupSlug,
  connectionHintValues,
  type AppliedConnectionHint,
  type ConnectionHintSource,
  // D-225 Slice 2 — the MCP generated-pack owner surfaces.
  mcpPackBadge,
  mcpPackReviewView,
  packRemovalMessage,
  packRemovalConfirm,
  type McpPackStatusView,
  type McpPackBadge,
  type McpPackReviewRowView,
  type McpPackReviewView,
} from './connections/index.js';
// Connections ▸ foundational account lanes (Mail · Calendar · Files) — the
// `collection.{mail,calendar,file}.*` half of the restructured surface (R13–R16).
export {
  ACCOUNT_LANES,
  ACCOUNT_SLUG_REGEX,
  ACCOUNTS_PANEL_STYLES,
  canSubmitAccountForm,
  findAccountLane,
  findAccountProvider,
  initialAccountsPanelState,
  isOAuthAccountTransport,
  renderAccountsPanel,
  seedAccountFormValues,
  splitAccountList,
  validateAccountForm,
  type AccountEnrollTransport,
  type AccountField,
  type AccountFieldType,
  type AccountFormValues,
  type AccountLane,
  type AccountLaneId,
  type AccountProvider,
  type AccountRow,
  type AccountsOAuthReloadRecovery,
  type AccountsPanelProps,
  type AccountsPanelStage,
  type AccountsPanelState,
} from './accounts/index.js';
// D-128 Phase 5 — Memory tab entity-detail panel.
export {
  renderEntityDetailPanel,
  // D-210 step 3 — the timeline section alone, for a host with its own header.
  renderTimelineSection,
  formatMetaFieldValue,
  summarizeEnrichmentValue,
  pickFreshestMetaSnapshot,
  collapseToFreshestPerTopic,
  ENTITY_DETAIL_PANEL_STYLES,
  type EntityDetailPanelProps,
  type EnrichmentSummary,
} from './memory/index.js';
// D-138 Phase 2 — Contact merge review + enrollment focus page.
// D-138 Phase 4 — Settings → Contacts persistent surface.
export {
  renderMergeReviewDialog,
  initialMergeReviewDialogState,
  MERGE_REVIEW_FIELDS,
  MERGE_REVIEW_DIALOG_STYLES,
  renderEnrollmentFocusPage,
  initialEnrollmentFocusPageState,
  isEtaEligible,
  remainingMillis,
  formatRemaining,
  DEFAULT_ETA_CONFIG,
  ENROLLMENT_FOCUS_PAGE_STYLES,
  renderContactsSettingsSection,
  initialContactsSettingsSectionState,
  CONTACTS_SETTINGS_SECTION_STYLES,
  // D-138 P5 — vendor preview + failure banner
  renderVendorMergePreviewDialog,
  VENDOR_MERGE_DIALOG_ACTIONS,
  renderUpstreamMergeFailureBanner,
  type MergeReviewContactCard,
  type MergeReviewItem,
  type MergeReviewDialogState,
  type MergeReviewDialogProps,
  type EnrollmentFocusStage,
  type SyncProgress,
  type ScanProgress,
  type EtaConfig,
  type EnrollmentFocusPageState,
  type EnrollmentFocusPageProps,
  type ContactsSettingsSectionState,
  type VendorMergePreviewState,
  type VendorMergeDialogAction,
  type UpstreamMergeFailureBannerState,
} from './contacts/index.js';
export {
  resolveConnectionSchema,
  resolveVendorSchema,
  initialVendorSchemaValues,
  syncVendorOAuthEndpointValue,
  // D-165 slice 3 — vendor OAuth popup result handling (webclient enroll host).
  applyVendorOAuthResultValues,
  isVendorSandboxSelected,
  airbyteSchema,
  AIRBYTE_API_BASE,
  AIRBYTE_TOKEN_ENDPOINT,
  AIRBYTE_SCHEMA_INITIAL_VALUES,
  tavilySchema,
  TAVILY_API_BASE,
  TAVILY_SCHEMA_INITIAL_VALUES,
  tradingviewUdfSchema,
  TRADINGVIEW_UDF_DEMO_BASE,
  TRADINGVIEW_UDF_SCHEMA_INITIAL_VALUES,
  blueskySchema,
  BLUESKY_API_BASE,
  BLUESKY_SCHEMA_INITIAL_VALUES,
  apiSchema,
  mcpSchemas,
  notificationSchemas,
  MAIL_SEND_CAPABLE_INSTANCES_SOURCE,
  CONNECTION_KIND_CHOICES,
  CONNECTION_SUBTYPE_CHOICES,
  CONNECTION_NAME_REGEX,
  collectHeaderRows,
  collectMatchPatternRows,
  matchPatternRowsToPatterns,
  isCompleteMatchPatternRow,
  isHalfFilledMatchPatternRow,
  type ConnectionField,
  type ConnectionFieldType,
  type ConnectionFormValues,
  type ConnectionProbeSpec,
  type ConnectionSchema,
  type HeaderRow,
  type MatchPatternRow,
  type McpSubtype,
  type NotificationSubtype,
  type VendorOAuthResultValuePatch,
} from './connection-schemas/index.js';
// D-145 PA5 — form-renderer substrate (rendering + DOM read).
export {
  renderField,
  renderForm,
  readField,
  readFormValues,
  FORM_RENDERER_STYLES,
  type FormRenderOptions,
} from './form-renderer/index.js';
// Shared name→id reference-picker (combobox) — ONE primitive behind every
// "type a name → store an id" field (recipe filters, `data.*` refs, …).
// Namespaced (generic model verbs like `setQuery`/`closeList` would
// otherwise pollute the flat barrel).
export * from './output-table-edit.js';
export * as RefPicker from './ref-picker/index.js';
// Shared resumable-upload engine + widget — the CLIENT half of D-172 file
// uploads (state machine over the binary `/ws/upload` transport + `upload.*`
// rpc control plane, plus a vanilla-DOM progress widget). Namespaced like
// RefPicker (own attr constants + a generic `createUploadEngine` verb).
export * as Upload from './upload/index.js';
// Shared Run | Schedule modal — ONE recipe-launch modal behind both the
// recipes library page and the chat-composer "Run a recipe" palette
// (webclient IA §D.L1). Namespaced like RefPicker (own attr constants +
// generic verbs).
export * as RunModal from './run-modal/index.js';
// Shared modal focus-trap (a11y) — Tab cycling within an `aria-modal` dialog +
// focus-in/restore, across the Run modal, the recipes Automation modal, and the
// chat Create overlay. A flat named export (one function + its types).
export {
  wireFocusTrap,
  type WireFocusTrapOptions,
  type FocusTrapHandle,
} from './focus-trap.js';
// D-145 PA6 — work-entity page substrate (Source dropdown + list/search view
// + create/edit dialog). R18 dropped the per-kind nav (the Data route's grouped
// tabs are the single kind nav).
export {
  renderSourceDropdown,
  renderSourceAffordanceChips,
  renderWorkEntityListView,
  renderWorkEntityDialog,
  renderWorkEntityPage,
  renderBookingDetail,
  projectRowText,
  WORK_ENTITY_PAGE_STYLES,
  type SourceDropdownProps,
  type WorkEntityDialogProps,
  type WorkEntityPageProps,
  type BookingDetailProps,
} from './work-entity-page/index.js';
// D-145 PA7 — mail-compose substrate (compose dialog wrapping the
// PA5 form-renderer + sender-Source picker + AI-assist sidebar stub).
export {
  renderMailComposeDialog,
  renderAiAssistSidebar,
  MAIL_COMPOSE_STYLES,
  type MailComposeDialogProps,
  type AiAssistSidebarProps,
} from './mail-compose/index.js';

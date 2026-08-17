/** D-125 P7.1 — Settings → Connections page barrel.
 *
 *  Public surface for the new D-125 Connections UI. Schemas live one
 *  level up under `connection-schemas/` so recipe-install pre-fill
 *  paths can pick them up without dragging in the page renderer. */

export {
  renderConnectionsPage,
  connectionFormValidationIssue,
  connectionFormValidationSummary,
  connectionFormValidationShouldAnnounce,
  connectionCredentialRegenerationAdminHandoff,
  MCP_PACK_INSTALL_SCOPE_HOST_ATTR,
  validateConnectionForm,
  CONNECTIONS_PAGE_STYLES,
  type ConnectionsPageProps,
  type ConnectionsPostSafeStopProfileHandoff,
  type ConnectionFormValidationIssue,
  type ConnectionFormValidationSummary,
} from './page.js';
export {
  initialConnectionsPageState,
  initialConnectionsDialogState,
  connectionRowKey,
  type ConnectionsPageState,
  type ConnectionsDialogState,
  type ConnectionsDialogExternalChangeState,
  type ConnectionsDialogCredentialCorrectionState,
  type ConnectionsPostSafeStopRecoveryState,
  type ConnectionsDialogStage,
  type ConnectionsDeleteConfirmState,
  type ConnectionsServerUpdateTriage,
  type ConnectionsServerUpdateTriageReason,
  type ServerUpdateReceiptVerificationState,
} from './state.js';
export {
  initialConnectionsSetupGuideState,
  canonicalizeConnectionSetupGuideUrl,
  buildConnectionSetupGuidePreview,
  connectionSetupGuideContextsMatch,
  canApplyConnectionSetupGuideSuggestion,
  connectionSetupGuideReturnTarget,
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
} from './setup-guide.js';
export {
  connectionFormRunsOAuthDance,
  connectionOAuthCredentialReadiness,
  connectionOAuthHttpsEndpointIssue,
  invalidatesConnectionOAuthResult,
  isConnectionOAuthLockedField,
  type ConnectionOAuthCredentialFieldKey,
  type ConnectionOAuthCredentialIssue,
  type ConnectionOAuthCredentialReadiness,
  type ConnectionOAuthCredentialRequirement,
} from './oauth-credentials.js';
export {
  projectConnectionPayload,
  shouldPatchConnectionAuth,
  flattenConnectionViewIntoValues,
  resolveConnectionViewVendor,
  buildConnectionEditDialogPatch,
  type ConnectionPayload,
  type ConnectionEditDialogPatch,
} from './payload.js';
export {
  renderEngagementHealthPanel,
  ENGAGEMENT_HEALTH_PANEL_STYLES,
  type EngagementHealthPanelProps,
} from './engagement-health.js';
// D-223 — pack-declared pre-fills for the generic connection form. Values only,
// onto fields the schema renders visible and editable.
export {
  applyConnectionHints,
  connectionHintSetupSlug,
  connectionHintValues,
  type AppliedConnectionHint,
  type ConnectionHintSource,
} from './apply-hints.js';
// D-225 Slice 2 — the MCP generated-pack owner surfaces: drift badge, the
// enrollment review model, and wording for a removal that also deletes a
// connection. Pure projections; the security properties the server established
// are preserved HERE or they are lost.
export {
  mcpPackBadge,
  mcpPackReviewView,
  packRemovalMessage,
  packRemovalConfirm,
  type McpPackStatusView,
  type McpPackBadge,
  type McpPackReviewRowView,
  type McpPackReviewView,
} from './mcp-pack.js';

export type { IngredientExecutor, ManifestLoader, ResolvedCall } from './types.js';
export { IngredientError } from './types.js';
export { executeMCP, type MCPInput } from './mcp.js';
export { executeHTTP, describeHttpRequest } from './http.js';
export { executeDOM, type DOMContext, type DOMWriteResult } from './dom.js';
export { createChatAdapter, type ChatAdapterDeps, type ChatConfig, type ChatAuditEntry } from './chat.js';
export { matchUrlPattern } from './url-match.js';
export { composeApiUrl } from './url-template.js';
export {
  fetchOriginPinned,
  CrossOriginRedirectError,
  RedirectLimitError,
} from './origin-pinned-fetch.js';
export {
  DEFAULT_RESPONSE_BODY_MAX_BYTES,
  ResponseBodyTooLargeError,
  discardResponseBody,
  readBoundedResponseBytes,
  readBoundedResponseText,
  type BoundedResponseText,
} from './bounded-response-body.js';
export { withIngredientCache, type IngredientCacheOptions } from './cache.js';
export {
  createIngredientExecutor,
  mergeManifestStepInput,
  mergeManifestStepOutput,
  resolveDispatchSlot,
  type Adapter,
  type DispatchSlot,
  type IngredientDispatchOptions,
} from './dispatch.js';
export {
  createKernelAdapter,
  RECEPTION_LOCAL_BASE_URL,
  RECEPTION_MATERIALIZE_SLUG,
  RECIPE_KEYED_WATCHER_SLUGS,
  type KernelDispatchers,
  type KernelCollectionPlatform,
  type KernelCollectionRecord,
  type KernelCollectionSearchMatch,
  type KernelWatcherSlug,
  type KernelTriggerOutput,
  type ReceptionMaterializeInput,
  type ReceptionMaterializeKind,
  type ReceptionMaterializeResult,
  type KernelSellerOfferEnsureInput,
  type KernelSellerOfferListInput,
} from './kernel.js';
export {
  createConnectionAdapter,
  type ConnectionAdapterDeps,
  type ConnectionAdapterStore,
  type ConnectionAuditEmission,
  type ConnectionHandlerCtx,
  type ConnectionKindHandler,
} from './connection.js';
export {
  createConnectionApiHandler,
  describeConnectionApiRequest, describeConnectionApiUpload,
  buildConnectionApiBody,
  refreshOAuth2,
  refreshOAuth2WithMetadata,
  exchangeOAuth2ClientCredentials,
  createEnsureFreshAuth,
  createEnsureFreshAuthDetailed,
  type ConnectionApiHandlerDeps,
  type EnsureFreshAuthDeps,
  type OAuth2RefreshResult,
  type FreshConnectionAuth,
} from './connection-api.js';
export {
  createConnectionMcpHandler,
  describeConnectionMcpRequest,
  type ConnectionMcpHandlerDeps,
  type McpStreamHandle,
  type WsClientHandle,
  type WsConnect,
  type StdioClientHandle,
  type StdioSpawn,
  type McpStreamProbeResult,
  probeMcpLegacySseTools,
  probeMcpPushSupport,
  type McpPushProbeResult,
  type McpPushUnavailableReason,
  type McpAcknowledgedNotifications,
  openMcpListenStream,
  createMcpListenOpener,
  MCP_LISTEN_OPEN_TIMEOUT_MS,
  type McpListenStreamHandle,
  type McpListenOpenResult,
  probeMcpStreamTools,
  readMcpHttpEnvelope,
  MCP_TOOL_LIST_PROBE_MAX_PAGES,
  type McpToolListPageResult,
  parseMcpToolListPage,
  type StdioMcpLaunchSpec,
  type StdioMcpLaunchSpecResult,
  resolveStdioMcpLaunchSpec,
} from './connection-mcp.js';
export {
  createConnectionNotificationHandler,
  type ConnectionNotificationHandlerDeps,
  type InAppEmitFn,
  type NotificationBusBody,
  type MailRpcDep,
  type MailRpcSendInput,
  type MailRpcSendResult,
} from './connection-notification.js';
export {
  validateIngredient,
  isValidIngredient,
  assertValidIngredient,
  crossCheckCatalogOpenApi,
  crossCheckCatalogGoogleDiscovery,
} from './validate.js';
export {
  evaluateTimeWatcher,
  type TimeWatcherArgs,
  type TimeWatcherOutput,
  evaluateHttpWatcher,
  type HttpWatcherArgs,
  type HttpWatcherOutput,
  type HttpWatcherDeps,
  evaluateRecipeWatcher,
  type RecipeWatcherArgs,
  type RecipeWatcherKind,
  type RecipeWatcherOutput,
  type RecipeWatcherRunSummary,
  type RecipeWatcherDeps,
} from './watchers/index.js';
export type {
  ValidationSeverity,
  ValidationIssue,
  ValidationResult,
  ValidateIngredientOptions,
} from './validate.js';

// D-217 — the chunked-upload walk. It lives in THIS package, not the engine,
// because the § 8a amendment moved the walk BELOW the commit boundary: the
// sequencer runs here, and `packages/ingredients` cannot import the engine
// (the project graph runs engine → ingredients). The engine imports
// `planChunkedUpload` from here to size the act before it dispatches.
export {
  planChunkedUpload,
  startChunkedWalk,
  nextChunkedAction,
  advanceChunkedWalk,
  buildChunkedPhaseInput,
  ChunkedUploadPlanError,
  ChunkedPhaseInputError,
  type ChunkPlan,
  type ChunkPlanEntry,
  type ChunkedWalkAction,
  type ChunkedWalkOutcome,
  type ChunkedWalkResult,
  type ChunkedWalkState,
  type ChunkedPhaseTokens,
} from './chunked-upload-walk.js';
export {
  runChunkedUpload,
  parseChunkedWalkInput,
  ChunkedWalkInputError,
  type ChunkedUploadRunResult,
  type PerformChunkedPhase,
} from './chunked-upload-runner.js';

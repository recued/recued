/** Rpc layer — shared wire types.
 *
 *  Clients (bridge, webclient, server) import from here to get the
 *  canonical registry + conn types. No runtime code yet — just the
 *  contract.
 */

export type {
  RpcMethodSpec,
  RpcRegistry,
  RpcRequest,
  RpcResponse,
  Conn,
  NoArgMethods,
  RpcMiddleware,
  RpcCallOptions,
} from './types.js';

export { RpcError } from './types.js';

export type {
  ServerRpcRegistry,
  ServerAuthState,
  ServerAuthMigrationStatus,
  ServerSchedule,
  ServerMissedRunEntry,
  ServerMissedRunReport,
  RecipeRunFacts,
  ServerExecuteResponse,
  ServerMigrationResult,
  RecipeListRecipeView,
  ServerRecipeFullEntry,
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
} from './server-registry.js';

export { SERVER_RPC_METHODS, SERVER_RPC_METHOD_SET } from './server-registry.js';

export type {
  RpcHandler,
  HandlerRegistry,
  CompleteHandlerRegistry,
} from './handler.js';

export { composeHandlers, handlerSlice } from './compose.js';
export type { HandlerSlice, AnyHandlerSlice, ComposedHandlers } from './compose.js';

export { createPendingMap } from './pending-map.js';
export type { PendingEntry, PendingMap } from './pending-map.js';

export {
  collectListPages,
  LIST_PAGE_DEFAULT_LIMIT,
  LIST_PAGE_MAX_LIMIT,
} from './list-page.js';
export type {
  CollectListPagesOptions,
  ListPage,
  ListPageFields,
  ListPageRequest,
} from './list-page.js';

// D-120 Phase 7 — unified memory export contracts (per-recipe, local-full,
// server-full). The wire types + helper constants both extension and
// server share when implementing the unified export dialog.
export type {
  AuditExportFormat,
  AuditExportPreset,
  AuditExportRequest,
  AuditExportEstimate,
  AuditExportEnvelope,
  AuditExportPage,
  AuditExportEntry,
} from './audit-export.js';
export {
  AUDIT_EXPORT_MAX_PAGE_SIZE,
  AUDIT_EXPORT_DEFAULT_PAGE_SIZE,
  AUDIT_EXPORT_BYTES_PER_ENTRY,
  presetToBounds,
  clampAuditExportPageSize,
} from './audit-export.js';

// D-198 — owner-trusted memory-management rpc contracts (list/create/update/
// delete/import) over the D-120 `data.memory.*` timeline. Export reuses the
// `audit.export.*` pair above.
export type {
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
} from './memory.js';
export {
  MEMORY_LIST_MAX_PAGE_SIZE,
  MEMORY_LIST_DEFAULT_PAGE_SIZE,
} from './memory.js';

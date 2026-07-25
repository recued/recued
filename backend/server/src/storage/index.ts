export { createEncryptedBlobStore, type BlobStore } from './blob-store.js';
export {
  createSQLiteCacheStore,
  listReferencedBlobHashes,
  INLINE_THRESHOLD,
  type SQLiteCacheStoreOptions,
} from './sqlite-cache-store.js';
export {
  createAnnotationStore,
  ensureAnnotationSchema,
  listAnnotationReferencedBlobHashes,
  AnnotationKeyInvalidError,
  AnnotationValueTooLargeError,
  type AnnotationStore,
  type AnnotateInput,
  type LinkInput,
  type CascadeResult,
  type CreateAnnotationStoreOptions,
} from './annotation-store.js';
export {
  createContactStore,
  ensureContactSchema,
  type ContactStore,
  type ContactObservation,
  type ManualUpsertInput,
  type ContactListQuery,
} from './contact-store.js';
export {
  createEnrichmentStore,
  ensureEnrichmentSchema,
  EnrichmentTopicUnknownError,
  EnrichmentScopeUnsupportedError,
  EnrichmentValueInvalidError,
  EnrichmentShapeMismatchError,
  type EnrichmentStore,
  type EnrichmentRecord,
  type EnrichmentUpsertInput,
  type EnrichmentListQuery,
  type CreateEnrichmentStoreOptions,
} from './enrichment-store.js';
export {
  createEnrichmentCascade,
  type CascadeEngine,
  type CascadeResult as EnrichmentCascadeResult,
} from './enrichment-cascade.js';
export {
  createEnrichmentResolver,
  type EnrichmentResolver,
  type EnrichmentResolveResult,
} from './enrichment-resolver.js';
export {
  createEngagementStore,
  ensureEngagementSchema,
  EngagementInvalidError,
  EngagementCursorInvalidError,
  ENGAGEMENTS_TABLE,
  ENGAGEMENT_EDGES_TABLE,
  ENGAGEMENT_INBOUND_EVENT_LEDGER_TABLE,
  ENGAGEMENT_DEDUPE_CANDIDATES_TABLE,
  type EngagementStore,
  type CreateEngagementStoreOptions,
  type UpsertEngagementInput,
  type UpsertEdgeInput,
  type InboundEventLedgerCheckResult,
  type ContactRedirectLookup,
  type ContactIdentityExpansion,
} from './engagement-store.js';
// D-149 P1 — Reception substrate placeholder schemas (eight tables).
// Per-pair only; no cross-cloud sync (Must Hold I-15; D-097 / D-168).
export {
  ensureReceptionSchema,
  RECEPTION_TABLES,
  type ReceptionTableName,
} from './reception-store.js';
// D-172 resumable uploads — SHARED in-flight chunked-upload session substrate
// (reception drop + webclient Data→File consumers, keyed by scope_kind/scope_key).
// Per-pair only; no cross-cloud sync (D-097 / D-168).
export {
  createUploadSessionStore,
  ensureUploadSessionSchema,
  UPLOAD_SESSION_TTL_MS,
  UPLOAD_CHUNK_MAX_BYTES,
  UPLOAD_MAX_CONCURRENT_SESSIONS_PER_SCOPE,
  UPLOAD_MAX_PENDING_BYTES,
  type UploadScopeKind,
  type UploadSession,
  type UploadSessionStore,
  type UploadSessionCreateInput,
  type AdvanceOffsetResult,
} from './upload-session-store.js';
// D-196 Seller Economy — local seller settings/tier/customer/usage substrate.
export {
  createSellerStore,
  ensureSellerSchema,
  SELLER_SETTINGS_TABLE,
  SELLER_TIERS_TABLE,
  SELLER_CUSTOMERS_TABLE,
  SELLER_CUSTOMER_USAGE_ROLLUPS_TABLE,
  SellerStoreValidationError,
  SellerStoreConflictError,
  type SellerStore,
  type SellerSettingsUpsertInput,
  type SellerTierUpsertInput,
  type SellerCustomerUpsertInput,
  type SellerUsageRecordInput,
  type SellerCustomerListQuery,
} from './seller-store.js';
// D-137 — AI Chat core schemas (sessions + messages + durable action recovery).
// Per-pair only; no cross-cloud sync (D-097 / D-168).
// D-137 P1.2 — Chat sub-DEK helpers + ChatStore CRUD.
export {
  ensureChatSchema,
  CHAT_TABLES,
  createChatStore,
  encodeChatContentForStorage,
  decodeChatContentFromStorage,
  ChatVaultLockedError,
  type ChatTableName,
  type ChatStore,
  type ChatKeyProvider,
  type CreateSessionInput,
  type AppendMessageInput,
} from './chat-store.js';
export { createSqliteChatPlanStore } from './chat-plan-store.js';
// D-145 PA1 + PA2 — work entity substrate (task / note / commitment /
// project) + Source registry + note access ledger + default-Source
// memory.
export {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  WorkEntityValidationError,
  SourceRegistrationError,
  SOURCE_REGISTRY_TABLE,
  TASK_TABLE,
  NOTE_TABLE,
  COMMITMENT_TABLE,
  PROJECT_TABLE,
  NOTE_ACCESS_LEDGER_TABLE,
  WORK_ENTITY_DEFAULT_SOURCE_TABLE,
  TABLE_FOR_KIND,
  ALL_SYNC_STATES,
  type WorkEntityStore,
  type CreateWorkEntityStoreOptions,
  type WorkEntityListQuery,
  type WorkEntitySourceIdentityInput,
  type TaskWriteInput,
  type NoteWriteInput,
  type CommitmentWriteInput,
  type ProjectWriteInput,
} from './work-entity-store.js';

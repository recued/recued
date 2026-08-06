export type {
  Collection,
  EncryptedEntry,
  ConfigEntry,
  FieldQuery,
  FieldQueryableCollection,
} from './types.js';
export { isFieldQueryable } from './types.js';
export { createInMemoryCollection } from './in-memory.js';
export {
  createIDBCollection,
  type IDBCollection,
  type IDBCollectionOptions,
} from './idb-collection.js';
export {
  generateKey, exportKey, importKey,
  encrypt, decrypt,
  wrapKey, unwrapKey,
  deriveKeyFromPassphrase, generateSalt,
} from './crypto.js';
export { createEncryptedCollection } from './encrypted-collection.js';
export {
  createVaultStore,
  VaultQuotaExceededError,
  type VaultStore,
  type VaultQuotaOptions,
  type CreateVaultStoreOptions,
} from './vault.js';
export { createConfigStore, type ConfigStore } from './config.js';
export {
  createAuditLogStore,
  newRunId,
  buildAuditEntry,
  isReserveAction,
  RESERVE_ACTIONS,
  type AuditLogStore,
  type AuditEntry,
  type ActivityEntry,
  type ActivityAction,
  type AppendOptions,
  type AuditEntryInput,
} from './audit.js';
// D-120 Phase 2 — content-addressed recipe-shape snapshots store.
// Used by extension install path (IDB-backed) + tests; the server's
// SQL-side equivalent lives in `backend/server/src/memory-schema.ts`.
export {
  createRecipeInsightsStore,
  type RecipeInsightsStore,
  type RecipeInsightRecord,
} from './recipe-insights.js';
// D-120 Phase 7 — shared memory-export serializer. Both the extension
// (IDB-backed) and the server (SQLite-backed) call into the same
// `exportPage` + `estimateExport` helpers so the wire envelope shape
// stays identical across scopes.
export {
  exportPage,
  estimateExport,
  buildExportEntry,
  decodeAuditExportCursor,
  type AuditExportSource,
  type AuditExportIdentity,
  type AuditExportCursor,
  type AuditExportLinkRow,
  type AuditExportInsightRow,
} from './audit-export.js';
// D-125 Phase 1.2 — connection substrate IDB row store. Mirrors the
// server-side SQLite store at `backend/server/src/storage/
// connection-store.ts`; both produce identical `ConnectionRow`
// shapes, projected to `ConnectionView` via contracts-side
// `connectionViewFromRow` (auth excluded).
export {
  createConnectionRowStore,
  type ConnectionRowStore,
  type ConnectionRowStoreOptions,
} from './connection-store.js';
// D-145 PB2 — RecuedPlan IR store. Persists D-120 memory entries of
// kind `recued_plan` per § B.5.3. Server-side (SQLite) primary path;
// IDB / in-memory backings used in tests. Runtime validator gate via
// `assertValidRecuedPlan` on every write. Signature path lives at
// `backend/server/src/recued-plan/signing.ts`.
export {
  createRecuedPlanStore,
  RECUED_PLAN_KIND,
  type RecuedPlanStore,
  type RecuedPlanListOptions,
} from './recued-plan.js';
// D-145 engine-wiring slice 3a — D-153 commit store. The persistence
// substrate for the atomic commit log (one tool call = one commit) +
// its crash-safe writePending → recordOutcome → sweepPendingToInDoubt
// protocol. Substrate-only — the Gateway dispatch-outbox (slice 3b) is
// the sole writer and wires this into the engine.
export {
  createCommitStore,
  type CommitStore,
  type PendingCommitInput,
  type CommitOutcome,
  type CommitOutcomeStatus,
} from './commits.js';
// D-157 P1 — preflight checkpoint store. The persistence substrate for
// a preflight-gated run's resumable state — the engine writes a
// `Checkpoint` at a policy-`ask` gate and ends the execution. Mirrors
// `CommitStore`; substrate-only — the engine pause/resume path (a later
// D-157 P1 slice) is the writer + reader.
export {
  createCheckpointStore,
  type CheckpointStore,
} from './checkpoints.js';
// D-177 P5a — the durable batch-ask store (N.10): one row per open
// (origin unit × ingredient × operation × connection) aggregation, with
// the version-guarded `open → closing → answered` lifecycle. The server
// batch-approval coordinator is the sole caller.
export {
  createBatchAskStore,
  type BatchAskCloseResult,
  type BatchAskStore,
  type NewBatchAskMember,
} from './batch-asks.js';

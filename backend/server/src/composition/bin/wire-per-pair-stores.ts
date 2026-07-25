/** Per-pair store substrate composer.
 *
 *  Materialises 19 SQLite-backed (or in-memory per-process) per-pair
 *  store handles + 8 schema-only ensures in one boot pass. Every store
 *  here is per-pair: no cross-cloud sync (D-097 / D-168), never
 *  serialised via MCP responses, never relayed by the cloud. Three
 *  concerns interleave:
 *
 *    1. **Schema ensures** — idempotent `CREATE IF NOT EXISTS` /
 *       `ALTER TABLE ADD COLUMN IF NOT EXISTS` passes. Some of these
 *       only install schema (annotation, bistemporal, link-confidence,
 *       enrichment, time-relative-watcher, reception, exposure); others
 *       are paired with a store creation below.
 *    2. **Store materialisation** — `createXxxStore(db)` (or in-memory
 *       factory) handles that downstream rpc handlers + dispatchers
 *       capture. Most stores are unconditional once `db` is present.
 *    3. **One auto-registration side-effect** — after the work-entity
 *       store materialises, `autoRegisterRecuedBuiltinSources(...)`
 *       seeds the per-kind Recued built-in Source row (idempotent
 *       against `getSource(id) !== null`). Order is load-bearing:
 *       the store must exist before the auto-register runs.
 *
 *  Gate: `db` undefined (daemon-only subcommands; dbless harness) →
 *  the entire pass is skipped and the helper returns `undefined`;
 *  caller assigns each `*Ref` to undefined (existing downstream code
 *  already handles the undefined case via optional-chain / non-null
 *  assertion / `if` gates).
 *
 *  Dynamic-import discipline preserved verbatim. Pre-extraction every
 *  store factory + schema-ensure was reached via `await import(...)`
 *  so subcommands like `pair` / `audit` / `logs` / `llm` / `archive`
 *  / `upgrade` / `unlock` / `lock` / `auth-status` (which still pass
 *  the `if (db)` gate but don't need these tables) didn't pay the
 *  factory module's import cost. The composer keeps the dynamic
 *  imports inside the same single `await` chain. */

import type Database from 'better-sqlite3';

// Static imports for schema-ensures that were already statically
// imported in bin.ts pre-extraction. Keeps the load-timing identical
// (eager-load on bin.ts import); dynamic in the composer body for
// every dependency that was already dynamic-imported in bin.ts.
import {
  ensureBistemporalSchema,
  ensureLinkConfidenceSchema,
} from '../../memory-schema.js';
import { ensureExposureSchema } from '../../exposure/sqlite-store.js';

// Type-only imports — erased at runtime, no module-evaluation cost.
import type { WorkEntityStore } from '../../storage/work-entity-store.js';
import type { S2SPreviewStore } from '../../s2s-preview/store.js';
import type { CorrectionEventsStore } from '../../storage/correction-events-store.js';
import type { PublicEndpointRegistryStore } from '../../storage/public-endpoint-registry-store.js';
import type { ReceptionRegistryCache } from '../../ports/reception/registry-cache.js';
import type { ReceptionRateLimiter } from '../../ports/reception/rate-limiter.js';
import type { PreviewHashStore } from '../../ports/reception/preview-hash.js';
import type { SchedulingFormNonceStore } from '../../ports/reception/handlers/scheduling-link.js';
import type {
  FormDefinitionStore,
  FormSubmissionStore,
} from '../../storage/reception-form-store.js';
import type { ReceptionIntakeRecipePairStore } from '../../storage/reception-intake-recipe-pair-store.js';
import type { FormResponseStore } from '../../storage/form-response-store.js';
import type { IntakeFormNonceStore } from '../../ports/reception/handlers/intake-form.js';
import type { DropBlobStore } from '../../storage/reception-drop-store.js';
import type { DropLinkNonceStore } from '../../ports/reception/handlers/drop-link.js';
import type { ApprovalIntentStore } from '../../storage/reception-approval-store.js';
import type { ApprovalLinkNonceStore } from '../../ports/reception/handlers/approval-link.js';
import type { StatusProjectionStore } from '../../storage/reception-status-projection-store.js';
import type { ReceptionIpBlockStore } from '../../storage/reception-ip-block-store.js';

export interface ComposePerPairStoresDeps {
  /** `undefined` for daemon-only subcommands (start / stop / status /
   *  restart) + dbless test harnesses. The composer short-circuits to
   *  `undefined` so the caller can assign each ref to undefined. */
  readonly db: Database.Database | undefined;
}

/** Bundle of per-pair store handles. Field names are the canonical
 *  store names (no `Ref` suffix); the caller renames to `xxxRef` at
 *  destructuring time to preserve downstream binding conventions. */
export interface PerPairStoresBundle {
  // D-145 PA2 work entity substrate.
  readonly workEntityStore: WorkEntityStore;
  // D-145 PB12 / PB14 — privacy-bound stores.
  readonly s2sPreviewStore: S2SPreviewStore;
  readonly correctionEventsStore: CorrectionEventsStore;
  // D-149 P3 reception substrate.
  readonly publicEndpointRegistryStore: PublicEndpointRegistryStore;
  readonly receptionRegistryCache: ReceptionRegistryCache;
  readonly receptionRateLimiter: ReceptionRateLimiter;
  readonly previewHashStore: PreviewHashStore;
  // D-149 P5 scheduling-link. (D-210 A.8 slice 4c retired the booking store —
  // bookings live in `intakeFormSubmissionStore`.)
  readonly schedulingFormNonceStore: SchedulingFormNonceStore;
  // D-149 P6 intake-form.
  readonly intakeFormDefinitionStore: FormDefinitionStore;
  readonly intakeRecipePairStore: ReceptionIntakeRecipePairStore;
  readonly intakeFormSubmissionStore: FormSubmissionStore;
  /** Accepted, immutable intake responses exposed as owner data. */
  readonly formResponseStore: FormResponseStore;
  readonly intakeFormNonceStore: IntakeFormNonceStore;
  // D-149 P7 drop-link.
  readonly dropBlobStore: DropBlobStore;
  readonly dropLinkNonceStore: DropLinkNonceStore;
  // D-149 P8 approval-link.
  readonly approvalIntentStore: ApprovalIntentStore;
  readonly approvalLinkNonceStore: ApprovalLinkNonceStore;
  // D-149 P9 status-link projection (reader deliberately omitted
  // until a real `data.*` warehouse reader lands).
  readonly statusProjectionStore: StatusProjectionStore;
  // D-149 P12 Abuse Inbox per-server IP block.
  readonly ipBlockStore: ReceptionIpBlockStore;
}

/** Compose every per-pair store + its prerequisite schema ensures.
 *  Returns `undefined` when `db` is absent (daemon-only subcommands /
 *  dbless harness). */
export const composePerPairStores = async (
  deps: ComposePerPairStoresDeps,
): Promise<PerPairStoresBundle | undefined> => {
  const db = deps.db;
  if (!db) return undefined;

  // Schema ensures first — the dependency direction is schema → store,
  // and several schema-ensure functions are lazy-lifted from their
  // handler modules so the boot pass stays single-pass. Order matches
  // the pre-extraction sequence verbatim.

  // Annotation schema before bistemporal so the bistemporal pass finds
  // the `annotation` + `link` tables.
  const { ensureAnnotationSchema } = await import('../../storage/annotation-store.js');
  ensureAnnotationSchema(db);

  // Bistemporal pass — `event_at` widening across annotation / link /
  // memory rows for the `data.timeline()` chronological feed (D-120
  // Phase 7.5). Static import (see header).
  ensureBistemporalSchema(db);

  // D-122 Phase 2 — `link.confidence` + `link.evidence` columns for
  // the `link-create` ingredient. Static import (see header).
  ensureLinkConfidenceSchema(db);

  // D-122 Phase 4.5 — `data_enrichment` + sidecar tables for the
  // unified enrichment substrate.
  const { ensureEnrichmentSchema } = await import('../../storage/enrichment-store.js');
  ensureEnrichmentSchema(db);

  // D-122 Phase 4.5 — time-relative-watcher state table.
  const { ensureTimeRelativeWatcherSchema } = await import(
    '../../watchers/time-relative-watcher.js'
  );
  ensureTimeRelativeWatcherSchema(db);

  // D-145 PA1 — work entity substrate tables (task / note / commitment /
  // project) + source_registry + note_access_ledger. PA2 widens this
  // step to instantiate the store + auto-register Recued built-in
  // Sources for each kind on first init.
  const { ensureWorkEntitySchema, createWorkEntityStore } = await import(
    '../../storage/work-entity-store.js'
  );
  ensureWorkEntitySchema(db);
  const workEntityStore = createWorkEntityStore(db);
  const { autoRegisterRecuedBuiltinSources } = await import(
    '../../work-entity-source-boot.js'
  );
  autoRegisterRecuedBuiltinSources(workEntityStore);

  // D-145 PB12 — Peer-Recued Preview substrate store.
  const { createS2SPreviewStore } = await import('../../s2s-preview/store.js');
  const s2sPreviewStore = createS2SPreviewStore(db);

  // D-145 PB14 — Correction Learning substrate store. Per-pair only —
  // no cross-cloud sync (D-097 / D-168); never serialized via MCP responses. The
  // engine consumption hooks (correction-learning module) thread the
  // store's `listRecent` results into the orchestrator's pre-flight /
  // threshold / AI-packet projection passes.
  const { createCorrectionEventsStore } = await import(
    '../../storage/correction-events-store.js'
  );
  const correctionEventsStore = createCorrectionEventsStore(db);

  // D-149 P1 — Reception substrate placeholder schemas (eight tables
  // landed at boot per pre-launch zero-installs rule). Per-pair only;
  // no cross-cloud sync (Must Hold I-15; D-097 / D-168). P3 fills the
  // registry + access log rpc surface; P5-P9 fill the per-kind row writers.
  const { ensureReceptionSchema } = await import('../../storage/reception-store.js');
  ensureReceptionSchema(db);

  // D-172 resumable uploads — the SHARED `upload_session` table lands at boot.
  // Generalized out of the Reception schema (rev-3 reframe): both the reception
  // drop page + the webclient Data→File view ingest through one substrate, keyed
  // by (scope_kind, scope_key). Per-pair only; no cross-cloud sync (D-097 /
  // D-168). The chunk-handler + per-consumer store instances follow in a later
  // slice — this just materializes the table.
  const { ensureUploadSessionSchema } = await import(
    '../../storage/upload-session-store.js'
  );
  ensureUploadSessionSchema(db);

  // D-149 P3 § A.3 — Reception per-pair handles. The registry store +
  // 60s-staleness cache + hybrid in-memory rate limiter + preview-hash
  // store are composed here so both the rpc surface (admin-only
  // mutations through ws) and the visitor path-router dispatch
  // (anonymous-traffic listener) share the same in-process instances.
  // `reload` re-hydrates the rate limiter from the SQLite snapshot so
  // per-day caps survive process restarts.
  const { createPublicEndpointRegistryStore } = await import(
    '../../storage/public-endpoint-registry-store.js'
  );
  const publicEndpointRegistryStore = createPublicEndpointRegistryStore(db);
  const { createReceptionRegistryCache } = await import(
    '../../ports/reception/registry-cache.js'
  );
  const receptionRegistryCache = createReceptionRegistryCache();
  const { createReceptionRateLimiter } = await import(
    '../../ports/reception/rate-limiter.js'
  );
  const receptionRateLimiter = createReceptionRateLimiter({ db });
  receptionRateLimiter.reload(Date.now());
  const { createPreviewHashStore } = await import(
    '../../ports/reception/preview-hash.js'
  );
  const previewHashStore = createPreviewHashStore();

  // D-149 P5 § A.5.2 — scheduling form-nonce store, guarding POST `/book`
  // against stale/duplicate submissions (single-use per § Must Hold I-12b).
  // Per-pair — no cross-cloud sync (D-097 / D-168).
  //
  // D-210 A.8 slice 4c — the booking-request store that stood beside it is
  // GONE. Bookings are `reception_form_submission` rows (`intakeFormSubmissionStore`
  // below is the one store both flows write), so its `reception_booking_request`
  // table was dropped along with the booking-PII key stream that sealed its
  // columns.
  const { createInMemorySchedulingFormNonceStore } = await import(
    '../../ports/reception/handlers/scheduling-link.js'
  );
  const schedulingFormNonceStore = createInMemorySchedulingFormNonceStore();

  // D-149 P6 § A.5.3 — intake_form definition + submission stores +
  // in-memory form-nonce store. D-200 adds the compact endpoint/recipe pair
  // registry between those source and submission stores. The definition store
  // backs admin-side CRUD (Settings → Reception → Intake forms) + the GET
  // handler's schema load; the submission store persists visitor POST rows;
  // the nonce store guards POST against stale / duplicate submissions. All
  // four stay per-pair — no cross-cloud sync (D-097 / D-168). Form-PII key
  // wires inside the `keys` branch alongside the booking-PII key derivation.
  const { createReceptionFormDefinitionStore, createReceptionFormSubmissionStore } =
    await import('../../storage/reception-form-store.js');
  const intakeFormDefinitionStore = createReceptionFormDefinitionStore(db);
  const { createReceptionIntakeRecipePairStore } = await import(
    '../../storage/reception-intake-recipe-pair-store.js'
  );
  const intakeRecipePairStore = createReceptionIntakeRecipePairStore(db);
  const intakeFormSubmissionStore = createReceptionFormSubmissionStore(db);
  // Accepted form responses are a canonical data collection, not another
  // Reception queue table. The factory owns its idempotent schema ensure.
  const { createFormResponseStore } = await import(
    '../../storage/form-response-store.js'
  );
  const formResponseStore = createFormResponseStore(db);
  const { createInMemoryIntakeFormNonceStore } = await import(
    '../../ports/reception/handlers/intake-form.js'
  );
  const intakeFormNonceStore = createInMemoryIntakeFormNonceStore();

  // D-149 P7 § A.5.4 — drop_link blob metadata store + in-memory
  // form-nonce store. The metadata store persists
  // `reception_drop_blob_metadata` rows; the nonce store guards POST
  // upload against stale / duplicate submissions. Both stay per-pair
  // — no cross-cloud sync (D-097 / D-168). Drop-PII key + drop_blobs
  // filesystem root wire inside the `keys` branch.
  const { createReceptionDropBlobStore } = await import(
    '../../storage/reception-drop-store.js'
  );
  const dropBlobStore = createReceptionDropBlobStore(db);
  const { createInMemoryDropLinkNonceStore } = await import(
    '../../ports/reception/handlers/drop-link.js'
  );
  const dropLinkNonceStore = createInMemoryDropLinkNonceStore();

  // D-149 P8 § A.5.5 — approval_link intent store + in-memory form-
  // nonce store. The intent store persists `reception_approval_intent`
  // rows; the nonce store guards POST consume against stale /
  // duplicate submissions. Both stay per-pair — no cross-cloud sync
  // (D-097 / D-168). Approval-PII key wires inside the `keys` branch.
  const { createReceptionApprovalIntentStore } = await import(
    '../../storage/reception-approval-store.js'
  );
  const approvalIntentStore = createReceptionApprovalIntentStore(db);
  const { createInMemoryApprovalLinkNonceStore } = await import(
    '../../ports/reception/handlers/approval-link.js'
  );
  const approvalLinkNonceStore = createInMemoryApprovalLinkNonceStore();

  // D-149 P9 § A.5.6 — status_link projection store. Wired at boot so
  // the rpc `endpoint.create` flow can seed the per-endpoint projection
  // row. The companion `StatusEntitySourceReader` is intentionally NOT
  // wired here (Codex review P1 fold, 2026-05-13): pre-fold bin.ts
  // shipped `NULL_STATUS_ENTITY_SOURCE_READER` which made
  // `statusLinkReady` true in the dispatcher + always returned the
  // placeholder via the live handler. Until a `data.*` warehouse reader
  // is wired we omit the reader dep entirely so the dispatcher falls
  // back to the kind-registry 503 stub (matching the `not_configured`
  // posture the other partially-wired kinds use). A downstream phase
  // will wire the real reader + flip the kind live.
  const { createReceptionStatusProjectionStore } = await import(
    '../../storage/reception-status-projection-store.js'
  );
  const statusProjectionStore = createReceptionStatusProjectionStore(db);

  // D-149 P12 § A.20.5 — Abuse Inbox IP block store over the tenth
  // Reception table (`reception_ip_block_list`, materialised by
  // `ensureReceptionSchema` above). Unlike the deferred status-link
  // reader, this store has no external dependency — it is wired
  // immediately so the rpc trio + the listener block check are both
  // live from boot.
  const { createReceptionIpBlockStore } = await import(
    '../../storage/reception-ip-block-store.js'
  );
  const ipBlockStore = createReceptionIpBlockStore(db);

  // D-137 chat substrate schemas now ensured inside
  // `composeChatOrchestrator` (round-2 extraction). No prior bin.ts
  // call site reads those tables, so the helper's per-compose ensures
  // are the single source of truth.

  // D-148 W3.9 — Exposure state singleton (per-path resolution + ack +
  // last-changed metadata). Per-pair only; no cross-cloud sync (D-097 / D-168).
  // Promotes the W3.5 in-memory store so Mary's preset choices survive
  // restart. First-boot loads return null + the state machine seeds
  // from `DEFAULT_EXPOSURE_STATE`; the bootstrap-derived initial state
  // is applied as the first `save()` via `reapply()` in cmdServe.
  // Static import (see header).
  ensureExposureSchema(db);

  return {
    workEntityStore,
    s2sPreviewStore,
    correctionEventsStore,
    publicEndpointRegistryStore,
    receptionRegistryCache,
    receptionRateLimiter,
    previewHashStore,
    schedulingFormNonceStore,
    intakeFormDefinitionStore,
    intakeRecipePairStore,
    intakeFormSubmissionStore,
    formResponseStore,
    intakeFormNonceStore,
    dropBlobStore,
    dropLinkNonceStore,
    approvalIntentStore,
    approvalLinkNonceStore,
    statusProjectionStore,
    ipBlockStore,
  };
};

/** Round 5 / executorConfig surgical extraction — boot composer for
 *  the `ServerExecutorConfig` object literal.
 *
 *  The pre-extraction site was a single 362-LOC object literal in
 *  `bin.ts` with two async IIFEs (for the `connection.api` /
 *  `connection.mcp` sub-deps) and a 250-line `kernelDispatchers`
 *  sub-literal whose 12+ closures fire at recipe-execute time. The
 *  helper preserves the literal verbatim — every closure, every
 *  conditional spread, every dynamic `await import(...)` — and folds
 *  the IO-only knobs (manifests, vault, llmConfig, etc.) into a
 *  typed deps shape.
 *
 *  Late-bound semantics. Every late-or-conditional ref (`housekeepingState`,
 *  `engagementRateControlStore`, `auditLog`, `connectionStore`, …)
 *  is assigned BEFORE this helper runs at boot, so direct-value
 *  capture preserves the original semantics (the closures dereference
 *  the captured value per-call, same as today).
 *
 *  Failure-graceful posture preserved field-by-field — every closure's
 *  pre-extraction graceful-degradation comment moves with the closure.
 */

import type Database from 'better-sqlite3';
import type { AuditLogStore } from '@recued/storage';
import { IngredientError } from '@recued/ingredients';
// D-207 slice 3d — the general no-resend fence.
import {
  contractPermitsDoorType,
  isContractActive,
  isMailSendClaimSettled,
  mailSentReconciliationQueryFor,
  toPublicSellerTier,
  type ConnectionHealth,
  deriveExchangeStatus,
} from '@recued/contracts';
import { createMailSendClaimStore } from '../../storage/mail-send-claim-store.js';
import { raiseMailSendOutcomeAsk } from '../../mail-send-outcome-ask.js';
import type { MailSentReconciliationResult } from '../../collections/mail/provider.js';
import type {
  ConnectionApiHandlerDeps,
  ConnectionMcpHandlerDeps,
  ConnectionNotificationHandlerDeps,
  KernelDispatchers,
} from '@recued/ingredients';
import type { CacheStore } from '@recued/cache';
import type { PiiKnownValueSource } from '@recued/transforms';
import type {
  LLMConfig,
  QuotaTracker,
} from '@recued/llm';
import type { LLMConfigManager } from '../../llm-config.js';
import type { KeyManager } from '../../key-manager.js';
import type { ServerExecutorConfig } from '../../server-executor.js';
import { createRunTokenUsageSink, type RunTokenUsageSink } from '../../run-token-usage.js';
import { createRunKnownValues } from '../../run-known-values.js';
import type { ConnectionStoreSqlite } from '../../storage/connection-store.js';
import type { SharedStore } from '../../storage/shared-store.js';
import type { BlobStore } from '../../storage/blob-store.js';
import type { EnrichmentStore } from '../../storage/enrichment-store.js';
import type { CascadeEngine } from '../../storage/enrichment-cascade.js';
import type { AnnotationStore } from '../../storage/annotation-store.js';
import type { ContactStore } from '../../storage/contact-store.js';
import type { CrmRecordMirrorStore } from '../../storage/crm-record-mirror-store.js';
import type {
  ContactBusinessContextCalendarReader,
  ContactBusinessContextCrmSource,
} from '../../contact-business-context.js';
import type { GatedReadGrantResolver } from '../../read-grant-checker.js';
import type { CollectionRegistry } from '../../collections/registry.js';
import type { MailCollection } from '../../collections/mail/mail-collection.js';
import type { FileStack } from '../../collections/file/compose.js';
import type { RemoteFileReadDeps } from '../../collections/file/remote-file-byte-resolver.js';
import type { CalendarStack } from '../../collections/calendar/compose.js';
import type { ServiceStack } from '../../collections/service/compose.js';
import type { AnnotationRpcDeps } from '../../annotation-handler.js';
import type {
  NotificationChannel,
  NotificationChannelDispatcher,
} from '../../notification-handler.js';
import type { HousekeepingStateStore } from '../../housekeeping/index.js';
import type { EngagementRateControlStore } from '../../storage/engagement-rate-control-store.js';
import type { ConnectionLookup } from '../../housekeeping/reconciliation/vendor-reconciler.js';
import type { createWorkEntityDispatchers } from '../../work-entity-ingredients.js';
import type { createWatcherDispatcher } from '../../watchers/index.js';
import type { ManifestRegistry } from '../../manifest-loader.js';
import type { BridgeDispatcher } from '../../bridges/dispatcher.js';
import type { ContactRpcDeps } from '../../contact-handler.js';
import type { ReceptionProjectionWorkEntityStore } from '../../ports/reception/projection/reception-projection.js';

import type { WorkEntityStore } from '../../storage/work-entity-store.js';
import type { PublicEndpointRegistryStore } from '../../storage/public-endpoint-registry-store.js';
import type { ReceptionSealedVisitorEmailResolver } from '../../ports/reception/projection/reception-sealed-visitor-email.js';
import type { ChatInboundTokenStore } from '../../storage/chat-inbound-token-store.js';
import type { ContractStore } from '../../storage/contract-store.js';
import { createContractDefinitionStore } from '../../storage/contract-definition-store.js';
import type { SellerClaimStore } from '../../storage/seller-claim-store.js';
import { type SellerStore } from '../../storage/seller-store.js';
import type { SellerOrderStore } from '../../storage/seller-order-store.js';
import type { FormResponseStore } from '../../storage/form-response-store.js';
import type { MailFactStore } from '../../storage/mail-fact-store.js';
import type { FormSubmissionStore } from '../../storage/reception-form-store.js';
import type { ScopedWebhookEventReader } from '../../webhook-recipe-consumer.js';
import { makeConnectionRuntimeBaseIssueSink } from '../../connection-runtime-base-issue.js';
import { makeConnectionCredentialPersistFailureSink } from '../../connection-credential-persist-failure.js';

/** Inline type alias matching the pre-extraction
 *  `ReturnType<typeof createWorkEntityDispatchers>` shape that bin.ts
 *  already uses at the call site. The dispatcher module exports the
 *  factory but not the shape directly, so the helper mirrors bin.ts's
 *  derived-type idiom. */
type WorkEntityDispatchers = ReturnType<typeof createWorkEntityDispatchers>;


/** Inputs to compose the executor config. Every field's shape matches
 *  the corresponding `let` / `const` binding in `bin.ts` at the
 *  pre-extraction call site (line 2049). The helper writes each one
 *  into the same key on `ServerExecutorConfig` (or into a
 *  `kernelDispatchers` closure for the lazy-resolution paths).
 *
 *  Required vs `T | undefined` follows the pre-extraction posture:
 *  fields used UNCONDITIONALLY in the literal (`manifests`, `vault`,
 *  `llmQuota`, `cacheStore`, `serverInstanceId`, `watcherDispatcher`,
 *  `collectionRegistry`) are required; everything that participates in
 *  a conditional spread or whose closure reads it through a truthy
 *  guard is optional. */
export interface ComposeExecutorConfigDeps {
  manifests: ManifestRegistry;
  baseVault: Record<string, unknown>;
  llmQuota: QuotaTracker;
  /** Optional cache store. Pre-extraction `bin.ts` declared this
   *  `CacheStore | undefined` and passed it through to the literal's
   *  `cacheStore` field (which is itself optional on
   *  `ServerExecutorConfig`). The helper preserves that shape so a
   *  dbless / no-cache harness still composes a valid config. */
  cacheStore: CacheStore | undefined;
  /** L1-cache content-addressed blob store — the same handle the mail
   *  collection spills >64 KB bodies to. Threaded so the kernel
   *  `mail-body-read` dispatcher can hydrate CAS-spilled bodies.
   *  Undefined in dbless / no-cache harnesses (gated on `db` at the
   *  serve composition); the dispatcher then stays unwired and the
   *  ingredient surfaces `SERVER_NOT_REACHABLE`. */
  cacheBlobs: BlobStore | undefined;
  /** D-216 — read CAS bytes for a `file_ref` so a `connection.api` op that
   *  declares `bind.upload` can send the FILE rather than a reference. The
   *  SAME reader the cli `input_materialize` path uses (`wire-execute-deps`
   *  builds it from the inbound file collection); threaded here because the
   *  api handler is composed on this side.
   *
   *  Undefined ⇒ an upload op fails CLOSED with `SERVER_NOT_REACHABLE` — the
   *  standalone MCP boot composes no file-source stores, and silently
   *  sending an empty body would be worse than refusing. */
  readFileBytes?: ((record_id: string) => Promise<{
    bytes: Uint8Array;
    mime_type: string;
    filename: string;
  }>) | undefined;
  /** D-217 slice 2b-ii — read ONE chunk of a staged plaintext for a chunked
   *  upload's APPEND. Deliberately NOT `readFileBytes`: that returns the whole
   *  file, and calling it per chunk would decrypt a 512 MB blob once per
   *  request. The engine stages once (`ExecutionContext.uploadStaging`) and the
   *  wire carries the resulting token, which this resolves against the SAME
   *  registry.
   *
   *  Undefined ⇒ a chunked upload fails CLOSED with `SERVER_NOT_REACHABLE`,
   *  matching the `readFileBytes` posture — a boot with no file-source stores
   *  must refuse rather than send an empty body. */
  readUploadChunk?: ((token: string, offset: number, length: number) => Promise<{
    bytes: Uint8Array;
    mime_type: string;
  }>) | undefined;
  /** D-192 remote byte-fetch — the shared `remote` bundle so a `file:remote:*`
   *  id passed to the recipe `data-file-read` ingredient (and, through it, an
   *  `ai-*` multimodal `llm.data` file-ref, which reads via the SAME dispatcher)
   *  lazily fetches the mirrored vendor's bytes instead of `file_remote_unsupported`.
   *  Read lazily; undefined ⇒ a remote id 501s (the pre-byte-fetch posture — e.g.
   *  the standalone MCP boot, which composes no file-source stores). */
  getRemoteFileReadDeps?: (() => RemoteFileReadDeps | undefined) | undefined;
  serverInstanceId: string;
  watcherDispatcher: ReturnType<typeof createWatcherDispatcher>;
  collectionRegistry: CollectionRegistry;
  /** Core Seller substrate. The Seller offer registry needs this store alone;
   *  the D-196 customer-access lifecycle group additionally requires the
   *  contract and inbound-token stores below. Missing dependencies leave only
   *  their corresponding adapter slots unavailable. */
  sellerStore: SellerStore | undefined;
  /** D-207 §4.3 — the order (money) leg. */
  sellerOrderStore: SellerOrderStore | undefined;
  contractStore: ContractStore | undefined;
  inboundTokenStore: ChatInboundTokenStore | undefined;
  /** Revokes outstanding one-time claims when provider/kernel lifecycle closes
   *  a customer and seals the bearer on first issue. */
  sellerClaimStore?: SellerClaimStore | undefined;
  /** Authoritative public Reception origin for kernel-issued customer claims.
   *  Read lazily so non-issuing lifecycle operations remain available on a
   *  local-only deployment. */
  getSellerPublicBaseUrl?: (() => string) | undefined;

  llmConfig: LLMConfig | undefined;
  /** D-174 R28 — per-use LIVE config resolver from the LLM substrate. Threaded
   *  onto `ServerExecutorConfig.resolveLlmConfig` so the AI adapter reads config
   *  at call time (chat + embeddings apply without a restart). */
  resolveLlmConfig: (() => LLMConfig | undefined) | undefined;
  llmManager: LLMConfigManager | undefined;
  /** D-250 § D — run-scoped provider-usage accumulator behind
   *  `AuditEntry.total_usage`. OPTIONAL, for tests that need to inspect what
   *  the adapter recorded; production leaves it unset and takes the default
   *  built below.
   *
   *  ⛔ THE DEFAULT IS BUILT ONCE PER CONFIG ON PURPOSE. The AI adapter records
   *  into the sink hanging off this config and the execute handler claims from
   *  `deps.executorConfig.runTokenUsage` — the same object — so one config
   *  cannot hold a writer and a reader that disagree. Passing the sink in from
   *  two call sites instead would make that a convention two callers have to
   *  keep, and getting it wrong yields a field permanently absent with nothing
   *  failing anywhere. */
  runTokenUsage?: RunTokenUsageSink | undefined;
  /** D-316 amendment — the chat's whole-warehouse known-value matcher for a
   *  recipe's `content` PII tags. Forwarded onto `ServerExecutorConfig`, where
   *  the AI adapter, the preapproval review and the execute handler all read the
   *  SAME one. Absent ⇒ `content` tags hide only what identifier tags seeded. */
  piiKnownValues?: (() => PiiKnownValueSource | undefined) | undefined;
  connectionStore: ConnectionStoreSqlite | undefined;
  /** D-234 § 234.4 — LATE BINDING for the inbound peer door. The notification
   *  block lands on `executeDeps.preflightNotifier`, which is composed AFTER
   *  this config, so a kernel dispatcher cannot capture it at construction. Same
   *  seam the container-pick and saga wirings use for the same reason. Absent ⇒
   *  the door refuses rather than raising nothing silently. */
  getExecuteDeps?: () => { preflightNotifier?: unknown; auditLog?: unknown;
    mailDraft?: import('../../execute-handler.js').ExecuteHandlerDeps['mailDraft'];
    mailDraftSaveToMailbox?: import('../../execute-handler.js').ExecuteHandlerDeps['mailDraftSaveToMailbox'];
    preapprovalRequest?: import('../../execute-handler.js').ExecuteHandlerDeps['preapprovalRequest'] } | undefined;
  auditLog: AuditLogStore | undefined;
  keys: KeyManager | undefined;
  connectionNotificationDeps: ConnectionNotificationHandlerDeps | undefined;
  fileStack: FileStack | undefined;
  calendarStack: CalendarStack | undefined;
  serviceStack: ServiceStack | undefined;
  sharedStore: SharedStore | undefined;
  /** Intake responses are reachable by recipes only through the owner-only
   *  `form-response-list/get` reads and `form-response-set-state` lifecycle write
   *  kernel operations. Undefined in runtimes without the canonical
   *  FormResponse store, leaving all of those dispatchers absent so the adapter fails
   *  closed with SERVER_NOT_REACHABLE. */
  formResponseStore:
    | Pick<FormResponseStore, 'findById' | 'list' | 'setLifecycleState'>
    | undefined;
  /** D-315 — mail facts, read by recipes through `mail-fact-get` /
   *  `mail-fact-list` (dispatch scope `data.mail`). Undefined in runtimes
   *  without the store, leaving both dispatchers absent so the adapter fails
   *  closed with SERVER_NOT_REACHABLE. */
  mailFactStore: MailFactStore | undefined;
  /** D-210 Phase C (§4b) — the intake submission store, for the
   *  RESOLVED-POINTER WRITE-BACK on the approve-resume leg.
   *
   *  ⛔ FIXES A LIVE BUG. `reception_form_submission` carries
   *  `resolved_target_kind` / `resolved_target_id`, and
   *  `reception.record.list` reads them to compute a record's `resolved`
   *  pointer — the middle link of the display chain
   *  `record → resolved pointer → destination → data.timeline(id)`. Only
   *  the AUTO-ACCEPT branch ever wrote them. The review path deliberately
   *  leaves them null ("nothing is materialized until the user approves")
   *  and NOTHING wrote them back when the approval actually materialized
   *  the destination — so every reviewed intake read as UNRESOLVED
   *  forever, even with its task / note / calendar event sitting right
   *  there. Retiring auto-accept would make the column permanently dead,
   *  because it would remove the last writer.
   *
   *  Absent ⇒ no write-back (the materialize still succeeds). */
  intakeFormSubmissionStore?: Pick<FormSubmissionStore, 'markProcessed'>;
  /** D-201 Slice 4 — active-run/binding-scoped decoded event reader. Optional
   * because dbless/CLI harnesses do not compose the ingress substrate. */
  webhookEventReader?: ScopedWebhookEventReader | undefined;
  contactStore: ContactStore | undefined;
  /** Optional existing-store readers for the zero-AI contact relationship
   * projection. The dispatcher is present whenever the ordinary ContactStore
   * or this narrower contact reader is present; missing family stores surface
   * as explicit unavailable coverage. */
  businessContextWorkEntityStore?: Pick<
    WorkEntityStore,
    'summarizeContactRelationships' | 'listSources'
  > | undefined;
  businessContextContactStore?: Pick<
    ContactStore,
    'resolveCanonicalEmail' | 'get' | 'addressSet' | 'countCompanyPeers'
  > | undefined;
  businessContextCrmMirrorStore?: Pick<CrmRecordMirrorStore, 'listByRef' | 'list'> | undefined;
  /** Optional table-only calendar reader for runtimes (notably stdio MCP) that
   * intentionally do not compose a provider-owning CalendarStack. */
  businessContextCalendars?: ContactBusinessContextCalendarReader | undefined;
  getBoundCrmSources?: (() => readonly ContactBusinessContextCrmSource[]) | undefined;
  annotationDeps: AnnotationRpcDeps | undefined;
  db: Database.Database | undefined;
  annotationStore: AnnotationStore | undefined;
  enrichmentStore: EnrichmentStore | undefined;
  /** D-239 — the enrichment cascade engine, for the mail write-back's
   *  delete path. Distinct from `enrichmentStore` above: the store holds
   *  the rows, the cascade decides what a source delete does to the rows
   *  that DEPEND on them (`dependent` policies delete, `aggregate` ones
   *  mark for recompute). Optional in the same way `annotationStore` is —
   *  a dbless / MCP-only boot composes neither, and a mail delete there
   *  removes the row with nothing downstream to clean up. */
  enrichmentCascade:
    | Pick<CascadeEngine, 'cascadeForSourceDelete'>
    | undefined;
  /** D-187 AMENDMENT — the per-(bound contract) read-grant resolver, for the
   *  recipe-channel enrichment-list + timeline-read dispatchers' read-grant resolution.
   *  Constructed once at the serve/cli composition site over the real contract store;
   *  `undefined` ⇒ the author-default checker (registry defaults). */
  readGrantResolver: GatedReadGrantResolver | undefined;
  notificationChannelDispatchers:
    | Record<NotificationChannel, NotificationChannelDispatcher>
    | undefined;
  housekeepingState: HousekeepingStateStore | undefined;
  engagementRateControlStore: EngagementRateControlStore | undefined;
  workEntityDispatchers: WorkEntityDispatchers | undefined;
  /** D-173 P1-dispatch — the per-pair work-entity store the reception
   *  projection materialises task / note / commitment / project through (the
   *  destination Source by `top_tier_kind`). Together with the canonical
   *  FormResponse store, it backs the `receptionMaterialize`
   *  kernel dispatcher (the LOCAL dispatch target the catalog gateway routes a
   *  reception op's `materialize` to on approve-resume — D-173 I-2). Absent
   *  (dbless harness) → the dispatcher stays unwired and the kernel adapter
   *  surfaces `SERVER_NOT_REACHABLE` for `reception-materialize`. This is the
   *  SAME store `composeReceptionInboxDeps` (R2 INT-3) binds its
   *  `projectReception` effect over, so the gate-held op and the inbox-side
   *  effect materialise identically. */
  receptionProjectionWorkEntityStore: ReceptionProjectionWorkEntityStore | undefined;
  /** D-173 P1-dispatch — the `contact.upsert` path the reception projection's
   *  `contact`-kind branch writes through (NOT a Source). Present only when a
   *  contact-kind reception can run; a contact projection without it
   *  fail-closes inside `runReceptionProjection`. */
  receptionProjectionContactDeps: ContactRpcDeps | undefined;
  /** D-210 — the merged sealed scheduling-submission store. The booking mint
   *  opens it server-side for the original slot and visitor provenance, then
   *  verifies the caller-bound request/booking pair before writing. */
  receptionProjectionBookingStore: FormSubmissionStore | undefined;
  /** D-210 WS3 — the `contact` branch's sealed-visitor-email resolver. An
   *  INTAKE targeting a contact carries no email in its held payload; the
   *  projection resolves it server-side from the submission id in provenance.
   *  Absent ⇒ an intake→contact projection fail-closes inside
   *  `runReceptionProjection` (never an unkeyed identity write). */
  resolveSealedVisitorEmail: ReceptionSealedVisitorEmailResolver | undefined;
  /** D-210 A.2 / slice 3b — the booking-entity store the SCHEDULING projection
   *  branch writes through. `readBooking` is the I-4 anchor read (the row the
   *  mint would write), `writeBooking` the materialization itself.
   *
   *  ⚠ The reasoning here INVERTED in 3b and the old note read the other way:
   *  it said this must not fold into `receptionProjectionWorkEntityStore`
   *  because "the projection does not project bookings — a booking is a
   *  COMPANION to the calendar event, not an alternative destination". A.2 made
   *  a booking exactly that: the destination, with no event beside it. It stays
   *  separate now for a different and narrower reason — the scheduling branch
   *  needs the sealed-row opens that the generic work-entity arm must not have.
   *
   *  Absent ⇒ a reservation projection fail-closes (never a silent drop). */
  receptionBookingMintStore?: Pick<WorkEntityStore, 'writeBooking' | 'readBooking'> | undefined;
  /** D-210 slice 3 — the endpoint registry, read by the mint for the endpoint's
   *  owner-authored `display_name` (the booking's title). Absent ⇒ the generic
   *  fallback title; never the drain's visitor-name-carrying statement. */
  receptionEndpointRegistryStore?:
    | Pick<PublicEndpointRegistryStore, 'findById'>
    | undefined;

  /** D-210 §7 — derive the booking-PII AEAD key from the reception sub-DEK,
   *  for the `notify-booking-visitor` dispatcher's server-side open of the
   *  sealed `visitor_email`. THROWS when the FileVault is locked (mirrors
   *  `wire-reception-substrate.ts`'s `getSchedulingBookingPiiKey`). Optional
   *  (unlike the booking store above) because the dispatcher self-guards on
   *  all three deps — absent ⇒ `notify-booking-visitor` stays unwired. */
  // ⚠ RENAMED with the table: the booking blob seals under the FORM key now
  // (`booking-blob.ts`). Keeping the old name would have left a seam whose
  // name no longer describes what it hands back.
  getFormSubmissionPiiKey?: (() => Uint8Array) | undefined;

  /** D-169 P0 follow-on — late-bound bridge dispatcher accessor.
   *  Threads onto `ServerExecutorConfig.bridgeDispatcherRef` so the
   *  executor's DOM adapter materialises when the boot site publishes
   *  the live dispatcher (after `createWebSocketUpgrade` returns).
   *  Optional — when omitted the dom adapter slot falls through to the
   *  registry's `unsupported('dom', ...)` placeholder. */
  getBridgeDispatcher?: () => BridgeDispatcher | undefined;
}

/** Build the OAuth2-refresh write-back callback shared by the `connection.api`
 *  + `connection.mcp` handler deps. Both feed the SAME `createEnsureFreshAuth`
 *  gate, so a rotated token must persist identically regardless of kind. Re-encodes
 *  via the `connection` sub-DEK used at enrollment and upserts the row,
 *  PRESERVING `subresource_path` — a 401-triggered refresh must never reset the
 *  sub-resource scope to NULL (a silent permission-boundary widening; D-165
 *  P3.path-picker). Single source so that invariant can't drift between kinds. */
type EncodeAuthForStorage = (typeof import('../../connection-handler.js'))['encodeAuthForStorage'];

const makeRefreshPersistAuth = (
  connectionStore: ConnectionStoreSqlite,
  encodeAuthForStorage: EncodeAuthForStorage,
  keyProvider: Parameters<EncodeAuthForStorage>[2],
): ConnectionApiHandlerDeps['persistAuth'] =>
  async (row, newAuth, configPatch) => {
    const auth_ciphertext = await encodeAuthForStorage(
      newAuth,
      { kind: row.kind, name: row.name },
      keyProvider,
    );
    if (connectionStore.persistRefreshedAuth) {
      if (!connectionStore.persistRefreshedAuth(row, auth_ciphertext, Date.now(), configPatch)) {
        throw new Error('The connection changed during credential refresh.');
      }
      return;
    }
    let config_json = row.config_json;
    if (configPatch !== undefined) {
      const parsed: unknown = JSON.parse(row.config_json);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`connection '${row.name}' has malformed config_json`);
      }
      config_json = JSON.stringify({
        ...(parsed as Record<string, unknown>),
        base_url: configPatch.base_url,
      });
    }
    connectionStore.upsert({
      kind: row.kind,
      name: row.name,
      ...(row.subtype !== undefined ? { subtype: row.subtype } : {}),
      display_name: row.display_name,
      ...(row.publisher_id !== undefined ? { publisher_id: row.publisher_id } : {}),
      config_json,
      auth_ciphertext,
      enrolled_at: row.enrolled_at,
      updated_at: Date.now(),
      ...(row.last_used_at !== undefined ? { last_used_at: row.last_used_at } : {}),
      ...(row.health_json !== undefined ? { health_json: row.health_json } : {}),
      ...(row.subresource_path !== undefined ? { subresource_path: row.subresource_path } : {}),
      // granted-scopes — preserve the vendor-granted coverage set across a
      // 401-triggered refresh restamp, same invariant as subresource_path:
      // dropping it wipes the set to NULL → pack-readiness false-negative.
      ...(row.granted_scopes_json !== undefined ? { granted_scopes_json: row.granted_scopes_json } : {}),
    });
  };

/** Compose the executor config. Async because the
 *  `connection.api` / `connection.mcp` IIFEs `await import(...)` the
 *  connection-handler module verbatim (pre-extraction did the same at
 *  the top-level `await`-allowed module scope of `bin.ts`). The
 *  caller in `bin.ts` invokes via `await composeExecutorConfig(...)`. */
/** D-244 — the dep bundle both csv kernel ops take.
 *
 *  🔑 The READ is the same one `markdownTemplateRender` uses, deliberately: a
 *  stored file should have one gated read path, not one per consumer. The INGEST
 *  mirrors `file-persist`'s keying — the discriminator is the CONTENT hash
 *  rather than the filename, so two different filters over one sheet never
 *  collide on a record and an identical re-filter stays idempotent. */
const csvFileDeps = async (
  deps: ComposeExecutorConfigDeps,
  run_id?: string,
  step_id?: string,
): Promise<import('../../collections/file/csv-filter-handler.js').CsvFilterDeps> => {
  const { handleFileRead } = await import('../../collections/file/file-read-handler.js');
  const { createHash } = await import('node:crypto');
  const remote = deps.getRemoteFileReadDeps?.();
  const stack = deps.fileStack;
  return {
    reader: {
      readFile: (readInput) => handleFileRead(
        {
          registry: deps.collectionRegistry,
          blobs: deps.cacheBlobs!,
          ...(deps.auditLog ? { auditLog: deps.auditLog } : {}),
          ...(remote ? { remote } : {}),
        },
        readInput,
      ),
    },
    // D-245 — the `{slug, path}` address. ⛔ NEVER WIRED UNTIL 2026-09-23: the
    // handler took an optional `instanceReader`, only its tests supplied one, and
    // every named-file CSV op on a real server failed "needs a paired server" —
    // `search-spreadsheet-onedrive` searches its named cache, so its search step
    // could not succeed. The read is `core.storage.file.read`'s own (the file
    // stack's live adapter, under the instance's read capability), wrapped inside
    // the CSV op: the recipe needs no file-read step and no second grant. What it
    // does face is the `data.file` fence, which `deriveDispatchScope` now applies
    // to the CSV ops as it does to `file.read`.
    ...(stack
      ? { instanceReader: { readInstanceFile: (where) => stack.kernelDispatchers.fileRead(where) } }
      : {}),
    ingest: async ({ bytes, filename, mime_type }) => {
      const collection = deps.collectionRegistry.get('file', 'received') as
        | { ingest?: (i: Record<string, unknown>) => Promise<{ record_id: string }> }
        | undefined;
      if (!collection || typeof collection.ingest !== 'function') {
        throw new Error('csv-filter: data.file.received collection is not registered');
      }
      const content_hash = createHash('sha256').update(bytes).digest('hex');
      const record = await collection.ingest({
        bytes,
        filename,
        mime_type,
        content_hash,
        origin: 'tool_output',
        source_id: `${run_id ?? 'csv'}:${step_id ?? 'filter'}:${content_hash}`,
      });
      return { record_id: record.record_id };
    },
  };
};

export const composeExecutorConfig = async (
  deps: ComposeExecutorConfigDeps,
): Promise<ServerExecutorConfig> => {
  // D-187 AMENDMENT — the per-(bound contract) read-grant resolver for the
  // recipe-channel enrichment-list + timeline-read dispatchers (threaded from the real
  // contract store at the serve/cli composition site). It gates to standing policy
  // contracts (active, non-grant) before honouring grant rows — the SAME gate the
  // overlay applies for the native tools. The dispatchers resolve against the enclosing
  // recipe's bound contract (the per-dispatch `origin_contract_id`); absent / a grant
  // id ⇒ the author-default checker (registry defaults).
  const readGrantResolver = deps.readGrantResolver;

  /** D-239 — deps for the mail write-back dispatcher.
   *
   *  The interesting member is `deleteLocalRecord`, which delegates to
   *  `handleCollectionDeleteRecord` — the SAME function backing the
   *  `collection.deleteRecord` rpc. That reuse is not tidiness, it is the
   *  fix for a specific hole: `bridgeEnrichmentCascade` filters `deleted`
   *  warehouse events to calendar + platform-reference scopes, so a mail
   *  delete that merely dropped the row and emitted an event would run NO
   *  cascade at all and leave every enrichment + annotation keyed to that
   *  message pointing at nothing. The rpc handler already fires both
   *  cascades; routing through it means the write-back and the rpc can
   *  never drift on what "delete a mail record" cleans up. */
  const mailDispatcherDeps = () => ({
    registry: deps.collectionRegistry,
    deleteLocalRecord: async (slug: string, record_id: string): Promise<void> => {
      const { handleCollectionDeleteRecord } = await import(
        '../../collections/collection-handler.js'
      );
      await handleCollectionDeleteRecord(
        {
          registry: deps.collectionRegistry,
          ...(deps.annotationStore
            ? {
                annotationCascade: (col: string, id: string) =>
                  deps.annotationStore!.cascadeDelete(col, id),
              }
            : {}),
          ...(deps.enrichmentCascade
            ? {
                enrichmentCascadeOnDelete: (scope, id) =>
                  deps.enrichmentCascade!.cascadeForSourceDelete(scope, id),
              }
            : {}),
        },
        { platform: 'mail', slug, record_id },
      );
    },
  });

  const createCustomerAccessLifecycle = async () => {
    if (!deps.sellerStore || !deps.contractStore || !deps.inboundTokenStore) {
      throw new Error('customer-access unavailable — seller lifecycle stores are not wired');
    }
    const [
      { createSellerCustomerAccessLifecycle },
      {
        createSellerCustomerClaimSupport,
        deliverSellerCustomerClaimEmail,
        readSellerCustomerAfterClaimDelivery,
      },
    ] = await Promise.all([
      import('../../seller/customer-access-lifecycle.js'),
      import('../../seller/customer-claim-delivery.js'),
    ]);
    const { createContractGrantEntryStore } = await import(
      '../../storage/contract-grant-entry-store.js'
    );
    const claimSupport = createSellerCustomerClaimSupport({
      ...(deps.getSellerPublicBaseUrl
        ? { getPublicBaseUrl: deps.getSellerPublicBaseUrl }
        : {}),
      ...(deps.llmManager ? { llmManager: deps.llmManager } : {}),
    });
    const lifecycle = createSellerCustomerAccessLifecycle({
      sellerStore: deps.sellerStore,
      contractStore: deps.contractStore,
      grantEntryStore: createContractGrantEntryStore(deps.contractStore),
      inboundTokenStore: deps.inboundTokenStore,
      ...(deps.sellerClaimStore ? { sellerClaimStore: deps.sellerClaimStore } : {}),
      buildClaimPayload: claimSupport.buildClaimPayload,
      requireClaimOnTokenIssue: true,
      mintedBy: `kernel:${deps.serverInstanceId}:customer-access`,
      now: () => Date.now(),
      transaction: (fn) => deps.contractStore!.transaction(fn),
    });
    return {
      lifecycle,
      toPublicClaim: claimSupport.toPublicClaim,
      deliverSellerCustomerClaimEmail,
      readSellerCustomerAfterClaimDelivery,
    };
  };
  const mcpCallbackContractDefinitions = deps.contractStore
    ? createContractDefinitionStore(deps.contractStore)
    : undefined;
  return {
    manifests: deps.manifests,
    vault: deps.baseVault,
    llmConfig: deps.llmConfig,
    resolveLlmConfig: deps.resolveLlmConfig,
    // D-169 P0 follow-on — DOM-runner accessor. Forwarded onto the
    // executor config so server-executor wires the bridge-bound DOM
    // adapter when the boot site has published a live dispatcher.
    ...(deps.getBridgeDispatcher
      ? { bridgeDispatcherRef: deps.getBridgeDispatcher }
      : {}),
    // Shared with housekeeping (`llmQuota` declared near llmConfig setup)
    // so per-source cooldowns + free-pool round-robin survive across
    // both recipe runs and AI-driven housekeeping cycles.
    llmQuota: deps.llmQuota,
    checkTokenBudget: deps.llmManager
      ? (expected) => deps.llmManager!.isOverBudget(expected)
      : undefined,
    onTokenUsage: deps.llmManager
      ? (tokens) => deps.llmManager!.addUsage(tokens)
      : undefined,
    // D-250 § D — the run-scoped half of the same provider result.
    // ⛔ NOT GATED ON `llmManager`, unlike the two hooks above it. Those feed
    // the daily budget counter, which lives on the manager and is meaningless
    // without it; this feeds an AUDIT field, which is wanted on every server
    // that runs recipes — including one with no budget configured, which is the
    // default. Gating it on the manager would have shipped the field silently
    // empty on exactly the installs least likely to notice.
    runTokenUsage: deps.runTokenUsage ?? createRunTokenUsageSink(),
    // D-316 amendment — the run cache is built ONCE PER CONFIG, like the token
    // sink above: the AI adapter and the execute handler must share it, or each
    // would build its own matcher for the same run.
    ...(deps.piiKnownValues
      ? {
          piiKnownValues: deps.piiKnownValues,
          piiKnownValuesRuns: createRunKnownValues(deps.piiKnownValues),
        }
      : {}),
    cacheStore: deps.cacheStore,
    instanceId: deps.serverInstanceId,
    cacheMaxBytes: 1024 * 1024 * 1024, // 1 GB default
    // D-125 P3.1 — connection adapter store reference. The SQLite-
    // backed store from P1.2 doubles as the adapter's lookup surface;
    // server-executor materialises the connection adapter when this is
    // set. Absent in dbless harnesses → the registry slot stays at D-126's
    // kind-named `unsupported('connection')` default, which reports the
    // unwired store rather than claiming the adapter has not shipped.
    ...(deps.connectionStore ? { connectionStore: deps.connectionStore } : {}),
    // D-125 P3.2 — audit sink for connection adapter dispatch. When both
    // the connection store and the audit log are present, server-executor
    // wires the per-dispatch emitter that lands one `connection_<kind>`
    // activity row per call. `auditLog` is undefined in dbless harnesses;
    // the emitter wiring degrades gracefully (no row, no error).
    ...(deps.auditLog ? { auditLog: deps.auditLog } : {}),
    // D-125 P4.1 — `connection.api` per-kind handler deps. Closes over
    // the same connection sub-DEK keyProvider used by enrollment so
    // decode + OAuth2-refresh re-encode round-trip through the same
    // AEAD pipeline. `persistAuth` writes via the store directly (we're
    // already in the same process as the rpc handlers). When the
    // FileVault is uninitialized we still wire the handler — the
    // base64-JSON fallback in `decodeAuthFromStorage` /
    // `encodeAuthForStorage` keeps fresh-install runtime functional;
    // the AEAD swap activates as soon as the bundle is unlocked.
    // Absent connectionStore → handler stays unwired (api dispatch
    // surfaces P3.1's `INGREDIENT_ADAPTER_ALL_FAILED` placeholder).
    ...(deps.connectionStore
      ? {
          connectionApi: await (async (): Promise<ConnectionApiHandlerDeps> => {
            const { decodeAuthFromStorage, encodeAuthForStorage } = await import('../../connection-handler.js');
            const keyProvider = (deps.keys && deps.keys.state() !== 'uninitialized')
              ? deps.keys.keyProvider('connection')
              : undefined;
            return {
              decodeAuth: (row) =>
                decodeAuthFromStorage(
                  row.auth_ciphertext,
                  { kind: row.kind, name: row.name },
                  keyProvider,
                ),
              // Shared with connection.mcp via `makeRefreshPersistAuth` (the
              // `subresource_path` carry-forward invariant lives there).
              persistAuth: makeRefreshPersistAuth(
                deps.connectionStore!,
                encodeAuthForStorage,
                keyProvider,
              ),
              // D-218 — the swallowed-write signal. Absent in a dbless harness,
              // which keeps the old silent behaviour there rather than
              // inventing a sink.
              ...(deps.auditLog
                ? {
                    onPersistFailure: makeConnectionCredentialPersistFailureSink(deps.auditLog),
                    onRuntimeBaseIssue: makeConnectionRuntimeBaseIssueSink(deps.auditLog),
                  }
                : {}),
              // D-216 — the byte reader for `bind.upload` ops.
              ...(deps.readFileBytes ? { readFileBytes: deps.readFileBytes } : {}),
              // D-217 — the ranged reader for a chunked upload's APPEND.
              ...(deps.readUploadChunk ? { readUploadChunk: deps.readUploadChunk } : {}),
            };
          })(),
          // D-125 P4.2 — `connection.mcp` per-kind handler deps. Reuses the
          // same connection sub-DEK keyProvider as P4.1. `persistAuth` mirrors
          // the api handler's (shared `makeRefreshPersistAuth`) so the
          // OAuth2-refresh gate persists a rotated token for MCP connections
          // too. Pool eviction uses `MCP_CLIENT_IDLE_TIMEOUT_MS` (5 min).
          connectionMcp: await (async (): Promise<ConnectionMcpHandlerDeps> => {
            const { decodeAuthFromStorage, encodeAuthForStorage } = await import('../../connection-handler.js');
            const { createWsConnect } = await import('../../mcp-ws-connector.js');
            const { createStdioSpawn } = await import('../../mcp-stdio-spawner.js');
            const keyProvider = (deps.keys && deps.keys.state() !== 'uninitialized')
              ? deps.keys.keyProvider('connection')
              : undefined;
            return {
              decodeAuth: (row) =>
                decodeAuthFromStorage(
                  row.auth_ciphertext,
                  { kind: row.kind, name: row.name },
                  keyProvider,
                ),
              persistAuth: makeRefreshPersistAuth(
                deps.connectionStore!,
                encodeAuthForStorage,
                keyProvider,
              ),
              // D-232 § 22 — REAL TRAFFIC WRITES HEALTH. Without this the field is
              // a manual snapshot: a connection that has failed every call for a
              // week still reads `ok` from whenever someone last pressed probe,
              // and anything consulting it (retry, fail-fast, the Connections
              // panel) is consulting nobody's opinion.
              // ⚠ `setHealth` is a single-column UPDATE precisely so this cannot
              // race the `persistAuth` credential rotation directly above — a
              // read-modify-write here would run that race on EVERY dispatch.
              persistHealth: async (name: string, health: ConnectionHealth) => {
                if (deps.connectionStore === undefined) {
                  // ⛔ NEVER SILENT. An optional-chained no-op here is the exact
                  // fake-seam shape this whole feature exists to remove.
                  console.warn('[connection-health] no connectionStore; health not written');
                  return;
                }
                deps.connectionStore.setHealth('mcp', name, JSON.stringify(health));
              },
              ...(deps.auditLog
                ? { onPersistFailure: makeConnectionCredentialPersistFailureSink(deps.auditLog) }
                : {}),
              // B3a — websocket transport (D-125 §920). The `ws`-backed
              // connector sets the bearer in the upgrade handshake +
              // refuses cross-origin redirects (SSRF). The watch-poll mcp
              // handler inherits this via the same connectionMcp deps.
              wsConnect: createWsConnect(),
              // B3b — stdio transport (D-125 §921). The child_process-backed
              // spawner uses shell:false + a curated minimal env. The command
              // is user-enrolled (Settings → Connections), never pack-injected.
              spawnStdioMcp: createStdioSpawn(),
            };
          })(),
          // D-177 P2b / D-228 slice 4 — per-tool TIER gate for the kernel
          // connection-mcp-{read,write} dispatch surfaces. No-op for every other
          // slug; absent without a db (dbless harness).
          //
          // ⛔⛔ IT NO LONGER READS THE CHAT PRESENTATION STORE. The tier used to
          // come from `tool_overrides`; it now comes from the pack operation the
          // tool is dispatched through, resolved through the SAME contract rows
          // the door reads. So the gate needs the contract store (for the
          // connection→catalog binding AND the owner's ruling) and the manifest
          // registry — both threaded here rather than re-derived, so the gate
          // cannot disagree with the dispatcher about what is installed.
          //
          // ⚠ Resolution stays LAZY inside the gate: this config composes before
          // the stores are guaranteed populated, and an eager read would crash a
          // fresh-db boot (the D-164 trust-store lesson).
          ...(deps.db
            ? await (async () => {
                const { createConnectionMcpGateFromDb } = await import(
                  '../../connection-mcp-gate.js'
                );
                return {
                  connectionGateDispatch: createConnectionMcpGateFromDb(deps.db!, {
                    ...(deps.contractStore ? { contractStore: deps.contractStore } : {}),
                    getManifest: (slug: string) => deps.manifests.get(slug),
                  }),
                };
              })()
            : {}),
          // D-125 P4.3 — `connection.notification` per-kind handler deps.
          // Hoisted to `connectionNotificationDeps` above so the kernel
          // `notification-send` dispatcher bridge (built next) can share
          // the same handler instance.
          ...(deps.connectionNotificationDeps
            ? { connectionNotification: deps.connectionNotificationDeps }
            : {}),
        }
      : {}),
    // D-103 Phase A + D-106 Phase D: kernel ingredients dispatch to
    // in-process handlers. Ext-side rpc routing for the same slugs
    // lands in `packages/ingredients/src/kernel.ts` (switched on
    // the same slug list; the ext implementation rpcs to the paired
    // server).
    kernelDispatchers: {
      ...(deps.fileStack?.kernelDispatchers ?? {}),
      ...(deps.calendarStack?.kernelDispatchers ?? {}),
      // D-115 Phase 6 — unified watcher dispatcher slot: time,
      // time-relative and http (the mail, file, calendar, webhook and
      // recipe watchers were retired 2026-10-05); `runtime.testTrigger`
      // shares this binding. (DOM watching is not a server-local watcher —
      // it runs through the D-179 watch-poll source via the paired Bridge;
      // see `watch/dom-source.ts`.)
      watcher: deps.watcherDispatcher,
      // D-234 § 234.4 — the peer ASK dispatcher. ⛔ WIRING THIS IS THE WHOLE
      // FEATURE: `createKernelAdapter` refuses an unwired slug with
      // `SERVER_NOT_REACHABLE`, so `core.peer.ask` exists and does nothing until
      // it is threaded here. Absent without a db, matching every other
      // store-backed dispatcher — a dbless harness has nowhere to record an
      // answer, and refusing beats accepting a call and dropping it.
      //
      // ⛔⛔ THE STORE IS BUILT LAZILY, ON FIRST USE, AND THE FIRST CUT WAS NOT.
      // Constructing it here ran `CREATE TABLE` at COMPOSITION time, which (a)
      // pays DDL on every boot for a table most servers never touch, and (b)
      // makes composing the executor fail outright if the handle is not open yet
      // — caught by two unrelated `timelineRead` tests that compose with a closed
      // db and had nothing to do with peers. Every sibling dispatcher in this
      // block already defers its work to call time (`await import(...)` inside
      // the handler); this now matches them.
      ...(deps.db
        ? (() => {
            let answers:
              import('../../storage/peer-answer-store.js').PeerAnswerStore | undefined;
            const openAnswers = async () => {
              if (answers === undefined) {
                const { createPeerAnswerStore } = await import(
                  '../../storage/peer-answer-store.js'
                );
                answers = createPeerAnswerStore(deps.db!);
              }
              return answers;
            };
            return {
              // D-234 § 234.4 — the ASKING op. ⛔ WITHOUT THIS THREADING, a recipe
              // naming `core.peer.ask` gets `SERVER_NOT_REACHABLE` and the whole
              // pause substrate — signal, re-throw, step-loop catch,
              // `awaiting_peer` — is unreachable code that every test still
              // passes, because every test builds its own adapter.
              //
              // ⚠ `run_id` / `step_id` come off `StepMeta`, i.e. the ENGINE, and
              // are refused when absent: the conversation ref is derived from
              // them and a ref that cannot be reproduced on resume strands the
              // run silently.
              peerAsk: async (input, stepMeta) => {
                const { dispatchPeerAsk } = await import('../../peer-ask-dispatch.js');
                return dispatchPeerAsk(input, {
                  answers: await openAnswers(),
                  run_id: stepMeta?.run_id ?? '',
                  step_id: stepMeta?.step_id ?? '',
                });
              },
            };
          })()
        : {}),
      ...(deps.sharedStore
        ? {
            write: async ({ key, value, ttl: _ttl }) => {
              const { handleSharedWrite } = await import('../../shared-handler.js');
              return handleSharedWrite({ store: deps.sharedStore! }, { key, value });
            },
            compareAndSet: async ({ key, expected_revision, value }) => {
              const { handleSharedCompareAndSet } = await import('../../shared-handler.js');
              return handleSharedCompareAndSet(
                { store: deps.sharedStore! },
                { key, expected_revision, value },
              );
            },
            patch: async ({ key, set, unset, match }) => {
              const { handleSharedPatch } = await import('../../shared-handler.js');
              return handleSharedPatch({ store: deps.sharedStore! }, { key, set, unset, match });
            },
            read: async ({ key }) => {
              const { handleSharedRead } = await import('../../shared-handler.js');
              return handleSharedRead({ store: deps.sharedStore! }, { key });
            },
            // D-232 § 23 — DERIVED FROM THE AUDIT TRAIL, WHICH IS WHY IT IS
            // SERVER-SIDE. Nothing new is stored: the runs filed under the ref
            // already say everything, and a state machine that can drift from the
            // runs it describes is worse than a projection that cannot.
            exchangeStatus: async ({ exchange_ref, callback_op }) => {
              const { classifyRunFailure: classifyRunFailureImpl } = await import('@recued/engine');
              const rows = deps.auditLog === undefined
                ? []
                : await deps.auditLog.listByExchangeRef(exchange_ref, 200);
              const report = deriveExchangeStatus(
                exchange_ref,
                rows.map((r) => ({
                  recipe_id: r.recipe_id,
                  status: String(r.commit_status ?? ''),
                  errors: r.errors ?? [],
                  // D-232 § 30 — the peer's verdict, carried into the fold. ⛔
                  // This mapping is a THIRD enumerating copier on the same path
                  // (after `buildAuditEntry` and `ExecuteResponse`): the column
                  // can be written and exported correctly and STILL be invisible
                  // to the status surface if it is not named right here.
                  ...(r.exchange_peer_ack !== undefined
                    ? { peer_ack: r.exchange_peer_ack }
                    : {}),
                })),
                callback_op,
                classifyRunFailureImpl,
              );
              return {
                ref: report.ref,
                status: report.status,
                ...(report.kind !== undefined ? { kind: report.kind } : {}),
                ...(report.reason !== undefined ? { reason: report.reason } : {}),
                runs: report.runs,
              };
            },
            list: async ({ prefix }) => {
              const { handleSharedList } = await import('../../shared-handler.js');
              return handleSharedList({ store: deps.sharedStore! }, { prefix });
            },
            search: async ({ scope, query }) => {
              const { handleSharedSearch } = await import('../../shared-handler.js');
              return handleSharedSearch({ store: deps.sharedStore! }, { scope, query });
            },
            delete: async ({ key }) => {
              const { handleSharedDelete } = await import('../../shared-handler.js');
              return handleSharedDelete({ store: deps.sharedStore! }, { key });
            },
            deletePrefix: async ({ prefix }) => {
              const { handleSharedDeletePrefix } = await import('../../shared-handler.js');
              return handleSharedDeletePrefix({ store: deps.sharedStore! }, { prefix });
            },
          }
        : {}),
      ...(deps.formResponseStore
        ? {
            formResponseList: async (input) => {
              const requested = input.limit ?? 100;
              const fetched = deps.formResponseStore!.list({
                ...input,
                limit: requested + 1,
              });
              const hasMore = fetched.length > requested;
              const records = hasMore ? fetched.slice(0, requested) : fetched;
              const last = records.at(-1);
              return {
                records,
                ...(hasMore && last !== undefined
                  ? {
                      next_cursor: {
                        accepted_at: last.accepted_at,
                        submission_id: last.submission_id,
                      },
                    }
                  : {}),
              };
            },
            formResponseGet: async ({ submission_id }) => ({
              record: deps.formResponseStore!.findById(submission_id),
            }),
            // D-210 A.8 slice 2 — the lifecycle write. `Date.now()` here rather
            // than a caller-supplied instant: `state_changed_at` is the
            // server's record of WHEN a state moved, and a caller that could
            // choose it could backdate a no-show.
            formResponseSetState: async ({ submission_id, lifecycle_state }) => ({
              record: deps.formResponseStore!.setLifecycleState(
                submission_id,
                lifecycle_state,
                Date.now(),
              ),
            }),
          }
        : {}),
      /** D-207 slice 3d — the general no-resend fence.
       *
       *  Everything the provider is asked is DERIVED from the claim `mail-send` wrote
       *  before it dispatched. The recipe hands over an id and nothing else, which is
       *  what makes a forged match impossible rather than merely disallowed.
       *
       *  ⛔ Note what a missing collection produces: `unavailable`, which settles
       *  NOTHING. An absent mail account is not evidence a message failed to send —
       *  treating it as such would authorize a resend from our own misconfiguration. */
      mailSentReconcile: async ({ reconciliation_id }) => {
        // ⛔ No database, no claim, no honest answer. Refusing beats returning a
        // `not_found`-shaped nothing that a caller could read as "safe to resend".
        if (!deps.db) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            'mail-sent-reconcile unavailable — no durable store to read the send claim from',
            { reconciliation_id },
          );
        }
        const claims = createMailSendClaimStore(deps.db);
        const claim = claims.get(reconciliation_id);
        if (claim === null) {
          throw new IngredientError(
            'BAD_INPUT',
            `mail-sent-reconcile: no send claim '${reconciliation_id}' — a send is only `
              + 'reconcilable against the claim written before it',
            { reconciliation_id },
          );
        }

        // Already settled by provider source truth. Asking again cannot improve on it,
        // and re-stamping it would churn a decision a human may already have acted on.
        if (isMailSendClaimSettled(claim.status)) {
          return {
            status: claim.status,
            settled: true,
            provider_message_id: claim.provider_message_id,
            sent_at: claim.sent_at,
            ambiguity_reason: claim.ambiguity_reason,
            scanned_candidates: 0,
          };
        }

        const query = mailSentReconciliationQueryFor(claim, Date.now());
        if (query === null) {
          throw new IngredientError(
            'BAD_INPUT',
            `mail-sent-reconcile: the claim '${reconciliation_id}' cannot produce an honest `
              + 'query (a byte-proof claim with no pinned bytes would have to be downgraded '
              + 'to an envelope question, which would silently weaken what it proves)',
            { reconciliation_id },
          );
        }

        const collection = deps.collectionRegistry.get('mail', claim.sender_slug);
        const result: MailSentReconciliationResult =
          collection === undefined
            || !('lookupSentByReconciliationId' in collection)
            || typeof collection.lookupSentByReconciliationId !== 'function'
            ? { status: 'unavailable', reason: 'unsupported', scanned_candidates: 0 }
            : await (collection as MailCollection).lookupSentByReconciliationId(query);

        const settledClaim = claims.settle({
          reconciliation_id,
          expected_revision: claim.revision,
          result,
          now: Date.now(),
        });

        return {
          status: settledClaim.status,
          // ⛔ HONEST: a `not_found` is a real ANSWER that changed NOTHING. Reporting it
          // as a successful reconciliation would invite the very resend this forbids.
          settled: isMailSendClaimSettled(settledClaim.status),
          provider_message_id: settledClaim.provider_message_id,
          sent_at: settledClaim.sent_at,
          ambiguity_reason: settledClaim.ambiguity_reason,
          scanned_candidates: result.scanned_candidates,
        };
      },
      ...(deps.webhookEventReader
        ? {
            webhookEventGet: async (
              { event_ref },
              { recipe_id, run_id },
            ) => deps.webhookEventReader!.read({ event_ref, recipe_id, run_id }),
          }
        : {}),
      collectionList: async ({ platform, slug, filters, since, until, limit }) => {
        const { handleCollectionList } = await import('../../collections/collection-handler.js');
        const res = await handleCollectionList(
          { registry: deps.collectionRegistry },
          { platform, slug, filters, since, until, limit },
        );
        // D-236 — forward the freshness verdict. ⛔ This closure previously
        // narrowed the handler's result to `{ records }`, which is exactly how
        // a fact that already existed server-side stayed invisible to every
        // recipe: nothing was missing, something was being DROPPED in transit.
        return { records: res.records, source_freshness: res.source_freshness };
      },
      collectionGet: async ({ platform, slug, record_id }) => {
        const { handleCollectionGet } = await import('../../collections/collection-handler.js');
        return handleCollectionGet(
          { registry: deps.collectionRegistry },
          { platform, slug, record_id },
        );
      },
      collectionSearch: async ({ platform, slug, query, limit }) => {
        const { handleCollectionSearch } = await import('../../collections/collection-handler.js');
        const res = await handleCollectionSearch(
          { registry: deps.collectionRegistry },
          { platform, slug, query, limit },
        );
        // D-236 — forward the verdict. ⛔ This closure narrowed to `{ matches }`
        // for the same reason its `collectionList` sibling narrowed to
        // `{ records }`: the extra key looked like noise. It is the SECOND
        // instance of the exact defect D-236 exists to fix, found by sweeping
        // for siblings rather than by fixing only the one that was reported.
        return { matches: res.matches, source_freshness: res.source_freshness };
      },
      // D-122 Phase 2 — graph-builder kernel ingredients. Each dispatcher
      // is gated on its underlying store/deps; absent → kernel adapter
      // returns SERVER_NOT_REACHABLE (test harnesses that don't stand up
      // the full warehouse stack still pass).
      ...(deps.contactStore
        ? {
            contactUpsert: async (input) => {
              const { handleContactUpsert } = await import('../../contact-handler.js');
              return handleContactUpsert(
                // D-161 P2 — lift the engine-supplied origin facet off the
                // TRUSTED kernel dispatch input into the handler deps, so a
                // recipe-driven `contact-upsert` stamps the run's actor
                // (propagated from its ExecutionSource, I-6) and a client
                // payload can never spoof it (A.5). Mirrors the
                // enrichmentUpsert / annotationCreate injections.
                // D-177 N.11 rule 1 — this closure IS the engine path, so
                // the write surface is statically 'engine' (whatever
                // channel drove the run): recipe-written rows never read
                // user-clean at the open-grant gate.
                {
                  store: deps.contactStore!,
                  ...(input.origin_actor !== undefined
                    ? { origin_actor: input.origin_actor }
                    : {}),
                  ...(input.origin_contract_id !== undefined
                    ? { origin_contract_id: input.origin_contract_id }
                    : {}),
                  origin_surface: 'engine',
                },
                {
                  email: input.email,
                  ...(input.display_name !== undefined ? { name: input.display_name } : {}),
                  ...(input.last_interaction !== undefined
                    ? { last_interaction: input.last_interaction }
                    : {}),
                  ...(input.first_seen !== undefined ? { first_seen: input.first_seen } : {}),
                },
              );
            },
            // D-145 PA8 follow-on — contact-resolve reads an identifier
            // back to a local contact_id (e.g. the counterparty email an
            // extractor recipe pulled off a mail). Same ContactStore dep
            // as contactUpsert; the handler validates the exactly-one
            // identifier rule, so the input forwards through unchanged.
            contactResolve: async (input) => {
              const { handleContactResolve } = await import('../../contact-handler.js');
              return handleContactResolve({ store: deps.contactStore! }, input);
            },
          }
        : {}),
      ...((deps.businessContextContactStore ?? deps.contactStore)
        ? {
            contactBusinessContext: async (input) => {
              const { resolveContactBusinessContext } = await import(
                '../../contact-business-context.js'
              );
              return resolveContactBusinessContext(
                {
                  contacts: deps.businessContextContactStore ?? deps.contactStore!,
                  ...(deps.businessContextWorkEntityStore
                    ? { workEntities: deps.businessContextWorkEntityStore }
                    : {}),
                  ...(deps.businessContextCalendars ?? deps.calendarStack
                    ? { calendars: deps.businessContextCalendars ?? deps.calendarStack! }
                    : {}),
                  ...(deps.businessContextCrmMirrorStore
                    ? { crmMirror: deps.businessContextCrmMirrorStore }
                    : {}),
                  ...(deps.getBoundCrmSources
                    ? { getBoundCrmSources: deps.getBoundCrmSources }
                    : {}),
                },
                input,
              );
            },
          }
        : {}),
      mailThreadRead: async (input) => {
        const { handleMailThreadRead } = await import('../../mail-thread-handler.js');
        return handleMailThreadRead(
          { registry: deps.collectionRegistry },
          input,
        );
      },
      ...(deps.annotationDeps
        ? {
            linkCreate: async (input) => {
              const { handleLinkCreate } = await import('../../annotation-handler.js');
              return handleLinkCreate(
                // D-161 P2 — lift the engine-supplied origin facet off the
                // TRUSTED kernel dispatch input into the handler deps
                // (server-side), so the written link row's origin_actor is
                // propagated from the run's ExecutionSource and a client
                // payload can never spoof it (I-6 / A.5). Mirrors the
                // `enrichmentUpsert` injection.
                // D-177 N.11 rule 1 — link rows stamp the 'engine' surface
                // too (codex LOW fold): links stay ungated, but the facet
                // must read truthfully if the gate grammar ever widens.
                {
                  ...deps.annotationDeps!,
                  ...(input.origin_actor !== undefined
                    ? { origin_actor: input.origin_actor }
                    : {}),
                  ...(input.origin_contract_id !== undefined
                    ? { origin_contract_id: input.origin_contract_id }
                    : {}),
                  origin_surface: 'engine',
                },
                input as unknown as Record<string, unknown>,
              );
            },
            annotationCreate: async (input) => {
              const { handleAnnotationCreate } = await import('../../annotation-handler.js');
              return handleAnnotationCreate(
                // D-161 P2 — lift the engine-supplied origin facet off the
                // trusted dispatch input into the handler deps (as above).
                // D-177 N.11 rule 1 — recipe-path annotation writes stamp
                // the 'engine' surface (see contactUpsert above).
                {
                  ...deps.annotationDeps!,
                  ...(input.origin_actor !== undefined
                    ? { origin_actor: input.origin_actor }
                    : {}),
                  ...(input.origin_contract_id !== undefined
                    ? { origin_contract_id: input.origin_contract_id }
                    : {}),
                  origin_surface: 'engine',
                },
                input as unknown as Record<string, unknown>,
              );
            },
            // ⛔ THE THREE READ VERBS WERE NEVER WIRED HERE. The kernel adapter
            // declared them and only a test double supplied them
            // (`kernel-annotation.test.ts`), so on a real server
            // `annotation-list` / `annotation-search` / `link-list` failed
            // "unavailable" on every run while their unit tests passed. The
            // op gate is the usual per-dispatch one; a read stamps nothing, so
            // there is no origin facet to lift.
            annotationList: async (input) => {
              const { handleAnnotationList } = await import('../../annotation-handler.js');
              return handleAnnotationList(deps.annotationDeps!, input);
            },
            annotationSearch: async (input) => {
              const { handleAnnotationSearch } = await import('../../annotation-handler.js');
              return handleAnnotationSearch(deps.annotationDeps!, input);
            },
            linkList: async (input) => {
              const { handleLinkList } = await import('../../annotation-handler.js');
              return handleLinkList(deps.annotationDeps!, input);
            },
            // The two deletes were unwired for the same reason. Their SCOPE is
            // decided in the kernel adapter, where the run's identity is: an
            // annotation delete arrives pinned to the running recipe, a link
            // delete does not (see the two cases in `kernel.ts`).
            annotationDelete: async (input) => {
              const { handleAnnotationDelete } = await import('../../annotation-handler.js');
              return handleAnnotationDelete(deps.annotationDeps!, input);
            },
            linkDelete: async (input) => {
              const { handleLinkDelete } = await import('../../annotation-handler.js');
              return handleLinkDelete(deps.annotationDeps!, input);
            },
          }
        : {}),
      ...(deps.db && deps.annotationStore && deps.auditLog
        ? {
            timelineRead: async (input) => {
              const { handleTimelineReadFromRecipe } = await import('../../timeline-recipe-handler.js');
              // D-187 AMENDMENT — resolve the enclosing recipe's bound-contract
              // read-grant checker (the recipe-channel analog of the native tool's door
              // contract). The handler applies it ONLY when `trigger_source === 'mcp'`
              // (it flips `gateMcpPrivate` per-call); absent ⇒ registry author defaults.
              const readGrantChecker =
                readGrantResolver?.resolveForContract(input.origin_contract_id);
              return handleTimelineReadFromRecipe(
                {
                  timelineDeps: {
                    db: deps.db!,
                    auditLog: deps.auditLog!,
                    annotationStore: deps.annotationStore!,
                    // D-128 Phase 5 — enrichment store fans
                    // `data_enrichment` rows for the (scope, target_id)
                    // pair into the recipe-channel feed alongside mail /
                    // calendar / annotation entries. Absent store
                    // degrades gracefully (zero enrichment entries).
                    ...(deps.enrichmentStore
                      ? { enrichmentStore: deps.enrichmentStore }
                      : {}),
                    ...(readGrantChecker
                      ? { readGrantChecker }
                      : {}),
                    // loadCollectionRecord stays unset for the recipe
                    // channel — graph-builders rarely need the raw record
                    // snapshot inline (they typically pull it through
                    // `email-get` / `calendar-get` directly).
                  },
                },
                input,
              );
            },
          }
        : {}),
      // D-122 Phase 4.5 — enrichment substrate dispatchers. Absent
      // store ⇒ kernel adapter surfaces SERVER_NOT_REACHABLE so dbless
      // harnesses keep working.
      ...(deps.enrichmentStore
        ? {
            enrichmentUpsert: async (input) => {
              const { handleEnrichmentUpsert } = await import('../../enrichment-handler.js');
              return handleEnrichmentUpsert(
                {
                  store: deps.enrichmentStore!,
                  // D-161 P1 — lift the engine-supplied origin facet off
                  // the TRUSTED kernel dispatch input into the handler
                  // deps (server-side), so the written row's origin_actor
                  // is propagated from the run's ExecutionSource and a
                  // client RPC payload can never spoof it (I-6 / A.5).
                  // Mirrors the `enrichmentList` trigger_source injection.
                  ...(input.origin_actor !== undefined
                    ? { origin_actor: input.origin_actor }
                    : {}),
                  ...(input.origin_contract_id !== undefined
                    ? { origin_contract_id: input.origin_contract_id }
                    : {}),
                },
                input,
              );
            },
            enrichmentList: async (input) => {
              const { handleEnrichmentList } = await import('../../enrichment-handler.js');
              return handleEnrichmentList(
                {
                  store: deps.enrichmentStore!,
                  // D-136 P7.E — forward the kernel-threaded trigger_source
                  // so the handler can apply `mcp_exposed: 'private'` gating
                  // when the recipe was invoked through `recued_runRecipe`.
                  ...(typeof input.trigger_source === 'string'
                    ? { trigger_source: input.trigger_source }
                    : {}),
                  // D-187 AMENDMENT — forward the run's contract_id + the read-grant
                  // resolver so the mcp-trigger reject resolves the topic's
                  // `enrichment.<topic>` grant per-(bound contract) rather than a global
                  // override table.
                  ...(typeof input.origin_contract_id === 'string'
                    ? { origin_contract_id: input.origin_contract_id }
                    : {}),
                  ...(readGrantResolver ? { readGrantResolver } : {}),
                },
                input,
              );
            },
          }
        : {}),
      // D-315 — mail facts and the things they fold into.
      ...(deps.mailFactStore
        ? {
            mailFactGet: async ({ id }) => {
              const { readMailFact } = await import('../../mail-facts/mail-fact-reads.js');
              return readMailFact(deps.mailFactStore!, id);
            },
            mailFactList: async (query) => {
              const { listMailFacts } = await import('../../mail-facts/mail-fact-reads.js');
              return { records: listMailFacts(deps.mailFactStore!, query) };
            },
          }
        : {}),
      // mail-get is a thin warehouse read — wired whenever the
      // collection registry is present.
      mailGet: async (input) => {
        const { handleMailGet } = await import('../../mail-get-handler.js');
        return handleMailGet({ registry: deps.collectionRegistry }, input);
      },
      // D-239 — the mail write-back four. Wired unconditionally alongside
      // the reads: the capability question ("may this mailbox be written?")
      // belongs to the ENROLLMENT and is answered by the dispatcher's
      // `mutationCapable` gate with a legible refusal. Gating the wiring
      // itself on some composition-time condition would surface a
      // read-only mailbox as SERVER_NOT_REACHABLE — "your server is
      // unreachable" for a server that is right here and simply was not
      // granted write access.
      mailMark: async (input) => {
        const { handleMailMark } = await import('../../collections/mail/mail-dispatcher.js');
        return handleMailMark(mailDispatcherDeps(), input);
      },
      mailFlag: async (input) => {
        const { handleMailFlag } = await import('../../collections/mail/mail-dispatcher.js');
        return handleMailFlag(mailDispatcherDeps(), input);
      },
      mailMove: async (input) => {
        const { handleMailMove } = await import('../../collections/mail/mail-dispatcher.js');
        return handleMailMove(mailDispatcherDeps(), {
          slug: input.slug,
          record_id: input.record_id,
          destination: {
            ...(input.folder !== undefined ? { folder: input.folder } : {}),
            ...(input.add_labels !== undefined ? { add_labels: input.add_labels } : {}),
            ...(input.remove_labels !== undefined
              ? { remove_labels: input.remove_labels }
              : {}),
          },
        });
      },
      mailDelete: async (input) => {
        const { handleMailDelete } = await import('../../collections/mail/mail-dispatcher.js');
        return handleMailDelete(mailDispatcherDeps(), input);
      },
      // D-172 P1 — content bytes for inbound data.file records leave
      // the warehouse only through this kernel ingredient path. The
      // engine wraps ingredient dispatch with the Commit Gateway, so
      // policy gating + commit audit happen before this handler reads
      // the CAS blob.
      ...(deps.cacheBlobs
        ? {
            dataFileRead: async (input) => {
              const { handleFileRead } = await import('../../collections/file/file-read-handler.js');
              // D-192 — a `file:remote:*` id routes to the vendor byte fetch when
              // the file-source mirror is wired; a CAS id takes the existing path.
              const remote = deps.getRemoteFileReadDeps?.();
              return handleFileRead(
                {
                  registry: deps.collectionRegistry,
                  blobs: deps.cacheBlobs!,
                  ...(deps.auditLog ? { auditLog: deps.auditLog } : {}),
                  ...(remote ? { remote } : {}),
                },
                input,
              );
            },
            // D-200 Slice 3 — strict deterministic Markdown substitution. The
            // outer kernel op is the gated data.file write; this handler reuses
            // the audited file reader and emits only a run-scoped temp ref.
            markdownTemplateRender: async (input) => {
              const { handleMarkdownTemplateRender } = await import(
                '../../collections/file/markdown-template-render-handler.js'
              );
              const { handleFileRead } = await import(
                '../../collections/file/file-read-handler.js'
              );
              const remote = deps.getRemoteFileReadDeps?.();
              return handleMarkdownTemplateRender(
                {
                  readFile: (readInput) => handleFileRead(
                    {
                      registry: deps.collectionRegistry,
                      blobs: deps.cacheBlobs!,
                      ...(deps.auditLog ? { auditLog: deps.auditLog } : {}),
                      ...(remote ? { remote } : {}),
                    },
                    readInput,
                  ),
                },
                input,
              );
            },
          }
        : {}),
      // D-185 Slice 4 — `file-persist` (the temp→cas keep step). Ingests a
      // run-scoped temp file_ref's bytes into data.file.received and returns the
      // durable cas_ref. The handler resolves the collection off the registry +
      // does the CAS ingest itself (no `cacheBlobs` dep — the collection owns its
      // blob store); fails closed `collection_not_found` when unregistered.
      // D-244 — one dep bundle for both csv ops: the SAME gated read the markdown
      // renderer takes, plus a CAS ingest for the filtered result. Keyed the way
      // `file-persist` keys its record — the discriminator is the CONTENT hash,
      // not the filename, so two different filters of one sheet never collide
      // and an identical re-filter stays idempotent.
      // D-244 — `csv-filter` / `csv-columns`. Reuses the SAME gated file read the
      // markdown renderer takes, so a stored CSV has one read path rather than
      // one per consumer. The parsing itself is `@recued/transforms` code shared
      // with `csv_parse` — the handler owns only the I/O.
      csvFilter: async (input) => {
        const { handleCsvFilter } = await import('../../collections/file/csv-filter-handler.js');
        return handleCsvFilter(
          await csvFileDeps(deps, input.run_id, input.step_id),
          input,
        );
      },
      // D-245 — ref → a record the recipe named. Reuses the same gated read the
      // csv ops take, and the same `write` capability gate `file-write` enforces:
      // naming a destination does not grant writing to it.
      filePutRef: async (input) => {
        // ⛔ The instance store + live adapters come from the FILE STACK, the one
        // place that owns adapter lifecycle — not re-derived here, or a
        // put_ref could write through an adapter the stack considers stopped.
        const stack = deps.fileStack;
        if (!stack) {
          throw new Error('file.put_ref: no file stack — enrol a writable file instance first');
        }
        const { handleFilePutRef } = await import('../../collections/file/dispatcher.js');
        const csv = await csvFileDeps(deps);
        return handleFilePutRef(
          {
            instances: stack.instances,
            getAdapter: (slug: string) => stack.getLiveAdapter(slug),
            readFile: csv.reader.readFile,
          } as never,
          input,
        );
      },
      csvStats: async (input) => {
        const { handleCsvStats } = await import('../../collections/file/csv-filter-handler.js');
        return handleCsvStats(await csvFileDeps(deps), input);
      },
      // `csv-rows` — `csv-filter`'s READING twin. It gets the read half of the
      // bundle only: the ingestor is dropped here, so the op that saves nothing
      // is never handed the means to.
      csvRows: async (input) => {
        const { handleCsvRows } = await import('../../collections/file/csv-filter-handler.js');
        const { ingest: _ingest, ...read } = await csvFileDeps(deps);
        return handleCsvRows(read, input);
      },
      csvColumns: async (input) => {
        const { handleCsvColumns } = await import('../../collections/file/csv-filter-handler.js');
        return handleCsvColumns(await csvFileDeps(deps), input);
      },
      fileReadTemp: async (input) => {
        const { handleFileReadTemp } = await import('../../collections/file/file-read-temp-handler.js');
        return handleFileReadTemp(input);
      },
      filePersist: async (input) => {
        const { handleFilePersist } = await import('../../collections/file/file-persist-handler.js');
        return handleFilePersist({ registry: deps.collectionRegistry }, input);
      },
      // D-173 P5 (scan-gate part B) — `file-set-scan-status` (the post-scan
      // write-back). Patches a data.file.received record's scan_status hot field
      // to the scanner verdict + emits `updated`. The handler resolves the
      // collection off the registry; fails closed `collection_not_found` when
      // unregistered. MCP-reserved (author 'recued', not in
      // MCP_EXPOSED_KERNEL_INGREDIENTS) — never an agent tool.
      fileSetScanStatus: async (input) => {
        const { handleFileSetScanStatus } = await import('../../collections/file/file-scan-status-handler.js');
        return handleFileSetScanStatus({ registry: deps.collectionRegistry }, input);
      },
      // D-173 P1-dispatch — the LOCAL materialize of a reviewed reception
      // submission. The reception core-pack op (reception-intake /
      // reception-approval) is a catalog-form `approval_required` operation
      // whose REST binding points at the local-only `https://reception.local`
      // sentinel; the D-157 gate HOLDS it pending in the inbox, then the
      // engine re-dispatches the gated op on approve-resume. The ingredient
      // executor recognises the reception-local surface dispatch and routes it
      // to the `reception-materialize` kernel ingredient, which lands HERE.
      // The effect is `runReceptionProjection` over the SAME per-pair
      // destination stores `composeReceptionInboxDeps` binds its
      // `projectReception` effect over — so the gate-held op completes
      // identically. Gated on either projection store; when both
      // are absent (dbless harness), the kernel adapter surfaces
      // SERVER_NOT_REACHABLE.
      ...(deps.receptionProjectionWorkEntityStore || deps.formResponseStore
        ? {
            receptionMaterialize: async (input) => {
              const { runReceptionProjection } = await import(
                '../../ports/reception/projection/reception-projection.js'
              );
              // D-173 P4.3 — the `calendar.event` branch's local create seam.
              //
              // ⚠ Since D-210 A.2 that branch is an INTAKE targeting a calendar,
              // NOT a reservation (a booking is never in the calendar), so this
              // no longer needs the scheduling booking store. Absent → a
              // calendar projection fail-closes. Stateless, so building it per
              // call is cheap.
              const calendarStack = deps.calendarStack;
              const bookingStore = deps.receptionProjectionBookingStore;
              const createCalendarEvent = calendarStack
                ? await (async () => {
                    const { createReceptionCalendarEventSeam } = await import(
                      '../../ports/reception/projection/reception-calendar-event.js'
                    );
                    return createReceptionCalendarEventSeam({
                      calendarCreate: calendarStack.kernelDispatchers.calendarCreate,
                    });
                  })()
                : undefined;
              // D-210 A.2 / slice 3b — the SCHEDULING booking write path: the
              // reservation's whole materialization, replacing the calendar
              // event it used to hang off. Needs BOTH the work-entity store
              // (the row) and the scheduling booking store (the sealed slot +
              // provenance); absent → a reservation projection fail-closes.
              //
              // The counterparty (sealed email → contact id) and the title
              // (endpoint `display_name`) are each independently optional, so a
              // partial substrate costs the booking a FIELD, never the row.
              const mintStore = deps.receptionBookingMintStore;
              const createBooking =
                mintStore !== undefined
                  && bookingStore !== undefined
                  && deps.getFormSubmissionPiiKey !== undefined
                  ? await (async () => {
                      const { createReceptionBookingMintSeam } = await import(
                        '../../ports/reception/projection/reception-booking-mint.js'
                      );
                      return createReceptionBookingMintSeam({
                        writeBooking: (writeInput, now) =>
                          mintStore.writeBooking(writeInput, now),
                        readBooking: (id) => mintStore.readBooking(id),
                        findBooking: (request_id) => bookingStore.findById(request_id),
                        markProcessed: (input) => bookingStore.markProcessed(input),
                        ...(deps.receptionEndpointRegistryStore
                          ? {
                              findEndpoint: (endpoint_id) =>
                                deps.receptionEndpointRegistryStore!.findById(endpoint_id),
                            }
                          : {}),
                        getFormSubmissionPiiKey: deps.getFormSubmissionPiiKey!,
                        // D-210 A.8 slice 3d — the visitor-confirmation send,
                        // built from the SAME pieces the `notifyBookingVisitor`
                        // dispatcher below uses, so the form-option path and the
                        // recipe path open the sealed address identically.
                        //
                        // ⚠ Conditional spread — the shape that silently dropped
                        // `receptionManageMintDeps` from ServerConfig. It is safe
                        // in this direction (the seam DECLARES both keys, so a
                        // typo is a tsc error, not a silent drop), and a genuinely
                        // absent dep fails CLOSED: a ticked notify refuses rather
                        // than minting and swallowing the send.
                        ...(deps.getFormSubmissionPiiKey
                          ? {
                              notifyVisitor: async (notifyInput) => {
                                const { handleNotifyBookingVisitor } = await import(
                                  '../../ports/reception/notify-booking-visitor.js'
                                );
                                const { handleCollectionMailSend } = await import(
                                  '../../collections/collection-handler.js'
                                );
                                return handleNotifyBookingVisitor(
                                  {
                                    readBooking: (id) => mintStore.readBooking(id),
                                    findBooking: (request_id) =>
                                      bookingStore.findById(request_id),
                                    getFormSubmissionPiiKey: deps.getFormSubmissionPiiKey!,
                                    mailSend: (mailInput) =>
                                      handleCollectionMailSend(
                                        { registry: deps.collectionRegistry },
                                        mailInput,
                                      ),
                                  },
                                  notifyInput,
                                );
                              },
                            }
                          : {}),
                        isLiveSendCapableMailInstance: (instanceId) => {
                          const collection = deps.collectionRegistry.get('mail', instanceId);
                          return collection !== undefined
                            && 'sendCapable' in collection
                            && collection.sendCapable === true
                            && 'send' in collection
                            && typeof collection.send === 'function';
                        },
                        ...(deps.receptionProjectionContactDeps
                          ? { contactDeps: deps.receptionProjectionContactDeps }
                          : {}),
                      });
                    })()
                  : undefined;
              // D-173 P5 — the drop branch's file-attach seam (a task with the
              // uploaded file attached, D-172). Built only when the annotation
              // store is up; absent → a work-entity projection carrying a
              // `file_id` fail-closes (never a silent drop of the upload).
              const annotationDeps = deps.annotationDeps;
              const attachFileEffect = annotationDeps
                ? await (async () => {
                    const { createReceptionAttachFileSeam } = await import(
                      '../../ports/reception/projection/reception-attach-file.js'
                    );
                    return createReceptionAttachFileSeam({
                      attachDeps: { annotationDeps, registry: deps.collectionRegistry },
                    });
                  })()
                : undefined;
              const projected = await runReceptionProjection(
                {
                  workEntityStore: deps.receptionProjectionWorkEntityStore ?? {},
                  ...(deps.formResponseStore !== undefined
                    ? { formResponseStore: deps.formResponseStore }
                    : {}),
                  ...(deps.resolveSealedVisitorEmail !== undefined
                    ? { resolveSealedVisitorEmail: deps.resolveSealedVisitorEmail }
                    : {}),
                  ...(deps.receptionProjectionContactDeps !== undefined
                    ? { contactDeps: deps.receptionProjectionContactDeps }
                    : {}),
                  ...(createCalendarEvent !== undefined ? { createCalendarEvent } : {}),
                  ...(createBooking !== undefined ? { createBooking } : {}),
                  ...(attachFileEffect !== undefined ? { attachFile: attachFileEffect } : {}),
                  now: () => Date.now(),
                },
                input,
              );
              // D-210 Phase C (§4b) — stamp the destination back onto the
              // submission row now that the approval has materialized it.
              // Shared with its tests so there is one implementation; see
              // `reception-resolved-pointer.ts` for why it is best-effort.
              const { writeResolvedPointerBack } = await import(
                '../../ports/reception/projection/reception-resolved-pointer.js'
              );
              writeResolvedPointerBack(deps.intakeFormSubmissionStore, input, projected);
              return projected;
            },
          }
        : {}),
      // D-145 PA10 follow-on — mail-body-read materializes a record's
      // full body (inline ≤64 KB or hydrated from CAS via blob_hash), so
      // it needs the blob store on top of the collection registry. Wired
      // only when the blob store is present — dbless / no-cache harnesses
      // have no CAS and therefore no >64 KB bodies to hydrate; the kernel
      // adapter then surfaces SERVER_NOT_REACHABLE for the slug.
      ...(deps.cacheBlobs
        ? {
            mailBodyRead: async (input) => {
              const { handleMailBodyRead } = await import('../../mail-body-read-handler.js');
              return handleMailBodyRead(
                { registry: deps.collectionRegistry, blobs: deps.cacheBlobs! },
                input,
              );
            },
          }
        : {}),
      // D-127 P2.1 — kernel mail-send dispatches through the same
      // collection.mail.send rpc handler as the wire-side rpc, so the
      // sender ≠ to guard, capability check, and `mail_send` audit row
      // (P1.6 + P1.7) all fire identically whether the call originated
      // from a kernel `mail-send` step or an external rpc client.
      mailSend: async (input) => {
        const { handleCollectionMailSend } = await import('../../collections/collection-handler.js');
        try {
          return await handleCollectionMailSend({ registry: deps.collectionRegistry }, input);
        } catch (err) {
          // A fenced send that ended without an outcome — this attempt, or an
          // earlier one a retry just ran into — is the OWNER's to settle: ask them
          // "Did this email go out?" (once per claim; it waits under the bell).
          // Best-effort: the failure below stands either way.
          const reconciliation_id = (input as { reconciliation_id?: unknown }).reconciliation_id;
          if (typeof reconciliation_id === 'string' && deps.db) {
            try {
              await raiseMailSendOutcomeAsk({
                notifier: deps.getExecuteDeps?.()?.preflightNotifier,
                claims: createMailSendClaimStore(deps.db),
                reconciliation_id,
                now: Date.now(),
              });
            } catch {
              /* the refusal still reaches the run; the next retry asks again */
            }
          }
          throw err;
        }
      },
      // D-210 §7 — notify a booking's visitor server-side. Wired only when the
      // link store + booking store + booking-PII key are ALL present (the
      // reception stack is up + the FileVault key source exists); absent ⇒ the
      // kernel case surfaces SERVER_NOT_REACHABLE like any unwired dispatcher.
      // The resolved visitor address never returns to the recipe — the seam
      // reports only { notified }. Delegates the actual send to the SAME
      // collection.mail.send path as mailSend above (capability check, sender ≠
      // to guard, mail_send audit), so a booking-visitor notice and a plain
      // recipe send are indistinguishable on the wire.
      // ⚠ Gated on the WORK-ENTITY store since D-210 A.2 (slice 3b), not the
      // annotation store: the seam reads the booking's own
      // `reception_record_id` instead of walking a `scheduled-from` link.
      ...(deps.receptionBookingMintStore
        && deps.receptionProjectionBookingStore
        && deps.getFormSubmissionPiiKey
        ? {
            notifyBookingVisitor: async (input) => {
              const { handleNotifyBookingVisitor } = await import(
                '../../ports/reception/notify-booking-visitor.js'
              );
              const { handleCollectionMailSend } = await import(
                '../../collections/collection-handler.js'
              );
              return handleNotifyBookingVisitor(
                {
                  readBooking: (id) => deps.receptionBookingMintStore!.readBooking(id),
                  findBooking: (request_id) =>
                    deps.receptionProjectionBookingStore!.findById(request_id),
                  getFormSubmissionPiiKey: deps.getFormSubmissionPiiKey!,
                  mailSend: (mailInput) =>
                    handleCollectionMailSend(
                      { registry: deps.collectionRegistry },
                      mailInput,
                      // D-210 audit finding 3b — promote the seam's own declaration
                      // into the TRUSTED third parameter. `notify-booking-visitor`
                      // sets this because its `to` is a sealed visitor address; the
                      // handler deliberately refuses to read the flag out of `args`,
                      // so a wire caller cannot suppress its own audit recipients.
                      {
                        redact_audit_recipients:
                          mailInput.redact_audit_recipients === true,
                      },
                    ),
                },
                input,
              );
            },
          }
        : {}),
      // D-122 follow-on — notification-send dispatcher bridge. Each
      // channel resolves to the user's first enrolled
      // `connection.notification.<name>` record matching the channel's
      // subtype (slack / telegram / email / in-app); dispatch routes
      // through the same connection-notification handler the connection
      // adapter uses, so re-enrollments + auth refreshes pick up
      // immediately. In-app needs no record (D-312). A channel with no
      // record surfaces in `failed[]` when the recipe named it; a send that
      // names none skips it, unless nothing got through at all.
      notificationSend: async (input) => {
        const { handleNotificationSend } = await import('../../notification-handler.js');
        return handleNotificationSend(
          { dispatchers: deps.notificationChannelDispatchers ?? {} },
          input as Parameters<typeof handleNotificationSend>[1],
        );
      },
      ...(deps.sharedStore && deps.inboundTokenStore && mcpCallbackContractDefinitions
        ? {
            notificationRecipeCallback: async (input) => {
              const { enqueueMcpRecipeCallback } = await import(
                '../../mcp-recipe-callback.js'
              );
              return enqueueMcpRecipeCallback(
                {
                  store: deps.sharedStore!,
                  inboundTokenStore: deps.inboundTokenStore!,
                  isContractLive: (contract_id) => {
                    const definition = mcpCallbackContractDefinitions.get(contract_id);
                    return definition !== null && isContractActive(definition, Date.now());
                  },
                  permitsMcpDoor: (contract_id) => {
                    const definition = mcpCallbackContractDefinitions.get(contract_id);
                    return definition !== null && contractPermitsDoorType(definition, 'mcp');
                  },
                },
                input,
              );
            },
          }
        : {}),
      mailDraft: async (method, input, meta) => {
        const draft = deps.getExecuteDeps?.()?.mailDraft;
        if (!draft) throw new Error('Saved drafts are unavailable until the owner service is ready.');
        return draft(method, input, meta);
      },
      // D-264 — same late-bound shape as `mailDraft` above: the owner service
      // composes the export dispatcher after this config is built, so the
      // lookup happens per call rather than at wiring time.
      mailDraftSaveToMailbox: async (input, meta) => {
        const exporter = deps.getExecuteDeps?.()?.mailDraftSaveToMailbox;
        if (!exporter) throw new Error('Exporting a draft to the mailbox is unavailable on this server.');
        return exporter(input, meta);
      },
      preapprovalRequest: async (input, meta) => {
        const request = deps.getExecuteDeps?.()?.preapprovalRequest;
        if (!request) throw new Error('Pre-approval requests are unavailable until the owner review service is ready.');
        return request(input, meta);
      },
      ...(deps.sellerStore
        ? {
            sellerOfferEnsure: async (input) => deps.sellerStore!.ensureOffer({
              ...input,
              now: Date.now(),
            }),
            sellerOfferFulfillmentAttach: async (input) =>
              deps.sellerStore!.attachOfferFulfillmentRecipe({
                ...input,
                now: Date.now(),
              }),
            sellerOfferGet: async (input) => ({
              offer: deps.sellerStore!.getOffer(input.offer_id),
            }),
            sellerOfferList: async (input) => ({
              offers: deps.sellerStore!.listOffers(input),
            }),
            // D-196 §4.5 — the vendor-neutral tier read. ⛔ Rows cross the
            // recipe boundary ONLY through `toPublicSellerTier` (an explicit
            // pick): `template_contract_id` — the private authority pointer —
            // and tier row ids never reach step state. The dispatcher slot is
            // typed on `SellerTierPublic`, so wiring the raw row here would
            // not compile.
            sellerTierGet: async (input) => {
              const tier = deps.sellerStore!.findTier(input);
              return { tier: tier === null ? null : toPublicSellerTier(tier) };
            },
            sellerTierList: async (input) => ({
              tiers: deps.sellerStore!.listTiers(input).map(toPublicSellerTier),
            }),
          }
        : {}),
      // ── D-207 §4.3 — core.seller.order ───────────────────────────────────
      // Thin pass-through by design. Every fence — the F5 evidence-phase refusal,
      // the underpay check, the F6 double-session conflict, the CAS — lives at the
      // STORAGE boundary, because this wiring is only one of the store's possible
      // callers and a check that guards a single door is not a fence.
      ...(deps.sellerOrderStore
        ? {
            sellerOrderOpen: async (input) =>
              deps.sellerOrderStore!.openOrder({ ...input, now: Date.now() }),
            sellerOrderGet: async (input) => ({
              order:
                input.order_handle !== undefined
                  ? deps.sellerOrderStore!.getOrderByHandle(input.order_handle)
                  : deps.sellerOrderStore!.getOrder(input.order_key!),
            }),
            sellerOrderList: async (input) => ({
              orders: deps.sellerOrderStore!.listOrders(input),
            }),
            sellerOrderQuote: async (input) =>
              deps.sellerOrderStore!.quoteOrder({ ...input, now: Date.now() }),
            sellerOrderAttachPayment: async (input) =>
              deps.sellerOrderStore!.attachOrderPayment({ ...input, now: Date.now() }),
            sellerOrderConfirmPayment: async (input) =>
              deps.sellerOrderStore!.confirmOrderPayment({
                order_key: input.order_key,
                expected_revision: input.expected_revision,
                evidence: input.evidence as never,
                now: Date.now(),
              }),
            sellerOrderConfirmRenewalPayment: async (input) =>
              deps.sellerOrderStore!.confirmOrderRenewalPayment({
                order_key: input.order_key,
                expected_revision: input.expected_revision,
                evidence: input.evidence as never,
                now: Date.now(),
              }),
            sellerOrderConfirmRefund: async (input) =>
              deps.sellerOrderStore!.confirmOrderRefund({
                order_key: input.order_key,
                expected_revision: input.expected_revision,
                evidence: input.evidence as never,
                now: Date.now(),
              }),
            // `input.artifact` is already a verified `PinnedCasFileRef` — the kernel
            // case re-read the bytes through `dataFileRead` and refused a mismatch
            // before we were reached. The store re-guards the carrier anyway.
            sellerOrderAttachArtifact: async (input) =>
              deps.sellerOrderStore!.attachOrderArtifact({ ...input, now: Date.now() }),
            sellerOrderTransition: async (input) =>
              deps.sellerOrderStore!.transitionOrder({ ...input, now: Date.now() }),
            sellerOrderLinkWorkEntity: async (input) =>
              deps.sellerOrderStore!.linkOrderWorkEntity({ ...input, now: Date.now() }),
            sellerOrderLinkCustomer: async (input) =>
              deps.sellerOrderStore!.linkOrderCustomer({ ...input, now: Date.now() }),
          }
        : {}),
      ...(deps.sellerStore && deps.contractStore && deps.inboundTokenStore
        ? {
            customerAccessIssue: async (input) => {
              const {
                lifecycle,
                toPublicClaim,
                deliverSellerCustomerClaimEmail,
                readSellerCustomerAfterClaimDelivery,
              } = await createCustomerAccessLifecycle();
              const result = lifecycle.issueCustomer(input);
              const claim = result.issued_claim === null
                ? null
                : toPublicClaim(result.issued_claim);
              const claim_email_delivery =
                result.result === 'created'
                && input.lifecycle_source !== 'manual'
                && result.issued_claim !== null
                && claim !== null
                  ? await deliverSellerCustomerClaimEmail({
                      deps: {
                        sellerStore: deps.sellerStore!,
                        isLiveSendCapableMailInstance: (instanceId) => {
                          const collection = deps.collectionRegistry.get(
                            'mail',
                            instanceId,
                          );
                          return collection !== undefined
                            && 'sendCapable' in collection
                            && collection.sendCapable === true
                            && 'send' in collection
                            && typeof collection.send === 'function';
                        },
                        sendClaimMail: async (mail) => {
                          const { handleCollectionMailSend } = await import(
                            '../../collections/collection-handler.js'
                          );
                          return handleCollectionMailSend(
                            { registry: deps.collectionRegistry },
                            {
                              instance: mail.instance_id,
                              to: [mail.to],
                              subject: mail.subject,
                              body_text: mail.body_text,
                            },
                          );
                        },
                      },
                      customer_id: result.customer.customer_id,
                      email: result.customer.email,
                      issued_claim: result.issued_claim,
                      public_claim: claim,
                    })
                  : null;
              return {
                result: result.result,
                customer: readSellerCustomerAfterClaimDelivery(
                  deps.sellerStore!,
                  result.customer,
                ),
                claim,
                claim_email_delivery,
              };
            },
            customerAccessExtend: async (input) => {
              const { lifecycle } = await createCustomerAccessLifecycle();
              // D-309 — how an end date was set is the server's to record: a
              // step, chat or MCP call naming one is a hand change, whatever it
              // claims. Dropped here, never forwarded.
              const { period_origin: _serverOnly, ...request } = input as typeof input
                & { readonly period_origin?: unknown };
              return { customer: lifecycle.extendCustomer(request) };
            },
            customerAccessSwapTier: async (input) => {
              const { lifecycle } = await createCustomerAccessLifecycle();
              return { customer: lifecycle.swapCustomerTier(input) };
            },
            customerAccessClose: async (input) => {
              const { lifecycle } = await createCustomerAccessLifecycle();
              return { customer: lifecycle.closeCustomer(input) };
            },
          }
        : {}),
      // D-145 PA3 — work-entity CRUD dispatchers. Composed via
      // `createWorkEntityDispatchers` (built above so the spread here
      // stays a plain object) which threads the storage layer + resolver
      // + (optional) per-vendor write hooks. Source resolution + write-
      // capability gate + commitment lifecycle state machine all live in
      // the composer — the bin-side wire is deliberately thin so re-
      // using the composer in test harnesses doesn't fork the production
      // behaviour. PA3 ships no vendor write hooks (HubSpot / Salesforce
      // task adapters land in PA4+); connection-Source writes surface
      // `SOURCE_NOT_WRITE_CAPABLE` until then.
      ...(deps.workEntityDispatchers ?? {}),
    } satisfies KernelDispatchers,
  };
};

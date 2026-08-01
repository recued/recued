/** D-149 P3 § A.3 — reception substrate composer.
 *
 *  Builds `receptionRpcDeps` (admin-only `reception.*` rpc surface) +
 *  `receptionPortDeps` (visitor-facing path-router) from the per-pair
 *  stores composed at module top in `bin.ts`. Both deps share the same
 *  registry / cache / rate-limiter / preview-hash stores + the same
 *  reception pepper closure so visitor + admin paths always see the
 *  same bytes; the helper enforces that single-source invariant in one
 *  place.
 *
 *  Gate parity with the pre-extraction `if`: returns `undefined` when
 *  ANY of the six required handles (`publicEndpointRegistryStore` /
 *  `receptionRegistryCache` / `receptionRateLimiter` / `previewHashStore`
 *  / `auditLog` / `keys`) is missing. Optional store refs are passed
 *  through as conditional spreads — when absent the corresponding
 *  per-kind handler degrades to the dispatcher's 503 stub (matching the
 *  P5/P6/P7/P8 boot-phase posture).
 *
 *  Cryptographic separation preserved field-by-field:
 *    1. Reception pepper — `deriveReceptionPepperFromSubDek` (HKDF info
 *       `'reception/source-ip-pepper'` per `server-secret-pepper.ts`).
 *    2. Booking PII — RETIRED (D-210 A.8 s4b-ii); was `deriveBookingPiiKeyFromSubDek` (distinct HKDF
 *       info per `booking-pii.ts`).
 *    3. Form PII — `deriveFormSubmissionPiiKeyFromSubDek`.
 *    4. Drop PII — `deriveDropBlobPiiKeyFromSubDek`.
 *    5. Approval PII — `deriveApprovalIntentPiiKeyFromSubDek`.
 *  Each derivation happens per-call (no in-process memoisation) so a
 *  `KeyManager.lock()` zeroisation takes effect immediately for every
 *  visitor path (Codex P2 #2 fold from the pre-extraction comment).
 *
 *  Side effect: registers the `reception-rate-snapshot` background
 *  interval with the provided registry (30s cadence; `onStop` emits one
 *  final snapshot at shutdown so the SQLite row reflects live in-memory
 *  state). Both the tick + onStop bodies swallow errors per the
 *  pre-extraction pattern. */

import type { AuditLogStore } from '@recued/storage';
import type { TrustFooterDeploymentMode } from '@recued/contracts';
import type { EventBus } from '../../events/bus.js';
import type { KeyManager } from '../../key-manager.js';
import type {
  ReceptionBroadcastEvent,
  ReceptionRpcDeps,
} from '../../reception-rpc-handler.js';
import type { ReceptionPortHandlerDeps } from '../../ports/reception/handler.js';
import type { PublicEndpointRegistryStore } from '../../storage/public-endpoint-registry-store.js';
import type { ReceptionRegistryCache } from '../../ports/reception/registry-cache.js';
import type { ReceptionRateLimiter } from '../../ports/reception/rate-limiter.js';
import type { PreviewHashStore } from '../../ports/reception/preview-hash.js';
import type { SchedulingFormNonceStore } from '../../ports/reception/handlers/scheduling-link.js';
import { NULL_SCHEDULING_CALENDAR_EVENTS_READER } from '../../ports/reception/handlers/scheduling-link.js';
import type { FormSubmissionStore } from '../../storage/reception-form-store.js';
import type { ReceptionIntakeRecipePairStore } from '../../storage/reception-intake-recipe-pair-store.js';
import type { IntakeFormNonceStore } from '../../ports/reception/handlers/intake-form.js';
import type { RecipeStore } from '../../recipe-store.js';
import type { ConnectionStoreSqlite } from '../../storage/connection-store.js';
import type { DropBlobStore } from '../../storage/reception-drop-store.js';
import type { DropLinkNonceStore } from '../../ports/reception/handlers/drop-link.js';
import type { ApprovalIntentStore } from '../../storage/reception-approval-store.js';
import type { ApprovalLinkNonceStore } from '../../ports/reception/handlers/approval-link.js';
import type { StatusProjectionStore } from '../../storage/reception-status-projection-store.js';
import type { StatusEntitySourceReader } from '../../ports/reception/handlers/status-link.js';
import type { ReceptionIpBlockStore } from '../../storage/reception-ip-block-store.js';
import type { HostnameRegistryStore } from '../../storage/hostname-registry.js';
import type Database from 'better-sqlite3';
import type { BlobStore } from '../../storage/blob-store.js';
import type { ReceptionUploadService } from '../../upload/reception-upload-service.js';
import type { InboundFileCollection } from '../../collections/file/inbound-file-collection.js';
import type { AnnotationRpcDeps } from '../../annotation-handler.js';
import type { CollectionRegistry } from '../../collections/registry.js';
import type { ContactStore } from '../../storage/contact-store.js';
import type { BackgroundServiceRegistry } from './wire-background-services.js';
import { composeReceptionComposePropose } from './wire-reception-compose-propose.js';
// Value imports are deferred to the drain-registration site below (dynamic
// import) to match this module's lazy-load posture — keeping the processor
// (and its transitive form-pii / work-entity imports) out of the static
// graph so a partial form-pii mock in the harness can't trip module load.
import type {
  FireReceptionWorkflow,
  ReceptionSubmissionProcessor,
} from '../../ports/reception/reception-drain.js';
import type { WatchSourceStatusEntry } from '@recued/contracts';
import type { WarehouseEventBus } from '@recued/warehouse-events';
import {
  getDefaultWatchSourceRegistry,
  receptionSourceKey,
  type WatchSourceRegistry,
} from '../../watch/source-registry.js';
import type { ReceptionMaterializeStore } from '../../ports/reception/processors/intake-form-processor.js';
import type { LlmSubstrate } from './wire-llm-substrate.js';
import type { SellerClaimStore } from '../../storage/seller-claim-store.js';
import type { SharedStore } from '../../storage/shared-store.js';
import type { WorkEntityStore } from '../../storage/work-entity-store.js';
import type { SellerOrderStore } from '../../storage/seller-order-store.js';
import type { SellerStore } from '../../storage/seller-store.js';
import { createPaidDocumentDirectCheckoutReviewAdmission } from '../../paid-document-direct-checkout-review-admission.js';
// D-207 slice 1c — the reception door: what a bind mints, and what a submit runs.
import type { ExecuteHandlerDeps } from '../../execute-handler.js';
import type { ReceptionDoorBindDeps } from '../../reception-door-bind.js';
import type { ReceptionRecipeRunner } from '../../reception-recipe-runner.js';
import type { OpResolver } from '../../derive-recipe-capability.js';
import type { ContractDefinitionStore } from '../../storage/contract-definition-store.js';
import type { ContractGrantEntryStore } from '../../storage/contract-grant-entry-store.js';
import type { DishStore } from '../../dish-store.js';
// D-210 Appendix B — the on-the-go `/reception/manage` reschedule door.
import type { ReceptionManageCredentialStore } from '../../storage/reception-manage-credential-store.js';
import type { ReceptionManageRescheduleRunner } from '../../reception-manage-runner.js';
import { DEFAULT_LOCAL_CALENDAR_SLUG } from '../../collections/calendar/local-provider.js';
import type { RecordsStore } from '../../records/store.js';
import { assertRecordsNonOwnerRecipeExposure } from '../../records/non-owner-exposure.js';

/** Inputs to `composeReceptionSubstrate`. The six "required" handles
 *  gate the whole branch (mirroring the pre-extraction `if`); the
 *  eleven "optional" store refs are conditional spreads, dropped when
 *  undefined so each downstream `get…` field stays absent + the
 *  dispatcher's 503-stub fallback engages.
 *
 *  `eventBus` + `dbPath` + `backgroundServices` are always present at
 *  the caller's site (`cmdServe`); typing them as non-optional makes
 *  the helper crash early if a future caller forgets one. */
export interface ComposeReceptionSubstrateDeps {
  // Required gate handles
  readonly publicEndpointRegistryStore: PublicEndpointRegistryStore | undefined;
  readonly receptionRegistryCache: ReceptionRegistryCache | undefined;
  readonly receptionRateLimiter: ReceptionRateLimiter | undefined;
  readonly previewHashStore: PreviewHashStore | undefined;
  readonly auditLog: AuditLogStore | undefined;
  readonly keys: KeyManager | undefined;

  // Always-present caller-supplied infra
  readonly eventBus: EventBus;
  readonly dbPath: string;
  readonly backgroundServices: BackgroundServiceRegistry;
  readonly executeRecuedRequestPersist: import('@recued/middleware/orchestrator/index.js').ExecuteRecuedRequestContext['persist'] | undefined;
  readonly llmConfig: LlmSubstrate['llmConfig'];
  readonly llmQuota: LlmSubstrate['llmQuota'] | undefined;
  readonly llmAdapterRegistry: LlmSubstrate['llmAdapterRegistry'] | undefined;
  readonly emptyTabProbe: LlmSubstrate['emptyTabProbe'] | undefined;
  readonly hostnameRegistryStore?: Pick<HostnameRegistryStore, 'list'> | undefined;

  // Optional store refs — caller passes the same let-binding refs it
  // holds today; undefined → field omitted on the produced deps.
  readonly approvalIntentStore: ApprovalIntentStore | undefined;
  readonly statusProjectionStore: StatusProjectionStore | undefined;
  /** D-149 P9 § A.5.6 — production status_link entity-source reader,
   *  pre-built by the caller from the work-entity warehouse (+ optional
   *  contact store). Present together with `statusProjectionStore` flips
   *  `statusLinkReady` true so the dispatcher serves the live projection;
   *  absent ⇒ the dispatcher falls back to the kind-registry 503 stub. */
  readonly statusEntitySourceReader?: StatusEntitySourceReader | undefined;
  /** D-149 § A.5.3 — work-entity warehouse write-slice for the submission
   *  drain (intake_form → task / note / commitment materialization).
   *  Present together with `intakeFormSubmissionStore` registers the
   *  drain processor; absent ⇒ no drain (boot phase). */
  readonly workEntityStore?: ReceptionMaterializeStore | undefined;
  /** D-207 slice 3c — the seller substrate the reception RUNNER opens an order against
   *  when a paired recipe's config names an offer (§4.4: an order exists iff there is an
   *  offer). Also serves the rpc handler's offer read (`getSellerOfferStore`). */
  readonly sellerOfferStore?: Pick<SellerStore, 'getOffer'> | undefined;
  readonly sellerOrderStore?: Pick<SellerOrderStore, 'openOrder'> | undefined;
  readonly sharedStore?: Pick<SharedStore, 'read' | 'compareAndSet'> | undefined;
  /** D-173 P3 § A.7 — the review-then-approve dispatch seam (the SINGLE path
   *  for REVIEW-mode endpoints, the default). Threaded into both drain
   *  processors so a pending submission fires the compiled `review-then-approve`
   *  recipe (held at the D-157 gate → inbox). Absent (boot phase before the
   *  engine composes, or a deployment with no reception core-pack) ⇒ review-mode
   *  rows stay pending to dispatch once the recipe lands (NEVER auto-materialized
   *  — that would bypass review, I-1). Auto-accept endpoints materialize directly
   *  and never use it (A.7). */
  readonly fireReceptionWorkflow?: FireReceptionWorkflow | undefined;
  readonly ipBlockStore: ReceptionIpBlockStore | undefined;
  readonly schedulingFormNonceStore: SchedulingFormNonceStore | undefined;
  readonly intakeFormSubmissionStore: FormSubmissionStore | undefined;
  /** D-200 Slice 6g.2 — compact pair registry plus current saved recipes.
   * Pair storage enables the resolver; a missing recipe store makes any
   * configured row stale rather than silently generic. */
  readonly intakeRecipePairStore?: ReceptionIntakeRecipePairStore | undefined;
  readonly recipeStore?: RecipeStore | undefined;
  /** D-221 — exact installed Records operation inventory for the reception
   * exposure gate. */
  readonly recordsStore?: RecordsStore | undefined;
  /** D-200 Slice 6g.10 — exact recipe-pinned Stripe/template readiness. */
  readonly connectionStore?: Pick<ConnectionStoreSqlite, 'get'> | undefined;
  readonly intakeFormNonceStore: IntakeFormNonceStore | undefined;
  readonly dropBlobStore: DropBlobStore | undefined;
  readonly blobStore: BlobStore | undefined;
  readonly dropLinkNonceStore: DropLinkNonceStore | undefined;
  /** D-172 step 5a — the per-pair SQLite handle, used to build the SHARED
   *  `upload_session` store backing the reception resumable-upload service.
   *  Present together with `blobStore` + `dropBlobStore` + `dropLinkNonceStore`
   *  wires the `…/uploads` HTTP endpoints; absent ⇒ the single-POST stays the
   *  only upload path. */
  readonly db?: Database.Database | undefined;
  readonly approvalLinkNonceStore: ApprovalLinkNonceStore | undefined;
  /** D-172 P3 § A.5 — the `received` inbound-file collection (`ingest`).
   *  Present together with `dropBlobStore` + `attachFileDeps` registers
   *  the drop_link drain processor; absent ⇒ no drop drain (boot phase /
   *  file substrate not composed). */
  readonly inboundFileCollection?: InboundFileCollection | undefined;
  /** D-172 P3 § A.5 — `attachFile` deps (annotation store + collection
   *  registry). Gates the drop drain alongside `inboundFileCollection`. */
  readonly attachFileDeps?:
    | { annotationDeps: AnnotationRpcDeps; registry: CollectionRegistry }
    | undefined;
  /** D-172 P3 § A.5 — resolve the pre-bound `contact_scoping.contact_id`
   *  → canonical email for the drop contact-attach + the
   *  `require_contact_email_match` check. Optional: absent ⇒ a
   *  `auto_attach_to_contact` config still ingests + project-attaches but
   *  withholds the contact edge. */
  readonly contactStore?: Pick<ContactStore, 'getByContactId'> | undefined;
  /** WatchSource reception push source — the warehouse bus verified
   *  mutation arrivals emit on (`data.reception.<kind>.request.created`).
   *  Absent => no arrival events (pre-warehouse harness). */
  readonly warehouseBus?: WarehouseEventBus | undefined;
  /** WatchSource governance registry. Defaults to the process-wide
   *  registry; tests inject an isolated instance. */
  readonly watchSourceRegistry?: WatchSourceRegistry | undefined;
  /** D-196 S3b — sealed one-time customer claim store. */
  readonly sellerClaimStore?: SellerClaimStore | undefined;
  /** D-210 Appendix B — single-use, per-record credentials for the on-the-go
   *  `/reception/manage` reschedule link. Built upstream (`compose-app-context`)
   *  beside the claim store. Absent ⇒ the manage path 404s (the runner + these
   *  credentials are both required for the surface). */
  readonly receptionManageCredentialStore?: ReceptionManageCredentialStore | undefined;

  // ── D-207 slice 1c — the reception door ────────────────────────────────────────────
  /** The contract substrate a door is minted into — the SAME instances the Gateway reads
   *  its verdicts from (threaded down from `wire-execute-deps`, never rebuilt here).
   *  Absent (dbless) ⇒ no door can be hung ⇒ `intake_recipe_pair.bind` refuses any recipe
   *  that would need one, instead of saving a pair whose form hard-denies every submit. */
  readonly contractDefinitionStore?: ContractDefinitionStore | undefined;
  readonly grantEntryStore?: ContractGrantEntryStore | undefined;
  /** The engine handle the gated runner dispatches through. Present ⇒ a bound door's recipe
   *  actually RUNS on a public submit; absent (boot phase) ⇒ the pair keeps whatever path
   *  owned it before. */
  readonly executeDeps?: ExecuteHandlerDeps | undefined;
  /** D-179 — the dish store. A recipe's install config lives on its `is_default` dish's
   *  `config_overlay`, and that is what the capability derivation must resolve
   *  `{{config.*}}` through: the same values `handleExecute` merges at fire. Deriving from
   *  `recipe.variables` instead refuses most of the shipped library. */
  readonly dishStore?: Pick<DishStore, 'listByRecipe'> | undefined;
  /** Maps an ingredient's catalog slug + `input.operation` back to the canonical op id(s)
   *  it dispatches, so an ingredient-step contributes a GRANT and not just a slug. Absent ⇒
   *  ingredient steps contribute no op id, which under-derives the closure — and an
   *  under-derived closure is a door that hard-denies mid-run on an op the owner was never
   *  shown. Wire it. */
  readonly resolveRecipeOp?: OpResolver | undefined;
  /** D-207 slice 3c — op id → risk tier for the installed pack catalogs. The bind falls
   *  back to the kernel registry, so this need only answer for pack ops. */
  readonly resolveRecipeOpRisk?: ((opId: string) => string | undefined) | undefined;
}

/** The explicit "no trigger bus was composed" stand-in for the D-210 WS2
 *  form_response fan-out. Named rather than inlined so a reader can see that
 *  the warehouse half of the fan-out is genuinely absent on a pre-warehouse
 *  harness, instead of reading a `{ emit: () => {} }` literal as live wiring. */
/** Bundle returned to the caller. Both fields populated together — if
 *  the gate fires the helper returns `undefined` (caller leaves both
 *  let-bindings untouched). */
export interface ReceptionSubstrateBundle {
  readonly receptionRpcDeps: ReceptionRpcDeps;
  readonly receptionPortDeps: ReceptionPortHandlerDeps;
}

/** Compose the D-149 P3 reception substrate. Async because the per-kind
 *  PII derivation modules + the pepper / `RpcError` / `node:path`
 *  primitives are dynamically imported (matches the pre-extraction
 *  posture — keeps the helper's module-load cost off the dbless harness
 *  paths even though `cmdServe` is its only caller today). */
export const composeReceptionSubstrate = async (
  deps: ComposeReceptionSubstrateDeps,
): Promise<ReceptionSubstrateBundle | undefined> => {
  if (
    !deps.publicEndpointRegistryStore
    || !deps.receptionRegistryCache
    || !deps.receptionRateLimiter
    || !deps.previewHashStore
    || !deps.auditLog
    || !deps.keys
  ) {
    return undefined;
  }

  // Local alias bindings — match the pre-extraction names so the body
  // reads identical to the inline block + the broadcast / per-call
  // closures capture stable references (not the wider let-bindings).
  const registryStore = deps.publicEndpointRegistryStore;
  const registryCache = deps.receptionRegistryCache;
  const rateLimiter = deps.receptionRateLimiter;
  const previewStore = deps.previewHashStore;
  const auditLog = deps.auditLog;
  const eventBus = deps.eventBus;
  const hostnameRegistryStore = deps.hostnameRegistryStore;

  const { deriveReceptionPepperFromSubDek } = await import(
    '../../ports/reception/server-secret-pepper.js'
  );
  const { RpcError } = await import('@recued/contracts');
  const { canBindHostname, isProDdnsHost } = await import('@recued/contracts');
  const receptionKeyProvider = deps.keys.keyProvider('reception');

  // Codex P2 #1 fold (pre-extraction) — surface locked-vault state with
  // a coded `not_configured` RpcError (503) so the rpc dispatcher emits
  // a typed wire envelope instead of falling through to `internal_error`
  // / 500. Codex P2 #2 fold (pre-extraction) — no in-process pepper
  // memoisation so `KeyManager.lock()` zeroisation takes effect
  // immediately.
  const getReceptionPepper = (): Buffer => {
    const subDek = receptionKeyProvider();
    if (!subDek) {
      throw new RpcError(
        'not_configured',
        'reception: pepper unavailable — FileVault locked or KeyManager uninitialised',
        503,
      );
    }
    return deriveReceptionPepperFromSubDek(subDek);
  };

  const configuredShareBaseUrl = ((): string | null => {
    const raw = process.env.RECUED_PUBLIC_BASE_URL?.trim();
    if (raw && raw.length > 0) return raw.replace(/\/+$/, '');
    return null;
  })();

  const localShareHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

  const isPublicShareBaseUrl = (raw: string | null): raw is string => {
    if (raw === null) return false;
    try {
      const parsed = new URL(raw);
      return (
        (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
        parsed.hostname.length > 0 &&
        !localShareHosts.has(parsed.hostname.toLowerCase())
      );
    } catch {
      return false;
    }
  };

  const deriveShareBaseUrlFromHostnameRegistry = (): string | null => {
    if (!hostnameRegistryStore) return null;

    for (const hostname of hostnameRegistryStore.list()) {
      if (!canBindHostname(hostname)) continue;
      const port = hostname.listener_ports.includes(443)
        ? 443
        : hostname.listener_ports[0];
      if (port === undefined) continue;

      const candidate = port === 443
        ? `https://${hostname.hostname}`
        : `https://${hostname.hostname}:${port}`;
      if (isPublicShareBaseUrl(candidate)) return candidate;
    }

    return null;
  };

  const resolveShareBaseUrl = (): string | null => {
    if (isPublicShareBaseUrl(configuredShareBaseUrl)) {
      return configuredShareBaseUrl;
    }
    return deriveShareBaseUrlFromHostnameRegistry();
  };

  const getShareBaseUrl = (): string => {
    const shareBaseUrl = resolveShareBaseUrl();
    if (!shareBaseUrl) {
      throw new RpcError(
        'not_configured',
        'reception: set RECUED_PUBLIC_BASE_URL or configure a verified public hostname before sharing reception endpoints',
        503,
      );
    }
    return shareBaseUrl;
  };

  // D-149 P12 § A.20.7 — Public Trust Footer deployment mode. A
  // `<handle>.recued.cloud` host is the Pro auto-managed path
  // (`pro_cloud`); every other host (BYO DDNS / custom domain /
  // localhost) is `byo_ddns`. Malformed base URL falls back to the
  // conservative `byo_ddns` copy.
  const receptionDeploymentMode: TrustFooterDeploymentMode = ((): TrustFooterDeploymentMode => {
    if (configuredShareBaseUrl === null) return 'byo_ddns';
    try {
      return isProDdnsHost(new URL(configuredShareBaseUrl).hostname) ? 'pro_cloud' : 'byo_ddns';
    } catch {
      return 'byo_ddns';
    }
  })();

  // Codex P1 #4 fold (pre-extraction) — default false. Direct LAN /
  // public listeners MUST NOT trust caller-supplied XFF.
  const trustProxyEnv = process.env.RECUED_RECEPTION_TRUST_PROXY?.trim();
  const trustForwardedFor = trustProxyEnv === 'true' || trustProxyEnv === '1';

  const broadcastReceptionEvent = (event: ReceptionBroadcastEvent): void => {
    eventBus.emit(event);
    if (event.kind === 'reception.endpoint_changed') {
      registryCache.invalidate(event.endpoint_id);
    } else if (event.kind === 'reception.emergency_disabled') {
      registryCache.flush();
    }
  };

  const composePropose = composeReceptionComposePropose({
    llmConfig: deps.llmConfig,
    llmQuota: deps.llmQuota,
    llmAdapterRegistry: deps.llmAdapterRegistry,
    emptyTabProbe: deps.emptyTabProbe,
    now: () => Date.now(),
    ...(deps.executeRecuedRequestPersist
      ? { persist: deps.executeRecuedRequestPersist }
      : {}),
  });

  const receptionRpcDepsBase: ReceptionRpcDeps = {
    getStore: () => registryStore,
    getPreviewStore: () => previewStore,
    getPepper: getReceptionPepper,
    getShareBaseUrl,
    auditLog,
    broadcast: broadcastReceptionEvent,
    now: () => Date.now(),
    preflightEnable: ({ endpoint: _endpoint }) => {
      // D-173 P4.2 (N.3 "Enable" gate) — the scheduling_link enable
      // hard-block is LIFTED. D-149 blocked scheduling on "requires the
      // production calendar availability reader"; D-173 reframes bookings
      // as review-by-default proposals (D7): a booking materializes a
      // local commitment held at the Reception Inbox, and free/busy-vs-
      // your-calendar availability is OUT OF SCOPE (you confirm at
      // approval). Slot availability comes from the owner's
      // `explicit_windows`, not a live calendar read — so the cold-start
      // null calendar reader (no busy events) is the correct production
      // posture. The only remaining enable requirement is a public URL.
      if (resolveShareBaseUrl()) {
        return { ok: true, passed: ['Public Reception URL is configured'] };
      }
      return {
        ok: false,
        blocked: ['Set a public URL before enabling Reception endpoints'],
      };
    },
    // D-149 P8 § A.5.5 — seed the per-endpoint approval intent row at
    // create time so the visitor consume flow has a target to atomically
    // flip. Optional dep: when absent the rpc still accepts
    // approval_link creates; the visitor consume path degrades to the
    // placeholder until the store is wired.
    ...(deps.approvalIntentStore
      ? { getApprovalIntentStore: () => deps.approvalIntentStore! }
      : {}),
    // D-149 P9 § A.5.6 — seed the per-endpoint status projection row at
    // create time so the visitor GET path has a target to read.
    ...(deps.statusProjectionStore
      ? { getStatusProjectionStore: () => deps.statusProjectionStore! }
      : {}),
    // D-149 P12 § A.20.5 — Abuse Inbox IP block store for the
    // `reception.abuse_inbox.*` rpc trio.
    ...(deps.ipBlockStore ? { getIpBlockStore: () => deps.ipBlockStore! } : {}),
    // D-200 Slice 6g.3 — paired-client exact form/recipe authoring.
    ...(deps.intakeRecipePairStore
      ? { getIntakeRecipePairStore: () => deps.intakeRecipePairStore! }
      : {}),
    ...(deps.recipeStore ? { getRecipeStore: () => deps.recipeStore! } : {}),
    ...(deps.recordsStore
      ? {
          preflightNonOwnerRecipeExposure: (
            recipe: import('@recued/contracts').RecipeDefinition,
          ) => assertRecordsNonOwnerRecipeExposure(
            recipe,
            'reception',
            {
              isOperationId: (operationId) =>
                deps.recordsStore!.isInstalledOperationId(operationId),
              isCatalogOperation: (catalogSlug, operationKey) =>
                deps.recordsStore!.isInstalledCatalogOperation(catalogSlug, operationKey),
            },
          ),
        }
      : {}),
    ...(deps.connectionStore
      ? { getConnectionStore: () => deps.connectionStore! }
      : {}),
    ...(deps.inboundFileCollection
      ? { getInboundFileCollection: () => deps.inboundFileCollection! }
      : {}),
    ...(deps.sellerOfferStore
      ? { getSellerOfferStore: () => deps.sellerOfferStore! }
      : {}),
    ...(composePropose ? { composePropose } : {}),
  };

  // D-210 A.8 slice 4b-ii — the booking-PII key stream is RETIRED here. A
  // booking's fields are sealed under the FORM-submission key below, because a
  // booking row is a `reception_form_submission` row and its readers open with
  // that key (`booking-blob.ts`). Slice 4c then DELETED `booking-pii.ts` — by
  // then nothing in the wired graph reached for it.

  // D-149 P6 § A.5.3 — form-submission PII AEAD key. Distinct HKDF info per
  // stream keeps drop / approval / form cryptographically separate.
  const { deriveFormSubmissionPiiKeyFromSubDek } = await import(
    '../../ports/reception/form-pii.js'
  );
  const getIntakeFormSubmissionPiiKey = (): Uint8Array => {
    const subDek = receptionKeyProvider();
    if (!subDek) {
      throw new RpcError(
        'not_configured',
        'reception: form-PII key unavailable — FileVault locked or KeyManager uninitialised',
        503,
      );
    }
    return deriveFormSubmissionPiiKeyFromSubDek(subDek);
  };

  // D-149 P7 § A.5.4 — drop-blob PII AEAD key. DISTINCT HKDF info from
  // booking-PII + form-PII.
  const { deriveDropBlobPiiKeyFromSubDek } = await import(
    '../../ports/reception/drop-pii.js'
  );
  const getDropBlobPiiKey = (): Uint8Array => {
    const subDek = receptionKeyProvider();
    if (!subDek) {
      throw new RpcError(
        'not_configured',
        'reception: drop-PII key unavailable — FileVault locked or KeyManager uninitialised',
        503,
      );
    }
    return deriveDropBlobPiiKeyFromSubDek(subDek);
  };

  // D-149 P7 § A.5.4 — drop_blobs filesystem root. Resolved against the
  // SQLite database's parent directory so a moved data dir keeps blobs
  // co-located with their metadata rows. The handler creates the
  // directory tree lazily.
  const { resolve, dirname } = await import('node:path');
  const dropBlobsRoot = resolve(dirname(deps.dbPath), 'drop_blobs');
  const getDropBlobsRoot = (): string => dropBlobsRoot;

  // D-172 step 5a — the reception consumer of the shared resumable-upload core.
  // Built when the db handle + CAS + drop store + nonce store are all wired
  // (PII key + audit log are guaranteed by the gate above). The scratch root is
  // the SAME `upload_blobs` data-volume sibling the webclient consumer uses —
  // one shared `upload_session` table + one shared scratch root for the one
  // shared core, so the already-registered `upload-session-sweep` housekeeping
  // task reaps reception's sessions too (global `listExpired` + shared orphan
  // dir). Absent ⇒ the dispatcher 404s the `…/uploads` sub-tree and the JS-free
  // single-POST stays the only upload path.
  let receptionUploadService: ReceptionUploadService | undefined;
  if (deps.db && deps.blobStore && deps.dropBlobStore && deps.dropLinkNonceStore) {
    const { createReceptionUploadService } = await import(
      '../../upload/reception-upload-service.js'
    );
    const dropBlobStoreForUpload = deps.dropBlobStore;
    const dropLinkNonceStoreForUpload = deps.dropLinkNonceStore;
    receptionUploadService = createReceptionUploadService({
      db: deps.db,
      blobs: deps.blobStore,
      uploadsRoot: resolve(dirname(deps.dbPath), 'upload_blobs'),
      dropBlobStore: dropBlobStoreForUpload,
      getStore: () => registryStore,
      getDropLinkNonceStore: () => dropLinkNonceStoreForUpload,
      getDropBlobPiiKey,
      auditLog,
      invalidateRegistryCache: (id) => registryCache.invalidate(id),
    });
  }

  // D-149 P8 § A.5.5 — approval-intent PII AEAD key. DISTINCT HKDF info
  // from booking-PII + form-PII + drop-PII.
  const { deriveApprovalIntentPiiKeyFromSubDek } = await import(
    '../../ports/reception/approval-pii.js'
  );
  const getApprovalIntentPiiKey = (): Uint8Array => {
    const subDek = receptionKeyProvider();
    if (!subDek) {
      throw new RpcError(
        'not_configured',
        'reception: approval-PII key unavailable — FileVault locked or KeyManager uninitialised',
        503,
      );
    }
    return deriveApprovalIntentPiiKeyFromSubDek(subDek);
  };

  // D-173 P4.2 § N.3/D7 — wire the COLD-START null calendar reader. The
  // D-149 decision (fold P1 #2, 2026-05-13) left this unwired because a
  // null reader returning `[]` made `computeFreeWindows` treat the whole
  // look-ahead as free — a free/busy leak against a real-but-unwired
  // calendar. D-173 retires that concern: free/busy-vs-your-calendar
  // availability is OUT OF SCOPE (D7) — slot availability is the owner's
  // declared `explicit_windows` (intersected at
  // `intersectWithAvailabilityWindows`), the booking materializes a
  // review-by-default commitment held at the Reception Inbox, and the
  // owner confirms at approval. So the null reader (no busy events) is the CORRECT
  // production posture for cold-start scheduling, and wiring it
  // completes the three scheduling deps so the dispatcher serves the
  // visitor slot picker instead of the 503 stub. A future connected
  // calendar source replaces this with a real busy-event reader.
  const getSchedulingCalendarReader = (): typeof NULL_SCHEDULING_CALENDAR_EVENTS_READER =>
    NULL_SCHEDULING_CALENDAR_EVENTS_READER;
  const watchSourceRegistry = deps.watchSourceRegistry ?? getDefaultWatchSourceRegistry();

  let resolveIntakeFormRecipePair:
    | NonNullable<ReceptionPortHandlerDeps['resolveIntakeFormRecipePair']>
    | undefined;
  if (deps.intakeRecipePairStore) {
    const [
      { resolveReceptionIntakeRecipePair },
      { deriveReceptionIntakeRecipePairBinding },
    ] = await Promise.all([
      import('../../ports/reception/intake-recipe-pair.js'),
      import('../../reception-intake-recipe-pair-derivation.js'),
    ]);
    const pairStore = deps.intakeRecipePairStore;
    const recipeStore = deps.recipeStore;
    resolveIntakeFormRecipePair = ({ endpoint_id, form_config }) =>
      resolveReceptionIntakeRecipePair({
        endpoint_id,
        form_config,
        store: pairStore,
        getRecipe: (recipeId) => recipeStore?.get(recipeId) ?? null,
        deriveBinding: deriveReceptionIntakeRecipePairBinding,
      });
  }

  // ── D-207 slice 1c — THE DOOR ────────────────────────────────────────────────────────
  //
  // Two halves, composed together because neither is any use alone:
  //
  //   `doorBindDeps` — what the owner's `intake_recipe_pair.bind` rpc mints a door WITH.
  //                    Absent ⇒ bind refuses (`not_configured`) rather than saving a pair
  //                    whose form would look live and hard-deny every submission.
  //   `receptionRecipeRunner` — what actually RUNS a bound door's recipe on submit, through
  //                    `handleExecute` with an `(reception, anonymous, contract_id)` source.
  //
  // Both hang off the SAME contract stores the Gateway reads (threaded down from
  // `wire-execute-deps`, never rebuilt here) so a grant the mint writes is a grant the gate
  // can see. The dish's `config_overlay` is the config the derivation resolves `{{config.*}}`
  // through — the same source the engine will merge at fire (D-179: a Recipe is a pure paper
  // record; its values live on the dish), so what the owner consents to is what runs.
  let doorBindDeps: ReceptionDoorBindDeps | undefined;
  let receptionRecipeRunner: ReceptionRecipeRunner | undefined;
  // D-210 Appendix B — the held-reschedule runner for the `/reception/manage`
  // door. Built alongside `receptionRecipeRunner` (both need the same contract
  // stores + `executeDeps`), and its door contract is minted directly (see the
  // seed below). Left undefined without `executeDeps` ⇒ the manage path 404s.
  let manageRescheduleRunner: ReceptionManageRescheduleRunner | undefined;
  if (deps.intakeRecipePairStore
    && deps.contractDefinitionStore
    && deps.grantEntryStore) {
    const pairStore = deps.intakeRecipePairStore;
    const definitionStore = deps.contractDefinitionStore;
    const grantEntryStore = deps.grantEntryStore;
    const dishStore = deps.dishStore;
    const resolveOp = deps.resolveRecipeOp;
    const resolveOpRisk = deps.resolveRecipeOpRisk;

    // D-179 — the recipe's INSTALL config lives on its `is_default` dish; deriving from
    // `recipe.variables` instead would refuse most of the shipped library outright.
    //
    // ⛔ ONE function, deliberately shared by the BIND and the RUN. The bind resolves
    // `{{config.*}}` to derive the door's op closure (a step's CONNECTION lives there) and
    // shows the owner that list as the consent moment; the run must resolve the SAME values
    // or the owner consented to a run that cannot happen. Two lambdas here would be two
    // derivations that can drift — pass the identical reference to both. (D-209 #1 W2b:
    // the construction itself now lives in `recipe-capability-wiring.ts`, shared with the
    // webhook door's save/install wiring for the same reason.)
    const { composeInstallConfigResolver } = await import(
      '../../recipe-capability-wiring.js'
    );
    const resolveInstallConfig = composeInstallConfigResolver(dishStore);

    doorBindDeps = {
      pairStore,
      definitionStore,
      grantEntryStore,
      now: () => Date.now(),
      resolveConfig: resolveInstallConfig,
      ...(resolveOp ? { resolveOp } : {}),
      ...(resolveOpRisk ? { resolveOpRisk } : {}),
    };

    if (deps.executeDeps) {
      const { createReceptionRecipeRunner } = await import(
        '../../reception-recipe-runner.js'
      );
      const sellerOfferStore = deps.sellerOfferStore;
      const sellerOrderStore = deps.sellerOrderStore;

      receptionRecipeRunner = createReceptionRecipeRunner({
        executeDeps: deps.executeDeps,
        pairStore,
        definitionStore,
        // NOT optional, and NOT a convenience: `handleExecute` skips its install-dish merge
        // for any run carrying a `run_id`, and the runner always carries one (idempotency).
        // Without this the door's recipe runs with an EMPTY config.
        resolveConfig: resolveInstallConfig,
        // D-207 slice 3c. Absent ⇒ a recipe naming an offer REFUSES rather than silently
        // degrading to plain intake, which would thank a visitor who came to buy.
        ...(sellerOfferStore && sellerOrderStore
          ? { seller: { offers: sellerOfferStore, orders: sellerOrderStore } }
          : {}),
        now: () => Date.now(),
      });

      // ── D-210 Appendix B — the on-the-go `/reception/manage` reschedule door ────────────
      //
      // A dedicated single-use-credential surface, NOT one of the six endpoint kinds and NOT
      // a paired form. So it does NOT go through `bindReceptionDoor`: that links a door via
      // the intake pair store (UPDATE-only), and there is no `__manage__` pair row to update
      // ⇒ the bind would silently no-op and the runner would resolve `no_door` forever. The
      // door contract is instead minted DIRECTLY here and its id held in the closure the
      // runner reads. Idempotent across boots by find-by-display_name (a reboot reuses the
      // live contract, never piling up dead duplicates); a revoked contract still resolves
      // but `buildReceptionContractSnapshot` yields an empty allowlist ⇒ every dispatch
      // denies — the kill-switch is intact. The recipe renders nothing (`output.render: []`),
      // so there is no responding-door refusal to trip.
      if (deps.receptionManageCredentialStore) {
        const [
          { createReceptionManageRescheduleRunner, RECEPTION_MANAGE_RESCHEDULE_RECIPE_ID },
          { mintDoorContract },
          { deriveRecipeCapability },
          { isContractActive },
        ] = await Promise.all([
          import('../../reception-manage-runner.js'),
          import('../../mint-door-contract.js'),
          import('../../derive-recipe-capability.js'),
          import('@recued/contracts'),
        ]);
        // preInstall has already `save()`d the bundled recipe by the time the substrate
        // composes; `getBundled` is the belt-and-braces fallback for a SQLite-empty boot.
        const manageRecipe =
          deps.recipeStore?.get(RECEPTION_MANAGE_RESCHEDULE_RECIPE_ID)
          ?? deps.recipeStore?.getBundled(RECEPTION_MANAGE_RESCHEDULE_RECIPE_ID)
          ?? null;
        let manageContractId: string | null = null;
        if (manageRecipe) {
          const derived = deriveRecipeCapability(manageRecipe, resolveOp ? { resolveOp } : {});
          if (derived.ok) {
            // `mintDoorContract` sets exactly `Reception door — <recipeId>`; matching on it
            // is what makes the mint idempotent across restarts.
            const displayName = `Reception door — ${RECEPTION_MANAGE_RESCHEDULE_RECIPE_ID}`;
            const existing = definitionStore
              .list()
              .find((d) => d.display_name === displayName && isContractActive(d, Date.now()));
            manageContractId =
              existing?.contract_id
              ?? mintDoorContract(
                {
                  door: 'reception',
                  recipeId: RECEPTION_MANAGE_RESCHEDULE_RECIPE_ID,
                  capability: derived.capability,
                  mintedBy: 'system',
                },
                { definitionStore, grantEntryStore, now: () => Date.now() },
              ).contract_id;
          }
        }
        manageRescheduleRunner = createReceptionManageRescheduleRunner({
          executeDeps: deps.executeDeps,
          definitionStore,
          // A closure over the boot-resolved id — the runner reads it per request. `null`
          // (recipe missing / underivable) ⇒ the runner returns `no_door`, never a raw run.
          resolveContractId: () => manageContractId,
          now: () => Date.now(),
        });
      }
    }
  }

  // ── D-207 slice 3c — the gated runner IS the submit path ─────────────────────────────
  //
  // There is no longer anything to fall through TO. Until this slice a pair with no door
  // landed on D-200's direct-checkout coordinator, which ran the recipe through the ONLY
  // raw `executeRecipe` in the server — outside the Gateway, the contract, the actor and
  // the run row. It was "safe" solely because its recipe profile was crippled to the point
  // of being unable to dispatch a single ingredient, and the safety and the narrowness were
  // the same property. That is why it could never generalize, and it is gone.
  //
  // `no_door` now means exactly what it says: this pair has no minted contract, so nothing
  // may run. `refused` — never a success page. The pair exists, so the visitor is on a form
  // that promised to DO something and did not, and telling them so is the whole of slice
  // 1c's lesson.
  let coordinateIntakeFormPairedRun:
    | NonNullable<ReceptionPortHandlerDeps['coordinateIntakeFormPairedRun']>
    | undefined;
  if (receptionRecipeRunner && deps.intakeFormSubmissionStore) {
    const { composeReceptionRecipeRunnerAdapter } = await import(
      '../../reception-recipe-runner-adapter.js'
    );
    const runViaDoor = composeReceptionRecipeRunnerAdapter({
      runner: receptionRecipeRunner,
      submissionStore: deps.intakeFormSubmissionStore,
      getFormSubmissionPiiKey: getIntakeFormSubmissionPiiKey,
    });
    coordinateIntakeFormPairedRun = async (input) => {
      const outcome = await runViaDoor(input);
      return outcome.kind === 'no_door' ? { kind: 'refused' as const } : outcome;
    };
  }

  const receptionRpcDeps: ReceptionRpcDeps = {
    ...receptionRpcDepsBase,
    // D-207 slice 1c — what `intake_recipe_pair.bind` mints the door with. Omitted ⇒ bind
    // refuses (`not_configured`) any recipe that needs one.
    ...(doorBindDeps ? { getDoorBindDeps: () => doorBindDeps } : {}),
  };

  const receptionPortDeps: ReceptionPortHandlerDeps = {
    getStore: () => registryStore,
    getCache: () => registryCache,
    getRateLimiter: () => rateLimiter,
    getPepper: getReceptionPepper,
    now: () => Date.now(),
    trustForwardedFor,
    ...(deps.schedulingFormNonceStore
      ? { getSchedulingFormNonceStore: () => deps.schedulingFormNonceStore! }
      : {}),
    // D-173 P4.2 — the cold-start null calendar reader (no busy events).
    // Stateless, so wired unconditionally; `schedulingDepsReady` still
    // requires the booking + form-nonce stores above before the
    // dispatcher serves the slot picker.
    getSchedulingCalendarReader,
    // D-149 P6 § A.5.3 — intake_form deps.
    ...(deps.intakeFormSubmissionStore
      ? { getIntakeFormSubmissionStore: () => deps.intakeFormSubmissionStore! }
      : {}),
    ...(deps.intakeFormNonceStore
      ? { getIntakeFormNonceStore: () => deps.intakeFormNonceStore! }
      : {}),
    ...(resolveIntakeFormRecipePair
      ? { resolveIntakeFormRecipePair }
      : {}),
    ...(coordinateIntakeFormPairedRun
      ? { coordinateIntakeFormPairedRun }
      : {}),
    getIntakeFormSubmissionPiiKey,
    // D-149 P7 § A.5.4 — drop_link deps.
    ...(deps.dropBlobStore ? { getDropBlobStore: () => deps.dropBlobStore! } : {}),
    ...(deps.blobStore ? { getBlobStore: () => deps.blobStore! } : {}),
    ...(deps.dropLinkNonceStore
      ? { getDropLinkNonceStore: () => deps.dropLinkNonceStore! }
      : {}),
    getDropBlobPiiKey,
    getDropBlobsRoot,
    // D-172 step 5a — resumable drop-link upload service (mounts the
    // `…/uploads` HTTP endpoints). Present iff its db + CAS + store deps wired.
    ...(receptionUploadService
      ? { getReceptionUploadService: () => receptionUploadService! }
      : {}),
    // D-149 P8 § A.5.5 — approval_link deps.
    ...(deps.approvalIntentStore
      ? { getApprovalIntentStore: () => deps.approvalIntentStore! }
      : {}),
    ...(deps.approvalLinkNonceStore
      ? { getApprovalLinkNonceStore: () => deps.approvalLinkNonceStore! }
      : {}),
    getApprovalIntentPiiKey,
    // D-149 P9 § A.5.6 — status_link deps. Both the projection store AND
    // the entity-source reader are required for `statusLinkReady` → the
    // dispatcher serves the live projection (else it falls back to the
    // 503 stub). The reader is built by the caller from the work-entity
    // warehouse; for source kinds without a store (event / itinerary /
    // packing_list) it returns null and the handler renders the
    // placeholder, matching the "entity not available" degrade.
    ...(deps.statusProjectionStore
      ? { getStatusProjectionStore: () => deps.statusProjectionStore! }
      : {}),
    ...(deps.statusEntitySourceReader
      ? { getStatusEntitySourceReader: () => deps.statusEntitySourceReader! }
      : {}),
    // D-149 P12 § A.20.5 — Abuse Inbox IP block store for the
    // listener-level block check (runs before the per-IP rate-limit
    // consume; a banned `(endpoint_id, source_ip_hash)` pair → 403).
    ...(deps.ipBlockStore ? { getIpBlockStore: () => deps.ipBlockStore! } : {}),
    auditLog,
    // D-149 P12 § A.20.7 — deployment mode for the Public Trust Footer.
    receptionDeploymentMode,
    ...(deps.sellerClaimStore
      ? { getSellerClaimStore: () => deps.sellerClaimStore! }
      : {}),
    // D-210 Appendix B — the on-the-go `/reception/manage` reschedule surface.
    // Credential store + runner are both required (the handler gates on both);
    // the local calendar slug is passed unconditionally because the port cannot
    // import `collections/calendar` for it.
    ...(deps.receptionManageCredentialStore
      ? { getReceptionManageCredentialStore: () => deps.receptionManageCredentialStore! }
      : {}),
    ...(manageRescheduleRunner
      ? { getReceptionManageRescheduleRunner: () => manageRescheduleRunner! }
      : {}),
    receptionManageCalendarSlug: DEFAULT_LOCAL_CALENDAR_SLUG,
    // WatchSource reception push source — verified mutation arrivals
    // emit canonical bus events + stamp the governance row's liveness.
    ...(deps.warehouseBus ? { warehouseBus: deps.warehouseBus } : {}),
    markSourceEvent: (source_key, at) => watchSourceRegistry.markEvent(source_key, at),
  };

  // WatchSource governance — one row per endpoint kind present in the
  // registry (the singleton reception_page never emits arrival events:
  // it is a view-only surface, so it lists no row). Rows derive fresh
  // per list() so endpoint CRUD surfaces without churn.
  watchSourceRegistry.register('reception', {
    list() {
      const byKind = new Map<string, { enabled: number; total: number }>();
      for (const endpoint of registryStore.list()) {
        if (endpoint.kind === 'reception_page') continue;
        const counts = byKind.get(endpoint.kind) ?? { enabled: 0, total: 0 };
        counts.total += 1;
        if (endpoint.enabled && endpoint.revoked_at === null) counts.enabled += 1;
        byKind.set(endpoint.kind, counts);
      }
      const rows: WatchSourceStatusEntry[] = [];
      for (const [kind, counts] of byKind) {
        rows.push({
          source_key: receptionSourceKey(kind),
          mechanism: 'reception',
          label: `reception ${kind} (${counts.enabled} of ${counts.total} enabled)`,
          emits: [`data.reception.${kind}.request.created`],
          active: counts.enabled > 0,
          inactive_reason: counts.enabled > 0 ? null : 'no enabled endpoints',
          last_event_at: null,
        });
      }
      return rows;
    },
  });

  // 30s rate-limiter snapshot cadence per § Contract Tightening §
  // Rate-limit substrate. The limiter holds per-day caps in-memory;
  // without periodic persistence a process restart would reset a
  // visitor's counter mid-window. `onStop` emits one final snapshot at
  // shutdown so the SQLite row reflects live in-memory state. Both the
  // tick and the onStop body swallow errors per the pre-extraction
  // pattern.
  deps.backgroundServices.registerInterval({
    name: 'reception-rate-snapshot',
    intervalMs: 30_000,
    tick: () => {
      try {
        rateLimiter.snapshot(Date.now());
      } catch (e) {
        console.warn('[d-149.p3] reception rate-limiter snapshot failed', e);
      }
    },
    onStop: () => {
      try {
        rateLimiter.snapshot(Date.now());
      } catch (e) {
        console.warn('[d-149.p3] final rate-limiter snapshot failed', e);
      }
    },
  });

  // D-149 § A.5.3 + § A.5.5 + § Must Hold I-12 — register the submission
  // drain. Pending intake_form rows materialize into work entities (task /
  // note / commitment) per each endpoint's submission_processing_rule;
  // consumed approval_link intents apply their `on_approve_action`
  // (create_commitment is concrete here, mark_resolved / fire_recipe route
  // through the effect seam) — both closing the "collected/consumed then
  // unreachable" gap. The notify + triggered_recipe / applyEffect seams
  // are intentionally left unwired here (NotificationBlock is engine-
  // internal; the recipe executor + cross-substrate target resolution need
  // DI) — a later effects pass supplies them. Without the work-entity
  // warehouse (boot phase) no processor is registered and the drain stays
  // a no-op.
  const { registerReceptionDrain } = await import('../../ports/reception/reception-drain.js');
  const drainProcessors: ReceptionSubmissionProcessor[] = [];
  if (deps.workEntityStore && deps.intakeFormSubmissionStore) {
    const { createIntakeFormSubmissionProcessor } = await import(
      '../../ports/reception/processors/intake-form-processor.js'
    );
    const intakeSubmissionStore = deps.intakeFormSubmissionStore;
    const materializeStore = deps.workEntityStore;
    drainProcessors.push(
      createIntakeFormSubmissionProcessor({
        registryStore,
        submissionStore: intakeSubmissionStore,
        workEntityStore: materializeStore,
        getFormSubmissionPiiKey: getIntakeFormSubmissionPiiKey,
        now: () => Date.now(),
        // D-173 P3 § A.7 — the review-then-approve dispatch seam. Review-mode
        // (default) submissions fire the compiled recipe → held at the gate →
        // inbox; auto-accept submissions materialize directly (the seam is
        // bypassed). Absent ⇒ review rows stay pending (never auto-materialized).
        ...(deps.fireReceptionWorkflow
          ? { fireReceptionWorkflow: deps.fireReceptionWorkflow }
          : {}),
        ...(deps.sharedStore
          ? {
              admitPaidDirectCheckoutReview:
                createPaidDocumentDirectCheckoutReviewAdmission(deps.sharedStore),
            }
          : {}),
      }),
    );
  }
  if (deps.workEntityStore && deps.approvalIntentStore) {
    const { createApprovalLinkSubmissionProcessor } = await import(
      '../../ports/reception/processors/approval-link-processor.js'
    );
    const approvalStore = deps.approvalIntentStore;
    const commitmentStore = deps.workEntityStore;
    drainProcessors.push(
      createApprovalLinkSubmissionProcessor({
        registryStore,
        intentStore: approvalStore,
        workEntityStore: commitmentStore,
        getApprovalIntentPiiKey,
        now: () => Date.now(),
        // D-173 P3 § A.7 — review-then-approve dispatch for a `create_commitment`
        // endpoint (the same seam the intake processor uses). Review (default)
        // holds the commitment materialize at the gate → inbox; auto-accept
        // materializes directly. `mark_resolved` / `fire_recipe` route through
        // `applyEffect` regardless. Absent ⇒ review rows stay pending.
        ...(deps.fireReceptionWorkflow
          ? { fireReceptionWorkflow: deps.fireReceptionWorkflow }
          : {}),
      }),
    );
  }
  // D-172 P3 § A.5 / D-173 P5 § A.7 — register the drop_link drain processor.
  // REVIEW-BY-DEFAULT (the `fireReceptionWorkflow` seam): a pending drop blob is
  // ingested into `data.file.received` (the bytes are already in the CAS, A.1),
  // then a `drop.materialize` op (a task with the file attached) is HELD at the
  // D-157 gate → Reception Inbox; the task + attach run only on approve. An
  // endpoint may opt into AUTO-ACCEPT (`on_upload.auto_accept: true`) for the
  // legacy straight-through ingest + pre-bound contact/project attach (never a
  // contact resolved from the visitor email — D-149 N.6 / I-9). Gated on the
  // file collection + attachFile deps + the drop store; absent (boot phase /
  // file substrate not composed) ⇒ no drop drain. The contact resolver is
  // optional (auto-accept contact-attach); the `fireReceptionWorkflow` seam is
  // optional — without it a review-mode drop stays pending (never inline-
  // materializes — I-1).
  if (deps.dropBlobStore && deps.inboundFileCollection && deps.attachFileDeps) {
    const { createDropLinkSubmissionProcessor } = await import(
      '../../ports/reception/processors/drop-link-processor.js'
    );
    const { attachFile } = await import('../../collections/file/attach-file.js');
    const dropStore = deps.dropBlobStore;
    const fileCollection = deps.inboundFileCollection;
    const attachFileDeps = deps.attachFileDeps;
    drainProcessors.push(
      createDropLinkSubmissionProcessor({
        registryStore,
        dropBlobStore: dropStore,
        getDropBlobPiiKey,
        fileIngestor: fileCollection,
        attach: attachFile,
        attachDeps: attachFileDeps,
        ...(deps.contactStore ? { contactResolver: deps.contactStore } : {}),
        ...(deps.fireReceptionWorkflow
          ? { fireReceptionWorkflow: deps.fireReceptionWorkflow }
          : {}),
        now: () => Date.now(),
        // notify + runRecipe seams intentionally unwired here (mirrors the
        // intake_form / approval_link posture — NotificationBlock is
        // engine-internal + the recipe executor needs DI). A later effects
        // pass supplies them.
      }),
    );
  }

  // D-173 P4 § D7 — register the scheduling_link booking drain. A pending
  // reservation → a HELD review-then-approve op whose materialize target is a
  // booking with its own slot. Scheduling NEVER auto-books (I-7), so there is no
  // auto-accept branch and no work-entity store dep — the drain only
  // dispatches the review workflow (the approve-time materialize rides the
  // `reception-materialize` kernel like every other reception kind). Gated on
  // the booking store; absent (boot phase) ⇒ no scheduling drain. The dispatch
  // seam is threaded like the other kinds; absent ⇒ bookings stay pending to
  // dispatch once the reception-scheduling core-pack installs (never
  // auto-materialized — I-1 / I-7).
  // D-210 A.8 slice 4b-ii — gated on the MERGED store, which is where bookings
  // live now; 4c deleted the separate booking store this used to be gated on.
  if (deps.intakeFormSubmissionStore) {
    const { createSchedulingLinkSubmissionProcessor } = await import(
      '../../ports/reception/processors/scheduling-link-processor.js'
    );
    const bookingStore = deps.intakeFormSubmissionStore;

    // ── D-210 R-2 — the booking flow joins the door substrate ────────────────────────────
    //
    // Until this slice `scheduling_link` could only ever take the contract-free
    // `{reactive, system}` dispatch: `requireIntakeEndpoint` 409s every non-`intake_form`
    // kind out of pairing, so the booking flow ran with no door, no grants and no dish —
    // everything D-207/D-209 built, structurally excluded by one RPC branch (D-210 §3).
    //
    // The two seams below are what a paired booking needs, and they are gated SEPARATELY on
    // purpose. `resolveSchedulingRecipePair` alone is enough to make a paired endpoint HOLD
    // (fail-closed: the owner's recipe cannot run, so nothing runs); adding
    // `runPairedBooking` is what makes it dispatch. Wiring the run without the resolve
    // would be the dangerous half — it can never happen, because the plan only ever reaches
    // `paired` through the resolver.
    //
    // ⚠ Both hang off the SAME `intakeRecipePairStore` + runner the intake door uses. The
    // store's name is narrower than its behaviour — since the owner-ruled rebuild it holds
    // form pairs (v1/v2) AND scheduling pairs (v3), keyed by endpoint. Do not infer from
    // the name that a v3 cannot be there.
    let resolveSchedulingRecipePair:
      | NonNullable<
          Parameters<typeof createSchedulingLinkSubmissionProcessor>[0]['resolveSchedulingRecipePair']
        >
      | undefined;
    if (deps.intakeRecipePairStore) {
      const [
        { resolveReceptionSchedulingRecipePair },
        { deriveReceptionSchedulingRecipePairBinding },
      ] = await Promise.all([
        import('../../ports/reception/scheduling-recipe-pair.js'),
        import('../../reception-scheduling-recipe-pair-derivation.js'),
      ]);
      const schedulingPairStore = deps.intakeRecipePairStore;
      const schedulingRecipeStore = deps.recipeStore;
      resolveSchedulingRecipePair = ({ endpoint_id, required_visitor_fields }) =>
        resolveReceptionSchedulingRecipePair({
          endpoint_id,
          required_visitor_fields,
          store: schedulingPairStore,
          getRecipe: (recipeId) => schedulingRecipeStore?.get(recipeId) ?? null,
          deriveBinding: deriveReceptionSchedulingRecipePairBinding,
        });
    }

    // The gated runner, unchanged: it resolves the door contract, refuses without one
    // (`no_door`), stamps `{ channel: 'reception', actor: 'anonymous', reception_id,
    // contract_id }`, builds the snapshot and passes the dish's config. `ReceptionRunInput`
    // is generic — `submission` is whatever the caller recovered from the durable row, and
    // reaches the recipe as `context.reception_submission`. A booking record fits it exactly.
    const runner = receptionRecipeRunner;
    const runPairedBooking = runner
      ? async ({
          endpoint_id,
          request_id,
          record,
        }: {
          endpoint_id: string;
          request_id: string;
          record: Record<string, unknown>;
        }) => {
          const outcome = await runner.run({
            endpoint_id,
            // The runner's idempotency anchor (`run_id: reception:<id>`) — a re-drive of
            // the same booking collapses onto one run rather than re-firing its effects.
            submission_id: request_id,
            submission: record,
          });
          return outcome.kind === 'completed'
            ? ({ kind: 'completed' } as const)
            : outcome.kind === 'failed'
              ? ({ kind: 'failed', errors: outcome.errors } as const)
              : ({ kind: outcome.kind } as const);
        }
      : undefined;

    drainProcessors.push(
      createSchedulingLinkSubmissionProcessor({
        registryStore,
        bookingStore,
        getFormSubmissionPiiKey: getIntakeFormSubmissionPiiKey,
        now: () => Date.now(),
        ...(deps.fireReceptionWorkflow
          ? { fireReceptionWorkflow: deps.fireReceptionWorkflow }
          : {}),
        ...(resolveSchedulingRecipePair ? { resolveSchedulingRecipePair } : {}),
        ...(runPairedBooking ? { runPairedBooking } : {}),
      }),
    );
  }

  registerReceptionDrain({
    backgroundServices: deps.backgroundServices,
    processors: drainProcessors,
    now: () => Date.now(),
  });

  return { receptionRpcDeps, receptionPortDeps };
};

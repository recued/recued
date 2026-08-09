/** Kernel ingredient adapter (D-103 Phase A + D-106 Phase D +
 *  D-115 Phase 6 + D-117 Phase 6).
 *
 *  Routes manifests with `author === KERNEL_AUTHOR` (the reserved
 *  `recued` publisher namespace) to caller-supplied dispatchers:
 *    - Phase A: seven `shared-*` ingredients (durable + cache tier).
 *    - Phase D: read-only warehouse ingredients — `file-list`,
 *      `file-get`, `webhook-list`, `webhook-get`, `email-list`,
 *      `email-search`, `email-get`. A single `collectionList` /
 *      `collectionGet` / `collectionSearch` dispatcher slot handles
 *      all three platforms; the slug determines the platform passed
 *      to the dispatcher.
 *    - Accepted FormResponse read: `form-response-get` uses a dedicated
 *      dispatcher because its canonical free-form record shape is not a
 *      Phase-D collection mirror row.
 *    - Phase 6 (D-115): watcher ingredients — `time-watcher`,
 *      `recipe-watcher`, `http-watcher`, `mail-watcher`,
 *      `file-watcher`, `calendar-watcher`, `webhook-watcher`. One
 *      unified `watcher` dispatcher slot fans out on the slug so
 *      runtime wiring can mount a single handler for all reactive
 *      gates. Handlers return `TriggerOutput = { should_run, ... }`
 *      — the executor's trigger phase inspects `should_run` to
 *      decide whether the tick proceeds.
 *  Every slot is optional — runtimes that don't wire a particular op
 *  return `SERVER_NOT_REACHABLE` at call time so the recipe surface
 *  renders a legible error instead of a silent hang.
 *
 *  Two call patterns:
 *    - Server runtime: dispatchers invoke the handler functions in-
 *      process (no wire traffic).
 *    - Ext runtime: dispatchers rpc to the paired server via
 *      `shared.*` / `collection.*` methods. Absent paired server
 *      → `server_not_reachable`. */

import { IngredientError, type ResolvedCall } from './types.js';
import type { Adapter } from './dispatch.js';
import {
  canonicalizeEmail,
  extractCanonicalRef,
  MAIL_SENT_RECONCILIATION_MAX_WINDOW_MS,
  isEnrichmentScope,
  isMailReconciliationId,
  isSellerCustomerCloseReason,
  isSellerLifecycleSource,
  isSellerOfferKind,
  isSellerOrderOriginKind,
  isSellerOrderPhase,
  isSellerOrderTransitionOpTarget,
  isWorkEntityKind,
  SYNC_STATE_SET,
  SELLER_ORDER_ORIGIN_KINDS,
  SELLER_OFFER_KINDS,
  SELLER_OFFER_PRICING_KINDS,
  isSellerOfferPricingKind,
  isSellerOfferState,
  isTempFileRef,
  stampCanonicalFields,
  stripCorePrefix,
  type Actor,
  type Annotation,
  type AnnotationFilter,
  type AnnotationSearchMatch,
  type ExecutionSource,
  type AnnotationSearchQuery,
  type CanonicalCollectionName,
  type CanonicalRecord,
  type Booking,
  type BookingLifecycleState,
  type Commitment,
  type CommitmentDirection,
  type CommitmentDerivation,
  type CommitmentEvidenceEntry,
  type CommitmentExpiryPolicy,
  type ContactAliasPlatform,
  type ContactBusinessContextResult,
  type ContactRecord,
  type EnrichmentScope,
  type FormResponse,
  type FormResponseLifecycleState,
  type FormResponseListCursor,
  type FormResponseListQuery,
  FORM_RESPONSE_LIFECYCLE_STATES,
  FORM_RESPONSE_LIFECYCLE_STATE_SET,
  type Link,
  type LinkFilter,
  type MailSentReconciliationQuery,
  type MailSentReconciliationResult,
  type MonetaryValue,
  type Note,
  type Project,
  type ProjectState,
  type SellerCustomer,
  type SellerCustomerClaim,
  type SellerCustomerClaimEmailDelivery,
  type SellerCustomerCloseReason,
  type SellerLifecycleSource,
  type SellerOffer,
  type SellerTierPublic,
  type SellerOfferEnsureResult,
  type SellerOfferFulfillmentAttachResult,
  type SellerOfferKind,
  type SellerOrderOriginKind,
  type SellerOrderPhase,
  type WorkEntityKind,
  type WorkEntity,
  type SyncState,
  type SellerOfferPricingKind,
  type SellerOfferState,
  type SourceTopTierKind,
  type Task,
  type TaskPriority,
  type TempFileRef,
  type TimelineEntry,
  NOTIFICATION_DELIVERY_CHANNELS,
  type NotificationDeliveryChannel,
  // D-207 slice 3d — the artifact pin is VERIFIED against `data.file` source
  // truth, never taken on the caller's word.
  verifySellerOrderArtifactPin,
  type PinnedCasFileRef,
} from '@recued/contracts';

/** D-119 Phase 12 — stamp `_id` + `_collection` onto every record
 *  returned through the kernel adapter so recipes consume canonical
 *  refs uniformly. Idempotent — adapters that already stamp are
 *  passed through unchanged (existing values win). The single
 *  chokepoint here means per-runtime dispatchers don't each need to
 *  remember the stamping rule.
 *
 *  Generic over `T extends object` rather than `Record<string,unknown>`
 *  because the kernel-side record interfaces (`KernelCollectionRecord`
 *  etc.) declare named fields without an open index signature; the
 *  cast inside is a one-line widening that the contracts helper
 *  accepts. */
const stampOne = <T extends object>(
  record: T,
  collection: CanonicalCollectionName,
  id: string,
): T & CanonicalRecord =>
  stampCanonicalFields(
    record as unknown as Record<string, unknown>,
    collection,
    id,
  ) as T & CanonicalRecord;

const stampMany = <T extends object>(
  records: readonly T[],
  collection: CanonicalCollectionName,
  idOf: (r: T) => string,
): (T & CanonicalRecord)[] => records.map((r) => stampOne(r, collection, idOf(r)));

/** D-192 seam 10 — the fan-out default IS the full delivery vocabulary (every
 *  declared chat transport + email + in_app), so a new chat transport joins the
 *  default fan-out with no edit here. */
const DEFAULT_NOTIFICATION_CHANNELS = NOTIFICATION_DELIVERY_CHANNELS;
const DELIVERY_CHANNEL_SET: ReadonlySet<string> = new Set(NOTIFICATION_DELIVERY_CHANNELS);

const withCreateOrigin = <T extends {
  origin_actor?: Actor;
  origin_trigger_source?: string;
  origin_execution_source?: ExecutionSource;
  work_entity_write_preadmitted?: boolean;
}>(
  input: T,
  stepMeta:
    | {
        actor?: Actor;
        trigger_source?: string;
        execution_source?: ExecutionSource;
        work_entity_write_preadmitted?: boolean;
      }
    | undefined,
): T => {
  const out = { ...input };
  // The origin channel is ADAPTER-OWNED: recipe-authored origin fields
  // in the step input are dropped, never honored — a recipe must not
  // be able to masquerade its create's origin (it can still target a
  // source explicitly via `source_id`, which is the honest, gated
  // path).
  delete out.origin_actor;
  delete out.origin_trigger_source;
  // D-192 baseline-admission (S2) — the run's execution source rides the SAME
  // adapter-owned channel: strip any recipe-supplied value then forward it from
  // StepMeta ONLY, so the server dispatcher's actor-aware contract-grant admission
  // (`admitVendorWrite`) evaluates the REAL dispatch identity, never a recipe-forged
  // one. A recipe that names a privileged actor here is silently overwritten.
  delete out.origin_execution_source;
  // D-192 6c.2c — the create-plan / container-pick re-run admission is the
  // SAME adapter-owned, engine-set channel: strip any recipe-supplied value
  // then forward the run-level flag from StepMeta ONLY. A recipe / chat / MCP
  // caller can never set it (the two re-run wirings are the only producers),
  // so it can never self-admit a vendor create past the `'ask'` gate.
  delete out.work_entity_write_preadmitted;
  if (stepMeta?.actor) out.origin_actor = stepMeta.actor;
  if (typeof stepMeta?.trigger_source === 'string' && stepMeta.trigger_source.length > 0) {
    out.origin_trigger_source = stepMeta.trigger_source;
  }
  if (stepMeta?.execution_source !== undefined) {
    out.origin_execution_source = stepMeta.execution_source;
  }
  if (stepMeta?.work_entity_write_preadmitted === true) {
    out.work_entity_write_preadmitted = true;
  }
  return out;
};

const collectionForKernelPlatform = (
  platform: 'mail' | 'file' | 'webhook',
): CanonicalCollectionName => platform;

/** Phase D collection record shape — kept inline here instead of
 *  importing from `@recued/contracts` so `@recued/ingredients` stays
 *  declaration-dep-free. Callers that want the richer type can
 *  import `CollectionRecord` from contracts and cast. */
export interface KernelCollectionRecord {
  record_id: string;
  received_at: number;
  modified_at: number;
  hot_fields: Record<string, unknown>;
  size_bytes: number;
  source_id: string;
  body_inline?: string;
  blob_hash?: string;
}

/** D-200 Rev 26 — exact Sent-link reconciliation needs indexed envelope
 * metadata, never the message body or its CAS locator. Keep this projection at
 * the kernel boundary so `metadata_only: true` prevents both carriers from
 * entering recipe step state while preserving the legacy full-row list shape
 * for existing callers that do not opt in. */
const collectionRecordMetadataOnly = (
  record: KernelCollectionRecord,
): KernelCollectionRecord => {
  const projected = { ...record };
  delete projected.body_inline;
  delete projected.blob_hash;
  return projected;
};

export interface KernelCollectionSearchMatch {
  record_id: string;
  hot_fields: Record<string, unknown>;
  rank: number;
  snippet: string;
}

export type KernelCollectionPlatform = 'mail' | 'file' | 'webhook';

/** D-117 — calendar dispatcher inputs / outputs. Kept inline here to
 *  preserve `@recued/ingredients`'s declaration-dep-free posture; the
 *  server-side calendar dispatcher narrows back to the contracts'
 *  `CanonicalEvent` / `CalendarRecordHotFields` types. */
export interface KernelCalendarHotFields {
  calendar_id: string;
  summary: string;
  start_at: number;
  end_at: number;
  status: 'confirmed' | 'cancelled' | 'tentative';
  organizer?: string;
  ical_uid: string;
  location?: string;
  is_all_day: boolean;
  is_recurring: boolean;
}

export interface KernelCalendarRecordStat {
  exists: boolean;
  start_at?: number;
  end_at?: number;
  status?: 'confirmed' | 'cancelled' | 'tentative';
  attendee_count?: number;
  last_modified_at?: number;
}

/** Subset of `CanonicalEvent` the kernel surface treats as opaque —
 *  the server casts back to the rich type at the dispatcher boundary. */
export type KernelCanonicalEvent = Record<string, unknown>;

export type KernelCalendarMutationScope =
  | 'this_instance'
  | 'this_and_future'
  | 'series';

/** Known watcher slugs routed through the unified `watcher`
 *  dispatcher slot. See `watcherDispatchSlugs` below for the
 *  manifest-match set — any non-watcher slug that happens to start
 *  with one of these prefixes still falls through to its own switch
 *  arm (webhook-list vs webhook-watcher). */
export type KernelWatcherSlug =
  | 'time-watcher'
  | 'recipe-watcher'
  | 'http-watcher'
  | 'mail-watcher'
  | 'file-watcher'
  | 'calendar-watcher'
  | 'webhook-watcher'
  | 'time-relative-watcher';

/** ⛔⛔ THE WATCHERS THAT KEY PER-RECIPE STATE, and therefore require an
 *  ENGINE-OWNED recipe identity rather than an authored one.
 *
 *    webhook-watcher       — its per-`(recipe_id, slug)` queue, which `drain()`
 *                            DELETES as it returns.
 *    time-relative-watcher — its durable firing ledger.
 *
 *  Two consumers, and they must never drift apart:
 *    1. The kernel adapter (below) OVERWRITES `args.recipe_id` from
 *       `stepMeta.recipe_id` for exactly these slugs, so a recipe can only ever
 *       touch its own state.
 *    2. `runtime.runWatcher` (backend `watcher-rpc-handler.ts`) REFUSES exactly
 *       these slugs, because that transport is a thin pass-through with no
 *       engine context — it cannot supply the identity, so it must not pretend
 *       to. A caller there could otherwise name another recipe's queue and both
 *       read its contents (headers, body, source IP) and destroy them.
 *
 *  ⚠ The other six take explicit args and mutate nothing, so they stay
 *  forwardable. This is not "watchers are dangerous"; it is "state keyed by an
 *  identity the caller supplies is only as trustworthy as the caller". */
export const RECIPE_KEYED_WATCHER_SLUGS: ReadonlySet<KernelWatcherSlug> = new Set([
  'webhook-watcher',
  'time-relative-watcher',
]);

/** Minimum envelope watcher handlers return. `should_run` is the AND-
 *  gate field the trigger phase inspects; every other field is surfaced
 *  on `{{trigger.<step_id>.<field>}}` for downstream phases. Runtime
 *  layers narrow this with adapter-specific shapes (e.g. mail returns
 *  `items` + `last_seen_at`). */
export interface KernelTriggerOutput {
  should_run: boolean;
  [field: string]: unknown;
}

/** D-173 P1-dispatch — the LOCAL-ONLY base URL the reception core-pack
 *  catalog ops (reception-intake / reception-approval) carry as their api
 *  surface `default_base_url`. It is a sentinel, NOT a reachable endpoint:
 *  a reception `materialize` op is a catalog-form `approval_required`
 *  operation whose REST binding points here so the D-157 Gateway HOLDS the
 *  call pending in the inbox. On approve-resume the ingredient executor
 *  recognises a surface-dispatch against this sentinel and routes it to the
 *  `reception-materialize` kernel ingredient (→ `runReceptionProjection`)
 *  instead of attempting an HTTP call to a dead host. The gate-hold leg
 *  (the catalog gateway's `ask` → `PreflightRequiredSignal`) is untouched —
 *  this only redirects the post-approval DISPATCH leg.
 *
 *  Kept in lock-step with the `surfaces_seed.default_base_url` literal in
 *  `community/packs/recued-core/reception-{intake,approval}.json`. */
export const RECEPTION_LOCAL_BASE_URL = 'https://reception.local';

/** D-173 P1-dispatch — the kernel slug the executor re-routes a
 *  reception-local surface dispatch to. */
export const RECEPTION_MATERIALIZE_SLUG = 'reception-materialize';

/** D-173 P1-dispatch — the projection input the `reception-materialize`
 *  kernel dispatcher consumes. STRUCTURALLY mirrors the backend
 *  `ReceptionProjectionInput` (the public-boundary rule forbids importing
 *  the backend type into `packages/ingredients`); the boot wiring binds the
 *  dispatcher to `runReceptionProjection`, whose input type this matches. */
export type ReceptionMaterializeKind = SourceTopTierKind | 'form_response';

export interface ReceptionMaterializeInput {
  top_tier_kind: ReceptionMaterializeKind;
  id: string;
  title: string;
  body?: string;
  metadata?: Record<string, unknown>;
  source_id?: string;
  contact_email?: string;
  contact_name?: string;
  /** A dated commitment's due time. Scheduling uses `start_at` instead. */
  promised_for_at?: number;
  /** D-173 P4 / I-7 — when set (scheduling), the projection refuses to
   *  materialize a slot already in the past. Re-checks at this approve-resume
   *  leg so a booking that sat in the inbox until its slot passed never books.
   *  Guards the booking branch's `start_at`. */
  reject_if_slot_past?: boolean;
  /** Booking or intake-calendar slot start. Editable at the gate. Epoch ms. */
  start_at?: number;
  /** Booking or intake-calendar slot duration. */
  duration_minutes?: number;
  /** Booking or intake-calendar IANA timezone. */
  timezone?: string;
  /** Scheduling reservation id. Presence selects the sealed booking mint. */
  booking_request_id?: string;
  /** HMAC binding the exact reservation id to the deterministic booking id. */
  booking_binding?: string;
  /** Per-approval owner choice to send a booking confirmation. */
  notify_visitor?: boolean;
  /** Intake-calendar day-scoped event flag. */
  is_all_day?: boolean;
  /** D-173 P5 — a `data.file.received` record id (a drop's ingested file).
   *  When present on a work-entity projection (drop → a task), the file is
   *  attached to the materialized entity via `data.link role:'attachment'`.
   *  Work-entity branch only. */
  file_id?: string;
}

/** D-173 P1-dispatch — the projection result. Mirrors the backend
 *  `ReceptionProjectionResult`; `form_response` is the mutable working
 *  destination paired with an immutable sealed Reception submission. */
export interface ReceptionMaterializeResult {
  top_tier_kind: ReceptionMaterializeKind;
  target_id: string;
}

export interface KernelScheduleRecipeInput {
  recipe_id: string;
  mode: 'one_shot' | 'recurring';
  run_at?: number;
  cron_expression?: string;
  dish_id?: string;
  enabled?: boolean;
}

export interface KernelSellerOfferEnsureInput {
  offer_id: string;
  kind: SellerOfferKind;
  display_name: string;
  description?: string;
  pricing_kind: SellerOfferPricingKind;
  amount_minor?: number | null;
  currency?: string | null;
  fulfillment_recipe_id?: string | null;
  /** D-196 1d — non-secret generic fulfillment pointers (`{entitlement_key, …}`).
   *  Recipe-settable; a secret is NOT accepted here (it lives in the vault and is
   *  referenced at point of use). */
  fulfillment_config?: Readonly<Record<string, unknown>> | null;
  /** Stamped from engine step metadata; never accepted from recipe input. */
  created_by_recipe_id: string;
}

export interface KernelSellerOfferFulfillmentAttachInput {
  offer_id: string;
  /** Stamped from engine step metadata and used as both creator proof and the
   * immutable local navigation target. */
  recipe_id: string;
}

export interface KernelSellerOfferListInput {
  kind?: SellerOfferKind;
  state?: SellerOfferState;
}

/** D-207 §4.3 — `core.seller.order`. ⛔ Note what is NOT here: no amount, no
 *  currency, no product. `open` names WHICH offer; the server reads WHAT it costs
 *  from the offer row. The absence of a price parameter is the fence. */
export interface KernelSellerOrderOpenInput {
  offer_id: string;
  origin_kind: SellerOrderOriginKind;
  origin_ref: string;
  customer_id?: string | null;
  /** D-196 §4.5 — the tier this order sells, snapshotted onto the row at open.
   *  The entitlement KEY, never a tier row id. Names WHICH access, not what it
   *  costs — the price fence above is untouched. */
  entitlement_key?: string | null;
}

export interface KernelSellerOrderGetInput {
  order_key?: string;
  order_handle?: string;
}

export interface KernelSellerOrderListInput {
  offer_id?: string;
  phase?: SellerOrderPhase;
  origin_kind?: SellerOrderOriginKind;
  origin_ref?: string;
  limit?: number;
}

export interface KernelSellerOrderQuoteInput {
  order_key: string;
  expected_revision: number;
  amount_minor: number;
  currency: string;
}

export interface KernelSellerOrderAttachPaymentInput {
  order_key: string;
  expected_revision: number;
  provider: string;
  provider_session_id: string;
  checkout_url?: string | null;
  expires_at?: number | null;
}

export interface KernelSellerOrderConfirmPaymentInput {
  order_key: string;
  expected_revision: number;
  evidence: Record<string, unknown>;
}

/** D-196 renewal — same posture as confirm-payment: the evidence shape is
 *  validated at the STORAGE boundary, where the invoice-keyed correlation and
 *  the acquisition-order anchor it must match are re-derived from stored rows. */
export interface KernelSellerOrderConfirmRenewalPaymentInput {
  order_key: string;
  expected_revision: number;
  evidence: Record<string, unknown>;
}

export interface KernelSellerOrderConfirmRefundInput {
  order_key: string;
  expected_revision: number;
  evidence: Record<string, unknown>;
}

/** What the reconcile op reports back. `settled` is the honest discriminator: a
 *  `not_found` is a real answer that changed NOTHING, and reporting it as a
 *  successful reconciliation would invite exactly the resend this substrate forbids. */
export interface KernelMailSentReconcileResult {
  status: string;
  settled: boolean;
  provider_message_id: string | null;
  sent_at: number | null;
  ambiguity_reason: string | null;
  scanned_candidates: number;
}

export interface KernelSellerOrderAttachArtifactInput {
  order_key: string;
  expected_revision: number;
  /** ⛔ The VERIFIED pin, not the recipe's two loose strings. The kernel case
   *  re-reads the bytes through `dataFileRead` and refuses a hash that does not
   *  match source truth BEFORE anything reaches the store — so what crosses this
   *  boundary is a proven `(ref, hash)`, never an asserted one. */
  artifact: PinnedCasFileRef;
}

export interface KernelSellerOrderTransitionInput {
  order_key: string;
  expected_revision: number;
  next_phase: SellerOrderPhase;
  error_code?: string | null;
}

export interface KernelSellerOrderLinkWorkEntityInput {
  order_key: string;
  expected_revision: number;
  work_entity_kind: WorkEntityKind;
  work_entity_id: string;
}

/** D-207 §4.5 — the order → seller-customer link. `order.open` accepts
 *  `customer_id`, but an ACQUISITION order is opened at checkout, BEFORE the
 *  customer exists: the customer row is created by
 *  `core.seller.customer-access.issue` only once the payment is evidence-backed.
 *  Without a post-open link the acquisition order could never carry its customer
 *  and the money↔access edge would be one-way. */
export interface KernelSellerOrderLinkCustomerInput {
  order_key: string;
  expected_revision: number;
  customer_id: string;
}

export interface KernelSellerOrderMutationResult {
  result: 'updated' | 'unchanged';
  order: unknown;
}

/** D-196 §4.5 — `core.seller.tier`, the vendor-neutral tier read. Addressed by
 *  the same `(lifecycle_source, door_id, entitlement_key)` triple
 *  `customer-access-issue` consumes, so a flow reads exactly the tier it is
 *  about to open an order for or issue against. No row id anywhere in this
 *  family: the KEY is the recipe-facing identity (it survives a re-sync). */
export interface KernelSellerTierGetInput {
  lifecycle_source: SellerLifecycleSource;
  door_id: string;
  entitlement_key: string;
}

export interface KernelSellerTierListInput {
  door_id?: string;
  lifecycle_source?: SellerLifecycleSource;
  active?: boolean;
}

export interface KernelCustomerAccessTargetInput {
  customer_id?: string;
  lifecycle_source?: SellerLifecycleSource;
  door_id?: string;
  source_customer_id?: string;
}

export interface KernelCustomerAccessIssueInput {
  lifecycle_source: SellerLifecycleSource;
  door_id: string;
  source_customer_id: string;
  entitlement_key: string;
  email?: string | null;
  current_period_end?: number | null;
  source_status?: string | null;
  external_subscription_id?: string | null;
}

export interface KernelCustomerAccessIssueResult {
  result: 'created' | 'extended';
  customer: SellerCustomer;
  /** Short-lived, single-use delivery capability. Present only on create; the
   * long-lived bearer never crosses the kernel/recipe boundary. */
  claim: SellerCustomerClaim | null;
  /** Automatic post-commit mail outcome for newly created non-manual
   * customers. Replays and manual-source kernel issues leave this null. */
  claim_email_delivery: SellerCustomerClaimEmailDelivery | null;
}

export interface KernelCustomerAccessExtendInput extends KernelCustomerAccessTargetInput {
  current_period_end?: number | null;
  source_status?: string | null;
  email?: string | null;
}

export interface KernelCustomerAccessSwapTierInput extends KernelCustomerAccessTargetInput {
  entitlement_key: string;
  current_period_end?: number | null;
  source_status?: string | null;
}

export interface KernelCustomerAccessCloseInput extends KernelCustomerAccessTargetInput {
  reason: SellerCustomerCloseReason;
  source_status?: string | null;
}

export interface KernelDispatchers {
  write?: (input: {
    key: string;
    value: unknown;
    ttl?: number;
  }) => Promise<{ ok: true; key: string; bytes_written: number }>;
  compareAndSet?: (input: {
    key: string;
    expected_revision: number | null;
    value: unknown;
  }) => Promise<{
    ok: true;
    key: string;
    revision: number;
    created: boolean;
    bytes_written: number;
  }>;
  /** D-232 § 23 — what happened to an exchange. Server-side because the answer
   *  lives in the AUDIT TRAIL, which no client holds.
   *
   *  ⛔ Read-only and ref-scoped by construction: the caller names a ref and gets
   *  a delivery state back. It confers no authority — an exchange ref is a handle
   *  the caller already minted or was handed, and the query is a read. */
  exchangeStatus?: (input: { exchange_ref: string; callback_op?: string }) => Promise<{
    ref: string;
    status: string;
    kind?: string;
    reason?: string;
    runs: number;
  }>;
  read?: (input: { key: string }) => Promise<{
    found: boolean;
    key: string;
    value?: unknown;
    cas_revision?: number | null;
  }>;
  list?: (input: { prefix: string }) => Promise<{
    entries: { key: string; value: unknown }[];
  }>;
  search?: (input: { scope: string; query: string }) => Promise<{
    matches: { key: string; value: unknown; rank: number }[];
  }>;
  delete?: (input: { key: string }) => Promise<{ ok: true; key: string }>;
  deletePrefix?: (input: { prefix: string }) => Promise<{
    ok: true;
    prefix: string;
    deleted: number;
  }>;

  // Phase 7 (D-110) — file-adapter mutation slots. Recipes invoke
  // these via file-write / file-delete / file-move / file-read. All
  // four take the same slug → instance resolution; the server-side
  // dispatcher enforces caps + auth_state before the call reaches
  // the adapter.
  /** Write bytes to a record on the named file instance. Body is
   *  base64-encoded so the rpc envelope stays JSON-clean. */
  fileWrite?: (input: {
    slug: string;
    path: string;
    body_b64: string;
    mime?: string;
  }) => Promise<{ ok: true; bytes_written: number }>;
  /** Delete a record from the named file instance. */
  fileDelete?: (input: {
    slug: string;
    path: string;
  }) => Promise<{ ok: true }>;
  /** Read bytes from a record. Returns base64-encoded body +
   *  detected mime. */
  fileRead?: (input: {
    slug: string;
    path: string;
  }) => Promise<{ body_b64: string; mime?: string }>;
  /** Move a record from one (slug, path) pair to another (slug,
   *  path) pair. Destination slug may equal source slug — the
   *  server handles cross-adapter moves by staging the body
   *  through a bounded buffer. */
  fileMove?: (input: {
    from_slug: string;
    from_path: string;
    to_slug: string;
    to_path: string;
  }) => Promise<{ ok: true }>;
  /** Stat a record — cheap metadata read. Returns
   *  { exists, size_bytes?, modified_at_ms?, mime? }. Absent records
   *  surface as { exists: false } (not an error); other adapter
   *  failures (permission, IO) propagate as typed errors. */
  fileStat?: (input: {
    slug: string;
    path: string;
  }) => Promise<{
    exists: boolean;
    size_bytes?: number;
    modified_at_ms?: number;
    mime?: string;
  }>;
  /** Backs `data-file-read`. Reads content bytes from the inbound
   *  `data.file.received` warehouse collection by record_id. */
  dataFileRead?: (input: {
    record_id: string;
  }) => Promise<{
    record_id: string;
    bytes_b64: string;
    mime_type: string;
    filename: string;
    size_bytes: number;
    blob_hash: string;
  }>;
  /** D-185 Slice 4 — backs `file-persist`. Reads a run-scoped `temp` file_ref's
   *  bytes (CONFINED to the producing run's scratch root via `run_id`) and
   *  ingests them into the `data.file.received` CAS warehouse, returning the
   *  durable `cas_ref` record_id — the explicit `temp → cas` keep step (§2). */
  filePersist?: (input: {
    ref: TempFileRef;
    run_id: string;
    step_id?: string;
  }) => Promise<{
    cas_ref: string;
    record_id: string;
    mime_type: string;
    filename: string;
    size_bytes: number;
  }>;
  /** D-200 Slice 3 — backs `file-render-markdown-template`. Reads one durable
   *  Markdown file ref, performs strict bounded scalar substitution, and emits
   *  one temp file_ref under the current run's scratch root. */
  markdownTemplateRender?: (input: {
    template_file_ref: string;
    values: Record<string, unknown>;
    strict: true;
    run_id: string;
  }) => Promise<{
    file_ref: TempFileRef;
    template_sha256: string;
    content_sha256: string;
    used_keys: string[];
    missing_keys: string[];
  }>;
  /** D-173 P5 (scan-gate part B) — backs `file-set-scan-status`. Patches a
   *  `data.file.received` record's `scan_status` hot field to a scanner verdict
   *  (`clean` / `flagged`) and emits `updated` so the reception inbox + reactive
   *  subscribers see it; idempotent (no event when unchanged). The reactive
   *  ClamAV pack recipe calls it after the local scan. MCP-reserved (the backing
   *  ingredient is `author: 'recued'` and is NOT in
   *  `MCP_EXPOSED_KERNEL_INGREDIENTS`), so an external agent can never forge a
   *  `clean` verdict on a malicious upload. */
  fileSetScanStatus?: (input: {
    record_id: string;
    status: 'pending' | 'clean' | 'flagged' | 'unscanned';
  }) => Promise<{
    record_id: string;
    scan_status: 'pending' | 'clean' | 'flagged' | 'unscanned';
  }>;
  /** D-173 P1-dispatch — backs `reception-materialize`, the LOCAL dispatch
   *  target the ingredient executor routes a reception catalog op's
   *  `materialize` to on approve-resume (instead of the placeholder
   *  `https://reception.local` HTTP binding). The boot wiring binds it to
   *  `runReceptionProjection` over the per-pair destination stores. Entity
   *  targets materialise through their Source; `form_response` verifies the
   *  canonical accepted row and creates nothing else. Absent slot →
   *  `SERVER_NOT_REACHABLE` (a dbless / reception-disabled harness surfaces a
   *  legible error, never a silent drop of the approved submission). */
  receptionMaterialize?: (
    input: ReceptionMaterializeInput,
  ) => Promise<ReceptionMaterializeResult>;

  // D-115 Phase 6 — unified watcher dispatcher. One slot handles all
  // eight watcher slugs: the kernel adapter routes by the `slug` field,
  // and the handler returns a `KernelTriggerOutput`. Slot-specific
  // logic (warehouse read, audit scan, HTTP poll, DOM selector match,
  // in-memory webhook queue, time predicate) lives in the handler;
  // this contract keeps the dispatch surface typed + uniform. Absent
  // slot → SERVER_NOT_REACHABLE, same pattern as the other kernel
  // dispatchers.
  watcher?: (input: {
    slug: KernelWatcherSlug;
    args: Record<string, unknown>;
  }) => Promise<KernelTriggerOutput>;

  /** Backs `form-response-get`. Accepted responses are already canonical
   *  records, so this dedicated slot returns the store shape unchanged. Access
   *  is enforced before dispatch by the owner-only operation grant and the
   *  `data.form_response` scope fence. */
  formResponseGet?: (input: {
    submission_id: string;
  }) => Promise<{ record: FormResponse | null }>;

  /** Bounded recipe-side collection read. Full values remain content-tainted
   * and admission is fenced to data.form_response before dispatch. */
  formResponseList?: (input: FormResponseListQuery) => Promise<{
    records: readonly FormResponse[];
    next_cursor?: FormResponseListCursor;
  }>;

  /** D-210 A.8 slice 2 — backs `form-response-set-state`. Advances the
   *  OWNER-authored lifecycle only; the visitor's answers are not writable
   *  through this slot by construction (there is no field for them). Access is
   *  enforced before dispatch by the owner-only operation grant and the
   *  `data.form_response` scope fence, same as the read. */
  formResponseSetState?: (input: {
    submission_id: string;
    lifecycle_state: FormResponseLifecycleState;
  }) => Promise<{ record: FormResponse | null }>;

  /** D-201 Slice 4 — backs `webhook-event-get`. `recipe_id` and `run_id`
   * come only from engine-supplied StepMeta; the authored call can provide only
   * the opaque locator. The server dispatcher rechecks the binding/run/pin. */
  webhookEventGet?: (
    input: { event_ref: string },
    authority: { recipe_id: string; run_id: string },
  ) => Promise<unknown>;

  // Phase D (D-106) — warehouse reader slots. Dispatched by platform
  // extracted from the kernel slug (`file-list` → platform='file').

  /** Backs `file-list`, `webhook-list`, `email-list`. */
  collectionList?: (input: {
    platform: KernelCollectionPlatform;
    slug: string;
    filters?: Record<string, unknown>;
    since?: number;
    until?: number;
    limit?: number;
  }) => Promise<{ records: KernelCollectionRecord[] }>;
  /** Backs `file-get`, `webhook-get`, `email-get`. */
  collectionGet?: (input: {
    platform: KernelCollectionPlatform;
    slug: string;
    record_id: string;
  }) => Promise<{ record: KernelCollectionRecord | null }>;
  /** Backs `email-search`. Mail is the only platform that exposes a
   *  search kernel in Phase D (file + webhook defer FTS to a later
   *  commit — see spec §kernel-ingredients). */
  collectionSearch?: (input: {
    platform: KernelCollectionPlatform;
    slug: string;
    query: string;
    limit?: number;
  }) => Promise<{ matches: KernelCollectionSearchMatch[] }>;

  // D-117 Phase 6 — eight calendar dispatcher slots. Reads
  // (list/get/search/stat) hit the server-side warehouse only;
  // writes (create/update/delete/rsvp) are verified-then-reflected
  // — the server's calendar dispatcher only writes to the warehouse
  // after the provider returns a verified canonical event. Absent
  // slot → SERVER_NOT_REACHABLE per the same pattern as file-*.

  /** Backs `calendar-list`. Returns hot-field rows ordered by
   *  `start_at` ascending. */
  calendarList?: (input: {
    slug: string;
    calendar_id?: string;
    since?: number;
    until?: number;
    status?: 'confirmed' | 'cancelled' | 'tentative';
    limit?: number;
  }) => Promise<{ records: KernelCalendarHotFields[] }>;

  /** Backs `calendar-get`. Returns the full canonical event JSON or
   *  null when the source_id is unknown. */
  calendarGet?: (input: {
    slug: string;
    source_id: string;
  }) => Promise<{ record: KernelCanonicalEvent | null }>;

  /** Backs `calendar-search`. FTS5 over summary + description +
   *  location. */
  calendarSearch?: (input: {
    slug: string;
    query: string;
    limit?: number;
  }) => Promise<{
    matches: Array<KernelCalendarHotFields & { snippet: string }>;
  }>;

  /** Backs `calendar-stat`. `event_not_found` collapses to
   *  `{ exists: false }` — file-stat precedent. */
  calendarStat?: (input: {
    slug: string;
    source_id: string;
  }) => Promise<KernelCalendarRecordStat>;

  /** Backs `calendar-create`. Not idempotent — re-fire creates
   *  duplicates. */
  calendarCreate?: (input: {
    slug: string;
    calendar_id: string;
    event: KernelCanonicalEvent;
  }) => Promise<{ source_id: string; ical_uid: string }>;

  /** Backs `calendar-update`. `scope` controls series semantics on
   *  recurring events. `'this_and_future'` on caldav rejects with
   *  `CALENDAR_RRULE_UNSUPPORTED`. */
  calendarUpdate?: (input: {
    slug: string;
    source_id: string;
    patch: KernelCanonicalEvent;
    scope?: KernelCalendarMutationScope;
  }) => Promise<{ source_id: string }>;

  /** Backs `calendar-delete`. Idempotent at provider level. D-210 step 3
   *  — echoes `source_id` (the removed event) so the engine's D-120 write
   *  link can name `calendar:<source_id>` after the warehouse row is gone. */
  calendarDelete?: (input: {
    slug: string;
    source_id: string;
    scope?: KernelCalendarMutationScope;
  }) => Promise<{ deleted: true; source_id: string }>;

  /** Backs `calendar-rsvp`. Throws `CALENDAR_ATTENDEE_NOT_SELF`
   *  when the signed-in user isn't an attendee. */
  calendarRsvp?: (input: {
    slug: string;
    source_id: string;
    response: 'accepted' | 'declined' | 'tentative';
    comment?: string;
  }) => Promise<{ source_id: string; response_status: string }>;

  // D-119 Phase 13 — annotation + link dispatcher slots. Recipe-side
  // ingredient slugs (`data-annotate`, `annotation-list`,
  // `annotation-search`, `annotation-delete`, `data-link`,
  // `link-list`, `link-delete`) all route through these. The handler
  // resolves canonical refs, stamps staleness fields, and rpcs to the
  // server's `annotation.*` / `link.*` methods. Absent slot →
  // SERVER_NOT_REACHABLE per the same pattern as other warehouse
  // surfaces; the warehouse fundamentally lives on the server.

  /** Backs `data-annotate`. Accepts either a canonical record ref
   *  (`{ ref: { _id, _collection, ... } }`) — typical when piped from
   *  a `foreach` over a `data.*` collection — or an explicit
   *  `{ target_collection, target_id }` pair. Engine pre-computes the
   *  source / recipe / model hashes and supplies them on the dispatch
   *  envelope so the kernel handler doesn't reach back into the
   *  recipe metadata. */
  annotate?: (input: {
    target_collection: string;
    target_id: string;
    key: string;
    value: unknown;
    authored_by_recipe_id: string;
    source_record_hash: string;
    recipe_hash: string;
    model_used?: string;
  }) => Promise<{ annotation: Annotation }>;

  /** Backs `annotation-list`. Filters AND together; absent fields
   *  don't restrict. */
  annotationList?: (input: AnnotationFilter) => Promise<{
    annotations: Annotation[];
  }>;

  /** Backs `annotation-search`. FTS5 over inline-stored values. */
  annotationSearch?: (input: AnnotationSearchQuery) => Promise<{
    matches: AnnotationSearchMatch[];
  }>;

  /** Backs `annotation-delete`. Refuses an empty filter — guards
   *  against accidental table-wipe. */
  annotationDelete?: (input: AnnotationFilter) => Promise<{
    ok: true;
    deleted: number;
  }>;

  /** Backs `data-link`. Accepts canonical refs on either side. */
  linkWrite?: (input: {
    from_collection: string;
    from_id: string;
    to_collection: string;
    to_id: string;
    role: string;
    authored_by_recipe_id: string;
  }) => Promise<{ link: Link }>;

  /** Backs `link-list`. Filters AND together. */
  linkList?: (input: LinkFilter) => Promise<{ links: Link[] }>;

  /** Backs `link-delete`. Refuses an empty filter. */
  linkDelete?: (input: LinkFilter) => Promise<{
    ok: true;
    deleted: number;
  }>;

  // D-122 Phase 2 — graph-builder kernel ingredients. Five new slots
  // backing the foundational extraction recipe authoring surface.
  // `contactUpsert` shims the existing `contact.upsert` rpc;
  // `mailThreadRead` is a new server-side handler that bundles every
  // `data.mail` row sharing `thread_id`; `linkCreate` + `annotationCreate`
  // wrap the annotation/link write paths with upsert semantics plus
  // probabilistic metadata (confidence / evidence on links; confidence
  // folded into value on annotations); `timelineRead` re-exposes the MCP
  // `data.timeline()`
  // primitive on the recipe channel per the channel-isolation invariant.
  // All five live on the server (warehouse-resident); ext callers reach
  // them via the paired-WS rpc transport. `linkCreate` is a semantic
  // upsert in the production SQLite store; lightweight adapters may retain
  // the compatibility delete-then-insert path at the server handler.

  /** Backs `contact-upsert`. Idempotent — first-seen-wins on
   *  `first_seen`, latest-wins on `last_interaction`. The underlying
   *  store canonicalizes the email before lookup. */
  contactUpsert?: (input: {
    email: string;
    display_name?: string;
    last_interaction?: number;
    first_seen?: number;
    /** D-161 P2 — origin provenance facet, forwarded from
     *  `call.stepMeta?.actor` so a recipe-driven `contact-upsert` stamps
     *  the run's actor (an MCP recipe → `contracted_user`), not the direct
     *  rpc's `'user_self'`. Absent on direct callers → store default
     *  `'system'`. The paired-server dispatcher lifts it off the trusted
     *  input into the handler deps (never spoofable, I-6 / A.5). */
    origin_actor?: Actor;
    /** D-161 P2 — contract in force on the writing execution. */
    origin_contract_id?: string;
  }) => Promise<{ contact: ContactRecord }>;

  /** Backs `contact-resolve` (D-145 PA8 follow-on). Resolves a single
   *  identifier — email / phone / alias / platform_id — to a local
   *  `contact_id`. Read-only; the handler owns the exactly-one-identifier
   *  rule and walks the D-138 merged_into chain on the email path so a
   *  stale post-merge address surfaces the surviving contact.
   *  `contact_id` is null on a miss; `alternatives` carries candidate
   *  ids for an ambiguous phone / alias lookup; `contact` is the full
   *  record on a confident hit. */
  contactResolve?: (input: {
    email?: string;
    phone?: string;
    alias?: string;
    platform_id?: { platform: ContactAliasPlatform; id: string };
  }) => Promise<{
    contact_id: string | null;
    confidence: number;
    alternatives: string[];
    contact?: ContactRecord;
  }>;

  /** Backs `contact-business-context`. Recomputes a metadata-only, zero-AI
   * relationship projection from existing contact, CRM, work-entity, and
   * calendar stores. The mutually-exclusive `level` lets recipes consume the
   * correlated family as one capped signal. */
  contactBusinessContext?: (input: {
    email: string;
    as_of: number;
    known_before_at: number;
  }) => Promise<ContactBusinessContextResult>;

  /** Backs `mail-thread-reader`. Queries `data.mail` records matching
   *  `thread_id`, sorts ascending by `received_at`, returns up to
   *  `max_messages` messages plus first/last timestamps + count. */
  mailThreadRead?: (input: {
    slug: string;
    thread_id: string;
    max_messages?: number;
  }) => Promise<{
    messages: KernelCollectionRecord[];
    message_count: number;
    first_at: number;
    last_at: number;
  }>;

  /** Backs `link-create`. The kernel adapter pre-splits source/target
   *  on the first colon and resolves `kind` → `role`; the dispatcher
   *  receives normalized canonical fields plus confidence + evidence.
   *  Idempotent on (from, to, role): the dispatcher deletes any prior
   *  row at that key before insert (caller need not check). */
  linkCreate?: (input: {
    from_collection: string;
    from_id: string;
    to_collection: string;
    to_id: string;
    role: string;
    authored_by_recipe_id: string;
    confidence?: number;
    evidence?: string;
    event_at?: number;
    /** D-161 P2 — origin provenance facet. The kernel adapter forwards
     *  `call.stepMeta?.actor` (= the run's `ExecutionSource.actor`) so the
     *  paired-server dispatcher stamps `origin_actor` on the written link
     *  row, propagated from the run (I-6). Absent on direct callers
     *  without recipe context → store defaults to `'system'`. */
    origin_actor?: Actor;
    /** D-161 P2 — contract in force on the writing execution, forwarded
     *  from `call.stepMeta?.contract_id`. Present iff contracted. */
    origin_contract_id?: string;
  }) => Promise<{ link: Link }>;

  /** Backs `annotation-create`. The kernel adapter pre-splits target
   *  on the first colon and folds optional confidence into value as
   *  `{ value, confidence }` before the dispatcher sees it. Idempotent
   *  on (target_collection, target_id, key): the dispatcher deletes
   *  any prior row at that triple before insert. */
  annotationCreate?: (input: {
    target_collection: string;
    target_id: string;
    key: string;
    value: unknown;
    authored_by_recipe_id: string;
    source_record_hash: string;
    recipe_hash: string;
    model_used?: string;
    event_at?: number;
    /** D-161 P2 — origin provenance facet, forwarded from
     *  `call.stepMeta?.actor` (mirrors `linkCreate` / `enrichmentUpsert`).
     *  Absent on direct callers → store defaults to `'system'`. */
    origin_actor?: Actor;
    /** D-161 P2 — contract in force on the writing execution. */
    origin_contract_id?: string;
  }) => Promise<{ annotation_id: string; annotation: Annotation }>;

  /** Backs `timeline-read`. The kernel adapter passes the combined
   *  entity string straight through (`<collection>:<id>` is the same
   *  format the MCP primitive expects). Returns the same response
   *  shape as `data.timeline()`. P7.G — `trigger_source` mirrors the
   *  enclosing recipe execution's origin so the recipe-channel
   *  dispatcher can apply `mcp_exposed: 'private'` gating when set to
   *  `'mcp'` (paired-client triggers stay user-permissive). */
  timelineRead?: (input: {
    entity: string;
    axis?: 'event' | 'ingestion';
    since?: number;
    until?: number;
    limit?: number;
    cursor?: string;
    trigger_source?: string;
    /** D-187 — contract in force on the reading execution, forwarded from
     *  `call.stepMeta?.contract_id`. The dispatcher resolves the enclosing
     *  recipe's per-(bound contract, topic) enrichment read-visibility against it
     *  when `trigger_source === 'mcp'`. Present iff contracted. */
    origin_contract_id?: string;
  }) => Promise<{ entries: TimelineEntry[]; next_cursor?: string }>;

  // D-122 Phase 4.5 — enrichment substrate ingredients. Five new
  // slots covering generic write/read into `data.enrichment.*` plus
  // mail-get + notification-send. All five live on the server
  // (warehouse-resident); ext callers reach them via the paired-WS
  // rpc transport.

  /** Backs `enrichment-upsert`. The kernel adapter normalizes the
   *  shape A vs B input (callers pass `id` either way; the dispatcher
   *  routes per registry shape). Engine pre-stamps recipe_hash +
   *  source_record_hash; recipes don't compute these directly. */
  enrichmentUpsert?: (input: {
    topic: string;
    scope?: EnrichmentScope;
    id: string;
    value: unknown;
    authored_by_recipe_id: string;
    source_record_hash?: string;
    recipe_hash?: string;
    /** D-136 P2 — replaces legacy `model_used`. */
    ingredient_slug?: string;
    /** D-136 P2 — resolved provider model id (P3 retrofit). */
    model_id?: string;
    event_at?: number;
    /** D-161 P1 — origin provenance facet. The kernel adapter forwards
     *  `call.stepMeta?.actor` (= the run's `ExecutionSource.actor`) so the
     *  paired-server dispatcher stamps `origin_actor` on the written
     *  `data_enrichment` row, propagated from the run (I-6). Absent on
     *  direct callers without a recipe context → store defaults to
     *  `'system'`. */
    origin_actor?: Actor;
    /** D-161 P1 — contract in force on the writing execution, forwarded
     *  from `call.stepMeta?.contract_id`. Present iff contracted. */
    origin_contract_id?: string;
  }) => Promise<{ _id: string; wrote: true }>;

  /** Backs `enrichment-list`. */
  enrichmentList?: (input: {
    topic: string;
    scope?: EnrichmentScope;
    target_id?: string;
    authored_by_recipe_id?: string;
    fresh_only?: boolean;
    limit?: number;
    offset?: number;
    /** D-136 P7.E — origin of the enclosing recipe execution. The
     *  kernel adapter forwards `call.stepMeta?.trigger_source` so the
     *  paired-server dispatcher can apply policy gates such as
     *  `mcp_exposed: 'private'` rejection on the MCP-triggered path.
     *  Optional — direct callers without a recipe context leave it
     *  absent and the dispatcher applies its default policy. */
    trigger_source?: string;
    /** D-187 — contract in force on the reading execution, forwarded from
     *  `call.stepMeta?.contract_id`. The dispatcher resolves the topic's
     *  per-(bound contract, topic) read-visibility against it (the recipe-channel
     *  analog of the native MCP tool's door contract). Present iff contracted. */
    origin_contract_id?: string;
  }) => Promise<{ entries: unknown[]; next_cursor: string | null }>;

  /** Backs `mail-get`. Single-record warehouse read; symmetric with
   *  `calendarGet`. Returns null when the record_id is unknown. */
  mailGet?: (input: { slug: string; record_id: string }) =>
    Promise<{ record: unknown | null }>;

  /** Backs `mail-body-read`. Materializes a mail record's full body —
   *  `body_inline` directly (≤64 KB) or hydrated from content-addressed
   *  storage via `blob_hash` (>64 KB) — closing the gap where `mail-get`
   *  hands back the inline-or-hash pointer and >64 KB bodies read as
   *  nothing. `body` is null when the record is missing, has no body, or
   *  the CAS blob is unresolvable; `found` is true iff the record exists.
   *  `max_chars`, when set, caps the returned body and flags `truncated`. */
  mailBodyRead?: (input: { slug: string; record_id: string; max_chars?: number }) =>
    Promise<{ body: string | null; found: boolean; size_bytes: number; truncated: boolean }>;

  /** Backs `notification-send`. Routes per channel; result shape
   *  reports per-channel delivery outcome. `link_url` is the deep
   *  link target surfaced alongside the body — renamed from `url`
   *  to dodge collision with the engine-locked HTTP routing key.
   *  Omitted channels fan out to every supported notification channel. */
  notificationSend?: (input: {
    channels?: ReadonlyArray<NotificationDeliveryChannel>;
    text: string;
    title?: string;
    link_url?: string;
  }) => Promise<{
    delivered_to: Array<NotificationDeliveryChannel>;
    failed: Array<NotificationDeliveryChannel>;
  }>;

  /** Backs `core.notification.recipe-callback`. Queues a bounded pointer for
   * active MCP tokens bound to the selected contract and explicitly granted the
   * named query recipe. The callback is only a hint; its arguments are replayed
   * through the ordinary MCP tool gate when the client follows it. */
  notificationRecipeCallback?: (input: {
    destination_contract_id: string;
    topic: string;
    query_tool: string;
    arguments: Record<string, unknown>;
    ttl_seconds?: number;
    /** Trusted engine provenance; never accepted from authored input. */
    source_recipe_id: string;
  }) => Promise<{
    queued_to: number;
    failed_to: number;
    coalesced: true;
    skipped_reason: string | null;
  }>;

  /** D-193 — backs `schedule-recipe`. Creates a server-owned schedule
   *  for an already-installed recipe only. The dispatcher wires the
   *  local RecipeStore + ScheduleStore, so inline recipe JSON is not a
   *  supported input path. */
  scheduleRecipe?: (input: KernelScheduleRecipeInput) => Promise<{
    schedule: unknown;
  }>;

  /** Core Seller registry. The server owns its DB/schema/menu/UI; recipes can
   *  compose only through these fixed dispatch slots. */
  sellerOfferEnsure?: (
    input: KernelSellerOfferEnsureInput,
  ) => Promise<SellerOfferEnsureResult>;
  sellerOfferFulfillmentAttach?: (
    input: KernelSellerOfferFulfillmentAttachInput,
  ) => Promise<SellerOfferFulfillmentAttachResult>;
  sellerOfferGet?: (input: { offer_id: string }) => Promise<{
    offer: SellerOffer | null;
  }>;
  sellerOfferList?: (input: KernelSellerOfferListInput) => Promise<{
    offers: SellerOffer[];
  }>;

  /** D-196 §4.5 — vendor-neutral tier reads. ⛔ Typed on `SellerTierPublic`,
   *  never the full `SellerTier` row: the wiring projects through
   *  `toPublicSellerTier`, so `template_contract_id` (the private authority
   *  pointer) and tier row ids cannot cross into recipe step state. */
  sellerTierGet?: (input: KernelSellerTierGetInput) => Promise<{
    tier: SellerTierPublic | null;
  }>;
  sellerTierList?: (input: KernelSellerTierListInput) => Promise<{
    tiers: SellerTierPublic[];
  }>;

  /** D-207 §4.3 — the order (money) leg. Absent slots surface
   *  SERVER_NOT_REACHABLE for dbless / seller-disabled harnesses, exactly like
   *  the offer slots above. */
  sellerOrderOpen?: (input: KernelSellerOrderOpenInput) => Promise<{
    result: 'created' | 'existing';
    order: unknown;
    correlation: unknown;
  }>;
  sellerOrderGet?: (input: KernelSellerOrderGetInput) => Promise<{
    order: unknown;
  }>;
  sellerOrderList?: (input: KernelSellerOrderListInput) => Promise<{
    orders: unknown[];
  }>;
  sellerOrderQuote?: (
    input: KernelSellerOrderQuoteInput,
  ) => Promise<KernelSellerOrderMutationResult>;
  sellerOrderAttachPayment?: (
    input: KernelSellerOrderAttachPaymentInput,
  ) => Promise<KernelSellerOrderMutationResult>;
  sellerOrderConfirmPayment?: (
    input: KernelSellerOrderConfirmPaymentInput,
  ) => Promise<KernelSellerOrderMutationResult>;
  sellerOrderConfirmRenewalPayment?: (
    input: KernelSellerOrderConfirmRenewalPaymentInput,
  ) => Promise<KernelSellerOrderMutationResult>;
  sellerOrderConfirmRefund?: (
    input: KernelSellerOrderConfirmRefundInput,
  ) => Promise<KernelSellerOrderMutationResult>;
  /** D-207 slice 3d — the general no-resend fence. Takes ONLY the reconciliation id:
   *  the server reads the claim `mail-send` wrote before dispatch, derives the whole
   *  provider query from it, asks provider source truth, and settles the claim on the
   *  provider's VERDICT. A caller who could author the recipient, subject or window
   *  could forge a match — and a forged match marks a document delivered that was
   *  never sent. */
  mailSentReconcile?: (input: {
    reconciliation_id: string;
  }) => Promise<KernelMailSentReconcileResult>;
  sellerOrderAttachArtifact?: (
    input: KernelSellerOrderAttachArtifactInput,
  ) => Promise<KernelSellerOrderMutationResult>;
  sellerOrderTransition?: (
    input: KernelSellerOrderTransitionInput,
  ) => Promise<KernelSellerOrderMutationResult>;
  sellerOrderLinkWorkEntity?: (
    input: KernelSellerOrderLinkWorkEntityInput,
  ) => Promise<KernelSellerOrderMutationResult>;
  sellerOrderLinkCustomer?: (
    input: KernelSellerOrderLinkCustomerInput,
  ) => Promise<KernelSellerOrderMutationResult>;

  /** D-196 — seller-customer access lifecycle ops. These mutate the local
   *  seller customer row, customer-instance contract, and bound inbound MCP
   *  token through the server lifecycle service. Absent slots surface
   *  SERVER_NOT_REACHABLE for dbless / seller-disabled harnesses. */
  customerAccessIssue?: (
    input: KernelCustomerAccessIssueInput,
  ) => Promise<KernelCustomerAccessIssueResult>;
  customerAccessExtend?: (
    input: KernelCustomerAccessExtendInput,
  ) => Promise<{ customer: SellerCustomer }>;
  customerAccessSwapTier?: (
    input: KernelCustomerAccessSwapTierInput,
  ) => Promise<{ customer: SellerCustomer }>;
  customerAccessClose?: (
    input: KernelCustomerAccessCloseInput,
  ) => Promise<{ customer: SellerCustomer }>;

  // D-127 P2.1 — kernel `mail-send` dispatcher. Routes to
  // `collection.mail.send` server-side (or rpcs into the paired server
  // ext-side). Sender ≠ to / capability gate / audit emission all live
  // in the underlying `MailCollection.send` (P1.6 + P1.7) — the
  // dispatcher just resolves the instance and forwards.
  //
  // D-127 follow-on — `recipe_id` / `step_id` flow from the engine via
  // `ResolvedCall.stepMeta` so the rpc-layer `mail_send` audit row can
  // attribute back to the originating recipe + step. Optional because
  // direct callers (Settings → Connections probe, MCP agent, tests)
  // reach the dispatcher without an engine context — the audit row
  // simply omits both fields in that case.
  mailSend?: (input: {
    instance: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    body_text: string;
    body_html?: string;
    in_reply_to?: string;
    references?: string[];
    reply_to?: string;
    /** Optional compact identity committed before a non-idempotent send.
     * Providers carry it in X-Recued-Reconciliation-ID so source-truth
     * ingestion can find an otherwise response-less accepted message. */
    reconciliation_id?: string;
    /** D-172 P2 — `data.file` record-id refs to attach. Resolved to
     *  bytes at the backend `MailCollection.send` layer (the kernel
     *  forwards refs only). */
    attachments?: string[];
    recipe_id?: string;
    step_id?: string;
  }) => Promise<{
    source_id: string;
    message_id: string;
    sent_at: number;
    thread_id?: string;
    warnings?: Array<{ code: string; message: string }>;
    _id: string | null;
    _collection: 'data.mail';
  }>;

  /** D-210 §7 — notify a booking's visitor server-side. The recipe supplies the
   *  BOOKING, the owner's sender account, and the message; the dispatcher reads
   *  the booking's own `reception_record_id` back to the sealed
   *  `reception_booking_request`, opens ONLY the `visitor_email` at send-time,
   *  and delegates the actual send to `mailSend`.
   *  ⛔ The visitor address is NEVER an input and NEVER returned — the recipe can
   *  address a booking's visitor without ever holding their PII (owner ruling:
   *  resolved server-side at send-time). Returns `notified` + a coarse `reason`
   *  when there is nothing to send (`not_a_reception_booking` /
   *  `booking_not_found` / `no_visitor_email`), never the address.
   *  ⚠ Took `event_source_id` (a calendar event) until D-210 A.2 — a booking is
   *  never in the calendar, so there is no event to name. */
  notifyBookingVisitor?: (input: {
    booking_id: string;
    sender_mail_instance: string;
    subject: string;
    body: string;
    body_format?: 'text' | 'html';
    recipe_id?: string;
    step_id?: string;
  }) => Promise<{ notified: boolean; reason?: string }>;

  // ── Work-entity recipe reads + D-145 PA3 CRUD dispatcher slots ───
  /** Recipe-callable polymorphic read. `parent_project_id` is exact and is
   *  admitted only for task/project, keeping federation reads scoped before
   *  any row enters recipe state. */
  workEntityList?: (input: {
    kind: WorkEntityKind;
    source_id?: string;
    sync_states?: readonly SyncState[];
    include_deleted?: boolean;
    include_disabled?: boolean;
    parent_project_id?: string;
    limit?: number;
    offset?: number;
  }) => Promise<{ entities: WorkEntity[]; total: number }>;
  /** Recipe-callable by-id native read. */
  workEntityGet?: (input: {
    kind: WorkEntityKind;
    id: string;
  }) => Promise<{ entity: WorkEntity | null; found: boolean }>;

  // ── D-145 PA3 — work-entity CRUD dispatcher slots ───────────────
  // 14 slots covering task / note / commitment / project CRUD. Every
  // slot resolves the Source the same way (input.source_id wins; per-
  // kind default-Source memory next; Recued built-in for the kind as
  // the final fallback) and validates write-capability + commitment
  // lifecycle moves at the dispatch layer. Connection-Source writes
  // route through the first-dispatch capability probe (PA2 registers
  // `write_capable: false` until proof; PA3 dispatch flips it via
  // `registerSource` UPSERT after successful vendor write — vendor
  // task adapters land in PA4+). Absent slot → SERVER_NOT_REACHABLE
  // per the kernel adapter precedent.
  taskCreate?: (input: {
    title: string;
    idempotency_key?: string;
    body?: string;
    due_at?: number;
    priority?: TaskPriority;
    state?: string;
    progress?: number;
    done?: boolean;
    completed_at?: number;
    assigned_contact_id?: string;
    parent_calendar_event_id?: string;
    linked_mail_thread_id?: string;
    parent_project_id?: string;
    blocks_task_ids?: readonly string[];
    source_extension_blob?: Record<string, unknown>;
    source_id?: string;
    /** D-192 P4 — run-origin fields the adapter forwards from
     *  `call.stepMeta` (actor + trigger_source) so the dispatcher's
     *  actor-aware Source resolution can tell an LLM-origin create
     *  (chat / mcp / contracted_user → default LOCAL, skip the sticky
     *  per-kind default) from a human / recipe one. Mirrors the
     *  `contactUpsert` origin forwarding. */
    origin_actor?: Actor;
    origin_trigger_source?: string;
    /** D-192 6c.2c — caller-named vendor containers by dependency ref
     *  (`{ project: 'Roadmap' }`), forwarded verbatim to the create-assist
     *  resolver (label-exact pick, else a granted create-plan). */
    container_names?: Record<string, string>;
    /** D-192 6c.2c — engine-set create-plan / container-pick re-run flag,
     *  forwarded from `StepMeta` by `withCreateOrigin` (recipe-supplied values
     *  stripped). Admits the vendor create past its `'ask'` gate on the re-run. */
    work_entity_write_preadmitted?: boolean;
  }) => Promise<{ task: Task }>;
  taskUpdate?: (input: {
    id: string;
    title?: string;
    body?: string;
    due_at?: number;
    priority?: TaskPriority;
    state?: string;
    progress?: number;
    assigned_contact_id?: string;
    parent_calendar_event_id?: string;
    linked_mail_thread_id?: string;
    parent_project_id?: string;
    blocks_task_ids?: readonly string[];
    source_extension_blob?: Record<string, unknown>;
  }) => Promise<{ task: Task }>;
  taskDelete?: (input: {
    id: string;
    tombstone?: boolean;
  }) => Promise<{ ok: true; id: string; tombstoned: boolean }>;
  taskMarkDone?: (input: {
    id: string;
    done?: boolean;
    completed_at?: number;
  }) => Promise<{ task: Task }>;

  noteCreate?: (input: {
    body: string;
    title?: string;
    related_contact_ids?: readonly string[];
    related_calendar_event_ids?: readonly string[];
    related_mail_thread_ids?: readonly string[];
    related_project_ids?: readonly string[];
    source_id?: string;
    /** D-192 P4 — see `taskCreate`. */
    origin_actor?: Actor;
    origin_trigger_source?: string;
    /** D-192 6c.2c — see `taskCreate`. */
    container_names?: Record<string, string>;
    work_entity_write_preadmitted?: boolean;
  }) => Promise<{ note: Note }>;
  noteUpdate?: (input: {
    id: string;
    body?: string;
    title?: string;
    related_contact_ids?: readonly string[];
    related_calendar_event_ids?: readonly string[];
    related_mail_thread_ids?: readonly string[];
    related_project_ids?: readonly string[];
  }) => Promise<{ note: Note }>;
  noteDelete?: (input: {
    id: string;
    tombstone?: boolean;
  }) => Promise<{ ok: true; id: string; tombstoned: boolean }>;

  commitmentCreate?: (input: {
    direction: CommitmentDirection;
    statement: string;
    derivation: CommitmentDerivation;
    promised_at?: number;
    promised_for_at?: number;
    expiry_policy?: CommitmentExpiryPolicy;
    derivation_confidence?: number;
    monetary_value?: MonetaryValue;
    counterparty_contact_id?: string;
    derived_from_mail_thread_id?: string;
    derived_from_meeting_id?: string;
    blocks_task_ids?: readonly string[];
    blocks_project_ids?: readonly string[];
    source_id?: string;
    /** D-192 F1 — immutable evidence snapshots; paired with
     *  `derivation: 'evidence_captured'` (the ingredient enforces the
     *  pairing both ways). */
    evidence_blob?: readonly CommitmentEvidenceEntry[];
    /** D-192 P4 — see `taskCreate`. */
    origin_actor?: Actor;
    origin_trigger_source?: string;
  }) => Promise<{ commitment: Commitment }>;
  commitmentUpdate?: (input: {
    id: string;
    statement?: string;
    promised_for_at?: number;
    expiry_policy?: CommitmentExpiryPolicy;
    monetary_value?: MonetaryValue;
    counterparty_contact_id?: string;
    derivation_confidence?: number;
    blocks_task_ids?: readonly string[];
    blocks_project_ids?: readonly string[];
  }) => Promise<{ commitment: Commitment }>;
  commitmentFulfill?: (input: {
    id: string;
    fulfilled_at?: number;
  }) => Promise<{ commitment: Commitment }>;
  commitmentCancel?: (input: {
    id: string;
    cancelled_at?: number;
  }) => Promise<{ commitment: Commitment }>;

  projectCreate?: (input: {
    title: string;
    description?: string;
    state?: ProjectState;
    target_completion_at?: number;
    related_contact_ids?: readonly string[];
    parent_project_id?: string;
    source_id?: string;
    /** D-192 P4 — see `taskCreate`. */
    origin_actor?: Actor;
    origin_trigger_source?: string;
    /** D-192 6c.2c — see `taskCreate`. */
    container_names?: Record<string, string>;
    work_entity_write_preadmitted?: boolean;
  }) => Promise<{ project: Project }>;
  projectUpdate?: (input: {
    id: string;
    title?: string;
    description?: string;
    state?: ProjectState;
    target_completion_at?: number;
    related_contact_ids?: readonly string[];
    parent_project_id?: string;
  }) => Promise<{ project: Project }>;
  projectArchive?: (input: {
    id: string;
  }) => Promise<{ project: Project }>;

  /** D-210 — booking. The booking owns its OWN time (A.2): booking and
   *  calendar are disjoint, so `slot_start_at` / `slot_end_at` are this
   *  row's fact. Both or neither; duration is derived, never sent. */
  bookingCreate?: (input: {
    title: string;
    lifecycle_state?: BookingLifecycleState;
    slot_start_at?: number;
    slot_end_at?: number;
    monetary_value?: MonetaryValue;
    counterparty_contact_id?: string;
    // ⛔ NO `reception_record_id` — see the `booking-create` arm. Provenance is
    // server-written through the store, never authored by a kernel caller.
    source_id?: string;
    /** D-192 P4 — see `taskCreate`. */
    origin_actor?: Actor;
    origin_trigger_source?: string;
    work_entity_write_preadmitted?: boolean;
  }) => Promise<{ booking: Booking }>;
  bookingUpdate?: (input: {
    id: string;
    title?: string;
    lifecycle_state?: BookingLifecycleState;
    /** Reschedule. BOTH or NEITHER — a half-supplied pair is refused,
     *  not half-applied. */
    slot_start_at?: number;
    slot_end_at?: number;
    monetary_value?: MonetaryValue;
    counterparty_contact_id?: string;
  }) => Promise<{ booking: Booking }>;
  bookingDelete?: (input: {
    id: string;
    tombstone?: boolean;
  }) => Promise<{ ok: true; id: string; tombstoned: boolean }>;
}

/** Produce an Adapter that dispatches the shared-* kernel slugs
 *  to the provided callbacks. Useful from both the server runtime (in-
 *  process) and the ext runtime (rpc). */
export const createKernelAdapter = (dispatchers: KernelDispatchers): Adapter => {
  return async (call: ResolvedCall): Promise<unknown> => {
    const slug = call.slug;
    // §5 — a `core-<bare>` kernel alias (e.g. `core-notification-send`) dispatches
    // to the same case as its bare slug; `slug` stays the raw value for error context.
    switch (stripCorePrefix(slug)) {
      case 'shared-write': {
        if (!dispatchers.write) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `shared-write unavailable — no paired server or kernel dispatcher`,
            { slug },
          );
        }
        const { key, value, ttl } = call.input as { key: string; value: unknown; ttl?: number };
        return dispatchers.write({ key, value, ttl });
      }
      case 'shared-compare-and-set': {
        if (!dispatchers.compareAndSet) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `shared-compare-and-set unavailable — no paired server or kernel dispatcher`,
            { slug },
          );
        }
        const { key, expected_revision, value } = call.input as {
          key: unknown;
          expected_revision: number | null;
          value: unknown;
        };
        if (typeof key !== 'string' || key.length === 0) {
          throw new IngredientError(
            'BAD_INPUT',
            `shared-compare-and-set: key is required`,
            { slug },
          );
        }
        if (
          expected_revision !== null
          && (!Number.isSafeInteger(expected_revision) || expected_revision < 0)
        ) {
          throw new IngredientError(
            'BAD_INPUT',
            `shared-compare-and-set: expected_revision must be null or a non-negative safe integer`,
            { slug, expected_revision },
          );
        }
        return dispatchers.compareAndSet({
          key,
          expected_revision,
          value,
        });
      }
      case 'exchange-status': {
        // D-232 § 23 — `output.exchange` hands the caller a ref; this is what
        // makes that ref answerable from RECIPE-LAND. `listByExchangeRef` was
        // wired only to the AI door, so a model could ask and the recipe that
        // started the exchange could not.
        if (!dispatchers.exchangeStatus) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `exchange-status unavailable — the answer lives in the server's audit trail`,
            { slug },
          );
        }
        const { exchange_ref, callback_op } = call.input as {
          exchange_ref: unknown; callback_op: unknown;
        };
        if (typeof exchange_ref !== 'string' || exchange_ref.length === 0) {
          throw new IngredientError('BAD_INPUT', `exchange-status: exchange_ref is required`, { slug });
        }
        return await dispatchers.exchangeStatus({
          exchange_ref,
          ...(typeof callback_op === 'string' && callback_op.length > 0
            ? { callback_op }
            : {}),
        });
      }
      case 'shared-read': {
        if (!dispatchers.read) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `shared-read unavailable — no paired server or kernel dispatcher`,
            { slug },
          );
        }
        const { key } = call.input as { key: unknown };
        if (typeof key !== 'string' || key.length === 0) {
          throw new IngredientError(
            'BAD_INPUT',
            `shared-read: key is required`,
            { slug },
          );
        }
        const out = await dispatchers.read({ key });
        return out;
      }
      case 'shared-list': {
        if (!dispatchers.list) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `shared-list unavailable — no paired server or kernel dispatcher`,
            { slug },
          );
        }
        const { prefix } = call.input as { prefix: string };
        const out = await dispatchers.list({ prefix });
        // D-119 Phase 12 — shared entries carry their `key` as `_id`.
        return {
          entries: stampMany(out.entries, 'shared', (e) => e.key),
        };
      }
      case 'shared-search': {
        if (!dispatchers.search) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `shared-search unavailable — no paired server or kernel dispatcher`,
            { slug },
          );
        }
        const { scope, query } = call.input as { scope: string; query: string };
        const out = await dispatchers.search({ scope, query });
        return {
          matches: stampMany(out.matches, 'shared', (m) => m.key),
        };
      }
      case 'shared-delete': {
        if (!dispatchers.delete) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `shared-delete unavailable — no paired server or kernel dispatcher`,
            { slug },
          );
        }
        const { key } = call.input as { key: string };
        return dispatchers.delete({ key });
      }
      case 'shared-delete-prefix': {
        if (!dispatchers.deletePrefix) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `shared-delete-prefix unavailable — no paired server or kernel dispatcher`,
            { slug },
          );
        }
        const { prefix } = call.input as { prefix: string };
        return dispatchers.deletePrefix({ prefix });
      }

      case 'form-response-list': {
        if (!dispatchers.formResponseList) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            'form-response-list unavailable — no paired server or form-response dispatcher',
            { slug },
          );
        }
        const input = call.input as Record<string, unknown>;
        assertOnlyKernelInputFields(
          input,
          ['endpoint_id', 'form_definition_id', 'lifecycle_states', 'before', 'limit'],
          slug,
        );
        const badListInput = (message: string): never => {
          throw new IngredientError('BAD_INPUT', `form-response-list: ${message}`, { slug });
        };
        // Ingredient dispatch merges manifest defaults first. Optional fields
        // therefore arrive as null, not undefined; normalize those defaults to
        // absence before validating explicit values.
        const limit = input.limit == null ? 100 : input.limit;
        if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 499) {
          badListInput('limit must be an integer between 1 and 499');
        }
        for (const key of ['endpoint_id', 'form_definition_id'] as const) {
          const value = input[key];
          if (
            value !== undefined
            && value !== null
            && (typeof value !== 'string' || value.trim().length === 0)
          ) {
            badListInput(`${key} must be a non-empty string when supplied`);
          }
        }
        if (input.lifecycle_states !== undefined && input.lifecycle_states !== null) {
          if (
            !Array.isArray(input.lifecycle_states)
            || input.lifecycle_states.length === 0
            || input.lifecycle_states.some(
              (state) => !FORM_RESPONSE_LIFECYCLE_STATE_SET.has(
                state as FormResponseLifecycleState,
              ),
            )
          ) {
            badListInput(
              `lifecycle_states must be a non-empty array of: ${FORM_RESPONSE_LIFECYCLE_STATES.join(', ')}`,
            );
          }
        }
        if (input.before !== undefined && input.before !== null) {
          const before = input.before as Record<string, unknown> | null;
          if (
            before === null
            || typeof before !== 'object'
            || Array.isArray(before)
            || !Number.isSafeInteger(before.accepted_at)
            || (before.accepted_at as number) < 0
            || typeof before.submission_id !== 'string'
            || before.submission_id.trim().length === 0
          ) {
            badListInput('before must contain a non-negative accepted_at and submission_id');
          }
        }
        return dispatchers.formResponseList({
          limit: limit as number,
          ...(typeof input.endpoint_id === 'string' ? { endpoint_id: input.endpoint_id } : {}),
          ...(typeof input.form_definition_id === 'string'
            ? { form_definition_id: input.form_definition_id }
            : {}),
          ...(Array.isArray(input.lifecycle_states)
            ? { lifecycle_states: input.lifecycle_states as FormResponseListQuery['lifecycle_states'] }
            : {}),
          ...(input.before !== undefined && input.before !== null
            ? { before: input.before as FormResponseListCursor }
            : {}),
        });
      }

      case 'form-response-get': {
        if (!dispatchers.formResponseGet) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `form-response-get unavailable — no paired server or form-response dispatcher`,
            { slug },
          );
        }
        const input = call.input as { submission_id?: unknown };
        if (
          typeof input.submission_id !== 'string'
          || input.submission_id.trim().length === 0
        ) {
          throw new IngredientError(
            'BAD_INPUT',
            'form-response-get: submission_id is required',
            { slug },
          );
        }
        return dispatchers.formResponseGet({ submission_id: input.submission_id });
      }

      case 'form-response-set-state': {
        if (!dispatchers.formResponseSetState) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `form-response-set-state unavailable — no paired server or form-response dispatcher`,
            { slug },
          );
        }
        const input = call.input as {
          submission_id?: unknown;
          lifecycle_state?: unknown;
        };
        if (
          typeof input.submission_id !== 'string'
          || input.submission_id.trim().length === 0
        ) {
          throw new IngredientError(
            'BAD_INPUT',
            'form-response-set-state: submission_id is required',
            { slug },
          );
        }
        // Build the message from the contract const, never a copied literal —
        // an agent that supplies a bad value reads back the ACTUAL accepted
        // set, and the message cannot drift from the vocabulary it guards.
        if (
          typeof input.lifecycle_state !== 'string'
          || !FORM_RESPONSE_LIFECYCLE_STATE_SET.has(
            input.lifecycle_state as FormResponseLifecycleState,
          )
        ) {
          throw new IngredientError(
            'BAD_INPUT',
            'form-response-set-state: lifecycle_state must be one of: '
              + FORM_RESPONSE_LIFECYCLE_STATES.join(', '),
            { slug },
          );
        }
        return dispatchers.formResponseSetState({
          submission_id: input.submission_id,
          lifecycle_state: input.lifecycle_state as FormResponseLifecycleState,
        });
      }

      case 'webhook-event-get': {
        if (!dispatchers.webhookEventGet) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            'webhook-event-get unavailable — no paired server or scoped event dispatcher',
            { slug },
          );
        }
        const input = call.input as { event_ref?: unknown };
        if (typeof input.event_ref !== 'string' || input.event_ref.trim().length === 0) {
          throw new IngredientError(
            'BAD_INPUT',
            'webhook-event-get: event_ref is required',
            { slug },
          );
        }
        const recipeId = call.stepMeta?.recipe_id;
        const runId = call.stepMeta?.run_id;
        if (typeof recipeId !== 'string' || recipeId.length === 0
          || typeof runId !== 'string' || runId.length === 0) {
          throw new IngredientError(
            'WEBHOOK_EVENT_NOT_AUTHORIZED',
            'webhook event is unavailable to this recipe run',
            { slug },
          );
        }
        return dispatchers.webhookEventGet(
          { event_ref: input.event_ref },
          { recipe_id: recipeId, run_id: runId },
        );
      }

      // Phase D — warehouse readers. Platform is derived from the
      // slug prefix so the dispatcher sees a uniform surface.
      case 'file-list':
      case 'webhook-list':
      case 'email-list': {
        if (!dispatchers.collectionList) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `${slug} unavailable — no paired server or collection dispatcher`,
            { slug },
          );
        }
        const platform = platformForSlug(slug);
        const input = call.input as {
          slug: string;
          filters?: Record<string, unknown>;
          since?: number;
          until?: number;
          limit?: number;
          metadata_only?: boolean;
        };
        if (input.metadata_only !== undefined && typeof input.metadata_only !== 'boolean') {
          throw new IngredientError(
            'BAD_INPUT',
            `${slug}: metadata_only must be a boolean when provided`,
            { slug },
          );
        }
        const { metadata_only: metadataOnly, ...listInput } = input;
        const out = await dispatchers.collectionList({ platform, ...listInput });
        const records = slug === 'email-list' && metadataOnly === true
          ? out.records.map(collectionRecordMetadataOnly)
          : out.records;
        // D-119 Phase 12 — stamp `_id` (= record_id) + `_collection` on
        // every returned record so recipes can `foreach` and reference
        // `{{item._id}}` / `{{item._collection}}` uniformly.
        return {
          records: stampMany(
            records,
            collectionForKernelPlatform(platform),
            (r) => r.record_id,
          ),
        };
      }
      case 'file-get':
      case 'webhook-get':
      case 'email-get': {
        if (!dispatchers.collectionGet) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `${slug} unavailable — no paired server or collection dispatcher`,
            { slug },
          );
        }
        const platform = platformForSlug(slug);
        const input = call.input as { slug: string; record_id: string };
        const out = await dispatchers.collectionGet({ platform, ...input });
        return {
          record: out.record
            ? stampOne(
                out.record,
                collectionForKernelPlatform(platform),
                out.record.record_id,
              )
            : null,
        };
      }
      case 'email-search': {
        if (!dispatchers.collectionSearch) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `email-search unavailable — no paired server or collection dispatcher`,
            { slug },
          );
        }
        const input = call.input as {
          slug: string;
          query: string;
          limit?: number;
        };
        const out = await dispatchers.collectionSearch({ platform: 'mail', ...input });
        return {
          matches: stampMany(out.matches, 'mail', (m) => m.record_id),
        };
      }

      // Phase 7 (D-110) — file mutation ingredients.
      case 'file-read': {
        if (!dispatchers.fileRead) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `file-read unavailable — no paired server or file dispatcher`,
            { slug },
          );
        }
        const input = call.input as { slug: string; path: string };
        return dispatchers.fileRead(input);
      }
      case 'data-file-read': {
        if (!dispatchers.dataFileRead) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `data-file-read unavailable — no paired server or file content dispatcher`,
            { slug },
          );
        }
        const input = call.input as { record_id?: unknown; metadata_only?: unknown };
        if (typeof input.record_id !== 'string' || input.record_id.length === 0) {
          throw new IngredientError('BAD_INPUT', 'data-file-read: record_id is required', { slug });
        }
        if (input.metadata_only !== undefined && typeof input.metadata_only !== 'boolean') {
          throw new IngredientError(
            'BAD_INPUT',
            'data-file-read: metadata_only must be boolean when present',
            { slug },
          );
        }
        const result = await dispatchers.dataFileRead({ record_id: input.record_id });
        if (input.metadata_only !== true) return result;
        return {
          record_id: result.record_id,
          mime_type: result.mime_type,
          filename: result.filename,
          size_bytes: result.size_bytes,
          blob_hash: result.blob_hash,
        };
      }
      case 'file-persist': {
        // D-185 Slice 4 — the explicit temp→cas keep step. Accepts ONLY a `temp`
        // file_ref (a cas ref is already durable). `run_id` confines the read to
        // the producing run's scratch root (the only authorization on a temp ref
        // — the producing op was already gated, §3.2), so it is REQUIRED.
        if (!dispatchers.filePersist) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `file-persist unavailable — no paired server or file ingest dispatcher`,
            { slug },
          );
        }
        const input = call.input as { ref?: unknown };
        if (!isTempFileRef(input.ref)) {
          throw new IngredientError(
            'BAD_INPUT',
            "file-persist: 'ref' must be a temp file_ref (a cas ref is already durable)",
            { slug },
          );
        }
        const run_id = call.stepMeta?.run_id;
        if (typeof run_id !== 'string' || run_id.length === 0) {
          throw new IngredientError(
            'BAD_INPUT',
            'file-persist: requires a run scope (no run_id on the step)',
            { slug },
          );
        }
        return dispatchers.filePersist({
          ref: input.ref,
          run_id,
          ...(call.stepMeta?.step_id ? { step_id: call.stepMeta.step_id } : {}),
        });
      }
      case 'file-render-markdown-template': {
        if (!dispatchers.markdownTemplateRender) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `file-render-markdown-template unavailable — no paired server renderer`,
            { slug },
          );
        }
        const input = call.input as {
          template_file_ref?: unknown;
          values?: unknown;
          strict?: unknown;
        };
        const unknownInputKey = Object.keys(call.input).find(
          (key) => !['template_file_ref', 'values', 'strict'].includes(key),
        );
        if (unknownInputKey !== undefined) {
          const unknownInputKeyPreview = JSON.stringify(unknownInputKey.slice(0, 128));
          throw new IngredientError(
            'BAD_INPUT',
            `file-render-markdown-template: unknown input ${unknownInputKeyPreview}`,
            { slug },
          );
        }
        if (
          typeof input.template_file_ref !== 'string'
          || input.template_file_ref.length === 0
        ) {
          throw new IngredientError(
            'BAD_INPUT',
            'file-render-markdown-template: template_file_ref is required',
            { slug },
          );
        }
        if (
          typeof input.values !== 'object'
          || input.values === null
          || Array.isArray(input.values)
        ) {
          throw new IngredientError(
            'BAD_INPUT',
            'file-render-markdown-template: values must be an object',
            { slug },
          );
        }
        if (input.strict !== true) {
          throw new IngredientError(
            'BAD_INPUT',
            'file-render-markdown-template: strict must be true',
            { slug },
          );
        }
        const run_id = call.stepMeta?.run_id;
        if (typeof run_id !== 'string' || run_id.length === 0) {
          throw new IngredientError(
            'BAD_INPUT',
            'file-render-markdown-template: requires a run scope (no run_id on the step)',
            { slug },
          );
        }
        return dispatchers.markdownTemplateRender({
          template_file_ref: input.template_file_ref,
          values: input.values as Record<string, unknown>,
          strict: true,
          run_id,
        });
      }
      case 'file-set-scan-status': {
        // D-173 P5 (scan-gate part B) — the post-scan write-back. Patches a
        // data.file.received record's scan_status to the scanner verdict. The
        // reactive ClamAV pack recipe calls it after the local clamdscan;
        // MCP-reserved (author 'recued', not in MCP_EXPOSED_KERNEL_INGREDIENTS),
        // so an agent can never forge a `clean` verdict on a malicious upload.
        if (!dispatchers.fileSetScanStatus) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `file-set-scan-status unavailable — no paired server or file scan-status dispatcher`,
            { slug },
          );
        }
        const input = call.input as { record_id?: unknown; status?: unknown };
        if (typeof input.record_id !== 'string' || input.record_id.length === 0) {
          throw new IngredientError('BAD_INPUT', 'file-set-scan-status: record_id is required', { slug });
        }
        if (
          input.status !== 'pending'
          && input.status !== 'clean'
          && input.status !== 'flagged'
          && input.status !== 'unscanned'
        ) {
          throw new IngredientError(
            'BAD_INPUT',
            "file-set-scan-status: status must be one of 'pending' | 'clean' | 'flagged' | 'unscanned'",
            { slug },
          );
        }
        return dispatchers.fileSetScanStatus({ record_id: input.record_id, status: input.status });
      }
      case RECEPTION_MATERIALIZE_SLUG: {
        // D-173 P1-dispatch — the LOCAL materialize of a reviewed reception
        // submission. The ingredient executor (`dispatch.ts`) re-routes a
        // reception catalog op's surface dispatch here on approve-resume; the
        // boot wiring binds the dispatcher to `runReceptionProjection`. This
        // path is NEVER reached for a fresh (un-approved) op — the catalog
        // gateway holds it at the gate first.
        if (!dispatchers.receptionMaterialize) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `${RECEPTION_MATERIALIZE_SLUG} unavailable — no reception projection dispatcher wired`,
            { slug },
          );
        }
        const input = call.input as Partial<ReceptionMaterializeInput>;
        if (typeof input.top_tier_kind !== 'string' || input.top_tier_kind.length === 0) {
          throw new IngredientError(
            'BAD_INPUT',
            `${RECEPTION_MATERIALIZE_SLUG}: top_tier_kind is required`,
            { slug },
          );
        }
        if (typeof input.id !== 'string' || input.id.length === 0) {
          throw new IngredientError(
            'BAD_INPUT',
            `${RECEPTION_MATERIALIZE_SLUG}: id is required`,
            { slug },
          );
        }
        if (typeof input.title !== 'string') {
          throw new IngredientError(
            'BAD_INPUT',
            `${RECEPTION_MATERIALIZE_SLUG}: title is required`,
            { slug },
          );
        }
        return dispatchers.receptionMaterialize({
          top_tier_kind: input.top_tier_kind,
          id: input.id,
          title: input.title,
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
          ...(input.source_id !== undefined ? { source_id: input.source_id } : {}),
          ...(input.contact_email !== undefined ? { contact_email: input.contact_email } : {}),
          ...(input.contact_name !== undefined ? { contact_name: input.contact_name } : {}),
          // The dispatcher reconstructs a clean projection object, so every
          // booking, notification and intake-calendar control must be relayed
          // explicitly here or the real catalog dispatch would drop it.
          ...(input.promised_for_at !== undefined
            ? { promised_for_at: input.promised_for_at }
            : {}),
          ...(input.reject_if_slot_past !== undefined
            ? { reject_if_slot_past: input.reject_if_slot_past }
            : {}),
          ...(input.start_at !== undefined ? { start_at: input.start_at } : {}),
          ...(input.notify_visitor !== undefined
            ? { notify_visitor: input.notify_visitor }
            : {}),
          ...(input.duration_minutes !== undefined
            ? { duration_minutes: input.duration_minutes }
            : {}),
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
          ...(input.booking_request_id !== undefined
            ? { booking_request_id: input.booking_request_id }
            : {}),
          ...(input.booking_binding !== undefined
            ? { booking_binding: input.booking_binding }
            : {}),
          ...(input.is_all_day !== undefined ? { is_all_day: input.is_all_day } : {}),
          ...(input.file_id !== undefined ? { file_id: input.file_id } : {}),
        });
      }
      case 'file-write': {
        if (!dispatchers.fileWrite) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `file-write unavailable — no paired server or file dispatcher`,
            { slug },
          );
        }
        const input = call.input as {
          slug: string;
          path: string;
          body_b64: string;
          mime?: string;
        };
        return dispatchers.fileWrite(input);
      }
      case 'file-delete': {
        if (!dispatchers.fileDelete) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `file-delete unavailable — no paired server or file dispatcher`,
            { slug },
          );
        }
        const input = call.input as { slug: string; path: string };
        return dispatchers.fileDelete(input);
      }
      case 'file-move': {
        if (!dispatchers.fileMove) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `file-move unavailable — no paired server or file dispatcher`,
            { slug },
          );
        }
        const input = call.input as {
          from_slug: string;
          from_path: string;
          to_slug: string;
          to_path: string;
        };
        return dispatchers.fileMove(input);
      }
      case 'file-stat': {
        if (!dispatchers.fileStat) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `file-stat unavailable — no paired server or file dispatcher`,
            { slug },
          );
        }
        const input = call.input as { slug: string; path: string };
        return dispatchers.fileStat(input);
      }

      // D-117 Phase 6 — calendar dispatcher slots. Reads hit the
      // server warehouse; writes go through the provider first and
      // only land in the warehouse on verified success.
      case 'calendar-list': {
        if (!dispatchers.calendarList) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `calendar-list unavailable — no paired server or calendar dispatcher`,
            { slug },
          );
        }
        const input = call.input as Parameters<NonNullable<KernelDispatchers['calendarList']>>[0];
        const out = await dispatchers.calendarList(input);
        // D-119 Phase 12 — `ical_uid` is the cross-provider stable id
        // for events (gcal source_id, microsoft graph eventId, caldav
        // UID all collapse to the iCalendar UID). Use it as `_id`.
        return {
          records: stampMany(out.records, 'calendar', (r) => r.ical_uid),
        };
      }
      case 'calendar-get': {
        if (!dispatchers.calendarGet) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `calendar-get unavailable — no paired server or calendar dispatcher`,
            { slug },
          );
        }
        const input = call.input as Parameters<NonNullable<KernelDispatchers['calendarGet']>>[0];
        const out = await dispatchers.calendarGet(input);
        // The full canonical event carries both `source_id` (storage
        // key) and `ical_uid` (cross-provider id). Prefer `ical_uid`
        // for `_id` so refs stay portable across re-syncs from a
        // different provider; fall back to `source_id` if missing.
        const record = out.record;
        if (!record) return { record: null };
        const id =
          (typeof record.ical_uid === 'string' && record.ical_uid)
          || (typeof record.source_id === 'string' && record.source_id)
          || input.source_id;
        return { record: stampOne(record, 'calendar', id) };
      }
      case 'calendar-search': {
        if (!dispatchers.calendarSearch) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `calendar-search unavailable — no paired server or calendar dispatcher`,
            { slug },
          );
        }
        const input = call.input as Parameters<NonNullable<KernelDispatchers['calendarSearch']>>[0];
        const out = await dispatchers.calendarSearch(input);
        return {
          matches: stampMany(out.matches, 'calendar', (m) => m.ical_uid),
        };
      }
      case 'calendar-stat': {
        if (!dispatchers.calendarStat) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `calendar-stat unavailable — no paired server or calendar dispatcher`,
            { slug },
          );
        }
        const input = call.input as Parameters<NonNullable<KernelDispatchers['calendarStat']>>[0];
        return dispatchers.calendarStat(input);
      }
      case 'calendar-create': {
        if (!dispatchers.calendarCreate) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `calendar-create unavailable — no paired server or calendar dispatcher`,
            { slug },
          );
        }
        const input = call.input as Parameters<NonNullable<KernelDispatchers['calendarCreate']>>[0];
        return dispatchers.calendarCreate(input);
      }
      case 'calendar-update': {
        if (!dispatchers.calendarUpdate) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `calendar-update unavailable — no paired server or calendar dispatcher`,
            { slug },
          );
        }
        const input = call.input as Parameters<NonNullable<KernelDispatchers['calendarUpdate']>>[0];
        return dispatchers.calendarUpdate(input);
      }
      case 'calendar-delete': {
        if (!dispatchers.calendarDelete) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `calendar-delete unavailable — no paired server or calendar dispatcher`,
            { slug },
          );
        }
        const input = call.input as Parameters<NonNullable<KernelDispatchers['calendarDelete']>>[0];
        return dispatchers.calendarDelete(input);
      }
      case 'calendar-rsvp': {
        if (!dispatchers.calendarRsvp) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `calendar-rsvp unavailable — no paired server or calendar dispatcher`,
            { slug },
          );
        }
        const input = call.input as Parameters<NonNullable<KernelDispatchers['calendarRsvp']>>[0];
        return dispatchers.calendarRsvp(input);
      }

      // D-115 Phase 6 — watcher ingredients. One kernel slot handles
      // every watcher slug; the handler inspects `input.slug` + `input.args`
      // to pick the concrete gate logic (warehouse / audit / HTTP /
      // time / webhook). Absent handler surfaces as
      // SERVER_NOT_REACHABLE so reactive recipes fail cleanly in
      // runtimes that haven't wired watcher dispatch yet.
      case 'time-watcher':
      case 'recipe-watcher':
      case 'http-watcher':
      case 'mail-watcher':
      case 'file-watcher':
      case 'calendar-watcher':
      case 'webhook-watcher':
      case 'time-relative-watcher': {
        if (!dispatchers.watcher) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `${slug} unavailable — no watcher dispatcher wired`,
            { slug },
          );
        }
        const args = { ...(call.input as Record<string, unknown>) };
        // These watchers key PER-RECIPE state by recipe id. That identity is
        // engine-owned (and deliberately absent from the public manifests), so
        // inject the trusted step metadata here. Keep an explicit input value
        // only for direct-RPC callers that have no engine context; when
        // metadata is present it must win over authored input.
        //
        //   time-relative-watcher — its durable firing ledger.
        //   webhook-watcher       — ⛔⛔ its per-`(recipe_id, slug)` queue, which
        //     `drain()` DELETES as it returns. Added 2026-07-31 after a Codex
        //     review: `recipe_id` was caller-supplied and unchecked, so any
        //     recipe could name ANOTHER recipe's queue and both READ its
        //     contents (headers, body, source IP — including authorization and
        //     signature headers) and DESTROY them, leaving the owning recipe to
        //     miss those deliveries permanently. One trigger silently eating
        //     another's webhooks is close to undiagnosable from the outside.
        //
        // ⚠ The DESTRUCTIVE drain itself is correct and stays: it is the
        // at-most-once consume that stops a webhook re-firing on every tick.
        // What was wrong is WHOSE queue a caller could name. With identity
        // bound to the executing recipe, a recipe can only drain its own —
        // `slug` stays authored because the hook path is `/hook/{recipe_id}/
        // {slug}`, so it is already fenced inside the recipe's own namespace.
        // ⚠ DERIVED from `RECIPE_KEYED_WATCHER_SLUGS`, never re-listed here — the
        // rpc handler refuses the same set, and a hand-copied list is how the
        // two halves of one rule drift apart.
        if (
          RECIPE_KEYED_WATCHER_SLUGS.has(slug as KernelWatcherSlug)
          && typeof call.stepMeta?.recipe_id === 'string'
          && call.stepMeta.recipe_id.length > 0
        ) {
          args.recipe_id = call.stepMeta.recipe_id;
        }
        return dispatchers.watcher({
          slug: slug as KernelWatcherSlug,
          args,
        });
      }

      // D-119 Phase 13 — annotation + link dispatcher slots. Each
      // slug maps to its own dispatcher slot; absent slot surfaces as
      // SERVER_NOT_REACHABLE because annotations + links live on the
      // server warehouse. Recipe-side input shapes accept canonical
      // refs (`{ ref: <canonical> }`) or explicit collection/id pairs;
      // we normalize before calling the dispatcher.
      case 'data-annotate': {
        if (!dispatchers.annotate) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `data-annotate unavailable — no paired server or annotation dispatcher`,
            { slug },
          );
        }
        const input = call.input as {
          ref?: unknown;
          target_collection?: string;
          target_id?: string;
          key: string;
          value: unknown;
          authored_by_recipe_id: string;
          source_record_hash: string;
          recipe_hash: string;
          model_used?: string;
        };
        const target = resolveTargetRef(input);
        const dispatchInput: Parameters<NonNullable<KernelDispatchers['annotate']>>[0] = {
          target_collection: target.collection,
          target_id: target.id,
          key: input.key,
          value: input.value,
          authored_by_recipe_id: input.authored_by_recipe_id,
          source_record_hash: input.source_record_hash,
          recipe_hash: input.recipe_hash,
        };
        if (input.model_used !== undefined) dispatchInput.model_used = input.model_used;
        return dispatchers.annotate(dispatchInput);
      }
      case 'annotation-list': {
        if (!dispatchers.annotationList) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `annotation-list unavailable — no paired server or annotation dispatcher`,
            { slug },
          );
        }
        return dispatchers.annotationList(call.input as AnnotationFilter);
      }
      case 'annotation-search': {
        if (!dispatchers.annotationSearch) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `annotation-search unavailable — no paired server or annotation dispatcher`,
            { slug },
          );
        }
        return dispatchers.annotationSearch(call.input as unknown as AnnotationSearchQuery);
      }
      case 'annotation-delete': {
        if (!dispatchers.annotationDelete) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `annotation-delete unavailable — no paired server or annotation dispatcher`,
            { slug },
          );
        }
        return dispatchers.annotationDelete(call.input as AnnotationFilter);
      }
      case 'data-link': {
        if (!dispatchers.linkWrite) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `data-link unavailable — no paired server or link dispatcher`,
            { slug },
          );
        }
        const input = call.input as {
          from?: unknown;
          to?: unknown;
          from_collection?: string;
          from_id?: string;
          to_collection?: string;
          to_id?: string;
          role: string;
          authored_by_recipe_id: string;
        };
        const fromRef = resolveSidedRef(input, 'from');
        const toRef = resolveSidedRef(input, 'to');
        return dispatchers.linkWrite({
          from_collection: fromRef.collection,
          from_id: fromRef.id,
          to_collection: toRef.collection,
          to_id: toRef.id,
          role: input.role,
          authored_by_recipe_id: input.authored_by_recipe_id,
        });
      }
      case 'link-list': {
        if (!dispatchers.linkList) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `link-list unavailable — no paired server or link dispatcher`,
            { slug },
          );
        }
        return dispatchers.linkList(call.input as LinkFilter);
      }
      case 'link-delete': {
        if (!dispatchers.linkDelete) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `link-delete unavailable — no paired server or link dispatcher`,
            { slug },
          );
        }
        return dispatchers.linkDelete(call.input as LinkFilter);
      }

      // D-122 Phase 2 — graph-builder ingredients. The five new slugs
      // share an input-normalization concern: combined-string refs
      // (`<collection>:<id>`) and confidence/evidence pass-through.
      // The adapter shoulders the parsing so server-side dispatchers
      // see clean canonical-field shapes; recipes get a friendlier
      // surface (`source: "data.mail:msg-abc"` reads better than
      // `source_collection: "data.mail", source_id: "msg-abc"` when
      // every recipe interpolates the same `{{item._id}}` shape).

      case 'contact-upsert': {
        if (!dispatchers.contactUpsert) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `contact-upsert unavailable — no paired server or contact dispatcher`,
            { slug },
          );
        }
        const input = call.input as {
          email: unknown;
          display_name?: unknown;
          last_interaction?: unknown;
          first_seen?: unknown;
        };
        if (typeof input.email !== 'string' || input.email.length === 0) {
          throw new IngredientError(
            'BAD_INPUT',
            `contact-upsert: email is required`,
            { slug },
          );
        }
        const dispatchInput: Parameters<NonNullable<KernelDispatchers['contactUpsert']>>[0] = {
          email: input.email,
        };
        if (typeof input.display_name === 'string') dispatchInput.display_name = input.display_name;
        if (typeof input.last_interaction === 'number') dispatchInput.last_interaction = input.last_interaction;
        if (typeof input.first_seen === 'number') dispatchInput.first_seen = input.first_seen;
        // D-161 P2 — forward the engine-supplied run actor + contract_id so
        // the dispatcher stamps the contact row's origin from the run's
        // ExecutionSource (an MCP recipe → contracted_user), not the direct
        // rpc's user_self (I-6 / A.5). Mirrors enrichment-upsert.
        if (call.stepMeta?.actor) {
          dispatchInput.origin_actor = call.stepMeta.actor;
        }
        if (typeof call.stepMeta?.contract_id === 'string'
            && call.stepMeta.contract_id.length > 0) {
          dispatchInput.origin_contract_id = call.stepMeta.contract_id;
        }
        const out = await dispatchers.contactUpsert(dispatchInput);
        // ContactRecord already carries `_id` (= canonical email) +
        // `_collection` from the server-side store, but stamp here too
        // so a dispatcher returning the raw-row shape still surfaces
        // canonically. `stampOne` is idempotent so this is a no-op for
        // already-stamped records.
        return {
          contact: stampOne(
            out.contact as unknown as Record<string, unknown>,
            'contact',
            (out.contact as { email?: string }).email
              ?? (out.contact as { _id?: string })._id
              ?? input.email,
          ),
        };
      }

      case 'contact-resolve': {
        if (!dispatchers.contactResolve) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `contact-resolve unavailable — no paired server or contact dispatcher`,
            { slug },
          );
        }
        const input = call.input as {
          email?: unknown;
          phone?: unknown;
          alias?: unknown;
          platform_id?: unknown;
        };
        // The handler owns the exactly-one-identifier rule (zero or >1
        // provided → bad_request) and the per-kind inner validation
        // (platform support, non-empty id). The adapter only forwards a
        // string identifier when it is non-empty after trimming — the
        // manifest defaults each optional field to "" (so the validator
        // treats them as optional, not required), and a whitespace-only
        // value is not a real identifier. Dropping empties here keeps the
        // dispatch clean; it does NOT substitute for the recipe's own
        // skip-on-empty guard (a step that forwards zero identifiers
        // still hits the handler's bad_request — callers must guard).
        const dispatchInput: Parameters<NonNullable<KernelDispatchers['contactResolve']>>[0] = {};
        if (typeof input.email === 'string' && input.email.trim().length > 0) {
          dispatchInput.email = input.email;
        }
        if (typeof input.phone === 'string' && input.phone.trim().length > 0) {
          dispatchInput.phone = input.phone;
        }
        if (typeof input.alias === 'string' && input.alias.trim().length > 0) {
          dispatchInput.alias = input.alias;
        }
        if (input.platform_id != null && typeof input.platform_id === 'object') {
          dispatchInput.platform_id = input.platform_id as {
            platform: ContactAliasPlatform;
            id: string;
          };
        }
        // Verbatim pass-through — resolve returns a result object (ids +
        // confidence), not a warehouse record, so no `stampOne`. The
        // nested `contact` (when present) is already canonically stamped
        // by the server-side ContactStore.
        return dispatchers.contactResolve(dispatchInput);
      }

      case 'contact-business-context': {
        if (!dispatchers.contactBusinessContext) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `contact-business-context unavailable — no paired server or contact dispatcher`,
            { slug },
          );
        }
        const input = call.input as {
          email?: unknown;
          as_of?: unknown;
          known_before_at?: unknown;
        };
        const email = typeof input.email === 'string'
          ? canonicalizeEmail(input.email)
          : '';
        if (email.length === 0) {
          throw new IngredientError(
            'BAD_INPUT',
            'contact-business-context: email must be a valid email address',
            { slug },
          );
        }
        if (typeof input.as_of !== 'number'
            || !Number.isFinite(input.as_of)
            || input.as_of < 0) {
          throw new IngredientError(
            'BAD_INPUT',
            'contact-business-context: as_of must be a non-negative finite number',
            { slug },
          );
        }
        if (typeof input.known_before_at !== 'number'
            || !Number.isFinite(input.known_before_at)
            || input.known_before_at < 0
            || input.known_before_at > input.as_of) {
          throw new IngredientError(
            'BAD_INPUT',
            'contact-business-context: known_before_at must be a non-negative finite number no later than as_of',
            { slug },
          );
        }
        return dispatchers.contactBusinessContext({
          email,
          as_of: input.as_of,
          known_before_at: input.known_before_at,
        });
      }

      case 'mail-thread-reader': {
        if (!dispatchers.mailThreadRead) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `mail-thread-reader unavailable — no paired server or mail thread dispatcher`,
            { slug },
          );
        }
        const input = call.input as {
          slug?: unknown;
          thread_id?: unknown;
          max_messages?: unknown;
        };
        if (typeof input.slug !== 'string' || input.slug.length === 0) {
          throw new IngredientError(
            'BAD_INPUT',
            `mail-thread-reader: slug is required`,
            { slug },
          );
        }
        if (typeof input.thread_id !== 'string' || input.thread_id.length === 0) {
          throw new IngredientError(
            'BAD_INPUT',
            `mail-thread-reader: thread_id is required`,
            { slug },
          );
        }
        const dispatchInput: Parameters<NonNullable<KernelDispatchers['mailThreadRead']>>[0] = {
          slug: input.slug,
          thread_id: input.thread_id,
        };
        if (typeof input.max_messages === 'number' && input.max_messages > 0) {
          dispatchInput.max_messages = input.max_messages;
        }
        const out = await dispatchers.mailThreadRead(dispatchInput);
        // Stamp messages canonically — same path as `email-list` so
        // recipes can `foreach` over `step.thread.messages` and reach
        // `{{item._id}}` consistently.
        return {
          messages: stampMany(out.messages, 'mail', (m) => m.record_id),
          message_count: out.message_count,
          first_at: out.first_at,
          last_at: out.last_at,
        };
      }

      case 'link-create': {
        if (!dispatchers.linkCreate) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `link-create unavailable — no paired server or link-create dispatcher`,
            { slug },
          );
        }
        const input = call.input as {
          source?: unknown;
          target?: unknown;
          kind?: unknown;
          confidence?: unknown;
          evidence?: unknown;
          authored_by_recipe_id?: unknown;
          event_at?: unknown;
        };
        const from = parseEntityRef(input.source, 'source', 'link-create');
        const to = parseEntityRef(input.target, 'target', 'link-create');
        if (typeof input.kind !== 'string' || input.kind.length === 0) {
          throw new IngredientError(
            'BAD_INPUT',
            `link-create: kind is required`,
            { slug },
          );
        }
        if (typeof input.authored_by_recipe_id !== 'string') {
          throw new IngredientError(
            'BAD_INPUT',
            `link-create: authored_by_recipe_id is required`,
            { slug },
          );
        }
        const dispatchInput: Parameters<NonNullable<KernelDispatchers['linkCreate']>>[0] = {
          from_collection: from.collection,
          from_id: from.id,
          to_collection: to.collection,
          to_id: to.id,
          role: input.kind,
          authored_by_recipe_id: input.authored_by_recipe_id,
        };
        if (typeof input.confidence === 'number' && Number.isFinite(input.confidence)) {
          dispatchInput.confidence = input.confidence;
        }
        if (typeof input.evidence === 'string' && input.evidence.length > 0) {
          dispatchInput.evidence = input.evidence;
        }
        if (typeof input.event_at === 'number') {
          dispatchInput.event_at = input.event_at;
        }
        // D-161 P2 — forward the engine-supplied run actor + contract_id
        // so the dispatcher stamps `origin_actor` on the written link row,
        // propagated from the run's `ExecutionSource` (I-6). Mirrors the
        // `enrichment-upsert` forward. Direct callers (no engine context)
        // leave `call.stepMeta` undefined and the store defaults to
        // `'system'`.
        if (call.stepMeta?.actor) {
          dispatchInput.origin_actor = call.stepMeta.actor;
        }
        if (typeof call.stepMeta?.contract_id === 'string'
            && call.stepMeta.contract_id.length > 0) {
          dispatchInput.origin_contract_id = call.stepMeta.contract_id;
        }
        return dispatchers.linkCreate(dispatchInput);
      }

      case 'annotation-create': {
        if (!dispatchers.annotationCreate) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `annotation-create unavailable — no paired server or annotation-create dispatcher`,
            { slug },
          );
        }
        const input = call.input as {
          target?: unknown;
          key?: unknown;
          value?: unknown;
          confidence?: unknown;
          authored_by_recipe_id?: unknown;
          source_record_hash?: unknown;
          recipe_hash?: unknown;
          model_used?: unknown;
          event_at?: unknown;
        };
        const target = parseEntityRef(input.target, 'target', 'annotation-create');
        if (typeof input.key !== 'string' || input.key.length === 0) {
          throw new IngredientError(
            'BAD_INPUT',
            `annotation-create: key is required`,
            { slug },
          );
        }
        if (typeof input.authored_by_recipe_id !== 'string') {
          throw new IngredientError(
            'BAD_INPUT',
            `annotation-create: authored_by_recipe_id is required`,
            { slug },
          );
        }
        if (typeof input.source_record_hash !== 'string'
          || typeof input.recipe_hash !== 'string') {
          throw new IngredientError(
            'BAD_INPUT',
            `annotation-create: source_record_hash + recipe_hash are required`,
            { slug },
          );
        }
        // Fold confidence into value when supplied so the per-record
        // ref read (`{{data.<col>.<id>.annotations.<key>}}`) returns the
        // grade alongside the data. Recipes that don't pass confidence
        // get the raw `value` through unchanged.
        const value =
          typeof input.confidence === 'number' && Number.isFinite(input.confidence)
            ? { value: input.value, confidence: input.confidence }
            : input.value;
        const dispatchInput: Parameters<NonNullable<KernelDispatchers['annotationCreate']>>[0] = {
          target_collection: target.collection,
          target_id: target.id,
          key: input.key,
          value,
          authored_by_recipe_id: input.authored_by_recipe_id,
          source_record_hash: input.source_record_hash,
          recipe_hash: input.recipe_hash,
        };
        if (typeof input.model_used === 'string') {
          dispatchInput.model_used = input.model_used;
        }
        if (typeof input.event_at === 'number') {
          dispatchInput.event_at = input.event_at;
        }
        // D-161 P2 — forward the engine-supplied run actor + contract_id
        // (mirrors `link-create` / `enrichment-upsert`). An MCP-run
        // recipe's annotation thus carries `contracted_user`, not the
        // store's `'system'` default (I-6 / A.5).
        if (call.stepMeta?.actor) {
          dispatchInput.origin_actor = call.stepMeta.actor;
        }
        if (typeof call.stepMeta?.contract_id === 'string'
            && call.stepMeta.contract_id.length > 0) {
          dispatchInput.origin_contract_id = call.stepMeta.contract_id;
        }
        return dispatchers.annotationCreate(dispatchInput);
      }

      case 'enrichment-upsert': {
        if (!dispatchers.enrichmentUpsert) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `enrichment-upsert unavailable — no paired server or enrichment dispatcher`,
            { slug },
          );
        }
        const input = call.input as {
          topic?: unknown;
          scope?: unknown;
          id?: unknown;
          value?: unknown;
          authored_by_recipe_id?: unknown;
          source_record_hash?: unknown;
          recipe_hash?: unknown;
          /** D-136 P2 — replaces legacy `model_used`. */
          ingredient_slug?: unknown;
          /** D-136 P2 — resolved provider model id (P3 retrofit). */
          model_id?: unknown;
          event_at?: unknown;
        };
        if (typeof input.topic !== 'string' || input.topic.length === 0) {
          throw new IngredientError('BAD_INPUT', 'enrichment-upsert: topic is required', { slug });
        }
        if (typeof input.id !== 'string' || input.id.length === 0) {
          throw new IngredientError('BAD_INPUT', 'enrichment-upsert: id is required', { slug });
        }
        if (typeof input.authored_by_recipe_id !== 'string'
          || input.authored_by_recipe_id.length === 0) {
          throw new IngredientError(
            'BAD_INPUT',
            'enrichment-upsert: authored_by_recipe_id is required',
            { slug },
          );
        }
        const dispatchInput: Parameters<NonNullable<KernelDispatchers['enrichmentUpsert']>>[0] = {
          topic: input.topic,
          id: input.id,
          value: input.value,
          authored_by_recipe_id: input.authored_by_recipe_id,
        };
        if (typeof input.scope === 'string' && isEnrichmentScope(input.scope)) {
          dispatchInput.scope = input.scope;
        }
        if (typeof input.source_record_hash === 'string') {
          dispatchInput.source_record_hash = input.source_record_hash;
        }
        if (typeof input.recipe_hash === 'string') {
          dispatchInput.recipe_hash = input.recipe_hash;
        }
        if (typeof input.ingredient_slug === 'string') {
          dispatchInput.ingredient_slug = input.ingredient_slug;
        }
        if (typeof input.model_id === 'string') {
          dispatchInput.model_id = input.model_id;
        }
        if (typeof input.event_at === 'number') {
          dispatchInput.event_at = input.event_at;
        }
        // D-161 P1 — forward the engine-supplied run actor + contract_id
        // so the dispatcher stamps the `origin_actor` provenance facet on
        // the written `data_enrichment` row, propagated from the run's
        // `ExecutionSource` (I-6). Mirrors the `enrichment-list`
        // trigger_source forward. Recipe-side direct callers (no engine
        // context) leave `call.stepMeta` undefined and the store defaults
        // origin to `'system'`.
        if (call.stepMeta?.actor) {
          dispatchInput.origin_actor = call.stepMeta.actor;
        }
        if (typeof call.stepMeta?.contract_id === 'string'
            && call.stepMeta.contract_id.length > 0) {
          dispatchInput.origin_contract_id = call.stepMeta.contract_id;
        }
        return dispatchers.enrichmentUpsert(dispatchInput);
      }

      case 'enrichment-list': {
        if (!dispatchers.enrichmentList) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `enrichment-list unavailable — no paired server or enrichment dispatcher`,
            { slug },
          );
        }
        const input = call.input as {
          topic?: unknown;
          scope?: unknown;
          target_id?: unknown;
          authored_by_recipe_id?: unknown;
          fresh_only?: unknown;
          limit?: unknown;
          offset?: unknown;
        };
        if (typeof input.topic !== 'string' || input.topic.length === 0) {
          throw new IngredientError('BAD_INPUT', 'enrichment-list: topic is required', { slug });
        }
        const dispatchInput: Parameters<NonNullable<KernelDispatchers['enrichmentList']>>[0] = {
          topic: input.topic,
        };
        if (typeof input.scope === 'string' && isEnrichmentScope(input.scope)) {
          dispatchInput.scope = input.scope;
        }
        if (typeof input.target_id === 'string') dispatchInput.target_id = input.target_id;
        if (typeof input.authored_by_recipe_id === 'string') {
          dispatchInput.authored_by_recipe_id = input.authored_by_recipe_id;
        }
        if (typeof input.fresh_only === 'boolean') dispatchInput.fresh_only = input.fresh_only;
        if (typeof input.limit === 'number') dispatchInput.limit = input.limit;
        if (typeof input.offset === 'number') dispatchInput.offset = input.offset;
        // D-136 P7.E — thread the engine-supplied trigger_source so the
        // server dispatcher can apply MCP-private gates without widening
        // every caller's contract. Recipe-side direct adapter callers
        // (manual tests, MCP agent paths that build a `ResolvedCall`
        // without engine context) leave `call.stepMeta` undefined, and
        // the dispatcher falls back to its default policy.
        if (typeof call.stepMeta?.trigger_source === 'string'
            && call.stepMeta.trigger_source.length > 0) {
          dispatchInput.trigger_source = call.stepMeta.trigger_source;
        }
        // D-187 — forward the run's contract_id so the dispatcher resolves the
        // topic's per-(bound contract, topic) read-visibility (mirrors the
        // enrichment-upsert origin_contract_id threading).
        if (typeof call.stepMeta?.contract_id === 'string'
            && call.stepMeta.contract_id.length > 0) {
          dispatchInput.origin_contract_id = call.stepMeta.contract_id;
        }
        return dispatchers.enrichmentList(dispatchInput);
      }

      case 'mail-get': {
        if (!dispatchers.mailGet) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `mail-get unavailable — no paired server or mail-get dispatcher`,
            { slug },
          );
        }
        const input = call.input as { slug?: unknown; record_id?: unknown };
        if (typeof input.slug !== 'string' || input.slug.length === 0) {
          throw new IngredientError('BAD_INPUT', 'mail-get: slug is required', { slug });
        }
        if (typeof input.record_id !== 'string' || input.record_id.length === 0) {
          throw new IngredientError('BAD_INPUT', 'mail-get: record_id is required', { slug });
        }
        return dispatchers.mailGet({ slug: input.slug, record_id: input.record_id });
      }

      case 'mail-body-read': {
        if (!dispatchers.mailBodyRead) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `mail-body-read unavailable — no paired server or mail-body-read dispatcher`,
            { slug },
          );
        }
        const input = call.input as {
          slug?: unknown;
          record_id?: unknown;
          max_chars?: unknown;
        };
        if (typeof input.slug !== 'string' || input.slug.length === 0) {
          throw new IngredientError('BAD_INPUT', 'mail-body-read: slug is required', { slug });
        }
        if (typeof input.record_id !== 'string' || input.record_id.length === 0) {
          throw new IngredientError('BAD_INPUT', 'mail-body-read: record_id is required', { slug });
        }
        // `max_chars` is optional (manifest default null → caller may
        // omit). When present it must be a positive integer; reject
        // anything else with a recipe-facing error rather than silently
        // ignoring a malformed cap.
        if (input.max_chars != null
            && (typeof input.max_chars !== 'number'
                || !Number.isInteger(input.max_chars)
                || input.max_chars <= 0)) {
          throw new IngredientError(
            'BAD_INPUT',
            'mail-body-read: max_chars must be a positive integer',
            { slug },
          );
        }
        return dispatchers.mailBodyRead({
          slug: input.slug,
          record_id: input.record_id,
          ...(input.max_chars != null ? { max_chars: input.max_chars as number } : {}),
        });
      }

      case 'notification-send': {
        if (!dispatchers.notificationSend) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `notification-send unavailable — no paired server or notification dispatcher`,
            { slug },
          );
        }
        const input = call.input as {
          channels?: unknown;
          text?: unknown;
          title?: unknown;
          link_url?: unknown;
        };
        if (input.channels !== undefined && (!Array.isArray(input.channels) || input.channels.length === 0)) {
          throw new IngredientError(
            'BAD_INPUT',
            'notification-send: channels[] is required',
            { slug },
          );
        }
        const rawChannels = input.channels ?? DEFAULT_NOTIFICATION_CHANNELS;
        const channels = rawChannels.filter(
          (c): c is NotificationDeliveryChannel => DELIVERY_CHANNEL_SET.has(c),
        );
        if (channels.length === 0) {
          throw new IngredientError(
            'BAD_INPUT',
            `notification-send: no valid channels in ${JSON.stringify(rawChannels)}`,
            { slug },
          );
        }
        if (typeof input.text !== 'string' || input.text.length === 0) {
          throw new IngredientError('BAD_INPUT', 'notification-send: text is required', { slug });
        }
        const dispatchInput: Parameters<NonNullable<KernelDispatchers['notificationSend']>>[0] = {
          channels,
          text: input.text,
        };
        if (typeof input.title === 'string') dispatchInput.title = input.title;
        if (typeof input.link_url === 'string') dispatchInput.link_url = input.link_url;
        return dispatchers.notificationSend(dispatchInput);
      }

      case 'notification-recipe-callback': {
        if (!dispatchers.notificationRecipeCallback) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            'notification-recipe-callback unavailable — no MCP callback dispatcher',
            { slug },
          );
        }
        const input = call.input as Record<string, unknown>;
        assertOnlyKernelInputFields(
          input,
          ['destination_contract_id', 'topic', 'query_tool', 'arguments', 'ttl_seconds'],
          slug,
        );
        const destinationContractId = input.destination_contract_id;
        const topic = input.topic;
        const queryTool = input.query_tool;
        const callbackArguments = input.arguments;
        const ttlSeconds = input.ttl_seconds;
        const sourceRecipeId = call.stepMeta?.recipe_id;
        if (typeof destinationContractId !== 'string' || destinationContractId.length === 0) {
          throw new IngredientError(
            'BAD_INPUT',
            'notification-recipe-callback: destination_contract_id is required',
            { slug },
          );
        }
        if (typeof topic !== 'string' || topic.length === 0) {
          throw new IngredientError(
            'BAD_INPUT',
            'notification-recipe-callback: topic is required',
            { slug },
          );
        }
        if (typeof queryTool !== 'string' || queryTool.length === 0) {
          throw new IngredientError(
            'BAD_INPUT',
            'notification-recipe-callback: query_tool is required',
            { slug },
          );
        }
        if (
          callbackArguments === null
          || typeof callbackArguments !== 'object'
          || Array.isArray(callbackArguments)
        ) {
          throw new IngredientError(
            'BAD_INPUT',
            'notification-recipe-callback: arguments must be an object',
            { slug },
          );
        }
        if (
          ttlSeconds !== undefined
          && (
            typeof ttlSeconds !== 'number'
            || !Number.isSafeInteger(ttlSeconds)
            || ttlSeconds <= 0
          )
        ) {
          throw new IngredientError(
            'BAD_INPUT',
            'notification-recipe-callback: ttl_seconds must be a positive integer',
            { slug },
          );
        }
        if (typeof sourceRecipeId !== 'string' || sourceRecipeId.length === 0) {
          throw new IngredientError(
            'BAD_INPUT',
            'notification-recipe-callback: a recipe execution context is required',
            { slug },
          );
        }
        return dispatchers.notificationRecipeCallback({
          destination_contract_id: destinationContractId,
          topic,
          query_tool: queryTool,
          arguments: callbackArguments as Record<string, unknown>,
          ...(ttlSeconds !== undefined ? { ttl_seconds: ttlSeconds } : {}),
          source_recipe_id: sourceRecipeId,
        });
      }

      case 'schedule-recipe': {
        if (!dispatchers.scheduleRecipe) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `schedule-recipe unavailable — no paired server or schedule dispatcher`,
            { slug },
          );
        }
        const input = call.input as {
          recipe_id?: unknown;
          mode?: unknown;
          run_at?: unknown;
          cron_expression?: unknown;
          dish_id?: unknown;
          enabled?: unknown;
        };
        if (typeof input.recipe_id !== 'string' || input.recipe_id.length === 0) {
          throw new IngredientError('BAD_INPUT', 'schedule-recipe: recipe_id is required', { slug });
        }
        if (input.mode !== 'one_shot' && input.mode !== 'recurring') {
          throw new IngredientError(
            'BAD_INPUT',
            "schedule-recipe: mode must be 'one_shot' or 'recurring'",
            { slug },
          );
        }
        if (
          input.mode === 'one_shot' &&
          (typeof input.run_at !== 'number' || !Number.isFinite(input.run_at) || input.run_at <= 0)
        ) {
          throw new IngredientError(
            'BAD_INPUT',
            'schedule-recipe: run_at must be a positive Unix-ms timestamp for one_shot schedules',
            { slug },
          );
        }
        if (
          input.mode === 'recurring' &&
          (typeof input.cron_expression !== 'string' || input.cron_expression.trim().length === 0)
        ) {
          throw new IngredientError(
            'BAD_INPUT',
            'schedule-recipe: cron_expression is required for recurring schedules',
            { slug },
          );
        }
        if (
          input.dish_id !== undefined &&
          input.dish_id !== '' &&
          (typeof input.dish_id !== 'string' || input.dish_id.length === 0)
        ) {
          throw new IngredientError('BAD_INPUT', 'schedule-recipe: dish_id must be a non-empty string', { slug });
        }
        if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
          throw new IngredientError('BAD_INPUT', 'schedule-recipe: enabled must be boolean when provided', { slug });
        }
        const dispatchInput: KernelScheduleRecipeInput = {
          recipe_id: input.recipe_id,
          mode: input.mode,
        };
        if (typeof input.run_at === 'number') dispatchInput.run_at = input.run_at;
        if (typeof input.cron_expression === 'string' && input.cron_expression.length > 0) {
          dispatchInput.cron_expression = input.cron_expression;
        }
        if (typeof input.dish_id === 'string' && input.dish_id.length > 0) dispatchInput.dish_id = input.dish_id;
        if (typeof input.enabled === 'boolean') dispatchInput.enabled = input.enabled;
        return dispatchers.scheduleRecipe(dispatchInput);
      }

      case 'seller-offer-ensure': {
        if (!dispatchers.sellerOfferEnsure) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            'seller-offer-ensure unavailable — no paired server or Seller dispatcher',
            { slug },
          );
        }
        const input = call.input as Record<string, unknown>;
        assertOnlyKernelInputFields(input, [
          'offer_id',
          'kind',
          'display_name',
          'description',
          'pricing_kind',
          'amount_minor',
          'currency',
          'fulfillment_recipe_id',
          'fulfillment_config',
        ], slug);
        const recipe_id = call.stepMeta?.recipe_id;
        if (typeof recipe_id !== 'string' || recipe_id.trim().length === 0) {
          throw new IngredientError(
            'BAD_INPUT',
            'seller-offer-ensure: recipe execution context is required',
            { slug },
          );
        }
        if (!isSellerOfferKind(input.kind)) {
          throw new IngredientError(
            'BAD_INPUT',
            `seller-offer-ensure: kind must be one of: ${SELLER_OFFER_KINDS.join(', ')}`,
            { slug },
          );
        }
        if (!isSellerOfferPricingKind(input.pricing_kind)) {
          throw new IngredientError(
            'BAD_INPUT',
            `seller-offer-ensure: pricing_kind must be one of: ${SELLER_OFFER_PRICING_KINDS.join(', ')}`,
            { slug },
          );
        }
        const description = optionalKernelString(input.description, 'description', slug);
        const fulfillment_recipe_id = optionalKernelString(
          input.fulfillment_recipe_id,
          'fulfillment_recipe_id',
          slug,
        );
        // D-196 1d — a non-secret pointer map. Shape-checked here (plain object);
        // the store re-validates + size-bounds it. A secret is never accepted.
        let fulfillment_config: Readonly<Record<string, unknown>> | undefined;
        if (input.fulfillment_config !== undefined && input.fulfillment_config !== null) {
          if (
            typeof input.fulfillment_config !== 'object'
            || Array.isArray(input.fulfillment_config)
          ) {
            throw new IngredientError(
              'BAD_INPUT',
              'seller-offer-ensure: fulfillment_config must be a JSON object',
              { slug },
            );
          }
          fulfillment_config = input.fulfillment_config as Readonly<Record<string, unknown>>;
        }
        const dispatchInput: KernelSellerOfferEnsureInput = {
          offer_id: requireKernelString(input.offer_id, 'offer_id', slug),
          kind: input.kind,
          display_name: requireKernelString(input.display_name, 'display_name', slug),
          pricing_kind: input.pricing_kind,
          created_by_recipe_id: recipe_id.trim(),
        };
        if (description !== undefined) dispatchInput.description = description;
        if (fulfillment_recipe_id !== undefined) {
          dispatchInput.fulfillment_recipe_id = fulfillment_recipe_id;
        }
        if (fulfillment_config !== undefined) {
          dispatchInput.fulfillment_config = fulfillment_config;
        }
        if (input.pricing_kind === 'fixed') {
          if (
            typeof input.amount_minor !== 'number'
            || !Number.isSafeInteger(input.amount_minor)
            || input.amount_minor <= 0
          ) {
            throw new IngredientError(
              'BAD_INPUT',
              'seller-offer-ensure: amount_minor must be a positive safe integer for fixed pricing',
              { slug },
            );
          }
          dispatchInput.amount_minor = input.amount_minor;
          dispatchInput.currency = requireKernelString(input.currency, 'currency', slug);
        } else {
          if (input.amount_minor !== undefined && input.amount_minor !== null) {
            throw new IngredientError(
              'BAD_INPUT',
              'seller-offer-ensure: amount_minor must be absent for unspecified pricing',
              { slug },
            );
          }
          if (
            input.currency !== undefined
            && input.currency !== null
            && input.currency !== ''
          ) {
            throw new IngredientError(
              'BAD_INPUT',
              'seller-offer-ensure: currency must be absent for unspecified pricing',
              { slug },
            );
          }
        }
        return dispatchers.sellerOfferEnsure(dispatchInput);
      }

      case 'seller-offer-attach-fulfillment': {
        if (!dispatchers.sellerOfferFulfillmentAttach) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            'seller-offer-attach-fulfillment unavailable — no paired server or Seller dispatcher',
            { slug },
          );
        }
        const input = call.input as Record<string, unknown>;
        assertOnlyKernelInputFields(input, ['offer_id'], slug);
        const recipe_id = call.stepMeta?.recipe_id;
        if (typeof recipe_id !== 'string' || recipe_id.trim().length === 0) {
          throw new IngredientError(
            'BAD_INPUT',
            'seller-offer-attach-fulfillment: recipe execution context is required',
            { slug },
          );
        }
        return dispatchers.sellerOfferFulfillmentAttach({
          offer_id: requireKernelString(input.offer_id, 'offer_id', slug),
          recipe_id: recipe_id.trim(),
        });
      }

      case 'seller-offer-get': {
        if (!dispatchers.sellerOfferGet) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            'seller-offer-get unavailable — no paired server or Seller dispatcher',
            { slug },
          );
        }
        const input = call.input as Record<string, unknown>;
        assertOnlyKernelInputFields(input, ['offer_id'], slug);
        return dispatchers.sellerOfferGet({
          offer_id: requireKernelString(input.offer_id, 'offer_id', slug),
        });
      }

      case 'seller-offer-list': {
        if (!dispatchers.sellerOfferList) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            'seller-offer-list unavailable — no paired server or Seller dispatcher',
            { slug },
          );
        }
        const input = call.input as Record<string, unknown>;
        assertOnlyKernelInputFields(input, ['kind', 'state'], slug);
        const dispatchInput: KernelSellerOfferListInput = {};
        if (input.kind !== undefined && input.kind !== null && input.kind !== '') {
          if (!isSellerOfferKind(input.kind)) {
            throw new IngredientError(
              'BAD_INPUT',
              `seller-offer-list: kind must be one of: ${SELLER_OFFER_KINDS.join(', ')}`,
              { slug },
            );
          }
          dispatchInput.kind = input.kind;
        }
        if (input.state !== undefined && input.state !== null && input.state !== '') {
          if (!isSellerOfferState(input.state)) {
            throw new IngredientError(
              'BAD_INPUT',
              'seller-offer-list: state must be draft, active, paused, or archived',
              { slug },
            );
          }
          dispatchInput.state = input.state;
        }
        return dispatchers.sellerOfferList(dispatchInput);
      }

      // ── D-207 §4.3 — core.seller.order ─────────────────────────────────────
      case 'seller-order-open': {
        if (!dispatchers.sellerOrderOpen) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            'seller-order-open unavailable — no paired server or Seller dispatcher',
            { slug },
          );
        }
        const input = call.input as Record<string, unknown>;
        // ⛔ The closed key set IS the fence. There is no `amount_minor`, no
        // `currency`, no `product_name` — so a recipe cannot supply a price, and
        // therefore neither can a visitor whose value it might be carrying. The
        // server reads the commerce terms from the offer row.
        assertOnlyKernelInputFields(
          input,
          ['offer_id', 'origin_kind', 'origin_ref', 'customer_id', 'entitlement_key'],
          slug,
        );
        if (!isSellerOrderOriginKind(input.origin_kind)) {
          throw new IngredientError(
            'BAD_INPUT',
            `seller-order-open: origin_kind must be one of ${SELLER_ORDER_ORIGIN_KINDS.join(', ')}`,
            { slug },
          );
        }
        return dispatchers.sellerOrderOpen({
          offer_id: requireKernelString(input.offer_id, 'offer_id', slug),
          origin_kind: input.origin_kind,
          origin_ref: requireKernelString(input.origin_ref, 'origin_ref', slug),
          customer_id: optionalKernelString(input.customer_id, 'customer_id', slug) ?? null,
          // D-196 §4.5 — names WHICH access the order sells, not what it costs.
          // Snapshotted server-side; fulfilment reads the ORDER's copy.
          entitlement_key:
            optionalKernelString(input.entitlement_key, 'entitlement_key', slug) ?? null,
        });
      }

      case 'seller-order-get': {
        if (!dispatchers.sellerOrderGet) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            'seller-order-get unavailable — no paired server or Seller dispatcher',
            { slug },
          );
        }
        const input = call.input as Record<string, unknown>;
        assertOnlyKernelInputFields(input, ['order_key', 'order_handle'], slug);
        const order_key = optionalKernelString(input.order_key, 'order_key', slug);
        const order_handle = optionalKernelString(input.order_handle, 'order_handle', slug);
        if ((order_key === undefined) === (order_handle === undefined)) {
          throw new IngredientError(
            'BAD_INPUT',
            'seller-order-get: supply exactly one of order_key or order_handle',
            { slug },
          );
        }
        return dispatchers.sellerOrderGet({ order_key, order_handle });
      }

      case 'seller-order-list': {
        if (!dispatchers.sellerOrderList) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            'seller-order-list unavailable — no paired server or Seller dispatcher',
            { slug },
          );
        }
        const input = call.input as Record<string, unknown>;
        assertOnlyKernelInputFields(
          input,
          ['offer_id', 'phase', 'origin_kind', 'origin_ref', 'limit'],
          slug,
        );
        const listInput: KernelSellerOrderListInput = {};
        const offer_id = optionalKernelString(input.offer_id, 'offer_id', slug);
        if (offer_id !== undefined) listInput.offer_id = offer_id;
        const origin_ref = optionalKernelString(input.origin_ref, 'origin_ref', slug);
        if (origin_ref !== undefined) listInput.origin_ref = origin_ref;
        if (input.phase !== undefined && input.phase !== null && input.phase !== '') {
          if (!isSellerOrderPhase(input.phase)) {
            throw new IngredientError(
              'BAD_INPUT',
              'seller-order-list: phase is not an order phase',
              { slug },
            );
          }
          listInput.phase = input.phase;
        }
        if (
          input.origin_kind !== undefined
          && input.origin_kind !== null
          && input.origin_kind !== ''
        ) {
          if (!isSellerOrderOriginKind(input.origin_kind)) {
            throw new IngredientError(
              'BAD_INPUT',
              'seller-order-list: origin_kind is not a known origin',
              { slug },
            );
          }
          listInput.origin_kind = input.origin_kind;
        }
        if (input.limit !== undefined && input.limit !== null) {
          listInput.limit = requireKernelNumber(input.limit, 'limit', slug);
        }
        return dispatchers.sellerOrderList(listInput);
      }

      case 'seller-order-quote': {
        if (!dispatchers.sellerOrderQuote) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            'seller-order-quote unavailable — no paired server or Seller dispatcher',
            { slug },
          );
        }
        const input = call.input as Record<string, unknown>;
        assertOnlyKernelInputFields(
          input,
          ['order_key', 'expected_revision', 'amount_minor', 'currency'],
          slug,
        );
        return dispatchers.sellerOrderQuote({
          order_key: requireKernelString(input.order_key, 'order_key', slug),
          expected_revision: requireKernelNumber(
            input.expected_revision,
            'expected_revision',
            slug,
          ),
          amount_minor: requireKernelNumber(input.amount_minor, 'amount_minor', slug),
          currency: requireKernelString(input.currency, 'currency', slug),
        });
      }

      case 'seller-order-attach-payment': {
        if (!dispatchers.sellerOrderAttachPayment) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            'seller-order-attach-payment unavailable — no paired server or Seller dispatcher',
            { slug },
          );
        }
        const input = call.input as Record<string, unknown>;
        assertOnlyKernelInputFields(
          input,
          [
            'order_key',
            'expected_revision',
            'provider',
            'provider_session_id',
            'checkout_url',
            'expires_at',
          ],
          slug,
        );
        return dispatchers.sellerOrderAttachPayment({
          order_key: requireKernelString(input.order_key, 'order_key', slug),
          expected_revision: requireKernelNumber(
            input.expected_revision,
            'expected_revision',
            slug,
          ),
          provider: requireKernelString(input.provider, 'provider', slug),
          provider_session_id: requireKernelString(
            input.provider_session_id,
            'provider_session_id',
            slug,
          ),
          checkout_url: optionalKernelString(input.checkout_url, 'checkout_url', slug) ?? null,
          expires_at:
            input.expires_at === undefined
            || input.expires_at === null
            || input.expires_at === 0
              ? null
              : requireKernelNumber(input.expires_at, 'expires_at', slug),
        });
      }

      case 'seller-order-confirm-payment': {
        if (!dispatchers.sellerOrderConfirmPayment) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            'seller-order-confirm-payment unavailable — no paired server or Seller dispatcher',
            { slug },
          );
        }
        const input = call.input as Record<string, unknown>;
        assertOnlyKernelInputFields(
          input,
          ['order_key', 'expected_revision', 'evidence'],
          slug,
        );
        // The evidence shape is validated at the STORAGE boundary, not here: the
        // correlation it must match is re-derived from the stored order, which
        // this layer cannot see. Forwarding it unmodified keeps ONE place able to
        // decide whether money moved.
        if (!isPlainKernelRecord(input.evidence)) {
          throw new IngredientError(
            'BAD_INPUT',
            'seller-order-confirm-payment: evidence must be an object',
            { slug },
          );
        }
        return dispatchers.sellerOrderConfirmPayment({
          order_key: requireKernelString(input.order_key, 'order_key', slug),
          expected_revision: requireKernelNumber(
            input.expected_revision,
            'expected_revision',
            slug,
          ),
          evidence: input.evidence,
        });
      }

      case 'seller-order-confirm-renewal-payment': {
        if (!dispatchers.sellerOrderConfirmRenewalPayment) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            'seller-order-confirm-renewal-payment unavailable — no paired server or Seller dispatcher',
            { slug },
          );
        }
        const input = call.input as Record<string, unknown>;
        assertOnlyKernelInputFields(
          input,
          ['order_key', 'expected_revision', 'evidence'],
          slug,
        );
        // Same posture as seller-order-confirm-payment: the evidence shape is
        // validated at the STORAGE boundary, where the invoice-keyed correlation
        // and the acquisition-order anchor it must match are re-derived from
        // stored rows this layer cannot see.
        if (!isPlainKernelRecord(input.evidence)) {
          throw new IngredientError(
            'BAD_INPUT',
            'seller-order-confirm-renewal-payment: evidence must be an object',
            { slug },
          );
        }
        return dispatchers.sellerOrderConfirmRenewalPayment({
          order_key: requireKernelString(input.order_key, 'order_key', slug),
          expected_revision: requireKernelNumber(
            input.expected_revision,
            'expected_revision',
            slug,
          ),
          evidence: input.evidence,
        });
      }

      case 'seller-order-confirm-refund': {
        if (!dispatchers.sellerOrderConfirmRefund) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            'seller-order-confirm-refund unavailable — no paired server or Seller dispatcher',
            { slug },
          );
        }
        const input = call.input as Record<string, unknown>;
        assertOnlyKernelInputFields(
          input,
          ['order_key', 'expected_revision', 'evidence'],
          slug,
        );
        if (!isPlainKernelRecord(input.evidence)) {
          throw new IngredientError(
            'BAD_INPUT',
            'seller-order-confirm-refund: evidence must be an object',
            { slug },
          );
        }
        return dispatchers.sellerOrderConfirmRefund({
          order_key: requireKernelString(input.order_key, 'order_key', slug),
          expected_revision: requireKernelNumber(
            input.expected_revision,
            'expected_revision',
            slug,
          ),
          evidence: input.evidence,
        });
      }

      case 'mail-sent-reconcile': {
        if (!dispatchers.mailSentReconcile) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            'mail-sent-reconcile unavailable — no paired server or mail dispatcher',
            { slug },
          );
        }
        const input = call.input as Record<string, unknown>;
        // ⛔ THE FENCE IS THE CLOSED KEY SET. There is no recipient, no subject, no
        // window, no sender, no provider evidence and no outcome here — a caller who
        // could name any of them could forge a match, and a forged match marks a
        // document DELIVERED that was never sent. The server derives every one of
        // them from the claim it wrote before dispatch.
        assertOnlyKernelInputFields(input, ['reconciliation_id'], slug);
        return dispatchers.mailSentReconcile({
          reconciliation_id: requireKernelString(
            input.reconciliation_id,
            'reconciliation_id',
            slug,
          ),
        });
      }

      case 'seller-order-attach-artifact': {
        if (!dispatchers.sellerOrderAttachArtifact) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            'seller-order-attach-artifact unavailable — no paired server or Seller dispatcher',
            { slug },
          );
        }
        // ⛔ NOT optional. The artifact is what the customer paid for, and a
        // `data.file` record id does not determine its bytes. Without the reader
        // there is no way to prove the hash, so there is no way to pin honestly —
        // and pinning dishonestly is worse than refusing.
        if (!dispatchers.dataFileRead) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            'seller-order-attach-artifact unavailable — no data.file reader to verify the artifact against',
            { slug },
          );
        }
        const input = call.input as Record<string, unknown>;
        assertOnlyKernelInputFields(
          input,
          ['order_key', 'expected_revision', 'artifact_ref', 'artifact_hash'],
          slug,
        );
        const verified = await verifySellerOrderArtifactPin(
          {
            artifact_ref: input.artifact_ref,
            artifact_hash: input.artifact_hash,
          },
          dispatchers.dataFileRead,
        );
        if (!verified.ok) {
          // The recipe still NAMES the bytes it means (that assertion is the
          // owner's consent anchor — deriving the hash from whatever the file
          // currently holds would pin bytes nobody approved). It just no longer
          // gets to be BELIEVED.
          throw new IngredientError(
            'BAD_INPUT',
            `seller-order-attach-artifact: ${verified.detail}`,
            { slug, reason: verified.reason },
          );
        }
        return dispatchers.sellerOrderAttachArtifact({
          order_key: requireKernelString(input.order_key, 'order_key', slug),
          expected_revision: requireKernelNumber(
            input.expected_revision,
            'expected_revision',
            slug,
          ),
          artifact: verified.pin,
        });
      }

      case 'seller-order-transition': {
        if (!dispatchers.sellerOrderTransition) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            'seller-order-transition unavailable — no paired server or Seller dispatcher',
            { slug },
          );
        }
        const input = call.input as Record<string, unknown>;
        assertOnlyKernelInputFields(
          input,
          ['order_key', 'expected_revision', 'next_phase', 'error_code'],
          slug,
        );
        // ⛔ F5 — a first, cheap refusal. The REAL fence is at the storage
        // boundary (`transitionOrder`), and it must stay there: this layer can be
        // bypassed by any other caller of the store, and a check that lives only
        // in front of one door is not a fence. Both refuse the same set, DERIVED
        // from one const, so they cannot disagree.
        if (!isSellerOrderTransitionOpTarget(input.next_phase)) {
          throw new IngredientError(
            'BAD_INPUT',
            `seller-order-transition: '${String(input.next_phase)}' asserts that money `
              + 'moved — use seller-order-confirm-payment or seller-order-confirm-refund, '
              + 'which verify provider evidence',
            { slug },
          );
        }
        return dispatchers.sellerOrderTransition({
          order_key: requireKernelString(input.order_key, 'order_key', slug),
          expected_revision: requireKernelNumber(
            input.expected_revision,
            'expected_revision',
            slug,
          ),
          next_phase: input.next_phase,
          error_code: optionalKernelString(input.error_code, 'error_code', slug) ?? null,
        });
      }

      case 'seller-order-link-work-entity': {
        if (!dispatchers.sellerOrderLinkWorkEntity) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            'seller-order-link-work-entity unavailable — no paired server or Seller dispatcher',
            { slug },
          );
        }
        const input = call.input as Record<string, unknown>;
        assertOnlyKernelInputFields(
          input,
          ['order_key', 'expected_revision', 'work_entity_kind', 'work_entity_id'],
          slug,
        );
        if (!isWorkEntityKind(input.work_entity_kind)) {
          throw new IngredientError(
            'BAD_INPUT',
            'seller-order-link-work-entity: work_entity_kind is not a work-entity kind',
            { slug },
          );
        }
        return dispatchers.sellerOrderLinkWorkEntity({
          order_key: requireKernelString(input.order_key, 'order_key', slug),
          expected_revision: requireKernelNumber(
            input.expected_revision,
            'expected_revision',
            slug,
          ),
          work_entity_kind: input.work_entity_kind,
          work_entity_id: requireKernelString(input.work_entity_id, 'work_entity_id', slug),
        });
      }

      case 'seller-order-link-customer': {
        if (!dispatchers.sellerOrderLinkCustomer) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            'seller-order-link-customer unavailable — no paired server or Seller dispatcher',
            { slug },
          );
        }
        const input = call.input as Record<string, unknown>;
        assertOnlyKernelInputFields(
          input,
          ['order_key', 'expected_revision', 'customer_id'],
          slug,
        );
        return dispatchers.sellerOrderLinkCustomer({
          order_key: requireKernelString(input.order_key, 'order_key', slug),
          expected_revision: requireKernelNumber(
            input.expected_revision,
            'expected_revision',
            slug,
          ),
          customer_id: requireKernelString(input.customer_id, 'customer_id', slug),
        });
      }

      // ── D-196 §4.5 — core.seller.tier: the vendor-neutral tier read ────────
      case 'seller-tier-get': {
        if (!dispatchers.sellerTierGet) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            'seller-tier-get unavailable — no paired server or Seller dispatcher',
            { slug },
          );
        }
        const input = call.input as Record<string, unknown>;
        // ⛔ The closed key set deliberately admits NO row id: the entitlement
        // KEY is the recipe-facing tier identity (it survives a re-sync; row
        // ids do not), addressed by the same triple `customer-access-issue`
        // consumes.
        assertOnlyKernelInputFields(
          input,
          ['lifecycle_source', 'door_id', 'entitlement_key'],
          slug,
        );
        return dispatchers.sellerTierGet({
          lifecycle_source: requireSellerLifecycleSource(input.lifecycle_source, slug),
          door_id: requireKernelString(input.door_id, 'door_id', slug),
          entitlement_key: requireKernelString(
            input.entitlement_key,
            'entitlement_key',
            slug,
          ),
        });
      }

      case 'seller-tier-list': {
        if (!dispatchers.sellerTierList) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            'seller-tier-list unavailable — no paired server or Seller dispatcher',
            { slug },
          );
        }
        const input = call.input as Record<string, unknown>;
        assertOnlyKernelInputFields(
          input,
          ['door_id', 'lifecycle_source', 'active'],
          slug,
        );
        const listInput: KernelSellerTierListInput = {};
        const door_id = optionalKernelString(input.door_id, 'door_id', slug);
        if (door_id !== undefined) listInput.door_id = door_id;
        if (
          input.lifecycle_source !== undefined
          && input.lifecycle_source !== null
          && input.lifecycle_source !== ''
        ) {
          listInput.lifecycle_source = requireSellerLifecycleSource(
            input.lifecycle_source,
            slug,
          );
        }
        if (input.active !== undefined && input.active !== null && input.active !== '') {
          if (typeof input.active !== 'boolean') {
            throw new IngredientError(
              'BAD_INPUT',
              'seller-tier-list: active must be a boolean when provided',
              { slug },
            );
          }
          listInput.active = input.active;
        }
        return dispatchers.sellerTierList(listInput);
      }

      case 'customer-access-issue': {
        if (!dispatchers.customerAccessIssue) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `customer-access-issue unavailable — no paired server or customer-access dispatcher`,
            { slug },
          );
        }
        const input = call.input as Record<string, unknown>;
        if (Object.prototype.hasOwnProperty.call(input, 'customer_id')) {
          throw new IngredientError(
            'BAD_INPUT',
            `customer-access-issue: customer_id is server-generated and must not be supplied`,
            { slug },
          );
        }
        const callerTokenField = [
          'token_grants',
          'token_label',
          'token_expires_at',
          'token_concurrency_tier',
          'token_chat_mode',
        ].find((field) => Object.prototype.hasOwnProperty.call(input, field));
        if (callerTokenField !== undefined) {
          throw new IngredientError(
            'BAD_INPUT',
            `customer-access-issue: ${callerTokenField} is server-derived and must not be supplied`,
            { slug },
          );
        }
        const dispatchInput: KernelCustomerAccessIssueInput = {
          lifecycle_source: requireSellerLifecycleSource(input.lifecycle_source, slug),
          door_id: requireKernelString(input.door_id, 'door_id', slug),
          source_customer_id: requireKernelString(input.source_customer_id, 'source_customer_id', slug),
          entitlement_key: requireKernelString(input.entitlement_key, 'entitlement_key', slug),
        };
        const email = optionalNullableKernelString(input.email, 'email', slug);
        if (email !== undefined) dispatchInput.email = email;
        const current_period_end = optionalCustomerAccessPeriodEnd(input, slug);
        if (current_period_end !== undefined) dispatchInput.current_period_end = current_period_end;
        const source_status = optionalNullableKernelString(input.source_status, 'source_status', slug);
        if (source_status !== undefined) dispatchInput.source_status = source_status;
        const external_subscription_id = optionalNullableKernelString(
          input.external_subscription_id,
          'external_subscription_id',
          slug,
        );
        if (external_subscription_id !== undefined) {
          dispatchInput.external_subscription_id = external_subscription_id;
        }
        return dispatchers.customerAccessIssue(dispatchInput);
      }

      case 'customer-access-extend': {
        if (!dispatchers.customerAccessExtend) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `customer-access-extend unavailable — no paired server or customer-access dispatcher`,
            { slug },
          );
        }
        const input = call.input as Record<string, unknown>;
        const dispatchInput: KernelCustomerAccessExtendInput = parseCustomerAccessTarget(input, slug);
        const current_period_end = optionalCustomerAccessPeriodEnd(input, slug);
        if (current_period_end !== undefined) dispatchInput.current_period_end = current_period_end;
        const source_status = optionalNullableKernelString(input.source_status, 'source_status', slug);
        if (source_status !== undefined) dispatchInput.source_status = source_status;
        const email = optionalNullableKernelString(input.email, 'email', slug);
        if (email !== undefined) dispatchInput.email = email;
        return dispatchers.customerAccessExtend(dispatchInput);
      }

      case 'customer-access-swap-tier': {
        if (!dispatchers.customerAccessSwapTier) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `customer-access-swap-tier unavailable — no paired server or customer-access dispatcher`,
            { slug },
          );
        }
        const input = call.input as Record<string, unknown>;
        const dispatchInput: KernelCustomerAccessSwapTierInput = {
          ...parseCustomerAccessTarget(input, slug),
          entitlement_key: requireKernelString(input.entitlement_key, 'entitlement_key', slug),
        };
        const current_period_end = optionalCustomerAccessPeriodEnd(input, slug);
        if (current_period_end !== undefined) dispatchInput.current_period_end = current_period_end;
        const source_status = optionalNullableKernelString(input.source_status, 'source_status', slug);
        if (source_status !== undefined) dispatchInput.source_status = source_status;
        return dispatchers.customerAccessSwapTier(dispatchInput);
      }

      case 'customer-access-close': {
        if (!dispatchers.customerAccessClose) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `customer-access-close unavailable — no paired server or customer-access dispatcher`,
            { slug },
          );
        }
        const input = call.input as Record<string, unknown>;
        const reason = requireKernelString(input.reason, 'reason', slug);
        if (!isSellerCustomerCloseReason(reason)) {
          throw new IngredientError(
            'BAD_INPUT',
            `customer-access-close: reason must be a supported seller close reason`,
            { slug },
          );
        }
        const dispatchInput: KernelCustomerAccessCloseInput = {
          ...parseCustomerAccessTarget(input, slug),
          reason,
        };
        const source_status = optionalNullableKernelString(input.source_status, 'source_status', slug);
        if (source_status !== undefined) dispatchInput.source_status = source_status;
        return dispatchers.customerAccessClose(dispatchInput);
      }

      // D-127 P2.1 — kernel mail-send. Body / threading / cc-bcc all
      // pass through to the dispatcher; per-input validation runs here
      // so the dispatcher (server: MailCollection.send; ext: rpc) sees
      // a clean shape. Sender-loop guard + audit emission + capability
      // check live in MailCollection.send so this slot is the thin
      // input-validation layer over the unified rpc.
      case 'mail-send': {
        if (!dispatchers.mailSend) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `mail-send unavailable — no paired server or mail-send dispatcher`,
            { slug },
          );
        }
        const input = call.input as {
          sender_mail_instance?: unknown;
          to?: unknown;
          cc?: unknown;
          bcc?: unknown;
          subject?: unknown;
          body?: unknown;
          body_format?: unknown;
          in_reply_to?: unknown;
          references?: unknown;
          reply_to?: unknown;
          reconciliation_id?: unknown;
          attachments?: unknown;
        };
        if (typeof input.sender_mail_instance !== 'string'
          || input.sender_mail_instance.length === 0) {
          throw new IngredientError(
            'BAD_INPUT',
            `mail-send: sender_mail_instance is required`,
            { slug },
          );
        }
        const to = coerceStringArray(input.to, 'mail-send: to');
        if (to.length === 0) {
          throw new IngredientError(
            'BAD_INPUT',
            `mail-send: to must contain at least one recipient`,
            { slug },
          );
        }
        if (typeof input.subject !== 'string') {
          throw new IngredientError(
            'BAD_INPUT',
            `mail-send: subject is required`,
            { slug },
          );
        }
        if (typeof input.body !== 'string') {
          throw new IngredientError(
            'BAD_INPUT',
            `mail-send: body is required`,
            { slug },
          );
        }
        const bodyFormat = input.body_format === 'html' ? 'html' : 'text';
        const dispatchInput: Parameters<NonNullable<KernelDispatchers['mailSend']>>[0] = {
          instance: input.sender_mail_instance,
          to,
          subject: input.subject,
          body_text: bodyFormat === 'html' ? '' : input.body,
        };
        if (bodyFormat === 'html') dispatchInput.body_html = input.body;
        if (input.cc !== undefined && input.cc !== null) {
          dispatchInput.cc = coerceStringArray(input.cc, 'mail-send: cc');
        }
        if (input.bcc !== undefined && input.bcc !== null) {
          dispatchInput.bcc = coerceStringArray(input.bcc, 'mail-send: bcc');
        }
        if (typeof input.in_reply_to === 'string' && input.in_reply_to.length > 0) {
          dispatchInput.in_reply_to = input.in_reply_to;
        }
        if (input.references !== undefined && input.references !== null) {
          dispatchInput.references = coerceStringArray(
            input.references,
            'mail-send: references',
          );
        }
        if (typeof input.reply_to === 'string' && input.reply_to.length > 0) {
          dispatchInput.reply_to = input.reply_to;
        }
        if (input.reconciliation_id !== undefined && input.reconciliation_id !== null) {
          if (!isMailReconciliationId(input.reconciliation_id)) {
            throw new IngredientError(
              'BAD_INPUT',
              'mail-send: reconciliation_id must be a bounded ASCII header token',
              { slug },
            );
          }
          dispatchInput.reconciliation_id = input.reconciliation_id;
        }
        // D-172 P2 — forward `attachments` refs (data.file record-ids) to
        // the dispatcher. The kernel just carries the refs as strings;
        // resolution (ref → bytes via the Gateway-gated file.read) happens
        // at the backend MailCollection.send layer, which has the file-
        // read deps. Empty / absent leaves the field off so the legacy
        // text/html send shape is byte-identical.
        if (input.attachments !== undefined && input.attachments !== null) {
          const attachments = coerceStringArray(
            input.attachments,
            'mail-send: attachments',
          );
          if (attachments.length > 0) dispatchInput.attachments = attachments;
        }
        // D-127 follow-on — thread engine-supplied step identity to the
        // dispatcher so the rpc-layer `mail_send` audit row carries
        // `recipe_id` + `step_id`. `call.stepMeta` is populated by
        // `createIngredientExecutor` only — direct adapter callers
        // (tests building a `ResolvedCall` manually, MCP agent paths)
        // leave it absent and the audit row omits both fields.
        if (call.stepMeta?.recipe_id) {
          dispatchInput.recipe_id = call.stepMeta.recipe_id;
        }
        if (call.stepMeta?.step_id) {
          dispatchInput.step_id = call.stepMeta.step_id;
        }
        try {
          return await dispatchers.mailSend(dispatchInput);
        } catch (err) {
          // Translate the rpc-layer "slug not registered" error
          // (`RpcError('not_found')` from `requireMailCollection`) into
          // a recipe-friendly typed code so the surface is consistent
          // with the other MAIL_SEND_* codes from P1.2.
          if (isCollectionNotFoundError(err)) {
            throw new IngredientError(
              'MAIL_INSTANCE_NOT_FOUND',
              `mail-send: '${input.sender_mail_instance}' is not a registered mail account`,
              { slug, sender_mail_instance: input.sender_mail_instance },
            );
          }
          // D-145 engine-wiring slice 3b.3 — a send that fails in
          // flight (provider 5xx, malformed ack, SMTP socket drop /
          // timeout) is genuine uncertain delivery: the message may
          // already be queued or sent. The gmail / graph / imap
          // providers surface every such failure as the single
          // `MAIL_SEND_NETWORK_FAILED` bucket — normalise it to the
          // `ACTION_DELIVERY_UNCERTAIN` code the commit Gateway keys on
          // (`isInDoubtError`) so the commit records `in_doubt`, not a
          // wrong `failed` that would invite a blind double-send retry.
          // Confirmed pre-send failures (`MAIL_SEND_AUTH_FAILED` /
          // `MAIL_SEND_RECIPIENT_INVALID` / capability + self-loop
          // guards) keep their codes — those genuinely never sent. The
          // original code is preserved in `details.mail_send_code`.
          // (Honours the slice-3b.2 cross-slice obligation: every
          // executor capable of uncertain delivery surfaces
          // `ACTION_DELIVERY_UNCERTAIN`.) Other errors — confirmed-
          // failure `IngredientError`s, rpc transport errors —
          // propagate unchanged.
          if (
            err instanceof IngredientError
            && err.code === 'MAIL_SEND_NETWORK_FAILED'
          ) {
            throw new IngredientError(
              'ACTION_DELIVERY_UNCERTAIN',
              err.message,
              {
                ...(err.details ?? {}),
                slug,
                mail_send_code: 'MAIL_SEND_NETWORK_FAILED',
              },
            );
          }
          throw err;
        }
      }

      // D-210 §7 — notify a booking's visitor of a change (e.g. a reschedule).
      // Thin input validation over the injected dispatcher, which resolves the
      // SEALED visitor address server-side (booking → `reception_record_id` →
      // open only `visitor_email`) and delegates the send to `mailSend`. The
      // recipe supplies the BOOKING, the owner's sender, and the message — never
      // the recipient, which never reaches step state. Joins
      // OUTBOUND_SEND_INGREDIENT_SLUGS so the send still lifts to the D-157 gate.
      case 'notify-booking-visitor': {
        if (!dispatchers.notifyBookingVisitor) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `notify-booking-visitor unavailable — no paired server or dispatcher`,
            { slug },
          );
        }
        const input = call.input as {
          booking_id?: unknown;
          sender_mail_instance?: unknown;
          subject?: unknown;
          body?: unknown;
          body_format?: unknown;
        };
        if (typeof input.booking_id !== 'string' || input.booking_id.length === 0) {
          throw new IngredientError(
            'BAD_INPUT',
            `notify-booking-visitor: booking_id is required`,
            { slug },
          );
        }
        if (typeof input.sender_mail_instance !== 'string'
          || input.sender_mail_instance.length === 0) {
          throw new IngredientError(
            'BAD_INPUT',
            `notify-booking-visitor: sender_mail_instance is required`,
            { slug },
          );
        }
        if (typeof input.subject !== 'string') {
          throw new IngredientError(
            'BAD_INPUT',
            `notify-booking-visitor: subject is required`,
            { slug },
          );
        }
        if (typeof input.body !== 'string') {
          throw new IngredientError(
            'BAD_INPUT',
            `notify-booking-visitor: body is required`,
            { slug },
          );
        }
        const dispatchInput: Parameters<
          NonNullable<KernelDispatchers['notifyBookingVisitor']>
        >[0] = {
          booking_id: input.booking_id,
          sender_mail_instance: input.sender_mail_instance,
          subject: input.subject,
          body: input.body,
        };
        if (input.body_format === 'html') dispatchInput.body_format = 'html';
        if (call.stepMeta?.recipe_id) dispatchInput.recipe_id = call.stepMeta.recipe_id;
        if (call.stepMeta?.step_id) dispatchInput.step_id = call.stepMeta.step_id;
        return dispatchers.notifyBookingVisitor(dispatchInput);
      }

      case 'timeline-read': {
        if (!dispatchers.timelineRead) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `timeline-read unavailable — no paired server or timeline dispatcher`,
            { slug },
          );
        }
        const input = call.input as {
          entity?: unknown;
          axis?: unknown;
          since?: unknown;
          until?: unknown;
          limit?: unknown;
          cursor?: unknown;
        };
        if (typeof input.entity !== 'string' || input.entity.length === 0) {
          throw new IngredientError(
            'BAD_INPUT',
            `timeline-read: entity is required (format <collection>:<id>)`,
            { slug },
          );
        }
        // Validate the colon-separated shape early so the dispatcher
        // can assume `parseTimelineEntityId` will succeed downstream.
        // The MCP primitive itself re-validates and would throw a
        // typed RpcError; we surface a kernel-error instead so the
        // recipe layer sees a consistent BAD_INPUT shape.
        if (!input.entity.includes(':')) {
          throw new IngredientError(
            'BAD_INPUT',
            `timeline-read: entity must be '<collection>:<id>' (got: ${input.entity})`,
            { slug },
          );
        }
        const dispatchInput: Parameters<NonNullable<KernelDispatchers['timelineRead']>>[0] = {
          entity: input.entity,
        };
        if (input.axis === 'event' || input.axis === 'ingestion') {
          dispatchInput.axis = input.axis;
        }
        if (typeof input.since === 'number') dispatchInput.since = input.since;
        if (typeof input.until === 'number') dispatchInput.until = input.until;
        if (typeof input.limit === 'number') dispatchInput.limit = input.limit;
        if (typeof input.cursor === 'string') dispatchInput.cursor = input.cursor;
        // P7.G — forward the engine-stamped trigger_source so the
        // recipe-channel dispatcher can gate on `mcp_exposed: 'private'`
        // when the enclosing recipe was MCP-triggered. Mirrors the
        // `enrichment-list` adapter's threading per P7.E.
        if (typeof call.stepMeta?.trigger_source === 'string') {
          dispatchInput.trigger_source = call.stepMeta.trigger_source;
        }
        // D-187 — forward the run's contract_id so the recipe-channel timeline
        // dispatcher resolves the per-(bound contract, topic) read-visibility map
        // (mirrors the enrichment-list threading above).
        if (typeof call.stepMeta?.contract_id === 'string'
            && call.stepMeta.contract_id.length > 0) {
          dispatchInput.origin_contract_id = call.stepMeta.contract_id;
        }
        return dispatchers.timelineRead(dispatchInput);
      }

      // ── Recipe-callable work-entity reads ───────────────────────
      case 'work-entity-list': {
        if (!dispatchers.workEntityList) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `work-entity-list unavailable — no paired server or work-entity dispatcher`,
            { slug },
          );
        }
        const raw = call.input as Record<string, unknown>;
        if (typeof raw.kind !== 'string' || !isWorkEntityKind(raw.kind)) {
          throw new IngredientError(
            'BAD_INPUT',
            'work-entity-list: kind must be task, note, commitment, project, or booking',
            { slug },
          );
        }
        if (raw.parent_project_id !== undefined
          && raw.kind !== 'task' && raw.kind !== 'project') {
          throw new IngredientError(
            'BAD_INPUT',
            'work-entity-list: parent_project_id is admitted only for task or project',
            { slug },
          );
        }
        if (raw.source_id !== undefined
          && (typeof raw.source_id !== 'string' || raw.source_id.length === 0)) {
          throw new IngredientError(
            'BAD_INPUT',
            'work-entity-list: source_id must be a non-empty string when supplied',
            { slug },
          );
        }
        if (raw.parent_project_id !== undefined
          && (typeof raw.parent_project_id !== 'string'
            || raw.parent_project_id.length === 0)) {
          throw new IngredientError(
            'BAD_INPUT',
            'work-entity-list: parent_project_id must be a non-empty string when supplied',
            { slug },
          );
        }
        if (raw.sync_states !== undefined
          && (!Array.isArray(raw.sync_states)
            || !raw.sync_states.every((state) =>
              typeof state === 'string' && SYNC_STATE_SET.has(state as SyncState)))) {
          throw new IngredientError(
            'BAD_INPUT',
            'work-entity-list: sync_states contains an unknown state',
            { slug },
          );
        }
        for (const flag of ['include_deleted', 'include_disabled'] as const) {
          if (raw[flag] !== undefined && typeof raw[flag] !== 'boolean') {
            throw new IngredientError(
              'BAD_INPUT',
              `work-entity-list: ${flag} must be boolean when supplied`,
              { slug },
            );
          }
        }
        if (raw.limit !== undefined
          && (typeof raw.limit !== 'number' || !Number.isInteger(raw.limit) || raw.limit < 1)) {
          throw new IngredientError(
            'BAD_INPUT',
            'work-entity-list: limit must be a positive integer when supplied',
            { slug },
          );
        }
        if (raw.offset !== undefined
          && (typeof raw.offset !== 'number' || !Number.isInteger(raw.offset) || raw.offset < 0)) {
          throw new IngredientError(
            'BAD_INPUT',
            'work-entity-list: offset must be a non-negative integer when supplied',
            { slug },
          );
        }
        const input: Parameters<NonNullable<KernelDispatchers['workEntityList']>>[0] = {
          kind: raw.kind,
        };
        if (typeof raw.source_id === 'string') input.source_id = raw.source_id;
        if (Array.isArray(raw.sync_states)) input.sync_states = raw.sync_states as SyncState[];
        if (typeof raw.include_deleted === 'boolean') input.include_deleted = raw.include_deleted;
        if (typeof raw.include_disabled === 'boolean') input.include_disabled = raw.include_disabled;
        if (typeof raw.parent_project_id === 'string') input.parent_project_id = raw.parent_project_id;
        if (typeof raw.limit === 'number') input.limit = raw.limit;
        if (typeof raw.offset === 'number') input.offset = raw.offset;
        return dispatchers.workEntityList(input);
      }
      case 'work-entity-get': {
        if (!dispatchers.workEntityGet) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `work-entity-get unavailable — no paired server or work-entity dispatcher`,
            { slug },
          );
        }
        const raw = call.input as Record<string, unknown>;
        if (typeof raw.kind !== 'string' || !isWorkEntityKind(raw.kind)) {
          throw new IngredientError(
            'BAD_INPUT',
            'work-entity-get: kind must be task, note, commitment, project, or booking',
            { slug },
          );
        }
        if (typeof raw.id !== 'string' || raw.id.length === 0) {
          throw new IngredientError('BAD_INPUT', 'work-entity-get: id is required', { slug });
        }
        return dispatchers.workEntityGet({ kind: raw.kind, id: raw.id });
      }

      // ── D-145 PA3 — work-entity CRUD kernel ingredients ────────
      // Each slug routes to its own dispatcher slot. Source resolution
      // + write-capability validation + commitment lifecycle moves all
      // happen at the dispatcher (server-side); the kernel adapter
      // does input shape validation only. Stamps `_id` + `_collection`
      // on the returned canonical record so recipes can read
      // `{{step.task._id}}` / `{{step.task._collection}}` uniformly.
      case 'task-create': {
        if (!dispatchers.taskCreate) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `task-create unavailable — no paired server or work-entity dispatcher`,
            { slug },
          );
        }
        const input = call.input as Parameters<NonNullable<KernelDispatchers['taskCreate']>>[0];
        if (typeof input.title !== 'string' || input.title.length === 0) {
          throw new IngredientError('BAD_INPUT', 'task-create: title is required', { slug });
        }
        const out = await dispatchers.taskCreate(withCreateOrigin(input, call.stepMeta));
        return { task: stampOne(out.task as unknown as Record<string, unknown>, 'task', out.task.id) };
      }
      case 'task-update': {
        if (!dispatchers.taskUpdate) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `task-update unavailable — no paired server or work-entity dispatcher`,
            { slug },
          );
        }
        const input = call.input as Parameters<NonNullable<KernelDispatchers['taskUpdate']>>[0];
        if (typeof input.id !== 'string' || input.id.length === 0) {
          throw new IngredientError('BAD_INPUT', 'task-update: id is required', { slug });
        }
        const out = await dispatchers.taskUpdate(input);
        return { task: stampOne(out.task as unknown as Record<string, unknown>, 'task', out.task.id) };
      }
      case 'task-delete': {
        if (!dispatchers.taskDelete) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `task-delete unavailable — no paired server or work-entity dispatcher`,
            { slug },
          );
        }
        const input = call.input as Parameters<NonNullable<KernelDispatchers['taskDelete']>>[0];
        if (typeof input.id !== 'string' || input.id.length === 0) {
          throw new IngredientError('BAD_INPUT', 'task-delete: id is required', { slug });
        }
        return dispatchers.taskDelete(input);
      }
      case 'task-mark-done': {
        if (!dispatchers.taskMarkDone) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `task-mark-done unavailable — no paired server or work-entity dispatcher`,
            { slug },
          );
        }
        const input = call.input as Parameters<NonNullable<KernelDispatchers['taskMarkDone']>>[0];
        if (typeof input.id !== 'string' || input.id.length === 0) {
          throw new IngredientError('BAD_INPUT', 'task-mark-done: id is required', { slug });
        }
        const out = await dispatchers.taskMarkDone(input);
        return { task: stampOne(out.task as unknown as Record<string, unknown>, 'task', out.task.id) };
      }

      case 'note-create': {
        if (!dispatchers.noteCreate) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `note-create unavailable — no paired server or work-entity dispatcher`,
            { slug },
          );
        }
        const input = call.input as Parameters<NonNullable<KernelDispatchers['noteCreate']>>[0];
        if (typeof input.body !== 'string' || input.body.length === 0) {
          throw new IngredientError('BAD_INPUT', 'note-create: body is required', { slug });
        }
        const out = await dispatchers.noteCreate(withCreateOrigin(input, call.stepMeta));
        return { note: stampOne(out.note as unknown as Record<string, unknown>, 'note', out.note.id) };
      }
      case 'note-update': {
        if (!dispatchers.noteUpdate) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `note-update unavailable — no paired server or work-entity dispatcher`,
            { slug },
          );
        }
        const input = call.input as Parameters<NonNullable<KernelDispatchers['noteUpdate']>>[0];
        if (typeof input.id !== 'string' || input.id.length === 0) {
          throw new IngredientError('BAD_INPUT', 'note-update: id is required', { slug });
        }
        const out = await dispatchers.noteUpdate(input);
        return { note: stampOne(out.note as unknown as Record<string, unknown>, 'note', out.note.id) };
      }
      case 'note-delete': {
        if (!dispatchers.noteDelete) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `note-delete unavailable — no paired server or work-entity dispatcher`,
            { slug },
          );
        }
        const input = call.input as Parameters<NonNullable<KernelDispatchers['noteDelete']>>[0];
        if (typeof input.id !== 'string' || input.id.length === 0) {
          throw new IngredientError('BAD_INPUT', 'note-delete: id is required', { slug });
        }
        return dispatchers.noteDelete(input);
      }

      // D-192 F1 — `commitment-propose` is the review-then-approve PROPOSAL
      // surface: the SAME create dispatcher (the gate, not the effect, is the
      // difference — the proposal slug rides the all-actor approval lift, so
      // a dispatch reaching THIS code has already been owner-approved or was
      // resumed past the D-157 hold).
      case 'commitment-create':
      case 'commitment-propose': {
        if (!dispatchers.commitmentCreate) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `${slug} unavailable — no paired server or work-entity dispatcher`,
            { slug },
          );
        }
        const input = call.input as Parameters<NonNullable<KernelDispatchers['commitmentCreate']>>[0];
        if (typeof input.direction !== 'string') {
          throw new IngredientError('BAD_INPUT', `${slug}: direction is required`, { slug });
        }
        if (typeof input.statement !== 'string' || input.statement.length === 0) {
          throw new IngredientError('BAD_INPUT', `${slug}: statement is required`, { slug });
        }
        if (typeof input.derivation !== 'string') {
          throw new IngredientError('BAD_INPUT', `${slug}: derivation is required`, { slug });
        }
        const out = await dispatchers.commitmentCreate(withCreateOrigin(input, call.stepMeta));
        return { commitment: stampOne(out.commitment as unknown as Record<string, unknown>, 'commitment', out.commitment.id) };
      }
      case 'commitment-update': {
        if (!dispatchers.commitmentUpdate) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `commitment-update unavailable — no paired server or work-entity dispatcher`,
            { slug },
          );
        }
        const input = call.input as Parameters<NonNullable<KernelDispatchers['commitmentUpdate']>>[0];
        if (typeof input.id !== 'string' || input.id.length === 0) {
          throw new IngredientError('BAD_INPUT', 'commitment-update: id is required', { slug });
        }
        const out = await dispatchers.commitmentUpdate(input);
        return { commitment: stampOne(out.commitment as unknown as Record<string, unknown>, 'commitment', out.commitment.id) };
      }
      case 'commitment-fulfill': {
        if (!dispatchers.commitmentFulfill) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `commitment-fulfill unavailable — no paired server or work-entity dispatcher`,
            { slug },
          );
        }
        const input = call.input as Parameters<NonNullable<KernelDispatchers['commitmentFulfill']>>[0];
        if (typeof input.id !== 'string' || input.id.length === 0) {
          throw new IngredientError('BAD_INPUT', 'commitment-fulfill: id is required', { slug });
        }
        const out = await dispatchers.commitmentFulfill(input);
        return { commitment: stampOne(out.commitment as unknown as Record<string, unknown>, 'commitment', out.commitment.id) };
      }
      case 'commitment-cancel': {
        if (!dispatchers.commitmentCancel) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `commitment-cancel unavailable — no paired server or work-entity dispatcher`,
            { slug },
          );
        }
        const input = call.input as Parameters<NonNullable<KernelDispatchers['commitmentCancel']>>[0];
        if (typeof input.id !== 'string' || input.id.length === 0) {
          throw new IngredientError('BAD_INPUT', 'commitment-cancel: id is required', { slug });
        }
        const out = await dispatchers.commitmentCancel(input);
        return { commitment: stampOne(out.commitment as unknown as Record<string, unknown>, 'commitment', out.commitment.id) };
      }

      case 'project-create': {
        if (!dispatchers.projectCreate) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `project-create unavailable — no paired server or work-entity dispatcher`,
            { slug },
          );
        }
        const input = call.input as Parameters<NonNullable<KernelDispatchers['projectCreate']>>[0];
        if (typeof input.title !== 'string' || input.title.length === 0) {
          throw new IngredientError('BAD_INPUT', 'project-create: title is required', { slug });
        }
        const out = await dispatchers.projectCreate(withCreateOrigin(input, call.stepMeta));
        return { project: stampOne(out.project as unknown as Record<string, unknown>, 'project', out.project.id) };
      }
      case 'project-update': {
        if (!dispatchers.projectUpdate) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `project-update unavailable — no paired server or work-entity dispatcher`,
            { slug },
          );
        }
        const input = call.input as Parameters<NonNullable<KernelDispatchers['projectUpdate']>>[0];
        if (typeof input.id !== 'string' || input.id.length === 0) {
          throw new IngredientError('BAD_INPUT', 'project-update: id is required', { slug });
        }
        const out = await dispatchers.projectUpdate(input);
        return { project: stampOne(out.project as unknown as Record<string, unknown>, 'project', out.project.id) };
      }
      case 'project-archive': {
        if (!dispatchers.projectArchive) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `project-archive unavailable — no paired server or work-entity dispatcher`,
            { slug },
          );
        }
        const input = call.input as Parameters<NonNullable<KernelDispatchers['projectArchive']>>[0];
        if (typeof input.id !== 'string' || input.id.length === 0) {
          throw new IngredientError('BAD_INPUT', 'project-archive: id is required', { slug });
        }
        const out = await dispatchers.projectArchive(input);
        return { project: stampOne(out.project as unknown as Record<string, unknown>, 'project', out.project.id) };
      }

      // D-210 — booking. THREE verbs: a lifecycle move rides `booking-update`
      // rather than dedicated cancel / complete slugs, because a booking has no
      // state MACHINE to guard (a real reservation genuinely goes
      // confirmed -> cancelled -> confirmed again). The dispatcher, not this
      // arm, decides whether the move re-stamps `state_changed_at`.
      case 'booking-create': {
        if (!dispatchers.bookingCreate) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `booking-create unavailable — no paired server or work-entity dispatcher`,
            { slug },
          );
        }
        const input = call.input as Parameters<NonNullable<KernelDispatchers['bookingCreate']>>[0];
        if (typeof input.title !== 'string' || input.title.length === 0) {
          throw new IngredientError('BAD_INPUT', 'booking-create: title is required', { slug });
        }
        // ⛔ STRIP caller-supplied provenance. `reception_record_id` says "this
        // booking came from that visitor's request" — an authority claim, and
        // nothing here can verify it: there is no existence check and no
        // reception-origin check, so any holder of
        // `core.work-entity.booking.create` (a recipe, a chat turn, an MCP
        // door) could mint a booking that CLAIMS to be a real reservation.
        // Fabricated provenance is worse than none, because every downstream
        // reader treats it as evidence.
        //
        // The reception mint path (D-210 slice 3) writes it SERVER-SIDE
        // through the store, never through this op — the same shape as the
        // sealed visitor email: the caller names the work, the server supplies
        // the identity. Stripped HERE rather than only omitted from the
        // manifest because the engine does not filter `call.input` by the
        // manifest's declared keys, so an undeclared field still arrives.
        const { reception_record_id: _ignoredProvenance, ...safeInput } = input as
          typeof input & { reception_record_id?: string };
        const out = await dispatchers.bookingCreate(withCreateOrigin(safeInput, call.stepMeta));
        return { booking: stampOne(out.booking as unknown as Record<string, unknown>, 'booking', out.booking.id) };
      }
      case 'booking-update': {
        if (!dispatchers.bookingUpdate) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `booking-update unavailable — no paired server or work-entity dispatcher`,
            { slug },
          );
        }
        const input = call.input as Parameters<NonNullable<KernelDispatchers['bookingUpdate']>>[0];
        if (typeof input.id !== 'string' || input.id.length === 0) {
          throw new IngredientError('BAD_INPUT', 'booking-update: id is required', { slug });
        }
        const out = await dispatchers.bookingUpdate(input);
        return { booking: stampOne(out.booking as unknown as Record<string, unknown>, 'booking', out.booking.id) };
      }
      case 'booking-delete': {
        if (!dispatchers.bookingDelete) {
          throw new IngredientError(
            'SERVER_NOT_REACHABLE',
            `booking-delete unavailable — no paired server or work-entity dispatcher`,
            { slug },
          );
        }
        const input = call.input as Parameters<NonNullable<KernelDispatchers['bookingDelete']>>[0];
        if (typeof input.id !== 'string' || input.id.length === 0) {
          throw new IngredientError('BAD_INPUT', 'booking-delete: id is required', { slug });
        }
        return dispatchers.bookingDelete(input);
      }

      default:
        throw new IngredientError(
          'INGREDIENT_NOT_FOUND',
          `unknown kernel ingredient '${slug}'`,
          { slug },
        );
    }
  };
};

const customerAccessPrefix = (slug: string): string => stripCorePrefix(slug);

const assertOnlyKernelInputFields = (
  input: Record<string, unknown>,
  allowed: readonly string[],
  slug: string,
): void => {
  const allowedFields = new Set(allowed);
  const unknown = Object.keys(input).find((field) => !allowedFields.has(field));
  if (unknown !== undefined) {
    throw new IngredientError(
      'BAD_INPUT',
      `${customerAccessPrefix(slug)}: ${unknown} is not a supported input field`,
      { slug },
    );
  }
};

const requireKernelString = (value: unknown, field: string, slug: string): string => {
  if (typeof value !== 'string') {
    throw new IngredientError(
      'BAD_INPUT',
      `${customerAccessPrefix(slug)}: ${field} is required`,
      { slug },
    );
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new IngredientError(
      'BAD_INPUT',
      `${customerAccessPrefix(slug)}: ${field} must be a non-empty string`,
      { slug },
    );
  }
  return trimmed;
};

const optionalKernelString = (
  value: unknown,
  field: string,
  slug: string,
): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new IngredientError(
      'BAD_INPUT',
      `${customerAccessPrefix(slug)}: ${field} must be a string when provided`,
      { slug },
    );
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

/** D-207 §4.3 — a whole, safe integer. Used for `expected_revision` (the CAS
 *  token) and `amount_minor`, where a float or a non-finite value must be a loud
 *  refusal rather than something SQLite quietly coerces. */
const requireKernelNumber = (value: unknown, field: string, slug: string): number => {
  if (!Number.isSafeInteger(value)) {
    throw new IngredientError(
      'BAD_INPUT',
      `${customerAccessPrefix(slug)}: ${field} must be a whole number`,
      { slug },
    );
  }
  return value as number;
};

const isPlainKernelRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const optionalNullableKernelString = (
  value: unknown,
  field: string,
  slug: string,
): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return optionalKernelString(value, field, slug);
};

const optionalNonNegativeInteger = (
  value: unknown,
  field: string,
  slug: string,
): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new IngredientError(
      'BAD_INPUT',
      `${customerAccessPrefix(slug)}: ${field} must be a non-negative integer`,
      { slug },
    );
  }
  return value;
};

const optionalNonNegativeIntegerOrNull = (
  value: unknown,
  field: string,
  slug: string,
): number | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return optionalNonNegativeInteger(value, field, slug);
};

const optionalCustomerAccessPeriodEnd = (
  input: Record<string, unknown>,
  slug: string,
): number | null | undefined => {
  const publicPeriodEnd = optionalNonNegativeIntegerOrNull(
    input.period_end,
    'period_end',
    slug,
  );
  const storagePeriodEnd = optionalNonNegativeIntegerOrNull(
    input.current_period_end,
    'current_period_end',
    slug,
  );
  if (
    publicPeriodEnd !== undefined
    && storagePeriodEnd !== undefined
    && publicPeriodEnd !== storagePeriodEnd
  ) {
    throw new IngredientError(
      'BAD_INPUT',
      `${customerAccessPrefix(slug)}: period_end and current_period_end must not conflict`,
      { slug },
    );
  }
  return publicPeriodEnd !== undefined ? publicPeriodEnd : storagePeriodEnd;
};

const requireSellerLifecycleSource = (
  value: unknown,
  slug: string,
): SellerLifecycleSource => {
  if (!isSellerLifecycleSource(value)) {
    throw new IngredientError(
      'BAD_INPUT',
      `${customerAccessPrefix(slug)}: lifecycle_source must be manual, stripe, or future_provider`,
      { slug },
    );
  }
  return value;
};

const optionalSellerLifecycleSource = (
  value: unknown,
  slug: string,
): SellerLifecycleSource | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.trim().length === 0) return undefined;
  return requireSellerLifecycleSource(value, slug);
};

const parseCustomerAccessTarget = (
  input: Record<string, unknown>,
  slug: string,
): KernelCustomerAccessTargetInput => {
  const customer_id = optionalKernelString(input.customer_id, 'customer_id', slug);
  const lifecycle_source = optionalSellerLifecycleSource(input.lifecycle_source, slug);
  const door_id = optionalKernelString(input.door_id, 'door_id', slug);
  const source_customer_id = optionalKernelString(
    input.source_customer_id,
    'source_customer_id',
    slug,
  );
  if (customer_id === undefined) {
    if (
      lifecycle_source === undefined
      || door_id === undefined
      || source_customer_id === undefined
    ) {
      throw new IngredientError(
        'BAD_INPUT',
        `${customerAccessPrefix(slug)}: target requires customer_id or lifecycle_source/source_customer_id/door_id`,
        { slug },
      );
    }
    return { lifecycle_source, door_id, source_customer_id };
  }

  const target: KernelCustomerAccessTargetInput = { customer_id };
  if (lifecycle_source !== undefined) target.lifecycle_source = lifecycle_source;
  if (door_id !== undefined) target.door_id = door_id;
  if (source_customer_id !== undefined) target.source_customer_id = source_customer_id;
  return target;
};

/** Normalize a `data-annotate` input into `{ collection, id }`. The
 *  recipe surface accepts either `ref: <canonical record>` (typical
 *  inside a `foreach`) or explicit `target_collection` +
 *  `target_id`. Throws `BAD_INPUT` when neither path resolves. */
const resolveTargetRef = (input: {
  ref?: unknown;
  target_collection?: string;
  target_id?: string;
}): { collection: string; id: string } => {
  if (input.ref !== undefined) {
    const extracted = extractCanonicalRef(input.ref);
    if (extracted) return extracted;
    throw new IngredientError(
      'BAD_INPUT',
      `data-annotate: ref is not a canonical record (missing _id / _collection)`,
      {},
    );
  }
  if (
    typeof input.target_collection === 'string'
    && typeof input.target_id === 'string'
  ) {
    return { collection: input.target_collection, id: input.target_id };
  }
  throw new IngredientError(
    'BAD_INPUT',
    `data-annotate: expected either ref or target_collection+target_id`,
    {},
  );
};

/** Normalize a `data-link` `from`/`to` side. Accepts either `${side}:
 *  <canonical record>` or explicit `${side}_collection` +
 *  `${side}_id`. */
const resolveSidedRef = (
  input: Record<string, unknown>,
  side: 'from' | 'to',
): { collection: string; id: string } => {
  const ref = input[side];
  if (ref !== undefined) {
    const extracted = extractCanonicalRef(ref);
    if (extracted) return extracted;
    throw new IngredientError(
      'BAD_INPUT',
      `data-link: ${side} is not a canonical record (missing _id / _collection)`,
      {},
    );
  }
  const collection = input[`${side}_collection`];
  const id = input[`${side}_id`];
  if (typeof collection === 'string' && typeof id === 'string') {
    return { collection, id };
  }
  throw new IngredientError(
    'BAD_INPUT',
    `data-link: expected ${side} (canonical ref) or ${side}_collection+${side}_id`,
    {},
  );
};

/** D-122 Phase 2 — split the combined `<collection>:<id>` entity ref
 *  used by `link-create` / `annotation-create` / `timeline-read`. The
 *  shape mirrors what the MCP `data.timeline()` primitive accepts so
 *  recipes can pass `{{item._id ? data.* :}}` style refs uniformly. We
 *  split on the FIRST colon — collection names don't contain colons,
 *  but record ids occasionally do (`vendor:order:42`), and giving the
 *  rest to the id side preserves them.
 *
 *  Throws `BAD_INPUT` for missing-side or empty-side ref so the recipe
 *  surface sees a typed error before the dispatcher round-trips. */
const parseEntityRef = (
  raw: unknown,
  field: string,
  source: string,
): { collection: string; id: string } => {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new IngredientError(
      'BAD_INPUT',
      `${source}: ${field} is required (format <collection>:<id>)`,
      {},
    );
  }
  const idx = raw.indexOf(':');
  if (idx <= 0 || idx === raw.length - 1) {
    throw new IngredientError(
      'BAD_INPUT',
      `${source}: ${field} must be '<collection>:<id>' (got: ${raw})`,
      {},
    );
  }
  return {
    collection: raw.slice(0, idx),
    id: raw.slice(idx + 1),
  };
};

/** Map the kernel slug prefix to the contract's platform enum.
 *  `email-*` → 'mail' (contract uses the shorter term; the kernel
 *  slug keeps `email-*` because users write that into recipes). */
const platformForSlug = (slug: string): KernelCollectionPlatform => {
  if (slug.startsWith('email-')) return 'mail';
  if (slug.startsWith('file-')) return 'file';
  if (slug.startsWith('webhook-')) return 'webhook';
  throw new IngredientError(
    'INGREDIENT_NOT_FOUND',
    `unsupported collection slug '${slug}'`,
    { slug },
  );
};

/** D-127 P2.1 — coerce a recipe input value into a string-only array.
 *  Recipes pass either a single literal address (string) or a list
 *  via `to: "{{step.list}}"`. Throws `BAD_INPUT` for anything else
 *  with a hint pointing at the offending field. */
const coerceStringArray = (value: unknown, fieldHint: string): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return value as string[];
  }
  throw new IngredientError(
    'BAD_INPUT',
    `${fieldHint} must be a string or array of strings`,
    {},
  );
};

/** D-127 P2.1 — duck-type the rpc-layer "slug not registered" error.
 *  `RpcError` lives in `@recued/contracts` but importing it here would
 *  pull every recipe surface against the rpc namespace. Instead we
 *  recognize the shape: `{ code: 'not_found', message: string }`.
 *  Translating to `MAIL_INSTANCE_NOT_FOUND` is purely a recipe-
 *  surface ergonomic — the rpc reason is preserved in the inner
 *  message via the dispatcher chain. */
const isCollectionNotFoundError = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown };
  if (e.code !== 'not_found') return false;
  if (typeof e.message !== 'string') return false;
  return e.message.includes('COLLECTION_NOT_FOUND')
    || e.message.includes('not found');
};

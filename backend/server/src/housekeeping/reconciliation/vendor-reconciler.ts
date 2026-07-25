/** D-128 Phase 2 — Reconciliation harness.
 *
 *  Wraps a vendor-specific `VendorReconciler` into a
 *  `HousekeepingTaskInstance` that fits into D-123's housekeeping
 *  execution mode. One task per `(vendor, entity, connection_name)`
 *  triple — the reconciler is per-(vendor, entity) (e.g. one for
 *  HubSpot deals, one for HubSpot contacts), the task is bound to a
 *  specific user-enrolled connection (`acme-hubspot`,
 *  `personal-hubspot`).
 *
 *  Per cycle:
 *    1. Read cursor `{ kind: 'time', last_seen_at }` from
 *       `housekeeping_state`. First run reads `0`.
 *    2. Look up the bound `ConnectionRecord` via the supplied
 *       `ConnectionLookup`. Connection deleted / never enrolled →
 *       yield with reason `'no_work'`.
 *    3. Walk `reconciler.listUpdatedSince(connection, cursor, limit)`
 *       batched. Per slim record:
 *         - Compute `new_hash = reconciler.hashOf(slim)`.
 *         - Look up existing enrichment rows for `(scope, target_id)`
 *           via `enrichmentStore.listByTarget`.
 *         - Old hash = first row's `meta.snapshot_hash` (or null on
 *           first sighting).
 *         - If hash matches: skip (no-op — idempotent re-run safety).
 *         - If hash differs / first sighting: refresh meta on every
 *           existing row + emit synthetic warehouse event
 *           (`event_kind: 'updated'` when rows existed, `'created'`
 *           otherwise) carrying the FAT payload: `record` = the new
 *           meta snapshot minus stamping fields, plus `prev` +
 *           `changed_fields` on updates whose prior row carried meta —
 *           so sugar `fields`/`where` dispatch filters evaluate for
 *           real on reconciler-fed vendors (they used to pass-through
 *           on these doorbell events).
 *    4. If `listDeletedSince` is implemented: walk it; emit
 *       `event_kind: 'deleted'` for each target_id, with `prev` = the
 *       last known meta snapshot when one exists.
 *    5. Advance cursor to `max(modified_at)` seen.
 *
 *  Idempotent by construction — the cursor + hash skip-rule mean
 *  re-runs do no work. The cascade engine bridge
 *  (`bridgeEnrichmentCascade`) listens on the warehouse bus and routes
 *  platform-reference-scope events into `cascadeForSourceUpdate` /
 *  `cascadeForSourceDelete`; D-128 P1 widens the bridge to recognise
 *  the open four-segment scope shape.
 *
 *  Spec: `docs/d-128-spec.md` §A.3. */

import {
  CONNECTION_VENDOR_ENTITIES,
  composeVendorEntityScope,
  deserializeEnrichmentMeta,
  vendorHasEngagement,
  PLATFORM_REFERENCE_BATCH_SIZE,
  type ConnectionRecord,
  type EnrichmentMeta,
  type EnrichmentScope,
  type HousekeepingCursor,
  type HousekeepingStepResult,
  type HousekeepingTaskMeta,
} from '@recued/contracts';
import { diffChangedFields } from '@recued/warehouse-events';

import type { HousekeepingContext, HousekeepingTaskInstance } from '../registry.js';
import type { RateGateLease } from './vendor-rate-gate.js';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/** D-128 — slim record yielded by a vendor reconciler. Carries the
 *  canonical fields the harness needs to drive hash-diff + meta
 *  projection; vendor-specific implementations may attach extras for
 *  their own producers. The harness reads only `id` and `modified_at`
 *  directly. */
export interface SlimRecord {
  /** Platform-native record id. Same as the enrichment row's
   *  `target_id` for this vendor + entity. Opaque to the harness. */
  id: string;
  /** Modified-at timestamp from the platform (unix-ms). The cursor
   *  advances to `max(modified_at)` seen across the cycle so the next
   *  run picks up rows updated since. */
  modified_at: number;
}

/** D-128 P3 — one event extracted from a webhook payload. The funnel
 *  routes each entry into the same hash-diff + emit pipeline as the
 *  reconciliation cycle. Vendors with explicit delete events emit a
 *  `'deleted'` entry carrying just the target id; create/update entries
 *  carry a full `SlimRecord` so the funnel can run `hashOf` + `toMeta`
 *  without a follow-up vendor call. */
export type WebhookSlimEvent =
  | { kind: 'created' | 'updated'; record: SlimRecord }
  | { kind: 'deleted'; target_id: string };

/** D-128 P3 — vendor-specific webhook verifier + slim-record producer.
 *  One processor per `(vendor, entity)` reconciler — vendor Ds (D-129
 *  HubSpot, D-130 Salesforce) implement this and the funnel
 *  (`webhook-funnel.ts`) drives it. Multiple reconcilers for the same
 *  vendor share a single inbound endpoint; each parses only the events
 *  for its own entity, so a HubSpot payload mixing deal + contact events
 *  fans out across `(hubspot, deal)` + `(hubspot, contact)` reconcilers
 *  cleanly.
 *
 *  HMAC verification is per-vendor (every entity reconciler from the
 *  same vendor declares the same `signature_header`); the funnel
 *  picks the first registered reconciler for the requested vendor
 *  to read the header name + algorithm. Vendors that authenticate via
 *  a different mechanism (D-130 P5 Salesforce — OAuth-bound CometD
 *  long-poll subscription is the trust boundary; no per-message
 *  signature) leave `signature_header` undefined and the funnel skips
 *  HMAC verification. The dispatcher remains responsible for ensuring
 *  the payload's authenticity through the alternate channel. */
export interface WebhookProcessor {
  /** HTTP header name carrying the HMAC signature. Vendor-specific —
   *  HubSpot uses `X-HubSpot-Signature-v3`, Stripe `Stripe-Signature`,
   *  GitHub `X-Hub-Signature-256`. Header lookup is case-insensitive
   *  at the funnel. Optional at D-130 P5 — Salesforce CometD events
   *  arrive over an OAuth-bound long-poll subscription; the
   *  authentication is the bearer token, not a per-message HMAC, so
   *  the processor declares no header and the funnel skips signature
   *  verification when the dispatcher provides a trusted payload. */
  signature_header?: string;
  /** HMAC algorithm. Today the funnel only supports `'sha256'`; the
   *  field is on the interface so vendors using another algo (e.g.
   *  Stripe's combined timestamp + sha256) declare it explicitly. */
  signature_algorithm?: 'sha256';
  /** Parse a vendor webhook payload (already JSON-decoded by the
   *  funnel) into zero or more slim events. The funnel filters
   *  per-reconciler: each reconciler sees the same payload and
   *  returns only the events relevant to its `(vendor, entity)`.
   *  Returning an empty array is the canonical "this payload is for a
   *  different entity" signal — not an error.
   *
   *  Headers are passed alongside in case the vendor stamps the event
   *  type or entity hint there (HubSpot's subscription `type` lives
   *  in body; GitHub's `X-GitHub-Event` lives in headers).
   *
   *  D-129 P5 widened the return type to allow `Promise` — vendors
   *  whose webhook payloads don't carry full record fields (e.g.
   *  HubSpot stamps only `objectId` per event) need a follow-up GET
   *  per `'created' | 'updated'` event to materialise the slim record
   *  before the funnel runs `hashOf` + `toMeta`. The `connection_name`
   *  parameter lets such processors look up the connection through an
   *  injected lookup at construction time. Sync impls keep working
   *  unchanged — return a plain array. */
  parseEvents(
    payload: unknown,
    headers: Record<string, string>,
    connection_name: string,
  ): ReadonlyArray<WebhookSlimEvent> | Promise<ReadonlyArray<WebhookSlimEvent>>;
  /** Optional — extract a vendor-stable delivery id for dedup against
   *  the `PLATFORM_REFERENCE_WEBHOOK_REPLAY_WINDOW_MS` window. When
   *  the vendor doesn't supply one, the funnel falls back to a body
   *  hash. Returning null defers to the body-hash fallback. */
  deliveryId?(
    payload: unknown,
    headers: Record<string, string>,
  ): string | null;
}

/** D-128 — reconciliation cadences exposed to the user via Settings →
 *  Connections → <connection> → Reconciliation. The harness itself
 *  doesn't enforce the cadence — D-123's scheduler picks tasks per
 *  cycle, and a per-task cadence override lives in subsequent P2
 *  iterations once the picker UI exists. Reserved here so vendor Ds
 *  declare a sensible default. */
export type ReconciliationCadence = '1h' | '6h' | '24h';

/** D-192 S4c2 — the opaque-cursor hook for `sync_kind: 'delta_cursor'`
 *  reconcilers (Microsoft Dynamics OData `$deltatoken`, any incremental-
 *  token engagement vendor). The harness cursor is otherwise numeric time
 *  (`{ kind: 'time', last_seen_at }`); a delta token is an opaque STRING
 *  (often a full `@odata.deltaLink` URL) that must survive across cycles +
 *  restarts. A reconciler that declares `delta` opts the harness into the
 *  `{ kind: 'delta', token }` cursor path instead:
 *
 *    1. Before the walk, the harness hands the reconciler the prior token
 *       (`''` on cold start) via `loadStartRef`; the reconciler's
 *       `listUpdatedSince` drains from it (ignoring the numeric cursor arg).
 *    2. After the walk, the harness reads the new terminal watermark via
 *       `takeWatermark` and persists `{ kind: 'delta', token }`. A `null`
 *       watermark (the walk didn't reach a terminal page — undrained page /
 *       budget yield) HOLDS the prior token, so the next cycle re-walks from
 *       the same ref (mirrors the file-source `shapeDeltaOutcome` undrained-
 *       suppression: never advance a cursor a partial walk couldn't finish).
 *
 *  Per-connection keyed so concurrent steps for different connections of the
 *  same vendor never cross (the `pendingDeletes`/`pendingCursor` closure-Map
 *  pattern from `canonical-crm-reconciler.ts`). A delta reconciler carries
 *  `selfIngest` (its own engagement write) — the two are the engagement path;
 *  it never combines with the numeric-time default write. */
export interface DeltaCursorReconciler {
  /** Hand the harness-loaded prior token (or `''` cold) to the reconciler
   *  before it walks. The reconciler stashes it per connection + drains from
   *  it in `listUpdatedSince`. */
  loadStartRef(connection_name: string, token: string): void;
  /** After the walk, the new terminal watermark to persist, or `null` when
   *  the walk didn't reach one (undrained final page / budget yield) — the
   *  harness then holds the prior token. Clears the per-connection stash so a
   *  later suspended cycle can never replay a stale watermark. */
  takeWatermark(connection_name: string): string | null;
}

/** D-128 — vendor reconciler interface. One instance per `(vendor,
 *  entity)` pair. Vendor Ds (D-129 HubSpot, D-130 Salesforce)
 *  implement this; D-128 ships only the interface + the harness
 *  wrapping it into a HousekeepingTaskInstance. */
export interface VendorReconciler {
  /** Vendor segment of the platform-reference scope (`hubspot`,
   *  `salesforce`, `linear`). Lowercase, `[a-z][a-z0-9_]*`. */
  vendor: string;
  /** Entity segment (`deal`, `opportunity`, `issue`). Lowercase,
   *  `[a-z][a-z0-9_]*`. */
  entity: string;
  /** Default polling cadence — user-overridable in
   *  Settings → Connections → <connection> → Reconciliation once the
   *  picker ships. */
  default_cadence: ReconciliationCadence;
  /** List records updated since cursor. Vendor-specific
   *  implementation — typically a SOQL query, REST endpoint with
   *  `?since=`, or GraphQL filter. The harness reads slim records
   *  one at a time and respects the per-step `limit` to keep cycle
   *  budgets bounded. */
  listUpdatedSince(
    connection: ConnectionRecord,
    cursor: number,
    limit: number,
  ): AsyncIterable<SlimRecord>;
  /** Compute a stable canonical-field hash for the record. Must be
   *  deterministic across runs; vendor-specific field set determines
   *  what counts as a meaningful change. Convention is `<algo>:<hex>`
   *  (e.g. `'fnv1a:8a3f...'`) so the algorithm is self-describing in
   *  storage. D-184 — OPTIONAL: a reconciler that supplies `selfIngest`
   *  (its own richer write) needs neither `hashOf` nor `toMeta`; the
   *  harness skips its hash-diff + default write. A reconciler must
   *  carry EITHER `selfIngest` OR both `hashOf` + `toMeta`
   *  (`buildVendorReconciliationTask` asserts this at construction). */
  hashOf?(record: SlimRecord): string;
  /** Render the meta payload from a slim record. Vendor-specific
   *  field mapping; the result is serialised at upsert time and
   *  rejected when over `PLATFORM_REFERENCE_META_MAX_BYTES`. D-184 —
   *  OPTIONAL (see `hashOf`); a `selfIngest` reconciler omits it. */
  toMeta?(record: SlimRecord): EnrichmentMeta;
  /** Detect deletions. Vendors with explicit delete events use the
   *  webhook channel (P3); vendors without (most CRMs) implement a
   *  periodic existence-check pass and yield deleted target_ids
   *  here. Optional — the harness skips delete propagation when
   *  absent. */
  listDeletedSince?(
    connection: ConnectionRecord,
    cursor: number,
  ): AsyncIterable<string>;
  /** Optional webhook funnel — vendor-D wires the receiver in P3 and
   *  this property routes payloads into the same synthetic-event
   *  path as the cycle. Reserved at P2; the harness ignores it. */
  webhookProcessor?: WebhookProcessor;
  /** D-184 — how many vendor API calls a step consumed, for the shared
   *  `VendorRateGate` daily budget. The harness derives `pages` from the
   *  records processed; this maps `(processed, pages) → api_calls`. Default
   *  (absent) is `pages` — one list/search call per page. That fits the
   *  record reconcilers (deal/contact/company) AND the Salesforce engagement
   *  reconcilers, whose SOQL walk carries every field in the page query (no
   *  per-record fetch). The HubSpot engagement reconcilers make a per-record
   *  associations GET on top of the page, so they override to `pages +
   *  processed` (mirrors the retired runonce runner's `api_calls_consumed`).
   *
   *  D-192 S4c2 — `connection_name` is threaded so a delta reconciler can return
   *  the REAL `fetchPage` count for the connection it just walked (the harness's
   *  `pages = ceil(processed/batch)` estimate badly undercounts a multi-page delta
   *  whose pages are mostly tombstones / unchanged rows — `processed` ≈ 0 while the
   *  fetch cost is N pages). Optional + backward-compatible: existing impls ignore
   *  the extra arg. */
  apiCallsFor?(processed: number, pages: number, connection_name?: string): number;
  /** D-184 — a reconciler's OWN per-record write, replacing the harness
   *  default (hash-diff → `refreshMetaForTarget` + warehouse `bus.emit`).
   *  Present on the engagement reconcilers (HubSpot
   *  `ingestEngagementWithEdges` / Salesforce `ingest`): they write the
   *  `engagements` table + `engagement_edges` (D-138-resolved) + dedupe
   *  candidates and fire their own internal cascade
   *  (`onEngagementChange` → `cascadeForEngagementEvent`), so the harness
   *  needs neither `hashOf` nor a warehouse event. The harness calls this
   *  per record INSTEAD of the default write when present; record
   *  reconcilers omit it and keep the default. The closure owns its store
   *  (no `HousekeepingContext` dep). */
  selfIngest?(
    connection: ConnectionRecord,
    connection_name: string,
    record: SlimRecord,
  ): void | Promise<void>;
  /** D-192 S4c2 — opt into the opaque `{ kind: 'delta', token }` cursor path
   *  for `sync_kind: 'delta_cursor'` vendors (see `DeltaCursorReconciler`).
   *  Absent ⇒ the default numeric-time cursor. Present ⇒ `selfIngest` is also
   *  present (delta reconcilers own their engagement write). */
  delta?: DeltaCursorReconciler;
}

/** D-128 — connection lookup callback. The harness calls this on
 *  every step instead of capturing a `ConnectionRecord` at
 *  construction so that auth refreshes / config edits flow through
 *  without re-registering tasks. Returning null (connection deleted
 *  or never enrolled) yields the task with `'no_work'` — re-enrolling
 *  picks the cycle back up next idle window.
 *
 *  D-129 P2 widened the return type to allow either a sync result or
 *  a Promise — the production lookup decodes the AEAD-encrypted auth
 *  ciphertext via Web Crypto, which is necessarily async; the test
 *  fixtures still return synchronously and the harness `await`s
 *  uniformly. */
export type ConnectionLookup = (
  name: string,
) => ConnectionRecord | null | Promise<ConnectionRecord | null>;

export interface BuildVendorReconciliationTaskInput {
  reconciler: VendorReconciler;
  /** User-enrolled connection name this task drives. Each connection
   *  gets its own task; the reconciler is shared across tasks of the
   *  same vendor + entity. */
  connection_name: string;
  lookupConnection: ConnectionLookup;
  /** Optional override of the per-step record limit. Tests pass small
   *  values to force budget-yield behaviour. Defaults to
   *  `PLATFORM_REFERENCE_BATCH_SIZE`. */
  batch_size?: number;
}

// ────────────────────────────────────────────────────────────────
// Task id helpers
// ────────────────────────────────────────────────────────────────

/** D-128 — task-id convention for reconciliation tasks. Used as the
 *  `housekeeping_state.task_id` primary key + the registration key.
 *  Fully qualified per-connection so multiple connections of the
 *  same vendor (e.g. `acme-hubspot` and `personal-hubspot`) get
 *  independent cursors. */
export const reconciliationTaskId = (
  vendor: string,
  entity: string,
  connection_name: string,
): string => `reconciliation.${vendor}.${entity}.${connection_name}`;

// ────────────────────────────────────────────────────────────────
// Harness
// ────────────────────────────────────────────────────────────────

/** D-128 — wrap a vendor reconciler into a `HousekeepingTaskInstance`.
 *  The instance is registered with the housekeeping registry by the
 *  vendor D's enrollment path (e.g. `connection.upsert` for a HubSpot
 *  connection registers tasks for `(hubspot, deal)`, `(hubspot,
 *  contact)`, …). D-128 P2 ships zero registrations — vendor Ds
 *  populate at boot. */
export const buildVendorReconciliationTask = (
  input: BuildVendorReconciliationTaskInput,
): HousekeepingTaskInstance => {
  const { reconciler, connection_name, lookupConnection } = input;
  const batch_size = input.batch_size ?? PLATFORM_REFERENCE_BATCH_SIZE;
  // D-184 — a reconciler drives EITHER its own write (`selfIngest`) or the
  // harness default (hash-diff via `hashOf` + `toMeta`). Assert one of the two
  // at construction so the step loop's `hashOf!`/`toMeta!` in the default branch
  // is sound (a misconfigured reconciler fails loudly at boot, not mid-cycle).
  if (
    reconciler.selfIngest === undefined
    && (reconciler.hashOf === undefined || reconciler.toMeta === undefined)
  ) {
    throw new Error(
      `buildVendorReconciliationTask: reconciler '${reconciler.vendor}.${reconciler.entity}' must ` +
        'provide either selfIngest or both hashOf + toMeta',
    );
  }
  const scope: EnrichmentScope = composeVendorEntityScope(
    reconciler.vendor,
    reconciler.entity,
  );
  const taskId = reconciliationTaskId(
    reconciler.vendor,
    reconciler.entity,
    connection_name,
  );

  const meta: HousekeepingTaskMeta = {
    id: taskId,
    description: `Reconcile ${reconciler.vendor} ${reconciler.entity} records under '${connection_name}'`,
    interruptible: true,
    kind: 'core',
    // Reconciliation is deterministic — no AI cost. The scheduler
    // treats the task as idle-eligible by default; per-connection
    // cadence override lives on `housekeeping_config` future work.
    idle_eligible: true,
  };

  return {
    meta,
    async step(
      ctx: HousekeepingContext,
      cursor: HousekeepingCursor,
      budget_ms: number,
    ): Promise<HousekeepingStepResult> {
      const startedAt = ctx.now();
      const cursorMs = cursor.kind === 'time' ? cursor.last_seen_at : 0;
      // D-192 S4c2 — delta-cursor path. A `delta` reconciler persists an opaque
      // token instead of numeric time; `priorToken` is the last terminal
      // watermark (`''` cold). `holdCursor` is the cursor returned on any
      // partial/hold outcome (no_work / busy / budget yield): a delta walk holds
      // the prior token (never advance a cursor a partial walk can't finish — the
      // `shapeDeltaOutcome` undrained rule), the numeric path holds `seen`.
      const isDelta = reconciler.delta !== undefined;
      const priorToken = cursor.kind === 'delta' ? cursor.token : '';
      const holdCursor = (seen: number): HousekeepingCursor =>
        isDelta ? { kind: 'delta', token: priorToken } : { kind: 'time', last_seen_at: seen };

      const conn = await lookupConnection(connection_name);
      if (conn === null) {
        // Connection unenrolled or never present. Hold cursor; the
        // task sits dormant until the user re-enrolls.
        return {
          status: 'yield',
          reason: 'no_work',
          cursor: holdCursor(cursorMs),
        };
      }

      // D-184 — claim the shared per-(connection, vendor) rate slot + budget.
      // A missing gate or a non-budgeted vendor ⇒ ungated (null lease). 'busy'
      // (another pull in flight for this connection) / 'suspended' (daily budget
      // spent) ⇒ yield WITHOUT pulling; else a lease whose API usage we record +
      // release in `finally` (so a throw mid-walk still frees the slot).
      const gate = ctx.rateGate;
      const vendor = reconciler.vendor;
      let lease: RateGateLease | null = null;
      // D-192 — the shared rate slot/budget applies to any vendor that declares
      // engagement entities (registry predicate over the live merged registry
      // `ctx` already carries), not the retired closed `hubspot`/`salesforce`
      // union — so a pack-declared engagement CRM is rate-governed with no edit.
      if (gate && vendorHasEngagement(vendor, ctx.resolveVendorRegistry?.() ?? CONNECTION_VENDOR_ENTITIES)) {
        const verdict = gate.acquire({ connection_id: connection_name, vendor, now: ctx.now() });
        if (verdict === 'busy' || verdict === 'suspended') {
          return {
            status: 'yield',
            reason: verdict === 'busy' ? 'vendor_pull_in_flight' : 'vendor_budget_suspended',
            cursor: holdCursor(cursorMs),
          };
        }
        lease = verdict;
      }

      // D-192 S4c2 — hand the reconciler its prior delta start-ref (`''` cold)
      // before it walks. It stashes the ref per connection + drains from it in
      // `listUpdatedSince` (ignoring the numeric `cursorMs` arg). Numeric-time
      // reconcilers omit `delta` and read `cursorMs` directly.
      if (reconciler.delta) reconciler.delta.loadStartRef(connection_name, priorToken);

      let maxSeen = cursorMs;
      let processed = 0;
      let yieldedForBudget = false;

      try {
      // ── Updates ─────────────────────────────────────────────────
      for await (const slim of reconciler.listUpdatedSince(conn, cursorMs, batch_size)) {
        // D-192 S4c2 — a delta reconciler drains its whole feed atomically before
        // yielding the first record + only advances its opaque token on a FULL
        // ingest (a partial ingest can't persist a mid-walk delta position). So a
        // mid-ingest budget yield would abandon the already-fetched drain AND hold
        // the prior token → the next cycle re-drains the same feed → NO progress =
        // a wedge if one drain consistently outlasts the budget (a large cold-start
        // backfill). Skip the yield for delta: ingest the drained rows to completion
        // (cheap local writes; the expensive fetch already happened), then advance.
        // The numeric-time path is unchanged — it makes partial progress via
        // `maxSeen`, so its cooperative yield still stands.
        if (!isDelta && ctx.now() - startedAt >= budget_ms) {
          yieldedForBudget = true;
          break;
        }
        if (reconciler.selfIngest) {
          // D-184 — engagement reconcilers own their write (the `engagements`
          // table + `engagement_edges` + dedupe candidates) and fire their own
          // internal cascade (`onEngagementChange`), so the harness's hash-diff +
          // warehouse `bus.emit` are replaced by the reconciler's per-record
          // ingest. No `hashOf`/`toMeta` and no warehouse event here.
          await reconciler.selfIngest(conn, connection_name, slim);
        } else {
        // Default write — `hashOf`/`toMeta` are present by the construction
        // invariant (a reconciler without `selfIngest` carries both).
        const newHash = reconciler.hashOf!(slim);
        const newMeta = reconciler.toMeta!(slim);
        // D-190 — mirror EVERY record UNCONDITIONALLY: independent of the
        // hash-diff branch below AND of whether any AI producer wrote an
        // enrichment row. `deal.search` reads this dedicated store, so
        // completeness can't hinge on the producer-gated enrichment path
        // (`refreshMetaForTarget` is a no-op on first sighting, so un-enriched
        // records would otherwise never become listable). Idempotent — the
        // upsert preserves `created_at` on conflict. Skips when no mirror is
        // wired (dbless harnesses / non-CRM reconcilers / tests).
        ctx.crmRecordMirror?.upsert({ scope, target_id: slim.id, meta: newMeta, now: ctx.now() });
        const existing = ctx.enrichmentStore.listByTarget(scope, slim.id, { limit: 1 });
        const prevMeta = pickSnapshotMeta(existing);
        const oldHash = prevMeta?.snapshot_hash ?? null;

        if (oldHash !== newHash) {
          // Refresh meta on every existing row first so subscribers
          // reading meta on `'updated'` events see the new values.
          // No-op when no rows exist (first sighting); the upsert path
          // for the producer's first write picks up new meta directly
          // when D-129 producers land.
          if (existing.length > 0) {
            ctx.enrichmentStore.refreshMetaForTarget(scope, slim.id, newMeta);
          }
          ctx.bus.emit({
            platform: scope,
            slug: connection_name,
            entity_type: reconciler.entity,
            event_kind: existing.length > 0 ? 'updated' : 'created',
            record_id: slim.id,
            at: ctx.now(),
            ...buildFatEventFields(newMeta, existing.length > 0 ? prevMeta : null),
          });
        }
        }

        if (slim.modified_at > maxSeen) maxSeen = slim.modified_at;
        processed += 1;
      }

      if (yieldedForBudget) {
        return {
          status: 'yield',
          reason: 'budget_exhausted',
          cursor: holdCursor(maxSeen),
        };
      }

      // ── Deletions ───────────────────────────────────────────────
      if (reconciler.listDeletedSince) {
        for await (const targetId of reconciler.listDeletedSince(conn, cursorMs)) {
          if (ctx.now() - startedAt >= budget_ms) {
            return {
              status: 'yield',
              reason: 'budget_exhausted',
              cursor: holdCursor(maxSeen),
            };
          }
          const deletedMeta = pickSnapshotMeta(
            ctx.enrichmentStore.listByTarget(scope, targetId, { limit: 1 }),
          );
          // D-190 — drop the record's mirror row on delete (delete-cascade), so
          // `deal.search` stops surfacing a record the vendor removed.
          ctx.crmRecordMirror?.deleteForSource(scope, targetId);
          ctx.bus.emit({
            platform: scope,
            slug: connection_name,
            entity_type: reconciler.entity,
            event_kind: 'deleted',
            record_id: targetId,
            at: ctx.now(),
            // Last known canonical snapshot — the D-124 `prev` convention
            // for deletes (no current state to carry as `record`).
            ...(deletedMeta !== null ? { prev: metaToEventRecord(deletedMeta) } : {}),
          });
        }
      }

      // D-192 S4c2 — a delta walk persists its NEW terminal watermark; a null
      // watermark (undrained final page / no walk) holds the prior token so the
      // next cycle re-walks from the same ref. `takeWatermark` clears the stash.
      if (reconciler.delta) {
        const watermark = reconciler.delta.takeWatermark(connection_name);
        return {
          status: 'complete',
          cursor: { kind: 'delta', token: watermark ?? priorToken },
        };
      }
      return {
        status: 'complete',
        cursor: { kind: 'time', last_seen_at: maxSeen },
      };
      } finally {
        if (lease) {
          // api_calls ≈ pages fetched (≥1, since a pull ran). The per-vendor
          // `apiCallsFor` override maps it: HubSpot engagement reconcilers make
          // a per-record associations GET so they add `processed` (→ pages +
          // processed); record reconcilers AND Salesforce engagement reconcilers
          // (single SOQL round trip per page) keep the default 1 call/page.
          const pages = Math.max(1, Math.ceil(processed / batch_size));
          const api_calls = reconciler.apiCallsFor?.(processed, pages, connection_name) ?? pages;
          lease.record({ api_calls, entity: reconciler.entity, pages, now: ctx.now() });
          lease.release();
        }
      }
    },
  };
};

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

/** Pick the freshest stamped meta snapshot from a row list, or null
 *  when no rows exist / no row carries meta yet (pre-reconciler row
 *  written by a producer that didn't go through this harness). The
 *  selection rule mirrors what the old `pickSnapshotHash` compared, so
 *  the `prev` a fat event carries is always the snapshot whose hash
 *  the skip-rule actually diffed against. Shared with the webhook
 *  funnel (same hash-diff + emit pipeline). */
export const pickSnapshotMeta = (
  rows: ReadonlyArray<{ meta: EnrichmentMeta | null }>,
): EnrichmentMeta | null => {
  for (const row of rows) {
    const meta = row.meta;
    if (meta && typeof meta.snapshot_hash === 'string' && meta.snapshot_hash.length > 0) {
      return meta;
    }
  }
  return null;
};

/** Reconciler fat-event payload — the meta snapshot minus its two
 *  stamping fields. Meta keys ARE the canonical projection vocabulary
 *  (`CONNECTION_VENDOR_ENTITIES.meta_fields` keys: `name` / `stage` /
 *  `amount` / `key_dates.close_date` / …), so a sugar `fields` /
 *  `where` dispatch filter authored against `record.<k>` matches
 *  reconciler-sourced events exactly as it matches poll-sourced ones.
 *
 *  KNOWN DIVERGENCE — `id`: the registry declares an `id` meta_field
 *  (poll projections carry it) but no `project*Meta()` writes it, so
 *  reconciler-fat records have no `record.id` key (missing-path → the
 *  filter PASSES, today's behavior). Deliberately NOT injected here:
 *  the two sources also disagree on id FORM (poll = unprefixed vendor
 *  id, reconciler `record_id` = prefixed full target id), so a blind
 *  inject would create a value mismatch worse than the absence. Sugar
 *  `where: {id}` compiles to `record_id` (never `record.id`), so the
 *  registered authoring path is unaffected. Unifying the cross-source
 *  id story is its own follow-on decision. */
export const metaToEventRecord = (meta: EnrichmentMeta): Record<string, unknown> => {
  const { snapshot_at: _at, snapshot_hash: _hash, ...fields } = meta;
  return fields;
};

/** Build the fat `record` / `prev` / `changed_fields` slice for a
 *  reconciler-pipeline `created` / `updated` emit. Mirrors the
 *  poll-manager's conventions: `record` on created + updated; `prev` +
 *  `changed_fields` (dotted leaf paths via `diffChangedFields`) on
 *  updated only — and only when the prior snapshot actually carried
 *  meta (rows written by a producer outside this harness have none;
 *  the event then degrades to record-only, never a fabricated prev). */
export const buildFatEventFields = (
  newMeta: EnrichmentMeta,
  prevMeta: EnrichmentMeta | null,
): { record: Record<string, unknown>; prev?: Record<string, unknown>; changed_fields?: string[] } => {
  const record = metaToEventRecord(newMeta);
  if (prevMeta === null) return { record };
  const prev = metaToEventRecord(prevMeta);
  return { record, prev, changed_fields: diffChangedFields(prev, record) };
};

/** D-128 — exposed for unit tests + the future P5 Memory tab
 *  integration that wants to read meta directly from a row payload
 *  loaded out of band. Wraps `deserializeEnrichmentMeta` so callers
 *  outside the store layer don't reach into contracts internals. */
export const readMetaFromRow = (raw: string | null): EnrichmentMeta | null =>
  deserializeEnrichmentMeta(raw);

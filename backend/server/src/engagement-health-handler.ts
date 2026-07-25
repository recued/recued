/** D-139 Phase 2 — engagement health rpc handlers.
 *
 *  Two methods drive Settings → Connections → HubSpot / Salesforce
 *  per-entity health surface + Salesforce capability re-probe button:
 *
 *    `collection.connection.engagementHealth` — read per-entity
 *      health for one connection. Reads:
 *        - `housekeeping_state.reconciliation.<vendor>.<entity>.<conn>`
 *          (cycle row — D-128 substrate; D-184 folded engagement onto
 *          this same cycle, so it's the sole telemetry row now)
 *        - `EngagementRateControlStore.readUsage(connection_id, vendor)`
 *          (per-(connection, vendor) daily budget — D-139 P1a.2)
 *        - `EngagementCapabilityStore.listByConnection(connection_id)`
 *          (Salesforce only — describeSObjects() probe output)
 *
 *    `collection.connection.reprobeEngagementCapabilities` —
 *      Salesforce only. Re-runs `describeSObjects()` + per-channel
 *      CDC + PushTopic streamability probes (Pass-5 R5.10) +
 *      dual-schema VoiceCall vs CallHistory pick (Pass-5 R5.11);
 *      persists results via `EngagementCapabilityStore.upsert`;
 *      auto-creates PushTopics for newly-streamable objects via
 *      `pushtopic-soap.ts:ensureEngagementPushTopics`; returns the
 *      fresh capability list + `call_entity_changed` flag so the
 *      UI can surface "Switched to <entity>" toast.
 *
 *  Spec: `docs/d-139-spec.md` § A.8 + § P2. */

import {
  RpcError,
  CONNECTION_VENDOR_ENTITIES,
  engagementSyncKind,
  vendorHasEngagement,
  SALESFORCE_RELATIONSHIP_ENTITY_NAMES,
  SALESFORCE_ENGAGEMENT_PUSHTOPIC_NAMES,
  type ConnectionVendorEntity,
  type EngagementVendor,
  type EngagementHealthRequest,
  type EngagementHealthResponse,
  type EngagementHealthRow,
  type EngagementRelationshipCapability,
  type ReprobeEngagementCapabilitiesRequest,
  type ReprobeEngagementCapabilitiesResponse,
  type RateControlStateValue,
  type EngagementCapabilityFlags,
  type ConnectionRecord,
  type ConnectionAuth,
  type HandlerSlice,
  type ServerRpcRegistry,
} from '@recued/contracts';
import type { WsClient } from './ws-server.js';
import type { ConnectionStoreSqlite } from './storage/connection-store.js';
import type { HousekeepingStateStore } from './housekeeping/state-store.js';
import type { EngagementRateControlStore } from './storage/engagement-rate-control-store.js';
import type { EngagementCapabilityStore } from './storage/engagement-capability-store.js';
import {
  reconciliationTaskId,
  type ConnectionLookup,
} from './housekeeping/reconciliation/vendor-reconciler.js';
import {
  probeSalesforceEngagementCapabilities,
  probeOutcomeToCapabilityFlags,
} from './data/salesforce/describe-probe.js';
import { ensureEngagementPushTopics } from './data/salesforce/pushtopic-soap.js';
import { deriveRateControlState } from './storage/engagement-rate-control-store.js';

// ────────────────────────────────────────────────────────────────
// Deps
// ────────────────────────────────────────────────────────────────

export interface EngagementHealthDeps {
  connectionStore: ConnectionStoreSqlite;
  housekeepingState: HousekeepingStateStore;
  rateControlStore: EngagementRateControlStore;
  capabilityStore: EngagementCapabilityStore;
  /** Vendor-agnostic api-connection lookup. The same helper the
   *  vendor reconcilers use — decodes auth + parses config. Required
   *  for the Salesforce re-probe handler (the probe needs a fully-
   *  hydrated `ConnectionRecord`). */
  lookupConnection: ConnectionLookup;
  /** Auth refresh — fired on 401 from any probe leg. Same
   *  single-flight wrapper the existing CRM-trio + engagement
   *  reconcilers share. Required for re-probe. */
  refreshAuth: (connection: ConnectionRecord) => Promise<ConnectionAuth>;
  /** Injectable clock — defaults to `Date.now`. */
  now?: () => number;
  /** Injectable fetcher — defaults to `globalThis.fetch`. Tests
   *  inject mock fetchers for the Salesforce describe + PushTopic
   *  paths. */
  fetcher?: typeof fetch;
  /** D-184 — register / swap the Salesforce call-entity (voice_call OR
   *  call_history) HOUSEKEEPING task for the reprobed connection after a
   *  successful re-probe persists `winning_call_entity`. Without this
   *  hook the health surface can advertise a call entity that has no
   *  reconciliation task, so its row never gets a `last_pulled_at`. The
   *  hook is invoked once per successful re-probe with the new winner;
   *  the implementation (Salesforce boot) builds the matching reconciler
   *  + registers its `buildVendorReconciliationTask` for the connection
   *  (and unregisters the loser's task, if any). Optional — db-less /
   *  harness paths skip cleanly. (Replaces the pre-D-184 runonce-runner
   *  registration; the reconciler-runonce stopgap is retired.) */
  registerSalesforceCallEntity?: (input: {
    connection: ConnectionRecord;
    winner: 'voice_call' | 'call_history' | null;
    prior: 'voice_call' | 'call_history' | null;
  }) => Promise<void> | void;
  /** D-192 — the live merged vendor-entity registry accessor. Drives the
   *  registry-facet-based health surface: which vendors carry engagement
   *  (`vendorHasEngagement`), which entities to surface (the `engagement` facet's
   *  capability / exclusive_group), and which are streaming (`engagementSyncKind
   *  === 'stream'`, gating the capability column + relationship panel + re-probe).
   *  Replaces the retired `hubspot`/`salesforce` literals so a pack-declared
   *  engagement CRM's health surface works with no code edit. Omit → shipped
   *  built-ins (`CONNECTION_VENDOR_ENTITIES`). */
  resolveVendorRegistry?: () => ReadonlyArray<ConnectionVendorEntity>;
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

/** Ensure the rpc args object is a record. Mirrors the pattern in
 *  `connection-handler.ts`. */
const ensureRecord = (
  where: string,
  args: unknown,
): Record<string, unknown> => {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new RpcError('bad_request', `${where}: args must be an object`);
  }
  return args as Record<string, unknown>;
};

const ensureName = (where: string, name: unknown): string => {
  if (typeof name !== 'string' || !name.trim()) {
    throw new RpcError('bad_request', `${where}: name is required`);
  }
  return name.trim();
};

/** Pull the vendor string from `connection.config.vendor`. The
 *  enrollment dialog sets this for HubSpot + Salesforce; older /
 *  unscoped api connections won't have it and the rpc rejects them
 *  with a hint pointing at re-enrollment. */
const inferVendor = (
  where: string,
  config: Record<string, unknown>,
  connectionName: string,
  registry: ReadonlyArray<ConnectionVendorEntity>,
): EngagementVendor => {
  const v = config.vendor;
  if (typeof v !== 'string' || !v.trim()) {
    throw new RpcError(
      'bad_request',
      `${where}: connection '${connectionName}' has no vendor — re-enroll via Settings → Connections → Add HubSpot / Salesforce`,
    );
  }
  // D-192 — registry predicate over the live merged registry (built-ins + packs)
  // replaces the closed `isEngagementVendor` union, so any vendor declaring
  // engagement entities has a health surface.
  if (!vendorHasEngagement(v, registry)) {
    throw new RpcError(
      'bad_request',
      `${where}: connection '${connectionName}' has no engagement surface for vendor '${v}' — engagement health is only available for vendors that declare engagement entities`,
    );
  }
  return v;
};

/** Look up a connection row + parse its config. Returns the
 *  `connection_id` (composite key `${kind}:${name}`) used as the
 *  capability-store row primary. NOTE: the rate-control store is keyed on
 *  the BARE connection name (what the rate-gate writes), so its reads pass
 *  `name` directly — see the `readUsage`/`readPages` call sites. */
const loadConnectionRow = (
  deps: EngagementHealthDeps,
  where: string,
  name: string,
  registry: ReadonlyArray<ConnectionVendorEntity>,
): {
  connection_id: string;
  config: Record<string, unknown>;
  vendor: EngagementVendor;
} => {
  const row = deps.connectionStore.get('api', name);
  if (!row) {
    throw new RpcError(
      'not_found',
      `${where}: no api connection named '${name}'`,
    );
  }
  let config: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.config_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>;
    }
  } catch {
    config = {};
  }
  const vendor = inferVendor(where, config, name, registry);
  return { connection_id: row.pk, config, vendor };
};

/** Decide which engagement entities to surface in the health response —
 *  D-192 registry-facet-driven (the Salesforce voice_call XOR call_history rule
 *  generalized to the whole engagement plane):
 *    - `capability: 'always'` entities are always surfaced (HubSpot's five;
 *      Salesforce task / event / email_message);
 *    - each probe-gated `exclusive_group` surfaces at most ONE member — the
 *      capability-`available` winner (Salesforce voice_call vs call_history per
 *      Pass-5 R5.11); before any probe lands, none of the group surfaces, so the
 *      UI never shows a row that can never have last_pulled_at;
 *    - a probe-gated singleton (no group) surfaces only when it probed available.
 *  Iterates the vendor's engagement entities in registry-declaration order, so
 *  the emitted order matches the old hardcoded lists (built-ins pinned by the
 *  D-192 S1 invariant test). A pack-declared engagement CRM surfaces with no edit. */
const surfaceEntitiesForVendor = (
  vendor: EngagementVendor,
  capabilityByEntity: ReadonlyMap<string, EngagementCapabilityFlags>,
  registry: ReadonlyArray<ConnectionVendorEntity>,
): ReadonlyArray<string> => {
  const engEntities = registry.filter(
    (e) => e.vendor === vendor && e.engagement !== undefined,
  );
  const out: string[] = [];
  const groupsResolved = new Set<string>();
  for (const e of engEntities) {
    const facet = e.engagement!;
    if (facet.capability === 'always') {
      out.push(e.entity);
      continue;
    }
    // probe_gated
    if (facet.exclusive_group !== undefined) {
      // Resolve each mutually-exclusive group once (at its first member): surface
      // the group's capability-winner in declaration order, else nothing.
      if (groupsResolved.has(facet.exclusive_group)) continue;
      groupsResolved.add(facet.exclusive_group);
      const winner = engEntities.find(
        (m) =>
          m.engagement?.exclusive_group === facet.exclusive_group &&
          capabilityByEntity.get(m.entity)?.available === true,
      );
      if (winner !== undefined) out.push(winner.entity);
      continue;
    }
    // probe_gated singleton — surface only when it probed available.
    if (capabilityByEntity.get(e.entity)?.available === true) {
      out.push(e.entity);
    }
  }
  return out;
};

/** Build one health row for `(vendor, entity)` against the deps. */
const projectHealthRow = (
  deps: EngagementHealthDeps,
  connection_id: string,
  connection_name: string,
  vendor: EngagementVendor,
  entity: string,
  rateState: RateControlStateValue,
  pages_fetched_today: number,
  api_calls_consumed_today: number,
  budget_utilization_pct: number,
  capability: EngagementCapabilityFlags | undefined,
): EngagementHealthRow => {
  // D-184 — read the single cycle reconciliation row. Engagement now
  // rides the same housekeeping cycle as the record reconcilers, so the
  // cycle row carries all the telemetry; the separate runonce-task row is
  // gone (the reconciler-runonce stopgap is retired).
  const cycleTaskId = reconciliationTaskId(vendor, entity, connection_name);
  const cycleRow = deps.housekeepingState.get(cycleTaskId);

  // last_pulled_at = the cycle row's last_run_at only when its last run
  // SUCCEEDED. Failed-run rows still carry a last_run_at, but the contract
  // says `last_pulled_at` is "most recent successful pull" (see
  // `packages/contracts/src/engagement-rpc.ts`) — surfacing a failed-run
  // timestamp would mislead the UI's "last pulled" indicator.
  const last_pulled_at =
    cycleRow?.last_status === 'complete' && cycleRow.last_run_at != null
      ? cycleRow.last_run_at
      : null;

  // last_error surfaces ONLY when the most recent run failed — so a newer
  // successful run clears a stale error.
  const last_error =
    cycleRow?.last_status === 'error' ? (cycleRow.last_error ?? null) : null;

  const row: EngagementHealthRow = {
    vendor,
    entity,
    last_pulled_at,
    last_error,
    pages_fetched_today,
    api_calls_consumed_today,
    budget_utilization_pct,
    rate_control_state: rateState,
  };
  if (capability !== undefined) {
    row.capability = capability;
  }
  return row;
};

// ────────────────────────────────────────────────────────────────
// engagementHealth handler
// ────────────────────────────────────────────────────────────────

/** Read the per-entity engagement-health surface for one connection.
 *
 *  Each row composes:
 *    - `last_pulled_at` / `last_error` from `housekeeping_state` (the
 *      cycle reconciliation row), using its last_run_at only when the
 *      run succeeded and surfacing `last_error` only when the most
 *      recent run failed.
 *    - `pages_fetched_today` from the rate-control store's per-
 *      (connection, vendor, entity) `engagement_page_counter` bucket
 *      (D-184 — populated by the reconciliation harness's rate-gate
 *      lease via `recordPages`).
 *    - `api_calls_consumed_today` + `budget_utilization_pct` +
 *      `rate_control_state` from `EngagementRateControlStore.readUsage`
 *      (per-(connection, vendor) bucket — the shared rate gate feeds it
 *      across every reconciler on the connection).
 *    - `capability` from `EngagementCapabilityStore.listByConnection`
 *      (Salesforce only — HubSpot rows omit the capability slot). */
export const handleEngagementHealth = (
  deps: EngagementHealthDeps,
  args: EngagementHealthRequest,
): EngagementHealthResponse => {
  const where = 'collection.connection.engagementHealth';
  const a = ensureRecord(where, args);
  const name = ensureName(where, a.name);
  // D-192 — live merged registry (built-ins + installed packs), read once per
  // request; drives vendor gating + entity surface + streaming gates below.
  const registry = deps.resolveVendorRegistry?.() ?? CONNECTION_VENDOR_ENTITIES;
  const { connection_id, vendor } = loadConnectionRow(deps, where, name, registry);
  const now = deps.now?.() ?? Date.now();

  // Read budget once per (connection, vendor) — same usage applies to
  // every entity on the connection (per § A.6.2 the daily bucket is
  // per-(connection, vendor), not per-(connection, vendor, entity)).
  // Keyed on the BARE connection `name`, NOT the composite `connection_id`
  // (`api:<name>`): the rate-gate WRITES budget/pages under the bare name
  // (`vendor-reconciler.ts:372` `gate.acquire({ connection_id: connection_name })`
  // → `recordUsage`/`recordPages`). Reading the composite would hit a
  // separate, always-seeded-`normal` row and never surface real throttling.
  const usage = deps.rateControlStore.readUsage({
    connection_id: name,
    vendor,
    now,
  });

  // Capability lookup — streaming vendors only (Salesforce's describeSObjects).
  // A `poll` vendor (HubSpot) carries no capability rows by construction.
  const capabilityRows = deps.capabilityStore.listByConnection(connection_id);
  const capabilityByEntity = new Map<string, EngagementCapabilityFlags>(
    capabilityRows.map((r) => [r.entity, r] as const),
  );
  const isStreaming = engagementSyncKind(vendor, registry) === 'stream';

  const entities = surfaceEntitiesForVendor(vendor, capabilityByEntity, registry);
  const rows: EngagementHealthRow[] = entities.map((entity) => {
    // Read pages_today from the rate-control store's per-(connection,
    // vendor, entity) bucket. Spec § A.6.2 carries `pages_fetched_today`
    // as a load-bearing field. D-184 — the reconciliation harness's
    // rate-gate lease bumps the counter on every cycle via `recordPages`.
    // Bare-name key (see `readUsage` above) — `recordPages` writes under it.
    const pagesUsage = deps.rateControlStore.readPages({
      connection_id: name,
      vendor,
      entity,
      now,
    });
    return projectHealthRow(
      deps,
      connection_id,
      name,
      vendor,
      entity,
      usage.rate_control_state,
      pagesUsage.pages_today,
      usage.calls_today,
      Math.min(usage.budget_utilization_pct, 1),
      // Streaming vendors (Salesforce): surface the capability row when present.
      // Poll vendors (HubSpot): undefined (no capability rows).
      isStreaming ? capabilityByEntity.get(entity) : undefined,
    );
  });

  // P2 Codex review fold #7 (P2) — surface streaming-vendor relationship-
  // object capabilities (Salesforce TaskRelation / EventRelation /
  // EmailMessageRelation) in their own response slot. The UI renders these in a
  // separate panel section so the engagement-entity table stays uncluttered. A
  // poll vendor (HubSpot) has no equivalent — empty array. D-192 — gated on the
  // streaming sync class, not the `salesforce` literal (relationship junctions +
  // CometD streaming are a streaming-vendor concern; the junction NAMES stay a
  // Salesforce leaf constant).
  const relationships: EngagementRelationshipCapability[] = [];
  if (isStreaming) {
    const rel = new Set<string>(SALESFORCE_RELATIONSHIP_ENTITY_NAMES);
    for (const cap of capabilityRows) {
      if (rel.has(cap.entity)) {
        relationships.push({
          // Relationship junctions are a Salesforce-leaf concept — the entity
          // names (`SALESFORCE_RELATIONSHIP_ENTITY_NAMES`) + the capability
          // `EngagementRelationshipCapability.vendor` type are SF-specific, so the
          // loop only matches SF connections. The panel GATE generalized to the
          // streaming class; this leaf vendor tag stays 'salesforce' until a
          // second streaming vendor with junctions forces the type open.
          vendor: 'salesforce',
          entity: cap.entity,
          capability: cap,
        });
      }
    }
    relationships.sort((a, b) => a.entity.localeCompare(b.entity));
  }

  return {
    vendor,
    rows,
    daily_budget: usage.daily_budget,
    bucket_started_at: usage.bucket_started_at,
    relationships,
  };
};

// ────────────────────────────────────────────────────────────────
// reprobeEngagementCapabilities handler
// ────────────────────────────────────────────────────────────────

/** Salesforce-only: re-run the describe + CDC + PushTopic-streamability
 *  probe trio + dual-schema pick + persist + auto-create PushTopics +
 *  re-project the per-entity health surface. The whole rpc runs serially
 *  against Salesforce — production enrollment is a one-time hit. */
export const handleReprobeEngagementCapabilities = async (
  deps: EngagementHealthDeps,
  args: ReprobeEngagementCapabilitiesRequest,
): Promise<ReprobeEngagementCapabilitiesResponse> => {
  const where = 'collection.connection.reprobeEngagementCapabilities';
  const a = ensureRecord(where, args);
  const name = ensureName(where, a.name);
  const registry = deps.resolveVendorRegistry?.() ?? CONNECTION_VENDOR_ENTITIES;
  const { connection_id, vendor } = loadConnectionRow(deps, where, name, registry);
  // D-192 — capability re-probe is a streaming-vendor concern (describeSObjects +
  // CometD PushTopic streamability). Gated on the sync class, not the `salesforce`
  // literal; a `poll` vendor (HubSpot) has no capability plane to re-probe.
  if (engagementSyncKind(vendor, registry) !== 'stream') {
    throw new RpcError(
      'bad_request',
      `${where}: capability re-probe is for streaming engagement vendors only (e.g. Salesforce) — for a poll vendor like HubSpot use 'collection.connection.probe' (auth check)`,
    );
  }
  const now = deps.now?.() ?? Date.now();

  // Compute prior winning call entity BEFORE the upsert so we can
  // detect the dual-schema pick changing across probes.
  const priorRows = deps.capabilityStore.listByConnection(connection_id);
  const priorByEntity = new Map<string, EngagementCapabilityFlags>(
    priorRows.map((r) => [r.entity, r] as const),
  );
  const priorWinner: 'voice_call' | 'call_history' | null =
    priorByEntity.get('voice_call')?.available === true
      ? 'voice_call'
      : priorByEntity.get('call_history')?.available === true
        ? 'call_history'
        : null;

  const connection = await deps.lookupConnection(name);
  if (!connection) {
    // Should have been caught by `loadConnectionRow` above; defensive.
    throw new RpcError('not_found', `${where}: connection '${name}' lookup returned null`);
  }

  const probe = await probeSalesforceEngagementCapabilities(connection, {
    refreshAuth: deps.refreshAuth,
    ...(deps.fetcher !== undefined ? { fetcher: deps.fetcher } : {}),
  });

  // P2 Codex review fold #1 (P1) — defer capability upsert until
  // AFTER `ensureEngagementPushTopics` has resolved. The probe leg
  // tells us "PushTopic Query dry-run with the canonical projection
  // succeeded" but spec § 1368-1375 says `push_topic_supported = true`
  // means the SOAP create attempt itself succeeded. If we persist the
  // probe-leg flag before SOAP create runs and then SOAP create fails,
  // the stored row contradicts the spec's invariant + downstream
  // reconciliation skips the reconciler-only fallback. Compute the
  // streamable subset from the probe outcomes, run create, merge the
  // create result into the capability flags, then persist.
  const streamableEntities = probe.outcomes
    .filter((o) => o.push_topic_streamable && o.available)
    .map((o) => o.entity);
  const pushtopic_creation: Array<{
    entity: string;
    outcome: 'created' | 'preserved' | 'create_failed';
    error?: string;
  }> = [];
  /** Per-entity create failures keyed on entity → error message. Drives
   *  the `push_topic_supported: false` + `reconciler_only: true` +
   *  `association_rescan_required: true` + `last_probe_error` patch
   *  applied to capability flags before upsert (Codex P1 #1). */
  const createFailures = new Map<string, string>();
  if (streamableEntities.length > 0) {
    try {
      const result = await ensureEngagementPushTopics(connection, streamableEntities, {
        refreshAuth: deps.refreshAuth,
        ...(deps.fetcher !== undefined ? { fetcher: deps.fetcher } : {}),
      });
      for (const created of result.created) {
        const entity = streamableEntities.find(
          (e) => e === entityFromPushTopicName(created),
        );
        if (entity !== undefined) {
          pushtopic_creation.push({ entity, outcome: 'created' });
        }
      }
      for (const existed of result.existed) {
        const entity = streamableEntities.find(
          (e) => e === entityFromPushTopicName(existed),
        );
        if (entity !== undefined) {
          pushtopic_creation.push({ entity, outcome: 'preserved' });
        }
      }
    } catch (e) {
      // Per-entity granularity isn't available from the helper's
      // throw — surface a single create_failed entry covering the
      // streamable subset + record the failure against every entity
      // in that subset so capability flags downgrade uniformly.
      const message =
        e instanceof Error ? e.message : 'pushtopic auto-creation failed';
      for (const entity of streamableEntities) {
        pushtopic_creation.push({
          entity,
          outcome: 'create_failed',
          error: message,
        });
        createFailures.set(entity, message);
      }
    }
  }

  // Now persist capability flags — with PushTopic-create failures
  // merged into the row shape. Failed-create entities downgrade to
  // `push_topic_supported: false` + `reconciler_only: true` +
  // `association_rescan_required: true` + `last_probe_error` carrying
  // the SOAP error string.
  for (const outcome of probe.outcomes) {
    const flags = probeOutcomeToCapabilityFlags({
      outcome,
      connection_id,
      last_probed_at: now,
    });
    const createErr = createFailures.get(outcome.entity);
    if (createErr !== undefined) {
      flags.push_topic_supported = false;
      flags.reconciler_only = true;
      flags.association_rescan_required = true;
      const probeErr = flags.last_probe_error;
      flags.last_probe_error =
        probeErr !== undefined && probeErr.length > 0
          ? `${probeErr}; pushtopic_create: ${createErr}`
          : `pushtopic_create: ${createErr}`;
    }
    deps.capabilityStore.upsert(flags);
  }

  const winning_call_entity = probe.winning_call_entity;
  const call_entity_changed = priorWinner !== winning_call_entity;

  // D-184 — register / swap the winning call entity's HOUSEKEEPING task
  // for this connection. Pre-D-184 this registered a runonce runner; now
  // it builds a `buildVendorReconciliationTask` so the call entity rides
  // the cycle like the other engagement entities. After re-probe surfaces
  // a winner we need a task under that key or the call row never gets a
  // `last_pulled_at`. Best-effort — db-less / harness paths leave the
  // hook undefined.
  if (deps.registerSalesforceCallEntity) {
    try {
      await deps.registerSalesforceCallEntity({
        connection,
        winner: winning_call_entity,
        prior: priorWinner,
      });
    } catch {
      // Best-effort; registration failure shouldn't fail the rpc. The
      // health surface will still surface the row; the next reprobe
      // re-attempts the task registration.
    }
  }

  // Re-project the health surface using the freshly-persisted
  // capability rows.
  const health = handleEngagementHealth(deps, { name });

  return {
    rows: health.rows,
    reprobed_at: now,
    winning_call_entity,
    call_entity_changed,
    pushtopic_creation,
  };
};

/** Map a PushTopic name back to its engagement entity. The single
 *  source of truth for the (entity → topic name) direction is
 *  `SALESFORCE_ENGAGEMENT_PUSHTOPIC_NAMES` in contracts; this is the
 *  reverse view the rpc needs to surface PushTopic create outcomes
 *  back to the UI keyed by entity. */
const entityFromPushTopicName = (
  pushTopicName: string,
): string | undefined => {
  for (const [entity, name] of Object.entries(
    SALESFORCE_ENGAGEMENT_PUSHTOPIC_NAMES,
  )) {
    if (name === pushTopicName) return entity;
  }
  return undefined;
};

// ────────────────────────────────────────────────────────────────
// Handler slice — composeHandlers factory
// ────────────────────────────────────────────────────────────────

export type EngagementHealthMethods =
  | 'collection.connection.engagementHealth'
  | 'collection.connection.reprobeEngagementCapabilities';

export const makeEngagementHealthHandlers = (
  deps: EngagementHealthDeps | undefined,
): HandlerSlice<ServerRpcRegistry, EngagementHealthMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: [
      'collection.connection.engagementHealth',
      'collection.connection.reprobeEngagementCapabilities',
    ],
    handlers: {
      'collection.connection.engagementHealth': async (args) =>
        handleEngagementHealth(
          deps,
          args as Parameters<typeof handleEngagementHealth>[1],
        ),
      'collection.connection.reprobeEngagementCapabilities': async (args) =>
        handleReprobeEngagementCapabilities(
          deps,
          args as Parameters<typeof handleReprobeEngagementCapabilities>[1],
        ),
    },
  };
};

/** Re-export so the in-process handler test fixtures don't need to
 *  pull `engagement-rate-control-store`'s helper directly. Still,
 *  using the helper keeps a single source of truth for the cadence-
 *  state derivation. */
export { deriveRateControlState };

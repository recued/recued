/** D-139 Phase 2 — Connection-page UX rpc surfaces.
 *
 *  Two new methods drive Settings → Connections → HubSpot / Salesforce
 *  per-entity health surface + Salesforce capability re-probe button:
 *
 *    `collection.connection.engagementHealth` — read per-entity
 *      health for one connection. Returns one row per engagement
 *      entity supported by the vendor (5 for HubSpot,
 *      4 for Salesforce post probe-driven dual-schema VoiceCall vs
 *      CallHistory pick + parent objects). Each row carries:
 *        - last_pulled_at (the cycle reconciliation row's last_run_at
 *          when its last run succeeded; D-184 folded engagement onto
 *          this same cycle, so it is the sole telemetry row)
 *        - last_error (last failing error string, if any)
 *        - pages_fetched_today + api_calls_consumed_today (per-vendor
 *          daily aggregates from the rate-control store; the shared
 *          rate gate feeds the counter across every reconciler on the
 *          connection per § A.6.2)
 *        - budget_utilization_pct + rate_control_state
 *          (`'normal' | 'degraded_30m' | 'degraded_1h' | 'suspended'`)
 *        - capability (Salesforce only — full
 *          `EngagementCapabilityFlags` row from the capability store)
 *
 *    `collection.connection.reprobeEngagementCapabilities` —
 *      Salesforce only. Re-runs `describeSObjects()` + per-channel
 *      CDC + PushTopic streamability probes (Pass-5 R5.10) +
 *      dual-schema VoiceCall vs CallHistory pick (Pass-5 R5.11);
 *      persists results via `EngagementCapabilityStore.upsert`;
 *      calls into PushTopic auto-creation for newly-streamable
 *      objects per `pushtopic-soap.ts:ensureEngagementPushTopics`;
 *      returns the fresh capability list + `call_entity_changed`
 *      flag so the UI can surface "Switched to <entity>" when the
 *      probe winner shifts.
 *
 *  HubSpot has no equivalent re-probe — its "capabilities" are
 *  Developer-Portal-app-scope-driven, which only changes when the
 *  user re-OAuths. Re-probing for HubSpot is the existing
 *  `collection.connection.probe` rpc (auth check) — not engagement
 *  capability.
 *
 *  The rpc layer is symmetric across HubSpot + Salesforce on the
 *  health side so the UI can render both panels through the same
 *  shape; the re-probe rpc is Salesforce-only because HubSpot
 *  doesn't carry the capability-flag substrate.
 *
 *  Spec: `docs/d-139-spec.md` § A.8 + `### P2`. */

import type { EngagementVendor } from './engagement-evidence.js';
import type { EngagementCapabilityFlags } from './engagement.js';

/** Substrate cadence given current per-connection daily usage. Same
 *  closed list as `engagement-rate-control-store.ts:RateControlState`,
 *  re-declared here so contracts doesn't depend on backend internals. */
export const RATE_CONTROL_STATE_VALUES = [
  'normal',
  'degraded_30m',
  'degraded_1h',
  'suspended',
] as const;
export type RateControlStateValue = (typeof RATE_CONTROL_STATE_VALUES)[number];
export const RATE_CONTROL_STATE_SET: ReadonlySet<string> = new Set(
  RATE_CONTROL_STATE_VALUES,
);
export const isRateControlStateValue = (
  raw: unknown,
): raw is RateControlStateValue =>
  typeof raw === 'string' && RATE_CONTROL_STATE_SET.has(raw);

/** One row in the per-entity health surface. The renderer keys rows
 *  on `(vendor, entity)`; the `connection_id` is implied by the
 *  outer request. */
export interface EngagementHealthRow {
  vendor: EngagementVendor;
  /** Engagement entity name. HubSpot: 'email' | 'meeting' | 'note' |
   *  'call' | 'task'. Salesforce: 'task' | 'event' | 'email_message' |
   *  'voice_call' | 'call_history' (whichever wins the dual-schema
   *  probe per Pass-5 R5.11; the loser is omitted from the response). */
  entity: string;
  /** Most recent successful pull timestamp — the
   *  `housekeeping_state.reconciliation.<vendor>.<entity>.<conn>` cycle
   *  row's last_run_at when its last run succeeded. `null` when the row
   *  doesn't exist yet (entity never pulled) or the last run failed. */
  last_pulled_at: number | null;
  /** Last failing error string from the most recent failed run.
   *  `null` when the most recent run succeeded OR no run has happened
   *  yet. */
  last_error: string | null;
  /** Pages-fetched-today on this `(connection, vendor)` daily bucket.
   *  The shared rate gate feeds the counter across every reconciler on
   *  the connection. `0` when the bucket is fresh / unused. */
  pages_fetched_today: number;
  /** Api-calls-consumed-today on this `(connection, vendor)` daily
   *  bucket. Sourced from the rate-control store's `BudgetUsage`. */
  api_calls_consumed_today: number;
  /** `calls_today / daily_budget` capped at `1.0`. */
  budget_utilization_pct: number;
  /** Substrate cadence given current usage. */
  rate_control_state: RateControlStateValue;
  /** Salesforce only — `EngagementCapabilityFlags` row from the
   *  capability store (`describeSObjects()` probe output). HubSpot
   *  rows omit this; HubSpot has no equivalent capability surface
   *  (its "what's available" is OAuth-scope-driven, surfaced via
   *  the existing connection-probe + token-introspect path). */
  capability?: EngagementCapabilityFlags;
}

/** Request to read the per-entity health surface for one connection. */
export interface EngagementHealthRequest {
  /** Connection name as stored on the connection-row composite key.
   *  Kind is always `'api'` for engagement-vendor connections; the
   *  rpc looks the connection up by `(kind: 'api', name)`. */
  name: string;
}

/** Per-relationship-object capability row — Salesforce only. The
 *  health-surface rpc returns these alongside the engagement-entity
 *  rows so the UI can render a separate "Relationship objects" panel
 *  per spec § A.2.1 + § P2 (TaskRelation / EventRelation /
 *  EmailMessageRelation availability). HubSpot has no equivalent. */
export interface EngagementRelationshipCapability {
  vendor: 'salesforce';
  /** Closed list per Pass-3 R3.5: 'task_relation' / 'event_relation' /
   *  'email_message_relation'. */
  entity: string;
  /** Probe outcome — `available`, `cdc_supported`,
   *  `push_topic_supported`, `last_probe_error?`. Same shape as
   *  `EngagementCapabilityFlags` but typed separately so the UI
   *  doesn't conflate the two surfaces. */
  capability: import('./engagement.js').EngagementCapabilityFlags;
}

/** Per-entity health surface response. */
export interface EngagementHealthResponse {
  /** Inferred from `connection.config.vendor` — the rpc rejects
   *  connections whose vendor isn't in `ENGAGEMENT_VENDOR_VALUES`. */
  vendor: EngagementVendor;
  /** One row per engagement entity supported by the vendor. */
  rows: ReadonlyArray<EngagementHealthRow>;
  /** Per-`(connection, vendor)` daily budget at the time of the read. */
  daily_budget: number;
  /** When the daily bucket started. Lets the UI render
   *  "resets in N hours" without a separate read. */
  bucket_started_at: number;
  /** D-139 P2 Codex review fold #7 — Salesforce-only relationship-object
   *  capability surface (TaskRelation / EventRelation /
   *  EmailMessageRelation). Empty array on HubSpot or when no probe
   *  has run. UI renders these in a separate panel section so the
   *  per-engagement-entity health table stays uncluttered. */
  relationships: ReadonlyArray<EngagementRelationshipCapability>;
}

/** Salesforce-only — re-probe request. Kicks off a fresh capability
 *  probe round and persists the result. The rpc is sync: probe legs
 *  run serially, the response carries the fresh capability list. */
export interface ReprobeEngagementCapabilitiesRequest {
  /** Salesforce connection name. The rpc rejects HubSpot connections
   *  with a hint pointing at `collection.connection.probe`. */
  name: string;
}

/** Re-probe response. The full health row list is re-projected after
 *  the capability rows are persisted so the UI can render both the
 *  capability surface AND the per-entity health surface from one
 *  round-trip. */
export interface ReprobeEngagementCapabilitiesResponse {
  rows: ReadonlyArray<EngagementHealthRow>;
  reprobed_at: number;
  /** Pass-5 R5.11 dual-schema pick — current winner. `null` when
   *  neither VoiceCall nor CallHistory is available. */
  winning_call_entity: 'voice_call' | 'call_history' | null;
  /** True when the probe winner shifted from the prior probe (e.g.
   *  org installed Service Cloud Voice since last probe). UI surfaces
   *  "Switched to <entity>" toast on true. */
  call_entity_changed: boolean;
  /** PushTopic auto-creation outcome per object newly-streamable since
   *  the prior probe. Closed list of `'created' | 'preserved' |
   *  'create_failed'` per entity. UI surfaces this so the user knows
   *  whether the PushTopic SOAP create succeeded. */
  pushtopic_creation: ReadonlyArray<{
    entity: string;
    outcome: 'created' | 'preserved' | 'create_failed';
    error?: string;
  }>;
}

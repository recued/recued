/** D-130 Phase 5 — Salesforce WebhookProcessor over CometD / PushTopic.
 *
 *  One factory + one processor instance per Sales Cloud entity
 *  (opportunity / contact / account). The processor implements the
 *  same `WebhookProcessor` interface as HubSpot's HMAC-bound v3 path,
 *  but with three substantive divergences:
 *
 *    - **No HMAC signature header.** Salesforce CometD long-poll runs
 *      over an OAuth-bound subscription; authenticity is established
 *      at the channel level (only the authenticated connection's
 *      subscriber receives events for its org), not the per-message
 *      level. The processor declares no `signature_header`, and the
 *      webhook funnel skips HMAC verification when no header is
 *      present (D-130 P5 funnel widening).
 *
 *    - **Channel-based fan-out.** The CometD dispatcher delivers every
 *      org event to every Salesforce reconciler; each entity's
 *      processor filters by the inbound `channel` field
 *      (`/topic/RecuedOpportunityFeed` / `/topic/RecuedContactFeed` /
 *      `/topic/RecuedAccountFeed`). Returning `[]` is the canonical
 *      "different entity" signal — same convention HubSpot uses for
 *      mixed-entity payloads.
 *
 *    - **Full record passthrough — no follow-up GET.** PushTopic event
 *      envelopes carry every field the PushTopic's Query declares; the
 *      Recued PushTopics request the canonical SOQL projection per
 *      entity, so the slim record materialises directly from the
 *      event's `sobject` block without a second API call. This is
 *      the substantive simplification vs HubSpot's two-phase parse-
 *      then-fetch pipeline (HubSpot webhooks ship skeletal payloads).
 *
 *  Replay defense: each event carries a monotonic `replayId` per
 *  channel + connection. The processor maintains an in-memory tracker
 *  per `(connection_name, channel)` and rejects events whose replayId
 *  is `<=` the highest already-seen value — a stale CometD reconnect
 *  with an out-of-date `replayId` won't double-emit. Tracker is
 *  per-process; the cycle catches up on cold-start gaps via cursor
 *  advance.
 *
 *  Spec: `docs/d-130-spec.md` § A.4 + § Phase 5. */

import {
  SALESFORCE_PUSHTOPIC_CHANNEL_PREFIX,
  SALESFORCE_PUSHTOPIC_NAMES,
  SALESFORCE_SOBJECT_ID_PREFIXES,
  composePlatformRecordTargetId,
  type SalesforceEntityName,
} from '@recued/contracts';

import type {
  SlimRecord,
  WebhookProcessor,
  WebhookSlimEvent,
} from '../../housekeeping/reconciliation/vendor-reconciler.js';

import type { RawSalesforceRecord } from './_salesforce-search.js';

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

/** A single CometD event envelope as Salesforce's Streaming API
 *  delivers it. PushTopic events land in this shape on
 *  `/topic/<name>` channels; the dispatcher (CometD subscriber, P5.2)
 *  forwards the raw envelope into `parseEvents` via the funnel's
 *  `payload` argument. */
export interface SalesforceCometDEvent {
  channel: string;
  data: {
    event: {
      type: 'created' | 'updated' | 'deleted' | 'undeleted';
      replayId: number;
      createdDate?: string;
    };
    sobject: RawSalesforceRecord;
  };
}

/** Two valid payload shapes the funnel might deliver into
 *  `parseEvents`:
 *
 *    1. Single envelope (`SalesforceCometDEvent`) — CometD delivers
 *       events one-at-a-time, so the in-process dispatcher will
 *       typically pass a single envelope per call.
 *    2. Batched array (`SalesforceCometDEvent[]`) — supported for
 *       buffered delivery + tests that exercise multiple events in
 *       one parse call.
 *
 *  Both flow through the same per-event routine; arrays are flattened
 *  before iteration. Other shapes return `[]` (the funnel logs +
 *  marks as failed when relevant). */
export type SalesforceCometDPayload =
  | SalesforceCometDEvent
  | ReadonlyArray<SalesforceCometDEvent>;

/** Construction options. */
export interface BuildSalesforceWebhookProcessorInput {
  /** Entity this processor covers — picks the channel filter +
   *  slim-record id prefix. */
  entity: SalesforceEntityName;
  /** Per-process replayId tracker. The boot wire creates one tracker
   *  shared across all three entity processors — same store backs
   *  both the in-process subscriber's reconnect-with-replayId resume
   *  and the parseEvents monotonicity reject. Tests pass a fresh
   *  tracker per scenario. */
  replayIdTracker: SalesforceReplayIdTracker;
}

// ────────────────────────────────────────────────────────────────
// ReplayId tracker
// ────────────────────────────────────────────────────────────────

/** Per-(connection_name, channel) monotonic replayId tracker.
 *  CometD's replayId increments monotonically per channel for the
 *  org's lifetime; the subscriber resumes from the highest-seen value
 *  on reconnect, and the processor rejects same-or-older replayIds
 *  to prevent double-emit on transient reconnect storms. */
export interface SalesforceReplayIdTracker {
  /** Returns the highest replayId observed for the given key, or
   *  `null` when no event has yet flowed through. */
  getLastReplayId(connection_name: string, channel: string): number | null;
  /** Records a replayId as seen. Idempotent — calling with a value
   *  `<=` the current highest is a no-op (the processor's
   *  monotonicity reject runs before this call, but the no-op makes
   *  the tracker trivially safe to over-call). */
  recordReplayId(connection_name: string, channel: string, replayId: number): void;
  /** Drop all replayId state for a given connection. Called on
   *  connection delete by the boot wire so the next re-enrollment
   *  starts with a clean slate (rather than rejecting events from a
   *  recreated PushTopic that may emit lower replayIds). */
  forgetConnection(connection_name: string): void;
}

/** Build an in-memory replayId tracker. The boot wire constructs one
 *  per process; tests pass a fresh instance per scenario. */
export const createInMemoryReplayIdTracker = (): SalesforceReplayIdTracker => {
  const byKey = new Map<string, number>();
  const compoundKey = (connection_name: string, channel: string): string =>
    `${connection_name}\x1f${channel}`;

  return {
    getLastReplayId(connection_name, channel) {
      const v = byKey.get(compoundKey(connection_name, channel));
      return typeof v === 'number' ? v : null;
    },
    recordReplayId(connection_name, channel, replayId) {
      const key = compoundKey(connection_name, channel);
      const cur = byKey.get(key);
      if (cur === undefined || replayId > cur) byKey.set(key, replayId);
    },
    forgetConnection(connection_name) {
      const prefix = `${connection_name}\x1f`;
      for (const k of byKey.keys()) {
        if (k.startsWith(prefix)) byKey.delete(k);
      }
    },
  };
};

// ────────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────────

/** D-130 P5 — build a Salesforce `WebhookProcessor` for a single
 *  entity. Three instances ship at boot — one per Sales Cloud entity
 *  — sharing the same replayId tracker (so reconnects resume cleanly
 *  across the trio). Channel filter + slim-record id prefix come from
 *  the entity discriminator; the rest of the parse logic is uniform.
 */
export const buildSalesforceWebhookProcessor = (
  input: BuildSalesforceWebhookProcessorInput,
): WebhookProcessor => {
  const { entity, replayIdTracker } = input;
  const channel = `${SALESFORCE_PUSHTOPIC_CHANNEL_PREFIX}${SALESFORCE_PUSHTOPIC_NAMES[entity]}`;
  const sobjectIdPrefix = SALESFORCE_SOBJECT_ID_PREFIXES[entity];

  return {
    // No `signature_header` — CometD trust boundary lives at the
    // OAuth-bound subscription, not the per-message level. The funnel
    // detects the absent header and skips HMAC verification (D-130 P5).
    deliveryId(payload) {
      // Use the highest replayId across the payload as the dedup
      // key. The funnel's body-hash fallback covers cases where
      // payload shape doesn't match (returning null defers to
      // fallback). CometD-only path → not load-bearing for the
      // funnel's dedup ring (the in-process subscriber dedups via
      // replayIdTracker before the funnel ever sees the event), but
      // having a stable id keeps the funnel well-behaved if a
      // payload is ever replayed through it manually for test or
      // recovery reasons.
      const events = flattenPayload(payload);
      if (events.length === 0) return null;
      let max = -Infinity;
      for (const e of events) {
        if (e.data.event.replayId > max) max = e.data.event.replayId;
      }
      return Number.isFinite(max) ? `salesforce:${entity}:${max}` : null;
    },
    parseEvents(payload, _headers, connection_name) {
      const events = flattenPayload(payload);
      if (events.length === 0) return [];

      const out: WebhookSlimEvent[] = [];
      for (const env of events) {
        // Channel discriminator — every entity processor sees every
        // CometD event from the dispatcher; only events on this
        // entity's PushTopic pass through.
        if (env.channel !== channel) continue;

        const replayId = env.data.event.replayId;
        const lastSeen = replayIdTracker.getLastReplayId(connection_name, channel);
        if (lastSeen !== null && replayId <= lastSeen) {
          // Same-or-older replayId — already processed (a stale
          // reconnect with an out-of-date resume cursor). Drop the
          // event silently; the dispatcher logs at the subscriber
          // level if the volume warrants attention.
          continue;
        }
        replayIdTracker.recordReplayId(connection_name, channel, replayId);

        const id = readString(env.data.sobject.Id);
        if (id === null) continue;

        // Defence-in-depth: cross-validate the SObject id prefix
        // against the channel's declared entity. Salesforce's own
        // PushTopic routing already filters per-channel, but a
        // protocol-level bug (or test fixture mismatch) surfaces
        // visibly here.
        if (!id.startsWith(sobjectIdPrefix)) continue;

        const target_id = composePlatformRecordTargetId('salesforce', entity, connection_name, id);

        switch (env.data.event.type) {
          case 'deleted': {
            out.push({ kind: 'deleted', target_id });
            break;
          }
          case 'undeleted':
          case 'created':
          case 'updated': {
            // Undeletion fires as a re-create (the org's Recycle Bin
            // restored the record + its identity carries forward) so
            // the cascade engine treats it the same as the initial
            // create — a no-op when the target_id already has an
            // enrichment row, otherwise an insertion.
            const modifiedAt = parseEventModifiedAt(env);
            if (modifiedAt === null) continue;
            const record: SlimRecord & { _raw: RawSalesforceRecord } = {
              id: target_id,
              modified_at: modifiedAt,
              _raw: env.data.sobject,
            };
            out.push({
              kind: env.data.event.type === 'updated' ? 'updated' : 'created',
              record,
            });
            break;
          }
          default: {
            // Unknown event type — skip silently. Salesforce may add
            // new event types over time; the processor is forward-
            // compatible.
            continue;
          }
        }
      }

      return out;
    },
  };
};

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

/** Coerce a payload (single envelope or batched array) into a flat
 *  array. Defensive against unexpected shapes — returns `[]` rather
 *  than throwing so the funnel can mark the call as a no-op rather
 *  than failing loudly. */
const flattenPayload = (payload: unknown): ReadonlyArray<SalesforceCometDEvent> => {
  if (Array.isArray(payload)) {
    return payload.filter(isSalesforceCometDEvent);
  }
  if (isSalesforceCometDEvent(payload)) return [payload];
  return [];
};

const isSalesforceCometDEvent = (raw: unknown): raw is SalesforceCometDEvent => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const e = raw as Record<string, unknown>;
  if (typeof e.channel !== 'string' || e.channel.length === 0) return false;
  const data = e.data;
  if (data === null || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  const event = d.event;
  if (event === null || typeof event !== 'object') return false;
  const ev = event as Record<string, unknown>;
  if (typeof ev.type !== 'string') return false;
  if (typeof ev.replayId !== 'number' || !Number.isFinite(ev.replayId)) return false;
  const sobject = d.sobject;
  if (sobject === null || typeof sobject !== 'object') return false;
  return true;
};

const readString = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0) return null;
  return raw;
};

/** Parse `modified_at` from the event envelope. Prefers the SObject's
 *  `LastModifiedDate` (always present on PushTopic Query projections
 *  for Recued's three SObjects), falls back to the event's
 *  `createdDate` (CometD-stamped wall clock when the event fired).
 *  Returns null when neither parses — caller skips the event so the
 *  cycle catches up on cursor advance. */
const parseEventModifiedAt = (env: SalesforceCometDEvent): number | null => {
  const sobjectModified = env.data.sobject.LastModifiedDate;
  if (typeof sobjectModified === 'string' && sobjectModified.length > 0) {
    const ms = Date.parse(sobjectModified);
    if (Number.isFinite(ms)) return ms;
  }
  const eventCreated = env.data.event.createdDate;
  if (typeof eventCreated === 'string' && eventCreated.length > 0) {
    const ms = Date.parse(eventCreated);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
};

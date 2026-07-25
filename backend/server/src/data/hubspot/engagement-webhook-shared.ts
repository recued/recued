/** D-139 Phase 1a.2 — shared scaffolding for HubSpot engagement
 *  webhook processors.
 *
 *  Each engagement type (email / meeting / note / call / task) ships a
 *  processor with identical structure: parse → idempotency-ledger
 *  gate → follow-up GET → emit slim event. The differences live in
 *  the subscriptionType prefix, the object type for the GET, and the
 *  property list. This module encapsulates the shared parts.
 *
 *  D-139 P1a.1.1 widens the factory with an optional
 *  `applyAssociationChange` callback that handles the edge-only write
 *  path for `<prefix>.associationChange` events per § A.4. When wired,
 *  the factory ledgers the event AFTER the edge writes succeed (per
 *  the carry-forward learning that the ledger is a "we processed this
 *  and the side-effects landed" marker, not a "we saw this" marker).
 *  When unwired, associationChange events pass through unledgered and
 *  the per-cycle association-rescan substrate (§ A.6.3) covers the
 *  case.
 *
 *  Spec: D-139 § A.3.8, § A.4, § A.6. */

import type { ConnectionRecord } from '@recued/contracts';

import type { EngagementStore } from '../../storage/engagement-store.js';
import type {
  WebhookProcessor,
  WebhookSlimEvent,
} from '../../housekeeping/reconciliation/vendor-reconciler.js';

import {
  getHubSpotObject,
  type HubSpotObjectType,
  type HubSpotSearchDeps,
  type RawHubSpotRecord,
} from './_hubspot-search.js';
import {
  parseUnixMs,
  type HubSpotEngagementEntity,
} from './engagement-shared.js';

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

export type HubSpotEngagementConnectionLookup = (
  name: string,
) => ConnectionRecord | null | Promise<ConnectionRecord | null>;

interface HubSpotEventEntry {
  subscriptionType: string;
  objectId: number;
  eventId: number;
  occurredAt?: number;
  portalId?: number;
}

const isHubSpotEventEntry = (raw: unknown): raw is HubSpotEventEntry => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    return false;
  const e = raw as Record<string, unknown>;
  return (
    typeof e.subscriptionType === 'string' &&
    typeof e.objectId === 'number' &&
    typeof e.eventId === 'number'
  );
};

const parseEventArray = (
  payload: unknown,
): ReadonlyArray<HubSpotEventEntry> => {
  if (!Array.isArray(payload)) return [];
  const out: HubSpotEventEntry[] = [];
  for (const raw of payload) {
    if (isHubSpotEventEntry(raw)) out.push(raw);
  }
  return out;
};

// ────────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────────

/** D-139 P1a.1.1 — invoked when a `<prefix>.associationChange` event
 *  arrives AND the factory has the `applyAssociationChange` callback
 *  wired. Implementations re-fetch the engagement's current
 *  associations via `fetchHubSpotEngagementAssociations`, diff against
 *  the persisted `engagement_edges`, and emit edge upserts +
 *  tombstones.
 *
 *  Returning a successful result triggers the factory to insert the
 *  ledger row AFTER the writes have landed (per the carry-forward
 *  learning). Throwing or rejecting leaves the ledger empty so
 *  HubSpot's webhook retry can re-attempt; the per-cycle association-
 *  rescan substrate provides the fallback recovery path. */
export type AssociationChangeApplier = (input: {
  connection: ConnectionRecord;
  connection_id: string;
  entity: HubSpotEngagementEntity;
  /** Substrate-shaped target id (e.g. `'hubspot_meeting_47291'`). */
  target_id: string;
  /** Raw HubSpot id without the `<vendor>_<entity>_` prefix — passed
   *  through to `fetchHubSpotEngagementAssociations`. */
  raw_id: string;
  /** Wall-clock — drives edge `created_at` + tombstone stamping. */
  now: number;
}) => Promise<AssociationChangeApplierResult>;

export interface AssociationChangeApplierResult {
  edges_created: number;
  edges_tombstoned: number;
  /** Number of vendor `/associations/` HTTP calls consumed. Counts
   *  against the per-connection daily token budget at § A.6.2. */
  api_calls_consumed: number;
  /** True when the engagement record itself returned 404 — substrate
   *  should NOT ledger the event (the engagement was likely deleted
   *  in flight; the deletion event will arrive separately). */
  source_record_missing: boolean;
  /** Codex P1 #1 fold-back — true when the applier deferred work
   *  because of rate-control suspension / per-tuple 429 backoff /
   *  similar transient unavailability. The factory MUST NOT ledger
   *  retryable deferrals — HubSpot will redeliver the webhook (it
   *  uses at-least-once semantics) and the applier will succeed on
   *  the next attempt. Distinct from `source_record_missing` (404 —
   *  no work to do) and from a thrown exception (caller decides). */
  retryable_failure: boolean;
}

export interface BuildEngagementWebhookProcessorInput {
  /** Lowercase subscription prefix — e.g. `'meeting'`, `'note'`. */
  subscriptionPrefix: 'email' | 'meeting' | 'note' | 'call' | 'task';
  /** HubSpot object type for the follow-up GET — `'meetings'` /
   *  `'notes'` / `'calls'` / `'tasks'` / `'emails'`. */
  objectType: HubSpotObjectType;
  /** Per-vendor target id prefix — `'hubspot_meeting_'` etc. */
  targetIdPrefix: string;
  /** Properties to request on the follow-up GET. */
  properties: ReadonlyArray<string>;
  /** Search helper deps. */
  search: HubSpotSearchDeps;
  /** Connection store lookup. */
  lookupConnection: HubSpotEngagementConnectionLookup;
  /** Engagement store — funnel uses `checkAndInsertInboundEvent` for
   *  ledger gating. */
  engagementStore: EngagementStore;
  /** Optional clock for `observed_at` stamping. */
  now?: () => number;
  /** D-139 P1a.1.1 — when wired, `<prefix>.associationChange` events
   *  route through this callback for the edge-only write path; the
   *  factory ledgers the event AFTER the writes succeed. When unwired,
   *  associationChange events pass through unledgered and the
   *  per-cycle association-rescan substrate (§ A.6.3) covers the
   *  case (P1a.2 default behavior). */
  applyAssociationChange?: AssociationChangeApplier;
}

/** D-139 § A.3.8 — build a vendor-specific webhook processor. The
 *  funnel calls `parseEvents` per delivery; processors of different
 *  prefixes filter so each receives only their own events.
 *
 *  associationChange events PASS THROUGH UNLEDGERED at P1a.2 — the
 *  per-cycle association-rescan substrate (§ A.6.3) handles them via
 *  the secondary sweep. Once the edge-only write path lands, the
 *  funnel can ledger associationChange separately. */
export const buildEngagementWebhookProcessor = (
  input: BuildEngagementWebhookProcessorInput,
): WebhookProcessor => {
  const nowFn = input.now ?? ((): number => Date.now());
  const prefix = input.subscriptionPrefix;
  return {
    signature_header: 'X-HubSpot-Signature-v3',
    signature_algorithm: 'sha256',
    deliveryId(payload) {
      const events = parseEventArray(payload);
      if (events.length === 0) return null;
      return `hubspot:${events[0]!.eventId}`;
    },
    async parseEvents(payload, _headers, connection_name) {
      const entries = parseEventArray(payload).filter((e) =>
        e.subscriptionType.startsWith(`${prefix}.`),
      );
      if (entries.length === 0) return [];

      let connection: ConnectionRecord | null | undefined;
      const resolveConnection = async (): Promise<ConnectionRecord | null> => {
        if (connection !== undefined) return connection;
        connection = await input.lookupConnection(connection_name);
        return connection;
      };

      const out: WebhookSlimEvent[] = [];

      for (const entry of entries) {
        const conn = await resolveConnection();
        const connectionId = connection_name;

        // D-139 P1a.1.1 — associationChange routing.
        // When `applyAssociationChange` is wired, the funnel:
        //   1. Lookups ledger first — duplicate? short-circuit.
        //   2. Calls applier; on success, ledgers AFTER the writes
        //      land (per the carry-forward learning).
        //   3. Returns no slim event for this entry (edges land via
        //      the applier; the harness has nothing to do).
        // When `applyAssociationChange` is NOT wired, associationChange
        // events pass through unledgered and the per-cycle
        // association-rescan substrate (§ A.6.3) handles them.
        if (entry.subscriptionType === `${prefix}.associationChange`) {
          if (input.applyAssociationChange === undefined) continue;
          const idempotencyKey = `${entry.eventId}-${entry.subscriptionType}`;
          const lookup = input.engagementStore.lookupInboundEvent({
            connection_id: connectionId,
            vendor: 'hubspot',
            idempotency_key: idempotencyKey,
          });
          if (lookup.exists) continue;
          if (conn === null) continue;
          const targetId = `${input.targetIdPrefix}${entry.objectId}`;
          let applierResult: AssociationChangeApplierResult;
          try {
            applierResult = await input.applyAssociationChange({
              connection: conn,
              connection_id: connectionId,
              entity: prefix,
              target_id: targetId,
              raw_id: String(entry.objectId),
              now: nowFn(),
            });
          } catch {
            // Applier threw — leave ledger empty so HubSpot's webhook
            // retry can re-attempt. The per-cycle rescan substrate
            // also catches the missing edges on its own cadence.
            continue;
          }
          if (applierResult.source_record_missing) {
            // The engagement record itself was deleted; the deletion
            // event will arrive separately. Don't ledger this
            // associationChange — the next reconciler cycle will
            // tombstone the edges via cascade.
            continue;
          }
          if (applierResult.retryable_failure) {
            // Codex P1 #1 fold-back — applier deferred (rate-control
            // suspended / 429 backoff / transient). DO NOT ledger;
            // HubSpot's at-least-once retry will redeliver and the
            // applier should succeed on the next attempt.
            continue;
          }
          // Ledger AFTER the writes have landed — per § A.3.8 + the
          // carry-forward learning. Idempotent-on-conflict so
          // concurrent retries (HubSpot's "at-least-once" delivery)
          // don't double-process.
          input.engagementStore.checkAndInsertInboundEvent({
            connection_id: connectionId,
            vendor: 'hubspot',
            idempotency_key: idempotencyKey,
            delivery_path: 'webhook',
            observed_at: nowFn(),
          });
          continue;
        }

        if (
          entry.subscriptionType !== `${prefix}.deletion` &&
          entry.subscriptionType !== `${prefix}.creation` &&
          entry.subscriptionType !== `${prefix}.propertyChange`
        ) {
          // Unknown subscription suffix — skip without ledgering.
          continue;
        }

        const ledger = input.engagementStore.checkAndInsertInboundEvent({
          connection_id: connectionId,
          vendor: 'hubspot',
          idempotency_key: `${entry.eventId}-${entry.subscriptionType}`,
          delivery_path: 'webhook',
          observed_at: nowFn(),
        });
        if (ledger.duplicate) continue;

        if (entry.subscriptionType === `${prefix}.deletion`) {
          out.push({
            kind: 'deleted',
            target_id: `${input.targetIdPrefix}${entry.objectId}`,
          });
          continue;
        }

        if (conn === null) continue;
        const raw = await getHubSpotObject(
          conn,
          input.objectType,
          String(entry.objectId),
          input.properties,
          input.search,
        );
        if (raw === null) continue;
        const modifiedAt = parseUnixMs(raw.properties.hs_lastmodifieddate);
        if (modifiedAt === null) continue;

        out.push({
          kind:
            entry.subscriptionType === `${prefix}.creation`
              ? 'created'
              : 'updated',
          record: {
            id: `${input.targetIdPrefix}${raw.id}`,
            modified_at: modifiedAt,
            _raw: raw,
          } as { id: string; modified_at: number; _raw: RawHubSpotRecord },
        });
      }

      return out;
    },
  };
};

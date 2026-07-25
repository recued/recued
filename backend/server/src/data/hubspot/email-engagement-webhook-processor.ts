/** D-139 Phase 1a.1 — HubSpot email-engagement webhook processor.
 *
 *  Sibling to `webhook-processor.ts` (deal/contact/company). The
 *  engagement processor differs in two material ways:
 *
 *    1. Idempotency ledger — every webhook delivery checks the
 *       `engagement_inbound_event_ledger` BEFORE processing. The
 *       idempotency key is `<eventId>-<subscriptionType>` per
 *       § A.3.8. Duplicate-key arrivals return a no-op WITHOUT
 *       re-firing side effects (Pass-5 R5.8 — the ledger entry is
 *       sufficient evidence that prior processing landed; no outcome
 *       cache stored).
 *    2. associationChange routing — when supported per the per-(connection,
 *       vendor, entity) capability map, `email.associationChange`
 *       events fire only the engagement-edges write path; no engagement-
 *       row meta refresh needed. P1a.1.1 wires the edge-only write
 *       path via the optional `applyAssociationChange` callback;
 *       when wired, the processor ledgers AFTER the edge writes
 *       succeed (per the carry-forward learning). When unwired,
 *       associationChange events pass through unledgered and the
 *       per-cycle association-rescan substrate (§ A.6.3) covers the
 *       case (P1a.2 default).
 *
 *  HMAC verification is shared with the deal/contact/company processors
 *  via the `WebhookProcessor.signature_header` declaration; the funnel
 *  reads the secret from the connection record's
 *  `config.webhook_secret`.
 *
 *  Spec: D-139 § A.3.8, § A.4, § A.6. */

import {
  HUBSPOT_EMAIL_PROPERTIES,
  type ConnectionRecord,
} from '@recued/contracts';

import type { EngagementStore } from '../../storage/engagement-store.js';
import type {
  WebhookProcessor,
  WebhookSlimEvent,
} from '../../housekeeping/reconciliation/vendor-reconciler.js';

import type { AssociationChangeApplier, AssociationChangeApplierResult } from './engagement-webhook-shared.js';
import {
  getHubSpotObject,
  type HubSpotSearchDeps,
  type RawHubSpotRecord,
} from './_hubspot-search.js';
import type { HubSpotEmailEngagementSlimRecord } from './email-engagement-reconciler.js';

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

export type HubSpotEngagementConnectionLookup = (
  name: string,
) => ConnectionRecord | null | Promise<ConnectionRecord | null>;

export interface BuildHubSpotEmailEngagementWebhookProcessorInput {
  search: HubSpotSearchDeps;
  lookupConnection: HubSpotEngagementConnectionLookup;
  /** Engagement store — webhook funnel uses
   *  `checkAndInsertInboundEvent` for ledger gating. */
  engagementStore: EngagementStore;
  /** Optional clock for `observed_at` stamping. Defaults to
   *  `Date.now`. */
  now?: () => number;
  /** D-139 P1a.1.1 — when wired, `email.associationChange` events
   *  route through this callback for the edge-only write path; the
   *  processor ledgers the event AFTER the writes succeed. When
   *  unwired, associationChange events pass through unledgered and
   *  the per-cycle association-rescan substrate (§ A.6.3) covers
   *  the case (P1a.2 default behavior). */
  applyAssociationChange?: AssociationChangeApplier;
}

interface HubSpotEventEntry {
  subscriptionType: string;
  objectId: number;
  eventId: number;
  occurredAt?: number;
  portalId?: number;
}

const isHubSpotEventEntry = (raw: unknown): raw is HubSpotEventEntry => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
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

export const buildHubSpotEmailEngagementWebhookProcessor = (
  input: BuildHubSpotEmailEngagementWebhookProcessorInput,
): WebhookProcessor => {
  const nowFn = input.now ?? ((): number => Date.now());
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
        e.subscriptionType.startsWith('email.'),
      );
      if (entries.length === 0) return [];

      // Resolve the connection lazily — only needed for create/update
      // follow-up GETs. The funnel passes `connection_name` per
      // delivery; the connection record carries `_id`, used as
      // `connection_id` on the ledger row.
      let connection: ConnectionRecord | null | undefined;
      const resolveConnection = async (): Promise<ConnectionRecord | null> => {
        if (connection !== undefined) return connection;
        connection = await input.lookupConnection(connection_name);
        return connection;
      };

      const out: WebhookSlimEvent[] = [];

      for (const entry of entries) {
        const conn = await resolveConnection();
        // Use the user-chosen connection name as the substrate-side
        // identifier — substrate's connection_id namespacing per
        // Pass-3 R3.2 isolates rows across multiple HubSpot portals
        // by this key; vendor + kind context is implicit at the
        // engagement-store layer.
        const connectionId = connection_name;

        // D-139 P1a.1.1 — associationChange routing. When the
        // edge-only write path is wired (`applyAssociationChange`
        // supplied), the processor:
        //   1. Pre-checks the ledger.
        //   2. Calls the applier.
        //   3. On success, inserts the ledger row AFTER the writes
        //      land (per the carry-forward learning that the ledger
        //      is a "we processed this" marker, not a "we saw this"
        //      marker).
        // When the applier is NOT wired, associationChange events
        // pass through unledgered and the per-cycle association-
        // rescan substrate (§ A.6.3) covers them (P1a.2 default).
        if (entry.subscriptionType === 'email.associationChange') {
          if (input.applyAssociationChange === undefined) continue;
          const idempotencyKey = `${entry.eventId}-${entry.subscriptionType}`;
          const lookup = input.engagementStore.lookupInboundEvent({
            connection_id: connectionId,
            vendor: 'hubspot',
            idempotency_key: idempotencyKey,
          });
          if (lookup.exists) continue;
          if (conn === null) continue;
          const targetId = `hubspot_email_${entry.objectId}`;
          let applierResult: AssociationChangeApplierResult;
          try {
            applierResult = await input.applyAssociationChange({
              connection: conn,
              connection_id: connectionId,
              entity: 'email',
              target_id: targetId,
              raw_id: String(entry.objectId),
              now: nowFn(),
            });
          } catch {
            continue;
          }
          if (applierResult.source_record_missing) continue;
          // Codex P1 #1 fold-back — applier deferred for retryable
          // reason (rate-control / 429 / transient). Don't ledger;
          // HubSpot's at-least-once retry will redeliver.
          if (applierResult.retryable_failure) continue;
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
          entry.subscriptionType !== 'email.deletion' &&
          entry.subscriptionType !== 'email.creation' &&
          entry.subscriptionType !== 'email.propertyChange'
        ) {
          // Unknown subscription suffix — skip without ledgering;
          // forward-compatible with subscription-type additions.
          continue;
        }

        // Idempotency-ledger check per § A.3.8. Only events whose
        // side-effects this pass applies get ledgered (Pass-5 R5.8).
        const ledger = input.engagementStore.checkAndInsertInboundEvent({
          connection_id: connectionId,
          vendor: 'hubspot',
          idempotency_key: `${entry.eventId}-${entry.subscriptionType}`,
          delivery_path: 'webhook',
          observed_at: nowFn(),
        });
        if (ledger.duplicate) continue;

        if (entry.subscriptionType === 'email.deletion') {
          out.push({
            kind: 'deleted',
            target_id: `hubspot_email_${entry.objectId}`,
          });
          continue;
        }

        if (conn === null) continue;
        const raw = await getHubSpotObject(
          conn,
          'emails',
          String(entry.objectId),
          HUBSPOT_EMAIL_PROPERTIES,
          input.search,
        );
        if (raw === null) continue;
        const modifiedAt = parseUnixMs(raw.properties.hs_lastmodifieddate);
        if (modifiedAt === null) continue;

        out.push({
          kind:
            entry.subscriptionType === 'email.creation' ? 'created' : 'updated',
          record: {
            id: `hubspot_email_${raw.id}`,
            modified_at: modifiedAt,
            _raw: raw,
          } as HubSpotEmailEngagementSlimRecord,
        });
      }

      return out;
    },
  };
};

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const parseUnixMs = (
  raw: string | null | undefined,
): number | null => {
  if (raw === null || raw === undefined || raw === '') return null;
  const asInt = Number(raw);
  if (Number.isFinite(asInt) && asInt > 0) return Math.trunc(asInt);
  const asDate = Date.parse(raw);
  return Number.isFinite(asDate) ? asDate : null;
};

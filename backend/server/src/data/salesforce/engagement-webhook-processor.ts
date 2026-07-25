/** D-139 Phase 1b — Salesforce engagement WebhookProcessor.
 *
 *  Mirror-shape with the D-130 P5 `webhook-processor.ts` (which
 *  covers the CRM trio: opportunity / contact / account). Engagement
 *  events ride the same CometD long-poll channel; per-entity
 *  processors filter by channel discriminator.
 *
 *  Idempotency-key derivation per § A.3.8: `<channel>:<replayId>`.
 *  Codex review fold #6 (atomic check+insert path): the processor
 *  calls `EngagementStore.checkAndInsertInboundEvent` (atomic
 *  check-and-insert) at parse time. On novel arrival the ledger row
 *  lands inside the same SQLite transaction as the duplicate-check;
 *  on duplicate, the processor returns `[]` echoing
 *  `previous_observed_at` via the in-process replayId tracker. This
 *  closes the dead-ledger bug Codex flagged (the prior P1b shape
 *  ran read-only `lookupInboundEvent` and never wrote, so the
 *  ledger stayed empty across process restarts). The TOCTOU window
 *  between parse-time ledger insert and the side-effect-applied
 *  engagement-row write is bounded by the harness's per-event
 *  dispatch latency; future widening that threads the idempotency
 *  key through the slim-event shape into the side-effect-applied
 *  path is a carry-forward (same gap exists for HubSpot's parse-
 *  time-ledger handling).
 *
 *  Spec: D-139 § A.3.8, Pass-5 R5.10. */

import {
  SALESFORCE_ENGAGEMENT_PUSHTOPIC_NAMES,
  SALESFORCE_ENGAGEMENT_SOBJECT_ID_PREFIXES,
  SALESFORCE_PUSHTOPIC_CHANNEL_PREFIX,
  type SalesforceEngagementEntityName,
  type SalesforceRelationshipEntityName,
} from '@recued/contracts';

import type { EngagementStore } from '../../storage/engagement-store.js';
import type {
  SlimRecord,
  WebhookProcessor,
  WebhookSlimEvent,
} from '../../housekeeping/reconciliation/vendor-reconciler.js';

import type {
  SalesforceCometDEvent,
  SalesforceCometDPayload,
  SalesforceReplayIdTracker,
} from './webhook-processor.js';
import type { RawSalesforceRecord } from './_salesforce-search.js';

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

export type SalesforceEngagementProcessorEntity =
  | SalesforceEngagementEntityName
  | SalesforceRelationshipEntityName;

export interface BuildSalesforceEngagementWebhookProcessorInput {
  entity: SalesforceEngagementProcessorEntity;
  replayIdTracker: SalesforceReplayIdTracker;
  /** Engagement store — used to consult the inbound-event ledger
   *  before emitting events. Idempotency-key derivation per § A.3.8. */
  engagementStore: EngagementStore;
}

// ────────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────────

export const buildSalesforceEngagementWebhookProcessor = (
  input: BuildSalesforceEngagementWebhookProcessorInput,
): WebhookProcessor => {
  const { entity, replayIdTracker, engagementStore } = input;
  const channel = `${SALESFORCE_PUSHTOPIC_CHANNEL_PREFIX}${SALESFORCE_ENGAGEMENT_PUSHTOPIC_NAMES[entity]}`;
  const sobjectIdPrefix = SALESFORCE_ENGAGEMENT_SOBJECT_ID_PREFIXES[entity];

  return {
    deliveryId(payload) {
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
        if (env.channel !== channel) continue;

        const replayId = env.data.event.replayId;
        const lastSeen = replayIdTracker.getLastReplayId(connection_name, channel);
        if (lastSeen !== null && replayId <= lastSeen) {
          // Same-or-older replayId — already processed.
          continue;
        }

        // § A.3.8 idempotency-key — `<channel>:<replayId>`. Atomic
        // check-and-insert (Codex fold #6): on novel arrival the
        // ledger row lands at parse time inside the same SQLite
        // transaction as the duplicate-check; on duplicate the call
        // is a no-op + we skip emit. The persistent ledger now
        // actually populates (the prior `lookupInboundEvent` shape
        // never wrote, so cross-process replay defense was dead).
        const idempotencyKey = `${env.channel}:${replayId}`;
        const dup = engagementStore.checkAndInsertInboundEvent({
          connection_id: connection_name,
          vendor: 'salesforce',
          idempotency_key: idempotencyKey,
          delivery_path: 'cometd',
          observed_at: Date.now(),
        });
        if (dup.duplicate) continue;

        replayIdTracker.recordReplayId(connection_name, channel, replayId);

        const id = readString(env.data.sobject.Id);
        if (id === null) continue;

        // Defence-in-depth — id-prefix must match the channel's
        // declared SObject. Salesforce's PushTopic routing already
        // filters by channel; this catches protocol-level corruption.
        if (!id.startsWith(sobjectIdPrefix)) continue;

        const target_id = `salesforce_${entity}_${id}`;

        switch (env.data.event.type) {
          case 'deleted': {
            out.push({ kind: 'deleted', target_id });
            break;
          }
          case 'undeleted':
          case 'created':
          case 'updated': {
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
          default:
            continue;
        }
      }
      return out;
    },
  };
};

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const flattenPayload = (
  payload: unknown,
): ReadonlyArray<SalesforceCometDEvent> => {
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

const parseEventModifiedAt = (env: SalesforceCometDEvent): number | null => {
  const sobjectModified = env.data.sobject.LastModifiedDate;
  if (typeof sobjectModified === 'string' && sobjectModified.length > 0) {
    const ms = Date.parse(sobjectModified);
    if (Number.isFinite(ms)) return ms;
  }
  // EmailMessageRelation uses SystemModstamp not LastModifiedDate.
  const systemModstamp = (env.data.sobject as Record<string, unknown>).SystemModstamp;
  if (typeof systemModstamp === 'string' && systemModstamp.length > 0) {
    const ms = Date.parse(systemModstamp);
    if (Number.isFinite(ms)) return ms;
  }
  const eventCreated = env.data.event.createdDate;
  if (typeof eventCreated === 'string' && eventCreated.length > 0) {
    const ms = Date.parse(eventCreated);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
};

// Re-export for callers
export type { SalesforceCometDPayload };

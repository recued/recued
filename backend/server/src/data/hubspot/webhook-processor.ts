/** D-129 Phase 5 — HubSpot WebhookProcessor.
 *
 *  One factory per entity (deal / contact / company). Each instance:
 *
 *    - Declares `X-HubSpot-Signature-v3` as the HMAC header (sha256).
 *      The funnel reads `webhook_secret` from the connection's
 *      `config.webhook_secret` and verifies against the raw body —
 *      that path is shared with every other vendor.
 *    - Extracts `eventId` from the first payload event as the
 *      `deliveryId` for the funnel's replay-defense ring (5-minute
 *      window per `PLATFORM_REFERENCE_WEBHOOK_REPLAY_WINDOW_MS`).
 *    - Filters HubSpot's mixed-entity payload by `subscriptionType`
 *      prefix matching its own `entity` segment. Returning `[]` is
 *      the canonical "different entity" signal the funnel honors.
 *    - On `*.deletion`: emits `{ kind: 'deleted', target_id }`
 *      directly — the webhook payload carries the deleted object id,
 *      no follow-up fetch needed.
 *    - On `*.creation` / `*.propertyChange`: HubSpot's webhook payload
 *      doesn't carry full record fields, so the processor follows up
 *      with a single GET via `getHubSpotObject` to materialize the
 *      slim record. The funnel's hash-diff + meta-refresh + synthetic-
 *      event-emit pipeline runs against the materialized record
 *      uniformly with the cycle path (load-bearing decision #8 in
 *      D-129).
 *
 *  The follow-up GET path makes `parseEvents` async — D-129 P5 widened
 *  `WebhookProcessor.parseEvents` to allow `Promise<...>` returns.
 *  Sync vendor processors (and the existing P3 test stubs) keep
 *  working unchanged.
 *
 *  Spec: D-129 § A.4 + § Phase 5. */

import { composePlatformRecordTargetId, type ConnectionRecord } from '@recued/contracts';

import type {
  SlimRecord,
  WebhookProcessor,
  WebhookSlimEvent,
} from '../../housekeeping/reconciliation/vendor-reconciler.js';

import {
  getHubSpotObject,
  type HubSpotObjectType,
  type HubSpotSearchDeps,
  type RawHubSpotRecord,
} from './_hubspot-search.js';

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

/** HubSpot Sales Hub entity. Used to compose `subscriptionType`
 *  filter prefixes + slim-record id prefixes + the pluralized object
 *  type segment in URLs. */
export type HubSpotEntity = 'deal' | 'contact' | 'company';

const ENTITY_OBJECT_TYPE: Record<HubSpotEntity, HubSpotObjectType> = {
  deal: 'deals',
  contact: 'contacts',
  company: 'companies',
};

/** Connection lookup the processor uses for follow-up GETs. Same
 *  shape as `ConnectionLookup` in vendor-reconciler.js — async-or-sync
 *  result. The processor caches the lookup result across events in a
 *  single delivery so a payload with N creation/propertyChange entries
 *  hits the lookup once, not N times. */
export type HubSpotConnectionLookup = (
  name: string,
) => ConnectionRecord | null | Promise<ConnectionRecord | null>;

export interface BuildHubSpotWebhookProcessorInput {
  /** Entity this processor covers — one processor per (vendor, entity). */
  entity: HubSpotEntity;
  /** Search-helper deps — fetcher, refreshAuth, etc. Same shape the
   *  reconciler uses; the boot wire shares the same `refreshHubSpotAuth`
   *  hook across reconcilers + processors. */
  search: HubSpotSearchDeps;
  /** Look up the connection record by name. The funnel passes
   *  `connection_name` per delivery; the processor resolves the
   *  connection for follow-up GETs. */
  lookupConnection: HubSpotConnectionLookup;
  /** Canonical property list to fetch on follow-up — per-entity
   *  (`HUBSPOT_DEAL_PROPERTIES` / `_CONTACT_` / `_COMPANY_`). */
  properties: ReadonlyArray<string>;
}

// ────────────────────────────────────────────────────────────────
// Webhook payload shape
// ────────────────────────────────────────────────────────────────

interface HubSpotEventEntry {
  subscriptionType: string;
  objectId: number;
  eventId: number;
  occurredAt: number;
  portalId: number;
}

const isHubSpotEventEntry = (raw: unknown): raw is HubSpotEventEntry => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const e = raw as Record<string, unknown>;
  return (
    typeof e.subscriptionType === 'string'
    && typeof e.objectId === 'number'
    && typeof e.eventId === 'number'
  );
};

/** HubSpot webhook v3 body is an array of event entries directly,
 *  e.g. `[{subscriptionType: 'deal.creation', objectId: 123, ...}, ...]`.
 *  Returns the well-formed entries; malformed entries are skipped
 *  silently so a partially-bad payload still processes the good
 *  parts. */
const parseHubSpotEventArray = (payload: unknown): ReadonlyArray<HubSpotEventEntry> => {
  if (!Array.isArray(payload)) return [];
  const out: HubSpotEventEntry[] = [];
  for (const raw of payload) {
    if (isHubSpotEventEntry(raw)) out.push(raw);
  }
  return out;
};

/** Use the first event's `eventId` as the delivery id. HubSpot stamps
 *  these per-event (not per-delivery), but the per-batch first eventId
 *  is sufficiently stable for the 5-minute replay window — same batch
 *  redelivered carries the same eventId. Returns null when payload is
 *  malformed; the funnel falls back to body-hash dedup. */
const extractDeliveryId = (payload: unknown): string | null => {
  const events = parseHubSpotEventArray(payload);
  if (events.length === 0) return null;
  return `hubspot:${events[0]!.eventId}`;
};

const isDeleteSubscription = (s: string): boolean => s.endsWith('.deletion');
const isCreateOrUpdateSubscription = (s: string): boolean =>
  s.endsWith('.creation') || s.endsWith('.propertyChange');

// ────────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────────

/** D-129 P5 — build a HubSpot `WebhookProcessor` for a single entity.
 *  All three Sales Hub reconcilers get one instance each — the
 *  signature_header / algorithm / dedup shape are identical across
 *  entities; only the entity prefix filter + slim-record id prefix +
 *  property projection differ. */
export const buildHubSpotWebhookProcessor = (
  input: BuildHubSpotWebhookProcessorInput,
): WebhookProcessor => {
  const { entity, properties } = input;
  const objectType = ENTITY_OBJECT_TYPE[entity];

  return {
    signature_header: 'X-HubSpot-Signature-v3',
    signature_algorithm: 'sha256',
    deliveryId(payload) {
      return extractDeliveryId(payload);
    },
    async parseEvents(payload, _headers, connection_name) {
      const entries = parseHubSpotEventArray(payload);
      const filtered = entries.filter((e) =>
        e.subscriptionType.startsWith(`${entity}.`),
      );
      if (filtered.length === 0) return [];

      let connection: ConnectionRecord | null | undefined;
      const out: WebhookSlimEvent[] = [];

      for (const entry of filtered) {
        if (isDeleteSubscription(entry.subscriptionType)) {
          out.push({
            kind: 'deleted',
            target_id: composePlatformRecordTargetId('hubspot', entity, connection_name, String(entry.objectId)),
          });
          continue;
        }

        if (!isCreateOrUpdateSubscription(entry.subscriptionType)) {
          // Unknown subscription suffix — skip silently. HubSpot may
          // add new subscription types over time; the processor is
          // forward-compatible.
          continue;
        }

        // Lazy-resolve connection on first creation/propertyChange.
        if (connection === undefined) {
          connection = await input.lookupConnection(connection_name);
        }
        if (connection === null) {
          // Connection unenrolled / never present; skip remaining
          // materialize calls. The next reconciliation cycle (when
          // the user re-enrolls) catches up via cursor advance.
          continue;
        }

        const raw = await getHubSpotObject(
          connection,
          objectType,
          String(entry.objectId),
          properties,
          input.search,
        );
        if (raw === null) continue; // 404 — record deleted between webhook fire + GET.

        const modifiedAt = parseUnixMs(raw.properties.hs_lastmodifieddate);
        if (modifiedAt === null) continue;

        out.push({
          kind: entry.subscriptionType.endsWith('.creation') ? 'created' : 'updated',
          // Carry _raw alongside the public SlimRecord shape so the
          // reconciler's `hashOf(record._raw)` + `toMeta(record._raw)`
          // operate identically to the cycle path. Structural typing
          // makes this transparent to the funnel.
          record: {
            id: composePlatformRecordTargetId('hubspot', entity, connection_name, String(raw.id)),
            modified_at: modifiedAt,
            _raw: raw,
          } as SlimRecord & { _raw: RawHubSpotRecord },
        });
      }

      return out;
    },
  };
};

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const parseUnixMs = (raw: string | null | undefined): number | null => {
  if (raw === null || raw === undefined || raw === '') return null;
  const asInt = Number(raw);
  if (Number.isFinite(asInt) && asInt > 0) return Math.trunc(asInt);
  const asDate = Date.parse(raw);
  return Number.isFinite(asDate) ? asDate : null;
};

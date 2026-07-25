/** D-128 Phase 3 — Webhook funnel.
 *
 *  Receives an inbound vendor webhook delivery, HMAC-verifies it
 *  against the connection's `webhook_secret`, dispatches the parsed
 *  payload across every reconciler registered for the vendor, and
 *  funnels each parsed event into the same hash-diff + meta-refresh
 *  + synthetic-warehouse-emit pipeline as the reconciliation cycle
 *  in `vendor-reconciler.ts`.
 *
 *  The cycle remains the catch-up safety net — when a vendor opts in
 *  to webhook acceleration the cycle runs at the per-vendor cadence
 *  and does no work in the steady state (cursor + hash skip-rule).
 *  When webhooks are silent (vendor outage, missed delivery), the
 *  cycle catches up on the next idle window.
 *
 *  Idempotent against replays: an in-memory dedup ring keyed on the
 *  `(connection_name, delivery_id)` pair (with a body-hash fallback
 *  when the vendor doesn't supply a delivery id) skips duplicate
 *  payloads inside `PLATFORM_REFERENCE_WEBHOOK_REPLAY_WINDOW_MS`.
 *
 *  Spec: `docs/d-128-spec.md` §A.3.1 + Phase 3. */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import {
  PLATFORM_REFERENCE_WEBHOOK_REPLAY_WINDOW_MS,
  composeVendorEntityScope,
  readConnectionInboundSecret,
  type EnrichmentScope,
} from '@recued/contracts';
import type { WarehouseEventBus } from '@recued/warehouse-events';

import type { EnrichmentStore } from '../../storage/enrichment-store.js';
import type { CrmRecordMirrorStore } from '../../storage/crm-record-mirror-store.js';
import type { ReconcilerRegistry } from './reconciler-registry.js';
import type { VendorReconciler, WebhookSlimEvent } from './vendor-reconciler.js';
import { buildFatEventFields, metaToEventRecord, pickSnapshotMeta } from './vendor-reconciler.js';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/** Parsed config callback. Returns the connection's plaintext config
 *  object (the same object `connectionViewFromRow` parses out of
 *  `config_json` before stripping inbound secrets), or null when the
 *  connection isn't enrolled. The funnel reads `webhook_secret`
 *  directly from the result via `readConnectionInboundSecret` —
 *  recipes never reach this path because the resolver projection
 *  filters those fields out. */
export type ConnectionConfigLookup = (
  vendor: string,
  connection_name: string,
) => Record<string, unknown> | null;

export interface WebhookFunnelDeps {
  /** Reconciler registry to fan out across. The funnel calls
   *  `registry.listByVendor(vendor)` for every delivery; vendors with
   *  multiple registered entities (HubSpot deal + contact + company)
   *  see the same payload land on every entity reconciler so each can
   *  filter via `WebhookProcessor.parseEvents`. */
  registry: ReconcilerRegistry;
  /** Look up the connection's parsed config object (carrying the
   *  `webhook_secret` field for HMAC verify). Wired by `bin.ts` over
   *  `ConnectionStoreSqlite.get('api', name)` + JSON.parse. Tests pass
   *  an in-memory map. */
  lookupConnectionConfig: ConnectionConfigLookup;
  /** Enrichment store for hash-diff lookups + meta refresh. Same
   *  store the reconciliation harness reads. */
  enrichmentStore: EnrichmentStore;
  /** D-190 — the dedicated CRM record mirror. The funnel upserts every
   *  create/update record into it UNCONDITIONALLY (mirroring the reconciliation
   *  cycle), so webhook-accelerated changes keep `deal.search`'s mirror fresh —
   *  Salesforce CometD is the live driver, where the cycle would otherwise lag
   *  by an idle window. Optional — absent ⇒ the funnel skips the mirror write
   *  (the catch-up cycle still mirrors on its next pass). */
  crmRecordMirror?: CrmRecordMirrorStore;
  /** Warehouse event bus — synthetic events flow through the same
   *  channel as the reconciliation cycle's emits, so the cascade
   *  engine bridge picks them up without any new wiring. */
  bus: WarehouseEventBus;
  now?: () => number;
  /** Override the default window for dedup. Tests pass small values
   *  to drive replay-then-expire scenarios. Defaults to
   *  `PLATFORM_REFERENCE_WEBHOOK_REPLAY_WINDOW_MS`. */
  replayWindowMs?: number;
  /** Optional best-effort logger — vendor parser bugs surface here.
   *  Production wires it to the daemon's structured log; tests omit. */
  log?: (level: 'warn' | 'error', msg: string, data?: unknown) => void;
  /** WatchSource governance hook — called once per warehouse-bus emit
   *  (after the emit) so the push-source registry can stamp
   *  `last_event_at` on the matching webhook row. Never throws into the
   *  funnel path by contract (wire a non-throwing closure). */
  onEmit?: (info: { vendor: string; entity: string; connection_name: string; at: number }) => void;
  /** Require per-message authentication (an HMAC `signature_header`).
   *  The PUBLIC HTTP receiver sets this: an OAuth-bound vendor
   *  (Salesforce CometD — trust lives at the subscription channel, not
   *  the message) must NOT be reachable over unauthenticated HTTP, so
   *  its no-signature path returns `webhook_not_supported` here. The
   *  in-process CometD funnel omits it (its dispatcher IS the
   *  authenticated channel). */
  requireMessageAuth?: boolean;
}

export interface WebhookFunnelInput {
  vendor: string;
  /** User-enrolled connection name. Picked off the request path
   *  (`/v1/connection/webhook/<vendor>/<connection_name>`). */
  connection_name: string;
  /** Already JSON-decoded payload. The HTTP layer parses + handles
   *  body-size + media-type concerns before calling. */
  payload: unknown;
  /** Lowercased header names → header values. The HTTP layer
   *  normalises keys via `String.prototype.toLowerCase` so vendor
   *  signature lookups don't fork on header-case quirks. */
  headers: Record<string, string>;
  /** Raw request body bytes — required for HMAC verification (the
   *  signature is computed against the bytes the vendor signed, not
   *  the JSON.parse + JSON.stringify round-trip). */
  rawBody: Buffer;
}

export type WebhookFunnelResult =
  | {
      ok: true;
      status: 202;
      processed: number;
      deduped: number;
      failed: number;
    }
  | {
      ok: false;
      status: number;
      code:
        | 'connection_not_found'
        | 'vendor_not_registered'
        | 'webhook_not_supported'
        | 'webhook_secret_missing'
        | 'signature_missing'
        | 'invalid_signature'
        | 'invalid_payload';
      message: string;
    };

/** D-129 P5 widened the return type to `Promise<WebhookFunnelResult>` —
 *  vendor processors with async `parseEvents` (e.g. HubSpot's
 *  follow-up GET on `*.creation` / `*.propertyChange`) push the
 *  funnel onto an async path. Sync vendor impls flow unchanged; the
 *  funnel always awaits internally. */
export type WebhookFunnelHandler = (input: WebhookFunnelInput) => Promise<WebhookFunnelResult>;

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Soft cap on the dedup ring size. The funnel is one process per
 *  paired server; a 2 KB-payload-per-entry budget keeps memory
 *  bounded even under sustained webhook traffic. Older entries are
 *  evicted FIFO when the cap trips — the replay-window check still
 *  protects against same-window replays in the typical case. */
export const WEBHOOK_DEDUP_RING_MAX_ENTRIES = 2048;

// ────────────────────────────────────────────────────────────────
// Dedup ring — per-process, in-memory.
// ────────────────────────────────────────────────────────────────

const createDedupRing = (
  windowMs: number,
  maxEntries: number,
): {
  has(key: string, now: number): boolean;
  add(key: string, now: number): void;
  size(): number;
} => {
  const byKey = new Map<string, number>();

  return {
    has(key, now) {
      const seen = byKey.get(key);
      if (seen === undefined) return false;
      if (now - seen > windowMs) {
        byKey.delete(key);
        return false;
      }
      return true;
    },
    add(key, now) {
      // Refresh insertion order so the FIFO eviction below picks the
      // genuinely-oldest entry on overflow.
      byKey.delete(key);
      byKey.set(key, now);
      // FIFO eviction when the soft cap trips. Map preserves
      // insertion order; the first key is always the oldest.
      while (byKey.size > maxEntries) {
        const oldest = byKey.keys().next().value;
        if (oldest === undefined) break;
        byKey.delete(oldest);
      }
    },
    size() {
      return byKey.size;
    },
  };
};

// ────────────────────────────────────────────────────────────────
// HMAC
// ────────────────────────────────────────────────────────────────

/** Constant-time-compare the provided header against the HMAC-SHA-256
 *  of the raw body. Accepts both `sha256=<hex>` (GitHub `X-Hub-Signature-256`
 *  style) and bare `<hex>` (Stripe-style). Returns false on any decode
 *  failure or length mismatch.
 *
 *  This is a GENERIC body-only-hex scheme. NOTE it is NOT HubSpot's
 *  Signature-v3 scheme — see the DOCUMENT-AND-DEFER note at the verify
 *  call site. A vendor whose real signature covers more than the body
 *  (method + uri + timestamp) needs its own verifier, not this. */
const verifyHmacSha256 = (
  secret: string,
  body: Buffer,
  provided: string,
): boolean => {
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  const clean = provided.startsWith('sha256=') ? provided.slice(7) : provided;
  if (clean.length !== expected.length) return false;
  let eBytes: Buffer;
  let cBytes: Buffer;
  try {
    eBytes = Buffer.from(expected, 'hex');
    cBytes = Buffer.from(clean, 'hex');
  } catch {
    return false;
  }
  if (eBytes.length !== cBytes.length) return false;
  return timingSafeEqual(eBytes, cBytes);
};

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const bodyHash = (body: Buffer): string =>
  `sha256:${createHash('sha256').update(body).digest('hex')}`;

const pickSignatureHeader = (
  headers: Record<string, string>,
  headerName: string,
): string | null => {
  const raw = headers[headerName.toLowerCase()];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
};

/** Pick the canonical signature header for a vendor by reading the
 *  first registered reconciler's `WebhookProcessor.signature_header`.
 *  Multiple reconcilers from the same vendor (deal + contact +
 *  company) share the same vendor-level signature scheme, so any
 *  one works. Returns null when no reconciler in the list declares a
 *  signature header — at D-130 P5 this is *also* the canonical signal
 *  for OAuth-bound vendors (Salesforce CometD subscription) where the
 *  trust boundary lives at the channel level, not the message level. */
const pickVendorSignatureHeader = (
  reconcilers: ReadonlyArray<VendorReconciler>,
): string | null => {
  for (const r of reconcilers) {
    if (r.webhookProcessor?.signature_header) {
      return r.webhookProcessor.signature_header;
    }
  }
  return null;
};

/** Detect whether a vendor's reconcilers expose any webhook processor
 *  at all. Used by the funnel to distinguish "vendor doesn't support
 *  webhooks" (return 404) from "vendor supports webhooks but uses a
 *  non-HMAC trust boundary" (skip signature verification, proceed to
 *  parseEvents). The first case is HubSpot pre-D-129 P5; the second
 *  is Salesforce on the CometD path at D-130 P5. */
const vendorHasAnyWebhookProcessor = (
  reconcilers: ReadonlyArray<VendorReconciler>,
): boolean => reconcilers.some((r) => r.webhookProcessor !== undefined);

/** Pick the first reconciler whose `WebhookProcessor.deliveryId`
 *  returns a non-null id for this payload. Falls back to a body
 *  hash when no vendor stamps a delivery id. */
const pickDeliveryId = (
  reconcilers: ReadonlyArray<VendorReconciler>,
  payload: unknown,
  headers: Record<string, string>,
  fallback: string,
): string => {
  for (const r of reconcilers) {
    const id = r.webhookProcessor?.deliveryId?.(payload, headers);
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return fallback;
};

// ────────────────────────────────────────────────────────────────
// Funnel
// ────────────────────────────────────────────────────────────────

/** D-128 P3 — build a webhook funnel handler closing over the
 *  registry + connection-config lookup + enrichment store + bus.
 *  `bin.ts` wires one funnel per process and routes the HTTP recipient
 *  endpoint at it; tests construct an isolated funnel per scenario. */
export const createWebhookFunnel = (deps: WebhookFunnelDeps): {
  handle: WebhookFunnelHandler;
  /** Test-only: peek dedup ring size. */
  dedupSize(): number;
} => {
  const now = (): number => deps.now?.() ?? Date.now();
  const windowMs = deps.replayWindowMs ?? PLATFORM_REFERENCE_WEBHOOK_REPLAY_WINDOW_MS;
  const dedup = createDedupRing(windowMs, WEBHOOK_DEDUP_RING_MAX_ENTRIES);

  const handle: WebhookFunnelHandler = async (input) => {
    const { vendor, connection_name, payload, headers, rawBody } = input;

    const config = deps.lookupConnectionConfig(vendor, connection_name);
    if (config === null) {
      return {
        ok: false,
        status: 404,
        code: 'connection_not_found',
        message: `no '${vendor}' connection enrolled under '${connection_name}'`,
      };
    }

    const reconcilers = deps.registry.listByVendor(vendor);
    if (reconcilers.length === 0) {
      return {
        ok: false,
        status: 404,
        code: 'vendor_not_registered',
        message: `no reconciler registered for vendor '${vendor}'`,
      };
    }

    const sigHeaderName = pickVendorSignatureHeader(reconcilers);

    // D-130 P5 — two valid shapes for "vendor supports webhooks":
    //
    //   1. HMAC-bound (HubSpot): one or more reconcilers declare a
    //      `signature_header`; the funnel verifies HMAC against
    //      `webhook_secret`.
    //   2. OAuth-bound (Salesforce CometD): reconcilers expose a
    //      webhook processor but no `signature_header` — the trust
    //      boundary lives at the long-poll subscription level, not
    //      the per-message level. The funnel skips HMAC verification;
    //      the dispatcher (in-process CometD subscriber) is
    //      responsible for ensuring payload authenticity.
    //
    // No webhookProcessor at all → 404 (vendor genuinely doesn't
    // support webhook acceleration).
    if (!sigHeaderName && !vendorHasAnyWebhookProcessor(reconcilers)) {
      return {
        ok: false,
        status: 404,
        code: 'webhook_not_supported',
        message: `vendor '${vendor}' has no reconciler declaring a webhook processor`,
      };
    }

    // OAuth-bound vendor on a funnel that requires per-message auth
    // (the public HTTP receiver) → 404. Shape 2 vendors are reachable
    // ONLY through their authenticated in-process channel.
    if (!sigHeaderName && deps.requireMessageAuth === true) {
      return {
        ok: false,
        status: 404,
        code: 'webhook_not_supported',
        message: `vendor '${vendor}' accepts changes over its authenticated subscription channel, not HTTP webhooks`,
      };
    }

    if (sigHeaderName !== null) {
      const secret = readConnectionInboundSecret(config, 'webhook_secret');
      if (!secret) {
        return {
          ok: false,
          status: 503,
          code: 'webhook_secret_missing',
          message: `connection '${connection_name}' is missing webhook_secret in its config — fill in Settings → Connections`,
        };
      }

      const provided = pickSignatureHeader(headers, sigHeaderName);
      if (!provided) {
        return {
          ok: false,
          status: 401,
          code: 'signature_missing',
          message: `missing ${sigHeaderName} header`,
        };
      }

      // ─── DOCUMENT-AND-DEFER: HubSpot Signature-v3 divergence ───
      // `verifyHmacSha256` is the GENERIC body-only-hex scheme. HubSpot
      // declares `signature_header: 'X-HubSpot-Signature-v3'` (see
      // `buildHubSpotWebhookProcessor`), but its real v3 contract is
      // `base64(HMAC-SHA-256(secret, requestMethod + requestUri + body +
      // timestamp))` PLUS a 5-minute `X-HubSpot-Request-Timestamp` freshness
      // window (D-129 §173-175) — NOT what this verify computes. So a genuine
      // HubSpot v3 delivery would FAIL here (and the P5 funnel test below
      // blesses only the generic body-only-hex shape, not real v3).
      //
      // Why this is safe to defer (owner-verified 2026-06-17): the HubSpot
      // receiver is WIRED (boot.ts attaches webhookProcessors to the deal/
      // contact/company reconcilers) but UNDRIVEN — nothing registers a
      // HubSpot app subscription, so HubSpot never POSTs here. The shipped
      // pack drives reads/writes over OAuth + the polling reconcile cycle;
      // the webhook path is acceleration-only and dormant. No live exploit,
      // no sync dependency.
      //
      // WHEN webhooks are productized: add a per-vendor v3 verifier (the
      // Slack/Telegram descriptor shape, NOT a funnel rewrite) that hashes
      // method+uri+body+timestamp, base64-compares, and enforces freshness;
      // register the live HubSpot subscription; update the P5 test.
      if (!verifyHmacSha256(secret, rawBody, provided)) {
        return {
          ok: false,
          status: 401,
          code: 'invalid_signature',
          message: 'HMAC signature does not match webhook_secret',
        };
      }
    }

    const tNow = now();
    const fallbackId = bodyHash(rawBody);
    const deliveryId = pickDeliveryId(reconcilers, payload, headers, fallbackId);
    const dedupKey = [connection_name, deliveryId].join(' ');
    if (dedup.has(dedupKey, tNow)) {
      return { ok: true, status: 202, processed: 0, deduped: 1, failed: 0 };
    }
    dedup.add(dedupKey, tNow);

    let processed = 0;
    let failed = 0;

    for (const reconciler of reconcilers) {
      const proc = reconciler.webhookProcessor;
      if (!proc) continue;
      // D-184 — the funnel only drives DEFAULT-WRITE reconcilers (the
      // hash-diff + plain-enrichment write below needs `hashOf` + `toMeta`).
      // A `selfIngest` engagement reconciler can't be funneled — its write
      // is the engagements table + edges + dedupe, not the enrichment path —
      // so skip it here and let the harness pull cycle own it. Defensive:
      // the SF engagement factory attaches a webhookProcessor to its
      // reconcilers, so this guard (not the "no webhookProcessor" invariant)
      // is what keeps `hashOf!`/`toMeta!` below sound. Engagement stays
      // pull-only, exactly as it was on the retired runonce path.
      if (!reconciler.hashOf || !reconciler.toMeta) continue;

      let events: ReadonlyArray<WebhookSlimEvent>;
      try {
        events = await proc.parseEvents(payload, headers, connection_name);
      } catch (e) {
        failed += 1;
        deps.log?.('warn', `parseEvents threw for ${reconciler.vendor}.${reconciler.entity}`, {
          error: e instanceof Error ? e.message : String(e),
        });
        continue;
      }
      if (events.length === 0) continue;

      const scope: EnrichmentScope = composeVendorEntityScope(
        reconciler.vendor,
        reconciler.entity,
      );

      for (const event of events) {
        try {
          if (event.kind === 'deleted') {
            const deletedMeta = pickSnapshotMeta(
              deps.enrichmentStore.listByTarget(scope, event.target_id, { limit: 1 }),
            );
            // D-190 — drop the mirror row on delete (delete-cascade), matching
            // the reconciliation cycle so deal.search stops surfacing it.
            deps.crmRecordMirror?.deleteForSource(scope, event.target_id);
            deps.bus.emit({
              platform: scope,
              slug: connection_name,
              entity_type: reconciler.entity,
              event_kind: 'deleted',
              record_id: event.target_id,
              at: tNow,
              // Last known canonical snapshot — the D-124 `prev`
              // convention for deletes.
              ...(deletedMeta !== null ? { prev: metaToEventRecord(deletedMeta) } : {}),
            });
            deps.onEmit?.({
              vendor: reconciler.vendor,
              entity: reconciler.entity,
              connection_name,
              at: tNow,
            });
            processed += 1;
            continue;
          }

          const slim = event.record;
          // D-184 — `hashOf`/`toMeta` are present here: the loop-top guard
          // skipped any `selfIngest` reconciler (which lacks both), so only
          // default-write RECORD reconcilers reach this write path.
          const newHash = reconciler.hashOf!(slim);
          const newMeta = reconciler.toMeta!(slim);
          // D-190 — mirror EVERY record UNCONDITIONALLY: independent of the
          // hash-diff skip below AND of any AI producer, mirroring the
          // reconciliation cycle so webhook-accelerated changes keep
          // deal.search's mirror fresh (Salesforce CometD is the live driver).
          // Idempotent — preserves created_at. Skips when no mirror is wired.
          deps.crmRecordMirror?.upsert({ scope, target_id: slim.id, meta: newMeta, now: tNow });
          const existing = deps.enrichmentStore.listByTarget(scope, slim.id, { limit: 1 });
          const prevMeta = pickSnapshotMeta(existing);
          const oldHash = prevMeta?.snapshot_hash ?? null;

          if (oldHash === newHash) {
            // Steady state — the record's snapshot is already current.
            // Webhook arriving on a no-op change (e.g. property the
            // vendor's webhook subscribes to but our hash doesn't track)
            // is normal traffic; counted as processed.
            processed += 1;
            continue;
          }

          if (existing.length > 0) {
            deps.enrichmentStore.refreshMetaForTarget(scope, slim.id, newMeta);
          }

          deps.bus.emit({
            platform: scope,
            slug: connection_name,
            entity_type: reconciler.entity,
            event_kind: existing.length > 0 ? 'updated' : 'created',
            record_id: slim.id,
            at: tNow,
            ...buildFatEventFields(newMeta, existing.length > 0 ? prevMeta : null),
          });
          deps.onEmit?.({
            vendor: reconciler.vendor,
            entity: reconciler.entity,
            connection_name,
            at: tNow,
          });
          processed += 1;
        } catch (e) {
          failed += 1;
          deps.log?.('warn', `event dispatch failed for ${reconciler.vendor}.${reconciler.entity}`, {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    return { ok: true, status: 202, processed, deduped: 0, failed };
  };

  return {
    handle,
    dedupSize: () => dedup.size(),
  };
};


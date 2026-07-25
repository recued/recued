/** D-128 Phase 3 — Webhook funnel + recipient endpoint tests.
 *
 *  Covers:
 *  - `WebhookProcessor` interface widening (signature_header,
 *    parseEvents, deliveryId).
 *  - `createWebhookFunnel` happy path (HMAC verify → parseEvents →
 *    hash diff → meta refresh + synthetic warehouse-event emit).
 *  - HMAC failure modes (missing header / missing secret / wrong
 *    signature / bad hex).
 *  - Dedup against `PLATFORM_REFERENCE_WEBHOOK_REPLAY_WINDOW_MS`.
 *  - Cycle-as-safety-net: cycle running after a webhook stays a
 *    no-op via the same hash-match skip rule.
 *  - `connectionViewFromRow` filters `webhook_secret` so recipes
 *    can't read it through the resolver.
 *  - HTTP recipient: path parsing, JSON gating, body cap, public-
 *    reachable gate, body-hash dedup fallback.
 *  - 404 / 503 / 401 / 400 HTTP error mappings.
 *  - Multi-reconciler vendor fan-out (one payload, two reconcilers,
 *    each filtering for its own entity). */

import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWarehouseEventBus } from '@recued/warehouse-events';
import type { WarehouseEvent } from '@recued/warehouse-events';
import {
  CONNECTION_INBOUND_SECRET_FIELDS,
  PLATFORM_REFERENCE_WEBHOOK_REPLAY_WINDOW_MS,
  composeVendorEntityScope,
  connectionViewFromRow,
  readConnectionInboundSecret,
  type ConnectionRecord,
  type ConnectionRow,
  type EnrichmentScope,
} from '@recued/contracts';

import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import {
  buildVendorReconciliationTask,
  type SlimRecord,
  type VendorReconciler,
  type WebhookProcessor,
  type WebhookSlimEvent,
} from '../housekeeping/reconciliation/vendor-reconciler.js';
import {
  createReconcilerRegistry,
  type ReconcilerRegistry,
} from '../housekeeping/reconciliation/reconciler-registry.js';
import {
  WEBHOOK_DEDUP_RING_MAX_ENTRIES,
  createWebhookFunnel,
  type ConnectionConfigLookup,
  type WebhookFunnelHandler,
} from '../housekeeping/reconciliation/webhook-funnel.js';
import { createConnectionWebhookListener } from '../connection-webhook-listener.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';

// ────────────────────────────────────────────────────────────────
// Test harness
// ────────────────────────────────────────────────────────────────

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-128-p3-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  store = createEnrichmentStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const validRollup = {
  interaction_count: 1,
  last_interaction: 1,
  recent_subjects: ['x'],
  cursor_at: 1,
  window_ms: 30 * 24 * 60 * 60 * 1000,
};

const sampleConnection = (name = 'acme-hubspot'): ConnectionRecord => ({
  name,
  kind: 'api',
  display_name: name,
  config: { base_url: 'https://api.hubapi.com', webhook_secret: 'shh' },
  auth: { type: 'bearer', token: 'pat-token' },
  enrolled_at: 1,
  updated_at: 1,
});

const makeBus = (): { bus: ReturnType<typeof createWarehouseEventBus>; events: WarehouseEvent[] } => {
  const events: WarehouseEvent[] = [];
  const bus = createWarehouseEventBus();
  bus.subscribe('**', (ev) => {
    events.push(ev);
  });
  return { bus, events };
};

interface MakeReconcilerOpts {
  vendor?: string;
  entity?: string;
  records?: ReadonlyArray<SlimRecord>;
  deletions?: ReadonlyArray<string>;
  webhookProcessor?: WebhookProcessor;
}

const makeReconciler = (opts: MakeReconcilerOpts = {}): VendorReconciler => {
  const vendor = opts.vendor ?? 'hubspot';
  const entity = opts.entity ?? 'deal';
  const records = opts.records ?? [];
  const deletions = opts.deletions ?? [];

  const recon: VendorReconciler = {
    vendor,
    entity,
    default_cadence: '6h',
    async *listUpdatedSince(_conn, cursor, _limit) {
      for (const r of records) {
        if (r.modified_at > cursor) yield r;
      }
    },
    hashOf(record) {
      return `fnv1a:${record.id}-${record.modified_at}`;
    },
    toMeta(record) {
      return {
        snapshot_at: record.modified_at,
        snapshot_hash: `fnv1a:${record.id}-${record.modified_at}`,
        name: `Record ${record.id}`,
      };
    },
  };

  if (deletions.length > 0) {
    recon.listDeletedSince = async function* (_conn, _cursor) {
      for (const id of deletions) yield id;
    };
  }
  if (opts.webhookProcessor) {
    recon.webhookProcessor = opts.webhookProcessor;
  }

  return recon;
};

const makeWebhookProcessor = (
  entity: string,
  signature_header = 'x-hubspot-signature-v3',
): WebhookProcessor => ({
  signature_header,
  signature_algorithm: 'sha256',
  parseEvents(payload, _headers) {
    if (!payload || typeof payload !== 'object' || !('events' in payload)) return [];
    const raw = (payload as { events: ReadonlyArray<Record<string, unknown>> }).events;
    const out: WebhookSlimEvent[] = [];
    for (const e of raw) {
      if (e.entity !== entity) continue;
      if (e.kind === 'deleted') {
        out.push({ kind: 'deleted', target_id: String(e.id) });
      } else if (e.kind === 'created' || e.kind === 'updated') {
        out.push({
          kind: e.kind,
          record: { id: String(e.id), modified_at: Number(e.modified_at) },
        });
      }
    }
    return out;
  },
  deliveryId(_payload, headers) {
    return headers['x-hubspot-delivery-id'] ?? null;
  },
});

const sign = (secret: string, body: Buffer): string =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

interface MakeFunnelOpts {
  registry?: ReconcilerRegistry;
  connections?: Record<string, Record<string, unknown> | null>;
  now?: () => number;
  replayWindowMs?: number;
  onEmit?: (info: { vendor: string; entity: string; connection_name: string; at: number }) => void;
  requireMessageAuth?: boolean;
}

const makeFunnel = (opts: MakeFunnelOpts = {}): {
  registry: ReconcilerRegistry;
  bus: ReturnType<typeof createWarehouseEventBus>;
  events: WarehouseEvent[];
  funnel: ReturnType<typeof createWebhookFunnel>;
  handle: WebhookFunnelHandler;
} => {
  const registry = opts.registry ?? createReconcilerRegistry();
  const { bus, events } = makeBus();
  const lookup: ConnectionConfigLookup = (vendor, name) =>
    opts.connections?.[`${vendor}/${name}`] ?? null;
  const funnel = createWebhookFunnel({
    registry,
    lookupConnectionConfig: lookup,
    enrichmentStore: store,
    bus,
    now: opts.now,
    replayWindowMs: opts.replayWindowMs,
    ...(opts.onEmit ? { onEmit: opts.onEmit } : {}),
    ...(opts.requireMessageAuth !== undefined
      ? { requireMessageAuth: opts.requireMessageAuth }
      : {}),
  });
  return { registry, bus, events, funnel, handle: funnel.handle };
};

// ────────────────────────────────────────────────────────────────
// connectionViewFromRow filtering of webhook_secret
// ────────────────────────────────────────────────────────────────

describe('D-128 P3 — connection view filters inbound secrets', async () => {
  it('strips webhook_secret from the resolver projection', async () => {
    const row: ConnectionRow = {
      pk: 'api:acme',
      kind: 'api',
      name: 'acme',
      display_name: 'Acme HubSpot',
      config_json: JSON.stringify({
        base_url: 'https://api.hubapi.com',
        webhook_secret: 'shh',
      }),
      auth_ciphertext: '',
      enrolled_at: 1,
      updated_at: 1,
    };
    const view = connectionViewFromRow(row);
    expect(view.base_url).toBe('https://api.hubapi.com');
    expect(view.webhook_secret).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain('shh');
  });

  it('readConnectionInboundSecret reads webhook_secret straight from parsed config', async () => {
    const config = { webhook_secret: 'shh', base_url: 'x' };
    expect(readConnectionInboundSecret(config, 'webhook_secret')).toBe('shh');
    expect(readConnectionInboundSecret(config, 'base_url')).toBeNull(); // not in inbound list
    expect(readConnectionInboundSecret({}, 'webhook_secret')).toBeNull();
    expect(readConnectionInboundSecret({ webhook_secret: '' }, 'webhook_secret')).toBeNull();
  });

  it('CONNECTION_INBOUND_SECRET_FIELDS includes webhook_secret', async () => {
    expect(CONNECTION_INBOUND_SECRET_FIELDS).toContain('webhook_secret');
  });
});

// ────────────────────────────────────────────────────────────────
// Funnel — happy path
// ────────────────────────────────────────────────────────────────

describe('D-128 P3 — funnel happy path', async () => {
  it('first-sighting webhook emits `created` and stores no rows (D-129+ producers fill them)', async () => {
    const recon = makeReconciler({
      webhookProcessor: makeWebhookProcessor('deal'),
    });
    const registry = createReconcilerRegistry();
    registry.register(recon);
    const { handle, events } = makeFunnel({
      registry,
      connections: { 'hubspot/acme-hubspot': sampleConnection().config },
    });

    const payload = {
      events: [{ entity: 'deal', kind: 'created', id: 'deal-1', modified_at: 100 }],
    };
    const rawBody = Buffer.from(JSON.stringify(payload));

    const result = await handle({
      vendor: 'hubspot',
      connection_name: 'acme-hubspot',
      payload,
      headers: {
        'x-hubspot-signature-v3': sign('shh', rawBody),
        'x-hubspot-delivery-id': 'delivery-001',
      },
      rawBody,
    });

    expect(result).toEqual({
      ok: true,
      status: 202,
      processed: 1,
      deduped: 0,
      failed: 0,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      platform: 'connection.api.hubspot.deal',
      slug: 'acme-hubspot',
      entity_type: 'deal',
      event_kind: 'created',
      record_id: 'deal-1',
    });
  });

  it('webhook updates against an existing row refreshes meta + emits `updated`', async () => {
    const scope: EnrichmentScope = 'connection.api.hubspot.deal';
    const target = 'deal-1';
    store.upsert({
      topic: 'contact_timeline_rollup', // borrow a real topic; harness only reads meta
      scope: 'contact',
      target_id: target,
      value: validRollup,
      authored_by: 'recipe.x',
      meta: { snapshot_at: 1, snapshot_hash: 'fnv1a:stale', name: 'old name' },
    });
    db.prepare('UPDATE data_enrichment SET scope = ? WHERE target_id = ?').run(scope, target);

    const recon = makeReconciler({
      webhookProcessor: makeWebhookProcessor('deal'),
    });
    const registry = createReconcilerRegistry();
    registry.register(recon);
    const { handle, events } = makeFunnel({
      registry,
      connections: { 'hubspot/acme': sampleConnection('acme').config },
    });

    const payload = {
      events: [{ entity: 'deal', kind: 'updated', id: target, modified_at: 9_000 }],
    };
    const rawBody = Buffer.from(JSON.stringify(payload));

    const result = await handle({
      vendor: 'hubspot',
      connection_name: 'acme',
      payload,
      headers: {
        'x-hubspot-signature-v3': sign('shh', rawBody),
        'x-hubspot-delivery-id': 'delivery-002',
      },
      rawBody,
    });

    expect(result.ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_kind).toBe('updated');

    const rows = store.listByTarget(scope, target);
    expect(rows[0]!.meta?.snapshot_hash).toBe(`fnv1a:${target}-9000`);
    expect(rows[0]!.meta?.name).toBe(`Record ${target}`);
  });

  it('webhook with same hash as existing row skips emit (no-op change)', async () => {
    const scope: EnrichmentScope = 'connection.api.hubspot.deal';
    const target = 'deal-1';
    const stableHash = 'fnv1a:deal-1-1500';
    store.upsert({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: target,
      value: validRollup,
      authored_by: 'recipe.x',
      meta: { snapshot_at: 1, snapshot_hash: stableHash, name: 'unchanged' },
    });
    db.prepare('UPDATE data_enrichment SET scope = ? WHERE target_id = ?').run(scope, target);

    const recon = makeReconciler({
      webhookProcessor: makeWebhookProcessor('deal'),
    });
    const registry = createReconcilerRegistry();
    registry.register(recon);
    const { handle, events } = makeFunnel({
      registry,
      connections: { 'hubspot/acme': sampleConnection('acme').config },
    });

    const payload = {
      events: [{ entity: 'deal', kind: 'updated', id: target, modified_at: 1_500 }],
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const result = await handle({
      vendor: 'hubspot',
      connection_name: 'acme',
      payload,
      headers: {
        'x-hubspot-signature-v3': sign('shh', rawBody),
        'x-hubspot-delivery-id': 'delivery-noop',
      },
      rawBody,
    });

    expect(result.ok).toBe(true);
    expect(events).toHaveLength(0);
    // Meta untouched.
    expect(store.listByTarget(scope, target)[0]!.meta?.name).toBe('unchanged');
  });

  it('emits `deleted` events from parseEvents straight onto the bus', async () => {
    const recon = makeReconciler({
      webhookProcessor: makeWebhookProcessor('deal'),
    });
    const registry = createReconcilerRegistry();
    registry.register(recon);
    const { handle, events } = makeFunnel({
      registry,
      connections: { 'hubspot/acme': sampleConnection('acme').config },
    });

    const payload = {
      events: [
        { entity: 'deal', kind: 'deleted', id: 'deal-x' },
        { entity: 'deal', kind: 'deleted', id: 'deal-y' },
      ],
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    await handle({
      vendor: 'hubspot',
      connection_name: 'acme',
      payload,
      headers: { 'x-hubspot-signature-v3': sign('shh', rawBody) },
      rawBody,
    });

    expect(events.map((e) => [e.event_kind, e.record_id])).toEqual([
      ['deleted', 'deal-x'],
      ['deleted', 'deal-y'],
    ]);
  });
});

// ────────────────────────────────────────────────────────────────
// Funnel — HMAC failure modes
// ────────────────────────────────────────────────────────────────

describe('D-128 P3 — HMAC verification', async () => {
  it('rejects missing signature header with 401 signature_missing', async () => {
    const recon = makeReconciler({
      webhookProcessor: makeWebhookProcessor('deal'),
    });
    const registry = createReconcilerRegistry();
    registry.register(recon);
    const { handle, events } = makeFunnel({
      registry,
      connections: { 'hubspot/acme': sampleConnection('acme').config },
    });

    const rawBody = Buffer.from('{}');
    const result = await handle({
      vendor: 'hubspot',
      connection_name: 'acme',
      payload: {},
      headers: {},
      rawBody,
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 401, code: 'signature_missing' });
    expect(events).toHaveLength(0);
  });

  it('rejects wrong signature with 401 invalid_signature', async () => {
    const recon = makeReconciler({
      webhookProcessor: makeWebhookProcessor('deal'),
    });
    const registry = createReconcilerRegistry();
    registry.register(recon);
    const { handle, events } = makeFunnel({
      registry,
      connections: { 'hubspot/acme': sampleConnection('acme').config },
    });

    const rawBody = Buffer.from('{}');
    const result = await handle({
      vendor: 'hubspot',
      connection_name: 'acme',
      payload: {},
      headers: {
        'x-hubspot-signature-v3': sign('wrong-secret', rawBody),
      },
      rawBody,
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 401, code: 'invalid_signature' });
    expect(events).toHaveLength(0);
  });

  it('accepts bare-hex signatures (Stripe-style without sha256= prefix)', async () => {
    const recon = makeReconciler({
      webhookProcessor: makeWebhookProcessor('deal'),
    });
    const registry = createReconcilerRegistry();
    registry.register(recon);
    const { handle } = makeFunnel({
      registry,
      connections: { 'hubspot/acme': sampleConnection('acme').config },
    });

    const payload = { events: [{ entity: 'deal', kind: 'created', id: 'd-1', modified_at: 1 }] };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const bareHex = createHmac('sha256', 'shh').update(rawBody).digest('hex');

    const result = await handle({
      vendor: 'hubspot',
      connection_name: 'acme',
      payload,
      headers: { 'x-hubspot-signature-v3': bareHex },
      rawBody,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects non-hex garbage in signature header', async () => {
    const recon = makeReconciler({
      webhookProcessor: makeWebhookProcessor('deal'),
    });
    const registry = createReconcilerRegistry();
    registry.register(recon);
    const { handle } = makeFunnel({
      registry,
      connections: { 'hubspot/acme': sampleConnection('acme').config },
    });

    const result = await handle({
      vendor: 'hubspot',
      connection_name: 'acme',
      payload: {},
      headers: { 'x-hubspot-signature-v3': 'sha256=not-hex-garbage' },
      rawBody: Buffer.from('{}'),
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 401, code: 'invalid_signature' });
  });

  it('returns 503 webhook_secret_missing when the connection has no webhook_secret', async () => {
    const recon = makeReconciler({
      webhookProcessor: makeWebhookProcessor('deal'),
    });
    const registry = createReconcilerRegistry();
    registry.register(recon);
    const { handle } = makeFunnel({
      registry,
      connections: { 'hubspot/acme': { base_url: 'https://api.hubapi.com' } },
    });

    const result = await handle({
      vendor: 'hubspot',
      connection_name: 'acme',
      payload: {},
      headers: { 'x-hubspot-signature-v3': 'whatever' },
      rawBody: Buffer.from('{}'),
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 503, code: 'webhook_secret_missing' });
  });
});

// ────────────────────────────────────────────────────────────────
// Funnel — 404 paths
// ────────────────────────────────────────────────────────────────

describe('D-128 P3 — 404 paths', async () => {
  it('returns 404 connection_not_found when the connection isn\'t enrolled', async () => {
    const recon = makeReconciler({
      webhookProcessor: makeWebhookProcessor('deal'),
    });
    const registry = createReconcilerRegistry();
    registry.register(recon);
    const { handle } = makeFunnel({ registry, connections: {} });

    const result = await handle({
      vendor: 'hubspot',
      connection_name: 'unknown',
      payload: {},
      headers: {},
      rawBody: Buffer.from('{}'),
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 404, code: 'connection_not_found' });
  });

  it('returns 404 vendor_not_registered when no reconciler covers the vendor', async () => {
    const { handle } = makeFunnel({
      connections: { 'hubspot/acme': sampleConnection('acme').config },
    });

    const result = await handle({
      vendor: 'hubspot',
      connection_name: 'acme',
      payload: {},
      headers: {},
      rawBody: Buffer.from('{}'),
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 404, code: 'vendor_not_registered' });
  });

  it('returns 404 webhook_not_supported when registered reconcilers omit webhookProcessor', async () => {
    const recon = makeReconciler({}); // no webhookProcessor
    const registry = createReconcilerRegistry();
    registry.register(recon);
    const { handle } = makeFunnel({
      registry,
      connections: { 'hubspot/acme': sampleConnection('acme').config },
    });

    const result = await handle({
      vendor: 'hubspot',
      connection_name: 'acme',
      payload: {},
      headers: {},
      rawBody: Buffer.from('{}'),
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 404, code: 'webhook_not_supported' });
  });
});

// ────────────────────────────────────────────────────────────────
// Funnel — dedup
// ────────────────────────────────────────────────────────────────

describe('D-128 P3 — dedup against replay window', async () => {
  it('dedupes the second delivery within the replay window', async () => {
    const recon = makeReconciler({
      webhookProcessor: makeWebhookProcessor('deal'),
    });
    const registry = createReconcilerRegistry();
    registry.register(recon);
    let t = 1_000_000;
    const { handle, events } = makeFunnel({
      registry,
      connections: { 'hubspot/acme': sampleConnection('acme').config },
      now: () => t,
    });

    const payload = { events: [{ entity: 'deal', kind: 'created', id: 'deal-1', modified_at: 100 }] };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const headers = {
      'x-hubspot-signature-v3': sign('shh', rawBody),
      'x-hubspot-delivery-id': 'delivery-dup',
    };

    const r1 = await handle({ vendor: 'hubspot', connection_name: 'acme', payload, headers, rawBody });
    expect(r1).toMatchObject({ processed: 1, deduped: 0 });

    // Same delivery id within window → deduped.
    t += 1_000;
    const r2 = await handle({ vendor: 'hubspot', connection_name: 'acme', payload, headers, rawBody });
    expect(r2).toMatchObject({ processed: 0, deduped: 1 });
    expect(events).toHaveLength(1);
  });

  it('past the replay window the same delivery is processed again', async () => {
    const recon = makeReconciler({
      webhookProcessor: makeWebhookProcessor('deal'),
    });
    const registry = createReconcilerRegistry();
    registry.register(recon);
    let t = 1_000_000;
    const { handle, events } = makeFunnel({
      registry,
      connections: { 'hubspot/acme': sampleConnection('acme').config },
      now: () => t,
    });

    const payload = { events: [{ entity: 'deal', kind: 'created', id: 'deal-1', modified_at: 100 }] };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const headers = {
      'x-hubspot-signature-v3': sign('shh', rawBody),
      'x-hubspot-delivery-id': 'delivery-window',
    };

    await handle({ vendor: 'hubspot', connection_name: 'acme', payload, headers, rawBody });
    t += PLATFORM_REFERENCE_WEBHOOK_REPLAY_WINDOW_MS + 1;
    const r2 = await handle({ vendor: 'hubspot', connection_name: 'acme', payload, headers, rawBody });
    expect(r2).toMatchObject({ processed: 1, deduped: 0 });
    expect(events).toHaveLength(2);
  });

  it('falls back to body-hash dedup when the vendor stamps no delivery id', async () => {
    const recon = makeReconciler({
      webhookProcessor: {
        signature_header: 'x-hubspot-signature-v3',
        parseEvents(payload, _h) {
          if (!payload || typeof payload !== 'object' || !('events' in payload)) return [];
          const raw = (payload as { events: ReadonlyArray<Record<string, unknown>> }).events;
          return raw
            .filter((e) => e.kind === 'created' || e.kind === 'updated')
            .map((e) => ({
              kind: e.kind as 'created' | 'updated',
              record: { id: String(e.id), modified_at: Number(e.modified_at) },
            }));
        },
        // deliveryId omitted on purpose — body-hash fallback.
      },
    });
    const registry = createReconcilerRegistry();
    registry.register(recon);
    let t = 1_000_000;
    const { handle, events } = makeFunnel({
      registry,
      connections: { 'hubspot/acme': sampleConnection('acme').config },
      now: () => t,
    });

    const payload = { events: [{ entity: 'deal', kind: 'created', id: 'd1', modified_at: 5 }] };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const headers = { 'x-hubspot-signature-v3': sign('shh', rawBody) };

    await handle({ vendor: 'hubspot', connection_name: 'acme', payload, headers, rawBody });
    t += 1;
    const r2 = await handle({ vendor: 'hubspot', connection_name: 'acme', payload, headers, rawBody });
    expect(r2).toMatchObject({ deduped: 1, processed: 0 });
    expect(events).toHaveLength(1);
  });

  it('different delivery ids with the same body are NOT deduped (vendor-id wins over body-hash)', async () => {
    const recon = makeReconciler({
      webhookProcessor: makeWebhookProcessor('deal'),
    });
    const registry = createReconcilerRegistry();
    registry.register(recon);
    let t = 1_000_000;
    const { handle, events } = makeFunnel({
      registry,
      connections: { 'hubspot/acme': sampleConnection('acme').config },
      now: () => t,
    });

    const payload = { events: [{ entity: 'deal', kind: 'created', id: 'd1', modified_at: 5 }] };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const sig = sign('shh', rawBody);

    await handle({
      vendor: 'hubspot',
      connection_name: 'acme',
      payload,
      headers: { 'x-hubspot-signature-v3': sig, 'x-hubspot-delivery-id': 'a' },
      rawBody,
    });
    await handle({
      vendor: 'hubspot',
      connection_name: 'acme',
      payload,
      headers: { 'x-hubspot-signature-v3': sig, 'x-hubspot-delivery-id': 'b' },
      rawBody,
    });
    expect(events).toHaveLength(2);
  });

  it('dedup ring soft cap is exposed for ops sanity', async () => {
    expect(WEBHOOK_DEDUP_RING_MAX_ENTRIES).toBeGreaterThan(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Multi-reconciler vendor fan-out
// ────────────────────────────────────────────────────────────────

describe('D-128 P3 — vendor fan-out across multiple reconcilers', async () => {
  it('dispatches a mixed payload to each entity reconciler in turn', async () => {
    const dealRecon = makeReconciler({
      entity: 'deal',
      webhookProcessor: makeWebhookProcessor('deal'),
    });
    const contactRecon = makeReconciler({
      entity: 'contact',
      webhookProcessor: makeWebhookProcessor('contact'),
    });
    const registry = createReconcilerRegistry();
    registry.register(dealRecon);
    registry.register(contactRecon);
    const { handle, events } = makeFunnel({
      registry,
      connections: { 'hubspot/acme': sampleConnection('acme').config },
    });

    const payload = {
      events: [
        { entity: 'deal', kind: 'created', id: 'deal-1', modified_at: 100 },
        { entity: 'contact', kind: 'updated', id: 'contact-1', modified_at: 200 },
      ],
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    await handle({
      vendor: 'hubspot',
      connection_name: 'acme',
      payload,
      headers: {
        'x-hubspot-signature-v3': sign('shh', rawBody),
        'x-hubspot-delivery-id': 'mixed',
      },
      rawBody,
    });

    expect(events.map((e) => [e.platform, e.record_id])).toEqual([
      ['connection.api.hubspot.deal', 'deal-1'],
      ['connection.api.hubspot.contact', 'contact-1'],
    ]);
  });

  it('counts a parseEvents throw as failed without aborting the rest', async () => {
    const dealRecon = makeReconciler({
      entity: 'deal',
      webhookProcessor: {
        signature_header: 'x-hubspot-signature-v3',
        parseEvents() {
          throw new Error('vendor parser bug');
        },
      },
    });
    const contactRecon = makeReconciler({
      entity: 'contact',
      webhookProcessor: makeWebhookProcessor('contact'),
    });
    const registry = createReconcilerRegistry();
    registry.register(dealRecon);
    registry.register(contactRecon);
    const { handle, events } = makeFunnel({
      registry,
      connections: { 'hubspot/acme': sampleConnection('acme').config },
    });

    const payload = {
      events: [{ entity: 'contact', kind: 'updated', id: 'c-1', modified_at: 1 }],
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const result = await handle({
      vendor: 'hubspot',
      connection_name: 'acme',
      payload,
      headers: {
        'x-hubspot-signature-v3': sign('shh', rawBody),
      },
      rawBody,
    });

    expect(result).toMatchObject({ ok: true, processed: 1, failed: 1 });
    expect(events).toHaveLength(1);
    expect(events[0]!.entity_type).toBe('contact');
  });
});

// ────────────────────────────────────────────────────────────────
// Cycle-as-safety-net interaction
// ────────────────────────────────────────────────────────────────

describe('D-128 P3 — cycle is the catch-up safety net after webhooks', async () => {
  it('cycle running after a webhook delivers the same record stays a no-op when an enrichment row exists with the new hash', async () => {
    const scope: EnrichmentScope = 'connection.api.hubspot.deal';
    const target = 'deal-1';
    // Simulate a producer having written an enrichment row earlier
    // with the soon-to-be-stale hash.
    store.upsert({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: target,
      value: validRollup,
      authored_by: 'recipe.x',
      meta: { snapshot_at: 1, snapshot_hash: 'fnv1a:stale', name: 'old' },
    });
    db.prepare('UPDATE data_enrichment SET scope = ? WHERE target_id = ?').run(scope, target);

    const records: SlimRecord[] = [{ id: target, modified_at: 9_000 }];
    const recon = makeReconciler({
      records,
      webhookProcessor: makeWebhookProcessor('deal'),
    });
    const registry = createReconcilerRegistry();
    registry.register(recon);
    const { handle, bus, events } = makeFunnel({
      registry,
      connections: { 'hubspot/acme': sampleConnection('acme').config },
    });

    // 1. Webhook arrives — refreshes meta + emits 'updated'.
    const payload = {
      events: [{ entity: 'deal', kind: 'updated', id: target, modified_at: 9_000 }],
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    await handle({
      vendor: 'hubspot',
      connection_name: 'acme',
      payload,
      headers: {
        'x-hubspot-signature-v3': sign('shh', rawBody),
        'x-hubspot-delivery-id': 'delivery-1',
      },
      rawBody,
    });
    expect(events).toHaveLength(1);
    expect(store.listByTarget(scope, target)[0]!.meta?.snapshot_hash).toBe(`fnv1a:${target}-9000`);

    // 2. Cycle runs after — same modified_at in the stub's
    //    listUpdatedSince, hashOf produces the same hash the funnel
    //    just stored, so the cycle yields zero new emits.
    const task = buildVendorReconciliationTask({
      reconciler: recon,
      connection_name: 'acme',
      lookupConnection: () => sampleConnection('acme'),
    });
    const ctx: HousekeepingContext = {
      db,
      bus,
      enrichmentStore: store,
      recipeStore: {} as unknown as HousekeepingContext['recipeStore'],
      now: () => 2_000_000_000_000,
      emitAuditRow: () => {},
    };
    const before = events.length;
    await task.step(ctx, { kind: 'time', last_seen_at: 0 }, 60_000);
    expect(events.length).toBe(before); // no new emits — cycle was a safety net no-op.
  });
});

// ────────────────────────────────────────────────────────────────
// HTTP recipient
// ────────────────────────────────────────────────────────────────

const buildRequest = (
  method: string,
  url: string,
  body: string,
  headers: Record<string, string> = {},
): IncomingMessage => {
  const { Readable } = require('node:stream');
  const stream = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  stream.headers = headers;
  stream.method = method;
  stream.url = url;
  // Patch the inherited setMaxListeners so the test runner doesn't
  // complain when we add data/end/error/close listeners.
  return stream;
};

interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  ended: boolean;
}

const makeResponse = (): { res: import('node:http').ServerResponse; captured: CapturedResponse } => {
  const captured: CapturedResponse = {
    statusCode: 0,
    headers: {},
    body: '',
    ended: false,
  };
  const res = {
    get statusCode(): number { return captured.statusCode; },
    set statusCode(v: number) { captured.statusCode = v; },
    setHeader(k: string, v: string): void { captured.headers[k.toLowerCase()] = v; },
    getHeader(k: string): string | undefined { return captured.headers[k.toLowerCase()]; },
    end(b?: string | Buffer): void {
      if (b !== undefined) captured.body += typeof b === 'string' ? b : b.toString('utf-8');
      captured.ended = true;
    },
    write(b: string | Buffer): boolean {
      captured.body += typeof b === 'string' ? b : b.toString('utf-8');
      return true;
    },
  } as unknown as import('node:http').ServerResponse;
  return { res, captured };
};

describe('D-128 P3 — HTTP recipient', async () => {
  it('happy path POST → funnel → 202', async () => {
    const recon = makeReconciler({
      webhookProcessor: makeWebhookProcessor('deal'),
    });
    const registry = createReconcilerRegistry();
    registry.register(recon);
    const { funnel } = makeFunnel({
      registry,
      connections: { 'hubspot/acme': sampleConnection('acme').config },
    });

    const listener = createConnectionWebhookListener({
      funnel: funnel.handle,
      publicReachable: () => true,
    });

    const payload = { events: [{ entity: 'deal', kind: 'created', id: 'd-1', modified_at: 1 }] };
    const body = JSON.stringify(payload);
    const sig = sign('shh', Buffer.from(body));
    const req = buildRequest('POST', '/v1/connection/webhook/hubspot/acme', body, {
      'content-type': 'application/json',
      'x-hubspot-signature-v3': sig,
    });
    const { res, captured } = makeResponse();

    await listener(req, res, 'hubspot', 'acme');

    expect(captured.statusCode).toBe(202);
    const parsed = JSON.parse(captured.body);
    expect(parsed).toMatchObject({ ok: true, processed: 1, deduped: 0, failed: 0 });
  });

  it('returns 503 when public_reachable is false', async () => {
    const { funnel } = makeFunnel({});
    const listener = createConnectionWebhookListener({
      funnel: funnel.handle,
      publicReachable: () => false,
    });
    const req = buildRequest('POST', '/v1/connection/webhook/hubspot/acme', '{}', {
      'content-type': 'application/json',
    });
    const { res, captured } = makeResponse();
    await listener(req, res, 'hubspot', 'acme');
    expect(captured.statusCode).toBe(503);
    expect(JSON.parse(captured.body).error.code).toBe('WEBHOOK_UNAVAILABLE');
  });

  it('returns 415 when content-type isn\'t JSON', async () => {
    const { funnel } = makeFunnel({});
    const listener = createConnectionWebhookListener({
      funnel: funnel.handle,
      publicReachable: () => true,
    });
    const req = buildRequest('POST', '/v1/connection/webhook/hubspot/acme', 'not json', {
      'content-type': 'text/plain',
    });
    const { res, captured } = makeResponse();
    await listener(req, res, 'hubspot', 'acme');
    expect(captured.statusCode).toBe(415);
  });

  it('returns 400 invalid_json on broken JSON body', async () => {
    const { funnel } = makeFunnel({});
    const listener = createConnectionWebhookListener({
      funnel: funnel.handle,
      publicReachable: () => true,
    });
    const req = buildRequest('POST', '/v1/connection/webhook/hubspot/acme', '{broken', {
      'content-type': 'application/json',
    });
    const { res, captured } = makeResponse();
    await listener(req, res, 'hubspot', 'acme');
    expect(captured.statusCode).toBe(400);
    expect(JSON.parse(captured.body).error.code).toBe('invalid_json');
  });

  it('returns 405 on non-POST method', async () => {
    const { funnel } = makeFunnel({});
    const listener = createConnectionWebhookListener({
      funnel: funnel.handle,
      publicReachable: () => true,
    });
    const req = buildRequest('GET', '/v1/connection/webhook/hubspot/acme', '', {
      'content-type': 'application/json',
    });
    const { res, captured } = makeResponse();
    await listener(req, res, 'hubspot', 'acme');
    expect(captured.statusCode).toBe(405);
  });

  it('returns 413 when body exceeds the cap', async () => {
    const { funnel } = makeFunnel({});
    const listener = createConnectionWebhookListener({
      funnel: funnel.handle,
      publicReachable: () => true,
      maxBodyBytes: 16,
    });
    const req = buildRequest(
      'POST',
      '/v1/connection/webhook/hubspot/acme',
      JSON.stringify({ x: 'y'.repeat(64) }),
      { 'content-type': 'application/json' },
    );
    const { res, captured } = makeResponse();
    await listener(req, res, 'hubspot', 'acme');
    expect(captured.statusCode).toBe(413);
  });
});

// ────────────────────────────────────────────────────────────────
// Vendor scope composition uses the new helper
// ────────────────────────────────────────────────────────────────

describe('D-128 P3 — vendor scope composition', async () => {
  it('emits warehouse events with the canonical platform-reference scope', async () => {
    expect(composeVendorEntityScope('hubspot', 'deal')).toBe('connection.api.hubspot.deal');
  });
});

// ────────────────────────────────────────────────────────────────
// WatchSource generalization — onEmit hook + requireMessageAuth
// ────────────────────────────────────────────────────────────────

describe('WatchSource — funnel onEmit + requireMessageAuth', async () => {
  it('onEmit fires once per bus emit with (vendor, entity, connection, at)', async () => {
    const recon = makeReconciler({
      webhookProcessor: makeWebhookProcessor('deal'),
    });
    const registry = createReconcilerRegistry();
    registry.register(recon);
    const emits: Array<{ vendor: string; entity: string; connection_name: string; at: number }> = [];
    const { handle } = makeFunnel({
      registry,
      connections: { 'hubspot/acme-hubspot': sampleConnection().config },
      now: () => 42_000,
      onEmit: (info) => emits.push(info),
    });

    const payload = {
      events: [
        { entity: 'deal', kind: 'created', id: 'deal-1', modified_at: 100 },
        { entity: 'deal', kind: 'deleted', id: 'deal-2' },
      ],
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const result = await handle({
      vendor: 'hubspot',
      connection_name: 'acme-hubspot',
      payload,
      headers: {
        'x-hubspot-signature-v3': sign('shh', rawBody),
        'x-hubspot-delivery-id': 'delivery-emit-1',
      },
      rawBody,
    });
    expect(result).toMatchObject({ ok: true, processed: 2 });
    expect(emits).toEqual([
      { vendor: 'hubspot', entity: 'deal', connection_name: 'acme-hubspot', at: 42_000 },
      { vendor: 'hubspot', entity: 'deal', connection_name: 'acme-hubspot', at: 42_000 },
    ]);
  });

  it('requireMessageAuth rejects an OAuth-bound (no signature_header) vendor over HTTP', async () => {
    // Salesforce-shaped: webhookProcessor present, NO signature_header —
    // trust lives at the CometD subscription. The public HTTP receiver
    // must not accept unauthenticated payloads for it.
    const recon = makeReconciler({
      vendor: 'salesforce',
      entity: 'opportunity',
      webhookProcessor: {
        signature_algorithm: 'sha256',
        parseEvents: () => [
          { kind: 'created', record: { id: 'o1', modified_at: 1 } },
        ],
      } as never,
    });
    const registry = createReconcilerRegistry();
    registry.register(recon);
    const { handle, events } = makeFunnel({
      registry,
      connections: { 'salesforce/sf-main': { base_url: 'https://x.my.salesforce.com' } },
      requireMessageAuth: true,
    });

    const result = await handle({
      vendor: 'salesforce',
      connection_name: 'sf-main',
      payload: { whatever: true },
      headers: {},
      rawBody: Buffer.from('{}'),
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 404, code: 'webhook_not_supported' });
    expect(events).toHaveLength(0);
  });

  it('an in-process funnel (no requireMessageAuth) still accepts the OAuth-bound vendor', async () => {
    const recon = makeReconciler({
      vendor: 'salesforce',
      entity: 'opportunity',
      webhookProcessor: {
        signature_algorithm: 'sha256',
        parseEvents: () => [
          { kind: 'created', record: { id: 'o1', modified_at: 1 } },
        ],
      } as never,
    });
    const registry = createReconcilerRegistry();
    registry.register(recon);
    const { handle, events } = makeFunnel({
      registry,
      connections: { 'salesforce/sf-main': { base_url: 'https://x.my.salesforce.com' } },
    });

    const result = await handle({
      vendor: 'salesforce',
      connection_name: 'sf-main',
      payload: { whatever: true },
      headers: {},
      rawBody: Buffer.from('{}'),
    });
    expect(result).toMatchObject({ ok: true, processed: 1 });
    expect(events).toHaveLength(1);
  });
});

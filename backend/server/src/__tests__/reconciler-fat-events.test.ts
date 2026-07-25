/** Reconciler fat-event emission regression pins.
 *
 *  Covers the record / prev / changed_fields payload helpers, the
 *  reconciliation cycle emit path, and the webhook funnel emit path. */

import { createHmac } from 'node:crypto';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  ConnectionRecord,
  EnrichmentMeta,
  EnrichmentScope,
} from '../../../../packages/contracts/src/index.js';
import {
  createWarehouseEventBus,
  type WarehouseEvent,
} from '../../../../packages/warehouse-events/src/index.js';

import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';
import {
  buildFatEventFields,
  buildVendorReconciliationTask,
  metaToEventRecord,
  pickSnapshotMeta,
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
  createWebhookFunnel,
  type ConnectionConfigLookup,
  type WebhookFunnelHandler,
} from '../housekeeping/reconciliation/webhook-funnel.js';

// ────────────────────────────────────────────────────────────────
// Test harness
// ────────────────────────────────────────────────────────────────

let db: Database.Database;
let store: EnrichmentStore;
let idSeq: number;
let nowSeq: number;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  idSeq = 0;
  nowSeq = 1_000_000;
  store = createEnrichmentStore(db, {
    newId: () => `enr_${++idSeq}`,
    now: () => nowSeq++,
  });
});

afterEach(() => {
  db.close();
});

const validRollup = {
  interaction_count: 1,
  last_interaction: 1,
  recent_subjects: ['x'],
  cursor_at: 1,
  window_ms: 30 * 24 * 60 * 60 * 1000,
};

const platformScope: EnrichmentScope = 'connection.api.hubspot.deal';

interface TestSlimRecord extends SlimRecord {
  hash: string;
  name: string;
  amount: number;
  stage?: string;
  close_date: number;
  vendor_extra?: unknown;
}

const oldMeta = (overrides: Partial<EnrichmentMeta> = {}): EnrichmentMeta => ({
  snapshot_at: 100,
  snapshot_hash: 'fnv1a:old',
  name: 'Acme Renewal',
  amount: 100,
  stage: 'negotiation',
  key_dates: { close_date: 1_700_000_000_000 },
  vendor_extra: { score: 7 },
  ...overrides,
});

const recordMeta = (record: SlimRecord): EnrichmentMeta => {
  const r = record as TestSlimRecord;
  return {
    snapshot_at: r.modified_at,
    snapshot_hash: `fnv1a:${r.hash}`,
    name: r.name,
    amount: r.amount,
    stage: r.stage ?? 'negotiation',
    key_dates: { close_date: r.close_date },
    ...(r.vendor_extra !== undefined ? { vendor_extra: r.vendor_extra } : {}),
  };
};

const makeRecord = (overrides: Partial<TestSlimRecord> = {}): TestSlimRecord => ({
  id: 'deal-1',
  modified_at: 200,
  hash: 'new',
  name: 'Acme Renewal',
  amount: 150,
  stage: 'negotiation',
  close_date: 1_700_086_400_000,
  vendor_extra: { score: 7 },
  ...overrides,
});

const makeReconciler = (opts: {
  records?: ReadonlyArray<SlimRecord>;
  deletions?: ReadonlyArray<string>;
  webhookProcessor?: WebhookProcessor;
} = {}): VendorReconciler => {
  const records = opts.records ?? [];
  const deletions = opts.deletions ?? [];
  const recon: VendorReconciler = {
    vendor: 'hubspot',
    entity: 'deal',
    default_cadence: '6h',
    async *listUpdatedSince(_conn, cursor, _limit) {
      for (const record of records) {
        if (record.modified_at > cursor) yield record;
      }
    },
    hashOf(record) {
      return `fnv1a:${(record as TestSlimRecord).hash}`;
    },
    toMeta: recordMeta,
  };

  if (deletions.length > 0) {
    recon.listDeletedSince = async function* () {
      for (const targetId of deletions) yield targetId;
    };
  }
  if (opts.webhookProcessor) {
    recon.webhookProcessor = opts.webhookProcessor;
  }
  return recon;
};

const sampleConnection = (name = 'acme'): ConnectionRecord => ({
  name,
  kind: 'api',
  display_name: name,
  config: { base_url: 'https://api.hubapi.com', webhook_secret: 'shh' },
  auth: { type: 'bearer', token: 'pat-token' },
  enrolled_at: 1,
  updated_at: 1,
});

const makeBus = (): {
  bus: ReturnType<typeof createWarehouseEventBus>;
  events: WarehouseEvent[];
} => {
  const events: WarehouseEvent[] = [];
  const bus = createWarehouseEventBus();
  bus.subscribe('**', (event) => {
    events.push(event);
  });
  return { bus, events };
};

const makeContext = (bus: ReturnType<typeof createWarehouseEventBus>): HousekeepingContext => ({
  db,
  bus,
  enrichmentStore: store,
  recipeStore: {} as HousekeepingContext['recipeStore'],
  now: () => 2_000_000_000_000,
  emitAuditRow: () => {},
});

const seedPlatformRow = (target_id: string, meta?: EnrichmentMeta): void => {
  store.upsert({
    topic: 'contact_timeline_rollup',
    scope: 'contact',
    target_id,
    value: validRollup,
    authored_by: 'recipe.x',
    ...(meta !== undefined ? { meta } : {}),
  });
  db.prepare('UPDATE data_enrichment SET scope = ? WHERE target_id = ?').run(
    platformScope,
    target_id,
  );
};

const expectNoStampingFields = (record: Record<string, unknown> | undefined): void => {
  expect(record).toBeDefined();
  if (record === undefined) return;
  expect(record).not.toHaveProperty('snapshot_at');
  expect(record).not.toHaveProperty('snapshot_hash');
};

const strippedOldMeta = (meta: EnrichmentMeta = oldMeta()): Record<string, unknown> => ({
  name: meta.name,
  amount: meta.amount,
  stage: meta.stage,
  key_dates: meta.key_dates,
  vendor_extra: meta.vendor_extra,
});

const sign = (secret: string, body: Buffer): string =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

const makeWebhookProcessor = (): WebhookProcessor => ({
  signature_header: 'x-hubspot-signature-v3',
  signature_algorithm: 'sha256',
  parseEvents(payload) {
    if (!payload || typeof payload !== 'object' || !('events' in payload)) return [];
    const events = (payload as { events: ReadonlyArray<Record<string, unknown>> }).events;
    const out: WebhookSlimEvent[] = [];
    for (const event of events) {
      if (event.entity !== 'deal') continue;
      if (event.kind === 'deleted') {
        out.push({ kind: 'deleted', target_id: String(event.id) });
      } else if (event.kind === 'created' || event.kind === 'updated') {
        out.push({
          kind: event.kind,
          record: makeRecord({
            id: String(event.id),
            modified_at: Number(event.modified_at),
            hash: String(event.hash),
            name: String(event.name),
            amount: Number(event.amount),
            close_date: Number(event.close_date),
            vendor_extra: event.vendor_extra,
          }),
        });
      }
    }
    return out;
  },
  deliveryId(_payload, headers) {
    return headers['x-hubspot-delivery-id'] ?? null;
  },
});

const makeFunnel = (opts: {
  registry?: ReconcilerRegistry;
  connections?: Record<string, Record<string, unknown> | null>;
} = {}): {
  events: WarehouseEvent[];
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
    now: () => 2_000_000_000_000,
  });
  return { events, handle: funnel.handle };
};

const deliver = async (
  handle: WebhookFunnelHandler,
  payload: unknown,
  deliveryId: string,
) => {
  const rawBody = Buffer.from(JSON.stringify(payload));
  return handle({
    vendor: 'hubspot',
    connection_name: 'acme',
    payload,
    headers: {
      'x-hubspot-signature-v3': sign('shh', rawBody),
      'x-hubspot-delivery-id': deliveryId,
    },
    rawBody,
  });
};

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

describe('reconciler fat-event helpers', () => {
  it('metaToEventRecord strips exactly snapshot_at and snapshot_hash', () => {
    const record = metaToEventRecord({
      snapshot_at: 123,
      snapshot_hash: 'fnv1a:abc',
      snapshot_at_source: 'vendor',
      snapshot_hash_algo: 'fnv1a',
      name: 'Acme',
      key_dates: { close_date: 456 },
      vendor_extra: { nested: true },
    });

    expect(record).toEqual({
      snapshot_at_source: 'vendor',
      snapshot_hash_algo: 'fnv1a',
      name: 'Acme',
      key_dates: { close_date: 456 },
      vendor_extra: { nested: true },
    });
    expect(record).not.toHaveProperty('snapshot_at');
    expect(record).not.toHaveProperty('snapshot_hash');
  });

  it('buildFatEventFields returns record-only when there is no prior meta', () => {
    const fields = buildFatEventFields(
      {
        snapshot_at: 200,
        snapshot_hash: 'fnv1a:new',
        name: 'Acme',
        amount: 150,
        key_dates: { close_date: 300 },
        vendor_extra: { pass: 'through' },
      },
      null,
    );

    expect(fields).toEqual({
      record: {
        name: 'Acme',
        amount: 150,
        key_dates: { close_date: 300 },
        vendor_extra: { pass: 'through' },
      },
    });
    expect(fields.prev).toBeUndefined();
    expect(fields.changed_fields).toBeUndefined();
    expectNoStampingFields(fields.record);
  });

  it('buildFatEventFields adds stripped prev and sorted dotted changed fields', () => {
    const fields = buildFatEventFields(
      {
        snapshot_at: 200,
        snapshot_hash: 'fnv1a:new',
        name: 'Acme',
        amount: 150,
        key_dates: { close_date: 300, renewal_date: 400 },
        vendor_extra: { score: 8 },
      },
      {
        snapshot_at: 100,
        snapshot_hash: 'fnv1a:old',
        name: 'Acme',
        amount: 100,
        key_dates: { close_date: 200, renewal_date: 400 },
        vendor_extra: { score: 7 },
      },
    );

    expect(fields.record).toEqual({
      name: 'Acme',
      amount: 150,
      key_dates: { close_date: 300, renewal_date: 400 },
      vendor_extra: { score: 8 },
    });
    expect(fields.prev).toEqual({
      name: 'Acme',
      amount: 100,
      key_dates: { close_date: 200, renewal_date: 400 },
      vendor_extra: { score: 7 },
    });
    expect(fields.changed_fields).toEqual([
      'amount',
      'key_dates.close_date',
      'vendor_extra.score',
    ]);
    expectNoStampingFields(fields.record);
    expectNoStampingFields(fields.prev);
  });

  it('pickSnapshotMeta skips rows without usable meta and returns the first stamped snapshot', () => {
    const first = oldMeta({ snapshot_hash: 'fnv1a:first' });
    const second = oldMeta({ snapshot_hash: 'fnv1a:second' });

    expect(
      pickSnapshotMeta([
        { meta: null },
        { meta: { snapshot_at: 1, snapshot_hash: '' } as EnrichmentMeta },
        { meta: first },
        { meta: second },
      ]),
    ).toBe(first);
    expect(pickSnapshotMeta([{ meta: null }])).toBeNull();
    expect(pickSnapshotMeta([])).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// Reconciliation cycle
// ────────────────────────────────────────────────────────────────

describe('reconciler cycle fat-event emission', () => {
  it('first sighting emits created with record only', async () => {
    const record = makeRecord({
      id: 'deal-created',
      modified_at: 500,
      hash: 'created',
      amount: 250,
      close_date: 1_700_172_800_000,
    });
    const task = buildVendorReconciliationTask({
      reconciler: makeReconciler({ records: [record] }),
      connection_name: 'acme',
      lookupConnection: () => sampleConnection(),
    });
    const { bus, events } = makeBus();

    const result = await task.step(makeContext(bus), { kind: 'time', last_seen_at: 0 }, 60_000);

    expect(result.status).toBe('complete');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      platform: platformScope,
      slug: 'acme',
      entity_type: 'deal',
      event_kind: 'created',
      record_id: 'deal-created',
      record: metaToEventRecord(recordMeta(record)),
    });
    expect(events[0]!.prev).toBeUndefined();
    expect(events[0]!.changed_fields).toBeUndefined();
    expectNoStampingFields(events[0]!.record);
  });

  it('changed existing record emits updated with stripped prev and exact changed fields', async () => {
    const target = 'deal-updated';
    const previous = oldMeta();
    seedPlatformRow(target, previous);
    const record = makeRecord({ id: target, hash: 'new', amount: 150 });
    const task = buildVendorReconciliationTask({
      reconciler: makeReconciler({ records: [record] }),
      connection_name: 'acme',
      lookupConnection: () => sampleConnection(),
    });
    const { bus, events } = makeBus();

    await task.step(makeContext(bus), { kind: 'time', last_seen_at: 0 }, 60_000);

    expect(events).toHaveLength(1);
    expect(events[0]!.event_kind).toBe('updated');
    expect(events[0]!.record).toEqual(metaToEventRecord(recordMeta(record)));
    expect(events[0]!.prev).toEqual(strippedOldMeta(previous));
    expect(events[0]!.changed_fields).toEqual(['amount', 'key_dates.close_date']);
    expectNoStampingFields(events[0]!.record);
    expectNoStampingFields(events[0]!.prev);
  });

  it('existing row without prior meta emits updated with record only', async () => {
    const target = 'deal-meta-less';
    seedPlatformRow(target);
    const record = makeRecord({ id: target, hash: 'from-producer-row' });
    const task = buildVendorReconciliationTask({
      reconciler: makeReconciler({ records: [record] }),
      connection_name: 'acme',
      lookupConnection: () => sampleConnection(),
    });
    const { bus, events } = makeBus();

    await task.step(makeContext(bus), { kind: 'time', last_seen_at: 0 }, 60_000);

    expect(events).toHaveLength(1);
    expect(events[0]!.event_kind).toBe('updated');
    expect(events[0]!.record).toEqual(metaToEventRecord(recordMeta(record)));
    expect(events[0]!.prev).toBeUndefined();
    expect(events[0]!.changed_fields).toBeUndefined();
    expectNoStampingFields(events[0]!.record);
  });

  it('deletion emits stripped prev when stored meta exists and omits prev without meta', async () => {
    seedPlatformRow('deal-deleted-with-meta', oldMeta({ name: 'Gone' }));
    seedPlatformRow('deal-deleted-without-meta');
    const task = buildVendorReconciliationTask({
      reconciler: makeReconciler({
        deletions: ['deal-deleted-with-meta', 'deal-deleted-without-meta'],
      }),
      connection_name: 'acme',
      lookupConnection: () => sampleConnection(),
    });
    const { bus, events } = makeBus();

    await task.step(makeContext(bus), { kind: 'time', last_seen_at: 0 }, 60_000);

    expect(events.map((event) => [event.event_kind, event.record_id])).toEqual([
      ['deleted', 'deal-deleted-with-meta'],
      ['deleted', 'deal-deleted-without-meta'],
    ]);
    expect(events[0]!.prev).toEqual(strippedOldMeta(oldMeta({ name: 'Gone' })));
    expect(events[0]!.record).toBeUndefined();
    expect(events[0]!.changed_fields).toBeUndefined();
    expect(events[1]!.prev).toBeUndefined();
    expect(events[1]!.record).toBeUndefined();
    expect(events[1]!.changed_fields).toBeUndefined();
    expectNoStampingFields(events[0]!.prev);
  });
});

// ────────────────────────────────────────────────────────────────
// Webhook funnel
// ────────────────────────────────────────────────────────────────

describe('webhook funnel fat-event emission', () => {
  it('created and updated webhook events emit fat record payloads', async () => {
    seedPlatformRow('deal-webhook-updated', oldMeta());
    const registry = createReconcilerRegistry();
    registry.register(makeReconciler({ webhookProcessor: makeWebhookProcessor() }));
    const { handle, events } = makeFunnel({
      registry,
      connections: { 'hubspot/acme': sampleConnection().config },
    });

    const result = await deliver(
      handle,
      {
        events: [
          {
            entity: 'deal',
            kind: 'created',
            id: 'deal-webhook-created',
            modified_at: 300,
            hash: 'webhook-created',
            name: 'New Webhook Deal',
            amount: 75,
            close_date: 1_700_259_200_000,
            vendor_extra: { score: 3 },
          },
          {
            entity: 'deal',
            kind: 'updated',
            id: 'deal-webhook-updated',
            modified_at: 400,
            hash: 'webhook-updated',
            name: 'Acme Renewal',
            amount: 175,
            close_date: 1_700_345_600_000,
            vendor_extra: { score: 7 },
          },
        ],
      },
      'delivery-fat-records',
    );

    expect(result).toMatchObject({ ok: true, processed: 2, deduped: 0, failed: 0 });
    expect(events).toHaveLength(2);
    expect(events[0]!.event_kind).toBe('created');
    expect(events[0]!.record).toEqual({
      name: 'New Webhook Deal',
      amount: 75,
      stage: 'negotiation',
      key_dates: { close_date: 1_700_259_200_000 },
      vendor_extra: { score: 3 },
    });
    expect(events[0]!.prev).toBeUndefined();
    expect(events[0]!.changed_fields).toBeUndefined();

    expect(events[1]!.event_kind).toBe('updated');
    expect(events[1]!.record).toEqual({
      name: 'Acme Renewal',
      amount: 175,
      stage: 'negotiation',
      key_dates: { close_date: 1_700_345_600_000 },
      vendor_extra: { score: 7 },
    });
    expect(events[1]!.prev).toEqual(strippedOldMeta());
    expect(events[1]!.changed_fields).toEqual(['amount', 'key_dates.close_date']);
    expectNoStampingFields(events[0]!.record);
    expectNoStampingFields(events[1]!.record);
    expectNoStampingFields(events[1]!.prev);
  });

  it('deleted webhook events carry stripped prev from the store when available', async () => {
    seedPlatformRow('deal-webhook-deleted-with-meta', oldMeta({ name: 'Webhook Gone' }));
    const registry = createReconcilerRegistry();
    registry.register(makeReconciler({ webhookProcessor: makeWebhookProcessor() }));
    const { handle, events } = makeFunnel({
      registry,
      connections: { 'hubspot/acme': sampleConnection().config },
    });

    const result = await deliver(
      handle,
      {
        events: [
          { entity: 'deal', kind: 'deleted', id: 'deal-webhook-deleted-with-meta' },
          { entity: 'deal', kind: 'deleted', id: 'deal-webhook-deleted-empty' },
        ],
      },
      'delivery-deleted-prev',
    );

    expect(result).toMatchObject({ ok: true, processed: 2, deduped: 0, failed: 0 });
    expect(events.map((event) => [event.event_kind, event.record_id])).toEqual([
      ['deleted', 'deal-webhook-deleted-with-meta'],
      ['deleted', 'deal-webhook-deleted-empty'],
    ]);
    expect(events[0]!.prev).toEqual(strippedOldMeta(oldMeta({ name: 'Webhook Gone' })));
    expect(events[0]!.record).toBeUndefined();
    expect(events[0]!.changed_fields).toBeUndefined();
    expect(events[1]!.prev).toBeUndefined();
    expect(events[1]!.record).toBeUndefined();
    expect(events[1]!.changed_fields).toBeUndefined();
    expectNoStampingFields(events[0]!.prev);
  });
});

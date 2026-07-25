/** D-190 — the reconciler + funnel write the CRM record mirror (MS2).
 *
 *  The unifying fix: the vendor reconciliation harness
 *  (`buildVendorReconciliationTask`) and the webhook funnel
 *  (`createWebhookFunnel`) both upsert one row per CRM record into the
 *  dedicated `crm_record_mirror` store UNCONDITIONALLY — independent of the
 *  enrichment hash-diff AND of whether any AI producer wrote an enrichment row.
 *  So `deal.search` (MS3) surfaces EVERY record, not just producer-enriched
 *  ones (the pre-existing base-row gap: `refreshMetaForTarget` is UPDATE-only,
 *  so an un-enriched record never became listable through the enrichment path).
 *
 *  Real SQLite + real `CrmRecordMirrorStore` throughout — an integration test
 *  of the write side, not a stub assertion. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWarehouseEventBus } from '@recued/warehouse-events';
import {
  composeVendorEntityScope,
  type ConnectionRecord,
  type EnrichmentScope,
  type EnrichmentMeta,
} from '@recued/contracts';

import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import {
  createCrmRecordMirrorStore,
  ensureCrmRecordMirrorSchema,
  type CrmRecordMirrorStore,
} from '../storage/crm-record-mirror-store.js';
import {
  buildVendorReconciliationTask,
  type SlimRecord,
  type VendorReconciler,
  type WebhookProcessor,
  type WebhookSlimEvent,
} from '../housekeeping/reconciliation/vendor-reconciler.js';
import { createReconcilerRegistry } from '../housekeeping/reconciliation/reconciler-registry.js';
import {
  createWebhookFunnel,
  type ConnectionConfigLookup,
} from '../housekeeping/reconciliation/webhook-funnel.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';

const DEAL_SCOPE = composeVendorEntityScope('hubspot', 'deal'); // connection.api.hubspot.deal

// ────────────────────────────────────────────────────────────────
// Harness
// ────────────────────────────────────────────────────────────────

let dir: string;
let db: Database.Database;
let enrichmentStore: EnrichmentStore;
let mirror: CrmRecordMirrorStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-190-mirror-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  enrichmentStore = createEnrichmentStore(db);
  ensureCrmRecordMirrorSchema(db);
  mirror = createCrmRecordMirrorStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const sampleConnection = (name = 'acme-hubspot'): ConnectionRecord => ({
  name,
  kind: 'api',
  display_name: name,
  config: { base_url: 'https://api.hubapi.com' },
  auth: { type: 'bearer', token: 'pat-token' },
  enrolled_at: 1,
  updated_at: 1,
});

interface MakeReconOpts {
  records?: ReadonlyArray<SlimRecord>;
  deletions?: ReadonlyArray<string>;
  webhookProcessor?: WebhookProcessor;
}

/** A default-write deal reconciler — `hashOf` + `toMeta` project the canonical
 *  fields (`name` / `amount`) the mirror carries. */
const makeDealReconciler = (opts: MakeReconOpts = {}): VendorReconciler => {
  const records = opts.records ?? [];
  const deletions = opts.deletions ?? [];
  const recon: VendorReconciler = {
    vendor: 'hubspot',
    entity: 'deal',
    default_cadence: '6h',
    async *listUpdatedSince(_conn, cursor) {
      for (const r of records) if (r.modified_at > cursor) yield r;
    },
    hashOf: (record) => `fnv1a:${record.id}-${record.modified_at}`,
    toMeta: (record): EnrichmentMeta => ({
      snapshot_at: record.modified_at,
      snapshot_hash: `fnv1a:${record.id}-${record.modified_at}`,
      name: `Deal ${record.id}`,
      amount: record.modified_at, // an arbitrary canonical field, value varies by record
    }),
  };
  if (deletions.length > 0) {
    recon.listDeletedSince = async function* (_conn, _cursor) {
      for (const id of deletions) yield id;
    };
  }
  if (opts.webhookProcessor) recon.webhookProcessor = opts.webhookProcessor;
  return recon;
};

const makeCtx = (overrides: Partial<HousekeepingContext> = {}): HousekeepingContext => ({
  db,
  bus: createWarehouseEventBus(),
  enrichmentStore,
  recipeStore: {} as unknown as HousekeepingContext['recipeStore'],
  now: () => 2_000_000_000_000,
  emitAuditRow: () => {},
  crmRecordMirror: mirror,
  ...overrides,
});

// ────────────────────────────────────────────────────────────────
// Reconciliation cycle path
// ────────────────────────────────────────────────────────────────

describe('D-190 — buildVendorReconciliationTask writes the mirror', () => {
  it('mirrors a record on first sighting WITH NO enrichment row (the producer-independent base-row write)', async () => {
    const task = buildVendorReconciliationTask({
      reconciler: makeDealReconciler({ records: [{ id: 'deal-1', modified_at: 1_000 }] }),
      connection_name: 'acme',
      lookupConnection: () => sampleConnection('acme'),
    });

    const result = await task.step(makeCtx(), { kind: 'time', last_seen_at: 0 }, 60_000);
    expect(result.status).toBe('complete');

    // The mirror carries the canonical projection...
    const rows = mirror.list(DEAL_SCOPE);
    expect(rows.map((r) => r.target_id)).toEqual(['deal-1']);
    expect(rows[0]!.meta.name).toBe('Deal deal-1');
    // ...even though NO enrichment row exists for it (the pre-D-190 path would
    // have left this deal invisible to deal.search).
    expect(enrichmentStore.listByTarget(DEAL_SCOPE, 'deal-1')).toHaveLength(0);
  });

  it('mirrors EVERY record in a batch unconditionally (completeness does not depend on an AI producer)', async () => {
    const task = buildVendorReconciliationTask({
      reconciler: makeDealReconciler({
        records: [
          { id: 'deal-1', modified_at: 1_000 },
          { id: 'deal-2', modified_at: 2_000 },
          { id: 'deal-3', modified_at: 3_000 },
        ],
      }),
      connection_name: 'acme',
      lookupConnection: () => sampleConnection('acme'),
    });

    await task.step(makeCtx(), { kind: 'time', last_seen_at: 0 }, 60_000);

    expect(mirror.list(DEAL_SCOPE).map((r) => r.target_id).sort()).toEqual([
      'deal-1',
      'deal-2',
      'deal-3',
    ]);
  });

  it('refreshes the mirror meta when a record changes across cycles (preserving created_at)', async () => {
    const lookup = () => sampleConnection('acme');
    // Cycle 1 — first sighting.
    await buildVendorReconciliationTask({
      reconciler: makeDealReconciler({ records: [{ id: 'deal-1', modified_at: 1_000 }] }),
      connection_name: 'acme',
      lookupConnection: lookup,
    }).step(makeCtx({ now: () => 10_000 }), { kind: 'time', last_seen_at: 0 }, 60_000);
    expect(mirror.list(DEAL_SCOPE)[0]!.meta.amount).toBe(1_000);

    // Cycle 2 — the deal moved (new modified_at → new hash + new projected amount).
    await buildVendorReconciliationTask({
      reconciler: makeDealReconciler({ records: [{ id: 'deal-1', modified_at: 5_000 }] }),
      connection_name: 'acme',
      lookupConnection: lookup,
    }).step(makeCtx({ now: () => 20_000 }), { kind: 'time', last_seen_at: 1_000 }, 60_000);

    expect(mirror.list(DEAL_SCOPE)[0]!.meta.amount).toBe(5_000);
    // created_at survives the refresh, updated_at advances.
    const raw = db
      .prepare('SELECT created_at, updated_at FROM crm_record_mirror WHERE target_id = ?')
      .get('deal-1') as { created_at: number; updated_at: number };
    expect(raw.created_at).toBe(10_000);
    expect(raw.updated_at).toBe(20_000);
  });

  it('drops the mirror row on a vendor delete (delete-cascade)', async () => {
    // Seed the mirror with two deals, then reconcile a delete of one.
    mirror.upsert({ scope: DEAL_SCOPE, target_id: 'deal-x', meta: { snapshot_at: 1, snapshot_hash: 'h', name: 'X' }, now: 1 });
    mirror.upsert({ scope: DEAL_SCOPE, target_id: 'deal-y', meta: { snapshot_at: 1, snapshot_hash: 'h', name: 'Y' }, now: 1 });

    const task = buildVendorReconciliationTask({
      reconciler: makeDealReconciler({ records: [], deletions: ['deal-x'] }),
      connection_name: 'acme',
      lookupConnection: () => sampleConnection('acme'),
    });
    await task.step(makeCtx(), { kind: 'time', last_seen_at: 0 }, 60_000);

    expect(mirror.list(DEAL_SCOPE).map((r) => r.target_id)).toEqual(['deal-y']);
  });

  it('does NOT mirror a selfIngest (engagement) reconciler — only default-write CRM records', async () => {
    const recon: VendorReconciler = {
      vendor: 'hubspot',
      entity: 'email',
      default_cadence: '6h',
      async *listUpdatedSince(_c, cursor) {
        for (const r of [{ id: 'eng-1', modified_at: 1_000 }]) if (r.modified_at > cursor) yield r;
      },
      selfIngest: () => { /* engagement write — not a CRM record */ },
    };
    const task = buildVendorReconciliationTask({
      reconciler: recon,
      connection_name: 'acme',
      lookupConnection: () => sampleConnection('acme'),
    });
    await task.step(makeCtx(), { kind: 'time', last_seen_at: 0 }, 60_000);

    expect(mirror.list(composeVendorEntityScope('hubspot', 'email'))).toEqual([]);
  });

  it('skips the mirror write cleanly when no mirror is wired (dbless harness parity)', async () => {
    const task = buildVendorReconciliationTask({
      reconciler: makeDealReconciler({ records: [{ id: 'deal-1', modified_at: 1_000 }] }),
      connection_name: 'acme',
      lookupConnection: () => sampleConnection('acme'),
    });
    // crmRecordMirror omitted — the harness `?.` short-circuits.
    const result = await task.step(makeCtx({ crmRecordMirror: undefined }), { kind: 'time', last_seen_at: 0 }, 60_000);
    expect(result.status).toBe('complete');
    expect(mirror.list(DEAL_SCOPE)).toEqual([]); // nothing written
  });
});

// ────────────────────────────────────────────────────────────────
// Webhook funnel path (Salesforce-CometD-style: no signature, in-process)
// ────────────────────────────────────────────────────────────────

/** A no-signature webhook processor (the OAuth-bound shape — Salesforce CometD,
 *  the live funnel driver), parsing `payload.events` into slim events. */
const dealWebhookProcessor: WebhookProcessor = {
  parseEvents(payload) {
    if (!payload || typeof payload !== 'object' || !('events' in payload)) return [];
    const raw = (payload as { events: ReadonlyArray<Record<string, unknown>> }).events;
    const out: WebhookSlimEvent[] = [];
    for (const e of raw) {
      if (e.entity !== 'deal') continue;
      if (e.kind === 'deleted') out.push({ kind: 'deleted', target_id: String(e.id) });
      else if (e.kind === 'created' || e.kind === 'updated') {
        out.push({ kind: e.kind, record: { id: String(e.id), modified_at: Number(e.modified_at) } });
      }
    }
    return out;
  },
};

const makeFunnel = () => {
  const registry = createReconcilerRegistry();
  registry.register(makeDealReconciler({ webhookProcessor: dealWebhookProcessor }));
  const lookup: ConnectionConfigLookup = (vendor, name) =>
    vendor === 'hubspot' && name === 'acme' ? {} : null;
  return createWebhookFunnel({
    registry,
    lookupConnectionConfig: lookup,
    enrichmentStore,
    bus: createWarehouseEventBus(),
    crmRecordMirror: mirror,
    now: () => 5_000,
  });
};

describe('D-190 — createWebhookFunnel writes the mirror', () => {
  it('mirrors a record on a webhook create event (keeps the mirror fresh between cycles)', async () => {
    const { handle } = makeFunnel();
    const payload = { events: [{ entity: 'deal', kind: 'created', id: 'deal-1', modified_at: 100 }] };
    const result = await handle({
      vendor: 'hubspot',
      connection_name: 'acme',
      payload,
      headers: {},
      rawBody: Buffer.from(JSON.stringify(payload)),
    });
    expect(result.ok).toBe(true);

    const rows = mirror.list(DEAL_SCOPE);
    expect(rows.map((r) => r.target_id)).toEqual(['deal-1']);
    expect(rows[0]!.meta.name).toBe('Deal deal-1');
  });

  it('drops the mirror row on a webhook delete event', async () => {
    mirror.upsert({ scope: DEAL_SCOPE, target_id: 'deal-1', meta: { snapshot_at: 1, snapshot_hash: 'h', name: 'D1' }, now: 1 });
    const { handle } = makeFunnel();
    const payload = { events: [{ entity: 'deal', kind: 'deleted', id: 'deal-1' }] };
    await handle({
      vendor: 'hubspot',
      connection_name: 'acme',
      payload,
      headers: {},
      rawBody: Buffer.from(JSON.stringify(payload)),
    });
    expect(mirror.list(DEAL_SCOPE)).toEqual([]);
  });
});

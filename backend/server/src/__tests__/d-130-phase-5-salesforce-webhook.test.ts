/** D-130 Phase 5 — Salesforce WebhookProcessor (CometD/PushTopic) tests.
 *
 *  Covers the substrate that ships at P5:
 *  - SALESFORCE_PUSHTOPIC_NAMES + SALESFORCE_SOBJECT_ID_PREFIXES
 *    closed-list registry shape.
 *  - In-memory replayId tracker monotonicity + per-(connection,
 *    channel) isolation + connection-scoped forget.
 *  - buildSalesforceWebhookProcessor channel-based fan-out per entity:
 *    cross-entity events drop to [], correct-entity events emit slim
 *    records.
 *  - Created / updated / deleted / undeleted event kinds map to the
 *    canonical WebhookSlimEvent shape.
 *  - ReplayId monotonicity rejects same-or-older replayIds; first-
 *    seen monotonic replayId records + emits.
 *  - Full record passthrough — no follow-up GET (the slim record's
 *    _raw carries the SObject fields directly).
 *  - SObject id prefix cross-validation rejects mis-routed events.
 *  - The webhook funnel skips HMAC verification when the processor
 *    declares no signature_header (OAuth-bound trust path).
 *  - Funnel still 404s when no reconciler exposes a webhookProcessor
 *    at all (vendor doesn't support webhook acceleration).
 *  - bin.ts boot wire forgets replayId state on connection delete.
 *
 *  CometD network client + PushTopic SOAP auto-creation + per-
 *  connection subscription lifecycle ship at P5.2 follow-up — those
 *  are out of scope here. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SALESFORCE_PUSHTOPIC_CHANNEL_PREFIX,
  SALESFORCE_PUSHTOPIC_NAMES,
  SALESFORCE_SOBJECT_ID_PREFIXES,
} from '@recued/contracts';

import {
  buildSalesforceWebhookProcessor,
  createInMemoryReplayIdTracker,
  type SalesforceCometDEvent,
  type SalesforceReplayIdTracker,
} from '../data/salesforce/webhook-processor.js';
import { wireSalesforceReconciliation } from '../data/salesforce/boot.js';
import { buildSalesforceReconcilers } from '../data/salesforce/registration.js';
import { createWebhookFunnel } from '../housekeeping/reconciliation/webhook-funnel.js';
import {
  createReconcilerRegistry,
  type ReconcilerRegistry,
} from '../housekeeping/reconciliation/reconciler-registry.js';
import {
  clearDefaultReconcilerRegistry,
  registerVendorReconciler,
} from '../housekeeping/reconciliation/reconciler-registry.js';
import {
  clearDefaultHousekeepingRegistry,
} from '../housekeeping/registry.js';
import {
  createConnectionStore,
  type ConnectionStoreSqlite,
} from '../storage/connection-store.js';
import type { EnrichmentStore } from '../storage/enrichment-store.js';
import type { WarehouseEventBus } from '@recued/warehouse-events';

// ────────────────────────────────────────────────────────────────
// Constants — assert closed-list shape from contracts
// ────────────────────────────────────────────────────────────────

describe('D-130 P5 — SALESFORCE_PUSHTOPIC_NAMES registry shape', () => {
  it('declares the canonical PushTopic names per spec § Constants', () => {
    expect(SALESFORCE_PUSHTOPIC_NAMES).toEqual({
      opportunity: 'RecuedOpportunityFeed',
      contact: 'RecuedContactFeed',
      account: 'RecuedAccountFeed',
    });
  });

  it('binds entity discriminators to the Salesforce SObject id prefix convention', () => {
    expect(SALESFORCE_SOBJECT_ID_PREFIXES.opportunity).toBe('006');
    expect(SALESFORCE_SOBJECT_ID_PREFIXES.contact).toBe('003');
    expect(SALESFORCE_SOBJECT_ID_PREFIXES.account).toBe('001');
  });

  it('namespaces channels under /topic/ — distinguishing PushTopic streaming from CDC (post-launch)', () => {
    expect(SALESFORCE_PUSHTOPIC_CHANNEL_PREFIX).toBe('/topic/');
  });
});

// ────────────────────────────────────────────────────────────────
// In-memory replayId tracker
// ────────────────────────────────────────────────────────────────

describe('D-130 P5 — createInMemoryReplayIdTracker', () => {
  it('starts empty for every key', () => {
    const tracker = createInMemoryReplayIdTracker();
    expect(tracker.getLastReplayId('acme', '/topic/RecuedOpportunityFeed')).toBeNull();
    expect(tracker.getLastReplayId('acme', '/topic/RecuedContactFeed')).toBeNull();
  });

  it('records monotonically and returns the highest seen', () => {
    const tracker = createInMemoryReplayIdTracker();
    tracker.recordReplayId('acme', '/topic/RecuedOpportunityFeed', 100);
    tracker.recordReplayId('acme', '/topic/RecuedOpportunityFeed', 105);
    tracker.recordReplayId('acme', '/topic/RecuedOpportunityFeed', 102); // late event — drops
    expect(tracker.getLastReplayId('acme', '/topic/RecuedOpportunityFeed')).toBe(105);
  });

  it('isolates state per (connection, channel)', () => {
    const tracker = createInMemoryReplayIdTracker();
    tracker.recordReplayId('acme', '/topic/RecuedOpportunityFeed', 100);
    tracker.recordReplayId('personal', '/topic/RecuedOpportunityFeed', 50);
    tracker.recordReplayId('acme', '/topic/RecuedContactFeed', 200);
    expect(tracker.getLastReplayId('acme', '/topic/RecuedOpportunityFeed')).toBe(100);
    expect(tracker.getLastReplayId('personal', '/topic/RecuedOpportunityFeed')).toBe(50);
    expect(tracker.getLastReplayId('acme', '/topic/RecuedContactFeed')).toBe(200);
  });

  it('forgetConnection drops every channel for the connection — leaves other connections intact', () => {
    const tracker = createInMemoryReplayIdTracker();
    tracker.recordReplayId('acme', '/topic/RecuedOpportunityFeed', 100);
    tracker.recordReplayId('acme', '/topic/RecuedContactFeed', 200);
    tracker.recordReplayId('personal', '/topic/RecuedOpportunityFeed', 50);
    tracker.forgetConnection('acme');
    expect(tracker.getLastReplayId('acme', '/topic/RecuedOpportunityFeed')).toBeNull();
    expect(tracker.getLastReplayId('acme', '/topic/RecuedContactFeed')).toBeNull();
    expect(tracker.getLastReplayId('personal', '/topic/RecuedOpportunityFeed')).toBe(50);
  });
});

// ────────────────────────────────────────────────────────────────
// WebhookProcessor — channel-based fan-out + event kinds
// ────────────────────────────────────────────────────────────────

const sampleOpportunityEvent = (
  overrides: Partial<SalesforceCometDEvent['data']['event']> = {},
  sobject: Partial<SalesforceCometDEvent['data']['sobject']> = {},
): SalesforceCometDEvent => ({
  channel: '/topic/RecuedOpportunityFeed',
  data: {
    event: {
      type: 'created',
      replayId: 1,
      createdDate: '2026-05-01T14:32:18.000Z',
      ...overrides,
    },
    sobject: {
      Id: '006A0000005XYZAB',
      Name: 'Acme Q3 Expansion',
      LastModifiedDate: '2026-05-01T14:32:18.000Z',
      ...sobject,
    },
  },
});

const sampleContactEvent = (
  overrides: Partial<SalesforceCometDEvent['data']['event']> = {},
  sobject: Partial<SalesforceCometDEvent['data']['sobject']> = {},
): SalesforceCometDEvent => ({
  channel: '/topic/RecuedContactFeed',
  data: {
    event: {
      type: 'created',
      replayId: 1,
      createdDate: '2026-05-01T14:32:18.000Z',
      ...overrides,
    },
    sobject: {
      Id: '003A0000005XYZAB',
      Email: 'bob@example.com',
      LastModifiedDate: '2026-05-01T14:32:18.000Z',
      ...sobject,
    },
  },
});

describe('D-130 P5 — buildSalesforceWebhookProcessor channel-based fan-out', () => {
  let tracker: SalesforceReplayIdTracker;
  beforeEach(() => {
    tracker = createInMemoryReplayIdTracker();
  });

  it('opportunity processor only emits events for the opportunity channel', async () => {
    const proc = buildSalesforceWebhookProcessor({ entity: 'opportunity', replayIdTracker: tracker });
    const out = await proc.parseEvents([sampleOpportunityEvent(), sampleContactEvent()], {}, 'acme');
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('created');
    if (out[0]!.kind !== 'created' && out[0]!.kind !== 'updated') throw new Error('expected create/update');
    expect(out[0]!.record.id).toBe('salesforce_opportunity_acme_006A0000005XYZAB');
  });

  it('contact processor only emits events for the contact channel', async () => {
    const proc = buildSalesforceWebhookProcessor({ entity: 'contact', replayIdTracker: tracker });
    const out = await proc.parseEvents([sampleOpportunityEvent(), sampleContactEvent()], {}, 'acme');
    expect(out).toHaveLength(1);
    if (out[0]!.kind !== 'created' && out[0]!.kind !== 'updated') throw new Error('expected create/update');
    expect(out[0]!.record.id).toBe('salesforce_contact_acme_003A0000005XYZAB');
  });

  it('emits [] when payload only carries different-entity events', async () => {
    const proc = buildSalesforceWebhookProcessor({ entity: 'account', replayIdTracker: tracker });
    const out = await proc.parseEvents([sampleOpportunityEvent(), sampleContactEvent()], {}, 'acme');
    expect(out).toEqual([]);
  });

  it('declares no signature_header (OAuth-bound — funnel skips HMAC)', () => {
    const proc = buildSalesforceWebhookProcessor({ entity: 'opportunity', replayIdTracker: tracker });
    expect(proc.signature_header).toBeUndefined();
  });

  it('extracts deliveryId from the highest replayId in the payload (best-effort dedup hint)', () => {
    const proc = buildSalesforceWebhookProcessor({ entity: 'opportunity', replayIdTracker: tracker });
    const id = proc.deliveryId?.(
      [
        sampleOpportunityEvent({ replayId: 100 }),
        sampleOpportunityEvent({ replayId: 200 }),
      ],
      {},
    );
    expect(id).toBe('salesforce:opportunity:200');
  });

  it('accepts a single envelope (not an array) as the payload shape', async () => {
    const proc = buildSalesforceWebhookProcessor({ entity: 'opportunity', replayIdTracker: tracker });
    const out = await proc.parseEvents(sampleOpportunityEvent(), {}, 'acme');
    expect(out).toHaveLength(1);
  });

  it('returns [] for malformed payloads (defensive — funnel marks as no-op)', async () => {
    const proc = buildSalesforceWebhookProcessor({ entity: 'opportunity', replayIdTracker: tracker });
    expect(await proc.parseEvents(null, {}, 'acme')).toEqual([]);
    expect(await proc.parseEvents({ totally: 'wrong shape' }, {}, 'acme')).toEqual([]);
    expect(await proc.parseEvents([{ broken: true }], {}, 'acme')).toEqual([]);
  });
});

describe('D-130 P5 — event kind mapping', () => {
  let tracker: SalesforceReplayIdTracker;
  beforeEach(() => {
    tracker = createInMemoryReplayIdTracker();
  });

  it('maps created → kind: "created" with full record passthrough', async () => {
    const proc = buildSalesforceWebhookProcessor({ entity: 'opportunity', replayIdTracker: tracker });
    const out = await proc.parseEvents(
      sampleOpportunityEvent({ type: 'created', replayId: 1 }, { Name: 'Big Deal', Amount: 999_000 }),
      {},
      'acme',
    );
    expect(out).toHaveLength(1);
    if (out[0]!.kind !== 'created') throw new Error('expected created');
    // Full record passthrough — _raw carries the SObject fields without
    // a follow-up GET.
    const raw = (out[0]!.record as unknown as { _raw: Record<string, unknown> })._raw;
    expect(raw.Name).toBe('Big Deal');
    expect(raw.Amount).toBe(999_000);
  });

  it('maps updated → kind: "updated"', async () => {
    const proc = buildSalesforceWebhookProcessor({ entity: 'opportunity', replayIdTracker: tracker });
    const out = await proc.parseEvents(
      sampleOpportunityEvent({ type: 'updated', replayId: 1 }),
      {},
      'acme',
    );
    expect(out[0]!.kind).toBe('updated');
  });

  it('maps deleted → kind: "deleted" carrying just the target_id (no record materialization)', async () => {
    const proc = buildSalesforceWebhookProcessor({ entity: 'opportunity', replayIdTracker: tracker });
    const out = await proc.parseEvents(
      sampleOpportunityEvent({ type: 'deleted', replayId: 1 }),
      {},
      'acme',
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('deleted');
    if (out[0]!.kind !== 'deleted') throw new Error('expected deleted');
    expect(out[0]!.target_id).toBe('salesforce_opportunity_acme_006A0000005XYZAB');
  });

  it('maps undeleted → kind: "created" (Recycle Bin restore = re-create on cascade engine side)', async () => {
    const proc = buildSalesforceWebhookProcessor({ entity: 'opportunity', replayIdTracker: tracker });
    const out = await proc.parseEvents(
      sampleOpportunityEvent({ type: 'undeleted', replayId: 1 }),
      {},
      'acme',
    );
    expect(out[0]!.kind).toBe('created');
  });

  it('drops unknown event types silently (forward-compat)', async () => {
    const proc = buildSalesforceWebhookProcessor({ entity: 'opportunity', replayIdTracker: tracker });
    const out = await proc.parseEvents(
      sampleOpportunityEvent({ type: 'rebooted' as 'created' }),
      {},
      'acme',
    );
    expect(out).toEqual([]);
  });

  it('drops events whose SObject id prefix mismatches the channel entity (defence-in-depth)', async () => {
    const proc = buildSalesforceWebhookProcessor({ entity: 'opportunity', replayIdTracker: tracker });
    // Channel says opportunity, but Id starts with 003 (contact prefix).
    const mismatched: SalesforceCometDEvent = {
      ...sampleOpportunityEvent(),
      data: {
        ...sampleOpportunityEvent().data,
        sobject: { Id: '003BADBAD000000', Name: 'Wrong entity', LastModifiedDate: '2026-05-01T00:00:00.000Z' },
      },
    };
    const out = await proc.parseEvents(mismatched, {}, 'acme');
    expect(out).toEqual([]);
  });

  it('drops events whose modified_at cannot be parsed (cursor cannot advance)', async () => {
    const proc = buildSalesforceWebhookProcessor({ entity: 'opportunity', replayIdTracker: tracker });
    const out = await proc.parseEvents(
      sampleOpportunityEvent({ createdDate: 'not-a-date' }, { LastModifiedDate: 'also-broken' }),
      {},
      'acme',
    );
    expect(out).toEqual([]);
  });
});

describe('D-130 P5 — replayId monotonicity reject', () => {
  let tracker: SalesforceReplayIdTracker;
  beforeEach(() => {
    tracker = createInMemoryReplayIdTracker();
  });

  it('rejects events whose replayId is <= the highest already-seen for (connection, channel)', async () => {
    const proc = buildSalesforceWebhookProcessor({ entity: 'opportunity', replayIdTracker: tracker });
    // First event: replayId 100 — recorded.
    const out1 = await proc.parseEvents(sampleOpportunityEvent({ replayId: 100 }), {}, 'acme');
    expect(out1).toHaveLength(1);
    // Same replayId — drops.
    const out2 = await proc.parseEvents(sampleOpportunityEvent({ replayId: 100 }), {}, 'acme');
    expect(out2).toEqual([]);
    // Smaller replayId — drops (stale reconnect with out-of-date cursor).
    const out3 = await proc.parseEvents(sampleOpportunityEvent({ replayId: 50 }), {}, 'acme');
    expect(out3).toEqual([]);
    // Higher replayId — accepted, advances tracker.
    const out4 = await proc.parseEvents(sampleOpportunityEvent({ replayId: 101 }), {}, 'acme');
    expect(out4).toHaveLength(1);
    expect(tracker.getLastReplayId('acme', '/topic/RecuedOpportunityFeed')).toBe(101);
  });

  it('isolates monotonicity per (connection, channel) — two connections never interfere', async () => {
    const proc = buildSalesforceWebhookProcessor({ entity: 'opportunity', replayIdTracker: tracker });
    await proc.parseEvents(sampleOpportunityEvent({ replayId: 500 }), {}, 'acme');
    // Different connection — its own replayId space starts fresh.
    const out = await proc.parseEvents(sampleOpportunityEvent({ replayId: 1 }), {}, 'personal');
    expect(out).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────
// Webhook funnel — skip HMAC when no signature_header
// ────────────────────────────────────────────────────────────────

const makeStubEnrichmentStore = (): EnrichmentStore => {
  // Minimal stub — only the methods the funnel calls under test paths.
  // Cast through `unknown` because we deliberately under-implement the
  // interface for this test's narrow assertions.
  const store = {
    listByTarget: () => [],
    refreshMetaForTarget: () => 0,
  };
  return store as unknown as EnrichmentStore;
};

const makeStubBus = (): WarehouseEventBus => {
  const events: unknown[] = [];
  return {
    emit: (e: unknown) => events.push(e),
    subscribe: () => () => undefined,
  } as unknown as WarehouseEventBus;
};

describe('D-130 P5 — funnel skips HMAC when processor declares no signature_header', () => {
  let registry: ReconcilerRegistry;
  let tracker: SalesforceReplayIdTracker;

  beforeEach(() => {
    registry = createReconcilerRegistry();
    tracker = createInMemoryReplayIdTracker();
    const reconcilers = buildSalesforceReconcilers({
      opportunity: {
        search: {
          fetcher: (async () => new Response('{}', { status: 200 })) as typeof fetch,
          refreshAuth: async () => ({
            type: 'oauth2_refresh',
            refresh_token: 'rt',
            client_id: 'c',
            client_secret: 's',
            token_endpoint: 'https://login.salesforce.com/services/oauth2/token',
            current_access_token: 'at',
            expires_at: Date.now() + 3_600_000,
          }),
        },
      },
      contact: {
        search: {
          fetcher: (async () => new Response('{}', { status: 200 })) as typeof fetch,
          refreshAuth: async () => ({
            type: 'oauth2_refresh',
            refresh_token: 'rt',
            client_id: 'c',
            client_secret: 's',
            token_endpoint: 'https://login.salesforce.com/services/oauth2/token',
            current_access_token: 'at',
            expires_at: Date.now() + 3_600_000,
          }),
        },
      },
      account: {
        search: {
          fetcher: (async () => new Response('{}', { status: 200 })) as typeof fetch,
          refreshAuth: async () => ({
            type: 'oauth2_refresh',
            refresh_token: 'rt',
            client_id: 'c',
            client_secret: 's',
            token_endpoint: 'https://login.salesforce.com/services/oauth2/token',
            current_access_token: 'at',
            expires_at: Date.now() + 3_600_000,
          }),
        },
      },
      replayIdTracker: tracker,
    });
    for (const r of reconcilers) registry.register(r);
  });

  it('processes a Salesforce CometD-shaped delivery without any signature header', async () => {
    const funnel = createWebhookFunnel({
      registry,
      lookupConnectionConfig: () => ({ base_url: 'https://acme.my.salesforce.com', vendor: 'salesforce' }),
      enrichmentStore: makeStubEnrichmentStore(),
      bus: makeStubBus(),
    });

    const payload: SalesforceCometDEvent = sampleOpportunityEvent({ replayId: 1 });
    const rawBody = Buffer.from(JSON.stringify(payload));
    const result = await funnel.handle({
      vendor: 'salesforce',
      connection_name: 'acme',
      payload,
      headers: {},
      rawBody,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // 1 created event processed (opportunity entity matches channel),
      // 0 from contact/account processors (their parseEvents return []).
      expect(result.processed).toBe(1);
      expect(result.deduped).toBe(0);
    }
  });

  it('still 404s when no reconciler exposes any webhookProcessor at all', async () => {
    const emptyRegistry = createReconcilerRegistry();
    // Register a Salesforce-vendor reconciler manually with no processor.
    emptyRegistry.register({
      vendor: 'salesforce',
      entity: 'opportunity',
      default_cadence: '6h',
      listUpdatedSince: async function* () {},
      hashOf: () => 'fnv1a:00000000',
      toMeta: () => ({ snapshot_at: 1, snapshot_hash: 'fnv1a:00000000' }),
    });
    const funnel = createWebhookFunnel({
      registry: emptyRegistry,
      lookupConnectionConfig: () => ({ vendor: 'salesforce' }),
      enrichmentStore: makeStubEnrichmentStore(),
      bus: makeStubBus(),
    });

    const result = await funnel.handle({
      vendor: 'salesforce',
      connection_name: 'acme',
      payload: sampleOpportunityEvent(),
      headers: {},
      rawBody: Buffer.from('{}'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('webhook_not_supported');
    }
  });
});

// ────────────────────────────────────────────────────────────────
// Boot wire — tracker.forgetConnection on connection delete
// ────────────────────────────────────────────────────────────────

describe('D-130 P5 — wireSalesforceReconciliation forgets replayId state on delete', () => {
  let dir: string;
  let db: Database.Database;
  let connectionStore: ConnectionStoreSqlite;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd-130-p5-boot-'));
    db = new Database(join(dir, 'test.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    connectionStore = createConnectionStore(db);
    clearDefaultReconcilerRegistry();
    clearDefaultHousekeepingRegistry();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    clearDefaultReconcilerRegistry();
    clearDefaultHousekeepingRegistry();
  });

  it('drops replayId tracker state for the deleted connection — re-enrollment starts fresh', () => {
    connectionStore.upsert({
      kind: 'api',
      name: 'temp',
      display_name: 'temp',
      config_json: JSON.stringify({
        base_url: 'https://acme.my.salesforce.com',
        vendor: 'salesforce',
        sandbox: 'production',
      }),
      auth_ciphertext: 'opaque',
      enrolled_at: 1,
      updated_at: 1,
    });

    const tracker = createInMemoryReplayIdTracker();
    const reconcilers = buildSalesforceReconcilers({
      opportunity: { search: { fetcher: (async () => new Response('{}', { status: 200 })) as typeof fetch, refreshAuth: async () => ({ type: 'oauth2_refresh', refresh_token: 'rt', client_id: 'c', client_secret: 's', token_endpoint: 'https://login.salesforce.com/services/oauth2/token', current_access_token: 'at', expires_at: Date.now() + 3_600_000 }) } },
      contact: { search: { fetcher: (async () => new Response('{}', { status: 200 })) as typeof fetch, refreshAuth: async () => ({ type: 'oauth2_refresh', refresh_token: 'rt', client_id: 'c', client_secret: 's', token_endpoint: 'https://login.salesforce.com/services/oauth2/token', current_access_token: 'at', expires_at: Date.now() + 3_600_000 }) } },
      account: { search: { fetcher: (async () => new Response('{}', { status: 200 })) as typeof fetch, refreshAuth: async () => ({ type: 'oauth2_refresh', refresh_token: 'rt', client_id: 'c', client_secret: 's', token_endpoint: 'https://login.salesforce.com/services/oauth2/token', current_access_token: 'at', expires_at: Date.now() + 3_600_000 }) } },
      replayIdTracker: tracker,
    });

    wireSalesforceReconciliation({
      connectionStore,
      reconcilers,
      lookupConnection: () => null,
      replayIdTracker: tracker,
    });

    // Seed replayId state.
    tracker.recordReplayId('temp', '/topic/RecuedOpportunityFeed', 100);
    expect(tracker.getLastReplayId('temp', '/topic/RecuedOpportunityFeed')).toBe(100);

    connectionStore.delete('api', 'temp');
    expect(tracker.getLastReplayId('temp', '/topic/RecuedOpportunityFeed')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// registration.ts — webhookProcessor refs attached
// ────────────────────────────────────────────────────────────────

describe('D-130 P5 — buildSalesforceReconcilers attaches webhookProcessor refs', () => {
  it('every reconciler in the trio has a webhookProcessor pointing at its entity processor', () => {
    const reconcilers = buildSalesforceReconcilers({
      opportunity: { search: { fetcher: (async () => new Response('{}', { status: 200 })) as typeof fetch, refreshAuth: async () => ({ type: 'oauth2_refresh', refresh_token: 'rt', client_id: 'c', client_secret: 's', token_endpoint: 'https://login.salesforce.com/services/oauth2/token', current_access_token: 'at', expires_at: Date.now() + 3_600_000 }) } },
      contact: { search: { fetcher: (async () => new Response('{}', { status: 200 })) as typeof fetch, refreshAuth: async () => ({ type: 'oauth2_refresh', refresh_token: 'rt', client_id: 'c', client_secret: 's', token_endpoint: 'https://login.salesforce.com/services/oauth2/token', current_access_token: 'at', expires_at: Date.now() + 3_600_000 }) } },
      account: { search: { fetcher: (async () => new Response('{}', { status: 200 })) as typeof fetch, refreshAuth: async () => ({ type: 'oauth2_refresh', refresh_token: 'rt', client_id: 'c', client_secret: 's', token_endpoint: 'https://login.salesforce.com/services/oauth2/token', current_access_token: 'at', expires_at: Date.now() + 3_600_000 }) } },
    });
    for (const r of reconcilers) {
      expect(r.webhookProcessor).toBeDefined();
      expect(r.webhookProcessor!.signature_header).toBeUndefined();
    }
  });
});

// Suppress unused-import warning when test file imports registerVendorReconciler
// purely for symmetry with the other test files — actual register() use happens
// via registry.register() above.
void registerVendorReconciler;

/** D-129 Phase 5 — HubSpot WebhookProcessor + getHubSpotObject tests.
 *
 *  Covers:
 *  - `buildHubSpotWebhookProcessor` per-entity factory: signature
 *    header + algorithm declaration; deliveryId extraction.
 *  - `parseEvents` async filtering by entity prefix
 *    (deal/contact/company) — different-entity events return [].
 *  - `*.deletion` short-circuit (no follow-up GET).
 *  - `*.creation` / `*.propertyChange` follow-up GET round-trip:
 *    materializes raw record, projects modified_at, attaches _raw.
 *  - Cross-entity payload fan-out — each entity processor sees all
 *    events but emits only its own.
 *  - Connection-lookup-returns-null graceful skip (no GETs).
 *  - 404 on follow-up GET → record skipped.
 *  - `getHubSpotObject` happy-path GET shape.
 *  - `getHubSpotObject` 401 single-shot refresh round-trip.
 *  - `getHubSpotObject` 429 backoff round-trip.
 *  - `getHubSpotObject` 404 → null.
 *  - End-to-end via funnel: webhook → parseEvents → hashOf → emit.
 *
 *  Reconciler-side concerns shared with P2 + P3 + P4 (HMAC verify,
 *  funnel dedup, listener HTTP plumbing) live in the D-128 P3 funnel
 *  test file; this file only exercises P5-specific behaviour. */

import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  HUBSPOT_CONTACT_PROPERTIES,
  HUBSPOT_DEAL_PROPERTIES,
  type ConnectionAuth,
  type ConnectionRecord,
} from '@recued/contracts';

import {
  HubSpotAuthExpiredError,
  HubSpotRateLimitedError,
  getHubSpotObject,
  type HubSpotSearchDeps,
  type RawHubSpotRecord,
} from '../data/hubspot/_hubspot-search.js';
import { buildHubSpotWebhookProcessor } from '../data/hubspot/webhook-processor.js';

// ────────────────────────────────────────────────────────────────
// Shared test harness
// ────────────────────────────────────────────────────────────────

const sampleAuth = (overrides: Partial<Extract<ConnectionAuth, { type: 'oauth2_refresh' }>> = {}): ConnectionAuth => ({
  type: 'oauth2_refresh',
  refresh_token: 'rt-1',
  client_id: 'cid-1',
  client_secret: 'cs-1',
  token_endpoint: 'https://api.hubapi.com/oauth/v1/token',
  current_access_token: 'access-1',
  expires_at: Date.now() + 3_600_000,
  ...overrides,
});

const sampleHubSpotConnection = (name = 'acme-hubspot'): ConnectionRecord => ({
  name,
  kind: 'api',
  display_name: name,
  config: { base_url: 'https://api.hubapi.com', vendor: 'hubspot' },
  auth: sampleAuth(),
  enrolled_at: 1,
  updated_at: 1,
});

const rawDeal = (
  overrides: Partial<RawHubSpotRecord['properties']> = {},
  id = '1234',
): RawHubSpotRecord => ({
  id,
  properties: {
    dealname: 'Acme Q3',
    dealstage: 'negotiation',
    amount: '50000',
    hs_lastmodifieddate: '1730294400000',
    ...overrides,
  },
});

const rawContact = (
  overrides: Partial<RawHubSpotRecord['properties']> = {},
  id = '5678',
): RawHubSpotRecord => ({
  id,
  properties: {
    email: 'bob@example.com',
    firstname: 'Bob',
    hs_lastmodifieddate: '1730294400000',
    ...overrides,
  },
});

const event = (
  subscriptionType: string,
  objectId: number,
  eventId = 1000 + objectId,
) => ({
  subscriptionType,
  objectId,
  eventId,
  occurredAt: 1730000000000,
  portalId: 42,
});

// ────────────────────────────────────────────────────────────────
// signature_header + algorithm + deliveryId
// ────────────────────────────────────────────────────────────────

describe('D-129 P5 — buildHubSpotWebhookProcessor static fields', () => {
  const proc = buildHubSpotWebhookProcessor({
    entity: 'deal',
    search: { refreshAuth: async () => sampleAuth() },
    lookupConnection: () => null,
    properties: HUBSPOT_DEAL_PROPERTIES,
  });

  it('declares X-HubSpot-Signature-v3 as the HMAC header', () => {
    expect(proc.signature_header).toBe('X-HubSpot-Signature-v3');
  });

  it('declares sha256 as the HMAC algorithm', () => {
    expect(proc.signature_algorithm).toBe('sha256');
  });

  it('extracts deliveryId from the first event\'s eventId', () => {
    const id = proc.deliveryId!([event('deal.creation', 1, 999), event('deal.propertyChange', 2, 1001)], {});
    expect(id).toBe('hubspot:999');
  });

  it('returns null deliveryId on malformed payload', () => {
    expect(proc.deliveryId!({ not: 'an array' }, {})).toBeNull();
    expect(proc.deliveryId!([], {})).toBeNull();
    expect(proc.deliveryId!([{ no: 'subscriptionType' }], {})).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// parseEvents — entity prefix filter
// ────────────────────────────────────────────────────────────────

describe('D-129 P5 — parseEvents entity prefix filter', () => {
  it('returns [] when payload has no events for this entity', async () => {
    const proc = buildHubSpotWebhookProcessor({
      entity: 'deal',
      search: { refreshAuth: async () => sampleAuth() },
      lookupConnection: () => null,
      properties: HUBSPOT_DEAL_PROPERTIES,
    });
    const out = await proc.parseEvents(
      [event('contact.creation', 1), event('company.deletion', 2)],
      {},
      'acme',
    );
    expect(out).toEqual([]);
  });

  it('returns [] on a non-array payload', async () => {
    const proc = buildHubSpotWebhookProcessor({
      entity: 'deal',
      search: { refreshAuth: async () => sampleAuth() },
      lookupConnection: () => null,
      properties: HUBSPOT_DEAL_PROPERTIES,
    });
    expect(await proc.parseEvents({ events: [] }, {}, 'acme')).toEqual([]);
    expect(await proc.parseEvents(null, {}, 'acme')).toEqual([]);
  });

  it('skips malformed entries silently and processes well-formed ones', async () => {
    const proc = buildHubSpotWebhookProcessor({
      entity: 'deal',
      search: { refreshAuth: async () => sampleAuth() },
      lookupConnection: () => null,
      properties: HUBSPOT_DEAL_PROPERTIES,
    });
    const out = await proc.parseEvents(
      [
        { not: 'a real event' },
        event('deal.deletion', 7),
      ],
      {},
      'acme',
    );
    expect(out).toEqual([
      { kind: 'deleted', target_id: 'hubspot_deal_acme_7' },
    ]);
  });
});

// ────────────────────────────────────────────────────────────────
// parseEvents — *.deletion short-circuit
// ────────────────────────────────────────────────────────────────

describe('D-129 P5 — parseEvents *.deletion short-circuit', () => {
  it('emits deleted events without any follow-up fetcher calls', async () => {
    const fetchCalls: string[] = [];
    const proc = buildHubSpotWebhookProcessor({
      entity: 'deal',
      search: {
        fetcher: (async (url: string | URL) => {
          fetchCalls.push(String(url));
          return new Response('{}', { status: 200 });
        }) as typeof fetch,
        refreshAuth: async () => sampleAuth(),
      },
      lookupConnection: () => sampleHubSpotConnection(),
      properties: HUBSPOT_DEAL_PROPERTIES,
    });

    const out = await proc.parseEvents(
      [event('deal.deletion', 100), event('deal.deletion', 101)],
      {},
      'acme',
    );

    expect(out).toEqual([
      { kind: 'deleted', target_id: 'hubspot_deal_acme_100' },
      { kind: 'deleted', target_id: 'hubspot_deal_acme_101' },
    ]);
    expect(fetchCalls).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// parseEvents — *.creation / *.propertyChange follow-up GET
// ────────────────────────────────────────────────────────────────

describe('D-129 P5 — parseEvents creation/propertyChange follow-up GET', () => {
  it('materializes the slim record via getHubSpotObject for *.creation', async () => {
    const fetcher = async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/objects/deals/1234')) {
        return new Response(JSON.stringify(rawDeal()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    };
    const proc = buildHubSpotWebhookProcessor({
      entity: 'deal',
      search: {
        fetcher: fetcher as typeof fetch,
        refreshAuth: async () => sampleAuth(),
      },
      lookupConnection: () => sampleHubSpotConnection(),
      properties: HUBSPOT_DEAL_PROPERTIES,
    });

    const out = await proc.parseEvents([event('deal.creation', 1234)], {}, 'acme');
    expect(out).toHaveLength(1);
    const e = out[0]!;
    expect(e.kind).toBe('created');
    if (e.kind === 'created' || e.kind === 'updated') {
      expect(e.record.id).toBe('hubspot_deal_acme_1234');
      expect(e.record.modified_at).toBe(1730294400000);
      expect((e.record as unknown as { _raw: RawHubSpotRecord })._raw.properties.dealname).toBe('Acme Q3');
    }
  });

  it('materializes the slim record + emits "updated" for *.propertyChange', async () => {
    const fetcher = async () =>
      new Response(JSON.stringify(rawDeal()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const proc = buildHubSpotWebhookProcessor({
      entity: 'deal',
      search: {
        fetcher: fetcher as typeof fetch,
        refreshAuth: async () => sampleAuth(),
      },
      lookupConnection: () => sampleHubSpotConnection(),
      properties: HUBSPOT_DEAL_PROPERTIES,
    });

    const out = await proc.parseEvents([event('deal.propertyChange', 1234)], {}, 'acme');
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('updated');
  });

  it('caches the connection lookup across multiple events in one delivery', async () => {
    let lookupCount = 0;
    const fetcher = async () =>
      new Response(JSON.stringify(rawDeal()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const proc = buildHubSpotWebhookProcessor({
      entity: 'deal',
      search: {
        fetcher: fetcher as typeof fetch,
        refreshAuth: async () => sampleAuth(),
      },
      lookupConnection: () => {
        lookupCount += 1;
        return sampleHubSpotConnection();
      },
      properties: HUBSPOT_DEAL_PROPERTIES,
    });

    await proc.parseEvents(
      [
        event('deal.creation', 1),
        event('deal.propertyChange', 2),
        event('deal.creation', 3),
      ],
      {},
      'acme',
    );

    expect(lookupCount).toBe(1);
  });

  it('skips when getHubSpotObject returns null (404 — record deleted between webhook + GET)', async () => {
    const fetcher = async () => new Response('gone', { status: 404 });
    const proc = buildHubSpotWebhookProcessor({
      entity: 'deal',
      search: {
        fetcher: fetcher as typeof fetch,
        refreshAuth: async () => sampleAuth(),
      },
      lookupConnection: () => sampleHubSpotConnection(),
      properties: HUBSPOT_DEAL_PROPERTIES,
    });

    const out = await proc.parseEvents([event('deal.creation', 1234)], {}, 'acme');
    expect(out).toEqual([]);
  });

  it('skips when raw record is missing hs_lastmodifieddate (cursor cannot advance for it)', async () => {
    const fetcher = async () =>
      new Response(
        JSON.stringify(rawDeal({ hs_lastmodifieddate: null })),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const proc = buildHubSpotWebhookProcessor({
      entity: 'deal',
      search: {
        fetcher: fetcher as typeof fetch,
        refreshAuth: async () => sampleAuth(),
      },
      lookupConnection: () => sampleHubSpotConnection(),
      properties: HUBSPOT_DEAL_PROPERTIES,
    });

    const out = await proc.parseEvents([event('deal.creation', 1234)], {}, 'acme');
    expect(out).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// parseEvents — connection lookup returns null → graceful skip
// ────────────────────────────────────────────────────────────────

describe('D-129 P5 — connection-lookup-null graceful skip', () => {
  it('emits delete events but skips creation/propertyChange when connection is null', async () => {
    const fetchCalls: string[] = [];
    const proc = buildHubSpotWebhookProcessor({
      entity: 'deal',
      search: {
        fetcher: (async (url: string | URL) => {
          fetchCalls.push(String(url));
          return new Response('{}', { status: 200 });
        }) as typeof fetch,
        refreshAuth: async () => sampleAuth(),
      },
      lookupConnection: () => null,
      properties: HUBSPOT_DEAL_PROPERTIES,
    });

    const out = await proc.parseEvents(
      [
        event('deal.deletion', 1),
        event('deal.creation', 2),
        event('deal.propertyChange', 3),
      ],
      {},
      'gone',
    );

    // Only the delete short-circuits without a connection.
    expect(out).toEqual([{ kind: 'deleted', target_id: 'hubspot_deal_gone_1' }]);
    expect(fetchCalls).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// Cross-entity fan-out — each processor filters its own
// ────────────────────────────────────────────────────────────────

describe('D-129 P5 — cross-entity payload fan-out', () => {
  it('contact processor sees a mixed payload but emits only contact events', async () => {
    const fetcher = async () =>
      new Response(JSON.stringify(rawContact()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const proc = buildHubSpotWebhookProcessor({
      entity: 'contact',
      search: {
        fetcher: fetcher as typeof fetch,
        refreshAuth: async () => sampleAuth(),
      },
      lookupConnection: () => sampleHubSpotConnection(),
      properties: HUBSPOT_CONTACT_PROPERTIES,
    });

    const out = await proc.parseEvents(
      [
        event('deal.creation', 1),
        event('contact.creation', 5678),
        event('company.deletion', 99),
        event('contact.deletion', 5679),
      ],
      {},
      'acme',
    );

    expect(out).toHaveLength(2);
    expect(out[0]!.kind).toBe('created');
    if (out[0]!.kind === 'created') {
      expect(out[0]!.record.id).toBe('hubspot_contact_acme_5678');
    }
    expect(out[1]).toEqual({ kind: 'deleted', target_id: 'hubspot_contact_acme_5679' });
  });
});

// ────────────────────────────────────────────────────────────────
// getHubSpotObject helper
// ────────────────────────────────────────────────────────────────

describe('D-129 P5 — getHubSpotObject GET shape', () => {
  it('GETs /crm/v3/objects/<type>/<id>?properties=<csv> with bearer token', async () => {
    const calls: Array<{ url: string; method?: string; headers: Record<string, string> }> = [];
    const fetcher = async (url: string | URL, init: RequestInit | undefined) => {
      calls.push({
        url: String(url),
        method: init?.method,
        headers: init?.headers as Record<string, string>,
      });
      return new Response(JSON.stringify(rawDeal()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const deps: HubSpotSearchDeps = {
      fetcher: fetcher as typeof fetch,
      refreshAuth: async () => sampleAuth(),
    };

    const result = await getHubSpotObject(
      sampleHubSpotConnection(),
      'deals',
      '1234',
      ['dealname', 'dealstage'],
      deps,
    );

    expect(result).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.hubapi.com/crm/v3/objects/deals/1234?properties=dealname,dealstage');
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.headers.Authorization).toBe('Bearer access-1');
  });

  it('returns null on 404', async () => {
    const fetcher = async () => new Response('not found', { status: 404 });
    const result = await getHubSpotObject(
      sampleHubSpotConnection(),
      'deals',
      '1234',
      ['dealname'],
      { fetcher: fetcher as typeof fetch, refreshAuth: async () => sampleAuth() },
    );
    expect(result).toBeNull();
  });

  it('refreshes auth + retries on a single 401', async () => {
    let callCount = 0;
    const tokens: string[] = [];
    const fetcher = async (_url: string | URL, init: RequestInit | undefined) => {
      callCount += 1;
      const headers = init?.headers as Record<string, string>;
      tokens.push(headers.Authorization?.replace('Bearer ', '') ?? '');
      if (callCount === 1) return new Response('{}', { status: 401 });
      return new Response(JSON.stringify(rawDeal()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const result = await getHubSpotObject(
      sampleHubSpotConnection(),
      'deals',
      '1234',
      ['dealname'],
      {
        fetcher: fetcher as typeof fetch,
        refreshAuth: async () => sampleAuth({ current_access_token: 'access-2' }),
      },
    );

    expect(result).not.toBeNull();
    expect(tokens).toEqual(['access-1', 'access-2']);
  });

  it('throws HubSpotAuthExpiredError when 401 persists after refresh', async () => {
    const fetcher = async () => new Response('{}', { status: 401 });
    await expect(
      getHubSpotObject(
        sampleHubSpotConnection(),
        'deals',
        '1234',
        ['dealname'],
        {
          fetcher: fetcher as typeof fetch,
          refreshAuth: async () => sampleAuth({ current_access_token: 'still-bad' }),
        },
      ),
    ).rejects.toBeInstanceOf(HubSpotAuthExpiredError);
  });

  it('retries on 429 + Retry-After then succeeds', async () => {
    const sleepCalls: number[] = [];
    let callCount = 0;
    const fetcher = async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response('{}', { status: 429, headers: { 'Retry-After': '1' } });
      }
      return new Response(JSON.stringify(rawDeal()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const result = await getHubSpotObject(
      sampleHubSpotConnection(),
      'deals',
      '1234',
      ['dealname'],
      {
        fetcher: fetcher as typeof fetch,
        refreshAuth: async () => sampleAuth(),
        sleep: async (ms) => {
          sleepCalls.push(ms);
        },
      },
    );

    expect(result).not.toBeNull();
    expect(sleepCalls).toEqual([1_000]);
  });

  it('throws HubSpotRateLimitedError after exhausting 429 retries', async () => {
    const fetcher = async () =>
      new Response('{}', { status: 429, headers: { 'Retry-After': '1' } });
    await expect(
      getHubSpotObject(
        sampleHubSpotConnection(),
        'deals',
        '1234',
        ['dealname'],
        {
          fetcher: fetcher as typeof fetch,
          refreshAuth: async () => sampleAuth(),
          sleep: async () => undefined,
          rateLimitMaxRetries: 1,
        },
      ),
    ).rejects.toBeInstanceOf(HubSpotRateLimitedError);
  });

  it('URL-encodes the object id in the path', async () => {
    let observedUrl = '';
    const fetcher = async (url: string | URL) => {
      observedUrl = String(url);
      return new Response(JSON.stringify(rawDeal()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    await getHubSpotObject(
      sampleHubSpotConnection(),
      'deals',
      'id with spaces/and-slash',
      ['dealname'],
      { fetcher: fetcher as typeof fetch, refreshAuth: async () => sampleAuth() },
    );

    expect(observedUrl).toContain('id%20with%20spaces%2Fand-slash');
  });
});

// ────────────────────────────────────────────────────────────────
// End-to-end via funnel — webhook → parseEvents → emit
// ────────────────────────────────────────────────────────────────

describe('D-129 P5 — end-to-end via funnel', () => {
  it('webhook delivery flows through funnel + processor + reconciler hashOf to emit a synthetic warehouse event', async () => {
    // Lazy imports to keep the helper import-side small.
    const { createWarehouseEventBus } = await import('@recued/warehouse-events');
    const { createReconcilerRegistry } = await import(
      '../housekeeping/reconciliation/reconciler-registry.js'
    );
    const { createWebhookFunnel } = await import(
      '../housekeeping/reconciliation/webhook-funnel.js'
    );
    const { HubSpotDealReconciler } = await import('../data/hubspot/deal-reconciler.js');

    const fetcher = async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/objects/deals/1234')) {
        return new Response(
          JSON.stringify(rawDeal({}, '1234')),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    };
    const lookupConnection = () => sampleHubSpotConnection();
    const search: HubSpotSearchDeps = {
      fetcher: fetcher as typeof fetch,
      refreshAuth: async () => sampleAuth(),
    };

    const webhookProcessor = buildHubSpotWebhookProcessor({
      entity: 'deal',
      search,
      lookupConnection,
      properties: HUBSPOT_DEAL_PROPERTIES,
    });

    const reconciler = new HubSpotDealReconciler({ search, webhookProcessor });

    const registry = createReconcilerRegistry();
    registry.register(reconciler);

    const events: unknown[] = [];
    const bus = createWarehouseEventBus();
    bus.subscribe('**', (e) => events.push(e));

    // In-memory enrichment store — minimal stub.
    const enrichmentStore = {
      listByTarget: () => [],
      refreshMetaForTarget: () => undefined,
    } as unknown as Parameters<typeof createWebhookFunnel>[0]['enrichmentStore'];

    const funnel = createWebhookFunnel({
      registry,
      lookupConnectionConfig: () => ({
        base_url: 'https://api.hubapi.com',
        webhook_secret: 'shh',
        vendor: 'hubspot',
      }),
      enrichmentStore,
      bus,
    });

    const payload = [event('deal.creation', 1234)];
    const rawBody = Buffer.from(JSON.stringify(payload));
    // DOCUMENT-AND-DEFER: this signs the GENERIC body-only-hex scheme the
    // funnel verifies today — NOT HubSpot's real Signature-v3
    // (`base64(HMAC over method+uri+body+timestamp)` + freshness, D-129
    // §173-175). The receiver is wired-but-undriven (no live HubSpot
    // subscription), so this exercises the funnel plumbing, not v3 auth.
    // When webhooks are productized, replace this with a real-v3 sig +
    // freshness assertion. See the verify call site in `webhook-funnel.ts`.
    const sig = `sha256=${createHmac('sha256', 'shh').update(rawBody).digest('hex')}`;

    const result = await funnel.handle({
      vendor: 'hubspot',
      connection_name: 'acme-hubspot',
      payload,
      headers: { 'x-hubspot-signature-v3': sig },
      rawBody,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.processed).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      platform: 'connection.api.hubspot.deal',
      slug: 'acme-hubspot',
      entity_type: 'deal',
      event_kind: 'created',
      record_id: 'hubspot_deal_acme-hubspot_1234',
    });
  });
});

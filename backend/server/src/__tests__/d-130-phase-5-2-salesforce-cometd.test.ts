/** D-130 Phase 5.2 — Salesforce CometD subscriber + PushTopic SOAP +
 *  per-connection subscription lifecycle tests.
 *
 *  Covers the network-plumbing layer that ships at P5.2:
 *  - PushTopic SOAP idempotency: SOQL existence check short-circuits
 *    when all canonical names exist; SOAP-creates only the missing
 *    ones with a canonical Query + Notify-flag set.
 *  - SOAP envelope shape: SessionHeader, Partner namespace,
 *    NotifyForFields=Referenced, ApiVersion bare-numeric, all four
 *    NotifyForOperation* flags true.
 *  - 401 single-flight refresh on the SOQL list path.
 *  - Bayeux protocol: handshake captures clientId; subscribe pulls
 *    replayId per channel from the shared tracker; long-poll
 *    dispatches /topic/* events through onEvent.
 *  - Reconnect-with-replayId resume: tracker records replayIds as
 *    events flow through (via the webhook processor wired in P5);
 *    the next handshake's subscribe carries the highest seen value
 *    per channel.
 *  - stop() aborts the in-flight long-poll, sends disconnect best-
 *    effort, and is idempotent.
 *  - Lifecycle wiring: boot scan starts subscribers for every
 *    existing Salesforce connection; upsert/delete hooks fire the
 *    same start/stop cycle.
 *
 *  The CometD network client is exercised via a per-call HTTP
 *  fetcher stub. Subsequent /meta/connect responses HANG (resolving
 *  only when the AbortSignal fires), accurately modelling Salesforce's
 *  long-poll behaviour and preventing the loop from tight-looping in
 *  test mode. Tests stop the subscriber explicitly after the first
 *  cycle settles. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SALESFORCE_API_VERSION,
  SALESFORCE_COMETD_PATH,
  SALESFORCE_ENTITY_NAMES,
  SALESFORCE_PUSHTOPIC_API_VERSION,
  SALESFORCE_PUSHTOPIC_NAMES,
  SALESFORCE_SOAP_PARTNER_PATH,
  type ConnectionAuth,
  type ConnectionRecord,
} from '@recued/contracts';

import { buildSalesforceCometDSubscriber } from '../data/salesforce/cometd-subscriber.js';
import {
  ensurePushTopics,
  pushTopicQueryFor,
} from '../data/salesforce/pushtopic-soap.js';
import { wireSalesforceCometDLifecycle } from '../data/salesforce/cometd-lifecycle.js';
import {
  createInMemoryReplayIdTracker,
  type SalesforceCometDEvent,
} from '../data/salesforce/webhook-processor.js';
import {
  createConnectionStore,
  type ConnectionStoreSqlite,
} from '../storage/connection-store.js';

// ────────────────────────────────────────────────────────────────
// Shared fixtures
// ────────────────────────────────────────────────────────────────

const INSTANCE_URL = 'https://acme.my.salesforce.com';

const buildConnection = (
  overrides: Partial<ConnectionRecord> = {},
): ConnectionRecord => ({
  name: 'acme',
  kind: 'api',
  display_name: 'Acme Salesforce',
  config: {
    base_url: INSTANCE_URL,
    vendor: 'salesforce',
    sandbox: 'production',
  },
  auth: buildAuth(),
  enrolled_at: 1,
  updated_at: 1,
  ...overrides,
});

const buildAuth = (): ConnectionAuth => ({
  type: 'oauth2_refresh',
  refresh_token: 'rt',
  client_id: 'c',
  client_secret: 's',
  token_endpoint: 'https://login.salesforce.com/services/oauth2/token',
  current_access_token: 'access-token-1',
  expires_at: Date.now() + 3_600_000,
});

interface RecordedCall {
  url: string;
  method: string;
  body: string;
  headers: Record<string, string>;
}

/** Build a Promise that resolves only when the AbortSignal fires —
 *  models Salesforce's long-poll behavior in test fetchers. The
 *  resolve-with-empty path keeps `await`s safe (no unhandled rejection)
 *  while the subscriber's loop bails on `stopRequested` after abort. */
const hangUntilAbort = (signal: AbortSignal | undefined): Promise<Response> =>
  new Promise<Response>((resolve) => {
    if (!signal) return; // never resolves — only safe under explicit timeout
    if (signal.aborted) {
      resolve(new Response('[]', { status: 200 }));
      return;
    }
    signal.addEventListener('abort', () => {
      resolve(new Response('[]', { status: 200 }));
    });
  });

// ────────────────────────────────────────────────────────────────
// PushTopic SOAP — idempotent provisioning
// ────────────────────────────────────────────────────────────────

describe('D-130 P5.2 — ensurePushTopics idempotency + envelope', () => {
  it('short-circuits when all canonical PushTopic names already exist', async () => {
    const calls: RecordedCall[] = [];
    const fetcher = (async (
      url: string,
      init: RequestInit = {},
    ): Promise<Response> => {
      calls.push({
        url,
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? init.body : '',
        headers: (init.headers ?? {}) as Record<string, string>,
      });
      // SOQL list: return all three names — every PushTopic exists.
      const records = SALESFORCE_ENTITY_NAMES.map((entity) => ({
        Id: `0fL${entity}`,
        Name: SALESFORCE_PUSHTOPIC_NAMES[entity],
      }));
      return new Response(JSON.stringify({ records, done: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const result = await ensurePushTopics(buildConnection(), {
      fetcher,
      refreshAuth: async (c) => c.auth,
    });

    expect(result.created).toEqual([]);
    expect(result.existed).toEqual([
      SALESFORCE_PUSHTOPIC_NAMES.opportunity,
      SALESFORCE_PUSHTOPIC_NAMES.contact,
      SALESFORCE_PUSHTOPIC_NAMES.account,
    ]);
    // Only the SOQL list call happened — no SOAP creates.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/services/data/');
    expect(calls[0]!.url).toContain('FROM%20PushTopic');
  });

  it('creates only the missing PushTopics; existing ones short-circuit', async () => {
    const calls: RecordedCall[] = [];
    const fetcher = (async (
      url: string,
      init: RequestInit = {},
    ): Promise<Response> => {
      calls.push({
        url,
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? init.body : '',
        headers: (init.headers ?? {}) as Record<string, string>,
      });
      if (init.method === 'POST') {
        // SOAP create — return success envelope.
        return new Response(
          '<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><createResponse><result><id>0fLABC</id><success>true</success></result></createResponse></soapenv:Body></soapenv:Envelope>',
          { status: 200, headers: { 'Content-Type': 'text/xml' } },
        );
      }
      // SOQL list: only opportunity exists; contact + account missing.
      return new Response(
        JSON.stringify({
          records: [{ Id: '0fLOPP', Name: SALESFORCE_PUSHTOPIC_NAMES.opportunity }],
          done: true,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    const result = await ensurePushTopics(buildConnection(), {
      fetcher,
      refreshAuth: async (c) => c.auth,
    });

    expect(result.existed).toEqual([SALESFORCE_PUSHTOPIC_NAMES.opportunity]);
    expect(result.created).toEqual([
      SALESFORCE_PUSHTOPIC_NAMES.contact,
      SALESFORCE_PUSHTOPIC_NAMES.account,
    ]);
    // 1 list + 2 SOAP creates.
    expect(calls).toHaveLength(3);
    expect(calls[1]!.method).toBe('POST');
    expect(calls[1]!.url).toBe(`${INSTANCE_URL}${SALESFORCE_SOAP_PARTNER_PATH}`);
    // SOAP envelope shape — contains the canonical Query + version pin
    // + every NotifyForOperation flag true + NotifyForFields=Referenced.
    expect(calls[1]!.body).toContain('xsi:type="PushTopic"');
    expect(calls[1]!.body).toContain(`<Name>${SALESFORCE_PUSHTOPIC_NAMES.contact}</Name>`);
    expect(calls[1]!.body).toContain(`<ApiVersion>${SALESFORCE_PUSHTOPIC_API_VERSION}</ApiVersion>`);
    expect(calls[1]!.body).toContain('<NotifyForOperationCreate>true</NotifyForOperationCreate>');
    expect(calls[1]!.body).toContain('<NotifyForOperationUpdate>true</NotifyForOperationUpdate>');
    expect(calls[1]!.body).toContain('<NotifyForOperationDelete>true</NotifyForOperationDelete>');
    expect(calls[1]!.body).toContain('<NotifyForOperationUndelete>true</NotifyForOperationUndelete>');
    expect(calls[1]!.body).toContain('<NotifyForFields>Referenced</NotifyForFields>');
    expect(calls[1]!.body).toContain(pushTopicQueryFor('contact'));
    // Auth flows in via SessionHeader (Partner SOAP convention),
    // never as Bearer for SOAP — explicit assertion to keep the
    // contract pinned.
    expect(calls[1]!.body).toContain('<urn:sessionId>access-token-1</urn:sessionId>');
    const headers = calls[1]!.headers;
    expect(headers['Content-Type'] ?? headers['content-type']).toContain('text/xml');
    expect(headers.SOAPAction ?? headers.soapaction).toBe('""');
  });

  it('refreshes + retries on 401 from the SOQL list', async () => {
    let listCalls = 0;
    const refreshes: number[] = [];
    const fetcher = (async (url: string): Promise<Response> => {
      if (url.includes('/query?')) {
        listCalls += 1;
        if (listCalls === 1) {
          return new Response('{"message":"unauthorized"}', { status: 401 });
        }
        return new Response(
          JSON.stringify({ records: SALESFORCE_ENTITY_NAMES.map((entity) => ({
            Name: SALESFORCE_PUSHTOPIC_NAMES[entity],
          })), done: true }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url: ${url}`);
    }) as typeof fetch;

    const result = await ensurePushTopics(buildConnection(), {
      fetcher,
      refreshAuth: async (c) => {
        refreshes.push(refreshes.length + 1);
        return { ...c.auth, current_access_token: 'access-token-2' } as ConnectionAuth;
      },
    });

    expect(refreshes).toHaveLength(1);
    expect(listCalls).toBe(2);
    expect(result.created).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// CometD subscriber — Bayeux protocol mechanics
// ────────────────────────────────────────────────────────────────

interface BayeuxCallLog {
  channel: string;
  body: ReadonlyArray<Record<string, unknown>>;
}

const buildBayeuxFetcher = (
  scenario: {
    /** Called for the n'th /meta/connect (1-indexed). The default
     *  behavior: first cycle returns an empty quiet ack, every
     *  subsequent cycle hangs until aborted (modelling Salesforce's
     *  long-poll). Override for event-delivery + advice-driven
     *  scenarios. */
    onConnect?: (sequence: number, signal: AbortSignal | undefined) => Promise<Response>;
    onSubscribe?: (channels: ReadonlyArray<string>) => Response;
    onHandshake?: (sequence: number) => Response;
    onDisconnect?: () => Response;
  } = {},
): { fetcher: typeof fetch; calls: BayeuxCallLog[] } => {
  const calls: BayeuxCallLog[] = [];
  let handshakes = 0;
  let connects = 0;
  const fetcher = (async (
    _url: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const bodyText = typeof init.body === 'string' ? init.body : '';
    let parsed: ReadonlyArray<Record<string, unknown>> = [];
    try {
      parsed = JSON.parse(bodyText) as ReadonlyArray<Record<string, unknown>>;
    } catch {
      parsed = [];
    }
    const channel = String(parsed[0]?.channel ?? '');
    calls.push({ channel, body: parsed });
    const signal = (init as RequestInit & { signal?: AbortSignal }).signal;

    if (channel === '/meta/handshake') {
      handshakes += 1;
      const fn = scenario.onHandshake;
      if (fn) return fn(handshakes);
      return new Response(
        JSON.stringify([{
          channel: '/meta/handshake',
          successful: true,
          clientId: `client-${handshakes}`,
          version: '1.0',
          supportedConnectionTypes: ['long-polling'],
        }]),
        { status: 200 },
      );
    }
    if (channel === '/meta/subscribe') {
      const subscribed = parsed.map((m) => String(m.subscription ?? ''));
      const fn = scenario.onSubscribe;
      if (fn) return fn(subscribed);
      const acks = subscribed.map((sub) => ({
        channel: '/meta/subscribe',
        subscription: sub,
        successful: true,
      }));
      return new Response(JSON.stringify(acks), { status: 200 });
    }
    if (channel === '/meta/connect') {
      connects += 1;
      const fn = scenario.onConnect;
      if (fn) return await fn(connects, signal);
      // Default: first cycle returns an immediate quiet ack so tests
      // observe one onLongPollSettle; subsequent cycles hang to model
      // real Salesforce long-poll behavior.
      if (connects === 1) {
        return new Response(
          JSON.stringify([{ channel: '/meta/connect', successful: true }]),
          { status: 200 },
        );
      }
      return await hangUntilAbort(signal);
    }
    if (channel === '/meta/disconnect') {
      const fn = scenario.onDisconnect;
      if (fn) return fn();
      return new Response(
        JSON.stringify([{ channel: '/meta/disconnect', successful: true }]),
        { status: 200 },
      );
    }
    return new Response('[]', { status: 200 });
  }) as typeof fetch;
  return { fetcher, calls };
};

/** Run the subscriber for one long-poll cycle, then stop it. Centralizes
 *  the lifecycle dance every subscriber test needs. */
const runOneCycle = async (subscriberDeps: {
  fetcher: typeof fetch;
  tracker: ReturnType<typeof createInMemoryReplayIdTracker>;
  lookupConnection?: () => Promise<ConnectionRecord | null>;
  refreshAuth?: (c: ConnectionRecord) => Promise<ConnectionAuth>;
  onEvent?: (e: SalesforceCometDEvent) => void;
  reconnectBaseMs?: number;
  cyclesToWait?: number;
}): Promise<void> => {
  const cyclesToWait = subscriberDeps.cyclesToWait ?? 1;
  let cycles = 0;
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
  const subscriber = buildSalesforceCometDSubscriber({
    connection_name: 'acme',
    lookupConnection: subscriberDeps.lookupConnection ?? (async () => buildConnection()),
    refreshAuth: subscriberDeps.refreshAuth ?? (async (c) => c.auth),
    replayIdTracker: subscriberDeps.tracker,
    onEvent: subscriberDeps.onEvent ?? (() => {}),
    fetcher: subscriberDeps.fetcher,
    sleep: async () => {},
    ...(subscriberDeps.reconnectBaseMs !== undefined
      ? { reconnectBaseMs: subscriberDeps.reconnectBaseMs }
      : {}),
    onLongPollSettle: () => {
      cycles += 1;
      if (cycles >= cyclesToWait) resolveSettled();
    },
  });
  await subscriber.start();
  await settled;
  await subscriber.stop();
};

describe('D-130 P5.2 — CometD subscriber Bayeux protocol', () => {
  it('handshake + subscribe pulls replayId per channel from the tracker (first run = -1)', async () => {
    const tracker = createInMemoryReplayIdTracker();
    const { fetcher, calls } = buildBayeuxFetcher();
    await runOneCycle({ fetcher, tracker });

    const handshake = calls.find((c) => c.channel === '/meta/handshake')!;
    expect(handshake).toBeDefined();
    expect(handshake.body[0]!.version).toBe('1.0');
    expect((handshake.body[0]!.ext as Record<string, unknown>).replay).toBe(true);

    const subscribes = calls.filter((c) => c.channel === '/meta/subscribe');
    // One batched call carries three subscribe messages — one per
    // channel — each with replay: -1 (first-run).
    expect(subscribes).toHaveLength(1);
    expect(subscribes[0]!.body).toHaveLength(SALESFORCE_ENTITY_NAMES.length);
    for (const entity of SALESFORCE_ENTITY_NAMES) {
      const channel = `/topic/${SALESFORCE_PUSHTOPIC_NAMES[entity]}`;
      const sub = subscribes[0]!.body.find((m) => m.subscription === channel);
      expect(sub).toBeDefined();
      const replay = ((sub!.ext as Record<string, unknown>).replay) as Record<string, number>;
      expect(replay[channel]).toBe(-1);
    }
  });

  it('subscribe carries last-seen replayId per channel after events flow through', async () => {
    const tracker = createInMemoryReplayIdTracker();
    // Simulate a previous session — events landed and the tracker
    // recorded the highest replayId per channel.
    tracker.recordReplayId('acme', '/topic/RecuedOpportunityFeed', 100);
    tracker.recordReplayId('acme', '/topic/RecuedContactFeed', 200);
    // (account left untouched — confirms first-time channels still get -1)

    const { fetcher, calls } = buildBayeuxFetcher();
    await runOneCycle({ fetcher, tracker });

    const subscribe = calls.find((c) => c.channel === '/meta/subscribe')!;
    const oppSub = subscribe.body.find((m) => m.subscription === '/topic/RecuedOpportunityFeed')!;
    const contactSub = subscribe.body.find((m) => m.subscription === '/topic/RecuedContactFeed')!;
    const accountSub = subscribe.body.find((m) => m.subscription === '/topic/RecuedAccountFeed')!;

    expect(((oppSub.ext as Record<string, unknown>).replay as Record<string, number>)['/topic/RecuedOpportunityFeed']).toBe(100);
    expect(((contactSub.ext as Record<string, unknown>).replay as Record<string, number>)['/topic/RecuedContactFeed']).toBe(200);
    expect(((accountSub.ext as Record<string, unknown>).replay as Record<string, number>)['/topic/RecuedAccountFeed']).toBe(-1);
  });

  it('long-poll dispatches /topic/* events to onEvent, drops /meta/connect ack', async () => {
    const tracker = createInMemoryReplayIdTracker();
    const event: SalesforceCometDEvent = {
      channel: '/topic/RecuedOpportunityFeed',
      data: {
        event: { type: 'created', replayId: 100, createdDate: '2026-05-01T12:00:00Z' },
        sobject: { Id: '006A0', Name: 'Acme Q3', LastModifiedDate: '2026-05-01T12:00:00Z' },
      },
    };
    const { fetcher } = buildBayeuxFetcher({
      onConnect: async (seq, signal) => {
        if (seq === 1) {
          return new Response(
            JSON.stringify([
              event,
              { channel: '/meta/connect', successful: true },
            ]),
            { status: 200 },
          );
        }
        return await hangUntilAbort(signal);
      },
    });
    const received: SalesforceCometDEvent[] = [];
    await runOneCycle({
      fetcher,
      tracker,
      onEvent: (e) => { received.push(e); },
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.channel).toBe('/topic/RecuedOpportunityFeed');
    expect(received[0]!.data.event.type).toBe('created');
    expect(received[0]!.data.event.replayId).toBe(100);
  });

  it('reconnects after server requests /meta/handshake — second handshake reuses tracker state', async () => {
    const tracker = createInMemoryReplayIdTracker();
    tracker.recordReplayId('acme', '/topic/RecuedOpportunityFeed', 50);
    const { fetcher, calls } = buildBayeuxFetcher({
      onConnect: async (seq, signal) => {
        if (seq === 1) {
          // First connect: ack with advice:reconnect:handshake. Loop
          // tears the session down + restarts from handshake.
          return new Response(
            JSON.stringify([{
              channel: '/meta/connect',
              successful: true,
              advice: { reconnect: 'handshake' },
            }]),
            { status: 200 },
          );
        }
        if (seq === 2) {
          // Second cycle (post-reconnect): quiet ack so onLongPollSettle
          // fires and the test can observe the second handshake.
          return new Response(
            JSON.stringify([{ channel: '/meta/connect', successful: true }]),
            { status: 200 },
          );
        }
        return await hangUntilAbort(signal);
      },
    });
    await runOneCycle({ fetcher, tracker, reconnectBaseMs: 1, cyclesToWait: 2 });

    const handshakes = calls.filter((c) => c.channel === '/meta/handshake');
    expect(handshakes.length).toBeGreaterThanOrEqual(2);
    // The second handshake's subscribe MUST carry the recorded
    // replayId — proves resume across reconnect.
    const subscribes = calls.filter((c) => c.channel === '/meta/subscribe');
    expect(subscribes.length).toBeGreaterThanOrEqual(2);
    const lastSubscribe = subscribes[subscribes.length - 1]!;
    const oppSub = lastSubscribe.body.find((m) => m.subscription === '/topic/RecuedOpportunityFeed')!;
    expect(((oppSub.ext as Record<string, unknown>).replay as Record<string, number>)['/topic/RecuedOpportunityFeed']).toBe(50);
  });

  it('refreshes once on 401 from handshake', async () => {
    const tracker = createInMemoryReplayIdTracker();
    let handshakeAttempt = 0;
    const refreshes: number[] = [];
    const { fetcher } = buildBayeuxFetcher({
      onHandshake: () => {
        handshakeAttempt += 1;
        if (handshakeAttempt === 1) {
          return new Response('unauthorized', { status: 401 });
        }
        return new Response(
          JSON.stringify([{
            channel: '/meta/handshake',
            successful: true,
            clientId: `client-${handshakeAttempt}`,
          }]),
          { status: 200 },
        );
      },
    });
    await runOneCycle({
      fetcher,
      tracker,
      refreshAuth: async (c) => {
        refreshes.push(refreshes.length + 1);
        return { ...c.auth, current_access_token: 'access-token-2' } as ConnectionAuth;
      },
    });
    expect(refreshes).toHaveLength(1);
    expect(handshakeAttempt).toBe(2);
  });

  it('stop() is idempotent + sends /meta/disconnect best-effort', async () => {
    const tracker = createInMemoryReplayIdTracker();
    const { fetcher, calls } = buildBayeuxFetcher();
    let cycles = 0;
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const subscriber = buildSalesforceCometDSubscriber({
      connection_name: 'acme',
      lookupConnection: async () => buildConnection(),
      refreshAuth: async (c) => c.auth,
      replayIdTracker: tracker,
      onEvent: () => {},
      fetcher,
      sleep: async () => {},
      onLongPollSettle: () => {
        cycles += 1;
        if (cycles === 1) resolveSettled();
      },
    });
    await subscriber.start();
    await settled;
    await subscriber.stop();
    // Second stop() is a no-op (idempotent).
    await subscriber.stop();
    expect(subscriber.state()).toBe('stopped');
    const disconnects = calls.filter((c) => c.channel === '/meta/disconnect');
    expect(disconnects).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────
// Lifecycle wiring — boot scan + upsert + delete
// ────────────────────────────────────────────────────────────────

describe('D-130 P5.2 — wireSalesforceCometDLifecycle store-observer pattern', () => {
  let dir: string;
  let db: Database.Database;
  let connectionStore: ConnectionStoreSqlite;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd-130-p5-2-lifecycle-'));
    db = new Database(join(dir, 'test.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    connectionStore = createConnectionStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Build a fetcher that handles both PushTopic SOAP + Bayeux. The
   *  /meta/connect path returns a quiet ack on the first call (so the
   *  subscriber's start() resolves cleanly + subscriber state is
   *  observable) and hangs on subsequent calls (so the loop doesn't
   *  tight-loop between cycles). */
  const buildAllInOneFetcher = (): {
    fetcher: typeof fetch;
    soapCalls: () => number;
    connectCount: () => number;
  } => {
    const counters = { soapCalls: 0, connectCount: 0 };
    const fetcher = (async (
      url: string,
      init: RequestInit = {},
    ): Promise<Response> => {
      const signal = (init as RequestInit & { signal?: AbortSignal }).signal;
      const body = typeof init.body === 'string' ? init.body : '';
      // Bayeux long-poll endpoint
      if (url.includes(SALESFORCE_COMETD_PATH)) {
        if (body.includes('"channel":"/meta/handshake"')) {
          return new Response(
            JSON.stringify([{
              channel: '/meta/handshake',
              successful: true,
              clientId: 'client-1',
            }]),
            { status: 200 },
          );
        }
        if (body.includes('"channel":"/meta/subscribe"')) {
          const acks = SALESFORCE_ENTITY_NAMES.map((entity) => ({
            channel: '/meta/subscribe',
            subscription: `/topic/${SALESFORCE_PUSHTOPIC_NAMES[entity]}`,
            successful: true,
          }));
          return new Response(JSON.stringify(acks), { status: 200 });
        }
        if (body.includes('"channel":"/meta/connect"')) {
          counters.connectCount += 1;
          if (counters.connectCount === 1) {
            return new Response(
              JSON.stringify([{ channel: '/meta/connect', successful: true }]),
              { status: 200 },
            );
          }
          return await hangUntilAbort(signal);
        }
        if (body.includes('"channel":"/meta/disconnect"')) {
          return new Response(
            JSON.stringify([{ channel: '/meta/disconnect', successful: true }]),
            { status: 200 },
          );
        }
        return new Response('[]', { status: 200 });
      }
      // PushTopic SOQL list
      if (url.includes(`/services/data/${SALESFORCE_API_VERSION}/query`)) {
        // All exist — short-circuit; lifecycle's ensurePushTopics
        // returns no creates so SOAP path stays untouched.
        const records = SALESFORCE_ENTITY_NAMES.map((entity) => ({
          Id: `0fL${entity}`,
          Name: SALESFORCE_PUSHTOPIC_NAMES[entity],
        }));
        return new Response(
          JSON.stringify({ records, done: true }),
          { status: 200 },
        );
      }
      // PushTopic SOAP create (unused in tests where all exist)
      if (url.includes(SALESFORCE_SOAP_PARTNER_PATH)) {
        counters.soapCalls += 1;
        return new Response(
          '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><createResponse><result><id>0fL</id><success>true</success></result></createResponse></soapenv:Body></soapenv:Envelope>',
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    return {
      fetcher,
      soapCalls: () => counters.soapCalls,
      connectCount: () => counters.connectCount,
    };
  };

  /** Helper: poll until the lifecycle reports the named connection
   *  active. The lifecycle's start path is fire-and-forget at the
   *  observer-hook layer; we wait until provisioning + start settle. */
  const waitForActive = async (
    handle: { listActive(): ReadonlyArray<string> },
    name: string,
    timeoutMs = 2_000,
  ): Promise<void> => {
    const start = Date.now();
    while (!handle.listActive().includes(name)) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`subscriber for '${name}' never came up`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  it('boot scan starts subscribers for every existing Salesforce connection', async () => {
    // Seed two Salesforce connections + one HubSpot to confirm filter.
    connectionStore.upsert({
      kind: 'api',
      name: 'sf-prod',
      display_name: 'sf-prod',
      config_json: JSON.stringify({ base_url: INSTANCE_URL, vendor: 'salesforce' }),
      auth_ciphertext: 'opaque',
      enrolled_at: 1,
      updated_at: 1,
    });
    connectionStore.upsert({
      kind: 'api',
      name: 'sf-sandbox',
      display_name: 'sf-sandbox',
      config_json: JSON.stringify({ base_url: INSTANCE_URL, vendor: 'salesforce' }),
      auth_ciphertext: 'opaque',
      enrolled_at: 2,
      updated_at: 2,
    });
    connectionStore.upsert({
      kind: 'api',
      name: 'hs',
      display_name: 'hs',
      config_json: JSON.stringify({ vendor: 'hubspot' }),
      auth_ciphertext: 'opaque',
      enrolled_at: 3,
      updated_at: 3,
    });

    const { fetcher } = buildAllInOneFetcher();
    const tracker = createInMemoryReplayIdTracker();
    const handle = wireSalesforceCometDLifecycle({
      connectionStore,
      lookupConnection: async (name) => {
        if (name === 'sf-prod' || name === 'sf-sandbox') {
          return buildConnection({ name });
        }
        return null;
      },
      refreshAuth: async (c) => c.auth,
      replayIdTracker: tracker,
      onEvent: async () => {},
      fetcher,
      sleep: async () => {},
    });

    await waitForActive(handle, 'sf-prod');
    await waitForActive(handle, 'sf-sandbox');
    expect([...handle.listActive()].sort()).toEqual(['sf-prod', 'sf-sandbox']);
    // HubSpot row was filtered out — never starts a subscriber.
    expect(handle.listActive()).not.toContain('hs');

    await handle.stopAll();
  });

  it('upsert hook starts a new subscriber; delete hook stops it', async () => {
    const { fetcher } = buildAllInOneFetcher();
    const tracker = createInMemoryReplayIdTracker();
    const handle = wireSalesforceCometDLifecycle({
      connectionStore,
      lookupConnection: async () => buildConnection(),
      refreshAuth: async (c) => c.auth,
      replayIdTracker: tracker,
      onEvent: async () => {},
      fetcher,
      sleep: async () => {},
    });

    expect(handle.listActive()).toEqual([]);

    connectionStore.upsert({
      kind: 'api',
      name: 'acme',
      display_name: 'Acme',
      config_json: JSON.stringify({ base_url: INSTANCE_URL, vendor: 'salesforce' }),
      auth_ciphertext: 'opaque',
      enrolled_at: 1,
      updated_at: 1,
    });

    await waitForActive(handle, 'acme');
    expect(handle.listActive()).toEqual(['acme']);

    connectionStore.delete('api', 'acme');

    // Wait until the subscriber drops off (delete hook is fire-and-forget).
    const deadline = Date.now() + 2_000;
    while (handle.listActive().includes('acme')) {
      if (Date.now() > deadline) throw new Error('subscriber for acme never stopped');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(handle.listActive()).toEqual([]);
  });

  it('duplicate upserts under the same name do not double-start the subscriber', async () => {
    const { fetcher } = buildAllInOneFetcher();
    const tracker = createInMemoryReplayIdTracker();
    const handle = wireSalesforceCometDLifecycle({
      connectionStore,
      lookupConnection: async () => buildConnection(),
      refreshAuth: async (c) => c.auth,
      replayIdTracker: tracker,
      onEvent: async () => {},
      fetcher,
      sleep: async () => {},
    });

    // Two upserts back-to-back under the same name (e.g. token rotation).
    connectionStore.upsert({
      kind: 'api',
      name: 'acme',
      display_name: 'Acme',
      config_json: JSON.stringify({ base_url: INSTANCE_URL, vendor: 'salesforce' }),
      auth_ciphertext: 'opaque',
      enrolled_at: 1,
      updated_at: 1,
    });
    connectionStore.upsert({
      kind: 'api',
      name: 'acme',
      display_name: 'Acme',
      config_json: JSON.stringify({ base_url: INSTANCE_URL, vendor: 'salesforce' }),
      auth_ciphertext: 'opaque',
      enrolled_at: 1,
      updated_at: 2, // refresh
    });

    await waitForActive(handle, 'acme');
    // listActive returns one entry — the second upsert is a no-op.
    expect(handle.listActive()).toEqual(['acme']);

    await handle.stopAll();
  });
});

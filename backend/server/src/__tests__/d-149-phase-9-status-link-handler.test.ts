/** D-149 P9 § A.5.6 — status_link GET integration tests.
 *
 *  Covers:
 *    - Token-less GET returns 401.
 *    - Authorized GET renders the read-only projection HTML with
 *      security headers (CSP / no-store / X-Frame-Options DENY /
 *      Referrer-Policy no-referrer / X-Content-Type-Options nosniff).
 *    - Auto-refresh meta tag emits when `auto_refresh_enabled === true`,
 *      omitted otherwise.
 *    - User-only fields (out-of-ceiling source row entries —
 *      internal_codename / vendor_contracts / slack_thread_url /
 *      itinerary booking codes) ABSENT from rendered HTML (no-leak
 *      invariant per § Must Hold I-13).
 *    - JSON polling endpoint (`?format=json`) returns the closed
 *      envelope.
 *    - JSON polling envelope contains only declared fields per
 *      projection.
 *    - POST returns 405 (status_link is GET-only).
 *    - Missing projection row → placeholder (substrate boot anomaly).
 *    - Missing entity (null reader) → placeholder. */

import Database from 'better-sqlite3';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { StatusLinkConfig } from '@recued/contracts';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import { createPublicEndpointRegistryStore } from '../storage/public-endpoint-registry-store.js';
import { createReceptionStatusProjectionStore } from '../storage/reception-status-projection-store.js';
import { createReceptionRateLimiter } from '../ports/reception/rate-limiter.js';
import { createReceptionRegistryCache } from '../ports/reception/registry-cache.js';
import { createReceptionPortHandler } from '../ports/reception/handler.js';
import {
  computeBearerHmac,
  deriveReceptionPepper,
} from '../ports/reception/server-secret-pepper.js';
import type { StatusEntitySourceReader } from '../ports/reception/handlers/status-link.js';

const NOW = 1_700_000_000_000;
const PEPPER = deriveReceptionPepper(Buffer.alloc(32, 0xc4));
const DAY = 24 * 60 * 60 * 1000;
const ENTITY_UPDATED_AT = NOW - 2 * DAY;

const buildEnv = () => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const store = createPublicEndpointRegistryStore(db);
  const cache = createReceptionRegistryCache();
  const limiter = createReceptionRateLimiter({ db });
  const projectionStore = createReceptionStatusProjectionStore(db);
  return { db, store, cache, limiter, projectionStore };
};

const baseConfig: StatusLinkConfig = {
  display_name: 'Mary',
  caption: 'Live updates',
  projection_kind: 'project',
  source_ref: { kind: 'data.project', project_id: 'proj-42' },
  refresh_policy: { auto_refresh_enabled: true, refresh_interval_seconds: 60 },
  comments_enabled: false,
  shows_update_history: true,
  expiry_days: 30,
};

const ENDPOINT_ID = 'ep-status-1';

const insertEndpoint = (
  env: ReturnType<typeof buildEnv>,
  bearer: string,
  config: StatusLinkConfig = baseConfig,
) => {
  env.store.create({
    endpoint_id: ENDPOINT_ID,
    kind: 'status_link',
    packet_declaration: {
      packet_kind: 'status_link_packet',
      source_query_ref: { kind: 'data.project', project_id: 'proj-42' },
    },
    bearer_secret_hmac: computeBearerHmac(bearer, PEPPER),
    created_at: NOW - DAY,
    created_by_client_id: 'inst-1',
    expires_at: null,
    long_lived_acknowledged_at: NOW - DAY,
    metadata: config as unknown as Record<string, unknown>,
  });
  env.store.enable(ENDPOINT_ID, NOW);
  env.projectionStore.create({
    projection_id: ENDPOINT_ID,
    endpoint_id: ENDPOINT_ID,
    projection_kind: config.projection_kind,
    source_entity_kind: config.source_ref.kind,
    source_entity_id:
      config.source_ref.kind === 'data.project'
        ? (config.source_ref as { project_id: string }).project_id
        : '',
    refresh_policy: config.refresh_policy,
    comments_enabled: config.comments_enabled,
    shows_update_history: config.shows_update_history,
  });
  return ENDPOINT_ID;
};

const fakeReq = (
  method: string,
  url: string,
  headers?: Record<string, string>,
): IncomingMessage => {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: '203.0.113.9' });
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = url;
  Object.assign(req.headers, headers ?? {});
  return req;
};

const fakeRes = () => {
  const bodyChunks: Array<string | Buffer> = [];
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    end(body?: string | Buffer) {
      if (body !== undefined) bodyChunks.push(body);
    },
    write(body: string | Buffer) {
      bodyChunks.push(body);
    },
    get body(): string {
      return bodyChunks
        .map((c) => (typeof c === 'string' ? c : c.toString('utf8')))
        .join('');
    },
    get status(): number {
      return res.statusCode;
    },
  } as unknown as ServerResponse & { status: number; body: string };
  return res;
};

const readerReturning = (
  row: Readonly<Record<string, unknown>>,
  updated_at: number = ENTITY_UPDATED_AT,
): StatusEntitySourceReader => ({
  read: () => ({ row, last_updated_at: updated_at }),
});

const NULL_READER: StatusEntitySourceReader = { read: () => null };

const buildHandler = (
  env: ReturnType<typeof buildEnv>,
  reader: StatusEntitySourceReader,
) =>
  createReceptionPortHandler({
    getStore: () => env.store,
    getCache: () => env.cache,
    getRateLimiter: () => env.limiter,
    getPepper: () => PEPPER,
    now: () => NOW,
    getStatusProjectionStore: () => env.projectionStore,
    getStatusEntitySourceReader: () => reader,
  });

const PROJECT_ROW_LEAKY = {
  title: 'Q3 Launch',
  state: 'in_progress',
  open_commitment_count: 3,
  last_activity_at_relative: '2 hours ago',
  milestone_summary: 'Phase 2 done',
  // These MUST NEVER reach the visitor's HTML / JSON.
  internal_codename: 'project-shadow',
  vendor_contracts: ['contract-1', 'contract-2'],
  slack_thread_url: 'https://example.slack.com/archives/secret-thread',
  budget_total_cents: 1_500_000,
};

// ────────────────────────────────────────────────────────────────
// GET HTML tests
// ────────────────────────────────────────────────────────────────

describe('D-149 P9 § A.5.6 — GET /reception/status/<id> (HTML)', () => {
  it('returns 401 when no token is supplied', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env, readerReturning(PROJECT_ROW_LEAKY));
    const res = fakeRes();
    await handler(fakeReq('GET', `/reception/status/${ENDPOINT_ID}`), res);
    expect(res.status).toBe(401);
  });

  it('renders the projection HTML with security headers when token is valid', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env, readerReturning(PROJECT_ROW_LEAKY));
    const res = fakeRes();
    await handler(fakeReq('GET', `/reception/status/${ENDPOINT_ID}?t=goodbearer`), res);
    expect(res.status).toBe(200);
    expect(res.body).toContain('<html');
    expect(res.body).toContain('Mary');
    expect(res.body).toContain('Live updates');
    expect(res.body).toContain('Q3 Launch');
    expect(res.body).toContain('in_progress');
    expect(res.body).toContain('Phase 2 done');

    const get = (k: string) =>
      typeof res.getHeader(k) === 'string' ? (res.getHeader(k) as string) : '';
    expect(get('content-type')).toContain('text/html');
    expect(get('cache-control')).toContain('no-store');
    expect(get('x-frame-options').toUpperCase()).toBe('DENY');
    expect(get('referrer-policy')).toBe('no-referrer');
    expect(get('x-content-type-options')).toBe('nosniff');
  });

  it('emits auto-refresh meta when auto_refresh_enabled=true', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env, readerReturning(PROJECT_ROW_LEAKY));
    const res = fakeRes();
    await handler(fakeReq('GET', `/reception/status/${ENDPOINT_ID}?t=goodbearer`), res);
    expect(res.status).toBe(200);
    expect(res.body).toContain('<meta http-equiv="refresh" content="60">');
  });

  it('omits auto-refresh meta when auto_refresh_enabled=false', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer', {
      ...baseConfig,
      refresh_policy: { auto_refresh_enabled: false },
    });
    const handler = buildHandler(env, readerReturning(PROJECT_ROW_LEAKY));
    const res = fakeRes();
    await handler(fakeReq('GET', `/reception/status/${ENDPOINT_ID}?t=goodbearer`), res);
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('http-equiv="refresh"');
  });

  it('no-leak: HTML never contains out-of-ceiling source fields', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env, readerReturning(PROJECT_ROW_LEAKY));
    const res = fakeRes();
    await handler(fakeReq('GET', `/reception/status/${ENDPOINT_ID}?t=goodbearer`), res);
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('project-shadow');
    expect(res.body).not.toContain('contract-1');
    expect(res.body).not.toContain('contract-2');
    expect(res.body).not.toContain('slack.com');
    expect(res.body).not.toContain('1500000');
    expect(res.body).not.toContain('1_500_000');
    expect(res.body).not.toContain('budget_total_cents');
  });

  it('itinerary projection strips booking codes + confirmation numbers from rendered legs', async () => {
    const env = buildEnv();
    const cfg: StatusLinkConfig = {
      ...baseConfig,
      projection_kind: 'itinerary',
      source_ref: { kind: 'data.itinerary', itinerary_id: 'it-1' },
    };
    // The reader returns out-of-ceiling fields on the leg objects; the
    // substrate's per-field redactor MUST strip them at the boundary.
    const reader = readerReturning({
      title: 'NYC trip',
      date_range: { start_at: NOW, end_at: NOW + 5 * DAY },
      visible_legs: [
        {
          origin: 'SFO',
          destination: 'JFK',
          mode: 'flight',
          time: '08:00',
          confirmation_number: 'PNR12345',
          booking_code: 'BC-9876',
          loyalty_id: 'AA-LOYALTY',
        },
      ],
      vendor_contract_ref: 'vc-1',
    });
    env.store.create({
      endpoint_id: ENDPOINT_ID,
      kind: 'status_link',
      packet_declaration: {
        packet_kind: 'status_link_packet',
        source_query_ref: { kind: 'data.itinerary', itinerary_id: 'it-1' },
      },
      bearer_secret_hmac: computeBearerHmac('goodbearer', PEPPER),
      created_at: NOW - DAY,
      created_by_client_id: 'inst-1',
      expires_at: null,
      long_lived_acknowledged_at: NOW - DAY,
      metadata: cfg as unknown as Record<string, unknown>,
    });
    env.store.enable(ENDPOINT_ID, NOW);
    env.projectionStore.create({
      projection_id: ENDPOINT_ID,
      endpoint_id: ENDPOINT_ID,
      projection_kind: 'itinerary',
      source_entity_kind: 'data.itinerary',
      source_entity_id: 'it-1',
      refresh_policy: cfg.refresh_policy,
      comments_enabled: false,
      shows_update_history: true,
    });
    const handler = buildHandler(env, reader);
    const res = fakeRes();
    await handler(fakeReq('GET', `/reception/status/${ENDPOINT_ID}?t=goodbearer`), res);
    expect(res.status).toBe(200);
    expect(res.body).toContain('SFO');
    expect(res.body).toContain('JFK');
    expect(res.body).not.toContain('PNR12345');
    expect(res.body).not.toContain('BC-9876');
    expect(res.body).not.toContain('AA-LOYALTY');
    expect(res.body).not.toContain('vendor_contract_ref');
    expect(res.body).not.toContain('vc-1');
  });

  it('null reader → placeholder (entity missing / out of scope)', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env, NULL_READER);
    const res = fakeRes();
    await handler(fakeReq('GET', `/reception/status/${ENDPOINT_ID}?t=goodbearer`), res);
    expect(res.status).toBe(503);
    expect(res.body).toContain('not currently available');
  });

  it('missing projection row → placeholder (substrate boot anomaly)', async () => {
    const env = buildEnv();
    // Insert endpoint but skip projection-row seeding.
    env.store.create({
      endpoint_id: ENDPOINT_ID,
      kind: 'status_link',
      packet_declaration: {
        packet_kind: 'status_link_packet',
        source_query_ref: { kind: 'data.project', project_id: 'proj-42' },
      },
      bearer_secret_hmac: computeBearerHmac('goodbearer', PEPPER),
      created_at: NOW - DAY,
      created_by_client_id: 'inst-1',
      expires_at: null,
      long_lived_acknowledged_at: NOW - DAY,
      metadata: baseConfig as unknown as Record<string, unknown>,
    });
    env.store.enable(ENDPOINT_ID, NOW);
    const handler = buildHandler(env, readerReturning(PROJECT_ROW_LEAKY));
    const res = fakeRes();
    await handler(fakeReq('GET', `/reception/status/${ENDPOINT_ID}?t=goodbearer`), res);
    expect(res.status).toBe(503);
  });
});

// ────────────────────────────────────────────────────────────────
// GET JSON tests (?format=json)
// ────────────────────────────────────────────────────────────────

describe('D-149 P9 § A.5.6 — GET /reception/status/<id>?format=json', () => {
  it('returns the closed JSON envelope', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env, readerReturning(PROJECT_ROW_LEAKY));
    const res = fakeRes();
    await handler(
      fakeReq('GET', `/reception/status/${ENDPOINT_ID}?t=goodbearer&format=json`),
      res,
    );
    expect(res.status).toBe(200);
    const get = (k: string) =>
      typeof res.getHeader(k) === 'string' ? (res.getHeader(k) as string) : '';
    expect(get('content-type')).toContain('application/json');
    expect(get('cache-control')).toContain('no-store');
    expect(get('referrer-policy')).toBe('no-referrer');
    expect(get('x-content-type-options')).toBe('nosniff');
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.endpoint_id).toBe(ENDPOINT_ID);
    expect(body.projection_kind).toBe('project');
    expect(body.next_refresh_in_seconds).toBe(60);
    expect(typeof body.last_updated_at_relative).toBe('string');
    expect(body.updates_visible).toBe(true);
    expect(body.comments_enabled).toBe(false);
    const visible = body.visible_fields as Record<string, unknown>;
    expect(visible.title).toBe('Q3 Launch');
    expect(visible.state).toBe('in_progress');
    expect(visible.open_commitment_count).toBe(3);
  });

  it('JSON envelope strips out-of-ceiling fields (no-leak)', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env, readerReturning(PROJECT_ROW_LEAKY));
    const res = fakeRes();
    await handler(
      fakeReq('GET', `/reception/status/${ENDPOINT_ID}?t=goodbearer&format=json`),
      res,
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    const visible = body.visible_fields as Record<string, unknown>;
    expect(visible).not.toHaveProperty('internal_codename');
    expect(visible).not.toHaveProperty('vendor_contracts');
    expect(visible).not.toHaveProperty('slack_thread_url');
    expect(visible).not.toHaveProperty('budget_total_cents');
  });

  it('JSON envelope NEVER carries the bearer or source ref', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env, readerReturning(PROJECT_ROW_LEAKY));
    const res = fakeRes();
    await handler(
      fakeReq('GET', `/reception/status/${ENDPOINT_ID}?t=goodbearer&format=json`),
      res,
    );
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('goodbearer');
    expect(res.body).not.toContain('source_ref');
    expect(res.body).not.toContain('proj-42');
    expect(res.body).not.toContain('bearer_secret');
  });

  it('next_refresh_in_seconds is null when auto_refresh_enabled=false', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer', {
      ...baseConfig,
      refresh_policy: { auto_refresh_enabled: false },
    });
    const handler = buildHandler(env, readerReturning(PROJECT_ROW_LEAKY));
    const res = fakeRes();
    await handler(
      fakeReq('GET', `/reception/status/${ENDPOINT_ID}?t=goodbearer&format=json`),
      res,
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.next_refresh_in_seconds).toBeNull();
  });

  it('Accept: application/json (no ?format=json) also returns JSON', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env, readerReturning(PROJECT_ROW_LEAKY));
    const res = fakeRes();
    await handler(
      fakeReq('GET', `/reception/status/${ENDPOINT_ID}?t=goodbearer`, {
        accept: 'application/json',
      }),
      res,
    );
    expect(res.status).toBe(200);
    const get = (k: string) =>
      typeof res.getHeader(k) === 'string' ? (res.getHeader(k) as string) : '';
    expect(get('content-type')).toContain('application/json');
  });
});

// ────────────────────────────────────────────────────────────────
// Non-GET methods
// ────────────────────────────────────────────────────────────────

describe('D-149 P9 § A.5.6 — non-GET methods', () => {
  it('POST returns 405', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env, readerReturning(PROJECT_ROW_LEAKY));
    const res = fakeRes();
    await handler(fakeReq('POST', `/reception/status/${ENDPOINT_ID}?t=goodbearer`), res);
    expect(res.status).toBe(405);
    expect(res.getHeader('allow')).toBe('GET');
  });

  it('DELETE returns 405', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env, readerReturning(PROJECT_ROW_LEAKY));
    const res = fakeRes();
    await handler(fakeReq('DELETE', `/reception/status/${ENDPOINT_ID}?t=goodbearer`), res);
    expect(res.status).toBe(405);
  });

  it('verb segment beyond endpoint_id returns 404', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env, readerReturning(PROJECT_ROW_LEAKY));
    const res = fakeRes();
    await handler(
      fakeReq('GET', `/reception/status/${ENDPOINT_ID}/edit?t=goodbearer`),
      res,
    );
    expect(res.status).toBe(404);
  });
});

// ────────────────────────────────────────────────────────────────
// Deps-absent fallback
// ────────────────────────────────────────────────────────────────

describe('D-149 P9 § A.5.6 — deps-absent fallback', () => {
  it('falls back to 503 stub when status deps not wired', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    // Build handler without the status_link deps — mimics boot-state
    // where bin.ts hasn't yet wired the projection store or reader.
    const handler = createReceptionPortHandler({
      getStore: () => env.store,
      getCache: () => env.cache,
      getRateLimiter: () => env.limiter,
      getPepper: () => PEPPER,
      now: () => NOW,
    });
    const res = fakeRes();
    await handler(fakeReq('GET', `/reception/status/${ENDPOINT_ID}?t=goodbearer`), res);
    expect(res.status).toBe(503);
  });

  it('Codex P1 fold (2026-05-13) — projection store wired BUT reader absent → kind-registry 503 stub', async () => {
    // The boot posture bin.ts ships: projection store is composed, but
    // the entity-source reader is OMITTED until a real `data.*`
    // warehouse adapter is wired. The dispatcher's `statusLinkReady`
    // check requires BOTH deps, so this scenario falls through to the
    // RECEPTION_KIND_HANDLERS stub's 503 response (matching the
    // `not_configured` posture other partially-wired kinds use).
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = createReceptionPortHandler({
      getStore: () => env.store,
      getCache: () => env.cache,
      getRateLimiter: () => env.limiter,
      getPepper: () => PEPPER,
      now: () => NOW,
      getStatusProjectionStore: () => env.projectionStore,
      // reader intentionally absent
    });
    const res = fakeRes();
    await handler(fakeReq('GET', `/reception/status/${ENDPOINT_ID}?t=goodbearer`), res);
    expect(res.status).toBe(503);
    // The kind-registry stub returns the JSON `not_implemented` shape,
    // NOT the HTML placeholder — assert we hit that path (not the live
    // handler's null-reader → placeholder path).
    const get = (k: string) =>
      typeof res.getHeader(k) === 'string' ? (res.getHeader(k) as string) : '';
    expect(get('content-type')).toContain('application/json');
  });
});

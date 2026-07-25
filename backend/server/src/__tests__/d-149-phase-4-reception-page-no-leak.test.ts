/** D-149 P4 § A.5.1 — reception_page no-leak fixture (spec line 591).
 *
 *  Fixture: server with sensitive fields populated. Reception page
 *  rendered → assertion: rendered HTML contains NO fragment of:
 *
 *    - `data.calendar.*` (calendar events, attendees, titles)
 *    - `data.mail.*` (mail subjects, bodies, threads)
 *    - `vault.*` (API keys, OAuth tokens)
 *    - `data.memory.*` (audit entries, recipe insights)
 *    - `data.contact.<id>.annotations.*` (per-contact annotations)
 *    - `data.enrichment.*` (AI-computed facts)
 *
 *  Mechanism: the D-145 substrate's strict-pick at `buildReceptionPacket`
 *  already drops anything outside `PACKET_FIELDS_VISIBLE.reception_page_packet`
 *  before reaching the renderer. This test poisons the singleton row's
 *  metadata blob with extra namespace-prefixed keys + asserts the
 *  rendered HTML never contains those prefixes. */

import Database from 'better-sqlite3';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import { createPublicEndpointRegistryStore } from '../storage/public-endpoint-registry-store.js';
import { createReceptionRateLimiter } from '../ports/reception/rate-limiter.js';
import { createReceptionRegistryCache } from '../ports/reception/registry-cache.js';
import { createReceptionPortHandler } from '../ports/reception/handler.js';
import { deriveReceptionPepper } from '../ports/reception/server-secret-pepper.js';

const NOW = 1_700_000_000_000;
const PEPPER = deriveReceptionPepper(Buffer.alloc(32, 0x99));

const buildEnv = () => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const store = createPublicEndpointRegistryStore(db);
  const cache = createReceptionRegistryCache();
  const limiter = createReceptionRateLimiter({ db });
  return { db, store, cache, limiter };
};

const fakeReq = (url: string): IncomingMessage => {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: '203.0.113.5' });
  const req = new IncomingMessage(socket);
  req.method = 'GET';
  req.url = url;
  return req;
};

const fakeRes = () => {
  let bodyChunks: Array<string | Buffer> = [];
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
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
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
  } as unknown as ServerResponse & { status: number; body: string };
  return res;
};

describe('D-149 P4 § A.5.1 — no-leak fixture (spec line 591)', () => {
  it('rendered HTML never contains poisoned namespace prefixes', async () => {
    const env = buildEnv();
    // Poison the metadata blob with private-namespace-prefixed strings
    // that should NEVER reach the visitor. The substrate's strict-pick
    // at `buildReceptionPacket` is the load-bearing defense — any leak
    // here means the closed list expanded silently or the renderer
    // dropped escape discipline.
    const poisonedConfig = {
      display_overrides: {
        display_name: 'Mary',
        tagline: 'Available',
        tz_label: 'America/Los_Angeles',
        preferred_contact_methods: ['email'],
      },
      sections_enabled: {
        contact_card: true,
        contact_methods: true,
        availability_cta: true,
        intake_cta: false,
        drop_cta: false,
        custom_links: false,
      },
      linked_endpoints: { scheduling_link_endpoint_id: 'sl_abc' },
      // POISON fields (any of these surfacing in HTML is a leak):
      __private_calendar_event_title: 'Secret 1:1 with VC',
      __private_mail_subject: 'Re: Confidential acquisition',
      __vault_anthropic_api_key: 'sk-secret-abcd1234',
      __memory_audit_entry: 'Mary fired Bob on 2026-04-01',
      __annotation_note: 'do not trust Carol — she leaked the deal',
      __enrichment_topic: 'mary_sentiment_burned_out',
    } as unknown as Parameters<
      typeof env.store.upsertReceptionPageSingleton
    >[0]['config'];
    env.store.upsertReceptionPageSingleton({
      config: poisonedConfig,
      now: NOW,
      actor_instance_id: 'mary',
    });
    const handler = createReceptionPortHandler({
      getStore: () => env.store,
      getCache: () => env.cache,
      getRateLimiter: () => env.limiter,
      getPepper: () => PEPPER,
      now: () => NOW,
    });
    const res = fakeRes();
    await handler(fakeReq('/reception/'), res);
    expect(res.status).toBe(200);
    const body = res.body;
    // Private-namespace string assertions — none should surface in
    // the rendered HTML body.
    expect(body).not.toContain('Secret 1:1 with VC');
    expect(body).not.toContain('Re: Confidential acquisition');
    expect(body).not.toContain('sk-secret-abcd1234');
    expect(body).not.toContain('Mary fired Bob');
    expect(body).not.toContain('do not trust Carol');
    expect(body).not.toContain('mary_sentiment_burned_out');
    // Private-namespace key assertions — none should appear in the body
    // either. Substrate's closed-shape strict-pick drops these at the
    // transformation step (the only fields surviving are
    // display_name/tagline/avatar_url/preferred_contact_methods/cta_buttons/
    // tz_label/response_time_estimate).
    expect(body).not.toContain('__vault_');
    expect(body).not.toContain('__memory_');
    expect(body).not.toContain('__annotation_');
    expect(body).not.toContain('__enrichment_');
    expect(body).not.toContain('__private_');
    // Sanity check — the legitimate fields DO appear.
    expect(body).toContain('Mary');
    expect(body).toContain('Available');
  });

  it('rendered HTML never carries the registry row internals', async () => {
    const env = buildEnv();
    env.store.upsertReceptionPageSingleton({
      config: {
        display_overrides: {
          display_name: 'Mary',
          tagline: '',
          tz_label: 'UTC',
          preferred_contact_methods: [],
        },
        sections_enabled: {
          contact_card: true,
          contact_methods: false,
          availability_cta: false,
          intake_cta: false,
          drop_cta: false,
          custom_links: false,
        },
        linked_endpoints: {},
      },
      now: NOW,
      actor_instance_id: 'mary-instance',
    });
    const handler = createReceptionPortHandler({
      getStore: () => env.store,
      getCache: () => env.cache,
      getRateLimiter: () => env.limiter,
      getPepper: () => PEPPER,
      now: () => NOW,
    });
    const res = fakeRes();
    await handler(fakeReq('/reception/'), res);
    // Registry internals: bearer_secret_hmac / endpoint_id / created_by_client_id
    // MUST NOT reach the visitor. The reception_page singleton endpoint_id
    // is a substrate constant + intentionally non-secret; assert it
    // doesn't surface anyway since the visitor never needs the id.
    expect(res.body).not.toContain('__reception_page__');
    expect(res.body).not.toContain('mary-instance');
    expect(res.body).not.toContain('bearer_secret_hmac');
  });
});

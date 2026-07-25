/** D-149 P4 § A.5.1 — reception_page handler integration tests.
 *
 *  Covers:
 *    - Default-empty state on fresh install renders the substrate
 *      placeholder (Must Hold I-1 no-fingerprint baseline).
 *    - Configured state renders display_name + tagline + contact
 *      methods + CTAs.
 *    - Section toggles gate which CTAs render (toggle off → CTA hidden
 *      even if linked_endpoints carries the id).
 *    - XSS escape via the renderer's `htmlEscape` — display_name with
 *      `<script>` does not survive into the HTML.
 *    - HTTP headers: 200, text/html, no-store, referrer-policy
 *      same-origin, x-frame-options DENY.
 *    - CSP meta tag present with `script-src 'none'`. */

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
import type { ReceptionPageConfig } from '@recued/contracts';

const NOW = 1_700_000_000_000;
const PEPPER = deriveReceptionPepper(Buffer.alloc(32, 0x77));

const buildEnv = () => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const store = createPublicEndpointRegistryStore(db);
  const cache = createReceptionRegistryCache();
  const limiter = createReceptionRateLimiter({ db });
  return { db, store, cache, limiter };
};

const fakeReq = (method: string, url: string): IncomingMessage => {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: '203.0.113.5' });
  const req = new IncomingMessage(socket);
  req.method = method;
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

const sampleConfig: ReceptionPageConfig = {
  display_overrides: {
    display_name: 'Mary Smith',
    tagline: 'Available Mon–Fri',
    tz_label: 'America/Los_Angeles',
    preferred_contact_methods: ['email', 'slack'],
    response_time_estimate: 'usually within 24h',
  },
  sections_enabled: {
    contact_card: true,
    contact_methods: true,
    availability_cta: true,
    intake_cta: true,
    drop_cta: false,
    custom_links: true,
    link_buttons: true,
  },
  linked_endpoints: {
    scheduling_link_endpoint_id: 'sl_abc123',
    intake_form_endpoint_id: 'if_def456',
    drop_link_endpoint_id: 'dl_ghi789',
  },
  custom_links: [{ label: 'Read my blog', url: 'https://example.com/blog' }],
  link_buttons: [{
    label: 'Subscribe',
    url: 'https://buy.stripe.com/example',
    description: 'Choose a plan.',
  }],
};

const buildHandler = (env: ReturnType<typeof buildEnv>) =>
  createReceptionPortHandler({
    getStore: () => env.store,
    getCache: () => env.cache,
    getRateLimiter: () => env.limiter,
    getPepper: () => PEPPER,
    now: () => NOW,
  });

describe('D-149 P4 § A.5.1 — fresh-install singleton path', () => {
  it('GET /reception/ returns 200 with substrate placeholder copy', async () => {
    const env = buildEnv();
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/'), res);
    expect(res.status).toBe(200);
    expect(res.getHeader('content-type')).toBe('text/html; charset=utf-8');
    // Apostrophe HTML-escaped to `&#39;`; assert on a unique fragment
    // that survives the escape table.
    expect(res.body).toContain('Reception is not yet configured');
  });

  it('placeholder body contains no user data (no display_name, no tagline)', async () => {
    const env = buildEnv();
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/'), res);
    // Substrate placeholder is the only body content; no per-user
    // fields surface because no upsert has run.
    expect(res.body).not.toContain('class="rcp-name"');
    expect(res.body).not.toContain('class="rcp-tagline"');
  });

  it('emits referrer-policy + x-frame-options privacy headers', async () => {
    const env = buildEnv();
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/'), res);
    expect(res.getHeader('referrer-policy')).toBe('same-origin');
    expect(res.getHeader('x-frame-options')).toBe('DENY');
    expect(res.getHeader('cache-control')).toBe('no-store');
    expect(res.getHeader('x-content-type-options')).toBe('nosniff');
  });
});

describe('D-149 P4 § A.5.1 — configured singleton path', () => {
  it('renders display_name + tagline after upsert', async () => {
    const env = buildEnv();
    env.store.upsertReceptionPageSingleton({
      config: sampleConfig,
      now: NOW,
      actor_instance_id: 'mary',
    });
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/'), res);
    expect(res.status).toBe(200);
    expect(res.body).toContain('Mary Smith');
    expect(res.body).toContain('Available Mon–Fri');
    expect(res.body).toContain('usually within 24h');
    expect(res.body).toContain('Subscribe');
    expect(res.body).toContain('https://buy.stripe.com/example');
    expect(res.body).toContain('Choose a plan.');
  });

  it('renders contact-method chips in the rendered shell', async () => {
    const env = buildEnv();
    env.store.upsertReceptionPageSingleton({
      config: sampleConfig,
      now: NOW,
      actor_instance_id: 'mary',
    });
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/'), res);
    expect(res.body).toContain('class="rcp-method-chip">Email');
    expect(res.body).toContain('class="rcp-method-chip">Slack');
    // Methods not in the user's list don't surface.
    expect(res.body).not.toContain('Telegram');
  });

  it('CTA section gated by section_config toggle (drop_cta=false hides drop)', async () => {
    const env = buildEnv();
    env.store.upsertReceptionPageSingleton({
      config: sampleConfig,
      now: NOW,
      actor_instance_id: 'mary',
    });
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/'), res);
    // availability_cta + intake_cta are on; drop_cta is off.
    expect(res.body).toContain('/reception/scheduling/sl_abc123');
    expect(res.body).toContain('/reception/intake/if_def456');
    expect(res.body).not.toContain('/reception/drop/dl_ghi789');
  });

  it('CSP meta tag enforces script-src none + frame-ancestors none', async () => {
    const env = buildEnv();
    env.store.upsertReceptionPageSingleton({
      config: sampleConfig,
      now: NOW,
      actor_instance_id: 'mary',
    });
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/'), res);
    expect(res.body).toContain("script-src 'none'");
    expect(res.body).toContain("frame-ancestors 'none'");
    expect(res.body).toContain("default-src 'self'");
  });
});

describe('D-149 P4 § A.5.1 + § A.11 TR-8 — XSS escape', () => {
  it('HTML-escapes <script> tags in display_name', async () => {
    const env = buildEnv();
    const malicious: ReceptionPageConfig = {
      ...sampleConfig,
      display_overrides: {
        ...sampleConfig.display_overrides,
        display_name: '<script>alert("xss")</script>Mary',
      },
    };
    env.store.upsertReceptionPageSingleton({
      config: malicious,
      now: NOW,
      actor_instance_id: 'mary',
    });
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/'), res);
    expect(res.body).not.toContain('<script>alert');
    expect(res.body).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;Mary');
  });

  it('HTML-escapes tagline + response_time_estimate', async () => {
    const env = buildEnv();
    const malicious: ReceptionPageConfig = {
      ...sampleConfig,
      display_overrides: {
        ...sampleConfig.display_overrides,
        tagline: '"><img src=x onerror=alert(1)>',
        response_time_estimate: `'\\x3csvg/onload=alert(1)\\x3e`,
      },
    };
    env.store.upsertReceptionPageSingleton({
      config: malicious,
      now: NOW,
      actor_instance_id: 'mary',
    });
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/'), res);
    expect(res.body).not.toContain('<img src=x');
    expect(res.body).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  });

  it('HTML-escapes custom_link label + url in href', async () => {
    const env = buildEnv();
    const xssed: ReceptionPageConfig = {
      ...sampleConfig,
      custom_links: [
        // The validator rejects javascript: urls at upsert; this test
        // bypasses validation to assert the renderer is also safe in
        // depth.
        { label: '<b>bold</b>', url: 'https://example.com/?x="><script>' },
      ],
    };
    env.store.upsertReceptionPageSingleton({
      config: xssed,
      now: NOW,
      actor_instance_id: 'mary',
    });
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/'), res);
    expect(res.body).not.toContain('<b>bold</b>');
    expect(res.body).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(res.body).not.toContain('"><script>');
  });

  it('drops a stored link_button that bypassed RPC HTTPS validation', async () => {
    const env = buildEnv();
    const corrupted: ReceptionPageConfig = {
      ...sampleConfig,
      link_buttons: [{ label: 'Unsafe checkout', url: 'javascript:alert(1)' }],
    };
    env.store.upsertReceptionPageSingleton({
      config: corrupted,
      now: NOW,
      actor_instance_id: 'mary',
    });
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/'), res);
    expect(res.body).not.toContain('javascript:');
    expect(res.body).not.toContain('Unsafe checkout');
  });
});

describe('D-149 P4 § A.5.1 — corrupt-config fallback', () => {
  it('renders placeholder when display_overrides is missing', async () => {
    const env = buildEnv();
    // Write a row directly with a malformed metadata blob, bypassing
    // the upsert helper's structural gate.
    env.db
      .prepare(
        `INSERT INTO public_endpoint_registry
          (endpoint_id, kind, enabled, packet_declaration, bearer_secret_hmac,
           created_at, created_by_client_id, expires_at, long_lived_acknowledged_at,
           audit_count, metadata_blob)
         VALUES ('__reception_page__', 'reception_page', 1, '{}', x'00', ?, 'mary', NULL, ?, 0, ?)`,
      )
      .run(NOW, NOW, JSON.stringify({ not_a_config: true }));
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/'), res);
    expect(res.status).toBe(200);
    // Apostrophe HTML-escaped to `&#39;`; assert on a unique fragment
    // that survives the escape table.
    expect(res.body).toContain('Reception is not yet configured');
  });
});

describe('D-149 P4 § A.5.1 — no-deps floor', () => {
  it('GET /reception/ without deps still returns 404 (deps-absent path)', async () => {
    // The deps-absent path is the P1 baseline — handlers mount before
    // the persistence layer is composed; the 404 floor stays.
    const handler = createReceptionPortHandler();
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/'), res);
    expect(res.status).toBe(404);
  });
});

describe('D-149 P4 Codex fold — emergency disable kills the singleton (P1)', () => {
  it('after reception.emergency_disable_all flips enabled=0, /reception/ falls back to placeholder', async () => {
    const env = buildEnv();
    env.store.upsertReceptionPageSingleton({
      config: sampleConfig,
      now: NOW,
      actor_instance_id: 'mary',
    });
    // Sanity — page renders configured before disable.
    const handler = buildHandler(env);
    {
      const res = fakeRes();
      await handler(fakeReq('GET', '/reception/'), res);
      expect(res.body).toContain('Mary Smith');
    }
    // Sweep every enabled=1 row to 0 (operator kill switch).
    env.store.emergencyDisableAll(NOW);
    // Now the singleton render falls through to the substrate
    // placeholder — no user data leaks while the page is in
    // emergency-disabled state.
    {
      const res = fakeRes();
      await handler(fakeReq('GET', '/reception/'), res);
      expect(res.body).toContain('Reception is not yet configured');
      expect(res.body).not.toContain('Mary Smith');
    }
  });
});

describe('D-149 P4 Codex fold — contact_methods section toggle honored (P2)', () => {
  it('contact_methods=false hides the "Reach me via" chips even with methods configured', async () => {
    const env = buildEnv();
    const cfg = {
      ...sampleConfig,
      sections_enabled: { ...sampleConfig.sections_enabled, contact_methods: false },
    };
    env.store.upsertReceptionPageSingleton({
      config: cfg,
      now: NOW,
      actor_instance_id: 'mary',
    });
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/'), res);
    expect(res.body).toContain('Mary Smith');
    expect(res.body).not.toContain('rcp-method-chip');
    expect(res.body).not.toContain('Reach me via');
  });

  it('contact_card=false blanks tagline + avatar + response_time_estimate', async () => {
    const env = buildEnv();
    const cfg = {
      ...sampleConfig,
      sections_enabled: { ...sampleConfig.sections_enabled, contact_card: false },
    };
    env.store.upsertReceptionPageSingleton({
      config: cfg,
      now: NOW,
      actor_instance_id: 'mary',
    });
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/'), res);
    // display_name still renders (substrate validator requires non-empty),
    // but tagline + response_time_estimate are suppressed.
    expect(res.body).toContain('Mary Smith');
    expect(res.body).not.toContain('Available Mon–Fri');
    expect(res.body).not.toContain('usually within 24h');
  });
});

describe('D-149 P4 Codex fold — share_url drives CTA href (P2)', () => {
  it('CTA href uses share_url when present', async () => {
    const env = buildEnv();
    const cfg: typeof sampleConfig = {
      ...sampleConfig,
      linked_endpoints: {
        ...sampleConfig.linked_endpoints,
        scheduling_link_share_url:
          'https://mary.example.com/reception/scheduling/sl_abc123?t=secret-xyz',
      },
    };
    env.store.upsertReceptionPageSingleton({
      config: cfg,
      now: NOW,
      actor_instance_id: 'mary',
    });
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/'), res);
    expect(res.body).toContain('t=secret-xyz');
  });

  it('CTA href falls back to token-less path when share_url unset', async () => {
    const env = buildEnv();
    env.store.upsertReceptionPageSingleton({
      config: sampleConfig,
      now: NOW,
      actor_instance_id: 'mary',
    });
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/'), res);
    // No share_url configured for scheduling; falls back to
    // /reception/scheduling/<endpoint_id> (visitor lands on 401).
    expect(res.body).toContain('/reception/scheduling/sl_abc123');
    expect(res.body).not.toContain('?t=');
  });
});

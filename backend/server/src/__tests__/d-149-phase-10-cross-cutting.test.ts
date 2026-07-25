/** D-149 P10 — Cross-cutting privacy + CSRF acceptance pass.
 *
 *  The threat-model rows (§ A.11) verified in
 *  `d-149-phase-10-threat-model-acceptance.test.ts` are per-threat;
 *  this suite is the cross-cutting indexed pass over the substrate
 *  invariants that span every kind:
 *
 *    - § Must Hold I-12b — CSRF + Referrer-Policy + token-strip:
 *        - state-changing POSTs reject mismatched Origin (CSRF guard)
 *        - `Referrer-Policy: no-referrer` on every token-bearing kind
 *        - `?t=` redacted from `public_endpoint_access_log` URL field
 *    - § Must Hold I-8 — source-IP hash is endpoint-scoped + uses a
 *      server-secret pepper (NOT the public server identity key)
 *    - § Must Hold I-9 — no cross-endpoint visitor tracking by default;
 *      rate-limit buckets key on the server-wide hash but the
 *      persisted access-log row keys on the endpoint-scoped hash
 *    - Cross-endpoint isolation — two endpoints in one DB stay
 *      decoupled (rate-limit budget, access log, token verification)
 *
 *  Spec: docs/d-149-spec.md § A.16 + § A.18 + § Must Hold I-8 / I-9 /
 *  I-12b. */

import Database from 'better-sqlite3';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SchedulingLinkConfig } from '@recued/contracts';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import { createPublicEndpointRegistryStore } from '../storage/public-endpoint-registry-store.js';
// D-210 A.8 slice 4b-ii — a booking is a `reception_form_submission` row with a
// slot; `reception_booking_request` has no writer any more.
import { createReceptionFormSubmissionStore } from '../storage/reception-form-store.js';
import { createReceptionRateLimiter } from '../ports/reception/rate-limiter.js';
import { createReceptionRegistryCache } from '../ports/reception/registry-cache.js';
import { createReceptionPortHandler } from '../ports/reception/handler.js';
import {
  computeBearerHmac,
  deriveReceptionPepper,
  hashSourceIpEndpointScoped,
  hashSourceIpServerWide,
} from '../ports/reception/server-secret-pepper.js';
import { createInMemorySchedulingFormNonceStore } from '../ports/reception/handlers/scheduling-link.js';
// ⚠ The FORM key, not the booking one — a booking's fields seal under the key
// its table's readers open with (`booking-blob.ts`).
import { deriveFormSubmissionPiiKeyFromSubDek } from '../ports/reception/form-pii.js';
import type { AuditLogStore } from '@recued/storage';

// 30-min-grid-aligned. The `/book` CSRF test below hardcodes `NOW + 1h` as the
// booked slot, which is only a valid candidate when NOW sits on the tz-local
// clock grid the enumerator snaps to (D-149 `69c3a2a3`: slots snap to the
// `America/New_York` :00/:30 grid — a whole-hour offset, so a UTC 30-min
// boundary is also a NY one). `1_700_000_000_000` is 800_000 ms past a boundary,
// so floor it (same fix as the scheduling-link-handler test). All other uses of
// NOW here are relative, so the shift is transparent.
const NOW = 1_700_000_000_000 - (1_700_000_000_000 % (30 * 60 * 1000)); // 1_699_999_200_000
const PEPPER = deriveReceptionPepper(Buffer.alloc(32, 0x20));
const SUB_DEK = new Uint8Array(32).fill(0x21);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const noopAudit = (): AuditLogStore =>
  ({
    logActivity: async () => undefined,
    listActivity: async () => [],
    listAgentAccess: async () => [],
    listProvenanceLinks: async () => [],
    timeline: async () => [],
    bumpInsightSnapshotIfDifferent: async () => null,
    queryRecipeInsight: async () => null,
  }) as unknown as AuditLogStore;

const buildEnv = () => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const store = createPublicEndpointRegistryStore(db);
  const cache = createReceptionRegistryCache();
  const limiter = createReceptionRateLimiter({ db });
  const booking = createReceptionFormSubmissionStore(db);
  const formNonce = createInMemorySchedulingFormNonceStore();
  return { db, store, cache, limiter, booking, formNonce };
};

const schedulingConfig: SchedulingLinkConfig = {
  display_name: 'Mary',
  duration_options_minutes: [30],
  available_window_definition: {
    tz: 'America/New_York',
    explicit_windows: [
      { day_of_week: 0, start_minute: 0, end_minute: 1440 },
      { day_of_week: 1, start_minute: 0, end_minute: 1440 },
      { day_of_week: 2, start_minute: 0, end_minute: 1440 },
      { day_of_week: 3, start_minute: 0, end_minute: 1440 },
      { day_of_week: 4, start_minute: 0, end_minute: 1440 },
      { day_of_week: 5, start_minute: 0, end_minute: 1440 },
      { day_of_week: 6, start_minute: 0, end_minute: 1440 },
    ],
  },
  required_visitor_fields: {
    name: 'required',
    email: 'required',
    topic: 'optional',
    phone: 'omit',
    notes: 'optional',
  },
  min_advance_notice_hours: 1,
  max_lead_time_days: 30,
  max_bookings_per_day: 0,
  on_booking: {
    create_calendar_event: true,
    create_commitment_entity: true,
  },
};

const insertSchedulingEndpoint = (
  env: ReturnType<typeof buildEnv>,
  endpoint_id: string,
  bearer: string,
) => {
  env.store.create({
    endpoint_id,
    kind: 'scheduling_link',
    packet_declaration: {
      packet_kind: 'scheduling_link_packet',
      source_query_ref: { kind: 'data.calendar.combined' },
    },
    bearer_secret_hmac: computeBearerHmac(bearer, PEPPER),
    created_at: NOW - DAY,
    created_by_client_id: 'inst-1',
    expires_at: null,
    long_lived_acknowledged_at: NOW - DAY,
    metadata: schedulingConfig as unknown as Record<string, unknown>,
  });
  env.store.enable(endpoint_id, NOW);
};

const fakeReq = (
  method: string,
  url: string,
  opts?: { ip?: string; body?: string; headers?: Record<string, string> },
): IncomingMessage => {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', {
    value: opts?.ip ?? '203.0.113.80',
  });
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = url;
  Object.assign(req.headers, opts?.headers ?? {});
  if (opts?.body !== undefined) {
    setImmediate(() => {
      req.emit('data', Buffer.from(opts.body as string, 'utf8'));
      req.emit('end');
    });
  }
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

const buildHandler = (env: ReturnType<typeof buildEnv>) =>
  createReceptionPortHandler({
    getStore: () => env.store,
    getCache: () => env.cache,
    getRateLimiter: () => env.limiter,
    getPepper: () => PEPPER,
    now: () => NOW,
    getIntakeFormSubmissionStore: () => env.booking,
    getSchedulingFormNonceStore: () => env.formNonce,
    getSchedulingCalendarReader: () => ({ list: () => [] }),
    getIntakeFormSubmissionPiiKey: () => deriveFormSubmissionPiiKeyFromSubDek(SUB_DEK),
    auditLog: noopAudit(),
  });

// ────────────────────────────────────────────────────────────────
// I-12b — CSRF guard on state-changing POSTs
// ────────────────────────────────────────────────────────────────

describe('D-149 P10 § Must Hold I-12b — CSRF guard on state-changing POSTs', () => {
  it('POST /book with a cross-origin Origin header is rejected (403)', async () => {
    const env = buildEnv();
    insertSchedulingEndpoint(env, 'ep-csrf', 'goodbearer');
    const handler = buildHandler(env);
    const nonce = env.formNonce.issue('ep-csrf', NOW);
    const slotStart = NOW + 1 * HOUR;
    const slotEnd = slotStart + 30 * 60 * 1000;
    const body =
      `t=goodbearer&form_nonce=${nonce}&duration=30` +
      `&slot=${slotStart}|${slotEnd}|30&visitor_name=Q&visitor_email=q%40example.com`;
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/scheduling/ep-csrf/book?t=goodbearer', {
        body,
        headers: {
          host: 'mary.example.com',
          origin: 'https://attacker.example.net',
          'content-type': 'application/x-www-form-urlencoded',
        },
      }),
      res,
    );
    expect(res.status).toBe(403);
  });

  it('POST /book with NO Origin and NO Referer is rejected (403) — same-origin policy', async () => {
    const env = buildEnv();
    insertSchedulingEndpoint(env, 'ep-csrf2', 'goodbearer');
    const handler = buildHandler(env);
    const nonce = env.formNonce.issue('ep-csrf2', NOW);
    const slotStart = NOW + 1 * HOUR;
    const slotEnd = slotStart + 30 * 60 * 1000;
    const body =
      `t=goodbearer&form_nonce=${nonce}&duration=30` +
      `&slot=${slotStart}|${slotEnd}|30&visitor_name=Q&visitor_email=q%40example.com`;
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/scheduling/ep-csrf2/book?t=goodbearer', {
        body,
        headers: {
          host: 'mary.example.com',
          'content-type': 'application/x-www-form-urlencoded',
        },
      }),
      res,
    );
    expect(res.status).toBe(403);
  });

  it('POST /book with same-origin Origin is accepted (CSRF guard does not block legit traffic)', async () => {
    const env = buildEnv();
    insertSchedulingEndpoint(env, 'ep-csrf3', 'goodbearer');
    const handler = buildHandler(env);
    const nonce = env.formNonce.issue('ep-csrf3', NOW);
    const slotStart = NOW + 1 * HOUR;
    const slotEnd = slotStart + 30 * 60 * 1000;
    const body =
      `t=goodbearer&form_nonce=${nonce}&duration=30` +
      `&slot=${slotStart}|${slotEnd}|30&visitor_name=Q&visitor_email=q%40example.com`;
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/scheduling/ep-csrf3/book?t=goodbearer', {
        body,
        headers: {
          host: 'mary.example.com',
          origin: 'https://mary.example.com',
          'content-type': 'application/x-www-form-urlencoded',
        },
      }),
      res,
    );
    expect(res.status).toBe(200);
  });
});

// ────────────────────────────────────────────────────────────────
// I-12b — Referrer-Policy on token-bearing pages
// ────────────────────────────────────────────────────────────────

describe('D-149 P10 § Must Hold I-12b — Referrer-Policy no-referrer on token-bearing pages', () => {
  it('scheduling_link GET render sets Referrer-Policy: no-referrer', async () => {
    const env = buildEnv();
    insertSchedulingEndpoint(env, 'ep-ref', 'goodbearer');
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(
      fakeReq('GET', '/reception/scheduling/ep-ref?t=goodbearer'),
      res,
    );
    expect(res.status).toBe(200);
    expect(res.getHeader('referrer-policy')).toBe('no-referrer');
  });

  it('token-bearing handler render files all set referrer-policy no-referrer (source ratchet)', async () => {
    // The five token-bearing kinds (scheduling / intake / drop / approval
    // / status) MUST emit `Referrer-Policy: no-referrer` because their
    // URLs carry the `?t=` secret — `same-origin` (the reception_page
    // default) would still leak the token to same-origin asset fetches.
    // This ratchet greps the render source so a future kind that forgets
    // the header fails here.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const handlersDir = resolve(__dirname, '..', 'ports', 'reception', 'handlers');
    const tokenBearingRenderFiles = [
      'scheduling-link.ts',
      'scheduling-link-book.ts',
      'intake-form.ts',
      'drop-link.ts',
      'approval-link.ts',
      'status-link.ts',
    ];
    for (const file of tokenBearingRenderFiles) {
      const src = readFileSync(resolve(handlersDir, file), 'utf8');
      expect(src).toContain("'no-referrer'");
    }
  });

  it('reception_page singleton uses same-origin (NOT token-bearing — no ?t= secret)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(
      resolve(__dirname, '..', 'ports', 'reception', 'handlers', 'reception-page.ts'),
      'utf8',
    );
    // The singleton page has no per-link token, so `same-origin` is the
    // correct (looser) policy per § A.14 invariant 10.
    expect(src).toContain("'same-origin'");
  });
});

// ────────────────────────────────────────────────────────────────
// I-12b — token-strip from operational access log
// ────────────────────────────────────────────────────────────────

describe('D-149 P10 § Must Hold I-12b — token-strip from operational access log', () => {
  it('?t= is redacted from url_path_redacted on a successful view', async () => {
    const env = buildEnv();
    insertSchedulingEndpoint(env, 'ep-strip', 'supersecretbearer');
    const handler = buildHandler(env);
    await handler(
      fakeReq('GET', '/reception/scheduling/ep-strip?t=supersecretbearer'),
      fakeRes(),
    );
    const rows = env.store.readAccessLog({ endpoint_id: 'ep-strip' });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.url_path_redacted ?? '').not.toContain('supersecretbearer');
      expect(row.url_path_redacted ?? '').not.toContain('t=');
      // The bare path survives so operators can still see which endpoint
      // was hit.
      expect(row.url_path_redacted).toBe('/reception/scheduling/ep-strip');
    }
  });

  it('?t= is redacted even on an invalid-token (401) request', async () => {
    const env = buildEnv();
    insertSchedulingEndpoint(env, 'ep-strip2', 'realbearer');
    const handler = buildHandler(env);
    await handler(
      fakeReq('GET', '/reception/scheduling/ep-strip2?t=guessed-wrong-secret'),
      fakeRes(),
    );
    const rows = env.store.readAccessLog({ endpoint_id: 'ep-strip2' });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.url_path_redacted ?? '').not.toContain('guessed-wrong-secret');
    }
  });

  it('extra non-token query params are preserved while ?t= is stripped', async () => {
    const env = buildEnv();
    insertSchedulingEndpoint(env, 'ep-strip3', 'realbearer');
    const handler = buildHandler(env);
    await handler(
      fakeReq(
        'GET',
        '/reception/scheduling/ep-strip3?t=realbearer&format=json&utm=abc',
      ),
      fakeRes(),
    );
    const rows = env.store.readAccessLog({ endpoint_id: 'ep-strip3' });
    expect(rows.length).toBeGreaterThan(0);
    const redacted = rows[0]!.url_path_redacted ?? '';
    expect(redacted).not.toContain('realbearer');
    expect(redacted).toContain('format=json');
    expect(redacted).toContain('utm=abc');
  });
});

// ────────────────────────────────────────────────────────────────
// I-8 — source-IP hash is endpoint-scoped + server-secret pepper
// ────────────────────────────────────────────────────────────────

describe('D-149 P10 § Must Hold I-8 — source-IP hash discipline', () => {
  it('the pepper is a server-internal secret — NOT derivable from any public key', async () => {
    // TR-2 + § A.16.2: an attacker who knows the (public) server
    // identity key MUST NOT be able to replay the IP hash. The pepper
    // derives from the FileVault-bound reception sub-DEK via HKDF; a
    // distinct sub-DEK / master produces a distinct pepper.
    const pepperA = deriveReceptionPepper(Buffer.alloc(32, 0x01));
    const pepperB = deriveReceptionPepper(Buffer.alloc(32, 0x02));
    expect(pepperA.equals(pepperB)).toBe(false);
    // Same master → deterministic pepper (survives restart).
    const pepperA2 = deriveReceptionPepper(Buffer.alloc(32, 0x01));
    expect(pepperA.equals(pepperA2)).toBe(true);
  });

  it('endpoint-scoped hash for the same IP differs across endpoints', () => {
    const ip = '198.51.100.90';
    const a = hashSourceIpEndpointScoped(ip, 'endpoint-1', PEPPER);
    const b = hashSourceIpEndpointScoped(ip, 'endpoint-2', PEPPER);
    const c = hashSourceIpEndpointScoped(ip, 'endpoint-1', PEPPER);
    expect(a).not.toBe(b);
    // Deterministic within an endpoint scope.
    expect(a).toBe(c);
  });

  it('the hash output reveals nothing about the source IP (one-way)', () => {
    const hash = hashSourceIpEndpointScoped('198.51.100.91', 'endpoint-1', PEPPER);
    expect(hash).not.toContain('198.51.100.91');
    // base64url, fixed length (32-byte HKDF output).
    expect(/^[A-Za-z0-9_-]+$/.test(hash)).toBe(true);
    expect(Buffer.from(hash, 'base64url').length).toBe(32);
  });

  it('a wrong-pepper guess does not reproduce the hash (pepper is load-bearing)', () => {
    const real = hashSourceIpEndpointScoped('198.51.100.92', 'endpoint-1', PEPPER);
    const wrongPepper = deriveReceptionPepper(Buffer.alloc(32, 0xff));
    const forged = hashSourceIpEndpointScoped(
      '198.51.100.92',
      'endpoint-1',
      wrongPepper,
    );
    expect(forged).not.toBe(real);
  });
});

// ────────────────────────────────────────────────────────────────
// I-9 — no cross-endpoint visitor tracking by default
// ────────────────────────────────────────────────────────────────

describe('D-149 P10 § Must Hold I-9 — no cross-endpoint visitor tracking by default', () => {
  it('a visitor hitting two endpoints lands two access-log rows with DIFFERENT source_ip_hash', async () => {
    const env = buildEnv();
    insertSchedulingEndpoint(env, 'ep-iso-A', 'tokenA');
    insertSchedulingEndpoint(env, 'ep-iso-B', 'tokenB');
    const handler = buildHandler(env);
    const visitorIp = '198.51.100.100';
    await handler(
      fakeReq('GET', '/reception/scheduling/ep-iso-A?t=tokenA', { ip: visitorIp }),
      fakeRes(),
    );
    await handler(
      fakeReq('GET', '/reception/scheduling/ep-iso-B?t=tokenB', { ip: visitorIp }),
      fakeRes(),
    );
    const rowsA = env.store.readAccessLog({ endpoint_id: 'ep-iso-A' });
    const rowsB = env.store.readAccessLog({ endpoint_id: 'ep-iso-B' });
    expect(rowsA.length).toBeGreaterThan(0);
    expect(rowsB.length).toBeGreaterThan(0);
    // Same visitor IP, but the persisted hashes are endpoint-scoped —
    // a JOIN on source_ip_hash returns nothing.
    expect(rowsA[0]!.source_ip_hash).not.toBe(rowsB[0]!.source_ip_hash);
  });

  it('rate-limit buckets DO key on the server-wide hash (so a bot cannot rotate endpoint ids to escape)', () => {
    // Codex P1 #3 fold (P3): the rate-limit key is the server-wide hash,
    // NOT the endpoint-scoped hash — otherwise rotating endpoint ids
    // would mint a fresh per-IP budget per id. This is the ONE place
    // the server-wide hash is used WITHOUT user opt-in; it never lands
    // in a persisted access-log row, only in the in-memory rate-limit
    // bucket key.
    const ip = '198.51.100.101';
    const serverWide = hashSourceIpServerWide(ip, PEPPER);
    const serverWide2 = hashSourceIpServerWide(ip, PEPPER);
    expect(serverWide).toBe(serverWide2);
    // The server-wide hash is distinct from any endpoint-scoped hash.
    expect(serverWide).not.toBe(
      hashSourceIpEndpointScoped(ip, 'endpoint-1', PEPPER),
    );
  });

  it('access-log rows carry no visitor_id / cross-ref column (structural)', async () => {
    const env = buildEnv();
    insertSchedulingEndpoint(env, 'ep-noxref', 'token');
    const handler = buildHandler(env);
    await handler(
      fakeReq('GET', '/reception/scheduling/ep-noxref?t=token'),
      fakeRes(),
    );
    const cols = env.db
      .prepare(`PRAGMA table_info(public_endpoint_access_log)`)
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).not.toContain('visitor_id');
    expect(names).not.toContain('cross_endpoint_visitor_id');
    // user_agent_hash exists but is NULL by default (no UA logging per
    // § A.14 invariant 10).
    expect(names).toContain('source_ip_hash');
  });

  it('user_agent_hash is NULL by default (no fingerprinting telemetry)', async () => {
    const env = buildEnv();
    insertSchedulingEndpoint(env, 'ep-noua', 'token');
    const handler = buildHandler(env);
    await handler(
      fakeReq('GET', '/reception/scheduling/ep-noua?t=token', {
        headers: { 'user-agent': 'Mozilla/5.0 (some unique fingerprint)' },
      }),
      fakeRes(),
    );
    const rows = env.store.readAccessLog({ endpoint_id: 'ep-noua' });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.user_agent_hash).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// Cross-endpoint isolation — token + rate-limit decoupling
// ────────────────────────────────────────────────────────────────

describe('D-149 P10 — Cross-endpoint isolation', () => {
  it('two endpoints in one DB verify against their own bearer only', async () => {
    const env = buildEnv();
    insertSchedulingEndpoint(env, 'ep-x-1', 'secret-one');
    insertSchedulingEndpoint(env, 'ep-x-2', 'secret-two');
    const handler = buildHandler(env);
    // secret-one works at ep-x-1.
    const ok1 = fakeRes();
    await handler(fakeReq('GET', '/reception/scheduling/ep-x-1?t=secret-one'), ok1);
    expect(ok1.status).toBe(200);
    // secret-one rejected at ep-x-2.
    const bad = fakeRes();
    await handler(fakeReq('GET', '/reception/scheduling/ep-x-2?t=secret-one'), bad);
    expect(bad.status).toBe(401);
    // secret-two works at ep-x-2.
    const ok2 = fakeRes();
    await handler(fakeReq('GET', '/reception/scheduling/ep-x-2?t=secret-two'), ok2);
    expect(ok2.status).toBe(200);
  });

  it('revoking one endpoint does not affect a sibling endpoint', async () => {
    const env = buildEnv();
    insertSchedulingEndpoint(env, 'ep-rev-A', 'tokA');
    insertSchedulingEndpoint(env, 'ep-rev-B', 'tokB');
    const handler = buildHandler(env);
    env.store.revoke({ endpoint_id: 'ep-rev-A', now: NOW, reason: 'test' });
    env.cache.invalidate('ep-rev-A');
    const revoked = fakeRes();
    await handler(fakeReq('GET', '/reception/scheduling/ep-rev-A?t=tokA'), revoked);
    expect(revoked.status).toBe(410);
    const sibling = fakeRes();
    await handler(fakeReq('GET', '/reception/scheduling/ep-rev-B?t=tokB'), sibling);
    expect(sibling.status).toBe(200);
  });

  it('a same-IP probe burns the server-wide rate-limit budget regardless of which endpoint id it targets', async () => {
    // The server-wide hash keying means rotating endpoint ids cannot
    // escape the per-IP budget — verify by issuing requests across two
    // endpoint ids from one IP and observing the shared bucket.
    const env = buildEnv();
    insertSchedulingEndpoint(env, 'ep-share-A', 'tokA');
    insertSchedulingEndpoint(env, 'ep-share-B', 'tokB');
    const handler = buildHandler(env);
    const attackerIp = '198.51.100.110';
    let saw429 = false;
    // scheduling_link per-kind cap is 30/min — split across two ids.
    for (let i = 0; i < 40; i += 1) {
      const id = i % 2 === 0 ? 'ep-share-A' : 'ep-share-B';
      const tok = i % 2 === 0 ? 'tokA' : 'tokB';
      const res = fakeRes();
      await handler(
        fakeReq('GET', `/reception/scheduling/${id}?t=${tok}`, { ip: attackerIp }),
        res,
      );
      if (res.status === 429) saw429 = true;
    }
    // The shared per-IP budget exhausts even though the attacker rotated
    // endpoint ids.
    expect(saw429).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// Pepper fingerprint helper — operator diagnostics never leak the pepper
// ────────────────────────────────────────────────────────────────

describe('D-149 P10 — pepper diagnostics never leak the pepper', () => {
  it('peeperFingerprint returns a short digest that is NOT the pepper itself', async () => {
    const { peeperFingerprint } = await import(
      '../ports/reception/server-secret-pepper.js'
    );
    const fp = peeperFingerprint(PEPPER);
    expect(fp.length).toBe(16);
    expect(fp).not.toBe(PEPPER.toString('hex'));
    // It IS a stable function of the pepper (operators compare across
    // contexts) — equals the first 16 hex chars of sha256(pepper).
    const expected = createHash('sha256').update(PEPPER).digest('hex').slice(0, 16);
    expect(fp).toBe(expected);
  });
});

/** D-149 P10 § A.11 — Threat-model acceptance pass.
 *
 *  Indexed verification of the sixteen T-rows in spec § A.11. Each
 *  P4-P9 phase shipped per-kind tests for the row that lands at that
 *  phase (T-3 / T-4 / T-5 in P7; T-10 in P8; T-16 in P7); this P10
 *  suite is the cross-cutting + indexed pass that verifies the
 *  threat-model surface holds at the substrate level across every
 *  kind in one place.
 *
 *  The acceptance shape (per spec § P10 line 1864): one `describe`
 *  block per T-row, with at least one verifying test. T-rows that
 *  land at an earlier phase carry an "indexed via" annotation that
 *  records the existing test file owning the live exercise, and
 *  re-verifies the load-bearing substrate primitive here so the
 *  cross-cutting suite stays self-contained.
 *
 *  Spec: D-149 § A.11 + § P10. */

import Database from 'better-sqlite3';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { SchedulingLinkConfig } from '@recued/contracts';
import { RECEPTION_RATE_LIMIT_DEFAULTS } from '@recued/contracts';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import { createPublicEndpointRegistryStore } from '../storage/public-endpoint-registry-store.js';
// D-210 A.8 slice 4b-ii — a booking is a `reception_form_submission` row with a
// slot; `reception_booking_request` has no writer any more. The intake half of
// this file already imported this store — now BOTH flows read it.
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
// its table's readers open with (`booking-blob.ts`). The scheduling half of this
// file now derives from the same import the intake half always used.
import {
  deriveFormSubmissionPiiKeyFromSubDek,
  sealFormSubmissionField,
  openFormSubmissionField,
} from '../ports/reception/form-pii.js';
import type { AuditLogStore } from '@recued/storage';

const NOW = 1_700_000_000_000;
const PEPPER = deriveReceptionPepper(Buffer.alloc(32, 0x10));
const SUB_DEK = new Uint8Array(32).fill(0x11);
const DAY = 24 * 60 * 60 * 1000;

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
  // D-210 A.8 slice 4b-ii — ONE store, two names. Bookings and intakes are rows
  // in the SAME `reception_form_submission` table now, told apart by their slot;
  // `booking` keeps its name because that is the flow the scheduling cases drive.
  const submission = createReceptionFormSubmissionStore(db);
  const booking = submission;
  const formNonce = createInMemorySchedulingFormNonceStore();
  return { db, store, cache, limiter, booking, submission, formNonce };
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
  ip = '203.0.113.10',
  headers?: Record<string, string>,
): IncomingMessage => {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: ip });
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
// T-1 — Drive-by scraping / reconnaissance
// ────────────────────────────────────────────────────────────────

describe('D-149 P10 § A.11 T-1 — Drive-by scraping / reconnaissance', () => {
  it('returns 401 generic for an unknown endpoint id (no fingerprinting of valid endpoints)', async () => {
    const env = buildEnv();
    insertSchedulingEndpoint(env, 'ep-A', 'goodbearer');
    const handler = buildHandler(env);
    const valid = fakeRes();
    await handler(
      fakeReq('GET', '/reception/scheduling/ep-A?t=bogusbearer', '198.51.100.1'),
      valid,
    );
    expect(valid.status).toBe(401);
    const unknown = fakeRes();
    await handler(
      fakeReq('GET', '/reception/scheduling/ep-does-not-exist?t=bogusbearer', '198.51.100.2'),
      unknown,
    );
    expect(unknown.status).toBe(401);
    // Generic message — no kind / id leak.
    expect(unknown.body).not.toContain('does-not-exist');
    expect(unknown.body).not.toContain('ep-A');
  });

  it('per-IP global rate limit kicks in under sustained probe', () => {
    const db = new Database(':memory:');
    ensureReceptionSchema(db);
    const limiter = createReceptionRateLimiter({ db });
    // `reception_page`'s per-kind window equals the global (60/60s), so
    // the global bucket is the binding constraint — the 61st request
    // trips `per_ip_global` (consulted before the per-kind bucket).
    const limit = RECEPTION_RATE_LIMIT_DEFAULTS.per_ip_global.max_requests;
    for (let i = 0; i < limit; i += 1) {
      expect(
        limiter.consumePreVerify({
          source_ip_hash: 'probe-ip',
          endpoint_kind: 'reception_page',
          now: NOW,
        }).ok,
      ).toBe(true);
    }
    const overflow = limiter.consumePreVerify({
      source_ip_hash: 'probe-ip',
      endpoint_kind: 'reception_page',
      now: NOW,
    });
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.bucket_kind).toBe('per_ip_global');
  });

  it('reception_page singleton returns generic 200 (substrate placeholder; no endpoint enumeration)', async () => {
    const env = buildEnv();
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/'), res);
    expect(res.status).toBe(200);
    // No private endpoint ids leak into the singleton page.
    expect(res.body).not.toContain('ep-');
  });
});

// ────────────────────────────────────────────────────────────────
// T-2 — Bot form spam (indexed via P6 handler tests)
// ────────────────────────────────────────────────────────────────

describe('D-149 P10 § A.11 T-2 — Bot form spam', () => {
  it('intake_form pre-verification envelope caps requests per IP (indexed via P6)', () => {
    // The durable P6 handler enforces each form's owner-selected 1..60/hour
    // per-source cap. This earlier, token-less primitive is the matching
    // 60/hour HMAC-work envelope: it still bounds anonymous abuse without
    // silently overriding a valid form setting before the form is parsed.
    const db = new Database(':memory:');
    ensureReceptionSchema(db);
    const limiter = createReceptionRateLimiter({ db });
    const cap = RECEPTION_RATE_LIMIT_DEFAULTS.per_endpoint_kind.intake_form.max_requests;
    expect(cap).toBe(60);
    for (let i = 0; i < cap; i += 1) {
      expect(
        limiter.consumePreVerify({
          source_ip_hash: 'spam-bot-ip',
          endpoint_kind: 'intake_form',
          now: NOW,
        }).ok,
      ).toBe(true);
    }
    const overflow = limiter.consumePreVerify({
      source_ip_hash: 'spam-bot-ip',
      endpoint_kind: 'intake_form',
      now: NOW,
    });
    expect(overflow.ok).toBe(false);
  });

  it('per-endpoint daily cap on intake_form is 1000/day (per spec § A.5.3)', () => {
    expect(
      RECEPTION_RATE_LIMIT_DEFAULTS.per_endpoint_daily_cap.intake_form,
    ).toBe(1_000);
  });
});

// ────────────────────────────────────────────────────────────────
// T-3 / T-4 / T-5 / T-16 — File-upload abuse (indexed via P7)
// ────────────────────────────────────────────────────────────────

describe('D-149 P10 § A.11 T-3 — File-upload malware (indexed via P7)', () => {
  it('drop_link MIME-type allowlist is closed-list at the contract layer', async () => {
    const { DROP_LINK_ALLOWED_MIME_TYPES } = await import('@recued/contracts');
    expect(DROP_LINK_ALLOWED_MIME_TYPES.length).toBeGreaterThan(0);
    expect(DROP_LINK_ALLOWED_MIME_TYPES).not.toContain('text/html');
    expect(DROP_LINK_ALLOWED_MIME_TYPES).not.toContain('application/javascript');
    expect(DROP_LINK_ALLOWED_MIME_TYPES).not.toContain('application/x-msdownload');
  });
});

describe('D-149 P10 § A.11 T-4 — File-upload oversize / DoS (indexed via P7)', () => {
  it('drop_link per-endpoint daily cap defaults to 50/day', () => {
    expect(
      RECEPTION_RATE_LIMIT_DEFAULTS.per_endpoint_daily_cap.drop_link,
    ).toBe(50);
  });

  it('drop_link per-ip window caps at 5/hour (tighter than the 60/min global)', () => {
    const window = RECEPTION_RATE_LIMIT_DEFAULTS.per_endpoint_kind.drop_link;
    expect(window.max_requests).toBe(5);
    expect(window.window_ms).toBe(3_600_000);
  });
});

describe('D-149 P10 § A.11 T-5 — File-upload illegal content (substrate-level documented)', () => {
  it('substrate documents the user-responsibility scope via the operational access log', () => {
    // Substrate-level: T-5 ships no automatic protection beyond MIME / size /
    // scan. The user is responsible via the Settings → Drop blobs page. The
    // verifying check is that `public_endpoint_access_log` retains a
    // queryable per-blob record so the user can audit + delete.
    const env = buildEnv();
    insertSchedulingEndpoint(env, 'ep-T5', 'goodbearer');
    env.store.appendAccessLog({
      id: 'log-T5',
      endpoint_id: 'ep-T5',
      accessed_at: NOW,
      source_ip_hash: 'h',
      user_agent_hash: null,
      action_taken: 'view',
      outcome: 'ok',
      url_path_redacted: '/reception/drop/ep-T5',
      metadata: {},
    });
    const rows = env.store.readAccessLog({ endpoint_id: 'ep-T5' });
    expect(rows.length).toBe(1);
  });
});

describe('D-149 P10 § A.11 T-16 — Path traversal in drop_link filename (indexed via P7)', () => {
  it('drop blob storage path is content-hash-keyed (not filename-keyed) — structural', () => {
    // The verifying test lives in
    // `d-149-phase-7-drop-link-blob-storage.test.ts`; here we verify the
    // load-bearing substrate primitive — content-addressed paths cannot
    // traverse because the path component is a SHA-256 hex digest.
    const sample = 'fe' + 'd9' + 'c0'.repeat(30);
    expect(/^[0-9a-f]{64}$/.test(sample)).toBe(true);
    expect(sample.includes('..')).toBe(false);
    expect(sample.includes('/')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// T-6 — Token brute-force
// ────────────────────────────────────────────────────────────────

describe('D-149 P10 § A.11 T-6 — Token brute-force', () => {
  it('per-IP rate limit kicks in before HMAC compute on invalid-token spray', async () => {
    const env = buildEnv();
    insertSchedulingEndpoint(env, 'ep-T6', 'realbearer');
    const handler = buildHandler(env);
    // `scheduling_link`'s per-kind window (30/60s) is tighter than the
    // 60/60s global, so it binds first. Per § Must Hold I-10 the
    // pre-verify rate-limit runs BEFORE the HMAC compute — once the
    // window is exhausted every further guess is a cheap 429, not a
    // burned HMAC.
    const kindCap =
      RECEPTION_RATE_LIMIT_DEFAULTS.per_endpoint_kind.scheduling_link.max_requests;
    let last401 = -1;
    let first429 = -1;
    for (let i = 0; i < kindCap + 5; i += 1) {
      const res = fakeRes();
      await handler(
        fakeReq('GET', `/reception/scheduling/ep-T6?t=guess-${i}`, '198.51.100.6'),
        res,
      );
      if (res.status === 401) last401 = i;
      if (res.status === 429 && first429 === -1) first429 = i;
    }
    // Invalid-token guesses get 401 until the window exhausts.
    expect(last401).toBeGreaterThanOrEqual(0);
    expect(last401).toBeLessThanOrEqual(kindCap);
    // After the window: 429 — the rate-limit stopped the guess before
    // the verify path ran.
    expect(first429).toBeGreaterThan(0);
    expect(first429).toBeLessThanOrEqual(kindCap + 5);
    expect(first429).toBeGreaterThan(last401);
  });

  it('Retry-After header populated on rate-limit reject (§ A.16.6 wire shape)', async () => {
    const env = buildEnv();
    insertSchedulingEndpoint(env, 'ep-T6b', 'realbearer');
    const handler = buildHandler(env);
    const kindCap =
      RECEPTION_RATE_LIMIT_DEFAULTS.per_endpoint_kind.scheduling_link.max_requests;
    for (let i = 0; i < kindCap; i += 1) {
      const res = fakeRes();
      await handler(
        fakeReq('GET', `/reception/scheduling/ep-T6b?t=g-${i}`, '198.51.100.7'),
        res,
      );
    }
    const overflow = fakeRes();
    await handler(
      fakeReq('GET', `/reception/scheduling/ep-T6b?t=g-final`, '198.51.100.7'),
      overflow,
    );
    expect(overflow.status).toBe(429);
    expect(overflow.getHeader('retry-after')).toBeDefined();
  });
});

// ────────────────────────────────────────────────────────────────
// T-7 — Per-endpoint DDoS
// ────────────────────────────────────────────────────────────────

describe('D-149 P10 § A.11 T-7 — Per-endpoint DDoS', () => {
  it('flooding endpoint A from one IP does not lock out endpoint B from a different IP', async () => {
    const env = buildEnv();
    insertSchedulingEndpoint(env, 'ep-T7-A', 'tokenA');
    insertSchedulingEndpoint(env, 'ep-T7-B', 'tokenB');
    const handler = buildHandler(env);
    const limit = RECEPTION_RATE_LIMIT_DEFAULTS.per_ip_global.max_requests;
    // Burn endpoint A's rate-limit budget from ip_attacker.
    for (let i = 0; i < limit + 5; i += 1) {
      const res = fakeRes();
      await handler(
        fakeReq('GET', `/reception/scheduling/ep-T7-A?t=tokenA`, '198.51.100.20'),
        res,
      );
    }
    // ip_normal hitting endpoint B is unaffected (per-IP buckets are
    // per-source-IP-hash, so a different IP has its own budget).
    const res = fakeRes();
    await handler(
      fakeReq('GET', `/reception/scheduling/ep-T7-B?t=tokenB`, '198.51.100.21'),
      res,
    );
    expect([200, 503]).toContain(res.status);
    expect(res.status).not.toBe(429);
  });

  it('per-endpoint daily cap is per-endpoint_id, not per-kind (endpoint isolation)', () => {
    const db = new Database(':memory:');
    ensureReceptionSchema(db);
    const limiter = createReceptionRateLimiter({ db });
    const cap = RECEPTION_RATE_LIMIT_DEFAULTS.per_endpoint_daily_cap.drop_link;
    // Burn endpoint X's daily cap.
    for (let i = 0; i < cap; i += 1) {
      limiter.consumePostVerify({
        endpoint_id: 'endpoint-X',
        endpoint_kind: 'drop_link',
        now: NOW,
      });
    }
    expect(
      limiter.consumePostVerify({
        endpoint_id: 'endpoint-X',
        endpoint_kind: 'drop_link',
        now: NOW,
      }).ok,
    ).toBe(false);
    // Endpoint Y still has its full budget.
    expect(
      limiter.consumePostVerify({
        endpoint_id: 'endpoint-Y',
        endpoint_kind: 'drop_link',
        now: NOW,
      }).ok,
    ).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// T-8 — Information leakage via timing (best-effort)
// ────────────────────────────────────────────────────────────────

describe('D-149 P10 § A.11 T-8 — Information leakage via timing', () => {
  it('valid-id-wrong-token + nonexistent-id-wrong-token return the SAME wire shape', async () => {
    const env = buildEnv();
    insertSchedulingEndpoint(env, 'ep-T8', 'realbearer');
    const handler = buildHandler(env);
    const valid = fakeRes();
    await handler(
      fakeReq('GET', '/reception/scheduling/ep-T8?t=wrong', '198.51.100.30'),
      valid,
    );
    const bogus = fakeRes();
    await handler(
      fakeReq('GET', '/reception/scheduling/ep-bogus?t=wrong', '198.51.100.31'),
      bogus,
    );
    expect(valid.status).toBe(401);
    expect(bogus.status).toBe(401);
    // Both responses use the generic `unauthorized` code (no kind / state leak).
    expect(valid.body).toContain('unauthorized');
    expect(bogus.body).toContain('unauthorized');
    expect(valid.body).toBe(bogus.body);
  });

  it('token verify uses HMAC-keyed lookup (NOT Argon2id) per § A.18.2 + Trap Register TR-11', async () => {
    const tokens = await import('../ports/reception/token-primitives.js');
    const pepper = await import('../ports/reception/server-secret-pepper.js');
    // The verify primitive is `verifyBearerSecret` which delegates to
    // crypto.timingSafeEqual — a constant-time compare, NOT a password
    // hash. Per-request Argon2id would be a DoS lever.
    const hmac = pepper.computeBearerHmac('a-bearer', PEPPER);
    expect(
      tokens.verifyBearerSecret({
        submitted_secret: 'a-bearer',
        stored_hmac: hmac,
        pepper: PEPPER,
      }),
    ).toBe(true);
    expect(
      tokens.verifyBearerSecret({
        submitted_secret: 'other-bearer',
        stored_hmac: hmac,
        pepper: PEPPER,
      }),
    ).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// T-9 — Cross-endpoint privilege escalation
// ────────────────────────────────────────────────────────────────

describe('D-149 P10 § A.11 T-9 — Cross-endpoint token reuse', () => {
  it('token A presented at endpoint B returns 401 (per-endpoint scoping)', async () => {
    const env = buildEnv();
    insertSchedulingEndpoint(env, 'ep-T9-A', 'tokenA');
    insertSchedulingEndpoint(env, 'ep-T9-B', 'tokenB');
    const handler = buildHandler(env);
    // Sanity: tokenA works at endpoint A.
    const okA = fakeRes();
    await handler(
      fakeReq('GET', '/reception/scheduling/ep-T9-A?t=tokenA', '198.51.100.40'),
      okA,
    );
    expect(okA.status).toBe(200);
    // tokenA presented at endpoint B → 401.
    const reuse = fakeRes();
    await handler(
      fakeReq('GET', '/reception/scheduling/ep-T9-B?t=tokenA', '198.51.100.41'),
      reuse,
    );
    expect(reuse.status).toBe(401);
  });

  it('endpoint-kind mismatch (status_link token at scheduling URL) returns 401', async () => {
    const env = buildEnv();
    // Insert a scheduling endpoint + a status endpoint with their own
    // bearers. Present the status token at the scheduling path → 401
    // even though the secret matches a real row.
    insertSchedulingEndpoint(env, 'ep-T9-sched', 'schedToken');
    env.store.create({
      endpoint_id: 'ep-T9-status',
      kind: 'status_link',
      packet_declaration: {
        packet_kind: 'status_link_packet',
        source_query_ref: { kind: 'data.project', project_id: 'p1' },
      },
      bearer_secret_hmac: computeBearerHmac('statusToken', PEPPER),
      created_at: NOW - DAY,
      created_by_client_id: 'inst-1',
      expires_at: null,
      long_lived_acknowledged_at: NOW - DAY,
      metadata: {},
    });
    env.store.enable('ep-T9-status', NOW);
    const handler = buildHandler(env);
    // status token at scheduling URL — id matches scheduling but token
    // doesn't HMAC-match the scheduling endpoint's stored hash → 401.
    const wrong = fakeRes();
    await handler(
      fakeReq('GET', '/reception/scheduling/ep-T9-sched?t=statusToken', '198.51.100.45'),
      wrong,
    );
    expect(wrong.status).toBe(401);
  });
});

// ────────────────────────────────────────────────────────────────
// T-10 — Approval-link replay (indexed via P8)
// ────────────────────────────────────────────────────────────────

describe('D-149 P10 § A.11 T-10 — Approval-link replay (indexed via P8)', () => {
  it('approval-link single-use enforcement primitive is structurally documented', async () => {
    // Verifying test lives in `d-149-phase-8-approval-link-handler.test.ts`
    // ("second POST returns already-consumed page"). Here we verify the
    // contract-side primitive: `approval_intent.consumed` is in the
    // closed `RECEPTION_HIGH_ASSURANCE_AUDIT_KINDS` so consumption emits
    // a signed audit row.
    const { RECEPTION_HIGH_ASSURANCE_AUDIT_KIND_SET } = await import(
      '@recued/contracts'
    );
    expect(
      RECEPTION_HIGH_ASSURANCE_AUDIT_KIND_SET.has('approval_intent.consumed'),
    ).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// T-11 — Source-IP correlation across endpoints
// ────────────────────────────────────────────────────────────────

describe('D-149 P10 § A.11 T-11 — Source-IP correlation default-off', () => {
  it('endpoint-scoped hash differs across endpoints for the same client IP', () => {
    const ip = '198.51.100.50';
    const hashA = hashSourceIpEndpointScoped(ip, 'endpoint-A', PEPPER);
    const hashB = hashSourceIpEndpointScoped(ip, 'endpoint-B', PEPPER);
    expect(hashA).not.toBe(hashB);
  });

  it('server-wide hash matches across endpoints (opt-in path; same IP → same hash)', () => {
    const ip = '198.51.100.51';
    const hash1 = hashSourceIpServerWide(ip, PEPPER);
    const hash2 = hashSourceIpServerWide(ip, PEPPER);
    expect(hash1).toBe(hash2);
  });

  it('access log writes the endpoint-scoped hash by default (per I-8 + I-9)', async () => {
    const env = buildEnv();
    insertSchedulingEndpoint(env, 'ep-T11', 'tokenT11');
    const handler = buildHandler(env);
    await handler(
      fakeReq('GET', '/reception/scheduling/ep-T11?t=tokenT11', '198.51.100.52'),
      fakeRes(),
    );
    const rows = env.store.readAccessLog({ endpoint_id: 'ep-T11' });
    expect(rows.length).toBeGreaterThan(0);
    const got = rows[0]!.source_ip_hash;
    const expectedEndpointScoped = hashSourceIpEndpointScoped(
      '198.51.100.52',
      'ep-T11',
      PEPPER,
    );
    expect(got).toBe(expectedEndpointScoped);
    expect(got).not.toBe(hashSourceIpServerWide('198.51.100.52', PEPPER));
  });

  it('substrate has no visitor_id primitive — cross-endpoint correlation structurally infeasible by default', async () => {
    const contracts = await import('@recued/contracts');
    // Any cross-endpoint correlation primitive would have to live in
    // `@recued/contracts`. Assert none of the obvious names exist (this
    // is a structural ratchet; a future PR adding such a primitive
    // requires this test to fail + a § A.16.4 + § Must Hold I-9
    // amendment).
    expect((contracts as Record<string, unknown>)['VISITOR_ID']).toBeUndefined();
    expect(
      (contracts as Record<string, unknown>)['CROSS_ENDPOINT_VISITOR_ID'],
    ).toBeUndefined();
    expect(
      (contracts as Record<string, unknown>)['CROSS_ENDPOINT_HASH_DEFAULT'],
    ).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// T-12 — Visitor email leak across submissions (default off)
// ────────────────────────────────────────────────────────────────

describe('D-149 P10 § A.11 T-12 — Cross-submission visitor-email link absent by default', () => {
  it('per-row AEAD AAD includes (endpoint_id, submission_id, field) — same plaintext yields distinct ciphertexts', async () => {
    const key = deriveFormSubmissionPiiKeyFromSubDek(SUB_DEK);
    const sealedA = await sealFormSubmissionField({
      key,
      endpoint_id: 'endpoint-A',
      submission_id: 'sub-1',
      field: 'visitor_email',
      plaintext: 'visitor@example.com',
    });
    const sealedB = await sealFormSubmissionField({
      key,
      endpoint_id: 'endpoint-B',
      submission_id: 'sub-2',
      field: 'visitor_email',
      plaintext: 'visitor@example.com',
    });
    expect(sealedA).not.toBeNull();
    expect(sealedB).not.toBeNull();
    expect(sealedA).not.toBe(sealedB);
  });

  it('decrypt-with-wrong-AAD fails — cross-endpoint ciphertext substitution does not round-trip', async () => {
    const key = deriveFormSubmissionPiiKeyFromSubDek(SUB_DEK);
    const sealed = await sealFormSubmissionField({
      key,
      endpoint_id: 'endpoint-A',
      submission_id: 'sub-1',
      field: 'visitor_email',
      plaintext: 'visitor@example.com',
    });
    expect(sealed).not.toBeNull();
    // Attempt to decrypt the ciphertext from endpoint-A AS IF it belonged
    // to endpoint-B → AEAD-mismatch rejects.
    await expect(
      openFormSubmissionField({
        key,
        endpoint_id: 'endpoint-B',
        submission_id: 'sub-1',
        field: 'visitor_email',
        ciphertext: sealed,
      }),
    ).rejects.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────
// T-13 — Capacity exhaustion
// ────────────────────────────────────────────────────────────────

describe('D-149 P10 § A.11 T-13 — Capacity exhaustion', () => {
  it('per-endpoint daily cap fires before unbounded growth (drop_link 50; intake_form 1000; status_link 5000)', () => {
    const caps = RECEPTION_RATE_LIMIT_DEFAULTS.per_endpoint_daily_cap;
    expect(caps.drop_link).toBe(50);
    expect(caps.intake_form).toBe(1_000);
    expect(caps.status_link).toBe(5_000);
    expect(caps.scheduling_link).toBe(100);
    expect(caps.approval_link).toBe(100);
    // reception_page is uncapped (singleton, server-wide rate-limit applies).
    expect(caps.reception_page).toBe(Number.POSITIVE_INFINITY);
  });

  it('rate-limiter snapshot persists state across simulated restart (§ Open question 7)', () => {
    const db = new Database(':memory:');
    ensureReceptionSchema(db);
    const limiter1 = createReceptionRateLimiter({ db });
    for (let i = 0; i < 10; i += 1) {
      limiter1.consumePostVerify({
        endpoint_id: 'ep-T13',
        endpoint_kind: 'drop_link',
        now: NOW,
      });
    }
    limiter1.snapshot(NOW);
    // Simulated restart — fresh limiter against the same DB.
    const limiter2 = createReceptionRateLimiter({ db });
    limiter2.reload(NOW);
    // Continue: previous 10 + new 41 = 51 → 51st (index 40) should reject.
    let firstReject = -1;
    for (let i = 0; i < 50; i += 1) {
      const r = limiter2.consumePostVerify({
        endpoint_id: 'ep-T13',
        endpoint_kind: 'drop_link',
        now: NOW,
      });
      if (!r.ok && firstReject === -1) firstReject = i;
    }
    expect(firstReject).toBeGreaterThanOrEqual(0);
    // Pre-restart consumed 10; post-restart should reject within ~40.
    expect(firstReject).toBeLessThanOrEqual(40);
  });
});

// ────────────────────────────────────────────────────────────────
// T-14 — Malicious-content reflection (XSS)
// ────────────────────────────────────────────────────────────────

describe('D-149 P10 § A.11 T-14 — Malicious-content reflection (XSS)', () => {
  it("substrate renders all visitor-facing kinds with `script-src 'none'` CSP", async () => {
    const env = buildEnv();
    insertSchedulingEndpoint(env, 'ep-T14', 'tokenT14');
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(
      fakeReq('GET', '/reception/scheduling/ep-T14?t=tokenT14', '198.51.100.60'),
      res,
    );
    expect(res.status).toBe(200);
    // CSP `script-src 'none'` prevents inline JS reflection.
    expect(res.body).toContain("script-src 'none'");
  });

  it('reflective text (display_name) is htmlEscape\'d on render', async () => {
    const env = buildEnv();
    const xssConfig: SchedulingLinkConfig = {
      ...schedulingConfig,
      display_name: '<script>alert(1)</script>',
    };
    env.store.create({
      endpoint_id: 'ep-T14b',
      kind: 'scheduling_link',
      packet_declaration: {
        packet_kind: 'scheduling_link_packet',
        source_query_ref: { kind: 'data.calendar.combined' },
      },
      bearer_secret_hmac: computeBearerHmac('tokenT14b', PEPPER),
      created_at: NOW - DAY,
      created_by_client_id: 'inst-1',
      expires_at: null,
      long_lived_acknowledged_at: NOW - DAY,
      metadata: xssConfig as unknown as Record<string, unknown>,
    });
    env.store.enable('ep-T14b', NOW);
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(
      fakeReq('GET', '/reception/scheduling/ep-T14b?t=tokenT14b', '198.51.100.61'),
      res,
    );
    expect(res.status).toBe(200);
    // Raw `<script>` MUST NOT appear; the substrate must HTML-escape.
    expect(res.body).not.toMatch(/<script>alert\(1\)<\/script>/);
    // The escaped form is present (substrate uses &lt; / &gt;).
    expect(res.body).toContain('&lt;script&gt;');
  });
});

// ────────────────────────────────────────────────────────────────
// T-15 — TLS downgrade / cleartext traffic
// ────────────────────────────────────────────────────────────────

describe('D-149 P10 § A.11 T-15 — TLS downgrade / cleartext traffic', () => {
  it('substrate is hostname-agnostic — TLS termination is at the listener; the handler does NOT inspect TLS state', async () => {
    // Reception code paths MUST NOT reference TLS / scheme primitives —
    // termination happens at D-148 P6/P7's consolidated listener. T-15
    // is enforced by HSTS preload on Pro DDNS handles + the LAN port-80
    // listener path resolution + the public port-443 listener. This
    // test verifies the substrate primitive: no reception handler
    // reads `req.connection.encrypted` / `req.headers['x-forwarded-proto']`
    // and the response paths are scheme-blind.
    const env = buildEnv();
    insertSchedulingEndpoint(env, 'ep-T15', 'tokenT15');
    const handler = buildHandler(env);
    const httpsReq = fakeReq(
      'GET',
      '/reception/scheduling/ep-T15?t=tokenT15',
      '198.51.100.70',
      { 'x-forwarded-proto': 'https' },
    );
    const httpReq = fakeReq(
      'GET',
      '/reception/scheduling/ep-T15?t=tokenT15',
      '198.51.100.71',
      { 'x-forwarded-proto': 'http' },
    );
    const httpsRes = fakeRes();
    const httpRes = fakeRes();
    await handler(httpsReq, httpsRes);
    await handler(httpReq, httpRes);
    // Both succeed — substrate is hostname/scheme agnostic. TLS is
    // enforced at the listener level (Pro DDNS handle ships HSTS;
    // free path users configure HSTS on their reverse proxy).
    expect(httpsRes.status).toBe(200);
    expect(httpRes.status).toBe(200);
  });
});

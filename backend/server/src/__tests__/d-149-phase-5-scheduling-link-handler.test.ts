/** D-149 P5 § A.5.2 — scheduling_link GET + POST /book integration tests.
 *
 *  Covers:
 *    - Token-less request returns 401.
 *    - Authorized GET renders the slot picker form + HTTP headers
 *      (CSP / no-store / X-Frame-Options DENY).
 *    - POST /book with valid form succeeds + persists a booking row.
 *    - POST /book rejects stale / missing form_nonce.
 *    - POST /book rejects mismatched Origin.
 *    - POST /book rejects slots not in the enumerated candidate set.
 *    - POST /book enforces max_bookings_per_day.
 *    - Rendered HTML never carries event titles / attendees / agendas
 *      from the underlying calendar fixture (no-leak invariant). */

import Database from 'better-sqlite3';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  PACKET_FIELDS_VISIBLE,
  RECEPTION_ENDPOINT_KIND_TO_PACKET_KIND,
  type AvailabilityRawCalendarEvent,
  type SchedulingLinkConfig,
} from '@recued/contracts';
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
} from '../ports/reception/server-secret-pepper.js';
import { createInMemorySchedulingFormNonceStore } from '../ports/reception/handlers/scheduling-link.js';
// ⚠ The FORM key, not the booking one — a booking's fields seal under the key
// its table's readers open with (`booking-blob.ts`).
import { deriveFormSubmissionPiiKeyFromSubDek } from '../ports/reception/form-pii.js';
import type { AuditLogStore } from '@recued/storage';

// 30-min-aligned (a genuinely "round" timestamp — the booking test below
// hardcodes `NOW + 1h` as the first candidate, which only holds when NOW is
// on the tz-local clock grid the enumerator snaps to). `1_700_000_000_000`
// is 800_000 ms past a 30-min boundary, so floor it.
const NOW = 1_700_000_000_000 - (1_700_000_000_000 % (30 * 60 * 1000)); // 1_699_999_200_000
const SUB_DEK = new Uint8Array(32).fill(0x4a);
const PEPPER = deriveReceptionPepper(Buffer.alloc(32, 0x77));
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const fakeAudit = (): AuditLogStore => {
  return {
    logActivity: async () => undefined,
    listActivity: async () => [],
    listAgentAccess: async () => [],
    listProvenanceLinks: async () => [],
    timeline: async () => [],
    bumpInsightSnapshotIfDifferent: async () => null,
    queryRecipeInsight: async () => null,
  } as unknown as AuditLogStore;
};

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

const goodConfig: SchedulingLinkConfig = {
  display_name: 'Mary Smith',
  instructions: 'Book a 30-minute consult.',
  duration_options_minutes: [30, 60],
  available_window_definition: {
    // Test fixture spans 24h on every day so the slot enumerator
    // doesn't fight the availability intersection in the booking-
    // flow happy-path tests below. The intersection logic itself is
    // exercised by `d-149-phase-5-scheduling-link-slots.test.ts`.
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

const insertEndpoint = (
  env: ReturnType<typeof buildEnv>,
  bearer: string,
  config: SchedulingLinkConfig = goodConfig,
) => {
  const endpoint_id = 'ep-scheduling-1';
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
    metadata: config as unknown as Record<string, unknown>,
  });
  env.store.enable(endpoint_id, NOW);
  return endpoint_id;
};

const fakeReq = (method: string, url: string, body?: string, headers?: Record<string, string>): IncomingMessage => {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: '203.0.113.5' });
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = url;
  Object.assign(req.headers, headers ?? {});
  if (body !== undefined) {
    // Drive the data/end events on next tick so the consumer can subscribe.
    setImmediate(() => {
      req.emit('data', Buffer.from(body, 'utf8'));
      req.emit('end');
    });
  }
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

const buildHandler = (
  env: ReturnType<typeof buildEnv>,
  calendarEvents: ReadonlyArray<AvailabilityRawCalendarEvent>,
) =>
  createReceptionPortHandler({
    getStore: () => env.store,
    getCache: () => env.cache,
    getRateLimiter: () => env.limiter,
    getPepper: () => PEPPER,
    now: () => NOW,
    getIntakeFormSubmissionStore: () => env.booking,
    getSchedulingFormNonceStore: () => env.formNonce,
    getSchedulingCalendarReader: () => ({
      list: () => calendarEvents,
    }),
    getIntakeFormSubmissionPiiKey: () => deriveFormSubmissionPiiKeyFromSubDek(SUB_DEK),
    auditLog: fakeAudit(),
  });

describe('D-149 P5 § A.5.2 — GET /reception/scheduling/<id>', () => {
  it('returns 401 when no token is supplied', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env, []);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/scheduling/ep-scheduling-1'), res);
    expect(res.status).toBe(401);
  });

  it('returns 200 with slot picker HTML for a valid token', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env, []);
    const res = fakeRes();
    await handler(
      fakeReq('GET', '/reception/scheduling/ep-scheduling-1?t=goodbearer'),
      res,
    );
    expect(res.status).toBe(200);
    expect(res.getHeader('content-type')).toBe('text/html; charset=utf-8');
    expect(res.getHeader('cache-control')).toBe('no-store');
    expect(res.getHeader('x-frame-options')).toBe('DENY');
    expect(res.body).toContain('Schedule with Mary Smith');
    expect(res.body).toContain('script-src \'none\'');
    expect(res.body).toContain('action="/reception/scheduling/ep-scheduling-1/book?t=');
  });

  it('renders 503 placeholder when registry metadata is corrupt', async () => {
    const env = buildEnv();
    // Insert a row with garbage metadata
    env.store.create({
      endpoint_id: 'ep-scheduling-2',
      kind: 'scheduling_link',
      packet_declaration: {
        packet_kind: 'scheduling_link_packet',
        source_query_ref: { kind: 'data.calendar.combined' },
      },
      bearer_secret_hmac: computeBearerHmac('badcfg', PEPPER),
      created_at: NOW - DAY,
      created_by_client_id: 'inst-1',
      expires_at: null,
      long_lived_acknowledged_at: NOW - DAY,
      metadata: { not_a_config: true } as unknown as Record<string, unknown>,
    });
    env.store.enable('ep-scheduling-2', NOW);
    const handler = buildHandler(env, []);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/scheduling/ep-scheduling-2?t=badcfg'), res);
    expect(res.status).toBe(503);
    expect(res.body).toContain('not currently accepting bookings');
  });

  it('switches duration via ?duration= query param', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env, []);
    const res = fakeRes();
    await handler(
      fakeReq(
        'GET',
        '/reception/scheduling/ep-scheduling-1?t=goodbearer&duration=60',
      ),
      res,
    );
    expect(res.status).toBe(200);
    // Hidden field carries the active duration
    expect(res.body).toContain('name="duration" value="60"');
  });
});

describe('D-149 P5 § A.5.2 — POST /reception/scheduling/<id>/book', () => {
  it('rejects POST when Origin header is missing', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env, []);
    // Issue a form nonce
    const nonce = env.formNonce.issue('ep-scheduling-1', NOW);
    const body = `t=goodbearer&form_nonce=${nonce}&duration=30&slot=${NOW + 25 * HOUR}|${NOW + 25 * HOUR + 30 * 60 * 1000}|30&visitor_name=Q&visitor_email=q%40example.com`;
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/scheduling/ep-scheduling-1/book?t=goodbearer', body, {
        host: 'localhost',
        'content-type': 'application/x-www-form-urlencoded',
      }),
      res,
    );
    expect(res.status).toBe(403);
  });

  it('rejects POST when form_nonce is stale (already consumed)', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env, []);
    const nonce = env.formNonce.issue('ep-scheduling-1', NOW);
    env.formNonce.consume('ep-scheduling-1', nonce, NOW); // burn it
    const body = `t=goodbearer&form_nonce=${nonce}&duration=30&slot=${NOW + 25 * HOUR}|${NOW + 25 * HOUR + 30 * 60 * 1000}|30&visitor_name=Q&visitor_email=q%40example.com`;
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/scheduling/ep-scheduling-1/book?t=goodbearer', body, {
        host: 'localhost',
        origin: 'http://localhost',
        'content-type': 'application/x-www-form-urlencoded',
      }),
      res,
    );
    expect(res.status).toBe(400);
    expect(res.body).toContain('reload the page');
  });

  it('rejects POST when slot does not match a candidate', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env, []);
    const nonce = env.formNonce.issue('ep-scheduling-1', NOW);
    // Random slot that is in advance but not aligned to enumerated candidates.
    const body = `t=goodbearer&form_nonce=${nonce}&duration=30&slot=${NOW + 25 * HOUR + 13}|${NOW + 25 * HOUR + 30 * 60 * 1000 + 13}|30&visitor_name=Q&visitor_email=q%40example.com`;
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/scheduling/ep-scheduling-1/book?t=goodbearer', body, {
        host: 'localhost',
        origin: 'http://localhost',
        'content-type': 'application/x-www-form-urlencoded',
      }),
      res,
    );
    expect(res.status).toBe(409);
  });

  it('writes a booking row on a valid submission', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env, []);
    // Enumerate one candidate to pick a real slot
    const nonceForGet = env.formNonce.issue('ep-scheduling-1', NOW);
    void nonceForGet;
    // Re-issue + reuse a fresh nonce for the POST
    const nonce = env.formNonce.issue('ep-scheduling-1', NOW);
    // Slot: NOW + 25 hours rounded to a 30-minute boundary inside the window
    // is too coarse. Easier: pick the FIRST candidate computeFreeWindows
    // would emit — see slot-enumeration tests; the look-ahead window is
    // 30 * DAY so the first candidate inside the look-ahead is at
    // ceil(NOW + advance_notice_hours * HOUR) snapped to a 30-min step
    // boundary relative to NOW. With min_advance_notice_hours=1 +
    // NOW being a round timestamp, the first candidate is NOW + 1h.
    const slotStart = NOW + 1 * HOUR;
    const slotEnd = slotStart + 30 * 60 * 1000;
    const body = `t=goodbearer&form_nonce=${nonce}&duration=30&slot=${slotStart}|${slotEnd}|30&visitor_name=Q&visitor_email=q%40example.com&visitor_topic=Hello`;
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/scheduling/ep-scheduling-1/book?t=goodbearer', body, {
        host: 'localhost',
        origin: 'http://localhost',
        'content-type': 'application/x-www-form-urlencoded',
      }),
      res,
    );
    expect(res.status).toBe(200);
    expect(res.body).toContain('Booking received');
    const pending = env.booking.listPendingBookingsForEndpoint('ep-scheduling-1');
    expect(pending.length).toBe(1);
    expect(pending[0]!.slot?.start_at).toBe(slotStart);
    // D-210 A.8 slice 4b-ii — name / phone / topic / notes folded into the ONE
    // `submission_blob_encrypted`; the email keeps its own column. Same claim as
    // the four-column assertion it replaces: the visitor's typed fields reached
    // the row SEALED, not dropped.
    expect(pending[0]!.submission_blob_encrypted.length).toBeGreaterThan(0);
    expect(pending[0]!.visitor_email_encrypted).not.toBeNull();
  });

  it('admits TWO visitors booking the SAME slot — capacity is the owner’s call, not the door’s', async () => {
    // The behaviour change of 2026-07-16, driven end-to-end through the real
    // HTTP handler. Until now the second visitor got a 409 error page — "That
    // time was just booked. Please pick another slot." — because an overlap
    // refusal hard-coded capacity to 1 per endpoint. A restaurant with 100
    // tables holds 100 bookings at the same time; a yoga class holds 10. How
    // many is too many is a judgment only the owner can make, and they make it
    // at the D-157 gate — which is what D-173 D7 means by "confirmed at
    // approval". Both bookings now land as separate holds for the owner to
    // approve or reject.
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env, []);
    const slotStart = NOW + 1 * HOUR;
    const slotEnd = slotStart + 30 * 60 * 1000;

    const book = async (visitor: string) => {
      const nonce = env.formNonce.issue('ep-scheduling-1', NOW);
      const body = `t=goodbearer&form_nonce=${nonce}&duration=30&slot=${slotStart}|${slotEnd}|30&visitor_name=${visitor}&visitor_email=${visitor}%40example.com&visitor_topic=Hello`;
      const res = fakeRes();
      await handler(
        fakeReq('POST', '/reception/scheduling/ep-scheduling-1/book?t=goodbearer', body, {
          host: 'localhost',
          origin: 'http://localhost',
          'content-type': 'application/x-www-form-urlencoded',
        }),
        res,
      );
      return res;
    };

    const first = await book('Ana');
    const second = await book('Ben');

    expect(first.status).toBe(200);
    expect(first.body).toContain('Booking received');
    // The one that used to be turned away.
    expect(second.status).toBe(200);
    expect(second.body).toContain('Booking received');

    // Both are real, distinct holds at the same instant — the owner sees two
    // inbox items and decides.
    const pending = env.booking.listPendingBookingsForEndpoint('ep-scheduling-1');
    expect(pending.length).toBe(2);
    expect(pending.map((p) => p.slot?.start_at)).toEqual([slotStart, slotStart]);
    expect(new Set(pending.map((p) => p.submission_id)).size).toBe(2);
  });

  it('rejects POST when an unknown form field is present', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env, []);
    const nonce = env.formNonce.issue('ep-scheduling-1', NOW);
    const body = `t=goodbearer&form_nonce=${nonce}&duration=30&slot=${NOW + HOUR}|${NOW + HOUR + 30 * 60 * 1000}|30&visitor_name=Q&visitor_email=q%40example.com&malicious=1`;
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/scheduling/ep-scheduling-1/book?t=goodbearer', body, {
        host: 'localhost',
        origin: 'http://localhost',
        'content-type': 'application/x-www-form-urlencoded',
      }),
      res,
    );
    expect(res.status).toBe(400);
  });

  it('enforces max_bookings_per_day cap', async () => {
    const env = buildEnv();
    const cappedConfig: SchedulingLinkConfig = { ...goodConfig, max_bookings_per_day: 1 };
    insertEndpoint(env, 'goodbearer', cappedConfig);
    // Pre-fill one booking. D-210 A.8 slice 4b-ii — `slot` present is what MAKES
    // the row a booking (the store derives the kind from it), and the blob is
    // NOT NULL, so a placeholder ciphertext stands in for the sealed fields the
    // cap never reads.
    env.booking.insert({
      submission_id: 'req-prior',
      endpoint_id: 'ep-scheduling-1',
      form_definition_id: null,
      submitted_at: NOW - HOUR,
      source_ip_hash: null,
      visitor_email_encrypted: null,
      submission_blob_encrypted: 'AQID',
      schema_version: 1,
      processing_outcome: 'pending',
      slot: {
        start_at: NOW + HOUR,
        end_at: NOW + HOUR + 30 * 60 * 1000,
        duration_minutes: 30,
      },
    });
    const handler = buildHandler(env, []);
    const nonce = env.formNonce.issue('ep-scheduling-1', NOW);
    const slotStart = NOW + 2 * HOUR;
    const slotEnd = slotStart + 30 * 60 * 1000;
    const body = `t=goodbearer&form_nonce=${nonce}&duration=30&slot=${slotStart}|${slotEnd}|30&visitor_name=Q&visitor_email=q%40example.com`;
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/scheduling/ep-scheduling-1/book?t=goodbearer', body, {
        host: 'localhost',
        origin: 'http://localhost',
        'content-type': 'application/x-www-form-urlencoded',
      }),
      res,
    );
    expect(res.status).toBe(429);
  });
});

describe('D-149 P5 § A.5.2 — fields_visible matches the packet ceiling', () => {
  it('PACKET_FIELDS_VISIBLE.scheduling_link_packet excludes calendar event titles', () => {
    const fields = PACKET_FIELDS_VISIBLE['scheduling_link_packet'];
    expect(fields).toContain('free_windows');
    expect(fields).toContain('duration_options');
    expect(fields).not.toContain('calendar_events');
    expect(fields).not.toContain('title');
    expect(fields).not.toContain('attendees');
    expect(fields).not.toContain('notes');
  });

  it('endpoint kind binds to scheduling_link_packet only', () => {
    expect(RECEPTION_ENDPOINT_KIND_TO_PACKET_KIND.scheduling_link).toBe('scheduling_link_packet');
  });
});

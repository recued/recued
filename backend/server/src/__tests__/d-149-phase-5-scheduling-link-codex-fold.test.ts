/** D-149 P5 Codex review fold (2026-05-13) — ratchet tests covering
 *  four of the five findings:
 *
 *    P1 #1 — availability windows applied to free_windows before
 *            slot enumeration.
 *    P1 #2 — null calendar reader → dispatcher falls back to 503 stub
 *            (rather than rendering false availability).
 *    P2 #1 — token-bearing scheduling pages emit
 *            `Referrer-Policy: no-referrer`.
 *    P2 #2 — config validator rejects phone='required' / notes='required'
 *            per spec § A.5.2 line 609-615.
 *
 *  Each ratchet is its own `describe` block so a regression that
 *  re-opens any single fold surfaces under the matching label.
 *
 *  ## P1 #3 RETIRED 2026-07-16 — its premise expired
 *
 *  P1 #3 ("POST /book rejects a slot overlapping any non-rejected pending
 *  booking") and its four ratchets are DELETED, with their subject. The fold
 *  closed a race — a second visitor claiming a slot before the calendar
 *  reflected the first — but that is only a race at CAPACITY 1, an assumption
 *  the substrate was never entitled to make (a 100-table restaurant holds 100
 *  bookings at once). Capacity is the owner's judgment, exercised at the D-157
 *  gate against the overlap COUNT on the approval ask — D-173 D7's
 *  "confirmed at approval". The guard also produced two live defects; see
 *  `d-173-i5-slot-edit-row-staleness.test.ts` and
 *  internal design notes § 9.
 *
 *  This is a deliberate retirement, not a regression: re-adding an overlap
 *  refusal here would re-hardcode capacity to 1. */

import Database from 'better-sqlite3';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import type {
  AvailabilityRawCalendarEvent,
  FreeWindow,
  SchedulingLinkConfig,
} from '@recued/contracts';
import { validateSchedulingLinkConfig } from '@recued/contracts';
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
import { intersectWithAvailabilityWindows } from '../ports/reception/transformations/scheduling-link-slots.js';
import type { AuditLogStore } from '@recued/storage';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PEPPER = deriveReceptionPepper(Buffer.alloc(32, 0x77));
const SUB_DEK = new Uint8Array(32).fill(0x4a);

const fakeAudit = (): AuditLogStore =>
  ({
    logActivity: async () => undefined,
    listActivity: async () => [],
    listAgentAccess: async () => [],
    listProvenanceLinks: async () => [],
    timeline: async () => [],
    bumpInsightSnapshotIfDifferent: async () => null,
    queryRecipeInsight: async () => null,
  }) as unknown as AuditLogStore;

const fakeReq = (
  method: string,
  url: string,
  body?: string,
  headers?: Record<string, string>,
): IncomingMessage => {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: '203.0.113.5' });
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = url;
  Object.assign(req.headers, headers ?? {});
  if (body !== undefined) {
    setImmediate(() => {
      req.emit('data', Buffer.from(body, 'utf8'));
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

const configWithMondayOnly = (): SchedulingLinkConfig => ({
  display_name: 'Mary Smith',
  duration_options_minutes: [30],
  available_window_definition: {
    tz: 'America/New_York',
    explicit_windows: [{ day_of_week: 1, start_minute: 540, end_minute: 1020 }],
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
});

const insertEndpoint = (env: ReturnType<typeof buildEnv>, bearer: string, config: SchedulingLinkConfig) => {
  const endpoint_id = 'ep-codex-fold-1';
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

const buildHandler = (
  env: ReturnType<typeof buildEnv>,
  calendarEvents: ReadonlyArray<AvailabilityRawCalendarEvent>,
  options?: { omitCalendarReader?: boolean },
) =>
  createReceptionPortHandler({
    getStore: () => env.store,
    getCache: () => env.cache,
    getRateLimiter: () => env.limiter,
    getPepper: () => PEPPER,
    now: () => NOW,
    getIntakeFormSubmissionStore: () => env.booking,
    getSchedulingFormNonceStore: () => env.formNonce,
    ...(options?.omitCalendarReader === true
      ? {}
      : {
          getSchedulingCalendarReader: () => ({
            list: () => calendarEvents,
          }),
        }),
    getIntakeFormSubmissionPiiKey: () => deriveFormSubmissionPiiKeyFromSubDek(SUB_DEK),
    auditLog: fakeAudit(),
  });

describe('D-149 P5 Codex P1 #1 — availability windows applied before enumeration', () => {
  it('intersectWithAvailabilityWindows fails closed (no slots) when explicit_windows is empty', () => {
    // D-173 P4.2 — with the cold-start null calendar reader the full
    // look-ahead arrives as free; an empty availability declaration must
    // yield ZERO slots (not the whole look-ahead), since native
    // availability is `explicit_windows` and the engine-side SI path is
    // out of v1 scope.
    const fw: FreeWindow[] = [{ start_at: NOW, end_at: NOW + DAY }];
    const out = intersectWithAvailabilityWindows({
      free_windows: fw,
      explicit_windows: [],
      tz: 'America/New_York',
      window_start: NOW,
      window_end: NOW + DAY,
    });
    expect(out).toEqual([]);
  });

  it('intersectWithAvailabilityWindows drops free windows outside availability', () => {
    // A Monday 9-5 NYC config + a free window that lies entirely on
    // a Tuesday → the intersection must be empty.
    const tuesday17UTC = Date.UTC(2023, 10, 14, 17, 0, 0); // Tuesday 12:00 ET
    const fw: FreeWindow[] = [{ start_at: tuesday17UTC, end_at: tuesday17UTC + HOUR }];
    const out = intersectWithAvailabilityWindows({
      free_windows: fw,
      explicit_windows: [{ day_of_week: 1, start_minute: 540, end_minute: 1020 }], // Monday only
      tz: 'America/New_York',
      window_start: tuesday17UTC - DAY,
      window_end: tuesday17UTC + DAY,
    });
    expect(out).toEqual([]);
  });

  it('intersectWithAvailabilityWindows preserves the overlap when free window crosses the boundary', () => {
    // Monday 8:00am-10:00am ET = Monday 13:00-15:00 UTC (Nov 13 2023 is
    // standard time in NY). Availability: Mon 9-5 ET. Output should be
    // Mon 9-10 ET = 1 hour.
    const monday13UTC = Date.UTC(2023, 10, 13, 13, 0, 0);
    const fw: FreeWindow[] = [{ start_at: monday13UTC, end_at: monday13UTC + 2 * HOUR }];
    const out = intersectWithAvailabilityWindows({
      free_windows: fw,
      explicit_windows: [{ day_of_week: 1, start_minute: 540, end_minute: 1020 }],
      tz: 'America/New_York',
      window_start: monday13UTC - HOUR,
      window_end: monday13UTC + 3 * HOUR,
    });
    expect(out.length).toBe(1);
    expect(out[0]!.end_at - out[0]!.start_at).toBe(HOUR);
  });

  it('GET render: every emitted slot label starts with "Mon" under Monday-only config', async () => {
    // Pre-fold, the renderer would have emitted slot candidates on
    // every weekday of the look-ahead. Post-fold, the only slots that
    // survive the intersection are Monday-of-week candidates, so the
    // visitor-facing labels all start with the "Mon" weekday prefix.
    const env = buildEnv();
    insertEndpoint(env, 'bearer', configWithMondayOnly());
    const handler = buildHandler(env, []);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/scheduling/ep-codex-fold-1?t=bearer'), res);
    expect(res.status).toBe(200);
    // Each `<option value="...">{display_label}</option>` carries a
    // label of the form `<weekday>, <month> <day> · <start>–<end>`.
    // Pull out the labels + assert every one starts with "Mon ".
    const labels = res.body.match(/<option value="[^"]+">([^<]+)<\/option>/g) ?? [];
    expect(labels.length).toBeGreaterThan(0);
    for (const m of labels) {
      // Skip the duration-option <option> elements (these have no comma).
      // Slot labels look like `Mon, Nov 20 · 09:00–09:30`.
      const inner = m.replace(/<option value="[^"]+">/, '').replace('</option>', '');
      if (!inner.includes(',')) continue;
      expect(inner.startsWith('Mon')).toBe(true);
    }
  });
});

describe('D-149 P5 Codex P1 #2 — null calendar reader degrades to 503', () => {
  it('dispatcher falls back to the kind-registry 503 stub when calendar reader omitted', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'bearer', configWithMondayOnly());
    const handler = buildHandler(env, [], { omitCalendarReader: true });
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/scheduling/ep-codex-fold-1?t=bearer'), res);
    expect(res.status).toBe(503);
  });
});


describe('D-149 P5 Codex P2 #1 — Referrer-Policy: no-referrer on scheduling pages', () => {
  it('GET render emits Referrer-Policy: no-referrer', async () => {
    const config: SchedulingLinkConfig = {
      ...configWithMondayOnly(),
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
    };
    const env = buildEnv();
    insertEndpoint(env, 'bearer', config);
    const handler = buildHandler(env, []);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/scheduling/ep-codex-fold-1?t=bearer'), res);
    expect(res.getHeader('referrer-policy')).toBe('no-referrer');
  });
});

describe('D-149 P5 Codex P2 #2 — config validator rejects phone/notes=required', () => {
  it('rejects phone=required', () => {
    const c = {
      ...configWithMondayOnly(),
      required_visitor_fields: {
        name: 'required',
        email: 'required',
        topic: 'optional',
        phone: 'required',
        notes: 'optional',
      },
    } as unknown;
    expect(
      validateSchedulingLinkConfig(c).some((f) => f.code === 'visitor_fields_invalid'),
    ).toBe(true);
  });

  it('rejects notes=required', () => {
    const c = {
      ...configWithMondayOnly(),
      required_visitor_fields: {
        name: 'required',
        email: 'required',
        topic: 'optional',
        phone: 'omit',
        notes: 'required',
      },
    } as unknown;
    expect(
      validateSchedulingLinkConfig(c).some((f) => f.code === 'visitor_fields_invalid'),
    ).toBe(true);
  });

  it('accepts phone=optional + notes=optional', () => {
    const c = {
      ...configWithMondayOnly(),
      required_visitor_fields: {
        name: 'required',
        email: 'required',
        topic: 'optional',
        phone: 'optional',
        notes: 'optional',
      },
    };
    expect(validateSchedulingLinkConfig(c)).toEqual([]);
  });
});

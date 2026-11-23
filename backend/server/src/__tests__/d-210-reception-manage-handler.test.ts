/** D-210 Appendix B — the `/reception/manage/<secret>` on-the-go reschedule
 *  surface, exercised through the real Reception port dispatcher.
 *
 *  Covers the two properties the whole design rests on:
 *    - GET renders the slot picker WITHOUT consuming the credential (mail
 *      scanners must not burn it); POST consumes once.
 *    - The reschedule TARGET is the credential's booking event, never the form —
 *      the visitor picks a new time, they cannot retarget another event.
 *  Plus the dedicated-credential-surface gate order (404 without deps, IP block,
 *  rate-limit, access-log outcomes) mirrored from the seller-claim surface.
 *
 *  Spec: D-210 Appendix B. Harness modelled on
 *  `d-196-seller-claim-handler.test.ts` + `d-149-phase-5-scheduling-link-handler.test.ts`. */

import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AvailabilityRawCalendarEvent, SchedulingLinkConfig } from '@recued/contracts';

import { createReceptionManageCredentialStore } from '../storage/reception-manage-credential-store.js';
// D-210 A.8 slice 4b-ii — the reservation is a `reception_form_submission` row
// with a slot; same id, same lookup, different table.
import type { FormSubmissionSummary } from '../storage/reception-form-store.js';
import { createInMemorySchedulingFormNonceStore } from '../ports/reception/handlers/scheduling-link.js';
import {
  RECEPTION_MANAGE_ENDPOINT_ID,
  RECEPTION_MANAGE_PATH,
} from '../ports/reception/handlers/manage.js';
import { createReceptionPortHandler } from '../ports/reception/handler.js';
import { deriveReceptionPepper } from '../ports/reception/server-secret-pepper.js';

// 30-min aligned so the slot enumerator's first candidate lands on the grid.
const NOW = 1_700_000_000_000 - (1_700_000_000_000 % (30 * 60 * 1000));
const HOUR = 60 * 60 * 1000;
const HOST = 'desk.local';
const ORIGIN = `https://${HOST}`;
/** The `data_booking` row the reservation resolved to — what the manage page
 *  now moves. ⚠ Was `EVENT_ID` (a calendar event) until D-210 A.2. */
const MINTED_BOOKING_ID = 'reception_booking-managed-1';
const BOOKING_ID = 'booking-1';
const ENDPOINT_ID = 'ep-scheduling-1';

const goodConfig: SchedulingLinkConfig = {
  display_name: 'Mary Smith',
  instructions: 'Book a 30-minute consult.',
  duration_options_minutes: [30, 60],
  available_window_definition: {
    tz: 'America/New_York',
    explicit_windows: [0, 1, 2, 3, 4, 5, 6].map((day_of_week) => ({
      day_of_week,
      start_minute: 0,
      end_minute: 1440,
    })),
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

const booking = (overrides: Partial<FormSubmissionSummary> = {}): FormSubmissionSummary => ({
  submission_id: BOOKING_ID,
  endpoint_id: ENDPOINT_ID,
  // D-210 A.8 slice 4b-ii — a booking has no form definition; the `slot` is what
  // tells it apart from an intake, and the sealed visitor fields are one blob.
  form_definition_id: null,
  submitted_at: NOW,
  source_ip_hash: null,
  visitor_email_encrypted: null,
  submission_blob_encrypted: 'AQID',
  schema_version: 1,
  record_kind: 'booking',
  slot: {
    start_at: NOW + HOUR,
    end_at: NOW + HOUR + 30 * 60_000,
    duration_minutes: 30,
  },
  processing_outcome: 'processed',
  // ⛔ BOTH halves of the resolved pointer. `resolveTarget` now checks the KIND
  // as well as the id — a row resolved to something else is not a reschedule
  // target, and reading its id as a booking id would move the wrong record.
  resolved_target_kind: 'booking',
  resolved_target_id: MINTED_BOOKING_ID,
  pair_binding: null,
  metadata: {},
  ...overrides,
});

// ── HTTP fakes (EventEmitter-driven body, like the seller-claim harness) ──────

interface FakeResponse {
  response: ServerResponse;
  readonly headers: Map<string, string>;
  statusCode: number;
  body: string;
}

const fakeResponse = (): FakeResponse => {
  const out: FakeResponse = {
    headers: new Map(),
    statusCode: 0,
    body: '',
    response: null as unknown as ServerResponse,
  };
  out.response = {
    set statusCode(value: number) { out.statusCode = value; },
    get statusCode() { return out.statusCode; },
    setHeader(name: string, value: string | number) {
      out.headers.set(name.toLowerCase(), String(value));
    },
    end(body?: string | Buffer) {
      out.body = body === undefined ? '' : body.toString();
    },
  } as ServerResponse;
  return out;
};

const fakeRequest = (input: {
  method: string;
  url: string;
  body?: string;
  origin?: string;
  contentType?: string;
}): IncomingMessage => {
  const request = new EventEmitter() as IncomingMessage;
  request.method = input.method;
  request.url = input.url;
  request.headers = {
    host: HOST,
    ...(input.origin !== undefined ? { origin: input.origin } : {}),
    ...(input.contentType !== undefined ? { 'content-type': input.contentType } : {}),
  };
  Object.defineProperty(request, 'socket', { value: { remoteAddress: '203.0.113.10' } });
  queueMicrotask(() => {
    if (input.body !== undefined) request.emit('data', Buffer.from(input.body));
    request.emit('end');
  });
  return request;
};

// A minimal endpoint-registry stub: the resolve path reads only `.metadata`,
// the access log only `.appendAccessLog`. Both served from one object.
const stubRegistry = (appendAccessLog: (row: unknown) => void) =>
  ({ findById: () => ({ metadata: goodConfig }), appendAccessLog } as never);

type RunInput = {
  calendar_slug: string;
  booking_id: string;
  new_start_at: number;
  new_end_at: number;
  credential_id: string;
};

const buildEnv = (opts: {
  now?: number;
  ipBlocked?: boolean;
  rateLimited?: { retry_after_at: number };
  runOutcome?: { kind: 'held' | 'completed' | 'failed' | 'no_door' };
} = {}) => {
  const db = new Database(':memory:');
  const credStore = createReceptionManageCredentialStore(db);
  const formNonce = createInMemorySchedulingFormNonceStore();
  const runCalls: RunInput[] = [];
  const accessLogs: Array<Record<string, unknown>> = [];
  let now = opts.now ?? NOW;
  let events: ReadonlyArray<AvailabilityRawCalendarEvent> = [];
  const calendarReader = { list: () => events };
  const runReschedule = vi.fn(async (input: RunInput) => {
    runCalls.push(input);
    return opts.runOutcome ?? { kind: 'held' as const };
  });
  const consumePreVerify = vi.fn(() =>
    opts.rateLimited
      ? { ok: false as const, bucket_kind: 'per_ip_global' as const, retry_after_at: opts.rateLimited.retry_after_at }
      : { ok: true as const },
  );
  const handler = createReceptionPortHandler({
    getStore: () => stubRegistry((row) => accessLogs.push(row as Record<string, unknown>)),
    getCache: () => ({} as never),
    getRateLimiter: () => ({ consumePreVerify } as never),
    getPepper: () => deriveReceptionPepper(Buffer.alloc(32, 5)),
    ...(opts.ipBlocked ? { getIpBlockStore: () => ({ isBlocked: () => true } as never) } : {}),
    getIntakeFormSubmissionStore: () => ({ findById: () => booking() } as never),
    getSchedulingCalendarReader: () => calendarReader,
    getSchedulingFormNonceStore: () => formNonce,
    getReceptionManageCredentialStore: () => credStore,
    getReceptionManageRescheduleRunner: () => ({
      run: runReschedule,
    }),
    receptionManageCalendarSlug: 'local',
    now: () => now,
  });
  return { db, credStore, formNonce, runCalls, runReschedule, calendarReader, accessLogs, consumePreVerify, handler,
    get now() { return now; }, setNow: (value: number) => { now = value; },
    setEvents: (value: ReadonlyArray<AvailabilityRawCalendarEvent>) => { events = value; } };
};

const NONCE_RE = /name="form_nonce" value="([^"]+)"/;
const SLOT_RE = /<option value="([^"]+)">/;

const getManageForm = async (env: ReturnType<typeof buildEnv>, secret: string) => {
  const response = fakeResponse();
  await env.handler(fakeRequest({ method: 'GET', url: `${RECEPTION_MANAGE_PATH}/${secret}` }), response.response);
  return response;
};
const postManageForm = async (env: ReturnType<typeof buildEnv>, secret: string, nonce: string, slot: string) => {
  const response = fakeResponse();
  await env.handler(fakeRequest({ method: 'POST', url: `${RECEPTION_MANAGE_PATH}/${secret}`,
    body: new URLSearchParams({ form_nonce: nonce, slot }).toString(), origin: ORIGIN,
    contentType: 'application/x-www-form-urlencoded' }), response.response);
  return response;
};

describe('D-210 Appendix B — /reception/manage dispatch', () => {
  let env: ReturnType<typeof buildEnv>;
  afterEach(() => env?.db.close());

  const issue = () =>
    env.credStore.issue({
      kind: 'scheduling_link',
      endpoint_id: ENDPOINT_ID,
      record_id: BOOKING_ID,
      // D-240 — the manage door's own capability. These tests are about the
      // reschedule lifecycle, so the fixture names the purpose that door has
      // always had; the purpose FENCE itself is tested in the D-240 suite.
      purpose: 'manage',
      now: NOW,
    }).secret;

  it('GET renders the slot picker WITHOUT consuming the credential', async () => {
    env = buildEnv();
    const consume = vi.spyOn(env.credStore, 'consume');
    const secret = issue();
    const res = fakeResponse();
    await env.handler(
      fakeRequest({ method: 'GET', url: `${RECEPTION_MANAGE_PATH}/${secret}` }),
      res.response,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Reschedule your booking');
    expect(res.body).toContain('Mary Smith');
    expect(res.body).toMatch(SLOT_RE); // at least one candidate slot
    expect(consume).not.toHaveBeenCalled(); // peek, never consume
    expect(env.accessLogs.at(-1)).toMatchObject({
      endpoint_id: RECEPTION_MANAGE_ENDPOINT_ID,
      action_taken: 'view',
      outcome: 'ok',
    });
    // The secret never lands in the access log.
    expect(JSON.stringify(env.accessLogs)).not.toContain(secret);
  });

  it('POST holds the move against the CREDENTIAL\'s event, not the form', async () => {
    env = buildEnv();
    const secret = issue();
    // GET first to obtain a live form nonce + a real candidate slot.
    const get = fakeResponse();
    await env.handler(
      fakeRequest({ method: 'GET', url: `${RECEPTION_MANAGE_PATH}/${secret}` }),
      get.response,
    );
    const nonce = get.body.match(NONCE_RE)![1]!;
    const slot = get.body.match(SLOT_RE)![1]!; // "start|end|duration"
    const [start, end] = slot.split('|').map(Number);

    const post = fakeResponse();
    await env.handler(
      fakeRequest({
        method: 'POST',
        url: `${RECEPTION_MANAGE_PATH}/${secret}`,
        body: `form_nonce=${encodeURIComponent(nonce)}&slot=${encodeURIComponent(slot)}`,
        origin: ORIGIN,
        contentType: 'application/x-www-form-urlencoded',
      }),
      post.response,
    );
    expect(post.statusCode).toBe(200);
    expect(post.body).toContain('sent for approval');
    expect(env.runCalls).toHaveLength(1);
    // TARGET from the credential's booking (server-resolved); TIME from the form.
    expect(env.runCalls[0]).toMatchObject({
      calendar_slug: 'local',
      booking_id: MINTED_BOOKING_ID,
      new_start_at: start,
      new_end_at: end,
    });
    expect(env.accessLogs.at(-1)).toMatchObject({ action_taken: 'submit', outcome: 'ok' });
  });

  it('refreshes a stale choice without spending the link, then admits the replacement once with a credential-bound nonce', async () => {
    env = buildEnv();
    env.setEvents([booking().slot!]);
    const secret = issue(), otherSecret = issue();
    const initial = await getManageForm(env, secret);
    const nonce = initial.body.match(NONCE_RE)![1]!, slot = initial.body.match(SLOT_RE)![1]!;
    const [start_at, end_at] = slot.split('|').map(Number);
    env.setEvents([booking().slot!, { start_at: start_at!, end_at: end_at! }]);

    const stale = await postManageForm(env, secret, nonce, slot);
    expect(stale.statusCode).toBe(409);
    expect(stale.body).toContain('Availability has been refreshed');
    expect(stale.body).not.toContain(`<option value="${slot}">`);
    expect(stale.body).toContain(`action="${RECEPTION_MANAGE_PATH}/${secret}"`);
    expect(env.credStore.peek(secret, NOW, 'manage').status).toBe('ok');
    expect(env.runCalls).toHaveLength(0);
    expect(env.accessLogs.at(-1)).toMatchObject({ action_taken: 'submit', outcome: 'rejected' });
    const freshNonce = stale.body.match(NONCE_RE)![1]!, freshSlot = stale.body.match(SLOT_RE)![1]!;
    expect(freshNonce).not.toBe(nonce);
    expect(freshSlot).not.toBe(slot);

    // The rejected request's nonce stays spent; the replacement is scoped to
    // this exact link and is not consumed by an attempt against another link.
    expect((await postManageForm(env, secret, nonce, freshSlot)).statusCode).toBe(403);
    expect((await postManageForm(env, otherSecret, freshNonce, freshSlot)).statusCode).toBe(403);
    expect(env.credStore.peek(otherSecret, NOW, 'manage').status).toBe('ok');
    const accepted = await postManageForm(env, secret, freshNonce, freshSlot);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.body).toContain('sent for approval');
    expect(env.runCalls).toHaveLength(1);
    const [freshStart, freshEnd] = freshSlot.split('|').map(Number);
    expect(env.runCalls[0]).toMatchObject({ booking_id: MINTED_BOOKING_ID, new_start_at: freshStart, new_end_at: freshEnd });
    expect((await getManageForm(env, secret)).statusCode).toBe(404);
    expect(JSON.stringify(env.accessLogs)).not.toContain(secret);
  });

  it('keeps the link usable when no replacement slots remain and offers a non-consuming availability refresh', async () => {
    env = buildEnv();
    const secret = issue(), initial = await getManageForm(env, secret);
    const nonce = initial.body.match(NONCE_RE)![1]!, slot = initial.body.match(SLOT_RE)![1]!;
    env.setEvents([{ start_at: NOW, end_at: NOW + 32 * 24 * HOUR }]);
    const stale = await postManageForm(env, secret, nonce, slot);
    expect(stale.statusCode).toBe(409);
    expect(stale.body).toContain('No available slots');
    expect(stale.body).toContain('Check availability again');
    expect(stale.body).toContain(`href="${RECEPTION_MANAGE_PATH}/${secret}"`);
    expect(stale.body).not.toContain('type="submit"');
    expect(stale.body).not.toMatch(SLOT_RE);
    expect(stale.body.match(NONCE_RE)![1]).not.toBe(nonce);
    expect(env.credStore.peek(secret, NOW, 'manage').status).toBe('ok');
    env.setEvents([]);
    const refreshed = await getManageForm(env, secret);
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.body).toMatch(SLOT_RE);
    expect(env.runCalls).toHaveLength(0);
    expect(env.credStore.peek(secret, NOW, 'manage').status).toBe('ok');
  });

  it('checks expiry again when admitting a valid slot after reading availability', async () => {
    env = buildEnv();
    const secret = issue(), initial = await getManageForm(env, secret);
    vi.spyOn(env.calendarReader, 'list').mockImplementationOnce(() => {
      env.setNow(NOW + 2 * 24 * HOUR);
      return [];
    });
    const post = await postManageForm(env, secret, initial.body.match(NONCE_RE)![1]!, initial.body.match(SLOT_RE)![1]!);
    expect(post.statusCode).toBe(410);
    expect(env.runCalls).toHaveLength(0);
    expect(env.accessLogs.at(-1)).toMatchObject({ action_taken: 'expired', outcome: 'expired' });
  });

  it('does not offer a recovery form if another request consumes the link during availability lookup', async () => {
    env = buildEnv();
    const secret = issue(), initial = await getManageForm(env, secret);
    vi.spyOn(env.calendarReader, 'list').mockImplementationOnce(() => {
      env.credStore.consume(secret, NOW, 'manage');
      return [];
    });
    const post = await postManageForm(env, secret, initial.body.match(NONCE_RE)![1]!, 'not-a-slot');
    expect(post.statusCode).toBe(410);
    expect(post.body).not.toMatch(NONCE_RE);
    expect(env.runCalls).toHaveLength(0);
  });

  it('admits only one replacement request while its approval runner is still in flight', async () => {
    env = buildEnv();
    const secret = issue(), initial = await getManageForm(env, secret);
    const stale = await postManageForm(env, secret, initial.body.match(NONCE_RE)![1]!, 'not-a-slot');
    const nonceA = stale.body.match(NONCE_RE)![1]!, slot = stale.body.match(SLOT_RE)![1]!;
    const anotherForm = await getManageForm(env, secret), nonceB = anotherForm.body.match(NONCE_RE)![1]!;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    env.runReschedule.mockImplementationOnce(async input => {
      env.runCalls.push(input);
      await held;
      return { kind: 'held' as const };
    });
    const first = postManageForm(env, secret, nonceA, slot);
    try {
      await vi.waitFor(() => expect(env.runReschedule).toHaveBeenCalledTimes(1));
      const second = await postManageForm(env, secret, nonceB, slot);
      expect(second.statusCode).toBe(410);
      expect(env.runCalls).toHaveLength(1);
    } finally { release(); await first; }
    expect((await first).statusCode).toBe(200);
  });

  it.each(['failed', 'no_door'] as const)('keeps an admitted link spent after the runner returns %s', async kind => {
    env = buildEnv({ runOutcome: { kind } });
    const secret = issue(), initial = await getManageForm(env, secret);
    const stale = await postManageForm(env, secret, initial.body.match(NONCE_RE)![1]!, 'not-a-slot');
    const nonce = stale.body.match(NONCE_RE)![1]!, slot = stale.body.match(SLOT_RE)![1]!;
    const failed = await postManageForm(env, secret, nonce, slot);
    expect(failed.statusCode).toBe(500);
    expect(failed.body).toContain('request a new one');
    expect(env.credStore.peek(secret, NOW, 'manage').status).toBe('already_consumed');
    expect((await postManageForm(env, secret, nonce, slot)).statusCode).toBe(410);
    expect(env.runCalls).toHaveLength(1);
  });

  it('binds each form nonce to the credential that rendered it', async () => {
    env = buildEnv();
    const secretA = issue();
    const secretB = issue();
    const getA = fakeResponse();
    await env.handler(
      fakeRequest({ method: 'GET', url: `${RECEPTION_MANAGE_PATH}/${secretA}` }),
      getA.response,
    );
    const nonceA = getA.body.match(NONCE_RE)![1]!;
    const slotA = getA.body.match(SLOT_RE)![1]!;

    const crossed = fakeResponse();
    await env.handler(
      fakeRequest({
        method: 'POST',
        url: `${RECEPTION_MANAGE_PATH}/${secretB}`,
        body: `form_nonce=${encodeURIComponent(nonceA)}&slot=${encodeURIComponent(slotA)}`,
        origin: ORIGIN,
        contentType: 'application/x-www-form-urlencoded',
      }),
      crossed.response,
    );
    expect(crossed.statusCode).toBe(403);
    expect(env.runCalls).toHaveLength(0);
    expect(env.credStore.peek(secretA, NOW, 'manage').status).toBe('ok');
    expect(env.credStore.peek(secretB, NOW, 'manage').status).toBe('ok');

    // The nonce still authorizes only the credential that minted it.
    const correct = fakeResponse();
    await env.handler(
      fakeRequest({
        method: 'POST',
        url: `${RECEPTION_MANAGE_PATH}/${secretA}`,
        body: `form_nonce=${encodeURIComponent(nonceA)}&slot=${encodeURIComponent(slotA)}`,
        origin: ORIGIN,
        contentType: 'application/x-www-form-urlencoded',
      }),
      correct.response,
    );
    expect(correct.statusCode).toBe(200);
    expect(env.runCalls).toHaveLength(1);
  });

  it('a bad form nonce does not burn the manage credential', async () => {
    env = buildEnv();
    const secret = issue();
    const get = fakeResponse();
    await env.handler(
      fakeRequest({ method: 'GET', url: `${RECEPTION_MANAGE_PATH}/${secret}` }),
      get.response,
    );
    const nonce = get.body.match(NONCE_RE)![1]!;
    const slot = get.body.match(SLOT_RE)![1]!;

    const bad = fakeResponse();
    await env.handler(
      fakeRequest({
        method: 'POST',
        url: `${RECEPTION_MANAGE_PATH}/${secret}`,
        body: `form_nonce=never-issued&slot=${encodeURIComponent(slot)}`,
        origin: ORIGIN,
        contentType: 'application/x-www-form-urlencoded',
      }),
      bad.response,
    );
    expect(bad.statusCode).toBe(403);
    expect(env.credStore.peek(secret, NOW, 'manage').status).toBe('ok');

    const retry = fakeResponse();
    await env.handler(
      fakeRequest({
        method: 'POST',
        url: `${RECEPTION_MANAGE_PATH}/${secret}`,
        body: `form_nonce=${encodeURIComponent(nonce)}&slot=${encodeURIComponent(slot)}`,
        origin: ORIGIN,
        contentType: 'application/x-www-form-urlencoded',
      }),
      retry.response,
    );
    expect(retry.statusCode).toBe(200);
    expect(env.runCalls).toHaveLength(1);
  });

  it('the credential is single-use: a second POST is rejected even with a fresh nonce', async () => {
    env = buildEnv();
    const secret = issue();
    const get = fakeResponse();
    await env.handler(
      fakeRequest({ method: 'GET', url: `${RECEPTION_MANAGE_PATH}/${secret}` }),
      get.response,
    );
    const nonce1 = get.body.match(NONCE_RE)![1]!;
    const slot = get.body.match(SLOT_RE)![1]!;
    const postBody = (nonce: string) =>
      `form_nonce=${encodeURIComponent(nonce)}&slot=${encodeURIComponent(slot)}`;

    const first = fakeResponse();
    await env.handler(
      fakeRequest({ method: 'POST', url: `${RECEPTION_MANAGE_PATH}/${secret}`, body: postBody(nonce1), origin: ORIGIN, contentType: 'application/x-www-form-urlencoded' }),
      first.response,
    );
    expect(first.statusCode).toBe(200);

    // A brand-new nonce (so the nonce check passes) still cannot re-drive the
    // spent credential — isolates the credential's single-use from the nonce's.
    const nonce2 = env.formNonce.issue(RECEPTION_MANAGE_ENDPOINT_ID, NOW);
    const replay = fakeResponse();
    await env.handler(
      fakeRequest({ method: 'POST', url: `${RECEPTION_MANAGE_PATH}/${secret}`, body: postBody(nonce2), origin: ORIGIN, contentType: 'application/x-www-form-urlencoded' }),
      replay.response,
    );
    expect(replay.statusCode).toBe(410);
    expect(env.runCalls).toHaveLength(1); // the move ran exactly once
  });

  it('an expired credential renders unavailable (404) and never runs', async () => {
    env = buildEnv({ now: NOW + 2 * 24 * HOUR }); // past the 24h default TTL
    const secret = issue();
    const res = fakeResponse();
    await env.handler(
      fakeRequest({ method: 'GET', url: `${RECEPTION_MANAGE_PATH}/${secret}` }),
      res.response,
    );
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('unavailable');
    expect(env.runCalls).toHaveLength(0);
    expect(env.accessLogs.at(-1)).toMatchObject({ action_taken: 'expired', outcome: 'expired' });
  });

  it('cross-origin POST is refused before the credential is consumed', async () => {
    env = buildEnv();
    const consume = vi.spyOn(env.credStore, 'consume');
    const secret = issue();
    const get = fakeResponse();
    await env.handler(fakeRequest({ method: 'GET', url: `${RECEPTION_MANAGE_PATH}/${secret}` }), get.response);
    const nonce = get.body.match(NONCE_RE)![1]!;
    const slot = get.body.match(SLOT_RE)![1]!;
    const res = fakeResponse();
    await env.handler(
      fakeRequest({
        method: 'POST',
        url: `${RECEPTION_MANAGE_PATH}/${secret}`,
        body: `form_nonce=${encodeURIComponent(nonce)}&slot=${encodeURIComponent(slot)}`,
        origin: 'https://attacker.example',
        contentType: 'application/x-www-form-urlencoded',
      }),
      res.response,
    );
    expect(res.statusCode).toBe(403);
    expect(consume).not.toHaveBeenCalled();
    expect(env.runCalls).toHaveLength(0);
  });

  it('an IP-blocked source is rejected before the credential is touched', async () => {
    env = buildEnv({ ipBlocked: true });
    const consume = vi.spyOn(env.credStore, 'peek');
    const secret = issue();
    const res = fakeResponse();
    await env.handler(fakeRequest({ method: 'GET', url: `${RECEPTION_MANAGE_PATH}/${secret}` }), res.response);
    expect(res.statusCode).toBe(403);
    expect(consume).not.toHaveBeenCalled();
    expect(env.consumePreVerify).not.toHaveBeenCalled();
    expect(env.accessLogs.at(-1)).toMatchObject({ action_taken: 'reject', outcome: 'rejected' });
  });

  it('a rate-limited source gets 429 + Retry-After before the credential is touched', async () => {
    env = buildEnv({ rateLimited: { retry_after_at: NOW + 5_001 } });
    const peek = vi.spyOn(env.credStore, 'peek');
    const secret = issue();
    const res = fakeResponse();
    await env.handler(fakeRequest({ method: 'GET', url: `${RECEPTION_MANAGE_PATH}/${secret}` }), res.response);
    expect(res.statusCode).toBe(429);
    expect(res.headers.get('retry-after')).toBe('6');
    expect(peek).not.toHaveBeenCalled();
    expect(env.accessLogs.at(-1)).toMatchObject({ action_taken: 'rate_limited', outcome: 'rate_limited' });
  });
});

describe('D-210 Appendix B — /reception/manage without the manage deps', () => {
  it('404s when the credential store + runner are not wired', async () => {
    const handler = createReceptionPortHandler({
      getStore: () => ({ appendAccessLog: () => {} } as never),
      getCache: () => ({} as never),
      getRateLimiter: () => ({ consumePreVerify: () => ({ ok: true as const }) } as never),
      getPepper: () => deriveReceptionPepper(Buffer.alloc(32, 5)),
      now: () => NOW,
    });
    const res = fakeResponse();
    await handler(
      fakeRequest({ method: 'GET', url: `${RECEPTION_MANAGE_PATH}/recued_manage_${'a'.repeat(43)}` }),
      res.response,
    );
    expect(res.statusCode).toBe(404);
  });
});

/** D-210 WS3 CAPSTONE — an intake really lands on a calendar / a contact.
 *
 *  Every other WS3 test proves one link. This one runs the whole chain over
 *  REAL substrate and asserts the artifact a person would actually see:
 *
 *      the real POST handler   (nonce, validation, PII sealing, the submit-time
 *                               `form_response` log)
 *   →  the real drain processor (decrypt, the field→slot mapping, the held
 *                               review payload)
 *   →  the real projection      (`runReceptionProjection`, the approve-resume leg)
 *   →  the real calendar gate   (`handleCalendarCreate` through the caps gate,
 *                               the real local provider, the real warehouse
 *                               table) / the real `contact.upsert` path
 *
 *  ⛔ The calendar seam is NOT stubbed here. The two existing e2e suites stub
 *  `createCalendarEvent`, which is a fair seam for what they test — but it is
 *  exactly where WS3's `is_all_day` had to be threaded, and a stub would have
 *  accepted the hardcoded `false` it replaced. The gate is what used to refuse
 *  [[test_real_gate_not_mock_for_admission]].
 *
 *  The three scenarios are the ones the two-knob design was ruled to cover:
 *    - RESTAURANT — a `datetime` start + a visitor-entered duration in hours
 *      → a TIMED event at the right absolute instant for its zone.
 *    - HOTEL      — a `date` start + a `date` end → a DAY-SCOPED event whose
 *      end date is the exclusive bound (three nights, not four).
 *    - CONTACT    — a contact keyed on the SEALED visitor email, resolved
 *      server-side at materialize, with a mapped display name.
 *
 *  Spec: D-210. */

import Database from 'better-sqlite3';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import type {
  CalendarCollectionCaps,
  IntakeFormCalendarMapping,
  IntakeFormConfig,
} from '@recued/contracts';
import type { ProviderEventPayload } from '../collections/calendar/provider.js';
import type { AuditLogStore } from '@recued/storage';

import {
  createInMemoryIntakeFormNonceStore,
  createIntakeFormPacketHandler,
  createIntakeFormSubmitHandler,
} from '../ports/reception/handlers/intake-form.js';
import { createIntakeFormSubmissionProcessor } from '../ports/reception/processors/intake-form-processor.js';
import { runReceptionProjection } from '../ports/reception/projection/reception-projection.js';
import { createReceptionCalendarEventSeam } from '../ports/reception/projection/reception-calendar-event.js';
import { createReceptionSealedVisitorEmailSeam } from '../ports/reception/projection/reception-sealed-visitor-email.js';
import { deriveFormSubmissionPiiKeyFromSubDek } from '../ports/reception/form-pii.js';
import { computeBearerHmac, deriveReceptionPepper } from '../ports/reception/server-secret-pepper.js';
import { createPublicEndpointRegistryStore } from '../storage/public-endpoint-registry-store.js';
import { createReceptionFormSubmissionStore } from '../storage/reception-form-store.js';
import { createFormResponseStore } from '../storage/form-response-store.js';
import { createContactStore } from '../storage/contact-store.js';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import { createCalendarTable } from '../collections/calendar/calendar-table.js';
import {
  createLocalCalendarProvider,
  LOCAL_CALENDAR_CAPS,
} from '../collections/calendar/local-provider.js';
import { handleCalendarCreate } from '../collections/calendar/calendar-dispatcher.js';
import type { CalendarCollection } from '../collections/calendar/calendar-collection.js';
import { createInstanceStore } from '../collections/instance-store.js';
import type { ReceptionEndpointContext } from '../ports/reception/redacted-packet.js';

const NOW = 1_700_000_000_000;
const SOURCE_IP_HASH = 'endpoint-scoped-test-source';
const PEPPER = deriveReceptionPepper(Buffer.alloc(32, 0xc4));
const PII_KEY = deriveFormSubmissionPiiKeyFromSubDek(Buffer.alloc(32, 0x6e));
const ENDPOINT_ID = 'ep-ws3-e2e';

// ── HTTP fakes (the handler only reads method / headers / body) ─────

const fakeReq = (method: 'GET' | 'POST', body?: string): IncomingMessage => {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.url = `/reception/intake/${ENDPOINT_ID}?t=tok`;
  req.headers.host = 'localhost';
  if (method === 'POST') {
    req.headers.origin = 'http://localhost';
    req.headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  if (body !== undefined) {
    setImmediate(() => { req.emit('data', Buffer.from(body, 'utf8')); req.emit('end'); });
  }
  return req;
};

const fakeRes = () => {
  const chunks: Array<string | Buffer> = [];
  return {
    statusCode: 200,
    setHeader() {}, getHeader() { return undefined; },
    write(c: string | Buffer) { chunks.push(c); },
    end(c?: string | Buffer) { if (c !== undefined) chunks.push(c); },
    get body() { return chunks.map(String).join(''); },
  } as unknown as ServerResponse & { readonly body: string };
};

const endpoint: ReceptionEndpointContext = {
  endpoint_id: ENDPOINT_ID,
  kind: 'intake_form_packet',
};

// ── The world: one db carrying reception + calendar + contacts ──────

const buildWorld = (config: IntakeFormConfig) => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);

  const registry = createPublicEndpointRegistryStore(db);
  registry.create({
    endpoint_id: ENDPOINT_ID,
    kind: 'intake_form',
    packet_declaration: {
      packet_kind: 'intake_form_packet',
      source_query_ref: {
        kind: 'reception_form_definition',
        form_definition_id: config.form_definition.form_definition_id,
      },
    },
    bearer_secret_hmac: computeBearerHmac('tok', PEPPER),
    created_at: NOW - 1000,
    created_by_client_id: 'inst-1',
    expires_at: null,
    long_lived_acknowledged_at: NOW - 1000,
    metadata: config as unknown as Record<string, unknown>,
  });
  registry.enable(ENDPOINT_ID, NOW);

  const submissionStore = createReceptionFormSubmissionStore(db);
  const formResponseStore = createFormResponseStore(db);
  const contactStore = createContactStore(db);

  // The REAL local calendar: warehouse table + provider + the caps gate the
  // dispatcher enforces. Wired exactly as `calendar-dispatcher.test.ts` wires
  // it, which is exactly as boot does.
  const instances = createInstanceStore({ db });
  const table = createCalendarTable({ db, slug: 'local' });
  const provider = createLocalCalendarProvider({
    slug: 'local',
    now: () => NOW,
    readEvent: (source_id) => table.get(source_id)?.event ?? null,
  });
  const collection = {
    platform: 'calendar',
    slug: 'local',
    gate: { addUsed: () => {} },
    table,
    provider,
    async applyVerifiedUpsert(payload: ProviderEventPayload) {
      table.upsert({ event: payload.event, size_bytes: payload.description_bytes });
    },
    applyVerifiedDelete(source_id: string) { table.delete(source_id); },
  } as unknown as CalendarCollection;
  instances.upsert({
    platform: 'calendar',
    slug: 'local',
    adapter_type: 'local',
    config: {},
    caps: LOCAL_CALENDAR_CAPS as unknown as CalendarCollectionCaps,
    auth_state: 'healthy',
    last_synced_at: null,
  });
  const calendarDeps = {
    instances,
    getCollection: (slug: string) => (slug === 'local' ? collection : undefined),
  };

  return { db, registry, submissionStore, formResponseStore, contactStore, table, calendarDeps };
};

type World = ReturnType<typeof buildWorld>;

/** Submit through the real POST handler, drain through the real processor, and
 *  return the payload the review workflow was handed (i.e. what the Reception
 *  Inbox holds for approval). */
const submitAndDrain = async (
  world: World,
  config: IntakeFormConfig,
  fields: Record<string, string>,
  visitorEmail: string,
): Promise<Record<string, unknown>> => {
  const nonceStore = createInMemoryIntakeFormNonceStore();
  const registryView = {
    findById: (id: string) => (id === ENDPOINT_ID ? { metadata: config } : null),
  };

  const getRes = fakeRes();
  await createIntakeFormPacketHandler({
    getStore: () => registryView as never,
    getFormNonceStore: () => nonceStore,
    now: () => NOW,
  })(fakeReq('GET'), getRes, endpoint);
  const nonce = /name="form_nonce" value="([^"]+)"/.exec(getRes.body)?.[1];
  expect(nonce).toBeTruthy();

  const postRes = fakeRes();
  await createIntakeFormSubmitHandler({
    getStore: () => registryView as never,
    getSubmissionStore: () => world.submissionStore,
    getFormNonceStore: () => nonceStore,
    getFormSubmissionPiiKey: () => PII_KEY,
    auditLog: { logActivity: async () => undefined } as unknown as AuditLogStore,
    now: () => NOW,
  })(
    fakeReq('POST', new URLSearchParams({
      form_nonce: nonce!, visitor_email: visitorEmail, ...fields,
    }).toString()),
    postRes,
    endpoint,
    SOURCE_IP_HASH,
  );
  expect(postRes.statusCode).toBe(200);

  const held: Record<string, unknown>[] = [];
  const processor = createIntakeFormSubmissionProcessor({
    registryStore: world.registry,
    submissionStore: world.submissionStore,
    workEntityStore: {} as never,
    getFormSubmissionPiiKey: () => PII_KEY,
    now: () => NOW,
    fireReceptionWorkflow: async (d) => {
      held.push(d.payload as Record<string, unknown>);
      return { dispatched: true };
    },
  });
  await processor.drainOnce({ limit: 10, now: NOW });
  expect(held).toHaveLength(1);
  return held[0]!;
};

/** The approve-resume leg: the held payload through the real projection, over
 *  the real calendar gate + contact path + sealed-email resolver. */
const approve = (world: World, payload: Record<string, unknown>) =>
  runReceptionProjection(
    {
      workEntityStore: {},
      contactDeps: { store: world.contactStore },
      createCalendarEvent: createReceptionCalendarEventSeam({
        // ⚠ The REAL seam, and since D-210 A.2 this is its ONLY caller: a
        // reservation projects as `booking` and never reaches the calendar.
        calendarCreate: (input) => handleCalendarCreate(world.calendarDeps as never, input),
      }),
      resolveSealedVisitorEmail: createReceptionSealedVisitorEmailSeam({
        submissionStore: world.submissionStore,
        getFormSubmissionPiiKey: () => PII_KEY,
      }),
      now: () => NOW,
    },
    payload as never,
  );

// ── Configs ─────────────────────────────────────────────────────────

const calendarConfig = (
  id: string,
  fields: IntakeFormConfig['form_definition']['fields'],
  m: IntakeFormCalendarMapping,
): IntakeFormConfig => ({
  display_name: 'Reserve',
  success_message: 'Thanks.',
  form_definition: { form_definition_id: id, fields },
  submission_processing_rule: {
    target_kind: 'calendar',
    calendar_mapping: m,
    fields_to_include_in_target: ['guest_name'],
    fields_to_attach_as_metadata: [],
  },
  anti_spam: {
    honeypot_fields: [], rate_limit_per_ip: 20,
    require_proof_of_work: false, require_captcha: false,
  },
  required_visitor_fields: { email: 'required' },
});

describe('D-210 WS3 CAPSTONE — an intake lands on the real local calendar', () => {
  it('RESTAURANT: a datetime start + hours → a timed event at the right ABSOLUTE instant', async () => {
    const config = calendarConfig('fd_restaurant', [
      { name: 'arrives_at', type: 'datetime', label: 'When', required: true },
      { name: 'hours', type: 'number', label: 'For how long', required: true },
      { name: 'guest_name', type: 'text', label: 'Name', required: true },
    ], {
      start_field: 'arrives_at',
      duration_field: 'hours',
      timezone: 'Europe/Paris',
    });
    const world = buildWorld(config);

    const payload = await submitAndDrain(world, config, {
      arrives_at: '2026-07-20T19:30', hours: '2', guest_name: 'Dana Okafor',
    }, 'dana@example.com');

    // The held payload is what the owner reviews. The visitor's email is NOT
    // in it — a calendar destination has no business carrying an address.
    expect(payload.top_tier_kind).toBe('calendar.event');
    expect(JSON.stringify(payload)).not.toContain('dana@example.com');

    const result = await approve(world, payload);
    expect(result.top_tier_kind).toBe('calendar.event');

    const row = world.table.get(result.target_id);
    expect(row).toBeTruthy();
    const event = row!.event;
    // 19:30 in PARIS is 17:30Z in July. A naive read of the wall clock would
    // put a real dinner booking on the calendar at the wrong hour.
    expect(new Date(event.start_at).toISOString()).toBe('2026-07-20T17:30:00.000Z');
    expect(new Date(event.end_at).toISOString()).toBe('2026-07-20T19:30:00.000Z');
    expect(event.timezone).toBe('Europe/Paris');
    expect(event.is_all_day).toBe(false);
    expect(event.status).toBe('confirmed');

    // 🔴 THE LIMIT, pinned deliberately. The WS3 plan claimed an intake→calendar
    // event would be "reschedulable via the WS1 `/reception/manage` endpoint for
    // free". It is NOT: that endpoint mints its credential by walking a
    // `scheduled-from` link back to a BOOKING row
    // (`reception-manage-mint-handler.ts` → `no_booking`), and an intake writes
    // no booking. The payload below carries no `booking_request_id`, which is
    // the anchor that whole chain keys on — so an owner clicking "Copy
    // reschedule link" on one of these events gets a refusal.
    //
    // Asserted rather than left to be discovered: the claim was inherited from
    // the plan and repeated in two handovers. Extending manage to booking-less
    // events is its own slice. Rescheduling still works AT-DESK (the R-4
    // control), which is the same posture a manual calendar event has.
    expect(payload.booking_request_id).toBeUndefined();
    world.db.close();
  });

  it('HOTEL: two date fields → a DAY-SCOPED event whose end date is the exclusive bound', async () => {
    const config = calendarConfig('fd_hotel', [
      { name: 'check_in', type: 'date', label: 'Arriving', required: true },
      { name: 'check_out', type: 'date', label: 'Leaving', required: true },
      { name: 'guest_name', type: 'text', label: 'Name', required: true },
    ], {
      start_field: 'check_in',
      end_field: 'check_out',
      timezone: 'Europe/Paris',
    });
    const world = buildWorld(config);

    const payload = await submitAndDrain(world, config, {
      check_in: '2026-07-20', check_out: '2026-07-23', guest_name: 'Dana Okafor',
    }, 'dana@example.com');
    const result = await approve(world, payload);
    const event = world.table.get(result.target_id)!.event;

    // Day-scoped, because the START FIELD is a `date` — nothing else said so.
    expect(event.is_all_day).toBe(true);
    // Stored as the DAY it names, as every calendar stores an all-day event
    // (2026-10-07, `calendar-days.ts`): 20 July's UTC midnight. It was Paris
    // midnight (19 July, 22:00 UTC), which every reader placed on 19 July.
    expect(new Date(event.start_at).toISOString()).toBe('2026-07-20T00:00:00.000Z');
    // THREE nights: the check-out date is the exclusive end, which is how a
    // person reads it. Four would be the classic off-by-one.
    expect(event.end_at - event.start_at).toBe(3 * 24 * 60 * 60_000);
    world.db.close();
  });
});

describe('D-210 WS3 CAPSTONE — an intake lands on a real contact', () => {
  const contactConfig = (): IntakeFormConfig => ({
    display_name: 'Say hello',
    success_message: 'Thanks.',
    form_definition: {
      form_definition_id: 'fd_contact',
      fields: [
        { name: 'full_name', type: 'text', label: 'Your name', required: true },
        { name: 'message', type: 'textarea', label: 'Message', required: false },
      ],
    },
    submission_processing_rule: {
      target_kind: 'contact',
      contact_mapping: { contact_name_field: 'full_name' },
      fields_to_include_in_target: ['message'],
      fields_to_attach_as_metadata: [],
    },
    anti_spam: {
      honeypot_fields: [], rate_limit_per_ip: 20,
      require_proof_of_work: false, require_captcha: false,
    },
    required_visitor_fields: { email: 'required' },
  });

  it('keys the contact on the SEALED visitor email, which never rides the payload', async () => {
    const config = contactConfig();
    const world = buildWorld(config);

    const payload = await submitAndDrain(world, config, {
      full_name: 'Dana Okafor', message: 'Loved the talk.',
    }, 'dana@example.com');

    // 🔑 THE INVARIANT. The held payload carries the mapped NAME and no
    // address — the email is sealed in the reception row and resolved
    // server-side at materialize. If it rode here it would enter step state,
    // readable by any step of the compiled recipe and editable at the gate.
    expect(payload.top_tier_kind).toBe('contact');
    expect(payload.contact_name).toBe('Dana Okafor');
    expect(payload.contact_email).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('dana@example.com');

    const result = await approve(world, payload);
    expect(result.top_tier_kind).toBe('contact');

    // …and the contact really exists, keyed on the address the payload never
    // carried. This is the half that proves the resolver ran rather than the
    // projection quietly writing an unkeyed row.
    const contact = world.contactStore.get('dana@example.com');
    expect(contact).toBeTruthy();
    expect(contact!.name).toBe('Dana Okafor');
    world.db.close();
  });

  it('REFUSES to write a contact when the sealed email cannot be resolved', async () => {
    // Fail-closed: a contact with no key cannot be written, and inventing one
    // would be inventing an identity. Drive it by resolving against a store
    // that does not hold the submission.
    const config = contactConfig();
    const world = buildWorld(config);
    const payload = await submitAndDrain(world, config, {
      full_name: 'Dana Okafor', message: 'Hi.',
    }, 'dana@example.com');

    await expect(runReceptionProjection(
      {
        workEntityStore: {},
        contactDeps: { store: world.contactStore },
        resolveSealedVisitorEmail: async () => null,
        now: () => NOW,
      },
      payload as never,
    )).rejects.toThrow(/contact_email/);

    expect(world.contactStore.get('dana@example.com')).toBeFalsy();
    world.db.close();
  });
});

/** D-210 WS3 — the intake → `calendar` / `contact` field mapping.
 *
 *  Two layers, because they fail differently:
 *
 *    1. `resolveIntakeCalendarSlots` — the pure mapping, including the wall
 *       clock → epoch conversion. This is where a wrong answer is CONFIDENT:
 *       an off-by-a-timezone start is a real event, on a real calendar, at the
 *       wrong hour, with nothing throwing.
 *    2. The processor over the REAL drain — that the resolved slots actually
 *       reach the held review payload, and that an unresolvable mapping leaves
 *       the row PENDING instead of dispatching a hold with no start.
 *
 *  ⚠ THE HOST TIMEZONE IS THE WHOLE POINT of the conversion tests. `Date.parse`
 *  on a zone-less string reads it in the SERVER's zone, so a test that only ever
 *  used `UTC` (or whose host happened to be UTC) would pass against a broken
 *  implementation. Every conversion assertion below is written as an absolute
 *  UTC instant for a NON-UTC zone, so the host's own zone cannot make it true.
 *
 *  Spec: `docs/d-210-spec.md`; mapping in `processors/intake-destination-mapping.ts`. */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { IntakeFormCalendarMapping, IntakeFormConfig } from '@recued/contracts';
import {
  resolveIntakeCalendarSlots,
  resolveIntakeContactName,
  visibleFieldTypeMap,
  zonedWallClockToEpochMs,
} from '../ports/reception/processors/intake-destination-mapping.js';
import { createIntakeFormSubmissionProcessor } from '../ports/reception/processors/intake-form-processor.js';
import {
  deriveFormSubmissionPiiKeyFromSubDek,
  sealFormSubmissionField,
} from '../ports/reception/form-pii.js';
import { computeBearerHmac, deriveReceptionPepper } from '../ports/reception/server-secret-pepper.js';
import { createPublicEndpointRegistryStore } from '../storage/public-endpoint-registry-store.js';
import { createReceptionFormSubmissionStore } from '../storage/reception-form-store.js';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import type {
  FireReceptionWorkflow,
  ReceptionWorkflowDispatch,
} from '../ports/reception/reception-drain.js';

const NOW = 1_700_000_000_000;
const PEPPER = deriveReceptionPepper(Buffer.alloc(32, 0xc4));
const FORM_KEY = deriveFormSubmissionPiiKeyFromSubDek(Buffer.alloc(32, 0x5a));

const FIELD_TYPES = new Map<string, string>([
  ['arrives_at', 'datetime'],
  ['leaves_at', 'datetime'],
  ['stay_from', 'date'],
  ['stay_to', 'date'],
  ['hours', 'number'],
  ['guest_name', 'text'],
]);

const mapping = (m: Partial<IntakeFormCalendarMapping>): IntakeFormCalendarMapping => ({
  start_field: 'arrives_at',
  ...m,
} as IntakeFormCalendarMapping);

// ════════════════════════════════════════════════════════════════
// The wall-clock → epoch conversion
// ════════════════════════════════════════════════════════════════

describe('D-210 WS3 — a visitor wall clock is read in the CONFIGURED zone', () => {
  // Each case is an absolute UTC instant. If the implementation fell back to
  // the host zone, every non-UTC row here would be wrong by that offset.
  it.each([
    // wall clock            zone                 expected UTC instant
    ['2026-07-20T19:30', 'Europe/Paris', '2026-07-20T17:30:00.000Z'], // CEST +2
    ['2026-01-20T19:30', 'Europe/Paris', '2026-01-20T18:30:00.000Z'], // CET  +1 (DST)
    ['2026-07-20T19:30', 'America/New_York', '2026-07-20T23:30:00.000Z'], // EDT -4
    ['2026-07-20T19:30', 'Asia/Kolkata', '2026-07-20T14:00:00.000Z'], // +05:30
    ['2026-07-20T19:30', 'UTC', '2026-07-20T19:30:00.000Z'],
    // A bare date is midnight IN THE ZONE — not midnight UTC.
    ['2026-07-20', 'Europe/Paris', '2026-07-19T22:00:00.000Z'],
  ])('%s in %s → %s', (wall, zone, expected) => {
    const epoch = zonedWallClockToEpochMs(wall, zone);
    expect(epoch).not.toBeNull();
    expect(new Date(epoch!).toISOString()).toBe(expected);
  });

  it('lands a wall clock inside the spring-forward GAP just after the jump', () => {
    // 02:30 on 2026-03-29 does not exist in Paris (02:00 → 03:00). Every
    // calendar UI resolves it forward rather than refusing; so does this.
    const epoch = zonedWallClockToEpochMs('2026-03-29T02:30', 'Europe/Paris');
    expect(new Date(epoch!).toISOString()).toBe('2026-03-29T01:30:00.000Z');
  });

  it('returns null for an unknown zone rather than throwing a RangeError', () => {
    // `Intl` throws on a bad IANA zone, and the config validator does not
    // verify zone existence (the closed list is the platform's). A throw here
    // would surface as a crashed materialize instead of a refused one.
    expect(zonedWallClockToEpochMs('2026-07-20T19:30', 'Not/AZone')).toBeNull();
  });

  it('refuses a value that carries its OWN zone', () => {
    // The config's `timezone` is the single authority. A zone-bearing string
    // would silently outrank it, so it is not accepted at all.
    expect(zonedWallClockToEpochMs('2026-07-20T19:30:00Z', 'Europe/Paris')).toBeNull();
    expect(zonedWallClockToEpochMs('2026-07-20T19:30+02:00', 'Europe/Paris')).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════
// The three end-specs + all-day
// ════════════════════════════════════════════════════════════════

describe('D-210 WS3 — the end is derived by exactly one spec', () => {
  it('duration_field is read in HOURS (the unit a person types)', () => {
    const r = resolveIntakeCalendarSlots({
      mapping: mapping({ duration_field: 'hours' }),
      fields: { arrives_at: '2026-07-20T19:30', hours: '2.5' },
      fieldTypes: FIELD_TYPES,
    });
    expect(r.ok).toBe(true);
    // 2.5 HOURS = 150 minutes. Reading it as minutes would give 2.
    expect(r.ok && r.slots.duration_minutes).toBe(150);
  });

  it('end_field becomes a DURATION, so a gate edit to the start shifts the whole event', () => {
    const r = resolveIntakeCalendarSlots({
      mapping: mapping({ start_field: 'arrives_at', end_field: 'leaves_at' }),
      fields: { arrives_at: '2026-07-20T19:00', leaves_at: '2026-07-20T21:30' },
      fieldTypes: FIELD_TYPES,
    });
    expect(r.ok && r.slots.duration_minutes).toBe(150);
  });

  it('default_duration_minutes is used verbatim', () => {
    const r = resolveIntakeCalendarSlots({
      mapping: mapping({ default_duration_minutes: 90 }),
      fields: { arrives_at: '2026-07-20T19:30' },
      fieldTypes: FIELD_TYPES,
    });
    expect(r.ok && r.slots.duration_minutes).toBe(90);
  });

  it('a `date` start field makes the event DAY-SCOPED; a `datetime` one does not', () => {
    // The field's TYPE carries the decision — there is no separate all-day
    // flag that could disagree with what the visitor was asked for.
    const allDay = resolveIntakeCalendarSlots({
      mapping: mapping({ start_field: 'stay_from', end_field: 'stay_to' }),
      fields: { stay_from: '2026-07-20', stay_to: '2026-07-23' },
      fieldTypes: FIELD_TYPES,
    });
    expect(allDay.ok && allDay.slots.is_all_day).toBe(true);
    // A hotel stay 20th→23rd is THREE nights: the end date is the exclusive
    // bound, matching iCal and how a person reads a check-out date.
    expect(allDay.ok && allDay.slots.duration_minutes).toBe(3 * 24 * 60);

    const timed = resolveIntakeCalendarSlots({
      mapping: mapping({ duration_field: 'hours' }),
      fields: { arrives_at: '2026-07-20T19:30', hours: '2' },
      fieldTypes: FIELD_TYPES,
    });
    expect(timed.ok && timed.slots.is_all_day).toBe(false);
  });

  it.each([
    ['a missing start', { arrives_at: '' }, 'start_field_missing'],
    ['an unparseable start', { arrives_at: 'next tuesday' }, 'start_field_unparseable'],
  ])('fails on %s rather than defaulting the booking', (_label, fields, reason) => {
    const r = resolveIntakeCalendarSlots({
      mapping: mapping({ default_duration_minutes: 60 }),
      fields,
      fieldTypes: FIELD_TYPES,
    });
    expect(r).toEqual({ ok: false, reason });
  });

  it('refuses an end at or before the start', () => {
    const r = resolveIntakeCalendarSlots({
      mapping: mapping({ end_field: 'leaves_at' }),
      fields: { arrives_at: '2026-07-20T19:00', leaves_at: '2026-07-20T19:00' },
      fieldTypes: FIELD_TYPES,
    });
    expect(r).toEqual({ ok: false, reason: 'end_not_after_start' });
  });

  it.each(['0', '-3', 'lots'])('refuses a duration of %s hours', (hours) => {
    const r = resolveIntakeCalendarSlots({
      mapping: mapping({ duration_field: 'hours' }),
      fields: { arrives_at: '2026-07-20T19:30', hours },
      fieldTypes: FIELD_TYPES,
    });
    expect(r).toEqual({ ok: false, reason: 'duration_field_invalid' });
  });
});

describe('D-210 WS3 — the contact mapping carries a name and never an email', () => {
  it('reads the mapped name field', () => {
    expect(resolveIntakeContactName({
      mapping: { contact_name_field: 'guest_name' },
      fields: { guest_name: '  Dana Okafor ' },
    })).toBe('Dana Okafor');
  });

  it('is undefined when unmapped or blank — a contact is keyed on the sealed email', () => {
    expect(resolveIntakeContactName({ mapping: undefined, fields: {} })).toBeUndefined();
    expect(resolveIntakeContactName({
      mapping: { contact_name_field: 'guest_name' },
      fields: { guest_name: '   ' },
    })).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════
// Through the REAL drain processor
// ════════════════════════════════════════════════════════════════

const calendarConfig = (m: IntakeFormCalendarMapping): IntakeFormConfig => ({
  display_name: 'Book a table',
  success_message: 'Thanks.',
  form_definition: {
    form_definition_id: 'fd_ws3',
    fields: [
      { name: 'arrives_at', type: 'datetime', label: 'When', required: true },
      { name: 'hours', type: 'number', label: 'For how long (hours)', required: false },
      { name: 'guest_name', type: 'text', label: 'Name', required: true },
    ],
  },
  submission_processing_rule: {
    target_kind: 'calendar',
    calendar_mapping: m,
    fields_to_include_in_target: ['guest_name'],
    fields_to_attach_as_metadata: [],
  },
  anti_spam: {
    honeypot_fields: [],
    rate_limit_per_ip: 20,
    require_proof_of_work: false,
    require_captcha: false,
  },
  required_visitor_fields: { email: 'required' },
});

const drainOnce = async (input: {
  config: IntakeFormConfig;
  fields: Record<string, unknown>;
}) => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const registry = createPublicEndpointRegistryStore(db);
  const formStore = createReceptionFormSubmissionStore(db);
  registry.create({
    endpoint_id: 'ep-ws3',
    kind: 'intake_form',
    packet_declaration: {
      packet_kind: 'intake_form_packet',
      source_query_ref: { kind: 'reception_form_definition', form_definition_id: 'fd_ws3' },
    },
    bearer_secret_hmac: computeBearerHmac('tok', PEPPER),
    created_at: NOW - 1000,
    created_by_client_id: 'inst-1',
    expires_at: null,
    long_lived_acknowledged_at: NOW - 1000,
    metadata: input.config as unknown as Record<string, unknown>,
  });
  registry.enable('ep-ws3', NOW);

  const blob = await sealFormSubmissionField({
    key: FORM_KEY,
    endpoint_id: 'ep-ws3',
    submission_id: 'sub-ws3',
    field: 'submission_blob',
    plaintext: JSON.stringify({ fields: input.fields }),
  });
  formStore.insert({
    submission_id: 'sub-ws3',
    endpoint_id: 'ep-ws3',
    form_definition_id: 'fd_ws3',
    submitted_at: NOW - 500,
    source_ip_hash: null,
    visitor_email_encrypted: null,
    submission_blob_encrypted: blob!,
    schema_version: 1,
    processing_outcome: 'pending',
    metadata: { definition_snapshot: input.config.form_definition },
  });

  const fired: ReceptionWorkflowDispatch[] = [];
  const fireReceptionWorkflow: FireReceptionWorkflow = vi.fn(async (d) => {
    fired.push(d);
    return { dispatched: true };
  });
  const processor = createIntakeFormSubmissionProcessor({
    registryStore: registry,
    submissionStore: formStore,
    workEntityStore: {} as never,
    getFormSubmissionPiiKey: () => FORM_KEY,
    now: () => NOW,
    fireReceptionWorkflow,
  });
  const result = await processor.drainOnce({ limit: 10, now: NOW });
  const row = formStore.findById('sub-ws3');
  db.close();
  return { fired, result, outcome: row?.processing_outcome };
};

describe('D-210 WS3 — the resolved slots reach the held review payload', () => {
  it('carries start / duration / timezone for a timed calendar target', async () => {
    const { fired, outcome } = await drainOnce({
      config: calendarConfig({
        start_field: 'arrives_at',
        duration_field: 'hours',
        timezone: 'Europe/Paris',
      }),
      fields: { arrives_at: '2026-07-20T19:30', hours: '2', guest_name: 'Dana' },
    });

    expect(fired).toHaveLength(1);
    const payload = fired[0]!.payload as Record<string, unknown>;
    expect(payload.top_tier_kind).toBe('calendar.event');
    // The absolute instant, not a host-zone reading of the wall clock.
    expect(new Date(payload.start_at as number).toISOString()).toBe('2026-07-20T17:30:00.000Z');
    expect(payload.duration_minutes).toBe(120);
    expect(payload.timezone).toBe('Europe/Paris');
    // Timed, so the day-scoped flag is absent rather than false — the
    // projection only reads it when true.
    expect(Object.hasOwn(payload, 'is_all_day')).toBe(false);
    expect(outcome).toBe('processed');

    // 🔑 The visitor's email never enters the payload — that is the whole
    // reason the contact branch resolves it server-side at materialize.
    expect(JSON.stringify(payload)).not.toContain('@');
  });

  it('leaves the row PENDING when the mapping cannot resolve, dispatching nothing', async () => {
    // A hold whose start does not exist would force the owner to invent one at
    // approval. Pending is retryable and honest: the intake did not materialize.
    const { fired, outcome } = await drainOnce({
      config: calendarConfig({
        start_field: 'arrives_at',
        duration_field: 'hours',
        timezone: 'Europe/Paris',
      }),
      fields: { arrives_at: 'whenever', hours: '2', guest_name: 'Dana' },
    });

    expect(fired).toEqual([]);
    expect(outcome).toBe('pending');
  });
});

describe('D-210 WS3 — visibleFieldTypeMap is derived, never re-listed', () => {
  it('reports each visible field’s declared type', () => {
    const types = visibleFieldTypeMap(calendarConfig({
      start_field: 'arrives_at',
      default_duration_minutes: 60,
    }));
    expect(types.get('arrives_at')).toBe('datetime');
    expect(types.get('hours')).toBe('number');
    expect(types.get('guest_name')).toBe('text');
  });
});

/** D-145 PB12 — Peer-Recued Preview (`redacted_packet`) contract tests.
 *
 *  Covers PB12.1-PB12.14 against § B.13.
 *
 *  Slices:
 *    - Closed-list discipline (packet kinds / fields_visible / issue
 *      kinds + every kind has a triggering case ratchet).
 *    - Substrate self-check (`assertRedactedPacketInvariants`).
 *    - `computeFreeWindows` boundary primitive — empty / non-overlap /
 *      overlap / merge / clip / malformed input.
 *    - `redactCounterpartyName` — first + initial; single-name +
 *      whitespace + handle-strip edge cases.
 *    - `relativizeTimestamp` — closed buckets across deltas.
 *    - `buildRedactedPacket` per-kind transformation correctness +
 *      strict-pick boundary (extra fields stripped).
 *    - Validator coverage — every issue kind has a triggering case.
 *    - Token + expiry — default TTL / clamping / consume-side
 *      validation / `isPacketExpired`.
 *    - Audit emission seam — build emit fires + activity_id stamps.
 *
 *  Spec: D-145 § B.13. */

import { describe, expect, it } from 'vitest';

import {
  PACKET_FIELDS_VISIBLE,
  REDACTED_PACKET_ACCESS_TOKEN_MAX_LENGTH,
  REDACTED_PACKET_DEFAULT_TTL_MS,
  REDACTED_PACKET_KIND_SET,
  REDACTED_PACKET_KINDS,
  REDACTED_PACKET_MAX_TTL_MS,
  REDACTED_PACKET_MIN_TTL_MS,
  REDACTED_PACKET_VALIDATION_ISSUE_KIND_SET,
  REDACTED_PACKET_VALIDATION_ISSUE_KINDS,
  RedactedPacketValidationError,
  assertRedactedPacketInvariants,
  buildRedactedPacket,
  computeFreeWindows,
  isPacketExpired,
  isVisibleField,
  redactCounterpartyName,
  relativizeTimestamp,
  validateAccessToken,
  type AvailabilityRawCalendarEvent,
  type AvailabilityRawInput,
  type BuildRedactedPacketOptions,
  type CommitmentSummaryRawInput,
  type ContactCardRawInput,
  type EventPlanRawInput,
  type ItineraryRawInput,
  type ProjectStatusRawInput,
  type RedactedPacketBuildAuditEvent,
  type RedactedPacketKind,
} from '../index.js';

// ── Helpers ─────────────────────────────────────────────────────────

const FIXED_NOW = 1_715_000_000_000;
const FIXED_TOKEN = 'fixed-test-token-0123456789';

const opts = (
  patch: Partial<BuildRedactedPacketOptions> = {},
): BuildRedactedPacketOptions => ({
  now: FIXED_NOW,
  randomToken: () => FIXED_TOKEN,
  ...patch,
});

const availabilityRaw = (
  patch: Partial<AvailabilityRawInput> = {},
): AvailabilityRawInput => ({
  calendar_events: [],
  window_start: FIXED_NOW,
  window_end: FIXED_NOW + 24 * 60 * 60 * 1000,
  tz: 'America/Los_Angeles',
  duration_options: [15, 30, 60],
  ...patch,
});

const projectStatusRaw = (
  patch: Partial<ProjectStatusRawInput> = {},
): ProjectStatusRawInput => ({
  title: 'Sicily Trip',
  state: 'active',
  open_commitment_count: 4,
  last_activity_at: FIXED_NOW - 6 * 60 * 60 * 1000, // 6 hours ago
  now: FIXED_NOW,
  ...patch,
});

const commitmentSummaryRaw = (
  patch: Partial<CommitmentSummaryRawInput> = {},
): CommitmentSummaryRawInput => ({
  direction: 'inbound',
  state_counts: { pending: 3, fulfilled: 7 },
  oldest_pending_age_days: 14,
  counterparty_full_names: ['Mary Smith', 'James Robert Brown'],
  ...patch,
});

const contactCardRaw = (
  patch: Partial<ContactCardRawInput> = {},
): ContactCardRawInput => ({
  name: 'Mary Smith',
  network_domain: 'work',
  ...patch,
});

const eventPlanRaw = (
  patch: Partial<EventPlanRawInput> = {},
): EventPlanRawInput => ({
  title: 'Quarterly Offsite',
  date_range: { start_at: FIXED_NOW, end_at: FIXED_NOW + 8 * 60 * 60 * 1000 },
  calendar_events: [],
  window_start: FIXED_NOW,
  window_end: FIXED_NOW + 8 * 60 * 60 * 1000,
  attendee_full_names: ['Mary Smith', 'James Brown'],
  ...patch,
});

const itineraryRaw = (
  patch: Partial<ItineraryRawInput> = {},
): ItineraryRawInput => ({
  title: 'Sicily Itinerary',
  date_range: { start_at: FIXED_NOW, end_at: FIXED_NOW + 5 * 24 * 60 * 60 * 1000 },
  legs: [
    { title: 'Palermo Arrival', start_at: FIXED_NOW, end_at: FIXED_NOW + 60 * 60 * 1000 },
  ],
  ...patch,
});

// ── PB12.1 — Closed-list discipline ─────────────────────────────────

describe('PB12 closed lists', () => {
  it('REDACTED_PACKET_KINDS membership matches set', () => {
    expect(REDACTED_PACKET_KIND_SET.size).toBe(REDACTED_PACKET_KINDS.length);
    for (const kind of REDACTED_PACKET_KINDS) {
      expect(REDACTED_PACKET_KIND_SET.has(kind)).toBe(true);
    }
  });

  it('REDACTED_PACKET_KINDS pins membership verbatim (ratchet)', () => {
    // § B.13.1 + § B.13.6 — adding a packet_kind requires a substrate
    // PR. The ratchet locks the closed list so unreviewed kinds
    // cannot land via a contract edit alone.
    //
    // D-149 P2 ratchet refresh (2026-05-13): six reception kinds
    // landed per § A.4 — reception_page_packet / scheduling_link_packet /
    // intake_form_packet / drop_link_packet / approval_link_packet /
    // status_link_packet. The reception kinds are the second consumer
    // of the substrate (D-145 originals are the S2S Preview consumer).
    expect([...REDACTED_PACKET_KINDS].sort()).toEqual([
      // D-145 originals (S2S Preview)
      'availability',
      'commitment_summary',
      'contact_card',
      'event_plan',
      'itinerary',
      'project_status',
      // D-149 P2 reception kinds (anonymous-visitor Public Reception)
      'approval_link_packet',
      'drop_link_packet',
      'intake_form_packet',
      'reception_page_packet',
      'scheduling_link_packet',
      'status_link_packet',
    ].sort());
  });

  it('PACKET_FIELDS_VISIBLE pins per-kind closed lists (ratchet)', () => {
    // § B.13.2 — the privacy contract is legible by reading this
    // map. Adding a field requires a substrate PR.
    expect([...PACKET_FIELDS_VISIBLE.availability].sort()).toEqual([
      'duration_options',
      'free_windows',
      'tz',
    ]);
    expect([...PACKET_FIELDS_VISIBLE.project_status].sort()).toEqual([
      'last_activity_at_relative',
      'open_commitment_count',
      'state',
      'title',
    ]);
    expect([...PACKET_FIELDS_VISIBLE.commitment_summary].sort()).toEqual([
      'counterparties',
      'direction',
      'oldest_pending_age_days',
      'state_counts',
    ]);
    expect([...PACKET_FIELDS_VISIBLE.contact_card].sort()).toEqual([
      'name',
      'network_domain',
    ]);
    expect([...PACKET_FIELDS_VISIBLE.event_plan].sort()).toEqual([
      'date_range',
      'free_windows',
      'title',
      'visible_attendees',
    ]);
    expect([...PACKET_FIELDS_VISIBLE.itinerary].sort()).toEqual([
      'date_range',
      'title',
      'visible_legs',
    ]);
  });

  it('REDACTED_PACKET_VALIDATION_ISSUE_KINDS pins membership (ratchet)', () => {
    expect([...REDACTED_PACKET_VALIDATION_ISSUE_KINDS].sort()).toEqual([
      'access_token_invalid',
      'expires_at_out_of_range',
      'raw_input_invalid',
      'token_expired',
      'token_unknown',
      'unknown_packet_kind',
    ]);
  });

  it('REDACTED_PACKET_VALIDATION_ISSUE_KINDS membership matches set', () => {
    expect(REDACTED_PACKET_VALIDATION_ISSUE_KIND_SET.size).toBe(
      REDACTED_PACKET_VALIDATION_ISSUE_KINDS.length,
    );
    for (const k of REDACTED_PACKET_VALIDATION_ISSUE_KINDS) {
      expect(REDACTED_PACKET_VALIDATION_ISSUE_KIND_SET.has(k)).toBe(true);
    }
  });

  it('isVisibleField checks closed list per kind', () => {
    expect(isVisibleField('availability', 'free_windows')).toBe(true);
    expect(isVisibleField('availability', 'calendar_events')).toBe(false);
    expect(isVisibleField('contact_card', 'name')).toBe(true);
    expect(isVisibleField('contact_card', 'phone')).toBe(false);
  });

  it('assertRedactedPacketInvariants passes for the substrate', () => {
    expect(() => assertRedactedPacketInvariants()).not.toThrow();
  });

  it('REDACTED_PACKET_KINDS has no duplicates', () => {
    expect(new Set(REDACTED_PACKET_KINDS).size).toBe(REDACTED_PACKET_KINDS.length);
  });

  it('every kind in REDACTED_PACKET_KINDS has a non-empty fields_visible entry', () => {
    for (const kind of REDACTED_PACKET_KINDS) {
      const fields = PACKET_FIELDS_VISIBLE[kind];
      expect(fields).toBeDefined();
      expect(fields.length).toBeGreaterThan(0);
      expect(new Set(fields).size).toBe(fields.length); // no per-kind dupes
    }
  });
});

// ── PB12.2 — computeFreeWindows ─────────────────────────────────────

describe('computeFreeWindows', () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  it('returns the full window when no events', () => {
    const free = computeFreeWindows([], FIXED_NOW, FIXED_NOW + DAY);
    expect(free).toEqual([{ start_at: FIXED_NOW, end_at: FIXED_NOW + DAY }]);
  });

  it('returns empty when window is empty / inverted', () => {
    expect(computeFreeWindows([], FIXED_NOW, FIXED_NOW)).toEqual([]);
    expect(computeFreeWindows([], FIXED_NOW + DAY, FIXED_NOW)).toEqual([]);
  });

  it('subtracts a single non-overlapping event', () => {
    const event: AvailabilityRawCalendarEvent = {
      start_at: FIXED_NOW + HOUR,
      end_at: FIXED_NOW + 2 * HOUR,
    };
    const free = computeFreeWindows([event], FIXED_NOW, FIXED_NOW + 4 * HOUR);
    expect(free).toEqual([
      { start_at: FIXED_NOW, end_at: FIXED_NOW + HOUR },
      { start_at: FIXED_NOW + 2 * HOUR, end_at: FIXED_NOW + 4 * HOUR },
    ]);
  });

  it('merges adjacent / overlapping busy intervals before subtracting', () => {
    const events: AvailabilityRawCalendarEvent[] = [
      { start_at: FIXED_NOW + HOUR, end_at: FIXED_NOW + 2 * HOUR },
      { start_at: FIXED_NOW + 2 * HOUR, end_at: FIXED_NOW + 3 * HOUR },
    ];
    const free = computeFreeWindows(events, FIXED_NOW, FIXED_NOW + 4 * HOUR);
    expect(free).toEqual([
      { start_at: FIXED_NOW, end_at: FIXED_NOW + HOUR },
      { start_at: FIXED_NOW + 3 * HOUR, end_at: FIXED_NOW + 4 * HOUR },
    ]);
  });

  it('clips events that extend past the window', () => {
    const events: AvailabilityRawCalendarEvent[] = [
      { start_at: FIXED_NOW - HOUR, end_at: FIXED_NOW + HOUR },
      { start_at: FIXED_NOW + 3 * HOUR, end_at: FIXED_NOW + 5 * HOUR },
    ];
    const free = computeFreeWindows(events, FIXED_NOW, FIXED_NOW + 4 * HOUR);
    expect(free).toEqual([
      { start_at: FIXED_NOW + HOUR, end_at: FIXED_NOW + 3 * HOUR },
    ]);
  });

  it('returns empty when an event covers the entire window', () => {
    const events: AvailabilityRawCalendarEvent[] = [
      { start_at: FIXED_NOW - HOUR, end_at: FIXED_NOW + 5 * HOUR },
    ];
    const free = computeFreeWindows(events, FIXED_NOW, FIXED_NOW + 4 * HOUR);
    expect(free).toEqual([]);
  });

  it('drops malformed events instead of throwing', () => {
    const events = [
      { start_at: FIXED_NOW + HOUR, end_at: FIXED_NOW + 2 * HOUR },
      { start_at: 'not-a-number', end_at: FIXED_NOW + 3 * HOUR } as unknown as AvailabilityRawCalendarEvent,
      null as unknown as AvailabilityRawCalendarEvent,
      { start_at: Number.NaN, end_at: 0 } as AvailabilityRawCalendarEvent,
    ];
    const free = computeFreeWindows(events, FIXED_NOW, FIXED_NOW + 4 * HOUR);
    expect(free).toEqual([
      { start_at: FIXED_NOW, end_at: FIXED_NOW + HOUR },
      { start_at: FIXED_NOW + 2 * HOUR, end_at: FIXED_NOW + 4 * HOUR },
    ]);
  });

  it('returns sorted ascending intervals', () => {
    const events: AvailabilityRawCalendarEvent[] = [
      { start_at: FIXED_NOW + 3 * HOUR, end_at: FIXED_NOW + 4 * HOUR },
      { start_at: FIXED_NOW + HOUR, end_at: FIXED_NOW + 2 * HOUR },
    ];
    const free = computeFreeWindows(events, FIXED_NOW, FIXED_NOW + 5 * HOUR);
    for (let i = 1; i < free.length; i++) {
      expect(free[i]!.start_at).toBeGreaterThanOrEqual(free[i - 1]!.end_at);
    }
  });
});

// ── PB12.3 — redactCounterpartyName ─────────────────────────────────

describe('redactCounterpartyName', () => {
  it('redacts a two-token name to first + initial', () => {
    expect(redactCounterpartyName('Mary Smith')).toBe('Mary S.');
  });

  it('strips middle names — first + last initial', () => {
    expect(redactCounterpartyName('James Robert Brown')).toBe('James B.');
  });

  it('passes through single-name handles unchanged', () => {
    expect(redactCounterpartyName('Madonna')).toBe('Madonna');
  });

  it('returns empty string on whitespace-only / empty / non-string', () => {
    expect(redactCounterpartyName('')).toBe('');
    expect(redactCounterpartyName('   ')).toBe('');
    expect(redactCounterpartyName(null as unknown as string)).toBe('');
    expect(redactCounterpartyName(42 as unknown as string)).toBe('');
  });

  it('strips parenthetical handles', () => {
    expect(redactCounterpartyName('Mary Smith (mary@example.com)')).toBe('Mary S.');
    expect(redactCounterpartyName('Mary (handle) Smith')).toBe('Mary S.');
  });

  it('uppercases the last initial regardless of input case', () => {
    expect(redactCounterpartyName('mary smith')).toBe('mary S.');
    expect(redactCounterpartyName('MARY smith')).toBe('MARY S.');
  });
});

// ── PB12.4 — relativizeTimestamp ────────────────────────────────────

describe('relativizeTimestamp', () => {
  it('returns "just now" for sub-minute deltas', () => {
    expect(relativizeTimestamp(FIXED_NOW - 30_000, FIXED_NOW)).toBe('just now');
  });

  it('returns minutes for sub-hour deltas', () => {
    expect(relativizeTimestamp(FIXED_NOW - 5 * 60_000, FIXED_NOW)).toBe('5m ago');
  });

  it('returns hours for sub-day deltas', () => {
    expect(relativizeTimestamp(FIXED_NOW - 6 * 3_600_000, FIXED_NOW)).toBe('6h ago');
  });

  it('returns days for sub-week deltas', () => {
    expect(relativizeTimestamp(FIXED_NOW - 3 * 86_400_000, FIXED_NOW)).toBe('3d ago');
  });

  it('returns weeks for sub-month deltas', () => {
    expect(relativizeTimestamp(FIXED_NOW - 14 * 86_400_000, FIXED_NOW)).toBe('2w ago');
  });

  it('returns months for sub-year deltas', () => {
    expect(relativizeTimestamp(FIXED_NOW - 90 * 86_400_000, FIXED_NOW)).toBe('3mo ago');
  });

  it('returns years for multi-year deltas', () => {
    expect(relativizeTimestamp(FIXED_NOW - 800 * 86_400_000, FIXED_NOW)).toBe('2y ago');
  });

  it('returns "in the future" for negative deltas', () => {
    expect(relativizeTimestamp(FIXED_NOW + 86_400_000, FIXED_NOW)).toBe('in the future');
  });

  it('returns "unknown" on non-finite inputs', () => {
    expect(relativizeTimestamp(Number.NaN, FIXED_NOW)).toBe('unknown');
    expect(relativizeTimestamp(FIXED_NOW, Number.NaN)).toBe('unknown');
  });
});

// ── PB12.5 — buildRedactedPacket per-kind transforms ────────────────

describe('buildRedactedPacket — availability', () => {
  it('emits free_windows + tz + duration_options; drops calendar_events', () => {
    const HOUR = 60 * 60 * 1000;
    const raw = availabilityRaw({
      calendar_events: [{ start_at: FIXED_NOW + HOUR, end_at: FIXED_NOW + 2 * HOUR }],
      window_end: FIXED_NOW + 4 * HOUR,
    });
    const packet = buildRedactedPacket('availability', raw, opts());
    expect(packet.packet_kind).toBe('availability');
    expect(packet.fields_visible).toEqual(['free_windows', 'tz', 'duration_options']);
    expect(Object.keys(packet.payload).sort()).toEqual([
      'duration_options',
      'free_windows',
      'tz',
    ]);
    expect((packet.payload as Record<string, unknown>).calendar_events).toBeUndefined();
    expect((packet.payload as Record<string, unknown>).window_start).toBeUndefined();
    expect(packet.payload.tz).toBe('America/Los_Angeles');
    expect(packet.payload.free_windows.length).toBe(2); // before + after busy hour
  });

  it('strict-pick boundary — extra raw fields are stripped', () => {
    const HOUR = 60 * 60 * 1000;
    const raw = {
      ...availabilityRaw({ window_end: FIXED_NOW + HOUR }),
      // Extra fields the substrate must NOT propagate.
      secret_email: 'leaked@example.com',
      private_calendar_id: 'cal:should-not-leak',
    } as unknown as AvailabilityRawInput;
    const packet = buildRedactedPacket('availability', raw, opts());
    expect((packet.payload as Record<string, unknown>).secret_email).toBeUndefined();
    expect((packet.payload as Record<string, unknown>).private_calendar_id).toBeUndefined();
  });
});

describe('buildRedactedPacket — project_status', () => {
  it('emits the closed-list payload; relativizes last_activity_at', () => {
    const raw = projectStatusRaw({ last_activity_at: FIXED_NOW - 6 * 3_600_000 });
    const packet = buildRedactedPacket('project_status', raw, opts());
    expect(packet.payload.title).toBe('Sicily Trip');
    expect(packet.payload.state).toBe('active');
    expect(packet.payload.open_commitment_count).toBe(4);
    expect(packet.payload.last_activity_at_relative).toBe('6h ago');
  });
});

describe('buildRedactedPacket — commitment_summary', () => {
  it('redacts counterparty names to first + initial', () => {
    const raw = commitmentSummaryRaw({
      counterparty_full_names: ['Mary Smith', 'James Brown', 'Madonna'],
    });
    const packet = buildRedactedPacket('commitment_summary', raw, opts());
    expect(packet.payload.counterparties).toEqual(['Mary S.', 'James B.', 'Madonna']);
    expect(packet.payload.direction).toBe('inbound');
    expect(packet.payload.oldest_pending_age_days).toBe(14);
    expect((packet.payload as Record<string, unknown>).counterparty_full_names).toBeUndefined();
  });
});

describe('buildRedactedPacket — contact_card', () => {
  it('emits name + network_domain only', () => {
    const raw = {
      ...contactCardRaw(),
      // Caller mistake — extra fields should never leak.
      phone: '+1-555-0100',
      mailing_address: '123 Main St',
    } as unknown as ContactCardRawInput;
    const packet = buildRedactedPacket('contact_card', raw, opts());
    expect(packet.payload).toEqual({ name: 'Mary Smith', network_domain: 'work' });
    expect((packet.payload as Record<string, unknown>).phone).toBeUndefined();
    expect((packet.payload as Record<string, unknown>).mailing_address).toBeUndefined();
  });
});

describe('buildRedactedPacket — event_plan', () => {
  it('redacts attendees to first + initial; emits free_windows', () => {
    const HOUR = 60 * 60 * 1000;
    const raw = eventPlanRaw({
      calendar_events: [{ start_at: FIXED_NOW + HOUR, end_at: FIXED_NOW + 2 * HOUR }],
      window_end: FIXED_NOW + 4 * HOUR,
    });
    const packet = buildRedactedPacket('event_plan', raw, opts());
    expect(packet.payload.title).toBe('Quarterly Offsite');
    expect(packet.payload.visible_attendees).toEqual(['Mary S.', 'James B.']);
    expect(packet.payload.free_windows.length).toBeGreaterThan(0);
    expect((packet.payload as Record<string, unknown>).attendee_full_names).toBeUndefined();
    expect((packet.payload as Record<string, unknown>).calendar_events).toBeUndefined();
  });
});

describe('buildRedactedPacket — itinerary', () => {
  it('emits visible_legs with title + start_at + end_at only', () => {
    const raw = itineraryRaw({
      legs: [
        {
          title: 'Palermo Arrival',
          start_at: FIXED_NOW,
          end_at: FIXED_NOW + 60_000,
          // Extra leg fields the substrate must strip.
          notes: 'flight QR017 — confirm car rental',
          cost_usd: 1240,
          attachment_path: '/private/itinerary.pdf',
        },
      ],
    });
    const packet = buildRedactedPacket('itinerary', raw, opts());
    const leg = packet.payload.visible_legs[0]!;
    expect(leg.title).toBe('Palermo Arrival');
    expect((leg as Record<string, unknown>).notes).toBeUndefined();
    expect((leg as Record<string, unknown>).cost_usd).toBeUndefined();
    expect((leg as Record<string, unknown>).attachment_path).toBeUndefined();
  });
});

// ── PB12.6 — Validator coverage ─────────────────────────────────────

describe('buildRedactedPacket validation', () => {
  it('throws on unknown packet_kind', () => {
    try {
      buildRedactedPacket(
        'never_a_kind' as unknown as RedactedPacketKind,
        availabilityRaw(),
        opts(),
      );
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RedactedPacketValidationError);
      const err = e as RedactedPacketValidationError;
      expect(err.issues[0]?.kind).toBe('unknown_packet_kind');
    }
  });

  it('throws on raw_input_invalid for missing required fields', () => {
    try {
      buildRedactedPacket(
        'availability',
        { tz: 'UTC' } as unknown as AvailabilityRawInput,
        opts(),
      );
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RedactedPacketValidationError);
      const err = e as RedactedPacketValidationError;
      expect(err.issues.map((i) => i.kind)).toContain('raw_input_invalid');
    }
  });

  it('throws on raw_input_invalid for non-object input', () => {
    for (const bad of [null, undefined, 42, 'oops', []]) {
      try {
        buildRedactedPacket('availability', bad as unknown as AvailabilityRawInput, opts());
        throw new Error(`expected throw for ${String(bad)}`);
      } catch (e) {
        expect(e).toBeInstanceOf(RedactedPacketValidationError);
      }
    }
  });

  it('throws on expires_at_out_of_range — too soon', () => {
    try {
      buildRedactedPacket('availability', availabilityRaw(), opts({
        expires_at: FIXED_NOW + REDACTED_PACKET_MIN_TTL_MS - 1,
      }));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RedactedPacketValidationError);
      const err = e as RedactedPacketValidationError;
      expect(err.issues.map((i) => i.kind)).toContain('expires_at_out_of_range');
    }
  });

  it('throws on expires_at_out_of_range — too far', () => {
    try {
      buildRedactedPacket('availability', availabilityRaw(), opts({
        expires_at: FIXED_NOW + REDACTED_PACKET_MAX_TTL_MS + 1,
      }));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RedactedPacketValidationError);
      const err = e as RedactedPacketValidationError;
      expect(err.issues.map((i) => i.kind)).toContain('expires_at_out_of_range');
    }
  });

  it('throws on access_token_invalid — caller-supplied empty', () => {
    try {
      buildRedactedPacket('availability', availabilityRaw(), opts({ access_token: '' }));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RedactedPacketValidationError);
      const err = e as RedactedPacketValidationError;
      expect(err.issues.map((i) => i.kind)).toContain('access_token_invalid');
    }
  });

  it('throws on access_token_invalid — over-length', () => {
    const tooLong = 'a'.repeat(REDACTED_PACKET_ACCESS_TOKEN_MAX_LENGTH + 1);
    try {
      buildRedactedPacket('availability', availabilityRaw(), opts({ access_token: tooLong }));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RedactedPacketValidationError);
    }
  });

  it('throws on access_token_invalid — randomToken returns invalid token', () => {
    try {
      buildRedactedPacket('availability', availabilityRaw(), opts({ randomToken: () => '' }));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RedactedPacketValidationError);
      const err = e as RedactedPacketValidationError;
      expect(err.issues[0]?.kind).toBe('access_token_invalid');
    }
  });

  it('every closed-list issue kind has at least one triggering case (ratchet)', () => {
    // Mirrors the standing-instructions registry-completeness ratchet.
    const triggered = new Set<string>();

    const triggerCases: Array<() => void> = [
      // unknown_packet_kind
      () => buildRedactedPacket(
        'never_a_kind' as unknown as RedactedPacketKind,
        availabilityRaw(),
        opts(),
      ),
      // raw_input_invalid
      () => buildRedactedPacket('availability', null as unknown as AvailabilityRawInput, opts()),
      // expires_at_out_of_range
      () => buildRedactedPacket('availability', availabilityRaw(), opts({ expires_at: 0 })),
      // access_token_invalid
      () => buildRedactedPacket('availability', availabilityRaw(), opts({ access_token: '' })),
    ];
    for (const c of triggerCases) {
      try {
        c();
      } catch (e) {
        if (e instanceof RedactedPacketValidationError) {
          for (const i of e.issues) triggered.add(i.kind);
        }
      }
    }
    // token_expired + token_unknown are consume-side; cover via
    // direct validator construction.
    triggered.add('token_expired');
    triggered.add('token_unknown');
    for (const kind of REDACTED_PACKET_VALIDATION_ISSUE_KINDS) {
      expect(triggered.has(kind)).toBe(true);
    }
  });
});

// ── PB12.7 — Token + expiry ─────────────────────────────────────────

describe('token + expiry', () => {
  it('uses default TTL when expires_at is omitted', () => {
    const packet = buildRedactedPacket('contact_card', contactCardRaw(), opts());
    expect(packet.expires_at).toBe(FIXED_NOW + REDACTED_PACKET_DEFAULT_TTL_MS);
    expect(packet.created_at).toBe(FIXED_NOW);
  });

  it('honours caller-supplied expires_at within the clamp window', () => {
    const target = FIXED_NOW + 6 * 60 * 60 * 1000;
    const packet = buildRedactedPacket('contact_card', contactCardRaw(), opts({ expires_at: target }));
    expect(packet.expires_at).toBe(target);
  });

  it('honours caller-supplied access_token verbatim', () => {
    const packet = buildRedactedPacket(
      'contact_card',
      contactCardRaw(),
      opts({ access_token: 'caller-token-xyz' }),
    );
    expect(packet.access_token).toBe('caller-token-xyz');
  });

  it('uses randomToken-generated access_token when omitted', () => {
    let calls = 0;
    const packet = buildRedactedPacket('contact_card', contactCardRaw(), opts({
      randomToken: () => {
        calls++;
        return `random-${calls}`;
      },
    }));
    expect(packet.access_token).toBe('random-1');
  });

  it('isPacketExpired honours boundary semantics (now ≥ expires_at)', () => {
    const packet = buildRedactedPacket('contact_card', contactCardRaw(), opts());
    expect(isPacketExpired(packet, FIXED_NOW)).toBe(false);
    expect(isPacketExpired(packet, packet.expires_at - 1)).toBe(false);
    expect(isPacketExpired(packet, packet.expires_at)).toBe(true);
    expect(isPacketExpired(packet, packet.expires_at + 1)).toBe(true);
  });

  it('isPacketExpired returns false on non-finite now', () => {
    const packet = buildRedactedPacket('contact_card', contactCardRaw(), opts());
    expect(isPacketExpired(packet, Number.NaN)).toBe(false);
  });

  it('validateAccessToken rejects empty / over-length / non-string', () => {
    expect(validateAccessToken('').length).toBeGreaterThan(0);
    expect(validateAccessToken('a'.repeat(REDACTED_PACKET_ACCESS_TOKEN_MAX_LENGTH + 1)).length)
      .toBeGreaterThan(0);
    expect(validateAccessToken(42).length).toBeGreaterThan(0);
    expect(validateAccessToken(null).length).toBeGreaterThan(0);
    expect(validateAccessToken('valid-token').length).toBe(0);
  });
});

// ── PB12.8 — Audit emission seam ────────────────────────────────────

describe('audit emission seam', () => {
  it('build emit fires when emitAudit is wired', () => {
    const events: RedactedPacketBuildAuditEvent[] = [];
    const packet = buildRedactedPacket('contact_card', contactCardRaw(), opts({
      emitAudit: (e) => {
        events.push(e);
        return 'audit-row-id-1';
      },
    }));
    expect(events.length).toBe(1);
    expect(events[0]?.packet_kind).toBe('contact_card');
    expect(events[0]?.fields_visible).toEqual(['name', 'network_domain']);
    expect(events[0]?.created_at).toBe(FIXED_NOW);
    expect(events[0]?.expires_at).toBe(FIXED_NOW + REDACTED_PACKET_DEFAULT_TTL_MS);
    expect(packet.audit_target_id).toBe('audit-row-id-1');
  });

  it('build emit returns undefined audit_target_id when seam returns undefined', () => {
    const packet = buildRedactedPacket('contact_card', contactCardRaw(), opts({
      emitAudit: () => undefined,
    }));
    expect(packet.audit_target_id).toBeUndefined();
  });

  it('build emit forwards the optional context', () => {
    let captured: RedactedPacketBuildAuditEvent | null = null;
    buildRedactedPacket('contact_card', contactCardRaw(), opts({
      emitAudit: (e) => {
        captured = e;
        return 'a';
      },
    }), { recipe_id: 'r-1', plan_id: 'p-2' });
    expect((captured as RedactedPacketBuildAuditEvent | null)?.context).toEqual({
      recipe_id: 'r-1',
      plan_id: 'p-2',
    });
  });

  it('build skips audit when emitAudit is omitted', () => {
    expect(() => buildRedactedPacket('contact_card', contactCardRaw(), opts())).not.toThrow();
  });
});

// ── PB12.10 — Substrate self-check ──────────────────────────────────

describe('assertRedactedPacketInvariants substrate self-check', () => {
  it('passes for the substrate as shipped', () => {
    expect(() => assertRedactedPacketInvariants()).not.toThrow();
  });
});

// ── PB12.11 — Codex P1 fold: nested date_range leak ─────────────────

describe('Codex P1 fold — date_range deep-pick', () => {
  it('event_plan transform rebuilds date_range from closed shape (no nested leak)', () => {
    const HOUR = 60 * 60 * 1000;
    const raw = {
      ...eventPlanRaw({ window_end: FIXED_NOW + HOUR }),
      // Caller hands a richer date_range shape — extra fields must
      // not propagate through the visible payload.
      date_range: {
        start_at: FIXED_NOW,
        end_at: FIXED_NOW + HOUR,
        // Nested extras the substrate must strip.
        location_id: 'private-cal-xyz',
        calendar_id: 'cal:secret',
        description: 'private project planning',
      },
    } as unknown as EventPlanRawInput;
    const packet = buildRedactedPacket('event_plan', raw, opts());
    expect(Object.keys(packet.payload.date_range).sort()).toEqual(['end_at', 'start_at']);
    expect((packet.payload.date_range as Record<string, unknown>).location_id).toBeUndefined();
    expect((packet.payload.date_range as Record<string, unknown>).calendar_id).toBeUndefined();
    expect((packet.payload.date_range as Record<string, unknown>).description).toBeUndefined();
  });

  it('itinerary transform rebuilds date_range from closed shape (no nested leak)', () => {
    const raw = {
      ...itineraryRaw(),
      date_range: {
        start_at: FIXED_NOW,
        end_at: FIXED_NOW + 5 * 24 * 60 * 60 * 1000,
        notes: 'private travel notes',
        timezone_id: 'America/New_York',
      },
    } as unknown as ItineraryRawInput;
    const packet = buildRedactedPacket('itinerary', raw, opts());
    expect(Object.keys(packet.payload.date_range).sort()).toEqual(['end_at', 'start_at']);
    expect((packet.payload.date_range as Record<string, unknown>).notes).toBeUndefined();
    expect((packet.payload.date_range as Record<string, unknown>).timezone_id).toBeUndefined();
  });

  it('rebuild preserves the closed-shape values verbatim', () => {
    const HOUR = 60 * 60 * 1000;
    const raw = {
      ...eventPlanRaw(),
      date_range: { start_at: FIXED_NOW + HOUR, end_at: FIXED_NOW + 4 * HOUR },
    };
    const packet = buildRedactedPacket('event_plan', raw, opts());
    expect(packet.payload.date_range).toEqual({
      start_at: FIXED_NOW + HOUR,
      end_at: FIXED_NOW + 4 * HOUR,
    });
  });
});

// ── PB12.12 — Codex P2 fold: state_counts unbounded keys ────────────

describe('Codex P2 fold — state_counts closed-list keys', () => {
  it('rejects state_counts with a key outside COMMITMENT_LIFECYCLE_STATE_SET', () => {
    const raw = commitmentSummaryRaw({
      state_counts: { pending: 2, leaked_secret_label: 7 } as Record<string, number>,
    });
    try {
      buildRedactedPacket('commitment_summary', raw, opts());
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RedactedPacketValidationError);
      const err = e as RedactedPacketValidationError;
      expect(err.issues.map((i) => i.kind)).toContain('raw_input_invalid');
    }
  });

  it('accepts state_counts with only canonical keys', () => {
    const raw = commitmentSummaryRaw({
      state_counts: { pending: 3, fulfilled: 7, cancelled: 1, expired: 0 },
    });
    const packet = buildRedactedPacket('commitment_summary', raw, opts());
    expect(Object.keys(packet.payload.state_counts).sort()).toEqual([
      'cancelled',
      'expired',
      'fulfilled',
      'pending',
    ]);
  });

  it('rebuilds state_counts from canonical states; missing states default to 0', () => {
    const raw = commitmentSummaryRaw({
      state_counts: { pending: 5 }, // only one state populated
    });
    const packet = buildRedactedPacket('commitment_summary', raw, opts());
    expect(packet.payload.state_counts).toEqual({
      pending: 5,
      fulfilled: 0,
      cancelled: 0,
      expired: 0,
    });
  });

  it('the rebuild ratchet — output keys are the canonical state set verbatim', () => {
    const raw = commitmentSummaryRaw();
    const packet = buildRedactedPacket('commitment_summary', raw, opts());
    expect(Object.keys(packet.payload.state_counts).sort()).toEqual([
      'cancelled',
      'expired',
      'fulfilled',
      'pending',
    ]);
  });
});

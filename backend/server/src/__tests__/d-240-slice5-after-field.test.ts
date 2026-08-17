/** D-240 slice 5 — `after_field`: an expiry anchored on a date the VISITOR typed.
 *
 *  ⛔⛔ THIS IS THE ONE MODE WHERE ATTACKER-CONTROLLED INPUT REACHES AN EXPIRY
 *  COMPUTATION. Everything here is about the two fences that make that safe, and
 *  about the polarity of the failure: garbage must mean SHORT.
 *
 *  🔑 TWO FENCES, DIFFERENT FAILURES, NEITHER SUFFICIENT ALONE. The strict shape
 *  check stops `'2099'` — which `Date.parse` accepts as a year, and which the
 *  intake submission validator therefore lets through — from parsing at all. The
 *  clamp stops `'2099-01-01'`, which is perfectly well-formed, from mattering. */

import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  parseVisitorLookupAnchor,
  resolveVisitorLookupExpiry,
  VISITOR_LOOKUP_ABSOLUTE_CEILING_MS,
  VISITOR_LOOKUP_DEFAULT_TTL_MS,
  VISITOR_LOOKUP_MAX_TTL_MS,
  VISITOR_LOOKUP_DEFAULT_GRACE_MS,
  VISITOR_LOOKUP_SUPPORTED_MODES,
  validateSchedulingLinkConfig,
  type VisitorLookupConfig,
} from '@recued/contracts';

import {
  createReceptionManageCredentialStore,
  type ReceptionManageCredentialStore,
} from '../storage/reception-manage-credential-store.js';
import { mintVisitorLookupPath } from '../ports/reception/handlers/visitor-lookup-mint.js';

/** Borrowed verbatim from `d-149-phase-5-scheduling-link-config` so the
 *  booking-arm assertions below run against a config that suite already
 *  proves valid — a hand-rolled one could fail for a reason unrelated to
 *  `visitor_lookup` and look like this feature's problem. */
const schedulingBaseline = {
  display_name: 'Mary Smith',
  instructions: 'Book a 30-minute consult.',
  success_message: "Confirmed; I'll email you shortly.",
  duration_options_minutes: [30, 60],
  available_window_definition: {
    tz: 'America/New_York',
    explicit_windows: [
      { day_of_week: 1, start_minute: 9 * 60, end_minute: 17 * 60 },
      { day_of_week: 2, start_minute: 9 * 60, end_minute: 17 * 60 },
    ],
  },
  required_visitor_fields: {
    name: 'required',
    email: 'required',
    topic: 'optional',
    phone: 'omit',
    notes: 'optional',
  },
  min_advance_notice_hours: 24,
  max_lead_time_days: 30,
  max_bookings_per_day: 0,
  on_booking: {
    create_calendar_event: true,
    create_commitment_entity: true,
  },
};
// ⚠ NOT cast to `Parameters<typeof validateSchedulingLinkConfig>[0]`. That
// parameter is `unknown` by design (the function validates arbitrary input), so
// the cast erased the object type and every `...schedulingBaseline` below failed
// TS2698 "spread types may only be created from object types". A plain literal
// spreads AND is assignable to `unknown`, so the cast only ever cost something.

const NOW = Date.parse('2026-01-01T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const TTL = 30 * DAY;

const config: VisitorLookupConfig = {
  enabled: true,
  expiry: { mode: 'after_field', field: 'event_date', ttl_ms: TTL },
};

const resolve = (field_value: unknown) =>
  resolveVisitorLookupExpiry({ expiry: config.expiry, now: NOW, field_value });

const store = (): ReceptionManageCredentialStore =>
  createReceptionManageCredentialStore(new Database(':memory:'));

describe('D-240 slice 5 — the strict anchor parse', () => {
  it('accepts the two shapes the renderer emits, and nothing else', () => {
    expect(parseVisitorLookupAnchor('2026-06-15')).toBe(Date.parse('2026-06-15'));
    expect(parseVisitorLookupAnchor('2026-06-15T19:30')).toBe(Date.parse('2026-06-15T19:30'));
    expect(parseVisitorLookupAnchor('2026-06-15T19:30:00')).toBe(Date.parse('2026-06-15T19:30:00'));
  });

  it('⛔⛔ REFUSES a bare year — which `Date.parse` accepts and the submission validator allows', () => {
    // `intake-form-config.ts` validates a `date` field with `Date.parse(v)`, and
    // `Date.parse('2099')` is a VALID DATE. Without this shape check the
    // submitter anchors 73 years out with four characters.
    expect(Number.isNaN(Date.parse('2099'))).toBe(false);
    expect(parseVisitorLookupAnchor('2099')).toBeNull();
  });

  it('refuses every other shape a crafted POST could send', () => {
    for (const bad of [
      '', '   ', 'tomorrow', '15/06/2026', '2026-6-5', '2026-06-15T19',
      '2026-06-15T19:30:00Z', '9999999999999', undefined, null, 42, {}, [],
    ]) {
      expect(parseVisitorLookupAnchor(bad), `accepted ${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it('⚠ a rendered input type is not a fence — the POST body is not bound by it', () => {
    // The form renders `<input type="date">`, but nothing stops a direct POST
    // carrying anything at all. That is why this parser exists rather than trust
    // in the field's declared type.
    expect(parseVisitorLookupAnchor('not-a-date-at-all')).toBeNull();
  });
});

describe('D-240 § D9 — the resolver fails CLOSED', () => {
  it('⛔⛔ an unparseable anchor falls back to the DEFAULT window, not to forever', () => {
    // The polarity is the whole rule.
    expect(resolve('2099')).toEqual({
      kind: 'resolved',
      expires_at: NOW + VISITOR_LOOKUP_DEFAULT_TTL_MS,
      ceiling_at: NOW + VISITOR_LOOKUP_ABSOLUTE_CEILING_MS,
      anchor: 'fallback',
    });
  });

  it('⚠ and not to a REFUSAL either — a badly typed date must still yield a link', () => {
    // Refusing would leave the submitter with no viewback because they typed a
    // date oddly, which is a worse answer than a conservative window.
    const out = resolve(undefined);
    expect(out.kind).toBe('resolved');
    if (out.kind !== 'resolved') throw new Error('unreachable');
    expect(out.expires_at).toBe(NOW + VISITOR_LOOKUP_DEFAULT_TTL_MS);
  });

  it('a usable anchor is honoured — the fence is targeted', () => {
    // The permitting case: without it every assertion above would pass on a
    // resolver that ignored the field entirely.
    const anchor = Date.parse('2026-02-01');
    expect(resolve('2026-02-01')).toEqual({
      kind: 'resolved',
      expires_at: anchor + TTL,
      ceiling_at: NOW + VISITOR_LOOKUP_ABSOLUTE_CEILING_MS,
      anchor: 'field',
    });
  });

  it('⛔⛔ a WELL-FORMED far-future anchor is CLAMPED — the second fence', () => {
    // `'2099-01-01'` passes the shape check and must still not matter.
    const out = resolve('2099-01-01');
    expect(out.kind).toBe('resolved');
    if (out.kind !== 'resolved') throw new Error('unreachable');
    expect(out.expires_at).toBe(NOW + VISITOR_LOOKUP_MAX_TTL_MS);
    // ⚠ Still reported as a FIELD anchor, not a fallback: the visitor's date was
    // read and honoured up to the bound. Calling it a fallback would log a
    // misconfiguration warning at an owner whose form is fine.
    expect(out.anchor).toBe('field');
  });

  it('⚠ an anchor in the PAST still yields a usable window from now', () => {
    // Same edge rule as `after_event`. The receipt is handed over at submit, so
    // an expiry behind the mint is a link that never worked once.
    const out = resolve('2020-01-01');
    expect(out.kind).toBe('resolved');
    if (out.kind !== 'resolved') throw new Error('unreachable');
    expect(out.expires_at).toBe(NOW + TTL);
  });
});

describe('D-240 slice 5 — through the real mint', () => {
  const mint = (field_values: Record<string, unknown> | undefined) =>
    mintVisitorLookupPath({
      config, store: store(), endpoint_id: 'ep-1', record_id: 'sub-1', now: NOW,
      ...(field_values === undefined ? {} : { field_values }),
    });

  it('the mode is supported and mints', () => {
    expect(VISITOR_LOOKUP_SUPPORTED_MODES).toContain('after_field');
    expect(mint({ event_date: '2026-02-01' })).not.toBeNull();
  });

  it('⛔ reads the field the CONFIG names, not a fixed one', () => {
    const s = store();
    const path = mintVisitorLookupPath({
      config: { enabled: true, expiry: { mode: 'after_field', field: 'when', ttl_ms: TTL } },
      store: s, endpoint_id: 'ep-1', record_id: 'sub-1', now: NOW,
      field_values: { when: '2026-03-01', event_date: '2099-01-01' },
    })!;
    const secret = path.slice(path.lastIndexOf('/') + 1);
    // Anchored on `when`, so it dies a ttl after MARCH — not after 2099, and not
    // at the default window either.
    const expected = Date.parse('2026-03-01') + TTL;
    expect(s.peek(secret, expected - 1, 'lookup').status).toBe('ok');
    expect(s.peek(secret, expected + 1, 'lookup').status).toBe('expired');
  });

  it('⚠ a fallback is LOGGED — a form whose anchor never parses looks like it works', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(mint({ event_date: 'whenever' })).not.toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('anchor field did not parse'));
    } finally {
      warn.mockRestore();
    }
  });

  it('⚠ and a GOOD anchor logs nothing — the warning must stay actionable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mint({ event_date: '2026-02-01' });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('missing field values fall back rather than throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(mint(undefined)).not.toBeNull();
      expect(mint({})).not.toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('D-240 § D6 — the BOOKING arm reaches the real request path', () => {
  it('⛔⛔ the scheduling config ACCEPTS visitor_lookup — it had no such field at all', () => {
    // Codex's finding: contracts declared `after_event` as the scheduling-only
    // mode and the mint helper claimed two callers, but `SchedulingLinkConfig`
    // had no `visitor_lookup` field and the booking handler had no credential
    // store. `after_event` was declared, unit-tested via the helper, and
    // unreachable from any real booking.
    const cfg = validateSchedulingLinkConfig({
      ...schedulingBaseline,
      visitor_receipt: { enabled: true },
      visitor_lookup: {
        enabled: true,
        expiry: { mode: 'after_event', grace_ms: VISITOR_LOOKUP_DEFAULT_GRACE_MS },
      },
    });
    expect(cfg.map((f) => f.code)).toEqual([]);
  });

  it('⛔ and REFUSES an intake-only mode on a booking — the per-kind gate reaches here', () => {
    const cfg = validateSchedulingLinkConfig({
      ...schedulingBaseline,
      visitor_receipt: { enabled: true },
      visitor_lookup: {
        enabled: true,
        expiry: { mode: 'fixed', ttl_ms: VISITOR_LOOKUP_DEFAULT_TTL_MS },
      },
    });
    expect(cfg.map((f) => f.code)).toEqual(['visitor_lookup_invalid']);
  });

  it('⚠ and the receipt cross-field rule applies on a booking too', () => {
    const cfg = validateSchedulingLinkConfig({
      ...schedulingBaseline,
      visitor_lookup: {
        enabled: true,
        expiry: { mode: 'after_event', grace_ms: VISITOR_LOOKUP_DEFAULT_GRACE_MS },
      },
    });
    expect(cfg.map((f) => f.code)).toEqual(['visitor_lookup_invalid']);
  });

  it('⚠ the booking handler PASSES the slot end — asserted at the source', () => {
    // The mint is inside an async request path with heavy fixtures; the property
    // that was missing is that the call EXISTS and anchors on the slot, so it is
    // asserted where a regression would occur.
    const src = readFileSync(
      new URL('../ports/reception/handlers/scheduling-link-book.ts', import.meta.url),
      'utf8',
    );
    expect(src).toContain('mintVisitorLookupPath');
    expect(src).toMatch(/record_kind:\s*'scheduling_link'/);
    expect(src).toMatch(/slot_end_at:\s*input\.selected_slot_end_at/);
  });
});

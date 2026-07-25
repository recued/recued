/** D-210 A.8 slice 3d-2c — the `/ask` page's edit-then-approve leg.
 *
 *  The load-bearing test in this file is the ZONE ROUND TRIP. The page
 *  renders a held instant into a `datetime-local` and parses the owner's
 *  edit straight back out; if the two halves disagree about which zone a
 *  bare wall clock belongs to, an approval moves a real appointment by the
 *  offset with nothing red and `success: true`. Everything else guards the
 *  boundary: which authority acted, which hold it may act on, and that an
 *  edit is never silently dropped. */

import { describe, expect, it, vi } from 'vitest';
import type { ArgEditField, InboxItem } from '@recued/contracts';
import type { PendingAsk } from '@recued/notification';

import {
  buildEditsFromSubmission,
  coerceSubmittedEdit,
  createAskLandingEditApproval,
} from '../ask-landing-edit-approval.js';
import {
  epochMsToZonedWallClock,
  zonedWallClockToEpochMs,
} from '../ports/reception/processors/intake-destination-mapping.js';
import { buildAskLandingDetails } from '../ask-landing-held-op-details.js';

const PARIS = 'Europe/Paris';
const SUMMER_MS = Date.UTC(2026, 6, 20, 17, 30); // 19:30 CEST
const WINTER_MS = Date.UTC(2026, 0, 20, 17, 30); // 18:30 CET

const field = (over: Partial<ArgEditField> & { key: string }): ArgEditField =>
  ({ type: 'string', ...over }) as ArgEditField;

const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  hold_id: 'cp-1',
  operation_id: 'reception-scheduling.scheduling.materialize',
  top_tier_kind: 'booking',
  source: { kind: 'scheduling_link', record_ref: 'req-1' },
  args: {},
  arg_schema: { fields: [] },
  preview: { title: 'A reservation' },
  proposed_action: 'Create a booking',
  status: 'pending',
  ...over,
});

// ────────────────────────────────────────────────────────────────
// THE ROUND TRIP — render an instant, parse it back, get the instant
// ────────────────────────────────────────────────────────────────

describe('D-210 A.8 3d-2c — datetime round trip', () => {
  it('renders and re-parses the SAME instant across zones, offsets, and DST', () => {
    const cases: ReadonlyArray<[number, string]> = [
      [SUMMER_MS, PARIS],
      [WINTER_MS, PARIS],
      [SUMMER_MS, 'UTC'],
      [SUMMER_MS, 'America/New_York'],
      [SUMMER_MS, 'Asia/Kolkata'], // half-hour offset
      [Date.UTC(2026, 10, 3, 4, 15), 'Australia/Adelaide'], // +10:30 / +9:30
    ];
    for (const [ms, tz] of cases) {
      const wall = epochMsToZonedWallClock(ms, tz);
      expect(wall, `${tz} render`).not.toBeNull();
      expect(zonedWallClockToEpochMs(wall!, tz), `${tz} round trip`).toBe(ms);
    }
  });

  it('pins the ABSOLUTE wall clocks, so a UTC-host impl cannot pass by accident', () => {
    // Asserting the epoch alone would let a naive both-sides-server-zone
    // implementation round-trip "correctly" while showing the wrong time.
    expect(epochMsToZonedWallClock(SUMMER_MS, PARIS)).toBe('2026-07-20T19:30');
    expect(epochMsToZonedWallClock(WINTER_MS, PARIS)).toBe('2026-01-20T18:30');
    expect(epochMsToZonedWallClock(SUMMER_MS, 'UTC')).toBe('2026-07-20T17:30');
    expect(epochMsToZonedWallClock(SUMMER_MS, 'Asia/Kolkata')).toBe('2026-07-20T23:00');
  });

  it('is NOT Date.parse — the same wall clock means different instants per zone', () => {
    // The failure this guards: `Date.parse('2026-07-20T19:30')` reads the
    // SERVER's zone, so a Paris booking on a UTC host lands two hours out.
    const wall = '2026-07-20T19:30';
    const paris = zonedWallClockToEpochMs(wall, PARIS);
    const utc = zonedWallClockToEpochMs(wall, 'UTC');
    expect(paris).toBe(SUMMER_MS);
    expect(utc).toBe(Date.UTC(2026, 6, 20, 19, 30));
    expect(paris).not.toBe(utc);
  });

  it('survives a non-finite instant and an unknown zone without throwing', () => {
    expect(epochMsToZonedWallClock(Number.NaN, PARIS)).toBeNull();
    expect(epochMsToZonedWallClock(SUMMER_MS, 'Not/AZone')).toBeNull();
    expect(zonedWallClockToEpochMs('2026-07-20T19:30', 'Not/AZone')).toBeNull();
  });

  it('round-trips what the RENDERED CONTROL actually carries', () => {
    // The end-to-end version: whatever `buildAskLandingDetails` put in the
    // datetime-local `value`, coercion must turn back into the held instant.
    const built = buildAskLandingDetails(
      item({
        arg_schema: { fields: [field({ key: 'start_at', type: 'datetime' })] },
        args: { start_at: SUMMER_MS },
      }),
      { timeZone: PARIS, editable: true },
    );
    const control = built.details[0]!.edit!;
    expect(control.control).toBe('datetime-local');
    expect(control.value).toBe('2026-07-20T19:30');
    const back = coerceSubmittedEdit(
      field({ key: 'start_at', type: 'datetime' }),
      control.value,
      PARIS,
    );
    expect(back).toEqual({ ok: true, value: SUMMER_MS });
  });
});

// ────────────────────────────────────────────────────────────────
// coerceSubmittedEdit — form strings → the typed values the funnel takes
// ────────────────────────────────────────────────────────────────

describe('D-210 A.8 3d-2c — coerceSubmittedEdit', () => {
  const c = (f: Partial<ArgEditField> & { key: string }, raw: string | undefined) =>
    coerceSubmittedEdit(field(f), raw, PARIS);

  it('reads an ABSENT checkbox as false and a present one as true', () => {
    // An unchecked box submits nothing — that is the browser's encoding of
    // false, not of "unspecified".
    expect(c({ key: 'notify_visitor', type: 'boolean' }, undefined)).toEqual({
      ok: true,
      value: false,
    });
    expect(c({ key: 'notify_visitor', type: 'boolean' }, 'on')).toEqual({
      ok: true,
      value: true,
    });
  });

  it('keeps a string verbatim, including surrounding whitespace', () => {
    expect(c({ key: 'body' }, '  two  spaces  ')).toEqual({
      ok: true,
      value: '  two  spaces  ',
    });
  });

  it('coerces numbers and refuses non-numbers by name', () => {
    expect(c({ key: 'seats', type: 'number' }, '4')).toEqual({ ok: true, value: 4 });
    const bad = c({ key: 'seats', type: 'number', label: 'Seats' }, 'four');
    expect(bad.ok).toBe(false);
    expect((bad as { message: string }).message).toContain('Seats');
  });

  it('names the ZONE when a datetime cannot be read', () => {
    const bad = c({ key: 'start_at', type: 'datetime', label: 'Slot start' }, 'tomorrow');
    expect(bad.ok).toBe(false);
    expect((bad as { message: string }).message).toContain('Slot start');
    expect((bad as { message: string }).message).toContain(PARIS);
  });

  it('parses json objects and refuses scalars / malformed text', () => {
    expect(c({ key: 'meta', type: 'json' }, '{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(c({ key: 'meta', type: 'json' }, '5').ok).toBe(false);
    expect(c({ key: 'meta', type: 'json' }, '{oops').ok).toBe(false);
  });

  it('clears an empty optional field and refuses an empty required one', () => {
    expect(c({ key: 'body' }, '   ')).toEqual({ ok: true, value: undefined });
    const bad = c({ key: 'title', required: true, label: 'Summary' }, '   ');
    expect(bad.ok).toBe(false);
    expect((bad as { message: string }).message).toContain('Summary');
  });
});

// ────────────────────────────────────────────────────────────────
// buildEditsFromSubmission — CHANGED fields only, unknown keys REFUSED
// ────────────────────────────────────────────────────────────────

const SCHEDULING_ITEM = item({
  arg_schema: {
    fields: [
      field({ key: 'title', label: 'Summary', required: true }),
      field({ key: 'body', label: 'Details' }),
      field({ key: 'start_at', type: 'datetime', label: 'Slot start' }),
      field({ key: 'notify_visitor', type: 'boolean', label: 'Tell the visitor' }),
    ],
  },
  args: { title: 'Table for four', body: 'Window seat', start_at: SUMMER_MS },
});

describe('D-210 A.8 3d-2c — buildEditsFromSubmission', () => {
  const build = (raw: Record<string, string>, it = SCHEDULING_ITEM) =>
    buildEditsFromSubmission(it, raw, PARIS);

  it('emits ONLY the fields the owner actually changed', () => {
    const out = build({
      title: 'Table for four',
      body: 'Window seat',
      start_at: '2026-07-20T20:00',
    });
    expect(out).toEqual({ ok: true, edits: { start_at: Date.UTC(2026, 6, 20, 18, 0) } });
  });

  it('emits nothing when an untouched form is submitted back', () => {
    // Approving an unedited form must write no overrides — the same shape
    // the webclient inbox submits.
    expect(
      build({
        title: 'Table for four',
        body: 'Window seat',
        start_at: '2026-07-20T19:30',
      }),
    ).toEqual({ ok: true, edits: {} });
  });

  it('treats an absent checkbox as false — and as a CHANGE when it was true', () => {
    const on = item({
      ...SCHEDULING_ITEM,
      args: { ...SCHEDULING_ITEM.args, notify_visitor: true },
    });
    expect(build({ title: 'Table for four' }, on)).toEqual({
      ok: true,
      edits: { notify_visitor: false },
    });
    // And ticking it from an absent prefill is equally a change.
    expect(build({ title: 'Table for four', notify_visitor: 'on' })).toEqual({
      ok: true,
      edits: { notify_visitor: true },
    });
  });

  it('REFUSES a key the schema does not declare rather than ignoring it', () => {
    // Ignoring it would let a tampered body look accepted.
    const out = build({ title: 'Table for four', hold_id: 'cp-other' });
    expect(out.ok).toBe(false);
    expect((out as { message: string }).message).toContain('hold_id');
  });

  it('leaves an options_source field alone instead of clearing it', () => {
    // The page renders no control for a picker it cannot populate, so the
    // field is absent from the body — that absence must not read as "clear".
    const withPicker = item({
      arg_schema: {
        fields: [field({ key: 'calendar_id', label: 'Calendar', options_source: 'calendars' })],
      },
      args: { calendar_id: 'cal-1' },
    });
    expect(build({}, withPicker)).toEqual({ ok: true, edits: {} });
  });

  it('propagates a coercion refusal with its owner-readable message', () => {
    const out = build({ title: 'Table for four', start_at: 'whenever' });
    expect(out.ok).toBe(false);
    expect((out as { message: string }).message).toContain('Slot start');
  });
});

// ────────────────────────────────────────────────────────────────
// createAskLandingEditApproval — the boundary
// ────────────────────────────────────────────────────────────────

const ask = (over: Partial<PendingAsk> = {}): PendingAsk => ({
  ask_id: 'ask-1',
  message: { title: 'Approve', text: 'Approve?' },
  options: [
    { id: 'approve', label: 'Approve' },
    { id: 'deny', label: 'Deny' },
  ],
  handler_kind: 'gateway.preflight',
  handler_payload: { checkpoint_id: 'cp-1' },
  fanout_channels: ['email'],
  status: 'open',
  created_at: 1,
  ...over,
});

describe('D-210 A.8 3d-2c — createAskLandingEditApproval', () => {
  const harness = (over: {
    item?: InboxItem | null;
    approveResult?: { released: boolean; reason?: string };
  } = {}) => {
    const approve = vi.fn(async () => over.approveResult ?? { released: true });
    const findHoldItem = vi.fn(async () =>
      over.item === undefined ? SCHEDULING_ITEM : over.item,
    );
    return {
      approve,
      findHoldItem,
      run: createAskLandingEditApproval({ findHoldItem, approve, timeZone: PARIS }),
    };
  };

  it('DERIVES the hold from the ask — a body can never name another hold', () => {
    // The whole security property: possession of ONE ask edits-and-approves
    // exactly the operation that ask was raised for.
    const h = harness();
    return h
      .run({ ask: ask(), option: 'approve', rawEdits: { start_at: '2026-07-20T20:00' } })
      .then((out) => {
        expect(out.ok).toBe(true);
        expect(h.findHoldItem).toHaveBeenCalledWith('cp-1');
        expect(h.approve).toHaveBeenCalledWith({
          hold_id: 'cp-1',
          ask_id: 'ask-1',
          edits: { start_at: Date.UTC(2026, 6, 20, 18, 0) },
        });
      });
  });

  it('refuses edits on any option but approve, and says why for allow_session', () => {
    const h = harness();
    return Promise.all([
      h.run({ ask: ask(), option: 'deny', rawEdits: { title: 'x' } }),
      h.run({ ask: ask(), option: 'allow_session', rawEdits: { title: 'x' } }),
    ]).then(([deny, allow]) => {
      expect(deny.ok).toBe(false);
      expect(deny.message).toContain('Approve');
      expect(allow.ok).toBe(false);
      // N.14 — an edited approval earns no standing trust.
      expect(allow.message).toContain('allowing this session');
      expect(h.approve).not.toHaveBeenCalled();
    });
  });

  it('refuses a non-preflight ask, a BATCHED ask, and a payload with no checkpoint', async () => {
    const h = harness();
    const cases: PendingAsk[] = [
      ask({ handler_kind: 'noop' }),
      ask({ handler_payload: { checkpoint_id: 'cp-1', batch_id: 'b-1' } }),
      ask({ handler_payload: {} }),
    ];
    for (const a of cases) {
      const out = await h.run({ ask: a, option: 'approve', rawEdits: { title: 'x' } });
      expect(out.ok).toBe(false);
    }
    expect(h.findHoldItem).not.toHaveBeenCalled();
    expect(h.approve).not.toHaveBeenCalled();
  });

  it('refuses when the hold is gone, without calling approve', async () => {
    const h = harness({ item: null });
    const out = await h.run({
      ask: ask(),
      option: 'approve',
      rawEdits: { title: 'Table for four' },
    });
    expect(out.ok).toBe(false);
    expect(out.message).toContain('no longer waiting');
    expect(h.approve).not.toHaveBeenCalled();
  });

  it('reports an un-released approve as a failure, never as success', async () => {
    const h = harness({ approveResult: { released: false, reason: 'not_configured' } });
    const out = await h.run({
      ask: ask(),
      option: 'approve',
      rawEdits: { start_at: '2026-07-20T20:00' },
    });
    expect(out.ok).toBe(false);
    expect(out.message).toContain('cannot release');
  });
});

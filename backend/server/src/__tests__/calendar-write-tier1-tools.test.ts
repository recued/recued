/** Slice 2 — `calendar.create` / `calendar.update`: the first Tier-1 tools that
 *  deliberately STOP and ask.
 *
 *  ⛔ THE POINT OF THIS SLICE IS THE ASYMMETRY WITH SLICE 1, so the test that
 *  matters most is the classification one below. `work.create` is
 *  `classification: 'unknown'` and runs straight through: an approval card
 *  between "add a task" and a task is the whole cost of that feature. These two
 *  are `'write'`, which `requiresPlanApproval` gates UNCONDITIONALLY, because
 *  moving or cancelling an event changes something the owner already relied on
 *  and deleting a row afterwards does not un-tell the people who saw it move.
 *
 *  If a later edit "harmonises" the two tiers to one classification, the feature
 *  either becomes unusable (task creates behind cards) or unsafe (silent
 *  reschedules). The first describe block is what notices.
 */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { ExecutionSource } from '@recued/contracts';
import {
  TIER1_CLASSIFICATIONS,
  TIER1_CONCURRENCY_SAFE,
  TIER1_TOOL_DESCRIPTORS,
  TIER1_TOOL_NAMES,
} from '@recued/contracts';
// The orchestrator reaches it the same way (`planApproval as planApprovalModule`).
import { planApproval } from '@recued/gateway';
import { buildChatTier1Handlers, buildChatToolRegistryInputs, calendarAskLabels } from '../chat-tool-handlers.js';
import { calendarEventApprovalLabel, heldCalendarValueLabels } from '../held-calendar-labels.js';
import {
  checkCalendarCreate, checkCalendarUpdate, defaultCalendarFor, handleCalendarDelete, handleCalendarUpdate,
} from '../collections/calendar/calendar-dispatcher.js';
import { createCalendarTable } from '../collections/calendar/calendar-table.js';
import type { ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { createReadGrantChecker } from '../read-grant-checker.js';

const ownerSource: ExecutionSource = {
  channel: 'messenger',
  actor: 'user_self',
  vendor: 'telegram',
  from: '12345',
};
const ctx = (source: ExecutionSource = ownerSource) =>
  ({ execution_source: source, session_id: 'sess-1' }) as never;

const deps = (opts: { granted?: readonly string[]; wired?: boolean; readGranted?: boolean } = {}) => {
  const create = vi.fn(async () => ({ source_id: 'evt-1', ical_uid: 'uid-1' }));
  const update = vi.fn(async () => ({ source_id: 'evt-1' }));
  const granted = opts.granted ?? ['core.data.calendar.create', 'core.data.calendar.update'];
  return {
    __create: create,
    __update: update,
    getReadGrantResolver: () => ({
      resolveForSource: () => createReadGrantChecker({
        isGranted: () => opts.readGranted ?? true,
      }, 'calendar-test-contract'),
    }),
    getCalendarWriteDeps: () =>
      opts.wired === false ? undefined : ({ calendarCreate: create, calendarUpdate: update } as never),
    getOpAdmissionGate: () => ({
      isFrozenByPause: () => false,
      isOpGranted: (_s: ExecutionSource, opId: string | undefined) =>
        opId !== undefined && granted.includes(opId),
    }),
  } as unknown as ChatToolHandlerDeps & {
    __create: ReturnType<typeof vi.fn>;
    __update: ReturnType<typeof vi.fn>;
  };
};

describe('the write tier gates — and since D-329 the create tier does too', () => {
  it('both calendar writes require plan approval, and so does work.create (D-329)', () => {
    // Driven through the REAL predicate, not by asserting the classification
    // string: the string is an input to a decision, and the decision is the
    // thing that must not drift.
    expect(planApproval.requiresPlanApproval({ ...TIER1_TOOL_DESCRIPTORS['calendar.create'], tier: 1 })).toBe(true);
    expect(planApproval.requiresPlanApproval({ ...TIER1_TOOL_DESCRIPTORS['calendar.update'], tier: 1 })).toBe(true);
    // D-329 — the owner: "work.create can be auto after 3 approval so it is not that bad to
    // be a write". Approving it anywhere runs it, and repeats teach a standing rule.
    expect(planApproval.requiresPlanApproval({ ...TIER1_TOOL_DESCRIPTORS['work.create'], tier: 1 })).toBe(true);

    expect(TIER1_CLASSIFICATIONS['calendar.create']).toBe('write');
    expect(TIER1_CLASSIFICATIONS['calendar.update']).toBe('write');
  });

  it('calendar.update is never batched in parallel', () => {
    // Two updates to ONE event in a turn ("move it to Thursday and make it an
    // hour") would race on the same source_id and the provider's last write
    // silently wins. Create mints a new id, so it stays batchable.
    expect(TIER1_CONCURRENCY_SAFE['calendar.update']).toBe(false);
    expect(TIER1_CONCURRENCY_SAFE['calendar.create']).toBe(true);
  });
});

describe('calendar.create — refusals happen BEFORE the provider is touched', () => {
  it.each([true, false])('keeps write admission independent of a revoked collection read grant: write granted=%s', async granted => {
    const d = deps({ readGranted: false, granted: granted ? ['core.data.calendar.create'] : [] });
    const handlers = buildChatTier1Handlers(d);
    const result = await handlers['calendar.create']!({
      summary: 'Dentist', start_at: 1_000, end_at: 2_000, timezone: 'Europe/Dublin',
    }, ctx());
    expect(result.ok).toBe(granted);
    expect(d.__create).toHaveBeenCalledTimes(granted ? 1 : 0);
    if (!granted) expect(result).toMatchObject({ reason: 'classification_blocked' });
    const search = await handlers['calendar.search']!({}, ctx());
    expect(search).toMatchObject({ ok: true, result: { matches: [], hint: expect.any(String) } });
  });
  it('refuses an inverted window rather than letting the provider render nothing', async () => {
    const d = deps();
    const h = buildChatTier1Handlers(d);
    const res = await h['calendar.create']!(
      { summary: 'Dentist', start_at: 2_000, end_at: 1_000, timezone: 'Europe/Dublin' },
      ctx(),
    );
    expect(res.ok).toBe(false);
    expect((res as { detail: string }).detail).toMatch(/after start_at/i);
    expect(d.__create).not.toHaveBeenCalled();
  });

  it('refuses a missing timezone instead of quietly meaning UTC', async () => {
    // ⚠ The silent-UTC default is the defect this guards: "3pm" booked in the
    // wrong zone looks correct in the tool result and wrong on the phone.
    const d = deps();
    const h = buildChatTier1Handlers(d);
    const res = await h['calendar.create']!(
      { summary: 'Dentist', start_at: 1_000, end_at: 2_000 },
      ctx(),
    );
    expect(res.ok).toBe(false);
    expect((res as { detail: string }).detail).toMatch(/timezone/i);
    expect(d.__create).not.toHaveBeenCalled();
  });

  it('refuses when the op is not granted, before dispatching', async () => {
    const d = deps({ granted: [] });
    const h = buildChatTier1Handlers(d);
    const res = await h['calendar.create']!(
      { summary: 'X', start_at: 1_000, end_at: 2_000, timezone: 'UTC' },
      ctx(),
    );
    expect((res as { reason: string }).reason).toBe('classification_blocked');
    expect(d.__create).not.toHaveBeenCalled();
  });

  it('writes to the LOCAL calendar when none is named — the zero-config path', async () => {
    const d = deps();
    const h = buildChatTier1Handlers(d);
    const res = await h['calendar.create']!(
      { summary: 'Dentist', start_at: 1_000, end_at: 2_000, timezone: 'Europe/Dublin' },
      ctx(),
    );
    expect(res.ok).toBe(true);
    expect(d.__create).toHaveBeenCalledTimes(1);
    expect(d.__create.mock.calls[0]![0]).toMatchObject({ slug: 'local' });
  });
});

describe('calendar.update — a patch, and never an empty one', () => {
  it.each([true, false])('keeps update admission independent of a revoked collection read grant: write granted=%s', async granted => {
    const d = deps({ readGranted: false, granted: granted ? ['core.data.calendar.update'] : [] });
    const result = await buildChatTier1Handlers(d)['calendar.update']!({
      source_id: 'evt-1', summary: 'Moved',
    }, ctx());
    expect(result.ok).toBe(granted);
    expect(d.__update).toHaveBeenCalledTimes(granted ? 1 : 0);
    if (!granted) expect(result).toMatchObject({ reason: 'classification_blocked' });
  });
  it('refuses an empty patch rather than burning an approval on a no-op', async () => {
    // 🔑 The sharpest one. An empty patch would pass the owner's approval card,
    // dispatch, change nothing, and report success — an approval spent on
    // nothing, which teaches the owner the card is noise.
    const d = deps();
    const h = buildChatTier1Handlers(d);
    const res = await h['calendar.update']!({ source_id: 'evt-1' }, ctx());
    expect(res.ok).toBe(false);
    expect((res as { detail: string }).detail).toMatch(/at least one field/i);
    expect(d.__update).not.toHaveBeenCalled();
  });

  it('requires a source_id — never guesses which event was meant', async () => {
    const d = deps();
    const h = buildChatTier1Handlers(d);
    const res = await h['calendar.update']!({ summary: 'Moved' }, ctx());
    expect(res.ok).toBe(false);
    expect((res as { detail: string }).detail).toMatch(/source_id/i);
    expect(d.__update).not.toHaveBeenCalled();
  });

  it('sends ONLY the fields given, so an omitted field keeps its value', async () => {
    const d = deps();
    const h = buildChatTier1Handlers(d);
    const res = await h['calendar.update']!(
      { source_id: 'evt-1', start_at: 5_000, end_at: 9_000, timezone: 'Europe/Dublin' },
      ctx(),
    );
    expect(res.ok).toBe(true);
    const patch = (d.__update.mock.calls[0]![0] as { patch: Record<string, unknown> }).patch;
    expect(Object.keys(patch).sort()).toEqual(['end_at', 'start_at', 'timezone']);
    expect(patch).not.toHaveProperty('summary');
    expect(patch).not.toHaveProperty('status');
  });

  it('cancels by status without deleting the record', async () => {
    const d = deps();
    const h = buildChatTier1Handlers(d);
    const res = await h['calendar.update']!(
      { source_id: 'evt-1', status: 'cancelled' },
      ctx(),
    );
    expect(res.ok).toBe(true);
    expect((d.__update.mock.calls[0]![0] as { patch: { status: string } }).patch.status)
      .toBe('cancelled');
  });

  it('refuses when the update op is not granted', async () => {
    const d = deps({ granted: ['core.data.calendar.create'] }); // create only
    const h = buildChatTier1Handlers(d);
    const res = await h['calendar.update']!({ source_id: 'evt-1', summary: 'X' }, ctx());
    expect((res as { reason: string }).reason).toBe('classification_blocked');
    expect(d.__update).not.toHaveBeenCalled();
  });

  it('reports execution_error when the calendar stack is not wired', async () => {
    const h = buildChatTier1Handlers(deps({ wired: false }));
    const res = await h['calendar.update']!({ source_id: 'evt-1', summary: 'X' }, ctx());
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).not.toBe('classification_blocked');
  });
});

describe('calendar.update — the event its ask names (D-329, 2026-10-25)', () => {
  it('names the event by its title and when it is on the turn\'s clock, never by its id', async () => {
    const db = new Database(':memory:');
    const table = createCalendarTable({ db, slug: 'local' });
    const start = Date.UTC(2026, 9, 27, 14);
    table.upsert({ size_bytes: 0, event: { source_id: 'evt-1', ical_uid: 'uid-1', calendar_id: 'local', summary: 'Dentist',
      start_at: start, end_at: start + 3_600_000, timezone: 'UTC', is_all_day: false, status: 'confirmed',
      created_at: start, updated_at: start } } as never);
    const withCalendar = { ...deps(), getCollectionRegistry: () => ({ list: () => [{ slug: 'local', platform: 'calendar', table }] }) } as never;
    const named = await calendarAskLabels(withCalendar, { source_id: 'evt-1', start_at: start + 86_400_000 },
      { execution_source: ownerSource, time_zone: 'Europe/Dublin' } as never);
    expect(named).toEqual({ source_id: { 'evt-1': expect.stringMatching(/^Dentist, .+\(UTC\+00:00\)$/u) } });
    // The MCP wire keeps no clock: the title alone.
    expect(await calendarAskLabels(withCalendar, { source_id: 'evt-1' }, { channel: 'mcp_wire', mcp_token_id: 't' } as never))
      .toEqual({ source_id: { 'evt-1': 'Dentist' } });
    // Another calendar's event, or none: the id is shown.
    expect(await calendarAskLabels(withCalendar, { source_id: 'evt-1', calendar_id: 'google-work' }, ctx())).toBeUndefined();
    expect(await calendarAskLabels(withCalendar, { source_id: 'evt-9' }, ctx())).toBeUndefined();
    db.close();
  });
});

describe('D-329 — a calendar write is checked before the owner is asked', () => {
  it('⛔ every held Tier-1 write has a check of its own', () => {
    // A held write with no check is put to the owner and refused only after the yes.
    const held = TIER1_TOOL_NAMES.filter((name) => TIER1_CLASSIFICATIONS[name] === 'write');
    expect(Object.keys(buildChatToolRegistryInputs(deps()).tier1Checks).sort()).toEqual([...held].sort());
  });

  const START = Date.UTC(2026, 9, 27, 14);
  /** A real calendar table behind the dispatcher's own checks: an instance that may
   *  create and update events, and one that may only read. */
  const calendars = () => {
    const db = new Database(':memory:');
    const table = createCalendarTable({ db, slug: 'local' });
    table.upsert({ size_bytes: 0, event: { source_id: 'evt-1', ical_uid: 'uid-1', calendar_id: 'local', summary: 'Dentist',
      start_at: START, end_at: START + 3_600_000, timezone: 'UTC', is_all_day: false, status: 'confirmed',
      created_at: START, updated_at: START } } as never);
    const caps = { local: { create_event: 'yes', update_event: 'yes' }, readonly: { create_event: 'no', update_event: 'no' } };
    const updateEvent = vi.fn();
    const deps = {
      instances: { get: (_platform: string, slug: string) => (slug in caps
        ? { caps: caps[slug as keyof typeof caps], adapter_type: 'local', auth_state: 'healthy' } : null) },
      getCollection: (slug: string) => (slug in caps ? { table, provider: { kind: 'local', updateEvent } } : undefined),
    } as never;
    return { db, deps, updateEvent };
  };

  it('the dispatcher refuses an unknown event, a read-only calendar, and an event that would end before it starts', () => {
    const { db, deps } = calendars();
    expect(() => checkCalendarUpdate(deps, { slug: 'local', source_id: 'evt-9', patch: { summary: 'x' } })).toThrow('CALENDAR_EVENT_NOT_FOUND');
    expect(() => checkCalendarUpdate(deps, { slug: 'readonly', source_id: 'evt-1', patch: {} })).toThrow('CALENDAR_CAPABILITY_DENIED');
    expect(() => checkCalendarCreate(deps, { slug: 'readonly' })).toThrow('CALENDAR_CAPABILITY_DENIED');
    expect(() => checkCalendarCreate(deps, { slug: 'google-work' })).toThrow('CALENDAR_INSTANCE_NOT_FOUND');
    // Moved past its old end, with no new end.
    expect(() => checkCalendarUpdate(deps, { slug: 'local', source_id: 'evt-1', patch: { start_at: START + 7_200_000 } }))
      .toThrow('CALENDAR_EVENT_ENDS_BEFORE_IT_STARTS');
    expect(() => checkCalendarUpdate(deps, { slug: 'local', source_id: 'evt-1',
      patch: { start_at: START + 7_200_000, end_at: START + 10_800_000 } })).not.toThrow();
    db.close();
  });

  it('the write runs the same check, so it refuses what the check refuses before calling the calendar', async () => {
    const { db, deps, updateEvent } = calendars();
    await expect(handleCalendarUpdate(deps, { slug: 'local', source_id: 'evt-1', patch: { start_at: START + 7_200_000 } }))
      .rejects.toThrow('CALENDAR_EVENT_ENDS_BEFORE_IT_STARTS');
    expect(updateEvent).not.toHaveBeenCalled();
    db.close();
  });

  it('the chat\'s check answers with those refusals, and with the arguments\' own, before any write', async () => {
    const d = deps();
    const withChecks = { ...d, getCalendarWriteDeps: () => ({
      calendarCreate: d.__create, calendarUpdate: d.__update,
      checkCalendarCreate: (input: { slug: string }) => { if (input.slug !== 'local') throw new Error(`CALENDAR_INSTANCE_NOT_FOUND: no calendar instance '${input.slug}'`); },
      checkCalendarUpdate: (input: { source_id: string }) => { if (input.source_id !== 'evt-1') throw new Error(`CALENDAR_EVENT_NOT_FOUND: '${input.source_id}'`); },
    }) } as never;
    const checks = buildChatToolRegistryInputs(withChecks).tier1Checks;
    const event = { summary: 'Dentist', start_at: START, end_at: START + 3_600_000, timezone: 'Europe/Dublin' };
    expect(await checks['calendar.create']!(event, ctx())).toBeNull();
    expect(await checks['calendar.create']!({ ...event, calendar_id: 'google-work' }, ctx()))
      .toMatchObject({ ok: false, reason: 'invalid_args', detail: expect.stringContaining('CALENDAR_INSTANCE_NOT_FOUND') });
    expect(await checks['calendar.create']!({ ...event, end_at: START }, ctx()))
      .toMatchObject({ ok: false, detail: 'calendar.create: end_at must be after start_at' });
    expect(await checks['calendar.update']!({ source_id: 'evt-1', summary: 'Dentist (moved)' }, ctx())).toBeNull();
    expect(await checks['calendar.update']!({ source_id: 'evt-9', summary: 'x' }, ctx()))
      .toMatchObject({ ok: false, detail: expect.stringContaining('CALENDAR_EVENT_NOT_FOUND') });
    expect(d.__create).not.toHaveBeenCalled();
    expect(d.__update).not.toHaveBeenCalled();
  });
});

describe('D-336 (spec §48) — a create on an account goes on its main calendar', () => {
  /** An instance per account, its calendars as its provider lists them; `readonly` may not
   *  create events. */
  const accounts = (calendars: Record<string, ReadonlyArray<{ calendar_id: string; name: string; is_default?: true }>>) => {
    const known = (slug: string) => slug in calendars || slug === 'readonly';
    return {
      instances: { get: (_platform: string, slug: string) => (known(slug)
        ? { caps: { create_event: slug === 'readonly' ? 'no' : 'yes' }, adapter_type: 'gcal', auth_state: 'healthy' } : null) },
      getCollection: (slug: string) => (known(slug)
        ? { provider: { kind: 'gcal', listWritableCalendars: async () => calendars[slug] ?? [] } } : undefined),
    } as never;
  };

  it('the main calendar, else the only writable one; several with no main one, or none, are refused', async () => {
    const deps = accounts({
      google: [{ calendar_id: 'team', name: 'Team' }, { calendar_id: 'me@example.com', name: 'Me', is_default: true }],
      caldav: [{ calendar_id: 'home', name: 'Home' }],
      shared: [{ calendar_id: 'home', name: 'Home' }, { calendar_id: 'work', name: 'Work' }],
      empty: [],
    });
    expect(await defaultCalendarFor(deps, { slug: 'google' })).toBe('me@example.com');
    expect(await defaultCalendarFor(deps, { slug: 'caldav' })).toBe('home');
    await expect(defaultCalendarFor(deps, { slug: 'shared' })).rejects.toThrow(
      'CALENDAR_NO_MAIN_CALENDAR: \'shared\' has 2 calendars ("Home", "Work") and none is its main one, '
        + 'so an event cannot go on it from here. Tell the user they can add it with New event in Data → Calendar, where they choose the calendar');
    await expect(defaultCalendarFor(deps, { slug: 'empty' })).rejects.toThrow('CALENDAR_NO_WRITABLE_CALENDAR');
    await expect(defaultCalendarFor(deps, { slug: 'readonly' })).rejects.toThrow('CALENDAR_CAPABILITY_DENIED');
  });

  it("⛔ the chat's create puts the event there, and its check refuses an account with no main one before the owner is asked", async () => {
    // Asked of every account, `local` was found only on the local one: on Google it was "not found".
    const d = deps();
    const defaultCalendar = vi.fn(async ({ slug }: { slug: string }) => {
      if (slug === 'shared') throw new Error("CALENDAR_NO_MAIN_CALENDAR: 'shared' has 2 calendars");
      return slug === 'google' ? 'me@example.com' : 'local';
    });
    const wired = { ...d, getCalendarWriteDeps: () => ({ calendarCreate: d.__create, calendarUpdate: d.__update, defaultCalendar }) } as never;
    const event = { summary: 'Dentist', start_at: 1_000, end_at: 2_000, timezone: 'Europe/Dublin' };
    expect((await buildChatTier1Handlers(wired)['calendar.create']!({ ...event, calendar_id: 'google' }, ctx())).ok).toBe(true);
    expect(d.__create.mock.calls[0]![0]).toMatchObject({
      slug: 'google', calendar_id: 'me@example.com', event: { calendar_id: 'me@example.com' },
    });
    const checks = buildChatToolRegistryInputs(wired).tier1Checks;
    expect(await checks['calendar.create']!({ ...event, calendar_id: 'google' }, ctx())).toBeNull();
    expect(await checks['calendar.create']!({ ...event, calendar_id: 'shared' }, ctx()))
      .toMatchObject({ ok: false, reason: 'invalid_args', detail: expect.stringContaining('CALENDAR_NO_MAIN_CALENDAR') });
    expect(d.__create).toHaveBeenCalledTimes(1);
  });
});

describe("D-336 (spec §48) — an AI's or a recipe's change to an event with guests tells them", () => {
  const START = Date.UTC(2026, 9, 27, 14);
  /** A Google account holding one event, with `attendees` if given, behind the real dispatcher. */
  const google = (attendees?: ReadonlyArray<{ email: string; response_status: string; is_self?: true }>) => {
    const db = new Database(':memory:');
    const table = createCalendarTable({ db, slug: 'google' });
    table.upsert({ size_bytes: 0, event: { source_id: 'evt-1', ical_uid: 'uid-1', calendar_id: 'me@example.com', summary: 'Review',
      start_at: START, end_at: START + 3_600_000, timezone: 'UTC', is_all_day: false, status: 'confirmed',
      ...(attendees !== undefined ? { attendees } : {}), created_at: START, updated_at: START } } as never);
    const updateEvent = vi.fn(async (_input: Record<string, unknown>) => ({ event: { source_id: 'evt-1' } }));
    const deleteEvent = vi.fn(async (_input: Record<string, unknown>) => undefined);
    const createEvent = vi.fn(async (_calendar: string, _event: Record<string, unknown>) => ({ event: { source_id: 'evt-2' } }));
    const collection = {
      table, provider: { kind: 'gcal', updateEvent, deleteEvent, createEvent },
      applyVerifiedUpsert: vi.fn(async () => undefined), applyVerifiedDelete: vi.fn(),
    };
    const deps = {
      instances: { get: () => ({ caps: { update_event: 'yes', delete_event: 'yes' }, adapter_type: 'gcal', auth_state: 'healthy' }) },
      getCollection: (slug: string) => (slug === 'google' ? collection : undefined),
    } as never;
    return { db, deps, table, updateEvent, deleteEvent, createEvent };
  };
  const moved = { start_at: START + 3_600_000, end_at: START + 7_200_000 };

  it("moved or cancelled, Google is asked to tell its guests, as the owner's own edit asks; with none, it is not", async () => {
    const withGuests = google([{ email: 'ana@example.com', response_status: 'accepted' }]);
    await handleCalendarUpdate(withGuests.deps, { slug: 'google', source_id: 'evt-1', patch: moved });
    expect(withGuests.updateEvent.mock.calls[0]![0]).toMatchObject({ notify_attendees: true });
    await handleCalendarDelete(withGuests.deps, { slug: 'google', source_id: 'evt-1' });
    expect(withGuests.deleteEvent.mock.calls[0]![0]).toMatchObject({ notify_attendees: true });
    const alone = google();
    await handleCalendarUpdate(alone.deps, { slug: 'google', source_id: 'evt-1', patch: moved });
    expect(alone.updateEvent.mock.calls[0]![0]).not.toHaveProperty('notify_attendees');
    await handleCalendarDelete(alone.deps, { slug: 'google', source_id: 'evt-1' });
    expect(alone.deleteEvent.mock.calls[0]![0]).not.toHaveProperty('notify_attendees');
    withGuests.db.close();
    alone.db.close();
  });

  it('a series moved from one event on is told too: the old one ends for its guests, and the new one invites them', async () => {
    const withGuests = google([{ email: 'ana@example.com', response_status: 'accepted' }]);
    await handleCalendarUpdate(withGuests.deps, { slug: 'google', source_id: 'evt-1', patch: moved, scope: 'this_and_future' });
    expect(withGuests.updateEvent.mock.calls[0]![0]).toMatchObject({ scope: 'series', notify_attendees: true });
    expect(withGuests.createEvent.mock.calls[0]![1]).toMatchObject({ send_invitations: true });
    const alone = google();
    await handleCalendarUpdate(alone.deps, { slug: 'google', source_id: 'evt-1', patch: moved, scope: 'this_and_future' });
    expect(alone.updateEvent.mock.calls[0]![0]).not.toHaveProperty('notify_attendees');
    expect(alone.createEvent.mock.calls[0]![1]).not.toHaveProperty('send_invitations');
    withGuests.db.close();
    alone.db.close();
  });

  it("the owner's ask says Google emails them: on a Google event with guests, never the owner's own place on it", async () => {
    const wire = { channel: 'mcp_wire', mcp_token_id: 't' } as never;
    const labelOf = async (kind: string, attendees?: ReadonlyArray<{ email: string; response_status: string; is_self?: true }>) => {
      const { db, table } = google(attendees);
      const registry = { ...deps(), getCollectionRegistry: () => ({ list: () => [{ slug: 'google', platform: 'calendar', table, provider: { kind } }] }) } as never;
      try {
        return (await calendarAskLabels(registry, { source_id: 'evt-1', calendar_id: 'google' }, wire))?.source_id?.['evt-1'];
      } finally { db.close(); }
    };
    const me = { email: 'me@example.com', response_status: 'accepted', is_self: true as const };
    const ana = { email: 'ana@example.com', response_status: 'accepted' };
    const bo = { email: 'bo@example.com', response_status: 'needs_action' };
    expect(await labelOf('gcal', [me, ana, bo])).toBe('Review (Google emails its 2 guests)');
    expect(await labelOf('gcal', [me, ana])).toBe('Review (Google emails its guest)');
    expect(await labelOf('gcal', [me])).toBe('Review');
    expect(await labelOf('gcal')).toBe('Review');
    // Outlook tells its guests itself; a local event has no one to tell.
    expect(await labelOf('graph', [me, ana])).toBe('Review');
    expect(await labelOf('local', [me, ana])).toBe('Review');
  });

  it("D-336 (spec §52) — a recipe's held move or cancel says so on its approval too", () => {
    const { db, table } = google([{ email: 'ana@example.com', response_status: 'accepted' }]);
    const registry = { list: () => [{ slug: 'google', platform: 'calendar', table, provider: { kind: 'gcal' } }] } as never;
    const nameOf = (slug: string, source_id: string) => calendarEventApprovalLabel(registry, slug, source_id, 'UTC');
    try {
      for (const step of ['calendar-update', 'calendar-delete', 'recued/calendar-update']) {
        expect(heldCalendarValueLabels(step, { slug: 'google', source_id: 'evt-1', patch: moved }, nameOf))
          .toEqual({ source_id: { 'evt-1': expect.stringMatching(/^Review, .+ \(Google emails its guest\)$/) } });
      }
      // Any other step, an event or calendar not known, an input without both: no label.
      expect(heldCalendarValueLabels('mail-send', { slug: 'google', source_id: 'evt-1' }, nameOf)).toBeUndefined();
      expect(heldCalendarValueLabels('calendar-update', { slug: 'google', source_id: 'evt-9' }, nameOf)).toBeUndefined();
      expect(heldCalendarValueLabels('calendar-update', { slug: 'work', source_id: 'evt-1' }, nameOf)).toBeUndefined();
      expect(heldCalendarValueLabels('calendar-update', { source_id: 'evt-1' }, nameOf)).toBeUndefined();
      // A calendar that cannot answer costs the label, never the hold.
      expect(heldCalendarValueLabels('calendar-update', { slug: 'google', source_id: 'evt-1' }, () => { throw new Error('closed'); }))
        .toBeUndefined();
    } finally { db.close(); }
  });
});

describe("D-336 (spec §56) — chat cancels an Outlook event by deleting it, and says so", () => {
  it('a cancel on Outlook deletes the event through the real dispatcher, and the result says it is gone', async () => {
    const START = Date.UTC(2026, 10, 3, 23);
    const db = new Database(':memory:');
    const table = createCalendarTable({ db, slug: 'outlook' });
    table.upsert({ size_bytes: 0, event: { source_id: 'evt-1', ical_uid: 'uid-1', calendar_id: 'cal-main', summary: 'Recued 5c check',
      start_at: START, end_at: START + 1_800_000, timezone: 'UTC', is_all_day: false, status: 'confirmed',
      created_at: START, updated_at: START } } as never);
    const updateEvent = vi.fn(async () => { throw new Error('a cancel is not an update on Outlook'); });
    const deleteEvent = vi.fn(async (_input: Record<string, unknown>) => undefined);
    const collection = {
      table, provider: { kind: 'graph', updateEvent, deleteEvent, createEvent: vi.fn() },
      applyVerifiedUpsert: vi.fn(async () => undefined), applyVerifiedDelete: vi.fn(),
    };
    const dispatch = {
      instances: { get: () => ({ caps: { update_event: 'yes', delete_event: 'yes' }, adapter_type: 'graph', auth_state: 'healthy' }) },
      getCollection: (slug: string) => (slug === 'outlook' ? collection : undefined),
    } as never;
    const d = deps();
    const wired = { ...d, getCalendarWriteDeps: () => ({
      calendarCreate: d.__create,
      calendarUpdate: (input: never) => handleCalendarUpdate(dispatch, input),
    }) } as never;
    try {
      const result = await buildChatTier1Handlers(wired)['calendar.update']!(
        { source_id: 'evt-1', calendar_id: 'outlook', status: 'cancelled' }, ctx(),
      );
      expect(result).toEqual({
        ok: true,
        result: {
          cancelled: true, deleted: true, source_id: 'evt-1', calendar: 'outlook',
          note: 'Outlook keeps no cancelled events, so it was deleted. If the user organized it, '
            + 'Outlook sends its guests a cancellation.',
        },
      });
      expect(updateEvent).not.toHaveBeenCalled();
      expect(deleteEvent.mock.calls[0]![0]).toMatchObject({ calendar_id: 'cal-main', source_id: 'evt-1' });
      expect(collection.applyVerifiedDelete).toHaveBeenCalledWith('evt-1', undefined);
    } finally { db.close(); }
  });
});

describe('D-336 (spec §56) — chat changes an event by the id its search shows', () => {
  it("calendar.search returns each event's source_id, and calendar.update also takes its record_id, on the event's own calendar", async () => {
    const START = Date.UTC(2026, 10, 4);
    const db = new Database(':memory:');
    const table = createCalendarTable({ db, slug: 'outlook' });
    table.upsert({ size_bytes: 0, event: { source_id: 'AAMk-outlook-1', ical_uid: 'uid-1', calendar_id: 'cal-main', summary: 'Recued 56 chat',
      start_at: START, end_at: START + 1_800_000, timezone: 'UTC', is_all_day: false, status: 'confirmed',
      created_at: START, updated_at: START } } as never);
    const deleteEvent = vi.fn(async (_input: Record<string, unknown>) => undefined);
    const collection = {
      platform: 'calendar', slug: 'outlook', table,
      provider: { kind: 'graph', updateEvent: vi.fn(), deleteEvent, createEvent: vi.fn() },
      applyVerifiedUpsert: vi.fn(async () => undefined), applyVerifiedDelete: vi.fn(),
    };
    const dispatch = {
      instances: { get: () => ({ caps: { update_event: 'yes', delete_event: 'yes' }, adapter_type: 'graph', auth_state: 'healthy' }) },
      getCollection: (slug: string) => (slug === 'outlook' ? collection : undefined),
    } as never;
    const d = deps();
    const wired = {
      ...d,
      getCollectionRegistry: () => ({ list: () => [collection] }),
      getCalendarWriteDeps: () => ({
        calendarCreate: d.__create,
        calendarUpdate: (input: never) => handleCalendarUpdate(dispatch, input),
      }),
    } as never;
    try {
      const handlers = buildChatTier1Handlers(wired);
      const found = await handlers['calendar.search']!({ query: 'Recued 56' }, ctx());
      expect(found.ok).toBe(true);
      const [match] = (found as { result: { matches: Array<Record<string, unknown>> } }).result.matches;
      expect(match).toMatchObject({ collection_slug: 'outlook', source_id: 'AAMk-outlook-1', record_id: expect.stringMatching(/^cal:/) });

      // Live, the model passed the record_id as `source_id`, naming no calendar (§54, §56).
      // Its approval names the event, as for its source_id.
      const labels = await calendarAskLabels(wired, { source_id: match!.record_id, status: 'cancelled' }, ctx());
      expect(labels?.source_id?.[match!.record_id as string]).toEqual(expect.stringContaining('Recued 56 chat'));
      const res = await handlers['calendar.update']!({ source_id: match!.record_id, status: 'cancelled' }, ctx());
      expect(res).toMatchObject({ ok: true, result: { deleted: true, source_id: 'AAMk-outlook-1', calendar: 'outlook' } });
      expect(deleteEvent.mock.calls[0]![0]).toMatchObject({ source_id: 'AAMk-outlook-1', calendar_id: 'cal-main' });

      // An id no calendar holds is still refused as not found, naming it.
      const unknown = await handlers['calendar.update']!({ source_id: 'cal:nope', calendar_id: 'outlook', status: 'cancelled' }, ctx());
      expect(unknown).toMatchObject({ ok: false, detail: expect.stringContaining("CALENDAR_EVENT_NOT_FOUND: 'cal:nope'") });
      expect(deleteEvent).toHaveBeenCalledTimes(1);
    } finally { db.close(); }
  });
});


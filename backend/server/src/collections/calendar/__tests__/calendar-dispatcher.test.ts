/** D-117 Phase 6 — calendar dispatcher tests.
 *
 *  Covers all 8 handlers + the cap / instance / auth gate plus the
 *  `scope='this_and_future'` two-call expansion.
 *
 *  No live network or DB — fakes for the instance-store, the
 *  CalendarCollection (table + provider), and the provider's
 *  `createEvent` / `updateEvent` / `deleteEvent` / `rsvpEvent`. The
 *  point of this suite is the dispatcher logic, not the storage path.
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CalendarAdapterError,
  type CalendarCollectionCaps,
  type CanonicalEvent,
  type CollectionInstanceRow,
  RpcError,
} from '@recued/contracts';

import {
  createInstanceStore,
  type CollectionInstanceStore,
} from '../../instance-store.js';
import {
  handleCalendarCreate,
  handleCalendarDelete,
  handleCalendarGet,
  handleCalendarList,
  handleCalendarRsvp,
  handleCalendarSearch,
  handleCalendarStat,
  handleCalendarUpdate,
  type CalendarDispatcherDeps,
} from '../calendar-dispatcher.js';
import type { CalendarCollection } from '../calendar-collection.js';
import { createCalendarTable } from '../calendar-table.js';
import {
  createLocalCalendarProvider,
  LOCAL_CALENDAR_CAPS,
} from '../local-provider.js';
import type {
  CalendarProvider,
  CreateEventInput,
  DeleteEventInput,
  ProviderEventPayload,
  RsvpEventInput,
  UpdateEventInput,
} from '../provider.js';

const FULL_CAPS: CalendarCollectionCaps = {
  read: 'yes',
  list_calendars: 'yes',
  create_event: 'yes',
  update_event: 'yes',
  delete_event: 'yes',
  rsvp: 'yes',
  search: 'remote',
  watch: 'poll',
  auth: 'oauth',
  recurrence: 'server',
};

const READ_ONLY_CAPS: CalendarCollectionCaps = {
  ...FULL_CAPS,
  create_event: 'no',
  update_event: 'no',
  delete_event: 'no',
  rsvp: 'no',
  search: 'none',
};

const baseEvent = (overrides: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
  source_id: 'evt-1',
  ical_uid: 'uid-1@example',
  calendar_id: 'cal-1',
  summary: 'Standup',
  start_at: 1_700_000_000_000,
  end_at: 1_700_000_900_000,
  timezone: 'America/New_York',
  is_all_day: false,
  status: 'confirmed',
  attendees: [{ email: 'me@example.com', is_self: true, response_status: 'needs_action' }],
  created_at: 1_699_000_000_000,
  updated_at: 1_700_000_000_000,
  ...overrides,
});

interface ProviderCalls {
  create: Array<{ calendar_id: string; event: CreateEventInput }>;
  update: UpdateEventInput[];
  delete: DeleteEventInput[];
  rsvp: RsvpEventInput[];
}

const makeProvider = (
  kind: 'gcal' | 'graph' | 'caldav' = 'gcal',
  override: Partial<CalendarProvider> = {},
): { provider: CalendarProvider; calls: ProviderCalls; nextEvent: () => CanonicalEvent } => {
  const calls: ProviderCalls = { create: [], update: [], delete: [], rsvp: [] };
  let counter = 0;
  const nextEvent = (): CanonicalEvent => {
    counter += 1;
    return baseEvent({
      source_id: `evt-from-provider-${counter}`,
      updated_at: 1_700_000_000_000 + counter * 1000,
    });
  };
  const wrap = (event: CanonicalEvent): ProviderEventPayload => ({
    event,
    description_bytes: 0,
  });
  const provider: CalendarProvider = {
    kind,
    slug: 'work',
    async connect() {/* no-op */},
    async initialScan() {/* no-op */},
    async startSync() { return async () => {/* no-op */}; },
    async close() {/* no-op */},
    health: () => ({
      last_successful_sync_at: 0,
      error_count_24h: 0,
      pending_queue_size: 0,
      pending_series_expansions: 0,
    }),
    async createEvent(calendar_id, event) {
      calls.create.push({ calendar_id, event });
      return wrap(nextEvent());
    },
    async updateEvent(input) {
      calls.update.push(input);
      return wrap(nextEvent());
    },
    async deleteEvent(input) {
      calls.delete.push(input);
    },
    async rsvpEvent(input) {
      calls.rsvp.push(input);
      const ev = nextEvent();
      ev.attendees = [{ email: 'me@example.com', is_self: true, response_status: input.response }];
      return wrap(ev);
    },
    ...override,
  };
  return { provider, calls, nextEvent };
};

interface Harness {
  db: Database.Database;
  instances: CollectionInstanceStore;
  collection: CalendarCollection;
  deps: CalendarDispatcherDeps;
  calls: ProviderCalls;
  upserted: ProviderEventPayload[];
  deleted: string[];
  enrollInstance: (slug: string, caps?: CalendarCollectionCaps, auth_state?: 'healthy' | 'expired') => CollectionInstanceRow;
  seedEvent: (event?: Partial<CanonicalEvent>, description?: string) => CanonicalEvent;
}

const buildHarness = (
  providerKind: 'gcal' | 'graph' | 'caldav' = 'gcal',
  providerOverride: Partial<CalendarProvider> = {},
): Harness => {
  const db = new Database(':memory:');
  const instances = createInstanceStore({ db });
  const table = createCalendarTable({ db, slug: 'work' });
  const { provider, calls } = makeProvider(providerKind, providerOverride);
  const upserted: ProviderEventPayload[] = [];
  const deleted: string[] = [];

  const collection: CalendarCollection = {
    platform: 'calendar',
    slug: 'work',
    gate: { addUsed: () => {/* no-op */} } as never,
    sync: {
      async start() {/* no-op */},
      async stop() {/* no-op */},
    },
    upsert: () => {/* no-op */},
    delete: () => false,
    get: () => null,
    list: () => [],
    search: () => [],
    health: () => ({
      platform: 'calendar',
      slug: 'work',
      last_indexed_at: 0,
      pending_queue_size: 0,
      error_count_24h: 0,
      state: 'idle',
      event_count: 0,
      upcoming_count_24h: 0,
    }),
    runRetention: async () => ({
      pruned_count: 0,
      bytes_freed: 0,
      blob_hashes_freed: [],
      duration_ms: 0,
    }),
    async close() {/* no-op */},
    table,
    provider,
    async applyVerifiedUpsert(payload) {
      upserted.push(payload);
      table.upsert({
        event: payload.event,
        size_bytes: payload.description_bytes,
      });
    },
    applyVerifiedDelete(source_id) {
      deleted.push(source_id);
      table.delete(source_id);
    },
  };

  const deps: CalendarDispatcherDeps = {
    instances,
    getCollection: (slug) => (slug === 'work' ? collection : undefined),
  };

  const enrollInstance = (
    slug: string,
    caps: CalendarCollectionCaps = FULL_CAPS,
    auth_state: 'healthy' | 'expired' = 'healthy',
  ): CollectionInstanceRow => {
    instances.upsert({
      platform: 'calendar',
      slug,
      adapter_type: providerKind,
      config: {},
      caps,
      auth_state,
      last_synced_at: null,
    });
    return {
      slug,
      platform: 'calendar',
      adapter_type: providerKind,
      caps,
      auth_state,
      last_synced_at: null,
    };
  };

  const seedEvent = (
    overrides: Partial<CanonicalEvent> = {},
    description?: string,
  ): CanonicalEvent => {
    const event = baseEvent(overrides);
    table.upsert({
      event,
      size_bytes: description === undefined ? 0 : Buffer.byteLength(description, 'utf8'),
      ...(description === undefined ? {} : { body_inline: description }),
    });
    return event;
  };

  return { db, instances, collection, deps, calls, upserted, deleted, enrollInstance, seedEvent };
};

describe('calendar dispatcher — gates', () => {
  let h: Harness;
  beforeEach(() => { h = buildHarness(); });
  afterEach(() => { h.db.close(); });

  it('returns CALENDAR_INSTANCE_NOT_FOUND when slug is not enrolled', async () => {
    await expect(handleCalendarList(h.deps, { slug: 'missing' })).rejects.toMatchObject({
      code: 'not_found',
      message: expect.stringContaining('CALENDAR_INSTANCE_NOT_FOUND'),
    });
  });

  it('treats a same-named slug under a different platform as not found', async () => {
    // Instance store keys on (platform, slug) PRIMARY KEY — file:'work'
    // is independent of calendar:'work'. The calendar dispatcher
    // surfaces a clean not_found here.
    h.instances.upsert({
      platform: 'file',
      slug: 'work',
      adapter_type: 'fs',
      config: {},
      caps: {
        read: 'yes', write: 'yes', delete: 'yes', watch: 'realtime',
        mirror: 'optional', auth: 'none', path_style: 'posix',
      } as never,
      auth_state: 'healthy',
      last_synced_at: null,
    });
    await expect(handleCalendarList(h.deps, { slug: 'work' })).rejects.toMatchObject({
      code: 'not_found',
      message: expect.stringContaining('CALENDAR_INSTANCE_NOT_FOUND'),
    });
  });

  it('returns CALENDAR_ADAPTER_UNREACHABLE when row exists but no live collection', async () => {
    h.enrollInstance('other');
    await expect(handleCalendarList(h.deps, { slug: 'other' })).rejects.toMatchObject({
      code: 'server_not_reachable',
      message: expect.stringContaining('CALENDAR_ADAPTER_UNREACHABLE'),
    });
  });

  it('returns CALENDAR_CAPABILITY_DENIED on writes when caps lack the op', async () => {
    h.enrollInstance('work', READ_ONLY_CAPS);
    await expect(
      handleCalendarCreate(h.deps, {
        slug: 'work',
        calendar_id: 'cal-1',
        event: {
          calendar_id: 'cal-1',
          summary: 'New',
          start_at: 1, end_at: 2, timezone: 'UTC', is_all_day: false,
          status: 'confirmed',
        } as never,
      }),
    ).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('CALENDAR_CAPABILITY_DENIED') });
    expect(h.calls.create).toHaveLength(0);
  });

  it('forces caps to no when auth_state is not healthy on writes', async () => {
    h.enrollInstance('work', FULL_CAPS, 'expired');
    h.seedEvent();
    await expect(
      handleCalendarUpdate(h.deps, {
        slug: 'work',
        source_id: 'evt-1',
        patch: { summary: 'changed' },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(h.calls.update).toHaveLength(0);
  });

  it('reads tolerate degraded auth — list works on expired instance', async () => {
    h.enrollInstance('work', FULL_CAPS, 'expired');
    h.seedEvent();
    const res = await handleCalendarList(h.deps, { slug: 'work' });
    expect(res.records).toHaveLength(1);
  });

  it('rejects calendar-search when caps.search === none', async () => {
    h.enrollInstance('work', { ...FULL_CAPS, search: 'none' });
    await expect(handleCalendarSearch(h.deps, { slug: 'work', query: 'foo' })).rejects.toMatchObject({
      code: 'forbidden',
      message: expect.stringContaining('no search capability'),
    });
  });
});

describe('calendar dispatcher — read handlers', () => {
  let h: Harness;
  beforeEach(() => { h = buildHarness(); h.enrollInstance('work'); });
  afterEach(() => { h.db.close(); });

  it('list returns hot-field rows ordered by start_at ascending', async () => {
    h.seedEvent({ source_id: 'evt-1', start_at: 1_700_000_000_000 });
    h.seedEvent({ source_id: 'evt-2', start_at: 1_700_001_000_000 });
    const res = await handleCalendarList(h.deps, { slug: 'work' });
    expect(res.records.map((r) => r.start_at)).toEqual([1_700_000_000_000, 1_700_001_000_000]);
  });

  it('list passes calendar_id + status + range to the table', async () => {
    h.seedEvent({ source_id: 'evt-1', calendar_id: 'a', start_at: 100, status: 'confirmed' });
    h.seedEvent({ source_id: 'evt-2', calendar_id: 'b', start_at: 200, status: 'confirmed' });
    h.seedEvent({ source_id: 'evt-3', calendar_id: 'a', start_at: 300, status: 'cancelled' });
    const res = await handleCalendarList(h.deps, {
      slug: 'work',
      calendar_id: 'a',
      since: 50,
      until: 1000,
      status: 'confirmed',
    });
    expect(res.records.map((r) => r.summary)).toEqual(['Standup']);
  });

  it('get returns the canonical event JSON or null', async () => {
    h.seedEvent({ source_id: 'evt-1', summary: 'Hello' });
    const found = await handleCalendarGet(h.deps, { slug: 'work', source_id: 'evt-1' });
    expect(found.record?.summary).toBe('Hello');
    const missing = await handleCalendarGet(h.deps, { slug: 'work', source_id: 'nope' });
    expect(missing.record).toBeNull();
  });

  it('search returns matches carrying the event body', async () => {
    // ⛔ WAS `toHaveProperty('snippet')` over description-less fixtures — which
    // would pass against ANY string the dispatcher happened to attach. The
    // description is seeded HERE so the assertion has something to be wrong
    // about: the agenda line is what a reader actually needs, and it is what a
    // window centred on "review" would have been free to cut.
    h.seedEvent(
      { source_id: 'evt-1', summary: 'Quarterly review' },
      'Agenda: pipeline, then the renewal terms — 83 day notice.',
    );
    h.seedEvent({ source_id: 'evt-2', summary: 'Standup' });
    const res = await handleCalendarSearch(h.deps, { slug: 'work', query: 'review' });
    expect(res.matches.length).toBeGreaterThan(0);
    expect(res.matches[0].summary).toBe('Quarterly review');
    expect(res.matches[0]).not.toHaveProperty('snippet');
    expect(res.matches[0].body).toContain('83 day notice');
  });

  it('omits body for an event that has no description', async () => {
    // The honest empty: no description is not a truncated one, and the two must
    // not look alike — `body_truncated` is reserved for content withheld.
    h.seedEvent({ source_id: 'evt-3', summary: 'Bare review slot' });
    const res = await handleCalendarSearch(h.deps, { slug: 'work', query: 'bare' });
    expect(res.matches.length).toBeGreaterThan(0);
    expect(res.matches[0].body).toBeUndefined();
    expect(res.matches[0].body_truncated).toBeUndefined();
  });

  it('stat returns exists:false for missing source_id', async () => {
    const res = await handleCalendarStat(h.deps, { slug: 'work', source_id: 'nope' });
    expect(res.exists).toBe(false);
  });

  it('stat returns hot fields for present source_id', async () => {
    h.seedEvent({
      source_id: 'evt-1',
      attendees: [
        { email: 'a@example.com', response_status: 'accepted' },
        { email: 'b@example.com', response_status: 'declined' },
      ],
    });
    const res = await handleCalendarStat(h.deps, { slug: 'work', source_id: 'evt-1' });
    expect(res.exists).toBe(true);
    expect(res.attendee_count).toBe(2);
    expect(res.start_at).toBe(1_700_000_000_000);
  });
});

describe('calendar dispatcher — write handlers', () => {
  let h: Harness;
  beforeEach(() => { h = buildHarness(); h.enrollInstance('work'); });
  afterEach(() => { h.db.close(); });

  it('create calls provider.createEvent + applyVerifiedUpsert on success', async () => {
    const event: CreateEventInput = {
      calendar_id: 'cal-1',
      summary: 'New event',
      start_at: 100, end_at: 200, timezone: 'UTC', is_all_day: false,
      status: 'confirmed',
    } as never;
    const res = await handleCalendarCreate(h.deps, {
      slug: 'work',
      calendar_id: 'cal-1',
      event,
    });
    expect(res.source_id).toBe('evt-from-provider-1');
    expect(res.ical_uid).toBe('uid-1@example');
    expect(h.calls.create).toHaveLength(1);
    expect(h.upserted).toHaveLength(1);
  });

  it('create surfaces CalendarAdapterError as RpcError; warehouse untouched', async () => {
    const harness = buildHarness('gcal', {
      async createEvent() {
        throw new CalendarAdapterError('quota_exceeded', 'rate limited');
      },
    });
    harness.enrollInstance('work');
    await expect(
      handleCalendarCreate(harness.deps, {
        slug: 'work',
        calendar_id: 'cal-1',
        event: {
          calendar_id: 'cal-1',
          summary: 'x',
          start_at: 1, end_at: 2, timezone: 'UTC', is_all_day: false,
          status: 'confirmed',
        } as never,
      }),
    ).rejects.toMatchObject({
      code: 'quota_exceeded',
      message: expect.stringContaining('CALENDAR_QUOTA_EXCEEDED'),
    });
    expect(harness.upserted).toHaveLength(0);
    harness.db.close();
  });

  it('create maps io_error to upstream_error and leaves the warehouse untouched', async () => {
    const harness = buildHarness('gcal', {
      async createEvent() {
        throw new CalendarAdapterError('io_error', 'timeout');
      },
    });
    harness.enrollInstance('work');
    await expect(
      handleCalendarCreate(harness.deps, {
        slug: 'work',
        calendar_id: 'cal-1',
        event: {
          calendar_id: 'cal-1',
          summary: 'x',
          start_at: 1, end_at: 2, timezone: 'UTC', is_all_day: false,
          status: 'confirmed',
        } as never,
      }),
    ).rejects.toMatchObject({
      code: 'upstream_error',
      message: expect.stringContaining('CALENDAR_IO_ERROR'),
    });
    expect(harness.upserted).toHaveLength(0);
    harness.db.close();
  });

  it('update rejects CALENDAR_EVENT_NOT_FOUND when source_id is unknown', async () => {
    await expect(
      handleCalendarUpdate(h.deps, {
        slug: 'work',
        source_id: 'missing',
        patch: { summary: 'x' },
      }),
    ).rejects.toMatchObject({
      code: 'not_found',
      message: expect.stringContaining('CALENDAR_EVENT_NOT_FOUND'),
    });
  });

  it('update without scope defaults to this_instance', async () => {
    h.seedEvent();
    await handleCalendarUpdate(h.deps, {
      slug: 'work',
      source_id: 'evt-1',
      patch: { summary: 'changed' },
    });
    expect(h.calls.update[0].scope).toBe('this_instance');
  });

  it('update with scope=this_and_future on caldav forwards a single adapter call (adapter owns the split)', async () => {
    const harness = buildHarness('caldav');
    harness.enrollInstance('work');
    harness.seedEvent();
    const res = await handleCalendarUpdate(harness.deps, {
      slug: 'work',
      source_id: 'evt-1',
      patch: { summary: 'x' },
      scope: 'this_and_future',
    });
    // CalDAV holds the ICS, so the dispatcher does NOT do the two-call
    // truncate+create dance — it forwards one updateEvent call with the
    // scope and the adapter splits locally.
    expect(harness.calls.update).toHaveLength(1);
    expect(harness.calls.update[0].scope).toBe('this_and_future');
    expect(harness.calls.create).toHaveLength(0);
    expect(harness.upserted).toHaveLength(1);
    expect(res.source_id).toBe(harness.upserted[0].event.source_id);
    harness.db.close();
  });

  it('update with scope=this_and_future on gcal does the two-call expansion', async () => {
    h.seedEvent({
      source_id: 'evt-1',
      recurring_event_id: 'master-1',
      recurrence_rule: 'FREQ=DAILY',
    });
    await handleCalendarUpdate(h.deps, {
      slug: 'work',
      source_id: 'evt-1',
      patch: { summary: 'changed' },
      scope: 'this_and_future',
    });
    // First call: truncate master series
    expect(h.calls.update).toHaveLength(1);
    expect(h.calls.update[0].source_id).toBe('master-1');
    expect(h.calls.update[0].scope).toBe('series');
    expect(h.calls.update[0].patch.recurrence_rule).toMatch(/RECUED:UNTIL=/);
    // Second call: create new series
    expect(h.calls.create).toHaveLength(1);
    expect(h.calls.create[0].event.summary).toBe('changed');
  });

  it('update this_and_future surfaces partial-progress message on second-call failure', async () => {
    let createCount = 0;
    const harness = buildHarness('gcal', {
      async createEvent() {
        createCount++;
        throw new CalendarAdapterError('io_error', 'crashed');
      },
    });
    harness.enrollInstance('work');
    harness.seedEvent({
      source_id: 'evt-1',
      recurring_event_id: 'master-1',
      recurrence_rule: 'FREQ=DAILY',
    });
    await expect(
      handleCalendarUpdate(harness.deps, {
        slug: 'work',
        source_id: 'evt-1',
        patch: { summary: 'changed' },
        scope: 'this_and_future',
      }),
    ).rejects.toMatchObject({
      code: 'upstream_error',
      message: expect.stringContaining('master series'),
    });
    expect(createCount).toBe(1);
    harness.db.close();
  });

  it('delete passes scope through and removes the warehouse row on success', async () => {
    h.seedEvent();
    const res = await handleCalendarDelete(h.deps, {
      slug: 'work',
      source_id: 'evt-1',
      scope: 'series',
    });
    expect(res.deleted).toBe(true);
    // D-210 step 3 — the removed id is echoed for the D-120 write link.
    expect(res.source_id).toBe('evt-1');
    expect(h.calls.delete).toHaveLength(1);
    expect(h.calls.delete[0].scope).toBe('series');
    expect(h.deleted).toContain('evt-1');
  });

  it('delete with scope=this_and_future on caldav forwards to the adapter (adapter truncates locally)', async () => {
    const harness = buildHarness('caldav');
    harness.enrollInstance('work');
    harness.seedEvent();
    const res = await handleCalendarDelete(harness.deps, {
      slug: 'work',
      source_id: 'evt-1',
      scope: 'this_and_future',
    });
    expect(res.deleted).toBe(true);
    expect(harness.calls.delete).toHaveLength(1);
    expect(harness.calls.delete[0].scope).toBe('this_and_future');
    // The triggering row is dropped now; the truncated tail reconciles
    // on the next sync tick.
    expect(harness.deleted).toContain('evt-1');
    harness.db.close();
  });

  it('delete with scope=this_and_future on gcal still surfaces CALENDAR_RRULE_UNSUPPORTED (no delete-split on gcal/graph)', async () => {
    const harness = buildHarness('gcal', {
      async deleteEvent(input) {
        if (input.scope === 'this_and_future') {
          throw new CalendarAdapterError(
            'rrule_unsupported',
            "gcal delete: scope='this_and_future' must be expanded by the dispatcher into series-truncate",
          );
        }
      },
    });
    harness.enrollInstance('work');
    harness.seedEvent();
    await expect(
      handleCalendarDelete(harness.deps, {
        slug: 'work',
        source_id: 'evt-1',
        scope: 'this_and_future',
      }),
    ).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringContaining('CALENDAR_RRULE_UNSUPPORTED'),
    });
    harness.db.close();
  });

  it('delete returns CALENDAR_EVENT_NOT_FOUND for unknown source_id', async () => {
    await expect(
      handleCalendarDelete(h.deps, { slug: 'work', source_id: 'missing' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rsvp resolves self_email from existing attendees and reflects new response_status', async () => {
    h.seedEvent({
      source_id: 'evt-1',
      attendees: [
        { email: 'me@example.com', is_self: true, response_status: 'needs_action' },
        { email: 'them@example.com', response_status: 'accepted' },
      ],
    });
    const res = await handleCalendarRsvp(h.deps, {
      slug: 'work',
      source_id: 'evt-1',
      response: 'accepted',
    });
    expect(h.calls.rsvp).toHaveLength(1);
    expect(h.calls.rsvp[0].self_email).toBe('me@example.com');
    expect(res.response_status).toBe('accepted');
  });

  it('rsvp surfaces attendee_not_self as bad_request', async () => {
    const harness = buildHarness('gcal', {
      async rsvpEvent() {
        throw new CalendarAdapterError('attendee_not_self', 'not invited');
      },
    });
    harness.enrollInstance('work');
    harness.seedEvent();
    await expect(
      handleCalendarRsvp(harness.deps, {
        slug: 'work',
        source_id: 'evt-1',
        response: 'declined',
      }),
    ).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringContaining('CALENDAR_ATTENDEE_NOT_SELF'),
    });
    harness.db.close();
  });
});

// ────────────────────────────────────────────────────────────────
// D-173 P4.3 slice 2 — the LOCAL calendar is editable end-to-end
// ────────────────────────────────────────────────────────────────

/** BLOCKER-1: the calendar every reception booking lands on was create+read
 *  only, so a booking could never be moved or cancelled — most of running a
 *  day. Slice 1 declared `update_event` / `delete_event` `'no'` and the gate
 *  403'd them before the provider was reached.
 *
 *  This is the load-bearing proof that it is lifted, and it is deliberately
 *  built from the REAL pieces at every layer that could still refuse:
 *
 *    - the REAL `LOCAL_CALENDAR_CAPS` constant (not `FULL_CAPS`) — so if
 *      someone flips a cap back to `'no'`, this fails rather than the fixture
 *      papering over it;
 *    - the REAL dispatcher gate (`requireWrite` → `hasCap` → 403);
 *    - the REAL local provider, with its warehouse read seam;
 *    - the REAL warehouse table.
 *
 *  Only the CalendarCollection shell is a fixture. Testing the provider alone
 *  proves nothing here: the gate is what used to refuse
 *  ([[test_real_gate_not_mock_for_admission]]). */
describe('D-173 P4.3 slice 2 — local calendar update/delete through the real gate', () => {
  const buildLocalHarness = () => {
    const db = new Database(':memory:');
    const instances = createInstanceStore({ db });
    const table = createCalendarTable({ db, slug: 'local' });
    const provider = createLocalCalendarProvider({
      slug: 'local',
      now: () => 1_700_000_500_000,
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
      applyVerifiedDelete(source_id: string) {
        table.delete(source_id);
      },
    } as unknown as CalendarCollection;
    const deps: CalendarDispatcherDeps = {
      instances,
      getCollection: (slug) => (slug === 'local' ? collection : undefined),
    };
    // The REAL constant — the same value boot copies onto the instance row.
    instances.upsert({
      platform: 'calendar',
      slug: 'local',
      adapter_type: 'local',
      config: {},
      caps: LOCAL_CALENDAR_CAPS as unknown as CalendarCollectionCaps,
      auth_state: 'healthy',
      last_synced_at: null,
    });
    const seeded = baseEvent({ source_id: 'evt-local-1', calendar_id: 'local' });
    table.upsert({ event: seeded, size_bytes: 0 });
    return { db, table, deps };
  };

  it('MOVES a booking — no 403, and the warehouse reflects the new time', async () => {
    const h = buildLocalHarness();
    const moved = 1_700_100_000_000;

    const res = await handleCalendarUpdate(h.deps, {
      slug: 'local',
      source_id: 'evt-local-1',
      patch: { start_at: moved, end_at: moved + 900_000 },
    });

    expect(res).toEqual({ source_id: 'evt-local-1' });
    const row = h.table.get('evt-local-1');
    expect(row!.event.start_at).toBe(moved);
    expect(row!.event.end_at).toBe(moved + 900_000);
    // Unpatched fields survived the merge — the provider read the current row.
    expect(row!.event.summary).toBe('Standup');
    h.db.close();
  });

  it('CANCELS a booking by patching status — the row stays, the time stops counting', async () => {
    const h = buildLocalHarness();
    await handleCalendarUpdate(h.deps, {
      slug: 'local',
      source_id: 'evt-local-1',
      patch: { status: 'cancelled' },
    });
    expect(h.table.get('evt-local-1')!.event.status).toBe('cancelled');
    // The D7 overlap count excludes `cancelled`, so this is what makes a
    // cancelled booking stop occupying its slot on the approval surface.
    expect(h.table.overlapCount(1_700_000_000_000, 1_700_000_900_000)).toBe(0);
    h.db.close();
  });

  it('DELETES a booking — no 403, and the row is gone', async () => {
    const h = buildLocalHarness();

    const res = await handleCalendarDelete(h.deps, {
      slug: 'local',
      source_id: 'evt-local-1',
    });

    // D-210 step 3 — the real handler echoes the removed event's id so the
    // engine's D-120 write link can name `calendar:evt-local-1` after the
    // warehouse row (asserted gone below) no longer exists.
    expect(res).toEqual({ deleted: true, source_id: 'evt-local-1' });
    expect(h.table.get('evt-local-1')).toBeNull();
    h.db.close();
  });

  it('a stale slice-1 caps row still 403s — which is exactly why boot refreshes caps', async () => {
    // Pins the OTHER half of BLOCKER-1. The constant is not the gate; the row
    // is. If boot ever stops refreshing this row, edits silently 403 again with
    // the constant plainly reading 'yes' — see wire-calendar-stack.test.ts.
    const h = buildLocalHarness();
    h.deps.instances.upsert({
      platform: 'calendar',
      slug: 'local',
      adapter_type: 'local',
      config: {},
      caps: { ...(LOCAL_CALENDAR_CAPS as unknown as CalendarCollectionCaps), update_event: 'no' },
      auth_state: 'healthy',
      last_synced_at: null,
    });

    await expect(
      handleCalendarUpdate(h.deps, {
        slug: 'local',
        source_id: 'evt-local-1',
        patch: { summary: 'x' },
      }),
    ).rejects.toMatchObject({ status: 403 });
    h.db.close();
  });
});

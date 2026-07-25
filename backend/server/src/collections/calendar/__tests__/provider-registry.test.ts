/** D-117 Phase 2 — provider interface, caps validation, adapter
 *  registry tests.
 *
 *  Each adapter (gcal / graph / caldav) lands in its own phase with
 *  its own factory — Phase 2's concern is the surface those factories
 *  plug into. These tests exercise:
 *    - validateCalendarCaps accepts + rejects shapes matching the
 *      documented union members.
 *    - effectiveCaps mirrors file/caps.ts: auth state gates mutation
 *      caps without rewriting the stored shape.
 *    - hasCap returns the expected boolean per requirement.
 *    - createCalendarAdapterRegistry is idempotent-on-lookup,
 *      duplicate-reject on registration, stable-order on list.
 *    - probeCalendarAdapter validates the shape returned by probeCaps.
 */

import { describe, expect, it } from 'vitest';

import type {
  CalendarCollectionCaps,
  CollectionAuthState,
} from '@recued/contracts';

import {
  CalendarCapsValidationError,
  effectiveCaps,
  hasCap,
  isProbedCalendarCaps,
  validateCalendarCaps,
} from '../caps.js';
import {
  createCalendarAdapterRegistry,
  probeCalendarAdapter,
  type CalendarAdapterContext,
  type CalendarAdapterFactory,
} from '../adapter-registry.js';
import type {
  CalendarProvider,
  ProbedCalendarCaps,
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
  read: 'yes',
  list_calendars: 'yes',
  create_event: 'no',
  update_event: 'no',
  delete_event: 'no',
  rsvp: 'no',
  search: 'local',
  watch: 'none',
  auth: 'app_password',
  recurrence: 'client',
};

// ────────────────────────────────────────────────────────────────
// validateCalendarCaps
// ────────────────────────────────────────────────────────────────

describe('validateCalendarCaps', () => {
  it('accepts a fully-populated gcal-shaped probe', () => {
    expect(validateCalendarCaps(FULL_CAPS)).toEqual(FULL_CAPS);
  });

  it('accepts a caldav-shaped probe with local search + client recurrence', () => {
    const caps: CalendarCollectionCaps = {
      ...FULL_CAPS,
      search: 'local',
      recurrence: 'client',
      rsvp: 'no',
      auth: 'app_password',
    };
    expect(validateCalendarCaps(caps)).toEqual(caps);
  });

  it('accepts watch:none for future read-only adapters', () => {
    const caps: CalendarCollectionCaps = { ...FULL_CAPS, watch: 'none' };
    expect(validateCalendarCaps(caps).watch).toBe('none');
  });

  it('rejects missing read', () => {
    expect(() =>
      validateCalendarCaps({ ...FULL_CAPS, read: 'no' }),
    ).toThrowError(CalendarCapsValidationError);
  });

  it('rejects invalid watch mode (realtime deferred to D-118)', () => {
    // D-117 explicitly does not ship push notifications. An adapter
    // that probes 'realtime' is a factory bug.
    expect(() =>
      validateCalendarCaps({ ...FULL_CAPS, watch: 'realtime' }),
    ).toThrowError(CalendarCapsValidationError);
  });

  it('rejects invalid auth mode', () => {
    expect(() =>
      validateCalendarCaps({ ...FULL_CAPS, auth: 'keys' }),
    ).toThrowError(CalendarCapsValidationError);
  });

  it('rejects non-object input', () => {
    expect(() => validateCalendarCaps(null)).toThrowError(
      CalendarCapsValidationError,
    );
    expect(() => validateCalendarCaps('yes')).toThrowError(
      CalendarCapsValidationError,
    );
  });

  it('rejects missing mutation cap fields', () => {
    const partial = { ...FULL_CAPS } as Record<string, unknown>;
    delete partial.create_event;
    expect(() => validateCalendarCaps(partial)).toThrowError(
      CalendarCapsValidationError,
    );
  });

  it('rejects invalid search mode', () => {
    expect(() =>
      validateCalendarCaps({ ...FULL_CAPS, search: 'fulltext' }),
    ).toThrowError(CalendarCapsValidationError);
  });

  it('rejects invalid recurrence mode', () => {
    expect(() =>
      validateCalendarCaps({ ...FULL_CAPS, recurrence: 'never' }),
    ).toThrowError(CalendarCapsValidationError);
  });
});

// ────────────────────────────────────────────────────────────────
// effectiveCaps + hasCap
// ────────────────────────────────────────────────────────────────

describe('effectiveCaps', () => {
  it('returns caps unchanged when auth_state is healthy', () => {
    expect(effectiveCaps(FULL_CAPS, 'healthy')).toEqual(FULL_CAPS);
  });

  it('shorts mutations + watch to no/none when auth_state is expired', () => {
    const eff = effectiveCaps(FULL_CAPS, 'expired');
    expect(eff.create_event).toBe('no');
    expect(eff.update_event).toBe('no');
    expect(eff.delete_event).toBe('no');
    expect(eff.rsvp).toBe('no');
    expect(eff.watch).toBe('none');
    // read + list_calendars stay intact — stale tokens do not
    // silently break ingredient access to already-warehoused rows.
    expect(eff.read).toBe('yes');
    expect(eff.list_calendars).toBe('yes');
  });

  it.each([
    ['unauthorized' as CollectionAuthState],
    ['degraded' as CollectionAuthState],
  ])('non-healthy auth state %s also shorts mutations', (state) => {
    const eff = effectiveCaps(FULL_CAPS, state);
    expect(eff.create_event).toBe('no');
  });
});

describe('hasCap', () => {
  it('returns true for a permitted requirement', () => {
    expect(hasCap(FULL_CAPS, 'create_event')).toBe(true);
    expect(hasCap(FULL_CAPS, 'rsvp')).toBe(true);
  });

  it('returns false on a read-only adapter', () => {
    expect(hasCap(READ_ONLY_CAPS, 'create_event')).toBe(false);
    expect(hasCap(READ_ONLY_CAPS, 'rsvp')).toBe(false);
  });
});

describe('isProbedCalendarCaps', () => {
  it('narrows a valid shape', () => {
    expect(isProbedCalendarCaps(FULL_CAPS)).toBe(true);
  });

  it('rejects a partial shape', () => {
    const partial = { ...FULL_CAPS } as Record<string, unknown>;
    delete partial.watch;
    expect(isProbedCalendarCaps(partial)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// Adapter registry
// ────────────────────────────────────────────────────────────────

const stubProvider: CalendarProvider = {
  kind: 'gcal',
  slug: 'work',
  async connect() {},
  async initialScan() {},
  async startSync() {
    return async () => {};
  },
  async close() {},
  health() {
    return {
      last_successful_sync_at: 0,
      error_count_24h: 0,
      pending_queue_size: 0,
      pending_series_expansions: 0,
    };
  },
  async createEvent() {
    throw new Error('not in test');
  },
  async updateEvent() {
    throw new Error('not in test');
  },
  async deleteEvent() {},
  async rsvpEvent() {
    throw new Error('not in test');
  },
};

const makeFactory = (
  kind: 'gcal' | 'graph' | 'caldav',
  probed: ProbedCalendarCaps = FULL_CAPS,
): CalendarAdapterFactory => ({
  kind,
  async probeCaps() {
    return probed;
  },
  create() {
    return { ...stubProvider, kind };
  },
});

const makeCtx = (): CalendarAdapterContext => ({
  slug: 'work',
  config: {},
  getAccountValue: async () => null,
});

describe('createCalendarAdapterRegistry', () => {
  it('looks up factories by kind after registration', () => {
    const reg = createCalendarAdapterRegistry();
    const gcal = makeFactory('gcal');
    reg.register(gcal);
    expect(reg.get('gcal')).toBe(gcal);
  });

  it('returns undefined for unknown kinds', () => {
    const reg = createCalendarAdapterRegistry();
    expect(reg.get('imap')).toBeUndefined();
  });

  it('rejects duplicate registration', () => {
    const reg = createCalendarAdapterRegistry();
    reg.register(makeFactory('gcal'));
    expect(() => reg.register(makeFactory('gcal'))).toThrow(
      /duplicate registration/,
    );
  });

  it('listKinds returns kinds in registration order', () => {
    const reg = createCalendarAdapterRegistry();
    reg.register(makeFactory('caldav'));
    reg.register(makeFactory('gcal'));
    reg.register(makeFactory('graph'));
    expect(reg.listKinds()).toEqual(['caldav', 'gcal', 'graph']);
  });
});

// ────────────────────────────────────────────────────────────────
// probeCalendarAdapter
// ────────────────────────────────────────────────────────────────

describe('probeCalendarAdapter', () => {
  it('returns validated caps from a well-behaved factory', async () => {
    const caps = await probeCalendarAdapter(makeFactory('gcal'), makeCtx());
    expect(caps).toEqual(FULL_CAPS);
  });

  it('surfaces factory probe failures with a helpful message', async () => {
    const factory: CalendarAdapterFactory = {
      kind: 'caldav',
      async probeCaps() {
        throw new Error('PROPFIND timed out');
      },
      create() {
        return stubProvider;
      },
    };
    await expect(
      probeCalendarAdapter(factory, makeCtx()),
    ).rejects.toThrow(/probe failed for calendar adapter 'caldav'/);
  });

  it('rejects a factory that returns a malformed caps shape', async () => {
    const factory: CalendarAdapterFactory = {
      kind: 'gcal',
      async probeCaps() {
        // Factory bug — missing watch field. The helper throws so the
        // enroll rpc surfaces a developer error, not a user-facing
        // validation error.
        return {
          ...FULL_CAPS,
          watch: 'realtime',
        } as unknown as ProbedCalendarCaps;
      },
      create() {
        return stubProvider;
      },
    };
    await expect(
      probeCalendarAdapter(factory, makeCtx()),
    ).rejects.toThrow(CalendarCapsValidationError);
  });
});

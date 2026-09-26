import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  composePlatformRecordTargetId,
  RECUED_BUILTIN_SOURCE_ID,
  type CanonicalEvent,
  type WorkEntityKind,
} from '@recued/contracts';

import { createCalendarTable } from '../collections/calendar/calendar-table.js';
import type { CalendarStack } from '../collections/calendar/compose.js';
import { resolveContactBusinessContext } from '../contact-business-context.js';
import {
  createContactStore,
  type ContactStore,
} from '../storage/contact-store.js';
import {
  createCrmRecordMirrorStore,
  ensureCrmRecordMirrorSchema,
} from '../storage/crm-record-mirror-store.js';
import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';

const AS_OF = 1_700_000_000_000;
const EMAIL = 'ada@analytical.example';
const DEAL_SCOPE = 'connection.api.pipedrive.deal';

let db: Database.Database;
let contacts: ContactStore;
let work: WorkEntityStore;

const registerSource = (kind: Extract<WorkEntityKind, 'task' | 'booking' | 'project'>): void => {
  work.registerSource({
    id: RECUED_BUILTIN_SOURCE_ID(kind),
    top_tier_kind: kind,
    source_kind: 'builtin',
    source_label: `Recued ${kind}`,
    write_capable: true,
    registered_at: AS_OF - 1_000,
  });
};

const event = (overrides: Partial<CanonicalEvent>): CanonicalEvent => ({
  source_id: 'event-default',
  ical_uid: 'event-default@example.test',
  calendar_id: 'primary',
  summary: 'private title never leaves the context operation',
  start_at: AS_OF + 1_000,
  end_at: AS_OF + 2_000,
  timezone: 'UTC',
  is_all_day: false,
  status: 'confirmed',
  created_at: AS_OF - 10_000,
  updated_at: AS_OF - 100,
  ...overrides,
});

beforeEach(() => {
  db = new Database(':memory:');
  contacts = createContactStore(db);
  ensureWorkEntitySchema(db);
  ensureCrmRecordMirrorSchema(db);
  work = createWorkEntityStore(db);
  registerSource('task');
  registerSource('booking');
  registerSource('project');
});

afterEach(() => db.close());

describe('resolveContactBusinessContext', () => {
  it('recomputes every existing relationship family and emits one strongest tier', () => {
    const focal = contacts.upsertManual({
      email: EMAIL,
      name: 'Ada',
      company: 'Analytical Engines',
      first_seen: AS_OF - 50_000,
    }, AS_OF - 40_000);
    contacts.upsertManual({
      email: 'grace@analytical.example',
      name: 'Grace',
      company: 'Analytical Engines',
      first_seen: AS_OF - 40_000,
    }, AS_OF - 30_000);
    contacts.linkPlatformId({
      canonical_email: EMAIL,
      vendor: 'pipedrive',
      platform_id: 'person-1',
      state: 'confirmed',
      linked_at: AS_OF - 20_000,
      linked_by: 'user',
    });
    // A merged contact can legitimately retain multiple records from one CRM;
    // both ids must participate in the reverse lookup.
    contacts.linkPlatformId({
      canonical_email: EMAIL,
      vendor: 'pipedrive',
      platform_id: 'person-2',
      state: 'auto',
      linked_at: AS_OF - 19_000,
      linked_by: 'reconciler',
    });

    work.writeTask({
      source_id: RECUED_BUILTIN_SOURCE_ID('task'),
      title: 'active private task',
      assigned_contact_id: EMAIL,
    }, AS_OF - 1_000);
    work.writeTask({
      source_id: RECUED_BUILTIN_SOURCE_ID('task'),
      title: 'done private task',
      assigned_contact_id: EMAIL,
      done: true,
    }, AS_OF - 900);
    work.writeBooking({
      source_id: RECUED_BUILTIN_SOURCE_ID('booking'),
      title: 'private booking',
      counterparty_contact_id: focal.contact_id!,
      lifecycle_state: 'confirmed',
    }, AS_OF - 800);
    work.writeProject({
      source_id: RECUED_BUILTIN_SOURCE_ID('project'),
      title: 'private completed project',
      related_contact_ids: [focal.contact_id!],
      state: 'completed',
    }, AS_OF - 700);

    const calendarTable = createCalendarTable({ db, slug: 'work' });
    calendarTable.upsert({
      event: event({
        source_id: 'future',
        ical_uid: 'future@example.test',
        organizer: { email: EMAIL },
      }),
      size_bytes: 0,
      now: AS_OF - 600,
    });
    calendarTable.upsert({
      event: event({
        source_id: 'past',
        ical_uid: 'past@example.test',
        start_at: AS_OF - 2_000,
        end_at: AS_OF - 1_000,
        attendees: [{ email: EMAIL, response_status: 'accepted' }],
      }),
      size_bytes: 0,
      now: AS_OF - 500,
    });
    const calendars = {
      instances: {
        list: () => [{ slug: 'work', backfill_complete: true }],
      },
      listLive: () => [{ slug: 'work', table: calendarTable }],
    } as unknown as Pick<CalendarStack, 'instances' | 'listLive'>;

    ensureCrmRecordMirrorSchema(db);
    const mirror = createCrmRecordMirrorStore(db);
    mirror.upsert({
      scope: DEAL_SCOPE,
      target_id: 'pipedrive_deal_open',
      meta: {
        contact_id: 'person-1',
        close_state: 'open',
        name: 'private open deal',
        snapshot_at: AS_OF - 400,
        snapshot_hash: 'open-hash',
      } as never,
      now: AS_OF - 400,
    });
    mirror.upsert({
      scope: DEAL_SCOPE,
      target_id: 'pipedrive_deal_won',
      meta: {
        contact_id: 'person-2',
        close_state: 'won',
        name: 'private won deal',
        snapshot_at: AS_OF - 300,
        snapshot_hash: 'won-hash',
      } as never,
      now: AS_OF - 300,
    });

    const output = resolveContactBusinessContext({
      contacts,
      workEntities: work,
      calendars,
      crmMirror: mirror,
      getBoundCrmSources: () => [{ source_id: 'pipedrive', scope: DEAL_SCOPE }],
    }, { email: EMAIL, as_of: AS_OF, known_before_at: AS_OF });

    expect(output.identity).toEqual(expect.objectContaining({
      coverage: 'partial',
      resolved: true,
      known_before: true,
      authoritative: true,
      company_known: true,
      same_company: true,
      same_company_contact_count: 1,
      company_source: 'manual',
    }));
    expect(output.deals).toEqual({
      active_count: 1,
      historical_count: 1,
      won_count: 1,
      lost_count: 0,
      observed_count: 2,
      coverage: 'partial',
    });
    expect(output.tasks).toEqual({
      active_count: 1,
      historical_count: 1,
      observed_count: 2,
      coverage: 'complete',
    });
    expect(output.calendar).toEqual({
      active_count: 1,
      historical_count: 1,
      observed_count: 2,
      coverage: 'partial',
    });
    expect(output.bookings).toEqual({
      active_count: 1,
      historical_count: 0,
      observed_count: 1,
      coverage: 'complete',
    });
    expect(output.projects).toEqual({
      active_count: 0,
      historical_count: 1,
      observed_count: 1,
      coverage: 'complete',
    });
    expect(output.level).toBe('active');
    expect(output.active_families).toEqual(['deals', 'tasks', 'calendar', 'bookings']);
    expect(output.historical_families).toEqual(['deals', 'tasks', 'calendar', 'projects']);
    expect(JSON.stringify(output)).not.toContain('private');
  });

  it('does not call a sender known merely because the current mail just materialized it', () => {
    contacts.observe({
      email: EMAIL,
      source: 'email_from',
      event_at: AS_OF,
    }, AS_OF);

    const output = resolveContactBusinessContext({
      contacts,
      workEntities: work,
      getBoundCrmSources: () => [],
      crmMirror: createCrmRecordMirrorStore(db),
    }, {
      email: EMAIL,
      as_of: AS_OF + 10_000,
      known_before_at: AS_OF,
    });

    expect(output.identity).toEqual(expect.objectContaining({
      coverage: 'partial',
      resolved: true,
      known_before: false,
      authoritative: false,
      company_known: false,
      same_company: false,
    }));
    expect(output.level).toBe('none');
  });

  it('classifies calendar state at the fresh evaluation clock without moving the known cutoff', () => {
    contacts.observe({
      email: EMAIL,
      source: 'email_from',
      event_at: AS_OF,
    }, AS_OF);
    const calendarTable = createCalendarTable({ db, slug: 'work' });
    calendarTable.upsert({
      event: event({
        source_id: 'ended-after-mail',
        ical_uid: 'ended-after-mail@example.test',
        organizer: { email: EMAIL },
        start_at: AS_OF + 1_000,
        end_at: AS_OF + 2_000,
      }),
      size_bytes: 0,
      now: AS_OF + 500,
    });
    const calendars = {
      instances: { list: () => [{ slug: 'work' }] },
      listLive: () => [{ slug: 'work', table: calendarTable }],
    } as unknown as Pick<CalendarStack, 'instances' | 'listLive'>;

    const output = resolveContactBusinessContext({
      contacts,
      workEntities: work,
      calendars,
    }, {
      email: EMAIL,
      as_of: AS_OF + 3_000,
      known_before_at: AS_OF,
    });

    expect(output.identity.known_before).toBe(false);
    expect(output.calendar).toEqual({
      active_count: 0,
      historical_count: 1,
      observed_count: 1,
      coverage: 'partial',
    });
    expect(output.level).toBe('historical');
  });

  it('recognizes a manual projection even when the row was first created by current mail', () => {
    contacts.observe({
      email: EMAIL,
      source: 'email_from',
      event_at: AS_OF,
    }, AS_OF);
    contacts.upsertManual({ email: EMAIL, name: 'Ada Lovelace' }, AS_OF);

    const output = resolveContactBusinessContext({
      contacts,
      workEntities: work,
    }, { email: EMAIL, as_of: AS_OF, known_before_at: AS_OF });

    expect(output.identity.known_before).toBe(false);
    expect(output.identity.authoritative).toBe(true);
    expect(output.level).toBe('known');
  });

  it('retains exact-email positive work evidence when no opaque contact id resolves', () => {
    const email = 'legacy-assignee@example.test';
    work.writeTask({
      source_id: RECUED_BUILTIN_SOURCE_ID('task'),
      title: 'legacy task',
      assigned_contact_id: email,
    }, AS_OF - 100);

    const output = resolveContactBusinessContext({
      contacts,
      workEntities: work,
    }, { email, as_of: AS_OF, known_before_at: AS_OF });

    expect(output.identity.resolved).toBe(false);
    expect(output.tasks).toEqual({
      active_count: 1,
      historical_count: 0,
      observed_count: 1,
      coverage: 'partial',
    });
    expect(output.level).toBe('active');
    expect(output.active_families).toContain('tasks');
  });

  it('does not claim complete work coverage when an external source is enabled', () => {
    const focal = contacts.upsertManual({
      email: EMAIL,
      first_seen: AS_OF - 1_000,
    }, AS_OF - 900);
    work.registerSource({
      id: 'linear.office.task',
      top_tier_kind: 'task',
      source_kind: 'connection',
      source_label: 'Linear tasks',
      write_capable: true,
      registered_at: AS_OF - 800,
    });

    const output = resolveContactBusinessContext({
      contacts,
      workEntities: work,
    }, { email: focal.email, as_of: AS_OF, known_before_at: AS_OF });

    expect(output.tasks.coverage).toBe('partial');
    expect(output.bookings.coverage).toBe('complete');
  });

  it('preserves unknown coverage when no contact id exists for opaque work links', () => {
    ensureCrmRecordMirrorSchema(db);
    const mirror = createCrmRecordMirrorStore(db);

    const output = resolveContactBusinessContext({
      contacts,
      workEntities: work,
      crmMirror: mirror,
      getBoundCrmSources: () => [],
    }, {
      email: 'missing@example.test',
      as_of: AS_OF,
      known_before_at: AS_OF,
    });

    expect(output.identity.resolved).toBe(false);
    expect(output.tasks.coverage).toBe('partial');
    expect(output.bookings.coverage).toBe('partial');
    expect(output.projects.coverage).toBe('partial');
    expect(output.calendar.coverage).toBe('unavailable');
    expect(output.deals.coverage).toBe('not_configured');
    expect(output.level).toBe('none');
  });
});

/** Deals for a sender with NO contact link, found by matching the sender's email
 *  against the mirrored CRM contacts.
 *
 *  ⛔ Before this, deals were reached only through the contact graph's platform
 *  links, which only a contact Source the owner sets up creates. A merely-connected
 *  CRM therefore read zero deals for every sender, and the three "inquiry from an
 *  existing customer" recipes could never fire. */
describe('resolveContactBusinessContext — deals by email through the CRM mirror', () => {
  const SENDER = 'sam@buyer.example';
  const PERSON_SCOPE = 'connection.api.pipedrive.person';
  const personId = (native: string): string => composePlatformRecordTargetId('pipedrive', 'person', 'work', native);

  const seedPerson = (mirror: ReturnType<typeof createCrmRecordMirrorStore>, target_id: string, email: string): void => {
    mirror.upsert({
      scope: PERSON_SCOPE as never,
      target_id,
      meta: { email, name: 'Sam', snapshot_at: AS_OF - 900, snapshot_hash: `${target_id}-hash` } as never,
      now: AS_OF - 900,
    });
  };
  const seedDeal = (
    mirror: ReturnType<typeof createCrmRecordMirrorStore>,
    native: string,
    contact_id: string,
    close_state: 'open' | 'won' | 'lost',
  ): void => {
    mirror.upsert({
      scope: DEAL_SCOPE,
      target_id: composePlatformRecordTargetId('pipedrive', 'deal', 'work', native),
      meta: { contact_id, close_state, name: 'private deal', snapshot_at: AS_OF - 500, snapshot_hash: `${native}-hash` } as never,
      now: AS_OF - 500,
    });
  };
  const resolve = (mirror: ReturnType<typeof createCrmRecordMirrorStore>) => resolveContactBusinessContext({
    contacts,
    crmMirror: mirror,
    getBoundCrmSources: () => [{ source_id: 'pipedrive', scope: DEAL_SCOPE }],
  }, { email: SENDER, as_of: AS_OF, known_before_at: AS_OF });

  it('finds an unlinked first-time sender\'s deals and splits won from lost', () => {
    const mirror = createCrmRecordMirrorStore(db);
    seedPerson(mirror, personId('person-9'), SENDER);
    seedDeal(mirror, 'd-open', 'person-9', 'open');
    seedDeal(mirror, 'd-won', 'person-9', 'won');
    seedDeal(mirror, 'd-lost', 'person-9', 'lost');
    // Someone else's deal must not leak in.
    seedDeal(mirror, 'd-other', 'person-10', 'won');

    const output = resolve(mirror);

    expect(output.identity.resolved).toBe(false); // no local contact at all
    expect(output.deals).toEqual({
      active_count: 1,
      historical_count: 2,
      won_count: 1,
      lost_count: 1,
      observed_count: 3,
      coverage: 'partial',
    });
    expect(output.level).toBe('active');
    expect(JSON.stringify(output)).not.toContain('private');
  });

  it('matches the address case-insensitively, as a mailbox reports it', () => {
    const mirror = createCrmRecordMirrorStore(db);
    seedPerson(mirror, personId('person-9'), 'Sam@Buyer.Example');
    seedDeal(mirror, 'd-won', 'person-9', 'won');

    expect(resolve(mirror).deals.won_count).toBe(1);
  });

  it('counts a linked contact whose email also matches ONCE', () => {
    contacts.upsertManual({ email: SENDER, name: 'Sam', first_seen: AS_OF - 40_000 }, AS_OF - 30_000);
    contacts.linkPlatformId({
      canonical_email: SENDER,
      vendor: 'pipedrive',
      platform_id: 'person-9',
      state: 'confirmed',
      linked_at: AS_OF - 20_000,
      linked_by: 'user',
    });
    const mirror = createCrmRecordMirrorStore(db);
    seedPerson(mirror, personId('person-9'), SENDER);
    seedDeal(mirror, 'd-won', 'person-9', 'won');

    const output = resolve(mirror);
    expect(output.deals.won_count).toBe(1);
    expect(output.deals.observed_count).toBe(1);
  });

  it('finds nothing through a mirrored contact with a DIFFERENT email', () => {
    const mirror = createCrmRecordMirrorStore(db);
    seedPerson(mirror, personId('person-9'), 'someone-else@buyer.example');
    seedDeal(mirror, 'd-won', 'person-9', 'won');

    expect(resolve(mirror).deals).toEqual(expect.objectContaining({ won_count: 0, observed_count: 0 }));
  });

  it('never guesses a native id from a target id that does not parse', () => {
    // `pipedrive_person_person-9` has no connection segment, so it carries no
    // routing (`parsePlatformRecordTargetId` → null). Stripping a prefix by hand
    // would "find" person-9 here; the rule is to skip it.
    const mirror = createCrmRecordMirrorStore(db);
    seedPerson(mirror, 'pipedrive_person_person-9', SENDER);
    seedDeal(mirror, 'd-won', 'person-9', 'won');

    expect(resolve(mirror).deals.observed_count).toBe(0);
  });
});

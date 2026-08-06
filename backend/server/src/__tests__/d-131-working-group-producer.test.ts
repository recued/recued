/** D-131 A.15 — `working_group` producer tests.
 *
 *  Drives the standalone `workingGroupTask` against a real in-memory
 *  `data_enrichment` table + `collection_calendar_*` fixtures. Verifies:
 *   - Surface contract (topic / kind / is_ai_surface=false / token=0)
 *   - Pure helpers (participant extraction / attendee-key composition /
 *     stable id derivation / grouping / filter+cap)
 *   - Calendar scan + multi-table aggregation + look-back window
 *   - Whole-cycle orchestration — happy path, recurrence filter,
 *     min-attendees filter, cap enforcement
 *   - Stable derived_entity_id across runs
 *   - Sweep stale rows on cycle drift
 *   - Registry value_schema accept / reject
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  type WorkingGroupValue,
} from '@recued/contracts';

import {
  WORKING_GROUP_AUTHORED_BY,
  WORKING_GROUP_TOPIC,
  WORKING_GROUP_CALENDAR_LOOKBACK_MS,
  WORKING_GROUP_MAX_GROUPS,
  WORKING_GROUP_MIN_ATTENDEES_PER_EVENT,
  WORKING_GROUP_MIN_RECURRENCE_PER_GROUP,
  WORKING_GROUP_TOKEN_ESTIMATE,
  assembleWorkingGroup,
  composeAttendeeKey,
  deriveWorkingGroupId,
  extractParticipantSet,
  filterAndCapGroups,
  groupByAttendeeSet,
  runWorkingGroupCycle,
  scanRecentCalendarEventsForWorkingGroup,
  sweepStaleWorkingGroups,
  workingGroupScopeReadDeclaration,
  workingGroupTask,
  workingGroupTokenEstimate,
} from '../housekeeping/index.js';

import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';
import {
  createCalendarFixtureTable,
  insertCalendarFixtureRow,
} from './_calendar-fixture.js';

// ────────────────────────────────────────────────────────────────
// Fixture infrastructure
// ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * ONE_HOUR;

const CAL_TABLE_A = 'collection_calendar_55555555ee';
const CAL_TABLE_B = 'collection_calendar_66666666ff';

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-131-working-group-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  for (const t of [CAL_TABLE_A, CAL_TABLE_B]) {
    createCalendarFixtureTable(db, t);
  }
  store = createEnrichmentStore(db);
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface InsertedEvent {
  table?: string;
  record_id: string;
  organizer?: string;
  attendees: string[];
  start_at?: number;
  received_at?: number;
  summary?: string;
}

const insertEvent = (e: InsertedEvent): void => {
  const table = e.table ?? CAL_TABLE_A;
  const hot = {
    summary: e.summary ?? `Event ${e.record_id}`,
    organizer: e.organizer ?? 'alice@example.com',
    attendees: e.attendees,
    start_at: e.start_at ?? NOW + ONE_HOUR,
    end_at: (e.start_at ?? NOW + ONE_HOUR) + ONE_HOUR,
    status: 'confirmed',
    location: '',
    timezone: 'UTC',
  };
  insertCalendarFixtureRow(db, table, {
    record_id: e.record_id,
    hot,
    received_at: e.received_at ?? NOW,
  });
};

const buildCtx = (now: number = NOW): HousekeepingContext => ({
  db,
  bus: {
    emit: () => undefined,
    subscribe: () => () => undefined,
    dispose: () => undefined,
  } as never,
  enrichmentStore: store,
  recipeStore: {} as never,
  now: () => now,
  emitAuditRow: () => undefined,
});

// ────────────────────────────────────────────────────────────────
// Surface contract
// ────────────────────────────────────────────────────────────────

describe('workingGroupTask surface contract', () => {
  it('targets the working_group registry topic', () => {
    expect(workingGroupTask.topic).toBe('working_group');
  });

  it('declares is_ai_surface=false (deterministic)', () => {
    expect(workingGroupTask.is_ai_surface).toBe(false);
  });

  it('declares meta.kind=enrichment', () => {
    expect(workingGroupTask.meta.kind).toBe('enrichment');
  });

  it('declares meta.id=enrichment.working_group', () => {
    expect(workingGroupTask.meta.id).toBe('enrichment.working_group');
  });

  it('declares meta.interruptible=true', () => {
    expect(workingGroupTask.meta.interruptible).toBe(true);
  });

  it('does NOT stamp idle_eligible (D-132 trust gate resolves at runtime)', () => {
    expect(workingGroupTask.meta.idle_eligible).toBeUndefined();
  });

  it('exposes a zero-token cycle estimate (deterministic)', () => {
    expect(workingGroupTokenEstimate()).toBe(0);
    expect(workingGroupTokenEstimate()).toBe(WORKING_GROUP_TOKEN_ESTIMATE);
  });

  it('declares non-empty scope_read_declaration over data.calendar', () => {
    expect(workingGroupScopeReadDeclaration.length).toBeGreaterThan(0);
    const cal = workingGroupScopeReadDeclaration.find(
      (e) => e.collection === 'data.calendar',
    );
    expect(cal).toBeDefined();
    expect((cal!.sample_field_paths as ReadonlyArray<string>).length).toBeGreaterThan(0);
  });
});

describe('working_group registry entry', () => {
  it('is shape: derived_entity', () => {
    expect(ENRICHMENT_REGISTRY.working_group.shape).toBe('derived_entity');
  });

  it('uses members_list policy with members_scope=calendar', () => {
    const def = ENRICHMENT_REGISTRY.working_group as {
      policy: string;
      members_field?: string;
      members_scope?: string;
    };
    expect(def.policy).toBe('members_list');
    expect(def.members_field).toBe('members');
    expect(def.members_scope).toBe('calendar');
  });

  it('uses producer_kind=housekeeping', () => {
    expect(ENRICHMENT_REGISTRY.working_group.producer_kind).toBe('housekeeping');
  });

  it('does NOT declare emits_confidence (deterministic, no LLM)', () => {
    const def = ENRICHMENT_REGISTRY.working_group as { emits_confidence?: boolean };
    expect(def.emits_confidence).toBeUndefined();
  });

  it('does NOT declare default_trust_state (resolver returns "auto" for non-AI)', () => {
    const def = ENRICHMENT_REGISTRY.working_group as { default_trust_state?: string };
    expect(def.default_trust_state).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// Pure helpers — participant extraction
// ────────────────────────────────────────────────────────────────

describe('extractParticipantSet', () => {
  it('returns sorted unique emails including organizer', () => {
    const out = extractParticipantSet({
      organizer: 'alice@example.com',
      attendees: ['bob@example.com', 'carol@example.com'],
    });
    expect(out).toEqual(['alice@example.com', 'bob@example.com', 'carol@example.com']);
  });

  it('deduplicates organizer if also in attendees', () => {
    const out = extractParticipantSet({
      organizer: 'alice@example.com',
      attendees: ['alice@example.com', 'bob@example.com'],
    });
    expect(out).toEqual(['alice@example.com', 'bob@example.com']);
  });

  it('handles attendees as objects with .email field (gcal/graph shape)', () => {
    const out = extractParticipantSet({
      organizer: 'alice@example.com',
      attendees: [
        { email: 'bob@example.com', response_status: 'accepted' },
        { email: 'carol@example.com' },
      ],
    });
    expect(out).toEqual(['alice@example.com', 'bob@example.com', 'carol@example.com']);
  });

  it('canonicalises RFC-5322 wrapper shapes', () => {
    const out = extractParticipantSet({
      organizer: '"Alice Smith" <alice@example.com>',
      attendees: ['Bob Jones <bob@example.com>', 'carol@example.com (Carol Doe)'],
    });
    expect(out).toEqual(['alice@example.com', 'bob@example.com', 'carol@example.com']);
  });

  it('returns empty array on missing organizer + empty attendees', () => {
    expect(extractParticipantSet({})).toEqual([]);
  });

  it('drops unparseable entries silently', () => {
    const out = extractParticipantSet({
      organizer: 'alice@example.com',
      attendees: [42, null, 'bob@example.com'],
    });
    expect(out).toEqual(['alice@example.com', 'bob@example.com']);
  });
});

describe('composeAttendeeKey', () => {
  it('joins sorted emails with single space', () => {
    expect(composeAttendeeKey(['alice@x.com', 'bob@y.com'])).toBe(
      'alice@x.com bob@y.com',
    );
  });

  it('produces empty string for empty input', () => {
    expect(composeAttendeeKey([])).toBe('');
  });
});

describe('deriveWorkingGroupId', () => {
  it('produces a working_group_<hash> id', () => {
    expect(deriveWorkingGroupId('alice@x.com bob@y.com')).toMatch(
      /^working_group_[a-f0-9]+$/,
    );
  });

  it('is stable for the same key', () => {
    const a = deriveWorkingGroupId('alice@x.com bob@y.com carol@z.com');
    const b = deriveWorkingGroupId('alice@x.com bob@y.com carol@z.com');
    expect(a).toBe(b);
  });

  it('differs for different keys', () => {
    expect(deriveWorkingGroupId('a b c')).not.toBe(deriveWorkingGroupId('a b d'));
  });
});

// ────────────────────────────────────────────────────────────────
// Pure helpers — grouping + filtering
// ────────────────────────────────────────────────────────────────

const buildEvent = (
  record_id: string,
  participants: string[],
  start_at: number,
) => ({
  record_id,
  start_at,
  participants: [...participants].sort(),
});

describe('groupByAttendeeSet', () => {
  it('groups events with identical attendee sets', () => {
    const events = [
      buildEvent('e1', ['a@x', 'b@x', 'c@x'], NOW),
      buildEvent('e2', ['a@x', 'b@x', 'c@x'], NOW - ONE_DAY),
      buildEvent('e3', ['a@x', 'b@x', 'c@x'], NOW - 2 * ONE_DAY),
    ];
    const groups = groupByAttendeeSet(events);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.member_event_ids.sort()).toEqual(['e1', 'e2', 'e3']);
    expect(groups[0]!.contacts).toEqual(['a@x', 'b@x', 'c@x']);
  });

  it('separates groups with different attendee sets', () => {
    const events = [
      buildEvent('e1', ['a@x', 'b@x', 'c@x'], NOW),
      buildEvent('e2', ['a@x', 'b@x', 'd@x'], NOW),
    ];
    const groups = groupByAttendeeSet(events);
    expect(groups).toHaveLength(2);
  });

  it('tracks first / last event timestamps correctly', () => {
    const events = [
      buildEvent('e1', ['a@x', 'b@x'], NOW),
      buildEvent('e2', ['a@x', 'b@x'], NOW - 5 * ONE_DAY),
      buildEvent('e3', ['a@x', 'b@x'], NOW - 10 * ONE_DAY),
    ];
    const groups = groupByAttendeeSet(events);
    expect(groups[0]!.last_event_at).toBe(NOW);
    expect(groups[0]!.first_event_at).toBe(NOW - 10 * ONE_DAY);
  });

  it('handles empty input', () => {
    expect(groupByAttendeeSet([])).toEqual([]);
  });
});

describe('filterAndCapGroups', () => {
  const buildCandidate = (record_count: number, last_event_at = NOW) => ({
    attendee_key: `key${record_count}-${last_event_at}`,
    contacts: ['a@x', 'b@x', 'c@x'],
    member_event_ids: Array.from({ length: record_count }, (_, i) => `e-${record_count}-${i}`),
    first_event_at: last_event_at - record_count * ONE_DAY,
    last_event_at,
  });

  it('drops groups below the recurrence floor', () => {
    const groups = [buildCandidate(2), buildCandidate(1), buildCandidate(3)];
    const out = filterAndCapGroups(groups, 3);
    expect(out).toHaveLength(1);
    expect(out[0]!.member_event_ids).toHaveLength(3);
  });

  it('caps at MAX_GROUPS and keeps largest by event count', () => {
    const groups = [
      buildCandidate(3),
      buildCandidate(5),
      buildCandidate(4),
      buildCandidate(7),
      buildCandidate(2),
    ];
    const out = filterAndCapGroups(groups, 3, 2);
    expect(out).toHaveLength(2);
    expect(out.map((g) => g.member_event_ids.length).sort((a, b) => b - a)).toEqual([
      7, 5,
    ]);
  });

  it('breaks event-count ties on last_event_at desc', () => {
    const groups = [
      buildCandidate(3, NOW - 5 * ONE_DAY),
      buildCandidate(3, NOW),
    ];
    const out = filterAndCapGroups(groups, 3, 1);
    expect(out).toHaveLength(1);
    expect(out[0]!.last_event_at).toBe(NOW);
  });

  it('returns empty array when nothing meets recurrence floor', () => {
    expect(filterAndCapGroups([buildCandidate(1)], 3)).toEqual([]);
  });

  it('default thresholds match the exported constants', () => {
    expect(WORKING_GROUP_MIN_RECURRENCE_PER_GROUP).toBe(3);
    expect(WORKING_GROUP_MAX_GROUPS).toBe(30);
    expect(WORKING_GROUP_MIN_ATTENDEES_PER_EVENT).toBe(3);
  });
});

// ────────────────────────────────────────────────────────────────
// assembleWorkingGroup
// ────────────────────────────────────────────────────────────────

describe('assembleWorkingGroup', () => {
  it('produces a WorkingGroupValue with deduped sorted members', () => {
    const candidate = {
      attendee_key: 'a@x b@x c@x',
      contacts: ['a@x', 'b@x', 'c@x'],
      member_event_ids: ['e3', 'e1', 'e2', 'e1'],
      first_event_at: NOW - 30 * ONE_DAY,
      last_event_at: NOW,
    };
    const { value, derived_entity_id } = assembleWorkingGroup(candidate, NOW);
    expect(value.members).toEqual(['e1', 'e2', 'e3']);
    expect(value.contacts).toEqual(['a@x', 'b@x', 'c@x']);
    expect(value.event_count).toBe(3);
    expect(value.first_event_at).toBe(NOW - 30 * ONE_DAY);
    expect(value.last_event_at).toBe(NOW);
    expect(value.computed_at).toBe(NOW);
    expect(derived_entity_id).toMatch(/^working_group_[a-f0-9]+$/);
  });
});

// ────────────────────────────────────────────────────────────────
// Calendar scan
// ────────────────────────────────────────────────────────────────

describe('scanRecentCalendarEventsForWorkingGroup', () => {
  it('returns events in newest-first order with start_at + participants', () => {
    insertEvent({
      record_id: 'e-old',
      attendees: ['a@x', 'b@x'],
      start_at: NOW - 30 * ONE_DAY,
      received_at: NOW - 30 * ONE_DAY,
    });
    insertEvent({
      record_id: 'e-new',
      attendees: ['a@x', 'b@x'],
      start_at: NOW,
      received_at: NOW,
    });
    const events = scanRecentCalendarEventsForWorkingGroup(buildCtx(), NOW);
    expect(events.map((e) => e.record_id)).toEqual(['e-new', 'e-old']);
  });

  it('walks every collection_calendar_* table', () => {
    insertEvent({
      table: CAL_TABLE_A,
      record_id: 'a1',
      attendees: ['a@x', 'b@x'],
    });
    insertEvent({
      table: CAL_TABLE_B,
      record_id: 'b1',
      attendees: ['a@x', 'c@x'],
    });
    const events = scanRecentCalendarEventsForWorkingGroup(buildCtx(), NOW);
    expect(events.map((e) => e.record_id).sort()).toEqual(['a1', 'b1']);
  });

  it('drops events older than the look-back window', () => {
    insertEvent({
      record_id: 'too-old',
      attendees: ['a@x', 'b@x'],
      received_at: NOW - WORKING_GROUP_CALENDAR_LOOKBACK_MS - ONE_DAY,
    });
    insertEvent({
      record_id: 'in-window',
      attendees: ['a@x', 'b@x'],
    });
    const events = scanRecentCalendarEventsForWorkingGroup(buildCtx(), NOW);
    expect(events.map((e) => e.record_id)).toEqual(['in-window']);
  });

  it('drops events with fewer than MIN_ATTENDEES_PER_EVENT participants', () => {
    insertEvent({
      record_id: '1on1',
      organizer: 'a@x',
      attendees: ['b@x'], // 2 total — below threshold
    });
    insertEvent({
      record_id: 'team',
      organizer: 'a@x',
      attendees: ['b@x', 'c@x'], // 3 total — passes
    });
    const events = scanRecentCalendarEventsForWorkingGroup(buildCtx(), NOW);
    expect(events.map((e) => e.record_id)).toEqual(['team']);
  });

  it('cannot store an event with no start_at — production declares it NOT NULL', () => {
    // ⚠ This replaces a test that inserted a calendar row whose `hot_fields`
    // JSON omitted (or non-numerically typed) `start_at`, and asserted the
    // producer dropped it.
    //
    // That input is NOT REPRESENTABLE. Production's calendar table declares
    // `start_at INTEGER NOT NULL` (D-117 typed columns), so the branch is
    // unreachable on any real server; the old test only passed because the
    // fixture was mail-shaped and start_at lived in a JSON blob.
    //
    // Kept as an assertion about the schema rather than deleted: if start_at
    // ever becomes nullable, this reddens and the branch needs a real test.
    expect(() =>
      db
        .prepare(
          `INSERT INTO ${CAL_TABLE_A} (
             record_id, source_id, received_at, modified_at, size_bytes,
             calendar_id, summary, start_at, end_at, status, organizer,
             ical_uid, location, is_all_day, is_recurring,
             body_inline, blob_hash, etag, record_payload, prior_payload
           ) VALUES (?, ?, ?, ?, ?, 'primary', 'NoStart', NULL, ?, 'confirmed',
                     NULL, 'uid-nostart', NULL, 0, 0, NULL, NULL, NULL, '{}', NULL)`,
        )
        .run('e_nostart', 'e_nostart', NOW, NOW, 200, NOW),
    ).toThrow(/NOT NULL/i);
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 5; i += 1) {
      insertEvent({
        record_id: `e${i}`,
        attendees: ['b@x', 'c@x'],
        received_at: NOW - i * ONE_HOUR,
      });
    }
    const events = scanRecentCalendarEventsForWorkingGroup(buildCtx(), NOW, 3);
    expect(events).toHaveLength(3);
  });
});

// ────────────────────────────────────────────────────────────────
// runWorkingGroupCycle — end-to-end orchestration
// ────────────────────────────────────────────────────────────────

const seedRecurringMeetingCorpus = (): void => {
  // Group A: 4 events, attendees a/b/c/d, one organiser
  for (let i = 0; i < 4; i += 1) {
    insertEvent({
      record_id: `team-a-${i}`,
      organizer: 'lead@example.com',
      attendees: ['alice@example.com', 'bob@example.com', 'carol@example.com'],
      start_at: NOW - i * 7 * ONE_DAY,
      received_at: NOW - i * 7 * ONE_DAY,
    });
  }
  // Group B: 3 events, attendees x/y/z + organiser
  for (let i = 0; i < 3; i += 1) {
    insertEvent({
      record_id: `team-b-${i}`,
      organizer: 'manager@example.com',
      attendees: ['xavier@example.com', 'yvonne@example.com', 'zoe@example.com'],
      start_at: NOW - i * 14 * ONE_DAY,
      received_at: NOW - i * 14 * ONE_DAY,
    });
  }
  // Singleton (gets dropped by recurrence filter)
  insertEvent({
    record_id: 'one-off',
    organizer: 'lead@example.com',
    attendees: ['alice@example.com', 'frank@example.com', 'grace@example.com'],
  });
  // 1-on-1 (gets dropped by attendee floor)
  insertEvent({
    record_id: 'one-on-one',
    organizer: 'lead@example.com',
    attendees: ['alice@example.com'],
  });
};

describe('runWorkingGroupCycle', () => {
  it('produces zero rows on empty calendar corpus', () => {
    const out = runWorkingGroupCycle(buildCtx());
    expect(out.produced).toBe(0);
  });

  it('produces zero rows when no group meets recurrence floor', () => {
    insertEvent({
      record_id: 'e1',
      organizer: 'a@x',
      attendees: ['b@x', 'c@x'],
    });
    insertEvent({
      record_id: 'e2',
      organizer: 'd@x',
      attendees: ['e@x', 'f@x'],
    });
    const out = runWorkingGroupCycle(buildCtx());
    expect(out.produced).toBe(0);
  });

  it('happy path — emits one row per recurring group', () => {
    seedRecurringMeetingCorpus();
    const out = runWorkingGroupCycle(buildCtx());
    expect(out.produced).toBe(2);

    const rows = store.list({ topic: WORKING_GROUP_TOPIC, fresh_only: false });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.scope).toBeNull();
      expect(row.target_id).toBeNull();
      expect(row.authored_by).toBe(WORKING_GROUP_AUTHORED_BY);
      const v = row.value as WorkingGroupValue;
      expect(v.event_count).toBeGreaterThanOrEqual(WORKING_GROUP_MIN_RECURRENCE_PER_GROUP);
      expect(v.contacts.length).toBeGreaterThanOrEqual(WORKING_GROUP_MIN_ATTENDEES_PER_EVENT);
      expect(v.members.length).toBe(v.event_count);
      expect(v.last_event_at).toBeGreaterThanOrEqual(v.first_event_at);
    }
  });

  it('denormalizes contacts_resolved from directory names (bench harvest)', () => {
    // A name-capable contacts directory: two of team A's members are
    // named; the rest stay raw-list-only.
    db.exec(`CREATE TABLE IF NOT EXISTS contacts (email TEXT PRIMARY KEY, name TEXT)`);
    const ins = db.prepare(`INSERT INTO contacts (email, name) VALUES (?, ?)`);
    ins.run('alice@example.com', 'Alice Njoku');
    ins.run('lead@example.com', 'Lena Okafor');

    seedRecurringMeetingCorpus();
    runWorkingGroupCycle(buildCtx());
    const rows = store.list({ topic: WORKING_GROUP_TOPIC, fresh_only: false });
    const teamA = rows
      .map((r) => r.value as WorkingGroupValue)
      .find((v) => v.contacts.includes('alice@example.com'));
    expect(teamA).toBeDefined();
    // Only directory-NAMED members appear, sorted by entity; bob + carol
    // stay in the raw `contacts` list but earn no fabricated pair.
    expect(teamA!.contacts_resolved).toEqual([
      { entity: 'alice@example.com', name: 'Alice Njoku' },
      { entity: 'lead@example.com', name: 'Lena Okafor' },
    ]);
  });

  it('cluster A (4 events) carries lead/alice/bob/carol contacts and four event ids', () => {
    seedRecurringMeetingCorpus();
    runWorkingGroupCycle(buildCtx());
    const rows = store.list({ topic: WORKING_GROUP_TOPIC, fresh_only: false });
    const teamA = rows
      .map((r) => r.value as WorkingGroupValue)
      .find((v) =>
        v.contacts.includes('alice@example.com') &&
        v.contacts.includes('bob@example.com'),
      );
    expect(teamA).toBeDefined();
    expect([...teamA!.contacts].sort()).toEqual([
      'alice@example.com',
      'bob@example.com',
      'carol@example.com',
      'lead@example.com',
    ]);
    expect(teamA!.event_count).toBe(4);
    expect([...teamA!.members].sort()).toEqual([
      'team-a-0',
      'team-a-1',
      'team-a-2',
      'team-a-3',
    ]);
  });

  it('drops 1-on-1s + singletons before emit', () => {
    seedRecurringMeetingCorpus();
    runWorkingGroupCycle(buildCtx());
    const rows = store.list({ topic: WORKING_GROUP_TOPIC, fresh_only: false });
    // Both teams must be present; the one-off + 1-on-1 must NOT.
    const allMembers = rows.flatMap((r) => (r.value as WorkingGroupValue).members);
    expect(allMembers).not.toContain('one-off');
    expect(allMembers).not.toContain('one-on-one');
  });

  it('produces stable derived_entity_id across runs with the same corpus', () => {
    seedRecurringMeetingCorpus();
    runWorkingGroupCycle(buildCtx());
    const firstIds = store
      .list({ topic: WORKING_GROUP_TOPIC, fresh_only: false })
      .map((r) => r._id)
      .sort();

    runWorkingGroupCycle(buildCtx());
    const secondIds = store
      .list({ topic: WORKING_GROUP_TOPIC, fresh_only: false })
      .map((r) => r._id)
      .sort();

    expect(firstIds).toEqual(secondIds);
    expect(secondIds).toHaveLength(2);
  });

  it('cap is enforced on emitted groups', () => {
    // Build many distinct recurring groups (each with 3 events, 3 attendees).
    for (let g = 0; g < WORKING_GROUP_MAX_GROUPS + 5; g += 1) {
      for (let i = 0; i < 3; i += 1) {
        insertEvent({
          record_id: `g${g}-e${i}`,
          organizer: `org${g}@example.com`,
          attendees: [`m${g}-a@example.com`, `m${g}-b@example.com`],
          start_at: NOW - i * 7 * ONE_DAY,
          received_at: NOW - i * 7 * ONE_DAY,
        });
      }
    }
    const out = runWorkingGroupCycle(buildCtx());
    expect(out.produced).toBeLessThanOrEqual(WORKING_GROUP_MAX_GROUPS);
  });

  it('workingGroupTask.step returns complete + zero-cost cursor', async () => {
    seedRecurringMeetingCorpus();
    const result = await workingGroupTask.step(
      buildCtx(),
      { kind: 'complete' },
      60_000,
    );
    expect(result.status).toBe('complete');
    expect(result.cursor).toEqual({ kind: 'complete' });
  });

  it('round-trips through the registry value_schema', () => {
    seedRecurringMeetingCorpus();
    expect(() => runWorkingGroupCycle(buildCtx())).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────
// Sweep stale rows
// ────────────────────────────────────────────────────────────────

describe('sweepStaleWorkingGroups', () => {
  const insertGroup = (id: string): void => {
    store.upsert({
      topic: 'working_group',
      derived_entity_id: id,
      value: {
        contacts: ['a@x', 'b@x', 'c@x'],
        members: ['e1', 'e2', 'e3'],
        event_count: 3,
        first_event_at: NOW - 14 * ONE_DAY,
        last_event_at: NOW,
        computed_at: NOW,
      },
      authored_by: WORKING_GROUP_AUTHORED_BY,
    });
  };

  it('deletes rows whose id is not in the fresh set', () => {
    insertGroup('working_group_kept');
    insertGroup('working_group_orphan');
    const result = sweepStaleWorkingGroups(buildCtx(), new Set(['working_group_kept']));
    expect(result.deleted).toBe(1);
    const remaining = store.list({ topic: WORKING_GROUP_TOPIC, fresh_only: false });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!._id).toBe('working_group_kept');
  });

  it('deletes every row when fresh set is empty', () => {
    insertGroup('working_group_x');
    const result = sweepStaleWorkingGroups(buildCtx(), new Set());
    expect(result.deleted).toBe(1);
  });

  it('no-op when fresh set covers every row', () => {
    insertGroup('working_group_kept');
    const result = sweepStaleWorkingGroups(buildCtx(), new Set(['working_group_kept']));
    expect(result.deleted).toBe(0);
    expect(store.list({ topic: WORKING_GROUP_TOPIC, fresh_only: false })).toHaveLength(1);
  });

  it('cycle 2 sweeps a group that vanished from the corpus', () => {
    seedRecurringMeetingCorpus();
    runWorkingGroupCycle(buildCtx());
    expect(store.list({ topic: WORKING_GROUP_TOPIC, fresh_only: false })).toHaveLength(2);

    // Delete every team-b event. Cycle 2 should drop that working group.
    db.prepare(`DELETE FROM ${CAL_TABLE_A} WHERE record_id LIKE 'team-b-%'`).run();
    runWorkingGroupCycle(buildCtx());
    const rows = store.list({ topic: WORKING_GROUP_TOPIC, fresh_only: false });
    expect(rows).toHaveLength(1);
    const surviving = rows[0]!.value as WorkingGroupValue;
    expect(surviving.contacts).toContain('alice@example.com');
  });
});

// ────────────────────────────────────────────────────────────────
// Registry value_schema
// ────────────────────────────────────────────────────────────────

describe('working_group value_schema', () => {
  const validate = ENRICHMENT_REGISTRY.working_group.value_schema;

  const goodValue: WorkingGroupValue = {
    contacts: ['alice@example.com', 'bob@example.com', 'carol@example.com'],
    members: ['e1', 'e2', 'e3'],
    event_count: 3,
    first_event_at: NOW - 14 * ONE_DAY,
    last_event_at: NOW,
    computed_at: NOW,
  };

  it('accepts a well-formed value', () => {
    expect(validate(goodValue).ok).toBe(true);
  });

  it('rejects non-object values', () => {
    expect(validate('not an object').ok).toBe(false);
    expect(validate(null).ok).toBe(false);
    expect(validate([]).ok).toBe(false);
  });

  it('rejects empty contacts array', () => {
    expect(validate({ ...goodValue, contacts: [] }).ok).toBe(false);
  });

  it('rejects empty members array', () => {
    expect(validate({ ...goodValue, members: [] }).ok).toBe(false);
  });

  it('rejects non-string member entries', () => {
    expect(validate({ ...goodValue, members: ['e1', 42] }).ok).toBe(false);
  });

  it('rejects non-finite event_count', () => {
    expect(validate({ ...goodValue, event_count: NaN }).ok).toBe(false);
  });

  it('rejects missing computed_at', () => {
    const { computed_at: _ts, ...rest } = goodValue;
    void _ts;
    expect(validate(rest).ok).toBe(false);
  });
});

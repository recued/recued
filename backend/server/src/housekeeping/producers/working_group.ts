/** D-131 A.15 — `working_group` enrichment producer.
 *
 *  Second Shape B (derived-entity) housekeeping producer in Phase A;
 *  first deterministic Shape B. `members_list` policy with
 *  `members_scope: 'calendar'`: each working group owns the list of
 *  calendar event ids that recurringly clustered the same set of
 *  attendees. The cascade engine trims those ids on calendar-source-
 *  delete via the `members_list` policy; when the list empties, the
 *  row is dropped automatically.
 *
 *  Standalone `HousekeepingTaskInstance` (matches `topicClusterTask` /
 *  `confidenceDriftSignalTask` precedent — Shape B aggregates across
 *  the whole calendar corpus rather than per-record).
 *
 *  Algorithm:
 *
 *    1. **Calendar scan.** Walk every `collection_calendar_*` table
 *       for events within `CALENDAR_LOOKBACK_MS` and capped at
 *       `MAX_EVENTS_SCANNED`. Newest-first.
 *
 *    2. **Per-event participant set.** Canonical-email organizer +
 *       attendees into a single Set. Skip events with fewer than
 *       `MIN_ATTENDEES_PER_EVENT = 3` participants — 1-on-1s aren't
 *       working groups; the `meeting_frequency` producer covers
 *       per-contact cadence already.
 *
 *    3. **Group by attendee key.** key = `sorted(emails).join(' ')`.
 *       Two events with the same exact attendee set fall into the
 *       same group. Recurring meetings (weekly sync, monthly review)
 *       have stable attendee lists; ad-hoc one-offs end up as
 *       singletons that get filtered.
 *
 *    4. **Filter by recurrence.** Drop groups with fewer than
 *       `MIN_RECURRENCE_PER_GROUP = 3` events. Cap at `MAX_GROUPS = 30`,
 *       keeping the largest by event count + recent tiebreak.
 *
 *    5. **Stable id.** `derived_entity_id =
 *       working_group_<sha1-prefix(attendee_key)>`. Stable across runs
 *       for the same attendee set; upserts replace the row in place
 *       as new events accrete to an existing group.
 *
 *    6. **Sweep stale.** Delete every existing row of the topic whose
 *       id wasn't refreshed this cycle (group's attendees no longer
 *       present in the corpus, or recurrence dropped below threshold).
 *
 *  Pre-launch zero-installs semantics: the producer is the single
 *  source of truth for `working_group` rows, so eager sweep keeps
 *  orphans from accumulating. */

import { createHash } from 'node:crypto';

import {
  ENRICHMENT_REGISTRY,
  computeHousekeepingMetaTags,
  type EnrichmentTopic,
  type HousekeepingCursor,
  type HousekeepingStepResult,
  type WorkingGroupValue,
} from '@recued/contracts';

import type {
  HousekeepingContext,
  HousekeepingTaskInstance,
} from '../registry.js';
import { canonicalOne, collectAddresses } from './_email-addresses.js';
import { contactName } from './_contact-names.js';
import { listCollectionDataTables } from '../../collections/table.js';
import {
  CALENDAR_ROW_SELECT,
  calendarRowHotFields,
  type CalendarScanRow,
} from './_calendar-rows.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** How far back the calendar scan reaches. 90d matches `topic_cluster`
 *  / `attendee_patterns` so calendar-driven recipes that combine
 *  multiple enrichment surfaces see consistent corpus boundaries. */
export const CALENDAR_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;

/** Hard cap on events folded into one cycle. Calendar volume per pair
 *  rarely exceeds a few thousand events / 90d; the cap is defensive.
 *  Newest-first sort means a corpus over the cap loses the oldest
 *  events — acceptable for working-group recurrence detection. */
export const MAX_EVENTS_SCANNED = 2000;

/** Minimum participants per event before it counts toward a working
 *  group. Excludes 1-on-1s + solo holds. n=3 is the smallest "team"
 *  shape — `meeting_frequency` (A.9) covers per-contact cadence and
 *  `attendee_patterns` (A.8) covers pairwise co-attendance, so the
 *  working-group surface focuses on team-shaped clusters. */
export const MIN_ATTENDEES_PER_EVENT = 3;

/** Minimum recurrence count for a candidate group to emit. A single
 *  event with N people is a meeting, not a working group; 3+ events
 *  with the same attendee set is the recurrence floor — typical
 *  for weekly + biweekly + quarterly cadences within the look-back
 *  window. */
export const MIN_RECURRENCE_PER_GROUP = 3;

/** Cap on emitted groups per cycle. Higher than `MAX_CLUSTERS` (15)
 *  on `topic_cluster` since the deterministic shape carries no AI
 *  cost and the Settings detail-drawer / Memory tab can render more
 *  groups without LLM-budget pressure. */
export const MAX_GROUPS = 30;

/** Hash prefix length on the `derived_entity_id`. 12 hex chars matches
 *  `topic_cluster` for symmetric-looking ids in the warehouse explorer. */
export const ID_HASH_PREFIX_LEN = 12;

/** Per-cycle token estimate for the Run-Now cost preview. Deterministic
 *  — pure SQL aggregation + arithmetic. Zero token spend; idle-eligible
 *  by virtue of `is_ai_surface: false` + `default_trust_state: 'auto'`
 *  resolution from the registry. */
export const TOKEN_ESTIMATE_PER_CYCLE = 0;

/** Authored-by stamp for working_group rows. Keeps Memory feed
 *  attribution clean alongside the four other Shape A / Shape B
 *  housekeeping producers. */
export const WORKING_GROUP_AUTHORED_BY = 'system.housekeeping.working_group';

/** Topic key for this producer's emitted rows. */
export const WORKING_GROUP_TOPIC: EnrichmentTopic = 'working_group';

// ────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────

/** Pull the canonical participant set from a parsed calendar
 *  `hot_fields` object — organizer + attendees, deduplicated, sorted.
 *  Returns the empty array on any non-string organizer + empty
 *  attendee list, mirroring `attendee_patterns` / `related_threads`
 *  behaviour. Includes the organizer (working groups treat the
 *  meeting-series owner as a member). */
export const extractParticipantSet = (
  hot: Record<string, unknown>,
): string[] => {
  const set = new Set<string>();
  const organizer = canonicalOne(hot.organizer);
  if (organizer !== '') set.add(organizer);
  collectAddresses(hot.attendees, set);
  return Array.from(set).sort();
};

/** Compose the stable attendee key. Joining with U+0020 — emails can't
 *  contain a space, so the separator is unambiguous and the key
 *  surfaces readably in audit / debug feeds. */
export const composeAttendeeKey = (participants: ReadonlyArray<string>): string =>
  participants.join(' ');

/** Compose the stable `derived_entity_id` for a working group. Hashes
 *  the attendee key — same attendee set across runs hashes to the same
 *  id, so re-runs upsert in place rather than churning ids. */
export const deriveDerivedEntityId = (attendeeKey: string): string => {
  const digest = createHash('sha1').update(attendeeKey).digest('hex');
  return `working_group_${digest.slice(0, ID_HASH_PREFIX_LEN)}`;
};

/** A scanned calendar event boiled down to the fields the producer
 *  actually consumes. Reduces SQL row narrowing + JS object retention
 *  to a single shape. */
interface ScannedEvent {
  record_id: string;
  start_at: number;
  participants: string[];
}

/** A candidate working group prior to emit — collects events sharing
 *  the same attendee key; recurrence + cap filters apply downstream. */
export interface CandidateGroup {
  attendee_key: string;
  contacts: string[];
  member_event_ids: string[];
  first_event_at: number;
  last_event_at: number;
}

/** Walk every `collection_calendar_*` table for events within the
 *  look-back window. Newest-first across all tables, capped at the
 *  per-cycle limit. */
export const scanRecentEvents = (
  ctx: HousekeepingContext,
  now: number,
  limit: number = MAX_EVENTS_SCANNED,
): ScannedEvent[] => {
  const earliest = now - CALENDAR_LOOKBACK_MS;
  const tables = listCollectionDataTables(ctx.db, 'calendar');

  const all: ScannedEvent[] = [];
  for (const table of tables) {
    const rows = ctx.db
      .prepare(
        `SELECT ${CALENDAR_ROW_SELECT} FROM "${table}"
          WHERE received_at >= ?
          ORDER BY received_at DESC
          LIMIT ?`,
      )
      .all(earliest, limit) as CalendarScanRow[];
    for (const row of rows) {
      const parsed = calendarRowHotFields(row);
      if (parsed === null) continue;
      const startAt = parsed.start_at;
      if (typeof startAt !== 'number' || !Number.isFinite(startAt)) continue;
      const participants = extractParticipantSet(parsed);
      if (participants.length < MIN_ATTENDEES_PER_EVENT) continue;
      all.push({
        record_id: row.record_id,
        start_at: startAt,
        participants,
      });
    }
  }
  // Sort across-table by start_at desc; producer respects the cap on
  // already-collected events (per-table cap inside SQL is ALSO `limit`,
  // but the per-cycle global cap is enforced here).
  all.sort((a, b) => b.start_at - a.start_at);
  return all.slice(0, limit);
};

/** Group events by attendee key into candidate working groups. Newest
 *  events flow in first (`scanRecentEvents` already sorted desc), so
 *  per-group `last_event_at` is the first event seen for the key,
 *  `first_event_at` is the last — track both. */
export const groupByAttendeeSet = (
  events: ReadonlyArray<ScannedEvent>,
): CandidateGroup[] => {
  const groups = new Map<string, CandidateGroup>();
  for (const event of events) {
    const key = composeAttendeeKey(event.participants);
    const existing = groups.get(key);
    if (existing) {
      existing.member_event_ids.push(event.record_id);
      if (event.start_at > existing.last_event_at) {
        existing.last_event_at = event.start_at;
      }
      if (event.start_at < existing.first_event_at) {
        existing.first_event_at = event.start_at;
      }
    } else {
      groups.set(key, {
        attendee_key: key,
        contacts: [...event.participants],
        member_event_ids: [event.record_id],
        first_event_at: event.start_at,
        last_event_at: event.start_at,
      });
    }
  }
  return Array.from(groups.values());
};

/** Filter candidate groups by `MIN_RECURRENCE_PER_GROUP` + cap at
 *  `MAX_GROUPS`. Sorted by event count desc with `last_event_at` desc
 *  tiebreak so the most-active recent groups win the cap. */
export const filterAndCapGroups = (
  groups: ReadonlyArray<CandidateGroup>,
  minRecurrence: number = MIN_RECURRENCE_PER_GROUP,
  cap: number = MAX_GROUPS,
): CandidateGroup[] => {
  const surviving = groups.filter((g) => g.member_event_ids.length >= minRecurrence);
  surviving.sort((a, b) => {
    if (b.member_event_ids.length !== a.member_event_ids.length) {
      return b.member_event_ids.length - a.member_event_ids.length;
    }
    return b.last_event_at - a.last_event_at;
  });
  return surviving.slice(0, cap);
};

/** Build a `WorkingGroupValue` + the stable `derived_entity_id` from
 *  a finalised candidate group. Members deduplicated + sorted for
 *  deterministic JSON output. */
export const assembleGroup = (
  candidate: CandidateGroup,
  now: number,
  resolveName?: (email: string) => string | undefined,
): { value: WorkingGroupValue; derived_entity_id: string } => {
  const members = Array.from(new Set(candidate.member_event_ids)).sort();
  // Bench harvest (P1 v6) — resolved `{ entity, name }` pairs beside the
  // raw `contacts` list, so consumers name the group's people without a
  // lookup. Entries exist only for contacts the directory NAMES. (The
  // `members` → `event_ids` rename the bench also made stays DEFERRED —
  // see the WorkingGroupValue.contacts_resolved NOTE: the cascade
  // engine's `members_field: 'members'` must move in the same change.)
  const contacts_resolved =
    resolveName === undefined
      ? []
      : [...candidate.contacts].sort().flatMap((entity) => {
          const name = resolveName(entity);
          return name === undefined ? [] : [{ entity, name }];
        });
  const value: WorkingGroupValue = {
    contacts: [...candidate.contacts],
    members,
    ...(contacts_resolved.length > 0 ? { contacts_resolved } : {}),
    event_count: members.length,
    last_event_at: candidate.last_event_at,
    first_event_at: candidate.first_event_at,
    computed_at: now,
  };
  return {
    value,
    derived_entity_id: deriveDerivedEntityId(candidate.attendee_key),
  };
};

/** Sweep stale rows: list every existing working_group row, deleteById
 *  any whose id wasn't refreshed this cycle. Pre-launch zero-installs
 *  semantics — eager pruning keeps the warehouse explorer free of
 *  decayed groups. */
export const sweepStaleGroups = (
  ctx: HousekeepingContext,
  freshIds: ReadonlySet<string>,
): { deleted: number } => {
  const existing = ctx.enrichmentStore.list({
    topic: WORKING_GROUP_TOPIC,
    fresh_only: false,
    limit: 1000,
  });
  let deleted = 0;
  for (const row of existing) {
    if (freshIds.has(row._id)) continue;
    if (ctx.enrichmentStore.deleteById(row._id)) deleted += 1;
  }
  return { deleted };
};

// ────────────────────────────────────────────────────────────────
// Step
// ────────────────────────────────────────────────────────────────

/** One-shot scan-and-emit cycle. Exported for direct test access
 *  without the task wrapper. Returns `{ produced }` for caller-side
 *  assertions on cycle output. */
export const runWorkingGroupCycle = (
  ctx: HousekeepingContext,
): { produced: number } => {
  const now = ctx.now();
  const events = scanRecentEvents(ctx, now);
  if (events.length === 0) {
    sweepStaleGroups(ctx, new Set());
    return { produced: 0 };
  }

  const candidates = groupByAttendeeSet(events);
  const groups = filterAndCapGroups(candidates);
  if (groups.length === 0) {
    sweepStaleGroups(ctx, new Set());
    return { produced: 0 };
  }

  const freshIds = new Set<string>();
  let produced = 0;
  for (const candidate of groups) {
    const { value, derived_entity_id } = assembleGroup(candidate, now, (email) =>
      contactName(ctx, email),
    );
    ctx.enrichmentStore.upsert({
      topic: WORKING_GROUP_TOPIC,
      derived_entity_id,
      value,
      authored_by: WORKING_GROUP_AUTHORED_BY,
      event_at: now,
    });
    freshIds.add(derived_entity_id);
    produced += 1;
  }

  sweepStaleGroups(ctx, freshIds);
  return { produced };
};

// ────────────────────────────────────────────────────────────────
// Task instance
// ────────────────────────────────────────────────────────────────

export const workingGroupTask: HousekeepingTaskInstance = {
  meta: {
    id: 'enrichment.working_group',
    description:
      'Detect recurring attendee sets across calendar events; one row per working group.',
    interruptible: true,
    kind: 'enrichment',
    tags: computeHousekeepingMetaTags({
      def: ENRICHMENT_REGISTRY.working_group,
      isAiSurface: false,
    }),
  },
  topic: WORKING_GROUP_TOPIC,
  is_ai_surface: false,

  async step(
    ctx: HousekeepingContext,
    _cursor: HousekeepingCursor,
    _budget_ms: number,
  ): Promise<HousekeepingStepResult> {
    runWorkingGroupCycle(ctx);
    return { status: 'complete', cursor: { kind: 'complete' } };
  },
};

/** Per-cycle token estimate for the Run-Now cost preview. Exposed
 *  separately from the task instance so the rpc handler that builds
 *  the preview can call it without instantiating a step. Always 0
 *  (deterministic). */
export const workingGroupTokenEstimate = (): number => TOKEN_ESTIMATE_PER_CYCLE;

/** Scope-of-read declaration surfaced in the Run-Now scope dialog +
 *  detail drawer. Mirrors the shape the harness validates for Shape A
 *  producers. */
export const workingGroupScopeReadDeclaration = [
  {
    collection: 'data.calendar',
    sample_field_paths: ['organizer', 'attendees', 'start_at', 'record_id'],
  },
] as const;

/** D-210 — the booking CONSUMER surfaces.
 *
 *  Every assertion here guards a site that compiles clean while being wrong,
 *  because the vocabulary was hand-copied rather than derived. The backend
 *  guard (`isWorkEntityKind`) IS derived, so a new kind genuinely works —
 *  which is what makes these failures invisible: the model is simply never
 *  told the kind exists, and no backend test can see the omission. */

import { describe, expect, it } from 'vitest';

import { TIER1_TOOL_DESCRIPTORS, TIER1_TOPIC_TAGS } from '../chat.js';
import { sortEntitiesByDefault } from '../work-entity-page/list-view.js';
import { WORK_ENTITY_NAV } from '../work-entity-page/nav-registry.js';
import {
  WORK_ENTITY_KINDS,
  type Booking,
  type WorkEntity,
} from '../work-entities.js';

const kindEnumOf = (tool: 'work.search' | 'work.read'): readonly string[] => {
  const schema = TIER1_TOOL_DESCRIPTORS[tool].arg_schema as {
    properties: { kind: { enum: readonly string[] } };
  };
  return schema.properties.kind.enum;
};

describe('the model can ask for every work-entity kind', () => {
  it.each(['work.search', 'work.read'] as const)(
    '%s exposes the full kind union, not a copy of it',
    (tool) => {
      expect([...kindEnumOf(tool)].sort()).toEqual([...WORK_ENTITY_KINDS].sort());
    },
  );

  it.each(['work.search', 'work.read'] as const)(
    '%s prose names every kind — an enum the description contradicts is worse than either alone',
    (tool) => {
      const description = TIER1_TOOL_DESCRIPTORS[tool].description;
      for (const kind of WORK_ENTITY_KINDS) {
        expect(description, `${tool} description omits '${kind}'`).toContain(kind);
      }
    },
  );

  it.each(['work.search', 'work.read'] as const)(
    '%s topic tags carry every kind',
    (tool) => {
      const tags = TIER1_TOPIC_TAGS[tool] as readonly string[];
      for (const kind of WORK_ENTITY_KINDS) {
        expect(tags, `${tool} tags omit '${kind}'`).toContain(kind);
      }
    },
  );

  it('tells the model a booking owns its own time, and is not in the calendar', () => {
    // INVERTED at D-210 A.2 (slice 3). This test previously asserted the
    // OPPOSITE — that the description told the model a booking has no time and
    // to follow `calendar_event_source_id` to the event. That guarantee is now
    // false, so the test is re-pointed rather than deleted: the risk it guards
    // is unchanged in shape and only reversed in direction. A model holding the
    // stale belief hunts a calendar event that will never exist and answers
    // "when is it" with a lookup failure, on a row that has the answer.
    for (const tool of ['work.read', 'work.search'] as const) {
      const description = TIER1_TOOL_DESCRIPTORS[tool].description;
      expect(description, `${tool} omits slot_start_at`).toContain('slot_start_at');
      expect(description, `${tool} omits slot_end_at`).toContain('slot_end_at');
      // The disjointness has to be SAID, not merely implied by the presence of
      // the fields — the model's default prior is that an appointment lives in
      // a calendar, and only an explicit negation displaces it.
      expect(description, `${tool} does not deny the calendar`).toMatch(
        /not?\s+(a\s+)?calendar|never\s+(in\s+the\s+)?calendar|do NOT look in the calendar/i,
      );
    }
  });
});

describe('booking nav registration', () => {
  it('registers a spec whose icon name is the kind', () => {
    const spec = WORK_ENTITY_NAV.booking;
    expect(spec.plural_label).toBe('Bookings');
    expect(spec.icon_name).toBe('booking');
    expect(spec.empty_state_copy.length).toBeGreaterThan(0);
  });
});

// ────────────────────────────────────────────────────────────────
// The `break`-style sort switch — silent when an arm is missing
// ────────────────────────────────────────────────────────────────

const booking = (id: string, created_at: number): WorkEntity => ({
  _kind: 'booking',
  id,
  title: `Booking ${id}`,
  lifecycle_state: 'confirmed',
  created_at,
  updated_at: created_at,
  state_changed_at: created_at,
  source_id: 'recued.booking',
  last_seen_at: created_at,
  sync_state: 'live',
  conflict_policy: 'source_wins',
} satisfies { _kind: 'booking' } & Booking);

describe('sortEntitiesByDefault — booking', () => {
  it('sorts newest first', () => {
    const sorted = sortEntitiesByDefault('booking', [
      booking('a', 1_000),
      booking('c', 3_000),
      booking('b', 2_000),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(['c', 'b', 'a']);
  });

  it('is deterministic when two bookings share a timestamp', () => {
    // Without the id tiebreak the pair could reorder between renders, which
    // reads to the owner as the list "moving on its own".
    const input = [booking('z', 5_000), booking('a', 5_000)];
    expect(sortEntitiesByDefault('booking', input).map((e) => e.id)).toEqual(['a', 'z']);
    expect(sortEntitiesByDefault('booking', [...input].reverse()).map((e) => e.id)).toEqual([
      'a',
      'z',
    ]);
  });

  it('does not leave the input in store order — the arm is really running', () => {
    // A missing `case 'booking'` returns the slice untouched and passes any
    // test whose fixture happens to be pre-sorted. This one is not.
    const sorted = sortEntitiesByDefault('booking', [booking('old', 1), booking('new', 9)]);
    expect(sorted[0].id).toBe('new');
  });
});

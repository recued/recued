/** The `data.calendar.combined` overlap counter — "is anything else happening
 *  then?", answered across every calendar the owner has.
 *
 *  ## Why this exists
 *
 *  D-173 D7 put free/busy-vs-your-calendar OUT OF SCOPE and delegated the
 *  judgment to a human: *"you confirm at approval"*. It then never built the
 *  surface to confirm against — the approval showed the owner nothing about
 *  what else was on their calendar at that time. This is that surface's reader.
 *
 *  Since 2026-07-16 the substrate no longer refuses an overlapping booking
 *  (that hard-coded capacity to 1 per endpoint — a 100-table restaurant holds
 *  100 at once). Capacity is a judgment only the owner can make, so the machine
 *  does the part machines are good at — COUNTING — and the owner does the part
 *  only they can — DECIDING. Per [[substrate_enforces_humans]].
 *
 *  ## This count is a safety mechanism, not a decoration
 *
 *  With the refusal gone, **this count is the only thing standing between the
 *  owner and an unnoticed double-book.** They will approve a 4th booking on the
 *  strength of it reading "3". So:
 *
 *    - It counts across **every** calendar instance, not just the local one.
 *      A booking colliding with the owner's dentist appointment in Google
 *      Calendar is exactly the collision they need to see, and a count that
 *      silently skipped a calendar would be a check that looks like assurance
 *      and isn't — worse than showing nothing.
 *    - It uses a real **interval-overlap** predicate. Filtering on `start_at`
 *      alone (the `CalendarListQuery` shape) misses an event that STRADDLES the
 *      window — precisely the long events most worth knowing about.
 *    - A calendar that cannot be read is **reported, never silently skipped**
 *      (`unreadable`). A count is a claim about the world; a claim built on a
 *      partial read must say so, or the owner reads "2" and believes it means
 *      "2" when it means "2 that I could see". [[bounded_read_is_a_leak_for_security_seed_sets]]
 *      is the same shape: a capped read where correctness needs completeness.
 *
 *  ## Scope — why this is not a re-litigation of D7
 *
 *  D7's out-of-scope is the **visitor-facing slot picker**: slots come from the
 *  owner's declared windows, and `NULL_SCHEDULING_CALENDAR_EVENTS_READER` stays
 *  the correct posture there (`wire-reception-substrate.ts`). Nothing here
 *  touches that path. This reader serves the **owner**, at the **gate**, about
 *  **their own** calendar — a different surface, a different audience, and
 *  literally what "confirmed at approval" asks for. Do not wire this into the
 *  visitor path: event intervals are a free/busy disclosure. */

import type { CollectionInstanceStore } from '../instance-store.js';
import type { CalendarCollectionTable } from './calendar-table.js';

/** The result of one overlap count. Deliberately NOT a bare number: the count
 *  is only meaningful alongside how complete the read was. */
export interface CalendarOverlapCount {
  /** Non-cancelled events overlapping the window, summed across every calendar
   *  that could be read. */
  readonly count: number;
  /** How many calendar instances were counted. */
  readonly calendars_read: number;
  /** Slugs of instances that could NOT be read (no table / threw). The count
   *  EXCLUDES these — a non-empty list means `count` is a floor, not a total,
   *  and the surface must say so rather than render a bare number. */
  readonly unreadable: ReadonlyArray<string>;
}

export interface CalendarOverlapCounterDeps {
  /** The collection instance registry — enumerates the owner's calendars. */
  readonly instances: Pick<CollectionInstanceStore, 'list'>;
  /** Resolve one instance's table. Returns null when the instance has no table
   *  yet (enrolled but never synced) — counted as `unreadable`, never as zero. */
  readonly getTable: (slug: string) => CalendarCollectionTable | null;
}

/** Count non-cancelled events overlapping `[window_start, window_end)` across
 *  every enrolled calendar. */
export const countCalendarOverlap = (
  deps: CalendarOverlapCounterDeps,
  window_start: number,
  window_end: number,
): CalendarOverlapCount => {
  if (!(window_end > window_start)) {
    return { count: 0, calendars_read: 0, unreadable: [] };
  }

  let count = 0;
  let calendars_read = 0;
  const unreadable: string[] = [];

  for (const instance of deps.instances.list('calendar')) {
    try {
      const table = deps.getTable(instance.slug);
      if (table === null) {
        unreadable.push(instance.slug);
        continue;
      }
      count += table.overlapCount(window_start, window_end);
      calendars_read += 1;
    } catch {
      // One unreadable calendar must not zero the whole count, and must not
      // vanish from it either — a partial read is reported as partial. The
      // owner is about to make a decision on this number.
      unreadable.push(instance.slug);
    }
  }

  return { count, calendars_read, unreadable };
};

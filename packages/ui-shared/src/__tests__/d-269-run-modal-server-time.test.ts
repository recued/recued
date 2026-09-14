/** D-269 — a scheduled run's picked time, and which clock it was read in.
 *
 *  ⚠ THE DISTINCTION THAT DECIDES THE SHAPE OF THIS FIX. A one-shot's EXECUTION
 *  is not wrong: `datetime-local` is read in the browser's zone, converted to an
 *  absolute instant, and fired at exactly that instant. A recurring CRON was a
 *  real defect because a wall clock with no zone has no answer at all. ⇒ This
 *  one is a DISCLOSURE, not a correction, and conflating the two would mean
 *  "fixing" a one-shot by shifting the instant the owner already chose.
 *
 *  ⛔ AND IT IS SILENT WHEN THE CLOCKS AGREE. A line telling you 09:00 means
 *  09:00 is the line that teaches people to stop reading them — the same
 *  collapse rule as the instant preview, and the opposite call from the
 *  quiet-hours WINDOW, where the date is the content. */

import { describe, expect, it } from 'vitest';
import { describePickedInstantOnServer } from '../two-clock.js';

/** 09:00 in London on 2026-06-15. */
const PICKED = Date.parse('2026-06-15T09:00:00+01:00');

describe('D-269 — what the picked time means on the server', () => {
  it('⛔ says what the owner actually scheduled when the clocks differ', () => {
    const note = describePickedInstantOnServer(PICKED, 'Asia/Hong_Kong', {
      clientZone: 'Europe/London', locale: 'en-GB',
    });
    expect(note).not.toBeNull();
    expect(note).toContain('Asia/Hong_Kong');
    // 09:00 London is 16:00 Hong Kong — the number the owner has not worked out.
    expect(note).toContain('16:00');
  });

  it('⚠ SILENT when the two agree — no line is better than a redundant one', () => {
    expect(describePickedInstantOnServer(PICKED, 'Europe/London', {
      clientZone: 'Europe/London', locale: 'en-GB',
    })).toBeNull();
  });

  it('silent when the server zone is unknown, rather than guessing', () => {
    // A pre-D-269 server answers `not_configured` for the zone; inventing one
    // would put a confident wrong sentence in front of the owner.
    expect(describePickedInstantOnServer(PICKED, undefined)).toBeNull();
    expect(describePickedInstantOnServer(PICKED, '')).toBeNull();
  });

  it('⛔ it reports, it does not SHIFT — the instant is the owner\'s choice', () => {
    // The one-shot fires at the instant picked. A "fix" that moved it to the
    // server's 09:00 would silently reschedule what the owner already decided.
    const a = describePickedInstantOnServer(PICKED, 'Asia/Hong_Kong', {
      clientZone: 'Europe/London', locale: 'en-GB',
    });
    const b = describePickedInstantOnServer(PICKED, 'Asia/Hong_Kong', {
      clientZone: 'Europe/London', locale: 'en-GB',
    });
    expect(a).toBe(b);
  });
});

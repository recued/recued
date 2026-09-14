/** D-269 REV 4 — "which clock is this?", answered in one place.
 *
 *  ⛔⛔ WHY THIS IS SHARED AND NOT A TIMEZONE-PANEL WIDGET. Four surfaces stamp
 *  or read a zone and every one of them asks the owner the same unasked
 *  question: a saved-view alert (stamped at first enable from whichever browser
 *  toggled it), a scheduled mail send and a scheduled recipe run (re-stamped
 *  from the composing browser every time), and the server's own declared zone.
 *  Writing this inside the timezone panel is precisely what would make the other
 *  three "later" — the thing the owner ruled against when they said earlier
 *  consolidation beats later.
 *
 *  🔑 PREVIEW THE TIME, NOT THE ZONE NAME. `Asia/Hong_Kong` is a label;
 *  `22:00 here = 15:00 where you are` is the judgement. The second is what stops
 *  an owner silencing their own working day, and it is the only form that makes
 *  a divergence legible without arithmetic.
 *
 *  ⚠ TWO ROWS ONLY WHEN THEY DIFFER. In the common case (owner at home, or a
 *  laptop install where the server IS this machine) two identical lines are
 *  clutter that trains people to stop reading. The split earns its space exactly
 *  when there IS a difference — which is also the only moment it can prevent a
 *  mistake.
 *
 *  ⛔⛔ THE ROWS MUST NOT READ AS PEERS. The value is SET in the server's zone;
 *  the local row is a TRANSLATION, not a second control. Rendered symmetrically
 *  an owner will try to edit the local one — the two-editors failure arriving
 *  through visual weight instead of through a second input. Hence `role`:
 *  `'authoritative'` renders primary, `'translation'` renders secondary and
 *  indented, and a caller that ignores the distinction is visibly doing so.
 *
 *  ⚠ AND THE TRANSLATION IS PRESENT-TENSE, ALWAYS. The delta between two zones
 *  is not stable: either may observe DST, and they switch on DIFFERENT DATES
 *  (the US on the 2nd Sunday of March, the EU on the last), so for about three
 *  weeks each spring the familiar offset is off by an hour. **A preview that
 *  states "8 hours ahead" as a standing fact is wrong several weeks a year**, so
 *  this renders an instant it was handed and says "right now" — never a stored
 *  equivalence.
 *
 *  Spec: internal design notes D-269 REV 4 / REV 5 / REV 7. */

import { formatClientDateTime } from './date-time.js';

export type TwoClockRole = 'authoritative' | 'translation';

export interface TwoClockRow {
  role: TwoClockRole;
  /** Who this clock belongs to — "Server time", "This browser". */
  label: string;
  /** The IANA zone id. ⚠ SHOWN, deliberately: a human reading a zone label does
   *  not parrot it as a location the way a model does, so the suppression that
   *  keeps this string out of the chat packet does not apply here. The
   *  suppression belongs to the READER, not to the value (REV 7). */
  zone: string;
  /** The instant rendered in `zone`. */
  text: string;
}

export interface TwoClockView {
  rows: TwoClockRow[];
  /** True when the two zones resolve to different wall-clock readings at this
   *  instant. ⚠ Compared on the RENDERED TIME, not on the zone ids: two ids can
   *  differ (`Europe/London` / `Europe/Lisbon`) and agree on the clock, and
   *  showing a "difference" the owner cannot see is how a warning gets ignored. */
  diverged: boolean;
}

export interface TwoClockOptions {
  /** The zone the value is authored in — the server's resolved zone. */
  serverZone: string;
  /** The viewer's own zone. Defaults to this browser's. */
  clientZone?: string;
  /** The instant to render. Defaults to now. */
  at?: number;
  serverLabel?: string;
  clientLabel?: string;
  /** Test seam — pinned so a rendering assertion does not depend on the
   *  runner's locale. */
  locale?: string;
}

/** Build the view. ⚠ RETURNS A MODEL, NOT MARKUP: the two consumers that exist
 *  render into different shells, and a helper that emitted HTML would be
 *  re-implemented by the second one rather than reused. */
export const twoClockPreview = (opts: TwoClockOptions): TwoClockView => {
  const at = opts.at ?? Date.now();
  const clientZone = opts.clientZone
    ?? (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        return 'UTC';
      }
    })();

  const render = (zone: string): string => formatClientDateTime(at, {
    timeZone: zone,
    includeSeconds: false,
    ...(opts.locale === undefined ? {} : { locale: opts.locale }),
  });

  const serverText = render(opts.serverZone);
  const clientText = render(clientZone);

  const server: TwoClockRow = {
    role: 'authoritative',
    label: opts.serverLabel ?? 'Server time',
    zone: opts.serverZone,
    text: serverText,
  };

  // ⛔ The collapse is on the READING, not the ids — see `diverged`. When the
  // clocks agree the owner has nothing to reconcile, so one row is the honest
  // rendering and a second would only teach them to skim.
  if (serverText === clientText) return { rows: [server], diverged: false };

  return {
    rows: [
      server,
      {
        role: 'translation',
        label: opts.clientLabel ?? 'This browser',
        zone: clientZone,
        text: clientText,
      },
    ],
    diverged: true,
  };
};

/** D-269 step 1 — which zone a DURABLE, SERVER-EXECUTED stamp should carry.
 *
 *  ⛔⛔ THREE SURFACES STAMPED THE BROWSER'S ZONE INTO ROWS THE SERVER LATER
 *  EVALUATES: a saved-view alert (frozen at first enable, from whichever browser
 *  toggled it), a scheduled mail send and a scheduled recipe run (re-stamped
 *  from the composing browser every time). All three RUN on the server with no
 *  client attached, so the browser's zone was never the right answer — it was
 *  the only one reachable from where the stamp was made. An alert enabled on a
 *  laptop abroad carried the travel zone forever.
 *
 *  ⚠ NOT THE SAME QUESTION AS THE CHAT CLOCK, AND THE DIFFERENCE IS THE WHOLE
 *  POINT. `chat.send` still sends the BROWSER's zone (D-193), because there the
 *  question is *"what time is it where I am"* and a connected surface is live
 *  evidence of that. Here the question is *"what clock will this be evaluated
 *  on"*, and the answer belongs to the machine that will do the evaluating.
 *  ⇒ Do not "unify" these two call sites; they disagree on purpose.
 *
 *  ⚠ FALLS BACK TO THE BROWSER, DELIBERATELY. A pre-D-269 server answers
 *  `not_configured` and a fetch can simply not have landed yet, and in both
 *  cases stamping today's value is strictly better than stamping nothing —
 *  the field is required and an empty zone would fail the write. */
export const stampZone = (
  serverZone?: (() => string | undefined) | string,
): string => {
  const resolved = typeof serverZone === 'function' ? serverZone() : serverZone;
  if (typeof resolved === 'string' && resolved.length > 0) return resolved;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
};

/** D-269 step 3 follow-on — the same two-clock idea for a WINDOW.
 *
 *  ⛔⛔ A WALL-CLOCK WINDOW CANNOT BE SHOWN AS THE TIMES THE OWNER TYPED. They
 *  set "10pm–8am"; that string does not say WHICH 8am, and translated into the
 *  viewer's zone it may cross midnight at the other end or not at all
 *  (22:00→07:00 Hong Kong is 15:00→00:00 in London). **The cross-date is exactly
 *  what a time-only rendering hides, and exactly what an owner gets wrong.**
 *
 *  ⇒ So the surface shows two things, and the owner's own framing is the right
 *  one: *this is what you set*, then *this is what it actually looks like*:
 *
 *      You set          22:00 → 07:00
 *      Server clock     Mon 15 Jun 22:00  →  Tue 16 Jun 07:00   Asia/Hong_Kong
 *      This browser     Mon 15 Jun 15:00  →  Tue 16 Jun 00:00   Europe/London
 *
 *  ⚠ DATES ON BOTH ROWS, ALWAYS — not only when they differ. The row that
 *  carries no date is the one a reader assumes is "today", and here that guess
 *  is wrong half the time. This is the opposite call from the instant preview,
 *  where a second identical row is noise: for a window the date IS the content. */

export interface TwoClockWindowRow {
  role: TwoClockRole;
  label: string;
  zone: string;
  /** Full date + time of the open, rendered in `zone`. */
  start_text: string;
  /** Full date + time of the close, rendered in `zone`. */
  end_text: string;
  /** True when open and close land on different local dates IN THIS ZONE.
   *  ⚠ Per zone, not per window: the same window crosses in one and not the
   *  other, which is the whole reason the dates are shown. */
  crosses_date: boolean;
}

export interface TwoClockWindowView {
  rows: TwoClockWindowRow[];
  /** The zone-less statement of intent — what the owner typed. */
  declared_text: string;
  /** True when the two clocks disagree about the window's wall times. */
  diverged: boolean;
  /** True when the rendered occurrence is the one running RIGHT NOW. */
  active: boolean;
}

export interface TwoClockWindowOptions {
  serverZone: string;
  clientZone?: string;
  /** The concrete occurrence, resolved by the caller
   *  (`resolveQuietHoursOccurrence`) so this stays a rendering concern. */
  start: number;
  end: number;
  active: boolean;
  /** Minutes since local midnight, for the "you set" line. */
  fromMinute: number;
  toMinute: number;
  serverLabel?: string;
  clientLabel?: string;
  locale?: string;
}

const hhmm = (minute: number): string =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

export const twoClockWindowPreview = (
  opts: TwoClockWindowOptions,
): TwoClockWindowView => {
  const clientZone = opts.clientZone
    ?? (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        return 'UTC';
      }
    })();

  const render = (at: number, zone: string): string => formatClientDateTime(at, {
    timeZone: zone,
    includeSeconds: false,
    includeTimeZone: false,
    ...(opts.locale === undefined ? {} : { locale: opts.locale }),
  });

  const localDate = (at: number, zone: string): string => {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date(at));
    } catch {
      return '';
    }
  };

  const row = (role: TwoClockRole, label: string, zone: string): TwoClockWindowRow => ({
    role,
    label,
    zone,
    start_text: render(opts.start, zone),
    end_text: render(opts.end, zone),
    crosses_date: localDate(opts.start, zone) !== localDate(opts.end, zone),
  });

  const server = row('authoritative', opts.serverLabel ?? 'Server clock', opts.serverZone);
  const client = row('translation', opts.clientLabel ?? 'This browser', clientZone);

  return {
    // ⛔ BOTH ROWS ALWAYS — see the header. A window is not an instant: the
    // collapse that keeps the instant preview quiet would here hide the date
    // the reader most needs.
    rows: [server, client],
    declared_text: `${hhmm(opts.fromMinute)} → ${hhmm(opts.toMinute)}`,
    diverged: server.start_text !== client.start_text,
    active: opts.active,
  };
};


/** D-269 — what a datetime the owner PICKED means on the server's clock.
 *
 *  ⛔⛔ A `datetime-local` FIELD IS READ IN THE BROWSER'S ZONE, and the schedule
 *  that results runs on a machine that may keep a different one. Picking 09:00
 *  in London for a Hong Kong server yields 16:00 there — the INSTANT is correct
 *  and unambiguous, and the owner is still owed the sentence that says so.
 *
 *  ⚠ THE EXECUTION IS NOT WRONG HERE, UNLIKE THE CRON CASE, AND THAT DISTINCTION
 *  IS WORTH KEEPING. A one-shot stores an absolute instant, so it fires exactly
 *  when the owner meant; a recurring cron is a WALL CLOCK and had no zone at
 *  all, which is why that one was a defect and this one is a disclosure.
 *
 *  ⇒ Returns `null` when the two clocks agree — the same collapse rule as the
 *  instant preview, because a line telling you 09:00 means 09:00 is the line
 *  that teaches people to stop reading them. */
export const describePickedInstantOnServer = (
  at: number,
  serverZone: string | undefined,
  opts: { clientZone?: string; locale?: string } = {},
): string | null => {
  if (serverZone === undefined || serverZone.length === 0) return null;
  const clientZone = opts.clientZone
    ?? (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        return 'UTC';
      }
    })();
  const render = (zone: string): string => formatClientDateTime(at, {
    timeZone: zone,
    includeSeconds: false,
    includeTimeZone: false,
    ...(opts.locale === undefined ? {} : { locale: opts.locale }),
  });
  const here = render(clientZone);
  const there = render(serverZone);
  if (here === there) return null;
  return `That is ${there} on the server (${serverZone}).`;
};

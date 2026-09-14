/** D-269 step 3 — quiet hours: one window, per person, consulted by delivery.
 *
 *  ⛔⛔ THE ONE-LINE RULE THE WHOLE DESIGN TURNS ON: **QUIET HOURS SUPPRESSES A
 *  *DELIVERY*, NEVER AN *ASK*, AND NEVER STATE.** Verified when this was scoped:
 *  `approval.list` is a durable queue whose rows are written BEFORE any channel
 *  delivery (D-158 I-2), so an ask exists whether or not anyone was told. Quiet
 *  hours therefore has nothing to say about whether work happens — only about
 *  when the owner is pinged.
 *
 *  ── Why it is ONE window, and not per kind or per record ──────────
 *  Quiet hours is a fact about the PERSON. Tasks do not have bedtimes and a
 *  record has no opinion about when its owner sleeps. What genuinely varies is
 *  whether a KIND may interrupt — a booking starting in fifteen minutes may, a
 *  task due tomorrow may not — so the per-kind knob is a STANCE toward this one
 *  window (`respects_quiet_hours`), not a second window. Six windows would be
 *  six things to keep consistent and nobody would.
 *
 *  ⛔ SHIPS DEFAULT OFF, and that is the only safe default. D-262's AI gate
 *  states the test: it fails OPEN because *"silently disabling every AI producer
 *  would be a safety default the owner cannot see, reach or explain"*. A
 *  default-ON quiet window is that failure exactly — it withholds things nobody
 *  asked to have withheld, and the evidence of the withholding is the
 *  notification that did not arrive. An owner who never opens the setting gets
 *  today's behaviour, unchanged.
 *
 *  ⚠ WALL CLOCK, IN THE SERVER'S DECLARED ZONE. "I sleep at 10pm" stays 10pm
 *  through both DST transitions, so the window is one hour shorter on
 *  spring-forward night and one hour longer on fall-back night — which is what
 *  happens to that night. A fixed duration from a stored instant would slide the
 *  owner's bedtime by an hour twice a year, which is the failure they described.
 *  ⇒ The zone comes from D-269 step 1, and quiet hours CANNOT ARM without one.
 *
 *  Spec: internal design notes D-269 REV 2 Q1/Q2 + REV 5. */

import { zonedWallClockToEpochMs } from './zoned-wall-clock.js';
import type { ServerTimeZoneSetting } from './server-timezone.js';
import { isServerTimeZoneConfigured } from './server-timezone.js';

/** What the window is allowed to delay.
 *
 *  ⚠ `'approval'` IS IN THIS LIST AS OF STEP 5, AND IS STILL NOT THE
 *  RECOMMENDATION — see `QUIET_HOURS_APPROVAL_IS_NOT_RECOMMENDED`. It was
 *  deliberately absent until the pre-approval affordance existed beside it. The
 *  owner ruled that quiet hours MAY apply to approvals but that it is not the
 *  recommendation, because D-261 pre-approval gets the same silence without the
 *  work waiting — and because the residue pre-approval cannot cover (a reactive
 *  recipe answering an event that has not happened yet cannot be frozen) is
 *  exactly the part most likely to be time-critical. It ships LAST, beside the
 *  pre-approval pointer.
 *
 *  ⚠ A pre-step-5 server therefore REFUSES `'approval'` rather than accepting
 *  and ignoring it — which is the loud failure, and the right one: a policy the
 *  owner believes is on and which silently is not would be worse than an error. */
export const QUIET_HOURS_APPLIES_TO = ['notification', 'approval'] as const;

/** ⛔⛔ THE ONE VALUE WHOSE WORTH IS NEGATIVE WHEN CHOSEN CARELESSLY, WHICH IS
 *  WHY IT SHIPS LAST AND BESIDE THE PRE-APPROVAL POINTER.
 *
 *  The owner's ruling: quiet hours MAY apply to approvals, *"but that wouldn't
 *  be our recommendation because we have the pre-approval built and it is better
 *  be used for this matter"*. Compare what each buys:
 *
 *    pre-approval (D-261)  silence AND the work proceeds   you must anticipate it
 *    quiet hours on an ask silence, and the work WAITS     the expiry hazard below
 *
 *  ⇒ **Quiet hours on approvals buys silence at the cost of the work;
 *  pre-approval buys silence at no cost to the work.**
 *
 *  ⛔ AND THE RESIDUE PRE-APPROVAL CANNOT REACH IS THE DANGEROUS PART. D-261
 *  §14.2: *"Eligibility still requires a complete frozen invocation"* — a
 *  reactive recipe answering an event that has not happened yet is INELIGIBLE BY
 *  CONSTRUCTION. So the asks this setting would silence are exactly the ones
 *  pre-approval cannot pre-empt, which are also the ones most likely to be
 *  time-critical. */
export const QUIET_HOURS_APPROVAL_IS_NOT_RECOMMENDED = true;
export type QuietHoursAppliesTo = (typeof QUIET_HOURS_APPLIES_TO)[number];

export const MINUTES_PER_DAY = 24 * 60;

/** The window. Minutes since local midnight, `[from, to)`.
 *
 *  ⚠ MINUTES, NOT A STRING. "22:00" needs parsing, invites a timezone suffix
 *  nobody meant, and makes the cross-midnight comparison a string problem. An
 *  integer in `[0, 1440)` is comparable and cannot carry a second zone. */
export interface QuietHoursPolicy {
  /** ⛔ Default false — see the header. */
  enabled: boolean;
  from_minute: number;
  to_minute: number;
  applies_to: QuietHoursAppliesTo[];
  updated_at: number;
}

export const DEFAULT_QUIET_HOURS_FROM_MINUTE = 22 * 60; // 22:00
export const DEFAULT_QUIET_HOURS_TO_MINUTE = 7 * 60;    // 07:00

export const defaultQuietHoursPolicy = (updated_at = 0): QuietHoursPolicy => ({
  enabled: false,
  from_minute: DEFAULT_QUIET_HOURS_FROM_MINUTE,
  to_minute: DEFAULT_QUIET_HOURS_TO_MINUTE,
  applies_to: ['notification'],
  updated_at,
});

export const isValidQuietHoursMinute = (value: unknown): value is number =>
  typeof value === 'number'
  && Number.isInteger(value)
  && value >= 0
  && value < MINUTES_PER_DAY;

/** Local minutes-since-midnight for an instant in an IANA zone.
 *
 *  ⚠ Reads the LOCAL CLOCK rather than converting a wall time to an instant,
 *  because that is the actual question ("what time is it there now") and it has
 *  no DST gap: every instant has exactly one local reading, while a wall time
 *  can have none or two. ⇒ The spring-forward gap simply cannot arise here. */
export const localMinuteOfDay = (instant: number, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return (hour % 24) * 60 + minute;
};

/** Is `minute` inside `[from, to)`?
 *
 *  ⛔ CROSS-MIDNIGHT IS THE NORMAL CASE, NOT AN EDGE. 22:00 → 07:00 has
 *  `from > to`, and a naive `from <= m && m < to` is false for every minute of
 *  it — the window would silently never be active, which is the worst possible
 *  failure for a feature whose only evidence is a notification that did not
 *  arrive. */
export const isMinuteWithinWindow = (
  minute: number,
  from: number,
  to: number,
): boolean => {
  // ⚠ An empty window (from === to) means NOTHING is quiet. The alternative
  // reading — "all day" — would let a single mis-set field silence everything
  // forever, and silence is exactly what an owner cannot notice.
  if (from === to) return false;
  return from < to
    ? minute >= from && minute < to
    : minute >= from || minute < to;
};

/** Whether the window is active at `instant` in `timeZone`. */
export const isWithinQuietHours = (
  policy: QuietHoursPolicy,
  instant: number,
  timeZone: string,
): boolean => {
  if (!policy.enabled) return false;
  return isMinuteWithinWindow(
    localMinuteOfDay(instant, timeZone),
    policy.from_minute,
    policy.to_minute,
  );
};

/** ⛔⛔ CAN QUIET HOURS ARM AT ALL? The gate is a RESOLVABLE zone, not a DECLARED
 *  one: `follows_host` satisfies it with nothing typed, so a laptop owner never
 *  picks a zone and quiet hours still works. Expressing this as `zone !== null`
 *  would block the one deployment that needs it least. */
export const canArmQuietHours = (
  timezone: ServerTimeZoneSetting | null | undefined,
): boolean => isServerTimeZoneConfigured(timezone);

/** The decision the emit points ask.
 *
 *  ⚠ PURE, AND TAKES THE KIND'S STANCE RATHER THAN LOOKING IT UP, so the two
 *  policies stay separable: this function knows nothing about which kinds exist,
 *  and the per-kind policy knows nothing about clocks. */
export const shouldSuppressForQuietHours = (args: {
  policy: QuietHoursPolicy;
  instant: number;
  timeZone: string;
}): boolean => {
  // ⛔⛔ NO PER-KIND ESCAPE HATCH. The window took a `kindRespects` argument until
  // 2026-09-13, letting a kind declare itself exempt — which made "quiet hours"
  // mean something different for each row and put a notification-policy question
  // inside this one. A master silencer silences. What you are told about, and how
  // far ahead, is the other panel's job. (D-269 REV 15.)
  if (!args.policy.applies_to.includes('notification')) return false;
  return isWithinQuietHours(args.policy, args.instant, args.timeZone);
};

/** ⛔⛔ MAY THIS ASK'S DELIVERY BE HELD UNTIL THE WINDOW ENDS?
 *
 *  Three conditions, and the third is the one that keeps the feature honest:
 *
 *   1. the window applies to approvals at all (opt-in, never the default), and
 *   2. it is active now, and
 *   3. **the ask's work does NOT expire inside the window.**
 *
 *  ⛔ (3) IS THE ONLY PLACE QUIET HOURS CAN COST SOMETHING REAL. An ask is
 *  durable by construction — D-158 I-2 persists it BEFORE any delivery — so
 *  holding the ping loses nothing *unless the work itself expires before the
 *  owner wakes*. Then the hold is not a deferral, it is a deletion wearing a
 *  deferral's clothes. ⇒ Such an ask is DELIVERED ANYWAY: it breaks quiet hours
 *  rather than silently dropping work, which is the one thing the design says
 *  must never happen.
 *
 *  ⚠ `expires_at` is DECLARED BY THE RAISER, not inferred, because the block
 *  cannot read it: `PendingAsk` carries no deadline and `handler_payload` is an
 *  opaque `Record<string, unknown>`. **An ask that declares no expiry is
 *  treated as not expiring** — which is why the default must be conservative in
 *  the other direction: a caller that knows its work expires has to say so. */
export const mayHoldAskForQuietHours = (args: {
  policy: QuietHoursPolicy;
  instant: number;
  timeZone: string;
  /** When the work behind this ask stops being doable, if the raiser knows. */
  expiresAt?: number;
  /** When the window will release — an ask expiring before this is delivered. */
  windowEndsAt?: number;
}): boolean => {
  if (!args.policy.applies_to.includes('approval')) return false;
  if (!isWithinQuietHours(args.policy, args.instant, args.timeZone)) return false;
  if (args.expiresAt !== undefined && args.windowEndsAt !== undefined) {
    // ⛔ Expires before the owner wakes ⇒ deliver now and break the window.
    if (args.expiresAt <= args.windowEndsAt) return false;
  }
  return true;
};

export interface QuietHoursGetResponse {
  policy: QuietHoursPolicy;
  /** ⚠ Whether it CAN be armed, and the zone it would use — a client cannot
   *  compute either (under `follows_host` the zone is the server's host
   *  reading), and a toggle that silently does nothing is worse than a disabled
   *  one that says why. */
  can_arm: boolean;
  resolved_zone: string;
}

export interface QuietHoursSetRequest {
  enabled?: boolean;
  from_minute?: number;
  to_minute?: number;
  applies_to?: QuietHoursAppliesTo[];
}

export type QuietHoursSetResponse = QuietHoursGetResponse;

/** One CONCRETE occurrence of the window — real instants, not wall times.
 *
 *  ⛔⛔ WHY A WINDOW CANNOT BE SHOWN AS "10pm–8am". That string does not say
 *  WHICH 8am, and for a viewer in another zone it may not even cross midnight
 *  in the same place — 22:00→07:00 Hong Kong is 15:00→00:00 in London, which
 *  crosses at the other end. **The cross-date is exactly the part a time-only
 *  rendering hides**, and it is the part an owner gets wrong.
 *
 *  ⇒ A surface renders THESE, with dates, in both clocks. */
export interface QuietHoursOccurrence {
  /** Epoch ms the window opens. */
  start: number;
  /** Epoch ms it closes (exclusive), always `> start`. */
  end: number;
  /** True when `at` falls inside `[start, end)` — i.e. this is the occurrence
   *  the owner is IN rather than the next one. */
  active: boolean;
}

/** Resolve the occurrence an owner should be shown at `at`.
 *
 *  ⚠ SHOWS THE ONE YOU ARE IN, NOT ALWAYS THE NEXT. Asked at 02:00 inside a
 *  22:00→07:00 window, "the next occurrence" is tonight — which is true and
 *  useless; what the owner wants to read is *"quiet until 07:00 this morning"*.
 *  So an active window reports itself, and only an inactive one looks forward.
 *
 *  ⚠ Returns `null` for an empty window (`from === to`), matching
 *  `isMinuteWithinWindow`: nothing is quiet, so there is no occurrence to draw.
 *  Also `null` on an unusable zone rather than throwing — a preview must not be
 *  able to take a settings page down. */
export const resolveQuietHoursOccurrence = (
  policy: Pick<QuietHoursPolicy, 'from_minute' | 'to_minute'>,
  timeZone: string,
  at: number,
): QuietHoursOccurrence | null => {
  if (policy.from_minute === policy.to_minute) return null;

  /** The local calendar date at `instant`, `YYYY-MM-DD`, in the zone. */
  const localDate = (instant: number): string | null => {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date(instant));
    } catch {
      return null;
    }
  };

  const hhmm = (minute: number): string =>
    `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

  /** The instant `from_minute` falls on, for the local day containing `seed`. */
  const openOn = (seed: number): number | null => {
    const date = localDate(seed);
    if (date === null) return null;
    return zonedWallClockToEpochMs(`${date}T${hhmm(policy.from_minute)}`, timeZone);
  };

  const DAY_MS = 24 * 60 * 60 * 1000;
  // ⚠ The window may have opened YESTERDAY and still be running — the whole
  // point of a cross-midnight window. So the candidate opens are today's and
  // yesterday's, and the first one that still contains `at` wins.
  for (const seed of [at - DAY_MS, at]) {
    const start = openOn(seed);
    if (start === null) continue;
    const end = closeAfter(start, policy, timeZone);
    if (end === null) continue;
    if (at >= start && at < end) return { start, end, active: true };
  }

  // Not inside one: the next open is today's if it is still ahead, else
  // tomorrow's.
  for (const seed of [at, at + DAY_MS]) {
    const start = openOn(seed);
    if (start === null) continue;
    if (start < at) continue;
    const end = closeAfter(start, policy, timeZone);
    if (end === null) continue;
    return { start, end, active: false };
  }
  return null;
};

/** The close instant for a window that opened at `start`.
 *
 *  ⚠ COMPUTED FROM THE LOCAL DAY, NOT `start + duration`. A window spanning a
 *  DST transition is not a fixed number of hours — 22:00→07:00 is eight hours
 *  on spring-forward night and ten on fall-back — and "I sleep until 7" means
 *  7, not "nine hours after 10". */
const closeAfter = (
  start: number,
  policy: Pick<QuietHoursPolicy, 'from_minute' | 'to_minute'>,
  timeZone: string,
): number | null => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const crossesMidnight = policy.to_minute <= policy.from_minute;
  const closeDaySeed = crossesMidnight ? start + DAY_MS : start;
  let date: string;
  try {
    date = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(closeDaySeed));
  } catch {
    return null;
  }
  const hh = String(Math.floor(policy.to_minute / 60)).padStart(2, '0');
  const mm = String(policy.to_minute % 60).padStart(2, '0');
  return zonedWallClockToEpochMs(`${date}T${hh}:${mm}`, timeZone);
};

/** D-269 step 4 — what the owner is told when the window ends.
 *
 *  ⛔⛔ A QUERY, NOT A REPLAYED QUEUE, AND THAT IS THE WHOLE DESIGN. Nothing is
 *  held during the window: `durable-outbox` states the test for whether a
 *  message needs storing — *"would the receiver be unable to RECONSTRUCT it"* —
 *  and a reminder is fully reconstructable from its anchor plus the kind's
 *  offset. **The anchor rows ARE the queue.** At release the sweep re-runs its
 *  own classification over current state and renders one card.
 *
 *  🔑 AND RECOMPUTING IS NOT MERELY CHEAPER, IT IS MORE CORRECT. A queue of held
 *  notifications delivers a reminder for a booking that was CANCELLED at 03:00 —
 *  it replays a fact that has stopped being true. Recomputation cannot.
 *
 *  ⚠ ONE CARD, NOT ONE PER MISS — D-266's ruling, reused rather than re-minted:
 *  *"per-miss asks are what makes the strongest option the first one an owner
 *  switches off"*. A window that silences a hundred reminders and then fires a
 *  hundred at 07:00 has moved the noise, not removed it. */
export interface QuietHoursDigestItem {
  kind: string;
  id: string;
  title: string;
  /** The anchor instant this reminder is about. */
  anchor_at: number;
}

export interface QuietHoursDigest {
  /** The window that just ended. */
  from: number;
  to: number;
  /** ⛔ STILL ACTIONABLE — the anchor has not passed. These are listed, because
   *  the owner can still do something about them. */
  still_ahead: QuietHoursDigestItem[];
  /** ⛔ ALREADY GONE — the anchor passed inside the window. **COUNTED, NOT
   *  LISTED**, and that asymmetry is deliberate: *"catch up" for a reminder is
   *  NOT "fire it now"*. Replaying a 07:00 reminder for an 08:00 meeting is
   *  useful; replaying one for a meeting at 23:00 last night is noise
   *  pretending to be diligence. ⚠ But the COUNT is kept, because it is the
   *  record of what the window cost — the same role the miss count plays in
   *  D-266, and the only way an owner learns the window took something. */
  already_passed: number;
}

/** Split anchored rows into the digest's two halves.
 *
 *  ⚠ PURE, AND TAKES ROWS RATHER THAN A STORE, so the split is testable without
 *  a database and the sweep owns the query. */
export const buildQuietHoursDigest = (
  items: ReadonlyArray<QuietHoursDigestItem>,
  window: { from: number; to: number },
  now: number,
): QuietHoursDigest => {
  const still_ahead: QuietHoursDigestItem[] = [];
  let already_passed = 0;
  for (const item of items) {
    if (item.anchor_at > now) still_ahead.push(item);
    else already_passed += 1;
  }
  // Soonest first — the owner reads the top of a card, and the thing happening
  // next is the thing they can still act on.
  still_ahead.sort((a, b) => a.anchor_at - b.anchor_at);
  return { from: window.from, to: window.to, still_ahead, already_passed };
};

/** True when the digest has nothing to say. ⛔ An EMPTY digest must not be sent:
 *  a card that says "nothing happened while you were away" every morning is the
 *  notification an owner turns off, and taking the feature with it. */
export const isQuietHoursDigestEmpty = (d: QuietHoursDigest): boolean =>
  d.still_ahead.length === 0 && d.already_passed === 0;

/** Render the digest as the owner's card.
 *
 *  ⛔⛔ THE SPLIT IS THE MESSAGE, NOT DECORATION. "Catch up" for a reminder is
 *  NOT "fire it now": replaying a 07:00 reminder for an 08:00 meeting is useful,
 *  replaying one for a meeting at 23:00 last night is noise pretending to be
 *  diligence. So the things still ahead are LISTED — the owner can act on them —
 *  and the things already gone are COUNTED, because the count is the record of
 *  what the window cost and the only way they learn it took something.
 *
 *  ⚠ Lives in contracts beside the shape rather than in the server, because the
 *  same card has to render in a webclient surface later and a second renderer
 *  would drift from this one on its first edit. */
export const renderQuietHoursDigest = (
  digest: QuietHoursDigest,
  timeZone?: string,
): string => {
  const clock = (at: number): string => {
    try {
      return new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        ...(timeZone === undefined ? {} : { timeZone }),
      }).format(new Date(at));
    } catch {
      return '';
    }
  };

  const lines: string[] = [`Quiet hours ran ${clock(digest.from)} → ${clock(digest.to)}.`];

  if (digest.still_ahead.length > 0) {
    lines.push('');
    lines.push('Still ahead:');
    for (const item of digest.still_ahead) {
      lines.push(`· ${item.title} — ${clock(item.anchor_at)}`);
    }
  }
  if (digest.already_passed > 0) {
    lines.push('');
    // ⚠ Counted, and named as a deadline rather than listed: the owner cannot
    // act on these, and a list of them reads as a to-do list of failures.
    lines.push(
      digest.already_passed === 1
        ? '1 deadline passed while you were away.'
        : `${digest.already_passed} deadlines passed while you were away.`,
    );
  }
  return lines.join('\n');
};

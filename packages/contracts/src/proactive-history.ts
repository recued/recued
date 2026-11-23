import type { AssetEvidence, AssetRule, Sphere } from './assets.js';
import { isAssetDate } from './assets.js';
import { zonedWallClockToEpochMs } from './zoned-wall-clock.js';
import type { SituationBasis, SituationPlace, SituationRef, SituationWindow } from './situation.js';

export interface Episode {
  id: string;
  title: string;
  when: SituationWindow;
  where?: SituationPlace;
  people: string[];
  subjects: SituationRef[];
  evidence: AssetEvidence[];
  basis: SituationBasis;
  class_id?: string;
  notes?: string;
  occasion_id?: string;
  /** Versioned assembly rule, so an owner correction scores that rule. */
  assembly_rule?: 'owner_record.v1' | 'plan_trace.v1' | 'trace_only.v1';
  sphere?: Sphere;
  sensitive: Array<'health' | 'pregnancy' | 'money_under_stress' | 'relationships'>;
  storage_reason: 'owner_record' | 'owner_correction' | 'owner_annotation' | 'proposal_citation' | 'recurrence';
  /** D-343 slice 2 — set on the owner's closing record (`episode.record`): what they reported
   *  for the day. A skipped record says what did not happen, so a reader that means "what
   *  you did" leaves it out, and the owner's own lists mark it. Absent on every other episode. */
  outcome?: 'done' | 'skipped';
  created_at: number;
  updated_at: number;
}
export type EpisodeInput = Omit<Episode, 'id' | 'created_at' | 'updated_at'> & { id?: string };
export interface RetainedHistoryEvidence {
  id: string; title: string; when: SituationWindow; people: string[]; where?: SituationPlace;
  class_id: string; sources: SituationRef[]; retained_at?: number; source_mailbox?: string;
}
export interface Occasion {
  id: string;
  title: string;
  class_id?: string;
  /** Month and day; annual dates compute their next year at read time.
   * A one-time date uses source_next_on instead. February 29 falls on
   * February 28 in a common year. */
  month_day: string;
  people: string[];
  where?: SituationPlace;
  source?: SituationRef;
  /** Host source reconciliation can suspend a removed/hidden source without
   * changing the owner's mute choice or overwriting an owner-edited series. */
  source_active?: boolean;
  source_pinned?: boolean;
  /** A one-time occasion or expanded calendar series uses its actual next date. Null means no
   * future instance is known; it must not fall back to an invented recurrence. */
  source_next_on?: string | null;
  sphere?: Sphere;
  muted: boolean;
  /** D-407 slice 3 (Q4) — the owner's choice, or the AI's on the owner's approval: `true` is Private (the
   *  owner's messages call it only "Reminder in Yours", as they do its calendar event, and a model reading it
   *  is told it is private), `false` is Shown by name. Absent on an occasion saved before, and on one nobody
   *  chose for: then `occasionIsPrivate`'s rule decides. A server before slice 3 stores it unread
   *  (`YoursSnapshot.occasion_privacy` says one reads it). */
  private?: boolean;
  /** D-407 slice 2 — comes back whenever the last one says (a doctor, a dentist): `source_next_on` is the next one,
   *  and once it is past Recued asks "When is the next one?" (`occasionWaitingForNext`). The answer sets the next one;
   *  "No next one" takes this away, leaving a one-time occasion that has happened. A server before slice 2 stores it
   *  unread (`YoursSnapshot.occasion_next` says one reads it). */
  after_each?: true;
  /** D-407 slice 2 (Q2) — its time of day, HH:mm on `time_zone`'s clock: the appointment's own zone, since a hospital
   *  in another state can be in another. Both or neither. Absent: a day, as Yours' dates are. */
  time?: string;
  time_zone?: string;
  /** D-407 (the owner, 2026-11-21, "2 hours before", Q2) — with a `time`, alert this many minutes before it, 0 at the
   *  time, at most a day. Sent by the occasion's own engine at that instant, once for each date; ⛔ never a Data →
   *  Reminders record (the owner: "if occasion has its own reminder then it should not bind to the data.reminders").
   *  An occasion in the owner's calendar will alert from its event instead (slice 4), never both. A server before it
   *  stores it unread (`YoursSnapshot.occasion_alert` says one reads it). */
  alert_minutes?: number;
  /** D-407 slice 4 (Q3, Q4) — *In my calendar*: its own event goes in the calendar the owner chose once for occasions
   *  (`YoursSnapshot.settings.occasion_calendar`), written, moved, marked and alerted with it and removed with it. Absent
   *  or false: Recued only, no event anywhere. Only an occasion of the owner's own (no `source`): a contact's date or a
   *  calendar series is dated by its source. */
  in_calendar?: boolean;
  /** Rows on next_on, with the same closed grammar as asset clocks. */
  rules: AssetRule[];
  created_at: number;
  updated_at: number;
}
export type OccasionInput = Omit<Occasion, 'id' | 'created_at' | 'updated_at'> & { id?: string };
/** D-407 slice 3 (Q4) — whether an occasion is private: its own choice when it has one, else the rule before
 *  per-occasion privacy, so an occasion private before stays private: one with a person in it (a birthday, an
 *  anniversary, a doctor). A value is read only when it is `true` or `false`: an older server stored whatever
 *  a client sent, unchecked. One rule for the server and the app (the form's start state). */
export const occasionIsPrivate = (occasion: Pick<Occasion, 'people'> & { private?: unknown }): boolean =>
  typeof occasion.private === 'boolean' ? occasion.private : occasion.people.length > 0;
/** D-407 slice 2 (Q2) — a time of day as an occasion keeps one. */
export const OCCASION_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
/** Whether an IANA zone reads (`Intl` knows it). */
export const isOccasionTimeZone = (zone: unknown): zone is string =>
  typeof zone === 'string' && zone.length > 0 && zonedWallClockToEpochMs('2000-01-01T00:00', zone) !== null;
/** D-407 slice 2 (Q2) — an occasion's time of day on a day, as an instant: undefined with no time, or with a time or zone
 *  an older server stored unchecked that does not read. */
export const occasionTimeOn = (occasion: { time?: unknown; time_zone?: unknown }, day: string): number | undefined =>
  typeof occasion.time === 'string' && OCCASION_TIME.test(occasion.time) && isOccasionTimeZone(occasion.time_zone)
    ? zonedWallClockToEpochMs(`${day}T${occasion.time}`, occasion.time_zone) ?? undefined : undefined;
/** The most an occasion's alert comes before its time: a day. */
export const OCCASION_ALERT_MINUTES_MAX = 1440;
/** An alert's minutes as an occasion keeps them: a whole number from 0 to a day. */
export const isOccasionAlertMinutes = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= OCCASION_ALERT_MINUTES_MAX;
/** D-407 — the instant an occasion's alert goes on a day, its time less its minutes; undefined with no time or no
 *  alert, or with either as an older server stored it unchecked. */
export const occasionAlertAt = (occasion: { time?: unknown; time_zone?: unknown; alert_minutes?: unknown }, day: string): number | undefined => {
  const at = occasionTimeOn(occasion, day);
  return at === undefined || !isOccasionAlertMinutes(occasion.alert_minutes) ? undefined : at - occasion.alert_minutes * 60_000;
};
/** D-407 slice 2 — the date an occasion that comes back whenever the last one says last happened, once it is past and
 *  no next one is set: Recued asks "When is the next one?" from the day after. Undefined otherwise. A value an older
 *  server stored unchecked counts only when it is `true`. */
export const occasionWaitingForNext = (occasion: Pick<Occasion, 'source_next_on'> & { after_each?: unknown }, today: string): string | undefined =>
  occasion.after_each === true && typeof occasion.source_next_on === 'string' && isAssetDate(occasion.source_next_on)
    && occasion.source_next_on < today ? occasion.source_next_on : undefined;
/** P27 — an occasion rings every year: one on 29 February falls on 28 February in
 * a common year, rather than going silent three years in four. */
export const nextAnnualDate = (month_day: string, from: string): string | null => {
  const suffix = month_day.startsWith('--') ? month_day.slice(2) : month_day;
  if (!/^\d{2}-\d{2}$/u.test(suffix) || !isAssetDate(`2000-${suffix}`) || !isAssetDate(from)) return null;
  const year = Number(from.slice(0, 4));
  for (let next = year; next <= Math.min(9999, year + 8); next += 1) {
    const exact = `${String(next).padStart(4, '0')}-${suffix}`;
    const date = isAssetDate(exact) ? exact : suffix === '02-29' ? `${String(next).padStart(4, '0')}-02-28` : null;
    if (date !== null && date >= from) return date;
  }
  return null;
};
export const occasionNextDate = (occasion: Pick<Occasion, 'month_day' | 'source_next_on'>, from: string): string | null =>
  occasion.source_next_on !== undefined ? (occasion.source_next_on !== null && isAssetDate(occasion.source_next_on) && occasion.source_next_on >= from ? occasion.source_next_on : null)
    : nextAnnualDate(occasion.month_day, from);

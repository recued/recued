/** D-339 slice 15 (D-339 §6) — a goal on a Body's reading, kept as a pursuit (D-342 §17).
 *  The owner: *"body fat, weight, muscle are normal numbers that can be compared with ideal or set"*.
 *
 *  A goal is the owner's own number for one body-composition reading. Its progress is the Body's
 *  reading, worked out when read (`BodyGoalProgress`), never stored on the pursuit. */
import { BODY_MEASURE_FIELDS } from './body-chat.js';

/** The readings a goal can be set on: body composition. Heart rate, blood oxygen, blood sugar,
 *  breathing rate and HRV are judged by their pattern, not an ideal, so they take none. */
export const BODY_GOAL_FIELDS = ['weight', ...BODY_MEASURE_FIELDS] as const;
export type BodyGoalField = (typeof BODY_GOAL_FIELDS)[number];
export const isBodyGoalField = (value: unknown): value is BodyGoalField =>
  typeof value === 'string' && (BODY_GOAL_FIELDS as readonly string[]).includes(value);
/** The setting a pursuit keeps its goal in. */
export const BODY_GOAL_SETTING = 'goal';
/** The class of asset a goal is on: the Body signals pack's Body. */
export const BODY_CLASS_ID = 'body';
/** D-339 slice 19 — the Body's writer: the Body signals pack's summary, set up by itself when a Body is added. */
export const BODY_SUMMARY_RECIPE_ID = 'summarize-body-signals';
/** D-339 slice 20 — a ring or a watch, and its writer: the check that it is syncing, set up by itself once the
 *  Wearable belongs to a Body. */
export const WEARABLE_CLASS_ID = 'wearable';
export const WEARABLE_CHECK_RECIPE_ID = 'check-wearable-sync';

export interface BodyGoal {
  /** The Body it is on. */
  asset_id: string;
  reading: BodyGoalField;
  /** The number worked toward, in `unit`: the reading's unit when the goal was set. */
  target: number;
  unit: string;
  /** The reading when the goal was set, and the day that reading was for. It says which way is
   *  toward the target. The server takes it from the Body, never from the page. */
  start: number;
  start_day: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
/** A pursuit's goal, from its settings; undefined when it has none, or keeps something that is not one. */
export const readBodyGoal = (settings: Readonly<Record<string, unknown>> | null | undefined): BodyGoal | undefined => {
  const raw = settings?.[BODY_GOAL_SETTING];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const goal = raw as Record<string, unknown>;
  if (typeof goal.asset_id !== 'string' || !goal.asset_id || !isBodyGoalField(goal.reading)) return undefined;
  if (typeof goal.target !== 'number' || !Number.isFinite(goal.target) || typeof goal.start !== 'number' || !Number.isFinite(goal.start)) return undefined;
  if (typeof goal.unit !== 'string' || !goal.unit || typeof goal.start_day !== 'string' || !DAY.test(goal.start_day)) return undefined;
  return { asset_id: goal.asset_id, reading: goal.reading, target: goal.target, unit: goal.unit, start: goal.start, start_day: goal.start_day };
};
/** Which way the target lies from where the goal started. */
export const bodyGoalWay = (goal: Pick<BodyGoal, 'start' | 'target'>): 'down' | 'up' => goal.target < goal.start ? 'down' : 'up';

/** What the server works out for a goal from its Body when read. Never stored. */
export interface BodyGoalProgress {
  /** The pursuit the goal is kept on, its name, and its target date: a Body's page shows the goal
   *  without reading the pursuit. */
  pursuit_id: string;
  name: string;
  target_on?: string;
  goal: BodyGoal;
  way: 'down' | 'up';
  /** The Body's latest reading, in the goal's unit, and the day it is for. */
  now?: { value: number; day: string };
  /** What is left, in the goal's unit: 0 once at or past the target. */
  to_go?: number;
  /** The average of the last 7 days, and how many of them were measured (4 at least). */
  week?: { value: number; days: number };
  /** The pace over the trend's days (14 at least), in the goal's unit a week, signed the goal's way:
   *  above 0 is toward the target. */
  per_week?: number;
  /** The weeks left at that pace, when it is toward the target and the target is not reached yet. */
  weeks_left?: number;
  /** The 7-day average is at or past the target. */
  reached: boolean;
  /** Why there is no progress: the Body is gone, its reading has another unit now, or has no value. */
  problem?: 'body_gone' | 'other_unit' | 'no_value';
}

/** D-339 slice 16 — the owner's own normal for a reading, kept on the Body as `settings.ranges`, one a
 *  reading: a low, a high or both, its unit, and the day it was set. Not a pursuit: nothing ends. The
 *  owner: *"someone with special illness will never have the normal ideal numbers but one's own best
 *  fit numbers"*. */
export const BODY_RANGES_SETTING = 'ranges';
/** Past this many days a set range asks to be checked (*"a time sensitive matter of the set numbers"*). */
export const BODY_RANGE_REVIEW_DAYS = 180;
export interface BodyRange {
  low?: number;
  high?: number;
  unit: string;
  /** The day it was set, or last said to be still right. */
  set_on: string;
}
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
/** One range, or undefined when what is kept is not one. */
export const readBodyRange = (raw: unknown): BodyRange | undefined => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const range = raw as Record<string, unknown>;
  const low = positive(range.low) ? range.low : undefined; const high = positive(range.high) ? range.high : undefined;
  if (low === undefined && high === undefined || low !== undefined && high !== undefined && low >= high) return undefined;
  if (typeof range.unit !== 'string' || !range.unit || typeof range.set_on !== 'string' || !DAY.test(range.set_on)) return undefined;
  return { ...(low !== undefined ? { low } : {}), ...(high !== undefined ? { high } : {}), unit: range.unit, set_on: range.set_on };
};
/** A Body's ranges, each on a reading that can have one; what is not one is left out. */
export const readBodyRanges = (settings: Readonly<Record<string, unknown>> | null | undefined): Partial<Record<BodyGoalField, BodyRange>> => {
  const raw = settings?.[BODY_RANGES_SETTING];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).flatMap(([reading, value]) => {
    const range = isBodyGoalField(reading) ? readBodyRange(value) : undefined;
    return range ? [[reading, range]] : [];
  }));
};
/** Where a value sits against a range: in it, or over or under it, by how much. */
export const bodyRangePlace = (range: Pick<BodyRange, 'low' | 'high'>, value: number): { place: 'in' | 'over' | 'under'; by: number } =>
  range.high !== undefined && value > range.high ? { place: 'over', by: value - range.high }
    : range.low !== undefined && value < range.low ? { place: 'under', by: range.low - value } : { place: 'in', by: 0 };

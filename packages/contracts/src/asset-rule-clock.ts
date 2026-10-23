/** D-325 — rule arithmetic, with the owner's clock passed in. These functions
 * decide dates and thresholds; they never write or choose a reminder cadence. */
import { AssetValidationError, isAssetDate, type Asset, type AssetEvidence, type AssetReading, type AssetRule, type AssetRuleOffset } from './assets.js';
import { createZonedDateTimeFormatter } from './zoned-date-time-formatter.js';

const DAY = 86_400_000;
const dateFormatter = createZonedDateTimeFormatter({ era: 'short', year: 'numeric', month: '2-digit', day: '2-digit' });
export const assetDateAt = (at: number, timeZone: string): string => {
  if (!Number.isSafeInteger(at) || Math.abs(at) > 8.64e15) throw new AssetValidationError('Invalid date instant');
  const parts = dateFormatter(timeZone).formatToParts(at);
  const part = (type: string): string => parts.find(value => value.type === type)!.value;
  const result = `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
  if (part('era') !== 'AD' || !isAssetDate(result)) throw new AssetValidationError('Date is out of range');
  return result;
};
/** Calendar months clamp at the destination month's end, from the ORIGINAL
 * anchor each time. January 31 → February 28 → March 31, with no 30-day fiction. */
export const shiftAssetDate = (date: string, offset: AssetRuleOffset, direction: 1 | -1 = 1): string => {
  if (!isAssetDate(date) || !Number.isSafeInteger(offset.amount) || offset.amount < 0) throw new AssetValidationError('Invalid date offset');
  const at = new Date(`${date}T00:00:00.000Z`);
  const amount = offset.amount * direction;
  if (offset.unit === 'months') {
    const day = at.getUTCDate();
    at.setUTCDate(1); at.setUTCMonth(at.getUTCMonth() + amount);
    const end = new Date(at.getTime()); end.setUTCMonth(end.getUTCMonth() + 1, 0);
    at.setUTCDate(Math.min(day, end.getUTCDate()));
  } else if (offset.unit === 'weeks' || offset.unit === 'days') {
    at.setUTCDate(at.getUTCDate() + amount * (offset.unit === 'weeks' ? 7 : 1));
  } else throw new AssetValidationError('Unknown date offset unit');
  if (!Number.isFinite(at.getTime())) throw new AssetValidationError('Date offset is out of range');
  const result = at.toISOString().slice(0, 10);
  if (!isAssetDate(result)) throw new AssetValidationError('Date offset is out of range');
  return result;
};

export interface AssetRuleClock {
  cycle: string;
  due_on: string | null;
  act_by: string | null;
  active: boolean;
  /** Only condition recovery can close automatically. A usage crossing never does. */
  recovered: boolean;
  question: boolean;
  /** A projected crossing from prior readings, rather than a recorded date. */
  estimated?: true;
  /** The condition is present in a state the owner marked as expected. */
  expected?: true;
  evidence: AssetEvidence[];
}
export const assetRuleActBy = (due: string, rule: AssetRule): string =>
  [due, ...rule.schedule.before.map(point => shiftAssetDate(due, point, -1))].sort()[0]!;

/** §4.10 — the owner's word that a condition is intended ("that light flashes on
 * purpose"), kept on the asset as `settings.expected_patterns[field] = { active, at }`.
 * While the condition is present and so marked, it raises nothing. */
export const ASSET_EXPECTED_PATTERNS = 'expected_patterns';
export const assetConditionExpected = (asset: { settings?: Asset['settings'] }, field: string, active: boolean): boolean => {
  const patterns = asset.settings?.[ASSET_EXPECTED_PATTERNS];
  const mark = patterns && typeof patterns === 'object' && !Array.isArray(patterns) ? (patterns as Record<string, unknown>)[field] : undefined;
  return active && !!mark && typeof mark === 'object' && (mark as { active?: unknown }).active === true;
};

/** Occasions use these same typed clocks without becoming asset records. */
export type RuleClockSubject = Pick<Asset, 'status' | 'dates' | 'readings' | 'observations'> & { settings?: Asset['settings'] };
export const evaluateAssetRuleClock = (asset: RuleClockSubject, rule: AssetRule, context: {
  now: number;
  timeZone: string;
  /** Prior samples of this same reading; supplied by the service's history. */
  readings?: readonly AssetReading[];
  /** The interval cycle after the last done, beginning at one. For an objective
   *  rule, the episode: a condition's next breach after a recovery, or a usage
   *  target moved on by `every` for each one skipped as not needed. */
  cycle?: number;
}): AssetRuleClock => {
  const today = assetDateAt(context.now, context.timeZone);
  const empty: AssetRuleClock = { cycle: 'unknown', due_on: null, act_by: null, active: false, recovered: false, question: false, evidence: [] };
  if (!rule.enabled || !['active', 'lent'].includes(asset.status)) return empty;
  const when = rule.when;
  if (when.kind === 'expiry' || when.kind === 'interval') {
    const value = asset.dates[when.field];
    if (!value) return { ...empty, question: when.kind === 'interval' };
    let due = value;
    let cycle = value;
    if (when.kind === 'expiry' && when.offset) due = shiftAssetDate(value, when.offset, -1);
    if (when.kind === 'interval') {
      const n = context.cycle ?? 1;
      if (!Number.isSafeInteger(n) || n < 1) throw new AssetValidationError('Invalid interval cycle');
      due = shiftAssetDate(value, { ...when.every, amount: when.every.amount * n });
      cycle = `${value}:${n}`;
    }
    const act_by = assetRuleActBy(due, rule);
    return { ...empty, cycle, due_on: due, act_by, active: today >= act_by };
  }
  if (when.kind === 'condition') {
    const condition = asset.observations[when.field];
    if (!condition || condition.as_of > context.now) return empty;
    // Neither active nor recovered: an open occurrence is the owner's false alarm.
    if (assetConditionExpected(asset, when.field, condition.active)) {
      return { ...empty, cycle: `${when.field}:${condition.as_of}`, expected: true, evidence: condition.evidence };
    }
    return { ...empty, cycle: `${when.field}:${condition.as_of}`, active: condition.active
      && (when.certainty === 'conditional' || condition.certainty === 'confirmed'),
    recovered: !condition.active, evidence: condition.evidence };
  }
  const current = asset.readings[when.field];
  if (!current || current.as_of > context.now || current.unit !== when.unit) return empty;
  const episode = context.cycle ?? 1;
  if (!Number.isSafeInteger(episode) || episode < 1) throw new AssetValidationError('Invalid objective cycle');
  // The first episode keeps the plain key, so occurrences written before cycles existed still match.
  const cycle = episode === 1 ? `${when.field}:${when.target}` : `${when.field}:${when.target}:${episode}`;
  const skipped = when.mode === 'usage' && when.every ? when.every * (episode - 1) : 0;
  const target = when.target + (when.direction === 'rising' ? skipped : -skipped);
  const prior = [...(context.readings ?? [])].filter(sample => sample.unit === current.unit && sample.as_of < current.as_of
    && Number.isFinite(sample.as_of) && Number.isFinite(sample.value)).sort((a, b) => b.as_of - a.as_of)[0];
  const sign = when.direction === 'rising' ? 1 : -1;
  const remaining = (target - current.value) * sign;
  const crossed = remaining <= 0;
  const closeByValue = remaining <= (when.lead_value ?? 0);
  const recovered = when.mode === 'condition' && !crossed && prior !== undefined && (current.value - prior.value) * sign < 0;
  // Starting from the sample's as-of preserves a real projection when a device
  // was last read yesterday. Starting from now would keep moving the deadline.
  const rate = prior ? (current.value - prior.value) * sign / (current.as_of - prior.as_of) : null;
  const projected = rate !== null && rate > 0 ? current.as_of + remaining / rate : null;
  const due_on = crossed ? assetDateAt(current.as_of, context.timeZone)
    : projected !== null && Number.isFinite(projected) && Math.abs(projected) <= 8.64e15 ? assetDateAt(projected, context.timeZone) : null;
  const act_by = due_on ? shiftAssetDate(due_on, { amount: Math.ceil(when.lead_days), unit: 'days' }, -1) : null;
  return { ...empty, cycle, due_on, act_by,
    ...(!crossed && due_on !== null ? { estimated: true as const } : {}),
    active: !recovered && (crossed || closeByValue || (act_by !== null && today >= act_by)),
    recovered, evidence: [...(prior?.evidence ?? []), ...current.evidence] };
};

export interface AssetReminderPoint { key: string; date: string }
/** A caller records the past keys together: onboarding or a schedule edit sends
 * the latest missed point once, never a storm of all its earlier points. */
export const planAssetReminderPoints = (due: string, rule: AssetRule, today: string): {
  due: AssetReminderPoint | null;
  next: AssetReminderPoint | null;
  past_keys: string[];
} => {
  if (!isAssetDate(due) || !isAssetDate(today)) throw new AssetValidationError('Invalid reminder date');
  const points: AssetReminderPoint[] = rule.schedule.before.map(point => ({ key: `before:${point.amount}:${point.unit}`, date: shiftAssetDate(due, point, -1) }));
  if (rule.schedule.on_day) points.push({ key: 'on_day', date: due });
  const repeat = rule.schedule.after;
  if (repeat && rule.reaction.occurrence === 'action') {
    if (!Number.isSafeInteger(repeat.amount) || repeat.amount < 1) throw new AssetValidationError('A repeat must be at least daily');
    // Jump to the pair around today instead of iterating over years of missed
    // points. Calendar months are counted from the original due date.
    const from = new Date(`${due}T00:00:00Z`);
    const to = new Date(`${today}T00:00:00Z`);
    const gap = repeat.unit === 'months'
      ? (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + to.getUTCMonth() - from.getUTCMonth()
      : (to.getTime() - from.getTime()) / DAY / (repeat.unit === 'weeks' ? 7 : 1);
    const nearest = Math.max(1, Math.floor(gap / repeat.amount));
    for (const n of new Set([Math.max(1, nearest - 1), nearest, nearest + 1])) {
      points.push({ key: `after:${n}:${repeat.amount}:${repeat.unit}`, date: shiftAssetDate(due, { ...repeat, amount: repeat.amount * n }) });
    }
  }
  points.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
  const past = points.filter(point => point.date <= today);
  return { due: past[past.length - 1] ?? null, next: points.find(point => point.date > today) ?? null, past_keys: past.map(point => point.key) };
};

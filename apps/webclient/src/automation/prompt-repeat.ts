import { describeCron } from '@recued/contracts';

export const PROMPT_WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
export type PromptRepeatFrequency = 'daily' | 'weekdays' | 'weekly' | 'selected_days' | 'monthly' | 'custom';
export interface PromptRepeatValues {
  frequency: PromptRepeatFrequency; clock: string; weekday: string; cron: string;
  selectedWeekdays?: string[]; monthDay?: string;
}
const defaults = () => ({ frequency: 'custom' as PromptRepeatFrequency, clock: '09:00', weekday: '1', selectedWeekdays: ['1'], monthDay: '1' });

/** Decode only patterns the controls can express. In particular, a cron with
 * both a date and weekdays keeps their existing scheduler semantics in Custom. */
export const readPromptRepeat = (expression: string): ReturnType<typeof defaults> => {
  const parts = expression.trim().split(/\s+/u), result = defaults();
  if (parts.length !== 5 || !/^\d{1,2}$/.test(parts[0]!) || !/^\d{1,2}$/.test(parts[1]!)
    || Number(parts[0]) > 59 || Number(parts[1]) > 23 || parts[3] !== '*') return result;
  const clock = parts[1]!.padStart(2, '0') + ':' + parts[0]!.padStart(2, '0');
  if (parts[4] === '*' && /^\d{1,2}$/.test(parts[2]!) && Number(parts[2]) >= 1 && Number(parts[2]) <= 31)
    return { ...result, frequency: 'monthly', clock, monthDay: String(Number(parts[2])) };
  if (parts[2] !== '*') return result;
  if (parts[4] === '*') return { ...result, frequency: 'daily', clock };
  if (parts[4] === '1-5') return { ...result, frequency: 'weekdays', clock, selectedWeekdays: ['1', '2', '3', '4', '5'] };
  const days = new Set<number>();
  for (const term of parts[4]!.split(',')) {
    if (!/^[0-6](?:-[0-6])?$/.test(term)) return result;
    const [first, last = first] = term.split('-').map(Number);
    if (first! > last!) return result;
    for (let day = first!; day <= last!; day++) days.add(day);
  }
  const selectedWeekdays = [...days].sort().map(String);
  return { ...result, frequency: selectedWeekdays.length === 1 ? 'weekly' : 'selected_days', clock,
    weekday: selectedWeekdays[0]!, selectedWeekdays };
};

const encode = (value: PromptRepeatValues): string => {
  const [hour, minute] = value.clock.split(':').map(Number);
  if (!/^\d{2}:\d{2}$/.test(value.clock) || hour! > 23 || minute! > 59) throw new Error('Choose a valid recurring time.');
  const prefix = `${minute} ${hour}`;
  if (value.frequency === 'monthly') {
    if (!/^\d{1,2}$/.test(value.monthDay ?? '') || Number(value.monthDay) < 1 || Number(value.monthDay) > 31)
      throw new Error('Choose a day of the month from 1 to 31.');
    return `${prefix} ${Number(value.monthDay)} * *`;
  }
  if (value.frequency === 'selected_days') {
    const days = value.selectedWeekdays ?? [];
    if (!days.length || days.length > 7 || days.some(day => !/^[0-6]$/.test(day))) throw new Error('Choose at least one weekday.');
    return `${prefix} * * ${[...new Set(days)].sort().join(',')}`;
  }
  if (value.frequency === 'weekly' && !/^[0-6]$/.test(value.weekday)) throw new Error('Choose a day of the week.');
  return `${prefix} * * ${value.frequency === 'daily' ? '*' : value.frequency === 'weekdays' ? '1-5' : value.weekday}`;
};

export const promptRepeatCron = (value: PromptRepeatValues): string => {
  const original = value.cron.trim().replace(/\s+/gu, ' ');
  if (value.frequency === 'custom') return original;
  const expression = encode(value), previous = readPromptRepeat(original);
  // A title-only edit must not rewrite an equivalent date/list/range spelling:
  // changing its bytes would also retire a skipped run on the server.
  return previous.frequency !== 'custom' && encode({ ...previous, cron: original }) === expression ? original : expression;
};

export const describePromptCron = (expression: string): string => {
  const repeat = readPromptRepeat(expression);
  return repeat.frequency === 'selected_days'
    ? `${repeat.selectedWeekdays.map(day => PROMPT_WEEKDAY_NAMES[Number(day)]).join(', ')} at ${repeat.clock}`
    : describeCron(expression);
};

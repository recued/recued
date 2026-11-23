import type { PromptSchedule } from '@recued/contracts';
import { describePromptCron, PROMPT_WEEKDAY_NAMES, readPromptRepeat } from './prompt-repeat.js';

type TimingRow = Pick<PromptSchedule, 'mode' | 'time_zone' | 'run_at' | 'cron_expression'>;
interface TimingFields { readonly cadence: string; readonly calendar: string; readonly clock: string; readonly zone: string }
const cache = new WeakMap<TimingRow, { key: string; fields: TimingFields }>();
const fold = (text: string) => text.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();

/** Search saved timing, never a run outcome, an inactive timing field, or a
 * browser-zone reinterpretation. Cache formatting while the configuration is
 * unchanged, including when the same row object receives a newer setting. */
export const promptSearchTimingFields = (row: TimingRow): TimingFields => {
  const key = JSON.stringify([row.mode, row.time_zone, row.mode === 'one_shot' ? row.run_at : row.cron_expression]);
  const previous = cache.get(row);if (previous?.key === key) return previous.fields;
  let cadence = '', calendar = '', clock = '';
  if (row.mode === 'recurring' && typeof row.cron_expression === 'string') {
    const repeat = readPromptRepeat(row.cron_expression), parts = row.cron_expression.trim().split(/\s+/u);
    // A custom clock may still have an ordinary calendar, such as every
    // weekday between 8 and 17. Decode its declared days without inventing a
    // single clock time or rewriting the expression.
    const days = parts.length === 5 ? readPromptRepeat(['0', '0', ...parts.slice(2)].join(' ')) : null;
    cadence = describePromptCron(row.cron_expression);
    if (repeat.frequency !== 'custom') clock = repeat.clock;
    if (days?.frequency === 'monthly') {
      cadence = 'Monthly · ' + cadence;calendar = `Monthly · Day ${days.monthDay} of each month`;
    } else if (days?.frequency === 'daily') {
      calendar = 'Every day · ' + PROMPT_WEEKDAY_NAMES.join(', ');
    } else if (days?.frequency === 'weekdays') {
      calendar = 'Every weekday · ' + PROMPT_WEEKDAY_NAMES.slice(1, 6).join(', ');
    } else if (days?.frequency === 'weekly' || days?.frequency === 'selected_days') {
      const names = days.selectedWeekdays.map(day => PROMPT_WEEKDAY_NAMES[Number(day)]).join(', ');
      calendar = 'Weekly · ' + names;
    }
  } else if (row.mode === 'one_shot') {
    cadence = 'Once';
    if (typeof row.run_at === 'number' && Number.isFinite(row.run_at) && row.time_zone) {
      const date = new Date(row.run_at), precision: Intl.DateTimeFormatOptions = {
        ...(date.getUTCSeconds() || date.getUTCMilliseconds() ? { second: '2-digit' } : {}),
        ...(date.getUTCMilliseconds() ? { fractionalSecondDigits: 3 } : {}),
      };
      try {
        cadence += ' · ' + date.toLocaleString('en', { timeZone: row.time_zone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'shortOffset', ...precision });
        clock = date.toLocaleTimeString('en-GB', { timeZone: row.time_zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...precision });
      } catch { /* Retain the stated mode and zone without fabricating a clock. */ }
    }
  }
  const fields = { cadence, calendar, clock, zone: row.time_zone };
  cache.set(row, { key, fields });return fields;
};

/** Extra calendar/24-hour clock text is shown when it supplies a query term
 * absent from the usual cadence, so a metadata match is visible in the row. */
export const promptSearchTimingText = (row: TimingRow, query = ''): string => {
  const fields = promptSearchTimingFields(row), terms = fold(query).split(' ').filter(Boolean), base = fold(fields.cadence);
  const extra = [fields.calendar, fields.clock].filter(text => text && terms.some(term => fold(text).includes(term) && !base.includes(term)));
  return [fields.cadence, ...extra, fields.zone].filter(Boolean).join(' · ');
};

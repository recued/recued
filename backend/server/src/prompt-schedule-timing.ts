import { RpcError, type PromptSchedulePreview, type PromptScheduleTiming } from '@recued/contracts';
import { parseInstantWithOffset } from '@recued/transforms';
import { cronMatchesAt, nextCronMatch, validateCronInterval } from '@recued/scheduler';

const bad = (message: string): never => { throw new RpcError('bad_request', message, 400); };
const text = (value: unknown, name: string, max: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return bad(`${name} must contain 1–${max} characters.`);
  return value.trim();
};
const YEAR_MINUTES = 527_040;

/** Shared by saves and previews; never reads or writes conversation state. */
export const resolvePromptScheduleTiming = (raw: unknown, now: number, allowPast = false): {
  timing: PromptScheduleTiming; first_run_at: number;
} => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('Expected schedule timing.');
  const args = raw as Record<string, unknown>;
  if (Object.keys(args).some(key => !['mode', 'time_zone', 'run_at', 'cron_expression'].includes(key))) return bad('Unknown schedule timing field.');
  const time_zone = text(args.time_zone, 'Timezone', 100);
  try { new Intl.DateTimeFormat('en', { timeZone: time_zone }).format(0); } catch { return bad('Choose a valid IANA timezone.'); }
  if (args.mode === 'one_shot') {
    const at = parseInstantWithOffset(args.run_at);
    if (at === null || at === undefined || (!allowPast && at <= now)) return bad('Choose a future date-time including its timezone offset.');
    if (args.cron_expression !== undefined) return bad('A one-off request cannot have a recurring expression.');
    return { timing: { mode: 'one_shot', time_zone, run_at: args.run_at as string }, first_run_at: at };
  }
  if (args.mode !== 'recurring') return bad('Choose one-off or recurring.');
  if (args.run_at !== undefined) return bad('A recurring request cannot have a one-off date.');
  const cron_expression = text(args.cron_expression, 'Schedule', 120);
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  const parts = cron_expression.split(/\s+/);
  if (parts.some(part => part.includes(',') && part.includes('*'))) return bad('Do not combine a step and a list in one cron field.');
  if (parts.length !== 5 || parts.some((part, i) => !part.split(',').every(segment => {
    if (segment === '*') return true;
    if (/^\*\/[1-9]\d*$/.test(segment)) return Number(segment.slice(2)) <= ranges[i]![1]! + 1;
    if (!/^\d+(?:-\d+)?$/.test(segment)) return false;
    const [a, b = a] = segment.split('-').map(Number);
    return a! >= ranges[i]![0]! && b! <= ranges[i]![1]! && a! <= b!;
  }))) return bad('Use a valid five-field cron expression.');
  // Check all clock gaps as well as the shared validator's first gap.
  const clockSlots: number[] = [];
  const epoch = Date.UTC(2026, 0, 1);
  for (let minute = 0; minute < 1440; minute++) {
    if (cronMatchesAt([parts[0]!, parts[1]!, '*', '*', '*'], new Date(epoch + minute * 60000), 'UTC')) clockSlots.push(minute);
  }
  let tooClose = clockSlots.some((minute, index) => index > 0 && minute - clockSlots[index - 1]! < 5);
  if (!tooClose && clockSlots.length && 1440 + clockSlots[0]! - clockSlots.at(-1)! < 5) {
    const dates = ['0', '0', ...parts.slice(2)];
    for (let day = 0; day < 366 && !tooClose; day++) {
      tooClose = cronMatchesAt(dates, new Date(epoch + day * 86400000), 'UTC')
        && cronMatchesAt(dates, new Date(epoch + (day + 1) * 86400000), 'UTC');
    }
  }
  if (tooClose) return bad('Allow at least five minutes between recurring occurrences.');
  const validation = validateCronInterval(cron_expression);
  if (!validation.valid) return bad(validation.error ?? 'Schedule runs too frequently.');
  const first_run_at = nextCronMatch(parts, Math.floor(now / 60000) * 60000 + 60000, YEAR_MINUTES, time_zone);
  if (first_run_at === null) return bad('Schedule has no occurrence in the coming year.');
  return { timing: { mode: 'recurring', time_zone, cron_expression: parts.join(' ') }, first_run_at };
};

export const previewPromptScheduleTiming = (raw: unknown, now: number): PromptSchedulePreview => {
  const { timing, first_run_at } = resolvePromptScheduleTiming(raw, now, true);
  const preview: PromptSchedulePreview = { mode: timing.mode, time_zone: timing.time_zone,
    calculated_at: now, next_runs: first_run_at > now ? [first_run_at] : [] };
  if (timing.mode === 'one_shot') {
    if (first_run_at <= now) preview.past_run_at = first_run_at;
    return preview;
  }
  const end = Math.floor(now / 60000) * 60000 + 60000 + YEAR_MINUTES * 60000;
  preview.window_ends_at = end;
  let cursor = first_run_at + 60000;
  while (preview.next_runs.length < 3 && cursor < end) {
    const next = nextCronMatch(timing.cron_expression!.split(' '), cursor, Math.floor((end - cursor) / 60000), timing.time_zone);
    if (next === null) break;
    preview.next_runs.push(next); cursor = next + 60000;
  }
  return preview;
};

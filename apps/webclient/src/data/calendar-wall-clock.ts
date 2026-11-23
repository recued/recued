import { DAY_MS, zonedWallClockToEpochMs, zoneOffsetMsAt } from '@recued/contracts';

/** Always read the wall clock on the event's zone, even on a travelling browser. */
export const calendarWallClockValue = (at: number, zone: string, precision: 'minute' | 'second' | 'millisecond' = 'minute'): string => {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      ...(precision !== 'minute' ? { second: '2-digit' as const } : {}),
      ...(precision === 'millisecond' ? { fractionalSecondDigits: 3 as const } : {}),
    }).formatToParts(at);
    const p = (key: string) => parts.find(part => part.type === key)?.value ?? '';
    return `${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}`
      + (precision !== 'minute' ? `:${p('second')}` : '') + (precision === 'millisecond' ? `.${p('fractionalSecond')}` : '');
  } catch { return ''; }
};

/** Round-trip validation rejects invalid days and spring-forward gaps. Multiple
 * offsets around a transition expose both readings of a repeated wall clock. */
export const calendarWallClockCandidates = (value: string, zone: string): number[] => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value)) return [];
  const first = zonedWallClockToEpochMs(value.slice(0, 16), zone);
  if (first === null) return [];
  const naive = Date.parse(value + (value.length === 16 ? ':00Z' : 'Z'));
  if (!Number.isFinite(naive) || new Date(naive).toISOString().slice(0, 16) !== value.slice(0, 16)) return [];
  const normalized = new Date(naive).toISOString().slice(0, -1);
  const found = new Set<number>();
  try {
    for (const sample of [first - DAY_MS, first, first + DAY_MS]) {
      const candidate = naive - zoneOffsetMsAt(sample, zone);
      if (calendarWallClockValue(candidate, zone, 'millisecond') === normalized) found.add(candidate);
    }
  } catch { return []; }
  return [...found].sort((a, b) => a - b);
};


import { isAssetDate, type EpisodeInput } from '@recued/contracts';

export const yoursCalendarDate = (on: string): string => isAssetDate(on)
  ? new Date(`${on}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : on;

export const yoursDateTime = (at: number): string => new Date(at).toLocaleString(undefined,
  { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });

const midnight = (value: Date): boolean => value.getHours() === 0 && value.getMinutes() === 0 && value.getSeconds() === 0 && value.getMilliseconds() === 0;
export const episodeDateWords = (when: EpisodeInput['when']): string => {
  const from = new Date(when.from); const to = new Date(when.to);
  const date = (value: Date) => value.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  if (when.from === when.to) return date(from);
  // D-343 slice 5 — whole days (a day closed in the chat spans midnight to midnight) are those days,
  // not the midnight after them.
  if (midnight(from) && midnight(to) && to > from) {
    const last = new Date(to); last.setDate(last.getDate() - 1);
    return last.toDateString() === from.toDateString() ? date(from) : `${date(from)} – ${date(last)}`;
  }
  if (from.toDateString() !== to.toDateString()) return `${date(from)} – ${date(to)}`;
  const time = (value: Date) => value.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${date(from)} · ${time(from)}–${time(to)}`;
};

/** D-343 slice 5 — the local day an episode began, as Episodes groups them (YYYY-MM-DD), and the
 * day's heading ("Friday, Nov 6, 2026"). */
export const episodeDay = (at: number): string => {
  const day = new Date(at);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
};
export const episodeDayWords = (at: number): string => new Date(at).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });

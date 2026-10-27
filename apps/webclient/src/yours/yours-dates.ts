import { isAssetDate, type EpisodeInput } from '@recued/contracts';

export const yoursCalendarDate = (on: string): string => isAssetDate(on)
  ? new Date(`${on}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : on;

export const yoursDateTime = (at: number): string => new Date(at).toLocaleString(undefined,
  { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });

export const episodeDateWords = (when: EpisodeInput['when']): string => {
  const from = new Date(when.from); const to = new Date(when.to);
  const date = (value: Date) => value.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  if (when.from === when.to) return date(from);
  if (from.toDateString() !== to.toDateString()) return `${date(from)} – ${date(to)}`;
  const time = (value: Date) => value.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${date(from)} · ${time(from)}–${time(to)}`;
};

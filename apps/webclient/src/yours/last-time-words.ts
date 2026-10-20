import type { YoursLearningStatus } from '@recued/contracts';

/** D-325 P21 — "last time" in the owner's words, for Settings and Yours → Episodes. */
const CLASS_WORDS: Record<string, string> = { flowers: 'flowers', gifts: 'gifts', restaurants: 'restaurants', photos: 'photos', checkin: 'check-ins' };
export const lastTimeClassName = (id: string): string => CLASS_WORDS[id] ?? id.replaceAll('_', ' ');
const list = (words: string[]): string => words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;

/** What "last time" is doing now. */
export const lastTimeStateText = (status: YoursLearningStatus): string => {
  const ready = status.classes.filter(row => row.qualified).map(row => lastTimeClassName(row.class_id));
  if (status.last_time === 'on') return ready.length ? `On. Your overview may offer ${list(ready)}.` : 'On. No kind of offer has proved useful enough for your overview yet.';
  if (status.last_time === 'off') return 'Off. Recued does not ask again.';
  return status.asked ? 'Recued is asking whether to allow it. Answer in the bell, or here.'
    : 'Off until you allow it. Recued asks once, when a kind of offer has proved useful on your own records.';
};

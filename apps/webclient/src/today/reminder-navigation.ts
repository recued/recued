import { reminderDetailLink } from '@recued/contracts';
import type { TaskBlockerTodayOrigin } from '../data/task-blocker-navigation.js';

export interface TodayReminderOrigin extends Omit<TaskBlockerTodayOrigin, 'owner' | 'dependency'> {
  id: string; focus: string;
}
/** Explicit paired-boot continuity: only this reminder and its verified child
 * reader may keep a return to Today. Unrelated navigation retires it. */
export const createTodayReminderNavigation = (navigate: (hash: string) => void) => {
  let visit: { origin: TodayReminderOrigin; child?: string } | undefined;
  return {
    open(origin: TodayReminderOrigin) {
      visit = { origin: { ...origin, expanded: [...origin.expanded] } };
      navigate(reminderDetailLink(origin.id));
    },
    owns(id?: string) { return !!id && visit?.origin.id === id; },
    back(id?: string) { if (!id || visit?.origin.id !== id) return false; navigate('#today'); return true; },
    follow(id: string, hash: string) { if (visit?.origin.id === id) visit.child = hash; },
    route(hash: string) {
      if (visit && hash !== '#today' && hash !== '#data/today' && hash !== reminderDetailLink(visit.origin.id) && hash !== visit.child) visit = undefined;
    },
    restoreToday() { return visit ? { ...visit.origin, expanded: [...visit.origin.expanded] } : undefined; },
  };
};
export type TodayReminderNavigation = ReturnType<typeof createTodayReminderNavigation>;

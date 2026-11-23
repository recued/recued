import { serializeShellRoute } from '../shell/route.js';
import type { TaskBlockerFocus } from './task-blockers.js';

export interface TaskBlockerTodayOrigin extends TaskBlockerFocus {
  expanded: string[]; sphere: 'all' | 'personal' | 'professional' | 'unsorted'; sourcesOpen?: boolean; scrollTop: number;
}

/** One explicit handoff, owned by this paired app boot. A different destination
 * retires it; it never survives a server switch or relies on a browser referrer. */
export const createTaskBlockerNavigation = (navigate: (hash: string) => void) => {
  let visit: { target: string; origin: TaskBlockerTodayOrigin } | null = null;
  const copy = (value: typeof visit) => value ? { target: value.target, origin: { ...value.origin, expanded: [...value.origin.expanded] } } : null;
  return {
    snapshot: () => copy(visit) ?? undefined,
    restore(value: ReturnType<typeof copy> | undefined) { visit = copy(value ?? null); },
    open(origin: TaskBlockerTodayOrigin) { visit = { target: origin.dependency, origin: { ...origin, expanded: [...origin.expanded] } }; navigate(serializeShellRoute('data', 'task', origin.dependency)); },
    owns(id: string) { return visit?.target === id; },
    target: () => visit?.target,
    back(id: string) { if (visit?.target !== id) return false; navigate('#today'); return true; },
    restoreToday() { const origin = visit?.origin; visit = null; return origin; },
    route(hash: string) { if (visit && hash !== '#today' && hash !== serializeShellRoute('data', 'task', visit.target)) visit = null; },
  };
};
export type TaskBlockerNavigation = ReturnType<typeof createTaskBlockerNavigation>;

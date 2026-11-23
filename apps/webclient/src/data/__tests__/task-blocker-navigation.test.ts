import { describe, expect, it, vi } from 'vitest';
import { createTaskBlockerNavigation, type TaskBlockerTodayOrigin } from '../task-blocker-navigation.js';

const origin = (): TaskBlockerTodayOrigin => ({ owner: 'parent', dependency: 'task / Café', expanded: ['parent'], sphere: 'professional', sourcesOpen: true, scrollTop: 420 });

describe('Today blocker return', () => {
  it('restores its owned handoff after a related-record visit without sharing mutable disclosure state', () => {
    const nav = createTaskBlockerNavigation(() => {}); nav.open(origin());
    const saved = nav.snapshot(); nav.route('#data/project/launch'); expect(nav.owns(origin().dependency)).toBe(false);
    nav.restore(saved); saved!.origin.expanded.push('later');
    expect(nav.owns(origin().dependency)).toBe(true); expect(nav.restoreToday()).toEqual(origin());
  });
  it('returns only the task that owns the handoff and restores the originating view once', () => {
    const navigate = vi.fn(), nav = createTaskBlockerNavigation(navigate), before = origin(); nav.open(before);
    expect(navigate).toHaveBeenLastCalledWith('#data/task/task%20%2F%20Caf%C3%A9');
    before.expanded.push('later'); expect(nav.back('other')).toBe(false); expect(nav.owns(before.dependency)).toBe(true);
    expect(nav.back(before.dependency)).toBe(true); expect(navigate).toHaveBeenLastCalledWith('#today');
    expect(nav.restoreToday()).toEqual(origin()); expect(nav.restoreToday()).toBeUndefined();
  });
  it('retires a handoff after an unrelated navigation and keeps separate paired app boots independent', () => {
    const nav = createTaskBlockerNavigation(() => {}), second = createTaskBlockerNavigation(() => {}); nav.open(origin());
    nav.route('#data/task/task%20%2F%20Caf%C3%A9'); expect(nav.owns(origin().dependency)).toBe(true);
    expect(second.owns(origin().dependency)).toBe(false);
    nav.route('#data/task/another'); expect(nav.back(origin().dependency)).toBe(false); expect(nav.restoreToday()).toBeUndefined();
  });
});

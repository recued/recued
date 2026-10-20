/** D-325 §15.4 — a cluster's one-line summary, and the four coded answers on
 *  what Recued computed or inferred in it. A record the owner keeps answers
 *  with its own actions instead. */
import type { ProactiveToday, SituationCluster, SituationItem, YoursCommand, YoursCommandResult } from '@recued/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createTodayController, type TodayCallers } from '../today-controller.js';
import { renderToday, todayWindow } from '../../data/today-view.js';

const now = new Date(2026, 9, 18, 12).getTime();
const hour = 3_600_000;
const { tomorrow } = todayWindow(now);
const dimension = <T>(value: T | null, verdict: 'match' | 'unknown') => ({ value, verdict, basis: 'declared' as const, evidence: [] });
const item = (patch: Pick<SituationItem, 'ref' | 'kind' | 'basis'>, title: string): SituationItem => ({ ...patch, what: dimension(title, 'match'),
  when: dimension({ from: tomorrow, to: tomorrow + hour }, 'match'), where: dimension(null, 'unknown'), who: dimension(null, 'unknown'),
  reasons: ['due'], evidence: [], consequence: 'floor', updated_at: now });
const trip = item({ ref: { collection: 'booking', id: 'paris' }, kind: 'booking', basis: 'declared' }, 'Paris trip');
const check = item({ ref: { collection: 'asset', id: 'passport', field: 'trip_validity:booking:paris' }, kind: 'travel_validity', basis: 'derived' },
  'Passport · expires 2026-10-23; needs at least 2027-01-25');
const cluster: SituationCluster = { id: 'trip', subjects: [], span: { from: tomorrow, to: tomorrow + hour }, omitted: 0, items: [trip, check] };
const proactive: ProactiveToday = { situations: { clusters: [cluster], omitted: 0, ambiguous: [] }, summaries: { trip: 'Ana’s passport ends before the Paris trip.' },
  occurrences: [], proposal_count: 0, newest_proposal: null, unmatched_replies: [], phone_ready: true };
const setup = () => {
  const change = vi.fn(async (input: Extract<YoursCommand, { action: 'situation.dismiss' | 'situation.restore' }>): Promise<YoursCommandResult> =>
    input.action === 'situation.restore' ? { message: 'Shown again.' } : { id: 'item:check', message: `Won't show this again: ${input.label}.` });
  const callers = { workEntitySourceListCaller: async () => ({ sources: [] }), workEntityListCaller: async () => ({ entities: [], total: 0 }),
    collectionListInstancesCaller: async () => ({ instances: [] }), proactiveTodayCaller: async () => proactive, situationChangeCaller: change } as unknown as TodayCallers;
  const refreshActive = vi.fn();
  const controller = createTodayController({ callers, now: () => now, render: () => {}, isDisposed: () => false, isActive: () => true,
    refreshActive, focusTask: () => {}, ownsFocus: () => false, actionAttr: 'data-action', errMessage: error => String(error) });
  return { controller, change, refreshActive };
};

describe('Today answers on what Recued put in a cluster', () => {
  it('shows the summary, and puts the four answers on the computed check only', async () => {
    const { controller } = setup(); await controller.load(() => true);
    const html = renderToday(controller.snapshot(), false, 'data-action', false, false,
      { canComplete: false, canReschedule: false, edit: null, notice: null, canDismissSituation: true });
    expect(html).toContain('Ana’s passport ends before the Paris trip.');
    expect(html.match(/data-today-dismiss="/gu)).toHaveLength(4);
    for (const label of ['Not now', 'Not this one', 'Never this kind', 'That’s wrong']) expect(html).toContain(`aria-label="${label}: Passport · expires 2026-10-23`);
    expect(html).not.toContain('aria-label="Not now: Paris trip"');
    // An older server wires no caller, so no answer is offered.
    expect(renderToday(controller.snapshot(), false, 'data-action', false, false, { canComplete: false, canReschedule: false, edit: null, notice: null }))
      .not.toContain('data-today-dismiss=');
  });
  it('sends the item and its code, says what it did, offers Undo, and refreshes', async () => {
    const { controller, change, refreshActive } = setup(); await controller.load(() => true);
    expect(await controller.dismissSituation('trip', 1, 'not_this_one')).toBeNull();
    expect(change).toHaveBeenCalledWith({ action: 'situation.dismiss', ref: check.ref, kind: 'travel_validity', code: 'not_this_one', label: check.what.value });
    expect(controller.notice()).toBe(`Won't show this again: ${check.what.value}.`); expect(controller.undoDismissal()).toBe('item:check');
    expect(refreshActive).toHaveBeenCalledTimes(1);
    expect(renderToday(controller.snapshot(), false, 'data-action', false, false, { canComplete: false, canReschedule: false, edit: null,
      notice: controller.notice(), undoDismissal: controller.undoDismissal(), canDismissSituation: true })).toContain('data-action="today-situation-restore" data-today-dismissal="item:check"');
    await controller.restoreSituation('item:check');
    expect(change).toHaveBeenLastCalledWith({ action: 'situation.restore', key: 'item:check' });
    expect(controller.notice()).toBe('Shown again.'); expect(controller.undoDismissal()).toBeNull();
  });
  // Option A (§8) — a bill opens as itself (its link led to the whole facts list), and an
  // open from Today tells the learner, for a mail fact only.
  it('links a bill to itself and reports an open from Today, for a mail fact only', async () => {
    const bill = item({ ref: { collection: 'mail_fact', id: 'mthing_bill' }, kind: 'bill', basis: 'derived' }, 'Bill: Acme Power');
    const withBill: ProactiveToday = { ...proactive, situations: { ...proactive.situations, clusters: [{ ...cluster, items: [trip, check, bill] }] } };
    const opened = vi.fn();
    const callers = { workEntitySourceListCaller: async () => ({ sources: [] }), workEntityListCaller: async () => ({ entities: [], total: 0 }),
      collectionListInstancesCaller: async () => ({ instances: [] }), proactiveTodayCaller: async () => withBill, situationOpenedCaller: opened } as unknown as TodayCallers;
    const controller = createTodayController({ callers, now: () => now, render: () => {}, isDisposed: () => false, isActive: () => true,
      refreshActive: () => {}, focusTask: () => {}, ownsFocus: () => false, actionAttr: 'data-action', errMessage: error => String(error) });
    await controller.load(() => true);
    const html = renderToday(controller.snapshot(), false, 'data-action', false, false,
      { canComplete: false, canReschedule: false, edit: null, notice: null, canDismissSituation: true });
    expect(html).toContain('<a href="#data/mail_fact/thing/mthing_bill" data-action="today-situation-open" data-today-open-cluster="trip" data-today-open-item="2">');
    controller.recordOpen('trip', 2); expect(opened).toHaveBeenCalledWith({ action: 'navigation.open', ref: bill.ref, from: 'today' });
    controller.recordOpen('trip', 1); controller.recordOpen('trip', 0); expect(opened).toHaveBeenCalledTimes(1);
  });
  // A bill alone is its own row, so it is linked twice: the row's title and the cluster's
  // item. Only the cluster's link reported the open, and the row's is the one in view.
  it('reports an open from a situation row’s own link, as from its cluster item', async () => {
    const bill = item({ ref: { collection: 'mail_fact', id: 'mthing_bill' }, kind: 'bill', basis: 'derived' }, 'Bill: Acme Power');
    const bills: ProactiveToday = { ...proactive, situations: { ...proactive.situations, clusters: [{ ...cluster, id: 'bills', items: [bill] }] } };
    const callers = { workEntitySourceListCaller: async () => ({ sources: [] }), workEntityListCaller: async () => ({ entities: [], total: 0 }),
      collectionListInstancesCaller: async () => ({ instances: [] }), proactiveTodayCaller: async () => bills } as unknown as TodayCallers;
    const controller = createTodayController({ callers, now: () => now, render: () => {}, isDisposed: () => false, isActive: () => true,
      refreshActive: () => {}, focusTask: () => {}, ownsFocus: () => false, actionAttr: 'data-action', errMessage: error => String(error) });
    await controller.load(() => true);
    const links = renderToday(controller.snapshot(), false, 'data-action', false, false,
      { canComplete: false, canReschedule: false, edit: null, notice: null, canDismissSituation: true }).match(/<a href="#data\/mail_fact\/thing\/mthing_bill"[^>]*>/gu);
    expect(links).toEqual(Array(2).fill('<a href="#data/mail_fact/thing/mthing_bill" data-action="today-situation-open" data-today-open-cluster="bills" data-today-open-item="0">'));
  });
  it('opens the record for "That’s wrong", and never answers for a record the owner keeps', async () => {
    const { controller, change } = setup(); await controller.load(() => true);
    expect(await controller.dismissSituation('trip', 1, 'wrong')).toBe('#yours/asset/passport');
    change.mockClear();
    expect(await controller.dismissSituation('trip', 0, 'not_now')).toBeNull(); expect(change).not.toHaveBeenCalled();
  });
});

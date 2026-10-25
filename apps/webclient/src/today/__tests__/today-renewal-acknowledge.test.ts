/** D-325 §15.7 (2026-10-24) — Done on a renewal in Today acknowledges its reminder. A press
 *  does not renew a passport, so the task stays open (its new date closes it, under Yours →
 *  Due), and Today shows it again at its next reminder. Any other task still closes. */
import type { ProactiveToday, SourceRegistration, WorkEntity, YoursCommand, YoursCommandResult } from '@recued/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createTodayController, type TodayCallers } from '../today-controller.js';
import { todayWindow } from '../../data/today-view.js';

const now = new Date(2026, 9, 18, 12).getTime();
const { before } = todayWindow(now);
const source: SourceRegistration = { id: 'recued.commitment', top_tier_kind: 'commitment', source_kind: 'builtin',
  source_label: 'Commitments', write_capable: true, registered_at: 1 };
const commitment = (id: string): Extract<WorkEntity, { _kind: 'commitment' }> => ({ source_id: source.id, sync_state: 'live', conflict_policy: 'source_wins',
  last_seen_at: now, created_at: now, updated_at: now, _kind: 'commitment', id, statement: id, promised_for_at: before + 30 * 86_400_000, promised_at: now,
  direction: 'outbound', lifecycle_state: 'pending', due_status: 'not_due', expiry_policy: 'escalate_overdue', state_changed_at: now,
  lifecycle_changed_at: now, due_status_changed_at: now, derivation: 'rule_emitted', blocks_task_ids: [], blocks_project_ids: [] });
const passport = commitment('renew-passport'); const boiler = commitment('service-boiler');
const proactive: ProactiveToday = { situations: { clusters: [], omitted: 0, ambiguous: [] }, occurrences: [
  { id: 'occ-passport', asset_id: 'passport', asset_name: 'Passport', question: false, reminders_started: true, commitment: passport,
    renewal: { field: 'expires_on', current: '2027-04-17' } },
  { id: 'occ-boiler', asset_id: 'boiler', asset_name: 'Boiler', question: false, reminders_started: true, commitment: boiler }],
  proposal_count: 0, newest_proposal: null, unmatched_replies: [], phone_ready: true };
const noted = 'Noted. It stays open until its new date is entered under Yours → Due, and Today shows it again at its next reminder.';

const setup = (acknowledgeWired = true) => {
  const acknowledge = vi.fn(async (_input: Extract<YoursCommand, { action: 'occurrence.acknowledge' }>): Promise<YoursCommandResult> => ({ message: noted }));
  const close = vi.fn(async ({ id, outcome }: { id: string; outcome: 'fulfill' | 'cancel' }) =>
    ({ entity: { ...commitment(id), lifecycle_state: outcome === 'fulfill' ? 'fulfilled' as const : 'cancelled' as const } }));
  const callers = { workEntitySourceListCaller: async () => ({ sources: [source] }),
    workEntityListCaller: async ({ kind }: { kind: string }) => { const rows = kind === 'commitment' ? [passport, boiler] : []; return { entities: rows, total: rows.length }; },
    collectionListInstancesCaller: async () => ({ instances: [] }), proactiveTodayCaller: async () => proactive, commitmentCloseCaller: close,
    ...(acknowledgeWired ? { occurrenceAcknowledgeCaller: acknowledge } : {}) } as unknown as TodayCallers;
  const refreshActive = vi.fn();
  const controller = createTodayController({ callers, now: () => now, render: () => {}, isDisposed: () => false, isActive: () => true,
    refreshActive, focusTask: () => {}, ownsFocus: () => false, actionAttr: 'data-action', errMessage: error => String(error) });
  const key = (id: string) => controller.snapshot()!.items.find(item => item.commitmentId === id)!.key;
  return { controller, acknowledge, close, refreshActive, key };
};

describe('Today’s Done on a renewal', () => {
  it('acknowledges the renewal and leaves it open, while Done on any other task still closes it', async () => {
    const { controller, acknowledge, close, refreshActive, key } = setup(); await controller.load(() => true);
    await controller.closeCommitment(key('renew-passport'), 'fulfill');
    expect(acknowledge).toHaveBeenCalledWith({ action: 'occurrence.acknowledge', id: 'occ-passport' }); expect(close).not.toHaveBeenCalled();
    expect(controller.notice()).toBe(noted); expect(refreshActive).toHaveBeenCalledTimes(1);
    expect(controller.snapshot()!.items.map(item => item.commitmentId)).toEqual(['service-boiler']);
    await controller.closeCommitment(key('service-boiler'), 'fulfill');
    expect(close).toHaveBeenCalledWith({ id: 'service-boiler', outcome: 'fulfill' }); expect(acknowledge).toHaveBeenCalledTimes(1);
  });
  it('cancels a renewal as before, and closes it on a shell that wires no acknowledgement', async () => {
    const wired = setup(); await wired.controller.load(() => true);
    await wired.controller.closeCommitment(wired.key('renew-passport'), 'cancel');
    expect(wired.close).toHaveBeenCalledWith({ id: 'renew-passport', outcome: 'cancel' }); expect(wired.acknowledge).not.toHaveBeenCalled();
    const older = setup(false); await older.controller.load(() => true);
    await older.controller.closeCommitment(older.key('renew-passport'), 'fulfill');
    expect(older.close).toHaveBeenCalledWith({ id: 'renew-passport', outcome: 'fulfill' });
  });
});

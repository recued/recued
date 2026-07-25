/** D-113 — Gossip view plane tests. */

import { describe, expect, it } from 'vitest';
import {
  RECENT_RESOLVED_WINDOW_EXT_MS,
  type ApprovalPendingRecord,
  type ApprovalResolutionRecord,
} from '@recued/contracts';
import { createLocalState } from '../data-plane.js';
import {
  visiblePendings,
  createRecentResolvedTracker,
} from '../view-plane.js';

const mkPending = (id: string, over: Partial<ApprovalPendingRecord> = {}): ApprovalPendingRecord => ({
  approval_id: id,
  initiator_instance: 'inst-A',
  recipe_id: 'r',
  step_id: 's',
  prompt: '?',
  created_at: 1,
  timeout_at: 1_000,
  ...over,
});

const mkAction = (id: string, over: Partial<ApprovalResolutionRecord> = {}): ApprovalResolutionRecord => ({
  approval_id: id,
  created_by_instance: 'inst-A',
  kind: 'user_action',
  decision: 'approve',
  resolved_at: 1,
  ...over,
});

describe('visiblePendings', () => {
  it('shows pendings that have no matching action', () => {
    const state = createLocalState();
    state.pending.set('ap-1', mkPending('ap-1'));
    state.pending.set('ap-2', mkPending('ap-2'));
    expect(visiblePendings(state)).toHaveLength(2);
  });

  it('hides pendings with any matching action (even before pair evicts from gossip)', () => {
    const state = createLocalState();
    state.pending.set('ap-1', mkPending('ap-1'));
    state.pending.set('ap-2', mkPending('ap-2'));
    state.action.set('ap-1', [mkAction('ap-1')]);
    const visible = visiblePendings(state);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.approval_id).toBe('ap-2');
  });

  it('treats empty action array as unresolved', () => {
    // Defensive — action map key with empty array shouldn't hide.
    const state = createLocalState();
    state.pending.set('ap-1', mkPending('ap-1'));
    state.action.set('ap-1', []);
    expect(visiblePendings(state)).toHaveLength(1);
  });

  it('returns empty when no pendings', () => {
    expect(visiblePendings(createLocalState())).toEqual([]);
  });
});

describe('RecentResolvedTracker', () => {
  it('add + list surfaces entries within the window', () => {
    const t = createRecentResolvedTracker();
    t.add(mkPending('ap-1'), mkAction('ap-1'), 1_000);
    expect(t.list(1_500)).toHaveLength(1);
  });

  it('filters entries past RECENT_RESOLVED_WINDOW_EXT_MS', () => {
    const t = createRecentResolvedTracker();
    t.add(mkPending('ap-1'), mkAction('ap-1'), 0);
    expect(t.list(RECENT_RESOLVED_WINDOW_EXT_MS - 1)).toHaveLength(1);
    expect(t.list(RECENT_RESOLVED_WINDOW_EXT_MS + 1)).toHaveLength(0);
  });

  it('sweep removes expired entries and reports count', () => {
    const t = createRecentResolvedTracker();
    t.add(mkPending('ap-1'), mkAction('ap-1'), 0);
    t.add(mkPending('ap-2'), mkAction('ap-2'), 0);
    t.add(mkPending('ap-3'), mkAction('ap-3'), 100);
    const removed = t.sweep(RECENT_RESOLVED_WINDOW_EXT_MS + 50);
    expect(removed).toBe(2);
    expect(t.list(RECENT_RESOLVED_WINDOW_EXT_MS + 50)).toHaveLength(1);
  });

  it('list sorts newest first', () => {
    const t = createRecentResolvedTracker();
    t.add(mkPending('ap-1'), mkAction('ap-1'), 100);
    t.add(mkPending('ap-2'), mkAction('ap-2'), 500);
    t.add(mkPending('ap-3'), mkAction('ap-3'), 300);
    const list = t.list(600);
    expect(list.map((e) => e.approval_id)).toEqual(['ap-2', 'ap-3', 'ap-1']);
  });

  it('add is idempotent on approval_id (second add overwrites)', () => {
    const t = createRecentResolvedTracker();
    t.add(mkPending('ap-1'), mkAction('ap-1', { decision: 'approve' }), 100);
    t.add(mkPending('ap-1'), mkAction('ap-1', { decision: 'reject' }), 200);
    const list = t.list(300);
    expect(list).toHaveLength(1);
    expect(list[0]!.effective.decision).toBe('reject');
    expect(list[0]!.registered_at).toBe(200);
  });

  it('list does not mutate — repeated calls return fresh arrays', () => {
    const t = createRecentResolvedTracker();
    t.add(mkPending('ap-1'), mkAction('ap-1'), 0);
    const a = t.list(100);
    const b = t.list(100);
    expect(a).not.toBe(b);         // different array instances
    expect(a).toEqual(b);          // equal content
  });

  it('clear empties the tracker', () => {
    const t = createRecentResolvedTracker();
    t.add(mkPending('ap-1'), mkAction('ap-1'), 0);
    t.add(mkPending('ap-2'), mkAction('ap-2'), 0);
    t.clear();
    expect(t.list(100)).toEqual([]);
  });
});

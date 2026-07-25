import { describe, expect, it, vi } from 'vitest';

import type { PendingAsk } from '@recued/notification';
import type { ActivityEntry, AuditEntry, AuditLogStore } from '@recued/storage';
import {
  handleExecutionRecent,
  handleNotificationRecent,
  handlePendingAsks,
  makeHistoryHandlers,
  type HistoryDeps,
} from '../history-handler.js';

const hasOwn = (obj: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

const auditEntry = (patch: Partial<AuditEntry> = {}): AuditEntry => ({
  run_id: 'run-1',
  recipe_id: 'recipe-1',
  recipe_hash: 'hash-1',
  started_at: 1_800_000_000_000,
  finished_at: 1_800_000_000_123,
  duration_ms: 123,
  commit_status: 'succeeded',
  config_snapshot: {},
  errors: [],
  trigger_url: null,
  trigger_source: null,
  instance_id: null,
  ...patch,
});

const activityEntry = (patch: Partial<ActivityEntry> = {}): ActivityEntry => ({
  activity_id: 'activity-1',
  timestamp: 1_800_000_001_000,
  action: 'notification_fired',
  target: '',
  detail: JSON.stringify({ text: 'Body' }),
  ...patch,
});

const pendingAsk = (patch: Partial<PendingAsk> = {}): PendingAsk => ({
  ask_id: 'ask-1',
  message: { title: 'Approve?', text: 'Choose one' },
  options: [
    { id: 'yes', label: 'Yes' },
    { id: 'no', label: 'No' },
  ],
  handler_kind: 'test.handler',
  handler_payload: {},
  fanout_channels: ['ui'],
  status: 'open',
  created_at: 1_800_000_002_000,
  ...patch,
});

const fakeAuditLog = (patch: Partial<AuditLogStore>): AuditLogStore =>
  patch as unknown as AuditLogStore;

describe('D-169 P2 Slice 2 history handlers', () => {
  it('projects recent audit rows into ServerRecentExecution rows', async () => {
    const listRecent = vi.fn(async () => [
      auditEntry({
        run_id: 'run-failed',
        recipe_id: 'recipe-failed',
        started_at: 1_800_000_000_010,
        duration_ms: 456,
        commit_status: 'failed',
        errors: [
          {
            error_id: 'err-1',
            code: 'RECIPE_APPROVAL_TIMEOUT',
            message: 'timed out',
            severity: 'error',
            source: {
              recipe_id: 'recipe-failed',
              step_id: 'step-1',
              ingredient_slug: 'notify',
            },
            details: {},
            timestamp: '2026-05-28T18:00:00.000Z',
            retryable: false,
          },
        ],
      }),
      auditEntry({
        run_id: 'run-ok',
        recipe_id: 'recipe-ok',
        started_at: 1_800_000_000_020,
        duration_ms: 111,
        commit_status: 'succeeded',
        errors: [],
      }),
    ]);

    const out = await handleExecutionRecent(
      { auditLog: fakeAuditLog({ listRecent }) },
      { limit: 2 },
    );

    expect(out).toEqual({
      executions: [
        {
          run_id: 'run-failed',
          recipe_id: 'recipe-failed',
          status: 'failed',
          started_at: 1_800_000_000_010,
          duration_ms: 456,
          error_category: 'RECIPE_APPROVAL_TIMEOUT',
          // D-161 P3 — rows with no execution_source read in the 'system'
          // lane (P1 column-default semantics).
          origin_actor: 'system',
        },
        {
          run_id: 'run-ok',
          recipe_id: 'recipe-ok',
          status: 'succeeded',
          started_at: 1_800_000_000_020,
          duration_ms: 111,
          origin_actor: 'system',
        },
      ],
    });
    expect(hasOwn(out.executions[1]!, 'error_category')).toBe(false);
  });

  it('returns an empty execution slice when auditLog is absent', async () => {
    await expect(handleExecutionRecent({}, { limit: 10 })).resolves.toEqual({
      executions: [],
    });
  });

  it('clamps execution.recent limits before reading the audit log', async () => {
    const listRecent = vi.fn(async () => []);
    const deps: HistoryDeps = { auditLog: fakeAuditLog({ listRecent }) };
    const cases: Array<{ limit: number | undefined; expected: number }> = [
      { limit: undefined, expected: 50 },
      { limit: 5000, expected: 200 },
      { limit: 0, expected: 50 },
      { limit: -7, expected: 50 },
      { limit: Number.NaN, expected: 50 },
      { limit: 12.9, expected: 12 },
    ];

    for (const c of cases) {
      listRecent.mockClear();
      await handleExecutionRecent(deps, { limit: c.limit });
      // D-161 P3 — the aggregate feed now passes the default foreground
      // lane (`user_self`+`system`) as the 2nd `listRecent` arg.
      expect(listRecent).toHaveBeenCalledWith(c.expected, {
        origin_actors: ['user_self', 'system'],
      });
    }
  });

  it('filters fired notifications newest-first and slices after filtering', async () => {
    const listActivities = vi.fn(async () => [
      activityEntry({
        activity_id: 'n-3',
        timestamp: 1_800_000_003_000,
        detail: JSON.stringify({
          title: 'Newest',
          text: 'Newest body',
          link_url: 'https://example.test/newest',
        }),
      }),
      activityEntry({
        activity_id: 'other-1',
        timestamp: 1_800_000_002_900,
        action: 'server_boot',
        detail: 'ignored',
      }),
      activityEntry({
        activity_id: 'n-2',
        timestamp: 1_800_000_002_000,
        detail: '{not json',
      }),
      activityEntry({
        activity_id: 'n-1',
        timestamp: 1_800_000_001_000,
        detail: JSON.stringify({ text: 'Oldest body' }),
      }),
    ]);

    const out = await handleNotificationRecent(
      { auditLog: fakeAuditLog({ listActivities }) },
      { limit: 2 },
    );

    expect(out).toEqual({
      notifications: [
        {
          id: 'n-3',
          title: 'Newest',
          text: 'Newest body',
          link_url: 'https://example.test/newest',
          fired_at: 1_800_000_003_000,
        },
        {
          id: 'n-2',
          text: '',
          fired_at: 1_800_000_002_000,
        },
      ],
    });
  });

  it('degrades malformed and absent notification details to empty text rows', async () => {
    const listActivities = vi.fn(async () => [
      activityEntry({
        activity_id: 'bad-json',
        timestamp: 1_800_000_004_000,
        detail: '{bad',
      }),
      activityEntry({
        activity_id: 'absent-detail',
        timestamp: 1_800_000_003_000,
        detail: undefined,
      }),
    ]);

    await expect(
      handleNotificationRecent(
        { auditLog: fakeAuditLog({ listActivities }) },
        {},
      ),
    ).resolves.toEqual({
      notifications: [
        { id: 'bad-json', text: '', fired_at: 1_800_000_004_000 },
        { id: 'absent-detail', text: '', fired_at: 1_800_000_003_000 },
      ],
    });
  });

  it('returns an empty notification slice when auditLog is absent', async () => {
    await expect(handleNotificationRecent({}, { limit: 10 })).resolves.toEqual({
      notifications: [],
    });
  });

  it('sorts open asks newest-first and projects ServerPendingAsk rows', async () => {
    const listOpenAsks = vi.fn(async () => [
      pendingAsk({
        ask_id: 'ask-old',
        message: { text: 'Old body' },
        options: [{ id: 'ack', label: 'Acknowledge' }],
        created_at: 1_800_000_001_000,
      }),
      pendingAsk({
        ask_id: 'ask-new',
        message: { title: 'New title', text: 'New body' },
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ],
        created_at: 1_800_000_003_000,
      }),
    ]);

    const out = await handlePendingAsks({ listOpenAsks });

    expect(out).toEqual({
      asks: [
        {
          ask_id: 'ask-new',
          title: 'New title',
          text: 'New body',
          options: [
            { id: 'yes', label: 'Yes' },
            { id: 'no', label: 'No' },
          ],
          created_at: 1_800_000_003_000,
        },
        {
          ask_id: 'ask-old',
          text: 'Old body',
          options: [{ id: 'ack', label: 'Acknowledge' }],
          created_at: 1_800_000_001_000,
        },
      ],
    });
    expect(hasOwn(out.asks[1]!, 'title')).toBe(false);
  });

  it('returns an empty pending-asks slice when listOpenAsks is absent', async () => {
    await expect(handlePendingAsks({})).resolves.toEqual({ asks: [] });
  });

  it('makeHistoryHandlers(undefined) returns undefined', () => {
    expect(makeHistoryHandlers(undefined)).toBeUndefined();
  });

  it('handler slice exposes the history methods and delegates to the carried deps', async () => {
    const listRecent = vi.fn(async () => [
      auditEntry({ run_id: 'slice-run', recipe_id: 'slice-recipe' }),
    ]);
    const listActivities = vi.fn(async () => [
      activityEntry({
        activity_id: 'slice-notification',
        detail: JSON.stringify({ text: 'Slice notification' }),
      }),
    ]);
    const listOpenAsks = vi.fn(async () => [
      pendingAsk({ ask_id: 'slice-ask', message: { text: 'Slice ask' } }),
    ]);
    const slice = makeHistoryHandlers({
      auditLog: fakeAuditLog({ listRecent, listActivities }),
      listOpenAsks,
    });

    expect(slice?.methods).toEqual([
      'execution.recent',
      'notification.recent',
      'notification.pending_asks',
      // Pre-existing drift surfaced here (NOT D-161 P3): D-169 P2 Slice 3
      // added `notification.submitAnswer` to the handler's methods array
      // (history-handler.ts) without updating this assertion. Aligned while
      // co-editing this file for the P3 origin-projection churn.
      'notification.submitAnswer',
    ]);

    await expect(
      slice!.handlers['execution.recent']({ limit: 1 }, undefined as never),
    ).resolves.toMatchObject({
      executions: [{ run_id: 'slice-run', recipe_id: 'slice-recipe' }],
    });
    await expect(
      slice!.handlers['notification.recent']({ limit: 1 }, undefined as never),
    ).resolves.toMatchObject({
      notifications: [{ id: 'slice-notification', text: 'Slice notification' }],
    });
    await expect(
      slice!.handlers['notification.pending_asks'](
        undefined,
        undefined as never,
      ),
    ).resolves.toMatchObject({
      asks: [{ ask_id: 'slice-ask', text: 'Slice ask' }],
    });
    // D-161 P3 — execution.recent now passes the default foreground lane.
    expect(listRecent).toHaveBeenCalledWith(1, {
      origin_actors: ['user_self', 'system'],
    });
    expect(listActivities).toHaveBeenCalledTimes(1);
    expect(listOpenAsks).toHaveBeenCalledTimes(1);
  });
});

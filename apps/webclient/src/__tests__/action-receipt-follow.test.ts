import { describe, expect, it, vi } from 'vitest';
import type {
  GatedActionApprovalGroup,
  GatedActionGetResponse,
  GatedActionListRequest,
  GatedActionListResponse,
  GatedActionReceipt,
} from '@recued/contracts';

import { followActionReceipts } from '../action-receipt-follow.js';
import { createBroadcastSubscriber } from '../realtime/subscriber.js';

const changeClock = { change_epoch: 'epoch-1', change_floor: 0 } as const;

const memoryStorage = (): {
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  values: Map<string, string>;
} => {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
    },
  };
};

const receipt = (
  overrides: Partial<GatedActionReceipt> = {},
): GatedActionReceipt => ({
  action_ref: 'action-1',
  approval_ref: 'action-1',
  run_id: 'run-1',
  recipe_id: 'recipe-1',
  gated_step_id: 'send-mail',
  status: 'awaiting_approval',
  terminal: false,
  status_message: 'Waiting for owner approval.',
  created_at: 100,
  updated_at: 100,
  change_seq: 1,
  revision: 1,
  ...overrides,
});

const group = (
  overrides: Partial<GatedActionApprovalGroup> = {},
): GatedActionApprovalGroup => ({
  approval_ref: 'action-1',
  status: 'awaiting_approval',
  terminal: false,
  status_message: 'Waiting for approval (1 operation).',
  action_refs: ['action-1'],
  items: 1,
  succeeded: 0,
  failed: 0,
  dispatched: 0,
  denied: 0,
  cancelled: 0,
  in_doubt: 0,
  updated_at: 100,
  change_seq: 1,
  ...overrides,
});

const response = (
  groupOverrides: Partial<GatedActionApprovalGroup> = {},
): GatedActionGetResponse => ({
  receipt: receipt(),
  group: group(groupOverrides),
});

const changed = (
  subscriber: ReturnType<typeof createBroadcastSubscriber>,
  action_ref: string,
  action_revision: number,
  cursor = action_revision,
): void => {
  subscriber.dispatch({
    kind: 'execution',
    recipe_id: 'recipe-1',
    run_id: 'run-1',
    op: 'action_changed',
    action_ref,
    approval_ref: 'batch-1',
    action_revision,
    cursor,
  });
};

describe('followActionReceipts', () => {
  it('treats broadcasts as invalidations and presents only a terminal durable group', async () => {
    const subscriber = createBroadcastSubscriber();
    const getAction = vi.fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response({
        status: 'partial',
        terminal: true,
        status_message: '2 of 3 approved items completed or were handed off.',
        action_refs: ['action-1', 'action-2'],
        items: 3,
        succeeded: 1,
        failed: 1,
        dispatched: 1,
        updated_at: 300,
      }));
    const present = vi.fn();
    const follow = followActionReceipts({
      subscribe: subscriber.on,
      getAction,
      present,
    });

    changed(subscriber, 'action-1', 1);
    await vi.waitFor(() => expect(getAction).toHaveBeenCalledTimes(1));
    expect(present).not.toHaveBeenCalled();

    // A stale replay does not perform another read. The next receipt revision
    // reads the full stable group and emits one aggregate owner update.
    changed(subscriber, 'action-1', 1, 2);
    changed(subscriber, 'action-2', 2, 3);
    await vi.waitFor(() => expect(present).toHaveBeenCalledTimes(1));
    expect(getAction).toHaveBeenCalledTimes(2);
    expect(present).toHaveBeenCalledWith({
      title: 'Approved actions partially completed',
      text: '2 of 3 approved items completed or were handed off.',
    });

    follow.dispose();
    changed(subscriber, 'action-1', 3, 4);
    expect(getAction).toHaveBeenCalledTimes(2);
  });

  it('deduplicates terminal batch reads that converge on the same group outcome', async () => {
    const subscriber = createBroadcastSubscriber();
    const settled = response({
      approval_ref: 'batch-1',
      status: 'succeeded',
      terminal: true,
      status_message: '2 approved items completed.',
      action_refs: ['action-1', 'action-2'],
      items: 2,
      succeeded: 2,
      updated_at: 400,
    });
    const getAction = vi.fn()
      .mockResolvedValueOnce(settled)
      // A late current-ask metadata link may advance updated_at without
      // changing the terminal group outcome. It must not raise a second toast.
      .mockResolvedValueOnce({
        ...settled,
        group: { ...settled.group, updated_at: 401 },
      });
    const present = vi.fn();
    followActionReceipts({
      subscribe: subscriber.on,
      getAction,
      present,
    });

    changed(subscriber, 'action-1', 2);
    changed(subscriber, 'action-2', 2, 3);

    await vi.waitFor(() => expect(getAction).toHaveBeenCalledTimes(2));
    expect(present).toHaveBeenCalledTimes(1);
    expect(present).toHaveBeenCalledWith({
      title: 'Approved actions completed',
      text: '2 approved items completed.',
    });
  });

  it('renders a detached handoff as dispatched rather than completed', async () => {
    const subscriber = createBroadcastSubscriber();
    const present = vi.fn();
    followActionReceipts({
      subscribe: subscriber.on,
      getAction: vi.fn().mockResolvedValue(response({
        status: 'dispatched',
        terminal: true,
        status_message: '1 approved operation handed off.',
        dispatched: 1,
        updated_at: 200,
      })),
      present,
    });

    changed(subscriber, 'action-1', 2);

    await vi.waitFor(() => expect(present).toHaveBeenCalledTimes(1));
    expect(present).toHaveBeenCalledWith({
      title: 'Approved action dispatched',
      text: '1 approved operation handed off.',
    });
  });

  it('isolates durable-read failures and lets the same revision retry', async () => {
    const subscriber = createBroadcastSubscriber();
    const onError = vi.fn();
    const present = vi.fn();
    const getAction = vi.fn()
      .mockRejectedValueOnce(new Error('temporarily unavailable'))
      .mockResolvedValueOnce(response({
        status: 'succeeded',
        terminal: true,
        status_message: '1 approved item completed.',
        succeeded: 1,
        updated_at: 200,
      }));
    followActionReceipts({
      subscribe: subscriber.on,
      getAction,
      present,
      onError,
    });

    changed(subscriber, 'action-1', 2);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    changed(subscriber, 'action-1', 2, 3);
    await vi.waitFor(() => expect(present).toHaveBeenCalledTimes(1));
    expect(getAction).toHaveBeenCalledTimes(2);
  });

  it('retries a failed durable reconciliation without waiting for reconnect', async () => {
    let retry: { handler: () => void; delayMs: number; cancelled: boolean } | undefined;
    const listActions = vi.fn()
      .mockRejectedValueOnce(new Error('temporary list failure'))
      .mockResolvedValueOnce({
        ...changeClock,
        receipts: [],
        groups: [group({
          approval_ref: 'retry-action',
          action_refs: ['retry-action'],
          status: 'succeeded',
          terminal: true,
          status_message: 'Retried action completed.',
          succeeded: 1,
          updated_at: 50,
          change_seq: 2,
        })],
      });
    const present = vi.fn();
    const onError = vi.fn();
    const follow = followActionReceipts({
      subscribe: createBroadcastSubscriber().on,
      getAction: vi.fn(),
      listActions,
      present,
      onError,
      setRetryTimer: (handler, delayMs) => {
        retry = { handler, delayMs, cancelled: false };
        return { cancel: () => { if (retry !== undefined) retry.cancelled = true; } };
      },
    });

    follow.setConnected(true);
    await follow.reconcile();
    expect(onError).toHaveBeenCalledOnce();
    expect(retry).toMatchObject({ delayMs: 1_000, cancelled: false });

    retry!.handler();
    await vi.waitFor(() => expect(present).toHaveBeenCalledOnce());
    expect(listActions).toHaveBeenCalledTimes(2);
    follow.dispose();
  });

  it('reconciles a terminal outcome that completed while the client was offline', async () => {
    const subscriber = createBroadcastSubscriber();
    const present = vi.fn();
    const listActions = vi.fn().mockResolvedValue({
      ...changeClock,
      receipts: [],
      groups: [group({
        approval_ref: 'offline-action',
        status: 'in_doubt',
        terminal: true,
        status_message: 'The server restarted while this action was dispatching.',
        action_refs: ['offline-action'],
        items: 1,
        in_doubt: 1,
        updated_at: 500,
      })],
    });
    const follow = followActionReceipts({
      subscribe: subscriber.on,
      getAction: vi.fn(),
      listActions,
      present,
    });

    await follow.reconcile();

    expect(listActions).toHaveBeenCalledWith({
      status: [
        'succeeded',
        'partial',
        'failed',
        'dispatched',
        'denied',
        'cancelled',
        'in_doubt',
      ],
      limit: 200,
    });
    expect(present).toHaveBeenCalledOnce();
    expect(present).toHaveBeenCalledWith({
      title: 'Action outcome needs review',
      text: 'The server restarted while this action was dispatching.',
    });
  });

  it('persists delivered groups across recreation and reconnect reconciliation', async () => {
    const durable = memoryStorage();
    const settledGroup = group({
      approval_ref: 'batch-offline',
      status: 'succeeded',
      terminal: true,
      status_message: '2 approved items completed.',
      action_refs: ['action-1', 'action-2'],
      items: 2,
      succeeded: 2,
      updated_at: 600,
    });
    const listActions = vi.fn().mockResolvedValue({
      ...changeClock,
      receipts: [],
      groups: [settledGroup],
    });
    const firstPresent = vi.fn();
    const first = followActionReceipts({
      subscribe: createBroadcastSubscriber().on,
      getAction: vi.fn(),
      listActions,
      deliveryStorage: durable.storage,
      present: firstPresent,
    });

    // Concurrent reconnect signals collapse to one RPC and one presentation.
    await Promise.all([first.reconcile(), first.reconcile()]);
    expect(listActions).toHaveBeenCalledTimes(1);
    expect(firstPresent).toHaveBeenCalledTimes(1);
    first.dispose();

    const secondSubscriber = createBroadcastSubscriber();
    const secondPresent = vi.fn();
    const secondGet = vi.fn().mockResolvedValue({
      receipt: receipt({
        action_ref: 'action-1',
        approval_ref: 'batch-offline',
        status: 'succeeded',
        terminal: true,
        revision: 2,
      }),
      group: settledGroup,
    });
    const second = followActionReceipts({
      subscribe: secondSubscriber.on,
      getAction: secondGet,
      listActions,
      deliveryStorage: durable.storage,
      present: secondPresent,
    });

    await second.reconcile();
    changed(secondSubscriber, 'action-1', 2);
    await vi.waitFor(() => expect(secondGet).toHaveBeenCalledTimes(1));

    expect(secondPresent).not.toHaveBeenCalled();
    // The terminal live read schedules a durable pass so its bounded recent key
    // is covered by the persistent change frontier before it can be evicted.
    expect(listActions).toHaveBeenCalledTimes(3);
    expect(durable.values.size).toBe(1);
    second.dispose();
  });

  it('bounds the persisted delivery ledger', async () => {
    const durable = memoryStorage();
    const follow = followActionReceipts({
      subscribe: createBroadcastSubscriber().on,
      getAction: vi.fn(),
      listActions: vi.fn().mockResolvedValue({
        ...changeClock,
        receipts: [],
        groups: [1, 2, 3].map((n) => group({
          approval_ref: `action-${n}`,
          status: 'succeeded',
          terminal: true,
          status_message: `Action ${n} completed.`,
          action_refs: [`action-${n}`],
          succeeded: 1,
          updated_at: n,
          change_seq: n,
        })),
      }),
      deliveryStorage: durable.storage,
      maxDeliveredKeys: 2,
      present: vi.fn(),
    });

    await follow.reconcile();

    const stored = JSON.parse([...durable.values.values()][0]!) as {
      version: number;
      delivered: string[];
      recent: string[];
    };
    expect(stored.version).toBe(4);
    expect(stored.delivered).toHaveLength(1);
    expect(stored.recent).toHaveLength(2);
    expect(stored.recent.some((key) => key.startsWith('action-1:'))).toBe(false);
  });

  it('coalesces a live burst into a follow-up scan before bounded keys can replay', async () => {
    const durable = memoryStorage();
    const terminalGroups = [1, 2, 3].map((n) => group({
      approval_ref: `action-${n}`,
      action_refs: [`action-${n}`],
      status: 'succeeded',
      terminal: true,
      status_message: `Action ${n} completed.`,
      succeeded: 1,
      updated_at: n,
      change_seq: n,
    }));
    let resolveInFlight: ((value: GatedActionListResponse) => void) | undefined;
    const listActions = vi.fn()
      .mockResolvedValueOnce({ ...changeClock, receipts: [], groups: [] })
      .mockImplementationOnce(() => new Promise<GatedActionListResponse>((resolve) => {
        resolveInFlight = resolve;
      }))
      .mockResolvedValue({
        ...changeClock,
        receipts: [],
        groups: terminalGroups,
      });
    const getAction = vi.fn(async ({ action_ref }: { action_ref: string }) => {
      const n = Number(action_ref.slice('action-'.length));
      const terminalGroup = terminalGroups[n - 1]!;
      return {
        receipt: receipt({
          action_ref,
          approval_ref: action_ref,
          status: 'succeeded',
          terminal: true,
          status_message: terminalGroup.status_message,
          updated_at: n,
          change_seq: n,
          revision: 2,
        }),
        group: terminalGroup,
      };
    });
    const subscriber = createBroadcastSubscriber();
    const present = vi.fn();
    const follow = followActionReceipts({
      subscribe: subscriber.on,
      getAction,
      listActions,
      deliveryStorage: durable.storage,
      maxDeliveredKeys: 2,
      present,
    });

    // Establish the current epoch first, then hold a normal connected scan open
    // while more live terminal groups arrive.
    await follow.reconcile();
    const reconciling = follow.reconcile();
    await vi.waitFor(() => expect(resolveInFlight).toBeDefined());
    changed(subscriber, 'action-1', 2);
    changed(subscriber, 'action-2', 2);
    changed(subscriber, 'action-3', 2);
    await vi.waitFor(() => expect(present).toHaveBeenCalledTimes(3));
    const beforeScan = JSON.parse([...durable.values.values()][0]!) as {
      recent: string[];
      pending: string[];
    };
    expect(beforeScan.recent).toHaveLength(2);
    expect(beforeScan.pending).toHaveLength(3);

    resolveInFlight!({ ...changeClock, receipts: [], groups: [] });
    await reconciling;

    expect(listActions).toHaveBeenCalledTimes(3);
    expect(present.mock.calls.map(([toast]) => toast.text)).toEqual([
      'Action 1 completed.',
      'Action 2 completed.',
      'Action 3 completed.',
    ]);
    const afterScan = JSON.parse([...durable.values.values()][0]!) as {
      pending: string[];
    };
    expect(afterScan.pending).toEqual([]);
    follow.dispose();

    const restoredPresent = vi.fn();
    const restored = followActionReceipts({
      subscribe: createBroadcastSubscriber().on,
      getAction: vi.fn(),
      listActions: vi.fn().mockResolvedValue({
        ...changeClock,
        receipts: [],
        groups: terminalGroups,
      }),
      deliveryStorage: durable.storage,
      maxDeliveredKeys: 2,
      present: restoredPresent,
    });
    await restored.reconcile();

    expect(restoredPresent).not.toHaveBeenCalled();
    restored.dispose();
  });

  it('polls durable receipts only while connected and re-arms after each full scan', async () => {
    const polledGroup = group({
      approval_ref: 'external-action',
      action_refs: ['external-action'],
      status: 'dispatched',
      terminal: true,
      status_message: 'The approved operation was handed off.',
      dispatched: 1,
      change_seq: 2,
    });
    const listActions = vi.fn()
      .mockResolvedValueOnce({ ...changeClock, receipts: [], groups: [] })
      .mockResolvedValue({ ...changeClock, receipts: [], groups: [polledGroup] });
    const timers: Array<{
      handler: () => void;
      delayMs: number;
      cancelled: boolean;
    }> = [];
    const present = vi.fn();
    const follow = followActionReceipts({
      subscribe: createBroadcastSubscriber().on,
      getAction: vi.fn(),
      listActions,
      pollIntervalMs: 17,
      setPollTimer: (handler, delayMs) => {
        const timer = { handler, delayMs, cancelled: false };
        timers.push(timer);
        return { cancel: () => { timer.cancelled = true; } };
      },
      present,
    });

    follow.setConnected(true);
    await follow.reconcile();
    expect(timers).toHaveLength(1);
    expect(timers[0]).toMatchObject({ delayMs: 17, cancelled: false });

    timers[0]!.handler();
    await vi.waitFor(() => expect(present).toHaveBeenCalledWith({
      title: 'Approved action dispatched',
      text: 'The approved operation was handed off.',
    }));
    expect(listActions).toHaveBeenCalledTimes(2);
    expect(timers).toHaveLength(2);

    follow.setConnected(false);
    expect(timers[1]).toMatchObject({ cancelled: true });
    follow.dispose();
  });

  it('does not re-arm a retry when a reconciliation fails after disconnect', async () => {
    let rejectList: ((error: unknown) => void) | undefined;
    const setRetryTimer = vi.fn();
    const follow = followActionReceipts({
      subscribe: createBroadcastSubscriber().on,
      getAction: vi.fn(),
      listActions: vi.fn(() => new Promise<GatedActionListResponse>((_resolve, reject) => {
        rejectList = reject;
      })),
      setRetryTimer,
      present: vi.fn(),
    });

    follow.setConnected(true);
    const reconciling = follow.reconcile();
    await vi.waitFor(() => expect(rejectList).toBeDefined());
    follow.setConnected(false);
    rejectList!(new Error('connection closed'));
    await reconciling;

    expect(setRetryTimer).not.toHaveBeenCalled();
    follow.dispose();
  });

  it('pages through an offline burst before advancing its durable watermark', async () => {
    const durable = memoryStorage();
    const listActions = vi.fn(async (args: GatedActionListRequest) =>
      args.before === undefined
        ? {
            ...changeClock,
            receipts: [receipt({ action_ref: 'action-3', updated_at: 300, change_seq: 3 })],
            groups: [group({
              approval_ref: 'action-3',
              action_refs: ['action-3'],
              status: 'succeeded',
              terminal: true,
              status_message: 'Third completed.',
              succeeded: 1,
              updated_at: 300,
              change_seq: 3,
            })],
            next_cursor: { change_seq: 3, action_ref: 'action-3' },
          }
        : {
            ...changeClock,
            receipts: [
              receipt({ action_ref: 'action-2', updated_at: 200, change_seq: 2 }),
              receipt({ action_ref: 'action-1', updated_at: 100, change_seq: 1 }),
            ],
            groups: [
              group({
                approval_ref: 'action-2',
                action_refs: ['action-2'],
                status: 'failed',
                terminal: true,
                status_message: 'Second failed.',
                failed: 1,
                updated_at: 200,
                change_seq: 2,
              }),
              group({
                approval_ref: 'action-1',
                action_refs: ['action-1'],
                status: 'succeeded',
                terminal: true,
                status_message: 'First completed.',
                succeeded: 1,
                updated_at: 100,
                change_seq: 1,
              }),
            ],
          });
    const present = vi.fn();
    const follow = followActionReceipts({
      subscribe: createBroadcastSubscriber().on,
      getAction: vi.fn(),
      listActions,
      deliveryStorage: durable.storage,
      reconcileLimit: 2,
      present,
    });

    await follow.reconcile();

    expect(listActions).toHaveBeenCalledTimes(2);
    expect(listActions.mock.calls[1]?.[0]).toMatchObject({
      before: { change_seq: 3, action_ref: 'action-3' },
    });
    expect(present.mock.calls.map(([toast]) => toast.text)).toEqual([
      'First completed.',
      'Second failed.',
      'Third completed.',
    ]);
    const stored = JSON.parse([...durable.values.values()][0]!) as {
      since_change_seq: number;
      delivered: string[];
    };
    expect(stored.since_change_seq).toBe(3);
    expect(stored.delivered).toHaveLength(1);
  });

  it('does not skip a newer outcome when the wall clock moves backward', async () => {
    const durable = memoryStorage();
    const firstGroup = group({
      approval_ref: 'z-group',
      action_refs: ['z-action'],
      status: 'succeeded',
      terminal: true,
      status_message: 'Original completed.',
      succeeded: 1,
      updated_at: 700,
      change_seq: 10,
    });
    const first = followActionReceipts({
      subscribe: createBroadcastSubscriber().on,
      getAction: vi.fn(),
      listActions: vi.fn().mockResolvedValue({
        ...changeClock,
        receipts: [],
        groups: [firstGroup],
      }),
      deliveryStorage: durable.storage,
      present: vi.fn(),
    });
    await first.reconcile();
    first.dispose();

    const present = vi.fn();
    const listActions = vi.fn().mockResolvedValue({
      ...changeClock,
      receipts: [],
      groups: [
        firstGroup,
        group({
          approval_ref: 'a-late-group',
          action_refs: ['a-late-action'],
          status: 'succeeded',
          terminal: true,
          status_message: 'Late same-millisecond action completed.',
          succeeded: 1,
          updated_at: 650,
          change_seq: 11,
        }),
      ],
    });
    const second = followActionReceipts({
      subscribe: createBroadcastSubscriber().on,
      getAction: vi.fn(),
      listActions,
      deliveryStorage: durable.storage,
      present,
    });

    await second.reconcile();

    expect(listActions).toHaveBeenCalledWith(expect.objectContaining({
      since_change_seq: 10,
    }));
    expect(present).toHaveBeenCalledOnce();
    expect(present).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Late same-millisecond action completed.',
    }));
  });

  it('drops an old-connection get response that resolves after reconnect', async () => {
    let resolveOldGet: ((value: GatedActionGetResponse) => void) | undefined;
    let resolveNewList: ((value: GatedActionListResponse) => void) | undefined;
    const subscriber = createBroadcastSubscriber();
    const present = vi.fn();
    const follow = followActionReceipts({
      subscribe: subscriber.on,
      getAction: vi.fn(() => new Promise<GatedActionGetResponse>((resolve) => {
        resolveOldGet = resolve;
      })),
      listActions: vi.fn(() => new Promise<GatedActionListResponse>((resolve) => {
        resolveNewList = resolve;
      })),
      present,
    });

    follow.setConnected(true);
    changed(subscriber, 'old-lineage-action', 9);
    await vi.waitFor(() => expect(resolveOldGet).toBeDefined());

    follow.setConnected(false);
    follow.prepareReconnect();
    follow.setConnected(true);
    const reconciling = follow.reconcile();
    await vi.waitFor(() => expect(resolveNewList).toBeDefined());
    resolveOldGet!({
      receipt: receipt({
        action_ref: 'old-lineage-action',
        approval_ref: 'old-lineage-action',
        status: 'failed',
        terminal: true,
        status_message: 'Stale old-lineage failure.',
        change_seq: 999,
      }),
      group: group({
        approval_ref: 'old-lineage-action',
        action_refs: ['old-lineage-action'],
        status: 'failed',
        terminal: true,
        status_message: 'Stale old-lineage failure.',
        failed: 1,
        change_seq: 999,
      }),
    });
    await Promise.resolve();
    resolveNewList!({
      change_epoch: 'new-lineage',
      change_floor: 20,
      receipts: [],
      groups: [],
    });
    await reconciling;

    expect(present).not.toHaveBeenCalled();
    follow.dispose();
  });

  it('adopts a restored epoch for a reused action ref and does not replay its catch-up', async () => {
    const durable = memoryStorage();
    const beforeRestore = group({
      approval_ref: 'restored-action',
      action_refs: ['restored-action'],
      status: 'succeeded',
      terminal: true,
      status_message: 'Before restore.',
      succeeded: 1,
      change_seq: 10,
    });
    const first = followActionReceipts({
      subscribe: createBroadcastSubscriber().on,
      getAction: vi.fn(),
      listActions: vi.fn().mockResolvedValue({
        change_epoch: 'epoch-before',
        change_floor: 0,
        receipts: [],
        groups: [beforeRestore],
      }),
      deliveryStorage: durable.storage,
      present: vi.fn(),
    });
    await first.reconcile();
    first.dispose();

    const afterRestore = group({
      // Archive restore may rewind and reuse both stable identities. Status and
      // counts can also converge on the same presentation key; the new epoch is
      // what makes this a distinct owner outcome.
      approval_ref: 'restored-action',
      action_refs: ['restored-action'],
      status: 'succeeded',
      terminal: true,
      status_message: 'After restore.',
      succeeded: 1,
      change_seq: 22,
    });
    const listAfterRestore = vi.fn().mockResolvedValue({
      change_epoch: 'epoch-after',
      change_floor: 21,
      receipts: [],
      // The floor is also enforced client-side after a complete page scan, so
      // even an over-broad/legacy server page cannot replay inherited history.
      groups: [beforeRestore, afterRestore],
    });
    const presentAfterRestore = vi.fn();
    const second = followActionReceipts({
      subscribe: createBroadcastSubscriber().on,
      getAction: vi.fn(),
      listActions: listAfterRestore,
      deliveryStorage: durable.storage,
      present: presentAfterRestore,
    });
    await second.reconcile();
    expect(listAfterRestore).toHaveBeenCalledWith(expect.objectContaining({
      since_change_epoch: 'epoch-before',
      since_change_seq: 10,
    }));
    expect(presentAfterRestore).toHaveBeenCalledOnce();
    expect(presentAfterRestore).toHaveBeenCalledWith(expect.objectContaining({
      text: 'After restore.',
    }));
    second.dispose();

    const thirdPresent = vi.fn();
    const thirdList = vi.fn().mockResolvedValue({
      change_epoch: 'epoch-after',
      change_floor: 21,
      receipts: [],
      groups: [afterRestore],
    });
    const third = followActionReceipts({
      subscribe: createBroadcastSubscriber().on,
      getAction: vi.fn(),
      listActions: thirdList,
      deliveryStorage: durable.storage,
      present: thirdPresent,
    });
    await third.reconcile();

    expect(thirdList).toHaveBeenCalledWith(expect.objectContaining({
      since_change_epoch: 'epoch-after',
      since_change_seq: 22,
    }));
    expect(thirdPresent).not.toHaveBeenCalled();
    const persisted = JSON.parse([...durable.values.values()][0]!) as {
      version: number;
      change_epoch: string;
      since_change_seq: number;
    };
    expect(persisted).toMatchObject({
      version: 4,
      change_epoch: 'epoch-after',
      since_change_seq: 22,
    });
    third.dispose();
  });

  it('defers a live result until new-epoch reconciliation adopts its lineage', async () => {
    const durable = memoryStorage();
    const beforeRestore = group({
      approval_ref: 'restored-action',
      action_refs: ['restored-action'],
      status: 'succeeded',
      terminal: true,
      status_message: 'Before restore.',
      succeeded: 1,
      change_seq: 10,
    });
    const first = followActionReceipts({
      subscribe: createBroadcastSubscriber().on,
      getAction: vi.fn(),
      listActions: vi.fn().mockResolvedValue({
        change_epoch: 'epoch-before',
        change_floor: 0,
        receipts: [],
        groups: [beforeRestore],
      }),
      deliveryStorage: durable.storage,
      present: vi.fn(),
    });
    await first.reconcile();
    first.dispose();

    const afterRestore = group({
      approval_ref: 'restored-action',
      action_refs: ['restored-action'],
      status: 'failed',
      terminal: true,
      status_message: 'The restored action failed.',
      failed: 1,
      change_seq: 22,
    });
    let resolveList: ((value: GatedActionListResponse) => void) | undefined;
    const subscriber = createBroadcastSubscriber();
    const present = vi.fn();
    const afterRestorePage: GatedActionListResponse = {
      change_epoch: 'epoch-after',
      change_floor: 21,
      receipts: [],
      groups: [afterRestore],
    };
    const getAfterRestore = vi.fn().mockResolvedValue({
      receipt: receipt({
        action_ref: 'restored-action',
        approval_ref: 'restored-action',
        status: 'failed',
        terminal: true,
        status_message: 'The restored action failed.',
        change_seq: 22,
      }),
      group: afterRestore,
    });
    const second = followActionReceipts({
      subscribe: subscriber.on,
      getAction: getAfterRestore,
      listActions: vi.fn()
        .mockImplementationOnce(() => new Promise<GatedActionListResponse>((resolve) => {
          resolveList = resolve;
        }))
        .mockResolvedValue(afterRestorePage),
      deliveryStorage: durable.storage,
      present,
    });
    second.prepareReconnect();
    const reconciling = second.reconcile();

    changed(subscriber, 'restored-action', 1);
    await vi.waitFor(() => expect(resolveList).toBeDefined());
    await vi.waitFor(() => expect(getAfterRestore).toHaveBeenCalledOnce());
    await Promise.resolve();
    // The durable get may finish before the list, but presentation waits until
    // the new epoch is known so a crash cannot persist this key under the old
    // lineage and replay it after restoration.
    expect(present).not.toHaveBeenCalled();

    resolveList!(afterRestorePage);
    await reconciling;

    expect(present).toHaveBeenCalledOnce();
    expect(present).toHaveBeenCalledWith({
      title: 'Approved action failed',
      text: 'The restored action failed.',
    });
    second.dispose();
  });

  it('recovers after recreation if the page closes before deferred epoch presentation', async () => {
    const durable = memoryStorage();
    const beforeRestore = group({
      approval_ref: 'restored-action',
      action_refs: ['restored-action'],
      status: 'succeeded',
      terminal: true,
      status_message: 'Before restore.',
      succeeded: 1,
      change_seq: 10,
    });
    const seeded = followActionReceipts({
      subscribe: createBroadcastSubscriber().on,
      getAction: vi.fn(),
      listActions: vi.fn().mockResolvedValue({
        change_epoch: 'epoch-before',
        change_floor: 0,
        receipts: [],
        groups: [beforeRestore],
      }),
      deliveryStorage: durable.storage,
      present: vi.fn(),
    });
    await seeded.reconcile();
    seeded.dispose();

    const afterRestore = group({
      approval_ref: 'restored-action',
      action_refs: ['restored-action'],
      status: 'failed',
      terminal: true,
      status_message: 'After restore failed.',
      failed: 1,
      change_seq: 22,
    });
    let resolveInterruptedList: ((value: GatedActionListResponse) => void) | undefined;
    const interruptedSubscriber = createBroadcastSubscriber();
    const interruptedGet = vi.fn().mockResolvedValue({
      receipt: receipt({
        action_ref: 'restored-action',
        approval_ref: 'restored-action',
        status: 'failed',
        terminal: true,
        status_message: 'After restore failed.',
        change_seq: 22,
      }),
      group: afterRestore,
    });
    const interruptedPresent = vi.fn();
    const interrupted = followActionReceipts({
      subscribe: interruptedSubscriber.on,
      getAction: interruptedGet,
      listActions: vi.fn(() => new Promise<GatedActionListResponse>((resolve) => {
        resolveInterruptedList = resolve;
      })),
      deliveryStorage: durable.storage,
      present: interruptedPresent,
    });
    interrupted.prepareReconnect();
    const interruptedReconcile = interrupted.reconcile();
    changed(interruptedSubscriber, 'restored-action', 1);
    await vi.waitFor(() => expect(interruptedGet).toHaveBeenCalledOnce());
    await Promise.resolve();

    expect(interruptedPresent).not.toHaveBeenCalled();
    interrupted.dispose();
    resolveInterruptedList!({
      change_epoch: 'epoch-after',
      change_floor: 21,
      receipts: [],
      groups: [afterRestore],
    });
    await interruptedReconcile;

    const recoveredPresent = vi.fn();
    const recovered = followActionReceipts({
      subscribe: createBroadcastSubscriber().on,
      getAction: vi.fn(),
      listActions: vi.fn().mockResolvedValue({
        change_epoch: 'epoch-after',
        change_floor: 21,
        receipts: [],
        groups: [afterRestore],
      }),
      deliveryStorage: durable.storage,
      present: recoveredPresent,
    });
    await recovered.reconcile();

    expect(recoveredPresent).toHaveBeenCalledOnce();
    expect(recoveredPresent).toHaveBeenCalledWith({
      title: 'Approved action failed',
      text: 'After restore failed.',
    });
    recovered.dispose();
  });

  it('forgets connection-local revisions before resubscribing after restore', async () => {
    const subscriber = createBroadcastSubscriber();
    const getAction = vi.fn().mockResolvedValue(response({
      status: 'succeeded',
      terminal: true,
      succeeded: 1,
    }));
    const follow = followActionReceipts({
      subscribe: subscriber.on,
      getAction,
      present: vi.fn(),
    });

    changed(subscriber, 'action-1', 5);
    await vi.waitFor(() => expect(getAction).toHaveBeenCalledTimes(1));
    follow.prepareReconnect();
    changed(subscriber, 'action-1', 1);
    await vi.waitFor(() => expect(getAction).toHaveBeenCalledTimes(2));
    follow.dispose();
  });
});

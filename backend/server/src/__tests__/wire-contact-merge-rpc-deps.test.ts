/**
 * Unit coverage for composeContactMergeRpcDeps.
 *
 * Mock shapes are based on:
 * - backend/server/src/composition/bin/wire-contact-merge-rpc-deps.ts
 * - backend/server/src/contact-merge-handler.ts
 */

import { describe, expect, it, vi } from 'vitest';
import {
  CONTACT_MERGE_CANDIDATE_SCAN_TASK_ID,
  type ContactMergeCandidate,
  type ContactMergeScanMode,
  type HousekeepingCycleResult,
  type HousekeepingPerTaskResult,
  type HousekeepingYieldReason,
} from '@recued/contracts';
import type Database from 'better-sqlite3';
import type {
  ContactMergeRpcDeps,
  RemergePromptStore,
} from '../contact-merge-handler.js';
import type {
  ComposeContactMergeRpcDepsInput,
} from '../composition/bin/wire-contact-merge-rpc-deps.js';
import { composeContactMergeRpcDeps } from '../composition/bin/wire-contact-merge-rpc-deps.js';
import type { HousekeepingSchedulerRegistry } from '../composition/bin/housekeeping-scheduler-instance.js';
import type { EventBus } from '../events/bus.js';
import type { HousekeepingScheduler } from '../housekeeping/index.js';
import type { HousekeepingStateStore } from '../housekeeping/state-store.js';
import type { AnnotationStore } from '../storage/annotation-store.js';
import type { ContactStore } from '../storage/contact-store.js';

type EventBusMock = EventBus & {
  emit: ReturnType<typeof vi.fn>;
};
type HousekeepingStateStoreMock = HousekeepingStateStore & {
  set: ReturnType<typeof vi.fn>;
};
type SchedulerMock = HousekeepingScheduler & {
  runOnce: ReturnType<typeof vi.fn>;
};
type SchedulerRegistryMock = HousekeepingSchedulerRegistry & {
  getScheduler: ReturnType<typeof vi.fn>;
};
type DatabaseMock = Database.Database & {
  prepare: ReturnType<typeof vi.fn>;
};
type PreparedStatementMock = {
  get: ReturnType<typeof vi.fn>;
};

const makeContactStore = (): ContactStore =>
  ({ kind: 'contact-store' }) as unknown as ContactStore;

const makeAnnotationStore = (): AnnotationStore =>
  ({ kind: 'annotation-store' }) as unknown as AnnotationStore;

const makePromptStore = (): RemergePromptStore =>
  ({
    get: vi.fn(),
    resolve: vi.fn(),
  }) as unknown as RemergePromptStore;

const makeEventBus = (): EventBusMock =>
  ({
    emit: vi.fn(),
  }) as unknown as EventBusMock;

const makeHousekeepingState = (): HousekeepingStateStoreMock =>
  ({
    set: vi.fn(),
  }) as unknown as HousekeepingStateStoreMock;

const makeTaskResult = (
  overrides: Partial<HousekeepingPerTaskResult> = {},
): HousekeepingPerTaskResult => ({
  task_id: CONTACT_MERGE_CANDIDATE_SCAN_TASK_ID,
  status: 'complete',
  duration_ms: 1,
  ...overrides,
});

const makeCycle = (
  per_task: ReadonlyArray<HousekeepingPerTaskResult> = [makeTaskResult()],
): HousekeepingCycleResult => ({
  preset: 'balanced',
  duration_ms: 1,
  tasks_stepped: per_task.length,
  tasks_complete: per_task.filter((p) => p.status === 'complete').length,
  tasks_yielded: per_task.filter((p) => p.status === 'yield').length,
  tasks_errored: per_task.filter((p) => p.status === 'error').length,
  per_task,
});

const makeYieldCycle = (
  yield_reason?: HousekeepingYieldReason,
): HousekeepingCycleResult => makeCycle([
  makeTaskResult({
    status: 'yield',
    ...(yield_reason !== undefined ? { yield_reason } : {}),
  }),
]);

const makeScheduler = (
  cycles: ReadonlyArray<HousekeepingCycleResult> = [makeCycle()],
): SchedulerMock => {
  const runOnce = vi.fn();
  for (const cycle of cycles) {
    runOnce.mockResolvedValueOnce(cycle);
  }
  return ({
    runOnce,
  }) as unknown as SchedulerMock;
};

const makeSchedulerRegistry = (
  scheduler: HousekeepingScheduler | undefined,
): SchedulerRegistryMock => ({
  getScheduler: vi.fn(() => scheduler),
}) as unknown as SchedulerRegistryMock;

const makeDatabase = (
  row: { c: number } | undefined = { c: 0 },
): {
  database: Database.Database;
  statement: PreparedStatementMock;
  prepare: ReturnType<typeof vi.fn>;
} => {
  const statement: PreparedStatementMock = {
    get: vi.fn(() => row),
  };
  const prepare = vi.fn(() => statement);
  return {
    database: ({ prepare } as unknown as DatabaseMock),
    statement,
    prepare,
  };
};

const makeCandidate = (
  overrides: Partial<ContactMergeCandidate> = {},
): ContactMergeCandidate => ({
  id: 'candidate-1',
  email_a: 'alpha@example.com',
  email_b: 'beta@example.com',
  pair_key: 'alpha@example.com|beta@example.com',
  matched_fields: ['name', 'company'],
  detected_at: 1_700_000_000_000,
  detected_by: 'housekeeping',
  status: 'pending',
  ...overrides,
});

const makeInput = (
  overrides: Partial<ComposeContactMergeRpcDepsInput> = {},
): ComposeContactMergeRpcDepsInput => ({
  contactStore: makeContactStore(),
  annotationStore: makeAnnotationStore(),
  promptStore: makePromptStore(),
  housekeepingState: makeHousekeepingState(),
  db: makeDatabase().database,
  eventBus: makeEventBus(),
  schedulerRegistry: makeSchedulerRegistry(makeScheduler()),
  setActiveScanMode: vi.fn(),
  // D-205 — REQUIRED, not optional, so a composer cannot be constructed without DECIDING
  // whether a merge invalidates the enrichment keyed on the identities it changed. That
  // decision was silently absent for the whole life of `onIdentityChanged` — the hook was
  // declared, fired, and never supplied. These tests exercise the other slices, so they
  // opt out explicitly; the wire itself is pinned in `d-205-merge-identity-cascade-wire`.
  enrichmentCascade: undefined,
  ...overrides,
});

const composeHarness = (
  overrides: Partial<ComposeContactMergeRpcDepsInput> = {},
): {
  input: ComposeContactMergeRpcDepsInput;
  deps: ContactMergeRpcDeps;
} => {
  const input = makeInput(overrides);
  const bundle = composeContactMergeRpcDeps(input);
  if (!bundle.contactMergeDeps) {
    throw new Error('expected configured contact merge deps');
  }
  return {
    input,
    deps: bundle.contactMergeDeps,
  };
};

const getRunScanNow = (
  deps: ContactMergeRpcDeps,
): NonNullable<ContactMergeRpcDeps['runScanNow']> => {
  if (!deps.runScanNow) throw new Error('runScanNow missing');
  return deps.runScanNow;
};

describe('composeContactMergeRpcDeps', () => {
  it('returns undefined deps when contactStore is missing', () => {
    const bundle = composeContactMergeRpcDeps(makeInput({
      contactStore: undefined,
      annotationStore: undefined,
      promptStore: undefined,
      housekeepingState: undefined,
      db: undefined,
    }));

    expect(bundle).toEqual({
      contactMergeDeps: undefined,
    });
  });

  it.each(['inserted', 'resolved'] as const)(
    'emitMergeCandidate emits %s merge candidate events',
    (subkind) => {
      const eventBus = makeEventBus();
      const { deps } = composeHarness({ eventBus });
      const candidate = makeCandidate({
        id: `candidate-${subkind}`,
        pair_key: `alpha@example.com|${subkind}@example.com`,
      });

      deps.emitMergeCandidate?.(subkind, candidate);

      expect(eventBus.emit).toHaveBeenCalledWith({
        kind: 'merge_candidate',
        subkind,
        candidate_id: candidate.id,
        pair_key: candidate.pair_key,
      });
    },
  );

  it('emitMergeCandidate swallows eventBus.emit throws', () => {
    const eventBus = makeEventBus();
    eventBus.emit.mockImplementation(() => {
      throw new Error('emit failed');
    });
    const { deps } = composeHarness({ eventBus });

    expect(() => deps.emitMergeCandidate?.('inserted', makeCandidate())).not.toThrow();
  });

  it('includes annotationStore when supplied', () => {
    const annotationStore = makeAnnotationStore();
    const { deps } = composeHarness({ annotationStore });

    expect(deps.annotationStore).toBe(annotationStore);
    expect(deps).toHaveProperty('annotationStore');
  });

  it('omits annotationStore when absent', () => {
    const { deps } = composeHarness({ annotationStore: undefined });

    expect(deps).not.toHaveProperty('annotationStore');
  });

  it('includes promptStore when supplied', () => {
    const promptStore = makePromptStore();
    const { deps } = composeHarness({ promptStore });

    expect(deps.promptStore).toBe(promptStore);
    expect(deps).toHaveProperty('promptStore');
  });

  it('omits promptStore when absent', () => {
    const { deps } = composeHarness({ promptStore: undefined });

    expect(deps).not.toHaveProperty('promptStore');
  });

  it('omits runScanNow when housekeepingState is missing', () => {
    const { deps } = composeHarness({ housekeepingState: undefined });

    expect(deps).not.toHaveProperty('runScanNow');
  });

  it('omits runScanNow when db is missing', () => {
    const { deps } = composeHarness({ db: undefined });

    expect(deps).not.toHaveProperty('runScanNow');
  });

  it('includes runScanNow when housekeepingState and db are supplied', () => {
    const { deps } = composeHarness({
      housekeepingState: makeHousekeepingState(),
      db: makeDatabase().database,
    });

    expect(deps.runScanNow).toEqual(expect.any(Function));
    expect(deps).toHaveProperty('runScanNow');
  });

  it('runScanNow throws when the scheduler is not yet constructed', async () => {
    const { deps } = composeHarness({
      schedulerRegistry: makeSchedulerRegistry(undefined),
    });

    await expect(getRunScanNow(deps)({ mode: 'delta' })).rejects.toThrow(
      new Error('housekeeping scheduler not yet constructed'),
    );
  });

  it('resets the scan cursor for full scans', async () => {
    const lastRunAt = 1_700_000_111_000;
    const startTs = 1_700_000_111_123;
    const dateNow = vi.spyOn(Date, 'now')
      .mockReturnValueOnce(lastRunAt)
      .mockReturnValueOnce(startTs);
    const housekeepingState = makeHousekeepingState();
    const { deps } = composeHarness({
      housekeepingState,
      schedulerRegistry: makeSchedulerRegistry(makeScheduler([makeCycle()])),
    });

    try {
      await getRunScanNow(deps)({ mode: 'full' });
    } finally {
      dateNow.mockRestore();
    }

    expect(housekeepingState.set).toHaveBeenCalledWith({
      task_id: CONTACT_MERGE_CANDIDATE_SCAN_TASK_ID,
      cursor: { kind: 'time_email', last_seen_at: 0, last_email: '' },
      last_status: 'pending',
      last_run_at: lastRunAt,
      consecutive_errors: 0,
    });
  });

  it('does not reset the scan cursor for delta scans', async () => {
    const housekeepingState = makeHousekeepingState();
    const { deps } = composeHarness({
      housekeepingState,
      schedulerRegistry: makeSchedulerRegistry(makeScheduler([makeCycle()])),
    });

    await getRunScanNow(deps)({ mode: 'delta' });

    expect(housekeepingState.set).not.toHaveBeenCalled();
  });

  it('sets full scan mode before the scheduler loop and restores delta after success', async () => {
    const setActiveScanMode = vi.fn();
    const scheduler = makeScheduler([makeCycle()]);
    const { deps } = composeHarness({
      schedulerRegistry: makeSchedulerRegistry(scheduler),
      setActiveScanMode,
    });

    await getRunScanNow(deps)({ mode: 'full' });

    expect(setActiveScanMode).toHaveBeenNthCalledWith(1, 'full');
    expect(setActiveScanMode.mock.invocationCallOrder[0]).toBeLessThan(
      scheduler.runOnce.mock.invocationCallOrder[0],
    );
    expect(setActiveScanMode).toHaveBeenLastCalledWith('delta');
  });

  it('restores delta scan mode when the scheduler throws', async () => {
    const setActiveScanMode = vi.fn();
    const scheduler = makeScheduler([]);
    scheduler.runOnce.mockRejectedValueOnce(new Error('scheduler failed'));
    const { deps } = composeHarness({
      schedulerRegistry: makeSchedulerRegistry(scheduler),
      setActiveScanMode,
    });

    await expect(getRunScanNow(deps)({ mode: 'full' })).rejects.toThrow(
      'scheduler failed',
    );

    expect(setActiveScanMode).toHaveBeenNthCalledWith(1, 'full');
    expect(setActiveScanMode).toHaveBeenLastCalledWith('delta');
  });

  it('exits the yield-resume loop after one complete cycle', async () => {
    const scheduler = makeScheduler([makeCycle([
      makeTaskResult({ status: 'complete' }),
    ])]);
    const { deps } = composeHarness({
      schedulerRegistry: makeSchedulerRegistry(scheduler),
    });

    const result = await getRunScanNow(deps)({ mode: 'delta' });

    expect(result.iterated).toBe(1);
    expect(scheduler.runOnce).toHaveBeenCalledTimes(1);
    expect(scheduler.runOnce).toHaveBeenCalledWith({
      task_id: CONTACT_MERGE_CANDIDATE_SCAN_TASK_ID,
    });
  });

  it('exits the yield-resume loop after one error cycle', async () => {
    const scheduler = makeScheduler([makeCycle([
      makeTaskResult({ status: 'error' }),
    ])]);
    const { deps } = composeHarness({
      schedulerRegistry: makeSchedulerRegistry(scheduler),
    });

    const result = await getRunScanNow(deps)({ mode: 'delta' });

    expect(result.iterated).toBe(1);
    expect(scheduler.runOnce).toHaveBeenCalledTimes(1);
  });

  it('drains multiple yield cycles until a complete cycle settles the scan', async () => {
    const scheduler = makeScheduler([
      makeYieldCycle('budget_exhausted'),
      makeYieldCycle('budget_exhausted'),
      makeCycle([makeTaskResult({ status: 'complete' })]),
    ]);
    const { deps } = composeHarness({
      schedulerRegistry: makeSchedulerRegistry(scheduler),
    });

    const result = await getRunScanNow(deps)({ mode: 'delta' });

    expect(result.iterated).toBe(3);
    expect(scheduler.runOnce).toHaveBeenCalledTimes(3);
  });

  it('breaks immediately when the cycle omits the contact merge task result', async () => {
    const scheduler = makeScheduler([makeCycle([
      makeTaskResult({
        task_id: 'other-task',
        status: 'complete',
      }),
    ])]);
    const { deps } = composeHarness({
      schedulerRegistry: makeSchedulerRegistry(scheduler),
    });

    const result = await getRunScanNow(deps)({ mode: 'delta' });

    expect(result.iterated).toBe(0);
    expect(scheduler.runOnce).toHaveBeenCalledTimes(1);
  });

  it('stops yield-resume looping at the 50-iteration cap', async () => {
    const scheduler = makeScheduler([]);
    scheduler.runOnce.mockResolvedValue(makeYieldCycle('budget_exhausted'));
    const { deps } = composeHarness({
      schedulerRegistry: makeSchedulerRegistry(scheduler),
    });

    const result = await getRunScanNow(deps)({ mode: 'delta' });

    expect(result.iterated).toBe(50);
    expect(scheduler.runOnce).toHaveBeenCalledTimes(50);
  });

  it.each([
    'budget_exhausted',
    'no_work',
  ] as const)('returns narrowed yield_reason %s', async (yield_reason) => {
    const scheduler = makeScheduler([
      makeYieldCycle(yield_reason),
      makeCycle([makeTaskResult({ status: 'complete' })]),
    ]);
    const { deps } = composeHarness({
      schedulerRegistry: makeSchedulerRegistry(scheduler),
    });

    const result = await getRunScanNow(deps)({ mode: 'delta' });

    expect(result.yield_reason).toBe(yield_reason);
  });

  it.each([
    'dependency_pending',
    'pool_policy_unsatisfiable',
  ] as const)('does not return non-rpc yield_reason %s', async (yield_reason) => {
    const scheduler = makeScheduler([
      makeYieldCycle(yield_reason),
      makeCycle([makeTaskResult({ status: 'complete' })]),
    ]);
    const { deps } = composeHarness({
      schedulerRegistry: makeSchedulerRegistry(scheduler),
    });

    const result = await getRunScanNow(deps)({ mode: 'delta' });

    expect(result).not.toHaveProperty('yield_reason');
  });

  it('returns the latest narrowed yield_reason from a multi-iteration scan', async () => {
    const scheduler = makeScheduler([
      makeYieldCycle('no_work'),
      makeYieldCycle('budget_exhausted'),
      makeCycle([makeTaskResult({ status: 'complete' })]),
    ]);
    const { deps } = composeHarness({
      schedulerRegistry: makeSchedulerRegistry(scheduler),
    });

    const result = await getRunScanNow(deps)({ mode: 'delta' });

    expect(result.yield_reason).toBe('budget_exhausted');
  });

  it('omits yield_reason when the yielded task result has no reason', async () => {
    const scheduler = makeScheduler([
      makeYieldCycle(),
      makeCycle([makeTaskResult({ status: 'complete' })]),
    ]);
    const { deps } = composeHarness({
      schedulerRegistry: makeSchedulerRegistry(scheduler),
    });

    const result = await getRunScanNow(deps)({ mode: 'delta' });

    expect(result).not.toHaveProperty('yield_reason');
  });

  it('surfaces the post-scan housekeeping candidate count and binds the scan start timestamp', async () => {
    const startTs = 1_700_000_222_000;
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(startTs);
    const database = makeDatabase({ c: 7 });
    const { deps } = composeHarness({
      db: database.database,
      schedulerRegistry: makeSchedulerRegistry(makeScheduler([makeCycle()])),
    });

    let result: Awaited<ReturnType<NonNullable<ContactMergeRpcDeps['runScanNow']>>>;
    try {
      result = await getRunScanNow(deps)({ mode: 'delta' });
    } finally {
      dateNow.mockRestore();
    }

    expect(result.surfaced_count).toBe(7);
    expect(database.statement.get).toHaveBeenCalledWith(startTs);
    expect(database.prepare).toHaveBeenCalledWith(expect.stringContaining(
      "detected_by = 'housekeeping'",
    ));
    expect(database.prepare).toHaveBeenCalledWith(expect.stringContaining(
      'detected_at >= ?',
    ));
  });

  it('surfaces zero when the post-scan count query returns no row', async () => {
    const database = makeDatabase(undefined);
    const { deps } = composeHarness({
      db: database.database,
      schedulerRegistry: makeSchedulerRegistry(makeScheduler([makeCycle()])),
    });

    const result = await getRunScanNow(deps)({ mode: 'delta' });

    expect(result.surfaced_count).toBe(0);
  });

  it('passes contactStore, annotationStore, and promptStore references through directly', () => {
    const contactStore = makeContactStore();
    const annotationStore = makeAnnotationStore();
    const promptStore = makePromptStore();
    const { deps } = composeHarness({
      contactStore,
      annotationStore,
      promptStore,
    });

    expect(deps.contactStore).toBe(contactStore);
    expect(deps.annotationStore).toBe(annotationStore);
    expect(deps.promptStore).toBe(promptStore);
  });
});

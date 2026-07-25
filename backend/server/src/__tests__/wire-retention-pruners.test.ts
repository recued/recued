import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Checkpoint } from '@recued/contracts';
import { buildAuditEntry } from '@recued/storage';

import { composeRetentionPruners } from '../composition/bin/wire-retention-pruners.js';

type RegisteredInterval = {
  name: string;
  intervalMs: number;
  tick: () => void;
  fireImmediate: boolean;
};

const makeBackgroundServices = () => ({
  registerInterval: vi.fn(),
});

const makeRuntimeConfig = (value: number | Error = 3600) => ({
  get: vi.fn(() => {
    if (value instanceof Error) {
      throw value;
    }

    return value;
  }),
});

const makeAuditRetention = () => ({
  runSafe: vi.fn(),
});

const makeS2sPreviewStore = () => ({
  pruneExpired: vi.fn(),
});

const makeCorrectionEventsStore = () => ({
  pruneOlderThan: vi.fn(),
});

const composeWithDeps = (overrides: Record<string, unknown> = {}) => {
  const backgroundServices = makeBackgroundServices();
  composeRetentionPruners({
    backgroundServices,
    runtimeConfig: makeRuntimeConfig(),
    auditRetention: undefined,
    s2sPreviewStore: undefined,
    correctionEventsStore: undefined,
    ...overrides,
  } as any);

  return backgroundServices.registerInterval.mock.calls.map(
    ([registration]) => registration,
  ) as RegisteredInterval[];
};

afterEach(() => {
  vi.useRealTimers();
});

describe('composeRetentionPruners per-pruner gating', () => {
  it('registers no intervals when all three stores are absent', () => {
    expect(composeWithDeps()).toHaveLength(0);
  });

  it('registers only audit-prune when audit retention is present', () => {
    const registrations = composeWithDeps({
      auditRetention: makeAuditRetention(),
    });

    expect(registrations).toHaveLength(1);
    expect(registrations[0].name).toBe('audit-prune');
  });

  it('registers only s2s-preview-prune when the s2s preview store is present', () => {
    const registrations = composeWithDeps({
      s2sPreviewStore: makeS2sPreviewStore(),
    });

    expect(registrations).toHaveLength(1);
    expect(registrations[0].name).toBe('s2s-preview-prune');
  });

  it('registers only correction-events-prune when the correction events store is present', () => {
    const registrations = composeWithDeps({
      correctionEventsStore: makeCorrectionEventsStore(),
    });

    expect(registrations).toHaveLength(1);
    expect(registrations[0].name).toBe('correction-events-prune');
  });

  it('registers all pruners in audit, s2s, correction order', () => {
    const registrations = composeWithDeps({
      auditRetention: makeAuditRetention(),
      s2sPreviewStore: makeS2sPreviewStore(),
      correctionEventsStore: makeCorrectionEventsStore(),
    });

    expect(registrations.map((registration) => registration.name)).toEqual([
      'audit-prune',
      's2s-preview-prune',
      'correction-events-prune',
    ]);
  });
});

describe('composeRetentionPruners D-214 expiry handoff', () => {
  it('finalizes the exact chat turn carried by the expired run source', async () => {
    const now = 4_000_000_000;
    const cp: Checkpoint = {
      checkpoint_id: 'cp-chat',
      run_id: 'run-chat',
      recipe_id: 'mail.send',
      gated_step_id: 'send',
      step_state: {},
      created_at: 1,
    };
    let deleted = false;
    let current = buildAuditEntry({
      recipe_id: 'mail.send',
      recipe_hash: 'hash',
      commit_status: 'awaiting_approval',
      duration_ms: 1,
      errors: [],
      config_snapshot: {},
      trigger_url: null,
      trigger_source: 'manual',
      instance_id: 'server',
      run_id: 'run-chat',
      now: 1,
      checkpoint_id: 'cp-chat',
      execution_source: {
        channel: 'chat',
        actor: 'user_self',
        chat_session_id: 'session-chat',
        user_id: 'owner',
        turn_id: 'turn-chat',
      },
    });
    const checkpointStore = {
      list: vi.fn(async () => [cp]),
      get: vi.fn(async () => deleted ? null : cp),
      delete: vi.fn(async () => {
        deleted = true;
      }),
    };
    const auditLog = {
      get: vi.fn(async () => current),
      append: vi.fn(async (entry) => {
        current = entry;
      }),
      logActivity: vi.fn(async () => undefined),
    };
    const finalizeTurn = vi.fn(async () => undefined);
    const registrations = composeWithDeps({
      checkpointStore,
      auditLog,
      executionCaseLifecycle: { finalizeTurn },
      runtimeConfig: {
        get: vi.fn(() => 30),
      },
      now: () => now,
    });

    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.name).toBe('checkpoint-stale-prune');
    registrations[0]!.tick();
    await vi.waitFor(() => {
      expect(finalizeTurn).toHaveBeenCalledWith({
        session_id: 'session-chat',
        turn_id: 'turn-chat',
      });
    });
    expect(deleted).toBe(true);
    expect(current.commit_status).toBe('failed');
  });
});

describe('composeRetentionPruners audit-prune', () => {
  it.each([
    [120, 120_000],
    [30, 60_000],
    [3600, 3_600_000],
  ])('uses %i seconds as %i milliseconds', (seconds, intervalMs) => {
    const runtimeConfig = makeRuntimeConfig(seconds);
    const registrations = composeWithDeps({
      runtimeConfig,
      auditRetention: makeAuditRetention(),
    });

    expect(runtimeConfig.get).toHaveBeenCalledWith('audit.prune_interval_s');
    expect(registrations[0]).toMatchObject({
      name: 'audit-prune',
      intervalMs,
      fireImmediate: true,
    });
  });

  it('falls back to one hour when runtime config throws', () => {
    const registrations = composeWithDeps({
      runtimeConfig: makeRuntimeConfig(new Error('config unavailable')),
      auditRetention: makeAuditRetention(),
    });

    expect(registrations[0].intervalMs).toBe(3_600_000);
    expect(registrations[0].fireImmediate).toBe(true);
  });

  it('invokes runSafe from the tick', () => {
    const auditRetention = makeAuditRetention();
    const registrations = composeWithDeps({ auditRetention });

    registrations[0].tick();

    expect(auditRetention.runSafe).toHaveBeenCalledTimes(1);
  });

  it('does not throw synchronously when runSafe returns a rejected promise', () => {
    const auditRetention = makeAuditRetention();
    const rejected = Promise.reject(new Error('best-effort audit failure'));
    rejected.catch(() => {});
    auditRetention.runSafe.mockReturnValue(rejected);
    const registrations = composeWithDeps({ auditRetention });

    expect(() => registrations[0].tick()).not.toThrow();
    expect(auditRetention.runSafe).toHaveBeenCalledTimes(1);
  });
});

describe('composeRetentionPruners s2s-preview-prune', () => {
  it('registers the fixed one-hour interval and fireImmediate', () => {
    const registrations = composeWithDeps({
      s2sPreviewStore: makeS2sPreviewStore(),
    });

    expect(registrations[0]).toMatchObject({
      name: 's2s-preview-prune',
      intervalMs: 3_600_000,
      fireImmediate: true,
    });
  });

  it('passes the injected now value to pruneExpired', () => {
    const s2sPreviewStore = makeS2sPreviewStore();
    const registrations = composeWithDeps({
      s2sPreviewStore,
      now: () => 999_000,
    });

    registrations[0].tick();

    expect(s2sPreviewStore.pruneExpired).toHaveBeenCalledWith(999_000);
  });

  it('passes Date.now when now is undefined', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_234_567);
    const s2sPreviewStore = makeS2sPreviewStore();
    const registrations = composeWithDeps({ s2sPreviewStore });

    registrations[0].tick();

    expect(s2sPreviewStore.pruneExpired).toHaveBeenCalledWith(1_234_567);
  });

  it('swallows pruneExpired throws', () => {
    const s2sPreviewStore = makeS2sPreviewStore();
    s2sPreviewStore.pruneExpired.mockImplementation(() => {
      throw new Error('prune failed');
    });
    const registrations = composeWithDeps({ s2sPreviewStore });

    expect(() => registrations[0].tick()).not.toThrow();
  });
});

describe('composeRetentionPruners correction-events-prune', () => {
  it('registers the fixed daily interval and fireImmediate', () => {
    const registrations = composeWithDeps({
      correctionEventsStore: makeCorrectionEventsStore(),
    });

    expect(registrations[0]).toMatchObject({
      name: 'correction-events-prune',
      intervalMs: 86_400_000,
      fireImmediate: true,
    });
  });

  it('passes the injected now value to pruneOlderThan', () => {
    const correctionEventsStore = makeCorrectionEventsStore();
    const registrations = composeWithDeps({
      correctionEventsStore,
      now: () => 999_000,
    });

    registrations[0].tick();

    expect(correctionEventsStore.pruneOlderThan).toHaveBeenCalledWith(999_000);
  });

  it('passes Date.now when now is undefined', () => {
    vi.useFakeTimers();
    vi.setSystemTime(7_654_321);
    const correctionEventsStore = makeCorrectionEventsStore();
    const registrations = composeWithDeps({ correctionEventsStore });

    registrations[0].tick();

    expect(correctionEventsStore.pruneOlderThan).toHaveBeenCalledWith(7_654_321);
  });

  it('swallows pruneOlderThan throws', () => {
    const correctionEventsStore = makeCorrectionEventsStore();
    correctionEventsStore.pruneOlderThan.mockImplementation(() => {
      throw new Error('prune failed');
    });
    const registrations = composeWithDeps({ correctionEventsStore });

    expect(() => registrations[0].tick()).not.toThrow();
  });
});

describe('composeRetentionPruners now seam and call independence', () => {
  it('passes the injected now value to both time-based pruners', () => {
    const s2sPreviewStore = makeS2sPreviewStore();
    const correctionEventsStore = makeCorrectionEventsStore();
    const registrations = composeWithDeps({
      s2sPreviewStore,
      correctionEventsStore,
      now: () => 999_000,
    });

    registrations[0].tick();
    registrations[1].tick();

    expect(s2sPreviewStore.pruneExpired).toHaveBeenCalledWith(999_000);
    expect(correctionEventsStore.pruneOlderThan).toHaveBeenCalledWith(999_000);
  });

  it('keeps registrations from separate helper calls independent', () => {
    const firstStore = makeS2sPreviewStore();
    const secondStore = makeS2sPreviewStore();
    const firstRegistrations = composeWithDeps({
      s2sPreviewStore: firstStore,
      now: () => 111,
    });
    const secondRegistrations = composeWithDeps({
      s2sPreviewStore: secondStore,
      now: () => 222,
    });

    firstRegistrations[0].tick();
    secondRegistrations[0].tick();

    expect(firstStore.pruneExpired).toHaveBeenCalledWith(111);
    expect(secondStore.pruneExpired).toHaveBeenCalledWith(222);
  });
});

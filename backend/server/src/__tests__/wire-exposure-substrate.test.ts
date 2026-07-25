/**
 * Unit coverage for composeExposureSubstrate.
 *
 * Mock shapes are based on:
 * - backend/server/src/exposure/index.ts
 * - backend/server/src/network/path-listener-coordinator.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ExposureState,
  PathResolution,
  PathRole,
} from '@recued/contracts';
import type {
  ExposureSideEffects,
  ExposureStateMachine,
  ExposureStateMachineOptions,
} from '../exposure/index.js';
import type { ProductionPathListenerCoordinator } from '../network/path-listener-coordinator.js';

const exposureMocks = vi.hoisted(() => ({
  createExposureStateMachine: vi.fn(),
  createInMemoryExposureStore: vi.fn(),
  inMemoryStore: { kind: 'in-memory-exposure-store' },
}));

const sqliteStoreMocks = vi.hoisted(() => ({
  createSqliteExposureStore: vi.fn(),
  sqliteStore: { kind: 'sqlite-exposure-store' },
}));

const bootstrapMocks = vi.hoisted(() => ({
  deriveBootstrapDerivedExposureState: vi.fn(),
  assertLanListenerBoundOrExit: vi.fn(),
}));

const resetFlagMocks = vi.hoisted(() => ({
  EXPOSURE_RESET_AUDIT_ACTION: 'exposure_reset_via_cli',
  applyResetExposureBoot: vi.fn(),
}));

vi.mock('../exposure/index.js', () => ({
  createExposureStateMachine: exposureMocks.createExposureStateMachine,
  createInMemoryExposureStore: exposureMocks.createInMemoryExposureStore,
}));

vi.mock('../exposure/sqlite-store.js', () => ({
  createSqliteExposureStore: sqliteStoreMocks.createSqliteExposureStore,
}));

vi.mock('../exposure/bootstrap.js', () => ({
  deriveBootstrapDerivedExposureState:
    bootstrapMocks.deriveBootstrapDerivedExposureState,
  assertLanListenerBoundOrExit: bootstrapMocks.assertLanListenerBoundOrExit,
}));

vi.mock('../exposure/reset-flag.js', () => ({
  EXPOSURE_RESET_AUDIT_ACTION: resetFlagMocks.EXPOSURE_RESET_AUDIT_ACTION,
  applyResetExposureBoot: resetFlagMocks.applyResetExposureBoot,
}));

import { composeExposureSubstrate } from '../composition/bin/wire-exposure-substrate.js';

type ComposeInput = Parameters<typeof composeExposureSubstrate>[0];
type MachineMock = ExposureStateMachine & {
  current: ReturnType<typeof vi.fn>;
  reapply: ReturnType<typeof vi.fn>;
};
type ListenerCoordinatorMock = ProductionPathListenerCoordinator & {
  apply: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

const originalPublicReachableEnv = process.env.RECUED_PUBLIC_REACHABLE;

const makeResolution = (
  overrides: Partial<Record<PathRole, PathResolution>> = {},
): Record<PathRole, PathResolution> => ({
  health: { lan: true, public: false },
  ws: { lan: true, public: false },
  mcp: { lan: true, public: false },
  llm_gateway: { lan: true, public: false },
  webhooks: { lan: false, public: false },
  reception: { lan: false, public: false },
  oauth: { lan: false, public: false },
  ask: { lan: false, public: false },
  webclient: { lan: true, public: false },
  ...overrides,
});

const makeExposureState = (
  overrides: Partial<ExposureState> = {},
): ExposureState => ({
  resolution: makeResolution(),
  derived_preset_label: 'lan_only',
  public_mcp_acknowledgement: { acknowledged: false },
  last_changed_at: 1_700_000_000_000,
  changed_by_client_id: 'system:test',
  ...overrides,
});

const makeMachine = (state = makeExposureState()): MachineMock =>
  ({
    current: vi.fn(async () => state),
    reapply: vi.fn(async () => state),
    applyPreset: vi.fn(),
    setPathResolution: vi.fn(),
    setPublicMcpAcknowledgement: vi.fn(),
  }) as unknown as MachineMock;

const makeListenerStatuses = (
  lanListening = true,
): Array<{
  listener: 'lan' | 'public';
  listening: boolean;
  bind_address: string | null;
  failure?: string;
}> => [
  {
    listener: 'lan',
    listening: lanListening,
    bind_address: '192.0.2.20',
    ...(lanListening ? {} : { failure: 'EADDRINUSE' }),
  },
  {
    listener: 'public',
    listening: false,
    bind_address: null,
  },
];

const makeListenerCoordinator = (
  statuses = makeListenerStatuses(),
): ListenerCoordinatorMock =>
  ({
    apply: vi.fn(async () => ({
      lan: { listening: true, bind_address: '192.0.2.20' },
      public: { listening: false, bind_address: null },
    })),
    status: vi.fn(() => statuses),
    stop: vi.fn(async () => {}),
  }) as unknown as ListenerCoordinatorMock;

const makeAuditLog = () => ({
  logActivity: vi.fn(async () => {}),
});

const makeDb = () => ({ kind: 'better-sqlite3-db' }) as any;

let seedState: ExposureState;
let machine: MachineMock;

const resetComposerMocks = (): void => {
  seedState = makeExposureState({
    derived_preset_label: 'custom',
    changed_by_client_id: 'system:bootstrap_derive',
  });
  machine = makeMachine();

  exposureMocks.createExposureStateMachine.mockReset();
  exposureMocks.createExposureStateMachine.mockReturnValue(machine);
  exposureMocks.createInMemoryExposureStore.mockReset();
  exposureMocks.createInMemoryExposureStore.mockReturnValue(
    exposureMocks.inMemoryStore,
  );

  sqliteStoreMocks.createSqliteExposureStore.mockReset();
  sqliteStoreMocks.createSqliteExposureStore.mockReturnValue(
    sqliteStoreMocks.sqliteStore,
  );

  bootstrapMocks.deriveBootstrapDerivedExposureState.mockReset();
  bootstrapMocks.deriveBootstrapDerivedExposureState.mockReturnValue(seedState);
  bootstrapMocks.assertLanListenerBoundOrExit.mockReset();
  bootstrapMocks.assertLanListenerBoundOrExit.mockImplementation(() => {});

  resetFlagMocks.applyResetExposureBoot.mockReset();
  resetFlagMocks.applyResetExposureBoot.mockResolvedValue({
    reset: false,
    persisted: seedState,
  });
};

const composeHarness = async (
  overrides: Partial<ComposeInput> = {},
): Promise<{
  bundle: Awaited<ReturnType<typeof composeExposureSubstrate>>;
  input: ComposeInput;
  listenerCoordinator: ListenerCoordinatorMock;
}> => {
  const listenerCoordinator =
    (overrides.listenerCoordinator as ListenerCoordinatorMock | undefined) ??
    makeListenerCoordinator();
  const input: ComposeInput = {
    args: [],
    db: undefined,
    auditLog: undefined,
    listenerCoordinator,
    webhookPort: 9443,
    lanBindAddress: '192.0.2.20',
    wsHandleClientCount: vi.fn(() => 0),
    ...overrides,
  };
  const bundle = await composeExposureSubstrate(input);
  return { bundle, input, listenerCoordinator };
};

const lastMachineOptions = (): ExposureStateMachineOptions => {
  const call = exposureMocks.createExposureStateMachine.mock.calls.at(-1);
  if (!call) throw new Error('createExposureStateMachine was not called');
  return call[0] as ExposureStateMachineOptions;
};

const lastResetArgs = (): Record<string, any> => {
  const call = resetFlagMocks.applyResetExposureBoot.mock.calls.at(-1);
  if (!call) throw new Error('applyResetExposureBoot was not called');
  return call[0] as Record<string, any>;
};

const auditPayload = (
  overrides: Partial<Parameters<ExposureSideEffects['recordAudit']>[0]> = {},
): Parameters<ExposureSideEffects['recordAudit']>[0] => ({
  action: 'exposure_path_resolution_change',
  resolution: makeResolution({
    webhooks: { lan: true, public: false },
  }),
  derived_preset_label: 'custom',
  public_mcp_acknowledgement: {
    acknowledged: true,
    acknowledged_at: 1_700_000_000_500,
    acknowledged_by_client_id: 'client-1',
    free_text_confirmation: 'I understand public MCP exposure',
  },
  changed_by_client_id: 'client-1',
  path: 'webhooks',
  next_resolution: { lan: true, public: false },
  reason: 'operator request',
  free_text_confirmation: 'confirmed',
  active_ws_connections: 4,
  ...overrides,
});

const installLanBindAssertImplementation = () => {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`exit ${code}`);
  });
  bootstrapMocks.assertLanListenerBoundOrExit.mockImplementation(
    (
      statuses: Array<{ listener: string; listening: boolean }>,
      resolution: Record<PathRole, PathResolution>,
    ) => {
      const anyLanPath = Object.values(resolution).some((r) => r.lan);
      const lan = statuses.find((s) => s.listener === 'lan');
      if (anyLanPath && (!lan || !lan.listening)) {
        process.exit(4);
      }
    },
  );
  return exitSpy;
};

beforeEach(() => {
  delete process.env.RECUED_PUBLIC_REACHABLE;
  resetComposerMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  if (originalPublicReachableEnv === undefined) {
    delete process.env.RECUED_PUBLIC_REACHABLE;
  } else {
    process.env.RECUED_PUBLIC_REACHABLE = originalPublicReachableEnv;
  }
  vi.restoreAllMocks();
});

describe('composeExposureSubstrate env seed', () => {
  it("wires RECUED_PUBLIC_REACHABLE='true' as public_reachable true", async () => {
    process.env.RECUED_PUBLIC_REACHABLE = 'true';

    await composeHarness({ webhookPort: 1443 });

    expect(bootstrapMocks.deriveBootstrapDerivedExposureState).toHaveBeenCalledWith({
      webhook_port: 1443,
      public_reachable: true,
    });
  });

  it("wires RECUED_PUBLIC_REACHABLE='1' as public_reachable true", async () => {
    process.env.RECUED_PUBLIC_REACHABLE = '1';

    await composeHarness({ webhookPort: 2443 });

    expect(bootstrapMocks.deriveBootstrapDerivedExposureState).toHaveBeenCalledWith({
      webhook_port: 2443,
      public_reachable: true,
    });
  });

  it("wires RECUED_PUBLIC_REACHABLE='false' as public_reachable false", async () => {
    process.env.RECUED_PUBLIC_REACHABLE = 'false';

    await composeHarness({ webhookPort: 3443 });

    expect(bootstrapMocks.deriveBootstrapDerivedExposureState).toHaveBeenCalledWith({
      webhook_port: 3443,
      public_reachable: false,
    });
  });

  it('wires an unset RECUED_PUBLIC_REACHABLE as public_reachable false', async () => {
    await composeHarness({ webhookPort: 4443 });

    expect(bootstrapMocks.deriveBootstrapDerivedExposureState).toHaveBeenCalledWith({
      webhook_port: 4443,
      public_reachable: false,
    });
  });
});

describe('composeExposureSubstrate reset flag', () => {
  it('passes resetRequested true to applyResetExposureBoot when --reset-exposure and db are present', async () => {
    await composeHarness({ args: ['--reset-exposure'], db: makeDb() });

    expect(resetFlagMocks.applyResetExposureBoot).toHaveBeenCalledTimes(1);
    expect(lastResetArgs()).toMatchObject({
      store: sqliteStoreMocks.sqliteStore,
      bootstrap: seedState,
      resetRequested: true,
    });
  });

  it('passes resetRequested false to applyResetExposureBoot when the flag is absent', async () => {
    await composeHarness({ args: ['serve'], db: makeDb() });

    expect(resetFlagMocks.applyResetExposureBoot).toHaveBeenCalledTimes(1);
    expect(lastResetArgs()).toMatchObject({
      store: sqliteStoreMocks.sqliteStore,
      bootstrap: seedState,
      resetRequested: false,
    });
  });

  it('does not call applyResetExposureBoot without db even when --reset-exposure is present', async () => {
    await composeHarness({ args: ['--reset-exposure'], db: undefined });

    expect(resetFlagMocks.applyResetExposureBoot).not.toHaveBeenCalled();
    expect(sqliteStoreMocks.createSqliteExposureStore).not.toHaveBeenCalled();
  });

  it('logs the reset audit banner when applyResetExposureBoot reports reset true', async () => {
    resetFlagMocks.applyResetExposureBoot.mockResolvedValueOnce({
      reset: true,
      persisted: seedState,
    });

    await composeHarness({ args: ['--reset-exposure'], db: makeDb() });

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining(resetFlagMocks.EXPOSURE_RESET_AUDIT_ACTION),
    );
  });
});

describe('composeExposureSubstrate store branch', () => {
  it('uses an in-memory store seeded with initialExposureState when db is absent', async () => {
    await composeHarness({ db: undefined });

    expect(exposureMocks.createInMemoryExposureStore).toHaveBeenCalledTimes(1);
    expect(exposureMocks.createInMemoryExposureStore).toHaveBeenCalledWith(
      seedState,
    );
    expect(lastMachineOptions().store).toBe(exposureMocks.inMemoryStore);
  });

  it('uses a SQLite store when db is present', async () => {
    const db = makeDb();

    await composeHarness({ db });

    expect(sqliteStoreMocks.createSqliteExposureStore).toHaveBeenCalledTimes(1);
    expect(sqliteStoreMocks.createSqliteExposureStore).toHaveBeenCalledWith(db);
    expect(exposureMocks.createInMemoryExposureStore).not.toHaveBeenCalled();
    expect(lastMachineOptions().store).toBe(sqliteStoreMocks.sqliteStore);
  });
});

describe('composeExposureSubstrate reset audit emit', () => {
  it('passes a reset recordAudit closure that logs the expected audit shape', async () => {
    const auditLog = makeAuditLog();
    const resolution = makeResolution({ health: { lan: true, public: true } });

    await composeHarness({ db: makeDb(), auditLog: auditLog as any });
    await lastResetArgs().recordAudit({
      action: resetFlagMocks.EXPOSURE_RESET_AUDIT_ACTION,
      resolution,
      changed_by_client_id: 'system:cli_reset',
      reason: '--reset-exposure boot flag',
      applied_at: 1_700_000_000_111,
    });

    expect(auditLog.logActivity).toHaveBeenCalledWith({
      activity_id:
        'exposure:exposure_reset_via_cli:1700000000111',
      timestamp: 1_700_000_000_111,
      action: resetFlagMocks.EXPOSURE_RESET_AUDIT_ACTION,
      target: 'exposure',
      detail: JSON.stringify({
        resolution,
        changed_by_client_id: 'system:cli_reset',
        reason: '--reset-exposure boot flag',
      }),
    });
  });

  it('passes a reset recordAudit closure that no-ops without auditLog', async () => {
    await composeHarness({ db: makeDb(), auditLog: undefined });

    await expect(
      lastResetArgs().recordAudit({
        action: resetFlagMocks.EXPOSURE_RESET_AUDIT_ACTION,
        resolution: makeResolution(),
        changed_by_client_id: 'system:cli_reset',
        reason: '--reset-exposure boot flag',
        applied_at: 1_700_000_000_222,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('composeExposureSubstrate exposure audit and broadcast effects', () => {
  it('records exposure audit rows with action, target, and detail JSON', async () => {
    const auditLog = makeAuditLog();
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_333);
    const payload = auditPayload();

    await composeHarness({ auditLog: auditLog as any });
    await lastMachineOptions().effects.recordAudit(payload);

    expect(auditLog.logActivity).toHaveBeenCalledWith({
      activity_id:
        'exposure:exposure_path_resolution_change:1700000000333',
      timestamp: 1_700_000_000_333,
      action: 'exposure_path_resolution_change',
      target: 'webhooks',
      detail: JSON.stringify({
        resolution: payload.resolution,
        derived_preset_label: 'custom',
        public_mcp_acknowledged: true,
        next_resolution: { lan: true, public: false },
        changed_by_client_id: 'client-1',
        reason: 'operator request',
        free_text_confirmation: 'confirmed',
        active_ws_connections: 4,
      }),
    });
  });

  it('no-ops exposure audit rows when auditLog is absent', async () => {
    await composeHarness({ auditLog: undefined });

    await expect(
      lastMachineOptions().effects.recordAudit(auditPayload()),
    ).resolves.toBeUndefined();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('swallows exposure audit emit failures and logs a warning', async () => {
    const auditLog = {
      logActivity: vi.fn(async () => {
        throw new Error('audit offline');
      }),
    };

    await composeHarness({ auditLog: auditLog as any });

    await expect(
      lastMachineOptions().effects.recordAudit(auditPayload()),
    ).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(
      '[exposure] audit emit failed',
      'audit offline',
    );
  });

  it('broadcast fans an exposure_changed event onto the D-121 bus', async () => {
    const emit = vi.fn();
    await composeHarness({ eventBus: { emit } as any });

    const resolution = makeResolution({ ws: { lan: true, public: true } });
    const public_mcp_acknowledgement = {
      acknowledged: true,
      acknowledged_at: 1_700_000_000_500,
      acknowledged_by_client_id: 'client-9',
      free_text_confirmation: 'I understand public MCP exposure',
    };

    await lastMachineOptions().effects.broadcast({
      type: 'exposure_changed',
      resolution,
      derived_preset_label: 'public',
      public_mcp_acknowledgement,
      changed_at: 1_700_000_000_555,
      changed_by_client_id: 'client-9',
    });

    // Mapped onto the bus envelope: `type` → `kind`; the bus stamps
    // `cursor`, so the emit input omits it.
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      kind: 'exposure_changed',
      resolution,
      derived_preset_label: 'public',
      public_mcp_acknowledgement,
      changed_at: 1_700_000_000_555,
      changed_by_client_id: 'client-9',
    });
  });

  it('broadcast no-ops when no event bus is threaded (db-less harness)', async () => {
    await composeHarness();

    await expect(
      lastMachineOptions().effects.broadcast({
        type: 'exposure_changed',
        resolution: makeResolution(),
        derived_preset_label: 'lan_only',
        public_mcp_acknowledgement: { acknowledged: false },
        changed_at: 1_700_000_000_000,
        changed_by_client_id: 'system:test',
      }),
    ).resolves.toBeUndefined();
  });

  it('broadcast swallows a wedged bus emit (best-effort fan-out)', async () => {
    const emit = vi.fn(() => {
      throw new Error('bus offline');
    });
    await composeHarness({ eventBus: { emit } as any });

    await expect(
      lastMachineOptions().effects.broadcast({
        type: 'exposure_changed',
        resolution: makeResolution(),
        derived_preset_label: 'custom',
        public_mcp_acknowledgement: { acknowledged: true },
        changed_at: 1_700_000_000_111,
        changed_by_client_id: 'client-2',
      }),
    ).resolves.toBeUndefined();
    expect(emit).toHaveBeenCalledTimes(1);
  });
});

describe('composeExposureSubstrate state-machine args', () => {
  it('passes the listener, expected store, and bind addresses', async () => {
    const listenerCoordinator = makeListenerCoordinator();

    await composeHarness({
      db: makeDb(),
      listenerCoordinator,
      lanBindAddress: '10.0.0.7',
    });

    expect(lastMachineOptions()).toMatchObject({
      listener: listenerCoordinator,
      store: sqliteStoreMocks.sqliteStore,
      bind_addresses: { lan: '10.0.0.7', public: '0.0.0.0' },
    });
  });

  it('threads a live activeWsConnections count getter', async () => {
    let count = 2;
    const wsHandleClientCount = vi.fn(() => count);

    await composeHarness({ wsHandleClientCount });
    count = 9;

    expect(lastMachineOptions().activeWsConnections?.count()).toBe(9);
    expect(wsHandleClientCount).toHaveBeenCalledTimes(1);
  });

  it('passes a DDNS availability stub that resolves false', async () => {
    await composeHarness();

    await expect(lastMachineOptions().ddns.isConfigured()).resolves.toBe(false);
  });

  it('passes exposure effects into the state machine', async () => {
    await composeHarness();

    expect(lastMachineOptions().effects.recordAudit).toBeTypeOf('function');
    expect(lastMachineOptions().effects.broadcast).toBeTypeOf('function');
  });
});

describe('composeExposureSubstrate finalize ordering', () => {
  it('returns the exposure machine and a deferred finalize function', async () => {
    const { bundle } = await composeHarness();

    expect(bundle.exposureMachine).toBe(machine);
    expect(bundle.finalize).toBeTypeOf('function');
    expect(machine.reapply).not.toHaveBeenCalled();
  });

  it('runs reapply before status read and LAN assertion', async () => {
    const order: string[] = [];
    machine.reapply.mockImplementation(async () => {
      order.push('reapply');
      return seedState;
    });
    machine.current.mockImplementation(async () => {
      order.push('current');
      return seedState;
    });
    const listenerCoordinator = makeListenerCoordinator();
    listenerCoordinator.status.mockImplementation(() => {
      order.push('status');
      return makeListenerStatuses();
    });
    bootstrapMocks.assertLanListenerBoundOrExit.mockImplementation(() => {
      order.push('assert');
    });

    const { bundle } = await composeHarness({ listenerCoordinator });
    await bundle.finalize();

    expect(order).toEqual(['reapply', 'current', 'status', 'assert']);
  });

  it('passes postReapplyState.resolution into assertLanListenerBoundOrExit', async () => {
    const postReapplyResolution = makeResolution({
      ws: { lan: false, public: false },
    });
    const postReapplyState = makeExposureState({
      resolution: postReapplyResolution,
    });
    machine.current.mockResolvedValueOnce(postReapplyState);

    const { bundle } = await composeHarness();
    await bundle.finalize();

    expect(bootstrapMocks.assertLanListenerBoundOrExit).toHaveBeenCalledWith(
      expect.any(Array),
      postReapplyResolution,
    );
  });
});

describe('composeExposureSubstrate LAN bind assertion', () => {
  it('does not exit when the stub status reports LAN bound', async () => {
    const exitSpy = installLanBindAssertImplementation();
    const listenerCoordinator = makeListenerCoordinator(makeListenerStatuses(true));

    const { bundle } = await composeHarness({ listenerCoordinator });
    await expect(bundle.finalize()).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits with code 4 when the stub status reports LAN unbound', async () => {
    const exitSpy = installLanBindAssertImplementation();
    const listenerCoordinator = makeListenerCoordinator(makeListenerStatuses(false));

    const { bundle } = await composeHarness({ listenerCoordinator });

    await expect(bundle.finalize()).rejects.toThrow('exit 4');
    expect(exitSpy).toHaveBeenCalledWith(4);
  });
});

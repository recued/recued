/**
 * Unit coverage for composeObservabilityRpcDeps.
 *
 * Mock shapes are based on:
 * - backend/server/src/composition/bin/wire-observability-rpc-deps.ts
 * - packages/scheduler/src/auto-disabled.ts
 */

import { describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { AutoRunEntryLike } from '@recued/scheduler';
import type { AuditLogStore, CheckpointStore, CommitStore } from '@recued/storage';
import type {
  ApprovalHandlerDeps,
  ApprovalStore,
} from '../approval-handler.js';
import type {
  CircuitBreakerStore,
  ServerAutoRunHandle,
} from '../auto-run-scheduler.js';
import type {
  ComposeObservabilityRpcDepsInput,
} from '../composition/bin/wire-observability-rpc-deps.js';
import { composeObservabilityRpcDeps } from '../composition/bin/wire-observability-rpc-deps.js';
import type { EventBus } from '../events/bus.js';
import type { PairingManager } from '../pairing.js';
import type { RecipeStore } from '../recipe-store.js';
import type { WsClient } from '../ws-server.js';

type ApprovalPushPayload = Parameters<ApprovalHandlerDeps['pushToClient']>[1];
type WebSocketMock = {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
};
type WsClientMock = WsClient & {
  ws: WebSocketMock;
};
type RecipeStoreMock = RecipeStore & {
  get: ReturnType<typeof vi.fn>;
};
type PairingManagerMock = PairingManager & {
  getRealmToken: ReturnType<typeof vi.fn>;
};
type CircuitBreakerStoreMock = CircuitBreakerStore & {
  get: ReturnType<typeof vi.fn>;
};

const makeRecipeStore = (
  recipes: ReadonlyMap<string, unknown> = new Map(),
): RecipeStoreMock =>
  ({
    get: vi.fn((recipe_id: string) => recipes.get(recipe_id) ?? null),
  }) as unknown as RecipeStoreMock;

const makeApprovalStore = (): ApprovalStore =>
  ({ kind: 'approval-store' }) as unknown as ApprovalStore;

const makeEventBus = (): EventBus =>
  ({ kind: 'event-bus' }) as unknown as EventBus;

const makeDatabase = (): Database.Database =>
  ({ kind: 'database' }) as unknown as Database.Database;

const makeAuditLog = (): AuditLogStore =>
  ({ kind: 'audit-log' }) as unknown as AuditLogStore;

const makeCheckpointStore = (): CheckpointStore =>
  ({ kind: 'checkpoint-store' }) as unknown as CheckpointStore;

const makeCommitStore = (): CommitStore =>
  ({ kind: 'commit-store' }) as unknown as CommitStore;

const makePairing = (
  token = 'realm-token',
): PairingManagerMock =>
  ({
    getRealmToken: vi.fn(() => token),
  }) as unknown as PairingManagerMock;

const makeCircuitStore = (
  entries: ReadonlyMap<string, { last_failure_reason?: string }> = new Map(),
): CircuitBreakerStoreMock =>
  ({
    get: vi.fn((recipe_id: string) => entries.get(recipe_id)),
  }) as unknown as CircuitBreakerStoreMock;

const makeRosterEntry = (
  overrides: Partial<AutoRunEntryLike> & Pick<AutoRunEntryLike, 'recipe_id'>,
): AutoRunEntryLike => ({
  publisher_id: 'recued-core',
  auto_disabled: true,
  consecutive_failures: 3,
  process_id: `process-${overrides.recipe_id}`,
  last_finished_at: 1_700_000_000_000,
  ...overrides,
});

const makeAutoRunHandle = (
  entries: ReadonlyArray<AutoRunEntryLike>,
): ServerAutoRunHandle =>
  ({
    roster: new Map(entries.map((entry) => [entry.recipe_id, entry])),
  }) as unknown as ServerAutoRunHandle;

const makeWsClient = (
  readyState: number,
  send: ReturnType<typeof vi.fn> = vi.fn(),
): WsClientMock =>
  ({
    ws: { readyState, send },
    realm: 'realm',
    instance_id: 'instance-1',
    display_name: 'Test Client',
    connected_at: 1_700_000_000_000,
  }) as unknown as WsClientMock;

const makePayload = (
  event: ApprovalPushPayload['event'] = { seq: 1, pending_count: 2 },
): ApprovalPushPayload => ({
  type: 'approval_changed',
  event,
});

const makeInput = (
  overrides: Partial<ComposeObservabilityRpcDepsInput> = {},
): ComposeObservabilityRpcDepsInput => ({
  recipeStore: makeRecipeStore(),
  approvalStore: makeApprovalStore(),
  eventBus: makeEventBus(),
  serverStartedAt: 1_700_000_111_000,
  db: makeDatabase(),
  auditLog: makeAuditLog(),
  checkpointStore: makeCheckpointStore(),
  commitStore: makeCommitStore(),
  serverInstanceId: 'server-a',
  pairing: makePairing(),
  circuitStore: makeCircuitStore(),
  getAutoRunHandle: vi.fn(() => undefined),
  ...overrides,
});

const composeHarness = (
  overrides: Partial<ComposeObservabilityRpcDepsInput> = {},
): {
  input: ComposeObservabilityRpcDepsInput;
  bundle: ReturnType<typeof composeObservabilityRpcDeps>;
} => {
  const input = makeInput(overrides);
  return {
    input,
    bundle: composeObservabilityRpcDeps(input),
  };
};

const getStatusPageDeps = (
  bundle: ReturnType<typeof composeObservabilityRpcDeps>,
) => {
  if (!bundle.statusPageDeps) throw new Error('expected statusPageDeps');
  return bundle.statusPageDeps;
};

describe('composeObservabilityRpcDeps', () => {
  it('passes recipeStore and serverStartedAt through to recipeListDeps', () => {
    const recipeStore = makeRecipeStore();
    const { bundle } = composeHarness({
      recipeStore,
      serverStartedAt: 1_700_000_222_000,
    });

    expect(bundle.recipeListDeps).toEqual({
      store: recipeStore,
      serverStartedAt: 1_700_000_222_000,
    });
  });

  it('pushToClient sends JSON.stringify(payload) when the websocket is open', () => {
    const { bundle } = composeHarness();
    const client = makeWsClient(1);
    const payload = makePayload({ seq: 7, pending_count: 4 });

    bundle.approvalDeps.pushToClient(client, payload);

    expect(client.ws.send).toHaveBeenCalledWith(JSON.stringify(payload));
  });

  it('pushToClient does not call ws.send when readyState is 0', () => {
    const { bundle } = composeHarness();
    const client = makeWsClient(0);

    bundle.approvalDeps.pushToClient(client, makePayload());

    expect(client.ws.send).not.toHaveBeenCalled();
  });

  it('pushToClient does not call ws.send when readyState is 2', () => {
    const { bundle } = composeHarness();
    const client = makeWsClient(2);

    bundle.approvalDeps.pushToClient(client, makePayload());

    expect(client.ws.send).not.toHaveBeenCalled();
  });

  it('pushToClient does not call ws.send when readyState is 3', () => {
    const { bundle } = composeHarness();
    const client = makeWsClient(3);

    bundle.approvalDeps.pushToClient(client, makePayload());

    expect(client.ws.send).not.toHaveBeenCalled();
  });

  it('pushToClient swallows ws.send throws', () => {
    const send = vi.fn(() => {
      throw new Error('send failed');
    });
    const { bundle } = composeHarness();
    const client = makeWsClient(1, send);

    expect(() => bundle.approvalDeps.pushToClient(client, makePayload())).not.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('pushToClient serializes the exact approval_changed payload', () => {
    const { bundle } = composeHarness();
    const client = makeWsClient(1);
    const payload = makePayload({
      seq: 9,
      pending_count: 6,
    });

    bundle.approvalDeps.pushToClient(client, payload);

    expect(JSON.parse(client.ws.send.mock.calls[0][0])).toEqual({
      type: 'approval_changed',
      event: {
        seq: 9,
        pending_count: 6,
      },
    });
  });

  it('passes eventBus through as eventsDeps.bus', () => {
    const eventBus = makeEventBus();
    const { bundle } = composeHarness({ eventBus });

    expect(bundle.eventsDeps).toEqual({ bus: eventBus });
  });

  it('defines auditExportDeps with db, auditLog, and serverInstanceId when both stores are present', () => {
    const db = makeDatabase();
    const auditLog = makeAuditLog();
    const { bundle } = composeHarness({
      db,
      auditLog,
      serverInstanceId: 'server-export',
    });

    expect(bundle.auditExportDeps).toEqual({
      db,
      auditLog,
      serverInstanceId: 'server-export',
    });
  });

  it('defines executionFeedDeps with db, auditLog, checkpointStore, commitStore, and serverInstanceId when all stores are present', () => {
    const db = makeDatabase();
    const auditLog = makeAuditLog();
    const checkpointStore = makeCheckpointStore();
    const commitStore = makeCommitStore();
    const { bundle } = composeHarness({
      db,
      auditLog,
      checkpointStore,
      commitStore,
      serverInstanceId: 'server-runs',
    });

    expect(bundle.executionFeedDeps).toEqual({
      db,
      auditLog,
      checkpointStore,
      commitStore,
      serverInstanceId: 'server-runs',
    });
  });

  it('returns undefined auditExportDeps when db is undefined', () => {
    const { bundle } = composeHarness({ db: undefined });

    expect(bundle.auditExportDeps).toBeUndefined();
    expect(bundle.executionFeedDeps).toBeUndefined();
  });

  it('returns undefined auditExportDeps when auditLog is undefined', () => {
    const { bundle } = composeHarness({ auditLog: undefined });

    expect(bundle.auditExportDeps).toBeUndefined();
    expect(bundle.executionFeedDeps).toBeUndefined();
  });

  it('returns undefined executionFeedDeps when checkpointStore is undefined', () => {
    const { bundle } = composeHarness({ checkpointStore: undefined });

    expect(bundle.auditExportDeps).toBeDefined();
    expect(bundle.executionFeedDeps).toBeUndefined();
  });

  it('returns undefined executionFeedDeps when commitStore is undefined', () => {
    const { bundle } = composeHarness({ commitStore: undefined });

    expect(bundle.auditExportDeps).toBeDefined();
    expect(bundle.executionFeedDeps).toBeUndefined();
  });

  it('returns undefined auditExportDeps when db and auditLog are undefined', () => {
    const { bundle } = composeHarness({
      db: undefined,
      auditLog: undefined,
    });

    expect(bundle.auditExportDeps).toBeUndefined();
  });

  it('defines statusPageDeps when pairing and circuitStore are present', () => {
    const { bundle } = composeHarness({
      pairing: makePairing('realm-present'),
      circuitStore: makeCircuitStore(),
    });

    expect(bundle.statusPageDeps).toEqual({
      realmToken: 'realm-present',
      serverId: 'server-a',
      buildSummary: expect.any(Function),
    });
  });

  it('returns undefined statusPageDeps when pairing is undefined', () => {
    const { bundle } = composeHarness({ pairing: undefined });

    expect(bundle.statusPageDeps).toBeUndefined();
  });

  it('returns undefined statusPageDeps when circuitStore is undefined', () => {
    const { bundle } = composeHarness({ circuitStore: undefined });

    expect(bundle.statusPageDeps).toBeUndefined();
  });

  it('returns undefined statusPageDeps when pairing and circuitStore are undefined', () => {
    const { bundle } = composeHarness({
      pairing: undefined,
      circuitStore: undefined,
    });

    expect(bundle.statusPageDeps).toBeUndefined();
  });

  it('snapshots realmToken from pairing.getRealmToken at composer-call time', () => {
    const pairing = ({
      getRealmToken: vi.fn()
        .mockReturnValueOnce('realm-at-compose')
        .mockReturnValue('realm-later'),
    }) as unknown as PairingManagerMock;

    const { bundle } = composeHarness({ pairing });
    const statusPageDeps = getStatusPageDeps(bundle);

    expect(pairing.getRealmToken).toHaveBeenCalledTimes(1);
    expect(statusPageDeps.realmToken).toBe('realm-at-compose');
    statusPageDeps.buildSummary();
    expect(pairing.getRealmToken).toHaveBeenCalledTimes(1);
  });

  it('includes serverId when serverInstanceId is non-empty', () => {
    const { bundle } = composeHarness({ serverInstanceId: 'server-status' });

    expect(getStatusPageDeps(bundle).serverId).toBe('server-status');
  });

  it('omits serverId when serverInstanceId is an empty string', () => {
    const { bundle } = composeHarness({ serverInstanceId: '' });

    expect(getStatusPageDeps(bundle)).not.toHaveProperty('serverId');
  });

  it('buildSummary returns an empty array when getAutoRunHandle returns undefined', () => {
    const getAutoRunHandle = vi.fn(() => undefined);
    const { bundle } = composeHarness({ getAutoRunHandle });

    expect(getStatusPageDeps(bundle).buildSummary()).toEqual([]);
    expect(getAutoRunHandle).toHaveBeenCalledTimes(1);
  });

  it('buildSummary returns AutoDisabledSummary rows from a non-empty handle roster', () => {
    const recipeStore = makeRecipeStore(new Map([
      ['recipe-b', { metadata: { name: 'Recipe Bravo' } }],
      ['recipe-a', { metadata: { name: 'Recipe Alpha' } }],
    ]));
    const circuitStore = makeCircuitStore(new Map([
      ['recipe-a', { last_failure_reason: 'alpha failed' }],
      ['recipe-b', { last_failure_reason: 'bravo failed' }],
    ]));
    const handle = makeAutoRunHandle([
      makeRosterEntry({
        recipe_id: 'recipe-b',
        consecutive_failures: 5,
        process_id: 'process-b',
        last_finished_at: 1_700_000_000_200,
      }),
      makeRosterEntry({
        recipe_id: 'recipe-a',
        consecutive_failures: 4,
        process_id: 'process-a',
        last_finished_at: 1_700_000_000_100,
      }),
    ]);
    const { bundle } = composeHarness({
      recipeStore,
      circuitStore,
      getAutoRunHandle: vi.fn(() => handle),
    });

    expect(getStatusPageDeps(bundle).buildSummary()).toEqual([
      {
        recipe_id: 'recipe-a',
        publisher_id: 'recued-core',
        name: 'Recipe Alpha',
        consecutive_failures: 4,
        last_process_id: 'process-a',
        last_finished_at: 1_700_000_000_100,
        last_failure_reason: 'alpha failed',
      },
      {
        recipe_id: 'recipe-b',
        publisher_id: 'recued-core',
        name: 'Recipe Bravo',
        consecutive_failures: 5,
        last_process_id: 'process-b',
        last_finished_at: 1_700_000_000_200,
        last_failure_reason: 'bravo failed',
      },
    ]);
  });

  it('buildSummary reads the latest getAutoRunHandle value on every invocation', () => {
    let handle: ServerAutoRunHandle | undefined = makeAutoRunHandle([
      makeRosterEntry({ recipe_id: 'recipe-first' }),
    ]);
    const getAutoRunHandle = vi.fn(() => handle);
    const { bundle } = composeHarness({ getAutoRunHandle });
    const statusPageDeps = getStatusPageDeps(bundle);

    expect(statusPageDeps.buildSummary().map((row) => row.recipe_id)).toEqual([
      'recipe-first',
    ]);

    handle = makeAutoRunHandle([
      makeRosterEntry({ recipe_id: 'recipe-second' }),
    ]);

    expect(statusPageDeps.buildSummary().map((row) => row.recipe_id)).toEqual([
      'recipe-second',
    ]);
    expect(getAutoRunHandle).toHaveBeenCalledTimes(2);
  });

  it('buildSummary lookupName uses recipeStore.get(recipe_id).metadata.name', () => {
    const recipeStore = makeRecipeStore(new Map([
      ['recipe-named', { metadata: { name: 'Named Recipe' } }],
    ]));
    const handle = makeAutoRunHandle([
      makeRosterEntry({ recipe_id: 'recipe-named' }),
    ]);
    const { bundle } = composeHarness({
      recipeStore,
      getAutoRunHandle: vi.fn(() => handle),
    });

    expect(getStatusPageDeps(bundle).buildSummary()[0].name).toBe('Named Recipe');
    expect(recipeStore.get).toHaveBeenCalledWith('recipe-named');
  });

  it('buildSummary lookupName returns null when recipeStore.get throws', () => {
    const recipeStore = makeRecipeStore();
    recipeStore.get.mockImplementation(() => {
      throw new Error('recipe lookup failed');
    });
    const handle = makeAutoRunHandle([
      makeRosterEntry({ recipe_id: 'recipe-throw' }),
    ]);
    const { bundle } = composeHarness({
      recipeStore,
      getAutoRunHandle: vi.fn(() => handle),
    });

    expect(getStatusPageDeps(bundle).buildSummary()[0].name).toBe('recipe-throw');
  });

  it('buildSummary lookupName returns null when metadata.name is missing', () => {
    const recipeStore = makeRecipeStore(new Map([
      ['recipe-missing-name', { metadata: {} }],
    ]));
    const handle = makeAutoRunHandle([
      makeRosterEntry({ recipe_id: 'recipe-missing-name' }),
    ]);
    const { bundle } = composeHarness({
      recipeStore,
      getAutoRunHandle: vi.fn(() => handle),
    });

    expect(getStatusPageDeps(bundle).buildSummary()[0].name).toBe('recipe-missing-name');
  });

  it('buildSummary lookupFailureReason returns undefined when circuitStore.get throws', () => {
    const circuitStore = makeCircuitStore();
    circuitStore.get.mockImplementation(() => {
      throw new Error('circuit lookup failed');
    });
    const handle = makeAutoRunHandle([
      makeRosterEntry({ recipe_id: 'recipe-circuit-throw' }),
    ]);
    const { bundle } = composeHarness({
      circuitStore,
      getAutoRunHandle: vi.fn(() => handle),
    });

    expect(
      getStatusPageDeps(bundle).buildSummary()[0].last_failure_reason,
    ).toBeUndefined();
  });

  it('buildSummary lookupFailureReason returns undefined when the circuit entry is missing', () => {
    const circuitStore = makeCircuitStore();
    const handle = makeAutoRunHandle([
      makeRosterEntry({ recipe_id: 'recipe-no-circuit-entry' }),
    ]);
    const { bundle } = composeHarness({
      circuitStore,
      getAutoRunHandle: vi.fn(() => handle),
    });

    expect(
      getStatusPageDeps(bundle).buildSummary()[0].last_failure_reason,
    ).toBeUndefined();
    expect(circuitStore.get).toHaveBeenCalledWith('recipe-no-circuit-entry');
  });

  it('passes all core references through directly', () => {
    const recipeStore = makeRecipeStore();
    const approvalStore = makeApprovalStore();
    const eventBus = makeEventBus();
    const db = makeDatabase();
    const auditLog = makeAuditLog();
    const checkpointStore = makeCheckpointStore();
    const commitStore = makeCommitStore();
    const { bundle } = composeHarness({
      recipeStore,
      approvalStore,
      eventBus,
      db,
      auditLog,
      checkpointStore,
      commitStore,
    });

    expect(bundle.recipeListDeps.store).toBe(recipeStore);
    expect(bundle.approvalDeps.store).toBe(approvalStore);
    expect(bundle.eventsDeps.bus).toBe(eventBus);
    expect(bundle.auditExportDeps?.db).toBe(db);
    expect(bundle.auditExportDeps?.auditLog).toBe(auditLog);
    expect(bundle.executionFeedDeps?.checkpointStore).toBe(checkpointStore);
    expect(bundle.executionFeedDeps?.commitStore).toBe(commitStore);
  });
});

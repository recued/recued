import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRuntimeConfigStore } from '@recued/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CircuitBreakerStore } from '../auto-run-scheduler.js';
import { createBootTrace } from '../cli/boot-trace.js';
import { composeAppContext } from '../serve/compose-app-context.js';
import {
  createExecutionLateBoundRefs,
} from '../serve/compose-execution-context.js';
import {
  composeRpcContext,
  type ComposeRpcContextOptions,
} from '../serve/compose-rpc-context.js';
import { composeStorageContext } from '../serve/compose-storage-context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const rpcContextPath = join(
  repoRoot,
  'backend/server/src/serve/compose-rpc-context.ts',
);

let tmp: string | undefined;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

const makeTmp = (): string => {
  tmp = mkdtempSync(join(tmpdir(), 'recued-serve-rpc-'));
  return tmp;
};

const makeSchedulerRegistry = ():
  ComposeRpcContextOptions['schedulerRegistry'] => {
  const producers = new Map();
  return {
    producers: vi.fn(() => producers),
    getScheduler: vi.fn(() => undefined),
    setScheduler: vi.fn(),
    stop: vi.fn(),
  } as unknown as ComposeRpcContextOptions['schedulerRegistry'];
};

const makeCircuitStore = (): CircuitBreakerStore =>
  ({ get: vi.fn(() => undefined) }) as unknown as CircuitBreakerStore;

describe('composeRpcContext', () => {
  it('composes pre-handler RPC deps with the existing serve-context identities', async () => {
    const dir = makeTmp();
    const dbPath = join(dir, 'server.db');
    const runtimeConfig = createRuntimeConfigStore({});
    const storageContext = await composeStorageContext({
      dbPath,
      bootTrace: createBootTrace({
        entrypoint: 'serve-entry',
        profile: 'serve',
        command: 'serve',
        env: {},
      }),
      runtimeConfig,
      vaultQuotas: {
        perPublisherBytes: 1_234_000,
        totalBytes: 5_678_000,
      },
    });

    try {
      const lateBound = createExecutionLateBoundRefs();
      const app = composeAppContext({
        db: storageContext.db,
        dbPath,
        envLlmConfig: storageContext.envLlmConfig,
        gateRegistry: storageContext.gateRegistry,
        auditLog: storageContext.auditLog,
        eventBus: storageContext.eventBus,
        serverInstanceId: storageContext.serverInstanceId,
        recipeStore: storageContext.recipeStore,
        pairedInstances: storageContext.pairedInstances,
        workEntityStore: storageContext.workEntityStoreRef,
        chatLateBound: lateBound,
      });
      const schedulerRegistry = makeSchedulerRegistry();
      const setActiveContactMergeScanMode = vi.fn();
      const getApiConnectionLookup = vi.fn(() => undefined);
      const getRefreshAuth = vi.fn(() => undefined);
      const getRegisterSalesforceCallEntity = vi.fn(() => undefined);

      const context = composeRpcContext({
        storage: storageContext,
        app,
        // D-163 Slice C — composeRpcContext reads
        // `execution.notificationBlock` to build the notifications rpc
        // bundle. The block isn't constructed in this dbless harness, so
        // the bundle drops and the 3 `notifications.*` rpcs surface
        // `not_configured` — matching the gating discipline every other
        // db-backed slice already follows.
        // D-181 §12 — composeRpcContext also reads
        // `execution.executeDeps.inFlightRegistry` to wire the `/status`
        // lanes line. This dbless harness has no governor registry, so the
        // getter spread drops and the lanes section is omitted.
        execution: {
          notificationBlock: undefined,
          executeDeps: {} as ComposeRpcContextOptions['execution']['executeDeps'],
        },
        schedulerRegistry,
        upstreamMergeRegistry: undefined,
        setActiveContactMergeScanMode,
        getApiConnectionLookup,
        getRefreshAuth,
        getRegisterSalesforceCallEntity,
        circuitStore: makeCircuitStore(),
        autoRunSettingsStore: undefined,
        getAutoRunHandle: () => undefined,
        serverStartedAt: 1_700_000_333_000,
      });

      expect(context.housekeepingRpcDeps?.config).toBe(app.housekeepingConfigRef);
      expect(context.housekeepingRpcDeps?.state).toBe(app.housekeepingStateRef);

      expect(context.upstreamMergeDeps?.store).toBe(app.upstreamMergeStoreRef);
      expect(context.upstreamMergeDeps?.contactStore).toBe(app.contactStoreRef);
      expect(context.upstreamMergeRegistry).toBe(
        context.upstreamMergeDeps?.vendorMergers,
      );

      expect(context.contactMergeDeps?.contactStore).toBe(app.contactStoreRef);
      expect(context.contactMergeDeps?.annotationStore).toBe(app.annotationStoreRef);
      expect(context.contactMergeDeps?.promptStore).toBe(app.remergePromptStoreRef);
      expect(context.contactMergeDeps?.runScanNow).toEqual(expect.any(Function));

      expect(context.engagementHealthDeps?.connectionStore).toBe(app.connectionStoreRef);
      expect(context.engagementHealthDeps?.housekeepingState).toBe(
        app.housekeepingStateRef,
      );
      expect(context.engagementHealthDeps?.rateControlStore).toBe(
        app.engagementRateControlStoreRef,
      );
      expect(context.engagementHealthDeps?.capabilityStore).toBe(
        app.engagementCapabilityStoreRef,
      );
      expect(getApiConnectionLookup).not.toHaveBeenCalled();
      expect(getRefreshAuth).not.toHaveBeenCalled();
      expect(getRegisterSalesforceCallEntity).not.toHaveBeenCalled();
      expect(setActiveContactMergeScanMode).not.toHaveBeenCalled();

      expect(context.observabilityBundle.recipeListDeps).toEqual({
        store: storageContext.recipeStore,
        serverStartedAt: 1_700_000_333_000,
        // Same bundle object the observability composer builds; what the
        // roster returns is pinned in `wire-observability-rpc-deps.test.ts`.
        // Exact shape kept deliberately — see the note there.
        packRoster: expect.any(Function),
      });
      expect(context.observabilityBundle.approvalDeps.store).toBe(
        storageContext.approvalStore,
      );
      expect(context.observabilityBundle.eventsDeps.bus).toBe(
        storageContext.eventBus,
      );
      expect(context.observabilityBundle.auditExportDeps).toEqual({
        db: storageContext.db,
        auditLog: storageContext.auditLog,
        serverInstanceId: storageContext.serverInstanceId,
      });
      expect(context.observabilityBundle.executionFeedDeps).toEqual({
        db: storageContext.db,
        auditLog: storageContext.auditLog,
        checkpointStore: storageContext.checkpointStore,
        commitStore: storageContext.commitStore,
        gatedActionStore: storageContext.gatedActionStore,
        // The SAME store the approval resumer writes an owner page-run's
        // result into — `execution.get` hands it to the page still "held".
        settledRunResults: storageContext.settledRunResults,
        serverInstanceId: storageContext.serverInstanceId,
      });
      expect(context.observabilityBundle.executionFeedDeps?.settledRunResults)
        .toBe(storageContext.settledRunResults);
      expect(context.observabilityBundle.statusPageDeps?.realmToken).toBe(
        storageContext.pairing?.getRealmToken(),
      );
    } finally {
      storageContext.db.close();
    }
  });

  it('keeps RPC context out of listener, scheduler startup, lifecycle, shutdown, and MCP imports', () => {
    const source = readFileSync(rpcContextPath, 'utf8');

    expect(source).toMatch(/composeHousekeepingRpcDeps/);
    expect(source).toMatch(/composeUpstreamMergeRpcDeps/);
    expect(source).toMatch(/composeContactMergeRpcDeps/);
    expect(source).toMatch(/composeEngagementHealthRpcDeps/);
    expect(source).toMatch(/composeObservabilityRpcDeps/);
    expect(source).not.toMatch(/createServerHandlerSet|startServer/);
    expect(source).not.toMatch(/path-listener|createProductionPathListenerCoordinator/);
    expect(source).not.toMatch(/composeWebhookListeners/);
    expect(source).not.toMatch(/composeSchedulers|composeHousekeepingScheduler/);
    expect(source).not.toMatch(/background-services/);
    expect(source).not.toMatch(/mcp-server|wire-mcp-http-transport|composeMcpHttpTransport/);
    expect(source).not.toMatch(/createLifecycle|LockHeldError|process\.on|process\.exit/);
  });
});

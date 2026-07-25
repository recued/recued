import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const bootstrapCascadeMocks = vi.hoisted(() => ({
  createEvictionCascade: vi.fn(),
  listReferencedBlobHashes: vi.fn(),
  listSharedReferencedBlobHashes: vi.fn(),
  listCollectionReferencedBlobHashes: vi.fn(),
  listAnnotationReferencedBlobHashes: vi.fn(),
}));

vi.mock('../eviction-cascade.js', () => ({
  DEFAULT_CASCADE_CONFIG: {
    debounceWindowMs: 60_000,
    orphanScanMaxBlobs: 1000,
    hysteresisRatio: 0.9,
  },
  createEvictionCascade: bootstrapCascadeMocks.createEvictionCascade,
}));

vi.mock('../storage/sqlite-cache-store.js', () => ({
  listReferencedBlobHashes: bootstrapCascadeMocks.listReferencedBlobHashes,
}));

vi.mock('../storage/shared-store.js', () => ({
  listSharedReferencedBlobHashes: bootstrapCascadeMocks.listSharedReferencedBlobHashes,
}));

vi.mock('../storage/collection-blob-refs.js', () => ({
  listCollectionReferencedBlobHashes:
    bootstrapCascadeMocks.listCollectionReferencedBlobHashes,
  quoteSqliteIdent: (s: string) => `"${s}"`,
}));

// annotation-store has a wide export surface consumed elsewhere in the module
// graph — preserve the real exports and override only the ref reader.
vi.mock('../storage/annotation-store.js', async (importActual) => ({
  ...(await importActual<typeof import('../storage/annotation-store.js')>()),
  listAnnotationReferencedBlobHashes:
    bootstrapCascadeMocks.listAnnotationReferencedBlobHashes,
}));

import {
  composeBootstrapCascadeContext,
  type ComposeBootstrapCascadeContextOptions,
} from '../serve/compose-bootstrap-cascade-context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const helperPath = join(
  repoRoot,
  'backend/server/src/serve/compose-bootstrap-cascade-context.ts',
);
const lifecycleRecoveryBridgePath = join(
  repoRoot,
  'backend/server/src/serve/start-lifecycle-recovery-pre-listener-runtime.ts',
);
const postAppBridgePath = join(
  repoRoot,
  'backend/server/src/serve/start-post-app-collection-execution-runtime.ts',
);
const postExecutionBridgePath = join(
  repoRoot,
  'backend/server/src/serve/start-post-execution-bootstrap-maintenance-runtime.ts',
);

const makeRuntimeConfig = (
  values: Record<string, unknown> = {
    'cascade.debounce_window_s': 7,
    'cascade.orphan_scan_max_blobs': 55,
  },
) => ({
  get: vi.fn((key: string) => {
    if (!(key in values)) throw new Error(`missing ${key}`);
    return values[key];
  }),
});

const makeOptions = (
  overrides: Partial<ComposeBootstrapCascadeContextOptions> = {},
): ComposeBootstrapCascadeContextOptions => {
  const gateRegistry = {
    all: vi.fn(() => [{ surface: 'cache' }]),
  };

  return {
    base: {
      loadedConfig: {
        bootstrap: { bind_port: 4321 },
        runtime: { tag: 'runtime' },
        source: '/tmp/recued/config.toml',
      },
      runtimeConfig: makeRuntimeConfig(),
    },
    serverVersion: '9.9.9',
    storage: {
      db: { tag: 'db' },
      auditLog: { tag: 'audit-log' },
      gateRegistry,
      auditRetention: { tag: 'audit-retention' },
      pressureState: { tag: 'pressure-state' },
    },
    app: {
      serverState: { tag: 'server-state' },
      cacheStore: { tag: 'cache-store' },
      cacheBlobs: { tag: 'cache-blobs' },
      sharedStoreRef: { tag: 'shared-store' },
      sharedBlobs: { tag: 'shared-blobs' },
      annotationStoreRef: { tag: 'annotation-store' },
    },
    collection: {
      collectionRegistry: { tag: 'collection-registry' },
    },
    warn: vi.fn(),
    ...overrides,
  } as unknown as ComposeBootstrapCascadeContextOptions;
};

beforeEach(() => {
  bootstrapCascadeMocks.createEvictionCascade.mockReset();
  bootstrapCascadeMocks.listReferencedBlobHashes.mockReset();
  bootstrapCascadeMocks.listSharedReferencedBlobHashes.mockReset();
  bootstrapCascadeMocks.listCollectionReferencedBlobHashes.mockReset();
  bootstrapCascadeMocks.listAnnotationReferencedBlobHashes.mockReset();

  bootstrapCascadeMocks.createEvictionCascade.mockReturnValue({
    tag: 'cascade',
  });
  bootstrapCascadeMocks.listReferencedBlobHashes.mockReturnValue(
    new Set(['cache-hash']),
  );
  bootstrapCascadeMocks.listSharedReferencedBlobHashes.mockReturnValue(
    new Set(['shared-hash']),
  );
  bootstrapCascadeMocks.listCollectionReferencedBlobHashes.mockReturnValue(
    new Set(['collection-hash']),
  );
  bootstrapCascadeMocks.listAnnotationReferencedBlobHashes.mockReturnValue(
    new Set(['annotation-hash']),
  );
});

describe('composeBootstrapCascadeContext', () => {
  it('builds cascade, bootstrap deps, and pressure deps from the live serve contexts', () => {
    const options = makeOptions();

    const context = composeBootstrapCascadeContext(options);

    expect(bootstrapCascadeMocks.createEvictionCascade).toHaveBeenCalledWith(
      expect.objectContaining({
        registry: options.storage.gateRegistry,
        state: options.storage.pressureState,
        auditLog: options.storage.auditLog,
        cache: options.app.cacheStore,
        // Two posture-split CAS roots (blob-encryption Phase 1).
        cacheBlobs: options.app.cacheBlobs,
        sharedBlobs: options.app.sharedBlobs,
        auditRetention: options.storage.auditRetention,
        collectionRegistry: options.collection.collectionRegistry,
        db: options.storage.db,
      }),
    );

    const cascadeDeps = bootstrapCascadeMocks.createEvictionCascade.mock
      .calls[0]![0] as {
        cacheBlobRefs: () => Set<string>;
        collectionBlobRefs: () => Set<string>;
        sharedBlobRefs: () => Set<string>;
        annotationBlobRefs: () => Set<string>;
        config: () => {
          debounceWindowMs: number;
          orphanScanMaxBlobs: number;
          hysteresisRatio: number;
        };
      };
    // Cache root keepset = cache ∪ collection; keyless root keepset = shared ∪
    // annotation. Each reader delegates to its storage-layer scan for the db.
    expect(cascadeDeps.cacheBlobRefs()).toEqual(new Set(['cache-hash']));
    expect(cascadeDeps.collectionBlobRefs()).toEqual(new Set(['collection-hash']));
    expect(cascadeDeps.sharedBlobRefs()).toEqual(new Set(['shared-hash']));
    expect(cascadeDeps.annotationBlobRefs()).toEqual(new Set(['annotation-hash']));
    expect(bootstrapCascadeMocks.listReferencedBlobHashes).toHaveBeenCalledWith(
      options.storage.db,
    );
    expect(
      bootstrapCascadeMocks.listCollectionReferencedBlobHashes,
    ).toHaveBeenCalledWith(options.storage.db);
    expect(
      bootstrapCascadeMocks.listSharedReferencedBlobHashes,
    ).toHaveBeenCalledWith(options.storage.db);
    expect(
      bootstrapCascadeMocks.listAnnotationReferencedBlobHashes,
    ).toHaveBeenCalledWith(options.storage.db);
    expect(cascadeDeps.config()).toEqual({
      debounceWindowMs: 7000,
      orphanScanMaxBlobs: 55,
      hysteresisRatio: 0.9,
    });

    expect(context.cascade).toEqual({ tag: 'cascade' });
    expect(context.pressureDeps).toEqual({
      registry: options.storage.gateRegistry,
      cascade: context.cascade,
    });
    expect(context.bootstrapDeps).toEqual(
      expect.objectContaining({
        bootstrap: options.base.loadedConfig.bootstrap,
        state: options.app.serverState,
        gates: [{ surface: 'cache' }],
        version: '9.9.9',
        auditLog: options.storage.auditLog,
        pressureState: options.storage.pressureState,
      }),
    );
  });

  it('uses cascade config fallbacks while preserving the restart placeholder hook', () => {
    const warn = vi.fn();
    const options = makeOptions({
      base: {
        ...makeOptions().base,
        runtimeConfig: makeRuntimeConfig({
          'cascade.debounce_window_s': 3,
        }) as unknown as ComposeBootstrapCascadeContextOptions['base']['runtimeConfig'],
      },
      warn,
    });

    const context = composeBootstrapCascadeContext(options);
    const cascadeDeps = bootstrapCascadeMocks.createEvictionCascade.mock
      .calls[0]![0] as {
        config: () => {
          debounceWindowMs: number;
          orphanScanMaxBlobs: number;
          hysteresisRatio: number;
        };
      };

    expect(cascadeDeps.config()).toEqual({
      debounceWindowMs: 3000,
      orphanScanMaxBlobs: 1000,
      hysteresisRatio: 0.9,
    });

    context.bootstrapDeps?.onRestartRequested?.('config');
    expect(warn).toHaveBeenCalledWith('[bootstrap] restart requested: config');
  });

  it('preserves cascade and bootstrap gates independently', () => {
    const options = makeOptions({
      storage: {
        ...makeOptions().storage,
        pressureState: undefined,
      },
    });

    const context = composeBootstrapCascadeContext(options);

    expect(bootstrapCascadeMocks.createEvictionCascade).not.toHaveBeenCalled();
    expect(context.cascade).toBeUndefined();
    expect(context.pressureDeps).toBeUndefined();
    expect(context.bootstrapDeps).toEqual(
      expect.objectContaining({
        bootstrap: options.base.loadedConfig.bootstrap,
        state: options.app.serverState,
        gates: [{ surface: 'cache' }],
      }),
    );

    const withoutServerState = composeBootstrapCascadeContext(
      makeOptions({
        app: {
          ...makeOptions().app,
          serverState: undefined,
        },
      }),
    );
    expect(withoutServerState.bootstrapDeps).toBeUndefined();
  });
});

describe('compose-bootstrap-cascade-context source boundary', () => {
  it('keeps bootstrap, cascade, and pressure setup in the post-execution bridge', () => {
    const helperSource = readFileSync(helperPath, 'utf8');
    const postAppBridgeSource = readFileSync(postAppBridgePath, 'utf8');
    const bridgeSource = readFileSync(postExecutionBridgePath, 'utf8');

    expect(postAppBridgeSource).toMatch(
      /start-post-execution-bootstrap-maintenance-runtime\.js/,
    );
    expect(postAppBridgeSource).toMatch(
      /await startPostExecutionBootstrapMaintenanceRuntime\(\{/,
    );
    expect(bridgeSource).toMatch(/compose-bootstrap-cascade-context\.js/);
    expect(bridgeSource).toMatch(/composeBootstrapCascadeContext/);
    expect(helperSource).toMatch(/createEvictionCascade/);
    expect(helperSource).toMatch(/DEFAULT_CASCADE_CONFIG/);
    expect(helperSource).toMatch(/listReferencedBlobHashes/);
    expect(helperSource).toMatch(/listSharedReferencedBlobHashes/);
    expect(helperSource).toMatch(/BootstrapHandlerDeps/);
    expect(helperSource).toMatch(/PressureHandlerDeps/);
  });

  it('preserves execution, bootstrap cascade, lifecycle, boot recovery, ingress, and listener ordering', () => {
    const postAppBridgeSource = readFileSync(postAppBridgePath, 'utf8');
    const postExecutionBridgeSource = readFileSync(postExecutionBridgePath, 'utf8');
    const bridgeSource = readFileSync(lifecycleRecoveryBridgePath, 'utf8');

    const executionIndex = postAppBridgeSource.indexOf(
      'await composeExecutionContext({',
    );
    const postExecutionBridgeIndex = postAppBridgeSource.indexOf(
      'await startPostExecutionBootstrapMaintenanceRuntime({',
    );
    const bootstrapCascadeIndex = postExecutionBridgeSource.indexOf(
      'composeBootstrapCascadeContext(options.bootstrapCascade)',
    );
    const maintenanceIndex = postExecutionBridgeSource.indexOf(
      'composeMaintenanceContext({',
    );
    const outerBridgeIndex = postExecutionBridgeSource.indexOf(
      'await startLifecycleRecoveryPreListenerRuntime({',
    );
    const lifecycleIndex = bridgeSource.indexOf('await composeServeLifecycle({');
    const bootRecoveryIndex = bridgeSource.indexOf(
      'await startBootRecoveryAndAdapters({',
    );
    const preListenerIndex = bridgeSource.indexOf('await startPreListenerRuntime({');

    expect(executionIndex).toBeGreaterThanOrEqual(0);
    expect(postExecutionBridgeIndex).toBeGreaterThan(executionIndex);
    expect(bootstrapCascadeIndex).toBeGreaterThanOrEqual(0);
    expect(maintenanceIndex).toBeGreaterThan(bootstrapCascadeIndex);
    expect(outerBridgeIndex).toBeGreaterThan(maintenanceIndex);
    expect(lifecycleIndex).toBeGreaterThanOrEqual(0);
    expect(bootRecoveryIndex).toBeGreaterThan(lifecycleIndex);
    expect(preListenerIndex).toBeGreaterThan(bootRecoveryIndex);
  });

  it('keeps the helper focused on pre-lifecycle bootstrap, pressure, and cascade setup', () => {
    const helperSource = readFileSync(helperPath, 'utf8');

    expect(helperSource).not.toMatch(/composeMaintenanceContext/);
    expect(helperSource).not.toMatch(/composeServeLifecycle|createLifecycle/);
    expect(helperSource).not.toMatch(/startBootRecoveryAndAdapters|bootSigningIdentity/);
    expect(helperSource).not.toMatch(/composeIngressRpcContext/);
    expect(helperSource).not.toMatch(/composeClientSecurityContext/);
    expect(helperSource).not.toMatch(/composeRpcContext|composeListeners/);
    expect(helperSource).not.toMatch(/composeServeExposure|wrapServePeerCache/);
    expect(helperSource).not.toMatch(/startSchedulers|startServeHousekeepingScheduler/);
    expect(helperSource).not.toMatch(/startRetentionPruners|startDdnsUpdatePoller/);
    expect(helperSource).not.toMatch(/logBootBanner|installShutdown/);
  });
});

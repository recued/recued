import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Real (un-mocked) shipped schema set the housekeeping composer unions into the
// enrichment PII tag source for D-167 default-on protection.
import { CANONICAL_PII_ENTITY_SCHEMAS } from '../canonical-pii-schemas.js';

const housekeepingMocks = vi.hoisted(() => {
  const standaloneTasks = [{ id: 'task-a' }, { id: 'task-b' }];
  const perRecordProducers = [
    {
      producer: { topic: 'test.topic', consumes_external_context: [] as string[] },
      walker_kind: 'mail-thread',
    },
  ];

  return {
    createHousekeepingConfigStore: vi.fn(),
    createHousekeepingStateStore: vi.fn(),
    createTrustStore: vi.fn(),
    createTunableParamsStore: vi.fn(),
    createTunableParamsAccessor: vi.fn(),
    createLlmResultCacheStore: vi.fn(),
    createHousekeepingScheduler: vi.fn(),
    createEngineBusySignal: vi.fn(),
    registerHousekeepingTask: vi.fn(),
    listHousekeepingTasks: vi.fn(),
    buildEnrichmentProducerTask: vi.fn(),
    createMailSourceWalker: vi.fn(),
    createFileSourceWalker: vi.fn(),
    createNoteSourceWalker: vi.fn(),
    createTaskSourceWalker: vi.fn(),
    createProjectSourceWalker: vi.fn(),
    createSourceWalkerRegistry: vi.fn(),
    hashMailRecordWithBody: vi.fn(),
    STANDALONE_TASKS: standaloneTasks,
    PER_RECORD_PRODUCERS: perRecordProducers,
  };
});

const tlsRenewalMocks = vi.hoisted(() => ({
  buildTlsCertRenewalTask: vi.fn(),
}));

const contactMergeMocks = vi.hoisted(() => ({
  buildContactMergeCandidateScanTask: vi.fn(),
}));

const workEntitySweepMocks = vi.hoisted(() => ({
  buildWorkEntityDueStatusSweepTask: vi.fn(),
}));

const sellerReconcileMocks = vi.hoisted(() => ({
  buildSellerAccessReconcileTask: vi.fn(),
}));

const instanceStoreMocks = vi.hoisted(() => ({
  createInstanceStore: vi.fn(),
}));

// D-167 — the composer constructs a `local_manifest`-backed enrichment PII tag
// source over `deps.db`. The fake db in these tests has no `.exec`, so mock the
// store factory + the tag-source builder; the wiring assertion below checks the
// composer threads them onto ctx (the real builder is exercised end-to-end in
// `d-167-enrichment-pii-activation.test.ts`).
const localManifestMocks = vi.hoisted(() => ({
  createLocalManifestStore: vi.fn(),
}));

const enrichmentPiiTagSourceMocks = vi.hoisted(() => ({
  createEnrichmentPiiTagSourceFromLocalManifestStore: vi.fn(),
}));

vi.mock('../housekeeping/index.js', () => housekeepingMocks);
vi.mock('../housekeeping/tasks/tls-cert-renewal.js', () => tlsRenewalMocks);
vi.mock('../housekeeping/tasks/contact-merge-candidate-scan.js', () => contactMergeMocks);
vi.mock('../housekeeping/tasks/work-entity-due-status-sweep.js', () => workEntitySweepMocks);
vi.mock('../housekeeping/tasks/seller-access-reconcile.js', () => sellerReconcileMocks);
vi.mock('../collections/instance-store.js', () => instanceStoreMocks);
vi.mock('../ingredient-authoring/local-manifest-store.js', () => localManifestMocks);
vi.mock('../housekeeping/enrichment-pii-tag-source.js', () => enrichmentPiiTagSourceMocks);

import {
  composeHousekeepingScheduler,
  composeHousekeepingStores,
} from '../composition/bin/wire-housekeeping-substrate.js';

let db: any;
let configStore: any;
let stateStore: any;
let trustStore: any;
let tunableParamsStore: any;
let tunableParamsAccessor: any;
let llmResultCacheStore: any;
let enrichmentStore: any;
let recipeStore: any;
let collectionRegistry: any;
let cacheBlobs: any;
let eventBus: any;
let warehouseBus: any;
let llmCallables: any;
let scheduler: any;
let schedulerStart: ReturnType<typeof vi.fn>;
let busySignal: any;
let instanceStore: any;
let mailThreadWalker: any;
let mailBodyWalker: any;
let fileWalker: any;
let contactWalker: any;
let calendarWalker: any;
let defaultProducer: any;
let enrichmentTask: any;
let tlsTask: any;
let contactMergeTask: any;
let workEntitySweepTask: any;
let sellerReconcileTask: any;
let localManifestStore: any;
let enrichmentPiiTagSource: any;

const makeConfigStore = (preset: 'balanced' | 'off' = 'balanced') => ({
  read: vi.fn().mockReturnValue({ preset }),
});

const resetMockDefaults = () => {
  db = { kind: 'db' };
  configStore = makeConfigStore('balanced');
  stateStore = { kind: 'state-store' };
  trustStore = { kind: 'trust-store' };
  tunableParamsStore = { kind: 'tunable-params-store' };
  tunableParamsAccessor = { kind: 'tunable-params-accessor' };
  llmResultCacheStore = { kind: 'llm-result-cache-store' };
  enrichmentStore = { kind: 'enrichment-store' };
  recipeStore = { kind: 'recipe-store' };
  collectionRegistry = { kind: 'collection-registry' };
  cacheBlobs = { kind: 'cache-blobs' };
  eventBus = { emit: vi.fn() };
  warehouseBus = { emit: vi.fn() };
  llmCallables = {
    llm: vi.fn(),
    llmWithMeta: vi.fn(),
    resolveLLMModelId: vi.fn(),
    embed: vi.fn(),
  };
  schedulerStart = vi.fn();
  scheduler = { kind: 'scheduler', start: schedulerStart };
  busySignal = { kind: 'busy-signal' };
  instanceStore = { kind: 'instance-store' };
  mailThreadWalker = { kind: 'mail-thread-walker' };
  mailBodyWalker = { kind: 'mail-body-walker' };
  fileWalker = { kind: 'file-walker' };
  contactWalker = { kind: 'contact-walker' };
  calendarWalker = { kind: 'calendar-walker' };
  defaultProducer = { topic: 'test.topic', consumes_external_context: [] };
  enrichmentTask = { id: 'enrichment.test.topic' };
  tlsTask = { id: 'tls-cert-renewal' };
  contactMergeTask = { id: 'contact-merge-candidate-scan' };
  workEntitySweepTask = { id: 'work-entity-due-status-sweep' };
  sellerReconcileTask = { id: 'seller-access-reconcile' };
  localManifestStore = { kind: 'local-manifest-store' };
  enrichmentPiiTagSource = vi.fn();

  housekeepingMocks.STANDALONE_TASKS.splice(
    0,
    housekeepingMocks.STANDALONE_TASKS.length,
    { id: 'task-a' },
    { id: 'task-b' },
  );
  housekeepingMocks.PER_RECORD_PRODUCERS.splice(
    0,
    housekeepingMocks.PER_RECORD_PRODUCERS.length,
    { producer: defaultProducer, walker_kind: 'mail-thread' },
  );

  housekeepingMocks.createHousekeepingConfigStore.mockReturnValue(configStore);
  housekeepingMocks.createHousekeepingStateStore.mockReturnValue(stateStore);
  housekeepingMocks.createTrustStore.mockReturnValue(trustStore);
  housekeepingMocks.createTunableParamsStore.mockReturnValue(tunableParamsStore);
  housekeepingMocks.createTunableParamsAccessor.mockReturnValue(tunableParamsAccessor);
  housekeepingMocks.createLlmResultCacheStore.mockReturnValue(llmResultCacheStore);
  housekeepingMocks.createHousekeepingScheduler.mockReturnValue(scheduler);
  housekeepingMocks.createEngineBusySignal.mockReturnValue(busySignal);
  housekeepingMocks.listHousekeepingTasks.mockReturnValue([{ id: 'registered' }]);
  housekeepingMocks.buildEnrichmentProducerTask.mockImplementation(({ producer, walker }) => ({
    ...enrichmentTask,
    id: `enrichment.${producer.topic}`,
    producer,
    walker,
  }));
  housekeepingMocks.createSourceWalkerRegistry.mockReturnValue(new Map([
    ['mail', mailThreadWalker],
    ['contact', contactWalker],
    ['calendar', calendarWalker],
  ]));
  housekeepingMocks.createMailSourceWalker.mockReturnValue(mailBodyWalker);
  housekeepingMocks.createFileSourceWalker.mockReturnValue(fileWalker);
  tlsRenewalMocks.buildTlsCertRenewalTask.mockReturnValue(tlsTask);
  contactMergeMocks.buildContactMergeCandidateScanTask.mockReturnValue(contactMergeTask);
  workEntitySweepMocks.buildWorkEntityDueStatusSweepTask.mockReturnValue(workEntitySweepTask);
  sellerReconcileMocks.buildSellerAccessReconcileTask.mockReturnValue(sellerReconcileTask);
  instanceStoreMocks.createInstanceStore.mockReturnValue(instanceStore);
  localManifestMocks.createLocalManifestStore.mockReturnValue(localManifestStore);
  enrichmentPiiTagSourceMocks.createEnrichmentPiiTagSourceFromLocalManifestStore.mockReturnValue(
    enrichmentPiiTagSource,
  );
};

const resetForTest = () => {
  vi.clearAllMocks();
  resetMockDefaults();
};

const makeSchedulerDeps = (overrides: Record<string, any> = {}) => {
  const { stores: storeOverrides, ...rest } = overrides;
  return {
    db,
    stores: {
      configStore,
      stateStore,
      trustStore,
      tunableParamsStore,
      llmResultCacheStore,
      ...(storeOverrides ?? {}),
    },
    enrichmentStore,
    recipeStore,
    collectionRegistry,
    cacheBlobs,
    eventBus,
    warehouseBus,
    auditLog: undefined,
    llmCallables,
    enrichmentProducers: new Map(),
    ...rest,
  };
};

const composeWithDeps = (overrides: Record<string, any> = {}) =>
  composeHousekeepingScheduler(makeSchedulerDeps(overrides) as any);

const schedulerArgs = () => housekeepingMocks.createHousekeepingScheduler.mock.calls[0][0];

describe('composeHousekeepingStores', () => {
  beforeEach(resetForTest);

  it('returns undefined store fields when db is undefined', () => {
    expect(composeHousekeepingStores({ db: undefined })).toEqual({
      configStore: undefined,
      stateStore: undefined,
      trustStore: undefined,
      tunableParamsStore: undefined,
      llmResultCacheStore: undefined,
    });
  });

  it('does not call store factories when db is undefined', () => {
    composeHousekeepingStores({ db: undefined });

    expect(housekeepingMocks.createHousekeepingConfigStore).not.toHaveBeenCalled();
    expect(housekeepingMocks.createHousekeepingStateStore).not.toHaveBeenCalled();
    expect(housekeepingMocks.createTrustStore).not.toHaveBeenCalled();
    expect(housekeepingMocks.createTunableParamsStore).not.toHaveBeenCalled();
    expect(housekeepingMocks.createLlmResultCacheStore).not.toHaveBeenCalled();
  });

  it('populates every store field when db is defined', () => {
    expect(composeHousekeepingStores({ db } as any)).toEqual({
      configStore,
      stateStore,
      trustStore,
      tunableParamsStore,
      llmResultCacheStore,
    });
  });

  it('calls each store factory exactly once with db and returns factory identities', () => {
    const stores = composeHousekeepingStores({ db } as any);

    expect(housekeepingMocks.createHousekeepingConfigStore).toHaveBeenCalledOnce();
    expect(housekeepingMocks.createHousekeepingStateStore).toHaveBeenCalledOnce();
    expect(housekeepingMocks.createTrustStore).toHaveBeenCalledOnce();
    expect(housekeepingMocks.createTunableParamsStore).toHaveBeenCalledOnce();
    expect(housekeepingMocks.createLlmResultCacheStore).toHaveBeenCalledOnce();
    expect(housekeepingMocks.createHousekeepingConfigStore).toHaveBeenCalledWith(db);
    expect(housekeepingMocks.createHousekeepingStateStore).toHaveBeenCalledWith(db);
    expect(housekeepingMocks.createTrustStore).toHaveBeenCalledWith(db);
    expect(housekeepingMocks.createTunableParamsStore).toHaveBeenCalledWith(db);
    expect(housekeepingMocks.createLlmResultCacheStore).toHaveBeenCalledWith(db);
    expect(stores.configStore).toBe(configStore);
    expect(stores.stateStore).toBe(stateStore);
    expect(stores.trustStore).toBe(trustStore);
    expect(stores.tunableParamsStore).toBe(tunableParamsStore);
    expect(stores.llmResultCacheStore).toBe(llmResultCacheStore);
  });
});

describe('composeHousekeepingScheduler early returns', () => {
  beforeEach(resetForTest);

  it('returns undefined scheduler and registers no tasks when both stores are undefined', async () => {
    const result = await composeWithDeps({
      stores: {
        configStore: undefined,
        stateStore: undefined,
        trustStore: undefined,
      },
    });

    expect(result).toEqual({ scheduler: undefined });
    expect(housekeepingMocks.registerHousekeepingTask).not.toHaveBeenCalled();
  });

  it('returns undefined scheduler when only configStore is defined', async () => {
    const result = await composeWithDeps({
      stores: { stateStore: undefined },
    });

    expect(result).toEqual({ scheduler: undefined });
    expect(housekeepingMocks.createHousekeepingScheduler).not.toHaveBeenCalled();
  });

  it('returns undefined scheduler when only stateStore is defined', async () => {
    const result = await composeWithDeps({
      stores: { configStore: undefined },
    });

    expect(result).toEqual({ scheduler: undefined });
    expect(housekeepingMocks.createHousekeepingScheduler).not.toHaveBeenCalled();
  });
});

describe('enrichmentProducers map handling', () => {
  beforeEach(resetForTest);

  it('clears a pre-populated map before repopulating producers', async () => {
    const enrichmentProducers = new Map<string, any>([
      ['sentinel', { producer: { topic: 'old' }, walker: { kind: 'old' } }],
    ]);

    await composeWithDeps({ enrichmentProducers });

    expect(enrichmentProducers.has('sentinel')).toBe(false);
    expect(enrichmentProducers.has('enrichment.test.topic')).toBe(true);
  });

  it('preserves map identity by mutating the caller-owned map', async () => {
    const enrichmentProducers = new Map<string, any>();
    const sameMap = enrichmentProducers;

    await composeWithDeps({ enrichmentProducers });

    expect(enrichmentProducers).toBe(sameMap);
    expect(sameMap.get('enrichment.test.topic')).toEqual({
      producer: defaultProducer,
      walker: mailThreadWalker,
    });
  });

  it("stores producer entries keyed as 'enrichment.<topic>' after a successful run", async () => {
    await composeWithDeps({ enrichmentProducers: new Map<string, any>() });

    expect(makeSchedulerDeps().enrichmentProducers.size).toBe(0);
    const actual = new Map<string, any>();
    await composeWithDeps({ enrichmentProducers: actual });
    expect(actual.get('enrichment.test.topic')).toEqual({
      producer: defaultProducer,
      walker: mailThreadWalker,
    });
  });
});

describe('Standalone task registration', () => {
  beforeEach(resetForTest);

  it('passes all STANDALONE_TASKS entries to registerHousekeepingTask in declared order', async () => {
    await composeWithDeps();

    expect(housekeepingMocks.registerHousekeepingTask.mock.calls[0][0]).toBe(
      housekeepingMocks.STANDALONE_TASKS[0],
    );
    expect(housekeepingMocks.registerHousekeepingTask.mock.calls[1][0]).toBe(
      housekeepingMocks.STANDALONE_TASKS[1],
    );
  });

  it('does not import clearDefaultHousekeepingRegistry from the housekeeping index', () => {
    const source = readFileSync(
      'backend/server/src/composition/bin/wire-housekeeping-substrate.ts',
      'utf8',
    );
    const housekeepingImport = source.match(
      /import\s*\{[\s\S]*?\}\s*from\s*'\.\.\/housekeeping\/index\.js';/,
    )?.[0] ?? '';

    expect(housekeepingImport).not.toMatch(/\bclearDefaultHousekeepingRegistry\b/);
  });

  it('registers at least the standalone task count', async () => {
    await composeWithDeps();

    expect(housekeepingMocks.registerHousekeepingTask.mock.calls.length).toBeGreaterThanOrEqual(
      housekeepingMocks.STANDALONE_TASKS.length,
    );
  });
});

describe('Conditional contact-merge registration', () => {
  beforeEach(resetForTest);

  it('registers the contact-merge scan task when contactStore is defined', async () => {
    const contactStore = { kind: 'contact-store' };

    await composeWithDeps({ contactStore });

    expect(contactMergeMocks.buildContactMergeCandidateScanTask).toHaveBeenCalledWith({
      store: contactStore,
      eventBus,
      getMode: expect.any(Function),
    });
    expect(housekeepingMocks.registerHousekeepingTask).toHaveBeenCalledWith(contactMergeTask);
  });

  it('does not register the contact-merge scan task when contactStore is undefined', async () => {
    await composeWithDeps();

    expect(contactMergeMocks.buildContactMergeCandidateScanTask).not.toHaveBeenCalled();
    expect(housekeepingMocks.registerHousekeepingTask).not.toHaveBeenCalledWith(contactMergeTask);
  });

  it('passes the provided getActiveContactMergeScanMode function as getMode', async () => {
    const getActiveContactMergeScanMode = vi.fn(() => 'full' as const);

    await composeWithDeps({
      contactStore: { kind: 'contact-store' },
      getActiveContactMergeScanMode,
    });

    const options = contactMergeMocks.buildContactMergeCandidateScanTask.mock.calls[0][0];
    expect(options.getMode).toBe(getActiveContactMergeScanMode);
    expect(options.getMode()).toBe('full');
  });

  it("uses a fallback getMode that returns 'delta' when no mode getter is provided", async () => {
    await composeWithDeps({ contactStore: { kind: 'contact-store' } });

    const options = contactMergeMocks.buildContactMergeCandidateScanTask.mock.calls[0][0];
    expect(options.getMode()).toBe('delta');
  });
});

describe('Conditional TLS cert renewal', () => {
  beforeEach(resetForTest);

  it('builds and registers the TLS cert renewal task when all three TLS deps are present', async () => {
    const rotationEngine = { kind: 'rotation-engine' };
    const tlsCertSource = { kind: 'tls-cert-source' };

    await composeWithDeps({
      rotationEngine,
      tlsCertSource,
      tlsRenewerConfigured: true,
    });

    expect(tlsRenewalMocks.buildTlsCertRenewalTask).toHaveBeenCalledWith({
      engine: rotationEngine,
      certSource: tlsCertSource,
    });
    expect(housekeepingMocks.registerHousekeepingTask).toHaveBeenCalledWith(tlsTask);
  });

  it('does not build the TLS cert renewal task when rotationEngine is absent', async () => {
    await composeWithDeps({
      tlsCertSource: { kind: 'tls-cert-source' },
      tlsRenewerConfigured: true,
    });

    expect(tlsRenewalMocks.buildTlsCertRenewalTask).not.toHaveBeenCalled();
  });

  it('does not build the TLS cert renewal task when tlsCertSource is absent', async () => {
    await composeWithDeps({
      rotationEngine: { kind: 'rotation-engine' },
      tlsRenewerConfigured: true,
    });

    expect(tlsRenewalMocks.buildTlsCertRenewalTask).not.toHaveBeenCalled();
  });

  it('does not build the TLS cert renewal task when tlsRenewerConfigured is false', async () => {
    await composeWithDeps({
      rotationEngine: { kind: 'rotation-engine' },
      tlsCertSource: { kind: 'tls-cert-source' },
      tlsRenewerConfigured: false,
    });

    expect(tlsRenewalMocks.buildTlsCertRenewalTask).not.toHaveBeenCalled();
  });
});

describe('Conditional work-entity sweep', () => {
  beforeEach(resetForTest);

  it('registers with cascade in deps when workEntityStore and enrichmentCascade are provided', async () => {
    const workEntityStore = { kind: 'work-entity-store' };
    const enrichmentCascade = { kind: 'enrichment-cascade' };

    await composeWithDeps({ workEntityStore, enrichmentCascade });

    expect(workEntitySweepMocks.buildWorkEntityDueStatusSweepTask).toHaveBeenCalledWith({
      deps: {
        store: workEntityStore,
        bus: warehouseBus,
        cascade: enrichmentCascade,
      },
    });
    expect(housekeepingMocks.registerHousekeepingTask).toHaveBeenCalledWith(workEntitySweepTask);
  });

  it('registers without a cascade key when only workEntityStore is provided', async () => {
    const workEntityStore = { kind: 'work-entity-store' };

    await composeWithDeps({ workEntityStore });

    const options = workEntitySweepMocks.buildWorkEntityDueStatusSweepTask.mock.calls[0][0];
    expect(options.deps).toEqual({
      store: workEntityStore,
      bus: warehouseBus,
    });
    expect(options.deps).not.toHaveProperty('cascade');
    expect(housekeepingMocks.registerHousekeepingTask).toHaveBeenCalledWith(workEntitySweepTask);
  });

  it('does not register the work-entity sweep task when workEntityStore is absent', async () => {
    await composeWithDeps();

    expect(workEntitySweepMocks.buildWorkEntityDueStatusSweepTask).not.toHaveBeenCalled();
    expect(housekeepingMocks.registerHousekeepingTask).not.toHaveBeenCalledWith(workEntitySweepTask);
  });
});

describe('Conditional seller-access reconciler (D-196 §6.3 s2b)', () => {
  beforeEach(resetForTest);

  it('builds AND registers the reconciler when its deps are provided', async () => {
    // THE registration that ends the reconciler's inertness. `sellerAccessReconcileDeps`
    // is a pre-built object (assembled upstream where the seller stores + gateway
    // spine both exist), so the composer just builds the task from it and registers.
    const sellerAccessReconcileDeps = { kind: 'seller-reconcile-deps' };

    await composeWithDeps({ sellerAccessReconcileDeps });

    expect(sellerReconcileMocks.buildSellerAccessReconcileTask).toHaveBeenCalledWith({
      deps: sellerAccessReconcileDeps,
    });
    expect(housekeepingMocks.registerHousekeepingTask).toHaveBeenCalledWith(sellerReconcileTask);
  });

  it('⛔ does NOT build or register when the deps are absent — inert exactly as before', async () => {
    await composeWithDeps();

    expect(sellerReconcileMocks.buildSellerAccessReconcileTask).not.toHaveBeenCalled();
    expect(housekeepingMocks.registerHousekeepingTask).not.toHaveBeenCalledWith(sellerReconcileTask);
  });
});

describe('Per-record producer registration', () => {
  beforeEach(resetForTest);

  it('registers a producer with a matching walker kind and stores it in enrichmentProducers', async () => {
    const enrichmentProducers = new Map<string, any>();

    await composeWithDeps({ enrichmentProducers });

    expect(housekeepingMocks.buildEnrichmentProducerTask).toHaveBeenCalledWith({
      producer: defaultProducer,
      walker: mailThreadWalker,
    });
    expect(housekeepingMocks.registerHousekeepingTask).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'enrichment.test.topic',
        producer: defaultProducer,
        walker: mailThreadWalker,
      }),
    );
    expect(enrichmentProducers.get('enrichment.test.topic')).toEqual({
      producer: defaultProducer,
      walker: mailThreadWalker,
    });
  });

  it('registers file producers with the file source walker', async () => {
    const producer = { topic: 'file.topic', consumes_external_context: [] };
    housekeepingMocks.PER_RECORD_PRODUCERS.splice(0, 1, {
      producer,
      walker_kind: 'file',
    } as any);
    const enrichmentProducers = new Map<string, any>();

    await composeWithDeps({ enrichmentProducers });

    expect(housekeepingMocks.createFileSourceWalker).toHaveBeenCalledWith(collectionRegistry);
    expect(housekeepingMocks.buildEnrichmentProducerTask).toHaveBeenCalledWith({
      producer,
      walker: fileWalker,
    });
    expect(enrichmentProducers.get('enrichment.file.topic')).toEqual({
      producer,
      walker: fileWalker,
    });
  });

  it('skips a producer whose walker kind is unavailable', async () => {
    housekeepingMocks.PER_RECORD_PRODUCERS.splice(0, 1, {
      producer: { topic: 'missing.walker', consumes_external_context: [] },
      walker_kind: 'unknown-kind',
    } as any);
    const enrichmentProducers = new Map<string, any>();

    await composeWithDeps({ enrichmentProducers });

    expect(housekeepingMocks.buildEnrichmentProducerTask).not.toHaveBeenCalled();
    expect(enrichmentProducers.has('enrichment.missing.walker')).toBe(false);
  });

  it('adds external context dependencies for a producer with declarations and a registry', async () => {
    const registry = { add: vi.fn() };
    const contexts = ['pulse.account', 'pulse.contact'];
    const producer = {
      topic: 'external.consumer',
      consumes_external_context: contexts,
    };
    housekeepingMocks.PER_RECORD_PRODUCERS.splice(0, 1, {
      producer,
      walker_kind: 'mail-thread',
    });

    await composeWithDeps({ externalContextRegistry: registry });

    expect(registry.add).toHaveBeenCalledWith('external.consumer', contexts);
  });

  it('still registers a producer with declarations when no externalContextRegistry is provided', async () => {
    const producer = {
      topic: 'external.no.registry',
      consumes_external_context: ['pulse.account'],
    };
    const enrichmentProducers = new Map<string, any>();
    housekeepingMocks.PER_RECORD_PRODUCERS.splice(0, 1, {
      producer,
      walker_kind: 'mail-thread',
    });

    await composeWithDeps({ enrichmentProducers });

    expect(housekeepingMocks.buildEnrichmentProducerTask).toHaveBeenCalledWith({
      producer,
      walker: mailThreadWalker,
    });
    expect(enrichmentProducers.has('enrichment.external.no.registry')).toBe(true);
  });

  it('does not add external context dependencies for an empty declaration list', async () => {
    const registry = { add: vi.fn() };

    await composeWithDeps({ externalContextRegistry: registry });

    expect(registry.add).not.toHaveBeenCalled();
  });
});

describe('Busy signal construction', () => {
  beforeEach(resetForTest);

  it('passes autoRun.inFlight when getAutoRunInFlight is provided', async () => {
    const getAutoRunInFlight = vi.fn(() => true);

    await composeWithDeps({ getAutoRunInFlight });

    expect(housekeepingMocks.createEngineBusySignal).toHaveBeenCalledWith({
      autoRun: { inFlight: getAutoRunInFlight },
      instances: instanceStore,
    });
  });

  it('omits the autoRun key when getAutoRunInFlight is absent', async () => {
    await composeWithDeps();

    const options = housekeepingMocks.createEngineBusySignal.mock.calls[0][0];
    expect(options).toEqual({ instances: instanceStore });
    expect(options).not.toHaveProperty('autoRun');
  });

  it('uses the instance store returned by createInstanceStore', async () => {
    await composeWithDeps();

    expect(instanceStoreMocks.createInstanceStore).toHaveBeenCalledWith({ db });
    expect(housekeepingMocks.createEngineBusySignal.mock.calls[0][0].instances).toBe(instanceStore);
  });
});

describe('Scheduler ctx construction', () => {
  beforeEach(resetForTest);

  it('calls createHousekeepingScheduler with ctx containing core runtime deps', async () => {
    await composeWithDeps();

    expect(schedulerArgs().ctx).toEqual(expect.objectContaining({
      db,
      bus: warehouseBus,
      enrichmentStore,
      recipeStore,
      eventBus,
      blobs: cacheBlobs,
      now: Date.now,
    }));
  });

  it('spreads llm callables into ctx', async () => {
    await composeWithDeps();

    expect(schedulerArgs().ctx).toEqual(expect.objectContaining(llmCallables));
  });

  // D-167 activation — the enrichment PII tag source is built from a
  // `local_manifest`-backed read view over the per-pair db and threaded onto
  // every HousekeepingContext, so AI producers alias known PII before egress.
  it('wires the enrichment PII tag source onto ctx from the per-pair local manifest store', async () => {
    await composeWithDeps();

    expect(localManifestMocks.createLocalManifestStore).toHaveBeenCalledWith(db);
    // D-167 default-on: the composer unions the shipped canonical/CRM schemas in
    // as the 2nd arg so enrichment-producer egress aliases known PII with no install.
    expect(
      enrichmentPiiTagSourceMocks.createEnrichmentPiiTagSourceFromLocalManifestStore,
    ).toHaveBeenCalledWith(localManifestStore, CANONICAL_PII_ENTITY_SCHEMAS);
    expect(schedulerArgs().ctx.enrichmentPiiTagSource).toBe(enrichmentPiiTagSource);
  });

  it('spreads trustStore into ctx and the top-level scheduler args when present', async () => {
    await composeWithDeps();

    expect(schedulerArgs().ctx.trustStore).toBe(trustStore);
    expect(schedulerArgs().trustStore).toBe(trustStore);
  });

  it('omits trustStore from ctx and top-level scheduler args when absent', async () => {
    await composeWithDeps({ stores: { trustStore: undefined } });

    expect(schedulerArgs().ctx).not.toHaveProperty('trustStore');
    expect(schedulerArgs()).not.toHaveProperty('trustStore');
  });

  // D-145 § A.7.8 PA9.5 + § A.7.10 — production wiring lands the
  // tunable_params accessor + LLM result cache on every HousekeepingContext
  // the server boots. The two surfaces compose independently: the accessor
  // is constructed off the store via `createTunableParamsAccessor`; the
  // cache store is threaded directly. Each spread is gated on store
  // presence so dbless harnesses + tests degrade cleanly.
  it('wires tunableParams accessor onto ctx when tunableParamsStore is present', async () => {
    await composeWithDeps();

    expect(housekeepingMocks.createTunableParamsAccessor).toHaveBeenCalledTimes(1);
    expect(housekeepingMocks.createTunableParamsAccessor).toHaveBeenCalledWith(
      tunableParamsStore,
    );
    expect(schedulerArgs().ctx.tunableParams).toBe(tunableParamsAccessor);
  });

  it('omits tunableParams from ctx when tunableParamsStore is absent', async () => {
    await composeWithDeps({ stores: { tunableParamsStore: undefined } });

    expect(housekeepingMocks.createTunableParamsAccessor).not.toHaveBeenCalled();
    expect(schedulerArgs().ctx).not.toHaveProperty('tunableParams');
  });

  it('wires llmResultCache onto ctx when llmResultCacheStore is present', async () => {
    await composeWithDeps();

    expect(schedulerArgs().ctx.llmResultCache).toBe(llmResultCacheStore);
  });

  it('omits llmResultCache from ctx when llmResultCacheStore is absent', async () => {
    await composeWithDeps({ stores: { llmResultCacheStore: undefined } });

    expect(schedulerArgs().ctx).not.toHaveProperty('llmResultCache');
  });

  it('makes emitAuditRow a no-op when auditLog is undefined', async () => {
    await composeWithDeps({ auditLog: undefined });

    expect(() => schedulerArgs().ctx.emitAuditRow({
      ts: 123,
      action: 'housekeeping_cycle',
      target: 'housekeeping',
      detail: { ok: true },
    })).not.toThrow();
  });

  it('maps emitAuditRow to auditLog.logActivity when auditLog is present', async () => {
    const auditLog = { logActivity: vi.fn().mockResolvedValue(undefined) };

    await composeWithDeps({ auditLog });
    schedulerArgs().ctx.emitAuditRow({
      ts: 123,
      action: 'tls_auto_renew_attempted',
      target: 'tls',
      detail: { status: 'attempted' },
    });

    expect(auditLog.logActivity).toHaveBeenCalledWith({
      activity_id: '',
      timestamp: 123,
      action: 'tls_auto_renew_attempted',
      target: 'tls',
      detail: JSON.stringify({ status: 'attempted' }),
    });
  });

  it('wires onCycleStart and onCycleComplete to the observer and event bus', async () => {
    const observer = {
      beginCycle: vi.fn(),
      closeCycle: vi.fn(),
    };
    const getContactMergeCycleObserver = vi.fn(() => observer);

    await composeWithDeps({ getContactMergeCycleObserver });
    schedulerArgs().onCycleStart();
    schedulerArgs().onCycleComplete({
      duration_ms: 44,
      tasks_complete: 2,
      tasks_yielded: 1,
      tasks_errored: 0,
      per_task: [{ id: 'task-a' }],
    });

    expect(observer.beginCycle).toHaveBeenCalledOnce();
    expect(observer.closeCycle).toHaveBeenCalledOnce();
    expect(eventBus.emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'housekeeping_cycle',
      duration_ms: 44,
      tasks_complete: 2,
      tasks_yielded: 1,
      tasks_errored: 0,
      per_task: [{ id: 'task-a' }],
    }));
  });
});

describe('Scheduler start gating', () => {
  beforeEach(resetForTest);

  it("does not call scheduler.start when configStore.read().preset is 'off'", async () => {
    configStore = makeConfigStore('off');

    await composeWithDeps({ stores: { configStore } });

    expect(configStore.read).toHaveBeenCalledOnce();
    expect(schedulerStart).not.toHaveBeenCalled();
  });

  it("calls scheduler.start once when configStore.read().preset is not 'off'", async () => {
    await composeWithDeps();

    expect(configStore.read).toHaveBeenCalledOnce();
    expect(schedulerStart).toHaveBeenCalledOnce();
  });

  it('returns the scheduler regardless of start state', async () => {
    const offConfigStore = makeConfigStore('off');
    const offResult = await composeWithDeps({ stores: { configStore: offConfigStore } });
    const stoppedScheduler = scheduler;
    resetForTest();
    const onResult = await composeWithDeps();

    expect(offResult.scheduler).toBe(stoppedScheduler);
    expect(onResult.scheduler).toBe(scheduler);
  });
});

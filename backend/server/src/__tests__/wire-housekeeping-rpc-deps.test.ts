import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const housekeepingMocks = vi.hoisted(() => ({
  createHousekeepingConfigStore: vi.fn(),
  createHousekeepingStateStore: vi.fn(),
  createTrustStore: vi.fn(),
  createHousekeepingScheduler: vi.fn(),
  createEngineBusySignal: vi.fn(),
  registerHousekeepingTask: vi.fn(),
  listHousekeepingTasks: vi.fn(),
  buildEnrichmentProducerTask: vi.fn(),
  createMailSourceWalker: vi.fn(),
  createSourceWalkerRegistry: vi.fn(),
  hashMailRecordWithBody: vi.fn(),
  probeAiPathAvailability: vi.fn(),
  probeEmbeddingsPathAvailability: vi.fn(),
  isByokAllowedForBackground: vi.fn(),
  STANDALONE_TASKS: [],
  PER_RECORD_PRODUCERS: [],
}));

vi.mock('../housekeeping/index.js', () => housekeepingMocks);

import { composeHousekeepingRpcDeps } from '../composition/bin/wire-housekeeping-substrate.js';

let db: Database.Database | undefined;
let configStore: any;
let stateStore: any;
let trustStore: any;
let grantEntryStore: any;
let enrichmentStore: any;
let auditLog: any;
let eventBus: any;
let llmConfig: any;
let liveLlmConfig: any;
let llmQuota: any;
let enrichmentProducers: Map<string, any>;
let getScheduler: ReturnType<typeof vi.fn>;

const resetMockDefaults = () => {
  db = new Database(':memory:');
  configStore = { kind: 'config-store' };
  stateStore = { kind: 'state-store' };
  trustStore = { read: vi.fn().mockReturnValue({ pool_policy: 'byok_only' }) };
  grantEntryStore = { kind: 'grant-entry-store' };
  enrichmentStore = { kind: 'enrichment-store' };
  auditLog = { logActivity: vi.fn() };
  eventBus = { emit: vi.fn() };
  llmConfig = { kind: 'llm-config' };
  liveLlmConfig = { kind: 'live-llm-config' };
  llmQuota = { kind: 'llm-quota' };
  enrichmentProducers = new Map<string, any>();
  getScheduler = vi.fn(() => undefined);

  housekeepingMocks.listHousekeepingTasks.mockReturnValue([{ id: 'registered' }]);
  housekeepingMocks.probeAiPathAvailability.mockResolvedValue({ available: true });
  housekeepingMocks.probeEmbeddingsPathAvailability.mockReturnValue({ available: true });
  housekeepingMocks.isByokAllowedForBackground.mockReturnValue(true);
};

const resetForTest = () => {
  vi.clearAllMocks();
  resetMockDefaults();
};

const makeRpcDeps = (overrides: Record<string, any> = {}) => {
  const { stores: storeOverrides, ...rest } = overrides;
  return {
    db,
    stores: {
      configStore,
      stateStore,
      trustStore,
      ...(storeOverrides ?? {}),
    },
    enrichmentStore,
    grantEntryStore,
    auditLog,
    eventBus,
    llmConfig,
    resolveLlmConfig: () => liveLlmConfig,
    llmQuota,
    enrichmentProducers,
    getScheduler,
    ...rest,
  };
};

const composeWithDeps = (overrides: Record<string, any> = {}) =>
  composeHousekeepingRpcDeps(makeRpcDeps(overrides) as any) as any;

const makeProducer = (overrides: Record<string, any> = {}) => ({
  topic: 'test.topic',
  source_scope: 'mail',
  ai_surface: 'chat',
  estimate_per_record_tokens: vi.fn().mockReturnValue(25),
  scope_read_declaration: [
    { collection: 'mail', sample_field_paths: ['subject', 'body_preview'] },
  ],
  produce: vi.fn(),
  consumes_external_context: [],
  ...overrides,
});

const addProducer = (
  taskId = 'enrichment.test.topic',
  overrides: Record<string, any> = {},
) => {
  const producer = makeProducer(overrides);
  enrichmentProducers.set(taskId, {
    producer,
    walker: { kind: 'source-walker' },
  });
  return producer;
};

const seedMailTables = () => {
  db!.exec(`
    CREATE TABLE "collection_mail_alpha" (id TEXT);
    CREATE TABLE "collection_mail_beta" (id TEXT);
    CREATE TABLE "collection_contact_alpha" (id TEXT);
    INSERT INTO "collection_mail_alpha" (id) VALUES ('a1'), ('a2');
    INSERT INTO "collection_mail_beta" (id) VALUES ('b1');
    INSERT INTO "collection_contact_alpha" (id) VALUES ('c1'), ('c2'), ('c3');
  `);
};

describe('composeHousekeepingRpcDeps store gating', () => {
  beforeEach(resetForTest);
  afterEach(() => db?.close());

  it('returns undefined when configStore or stateStore is undefined', () => {
    expect(composeWithDeps({ stores: { configStore: undefined } })).toBeUndefined();
    expect(composeWithDeps({ stores: { stateStore: undefined } })).toBeUndefined();
  });

  it('includes optional stores only when defined and always includes eventBus', () => {
    const full = composeWithDeps();

    expect(full.config).toBe(configStore);
    expect(full.state).toBe(stateStore);
    expect(full.trustStore).toBe(trustStore);
    expect(full.eventBus).toBe(eventBus);
    expect(full.enrichmentStore).toBe(enrichmentStore);
    expect(full.auditLog).toBe(auditLog);
    expect(full.grantEntryStore).toBe(grantEntryStore);
    expect(full.db).toBe(db);

    const minimal = composeWithDeps({
      db: undefined,
      enrichmentStore: undefined,
      grantEntryStore: undefined,
      auditLog: undefined,
      stores: {
        trustStore: undefined,
      },
    });

    expect(minimal.eventBus).toBe(eventBus);
    expect(minimal).not.toHaveProperty('trustStore');
    expect(minimal).not.toHaveProperty('enrichmentStore');
    expect(minimal).not.toHaveProperty('auditLog');
    expect(minimal).not.toHaveProperty('grantEntryStore');
    expect(minimal).not.toHaveProperty('db');
  });
});

describe('composeHousekeepingRpcDeps registry and runOnce', () => {
  beforeEach(resetForTest);
  afterEach(() => db?.close());

  it('re-reads listHousekeepingTasks on every registry call', () => {
    const first = [{ id: 'first' }];
    const second = [{ id: 'second' }];
    housekeepingMocks.listHousekeepingTasks
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);

    const deps = composeWithDeps();

    expect(deps.registry()).toBe(first);
    expect(deps.registry()).toBe(second);
    expect(housekeepingMocks.listHousekeepingTasks).toHaveBeenCalledTimes(2);
  });

  it("throws when runOnce fires before the scheduler is constructed", async () => {
    const deps = composeWithDeps();

    await expect(deps.runOnce({ task_id: 'task-a' })).rejects.toThrow(
      'housekeeping scheduler not yet constructed',
    );
    expect(getScheduler).toHaveBeenCalledOnce();
  });

  it('delegates runOnce to the late-bound scheduler', async () => {
    const result = { per_task: [{ id: 'task-a' }] };
    const scheduler = { runOnce: vi.fn().mockResolvedValue(result) };
    getScheduler.mockReturnValue(scheduler);
    const deps = composeWithDeps();
    const opts = { task_id: 'task-a', budget_ms: 1234 };

    await expect(deps.runOnce(opts)).resolves.toBe(result);
    expect(scheduler.runOnce).toHaveBeenCalledWith(opts);
  });
});

describe('composeHousekeepingRpcDeps getEnrichmentInfo', () => {
  beforeEach(resetForTest);
  afterEach(() => db?.close());

  it('returns undefined when the task is missing or db is undefined', async () => {
    const deps = composeWithDeps();

    await expect(deps.getEnrichmentInfo('missing')).resolves.toBeUndefined();

    addProducer();
    const noDbDeps = composeWithDeps({ db: undefined });

    await expect(noDbDeps.getEnrichmentInfo('enrichment.test.topic')).resolves.toBeUndefined();
  });

  it('returns only deterministic enrichment info when token estimate is zero', async () => {
    seedMailTables();
    const producer = addProducer('enrichment.zero', {
      estimate_per_record_tokens: vi.fn().mockReturnValue(0),
      scope_read_declaration: [
        { collection: 'mail', sample_field_paths: ['subject'] },
        { collection: 'calendar', sample_field_paths: ['summary'] },
      ],
    });
    const deps = composeWithDeps();

    const result = await deps.getEnrichmentInfo('enrichment.zero');

    expect(producer.estimate_per_record_tokens).toHaveBeenCalledOnce();
    expect(result).toEqual({
      token_estimate_per_record: 0,
      source_collection_count: 3,
      scope_read: [
        { collection: 'mail', sample_field_paths: ['subject'], record_count: 3 },
        { collection: 'calendar', sample_field_paths: ['summary'] },
      ],
    });
    expect(housekeepingMocks.probeAiPathAvailability).not.toHaveBeenCalled();
    expect(housekeepingMocks.probeEmbeddingsPathAvailability).not.toHaveBeenCalled();
    expect(housekeepingMocks.isByokAllowedForBackground).not.toHaveBeenCalled();
    expect(trustStore.read).not.toHaveBeenCalled();
  });

  it('probes the embeddings path for embeddings producers', async () => {
    housekeepingMocks.probeEmbeddingsPathAvailability.mockReturnValue({
      available: false,
      reason: 'no_embeddings_model',
    });
    addProducer('enrichment.embedding', {
      ai_surface: 'embeddings',
      estimate_per_record_tokens: vi.fn().mockReturnValue(64),
    });
    const deps = composeWithDeps();

    const result = await deps.getEnrichmentInfo('enrichment.embedding');

    // D-174 R28 Slice C — the embeddings probe reads LIVE config (via
    // resolveLlmConfig), distinct from the boot `llmConfig` the chat probe uses.
    expect(housekeepingMocks.probeEmbeddingsPathAvailability).toHaveBeenCalledWith(
      liveLlmConfig,
      llmQuota,
    );
    expect(housekeepingMocks.probeAiPathAvailability).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      token_estimate_per_record: 64,
      ai_path_available: false,
      ai_path_reason: 'no_embeddings_model',
    });
  });

  it('probes the chat path for non-embeddings producers and omits empty reasons', async () => {
    housekeepingMocks.probeAiPathAvailability.mockResolvedValue({ available: false });
    addProducer('enrichment.chat', {
      ai_surface: undefined,
      estimate_per_record_tokens: vi.fn().mockReturnValue(12),
    });
    const deps = composeWithDeps();

    const result = await deps.getEnrichmentInfo('enrichment.chat');

    expect(housekeepingMocks.probeAiPathAvailability).toHaveBeenCalledWith(
      llmConfig,
      llmQuota,
    );
    expect(housekeepingMocks.probeEmbeddingsPathAvailability).not.toHaveBeenCalled();
    expect(result.ai_path_available).toBe(false);
    expect(result).not.toHaveProperty('ai_path_reason');
  });

  it('reads trust, collapses pool policy when global BYOK is off, and uses defaults otherwise', async () => {
    housekeepingMocks.isByokAllowedForBackground.mockReturnValue(false);
    addProducer('enrichment.policy-off', {
      topic: 'policy.topic',
      estimate_per_record_tokens: vi.fn().mockReturnValue(4),
    });
    const offDeps = composeWithDeps();

    const offResult = await offDeps.getEnrichmentInfo('enrichment.policy-off');

    expect(trustStore.read).toHaveBeenCalledWith('policy.topic', true);
    expect(housekeepingMocks.isByokAllowedForBackground).toHaveBeenCalledWith(db);
    expect(offResult.effective_pool_policy).toBe('free_only');
    expect(offResult.global_byok_allowed).toBe(false);

    resetForTest();
    trustStore.read.mockReturnValue(undefined);
    addProducer('enrichment.policy-default', {
      topic: 'default.topic',
      estimate_per_record_tokens: vi.fn().mockReturnValue(4),
    });
    const defaultDeps = composeWithDeps();

    const defaultResult = await defaultDeps.getEnrichmentInfo('enrichment.policy-default');

    expect(defaultResult.effective_pool_policy).toBe('free_then_byok');
    expect(defaultResult.global_byok_allowed).toBe(true);
  });

  it('works without a trustStore while preserving the global BYOK policy fields', async () => {
    addProducer('enrichment.no-trust', {
      estimate_per_record_tokens: vi.fn().mockReturnValue(9),
    });
    const deps = composeWithDeps({ stores: { trustStore: undefined } });

    const result = await deps.getEnrichmentInfo('enrichment.no-trust');

    expect(result.effective_pool_policy).toBe('free_then_byok');
    expect(result.global_byok_allowed).toBe(true);
  });

  it('maps scope_read record_count only for positive counts or the producer source scope', async () => {
    seedMailTables();
    addProducer('enrichment.scope', {
      source_scope: 'contact',
      estimate_per_record_tokens: vi.fn().mockReturnValue(0),
      scope_read_declaration: [
        { collection: 'contact', sample_field_paths: ['display_name'] },
        { collection: 'mail', sample_field_paths: ['subject'] },
        { collection: 'calendar', sample_field_paths: ['summary'] },
      ],
    });
    const deps = composeWithDeps();

    const result = await deps.getEnrichmentInfo('enrichment.scope');

    expect(result.source_collection_count).toBe(0);
    expect(result.scope_read).toEqual([
      { collection: 'contact', sample_field_paths: ['display_name'], record_count: 0 },
      { collection: 'mail', sample_field_paths: ['subject'], record_count: 3 },
      { collection: 'calendar', sample_field_paths: ['summary'] },
    ]);
  });
});

/** D-157 executeDeps boot composition. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  D165_CONTRACT_SCHEMA,
  OWNER_OPERATION_SCOPE,
  operationSpecHash,
  type Checkpoint,
  type IngredientManifest,
  type McpInboundTokenRecord,
} from '@recued/contracts';
import type { NotificationBlock } from '@recued/notification';
import {
  createAuditLogStore,
  createCheckpointStore,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
  type CheckpointStore,
  type CommitStore,
} from '@recued/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventBus } from '../events/bus.js';
import type { RecipeStore } from '../recipe-store.js';
import type { ServerExecutorConfig } from '../server-executor.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createContactStore } from '../storage/contact-store.js';
import type { EnrichmentStore } from '../storage/enrichment-store.js';
import type { SharedStore } from '../storage/shared-store.js';
import type { AnnotationStore } from '../storage/annotation-store.js';
import { ensureCheckpointSchema } from '../memory-schema.js';
import { ensureSourceDependencyEntitySchema } from '../storage/source-dependency-entity-store.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createAnnotationStore } from '../storage/annotation-store.js';
import { createContractStore } from '../storage/contract-store.js';
import {
  composeExecuteDeps,
  type ComposeExecuteDepsDeps,
} from '../composition/bin/wire-execute-deps.js';
import type {
  ComposeNotificationBlockDeps,
  NotificationBlockBundle,
} from '../composition/bin/wire-notification-block.js';

type TestEventBus = EventBus & { emit: ReturnType<typeof vi.fn> };

const NOW = Date.parse('2026-05-22T18:00:00.000Z');
const cleanups: Array<() => void> = [];

const directExecuteDepKeys = [
  'auditLog',
  'baseVault',
  // D-181 slice 2/4 — the long-op execution-control fields are constructed
  // unconditionally in the composer (the lane governor + its duration classifier +
  // the in-flight registry over them + the registry-aware cli executor), so their
  // keys are always present on the executeDeps surface.
  'cliInvocationExecutor',
  'inFlightRegistry',
  'laneGovernor',
  'opDurationClassifier',
  // D-165 P0/P1 — `connectionOperationProfiles` is created unconditionally
  // (the catalog gateway's profile resolver is always live; only the P1
  // HubSpot boot-seeding of it is gated on `connectionStore`), so the key
  // is always present on the executeDeps surface.
  'connectionOperationProfiles',
  'eventBus',
  'executorConfig',
  'instanceId',
  'recipeStore',
  'serverName',
  'sharedStore',
] as const;

const conditionalExecuteDepKeys = [
  // D-177 P5a — the batch-approval coordinator, composed with the
  // notification block (rides the same prereq gate).
  'batchApprovals',
  'checkpointStore',
  'commitStore',
  'db',
  'enrichmentStore',
  'preflightNotifier',
  // R2 step 6 — the same notification block, threaded as the torn-saga
  // notifier (rides the identical conditional spread as preflightNotifier).
  'sagaNotifier',
  // Doc §4 close-out — the same block, threaded as the >1-provider pick
  // notifier (identical conditional spread).
  'pickNotifier',
  // D-177 N.11 rule 1 — the annotation store now forwards onto
  // executeDeps (engine annotation prefetch + stored-cleanliness gate;
  // previously only the notification block consumed it) and the contact
  // store threads for the gate's dotted-email record resolution.
  'annotationStore',
  'contactStore',
  // D-179 P1 — dish resolution + per-dish continuity, both db-gated
  // (constructed inside the composer from `deps.db`); P3 adds the
  // group store for overlay inheritance.
  'dishStore',
  'dishGroupStore',
  'dishContextStore',
  // D-192 Slices 6b + 6c — the same notification block again, threaded as the
  // container-pick and create-plan notifier seams (both ride the identical
  // conditional spread as preflightNotifier). This ratchet had drifted stale
  // against them: it was RED at HEAD, masked by a `source_dependency_entity`
  // SqliteError that made composition throw before the parity assert ran.
  'containerPickNotifier',
  'createPlanNotifier',
] as const;

const makeDb = (): Database.Database => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  // `composeNotificationBlock` unconditionally builds the D-192 Slice 6b
  // container-pick store (`createSourceDependencyEntityStore`), so its table
  // must exist before composition — same pattern as `checkpointStore` below.
  ensureSourceDependencyEntitySchema(db);
  return db;
};

const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'execute-deps-composition-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const eventBus = (
  emit: ReturnType<typeof vi.fn> = vi.fn((event: unknown) => ({
    ...(event as Record<string, unknown>),
    cursor: 1,
  })),
): TestEventBus => ({
  cursor: vi.fn(() => 0),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  emit,
  replay: vi.fn(() => []),
  subscriberCount: vi.fn(() => 0),
}) as unknown as TestEventBus;

const auditLog = (db: Database.Database): AuditLogStore =>
  createAuditLogStore(
    createSQLiteCollection<AuditEntry>(db, 'audit_log'),
    createSQLiteCollection<ActivityEntry>(db, 'activity_log'),
  );

const checkpointStore = (db: Database.Database): CheckpointStore => {
  const store = createCheckpointStore(
    createSQLiteCollection<Checkpoint>(db, 'checkpoints'),
  );
  ensureCheckpointSchema(db);
  return store;
};

const annotationStore = (
  db: Database.Database,
  dir: string,
): AnnotationStore => {
  let nextId = 0;
  return createAnnotationStore({
    db,
    blobs: createBlobStore(join(dir, 'blobs')),
    now: () => NOW,
    newId: () => `annotation-${++nextId}`,
  });
};

const recipeStore = (): RecipeStore =>
  ({
    ids: vi.fn(() => []),
    get: vi.fn(() => null),
    getBundled: vi.fn(() => null),
    getStored: vi.fn(() => null),
    size: vi.fn(() => 0),
    register: vi.fn(),
    save: vi.fn(),
    delete: vi.fn(() => false),
    listStored: vi.fn(() => []),
    updateUpstream: vi.fn(),
    setOnUpgrade: vi.fn(),
  }) as unknown as RecipeStore;

const executorConfig = (): ServerExecutorConfig =>
  ({ manifests: {} }) as unknown as ServerExecutorConfig;

const sharedStore = (): SharedStore =>
  ({ read: vi.fn() }) as unknown as SharedStore;

const enrichmentStore = (): EnrichmentStore =>
  ({ list: vi.fn(() => []) }) as unknown as EnrichmentStore;

const commitStore = (): CommitStore =>
  ({ listPending: vi.fn(async () => []) }) as unknown as CommitStore;

const notificationPrereqs = () => {
  const db = makeDb();
  const dir = makeTempDir();
  return {
    db,
    auditLog: auditLog(db),
    checkpointStore: checkpointStore(db),
    annotationStore: annotationStore(db, dir),
  };
};

const buildDeps = (
  overrides: Partial<ComposeExecuteDepsDeps> = {},
): ComposeExecuteDepsDeps => ({
  recipeStore: recipeStore(),
  executorConfig: executorConfig(),
  baseVault: { TOKEN: 'server-token' },
  serverInstanceId: 'server-instance-1',
  serverDisplayName: 'Server One',
  eventBus: eventBus(),
  auditLog: undefined,
  sharedStore: undefined,
  db: undefined,
  enrichmentStore: undefined,
  commitStore: undefined,
  checkpointStore: undefined,
  annotationStore: undefined,
  getExecuteDeps: vi.fn<() => ExecuteHandlerDeps | undefined>(() => undefined),
  ...overrides,
});

const notificationBlockShape = () => ({
  notify: expect.any(Function),
  ask: expect.any(Function),
  registerAskHandler: expect.any(Function),
  submitAnswer: expect.any(Function),
  recoverPendingAsks: expect.any(Function),
  countOutstandingAsks: expect.any(Function),
  getNotificationSettings: expect.any(Function),
  describeNotificationChannels: expect.any(Function),
  // D-169 — `setNotificationChannel` became the two-mode setters
  // (`setNotificationChannelMode` + the bridge peer). The old name had rotted
  // here as the codebase's LAST reference to it, masked by the SqliteError
  // above that made composition throw before this assert ran.
  setNotificationChannelMode: expect.any(Function),
  setNotificationBridgeMode: expect.any(Function),
  setNotificationVerificationPhrase: expect.any(Function),
});

const expectNoConditionalSpreadKeys = (
  executeDeps: ExecuteHandlerDeps,
): void => {
  for (const key of conditionalExecuteDepKeys) {
    expect(key in executeDeps).toBe(false);
  }
};

const importComposerWithNotificationSpy = async () => {
  vi.resetModules();

  const block = {
    notify: vi.fn(),
    ask: vi.fn(),
    registerAskHandler: vi.fn(),
    submitAnswer: vi.fn(),
    recoverPendingAsks: vi.fn(),
    countOutstandingAsks: vi.fn(),
    getNotificationSettings: vi.fn(),
    describeNotificationChannels: vi.fn(),
    setNotificationChannel: vi.fn(),
    setNotificationVerificationPhrase: vi.fn(),
  } as unknown as NotificationBlock;
  const composeNotificationBlockMock = vi.fn<
    (deps: ComposeNotificationBlockDeps) => NotificationBlockBundle
  >(() => ({
    block,
    resumer: {
      resumeRun: vi.fn(),
      denyRun: vi.fn(),
    },
    // D-177 P5a — the bundle carries the batch-approval coordinator.
    batchApprovals: {
      registerHold: vi.fn(async () => ({ kind: 'fallback' as const })),
      hooks: { handleAnswer: vi.fn(async () => 'fallback' as const) },
    },
    // The `/ask` landing's live batch-membership read. REQUIRED on the bundle
    // on purpose: a composition that omits it silently turns the landing
    // page's detail block off for every reception hold, so the type is the
    // fence rather than a runtime surprise.
    getBatch: vi.fn(async () => null),
  }));

  vi.doMock('../composition/bin/wire-notification-block.js', () => ({
    composeNotificationBlock: composeNotificationBlockMock,
  }));

  const mod = await import('../composition/bin/wire-execute-deps.js');
  return {
    compose: mod.composeExecuteDeps,
    composeNotificationBlockMock,
    block,
  };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../composition/bin/wire-notification-block.js');
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe('composeExecuteDeps bundle shape', () => {
  it('returns exactly executeDeps and an undefined notificationBlock on the dbless path', () => {
    const bundle = composeExecuteDeps(buildDeps());

    expect(Object.keys(bundle).sort()).toEqual([
      // D-207 slice 1c — the contract substrate the reception door is minted into,
      // surfaced so the boot site hands the door the SAME stores the Gateway reads.
      'contractDefinitionStore',
      'executeDeps',
      // The `/ask` landing's live batch-membership read, surfaced from the
      // notification bundle that owns the batch rows. Undefined alongside
      // `notificationBlock` on the dbless path, but PRESENT as a key either
      // way — a composition that cannot count a batch's members must fail
      // closed at the resolver, not silently omit the seam here.
      'getBatch',
      'grantEntryStore',
      // D-181 slice 4 — the bundle also surfaces the in-flight registry (the
      // live active-list + kill authority) for the boot composer to wire.
      'inFlightRegistry',
      'notificationBlock',
      // D-210 Phase C — the DECORATED preflight resumer, surfaced so the
      // Reception inbox can release a hold that carries no durable ask
      // (notify-mode fanout). Must be THIS instance: the intake acceptance
      // hook rides the decoration, and one resumer across Inbox / global
      // queue / batch / boot recovery is what keeps approval semantics
      // identical on every surface.
      'preflightResumer',
    ]);
    expect('executeDeps' in bundle).toBe(true);
    expect('notificationBlock' in bundle).toBe(true);
    expect(bundle.notificationBlock).toBeUndefined();
  });

  it('returns exactly executeDeps and a notificationBlock when all block prereqs are present', () => {
    const bundle = composeExecuteDeps(buildDeps(notificationPrereqs()));

    expect(Object.keys(bundle).sort()).toEqual([
      // D-207 slice 1c — the contract substrate the reception door is minted into,
      // surfaced so the boot site hands the door the SAME stores the Gateway reads.
      'contractDefinitionStore',
      'executeDeps',
      // The `/ask` landing's live batch-membership read, surfaced from the
      // notification bundle that owns the batch rows. Undefined alongside
      // `notificationBlock` on the dbless path, but PRESENT as a key either
      // way — a composition that cannot count a batch's members must fail
      // closed at the resolver, not silently omit the seam here.
      'getBatch',
      'grantEntryStore',
      // D-181 slice 4 — the bundle also surfaces the in-flight registry (the
      // live active-list + kill authority) for the boot composer to wire.
      'inFlightRegistry',
      'notificationBlock',
      // D-210 Phase C — the DECORATED preflight resumer, surfaced so the
      // Reception inbox can release a hold that carries no durable ask
      // (notify-mode fanout). Must be THIS instance: the intake acceptance
      // hook rides the decoration, and one resumer across Inbox / global
      // queue / batch / boot recovery is what keeps approval semantics
      // identical on every surface.
      'preflightResumer',
    ]);
    expect(bundle.notificationBlock).toEqual(
      expect.objectContaining(notificationBlockShape()),
    );
  });
});

describe('composeExecuteDeps ExecuteHandlerDeps field parity', () => {
  it('keeps direct fields always keyed on the dbless path', () => {
    const deps = buildDeps();
    const { executeDeps } = composeExecuteDeps(deps);

    expect(Object.keys(executeDeps).sort()).toEqual(
      [...directExecuteDepKeys].sort(),
    );
    expect('recipeStore' in executeDeps).toBe(true);
    expect(executeDeps.recipeStore).toBe(deps.recipeStore);
    expect('executorConfig' in executeDeps).toBe(true);
    expect(executeDeps.executorConfig).toBe(deps.executorConfig);
    expect('baseVault' in executeDeps).toBe(true);
    expect(executeDeps.baseVault).toBe(deps.baseVault);
    expect('auditLog' in executeDeps).toBe(true);
    expect(executeDeps.auditLog).toBeUndefined();
    expect('instanceId' in executeDeps).toBe(true);
    expect(executeDeps.instanceId).toBe(deps.serverInstanceId);
    expect('serverName' in executeDeps).toBe(true);
    expect(executeDeps.serverName).toBe(deps.serverDisplayName);
    expect('sharedStore' in executeDeps).toBe(true);
    expect(executeDeps.sharedStore).toBeUndefined();
    expect('eventBus' in executeDeps).toBe(true);
    expect(executeDeps.eventBus).toBe(deps.eventBus);
  });

  it('keeps direct optional auditLog and sharedStore keyed with defined identities', () => {
    const storeDb = makeDb();
    const log = auditLog(storeDb);
    const shared = sharedStore();
    const { executeDeps } = composeExecuteDeps(buildDeps({
      auditLog: log,
      sharedStore: shared,
    }));

    expect('auditLog' in executeDeps).toBe(true);
    expect(executeDeps.auditLog).toBe(log);
    expect('sharedStore' in executeDeps).toBe(true);
    expect(executeDeps.sharedStore).toBe(shared);
  });

  it('omits every conditional-spread field when the matching input is undefined', () => {
    const { executeDeps } = composeExecuteDeps(buildDeps());

    expectNoConditionalSpreadKeys(executeDeps);
  });

  it('D-196 R2 composes live approval authority from the inbound bearer store', () => {
    const token: McpInboundTokenRecord = {
      token_id: 'tok-1',
      bearer_hash: 'a'.repeat(64),
      label: 'door',
      created_at: NOW - 1_000,
      expires_at: 0,
      revoked_at: null,
      grants: {
        recued_runRecipe: true,
        'recued_ingredient_mail-send': true,
      },
      concurrency_tier: 3,
      chat_mode: null,
      updated_at: NOW - 1_000,
    };
    const config = {
      manifests: {
        slugs: () => ['mail-send'],
        get: vi.fn(() => null),
      },
    } as unknown as ServerExecutorConfig;
    const { executeDeps } = composeExecuteDeps(buildDeps({
      executorConfig: config,
      inboundTokenStore: {
        getTokenById: vi.fn(() => token),
      },
    }));

    const result = executeDeps.approvalResumeAuthority?.resolve({
      execution_source: {
        channel: 'mcp',
        actor: 'contracted_user',
        agent_id: 'agent-1',
        tool_call_id: 'call-1',
        mcp_token_id: 'tok-1',
        contract_id: 'tok-1',
      },
      required_bearer_tool_names: ['recued_runRecipe'],
    });

    expect(result).toMatchObject({
      admitted: true,
      contract_snapshot: {
        allowed_tools: ['mail-send'],
      },
    });
  });

  it('includes every conditional-spread field with identity when the matching input is present', () => {
    const prereqs = notificationPrereqs();
    const enrichments = enrichmentStore();
    const commits = commitStore();
    // D-177 N.11 rule 1 — contact store threads conditionally too.
    const contacts = createContactStore(makeDb());
    const { executeDeps, notificationBlock } = composeExecuteDeps(buildDeps({
      ...prereqs,
      enrichmentStore: enrichments,
      commitStore: commits,
      contactStore: contacts,
    }));

    expect(Object.keys(executeDeps).sort()).toEqual([
      ...directExecuteDepKeys,
      ...conditionalExecuteDepKeys,
    ].sort());
    expect('db' in executeDeps).toBe(true);
    expect(executeDeps.db).toBe(prereqs.db);
    expect('enrichmentStore' in executeDeps).toBe(true);
    expect(executeDeps.enrichmentStore).toBe(enrichments);
    expect('commitStore' in executeDeps).toBe(true);
    expect(executeDeps.commitStore).toBe(commits);
    expect('checkpointStore' in executeDeps).toBe(true);
    expect(executeDeps.checkpointStore).toBe(prereqs.checkpointStore);
    expect('preflightNotifier' in executeDeps).toBe(true);
    expect(executeDeps.preflightNotifier).toBe(notificationBlock);
    expect('sagaNotifier' in executeDeps).toBe(true);
    expect(executeDeps.sagaNotifier).toBe(notificationBlock);
    expect('pickNotifier' in executeDeps).toBe(true);
    expect(executeDeps.pickNotifier).toBe(notificationBlock);
    // D-177 N.11 rule 1 — annotation + contact stores forward with
    // identity (gate row reads must hit the same live stores the rpcs
    // write through).
    expect('annotationStore' in executeDeps).toBe(true);
    expect(executeDeps.annotationStore).toBe(prereqs.annotationStore);
    expect('contactStore' in executeDeps).toBe(true);
    expect(executeDeps.contactStore).toBe(contacts);
    // D-179 P1 — dish stores are composer-constructed (not pass-through),
    // so assert presence rather than identity.
    expect('dishStore' in executeDeps).toBe(true);
    expect(executeDeps.dishStore).toBeDefined();
    expect('dishContextStore' in executeDeps).toBe(true);
    expect(executeDeps.dishContextStore).toBeDefined();
  });
});

describe('composeExecuteDeps notification-block gating', () => {
  it.each([
    ['db absent', 'db', false],
    ['auditLog absent', 'auditLog', false],
    ['checkpointStore absent', 'checkpointStore', false],
    ['annotationStore absent', 'annotationStore', false],
    ['all four absent', 'all', false],
    ['all four present', 'none', true],
  ] as const)(
    '%s gates notificationBlock and preflightNotifier together',
    (_name, missing, shouldCompose) => {
      const overrides =
        missing === 'all' ? {} : notificationPrereqs();
      const deps = buildDeps({
        ...overrides,
        ...(missing === 'db' ? { db: undefined } : {}),
        ...(missing === 'auditLog' ? { auditLog: undefined } : {}),
        ...(missing === 'checkpointStore' ? { checkpointStore: undefined } : {}),
        ...(missing === 'annotationStore' ? { annotationStore: undefined } : {}),
      });

      const bundle = composeExecuteDeps(deps);

      if (shouldCompose) {
        expect(bundle.notificationBlock).toEqual(
          expect.objectContaining(notificationBlockShape()),
        );
        expect('preflightNotifier' in bundle.executeDeps).toBe(true);
        expect(bundle.executeDeps.preflightNotifier).toBe(bundle.notificationBlock);
      } else {
        expect(bundle.notificationBlock).toBeUndefined();
        expect('preflightNotifier' in bundle.executeDeps).toBe(false);
      }
    },
  );
});

describe('composeExecuteDeps getExecuteDeps thunk plumbing', () => {
  it('passes the caller thunk to composeNotificationBlock unchanged and leaves it lazy', async () => {
    const {
      compose,
      composeNotificationBlockMock,
      block,
    } = await importComposerWithNotificationSpy();
    let executeDepsRef: ExecuteHandlerDeps | undefined;
    const getExecuteDeps = vi.fn(() => executeDepsRef);

    const bundle = compose(buildDeps({
      ...notificationPrereqs(),
      getExecuteDeps,
    }));

    expect(getExecuteDeps).not.toHaveBeenCalled();
    expect(composeNotificationBlockMock).toHaveBeenCalledTimes(1);
    const callDeps = composeNotificationBlockMock.mock.calls[0]![0];
    expect(callDeps.getExecuteDeps).toBe(getExecuteDeps);
    expect(callDeps.getExecuteDeps()).toBeUndefined();
    executeDepsRef = bundle.executeDeps;
    expect(callDeps.getExecuteDeps()).toBe(bundle.executeDeps);
    expect(bundle.notificationBlock).toBe(block);
  });

  it('threads an authoritative standing-ruling writer that preserves sibling policy facets', async () => {
    const {
      compose,
      composeNotificationBlockMock,
    } = await importComposerWithNotificationSpy();
    const prereqs = notificationPrereqs();
    const contractStore = createContractStore(prereqs.db, { now: () => NOW });
    contractStore.seedSchema(D165_CONTRACT_SCHEMA);
    contractStore.put(
      OWNER_OPERATION_SCOPE,
      ['test/simple', 'test/simple'],
      { risk: 'read', approval: 'ask', op_hash: 'old-hash' },
    );
    const manifests = createManifestRegistry('/nonexistent-d211-composition-dir');
    manifests.register({
      slug: 'test/simple',
      name: 'D-211 simple operation',
      description: 'Standing-ruling composition fixture',
      author: 'recued-core',
      kind: 'connection',
      category: 'action',
      risk_tier: 'read',
      input: {},
      output: {},
    } satisfies IngredientManifest);

    compose(buildDeps({
      ...prereqs,
      contractStore,
      executorConfig: { manifests } as ServerExecutorConfig,
    }));

    const callDeps = composeNotificationBlockMock.mock.calls[0]![0];
    expect(callDeps.upsertOverride).toEqual(expect.any(Function));
    await callDeps.upsertOverride!({
      kind: 'never_ask',
      ingredient_id: 'test/simple',
      operation_id: 'test/simple',
      op_hash: operationSpecHash({
        operation_id: 'test/simple',
        risk_tier: 'read',
      }),
      approval: 'never',
    });

    expect(
      contractStore.get(
        OWNER_OPERATION_SCOPE,
        ['test/simple', 'test/simple'],
      )?.value,
    ).toMatchObject({
      approval: 'never',
      risk: 'read',
      op_hash: expect.any(String),
    });
  });

  it('rejects a standing-ruling action when the exact operation changed after the ask', async () => {
    const {
      compose,
      composeNotificationBlockMock,
    } = await importComposerWithNotificationSpy();
    const prereqs = notificationPrereqs();
    const contractStore = createContractStore(prereqs.db, { now: () => NOW });
    contractStore.seedSchema(D165_CONTRACT_SCHEMA);
    const manifests = createManifestRegistry('/nonexistent-d211-stale-offer-dir');
    const operation = {
      operation_id: 'test/catalog.read',
      description: 'The operation the owner reviewed.',
      risk_tier: 'read' as const,
    };
    const catalog = {
      slug: 'test/catalog',
      name: 'D-211 catalog operation',
      description: 'Standing-ruling staleness fixture',
      author: 'recued-core',
      kind: 'connection',
      category: 'action',
      risk_tier: 'read',
      input: {},
      output: {},
      operations: { read: operation },
    } satisfies IngredientManifest;
    manifests.register(catalog);

    compose(buildDeps({
      ...prereqs,
      contractStore,
      executorConfig: { manifests } as ServerExecutorConfig,
    }));
    const writer = composeNotificationBlockMock.mock.calls[0]![0].upsertOverride!;

    manifests.register({
      ...catalog,
      operations: {
        read: { ...operation, description: 'Changed after the ask was rendered.' },
      },
    });

    await expect(writer({
      kind: 'never_ask',
      ingredient_id: catalog.slug,
      operation_id: operation.operation_id,
      op_hash: operationSpecHash(operation),
      approval: 'never',
    })).rejects.toThrow(/operation changed or was removed/);
    expect(
      contractStore.get(
        OWNER_OPERATION_SCOPE,
        [catalog.slug, operation.operation_id],
      ),
    ).toBeNull();
  });
});

describe('composeExecuteDeps preflight notifier identity', () => {
  it('threads the notificationBlock instance itself as executeDeps.preflightNotifier', () => {
    const bundle = composeExecuteDeps(buildDeps(notificationPrereqs()));

    expect(bundle.notificationBlock).toBeDefined();
    expect(bundle.executeDeps.preflightNotifier).toBe(bundle.notificationBlock);
  });
});

describe('composeExecuteDeps determinism', () => {
  it('returns the same executeDeps shape and input identities for identical inputs', () => {
    const deps = buildDeps({
      ...notificationPrereqs(),
      enrichmentStore: enrichmentStore(),
      commitStore: commitStore(),
      sharedStore: sharedStore(),
    });

    const first = composeExecuteDeps(deps);
    const second = composeExecuteDeps(deps);

    expect(Object.keys(second.executeDeps).sort()).toEqual(
      Object.keys(first.executeDeps).sort(),
    );
    expect(second.executeDeps.recipeStore).toBe(deps.recipeStore);
    expect(second.executeDeps.executorConfig).toBe(deps.executorConfig);
    expect(second.executeDeps.baseVault).toBe(deps.baseVault);
    expect(second.executeDeps.auditLog).toBe(deps.auditLog);
    expect(second.executeDeps.sharedStore).toBe(deps.sharedStore);
    expect(second.executeDeps.eventBus).toBe(deps.eventBus);
    expect(second.executeDeps.db).toBe(deps.db);
    expect(second.executeDeps.enrichmentStore).toBe(deps.enrichmentStore);
    expect(second.executeDeps.commitStore).toBe(deps.commitStore);
    expect(second.executeDeps.checkpointStore).toBe(deps.checkpointStore);
  });
});

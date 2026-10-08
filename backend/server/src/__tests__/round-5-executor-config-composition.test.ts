/** Round 5 executorConfig surgical extraction: boot composition. */

import BetterSqlite3 from 'better-sqlite3';
import type {
  ConnectionAuth,
  ConnectionKind,
  ConnectionRow,
  PreparePreapproval,
  PreapprovalResult,
  StepMeta,
} from '@recued/contracts';
import type {
  ConnectionNotificationHandlerDeps,
  KernelDispatchers,
} from '@recued/ingredients';
import type {
  LLMConfig,
  QuotaTracker,
} from '@recued/llm';
import type { AuditLogStore } from '@recued/storage';
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { CollectionRegistry } from '../collections/registry.js';
import type { FileStack } from '../collections/file/compose.js';
import type { RemoteFileReadDeps } from '../collections/file/remote-file-byte-resolver.js';
import type { CalendarStack } from '../collections/calendar/compose.js';
import type { AnnotationRpcDeps } from '../annotation-handler.js';
import type { HousekeepingStateStore } from '../housekeeping/index.js';
import type { ConnectionLookup } from '../housekeeping/reconciliation/vendor-reconciler.js';
import type { KeyManager, KeyManagerState } from '../key-manager.js';
import type { LLMConfigManager } from '../llm-config.js';
import type { ManifestRegistry } from '../manifest-loader.js';
import type {
  NotificationChannel,
  NotificationChannelDispatcher,
} from '../notification-handler.js';
import type { ServerExecutorConfig } from '../server-executor.js';
import type { AnnotationStore } from '../storage/annotation-store.js';
import { createAnnotationStore } from '../storage/annotation-store.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createMailSendClaimStore } from '../storage/mail-send-claim-store.js';
import { createKernelAdapter } from '@recued/ingredients';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CacheStore } from '@recued/cache';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';
import type { ContactStore } from '../storage/contact-store.js';
import type { EngagementRateControlStore } from '../storage/engagement-rate-control-store.js';
import type { EnrichmentStore } from '../storage/enrichment-store.js';
import type { SharedStore } from '../storage/shared-store.js';
import type { BlobStore } from '../storage/blob-store.js';
import type { FormResponseStore } from '../storage/form-response-store.js';
import { createMailFactStore } from '../storage/mail-fact-store.js';
import type { createWatcherDispatcher } from '../watchers/index.js';
import type { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import type {
  ComposeExecutorConfigDeps,
  composeExecutorConfig as ComposeExecutorConfig,
} from '../composition/bin/wire-executor-config.js';

type TestConnectionStore = ConnectionStoreSqlite & {
  upsert: ReturnType<typeof vi.fn>;
};
type TestKeyManager = KeyManager & {
  state: ReturnType<typeof vi.fn>;
  keyProvider: ReturnType<typeof vi.fn>;
};
type TestLlmManager = LLMConfigManager & {
  isOverBudget: ReturnType<typeof vi.fn>;
  addUsage: ReturnType<typeof vi.fn>;
};
type WorkEntityDispatchers = ReturnType<typeof createWorkEntityDispatchers>;

const Database = { default: BetterSqlite3 };
const NOW = Date.parse('2026-05-23T12:00:00.000Z');
const cleanups: Array<() => void> = [];

const mockedModulePaths = [
  '../connection-handler.js',
  '../shared-handler.js',
  '../collections/collection-handler.js',
  '../contact-business-context.js',
  '../contact-handler.js',
  '../mail-thread-handler.js',
  '../mail-body-read-handler.js',
  '../collections/file/file-read-handler.js',
  '../collections/file/markdown-template-render-handler.js',
  '../annotation-handler.js',
  '../timeline-recipe-handler.js',
  '../enrichment-handler.js',
  '../mail-get-handler.js',
  '../notification-handler.js',
] as const;

const alwaysTopLevelKeys = [
  'cacheMaxBytes',
  'cacheStore',
  'checkTokenBudget',
  'instanceId',
  'kernelDispatchers',
  'llmConfig',
  'llmQuota',
  'manifests',
  'onTokenUsage',
  'resolveLlmConfig',
  // D-250 § D — ALWAYS top-level, and deliberately not conditional like the
  // two hooks above it. Those feed the daily budget counter, which lives on
  // `llmManager` and is meaningless without it; this feeds an AUDIT field
  // wanted on every server that runs recipes — including one with no budget
  // configured, which is the default. `composeExecutorConfig` builds it per
  // config when the caller supplies none, so it is never absent.
  'runTokenUsage',
  'vault',
] as const;

const conditionalTopLevelKeys = [
  'auditLog',
  'connectionApi',
  'connectionMcp',
  'connectionNotification',
  'connectionStore',
] as const;

const alwaysKernelKeys = [
  'preapprovalRequest',
  'mailDraft',
  // D-264 — wired unconditionally for the same reason `mailDraft` is: the
  // dispatcher looks the owner service up per call, so there is nothing to gate
  // the WIRING on. A server with no mail stack leaves the underlying
  // `mailDraftSaveToMailbox` dep absent and the call raises rather than the key
  // vanishing from this shape.
  'mailDraftSaveToMailbox',
  'collectionGet',
  'collectionList',
  'collectionSearch',
  // D-244 — the CSV ops, wired unconditionally alongside the other file
  // primitives. They act on a file the caller already named, so there is no
  // capability to gate the WIRING on; like the mail four below, the dispatcher
  // fails closed at call time if the underlying store is absent. (`csvFilter`
  // saves its matches as a new record, a write; `csvRows` is its reading twin.)
  'csvColumns',
  'csvFilter',
  'csvRows',
  'csvStats',
  // D-315 slice 7 — `ics-read`, wired with the CSV ops for their reason: it
  // reads a file the caller already named, and fails closed at call time if
  // the store is absent.
  'icsRead',
  'filePersist',
  'filePutRef',
  // D-274 — the READ sibling of filePersist, always wired for the same
  // reason: it reads a temp ref the caller's own run already produced, so
  // there is no capability to gate the wiring on.
  'fileReadTemp',
  'fileSetScanStatus',
  // D-239 — the mail write-back four. Always-present ON PURPOSE: the
  // capability question ("may this mailbox be written?") belongs to the
  // ENROLLMENT and is answered by the dispatcher's `mutationCapable` gate.
  // Gating the WIRING on it instead would surface a read-only mailbox as
  // SERVER_NOT_REACHABLE — "your server is unreachable" for a server that is
  // right here and simply was not granted write access.
  'mailDelete',
  'mailFlag',
  'mailGet',
  'mailMark',
  'mailMove',
  'mailSend',
  // D-207 3d·2d — the no-resend mail-claim reconciler is wired always-present
  // alongside mailSend (baseline repair: the census lagged that commit).
  'mailSentReconcile',
  'mailThreadRead',
  'notificationSend',
  'watcher',
] as const satisfies readonly (keyof KernelDispatchers)[];

const sharedKernelKeys = [
  'compareAndSet',
  'delete',
  'deletePrefix',
  'list',
  'read',
  'search',
  'write',
] as const satisfies readonly (keyof KernelDispatchers)[];

const annotationKernelKeys = [
  'annotationCreate',
  'linkCreate',
  'annotationList',
  'annotationSearch',
  'linkList',
  'annotationDelete',
  'linkDelete',
] as const satisfies readonly (keyof KernelDispatchers)[];

const enrichmentKernelKeys = [
  'enrichmentList',
  'enrichmentUpsert',
] as const satisfies readonly (keyof KernelDispatchers)[];

const customerAccessKernelKeys = [
  'customerAccessIssue',
  'customerAccessExtend',
  'customerAccessSwapTier',
  'customerAccessClose',
] as const satisfies readonly (keyof KernelDispatchers)[];

const sellerOfferKernelKeys = [
  'sellerOfferEnsure',
  'sellerOfferFulfillmentAttach',
  'sellerOfferGet',
  'sellerOfferList',
] as const satisfies readonly (keyof KernelDispatchers)[];

// D-196 §4.5 — gated with the offer group on `sellerStore` presence.
const sellerTierKernelKeys = [
  'sellerTierGet',
  'sellerTierList',
] as const satisfies readonly (keyof KernelDispatchers)[];

const keySet = (value: object): string[] => Object.keys(value).sort();

const makeDb = (): BetterSqlite3.Database => {
  const db = Database.default(':memory:');
  cleanups.push(() => db.close());
  return db;
};

const manifestRegistry = (): ManifestRegistry => ({
  get: vi.fn(() => null),
  size: vi.fn(() => 0),
  slugs: vi.fn(() => []),
  register: vi.fn(),
  unregister: vi.fn(() => false),
});

const collectionRegistry = (): CollectionRegistry => ({
  register: vi.fn(),
  get: vi.fn(() => undefined),
  unregister: () => false,
  list: vi.fn(() => []),
  dispose: vi.fn(async () => undefined),
});

const blobStore = (): BlobStore => ({
  get: vi.fn(async () => null),
  put: vi.fn(async () => 'hash'),
  has: vi.fn(async () => false),
  delete: vi.fn(async () => undefined),
  sizeOf: vi.fn(async () => null),
  sweepOrphans: vi.fn(async () => 0),
  totalBytes: vi.fn(async () => 0),
  root: '/tmp/blobs',
}) as unknown as BlobStore;

// D-192 remote byte-fetch — a stub `remote` bundle. The dispatcher only forwards
// it by identity to the (mocked) `handleFileRead`, so the internals are inert.
const remoteFileReadDeps = (): RemoteFileReadDeps => ({
  fileMetaStore: {} as unknown as RemoteFileReadDeps['fileMetaStore'],
  resolveConnection: (async () => null) as RemoteFileReadDeps['resolveConnection'],
  byteResolvers: {},
});

const connectionStore = (): TestConnectionStore => ({
  upsert: vi.fn((input) => ({
    pk: `${input.kind}:${input.name}`,
    ...input,
  })),
  get: vi.fn(() => null),
  list: vi.fn(() => []),
  listSince: vi.fn(() => []),
  delete: vi.fn(() => false),
  count: vi.fn(() => 0),
  addOnUpsert: vi.fn(() => vi.fn()),
  addOnDelete: vi.fn(() => vi.fn()),
}) as unknown as TestConnectionStore;

const keyManager = (
  stateValue: KeyManagerState,
  provider: () => Uint8Array | null = vi.fn(() => new Uint8Array([1, 2, 3])),
): TestKeyManager => ({
  state: vi.fn(() => stateValue),
  init: vi.fn(),
  unlock: vi.fn(),
  lock: vi.fn(),
  getSubDEK: vi.fn(() => new Uint8Array([1, 2, 3])),
  keyProvider: vi.fn(() => provider),
  rotatePassword: vi.fn(),
  touch: vi.fn(),
}) as unknown as TestKeyManager;

const llmManager = (): TestLlmManager => ({
  isOverBudget: vi.fn((expected: number) => expected > 100),
  addUsage: vi.fn(),
}) as unknown as TestLlmManager;

const connectionNotificationDeps = (): ConnectionNotificationHandlerDeps =>
  ({
    decodeAuth: vi.fn(async () => ({ type: 'none' })),
  }) as unknown as ConnectionNotificationHandlerDeps;

const connectionRow = (
  overrides: Partial<ConnectionRow> = {},
): ConnectionRow => ({
  pk: 'api:crm',
  kind: 'api',
  name: 'crm',
  display_name: 'CRM',
  config_json: '{}',
  auth_ciphertext: 'stored-auth',
  enrolled_at: 1,
  updated_at: 2,
  ...overrides,
});

const baseVault = () => ({ TOKEN: 'server-token' });
const cacheStore = (): CacheStore => ({}) as unknown as CacheStore;
const quotaTracker = (): QuotaTracker => ({}) as unknown as QuotaTracker;
const watcherDispatcher = (): ReturnType<typeof createWatcherDispatcher> =>
  vi.fn(async () => ({ status: 'ok' })) as unknown as ReturnType<typeof createWatcherDispatcher>;
const auditLog = (): AuditLogStore =>
  ({ logActivity: vi.fn(async () => undefined) }) as unknown as AuditLogStore;
const sharedStore = (): SharedStore => ({}) as unknown as SharedStore;
const formResponseStore = (): Pick<
  FormResponseStore,
  'findById' | 'list' | 'setLifecycleState'
> => ({
  findById: vi.fn(() => null),
  list: vi.fn(() => []),
  setLifecycleState: vi.fn(() => null),
});
const contactStore = (): ContactStore => ({}) as unknown as ContactStore;
const annotationDeps = (): AnnotationRpcDeps => ({}) as unknown as AnnotationRpcDeps;
const annotationStore = (): AnnotationStore => ({}) as unknown as AnnotationStore;
const enrichmentStore = (): EnrichmentStore => ({}) as unknown as EnrichmentStore;
const sellerStore = (): ComposeExecutorConfigDeps['sellerStore'] =>
  ({}) as unknown as ComposeExecutorConfigDeps['sellerStore'];
const contractStore = (): ComposeExecutorConfigDeps['contractStore'] =>
  ({}) as unknown as ComposeExecutorConfigDeps['contractStore'];
const inboundTokenStore = (): ComposeExecutorConfigDeps['inboundTokenStore'] =>
  ({}) as unknown as ComposeExecutorConfigDeps['inboundTokenStore'];
const housekeepingState = (): HousekeepingStateStore =>
  ({ get: vi.fn(() => null) }) as unknown as HousekeepingStateStore;
const engagementRateControlStore = (): EngagementRateControlStore =>
  ({ readUsage: vi.fn() }) as unknown as EngagementRateControlStore;
const notificationDispatchers = (): Record<NotificationChannel, NotificationChannelDispatcher> => ({
  slack: vi.fn(async () => ({ ok: true })),
  telegram: vi.fn(async () => ({ ok: true })),
  whatsapp: vi.fn(async () => ({ ok: true })),
  discord: vi.fn(async () => ({ ok: true })),
  email: vi.fn(async () => ({ ok: true })),
  // D-238 — Teams joined `NotificationChannel`; the Record is over the FULL
  // union, so a missing member is a compile error.
  teams: vi.fn(async () => ({ ok: true })),
  in_app: vi.fn(async () => ({ ok: true })),
});
const workEntityDispatchers = (): WorkEntityDispatchers => ({
  taskCreate: vi.fn(async () => ({ task: { id: 'task-1' } })),
} as unknown as WorkEntityDispatchers);

const stackWithDispatchers = (
  dispatchers: Partial<KernelDispatchers>,
): { kernelDispatchers: Partial<KernelDispatchers> } =>
  ({ kernelDispatchers: dispatchers });

const buildDeps = (
  overrides: Partial<ComposeExecutorConfigDeps> = {},
): ComposeExecutorConfigDeps => ({
  manifests: manifestRegistry(),
  baseVault: baseVault(),
  llmQuota: quotaTracker(),
  cacheStore: cacheStore(),
  cacheBlobs: undefined,
  serverInstanceId: 'server-instance-1',
  watcherDispatcher: watcherDispatcher(),
  collectionRegistry: collectionRegistry(),
  llmConfig: undefined,
  resolveLlmConfig: undefined,
  llmManager: undefined,
  connectionStore: undefined,
  auditLog: undefined,
  keys: undefined,
  connectionNotificationDeps: undefined,
  fileStack: undefined,
  calendarStack: undefined,
  serviceStack: undefined,
  sharedStore: undefined,
  formResponseStore: undefined,
  mailFactStore: undefined,
  contactStore: undefined,
  annotationDeps: undefined,
  db: undefined,
  annotationStore: undefined,
  enrichmentStore: undefined,
  // D-239 — the mail write-back's delete cascade.
  enrichmentCascade: undefined,
  readGrantResolver: undefined,
  notificationChannelDispatchers: undefined,
  housekeepingState: undefined,
  engagementRateControlStore: undefined,
  workEntityDispatchers: undefined,
  receptionProjectionWorkEntityStore: undefined,
  receptionProjectionContactDeps: undefined,
  receptionProjectionBookingStore: undefined,
  // D-210 WS3 — the intake→contact sealed-email resolver. Absent here: this
  // harness composes no reception intake substrate.
  resolveSealedVisitorEmail: undefined,
  sellerStore: undefined,
  sellerOrderStore: undefined,
  contractStore: undefined,
  inboundTokenStore: undefined,
  ...overrides,
});

const importFreshComposer = async (): Promise<typeof ComposeExecutorConfig> => {
  vi.resetModules();
  const mod = await import('../composition/bin/wire-executor-config.js');
  return mod.composeExecutorConfig;
};

const composeWith = async (
  overrides: Partial<ComposeExecutorConfigDeps> = {},
): Promise<{ config: ServerExecutorConfig; deps: ComposeExecutorConfigDeps }> => {
  const compose = await importFreshComposer();
  const deps = buildDeps(overrides);
  return { deps, config: await compose(deps) };
};

const expectAbsent = (target: object, keys: readonly string[]): void => {
  for (const key of keys) {
    expect(key in target).toBe(false);
  }
};

const expectPresentFunctions = (
  target: Partial<Record<keyof KernelDispatchers, unknown>>,
  keys: readonly (keyof KernelDispatchers)[],
): void => {
  for (const key of keys) {
    expect(key in target).toBe(true);
    expect(target[key]).toEqual(expect.any(Function));
  }
};

const kernelOf = (config: ServerExecutorConfig): KernelDispatchers => {
  expect(config.kernelDispatchers).toBeDefined();
  return config.kernelDispatchers!;
};

const importComposerWithConnectionMocks = async () => {
  vi.resetModules();
  const decodedAuth: ConnectionAuth = { type: 'bearer', token: 'decoded' };
  const decodeAuthFromStorageMock = vi.fn(async () => decodedAuth);
  const encodeAuthForStorageMock = vi.fn(async () => 'encoded-auth');

  vi.doMock('../connection-handler.js', () => ({
    decodeAuthFromStorage: decodeAuthFromStorageMock,
    encodeAuthForStorage: encodeAuthForStorageMock,
  }));

  const mod = await import('../composition/bin/wire-executor-config.js');
  return {
    compose: mod.composeExecutorConfig,
    decodedAuth,
    decodeAuthFromStorageMock,
    encodeAuthForStorageMock,
  };
};

const importComposerWithNotificationMock = async () => {
  vi.resetModules();
  const handleNotificationSendMock = vi.fn(async (
    _deps: { dispatchers: Partial<Record<NotificationChannel, NotificationChannelDispatcher>> },
    _args: unknown,
  ) => ({
    delivered_to: [],
    failed: ['slack'],
  }));

  vi.doMock('../notification-handler.js', () => ({
    handleNotificationSend: handleNotificationSendMock,
  }));

  const mod = await import('../composition/bin/wire-executor-config.js');
  return {
    compose: mod.composeExecutorConfig,
    handleNotificationSendMock,
  };
};

const importComposerWithKernelMocks = async () => {
  vi.resetModules();
  const mocks = {
    handleSharedWrite: vi.fn(async () => ({ ok: true, key: 'data.shared.a', bytes_written: 1 })),
    handleSharedRead: vi.fn(async () => ({ found: true, key: 'data.shared.a', value: 1 })),
    handleSharedList: vi.fn(async () => ({ entries: [] })),
    handleSharedSearch: vi.fn(async () => ({ matches: [] })),
    handleSharedDelete: vi.fn(async () => ({ ok: true, key: 'data.shared.a' })),
    handleSharedDeletePrefix: vi.fn(async () => ({ ok: true, prefix: 'data.shared.', deleted: 1 })),
    handleCollectionList: vi.fn(async () => ({ records: [{ id: 'record-1' }] })),
    handleCollectionGet: vi.fn(async () => ({ record: null })),
    handleCollectionSearch: vi.fn(async () => ({ matches: [] })),
    handleCollectionMailSend: vi.fn(async () => ({ source_id: 'message-1' })),
    handleContactUpsert: vi.fn(async () => ({ contact: { email: 'ada@example.test' } })),
    handleContactResolve: vi.fn(async () => ({
      contact_id: 'c1',
      confidence: 1,
      alternatives: [],
      contact: { email: 'ada@example.test' },
    })),
    resolveContactBusinessContext: vi.fn(async () => ({
      as_of: NOW,
      known_before_at: NOW,
      identity: {
        coverage: 'partial',
        resolved: true,
        known_before: true,
        authoritative: true,
        company_known: false,
        same_company: false,
        same_company_contact_count: 0,
      },
      deals: { active_count: 0, historical_count: 0, observed_count: 0, coverage: 'not_configured' },
      tasks: { active_count: 0, historical_count: 0, observed_count: 0, coverage: 'unavailable' },
      calendar: { active_count: 0, historical_count: 0, observed_count: 0, coverage: 'unavailable' },
      bookings: { active_count: 0, historical_count: 0, observed_count: 0, coverage: 'unavailable' },
      projects: { active_count: 0, historical_count: 0, observed_count: 0, coverage: 'unavailable' },
      level: 'known',
      active_families: [],
      historical_families: [],
    })),
    handleMailThreadRead: vi.fn(async () => ({ messages: [] })),
    handleLinkCreate: vi.fn(async () => ({ ok: true })),
    handleAnnotationCreate: vi.fn(async () => ({ annotation: { id: 'annotation-1' } })),
    handleAnnotationList: vi.fn(async () => ({ annotations: [] })),
    handleAnnotationSearch: vi.fn(async () => ({ matches: [] })),
    handleLinkList: vi.fn(async () => ({ links: [] })),
    handleAnnotationDelete: vi.fn(async () => ({ ok: true, deleted: 0 })),
    handleLinkDelete: vi.fn(async () => ({ ok: true, deleted: 0 })),
    handleTimelineReadFromRecipe: vi.fn(async () => ({ items: [], next_cursor: null })),
    handleEnrichmentUpsert: vi.fn(async () => ({ entry: { id: 'enrichment-1' } })),
    handleEnrichmentList: vi.fn(async () => ({ entries: [], next_cursor: null })),
    handleMailGet: vi.fn(async () => ({ record: null })),
    handleMailBodyRead: vi.fn(async () => ({ body: null, found: false, size_bytes: 0, truncated: false })),
    handleFileRead: vi.fn(async () => ({
      record_id: 'file:abc',
      bytes_b64: 'eA==',
      mime_type: 'text/plain',
      filename: 'x.txt',
      size_bytes: 1,
      blob_hash: '1'.repeat(64),
    })),
    handleMarkdownTemplateRender: vi.fn(async (
      _deps: { readFile(input: { record_id: string }): Promise<unknown> },
      _input: unknown,
    ) => ({
      file_ref: {
        backing: 'temp' as const,
        path: '/tmp/recued-run-scratch/run-1/op-1/rendered.md',
        mime_type: 'text/markdown',
        filename: 'rendered.md',
      },
      template_sha256: '1'.repeat(64),
      content_sha256: '2'.repeat(64),
      used_keys: [],
      missing_keys: [],
    })),
    handleNotificationSend: vi.fn(async () => ({ delivered_to: [], failed: [] })),
  };

  vi.doMock('../shared-handler.js', () => ({
    handleSharedWrite: mocks.handleSharedWrite,
    handleSharedRead: mocks.handleSharedRead,
    handleSharedList: mocks.handleSharedList,
    handleSharedSearch: mocks.handleSharedSearch,
    handleSharedDelete: mocks.handleSharedDelete,
    handleSharedDeletePrefix: mocks.handleSharedDeletePrefix,
  }));
  vi.doMock('../collections/collection-handler.js', () => ({
    handleCollectionList: mocks.handleCollectionList,
    handleCollectionGet: mocks.handleCollectionGet,
    handleCollectionSearch: mocks.handleCollectionSearch,
    handleCollectionMailSend: mocks.handleCollectionMailSend,
  }));
  vi.doMock('../contact-handler.js', () => ({
    handleContactUpsert: mocks.handleContactUpsert,
    handleContactResolve: mocks.handleContactResolve,
  }));
  vi.doMock('../contact-business-context.js', () => ({
    resolveContactBusinessContext: mocks.resolveContactBusinessContext,
  }));
  vi.doMock('../mail-thread-handler.js', () => ({
    handleMailThreadRead: mocks.handleMailThreadRead,
  }));
  vi.doMock('../annotation-handler.js', () => ({
    handleLinkCreate: mocks.handleLinkCreate,
    handleAnnotationCreate: mocks.handleAnnotationCreate,
    handleAnnotationList: mocks.handleAnnotationList,
    handleAnnotationSearch: mocks.handleAnnotationSearch,
    handleLinkList: mocks.handleLinkList,
    handleAnnotationDelete: mocks.handleAnnotationDelete,
    handleLinkDelete: mocks.handleLinkDelete,
  }));
  vi.doMock('../timeline-recipe-handler.js', () => ({
    handleTimelineReadFromRecipe: mocks.handleTimelineReadFromRecipe,
  }));
  vi.doMock('../enrichment-handler.js', () => ({
    handleEnrichmentUpsert: mocks.handleEnrichmentUpsert,
    handleEnrichmentList: mocks.handleEnrichmentList,
  }));
  vi.doMock('../mail-get-handler.js', () => ({
    handleMailGet: mocks.handleMailGet,
  }));
  vi.doMock('../mail-body-read-handler.js', () => ({
    handleMailBodyRead: mocks.handleMailBodyRead,
  }));
  vi.doMock('../collections/file/file-read-handler.js', () => ({
    handleFileRead: mocks.handleFileRead,
  }));
  vi.doMock('../collections/file/markdown-template-render-handler.js', () => ({
    handleMarkdownTemplateRender: mocks.handleMarkdownTemplateRender,
  }));
  vi.doMock('../notification-handler.js', () => ({
    handleNotificationSend: mocks.handleNotificationSend,
  }));

  const mod = await import('../composition/bin/wire-executor-config.js');
  return {
    compose: mod.composeExecutorConfig,
    mocks,
  };
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of mockedModulePaths) {
    vi.doUnmock(path);
  }
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe('composeExecutorConfig top-level shape', () => {
  it('keeps direct fields keyed and omits conditional top-level fields on the minimal path', async () => {
    const { config, deps } = await composeWith({
      cacheStore: undefined,
      llmConfig: undefined,
      llmManager: undefined,
    });

    expect(keySet(config)).toEqual([...alwaysTopLevelKeys].sort());
    expect(config.manifests).toBe(deps.manifests);
    expect(config.vault).toBe(deps.baseVault);
    expect('llmConfig' in config).toBe(true);
    expect(config.llmConfig).toBeUndefined();
    expect(config.llmQuota).toBe(deps.llmQuota);
    expect('checkTokenBudget' in config).toBe(true);
    expect(config.checkTokenBudget).toBeUndefined();
    expect('onTokenUsage' in config).toBe(true);
    expect(config.onTokenUsage).toBeUndefined();
    expect('cacheStore' in config).toBe(true);
    expect(config.cacheStore).toBeUndefined();
    expect(config.instanceId).toBe(deps.serverInstanceId);
    expect(config.cacheMaxBytes).toBe(1024 * 1024 * 1024);
    expect(kernelOf(config)).toBeDefined();
    expectAbsent(config, conditionalTopLevelKeys);
  });

  it('threads conditional top-level identities when their gates are present', async () => {
    const store = connectionStore();
    const log = auditLog();
    const notificationDeps = connectionNotificationDeps();
    const { config } = await composeWith({
      connectionStore: store,
      auditLog: log,
      connectionNotificationDeps: notificationDeps,
    });

    expect(config.connectionStore).toBe(store);
    expect(config.auditLog).toBe(log);
    expect(config.connectionApi).toEqual(expect.objectContaining({
      decodeAuth: expect.any(Function),
      persistAuth: expect.any(Function),
    }));
    expect(config.connectionMcp).toEqual(expect.objectContaining({
      decodeAuth: expect.any(Function),
      onPersistFailure: expect.any(Function),
      wsConnect: expect.any(Function),
      spawnStdioMcp: expect.any(Function),
    }));
    expect(config.connectionNotification).toBe(notificationDeps);
  });

  it('returns deterministic top-level and dispatcher key sets for identical inputs', async () => {
    const compose = await importFreshComposer();
    const deps = buildDeps({
      connectionStore: connectionStore(),
      auditLog: auditLog(),
      sharedStore: sharedStore(),
      contactStore: contactStore(),
      annotationDeps: annotationDeps(),
      db: makeDb(),
      annotationStore: annotationStore(),
      enrichmentStore: enrichmentStore(),
      workEntityDispatchers: workEntityDispatchers(),
    });

    const first = await compose(deps);
    const second = await compose(deps);

    expect(keySet(second)).toEqual(keySet(first));
    expect(keySet(kernelOf(second))).toEqual(keySet(kernelOf(first)));
  });
});

describe('composeExecutorConfig llmManager derivation', () => {
  it('keeps token hooks present and undefined when llmManager is absent', async () => {
    const { config } = await composeWith({ llmManager: undefined });

    expect('checkTokenBudget' in config).toBe(true);
    expect(config.checkTokenBudget).toBeUndefined();
    expect('onTokenUsage' in config).toBe(true);
    expect(config.onTokenUsage).toBeUndefined();
  });

  it('derives token hook callables that delegate to llmManager', async () => {
    const manager = llmManager();
    const { config } = await composeWith({ llmManager: manager });

    expect(config.checkTokenBudget?.(101)).toBe(true);
    expect(manager.isOverBudget).toHaveBeenCalledWith(101);
    config.onTokenUsage?.(37);
    expect(manager.addUsage).toHaveBeenCalledWith(37);
  });
});

describe('composeExecutorConfig connection handler block', () => {
  it('omits the connection block and does not consult keys when connectionStore is absent', async () => {
    const keys = keyManager('unlocked');
    const { config } = await composeWith({
      keys,
      connectionNotificationDeps: connectionNotificationDeps(),
    });

    expectAbsent(config, [
      'connectionStore',
      'connectionApi',
      'connectionMcp',
      'connectionNotification',
    ]);
    expect(keys.state).not.toHaveBeenCalled();
    expect(keys.keyProvider).not.toHaveBeenCalled();
  });

  it('passes no keyProvider to api and mcp auth helpers while keys are uninitialized', async () => {
    const {
      compose,
      decodedAuth,
      decodeAuthFromStorageMock,
      encodeAuthForStorageMock,
    } = await importComposerWithConnectionMocks();
    const keys = keyManager('uninitialized');
    const store = connectionStore();
    const config = await compose(buildDeps({ connectionStore: store, keys }));
    const row = connectionRow({ auth_ciphertext: 'ciphertext' });

    await expect(config.connectionApi?.decodeAuth(row)).resolves.toBe(decodedAuth);
    await expect(config.connectionMcp?.decodeAuth(row)).resolves.toBe(decodedAuth);
    await config.connectionApi?.persistAuth(row, { type: 'none' });

    expect(keys.state).toHaveBeenCalledTimes(2);
    expect(keys.keyProvider).not.toHaveBeenCalled();
    expect(decodeAuthFromStorageMock).toHaveBeenNthCalledWith(
      1,
      'ciphertext',
      { kind: 'api', name: 'crm' },
      undefined,
    );
    expect(decodeAuthFromStorageMock).toHaveBeenNthCalledWith(
      2,
      'ciphertext',
      { kind: 'api', name: 'crm' },
      undefined,
    );
    expect(encodeAuthForStorageMock).toHaveBeenCalledWith(
      { type: 'none' },
      { kind: 'api', name: 'crm' },
      undefined,
    );
  });

  it.each([
    'locked',
    'unlocked',
  ] as const)('uses the connection keyProvider for %s keys in api and mcp handlers', async (stateValue) => {
    const {
      compose,
      decodeAuthFromStorageMock,
      encodeAuthForStorageMock,
    } = await importComposerWithConnectionMocks();
    const provider = vi.fn(() => new Uint8Array([9]));
    const keys = keyManager(stateValue, provider);
    const config = await compose(buildDeps({
      connectionStore: connectionStore(),
      keys,
    }));
    const row = connectionRow({ auth_ciphertext: 'ciphertext' });

    await config.connectionApi?.decodeAuth(row);
    await config.connectionMcp?.decodeAuth(row);
    await config.connectionApi?.persistAuth(row, { type: 'bearer', token: 'new' });

    expect(keys.state).toHaveBeenCalledTimes(2);
    expect(keys.keyProvider).toHaveBeenCalledTimes(2);
    expect(keys.keyProvider).toHaveBeenNthCalledWith(1, 'connection');
    expect(keys.keyProvider).toHaveBeenNthCalledWith(2, 'connection');
    expect(decodeAuthFromStorageMock).toHaveBeenNthCalledWith(
      1,
      'ciphertext',
      { kind: 'api', name: 'crm' },
      provider,
    );
    expect(decodeAuthFromStorageMock).toHaveBeenNthCalledWith(
      2,
      'ciphertext',
      { kind: 'api', name: 'crm' },
      provider,
    );
    expect(encodeAuthForStorageMock).toHaveBeenCalledWith(
      { type: 'bearer', token: 'new' },
      { kind: 'api', name: 'crm' },
      provider,
    );
  });

  it('persists refreshed auth with every optional connection row spread when fields are present', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { compose } = await importComposerWithConnectionMocks();
    const store = connectionStore();
    const config = await compose(buildDeps({ connectionStore: store }));
    const row = connectionRow({
      subtype: 'rest',
      publisher_id: 'hubspot',
      last_used_at: 123,
      health_json: '{"status":"ok"}',
    });

    await config.connectionApi?.persistAuth(row, { type: 'none' });

    expect(store.upsert).toHaveBeenCalledWith({
      kind: 'api',
      name: 'crm',
      subtype: 'rest',
      display_name: 'CRM',
      publisher_id: 'hubspot',
      config_json: '{}',
      auth_ciphertext: 'encoded-auth',
      enrolled_at: 1,
      updated_at: NOW,
      last_used_at: 123,
      health_json: '{"status":"ok"}',
    });
  });

  it('atomically merges a refreshed provider base URL without dropping connection config', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { compose } = await importComposerWithConnectionMocks();
    const store = connectionStore();
    const config = await compose(buildDeps({ connectionStore: store }));
    const row = connectionRow({
      config_json: JSON.stringify({
        vendor: 'pipedrive',
        base_url: 'https://old.pipedrive.com',
        cadence: '6h',
      }),
    });

    await config.connectionApi?.persistAuth(
      row,
      { type: 'bearer', token: 'fresh' },
      { base_url: 'https://new.pipedrive.com' },
    );

    const upsert = store.upsert.mock.calls[0]![0] as Record<string, unknown>;
    expect(JSON.parse(upsert.config_json as string)).toEqual({
      vendor: 'pipedrive',
      base_url: 'https://new.pipedrive.com',
      cadence: '6h',
    });
    expect(upsert.auth_ciphertext).toBe('encoded-auth');
  });

  it('audits an ignored provider runtime origin without recording response data', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { compose } = await importComposerWithConnectionMocks();
    const log = auditLog();
    const config = await compose(buildDeps({
      connectionStore: connectionStore(),
      auditLog: log,
    }));
    const row = connectionRow({
      config_json: JSON.stringify({ vendor: 'pipedrive' }),
    });

    config.connectionApi?.onRuntimeBaseIssue?.(row, {
      status: 'invalid',
      field: 'api_domain',
      reason: 'host is outside the provider allowlist',
    });

    expect(log.logActivity).toHaveBeenCalledWith(expect.objectContaining({
      timestamp: NOW,
      action: 'connection_runtime_base_refresh_ignored',
      target: 'crm',
      detail: JSON.stringify({
        kind: 'api',
        vendor: 'pipedrive',
        status: 'invalid',
        field: 'api_domain',
        reason: 'host is outside the provider allowlist',
      }),
    }));
    expect(JSON.stringify(vi.mocked(log.logActivity).mock.calls))
      .not.toContain('attacker.example');
  });

  // D-165 P3.path-picker — the api adapter's OAuth2-refresh write-back
  // restamps the whole row; a scoped connection must keep its
  // subresource_path so a 401-triggered refresh never silently widens
  // the permission boundary back to `/`.
  it('carries the connection subresource_path forward on refreshed-auth persistence', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { compose } = await importComposerWithConnectionMocks();
    const store = connectionStore();
    const config = await compose(buildDeps({ connectionStore: store }));
    const row = connectionRow({ subresource_path: '/photos' });

    await config.connectionApi?.persistAuth(row, { type: 'none' });

    const upsert = store.upsert.mock.calls[0]![0] as Record<string, unknown>;
    expect(upsert.subresource_path).toBe('/photos');
  });

  it('omits optional connection row spread keys when refreshed auth fields are absent', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { compose } = await importComposerWithConnectionMocks();
    const store = connectionStore();
    const config = await compose(buildDeps({ connectionStore: store }));

    await config.connectionApi?.persistAuth(connectionRow(), { type: 'none' });

    const upsert = store.upsert.mock.calls[0]![0] as Record<string, unknown>;
    expect(upsert).toEqual({
      kind: 'api',
      name: 'crm',
      display_name: 'CRM',
      config_json: '{}',
      auth_ciphertext: 'encoded-auth',
      enrolled_at: 1,
      updated_at: NOW,
    });
    expect('subtype' in upsert).toBe(false);
    expect('publisher_id' in upsert).toBe(false);
    expect('last_used_at' in upsert).toBe(false);
    expect('health_json' in upsert).toBe(false);
    // D-165 P3.path-picker — an unscoped row (no subresource_path) adds
    // nothing to the payload, so the column stays NULL rather than being
    // written as an explicit value.
    expect('subresource_path' in upsert).toBe(false);
  });
});

describe('composeExecutorConfig connectionNotification gating', () => {
  it.each([
    ['connectionStore and deps present', true, true, true],
    ['connectionStore present but deps absent', true, false, false],
    ['connectionStore absent but deps present', false, true, false],
  ] as const)('%s', async (_name, includeStore, includeDeps, shouldInclude) => {
    const notificationDeps = connectionNotificationDeps();
    const { config } = await composeWith({
      connectionStore: includeStore ? connectionStore() : undefined,
      connectionNotificationDeps: includeDeps ? notificationDeps : undefined,
    });

    expect('connectionNotification' in config).toBe(shouldInclude);
    if (shouldInclude) {
      expect(config.connectionNotification).toBe(notificationDeps);
    }
  });
});

describe('composeExecutorConfig kernel dispatcher shape', () => {
  it('uses the current pre-approval service after late composition and retains host execution metadata', async () => {
    let live: ReturnType<NonNullable<ComposeExecutorConfigDeps['getExecuteDeps']>>;
    const { config } = await composeWith({ getExecuteDeps: () => live });
    const request: PreparePreapproval = { idempotency_key: 'late-review',
      subject: { kind: 'recipe', recipe_id: 'reviewed-mail', publisher_id: 'core', config: {} },
      activation: { kind: 'one_shot', run_at: NOW + 60_000, time_zone: 'UTC' },
      decision_deadline: NOW + 30_000, dispatch_deadline: NOW + 120_000 };
    const meta: StepMeta = { step_id: 'review', execution_source: { channel: 'chat', actor: 'user_self',
      user_id: 'owner', chat_session_id: 'chat' }, entry_tool_name: 'recipe.run' };
    await expect(config.kernelDispatchers!.preapprovalRequest!(request, meta)).rejects.toThrow(/unavailable/);
    const pending: PreapprovalResult = { proposal_id: 'pap_review', future_execution_ref: 'paf_review',
      revision: 1, status: 'awaiting_owner', coverage: 'complete', eligible_members: 2, uncovered_calls: 0 };
    const handler = vi.fn(async () => pending);
    live = { preapprovalRequest: handler };
    expect(await config.kernelDispatchers!.preapprovalRequest!(request, meta)).toEqual(pending);
    expect(handler).toHaveBeenCalledExactlyOnceWith(request, meta);
    live = undefined;
    await expect(config.kernelDispatchers!.preapprovalRequest!(request, meta)).rejects.toThrow(/unavailable/);
  });
  it('keeps the always-present kernel dispatcher group and omits conditional groups on the minimal path', async () => {
    const { config } = await composeWith();
    const kernel = kernelOf(config);

    expect(keySet(kernel)).toEqual([...alwaysKernelKeys].sort());
    expectPresentFunctions(kernel, alwaysKernelKeys);
    expectAbsent(kernel, [
      ...sharedKernelKeys,
      'formResponseList',
      'formResponseGet',
      'formResponseSetState',
      'contactUpsert',
      'contactResolve',
      'contactBusinessContext',
      ...annotationKernelKeys,
      'timelineRead',
      ...enrichmentKernelKeys,
      ...sellerOfferKernelKeys,
      ...sellerTierKernelKeys,
      ...customerAccessKernelKeys,
      'taskCreate',
    ]);
  });

  it('spreads file and calendar stack dispatchers ahead of the built-in kernel group', async () => {
    const fileRead = vi.fn();
    const calendarList = vi.fn();
    const { config } = await composeWith({
      fileStack: stackWithDispatchers({ fileRead }) as FileStack,
      calendarStack: stackWithDispatchers({ calendarList }) as CalendarStack,
    });
    const kernel = kernelOf(config);

    expect(kernel.fileRead).toBe(fileRead);
    expect(kernel.calendarList).toBe(calendarList);
    expectPresentFunctions(kernel, alwaysKernelKeys);
  });

  it('gates the sharedStore dispatchers together', async () => {
    const withoutShared = kernelOf((await composeWith()).config);
    const withShared = kernelOf((await composeWith({ sharedStore: sharedStore() })).config);

    expectAbsent(withoutShared, sharedKernelKeys);
    expectPresentFunctions(withShared, sharedKernelKeys);
  });

  it('gates all form-response recipe dispatchers on the canonical store', async () => {
    const withoutStore = kernelOf((await composeWith()).config);
    expectAbsent(withoutStore, [
      'formResponseList',
      'formResponseGet',
      'formResponseSetState',
    ]);

    const record = { submission_id: 'submission-1', accepted_at: 2_000 } as never;
    const second = { submission_id: 'submission-0', accepted_at: 1_000 } as never;
    const store = formResponseStore();
    vi.mocked(store.findById).mockReturnValue(record);
    vi.mocked(store.list).mockReturnValue([record, second]);
    vi.mocked(store.setLifecycleState).mockReturnValue(record);
    const withStore = kernelOf((await composeWith({ formResponseStore: store })).config);

    expectPresentFunctions(withStore, [
      'formResponseList',
      'formResponseGet',
      'formResponseSetState',
    ]);
    await expect(withStore.formResponseList?.({ limit: 1, lifecycle_states: ['received'] }))
      .resolves.toEqual({
        records: [record],
        next_cursor: { accepted_at: 2_000, submission_id: 'submission-1' },
      });
    expect(store.list).toHaveBeenCalledWith({ limit: 2, lifecycle_states: ['received'] });
    await expect(
      withStore.formResponseGet?.({ submission_id: 'submission-1' }),
    ).resolves.toEqual({ record });
    expect(store.findById).toHaveBeenCalledWith('submission-1');
    await expect(withStore.formResponseSetState?.({
      submission_id: 'submission-1', lifecycle_state: 'accepted',
    })).resolves.toEqual({ record });
    expect(store.setLifecycleState).toHaveBeenCalledWith(
      'submission-1', 'accepted', expect.any(Number),
    );
  });

  it('gates the mail-fact read dispatchers on the store (D-315)', async () => {
    expectAbsent(kernelOf((await composeWith()).config), ['mailFactGet', 'mailFactList']);
    const db = new BetterSqlite3(':memory:');
    try {
      const kernel = kernelOf((await composeWith({ mailFactStore: createMailFactStore(db) })).config);
      expectPresentFunctions(kernel, ['mailFactGet', 'mailFactList']);
      await expect(kernel.mailFactGet?.({ id: 'mthing_x' })).resolves.toEqual({ thing: null, facts: [] });
      await expect(kernel.mailFactList?.({ of: 'things' })).resolves.toEqual({ records: [] });
    } finally {
      db.close();
    }
  });

  it('uses the same canonical store to complete a store-only reception approval', async () => {
    const record = {
      submission_id: 'submission-1',
      endpoint_id: 'endpoint-1',
      form_definition_id: 'client-intake',
    } as never;
    const store = formResponseStore();
    vi.mocked(store.findById).mockReturnValue(record);
    const kernel = kernelOf((await composeWith({ formResponseStore: store })).config);

    expectPresentFunctions(kernel, ['receptionMaterialize']);
    await expect(kernel.receptionMaterialize?.({
      top_tier_kind: 'form_response',
      id: 'submission-1',
      title: 'Client intake',
      metadata: {
        reception_form_submission_id: 'submission-1',
        reception_endpoint_id: 'endpoint-1',
        form_definition_id: 'client-intake',
      },
    })).resolves.toEqual({
      top_tier_kind: 'form_response',
      target_id: 'submission-1',
    });
    expect(store.findById).toHaveBeenCalledWith('submission-1');
  });

  it('gates file-content consumers and mailBodyRead on cacheBlobs presence', async () => {
    const withoutBlobs = kernelOf((await composeWith()).config);
    const withBlobs = kernelOf((await composeWith({ cacheBlobs: blobStore() })).config);

    expectAbsent(withoutBlobs, ['dataFileRead', 'markdownTemplateRender', 'mailBodyRead']);
    expectPresentFunctions(
      withBlobs,
      ['dataFileRead', 'markdownTemplateRender', 'mailBodyRead'],
    );
  });

  it('gates contact, annotation, enrichment, and work-entity dispatcher spreads independently', async () => {
    const work = workEntityDispatchers();
    const { config } = await composeWith({
      contactStore: contactStore(),
      annotationDeps: annotationDeps(),
      enrichmentStore: enrichmentStore(),
      workEntityDispatchers: work,
    });
    const kernel = kernelOf(config);

    expectPresentFunctions(kernel, [
      'contactUpsert',
      'contactResolve',
      'contactBusinessContext',
    ]);
    expectPresentFunctions(kernel, annotationKernelKeys);
    expectPresentFunctions(kernel, enrichmentKernelKeys);
    expect(kernel.taskCreate).toBe(work.taskCreate);
  });

  it('wires the read-only business context without enabling contact writes or general resolve', async () => {
    const { config } = await composeWith({
      businessContextContactStore: contactStore(),
    });
    const kernel = kernelOf(config);

    expectPresentFunctions(kernel, ['contactBusinessContext']);
    expectAbsent(kernel, ['contactUpsert', 'contactResolve']);
  });

  it('gates the customer-access lifecycle dispatcher group on all seller lifecycle stores', async () => {
    const missingToken = kernelOf((await composeWith({
      sellerStore: sellerStore(),
      contractStore: contractStore(),
    })).config);
    expectAbsent(missingToken, customerAccessKernelKeys);

    const { config } = await composeWith({
      sellerStore: sellerStore(),
      contractStore: contractStore(),
      inboundTokenStore: inboundTokenStore(),
    });
    expectPresentFunctions(kernelOf(config), customerAccessKernelKeys);
  });

  it('wires the core Seller offer registry from SellerStore alone', async () => {
    const offer = {
      offer_id: 'paid-document.outcome',
      kind: 'document' as const,
      display_name: 'Paid document',
      description: '',
      pricing_kind: 'unspecified' as const,
      amount_minor: null,
      currency: null,
      fulfillment_recipe_id: 'paid-document-origin',
      state: 'draft' as const,
      created_by_recipe_id: 'paid-document-setup',
      created_at: NOW,
      updated_at: NOW,
    };
    // A FULL tier row, private fields included — what the wiring's projection
    // must strip before the kernel result crosses into recipe state.
    const tier = {
      tier_id: 'tier_01',
      door_id: 'door_main',
      lifecycle_source: 'stripe' as const,
      entitlement_key: 'pro',
      display_name: 'Pro',
      template_contract_id: 'contract_template_pro',
      external_entitlement_id: 'feat_pro_123',
      usage_policy_json: {},
      pass_duration_seconds: null,
      customer_status_enabled_default: false,
      active: true,
      created_at: NOW,
      updated_at: NOW,
    };
    const publicTier = {
      entitlement_key: 'pro',
      display_name: 'Pro',
      lifecycle_source: 'stripe',
      external_entitlement_id: 'feat_pro_123',
      pass_duration_seconds: null,
      active: true,
    };
    const seller = {
      ensureOffer: vi.fn(() => ({ result: 'created' as const, offer })),
      attachOfferFulfillmentRecipe: vi.fn(() => ({
        result: 'unchanged' as const,
        offer,
      })),
      getOffer: vi.fn(() => offer),
      listOffers: vi.fn(() => [offer]),
      findTier: vi.fn(() => tier),
      listTiers: vi.fn(() => [tier]),
    } as unknown as NonNullable<ComposeExecutorConfigDeps['sellerStore']>;
    const now = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    cleanups.push(() => now.mockRestore());

    const kernel = kernelOf((await composeWith({ sellerStore: seller })).config);
    expectPresentFunctions(kernel, sellerOfferKernelKeys);
    expectPresentFunctions(kernel, sellerTierKernelKeys);
    expectAbsent(kernel, customerAccessKernelKeys);

    await expect(kernel.sellerOfferEnsure?.({
      offer_id: offer.offer_id,
      kind: offer.kind,
      display_name: offer.display_name,
      pricing_kind: offer.pricing_kind,
      fulfillment_recipe_id: offer.fulfillment_recipe_id,
      created_by_recipe_id: offer.created_by_recipe_id!,
    })).resolves.toEqual({ result: 'created', offer });
    expect(seller.ensureOffer).toHaveBeenCalledWith(expect.objectContaining({
      offer_id: offer.offer_id,
      now: NOW,
    }));
    await expect(kernel.sellerOfferFulfillmentAttach?.({
      offer_id: offer.offer_id,
      recipe_id: offer.created_by_recipe_id!,
    })).resolves.toEqual({ result: 'unchanged', offer });
    expect(seller.attachOfferFulfillmentRecipe).toHaveBeenCalledWith({
      offer_id: offer.offer_id,
      recipe_id: offer.created_by_recipe_id,
      now: NOW,
    });
    await expect(kernel.sellerOfferGet?.({ offer_id: offer.offer_id }))
      .resolves.toEqual({ offer });
    await expect(kernel.sellerOfferList?.({ state: 'draft' }))
      .resolves.toEqual({ offers: [offer] });

    // D-196 §4.5 — the REAL wiring must project the full store row down to the
    // public terms. `toEqual` is exact: were `template_contract_id` or
    // `tier_id` to ride through, this fails — the I-1 fence at the gate that
    // enforces it, not a mock of it.
    await expect(kernel.sellerTierGet?.({
      lifecycle_source: 'stripe',
      door_id: 'door_main',
      entitlement_key: 'pro',
    })).resolves.toEqual({ tier: publicTier });
    expect(seller.findTier).toHaveBeenCalledWith({
      lifecycle_source: 'stripe',
      door_id: 'door_main',
      entitlement_key: 'pro',
    });
    await expect(kernel.sellerTierList?.({ door_id: 'door_main' }))
      .resolves.toEqual({ tiers: [publicTier] });
    expect(seller.listTiers).toHaveBeenCalledWith({ door_id: 'door_main' });
  });

  it.each([
    ['db absent', { annotationStore: annotationStore(), auditLog: auditLog() }],
    ['annotationStore absent', { db: makeDb(), auditLog: auditLog() }],
    ['auditLog absent', { db: makeDb(), annotationStore: annotationStore() }],
  ] as const)('omits timelineRead when %s', async (_name, overrides) => {
    const { config } = await composeWith(overrides);

    expect('timelineRead' in kernelOf(config)).toBe(false);
  });

  it('⛔⛔ D-234 § 234.4 — the peer ASK op REACHES a dispatcher when db is wired', async () => {
    // THREADING THIS IS THE WHOLE FEATURE. `createKernelAdapter` refuses an
    // unwired slug with `SERVER_NOT_REACHABLE`, so `core.peer.ask` can sit in the
    // registry, pass its ratchets, and reach nothing at all — the exact shape of
    // D-231's inert `data.memory` resolver and of the four things D-232 built,
    // typed, tested and left unreachable in one session, all green.
    // ⚠ § 234.4j removed `exposePeer` / `revokePeer` / `listPeerExposures` from
    // this list WITH the ops behind them. A name dropped from an expectation is
    // indistinguishable from one never asserted, so it is written down here.
    const { config } = await composeWith({ db: makeDb() });
    expectPresentFunctions(kernelOf(config), [
      // D-234 § 234.4 slice 6 — `peerAsk` is the one that makes the whole pause
      // substrate reachable. Without it a recipe naming `core.peer.ask` gets
      // `SERVER_NOT_REACHABLE`, and the signal / re-throw / step-loop catch /
      // `awaiting_peer` chain is unreachable code that every test still passes,
      // because every test builds its own adapter.
      'peerAsk',
    ]);
  });

  it('⚠ and are ABSENT without a db rather than pretending', async () => {
    // A dbless harness has nowhere to record an answer. Refusing is the safe
    // direction for a surface that suspends a run waiting on one: a dispatcher
    // that accepted the call and dropped it would report success for a question
    // nobody will ever answer.
    const { config } = await composeWith({ db: undefined });
    expectAbsent(kernelOf(config), [
      'peerAsk',
    ]);
  });

  it('includes timelineRead only when db, annotationStore, and auditLog are all present', async () => {
    const { config } = await composeWith({
      db: makeDb(),
      annotationStore: annotationStore(),
      auditLog: auditLog(),
    });

    expectPresentFunctions(kernelOf(config), ['timelineRead']);
  });
});

describe('composeExecutorConfig kernel dynamic imports', () => {
  it('resolves every non-reconciler handler import and forwards the expected deps', async () => {
    const { compose, mocks } = await importComposerWithKernelMocks();
    const businessContextWorkEntities = {} as NonNullable<
      ComposeExecutorConfigDeps['businessContextWorkEntityStore']
    >;
    const businessContextCalendars = {} as NonNullable<
      ComposeExecutorConfigDeps['businessContextCalendars']
    >;
    const businessContextCrmMirror = {} as NonNullable<
      ComposeExecutorConfigDeps['businessContextCrmMirrorStore']
    >;
    const getBoundCrmSources = vi.fn(() => []);
    const deps = buildDeps({
      sharedStore: sharedStore(),
      contactStore: contactStore(),
      businessContextWorkEntityStore: businessContextWorkEntities,
      businessContextCalendars,
      businessContextCrmMirrorStore: businessContextCrmMirror,
      getBoundCrmSources,
      annotationDeps: annotationDeps(),
      db: makeDb(),
      annotationStore: annotationStore(),
      auditLog: auditLog(),
      enrichmentStore: enrichmentStore(),
      notificationChannelDispatchers: notificationDispatchers(),
    });
    const kernel = kernelOf(await compose(deps));

    await kernel.write?.({ key: 'data.shared.a', value: 1, ttl: 60 });
    await kernel.read?.({ key: 'data.shared.a' });
    await kernel.list?.({ prefix: 'data.shared.' });
    await kernel.search?.({ scope: 'data.shared', query: 'ada' });
    await kernel.delete?.({ key: 'data.shared.a' });
    await kernel.deletePrefix?.({ prefix: 'data.shared.' });
    await kernel.collectionList?.({ platform: 'mail', slug: 'work', limit: 3 });
    await kernel.collectionGet?.({ platform: 'mail', slug: 'work', record_id: 'm1' });
    await kernel.collectionSearch?.({ platform: 'mail', slug: 'work', query: 'ada' });
    await kernel.contactUpsert?.({
      email: 'ada@example.test',
      display_name: 'Ada',
      first_seen: NOW - 10,
      last_interaction: NOW,
    });
    await kernel.contactResolve?.({ email: 'ada@example.test' });
    await kernel.contactBusinessContext?.({
      email: 'ada@example.test',
      as_of: NOW,
      known_before_at: NOW,
    });
    await kernel.mailThreadRead?.({ slug: 'work', thread_id: 'thread-1' });
    await kernel.linkCreate?.({
      from_collection: 'data.mail',
      from_id: 'm1',
      to_collection: 'data.contact',
      to_id: 'c1',
      role: 'thread_participant',
    } as never);
    await kernel.annotationCreate?.({
      collection: 'data.mail',
      id: 'm1',
      key: 'summary',
      value: { text: 'hello' },
    } as never);
    await kernel.annotationList?.({ target_collection: 'data.mail', target_id: 'm1' });
    await kernel.annotationSearch?.({ query: 'hello', key: 'summary' });
    await kernel.linkList?.({ from_collection: 'data.mail', from_id: 'm1' });
    await kernel.annotationDelete?.({ key: 'summary', authored_by_recipe_id: 'r1' });
    await kernel.linkDelete?.({ role: 'thread_participant' });
    await kernel.timelineRead?.({
      scope: 'contact',
      target_id: 'c1',
    } as never);
    await kernel.enrichmentUpsert?.({
      scope: 'contact',
      target_id: 'c1',
      kind: 'profile',
      value: { name: 'Ada' },
    } as never);
    await kernel.enrichmentList?.({
      scope: 'contact',
      target_id: 'c1',
      trigger_source: 'mcp',
    } as never);
    await kernel.mailGet?.({ slug: 'work', record_id: 'm1' });
    await kernel.mailSend?.({
      instance: 'work',
      to: ['ada@example.test'],
      subject: 'Hello',
      body_text: 'Hi',
    });
    await kernel.notificationSend?.({
      channels: ['slack'],
      text: 'Heads up',
    });

    expect(mocks.handleSharedWrite).toHaveBeenCalledWith(
      { store: deps.sharedStore },
      { key: 'data.shared.a', value: 1 },
    );
    expect(mocks.handleSharedRead).toHaveBeenCalledWith(
      { store: deps.sharedStore },
      { key: 'data.shared.a' },
    );
    expect(mocks.handleCollectionList).toHaveBeenCalledWith(
      { registry: deps.collectionRegistry },
      { platform: 'mail', slug: 'work', filters: undefined, since: undefined, until: undefined, limit: 3 },
    );
    expect(mocks.handleContactUpsert).toHaveBeenCalledWith(
      // D-177 N.11 rule 1 — the kernel closure IS the engine path, so it
      // statically stamps the 'engine' write surface alongside the store.
      { store: deps.contactStore, origin_surface: 'engine' },
      {
        email: 'ada@example.test',
        name: 'Ada',
        first_seen: NOW - 10,
        last_interaction: NOW,
      },
    );
    expect(mocks.handleContactResolve).toHaveBeenCalledWith(
      { store: deps.contactStore },
      { email: 'ada@example.test' },
    );
    expect(mocks.resolveContactBusinessContext).toHaveBeenCalledWith(
      {
        contacts: deps.contactStore,
        workEntities: businessContextWorkEntities,
        calendars: businessContextCalendars,
        crmMirror: businessContextCrmMirror,
        getBoundCrmSources,
      },
      { email: 'ada@example.test', as_of: NOW, known_before_at: NOW },
    );
    expect(mocks.handleLinkCreate).toHaveBeenCalledWith(
      // D-177 N.11 rule 1 — link writes stamp the 'engine' surface too
      // (codex LOW fold; links stay ungated, the facet reads truthfully).
      { ...deps.annotationDeps, origin_surface: 'engine' },
      expect.objectContaining({ from_id: 'm1', to_id: 'c1' }),
    );
    // The three reads get the annotation deps AS WIRED — a read stamps nothing,
    // so no origin facet rides along (contrast the two writes above).
    expect(mocks.handleAnnotationList).toHaveBeenCalledWith(
      deps.annotationDeps,
      { target_collection: 'data.mail', target_id: 'm1' },
    );
    expect(mocks.handleAnnotationSearch).toHaveBeenCalledWith(
      deps.annotationDeps,
      { query: 'hello', key: 'summary' },
    );
    expect(mocks.handleLinkList).toHaveBeenCalledWith(
      deps.annotationDeps,
      { from_collection: 'data.mail', from_id: 'm1' },
    );
    // The deletes forward what the kernel adapter hands them; their SCOPE is
    // decided there (an annotation delete arrives pinned to its recipe).
    expect(mocks.handleAnnotationDelete).toHaveBeenCalledWith(
      deps.annotationDeps,
      { key: 'summary', authored_by_recipe_id: 'r1' },
    );
    expect(mocks.handleLinkDelete).toHaveBeenCalledWith(
      deps.annotationDeps,
      { role: 'thread_participant' },
    );
    expect(mocks.handleTimelineReadFromRecipe).toHaveBeenCalledWith(
      {
        // D-187 AMENDMENT — the recipe-channel timeline resolves the bound contract's
        // read-grant checker per-dispatch; with no wired grant resolver (this fixture
        // passes `readGrantResolver: undefined`) it sets no checker and the timeline's
        // own fallback applies the author-default checker (registry defaults).
        timelineDeps: expect.objectContaining({
          db: deps.db,
          auditLog: deps.auditLog,
          annotationStore: deps.annotationStore,
          enrichmentStore: deps.enrichmentStore,
        }),
      },
      expect.objectContaining({ target_id: 'c1' }),
    );
    expect(mocks.handleEnrichmentList).toHaveBeenCalledWith(
      {
        store: deps.enrichmentStore,
        trigger_source: 'mcp',
      },
      expect.objectContaining({ target_id: 'c1', trigger_source: 'mcp' }),
    );
    expect(mocks.handleMailGet).toHaveBeenCalledWith(
      { registry: deps.collectionRegistry },
      { slug: 'work', record_id: 'm1' },
    );
    expect(mocks.handleCollectionMailSend).toHaveBeenCalledWith(
      { registry: deps.collectionRegistry },
      expect.objectContaining({ instance: 'work', subject: 'Hello' }),
    );
    expect(mocks.handleNotificationSend).toHaveBeenCalledWith(
      { dispatchers: deps.notificationChannelDispatchers },
      { channels: ['slack'], text: 'Heads up' },
    );
  });

  it('a fenced send that ends without an outcome asks the owner "Did this email go out?"', async () => {
    // The refusal/uncertain failure alone left the owner nothing on screen; the
    // dispatcher is where a recipe's send meets the late-bound notification block.
    const { compose, mocks } = await importComposerWithKernelMocks();
    const db = makeDb();
    const claims = createMailSendClaimStore(db);
    const { claim } = claims.claim({
      reconciliation_id: 'meeting-secretary.abc', sender_slug: 'work',
      recipient: 'ada@example.test', subject: 'Minutes', proof_kind: 'envelope', now: NOW,
    });
    claims.markUnknown({ reconciliation_id: 'meeting-secretary.abc', expected_revision: claim.revision, now: NOW + 1 });
    const notifier = {
      ask: vi.fn(async () => ({ ask_id: 'ask-1' })),
      listUnresolvedAsks: vi.fn(async () => []),
    };
    mocks.handleCollectionMailSend.mockRejectedValueOnce(new Error('smtp timeout'));
    const kernel = kernelOf(await compose(buildDeps({
      db,
      getExecuteDeps: () => ({ preflightNotifier: notifier }),
    })));

    await expect(kernel.mailSend?.({
      instance: 'work', to: ['ada@example.test'], subject: 'Minutes', body_text: 'Hi',
      reconciliation_id: 'meeting-secretary.abc',
    } as never)).rejects.toThrow('smtp timeout');

    expect(notifier.ask).toHaveBeenCalledTimes(1);
    expect(notifier.ask).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Did this email go out?' }),
      expect.any(Array),
      { kind: 'mail.send_outcome', payload: { reconciliation_id: 'meeting-secretary.abc', revision: 1 } },
    );

    // A send without the fence has nothing to ask about.
    mocks.handleCollectionMailSend.mockRejectedValueOnce(new Error('smtp timeout'));
    await expect(kernel.mailSend?.({
      instance: 'work', to: ['ada@example.test'], subject: 'Minutes', body_text: 'Hi',
    } as never)).rejects.toThrow('smtp timeout');
    expect(notifier.ask).toHaveBeenCalledTimes(1);
  });

  it('forwards the registry and blob store to handleMailBodyRead when cacheBlobs is present', async () => {
    const { compose, mocks } = await importComposerWithKernelMocks();
    const deps = buildDeps({ cacheBlobs: blobStore() });
    const kernel = kernelOf(await compose(deps));

    await kernel.mailBodyRead?.({ slug: 'work', record_id: 'm1', max_chars: 100 });

    expect(mocks.handleMailBodyRead).toHaveBeenCalledWith(
      { registry: deps.collectionRegistry, blobs: deps.cacheBlobs },
      { slug: 'work', record_id: 'm1', max_chars: 100 },
    );
  });

  it('forwards the registry, blob store, and audit log to handleFileRead when cacheBlobs is present', async () => {
    const { compose, mocks } = await importComposerWithKernelMocks();
    const deps = buildDeps({ cacheBlobs: blobStore(), auditLog: auditLog() });
    const kernel = kernelOf(await compose(deps));

    await kernel.dataFileRead?.({ record_id: 'file:abc' });

    expect(mocks.handleFileRead).toHaveBeenCalledWith(
      { registry: deps.collectionRegistry, blobs: deps.cacheBlobs, auditLog: deps.auditLog },
      { record_id: 'file:abc' },
    );
  });

  it('forwards the shared remote byte-fetch bundle to handleFileRead when getRemoteFileReadDeps yields one', async () => {
    const { compose, mocks } = await importComposerWithKernelMocks();
    const remote = remoteFileReadDeps();
    const deps = buildDeps({
      cacheBlobs: blobStore(),
      auditLog: auditLog(),
      getRemoteFileReadDeps: () => remote,
    });
    const kernel = kernelOf(await compose(deps));

    // A `file:remote:*` id now reaches the vendor byte fetch (channels 1 + 2 —
    // the recipe data-file-read ingredient AND the ai-* multimodal read that
    // dispatches through it) instead of `file_remote_unsupported`.
    await kernel.dataFileRead?.({ record_id: 'file:remote:AAA:BBB' });

    expect(mocks.handleFileRead).toHaveBeenCalledWith(
      { registry: deps.collectionRegistry, blobs: deps.cacheBlobs, auditLog: deps.auditLog, remote },
      { record_id: 'file:remote:AAA:BBB' },
    );
  });

  it('omits the remote bundle from handleFileRead when getRemoteFileReadDeps yields undefined (pre-byte-fetch posture)', async () => {
    const { compose, mocks } = await importComposerWithKernelMocks();
    const deps = buildDeps({
      cacheBlobs: blobStore(),
      auditLog: auditLog(),
      getRemoteFileReadDeps: () => undefined,
    });
    const kernel = kernelOf(await compose(deps));

    await kernel.dataFileRead?.({ record_id: 'file:remote:AAA:BBB' });

    // An EXACT-shape match — a spread `remote` would make the deps object no
    // longer deep-equal the `{ registry, blobs, auditLog }` triple, so this
    // asserts the bundle is absent (a remote id then 501s via handleFileRead).
    expect(mocks.handleFileRead).toHaveBeenCalledWith(
      { registry: deps.collectionRegistry, blobs: deps.cacheBlobs, auditLog: deps.auditLog },
      { record_id: 'file:remote:AAA:BBB' },
    );
  });

  it('wires the Markdown renderer to the same audited local file reader', async () => {
    const { compose, mocks } = await importComposerWithKernelMocks();
    const deps = buildDeps({ cacheBlobs: blobStore(), auditLog: auditLog() });
    const kernel = kernelOf(await compose(deps));
    const input = {
      template_file_ref: `file:${'a'.repeat(32)}`,
      values: { 'response.name': 'Ada' },
      strict: true as const,
      run_id: 'run-1',
    };

    await kernel.markdownTemplateRender?.(input);

    expect(mocks.handleMarkdownTemplateRender).toHaveBeenCalledWith(
      { readFile: expect.any(Function) },
      input,
    );
    const rendererDeps = mocks.handleMarkdownTemplateRender.mock.calls[0]?.[0] as {
      readFile(input: { record_id: string }): Promise<unknown>;
    };
    await rendererDeps.readFile({ record_id: input.template_file_ref });
    expect(mocks.handleFileRead).toHaveBeenCalledWith(
      { registry: deps.collectionRegistry, blobs: deps.cacheBlobs, auditLog: deps.auditLog },
      { record_id: input.template_file_ref },
    );
  });

  it('threads the remote byte-fetch bundle into the Markdown renderer file reader too', async () => {
    const { compose, mocks } = await importComposerWithKernelMocks();
    const remote = remoteFileReadDeps();
    const deps = buildDeps({
      cacheBlobs: blobStore(),
      auditLog: auditLog(),
      getRemoteFileReadDeps: () => remote,
    });
    const kernel = kernelOf(await compose(deps));

    await kernel.markdownTemplateRender?.({
      template_file_ref: 'file:remote:AAA:BBB',
      values: {},
      strict: true as const,
      run_id: 'run-1',
    });
    const rendererDeps = mocks.handleMarkdownTemplateRender.mock.calls[0]?.[0] as {
      readFile(input: { record_id: string }): Promise<unknown>;
    };
    await rendererDeps.readFile({ record_id: 'file:remote:AAA:BBB' });
    expect(mocks.handleFileRead).toHaveBeenCalledWith(
      { registry: deps.collectionRegistry, blobs: deps.cacheBlobs, auditLog: deps.auditLog, remote },
      { record_id: 'file:remote:AAA:BBB' },
    );
  });

  it('passes an empty dispatcher object to notificationSend when channel dispatchers are undefined', async () => {
    const { compose, handleNotificationSendMock } = await importComposerWithNotificationMock();
    const kernel = kernelOf(await compose(buildDeps({
      notificationChannelDispatchers: undefined,
    })));

    await kernel.notificationSend?.({ channels: ['slack'], text: 'Heads up' });

    expect(handleNotificationSendMock).toHaveBeenCalledTimes(1);
    const callDeps = handleNotificationSendMock.mock.calls[0]![0];
    expect(callDeps).toEqual({ dispatchers: {} });
    expect(callDeps.dispatchers).toEqual({});
  });
});

/** ⛔⛔ THE READS WERE DECLARED, UNIT-TESTED AND UNREACHABLE. `kernel-annotation.test.ts`
 *  hands the kernel adapter its OWN `annotationList` / `annotationSearch` / `linkList`,
 *  so it passed while this composition root supplied none, and every real run of
 *  `annotation-list`, `annotation-search` or `link-list` failed "unavailable". This
 *  drives the REAL composition root over a REAL store through the REAL kernel adapter,
 *  with no double anywhere on the path, so dropping the wiring again goes red here. */
describe('annotation + link reads reach a real store through the composition root', () => {
  it('annotation-list, annotation-search and link-list return what the store holds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'round5-annotation-reads-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = createAnnotationStore({ db: makeDb(), blobs: createBlobStore(join(dir, 'blobs')) });
    await store.annotate({
      target_collection: 'data.mail', target_id: 'm1', key: 'summary',
      value: 'Invoice from Acme', authored_by_recipe_id: 'r1', source_record_hash: 'h1',
    });
    await store.link({
      from_collection: 'data.mail', from_id: 'm1', to_collection: 'data.contact', to_id: 'c1',
      role: 'thread_participant', authored_by_recipe_id: 'r1',
    });
    const { config } = await composeWith({ annotationDeps: { store } });
    const adapter = createKernelAdapter(kernelOf(config));
    const run = async (slug: string, input: Record<string, unknown>) =>
      await adapter({ slug, input } as never) as Record<string, Array<Record<string, unknown>>>;

    const listed = await run('annotation-list', { target_collection: 'data.mail', target_id: 'm1' });
    expect(listed.annotations!.map((a) => [a.key, a.value])).toEqual([['summary', 'Invoice from Acme']]);

    const found = await run('annotation-search', { query: 'Acme' });
    expect(found.matches!.map((m) => m.target_id)).toEqual(['m1']);

    const links = await run('link-list', { from_collection: 'data.mail', from_id: 'm1' });
    expect(links.links!.map((l) => [l.to_collection, l.to_id, l.role]))
      .toEqual([['data.contact', 'c1', 'thread_participant']]);
  });

  /** ⛔ The owner's rule, end to end (2026-09-23). Annotations are regenerated by
   *  housekeeping, so a recipe deletes only its own — a row housekeeping wrote
   *  under the same key survives. Typed links are not regenerated by anything,
   *  so a recipe's link delete reaches every author's matching link. */
  it('annotation-delete spares what others wrote; link-delete does not scope', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'round5-annotation-deletes-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = createAnnotationStore({ db: makeDb(), blobs: createBlobStore(join(dir, 'blobs')) });
    for (const author of ['r1', 'housekeeping:link-discovery']) {
      await store.annotate({
        target_collection: 'data.contact', target_id: 'c1', key: 'frequent_touch',
        value: author, authored_by_recipe_id: author, source_record_hash: 'h1',
      });
      await store.link({
        from_collection: 'data.mail', from_id: 'm1', to_collection: 'data.contact', to_id: 'c1',
        role: 'thread_participant', authored_by_recipe_id: author,
      });
    }
    const { config } = await composeWith({ annotationDeps: { store } });
    const adapter = createKernelAdapter(kernelOf(config));
    const inRun = (slug: string, input: Record<string, unknown>) =>
      adapter({ slug, input, stepMeta: { recipe_id: 'r1', run_id: 'run-1' } } as never) as Promise<{ deleted: number }>;

    expect((await inRun('annotation-delete', { key: 'frequent_touch' })).deleted).toBe(1);
    expect((await store.listAnnotations({ key: 'frequent_touch' })).map((a) => a.authored_by_recipe_id))
      .toEqual(['housekeeping:link-discovery']);

    expect((await inRun('link-delete', { role: 'thread_participant' })).deleted).toBe(2);
    expect(await store.listLinks({ role: 'thread_participant' })).toEqual([]);
  });
});

/** ⛔ D-245's `{slug, path}` address never worked on a real server: the CSV
 *  handler took an optional `instanceReader` and only its own tests supplied
 *  one, so every named-file CSV op failed "needs a paired server". This drives
 *  the REAL composition root: the read reaches the file stack's own `fileRead`
 *  (what `core.storage.file.read` uses), wrapped inside the CSV op. */
describe('the CSV ops read a named file through the file stack', () => {
  it('csv-rows by {slug, path} reads via fileStack.fileRead', async () => {
    const reads: Array<{ slug: string; path: string }> = [];
    const fileRead = vi.fn(async (where: { slug: string; path: string }) => {
      reads.push(where);
      return { body_b64: Buffer.from('Name,Email\nAcme,ops@acme.test\n', 'utf8').toString('base64') };
    });
    const { config } = await composeWith({
      fileStack: stackWithDispatchers({ fileRead } as never) as FileStack,
    });
    const adapter = createKernelAdapter(kernelOf(config));
    const out = await adapter({
      slug: 'csv-rows', input: { slug: 'vault', path: 'sheets/people.csv', column: 'Name', match: 'Acme' },
    } as never) as { rows: unknown[] };
    expect(out.rows).toEqual([{ Name: 'Acme', Email: 'ops@acme.test' }]);
    expect(reads).toEqual([{ slug: 'vault', path: 'sheets/people.csv' }]);
  });

  it('without a file stack a named read still refuses rather than reading nothing', async () => {
    const { config } = await composeWith({});
    const adapter = createKernelAdapter(kernelOf(config));
    await expect(adapter({
      slug: 'csv-rows', input: { slug: 'vault', path: 'a.csv', column: 'Name', match: '' },
    } as never)).rejects.toThrow(/named file instance/);
  });
});

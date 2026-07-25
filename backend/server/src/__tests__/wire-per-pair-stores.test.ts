import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const perPairStoreMocks = vi.hoisted(() => {
  const callLog: string[] = [];

  const stores = {
    workEntityStore: { kind: 'workEntityStore' },
    s2sPreviewStore: { kind: 's2sPreviewStore' },
    correctionEventsStore: { kind: 'correctionEventsStore' },
    publicEndpointRegistryStore: { kind: 'publicEndpointRegistryStore' },
    receptionRegistryCache: { kind: 'receptionRegistryCache' },
    receptionRateLimiter: {
      kind: 'receptionRateLimiter',
      reload: vi.fn((_now: number) => {
        callLog.push('receptionRateLimiter.reload');
      }),
    },
    previewHashStore: { kind: 'previewHashStore' },
    schedulingFormNonceStore: { kind: 'schedulingFormNonceStore' },
    intakeFormDefinitionStore: { kind: 'intakeFormDefinitionStore' },
    intakeRecipePairStore: { kind: 'intakeRecipePairStore' },
    intakeFormSubmissionStore: { kind: 'intakeFormSubmissionStore' },
    formResponseStore: { kind: 'formResponseStore' },
    intakeFormNonceStore: { kind: 'intakeFormNonceStore' },
    dropBlobStore: { kind: 'dropBlobStore' },
    dropLinkNonceStore: { kind: 'dropLinkNonceStore' },
    approvalIntentStore: { kind: 'approvalIntentStore' },
    approvalLinkNonceStore: { kind: 'approvalLinkNonceStore' },
    statusProjectionStore: { kind: 'statusProjectionStore' },
    ipBlockStore: { kind: 'ipBlockStore' },
  };

  const mark = (label: string) =>
    vi.fn((..._args: unknown[]): void => {
      callLog.push(label);
    });
  const factory = <T>(label: string, value: T) =>
    vi.fn((..._args: unknown[]): T => {
      callLog.push(label);
      return value;
    });

  return {
    callLog,
    stores,
    ensureAnnotationSchema: mark('ensureAnnotationSchema'),
    ensureBistemporalSchema: mark('ensureBistemporalSchema'),
    ensureLinkConfidenceSchema: mark('ensureLinkConfidenceSchema'),
    ensureEnrichmentSchema: mark('ensureEnrichmentSchema'),
    ensureTimeRelativeWatcherSchema: mark('ensureTimeRelativeWatcherSchema'),
    ensureWorkEntitySchema: mark('ensureWorkEntitySchema'),
    autoRegisterRecuedBuiltinSources: mark('autoRegisterRecuedBuiltinSources'),
    ensureReceptionSchema: mark('ensureReceptionSchema'),
    ensureUploadSessionSchema: mark('ensureUploadSessionSchema'),
    ensureExposureSchema: mark('ensureExposureSchema'),
    createWorkEntityStore: factory('createWorkEntityStore', stores.workEntityStore),
    createS2SPreviewStore: factory('createS2SPreviewStore', stores.s2sPreviewStore),
    createCorrectionEventsStore: factory(
      'createCorrectionEventsStore',
      stores.correctionEventsStore,
    ),
    createPublicEndpointRegistryStore: factory(
      'createPublicEndpointRegistryStore',
      stores.publicEndpointRegistryStore,
    ),
    createReceptionRegistryCache: factory(
      'createReceptionRegistryCache',
      stores.receptionRegistryCache,
    ),
    createReceptionRateLimiter: factory(
      'createReceptionRateLimiter',
      stores.receptionRateLimiter,
    ),
    createPreviewHashStore: factory('createPreviewHashStore', stores.previewHashStore),
    createInMemorySchedulingFormNonceStore: factory(
      'createInMemorySchedulingFormNonceStore',
      stores.schedulingFormNonceStore,
    ),
    createReceptionFormDefinitionStore: factory(
      'createReceptionFormDefinitionStore',
      stores.intakeFormDefinitionStore,
    ),
    createReceptionIntakeRecipePairStore: factory(
      'createReceptionIntakeRecipePairStore',
      stores.intakeRecipePairStore,
    ),
    createReceptionFormSubmissionStore: factory(
      'createReceptionFormSubmissionStore',
      stores.intakeFormSubmissionStore,
    ),
    createFormResponseStore: factory(
      'createFormResponseStore',
      stores.formResponseStore,
    ),
    createInMemoryIntakeFormNonceStore: factory(
      'createInMemoryIntakeFormNonceStore',
      stores.intakeFormNonceStore,
    ),
    createReceptionDropBlobStore: factory(
      'createReceptionDropBlobStore',
      stores.dropBlobStore,
    ),
    createInMemoryDropLinkNonceStore: factory(
      'createInMemoryDropLinkNonceStore',
      stores.dropLinkNonceStore,
    ),
    createReceptionApprovalIntentStore: factory(
      'createReceptionApprovalIntentStore',
      stores.approvalIntentStore,
    ),
    createInMemoryApprovalLinkNonceStore: factory(
      'createInMemoryApprovalLinkNonceStore',
      stores.approvalLinkNonceStore,
    ),
    createReceptionStatusProjectionStore: factory(
      'createReceptionStatusProjectionStore',
      stores.statusProjectionStore,
    ),
    createReceptionIpBlockStore: factory(
      'createReceptionIpBlockStore',
      stores.ipBlockStore,
    ),
  };
});

vi.mock('../storage/annotation-store.js', () => ({
  ensureAnnotationSchema: perPairStoreMocks.ensureAnnotationSchema,
}));

vi.mock('../memory-schema.js', () => ({
  ensureBistemporalSchema: perPairStoreMocks.ensureBistemporalSchema,
  ensureLinkConfidenceSchema: perPairStoreMocks.ensureLinkConfidenceSchema,
}));

vi.mock('../storage/enrichment-store.js', () => ({
  ensureEnrichmentSchema: perPairStoreMocks.ensureEnrichmentSchema,
}));

vi.mock('../watchers/time-relative-watcher.js', () => ({
  ensureTimeRelativeWatcherSchema:
    perPairStoreMocks.ensureTimeRelativeWatcherSchema,
}));

vi.mock('../storage/work-entity-store.js', () => ({
  ensureWorkEntitySchema: perPairStoreMocks.ensureWorkEntitySchema,
  createWorkEntityStore: perPairStoreMocks.createWorkEntityStore,
}));

vi.mock('../work-entity-source-boot.js', () => ({
  autoRegisterRecuedBuiltinSources:
    perPairStoreMocks.autoRegisterRecuedBuiltinSources,
}));

vi.mock('../s2s-preview/store.js', () => ({
  createS2SPreviewStore: perPairStoreMocks.createS2SPreviewStore,
}));

vi.mock('../storage/correction-events-store.js', () => ({
  createCorrectionEventsStore: perPairStoreMocks.createCorrectionEventsStore,
}));

vi.mock('../storage/reception-store.js', () => ({
  ensureReceptionSchema: perPairStoreMocks.ensureReceptionSchema,
}));

vi.mock('../storage/upload-session-store.js', () => ({
  ensureUploadSessionSchema: perPairStoreMocks.ensureUploadSessionSchema,
}));

vi.mock('../storage/public-endpoint-registry-store.js', () => ({
  createPublicEndpointRegistryStore:
    perPairStoreMocks.createPublicEndpointRegistryStore,
}));

vi.mock('../ports/reception/registry-cache.js', () => ({
  createReceptionRegistryCache: perPairStoreMocks.createReceptionRegistryCache,
}));

vi.mock('../ports/reception/rate-limiter.js', () => ({
  createReceptionRateLimiter: perPairStoreMocks.createReceptionRateLimiter,
}));

vi.mock('../ports/reception/preview-hash.js', () => ({
  createPreviewHashStore: perPairStoreMocks.createPreviewHashStore,
}));

vi.mock('../ports/reception/handlers/scheduling-link.js', () => ({
  createInMemorySchedulingFormNonceStore:
    perPairStoreMocks.createInMemorySchedulingFormNonceStore,
}));

vi.mock('../storage/reception-form-store.js', () => ({
  createReceptionFormDefinitionStore:
    perPairStoreMocks.createReceptionFormDefinitionStore,
  createReceptionFormSubmissionStore:
    perPairStoreMocks.createReceptionFormSubmissionStore,
}));

vi.mock('../storage/reception-intake-recipe-pair-store.js', () => ({
  createReceptionIntakeRecipePairStore:
    perPairStoreMocks.createReceptionIntakeRecipePairStore,
}));

vi.mock('../storage/form-response-store.js', () => ({
  createFormResponseStore: perPairStoreMocks.createFormResponseStore,
}));

vi.mock('../ports/reception/handlers/intake-form.js', () => ({
  createInMemoryIntakeFormNonceStore:
    perPairStoreMocks.createInMemoryIntakeFormNonceStore,
}));

vi.mock('../storage/reception-drop-store.js', () => ({
  createReceptionDropBlobStore: perPairStoreMocks.createReceptionDropBlobStore,
}));

vi.mock('../ports/reception/handlers/drop-link.js', () => ({
  createInMemoryDropLinkNonceStore:
    perPairStoreMocks.createInMemoryDropLinkNonceStore,
}));

vi.mock('../storage/reception-approval-store.js', () => ({
  createReceptionApprovalIntentStore:
    perPairStoreMocks.createReceptionApprovalIntentStore,
}));

vi.mock('../ports/reception/handlers/approval-link.js', () => ({
  createInMemoryApprovalLinkNonceStore:
    perPairStoreMocks.createInMemoryApprovalLinkNonceStore,
}));

vi.mock('../storage/reception-status-projection-store.js', () => ({
  createReceptionStatusProjectionStore:
    perPairStoreMocks.createReceptionStatusProjectionStore,
}));

vi.mock('../storage/reception-ip-block-store.js', () => ({
  createReceptionIpBlockStore: perPairStoreMocks.createReceptionIpBlockStore,
}));

vi.mock('../exposure/sqlite-store.js', () => ({
  ensureExposureSchema: perPairStoreMocks.ensureExposureSchema,
}));

import { composePerPairStores } from '../composition/bin/wire-per-pair-stores.js';

const expectedCallOrder = [
  'ensureAnnotationSchema',
  'ensureBistemporalSchema',
  'ensureLinkConfidenceSchema',
  'ensureEnrichmentSchema',
  'ensureTimeRelativeWatcherSchema',
  'ensureWorkEntitySchema',
  'createWorkEntityStore',
  'autoRegisterRecuedBuiltinSources',
  'createS2SPreviewStore',
  'createCorrectionEventsStore',
  'ensureReceptionSchema',
  'ensureUploadSessionSchema',
  'createPublicEndpointRegistryStore',
  'createReceptionRegistryCache',
  'createReceptionRateLimiter',
  'receptionRateLimiter.reload',
  'createPreviewHashStore',
  // ⚠ D-210 A.8 slice 4c — `createSchedulingBookingStore` REMOVED from this
  // boot-order list, and from the two factory lists + the handle list below,
  // because the STORE LEFT THE SUBSTRATE (4c deleted the module and its
  // `reception_booking_request` table; bookings are `reception_form_submission`
  // rows). ⛔ These lists are ratchets — a row leaves only when its seam does,
  // never to quiet a red. ⇒ [[feedback_never_widen_a_frozen_fences_scope]]
  'createInMemorySchedulingFormNonceStore',
  'createReceptionFormDefinitionStore',
  'createReceptionIntakeRecipePairStore',
  'createReceptionFormSubmissionStore',
  'createFormResponseStore',
  'createInMemoryIntakeFormNonceStore',
  'createReceptionDropBlobStore',
  'createInMemoryDropLinkNonceStore',
  'createReceptionApprovalIntentStore',
  'createInMemoryApprovalLinkNonceStore',
  'createReceptionStatusProjectionStore',
  'createReceptionIpBlockStore',
  'ensureExposureSchema',
] as const;

const schemaEnsures = [
  perPairStoreMocks.ensureAnnotationSchema,
  perPairStoreMocks.ensureBistemporalSchema,
  perPairStoreMocks.ensureLinkConfidenceSchema,
  perPairStoreMocks.ensureEnrichmentSchema,
  perPairStoreMocks.ensureTimeRelativeWatcherSchema,
  perPairStoreMocks.ensureWorkEntitySchema,
  perPairStoreMocks.ensureReceptionSchema,
  perPairStoreMocks.ensureUploadSessionSchema,
  perPairStoreMocks.ensureExposureSchema,
] as const;

const dbStoreFactories = [
  perPairStoreMocks.createWorkEntityStore,
  perPairStoreMocks.createS2SPreviewStore,
  perPairStoreMocks.createCorrectionEventsStore,
  perPairStoreMocks.createPublicEndpointRegistryStore,
  perPairStoreMocks.createReceptionFormDefinitionStore,
  perPairStoreMocks.createReceptionIntakeRecipePairStore,
  perPairStoreMocks.createReceptionFormSubmissionStore,
  perPairStoreMocks.createFormResponseStore,
  perPairStoreMocks.createReceptionDropBlobStore,
  perPairStoreMocks.createReceptionApprovalIntentStore,
  perPairStoreMocks.createReceptionStatusProjectionStore,
  perPairStoreMocks.createReceptionIpBlockStore,
] as const;

const inMemoryFactories = [
  perPairStoreMocks.createReceptionRegistryCache,
  perPairStoreMocks.createPreviewHashStore,
  perPairStoreMocks.createInMemorySchedulingFormNonceStore,
  perPairStoreMocks.createInMemoryIntakeFormNonceStore,
  perPairStoreMocks.createInMemoryDropLinkNonceStore,
  perPairStoreMocks.createInMemoryApprovalLinkNonceStore,
] as const;

const dynamicMocks = [
  perPairStoreMocks.ensureAnnotationSchema,
  perPairStoreMocks.ensureEnrichmentSchema,
  perPairStoreMocks.ensureTimeRelativeWatcherSchema,
  perPairStoreMocks.ensureWorkEntitySchema,
  perPairStoreMocks.createWorkEntityStore,
  perPairStoreMocks.autoRegisterRecuedBuiltinSources,
  perPairStoreMocks.createS2SPreviewStore,
  perPairStoreMocks.createCorrectionEventsStore,
  perPairStoreMocks.ensureReceptionSchema,
  perPairStoreMocks.ensureUploadSessionSchema,
  perPairStoreMocks.createPublicEndpointRegistryStore,
  perPairStoreMocks.createReceptionRegistryCache,
  perPairStoreMocks.createReceptionRateLimiter,
  perPairStoreMocks.stores.receptionRateLimiter.reload,
  perPairStoreMocks.createPreviewHashStore,
  perPairStoreMocks.createInMemorySchedulingFormNonceStore,
  perPairStoreMocks.createReceptionFormDefinitionStore,
  perPairStoreMocks.createReceptionIntakeRecipePairStore,
  perPairStoreMocks.createReceptionFormSubmissionStore,
  perPairStoreMocks.createFormResponseStore,
  perPairStoreMocks.createInMemoryIntakeFormNonceStore,
  perPairStoreMocks.createReceptionDropBlobStore,
  perPairStoreMocks.createInMemoryDropLinkNonceStore,
  perPairStoreMocks.createReceptionApprovalIntentStore,
  perPairStoreMocks.createInMemoryApprovalLinkNonceStore,
  perPairStoreMocks.createReceptionStatusProjectionStore,
  perPairStoreMocks.createReceptionIpBlockStore,
] as const;

const bundleFieldCases = [
  ['workEntityStore', perPairStoreMocks.stores.workEntityStore],
  ['s2sPreviewStore', perPairStoreMocks.stores.s2sPreviewStore],
  ['correctionEventsStore', perPairStoreMocks.stores.correctionEventsStore],
  [
    'publicEndpointRegistryStore',
    perPairStoreMocks.stores.publicEndpointRegistryStore,
  ],
  ['receptionRegistryCache', perPairStoreMocks.stores.receptionRegistryCache],
  ['receptionRateLimiter', perPairStoreMocks.stores.receptionRateLimiter],
  ['previewHashStore', perPairStoreMocks.stores.previewHashStore],
  [
    'schedulingFormNonceStore',
    perPairStoreMocks.stores.schedulingFormNonceStore,
  ],
  [
    'intakeFormDefinitionStore',
    perPairStoreMocks.stores.intakeFormDefinitionStore,
  ],
  ['intakeRecipePairStore', perPairStoreMocks.stores.intakeRecipePairStore],
  [
    'intakeFormSubmissionStore',
    perPairStoreMocks.stores.intakeFormSubmissionStore,
  ],
  ['formResponseStore', perPairStoreMocks.stores.formResponseStore],
  ['intakeFormNonceStore', perPairStoreMocks.stores.intakeFormNonceStore],
  ['dropBlobStore', perPairStoreMocks.stores.dropBlobStore],
  ['dropLinkNonceStore', perPairStoreMocks.stores.dropLinkNonceStore],
  ['approvalIntentStore', perPairStoreMocks.stores.approvalIntentStore],
  ['approvalLinkNonceStore', perPairStoreMocks.stores.approvalLinkNonceStore],
  ['statusProjectionStore', perPairStoreMocks.stores.statusProjectionStore],
  ['ipBlockStore', perPairStoreMocks.stores.ipBlockStore],
] as const;

const makeDb = (): Database.Database =>
  ({ kind: 'mock-db' }) as unknown as Database.Database;

beforeEach(() => {
  vi.clearAllMocks();
  perPairStoreMocks.callLog.length = 0;
});

describe('composePerPairStores gate matrix', () => {
  it('returns undefined when db is absent', async () => {
    await expect(composePerPairStores({ db: undefined })).resolves.toBeUndefined();
  });

  it('does not invoke static schemas or dynamic dependency exports when db is absent', async () => {
    await composePerPairStores({ db: undefined });

    expect(perPairStoreMocks.ensureBistemporalSchema).not.toHaveBeenCalled();
    expect(perPairStoreMocks.ensureLinkConfidenceSchema).not.toHaveBeenCalled();
    expect(perPairStoreMocks.ensureExposureSchema).not.toHaveBeenCalled();
    for (const mock of dynamicMocks) {
      expect(mock).not.toHaveBeenCalled();
    }
    expect(perPairStoreMocks.callLog).toEqual([]);
  });

  it('returns a defined bundle with all 20 fields present when db is present', async () => {
    const bundle = await composePerPairStores({ db: makeDb() });

    expect(bundle).toBeDefined();
    for (const [field] of bundleFieldCases) {
      expect(bundle?.[field]).toBeDefined();
    }
  });
});

describe('composePerPairStores schema and factory ordering', () => {
  it('preserves the exact pre-extraction sequence', async () => {
    await composePerPairStores({ db: makeDb() });

    expect(perPairStoreMocks.callLog).toEqual(expectedCallOrder);
  });
});

describe('composePerPairStores auto-register side-effect', () => {
  it('auto-registers Recued built-in sources exactly once with the work entity store', async () => {
    await composePerPairStores({ db: makeDb() });

    expect(perPairStoreMocks.autoRegisterRecuedBuiltinSources).toHaveBeenCalledTimes(
      1,
    );
    expect(perPairStoreMocks.autoRegisterRecuedBuiltinSources).toHaveBeenCalledWith(
      perPairStoreMocks.stores.workEntityStore,
    );
    expect(
      perPairStoreMocks.autoRegisterRecuedBuiltinSources.mock.calls[0][0],
    ).toBe(perPairStoreMocks.createWorkEntityStore.mock.results[0].value);
  });

  it('runs auto-registration immediately after the work entity store is created', async () => {
    await composePerPairStores({ db: makeDb() });

    expect(perPairStoreMocks.callLog.slice(5, 8)).toEqual([
      'ensureWorkEntitySchema',
      'createWorkEntityStore',
      'autoRegisterRecuedBuiltinSources',
    ]);
  });
});

describe('composePerPairStores rate-limiter reload', () => {
  it('reloads the reception rate limiter exactly once with a numeric Date.now value', async () => {
    await composePerPairStores({ db: makeDb() });

    expect(perPairStoreMocks.stores.receptionRateLimiter.reload).toHaveBeenCalledTimes(
      1,
    );
    expect(perPairStoreMocks.stores.receptionRateLimiter.reload).toHaveBeenCalledWith(
      expect.any(Number),
    );
  });

  it('reloads after the reception rate limiter factory returns', async () => {
    await composePerPairStores({ db: makeDb() });

    expect(perPairStoreMocks.callLog.slice(14, 16)).toEqual([
      'createReceptionRateLimiter',
      'receptionRateLimiter.reload',
    ]);
    expect(
      perPairStoreMocks.createReceptionRateLimiter.mock.invocationCallOrder[0],
    ).toBeLessThan(
      perPairStoreMocks.stores.receptionRateLimiter.reload.mock
        .invocationCallOrder[0],
    );
  });
});

describe('composePerPairStores bundle field identity', () => {
  it.each(bundleFieldCases)('returns the %s factory value by identity', async (
    field,
    expected,
  ) => {
    const bundle = await composePerPairStores({ db: makeDb() });

    expect(bundle?.[field]).toBe(expected);
  });
});

describe('composePerPairStores argument passthrough', () => {
  it('passes the same db instance to every db-backed store factory', async () => {
    const db = makeDb();

    await composePerPairStores({ db });

    for (const factory of dbStoreFactories) {
      expect(factory).toHaveBeenCalledTimes(1);
      expect(factory.mock.calls[0][0]).toBe(db);
    }
  });

  it('passes { db } to the reception rate limiter factory', async () => {
    const db = makeDb();

    await composePerPairStores({ db });

    expect(perPairStoreMocks.createReceptionRateLimiter).toHaveBeenCalledTimes(1);
    const rateLimiterArg = perPairStoreMocks.createReceptionRateLimiter.mock
      .calls[0][0] as { db: unknown };
    expect(rateLimiterArg).toEqual({ db });
    expect(rateLimiterArg.db).toBe(db);
  });

  it('invokes all in-memory factories with no arguments', async () => {
    await composePerPairStores({ db: makeDb() });

    for (const factory of inMemoryFactories) {
      expect(factory).toHaveBeenCalledTimes(1);
      expect(factory.mock.calls[0]).toEqual([]);
    }
  });

  it('passes the same db instance to all 9 schema-ensure functions', async () => {
    const db = makeDb();

    await composePerPairStores({ db });

    for (const ensure of schemaEnsures) {
      expect(ensure).toHaveBeenCalledTimes(1);
      expect(ensure.mock.calls[0][0]).toBe(db);
    }
  });
});

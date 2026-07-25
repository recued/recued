import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcError, type EndpointSummary } from '@recued/contracts';

const receptionDerivationMocks = vi.hoisted(() => ({
  deriveReceptionPepperFromSubDek: vi.fn(),
  deriveFormSubmissionPiiKeyFromSubDek: vi.fn(),
  deriveDropBlobPiiKeyFromSubDek: vi.fn(),
  deriveApprovalIntentPiiKeyFromSubDek: vi.fn(),
}));
const directReviewAdmissionMocks = vi.hoisted(() => ({
  create: vi.fn(() => vi.fn()),
}));

vi.mock('../ports/reception/server-secret-pepper.js', () => ({
  deriveReceptionPepperFromSubDek:
    receptionDerivationMocks.deriveReceptionPepperFromSubDek,
}));

vi.mock('../ports/reception/form-pii.js', () => ({
  deriveFormSubmissionPiiKeyFromSubDek:
    receptionDerivationMocks.deriveFormSubmissionPiiKeyFromSubDek,
  // The intake_form drain processor (loaded via the substrate's drain
  // registration) imports `openFormSubmissionField` from this module; the
  // mock mirrors that surface so module load stays clean even if the
  // processor's import graph is pulled in.
  openFormSubmissionField: vi.fn(),
}));

vi.mock('../ports/reception/drop-pii.js', () => ({
  deriveDropBlobPiiKeyFromSubDek:
    receptionDerivationMocks.deriveDropBlobPiiKeyFromSubDek,
}));

vi.mock('../ports/reception/approval-pii.js', () => ({
  deriveApprovalIntentPiiKeyFromSubDek:
    receptionDerivationMocks.deriveApprovalIntentPiiKeyFromSubDek,
}));

vi.mock('../paid-document-direct-checkout-review-admission.js', () => ({
  createPaidDocumentDirectCheckoutReviewAdmission:
    directReviewAdmissionMocks.create,
}));

import { composeReceptionSubstrate } from '../composition/bin/wire-reception-substrate.js';

const originalPublicBaseUrl = process.env.RECUED_PUBLIC_BASE_URL;
const originalTrustProxy = process.env.RECUED_RECEPTION_TRUST_PROXY;

const IKM = Buffer.alloc(32, 0x11);
const DERIVED_PEPPER = Buffer.alloc(32, 0x21);
const DERIVED_FORM_PII = Buffer.alloc(32, 0x23);
const DERIVED_DROP_PII = Buffer.alloc(32, 0x24);
const DERIVED_APPROVAL_PII = Buffer.alloc(32, 0x25);

const restoreEnv = () => {
  if (originalPublicBaseUrl === undefined) {
    delete process.env.RECUED_PUBLIC_BASE_URL;
  } else {
    process.env.RECUED_PUBLIC_BASE_URL = originalPublicBaseUrl;
  }

  if (originalTrustProxy === undefined) {
    delete process.env.RECUED_RECEPTION_TRUST_PROXY;
  } else {
    process.env.RECUED_RECEPTION_TRUST_PROXY = originalTrustProxy;
  }
};

const resetMockDefaults = () => {
  receptionDerivationMocks.deriveReceptionPepperFromSubDek.mockReturnValue(
    DERIVED_PEPPER,
  );
  receptionDerivationMocks.deriveFormSubmissionPiiKeyFromSubDek.mockReturnValue(
    DERIVED_FORM_PII,
  );
  receptionDerivationMocks.deriveDropBlobPiiKeyFromSubDek.mockReturnValue(
    DERIVED_DROP_PII,
  );
  receptionDerivationMocks.deriveApprovalIntentPiiKeyFromSubDek.mockReturnValue(
    DERIVED_APPROVAL_PII,
  );
};

const makeKeys = (...args: [] | [Uint8Array | undefined]) => {
  const subDek = args.length === 0 ? IKM : args[0];
  const receptionKeyProvider = vi.fn(() => subDek);
  const keyProvider = vi.fn(() => receptionKeyProvider);
  const keys = { keyProvider };

  return { keys, keyProvider, receptionKeyProvider };
};

const makeDeps = (overrides: Record<string, any> = {}) => {
  const { keys } = makeKeys();

  return {
    publicEndpointRegistryStore: { kind: 'registry-store' },
    receptionRegistryCache: {
      invalidate: vi.fn(),
      flush: vi.fn(),
    },
    receptionRateLimiter: {
      snapshot: vi.fn(),
    },
    previewHashStore: { kind: 'preview-store' },
    auditLog: { logActivity: vi.fn() },
    keys,
    eventBus: { emit: vi.fn() },
    dbPath: '/tmp/recued/server.db',
    backgroundServices: {
      registerInterval: vi.fn(),
      // The reception drain registers a `StoppableService` via `register`
      // (D-149 `35bb3964`); compose calls it after the rate-snapshot
      // `registerInterval`, so the mock must provide both.
      register: vi.fn(),
    },
    approvalIntentStore: { kind: 'approval-intent-store' },
    statusProjectionStore: { kind: 'status-projection-store' },
    ipBlockStore: { kind: 'ip-block-store' },
    schedulingFormNonceStore: { kind: 'scheduling-form-nonce-store' },
    intakeFormSubmissionStore: { kind: 'intake-form-submission-store' },
    intakeRecipePairStore: { findByEndpoint: vi.fn(() => null) },
    recipeStore: { get: vi.fn(() => null) },
    sellerOfferStore: {
      getOffer: vi.fn(() => null),
    },
    sharedStore: { read: vi.fn(), compareAndSet: vi.fn() },
    directCheckoutProvider: {
      createSession: vi.fn(),
      readSession: vi.fn(),
    },
    connectionStore: { get: vi.fn(() => null) },
    inboundFileCollection: {
      get: vi.fn(() => null),
      readBytes: vi.fn(),
    },
    intakeFormNonceStore: { kind: 'intake-form-nonce-store' },
    dropBlobStore: { kind: 'drop-blob-store' },
    blobStore: { kind: 'blob-store' },
    dropLinkNonceStore: { kind: 'drop-link-nonce-store' },
    approvalLinkNonceStore: { kind: 'approval-link-nonce-store' },
    ...overrides,
  };
};

const makeHostnameProjection = (overrides: Record<string, any> = {}) => ({
  hostname_id: 'host-1',
  hostname: 'alice.recued.net',
  cert_source: 'recued_acme',
  ownership_status: 'verified',
  listener_ports: [443],
  ddns_managed: true,
  enabled: true,
  tls_topology: 'server_terminated',
  ...overrides,
});

const composeFromDeps = async (deps: Record<string, any>) =>
  composeReceptionSubstrate(deps as any) as any;

const composeDefined = async (overrides: Record<string, any> = {}) => {
  const deps = makeDeps(overrides);
  const bundle = await composeFromDeps(deps);

  expect(bundle).toBeDefined();

  return { deps, bundle };
};

const captureThrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (err) {
    return err;
  }

  throw new Error('expected function to throw');
};

const expectNotConfigured = (fn: () => unknown, messageFragment: string) => {
  const err = captureThrown(fn);

  expect(err).toBeInstanceOf(RpcError);
  expect(err).toMatchObject({ code: 'not_configured', status: 503 });
  expect((err as Error).message).toContain(messageFragment);
};

const getRegisteredIntervalSpec = (backgroundServices: any) => {
  expect(backgroundServices.registerInterval).toHaveBeenCalledTimes(1);
  return backgroundServices.registerInterval.mock.calls[0][0];
};

beforeEach(() => {
  vi.clearAllMocks();
  resetMockDefaults();
  delete process.env.RECUED_PUBLIC_BASE_URL;
  delete process.env.RECUED_RECEPTION_TRUST_PROXY;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  restoreEnv();
});

describe('composeReceptionSubstrate gate matrix', () => {
  it.each([
    ['publicEndpointRegistryStore missing', 'publicEndpointRegistryStore'],
    ['receptionRegistryCache missing', 'receptionRegistryCache'],
    ['receptionRateLimiter missing', 'receptionRateLimiter'],
    ['previewHashStore missing', 'previewHashStore'],
    ['auditLog missing', 'auditLog'],
    ['keys missing', 'keys'],
  ])('returns undefined when %s', async (_label, depKey) => {
    const bundle = await composeFromDeps(makeDeps({ [depKey]: undefined }));

    expect(bundle).toBeUndefined();
  });

  it('returns both rpc and port deps when all required handles are present', async () => {
    const { bundle } = await composeDefined();

    expect(bundle.receptionRpcDeps).toBeDefined();
    expect(bundle.receptionPortDeps).toBeDefined();
  });
});

describe('composeReceptionSubstrate key derivation', () => {
  it('derives reception pepper from a fresh 32-byte reception sub-DEK', async () => {
    const { keys, keyProvider, receptionKeyProvider } = makeKeys(IKM);
    const { bundle } = await composeDefined({ keys });

    const result = bundle.receptionRpcDeps.getPepper();

    expect(keyProvider).toHaveBeenCalledWith('reception');
    expect(receptionKeyProvider).toHaveBeenCalledTimes(1);
    expect(receptionKeyProvider).toHaveReturnedWith(IKM);
    expect(IKM).toHaveLength(32);
    expect(
      receptionDerivationMocks.deriveReceptionPepperFromSubDek,
    ).toHaveBeenCalledWith(IKM);
    expect(result).toBe(DERIVED_PEPPER);
  });

  it('surfaces locked-vault pepper state as not_configured', async () => {
    const { keys } = makeKeys(undefined);
    const { bundle } = await composeDefined({ keys });

    expectNotConfigured(
      () => bundle.receptionRpcDeps.getPepper(),
      'pepper unavailable',
    );
  });

  it.each([
    // ⚠ D-210 A.8 slice 4b-ii — `getSchedulingBookingPiiKey` REMOVED from this
    // list because the getter itself is retired, not because the guarantee
    // weakened: a booking's fields seal under the FORM key now, so the
    // locked-vault behaviour that mattered for bookings is the one asserted by
    // `getIntakeFormSubmissionPiiKey` on the next row. ⛔ A row must only ever
    // leave this list when its GETTER leaves the substrate.
    [
      'getIntakeFormSubmissionPiiKey',
      'form-PII key',
    ],
    [
      'getDropBlobPiiKey',
      'drop-PII key',
    ],
    [
      'getApprovalIntentPiiKey',
      'approval-PII key',
    ],
  ])('surfaces locked-vault state for %s', async (getterName, messageFragment) => {
    const { keys } = makeKeys(undefined);
    const { bundle } = await composeDefined({ keys });

    expectNotConfigured(
      () => bundle.receptionPortDeps[getterName](),
      messageFragment,
    );
  });

  it('does not memoise receptionKeyProvider results in-process', async () => {
    const { keys, receptionKeyProvider } = makeKeys(IKM);
    const { bundle } = await composeDefined({ keys });

    expect(bundle.receptionRpcDeps.getPepper()).toBe(DERIVED_PEPPER);
    expect(bundle.receptionRpcDeps.getPepper()).toBe(DERIVED_PEPPER);

    expect(receptionKeyProvider).toHaveBeenCalledTimes(2);
    expect(
      receptionDerivationMocks.deriveReceptionPepperFromSubDek,
    ).toHaveBeenCalledTimes(2);
  });
});

describe('composeReceptionSubstrate broadcastReceptionEvent', () => {
  it('emits endpoint_changed and invalidates only the captured registry cache alias', async () => {
    const deps = makeDeps();
    const capturedCache = deps.receptionRegistryCache;
    const replacementCache = {
      invalidate: vi.fn(),
      flush: vi.fn(),
    };
    const { receptionRpcDeps } = await composeFromDeps(deps);
    const event = {
      kind: 'reception.endpoint_changed',
      op: 'create',
      endpoint_id: 'ep-1',
    };

    deps.receptionRegistryCache = replacementCache;
    receptionRpcDeps.broadcast(event);

    expect(deps.eventBus.emit).toHaveBeenCalledWith(event);
    expect(capturedCache.invalidate).toHaveBeenCalledWith('ep-1');
    expect(capturedCache.flush).not.toHaveBeenCalled();
    expect(replacementCache.invalidate).not.toHaveBeenCalled();
    expect(replacementCache.flush).not.toHaveBeenCalled();
  });

  it('emits emergency_disabled and flushes only the captured registry cache alias', async () => {
    const deps = makeDeps();
    const capturedCache = deps.receptionRegistryCache;
    const replacementCache = {
      invalidate: vi.fn(),
      flush: vi.fn(),
    };
    const { receptionRpcDeps } = await composeFromDeps(deps);
    const event = {
      kind: 'reception.emergency_disabled',
      disabled_count: 2,
      reason: 'incident-1',
    };

    deps.receptionRegistryCache = replacementCache;
    receptionRpcDeps.broadcast(event);

    expect(deps.eventBus.emit).toHaveBeenCalledWith(event);
    expect(capturedCache.flush).toHaveBeenCalledTimes(1);
    expect(capturedCache.invalidate).not.toHaveBeenCalled();
    expect(replacementCache.invalidate).not.toHaveBeenCalled();
    expect(replacementCache.flush).not.toHaveBeenCalled();
  });
});

describe('composeReceptionSubstrate env-driven constants', () => {
  it('requires a public shareBaseUrl when unset', async () => {
    const { bundle } = await composeDefined();

    expectNotConfigured(
      () => bundle.receptionRpcDeps.getShareBaseUrl(),
      'set RECUED_PUBLIC_BASE_URL',
    );
  });

  it('trims trailing slashes from shareBaseUrl', async () => {
    process.env.RECUED_PUBLIC_BASE_URL = 'https://example.com///';

    const { bundle } = await composeDefined();

    expect(bundle.receptionRpcDeps.getShareBaseUrl()).toBe('https://example.com');
  });

  it('derives shareBaseUrl from the hostname registry when env is unset', async () => {
    const hostnameRegistryStore = {
      list: vi.fn(() => [
        makeHostnameProjection({
          hostname_id: 'disabled-host',
          hostname: 'disabled.recued.net',
          enabled: false,
        }),
        makeHostnameProjection({
          hostname_id: 'ready-host',
          hostname: 'ready.recued.net',
          listener_ports: [8446],
        }),
      ]),
    };

    const { bundle } = await composeDefined({ hostnameRegistryStore });

    expect(bundle.receptionRpcDeps.getShareBaseUrl()).toBe(
      'https://ready.recued.net:8446',
    );
    expect(bundle.receptionRpcDeps.preflightEnable?.({
      endpoint: { endpoint_id: 'ep-1' } as unknown as EndpointSummary,
      now: 1_700_000_000_000,
    })).toMatchObject({
      ok: true,
      passed: ['Public Reception URL is configured'],
    });
    expect(hostnameRegistryStore.list).toHaveBeenCalledTimes(2);
  });

  it('keeps a public env shareBaseUrl ahead of the hostname registry fallback', async () => {
    process.env.RECUED_PUBLIC_BASE_URL = 'https://env.example';
    const hostnameRegistryStore = {
      list: vi.fn(() => [
        makeHostnameProjection({
          hostname: 'ready.recued.net',
        }),
      ]),
    };

    const { bundle } = await composeDefined({ hostnameRegistryStore });

    expect(bundle.receptionRpcDeps.getShareBaseUrl()).toBe('https://env.example');
    expect(hostnameRegistryStore.list).not.toHaveBeenCalled();
  });

  it('requires a public shareBaseUrl for an empty env value', async () => {
    process.env.RECUED_PUBLIC_BASE_URL = '   ';

    const { bundle } = await composeDefined();

    expectNotConfigured(
      () => bundle.receptionRpcDeps.getShareBaseUrl(),
      'set RECUED_PUBLIC_BASE_URL',
    );
  });

  it('wires preflight_enable to the public URL requirement', async () => {
    const missing = await composeDefined();
    const endpoint = { endpoint_id: 'ep-1' } as unknown as EndpointSummary;

    expect(missing.bundle.receptionRpcDeps.preflightEnable?.({
      endpoint,
      now: 1_700_000_000_000,
    })).toMatchObject({
      ok: false,
      blocked: ['Set a public URL before enabling Reception endpoints'],
    });

    process.env.RECUED_PUBLIC_BASE_URL = 'https://example.com';
    const configured = await composeDefined();

    expect(configured.bundle.receptionRpcDeps.preflightEnable?.({
      endpoint,
      now: 1_700_000_000_000,
    })).toMatchObject({
      ok: true,
      passed: ['Public Reception URL is configured'],
    });

    // D-173 P4.2 (N.3 "Enable" gate) — the scheduling_link enable
    // hard-block is LIFTED. Bookings are review-by-default proposals
    // (a local commitment held at the Reception Inbox; free/busy is out
    // of scope per D7), so a scheduling endpoint enables on the same
    // public-URL requirement as every other kind.
    expect(configured.bundle.receptionRpcDeps.preflightEnable?.({
      endpoint: {
        endpoint_id: 'sched-1',
        kind: 'scheduling_link',
      } as unknown as EndpointSummary,
      now: 1_700_000_000_000,
    })).toMatchObject({
      ok: true,
      passed: ['Public Reception URL is configured'],
    });
  });

  it.each([
    ['https://mary.recued.net', 'pro_cloud'],
    ['https://localhost', 'byo_ddns'],
    ['https://example.com', 'byo_ddns'],
    ['not a url', 'byo_ddns'],
  ])('derives receptionDeploymentMode for %s', async (baseUrl, expected) => {
    process.env.RECUED_PUBLIC_BASE_URL = baseUrl;

    const { bundle } = await composeDefined();

    expect(bundle.receptionPortDeps.receptionDeploymentMode).toBe(expected);
  });

  it.each([
    [undefined, false],
    ['true', true],
    ['1', true],
    ['false', false],
    ['yes', false],
  ])('derives trustForwardedFor from %s', async (envValue, expected) => {
    if (envValue === undefined) {
      delete process.env.RECUED_RECEPTION_TRUST_PROXY;
    } else {
      process.env.RECUED_RECEPTION_TRUST_PROXY = envValue;
    }

    const { bundle } = await composeDefined();

    expect(bundle.receptionPortDeps.trustForwardedFor).toBe(expected);
  });
});

describe('composeReceptionSubstrate conditional spreads', () => {
  it('includes rpc optional store getters only when the corresponding store exists', async () => {
    const rpcOptionalCases = [
      ['approvalIntentStore', 'getApprovalIntentStore'],
      ['statusProjectionStore', 'getStatusProjectionStore'],
      ['ipBlockStore', 'getIpBlockStore'],
      ['intakeRecipePairStore', 'getIntakeRecipePairStore'],
      ['recipeStore', 'getRecipeStore'],
      ['connectionStore', 'getConnectionStore'],
      ['inboundFileCollection', 'getInboundFileCollection'],
      ['sellerOfferStore', 'getSellerOfferStore'],
    ] as const;

    for (const [depKey, getterName] of rpcOptionalCases) {
      const deps = makeDeps();
      const full = await composeFromDeps(deps);

      expect(getterName in full.receptionRpcDeps).toBe(true);
      expect(full.receptionRpcDeps[getterName]()).toBe(deps[depKey]);

      const missing = await composeFromDeps(
        makeDeps({ [depKey]: undefined }),
      );

      expect(getterName in missing.receptionRpcDeps).toBe(false);
    }
  });

  it('includes port optional store getters only when the corresponding store exists', async () => {
    const portOptionalCases = [
      // ⚠ D-210 A.8 slice 4b-ii — `['schedulingBookingStore',
      // 'getSchedulingBookingStore']` REMOVED: the port no longer takes that
      // getter at all (the scheduling handlers read the merged store, asserted
      // two rows down as `intakeFormSubmissionStore`). ⛔ This list is a ratchet —
      // dropping a row is only ever right when the SEAM is gone, never to make a
      // red go away. The remaining ten still ratchet.
      ['schedulingFormNonceStore', 'getSchedulingFormNonceStore'],
      ['intakeFormSubmissionStore', 'getIntakeFormSubmissionStore'],
      ['intakeFormNonceStore', 'getIntakeFormNonceStore'],
      ['dropBlobStore', 'getDropBlobStore'],
      ['blobStore', 'getBlobStore'],
      ['dropLinkNonceStore', 'getDropLinkNonceStore'],
      ['approvalIntentStore', 'getApprovalIntentStore'],
      ['approvalLinkNonceStore', 'getApprovalLinkNonceStore'],
      ['statusProjectionStore', 'getStatusProjectionStore'],
      ['ipBlockStore', 'getIpBlockStore'],
    ] as const;

    for (const [depKey, getterName] of portOptionalCases) {
      const deps = makeDeps();
      const full = await composeFromDeps(deps);

      expect(getterName in full.receptionPortDeps).toBe(true);
      expect(full.receptionPortDeps[getterName]()).toBe(deps[depKey]);

      const missing = await composeFromDeps(
        makeDeps({ [depKey]: undefined }),
      );

      expect(getterName in missing.receptionPortDeps).toBe(false);
    }
  });

  it('wires pair resolution with pair storage and fails configured rows closed without recipes', async () => {
    const fullDeps = makeDeps();
    const full = await composeFromDeps(fullDeps);

    expect('resolveIntakeFormRecipePair' in full.receptionPortDeps).toBe(true);
    expect(full.receptionPortDeps.resolveIntakeFormRecipePair({
      endpoint_id: 'ep-intake-1',
      form_config: {} as any,
    })).toEqual({ kind: 'unpaired' });
    expect(fullDeps.intakeRecipePairStore.findByEndpoint).toHaveBeenCalledWith(
      'ep-intake-1',
    );
    expect(fullDeps.recipeStore.get).not.toHaveBeenCalled();

    const missingPairStore = await composeFromDeps(makeDeps({
      intakeRecipePairStore: undefined,
    }));
    expect(
      'resolveIntakeFormRecipePair' in missingPairStore.receptionPortDeps,
    ).toBe(false);

    const pairBinding = {
      version: 1,
      form_definition_id: 'form-1',
      recipe_id: 'recipe-1',
      recipe_version: 1,
      pair_revision: `d200-pair-v1-${'a'.repeat(64)}`,
    };
    const missingRecipeStore = await composeFromDeps(makeDeps({
      recipeStore: undefined,
      intakeRecipePairStore: {
        findByEndpoint: vi.fn(() => ({
          endpoint_id: 'ep-intake-1',
          binding: pairBinding,
          created_at: 1,
          updated_at: 1,
        })),
      },
    }));
    expect(
      'resolveIntakeFormRecipePair' in missingRecipeStore.receptionPortDeps,
    ).toBe(true);
    expect(missingRecipeStore.receptionPortDeps.resolveIntakeFormRecipePair({
      endpoint_id: 'ep-intake-1',
      form_config: {} as any,
    })).toEqual({ kind: 'stale' });
  });

  /** D-207 slice 3c — the DOOR is the only thing that can serve a submit.
   *
   *  Before this slice the legacy coordinator composed from its own claim/provider source
   *  set (`directCheckoutTaskStore` + `sharedStore` + `directCheckoutProvider`), so a submit
   *  seam existed with no contract substrate anywhere in sight — it ran the recipe through
   *  the only raw `executeRecipe` in the server, outside the Gateway. That is gone.
   *
   *  This harness composes NO contract stores and NO `executeDeps`, so no door can be minted
   *  — and now that means no submit seam at all. Which is exactly right: a pair with no door
   *  grants nothing, so there is nothing a submission could legitimately run. */
  it('no contract substrate ⇒ NO submit seam — the legacy coordinator no longer supplies one', async () => {
    const full = await composeFromDeps(makeDeps());

    expect('coordinateIntakeFormPairedRun' in full.receptionPortDeps).toBe(false);

    // The recovery rpc went with the coordinator. A dep outliving its only producer would be
    // a surface that always 503s — an rpc that looks live and is not.
    expect('recoverDirectCheckout' in full.receptionRpcDeps).toBe(false);
  });

  it('composes exact paid-review admission into the intake drain from shared state', async () => {
    const deps = makeDeps({ workEntityStore: { kind: 'work-entity-store' } });
    await composeFromDeps(deps);

    expect(directReviewAdmissionMocks.create).toHaveBeenCalledWith(deps.sharedStore);
  });
});

describe('composeReceptionSubstrate always-on fields', () => {
  it('captures store/cache/rate-limiter/preview aliases and returns those identities', async () => {
    const deps = makeDeps();
    const registryStore = deps.publicEndpointRegistryStore;
    const registryCache = deps.receptionRegistryCache;
    const rateLimiter = deps.receptionRateLimiter;
    const previewStore = deps.previewHashStore;
    const { receptionRpcDeps, receptionPortDeps } = await composeFromDeps(deps);

    deps.publicEndpointRegistryStore = { kind: 'replacement-registry-store' };
    deps.receptionRegistryCache = { invalidate: vi.fn(), flush: vi.fn() };
    deps.receptionRateLimiter = { snapshot: vi.fn() };
    deps.previewHashStore = { kind: 'replacement-preview-store' };

    expect(receptionRpcDeps.getStore()).toBe(registryStore);
    expect(receptionPortDeps.getStore()).toBe(registryStore);
    expect(receptionPortDeps.getCache()).toBe(registryCache);
    expect(receptionPortDeps.getRateLimiter()).toBe(rateLimiter);
    expect(receptionRpcDeps.getPreviewStore()).toBe(previewStore);
  });

  it('uses Date.now for rpc and port clocks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_765_000_000_123);
    const { bundle } = await composeDefined();

    expect(bundle.receptionRpcDeps.now()).toBe(Date.now());
    expect(bundle.receptionPortDeps.now()).toBe(Date.now());
  });

  it('always wires the D-173 P4.2 cold-start scheduling calendar reader (no busy events)', async () => {
    // The reader is stateless + unconditional — with the booking +
    // form-nonce stores present, the dispatcher serves the visitor slot
    // picker instead of the 503 stub. Cold-start returns no busy events
    // (free/busy is out of scope per D7; availability = explicit_windows).
    const { bundle } = await composeDefined();
    expect('getSchedulingCalendarReader' in bundle.receptionPortDeps).toBe(true);
    const reader = bundle.receptionPortDeps.getSchedulingCalendarReader!();
    expect(reader.list({ window_start: 0, window_end: 1_000_000 })).toEqual([]);
  });

  it('threads auditLog directly and deployment mode only onto port deps', async () => {
    process.env.RECUED_PUBLIC_BASE_URL = 'https://mary.recued.net';

    const { deps, bundle } = await composeDefined();

    expect(bundle.receptionRpcDeps.auditLog).toBe(deps.auditLog);
    expect(bundle.receptionPortDeps.auditLog).toBe(deps.auditLog);
    expect('receptionDeploymentMode' in bundle.receptionPortDeps).toBe(true);
    expect(bundle.receptionPortDeps.receptionDeploymentMode).toBe('pro_cloud');
    expect('receptionDeploymentMode' in bundle.receptionRpcDeps).toBe(false);
  });
});

describe('composeReceptionSubstrate dropBlobsRoot', () => {
  it('resolves drop_blobs next to an absolute sqlite dbPath', async () => {
    const { bundle } = await composeDefined({
      dbPath: '/var/recued/server.db',
    });

    expect(bundle.receptionPortDeps.getDropBlobsRoot()).toBe(
      '/var/recued/drop_blobs',
    );
  });

  it('resolves drop_blobs against cwd for a relative sqlite dbPath', async () => {
    const { bundle } = await composeDefined({
      dbPath: './local.db',
    });

    expect(bundle.receptionPortDeps.getDropBlobsRoot()).toBe(
      resolve(dirname('./local.db'), 'drop_blobs'),
    );
  });

  it('computes dropBlobsRoot once at compose time', async () => {
    const deps = makeDeps({
      dbPath: './local.db',
    });
    const { receptionPortDeps } = await composeFromDeps(deps);
    const first = receptionPortDeps.getDropBlobsRoot();

    deps.dbPath = '/var/recued/server.db';

    expect(receptionPortDeps.getDropBlobsRoot()).toBe(first);
    expect(receptionPortDeps.getDropBlobsRoot()).toBe(first);
  });
});

describe('composeReceptionSubstrate background service registration', () => {
  it('registers the reception rate snapshot interval during compose', async () => {
    const { deps } = await composeDefined();
    const spec = getRegisteredIntervalSpec(deps.backgroundServices);

    expect(spec).toMatchObject({
      name: 'reception-rate-snapshot',
      intervalMs: 30_000,
    });
    expect(typeof spec.tick).toBe('function');
    expect(typeof spec.onStop).toBe('function');
  });

  it('snapshots the rate limiter on interval tick and onStop', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_765_000_100_000);
    const { deps } = await composeDefined();
    const spec = getRegisteredIntervalSpec(deps.backgroundServices);

    spec.tick();
    spec.onStop();

    expect(deps.receptionRateLimiter.snapshot).toHaveBeenCalledTimes(2);
    expect(deps.receptionRateLimiter.snapshot).toHaveBeenNthCalledWith(
      1,
      Date.now(),
    );
    expect(deps.receptionRateLimiter.snapshot).toHaveBeenNthCalledWith(
      2,
      Date.now(),
    );
  });

  it('swallows tick snapshot errors and logs the d-149 prefix', async () => {
    const err = new Error('snapshot failed');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { deps } = await composeDefined();
    const spec = getRegisteredIntervalSpec(deps.backgroundServices);

    deps.receptionRateLimiter.snapshot.mockImplementationOnce(() => {
      throw err;
    });

    expect(() => spec.tick()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/^\[d-149\.p3\]/),
      err,
    );
  });

  it('swallows onStop snapshot errors and logs the d-149 prefix', async () => {
    const err = new Error('final snapshot failed');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { deps } = await composeDefined();
    const spec = getRegisteredIntervalSpec(deps.backgroundServices);

    deps.receptionRateLimiter.snapshot.mockImplementationOnce(() => {
      throw err;
    });

    expect(() => spec.onStop()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/^\[d-149\.p3\]/),
      err,
    );
  });
});

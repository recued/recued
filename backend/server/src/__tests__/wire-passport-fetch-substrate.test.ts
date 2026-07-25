import { describe, expect, it, vi } from 'vitest';

import { composePassportFetchSubstrate } from '../composition/bin/wire-passport-fetch-substrate.js';
import type { PathRole, PathResolution } from '@recued/contracts';

type SyntheticKeypair = {
  public_key_b64: string;
  public_key_fingerprint: string;
};

type SyntheticCert = {
  fingerprint: string;
  valid_until: number;
};

const makeKeypair = (label: string): SyntheticKeypair => ({
  public_key_b64: `${label}-public-key`,
  public_key_fingerprint: `${label}-fingerprint`,
});

const makeCertSource = (cert: SyntheticCert | undefined) => ({
  getCurrentCert: vi.fn(() => cert),
});

type SyntheticHandleHistoryRow = {
  handle: string;
  reserved_at: number;
  released_at?: number;
  // The substrate maps to the passport's 3-field subset; carry the extra
  // server-internal fields so the test proves they are dropped.
  reason?: string;
  note?: string;
  transfer_counterparty_publisher_id?: string;
};

type SyntheticHandleState = {
  publisher_id: string;
  current_handle: string;
  handle_history: SyntheticHandleHistoryRow[];
};

/** Fake HandleStateMachine — only `current()` is read by `loadIdentity`.
 *  Pass `null` for a materialised-but-unreserved machine. */
const makeHandleStateMachine = (state: SyntheticHandleState | null) => ({
  current: vi.fn(async () => state),
});

type SyntheticExposureState = {
  // Typed as the full PathRole Record so the fixture below must supply ALL
  // roles — a new PathRole fails the fixture at compile time (the same
  // cascade signal the mapper avoids at runtime by iterating the Record).
  resolution: Record<PathRole, PathResolution>;
  derived_preset_label: string;
  public_mcp_acknowledgement: { acknowledged: boolean };
  last_changed_at: number;
  changed_by_client_id: string;
};

/** Fake ExposureStateMachine — `loadNetwork` reads only `current()`. */
const makeExposureMachine = (state: SyntheticExposureState) => ({
  current: vi.fn(async () => state),
});

type SyntheticPairedInstance = {
  instance_id: string;
  user_id: string;
  display_name: string;
  kind: 'bridge' | 'webclient' | 'cli';
  added_at: number;
  revoked_at: number | null;
};

/** Fake PairedInstancesStore — `loadClients` reads only `listAllActive()`. */
const makePairedInstancesStore = (roster: SyntheticPairedInstance[]) => ({
  listAllActive: vi.fn(() => roster),
});

const makeSigningIdentity = (
  serverKey: SyntheticKeypair = makeKeypair('server'),
  publisherKey: SyntheticKeypair = makeKeypair('publisher'),
) => {
  const serverIdentityKey = vi.fn(() => serverKey);
  const publisherIdentityKey = vi.fn(() => publisherKey);
  const signingIdentity = {
    identity: {
      serverIdentityKey,
      publisherIdentityKey,
    },
  };

  return { signingIdentity, serverIdentityKey, publisherIdentityKey };
};

const makeCertStack = (
  passportCertSource: ReturnType<typeof makeCertSource> | undefined = undefined,
  handleStateMachineRef: unknown = undefined,
) => {
  const getPassportCertSourceRef = vi.fn(() => passportCertSource);
  const getTlsCertSourceRef = vi.fn();
  const getInitialAcmeDomainIssuerRef = vi.fn();
  const getHandleStateMachineRef = vi.fn(() => handleStateMachineRef);
  const certStack = {
    getPassportCertSourceRef,
    getTlsCertSourceRef,
    getInitialAcmeDomainIssuerRef,
    getHandleStateMachineRef,
  };

  return {
    certStack,
    getPassportCertSourceRef,
    getTlsCertSourceRef,
    getInitialAcmeDomainIssuerRef,
    getHandleStateMachineRef,
  };
};

const makeDeps = (overrides: Record<string, unknown> = {}) => {
  const { signingIdentity } = makeSigningIdentity();
  const { certStack } = makeCertStack();

  return {
    db: {},
    signingIdentity,
    certStack,
    ...overrides,
  };
};

const composeFromDeps = (deps: Record<string, unknown>) =>
  composePassportFetchSubstrate(deps as any) as any;

const composeDefined = (overrides: Record<string, unknown> = {}) => {
  const bundle = composeFromDeps(makeDeps(overrides));

  expect(bundle).toBeDefined();

  return bundle;
};

const expectConservativeNetworkDefaults = (network: any) => {
  expect(network.lan_urls).toEqual([]);
  expect(network.derived_preset_label).toBe('lan_only');
  expect(network.public_mcp_acknowledgement).toEqual({
    acknowledged: false,
  });
  expect(network.per_path.health).toEqual({
    resolution: { lan: true, public: false },
  });
  expect(network.per_path.ws).toEqual({
    resolution: { lan: true, public: false },
  });
  expect(network.per_path.mcp).toEqual({
    resolution: { lan: true, public: false },
  });
  expect(network.per_path.webhooks).toEqual({
    resolution: { lan: false, public: false },
  });
  expect(network.per_path.reception).toEqual({
    resolution: { lan: false, public: false },
  });
};

describe('composePassportFetchSubstrate gate matrix', () => {
  it('returns undefined when db is missing and signingIdentity is present', () => {
    const { signingIdentity } = makeSigningIdentity();
    const { certStack } = makeCertStack();

    const bundle = composeFromDeps({
      db: undefined,
      signingIdentity,
      certStack,
    });

    expect(bundle).toBeUndefined();
  });

  it('returns undefined when signingIdentity is missing and db is present', () => {
    const { certStack } = makeCertStack();

    const bundle = composeFromDeps({
      db: {},
      signingIdentity: undefined,
      certStack,
    });

    expect(bundle).toBeUndefined();
  });

  it('returns passportFetchDeps when db and signingIdentity are both present', () => {
    const bundle = composeDefined();

    expect(bundle.passportFetchDeps).toBeDefined();
    expect(bundle.passportFetchDeps.providers).toBeDefined();
    expect(bundle.passportFetchDeps.serverIdentity).toBeTypeOf('function');
  });
});

describe('composePassportFetchSubstrate identity providers', () => {
  it('loadIdentity reads server and publisher keys fresh on every call', async () => {
    const serverA = makeKeypair('server-a');
    const publisherA = makeKeypair('publisher-a');
    const serverB = makeKeypair('server-b');
    const publisherB = makeKeypair('publisher-b');
    const { signingIdentity, serverIdentityKey, publisherIdentityKey } =
      makeSigningIdentity(serverA, publisherA);
    const bundle = composeDefined({ signingIdentity });

    const first = await bundle.passportFetchDeps.providers.loadIdentity();
    expect(first.server_public_key).toBe(serverA.public_key_b64);
    expect(first.server_identity_fingerprint).toBe(
      serverA.public_key_fingerprint,
    );
    // D-175: publisher_id == server fingerprint, sourced from the live key.
    expect(first.publisher_id).toBe(serverA.public_key_fingerprint);
    expect(first.publisher_identity_fingerprint).toBe(
      publisherA.public_key_fingerprint,
    );
    expect(serverIdentityKey).toHaveBeenCalledTimes(1);
    expect(publisherIdentityKey).toHaveBeenCalledTimes(1);

    serverIdentityKey.mockReturnValue(serverB);
    publisherIdentityKey.mockReturnValue(publisherB);

    const second = await bundle.passportFetchDeps.providers.loadIdentity();
    expect(second.server_public_key).toBe(serverB.public_key_b64);
    expect(second.server_identity_fingerprint).toBe(
      serverB.public_key_fingerprint,
    );
    expect(second.publisher_id).toBe(serverB.public_key_fingerprint);
    expect(second.publisher_identity_fingerprint).toBe(
      publisherB.public_key_fingerprint,
    );
    expect(serverIdentityKey).toHaveBeenCalledTimes(2);
    expect(publisherIdentityKey).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['without a materialised handle state machine', undefined],
    ['with a materialised but unreserved handle state machine', () => makeHandleStateMachine(null)],
  ])(
    'loadIdentity returns the expected field shape %s',
    async (_label, makeRef) => {
      const serverKey = makeKeypair('server-shape');
      const publisherKey = makeKeypair('publisher-shape');
      const { signingIdentity } = makeSigningIdentity(serverKey, publisherKey);
      const { certStack, getHandleStateMachineRef } = makeCertStack(
        undefined,
        makeRef?.(),
      );
      const bundle = composeDefined({ signingIdentity, certStack });

      const identity = await bundle.passportFetchDeps.providers.loadIdentity();

      expect(identity.server_public_key).toBe(serverKey.public_key_b64);
      expect(identity.server_identity_fingerprint).toBe(
        serverKey.public_key_fingerprint,
      );
      expect(identity.publisher_identity_fingerprint).toBe(
        publisherKey.public_key_fingerprint,
      );
      // D-175: publisher_id is the live server fingerprint regardless of
      // whether a handle is reserved — never the empty pre-reservation default.
      expect(identity.publisher_id).toBe(serverKey.public_key_fingerprint);
      expect(identity.current_handle).toBe('');
      expect(identity.handle_history).toEqual([]);
      expect(getHandleStateMachineRef).toHaveBeenCalledTimes(1);
    },
  );

  it('loadIdentity carries the reserved handle lineage, mapped to the passport subset', async () => {
    const serverKey = makeKeypair('server-lineage');
    const publisherKey = makeKeypair('publisher-lineage');
    const { signingIdentity } = makeSigningIdentity(serverKey, publisherKey);
    // The state's OWN publisher_id is deliberately a DIFFERENT value than the
    // live server fingerprint (the post-rotation-divergence case). The
    // passport must surface the LIVE key's fingerprint per D-175, never the
    // handle state's lagging field — assert both `=== serverFp` AND
    // `!== state.publisher_id` so a coincidental equality can't mask a
    // wrong-field return.
    const handleState: SyntheticHandleState = {
      publisher_id: 'sha256:stale-handle-state-publisher-id',
      current_handle: 'alice',
      handle_history: [
        {
          handle: 'old-handle',
          reserved_at: 100,
          released_at: 200,
          // Server-internal fields the passport subset must DROP.
          reason: 'changed',
          note: 'free-text note that may contain PII',
          transfer_counterparty_publisher_id: 'sha256:counterparty',
        },
        {
          // The live (current) row: no released_at.
          handle: 'alice',
          reserved_at: 200,
          reason: 'changed',
        },
      ],
    };
    const { certStack } = makeCertStack(
      undefined,
      makeHandleStateMachine(handleState),
    );
    const bundle = composeDefined({ signingIdentity, certStack });

    const identity = await bundle.passportFetchDeps.providers.loadIdentity();

    expect(identity.current_handle).toBe('alice');
    // Exact equality proves: reason/note/transfer_counterparty are dropped,
    // released_at is preserved when present and omitted when absent.
    expect(identity.handle_history).toEqual([
      { handle: 'old-handle', reserved_at: 100, released_at: 200 },
      { handle: 'alice', reserved_at: 200 },
    ]);
    // `toEqual` ignores undefined-valued keys, so assert the current row's
    // absent `released_at` is genuinely ABSENT (not `released_at: undefined`).
    expect(identity.handle_history[1]).not.toHaveProperty('released_at');
    // D-175: live fingerprint, NOT the handle state's stale publisher_id.
    expect(identity.publisher_id).toBe(serverKey.public_key_fingerprint);
    expect(identity.publisher_id).not.toBe(handleState.publisher_id);
  });

  it('loadIdentity omits a non-number released_at (malformed persisted row) from the signed passport', async () => {
    const serverKey = makeKeypair('server-bad-row');
    const publisherKey = makeKeypair('publisher-bad-row');
    const { signingIdentity } = makeSigningIdentity(serverKey, publisherKey);
    const handleState: SyntheticHandleState = {
      publisher_id: serverKey.public_key_fingerprint,
      current_handle: 'bob',
      handle_history: [
        {
          handle: 'bob',
          reserved_at: 1,
          // The SQLite store validator does not type-check released_at; a
          // corrupt row could carry a non-number. The mapper must NOT sign it
          // into the passport as a non-number released_at.
          released_at: 'not-a-number' as unknown as number,
          reason: 'changed',
        },
      ],
    };
    const { certStack } = makeCertStack(
      undefined,
      makeHandleStateMachine(handleState),
    );
    const bundle = composeDefined({ signingIdentity, certStack });

    const identity = await bundle.passportFetchDeps.providers.loadIdentity();

    expect(identity.handle_history).toEqual([{ handle: 'bob', reserved_at: 1 }]);
    expect(identity.handle_history[0]).not.toHaveProperty('released_at');
  });

  it('loadIdentity degrades to empty handle fields (keeping the live publisher_id) when current() rejects', async () => {
    const serverKey = makeKeypair('server-reject');
    const publisherKey = makeKeypair('publisher-reject');
    const { signingIdentity } = makeSigningIdentity(serverKey, publisherKey);
    // A materialised machine whose store read throws (e.g. SQLITE_BUSY) must
    // NOT fail the reconnect-time passport.fetch — the verify primitive reads
    // only server_public_key + cert_fingerprint, never the handle fields.
    const throwingHsm = {
      current: vi.fn(async () => {
        throw new Error('handle store read failed');
      }),
    };
    const { certStack } = makeCertStack(undefined, throwingHsm);
    const bundle = composeDefined({ signingIdentity, certStack });

    const identity = await bundle.passportFetchDeps.providers.loadIdentity();

    expect(identity.server_public_key).toBe(serverKey.public_key_b64);
    expect(identity.server_identity_fingerprint).toBe(
      serverKey.public_key_fingerprint,
    );
    expect(identity.publisher_id).toBe(serverKey.public_key_fingerprint);
    expect(identity.publisher_identity_fingerprint).toBe(
      publisherKey.public_key_fingerprint,
    );
    expect(identity.current_handle).toBe('');
    expect(identity.handle_history).toEqual([]);
    expect(throwingHsm.current).toHaveBeenCalledTimes(1);
  });

  it('serverIdentity getter reads the live server key on every invocation', () => {
    const serverA = makeKeypair('server-identity-a');
    const serverB = makeKeypair('server-identity-b');
    const { signingIdentity, serverIdentityKey } = makeSigningIdentity(serverA);
    const bundle = composeDefined({ signingIdentity });

    expect(bundle.passportFetchDeps.serverIdentity()).toBe(serverA);
    expect(serverIdentityKey).toHaveBeenCalledTimes(1);

    serverIdentityKey.mockReturnValue(serverB);

    expect(bundle.passportFetchDeps.serverIdentity()).toBe(serverB);
    expect(serverIdentityKey).toHaveBeenCalledTimes(2);
  });
});

describe('composePassportFetchSubstrate network provider', () => {
  it('loadNetwork reads the passport cert source, not the TLS cert source', async () => {
    const certSource = makeCertSource({
      fingerprint: 'fp1',
      valid_until: 1234567,
    });
    const { certStack, getPassportCertSourceRef, getTlsCertSourceRef } =
      makeCertStack(certSource);
    const bundle = composeDefined({ certStack });

    const network = await bundle.passportFetchDeps.providers.loadNetwork();

    expect(network.cert_fingerprint).toBe('fp1');
    expect(network.cert_expires_at).toBe(1234567);
    expect(getPassportCertSourceRef).toHaveBeenCalledTimes(1);
    expect(certSource.getCurrentCert).toHaveBeenCalledTimes(1);
    expect(getTlsCertSourceRef).not.toHaveBeenCalled();
  });

  it('loadNetwork returns empty-string and zero fallbacks when no passport cert source is present', async () => {
    const { certStack } = makeCertStack(undefined);
    const bundle = composeDefined({ certStack });

    const network = await bundle.passportFetchDeps.providers.loadNetwork();

    expect(network).toHaveProperty('cert_fingerprint', '');
    expect(network.cert_fingerprint).toBe('');
    expect(network.cert_fingerprint).not.toBeUndefined();
    expect(network.cert_expires_at).toBe(0);
  });

  it('loadNetwork returns empty-string and zero fallbacks when the passport cert source has no current cert', async () => {
    const certSource = makeCertSource(undefined);
    const { certStack } = makeCertStack(certSource);
    const bundle = composeDefined({ certStack });

    const network = await bundle.passportFetchDeps.providers.loadNetwork();

    expect(network).toHaveProperty('cert_fingerprint', '');
    expect(network.cert_fingerprint).toBe('');
    expect(network.cert_fingerprint).not.toBeUndefined();
    expect(network.cert_expires_at).toBe(0);
    expect(certSource.getCurrentCert).toHaveBeenCalledTimes(1);
  });

  it('loadNetwork resolves the passport cert source fresh on every call', async () => {
    const certSourceA = makeCertSource({
      fingerprint: 'fp-a',
      valid_until: 111,
    });
    const certSourceB = makeCertSource({
      fingerprint: 'fp-b',
      valid_until: 222,
    });
    const { certStack, getPassportCertSourceRef } = makeCertStack(certSourceA);
    const bundle = composeDefined({ certStack });

    const first = await bundle.passportFetchDeps.providers.loadNetwork();
    expect(first.cert_fingerprint).toBe('fp-a');
    expect(first.cert_expires_at).toBe(111);
    expect(certSourceA.getCurrentCert).toHaveBeenCalledTimes(1);

    getPassportCertSourceRef.mockReturnValue(certSourceB);

    const second = await bundle.passportFetchDeps.providers.loadNetwork();
    expect(second.cert_fingerprint).toBe('fp-b');
    expect(second.cert_expires_at).toBe(222);
    expect(getPassportCertSourceRef).toHaveBeenCalledTimes(2);
    expect(certSourceA.getCurrentCert).toHaveBeenCalledTimes(1);
    expect(certSourceB.getCurrentCert).toHaveBeenCalledTimes(1);
  });

  it('loadNetwork returns conservative defaults (DEFAULT_EXPOSURE_STATE) when no exposure machine is wired', async () => {
    const certSource = makeCertSource({
      fingerprint: 'fp-defaults',
      valid_until: 333,
    });
    const { certStack } = makeCertStack(certSource);
    const bundle = composeDefined({ certStack });

    expectConservativeNetworkDefaults(
      await bundle.passportFetchDeps.providers.loadNetwork(),
    );
    expectConservativeNetworkDefaults(
      await bundle.passportFetchDeps.providers.loadNetwork(),
    );
  });

  it('loadNetwork reflects the live exposure posture, not the lan_only stub', async () => {
    const certSource = makeCertSource({ fingerprint: 'fp-live', valid_until: 999 });
    const { certStack } = makeCertStack(certSource);
    // A non-default posture (public preset, /mcp public + acknowledged),
    // deliberately DIFFERENT from DEFAULT_EXPOSURE_STATE (lan_only) so a
    // regression back to the hardcoded stub would fail these assertions.
    // A full-PathRole non-default posture (distinct from DEFAULT_EXPOSURE_STATE's
    // lan_only) so a regression to the hardcoded stub fails — and the exact
    // per_path equality below proves EVERY role maps with no drop/add.
    const resolution: Record<PathRole, PathResolution> = {
      health: { lan: true, public: true },
      ws: { lan: true, public: true },
      mcp: { lan: true, public: true },
      llm_gateway: { lan: true, public: true },
      webhooks: { lan: true, public: true },
      reception: { lan: true, public: true },
      oauth: { lan: true, public: true },
      ask: { lan: true, public: false },
      webclient: { lan: true, public: false },
    };
    const exposure = makeExposureMachine({
      resolution,
      derived_preset_label: 'public',
      public_mcp_acknowledgement: { acknowledged: true },
      last_changed_at: 123,
      changed_by_client_id: 'wc_1',
    });
    const bundle = composeDefined({ certStack, getExposureMachine: () => exposure });

    const network = await bundle.passportFetchDeps.providers.loadNetwork();

    expect(network.derived_preset_label).toBe('public');
    expect(network.public_mcp_acknowledgement).toEqual({ acknowledged: true });
    // Exact full-Record equality: every PathRole maps to the live resolution,
    // no role dropped or fabricated.
    expect(network.per_path).toEqual({
      health: { resolution: { lan: true, public: true } },
      ws: { resolution: { lan: true, public: true } },
      mcp: { resolution: { lan: true, public: true } },
      llm_gateway: { resolution: { lan: true, public: true } },
      webhooks: { resolution: { lan: true, public: true } },
      reception: { resolution: { lan: true, public: true } },
      oauth: { resolution: { lan: true, public: true } },
      ask: { resolution: { lan: true, public: false } },
      webclient: { resolution: { lan: true, public: false } },
    });
    // cert stays wired from the cert source.
    expect(network.cert_fingerprint).toBe('fp-live');
    expect(exposure.current).toHaveBeenCalledTimes(1);
  });

  it('loadNetwork degrades to the conservative defaults when the exposure read rejects', async () => {
    const certSource = makeCertSource({ fingerprint: 'fp-fallback', valid_until: 555 });
    const { certStack } = makeCertStack(certSource);
    const throwingExposure = {
      current: vi.fn(async () => {
        throw new Error('exposure store read failed');
      }),
    };
    const bundle = composeDefined({
      certStack,
      getExposureMachine: () => throwingExposure,
    });

    const network = await bundle.passportFetchDeps.providers.loadNetwork();

    // Degrades to DEFAULT_EXPOSURE_STATE (lan_only) — must NOT throw, so the
    // reconnect-time passport.fetch survives a transient exposure-store error.
    expectConservativeNetworkDefaults(network);
    expect(network.derived_preset_label).toBe('lan_only');
    expect(network.public_mcp_acknowledgement).toEqual({ acknowledged: false });
    expect(network.cert_fingerprint).toBe('fp-fallback');
    expect(throwingExposure.current).toHaveBeenCalledTimes(1);
  });
});

describe('composePassportFetchSubstrate static providers', () => {
  it('loadClients returns an empty roster when no paired-instances store is wired', () => {
    const bundle = composeDefined();

    expect(bundle.passportFetchDeps.providers.loadClients()).toEqual([]);
  });

  it('loadClients maps the live paired-instances roster to passport client entries', () => {
    // A multi-kind roster with user_id + revoked_at present in the rows, so the
    // assertions prove user_id is DROPPED, revoked_at is omitted for active
    // rows, kind maps 1:1, and added_at (unix seconds) is normalised to ms.
    const store = makePairedInstancesStore([
      { instance_id: 'i-bridge', user_id: 'u1', display_name: 'My Bridge', kind: 'bridge', added_at: 1_700_000_000, revoked_at: null },
      { instance_id: 'i-web', user_id: 'u1', display_name: 'Laptop', kind: 'webclient', added_at: 1_700_000_100, revoked_at: null },
      { instance_id: 'i-cli', user_id: 'u2', display_name: 'CI box', kind: 'cli', added_at: 1_700_000_200, revoked_at: null },
    ]);
    const bundle = composeDefined({ pairedInstances: store });

    const clients = bundle.passportFetchDeps.providers.loadClients();

    expect(clients).toEqual([
      { client_id: 'i-bridge', client_kind: 'bridge', client_label: 'My Bridge', paired_at: 1_700_000_000_000 },
      { client_id: 'i-web', client_kind: 'webclient', client_label: 'Laptop', paired_at: 1_700_000_100_000 },
      { client_id: 'i-cli', client_kind: 'cli', client_label: 'CI box', paired_at: 1_700_000_200_000 },
    ]);
    // user_id never rides in the passport entry.
    expect(clients[0]).not.toHaveProperty('user_id');
    expect(store.listAllActive).toHaveBeenCalledTimes(1);
  });

  it('loadClients degrades to an empty roster when listAllActive throws', () => {
    const throwingStore = {
      listAllActive: vi.fn(() => {
        throw new Error('paired-instances read failed');
      }),
    };
    const bundle = composeDefined({ pairedInstances: throwingStore });

    // Must NOT throw — a transient store error degrades the reconnect-time
    // passport.fetch to an empty roster rather than failing it.
    expect(bundle.passportFetchDeps.providers.loadClients()).toEqual([]);
    expect(throwingStore.listAllActive).toHaveBeenCalledTimes(1);
  });

  it('loadCapabilities returns conservative local capability defaults', () => {
    const bundle = composeDefined();

    expect(bundle.passportFetchDeps.providers.loadCapabilities()).toEqual({
      software_version: 'recued',
      os: process.platform,
      arch: process.arch,
      storage_size_bytes: 0,
      ai_pool_configured: false,
      byok_slots_configured: 0,
      scheduled_recipes_count: 0,
      reactive_recipes_count: 0,
      installed_packs: [],
      connections: [],
    });
  });

  it('loadRecovery returns unconfigured recovery defaults', () => {
    const bundle = composeDefined();

    expect(bundle.passportFetchDeps.providers.loadRecovery()).toEqual({
      backup_status: 'unconfigured',
      filevault_recovery_key_status: 'absent',
    });
  });

  it('loadKeyHealth marks every key surface healthy', () => {
    const bundle = composeDefined();

    expect(bundle.passportFetchDeps.providers.loadKeyHealth()).toEqual({
      master_dek: { status: 'healthy' },
      sub_dek: { status: 'healthy' },
      server_identity_key: { status: 'healthy' },
      publisher_identity_key: { status: 'healthy' },
      tls_private_key: { status: 'healthy' },
      webclient_token: { status: 'healthy' },
      webhook_secret: { status: 'healthy' },
    });
  });
});

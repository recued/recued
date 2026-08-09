/** Pro DDNS certificate enrollment — the background job that makes a paid
 *  server's hostname actually work without a human adding it by hand.
 *
 *  ⛔ THE GAP (measured 2026-08-06). A user signs up, connects their account,
 *  and the server reserves `<handle>.recued.net` and publishes its A record in
 *  seconds. Then nothing: Settings → Hostnames is EMPTY and no certificate is
 *  ever ordered. Swept every `.upsert(` call site server-wide — the only
 *  writers of a hostname row are the three user-facing `collection.hostname.*`
 *  rpcs, first issuance lives inside `.add`, and the renewal task skips
 *  un-provisioned handles by design. So the enrollment stale window was not the
 *  6h renewal cooldown; it was UNBOUNDED.
 *
 *  The two steps are asserted separately because they fail independently: the
 *  row appearing is the only thing the USER can see, and it must survive an
 *  issuer that is not ready yet.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  composeProCertEnrollment,
  PRO_CERT_ENROLLMENT_BACKOFF_START_MS,
} from '../composition/bin/wire-pro-cert-enrollment.js';
import {
  createInMemoryHandleStateStore,
  type HandleState,
} from '../handle/index.js';
import type { HostnameRegistryStore, HostnameRegistryUpsertInput } from '../storage/hostname-registry.js';
/** Derived from the exported interface — the row/projection types are
 *  declared but not exported, and deriving keeps the fake pinned to the
 *  real signatures rather than a hand-copied shape. */
type RegistryRow = ReturnType<HostnameRegistryStore['get']> & {};
type RegistryProjection = ReturnType<HostnameRegistryStore['upsert']>;
import type { InitialAcmeDomainIssuer } from '../keys/rotation/acme-domain-renewer.js';
import type {
  BackgroundServiceRegistry,
  IntervalServiceSpec,
} from '../composition/bin/wire-background-services.js';

const ACTIVE: HandleState = {
  publisher_id: 'pub_1',
  current_handle: 'alice',
  handle_history: [],
  subscription_state: 'active',
  last_synced_at: 1_700_000_000_000,
};
const HOST = 'alice.recued.net';

/** A registry that behaves like the real one for the two fields this reads. */
const fakeRegistry = () => {
  const rows = new Map<string, RegistryRow>();
  return {
    rows,
    get: vi.fn((h: string): RegistryRow | null => rows.get(h) ?? null),
    upsert: vi.fn((input: HostnameRegistryUpsertInput): RegistryProjection => {
      const prev = rows.get(input.hostname) ?? {};
      rows.set(input.hostname, {
        // ⚠ Supplied rather than cast away. HostnameStorageRow requires these
        // four; a blanket `as` would hide the next field the real row gains,
        // which is exactly how this fake fell behind in the first place.
        hostname_normalized: input.hostname.toLowerCase(),
        tls_topology: 'server_terminated',
        created_at: 0,
        updated_at: 0,
        hostname_id: 'hid_1',
        ...prev,
        ...input,
      } as RegistryRow);
      return rows.get(input.hostname) as unknown as RegistryProjection;
    }),
  } satisfies Pick<HostnameRegistryStore, 'get' | 'upsert'> & { rows: Map<string, RegistryRow> };
};

const build = (opts: {
  handleState?: HandleState | null;
  issuer?: InitialAcmeDomainIssuer | undefined;
  identity?: string | undefined;
  vaultUnlocked?: () => boolean;
  lateHandle?: boolean;
}) => {
  let spec: IntervalServiceSpec | null = null;
  const registry: BackgroundServiceRegistry = {
    register: vi.fn(),
    registerInterval: vi.fn((s: IntervalServiceSpec) => { spec = s; return vi.fn(); }),
    stopAll: vi.fn(async () => {}),
    list: vi.fn(() => []),
  };
  const hostnameRegistry = fakeRegistry();
  let clock = 1_800_000_000_000;
  // A store that is EMPTY until `land()` — the sibling provisioner's reserve
  // completing mid-boot, which is the real sequence.
  let lateState: HandleState | null = null;
  const store = opts.lateHandle === true
    ? { load: async () => lateState, save: async (st: HandleState) => { lateState = st; } }
    : createInMemoryHandleStateStore(
        opts.handleState === undefined ? { ...ACTIVE } : (opts.handleState ?? undefined),
      );
  composeProCertEnrollment({
    registry,
    handleStateStore: store,
    ...(opts.vaultUnlocked ? { isVaultUnlocked: opts.vaultUnlocked } : {}),
    hostnameRegistry,
    getInitialAcmeIssuer: () => opts.issuer,
    serverIdentityId: () => (opts.identity === undefined ? 'srv_1' : opts.identity),
    now: () => clock,
  });
  if (!spec) throw new Error('not registered');
  return {
    spec: spec as IntervalServiceSpec,
    hostnameRegistry,
    advance: (ms: number) => { clock += ms; },
    landHandle: () => { lateState = { ...ACTIVE }; },
  };
};

const okIssuer = (): InitialAcmeDomainIssuer => ({
  issueInitialDomain: vi.fn(async () => ({
    ok: true as const,
    new_fingerprint: 'sha256:abc',
    cert_expires_at: 1_900_000_000_000,
  })),
});
const failingIssuer = (): InitialAcmeDomainIssuer => ({
  issueInitialDomain: vi.fn(async () => ({
    ok: false as const,
    reason: 'helper_unavailable' as const,
  })),
});

beforeEach(() => vi.restoreAllMocks());

describe('Pro cert enrollment', () => {
  it('creates the hostname row so the user SEES something pending', async () => {
    const { spec, hostnameRegistry } = build({ issuer: okIssuer() });

    await spec.tick();

    const row = hostnameRegistry.rows.get(HOST);
    expect(row).toBeDefined();
    expect(row?.cert_source).toBe('recued_acme');
    expect(row?.ddns_managed).toBe(true);
    // The reservation IS the ownership proof for a Recued-controlled zone.
    expect(row?.ownership_status).toBe('verified');
  });

  it('orders the certificate and persists the fingerprint', async () => {
    const issuer = okIssuer();
    const { spec, hostnameRegistry } = build({ issuer });

    await spec.tick();

    expect(issuer.issueInitialDomain).toHaveBeenCalledWith({ domain: HOST });
    expect(hostnameRegistry.rows.get(HOST)?.cert_fingerprint).toBe('sha256:abc');
  });

  it('still creates the row when the issuer is NOT ready', async () => {
    // The cert stack fills its issuer ref late. The row must appear anyway —
    // it is the only user-visible signal that provisioning has begun, and
    // withholding it would make a working server look idle.
    const { spec, hostnameRegistry } = build({ issuer: undefined });

    await spec.tick();

    expect(hostnameRegistry.rows.get(HOST)).toBeDefined();
    expect(hostnameRegistry.rows.get(HOST)?.cert_fingerprint).toBeUndefined();
  });

  it('does NOT re-order once a certificate exists', async () => {
    const issuer = okIssuer();
    const { spec } = build({ issuer });

    await spec.tick();
    await spec.tick();
    await spec.tick();

    // Idempotent: a provisioned row is left alone, so ticking forever costs
    // nothing and burns no CA quota.
    expect(issuer.issueInitialDomain).toHaveBeenCalledTimes(1);
  });

  it('backs off after a failure — CAs rate-limit FAILED validations', async () => {
    const issuer = failingIssuer();
    const { spec, advance } = build({ issuer });

    await spec.tick();
    expect(issuer.issueInitialDomain).toHaveBeenCalledTimes(1);

    // Retrying every tick would burn LE's 5-failures-per-hour limit and turn a
    // transient DNS miss into a hard block.
    await spec.tick();
    await spec.tick();
    expect(issuer.issueInitialDomain).toHaveBeenCalledTimes(1);

    advance(PRO_CERT_ENROLLMENT_BACKOFF_START_MS + 1_000);
    await spec.tick();
    expect(issuer.issueInitialDomain).toHaveBeenCalledTimes(2);
  });

  it('does nothing for a LAPSED subscription — the cloud already pulled the records', async () => {
    const issuer = okIssuer();
    const { spec, hostnameRegistry } = build({
      handleState: { ...ACTIVE, subscription_state: 'grace' },
      issuer,
    });

    await spec.tick();

    // DNS-01 cannot validate against a pulled record, so every attempt would
    // burn CA quota to fail.
    expect(hostnameRegistry.rows.size).toBe(0);
    expect(issuer.issueInitialDomain).not.toHaveBeenCalled();
  });

  /** ⛔ `fireImmediate` runs INSIDE the boot path. Owner call: it must still be
   *  effectively after vault-unlock and after a handle exists — a sealed server
   *  cannot read its own handle store, has no signing identity, and any work
   *  attempted there is wasted or wrong. */
  it('does NOTHING while the vault is sealed', async () => {
    const issuer = okIssuer();
    const { spec, hostnameRegistry } = build({ issuer, vaultUnlocked: () => false });

    await spec.tick();

    expect(hostnameRegistry.rows.size).toBe(0);
    expect(issuer.issueInitialDomain).not.toHaveBeenCalled();
  });

  it('resumes once the vault unlocks', async () => {
    let unlocked = false;
    const issuer = okIssuer();
    const { spec, hostnameRegistry } = build({ issuer, vaultUnlocked: () => unlocked });

    await spec.tick();
    expect(hostnameRegistry.rows.size).toBe(0);

    unlocked = true;
    await spec.tick();
    expect(hostnameRegistry.rows.get(HOST)).toBeDefined();
  });

  /** Same defect the DDNS poller had: the handle is reserved by a SIBLING timer
   *  ~26s after boot, so the one immediate fire is spent on a tick that cannot
   *  succeed. Without a warm-up the row — the only user-visible signal — would
   *  not appear until a full interval later. */
  it('warms up until the handle lands, instead of waiting a whole interval', async () => {
    vi.useFakeTimers();
    try {
      const { spec, hostnameRegistry, landHandle } = build({
        issuer: okIssuer(),
        lateHandle: true,
      });

      await spec.tick();                       // boot: reserve still in flight
      expect(hostnameRegistry.rows.size).toBe(0);

      landHandle();                            // provisioner finishes
      await vi.advanceTimersByTimeAsync(2_500); // warm-up re-tick, NOT the 5min cadence
      expect(hostnameRegistry.rows.get(HOST)).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  /** ⛔ THE REGISTRY DOES NOT SERIALIZE TICKS — `wire-background-services.ts`
   *  `runTick` calls `spec.tick()` unconditionally; its `inFlight` set only
   *  drains on shutdown. An issuance runs the cloud's 45s hold plus up to its
   *  150s budget plus CA time, close enough to the 5-minute interval to
   *  overlap, and the 2s warm-up re-ticks make a re-entry cheaper still. A
   *  re-entrant tick would order a SECOND certificate for one hostname, and
   *  CAs rate-limit failed validations, so both can end up blocked.
   *
   *  The backoff cannot cover this: `retryAfter` is set only AFTER a failure
   *  returns, so a concurrent tick reads 0 and proceeds. */
  it('does NOT re-enter while an issuance is still in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const issueInitialDomain = vi.fn(async () => {
      await gate;
      return { ok: true as const, new_fingerprint: 'fp', cert_expires_at: 1 };
    });
    const { spec } = build({ issuer: { issueInitialDomain } });

    const first = spec.tick();          // enters, blocks inside the issuer
    await Promise.resolve();
    await spec.tick();                  // must be a no-op
    await spec.tick();

    expect(issueInitialDomain).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  /** ⚠ The flag is released in `finally`, not at the end of `try`. Every
   *  precondition gate above returns EARLY, so releasing at the end of the
   *  happy path would wedge enrollment for the life of the process the first
   *  time a tick ran while sealed or handle-less — which is every boot. */
  it('releases the guard when a precondition gate returns early', async () => {
    let unlocked = false;
    const issuer = okIssuer();
    const { spec, hostnameRegistry } = build({ issuer, vaultUnlocked: () => unlocked });

    await spec.tick();                  // early return: vault sealed
    unlocked = true;
    await spec.tick();                  // must NOT be blocked by a stuck flag

    expect(hostnameRegistry.rows.get(HOST)).toBeDefined();
  });

  /** ⛔ THE SAME DEFECT AS THE DDNS FIRST-PUBLISH BUG, ONE LAYER UP. The cert
   *  stack fills its issuer ref in `composeLate`, which lands AFTER this
   *  service's `fireImmediate` tick — so the immediate fire is spent on a tick
   *  that cannot succeed. Without a warm-up the first certificate waits a full
   *  5-minute interval on a brand-new Pro server, at exactly the moment the
   *  user is watching Hostnames. Measured live: an unlocked server logged
   *  nothing at all for the whole observation window. */
  it('warms up until the ACME issuer is composed, instead of waiting an interval', async () => {
    vi.useFakeTimers();
    try {
      let issuer: InitialAcmeDomainIssuer | undefined;
      const made = okIssuer();
      const { spec, hostnameRegistry } = build({ issuer: undefined });
      // Rebuild with a late-arriving issuer via the same lazy getter shape the
      // composition root uses.
      void hostnameRegistry;
      void spec;

      let spec2: IntervalServiceSpec | null = null;
      const registry: BackgroundServiceRegistry = {
        register: vi.fn(),
        registerInterval: vi.fn((sp: IntervalServiceSpec) => { spec2 = sp; return vi.fn(); }),
        stopAll: vi.fn(async () => {}),
        list: vi.fn(() => []),
      };
      const rows = fakeRegistry();
      composeProCertEnrollment({
        registry,
        handleStateStore: createInMemoryHandleStateStore({ ...ACTIVE }),
        hostnameRegistry: rows,
        getInitialAcmeIssuer: () => issuer,     // undefined at first
        serverIdentityId: () => 'srv_1',
      });
      const s2 = spec2 as unknown as IntervalServiceSpec;

      await s2.tick();                          // boot: issuer not composed yet
      expect(made.issueInitialDomain).not.toHaveBeenCalled();
      // The row must still appear — it is the only user-visible signal.
      expect(rows.rows.get(HOST)).toBeDefined();

      issuer = made;                            // composeLate lands
      await vi.advanceTimersByTimeAsync(2_500); // warm-up re-tick, NOT 5 min
      expect(made.issueInitialDomain).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing before a handle is reserved', async () => {
    const issuer = okIssuer();
    const { spec, hostnameRegistry } = build({ handleState: null, issuer });

    await spec.tick();

    expect(hostnameRegistry.rows.size).toBe(0);
    expect(issuer.issueInitialDomain).not.toHaveBeenCalled();
  });
});

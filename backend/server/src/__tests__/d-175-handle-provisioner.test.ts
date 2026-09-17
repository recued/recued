/** D-175 — Pro-convenience handle provisioner (the server-half actuator).
 *
 *  The gating matrix + the load-bearing invariant: the publisher_id the
 *  actuator reserves with is ALWAYS `serverIdentity().public_key_fingerprint`
 *  (the exact `sha256:<hex>`), never a caller-supplied value, and the
 *  reservation is gated on the binding-entitlement resolver (fail closed).
 */

import { describe, it, expect, vi } from 'vitest';

import {
  generateEd25519Keypair,
  type StoredAccountBinding,
} from '../keys/index.js';
import type {
  ChangeHandleArgs,
  HandleState,
  HandleStateMachine,
  HandleStateMachineResult,
  ReReserveHandleArgs,
  ReserveHandleArgs,
} from '../handle/index.js';
import type {
  HandleChangeResponse,
  HandleReserveResponse,
} from '@recued/contracts';
import {
  provisionHandleFromBinding,
  PRO_CONVENIENCE_PROVISIONER_CLIENT_ID,
  type ProvisionHandleDeps,
} from '../pro-convenience/handle-provisioner.js';
import {
  type ProEntitlementResolution,
  type ProEntitlementSource,
} from '../pro-convenience/entitlement-source.js';

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

/** A real server-identity fingerprint (`sha256:<hex>` of SPKI-DER) — the
 *  canonical publisher_id under the D-175 identity contract. */
const FINGERPRINT = generateEd25519Keypair('server_identity_key')
  .public_key_fingerprint;

const mkBinding = (
  over: Partial<StoredAccountBinding> = {},
): StoredAccountBinding => ({
  account_id: 'acct_A',
  publisher_handle: 'alice',
  server_scoped_credential: 'secret-credential-never-read-here',
  server_fingerprint: FINGERPRINT,
  bound_at: 1,
  credential_issued_at: 1,
  ...over,
});

const reservedState = (
  publisher_id = FINGERPRINT,
  current_handle = 'alice',
): HandleState => ({
  publisher_id,
  current_handle,
  handle_history: [],
  subscription_state: 'active',
  last_synced_at: 1,
});

const fixedEntitlement = (
  r: ProEntitlementResolution,
): ProEntitlementSource => ({ resolve: vi.fn(async () => r) });

type HandleMachineView = Pick<
  HandleStateMachine,
  'current' | 'reserveInitial' | 'changeHandle' | 'reReserve'
>;

interface HandleFake {
  machine: HandleMachineView;
  current: ReturnType<typeof vi.fn>;
  reserveInitial: ReturnType<typeof vi.fn>;
  changeHandle: ReturnType<typeof vi.fn>;
  reReserve: ReturnType<typeof vi.fn>;
}

const okReserve: HandleStateMachineResult<HandleReserveResponse> = {
  ok: true,
  state: reservedState(),
  data: { reserved_at: 1, handle: 'alice', state: 'active' },
};

const okChange: HandleStateMachineResult<HandleChangeResponse> = {
  ok: true,
  state: reservedState(),
  data: {
    released_handle: 'alice',
    reserved_handle: 'bob',
    reserved_at: 1,
    soft_redirect_until: 2,
  },
};

const mkHandle = (opts: {
  current?: HandleState | null;
  reserve?: HandleStateMachineResult<HandleReserveResponse>;
  /** Result for the rebind corrective (cloud `change`). */
  change?: HandleStateMachineResult<HandleChangeResponse>;
  /** Result for the rotation corrective (cloud `reserve` re-anchor). */
  reReserve?: HandleStateMachineResult<HandleReserveResponse>;
}): HandleFake => {
  const current = vi.fn(async () => opts.current ?? null);
  const reserveInitial = vi.fn(async (_args: ReserveHandleArgs) =>
    opts.reserve ?? okReserve,
  );
  const changeHandle = vi.fn(async (_args: ChangeHandleArgs) =>
    opts.change ?? okChange,
  );
  const reReserve = vi.fn(async (_args: ReReserveHandleArgs) =>
    opts.reReserve ?? okReserve,
  );
  // The spies keep their Mock type for `.mock.calls` assertions; the
  // machine view is the plain `Pick<HandleStateMachine,...>` the
  // provisioner consumes (vitest 4's Mock type carries a spurious
  // construct signature that blocks a direct structural assignment).
  const machine = {
    current,
    reserveInitial,
    changeHandle,
    reReserve,
  } as unknown as HandleMachineView;
  return { machine, current, reserveInitial, changeHandle, reReserve };
};

const baseDeps = (
  over: Omit<Partial<ProvisionHandleDeps>, 'handle'> & { handle: HandleFake },
): ProvisionHandleDeps => {
  // Destructure `handle` out so the `...rest` spread can't overwrite the
  // `handle.machine` view with the raw HandleFake.
  const { handle, ...rest } = over;
  return {
    serverFingerprint: () => FINGERPRINT,
    loadBinding: () => mkBinding(),
    entitlement: fixedEntitlement({ state: 'entitled' }),
    handle: handle.machine,
    ...rest,
  };
};

// ────────────────────────────────────────────────────────────────
// The happy path — the contract assertion
// ────────────────────────────────────────────────────────────────

describe('D-175 handle provisioner — reservation', () => {
  it('reserves with publisher_id == the exact serverIdentity fingerprint', async () => {
    const handle = mkHandle({ current: null });
    const out = await provisionHandleFromBinding(baseDeps({ handle }));

    expect(out).toEqual({
      outcome: 'reserved',
      handle: 'alice',
      publisher_id: FINGERPRINT,
    });
    expect(handle.reserveInitial).toHaveBeenCalledTimes(1);
    const args = handle.reserveInitial.mock.calls[0]![0] as ReserveHandleArgs;
    // The load-bearing invariant — the publisher_id SENT is the live
    // server-identity fingerprint, an exact `sha256:<hex>`.
    expect(args.publisher_id).toBe(FINGERPRINT);
    expect(args.publisher_id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(args.handle).toBe('alice');
    expect(args.changed_by_client_id).toBe(PRO_CONVENIENCE_PROVISIONER_CLIENT_ID);
  });

  it('ignores any binding-side handle name drift — reserves the binding handle, fingerprint publisher_id', async () => {
    const handle = mkHandle({ current: null });
    await provisionHandleFromBinding(
      baseDeps({
        handle,
        loadBinding: () => mkBinding({ publisher_handle: 'bob' }),
      }),
    );
    const args = handle.reserveInitial.mock.calls[0]![0] as ReserveHandleArgs;
    expect(args.handle).toBe('bob');
    expect(args.publisher_id).toBe(FINGERPRINT);
  });
});

// ────────────────────────────────────────────────────────────────
// Gating matrix — skip / fail-closed
// ────────────────────────────────────────────────────────────────

describe('D-175 handle provisioner — gating', () => {
  it('unbound (null binding) → skipped, no entitlement round-trip', async () => {
    const handle = mkHandle({ current: null });
    const entitlement = fixedEntitlement({ state: 'entitled' });
    const out = await provisionHandleFromBinding(
      baseDeps({ handle, loadBinding: () => null, entitlement }),
    );
    expect(out).toEqual({ outcome: 'skipped', reason: 'unbound' });
    expect(handle.reserveInitial).not.toHaveBeenCalled();
    expect(entitlement.resolve).not.toHaveBeenCalled();
  });

  it('loadBinding throw (pre-boot) → skipped/unbound', async () => {
    const handle = mkHandle({ current: null });
    const out = await provisionHandleFromBinding(
      baseDeps({
        handle,
        loadBinding: () => {
          throw new Error('not_ready');
        },
      }),
    );
    expect(out).toEqual({ outcome: 'skipped', reason: 'unbound' });
    expect(handle.reserveInitial).not.toHaveBeenCalled();
  });

  it('bound but no publisher_handle → skipped/no_publisher_handle', async () => {
    const handle = mkHandle({ current: null });
    const out = await provisionHandleFromBinding(
      baseDeps({
        handle,
        loadBinding: () => mkBinding({ publisher_handle: undefined }),
      }),
    );
    expect(out).toEqual({ outcome: 'skipped', reason: 'no_publisher_handle' });
    expect(handle.reserveInitial).not.toHaveBeenCalled();
  });

  it('empty publisher_handle → skipped/no_publisher_handle', async () => {
    const handle = mkHandle({ current: null });
    const out = await provisionHandleFromBinding(
      baseDeps({
        handle,
        loadBinding: () => mkBinding({ publisher_handle: '' }),
      }),
    );
    expect(out).toEqual({ outcome: 'skipped', reason: 'no_publisher_handle' });
  });

  it('binding anchored to a rotated-away identity → skipped/fingerprint_mismatch', async () => {
    const handle = mkHandle({ current: null });
    const out = await provisionHandleFromBinding(
      baseDeps({
        handle,
        loadBinding: () => mkBinding({ server_fingerprint: 'sha256:stale' }),
      }),
    );
    expect(out).toEqual({ outcome: 'skipped', reason: 'fingerprint_mismatch' });
    expect(handle.reserveInitial).not.toHaveBeenCalled();
  });

  /** ⛔⛔ THIS TEST USED TO ASSERT THE OPPOSITE, AND THE ASSERTION IT LOST WAS
   *  THE BUG. It read "short-circuits before the entitlement round-trip" and
   *  pinned `entitlement.resolve` as NOT called — a cloud round-trip saved on the
   *  steady-state tick, which is the common one.
   *
   *  ⛔ THAT SAVING COST THE ONLY MOMENT A RENAME IS VISIBLE. The account's
   *  handle is the cloud's fact, and the binding's copy of it is written once, at
   *  the exchange. Skipping the mint meant the comparison below had nothing but
   *  that stale copy to compare against — so it compared the old name to the old
   *  name, said `already_reserved`, and a renamed account never moved its DNS
   *  record. The dashboard told the owner it had.
   *
   *  🔑 SO THE MINT IS NOW DELIBERATE, AND IS PINNED HERE AS SUCH — a future
   *  reader who sees a redundant-looking round-trip in the no-op path and
   *  "optimises" it away reintroduces a silent, user-visible defect. The cost is
   *  one mint per 5-minute tick against a Worker that already mints on every
   *  status render. */
  it('already reserved → already_reserved, but STILL mints (the rename channel)', async () => {
    const handle = mkHandle({ current: reservedState() });
    const entitlement = fixedEntitlement({ state: 'entitled' });
    const out = await provisionHandleFromBinding(
      baseDeps({ handle, entitlement }),
    );
    expect(out).toEqual({
      outcome: 'already_reserved',
      handle: 'alice',
      publisher_id: FINGERPRINT,
      // ⚠ The outcome now says whether the cloud confirmed us this tick. It has
      // to: the same outcome is returned for a reconnected server and for one
      // whose cloud is unreachable, and two callers act oppositely on that.
      entitlement_confirmed: true,
    });
    expect(handle.reserveInitial).not.toHaveBeenCalled();
    expect(handle.changeHandle).not.toHaveBeenCalled();
    expect(handle.reReserve).not.toHaveBeenCalled();
    expect(
      entitlement.resolve,
      'the steady-state tick is the ONLY place a rename can be noticed',
    ).toHaveBeenCalled();
    // ⚠ Exactly once. Two resolves in one tick double the cloud traffic AND can
    // read different handles, so the tick would target one and gate on another.
    expect(entitlement.resolve).toHaveBeenCalledTimes(1);
  });

  it('rebind to a different handle (identity stable) self-heals via change → corrected/change', async () => {
    // Same identity, but the binding now points at a different handle (a
    // confirmed rebind to an account whose publisher_handle changed). The
    // persisted reservation is for 'alice'; the live binding wants 'bob'.
    // The live fingerprint already owns 'alice' at the cloud → change.
    const handle = mkHandle({ current: reservedState(FINGERPRINT, 'alice') });
    const out = await provisionHandleFromBinding(
      baseDeps({
        handle,
        loadBinding: () => mkBinding({ publisher_handle: 'bob' }),
      }),
    );
    expect(out).toEqual({
      outcome: 'corrected',
      via: 'change',
      handle: 'bob',
      publisher_id: FINGERPRINT,
    });
    // Drove the change RPC toward the binding handle — NOT reserve/reReserve.
    expect(handle.changeHandle).toHaveBeenCalledTimes(1);
    expect(
      (handle.changeHandle.mock.calls[0]![0] as ChangeHandleArgs).next_handle,
    ).toBe('bob');
    expect(handle.reReserve).not.toHaveBeenCalled();
    expect(handle.reserveInitial).not.toHaveBeenCalled();
  });

  it('handle state under a rotated-away fingerprint self-heals via re-reserve → corrected/re_reserve', async () => {
    // Identity rotated + rebound: the binding is anchored to the LIVE
    // fingerprint (step 3 passes), but the persisted handle state still
    // carries the OLD publisher_id. Re-anchor under the live fingerprint.
    const stale = reservedState(`sha256:${'a'.repeat(64)}`, 'alice');
    const handle = mkHandle({ current: stale });
    const out = await provisionHandleFromBinding(baseDeps({ handle }));
    expect(out).toEqual({
      outcome: 'corrected',
      via: 're_reserve',
      handle: 'alice',
      publisher_id: FINGERPRINT,
    });
    expect(handle.reReserve).toHaveBeenCalledTimes(1);
    const args = handle.reReserve.mock.calls[0]![0] as ReReserveHandleArgs;
    // The load-bearing invariant — the publisher_id re-anchored TO is the
    // live server-identity fingerprint, never the rotated-away one.
    expect(args.publisher_id).toBe(FINGERPRINT);
    expect(args.publisher_id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(args.handle).toBe('alice');
    expect(handle.changeHandle).not.toHaveBeenCalled();
    expect(handle.reserveInitial).not.toHaveBeenCalled();
  });

  it('stale state + NOT entitled → fail closed (entitlement skip), no corrective attempted', async () => {
    const handle = mkHandle({ current: reservedState(FINGERPRINT, 'alice') });
    const out = await provisionHandleFromBinding(
      baseDeps({
        handle,
        loadBinding: () => mkBinding({ publisher_handle: 'bob' }),
        entitlement: fixedEntitlement({ state: 'not_entitled' }),
      }),
    );
    expect(out).toEqual({ outcome: 'skipped', reason: 'entitlement_not_entitled' });
    expect(handle.changeHandle).not.toHaveBeenCalled();
    expect(handle.reReserve).not.toHaveBeenCalled();
  });

  it('rebind corrective cloud rejection → reserve_failed, surfaced for retry', async () => {
    const handle = mkHandle({
      current: reservedState(FINGERPRINT, 'alice'),
      change: {
        ok: false,
        error: 'handle_taken',
        message: 'Pro subscription required',
      },
    });
    const out = await provisionHandleFromBinding(
      baseDeps({
        handle,
        loadBinding: () => mkBinding({ publisher_handle: 'bob' }),
      }),
    );
    expect(out).toEqual({
      outcome: 'reserve_failed',
      reason: 'handle_taken',
      message: 'Pro subscription required',
    });
    expect(handle.changeHandle).toHaveBeenCalledTimes(1);
    // A subscription-lapsed change is a clean retry — NOT a partial-success,
    // so the idempotent reReserve fallback must not fire.
    expect(handle.reReserve).not.toHaveBeenCalled();
  });

  it('rebind change fails with the old handle already gone (partial-crash) → reReserve fallback catches local state up → corrected', async () => {
    // A crash between a successful cloud change and the local persist: the
    // retry's change 409s `handle_transfer_handle_unowned` because the old
    // handle was already released. The reReserve fallback idempotently
    // re-claims the binding handle the cloud already owns.
    const handle = mkHandle({
      current: reservedState(FINGERPRINT, 'alice'),
      change: { ok: false, error: 'handle_transfer_handle_unowned' },
      reReserve: {
        ok: true,
        state: reservedState(FINGERPRINT, 'bob'),
        data: { reserved_at: 1, handle: 'bob', state: 'active' },
      },
    });
    const out = await provisionHandleFromBinding(
      baseDeps({
        handle,
        loadBinding: () => mkBinding({ publisher_handle: 'bob' }),
      }),
    );
    expect(out).toEqual({
      outcome: 'corrected',
      via: 're_reserve',
      handle: 'bob',
      publisher_id: FINGERPRINT,
    });
    expect(handle.changeHandle).toHaveBeenCalledTimes(1);
    expect(handle.reReserve).toHaveBeenCalledTimes(1);
    expect(
      (handle.reReserve.mock.calls[0]![0] as ReReserveHandleArgs).publisher_id,
    ).toBe(FINGERPRINT);
  });

  it('rebind partial-crash recovery where the fallback reReserve also fails → reserve_failed', async () => {
    const handle = mkHandle({
      current: reservedState(FINGERPRINT, 'alice'),
      change: { ok: false, error: 'handle_authority_handle_mismatch' },
      reReserve: { ok: false, error: 'handle_taken' },
    });
    const out = await provisionHandleFromBinding(
      baseDeps({
        handle,
        loadBinding: () => mkBinding({ publisher_handle: 'bob' }),
      }),
    );
    expect(out).toEqual({ outcome: 'reserve_failed', reason: 'handle_taken' });
    expect(handle.changeHandle).toHaveBeenCalledTimes(1);
    expect(handle.reReserve).toHaveBeenCalledTimes(1);
  });

  it('rotation corrective stranded old reservation (cloud handle_taken) → reserve_failed', async () => {
    // The real-cloud gap: auth:<new fingerprint> exists, but the old
    // reservation is still pinned to the rotated-away publisher_id, so the
    // re-reserve 409s until the rebind/grace flow migrates it. Surfaced for
    // retry — the provisioner self-heals on a later tick once it frees up.
    const handle = mkHandle({
      current: reservedState(`sha256:${'a'.repeat(64)}`, 'alice'),
      reReserve: { ok: false, error: 'handle_taken' },
    });
    const out = await provisionHandleFromBinding(baseDeps({ handle }));
    expect(out).toEqual({ outcome: 'reserve_failed', reason: 'handle_taken' });
    expect(handle.reReserve).toHaveBeenCalledTimes(1);
  });

  it('terminal state with no active handle (transferred-out / released) → skipped/no_active_handle, no corrective', async () => {
    // The state machine keeps publisher_id non-empty but empties
    // current_handle after a transfer-out or a lifecycle release. The
    // provisioner must NOT post an empty current_handle through change.
    const handle = mkHandle({ current: reservedState(FINGERPRINT, '') });
    const out = await provisionHandleFromBinding(baseDeps({ handle }));
    expect(out).toEqual({ outcome: 'skipped', reason: 'no_active_handle' });
    expect(handle.changeHandle).not.toHaveBeenCalled();
    expect(handle.reReserve).not.toHaveBeenCalled();
    expect(handle.reserveInitial).not.toHaveBeenCalled();
  });

  it('terminal (no-handle) state under a rotated-away identity → skipped/no_active_handle (never resurrects a released handle)', async () => {
    // Empty-handle guard fires BEFORE the identity branch, so a rotated-away
    // terminal state is left alone rather than re-reserved.
    const handle = mkHandle({ current: reservedState(`sha256:${'a'.repeat(64)}`, '') });
    const out = await provisionHandleFromBinding(baseDeps({ handle }));
    expect(out).toEqual({ outcome: 'skipped', reason: 'no_active_handle' });
    expect(handle.reReserve).not.toHaveBeenCalled();
    expect(handle.changeHandle).not.toHaveBeenCalled();
  });

  it.each([
    ['not_entitled', 'entitlement_not_entitled'],
    ['pending', 'entitlement_pending'],
    ['unavailable', 'entitlement_unavailable'],
    ['unbound', 'entitlement_unbound'],
  ] as const)(
    'entitlement %s → fail closed (skipped/%s), no reservation',
    async (state, reason) => {
      const handle = mkHandle({ current: null });
      const resolution =
        state === 'pending'
          ? { state, reason: 'entitlement_endpoint_pending' as const }
          : state === 'unavailable'
            ? { state, reason: 'x' }
            : { state };
      const out = await provisionHandleFromBinding(
        baseDeps({
          handle,
          entitlement: fixedEntitlement(resolution as ProEntitlementResolution),
        }),
      );
      expect(out).toEqual({ outcome: 'skipped', reason });
      expect(handle.reserveInitial).not.toHaveBeenCalled();
    },
  );

  /** ⚠ RETARGETED 2026-08-30. This drove a fake cloud returning
   *  `handle_subscription_lapsed` and was titled "(subscription lapsed)" — a scenario the
   *  real cloud can no longer produce, since the handle endpoints' Pro gate was lifted
   *  (a handle is free with any account; Pro buys DDNS + the certificate). A fake
   *  returning an unreachable code tests the propagation but ADVERTISES a policy that no
   *  longer exists, and reads to the next person as if it does. `handle_taken` is a
   *  rejection the cloud genuinely returns, so the propagation is exercised against
   *  something real. */
  it('cloud reserve rejection (handle taken) → reserve_failed, surfaced for retry', async () => {
    const handle = mkHandle({
      current: null,
      reserve: {
        ok: false,
        error: 'handle_taken',
        message: 'handle already reserved by another publisher',
      },
    });
    const out = await provisionHandleFromBinding(baseDeps({ handle }));
    expect(out).toEqual({
      outcome: 'reserve_failed',
      reason: 'handle_taken',
      message: 'handle already reserved by another publisher',
    });
    // It DID attempt — the publisher_id was correct; the cloud flag gated.
    expect(handle.reserveInitial).toHaveBeenCalledTimes(1);
    expect(
      (handle.reserveInitial.mock.calls[0]![0] as ReserveHandleArgs).publisher_id,
    ).toBe(FINGERPRINT);
  });
});

/** THE RENAME FINALLY REACHING THE SERVER.
 *
 *  ⛔⛔⛔ THE WHOLE FEATURE WAS ONE STALE FIELD. A dashboard rename wrote
 *  `publishers.id` and stopped: the cloud's owner record and the server's binding
 *  both keep a `publisher_handle` written once, at the exchange, and nothing
 *  refreshed either. So this provisioner compared the old name against the old
 *  name, returned `already_reserved`, and the DNS record never moved — while the
 *  rename dialog told the owner it had, and told them to re-point their paired
 *  browser at a hostname that would never exist.
 *
 *  🔑 THE MACHINERY WAS ALL PRESENT. `changeHandle` works, and the cloud sets a
 *  24h `soft_redirect_until` when it runs. The only missing piece was a fresh,
 *  TRUSTWORTHY answer to "what is this account called now" — which is why the
 *  handle rides inside the signed claim rather than beside it.
 */
describe('D-175 — a renamed handle migrates the hostname', () => {
  const entitledWith = (publisher_handle?: string): ProEntitlementSource =>
    fixedEntitlement({
      state: 'entitled',
      ...(publisher_handle !== undefined ? { publisher_handle } : {}),
    });

  it('moves the hostname when the claim names a handle the binding has never heard of', async () => {
    // Local state + binding both still say `alice`; only the claim knows `bob`.
    const handle = mkHandle({ current: reservedState(FINGERPRINT, 'alice') });
    const out = await provisionHandleFromBinding(
      baseDeps({
        handle,
        loadBinding: () => mkBinding({ publisher_handle: 'alice' }),
        entitlement: entitledWith('bob'),
      }),
    );

    expect(out).toMatchObject({ outcome: 'corrected', via: 'change', handle: 'bob' });
    expect(handle.changeHandle).toHaveBeenCalledTimes(1);
    expect(handle.changeHandle.mock.calls[0]![0]).toMatchObject({ next_handle: 'bob' });
  });

  /** ⚠ THE FALLBACK IS THE COMMON CASE, NOT AN EDGE ONE — every account that has
   *  never renamed, plus every server talking to a cloud older than the field.
   *  Overriding with `undefined` would strand all of them on
   *  `no_publisher_handle` and tear down working DDNS. */
  it.each([
    ['the claim carries no handle', undefined],
  ])('falls back to the binding when %s', async (_label, claimHandle) => {
    const handle = mkHandle({ current: reservedState(FINGERPRINT, 'alice') });
    const out = await provisionHandleFromBinding(
      baseDeps({
        handle,
        loadBinding: () => mkBinding({ publisher_handle: 'alice' }),
        entitlement: entitledWith(claimHandle),
      }),
    );
    expect(out).toMatchObject({ outcome: 'already_reserved', handle: 'alice' });
    expect(handle.changeHandle).not.toHaveBeenCalled();
  });

  /** ⛔ A SERVER THAT CANNOT REACH THE CLOUD MUST NOT TEAR DOWN ITS OWN DNS.
   *  `unavailable` carries no handle, so the binding snapshot stands and the tick
   *  is a no-op — the failure mode of the opposite reading is that a transient
   *  network fault renames everybody to nothing. */
  it('an unavailable mint leaves the existing hostname exactly where it is', async () => {
    const handle = mkHandle({ current: reservedState(FINGERPRINT, 'alice') });
    const out = await provisionHandleFromBinding(
      baseDeps({
        handle,
        loadBinding: () => mkBinding({ publisher_handle: 'alice' }),
        entitlement: fixedEntitlement({ state: 'unavailable', reason: 'network' }),
      }),
    );
    expect(handle.changeHandle).not.toHaveBeenCalled();
    expect(out).toMatchObject({ outcome: 'already_reserved', handle: 'alice' });
  });

  /** ⚠ AND THE FRESH NAME MUST REACH THE INITIAL RESERVE TOO, not just the
   *  corrective. A server that was renamed BEFORE it ever reserved would
   *  otherwise claim the old name and immediately need correcting. */
  it('a first reserve uses the renamed handle, not the binding snapshot', async () => {
    const handle = mkHandle({ current: null });
    await provisionHandleFromBinding(
      baseDeps({
        handle,
        loadBinding: () => mkBinding({ publisher_handle: 'alice' }),
        entitlement: entitledWith('bob'),
      }),
    );
    expect(handle.reserveInitial).toHaveBeenCalledTimes(1);
    expect(handle.reserveInitial.mock.calls[0]![0]).toMatchObject({ handle: 'bob' });
  });
});

/** ⛔⛔⛔ THE DETECTOR DID NOT FIRE IN THE COMMON CASE, AND RE-ARMED INSTEAD.
 *
 *  A healthy server — bound, handle reserved, local state matching — is the
 *  steady state, and it is exactly the shape that gets unbound. On the next tick
 *  the entitlement resolved to `disowned` at step 2 and was then DISCARDED: the
 *  `already_reserved` fast path returns before any entitlement gate, by design,
 *  because it is a no-op shortcut.
 *
 *  So the provisioning loop saw `already_reserved`, read it as a healthy tick,
 *  and called `rearmDisconnect()` — clearing the announcement mark on a server
 *  the cloud had just disowned. The detector never announced, and it undid the
 *  OTHER detector's announcement, which is the double-notification the whole
 *  seam exists to prevent.
 *
 *  🔑 `already_reserved` NEVER PROVED ENTITLEMENT. It proves local state matches
 *  the binding — nothing more. Reading it as "the cloud confirmed us" is the
 *  category error.
 */
describe('D-175 — a disowned server is reported, not mistaken for healthy', () => {
  it('reports disowned even when local state matches perfectly', async () => {
    const handle = mkHandle({ current: reservedState(FINGERPRINT, 'alice') });
    const out = await provisionHandleFromBinding(
      baseDeps({
        handle,
        loadBinding: () => mkBinding({ publisher_handle: 'alice' }),
        entitlement: fixedEntitlement({ state: 'disowned' }),
      }),
    );

    expect(
      out,
      'the steady-state fast path swallowed the disconnection',
    ).toEqual({ outcome: 'skipped', reason: 'entitlement_disowned' });
    // ⚠ And it must not have touched the cloud — every call would fail anyway.
    expect(handle.changeHandle).not.toHaveBeenCalled();
    expect(handle.reserveInitial).not.toHaveBeenCalled();
  });

  /** ⚠ AND BEFORE THE HANDLE CHECKS, for the same reason the cloud reports
   *  retirement before its handle gates: a disowned server's handle state is
   *  beside the point, and `no_publisher_handle` would hide the real answer from
   *  a server that never got as far as reserving one. */
  it('reports disowned even with no handle to provision', async () => {
    const out = await provisionHandleFromBinding(
      baseDeps({
        handle: mkHandle({ current: null }),
        loadBinding: () => mkBinding({ publisher_handle: '' }),
        entitlement: fixedEntitlement({ state: 'disowned' }),
      }),
    );
    expect(out).toEqual({ outcome: 'skipped', reason: 'entitlement_disowned' });
  });
});

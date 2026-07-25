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

  it('already reserved → already_reserved, short-circuits before the entitlement round-trip', async () => {
    const handle = mkHandle({ current: reservedState() });
    const entitlement = fixedEntitlement({ state: 'entitled' });
    const out = await provisionHandleFromBinding(
      baseDeps({ handle, entitlement }),
    );
    expect(out).toEqual({
      outcome: 'already_reserved',
      handle: 'alice',
      publisher_id: FINGERPRINT,
    });
    expect(handle.reserveInitial).not.toHaveBeenCalled();
    expect(handle.changeHandle).not.toHaveBeenCalled();
    expect(handle.reReserve).not.toHaveBeenCalled();
    expect(entitlement.resolve).not.toHaveBeenCalled();
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
        error: 'handle_subscription_lapsed',
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
      reason: 'handle_subscription_lapsed',
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

  it('cloud reserve rejection (subscription lapsed) → reserve_failed, surfaced for retry', async () => {
    const handle = mkHandle({
      current: null,
      reserve: {
        ok: false,
        error: 'handle_subscription_lapsed',
        message: 'Pro subscription required',
      },
    });
    const out = await provisionHandleFromBinding(baseDeps({ handle }));
    expect(out).toEqual({
      outcome: 'reserve_failed',
      reason: 'handle_subscription_lapsed',
      message: 'Pro subscription required',
    });
    // It DID attempt — the publisher_id was correct; the cloud flag gated.
    expect(handle.reserveInitial).toHaveBeenCalledTimes(1);
    expect(
      (handle.reserveInitial.mock.calls[0]![0] as ReserveHandleArgs).publisher_id,
    ).toBe(FINGERPRINT);
  });
});

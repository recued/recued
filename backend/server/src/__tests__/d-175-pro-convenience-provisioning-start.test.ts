/** D-175 — Pro-convenience provisioning starter (the registration glue).
 *
 *  Verifies the thin wiring: it registers a background tick ONLY when the
 *  cert stack composed the handle machine + entitlement source AND an
 *  identity is booted (dbless / daemon-only → clean no-op), and that the
 *  registered tick drives the provisioner with the LIVE server fingerprint.
 *  The provisioner's own gating matrix lives in `d-175-handle-provisioner`.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  generateEd25519Keypair,
  type Ed25519Keypair,
  type StoredAccountBinding,
} from '../keys/index.js';
import type {
  HandleState,
  HandleStateMachine,
  ReserveHandleArgs,
} from '../handle/index.js';
import type { HandleReserveResponse } from '@recued/contracts';
import type { BootedServerIdentity } from '../identity/boot.js';
import type { CertStack } from '../composition/bin/wire-cert-stack.js';
import type { ProEntitlementSource } from '../pro-convenience/entitlement-source.js';
import { createServerDisownedFlag } from '../pro-convenience/disconnect-announcer.js';
import { startProConvenienceProvisioning } from '../serve/start-pro-convenience-provisioning.js';

const KP: Ed25519Keypair = generateEd25519Keypair('server_identity_key');
const FINGERPRINT = KP.public_key_fingerprint;

const mkIdentity = (
  binding: StoredAccountBinding | null,
): BootedServerIdentity =>
  ({
    identity: { serverIdentityKey: () => KP },
    keyStore: { loadAccountBinding: () => binding },
  }) as unknown as BootedServerIdentity;

const okReserve = {
  ok: true as const,
  state: undefined,
  data: { reserved_at: 1, handle: 'alice', state: 'active' as const },
} satisfies { ok: true; state?: HandleState; data: HandleReserveResponse };

const mkHandleMachine = () => {
  const reserveInitial = vi.fn(async (_args: ReserveHandleArgs) => okReserve);
  const current = vi.fn(async (): Promise<HandleState | null> => null);
  const machine = { current, reserveInitial } as unknown as Pick<
    HandleStateMachine,
    'current' | 'reserveInitial'
  >;
  return { machine, reserveInitial, current };
};

const entitled: ProEntitlementSource = {
  async resolve() {
    return { state: 'entitled' };
  },
};

interface CapturedInterval {
  name: string;
  intervalMs: number;
  fireImmediate?: boolean;
  tick: () => Promise<void> | void;
}

const mkRegistry = () => {
  const intervals: CapturedInterval[] = [];
  const registerInterval = vi.fn((spec: CapturedInterval) => {
    intervals.push(spec);
    return () => {};
  });
  return { intervals, registerInterval };
};

const mkCertStack = (
  over: Partial<
    Pick<CertStack, 'getHandleStateMachineRef' | 'getBindingEntitlementSource'>
  >,
): Pick<CertStack, 'getHandleStateMachineRef' | 'getBindingEntitlementSource'> => ({
  getHandleStateMachineRef: () => undefined,
  getBindingEntitlementSource: () => undefined,
  ...over,
});

describe('D-175 startProConvenienceProvisioning — registration gating', () => {
  it('registers a fireImmediate timer when handle machine + entitlement + identity are all present', () => {
    const registry = mkRegistry();
    const { machine } = mkHandleMachine();
    startProConvenienceProvisioning({
      backgroundServices: registry as never,
      certStack: mkCertStack({
        getHandleStateMachineRef: () => machine as HandleStateMachine,
        getBindingEntitlementSource: () => entitled,
      }),
      getSigningIdentity: () => mkIdentity(null),
    });
    expect(registry.registerInterval).toHaveBeenCalledTimes(1);
    expect(registry.intervals[0]!.name).toBe('pro-convenience-provision');
    expect(registry.intervals[0]!.fireImmediate).toBe(true);
  });

  it.each([
    ['no handle machine (dbless)', { getBindingEntitlementSource: () => entitled }],
    ['no entitlement source', {}],
  ] as const)('skips registration when %s', (_label, over) => {
    const registry = mkRegistry();
    startProConvenienceProvisioning({
      backgroundServices: registry as never,
      certStack: mkCertStack(over),
      getSigningIdentity: () => mkIdentity(null),
    });
    expect(registry.registerInterval).not.toHaveBeenCalled();
  });

  it('skips registration when no identity is booted', () => {
    const registry = mkRegistry();
    const { machine } = mkHandleMachine();
    startProConvenienceProvisioning({
      backgroundServices: registry as never,
      certStack: mkCertStack({
        getHandleStateMachineRef: () => machine as HandleStateMachine,
        getBindingEntitlementSource: () => entitled,
      }),
      getSigningIdentity: () => undefined,
    });
    expect(registry.registerInterval).not.toHaveBeenCalled();
  });
});

describe('D-175 startProConvenienceProvisioning — the registered tick', () => {
  it('drives the provisioner with the live fingerprint publisher_id', async () => {
    const registry = mkRegistry();
    const { machine, reserveInitial } = mkHandleMachine();
    const binding: StoredAccountBinding = {
      account_id: 'acct',
      publisher_handle: 'alice',
      server_scoped_credential: 'secret',
      server_fingerprint: FINGERPRINT,
      bound_at: 1,
      credential_issued_at: 1,
    };
    startProConvenienceProvisioning({
      backgroundServices: registry as never,
      certStack: mkCertStack({
        getHandleStateMachineRef: () => machine as HandleStateMachine,
        getBindingEntitlementSource: () => entitled,
      }),
      getSigningIdentity: () => mkIdentity(binding),
    });

    // The promise is returned to the lifecycle registry so shutdown can
    // drain a reservation already in flight.
    const run = registry.intervals[0]!.tick();
    expect(run).toBeInstanceOf(Promise);
    await run;
    expect(reserveInitial).toHaveBeenCalledTimes(1);
    expect(
      (reserveInitial.mock.calls[0]![0] as ReserveHandleArgs).publisher_id,
    ).toBe(FINGERPRINT);
  });
});

/** ⛔⛔ THE SKIP-REASON SUPPRESSION IS FOR A STEADY STATE, AND IT USED TO
 *  OUTLIVE ONE. `lastSkipReason` was set on the first skip and never cleared,
 *  so a server that provisioned and then lost the cloud logged
 *  `entitlement_unavailable` exactly ONCE PER PROCESS and went quiet — the
 *  "non-provisioning Pro server indistinguishable from a healthy one" state the
 *  starter's own comment records as having cost a live drive hours.
 *
 *  🔑 NOTHING COVERED THE SUPPRESSION AT ALL, which is why the hole was
 *  invisible: deleting the whole `lastSkipReason` branch reddened nothing. The
 *  test drives the sequence that distinguishes the two behaviours — skip, skip,
 *  SUCCEED, skip — because a run that never succeeds in between cannot tell
 *  them apart. */
describe('D-175 startProConvenienceProvisioning — skip-reason logging', () => {
  const mkFlippingEntitlement = (): ProEntitlementSource & { entitled: boolean } => {
    const src = {
      entitled: false,
      async resolve() {
        return src.entitled
          ? ({ state: 'entitled' } as const)
          : ({ state: 'unavailable', reason: 'entitlement_mint_unavailable' } as const);
      },
    };
    return src as ProEntitlementSource & { entitled: boolean };
  };

  it('speaks again when the same reason returns after a tick that got through', async () => {
    const registry = mkRegistry();
    const { machine, reserveInitial } = mkHandleMachine();
    const entitlement = mkFlippingEntitlement();
    const binding: StoredAccountBinding = {
      account_id: 'acct',
      publisher_handle: 'alice',
      server_scoped_credential: 'secret',
      server_fingerprint: FINGERPRINT,
      bound_at: 1,
      credential_issued_at: 1,
    };
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      startProConvenienceProvisioning({
        backgroundServices: registry as never,
        certStack: mkCertStack({
          getHandleStateMachineRef: () => machine as HandleStateMachine,
          getBindingEntitlementSource: () => entitlement,
        }),
        getSigningIdentity: () => mkIdentity(binding),
      });
      const tick = registry.intervals[0]!.tick;
      const skips = (): string[] =>
        info.mock.calls
          .map((c) => String(c[0]))
          .filter((m) => m.includes('[pro-convenience-provision] skipped:'));

      await tick();
      expect(skips(), 'the first skip must say why').toHaveLength(1);
      await tick();
      expect(skips(), 'an unchanged steady state stays quiet').toHaveLength(1);

      entitlement.entitled = true;
      await tick();
      expect(reserveInitial, 'the middle tick must actually get through').toHaveBeenCalledTimes(1);

      entitlement.entitled = false;
      await tick();
      expect(
        skips(),
        'the reason returned after a successful tick — that is news, not a repeat',
      ).toHaveLength(2);
      expect(skips()[1]).toContain('entitlement_unavailable');
    } finally {
      info.mockRestore();
    }
  });
});

/** ⛔⛔⛔ THE LOOP READ A STEADY-STATE NO-OP AS "THE CLOUD CONFIRMED US".
 *
 *  `already_reserved` was in the re-arm list. It is the fast path taken when
 *  local state matches the binding, and it returns WITHOUT consulting
 *  entitlement — so it proves local agreement, nothing more. Reading it as proof
 *  of connection cleared the disconnect mark on a server the cloud had just
 *  disowned, which is how ONE disconnection becomes a notification per restart:
 *  the mark cleared here, the other detector announced again next boot.
 *
 *  🔑 The two outcomes that DO prove it each drove a cloud call standing behind
 *  the entitlement gate. That is the whole distinction.
 */
describe('D-175 startProConvenienceProvisioning — announcing and re-arming', () => {
  const bindingFor = (publisher_handle: string): StoredAccountBinding => ({
    account_id: 'acct',
    publisher_handle,
    server_scoped_credential: 'secret',
    server_fingerprint: FINGERPRINT,
    bound_at: 1,
    credential_issued_at: 1,
  });

  const runTick = async (opts: {
    entitlement: ProEntitlementSource;
    current?: HandleState | null;
    /** ⛔ START DISOWNED WHEN THE TEST IS ABOUT CLEARING IT. The flag defaults
     *  to false, so asserting `isDisowned() === false` after a tick passes
     *  whether or not anything cleared it — vacuous for exactly the mutation it
     *  was written to catch. Found by deleting `markConnected()` and watching it
     *  stay green. */
    startDisowned?: boolean;
  }) => {
    const registry = mkRegistry();
    const reserveInitial = vi.fn(async (_args: ReserveHandleArgs) => okReserve);
    const current = vi.fn(async (): Promise<HandleState | null> => opts.current ?? null);
    const machine = { current, reserveInitial } as unknown as HandleStateMachine;
    const announceDisconnect = vi.fn(async () => true);
    const rearmDisconnect = vi.fn();
    const disownedFlag = createServerDisownedFlag();
    if (opts.startDisowned) disownedFlag.markDisowned();

    startProConvenienceProvisioning({
      backgroundServices: registry as never,
      certStack: mkCertStack({
        getHandleStateMachineRef: () => machine,
        getBindingEntitlementSource: () => opts.entitlement,
      }),
      getSigningIdentity: () => mkIdentity(bindingFor('alice')),
      announceDisconnect,
      rearmDisconnect,
      disownedFlag,
    });

    await registry.intervals[0]!.tick();
    return { announceDisconnect, rearmDisconnect, disownedFlag };
  };

  const disowned: ProEntitlementSource = {
    async resolve() { return { state: 'disowned' }; },
  };

  it('announces when the cloud says the server is disowned', async () => {
    const { announceDisconnect, rearmDisconnect } = await runTick({ entitlement: disowned });
    expect(announceDisconnect).toHaveBeenCalledWith('entitlement_mint');
    expect(rearmDisconnect).not.toHaveBeenCalled();
  });

  /** ⛔ THE REGRESSION, IN THE SHAPE THAT PRODUCED IT: a healthy-looking server
   *  whose local state matches — the steady state, and exactly the shape that
   *  gets unbound. It must announce, and it must NOT re-arm. */
  it('announces even when local state matches the binding perfectly', async () => {
    const { announceDisconnect, rearmDisconnect } = await runTick({
      entitlement: disowned,
      current: {
        publisher_id: FINGERPRINT,
        current_handle: 'alice',
        handle_history: [],
        subscription_state: 'active',
        last_synced_at: 1,
      },
    });
    expect(
      announceDisconnect,
      'the steady-state fast path swallowed the disconnection',
    ).toHaveBeenCalledWith('entitlement_mint');
    expect(
      rearmDisconnect,
      're-armed on a disowned server — the mark clears and the next boot nags again',
    ).not.toHaveBeenCalled();
  });

  /** ⛔⛔⛔ THE MIRROR BUG OF THE LAST FIX. Excluding `already_reserved` from the
   *  re-arm outright stopped it re-arming on a disowned server — and broke the
   *  reconnection path, because after a reconnect the local state is UNCHANGED,
   *  so every tick returns exactly that outcome. The mark would never clear and
   *  the next genuine disconnection would be silent.
   *
   *  🔑 The outcome now carries whether entitlement was confirmed, so the two
   *  cases are told apart by a FACT rather than by guessing which outcome implies
   *  what. Same outcome, opposite meanings, and it had to say which. */
  it('re-arms on a reconnected steady state, and clears the DDNS stand-down', async () => {
    const { announceDisconnect, rearmDisconnect, disownedFlag } = await runTick({
      entitlement: entitled,
      // The state a reconnection actually starts from: the flag was set by
      // whichever detector noticed the disconnection.
      startDisowned: true,
      current: {
        publisher_id: FINGERPRINT,
        current_handle: 'alice',
        handle_history: [],
        subscription_state: 'active',
        last_synced_at: 1,
      },
    });
    expect(
      rearmDisconnect,
      'after a reconnect the mark never clears — the next disconnection is silent',
    ).toHaveBeenCalled();
    expect(
      disownedFlag.isDisowned(),
      'the DDNS poller stays stood down until a restart',
    ).toBe(false);
    expect(announceDisconnect).not.toHaveBeenCalled();
  });

  it('marks the shared flag when disowned, so the DDNS poller stands down too', async () => {
    const { disownedFlag } = await runTick({ entitlement: disowned });
    expect(disownedFlag.isDisowned()).toBe(true);
  });

  /** ⚠ AND A REAL RESERVE DOES RE-ARM: it stands behind the entitlement gate, so
   *  reaching it means the cloud confirmed ownership this tick. */
  it('re-arms on an outcome that required an entitled resolution', async () => {
    const { announceDisconnect, rearmDisconnect } = await runTick({ entitlement: entitled });
    expect(rearmDisconnect).toHaveBeenCalled();
    expect(announceDisconnect).not.toHaveBeenCalled();
  });

  /** ⛔⛔ THE CASE THE RE-ARM NARROWING ACTUALLY PROTECTS, and the one my first
   *  pass left untested — found by putting `already_reserved` back in the list
   *  and watching nothing go red.
   *
   *  A network blip with local state already matching takes the fast path and
   *  returns `already_reserved` WITHOUT consulting entitlement. With that outcome
   *  in the re-arm list, every blip clears the disconnect mark — so a genuinely
   *  disconnected server that blips once would be announced again on the next
   *  detection. The mark must only be cleared by an outcome that PROVED the
   *  cloud confirmed ownership, and this one proves only local agreement. */
  it('a blip with matching local state does not re-arm, though it looks healthy', async () => {
    const { announceDisconnect, rearmDisconnect } = await runTick({
      entitlement: { async resolve() { return { state: 'unavailable', reason: 'network' }; } },
      current: {
        publisher_id: FINGERPRINT,
        current_handle: 'alice',
        handle_history: [],
        subscription_state: 'active',
        last_synced_at: 1,
      },
    });
    expect(announceDisconnect).not.toHaveBeenCalled();
    expect(
      rearmDisconnect,
      'already_reserved proves local agreement, never that the cloud confirmed us',
    ).not.toHaveBeenCalled();
  });

  /** ⛔ AND A TRANSIENT FAILURE DOES NEITHER. `unavailable` is a network blip;
   *  announcing would be a false alarm and re-arming would let the next blip
   *  re-notify. */
  it('a transient mint failure neither announces nor re-arms', async () => {
    const { announceDisconnect, rearmDisconnect } = await runTick({
      entitlement: { async resolve() { return { state: 'unavailable', reason: 'network' }; } },
    });
    expect(announceDisconnect).not.toHaveBeenCalled();
    expect(rearmDisconnect).not.toHaveBeenCalled();
  });
});

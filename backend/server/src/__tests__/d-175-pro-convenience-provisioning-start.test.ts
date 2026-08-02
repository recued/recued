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

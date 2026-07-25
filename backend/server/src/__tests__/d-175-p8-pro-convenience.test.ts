/** D-175 P8 — Pro convenience wiring (server-side DDNS/ACME off the
 *  binding credential).
 *
 *  The gate per `factory/dispatch/d175-p8-pro-convenience-backend.md`:
 *    - the entitlement-gated decision engine (Pro ∧ bound ∧ reachable),
 *      across every branch incl. the typed `pending` boundary (the cloud
 *      entitlement-mint endpoint is the flagged gap → stub fails closed);
 *    - the secret-free wire (the credential held upstream NEVER appears in
 *      the status response — mirrors `manager.summarize()`);
 *    - the rpc handler: registered-client gate + `not_configured` when
 *      absent;
 *    - the contracts ratchets (`pro_convenience.` reserved from MCP;
 *      method registered).
 */

import { generateKeyPairSync, sign as nodeSign, type KeyObject } from 'node:crypto';

import { describe, it, expect, vi } from 'vitest';
import {
  MCP_RESERVED_RPC_PREFIXES,
  isReservedLocalRpc,
  isMcpToolName,
  SERVER_RPC_METHOD_SET,
  PRO_CONVENIENCE_ITEM_STATES,
  PRO_CONVENIENCE_ENTITLEMENTS,
  PRO_CONVENIENCE_RPC_METHODS,
  PRO_ENTITLEMENT_CLAIM_PURPOSE,
  PRO_ENTITLEMENT_TIERS,
  type AccountBindingStatusResponse,
} from '@recued/contracts';

import {
  createProConvenienceProvisioner,
  type ProConvenienceProvisionerDeps,
  type ProvisionedConvenienceSnapshot,
} from '../pro-convenience/provisioner.js';
import {
  createHttpProEntitlementSource,
  createPendingProEntitlementSource,
  type ProEntitlementResolution,
  type ProEntitlementSource,
} from '../pro-convenience/entitlement-source.js';
import { makeProConvenienceHandlers } from '../pro-convenience-handler.js';
import { createAccountBindingManager } from '../account-binding/manager.js';
import type { StoredAccountBinding } from '../keys/index.js';
import { createRpcDispatcher } from '../rpc-dispatcher.js';
import type { WsClient } from '../ws-server.js';

// ────────────────────────────────────────────────────────────────
// Fakes
// ────────────────────────────────────────────────────────────────

const bound = (
  account_id = 'acct_A',
  publisher_handle: string | undefined = 'alice',
): AccountBindingStatusResponse => ({
  status: 'bound',
  binding: {
    account_id,
    ...(publisher_handle !== undefined ? { publisher_handle } : {}),
    server_fingerprint: 'sha256:ff',
    bound_at: 1,
  },
});

const unbound: AccountBindingStatusResponse = { status: 'unbound', binding: null };

const fixedEntitlement = (r: ProEntitlementResolution): ProEntitlementSource => ({
  async resolve() {
    return r;
  },
});

interface EntitlementSigningFixture {
  privateKey: KeyObject;
  public_key_b64: string;
}

const makeEntitlementSigningFixture = (): EntitlementSigningFixture => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    public_key_b64: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64'),
  };
};

const b64urlJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

const mintEntitlementClaim = (
  key: KeyObject,
  claims: Record<string, unknown>,
): string => {
  const payload = b64urlJson(claims);
  const signingInput = `proent.v1.${payload}`;
  const sig = nodeSign(null, Buffer.from(signingInput, 'utf8'), key).toString('base64url');
  return `${signingInput}.${sig}`;
};

const storedBinding = (
  over: Partial<StoredAccountBinding> = {},
): StoredAccountBinding => ({
  account_id: 'acct_A',
  publisher_handle: 'alice',
  server_scoped_credential: 'SECRET-credential',
  server_fingerprint: 'sha256:ff',
  bound_at: 1,
  credential_issued_at: 1,
  ...over,
});

const fetchJson = (
  body: unknown,
  status = 200,
): typeof fetch =>
  vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch;

const make = (
  over: Partial<ProConvenienceProvisionerDeps> = {},
) =>
  createProConvenienceProvisioner({
    readBinding: () => bound(),
    entitlement: createPendingProEntitlementSource(),
    now: () => 1_000,
    ...over,
  });

// ────────────────────────────────────────────────────────────────
// Provisioner — gate matrix
// ────────────────────────────────────────────────────────────────

describe('D-175 P8 — provisioner gate', () => {
  it('unbound → every item awaiting-server (the binding is the prerequisite)', async () => {
    const s = await make({ readBinding: () => unbound }).status();
    expect(s.entitlement).toBe('unbound');
    for (const k of ['handle', 'ddns', 'acme'] as const) {
      expect(s.items[k].state).toBe('awaiting-server');
      expect(s.items[k].detail).toBe('no_binding');
    }
    // No bound account → no account fields leaked.
    expect(s.account_id).toBeUndefined();
  });

  it('readBinding throwing (pre-boot not_ready) → awaiting-server (no crash)', async () => {
    const s = await make({
      readBinding: () => {
        throw new Error('not_ready');
      },
    }).status();
    expect(s.entitlement).toBe('unbound');
    expect(s.items.handle.state).toBe('awaiting-server');
  });

  it('bound + the PENDING stub → every item pending (the typed cloud-seam gap)', async () => {
    const s = await make().status();
    expect(s.entitlement).toBe('pending');
    expect(s.account_id).toBe('acct_A');
    expect(s.publisher_handle).toBe('alice');
    expect(s.ddns_hostname).toBe('alice.recued.net');
    for (const k of ['handle', 'ddns', 'acme'] as const) {
      expect(s.items[k].state).toBe('pending');
      expect(s.items[k].detail).toBe('entitlement_endpoint_pending');
    }
  });

  it('bound + not_entitled (Free account) → inactive-free (Pro is friction-reduction only)', async () => {
    const s = await make({
      entitlement: fixedEntitlement({ state: 'not_entitled' }),
    }).status();
    expect(s.entitlement).toBe('not_entitled');
    expect(s.items.acme.state).toBe('inactive-free');
    expect(s.items.acme.detail).toBe('free_account');
  });

  it('bound + entitlement unavailable → fail closed to error (NOT a fabricated active)', async () => {
    const s = await make({
      entitlement: fixedEntitlement({ state: 'unavailable', reason: 'network' }),
    }).status();
    expect(s.entitlement).toBe('unavailable');
    for (const k of ['handle', 'ddns', 'acme'] as const) {
      expect(s.items[k].state).toBe('error');
      expect(s.items[k].detail).toBe('entitlement_unavailable');
    }
  });

  it('entitled + NOT reachable → awaiting-reachability (issuance waits for the reachability proof)', async () => {
    const s = await make({
      entitlement: fixedEntitlement({ state: 'entitled' }),
      readReachability: async () => ({ reachable: false }),
      readProvisioned: async () => ({ handle_reserved: true }),
    }).status();
    expect(s.entitlement).toBe('entitled');
    expect(s.items.handle.state).toBe('awaiting-reachability');
    expect(s.items.handle.detail).toBe('not_reachable');
  });

  it('entitled + reachable but no reachability reader → awaiting-reachability (conservative default)', async () => {
    const s = await make({
      entitlement: fixedEntitlement({ state: 'entitled' }),
      // readReachability absent
    }).status();
    expect(s.items.ddns.state).toBe('awaiting-reachability');
  });

  it('entitled + reachable + fully provisioned → active (handle + ddns + valid cert)', async () => {
    const snap: ProvisionedConvenienceSnapshot = {
      ddns_hostname: 'alice.recued.cloud',
      handle_reserved: true,
      ddns_published_at: 900,
      acme_cert_expires_at: 5_000, // > now (1_000)
    };
    const s = await make({
      entitlement: fixedEntitlement({ state: 'entitled' }),
      readReachability: async () => ({ reachable: true }),
      readProvisioned: async () => snap,
    }).status();
    expect(s.entitlement).toBe('entitled');
    expect(s.items.handle.state).toBe('active');
    expect(s.items.ddns.state).toBe('active');
    expect(s.items.acme.state).toBe('active');
    expect(s.items.acme.expires_at).toBe(5_000);
  });

  it('entitled + reachable + handle not reserved yet → pending/not_provisioned (reports reality, no actuation)', async () => {
    const s = await make({
      entitlement: fixedEntitlement({ state: 'entitled' }),
      readReachability: async () => ({ reachable: true }),
      readProvisioned: async () => ({ handle_reserved: false }),
    }).status();
    expect(s.items.handle.state).toBe('pending');
    expect(s.items.handle.detail).toBe('not_provisioned');
    expect(s.items.ddns.state).toBe('pending');
    expect(s.items.acme.state).toBe('pending');
  });

  it('entitled + reachable + EXPIRED cert → acme error/cert_expired (fail closed on expiry)', async () => {
    const s = await make({
      entitlement: fixedEntitlement({ state: 'entitled' }),
      readReachability: async () => ({ reachable: true }),
      readProvisioned: async () => ({
        handle_reserved: true,
        ddns_published_at: 900,
        acme_cert_expires_at: 500, // < now (1_000)
      }),
      now: () => 1_000,
    }).status();
    expect(s.items.acme.state).toBe('error');
    expect(s.items.acme.detail).toBe('cert_expired');
    expect(s.items.acme.expires_at).toBe(500);
  });
});

// ────────────────────────────────────────────────────────────────
// Pending entitlement stub — the typed boundary (never fabricates)
// ────────────────────────────────────────────────────────────────

describe('D-175 P8 — pending entitlement stub', () => {
  it('always resolves pending — never entitled (the cloud endpoint is the flagged gap)', async () => {
    const r = await createPendingProEntitlementSource().resolve();
    expect(r.state).toBe('pending');
    expect(r).not.toMatchObject({ state: 'entitled' });
  });
});

// ────────────────────────────────────────────────────────────────
// HTTP entitlement source — P8b real mint + local verification seam
// ────────────────────────────────────────────────────────────────

describe('D-175 P8b — HTTP entitlement source', () => {
  const NOW = 1_800_000_000_000;
  const goodClaim = (key: KeyObject, over: Record<string, unknown> = {}) =>
    mintEntitlementClaim(key, {
      v: 1,
      purpose: 'pro_entitlement_claim',
      account_id: 'acct_A',
      entitlement_tier: 'pro',
      server_fingerprint: 'sha256:ff',
      iat: NOW,
      exp: NOW + 60_000,
      ...over,
    });

  it('calls the mint endpoint, verifies the claim, and resolves entitled', async () => {
    const signing = makeEntitlementSigningFixture();
    const claim = goodClaim(signing.privateKey);
    const source = createHttpProEntitlementSource({
      loadBinding: () => storedBinding(),
      getEndpointUrl: () => 'https://auth.test/v1/account/entitlement/mint',
      getPublicKeyB64: () => signing.public_key_b64,
      fetchImpl: fetchJson({
        ok: true,
        entitlement_tier: 'pro',
        entitlement_claim: claim,
        expires_at: NOW + 60_000,
      }),
      now: () => NOW,
    });

    const r = await source.resolve();
    expect(r).toEqual({ state: 'entitled', expires_at: NOW + 60_000 });
    const bearer = await source.resolveClaim();
    expect(bearer?.entitlement_claim).toBe(claim);
  });

  it('maps a no-subscription mint response to not_entitled', async () => {
    const signing = makeEntitlementSigningFixture();
    const source = createHttpProEntitlementSource({
      loadBinding: () => storedBinding(),
      getEndpointUrl: () => 'https://auth.test/v1/account/entitlement/mint',
      getPublicKeyB64: () => signing.public_key_b64,
      fetchImpl: fetchJson({ ok: false, code: 'not_entitled' }, 403),
      now: () => NOW,
    });

    await expect(source.resolve()).resolves.toEqual({ state: 'not_entitled' });
  });

  it('fails closed on a bad signature', async () => {
    const signing = makeEntitlementSigningFixture();
    const wrong = makeEntitlementSigningFixture();
    const source = createHttpProEntitlementSource({
      loadBinding: () => storedBinding(),
      getEndpointUrl: () => 'https://auth.test/v1/account/entitlement/mint',
      getPublicKeyB64: () => signing.public_key_b64,
      fetchImpl: fetchJson({
        ok: true,
        entitlement_tier: 'pro',
        entitlement_claim: goodClaim(wrong.privateKey),
        expires_at: NOW + 60_000,
      }),
      now: () => NOW,
    });

    const r = await source.resolve();
    expect(r).toMatchObject({ state: 'unavailable', reason: 'entitlement_claim_invalid' });
  });

  it('fails closed on an expired TTL', async () => {
    const signing = makeEntitlementSigningFixture();
    const source = createHttpProEntitlementSource({
      loadBinding: () => storedBinding(),
      getEndpointUrl: () => 'https://auth.test/v1/account/entitlement/mint',
      getPublicKeyB64: () => signing.public_key_b64,
      fetchImpl: fetchJson({
        ok: true,
        entitlement_tier: 'pro',
        entitlement_claim: goodClaim(signing.privateKey, { exp: NOW - 1 }),
        expires_at: NOW - 1,
      }),
      now: () => NOW,
    });

    const r = await source.resolve();
    expect(r).toMatchObject({ state: 'unavailable', reason: 'entitlement_claim_invalid' });
  });

  it('fails closed when the claim account or server binding does not match the local binding', async () => {
    const signing = makeEntitlementSigningFixture();
    const source = createHttpProEntitlementSource({
      loadBinding: () => storedBinding(),
      getEndpointUrl: () => 'https://auth.test/v1/account/entitlement/mint',
      getPublicKeyB64: () => signing.public_key_b64,
      fetchImpl: fetchJson({
        ok: true,
        entitlement_tier: 'pro',
        entitlement_claim: goodClaim(signing.privateKey, { account_id: 'acct_other' }),
        expires_at: NOW + 60_000,
      }),
      now: () => NOW,
    });

    const r = await source.resolve();
    expect(r).toMatchObject({ state: 'unavailable', reason: 'entitlement_claim_invalid' });
  });
});

// ────────────────────────────────────────────────────────────────
// Secret-free wire — the credential held upstream never leaks
// ────────────────────────────────────────────────────────────────

describe('D-175 P8 — secret-free wire', () => {
  it('a server_scoped_credential held in the keystore NEVER appears in the status response', async () => {
    const SENTINEL = 'SECRET-cred-do-not-leak-7f3a';
    const stored: StoredAccountBinding = {
      account_id: 'acct_secret',
      publisher_handle: 'alice',
      server_scoped_credential: SENTINEL,
      server_fingerprint: 'sha256:ff',
      bound_at: 1,
      credential_issued_at: 1,
    };
    // Minimal keystore stub — the manager's status() only reads
    // loadAccountBinding(); summarize() drops the credential.
    const keyStore = {
      loadAccountBinding: () => stored,
      saveAccountBinding: () => {},
      clearAccountBinding: () => {},
      loadServerIdentityKey: () => null,
      saveServerIdentityKey: () => {},
      loadPublisherIdentityKey: () => null,
      savePublisherIdentityKey: () => {},
    };
    const manager = createAccountBindingManager({
      getServerIdentity: () => {
        throw new Error('identity not needed for status()');
      },
      getKeyStore: () => keyStore as never,
      exchangeClient: { exchange: async () => ({ ok: false, code: 'internal' }) },
    });

    const provisioner = createProConvenienceProvisioner({
      readBinding: () => manager.status(),
      entitlement: createPendingProEntitlementSource(),
    });
    const result = await provisioner.status();

    // Sanity — the credential really is held upstream.
    expect(keyStore.loadAccountBinding()!.server_scoped_credential).toBe(SENTINEL);
    // The wire is clean.
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(result).not.toHaveProperty('server_scoped_credential');
    expect(result.items.handle).not.toHaveProperty('server_scoped_credential');
    expect(result.account_id).toBe('acct_secret');
    expect(result.entitlement).toBe('pending');
  });
});

// ────────────────────────────────────────────────────────────────
// RPC handler slice
// ────────────────────────────────────────────────────────────────

describe('D-175 P8 — rpc handler slice', () => {
  const ctx = (instance_id: string | null = 'dev-1'): WsClient =>
    ({
      ws: null,
      realm: 'recued',
      instance_id,
      display_name: 'c',
      connected_at: 0,
      user_id: 'mary',
    }) as unknown as WsClient;

  const provisionerFor = (r: ProEntitlementResolution) =>
    createProConvenienceProvisioner({
      readBinding: () => bound(),
      entitlement: fixedEntitlement(r),
    });

  it('routes pro_convenience.status through the dispatcher against the provisioner', async () => {
    const slice = makeProConvenienceHandlers({
      provisioner: provisionerFor({ state: 'not_entitled' }),
    });
    expect(slice).toBeDefined();
    const dispatch = createRpcDispatcher(slice!.handlers as never, {});
    const r = await dispatch('pro_convenience.status', {}, ctx());
    expect(r.ok).toBe(true);
    expect((r as { body: { entitlement: string } }).body.entitlement).toBe('not_entitled');
  });

  it('rejects an UNREGISTERED client (no instance_id)', async () => {
    const slice = makeProConvenienceHandlers({
      provisioner: provisionerFor({ state: 'not_entitled' }),
    })!;
    const dispatch = createRpcDispatcher(slice.handlers as never, {});
    const r = await dispatch('pro_convenience.status', {}, ctx(null));
    expect(r.ok).toBe(false);
    expect((r as { error: { code: string } }).error.code).toBe('unauthorized');
  });

  it('absent deps → the slice drops (undefined) and the dispatcher returns not_configured', async () => {
    expect(makeProConvenienceHandlers(undefined)).toBeUndefined();
    const dispatch = createRpcDispatcher({} as never, {});
    const r = await dispatch('pro_convenience.status', {}, ctx());
    expect(r.ok).toBe(false);
    expect((r as { error: { code: string } }).error.code).toBe('not_configured');
  });
});

// ────────────────────────────────────────────────────────────────
// Contracts ratchets — channel isolation + registration
// ────────────────────────────────────────────────────────────────

describe('D-175 P8 — contracts ratchets', () => {
  it('pro_convenience. is reserved local-UI and pro_convenience.status never bridges onto MCP', () => {
    expect(MCP_RESERVED_RPC_PREFIXES).toContain('pro_convenience.');
    expect(isReservedLocalRpc('pro_convenience.status')).toBe(true);
    expect(isMcpToolName('pro_convenience.status')).toBe(false);
  });

  it('pro_convenience.status is registered in the dispatcher known-method set', () => {
    expect(SERVER_RPC_METHOD_SET.has('pro_convenience.status')).toBe(true);
    expect(PRO_CONVENIENCE_RPC_METHODS).toContain('pro_convenience.status');
  });

  it('the closed-list state + entitlement enums are exported intact', () => {
    expect(PRO_CONVENIENCE_ITEM_STATES).toContain('awaiting-server');
    expect(PRO_CONVENIENCE_ITEM_STATES).toContain('awaiting-reachability');
    expect(PRO_CONVENIENCE_ITEM_STATES).toContain('inactive-free');
    expect(PRO_CONVENIENCE_ITEM_STATES).toContain('pending');
    expect(PRO_CONVENIENCE_ENTITLEMENTS).toContain('entitled');
    expect(PRO_CONVENIENCE_ENTITLEMENTS).toContain('pending');
    expect(PRO_ENTITLEMENT_CLAIM_PURPOSE).toBe('pro_entitlement_claim');
    expect(PRO_ENTITLEMENT_TIERS).toEqual(['pro']);
  });
});

// NOTE: only ONE DDNS zone is enabled today (`.recued.net`), so every path below
// resolves to that suffix — the per-handle-zone DIFFERENTIATION is proven at the
// unit level (`zoneByLabel` + `hostnameForHandle`, contracts D-176 tests), and the
// label is shown to flow cloud → HandleState (handle state-machine test) →
// provisioner. These cases lock the regression (no `.recued.cloud`) + the new
// `readHandleState` dep's robustness.
describe('D-176 — data-driven DDNS hostname (provisioner)', () => {
  it('derives the hostname from the zone registry, never the retired .recued.cloud', async () => {
    const s = await make().status();
    expect(s.ddns_hostname).toBe('alice.recued.net');
    expect(s.ddns_hostname).not.toContain('.recued.cloud');
  });

  it('uses the persisted zone when the local handle state names the binding handle', async () => {
    const s = await make({
      readHandleState: async () => ({ current_handle: 'alice', ddns_zone: 'net' }),
    }).status();
    expect(s.ddns_hostname).toBe('alice.recued.net');
  });

  it('stays robust when the handle state is null or names a DIFFERENT handle (stale/rebound) — no crash, valid default hostname', async () => {
    const nullState = await make({ readHandleState: async () => null }).status();
    expect(nullState.ddns_hostname).toBe('alice.recued.net');
    const mismatched = await make({
      readHandleState: async () => ({ current_handle: 'bob', ddns_zone: 'net' }),
    }).status();
    expect(mismatched.ddns_hostname).toBe('alice.recued.net');
  });
});

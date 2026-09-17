import { readFileSync } from 'node:fs';
/** D-175 P8 — Pro convenience wiring (server-side DDNS/ACME off the
 *  binding credential).
 *
 *  The gate per `internal planning notes`:
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
  buildProvisionedSnapshot,
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

/** ⛔⛔ THE SEAM THAT ONLY EXISTED IN THIS FILE. `readProvisioned` was supplied by
 *  the tests above and by NOTHING in production, so a real server always got
 *  `snap = null` — `handle_reserved: false`, every item `pending /
 *  not_provisioned`, and a Pro card that said "Not set up yet" no matter what
 *  was actually provisioned. The card was not mis-describing a case; its live
 *  half was never connected.
 *
 *  🔑 A dep that appears only in a harness reports the harness. These arms cover
 *  the decision half; the arm below pins that composition still passes it. */
describe('buildProvisionedSnapshot — what the three reads mean', () => {
  it('reports nothing provisioned when no handle is held', () => {
    expect(buildProvisionedSnapshot({ handle: '', hostname: '' }))
      .toEqual({ handle_reserved: false });
  });

  it('a held handle is reserved, and names the hostname the items target', () => {
    expect(buildProvisionedSnapshot({ handle: 'alice', hostname: 'alice.recued.net' }))
      .toEqual({ handle_reserved: true, ddns_hostname: 'alice.recued.net' });
  });

  /** ⚠ ABSENT IS NOT ZERO. Omitting the key is what makes the provisioner report
   *  `pending`; a `0` would read as a real timestamp at the epoch and an expired
   *  cert. */
  it('omits the DDNS and cert stamps rather than defaulting them', () => {
    const snap = buildProvisionedSnapshot({ handle: 'alice', hostname: 'alice.recued.net' });
    expect(snap).not.toHaveProperty('ddns_published_at');
    expect(snap).not.toHaveProperty('acme_cert_expires_at');
  });

  it('carries both stamps when the substrate has them', () => {
    expect(buildProvisionedSnapshot({
      handle: 'alice',
      hostname: 'alice.recued.net',
      lastPublishedAt: 1_700_000_000_000,
      certExpiresAt: 1_800_000_000_000,
    })).toEqual({
      handle_reserved: true,
      ddns_hostname: 'alice.recued.net',
      ddns_published_at: 1_700_000_000_000,
      acme_cert_expires_at: 1_800_000_000_000,
    });
  });
});

/** ⛔⛔ AND THE WIRING ITSELF, because its absence is exactly the bug. A dep can
 *  be perfectly implemented and simply not passed — that is how this one hid for
 *  as long as it did, and no behavioural test can see it from inside the
 *  provisioner.
 *
 *  ⚠ COMMENTS STRIPPED BEFORE MATCHING. The composition site carries a long note
 *  about `readProvisioned` directly above the call, so a raw text search finds
 *  the prose whether or not the argument is there — the same way a comment
 *  quoting code once satisfied an assertion about that code. */
describe('composition passes readProvisioned in production', () => {
  it('the real provisioner is constructed with the live seam', () => {
    const src = readFileSync(
      new URL('../serve/compose-storage-context.ts', import.meta.url),
      'utf-8',
    );
    const code = src
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    const at = code.indexOf('createProConvenienceProvisioner({');
    expect(at, 'the production provisioner construction moved').toBeGreaterThan(-1);
    const call = code.slice(at, code.indexOf('});', at));
    expect(call, 'readProvisioned must be passed, or the card reports a placeholder forever')
      .toContain('readProvisioned:');
  });
});

/** The handle anchor — why a server that is bound, entitled and perfectly
 *  healthy shows nothing set up.
 *
 *  🔑 THE ORDERING IS THE FEATURE, NOT AN IMPLEMENTATION DETAIL, so it is
 *  asserted first and directly. Several servers on one LAN share one forwarded
 *  port, so the servers that do NOT hold the handle are exactly the servers with
 *  no reachability proof — the two conditions arrive together, always, in the
 *  case this exists for. Gate reachability first and the anchor branch is
 *  unreachable in production while every test that sets `reachable: true` still
 *  passes, which is the shape of a fix that is only true in the harness.
 *
 *  ⚠ THE HINT IS UNSIGNED, so the last arm below pins the boundary it must not
 *  cross: `resolveClaim` — the bearer path actuation uses — is unchanged by it. */
describe('D-175 — handle anchored to another server', () => {
  const anchored = (
    state: 'held_by_me' | 'held_by_other' | 'unanchored',
  ): ProEntitlementSource =>
    fixedEntitlement({ state: 'entitled', handle_anchor: { state, handle: 'alice' } });

  it('explains itself instead of blaming reachability, which it would also fail', async () => {
    const status = await make({
      entitlement: anchored('held_by_other'),
      readReachability: async () => ({ reachable: false, checked_at: 1 }),
      readProvisioned: async () => ({ handle_reserved: false }),
    }).status();

    expect(status.items.handle.state).toBe('inactive-elsewhere');
    expect(status.items.handle.detail).toBe('handle_on_another_server');
    // The assertion that fails if the branch is moved below the reachability
    // gate: that gate is open here, and it must not be what answers.
    expect(status.items.handle.detail).not.toBe('not_reachable');
    expect(status.items.ddns.detail).toBe('handle_on_another_server');
    expect(status.items.acme.detail).toBe('handle_on_another_server');
    // Still entitled — nothing is wrong with the account.
    expect(status.entitlement).toBe('entitled');
  });

  it('the anchor decides, not the local provisioned snapshot', async () => {
    // A server can hold a stale local cert + publish stamp for a handle that has
    // since migrated. Reading those would report `active` for a name that now
    // resolves elsewhere.
    const status = await make({
      entitlement: anchored('held_by_other'),
      readReachability: async () => ({ reachable: true, checked_at: 1 }),
      readProvisioned: async () => ({
        handle_reserved: true,
        ddns_hostname: 'alice.recued.net',
        ddns_published_at: 900,
        acme_cert_expires_at: 9_000,
      }),
    }).status();

    expect(status.items.handle.state).toBe('inactive-elsewhere');
    expect(status.items.acme.state).toBe('inactive-elsewhere');
    expect(status.items.acme.expires_at).toBeUndefined();
  });

  it('held_by_me is the ordinary path and the branch stays out of it', async () => {
    const status = await make({
      entitlement: anchored('held_by_me'),
      readReachability: async () => ({ reachable: true, checked_at: 1 }),
      readProvisioned: async () => ({
        handle_reserved: true,
        ddns_hostname: 'alice.recued.net',
        ddns_published_at: 900,
        acme_cert_expires_at: 9_000,
      }),
    }).status();

    expect(status.items.handle.state).toBe('active');
    expect(status.items.ddns.state).toBe('active');
    expect(status.items.acme.state).toBe('active');
  });

  /** ⛔ UNANCHORED IS NOT "SOMEWHERE ELSE" — it is "nowhere yet, and yours for
   *  the taking", which is what "Not set up yet" already says correctly. Telling
   *  an owner whose only server was unbound that their handle lives on another
   *  server would be false AND would hide the one case they can act on. */
  it.each([
    ['unanchored' as const, 'not_provisioned'],
  ])('%s keeps the claimable copy', async (state, detail) => {
    const status = await make({
      entitlement: anchored(state),
      readReachability: async () => ({ reachable: true, checked_at: 1 }),
      readProvisioned: async () => ({ handle_reserved: false }),
    }).status();
    expect(status.items.handle.state).toBe('pending');
    expect(status.items.handle.detail).toBe(detail);
  });

  it('no anchor at all changes nothing (an older cloud, or no handle reserved)', async () => {
    const status = await make({
      entitlement: fixedEntitlement({ state: 'entitled' }),
      readReachability: async () => ({ reachable: false, checked_at: 1 }),
      readProvisioned: async () => ({ handle_reserved: false }),
    }).status();
    expect(status.items.handle.state).toBe('awaiting-reachability');
    expect(status.items.handle.detail).toBe('not_reachable');
  });
});

/** The anchor's trip across the wire. It rides OUTSIDE the signature, so these
 *  pin both halves of that choice: it is read off the raw body (not the verified
 *  claim), and being unsigned it may not touch the bearer path. */
describe('D-175 — handle_anchor on the mint response', () => {
  const NOW = 1_800_000_000_000;
  const mintBody = (claim: string, handle_anchor?: unknown) => ({
    ok: true,
    entitlement_tier: 'pro',
    entitlement_claim: claim,
    expires_at: NOW + 60_000,
    ...(handle_anchor !== undefined ? { handle_anchor } : {}),
  });
  const sourceFor = (signing: EntitlementSigningFixture, body: unknown) =>
    createHttpProEntitlementSource({
      loadBinding: () => storedBinding(),
      getEndpointUrl: () => 'https://auth.test/v1/account/entitlement/mint',
      getPublicKeyB64: () => signing.public_key_b64,
      fetchImpl: fetchJson(body),
      now: () => NOW,
    });
  const claimFor = (signing: EntitlementSigningFixture) =>
    mintEntitlementClaim(signing.privateKey, {
      v: 1,
      purpose: 'pro_entitlement_claim',
      account_id: 'acct_A',
      entitlement_tier: 'pro',
      server_fingerprint: 'sha256:ff',
      iat: NOW,
      exp: NOW + 60_000,
    });

  it('carries a well-formed anchor through to the resolution', async () => {
    const signing = makeEntitlementSigningFixture();
    const r = await sourceFor(
      signing,
      mintBody(claimFor(signing), { state: 'held_by_other', handle: 'alice' }),
    ).resolve();
    expect(r).toEqual({
      state: 'entitled',
      expires_at: NOW + 60_000,
      handle_anchor: { state: 'held_by_other', handle: 'alice' },
    });
  });

  /** ⚠ THE OLD-SERVER CASE IS THE LIKELY ONE, not the exotic one: the Worker
   *  deploys on its own schedule and each self-hosted server updates on its
   *  owner's, so a state this build has never heard of WILL arrive eventually.
   *  Dropping it must leave an ordinary entitled resolution, never a failure —
   *  a display hint that can break entitlement is worse than no hint. */
  it.each([
    ['an unknown state', { state: 'held_by_a_future_thing', handle: 'alice' }],
    ['a missing handle', { state: 'held_by_other' }],
    ['an empty handle', { state: 'held_by_other', handle: '' }],
    ['a non-object', 'held_by_other'],
    ['null', null],
  ])('drops %s and stays entitled', async (_label, anchor) => {
    const signing = makeEntitlementSigningFixture();
    const r = await sourceFor(signing, mintBody(claimFor(signing), anchor)).resolve();
    expect(r).toEqual({ state: 'entitled', expires_at: NOW + 60_000 });
  });

  /** ⛔⛔ THE LINE THE HINT MAY NOT CROSS. `resolveClaim` is the bearer token
   *  actuation presents; if an unsigned field could suppress it, anyone able to
   *  shape a mint response could switch a server's conveniences off. Authority
   *  over the handle stays with the cloud's own `ddns_handle_mismatch` refusal. */
  it('does not touch the bearer path, whatever the anchor says', async () => {
    const signing = makeEntitlementSigningFixture();
    const claim = claimFor(signing);
    const bearer = await sourceFor(
      signing,
      mintBody(claim, { state: 'held_by_other', handle: 'alice' }),
    ).resolveClaim();
    expect(bearer?.entitlement_claim).toBe(claim);
  });
});

/** ⛔⛔ WHERE THE RENAMED HANDLE IS READ FROM, WHICH IS THE SECURITY QUESTION.
 *
 *  The server ACTS on this name: it moves a DNS record and a certificate to it.
 *  The `handle_anchor` beside it is read off the raw body on purpose — it only
 *  picks copy — and reading this one the same way would let anything able to
 *  shape a mint response re-point somebody's hostname. It must come from the
 *  payload the Ed25519 signature covers, and nowhere else. */
describe('D-175 — publisher_handle comes from the VERIFIED claim', () => {
  const NOW = 1_800_000_000_000;
  const claimWith = (signing: EntitlementSigningFixture, over: Record<string, unknown> = {}) =>
    mintEntitlementClaim(signing.privateKey, {
      v: 1,
      purpose: 'pro_entitlement_claim',
      account_id: 'acct_A',
      entitlement_tier: 'pro',
      server_fingerprint: 'sha256:ff',
      iat: NOW,
      exp: NOW + 60_000,
      ...over,
    });
  const sourceFor = (signing: EntitlementSigningFixture, body: unknown) =>
    createHttpProEntitlementSource({
      loadBinding: () => storedBinding(),
      getEndpointUrl: () => 'https://auth.test/v1/account/entitlement/mint',
      getPublicKeyB64: () => signing.public_key_b64,
      fetchImpl: fetchJson(body),
      now: () => NOW,
    });
  const mintBody = (claim: string, extra: Record<string, unknown> = {}) => ({
    ok: true,
    entitlement_tier: 'pro',
    entitlement_claim: claim,
    expires_at: NOW + 60_000,
    ...extra,
  });

  it('carries a signed handle through to the resolution', async () => {
    const signing = makeEntitlementSigningFixture();
    const r = await sourceFor(
      signing,
      mintBody(claimWith(signing, { publisher_handle: 'bob' })),
    ).resolve();
    expect(r).toMatchObject({ state: 'entitled', publisher_handle: 'bob' });
  });

  /** ⛔⛔⛔ THE ATTACK THIS SHUTS: a response whose signed claim says nothing
   *  about a handle, with `publisher_handle` bolted onto the JSON beside it. If
   *  the source read the body, this would silently re-point the server's DNS to a
   *  name the cloud never authorised. */
  it('IGNORES a handle bolted onto the response body outside the signature', async () => {
    const signing = makeEntitlementSigningFixture();
    const r = await sourceFor(
      signing,
      mintBody(claimWith(signing), { publisher_handle: 'attacker-owned' }),
    ).resolve();
    expect(r).toEqual({ state: 'entitled', expires_at: NOW + 60_000 });
  });

  /** ⚠ AND AN EMPTY STRING IS NOT A HANDLE. Present-and-empty is
   *  indistinguishable from "the handle was removed", and the provisioner would
   *  act on it — so the whole claim fails shape validation rather than passing a
   *  name nothing can reserve. */
  it('rejects a claim whose handle is present but empty', async () => {
    const signing = makeEntitlementSigningFixture();
    const r = await sourceFor(
      signing,
      mintBody(claimWith(signing, { publisher_handle: '' })),
    ).resolve();
    expect(r).toEqual({ state: 'unavailable', reason: 'entitlement_claim_invalid' });
  });
});

/** ⛔⛔⛔ THE DETECTOR HAD TO BE PRECISE BEFORE IT COULD BE WIRED.
 *
 *  The mint is BEARER-authenticated (an HMAC credential the cloud itself
 *  issued), not signature-authenticated like the DDNS route — and
 *  `credential_invalid` means FIVE things, two of which are 400s raised before a
 *  credential is even read: an unparseable body and a missing field, i.e. a bug
 *  in US. Wiring a disconnect announcement to that code would have told owners
 *  their server was disconnected because of a local serialization fault.
 *
 *  🔑 So the cloud emits a purpose-built `server_disowned` AFTER the HMAC
 *  verifies, and the server requires the code AND the 401 together.
 */
describe('D-175 — the disowned state is narrower than credential_invalid', () => {
  const NOW = 1_800_000_000_000;
  const sourceFor = (body: unknown, status = 200) =>
    createHttpProEntitlementSource({
      loadBinding: () => storedBinding(),
      getEndpointUrl: () => 'https://auth.test/v1/account/entitlement/mint',
      getPublicKeyB64: () => makeEntitlementSigningFixture().public_key_b64,
      fetchImpl: fetchJson(body, status),
      now: () => NOW,
    });

  it('maps a 401 server_disowned to the terminal disowned state', async () => {
    const r = await sourceFor({ ok: false, code: 'server_disowned' }, 401).resolve();
    expect(r).toEqual({ state: 'disowned' });
  });

  /** ⛔ THE CASES THAT MUST NOT ANNOUNCE. A malformed request is our own bug; a
   *  rotated credential is the owner's own deliberate act seconds earlier, with
   *  the binding still standing. Neither is a disconnection, and reporting one
   *  would be a false alarm the owner cannot act on. */
  it.each([
    ['a malformed request (400)', { ok: false, code: 'credential_invalid' }, 400],
    ['a rotated credential (401)', { ok: false, code: 'credential_invalid' }, 401],
  ])('does NOT report %s as disowned', async (_label, body, status) => {
    const r = await sourceFor(body, status).resolve();
    expect(r.state).not.toBe('disowned');
  });

  /** ⛔⛔ THE CODE **AND** THE STATUS. Accepting the word on any status would let
   *  a proxy error page or a future 4xx reuse of it stop a healthy server — and
   *  the consequence here is terminal, so two agreeing signals are the price. */
  it('ignores the word server_disowned on a status that cannot mean it', async () => {
    const r = await sourceFor({ ok: false, code: 'server_disowned' }, 500).resolve();
    expect(r.state).not.toBe('disowned');
  });
});

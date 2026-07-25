/** D-175 P5 — account ↔ server binding (server half).
 *
 *  The gate per `internal planning notes`:
 *    - the full receive → exchange (mock) → store → conflict →
 *      confirmed-rebind → audit path;
 *    - order-independence (account-first AND server-first);
 *    - the 1-server-1-owner invariant;
 *    - a mutation check (a forged / expired token is rejected);
 *  plus: secret-never-leaks, unbind / status lifecycle, the signed
 *  audit round-trip, the HTTP exchange client's failure discipline,
 *  the identity-file at-rest round-trip (plaintext + passphrase), the
 *  rpc handler/dispatcher path, and the contracts-side ratchets
 *  (`account.` reserved from MCP; methods registered; audit kinds
 *  high-assurance).
 *
 *  The mock exchange really verifies the Ed25519 server-identity proof,
 *  so the proof path is exercised end-to-end without a live Worker —
 *  a tampered proof is rejected by crypto, not a stub flag.
 */

import { describe, it, expect } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  RpcError,
  MCP_RESERVED_RPC_PREFIXES,
  isReservedLocalRpc,
  isMcpToolName,
  SERVER_RPC_METHOD_SET,
  HIGH_ASSURANCE_AUDIT_KINDS,
  ACCOUNT_BINDING_AUDIT_ACTIONS,
  type AccountBindingExchangeOutcome,
  type AccountBindingExchangeRequest,
  type AccountBindingProofClaims,
} from '@recued/contracts';
import {
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditLogStore,
} from '@recued/storage';

import {
  createAccountBindingManager,
  type AccountBindingActor,
} from '../account-binding/manager.js';
import {
  createHttpAccountBindingExchangeClient,
  type AccountBindingExchangeClient,
  type FetchLike,
} from '../account-binding/exchange-client.js';
import { makeAccountBindingHandlers } from '../account-binding-handler.js';
import {
  createInMemoryServerKeyStore,
  generateEd25519Keypair,
  ed25519Verify,
  type Ed25519Keypair,
} from '../keys/index.js';
import {
  createFileServerKeyStore,
  flushFileServerKeyStore,
} from '../keys/file-store.js';
import { createSigningAuditLog, verifyActivityEntry } from '../audit/signing.js';
import { createRpcDispatcher } from '../rpc-dispatcher.js';
import type { WsClient } from '../ws-server.js';

// ────────────────────────────────────────────────────────────────
// Fixtures + harness
// ────────────────────────────────────────────────────────────────

const ACCT_A = 'acct_A';
const ACCT_B = 'acct_B';
const ACTOR: AccountBindingActor = { user_id: 'mary', instance_id: 'dev-1' };

/** A test binding token is a JSON fixture the mock decodes (a real
 *  token is an opaque JWT — opaque to the server either way). */
const tokenFor = (
  account_id: string,
  opts: { expired?: boolean; publisher_handle?: string } = {},
): string => JSON.stringify({ account_id, ...opts });

interface MockExchange {
  client: AccountBindingExchangeClient;
  calls: AccountBindingExchangeRequest[];
}

/** Mock auth Worker. Verifies the Ed25519 server-identity proof for
 *  real, then maps the (JSON) token onto an outcome. A custom `resolve`
 *  overrides the default account/expiry mapping. */
const makeMockExchange = (
  resolve?: (
    parsedToken: { account_id?: string; expired?: boolean; publisher_handle?: string },
    req: AccountBindingExchangeRequest,
  ) => AccountBindingExchangeOutcome,
): MockExchange => {
  const calls: AccountBindingExchangeRequest[] = [];
  let seq = 0;
  return {
    calls,
    client: {
      async exchange(req) {
        calls.push(req);
        // Real proof verification — the server-identity proof is the
        // Worker's gate, not a stub flag.
        if (
          !ed25519Verify(
            req.server_public_key_b64,
            req.proof_payload,
            req.proof_signature,
          )
        ) {
          return { ok: false, code: 'proof_invalid' };
        }
        let claims: AccountBindingProofClaims;
        try {
          claims = JSON.parse(req.proof_payload) as AccountBindingProofClaims;
        } catch {
          return { ok: false, code: 'proof_invalid' };
        }
        if (
          claims.binding_token !== req.binding_token ||
          claims.purpose !== 'account_bind_exchange'
        ) {
          return { ok: false, code: 'proof_invalid' };
        }
        if (claims.server_fingerprint !== req.server_fingerprint) {
          return { ok: false, code: 'server_identity_mismatch' };
        }
        let parsed: { account_id?: string; expired?: boolean; publisher_handle?: string };
        try {
          parsed = JSON.parse(req.binding_token);
        } catch {
          return { ok: false, code: 'token_invalid' };
        }
        if (resolve) return resolve(parsed, req);
        if (parsed.expired) return { ok: false, code: 'token_expired' };
        if (!parsed.account_id) return { ok: false, code: 'token_invalid' };
        // Worker-side rebind gate: a DIFFERENT current owner without
        // strict confirmation → conflict, with NO commit (the Worker
        // would not record ownership / consume the nonce here).
        if (
          req.current_owner_account_id &&
          req.current_owner_account_id !== parsed.account_id &&
          req.confirm_rebind !== true
        ) {
          return {
            ok: false,
            conflict: true,
            current_owner: { account_id: req.current_owner_account_id },
            incoming: {
              account_id: parsed.account_id,
              ...(parsed.publisher_handle
                ? { publisher_handle: parsed.publisher_handle }
                : {}),
            },
          };
        }
        seq += 1;
        return {
          ok: true,
          account_id: parsed.account_id,
          ...(parsed.publisher_handle
            ? { publisher_handle: parsed.publisher_handle }
            : {}),
          server_scoped_credential: `SECRET-cred-${parsed.account_id}-${seq}`,
          credential_issued_at: 1_700_000_000_000 + seq,
        };
      },
    },
  };
};

const makeHarness = (opts: { exchange?: MockExchange; withAudit?: boolean } = {}) => {
  const keyStore = createInMemoryServerKeyStore();
  const identity: Ed25519Keypair = generateEd25519Keypair('server_identity_key');
  const exchange = opts.exchange ?? makeMockExchange();
  let clock = 1_700_000_000_000;

  let baseStore: AuditLogStore | undefined;
  let auditLog: AuditLogStore | undefined;
  if (opts.withAudit) {
    baseStore = createAuditLogStore(createInMemoryCollection());
    auditLog = createSigningAuditLog(baseStore, {
      getServerIdentity: () => identity,
    });
  }

  const manager = createAccountBindingManager({
    getServerIdentity: () => identity,
    getKeyStore: () => keyStore,
    exchangeClient: exchange.client,
    ...(auditLog ? { auditLog } : {}),
    now: () => clock,
  });

  return {
    manager,
    keyStore,
    identity,
    exchange,
    tick: (ms = 1000) => {
      clock += ms;
    },
    activities: async (): Promise<ActivityEntry[]> =>
      baseStore ? baseStore.listActivities(50) : [],
  };
};

// ────────────────────────────────────────────────────────────────
// Receive → exchange → store
// ────────────────────────────────────────────────────────────────

describe('D-175 P5 — binding manager: receive → exchange → store', () => {
  it('binds a fresh server: exchanges the token, stores the credential, returns a secret-free summary', async () => {
    const h = makeHarness();
    const result = await h.manager.bind({ binding_token: tokenFor(ACCT_A) }, ACTOR);

    expect(result.outcome).toBe('bound');
    if (result.outcome !== 'bound') return;
    expect(result.binding.account_id).toBe(ACCT_A);
    expect(result.binding.server_fingerprint).toBe(
      h.identity.public_key_fingerprint,
    );
    expect(result.binding.bound_at).toBe(1_700_000_000_000);

    // The credential landed in the store…
    const stored = h.keyStore.loadAccountBinding();
    expect(stored?.account_id).toBe(ACCT_A);
    expect(stored?.server_scoped_credential).toMatch(/^SECRET-cred-acct_A/);

    // …and the exchange was driven with a real proof over THIS token.
    expect(h.exchange.calls).toHaveLength(1);
    const req = h.exchange.calls[0]!;
    expect(req.binding_token).toBe(tokenFor(ACCT_A));
    expect(req.server_fingerprint).toBe(h.identity.public_key_fingerprint);
    expect(
      ed25519Verify(req.server_public_key_b64, req.proof_payload, req.proof_signature),
    ).toBe(true);
  });

  it('never leaks server_scoped_credential in the bind result, status, or audit detail', async () => {
    const h = makeHarness({ withAudit: true });
    const result = await h.manager.bind({ binding_token: tokenFor(ACCT_A) }, ACTOR);
    const credential = h.keyStore.loadAccountBinding()!.server_scoped_credential;
    expect(credential).toContain('SECRET-cred');

    expect(JSON.stringify(result)).not.toContain(credential);
    expect(JSON.stringify(h.manager.status())).not.toContain(credential);
    const rows = await h.activities();
    expect(JSON.stringify(rows)).not.toContain(credential);
  });

  it('same-account re-bind refreshes the credential but preserves bound_at (idempotent)', async () => {
    const h = makeHarness();
    await h.manager.bind({ binding_token: tokenFor(ACCT_A) }, ACTOR);
    const firstCred = h.keyStore.loadAccountBinding()!.server_scoped_credential;

    h.tick(5_000);
    const again = await h.manager.bind({ binding_token: tokenFor(ACCT_A) }, ACTOR);

    expect(again.outcome).toBe('bound');
    if (again.outcome !== 'bound') return;
    // bound_at preserved (first-bind stamp), credential rotated.
    expect(again.binding.bound_at).toBe(1_700_000_000_000);
    expect(again.binding.rebound_at).toBeUndefined();
    const stored = h.keyStore.loadAccountBinding()!;
    expect(stored.server_scoped_credential).not.toBe(firstCred);
  });
});

// ────────────────────────────────────────────────────────────────
// Conflict + confirmed rebind + 1-server-1-owner
// ────────────────────────────────────────────────────────────────

describe('D-175 P5 — conflict gate + 1-server-1-owner', () => {
  it('a different account without confirm returns conflict and stores nothing (no silent rebind)', async () => {
    const h = makeHarness({ withAudit: true });
    await h.manager.bind({ binding_token: tokenFor(ACCT_A) }, ACTOR);

    const result = await h.manager.bind({ binding_token: tokenFor(ACCT_B) }, ACTOR);
    expect(result.outcome).toBe('conflict');
    if (result.outcome !== 'conflict') return;
    expect(result.current_owner.account_id).toBe(ACCT_A);
    expect(result.incoming.account_id).toBe(ACCT_B);

    // The single owning-account slot is UNCHANGED — A still owns it,
    // B's freshly-exchanged credential was discarded.
    const stored = h.keyStore.loadAccountBinding()!;
    expect(stored.account_id).toBe(ACCT_A);
    expect(stored.server_scoped_credential).toMatch(/acct_A/);

    const rows = await h.activities();
    expect(rows.some((r) => r.action === 'account_bind_conflict')).toBe(true);
  });

  it('a confirmed rebind overwrites the owner and records the displaced account', async () => {
    const h = makeHarness({ withAudit: true });
    await h.manager.bind({ binding_token: tokenFor(ACCT_A) }, ACTOR);
    h.tick(10_000);

    const result = await h.manager.bind(
      { binding_token: tokenFor(ACCT_B), confirm_rebind: true },
      ACTOR,
    );
    expect(result.outcome).toBe('rebound');
    if (result.outcome !== 'rebound') return;
    expect(result.previous_account_id).toBe(ACCT_A);
    expect(result.binding.account_id).toBe(ACCT_B);
    expect(result.binding.rebound_at).toBe(1_700_000_010_000);

    // One owner at a time: the slot now holds B, A is gone.
    const stored = h.keyStore.loadAccountBinding()!;
    expect(stored.account_id).toBe(ACCT_B);

    const rows = await h.activities();
    const rebind = rows.find((r) => r.action === 'account_rebind');
    expect(rebind).toBeDefined();
    expect(JSON.parse(rebind!.detail ?? '{}').previous_account_id).toBe(ACCT_A);
  });

  it('confirm_rebind on a SAME-account bind is a refresh, not a rebind', async () => {
    const h = makeHarness();
    await h.manager.bind({ binding_token: tokenFor(ACCT_A) }, ACTOR);
    const result = await h.manager.bind(
      { binding_token: tokenFor(ACCT_A), confirm_rebind: true },
      ACTOR,
    );
    expect(result.outcome).toBe('bound');
  });

  it('requires a STRICT boolean confirm_rebind: a truthy non-boolean does NOT rebind', async () => {
    // Over WS the args are untyped JSON; a truthiness check would treat
    // "false" / 1 / {} as confirmed and silently rebind. They must all
    // still resolve to a conflict (no silent rebind), and the local
    // owner must stay A.
    for (const truthy of ['false', 1, {}, 'yes']) {
      const h = makeHarness();
      await h.manager.bind({ binding_token: tokenFor(ACCT_A) }, ACTOR);
      const result = await h.manager.bind(
        { binding_token: tokenFor(ACCT_B), confirm_rebind: truthy as unknown as boolean },
        ACTOR,
      );
      expect(result.outcome).toBe('conflict');
      expect(h.keyStore.loadAccountBinding()!.account_id).toBe(ACCT_A);
    }
  });

  it('passes the local current owner + strict confirm into the exchange so the Worker gates the rebind', async () => {
    const h = makeHarness();
    await h.manager.bind({ binding_token: tokenFor(ACCT_A) }, ACTOR);
    h.exchange.calls.length = 0;
    await h.manager.bind({ binding_token: tokenFor(ACCT_B) }, ACTOR);
    const req = h.exchange.calls[0]!;
    expect(req.current_owner_account_id).toBe(ACCT_A);
    expect(req.confirm_rebind).toBe(false);
  });

  it('fails CLOSED if a buggy/compromised Worker returns success for a different account without confirmation', async () => {
    // A Worker that ignores the rebind gate (always commits) must not be
    // able to silently overwrite the local owner — the server detects the
    // semantic violation (different account + confirm_rebind false) and
    // downgrades to a conflict rather than mirroring the rebind.
    const overcommit = makeMockExchange((parsed) => ({
      ok: true,
      account_id: parsed.account_id!,
      server_scoped_credential: `OVERCOMMIT-${parsed.account_id}`,
      credential_issued_at: 1,
    }));
    const h = makeHarness({ exchange: overcommit, withAudit: true });
    await h.manager.bind({ binding_token: tokenFor(ACCT_A) }, ACTOR);

    const result = await h.manager.bind({ binding_token: tokenFor(ACCT_B) }, ACTOR);
    expect(result.outcome).toBe('conflict');
    // Local owner unchanged — no silent rebind.
    expect(h.keyStore.loadAccountBinding()!.account_id).toBe(ACCT_A);
    const rows = await h.activities();
    const conflict = rows.find(
      (r) =>
        r.action === 'account_bind_conflict' &&
        JSON.parse(r.detail ?? '{}').worker_overcommit === true,
    );
    expect(conflict).toBeDefined();
  });
});

// ────────────────────────────────────────────────────────────────
// Order-independence
// ────────────────────────────────────────────────────────────────

describe('D-175 P5 — order-independence', () => {
  it('binds with no precondition (server-first): a fresh server binds immediately', async () => {
    const h = makeHarness();
    expect(h.manager.status().status).toBe('unbound');
    const result = await h.manager.bind({ binding_token: tokenFor(ACCT_A) }, ACTOR);
    expect(result.outcome).toBe('bound');
  });

  it('binds the same whether or not a prior status read / other op happened first (account-first vs server-first converge)', async () => {
    // "Account-first" surface: status was read (account existed) before
    // the token arrived. "Server-first": bind straight away. Both reach
    // the identical terminal — no "must have paired first" precondition.
    const serverFirst = makeHarness();
    const r1 = await serverFirst.manager.bind(
      { binding_token: tokenFor(ACCT_A) },
      ACTOR,
    );

    const accountFirst = makeHarness();
    expect(accountFirst.manager.status().status).toBe('unbound');
    accountFirst.tick(60_000);
    const r2 = await accountFirst.manager.bind(
      { binding_token: tokenFor(ACCT_A) },
      ACTOR,
    );

    expect(r1.outcome).toBe('bound');
    expect(r2.outcome).toBe('bound');
    expect(accountFirst.manager.status().status).toBe('bound');
  });
});

// ────────────────────────────────────────────────────────────────
// Mutation check — forged / expired token rejection
// ────────────────────────────────────────────────────────────────

describe('D-175 P5 — forged / expired token rejection', () => {
  it('rejects an expired token: throws, stores nothing, audits the failed exchange with the reason', async () => {
    const h = makeHarness({ withAudit: true });
    await expect(
      h.manager.bind({ binding_token: tokenFor(ACCT_A, { expired: true }) }, ACTOR),
    ).rejects.toMatchObject({ code: 'binding_exchange_failed' });

    expect(h.keyStore.loadAccountBinding()).toBeNull();
    const rows = await h.activities();
    const failed = rows.find((r) => r.action === 'account_bind_exchange_failed');
    expect(failed).toBeDefined();
    expect(JSON.parse(failed!.detail ?? '{}').reason).toBe('token_expired');
  });

  it('the server-identity proof is load-bearing: a tampered proof is rejected by the Worker', async () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const wrong = generateEd25519Keypair('server_identity_key');
    const { client } = makeMockExchange();
    const token = tokenFor(ACCT_A);
    const claims: AccountBindingProofClaims = {
      binding_token: token,
      server_fingerprint: identity.public_key_fingerprint,
      purpose: 'account_bind_exchange',
      signed_at: 1_700_000_000_000,
    };
    const proof_payload = JSON.stringify(claims);
    // Forge: claim identity's fingerprint but sign with a DIFFERENT key.
    const { ed25519Sign } = await import('../keys/index.js');
    const forged: AccountBindingExchangeRequest = {
      binding_token: token,
      server_fingerprint: identity.public_key_fingerprint,
      server_public_key_b64: identity.public_key_b64,
      proof_payload,
      proof_signature: ed25519Sign(wrong, proof_payload),
      confirm_rebind: false,
    };
    const outcome = await client.exchange(forged);
    expect(outcome.ok).toBe(false);
    if (outcome.ok || ('conflict' in outcome && outcome.conflict)) return;
    expect(outcome.code).toBe('proof_invalid');
  });

  it('a Worker proof_invalid rejection surfaces as a failed exchange + audit', async () => {
    const exchange = makeMockExchange(() => ({ ok: false, code: 'proof_invalid' }));
    const h = makeHarness({ exchange, withAudit: true });
    await expect(
      h.manager.bind({ binding_token: tokenFor(ACCT_A) }, ACTOR),
    ).rejects.toMatchObject({ code: 'binding_exchange_failed' });
    const rows = await h.activities();
    const failed = rows.find((r) => r.action === 'account_bind_exchange_failed');
    expect(JSON.parse(failed!.detail ?? '{}').reason).toBe('proof_invalid');
  });

  it('rejects a missing / empty / oversized token with bad_request (before any exchange)', async () => {
    const h = makeHarness();
    await expect(
      h.manager.bind({ binding_token: '' }, ACTOR),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      h.manager.bind({ binding_token: '   ' }, ACTOR),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      h.manager.bind({ binding_token: 'x'.repeat(9000) }, ACTOR),
    ).rejects.toMatchObject({ code: 'bad_request' });
    // No exchange was attempted for invalid input.
    expect(h.exchange.calls).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────
// not_ready + exchange_unavailable
// ────────────────────────────────────────────────────────────────

describe('D-175 P5 — degraded states', () => {
  it('surfaces not_ready when the signing identity is not booted', async () => {
    const manager = createAccountBindingManager({
      getServerIdentity: () => {
        throw new Error('not booted');
      },
      getKeyStore: () => {
        throw new Error('not booted');
      },
      exchangeClient: makeMockExchange().client,
    });
    await expect(
      manager.bind({ binding_token: tokenFor(ACCT_A) }, ACTOR),
    ).rejects.toMatchObject({ code: 'not_ready' });
    await expect(manager.unbind(ACTOR)).rejects.toMatchObject({
      code: 'not_ready',
    });
  });

  it('an unreachable exchange endpoint maps to a 503 + audits the failure', async () => {
    const exchange = makeMockExchange(() => ({
      ok: false,
      code: 'exchange_unavailable',
      message: 'no endpoint',
    }));
    const h = makeHarness({ exchange, withAudit: true });
    let thrown: unknown;
    try {
      await h.manager.bind({ binding_token: tokenFor(ACCT_A) }, ACTOR);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RpcError);
    expect((thrown as RpcError).code).toBe('binding_exchange_failed');
    expect((thrown as RpcError).status).toBe(503);
    const rows = await h.activities();
    expect(
      rows.some((r) => r.action === 'account_bind_exchange_failed'),
    ).toBe(true);
  });

  it('maps an internal (malformed Worker) failure to 502, not a 400 token error', async () => {
    const exchange = makeMockExchange(() => ({ ok: false, code: 'internal' }));
    const h = makeHarness({ exchange });
    let thrown: unknown;
    try {
      await h.manager.bind({ binding_token: tokenFor(ACCT_A) }, ACTOR);
    } catch (e) {
      thrown = e;
    }
    expect((thrown as RpcError).status).toBe(502);
  });

  it('keeps token / proof failures as 4xx (client input)', async () => {
    const h = makeHarness();
    await expect(
      h.manager.bind({ binding_token: tokenFor(ACCT_A, { expired: true }) }, ACTOR),
    ).rejects.toMatchObject({ status: 400 });
  });
});

// ────────────────────────────────────────────────────────────────
// unbind + status lifecycle
// ────────────────────────────────────────────────────────────────

describe('D-175 P5 — unbind + status', () => {
  it('unbind clears the binding + audits; a second unbind is not_bound', async () => {
    const h = makeHarness({ withAudit: true });
    await h.manager.bind({ binding_token: tokenFor(ACCT_A) }, ACTOR);

    const first = await h.manager.unbind(ACTOR);
    expect(first.outcome).toBe('unbound');
    if (first.outcome === 'unbound') {
      expect(first.previous.account_id).toBe(ACCT_A);
    }
    expect(h.keyStore.loadAccountBinding()).toBeNull();

    const second = await h.manager.unbind(ACTOR);
    expect(second.outcome).toBe('not_bound');

    const rows = await h.activities();
    expect(rows.filter((r) => r.action === 'account_unbind')).toHaveLength(1);
  });

  it('status reports unbound → bound and stays secret-free', async () => {
    const h = makeHarness();
    expect(h.manager.status()).toEqual({ status: 'unbound', binding: null });
    await h.manager.bind(
      { binding_token: tokenFor(ACCT_A, { publisher_handle: 'mary-co' }) },
      ACTOR,
    );
    const status = h.manager.status();
    expect(status.status).toBe('bound');
    expect(status.binding?.account_id).toBe(ACCT_A);
    expect(status.binding?.publisher_handle).toBe('mary-co');
    expect(status.binding).not.toHaveProperty('server_scoped_credential');
  });
});

// ────────────────────────────────────────────────────────────────
// Signed audit round-trip
// ────────────────────────────────────────────────────────────────

describe('D-175 P5 — signed audit ledger', () => {
  it('the account_bind row is signed, reserve-pinned, verifies, and carries account id + fingerprint + actor (no credential)', async () => {
    const h = makeHarness({ withAudit: true });
    await h.manager.bind({ binding_token: tokenFor(ACCT_A) }, ACTOR);

    const rows = await h.activities();
    const row = rows.find((r) => r.action === 'account_bind');
    expect(row).toBeDefined();
    if (!row) return;

    expect(row.signature).toBeDefined();
    expect(row.signer_fingerprint).toBe(h.identity.public_key_fingerprint);
    expect(row.reserve).toBe(true);
    expect(row.target).toBe(h.identity.public_key_fingerprint);

    const detail = JSON.parse(row.detail ?? '{}');
    expect(detail.account_id).toBe(ACCT_A);
    expect(detail.actor_surface).toBe('pair_client');
    expect(detail.actor_user_id).toBe('mary');
    expect(detail.actor_instance_id).toBe('dev-1');

    const verify = verifyActivityEntry(row, h.identity.public_key_b64);
    expect(verify.ok).toBe(true);
  });

  it('each lifecycle event emits its distinct, uniquely-keyed audit kind', async () => {
    const h = makeHarness({ withAudit: true });
    await h.manager.bind({ binding_token: tokenFor(ACCT_A) }, ACTOR); // account_bind
    h.tick(1000);
    await h.manager.bind({ binding_token: tokenFor(ACCT_B) }, ACTOR); // conflict
    h.tick(1000);
    await h.manager.bind(
      { binding_token: tokenFor(ACCT_B), confirm_rebind: true },
      ACTOR,
    ); // rebind
    h.tick(1000);
    await h.manager.unbind(ACTOR); // unbind

    const rows = await h.activities();
    const kinds = rows.map((r) => r.action).sort();
    expect(kinds).toEqual(
      ['account_bind', 'account_bind_conflict', 'account_rebind', 'account_unbind'].sort(),
    );
    // Distinct activity_ids (append-only history — no overwrite).
    const ids = new Set(rows.map((r) => r.activity_id));
    expect(ids.size).toBe(rows.length);
  });
});

// ────────────────────────────────────────────────────────────────
// HTTP exchange client — failure discipline
// ────────────────────────────────────────────────────────────────

describe('D-175 P5 — HTTP exchange client', () => {
  const req: AccountBindingExchangeRequest = {
    binding_token: 't',
    server_fingerprint: 'sha256:ff',
    server_public_key_b64: 'pk',
    proof_payload: '{}',
    proof_signature: 'sig',
    confirm_rebind: false,
  };

  it('resolves exchange_unavailable when no endpoint is configured', async () => {
    const client = createHttpAccountBindingExchangeClient({
      getEndpointUrl: () => undefined,
      fetchImpl: (() => {
        throw new Error('should not be called');
      }) as unknown as FetchLike,
    });
    const out = await client.exchange(req);
    expect(out).toMatchObject({ ok: false, code: 'exchange_unavailable' });
  });

  it('posts the request and returns a shape-valid success', async () => {
    let posted: { url: string; body: string } | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      posted = { url, body: init?.body ?? '' };
      return {
        status: 200,
        json: async () => ({
          ok: true,
          account_id: ACCT_A,
          server_scoped_credential: 'cred',
          credential_issued_at: 1,
        }),
      };
    };
    const client = createHttpAccountBindingExchangeClient({
      getEndpointUrl: () => 'https://auth.recued.com/v1/account/bind/exchange',
      fetchImpl,
    });
    const out = await client.exchange(req);
    expect(out.ok).toBe(true);
    expect(posted?.url).toContain('/exchange');
    expect(JSON.parse(posted!.body).binding_token).toBe('t');
  });

  it('normalizes an { ok:false, code } error body, collapsing off-list codes to internal', async () => {
    const make = (body: unknown, status = 400) =>
      createHttpAccountBindingExchangeClient({
        getEndpointUrl: () => 'https://x/exchange',
        fetchImpl: async () => ({ status, json: async () => body }),
      });

    const expired = await make({ ok: false, code: 'token_expired' }).exchange(req);
    expect(expired).toMatchObject({ ok: false, code: 'token_expired' });

    const offList = await make({ ok: false, code: 'totally_made_up' }).exchange(req);
    expect(offList).toMatchObject({ ok: false, code: 'internal' });
  });

  it('treats a 2xx without a valid success shape as internal', async () => {
    const client = createHttpAccountBindingExchangeClient({
      getEndpointUrl: () => 'https://x/exchange',
      // 200 but missing server_scoped_credential.
      fetchImpl: async () => ({
        status: 200,
        json: async () => ({ ok: true, account_id: ACCT_A }),
      }),
    });
    expect(await client.exchange(req)).toMatchObject({ ok: false, code: 'internal' });
  });

  it('rejects a success with a wrong-typed OPTIONAL field (publisher_handle / credential_expires_at) as internal', async () => {
    const base = {
      ok: true,
      account_id: ACCT_A,
      server_scoped_credential: 'cred',
      credential_issued_at: 1,
    };
    const badHandle = createHttpAccountBindingExchangeClient({
      getEndpointUrl: () => 'https://x/exchange',
      fetchImpl: async () => ({
        status: 200,
        json: async () => ({ ...base, publisher_handle: 123 }),
      }),
    });
    expect(await badHandle.exchange(req)).toMatchObject({ ok: false, code: 'internal' });

    const badExpiry = createHttpAccountBindingExchangeClient({
      getEndpointUrl: () => 'https://x/exchange',
      fetchImpl: async () => ({
        status: 200,
        json: async () => ({ ...base, credential_expires_at: 'soon' }),
      }),
    });
    expect(await badExpiry.exchange(req)).toMatchObject({ ok: false, code: 'internal' });
  });

  it('passes a shape-valid rebind-conflict outcome through verbatim (not collapsed to a failure)', async () => {
    const client = createHttpAccountBindingExchangeClient({
      getEndpointUrl: () => 'https://x/exchange',
      fetchImpl: async () => ({
        status: 409,
        json: async () => ({
          ok: false,
          conflict: true,
          current_owner: { account_id: ACCT_A },
          incoming: { account_id: ACCT_B },
        }),
      }),
    });
    const out = await client.exchange(req);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect('conflict' in out && out.conflict).toBe(true);
  });

  it('maps a network throw to exchange_unavailable (never throws)', async () => {
    const client = createHttpAccountBindingExchangeClient({
      getEndpointUrl: () => 'https://x/exchange',
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(await client.exchange(req)).toMatchObject({
      ok: false,
      code: 'exchange_unavailable',
    });
  });
});

// ────────────────────────────────────────────────────────────────
// At-rest storage — the identity-keys file
// ────────────────────────────────────────────────────────────────

describe('D-175 P5 — at-rest storage (identity-keys file)', () => {
  const makeTempDir = (): string =>
    mkdtempSync(join(tmpdir(), 'd175-p5-binding-'));
  const cleanup = (dir: string): void =>
    rmSync(dir, { recursive: true, force: true });

  const sampleBinding = () => ({
    account_id: ACCT_A,
    publisher_handle: 'mary-co',
    server_scoped_credential: 'SECRET-cred-on-disk',
    server_fingerprint: 'sha256:abc',
    bound_at: 1_700_000_000_000,
    credential_issued_at: 1_700_000_000_001,
  });

  it('round-trips the binding through the plaintext file-store across a reopen', async () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, 'keys.json');
      const store = await createFileServerKeyStore({ filePath: path });
      store.saveAccountBinding(sampleBinding());
      await flushFileServerKeyStore(store);

      const reopened = await createFileServerKeyStore({ filePath: path });
      const loaded = reopened.loadAccountBinding();
      expect(loaded).toEqual(sampleBinding());
    } finally {
      cleanup(dir);
    }
  });

  it('round-trips under the passphrase-sealed (AEAD) file-store; the wrong passphrase fails closed', async () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, 'keys.json');
      const weak = { t: 1, m: 8, p: 1 };
      const store = await createFileServerKeyStore({
        filePath: path,
        passphrase: 'correct horse',
        argon2_params: weak,
      });
      store.saveAccountBinding(sampleBinding());
      await flushFileServerKeyStore(store);

      const ok = await createFileServerKeyStore({
        filePath: path,
        passphrase: 'correct horse',
        argon2_params: weak,
      });
      expect(ok.loadAccountBinding()).toEqual(sampleBinding());

      await expect(
        createFileServerKeyStore({
          filePath: path,
          passphrase: 'WRONG',
          argon2_params: weak,
        }),
      ).rejects.toThrow();
    } finally {
      cleanup(dir);
    }
  });

  it('clearAccountBinding removes the binding from disk', async () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, 'keys.json');
      const store = await createFileServerKeyStore({ filePath: path });
      store.saveAccountBinding(sampleBinding());
      await flushFileServerKeyStore(store);
      store.clearAccountBinding();
      await flushFileServerKeyStore(store);

      const reopened = await createFileServerKeyStore({ filePath: path });
      expect(reopened.loadAccountBinding()).toBeNull();
      expect(existsSync(path)).toBe(true);
    } finally {
      cleanup(dir);
    }
  });
});

// ────────────────────────────────────────────────────────────────
// RPC handler slice + dispatcher
// ────────────────────────────────────────────────────────────────

describe('D-175 P5 — rpc handler slice', () => {
  const ctx = (
    user_id: string | undefined = 'mary',
    instance_id: string | null = 'dev-1',
  ): WsClient =>
    ({ ws: null, realm: 'recued', instance_id, display_name: 'c', connected_at: 0, user_id }) as unknown as WsClient;

  it('routes account.bind / unbind / bindingStatus through the dispatcher against the manager', async () => {
    const h = makeHarness();
    const slice = makeAccountBindingHandlers({ manager: h.manager });
    expect(slice).toBeDefined();
    const dispatch = createRpcDispatcher(slice!.handlers as never, {});

    const bind = await dispatch('account.bind', { binding_token: tokenFor(ACCT_A) }, ctx());
    expect(bind.ok).toBe(true);
    expect((bind as { body: { outcome: string } }).body.outcome).toBe('bound');

    const status = await dispatch('account.bindingStatus', {}, ctx());
    expect((status as { body: { status: string } }).body.status).toBe('bound');

    const unbind = await dispatch('account.unbind', {}, ctx());
    expect((unbind as { body: { outcome: string } }).body.outcome).toBe('unbound');
  });

  it('records the relaying client user_id / instance_id as audit provenance', async () => {
    const h = makeHarness({ withAudit: true });
    const slice = makeAccountBindingHandlers({ manager: h.manager })!;
    const dispatch = createRpcDispatcher(slice.handlers as never, {});
    await dispatch('account.bind', { binding_token: tokenFor(ACCT_A) }, ctx('bob', 'laptop'));
    const rows = await h.activities();
    const detail = JSON.parse(rows.find((r) => r.action === 'account_bind')!.detail ?? '{}');
    expect(detail.actor_user_id).toBe('bob');
    expect(detail.actor_instance_id).toBe('laptop');
  });

  it('absent deps → the slice drops (undefined) and the dispatcher returns not_configured', async () => {
    expect(makeAccountBindingHandlers(undefined)).toBeUndefined();
    const dispatch = createRpcDispatcher({} as never, {});
    const r = await dispatch('account.bind', { binding_token: 't' }, ctx());
    expect(r.ok).toBe(false);
    expect((r as { error: { code: string } }).error.code).toBe('not_configured');
  });

  it('rejects an UNREGISTERED client (no instance_id) on every account.* method — incl. the no-token unbind / status', async () => {
    const h = makeHarness();
    // Pre-bind via a registered client so there IS a credential an
    // unregistered caller could otherwise clear / read.
    const slice = makeAccountBindingHandlers({ manager: h.manager })!;
    const dispatch = createRpcDispatcher(slice.handlers as never, {});
    await dispatch('account.bind', { binding_token: tokenFor(ACCT_A) }, ctx());

    const unregistered = ctx('mary', null); // instance_id null = pre-register
    for (const [method, args] of [
      ['account.bind', { binding_token: tokenFor(ACCT_B) }],
      ['account.unbind', {}],
      ['account.bindingStatus', {}],
    ] as const) {
      const r = await dispatch(method, args, unregistered);
      expect(r.ok).toBe(false);
      expect((r as { error: { code: string } }).error.code).toBe('unauthorized');
    }
    // The binding is intact — the unregistered unbind did nothing.
    expect(h.keyStore.loadAccountBinding()?.account_id).toBe(ACCT_A);
  });
});

// ────────────────────────────────────────────────────────────────
// Contracts ratchets — channel isolation + registration
// ────────────────────────────────────────────────────────────────

describe('D-175 P5 — contracts ratchets', () => {
  it('account. is reserved local-UI and no account.* method bridges onto the MCP catalog', () => {
    expect(MCP_RESERVED_RPC_PREFIXES).toContain('account.');
    for (const m of ['account.bind', 'account.unbind', 'account.bindingStatus']) {
      expect(isReservedLocalRpc(m)).toBe(true);
      expect(isMcpToolName(m)).toBe(false);
    }
  });

  it('account.* methods are registered in the dispatcher known-method set', () => {
    expect(SERVER_RPC_METHOD_SET.has('account.bind')).toBe(true);
    expect(SERVER_RPC_METHOD_SET.has('account.unbind')).toBe(true);
    expect(SERVER_RPC_METHOD_SET.has('account.bindingStatus')).toBe(true);
  });

  it('every binding audit action is high-assurance (signed)', () => {
    for (const action of ACCOUNT_BINDING_AUDIT_ACTIONS) {
      expect(HIGH_ASSURANCE_AUDIT_KINDS.has(action)).toBe(true);
    }
  });
});

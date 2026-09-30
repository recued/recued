/** D-165 vendor OAuth complete slice 2a.
 *
 * Covers the framework-neutral `/oauth/complete` core plus the completed
 * result store. Valid state tokens are signed with the same real server
 * identity instance that the handler verifies against.
 */

import { describe, expect, it } from 'vitest';
import { OAUTH_STATE_TOKEN_REPLAY_WINDOW_MS } from '@recued/contracts';

import { handleVendorOAuthComplete } from '../connection-vendor-oauth-complete.js';
import {
  createVendorOAuthFlowStore,
  createVendorOAuthResultStore,
  encodeOauthStateToken,
  type VendorOAuthFlowRecord,
  type VendorOAuthResult,
} from '../connection-vendor-oauth-flow.js';
import {
  VendorOAuthError,
  type CompleteVendorOAuthOptions,
} from '../connection-vendor-oauth.js';
import { createServerIdentity, type ServerIdentity } from '../identity/index.js';
import { createInMemoryServerKeyStore, ed25519Sign } from '../keys/index.js';

const NOW = 1_700_000_000_000;
const ORIGIN = 'https://h.example.com';
const DIRECT_REDIRECT = `${ORIGIN}/oauth/complete`;
// D-165 slice 3 — the owner-binding nonce the flow record carries; the
// completion handler copies it into the result store, and `take` requires it.
const CLAIM_SECRET = 'claim-secret-xyz';

const EXCHANGED_RESULT = {
  refresh_token: 'rt-secret',
  granted_scopes: ['x'],
  instance_url: 'https://hubspot.example.com',
};

type FakeExchange = (
  opts: CompleteVendorOAuthOptions,
) => Promise<{ refresh_token: string; granted_scopes: string[]; instance_url?: string }>;

const makeIdentity = (): ServerIdentity =>
  createServerIdentity({
    store: createInMemoryServerKeyStore(),
    now: () => NOW,
  });

const flowRecord = (
  flow_id: string,
  overrides: Partial<VendorOAuthFlowRecord> = {},
): VendorOAuthFlowRecord => ({
  flow_id,
  vendor: 'hubspot',
  client_id: 'cid',
  client_secret: 'client-secret',
  redirect_uri: DIRECT_REDIRECT,
  sandbox: true,
  created_at: NOW,
  claim_secret: CLAIM_SECRET,
  ...overrides,
});

const resultRecord = (suffix: string): VendorOAuthResult => ({
  refresh_token: `rt-${suffix}`,
  granted_scopes: [`scope-${suffix}`],
  instance_url: `https://${suffix}.example.com`,
});

const mintState = (
  identity: ServerIdentity,
  opts: {
    server_url?: string;
    flow_id?: string;
    ts?: number;
  } = {},
): string =>
  encodeOauthStateToken(
    {
      server_url: opts.server_url ?? ORIGIN,
      flow_id: opts.flow_id ?? 'flow-complete',
      ts: opts.ts ?? NOW,
    },
    (bytes) => ed25519Sign(identity.serverIdentityKey(), bytes),
  );

const makeHarness = (
  opts: {
    now?: number;
    serverPublicUrl?: string | readonly string[] | null;
    stateServerUrl?: string;
    stateTs?: number;
    flowId?: string;
    flow?: VendorOAuthFlowRecord | null;
    exchange?: FakeExchange;
  } = {},
) => {
  const now = opts.now ?? NOW;
  const identity = makeIdentity();
  const flow_id = opts.flow?.flow_id ?? opts.flowId ?? 'flow-complete';
  const flow = opts.flow === undefined ? flowRecord(flow_id) : opts.flow;
  const flowStore = createVendorOAuthFlowStore({
    now: () => now,
    ttlMs: OAUTH_STATE_TOKEN_REPLAY_WINDOW_MS + 60_000,
    maxFlows: 16,
  });
  if (flow) flowStore.put(flow);
  const resultStore = createVendorOAuthResultStore({
    now: () => now,
    ttlMs: 60_000,
    maxEntries: 16,
  });
  const exchangeCalls: CompleteVendorOAuthOptions[] = [];
  const exchange: FakeExchange = async (args) => {
    exchangeCalls.push(args);
    if (opts.exchange) return opts.exchange(args);
    return EXCHANGED_RESULT;
  };
  const deps = {
    identity,
    flowStore,
    resultStore,
    serverPublicUrl: () =>
      opts.serverPublicUrl === undefined ? ORIGIN : opts.serverPublicUrl,
    exchange,
    now: () => now,
  };
  const state = mintState(identity, {
    server_url: opts.stateServerUrl,
    flow_id,
    ts: opts.stateTs,
  });

  return {
    deps,
    exchangeCalls,
    flow,
    flowStore,
    identity,
    resultStore,
    state,
    complete: (req: Parameters<typeof handleVendorOAuthComplete>[1]) =>
      handleVendorOAuthComplete(deps, req),
  };
};

describe('D-165 vendor OAuth complete handler', () => {
  it('completes the cloud POST shape, stashes the result, and consumes the flow', async () => {
    const h = makeHarness({ flowId: 'flow-post' });

    const res = await h.complete({
      method: 'POST',
      code: 'auth-code',
      state: h.state,
      flow_id: 'flow-post',
    });

    expect(res.status).toBe(200);
    expect(res.content_type).toBe('application/json');
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(res.outcome).toBe('completed');
    expect(res.flow_id).toBe('flow-post');
    expect(res.body).not.toContain('rt-secret');
    // The result inherited the flow's claim_secret — claiming with it returns
    // the credential; a non-consuming peek confirms the stash independently.
    expect(h.resultStore.peek('flow-post')).toEqual(EXCHANGED_RESULT);
    expect(h.resultStore.take('flow-post', CLAIM_SECRET)).toEqual(EXCHANGED_RESULT);
    expect(h.flowStore.take('flow-post')).toBeNull();
    expect(h.exchangeCalls).toHaveLength(1);
    expect(h.exchangeCalls[0].redirect_uri).toBe(h.flow!.redirect_uri);
    expect(h.exchangeCalls[0].client_id).toBe(h.flow!.client_id);
    expect(h.exchangeCalls[0].client_secret).toBe(h.flow!.client_secret);
    expect(h.exchangeCalls[0].sandbox).toBe(h.flow!.sandbox);
  });

  it('PKCE: passes the consumed flow code_verifier into the exchange', async () => {
    // A flow minted for a supports_pkce vendor carries a code_verifier. The
    // handler must forward it to the exchange so the provider binds the code
    // to THIS flow — an injected code (issued against a different challenge)
    // then fails. Mutation check: drop the passthrough and code_verifier is
    // undefined here.
    const h = makeHarness({
      flow: flowRecord('flow-pkce', { vendor: 'salesforce', code_verifier: 'cv-bound' }),
    });
    const res = await h.complete({
      method: 'POST',
      code: 'auth-code',
      state: h.state,
      flow_id: 'flow-pkce',
    });
    expect(res.outcome).toBe('completed');
    expect(h.exchangeCalls).toHaveLength(1);
    expect(h.exchangeCalls[0].code_verifier).toBe('cv-bound');
  });

  it('omits code_verifier from the exchange for a non-PKCE flow', async () => {
    const h = makeHarness({ flowId: 'flow-nopkce' }); // flowRecord has no code_verifier
    await h.complete({ method: 'POST', code: 'auth-code', state: h.state, flow_id: 'flow-nopkce' });
    expect(h.exchangeCalls[0].code_verifier).toBeUndefined();
  });

  // R14 — a form-supplied flow stored its own token endpoint; the handler
  // synthesizes the provider from it instead of a registry lookup (a registry
  // lookup on the non-registered `vendor` would 500 exchange_failed).
  it('synthesizes the provider from a form-supplied flow token_endpoint', async () => {
    const FORM_TOKEN = 'https://auth.example.com/oauth/token';
    const h = makeHarness({
      flow: flowRecord('flow-form', {
        vendor: 'my-thing',
        token_endpoint: FORM_TOKEN,
        scopes: ['read'],
      }),
    });
    const res = await h.complete({
      method: 'POST',
      code: 'auth-code',
      state: h.state,
      flow_id: 'flow-form',
    });
    expect(res.outcome).toBe('completed');
    expect(h.exchangeCalls).toHaveLength(1);
    expect(h.exchangeCalls[0].provider.oauth.token_endpoint).toBe(FORM_TOKEN);
  });

  it('completes the direct GET shape without a request flow_id and scrubs browser history', async () => {
    const h = makeHarness({ flowId: 'flow-get' });

    const res = await h.complete({
      method: 'GET',
      code: 'auth-code',
      state: h.state,
    });

    expect(res.status).toBe(200);
    expect(res.content_type).toBe('text/html; charset=utf-8');
    expect(res.body).toContain('OAuth complete');
    expect(res.body).toContain('history.replaceState');
    expect(res.outcome).toBe('completed');
    expect(res.flow_id).toBe('flow-get');
    expect(res.body).not.toContain('rt-secret');
    expect(h.resultStore.take('flow-get', CLAIM_SECRET)).toEqual(EXCHANGED_RESULT);
    expect(h.flowStore.take('flow-get')).toBeNull();
  });

  it('rejects a state signed by a different server identity without consuming the flow', async () => {
    const h = makeHarness({ flowId: 'flow-forged' });
    const forgedSigner = makeIdentity();
    const forgedState = mintState(forgedSigner, { flow_id: 'flow-forged' });

    const res = await h.complete({
      method: 'POST',
      code: 'auth-code',
      state: forgedState,
      flow_id: 'flow-forged',
    });

    expect(res.status).toBe(400);
    expect(res.outcome).toBe('invalid_state');
    expect(h.flowStore.take('flow-forged')).toEqual(h.flow);
    expect(h.exchangeCalls).toHaveLength(0);
  });

  it.each(['abc', 'a.b.c', '****.AQID'])(
    'rejects malformed state %j without consuming the flow',
    async (state) => {
      const h = makeHarness({ flowId: 'flow-malformed' });

      const res = await h.complete({
        method: 'POST',
        code: 'auth-code',
        state,
        flow_id: 'flow-malformed',
      });

      expect(res.status).toBe(400);
      expect(res.outcome).toBe('invalid_state');
      expect(h.flowStore.take('flow-malformed')).toEqual(h.flow);
    },
  );

  it('rejects a missing state as bad_request without consuming the flow', async () => {
    const h = makeHarness({ flowId: 'flow-missing-state' });

    const res = await h.complete({
      method: 'POST',
      code: 'auth-code',
      flow_id: 'flow-missing-state',
    });

    expect(res.status).toBe(400);
    expect(res.outcome).toBe('bad_request');
    expect(h.flowStore.take('flow-missing-state')).toEqual(h.flow);
  });

  it('rejects a POST flow_id that does not match the signed state', async () => {
    const h = makeHarness({ flowId: 'flow-state' });

    const res = await h.complete({
      method: 'POST',
      code: 'auth-code',
      state: h.state,
      flow_id: 'flow-other',
    });

    expect(res.status).toBe(400);
    expect(res.outcome).toBe('invalid_state');
    expect(h.flowStore.take('flow-state')).toEqual(h.flow);
    expect(h.exchangeCalls).toHaveLength(0);
  });

  it('rejects stale state tokens outside the replay window without consuming the flow', async () => {
    const h = makeHarness({
      flowId: 'flow-stale',
      now: NOW + OAUTH_STATE_TOKEN_REPLAY_WINDOW_MS + 1,
      stateTs: NOW,
    });

    const res = await h.complete({
      method: 'POST',
      code: 'auth-code',
      state: h.state,
      flow_id: 'flow-stale',
    });

    expect(res.status).toBe(400);
    expect(res.outcome).toBe('expired');
    expect(h.flowStore.take('flow-stale')).toEqual(h.flow);
  });

  it('rejects future-dated state tokens without consuming the flow', async () => {
    const h = makeHarness({
      flowId: 'flow-future',
      now: NOW - 1,
      stateTs: NOW,
    });

    const res = await h.complete({
      method: 'POST',
      code: 'auth-code',
      state: h.state,
      flow_id: 'flow-future',
    });

    expect(res.status).toBe(400);
    expect(res.outcome).toBe('expired');
    expect(h.flowStore.take('flow-future')).toEqual(h.flow);
  });

  it('rejects when the server public URL is not configured without consuming the flow', async () => {
    const h = makeHarness({
      flowId: 'flow-no-public-url',
      serverPublicUrl: null,
    });

    const res = await h.complete({
      method: 'POST',
      code: 'auth-code',
      state: h.state,
      flow_id: 'flow-no-public-url',
    });

    expect(res.status).toBe(503);
    expect(res.outcome).toBe('not_configured');
    expect(h.flowStore.take('flow-no-public-url')).toEqual(h.flow);
  });

  it('rejects a state minted for a different server URL without consuming the flow', async () => {
    const h = makeHarness({
      flowId: 'flow-wrong-server',
      stateServerUrl: 'https://other.example.com',
    });

    const res = await h.complete({
      method: 'POST',
      code: 'auth-code',
      state: h.state,
      flow_id: 'flow-wrong-server',
    });

    expect(res.status).toBe(400);
    expect(res.outcome).toBe('invalid_state');
    expect(h.flowStore.take('flow-wrong-server')).toEqual(h.flow);
  });

  /** The start rpc signs the address the provider returns to, and a server
   *  may have several (a Pro address and a custom domain). Any of ITS OWN is
   *  this server; anything else still is not. */
  it('accepts a state minted for any of the server\'s own addresses', async () => {
    const h = makeHarness({
      flowId: 'flow-second-address',
      serverPublicUrl: ['https://alice.recued.net', 'https://recued.example.com'],
      stateServerUrl: 'https://recued.example.com',
    });

    const res = await h.complete({
      method: 'POST',
      code: 'auth-code',
      state: h.state,
      flow_id: 'flow-second-address',
    });

    expect(res.status).toBe(200);
    expect(res.outcome).toBe('completed');
  });

  it('still rejects a state for an address the server does not have, without consuming the flow', async () => {
    const h = makeHarness({
      flowId: 'flow-not-ours',
      serverPublicUrl: ['https://alice.recued.net', 'https://recued.example.com'],
      stateServerUrl: 'https://other.example.com',
    });

    const res = await h.complete({
      method: 'POST',
      code: 'auth-code',
      state: h.state,
      flow_id: 'flow-not-ours',
    });

    expect(res.status).toBe(400);
    expect(res.outcome).toBe('invalid_state');
    expect(h.flowStore.take('flow-not-ours')).toEqual(h.flow);
  });

  it('returns flow_not_found for a valid state when no pending flow exists', async () => {
    const h = makeHarness({ flowId: 'flow-empty', flow: null });

    const res = await h.complete({
      method: 'POST',
      code: 'auth-code',
      state: h.state,
      flow_id: 'flow-empty',
    });

    expect(res.status).toBe(409);
    expect(res.outcome).toBe('flow_not_found');
    expect(h.exchangeCalls).toHaveLength(0);
  });

  it('treats a successful completion as single-use on replay of the same state', async () => {
    const h = makeHarness({ flowId: 'flow-replay' });

    const first = await h.complete({
      method: 'POST',
      code: 'auth-code',
      state: h.state,
      flow_id: 'flow-replay',
    });
    const second = await h.complete({
      method: 'POST',
      code: 'auth-code-2',
      state: h.state,
      flow_id: 'flow-replay',
    });

    expect(first.status).toBe(200);
    expect(first.outcome).toBe('completed');
    expect(second.status).toBe(409);
    expect(second.outcome).toBe('flow_not_found');
    expect(h.exchangeCalls).toHaveLength(1);
  });

  it('burns the flow on provider_error so the echoed state cannot be replayed', async () => {
    const h = makeHarness({ flowId: 'flow-provider-error' });

    const res = await h.complete({
      method: 'GET',
      state: h.state,
      provider_error: 'access_denied',
    });

    expect(res.status).toBe(400);
    expect(res.outcome).toBe('provider_error');
    expect(h.flowStore.take('flow-provider-error')).toBeNull();
    expect(h.exchangeCalls).toHaveLength(0);
  });

  it('burns the flow on a valid callback that is missing code', async () => {
    const h = makeHarness({ flowId: 'flow-missing-code' });

    const res = await h.complete({
      method: 'POST',
      state: h.state,
      flow_id: 'flow-missing-code',
    });

    expect(res.status).toBe(400);
    expect(res.outcome).toBe('bad_request');
    expect(h.flowStore.take('flow-missing-code')).toBeNull();
    expect(h.exchangeCalls).toHaveLength(0);
  });

  it('burns the flow and stashes no result when token exchange fails', async () => {
    const h = makeHarness({
      flowId: 'flow-exchange-fail',
      exchange: async () => {
        throw new VendorOAuthError('token_exchange_failed', 400, 'boom');
      },
    });

    const res = await h.complete({
      method: 'POST',
      code: 'auth-code',
      state: h.state,
      flow_id: 'flow-exchange-fail',
    });

    expect(res.status).toBe(502);
    expect(res.outcome).toBe('exchange_failed');
    expect(h.flowStore.take('flow-exchange-fail')).toBeNull();
    expect(h.resultStore.take('flow-exchange-fail', CLAIM_SECRET)).toBeNull();
    expect(h.exchangeCalls).toHaveLength(1);
  });

  it('escapes provider_error text reflected into the direct GET error page', async () => {
    const h = makeHarness({ flowId: 'flow-xss-provider' });
    const raw = '<script>alert(1)</script>';

    const res = await h.complete({
      method: 'GET',
      state: h.state,
      provider_error: raw,
    });

    expect(res.status).toBe(400);
    expect(res.outcome).toBe('provider_error');
    expect(res.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(res.body).not.toContain(raw);
    expect(h.flowStore.take('flow-xss-provider')).toBeNull();
  });

  it('escapes VendorOAuthError messages reflected into the direct GET error page', async () => {
    const h = makeHarness({
      flowId: 'flow-xss-exchange',
      exchange: async () => {
        throw new VendorOAuthError(
          'token_exchange_failed',
          400,
          'bad <vendor> "quoted"',
        );
      },
    });

    const res = await h.complete({
      method: 'GET',
      code: 'auth-code',
      state: h.state,
    });

    expect(res.status).toBe(502);
    expect(res.outcome).toBe('exchange_failed');
    expect(res.body).toContain('bad &lt;vendor&gt; &quot;quoted&quot;');
    expect(res.body).not.toContain('bad <vendor> "quoted"');
    expect(h.flowStore.take('flow-xss-exchange')).toBeNull();
  });
});

describe('SMB-finance slice 1b — QuickBooks realmId → config.base_url', () => {
  const qboFlow = (flow_id: string, sandbox: boolean): VendorOAuthFlowRecord =>
    flowRecord(flow_id, { vendor: 'quickbooks', sandbox });
  // QBO's token response carries NO instance_url — the realm composition path
  // is the one under test.
  const noInstanceUrlExchange: FakeExchange = async () => ({
    refresh_token: 'rt-qbo',
    granted_scopes: ['com.intuit.quickbooks.accounting'],
  });

  it('composes the SANDBOX base from the callback realmId (sandbox flow)', async () => {
    const h = makeHarness({ flow: qboFlow('flow-qbo-sbx', true), exchange: noInstanceUrlExchange });
    const res = await h.complete({ method: 'GET', code: 'auth-code', state: h.state, realm_id: '9341457273016687' });
    expect(res.outcome).toBe('completed');
    expect(h.resultStore.peek('flow-qbo-sbx')?.instance_url).toBe(
      'https://sandbox-quickbooks.api.intuit.com/v3/company/9341457273016687',
    );
  });

  it('composes the PRODUCTION base when the flow is not sandbox', async () => {
    const h = makeHarness({ flow: qboFlow('flow-qbo-prod', false), exchange: noInstanceUrlExchange });
    const res = await h.complete({ method: 'GET', code: 'auth-code', state: h.state, realm_id: '9341457273016687' });
    expect(res.outcome).toBe('completed');
    expect(h.resultStore.peek('flow-qbo-prod')?.instance_url).toBe(
      'https://quickbooks.api.intuit.com/v3/company/9341457273016687',
    );
  });

  it('stashes no instance_url when the callback carries no realmId', async () => {
    const h = makeHarness({ flow: qboFlow('flow-qbo-norealm', true), exchange: noInstanceUrlExchange });
    const res = await h.complete({ method: 'GET', code: 'auth-code', state: h.state });
    expect(res.outcome).toBe('completed');
    expect(h.resultStore.peek('flow-qbo-norealm')?.instance_url).toBeUndefined();
  });

  it('a token-response instance_url wins over realm composition', async () => {
    const h = makeHarness({
      flow: qboFlow('flow-qbo-tokenwins', true),
      exchange: async () => ({
        refresh_token: 'rt',
        granted_scopes: [],
        instance_url: 'https://override.example.com',
      }),
    });
    const res = await h.complete({ method: 'GET', code: 'auth-code', state: h.state, realm_id: '9341457273016687' });
    expect(res.outcome).toBe('completed');
    expect(h.resultStore.peek('flow-qbo-tokenwins')?.instance_url).toBe('https://override.example.com');
  });
});

describe('D-165 vendor OAuth completed result store', () => {
  it('put then take returns a result exactly once', () => {
    const store = createVendorOAuthResultStore({ now: () => NOW, ttlMs: 10_000 });
    const result = resultRecord('once');

    store.put('flow-once', result, CLAIM_SECRET, NOW);

    expect(store.take('flow-once', CLAIM_SECRET)).toEqual(result);
    expect(store.take('flow-once', CLAIM_SECRET)).toBeNull();
  });

  it('peek is non-consuming', () => {
    const store = createVendorOAuthResultStore({ now: () => NOW, ttlMs: 10_000 });
    const result = resultRecord('peek');

    store.put('flow-peek', result, CLAIM_SECRET, NOW);

    expect(store.peek('flow-peek')).toEqual(result);
    expect(store.take('flow-peek', CLAIM_SECRET)).toEqual(result);
  });

  it('treats expired results as absent for peek and take', () => {
    let now = NOW;
    const store = createVendorOAuthResultStore({ now: () => now, ttlMs: 100 });

    store.put('flow-expired-peek', resultRecord('expired-peek'), CLAIM_SECRET, NOW);
    store.put('flow-expired-take', resultRecord('expired-take'), CLAIM_SECRET, NOW);
    now = NOW + 101;

    expect(store.peek('flow-expired-peek')).toBeNull();
    expect(store.take('flow-expired-take', CLAIM_SECRET)).toBeNull();
    expect(store.size()).toBe(0);
  });

  it('evicts expired entries on write before adding the fresh result', () => {
    let now = NOW;
    const store = createVendorOAuthResultStore({ now: () => now, ttlMs: 100 });
    store.put('old-1', resultRecord('old-1'), CLAIM_SECRET, NOW);
    store.put('old-2', resultRecord('old-2'), CLAIM_SECRET, NOW);

    now = NOW + 101;
    const fresh = resultRecord('fresh');
    store.put('fresh', fresh, CLAIM_SECRET, now);

    expect(store.size()).toBe(1);
    expect(store.take('old-1', CLAIM_SECRET)).toBeNull();
    expect(store.take('old-2', CLAIM_SECRET)).toBeNull();
    expect(store.take('fresh', CLAIM_SECRET)).toEqual(fresh);
  });

  it('caps maxEntries by evicting the oldest live flow ids', () => {
    const store = createVendorOAuthResultStore({
      now: () => NOW,
      ttlMs: 10_000,
      maxEntries: 3,
    });

    for (let i = 0; i < 5; i += 1) {
      store.put(`flow-${i}`, resultRecord(`${i}`), CLAIM_SECRET, NOW + i);
    }

    expect(store.size()).toBe(3);
    expect(store.take('flow-0', CLAIM_SECRET)).toBeNull();
    expect(store.take('flow-1', CLAIM_SECRET)).toBeNull();
    expect(store.take('flow-2', CLAIM_SECRET)).toEqual(resultRecord('2'));
    expect(store.take('flow-4', CLAIM_SECRET)).toEqual(resultRecord('4'));
  });

  // ── D-165 slice 3 — owner-binding (the [high] claim-race fix) ──────────
  it('a wrong claim_secret returns null WITHOUT consuming — the owner can still claim', () => {
    const store = createVendorOAuthResultStore({ now: () => NOW, ttlMs: 10_000 });
    const result = resultRecord('owned');

    store.put('flow-owned', result, CLAIM_SECRET, NOW);

    // Two paired clients of the same user both see the `{ flow_id }` broadcast.
    // The non-originating client guesses a secret it never received → null, and
    // crucially the entry is NOT consumed, so the legit dialog still gets it.
    expect(store.take('flow-owned', 'wrong-secret')).toBeNull();
    expect(store.peek('flow-owned')).toEqual(result);
    expect(store.take('flow-owned', CLAIM_SECRET)).toEqual(result);
    // ...and only once.
    expect(store.take('flow-owned', CLAIM_SECRET)).toBeNull();
  });

  it('rejects an empty / length-mismatched claim_secret without throwing', () => {
    const store = createVendorOAuthResultStore({ now: () => NOW, ttlMs: 10_000 });
    store.put('flow-empty', resultRecord('empty'), CLAIM_SECRET, NOW);

    expect(store.take('flow-empty', '')).toBeNull();
    expect(store.take('flow-empty', `${CLAIM_SECRET}-longer`)).toBeNull();
    // Still claimable by the owner after the mismatched probes.
    expect(store.take('flow-empty', CLAIM_SECRET)).toEqual(resultRecord('empty'));
  });
});

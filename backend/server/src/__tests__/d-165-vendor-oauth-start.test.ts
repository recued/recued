/** D-165 vendor OAuth-start slice 1.
 *
 * Covers the signed state wire form, pending-flow store, authorize URL
 * construction, pure start helper, and the `collection.connection.startVendorOAuth`
 * rpc handler. The cloud-callback verification helper below mirrors the exact
 * static-page algorithm in `backend/api/src/routes/oauth-callback.ts`.
 */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getVendorProvider,
  OAUTH_CLOUD_CALLBACK_URL,
  type ConnectionVendorProvider,
} from '@recued/contracts';

import { makeConnectionHandlers, type ConnectionRpcDeps } from '../connection-handler.js';
import {
  b64UrlDecode,
  b64UrlEncode,
  buildVendorAuthorizeUrl,
  createVendorOAuthFlowStore,
  createVendorOAuthResultStore,
  decodeOauthStateToken,
  deriveCodeChallenge,
  encodeOauthStateToken,
  startVendorOAuth,
  type VendorOAuthFlowRecord,
  type VendorOAuthResult,
} from '../connection-vendor-oauth-flow.js';
import { createServerIdentity } from '../identity/index.js';
import {
  createInMemoryServerKeyStore,
  ed25519Sign,
  ed25519Verify,
  generateEd25519Keypair,
} from '../keys/index.js';
import { createConnectionStore } from '../storage/connection-store.js';

const NOW = 1_700_000_000_000;
const ORIGIN = 'https://h.example.com';
const DIRECT_REDIRECT = `${ORIGIN}/oauth/complete`;
// D-165 slice 3 — deterministic owner-binding nonce so the handler tests can
// assert the exact `claim_secret` the start rpc returns + stamps into the flow.
const CLAIM_SECRET = 'claim-secret-deterministic';
const START_METHOD = 'collection.connection.startVendorOAuth' as const;
// The handler ignores ctx; `never` satisfies the generic handler signature.
const RPC_CTX = undefined as unknown as never;

const dbs: Database.Database[] = [];

afterEach(() => {
  while (dbs.length > 0) {
    dbs.pop()!.close();
  }
});

const provider = (vendor: string): ConnectionVendorProvider => {
  const p = getVendorProvider(vendor);
  if (!p) throw new Error(`missing provider fixture: ${vendor}`);
  return p;
};

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const flowRecord = (
  flow_id: string,
  overrides: Partial<VendorOAuthFlowRecord> = {},
): VendorOAuthFlowRecord => ({
  flow_id,
  vendor: 'hubspot',
  client_id: 'cid',
  client_secret: 'secret',
  redirect_uri: DIRECT_REDIRECT,
  sandbox: false,
  created_at: NOW,
  claim_secret: CLAIM_SECRET,
  ...overrides,
});

// Copied from OAUTH_CALLBACK_JS semantics: base64url decode with padding,
// import the cached server_identity_key public half as SPKI, then verify
// Ed25519 over the decoded payload bytes.
const cloudCallbackB64urlToBytes = (s: string): Uint8Array => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
};

const verifyWithCloudCallbackAlgorithm = async (
  state: string,
  publicKeyB64: string,
  mutate?: {
    payloadBytes?: (bytes: Uint8Array) => Uint8Array;
    signatureBytes?: (bytes: Uint8Array) => Uint8Array;
  },
): Promise<{ payload: unknown; verified: boolean }> => {
  const parts = state.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('malformed_state');
  }
  const payloadBytes = cloudCallbackB64urlToBytes(parts[0]);
  const payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  const key = await crypto.subtle.importKey(
    'spki',
    cloudCallbackB64urlToBytes(publicKeyB64).buffer as ArrayBuffer,
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  const sig = cloudCallbackB64urlToBytes(parts[1]);
  const verifyPayload = mutate?.payloadBytes?.(payloadBytes) ?? payloadBytes;
  const verifySig = mutate?.signatureBytes?.(sig) ?? sig;
  const verified = await crypto.subtle.verify(
    'Ed25519',
    key,
    verifySig.buffer as ArrayBuffer,
    verifyPayload.buffer as ArrayBuffer,
  );
  return { payload, verified };
};

const validStartArgs = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  vendor: 'hubspot',
  client_id: 'cid',
  client_secret: 'secret',
  redirect_uri: OAUTH_CLOUD_CALLBACK_URL,
  sandbox: false,
  ...overrides,
});

const withoutField = (field: string): Record<string, unknown> => {
  const args = validStartArgs();
  delete args[field];
  return args;
};

const makeSqliteStore = () => {
  const db = new Database(':memory:');
  dbs.push(db);
  return createConnectionStore(db);
};

const makeHandlerHarness = (
  opts: {
    serverPublicUrl?: () => string | readonly string[] | null;
    flowIds?: string[];
    now?: number;
    installedPackScopeUnion?: (vendor: string) => readonly string[];
  } = {},
) => {
  const flowIds = opts.flowIds ?? ['flow-fixed'];
  let flowIdx = 0;
  const identity = createServerIdentity({
    store: createInMemoryServerKeyStore(),
    now: () => opts.now ?? NOW,
  });
  const flowStore = createVendorOAuthFlowStore({
    now: () => opts.now ?? NOW,
    ttlMs: 60_000,
    maxFlows: 16,
  });
  const deps: ConnectionRpcDeps = {
    store: makeSqliteStore(),
    now: () => opts.now ?? NOW,
    vendorOAuthStart: {
      identity,
      flowStore,
      serverPublicUrl: opts.serverPublicUrl ?? (() => ORIGIN),
      newFlowId: () => flowIds[flowIdx++] ?? `flow-${flowIdx}`,
      newClaimSecret: () => CLAIM_SECRET,
      ...(opts.installedPackScopeUnion
        ? { installedPackScopeUnion: opts.installedPackScopeUnion }
        : {}),
    },
  };
  const handlers = makeConnectionHandlers(deps)!.handlers;
  return {
    identity,
    flowStore,
    start: (args: unknown) => handlers[START_METHOD]!(args as never, RPC_CTX),
  };
};

describe('D-165 vendor OAuth-start state codec — cloud callback wire-compat', () => {
  it('produces a URL-safe state token the static callback page verifies with WebCrypto SPKI Ed25519', async () => {
    const keypair = generateEd25519Keypair('server_identity_key');
    const state = encodeOauthStateToken(
      {
        server_url: ORIGIN,
        flow_id: 'flow-page',
        ts: NOW,
      },
      (bytes) => ed25519Sign(keypair, bytes),
    );

    expect(state).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const params = new URLSearchParams();
    params.set('state', state);
    expect(params.get('state')).toBe(state);

    const verified = await verifyWithCloudCallbackAlgorithm(state, keypair.public_key_b64);
    expect(verified.payload).toEqual({
      server_url: ORIGIN,
      flow_id: 'flow-page',
      ts: NOW,
    });
    expect(verified.verified).toBe(true);

    const payloadTampered = await verifyWithCloudCallbackAlgorithm(
      state,
      keypair.public_key_b64,
      {
        payloadBytes: (bytes) => {
          const tampered = bytes.slice();
          const idx = tampered.indexOf('h'.charCodeAt(0));
          expect(idx).toBeGreaterThanOrEqual(0);
          tampered[idx] ^= 1;
          return tampered;
        },
      },
    );
    expect(payloadTampered.verified).toBe(false);

    const sigTampered = await verifyWithCloudCallbackAlgorithm(
      state,
      keypair.public_key_b64,
      {
        signatureBytes: (bytes) => {
          const tampered = bytes.slice();
          tampered[0] ^= 1;
          return tampered;
        },
      },
    );
    expect(sigTampered.verified).toBe(false);
  });
});

describe('D-165 vendor OAuth-start base64url helpers', () => {
  it('round-trips arbitrary bytes across padding-edge lengths 0..4', () => {
    for (let len = 0; len <= 4; len += 1) {
      const bytes = Uint8Array.from({ length: len }, (_v, i) => (i * 73 + 19) % 256);
      const encoded = b64UrlEncode(bytes);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(encoded).not.toContain('=');
      expect(b64UrlDecode(encoded)).toEqual(bytes);
    }
  });
});

describe('D-165 vendor OAuth-start state parser', () => {
  const unsignedState = (payload: unknown, sig = new Uint8Array([1, 2, 3])) =>
    `${b64UrlEncode(utf8(JSON.stringify(payload)))}.${b64UrlEncode(sig)}`;

  it('round-trips an encoded state token without verifying in the parser', () => {
    const keypair = generateEd25519Keypair('server_identity_key');
    const payload = {
      server_url: ORIGIN,
      flow_id: 'flow-roundtrip',
      ts: NOW,
      provider: 'hubspot',
    };
    const state = encodeOauthStateToken(payload, (bytes) => ed25519Sign(keypair, bytes));
    const decoded = decodeOauthStateToken(state);

    expect(decoded).not.toBeNull();
    expect(decoded!.payload).toEqual(payload);
    expect(new TextDecoder().decode(decoded!.payload_bytes)).toBe(JSON.stringify(payload));
    expect(ed25519Verify(keypair.public_key_b64, decoded!.payload_bytes, decoded!.signature_b64))
      .toBe(true);
  });

  it('returns null for malformed state token shapes', () => {
    expect(decodeOauthStateToken('no-dot')).toBeNull();
    expect(decodeOauthStateToken('.AQID')).toBeNull();
    expect(decodeOauthStateToken('AQID.')).toBeNull();
    expect(decodeOauthStateToken('****.AQID')).toBeNull();
    expect(decodeOauthStateToken('AQID.****')).toBeNull();
    expect(decodeOauthStateToken(`${b64UrlEncode(utf8('not json'))}.AQID`)).toBeNull();
    expect(decodeOauthStateToken(unsignedState({ flow_id: 'f', ts: NOW }))).toBeNull();
    expect(decodeOauthStateToken(unsignedState({ server_url: ORIGIN, ts: NOW }))).toBeNull();
    expect(decodeOauthStateToken(unsignedState({ server_url: ORIGIN, flow_id: 'f' }))).toBeNull();
    expect(decodeOauthStateToken(unsignedState({ server_url: 42, flow_id: 'f', ts: NOW })))
      .toBeNull();
    expect(decodeOauthStateToken(unsignedState({ server_url: ORIGIN, flow_id: 42, ts: NOW })))
      .toBeNull();
    expect(decodeOauthStateToken(unsignedState({ server_url: ORIGIN, flow_id: 'f', ts: 'now' })))
      .toBeNull();
  });
});

describe('D-165 vendor OAuth-start authorize URL builder', () => {
  it('builds a HubSpot production authorize URL with provider scopes and no client_secret', () => {
    const hubspot = provider('hubspot');
    const state = 'state-token';
    const url = new URL(buildVendorAuthorizeUrl({
      provider: hubspot,
      client_id: 'cid',
      redirect_uri: OAUTH_CLOUD_CALLBACK_URL,
      sandbox: false,
      state,
    }));

    expect(url.origin + url.pathname).toBe(hubspot.oauth.authorize_url);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe(OAUTH_CLOUD_CALLBACK_URL);
    expect(url.searchParams.get('scope')).toBe(hubspot.oauth.scopes.join(' '));
    expect(url.searchParams.get('state')).toBe(state);
    expect(url.searchParams.has('client_secret')).toBe(false);
    expect(url.toString()).not.toContain('SUPER_SECRET');
  });

  it('selects Salesforce sandbox authorize host when sandbox=true and never leaks client_secret', () => {
    const salesforce = provider('salesforce');
    const state = 'state-token';
    const url = new URL(buildVendorAuthorizeUrl({
      provider: salesforce,
      client_id: 'sf-cid',
      redirect_uri: DIRECT_REDIRECT,
      sandbox: true,
      state,
    }));

    expect(url.hostname).toBe('test.salesforce.com');
    expect(url.origin + url.pathname).toBe(salesforce.oauth.sandbox_authorize_url);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('sf-cid');
    expect(url.searchParams.get('redirect_uri')).toBe(DIRECT_REDIRECT);
    expect(url.searchParams.get('scope')).toBe(salesforce.oauth.scopes.join(' '));
    expect(url.searchParams.get('state')).toBe(state);
    expect(url.searchParams.has('client_secret')).toBe(false);
    expect(url.toString()).not.toContain('SUPER_SECRET');
  });

  it('merges Google authorize_params (access_type=offline + prompt=consent) and the standard keys still win', () => {
    const google = provider('google');
    const url = new URL(buildVendorAuthorizeUrl({
      provider: google,
      client_id: 'g-cid',
      redirect_uri: DIRECT_REDIRECT,
      sandbox: false,
      state: 'state-token',
    }));

    // The refresh-token params are present...
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    // ...and the standard OAuth-start keys are intact (set after the extras, so
    // a vendor's authorize_params can never override state/scope/redirect/etc.).
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('g-cid');
    expect(url.searchParams.get('redirect_uri')).toBe(DIRECT_REDIRECT);
    expect(url.searchParams.get('scope')).toBe(google.oauth.scopes.join(' '));
    expect(url.searchParams.get('state')).toBe('state-token');
  });

  it('requests Dropbox metadata and lazy content-read scopes in the consent URL', () => {
    const dropbox = provider('dropbox');
    const url = new URL(buildVendorAuthorizeUrl({
      provider: dropbox,
      client_id: 'dbx-cid',
      redirect_uri: DIRECT_REDIRECT,
      sandbox: false,
      state: 'state-token',
    }));

    expect(url.searchParams.get('scope')?.split(' ')).toEqual([
      'account_info.read',
      'files.metadata.read',
      'files.content.read',
    ]);
    expect(url.searchParams.get('token_access_type')).toBe('offline');
  });
});

describe('D-165 vendor OAuth-start pending flow store', () => {
  it('put then take returns a record exactly once', () => {
    const store = createVendorOAuthFlowStore({ now: () => NOW, ttlMs: 10_000 });
    const record = flowRecord('flow-once');

    store.put(record);

    expect(store.take('flow-once')).toEqual(record);
    expect(store.take('flow-once')).toBeNull();
  });

  it('peek is non-consuming', () => {
    const store = createVendorOAuthFlowStore({ now: () => NOW, ttlMs: 10_000 });
    const record = flowRecord('flow-peek');

    store.put(record);

    expect(store.peek('flow-peek')).toEqual(record);
    expect(store.take('flow-peek')).toEqual(record);
  });

  it('treats expired records as absent for peek and take', () => {
    let now = NOW;
    const store = createVendorOAuthFlowStore({ now: () => now, ttlMs: 100 });

    store.put(flowRecord('flow-expired-peek', { created_at: NOW }));
    store.put(flowRecord('flow-expired-take', { created_at: NOW }));
    now = NOW + 101;

    expect(store.peek('flow-expired-peek')).toBeNull();
    expect(store.take('flow-expired-take')).toBeNull();
    expect(store.size()).toBe(0);
  });

  it('evicts expired entries on write before adding the fresh record', () => {
    let now = NOW;
    const store = createVendorOAuthFlowStore({ now: () => now, ttlMs: 100 });
    store.put(flowRecord('old-1', { created_at: NOW }));
    store.put(flowRecord('old-2', { created_at: NOW }));

    now = NOW + 101;
    store.put(flowRecord('fresh', { created_at: now }));

    expect(store.size()).toBe(1);
    expect(store.take('old-1')).toBeNull();
    expect(store.take('old-2')).toBeNull();
    expect(store.take('fresh')).toEqual(flowRecord('fresh', { created_at: now }));
  });

  it('caps maxFlows by evicting the oldest live flow ids', () => {
    const store = createVendorOAuthFlowStore({ now: () => NOW, ttlMs: 10_000, maxFlows: 3 });

    for (let i = 0; i < 5; i += 1) {
      store.put(flowRecord(`flow-${i}`, { created_at: NOW + i }));
    }

    expect(store.size()).toBe(3);
    expect(store.take('flow-0')).toBeNull();
    expect(store.take('flow-1')).toBeNull();
    expect(store.take('flow-4')).toEqual(flowRecord('flow-4', { created_at: NOW + 4 }));
  });
});

describe('D-165 vendor OAuth-start pure start helper', () => {
  it('persists the full BYO credential record and embeds the signed state in authorize_url', () => {
    const keypair = generateEd25519Keypair('server_identity_key');
    const result = startVendorOAuth({
      provider: provider('hubspot'),
      client_id: 'cid',
      client_secret: 'secret',
      redirect_uri: OAUTH_CLOUD_CALLBACK_URL,
      sandbox: false,
      server_url: ORIGIN,
      flow_id: 'flow-start',
      claim_secret: CLAIM_SECRET,
      code_verifier: 'cv-start',
      now: NOW,
      sign: (bytes) => ed25519Sign(keypair, bytes),
    });

    // HubSpot is non-PKCE → no code_verifier stamped, no challenge in the URL.
    expect(result.record).toEqual({
      flow_id: 'flow-start',
      vendor: 'hubspot',
      client_id: 'cid',
      client_secret: 'secret',
      redirect_uri: OAUTH_CLOUD_CALLBACK_URL,
      sandbox: false,
      created_at: NOW,
      claim_secret: CLAIM_SECRET,
    });
    expect(new URL(result.authorize_url).searchParams.has('code_challenge')).toBe(false);
    expect(new URL(result.authorize_url).searchParams.get('state')).toBe(result.state);
    expect(decodeOauthStateToken(result.state)!.payload).toEqual({
      server_url: ORIGIN,
      flow_id: 'flow-start',
      ts: NOW,
      provider: 'hubspot',
    });
  });

  it('omits client_secret from the pending-flow record when the caller omits it', () => {
    const keypair = generateEd25519Keypair('server_identity_key');
    const result = startVendorOAuth({
      provider: provider('hubspot'),
      client_id: 'cid',
      redirect_uri: OAUTH_CLOUD_CALLBACK_URL,
      sandbox: true,
      server_url: ORIGIN,
      flow_id: 'flow-no-secret',
      claim_secret: CLAIM_SECRET,
      code_verifier: 'cv-start',
      now: NOW,
      sign: (bytes) => ed25519Sign(keypair, bytes),
    });

    expect(Object.prototype.hasOwnProperty.call(result.record, 'client_secret')).toBe(false);
    expect(result.record.sandbox).toBe(true);
  });

  it('PKCE: deriveCodeChallenge matches the RFC 7636 Appendix B S256 test vector', () => {
    // Independent oracle (not the impl helper) so a regression in the S256
    // encoding (wrong hash, padding, std-vs-url base64) is caught.
    expect(deriveCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('PKCE: a supports_pkce vendor stamps the verifier + adds the S256 challenge', () => {
    const keypair = generateEd25519Keypair('server_identity_key');
    const code_verifier = 'pkce-verifier-fixed';
    const result = startVendorOAuth({
      provider: provider('salesforce'),
      client_id: 'cid',
      client_secret: 'secret',
      redirect_uri: OAUTH_CLOUD_CALLBACK_URL,
      sandbox: false,
      server_url: ORIGIN,
      flow_id: 'flow-pkce',
      claim_secret: CLAIM_SECRET,
      code_verifier,
      now: NOW,
      sign: (bytes) => ed25519Sign(keypair, bytes),
    });

    // Verifier is held server-side in the flow record (never on the URL).
    expect(result.record.code_verifier).toBe(code_verifier);
    const url = new URL(result.authorize_url);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // The challenge is base64url(sha256(verifier)) — matches the helper.
    expect(url.searchParams.get('code_challenge')).toBe(deriveCodeChallenge(code_verifier));
    // The raw verifier must NEVER appear in the authorize URL.
    expect(result.authorize_url).not.toContain(code_verifier);
  });
});

describe('D-165 vendor OAuth-start rpc handler', () => {
  it('rejects not_configured when the OAuth-start wiring is absent', async () => {
    const handlers = makeConnectionHandlers({ store: makeSqliteStore() })!.handlers;

    await expect(handlers[START_METHOD]!(validStartArgs() as never, RPC_CTX))
      .rejects.toMatchObject({ code: 'not_configured' });
  });

  it.each([
    ['null', null],
    ['empty', ''],
  ])('rejects not_configured when serverPublicUrl() returns %s', async (_label, raw) => {
    const h = makeHandlerHarness({ serverPublicUrl: () => raw });

    await expect(h.start(validStartArgs())).rejects.toMatchObject({ code: 'not_configured' });
  });

  it.each([
    ['http://h'],
    ['https://h/path'],
  ])('rejects not_configured for non-clean server public URL %s', async (raw) => {
    const h = makeHandlerHarness({ serverPublicUrl: () => raw });

    await expect(h.start(validStartArgs())).rejects.toMatchObject({ code: 'not_configured' });
  });

  it.each([
    ['missing vendor', withoutField('vendor')],
    ['missing client_id', withoutField('client_id')],
    ['missing redirect_uri', withoutField('redirect_uri')],
    ['empty client_secret', validStartArgs({ client_secret: '' })],
    ['non-boolean sandbox', validStartArgs({ sandbox: 'sandbox' })],
    ['unknown vendor', validStartArgs({ vendor: 'unknown' })],
    ['hubspot without client_secret', withoutField('client_secret')],
    ['salesforce without client_secret', validStartArgs({ vendor: 'salesforce', client_secret: undefined })],
    ['redirect_uri outside choices', validStartArgs({ redirect_uri: 'https://evil.example/oauth/complete' })],
  ])('rejects bad_request for %s', async (_label, args) => {
    const h = makeHandlerHarness();

    await expect(h.start(args)).rejects.toMatchObject({ code: 'bad_request' });
  });

  it.each([
    ['cloud callback', OAUTH_CLOUD_CALLBACK_URL, 'flow-cloud'],
    ['direct callback', DIRECT_REDIRECT, 'flow-direct'],
  ])('returns authorize_url, flow_id, public key, and persists the flow for %s', async (
    _label,
    redirect_uri,
    flow_id,
  ) => {
    const h = makeHandlerHarness({ flowIds: [flow_id] });

    const result = await h.start(validStartArgs({ redirect_uri }));

    expect(result.flow_id).toBe(flow_id);
    expect(result.server_identity_public_key_b64).toBe(
      h.identity.serverIdentityKey().public_key_b64,
    );
    // The owner-binding nonce is returned ONLY here (to the originating client).
    expect(result.claim_secret).toBe(CLAIM_SECRET);
    const authorizeUrl = new URL(result.authorize_url);
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(redirect_uri);
    expect(authorizeUrl.searchParams.get('state')).toBeTruthy();
    expect(h.flowStore.take(flow_id)).toEqual({
      flow_id,
      vendor: 'hubspot',
      client_id: 'cid',
      client_secret: 'secret',
      redirect_uri,
      sandbox: false,
      created_at: NOW,
      claim_secret: CLAIM_SECRET,
    });
  });

  it('canonicalizes a trailing-slash serverPublicUrl for direct redirect and signed state', async () => {
    const h = makeHandlerHarness({
      serverPublicUrl: () => 'https://h/',
      flowIds: ['flow-slash'],
    });

    const result = await h.start(validStartArgs({ redirect_uri: 'https://h/oauth/complete' }));
    const authorizeUrl = new URL(result.authorize_url);
    const state = authorizeUrl.searchParams.get('state');

    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe('https://h/oauth/complete');
    expect(state).toBeTruthy();
    expect(decodeOauthStateToken(state!)!.payload.server_url).toBe('https://h');
    expect(h.flowStore.take('flow-slash')!.redirect_uri).toBe('https://h/oauth/complete');
  });

  /** ⛔ 2026-09-29: the server's public URL came from RECUED_PUBLIC_BASE_URL
   *  alone, so a Pro server that never set it refused every vendor sign-in.
   *  It is now every one of the server's own addresses — and a page at the
   *  server's https name sends ITS OWN /oauth/complete, so an owner with a Pro
   *  address and a custom domain must be able to start from either. */
  describe("the server's own addresses — more than one", () => {
    const PRO = 'https://alice.recued.net';
    const OWN = 'https://recued.example.com';

    it('accepts the direct choice at the second address, and the state names that address', async () => {
      const h = makeHandlerHarness({ serverPublicUrl: () => [PRO, OWN], flowIds: ['flow-own'] });
      const result = await h.start(validStartArgs({ redirect_uri: `${OWN}/oauth/complete` }));
      const state = new URL(result.authorize_url).searchParams.get('state')!;
      expect(decodeOauthStateToken(state)!.payload.server_url).toBe(OWN);
    });

    it('signs the preferred (first) address for the app.recued.com choice', async () => {
      const h = makeHandlerHarness({ serverPublicUrl: () => [PRO, OWN], flowIds: ['flow-cloud2'] });
      const result = await h.start(validStartArgs({ redirect_uri: OAUTH_CLOUD_CALLBACK_URL }));
      const state = new URL(result.authorize_url).searchParams.get('state')!;
      expect(decodeOauthStateToken(state)!.payload.server_url).toBe(PRO);
    });

    it('refuses an address that is none of them, and names every choice', async () => {
      const h = makeHandlerHarness({ serverPublicUrl: () => [PRO, OWN] });
      await expect(h.start(validStartArgs({ redirect_uri: 'https://evil.example/oauth/complete' })))
        .rejects.toMatchObject({
          code: 'bad_request',
          message: expect.stringContaining(`${OWN}/oauth/complete`),
        });
    });

    it('an unusable address does not block a usable one', async () => {
      const h = makeHandlerHarness({ serverPublicUrl: () => ['http://h', PRO], flowIds: ['flow-pro'] });
      const result = await h.start(validStartArgs({ redirect_uri: `${PRO}/oauth/complete` }));
      expect(result.flow_id).toBe('flow-pro');
    });

    it('none at all is not_configured', async () => {
      const h = makeHandlerHarness({ serverPublicUrl: () => [] });
      await expect(h.start(validStartArgs())).rejects.toMatchObject({ code: 'not_configured' });
    });
  });

  // R14 — form-supplied OAuth config (a generic BYO vendor, no registry entry).
  it('synthesizes a provider from form-supplied authorize_url + token_endpoint + scopes', async () => {
    const h = makeHandlerHarness({ flowIds: ['flow-form'] });
    const FORM_AUTHORIZE = 'https://auth.example.com/authorize';
    const FORM_TOKEN = 'https://auth.example.com/oauth/token';

    const result = await h.start({
      vendor: 'my-thing',
      client_id: 'cid',
      redirect_uri: OAUTH_CLOUD_CALLBACK_URL,
      sandbox: false,
      authorize_url: FORM_AUTHORIZE,
      token_endpoint: FORM_TOKEN,
      scopes: ['read', 'write'],
    });

    const url = new URL(result.authorize_url);
    expect(`${url.origin}${url.pathname}`).toBe(FORM_AUTHORIZE);
    expect(url.searchParams.get('scope')).toBe('read write');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe(OAUTH_CLOUD_CALLBACK_URL);
    // The token endpoint + requested scopes ride the flow record so
    // /oauth/complete can exchange without a registry lookup; no client_secret
    // is required for a form-supplied (public) client.
    const rec = h.flowStore.take('flow-form')!;
    expect(rec.vendor).toBe('my-thing');
    expect(rec.token_endpoint).toBe(FORM_TOKEN);
    expect(rec.scopes).toEqual(['read', 'write']);
    expect(rec.client_secret).toBeUndefined();
  });

  it('rejects a form-supplied flow with a non-URL authorize_url', async () => {
    const h = makeHandlerHarness();
    await expect(
      h.start({
        vendor: 'my-thing',
        client_id: 'cid',
        redirect_uri: OAUTH_CLOUD_CALLBACK_URL,
        authorize_url: 'not-a-url',
        token_endpoint: 'https://auth.example.com/oauth/token',
      }),
    ).rejects.toThrow(/authorize_url must be a complete HTTPS URL/);
    expect(h.flowStore.size()).toBe(0);
  });

  // Codex MED — credentials POST to token_endpoint, so plaintext is rejected.
  it('rejects a form-supplied http token_endpoint (credentials must not go over plaintext)', async () => {
    const h = makeHandlerHarness();
    await expect(
      h.start({
        vendor: 'my-thing',
        client_id: 'cid',
        redirect_uri: OAUTH_CLOUD_CALLBACK_URL,
        authorize_url: 'https://auth.example.com/authorize',
        token_endpoint: 'http://auth.example.com/oauth/token',
      }),
    ).rejects.toThrow(/token_endpoint must be a complete HTTPS URL/);
    expect(h.flowStore.size()).toBe(0);
  });

  it.each([
    ['embedded userinfo', 'https://owner:password@auth.example.com/oauth/token'],
    ['parser-normalized shorthand', 'https:auth.example.com/oauth/token'],
    ['a URL fragment', 'https://auth.example.com/oauth/token#ignored'],
  ])('rejects a form-supplied token_endpoint with %s before creating a flow', async (_case, endpoint) => {
    const h = makeHandlerHarness();
    await expect(
      h.start({
        vendor: 'my-thing',
        client_id: 'cid',
        redirect_uri: OAUTH_CLOUD_CALLBACK_URL,
        authorize_url: 'https://auth.example.com/authorize',
        token_endpoint: endpoint,
      }),
    ).rejects.toThrow(/token_endpoint must be a complete HTTPS URL/);
    expect(h.flowStore.size()).toBe(0);
  });

  // Codex HIGH — a REGISTERED vendor always uses its registry config; any
  // form-supplied endpoints are ignored (they cannot bypass PKCE / scopes /
  // the secret gate). The persisted record stays the strict registered shape.
  it('a registered vendor ignores form-supplied endpoints and uses the registry', async () => {
    const h = makeHandlerHarness({ flowIds: ['flow-reg'] });
    const result = await h.start(
      validStartArgs({
        authorize_url: 'https://evil.example.com/authorize',
        token_endpoint: 'https://evil.example.com/token',
      }),
    );
    // The authorize URL is the registered HubSpot one, NOT the form value.
    expect(result.authorize_url).toContain('app.hubspot.com');
    expect(result.authorize_url).not.toContain('evil.example.com');
    const rec = h.flowStore.take('flow-reg')!;
    expect(rec.vendor).toBe('hubspot');
    expect(rec.token_endpoint).toBeUndefined();
    expect(rec.scopes).toBeUndefined();
  });
});

describe('D-165 vendor OAuth result-claim rpc handler (slice 3)', () => {
  const TAKE_METHOD = 'collection.connection.takeVendorOAuthResult' as const;
  const RESULT: VendorOAuthResult = {
    refresh_token: 'rt-claimed',
    granted_scopes: ['scope-a'],
    instance_url: 'https://i.example.com',
  };

  const makeTakeHarness = () => {
    const resultStore = createVendorOAuthResultStore({ now: () => NOW, ttlMs: 60_000 });
    const deps: ConnectionRpcDeps = {
      store: makeSqliteStore(),
      now: () => NOW,
      vendorOAuthResult: { resultStore },
    };
    const handlers = makeConnectionHandlers(deps)!.handlers;
    return {
      resultStore,
      take: (args: unknown) => handlers[TAKE_METHOD]!(args as never, RPC_CTX),
    };
  };

  it('rejects not_configured when the result substrate is absent', async () => {
    const handlers = makeConnectionHandlers({ store: makeSqliteStore() })!.handlers;
    await expect(
      handlers[TAKE_METHOD]!({ flow_id: 'f', claim_secret: 's' } as never, RPC_CTX),
    ).rejects.toMatchObject({ code: 'not_configured' });
  });

  it.each([
    ['missing flow_id', { claim_secret: 's' }],
    ['empty flow_id', { flow_id: '  ', claim_secret: 's' }],
    ['missing claim_secret', { flow_id: 'f' }],
    ['empty claim_secret', { flow_id: 'f', claim_secret: '' }],
  ])('rejects bad_request for %s', async (_label, args) => {
    const h = makeTakeHarness();
    await expect(h.take(args)).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('returns null for an unknown flow without throwing', async () => {
    const h = makeTakeHarness();
    await expect(h.take({ flow_id: 'nope', claim_secret: CLAIM_SECRET })).resolves.toEqual({
      result: null,
    });
  });

  it('two-client race: the wrong secret gets null + cannot starve the owner; the owner claims once', async () => {
    const h = makeTakeHarness();
    h.resultStore.put('flow-race', RESULT, CLAIM_SECRET, NOW);

    // Client B (reacted to the `{ flow_id }` broadcast but never received the
    // secret) probes with a guess → null, and MUST NOT consume the entry.
    await expect(h.take({ flow_id: 'flow-race', claim_secret: 'guessed' })).resolves.toEqual({
      result: null,
    });

    // Client A (the originator, holding the secret) still claims the credential.
    await expect(
      h.take({ flow_id: 'flow-race', claim_secret: CLAIM_SECRET }),
    ).resolves.toEqual({ result: RESULT });

    // ...and only once — the claim consumed it.
    await expect(
      h.take({ flow_id: 'flow-race', claim_secret: CLAIM_SECRET }),
    ).resolves.toEqual({ result: null });
  });
});

describe('D-165 / Fork 1 — installed-pack scope union on the registered start path', () => {
  const scopeOf = (authorize_url: string): string =>
    new URL(authorize_url).searchParams.get('scope') ?? '';

  it('requests the vendor const verbatim when no union fn + no client scopes (no regression)', async () => {
    const h = makeHandlerHarness();
    const result = await h.start(validStartArgs());
    expect(scopeOf(result.authorize_url)).toBe(provider('hubspot').oauth.scopes.join(' '));
  });

  it('unions the installed packs needs on top of the const floor (server-computed)', async () => {
    const h = makeHandlerHarness({
      installedPackScopeUnion: (vendor) =>
        vendor === 'hubspot' ? ['crm.objects.deals.write'] : [],
    });
    const result = await h.start(validStartArgs());
    const expected = [
      ...new Set([...provider('hubspot').oauth.scopes, 'crm.objects.deals.write']),
    ].join(' ');
    expect(scopeOf(result.authorize_url)).toBe(expected);
    // The const floor is preserved (essentials like `oauth` survive).
    expect(scopeOf(result.authorize_url).split(' ')).toContain('oauth');
  });

  it('honors an explicit client scope set (B) and does NOT consult the union fn', async () => {
    const h = makeHandlerHarness({
      installedPackScopeUnion: () => {
        throw new Error('union fn must not be consulted when the client passes scopes');
      },
    });
    const result = await h.start(
      validStartArgs({ scopes: ['crm.objects.deals.write', '  ', 'crm.objects.deals.write'] }),
    );
    const expected = [
      ...new Set([...provider('hubspot').oauth.scopes, 'crm.objects.deals.write']),
    ].join(' ');
    expect(scopeOf(result.authorize_url)).toBe(expected);
  });

  it('keeps the const floor even when the client trims it from the passed set', async () => {
    // The client passes only a write scope (omitting the const essentials) —
    // the const floor is re-added so the connection can still refresh/operate.
    const h = makeHandlerHarness();
    const result = await h.start(validStartArgs({ scopes: ['crm.objects.deals.write'] }));
    const scopes = scopeOf(result.authorize_url).split(' ');
    for (const essential of provider('hubspot').oauth.scopes) {
      expect(scopes).toContain(essential);
    }
    expect(scopes).toContain('crm.objects.deals.write');
  });

  it('rejects a non-string-array scopes arg', async () => {
    const h = makeHandlerHarness();
    await expect(
      h.start(validStartArgs({ scopes: [42] })),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });
});

/** D-165 vendor OAuth complete slice 2b PortRequestHandler adapter. */

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { OAUTH_STATE_TOKEN_REPLAY_WINDOW_MS } from '@recued/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  createVendorOAuthCompletePortHandler,
  type VendorOAuthCompletePortHandlerDeps,
} from '../connection-vendor-oauth-complete-port.js';
import type { CompleteVendorOAuthOptions } from '../connection-vendor-oauth.js';
import {
  createVendorOAuthFlowStore,
  createVendorOAuthResultStore,
  encodeOauthStateToken,
  type VendorOAuthFlowRecord,
} from '../connection-vendor-oauth-flow.js';
import { createServerIdentity, type ServerIdentity } from '../identity/index.js';
import { createInMemoryServerKeyStore, ed25519Sign } from '../keys/index.js';

const NOW = 1_700_000_000_000;
const ORIGIN = 'https://h.example.com';
const DIRECT_REDIRECT = `${ORIGIN}/oauth/complete`;
// D-165 slice 3 — the owner-binding nonce on the flow; the result inherits it.
const CLAIM_SECRET = 'claim-secret-xyz';
const SCRUB_SCRIPT = 'history.replaceState(null,"","/oauth/complete")';

const EXCHANGED_RESULT = {
  refresh_token: 'rt-secret',
  granted_scopes: ['x'],
  instance_url: 'https://hubspot.example.com',
};

type FakeExchange = (
  opts: CompleteVendorOAuthOptions,
) => Promise<{ refresh_token: string; granted_scopes: string[]; instance_url?: string }>;

interface MockRes {
  statusCode: number;
  headers: Record<string, string>;
  ended: string;
  setHeader(k: string, v: string | number | readonly string[]): void;
  end(b?: string): void;
}

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

const makeRes = (): MockRes =>
  ({
    statusCode: 0,
    headers: {},
    ended: '',
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
    },
    end(b) {
      this.ended = b ?? '';
    },
  }) as MockRes;

const buildReq = (opts: {
  method: string;
  url: string;
  body?: string;
}): IncomingMessage => {
  const chunks = opts.body === undefined ? [] : [Buffer.from(opts.body, 'utf8')];
  const stream = Readable.from(chunks) as unknown as IncomingMessage;
  (stream as unknown as { method: string }).method = opts.method;
  (stream as unknown as { url: string }).url = opts.url;
  (stream as unknown as { headers: Record<string, string> }).headers = {};
  return stream;
};

const buildManualReq = (opts: {
  method: string;
  url: string;
}): IncomingMessage & EventEmitter => {
  const req = new EventEmitter() as IncomingMessage & EventEmitter;
  (req as unknown as { method: string }).method = opts.method;
  (req as unknown as { url: string }).url = opts.url;
  (req as unknown as { headers: Record<string, string> }).headers = {};
  return req;
};

const resolvesWithin = (promise: void | Promise<void>, ms = 50): Promise<boolean> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => resolve(false), ms);
    Promise.resolve(promise).then(
      () => {
        clearTimeout(timeout);
        resolve(true);
      },
      (err: unknown) => {
        clearTimeout(timeout);
        reject(err);
      },
    );
  });

const makeHarness = (
  opts: {
    flowId?: string;
    maxBodyBytes?: number;
    exchange?: FakeExchange;
    flow?: VendorOAuthFlowRecord;
  } = {},
) => {
  const identity = makeIdentity();
  const flow_id = opts.flow?.flow_id ?? opts.flowId ?? 'flow-complete';
  const flow = opts.flow ?? flowRecord(flow_id);
  const flowStore = createVendorOAuthFlowStore({
    now: () => NOW,
    ttlMs: OAUTH_STATE_TOKEN_REPLAY_WINDOW_MS + 60_000,
    maxFlows: 16,
  });
  flowStore.put(flow);
  const resultStore = createVendorOAuthResultStore({
    now: () => NOW,
    ttlMs: 60_000,
    maxEntries: 16,
  });
  const exchangeCalls: CompleteVendorOAuthOptions[] = [];
  const exchange: FakeExchange = async (args) => {
    exchangeCalls.push(args);
    if (opts.exchange) return opts.exchange(args);
    return EXCHANGED_RESULT;
  };
  const onCompleted = vi.fn();
  const deps: VendorOAuthCompletePortHandlerDeps = {
    identity,
    flowStore,
    resultStore,
    serverPublicUrl: () => ORIGIN,
    exchange,
    now: () => NOW,
    onCompleted,
    ...(opts.maxBodyBytes !== undefined ? { maxBodyBytes: opts.maxBodyBytes } : {}),
  };
  const state = mintState(identity, { flow_id });

  return {
    exchangeCalls,
    flow,
    flowStore,
    handler: createVendorOAuthCompletePortHandler(deps),
    identity,
    onCompleted,
    resultStore,
    state,
  };
};

const invoke = async (
  handler: ReturnType<typeof createVendorOAuthCompletePortHandler>,
  req: IncomingMessage,
): Promise<MockRes> => {
  const res = makeRes();
  await handler(req, res as unknown as ServerResponse);
  return res;
};

const json = (res: MockRes): unknown => JSON.parse(res.ended);

describe('D-165 vendor OAuth complete PortRequestHandler adapter', () => {
  it('completes a direct GET, hardens the HTML response, and signals the completed flow_id', async () => {
    const h = makeHarness({ flowId: 'flow-get' });
    const expectedScriptHash = createHash('sha256')
      .update(SCRUB_SCRIPT, 'utf8')
      .digest('base64');

    const res = await invoke(
      h.handler,
      buildReq({
        method: 'GET',
        url: `/oauth/complete?code=auth-code&state=${encodeURIComponent(h.state)}`,
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.ended).toContain('OAuth complete');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-security-policy']).toContain(
      `sha256-${expectedScriptHash}`,
    );
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(h.onCompleted).toHaveBeenCalledTimes(1);
    expect(h.onCompleted).toHaveBeenCalledWith('flow-get');
    expect(h.resultStore.take('flow-get', CLAIM_SECRET)).toEqual(EXCHANGED_RESULT);
  });

  it('extracts the QuickBooks ?realmId= from the GET callback and composes config.base_url', async () => {
    // SMB-finance slice 1b — the real QBO enrollment flow: the provider
    // redirects to /oauth/complete?code&state&realmId; the adapter must parse
    // realmId so the handler composes <sandbox-host>/v3/company/<realmId>.
    const h = makeHarness({
      flow: flowRecord('flow-qbo-port', { vendor: 'quickbooks', sandbox: true }),
      exchange: async () => ({ refresh_token: 'rt-qbo', granted_scopes: [] }),
    });

    const res = await invoke(
      h.handler,
      buildReq({
        method: 'GET',
        url: `/oauth/complete?code=auth-code&state=${encodeURIComponent(h.state)}&realmId=9341457273016687`,
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(h.onCompleted).toHaveBeenCalledWith('flow-qbo-port');
    expect(h.resultStore.peek('flow-qbo-port')?.instance_url).toBe(
      'https://sandbox-quickbooks.api.intuit.com/v3/company/9341457273016687',
    );
  });

  it('extracts the QuickBooks realmId from the cloud POST body and composes config.base_url', async () => {
    // The real in-app flow: the cloud /oauth-callback page POSTs
    // { code, state, flow_id, realmId } to the user-server. The adapter must
    // parse realmId from the POST body so the handler composes the company base.
    const h = makeHarness({
      flow: flowRecord('flow-qbo-post', { vendor: 'quickbooks', sandbox: true }),
      exchange: async () => ({ refresh_token: 'rt-qbo', granted_scopes: [] }),
    });

    const res = await invoke(
      h.handler,
      buildReq({
        method: 'POST',
        url: '/oauth/complete',
        body: JSON.stringify({
          code: 'auth-code',
          state: h.state,
          flow_id: 'flow-qbo-post',
          realmId: '9341457273016687',
        }),
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(h.onCompleted).toHaveBeenCalledWith('flow-qbo-post');
    expect(h.resultStore.peek('flow-qbo-post')?.instance_url).toBe(
      'https://sandbox-quickbooks.api.intuit.com/v3/company/9341457273016687',
    );
  });

  it('completes the cloud POST shape as JSON without leaking the refresh token', async () => {
    const h = makeHarness({ flowId: 'flow-post' });

    const res = await invoke(
      h.handler,
      buildReq({
        method: 'POST',
        url: '/oauth/complete',
        body: JSON.stringify({
          code: 'auth-code',
          state: h.state,
          flow_id: 'flow-post',
        }),
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json');
    expect(json(res)).toEqual({ ok: true });
    expect(res.headers['content-security-policy']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
    expect(h.onCompleted).toHaveBeenCalledTimes(1);
    expect(h.onCompleted).toHaveBeenCalledWith('flow-post');
    expect(res.ended).not.toContain('rt-secret');
    expect(h.resultStore.take('flow-post', CLAIM_SECRET)).toEqual(EXCHANGED_RESULT);
  });

  it('burns the flow without signaling completion when the provider denies a GET authorization', async () => {
    const h = makeHarness({ flowId: 'flow-denied' });

    const res = await invoke(
      h.handler,
      buildReq({
        method: 'GET',
        url: `/oauth/complete?error=access_denied&state=${encodeURIComponent(h.state)}`,
      }),
    );

    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.ended).toContain('Authorization failed: access_denied');
    expect(h.onCompleted).not.toHaveBeenCalled();
    expect(h.flowStore.take('flow-denied')).toBeNull();
  });

  it('settles immediately on an over-cap POST body without waiting for end', async () => {
    const h = makeHarness({ flowId: 'flow-over-cap', maxBodyBytes: 8 });
    const req = buildManualReq({ method: 'POST', url: '/oauth/complete' });
    const res = makeRes();

    const promise = h.handler(req, res as unknown as ServerResponse);
    req.emit('data', Buffer.alloc(9));

    expect(await resolvesWithin(promise)).toBe(true);
    expect(res.statusCode).toBe(413);
    expect(json(res)).toEqual({ ok: false, error: 'payload_too_large' });
    expect(res.headers['connection']).toBe('close');
    expect(h.onCompleted).not.toHaveBeenCalled();
  });

  it('maps malformed POST JSON to the core bad_request response without signaling completion', async () => {
    const h = makeHarness({ flowId: 'flow-malformed-json' });

    const res = await invoke(
      h.handler,
      buildReq({
        method: 'POST',
        url: '/oauth/complete',
        body: '{not json',
      }),
    );

    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toBe('application/json');
    expect(json(res)).toMatchObject({ ok: false, error: 'bad_request' });
    expect(h.onCompleted).not.toHaveBeenCalled();
  });

  it('rejects unsupported methods with 405 and the adapter Allow header', async () => {
    const h = makeHarness({ flowId: 'flow-put' });

    const res = await invoke(
      h.handler,
      buildReq({ method: 'PUT', url: '/oauth/complete', body: '' }),
    );

    expect(res.statusCode).toBe(405);
    // OPTIONS joined the allowed set in slice 3 (CORS preflight).
    expect(res.headers['allow']).toBe('GET, POST, OPTIONS');
    expect(res.ended).toBe('method_not_allowed');
    expect(h.onCompleted).not.toHaveBeenCalled();
  });

  it('does not signal completion when the signed state was forged by another identity', async () => {
    const h = makeHarness({ flowId: 'flow-forged' });
    const forgedState = mintState(makeIdentity(), { flow_id: 'flow-forged' });

    const res = await invoke(
      h.handler,
      buildReq({
        method: 'POST',
        url: '/oauth/complete',
        body: JSON.stringify({
          code: 'auth-code',
          state: forgedState,
          flow_id: 'flow-forged',
        }),
      }),
    );

    expect(res.statusCode).toBe(400);
    expect(json(res)).toMatchObject({ ok: false, error: 'invalid_state' });
    expect(h.onCompleted).not.toHaveBeenCalled();
  });

  it('resolves a POST stream error before end as a not-ok body read without signaling completion', async () => {
    const h = makeHarness({ flowId: 'flow-stream-error' });
    const req = buildManualReq({ method: 'POST', url: '/oauth/complete' });
    const res = makeRes();

    const promise = h.handler(req, res as unknown as ServerResponse);
    req.emit('error', new Error('stream failed'));

    expect(await resolvesWithin(promise)).toBe(true);
    expect([400, 413]).toContain(res.statusCode);
    expect(['bad_request', 'payload_too_large']).toContain(
      (json(res) as { error?: string }).error,
    );
    expect(h.onCompleted).not.toHaveBeenCalled();
  });
});

describe('D-165 vendor OAuth complete PortRequestHandler — CORS (slice 3)', () => {
  // The cloud callback page lives at `app.recued.com` (origin of
  // OAUTH_CLOUD_CALLBACK_URL). Hardcoded so a change to the single allowed
  // cross-origin caller fails loudly here.
  const CLOUD_ORIGIN = 'https://app.recued.com';

  it('answers an OPTIONS preflight with 204 + the cloud-origin CORS allowance', async () => {
    const h = makeHarness({ flowId: 'flow-preflight' });

    const res = await invoke(
      h.handler,
      buildReq({ method: 'OPTIONS', url: '/oauth/complete' }),
    );

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(CLOUD_ORIGIN);
    expect(res.headers['access-control-allow-methods']).toBe('GET, POST, OPTIONS');
    expect(res.headers['access-control-allow-headers']).toBe('Content-Type');
    expect(res.headers['vary']).toBe('Origin');
    expect(res.headers['cache-control']).toBe('no-store');
    // A preflight never runs the OAuth core — no flow is consumed, no signal.
    expect(h.onCompleted).not.toHaveBeenCalled();
    expect(h.resultStore.peek('flow-preflight')).toBeNull();
  });

  it('carries the ACAO on the cross-origin POST completion response', async () => {
    const h = makeHarness({ flowId: 'flow-cors-post' });

    const res = await invoke(
      h.handler,
      buildReq({
        method: 'POST',
        url: '/oauth/complete',
        body: JSON.stringify({
          code: 'auth-code',
          state: h.state,
          flow_id: 'flow-cors-post',
        }),
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(CLOUD_ORIGIN);
    expect(res.headers['vary']).toBe('Origin');
  });

  it('does NOT add CORS headers to the same-window direct-GET navigation', async () => {
    const h = makeHarness({ flowId: 'flow-get-nocors' });

    const res = await invoke(
      h.handler,
      buildReq({
        method: 'GET',
        url: `/oauth/complete?code=auth-code&state=${encodeURIComponent(h.state)}`,
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

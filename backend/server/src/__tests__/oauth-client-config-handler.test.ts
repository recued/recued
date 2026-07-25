/** D-127 wire-up — `server.getOAuthClientConfig` handler tests. */

import { describe, it, expect } from 'vitest';
import {
  makeOAuthClientConfigHandlers,
  type OAuthClientConfigDeps,
} from '../oauth-client-config-handler.js';
import type { WsClient } from '../ws-server.js';

const fakeCtx = {} as WsClient;

describe('makeOAuthClientConfigHandlers', () => {
  it('returns undefined when deps are absent', () => {
    expect(makeOAuthClientConfigHandlers(undefined)).toBeUndefined();
  });

  it('exposes only `server.getOAuthClientConfig`', () => {
    const slice = makeOAuthClientConfigHandlers({ getClientId: () => null });
    expect(slice?.methods).toEqual(['server.getOAuthClientConfig']);
  });

  it('returns null per-provider when getClientId returns null', async () => {
    const deps: OAuthClientConfigDeps = { getClientId: () => null };
    const slice = makeOAuthClientConfigHandlers(deps)!;
    const result = await slice.handlers['server.getOAuthClientConfig'](undefined, fakeCtx);
    expect(result).toEqual({ gmail: null, gcal: null, graph: null });
  });

  it('returns null when getClientId returns an empty string', async () => {
    const deps: OAuthClientConfigDeps = { getClientId: () => '' };
    const slice = makeOAuthClientConfigHandlers(deps)!;
    const result = await slice.handlers['server.getOAuthClientConfig'](undefined, fakeCtx);
    expect(result.gmail).toBeNull();
  });

  it('wraps a non-empty client id in { client_id }', async () => {
    const deps: OAuthClientConfigDeps = {
      getClientId: (provider) => {
        if (provider === 'gmail') return 'gmail-cid-123';
        if (provider === 'graph') return 'graph-cid-456';
        return null;
      },
    };
    const slice = makeOAuthClientConfigHandlers(deps)!;
    const result = await slice.handlers['server.getOAuthClientConfig'](undefined, fakeCtx);
    expect(result).toEqual({
      gmail: { client_id: 'gmail-cid-123' },
      gcal: null,
      graph: { client_id: 'graph-cid-456' },
    });
  });

  it('decouples gmail and gcal so a server can configure one without the other', async () => {
    const deps: OAuthClientConfigDeps = {
      getClientId: (provider) => (provider === 'gcal' ? 'gcal-only' : null),
    };
    const slice = makeOAuthClientConfigHandlers(deps)!;
    const result = await slice.handlers['server.getOAuthClientConfig'](undefined, fakeCtx);
    expect(result.gmail).toBeNull();
    expect(result.gcal).toEqual({ client_id: 'gcal-only' });
    expect(result.graph).toBeNull();
  });
});

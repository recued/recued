/** R27 — webclient auth-client recued.com session sign-out (local scope). */

import { describe, expect, it, vi } from 'vitest';
import {
  createAccountBindingAuthClient,
  type AccountBindingFetch,
} from '../settings/account-binding-auth-client.js';

interface FakeResponse {
  ok: boolean;
  text(): Promise<string>;
}

const res = (status: number, body: unknown): FakeResponse => ({
  ok: status >= 200 && status < 300,
  text: async () => JSON.stringify(body),
});

const sessionBody = (csrfToken: string) => ({
  authenticated: true,
  user: { id: 'acct-1', email: 'mary@example.com' },
  expiresAt: 1_700_000_100_000,
  csrfToken,
});

describe('R27 account auth-client — signOut (local scope)', () => {
  it('fetches a session for CSRF, then POSTs /v1/auth/signout with the token + credentials', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch: AccountBindingFetch = vi.fn(async (input, init) => {
      const url = String(input);
      calls.push({ url, ...(init !== undefined ? { init } : {}) });
      if (url.endsWith('/v1/auth/session')) return res(200, sessionBody('csrf-1')) as unknown as Response;
      if (url.endsWith('/v1/auth/signout')) {
        return res(200, { ok: true, authenticated: false, csrfToken: 'csrf-2' }) as unknown as Response;
      }
      throw new Error(`unexpected url ${url}`);
    });
    const client = createAccountBindingAuthClient({ workerUrl: 'https://auth.test', fetch });

    await client.signOut();

    const signout = calls.find((c) => c.url.endsWith('/v1/auth/signout'));
    expect(signout).toBeDefined();
    const headers = new Headers(signout!.init?.headers);
    expect(signout!.init?.method).toBe('POST');
    expect(signout!.init?.credentials).toBe('include');
    expect(headers.get('X-CSRF-Token')).toBe('csrf-1');
  });

  it('adopts the rotated CSRF token from the response and skips a redundant session fetch on the next call', async () => {
    let sessionFetches = 0;
    const tokensSent: Array<string | null> = [];
    const fetch: AccountBindingFetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v1/auth/session')) {
        sessionFetches += 1;
        return res(200, sessionBody('csrf-1')) as unknown as Response;
      }
      tokensSent.push(new Headers(init?.headers).get('X-CSRF-Token'));
      return res(200, { ok: true, authenticated: false, csrfToken: 'csrf-2' }) as unknown as Response;
    });
    const client = createAccountBindingAuthClient({ workerUrl: 'https://auth.test', fetch });

    await client.signOut();
    await client.signOut();

    // One session fetch total (for the first call); the second reuses csrf-2.
    expect(sessionFetches).toBe(1);
    expect(tokensSent).toEqual(['csrf-1', 'csrf-2']);
  });

  it('throws the Worker error message when sign-out fails', async () => {
    const fetch: AccountBindingFetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith('/v1/auth/session')) return res(200, sessionBody('csrf-1')) as unknown as Response;
      return res(401, { error: { message: 'Sign out failed.' } }) as unknown as Response;
    });
    const client = createAccountBindingAuthClient({ workerUrl: 'https://auth.test', fetch });

    await expect(client.signOut()).rejects.toThrow('Sign out failed.');
  });
});

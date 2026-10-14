/** D-322 §25 — provider identity, privacy, permission gaps and bounded reads. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionAuth } from '@recued/contracts';
import { readManagedOAuthAccountIdentity } from '../managed-oauth-account-preview.js';
afterEach(() => vi.useRealTimers());
const bearer: ConnectionAuth = { type: 'bearer', token: 'secret-native-token' };
const run = (base_url: string, value: unknown, auth: ConnectionAuth = bearer) => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(value));
  const managedFetch = vi.fn().mockResolvedValue(Response.json(value));
  return { fetch, managedFetch, result: readManagedOAuthAccountIdentity({ auth, base_url, now: 1000, fetch, managedFetch }) };
};
describe('D-322 account identity preview', () => {
  it.each([
    ['https://gmail.googleapis.com/gmail/v1', { emailAddress: 'owner@example.test', messagesTotal: 200, token: 'private' }, 'owner@example.test', '/users/me/profile'],
    ['https://graph.microsoft.com/v1.0', { id: 'user-1', mail: 'owner@example.test', displayName: 'Owner', userPrincipalName: 'login@example.test', private: 'body' }, 'user-1', '/me'],
    ['https://www.googleapis.com/drive/v3', { user: { permissionId: 'permission-1', emailAddress: 'owner@example.test', displayName: 'Owner', private: 'body' } }, 'permission-1', '/about'],
  ])('reads only the fixed %s identity and projects allowed fields', async (base, payload, id, path) => {
    const f = run(base as string, payload); const result = await f.result;
    expect(result).toMatchObject({ status: 'known', email: 'owner@example.test', account_id: id });
    expect(JSON.stringify(result)).not.toMatch(/messagesTotal|private|secret-native-token/);
    const [url, init] = f.fetch.mock.calls[0]!;
    expect(String(url)).toContain(path); expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit' });
    expect(new Headers(init!.headers).get('Authorization')).toBe('Bearer secret-native-token');
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps a Graph sign-in name distinct from a missing email', async () => {
    expect(await run('https://graph.microsoft.com/v1.0', { id: 'user', mail: null, userPrincipalName: 'login@example.test' }).result)
      .toEqual({ status: 'known', account_id: 'user', user_name: 'login@example.test' });
  });
  it.each(['https://sheets.googleapis.com/v4', 'https://www.googleapis.com/calendar/v3', 'https://evil.test/gmail/v1',
    'https://gmail.googleapis.com/other', 'https://password@gmail.googleapis.com/gmail/v1'])('leaves %s unknown without extra requests or scopes', async base => {
    const f = run(base, {}); expect(await f.result).toEqual({ status: 'unknown', reason: 'unsupported' }); expect(f.fetch).not.toHaveBeenCalled();
  });
  it('never refreshes an expired direct OAuth token to learn identity', async () => {
    const f = run('https://gmail.googleapis.com/gmail/v1', {}, { type: 'oauth2_refresh', client_id: 'app', refresh_token: 'private',
      token_endpoint: 'https://oauth2.googleapis.com/token', current_access_token: 'expired', expires_at: 10 });
    expect(await f.result).toMatchObject({ status: 'unknown' }); expect(f.fetch).not.toHaveBeenCalled();
  });
  it('leaves malformed saved authorization unknown without sending it', async () => {
    const f = run('https://gmail.googleapis.com/gmail/v1', {}, { type: 'bearer', token: 'invalid\nheader' });
    expect(await f.result).toEqual({ status: 'unknown', reason: 'unavailable' });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('uses the existing raw Nango transport without returning broker credentials', async () => {
    const auth: ConnectionAuth = { type: 'managed_oauth', broker_profile_id: 'cloud', integration_id: 'gmail', connection_id: 'remote',
      target_origin: 'https://gmail.googleapis.com', requested_scopes: [] };
    const f = run('https://gmail.googleapis.com/gmail/v1', { emailAddress: 'owner@example.test' }, auth);
    expect(await f.result).toMatchObject({ email: 'owner@example.test' }); expect(f.fetch).not.toHaveBeenCalled();
    expect(f.managedFetch.mock.calls[0]![0]).toBe(auth);
  });
  it.each([403, 500])('keeps HTTP %s unknown and discards its body', async status => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('private error', { status }));
    expect(await readManagedOAuthAccountIdentity({ auth: bearer, base_url: 'https://gmail.googleapis.com/gmail/v1', now: 0, fetch,
      managedFetch: vi.fn() })).toEqual({ status: 'unknown', reason: 'unavailable' });
  });
  it('limits native payloads and hides malformed JSON and raw network errors', async () => {
    for (const response of [new Response('x'.repeat(9000)), new Response('not json'), Response.json({ emailAddress: 'invalid' })]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
      expect(await readManagedOAuthAccountIdentity({ auth: bearer, base_url: 'https://gmail.googleapis.com/gmail/v1', now: 0, fetch,
        managedFetch: vi.fn() })).toEqual({ status: 'unknown', reason: 'unavailable' });
    }
  });
  it('aborts a stalled response body even when a fixture transport ignores its signal', async () => {
    const control = new AbortController(); let canceled = false;
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(control.signal);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(new ReadableStream({
      cancel: () => { canceled = true; },
    })));
    const result = readManagedOAuthAccountIdentity({ auth: bearer, base_url: 'https://gmail.googleapis.com/gmail/v1', now: 0, fetch, managedFetch: vi.fn() });
    await Promise.resolve(); await Promise.resolve(); control.abort();
    expect(await result).toMatchObject({ status: 'unknown' }); expect(canceled).toBe(true); expect(timeout).toHaveBeenCalledWith(5000);
    timeout.mockRestore();
  });
  it('cancels a response rejected by its declared body size', async () => {
    const cancel = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel }),
      { headers: { 'Content-Length': '9000' } }));
    expect(await readManagedOAuthAccountIdentity({ auth: bearer, base_url: 'https://gmail.googleapis.com/gmail/v1', now: 0, fetch,
      managedFetch: vi.fn() })).toEqual({ status: 'unknown', reason: 'unavailable' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it.each(['direct', 'broker'])('ends a stalled %s header read and cancels a response arriving after its deadline', async transport => {
    const control = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(control.signal);
    let finish!: (value: Response) => void;
    const delayed = new Promise<Response>(resolve => { finish = resolve; });
    const auth: ConnectionAuth = transport === 'direct' ? bearer : { type: 'managed_oauth', broker_profile_id: 'cloud',
      integration_id: 'gmail', connection_id: 'remote', target_origin: 'https://gmail.googleapis.com', requested_scopes: [] };
    const result = readManagedOAuthAccountIdentity({ auth, base_url: 'https://gmail.googleapis.com/gmail/v1', now: 0,
      fetch: vi.fn().mockReturnValue(delayed), managedFetch: vi.fn().mockReturnValue(delayed) });
    let completed = false; void result.then(() => { completed = true; });
    await Promise.resolve(); control.abort();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const endedAtDeadline = completed;
    const cancel = vi.fn();
    finish(new Response(new ReadableStream({ cancel })));
    expect(await result).toEqual({ status: 'unknown', reason: 'unavailable' });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(endedAtDeadline).toBe(true);
    timeout.mockRestore();
  });
});

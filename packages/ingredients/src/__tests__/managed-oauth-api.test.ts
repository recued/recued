/** D-322 — managed traffic remains below the native HTTP admission and error path. */
import { describe, expect, it, vi } from 'vitest';
import type { ConnectionRow, ManagedOAuthAuth } from '@recued/contracts';
import { createConnectionApiHandler } from '../connection-api.js';
import { IngredientError } from '../types.js';
const row: ConnectionRow = { pk: 'api:sheets', kind: 'api', name: 'sheets', display_name: 'Sheets', config_json: '{"base_url":"https://sheets.googleapis.com/v4"}', auth_ciphertext: 'encrypted', enrolled_at: 1, updated_at: 1 };
const auth: ManagedOAuthAuth = { type: 'managed_oauth', broker_profile_id: 'cloud', integration_id: 'sheets', connection_id: 'remote', target_origin: 'https://sheets.googleapis.com', requested_scopes: [] };
const call = { slug: 'sheets.read', risk_tier: 'read' as const, input: {}, output: {} };
describe('managed API dispatch', () => {
  it('fails closed without a broker transport and never falls back to anonymous native fetch', async () => {
    const native = vi.fn<typeof fetch>();
    const handler = createConnectionApiHandler({ decodeAuth: async () => auth, persistAuth: async () => {}, fetchImpl: native });
    await expect(handler(row, { method: 'GET', path: '/spreadsheets' }, call)).rejects.toMatchObject({ code: 'CONNECTION_REFUSED' });
    expect(native).not.toHaveBeenCalled();
  });
  it('revalidates admission before the broker sees traffic', async () => {
    const broker = vi.fn().mockResolvedValue(Response.json({ native: true }));
    const handler = createConnectionApiHandler({ decodeAuth: async () => auth, persistAuth: async () => {}, managedOAuthFetch: broker,
      beforeRequest: async () => { throw new IngredientError('ROLE_RESTRICTION', 'Not granted'); } });
    await expect(handler(row, { method: 'GET', path: '/spreadsheets' }, call)).rejects.toMatchObject({ code: 'ROLE_RESTRICTION' });
    expect(broker).not.toHaveBeenCalled();
  });
  it('keeps native fields and pagination and applies the existing output contract', async () => {
    const broker = vi.fn().mockResolvedValue(Response.json({ sheets: [{ properties: { sheetId: 3 } }], nextPageToken: 'next' }));
    const handler = createConnectionApiHandler({ decodeAuth: async () => auth, persistAuth: async () => {}, managedOAuthFetch: broker });
    expect(await handler(row, { method: 'GET', path: '/spreadsheets/id', 'query.fields': ['sheets', 'title'] }, call)).toMatchObject({ result: { sheets: [{ properties: { sheetId: 3 } }], nextPageToken: 'next' } });
    expect(broker.mock.calls[0]?.[1]).toBe('https://sheets.googleapis.com/v4/spreadsheets/id?fields=sheets&fields=title');
    expect(new Headers(broker.mock.calls[0]?.[2]?.headers).has('authorization')).toBe(false);
  });
  it('does not retry an uncertain write or reinterpret native authorization errors', async () => {
    const broker = vi.fn().mockResolvedValueOnce(new Response('lost acknowledgement', { status: 503 }))
      .mockResolvedValueOnce(new Response('scope denied', { status: 403 }));
    const handler = createConnectionApiHandler({ decodeAuth: async () => auth, persistAuth: async () => {}, managedOAuthFetch: broker });
    await expect(handler(row, { method: 'POST', path: '/spreadsheets' }, { ...call, risk_tier: 'write' })).rejects.toMatchObject({ code: 'ACTION_DELIVERY_UNCERTAIN' });
    expect(broker).toHaveBeenCalledTimes(1);
    await expect(handler(row, { method: 'GET', path: '/spreadsheets' }, call)).rejects.toMatchObject({ code: 'OAUTH_EXPIRED' });
    expect(broker).toHaveBeenCalledTimes(2);
  });
});

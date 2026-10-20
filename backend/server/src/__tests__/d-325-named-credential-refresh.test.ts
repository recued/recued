import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectionAuth, ConnectionRow } from '@recued/contracts';
import type { KeyManager } from '../key-manager.js';
import { decodeAuthFromStorage } from '../connection-handler.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { persistMessengerNotificationAuth } from '../composition/bin/wire-messenger-refresher.js';
import { createRemoteCredentialResolver } from '../composition/bin/wire-remote-channel.js';
import { createMessengerNotificationRefresher, type OAuth2RefreshAuth } from '../messenger-notification-refresh.js';
import { createMessengerIngressSupervisor } from '../messenger-ingress/supervisor.js';
import type { TeamsPollRunnerOptions } from '../messenger-ingress/teams-poll.js';
import { createMessengerIngressStateStore } from '../storage/messenger-ingress-state-store.js';

const blob = (auth: ConnectionAuth) => Buffer.from(JSON.stringify(auth)).toString('base64');
const row = (enrolled_at = 100): Omit<ConnectionRow, 'pk'> => ({ kind: 'notification', subtype: 'teams', name: 'private',
  display_name: 'Private chat', enrolled_at, updated_at: enrolled_at,
  config_json: JSON.stringify({ chat_id: 'private-chat', principal_id: 'owner' }),
  auth_ciphertext: blob({ type: 'bearer', token: `token-${enrolled_at}` }) });
const destination = { id: 'private', channel: 'teams' as const, connection_name: 'private', connection_enrolled_at: 100,
  recipient: 'private-chat', expected_sender: 'owner' };

describe('D-325 named notification credential renewal', () => {
  it('polls through the named connection and stops an old runner from reading a replacement conversation', async () => {
    const db = new Database(':memory:');
    let supervisor: ReturnType<typeof createMessengerIngressSupervisor> | undefined;
    try {
      const store = createConnectionStore(db);
      const oauth = (token: string): ConnectionAuth => ({ type: 'oauth2_refresh', refresh_token: 'fixture-refresh',
        client_id: 'fixture-client', token_endpoint: 'https://fixture.invalid/token', current_access_token: token });
      store.upsert({ ...row(), auth_ciphertext: blob(oauth('token-100')),
        config_json: JSON.stringify({ chat_id: 'private-chat', principal_id: 'owner', ingress_mode: 'poll' }) });
      let captured: TeamsPollRunnerOptions | undefined;
      const refreshIfNeeded = vi.fn(async (_name: string, auth: ConnectionAuth) => auth);
      const unexpected = () => { throw new Error('Unexpected runner'); };
      supervisor = createMessengerIngressSupervisor({ connectionStore: store, stateStore: createMessengerIngressStateStore(db),
        decodeAuth: async source => decodeAuthFromStorage(source.auth_ciphertext, { kind: source.kind, name: source.name }),
        dispatchers: { teams: async () => {} }, refreshAuth: { refreshIfNeeded },
        runnerFactory: { teams: options => { captured = options; return { start: () => {}, stop: async () => {} }; },
          slack: unexpected, telegram: unexpected, discord: unexpected },
      });
      await supervisor.start();
      expect(captured).toBeDefined();
      const oldRunner = captured!;
      expect(await oldRunner.getAccessToken()).toBe('token-100');
      expect(refreshIfNeeded.mock.calls[0]?.[0]).toBe('private');
      store.upsert({ ...row(200), auth_ciphertext: blob(oauth('token-200')),
        config_json: JSON.stringify({ chat_id: 'household-chat', principal_id: 'owner', ingress_mode: 'poll' }) });
      expect(await oldRunner.getAccessToken()).toBeNull();
    } finally { await supervisor?.stop(); db.close(); }
  });
  it('renews the named row through the atomic store path and preserves its credential-source identity', async () => {
    const db = new Database(':memory:');
    try {
      const store = createConnectionStore(db);
      const original = store.upsert(row());
      const source = store.getAuthSourceId!('notification', 'private');
      await persistMessengerNotificationAuth({ connectionStore: store }, 'private', { type: 'bearer', token: 'fresh' }, original);
      expect(await decodeAuthFromStorage(store.get('notification', 'private')!.auth_ciphertext,
        { kind: 'notification', name: 'private' })).toEqual({ type: 'bearer', token: 'fresh' });
      expect(store.getAuthSourceId!('notification', 'private')).toBe(source);
      expect(store.get('notification', 'teams')).toBeNull();
    } finally { db.close(); }
  });

  it('does not overwrite a replacement that arrives while the refreshed credential is being encoded', async () => {
    const db = new Database(':memory:');
    try {
      const store = createConnectionStore(db);
      const original = store.upsert(row());
      let replaced = false;
      const keys = { keyProvider: () => () => {
        if (!replaced) { replaced = true; store.upsert(row(200)); }
        return new Uint8Array(32).fill(7);
      } } as unknown as KeyManager;
      await expect(persistMessengerNotificationAuth({ connectionStore: store, keys }, 'private',
        { type: 'bearer', token: 'stale-refresh-result' }, original)).rejects.toThrow('changed during credential renewal');
      expect(store.get('notification', 'private')!.enrolled_at).toBe(200);
      expect(await decodeAuthFromStorage(store.get('notification', 'private')!.auth_ciphertext,
        { kind: 'notification', name: 'private' })).toEqual({ type: 'bearer', token: 'token-200' });
    } finally { db.close(); }
  });

  it('passes the named row to renewal and refuses delivery after an in-flight re-enrollment', async () => {
    const db = new Database(':memory:');
    try {
      const store = createConnectionStore(db); store.upsert(row());
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const refreshIfNeeded = vi.fn(async () => { await gate; return { type: 'bearer' as const, token: 'old-account-fresh-token' }; });
      const resolve = createRemoteCredentialResolver({ connectionStore: store, vendor: 'teams',
        resolveRecipient: config => typeof config?.chat_id === 'string' ? config.chat_id : null,
        refreshAuth: { refreshIfNeeded } });
      const pending = resolve(destination);
      await vi.waitFor(() => expect(refreshIfNeeded).toHaveBeenCalledTimes(1));
      expect(refreshIfNeeded.mock.calls[0]).toMatchObject(['private', { type: 'bearer', token: 'token-100' },
        { enrolled_at: 100, config_json: row().config_json }]);
      store.upsert(row(200)); release();
      expect(await pending).toBeNull();
    } finally { db.close(); }
  });

  it('shares a renewal for one identity without giving a new enrollment the old in-flight result', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const refresh = vi.fn(async (auth: OAuth2RefreshAuth) => { await gate; return { ...auth, current_access_token: auth.refresh_token }; });
    const renew = createMessengerNotificationRefresher({ now: () => 1000, refresh, persist: async () => {} });
    const auth: OAuth2RefreshAuth = { type: 'oauth2_refresh', client_id: 'fixture-client', token_endpoint: 'https://fixture.invalid/token',
      refresh_token: 'old-refresh', current_access_token: 'expired', expires_at: 0 };
    const identity = { enrolled_at: 100, auth_ciphertext: 'old-blob', config_json: '{}' };
    const a = renew.refreshIfNeeded('private', auth, identity);
    const same = renew.refreshIfNeeded('private', auth, identity);
    const newer = renew.refreshIfNeeded('private', { ...auth, refresh_token: 'new-refresh' }, { ...identity, enrolled_at: 200 });
    release();
    const [first, duplicate, second] = await Promise.all([a, same, newer]);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(first).toEqual(duplicate);
    expect((first as OAuth2RefreshAuth).current_access_token).toBe('old-refresh');
    expect((second as OAuth2RefreshAuth).current_access_token).toBe('new-refresh');
  });
});

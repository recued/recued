import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createMessengerIngressStateStore } from '../storage/messenger-ingress-state-store.js';

describe('messenger ingress state store', () => {
  it('persists one generic cursor/session row per vendor connection', () => {
    const db = new Database(':memory:');
    const store = createMessengerIngressStateStore(db, () => 123);

    store.put({
      vendor: 'telegram',
      connection_name: 'telegram',
      mode: 'poll',
      credential_fingerprint: 'auth-a',
      state: { offset: 42 },
    });
    expect(store.get('telegram', 'telegram')).toEqual({
      vendor: 'telegram',
      connection_name: 'telegram',
      mode: 'poll',
      credential_fingerprint: 'auth-a',
      state: { offset: 42 },
      updated_at: 123,
    });

    store.put({
      vendor: 'telegram',
      connection_name: 'telegram',
      mode: 'poll',
      credential_fingerprint: 'auth-a',
      state: { offset: 43 },
      updated_at: 200,
    });
    expect(store.get('telegram', 'telegram')?.state).toEqual({ offset: 43 });
    store.delete('telegram', 'telegram');
    expect(store.get('telegram', 'telegram')).toBeNull();
    db.close();
  });

  it('refuses unbounded state blobs', () => {
    const db = new Database(':memory:');
    const store = createMessengerIngressStateStore(db);
    expect(() => store.put({
      vendor: 'discord',
      connection_name: 'discord',
      mode: 'socket',
      credential_fingerprint: 'auth-b',
      state: { value: 'x'.repeat(40_000) },
    })).toThrow(/32 KiB/);
    db.close();
  });
});

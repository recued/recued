/** D-148 P3 + D-169 P0 Slice 2B — bridge local-store tests.
 *
 *  No-state-proof + closed-list 8-field gate. Anything outside the
 *  spec's documented set raises at set time. */

import { describe, it, expect } from 'vitest';
import { BRIDGE_LOCAL_STORAGE_FIELDS, type WebclientTokenRecord } from '@recued/contracts';
import {
  createInMemoryBridgeLocalStore,
  createChromeBridgeLocalStore,
  type ChromeStorageLocal,
} from '../storage/local-store.js';

const fakeTokenRecord = (token_id = 'tok-fixture'): WebclientTokenRecord => ({
  token_id,
  ciphertext_b64: 'Y2lwaGVy',
  iv_b64: 'aXY=',
  issued_at: 1_700_000_000_000,
});

describe('D-148 P3 + D-169 P0 Slice 2B — local-store closed-list gate', () => {
  it('rejects writes to undocumented keys (set)', async () => {
    const store = createInMemoryBridgeLocalStore();
    await expect(
      // @ts-expect-error testing runtime guard against arbitrary keys
      store.set('arbitrary_key', 'value'),
    ).rejects.toThrow(/refusing to write field outside spec/);
  });

  it('rejects removes of undocumented keys', async () => {
    const store = createInMemoryBridgeLocalStore();
    await expect(
      // @ts-expect-error testing runtime guard against arbitrary keys
      store.remove('arbitrary_key'),
    ).rejects.toThrow(/refusing to write field outside spec/);
  });

  it('inspect() returns exactly the 10 documented fields', async () => {
    const store = createInMemoryBridgeLocalStore();
    const view = await store.inspect();
    const keys = Object.keys(view).sort();
    expect(keys).toEqual([...BRIDGE_LOCAL_STORAGE_FIELDS].sort());
  });

  it('inspect() backed by a partial-state store still returns the 10 fields with safe defaults', async () => {
    const record = fakeTokenRecord('tok-fixture');
    const store = createInMemoryBridgeLocalStore({
      server_url: 'wss://alice.recued.cloud:8443/ws',
      webclient_token: record,
    });
    const view = await store.inspect();
    expect(view.server_url).toBe('wss://alice.recued.cloud:8443/ws');
    expect(view.webclient_token).toEqual(record);
    expect(view.server_public_key).toBeNull();
    expect(view.pair_metadata).toBeNull();
    expect(view.cert_pin_state).toBeNull();
    expect(view.chrome_permissions_state).toEqual({ origins: [] });
    expect(view.idempotency_cache.store_name).toBe('recued.bridge.idempotency');
    expect(view.pending_outbox.depth).toBe(0);
    expect(view.blocked_sites).toBeNull();
    expect(view.approval_notices_shown).toBeNull();
  });

  it('clear() wipes all set fields but the owner\'s list of blocked sites', async () => {
    const store = createInMemoryBridgeLocalStore({
      server_url: 'wss://example/',
      webclient_token: fakeTokenRecord(),
      blocked_sites: ['bank.example'],
      approval_notices_shown: ['ask-1'],
    });
    await store.clear();
    const view = await store.inspect();
    expect(view.server_url).toBeNull();
    expect(view.webclient_token).toBeNull();
    expect(view.approval_notices_shown).toBeNull();
    // D-335 slice G — dropping it would let the Bridge act on a site the owner listed.
    expect(view.blocked_sites).toEqual(['bank.example']);
  });

  it('rejects a legacy `bridge_token` write at the closed-list gate', async () => {
    const store = createInMemoryBridgeLocalStore();
    await expect(
      // @ts-expect-error D-169 P0 Slice 2B — `bridge_token` is no longer a documented key
      store.set('bridge_token', 'legacy-bearer'),
    ).rejects.toThrow(/refusing to write field outside spec/);
  });
});

describe('D-148 P3 — chrome-backed local-store adapter', () => {
  const buildFakeStorage = (): { storage: ChromeStorageLocal; data: Record<string, unknown> } => {
    const data: Record<string, unknown> = {};
    return {
      data,
      storage: {
        async get(keys) {
          const out: Record<string, unknown> = {};
          for (const k of keys) {
            if (k in data) out[k] = data[k];
          }
          return out;
        },
        async set(items) {
          Object.assign(data, items);
        },
        async remove(keys) {
          for (const k of keys) delete data[k];
        },
        async clear() {
          for (const k of Object.keys(data)) delete data[k];
        },
      },
    };
  };

  it('round-trips through chrome.storage', async () => {
    const fake = buildFakeStorage();
    const store = createChromeBridgeLocalStore(fake.storage);
    await store.set('server_url', 'wss://alice.recued.cloud:8443/ws');
    expect(fake.data.server_url).toBe('wss://alice.recued.cloud:8443/ws');
    expect(await store.get('server_url')).toBe('wss://alice.recued.cloud:8443/ws');
  });

  it('rejects undocumented keys via the chrome adapter too', async () => {
    const fake = buildFakeStorage();
    const store = createChromeBridgeLocalStore(fake.storage);
    await expect(
      // @ts-expect-error runtime guard against arbitrary keys
      store.set('arbitrary_key', 'x'),
    ).rejects.toThrow();
  });

  it('clear() removes only the documented keys, keeping the owner\'s blocked sites (defense in depth)', async () => {
    const fake = buildFakeStorage();
    fake.data.server_url = 'wss://example/';
    fake.data.blocked_sites = ['bank.example'];
    fake.data.approval_notices_shown = ['ask-1'];
    fake.data.unrelated_key = 'should remain — but indicates store contamination';
    const store = createChromeBridgeLocalStore(fake.storage);
    await store.clear();
    expect(fake.data.server_url).toBeUndefined();
    expect(fake.data.approval_notices_shown).toBeUndefined();
    expect(fake.data.blocked_sites).toEqual(['bank.example']);
    expect(fake.data.unrelated_key).toBe(
      'should remain — but indicates store contamination',
    );
  });
});

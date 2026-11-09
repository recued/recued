/** `pairing/pending-pair-store.ts` — the `chrome.storage.session` home of an
 *  accepted pairing whose setup has not finished (the worker pairing
 *  session's held reply; the pair host's DD#6).
 *
 *  The pairing suites prove the flow against a remembering fake. This one
 *  proves the real store against a fake `storage.session` AREA: what goes in
 *  the one key, what comes back out, and — the part that matters most — that
 *  the recovery key never goes in at all. */

import { describe, expect, it } from 'vitest';

import {
  BRIDGE_PENDING_PAIR_SESSION_KEY,
  createSessionPendingPairStore,
  type BridgeAcceptedPair,
  type ChromeStorageSessionArea,
} from '../pairing/pending-pair-store.js';

const buildArea = (seed: Record<string, unknown> = {}) => {
  const data: Record<string, unknown> = { ...seed };
  const area: ChromeStorageSessionArea = {
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const k of keys) if (k in data) out[k] = data[k];
      return out;
    },
    async set(items) {
      // Stored as a structured clone, like chrome.storage: no shared references.
      for (const [k, v] of Object.entries(items)) data[k] = JSON.parse(JSON.stringify(v));
    },
    async remove(keys) {
      for (const k of keys) delete data[k];
    },
  };
  return { area, data };
};

const RECOVERY_KEY = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

const ACCEPTED: BridgeAcceptedPair = {
  serverUrl: 'https://review.example',
  token: 'bearer-1',
  token_id: 'tok-id-1',
  passport: { identity: { server_public_key: 'PUBKEY', current_handle: 'alice' } },
  serverId: 'srv-1',
  instanceId: 'inst-1',
};

describe('createSessionPendingPairStore', () => {
  it('round-trips an accepted pairing through the one session key', async () => {
    const { area, data } = buildArea();
    const store = createSessionPendingPairStore(area);
    await store.save(ACCEPTED);
    expect(Object.keys(data)).toEqual([BRIDGE_PENDING_PAIR_SESSION_KEY]);
    expect(await store.load()).toEqual(ACCEPTED);
  });

  it('never writes the recovery key, even when one is passed in by mistake', async () => {
    const { area, data } = buildArea();
    const store = createSessionPendingPairStore(area);
    await store.save({ ...ACCEPTED, recoveryKey: RECOVERY_KEY } as BridgeAcceptedPair);
    const raw = data[BRIDGE_PENDING_PAIR_SESSION_KEY] as Record<string, unknown>;
    expect(raw).not.toHaveProperty('recoveryKey');
    expect(JSON.stringify(data)).not.toContain(RECOVERY_KEY);
    expect(await store.load()).toEqual(ACCEPTED);
  });

  it('keeps optional fields optional', async () => {
    const { area } = buildArea();
    const store = createSessionPendingPairStore(area);
    await store.save({ serverUrl: 'http://127.0.0.1:7717', token: 'legacy-bearer' });
    expect(await store.load()).toEqual({
      serverUrl: 'http://127.0.0.1:7717',
      token: 'legacy-bearer',
    });
  });

  it('answers null when nothing is saved, and after clear', async () => {
    const { area, data } = buildArea();
    const store = createSessionPendingPairStore(area);
    expect(await store.load()).toBeNull();
    await store.save(ACCEPTED);
    await store.clear();
    expect(data).toEqual({});
    expect(await store.load()).toBeNull();
  });

  it.each([
    ['not an object', 'bearer-1'],
    ['no token', { serverUrl: 'https://review.example' }],
    ['an empty token', { serverUrl: 'https://review.example', token: '' }],
    ['no server URL', { token: 'bearer-1' }],
    ['a non-string token id', { serverUrl: 'https://review.example', token: 'bearer-1', token_id: 7 }],
    ['an empty server id', { serverUrl: 'https://review.example', token: 'bearer-1', serverId: '' }],
    ['a non-string instance id', { serverUrl: 'https://review.example', token: 'bearer-1', instanceId: 3 }],
  ])('drops a row with %s rather than half-using it', async (_label, row) => {
    const { area } = buildArea({ [BRIDGE_PENDING_PAIR_SESSION_KEY]: row });
    expect(await createSessionPendingPairStore(area).load()).toBeNull();
  });
});

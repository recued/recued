import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { DEFAULT_INSTANCE_PREFS } from '@recued/contracts';
import {
  createPairedInstancesStore,
  type PairedInstancesStore,
} from '../paired-instances-store.js';
import { handlePrefsGet, handlePrefsSet } from '../prefs-handler.js';

let store: PairedInstancesStore;

beforeEach(() => {
  const db = new Database(':memory:');
  store = createPairedInstancesStore(db);
  store.addOrRefresh({ instance_id: 'ext-a', user_id: 'u', display_name: 'A' });
});

describe('prefs.get', () => {
  it('returns defaults for a freshly registered instance', async () => {
    const res = await handlePrefsGet({ store }, {}, { instance_id: 'ext-a' });
    expect(res.prefs).toEqual(DEFAULT_INSTANCE_PREFS);
  });

  it('rejects when the ws client has not completed register', async () => {
    await expect(handlePrefsGet({ store }, {}, {}))
      .rejects.toMatchObject({ code: 'unauthorized', status: 401 });
  });
});

describe('prefs.set', () => {
  it('persists a patched value and returns the merged result', async () => {
    const res = await handlePrefsSet(
      { store },
      { patch: { 'cache.sync_l2': false } },
      { instance_id: 'ext-a' },
    );
    expect(res.prefs['cache.sync_l2']).toBe(false);
    expect(store.getPrefs('ext-a')['cache.sync_l2']).toBe(false);
  });

  it('drops unknown keys silently (forward-compat)', async () => {
    const res = await handlePrefsSet(
      { store },
      { patch: { 'future.newKey': true, 'cache.sync_l2': false } },
      { instance_id: 'ext-a' },
    );
    expect(res.prefs['cache.sync_l2']).toBe(false);
    expect('future.newKey' in res.prefs).toBe(false);
  });

  it('drops wrong-typed values rather than throwing', async () => {
    const res = await handlePrefsSet(
      { store },
      { patch: { 'cache.sync_l2': 'not a bool' } },
      { instance_id: 'ext-a' },
    );
    // wrong type dropped → merged equals current (defaults)
    expect(res.prefs['cache.sync_l2']).toBe(DEFAULT_INSTANCE_PREFS['cache.sync_l2']);
  });

  it('rejects a non-object patch', async () => {
    await expect(handlePrefsSet({ store }, { patch: 'nope' }, { instance_id: 'ext-a' }))
      .rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('rejects a missing patch', async () => {
    await expect(handlePrefsSet({ store }, {}, { instance_id: 'ext-a' }))
      .rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects when the ws client has not completed register', async () => {
    await expect(handlePrefsSet({ store }, { patch: {} }, {}))
      .rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('is additive — second set preserves prior keys not in new patch', async () => {
    await handlePrefsSet({ store }, { patch: { 'cache.sync_l2': false } }, { instance_id: 'ext-a' });
    const res = await handlePrefsSet({ store }, { patch: {} }, { instance_id: 'ext-a' });
    expect(res.prefs['cache.sync_l2']).toBe(false);
  });
});

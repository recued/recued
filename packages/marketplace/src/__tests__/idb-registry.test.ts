import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { createIDBInstallRegistry, type IDBInstallRegistry } from '../idb-registry.js';
import type { InstalledRecipe } from '../types.js';
import type { RecipeDefinition } from '@recued/contracts';

const sampleRecipe: RecipeDefinition = {
  recipe_id: 'r1',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'R1',
    description: 'fixture',
    author: 'test',
    supported_platforms: ['hubspot'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { sidebar: [] },
} as unknown as RecipeDefinition;

const mkRecord = (overrides: Partial<InstalledRecipe> = {}): InstalledRecipe => ({
  recipe_id: 'r1',
  publisher_id: 'pub1',
  installed_version: 1,
  installed_hash: 'hash1',
  installed_at: 1_000_000,
  auto_run: false,
  recipe: sampleRecipe,
  last_checked_at: null,
  upstream_version: null,
  upstream_hash: null,
  ...overrides,
});

let counter = 0;
const uniqueDb = () => `install-registry-test-${++counter}-${Date.now()}`;

// ────────────────────────────────────────────────────────────────

describe('createIDBInstallRegistry — basic CRUD', () => {
  let registry: IDBInstallRegistry;
  beforeEach(() => { registry = createIDBInstallRegistry({ dbName: uniqueDb() }); });

  it('starts empty', async () => {
    expect(await registry.size()).toBe(0);
    expect(await registry.listInstalled()).toEqual([]);
  });

  it('markInstalled + getInstalled roundtrip', async () => {
    const record = mkRecord();
    await registry.markInstalled(record);
    const fetched = await registry.getInstalled('r1', 'pub1');
    expect(fetched).toEqual(record);
  });

  it('getInstalled returns null for missing key', async () => {
    expect(await registry.getInstalled('missing', 'pub1')).toBeNull();
  });

  it('size reflects install count', async () => {
    await registry.markInstalled(mkRecord({ recipe_id: 'a', publisher_id: 'p' }));
    await registry.markInstalled(mkRecord({ recipe_id: 'b', publisher_id: 'p' }));
    expect(await registry.size()).toBe(2);
  });

  it('markInstalled replaces existing entry', async () => {
    await registry.markInstalled(mkRecord({ installed_hash: 'old' }));
    await registry.markInstalled(mkRecord({ installed_hash: 'new' }));
    expect(await registry.size()).toBe(1);
    const fetched = await registry.getInstalled('r1', 'pub1');
    expect(fetched?.installed_hash).toBe('new');
  });
});

// ────────────────────────────────────────────────────────────────

describe('createIDBInstallRegistry — publisher scoping', () => {
  let registry: IDBInstallRegistry;
  beforeEach(() => { registry = createIDBInstallRegistry({ dbName: uniqueDb() }); });

  it('different publishers keep distinct entries for same recipe_id', async () => {
    await registry.markInstalled(mkRecord({ publisher_id: 'pubA', installed_hash: 'a' }));
    await registry.markInstalled(mkRecord({ publisher_id: 'pubB', installed_hash: 'b' }));
    expect(await registry.size()).toBe(2);
    expect((await registry.getInstalled('r1', 'pubA'))?.installed_hash).toBe('a');
    expect((await registry.getInstalled('r1', 'pubB'))?.installed_hash).toBe('b');
  });

  it('listInstalled returns both publisher entries', async () => {
    await registry.markInstalled(mkRecord({ publisher_id: 'pubA' }));
    await registry.markInstalled(mkRecord({ publisher_id: 'pubB' }));
    const all = await registry.listInstalled();
    expect(all.map((r) => r.publisher_id).sort()).toEqual(['pubA', 'pubB']);
  });
});

// ────────────────────────────────────────────────────────────────

describe('createIDBInstallRegistry — uninstall + upstream tracking', () => {
  let registry: IDBInstallRegistry;
  beforeEach(() => { registry = createIDBInstallRegistry({ dbName: uniqueDb() }); });

  it('markUninstalled removes the record', async () => {
    await registry.markInstalled(mkRecord());
    await registry.markUninstalled('r1', 'pub1');
    expect(await registry.getInstalled('r1', 'pub1')).toBeNull();
    expect(await registry.size()).toBe(0);
  });

  it('markUninstalled is idempotent on missing record', async () => {
    await expect(registry.markUninstalled('nothing', 'nobody')).resolves.toBeUndefined();
  });

  it('recordUpstreamCheck updates only upstream fields', async () => {
    await registry.markInstalled(mkRecord());
    await registry.recordUpstreamCheck(
      'r1', 'pub1',
      { version: 2, hash: 'upstream-hash' },
      2_000_000,
    );
    const updated = await registry.getInstalled('r1', 'pub1');
    expect(updated?.upstream_version).toBe(2);
    expect(updated?.upstream_hash).toBe('upstream-hash');
    expect(updated?.last_checked_at).toBe(2_000_000);
    // Installed fields unchanged
    expect(updated?.installed_version).toBe(1);
    expect(updated?.installed_hash).toBe('hash1');
  });

  it('recordUpstreamCheck on missing install is a silent no-op', async () => {
    await registry.recordUpstreamCheck(
      'missing', 'nobody',
      { version: 1, hash: 'x' },
      1_000_000,
    );
    expect(await registry.size()).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────

describe('createIDBInstallRegistry — persistence across instances', () => {
  it('two registries with same dbName share state', async () => {
    const dbName = uniqueDb();
    const r1 = createIDBInstallRegistry({ dbName });
    await r1.markInstalled(mkRecord({ recipe_id: 'persist', installed_hash: 'survives' }));
    await r1.close();

    const r2 = createIDBInstallRegistry({ dbName });
    const fetched = await r2.getInstalled('persist', 'pub1');
    expect(fetched?.installed_hash).toBe('survives');
  });

  it('different dbNames are isolated', async () => {
    const r1 = createIDBInstallRegistry({ dbName: uniqueDb() });
    const r2 = createIDBInstallRegistry({ dbName: uniqueDb() });
    await r1.markInstalled(mkRecord({ installed_hash: 'only-in-r1' }));
    expect(await r2.getInstalled('r1', 'pub1')).toBeNull();
  });

  it('simulates sw restart: recipe installed, registry closed, reopened, still present', async () => {
    const dbName = uniqueDb();
    const reg1 = createIDBInstallRegistry({ dbName });
    await reg1.markInstalled(mkRecord({
      installed_hash: 'pre-restart',
      installed_at: 1234567890,
    }));
    await reg1.close();

    // "service worker restarted" — fresh registry instance, same db
    const reg2 = createIDBInstallRegistry({ dbName });
    const list = await reg2.listInstalled();
    expect(list).toHaveLength(1);
    expect(list[0].installed_hash).toBe('pre-restart');
    expect(list[0].installed_at).toBe(1234567890);
  });
});

// ────────────────────────────────────────────────────────────────

describe('createIDBInstallRegistry — default dbName', () => {
  it('default dbName is recued-installs', async () => {
    // Just verify the factory runs without options
    const registry = createIDBInstallRegistry();
    await registry.markInstalled(mkRecord({ recipe_id: 'default-test' }));
    const fetched = await registry.getInstalled('default-test', 'pub1');
    expect(fetched).not.toBeNull();
    await registry.close();
  });
});

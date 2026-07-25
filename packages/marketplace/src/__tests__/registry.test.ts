import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryInstallRegistry } from '../registry.js';
import type { InstallRegistry, InstalledRecipe } from '../types.js';
import type { RecipeDefinition } from '@recued/contracts';

const sampleRecipe: RecipeDefinition = {
  recipe_id: 'r1',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'R1', description: 'desc', author: 'a',
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

describe('createInMemoryInstallRegistry', () => {
  let reg: InstallRegistry;

  beforeEach(() => {
    reg = createInMemoryInstallRegistry();
  });

  it('starts empty', async () => {
    expect(await reg.size()).toBe(0);
    expect(await reg.listInstalled()).toEqual([]);
  });

  it('markInstalled + getInstalled roundtrip', async () => {
    const record = mkRecord();
    await reg.markInstalled(record);
    const fetched = await reg.getInstalled('r1', 'pub1');
    expect(fetched).toEqual(record);
  });

  it('getInstalled returns null for missing entries', async () => {
    expect(await reg.getInstalled('missing', 'pub1')).toBe(null);
  });

  it('different publishers keep distinct entries for same recipe_id', async () => {
    const recordA = mkRecord({ publisher_id: 'pubA', installed_hash: 'a' });
    const recordB = mkRecord({ publisher_id: 'pubB', installed_hash: 'b' });
    await reg.markInstalled(recordA);
    await reg.markInstalled(recordB);
    expect(await reg.size()).toBe(2);
    expect((await reg.getInstalled('r1', 'pubA'))?.installed_hash).toBe('a');
    expect((await reg.getInstalled('r1', 'pubB'))?.installed_hash).toBe('b');
  });

  it('markInstalled replaces existing entry for the same key', async () => {
    await reg.markInstalled(mkRecord({ installed_hash: 'old' }));
    await reg.markInstalled(mkRecord({ installed_hash: 'new' }));
    expect(await reg.size()).toBe(1);
    expect((await reg.getInstalled('r1', 'pub1'))?.installed_hash).toBe('new');
  });

  it('markUninstalled removes an entry', async () => {
    await reg.markInstalled(mkRecord());
    await reg.markUninstalled('r1', 'pub1');
    expect(await reg.getInstalled('r1', 'pub1')).toBe(null);
    expect(await reg.size()).toBe(0);
  });

  it('markUninstalled is idempotent on missing entries', async () => {
    await expect(reg.markUninstalled('nothing', 'nobody')).resolves.toBeUndefined();
  });

  it('listInstalled returns all entries', async () => {
    await reg.markInstalled(mkRecord({ recipe_id: 'r1' }));
    await reg.markInstalled(mkRecord({ recipe_id: 'r2' }));
    const all = await reg.listInstalled();
    expect(all.length).toBe(2);
  });

  it('recordUpstreamCheck updates only upstream fields', async () => {
    await reg.markInstalled(mkRecord());
    await reg.recordUpstreamCheck('r1', 'pub1',
      { version: 2, hash: 'upstream' }, 2_000_000);
    const updated = await reg.getInstalled('r1', 'pub1');
    expect(updated?.upstream_version).toBe(2);
    expect(updated?.upstream_hash).toBe('upstream');
    expect(updated?.last_checked_at).toBe(2_000_000);
    // Installed fields unchanged
    expect(updated?.installed_version).toBe(1);
    expect(updated?.installed_hash).toBe('hash1');
  });

  it('recordUpstreamCheck on missing install is a silent no-op', async () => {
    await reg.recordUpstreamCheck('missing', 'nobody',
      { version: 1, hash: 'x' }, 1_000_000);
    expect(await reg.size()).toBe(0);
  });

  it('separate registries are independent', async () => {
    const a = createInMemoryInstallRegistry();
    const b = createInMemoryInstallRegistry();
    await a.markInstalled(mkRecord());
    expect(await a.size()).toBe(1);
    expect(await b.size()).toBe(0);
  });
});

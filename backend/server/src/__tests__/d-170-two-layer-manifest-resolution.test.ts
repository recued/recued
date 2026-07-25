/** D-170 #6 — two-layer manifest resolution.
 *
 *  Local authored manifests and bundled kernel/community manifests can share a
 *  slug without collapsing into one mutable registry entry:
 *    - local present shadows bundled;
 *    - local absent falls through to bundled;
 *    - version pins must match the winning layer exactly. A local version
 *      mismatch fails closed instead of falling through to bundled. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { IngredientManifest } from '@recued/contracts';

import {
  createLocalManifestStore,
} from '../ingredient-authoring/local-manifest-store.js';
import { createManifestRegistry } from '../manifest-loader.js';

const manifest = (
  slug: string,
  version: number,
  name: string,
): IngredientManifest => ({
  slug,
  version,
  name,
  description: `${name} fixture`,
  author: 'recued-core',
  kind: 'connection',
  category: 'data',
  risk_tier: 'read',
  input: {},
  output: {},
});

const writeBundled = (dir: string, m: IngredientManifest): void => {
  writeFileSync(join(dir, `${m.slug}.json`), JSON.stringify(m));
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('D-170 local-manifest-store version-aware reads', () => {
  it('returns highest local version unpinned and exact version when pinned', () => {
    const db = new Database(':memory:');
    try {
      const store = createLocalManifestStore(db);
      store.put({ manifest: manifest('local-api', 1, 'Local v1'), entity_schemas: [] });
      store.put({ manifest: manifest('local-api', 2, 'Local v2'), entity_schemas: [] });

      expect(store.getManifest('local-api')?.name).toBe('Local v2');
      expect(store.getManifest('local-api', 1)?.name).toBe('Local v1');
      expect(store.getManifest('local-api', 2)?.name).toBe('Local v2');
      expect(store.getManifest('local-api', 3)).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe('D-170 manifest registry local/bundled precedence', () => {
  it('local-shadows-bundled and unregister falls through to bundled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-d170-two-layer-'));
    tempDirs.push(dir);
    writeBundled(dir, manifest('shared-api', 1, 'Bundled v1'));
    const registry = createManifestRegistry(dir);

    registry.register(manifest('shared-api', 2, 'Local v2'));

    expect(registry.get('shared-api')?.name).toBe('Local v2');
    expect(registry.size()).toBe(1);
    expect(registry.slugs()).toEqual(['shared-api']);

    expect(registry.unregister('shared-api')).toBe(true);
    expect(registry.get('shared-api')?.name).toBe('Bundled v1');
  });

  it('falls through to bundled when no local manifest is present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-d170-two-layer-'));
    tempDirs.push(dir);
    writeBundled(dir, manifest('bundled-only', 1, 'Bundled only'));
    const registry = createManifestRegistry(dir);

    expect(registry.get('bundled-only')?.name).toBe('Bundled only');
    expect(registry.get('bundled-only', 1)?.name).toBe('Bundled only');
    expect(registry.get('bundled-only', 2)).toBeNull();
  });

  it('version pin must match the winning layer exactly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-d170-two-layer-'));
    tempDirs.push(dir);
    writeBundled(dir, manifest('shared-api', 1, 'Bundled v1'));
    const registry = createManifestRegistry(dir);
    registry.register(manifest('shared-api', 2, 'Local v2'));

    expect(registry.get('shared-api', 2)?.name).toBe('Local v2');
    expect(registry.get('shared-api', 1)).toBeNull();

    registry.unregister('shared-api');
    expect(registry.get('shared-api', 1)?.name).toBe('Bundled v1');
    expect(registry.get('shared-api', 2)).toBeNull();
  });
});

describe('§5 core- anti-shadow — local cannot shadow a reserved core- slug', () => {
  it('a registered local core- manifest never shadows the bundled core- layer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-core-shadow-'));
    tempDirs.push(dir);
    // The bundled kernel capability (what slice 2 ships under community/ingredients).
    writeBundled(dir, manifest('core-ai-classify', 1, 'Bundled core capability'));
    const registry = createManifestRegistry(dir);

    // An attacker-style local registration (e.g. a compiled composition /
    // save-as-new manifest) tries to claim the core- identity with arbitrary behavior.
    const evil: IngredientManifest = { ...manifest('core-ai-classify', 9, 'Evil shadow'), author: 'attacker', kind: 'http' };
    registry.register(evil);

    // get() always resolves core- to the bundled layer — the shadow is ignored.
    expect(registry.get('core-ai-classify')?.name).toBe('Bundled core capability');
    expect(registry.get('core-ai-classify')?.author).toBe('recued-core');
    // The version-pinned path is equally guarded — the attacker's version never resolves,
    // and the bundled version still does.
    expect(registry.get('core-ai-classify', 9)).toBeNull();
    expect(registry.get('core-ai-classify', 1)?.name).toBe('Bundled core capability');
    // register() refused to store it, so the local layer stays clean.
    expect(registry.slugs()).toEqual(['core-ai-classify']);
    expect(registry.size()).toBe(1);
  });

  it('a local core- manifest with no bundled counterpart resolves to null (never the local one)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-core-shadow-'));
    tempDirs.push(dir);
    const registry = createManifestRegistry(dir);

    registry.register(manifest('core-not-real', 1, 'Local-only core squat'));

    // No bundled core-not-real exists, and the local layer is ignored for core-.
    expect(registry.get('core-not-real')).toBeNull();
    expect(registry.slugs()).toEqual([]);
  });

  it('a non-core local slug still shadows bundled normally (no regression)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-core-shadow-'));
    tempDirs.push(dir);
    writeBundled(dir, manifest('regular-api', 1, 'Bundled v1'));
    const registry = createManifestRegistry(dir);

    registry.register(manifest('regular-api', 2, 'Local v2'));
    expect(registry.get('regular-api')?.name).toBe('Local v2');
  });
});

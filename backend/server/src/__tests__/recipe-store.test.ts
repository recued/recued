import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { RecipeDefinition } from '@recued/contracts';
import { createRecipeStore } from '../recipe-store.js';

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

const mkRecipe = (id: string, version = 1): RecipeDefinition => ({
  recipe_id: id,
  version,
  ttl: 60,
  metadata: { name: id, description: '', author: 'test', supported_platforms: [] },
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 's', transform: 'template', template: 'ok' }],
  output: { sidebar: [] },
});

let bundleDir: string;
let db: Database.Database;

beforeEach(() => {
  bundleDir = mkdtempSync(join(tmpdir(), 'recued-bundled-'));
  db = new Database(':memory:');
});

afterEach(() => {
  rmSync(bundleDir, { recursive: true, force: true });
  db.close();
});

// ────────────────────────────────────────────────────────────────
// Bundled loading (read-only file source)
// ────────────────────────────────────────────────────────────────

describe('createRecipeStore — bundled directory loading', () => {
  it('returns an empty store when the community dir does not exist', () => {
    const store = createRecipeStore('/definitely-not-a-real-path-xyz');
    expect(store.size()).toBe(0);
    expect(store.ids()).toEqual([]);
    expect(store.get('anything')).toBeNull();
  });

  it('loads .json files and ignores non-json', () => {
    writeFileSync(join(bundleDir, 'a.json'), JSON.stringify(mkRecipe('recipe-a')));
    writeFileSync(join(bundleDir, 'b.json'), JSON.stringify(mkRecipe('recipe-b')));
    writeFileSync(join(bundleDir, 'README.md'), '# not a recipe');

    const store = createRecipeStore(bundleDir);
    expect(store.size()).toBe(2);
    expect(store.ids().sort()).toEqual(['recipe-a', 'recipe-b']);
    expect(store.get('recipe-a')?.recipe_id).toBe('recipe-a');
  });

  it('skips malformed JSON without throwing', () => {
    writeFileSync(join(bundleDir, 'good.json'), JSON.stringify(mkRecipe('good-one')));
    writeFileSync(join(bundleDir, 'bad.json'), '{ not valid json');

    const store = createRecipeStore(bundleDir);
    expect(store.ids()).toEqual(['good-one']);
  });

  it('skips JSON files that lack a recipe_id', () => {
    writeFileSync(join(bundleDir, 'noid.json'), JSON.stringify({ some: 'data' }));
    writeFileSync(join(bundleDir, 'ok.json'), JSON.stringify(mkRecipe('real')));

    const store = createRecipeStore(bundleDir);
    expect(store.ids()).toEqual(['real']);
  });

  it('getStored returns null for bundled-only recipes (no DB row)', () => {
    writeFileSync(join(bundleDir, 'a.json'), JSON.stringify(mkRecipe('bundled-a')));
    const store = createRecipeStore(bundleDir);
    expect(store.get('bundled-a')).not.toBeNull();
    expect(store.getStored('bundled-a')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// In-memory register (no persistence)
// ────────────────────────────────────────────────────────────────

describe('createRecipeStore — register()', () => {
  it('stores a recipe in memory and retrieves it', () => {
    const store = createRecipeStore(bundleDir);
    store.register(mkRecipe('ephemeral'));
    expect(store.get('ephemeral')?.recipe_id).toBe('ephemeral');
    expect(store.ids()).toContain('ephemeral');
    expect(store.size()).toBe(1);
  });

  it('memory overrides shadow bundled recipes with the same id', () => {
    writeFileSync(join(bundleDir, 'a.json'), JSON.stringify(mkRecipe('shared', 1)));
    const store = createRecipeStore(bundleDir);
    expect(store.get('shared')?.version).toBe(1);

    store.register(mkRecipe('shared', 99));
    expect(store.get('shared')?.version).toBe(99);
    expect(store.size()).toBe(1); // still one unique id
  });
});

// ────────────────────────────────────────────────────────────────
// No-database mode
// ────────────────────────────────────────────────────────────────

describe('createRecipeStore — no database', () => {
  it('save() throws when no DB is configured', () => {
    const store = createRecipeStore(bundleDir);
    expect(() => store.save(mkRecipe('x'), 'recued-core', 'imported' as never))
      .toThrow('No database configured');
  });

  it('delete() returns false when no DB is configured', () => {
    const store = createRecipeStore(bundleDir);
    expect(store.delete('anything')).toBe(false);
  });

  it('listStored() returns empty when no DB is configured', () => {
    const store = createRecipeStore(bundleDir);
    expect(store.listStored()).toEqual([]);
  });

  it('updateUpstream() is a no-op (returns undefined) without a DB', () => {
    const store = createRecipeStore(bundleDir);
    expect(store.updateUpstream('x', { version: 2, hash: 'h' }, Date.now())).toBeUndefined();
  });

  it('getStored() returns null without a DB', () => {
    const store = createRecipeStore(bundleDir);
    expect(store.getStored('anything')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// SQLite persistence
// ────────────────────────────────────────────────────────────────

describe('createRecipeStore — SQLite persistence', () => {
  it('creates the recipes table on construction', () => {
    createRecipeStore(bundleDir, db);
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'recipes'")
      .all();
    expect(rows).toHaveLength(1);
  });

  it('save() inserts a new recipe and get()/getStored() find it', () => {
    const store = createRecipeStore(bundleDir, db);
    const recipe = mkRecipe('saved-one', 2);
    store.save(recipe, 'recued-core', 'pair-sync' as never, 1_700_000_000_000);

    expect(store.get('saved-one')?.version).toBe(2);
    const stored = store.getStored('saved-one');
    expect(stored).toBeTruthy();
    expect(stored!.publisher_id).toBe('recued-core');
    expect(stored!.version).toBe(2);
    expect(stored!.source).toBe('pair-sync');
    expect(stored!.installed_at).toBe(1_700_000_000_000);
    expect(typeof stored!.recipe_hash).toBe('string');
    expect(stored!.recipe_hash.length).toBeGreaterThan(0);
  });

  it('save() upserts when called twice for the same recipe_id', () => {
    const store = createRecipeStore(bundleDir, db);
    store.save(mkRecipe('up', 1), 'recued-core', 'pair-sync' as never, 1);
    store.save(mkRecipe('up', 5), 'other-pub', 'inline' as never, 2);

    const stored = store.getStored('up');
    expect(stored!.version).toBe(5);
    expect(stored!.publisher_id).toBe('other-pub');
    expect(stored!.source).toBe('inline');
    expect(stored!.installed_at).toBe(2);

    // Still one row.
    expect(store.listStored()).toHaveLength(1);
  });

  it('save() defaults now to Date.now() when omitted', () => {
    const store = createRecipeStore(bundleDir, db);
    const before = Date.now();
    store.save(mkRecipe('defaulted'), 'recued-core', 'inline' as never);
    const stored = store.getStored('defaulted')!;
    expect(stored.installed_at).toBeGreaterThanOrEqual(before);
    expect(stored.installed_at).toBeLessThanOrEqual(Date.now());
  });

  it('delete() removes the recipe and reports it', () => {
    const store = createRecipeStore(bundleDir, db);
    store.save(mkRecipe('to-delete'), 'recued-core', 'inline' as never);
    expect(store.delete('to-delete')).toBe(true);
    expect(store.get('to-delete')).toBeNull();
  });

  it('delete() returns false when no row was removed', () => {
    const store = createRecipeStore(bundleDir, db);
    expect(store.delete('never-existed')).toBe(false);
  });

  it('listStored() returns rows ordered by installed_at DESC', () => {
    const store = createRecipeStore(bundleDir, db);
    store.save(mkRecipe('older'), 'p', 'inline' as never, 100);
    store.save(mkRecipe('newer'), 'p', 'inline' as never, 200);
    store.save(mkRecipe('middle'), 'p', 'inline' as never, 150);

    const rows = store.listStored();
    expect(rows.map(r => r.recipe_id)).toEqual(['newer', 'middle', 'older']);
  });

  it('updateUpstream() sets upstream_version/hash/last_checked_at on an existing row', () => {
    const store = createRecipeStore(bundleDir, db);
    store.save(mkRecipe('up'), 'recued-core', 'inline' as never, 1);
    store.updateUpstream('up', { version: 7, hash: 'abc' }, 42);

    const row = db.prepare('SELECT upstream_version, upstream_hash, last_checked_at FROM recipes WHERE recipe_id = ?')
      .get('up') as { upstream_version: number; upstream_hash: string; last_checked_at: number };
    expect(row.upstream_version).toBe(7);
    expect(row.upstream_hash).toBe('abc');
    expect(row.last_checked_at).toBe(42);
  });

  it('updateUpstream() on a missing recipe is a no-op (no row created)', () => {
    const store = createRecipeStore(bundleDir, db);
    store.updateUpstream('ghost', { version: 7, hash: 'abc' }, 42);
    expect(store.listStored()).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// Priority: memory > SQLite > bundled
// ────────────────────────────────────────────────────────────────

describe('createRecipeStore — lookup priority', () => {
  it('memory override wins over SQLite and bundled', () => {
    writeFileSync(join(bundleDir, 'a.json'), JSON.stringify(mkRecipe('prio', 1)));
    const store = createRecipeStore(bundleDir, db);
    store.save(mkRecipe('prio', 2), 'p', 'pair-sync' as never, 1);
    expect(store.get('prio')?.version).toBe(2); // SQLite beats bundled

    store.register(mkRecipe('prio', 3));
    expect(store.get('prio')?.version).toBe(3); // Memory beats SQLite
  });

  it('SQLite wins over bundled for the same id', () => {
    writeFileSync(join(bundleDir, 'a.json'), JSON.stringify(mkRecipe('collide', 1)));
    const store = createRecipeStore(bundleDir, db);
    store.save(mkRecipe('collide', 9), 'p', 'pair-sync' as never, 1);
    expect(store.get('collide')?.version).toBe(9);
  });

  it('bundled is returned when neither memory nor SQLite has the recipe', () => {
    writeFileSync(join(bundleDir, 'a.json'), JSON.stringify(mkRecipe('only-bundled')));
    const store = createRecipeStore(bundleDir, db);
    expect(store.get('only-bundled')?.recipe_id).toBe('only-bundled');
  });

  it('size()/ids() unions memory + SQLite + bundled (deduped)', () => {
    writeFileSync(join(bundleDir, 'a.json'), JSON.stringify(mkRecipe('from-bundle')));
    const store = createRecipeStore(bundleDir, db);
    store.save(mkRecipe('from-db'), 'p', 'inline' as never, 1);
    store.register(mkRecipe('from-memory'));
    store.register(mkRecipe('from-bundle')); // duplicate id across sources

    expect(store.size()).toBe(3);
    expect(store.ids().sort()).toEqual(['from-bundle', 'from-db', 'from-memory']);
  });
});

// ────────────────────────────────────────────────────────────────
// D-145 PA10 follow-on — pack_slug column + listForPack
// (pack-install-registry — closes Slice B's Codex MAJOR 2)
// ────────────────────────────────────────────────────────────────

describe('createRecipeStore — pack_slug provenance', () => {
  it('persists pack_slug on save() + surfaces it on getStored()', () => {
    const store = createRecipeStore(bundleDir, db);
    store.save(mkRecipe('owned'), 'p', 'pair-sync' as never, 1, 'pack-x');
    const row = store.getStored('owned');
    expect(row?.pack_slug).toBe('pack-x');
  });

  it('save() without a pack_slug argument stores NULL (mcp-server / manual install semantic)', () => {
    const store = createRecipeStore(bundleDir, db);
    // The mcp-server.ts recipe-upload path + the auto-run scheduler's
    // test mock both omit the pack_slug parameter; pack-uninstall must
    // not claim those rows.
    store.save(mkRecipe('manual'), 'p', 'pair-sync' as never, 1);
    const row = store.getStored('manual');
    expect(row?.pack_slug).toBeNull();
  });

  it('save() with pack_slug=null clears any prior pack ownership (upsert overwrites column)', () => {
    const store = createRecipeStore(bundleDir, db);
    store.save(mkRecipe('clear'), 'p', 'pair-sync' as never, 1, 'pack-y');
    expect(store.getStored('clear')?.pack_slug).toBe('pack-y');
    // Manual re-save without a pack_slug arg → upsert sets pack_slug
    // to NULL. The user has effectively "unowned" the row by saving
    // their own content over the pack's version.
    store.save(mkRecipe('clear'), 'p', 'pair-sync' as never, 2);
    expect(store.getStored('clear')?.pack_slug).toBeNull();
  });

  it('save() with a different pack_slug transfers ownership (last-writer-wins)', () => {
    // Pack A installs `shared`. Pack B re-installs the same slug —
    // the upsert overwrites both content and pack_slug. This is the
    // semantic the cross-pack-collision uninstall test relies on.
    const store = createRecipeStore(bundleDir, db);
    store.save(mkRecipe('shared'), 'p', 'pair-sync' as never, 1, 'pack-a');
    store.save(mkRecipe('shared'), 'p', 'pair-sync' as never, 2, 'pack-b');
    expect(store.getStored('shared')?.pack_slug).toBe('pack-b');
  });

  it('listForPack() returns recipe_ids owned by the slug, in ORDER BY recipe_id ASC', () => {
    const store = createRecipeStore(bundleDir, db);
    // Insert out of alphabetical order to ensure the SQL ORDER BY
    // does the sorting rather than insertion order leaking through.
    store.save(mkRecipe('charlie'), 'p', 'pair-sync' as never, 3, 'pack-1');
    store.save(mkRecipe('alpha'), 'p', 'pair-sync' as never, 1, 'pack-1');
    store.save(mkRecipe('bravo'), 'p', 'pair-sync' as never, 2, 'pack-1');
    expect(store.listForPack('pack-1')).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('listForPack() omits rows owned by other packs + NULL-owned rows', () => {
    const store = createRecipeStore(bundleDir, db);
    store.save(mkRecipe('mine-1'), 'p', 'pair-sync' as never, 1, 'pack-mine');
    store.save(mkRecipe('mine-2'), 'p', 'pair-sync' as never, 1, 'pack-mine');
    store.save(mkRecipe('theirs'), 'p', 'pair-sync' as never, 1, 'pack-theirs');
    store.save(mkRecipe('manual'), 'p', 'pair-sync' as never, 1); // pack_slug = NULL
    expect(store.listForPack('pack-mine').sort()).toEqual(['mine-1', 'mine-2']);
    expect(store.listForPack('pack-theirs')).toEqual(['theirs']);
    // Unrelated slug → empty
    expect(store.listForPack('pack-other')).toEqual([]);
  });

  it('listForPack() returns [] for empty / whitespace-only slugs (defensive)', () => {
    const store = createRecipeStore(bundleDir, db);
    store.save(mkRecipe('foo'), 'p', 'pair-sync' as never, 1, 'pack-real');
    expect(store.listForPack('')).toEqual([]);
    expect(store.listForPack('   ')).toEqual([]);
  });

  it('listForPack() returns [] when the store has no db (bundled-only mode)', () => {
    // Tests that don't pass a db still see a callable listForPack —
    // the auto-run-scheduler test mock relies on this no-throw shape.
    const store = createRecipeStore(bundleDir);
    expect(store.listForPack('anything')).toEqual([]);
  });

  it('delete() drops the row and its pack_slug together', () => {
    const store = createRecipeStore(bundleDir, db);
    store.save(mkRecipe('to-drop'), 'p', 'pair-sync' as never, 1, 'pack-z');
    expect(store.listForPack('pack-z')).toEqual(['to-drop']);
    expect(store.delete('to-drop')).toBe(true);
    expect(store.listForPack('pack-z')).toEqual([]);
    expect(store.getStored('to-drop')).toBeNull();
  });

  it('listStored() surfaces pack_slug on every returned row', () => {
    const store = createRecipeStore(bundleDir, db);
    store.save(mkRecipe('owned-a'), 'p', 'pair-sync' as never, 1, 'pack-foo');
    store.save(mkRecipe('manual'), 'p', 'pair-sync' as never, 2);
    const rows = store.listStored();
    const owned = rows.find((r) => r.recipe_id === 'owned-a');
    const manual = rows.find((r) => r.recipe_id === 'manual');
    expect(owned?.pack_slug).toBe('pack-foo');
    expect(manual?.pack_slug).toBeNull();
  });
});

describe('createRecipeStore — exact local recipe authoring CAS', () => {
  it('preserves non-content provenance and rejects a stale exact-JSON writer', () => {
    const store = createRecipeStore(bundleDir, db);
    const inspectLocalRecipeEdit = store.inspectLocalRecipeEdit;
    const compareAndSaveLocalRecipe = store.compareAndSaveLocalRecipe;
    if (!inspectLocalRecipeEdit || !compareAndSaveLocalRecipe) {
      throw new Error('safe local recipe writer is not composed');
    }
    const original = mkRecipe('local-config', 4);
    original.metadata = {
      ...original.metadata,
      tags: ['local', 'checkout', 'document'],
    };
    store.save(original, 'local-owner', 'inline' as never, 123);
    store.updateUpstream('local-config', { version: 8, hash: 'upstream-hash' }, 456);
    const inspected = inspectLocalRecipeEdit('local-config');
    expect(inspected.kind).toBe('editable');
    if (inspected.kind !== 'editable') throw new Error('expected editable recipe');

    const next = structuredClone(inspected.recipe);
    next.metadata = {
      ...next.metadata,
      paid_document_direct_checkout: {
        version: 1,
        stripe_connection_name: 'stripe-primary',
        success_url: 'https://owner.example/success',
        cancel_url: 'https://owner.example/cancel',
        expiry_window_ms: 30 * 60 * 1_000,
        template_file_ref: `file:${'a'.repeat(32)}`,
      },
    };
    const updated = compareAndSaveLocalRecipe({
      recipe: next,
      expected_recipe_json: inspected.recipe_json,
      now: 789,
    });
    expect(updated).toMatchObject({ kind: 'updated' });
    const row = db.prepare(`
      SELECT publisher_id, source, installed_at, upstream_version,
             upstream_hash, last_checked_at, pack_slug, recipe_json
      FROM recipes WHERE recipe_id = ?
    `).get('local-config') as {
      publisher_id: string;
      source: string;
      installed_at: number;
      upstream_version: number;
      upstream_hash: string;
      last_checked_at: number;
      pack_slug: string | null;
      recipe_json: string;
    };
    expect(row).toMatchObject({
      publisher_id: 'local-owner',
      source: 'inline',
      installed_at: 123,
      upstream_version: 8,
      upstream_hash: 'upstream-hash',
      last_checked_at: 456,
      pack_slug: null,
    });
    expect(JSON.parse(row.recipe_json)).toEqual(next);

    const staleNext = structuredClone(inspected.recipe);
    staleNext.ttl = 999;
    expect(compareAndSaveLocalRecipe({
      recipe: staleNext,
      expected_recipe_json: inspected.recipe_json,
    })).toMatchObject({ kind: 'conflict' });
    expect(store.get('local-config')).toEqual(next);

    const current = inspectLocalRecipeEdit('local-config');
    if (current.kind !== 'editable') throw new Error('expected current editable recipe');
    db.prepare('UPDATE recipes SET pack_slug = ? WHERE recipe_id = ?')
      .run('pack-raced', 'local-config');
    const provenanceRaced = structuredClone(current.recipe);
    provenanceRaced.ttl = 777;
    expect(compareAndSaveLocalRecipe({
      recipe: provenanceRaced,
      expected_recipe_json: current.recipe_json,
    })).toEqual({ kind: 'not_editable' });
    expect(store.getStored('local-config')).toMatchObject({
      pack_slug: 'pack-raced',
      recipe_json: JSON.stringify(next),
    });
  });

  it('requires a fork for pack/bundled sources and refuses a memory-shadowed row', () => {
    const bundled = mkRecipe('bundled-config');
    writeFileSync(join(bundleDir, 'bundled-config.json'), JSON.stringify(bundled));
    const store = createRecipeStore(bundleDir, db);
    const inspectLocalRecipeEdit = store.inspectLocalRecipeEdit;
    if (!inspectLocalRecipeEdit) throw new Error('local edit inspection is not composed');
    expect(inspectLocalRecipeEdit('bundled-config')).toMatchObject({
      kind: 'fork_required',
    });

    store.save(mkRecipe('pack-config'), 'publisher', 'pair-sync' as never, 1, 'pack-a');
    expect(inspectLocalRecipeEdit('pack-config')).toMatchObject({
      kind: 'fork_required',
    });

    store.save(mkRecipe('shadowed-config'), 'local', 'inline' as never, 1);
    store.register(mkRecipe('shadowed-config', 2));
    expect(inspectLocalRecipeEdit('shadowed-config')).toEqual({
      kind: 'unavailable',
    });
  });
});

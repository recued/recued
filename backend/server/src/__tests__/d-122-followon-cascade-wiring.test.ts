/** D-122 follow-on — cascade hook wiring tests.
 *
 *  Covers the new wire sites:
 *    1. `bridgeEnrichmentCascade` — warehouse `updated` events fire
 *       `cascadeForSourceUpdate` for mail/calendar/file/contact;
 *       `deleted` events fire `cascadeForSourceDelete` for calendar
 *       only (mail/file/contact deletes are covered by other paths).
 *    2. `recipe-store.save()` — fires `onUpgradeHook` when prior hash
 *       differs from new hash; no-op on fresh install or no-op
 *       re-install with the same hash. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWarehouseEventBus } from '@recued/warehouse-events';
import type { EnrichmentScope, RecipeDefinition } from '@recued/contracts';
import { bridgeEnrichmentCascade } from '../events/emit-sites.js';
import { createRecipeStore } from '../recipe-store.js';

const stubCascade = () => {
  const updates: Array<[EnrichmentScope, string]> = [];
  const deletes: Array<[EnrichmentScope, string]> = [];
  return {
    updates,
    deletes,
    cascadeForSourceUpdate: (scope: EnrichmentScope, id: string) => {
      updates.push([scope, id]); return null;
    },
    cascadeForSourceDelete: (scope: EnrichmentScope, id: string) => {
      deletes.push([scope, id]); return null;
    },
  };
};

// ────────────────────────────────────────────────────────────────
// 1. bridgeEnrichmentSourceUpdate
// ────────────────────────────────────────────────────────────────

describe('D-122 follow-on — bridgeEnrichmentCascade (`updated` fan-out)', () => {
  it('fires cascadeForSourceUpdate on warehouse `updated` for mail / calendar / file / contact', () => {
    const cascade = stubCascade();
    const bus = createWarehouseEventBus();
    bridgeEnrichmentCascade(bus, cascade);

    bus.emit({ platform: 'mail',     slug: 'work',     entity_type: 'message', event_kind: 'updated', record_id: 'msg-1', at: 1 });
    bus.emit({ platform: 'calendar', slug: 'gcal',     entity_type: 'event',   event_kind: 'updated', record_id: 'evt-1', at: 1 });
    bus.emit({ platform: 'file',     slug: 'desktop',  entity_type: 'file',    event_kind: 'updated', record_id: '/x.txt', at: 1 });
    bus.emit({ platform: 'contact',  slug: 'primary',  entity_type: 'contact', event_kind: 'updated', record_id: 'a@x.com', at: 1 });

    expect(cascade.updates).toEqual([
      ['mail',     'msg-1'],
      ['calendar', 'evt-1'],
      ['file',     '/x.txt'],
      ['contact',  'a@x.com'],
    ]);
    expect(cascade.deletes).toEqual([]);
  });

  it('skips `created` and `synced` events on the update side', () => {
    const cascade = stubCascade();
    const bus = createWarehouseEventBus();
    bridgeEnrichmentCascade(bus, cascade);

    bus.emit({ platform: 'mail', slug: 'work', entity_type: 'message', event_kind: 'created', record_id: 'msg-c', at: 1 });
    bus.emit({ platform: 'mail', slug: 'work', entity_type: 'message', event_kind: 'synced',  record_id: '',      at: 1 });
    bus.emit({ platform: 'mail', slug: 'work', entity_type: 'message', event_kind: 'updated', record_id: 'msg-u', at: 1 });

    expect(cascade.updates).toEqual([['mail', 'msg-u']]);
  });

  it('skips webhook + service platforms (no enrichment topics declare those scopes)', () => {
    const cascade = stubCascade();
    const bus = createWarehouseEventBus();
    bridgeEnrichmentCascade(bus, cascade);

    bus.emit({ platform: 'webhook', slug: 'gh', entity_type: 'delivery', event_kind: 'updated', record_id: 'deliv-1', at: 1 });
    bus.emit({ platform: 'service', slug: 'ollama', entity_type: 'service', event_kind: 'updated', record_id: 'svc-1', at: 1 });
    bus.emit({ platform: 'mail',    slug: 'work', entity_type: 'message',  event_kind: 'updated', record_id: 'msg-1', at: 1 });

    expect(cascade.updates).toEqual([['mail', 'msg-1']]);
  });

  it('swallows cascade exceptions — bus emit chain stays alive', () => {
    const bus = createWarehouseEventBus();
    bridgeEnrichmentCascade(bus, {
      cascadeForSourceUpdate: () => { throw new Error('cascade boom'); },
      cascadeForSourceDelete: () => { throw new Error('cascade boom'); },
    });
    // Other subscribers still fire — verify by attaching a downstream
    // subscriber AFTER the cascade bridge.
    let downstream = 0;
    bus.subscribe('**', () => { downstream += 1; });

    expect(() => bus.emit({
      platform: 'mail', slug: 'work', entity_type: 'message',
      event_kind: 'updated', record_id: 'msg-x', at: 1,
    })).not.toThrow();
    expect(downstream).toBe(1);
  });

  it('skips events with empty record_id', () => {
    const cascade = stubCascade();
    const bus = createWarehouseEventBus();
    bridgeEnrichmentCascade(bus, cascade);
    bus.emit({
      platform: 'mail', slug: 'work', entity_type: 'message',
      event_kind: 'updated', record_id: '', at: 1,
    });
    expect(cascade.updates).toEqual([]);
  });
});

describe('D-122 follow-on — bridgeEnrichmentCascade (`deleted` fan-out)', () => {
  it('fires cascadeForSourceDelete on `deleted` for calendar (the only delete path that flows here)', () => {
    const cascade = stubCascade();
    const bus = createWarehouseEventBus();
    bridgeEnrichmentCascade(bus, cascade);

    bus.emit({ platform: 'calendar', slug: 'gcal', entity_type: 'event', event_kind: 'deleted', record_id: 'evt-9', at: 1 });

    expect(cascade.deletes).toEqual([['calendar', 'evt-9']]);
  });

  it('does not fire delete for mail / file / contact (those have their own synchronous delete cascades)', () => {
    const cascade = stubCascade();
    const bus = createWarehouseEventBus();
    bridgeEnrichmentCascade(bus, cascade);

    bus.emit({ platform: 'mail',    slug: 'work',    entity_type: 'message', event_kind: 'deleted', record_id: 'msg-d',  at: 1 });
    bus.emit({ platform: 'file',    slug: 'desktop', entity_type: 'file',    event_kind: 'deleted', record_id: '/d.txt', at: 1 });
    bus.emit({ platform: 'contact', slug: 'primary', entity_type: 'contact', event_kind: 'deleted', record_id: 'b@x.com', at: 1 });

    expect(cascade.deletes).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// 2. recipe-store onUpgrade hook
// ────────────────────────────────────────────────────────────────

describe('D-122 follow-on — recipe-store save() fires onUpgradeHook on hash change', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recipe-upgrade-'));
    db = new Database(join(dir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const buildRecipe = (recipe_id: string, version: number, name = 'rcp'): RecipeDefinition =>
    ({
      recipe_id,
      version,
      metadata: {
        name,
        description: 'desc',
        author: 'recued-core',
        supported_platforms: [],
        tags: [],
        budget_ms: 30000,
      },
      prefetch_steps: [],
      steps: [],
      output: { sidebar: [] },
    } as unknown as RecipeDefinition);

  it('fires onUpgrade when prior hash differs from new hash (actual content change)', () => {
    const fired: string[] = [];
    const store = createRecipeStore('/nonexistent', db);
    store.setOnUpgrade((id) => fired.push(id));

    store.save(buildRecipe('rcp-1', 1, 'v1'), 'recued-core', 'inline');
    expect(fired).toEqual([]);  // fresh install — no prior hash, no upgrade

    store.save(buildRecipe('rcp-1', 2, 'v2-renamed'), 'recued-core', 'inline');
    expect(fired).toEqual(['rcp-1']);  // hash changed → upgrade fires
  });

  it('does not fire onUpgrade on no-op re-install (same hash)', () => {
    const fired: string[] = [];
    const store = createRecipeStore('/nonexistent', db);
    store.setOnUpgrade((id) => fired.push(id));

    const recipe = buildRecipe('rcp-2', 1, 'fixed');
    store.save(recipe, 'recued-core', 'inline');
    store.save(recipe, 'recued-core', 'inline');  // same content, same hash

    expect(fired).toEqual([]);
  });

  it('swallows hook exceptions so save() succeeds even if cascade throws', () => {
    const store = createRecipeStore('/nonexistent', db);
    store.setOnUpgrade(() => { throw new Error('cascade boom'); });

    store.save(buildRecipe('rcp-3', 1), 'recued-core', 'inline');
    expect(() => {
      store.save(buildRecipe('rcp-3', 2, 'changed'), 'recued-core', 'inline');
    }).not.toThrow();
    expect(store.get('rcp-3')?.version).toBe(2);  // upgrade still landed
  });

  it('does not fire when no hook is registered', () => {
    const store = createRecipeStore('/nonexistent', db);
    // Hook never set.
    expect(() => {
      store.save(buildRecipe('rcp-4', 1), 'recued-core', 'inline');
      store.save(buildRecipe('rcp-4', 2, 'v2'), 'recued-core', 'inline');
    }).not.toThrow();
  });
});


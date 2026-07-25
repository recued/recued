/** Tests for the schema-driven server config — builder + applier.
 *
 *  Builder test: schema reports the real current values from the
 *  LLMConfigManager. Applier test: each declared field round-trips
 *  through apply → get; unknown keys + type-mismatched values throw
 *  with a descriptive error.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { createRuntimeConfigStore } from '@recued/config';
import type { FreePoolEntry } from '@recued/llm';
import { createLLMConfigManager } from '../llm-config.js';
import { buildSchema, applyField, makeConfigHandlers } from '../config-schema.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
});

describe('buildSchema', () => {
  it('returns a non-empty schema with stable keys', () => {
    const llmManager = createLLMConfigManager(db);
    const schema = buildSchema({ llmManager });
    expect(schema.length).toBeGreaterThan(0);
    for (const f of schema) {
      expect(typeof f.key).toBe('string');
      expect(typeof f.label).toBe('string');
      expect(typeof f.section).toBe('string');
      expect(['boolean', 'number', 'string', 'enum']).toContain(f.type);
    }
  });

  it('surfaces the current LLM allow_upgrade_default value', () => {
    const llmManager = createLLMConfigManager(db);
    expect(buildSchema({ llmManager })
      .find((f) => f.key === 'llm.allow_upgrade_default')?.value)
      .toBe(false);

    llmManager.setAllowUpgradeDefault(true);
    expect(buildSchema({ llmManager })
      .find((f) => f.key === 'llm.allow_upgrade_default')?.value)
      .toBe(true);
  });

  it('surfaces the current free-pool strategy as an enum field', () => {
    const llmManager = createLLMConfigManager(db);
    const field = buildSchema({ llmManager })
      .find((f) => f.key === 'llm.free_pool_strategy');
    expect(field?.type).toBe('enum');
    expect(field?.enum).toEqual(['round_robin', 'weighted']);
  });

  it('surfaces the current daily budget as a non-negative number', () => {
    const llmManager = createLLMConfigManager(db);
    llmManager.setBudget(50_000);
    const field = buildSchema({ llmManager })
      .find((f) => f.key === 'llm.budget');
    expect(field?.type).toBe('number');
    expect(field?.value).toBe(50_000);
    expect(field?.min).toBe(0);
  });
});

describe('applyField', () => {
  it('routes llm.allow_upgrade_default → LLMConfigManager.setAllowUpgradeDefault', () => {
    const llmManager = createLLMConfigManager(db);
    applyField('llm.allow_upgrade_default', true, { llmManager });
    expect(llmManager.getAllowUpgradeDefault()).toBe(true);
    applyField('llm.allow_upgrade_default', false, { llmManager });
    expect(llmManager.getAllowUpgradeDefault()).toBe(false);
  });

  it('routes llm.free_pool_strategy with enum validation', () => {
    const llmManager = createLLMConfigManager(db);
    applyField('llm.free_pool_strategy', 'weighted', { llmManager });
    expect(llmManager.getPoolStrategy()).toBe('weighted');
    expect(() => applyField('llm.free_pool_strategy', 'priority', { llmManager }))
      .toThrow(/expects/);
  });

  it('routes llm.budget with non-negative-number validation', () => {
    const llmManager = createLLMConfigManager(db);
    applyField('llm.budget', 100_000, { llmManager });
    expect(llmManager.getBudget()).toBe(100_000);
    expect(() => applyField('llm.budget', -1, { llmManager })).toThrow(/non-negative/);
    expect(() => applyField('llm.budget', NaN, { llmManager })).toThrow(/non-negative/);
  });

  it('throws "expects boolean" when a non-boolean is passed to a boolean field', () => {
    const llmManager = createLLMConfigManager(db);
    expect(() => applyField('llm.allow_upgrade_default', 'true' as unknown as boolean, { llmManager }))
      .toThrow(/expects boolean/);
  });

  it('throws "Unknown config key" for an unregistered key', () => {
    const llmManager = createLLMConfigManager(db);
    expect(() => applyField('llm.nonexistent', 1, { llmManager }))
      .toThrow(/Unknown config key/);
  });
});

describe('buildSchema ∘ applyField round-trip', () => {
  it('applying every field then rebuilding reflects the writes', () => {
    const llmManager = createLLMConfigManager(db);
    applyField('llm.allow_upgrade_default', true, { llmManager });
    applyField('llm.free_pool_strategy', 'weighted', { llmManager });
    applyField('llm.budget', 42, { llmManager });

    const schema = buildSchema({ llmManager });
    const byKey = Object.fromEntries(schema.map((f) => [f.key, f.value]));
    expect(byKey['llm.allow_upgrade_default']).toBe(true);
    expect(byKey['llm.free_pool_strategy']).toBe('weighted');
    expect(byKey['llm.budget']).toBe(42);
  });
});

// ────────────────────────────────────────────────────────────────
// D-103 Phase A: runtime-config fields (vault quotas, log levels, etc.)
// ────────────────────────────────────────────────────────────────

describe('buildSchema — runtime config fields', () => {
  it('emits only LLM fields when no runtimeConfig is wired', () => {
    const llmManager = createLLMConfigManager(db);
    const schema = buildSchema({ llmManager });
    const keys = schema.map((f) => f.key);
    expect(keys).toContain('llm.allow_upgrade_default');
    expect(keys).not.toContain('vault.quota.per_publisher_bytes');
    expect(keys).not.toContain('log.level');
  });

  it('emits every non-LLM runtime key when runtimeConfig is wired', () => {
    const llmManager = createLLMConfigManager(db);
    const runtimeConfig = createRuntimeConfigStore({});
    const schema = buildSchema({ llmManager, runtimeConfig });
    const keys = schema.map((f) => f.key);
    expect(keys).toContain('vault.quota.per_publisher_bytes');
    expect(keys).toContain('vault.quota.total_bytes');
    expect(keys).toContain('data.shared.quota.bytes');
    expect(keys).toContain('log.level');
    expect(keys).toContain('public_port');
    expect(keys).toContain('scheduler.min_interval_minutes');
  });

  it('does NOT surface internal fields (network.apex_mode) to the generic schema (Codex R26.2 fold)', () => {
    const llmManager = createLLMConfigManager(db);
    const runtimeConfig = createRuntimeConfigStore({});
    const keys = buildSchema({ llmManager, runtimeConfig }).map((f) => f.key);
    expect(keys).not.toContain('network.apex_mode');
  });

  it('rejects a generic setConfigField write to an internal field, but the store still reads it (Codex R26.2 fold)', () => {
    const llmManager = createLLMConfigManager(db);
    const runtimeConfig = createRuntimeConfigStore({});
    // The generic setter must refuse — `exposure.set_apex` owns this key so its
    // cross-field consistency gate can't be bypassed.
    expect(() =>
      applyField('network.apex_mode', 'serve_reception', { llmManager, runtimeConfig }),
    ).toThrow(/not editable through setConfigField/);
    // The field still persists + reads via the store (default until set).
    expect(runtimeConfig.get('network.apex_mode')).toBe('redirect');
  });

  it('carries label / section / description / min / max / enum through', () => {
    const llmManager = createLLMConfigManager(db);
    const runtimeConfig = createRuntimeConfigStore({});
    const schema = buildSchema({ llmManager, runtimeConfig });

    const level = schema.find((f) => f.key === 'log.level');
    expect(level?.type).toBe('enum');
    expect(level?.enum).toEqual(['debug', 'info', 'warn', 'error']);
    expect(level?.section).toBe('Logging');
    expect(level?.label).toBe('Log level');
    expect(typeof level?.description).toBe('string');

    const reserve = schema.find((f) => f.key === 'storage.reserve_pct');
    expect(reserve?.min).toBe(0);
    expect(reserve?.max).toBe(100);

    const publicPort = schema.find((f) => f.key === 'public_port');
    expect(publicPort?.section).toBe('Network');
    expect(publicPort?.type).toBe('number');
    expect(publicPort?.min).toBe(1);
    expect(publicPort?.max).toBe(65535);
    expect(publicPort?.integer).toBe(true);
  });

  it('surfaces the runtimeConfig store value, not just the default', () => {
    const llmManager = createLLMConfigManager(db);
    const runtimeConfig = createRuntimeConfigStore({
      'vault.quota.per_publisher_bytes': 7 * 1024 * 1024,
      public_port: 8443,
    });
    const schema = buildSchema({ llmManager, runtimeConfig });
    const field = schema.find((f) => f.key === 'vault.quota.per_publisher_bytes');
    expect(field?.value).toBe(7 * 1024 * 1024);
    expect(schema.find((f) => f.key === 'public_port')?.value).toBe(8443);
  });
});

describe('applyField — runtime config fields', () => {
  it('routes non-LLM keys to the runtimeConfig store', () => {
    const llmManager = createLLMConfigManager(db);
    const runtimeConfig = createRuntimeConfigStore({});
    applyField('log.level', 'warn', { llmManager, runtimeConfig });
    expect(runtimeConfig.get('log.level')).toBe('warn');
  });

  it('applies a round-trip: set then observe via buildSchema', () => {
    const llmManager = createLLMConfigManager(db);
    const runtimeConfig = createRuntimeConfigStore({});
    applyField('scheduler.min_interval_minutes', 15, { llmManager, runtimeConfig });
    const schema = buildSchema({ llmManager, runtimeConfig });
    const field = schema.find((f) => f.key === 'scheduler.min_interval_minutes');
    expect(field?.value).toBe(15);
  });

  it('rejects an unknown runtime key with a descriptive error', () => {
    const llmManager = createLLMConfigManager(db);
    const runtimeConfig = createRuntimeConfigStore({});
    expect(() => applyField('recipe.nope', 1, { llmManager, runtimeConfig }))
      .toThrow(/Unknown runtime key/);
  });

  it('rejects a non-LLM write when no runtimeConfig is wired', () => {
    const llmManager = createLLMConfigManager(db);
    expect(() => applyField('log.level', 'warn', { llmManager }))
      .toThrow(/Unknown config key/);
  });

  it('propagates range errors from the runtime-config validator', () => {
    const llmManager = createLLMConfigManager(db);
    const runtimeConfig = createRuntimeConfigStore({});
    expect(() => applyField('storage.reserve_pct', 500, { llmManager, runtimeConfig }))
      .toThrow(/must be <= 100/);
    expect(() => applyField('public_port', 0, { llmManager, runtimeConfig }))
      .toThrow(/must be >= 1/);
    expect(() => applyField('public_port', 8443.5, { llmManager, runtimeConfig }))
      .toThrow(/must be an integer/);
  });
});

// ────────────────────────────────────────────────────────────────
// D-174 R28 — field-level LLM write handlers
// ────────────────────────────────────────────────────────────────

const SLOT: Record<string, unknown> = {
  provider: 'openai', model: 'gpt-4o', api_key: 'sk-a', speed: 'fast', supports_json: true,
};
const ENTRY = (id: string): Record<string, unknown> => ({
  id, type: 'api', provider: 'openai-compatible', model: 'llama', api_key: 'k',
  base_url: 'https://api.groq.com/openai/v1', speed: 'fast', supports_json: true, enabled: true,
});
const handlersFor = (llmManager: ReturnType<typeof createLLMConfigManager>) => {
  const slice = makeConfigHandlers(llmManager, undefined);
  if (!slice) throw new Error('expected a config handler slice');
  return slice.handlers;
};

describe('makeConfigHandlers — server.setLLMSlot', () => {
  it('writes one slot and reflects it in getConfig', async () => {
    const llmManager = createLLMConfigManager(db);
    const h = handlersFor(llmManager);
    await h['server.setLLMSlot']({ slot_key: 'slot_2', slot: SLOT }, undefined as never);
    expect(llmManager.getConfig().slot_2?.provider).toBe('openai');
    expect(llmManager.getConfig().slot_2?.model).toBe('gpt-4o');
  });

  it('does NOT clobber the other slot (the two-tab fix)', async () => {
    const llmManager = createLLMConfigManager(db);
    const h = handlersFor(llmManager);
    await h['server.setLLMSlot'](
      { slot_key: 'slot_1', slot: { ...SLOT, model: 'm1' } }, undefined as never);
    await h['server.setLLMSlot'](
      { slot_key: 'slot_2', slot: { ...SLOT, model: 'm2' } }, undefined as never);
    // Writing slot_2 left slot_1 intact — the whole-blob path would have
    // resent a stale slot_1.
    expect(llmManager.getConfig().slot_1?.model).toBe('m1');
    expect(llmManager.getConfig().slot_2?.model).toBe('m2');
  });

  it('clears a slot when slot is null', async () => {
    const llmManager = createLLMConfigManager(db);
    const h = handlersFor(llmManager);
    await h['server.setLLMSlot']({ slot_key: 'slot_1', slot: SLOT }, undefined as never);
    await h['server.setLLMSlot']({ slot_key: 'slot_1', slot: null }, undefined as never);
    expect(llmManager.getConfig().slot_1).toBeUndefined();
  });

  it('rejects an unknown slot_key with bad_request', async () => {
    const h = handlersFor(createLLMConfigManager(db));
    await expect(
      h['server.setLLMSlot']({ slot_key: 'slot_9' as 'slot_1', slot: SLOT }, undefined as never),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects an invalid slot shape with bad_request (parseLLMConfig)', async () => {
    const h = handlersFor(createLLMConfigManager(db));
    await expect(
      h['server.setLLMSlot']({ slot_key: 'slot_1', slot: { provider: 42 } }, undefined as never),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('makeConfigHandlers — server.setEmbeddingsSlot (D-174 R28 Slice C)', () => {
  const EMB: Record<string, unknown> = {
    provider: 'openai', model: 'text-embedding-3-small', api_key: 'sk-embed',
  };

  it('writes the embeddings slot (no slot_key) and reflects it in getConfig', async () => {
    const llmManager = createLLMConfigManager(db);
    const h = handlersFor(llmManager);
    await h['server.setEmbeddingsSlot']({ slot: EMB }, undefined as never);
    const cfg = llmManager.getConfig();
    expect(cfg.embeddings_slot?.model).toBe('text-embedding-3-small');
    // Kept out of the chat slot space.
    expect(cfg.slot_1).toBeUndefined();
    expect(cfg.slot_2).toBeUndefined();
  });

  it('does NOT clobber chat slots', async () => {
    const llmManager = createLLMConfigManager(db);
    const h = handlersFor(llmManager);
    await h['server.setLLMSlot']({ slot_key: 'slot_1', slot: SLOT }, undefined as never);
    await h['server.setEmbeddingsSlot']({ slot: EMB }, undefined as never);
    expect(llmManager.getConfig().slot_1?.model).toBe('gpt-4o');
    expect(llmManager.getConfig().embeddings_slot?.model).toBe('text-embedding-3-small');
  });

  it('clears the embeddings slot when slot is null', async () => {
    const llmManager = createLLMConfigManager(db);
    const h = handlersFor(llmManager);
    await h['server.setEmbeddingsSlot']({ slot: EMB }, undefined as never);
    await h['server.setEmbeddingsSlot']({ slot: null }, undefined as never);
    expect(llmManager.getConfig().embeddings_slot).toBeUndefined();
  });

  it('rejects an invalid embeddings slot shape with bad_request (parseLLMConfig)', async () => {
    const h = handlersFor(createLLMConfigManager(db));
    await expect(
      h['server.setEmbeddingsSlot']({ slot: { provider: 42 } as Record<string, unknown> }, undefined as never),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('redacts the embeddings slot api_key to has_key in getLLMConfig', async () => {
    const llmManager = createLLMConfigManager(db);
    const h = handlersFor(llmManager);
    await h['server.setEmbeddingsSlot']({ slot: EMB }, undefined as never);
    const res = await h['server.getLLMConfig'](undefined as never, undefined as never) as {
      config: Record<string, Record<string, unknown>>;
    };
    expect(res.config.embeddings_slot).toMatchObject({
      provider: 'openai', model: 'text-embedding-3-small', has_key: true,
    });
    expect(res.config.embeddings_slot.api_key).toBeUndefined();
  });

  it('preserves the stored key on a blank-key write-back (redacted round-trip)', async () => {
    const llmManager = createLLMConfigManager(db);
    const h = handlersFor(llmManager);
    await h['server.setEmbeddingsSlot']({ slot: EMB }, undefined as never);
    // Read redacted (has_key, no api_key), change the model, send back with a
    // blank key via the field-level setter.
    const read = await h['server.getLLMConfig'](undefined as never, undefined as never) as {
      config: Record<string, Record<string, unknown>>;
    };
    const back: Record<string, unknown> = { ...read.config.embeddings_slot, api_key: '', model: 'text-embedding-3-large' };
    delete back.has_key;
    await h['server.setEmbeddingsSlot']({ slot: back }, undefined as never);
    const cfg = llmManager.getConfig();
    expect(cfg.embeddings_slot?.api_key).toBe('sk-embed');
    expect(cfg.embeddings_slot?.model).toBe('text-embedding-3-large');
  });
});

describe('makeConfigHandlers — free-pool field-level handlers', () => {
  it('upsertFreePoolEntry adds an entry; rejects an invalid one', async () => {
    const llmManager = createLLMConfigManager(db);
    const h = handlersFor(llmManager);
    await h['server.upsertFreePoolEntry']({ entry: ENTRY('a1') }, undefined as never);
    expect(llmManager.getConfig().free_pool?.map((e) => e.id)).toEqual(['a1']);
    await expect(
      h['server.upsertFreePoolEntry']({ entry: { id: 'bad' } }, undefined as never),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('removeFreePoolEntry returns removed:true / removed:false', async () => {
    const llmManager = createLLMConfigManager(db);
    llmManager.setPool([ENTRY('a1'), ENTRY('a2')] as unknown as FreePoolEntry[]);
    const h = handlersFor(llmManager);
    await expect(
      h['server.removeFreePoolEntry']({ id: 'a1' }, undefined as never),
    ).resolves.toEqual({ ok: true, removed: true });
    await expect(
      h['server.removeFreePoolEntry']({ id: 'gone' }, undefined as never),
    ).resolves.toEqual({ ok: true, removed: false });
    expect(llmManager.getConfig().free_pool?.map((e) => e.id)).toEqual(['a2']);
  });

  it('removeFreePoolEntry rejects an empty id', async () => {
    const h = handlersFor(createLLMConfigManager(db));
    await expect(
      h['server.removeFreePoolEntry']({ id: '' }, undefined as never),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('setFreePoolEntryEnabled toggles; reports found; rejects non-boolean', async () => {
    const llmManager = createLLMConfigManager(db);
    llmManager.setPool([ENTRY('a1')] as unknown as FreePoolEntry[]);
    const h = handlersFor(llmManager);
    await expect(
      h['server.setFreePoolEntryEnabled']({ id: 'a1', enabled: false }, undefined as never),
    ).resolves.toEqual({ ok: true, found: true });
    expect(llmManager.getPool()[0]?.enabled).toBe(false);
    await expect(
      h['server.setFreePoolEntryEnabled']({ id: 'gone', enabled: false }, undefined as never),
    ).resolves.toEqual({ ok: true, found: false });
    await expect(
      h['server.setFreePoolEntryEnabled'](
        { id: 'a1', enabled: 'no' as unknown as boolean }, undefined as never),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  // codex R28 Slice D MED — a locked server must surface 423, not a
  // success-shaped no-op, from the pool mutators.
  it('removeFreePoolEntry on a LOCKED server rejects with locked (423)', async () => {
    const dek = new Uint8Array(randomBytes(32));
    createLLMConfigManager(db, { getEncryptionKey: () => dek })
      .setPool([ENTRY('a1')] as unknown as FreePoolEntry[]);
    const locked = createLLMConfigManager(db, { getEncryptionKey: () => null });
    const h = handlersFor(locked);
    await expect(
      h['server.removeFreePoolEntry']({ id: 'a1' }, undefined as never),
    ).rejects.toMatchObject({ code: 'locked' });
  });
});

describe('makeConfigHandlers — server.getLLMConfig api_key redaction (Slice B)', () => {
  it('strips every api_key off the wire, replacing it with has_key', async () => {
    const llmManager = createLLMConfigManager(db);
    llmManager.setSlot1({
      provider: 'openai', model: 'gpt-4o', api_key: 'sk-secret', speed: 'fast', supports_json: true,
    });
    llmManager.setPool([ENTRY('a1')] as unknown as FreePoolEntry[]);
    const h = handlersFor(llmManager);
    const res = await h['server.getLLMConfig'](undefined as never, undefined as never);
    const cfg = res.config as {
      slot_1?: Record<string, unknown>;
      free_pool?: Array<Record<string, unknown>>;
    };
    expect(cfg.slot_1).toMatchObject({ provider: 'openai', model: 'gpt-4o', has_key: true });
    expect(cfg.slot_1).not.toHaveProperty('api_key');
    expect(cfg.free_pool?.[0]).toMatchObject({ id: 'a1', has_key: true });
    expect(cfg.free_pool?.[0]).not.toHaveProperty('api_key');
    // The slot secret appears nowhere in the serialized wire payload.
    expect(JSON.stringify(res.config)).not.toContain('sk-secret');
  });

  it('setLLMConfig accepts a redacted get-payload written back (blank-key preserve)', async () => {
    const llmManager = createLLMConfigManager(db);
    llmManager.setSlot1({
      provider: 'openai', model: 'gpt-4o', api_key: 'sk-keep', speed: 'fast', supports_json: true,
    });
    const h = handlersFor(llmManager);
    // Read the redacted config (slot_1 has has_key, NO api_key), change a
    // non-secret field, and write the whole blob back — the stored key must
    // survive instead of failing validation.
    const read = await h['server.getLLMConfig'](undefined as never, undefined as never);
    const cfg = read.config as { slot_1: Record<string, unknown> };
    await h['server.setLLMConfig'](
      { config: { ...read.config, slot_1: { ...cfg.slot_1, model: 'gpt-4o-mini' } } },
      undefined as never,
    );
    expect(llmManager.getConfig().slot_1?.api_key).toBe('sk-keep');     // preserved
    expect(llmManager.getConfig().slot_1?.model).toBe('gpt-4o-mini');   // updated
  });
});

// ────────────────────────────────────────────────────────────────
// Lever-2 per-slot — server.setChatCatalogMode + catalog_modes wire
// ────────────────────────────────────────────────────────────────

describe('makeConfigHandlers — server.setChatCatalogMode', () => {
  it('writes one source mode and reflects it in getConfig', async () => {
    const llmManager = createLLMConfigManager(db);
    const h = handlersFor(llmManager);
    await h['server.setChatCatalogMode']({ source_id: 'free_pool', mode: 'index' }, undefined as never);
    expect(llmManager.getCatalogModes()).toEqual({ free_pool: 'index' });
    expect(llmManager.getConfig().catalog_modes).toEqual({ free_pool: 'index' });
  });

  it('does NOT clobber the other source (field-level write)', async () => {
    const llmManager = createLLMConfigManager(db);
    const h = handlersFor(llmManager);
    await h['server.setChatCatalogMode']({ source_id: 'slot_1', mode: 'full' }, undefined as never);
    await h['server.setChatCatalogMode']({ source_id: 'free_pool', mode: 'lean-core' }, undefined as never);
    expect(llmManager.getCatalogModes()).toEqual({ slot_1: 'full', free_pool: 'lean-core' });
  });

  it('clears just that source when mode is null', async () => {
    const llmManager = createLLMConfigManager(db);
    const h = handlersFor(llmManager);
    llmManager.setCatalogModes({ slot_1: 'index', free_pool: 'lean-core' });
    await h['server.setChatCatalogMode']({ source_id: 'slot_1', mode: null }, undefined as never);
    expect(llmManager.getCatalogModes()).toEqual({ free_pool: 'lean-core' });
  });

  it('rejects an unknown source_id with bad_request', async () => {
    const h = handlersFor(createLLMConfigManager(db));
    await expect(
      h['server.setChatCatalogMode'](
        { source_id: 'slot_9' as 'slot_1', mode: 'index' }, undefined as never),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects an invalid mode with bad_request', async () => {
    const h = handlersFor(createLLMConfigManager(db));
    await expect(
      h['server.setChatCatalogMode'](
        { source_id: 'slot_1', mode: 'thin' as 'index' }, undefined as never),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('makeConfigHandlers — catalog_modes through the whole-blob + redaction wire', () => {
  it('setLLMConfig carries catalog_modes (bulk/import path)', async () => {
    const llmManager = createLLMConfigManager(db);
    const h = handlersFor(llmManager);
    await h['server.setLLMConfig'](
      { config: { catalog_modes: { slot_1: 'index', free_pool: 'lean-core' } } },
      undefined as never,
    );
    expect(llmManager.getCatalogModes()).toEqual({ slot_1: 'index', free_pool: 'lean-core' });
  });

  it('getLLMConfig passes catalog_modes through unredacted (not a secret)', async () => {
    const llmManager = createLLMConfigManager(db);
    llmManager.setCatalogModes({ slot_2: 'index' });
    const h = handlersFor(llmManager);
    const res = await h['server.getLLMConfig'](undefined as never, undefined as never);
    expect((res.config as { catalog_modes?: unknown }).catalog_modes).toEqual({ slot_2: 'index' });
  });

  it('survives a redacted get→write-back round-trip intact', async () => {
    const llmManager = createLLMConfigManager(db);
    // A real slot (so the round-trip exercises the redaction fill path) + modes.
    llmManager.setSlot1({
      provider: 'openai', model: 'gpt-4o', api_key: 'sk-keep', speed: 'fast', supports_json: true,
    });
    llmManager.setCatalogModes({ slot_1: 'full', free_pool: 'index' });
    const h = handlersFor(llmManager);
    const read = await h['server.getLLMConfig'](undefined as never, undefined as never);
    // Write the redacted blob straight back (the webclient's whole-blob save path).
    await h['server.setLLMConfig']({ config: read.config }, undefined as never);
    expect(llmManager.getCatalogModes()).toEqual({ slot_1: 'full', free_pool: 'index' });
    // The blank-key preserve still held for the slot alongside catalog_modes.
    expect(llmManager.getConfig().slot_1?.api_key).toBe('sk-keep');
  });
});

describe('makeConfigHandlers — llm_gateway config through the whole-blob wire', () => {
  it('setLLMConfig persists route controls and explicit null clears them', async () => {
    const llmManager = createLLMConfigManager(db);
    const h = handlersFor(llmManager);

    await h['server.setLLMConfig'](
      {
        config: {
          llm_gateway_default_route: 'slot:slot_1',
          llm_gateway_model_alias: 'seller-primary',
        },
      },
      undefined as never,
    );
    expect(llmManager.getLlmGatewayDefaultRoute()).toBe('slot:slot_1');
    expect(llmManager.getLlmGatewayModelAlias()).toBe('seller-primary');

    await h['server.setLLMConfig'](
      {
        config: {
          llm_gateway_default_route: null,
          llm_gateway_model_alias: null,
        },
      },
      undefined as never,
    );
    expect(llmManager.getLlmGatewayDefaultRoute()).toBeUndefined();
    expect(llmManager.getLlmGatewayModelAlias()).toBeUndefined();
  });

  it('getLLMConfig passes route controls through unredacted', async () => {
    const llmManager = createLLMConfigManager(db);
    llmManager.setLlmGatewayDefaultRoute('pool');
    llmManager.setLlmGatewayModelAlias('seller-primary');
    const h = handlersFor(llmManager);

    const res = await h['server.getLLMConfig'](undefined as never, undefined as never);
    expect(res.config).toMatchObject({
      llm_gateway_default_route: 'pool',
      llm_gateway_model_alias: 'seller-primary',
    });
  });
});

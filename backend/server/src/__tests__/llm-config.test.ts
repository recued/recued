import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { createLLMConfigManager } from '../llm-config.js';
import type { FreePoolEntry, LLMSlot } from '@recued/llm';

const slot: LLMSlot = {
  provider: 'openai',
  model: 'gpt-4',
  api_key: 'sk-test',
  speed: 'quality',
  supports_json: true,
  supports_search: true,
};

const apiEntry = (id: string): FreePoolEntry => ({
  id,
  type: 'api',
  provider: 'openai-compatible',
  model: 'llama-3.3-70b',
  api_key: 'k',
  base_url: 'https://api.groq.com/openai/v1',
  speed: 'fast',
  supports_json: true,
  enabled: true,
});

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
});

describe('LLMConfigManager — slot capability fields round-trip', () => {
  it('persists speed / supports_json / supports_search', () => {
    const mgr = createLLMConfigManager(db);
    mgr.setSlot1(slot);
    const loaded = mgr.getConfig().slot_1;
    expect(loaded?.speed).toBe('quality');
    expect(loaded?.supports_json).toBe(true);
    expect(loaded?.supports_search).toBe(true);
  });

  it('persists context, output, and daily token limits and clears stale values', () => {
    const mgr = createLLMConfigManager(db);
    mgr.setSlot1({
      ...slot,
      context_window_tokens: 128_000,
      max_output_tokens: 8_192,
      daily_budget_tokens: 50_000,
    });
    expect(mgr.getConfig().slot_1).toMatchObject({
      context_window_tokens: 128_000,
      max_output_tokens: 8_192,
      daily_budget_tokens: 50_000,
    });

    mgr.setSlot1(slot);
    const cleared = mgr.getConfig().slot_1;
    expect(cleared?.context_window_tokens).toBeUndefined();
    expect(cleared?.max_output_tokens).toBeUndefined();
    expect(cleared?.daily_budget_tokens).toBeUndefined();
  });

  it('clears slot fields when slot is nulled', () => {
    const mgr = createLLMConfigManager(db);
    mgr.setSlot1(slot);
    mgr.setSlot1(null);
    expect(mgr.getConfig().slot_1).toBeUndefined();
  });

  it('persists provider_name, and a save without one clears it', () => {
    const mgr = createLLMConfigManager(db);
    mgr.setSlot2({ ...slot, provider: 'openai-compatible', provider_name: 'Groq', base_url: 'https://api.groq.com/openai/v1' });
    expect(mgr.getConfig().slot_2?.provider_name).toBe('Groq');
    expect(mgr.getConfig().slot_2?.provider).toBe('openai-compatible');

    mgr.setSlot2({ ...slot, provider: 'openai-compatible', base_url: 'https://api.groq.com/openai/v1' });
    expect(mgr.getConfig().slot_2).not.toHaveProperty('provider_name');
  });
});

describe('LLMConfigManager — embeddings slot (D-174 R28 Slice C)', () => {
  const embeddingsSlot: LLMSlot = {
    provider: 'openai',
    model: 'text-embedding-3-small',
    api_key: 'sk-embed',
  };

  it('setEmbeddingsSlot persists; getConfig returns it independently of slot_1', () => {
    const mgr = createLLMConfigManager(db);
    mgr.setSlot1(slot);
    mgr.setEmbeddingsSlot(embeddingsSlot);
    const cfg = mgr.getConfig();
    // The slot's `model` field IS the embeddings model.
    expect(cfg.embeddings_slot).toMatchObject({
      provider: 'openai',
      model: 'text-embedding-3-small',
      api_key: 'sk-embed',
    });
    expect(cfg.slot_1?.model).toBe('gpt-4');
  });

  it('a configured embeddings slot does NOT surface as slot_1 / slot_2', () => {
    const mgr = createLLMConfigManager(db);
    mgr.setEmbeddingsSlot(embeddingsSlot);
    const cfg = mgr.getConfig();
    expect(cfg.embeddings_slot).toBeDefined();
    expect(cfg.slot_1).toBeUndefined();
    expect(cfg.slot_2).toBeUndefined();
  });

  it('clears the embeddings slot when nulled, leaving chat slots intact', () => {
    const mgr = createLLMConfigManager(db);
    mgr.setSlot1(slot);
    mgr.setEmbeddingsSlot(embeddingsSlot);
    mgr.setEmbeddingsSlot(null);
    expect(mgr.getConfig().embeddings_slot).toBeUndefined();
    expect(mgr.getConfig().slot_1).toBeDefined();
  });

  it('blank api_key preserves the stored key (shared saveSlot blank-preserve)', () => {
    const mgr = createLLMConfigManager(db);
    mgr.setEmbeddingsSlot(embeddingsSlot);
    // Re-save with a blank key + new model, same provider → key preserved.
    mgr.setEmbeddingsSlot({ ...embeddingsSlot, api_key: '', model: 'text-embedding-3-large' });
    const cfg = mgr.getConfig();
    expect(cfg.embeddings_slot?.api_key).toBe('sk-embed');
    expect(cfg.embeddings_slot?.model).toBe('text-embedding-3-large');
  });
});

describe('LLMConfigManager — free pool CRUD', () => {
  it('setPool / getPool round-trips', () => {
    const mgr = createLLMConfigManager(db);
    const pool = [apiEntry('a1'), apiEntry('a2')];
    mgr.setPool(pool);
    expect(mgr.getPool()).toEqual(pool);
    expect(mgr.getConfig().free_pool).toEqual(pool);
  });

  it('empty pool clears storage', () => {
    const mgr = createLLMConfigManager(db);
    mgr.setPool([apiEntry('a1')]);
    expect(mgr.getPool().length).toBe(1);
    mgr.setPool([]);
    expect(mgr.getPool()).toEqual([]);
    expect(mgr.getConfig().free_pool).toBeUndefined();
  });

  it('strategy defaults to round_robin and persists non-defaults', () => {
    const mgr = createLLMConfigManager(db);
    expect(mgr.getPoolStrategy()).toBe('round_robin');
    mgr.setPoolStrategy('weighted');
    expect(mgr.getPoolStrategy()).toBe('weighted');
    expect(mgr.getConfig().free_pool_strategy).toBe('weighted');
    // reset to default → drops the row, not returned in config
    mgr.setPoolStrategy('round_robin');
    expect(mgr.getConfig().free_pool_strategy).toBeUndefined();
  });

  it('allow_upgrade_default stays false by default, persists when true', () => {
    const mgr = createLLMConfigManager(db);
    expect(mgr.getAllowUpgradeDefault()).toBe(false);
    mgr.setAllowUpgradeDefault(true);
    expect(mgr.getAllowUpgradeDefault()).toBe(true);
    expect(mgr.getConfig().allow_upgrade_default).toBe(true);
  });
});

describe('LLMConfigManager — Lever-2 per-slot catalog modes', () => {
  it('getCatalogModes is empty by default; getConfig omits the field', () => {
    const mgr = createLLMConfigManager(db);
    expect(mgr.getCatalogModes()).toEqual({});
    expect('catalog_modes' in mgr.getConfig()).toBe(false);
  });

  it('setCatalogModes round-trips and getConfig includes it when non-empty', () => {
    const mgr = createLLMConfigManager(db);
    mgr.setCatalogModes({ slot_1: 'full', free_pool: 'index' });
    expect(mgr.getCatalogModes()).toEqual({ slot_1: 'full', free_pool: 'index' });
    expect(mgr.getConfig().catalog_modes).toEqual({ slot_1: 'full', free_pool: 'index' });
  });

  it('setCatalogModes({}) clears the persisted row (getConfig omits it)', () => {
    const mgr = createLLMConfigManager(db);
    mgr.setCatalogModes({ slot_1: 'index' });
    mgr.setCatalogModes({});
    expect(mgr.getCatalogModes()).toEqual({});
    expect('catalog_modes' in mgr.getConfig()).toBe(false);
  });

  it('setCatalogMode sets one source without clobbering the others', () => {
    const mgr = createLLMConfigManager(db);
    mgr.setCatalogMode('slot_1', 'full');
    mgr.setCatalogMode('free_pool', 'lean-core');
    expect(mgr.getCatalogModes()).toEqual({ slot_1: 'full', free_pool: 'lean-core' });
    // Overwrite one; the other is untouched.
    mgr.setCatalogMode('slot_1', 'index');
    expect(mgr.getCatalogModes()).toEqual({ slot_1: 'index', free_pool: 'lean-core' });
  });

  it('setCatalogMode(source, null) clears just that source', () => {
    const mgr = createLLMConfigManager(db);
    mgr.setCatalogModes({ slot_1: 'index', slot_2: 'full', free_pool: 'lean-core' });
    mgr.setCatalogMode('slot_2', null);
    expect(mgr.getCatalogModes()).toEqual({ slot_1: 'index', free_pool: 'lean-core' });
    // Clearing the last remaining source deletes the row → getConfig omits it.
    mgr.setCatalogMode('slot_1', null);
    mgr.setCatalogMode('free_pool', null);
    expect(mgr.getCatalogModes()).toEqual({});
    expect('catalog_modes' in mgr.getConfig()).toBe(false);
  });

  it('persists across a fresh manager over the same db', () => {
    const mgr = createLLMConfigManager(db);
    mgr.setCatalogMode('free_pool', 'index');
    const reopened = createLLMConfigManager(db);
    expect(reopened.getCatalogModes()).toEqual({ free_pool: 'index' });
  });

  it('defensively drops a hand-edited bad key / mode from a raw row', () => {
    const mgr = createLLMConfigManager(db);
    // Simulate a hand-edited SQLite row carrying a junk key + a bad mode value
    // alongside a valid pair. The rpc validates on write, but a raw edit bypasses
    // that — getCatalogModes must not surface garbage to the orchestrator.
    db.prepare('INSERT OR REPLACE INTO llm_config (key, value) VALUES (?, ?)').run(
      'catalog_modes',
      JSON.stringify({ slot_1: 'index', slot_9: 'index', free_pool: 'bogus' }),
    );
    expect(mgr.getCatalogModes()).toEqual({ slot_1: 'index' });
  });

  it('treats a malformed (non-JSON / array) persisted row as unset', () => {
    const mgr = createLLMConfigManager(db);
    const write = (v: string): void => {
      db.prepare('INSERT OR REPLACE INTO llm_config (key, value) VALUES (?, ?)').run('catalog_modes', v);
    };
    write('not json{');
    expect(mgr.getCatalogModes()).toEqual({});
    write('[1,2,3]');
    expect(mgr.getCatalogModes()).toEqual({});
  });
});

describe('LLMConfigManager — pool usage tracking is RETIRED (D-262 follow-on)', () => {
  it('⛔ no longer exposes the per-entry usage trio, because nothing ever fed it', () => {
    // `addPoolUsage` / `getPoolUsage` / `isPoolEntryOverCap` persisted
    // `pool_usage.<entry>.<date>` rows and answered "is this entry over its
    // cap" — but NOTHING EVER CALLED the writer, in this tree or in any commit
    // since it was introduced. So the getter always read 0 and the cap check
    // always answered false.
    //
    // 🔑 The danger was the plausible NAME, not the dead code: someone wiring
    // `addPoolUsage` would have believed they were feeding pool-cap
    // enforcement, and the real path would have kept working and hidden it.
    const mgr = createLLMConfigManager(db) as unknown as Record<string, unknown>;
    expect(mgr.addPoolUsage).toBeUndefined();
    expect(mgr.getPoolUsage).toBeUndefined();
    expect(mgr.isPoolEntryOverCap).toBeUndefined();
  });

  it('⛔ and leaves no `pool_usage.` rows behind, because the writer never ran', () => {
    createLLMConfigManager(db);
    const rows = db
      .prepare(`SELECT COUNT(*) AS n FROM llm_config WHERE key LIKE 'pool_usage.%'`)
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it('🔑 the coverage MOVES: pool caps are enforced by the quota tracker', async () => {
    // The behaviour the retired trio appeared to provide is real — it just
    // lives elsewhere, and (since the snapshot became persistent) survives a
    // restart. Deleting the old tests without pinning this would have removed
    // the only place the product's actual cap behaviour was asserted here.
    const { createQuotaTracker } = await import('@recued/llm');
    const quota = createQuotaTracker();
    const entry = {
      id: 'a1', type: 'api' as const, provider: 'openai' as const, model: 'm',
      api_key: 'k', speed: 'fast' as const, supports_json: true, enabled: true,
      daily_cap_tokens: 1_000,
    };
    expect(quota.statusFor(entry).available).toBe(true);
    quota.recordUsage('a1', 1_000);
    expect(quota.statusFor(entry).available).toBe(false);
  });
});

describe('LLMConfigManager — encryption', () => {
  it('encrypted api_keys survive save/load round-trip', () => {
    const dek = new Uint8Array(randomBytes(32));
    const mgr = createLLMConfigManager(db, { getEncryptionKey: () => dek });
    mgr.setSlot1({
      provider: 'openai', model: 'gpt-4', api_key: 'sk-supersecret',
      speed: 'quality', supports_json: true,
    });
    // Raw stored value is ciphertext, not the plaintext key
    const raw = db.prepare('SELECT value FROM llm_config WHERE key = ?').get('slot_1.api_key') as { value: string };
    expect(raw.value).toMatch(/^enc:v1:/);
    expect(raw.value).not.toContain('sk-supersecret');
    // Manager returns the decrypted key
    expect(mgr.getConfig().slot_1?.api_key).toBe('sk-supersecret');
  });

  it('encrypts the whole pool blob (entries contain api_keys)', () => {
    const dek = new Uint8Array(randomBytes(32));
    const mgr = createLLMConfigManager(db, { getEncryptionKey: () => dek });
    mgr.setPool([apiEntry('a1')]);
    const raw = db.prepare('SELECT value FROM llm_config WHERE key = ?').get('pool') as { value: string };
    expect(raw.value).toMatch(/^enc:v1:/);
    // Roundtrips via the manager
    expect(mgr.getPool()[0]?.type).toBe('api');
    if (mgr.getPool()[0]?.type === 'api') {
      expect((mgr.getPool()[0] as { api_key: string }).api_key).toBe('k');
    }
  });

  it('writing a sensitive value on a LOCKED manager throws (never plaintext fallback)', () => {
    // Encryption-aware manager that reports a null DEK (server locked).
    // The critical invariant: when getKey is wired but returns null, we
    // must NOT fall back to plaintext — users expect encrypted storage.
    const mgr = createLLMConfigManager(db, { getEncryptionKey: () => null });
    expect(() =>
      mgr.setSlot1({
        provider: 'openai', model: 'gpt-4', api_key: 'sk-fresh',
        speed: 'fast', supports_json: true,
      }),
    ).toThrow(/locked/i);
    // Disk has no plaintext row for the api_key
    const raw = db.prepare('SELECT value FROM llm_config WHERE key = ?').get('slot_1.api_key');
    expect(raw).toBeUndefined();
  });

  it('writing the pool on a LOCKED manager throws (never plaintext fallback)', () => {
    const mgr = createLLMConfigManager(db, { getEncryptionKey: () => null });
    expect(() => mgr.setPool([apiEntry('a1')])).toThrow(/locked/i);
    const raw = db.prepare('SELECT value FROM llm_config WHERE key = ?').get('pool');
    expect(raw).toBeUndefined();
  });

  it('reading an encrypted key from a locked manager throws a clear error', () => {
    const dek = new Uint8Array(randomBytes(32));
    // First, write with encryption enabled
    const writer = createLLMConfigManager(db, { getEncryptionKey: () => dek });
    writer.setSlot1({
      provider: 'openai', model: 'gpt-4', api_key: 'sk-x',
      speed: 'quality', supports_json: true,
    });
    // Then, reader with a null-returning provider (locked state)
    const reader = createLLMConfigManager(db, { getEncryptionKey: () => null });
    expect(() => reader.getConfig()).toThrow(/locked/i);
  });

  it('reading a plaintext key works even when encryption provider is unset (legacy)', () => {
    // Ensure table exists before raw inserts
    createLLMConfigManager(db);
    // Simulate a pre-encryption row written directly to storage
    db.prepare('INSERT OR REPLACE INTO llm_config (key, value) VALUES (?, ?)').run('slot_1.provider', 'openai');
    db.prepare('INSERT OR REPLACE INTO llm_config (key, value) VALUES (?, ?)').run('slot_1.model', 'gpt-4');
    db.prepare('INSERT OR REPLACE INTO llm_config (key, value) VALUES (?, ?)').run('slot_1.api_key', 'legacy-plain');
    // Reader with no encryption provider at all
    const mgr = createLLMConfigManager(db);
    expect(mgr.getConfig().slot_1?.api_key).toBe('legacy-plain');
  });

  it('backward compat signature: createLLMConfigManager(db, envConfig) still works', () => {
    const env: LLMSlot = {
      provider: 'anthropic', model: 'claude', api_key: 'env-key',
    };
    const mgr = createLLMConfigManager(db, { slot_1: env });
    // envConfig wins over missing SQLite state
    expect(mgr.getConfig().slot_1?.api_key).toBe('env-key');
  });

  it('resetUsage prunes stale daily rows but keeps today', () => {
    // ⚠ D-262 follow-on — the `pool_usage` half of this went with the retired
    // trio: nothing can create such a row any more, so asserting it is pruned
    // asserted the behaviour of a prefix that cannot exist.
    const mgr = createLLMConfigManager(db);
    db.prepare('INSERT INTO llm_config (key, value) VALUES (?, ?)').run('usage.2020-01-01', '500');
    mgr.addUsage(100);
    expect(mgr.getUsage()).toBe(100);
    mgr.resetUsage();
    // Today's total preserved; the stale day gone.
    expect(mgr.getUsage()).toBe(100);
    const stale = db.prepare('SELECT value FROM llm_config WHERE key = ?').get('usage.2020-01-01');
    expect(stale).toBeUndefined();
  });

  it('⚠ resetUsage has NO CALLER, and that hold is now SETTLED, not pending', () => {
    // The surface it waited on shipped, and reports TODAY ONLY — so nothing
    // reads a past day's row, and those rows are the only record of past daily
    // spend there is. Wiring this would trade an irreversible loss of the sole
    // spend history for one small row per day of growth. The rows stay.
    //
    // ⚠ It is NOT a per-slot reset and NOT a counter reset: the live daily
    // counters clear in QuotaTracker.maybeReset at UTC midnight, chat /
    // embeddings / transcription alike.
    const mgr = createLLMConfigManager(db);
    expect(typeof mgr.resetUsage).toBe('function');
  });
});

/** ⛔ An entry saved with a blank id could not be removed, disabled, tested
 *  or edited: the rpcs refuse a blank id. The pool names one on read. */
describe('LLMConfigManager — a pool entry is never nameless', () => {
  it('names a stored blank-id entry from its address, clear of the names taken', () => {
    const mgr = createLLMConfigManager(db);
    mgr.setPool([
      { ...apiEntry(''), base_url: 'https://api.groq.com/openai/v1' },
      apiEntry('groq'),
      { ...apiEntry('  '), base_url: 'https://openrouter.ai/api/v1' },
    ]);
    expect(mgr.getPool().map((e) => e.id)).toEqual(['groq-2', 'groq', 'openrouter']);
    // The same pool reads with the same names, until a write stores them.
    expect(mgr.getConfig().free_pool?.map((e) => e.id)).toEqual(['groq-2', 'groq', 'openrouter']);
  });

  it('can remove and disable a repaired entry by its new name, and stores the names', () => {
    const mgr = createLLMConfigManager(db);
    mgr.setPool([
      { ...apiEntry(''), base_url: 'https://api.groq.com/openai/v1' },
      { ...apiEntry(''), base_url: 'https://api.mistral.ai/v1' },
    ]);
    expect(mgr.setPoolEntryEnabled('mistral', false)).toBe(true);
    // Stored now: a fresh manager over the same rows reads the same names.
    expect(createLLMConfigManager(db).getPool().map((e) => [e.id, e.enabled]))
      .toEqual([['groq', true], ['mistral', false]]);
    expect(mgr.removePoolEntry('groq')).toBe(true);
    expect(mgr.getPool().map((e) => e.id)).toEqual(['mistral']);
  });
});

/** An edit that leaves the key field blank keeps the stored key — by the rule
 *  a slot's save uses, so a key never follows its entry to a new address. */
describe('LLMConfigManager — upsertPoolEntry keeps a key only on its own endpoint', () => {
  it('keeps the stored key for a blank key on the same endpoint, and the entry\u2019s place', () => {
    const mgr = createLLMConfigManager(db);
    mgr.setPool([apiEntry('a1'), apiEntry('a2')]);
    expect(mgr.upsertPoolEntry({ ...apiEntry('a1'), api_key: '', model: 'llama-3.1-8b' }))
      .toBe('saved');
    const pool = mgr.getPool();
    expect(pool.map((e) => e.id)).toEqual(['a1', 'a2']);
    expect(pool[0]).toMatchObject({ model: 'llama-3.1-8b', api_key: 'k' });
  });

  it('refuses a blank key for a new entry or a changed endpoint, and writes nothing', () => {
    const mgr = createLLMConfigManager(db);
    mgr.setPool([apiEntry('a1')]);
    expect(mgr.upsertPoolEntry({ ...apiEntry('new'), api_key: '' })).toBe('key_required');
    expect(mgr.upsertPoolEntry({
      ...apiEntry('a1'), api_key: '', base_url: 'https://openrouter.ai/api/v1',
    })).toBe('key_required');
    expect(mgr.upsertPoolEntry({ ...apiEntry('a1'), api_key: '', provider: 'openai' }))
      .toBe('key_required');
    expect(mgr.getPool()).toEqual([apiEntry('a1')]);
  });

  it('writes a typed key, and adds a new entry at the end', () => {
    const mgr = createLLMConfigManager(db);
    mgr.setPool([apiEntry('a1')]);
    expect(mgr.upsertPoolEntry({ ...apiEntry('a1'), api_key: 'k2' })).toBe('saved');
    expect(mgr.upsertPoolEntry(apiEntry('a2'))).toBe('saved');
    expect(mgr.getPool().map((e) => [e.id, e.api_key])).toEqual([['a1', 'k2'], ['a2', 'k']]);
  });
});

describe('LLMConfigManager — D-174 R28 field-level pool writes', () => {
  it('upsertPoolEntry appends a new entry, preserving the others', () => {
    const mgr = createLLMConfigManager(db);
    mgr.setPool([apiEntry('a1'), apiEntry('a2')]);
    mgr.upsertPoolEntry(apiEntry('a3'));
    expect(mgr.getPool().map((e) => e.id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('upsertPoolEntry replaces an existing entry by id (no duplicate)', () => {
    const mgr = createLLMConfigManager(db);
    mgr.setPool([apiEntry('a1'), apiEntry('a2')]);
    mgr.upsertPoolEntry({ ...apiEntry('a1'), model: 'updated-model' });
    const pool = mgr.getPool();
    // In place: an edited entry keeps its place (and its row in Settings)
    // rather than moving to the end.
    expect(pool.map((e) => e.id)).toEqual(['a1', 'a2']);
    const a1 = pool.find((e) => e.id === 'a1');
    expect(a1?.type === 'api' && a1.model).toBe('updated-model');
  });

  it('removePoolEntry removes by id and returns true; preserves others', () => {
    const mgr = createLLMConfigManager(db);
    mgr.setPool([apiEntry('a1'), apiEntry('a2'), apiEntry('a3')]);
    expect(mgr.removePoolEntry('a2')).toBe(true);
    expect(mgr.getPool().map((e) => e.id)).toEqual(['a1', 'a3']);
  });

  it('removePoolEntry returns false for an absent id (no-op)', () => {
    const mgr = createLLMConfigManager(db);
    mgr.setPool([apiEntry('a1')]);
    expect(mgr.removePoolEntry('nope')).toBe(false);
    expect(mgr.getPool().map((e) => e.id)).toEqual(['a1']);
  });

  it('setPoolEntryEnabled toggles one entry by id and returns true; leaves others', () => {
    const mgr = createLLMConfigManager(db);
    mgr.setPool([apiEntry('a1'), apiEntry('a2')]);
    expect(mgr.setPoolEntryEnabled('a1', false)).toBe(true);
    const pool = mgr.getPool();
    expect(pool.find((e) => e.id === 'a1')?.enabled).toBe(false);
    expect(pool.find((e) => e.id === 'a2')?.enabled).toBe(true);
  });

  it('setPoolEntryEnabled returns false for an absent id (no-op)', () => {
    const mgr = createLLMConfigManager(db);
    mgr.setPool([apiEntry('a1')]);
    expect(mgr.setPoolEntryEnabled('nope', false)).toBe(false);
    expect(mgr.getPool()[0]?.enabled).toBe(true);
  });

  it('a different-entry edit does not clobber a concurrent different-entry edit', () => {
    // The clobber Slice D fixes: two surfaces each running a single-entry
    // read-modify-write against the same pool. Because each op re-reads the
    // current pool and writes back synchronously, both edits survive (vs the
    // whole-blob setLLMConfig where the second writer's stale blob wins).
    const mgr = createLLMConfigManager(db);
    mgr.setPool([apiEntry('a1'), apiEntry('a2')]);
    mgr.setPoolEntryEnabled('a1', false); // "tab A"
    mgr.removePoolEntry('a2');            // "tab B"
    const pool = mgr.getPool();
    expect(pool.map((e) => e.id)).toEqual(['a1']);
    expect(pool[0]?.enabled).toBe(false); // tab A's edit survived tab B's
  });

  // codex R28 Slice D MED — a locked server must FAIL the mutating ops
  // (423), not silently no-op by treating the unreadable pool as empty.
  it('mutating ops on a LOCKED manager throw rather than silently no-op', () => {
    const dek = new Uint8Array(randomBytes(32));
    const writer = createLLMConfigManager(db, { getEncryptionKey: () => dek });
    writer.setPool([apiEntry('a1'), apiEntry('a2')]);
    const locked = createLLMConfigManager(db, { getEncryptionKey: () => null });
    expect(() => locked.removePoolEntry('a1')).toThrow(/locked/i);
    expect(() => locked.setPoolEntryEnabled('a1', false)).toThrow(/locked/i);
    expect(() => locked.upsertPoolEntry(apiEntry('a3'))).toThrow(/locked/i);
    // The encrypted pool is untouched — a reader with the DEK still sees both.
    const reader = createLLMConfigManager(db, { getEncryptionKey: () => dek });
    expect(reader.getPool().map((e) => e.id)).toEqual(['a1', 'a2']);
  });
});

describe('LLMConfigManager — D-196 llm_gateway route controls', () => {
  it('persists default route and model alias across manager instances', () => {
    const mgr = createLLMConfigManager(db);
    mgr.setSlot1(slot);
    mgr.setLlmGatewayDefaultRoute('slot:slot_1');
    mgr.setLlmGatewayModelAlias('seller-primary');

    const reopened = createLLMConfigManager(db);
    expect(reopened.getLlmGatewayDefaultRoute()).toBe('slot:slot_1');
    expect(reopened.getLlmGatewayModelAlias()).toBe('seller-primary');
    expect(reopened.getConfig()).toMatchObject({
      llm_gateway_default_route: 'slot:slot_1',
      llm_gateway_model_alias: 'seller-primary',
    });
  });

  it('clears route with null and clears alias with blank input', () => {
    const mgr = createLLMConfigManager(db);
    mgr.setLlmGatewayDefaultRoute('pool');
    mgr.setLlmGatewayModelAlias('seller-primary');

    mgr.setLlmGatewayDefaultRoute(null);
    mgr.setLlmGatewayModelAlias('   ');

    expect(mgr.getLlmGatewayDefaultRoute()).toBeUndefined();
    expect(mgr.getLlmGatewayModelAlias()).toBeUndefined();
    expect('llm_gateway_default_route' in mgr.getConfig()).toBe(false);
    expect('llm_gateway_model_alias' in mgr.getConfig()).toBe(false);
  });

  it('rejects invalid route writes and ignores malformed raw rows on read', () => {
    const mgr = createLLMConfigManager(db);
    expect(() => mgr.setLlmGatewayDefaultRoute('slot:slot_3' as never))
      .toThrow(/llm_gateway\.default_route invalid/);

    db.prepare('INSERT OR REPLACE INTO llm_config (key, value) VALUES (?, ?)')
      .run('llm_gateway.default_route', 'slot:slot_9');
    expect(mgr.getLlmGatewayDefaultRoute()).toBeUndefined();
    expect('llm_gateway_default_route' in mgr.getConfig()).toBe(false);
  });
});

describe('LLMConfigManager — Slice B blank-api_key preserve', () => {
  const byok = (over: Partial<LLMSlot> = {}): LLMSlot => ({
    provider: 'openai', model: 'm1', api_key: 'k1', speed: 'fast', supports_json: true, ...over,
  });

  it('a blank api_key with UNCHANGED provider + base_url preserves the stored key', () => {
    const mgr = createLLMConfigManager(db);
    mgr.setSlot1(byok({ api_key: 'k1' }));
    mgr.setSlot1(byok({ api_key: '', model: 'm2' })); // blank key, same provider, new model
    expect(mgr.getConfig().slot_1?.api_key).toBe('k1'); // preserved
    expect(mgr.getConfig().slot_1?.model).toBe('m2');   // metadata still updated
  });

  it('a blank api_key with a CHANGED provider drops the key (no stale credential)', () => {
    const mgr = createLLMConfigManager(db);
    mgr.setSlot1(byok({ provider: 'openai', api_key: 'k1' }));
    mgr.setSlot1(byok({ provider: 'anthropic', api_key: '' }));
    // keyless slot → loadSlot drops it rather than attach k1 to anthropic.
    expect(mgr.getConfig().slot_1).toBeUndefined();
  });

  it('a blank api_key with a CHANGED base_url drops the key', () => {
    const mgr = createLLMConfigManager(db);
    mgr.setSlot1(byok({ provider: 'openai-compatible', base_url: 'http://a/v1', api_key: 'k1' }));
    mgr.setSlot1(byok({ provider: 'openai-compatible', base_url: 'http://b/v1', api_key: '' }));
    expect(mgr.getConfig().slot_1).toBeUndefined();
  });

  /** The name is a label for the owner, not where the key goes: renaming a
   *  slot must not cost its key, and must not be what decides it either. */
  it('a blank api_key with only the NAME changed preserves the stored key', () => {
    const mgr = createLLMConfigManager(db);
    mgr.setSlot1(byok({ provider: 'openai-compatible', base_url: 'http://a/v1', provider_name: 'Groq', api_key: 'k1' }));
    mgr.setSlot1(byok({ provider: 'openai-compatible', base_url: 'http://a/v1', provider_name: 'Groq (work)', api_key: '' }));
    expect(mgr.getConfig().slot_1?.api_key).toBe('k1');
    expect(mgr.getConfig().slot_1?.provider_name).toBe('Groq (work)');
  });

  it('a kept NAME does not carry the key to a changed base_url', () => {
    const mgr = createLLMConfigManager(db);
    mgr.setSlot1(byok({ provider: 'openai-compatible', base_url: 'http://a/v1', provider_name: 'Groq', api_key: 'k1' }));
    mgr.setSlot1(byok({ provider: 'openai-compatible', base_url: 'http://b/v1', provider_name: 'Groq', api_key: '' }));
    expect(mgr.getConfig().slot_1).toBeUndefined();
  });

  it('a non-empty api_key overwrites the stored key', () => {
    const mgr = createLLMConfigManager(db);
    mgr.setSlot1(byok({ api_key: 'k1' }));
    mgr.setSlot1(byok({ api_key: 'k2' }));
    expect(mgr.getConfig().slot_1?.api_key).toBe('k2');
  });

  it('blank-preserve keeps an ENCRYPTED key decryptable', () => {
    const dek = new Uint8Array(randomBytes(32));
    const mgr = createLLMConfigManager(db, { getEncryptionKey: () => dek });
    mgr.setSlot1(byok({ api_key: 'sk-enc' }));
    mgr.setSlot1(byok({ api_key: '', model: 'm2' }));
    expect(mgr.getConfig().slot_1?.api_key).toBe('sk-enc');
  });
});

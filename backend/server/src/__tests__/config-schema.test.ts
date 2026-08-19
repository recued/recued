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
import type { FreePoolEntry, LLMSlot } from '@recued/llm';
import { resetEndpointCapabilities } from '@recued/llm';
import { createLLMConfigManager } from '../llm-config.js';
import { buildSchema, applyField, makeConfigHandlers } from '../config-schema.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  // The endpoint-capability memories are process-global by design (a rejection
  // is paid once per endpoint, not once per call), so they leak between cases
  // — a probe that learned "no JSON mode" here would silently change what the
  // next case's probe sends.
  resetEndpointCapabilities();
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
const ENTRY = (
  id: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id, type: 'api', provider: 'openai-compatible', model: 'llama', api_key: 'k',
  base_url: 'https://api.groq.com/openai/v1', speed: 'fast', supports_json: true, enabled: true,
  ...over,
});
const handlersFor = (
  llmManager: ReturnType<typeof createLLMConfigManager>,
  probe?: Parameters<typeof makeConfigHandlers>[2],
) => {
  const slice = makeConfigHandlers(llmManager, undefined, probe);
  if (!slice) throw new Error('expected a config handler slice');
  return slice.handlers;
};

/** A probe wiring whose adapter records what it was asked to send. */
const probeDeps = (
  complete: (messages: Array<{ role: string }>) => unknown = () => ({
    text: 'ok',
    usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5, model_id: 'm' },
  }),
) => {
  const seen: Array<{ slot: LLMSlot; roles: string[] }> = [];
  const usage: Array<[string, number]> = [];
  const embedSeen: LLMSlot[] = [];
  const deps = {
    embeddingsAdapters: ((key: string) => {
      // ⚠ The embeddings registry THROWS for an unregistered provider where
      // the chat one returns undefined — mirrored here, or the test double
      // hides the branch the real handler has to survive.
      if (key === 'anthropic') {
        throw new Error('No embeddings adapter registered for: anthropic');
      }
      return {
        provider: key,
        embed: async (slot: LLMSlot) => {
          embedSeen.push(slot);
          return {
            vector: new Array(1536).fill(0.1),
            model: slot.model,
            usage: { input_tokens: 3, output_tokens: 0, total_tokens: 3, model_id: slot.model },
          };
        },
      };
    }) as never,
    adapters: ((key: string) => (key === 'nope' ? undefined : {
      provider: key,
      complete: async (slot: LLMSlot, messages: Array<{ role: string }>) => {
        seen.push({ slot, roles: messages.map((m) => m.role) });
        return complete(messages);
      },
    })) as never,
    quota: {
      registerRequest: () => {},
      recordUsage: (id: string, tokens: number) => { usage.push([id, tokens]); },
    } as never,
  };
  return { deps, seen, usage, embedSeen };
};

/** Test connection — the JOIN.
 *
 *  `probe.test.ts` proves the probe reports correctly when something calls it;
 *  these prove the rpc calls it, with the RIGHT slot. The draft/blank-key rules
 *  are the part worth pinning: the webclient never receives a stored API key
 *  (it is redacted to `has_key`), so "test before saving" has to reconstruct
 *  the credential the same way a save would — or it reports a verdict for a
 *  configuration that will never exist. */
describe('makeConfigHandlers — server.probeLlmSource', () => {
  it('probes the SAVED slot when no draft is supplied', async () => {
    const llmManager = createLLMConfigManager(db);
    const { deps, seen } = probeDeps();
    const h = handlersFor(llmManager, deps);
    await h['server.setLLMSlot']({ slot_key: 'slot_1', slot: SLOT }, undefined as never);

    const result = await h['server.probeLlmSource'](
      { target: { kind: 'slot', slot_key: 'slot_1' } }, undefined as never);

    expect(result.ok).toBe(true);
    expect(result.diagnosis).toBe('ok');
    expect(seen[0]?.slot.api_key).toBe('sk-a');
    expect(seen[0]?.slot.model).toBe('gpt-4o');
    // The system role goes out first — the probe uses the real call path.
    expect(seen[0]?.roles).toEqual(['system', 'user']);
  });

  it('meters the probe like any other call', async () => {
    const llmManager = createLLMConfigManager(db);
    const { deps, usage } = probeDeps();
    const h = handlersFor(llmManager, deps);
    await h['server.setLLMSlot']({ slot_key: 'slot_2', slot: SLOT }, undefined as never);
    await h['server.probeLlmSource'](
      { target: { kind: 'slot', slot_key: 'slot_2' } }, undefined as never);
    // A probe that skipped the tracker would be an unmetered hole in the daily
    // budget — one the owner can pull on demand, from a button.
    expect(usage).toEqual([['slot_2', 5]]);
  });

  /** ⛔ THE DRAFT RULE. A blank key means "keep the stored one" — but only
   *  while provider + base_url are unchanged, exactly as `setLLMSlot` decides
   *  it. Probing a NEW endpoint with the previous provider's key would report
   *  on a configuration that will never exist. */
  it('resolves a blank draft key against the stored one, and only in context', async () => {
    const llmManager = createLLMConfigManager(db);
    const { deps, seen } = probeDeps();
    const h = handlersFor(llmManager, deps);
    await h['server.setLLMSlot']({ slot_key: 'slot_1', slot: SLOT }, undefined as never);

    // Same provider, new model, blank key → the stored key carries over.
    await h['server.probeLlmSource'](
      {
        target: { kind: 'slot', slot_key: 'slot_1' },
        draft: { provider: 'openai', model: 'gpt-4o-mini' },
      },
      undefined as never,
    );
    expect(seen[0]?.slot.api_key).toBe('sk-a');
    expect(seen[0]?.slot.model).toBe('gpt-4o-mini');

    // Changed provider, blank key → the old key must NOT follow it.
    const changed = await h['server.probeLlmSource'](
      {
        target: { kind: 'slot', slot_key: 'slot_1' },
        draft: {
          provider: 'openai-compatible', model: 'llama', base_url: 'http://x',
        },
      },
      undefined as never,
    );
    expect(changed.ok).toBe(false);
    expect(changed.diagnosis).toBe('auth');
    expect(seen).toHaveLength(1);
  });

  it('answers auth without a request when no key is stored at all', async () => {
    const llmManager = createLLMConfigManager(db);
    const { deps, seen } = probeDeps();
    const h = handlersFor(llmManager, deps);
    const result = await h['server.probeLlmSource'](
      {
        target: { kind: 'slot', slot_key: 'slot_1' },
        draft: { provider: 'openai', model: 'gpt-4o' },
      },
      undefined as never,
    );
    // Not a provider failure — but it IS the answer, and it names the field.
    expect(result.diagnosis).toBe('auth');
    expect(result.detail).toMatch(/No API key/i);
    expect(seen).toHaveLength(0);
  });

  /** ⛔ NOT the chat probe pointed at another slot. Embeddings is `embed` vs
   *  `complete`, its own adapter registry, and none of the chat capability
   *  questions apply. Sending a chat completion to an embeddings model would
   *  report its 404 as a missing model — true, and useless. */
  it('probes the embeddings slot with an EMBEDDINGS call', async () => {
    const llmManager = createLLMConfigManager(db);
    const { deps, seen, embedSeen } = probeDeps();
    const h = handlersFor(llmManager, deps);
    await h['server.setEmbeddingsSlot'](
      { slot: { ...SLOT, model: 'text-embedding-3-small' } }, undefined as never);

    const result = await h['server.probeLlmSource'](
      { target: { kind: 'slot', slot_key: 'embeddings_slot' } }, undefined as never);

    expect(result.ok).toBe(true);
    // The vector width is the fact an owner actually needs: a model quietly
    // serving 768-d where they expected 1536-d is a working connection that
    // produces unusable neighbours.
    expect(result.dimensions).toBe(1536);
    expect(embedSeen[0]?.model).toBe('text-embedding-3-small');
    // …and NOT through the chat registry.
    expect(seen).toHaveLength(0);
    // No chat capability claims — there is no system message or JSON mode here.
    expect(result.accepts_system_role).toBeUndefined();
    expect(result.supports_json).toBeUndefined();
  });

  it('turns an unregistered embeddings provider into a verdict, not a crash', async () => {
    const llmManager = createLLMConfigManager(db);
    const { deps } = probeDeps();
    const h = handlersFor(llmManager, deps);
    await h['server.setEmbeddingsSlot'](
      { slot: { ...SLOT, provider: 'anthropic', model: 'nope' } }, undefined as never);

    // Anthropic publishes no embeddings model, and the registry THROWS rather
    // than returning undefined — it has to land as a readable result.
    const result = await h['server.probeLlmSource'](
      { target: { kind: 'slot', slot_key: 'embeddings_slot' } }, undefined as never);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/embeddings adapter/i);
  });

  it('probes one free-pool entry by id, with that entry credential', async () => {
    const llmManager = createLLMConfigManager(db);
    const { deps, seen, usage } = probeDeps();
    const h = handlersFor(llmManager, deps);
    await h['server.upsertFreePoolEntry'](
      { entry: ENTRY('groq-a', { model: 'llama-8b', api_key: 'k-a' }) as never },
      undefined as never,
    );
    await h['server.upsertFreePoolEntry'](
      { entry: ENTRY('groq-b', { model: 'llama-70b', api_key: 'k-b' }) as never },
      undefined as never,
    );

    const result = await h['server.probeLlmSource'](
      { target: { kind: 'pool_entry', entry_id: 'groq-b' } }, undefined as never);

    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    // ⛔ The entries differ in exactly these fields on purpose. Identical
    // fixtures would make a wrong-row lookup send a byte-identical request,
    // and this assertion would pass on a broken lookup.
    expect(seen[0]?.slot.api_key).toBe('k-b');
    expect(seen[0]?.slot.model).toBe('llama-70b');
    // Metered against THAT entry, not the pool as a whole — the daily caps are
    // per-entry.
    expect(usage).toEqual([['pool:groq-b', 5]]);
  });

  it('answers for a pool id that does not exist instead of probing something else', async () => {
    const llmManager = createLLMConfigManager(db);
    const { deps, seen } = probeDeps();
    const h = handlersFor(llmManager, deps);
    const result = await h['server.probeLlmSource'](
      { target: { kind: 'pool_entry', entry_id: 'ghost' } }, undefined as never);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/ghost/);
    expect(seen).toHaveLength(0);
  });

  it('rejects an unknown target kind with bad_request', async () => {
    const { deps } = probeDeps();
    const h = handlersFor(createLLMConfigManager(db), deps);
    await expect(
      h['server.probeLlmSource'](
        { target: { kind: 'whatever' } as never }, undefined as never),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('answers unavailable rather than pretending, when unwired', async () => {
    const h = handlersFor(createLLMConfigManager(db));
    await expect(
      h['server.probeLlmSource']({ target: { kind: 'slot', slot_key: 'slot_1' } }, undefined as never),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('rejects an unknown slot_key with bad_request', async () => {
    const { deps } = probeDeps();
    const h = handlersFor(createLLMConfigManager(db), deps);
    await expect(
      h['server.probeLlmSource'](
        { target: { kind: 'slot', slot_key: 'slot_9' as 'slot_1' } },
        undefined as never,
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });
});

/** D-208 follow-on — DETECTED capabilities live on the source.
 *
 *  🔑 This was a side blob keyed by a content fingerprint. The fingerprint
 *  existed to auto-invalidate when provider/base_url/model change — but a
 *  SOURCE EDIT is that moment and the save path already runs then, so the
 *  content-addressing layer bought what the write path already knew, and
 *  brought orphan rows, a prune, and a resurrect-on-restart bug with it.
 *
 *  ⛔ Still not `supports_json`: that is a MATCH input (`match.ts:121`), so a
 *  detected value there would make a source unroutable rather than degraded. */
describe('detected endpoint capabilities live on the source', () => {
  it('writes a slot observation onto that slot', () => {
    const m = createLLMConfigManager(db);
    m.setSlot1({
      provider: 'openai-compatible', model: 'llama', api_key: 'k',
      speed: 'fast', supports_json: true,
    });
    m.setSourceCapability(
      { kind: 'slot', slot_key: 'slot_1' },
      { system_role_ok: false, native_json_ok: true },
    );

    const reread = createLLMConfigManager(db).getConfig();
    expect(reread.slot_1?.system_role_ok).toBe(false);
    // Absent means "not yet known", which reads as yes — writing `true`
    // everywhere would double the config to record the default.
    expect(reread.slot_1?.native_json_ok).toBeUndefined();
    // ⛔ And the ROUTING field is untouched.
    expect(reread.slot_1?.supports_json).toBe(true);
  });

  it('writes a pool observation onto that entry, leaving its siblings alone', () => {
    const m = createLLMConfigManager(db);
    m.setPool([
      ENTRY('groq-a', { model: 'llama-8b' }) as never,
      ENTRY('groq-b', { model: 'llama-70b' }) as never,
    ]);
    m.setSourceCapability({ kind: 'pool', entry_id: 'groq-b' }, { system_role_ok: false });

    const pool = createLLMConfigManager(db).getConfig().free_pool ?? [];
    expect(pool.find((e) => e.id === 'groq-b')?.system_role_ok).toBe(false);
    expect(pool.find((e) => e.id === 'groq-a')?.system_role_ok).toBeUndefined();
  });

  /** ⛔ THE ORPHAN CASE THE BLOB HAD TO PRUNE FOR. Here it needs no pruning:
   *  a removed source cannot be written to, so the observation is simply
   *  dropped rather than left behind to be resurrected later. */
  it('drops an observation for a source that was removed mid-flight', () => {
    // ⚠ KEYED on purpose. Without a DEK the manager stores `setSensitive`
    // values as PLAINTEXT, so a redundant rewrite is byte-identical and the
    // raw-row assertion below passes whether or not the write happened — which
    // is exactly how it was vacuous the first two times. Encryption is what
    // makes a needless write visible: a fresh IV per write.
    const dek = new Uint8Array(randomBytes(32));
    const m = createLLMConfigManager(db, { getEncryptionKey: () => dek });
    m.setPool([ENTRY('groq-a') as never]);
    const rawBefore = db
      .prepare("SELECT value FROM llm_config WHERE key = 'pool'")
      .get() as { value: string };

    expect(() => m.setSourceCapability(
      { kind: 'pool', entry_id: 'gone' }, { system_role_ok: false },
    )).not.toThrow();

    const pool = createLLMConfigManager(db, { getEncryptionKey: () => dek })
      .getConfig().free_pool ?? [];
    expect(pool).toHaveLength(1);
    expect(pool[0]?.id).toBe('groq-a');
    // ⚠ Asserted on the RAW ROW, not the parsed pool. The pool contains api
    // keys and is stored `setSensitive`, so a rewrite re-encrypts under a fresh
    // IV — identical plaintext, different bytes. Comparing the parsed value
    // would pass whether or not the needless write happened, which is exactly
    // how this assertion was vacuous the first time.
    const rawAfter = db
      .prepare("SELECT value FROM llm_config WHERE key = 'pool'")
      .get() as { value: string };
    expect(rawAfter.value).toBe(rawBefore.value);
  });

  /** …and this is the invalidation the fingerprint was built to provide, which
   *  the save path was always going to do anyway. */
  it('clears a stale observation when the slot is re-saved', () => {
    const m = createLLMConfigManager(db);
    m.setSlot1({
      provider: 'openai-compatible', model: 'llama', api_key: 'k',
      speed: 'fast', supports_json: true,
    });
    m.setSourceCapability({ kind: 'slot', slot_key: 'slot_1' }, { system_role_ok: false });
    expect(createLLMConfigManager(db).getConfig().slot_1?.system_role_ok).toBe(false);

    // The owner points the slot at a different model — everything observed
    // about the old one is now a guess about an endpoint nobody asked about.
    m.setSlot1({
      provider: 'openai-compatible', model: 'other-model', api_key: 'k',
      speed: 'fast', supports_json: true,
    });
    expect(createLLMConfigManager(db).getConfig().slot_1?.system_role_ok)
      .toBeUndefined();
  });
});

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

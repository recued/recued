/** Test connection proves a model can see pictures, and the proof outlives the
 *  process — through the server's REAL composition root.
 *
 *  ⛔ The halves are pinned elsewhere: the probe reaches a verdict
 *  (`packages/llm/.../probe.test.ts`), the memory announces only verdicts
 *  (`endpoint-capabilities.test.ts`), and the config manager stores and keeps a
 *  proof (`config-schema.test.ts`). None of them sees the seam that matters to
 *  an owner: `composeLlmSubstrate` registers the listener that turns a verdict
 *  into a stored `image_input_ok`, and hydrates it back at boot. A listener that
 *  dropped the field would leave every half green while a restart quietly
 *  switched off every camera check. So this composes the substrate for real,
 *  presses Test through the real handler, and reads the stored source back. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  completeWithFallbacks,
  imageInputSeen,
  onEndpointCapabilityLearned,
  resetEndpointCapabilities,
  classifyProviderError,
  type LLMMessage,
  type LLMSlot,
} from '@recued/llm';

import { composeLlmSubstrate } from '../composition/bin/wire-llm-substrate.js';
import { makeConfigHandlers } from '../config-schema.js';
import { createLLMConfigManager } from '../llm-config.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  resetEndpointCapabilities();
});
afterEach(() => {
  onEndpointCapabilityLearned(undefined);
  resetEndpointCapabilities();
});

const QWEN: LLMSlot = {
  provider: 'openai-compatible', model: 'qwen-vl', api_key: 'k',
  base_url: 'https://dashscope.example/v1', speed: 'fast', supports_json: true,
};

const USAGE = { input_tokens: 4, output_tokens: 1, total_tokens: 5, model_id: 'm' };
const carriesPicture = (messages: LLMMessage[]): boolean =>
  messages.some((m) => (m.content_parts ?? []).some((p) => p.type === 'image'));

/** Press Test connection on `target` through the real handler, with a model
 *  that answers the picture with `pictureAnswer`. */
const pressTest = async (
  manager: NonNullable<ReturnType<typeof composeLlmSubstrate>['llmManager']>,
  target: { kind: 'slot'; slot_key: 'slot_1' } | { kind: 'pool_entry'; entry_id: string },
  pictureAnswer: string,
) => {
  const slice = makeConfigHandlers(manager, undefined, {
    adapters: (() => ({
      provider: 'openai-compatible',
      complete: async (_slot: LLMSlot, messages: LLMMessage[]) => ({
        text: carriesPicture(messages) ? pictureAnswer : 'ok', usage: USAGE,
      }),
    })) as never,
    quota: { registerRequest: () => {}, recordUsage: () => {} } as never,
  });
  if (!slice) throw new Error('expected a config handler slice');
  return slice.handlers['server.probeLlmSource']({ target }, undefined as never);
};

const boot = () => {
  const substrate = composeLlmSubstrate({ db, keys: undefined, envLlmConfig: undefined });
  if (!substrate.llmManager) throw new Error('expected an LLM config manager');
  return substrate.llmManager;
};

describe('a picture proof, through the composed substrate', () => {
  it('is stored on the slot Test proved, and restored on the next boot', async () => {
    const manager = boot();
    manager.setSlot1(QWEN);

    const result = await pressTest(manager, { kind: 'slot', slot_key: 'slot_1' }, '4827');
    expect(result).toMatchObject({ ok: true, sees_pictures: true });
    expect(createLLMConfigManager(db).getConfig().slot_1?.image_input_ok).toBe(true);

    // Restart: a new process memory, the same database.
    onEndpointCapabilityLearned(undefined);
    resetEndpointCapabilities();
    boot();
    expect(imageInputSeen(QWEN)).toBe(true);
  });

  it('is stored on the pool entry Test proved, and withdrawn by a blind answer', async () => {
    const manager = boot();
    manager.upsertPoolEntry({ ...QWEN, id: 'qwen', type: 'api', enabled: true } as never);

    await pressTest(manager, { kind: 'pool_entry', entry_id: 'qwen' }, '4827');
    expect(createLLMConfigManager(db).getConfig().free_pool?.[0]?.image_input_ok).toBe(true);

    await pressTest(manager, { kind: 'pool_entry', entry_id: 'qwen' }, 'I cannot see a picture.');
    expect(createLLMConfigManager(db).getConfig().free_pool?.[0]?.image_input_ok).toBeUndefined();
  });

  /** ⛔ THE LOCKED-BOOT CASE. A boot that hydrated nothing holds no proof in
   *  memory; an unrelated learning on the same endpoint (here a system-role
   *  refusal) must not write that emptiness over the owner's stored proof. */
  it('survives an unrelated learning after a boot that hydrated nothing', async () => {
    const manager = boot();
    manager.setSlot1(QWEN);
    await pressTest(manager, { kind: 'slot', slot_key: 'slot_1' }, '4827');

    resetEndpointCapabilities();
    await completeWithFallbacks({
      provider: 'openai-compatible',
      complete: async (_slot: LLMSlot, messages: LLMMessage[]) => {
        if (messages.some((m) => m.role === 'system')) {
          throw classifyProviderError(400, '{"error":{"message":"System role not supported"}}', null);
        }
        return { text: 'ok', usage: USAGE };
      },
    }, QWEN, [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }], {
      model: QWEN.model, max_tokens: 8, timeout_ms: 1_000,
    });

    const stored = createLLMConfigManager(db).getConfig().slot_1;
    expect(stored?.system_role_ok).toBe(false);
    expect(stored?.image_input_ok).toBe(true);
  });
});

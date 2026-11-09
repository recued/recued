/** D-344 slice C — a call can prefer a source, the model the owner's chat runs on: tried first at
 *  whichever speed tier it is, within the layer the call allows and with its other requirements kept,
 *  never a pin. The owner: "user can always choose which model (the selected chat model) to perform
 *  such search". */
import { describe, expect, it } from 'vitest';
import type { LLMRequirements, WebChatTab } from '@recued/contracts';

import { buildAvailability } from '../availability.js';
import { matchLLM, type MatchRequest } from '../match.js';
import { createQuotaTracker } from '../quota.js';
import type { LLMConfig } from '../types.js';

const noTabs = async (): Promise<Set<WebChatTab>> => new Set();
const requires = (over: Partial<LLMRequirements> = {}): LLMRequirements => ({ speed: 'fast', output_format: 'text', ...over });
const slot = (model: string, speed: 'fast' | 'quality', supports_json = true) =>
  ({ provider: 'openai' as const, model, api_key: 'k', speed, supports_json });
const pool = (id: string, speed: 'fast' | 'quality') => ({ id, type: 'api' as const, provider: 'openai-compatible' as const,
  model: id, api_key: 'k', base_url: 'https://pool.example/v1', speed, supports_json: true, enabled: true });

/** The owner's models: a fast slot 1, a quality slot 2 (their chat's), and a free quality model. */
const config: LLMConfig = { slot_1: slot('slot-1-model', 'fast'), slot_2: slot('slot-2-model', 'quality'),
  free_pool: [pool('free-model', 'quality')] };

const route = async (request: Omit<MatchRequest, 'allowUpgrade'>, cfg: LLMConfig = config) => {
  const quota = createQuotaTracker();
  const availability = await buildAvailability({ config: cfg, quota, tabProbe: noTabs });
  return matchLLM({ allowUpgrade: false, ...request }, { config: cfg, availability, quota, strategy: 'round_robin' }).slot.model;
};

describe('D-344 slice C — a preferred source', () => {
  it('without one, a fast call takes the fast slot', async () => {
    expect(await route({ requires: requires() })).toBe('slot-1-model');
  });

  it('a fast call from a chat on slot 2 takes slot 2, a quality model, since the owner chose it', async () => {
    expect(await route({ requires: requires(), prefer: { pinSlot: 'slot_2' } })).toBe('slot-2-model');
  });

  it('a chat on the free pool takes a free model for a call that allows any', async () => {
    expect(await route({ requires: requires(), prefer: { layer: 'free' } })).toBe('free-model');
  });

  it('a call whose pool forbids the chat\'s model routes as it would without it', async () => {
    // A step for the free models only (its pool policy says which providers see what it sends).
    const cfg: LLMConfig = { ...config, free_pool: [pool('free-fast', 'fast')] };
    expect(await route({ requires: requires(), forceLayer: 'free', prefer: { pinSlot: 'slot_2' } }, cfg))
      .toBe(await route({ requires: requires(), forceLayer: 'free' }, cfg));
    expect(await route({ requires: requires(), forceLayer: 'free', prefer: { pinSlot: 'slot_2' } }, cfg)).toBe('free-fast');
    expect(await route({ requires: requires(), forceLayer: 'byok', prefer: { layer: 'free' } })).toBe('slot-1-model');
  });

  it('a requirement the chat\'s model cannot meet sends the call on as before', async () => {
    const cfg: LLMConfig = { ...config, slot_2: slot('slot-2-model', 'quality', false) };
    expect(await route({ requires: requires({ output_format: 'json' }), prefer: { pinSlot: 'slot_2' } }, cfg)).toBe('slot-1-model');
  });

  it('a hard pin wins over a preference', async () => {
    expect(await route({ requires: requires(), forceLayer: 'byok', pinSlot: 'slot_1', prefer: { pinSlot: 'slot_2' } }))
      .toBe('slot-1-model');
  });
});

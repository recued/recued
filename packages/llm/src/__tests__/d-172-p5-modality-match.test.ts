/** D-172 P5 / N.8 / Q4 — modality-aware match resolution + warn-on-none. */
import { beforeEach, describe, it, expect } from 'vitest';
import { matchLLM } from '../match.js';
import { noteImageInput, resetEndpointCapabilities } from '../endpoint-capabilities.js';
import { buildAvailability } from '../availability.js';
import { createQuotaTracker } from '../quota.js';
import { LLMError } from '../types.js';
import type { FreePoolEntry, LLMConfig } from '../types.js';
import type { LLMRequirements, WebChatTab } from '@recued/contracts';

const noTabs = async (): Promise<Set<WebChatTab>> => new Set();

const requires = (over: Partial<LLMRequirements> = {}): LLMRequirements => ({
  speed: 'fast',
  output_format: 'text',
  ...over,
});

const apiEntry = (id: string, over: Partial<Extract<FreePoolEntry, { type: 'api' }>> = {}) => ({
  id,
  type: 'api' as const,
  provider: 'openai-compatible' as const,
  model: 'llama',
  api_key: 'k',
  speed: 'fast' as const,
  supports_json: true,
  enabled: true,
  ...over,
});

const avail = async (config: LLMConfig, tabProbe = noTabs) =>
  buildAvailability({ config, quota: createQuotaTracker(), tabProbe });

describe('matchLLM — modality filtering (N.8)', () => {
  it('routes an image turn to the image-capable entry, skipping a text-only one', async () => {
    const config: LLMConfig = {
      free_pool: [
        apiEntry('text-only'),
        apiEntry('vision', { modalities: { image: true } }),
      ],
    };
    const match = matchLLM(
      { requires: requires(), allowUpgrade: false, requireModalities: { image: true } },
      { config, availability: await avail(config), quota: createQuotaTracker(), strategy: 'round_robin' },
    );
    expect(match.source.kind).toBe('pool');
    if (match.source.kind === 'pool') expect(match.source.entry.id).toBe('vision');
  });

  it('carries modalities onto the synthesized slot of a winning pool entry', async () => {
    const config: LLMConfig = {
      free_pool: [apiEntry('vision', { modalities: { image: true } })],
    };
    const match = matchLLM(
      { requires: requires(), allowUpgrade: false, requireModalities: { image: true } },
      { config, availability: await avail(config), quota: createQuotaTracker(), strategy: 'round_robin' },
    );
    expect(match.slot.modalities).toEqual({ image: true });
    // ⛔ D-262 § B4 — `transcription_model` is NOT carried, because it no longer
    // exists. The matcher synthesises a slot for a CHAT call; transcription
    // stopped coming through here when it moved to its own slot, so copying a
    // transcription field onto a chat slot was carrying a value nothing read.
    expect('transcription_model' in match.slot).toBe(false);
  });

  it('a BYOK slot without modalities cannot serve a media turn', async () => {
    const config: LLMConfig = {
      slot_1: { provider: 'anthropic', model: 'claude', api_key: 'sk', speed: 'fast', supports_json: true },
    };
    const availability = await avail(config);
    expect(() =>
      matchLLM(
        { requires: requires(), allowUpgrade: false, requireModalities: { image: true } },
        { config, availability, quota: createQuotaTracker(), strategy: 'round_robin' },
      ),
    ).toThrow(LLMError);
  });

  it('throws AI_LLM_UNAVAILABLE with requireModalities details + message when no source is capable', async () => {
    const config: LLMConfig = { free_pool: [apiEntry('text-only')] };
    const availability = await avail(config);
    try {
      matchLLM(
        { requires: requires(), allowUpgrade: false, requireModalities: { audio: true } },
        { config, availability, quota: createQuotaTracker(), strategy: 'round_robin' },
      );
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(LLMError);
      const err = e as LLMError;
      expect(err.code).toBe('AI_LLM_UNAVAILABLE');
      expect(err.message).toContain('modalities: audio');
      expect((err.details as Record<string, unknown>).requireModalities).toEqual({ audio: true });
    }
  });

  it('no modality demand → text-only sources still match (unchanged)', async () => {
    const config: LLMConfig = { free_pool: [apiEntry('text-only')] };
    const match = matchLLM(
      { requires: requires(), allowUpgrade: false },
      { config, availability: await avail(config), quota: createQuotaTracker(), strategy: 'round_robin' },
    );
    expect(match.source.kind).toBe('pool');
  });

  it('the modality demand survives a downgrade pass (never routes media to a text-only model)', async () => {
    // Demand quality+image with allow_downgrade. The quality entry is text-only;
    // only the fast entry has vision. Downgrade must pick the fast vision entry,
    // never the quality text-only one.
    const config: LLMConfig = {
      free_pool: [
        apiEntry('quality-text', { speed: 'quality' }),
        apiEntry('fast-vision', { speed: 'fast', modalities: { image: true } }),
      ],
    };
    const match = matchLLM(
      { requires: requires({ speed: 'quality', allow_downgrade: true }), allowUpgrade: false, requireModalities: { image: true } },
      { config, availability: await avail(config), quota: createQuotaTracker(), strategy: 'round_robin' },
    );
    expect(match.source.kind).toBe('pool');
    if (match.source.kind === 'pool') expect(match.source.entry.id).toBe('fast-vision');
    expect(match.used_downgrade).toBe(true);
  });
});

/** Picture input proven by Test connection (`endpoint-capabilities` § Picture
 *  input). Before it, `modalities.image` could only be typed into a stored
 *  config — nothing in the product typed it — so every picture turn refused. */
describe('matchLLM — a picture reaches a source Test connection proved', () => {
  beforeEach(() => { resetEndpointCapabilities(); });

  const pick = async (config: LLMConfig) => matchLLM(
    { requires: requires(), allowUpgrade: false, requireModalities: { image: true } },
    { config, availability: await avail(config), quota: createQuotaTracker(), strategy: 'round_robin' },
  );

  it('routes a picture to the entry proven in this process', async () => {
    const config: LLMConfig = { free_pool: [apiEntry('a'), apiEntry('b', { model: 'qwen-vl' })] };
    noteImageInput({ provider: 'openai-compatible', model: 'qwen-vl' }, true);
    const match = await pick(config);
    if (match.source.kind !== 'pool') throw new Error('expected a pool match');
    expect(match.source.entry.id).toBe('b');
  });

  /** A boot that could not read the store hydrates nothing; the per-use config
   *  read still carries the stored proof, so it must count on its own. */
  it('routes a picture to an entry whose stored proof says so, with nothing in memory', async () => {
    const config: LLMConfig = { free_pool: [apiEntry('a'), apiEntry('b', { image_input_ok: true })] };
    const match = await pick(config);
    if (match.source.kind !== 'pool') throw new Error('expected a pool match');
    expect(match.source.entry.id).toBe('b');
  });

  it('routes a picture to a proven slot', async () => {
    const config: LLMConfig = {
      slot_1: { provider: 'openai', model: 'gpt-4o', api_key: 'k', speed: 'fast', supports_json: true },
    };
    noteImageInput({ provider: 'openai', model: 'gpt-4o' }, true);
    expect((await pick(config)).source.kind).toBe('slot');
  });

  it('still refuses a picture when no source is proven or declared', async () => {
    const config: LLMConfig = { free_pool: [apiEntry('a')] };
    noteImageInput({ provider: 'openai-compatible', model: 'other' }, true);
    await expect(pick(config)).rejects.toBeInstanceOf(LLMError);
  });

  /** ⚠ The proof only ever ADDS: a declaration typed into the config is the
   *  owner's to keep, and a demand for audio still needs audio. */
  it('adds picture input without dropping or inventing other kinds', async () => {
    const config: LLMConfig = { free_pool: [apiEntry('a', { modalities: { audio: true } })] };
    noteImageInput({ provider: 'openai-compatible', model: 'llama' }, true);
    const availability = await avail(config);
    const demand = (requireModalities: { image?: boolean; audio?: boolean; document?: boolean }) =>
      () => matchLLM(
        { requires: requires(), allowUpgrade: false, requireModalities },
        { config, availability, quota: createQuotaTracker(), strategy: 'round_robin' },
      );
    expect(demand({ image: true, audio: true })().source.kind).toBe('pool');
    expect(demand({ document: true })).toThrow(LLMError);
  });
});

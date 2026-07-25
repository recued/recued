/** D-172 P5 / N.8 / Q4 — modality-aware match resolution + warn-on-none. */
import { describe, it, expect } from 'vitest';
import { matchLLM } from '../match.js';
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

  it('carries modalities + transcription_model onto the synthesized slot of a winning pool entry', async () => {
    const config: LLMConfig = {
      free_pool: [apiEntry('vision', { modalities: { image: true }, transcription_model: 'whisper-large-v3' })],
    };
    const match = matchLLM(
      { requires: requires(), allowUpgrade: false, requireModalities: { image: true } },
      { config, availability: await avail(config), quota: createQuotaTracker(), strategy: 'round_robin' },
    );
    expect(match.slot.modalities).toEqual({ image: true });
    expect(match.slot.transcription_model).toBe('whisper-large-v3');
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

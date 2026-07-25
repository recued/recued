import { describe, it, expect } from 'vitest';
import { preflightMatch } from '../preflight.js';
import { buildAvailability } from '../availability.js';
import { createQuotaTracker } from '../quota.js';
import type { FreePoolEntry, LLMConfig } from '../types.js';
import type { WebChatTab } from '@recued/contracts';

const noTabs = async (): Promise<Set<WebChatTab>> => new Set();

const apiEntry = (id: string, over: Partial<Extract<FreePoolEntry, { type: 'api' }>> = {}) => ({
  id,
  type: 'api' as const,
  provider: 'openai-compatible' as const,
  model: 'x',
  api_key: 'k',
  speed: 'fast' as const,
  supports_json: true,
  enabled: true,
  ...over,
});

describe('preflightMatch', () => {
  it('surfaces no_tier when no configured source matches required speed', async () => {
    const config: LLMConfig = {
      slot_1: { provider: 'openai', model: 'g', api_key: 'k', speed: 'fast', supports_json: true },
      slot_2: { provider: 'anthropic', model: 'c', api_key: 'k', speed: 'quality', supports_json: true },
      free_pool: [apiEntry('a1', { speed: 'fast' })],
    };
    const availability = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    const result = preflightMatch(
      [
        {
          step_id: 'extract',
          ingredient_slug: 'ai-extract',
          requires: { speed: 'thinking', output_format: 'json' },
          allowUpgrade: false,
        },
      ],
      { config, availability, quota: createQuotaTracker(), strategy: 'round_robin' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.reason).toBe('no_tier');
      expect(result.issues[0]?.suggestion).toMatch(/thinking-tier/i);
    }
  });

  it('resolves when the ingredient allows downgrade', async () => {
    const config: LLMConfig = {
      slot_1: { provider: 'openai', model: 'g', api_key: 'k', speed: 'fast', supports_json: true },
      slot_2: { provider: 'anthropic', model: 'c', api_key: 'k', speed: 'quality', supports_json: true },
    };
    const availability = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    const result = preflightMatch(
      [
        {
          step_id: 'summary',
          ingredient_slug: 'ai-summarize',
          requires: { speed: 'thinking', output_format: 'text', allow_downgrade: true },
          allowUpgrade: false,
        },
      ],
      { config, availability, quota: createQuotaTracker(), strategy: 'round_robin' },
    );
    expect(result.ok).toBe(true);
  });

  it('reports no_json when json required but no json-capable entry exists', async () => {
    const config: LLMConfig = {
      free_pool: [
        { id: 'a1', type: 'api', provider: 'openai-compatible', model: 'm', api_key: 'k', speed: 'fast', supports_json: false, enabled: true },
      ],
    };
    const availability = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    const result = preflightMatch(
      [
        {
          step_id: 'classify',
          ingredient_slug: 'ai-classify',
          requires: { speed: 'fast', output_format: 'json' },
          allowUpgrade: false,
        },
      ],
      { config, availability, quota: createQuotaTracker(), strategy: 'round_robin' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.reason).toBe('no_json');
  });

  it('collects ALL failing steps, not just the first', async () => {
    const config: LLMConfig = {
      slot_1: { provider: 'openai', model: 'g', api_key: 'k', speed: 'fast', supports_json: true },
    };
    const availability = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    const result = preflightMatch(
      [
        {
          step_id: 'extract',
          ingredient_slug: 'ai-extract',
          requires: { speed: 'thinking', output_format: 'json' },
          allowUpgrade: false,
        },
        {
          step_id: 'summary',
          ingredient_slug: 'ai-summarize',
          requires: { speed: 'quality', output_format: 'text' },
          allowUpgrade: false,
          forceLayer: 'free',
        },
      ],
      { config, availability, quota: createQuotaTracker(), strategy: 'round_robin' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBe(2);
      expect(result.issues.map((i) => i.step_id)).toEqual(['extract', 'summary']);
    }
  });

  it('returns ok when every step can match', async () => {
    const config: LLMConfig = {
      slot_1: { provider: 'openai', model: 'g', api_key: 'k', speed: 'fast', supports_json: true },
    };
    const availability = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    const result = preflightMatch(
      [
        {
          step_id: 's1',
          ingredient_slug: 'ai-classify',
          requires: { speed: 'fast', output_format: 'json' },
          allowUpgrade: false,
        },
      ],
      { config, availability, quota: createQuotaTracker(), strategy: 'round_robin' },
    );
    expect(result.ok).toBe(true);
  });

  it('does NOT mutate quota state (dry-run)', async () => {
    const config: LLMConfig = {
      free_pool: [apiEntry('a1'), apiEntry('a2')],
    };
    const quota = createQuotaTracker();
    const availability = await buildAvailability({ config, quota, tabProbe: noTabs });
    preflightMatch(
      [
        {
          step_id: 's1',
          ingredient_slug: 'ai-classify',
          requires: { speed: 'fast', output_format: 'json' },
          allowUpgrade: false,
        },
      ],
      { config, availability, quota, strategy: 'round_robin' },
    );
    expect(quota.currentCursor('free:fast')).toBe(0);
    expect(quota.snapshot().tokens_today).toEqual({});
  });

  it('reports no_search when a matching-tier source exists but none supports web-search', async () => {
    const config: LLMConfig = {
      slot_1: {
        provider: 'openai', model: 'g', api_key: 'k',
        speed: 'fast', supports_json: true, supports_search: false,
      },
    };
    const availability = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    const result = preflightMatch(
      [
        {
          step_id: 's',
          ingredient_slug: 'ai-research',
          requires: { speed: 'fast', output_format: 'json', needs_search: true },
          allowUpgrade: false,
        },
      ],
      { config, availability, quota: createQuotaTracker(), strategy: 'round_robin' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.reason).toBe('no_search');
      expect(result.issues[0]?.suggestion).toMatch(/search/i);
    }
  });

  it('reports all_unavailable when matching source exists but is not currently available', async () => {
    // Slot_1 is configured at the right tier but its budget is over the cutoff
    // (treated as unavailable for match purposes).
    const config: LLMConfig = {
      slot_1: { provider: 'openai', model: 'g', api_key: 'k', speed: 'fast', supports_json: true },
    };
    const availability = await buildAvailability({
      config, quota: createQuotaTracker(), tabProbe: noTabs,
      budgetStatus: (k) => k === 'slot_1' ? { over_cutoff: true } : { over_cutoff: false },
    });
    const result = preflightMatch(
      [
        {
          step_id: 's',
          ingredient_slug: 'ai-classify',
          requires: { speed: 'fast', output_format: 'json' },
          allowUpgrade: false,
        },
      ],
      { config, availability, quota: createQuotaTracker(), strategy: 'round_robin' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.reason).toBe('all_unavailable');
      expect(result.issues[0]?.suggestion).toMatch(/currently unavailable/i);
    }
  });

  it('treats disabled pool entries as if absent (no_tier when only-match is disabled)', async () => {
    const config: LLMConfig = {
      free_pool: [
        apiEntry('disabled', { speed: 'fast', enabled: false }),
      ],
    };
    const availability = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    const result = preflightMatch(
      [
        {
          step_id: 's',
          ingredient_slug: 'ai-classify',
          requires: { speed: 'fast', output_format: 'json' },
          allowUpgrade: false,
        },
      ],
      { config, availability, quota: createQuotaTracker(), strategy: 'round_robin' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.reason).toBe('no_tier');
  });
});

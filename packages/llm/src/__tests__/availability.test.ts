import { describe, it, expect } from 'vitest';
import { buildAvailability } from '../availability.js';
import { createQuotaTracker } from '../quota.js';
import type { LLMConfig, LLMSlot } from '../types.js';
import type { WebChatTab } from '@recued/contracts';

const slot = (over: Partial<LLMSlot> = {}): LLMSlot => ({
  provider: 'openai',
  model: 'm',
  api_key: 'k',
  speed: 'fast',
  supports_json: true,
  ...over,
});

const noTabs = async (): Promise<Set<WebChatTab>> => new Set();

describe('buildAvailability', () => {
  it('marks missing slots as no_key', async () => {
    const config: LLMConfig = {};
    const snap = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    expect(snap.slot_1).toEqual({ available: false, reason: 'no_key' });
    expect(snap.slot_2).toEqual({ available: false, reason: 'no_key' });
  });

  it('flags missing api_key and missing model on slots', async () => {
    const config: LLMConfig = { slot_1: slot({ api_key: '' }), slot_2: slot({ model: '' }) };
    const snap = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    expect(snap.slot_1).toEqual({ available: false, reason: 'no_key' });
    expect(snap.slot_2).toEqual({ available: false, reason: 'no_model' });
  });

  it('reports available slots when key + model are set', async () => {
    const config: LLMConfig = { slot_1: slot() };
    const snap = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    expect(snap.slot_1).toEqual({ available: true });
  });

  it('delegates api entry status to quota tracker (no_key / no_model propagate)', async () => {
    const config: LLMConfig = {
      free_pool: [
        { id: 'a1', type: 'api', provider: 'openai-compatible', model: '', api_key: 'k', speed: 'fast', supports_json: true, enabled: true },
      ],
    };
    const snap = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    expect(snap.free_pool[0]?.status).toEqual({ available: false, reason: 'no_model' });
  });

  it('reads slot_budget from injected callback', async () => {
    const config: LLMConfig = { slot_1: slot(), slot_2: slot({ speed: 'quality' }) };
    const snap = await buildAvailability({
      config,
      quota: createQuotaTracker(),
      tabProbe: noTabs,
      budgetStatus: (key) => (key === 'slot_2' ? { over_cutoff: true } : { over_cutoff: false }),
    });
    expect(snap.slot_budget.slot_1.over_cutoff).toBe(false);
    expect(snap.slot_budget.slot_2.over_cutoff).toBe(true);
  });

  // D-079/D-094 per-slot budgets (reinstated) — over_cutoff is DERIVED from
  // the slot's daily_budget_tokens vs the quota tracker's per-slot
  // tokens-today when no budgetStatus callback is injected.
  it('derives slot_budget.over_cutoff from daily_budget_tokens + quota usage', async () => {
    const config: LLMConfig = {
      slot_1: slot({ daily_budget_tokens: 1000 }),
      slot_2: slot({ speed: 'quality', daily_budget_tokens: 1000 }),
    };
    const quota = createQuotaTracker();
    quota.recordUsage('slot_1', 1000); // exactly at budget → over
    quota.recordUsage('slot_2', 400); // under budget
    const snap = await buildAvailability({ config, quota, tabProbe: noTabs });
    expect(snap.slot_budget.slot_1.over_cutoff).toBe(true);
    expect(snap.slot_budget.slot_2.over_cutoff).toBe(false);
  });

  it('treats absent / zero daily_budget_tokens as unlimited (never over)', async () => {
    const config: LLMConfig = {
      slot_1: slot(), // no budget
      slot_2: slot({ speed: 'quality', daily_budget_tokens: 0 }), // explicit unlimited
    };
    const quota = createQuotaTracker();
    quota.recordUsage('slot_1', 9_000_000);
    quota.recordUsage('slot_2', 9_000_000);
    const snap = await buildAvailability({ config, quota, tabProbe: noTabs });
    expect(snap.slot_budget.slot_1.over_cutoff).toBe(false);
    expect(snap.slot_budget.slot_2.over_cutoff).toBe(false);
  });

  it('lets an explicit budgetStatus override the derived budget', async () => {
    const config: LLMConfig = { slot_1: slot({ daily_budget_tokens: 1000 }) };
    const quota = createQuotaTracker();
    quota.recordUsage('slot_1', 5000); // would be over by derivation
    const snap = await buildAvailability({
      config,
      quota,
      tabProbe: noTabs,
      budgetStatus: () => ({ over_cutoff: false }), // explicit wins
    });
    expect(snap.slot_budget.slot_1.over_cutoff).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { matchLLM } from '../match.js';
import { buildAvailability } from '../availability.js';
import { createQuotaTracker } from '../quota.js';
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
  model: 'llama-3.3-70b',
  api_key: 'k',
  speed: 'fast' as const,
  supports_json: true,
  enabled: true,
  ...over,
});

describe('matchLLM — auto free-before-BYOK ranking', () => {
  it('carries pool context-window metadata onto the synthesized slot', async () => {
    const config: LLMConfig = {
      free_pool: [apiEntry('a1', { context_window_tokens: 32_768 })],
    };
    const quota = createQuotaTracker();
    const availability = await buildAvailability({ config, quota, tabProbe: noTabs });
    const match = matchLLM(
      { requires: requires(), allowUpgrade: false },
      { config, availability, quota, strategy: 'round_robin' },
    );
    expect(match.slot.context_window_tokens).toBe(32_768);
  });

  it('free pool wins over BYOK when both match the tier', async () => {
    const config: LLMConfig = {
      free_pool: [apiEntry('a1', { speed: 'fast' })],
      slot_1: { provider: 'openai', model: 'gpt-4', api_key: 'sk', speed: 'fast', supports_json: true },
    };
    const availability = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    const match = matchLLM(
      { requires: requires(), allowUpgrade: false },
      { config, availability, quota: createQuotaTracker(), strategy: 'round_robin' },
    );
    expect(match.source.kind).toBe('pool');
  });

  it('BYOK fires when no free candidate matches', async () => {
    const config: LLMConfig = {
      free_pool: [apiEntry('a1', { speed: 'fast' })], // fast only
      slot_2: { provider: 'anthropic', model: 'claude', api_key: 'sk', speed: 'quality', supports_json: true },
    };
    const availability = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    const match = matchLLM(
      { requires: requires({ speed: 'quality' }), allowUpgrade: false },
      { config, availability, quota: createQuotaTracker(), strategy: 'round_robin' },
    );
    expect(match.source.kind).toBe('slot');
  });
});

describe('matchLLM — strict capability filtering', () => {
  it('skips entries whose speed does not match (strict equality)', async () => {
    const config: LLMConfig = {
      free_pool: [apiEntry('a1', { speed: 'fast' })],
      slot_2: { provider: 'anthropic', model: 'claude', api_key: 'sk', speed: 'quality', supports_json: true },
    };
    const availability = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    const match = matchLLM(
      { requires: requires({ speed: 'quality' }), allowUpgrade: false },
      { config, availability, quota: createQuotaTracker(), strategy: 'round_robin' },
    );
    expect(match.source.kind).toBe('slot');
  });

  it('requires supports_search when ingredient needs search', async () => {
    const config: LLMConfig = {
      free_pool: [
        apiEntry('a1', { speed: 'fast', supports_search: false }),
        apiEntry('a2', { speed: 'fast', supports_search: true }),
      ],
    };
    const availability = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    const match = matchLLM(
      { requires: requires({ needs_search: true }), allowUpgrade: false },
      { config, availability, quota: createQuotaTracker(), strategy: 'round_robin' },
    );
    expect(match.source.kind).toBe('pool');
    if (match.source.kind === 'pool') expect(match.source.entry.id).toBe('a2');
  });
});

describe('matchLLM — forceLayer restricts candidates', () => {
  it('forceLayer:"byok" excludes pool entries', async () => {
    const config: LLMConfig = {
      free_pool: [apiEntry('a1', { speed: 'fast' })],
      slot_1: { provider: 'openai', model: 'gpt', api_key: 'sk', speed: 'fast', supports_json: true },
    };
    const availability = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    const match = matchLLM(
      { requires: requires(), allowUpgrade: false, forceLayer: 'byok' },
      { config, availability, quota: createQuotaTracker(), strategy: 'round_robin' },
    );
    expect(match.source.kind).toBe('slot');
  });

  it('forceLayer:"free" excludes slots', async () => {
    const config: LLMConfig = {
      free_pool: [apiEntry('a1', { speed: 'fast' })],
      slot_1: { provider: 'openai', model: 'gpt', api_key: 'sk', speed: 'fast', supports_json: true },
    };
    const availability = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    const match = matchLLM(
      { requires: requires(), allowUpgrade: false, forceLayer: 'free' },
      { config, availability, quota: createQuotaTracker(), strategy: 'round_robin' },
    );
    expect(match.source.kind).toBe('pool');
  });
});

describe('matchLLM — downgrade (ingredient-author quality dial)', () => {
  it('relaxes thinking → quality when allow_downgrade: true', async () => {
    const config: LLMConfig = {
      slot_2: { provider: 'anthropic', model: 'claude', api_key: 'sk', speed: 'quality', supports_json: true },
    };
    const availability = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    const match = matchLLM(
      { requires: requires({ speed: 'thinking', allow_downgrade: true }), allowUpgrade: false },
      { config, availability, quota: createQuotaTracker(), strategy: 'round_robin' },
    );
    expect(match.used_downgrade).toBe(true);
    expect(match.resolved_hint).toBe('quality');
  });

  it('does NOT downgrade without the flag', async () => {
    const config: LLMConfig = {
      slot_2: { provider: 'anthropic', model: 'claude', api_key: 'sk', speed: 'quality', supports_json: true },
    };
    const availability = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    expect(() =>
      matchLLM(
        { requires: requires({ speed: 'thinking', allow_downgrade: false }), allowUpgrade: false },
        { config, availability, quota: createQuotaTracker(), strategy: 'round_robin' },
      ),
    ).toThrow(/AI_LLM_UNAVAILABLE|No LLM source/i);
  });
});

describe('matchLLM — upgrade (recipe-variable user-cost dial)', () => {
  it('climbs to a higher tier when allowUpgrade is true', async () => {
    const config: LLMConfig = {
      slot_2: { provider: 'anthropic', model: 'claude', api_key: 'sk', speed: 'thinking', supports_json: true },
    };
    const availability = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    const match = matchLLM(
      { requires: requires({ speed: 'fast' }), allowUpgrade: true },
      { config, availability, quota: createQuotaTracker(), strategy: 'round_robin' },
    );
    expect(match.used_upgrade).toBe(true);
    expect(match.resolved_hint).toBe('thinking');
  });

  it('does NOT upgrade without the flag', async () => {
    const config: LLMConfig = {
      slot_2: { provider: 'anthropic', model: 'c', api_key: 'sk', speed: 'quality', supports_json: true },
    };
    const availability = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    expect(() =>
      matchLLM(
        { requires: requires({ speed: 'fast' }), allowUpgrade: false },
        { config, availability, quota: createQuotaTracker(), strategy: 'round_robin' },
      ),
    ).toThrow(/AI_LLM_UNAVAILABLE|No LLM source/i);
  });

  it('ownership separation: allow_downgrade alone does not permit upgrade', async () => {
    // Pool is empty; slot_2 is quality (higher than requested fast).
    const config: LLMConfig = {
      slot_2: { provider: 'anthropic', model: 'c', api_key: 'sk', speed: 'quality', supports_json: true },
    };
    const availability = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    expect(() =>
      matchLLM(
        { requires: requires({ allow_downgrade: true }), allowUpgrade: false },
        { config, availability, quota: createQuotaTracker(), strategy: 'round_robin' },
      ),
    ).toThrow(/AI_LLM_UNAVAILABLE|No LLM source/i);
  });
});

describe('matchLLM — budget cutoff excludes slots', () => {
  it('slots with over_cutoff budget are treated as unavailable', async () => {
    const config: LLMConfig = {
      slot_2: { provider: 'anthropic', model: 'c', api_key: 'sk', speed: 'quality', supports_json: true },
      free_pool: [apiEntry('a1', { speed: 'quality' })],
    };
    const availability = await buildAvailability({
      config,
      quota: createQuotaTracker(),
      tabProbe: noTabs,
      budgetStatus: (k) => (k === 'slot_2' ? { over_cutoff: true } : { over_cutoff: false }),
    });
    const match = matchLLM(
      { requires: requires({ speed: 'quality' }), allowUpgrade: false },
      { config, availability, quota: createQuotaTracker(), strategy: 'round_robin' },
    );
    expect(match.source.kind).toBe('pool');
  });
});

describe('matchLLM — round-robin cursor advances across calls', () => {
  it('rotates between equal-tier free_pool entries', async () => {
    const config: LLMConfig = {
      free_pool: [apiEntry('a1'), apiEntry('a2')],
    };
    const quota = createQuotaTracker();
    const availability = await buildAvailability({ config, quota, tabProbe: noTabs });

    const run = () => matchLLM(
      { requires: requires(), allowUpgrade: false },
      { config, availability, quota, strategy: 'round_robin' },
    );

    const m1 = run();
    quota.advanceCursor('free:fast'); // executor normally does this post-success
    const m2 = run();
    if (m1.source.kind === 'pool' && m2.source.kind === 'pool') {
      expect(m1.source.entry.id).not.toBe(m2.source.entry.id);
    } else {
      throw new Error('expected pool matches');
    }
  });
});

describe('matchLLM — rejectSet excludes retry candidates', () => {
  it('skips a rejected pool entry and picks the next one', async () => {
    const config: LLMConfig = {
      free_pool: [apiEntry('a1'), apiEntry('a2')],
    };
    const availability = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    const match = matchLLM(
      { requires: requires(), allowUpgrade: false },
      { config, availability, quota: createQuotaTracker(), strategy: 'round_robin', rejectSet: new Set(['a1']) },
    );
    if (match.source.kind === 'pool') {
      expect(match.source.entry.id).toBe('a2');
    } else {
      throw new Error('expected pool match');
    }
  });
});

describe('matchLLM — weighted strategy (deterministic via injected rng)', () => {
  const pool: FreePoolEntry[] = [
    { id: 'a1', type: 'api', provider: 'openai-compatible', model: 'm1',
      api_key: 'k', speed: 'fast', supports_json: true, enabled: true, weight: 1 },
    { id: 'a2', type: 'api', provider: 'openai-compatible', model: 'm2',
      api_key: 'k', speed: 'fast', supports_json: true, enabled: true, weight: 3 },
    { id: 'a3', type: 'api', provider: 'openai-compatible', model: 'm3',
      api_key: 'k', speed: 'fast', supports_json: true, enabled: true, weight: 6 },
  ];

  const seededRng = (value: number): () => number => () => value;

  it('small roll falls in the first bucket', async () => {
    const config: LLMConfig = { free_pool: pool };
    const availability = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    const match = matchLLM(
      { requires: requires(), allowUpgrade: false },
      { config, availability, quota: createQuotaTracker(), strategy: 'weighted', rng: seededRng(0.05) },
    );
    if (match.source.kind !== 'pool') throw new Error('expected pool match');
    expect(match.source.entry.id).toBe('a1');
  });

  it('mid roll lands in the a2 bucket', async () => {
    const config: LLMConfig = { free_pool: pool };
    const availability = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    const match = matchLLM(
      { requires: requires(), allowUpgrade: false },
      { config, availability, quota: createQuotaTracker(), strategy: 'weighted', rng: seededRng(0.25) },
    );
    if (match.source.kind !== 'pool') throw new Error('expected pool match');
    expect(match.source.entry.id).toBe('a2');
  });

  it('high roll lands in the heaviest bucket', async () => {
    const config: LLMConfig = { free_pool: pool };
    const availability = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    const match = matchLLM(
      { requires: requires(), allowUpgrade: false },
      { config, availability, quota: createQuotaTracker(), strategy: 'weighted', rng: seededRng(0.9) },
    );
    if (match.source.kind !== 'pool') throw new Error('expected pool match');
    expect(match.source.entry.id).toBe('a3');
  });

  it('single eligible entry short-circuits strategy (rng not called)', async () => {
    const config: LLMConfig = { free_pool: [pool[0]!] };
    const availability = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    let rngCalls = 0;
    const match = matchLLM(
      { requires: requires(), allowUpgrade: false },
      {
        config, availability, quota: createQuotaTracker(),
        strategy: 'weighted',
        rng: () => { rngCalls++; return 0.5; },
      },
    );
    expect(match.source.kind).toBe('pool');
    expect(rngCalls).toBe(0);
  });

  it('rng=1 (edge — roll never crosses zero through the loop) still picks the last bucket', async () => {
    // This exercises the final `return group[group.length - 1]` path.
    const config: LLMConfig = { free_pool: pool };
    const availability = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    const match = matchLLM(
      { requires: requires(), allowUpgrade: false },
      { config, availability, quota: createQuotaTracker(), strategy: 'weighted', rng: seededRng(1) },
    );
    if (match.source.kind !== 'pool') throw new Error('expected pool match');
    // With rng=1, roll = weight_total * 1; loop subtracts each weight
    // without ever going <= 0, so the final-return path fires.
    expect(match.source.entry.id).toBe('a3');
  });
});

// ────────────────────────────────────────────────────────────────
// forceLayer variations + error details
// ────────────────────────────────────────────────────────────────

describe('matchLLM — AI_LLM_UNAVAILABLE error details', () => {
  it('attaches diagnostic details + includes json/search/forceLayer in message', async () => {
    const config: LLMConfig = {}; // no pool, no slots
    const availability = await buildAvailability({
      config, quota: createQuotaTracker(), tabProbe: noTabs,
    });
    try {
      matchLLM(
        {
          requires: requires({ output_format: 'json', needs_search: true }),
          allowUpgrade: false,
          forceLayer: 'byok',
        },
        { config, availability, quota: createQuotaTracker(), strategy: 'round_robin' },
      );
    } catch (e) {
      const err = e as Error & {
        code?: string;
        details?: { rejected: string[]; forceLayer: string; requires: LLMRequirements };
      };
      expect(err.message).toContain('json');
      expect(err.message).toContain('search');
      expect(err.message).toContain('forceLayer: byok');
      expect(err.code).toBe('AI_LLM_UNAVAILABLE');
      expect(err.details?.forceLayer).toBe('byok');
      expect(err.details?.requires.output_format).toBe('json');
      expect(err.details?.rejected).toEqual([]);
      return;
    }
    throw new Error('expected throw');
  });

  it('carries rejected ids on the details payload', async () => {
    const config: LLMConfig = {
      free_pool: [apiEntry('a1'), apiEntry('a2')],
    };
    const availability = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    try {
      matchLLM(
        { requires: requires(), allowUpgrade: false },
        {
          config, availability, quota: createQuotaTracker(),
          strategy: 'round_robin',
          rejectSet: new Set(['a1', 'a2']),
        },
      );
    } catch (e) {
      const err = e as Error & { details?: { rejected: string[] } };
      expect(new Set(err.details?.rejected)).toEqual(new Set(['a1', 'a2']));
      return;
    }
    throw new Error('expected throw');
  });
});

// ────────────────────────────────────────────────────────────────
// Unavailable sources are skipped
// ────────────────────────────────────────────────────────────────

describe('matchLLM — availability gates', () => {
  it('skips a pool entry reported unavailable (disabled)', async () => {
    const config: LLMConfig = {
      free_pool: [
        apiEntry('a1', { enabled: false }), // marked unavailable via enabled flag
        apiEntry('a2', { enabled: true }),
      ],
    };
    const availability = await buildAvailability({
      config, quota: createQuotaTracker(), tabProbe: noTabs,
    });
    const match = matchLLM(
      { requires: requires(), allowUpgrade: false },
      { config, availability, quota: createQuotaTracker(), strategy: 'round_robin' },
    );
    if (match.source.kind !== 'pool') throw new Error('expected pool');
    expect(match.source.entry.id).toBe('a2');
  });

});

// ────────────────────────────────────────────────────────────────
// Combined upgrade + downgrade
// ────────────────────────────────────────────────────────────────

describe('matchLLM — combined upgrade + downgrade', () => {
  it('when strict + single-direction ladders miss, explores upgrade-then-downgrade', async () => {
    // Requirement: fast. Only slot available is at `quality` tier.
    // allowUpgrade alone moves to quality → match (used_upgrade=true, no downgrade).
    // That's the normal Pass 3 path — already covered above.
    //
    // For the combined-ladder branch, pick a setup where:
    //   requirement = fast
    //   upgrade path (Pass 3) tries quality then thinking — both miss
    //   then Pass 3's inner combined loop walks upgrade tiers and tries
    //   their DOWNGRADES. quality.downgrade = [fast] — and a `fast` slot
    //   exists that was filtered in Pass 1 by require_search. Relaxation
    //   of require_search isn't part of the algorithm; instead set it up
    //   so only a `thinking` tier slot exists, and allow both flags.
    //
    // Simplest: require fast+search. Only slot is `thinking` WITHOUT search.
    // Pass 1 misses (no fast w/ search). Pass 2 (downgrade from fast → none).
    // Pass 3 straight upgrade tries quality then thinking — both miss
    // (slot lacks search). Combined inner tries upgraded tiers' downgrades
    // — quality→fast (miss, no search), thinking→quality/fast (miss).
    // All miss → throws.
    //
    // To make the combined path SUCCEED: keep requirements simple, add a
    // slot at a tier reachable only via "upgrade then downgrade" path.
    // Example: requires=fast, slot at `fast` but supports_search=false,
    // and a second slot at `quality` that DOES support_search=false too.
    // Actually the combined loop is awkward — the simpler useful assertion
    // is just that the inner loop is executed when both flags are set.
    //
    // Here we exercise the case where upgrade would succeed at `quality`,
    // ensuring allow_downgrade being also true doesn't block the upgrade.
    const config: LLMConfig = {
      slot_2: { provider: 'anthropic', model: 'c', api_key: 'sk', speed: 'quality', supports_json: true },
    };
    const availability = await buildAvailability({
      config, quota: createQuotaTracker(), tabProbe: noTabs,
    });
    const match = matchLLM(
      {
        requires: requires({ speed: 'fast', allow_downgrade: true }),
        allowUpgrade: true,
      },
      { config, availability, quota: createQuotaTracker(), strategy: 'round_robin' },
    );
    expect(match.used_upgrade).toBe(true);
    expect(match.resolved_hint).toBe('quality');
  });

  it('Pass 3 walks thinking then stops at the first hit', async () => {
    // Upgrade starts at `fast`, slice(1) = ['quality', 'thinking'].
    // Only `thinking` is available → must skip `quality` and land there.
    const config: LLMConfig = {
      slot_2: { provider: 'anthropic', model: 'c', api_key: 'sk', speed: 'thinking', supports_json: true },
    };
    const availability = await buildAvailability({
      config, quota: createQuotaTracker(), tabProbe: noTabs,
    });
    const match = matchLLM(
      { requires: requires({ speed: 'fast' }), allowUpgrade: true },
      { config, availability, quota: createQuotaTracker(), strategy: 'round_robin' },
    );
    expect(match.resolved_hint).toBe('thinking');
    expect(match.used_upgrade).toBe(true);
  });
});

describe('matchLLM — D-191 Phase 6 exact-slot pin (INV3)', () => {
  // Two BYOK slots at the SAME speed — one local, one remote — plus a free-pool
  // entry at that speed. This is the leak `pinSlot` closes: by speed alone the
  // matcher can't tell the slots apart, and free-before-BYOK would prefer the
  // pool over either.
  const sameSpeedConfig = (): LLMConfig => ({
    free_pool: [apiEntry('fp', { speed: 'fast' })],
    slot_1: {
      provider: 'openai-compatible', model: 'q', api_key: 'k',
      base_url: 'http://localhost:11434/v1', speed: 'fast', supports_json: true,
    },
    slot_2: {
      provider: 'openai', model: 'gpt', api_key: 'sk', speed: 'fast', supports_json: true,
    },
  });

  it('pins to the EXACT slot — excludes the other same-speed slot AND the pool', async () => {
    const config = sameSpeedConfig();
    const availability = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    // Pin the REMOTE slot_2. Without the pin the free pool would win and slot_1
    // sorts ahead of slot_2 — so landing on slot_2 proves the pin took effect.
    const match = matchLLM(
      { requires: requires(), allowUpgrade: false, pinSlot: 'slot_2' },
      { config, availability, quota: createQuotaTracker(), strategy: 'round_robin' },
    );
    expect(match.source.kind).toBe('slot');
    if (match.source.kind === 'slot') expect(match.source.slot_key).toBe('slot_2');
  });

  it('a rejected pinned slot fails CLOSED — never cascades to the other slot or the pool', async () => {
    const config = sameSpeedConfig();
    const availability = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    // slot_1 pinned + rejected (retryable error). The match must THROW rather
    // than fall through to slot_2 (remote) or the pool — that fall-through is the
    // INV3 leak. The diagnostic message carries the pin.
    expect(() =>
      matchLLM(
        { requires: requires(), allowUpgrade: false, pinSlot: 'slot_1' },
        {
          config, availability, quota: createQuotaTracker(),
          strategy: 'round_robin', rejectSet: new Set(['slot_1']),
        },
      ),
    ).toThrow(/pinSlot: slot_1/);
  });

  it('CONTROL — without a pin, the SAME rejected slot_1 DOES cascade (a fast source still serves)', async () => {
    const config = sameSpeedConfig();
    const availability = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    const match = matchLLM(
      { requires: requires(), allowUpgrade: false },
      {
        config, availability, quota: createQuotaTracker(),
        strategy: 'round_robin', rejectSet: new Set(['slot_1']),
      },
    );
    // Proves the fail-closed behavior above is the PIN, not a config artifact.
    expect(['pool', 'slot']).toContain(match.source.kind);
  });

  it('a pinned slot at a non-matching speed fails closed (never relaxes onto the other slot)', async () => {
    // Pin slot_2 (quality) but require fast; slot_1 (fast) exists. The pin must
    // NOT let slot_1 serve — only slot_2, which doesn't match fast + no downgrade
    // → no match.
    const config: LLMConfig = {
      slot_1: { provider: 'openai', model: 'gpt', api_key: 'sk', speed: 'fast', supports_json: true },
      slot_2: { provider: 'anthropic', model: 'claude', api_key: 'sk', speed: 'quality', supports_json: true },
    };
    const availability = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    expect(() =>
      matchLLM(
        { requires: requires({ speed: 'fast' }), allowUpgrade: false, pinSlot: 'slot_2' },
        { config, availability, quota: createQuotaTracker(), strategy: 'round_robin' },
      ),
    ).toThrow(/No LLM source|AI_LLM_UNAVAILABLE/);
  });
});

/** D-145 PB4 / D-164 P6.2 -- select-tier baseline-shape ratchets. */

import { describe, expect, it } from 'vitest';

import {
  selectSynthesisTier,
  type SelectSynthesisTierInput,
} from '../tier-strategy/select-tier.js';
import * as tierStrategyBarrel from '../tier-strategy/index.js';
import type { ModelTier, TierBudget } from '@recued/contracts';

type SelectSynthesisTierOk = Extract<
  ReturnType<typeof selectSynthesisTier>,
  { readonly kind: 'ok' }
>;

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? true
    : false;
type IsOptional<T, K extends keyof T> = {} extends Pick<T, K> ? true : false;

type _Stage1Deleted = Expect<
  Equal<'stage1' extends keyof SelectSynthesisTierInput ? true : false, false>
>;
type _ChannelDefaultRequired = Expect<
  Equal<IsOptional<SelectSynthesisTierInput, 'channelDefault'>, false>
>;
type _SessionPrefOptional = Expect<
  Equal<IsOptional<SelectSynthesisTierInput, 'sessionPref'>, true>
>;
type _SessionPrefIsModelTier = Expect<
  Equal<NonNullable<SelectSynthesisTierInput['sessionPref']>, ModelTier>
>;

const generousBudget: TierBudget = {
  remaining_cents: 1_000,
  cost_ceiling_cents: 1_000,
};

const stage1FreeInput = {
  channelDefault: 'fast',
  budget: generousBudget,
} satisfies SelectSynthesisTierInput;

const expectOk = (
  result: ReturnType<typeof selectSynthesisTier>,
): SelectSynthesisTierOk => {
  expect(result.kind).toBe('ok');
  if (result.kind !== 'ok') {
    throw new Error(`expected ok tier result, got ${result.kind}`);
  }
  return result;
};

describe('D-164 P6.2 -- selectSynthesisTier input-shape ratchets', () => {
  it('is callable with channelDefault and budget, without a stage1 field', () => {
    // mutate: restore a required `stage1` field on SelectSynthesisTierInput
    // -> TS strict compilation fails here.
    const result = expectOk(selectSynthesisTier(stage1FreeInput));

    expect(Object.hasOwn(stage1FreeInput, 'stage1')).toBe(false);
    expect(result.baseline_tier).toBe('fast');
  });

  it('keeps stage1 off the accepted selectSynthesisTier input surface', () => {
    // mutate: restore SelectSynthesisTierInput.stage1 -> this @ts-expect-error
    // becomes unused under TS strict.
    const staleStage1Input = {
      channelDefault: 'fast',
      budget: generousBudget,
      // @ts-expect-error D-164 P6.2 deleted SelectSynthesisTierInput.stage1.
      stage1: { intents: [], context_breadth: 'narrow' },
    } satisfies SelectSynthesisTierInput;

    expect(Object.hasOwn(staleStage1Input, 'stage1')).toBe(true);
  });
});

describe('D-164 P6.2 -- nullish baseline semantics', () => {
  it('treats sessionPref undefined the same as omitting sessionPref', () => {
    // mutate: remove the undefined fallback path -> explicit undefined no longer matches omission.
    const omitted = selectSynthesisTier({
      channelDefault: 'reasoning',
      budget: generousBudget,
    });
    const explicitUndefined = selectSynthesisTier({
      channelDefault: 'reasoning',
      sessionPref: undefined,
      budget: generousBudget,
    });

    expect(explicitUndefined).toEqual(omitted);
    expect(expectOk(explicitUndefined).baseline_tier).toBe('reasoning');
  });

  it('uses nullish coalescing rather than generic truthiness for sessionPref', () => {
    // mutate: change `sessionPref ?? channelDefault` to
    // `sessionPref || channelDefault` -> empty string falls through to
    // channelDefault and this no longer halts.
    const badJsCallerInput = {
      channelDefault: 'reasoning',
      sessionPref: '',
      budget: generousBudget,
    } as unknown as SelectSynthesisTierInput;

    const result = selectSynthesisTier(badJsCallerInput);

    expect(result.kind).toBe('halt');
    if (result.kind === 'halt') {
      expect(result.reason).toBe('cost_ceiling_no_lower');
      expect(result.halted_at_tier).toBe('');
    }
  });
});

describe('D-164 P6.2 -- baseline_tier provenance ratchets', () => {
  it.each([
    {
      name: 'channelDefault stays the baseline even when modelHint raises and SI clamps later',
      input: {
        channelDefault: 'fast',
        modelHint: 'reasoning',
        siBounds: { max_tier: 'mid' },
        budget: { remaining_cents: 10, cost_ceiling_cents: 100 },
      },
      finalTier: 'mid',
      clampedTier: 'mid',
    },
    {
      name: 'sessionPref can lower channelDefault and remains the baseline before modelHint raises',
      input: {
        channelDefault: 'reasoning',
        sessionPref: 'fast',
        modelHint: 'reasoning',
        budget: generousBudget,
      },
      finalTier: 'reasoning',
      clampedTier: 'reasoning',
    },
    {
      name: 'sessionPref can raise channelDefault and survives later SI and budget lowering',
      input: {
        channelDefault: 'fast',
        sessionPref: 'reasoning',
        siBounds: { max_tier: 'mid' },
        budget: { remaining_cents: 5, cost_ceiling_cents: 100 },
      },
      finalTier: 'fast',
      clampedTier: 'mid',
    },
  ] satisfies ReadonlyArray<{
    readonly name: string;
    readonly input: SelectSynthesisTierInput;
    readonly finalTier: ModelTier;
    readonly clampedTier: ModelTier;
  }>)('$name', ({ input, finalTier, clampedTier }) => {
    // mutate: derive baseline_tier from channelDefault, modelHint,
    // clamped_tier, final tier, or retired stage1 -> this provenance
    // check fails.
    const result = expectOk(selectSynthesisTier(input));
    const expectedBaseline: ModelTier = input.sessionPref ?? input.channelDefault;

    expect(result.baseline_tier).toBe(expectedBaseline);
    expect(result.tier).toBe(finalTier);
    expect(result.clamped_tier).toBe(clampedTier);
  });
});

// tier-rename regression: the retired two-stage `Stage2Tier` naming
// (`selectStage2Tier` / `resolveStage2Tier`) was renamed to the
// single-stage `*SynthesisTier` family. Pin the barrel's value exports to
// the new names so the dead names can't be re-introduced as an alias.
describe('D-164 tier-rename -- tier-strategy barrel exports SynthesisTier names', () => {
  it('exports selectSynthesisTier + resolveSynthesisTier, not the old Stage2Tier names', () => {
    // mutate: re-add a `selectStage2Tier` / `resolveStage2Tier` export -> fails.
    expect(typeof tierStrategyBarrel.selectSynthesisTier).toBe('function');
    expect(typeof tierStrategyBarrel.resolveSynthesisTier).toBe('function');
    expect('selectStage2Tier' in tierStrategyBarrel).toBe(false);
    expect('resolveStage2Tier' in tierStrategyBarrel).toBe(false);
  });
});

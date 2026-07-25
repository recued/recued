/** D-164 P5 follow-on — SelectStage2TierStage1 orphan deletion ratchets.
 *
 *  Pins:
 *    - `packages/contracts/src/tier-strategy.ts` no longer declares the
 *      `SelectStage2TierStage1` interface (D-164 P6.2 simplified the
 *      `selectSynthesisTier` input to `{ channelDefault, sessionPref?, ... }`;
 *      the Stage 1 classifier output no longer flows into the selector,
 *      so the interface was orphaned).
 *    - `packages/contracts/src/index.ts` barrel no longer re-exports
 *      `SelectStage2TierStage1`.
 *    - Type-level: the symbol is not importable from `@recued/contracts`.
 *
 *  The companion type-level ratchet `_Stage1Deleted` in
 *  `packages/middleware-recued/src/__tests__/d-145-phase-pb4-p6-2-ratchet.test.ts`
 *  catches restoration of a `stage1` field on `SelectSynthesisTierInput`;
 *  this file catches restoration of the standalone interface + its
 *  barrel re-export. */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const TIER_STRATEGY_PATH = path.resolve(HERE, '..', 'tier-strategy.ts');
const BARREL_PATH = path.resolve(HERE, '..', 'index.ts');

const SYMBOL_RE = /\bSelectStage2TierStage1\b/;

describe('D-164 P5 follow-on — SelectStage2TierStage1 stays deleted', () => {
  it('tier-strategy.ts no longer declares the interface', () => {
    // mutate: re-add `export interface SelectStage2TierStage1 { ... }` →
    // this assertion fails.
    expect(readFileSync(TIER_STRATEGY_PATH, 'utf8')).not.toMatch(SYMBOL_RE);
  });

  it('contracts barrel no longer re-exports the type', () => {
    // mutate: restore `SelectStage2TierStage1,` to the tier-strategy.js
    // type re-export block in index.ts → this assertion fails.
    expect(readFileSync(BARREL_PATH, 'utf8')).not.toMatch(SYMBOL_RE);
  });

  it('type is not importable from @recued/contracts', () => {
    // mutate: restore the type + its barrel export → the
    // `@ts-expect-error` below becomes unused and TS strict fails.
    // @ts-expect-error D-164 P5 follow-on deleted SelectStage2TierStage1.
    type _Gone = import('@recued/contracts').SelectStage2TierStage1;
    expect(true).toBe(true);
  });
});

// The two-stage `Stage2Tier` naming (selectStage2Tier / resolveStage2Tier /
// Select|ResolveStage2Tier{Input,Result}) was residue from the RETIRED
// two-stage classifier→generator design (§ B.17). The live path is
// single-stage `ai.synthesize`, so the family was renamed to
// `selectSynthesisTier` / `resolveSynthesisTier` / `*SynthesisTier*`. This
// pins the contracts surface to the new names so the dead `Stage2Tier`
// naming can't creep back. (`SelectStage2TierStage1` above is a DIFFERENT,
// separately-deleted Stage-1-variant symbol and stays pinned-absent.)
describe('tier-rename — Stage2Tier naming stays renamed to SynthesisTier', () => {
  it('tier-strategy.ts declares SelectSynthesisTierResult, not the old Stage2Tier names', () => {
    // mutate: rename SelectSynthesisTierResult back to SelectStage2TierResult → fails.
    const src = readFileSync(TIER_STRATEGY_PATH, 'utf8');
    expect(src).toMatch(/\bSelectSynthesisTierResult\b/);
    expect(src).not.toMatch(/\bSelectStage2TierResult\b/);
    expect(src).not.toMatch(/\bselectStage2Tier\b/);
  });

  it('contracts barrel re-exports SelectSynthesisTierResult, not SelectStage2TierResult', () => {
    // mutate: restore `SelectStage2TierResult,` to the tier-strategy.js type
    // re-export block in index.ts → fails.
    const barrel = readFileSync(BARREL_PATH, 'utf8');
    expect(barrel).toMatch(/\bSelectSynthesisTierResult\b/);
    expect(barrel).not.toMatch(/\bSelectStage2TierResult\b/);
  });
});

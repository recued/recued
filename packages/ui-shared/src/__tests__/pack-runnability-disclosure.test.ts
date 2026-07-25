/** R2 build step 4 — shared pack runnability disclosure copy builders.
 *
 *  The consumer surfaces (#recipes route pack modal + Settings → Packs
 *  panel notice) pin the builder + their own renderer END-TO-END; this
 *  file pins the builder edge cases independent of any renderer —
 *  especially the fallback branches a consumer fixture may not reach:
 *  cross-provider spread (unsatisfied with empty unprovided_ops), the
 *  no-line install-item fallback, omitted result fields, and the
 *  satisfied-dependency filter. */

import { describe, expect, it } from 'vitest';
import type {
  BulkPackInstallResultLike,
  BulkPackUninstallResultLike,
  DependencyResolution,
  RecipeRunnabilityEntry,
} from '@recued/contracts';

import {
  installDisclosureBlocks,
  runnabilityDisclosureLines,
  uninstallDisclosureBlocks,
} from '../install/pack-runnability-disclosure.js';

const dep = (
  overrides: Partial<DependencyResolution> = {},
): DependencyResolution => ({
  capability: 'deal',
  ops: ['search'],
  optional: false,
  satisfied: false,
  providers: [],
  unprovided_ops: ['search'],
  ...overrides,
});

const entry = (
  recipe_id: string,
  dependencies: DependencyResolution[],
  status: RecipeRunnabilityEntry['status'] = 'blocked',
): RecipeRunnabilityEntry => ({ recipe_id, status, dependencies });

const okInstall = (
  overrides: Partial<BulkPackInstallResultLike> = {},
): BulkPackInstallResultLike => ({
  ok: true,
  installed: [],
  rolled_back: [],
  ...overrides,
});

const okUninstall = (
  overrides: Partial<BulkPackUninstallResultLike> = {},
): BulkPackUninstallResultLike => ({
  ok: true,
  removed: { recipes: [], body_grants: [] },
  ...overrides,
});

describe('runnabilityDisclosureLines', () => {
  it('renders one line per UNSATISFIED dependency, skipping satisfied ones', () => {
    const lines = runnabilityDisclosureLines(
      entry('r', [
        dep({ capability: 'mail', ops: ['read'], satisfied: true, unprovided_ops: [] }),
        dep(),
        dep({ capability: 'contact', ops: ['enrich'], optional: true, unprovided_ops: ['enrich'] }),
      ]),
    );
    expect(lines).toEqual([
      'Add a provider for deal.search.',
      'Add a provider for contact.enrich (optional — those steps skip).',
    ]);
  });

  it('falls back to the full op list on cross-provider spread (empty unprovided_ops)', () => {
    const lines = runnabilityDisclosureLines(
      entry('r', [dep({ ops: ['search', 'update'], unprovided_ops: [] })]),
    );
    expect(lines).toEqual([
      'No single connected provider covers all of deal.search, deal.update.',
    ]);
  });
});

describe('installDisclosureBlocks', () => {
  it('returns blocked-then-degraded blocks with per-recipe detail', () => {
    const blocks = installDisclosureBlocks(
      okInstall({
        born_blocked: [entry('a', [dep()])],
        born_degraded: [
          entry('b', [dep({ optional: true })], 'degraded'),
          entry('c', [dep({ optional: true })], 'degraded'),
        ],
      }),
    );
    expect(blocks.map((b) => b.kind)).toEqual(['born-blocked', 'born-degraded']);
    expect(blocks[0]!.headline).toBe(
      'This pack added 1 recipe that cannot run until a provider is connected:',
    );
    expect(blocks[0]!.items).toEqual([
      { recipe_id: 'a', detail: 'Add a provider for deal.search.' },
    ]);
    expect(blocks[1]!.headline).toBe(
      '2 recipes will run with an optional capability skipped:',
    );
  });

  it('falls back to the generic detail when an entry carries no unsatisfied lines', () => {
    const blocks = installDisclosureBlocks(
      okInstall({ born_blocked: [entry('a', [])] }),
    );
    expect(blocks[0]!.items[0]!.detail).toBe(
      'a declared dependency has no provider.',
    );
  });

  it('returns no blocks when the fields are omitted or empty', () => {
    expect(installDisclosureBlocks(okInstall())).toEqual([]);
    expect(
      installDisclosureBlocks(okInstall({ born_blocked: [], born_degraded: [] })),
    ).toEqual([]);
  });
});

describe('uninstallDisclosureBlocks', () => {
  it('returns one would-disable block; degraded-before items carry the qualifier', () => {
    const blocks = uninstallDisclosureBlocks(
      okUninstall({
        would_disable: [
          { recipe_id: 'a', before: 'runnable', after: 'blocked' },
          { recipe_id: 'b', before: 'degraded', after: 'blocked' },
        ],
      }),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe('would-disable');
    expect(blocks[0]!.headline).toBe(
      'This disabled 2 recipes that lost their last provider — they stay installed and recover when a provider is connected:',
    );
    expect(blocks[0]!.items).toEqual([
      { recipe_id: 'a', detail: '' },
      { recipe_id: 'b', detail: 'was already degraded.' },
    ]);
  });

  it('returns no blocks when would_disable is omitted or empty', () => {
    expect(uninstallDisclosureBlocks(okUninstall())).toEqual([]);
    expect(
      uninstallDisclosureBlocks(okUninstall({ would_disable: [] })),
    ).toEqual([]);
  });

  it('returns a would-degrade block for degraded survivors (§1.6 follow-on)', () => {
    const blocks = uninstallDisclosureBlocks(
      okUninstall({
        would_degrade: [{ recipe_id: 'a', before: 'runnable', after: 'degraded' }],
      }),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe('would-degrade');
    expect(blocks[0]!.headline).toBe(
      '1 recipe lost an optional capability — they keep running with those steps skipped, and recover when a provider is connected:',
    );
    expect(blocks[0]!.items).toEqual([{ recipe_id: 'a', detail: '' }]);
  });

  it('orders disable-then-degrade when both fields are present (mirrors install)', () => {
    const blocks = uninstallDisclosureBlocks(
      okUninstall({
        would_disable: [{ recipe_id: 'a', before: 'runnable', after: 'blocked' }],
        would_degrade: [
          { recipe_id: 'b', before: 'runnable', after: 'degraded' },
          { recipe_id: 'c', before: 'runnable', after: 'degraded' },
        ],
      }),
    );
    expect(blocks.map((b) => b.kind)).toEqual(['would-disable', 'would-degrade']);
    expect(blocks[1]!.headline).toBe(
      '2 recipes lost an optional capability — they keep running with those steps skipped, and recover when a provider is connected:',
    );
    expect(blocks[1]!.items.map((i) => i.recipe_id)).toEqual(['b', 'c']);
  });

  it('an empty would_degrade beside a populated would_disable yields only the disable block', () => {
    const blocks = uninstallDisclosureBlocks(
      okUninstall({
        would_disable: [{ recipe_id: 'a', before: 'runnable', after: 'blocked' }],
        would_degrade: [],
      }),
    );
    expect(blocks.map((b) => b.kind)).toEqual(['would-disable']);
  });
});

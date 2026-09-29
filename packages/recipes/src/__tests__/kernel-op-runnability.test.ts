/** D-182 §10 step 8 / R1 — unit tests for the recipe-level verb-split.
 *
 *  `applyKernelOpRunnability` walks a recipe's `core.crm.*`/`core.acct.*`
 *  op-steps against the bound connection families: an unbound read/search is
 *  rewritten to an empty-result step + warned; an unbound write/destructive
 *  blocks; a bound / closed-kind / non-kernel / Tier-P op is untouched.
 */
import { describe, expect, it } from 'vitest';

import type { KernelConnectionFamily, RecipeDefinition, RecipeStep } from '@recued/contracts';

import { applyKernelOpRunnability } from '../kernel-op-runnability.js';

const NONE = new Set<KernelConnectionFamily>();
const CRM = new Set<KernelConnectionFamily>(['crm']);
const ACCT = new Set<KernelConnectionFamily>(['acct']);

/** A minimal recipe with the given steps. */
const recipeWith = (steps: RecipeStep[]): RecipeDefinition =>
  ({
    recipe_id: 'r1-unit',
    version: 1,
    ttl: 300,
    metadata: { name: 'r1-unit', description: 'unit', author: 'test', supported_platforms: [] },
    variables: { crm: { type: 'connection' } },
    steps,
    output: { sidebar: [] },
  }) as unknown as RecipeDefinition;

const opStep = (id: string, op: string, extra: Record<string, unknown> = {}): RecipeStep =>
  ({ id, op, args: { limit: 10 }, ...extra }) as unknown as RecipeStep;

describe('applyKernelOpRunnability — R1 verb-split (§10 step 8)', () => {
  describe('unbound canonical READ → empty result + warning (recipe continues)', () => {
    it('rewrites core.crm.deal.search to an empty-array default step, keeping the id', () => {
      const res = applyKernelOpRunnability(recipeWith([opStep('deals', 'core.crm.deal.search')]), NONE);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const step = res.recipe.steps[0] as unknown as Record<string, unknown>;
      expect(step.id).toBe('deals');
      expect(step.transform).toBe('default');
      expect(step.value).toEqual([]); // search → collection
      expect('op' in step).toBe(false); // the op-step is gone
      expect(res.warnings).toHaveLength(1);
      expect(res.warnings[0]).toMatchObject({ step_id: 'deals', op: 'core.crm.deal.search' });
      expect(res.warnings[0].warning).toMatch(/crm not connected/i);
    });

    it('a READ verb (single record) empties to {} not []', () => {
      const res = applyKernelOpRunnability(recipeWith([opStep('deal', 'core.crm.deal.read')]), NONE);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect((res.recipe.steps[0] as unknown as Record<string, unknown>).value).toEqual({});
    });

    it('core.acct.invoice.search with no acct bound → empty []', () => {
      const res = applyKernelOpRunnability(recipeWith([opStep('inv', 'core.acct.invoice.search')]), NONE);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect((res.recipe.steps[0] as unknown as Record<string, unknown>).value).toEqual([]);
      expect(res.warnings[0].warning).toMatch(/acct not connected/i);
    });

    it('preserves skip_when / stop_when on the rewritten empty step; drops args/fail_on', () => {
      const res = applyKernelOpRunnability(
        recipeWith([opStep('deals', 'core.crm.deal.search', {
          skip_when: '{{config.x}} equal true',
          fail_on: '{{step.deals}} is_empty',
          stop_when: '{{step.deals}} is_empty',
        })]),
        NONE,
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const step = res.recipe.steps[0] as unknown as Record<string, unknown>;
      expect(step.skip_when).toBe('{{config.x}} equal true');
      expect('fail_on' in step).toBe(false); // dropped — empty must not trip is_empty
      // kept — stopping on the empty stand-in is a success, the downstream-safe direction
      expect(step.stop_when).toBe('{{step.deals}} is_empty');
      expect('args' in step).toBe(false);
    });
  });

  describe('unbound canonical WRITE / destructive → fail closed (block)', () => {
    it('core.crm.deal.create with no CRM bound → ok:false, blocked', () => {
      const res = applyKernelOpRunnability(recipeWith([opStep('mk', 'core.crm.deal.create')]), NONE);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.blocked).toHaveLength(1);
      expect(res.blocked[0]).toMatchObject({ step_id: 'mk', op: 'core.crm.deal.create' });
    });

    it('core.crm.deal.delete with no CRM bound → ok:false', () => {
      const res = applyKernelOpRunnability(recipeWith([opStep('rm', 'core.crm.deal.delete')]), NONE);
      expect(res.ok).toBe(false);
    });

    it('a MALFORMED unbound canonical read BLOCKS (never silently emptied)', () => {
      // `invoice` is not a crm_alias — a typo'd op must fail closed, not yield [].
      const res = applyKernelOpRunnability(recipeWith([opStep('x', 'core.crm.invoice.search')]), NONE);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.blocked.map((b) => b.op)).toEqual(['core.crm.invoice.search']);
    });

    it('a mixed recipe (bound-family read + unbound-family write) BLOCKS — write wins', () => {
      // CRM bound (its read is fine) but ACCT unbound → the acct write blocks.
      const res = applyKernelOpRunnability(
        recipeWith([
          opStep('deals', 'core.crm.deal.search'),
          opStep('mkInvoice', 'core.acct.invoice.create'),
        ]),
        CRM,
      );
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.blocked.map((b) => b.op)).toEqual(['core.acct.invoice.create']);
    });
  });

  describe('untouched: bound / closed-kind / non-kernel / Tier-P / transform', () => {
    it('a BOUND canonical op is left as the op-step (returns the same recipe ref)', () => {
      const input = recipeWith([opStep('deals', 'core.crm.deal.search')]);
      const res = applyKernelOpRunnability(input, CRM);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.recipe).toBe(input); // identity preserved — nothing rewritten
      expect(res.warnings).toHaveLength(0);
      expect((res.recipe.steps[0] as unknown as Record<string, unknown>).op).toBe('core.crm.deal.search');
    });

    it('a closed-kind kernel op (core.ai.summarize) is never touched', () => {
      const input = recipeWith([opStep('sum', 'core.ai.summarize')]);
      const res = applyKernelOpRunnability(input, NONE);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.recipe).toBe(input);
      expect((res.recipe.steps[0] as unknown as Record<string, unknown>).op).toBe('core.ai.summarize');
    });

    it('a bare legacy canonical op (deal.search) is NOT a kernel op → untouched', () => {
      const input = recipeWith([opStep('deals', 'deal.search')]);
      const res = applyKernelOpRunnability(input, NONE);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.recipe).toBe(input);
      expect((res.recipe.steps[0] as unknown as Record<string, unknown>).op).toBe('deal.search');
    });

    it('a Tier-P pack op is untouched', () => {
      const input = recipeWith([opStep('t', 'recued-core.whisper.audio.transcribe')]);
      const res = applyKernelOpRunnability(input, NONE);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.recipe).toBe(input);
    });

    it('a transform step is untouched', () => {
      const input = recipeWith([
        { id: 'noop', transform: 'trim', value: 'x' } as unknown as RecipeStep,
      ]);
      const res = applyKernelOpRunnability(input, NONE);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.recipe).toBe(input);
    });

    it('acct bound lifts an acct read; crm-only-bound does NOT', () => {
      const recipe = recipeWith([opStep('inv', 'core.acct.invoice.search')]);
      expect(applyKernelOpRunnability(recipe, ACCT).ok).toBe(true);
      const acctBound = applyKernelOpRunnability(recipe, ACCT);
      if (acctBound.ok) expect(acctBound.recipe).toBe(recipe); // untouched when bound
      const crmOnly = applyKernelOpRunnability(recipe, CRM);
      if (crmOnly.ok) expect(crmOnly.warnings).toHaveLength(1); // acct still unbound → empty+warn
    });
  });
});

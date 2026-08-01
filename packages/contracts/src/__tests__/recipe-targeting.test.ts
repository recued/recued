/** Entity-targeting rule (design § 8) — derivation + assessment + message.
 *
 *  The corpus calibration behind the prongs (2026-06-10, 165 community
 *  recipes): 69 targeted, ALL via non-engine `context.*` refs (almost all
 *  `context.entity_id`); zero op-steps with caller-fed selectors yet
 *  (canonical-pack world still arriving); zero null-guarded context
 *  targets. The fixtures mirror those shapes.
 */
import { describe, expect, it } from 'vitest';
import {
  assessRunTargets,
  buildTargetRequiredMessage,
  deriveRecipeTargeting,
} from '../recipe-targeting.js';

/** Minimal corpus-shaped targeted recipe — `context.entity_id` feeding a
 *  prefetch read (the assess-deal-risk-hubspot shape). */
const contextTargeted = {
  recipe_id: 'assess-deal-risk-hubspot',
  variables: {},
  prefetch_steps: [
    {
      id: 'deal',
      ingredient: 'deal-reader-hubspot',
      input: { deal_id: '{{context.entity_id}}' },
    },
  ],
  steps: [{ id: 'score', ingredient: 'ai-score', input: { 'llm.data': '{{step.deal}}' } }],
  output: { sidebar: [] },
};

describe('deriveRecipeTargeting — context prong', () => {
  it('flags a non-engine context ref as a context target', () => {
    const targeting = deriveRecipeTargeting(contextTargeted);
    expect(targeting.targeted).toBe(true);
    expect(targeting.targets).toEqual([{ kind: 'context', key: 'entity_id' }]);
  });

  it('collects multiple roots sorted and deduped across phases + output', () => {
    const targeting = deriveRecipeTargeting({
      recipe_id: 'r',
      trigger_steps: [{ id: 't', ingredient: 'x', input: { v: '{{context.zeta}}' } }],
      steps: [{ id: 's', ingredient: 'x', input: { a: '{{context.alpha}}', b: '{{context.alpha}}' } }],
      output: { sidebar: [{ title: '{{context.email_body}}' }] },
    });
    expect(targeting.targets.map((t) => t.key)).toEqual(['alpha', 'email_body', 'zeta']);
  });

  it('never counts engine/client-injected fields (tabs/server/bridge/event/recipe/caller)', () => {
    const targeting = deriveRecipeTargeting({
      recipe_id: 'reactive-recipe',
      steps: [
        {
          id: 's',
          ingredient: 'x',
          input: {
            a: '{{context.event.payload.record.stage}}',
            b: '{{context.server.available}}',
            c: '{{context.tabs}}',
            d: '{{context.bridge.online}}',
            e: '{{context.recipe.prev_total}}',
            f: '{{context.caller.contract_id}}',
          },
        },
      ],
    });
    expect(targeting).toEqual({ targeted: false, targets: [] });
  });

  it('a ref used only inside skip_when/fail_on conditions is gating, not a target', () => {
    const targeting = deriveRecipeTargeting({
      recipe_id: 'r',
      steps: [
        { id: 's', ingredient: 'x', skip_when: '{{context.entity_id}} is_null', input: { q: 'static' } },
        { id: 'f', ingredient: 'y', fail_on: '{{context.flag}} equal true', input: { q: 'static' } },
      ],
    });
    expect(targeting).toEqual({ targeted: false, targets: [] });
  });

  it('a skip_when absence-guard exempts the root even when other steps consume it', () => {
    const targeting = deriveRecipeTargeting({
      recipe_id: 'null-safe',
      steps: [
        { id: 'read', ingredient: 'x', skip_when: '{{context.entity_id}} is_null', input: { id: '{{context.entity_id}}' } },
        { id: 'fallback', ingredient: 'search', skip_when: '{{context.entity_id}} is_not_null', input: { q: 'all' } },
      ],
    });
    expect(targeting.targeted).toBe(false);
  });

  it('object-form skip_when absence-guards exempt too (is_empty included)', () => {
    const targeting = deriveRecipeTargeting({
      recipe_id: 'null-safe-obj',
      steps: [
        {
          id: 'read',
          ingredient: 'x',
          skip_when: { field: '{{context.entity_id}}', operator: 'is_empty' },
          input: { id: '{{context.entity_id}}' },
        },
      ],
    });
    expect(targeting.targeted).toBe(false);
  });

  it('a fail_on null-check is an authored REQUIREMENT — stays targeted', () => {
    const targeting = deriveRecipeTargeting({
      recipe_id: 'fail-loud',
      steps: [
        { id: 'read', ingredient: 'x', fail_on: '{{context.entity_id}} is_null', input: { id: '{{context.entity_id}}' } },
      ],
    });
    expect(targeting.targets).toEqual([{ kind: 'context', key: 'entity_id' }]);
  });

  it('a non-absence skip_when does not exempt (equal / contains gates keep the target)', () => {
    const targeting = deriveRecipeTargeting({
      recipe_id: 'gated',
      steps: [
        { id: 'read', ingredient: 'x', skip_when: '{{context.entity_id}} equal skip-me', input: { id: '{{context.entity_id}}' } },
      ],
    });
    expect(targeting.targeted).toBe(true);
  });
});

describe('deriveRecipeTargeting — op prong', () => {
  const opRecipe = (op: string, id: unknown, variables: Record<string, unknown> = { deal_id: null }) => ({
    recipe_id: 'canonical',
    variables,
    steps: [{ id: 'act', op, args: { id } }],
  });

  it('read/update/delete with a required-variable selector is a config target', () => {
    for (const op of ['deal.read', 'deal.update', 'contact.delete']) {
      const targeting = deriveRecipeTargeting(opRecipe(op, '{{config.deal_id}}'));
      expect(targeting.targets).toEqual([{ kind: 'config', key: 'deal_id' }]);
    }
  });

  it('a defaulted variable selector is self-sufficient — not a target', () => {
    expect(
      deriveRecipeTargeting(opRecipe('deal.read', '{{config.deal_id}}', { deal_id: 'd-1' })).targeted,
    ).toBe(false);
    expect(
      deriveRecipeTargeting(
        opRecipe('deal.read', '{{config.deal_id}}', { deal_id: { label: 'Deal', type: 'text', default: 'd-1' } }),
      ).targeted,
    ).toBe(false);
    expect(
      deriveRecipeTargeting(
        opRecipe('deal.read', '{{config.deal_id}}', { deal_id: { label: 'Deal', type: 'text', optional: true } }),
      ).targeted,
    ).toBe(false);
  });

  it('a required ValueHint variable selector IS a target', () => {
    const targeting = deriveRecipeTargeting(
      opRecipe('deal.read', '{{config.deal_id}}', { deal_id: { label: 'Deal', type: 'text' } }),
    );
    expect(targeting.targets).toEqual([{ kind: 'config', key: 'deal_id' }]);
  });

  it('search/create ops never target; self-resolving selectors never target', () => {
    expect(deriveRecipeTargeting(opRecipe('deal.search', '{{config.deal_id}}')).targeted).toBe(false);
    expect(deriveRecipeTargeting(opRecipe('deal.create', '{{config.deal_id}}')).targeted).toBe(false);
    expect(deriveRecipeTargeting(opRecipe('deal.update', '{{step.found.id}}')).targeted).toBe(false);
    expect(deriveRecipeTargeting(opRecipe('deal.update', '{{item.id}}')).targeted).toBe(false);
    expect(deriveRecipeTargeting(opRecipe('deal.read', 'deal-123')).targeted).toBe(false);
  });

  it('a context-fed selector lands as a context target (dedup with the context prong)', () => {
    const targeting = deriveRecipeTargeting(opRecipe('deal.read', '{{context.entity_id}}', {}));
    expect(targeting.targets).toEqual([{ kind: 'context', key: 'entity_id' }]);
  });
});

describe('deriveRecipeTargeting — page prong + shape trust', () => {
  it('a page trigger is a target', () => {
    const targeting = deriveRecipeTargeting({
      recipe_id: 'on-page',
      trigger: ['app.hubspot.com/contacts/*/deal/*'],
      steps: [{ id: 's', ingredient: 'draft-email-reader-hubspot' }],
    });
    expect(targeting.targets).toEqual([{ kind: 'page', key: 'page' }]);
  });

  it('page + context targets order: context first, page last', () => {
    const targeting = deriveRecipeTargeting({
      ...contextTargeted,
      trigger: ['app.hubspot.com/*'],
    });
    expect(targeting.targets).toEqual([
      { kind: 'context', key: 'entity_id' },
      { kind: 'page', key: 'page' },
    ]);
  });

  it('an empty trigger list is manual-only, not page-targeted', () => {
    expect(deriveRecipeTargeting({ recipe_id: 'r', trigger: [], steps: [] }).targeted).toBe(false);
  });

  it('trusts malformed input — never throws', () => {
    for (const bad of [null, undefined, 'text', 42, [], { steps: 'nope' }, { steps: [null, 7] }]) {
      expect(deriveRecipeTargeting(bad)).toEqual({ targeted: false, targets: [] });
    }
  });
});

describe('assessRunTargets', () => {
  const targeting = deriveRecipeTargeting(contextTargeted);

  it('non-targeted recipes always pass', () => {
    expect(assessRunTargets({ targeted: false, targets: [] }, undefined, undefined)).toEqual({
      ok: true,
      missing: [],
    });
  });

  it('missing context target blocks; supplied passes', () => {
    expect(assessRunTargets(targeting, undefined, undefined).ok).toBe(false);
    expect(assessRunTargets(targeting, undefined, {}).missing).toEqual([
      { kind: 'context', key: 'entity_id' },
    ]);
    expect(assessRunTargets(targeting, undefined, { entity_id: '12345' }).ok).toBe(true);
  });

  it('empty-string / null targets count as absent', () => {
    expect(assessRunTargets(targeting, undefined, { entity_id: '' }).ok).toBe(false);
    expect(assessRunTargets(targeting, undefined, { entity_id: '   ' }).ok).toBe(false);
    expect(assessRunTargets(targeting, undefined, { entity_id: null }).ok).toBe(false);
    expect(assessRunTargets(targeting, undefined, { entity_id: 0 }).ok).toBe(true);
  });

  it('config targets read from config', () => {
    const t = { targeted: true, targets: [{ kind: 'config', key: 'deal_id' } as const] };
    expect(assessRunTargets(t, undefined, undefined).ok).toBe(false);
    expect(assessRunTargets(t, { deal_id: 'd-1' }, undefined).ok).toBe(true);
  });

  it('page target: satisfied by non-empty context.tabs', () => {
    const t = { targeted: true, targets: [{ kind: 'page', key: 'page' } as const] };
    expect(assessRunTargets(t, undefined, undefined).ok).toBe(false);
    expect(assessRunTargets(t, undefined, { tabs: [] }).ok).toBe(false);
    expect(assessRunTargets(t, undefined, { tabs: ['draft-email-reader-hubspot'] }).ok).toBe(true);
  });

  it('page target: satisfied when all context targets arrived another way (the chat route)', () => {
    const both = deriveRecipeTargeting({ ...contextTargeted, trigger: ['app.hubspot.com/*'] });
    expect(assessRunTargets(both, undefined, { entity_id: '123' }).ok).toBe(true);
    const blocked = assessRunTargets(both, undefined, {});
    expect(blocked.missing).toEqual([
      { kind: 'context', key: 'entity_id' },
      { kind: 'page', key: 'page' },
    ]);
  });

  it('page-only recipes are NOT satisfied by unrelated context fields', () => {
    const t = { targeted: true, targets: [{ kind: 'page', key: 'page' } as const] };
    expect(assessRunTargets(t, undefined, { entity_id: '123' }).ok).toBe(false);
  });
});

describe('buildTargetRequiredMessage', () => {
  it('names the exact context key to pass', () => {
    const message = buildTargetRequiredMessage('assess-deal-risk-hubspot', [
      { kind: 'context', key: 'entity_id' },
    ]);
    expect(message).toContain("Recipe 'assess-deal-risk-hubspot' needs a target record");
    expect(message).toContain('context.entity_id');
    expect(message).toContain('re-run');
  });

  it('joins multiple keys across namespaces', () => {
    const message = buildTargetRequiredMessage('r', [
      { kind: 'context', key: 'entity_id' },
      { kind: 'config', key: 'deal_id' },
    ]);
    expect(message).toContain('context.entity_id and config.deal_id');
  });

  it('page-only gets the routing guidance, not the key sentence', () => {
    const message = buildTargetRequiredMessage('on-page', [{ kind: 'page', key: 'page' }]);
    expect(message).toContain('open the page in a connected browser');
    expect(message).not.toContain('needs a target record —');
  });

  it('page alongside context keys folds into the key sentence', () => {
    const message = buildTargetRequiredMessage('r', [
      { kind: 'context', key: 'entity_id' },
      { kind: 'page', key: 'page' },
    ]);
    expect(message).toContain('context.entity_id');
  });
});

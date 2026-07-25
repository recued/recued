import { describe, it, expect } from 'vitest';
import { validateRecipePublishPolicy } from '../validate-recipe-publish-policy.js';
import type { RecipeDefinition, RecipeStep, PrefetchStep } from '@recued/contracts';

const base = (over: Partial<RecipeDefinition>): RecipeDefinition =>
  ({
    recipe_id: 'r',
    version: 1,
    ttl: 60,
    metadata: { name: 'r', description: 'x', author: 'a', supported_platforms: [] },
    prefetch_steps: [],
    steps: [],
    output: { sidebar: [] },
    ...over,
  }) as unknown as RecipeDefinition;

const slugs = (r: ReturnType<typeof validateRecipePublishPolicy>) =>
  r.violations.map((v) => v.slug).sort();

describe('§5 validateRecipePublishPolicy', () => {
  it('ACCEPTS a recipe of only transforms + guards', () => {
    const r = validateRecipePublishPolicy(base({
      steps: [
        { id: 'f', transform: 'filter', array: '{{step.x}}' },
        { id: 'g', guard: '{{step.f}} is_empty' },
      ] as RecipeStep[],
    }));
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('ACCEPTS a canonical op-step (the pack-bound richer-kind path)', () => {
    const r = validateRecipePublishPolicy(base({
      steps: [{ id: 'deals', op: 'deal.search' }] as RecipeStep[],
    }));
    expect(r.ok).toBe(true);
  });

  it('ACCEPTS a §5 tool op-step (web egress reaches a published recipe only as a pack op)', () => {
    // The seam's whole point: a richer kind like web search (`search-exa`, REJECTED
    // as a direct ingredient below) becomes publishable as a pack-bound TOOL op-step
    // (`web.search`). The gate is structural — any `op` step passes — so the kind
    // stays on the pack catalog, gated at the gateway, never a direct ingredient.
    const r = validateRecipePublishPolicy(base({
      steps: [{ id: 'news', op: 'web.search' }] as RecipeStep[],
    }));
    expect(r.ok).toBe(true);
  });

  it('ACCEPTS direct core-* capability ingredient steps', () => {
    const r = validateRecipePublishPolicy(base({
      steps: [
        { id: 'c', ingredient: 'core-ai-classify', input: { 'llm.data': 'x', 'llm.categories': ['a'] } },
        { id: 'n', ingredient: 'core-notification-send', input: { channels: ['in_app'], text: 'hi' } },
        { id: 'm', ingredient: 'core-mail-post', input: {} },
        { id: 's', ingredient: 'core-slack-post', input: {} },
      ] as RecipeStep[],
    }));
    expect(r.ok).toBe(true);
  });

  it('ACCEPTS a mixed op-step + transform + core ingredient recipe', () => {
    const r = validateRecipePublishPolicy(base({
      prefetch_steps: [{ id: 'p', op: 'deal.search' }] as unknown as PrefetchStep[],
      steps: [
        { id: 'f', transform: 'filter', array: '{{step.p}}' },
        { id: 'c', ingredient: 'core-ai-classify', input: {} },
      ] as RecipeStep[],
    }));
    expect(r.ok).toBe(true);
  });

  it('REJECTS a bare richer-kind ingredient (must be packaged)', () => {
    const r = validateRecipePublishPolicy(base({
      steps: [{ id: 'enrich', ingredient: 'http-fetch', input: {} }] as RecipeStep[],
    }));
    expect(r.ok).toBe(false);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].step_id).toBe('enrich');
    expect(r.violations[0].slug).toBe('http-fetch');
    expect(r.violations[0].reason).toContain('pack');
  });

  it('REJECTS a bare (un-prefixed) contracted slug — core capabilities must be prefixed', () => {
    const r = validateRecipePublishPolicy(base({
      steps: [{ id: 'c', ingredient: 'ai-classify', input: {} }] as RecipeStep[],
    }));
    expect(r.ok).toBe(false);
    expect(slugs(r)).toEqual(['ai-classify']);
  });

  it('REJECTS richer kinds: dom / mcp / ai-prompt / search-exa', () => {
    const r = validateRecipePublishPolicy(base({
      steps: [
        { id: 'd', ingredient: 'draft-email-reader-hubspot', input: {} },
        { id: 'm', ingredient: 'mcp-tool', input: {} },
        { id: 'p', ingredient: 'ai-prompt', input: {} },
        { id: 'x', ingredient: 'search-exa', input: {} },
      ] as RecipeStep[],
    }));
    expect(r.ok).toBe(false);
    expect(slugs(r)).toEqual(['ai-prompt', 'draft-email-reader-hubspot', 'mcp-tool', 'search-exa']);
  });

  it('REJECTS a core-prefixed slug that is NOT a known capability (no smuggling)', () => {
    const r = validateRecipePublishPolicy(base({
      steps: [
        { id: 'h', ingredient: 'core-http-fetch', input: {} }, // not a known core capability
      ] as RecipeStep[],
    }));
    expect(r.ok).toBe(false);
    expect(slugs(r)).toEqual(['core-http-fetch']);
  });

  it('ACCEPTS core-ai-prompt (admitted to the capability set; web-search egress neutralized)', () => {
    const r = validateRecipePublishPolicy(base({
      steps: [{ id: 'p', ingredient: 'core-ai-prompt', input: {} }] as RecipeStep[],
    }));
    expect(r.ok).toBe(true);
  });

  it('REJECTS a {{ref}}-valued ingredient (unverifiable — fail closed)', () => {
    const r = validateRecipePublishPolicy(base({
      steps: [{ id: 'dyn', ingredient: '{{config.slug}}', input: {} }] as RecipeStep[],
    }));
    expect(r.ok).toBe(false);
    expect(r.violations[0].slug).toBe('{{config.slug}}');
  });

  it('fires across prefetch_steps and trigger_steps, not just steps', () => {
    const r = validateRecipePublishPolicy(base({
      prefetch_steps: [{ id: 'pf', ingredient: 'http-fetch' }] as unknown as PrefetchStep[],
      trigger_steps: [{ id: 'tg', ingredient: 'dom-reader' }] as unknown as RecipeStep[],
      steps: [{ id: 'ok', ingredient: 'core-ai-classify' }] as RecipeStep[],
    }));
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.step_id).sort()).toEqual(['pf', 'tg']);
  });

  it('fails closed on an unrecognized step shape', () => {
    const r = validateRecipePublishPolicy(base({
      steps: [{ id: 'weird', foo: 'bar' } as unknown as RecipeStep],
    }));
    expect(r.ok).toBe(false);
    expect(r.violations[0].step_id).toBe('weird');
  });

  it('fails closed on an ambiguous dual-key step (richer ingredient masked by transform)', () => {
    // A future direct caller might skip parseRecipe; a step carrying BOTH transform
    // and a richer ingredient must NOT pass as a transform.
    const r = validateRecipePublishPolicy(base({
      steps: [{ id: 'sneaky', transform: 'map', ingredient: 'search-exa', input: {} } as unknown as RecipeStep],
    }));
    expect(r.ok).toBe(false);
    expect(r.violations[0].step_id).toBe('sneaky');
    expect(r.violations[0].reason).toContain('ambiguous');
  });

  it('fails closed on an op-step that also carries a richer ingredient', () => {
    const r = validateRecipePublishPolicy(base({
      steps: [{ id: 'amb', op: 'deal.search', ingredient: 'search-exa' } as unknown as RecipeStep],
    }));
    expect(r.ok).toBe(false);
  });

  // ── event_triggers: dom watches are barred from published recipes ──
  it('REJECTS a dom-watch sugar trigger (must ship in a pack)', () => {
    const r = validateRecipePublishPolicy(base({
      event_triggers: [
        { on: 'element.changed', url: 'https://app.hubspot.com/contacts/*', selector: '#deal-amount' },
      ],
    } as Partial<RecipeDefinition>));
    expect(r.ok).toBe(false);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].step_id).toBe('event_triggers[0]');
    expect(r.violations[0].slug).toBe('<dom-watch>');
    expect(r.violations[0].reason).toContain('pack');
  });

  it('REJECTS a raw data.dom.* event-pattern trigger', () => {
    const r = validateRecipePublishPolicy(base({
      event_triggers: [{ event: 'data.dom.element.abc.updated' }],
    } as Partial<RecipeDefinition>));
    expect(r.ok).toBe(false);
    expect(r.violations[0].step_id).toBe('event_triggers[0]');
  });

  it('ACCEPTS managed data / push triggers and the accepted-response reader', () => {
    const r = validateRecipePublishPolicy(base({
      prefetch_steps: [{
        id: 'form_response',
        op: 'core.data.form-response.get',
        args: { submission_id: '{{context.event.payload.record_id}}' },
      }] as unknown as PrefetchStep[],
      event_triggers: [
        { event: 'data.connection.api.hubspot.deal.**.updated' },
        { on: 'deal.changed' },
        { on: 'message.received' },
        { on: 'form_response.accepted' },
        { event: 'data.mail.**.created' },
      ],
    } as Partial<RecipeDefinition>));
    expect(r.ok).toBe(true);
  });

  it('reports the offending dom trigger by index, alongside step violations', () => {
    const r = validateRecipePublishPolicy(base({
      steps: [{ id: 'enrich', ingredient: 'http-fetch', input: {} }] as RecipeStep[],
      event_triggers: [
        { on: 'deal.changed' },
        { on: 'element.changed', url: 'https://x.test/*', selector: '#a' },
      ],
    } as Partial<RecipeDefinition>));
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.step_id).sort()).toEqual(['enrich', 'event_triggers[1]']);
  });
});

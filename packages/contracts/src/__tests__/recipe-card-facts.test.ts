/** `recipe-card-facts.ts` — the card's channel and enrichment pills, derived
 *  from a recipe BODY. The server projects these onto `recipe.list` rows;
 *  these tests pin the derivation both ends share. */

import { describe, expect, it } from 'vitest';

import { recipeConsumedEnrichments, recipeNotificationChannels } from '../recipe-card-facts.js';

/** Refs that live only in `steps`, where the shipped corpus keeps them. */
const recipeWithRefsInSteps = {
  recipe_id: 'deal-alert',
  version: 1,
  metadata: { name: 'Deal alert', description: 'Tell me.', author: 'acme', supported_platforms: [] },
  variables: {},
  steps: [
    { id: 'score', op: 'core.data.read', args: { ref: '{{data.enrichment.contact.alice.deal_risk}}' } },
    { id: 'again', op: 'core.data.read', args: { ref: '{{data.enrichment.contact.alice.deal_risk}}' } },
    { id: 'notify', op: 'notification.slack.post', args: { text: 'heads up' } },
  ],
  output: { render: [] },
};

describe('recipeNotificationChannels', () => {
  it('finds a channel named in steps, in vocabulary order', () => {
    expect(recipeNotificationChannels(recipeWithRefsInSteps)).toContain('slack');
  });

  it('⛔ finds nothing once the steps are gone — why a list row cannot answer it', () => {
    const { steps: _steps, ...trimmed } = recipeWithRefsInSteps;
    expect(recipeNotificationChannels(trimmed)).not.toContain('slack');
  });
});

describe('recipeConsumedEnrichments', () => {
  it('finds enrichment reads in steps, once each, in first-seen order', () => {
    expect(recipeConsumedEnrichments(recipeWithRefsInSteps))
      .toEqual(['data.enrichment.contact.alice.deal_risk']);
  });

  it('keeps at most four', () => {
    const many = { steps: Array.from({ length: 6 }, (_, i) => ({ ref: `data.enrichment.x.${i}` })) };
    expect(recipeConsumedEnrichments(many)).toEqual([
      'data.enrichment.x.0', 'data.enrichment.x.1', 'data.enrichment.x.2', 'data.enrichment.x.3',
    ]);
  });

  it('answers empty for no body at all', () => {
    expect(recipeConsumedEnrichments(undefined)).toEqual([]);
    expect(recipeNotificationChannels(undefined)).toEqual([]);
  });
});

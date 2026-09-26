/** The Recipes card's channel and enrichment pills come from the SERVER's
 *  projection, because the body they are derived from is not on a list row.
 *
 *  ⛔ Fixtures here are REAL list rows: no `steps`, exactly what the server
 *  sends. A row built WITH steps would pass against the old row scan too, and
 *  that is how three list-row readers of step bodies stayed green after the
 *  trim (Kitchen templates, the guided import, and these pills). */

import { describe, expect, it } from 'vitest';
import type { ServerRecipeListEntry } from '@recued/contracts';

import { projectRecipeCardState } from '../recipes/bootstrap-recipes-route.js';

const row = (over: Partial<ServerRecipeListEntry> = {}): ServerRecipeListEntry => ({
  recipe_id: 'deal-alert',
  publisher_id: 'acme',
  version: 1,
  recipe_hash: 'h',
  source: 'pair-sync',
  installed_at: 1,
  recipe: {
    recipe_id: 'deal-alert',
    version: 1,
    ttl: 60,
    metadata: { name: 'Deal alert', description: '', author: 'acme', supported_platforms: [] },
    variables: {},
    output: { render: [] },
  },
  ...over,
});

describe('the Recipes card pills', () => {
  it('⛔ come from the server projection, which a trimmed row has and its body does not', () => {
    const card = projectRecipeCardState(row({
      notification_channels: ['slack'],
      consumed_enrichments: ['data.enrichment.contact.alice.deal_risk'],
    }), []);
    expect(card.notification_channels).toEqual(['slack']);
    expect(card.consumed_enrichments).toEqual(['data.enrichment.contact.alice.deal_risk']);
  });

  it('trust an empty projection as "none", not as "ask the body"', () => {
    const card = projectRecipeCardState(row({ notification_channels: [], consumed_enrichments: [] }), []);
    expect(card.notification_channels).toEqual([]);
    expect(card.consumed_enrichments).toEqual([]);
  });

  it('fall back to the body an OLDER server still sends on the row', () => {
    const older = row();
    (older.recipe as unknown as { steps: unknown[] }).steps = [
      { id: 'n', op: 'notification.slack.post', args: { ref: '{{data.enrichment.contact.alice.deal_risk}}' } },
    ];
    const card = projectRecipeCardState(older, []);
    expect(card.notification_channels).toContain('slack');
    expect(card.consumed_enrichments).toEqual(['data.enrichment.contact.alice.deal_risk']);
  });
});

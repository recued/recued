/** D-174 P7 - marketplace ingredient current-model renderer tests. */

import { describe, expect, it } from 'vitest';

import {
  marketplaceIngredientKind,
  renderMarketplaceIngredientCard,
  renderMarketplaceIngredientDetail,
  type MarketplaceIngredientRenderState,
} from '../marketplace/ingredient-card.js';

const currentModelIngredient: MarketplaceIngredientRenderState = {
  slug: 'hubspot-catalog',
  publisher_id: 'recued-core',
  publisher_certified: true,
  name: 'HubSpot Catalog',
  description: 'Read and update HubSpot records through approved operations.',
  manifest: {
    slug: 'hubspot-catalog',
    name: 'HubSpot Catalog',
    description: 'Read and update HubSpot records through approved operations.',
    author: 'recued-core',
    kind: 'http',
    category: 'action',
    risk_tier: 'write',
    input: {},
    output: {},
    operations: {
      'deals.read': {
        operation_id: 'recued-core/hubspot.deals.read',
        description: 'Read deals.',
        risk_tier: 'read',
        approval: 'never',
      },
      'deals.update': {
        operation_id: 'recued-core/hubspot.deals.update',
        description: 'Update deal fields.',
        risk_tier: 'write',
        approval: 'ask',
      },
      'deals.delete': {
        operation_id: 'recued-core/hubspot.deals.delete',
        risk_tier: 'destructive',
        approval: 'always',
      },
    },
    operation_groups: {
      deals: {
        group_id: 'deals',
        display_name: 'Deal operations',
        description: 'Operations that touch HubSpot deals.',
        operations: ['deals.read', 'deals.update', 'deals.delete'],
        risk_floor: 'read',
        grant_default: 'on_after_connect',
        upgrade_behavior: 'new_operations_off',
      },
    },
    cancellation_partner: 'hubspot.deals.restore',
    catalog_kind: 'official',
  },
};

describe('D-174 P7 - renderMarketplaceIngredientCard', () => {
  it('surfaces current-model grant fields from the manifest', () => {
    const html = renderMarketplaceIngredientCard(currentModelIngredient);

    expect(html).toContain('kind: HTTP');
    expect(html).toContain('Official catalog');
    expect(html).toContain('3 operations');
    expect(html).toContain('highest: Destructive');
    expect(html).toContain('2 approval pauses');
    expect(html).toContain('Review grants');
  });

  it('escapes user-controlled strings', () => {
    const html = renderMarketplaceIngredientCard({
      ...currentModelIngredient,
      name: '<script>alert(1)</script>',
    });

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('D-174 P7 - renderMarketplaceIngredientDetail', () => {
  it('renders operations, approval intent, operation groups, reversibility, and install CTA', () => {
    const html = renderMarketplaceIngredientDetail(currentModelIngredient);

    expect(html).toContain('Operations you grant (3)');
    expect(html).toContain('recued-core/hubspot.deals.update');
    expect(html).toContain('Pauses for approval card');
    expect(html).toContain('Always pauses for approval card');
    expect(html).toContain('Operation groups (1)');
    expect(html).toContain('Deal operations');
    expect(html).toContain('grant: on_after_connect');
    expect(html).toContain('Cancellation partner: hubspot.deals.restore');
    expect(html).toContain('Install in Recued');
  });

  it('degrades legacy partial manifests without blanking or throwing', () => {
    const legacy: MarketplaceIngredientRenderState = {
      slug: 'ai-summarize',
      publisher_id: 'recued-core',
      name: 'AI Summarize',
      description: 'Summarizes text.',
      manifest: {
        slug: 'ai-summarize',
        name: 'AI Summarize',
        description: 'Summarizes text.',
        author: 'recued-core',
        kind: 'ai',
      },
    };

    expect(marketplaceIngredientKind(legacy)).toBe('ai');
    const html = renderMarketplaceIngredientDetail(legacy);
    expect(html).toContain('AI Summarize');
    expect(html).toContain('kind: AI');
    expect(html).toContain('legacy manifest');
    expect(html).not.toContain('undefined');
  });
});

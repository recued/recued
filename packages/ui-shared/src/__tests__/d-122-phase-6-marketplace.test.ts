/** D-122 Phase 6 — marketplace surfacing render tests.
 *
 *  Covers the three new render modules in
 *  `packages/ui-shared/src/marketplace/`:
 *    - `recipe-card.ts` (alert/reactive/agent/url/manual badges,
 *      pack-membership chip, channel + enrichment pills)
 *    - `filter-chips.ts` (toggle behavior + active class flip)
 *    - `pack-page.ts` (manifest header + recipe list + cost block +
 *      install gate + blocking message). */

import { describe, expect, it } from 'vitest';
import {
  BULK_INSTALL_PACK_VERSION,
  BULK_PACK_INSTALL_PERMISSION,
  type BulkPackManifest,
} from '@recued/contracts';
import {
  renderRecipeCard,
  type RecipeCardState,
} from '../marketplace/recipe-card.js';
import {
  renderMarketplaceFilterChips,
  toggleMarketplaceFilter,
  DEFAULT_MARKETPLACE_FILTER_CHIPS,
} from '../marketplace/filter-chips.js';
import {
  renderPackPage,
  type PackPageState,
} from '../marketplace/pack-page.js';

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

const baseCard: RecipeCardState = {
  recipe_id: 'time-alert-before-event',
  publisher_id: 'recued-core',
  name: 'Time alert before event',
  description: 'Notify ahead of upcoming calendar events.',
  version: 1,
  author: 'recued-core',
  tags: ['alerts', 'calendar'],
  trigger_kind: 'alert',
  notification_channels: ['slack', 'email'],
  consumed_enrichments: ['calendar_event_rollup'],
};

const baseManifest: BulkPackManifest = {
  manifest_version: BULK_INSTALL_PACK_VERSION,
  slug: 'personal-crm-foundation',
  publisher: 'recued-core',
  name: 'Personal CRM Foundation',
  description: 'Alerts that read your warehouse.',
  version: 1,
  recipes: [
    { slug: 'time-alert-before-event', version: 1 },
    { slug: 'refresh-calendar-event-rollup', version: 1 },
  ],
  requires: [BULK_PACK_INSTALL_PERMISSION],
  tags: ['pack:personal-crm', 'alerts'],
};

const basePackState: PackPageState = {
  manifest: baseManifest,
  recipes: [
    baseCard,
    {
      ...baseCard,
      recipe_id: 'refresh-calendar-event-rollup',
      name: 'Refresh calendar event rollup',
      description: 'Silently rebuilds calendar rollups.',
      tags: ['reactive', 'calendar'],
      trigger_kind: 'reactive',
      notification_channels: undefined,
      consumed_enrichments: ['calendar_event_rollup'],
    },
  ],
  cost: {
    total_daily_fires: 80,
    total_daily_tokens: 32_000,
    free_pool_consumption_pct: 18,
  },
  install_enabled: true,
};

// ────────────────────────────────────────────────────────────────
// recipe-card
// ────────────────────────────────────────────────────────────────

describe('D-122 P6 — renderRecipeCard', () => {
  it('renders the alert badge for trigger_kind=alert', () => {
    const html = renderRecipeCard(baseCard);
    expect(html).toContain('recipe-card-badge--alert');
    expect(html).toContain('Alert');
    expect(html).toContain('Time alert before event');
  });

  it('renders notification channel pills + consumed-enrichment pills for alert recipes', () => {
    const html = renderRecipeCard(baseCard);
    expect(html).toContain('→ slack');
    expect(html).toContain('→ email');
    expect(html).toContain('reads calendar_event_rollup');
  });

  it('omits channel pills for non-alert kinds (reactive shows enrichments only)', () => {
    const html = renderRecipeCard({
      ...baseCard,
      trigger_kind: 'reactive',
      notification_channels: ['slack'],
      consumed_enrichments: ['contact_timeline_rollup'],
    });
    expect(html).not.toContain('→ slack');
    expect(html).toContain('reads contact_timeline_rollup');
  });

  it('renders the pack-membership chip with route + slug', () => {
    const html = renderRecipeCard({
      ...baseCard,
      pack_membership: { slug: 'personal-crm-foundation', name: 'Personal CRM Foundation' },
    });
    expect(html).toContain('data-route="/pack/personal-crm-foundation"');
    expect(html).toContain('in Personal CRM Foundation');
  });
});

// ────────────────────────────────────────────────────────────────
// filter-chips
// ────────────────────────────────────────────────────────────────

describe('D-122 P6 — renderMarketplaceFilterChips', () => {
  it('renders the Alerts chip from the default chip set', () => {
    const html = renderMarketplaceFilterChips({
      chips: DEFAULT_MARKETPLACE_FILTER_CHIPS,
      active: [],
    });
    expect(html).toContain('Alerts');
    expect(html).toContain('data-chip-id="alerts"');
    expect(html).toContain('data-tag="alerts"');
  });

  it('flips the active modifier when an active id is supplied', () => {
    const html = renderMarketplaceFilterChips({
      chips: DEFAULT_MARKETPLACE_FILTER_CHIPS,
      active: ['alerts'],
    });
    expect(html).toMatch(/marketplace-chip marketplace-chip--active[^"]*"\s+data-action="toggle-marketplace-filter"\s+data-chip-id="alerts"/);
    expect(html).toMatch(/aria-pressed="true"[^>]*>\s*Alerts/);
  });

  it('toggleMarketplaceFilter adds + removes a chip id', () => {
    expect(toggleMarketplaceFilter([], 'alerts')).toEqual(['alerts']);
    expect(toggleMarketplaceFilter(['alerts', 'mail'], 'alerts').sort())
      .toEqual(['mail']);
  });

  it('toggleMarketplaceFilter dedupes + preserves order semantics', () => {
    const next = toggleMarketplaceFilter(['mail', 'mail', 'crm'], 'alerts');
    // Set ordering: mail, crm, alerts
    expect(next).toEqual(['mail', 'crm', 'alerts']);
  });
});

// ────────────────────────────────────────────────────────────────
// pack-page
// ────────────────────────────────────────────────────────────────

describe('D-122 P6 — renderPackPage', () => {
  it('renders the manifest header (name, publisher, recipe count, version)', () => {
    const html = renderPackPage(basePackState);
    expect(html).toContain('Personal CRM Foundation');
    expect(html).toContain('recued-core');
    expect(html).toContain('2 recipes');
    expect(html).toContain('v1');
  });

  it('renders one recipe-card per manifest recipe entry', () => {
    const html = renderPackPage(basePackState);
    expect(html).toContain('Time alert before event');
    expect(html).toContain('Refresh calendar event rollup');
    // Two cards → two `<article class="recipe-card"`
    const cardMatches = html.match(/class="recipe-card"/g);
    expect(cardMatches?.length).toBe(2);
  });

  it('renders the aggregate cost block (fires, tokens, free-pool %)', () => {
    const html = renderPackPage(basePackState);
    expect(html).toContain('80 fires/day');
    expect(html).toContain('32,000 tokens/day');
    expect(html).toContain('Free pool consumption: ~18%');
  });

  it('renders the loading skeleton when cost is null', () => {
    const html = renderPackPage({ ...basePackState, cost: null });
    expect(html).toContain('Resolving cost preview…');
  });

  it('disables the install button when install_enabled is false', () => {
    const html = renderPackPage({
      ...basePackState,
      install_enabled: false,
      blocking_message: 'Pack references a recipe that no longer exists',
    });
    const installBtn = html.match(/data-action="install-pack"[^>]*>/)?.[0] ?? '';
    expect(installBtn).toContain('disabled');
    expect(html).toContain('Pack references a recipe that no longer exists');
    expect(html).toContain('role="alert"');
  });

  it('renders the requires block + escapes HTML in the description (XSS defense)', () => {
    const html = renderPackPage({
      ...basePackState,
      manifest: { ...baseManifest, description: '<script>alert(1)</script>' },
    });
    expect(html).toContain(BULK_PACK_INSTALL_PERMISSION);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });
});

/** D-122 Phase 6 — marketplace pack detail page.
 *
 *  Full pack landing — manifest header, recipe list (one card per
 *  recipe), aggregate cost preview, install button. Lives at
 *  `/pack/<slug>` in the webapp router; the extension sidebar
 *  redirects to the same URL on the marketplace web app.
 *
 *  Pure render. The host fetches the manifest (via
 *  `fetchBulkPackBySlug`), resolves the constituent recipes
 *  (`resolveBulkPack`), runs the cost estimator
 *  (`estimatePackCost`), classifies each recipe's trigger kind,
 *  derives notification channels + consumed enrichments, and assembles
 *  the resulting `PackPageState` once before render.
 *
 *  The install button mirrors the bulk-pack-dialog convention
 *  (`data-action="install-pack"`) so the existing flow orchestrator
 *  picks the click up unchanged.
 */

import { type BulkPackManifest } from '@recued/contracts';
import { e } from '../template.js';
import {
  renderRecipeCard,
  type RecipeCardState,
} from './recipe-card.js';

/** Aggregate cost summary the dialog renders under the recipe list.
 *  Mirrors the BulkPackDialog cost block but rolls per-recipe rows
 *  into pack-level totals. The host computes this from
 *  `estimatePackCost` upstream; the page is render-only. */
export interface PackPageCostSummary {
  /** Sum of `daily_fires` across the pack. */
  total_daily_fires: number;
  /** Sum of `daily_tokens` across the pack. */
  total_daily_tokens: number;
  /** Pack's share of the free-pool daily budget as a percentage
   *  (0..>100). `null` when the user hasn't configured the free pool —
   *  the page surfaces the gap with a "free pool not configured" hint. */
  free_pool_consumption_pct: number | null;
  /** Optional BYOK estimate ($/day) when the host can predict it. */
  byok_dollars_per_day?: number;
}

export interface PackPageState {
  manifest: BulkPackManifest;
  /** One card per `manifest.recipes[]` entry. The host classifies
   *  trigger kind + populates channel / enrichment pills before
   *  passing in. */
  recipes: RecipeCardState[];
  /** Aggregate cost summary. Empty when the host couldn't resolve
   *  per-recipe estimates (e.g., pack still loading). */
  cost: PackPageCostSummary | null;
  /** True when every recipe resolved cleanly + the user holds the
   *  install permission. The install button stays disabled otherwise. */
  install_enabled: boolean;
  /** Optional inline alert (e.g., "this pack references a recipe that
   *  no longer exists"). Renders above the install action. */
  blocking_message?: string;
}

const renderCostSummary = (cost: PackPageCostSummary | null): string => {
  if (!cost) {
    return `<p class="pack-page-cost pack-page-cost--loading">Resolving cost preview…</p>`;
  }
  const fires = cost.total_daily_fires.toLocaleString();
  const tokens = cost.total_daily_tokens.toLocaleString();
  const freePool = cost.free_pool_consumption_pct == null
    ? `<span class="pack-page-cost-line">Free pool not configured — set up an API key in Settings → AI</span>`
    : `<span class="pack-page-cost-line">Free pool consumption: ~${cost.free_pool_consumption_pct.toFixed(0)}% of daily budget</span>`;
  const byok = cost.byok_dollars_per_day == null
    ? ''
    : `<span class="pack-page-cost-line">If BYOK: ~$${e(cost.byok_dollars_per_day.toFixed(2))}/day</span>`;
  return `
    <section class="pack-page-section pack-page-cost">
      <h2>Cost &amp; usage</h2>
      <p class="pack-page-cost-headline">~${e(fires)} fires/day · ~${e(tokens)} tokens/day</p>
      ${freePool}
      ${byok}
    </section>
  `;
};

const renderRecipesSection = (state: PackPageState): string => {
  if (state.recipes.length === 0) {
    return `<section class="pack-page-section"><h2>Recipes</h2><p class="pack-page-empty">Pack manifest references no recipes.</p></section>`;
  }
  const cards = state.recipes.map((r) => renderRecipeCard(r)).join('');
  return `
    <section class="pack-page-section pack-page-recipes">
      <h2>Recipes (${state.recipes.length})</h2>
      <div class="pack-page-recipe-list">${cards}</div>
    </section>
  `;
};

const renderActions = (state: PackPageState): string => {
  const disabled = state.install_enabled ? '' : 'disabled';
  const blocking = state.blocking_message
    ? `<div class="pack-page-blocking" role="alert">${e(state.blocking_message)}</div>`
    : '';
  return `
    ${blocking}
    <div class="pack-page-actions">
      <button type="button" class="pack-page-btn pack-page-btn--cancel"
        data-action="cancel-pack">
        Cancel
      </button>
      <button type="button" class="pack-page-btn pack-page-btn--primary"
        data-action="install-pack"
        data-pack-slug="${e(state.manifest.slug)}"
        ${disabled}>
        Install pack
      </button>
    </div>
  `;
};

const renderRequires = (manifest: BulkPackManifest): string => {
  if (manifest.requires.length === 0) return '';
  const items = manifest.requires.map((r) =>
    `<li class="pack-page-requires-item"><code>${e(r)}</code></li>`,
  ).join('');
  return `
    <section class="pack-page-section pack-page-requires">
      <h2>Permissions requested</h2>
      <ul class="pack-page-requires-list">${items}</ul>
    </section>
  `;
};

/** v3 `repo` — author's source repo link. Issues / support route there;
 *  the marketplace hosts no comment or issue tracking. Defensively
 *  re-checks the https scheme (the manifest validator already gates it). */
const renderSupportLink = (manifest: BulkPackManifest): string => {
  const repo = manifest.repo;
  if (!repo || !repo.startsWith('https://')) return '';
  return `<p class="pack-page-support"><a class="pack-page-support-link" href="${e(repo)}" target="_blank" rel="noopener noreferrer">Issues &amp; support</a></p>`;
};

const renderTags = (manifest: BulkPackManifest): string => {
  if (manifest.tags.length === 0) return '';
  return `
    <ul class="pack-page-tags">
      ${manifest.tags.map((t) => `<li class="pack-page-tag">${e(t)}</li>`).join('')}
    </ul>
  `;
};

/** Render the full `/pack/<slug>` page. Returns an HTML string the
 *  host injects into the main pane. */
export const renderPackPage = (state: PackPageState): string => {
  const m = state.manifest;
  return `
    <article class="pack-page" data-pack-slug="${e(m.slug)}">
      <header class="pack-page-header">
        <h1 class="pack-page-name">${e(m.name)}</h1>
        <p class="pack-page-meta">
          ${m.recipes.length} recipe${m.recipes.length === 1 ? '' : 's'} —
          ${e(m.publisher)} · v${m.version}
        </p>
        <p class="pack-page-description">${e(m.description)}</p>
        ${renderSupportLink(m)}
        ${renderTags(m)}
      </header>

      ${renderRecipesSection(state)}
      ${renderCostSummary(state.cost)}
      ${renderRequires(m)}
      ${renderActions(state)}
    </article>
  `;
};

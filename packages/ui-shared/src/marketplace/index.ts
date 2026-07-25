/** D-122 Phase 6 — marketplace UI surface barrel.
 *
 *  Recipe card, filter chips, and pack-detail page. Hosts (extension
 *  sidebar + webapp marketplace view) consume the rendered HTML strings;
 *  the package itself is shape → HTML, no IO.
 */

export {
  renderRecipeCard,
  type RecipeCardState,
  type RecipeCardTriggerKind,
  type RecipeCardPackMembership,
} from './recipe-card.js';

export {
  renderMarketplaceFilterChips,
  toggleMarketplaceFilter,
  DEFAULT_MARKETPLACE_FILTER_CHIPS,
  type MarketplaceFilterChip,
  type MarketplaceFilterChipsState,
} from './filter-chips.js';

export {
  renderPackPage,
  type PackPageState,
  type PackPageCostSummary,
} from './pack-page.js';

export {
  MARKETPLACE_INGREDIENT_KIND_FILTERS,
  marketplaceIngredientKind,
  marketplaceIngredientKindLabel,
  renderMarketplaceIngredientCard,
  renderMarketplaceIngredientDetail,
  type MarketplaceIngredientKindFilter,
  type MarketplaceIngredientRenderState,
} from './ingredient-card.js';

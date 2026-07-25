/** D-119 Phase 3 — top-bar search slot.
 *
 *  Lifts the recipe-search field out of the recipes section and into
 *  the top bar. The same `data-field="recipe-filter"` hook the existing
 *  sidebar input listener targets is preserved so the runtime wiring
 *  in `sidebar.ts` keeps working unchanged: typing into the box still
 *  calls `setState({ recipeFilter: ... })` and the recipe list
 *  re-renders with `applyFilterAndFloat` doing the actual filtering.
 *
 *  Pure module. */

import { textInput } from '../primitives/index.js';

export interface SearchInputState {
  /** Current query string. `null` for "no filter active". Mirrors
   *  `SidebarState.recipeFilter` exactly. */
  query: string | null;
}

export const renderTopBarSearchInput = (state: SearchInputState): string => `
  <div class="top-bar-search">
    ${textInput({
      extraClass: 'top-bar-search-input',
      data: { field: 'recipe-filter' },
      placeholder: 'Search recipes…',
      value: state.query ?? '',
      ariaLabel: 'Search recipes',
    })}
  </div>
`;

/** Whole-list reads over the paged list rpcs (`@recued/contracts`
 *  `rpc/list-page.ts`).
 *
 *  Each helper reads every page and hands back the same `{ recipes }` /
 *  `{ catalog }` shape the unpaged call returned, so a surface that renders the
 *  whole list keeps its caller type and never sees a page. What changes is the
 *  wire: no single frame grows with the install count, and there is only one
 *  page per read in flight on the socket at a time.
 *
 *  ⚠ An older server ignores the paging arguments and answers with the whole
 *  list and no `next_cursor`. `collectListPages` takes that as complete, so
 *  these work against either. */

import {
  collectListPages,
  type ListPageFields,
  type ListPageRequest,
  type ToolCatalogEntryView,
} from '@recued/contracts';

/** Every row of `recipe.list`. Generic over the row type so a caller that
 *  narrowed its conn keeps its own row type. */
export const listAllRecipes = async <R>(
  call: (request: ListPageRequest) => Promise<{ recipes: ReadonlyArray<R> } & ListPageFields>,
): Promise<{ recipes: R[] }> => ({
  recipes: await collectListPages<R>({
    fetchPage: async (request) => {
      const answer = await call(request);
      return { items: answer.recipes, next_cursor: answer.next_cursor, total: answer.total };
    },
  }),
});

/** Every tool in `chat.inbound_token.tool_catalog`. */
export const listAllTools = async (
  call: (
    request: ListPageRequest,
  ) => Promise<{ catalog: ReadonlyArray<ToolCatalogEntryView> } & ListPageFields>,
): Promise<{ catalog: ToolCatalogEntryView[] }> => ({
  catalog: await collectListPages<ToolCatalogEntryView>({
    fetchPage: async (request) => {
      const answer = await call(request);
      return { items: answer.catalog, next_cursor: answer.next_cursor, total: answer.total };
    },
  }),
});

/** Whether ANY recipe is installed, reading one row instead of all of them.
 *  A paged answer carries `total`; an older server's whole-list answer does
 *  not, and its length says the same thing. */
export const hasAnyRecipe = async (
  call: (request: ListPageRequest) => Promise<{ recipes: ReadonlyArray<unknown> } & ListPageFields>,
): Promise<boolean> => {
  const answer = await call({ limit: 1 });
  return (answer.total ?? answer.recipes.length) > 0;
};

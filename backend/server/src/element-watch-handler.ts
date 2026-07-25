/** `triggers.createElementWatch` — server half of the Browser Bridge
 *  "watch this element" affordance.
 *
 *  Scaffolds a minimal LOCAL notify recipe from a `(url, selector)` target
 *  (element-watch-recipe.ts) and saves it. The declarative event-trigger
 *  reconciler — wired on `recipeStore.setOnMutated` in
 *  `serve/compose-listeners.ts` — fires on the save and materializes a
 *  trigger row for the recipe's `element.changed` sugar (compiled to a
 *  `data.dom.element.<target>.updated` subscription).
 *
 *  The materialized row is DISARMED by default (D-179 P5c, owner decision
 *  2026-06-12 — installing automation never silently starts polling). So
 *  this rpc CREATES the watch but does not start it: the user arms it in
 *  the #automation surface, where enabling mints + binds the managed dish.
 *  The Bridge surface (brick 3) tells the user where to enable it. This
 *  handler never touches the trigger store directly — saving the recipe is
 *  the whole server-side action.
 *
 *  OWNER-ONLY by construction: the method sits under the `triggers.` prefix,
 *  which `MCP_RESERVED_RPC_PREFIXES` (mcp-tool-catalog.ts) excludes from the
 *  MCP tool catalog — autonomous-execution policy (attaching a watch that
 *  fires a recipe on warehouse changes) is the owner's surface, never an
 *  MCP-channel agent's. Authoring a recipe + arming a watch is strictly more
 *  powerful than `triggers.create`, so the same isolation applies. */

import {
  isValidChromeMatchPattern,
  RpcError,
  type HandlerSlice,
  type ServerRpcRegistry,
} from '@recued/contracts';
import { validateRecipe } from '@recued/recipes';
import type { WsClient } from './ws-server.js';
import type { RecipeStore } from './recipe-store.js';
import {
  buildElementWatchRecipe,
  ELEMENT_WATCH_PUBLISHER,
} from './triggers/element-watch-recipe.js';

export interface ElementWatchRpcDeps {
  recipeStore: RecipeStore;
  /** Injectable clock — the `installed_at` stamp on the saved row. */
  now?: () => number;
}

export type ElementWatchMethods = 'triggers.createElementWatch';

const requireNonEmptyString = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new RpcError('bad_request', `${field} must be a non-empty string`, 400);
  }
  return v;
};

export const handleCreateElementWatch = async (
  deps: ElementWatchRpcDeps,
  args: { url?: unknown; selector?: unknown; label?: unknown },
): Promise<{ recipe_id: string; created: boolean }> => {
  const url = requireNonEmptyString(args.url, 'url');
  const selector = requireNonEmptyString(args.selector, 'selector');
  // The (url, selector) codec joins on a single space (the sugar validator
  // + `encodeDomWatchTarget` rely on it): a whitespace-laden url would split
  // the watch target at the wrong boundary. Reject fast with a clear message
  // rather than minting a silently-wrong watch.
  if (/\s/.test(url)) {
    throw new RpcError(
      'bad_request',
      'url must be a whitespace-free Chrome match pattern',
      400,
    );
  }
  // Fail closed on a structurally-invalid url. The downstream sugar validator
  // + codec only check non-empty / no-ref / whitespace-free, so a value like
  // 'not-a-url' would save fine but produce a `domain_allowlist` /
  // `target_domain_pattern` no bridge `granted_origins` entry can ever match
  // — the watch would arm (once enabled) and then poll a tab that never
  // exists, reporting `unavailable` forever (a silently-dead watch). The rpc
  // is the trust boundary; the canonical grammar lives in @recued/contracts.
  if (!isValidChromeMatchPattern(url)) {
    throw new RpcError(
      'bad_request',
      'url must be a valid Chrome match pattern (e.g. https://app.example.com/*)',
      400,
    );
  }
  const label = typeof args.label === 'string' ? args.label : undefined;

  const recipe = buildElementWatchRecipe({ url, selector, label });

  // Defensive validation — the scaffold is well-formed by construction, but
  // run the portable validator so any grammar drift (recipe_id rule, the
  // sugar entry's url/selector checks, notify input) surfaces as a clean rpc
  // error instead of a silently-dead trigger row at reconcile time.
  const result = validateRecipe(recipe);
  if (!result.valid) {
    const codes = result.issues
      .filter((i) => i.severity === 'error')
      .map((i) => i.code)
      .join(', ');
    throw new RpcError(
      'bad_request',
      `element-watch recipe failed validation: ${codes}`,
      400,
    );
  }

  // Idempotent: the recipe_id is a digest of (url, selector), so re-watching
  // the same element overwrites the prior scaffold (the reconciler then
  // treats the watch as already present and leaves its bookkeeping alone).
  const created = deps.recipeStore.get(recipe.recipe_id) === null;
  deps.recipeStore.save(recipe, ELEMENT_WATCH_PUBLISHER, 'inline', deps.now?.());
  // save() fires the setOnMutated hook → reconcile materializes the trigger
  // row (DISARMED) + rebuilds the dispatcher. The poll only arms once the
  // user enables the watch in #automation, so no background polling starts
  // here.

  return { recipe_id: recipe.recipe_id, created };
};

export const makeElementWatchHandlers = (
  deps: ElementWatchRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, ElementWatchMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['triggers.createElementWatch'],
    handlers: {
      'triggers.createElementWatch': async (args) =>
        handleCreateElementWatch(
          deps,
          args as Parameters<typeof handleCreateElementWatch>[1],
        ),
    },
  };
};

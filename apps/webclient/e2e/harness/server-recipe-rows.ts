/** The server's two recipe doors, mirrored for the e2e harness.
 *
 *  ⛔⛔ WHY THIS EXISTS. Since f95faec10 a `recipe.list` row carries no step
 *  bodies: the server strips `steps` / `prefetch_steps` and projects what a
 *  client needs from them onto the row. This harness went on handing out rows
 *  WITH bodies, so three client features that read a body off a list row broke
 *  for every real user and stayed green in e2e: Kitchen's form-response
 *  templates, the guided spreadsheet import, and the Recipes card pills. Every
 *  harness list reply now goes through `toServerListRow`, and the bodies it
 *  had stay reachable through `recipe.get`, as they are on a real server.
 *
 *  The projections are computed by the SAME contracts helpers the server's
 *  `recipe-list-handler.ts` uses, so the harness cannot drift from it. A
 *  projection a fixture sets itself wins.
 *
 *  ⛔ `provably_read_only` TOO, AS A SERVER WITH A PACK ROSTER SENDS IT. It was
 *  left out here, and once the client stopped judging a trimmed row for itself
 *  (7255ddf3c) a row without it was never proven read-only: no harness pack
 *  recipe could be a view any more, and every Pack Use e2e test that opens one
 *  failed. The roster this harness has ships no pack operations, so a pack op
 *  resolves to nothing and fails closed — as on a server without that pack. */

import {
  buildPackOperationIndex,
  isProvablyReadOnly,
  recipeConsumedEnrichments,
  recipeNotificationChannels,
  recipeRequiredConnections,
  recipeSpendsPerRun,
  spreadsheetImportOf,
  type RecipeDefinition,
  type RecipeReleaseView,
} from '@recued/contracts';
import { canonicalJSONStringifyStrict, sha256Hex } from '@recued/crypto';
import { hasNonEmptyWebhookDeclarations } from '../../../../backend/server/src/webhook-declaration-gate.js';

type Row = Record<string, unknown> & { recipe_id?: unknown; recipe?: unknown };

/** The harness's pack roster, as operations: none. */
const NO_PACK_OPS = buildPackOperationIndex([]);

const hasBody = (recipe: unknown): recipe is RecipeDefinition =>
  recipe !== null && typeof recipe === 'object' && Array.isArray((recipe as { steps?: unknown }).steps);

/** A list row as the server sends it: the body trimmed, its facts projected. */
export const toServerListRow = (row: Row): Row => {
  if (!hasBody(row.recipe)) return row;
  const { steps: _steps, prefetch_steps: _prefetch, ...view } = row.recipe as RecipeDefinition & {
    prefetch_steps?: unknown;
  };
  const declaration = spreadsheetImportOf(row.recipe);
  return {
    required_connections: recipeRequiredConnections(row.recipe)
      .map((c) => ({ kind: c.kind, name: c.name })),
    notification_channels: recipeNotificationChannels(row.recipe),
    consumed_enrichments: recipeConsumedEnrichments(row.recipe),
    spends_per_run: recipeSpendsPerRun(row.recipe),
    provably_read_only: isProvablyReadOnly(row.recipe, NO_PACK_OPS),
    ...(declaration === null ? {} : { spreadsheet_import: declaration }),
    ...row,
    recipe: view,
  };
};

/** The bodies list replies carried, so an otherwise unanswered `recipe.get` can
 *  return the full entry the list trimmed, as the server's two doors agree. */
export const createRecipeBodyMemory = () => {
  const byId = new Map<string, Row>();
  return {
    remember(rows: ReadonlyArray<Row>): void {
      for (const row of rows) {
        if (typeof row.recipe_id === 'string' && hasBody(row.recipe)) byId.set(row.recipe_id, row);
      }
    },
    get(recipeId: unknown): Row | null {
      return typeof recipeId === 'string' ? byId.get(recipeId) ?? null : null;
    },
  };
};

/** `recipe.release.get` for a recipe with no release history, as the server's
 *  `recipe-release-store.ts` answers it.
 *
 *  ⛔ The editor awaits this read before it renders anything (66217a045), and
 *  every current server answers it. This harness did not, so four Kitchen
 *  journeys sat on "Loading recipe…" until they timed out.
 *
 *  As on the server, a stored recipe can start reviewed releases, a bundled
 *  one must be forked first, a recipe declaring webhooks is not supported
 *  yet, and one the harness never served is unavailable. A list row does not
 *  say which pack owns a stored recipe, so every stored row counts as the
 *  owner's own. The digest is the server's (`recipeReleaseDigest`). */
export const unreleasedRecipeView = (recipeId: string, row: Row | null): RecipeReleaseView => {
  const history = { recipe_id: recipeId, managed: false, revision: 0, draft: null, drafts: [], releases: [], qualification: null };
  const unsupported = (reason: string): RecipeReleaseView => ({ ...history, supported: false, reason, active: null });
  if (row === null || !hasBody(row.recipe)) return unsupported('Open a saved local recipe to use reviewed releases.');
  if (row.source === 'bundled') return unsupported('Fork this pack or bundled recipe to a new local recipe id first.');
  if (hasNonEmptyWebhookDeclarations(row.recipe)) {
    return unsupported('Reviewed releases currently support local recipes without webhook declarations.');
  }
  return {
    ...history,
    supported: true,
    active: {
      sequence: 0,
      digest: 'sha256:' + sha256Hex(canonicalJSONStringifyStrict(row.recipe)),
      created_at: 0,
      recipe: structuredClone(row.recipe),
    },
  };
};

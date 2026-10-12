/** D-320 ruling 20 — a vendor-neutral search nobody pointed at a connection looks
 *  at every connection that can serve it.
 *
 *  A `core.crm.<alias>.search` step used to be lowered against ONE connection, the
 *  one its slot settled on. With none settled (the `crm` family has no pack
 *  default) an owner's run asked which, and a scheduled run was refused even with
 *  one CRM connection: the `crm` pack's recipes could not run on a schedule. Chat
 *  and MCP already answer an unnamed search by looking everywhere (D-255,
 *  `runCanonicalSearchFanout`); a recipe now does the same.
 *
 *  Done as a REWRITE before dispatch, so the engine, the gateway, approvals and
 *  audit see only ordinary steps. A search step `S` whose setting `V` nobody chose
 *  becomes, per serving connection `c` (sorted by name):
 *
 *    `S__on_<c>__raw`  the vendor fetch, signing in through `{{config.V__on_<c>}}`;
 *    `S__on_<c>`       the projection to canonical fields, with each record's
 *                      `connection_name` and `target_id`
 *                      (`<vendor>_<entity>_<connection>_<id>`, D-190), as every
 *                      search's has (`withRecordRouting`, the lowering);
 *    `S`               `flatten` of the legs, under the step's own id, so
 *                      `{{step.S}}` reads one list, as before.
 *
 *  `<c>` is the connection's name with `-` read as `_` (a step id is an
 *  identifier; a connection name has no `_`, so no two names meet). Named, not
 *  numbered: a failed leg's error names its connection, and a run resumed after a
 *  connection was added finds each leg where it left it.
 *
 *  🔑 EACH LEG SIGNS IN THROUGH A SETTING, NEVER A LITERAL NAME. `V__on_<c>` is
 *  declared on the run's copy (`type: 'connection'`, its connection the default),
 *  so everything that reads a step's connection reads a leg's the usual way: the
 *  run's record (`settledConnections`), the unbound check, the choice checks, and
 *  a door's derived connections (which refuse a literal name,
 *  `literal_connection`). They are also returned in `settings`, for a door or a
 *  pre-approval to write into the config it derives from or reviews.
 *
 *  ⛔ A SETTING SOMEONE CHOSE IS LEFT ALONE: the caller's own value, a dish's saved
 *  setting, or the run's or the dish's connection choice. The owner's ruling
 *  (2026-10-11) is that an explicit choice holds; only a default looks further. A
 *  choice made for a vendor's slot holds for that vendor's legs too
 *  (`servingConnectionsFor`).
 *
 *  ⛔ STRICT, not partial: a leg that fails fails the run (the legs run in name
 *  order and the run stops there), and its error names the leg, so the connection;
 *  chat instead returns the legs that worked (D-255). A digest that silently
 *  leaves one CRM out reads as complete; a run that fails says what to fix.
 *
 *  ⚠ The connections offered are those the run may use: a contract fans out only
 *  over what it covers. A door is derived from this rewrite, so it covers what the
 *  search reads when it is derived; a connection added later widens it only
 *  through the door's own upgrade. */

import {
  CONNECTION_VENDOR_ENTITIES,
  type ConnectionVendorEntity,
  isCanonicalOpStep,
  type IngredientManifest,
  type RecipeDefinition,
  type RecipeStep,
} from '@recued/contracts';
import { opStepConnectionSlots } from '@recued/recipes';

import { resolvePerSlotOpStepRecipe } from './ingredient-authoring/install-composition.js';
import { connectionsServingCanonicalOp, type PickCandidateDeps } from './pick-candidates.js';

/** One connection a fanned-out search reads. */
export interface FanoutConnection {
  connection_name: string;
  catalog_slug: string;
  vendor: string;
}

export interface CanonicalSearchFanoutDeps {
  /** Settings someone chose: their searches stay on that connection. */
  explicit: ReadonlySet<string>;
  /** The connections that can serve `<alias>.<verb>` and the run may use, sorted. */
  servingConnections: (alias: string, verb: string) => readonly FanoutConnection[];
  manifests: { get(slug: string): IngredientManifest | null };
  /** The registry a leg's canonical fields map through (ruling 20e: installed
   *  compositions included, for an accounting vendor). Omitted ⇒ the built-ins. */
  registry?: ReadonlyArray<ConnectionVendorEntity> | undefined;
}

export interface FannedSearch {
  step_id: string;
  /** The setting the search signed in through, which nobody chose. */
  setting: string;
  connections: FanoutConnection[];
}

export type CanonicalSearchFanoutResult =
  | {
      ok: true;
      recipe: RecipeDefinition;
      fanned: FannedSearch[];
      /** Each leg's setting and the connection it names, for the caller's config. */
      settings: Record<string, string>;
    }
  | { ok: false; reason: string };

/** The setting leg `<c>` of a search on `setting` signs in through. */
export const fanoutSettingName = (setting: string, connection_name: string): string =>
  `${setting}__on_${connection_name.replace(/-/g, '_')}`;

/** The connections a fanned-out search reads, by the run's rules: those serving the
 *  op (`connectionsServingCanonicalOp`), that the run may use (`admits`, a
 *  contract's connections), and, where a vendor's slot was given a connection by a
 *  choice (`slotChoices`, slot → connection), that one alone for that vendor. */
export const servingConnectionsFor = (deps: Pick<PickCandidateDeps, 'profiles' | 'manifests' | 'vendors'> & {
  admits?: (connection_name: string) => boolean;
  slotChoices?: Readonly<Record<string, string>>;
  slotOfCatalog?: (catalog_slug: string) => string;
}) => (alias: string, verb: string): FanoutConnection[] =>
  connectionsServingCanonicalOp(alias, verb, deps).filter((candidate) => {
    if (deps.admits !== undefined && !deps.admits(candidate.connection_name)) return false;
    const chosen = deps.slotChoices?.[deps.slotOfCatalog?.(candidate.catalog_slug) ?? candidate.catalog_slug];
    return chosen === undefined || chosen === candidate.connection_name;
  });

/** Rewrite every vendor-neutral `search` step whose setting nobody chose into one
 *  leg per serving connection and a merge. Steps it does not touch pass through. */
export const fanOutCanonicalSearches = (
  recipe: RecipeDefinition,
  deps: CanonicalSearchFanoutDeps,
): CanonicalSearchFanoutResult => {
  const slots = opStepConnectionSlots(recipe);
  // A recipe whose slots cannot be derived is the normal resolve's to report. One
  // with an op-step that names no setting is left alone too: it takes the recipe's
  // only setting, which the legs' settings would make ambiguous. (The run's copy
  // has none: `withSlotSettings` names each op-step's.)
  if (!slots.ok || recipe.steps.some((step) => isCanonicalOpStep(step) && step.connection === undefined)) {
    return { ok: true, recipe, fanned: [], settings: {} };
  }
  const reserved = new Set<string>([
    ...recipe.steps.map((step) => step.id),
    ...(recipe.prefetch_steps ?? []).map((step) => step.id),
    ...(recipe.trigger_steps ?? []).map((step) => step.id),
  ]);
  const variables: Record<string, unknown> = { ...(recipe.variables ?? {}) };
  // A leg's setting names a (setting, connection) pair, so every search on that
  // setting shares it; only one the recipe declared itself collides.
  const declaredHere = new Set<string>();
  const fanned: FannedSearch[] = [];
  const settings: Record<string, string> = {};
  const steps: RecipeStep[] = [];
  for (const step of recipe.steps) {
    const setting = isCanonicalOpStep(step) ? slots.slotByStepId.get(step.id) : undefined;
    const [alias, verb] = isCanonicalOpStep(step) ? step.op.split('.') : [];
    if (setting === undefined || verb !== 'search' || alias === undefined || deps.explicit.has(setting)
      || (step as { foreach?: unknown }).foreach !== undefined) {
      steps.push(step);
      continue;
    }
    const connections = deps.servingConnections(alias, verb);
    // None: the normal resolve reports why nothing can serve it.
    if (connections.length === 0) {
      steps.push(step);
      continue;
    }
    const legIds: string[] = [];
    for (const connection of connections) {
      const manifest = deps.manifests.get(connection.catalog_slug);
      if (manifest === null) return { ok: false, reason: `catalog '${connection.catalog_slug}' for connection '${connection.connection_name}' is not registered` };
      const legId = `${step.id}__on_${connection.connection_name.replace(/-/g, '_')}`;
      const rawId = `${legId}__raw`;
      if (reserved.has(rawId) || reserved.has(legId)) {
        return { ok: false, reason: `generated step id '${reserved.has(rawId) ? rawId : legId}' collides with an existing step id` };
      }
      reserved.add(rawId);
      reserved.add(legId);
      const legSetting = fanoutSettingName(setting, connection.connection_name);
      if (legSetting in variables && !declaredHere.has(legSetting)) {
        return { ok: false, reason: `generated setting '${legSetting}' collides with an existing setting` };
      }
      declaredHere.add(legSetting);
      variables[legSetting] = {
        label: `${connection.connection_name} (read by '${step.id}')`,
        type: 'connection',
        connection_kind: 'api',
        default: connection.connection_name,
      };
      settings[legSetting] = connection.connection_name;
      // The step alone, signing in through its leg's setting; nothing else is
      // lowered. The lowering writes each record's `connection_name` and
      // `target_id` from that setting, as it does for any search.
      const { trigger_steps: _triggerSteps, ...rest } = recipe;
      const lowered = resolvePerSlotOpStepRecipe(
        {
          ...rest,
          variables: { ...(recipe.variables ?? {}), [legSetting]: variables[legSetting] },
          steps: [{ ...step, connection: `{{config.${legSetting}}}` }],
          prefetch_steps: [],
        } as RecipeDefinition,
        new Map([[legSetting, manifest]]),
        `fanout:${connection.catalog_slug}`,
        (slug) => (slug === connection.catalog_slug ? connection.vendor : undefined),
        deps.registry ?? CONNECTION_VENDOR_ENTITIES,
      );
      if (!lowered.ok) return { ok: false, reason: lowered.message };
      const [raw, projection, ...extra] = lowered.recipe.steps;
      if (raw === undefined || projection === undefined || extra.length > 0 || projection.id !== step.id) {
        return { ok: false, reason: `search step '${step.id}' did not lower to a fetch and a projection` };
      }
      const { fail_on: _failOn, stop_when: _stopWhen, ...projectionRest } = projection as RecipeStep & {
        fail_on?: unknown;
        stop_when?: unknown;
      };
      const array = (projectionRest as { array?: unknown }).array;
      steps.push(
        { ...raw, id: rawId } as RecipeStep,
        {
          ...projectionRest,
          id: legId,
          array: typeof array === 'string' ? array.split(`{{step.${raw.id}`).join(`{{step.${rawId}`) : array,
        } as RecipeStep,
      );
      legIds.push(legId);
    }
    const authored = step as RecipeStep & { skip_when?: unknown; fail_on?: unknown; stop_when?: unknown };
    steps.push({
      id: step.id,
      transform: 'flatten',
      array: legIds.map((id) => `{{step.${id}}}`),
      ...(authored.skip_when !== undefined ? { skip_when: authored.skip_when } : {}),
      ...(authored.fail_on !== undefined ? { fail_on: authored.fail_on } : {}),
      ...(authored.stop_when !== undefined ? { stop_when: authored.stop_when } : {}),
    } as RecipeStep);
    fanned.push({ step_id: step.id, setting, connections: [...connections] });
  }
  return fanned.length === 0
    ? { ok: true, recipe, fanned, settings }
    : { ok: true, recipe: { ...recipe, variables: variables as RecipeDefinition['variables'], steps }, fanned, settings };
};

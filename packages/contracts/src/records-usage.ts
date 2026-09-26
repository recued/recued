/** Recipes detail — what a recipe does to pack-owned Records, and at what
 *  risk the pack author declared it.
 *
 *  Both facts already exist and were simply unread. A pack's composition
 *  carries one `PackOperationRow` per op with the author's `risk` + `approval`
 *  and, for a Records op, a `RecordsAuthorBinding` naming the `action` and the
 *  `entity` it touches. The recipe names ops by their Tier-P id
 *  (`<publisher>.<pack>.<operation>`), whose head is exactly the pack ref and
 *  whose tail is exactly the row's `op` — so the join is total and needs no
 *  new server field.
 *
 *  Why this must read the BINDING and never the op NAME: the catalog validator
 *  (`packages/ingredients/src/validate.ts`) checks that
 *  `surfaces.records.executes[opKey]` is a closed `core.records` binding, and
 *  it checks nothing whatsoever about how `opKey` is spelled. `job.create`
 *  binding `action: 'delete'` publishes clean. Deriving "this deletes" from the
 *  suffix would be a claim about a name, not about behaviour — and this line
 *  exists precisely so a destructive recipe cannot read as a harmless one.
 *
 *  Everything here is pure: same recipe + same roster → same result. An op the
 *  roster cannot resolve is REPORTED (`unresolved`), never silently dropped —
 *  a partial roster must not render as "touches nothing".
 */

import { RECORDS_ACTIONS, RISK_TIER_RANK, isRecordsAction, isRiskTier, parseOpId, isRecordsBatchAction,
  kernelOpDelivers, kernelOpForBackingSlug, kernelOpIsWatcher, kernelOpRiskTier, kernelOpSpendsPerRun } from './index.js';
import type { BulkPackManifest, OperationApproval, PackOperationRow, RecordsAction, RecordsBatchAllow, RiskTier } from './index.js';

/** The subset of a `packs.list` row this join needs. The caller maps a
 *  `PackListEntry` into it. */
export interface RecordsUsagePack {
  slug: string;
  publisher: string;
  name: string;
  /** Absent until fetched. `packs.list` sends none, for installed packs as
   *  much as for the rest (see `PackListEntry.manifest`); a pack detail
   *  backfills it through `packs.resolveBySlug`. A pack with no manifest
   *  contributes no operations, which is exactly the `unresolved` outcome this
   *  module already models — not an empty one. */
  manifest?: BulkPackManifest;
}

/** What an action does to STORED rows — the only three outcomes a person needs
 *  to weigh before running something. */
export type RecordsEffect = 'read' | 'write' | 'delete';

/** Effect of each Records action. Typed `Record<RecordsAction, …>` on purpose:
 *  a ninth action added to `RECORDS_ACTIONS` is a COMPILE ERROR here rather
 *  than a silent default to "read" — the same completeness ratchet the
 *  contract uses for `RISK_TIERS`.
 *
 *  Deliberately NOT the op row's authored `risk`. Across the shipped packs the
 *  two agree exactly (every `delete` is `destructive`, every `get` is `read`),
 *  but that agreement is a convention no validator enforces, and this line's
 *  whole job is to be true when a pack's own declaration is not. */
export const RECORDS_ACTION_EFFECT: Record<RecordsAction, RecordsEffect> = {
  create: 'write',
  get: 'read',
  get_many: 'read',
  search: 'read',
  count: 'read',
  aggregate: 'read',
  update: 'write',
  upsert: 'write',
  delete: 'delete',
  // ⚠ REACHABLE, unlike `batch` below — an import declares no allow-list to
  // expand into, because there is nothing to choose: it writes `create` to the
  // bound entity and only that. So a flat 'write' here is the whole truth
  // about it, which is exactly the condition `batch` fails.
  import: 'write',
  // ⚠ UNREACHABLE, and kept so the ratchet keeps working. A `batch` never
  // arrives here: it is EXPANDED into its declared pairs below, so the panel
  // says "creates batch, creates leg" rather than "batches batch" — which is
  // the thing a person actually needs to weigh. A constant here could only
  // under-report (a delete-carrying batch read as a write) or over-report
  // (a create-only batch read as a delete), and both are worse than nothing.
  batch: 'write',
};

/** One Records entity a recipe touches, and how. */
export interface RecordsEntityUsage {
  /** Composition-declared entity kind — `job`, `job_event`, `quote_request`. */
  entity: string;
  /** Every distinct action, in the contract's declared order. */
  actions: RecordsAction[];
  /** The distinct effects those actions have, in read → write → delete order. */
  effects: RecordsEffect[];
}

/** What one pack's Records surface sees from this recipe. */
export interface RecipeRecordsUsage {
  pack_ref: string;
  /** Display name from the roster; the slug when the pack is unnamed. */
  pack_name: string;
  entities: RecordsEntityUsage[];
}

/** The recipe's declared op posture, joined from the installed packs. */
export interface RecipeDeclaredOps {
  /** Strictest `risk` across every resolved Tier-P op. Null when the recipe
   *  names no Tier-P op, or none resolved. */
  risk: RiskTier | null;
  /** True when at least one resolved op declares `approval: 'ask'`. */
  asks_approval: boolean;
  /** Tier-P op ids named by the recipe that no installed pack declares —
   *  an uninstalled pack, a version skew, or a roster read that failed. */
  unresolved: string[];
  /** Resolved Tier-P ops, so a caller can count what the posture rests on. */
  resolved_count: number;
}

/** Loose recipe shape: a `RecipeDefinition` satisfies it. */
export interface RecordsUsageRecipe {
  steps?: unknown;
  prefetch_steps?: unknown;
  trigger_steps?: unknown;
}

/** The op id one step runs, or null.
 *
 *  An authored step names it (`op`). ⛔ AN INSTALLED STEP NO LONGER DOES: pack
 *  install LOWERS `<publisher>.<pack>.<operation>` into a call on the pack's
 *  catalog ingredient — `{ ingredient: <catalog>, input: { operation, args } }`
 *  — and stores that. Every proof here read only `op`, so on an installed pack
 *  each read failed closed: `rental-book`, driven live, showed no views and no
 *  lookups, only eighteen operation buttons.
 *
 *  Mapping it back is not a guess about a name. The catalog and the operation
 *  are exactly what runs, and they resolve to the same op row the authored step
 *  named. It needs the index's `byCatalog`, which only a caller that can derive
 *  catalog slugs supplies; without it, or for a catalog it does not map, the
 *  step resolves to nothing and every proof over it still fails closed.
 *
 *  A KERNEL op lowers the same way, onto its backing ingredient —
 *  `{ ingredient: <backing_slug>, input: <args> }` — and maps back through
 *  `kernelOpForBackingSlug`. That inverse is exact: the registry asserts at load
 *  that no two ordinary ops share a backing slug. It is also the reading the
 *  server's grants already take (`derive-recipe-capability.ts`,
 *  `execute-handler.ts`), so the proof sees a kernel step exactly as it is
 *  authorized. Until it did, a lowered `core.data.read` stayed un-analysable and
 *  an installed pack lost 57 detail pages to operation buttons.
 *
 *  ⛔ An ingredient that is BOTH a kernel backing slug and a mapped catalog has
 *  two readings, so it gets neither and fails closed. */
const stepOpId = (step: unknown, index?: PackOperationIndex): string | null => {
  if (step === null || typeof step !== 'object') return null;
  const row = step as { op?: unknown; ingredient?: unknown; input?: unknown };
  if (typeof row.op === 'string') return row.op === '' ? null : row.op;
  if (typeof row.ingredient !== 'string') return null;
  const kernel = kernelOpForBackingSlug(row.ingredient);
  const packRef = index?.byCatalog.get(row.ingredient);
  if (kernel !== undefined) return packRef === undefined ? kernel : null;
  if (packRef === undefined || row.input === null || typeof row.input !== 'object') return null;
  const operation = (row.input as { operation?: unknown }).operation;
  return typeof operation === 'string' && operation !== '' ? `${packRef}.${operation}` : null;
};

const opIdsIn = (steps: unknown, index?: PackOperationIndex): string[] => {
  if (!Array.isArray(steps)) return [];
  const ids: string[] = [];
  for (const step of steps) {
    const id = stepOpId(step, index);
    if (id !== null) ids.push(id);
  }
  return ids;
};

/** Every op id the recipe names, across all three step arrays, in encounter
 *  order with duplicates kept (the caller dedupes on what it groups by). With
 *  an index, a step install lowered from a pack op counts as that op. */
export const recipeOpIds = (recipe: RecordsUsageRecipe, index?: PackOperationIndex): string[] => [
  ...opIdsIn(recipe.prefetch_steps, index),
  ...opIdsIn(recipe.steps, index),
  ...opIdsIn(recipe.trigger_steps, index),
];

export interface ResolvedOp {
  pack: RecordsUsagePack;
  row: PackOperationRow;
}

/** Every installed pack's composition ops, keyed by the FULL Tier-P id a
 *  recipe names.
 *
 *  ⛔ THIS IS A PARAMETER BECAUSE THE COMMENT BELOW WAS ASPIRATIONAL.
 *  `indexPackOperations` said "built once per render, not per op" and was
 *  true about ops and wrong about RECIPES: both public functions rebuilt it
 *  on every call, so a caller classifying a whole corpus paid a full roster
 *  walk PER RECIPE. Measured on the shipped corpus — 1,048 packs, 2,342
 *  recipes, ~26k declared operations — that sweep took ~58 s of work on top
 *  of ~2 s of actually reading the files.
 *
 *  Taking the built index makes the hoist STRUCTURAL rather than advisory:
 *  you cannot call these without having built one, so the only question left
 *  is where you build it, and that is visible at the call site. */
export interface PackOperationIndex {
  readonly byOpId: ReadonlyMap<string, ResolvedOp>;
  /** Catalog slug → the pack ref (`<publisher>.<slug>`) whose ops it carries,
   *  so a step install lowered onto that catalog resolves back to its op (see
   *  `stepOpId`). Empty unless the caller derived it: a Records catalog slug
   *  is a digest of the pack's owner, computed asynchronously, which this pure
   *  and synchronous module cannot do. */
  readonly byCatalog: ReadonlyMap<string, string>;
}

const NO_CATALOGS: ReadonlyMap<string, string> = new Map();

/** Build the index. Once per roster — reuse it across every recipe.
 *  `catalogs` maps catalog slug → pack ref; pass it wherever the proofs run
 *  over INSTALLED recipes, whose pack ops install has lowered. */
export const buildPackOperationIndex = (
  packs: readonly RecordsUsagePack[],
  catalogs: ReadonlyMap<string, string> = NO_CATALOGS,
): PackOperationIndex => ({ byOpId: indexPackOperations(packs), byCatalog: catalogs });

const indexPackOperations = (
  packs: readonly RecordsUsagePack[],
): Map<string, ResolvedOp> => {
  const byOpId = new Map<string, ResolvedOp>();
  for (const pack of packs) {
    for (const content of pack.manifest?.contents ?? []) {
      if (content.type !== 'composition') continue;
      for (const row of content.composition.operations ?? []) {
        if (typeof row?.op !== 'string' || row.op === '') continue;
        // First declaration wins — a duplicate op id is a pack-authoring
        // error the install validator rejects; tolerating it here keeps the
        // render deterministic either way.
        const opId = `${pack.publisher}.${pack.slug}.${row.op}`;
        if (!byOpId.has(opId)) byOpId.set(opId, { pack, row });
      }
    }
  }
  return byOpId;
};

/** Narrow an opaque `OperationBind` to the Records author binding. Mirrors the
 *  catalog validator's own test (`kind === 'core.records'` + a closed action)
 *  so a non-Records op, or a malformed bind, contributes nothing.
 *
 *  ⚠ THIS NARROWING IS A LOCAL COPY OF A CONTRACT SHAPE, and it under-reported
 *  the moment `batch` arrived: it kept only `{action, entity}`, so a batch's
 *  `allow` — the only place its real reach is written down — was dropped before
 *  anything could read it, and the panel would have shown one anchor entity
 *  where three are touched. A narrow local type reads exactly like the contract
 *  until the contract grows. */
const recordsBindOf = (
  row: PackOperationRow,
): { action: RecordsAction; entity: string; allow?: readonly RecordsBatchAllow[] } | null => {
  const bind = row.bind as unknown;
  if (bind === null || typeof bind !== 'object') return null;
  const { kind, action, entity, allow } = bind as Record<string, unknown>;
  if (kind !== 'core.records') return null;
  if (!isRecordsAction(action)) return null;
  if (typeof entity !== 'string' || entity === '') return null;
  const pairs = Array.isArray(allow)
    ? allow.filter((pair): pair is RecordsBatchAllow =>
      pair !== null && typeof pair === 'object'
      && typeof (pair as { entity?: unknown }).entity === 'string'
      && isRecordsBatchAction((pair as { action?: unknown }).action))
    : undefined;
  return { action, entity, ...(pairs === undefined ? {} : { allow: pairs }) };
};

/** Rank actions by their position in the contract's own `RECORDS_ACTIONS`
 *  ladder, so the rendered list reads the same for every entity rather than in
 *  step order — and so a ninth action added to the contract ranks itself
 *  instead of silently sorting to the front. */
const RECORDS_ACTION_RANK: ReadonlyMap<RecordsAction, number> = new Map(
  RECORDS_ACTIONS.map((action, index) => [action, index] as const),
);

/** Group a recipe's Records ops by pack, then by entity. Packs sort by name and
 *  entities by kind, so the disclosure is stable across renders. */
export const recipeRecordsUsage = (
  recipe: RecordsUsageRecipe,
  packs: PackOperationIndex,
): RecipeRecordsUsage[] => {
  const index = packs.byOpId;
  const byPack = new Map<
    string,
    { pack_name: string; entities: Map<string, Set<RecordsAction>> }
  >();

  for (const opId of recipeOpIds(recipe, packs)) {
    const parsed = parseOpId(opId);
    if (parsed === null || parsed.tier !== 'pack') continue; // kernel / malformed
    const hit = index.get(opId);
    if (hit === undefined) continue; // unresolved — reported by recipeDeclaredOps
    const bind = recordsBindOf(hit.row);
    if (bind === null) continue; // a non-Records op of a Records pack
    let entry = byPack.get(parsed.pack_ref);
    if (entry === undefined) {
      entry = {
        pack_name: hit.pack.name.trim() || hit.pack.slug,
        entities: new Map(),
      };
      byPack.set(parsed.pack_ref, entry);
    }
    // D-226 — ⛔ A BATCH IS EXPANDED, NEVER SUMMARISED. Its `entity` is only an
    // anchor; what it actually touches is the declared allow-list, and each
    // pair is credited to its own entity so the panel reads the same whether a
    // pack wrote three ops or one batch that does the same three things.
    const pairs: { entity: string; action: RecordsAction }[] =
      bind.action === 'batch' && Array.isArray(bind.allow)
        ? bind.allow.map((pair) => ({ entity: pair.entity, action: pair.action }))
        : [{ entity: bind.entity, action: bind.action }];
    for (const pair of pairs) {
      const actions = entry.entities.get(pair.entity) ?? new Set<RecordsAction>();
      actions.add(pair.action);
      entry.entities.set(pair.entity, actions);
    }
  }

  return [...byPack.entries()]
    .map(([pack_ref, entry]) => ({
      pack_ref,
      pack_name: entry.pack_name,
      entities: [...entry.entities.entries()]
        .map(([entity, actions]) => {
          const ordered = [...actions].sort(
            (a, b) => (RECORDS_ACTION_RANK.get(a) ?? 0) - (RECORDS_ACTION_RANK.get(b) ?? 0),
          );
          const effects = (['read', 'write', 'delete'] as const).filter((effect) =>
            ordered.some((action) => RECORDS_ACTION_EFFECT[action] === effect),
          );
          return { entity, actions: ordered, effects: [...effects] };
        })
        .sort((a, b) => a.entity.localeCompare(b.entity)),
    }))
    .sort((a, b) => a.pack_name.localeCompare(b.pack_name) || a.pack_ref.localeCompare(b.pack_ref));
};

/** The strictest declared risk + approval intent across the recipe's Tier-P
 *  ops. This is the pack AUTHOR's classification, carried on every op row —
 *  available whether or not the recipe is exposed as an MCP tool, which is the
 *  gap it fills (the tool catalog only has entries for `chat_exposed`
 *  recipes, so 19 of the 26 Records recipes had no risk at all to show). */
export const recipeDeclaredOps = (
  recipe: RecordsUsageRecipe,
  packs: PackOperationIndex,
): RecipeDeclaredOps => {
  const index = packs.byOpId;
  const unresolved = new Set<string>();
  let risk: RiskTier | null = null;
  let asks = false;
  let resolved = 0;

  for (const opId of recipeOpIds(recipe, packs)) {
    const parsed = parseOpId(opId);
    if (parsed === null || parsed.tier !== 'pack') continue;
    const hit = index.get(opId);
    if (hit === undefined) {
      unresolved.add(opId);
      continue;
    }
    resolved += 1;
    const rowRisk: unknown = hit.row.risk;
    if (isRiskTier(rowRisk)) {
      if (risk === null || (RISK_TIER_RANK[rowRisk] ?? 0) > (RISK_TIER_RANK[risk] ?? 0)) {
        risk = rowRisk;
      }
    }
    const approval: OperationApproval | undefined = hit.row.approval;
    if (approval === 'ask') asks = true;
  }

  return {
    risk,
    asks_approval: asks,
    unresolved: [...unresolved].sort(),
    resolved_count: resolved,
  };
};

/** Step kinds whose effects this module can actually account for: `transform`
 *  and `guard` are pure, `op` is what the two read-only axes inspect. A step
 *  matching none of them — an `ingredient` step, or a kind added later — is not
 *  understood, and "not understood" cannot be allowed to read as "harmless".
 *  See the header.
 *
 *  The one `ingredient` step it does understand is a pack op install LOWERED,
 *  and only when the index maps its catalog back to that op (`stepOpId`); the
 *  op itself is then judged like any other. */
export const stepsAreAnalysable = (steps: unknown, index?: PackOperationIndex): boolean => {
  if (steps === undefined || steps === null) return true;
  if (!Array.isArray(steps)) return false;
  return steps.every((step) => {
    if (step === null || typeof step !== 'object') return false;
    const row = step as Record<string, unknown>;
    return typeof row.transform === 'string'
      || typeof row.op === 'string'
      || row.guard !== undefined
      || (typeof row.ingredient === 'string' && stepOpId(step, index) !== null);
  });
};

/** Can we PROVE this recipe only reads? See the header — every step kind
 *  understood, both axes clean, and an unresolved op is a no. */
/** ⛔⛔ TAKES THE FULL DEFINITION, AND THE TYPE IS THE GUARD.
 *  `stepsAreAnalysable(undefined)` is `true` — correct for the optional
 *  `prefetch_steps` / `trigger_steps`, and a trap for `steps`, which every
 *  recipe has. Hand this a body whose `steps` were stripped and every check
 *  passes vacuously: no steps, so no ops, so nothing unresolved and no write
 *  effect — it answers TRUE for a recipe that deletes. That is a permissions
 *  answer failing OPEN.
 *
 *  So the parameter is `RecordsUsageRecipe & { steps: unknown }`: a
 *  `recipe.list` row whose body has been trimmed cannot be passed without the
 *  compiler saying so. Consumers of a trimmed row read the server's projected
 *  `provably_read_only` instead — computed HERE, on the server, where the
 *  whole definition is.
 *
 *  ⛔⛔ AND THE TYPE WAS NOT ENOUGH, SO THE BODY CHECKS TOO. A cast walks past a
 *  parameter type, and the webclient's fallback for a row without the server's
 *  answer did exactly that (`entry.recipe as never`): any trimmed row, a delete
 *  included, came back read-only and ran as a view (2026-09-24 audit). Every
 *  recipe has a `steps` array (2,389 of 2,389 in `community/`), so a body
 *  without one was trimmed, and it proves nothing. */
export const isProvablyReadOnly = (
  recipe: RecordsUsageRecipe & { steps: unknown },
  roster: PackOperationIndex,
): boolean => {
  const r = recipe as unknown as {
    steps?: unknown; prefetch_steps?: unknown; trigger_steps?: unknown;
  };
  if (!Array.isArray(r.steps)) return false;
  if (
    !stepsAreAnalysable(r.steps, roster)
    || !stepsAreAnalysable(r.prefetch_steps, roster)
    || !stepsAreAnalysable(r.trigger_steps, roster)
  ) {
    return false;
  }
  const declared = recipeDeclaredOps(recipe, roster);
  if (declared.unresolved.length > 0) return false;
  if (declared.risk !== null && declared.risk !== 'read') return false;
  // ⛔⛔ D-282 — THE KERNEL TIER, WHICH `recipeDeclaredOps` SKIPS BY DESIGN.
  // Its loop reads `if (parsed.tier !== 'pack') continue`, which is right for
  // ITS job (the D-221 Records disclosure is about pack ops) and left this
  // proof — the one that decides a recipe may auto-run as a view, and which
  // D-282 B4 then re-runs on every data burst — blind to `core.*` entirely.
  // Measured before the fix: 49 of 396 views contained a kernel op the registry
  // itself calls `write`, `core.mail.send` among them.
  for (const opId of recipeOpIds(recipe, roster)) {
    const parsed = parseOpId(opId);
    // ⚠ An op id that does not PARSE is skipped by the loop above too, so it
    // used to buy silence twice over. We cannot prove anything about it.
    if (parsed === null) return false;
    if (parsed.tier !== 'kernel') continue;
    // `null` ⇒ this registry cannot classify it ⇒ fail closed, exactly as an
    // unresolved pack op does two lines up.
    if (kernelOpRiskTier(opId) !== 'read') return false;
    // A `read`-risk op can still DELIVER something (a notification, an approval
    // request). Nothing that runs unasked may send, so it is not read-only here.
    if (kernelOpDelivers(opId)) return false;
    // Nor a watcher: it fetches, drains or arms something, and belongs to an
    // automation, never a view (the backstop `kernelOpIsWatcher` describes).
    if (kernelOpIsWatcher(opId)) return false;
  }
  return recipeRecordsUsage(recipe, roster).every((pack) =>
    pack.entities.every((entity) =>
      !entity.effects.includes('write') && !entity.effects.includes('delete')));
};

/** D-282 — does one run of this recipe SPEND the owner something?
 *
 *  🔑🔑 THE SECOND OF THE TWO QUESTIONS A SURFACE MUST ANSWER BEFORE RUNNING A
 *  RECIPE NOBODY ASKED FOR. The first is "may I run this without being asked"
 *  — an EFFECT question, which {@link isProvablyReadOnly} now answers across
 *  both tiers. This is "may I run it REPEATEDLY without spending", and no risk
 *  tier can answer it: `core.ai.summarize` is `risk: 'read'` and that is
 *  correct — it changes nothing — while costing tokens every single time.
 *  Measured 2026-09-21: 114 of 396 pack views called `core.ai.*`, each of them
 *  an auto-run on tab selection and, after B4, a re-run on every data burst.
 *
 *  A kernel op id is visible in the recipe body alone, so that half needs no
 *  roster and a client can always compute it.
 *
 *  🔑 AND A PACK OP MARKED `spends_per_call` SPENDS TOO (2026-09-25, owner
 *  decision). The kernel half alone missed every metered vendor API: eight shipped
 *  views called one (an OpenAI response, Tavily and Exa searches, Wolfram Alpha)
 *  on every tab switch. That half needs the roster, which the server always has
 *  (`recipe-list-handler.ts`). Without one, a recipe calling a pack op is not a
 *  view anyway: its op does not resolve, so `isProvablyReadOnly` refuses it. */
export const recipeSpendsPerRun = (
  recipe: RecordsUsageRecipe,
  roster?: PackOperationIndex,
): boolean =>
  recipeOpIds(recipe, roster).some((opId) =>
    kernelOpSpendsPerRun(opId) || roster?.byOpId.get(opId)?.row.spends_per_call === true);


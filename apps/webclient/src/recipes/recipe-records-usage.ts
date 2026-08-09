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

import {
  RECORDS_ACTIONS,
  RISK_TIER_RANK,
  isRecordsAction,
  isRiskTier,
  parseOpId,
  type BulkPackManifest,
  type OperationApproval,
  type PackOperationRow,
  isRecordsBatchAction,
  type RecordsAction,
  type RecordsBatchAllow,
  type RiskTier,
} from '@recued/contracts';

/** The subset of a `packs.list` row this join needs. The caller maps a
 *  `PackListEntry` into it. */
export interface RecordsUsagePack {
  slug: string;
  publisher: string;
  name: string;
  /** Absent for an UNINSTALLED pack — `packs.list` forwards a manifest only
   *  for installed packs (see `PackListEntry.manifest`). A pack with no
   *  manifest contributes no operations, which is exactly the `unresolved`
   *  outcome this module already models — not an empty one. */
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

const opIdsIn = (steps: unknown): string[] => {
  if (!Array.isArray(steps)) return [];
  const ids: string[] = [];
  for (const step of steps) {
    if (step === null || typeof step !== 'object') continue;
    const op = (step as { op?: unknown }).op;
    if (typeof op === 'string' && op !== '') ids.push(op);
  }
  return ids;
};

/** Every op id the recipe names, across all three step arrays, in encounter
 *  order with duplicates kept (the caller dedupes on what it groups by). */
export const recipeOpIds = (recipe: RecordsUsageRecipe): string[] => [
  ...opIdsIn(recipe.prefetch_steps),
  ...opIdsIn(recipe.steps),
  ...opIdsIn(recipe.trigger_steps),
];

interface ResolvedOp {
  pack: RecordsUsagePack;
  row: PackOperationRow;
}

/** Index every installed pack's composition ops by their FULL Tier-P id, which
 *  is what a recipe names. Built once per render, not per op. */
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
  packs: readonly RecordsUsagePack[],
): RecipeRecordsUsage[] => {
  const index = indexPackOperations(packs);
  const byPack = new Map<
    string,
    { pack_name: string; entities: Map<string, Set<RecordsAction>> }
  >();

  for (const opId of recipeOpIds(recipe)) {
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
  packs: readonly RecordsUsagePack[],
): RecipeDeclaredOps => {
  const index = indexPackOperations(packs);
  const unresolved = new Set<string>();
  let risk: RiskTier | null = null;
  let asks = false;
  let resolved = 0;

  for (const opId of recipeOpIds(recipe)) {
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

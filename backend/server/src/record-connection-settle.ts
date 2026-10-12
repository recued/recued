/** D-320 ruling 20d — a step on one record, with no connection chosen, runs on the
 *  connection its record's id names.
 *
 *  A CRM record's id names the connection it came from (D-190,
 *  `<vendor>_<entity>_<connection>_<native>`). Until now the run settled the
 *  step's connection first, by the pack's default or by asking, and the gateway
 *  then refused the record if it named another (D-254, `PLATFORM_ID_SOURCE_MISMATCH`):
 *  with two HubSpot connections, a deal from the one that is not the default could
 *  not be read without the owner naming it, and a scheduled run could not at all.
 *  The owner's ruling 20: when nobody chose a connection, the record's id settles
 *  it; when someone did, a record from another connection is still refused (D-254
 *  cell B).
 *
 *  Settled BEFORE the run's other rules, as a value for the step's setting: the
 *  pack's default, the pick layer's ask and the pinned-target refusal then find the
 *  setting given, and everything that reads a setting (the resolve, which lowers a
 *  vendor-neutral step for the record's own vendor, the gateway's grant and
 *  contract checks, the run's record, `context.connections`) reads the record's
 *  connection. The gateway then hands the vendor its own id, as it did.
 *
 *  ⚠ ONLY AN ID KNOWN BEFORE THE RUN: a literal, a value of the run's config or
 *  context (`{{context.entity_id}}`, 93 of the shipped record steps), or one an
 *  earlier `default` or `trim` step makes of those (4 more, ruling 20, 2026-10-11:
 *  pure functions of values the run already has, computed here by the same
 *  transforms). An id another step produces is not known yet, so it settles
 *  nothing; a record it names from another connection is refused at the call, as
 *  before, naming that connection.
 *
 *  ⚠ Left alone, so the run's other rules decide as before: an id that names no
 *  connection, one whose connection is not set up here, one naming a record of
 *  another kind than the step reads, and a setting whose steps' records name two
 *  connections. */

import {
  CANONICAL_CRM_VERBS,
  collectRefs,
  getVendorEntityByCrmAlias,
  isCanonicalOpStep,
  parseOpId,
  parsePlatformRecordTargetId,
  recordIdArgKind,
  resolveValue,
  type CrmAlias,
  type IngredientManifest,
  type NamespaceStores,
  type RecipeDefinition,
} from '@recued/contracts';
import {
  CanonicalOpResolutionError,
  lowerOpStepRecipe,
  opStepConnectionSlots,
  WRITE_SELECTOR_KEY,
  type PackOpResolution,
} from '@recued/recipes';
import { TRANSFORMS, type TransformContext } from '@recued/transforms';

/** A pure `{{config.<var>}}` setting ref, the only shape a step signs in through. */
const PURE_CONFIG_REF = /^\{\{\s*config\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;

/** The canonical verbs that act on one record, by the id in `args.id`. */
const RECORD_VERBS: ReadonlySet<string> = new Set(
  (CANONICAL_CRM_VERBS as readonly string[]).filter((verb) => verb === 'read' || verb === 'update' || verb === 'delete'),
);

export interface RecordConnectionDeps {
  /** The catalogs. Absent (a partial host's door) ⇒ a vendor's op settles nothing. */
  manifests: { get(slug: string): IngredientManifest | null } | undefined;
  packs?: PackOpResolution | undefined;
  /** Whether a connection is set up on this server. */
  isSetUp: (connection_name: string) => boolean;
}

/** The record a step acts on: the id as authored, and the kind of record the step
 *  reads (`entity` for a vendor's op, the CRM alias for a vendor-neutral one). */
interface StepRecord {
  setting: string;
  id: unknown;
  matches: (vendor: string, entity: string) => boolean;
}

const recordOf = (
  step: Readonly<Record<string, unknown>>,
  deps: RecordConnectionDeps,
): StepRecord | undefined => {
  const setting = typeof step.connection === 'string' ? PURE_CONFIG_REF.exec(step.connection.trim())?.[1] : undefined;
  if (setting === undefined) return undefined;
  const args = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  // A vendor's own op names the argument its record id rides on (`record_id_arg`),
  // and the argument says what kind of record that is (`recordIdArgKind`): not the
  // op's own family, since `engagement.list` takes a `deal_id`.
  const byOperation = (catalog: string, operation: string, from: Record<string, unknown>): StepRecord | undefined => {
    const arg = deps.manifests?.get(catalog)?.operations?.[operation]?.record_id_arg;
    if (arg === undefined) return undefined;
    const kind = recordIdArgKind(arg);
    return { setting, id: from[arg], matches: (_vendor, entity) => entity === kind };
  };
  if (typeof step.op === 'string') {
    const parsed = parseOpId(step.op);
    if (parsed?.tier === 'pack') {
      const binding = deps.packs?.get(parsed.pack_ref);
      return binding === undefined ? undefined : byOperation(binding.catalog_slug, parsed.operation, args(step.args));
    }
    // A vendor-neutral op: `core.crm.<alias>.<verb>`, or the legacy bare form.
    const [alias, verb, ...extra] = parsed?.tier === 'kernel' && parsed.domain === 'crm'
      ? parsed.op.split('.')
      : parsed === null ? step.op.split('.') : [];
    if (alias === undefined || verb === undefined || extra.length > 0 || !RECORD_VERBS.has(verb)) return undefined;
    return {
      setting,
      id: args(step.args)[WRITE_SELECTOR_KEY],
      matches: (vendor, entity) => getVendorEntityByCrmAlias(vendor, alias as CrmAlias)?.entity === entity,
    };
  }
  if (typeof step.ingredient === 'string') {
    const input = args(step.input);
    return typeof input.operation === 'string' ? byOperation(step.ingredient, input.operation, args(input.args)) : undefined;
  }
  return undefined;
};

/** Not known before the run. */
const UNKNOWN: unique symbol = Symbol('unknown before the run');

/** The transforms an id may pass through and still be known before the run, each
 *  with the params it reads: pure functions, so the run computes the same value
 *  from the same config. The shapes shipped recipes use. */
const PASS_THROUGH: Readonly<Record<string, readonly string[]>> = {
  default: ['value', 'fallback'],
  trim: ['input'],
};

/** `default` and `trim` read none of it. */
const NO_RUN: TransformContext = {
  resolve: () => undefined,
  evaluate: () => false,
  now: () => new Date(0),
};

type StepIndex = ReadonlyMap<string, Readonly<Record<string, unknown>>>;

/** A value as the run will have it before any step runs, or `UNKNOWN`: a literal,
 *  one ref into the run's config or context, or the output of an earlier
 *  `default` / `trim` step whose params are such values (`earlier`: the steps
 *  before the one reading it). Resolved as the engine resolves a step's params. */
const knownBeforeRun = (
  value: unknown,
  stores: Pick<NamespaceStores, 'config' | 'context'>,
  earlier: StepIndex,
  depth = 0,
): unknown => {
  if (typeof value !== 'string' || !value.includes('{{')) return value;
  const refs = collectRefs(value);
  if (refs.length !== 1 || !/^\{\{[^{}]*\}\}$/.test(value)) return UNKNOWN;
  const { ns, path } = refs[0]!;
  if (ns === 'config' || ns === 'context') return resolveValue(value, stores as NamespaceStores);
  // The whole output of an earlier step, never a field of it.
  if (ns !== 'step' || depth >= 3 || path.length === 0 || path.includes('.')) return UNKNOWN;
  const source = earlier.get(path);
  const reads = source !== undefined && typeof source.transform === 'string' ? PASS_THROUGH[source.transform] : undefined;
  // A step that may skip itself, or runs per item, has no one value before the run.
  if (source === undefined || reads === undefined || source.skip_when !== undefined || source.foreach !== undefined) {
    return UNKNOWN;
  }
  const params: Record<string, unknown> = {};
  for (const name of reads) {
    if (!(name in source)) continue;
    const known = knownBeforeRun(source[name], stores, earlier, depth + 1);
    if (known === UNKNOWN) return UNKNOWN;
    params[name] = known;
  }
  return TRANSFORMS.get(source.transform as string)!(params, NO_RUN);
};

/** For each setting nobody chose (`explicit` holds the chosen ones), the connection
 *  its steps' records name, when they name one between them and it is set up. */
export const settingsFromRecordIds = (
  recipe: RecipeDefinition,
  input: {
    config: Readonly<Record<string, unknown>>;
    context?: Readonly<Record<string, unknown>> | undefined;
    explicit: ReadonlySet<string>;
  },
  deps: RecordConnectionDeps,
): Record<string, string> => {
  const stores = { config: { ...input.config }, context: { ...(input.context ?? {}) } };
  const named = new Map<string, Set<string>>();
  const unroutable = new Set<string>();
  // In run order: the prefetch steps, then the steps. A trigger step runs apart.
  const runs = [...(recipe.prefetch_steps ?? []), ...recipe.steps] as ReadonlyArray<Readonly<Record<string, unknown>>>;
  const earlier = new Map<string, Readonly<Record<string, unknown>>>();
  for (const step of [...runs, ...((recipe.trigger_steps ?? []) as ReadonlyArray<Readonly<Record<string, unknown>>>)]) {
    if (step === null || typeof step !== 'object') continue;
    const record = recordOf(step, deps);
    const before: StepIndex = runs.includes(step) ? new Map(earlier) : new Map();
    if (runs.includes(step) && typeof step.id === 'string') earlier.set(step.id, step);
    if (record === undefined || input.explicit.has(record.setting)) continue;
    const known = knownBeforeRun(record.id, stores, before);
    const parsed = known === UNKNOWN ? null : parsePlatformRecordTargetId(known);
    if (parsed === null) continue;
    if (!record.matches(parsed.vendor, parsed.entity) || !deps.isSetUp(parsed.connection_name)) {
      unroutable.add(record.setting);
      continue;
    }
    named.set(record.setting, (named.get(record.setting) ?? new Set<string>()).add(parsed.connection_name));
  }
  const out: Record<string, string> = {};
  for (const [setting, connections] of named) {
    if (connections.size === 1 && !unroutable.has(setting)) out[setting] = [...connections][0]!;
  }
  return out;
};

// ════════════════════════════════════════════════════════════════
// D-320 ruling 20g — a record id the run learns mid-run
// ════════════════════════════════════════════════════════════════

/** Mark each record step whose setting nobody chose to follow its record's
 *  connection at the call (`connection_follows_record`, which the engine reads,
 *  `connectionForRecord`): a catalog step whose `connection` is a setting not in
 *  `explicit` and whose operation declares the argument its record id rides on.
 *  On the run's copy, once its steps are resolved. A mark the recipe carried itself
 *  is dropped first: only the host may let a step leave its connection. */
export const markRecordFollowers = (
  recipe: RecipeDefinition,
  explicit: ReadonlySet<string>,
  deps: Pick<RecordConnectionDeps, 'manifests'>,
): { recipe: RecipeDefinition; marked: ReadonlySet<string> } => {
  const marked = new Set<string>();
  const mark = (steps: ReadonlyArray<Readonly<Record<string, unknown>>> | undefined) => (steps ?? []).map((step) => {
    if (step === null || typeof step !== 'object') return step;
    const { connection_follows_record: _authored, ...rest } = step as Record<string, unknown>;
    const setting = typeof rest.connection === 'string' ? PURE_CONFIG_REF.exec(rest.connection.trim())?.[1] : undefined;
    const input = rest.input !== null && typeof rest.input === 'object' && !Array.isArray(rest.input)
      ? rest.input as Record<string, unknown>
      : undefined;
    const declares = typeof rest.ingredient === 'string' && typeof input?.operation === 'string'
      && deps.manifests?.get(rest.ingredient)?.operations?.[input.operation]?.record_id_arg !== undefined;
    if (setting === undefined || explicit.has(setting) || !declares) return _authored === undefined ? step : rest;
    if (typeof rest.id === 'string') marked.add(rest.id);
    return { ...rest, connection_follows_record: true };
  });
  const out = {
    ...recipe,
    ...(recipe.prefetch_steps !== undefined ? { prefetch_steps: mark(recipe.prefetch_steps as never) } : {}),
    steps: mark(recipe.steps as never),
    ...(recipe.trigger_steps !== undefined ? { trigger_steps: mark(recipe.trigger_steps as never) } : {}),
  } as unknown as RecipeDefinition;
  return { recipe: out, marked };
};

/** An id the run learns mid-run that carries its connection: a `target_id` an
 *  earlier step or a `foreach` item holds (`{{item.target_id}}`,
 *  `{{step.deals.0.target_id}}`). Written so by an author who means the record to
 *  name its connection. */
const MID_RUN_TARGET_ID = /^\{\{\s*(?:step|item)(?:\.[A-Za-z0-9_-]+)*\.target_id\s*\}\}$/;

/** The connection to resolve a setting's vendor-neutral steps against when the run
 *  leaves the setting to its records instead of asking which or refusing: every
 *  op-step on it acts on one record (read / update / delete) by a mid-run
 *  `target_id`, or is a search (which reads every connection itself, ruling 20c),
 *  and every connection that can serve them is of one catalog. The
 *  steps are resolved for that catalog's vendor and the setting stays empty, so
 *  each call takes its record's connection (`markRecordFollowers`), and one whose
 *  id names none is refused. Undefined ⇒ the run asks or refuses, as before. */
export const recordRoutedConnection = (
  recipe: RecipeDefinition,
  setting: string,
  candidates: ReadonlyArray<{ connection_name: string; catalog_slug?: string }>,
  packs?: PackOpResolution,
): string | undefined => {
  if (candidates.length === 0 || new Set(candidates.map((c) => c.catalog_slug)).size !== 1) return undefined;
  let lowered: RecipeDefinition;
  try {
    lowered = lowerOpStepRecipe(recipe, packs ?? new Map());
  } catch (e) {
    if (e instanceof CanonicalOpResolutionError) return undefined;
    throw e;
  }
  const slots = opStepConnectionSlots(lowered);
  if (!slots.ok) return undefined;
  let any = false;
  for (const step of lowered.steps) {
    if (!isCanonicalOpStep(step) || slots.slotByStepId.get(step.id) !== setting) continue;
    const verb = step.op.split('.')[1];
    if (verb === 'search') continue;
    const id = (step.args as Record<string, unknown> | undefined)?.[WRITE_SELECTOR_KEY];
    if (verb === undefined || !RECORD_VERBS.has(verb) || typeof id !== 'string' || !MID_RUN_TARGET_ID.test(id)) return undefined;
    any = true;
  }
  return any ? candidates[0]!.connection_name : undefined;
};


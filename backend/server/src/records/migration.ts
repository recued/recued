import { createHash } from 'node:crypto';
import { copyLiteralJson } from './literal-json.js';

const MIGRATE = 'core.records.migrate';
const VERIFY = 'core.records.verify-migration';
const FINALIZE = 'core.records.finalize-migration';
const PRIVILEGED = new Set([MIGRATE, VERIFY, FINALIZE]);
const ROOT_KEYS = [
  'chat_exposed', 'metadata', 'output', 'prefetch_steps', 'recipe_id',
  'steps', 'ttl', 'variables', 'version',
] as const;
const METADATA_KEYS = new Set([
  'author', 'description', 'name', 'recipe_bundle', 'supported_platforms',
]);
const NAMESPACE_KEYS = new Set([
  'publisher', 'publisher_id', 'pack', 'pack_ref', 'pack_slug', 'namespace',
  'namespace_id', 'owner',
]);

export type RecordsMigrationMapping =
  | { op: 'move' | 'copy'; from: string; to: string }
  | { op: 'clear'; from: string }
  | { op: 'default'; to: string; value: unknown }
  | { op: 'safe_cast'; from: string; to: string }
  | { op: 'change_kind'; from: string; to: string; collision: 'refuse' }
  | { op: 'relationship'; from: string; to: string };

export interface RecordsMigrationTransformStep {
  id: string;
  op: typeof MIGRATE;
  args: {
    kind: string;
    from_v: number;
    new_v: number;
    field_mapping: RecordsMigrationMapping[];
  };
  args_hash: string;
}

export interface RecordsMigrationVerifyStep {
  id: string;
  op: typeof VERIFY;
  args: { kind: string; from_v: number; new_v: number };
  args_hash: string;
}

export interface RecordsMigrationFinalizeStep {
  id: string;
  op: typeof FINALIZE;
  args: { from_v: number; new_v: number };
  args_hash: string;
}

export interface RecordsMigrationPlan {
  recipe_id: string;
  recipe_version: number;
  recipe_digest: string;
  from_v: number;
  new_v: number;
  steps: Array<RecordsMigrationTransformStep | RecordsMigrationVerifyStep>;
  finalizer: RecordsMigrationFinalizeStep;
}

export type RecordsMigrationClassification =
  | { kind: 'business' }
  | { kind: 'migration'; plan: RecordsMigrationPlan }
  | { kind: 'invalid'; issue: string };

export interface RecordsMigrationRecipeRef {
  slug: string;
  version: number;
  visible?: boolean;
}

const plain = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const sameKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
};
const digest = (value: unknown): string =>
  createHash('sha256').update(canonical(value)).digest('hex');

const literalTreeIssue = (value: unknown, path = '$', seen = new Set<object>()): string | null => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string' && value.includes('{{')) return `${path} contains a dynamic reference`;
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))
      ? null : `${path} contains a non-literal number`;
  }
  if (typeof value !== 'object') return `${path} is not literal JSON`;
  if (seen.has(value)) return `${path} is cyclic`;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const issue = literalTreeIssue(value[index], `${path}[${index}]`, seen);
      if (issue) return issue;
    }
  } else {
    if (!plain(value)) return `${path} has a non-literal prototype`;
    for (const key of Object.keys(value)) {
      if (NAMESPACE_KEYS.has(key.toLowerCase())) return `${path}.${key} is a forbidden namespace selector`;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) return `${path}.${key} is not a data property`;
      const issue = literalTreeIssue(descriptor.value, `${path}.${key}`, seen);
      if (issue) return issue;
    }
  }
  seen.delete(value);
  return null;
};

const positiveVersion = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z][a-z0-9_.-]{0,127}$/.test(value);

const mappingIssue = (raw: unknown): string | null => {
  if (!plain(raw) || typeof raw.op !== 'string') return 'field mapping must be an object with an op';
  switch (raw.op) {
    case 'move':
    case 'copy':
    case 'safe_cast':
    case 'relationship':
      if (!sameKeys(raw, ['op', 'from', 'to']) || !identifier(raw.from) || !identifier(raw.to)) {
        return `${raw.op} mapping must contain only literal from/to field names`;
      }
      return null;
    case 'clear':
      return sameKeys(raw, ['op', 'from']) && identifier(raw.from)
        ? null : 'clear mapping must contain only a literal from field';
    case 'default':
      if (!sameKeys(raw, ['op', 'to', 'value']) || !identifier(raw.to)) {
        return 'default mapping must contain only to/value';
      }
      return literalTreeIssue(raw.value, '$.default.value');
    case 'change_kind':
      return sameKeys(raw, ['op', 'from', 'to', 'collision'])
        && identifier(raw.from) && identifier(raw.to) && raw.collision === 'refuse'
        ? null : 'change_kind requires literal from/to and collision:"refuse"';
    default:
      return `unknown migration mapping '${String(raw.op)}'`;
  }
};

/** Whole-recipe, fail-closed migration classifier. */
export const classifyRecordsMigrationRecipe = (
  ref: RecordsMigrationRecipeRef,
  recipe: unknown,
  expectedBundle: string,
): RecordsMigrationClassification => {
  const invalid = (issue: string): RecordsMigrationClassification => ({ kind: 'invalid', issue });
  const literal = copyLiteralJson(recipe);
  if (!literal.ok) return invalid(`migration candidate must be literal JSON: ${literal.issue}`);
  recipe = literal.value;
  const rawSteps = plain(recipe) && Array.isArray(recipe.steps) ? recipe.steps : [];
  const containsPrivileged = rawSteps.some((step) =>
    plain(step) && typeof step.op === 'string' && PRIVILEGED.has(step.op));
  if (!containsPrivileged) return { kind: 'business' };
  if (ref.visible !== false) return invalid('migration content ref must be visible:false');
  if (!plain(recipe) || !sameKeys(recipe, ROOT_KEYS)) return invalid('migration root must use the closed recipe shape');
  if (recipe.recipe_id !== ref.slug || recipe.version !== ref.version) return invalid('migration body identity does not match its content ref');
  if (recipe.chat_exposed !== false) return invalid('migration must be chat_exposed:false');
  if (!plain(recipe.variables) || Object.keys(recipe.variables).length !== 0) return invalid('migration variables must be empty');
  if (!Array.isArray(recipe.prefetch_steps) || recipe.prefetch_steps.length !== 0) return invalid('migration prefetch_steps must be empty');
  if (!plain(recipe.output) || !sameKeys(recipe.output, ['render'])
    || !Array.isArray(recipe.output.render) || recipe.output.render.length !== 0) {
    return invalid('migration output must be exactly { render: [] }');
  }
  if (!plain(recipe.metadata)) return invalid('migration metadata is required');
  for (const key of Object.keys(recipe.metadata)) {
    if (!METADATA_KEYS.has(key)) return invalid(`migration metadata key '${key}' is not inert`);
  }
  for (const key of ['name', 'description', 'author', 'supported_platforms']) {
    if (!Object.hasOwn(recipe.metadata, key)) return invalid(`migration metadata.${key} is required`);
  }
  if (recipe.metadata.recipe_bundle !== undefined && recipe.metadata.recipe_bundle !== expectedBundle) {
    return invalid('migration recipe_bundle disagrees with verified pack provenance');
  }
  const literalIssue = literalTreeIssue(recipe);
  if (literalIssue) return invalid(literalIssue);
  if (!Array.isArray(recipe.steps) || recipe.steps.length < 1) return invalid('migration requires executable steps');

  let edge: { from_v: number; new_v: number } | null = null;
  const classified: Array<RecordsMigrationTransformStep | RecordsMigrationVerifyStep | RecordsMigrationFinalizeStep> = [];
  for (let index = 0; index < recipe.steps.length; index += 1) {
    const step = recipe.steps[index];
    if (!plain(step) || !sameKeys(step, ['args', 'id', 'op']) || !identifier(step.id) || !plain(step.args)) {
      return invalid(`migration step ${index} must contain exactly id/op/args`);
    }
    if (!PRIVILEGED.has(step.op as string)) return invalid(`migration step '${step.id}' uses a business operation`);
    const args = step.args;
    if (!positiveVersion(args.from_v) || !positiveVersion(args.new_v) || args.from_v === args.new_v) {
      return invalid(`migration step '${step.id}' has an invalid/self-loop edge`);
    }
    if (edge === null) edge = { from_v: args.from_v, new_v: args.new_v };
    if (edge.from_v !== args.from_v || edge.new_v !== args.new_v) return invalid('all migration steps must agree on one edge');
    if (step.op === FINALIZE) {
      if (!sameKeys(args, ['from_v', 'new_v']) || index !== recipe.steps.length - 1) {
        return invalid('finalize-migration must occur exactly once, last, with only from_v/new_v');
      }
      classified.push({ id: step.id, op: FINALIZE, args: args as never, args_hash: digest(args) });
      continue;
    }
    if (step.op === VERIFY) {
      if (!sameKeys(args, ['kind', 'from_v', 'new_v']) || !identifier(args.kind)) {
        return invalid(`verify step '${step.id}' has an invalid closed args envelope`);
      }
      classified.push({ id: step.id, op: VERIFY, args: args as never, args_hash: digest(args) });
      continue;
    }
    if (!sameKeys(args, ['field_mapping', 'from_v', 'kind', 'new_v'])
      || !identifier(args.kind) || !Array.isArray(args.field_mapping)
      || args.field_mapping.length < 1 || args.field_mapping.length > 100) {
      return invalid(`migrate step '${step.id}' has an invalid closed args envelope`);
    }
    const targets = new Set<string>();
    for (const mapping of args.field_mapping) {
      const issue = mappingIssue(mapping);
      if (issue) return invalid(`migrate step '${step.id}': ${issue}`);
      const target = plain(mapping) && typeof mapping.to === 'string' ? mapping.to : undefined;
      if (target !== undefined && targets.has(target)) return invalid(`migrate step '${step.id}' writes target '${target}' twice`);
      if (target !== undefined) targets.add(target);
    }
    classified.push({ id: step.id, op: MIGRATE, args: args as never, args_hash: digest(args) });
  }
  const finalizers = classified.filter((step) => step.op === FINALIZE);
  if (finalizers.length !== 1 || classified.at(-1)?.op !== FINALIZE || edge === null) {
    return invalid('migration requires exactly one last finalizer');
  }
  return {
    kind: 'migration',
    plan: {
      recipe_id: recipe.recipe_id as string,
      recipe_version: recipe.version as number,
      recipe_digest: digest(recipe),
      from_v: edge.from_v,
      new_v: edge.new_v,
      steps: classified.slice(0, -1) as Array<RecordsMigrationTransformStep | RecordsMigrationVerifyStep>,
      finalizer: finalizers[0] as RecordsMigrationFinalizeStep,
    },
  };
};

export class RecordsMigrationRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordsMigrationRouteError';
  }
}

/** Unique shortest monotonic route. Equal-shortest ambiguity is a refusal. */
export const selectRecordsMigrationRoute = (
  plans: readonly RecordsMigrationPlan[],
  fromVersion: number,
  targetVersion: number,
  maxEdges = 8,
): RecordsMigrationPlan[] => {
  if (fromVersion === targetVersion) return [];
  const upgrading = targetVersion > fromVersion;
  const candidates = plans.filter((plan) =>
    plan.from_v !== plan.new_v
    && (upgrading ? plan.new_v > plan.from_v : plan.new_v < plan.from_v));
  const queue: Array<{ version: number; path: RecordsMigrationPlan[]; seen: Set<number> }> = [
    { version: fromVersion, path: [], seen: new Set([fromVersion]) },
  ];
  const solutions: RecordsMigrationPlan[][] = [];
  let shortest = Number.POSITIVE_INFINITY;
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.path.length >= shortest || current.path.length >= maxEdges) continue;
    for (const plan of candidates.filter((candidate) => candidate.from_v === current.version)) {
      if (current.seen.has(plan.new_v)) continue;
      if (upgrading && plan.new_v > targetVersion) continue;
      if (!upgrading && plan.new_v < targetVersion) continue;
      const path = [...current.path, plan];
      if (plan.new_v === targetVersion) {
        if (path.length < shortest) {
          shortest = path.length;
          solutions.length = 0;
        }
        if (path.length === shortest) solutions.push(path);
      } else {
        queue.push({ version: plan.new_v, path, seen: new Set([...current.seen, plan.new_v]) });
      }
    }
  }
  if (solutions.length === 0) throw new RecordsMigrationRouteError('no complete monotonic migration route');
  const identities = new Set(solutions.map((route) => route.map((plan) => plan.recipe_digest).join('>')));
  if (identities.size !== 1) throw new RecordsMigrationRouteError('migration route has equal-shortest ambiguity');
  return solutions[0]!;
};

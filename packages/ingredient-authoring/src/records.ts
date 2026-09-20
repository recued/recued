import {
  RECORDS_DECIMAL_SCALE,
  RECORDS_SLOT_FAMILIES,
  isRecordsAction,
  normalizeOperationArg,
  recordsSlotKind,
  type EntitySchemaIngredientInput,
  type IngredientManifest,
  type MetaFieldType,
  type OperationArgSpec,
  type RecordsAction,
  type RecordsAuthorBinding,
  type RecordsEntitySnapshot,
  type RecordsFieldKind,
  type RecordsFieldSnapshot,
  type RecordsSchemaSnapshot,
  type RiskTier,
  validateRecordsAggregateSelect,
  validateRecordsGroupBy,
  validateRecordsBatchAllow,
  validateRecordsRootProjection,
} from '@recued/contracts';

import { canonicalHash } from './canonical-hash.js';
import type {
  CompositionIngredient,
  IngredientEntityField,
  PackOperationRow,
} from './schema.js';

export interface RecordsAuthoringIssue {
  severity: 'error' | 'warn';
  code: string;
  path: string;
  message: string;
}

export interface RecordsHashes {
  storage_schema_hash: string;
  declaration_hash: string;
  operation_digests: Record<string, string>;
}

const FRIENDLY_PATH_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
const PROTOTYPE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const normalizeEntityId = (value: string): string => {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[a-z]/.test(normalized) ? normalized : `entity_${normalized || 'unknown'}`;
};
/** Exported for the digest-coverage sweep: the copier's completeness is only
 *  derivable if the admissible-key list and the copier can be compared. */
export const RECORDS_BIND_KEYS: Record<RecordsAction, ReadonlySet<string>> = {
  create: new Set(['kind', 'action', 'entity', 'natural_key']),
  get: new Set(['kind', 'action', 'entity']),
  get_many: new Set(['kind', 'action', 'entity']),
  search: new Set(['kind', 'action', 'entity', 'filter_fields', 'sort_fields']),
  count: new Set(['kind', 'action', 'entity', 'filter_fields']),
  aggregate: new Set(['kind', 'action', 'entity', 'filter_fields', 'select', 'group_by']),
  batch: new Set(['kind', 'action', 'entity', 'allow']),
  // ⚠ NO `allow`, and that is not an omission. A batch needs one because the
  // CALLER supplies the entity/action pairs; an import supplies neither — it
  // writes `create`, to this bind's own entity, and nothing else. There is
  // nothing to declare, so declaring it would only create a second place the
  // grant could be widened.
  import: new Set(['kind', 'action', 'entity']),
  update: new Set(['kind', 'action', 'entity']),
  upsert: new Set(['kind', 'action', 'entity']),
  delete: new Set(['kind', 'action', 'entity']),
};

const RISK_RANK: Record<RiskTier, number> = {
  read: 0,
  write: 1,
  admin: 2,
  destructive: 3,
};

const RISK_FLOOR: Record<RecordsAction, RiskTier> = {
  create: 'write',
  get: 'read',
  get_many: 'read',
  search: 'read',
  count: 'read',
  aggregate: 'read',
  update: 'write',
  upsert: 'write',
  delete: 'destructive',
  // A constant, unlike `batch`: an import can only ever `create`, so its floor
  // is a create's floor no matter how large the file. ⚠ SIZE IS NOT RISK —
  // writing 1000 rows is a thousand times a write, not a different tier, and
  // promoting it to `destructive` would make it need an approval a delete
  // earns while telling an owner nothing true about what it does. What an
  // owner needs to weigh before a bulk import is the ONE GATE, which is the
  // op's authored `approval: 'ask'`, not an inflated risk.
  import: 'write',
  // ⚠ THE ONLY ENTRY THAT IS A FLOOR-OF-A-FLOOR. A batch is at least a write
  // (it admits no reads), but its real floor is the strictest action its
  // allow-list contains — a batch that may delete is destructive. Computed by
  // `batchRiskFloor` below; this constant is the fallback for a batch whose
  // allow-list cannot be read, and it is deliberately the LOWEST rather than
  // the highest so a malformed declaration cannot be waved through at a tier it
  // never earned. The allow-list validation refuses it first.
  batch: 'write',
};

/** D-226 — the strictest floor across a batch's declared pairs. A batch is a
 *  compound op and its authority is the union of what it may do, never the
 *  average or the first. */
const batchRiskFloor = (allow: unknown): RiskTier => {
  if (!Array.isArray(allow)) return RISK_FLOOR.batch;
  let floor: RiskTier = RISK_FLOOR.batch;
  for (const entry of allow) {
    const action = (entry as { action?: unknown } | null)?.action;
    if (typeof action !== 'string' || !(action in RISK_FLOOR)) continue;
    const candidate = RISK_FLOOR[action as RecordsAction];
    if (RISK_RANK[candidate] > RISK_RANK[floor]) floor = candidate;
  }
  return floor;
};

const ACTION_ARGS: Record<RecordsAction, readonly OperationArgSpec[]> = {
  create: [
    { key: 'id', type: 'string', required: false },
    { key: 'values', type: 'object', required: true },
  ],
  get: [{ key: 'id', type: 'string', required: true, affects_target: true }],
  get_many: [{ key: 'ids', type: 'array', required: true, affects_target: true }],
  search: [
    { key: 'filters', type: 'object', required: false },
    { key: 'sort', type: 'string', required: false },
    { key: 'cursor', type: 'string', required: false },
    { key: 'limit', type: 'number', required: false },
  ],
  count: [{ key: 'filters', type: 'object', required: false }],
  // D-226 — the rollup SHAPE is declared on the bind (`select`), so the caller
  // supplies only the filter. That split is the authority boundary: the caller
  // chooses the occasion and the rows, never what is computed over them.
  aggregate: [{ key: 'filters', type: 'object', required: false }],
  // D-226 — the caller supplies the ROWS; the bind's `allow` decides what kinds
  // of write may be among them. Same split as `aggregate`'s `select`.
  batch: [{ key: 'ops', type: 'array', required: true }],
  // The file's TEXT plus the owner's column mapping — never a target. There is
  // no entity or namespace arg by design: the binding comes from the pack,
  // exactly as every other Records op binds, and without that this would be a
  // primitive for writing arbitrary rows into any pack's store.
  //
  // ⚠ THE MAPPING IS CALLER-SUPPLIED AND THAT IS CORRECT, unlike `aggregate`'s
  // `select` or `batch`'s `allow`. Which column holds the amount is a per-BANK
  // fact the owner declares, not a per-pack one — on the bind it would need a
  // pack per bank. It grants nothing either: a `create` already takes its
  // `values` wholesale from the caller, and the mapping can only ever name
  // fields of the entity this bind already writes.
  // ⚠ `dry_run` is OPTIONAL and defaults to a real import, which is the right
  // default only because the import is already idempotent — a re-run of the
  // same file replays rather than doubles. If that ever stops being true, the
  // default becomes the wrong way round.
  // ⛔⛔ `csv` AND `csv_ref` ARE BOTH OPTIONAL HERE AND EXACTLY ONE IS REQUIRED
  // AT RUNTIME — this envelope cannot say "one of", and pretending otherwise
  // would be worse than the gap. Marking `csv` required again would refuse every
  // ref-taking call at authoring time; marking `csv_ref` required would refuse
  // every text call. The exactly-one-of check lives where both values are
  // actually present — `resolveRecordsImportCsvRef` (both ⇒ refuse, neither ⇒
  // the store's "import requires csv text").
  //
  // ⚠ So this declaration is WIDER than the runtime, which is the safe
  // direction: the runtime refuses what the declaration admits, never the
  // reverse. Do not "tighten" it back without giving the envelope a real
  // one-of primitive — a required flag here is a claim about every call.
  //
  // 🔑 `csv_ref` IS `'object'`, NOT `'file_ref'`, AND THE DISTINCTION IS LOAD-
  // BEARING. `file_ref` is the DURABLE `data.file` record reference — the arg
  // type behind `input_materialize` / `upload`, and the thing a Kitchen picker
  // offers from the owner's file inventory. This arg takes a run-scoped
  // `TempFileRef` and REFUSES a durable id, so declaring it `file_ref` would
  // advertise a picker whose every value the op rejects at dispatch.
  import: [
    { key: 'csv', type: 'string', required: false },
    { key: 'csv_ref', type: 'object', required: false },
    { key: 'spec', type: 'object', required: true },
    { key: 'dry_run', type: 'boolean', required: false },
  ],
  update: [
    { key: 'id', type: 'string', required: true, affects_target: true },
    { key: 'expected_version', type: 'number', required: true },
    { key: 'expected_revision', type: 'number', required: true },
    { key: 'set', type: 'object', required: false },
    { key: 'unset', type: 'array', required: false },
  ],
  upsert: [
    { key: 'id', type: 'string', required: true, affects_target: true },
    { key: 'expected_version', type: 'number', required: true },
    { key: 'expected_revision', type: 'number', required: false },
    { key: 'values', type: 'object', required: true },
  ],
  delete: [
    { key: 'id', type: 'string', required: true, affects_target: true },
    { key: 'expected_version', type: 'number', required: true },
    { key: 'expected_revision', type: 'number', required: true },
  ],
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const uniqueStrings = (value: unknown): value is string[] =>
  Array.isArray(value)
  && value.length > 0
  && value.every((entry) => typeof entry === 'string' && entry.length > 0)
  && new Set(value).size === value.length;

const issue = (
  issues: RecordsAuthoringIssue[],
  code: string,
  path: string,
  message: string,
): void => {
  issues.push({ severity: 'error', code, path, message });
};

export const isRecordsComposition = (body: unknown): boolean => {
  if (!isPlainObject(body)) return false;
  const ingredients = Array.isArray(body.ingredients) ? body.ingredients : [];
  const operations = Array.isArray(body.operations) ? body.operations : [];
  return ingredients.some((entry) => isPlainObject(entry) && entry.kind === 'storage')
    || operations.some((entry) =>
      isPlainObject(entry)
      && isPlainObject(entry.bind)
      && entry.bind.kind === 'core.records');
};

const validateArgEnvelope = (
  row: PackOperationRow,
  action: RecordsAction,
  bind: Record<string, unknown>,
  path: string,
  issues: RecordsAuthoringIssue[],
): void => {
  const expected = ACTION_ARGS[action];
  const actual = (row.args ?? []).map(normalizeOperationArg);
  const expectedByKey = new Map(expected.map((arg) => [arg.key, arg]));
  const actualByKey = new Map(actual.map((arg) => [arg.key, arg]));
  if (actualByKey.size !== actual.length) {
    issue(issues, 'records_arg_duplicate', `${path}.args`, 'Records operation args must be unique');
  }
  for (const [key, wanted] of expectedByKey) {
    const got = actualByKey.get(key);
    if (action === 'create' && key === 'id' && bind.natural_key !== undefined) {
      if (got !== undefined) {
        issue(issues, 'records_natural_key_id_arg', `${path}.args`, 'a natural_key create must not declare an id arg');
      }
      continue;
    }
    if (got === undefined) {
      issue(issues, 'records_arg_missing', `${path}.args`, `Records ${action} must declare '${key}'`);
      continue;
    }
    if (
      got.type !== wanted.type
      || Boolean(got.required) !== Boolean(wanted.required)
      || Boolean(got.affects_target) !== Boolean(wanted.affects_target)
    ) {
      issue(
        issues,
        'records_arg_mismatch',
        `${path}.args`,
        `Records ${action} arg '${key}' has the wrong type/required/affects_target contract`,
      );
    }
  }
  for (const key of actualByKey.keys()) {
    if (!expectedByKey.has(key) || (action === 'create' && key === 'id' && bind.natural_key !== undefined)) {
      issue(issues, 'records_arg_extra', `${path}.args`, `Records ${action} does not admit arg '${key}'`);
    }
  }
};

const fieldKind = (field: IngredientEntityField): 'id' | RecordsFieldKind | undefined =>
  field.field_path === 'pk' ? 'id' : recordsSlotKind(field.field_path);

const expectedMetaType = (kind: 'id' | RecordsFieldKind): MetaFieldType => {
  if (kind === 'number') return 'number';
  if (kind === 'boolean') return 'boolean';
  if (kind === 'date' || kind === 'datetime') return 'datetime';
  return 'string';
};

const validateEntityFields = (
  composition: CompositionIngredient,
  issues: RecordsAuthoringIssue[],
): void => {
  const ingredient = composition.ingredients[0];
  const operationsById = new Map(composition.operations.map((row) => [row.op, row]));
  const declaredEntities = new Set(
    Object.keys(ingredient?.entities ?? {}).map((kind) => normalizeEntityId(kind)),
  );
  for (const [rawKind, entity] of Object.entries(ingredient?.entities ?? {})) {
    const path = `ingredients[0].entities.${rawKind}`;
    if (rawKind !== normalizeEntityId(rawKind)) {
      issue(issues, 'records_entity_key_not_normalized', path, `Records entity '${rawKind}' must already be normalized`);
    }
    if (entity.crm_alias !== undefined || entity.acct_alias !== undefined || entity.engagement !== undefined) {
      issue(issues, 'records_external_entity_facet', path, 'Records entities cannot declare CRM, accounting, or engagement facets');
    }
    const slots = new Set<string>();
    const aliases = new Set<string>();
    let idCount = 0;
    for (const [idx, field] of entity.fields.entries()) {
      const fPath = `${path}.fields[${idx}]`;
      const kind = fieldKind(field);
      if (kind === undefined) {
        issue(issues, 'records_slot_unknown', `${fPath}.field_path`, `field_path '${field.field_path}' is not a Records slot`);
        continue;
      }
      if (slots.has(field.field_path)) {
        issue(issues, 'records_slot_duplicate', `${fPath}.field_path`, `slot '${field.field_path}' is duplicated`);
      }
      slots.add(field.field_path);
      const foldedAlias = field.maps_to.normalize('NFKC').toLowerCase();
      if (aliases.has(foldedAlias)) {
        issue(issues, 'records_alias_duplicate', `${fPath}.maps_to`, `friendly path '${field.maps_to}' collides after normalization`);
      }
      aliases.add(foldedAlias);
      const segments = field.maps_to.split('.');
      if (
        !FRIENDLY_PATH_RE.test(field.maps_to)
        || segments.some((segment) => PROTOTYPE_SEGMENTS.has(segment))
      ) {
        issue(issues, 'records_alias_invalid', `${fPath}.maps_to`, `friendly path '${field.maps_to}' is not safe`);
      }
      if (
        kind !== 'id'
        && (field.maps_to === 'id' || field.maps_to === '_record' || field.maps_to.startsWith('_record.'))
      ) {
        issue(issues, 'records_alias_reserved', `${fPath}.maps_to`, `friendly path '${field.maps_to}' is reserved`);
      }
      if (kind === 'id') {
        idCount += 1;
        if (field.maps_to !== 'id' || field.type !== 'string' || field.optional === true) {
          issue(issues, 'records_id_mapping', fPath, "the protected pk slot must map exactly to required string 'id'");
        }
      } else {
        if (field.type !== expectedMetaType(kind)) {
          issue(issues, 'records_slot_type_mismatch', `${fPath}.type`, `slot '${field.field_path}' requires type '${expectedMetaType(kind)}'`);
        }
        if (kind === 'date' && field.date_granularity !== 'date') {
          issue(issues, 'records_date_granularity', `${fPath}.date_granularity`, `slot '${field.field_path}' requires date granularity`);
        }
        if (kind === 'datetime' && field.date_granularity !== 'datetime') {
          issue(issues, 'records_date_granularity', `${fPath}.date_granularity`, `slot '${field.field_path}' requires datetime granularity`);
        }
        if (kind !== 'date' && kind !== 'datetime' && field.date_granularity !== undefined) {
          issue(issues, 'records_date_granularity', `${fPath}.date_granularity`, 'date_granularity is only valid on d*/dt* slots');
        }
      }
      // A `references` names the entity a reference points AT. Only a ref slot
      // can carry one, and it must name an entity this composition declares —
      // an unresolvable target would be worse than none, because a picker and
      // a prefix check would both trust it.
      if (field.references !== undefined) {
        if (kind !== 'ref') {
          issue(issues, 'records_references_not_ref', `${fPath}.references`,
            `references is only valid on a ref slot (r1..r5), not on '${field.field_path}'`);
        } else if (!declaredEntities.has(normalizeEntityId(field.references))) {
          issue(issues, 'records_references_unknown', `${fPath}.references`,
            `references '${field.references}' is not an entity this composition declares`);
        }
      }
      if (field.derivation !== undefined || (field.applies !== undefined && field.applies !== 'both')) {
        issue(issues, 'records_field_not_persisted', fPath, 'Records fields cannot be derived or request/response-only');
      }
      if (field.source !== undefined) {
        issue(issues, 'records_field_source_unsupported', `${fPath}.source`, 'Records fields do not admit vendor discovery source metadata');
      }
      if (field.source_operation !== undefined) {
        const source = operationsById.get(field.source_operation);
        const bind = source?.bind as Record<string, unknown> | undefined;
        if (
          source === undefined
          || bind?.kind !== 'core.records'
          || bind.entity !== rawKind
          || (bind.action !== 'get' && bind.action !== 'search')
        ) {
          issue(issues, 'records_source_operation', `${fPath}.source_operation`, 'source_operation must be a same-entity Records get/search operation');
        }
      }
    }
    if (idCount !== 1) {
      issue(issues, 'records_id_mapping_count', `${path}.fields`, 'a Records entity must declare exactly one pk -> id mapping');
    }
    const paths = entity.fields.map((field) => field.maps_to);
    for (const candidate of paths) {
      if (paths.some((other) => other !== candidate && other.startsWith(`${candidate}.`))) {
        issue(issues, 'records_alias_prefix_collision', path, `friendly path '${candidate}' is a prefix of another field`);
      }
    }
  }
};

export const validateRecordsComposition = (
  composition: CompositionIngredient,
): RecordsAuthoringIssue[] => {
  const issues: RecordsAuthoringIssue[] = [];
  if (composition.ingredients.length !== 1 || composition.ingredients[0]?.kind !== 'storage') {
    issue(issues, 'records_composition_shape', 'ingredients', 'a Records composition has exactly one storage ingredient');
    return issues;
  }
  const ingredient = composition.ingredients[0];
  if (ingredient.cli !== undefined || ingredient.http !== undefined || ingredient.connection !== undefined || ingredient.mcp !== undefined) {
    issue(issues, 'records_mixed_surface', 'ingredients[0]', 'a Records storage ingredient cannot carry another surface config');
  }
  const entities = ingredient.entities ?? {};
  if (Object.keys(entities).length === 0) {
    issue(issues, 'records_entities_empty', 'ingredients[0].entities', 'a Records composition must declare at least one entity');
  }

  const usedEntities = new Set<string>();
  for (const [idx, row] of composition.operations.entries()) {
    const path = `operations[${idx}]`;
    const bind = row.bind;
    if (!isPlainObject(bind) || bind.kind !== 'core.records') {
      issue(issues, 'records_mixed_surface', `${path}.bind`, 'every Records operation must use bind.kind core.records');
      continue;
    }
    if (!isRecordsAction(bind.action)) {
      issue(issues, 'records_action_unknown', `${path}.bind.action`, `Records action '${String(bind.action)}' is not admitted`);
      continue;
    }
    const action = bind.action;
    const allowedKeys = RECORDS_BIND_KEYS[action];
    for (const key of Object.keys(bind)) {
      if (!allowedKeys.has(key)) {
        issue(issues, 'records_bind_key_unknown', `${path}.bind.${key}`, `Records ${action} does not admit bind key '${key}'`);
      }
    }
    if (typeof bind.entity !== 'string' || entities[bind.entity] === undefined) {
      issue(issues, 'records_entity_unknown', `${path}.bind.entity`, 'Records bind entity must name a declared entity exactly');
      continue;
    }
    usedEntities.add(bind.entity);
    const fields = entities[bind.entity].fields;
    const fieldByAlias = new Map(fields.map((field) => [field.maps_to, field]));

    const checkFieldList = (key: 'filter_fields' | 'sort_fields'): void => {
      const value = bind[key];
      if (value === undefined) return;
      if (!uniqueStrings(value)) {
        issue(issues, 'records_bind_field_list', `${path}.bind.${key}`, `${key} must be a non-empty unique string array`);
        return;
      }
      for (const alias of value) {
        if (key === 'sort_fields' && (alias === '_record.created_at' || alias === '_record.updated_at')) continue;
        const field = fieldByAlias.get(alias);
        const kind = field === undefined ? undefined : fieldKind(field);
        if (field === undefined || kind === 'id') {
          issue(issues, 'records_bind_field_unknown', `${path}.bind.${key}`, `'${alias}' is not a declared writable field`);
          continue;
        }
        if (kind === 'text') {
          issue(issues, 'records_text_unindexed', `${path}.bind.${key}`, `unindexed text field '${alias}' cannot be admitted by a pack query`);
        }
        // A DOTTED alias is projectable (it nests in the read shape) but not
        // queryable: `filterList` keys the filter map on the literal friendly
        // name, and the kernel's own arg guard refuses any object key carrying a
        // `.` before dispatch ever reaches it — so `filters: {"identity.customer":
        // …}` cannot be expressed, and the nested form resolves to an
        // undeclared parent. Admitting one here ships an operation with a
        // declared query field no caller can use.
        if (alias.includes('.')) {
          issue(issues, 'records_dotted_query_field', `${path}.bind.${key}`, `dotted field '${alias}' cannot be admitted by a pack query — a dotted alias is readable but not filterable/sortable`);
        }
        if (key === 'sort_fields' && (kind === 'string' || kind === 'ref')) {
          issue(issues, 'records_sort_unordered', `${path}.bind.${key}`, `field '${alias}' is not in an ordered Records family`);
        }
      }
    };
    checkFieldList('filter_fields');
    checkFieldList('sort_fields');

    // D-226 — the declared rollup. Validated HERE, at install, against this
    // entity's real field kinds: that is the whole reason `select` lives on the
    // bind rather than arriving in caller args. The matrix itself is in
    // contracts so the op surface and the (later) declared-ref reverse read
    // cannot disagree about what is admissible.
    if (action === 'aggregate') {
      const kinds: Record<string, RecordsFieldKind> = {};
      for (const field of fields) {
        const kind = fieldKind(field);
        if (kind !== undefined && kind !== 'id') kinds[field.maps_to] = kind;
      }
      for (const problem of validateRecordsAggregateSelect(bind.select, kinds)) {
        issue(issues, 'records_aggregate_select', `${path}.bind.select`, problem);
      }
      // ⚠ OPTIONAL — its absence is the ungrouped op, which is the shape that
      // shipped first and must keep working untouched. Present, it changes what
      // the op RETURNS (one row -> one row per group), which is why it is on the
      // bind, hashed, and validated here rather than passed in args.
      if (bind.group_by !== undefined) {
        for (const problem of validateRecordsGroupBy(bind.group_by, kinds)) {
          issue(issues, 'records_aggregate_group_by', `${path}.bind.group_by`, problem);
        }
      }
    } else {
      if (bind.select !== undefined) {
        issue(issues, 'records_aggregate_select', `${path}.bind.select`, `Records ${action} does not admit a select`);
      }
      if (bind.group_by !== undefined) {
        issue(issues, 'records_aggregate_group_by', `${path}.bind.group_by`, `Records ${action} does not admit a group_by`);
      }
    }

    // D-226 — the batch allow-list, validated against the entities that exist,
    // for the same reason `select` is validated against field kinds: it decides
    // what the op can DO, so a pair naming a missing entity must fail at
    // install rather than at the first call that happens to use it.
    if (action === 'batch') {
      const entityNames = Object.keys(
        (ingredient.entities ?? {}) as Record<string, unknown>,
      ).map(normalizeEntityId);
      for (const problem of validateRecordsBatchAllow(bind.allow, entityNames)) {
        issue(issues, 'records_batch_allow', `${path}.bind.allow`, problem);
      }
    } else if (bind.allow !== undefined) {
      issue(issues, 'records_batch_allow', `${path}.bind.allow`, `Records ${action} does not admit an allow list`);
    }

    if (bind.natural_key !== undefined) {
      if (action !== 'create' || !uniqueStrings(bind.natural_key)) {
        issue(issues, 'records_natural_key_shape', `${path}.bind.natural_key`, 'natural_key is a non-empty unique array admitted only on create');
      } else {
        for (const alias of bind.natural_key) {
          const field = fieldByAlias.get(alias);
          if (field === undefined || fieldKind(field) === 'id' || field.optional === true) {
            issue(issues, 'records_natural_key_field', `${path}.bind.natural_key`, `natural_key field '${alias}' must be declared, writable, and required`);
          }
        }
      }
    }
    const floor = action === 'batch' ? batchRiskFloor(bind.allow) : RISK_FLOOR[action];
    if (RISK_RANK[row.risk] < RISK_RANK[floor]) {
      issue(issues, 'records_risk_floor', `${path}.risk`, `Records ${action} requires risk '${floor}' or stricter`);
    }
    validateArgEnvelope(row, action, bind, path, issues);
    for (const unsupported of [
      'required_scopes',
      'pagination',
      'result_path',
      'accepts_media',
      'produces_media',
      'operation_bound_webhook',
    ] as const) {
      if ((row as unknown as Record<string, unknown>)[unsupported] !== undefined) {
        issue(issues, 'records_operation_feature_unsupported', `${path}.${unsupported}`, `${unsupported} is not supported by Records v1`);
      }
    }
  }
  for (const entity of Object.keys(entities)) {
    if (!usedEntities.has(entity)) {
      issue(issues, 'records_entity_unused', `ingredients[0].entities.${entity}`, 'every Records entity must be used by at least one operation');
    }
  }

  // D-226 — declared reverse reads. Validated HERE, against this pack's real
  // schema, so a projection whose walk cannot resolve is refused at install
  // rather than returning null forever at read time. Runs after the entity loop
  // because a hop names a SIBLING entity and the whole set has to be known.
  const kindsFor = (entityKind: string): { fields: { key: string; kind: string }[] } => ({
    fields: (entities[entityKind]?.fields ?? []).map((field) => ({
      key: field.maps_to,
      kind: field.field_path === 'pk' ? 'id' : (fieldKind(field) ?? 'string'),
    })),
  });
  const schemaForProjections: Record<string, { fields: { key: string; kind: string }[] }> = {};
  for (const entityKind of Object.keys(entities)) schemaForProjections[entityKind] = kindsFor(entityKind);
  for (const [entityKind, entity] of Object.entries(entities)) {
    const roots = (entity as { roots?: unknown[] }).roots;
    if (roots === undefined) continue;
    const at = `ingredients[0].entities.${entityKind}.roots`;
    if (!Array.isArray(roots)) {
      issue(issues, 'records_root_projection', at, 'roots must be an array');
      continue;
    }
    for (const [index, projection] of roots.entries()) {
      for (const problem of validateRecordsRootProjection(
        projection, entityKind, schemaForProjections, `${at}[${index}]`,
      )) {
        issue(issues, 'records_root_projection', at, problem);
      }
    }
  }
  // D-221 §6.2 — `natural_key` is a property of the ENTITY, not of one bind.
  // It is admissible only on `create`, so a sibling bind on the same entity
  // that can seat a row at a caller-supplied id (a second unkeyed `create`, or
  // any `upsert`) would turn derived-id uniqueness back into a convention. The
  // cross-operation shape has to refuse at authoring; per-bind validation
  // cannot see it.
  const naturalKeyByEntity = new Map<string, { key: string; path: string }>();
  for (const [idx, row] of composition.operations.entries()) {
    const bind = row.bind as Record<string, unknown> | undefined;
    if (!isPlainObject(bind) || bind.action !== 'create' || bind.natural_key === undefined) continue;
    if (typeof bind.entity !== 'string' || !uniqueStrings(bind.natural_key)) continue;
    const key = JSON.stringify([...(bind.natural_key as string[])].sort());
    const prior = naturalKeyByEntity.get(bind.entity);
    if (prior === undefined) {
      naturalKeyByEntity.set(bind.entity, { key, path: `operations[${idx}]` });
    } else if (prior.key !== key) {
      issue(
        issues,
        'records_natural_key_conflict',
        `operations[${idx}].bind.natural_key`,
        `entity '${bind.entity}' already declares a different natural_key at ${prior.path}`,
      );
    }
  }
  for (const [idx, row] of composition.operations.entries()) {
    const bind = row.bind as Record<string, unknown> | undefined;
    if (!isPlainObject(bind) || typeof bind.entity !== 'string') continue;
    if (!naturalKeyByEntity.has(bind.entity)) continue;
    if (bind.action === 'upsert') {
      issue(
        issues,
        'records_natural_key_conflict',
        `operations[${idx}].bind.action`,
        `entity '${bind.entity}' declares a natural_key, so it cannot also expose upsert`,
      );
    }
    if (bind.action === 'create' && bind.natural_key === undefined) {
      issue(
        issues,
        'records_natural_key_conflict',
        `operations[${idx}].bind.natural_key`,
        `entity '${bind.entity}' declares a natural_key, so every create on it must declare the same one`,
      );
    }
  }
  if (composition.recipe_templates !== undefined) {
    issue(issues, 'records_recipe_templates_unsupported', 'recipe_templates', 'Records v1 uses separately bundled recipes, not composition recipe_templates');
  }
  validateEntityFields(composition, issues);
  return issues;
};

export const recordsSchemaSnapshot = (
  composition: CompositionIngredient,
): RecordsSchemaSnapshot => {
  const ingredient = composition.ingredients[0];
  const entities: Record<string, RecordsEntitySnapshot> = {};
  for (const [rawKind, entity] of Object.entries(ingredient?.entities ?? {})) {
    const kind = normalizeEntityId(rawKind);
    entities[kind] = {
      kind,
      // D-226 — carried verbatim onto the snapshot the store installs, which is
      // what `readRootProjections` reads at runtime. Validation happens in
      // `validateRecordsComposition`, not here.
      ...(entity.roots === undefined ? {} : { roots: entity.roots }),
      fields: entity.fields.map((field): RecordsFieldSnapshot => ({
        key: field.maps_to,
        slot: field.field_path as RecordsFieldSnapshot['slot'],
        kind: field.field_path === 'pk'
          ? 'id'
          : recordsSlotKind(field.field_path)!,
        required: field.optional !== true,
        ...(field.label !== undefined ? { label: field.label } : {}),
        ...(field.references !== undefined ? { references: field.references } : {}),
        ...(field.description !== undefined ? { description: field.description } : {}),
        ...(field.pii !== undefined ? { privacy: field.pii } : {}),
        ...(field.source_operation !== undefined ? { source_operation: field.source_operation } : {}),
      })),
    };
  }
  return { decimal_scale: RECORDS_DECIMAL_SCALE, entities };
};

const canonicalStorageProjection = (snapshot: RecordsSchemaSnapshot): unknown => ({
  decimal_scale: snapshot.decimal_scale,
  entities: Object.values(snapshot.entities)
    .sort((a, b) => a.kind.localeCompare(b.kind))
    .map((entity) => ({
      kind: entity.kind,
      fields: entity.fields
        .map(({ key, slot, kind, required }) => ({ key, slot, kind, required }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    })),
});

/** ⛔⛔ ENUMERATING COPIER — every bind key that changes what the op RETURNS
 *  must be listed here, or a pack can redefine a granted operation without its
 *  digest moving. D-226's `select` was missing: two aggregate ops computing
 *  entirely different numbers hashed identically, so the D-177 pattern that
 *  drift invalidates a grant naturally was blind to the one thing an aggregate
 *  op actually is. Adding a bind key? Add it here in the same commit.
 *
 *  `select` needs no sorting: `canonicalize` sorts object keys recursively,
 *  so the ordering of outputs and of each spec's keys is already immaterial —
 *  which is the property the list-valued keys have to be sorted by hand to get. */
export const canonicalBind = (bind: RecordsAuthorBinding): unknown => ({
  kind: bind.kind,
  action: bind.action,
  entity: bind.entity,
  ...(bind.natural_key ? { natural_key: [...bind.natural_key].sort() } : {}),
  ...(bind.filter_fields ? { filter_fields: [...bind.filter_fields].sort() } : {}),
  ...(bind.sort_fields ? { sort_fields: [...bind.sort_fields].sort() } : {}),
  ...(bind.select ? { select: bind.select } : {}),
  ...(bind.group_by ? { group_by: bind.group_by } : {}),
  ...(bind.allow ? { allow: bind.allow } : {}),
});

export const hashRecordsDeclaration = async (
  composition: CompositionIngredient,
): Promise<RecordsHashes> => {
  const schema = recordsSchemaSnapshot(composition);
  const operation_digests: Record<string, string> = {};
  for (const row of [...composition.operations].sort((a, b) => a.op.localeCompare(b.op))) {
    operation_digests[row.op] = await canonicalHash({
      ...row,
      bind: canonicalBind(row.bind as unknown as RecordsAuthorBinding),
    });
  }
  return {
    storage_schema_hash: await canonicalHash(canonicalStorageProjection(schema)),
    declaration_hash: await canonicalHash({
      schema,
      operations: [...composition.operations]
        .sort((a, b) => a.op.localeCompare(b.op))
        .map((row) => ({ ...row, bind: canonicalBind(row.bind as unknown as RecordsAuthorBinding) })),
    }),
    operation_digests,
  };
};

/** Build the local schema carrier consumed by the D-167 privacy resolver. */
export const recordsEntitySchemas = (
  composition: CompositionIngredient,
  publisher: string,
  packSlug: string,
  catalogSlug = composition.slug,
): EntitySchemaIngredientInput[] => {
  const ingredient = composition.ingredients[0];
  return Object.entries(ingredient?.entities ?? {}).map(([rawKind, entity]) => {
    const kind = normalizeEntityId(rawKind);
    const sourceOps = composition.operations.filter((operation) => {
      const bind = operation.bind as Record<string, unknown>;
      return bind.kind === 'core.records'
        && bind.entity === rawKind
        // Every ordinary action except count can return a business identifier
        // or a complete friendly row. Privacy coverage follows the kernel's
        // actual response shapes, not the author's one optional discovery hint.
        && bind.action !== 'count';
    });
    return {
      ingredient_id: catalogSlug,
      entity_id: kind,
      scope: `data.entity.${publisher}.${packSlug}.${kind}`,
      projection_mode: 'canonical_mirror',
      schema_mode: 'static',
      target_id: { fields: ['id'], template: `${kind}_{id}` },
      meta_fields: entity.fields.map((field) => ({
        key: field.maps_to,
        type: field.type,
        required: field.optional !== true,
        source_path: `record.${field.maps_to}`,
        ...(field.label !== undefined ? { label: field.label } : {}),
        ...(field.references !== undefined ? { references: field.references } : {}),
        ...(field.description !== undefined ? { description: field.description } : {}),
        ...(field.pii !== undefined ? { privacy: field.pii } : {}),
        ...(field.date_granularity !== undefined ? { date_granularity: field.date_granularity } : {}),
      })),
      source_operations: Object.fromEntries(sourceOps.map((operation) => [
        operation.op,
        { catalog: catalogSlug, operation: operation.op },
      ])),
    };
  });
};

/** Internal catalog/install identity. Public authoring keeps the pack slug;
 * persistence uses this verified full-ref-derived id so two publishers may
 * honestly ship the same public slug without sharing registry or inventory
 * keys. The digest also keeps untrusted publisher punctuation out of slugs. */
export const recordsCatalogSlug = async (
  owner: { publisher: string; pack_slug: string },
): Promise<string> => `records-${(await canonicalHash(owner)).slice(0, 32)}`;

/** Stamp the verified owner/version onto the otherwise ordinary catalog. */
export const stampRecordsCatalog = async (
  manifest: IngredientManifest,
  composition: CompositionIngredient,
  owner: { publisher: string; pack_slug: string },
  packVersion: number,
): Promise<{ manifest: IngredientManifest; hashes: RecordsHashes }> => {
  const hashes = await hashRecordsDeclaration(composition);
  const internalSlug = await recordsCatalogSlug(owner);
  const records = manifest.surfaces?.records;
  if (records === undefined) throw new Error('records_schema_carrier_missing');
  const operations = Object.fromEntries(Object.entries(manifest.operations ?? {}).map(([key, spec]) => [
    key,
    { ...spec, operation_id: `${owner.publisher}.${owner.pack_slug}.${key}` },
  ]));
  const executes = Object.fromEntries(Object.entries(records.executes).map(([key, bind]) => [
    key,
    {
      ...bind,
      // Canonicalise the key ORDER, matching `canonicalBind`'s view of it.
      // `canonicalBind` (and therefore the declaration hash and the
      // cross-operation authoring check) already sorts, so leaving the STAMPED
      // bind on its authored order made the two disagree: a sibling create
      // declaring the same components in a different order installed clean and
      // then refused at every dispatch. It also made the derived `pk` depend on
      // which bind the store happened to read first, so the same pack could
      // derive different ids across reinstalls.
      ...(bind.natural_key ? { natural_key: [...bind.natural_key].sort() } : {}),
      owner,
      pack_version: packVersion,
      storage_schema_hash: hashes.storage_schema_hash,
      declaration_hash: hashes.declaration_hash,
      operation_digest: hashes.operation_digests[key],
    },
  ]));
  return {
    hashes,
    manifest: {
      ...manifest,
      slug: internalSlug,
      version: packVersion,
      author: owner.publisher,
      operations,
      surfaces: { records: { ...records, executes } },
    },
  };
};

/** Useful for schema/index ratchets and tests. */
export const recordsSlots = (): readonly string[] =>
  Object.values(RECORDS_SLOT_FAMILIES).flat();

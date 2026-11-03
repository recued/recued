/** D-226 — the DECLARED REVERSE READ.
 *
 *  D-206 found that "the relationship IS the contract to form the query,
 *  looking up from either end", and then only ever specified the forward end.
 *  This is the reverse end: a pack entity declares how it reaches an identity
 *  root, and what it will answer when someone reads FROM that root.
 *
 *  Without a `select`, reading from a root yields ROWS — bounded, capped, and
 *  the shape that produces "Bob has 3 deals" when he has 240. With one it
 *  yields THE AGGREGATE: one row, exact, and impossible to truncate.
 *
 *  ⛔ Nothing here is stored. The projection is computed at read time from the
 *  pack's own rows, so there is no invalidation, no cascade, no staleness, and
 *  no registry to open — core never STORES pack data, it ASKS the pack in the
 *  pack's own declared terms.
 *
 *  ⛔ The OCCASION is fixed by the declaration: per query, per parent entity, in
 *  the binding. A caller cannot choose the moment, vary the `where`, or
 *  re-point the traversal. Authority lives in the declaration, not the call
 *  site — which is what makes this analyzable at install and safe to accept
 *  from a third party. */
import type { RecordsAggregateSelectMap } from './records-aggregate.js';
import { recordsAggregateSelectIssues, validateRecordsGroupBy } from './records-aggregate.js';
import type { RecordsContractIssue, RecordsFieldKind } from './records.js';

/** Closed list of identity roots a pack may orbit. `contact` is the one that
 *  exists; `data.deal` / a local task root are separate decisions of their own
 *  weight (D-226 non-goals), and adding one here is deliberately a contract
 *  change rather than an authoring convenience. */
export const RECORDS_ROOT_KINDS = ['contact'] as const;
export type RecordsRootKind = (typeof RECORDS_ROOT_KINDS)[number];

/** ⚠ A `ref` field snapshot does NOT carry its target entity, and reverse
 *  resolution has to know it STATICALLY — the walk starts at the root and comes
 *  down, so there is no ref value in hand to read a target off. Hence the hop
 *  names both. */
export interface RecordsRootHop {
  /** A `ref` field on the entity at this level. */
  field: string;
  /** The entity that ref targets. */
  entity: string;
}

/** ⛔ Bounds the walk. Every hop is a full search against an id set, so an
 *  unbounded chain is an unbounded query fan-out on a read nobody asked to be
 *  expensive. Two hops covers `entry → engagement → contact`; a pack needing
 *  more is describing a graph, not a projection. */
export const RECORDS_ROOT_MAX_HOPS = 2;

export interface RecordsRootProjection {
  root: RecordsRootKind;
  /** Hops from THIS entity up toward the key-bearing entity. Empty means the
   *  key field is on this entity itself. */
  via: RecordsRootHop[];
  /** Field on the FINAL entity of the walk holding the root's key. For
   *  `contact` that is a canonical email — D-226: `contact_id` is not
   *  dereferenceable from a recipe today, so packs root on the email. */
  key_field: string;
  /** Same filter shape the store already accepts: `{ field: value }` for
   *  equality, `{ field: { op, value } }` otherwise. Fixed by the declaration
   *  and never supplied by a caller. */
  where?: Record<string, unknown>;
  select: RecordsAggregateSelectMap;
  /** How the projection names itself in a root view. */
  label?: string;
  /** 2026-10-09 — one rollup PER VALUE of this field of the BASE entity, rather
   *  than one over every row. The first user is the invoice book's "Owes you",
   *  grouped by `currency`: a sum of balances across currencies means nothing.
   *  Same key kinds and the same cap as the aggregate op's `group_by`
   *  (`RECORDS_GROUP_BY_KINDS`, `RECORDS_MAX_GROUPS`).
   *
   *  ⚠ A server older than this refuses a pack that declares it — an unknown
   *  key here is refused at install — so a pack that uses it needs the release
   *  that brought it. */
  group_by?: string;
  /** 2026-10-09 — the key a recipe reads this projection under,
   *  `{{data.contact.<email>.rollups.<pack>.<name>.<output>}}`. A pack with one
   *  projection may leave it out, and its outputs sit straight under the pack
   *  (`rollups.<pack>.<output>`). A pack with more must name every one, each
   *  differently (`validateRecordsRootProjectionNames`): recipes read rollups by
   *  pack, so two unnamed answers from one pack could only be told apart by
   *  guessing. The first such pack is the invoice book ("Owes you", "Pays",
   *  "Buys", "Billed").
   *
   *  ⚠ Naming a pack's only projection moves its outputs one level down. A
   *  server older than this refuses the key, as it does `group_by`. */
  name?: string;
}

/** A projection's `name` is one segment of a recipe path. `error` and
 *  `publishers` are the keys of the marker a recipe reads when two publishers
 *  ship one pack slug, so a projection named either would read as that clash. */
export const RECORDS_ROOT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const RESERVED_ROOT_NAMES: readonly string[] = ['error', 'publishers'];

export type RecordsRootSchema = Readonly<Record<string, { fields: readonly { key: string; kind: string }[] }>>;

/** The same bounded declared route is used by canonical validation and source editing. */
export const recordsRootRoute = (via: unknown, entityKind: string, entities: RecordsRootSchema, path = 'roots[0]'):
  { entity?: string; issues: RecordsContractIssue[] } => {
  const refuse = (message: string, at: (string | number)[]) => ({ issues: [{ path: at, message }] });
  if (!Array.isArray(via)) return refuse(`${path}.via: must be an array (empty when the key is on this entity)`, ['via']);
  if (via.length > RECORDS_ROOT_MAX_HOPS) return refuse(`${path}.via: at most ${RECORDS_ROOT_MAX_HOPS} hops`, ['via']);
  let current = entityKind;
  for (const [index, rawHop] of via.entries()) {
    const at = `${path}.via[${index}]`, location = ['via', index];
    if (rawHop === null || typeof rawHop !== 'object' || Array.isArray(rawHop)) return refuse(`${at}: must be { field, entity }`, location);
    const hop = rawHop as Record<string, unknown>;
    const entity = Object.hasOwn(entities, current) ? entities[current] : undefined;
    if (!entity) return refuse(`${at}: unknown entity '${current}'`, location);
    const field = entity.fields.find(f => f.key === hop.field);
    if (!field) return refuse(`${at}.field: '${String(hop.field)}' is not a field of '${current}'`, [...location, 'field']);
    if (field.kind !== 'ref') return refuse(`${at}.field: '${String(hop.field)}' is ${field.kind}, and only a ref can be a hop`, [...location, 'field']);
    if (typeof hop.entity !== 'string' || !Object.hasOwn(entities, hop.entity)) return refuse(`${at}.entity: '${String(hop.entity)}' is not a declared entity`, [...location, 'entity']);
    current = hop.entity;
  }
  if (!Object.hasOwn(entities, current)) return refuse(`${path}: unknown base entity '${entityKind}'`, []);
  return { entity: current, issues: [] };
};

/** Compatibility API: messages and their order come from the structured validator. */
export const validateRecordsRootProjection = (projection: unknown, entityKind: string, entities: RecordsRootSchema, path = 'roots[0]'): string[] =>
  recordsRootProjectionIssues(projection, entityKind, entities, path).map(issue => issue.message);

export const recordsRootProjectionIssues = (projection: unknown, entityKind: string, entities: RecordsRootSchema, path = 'roots[0]'): RecordsContractIssue[] => {
  const problems: RecordsContractIssue[] = [];
  const add = (message: string, at: (string | number)[] = [], target?: 'key') => problems.push({path: at, message, ...(target ? {target} : {})});
  if (projection === null || typeof projection !== 'object' || Array.isArray(projection)) {
    return [{path: [], message: `${path}: must be an object`}];
  }
  const p = projection as Record<string, unknown>;
  for (const key of Object.keys(p)) if (!['root', 'via', 'key_field', 'where', 'select', 'label', 'group_by', 'name'].includes(key)) add(`${path}: unknown key '${key}'`, [key], 'key');
  if (!RECORDS_ROOT_KINDS.includes(p.root as RecordsRootKind)) add(`${path}.root: must be one of ${RECORDS_ROOT_KINDS.join(', ')}`, ['root']);
  if (p.name !== undefined && (typeof p.name !== 'string' || !RECORDS_ROOT_NAME_PATTERN.test(p.name) || RESERVED_ROOT_NAMES.includes(p.name))) {
    add(`${path}.name: must be lower-case letters, digits and _, start with a letter, be at most 40 characters, `
      + `and not be ${RESERVED_ROOT_NAMES.map(n => `'${n}'`).join(' or ')}`, ['name']);
  }
  const route = recordsRootRoute(p.via, entityKind, entities, path);
  if (route.entity === undefined) return [...problems, ...route.issues];
  const finalEntity = entities[route.entity]!;
  const keyField = finalEntity.fields.find(f => f.key === p.key_field);
  if (!keyField) add(`${path}.key_field: '${String(p.key_field)}' is not a field of '${route.entity}'`, ['key_field']);
  else if (keyField.kind !== 'string') add(`${path}.key_field: '${String(p.key_field)}' is ${keyField.kind}; a root key must be a string`, ['key_field']);
  // Rollups and fixed filters use the BASE rows, not the contact-key entity.
  const baseEntity = Object.hasOwn(entities, entityKind) ? entities[entityKind] : undefined;
  if (!baseEntity) add(`${path}: unknown base entity '${entityKind}'`);
  else {
    const kinds: Record<string, RecordsFieldKind> = Object.create(null);
    for (const field of baseEntity.fields) if (field.kind !== 'id') kinds[field.key] = field.kind as RecordsFieldKind;
    for (const finding of recordsAggregateSelectIssues(p.select, kinds)) problems.push({...finding, path: ['select', ...finding.path], message: `${path}.${finding.message}`});
    if (p.group_by !== undefined) for (const problem of validateRecordsGroupBy(p.group_by, kinds)) add(`${path}.${problem}`, ['group_by']);
    if (p.where !== undefined) {
      if (p.where === null || typeof p.where !== 'object' || Array.isArray(p.where)) add(`${path}.where: must be an object of field predicates`, ['where']);
      else for (const key of Object.keys(p.where as Record<string, unknown>)) if (!Object.hasOwn(kinds, key)) add(`${path}.where: unknown field '${key}'`, ['where', key], 'key');
    }
  }
  return problems;
};

/** A lone projection can stay unnamed. Multiple projections need unique names. */
export const validateRecordsRootProjectionNames = (projections: readonly {path: string; projection: unknown}[]): string[] =>
  recordsRootProjectionNameIssues(projections).map(issue => issue.message);

export const recordsRootProjectionNameIssues = (projections: readonly {path: string; projection: unknown}[]): (RecordsContractIssue & { index: number })[] => {
  if (projections.length < 2) return [];
  const problems: (RecordsContractIssue & { index: number })[] = [], seen = new Map<string, string>();
  for (const [index, {path, projection}] of projections.entries()) {
    if (projection === null || typeof projection !== 'object' || Array.isArray(projection)) continue;
    const name = (projection as Record<string, unknown>).name;
    if (name === undefined) {
      problems.push({index, path: ['name'], message: `${path}.name: required when a pack declares more than one projection, because recipes read each one by its name`});
      continue;
    }
    if (typeof name !== 'string') continue;
    const prior = seen.get(name);
    if (prior === undefined) seen.set(name, path);
    else problems.push({index, path: ['name'], message: `${path}.name: '${name}' already names ${prior}`});
  }
  return problems;
};

/** What a root read returns for ONE pack projection.
 *
 *  ⛔⛔ `complete` is not decoration. D-206's store nearly shipped a silent
 *  catastrophe twice by answering a capped enumeration as if it were the whole
 *  set — "Bob has 3 deals" when he has 240. A projection walks bounded id sets,
 *  so it CAN hit a wall; when it does it must say so rather than under-report a
 *  number the user will treat as fact. */
export interface RecordsRootProjectionResult {
  publisher: string;
  pack_slug: string;
  entity: string;
  root: RecordsRootKind;
  label?: string;
  /** The projection's `name`, when it declares one: where recipes read it. */
  name?: string;
  /** On a grouped projection (`group_by`), which field and this rollup's value
   *  of it — `null` for the rows where that field is empty. Each group is its
   *  own result, and `label` already names the group ("Owes you · GBP"). */
  group?: { by: string; key: unknown };
  value: Record<string, unknown>;
  complete: boolean;
  /** Set when `complete` is false — what was hit, in the user's terms. */
  incomplete_reason?: string;
}

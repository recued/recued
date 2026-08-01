/** D-226 — resolving a declared reverse read.
 *
 *  Given an identity root and its key ("this contact, at this email"), ask
 *  every installed pack that declared a projection onto that root what it has
 *  to say, and return one aggregate row per pack.
 *
 *  ⛔ This is O(PACKS), not O(ROWS). That is the point. "Everything about Bob"
 *  does not page 240 pack records through a capped door; it reads one rollup
 *  per pack. The uncapped-and-filtered door D-206 wants is still needed — for
 *  "LIST Bob's deals", which is a different question — but it is not needed
 *  here, and conflating the two is what produces a confident number over a
 *  truncated set.
 *
 *  ⛔ Nothing is stored. Nothing is cached. There is no invalidation because
 *  there is nothing to invalidate: every call reads the pack's live rows.
 *
 *  ⛔ Core never learns what the numbers MEAN. The pack's declaration carries
 *  the filter and the functions; this file is an evaluator that could not tell
 *  you what "billable" is. */
import {
  createRecordsAggregator,
  type RecordsFieldKind,
  type RecordsRootKind,
  type RecordsRootProjection,
  type RecordsRootProjectionResult,
  type RecordsPackRef,
  type RecordsSchemaSnapshot,
} from '@recued/contracts';

import type { RecordsStore } from './store.js';

/** Rows pulled per level of the walk before the projection declares itself
 *  incomplete. Deliberately explicit: a wall that is hit silently is the
 *  D-206 failure this whole design exists to avoid. */
export const ROOT_PROJECTION_MAX_ROWS_PER_LEVEL = 2_000;
/** Ids per `in` predicate. The store admits at most `RECORDS_MAX_PREDICATES`
 *  predicates, not values, but a colossal `IN (...)` is its own problem. */
export const ROOT_PROJECTION_MAX_IDS_PER_QUERY = 100;

interface Walked {
  rows: Record<string, unknown>[];
  complete: boolean;
  reason?: string;
}

/** Page one entity's rows under a filter, bounded and honest about the bound. */
const pageAll = (
  store: RecordsStore,
  owner: RecordsPackRef,
  entity: string,
  filters: Record<string, unknown>,
): Walked => {
  const rows: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = store.ownerSearch({ owner, entity, filters, limit: 200, cursor });
    rows.push(...(page.records as unknown as Record<string, unknown>[]));
    if (rows.length > ROOT_PROJECTION_MAX_ROWS_PER_LEVEL) {
      return {
        rows: rows.slice(0, ROOT_PROJECTION_MAX_ROWS_PER_LEVEL),
        complete: false,
        reason: `more than ${ROOT_PROJECTION_MAX_ROWS_PER_LEVEL} ${entity} rows reach this root`,
      };
    }
    if (page.next_cursor === undefined) return { rows, complete: true };
    cursor = page.next_cursor;
  }
};

/** Resolve ONE declared projection for one root key.
 *
 *  The walk runs ROOT-DOWN: find the key-bearing rows first, then come back
 *  along the declared hops narrowing by ref. That is why a hop must name its
 *  target entity — coming down, there is no ref value in hand to read one off. */
const resolveOne = (
  store: RecordsStore,
  owner: RecordsPackRef,
  schema: RecordsSchemaSnapshot,
  baseEntity: string,
  projection: RecordsRootProjection,
  rootKey: string,
): RecordsRootProjectionResult => {
  const chain = [baseEntity, ...projection.via.map(hop => hop.entity)];
  const finalEntity = chain[chain.length - 1]!;

  let complete = true;
  let reason: string | undefined;

  // ⛔ ZERO HOPS IS NOT A DEGENERATE WALK — it is its own case, and treating it
  // as one cost DOUBLE. When `via` is empty the final entity IS the base
  // entity, so a seed query here would fetch exactly the rows the branch below
  // fetches again (with the pack's `where` added), and the first result would
  // be discarded unread. Found by counting queries before building a bench:
  // every zero-hop projection — the commonest shape, and the one
  // `invoice-book` ships — was querying twice to answer once.
  if (projection.via.length === 0) {
    const filters: Record<string, unknown> = {
      [projection.key_field]: rootKey, ...(projection.where ?? {}),
    };
    const page = pageAll(store, owner, baseEntity, filters);
    return finish(schema, baseEntity, projection, owner, page.rows, page.complete, page.reason);
  }

  // 1. the key-bearing rows at the far end of the chain
  const seed = pageAll(store, owner, finalEntity, { [projection.key_field]: rootKey });
  if (!seed.complete) { complete = false; reason = seed.reason; }
  let ids = seed.rows.map(row => String(row.id));

  // 2. walk back down the hops, narrowing by ref at each level
  for (let level = projection.via.length - 1; level >= 0; level -= 1) {
    const hop = projection.via[level]!;
    const entityAtLevel = chain[level]!;
    if (ids.length === 0) break;
    if (ids.length > ROOT_PROJECTION_MAX_IDS_PER_QUERY) {
      complete = false;
      reason ??= `more than ${ROOT_PROJECTION_MAX_IDS_PER_QUERY} ${hop.entity} rows reach this root`;
      ids = ids.slice(0, ROOT_PROJECTION_MAX_IDS_PER_QUERY);
    }
    const refs = ids.map(id => `${hop.entity}/${id}`);
    // The pack's own `where` applies only at the BASE level, where its fields
    // live — an intermediate level has no business being filtered by it.
    const filters: Record<string, unknown> = { [hop.field]: { op: 'in', value: refs } };
    if (level === 0 && projection.where !== undefined) Object.assign(filters, projection.where);
    const page = pageAll(store, owner, entityAtLevel, filters);
    if (!page.complete) { complete = false; reason ??= page.reason; }
    ids = page.rows.map(row => String(row.id));
    if (level === 0) {
      return finish(schema, baseEntity, projection, owner, page.rows, complete, reason);
    }
  }

  // Nothing reached the base entity. Still a real answer — the empty-set
  // contract (0 for counts and sums, null for avg/min/max/latest) is exactly
  // what "you have done no work for this person" should read as.
  return finish(schema, baseEntity, projection, owner, [], complete, reason);
};

const finish = (
  schema: RecordsSchemaSnapshot,
  baseEntity: string,
  projection: RecordsRootProjection,
  owner: RecordsPackRef,
  rows: Record<string, unknown>[],
  complete: boolean,
  reason: string | undefined,
): RecordsRootProjectionResult => {
  const kinds: Record<string, RecordsFieldKind> = {};
  for (const field of schema.entities[baseEntity]?.fields ?? []) {
    if (field.kind !== 'id') kinds[field.key] = field.kind;
  }
  const acc = createRecordsAggregator(projection.select, kinds);
  for (const row of rows) acc.push(row);
  return {
    publisher: owner.publisher,
    pack_slug: owner.pack_slug,
    entity: baseEntity,
    root: projection.root,
    ...(projection.label === undefined ? {} : { label: projection.label }),
    value: acc.finish(),
    complete,
    ...(complete ? {} : { incomplete_reason: reason ?? 'the walk hit a bound' }),
  };
};

// ── batched: many identities at once ────────────────────────────────────────
/** Root keys per `IN (…)` predicate. ⚠ A DIFFERENT bound from
 *  `ROOT_PROJECTION_MAX_IDS_PER_QUERY` even though they currently share a value:
 *  that one bounds ids discovered mid-walk, this one bounds identities the
 *  CALLER asked about. Conflating them would tie a list view's page size to a
 *  walk's fan-out. */
export const ROOT_PROJECTION_MAX_KEYS_PER_QUERY = 100;

/** Page an entity's rows under a filter, handing each to `onRow` and RETAINING
 *  NOTHING. The solo path materializes because it has one small answer to
 *  build; a batch would hold `keys × rows` if it did the same, so peak
 *  retention here is one page plus the per-key accumulators. */
const streamAll = (
  store: RecordsStore,
  owner: RecordsPackRef,
  entity: string,
  filters: Record<string, unknown>,
  budget: number,
  onRow: (row: Record<string, unknown>) => void,
): { complete: boolean; reason?: string } => {
  let cursor: string | undefined;
  let scanned = 0;
  for (;;) {
    const page = store.ownerSearch({ owner, entity, filters, limit: 200, cursor });
    for (const row of page.records as unknown as Record<string, unknown>[]) {
      scanned += 1;
      if (scanned > budget) {
        return { complete: false, reason: `more than ${budget} ${entity} rows reach this batch` };
      }
      onRow(row);
    }
    if (page.next_cursor === undefined) return { complete: true };
    cursor = page.next_cursor;
  }
};

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

interface KeyState {
  rows: Record<string, unknown>[];
  complete: boolean;
  reason?: string;
}

/** Resolve ONE declared projection for MANY root keys.
 *
 *  ⛔ THE PER-KEY BOUND IS THE SOLO BOUND. Each key gets exactly the
 *  `ROOT_PROJECTION_MAX_ROWS_PER_LEVEL` it would get on its own, tracked per
 *  key as rows stream past — so a batched answer equals the solo answer, key
 *  for key, and one noisy contact cannot make ninety-nine others read
 *  "incomplete". A flat chunk-wide row bound would have been simpler and would
 *  have made the list disagree with the detail view for no reason the user
 *  could see.
 *
 *  ⚠ The chunk-wide budget above it exists only so one enormous key cannot make
 *  the scan unbounded. Hitting THAT does taint the chunk, because a page that
 *  was never read cannot be proven not to contain a key's rows. */
const resolveBatch = (
  store: RecordsStore,
  owner: RecordsPackRef,
  schema: RecordsSchemaSnapshot,
  baseEntity: string,
  projection: RecordsRootProjection,
  keys: readonly string[],
): Map<string, RecordsRootProjectionResult> => {
  const chainDown = [baseEntity, ...projection.via.map(hop => hop.entity)];
  const finalEntity = chainDown[chainDown.length - 1]!;
  const state = new Map<string, KeyState>(keys.map(k => [k, { rows: [], complete: true }]));

  /** Admit a row to its key's set, enforcing that key's own row budget. */
  const admit = (key: string | undefined, row: Record<string, unknown>) => {
    if (key === undefined) return;                 // a row we cannot attribute
    const st = state.get(key);
    if (st === undefined) return;
    if (st.rows.length >= ROOT_PROJECTION_MAX_ROWS_PER_LEVEL) {
      st.complete = false;
      st.reason ??= `more than ${ROOT_PROJECTION_MAX_ROWS_PER_LEVEL} ${baseEntity} rows reach this root`;
      return;
    }
    st.rows.push(row);
  };
  const taintAll = (reason: string) => {
    for (const st of state.values()) { st.complete = false; st.reason ??= reason; }
  };

  for (const keyChunk of chunk(keys, ROOT_PROJECTION_MAX_KEYS_PER_QUERY)) {
    const budget = keyChunk.length * ROOT_PROJECTION_MAX_ROWS_PER_LEVEL;

    if (projection.via.length === 0) {
      // The key is ON the row, so partitioning is a field read. Same
      // short-circuit as the solo path, and for the same reason.
      const filters: Record<string, unknown> = {
        [projection.key_field]: { op: 'in', value: keyChunk }, ...(projection.where ?? {}),
      };
      const outcome = streamAll(store, owner, baseEntity, filters, budget, (row) => {
        admit(String(row[projection.key_field] ?? ''), row);
      });
      if (!outcome.complete) taintAll(outcome.reason!);
      continue;
    }

    // 1. seed at the far end: these rows carry the key.
    let owning = new Map<string, string>();        // row id -> root key
    const seed = streamAll(
      store, owner, finalEntity, { [projection.key_field]: { op: 'in', value: keyChunk } },
      budget, (row) => { owning.set(String(row.id), String(row[projection.key_field] ?? '')); });
    if (!seed.complete) taintAll(seed.reason!);

    // 2. walk back down. ⛔ PROVENANCE RIDES ON THE REF FIELD: each row names
    // its parent, and a row has exactly one parent ref, so "which identity does
    // this row belong to" is a lookup and never ambiguous. That is the whole
    // reason a batch is possible at all rather than N walks.
    for (let level = projection.via.length - 1; level >= 0; level -= 1) {
      const hop = projection.via[level]!;
      const entityAtLevel = chainDown[level]!;
      if (owning.size === 0) break;
      const next = new Map<string, string>();
      const ids = [...owning.keys()];
      for (const idChunk of chunk(ids, ROOT_PROJECTION_MAX_IDS_PER_QUERY)) {
        const filters: Record<string, unknown> = {
          [hop.field]: { op: 'in', value: idChunk.map(id => `${hop.entity}/${id}`) },
        };
        if (level === 0 && projection.where !== undefined) Object.assign(filters, projection.where);
        const outcome = streamAll(store, owner, entityAtLevel, filters, budget, (row) => {
          const parent = String(row[hop.field] ?? '').split('/')[1] ?? '';
          const key = owning.get(parent);
          if (level === 0) admit(key, row);
          else if (key !== undefined) next.set(String(row.id), key);
        });
        if (!outcome.complete) taintAll(outcome.reason!);
      }
      owning = next;
    }
  }

  return new Map([...state].map(([key, st]) =>
    [key, finish(schema, baseEntity, projection, owner, st.rows, st.complete, st.reason)]));
};

/** Every installed pack's answer about MANY identities, in O(packs) queries
 *  rather than O(packs × identities).
 *
 *  ⛔ Every requested key gets an entry, including ones no pack has heard of —
 *  an absent key and a zero are different claims, and a list view that dropped
 *  the row would silently shorten itself.
 *
 *  ⚠ Callers with ONE identity should keep using `readRootProjections`: it is
 *  the same answer by a shorter path, and it is the one the detail view and the
 *  timeline already use. */
export const readRootProjectionsBatch = (
  store: RecordsStore,
  root: RecordsRootKind,
  rootKeys: readonly string[],
): Map<string, RecordsRootProjectionResult[]> => {
  const keys = [...new Set(rootKeys.map(k => k.trim().toLowerCase()).filter(k => k.length > 0))];
  const out = new Map<string, RecordsRootProjectionResult[]>(keys.map(k => [k, []]));
  if (keys.length === 0) return out;

  for (const namespace of store.listNamespaces()) {
    if (namespace.state.state !== 'ready') continue;
    const owner = namespace.owner;
    const schema = namespace.schema;
    for (const [entityKind, entity] of Object.entries(schema.entities)) {
      for (const projection of entity.roots ?? []) {
        if (projection.root !== root) continue;
        try {
          const byKey = resolveBatch(store, owner, schema, entityKind, projection, keys);
          for (const key of keys) out.get(key)!.push(byKey.get(key)!);
        } catch (error) {
          // Scoped to this pack, for every key — the same posture as the solo
          // path. One pack whose declaration no longer matches its schema must
          // not take down a whole list.
          const message = error instanceof Error ? error.message : 'projection failed';
          for (const key of keys) {
            out.get(key)!.push({
              publisher: owner.publisher, pack_slug: owner.pack_slug, entity: entityKind,
              root: projection.root,
              ...(projection.label === undefined ? {} : { label: projection.label }),
              value: {}, complete: false, incomplete_reason: message,
            });
          }
        }
      }
    }
  }
  for (const results of out.values()) {
    results.sort((a, b) =>
      a.publisher.localeCompare(b.publisher)
      || a.pack_slug.localeCompare(b.pack_slug)
      || a.entity.localeCompare(b.entity));
  }
  return out;
};

/** Every installed pack's answer about one identity.
 *
 *  ⚠ Ordering is by (publisher, pack_slug, entity) so a root view is stable
 *  between calls — an unordered fan-out would reshuffle a user's page on every
 *  refresh for no reason. */
export const readRootProjections = (
  store: RecordsStore,
  root: RecordsRootKind,
  rootKey: string,
): RecordsRootProjectionResult[] => {
  const key = rootKey.trim().toLowerCase();
  if (key.length === 0) return [];

  const results: RecordsRootProjectionResult[] = [];
  for (const namespace of store.listNamespaces()) {
    // An orphaned or not-ready namespace answers nothing rather than throwing:
    // one broken pack must not take down the whole root view.
    if (namespace.state.state !== 'ready') continue;
    const owner = namespace.owner;
    const schema = namespace.schema;
    for (const [entityKind, entity] of Object.entries(schema.entities)) {
      for (const projection of entity.roots ?? []) {
        if (projection.root !== root) continue;
        try {
          results.push(resolveOne(store, owner, schema, entityKind, projection, key));
        } catch (error) {
          // A pack whose declaration no longer matches its schema is a refusal
          // for THAT pack, reported as incomplete — never a silent zero, and
          // never a failure of the whole read.
          results.push({
            publisher: owner.publisher, pack_slug: owner.pack_slug, entity: entityKind,
            root: projection.root,
            ...(projection.label === undefined ? {} : { label: projection.label }),
            value: {}, complete: false,
            incomplete_reason: error instanceof Error ? error.message : 'projection failed',
          });
        }
      }
    }
  }
  return results.sort((a, b) =>
    a.publisher.localeCompare(b.publisher)
    || a.pack_slug.localeCompare(b.pack_slug)
    || a.entity.localeCompare(b.entity));
};

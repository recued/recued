/** An undeclared argument to a `core.records` operation does nothing — and every
 *  argument that DOES something is admitted by name.
 *
 *  ⛔⛔ WHY THIS FILE EXISTS RATHER THAN 347 DERIVED REQUEST SCHEMAS. The D-165
 *  dispatch gate is `closedRequestSchemaViolation(op.request_schema, args)`, and
 *  all 347 `core.records` operations in `community/packs/` declare no
 *  `request_schema` at all — so by the measure the egress arc runs on, they read
 *  as "ungated". The arc's remedy elsewhere was to derive a closed schema from
 *  `args[]`. Deriving here would have been WRONG TWICE:
 *
 *  1. ⛔ **There is no egress.** `core.records` is the owner's LOCAL store. The
 *     population that measurement covers is `rest` / `graphql` / `mcp` binds,
 *     where `buildApiDispatchInput` forwards EVERY caller key to a provider.
 *     Nothing here leaves the machine, and nothing reads an undeclared key: the
 *     store picks its arguments by name (`call.args.values`, `args.filters`,
 *     `args.sort`, `args.limit`, …).
 *  2. ⛔ **The real gate is stronger than a schema could be, and it is already
 *     here.** A derived schema closes a KEY SET. The store closes the VALUES,
 *     against the entity's own field declaration and the BIND's `filter_fields` /
 *     `sort_fields` — bounds `args[].type` cannot express. Parking a weaker
 *     duplicate next to it is how a later reader takes the duplicate for the gate.
 *
 *  ⇒ So the decision is "already gated, elsewhere and better" — NOT "deferred".
 *  That makes these properties load-bearing, and until this file they were
 *  unpinned: `assertJsonTree` had no test in this directory at all, and nothing
 *  stated that an undeclared argument is inert. Both are exactly what a change
 *  that started forwarding args wholesale would break, silently.
 *
 *  ⚠ THE PREVIOUS REASON FOR SKIPPING THESE OPS WAS FALSE, which is the other
 *  half of why this is written down. `closed-schema-shape.mjs` claimed routing
 *  (`routePlatformRecordOperationArgs` / `routeQualifiedWorkEntityOperationArgs`)
 *  rewrote args before the gate, so a derived schema would judge keys "routing
 *  may have added". Neither router ever adds or drops a key — each returns
 *  `{ ...args, [id_arg]: <unwrapped> }` — and **0 of 347** records operations
 *  declare the `record_id_arg` / work-entity declaration that makes either run.
 *  A cited mechanism that is a no-op invites the widening it was meant to stop. */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  RecordsExecutionBinding, RecordsPackRef, RecordsSchemaSnapshot,
} from '@recued/contracts';

import { createRecordsStore, type RecordsStore } from '../store.js';

const OWNER: RecordsPackRef = { publisher: 'recued-core', pack_slug: 'inert' };
const SH = 'a'.repeat(64), DH = 'b'.repeat(64);

const bind = (
  action: string, entity: string, extra: Partial<RecordsExecutionBinding> = {}, tag = '',
): RecordsExecutionBinding => ({
  kind: 'core.records', action: action as never, entity, owner: OWNER, pack_version: 1,
  storage_schema_hash: SH, declaration_hash: DH,
  operation_digest: `d:${action}:${entity}${tag}`, ...extra,
});

const schema: RecordsSchemaSnapshot = {
  decimal_scale: 4,
  entities: {
    note: { kind: 'note', fields: [
      { key: 'id', slot: 'pk', kind: 'id', required: true },
      { key: 'title', slot: 's1', kind: 'string', required: true },
      // Declared on the entity but ABSENT from `filter_fields` / `sort_fields`
      // below — the gap the bind exists to express.
      { key: 'secret', slot: 's2', kind: 'string', required: false },
    ] },
  },
};

/** ⚠ One binding per action, because the entry gate's whole value is that it is
 *  UNCONDITIONAL — asserted on one action it would still pass after someone
 *  moved the call inside a single `case`. */
const B: Record<string, RecordsExecutionBinding> = {
  create: bind('create', 'note'),
  get: bind('get', 'note', {}, ':g'),
  get_many: bind('get_many', 'note', {}, ':gm'),
  search: bind('search', 'note', { filter_fields: ['title'], sort_fields: ['title'] }, ':s'),
  count: bind('count', 'note', { filter_fields: ['title'] }, ':c'),
  update: bind('update', 'note', {}, ':u'),
  delete: bind('delete', 'note', {}, ':d'),
  upsert: bind('upsert', 'note', { natural_key: ['title'] }, ':up'),
  aggregate: bind('aggregate', 'note', { select: { n: { fn: 'count' } } }, ':ag'),
  batch: bind('batch', 'note', { allow: [{ entity: 'note', action: 'create' }] }, ':b'),
  import: bind('import', 'note', {}, ':i'),
};

describe('core.records: undeclared args are inert, declared surfaces are admitted', () => {
  let db: Database.Database;
  let store: RecordsStore;
  const run = (b: RecordsExecutionBinding, args: Record<string, unknown>): unknown =>
    store.execute({ binding: b, principal: 'owner', args });
  const rows = (): unknown[] => db.prepare(
    'SELECT kind, pk, s1, s2, version, revision FROM core_records ORDER BY pk',
  ).all();

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    store = createRecordsStore(db, { now: (() => { let t = 1e12; return () => t += 1; })() });
    store.installNamespace({
      owner: OWNER, version: 1, storage_schema_hash: SH, declaration_hash: DH,
      artifact_digest: 'x', schema, bindings: B,
    });
  });
  afterEach(() => db.close());

  describe('⛔⛔ an undeclared top-level argument changes nothing', () => {
    it('leaves the persisted row and the returned record byte-identical', () => {
      // ⛔ THE CONTROL IS THE POINT. "It did not throw" would also be true of a
      // store that silently PERSISTED the extra key, so the assertion is
      // equality against the same call without it.
      run(B.create, { id: 'plain', values: { title: 't' } });
      const control = JSON.stringify(rows());
      const returned = run(B.create, {
        id: 'extra', values: { title: 't' },
        evil: 'DROP TABLE core_records', nested: { a: [1, 2] }, n: 7,
      });

      const persisted = rows() as Record<string, unknown>[];
      expect(persisted).toHaveLength(2);
      // Same shape as the control row, differing only in the id we chose.
      expect(JSON.stringify(persisted.filter((row) => row.pk === 'extra')))
        .toBe(control.replace(/"plain"/, '"extra"'));
      // …and it is not echoed back either, which is the other way an ignored
      // argument can still reach somewhere it matters.
      expect(JSON.stringify(returned)).not.toContain('DROP TABLE');
      expect(JSON.stringify(returned)).not.toContain('evil');
    });

    it('does not widen a read either', () => {
      run(B.create, { id: 'n1', values: { title: 'keep', secret: 'classified' } });
      const control = run(B.search, { filters: { title: 'keep' } });
      const withExtra = run(B.search, {
        filters: { title: 'keep' }, injected: { secret: { op: 'eq', value: 'classified' } },
      });
      expect(JSON.stringify(withExtra)).toBe(JSON.stringify(control));
    });
  });

  describe('⛔ the entry gate runs before the action switch, for every action', () => {
    // `store.ts` calls `assertJsonTree(call.args, '$.args')` ahead of
    // `assertExecutionAdmitted` and the switch, so a hostile key is refused
    // whatever else the args say — no per-action valid payload is needed here.
    const HOSTILE: [string, Record<string, unknown>][] = [
      ['a dotted key', { 'query.x': 1 }],
      ['constructor', { constructor: 1 }],
      ['prototype', { prototype: 1 }],
      ['a non-finite number', { n: Number.POSITIVE_INFINITY }],
      ['a symbol key', { [Symbol('s')]: 1 } as Record<string, unknown>],
      ['an accessor', Object.defineProperty({}, 'a', { get: () => 1, enumerable: true })],
    ];

    it.each(Object.keys(B))('refuses every hostile arg shape on %s', (action) => {
      for (const [label, args] of HOSTILE) {
        expect(() => run(B[action]!, args), `${action} admitted ${label}`)
          .toThrow(/not a safe own-property key|non-finite number|symbol key|is an accessor/);
      }
    });

    it('⛔ POSITIVE CONTROL — a benign extra key reaches the action', () => {
      // Without this, a store that threw on EVERY extra key would pass the sweep
      // above while contradicting the inertness this file is really about.
      expect(() => run(B.create, { id: 'ok', values: { title: 't' }, benign: 1 })).not.toThrow();
    });

    it('⛔ refuses a dotted key nested inside a value, not just at the root', () => {
      expect(() => run(B.create, { id: 'x', values: { 'a.b': 1 } }))
        .toThrow(/not a safe own-property key/);
    });
  });

  describe('🔑 the arguments that DO reach the store are admitted by name', () => {
    // These are the bounds a derived `request_schema` could not have expressed:
    // each is checked against the ENTITY schema or the BIND, not against a type.
    it('refuses a field the entity does not declare', () => {
      expect(() => run(B.create, { id: 'n', values: { title: 't', nope: 'x' } }))
        .toThrow(/unknown friendly field 'nope'/);
    });

    it('refuses a filter on a field the bind does not admit', () => {
      run(B.create, { id: 'n1', values: { title: 't', secret: 'classified' } });
      expect(() => run(B.search, { filters: { secret: 'classified' } }))
        .toThrow(/filter field 'secret' is not admitted/);
    });

    it('refuses a sort the bind does not admit, and an out-of-range limit', () => {
      expect(() => run(B.search, { sort: 'secret' })).toThrow(/sort 'secret' is not admitted/);
      for (const limit of [0, -1, 999_999, 1.5]) {
        expect(() => run(B.search, { limit }), `limit ${limit} admitted`)
          .toThrow(/limit must be an integer/);
      }
    });

    it('protects the identity columns from a values payload', () => {
      for (const values of [{ title: 't', id: 'forged' }, { title: 't', _record: {} }]) {
        expect(() => run(B.create, { id: 'n', values })).toThrow(/id and _record are protected/);
      }
    });
  });
});

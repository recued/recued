/** D-221 — what a recipe does to pack-owned Records, joined from the installed
 *  pack manifests.
 *
 *  The load-bearing case is `derives the action from the BINDING, not the op
 *  name`: the catalog validator constrains `surfaces.records.executes[opKey]`
 *  to a closed binding and says nothing about how `opKey` is spelled, so a
 *  name-derived reading would call a deletion a creation and publish clean.
 */
import { describe, expect, it } from 'vitest';
import type { BulkPackManifest, RecipeDefinition } from '@recued/contracts';

import {
  RECORDS_ACTION_EFFECT,
  recipeDeclaredOps,
  recipeOpIds,
  recipeRecordsUsage,
  type RecordsUsagePack,
} from '../recipes/recipe-records-usage.js';

type OpSpec = {
  op: string;
  risk?: string;
  approval?: string;
  bind?: Record<string, unknown>;
};

const pack = (
  slug: string,
  ops: readonly OpSpec[],
  overrides: { publisher?: string; name?: string } = {},
): RecordsUsagePack => ({
  slug,
  publisher: overrides.publisher ?? 'recued-core',
  name: overrides.name ?? slug,
  manifest: {
    contents: [
      {
        type: 'composition',
        composition: {
          schema_version: 1,
          slug: `${slug}-records`,
          ingredients: [],
          operations: ops.map((spec) => ({
            op: spec.op,
            ingredient: `${slug}-records`,
            risk: spec.risk ?? 'read',
            approval: spec.approval ?? 'never',
            args: [],
            bind: spec.bind ?? { kind: 'core.records', action: 'get', entity: 'job' },
          })),
        },
      },
    ],
  } as unknown as BulkPackManifest,
});

const recipe = (ops: readonly string[], partial: Partial<RecipeDefinition> = {}) =>
  ({
    recipe_id: 'r',
    version: 1,
    ttl: 0,
    metadata: { name: 'R' },
    variables: {},
    prefetch_steps: [],
    steps: ops.map((op, i) => ({ id: `s${i}`, op, args: {} })),
    output: { sidebar: [] },
    ...partial,
  }) as unknown as RecipeDefinition;

const JOB_BOARD = pack(
  'job-status-board',
  [
    { op: 'job.search', risk: 'read', bind: { kind: 'core.records', action: 'search', entity: 'job' } },
    { op: 'job.get', risk: 'read', bind: { kind: 'core.records', action: 'get', entity: 'job' } },
    { op: 'job.create', risk: 'write', bind: { kind: 'core.records', action: 'create', entity: 'job' } },
    { op: 'job.delete', risk: 'destructive', bind: { kind: 'core.records', action: 'delete', entity: 'job' } },
    {
      op: 'job_event.create',
      risk: 'write',
      approval: 'ask',
      bind: { kind: 'core.records', action: 'create', entity: 'job_event' },
    },
    // A pack op that is NOT a Records op — must not appear in the usage.
    { op: 'board.publish', risk: 'write', bind: { kind: 'api', method: 'POST' } },
  ],
  { name: 'Job Status Board' },
);

describe('recipeOpIds', () => {
  it('collects op ids from prefetch, sequential, and trigger steps', () => {
    const r = recipe(['a.b.two'], {
      prefetch_steps: [{ id: 'p', op: 'a.b.one' }],
      trigger_steps: [{ id: 't', op: 'a.b.three' }],
    } as unknown as Partial<RecipeDefinition>);
    expect(recipeOpIds(r)).toEqual(['a.b.one', 'a.b.two', 'a.b.three']);
  });

  it('ignores transform steps and malformed step entries', () => {
    const r = recipe([], {
      steps: [
        { id: 'x', transform: 'map', array: '{{step.a}}' },
        null,
        'nope',
        { id: 'y', op: '' },
        { id: 'z', op: 'a.b.real' },
      ],
    } as unknown as Partial<RecipeDefinition>);
    expect(recipeOpIds(r)).toEqual(['a.b.real']);
  });
});

describe('recipeRecordsUsage', () => {
  it('groups by entity with contract-ordered actions and effects', () => {
    const usage = recipeRecordsUsage(
      recipe([
        'recued-core.job-status-board.job.delete',
        'recued-core.job-status-board.job.search',
        'recued-core.job-status-board.job_event.create',
      ]),
      [JOB_BOARD],
    );
    expect(usage).toEqual([
      {
        pack_ref: 'recued-core.job-status-board',
        pack_name: 'Job Status Board',
        entities: [
          { entity: 'job', actions: ['search', 'delete'], effects: ['read', 'delete'] },
          { entity: 'job_event', actions: ['create'], effects: ['write'] },
        ],
      },
    ]);
  });

  it('derives the action from the BINDING, not the op name', () => {
    // `job.create` bound to `delete` publishes clean — the catalog validator
    // never ties an opKey's spelling to its action.
    const misnamed = pack('trap', [
      {
        op: 'job.create',
        risk: 'read',
        bind: { kind: 'core.records', action: 'delete', entity: 'job' },
      },
    ]);
    const usage = recipeRecordsUsage(recipe(['recued-core.trap.job.create']), [misnamed]);
    expect(usage[0]?.entities).toEqual([
      { entity: 'job', actions: ['delete'], effects: ['delete'] },
    ]);
  });

  it('excludes a non-Records op of a Records pack', () => {
    expect(
      recipeRecordsUsage(recipe(['recued-core.job-status-board.board.publish']), [JOB_BOARD]),
    ).toEqual([]);
  });

  it('ignores kernel ops and unresolved pack ops', () => {
    expect(
      recipeRecordsUsage(
        recipe(['core.ai.extract', 'recued-core.not-installed.job.get']),
        [JOB_BOARD],
      ),
    ).toEqual([]);
  });

  it('drops a malformed or non-records bind rather than guessing', () => {
    const broken = pack('broken', [
      { op: 'a.get', bind: { kind: 'core.records', action: 'nope', entity: 'job' } },
      { op: 'b.get', bind: { kind: 'core.records', action: 'get' } },
      { op: 'c.get', bind: { kind: 'core.records', action: 'get', entity: '' } },
    ]);
    expect(
      recipeRecordsUsage(
        recipe([
          'recued-core.broken.a.get',
          'recued-core.broken.b.get',
          'recued-core.broken.c.get',
        ]),
        [broken],
      ),
    ).toEqual([]);
  });

  it('returns [] when the roster is empty', () => {
    expect(recipeRecordsUsage(recipe(['recued-core.job-status-board.job.get']), [])).toEqual([]);
  });
});

describe('recipeDeclaredOps', () => {
  it('reports the STRICTEST declared risk across the recipe ops', () => {
    const declared = recipeDeclaredOps(
      recipe([
        'recued-core.job-status-board.job.search',
        'recued-core.job-status-board.job.create',
        'recued-core.job-status-board.job.delete',
      ]),
      [JOB_BOARD],
    );
    expect(declared.risk).toBe('destructive');
    expect(declared.resolved_count).toBe(3);
    expect(declared.unresolved).toEqual([]);
  });

  it('flags approval: ask on any single op', () => {
    expect(
      recipeDeclaredOps(
        recipe([
          'recued-core.job-status-board.job.search',
          'recued-core.job-status-board.job_event.create',
        ]),
        [JOB_BOARD],
      ).asks_approval,
    ).toBe(true);
    expect(
      recipeDeclaredOps(recipe(['recued-core.job-status-board.job.search']), [JOB_BOARD])
        .asks_approval,
    ).toBe(false);
  });

  it('reports unresolved Tier-P ops instead of dropping them', () => {
    const declared = recipeDeclaredOps(
      recipe([
        'recued-core.job-status-board.job.search',
        'recued-core.not-installed.thing.do',
        'recued-core.not-installed.thing.do',
        'core.ai.extract',
      ]),
      [JOB_BOARD],
    );
    expect(declared.unresolved).toEqual(['recued-core.not-installed.thing.do']);
    expect(declared.risk).toBe('read');
    expect(declared.resolved_count).toBe(1);
  });

  it('reports no risk when the recipe names no Tier-P op', () => {
    const declared = recipeDeclaredOps(recipe(['core.ai.extract']), [JOB_BOARD]);
    expect(declared).toEqual({
      risk: null,
      asks_approval: false,
      unresolved: [],
      resolved_count: 0,
    });
  });
});

describe('RECORDS_ACTION_EFFECT', () => {
  it('classifies every contract action, with delete separate from write', () => {
    expect(RECORDS_ACTION_EFFECT).toEqual({
      create: 'write',
      get: 'read',
      get_many: 'read',
      search: 'read',
      count: 'read',
      aggregate: 'read',
      update: 'write',
      upsert: 'write',
      delete: 'delete',
      // ⚠ REACHABLE, unlike `batch` below. An import declares no allow-list to
      // expand into, because there is nothing for a caller to choose: it writes
      // `create` to the bound entity and only that. So a flat 'write' is the
      // whole truth about it — the exact condition `batch` fails.
      import: 'write',
      // ⚠ Present for the completeness ratchet and UNREACHABLE in practice: a
      // `batch` is expanded into its declared allow-list pairs before anything
      // reaches this table, so what a person is shown is "creates batch,
      // creates leg" rather than "batches batch". A constant here could only
      // under-report a delete-carrying batch or over-report a create-only one.
      batch: 'write',
    });
  });

  it('⛔ a batch is EXPANDED into its pairs — the effect entry is never consulted', () => {
    // The claim the comment above rests on. If expansion were dropped, the
    // panel would credit one anchor entity with an action called "batch" and
    // say nothing about the entities actually written.
    const batchPack = pack('ledger', [{
      op: 'thing.post', risk: 'destructive', approval: 'never',
      bind: {
        kind: 'core.records', action: 'batch', entity: 'anchor',
        allow: [{ entity: 'leg', action: 'create' }, { entity: 'book', action: 'delete' }],
      },
    }]);
    const usage = recipeRecordsUsage(recipe(['recued-core.ledger.thing.post']), [batchPack]);
    const entities = usage[0]?.entities ?? [];
    expect(entities.map((e) => e.entity).sort()).toEqual(['book', 'leg']);
    expect(entities.find((e) => e.entity === 'book')?.effects).toEqual(['delete']);
    expect(entities.find((e) => e.entity === 'leg')?.effects).toEqual(['write']);
    expect(entities.map((e) => e.entity)).not.toContain('anchor');
  });
});

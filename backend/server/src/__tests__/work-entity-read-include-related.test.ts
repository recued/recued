/** `work.read`'s `include_related` — the D-192 P5 edge set, surfaced on demand.
 *
 *  The flag is a PARAMETER rather than a verb because edges are rows of the
 *  same `work-entity` collection as their owner, so they ride the two fences
 *  `work.read` already enforces. These tests hold that line from both ends:
 *  the flag must not manufacture access when the fences refuse, and it must
 *  never report "no relationships" for a read that could not read them. */

import type { ChatDispatchContext, ChatDispatchResult } from '@recued/contracts';
import { RECUED_BUILTIN_SOURCE_ID } from '@recued/contracts';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createWorkEntityEdgeStore,
  ensureWorkEntityEdgeSchema,
  type WorkEntityEdgeStore,
} from '../storage/work-entity-edge-store.js';
import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import {
  createWorkEntitySourceSyncStateStore,
  ensureWorkEntitySourceSyncStateSchema,
  type WorkEntitySourceSyncStateStore,
} from '../storage/work-entity-source-mirror.js';
import {
  runWorkEntityReadTool,
  type WorkEntityReadToolsDeps,
  type WorkEntityRelatedItem,
} from '../work-entity-read-tools.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';

const NOW = 1_700_000_000_000;
const SOURCE = RECUED_BUILTIN_SOURCE_ID('task');
const TASK_ID = 'task_alpha';

let db: Database.Database;
let store: WorkEntityStore;
let syncState: WorkEntitySourceSyncStateStore;
let edges: WorkEntityEdgeStore;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  ensureWorkEntitySchema(db);
  ensureWorkEntitySourceSyncStateSchema(db);
  ensureWorkEntityEdgeSchema(db);
  store = createWorkEntityStore(db);
  syncState = createWorkEntitySourceSyncStateStore(db);
  edges = createWorkEntityEdgeStore(db);
  store.registerSource({
    id: SOURCE,
    top_tier_kind: 'task',
    source_kind: 'builtin',
    source_label: SOURCE,
    write_capable: true,
    registered_at: NOW,
  });
  store.writeTask(
    {
      id: TASK_ID,
      source_id: SOURCE,
      title: 'Ship the renewal brief',
      done: false,
      state: 'LOCAL_OPEN',
      created_at: NOW,
      updated_at: NOW,
    },
    NOW,
  );
});

afterEach(() => {
  db.close();
});

const ctx: ChatDispatchContext = {
  execution_source: {
    channel: 'user',
    actor: 'user_self',
    user_id: 'owner',
    client_token_id: 'test',
  },
} as ChatDispatchContext;

const deps = (over: Partial<WorkEntityReadToolsDeps> = {}): WorkEntityReadToolsDeps => ({
  isCollectionReadGranted: () => true,
  isVerbOpGranted: () => true,
  getResolver: () => createWorkEntityResolver(store, { syncState, now: () => NOW }),
  getTargetedReadDeps: () => undefined,
  getEdgeStore: () => edges,
  now: () => NOW,
  ...over,
});

const ok = (r: ChatDispatchResult): Record<string, unknown> => {
  if (!r.ok) throw new Error(`expected ok dispatch, got ${r.reason}`);
  return r.result as Record<string, unknown>;
};

/** One resolved edge (parent project) + one unresolved (a sibling task whose
 *  target has not synced yet — D-192's admissible UNRESOLVED edge). */
const seedEdges = (): void => {
  edges.reconcileRecordEdges(
    {
      source_id: SOURCE,
      source_record_id: TASK_ID,
      owner_kind: 'task',
      owner_local_id: TASK_ID,
      desired: [
        {
          local_field: 'project',
          target_kind: 'project',
          target_scoped_key: 'project:proj_1',
          target_local_id: 'proj_1',
        },
        {
          local_field: 'blocked_by',
          target_kind: 'task',
          target_scoped_key: 'task:remote_77',
          target_remote_entity: 'issue',
          target_remote_id: 'remote_77',
        },
      ],
    },
    NOW,
  );
};

describe('work.read include_related', () => {
  it('omits related entirely when the flag is not set', async () => {
    seedEdges();
    const result = ok(await runWorkEntityReadTool(deps(), { kind: 'task', id: TASK_ID }, ctx));
    expect(result.found).toBe(true);
    expect(result).not.toHaveProperty('related');
    expect(result).not.toHaveProperty('related_unavailable');
  });

  it('returns the declared links when asked', async () => {
    seedEdges();
    const result = ok(
      await runWorkEntityReadTool(
        deps(),
        { kind: 'task', id: TASK_ID, include_related: true },
        ctx,
      ),
    );
    const related = result.related as WorkEntityRelatedItem[];
    expect(related).toHaveLength(2);
    const project = related.find((r) => r.field === 'project');
    expect(project).toEqual({ field: 'project', target_kind: 'project', target_id: 'proj_1', resolved: true });
  });

  // ⛔ The unresolved edge is the whole reason this returns a `resolved` flag
  // rather than filtering. Dropping it would under-report the record's links,
  // and `work.read`'s description tells the model to state links as present —
  // so a filtered-out edge becomes the model asserting one does not exist.
  it('KEEPS an unresolved edge and marks it, rather than dropping it', async () => {
    seedEdges();
    const result = ok(
      await runWorkEntityReadTool(
        deps(),
        { kind: 'task', id: TASK_ID, include_related: true },
        ctx,
      ),
    );
    const related = result.related as WorkEntityRelatedItem[];
    const blocked = related.find((r) => r.field === 'blocked_by');
    expect(blocked).toBeDefined();
    expect(blocked?.resolved).toBe(false);
    expect(blocked?.target_id).toBeUndefined();
    // The vendor handle survives — on an unresolved edge it is the only
    // human-meaningful thing to say about the target.
    expect(blocked?.target_remote_id).toBe('remote_77');
  });

  it('returns an empty list — not an unavailable — for a record with no links', async () => {
    const result = ok(
      await runWorkEntityReadTool(
        deps(),
        { kind: 'task', id: TASK_ID, include_related: true },
        ctx,
      ),
    );
    expect(result.related).toEqual([]);
    expect(result).not.toHaveProperty('related_unavailable');
  });

  // ⛔⛔ THE DISTINCTION THE WHOLE SHAPE EXISTS FOR: "could not read links" must
  // never arrive looking like "has no links". Both would otherwise be `[]`, and
  // the model states the second to the user as a fact about their data.
  it('DISCLOSES rather than returning [] when the edge store is unwired', async () => {
    seedEdges();
    const result = ok(
      await runWorkEntityReadTool(
        deps({ getEdgeStore: () => undefined }),
        { kind: 'task', id: TASK_ID, include_related: true },
        ctx,
      ),
    );
    expect(result).not.toHaveProperty('related');
    expect((result.related_unavailable as { reason: string }).reason).toMatch(/not wired/i);
  });

  it('DISCLOSES for a kind that has no relationship model at all', async () => {
    // `commitment` is not a WorkEntitySourceDeclarableKind, so `work_entity_edge`
    // cannot key an owner row of that kind — it has no links by construction.
    //
    // ⚠ The row must EXIST. A missing record short-circuits to
    // `{ entity: null, found: false }` long before the related block, so seeding
    // nothing here would have passed for the wrong reason — the first version of
    // this test did exactly that and asserted on an undefined.
    const commitmentSource = RECUED_BUILTIN_SOURCE_ID('commitment');
    store.registerSource({
      id: commitmentSource,
      top_tier_kind: 'commitment',
      source_kind: 'builtin',
      source_label: commitmentSource,
      write_capable: true,
      registered_at: NOW,
    });
    const commitment = store.writeCommitment(
      {
        source_id: commitmentSource,
        direction: 'outbound',
        statement: 'Send the signed amendment',
        derivation: 'user_declared',
      },
      NOW,
    );
    const result = ok(
      await runWorkEntityReadTool(
        deps(),
        { kind: 'commitment', id: commitment.id, include_related: true },
        ctx,
      ),
    );
    expect(result.found).toBe(true);
    expect(result).not.toHaveProperty('related');
    expect((result.related_unavailable as { reason: string }).reason)
      .toMatch(/no relationship model/i);
  });

  it('rejects a non-boolean flag instead of coercing it', async () => {
    const result = await runWorkEntityReadTool(
      deps(),
      { kind: 'task', id: TASK_ID, include_related: 'yes' },
      ctx,
    );
    expect(result.ok).toBe(false);
  });

  // The flag rides the EXISTING fences; it must not become a way around them.
  // Both refusals keep their `{ entity: null, found: false }` + hint shape and
  // grow no related payload.
  it.each([
    ['verb-op', { isVerbOpGranted: () => false }],
    ['collection', { isCollectionReadGranted: () => false }],
  ])('carries no related past the %s fence', async (_label, fence) => {
    seedEdges();
    const result = ok(
      await runWorkEntityReadTool(
        deps(fence as Partial<WorkEntityReadToolsDeps>),
        { kind: 'task', id: TASK_ID, include_related: true },
        ctx,
      ),
    );
    expect(result.found).toBe(false);
    expect(result).not.toHaveProperty('related');
    expect(result).not.toHaveProperty('related_unavailable');
    expect(result.hint).toBeDefined();
  });
});

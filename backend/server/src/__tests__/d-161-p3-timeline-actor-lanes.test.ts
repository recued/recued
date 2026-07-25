/** D-161 Part B (P3) — timeline / Memory actor lanes (server-side).
 *
 *  Two consumer surfaces read the P1 `origin_actor` stamp:
 *
 *  1. `data.timeline(entity_id)` (`handleTimelineRequest`) — gains an
 *     `origin_actors` lane filter applied across all 5 merge sources
 *     (memory derives origin from `execution_source.actor`; annotation /
 *     link / enrichment read their P1/P2 column). Omitted → no narrowing
 *     (full per-entity history; I-9). A lane filter narrows the page but
 *     never deletes rows (I-7: re-querying another lane returns them).
 *
 *  2. The aggregate "Recent activity" feed (`handleExecutionRecent` →
 *     `AuditLogStore.listRecent`) — DEFAULTS to the foreground lane
 *     (`user_self`+`system`); `contracted_user` / `anonymous` rows are
 *     reachable via an explicit `origin_actors`, never dropped (I-7).
 *
 *  Spec: docs/d-161-spec.md § N.8 / A.7 / I-7 / I-9 / O-2.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Actor, EmittedLink, ExecutionSource } from '@recued/contracts';
import { originProvenanceFromOptionalSource } from '@recued/contracts';
import {
  createAuditLogStore,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
} from '@recued/storage';

import { createSQLiteCollection } from '../sqlite-collection.js';
import { ensureMemorySchema, getOrCreateRecipeInsight } from '../memory-schema.js';
import { insertLinks } from '../memory-links.js';
import { createBlobStore } from '../storage/blob-store.js';
import {
  createAnnotationStore,
  type AnnotationStore,
} from '../storage/annotation-store.js';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import { handleTimelineRequest, type TimelineDeps } from '../mcp/timeline.js';
import { handleExecutionRecent } from '../history-handler.js';
import { _testing as mcpTesting } from '../mcp-server.js';

// ────────────────────────────────────────────────────────────────
// Harness
// ────────────────────────────────────────────────────────────────

let dir: string;
let db: Database.Database;
let auditLog: AuditLogStore;
let annotationStore: AnnotationStore;
let enrichmentStore: EnrichmentStore;
let insightId: number;

const setupHarness = (): void => {
  dir = mkdtempSync(join(tmpdir(), 'd161-p3-lanes-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');

  createSQLiteCollection<AuditEntry>(db, 'audit_entries');
  createSQLiteCollection<ActivityEntry>(db, 'audit_activities');
  ensureMemorySchema(db);

  const auditCol = createSQLiteCollection<AuditEntry>(db, 'audit_entries');
  const activityCol = createSQLiteCollection<ActivityEntry>(db, 'audit_activities');
  auditLog = createAuditLogStore(auditCol, activityCol);

  const blobs = createBlobStore(join(dir, 'blobs'));
  let annCounter = 0;
  let annClock = 1_000_000;
  annotationStore = createAnnotationStore({
    db,
    blobs,
    now: () => annClock++,
    newId: () => `ann-${++annCounter}`,
  });

  let enrCounter = 0;
  enrichmentStore = createEnrichmentStore(db, {
    now: () => 1_700_000_000_000,
    newId: () => `enr-${++enrCounter}`,
  });

  insightId = getOrCreateRecipeInsight(db, {
    hash: 'h-1',
    slug: 'p3-recipe',
    version: 1,
    flattened: '{"trigger":{"type":"manual"},"steps":[]}',
  });
};

const teardown = (): void => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
};

beforeEach(() => setupHarness());
afterEach(() => teardown());

// ── ExecutionSource fixtures, one per actor ─────────────────────
const SRC: Record<Actor, ExecutionSource> = {
  user_self: { channel: 'user', actor: 'user_self', user_id: 'u1', client_token_id: 'ct1' },
  system: { channel: 'schedule', actor: 'system', cron: '0 * * * *', source_recipe: 'p3-recipe' },
  contracted_user: {
    channel: 'mcp',
    actor: 'contracted_user',
    agent_id: 'agent-1',
    tool_call_id: 'tc-1',
    mcp_token_id: 'mt-1',
    contract_id: 'ct-x',
  },
  anonymous: { channel: 'reception', actor: 'anonymous', reception_id: 'rcp-1' },
};

const seedMemory = async (
  run_id: string,
  collection: string,
  entity_id: string,
  ts: number,
  execution_source: ExecutionSource | undefined,
): Promise<void> => {
  const entry: AuditEntry = {
    run_id,
    recipe_id: 'p3-recipe',
    recipe_hash: 'h-1',
    started_at: ts - 10,
    finished_at: ts,
    duration_ms: 10,
    commit_status: 'succeeded',
    config_snapshot: {},
    errors: [],
    trigger_url: null,
    trigger_source: 'manual',
    instance_id: null,
    recipe_insight_id: insightId,
    ...(execution_source !== undefined ? { execution_source } : {}),
  };
  await auditLog.append(entry);
  const link: EmittedLink = {
    step_id: 'step',
    collection,
    entity_id,
    kind: 'execution.action',
    access: 'read',
    ts,
  };
  // Stamp the link row's origin facet from the run source, exactly as
  // production does at the execute-handler `insertLinks` seam (D-161 P1).
  // The P4 memory loader reads the link's OWN `origin_actor` (prune-robust),
  // so the harness must mirror production rather than leaving it defaulted.
  insertLinks(
    db,
    {
      memory_id: run_id,
      recipe_insight_id: insightId,
      origin: originProvenanceFromOptionalSource(execution_source),
    },
    [link],
  );
};

const baseDeps = (): TimelineDeps => ({ db, auditLog, annotationStore, enrichmentStore });

/** Origin set keyed by source on the merged result. */
const originsBySource = (
  entries: ReadonlyArray<{ source: string; origin_actor?: Actor }>,
): Record<string, Actor | undefined> =>
  Object.fromEntries(entries.map((e) => [e.source, e.origin_actor]));

// ────────────────────────────────────────────────────────────────
// data.timeline() — lane filter across all sources
// ────────────────────────────────────────────────────────────────

describe('handleTimelineRequest — origin_actor lane filter', () => {
  /** Seed four sources on one entity, one distinct actor each. */
  const seedAllLanes = async (): Promise<void> => {
    await seedMemory('run-self', 'contact', 'c1', 3000, SRC.user_self);
    await annotationStore.annotate({
      target_collection: 'contact',
      target_id: 'c1',
      key: 'note',
      value: 'agent wrote this',
      authored_by_recipe_id: 'p3-recipe',
      recipe_hash: 'h-1',
      source_record_hash: 'src:contact:c1',
      origin_actor: 'contracted_user',
    });
    enrichmentStore.upsert({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'c1',
      value: {
        interaction_count: 5,
        last_interaction: 3000,
        recent_subjects: ['hello'],
        cursor_at: 3000,
        window_ms: 30 * 24 * 60 * 60 * 1000,
      },
      authored_by: 'system.housekeeping.contact_timeline_rollup',
      origin_actor: 'anonymous',
    });
    await annotationStore.link({
      from_collection: 'mail',
      from_id: 'm1',
      to_collection: 'contact',
      to_id: 'c1',
      role: 'mentions',
      authored_by_recipe_id: 'p3-recipe',
      origin_actor: 'system',
    });
  };

  it('no filter → all 4 sources surface, each carrying its write-actor lane (I-9)', async () => {
    await seedAllLanes();
    const res = await handleTimelineRequest(baseDeps(), { entity_id: 'contact:c1' });
    expect(res.entries).toHaveLength(4);
    expect(originsBySource(res.entries)).toEqual({
      memory: 'user_self',
      annotation: 'contracted_user',
      enrichment: 'anonymous',
      link: 'system',
    });
  });

  it('narrows to the agents lane (contracted_user) — only the annotation row', async () => {
    await seedAllLanes();
    const res = await handleTimelineRequest(baseDeps(), {
      entity_id: 'contact:c1',
      origin_actors: ['contracted_user'],
    });
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0].source).toBe('annotation');
    expect(res.entries[0].origin_actor).toBe('contracted_user');
  });

  it('foreground lane (user_self + system) → memory + link only; agents/reception filtered out', async () => {
    await seedAllLanes();
    const res = await handleTimelineRequest(baseDeps(), {
      entity_id: 'contact:c1',
      origin_actors: ['user_self', 'system'],
    });
    const sources = res.entries.map((e) => e.source).sort();
    expect(sources).toEqual(['link', 'memory']);
    expect(res.entries.every((e) => e.origin_actor === 'user_self' || e.origin_actor === 'system')).toBe(true);
  });

  it('reception lane (anonymous) → only the enrichment row (reachable, I-7)', async () => {
    await seedAllLanes();
    const res = await handleTimelineRequest(baseDeps(), {
      entity_id: 'contact:c1',
      origin_actors: ['anonymous'],
    });
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0].source).toBe('enrichment');
    expect(res.entries[0].origin_actor).toBe('anonymous');
  });

  it('I-7 treatment-not-exclusion: a narrowed query never drops rows from the warehouse', async () => {
    await seedAllLanes();
    // Narrow to one lane (hides the other three)…
    await handleTimelineRequest(baseDeps(), {
      entity_id: 'contact:c1',
      origin_actors: ['user_self'],
    });
    // …then every other lane is still reachable, and the unfiltered feed
    // still returns all 4 — nothing was deleted.
    const anon = await handleTimelineRequest(baseDeps(), {
      entity_id: 'contact:c1',
      origin_actors: ['anonymous'],
    });
    expect(anon.entries).toHaveLength(1);
    const all = await handleTimelineRequest(baseDeps(), { entity_id: 'contact:c1' });
    expect(all.entries).toHaveLength(4);
  });

  it('empty origin_actors → no narrowing (a [] filter never empties the feed)', async () => {
    await seedAllLanes();
    const res = await handleTimelineRequest(baseDeps(), {
      entity_id: 'contact:c1',
      origin_actors: [],
    });
    expect(res.entries).toHaveLength(4);
  });

  it('a memory row with no execution_source reads in the system lane', async () => {
    await seedMemory('run-legacy', 'contact', 'c2', 4000, undefined);
    const sys = await handleTimelineRequest(baseDeps(), {
      entity_id: 'contact:c2',
      origin_actors: ['system'],
    });
    expect(sys.entries).toHaveLength(1);
    expect(sys.entries[0].origin_actor).toBe('system');
    const self = await handleTimelineRequest(baseDeps(), {
      entity_id: 'contact:c2',
      origin_actors: ['user_self'],
    });
    expect(self.entries).toHaveLength(0);
  });

  it('paginates past a fully non-matching window to reach a deeper lane row (I-7 reachability)', async () => {
    // 5 anonymous memory rows (newer) sit ahead of 1 user_self row (oldest).
    // With limit=2, perSourceLimit=5 → the first fetch is entirely anonymous,
    // so the lane-filtered first page is empty. The fix must STILL emit a
    // cursor (anchored on the unfiltered window boundary) so the deeper
    // user_self row stays reachable instead of being stranded behind a
    // premature EOF (Codex P3 review HIGH).
    await seedMemory('run-a1', 'contact', 'c3', 1000, SRC.anonymous);
    await seedMemory('run-a2', 'contact', 'c3', 900, SRC.anonymous);
    await seedMemory('run-a3', 'contact', 'c3', 800, SRC.anonymous);
    await seedMemory('run-a4', 'contact', 'c3', 700, SRC.anonymous);
    await seedMemory('run-a5', 'contact', 'c3', 600, SRC.anonymous);
    await seedMemory('run-self-deep', 'contact', 'c3', 500, SRC.user_self);

    // First page is lane-empty but MUST advance (cursor present) — the fix.
    const first = await handleTimelineRequest(baseDeps(), {
      entity_id: 'contact:c3',
      origin_actors: ['user_self'],
      limit: 2,
    });
    expect(first.entries).toHaveLength(0);
    expect(first.next_cursor).toBeDefined();

    // Drain the cursor; the deep user_self row must surface, and only it.
    const runIdOf = (e: { payload: unknown }): string =>
      String((e.payload as { run_id?: string }).run_id);
    const collected: string[] = first.entries.map(runIdOf);
    let cursor = first.next_cursor;
    let guard = 0;
    while (cursor !== undefined && guard < 20) {
      const next = await handleTimelineRequest(baseDeps(), {
        entity_id: 'contact:c3',
        origin_actors: ['user_self'],
        limit: 2,
        cursor,
      });
      collected.push(...next.entries.map(runIdOf));
      cursor = next.next_cursor;
      guard += 1;
    }
    expect(collected).toEqual(['run-self-deep']);
  });
});

// ────────────────────────────────────────────────────────────────
// Aggregate "Recent activity" feed — handleExecutionRecent
// ────────────────────────────────────────────────────────────────

describe('handleExecutionRecent — aggregate feed actor lanes', () => {
  const seedRun = async (
    run_id: string,
    ts: number,
    execution_source: ExecutionSource | undefined,
  ): Promise<void> => {
    await auditLog.append({
      run_id,
      recipe_id: 'p3-recipe',
      recipe_hash: 'h-1',
      started_at: ts,
      finished_at: ts + 5,
      duration_ms: 5,
      commit_status: 'succeeded',
      config_snapshot: {},
      errors: [],
      trigger_url: null,
      trigger_source: 'manual',
      instance_id: null,
      recipe_insight_id: insightId,
      ...(execution_source !== undefined ? { execution_source } : {}),
    });
  };

  const seedAllRuns = async (): Promise<void> => {
    await seedRun('run-user', 5000, SRC.user_self);
    await seedRun('run-sys', 5001, SRC.system);
    await seedRun('run-legacy', 5002, undefined); // no source → system lane
    await seedRun('run-agent', 5003, SRC.contracted_user);
    await seedRun('run-anon', 5004, SRC.anonymous);
  };

  const idsOf = (out: { executions: ReadonlyArray<{ run_id: string }> }): string[] =>
    out.executions.map((e) => e.run_id).sort();

  it('defaults to the foreground lane (user_self + system); agents/reception excluded', async () => {
    await seedAllRuns();
    const out = await handleExecutionRecent({ auditLog }, { limit: 50 });
    expect(idsOf(out)).toEqual(['run-legacy', 'run-sys', 'run-user']);
    // The excluded rows are NOT in the default view…
    expect(idsOf(out)).not.toContain('run-agent');
    expect(idsOf(out)).not.toContain('run-anon');
  });

  it('projects the lane (origin_actor) onto each row; legacy rows → system', async () => {
    await seedAllRuns();
    const out = await handleExecutionRecent({ auditLog }, { limit: 50 });
    const byId = Object.fromEntries(out.executions.map((e) => [e.run_id, e.origin_actor]));
    expect(byId['run-user']).toBe('user_self');
    expect(byId['run-sys']).toBe('system');
    expect(byId['run-legacy']).toBe('system');
  });

  it('reaches the agents lane via an explicit origin_actors (I-7 — reachable, not dropped)', async () => {
    await seedAllRuns();
    const out = await handleExecutionRecent(
      { auditLog },
      { limit: 50, origin_actors: ['contracted_user'] },
    );
    expect(idsOf(out)).toEqual(['run-agent']);
    expect(out.executions[0].origin_actor).toBe('contracted_user');
  });

  it('reaches the reception lane (anonymous) via an explicit filter', async () => {
    await seedAllRuns();
    const out = await handleExecutionRecent(
      { auditLog },
      { limit: 50, origin_actors: ['anonymous'] },
    );
    expect(idsOf(out)).toEqual(['run-anon']);
    expect(out.executions[0].origin_actor).toBe('anonymous');
  });

  it('an empty origin_actors falls back to the default foreground (never an empty feed)', async () => {
    await seedAllRuns();
    const out = await handleExecutionRecent({ auditLog }, { limit: 50, origin_actors: [] });
    expect(idsOf(out)).toEqual(['run-legacy', 'run-sys', 'run-user']);
  });
});

// ────────────────────────────────────────────────────────────────
// MCP tool-schema discoverability (Codex P3 review MEDIUM / O-2)
// ────────────────────────────────────────────────────────────────

describe('recued_dataTimeline MCP tool schema — origin_actors facet', () => {
  it('advertises origin_actors as an Actor-enum array so schema-driven agents discover the lane filter', () => {
    const tool = mcpTesting.STATIC_TOOLS.find((t) => t.name === 'recued_dataTimeline');
    expect(tool).toBeDefined();
    const props = (tool!.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props.origin_actors).toBeDefined();
    const facet = props.origin_actors as { type: string; items: { enum: string[] } };
    expect(facet.type).toBe('array');
    expect([...facet.items.enum].sort()).toEqual([
      'anonymous',
      'contracted_user',
      'system',
      'user_self',
    ]);
  });
});

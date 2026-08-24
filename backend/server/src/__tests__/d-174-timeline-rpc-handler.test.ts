/** D-174 #22 — `data.timeline` pair-RPC handler tests.
 *
 *  Per the dispatch GATE: the pair-RPC returns the SAME rows as the
 *  MCP / recipe channels for a fixture entity (channel-isolation
 *  invariant — same SELECT, same storage, separate dispatcher). We
 *  assert byte-parity against:
 *    - `handleTimelineRequest` directly (what the MCP `recued_dataTimeline`
 *      tool calls), and
 *    - `handleTimelineReadFromRecipe` (the recipe-channel `timeline-read`
 *      kernel handler).
 *  Plus the bad-request guard + the slice's absent-deps + method-claim
 *  behaviour.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RpcError } from '@recued/contracts';
import {
  createAuditLogStore,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
} from '@recued/storage';

import { createSQLiteCollection } from '../sqlite-collection.js';
import { ensureMemorySchema } from '../memory-schema.js';
import { createBlobStore } from '../storage/blob-store.js';
import {
  createAnnotationStore,
  type AnnotationStore,
} from '../storage/annotation-store.js';
import type { WsClient } from '../ws-server.js';
import { handleTimelineRequest, type TimelineDeps } from '../mcp/timeline.js';
import { handleTimelineReadFromRecipe } from '../timeline-recipe-handler.js';
import {
  handleDataTimeline,
  makeTimelineRpcHandlers,
  type TimelineRpcDeps,
} from '../timeline-rpc-handler.js';

const ENTITY = 'contact:alice@example.com';

let dir: string;
let db: Database.Database;
let auditLog: AuditLogStore;
let annotationStore: AnnotationStore;
let timelineDeps: TimelineDeps;
let deps: TimelineRpcDeps;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'd174-timeline-'));
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
  let counter = 0;
  let clock = 1_000_000;
  annotationStore = createAnnotationStore({
    db,
    blobs,
    now: () => clock++,
    newId: () => `ann-${++counter}`,
  });
  // Seed two annotations on the fixture entity so the feed is non-empty.
  await annotationStore.annotate({
    target_collection: 'contact',
    target_id: 'alice@example.com',
    key: 'sentiment',
    value: 'warm',
    authored_by_recipe_id: 'r-1',
    source_record_hash: 'src-hash',
  });
  await annotationStore.annotate({
    target_collection: 'contact',
    target_id: 'alice@example.com',
    key: 'tier',
    value: 'gold',
    authored_by_recipe_id: 'r-1',
    source_record_hash: 'src-hash',
  });
  // Paired-client channel deps — NO `gateMcpPrivate` (sees private rows).
  timelineDeps = { db, auditLog, annotationStore };
  deps = { timelineDeps };
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('D-174 data.timeline — channel parity', () => {
  it('returns the same rows as the MCP channel (handleTimelineRequest)', async () => {
    const pair = await handleDataTimeline(deps, { entity_id: ENTITY });
    const mcp = await handleTimelineRequest(timelineDeps, { entity_id: ENTITY });
    expect(pair.entries.length).toBeGreaterThan(0);
    expect(pair.entries).toEqual(mcp.entries);
  });

  it('returns the same rows as the recipe channel (timeline-read)', async () => {
    const pair = await handleDataTimeline(deps, { entity_id: ENTITY });
    const recipe = await handleTimelineReadFromRecipe(
      { timelineDeps },
      { entity: ENTITY },
    );
    expect(pair.entries).toEqual(recipe.entries);
  });

  it('forwards axis / limit through to the shared query', async () => {
    const pair = await handleDataTimeline(deps, { entity_id: ENTITY, axis: 'ingestion', limit: 1 });
    const mcp = await handleTimelineRequest(timelineDeps, {
      entity_id: ENTITY,
      axis: 'ingestion',
      limit: 1,
    });
    expect(pair.entries).toEqual(mcp.entries);
    expect(pair.entries).toHaveLength(1);
  });

  it('empty entity → empty feed (no cursor)', async () => {
    const out = await handleDataTimeline(deps, { entity_id: 'contact:nobody@example.com' });
    expect(out.entries).toEqual([]);
    expect(out.next_cursor).toBeUndefined();
  });
});

describe('D-174 data.timeline — validation', () => {
  it('missing entity_id → bad_request', async () => {
    await expect(
      handleDataTimeline(deps, { entity_id: '' }),
    ).rejects.toMatchObject({ name: 'RpcError', code: 'bad_request' });
  });

  it('malformed entity_id (no colon) → bad_request from the shared query', async () => {
    await expect(
      handleDataTimeline(deps, { entity_id: 'no-colon-here' }),
    ).rejects.toThrow(RpcError);
  });
});

/** Minimal WsClient fake — only `instance_id` matters for the gate. */
const ctx = (instance_id: string | null): WsClient =>
  ({
    ws: null,
    realm: 'recued',
    instance_id,
    display_name: 'c',
    connected_at: 0,
    user_id: 'u',
  }) as unknown as WsClient;

describe('D-174 data.timeline — registered-client gate', () => {
  it('rejects an UNREGISTERED caller (instance_id null) before the query runs', async () => {
    const slice = makeTimelineRpcHandlers(deps)!;
    await expect(
      slice.handlers['data.timeline']({ entity_id: ENTITY }, ctx(null)),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('allows a REGISTERED caller through to the feed', async () => {
    const slice = makeTimelineRpcHandlers(deps)!;
    const out = await slice.handlers['data.timeline']({ entity_id: ENTITY }, ctx('dev-1'));
    expect((out as { entries: unknown[] }).entries.length).toBeGreaterThan(0);
  });

  it('paired-client deps leave the MCP privacy gate OFF (private rows by construction, behind the registered-client gate)', () => {
    expect(deps.timelineDeps.gateMcpPrivate).toBeFalsy();
  });
});

describe('D-174 makeTimelineRpcHandlers slice', () => {
  it('returns undefined when deps absent (→ not_configured)', () => {
    expect(makeTimelineRpcHandlers(undefined)).toBeUndefined();
  });

  it('claims exactly the data.timeline method', () => {
    const slice = makeTimelineRpcHandlers(deps);
    expect(slice).toBeDefined();
    expect(slice!.methods).toEqual(['data.timeline']);
  });
});

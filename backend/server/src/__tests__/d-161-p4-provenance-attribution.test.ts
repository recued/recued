/** D-161 Part B (P4) — provenance-honesty attribution (server-side).
 *
 *  The last D-161 phase. When an outside-actor row surfaces in a consumer
 *  feed it must render ATTRIBUTED — "agent X, under contract Y, asserted
 *  this" (`contracted_user`) / "visitor-derived" (`anonymous`) — never as
 *  the user's own first-person knowledge (I-10). The two feeds P3 built
 *  read the stamp:
 *
 *  1. `data.timeline(entity_id)` — each of the 5 merge sources projects
 *     `entry.attribution`. The memory source has the richest data (the
 *     joined audit row's `execution_source` → the agent id, +
 *     `contract_snapshot` → the contract version; N.8 / O-3); annotation /
 *     link / enrichment derive from their `origin_actor` + `origin_contract_id`
 *     columns.
 *  2. The aggregate "Recent activity" feed (`handleExecutionRecent`) —
 *     each run projects `attribution` from its audit `execution_source` +
 *     `contract_snapshot`.
 *
 *  O-3 is settled as RENDER, not store: attribution is derived at read
 *  time from the already-stored origin facet + the commit's existing
 *  `contract_snapshot` — no new column. First-person (`user_self` /
 *  `system`) rows carry NO attribution field, so the gold path is
 *  unchanged (I-9).
 *
 *  Spec: D-161 § N.8 / A.7 / I-9 / I-10 / O-3.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  Actor,
  ContractSnapshot,
  EmittedLink,
  ExecutionSource,
  ProvenanceAttribution,
} from '@recued/contracts';
import { originProvenanceFromOptionalSource } from '@recued/contracts';
import {
  createAuditLogStore,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
} from '@recued/storage';

import { ensureMemorySchema, getOrCreateRecipeInsight } from '../memory-schema.js';
import { insertLinks } from '../memory-links.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createBlobStore } from '../storage/blob-store.js';
import {
  createAnnotationStore,
  type AnnotationStore,
} from '../storage/annotation-store.js';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import { handleExecutionRecent } from '../history-handler.js';
import { handleTimelineRequest, type TimelineDeps } from '../mcp/timeline.js';

// ────────────────────────────────────────────────────────────────
// Harness (mirrors d-161-p3-timeline-actor-lanes.test.ts)
// ────────────────────────────────────────────────────────────────

let dir: string;
let db: Database.Database;
let auditLog: AuditLogStore;
let annotationStore: AnnotationStore;
let enrichmentStore: EnrichmentStore;
let insightId: number;

const setupHarness = (): void => {
  dir = mkdtempSync(join(tmpdir(), 'd161-p4-attr-'));
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
    slug: 'p4-recipe',
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

// ── ExecutionSource fixtures ────────────────────────────────────
const MCP_AGENT: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'agent-1',
  tool_call_id: 'tc-1',
  mcp_token_id: 'mt-1',
  contract_id: 'ct-x',
};
const RECEPTION_ANON: ExecutionSource = {
  channel: 'reception',
  actor: 'anonymous',
  reception_id: 'rcp-1',
};
const USER_SELF: ExecutionSource = {
  channel: 'user',
  actor: 'user_self',
  user_id: 'u1',
  client_token_id: 'ct1',
};
const SYSTEM_CRON: ExecutionSource = {
  channel: 'schedule',
  actor: 'system',
  cron: '0 * * * *',
  source_recipe: 'p4-recipe',
};

const SNAPSHOT: ContractSnapshot = {
  contract_id: 'ct-x',
  contract_version: 'v9',
  allowed_tools: ['mail-send'],
  approval_required: ['high'],
  scope_restrictions: ['data.mail'],
  resolved_at: 1_700_000_000_000,
};

const seedMemory = async (
  run_id: string,
  collection: string,
  entity_id: string,
  ts: number,
  execution_source: ExecutionSource | undefined,
  contract_snapshot?: ContractSnapshot,
): Promise<void> => {
  const entry: AuditEntry = {
    run_id,
    recipe_id: 'p4-recipe',
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
    ...(contract_snapshot !== undefined ? { contract_snapshot } : {}),
  };
  await auditLog.append(entry);
  insertOriginLink(run_id, collection, entity_id, ts, execution_source);
};

/** Insert just the provenance link row (D-120), stamped from the run
 *  source exactly as production's execute-handler seam does — WITHOUT an
 *  audit row. Simulates retention/manual prune: the audit body is gone,
 *  the link survives carrying its own P1 origin stamp. */
const insertOriginLink = (
  run_id: string,
  collection: string,
  entity_id: string,
  ts: number,
  execution_source: ExecutionSource | undefined,
): void => {
  const link: EmittedLink = {
    step_id: 'step',
    collection,
    entity_id,
    kind: 'execution.action',
    access: 'read',
    ts,
  };
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

/** Attribution keyed by source on the merged result. */
const attrBySource = (
  entries: ReadonlyArray<{ source: string; attribution?: ProvenanceAttribution }>,
): Record<string, ProvenanceAttribution | undefined> =>
  Object.fromEntries(entries.map((e) => [e.source, e.attribution]));

// ────────────────────────────────────────────────────────────────
// data.timeline() — attribution per source
// ────────────────────────────────────────────────────────────────

describe('handleTimelineRequest — memory source attribution (richest: source + snapshot)', () => {
  it('contracted_user (mcp) + contract_snapshot → "agent X, under contract Y, asserted this" w/ version (O-3)', async () => {
    await seedMemory('run-agent', 'contact', 'c1', 3000, MCP_AGENT, SNAPSHOT);
    const res = await handleTimelineRequest(baseDeps(), { entity_id: 'contact:c1' });
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0].attribution).toEqual({
      kind: 'agent',
      origin_actor: 'contracted_user',
      agent_id: 'agent-1',
      contract_id: 'ct-x',
      contract_version: 'v9',
      label: 'agent agent-1, under contract ct-x, asserted this',
    });
  });

  it('contracted_user without a snapshot → contract id from the source, no version', async () => {
    await seedMemory('run-agent', 'contact', 'c1', 3000, MCP_AGENT);
    const res = await handleTimelineRequest(baseDeps(), { entity_id: 'contact:c1' });
    expect(res.entries[0].attribution?.contract_id).toBe('ct-x');
    expect(res.entries[0].attribution?.contract_version).toBeUndefined();
    expect(res.entries[0].attribution?.agent_id).toBe('agent-1');
  });

  it('anonymous → visitor-derived', async () => {
    await seedMemory('run-anon', 'contact', 'c1', 3000, RECEPTION_ANON);
    const res = await handleTimelineRequest(baseDeps(), { entity_id: 'contact:c1' });
    expect(res.entries[0].attribution).toEqual({
      kind: 'visitor',
      origin_actor: 'anonymous',
      label: 'visitor-derived (anonymous reception)',
    });
  });

  it('I-9 gold path: a user_self / system memory row carries NO attribution field', async () => {
    await seedMemory('run-self', 'contact', 'c1', 3000, USER_SELF);
    await seedMemory('run-sys', 'contact', 'c1', 2000, SYSTEM_CRON);
    const res = await handleTimelineRequest(baseDeps(), { entity_id: 'contact:c1' });
    expect(res.entries).toHaveLength(2);
    for (const e of res.entries) {
      expect(e.attribution).toBeUndefined();
      expect('attribution' in e).toBe(false); // omitted, not present-undefined
    }
  });

  it('a pruned / source-less memory row → no attribution (origin unknown → system → first-person)', async () => {
    await seedMemory('run-legacy', 'contact', 'c1', 3000, undefined);
    const res = await handleTimelineRequest(baseDeps(), { entity_id: 'contact:c1' });
    expect(res.entries[0].origin_actor).toBe('system');
    expect(res.entries[0].attribution).toBeUndefined();
  });

  it('PRUNED AUDIT: a contracted_user link keeps its lane + attribution from the LINK row (I-10 prune gap)', async () => {
    // Audit body gone (retention), but the D-120 link survives with its own
    // P1 origin stamp. The memory entry must STILL surface attributed +
    // lane-filterable — never downgraded to unattributed first-person/system.
    insertOriginLink('run-orphan-agent', 'contact', 'c1', 3000, MCP_AGENT);
    const all = await handleTimelineRequest(baseDeps(), { entity_id: 'contact:c1' });
    expect(all.entries).toHaveLength(1);
    expect(all.entries[0].origin_actor).toBe('contracted_user');
    // agent_id / contract_version are lost with the pruned audit, but the
    // contract id is on the link row → the attribution + label survive.
    expect(all.entries[0].attribution).toEqual({
      kind: 'agent',
      origin_actor: 'contracted_user',
      contract_id: 'ct-x',
      label: 'an agent, under contract ct-x, asserted this',
    });

    // …and it reads in the agents lane, NOT the gold-path foreground.
    const agents = await handleTimelineRequest(baseDeps(), {
      entity_id: 'contact:c1',
      origin_actors: ['contracted_user'],
    });
    expect(agents.entries).toHaveLength(1);
    const foreground = await handleTimelineRequest(baseDeps(), {
      entity_id: 'contact:c1',
      origin_actors: ['user_self', 'system'],
    });
    expect(foreground.entries).toHaveLength(0);
  });

  it('PRUNED AUDIT: an anonymous link stays visitor-derived + reachable in the reception lane', async () => {
    insertOriginLink('run-orphan-anon', 'contact', 'c1', 3000, RECEPTION_ANON);
    const all = await handleTimelineRequest(baseDeps(), { entity_id: 'contact:c1' });
    expect(all.entries[0].origin_actor).toBe('anonymous');
    // D-209 #1 W3 — `anonymous` now spans reception AND webhook, and a pruned
    // audit row means the channel is unknowable: the label must be the
    // channel-NEUTRAL phrasing, never a claim of "reception" it cannot prove.
    expect(all.entries[0].attribution).toEqual({
      kind: 'visitor',
      origin_actor: 'anonymous',
      label: 'visitor-derived (anonymous)',
    });
    const reception = await handleTimelineRequest(baseDeps(), {
      entity_id: 'contact:c1',
      origin_actors: ['anonymous'],
    });
    expect(reception.entries).toHaveLength(1);
  });

  it('DIVERGENT AUDIT: the link is the SOLE contract source; version omitted unless the snapshot matches it', async () => {
    // A coherent production run never diverges, but the link facet must be
    // the ONLY contract source of truth: a `contract_snapshot` whose
    // contract_id differs from the link's must NEITHER relabel the contract
    // NOR attach its version (Codex P4 re-review HIGH).
    const divergentSnapshot: ContractSnapshot = { ...SNAPSHOT, contract_id: 'ct-OTHER' };
    await seedMemory('run-divergent', 'contact', 'c1', 3000, MCP_AGENT, divergentSnapshot);
    const res = await handleTimelineRequest(baseDeps(), { entity_id: 'contact:c1' });
    expect(res.entries[0].attribution).toEqual({
      kind: 'agent',
      origin_actor: 'contracted_user',
      agent_id: 'agent-1', // still enriched — the audit actor matches the link
      contract_id: 'ct-x', // the LINK's contract, never the snapshot's 'ct-OTHER'
      label: 'agent agent-1, under contract ct-x, asserted this',
    });
    expect(res.entries[0].attribution?.contract_version).toBeUndefined();
  });
});

describe('handleTimelineRequest — annotation / link / enrichment attribution (origin columns)', () => {
  it('annotation by contracted_user (origin_contract_id, no agent id) → "an agent, under contract Y, asserted this"', async () => {
    await annotationStore.annotate({
      target_collection: 'contact',
      target_id: 'c1',
      key: 'note',
      value: 'agent wrote this',
      authored_by_recipe_id: 'p4-recipe',
      source_record_hash: 'src:contact:c1',
      origin_actor: 'contracted_user',
      origin_contract_id: 'ct-ann',
    });
    const res = await handleTimelineRequest(baseDeps(), { entity_id: 'contact:c1' });
    const attribution = attrBySource(res.entries).annotation;
    expect(attribution).toEqual({
      kind: 'agent',
      origin_actor: 'contracted_user',
      contract_id: 'ct-ann',
      label: 'an agent, under contract ct-ann, asserted this',
    });
    expect(attribution?.agent_id).toBeUndefined(); // sidecar row has no execution_source
  });

  it('enrichment by contracted_user → attributed with its origin_contract_id', async () => {
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
      authored_by: 'agent.mcp',
      origin_actor: 'contracted_user',
      origin_contract_id: 'ct-enr',
    });
    const res = await handleTimelineRequest(baseDeps(), { entity_id: 'contact:c1' });
    expect(attrBySource(res.entries).enrichment).toEqual({
      kind: 'agent',
      origin_actor: 'contracted_user',
      contract_id: 'ct-enr',
      label: 'an agent, under contract ct-enr, asserted this',
    });
  });

  it('typed link by contracted_user → attributed', async () => {
    await annotationStore.link({
      from_collection: 'mail',
      from_id: 'm1',
      to_collection: 'contact',
      to_id: 'c1',
      role: 'mentions',
      authored_by_recipe_id: 'p4-recipe',
      origin_actor: 'contracted_user',
      origin_contract_id: 'ct-link',
    });
    const res = await handleTimelineRequest(baseDeps(), { entity_id: 'contact:c1' });
    expect(attrBySource(res.entries).link).toEqual({
      kind: 'agent',
      origin_actor: 'contracted_user',
      contract_id: 'ct-link',
      label: 'an agent, under contract ct-link, asserted this',
    });
  });

  it('I-9 gold path: a system-stamped annotation / link carries NO attribution', async () => {
    await annotationStore.annotate({
      target_collection: 'contact',
      target_id: 'c1',
      key: 'note',
      value: 'system summary',
      authored_by_recipe_id: 'p4-recipe',
      source_record_hash: 'src:contact:c1',
      origin_actor: 'system',
    });
    await annotationStore.link({
      from_collection: 'mail',
      from_id: 'm1',
      to_collection: 'contact',
      to_id: 'c1',
      role: 'mentions',
      authored_by_recipe_id: 'p4-recipe',
      origin_actor: 'system',
    });
    const res = await handleTimelineRequest(baseDeps(), { entity_id: 'contact:c1' });
    for (const e of res.entries) expect(e.attribution).toBeUndefined();
  });
});

describe('handleTimelineRequest — I-10 holistic (mixed lanes on one entity)', () => {
  it('attribution rides the actor lane: outside actors attributed, gold path silent', async () => {
    await seedMemory('run-self', 'contact', 'c1', 4000, USER_SELF);
    await seedMemory('run-agent', 'contact', 'c1', 3000, MCP_AGENT, SNAPSHOT);
    await annotationStore.annotate({
      target_collection: 'contact',
      target_id: 'c1',
      key: 'note',
      value: 'visitor said',
      authored_by_recipe_id: 'p4-recipe',
      source_record_hash: 'src:contact:c1',
      origin_actor: 'anonymous',
    });
    const res = await handleTimelineRequest(baseDeps(), { entity_id: 'contact:c1' });
    const byActor = Object.fromEntries(
      res.entries.map((e) => [e.origin_actor, e.attribution?.kind]),
    );
    // user_self → no attribution (the user's own); contracted_user → agent;
    // anonymous → visitor. An agent assertion never surfaces unattributed.
    expect(byActor.user_self).toBeUndefined();
    expect(byActor.contracted_user).toBe('agent');
    expect(byActor.anonymous).toBe('visitor');
  });
});

// ────────────────────────────────────────────────────────────────
// Aggregate "Recent activity" feed — handleExecutionRecent
// ────────────────────────────────────────────────────────────────

describe('handleExecutionRecent — run attribution', () => {
  const seedRun = async (
    run_id: string,
    ts: number,
    execution_source: ExecutionSource | undefined,
    contract_snapshot?: ContractSnapshot,
  ): Promise<void> => {
    await auditLog.append({
      run_id,
      recipe_id: 'p4-recipe',
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
      ...(contract_snapshot !== undefined ? { contract_snapshot } : {}),
    });
  };

  it('the agents lane (reached via an explicit filter) is attributed w/ agent id + contract version', async () => {
    await seedRun('run-agent', 5000, MCP_AGENT, SNAPSHOT);
    const out = await handleExecutionRecent(
      { auditLog },
      { limit: 50, origin_actors: ['contracted_user'] },
    );
    expect(out.executions).toHaveLength(1);
    expect(out.executions[0].attribution).toEqual({
      kind: 'agent',
      origin_actor: 'contracted_user',
      agent_id: 'agent-1',
      contract_id: 'ct-x',
      contract_version: 'v9',
      label: 'agent agent-1, under contract ct-x, asserted this',
    });
  });

  it('the reception lane is attributed visitor-derived', async () => {
    await seedRun('run-anon', 5000, RECEPTION_ANON);
    const out = await handleExecutionRecent(
      { auditLog },
      { limit: 50, origin_actors: ['anonymous'] },
    );
    expect(out.executions[0].attribution).toEqual({
      kind: 'visitor',
      origin_actor: 'anonymous',
      label: 'visitor-derived (anonymous reception)',
    });
  });

  it('DIVERGENT AUDIT: a run renders under its SOURCE contract; version omitted when the snapshot is for another', async () => {
    // Mirrors the memory divergence test for the aggregate feed: the source
    // is the sole contract truth; an incoherent snapshot must not relabel the
    // contract or attach its version (Codex P4 re-review HIGH).
    const divergentSnapshot: ContractSnapshot = { ...SNAPSHOT, contract_id: 'ct-OTHER' };
    await seedRun('run-divergent', 5000, MCP_AGENT, divergentSnapshot);
    const out = await handleExecutionRecent(
      { auditLog },
      { limit: 50, origin_actors: ['contracted_user'] },
    );
    expect(out.executions[0].attribution).toEqual({
      kind: 'agent',
      origin_actor: 'contracted_user',
      agent_id: 'agent-1',
      contract_id: 'ct-x', // the SOURCE's contract, never the snapshot's 'ct-OTHER'
      label: 'agent agent-1, under contract ct-x, asserted this',
    });
    expect(out.executions[0].attribution?.contract_version).toBeUndefined();
  });

  it('I-9 / I-10: the default foreground feed carries NO attribution on any row', async () => {
    await seedRun('run-user', 5000, USER_SELF);
    await seedRun('run-sys', 5001, SYSTEM_CRON);
    await seedRun('run-legacy', 5002, undefined);
    // Agents + reception runs exist but are NOT in the default foreground…
    await seedRun('run-agent', 5003, MCP_AGENT, SNAPSHOT);
    await seedRun('run-anon', 5004, RECEPTION_ANON);
    const out = await handleExecutionRecent({ auditLog }, { limit: 50 });
    // …the default feed is exactly the 3 gold-path runs, all unattributed
    // (an agent run never appears unattributed in the first-person feed).
    expect(out.executions.map((e) => e.run_id).sort()).toEqual([
      'run-legacy',
      'run-sys',
      'run-user',
    ]);
    for (const e of out.executions) expect(e.attribution).toBeUndefined();
  });
});

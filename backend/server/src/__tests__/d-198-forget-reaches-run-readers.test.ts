/** D-198 §11 — a run the owner forgot in the Memory lens stays forgotten where an
 *  AI reads runs: `data.timeline` (MCP, recipe and paired channels share
 *  `handleTimelineRequest`) and MCP run history (`recued_getAudit`).
 *
 *  ⛔ The forget goes through the REAL `memory.delete` handler onto the store boot
 *  opens (`openMemoryRedactionStore`), and NEITHER reader is handed that store:
 *  each must find the mark on the database it already reads. Passing the store in
 *  would prove a reader can honour one, not that it does where nothing wires one —
 *  which is the stdio MCP process, every time.
 *
 *  Every forgotten-run assertion is paired with the run nobody forgot in the same
 *  response, so a reader that dropped or blanked every run cannot pass.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EmittedLink, TimelineEntry } from '@recued/contracts';
import {
  createAuditLogStore,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
} from '@recued/storage';

import { createSQLiteCollection } from '../sqlite-collection.js';
import { ensureMemorySchema, getOrCreateRecipeInsight } from '../memory-schema.js';
import { insertLinks } from '../memory-links.js';
import { handleTimelineRequest } from '../mcp/timeline.js';
import { handleMemoryDelete } from '../memory-rpc-handler.js';
import { openMemoryRedactionStore } from '../memory-revision.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { createMcpHttpDispatch, type McpDeps } from '../mcp-server.js';

const FORGOTTEN_OUTPUT = 'Invoice 4471 for Dana Whitfield is overdue';
const FORGOTTEN_CONFIG = 'acct-7731-private';
const FORGOTTEN_CONTEXT = 'dana.whitfield@example.com';
const KEPT_OUTPUT = 'Weekly digest sent';

let dir: string;
let db: Database.Database;
let auditLog: AuditLogStore;
let insightId: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'd198-forget-runs-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  // Audit tables first, then the memory schema — the order boot uses.
  auditLog = createAuditLogStore(
    createSQLiteCollection<AuditEntry>(db, 'audit_entries'),
    createSQLiteCollection<ActivityEntry>(db, 'audit_activities'),
  );
  ensureMemorySchema(db);
  insightId = getOrCreateRecipeInsight(db, {
    hash: 'h-1',
    slug: 'overdue-invoices',
    version: 1,
    flattened: '{"trigger":{"type":"manual"},"steps":[]}',
  });

  const run = (run_id: string, ts: number, output: string, extra: Partial<AuditEntry> = {}): AuditEntry => ({
    run_id,
    recipe_id: 'overdue-invoices',
    recipe_hash: 'h-1',
    started_at: ts - 50,
    finished_at: ts,
    duration_ms: 50,
    commit_status: 'succeeded',
    config_snapshot: {},
    errors: [],
    trigger_url: null,
    trigger_source: 'manual',
    instance_id: null,
    recipe_insight_id: insightId,
    output_string: output,
    ...extra,
  });
  await auditLog.append(run('run-forgotten', 2_000, FORGOTTEN_OUTPUT, {
    config_snapshot: { account: FORGOTTEN_CONFIG },
    context_snapshot: { sender: FORGOTTEN_CONTEXT },
  }));
  await auditLog.append(run('run-kept', 1_000, KEPT_OUTPUT));

  const touch = (run_id: string, ts: number): void => {
    const link: EmittedLink = {
      step_id: 'step', collection: 'mail', entity_id: 'msg-1', kind: 'execution.action', access: 'read', ts,
    };
    insertLinks(db, { memory_id: run_id, recipe_insight_id: insightId }, [link]);
  };
  touch('run-forgotten', 2_000);
  touch('run-kept', 1_000);

  // The owner presses Forget on the run in the Memory lens.
  const result = await handleMemoryDelete(
    { auditLog, redactionStore: openMemoryRedactionStore(db) },
    { memory_id: 'run-forgotten' },
  );
  expect(result).toMatchObject({ deleted: false, redacted: true });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const memoryEntry = (entries: TimelineEntry[], run_id: string): TimelineEntry | undefined =>
  entries.find((e) => e.source === 'memory' && (e.payload as { run_id?: string }).run_id === run_id);

describe('data.timeline — a forgotten run keeps its place and loses its content', () => {
  it('returns the skeleton the Memory lens keeps, next to the run nobody forgot', async () => {
    // No redaction store in the deps: only the database and the audit log.
    const response = await handleTimelineRequest({ db, auditLog }, { entity_id: 'mail:msg-1' });

    const forgotten = memoryEntry(response.entries, 'run-forgotten');
    expect(forgotten).toBeDefined();
    expect(forgotten!.payload).toEqual({ run_id: 'run-forgotten', redacted: true });
    expect(forgotten!.recipe_slug).toBeUndefined();
    expect(forgotten!.recipe_insight_id).toBeUndefined();
    expect(forgotten!.origin_actor).toBe('system');
    expect(forgotten!.kind).toBe('execution.action');

    const kept = memoryEntry(response.entries, 'run-kept');
    expect((kept!.payload as { output_string?: string }).output_string).toBe(KEPT_OUTPUT);
    expect(kept!.recipe_slug).toBe('overdue-invoices');

    expect(JSON.stringify(response)).not.toContain(FORGOTTEN_OUTPUT);
  });
});

describe('recued_getAudit — run history an AI reads leaves out what was forgotten', () => {
  it('cuts the forgotten run to that it happened, and returns the other in full', async () => {
    const manifests = createManifestRegistry('/nonexistent');
    const dispatch = createMcpHttpDispatch({
      recipeStore: createRecipeStore('/nonexistent'),
      executorConfig: { manifests },
      baseVault: {},
      inboundTokenAuthorize: () => true,
      // No redaction store here either.
      db,
      auditLog,
    } as unknown as McpDeps);

    const response = await dispatch(
      { jsonrpc: '2.0', id: 'audit', method: 'tools/call', params: { name: 'recued_getAudit', arguments: {} } },
      'bearer-test',
    ) as { result: { isError?: boolean; content: Array<{ text: string }> } };

    expect(response.result.isError).toBeUndefined();
    const text = response.result.content[0]!.text;
    const rows = JSON.parse(text) as Array<Record<string, unknown>>;

    expect(rows.find((r) => r.run_id === 'run-forgotten')).toEqual({
      run_id: 'run-forgotten',
      started_at: 1_950,
      kind: 'run',
      origin_actor: 'system',
      redacted: true,
    });
    const kept = rows.find((r) => r.run_id === 'run-kept');
    expect(kept?.output_string).toBe(KEPT_OUTPUT);
    expect(kept?.recipe_id).toBe('overdue-invoices');

    for (const secret of [FORGOTTEN_OUTPUT, FORGOTTEN_CONFIG, FORGOTTEN_CONTEXT]) {
      expect(text).not.toContain(secret);
    }
  });
});

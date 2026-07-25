/** D-120 Phase 7 — server-side unified memory-export rpc tests.
 *
 *  Drives `audit.export.estimate` + `audit.export.page` through the
 *  handler against an in-memory `AuditLogStore` plus a real SQLite
 *  in-memory db so the link / insight joins exercise the same SQL the
 *  production handler emits.
 *
 *  Covers:
 *    - estimate: count + format-aware bytes
 *    - page: envelope on first page + scope='server' + recipe_insights
 *      hash dedup
 *    - cursor pagination over multi-page exports
 *    - link join from the live `links` SQLite table
 *    - audit ledger entry written when the first page lands
 *    - validator rejects malformed args (since > until, bad format)
 *    - returns "not_configured" semantics via undefined-deps
 */

import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  buildAuditEntry,
  createAuditLogStore,
  createInMemoryCollection,
  type AuditEntry,
  type AuditLogStore,
} from '@recued/storage';
import { ensureMemorySchema, getOrCreateRecipeInsight } from '../memory-schema.js';
import {
  handleAuditExportEstimate,
  handleAuditExportPage,
  makeAuditExportHandlers,
} from '../audit-export-handler.js';

const mkEntry = (
  run_id: string,
  recipe_id: string,
  recipe_hash: string,
  started_at: number,
): AuditEntry => buildAuditEntry({
  run_id,
  recipe_id,
  recipe_hash,
  // buildAuditEntry derives started_at = now - duration_ms; using
  // duration_ms=0 + now=started_at pins both to `started_at`.
  now: started_at,
  duration_ms: 0,
  commit_status: 'succeeded',
  config_snapshot: {},
  errors: [],
  trigger_url: null,
  trigger_source: 'manual',
  instance_id: 'ext-test',
});

const mkDeps = async () => {
  const db = new Database(':memory:');
  // ensureMemorySchema's audit-side indexes presume the `audit_entries`
  // table already exists (production wires the SQLite-backed audit
  // collection FIRST in `bin.ts`). The test path uses an in-memory
  // audit collection so the deps shape mirrors production but skips
  // SQL audit storage; create the audit_entries table by hand so the
  // memory-schema indexes bind cleanly.
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_entries (key TEXT PRIMARY KEY, data TEXT NOT NULL);
  `);
  ensureMemorySchema(db);
  const auditLog: AuditLogStore = createAuditLogStore(
    createInMemoryCollection(),
    createInMemoryCollection(),
  );
  return {
    db,
    auditLog,
    serverInstanceId: 'srv-test-1',
  };
};

describe('audit.export.estimate', () => {
  let deps: Awaited<ReturnType<typeof mkDeps>>;
  beforeEach(async () => {
    deps = await mkDeps();
  });

  it('returns the count of entries matching the filter', async () => {
    await deps.auditLog.append(mkEntry('r1', 'recipe-a', 'h1', 100));
    await deps.auditLog.append(mkEntry('r2', 'recipe-a', 'h1', 200));
    await deps.auditLog.append(mkEntry('r3', 'recipe-b', 'h2', 150));

    const est = await handleAuditExportEstimate(deps, {});
    expect(est.entry_count).toBe(3);
    expect(est.estimated_bytes).toBeGreaterThan(0);
  });

  it('honours the recipe_id filter', async () => {
    await deps.auditLog.append(mkEntry('r1', 'recipe-a', 'h1', 100));
    await deps.auditLog.append(mkEntry('r2', 'recipe-b', 'h2', 200));

    const est = await handleAuditExportEstimate(deps, { recipe_id: 'recipe-a' });
    expect(est.entry_count).toBe(1);
  });

  it('honours since/until bounds', async () => {
    await deps.auditLog.append(mkEntry('r1', 'recipe-a', 'h1', 100));
    await deps.auditLog.append(mkEntry('r2', 'recipe-a', 'h1', 200));
    await deps.auditLog.append(mkEntry('r3', 'recipe-a', 'h1', 300));

    const est = await handleAuditExportEstimate(deps, { since: 150, until: 250 });
    expect(est.entry_count).toBe(1);
  });

  it('rejects since > until', async () => {
    await expect(
      handleAuditExportEstimate(deps, { since: 200, until: 100 }),
    ).rejects.toThrow(/since must be <=/);
  });
});

describe('audit.export.page — envelope', () => {
  let deps: Awaited<ReturnType<typeof mkDeps>>;
  beforeEach(async () => {
    deps = await mkDeps();
  });

  it('emits envelope with scope=server + serverInstanceId on first page', async () => {
    await deps.auditLog.append(mkEntry('r1', 'recipe-a', 'h1', 100));
    const page = await handleAuditExportPage(deps, { format: 'json' });
    expect(page.envelope).toBeDefined();
    expect(page.envelope!.scope).toBe('server');
    expect(page.envelope!.instance_id).toBe('srv-test-1');
    expect(page.envelope!.format).toBe('json');
  });

  it('joins recipe_insights from the SQLite table into the envelope', async () => {
    // Seed a recipe_insights row, then append an audit entry whose
    // recipe_hash matches.
    getOrCreateRecipeInsight(deps.db, {
      hash: 'h1',
      slug: 'recipe-a',
      version: 1,
      flattened: JSON.stringify({ steps: [{ id: 'step-1' }] }),
      created_at: 0,
    });
    await deps.auditLog.append(mkEntry('r1', 'recipe-a', 'h1', 100));

    const page = await handleAuditExportPage(deps, { format: 'json' });
    expect(page.envelope!.recipe_insights['h1']).toBeDefined();
    expect(page.envelope!.recipe_insights['h1']!.slug).toBe('recipe-a');
    expect((page.envelope!.recipe_insights['h1']!.flattened as { steps: Array<unknown> }).steps)
      .toHaveLength(1);
  });

  it('joins link rows from the SQLite table per entry', async () => {
    const insightId = getOrCreateRecipeInsight(deps.db, {
      hash: 'h1', slug: 'recipe-a', version: 1, flattened: '{}', created_at: 0,
    });
    await deps.auditLog.append(mkEntry('r1', 'recipe-a', 'h1', 100));
    deps.db.prepare(
      `INSERT INTO links (memory_id, entity_id, recipe_insight_id, kind, ts)
         VALUES (?, ?, ?, ?, ?)`,
    ).run('r1', 'mail:msg-1', insightId, 'execution.action', 105);

    const page = await handleAuditExportPage(deps, { format: 'json' });
    const parsed = JSON.parse(`[${page.body}]`);
    expect(parsed[0].links).toHaveLength(1);
    expect(parsed[0].links[0].entity_id).toBe('mail:msg-1');
    expect(parsed[0].links[0].kind).toBe('execution.action');
  });
});

describe('audit.export.page — pagination', () => {
  let deps: Awaited<ReturnType<typeof mkDeps>>;
  beforeEach(async () => {
    deps = await mkDeps();
  });

  it('streams pages in descending started_at order', async () => {
    for (let i = 0; i < 5; i += 1) {
      await deps.auditLog.append(mkEntry(`r${i}`, 'recipe-a', 'h1', i * 10));
    }
    const collected: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await handleAuditExportPage(deps, {
        format: 'json',
        page_size: 2,
        ...(cursor ? { cursor } : {}),
      });
      const parsed = JSON.parse(`[${page.body}]`);
      for (const e of parsed) collected.push(e.id);
      cursor = page.next_cursor;
      pages += 1;
      if (pages > 10) throw new Error('runaway pagination');
    } while (cursor);
    expect(collected).toEqual(['r4', 'r3', 'r2', 'r1', 'r0']);
  });
});

describe('audit.export.page — audit ledger', () => {
  let deps: Awaited<ReturnType<typeof mkDeps>>;
  beforeEach(async () => {
    deps = await mkDeps();
  });

  it('logs an audit_export activity on the first page', async () => {
    await deps.auditLog.append(mkEntry('r1', 'recipe-a', 'h1', 100));
    await handleAuditExportPage(deps, { format: 'json' });
    const acts = await deps.auditLog.listActivities(10);
    expect(acts.some((a) => a.action === 'audit_export')).toBe(true);
  });

  it('does NOT re-log on subsequent pages', async () => {
    for (let i = 0; i < 3; i += 1) {
      await deps.auditLog.append(mkEntry(`r${i}`, 'recipe-a', 'h1', i * 10));
    }
    const page1 = await handleAuditExportPage(deps, { format: 'json', page_size: 1 });
    const acts1 = (await deps.auditLog.listActivities(10))
      .filter((a) => a.action === 'audit_export').length;
    await handleAuditExportPage(deps, {
      format: 'json', page_size: 1, cursor: page1.next_cursor,
    });
    const acts2 = (await deps.auditLog.listActivities(10))
      .filter((a) => a.action === 'audit_export').length;
    expect(acts2).toBe(acts1); // unchanged — only first page logs
  });
});

describe('audit.export validation', () => {
  let deps: Awaited<ReturnType<typeof mkDeps>>;
  beforeEach(async () => {
    deps = await mkDeps();
  });

  it('rejects bad format', async () => {
    await expect(
      handleAuditExportPage(deps, { format: 'xml' as 'json' }),
    ).rejects.toThrow(/format must be one of/);
  });

  it('rejects empty recipe_id', async () => {
    await expect(
      handleAuditExportPage(deps, { recipe_id: '' }),
    ).rejects.toThrow(/recipe_id/);
  });
});

describe('makeAuditExportHandlers', () => {
  it('returns undefined when deps absent', () => {
    expect(makeAuditExportHandlers(undefined)).toBeUndefined();
  });

  it('declares both estimate + page methods', async () => {
    const deps = await mkDeps();
    const slice = makeAuditExportHandlers(deps);
    expect(slice).toBeDefined();
    expect(slice!.methods).toContain('audit.export.estimate');
    expect(slice!.methods).toContain('audit.export.page');
  });
});

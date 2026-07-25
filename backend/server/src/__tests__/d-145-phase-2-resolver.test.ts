/** D-145 PA2 — Source primitive resolver + default-Source memory.
 *
 *  Storage-layer extensions (`getDefaultSource` / `setDefaultSource` /
 *  `clearDefaultSource` + `listByKind`) and the substrate-level
 *  `WorkEntityResolver` facade (polymorphic + scoped reads, snapshot
 *  helpers, typed errors). */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RECUED_BUILTIN_SOURCE_ID,
  CONNECTION_SOURCE_ID,
  WORK_ENTITY_KINDS,
} from '@recued/contracts';

import {
  WORK_ENTITY_DEFAULT_SOURCE_TABLE,
  WorkEntityValidationError,
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import {
  WorkEntityResolverError,
  createWorkEntityResolver,
} from '../work-entity-resolver.js';

let dir: string;
let db: Database.Database;
let store: WorkEntityStore;

const NOW = 1_700_000_000_000;

const registerBuiltins = (s: WorkEntityStore): void => {
  for (const kind of WORK_ENTITY_KINDS) {
    s.registerSource({
      id: RECUED_BUILTIN_SOURCE_ID(kind),
      top_tier_kind: kind,
      source_kind: 'builtin',
      source_label: 'Recued built-in',
      write_capable: true,
      mcp_exposed: false,
      registered_at: NOW,
    });
  }
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd145-pa2-resolver-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureWorkEntitySchema(db);
  store = createWorkEntityStore(db);
  registerBuiltins(store);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────
// Schema — the new default-Source table lands at boot
// ────────────────────────────────────────────────────────────────

describe('PA2 schema', () => {
  it('creates the work_entity_default_source table', () => {
    const row = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
      )
      .get(WORK_ENTITY_DEFAULT_SOURCE_TABLE);
    expect(row).toBeDefined();
  });

  it('default-source FK cascades on Source unregister', () => {
    store.setDefaultSource('task', RECUED_BUILTIN_SOURCE_ID('task'), NOW);
    expect(store.getDefaultSource('task')).toBe(RECUED_BUILTIN_SOURCE_ID('task'));
    store.unregisterSource(RECUED_BUILTIN_SOURCE_ID('task'));
    expect(store.getDefaultSource('task')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// Default-Source memory — § A.2.2
// ────────────────────────────────────────────────────────────────

describe('default-Source memory', () => {
  it('returns null before anything is pinned', () => {
    for (const kind of WORK_ENTITY_KINDS) {
      expect(store.getDefaultSource(kind)).toBeNull();
    }
  });

  it('round-trips set → get per kind', () => {
    for (const kind of WORK_ENTITY_KINDS) {
      const id = RECUED_BUILTIN_SOURCE_ID(kind);
      store.setDefaultSource(kind, id, NOW);
      expect(store.getDefaultSource(kind)).toBe(id);
    }
  });

  it('per-kind isolation — pinning task does not affect note', () => {
    store.setDefaultSource('task', RECUED_BUILTIN_SOURCE_ID('task'), NOW);
    expect(store.getDefaultSource('note')).toBeNull();
    expect(store.getDefaultSource('commitment')).toBeNull();
    expect(store.getDefaultSource('project')).toBeNull();
  });

  it('overwrites on second set', () => {
    store.registerSource({
      id: 'hubspot.acme.task',
      top_tier_kind: 'task',
      source_kind: 'connection',
      source_label: 'HubSpot tasks (acme)',
      write_capable: true,
      mcp_exposed: false,
      registered_at: NOW,
    });
    store.setDefaultSource('task', RECUED_BUILTIN_SOURCE_ID('task'), NOW);
    store.setDefaultSource('task', 'hubspot.acme.task', NOW + 1);
    expect(store.getDefaultSource('task')).toBe('hubspot.acme.task');
  });

  it('clear removes the pin', () => {
    store.setDefaultSource('task', RECUED_BUILTIN_SOURCE_ID('task'), NOW);
    expect(store.clearDefaultSource('task')).toBe(true);
    expect(store.getDefaultSource('task')).toBeNull();
  });

  it('clear returns false when nothing was pinned', () => {
    expect(store.clearDefaultSource('task')).toBe(false);
  });

  it('rejects unknown source_id', () => {
    expect(() =>
      store.setDefaultSource('task', 'recued.nope', NOW),
    ).toThrow(WorkEntityValidationError);
  });

  it('rejects kind/Source mismatch (task pinning note Source)', () => {
    expect(() =>
      store.setDefaultSource('task', RECUED_BUILTIN_SOURCE_ID('note'), NOW),
    ).toThrow(/note/);
  });

  it('rejects unknown kind', () => {
    expect(() =>
      store.setDefaultSource('mail_message' as never, 'recued.task', NOW),
    ).toThrow(WorkEntityValidationError);
    expect(() => store.getDefaultSource('mail_message' as never)).toThrow(
      WorkEntityValidationError,
    );
    expect(() => store.clearDefaultSource('mail_message' as never)).toThrow(
      WorkEntityValidationError,
    );
  });

  it('rejects empty source_id', () => {
    expect(() => store.setDefaultSource('task', '', NOW)).toThrow(
      WorkEntityValidationError,
    );
  });
});

// ────────────────────────────────────────────────────────────────
// listByKind — store-level polymorphic + scoped read
// ────────────────────────────────────────────────────────────────

describe('store.listByKind', () => {
  beforeEach(() => {
    // Seed two task Sources, one task each, so list union returns both.
    store.registerSource({
      id: 'hubspot.acme.task',
      top_tier_kind: 'task',
      source_kind: 'connection',
      source_label: 'HubSpot tasks (acme)',
      write_capable: true,
      mcp_exposed: false,
      registered_at: NOW,
    });
    store.writeTask({ source_id: 'recued.task', title: 'local-task' }, NOW);
    store.writeTask({ source_id: 'hubspot.acme.task', title: 'remote-task' }, NOW);
  });

  it('polymorphic — unions rows across Sources', () => {
    const rows = store.listByKind('task');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r._kind === 'task')).toBe(true);
    const titles = rows.map((r) => (r as { title: string }).title).sort();
    expect(titles).toEqual(['local-task', 'remote-task']);
  });

  it('scoped via query.source_id — only that Source', () => {
    const rows = store.listByKind('task', { source_id: 'recued.task' });
    expect(rows).toHaveLength(1);
    expect((rows[0] as { title: string }).title).toBe('local-task');
  });

  it('rejects unknown kind', () => {
    expect(() => store.listByKind('mail_message' as never)).toThrow(
      WorkEntityValidationError,
    );
  });

  it('returns empty when no rows match', () => {
    expect(
      store.listByKind('task', { source_id: 'recued.note' }),
    ).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────
// WorkEntityResolver — substrate facade
// ────────────────────────────────────────────────────────────────

describe('createWorkEntityResolver', () => {
  beforeEach(() => {
    store.registerSource({
      id: 'hubspot.acme.task',
      top_tier_kind: 'task',
      source_kind: 'connection',
      source_label: 'HubSpot tasks (acme)',
      write_capable: true,
      mcp_exposed: false,
      registered_at: NOW,
    });
    store.writeTask({ source_id: 'recued.task', title: 'local-task' }, NOW);
    store.writeTask(
      { source_id: 'hubspot.acme.task', title: 'remote-task' },
      NOW,
    );
    store.writeNote({ source_id: 'recued.note', body: 'note body' }, NOW);
  });

  it('listByKind delegates polymorphic union read', () => {
    const r = createWorkEntityResolver(store);
    expect(r.listByKind('task')).toHaveLength(2);
    expect(r.listByKind('note')).toHaveLength(1);
    expect(r.listByKind('commitment')).toHaveLength(0);
  });

  it('listByKindScoped restricts to one Source', () => {
    const r = createWorkEntityResolver(store);
    const rows = r.listByKindScoped('task', 'recued.task');
    expect(rows).toHaveLength(1);
    expect((rows[0] as { title: string }).title).toBe('local-task');
  });

  it('listByKindScoped errors on unknown source_id', () => {
    const r = createWorkEntityResolver(store);
    expect(() => r.listByKindScoped('task', 'recued.nope')).toThrow(
      WorkEntityResolverError,
    );
  });

  it('listByKindScoped errors with kind_source_mismatch', () => {
    const r = createWorkEntityResolver(store);
    let caught: unknown;
    try {
      r.listByKindScoped('task', RECUED_BUILTIN_SOURCE_ID('note'));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WorkEntityResolverError);
    expect((caught as WorkEntityResolverError).code).toBe('kind_source_mismatch');
  });

  it('listByKind errors on unknown_kind', () => {
    const r = createWorkEntityResolver(store);
    let caught: unknown;
    try {
      r.listByKind('mail_message' as never);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WorkEntityResolverError);
    expect((caught as WorkEntityResolverError).code).toBe('unknown_kind');
  });

  it('readEntity dispatches by kind', () => {
    const r = createWorkEntityResolver(store);
    const tasks = r.listByKind('task');
    const t0 = tasks[0]!;
    const fetched = r.readEntity('task', t0.id);
    expect(fetched).not.toBeNull();
    expect(fetched!._kind).toBe('task');
    expect(fetched!.id).toBe(t0.id);
  });

  it('readEntity returns null for unknown id', () => {
    const r = createWorkEntityResolver(store);
    expect(r.readEntity('task', 'no-such-id')).toBeNull();
  });

  // Codex P2 fold — readEntity must not surface tombstoned rows
  it('readEntity hides tombstoned rows (Codex P2 fold)', () => {
    const r = createWorkEntityResolver(store);
    const t = store.writeTask(
      { source_id: 'recued.task', title: 'doomed' },
      NOW,
    );
    expect(r.readEntity('task', t.id)).not.toBeNull();
    store.deleteTask(t.id, { tombstone: true, now: NOW });
    expect(r.readEntity('task', t.id)).toBeNull();
  });

  // Codex P2 fold — readEntity must not surface orphaned rows
  it('readEntity hides orphaned rows (Codex P2 fold)', () => {
    const r = createWorkEntityResolver(store);
    store.registerSource({
      id: 'hubspot.transient.task',
      top_tier_kind: 'task',
      source_kind: 'connection',
      source_label: 'HubSpot tasks (transient)',
      write_capable: false,
      mcp_exposed: false,
      registered_at: NOW,
    });
    const t = store.writeTask(
      { source_id: 'hubspot.transient.task', title: 'gone' },
      NOW,
    );
    expect(r.readEntity('task', t.id)).not.toBeNull();
    store.unregisterSource('hubspot.transient.task');
    expect(r.readEntity('task', t.id)).toBeNull();
  });

  it('listSources delegates to the store', () => {
    const r = createWorkEntityResolver(store);
    const taskSources = r.listSources('task');
    expect(taskSources).toHaveLength(2);
    const all = r.listSources();
    expect(all.length).toBe(WORK_ENTITY_KINDS.length + 1); // 4 builtins + 1 hubspot
  });

  it('default-Source memory passthrough', () => {
    const r = createWorkEntityResolver(store);
    expect(r.getDefaultSource('task')).toBeNull();
    r.setDefaultSource('task', RECUED_BUILTIN_SOURCE_ID('task'), NOW);
    expect(r.getDefaultSource('task')).toBe(RECUED_BUILTIN_SOURCE_ID('task'));
    expect(r.clearDefaultSource('task')).toBe(true);
    expect(r.getDefaultSource('task')).toBeNull();
  });

  it('setDefaultSource wraps storage error in resolver error', () => {
    const r = createWorkEntityResolver(store);
    let caught: unknown;
    try {
      r.setDefaultSource('task', 'recued.nope', NOW);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WorkEntityResolverError);
    expect((caught as WorkEntityResolverError).code).toBe('unknown_source');
  });

  it('setDefaultSource wraps kind_source_mismatch', () => {
    const r = createWorkEntityResolver(store);
    let caught: unknown;
    try {
      r.setDefaultSource('task', RECUED_BUILTIN_SOURCE_ID('note'), NOW);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WorkEntityResolverError);
    expect((caught as WorkEntityResolverError).code).toBe('kind_source_mismatch');
  });

  it('snapshotByKind returns flat id-keyed map', () => {
    const r = createWorkEntityResolver(store);
    const snap = r.snapshotByKind('task');
    expect(Object.keys(snap)).toHaveLength(2);
    for (const [id, row] of Object.entries(snap)) {
      expect(row.id).toBe(id);
      expect(row._kind).toBe('task');
    }
  });

  it('snapshotByKindScoped restricts to one Source', () => {
    const r = createWorkEntityResolver(store);
    const snap = r.snapshotByKindScoped('task', 'recued.task');
    expect(Object.keys(snap)).toHaveLength(1);
    expect(Object.values(snap)[0]!._kind).toBe('task');
  });

  it('snapshotByKindScoped uses prototype-null map', () => {
    const r = createWorkEntityResolver(store);
    const snap = r.snapshotByKind('task');
    expect(Object.getPrototypeOf(snap)).toBeNull();
  });

  it('WorkEntityResolverError carries source_id + kind detail', () => {
    const e = new WorkEntityResolverError('unknown_source', 'msg', {
      source_id: 'x',
      kind: 'task',
    });
    expect(e.code).toBe('unknown_source');
    expect(e.source_id).toBe('x');
    expect(e.kind).toBe('task');
    expect(e.name).toBe('WorkEntityResolverError');
  });
});

// ────────────────────────────────────────────────────────────────
// CONNECTION_SOURCE_ID format — substrate-level invariant
// ────────────────────────────────────────────────────────────────

describe('CONNECTION_SOURCE_ID', () => {
  it('formats hubspot.<conn>.task per § A.2', () => {
    expect(CONNECTION_SOURCE_ID('hubspot', 'acme', 'task')).toBe(
      'hubspot.acme.task',
    );
  });
  it('formats salesforce.<conn>.task per § A.2', () => {
    expect(CONNECTION_SOURCE_ID('salesforce', 'prod', 'task')).toBe(
      'salesforce.prod.task',
    );
  });
});

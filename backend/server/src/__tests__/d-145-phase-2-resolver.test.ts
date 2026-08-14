/** D-145 PA2 — Source primitive resolver + default-Source memory.
 *
 *  ⛔ The default-Source family is DELETED (D-187 Sources half). Formerly (`getDefaultSource` / `setDefaultSource` /
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

/* ⛔ The `PA2 schema` (work_entity_default_source table + its FK cascade) and
 *  `default-Source memory` suites are DELETED (D-187 Sources half). The table
 *  and the whole get/set/clear family are gone: write routing is
 *  `explicit source_id ?? built-in local`, so there is no pin to round-trip,
 *  isolate per kind, or validate against a Source registration. */

describe('store.listByKind', () => {
  beforeEach(() => {
    // Seed two task Sources, one task each, so list union returns both.
    store.registerSource({
      id: 'hubspot.acme.task',
      top_tier_kind: 'task',
      source_kind: 'connection',
      source_label: 'HubSpot tasks (acme)',
      write_capable: true,
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

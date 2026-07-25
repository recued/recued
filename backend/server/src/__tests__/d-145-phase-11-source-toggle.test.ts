/** D-145 PA11 — Settings → Work Entities Source management.
 *
 *  Storage-layer + resolver tests:
 *    - `enabled` field round-trip on `source_registry`
 *    - `setSourceEnabled` / `setSourceMcpExposed` write paths
 *    - polymorphic `listByKind` excludes disabled-Source rows by default
 *    - explicit `source_id` scope bypasses the disabled filter
 *    - `include_disabled: true` opt-in returns disabled-Source rows
 *    - `registerSource` UPSERT preserves the user's `enabled` toggle
 *    - missing-Source writes raise `SourceRegistrationError`
 */

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
  SOURCE_REGISTRY_TABLE,
  SourceRegistrationError,
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';

let dir: string;
let db: Database.Database;
let store: WorkEntityStore;

const NOW = 1_700_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd145-pa11-source-toggle-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureWorkEntitySchema(db);
  store = createWorkEntityStore(db);
  for (const kind of WORK_ENTITY_KINDS) {
    store.registerSource({
      id: RECUED_BUILTIN_SOURCE_ID(kind),
      top_tier_kind: kind,
      source_kind: 'builtin',
      source_label: 'Recued built-in',
      write_capable: true,
      mcp_exposed: false,
      registered_at: NOW,
    });
  }
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────
// Schema — the `enabled` column lands at boot
// ────────────────────────────────────────────────────────────────

describe('PA11 schema', () => {
  it('source_registry carries an `enabled` column with default 1', () => {
    const cols = db
      .prepare(`PRAGMA table_info(${SOURCE_REGISTRY_TABLE})`)
      .all() as Array<{ name: string; dflt_value: string | null }>;
    const enabledCol = cols.find((c) => c.name === 'enabled');
    expect(enabledCol).toBeDefined();
    // SQLite stringifies the default literal `1` as the string '1'.
    expect(enabledCol?.dflt_value).toBe('1');
  });

  it('idempotent boot does not error on `enabled` re-add', () => {
    // Calling ensureWorkEntitySchema again on the same db must not
    // throw "duplicate column name: enabled" — the boot path swallows
    // that single error so re-init stays safe.
    expect(() => ensureWorkEntitySchema(db)).not.toThrow();
  });

  it('newly-registered Sources default to enabled=true', () => {
    const reg = store.getSource(RECUED_BUILTIN_SOURCE_ID('task'));
    expect(reg).not.toBeNull();
    expect(reg?.enabled).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// `setSourceEnabled` / `setSourceMcpExposed`
// ────────────────────────────────────────────────────────────────

describe('PA11 toggle writers', () => {
  it('setSourceEnabled flips the column and round-trips through getSource', () => {
    const id = RECUED_BUILTIN_SOURCE_ID('task');
    const after_disable = store.setSourceEnabled(id, false);
    expect(after_disable.enabled).toBe(false);
    const re_read = store.getSource(id);
    expect(re_read?.enabled).toBe(false);

    const after_enable = store.setSourceEnabled(id, true);
    expect(after_enable.enabled).toBe(true);
  });

  it('setSourceMcpExposed flips the column and round-trips', () => {
    const id = RECUED_BUILTIN_SOURCE_ID('note');
    expect(store.getSource(id)?.mcp_exposed).toBe(false);
    const after = store.setSourceMcpExposed(id, true);
    expect(after.mcp_exposed).toBe(true);
    expect(store.getSource(id)?.mcp_exposed).toBe(true);
  });

  it('setSourceEnabled raises on unregistered source_id', () => {
    expect(() => store.setSourceEnabled('does.not.exist', false)).toThrow(
      SourceRegistrationError,
    );
  });

  it('setSourceMcpExposed raises on unregistered source_id', () => {
    expect(() => store.setSourceMcpExposed('does.not.exist', true)).toThrow(
      SourceRegistrationError,
    );
  });

  it('setSourceEnabled rejects non-boolean argument', () => {
    const id = RECUED_BUILTIN_SOURCE_ID('task');
    // @ts-expect-error — runtime guard
    expect(() => store.setSourceEnabled(id, 'yes')).toThrow(
      SourceRegistrationError,
    );
  });
});

// ────────────────────────────────────────────────────────────────
// Polymorphic-list disabled filter
// ────────────────────────────────────────────────────────────────

describe('PA11 polymorphic-list disabled filter', () => {
  it('listByKind excludes disabled-Source rows by default', () => {
    const taskBuiltin = RECUED_BUILTIN_SOURCE_ID('task');
    const hubspotTask = CONNECTION_SOURCE_ID('hubspot', 'conn-42', 'task');
    store.registerSource({
      id: hubspotTask,
      top_tier_kind: 'task',
      source_kind: 'connection',
      source_label: 'HubSpot Tasks (conn-42)',
      write_capable: true,
      mcp_exposed: false,
      registered_at: NOW,
    });
    // One task per Source.
    store.writeTask({ title: 'Recued task', source_id: taskBuiltin });
    store.writeTask({
      title: 'HubSpot task',
      source_id: hubspotTask,
      source_record_id: 'hub-1',
    });
    expect(store.listByKind('task')).toHaveLength(2);

    // Disable HubSpot Source — its row drops out of polymorphic reads.
    store.setSourceEnabled(hubspotTask, false);
    const list_after_disable = store.listTasks();
    expect(list_after_disable).toHaveLength(1);
    expect(list_after_disable[0]?.title).toBe('Recued task');
  });

  it('explicit source_id scope honors disable; include_disabled escapes', () => {
    // D-145 PA11 Codex P2 fold (finding 3) — explicit
    // `data.<kind>.<source_id>.*` reads also honor the disabled
    // filter so a user toggle isn't silently bypassed by a recipe
    // that happens to scope to the disabled Source. Admin / debug
    // surfaces opt out via `include_disabled: true`.
    const hubspotTask = CONNECTION_SOURCE_ID('hubspot', 'conn-42', 'task');
    store.registerSource({
      id: hubspotTask,
      top_tier_kind: 'task',
      source_kind: 'connection',
      source_label: 'HubSpot Tasks (conn-42)',
      write_capable: true,
      mcp_exposed: false,
      registered_at: NOW,
    });
    store.writeTask({
      title: 'HubSpot task',
      source_id: hubspotTask,
      source_record_id: 'hub-2',
    });
    store.setSourceEnabled(hubspotTask, false);
    // Default polymorphic read excludes the disabled row.
    expect(store.listByKind('task')).toHaveLength(0);
    // Explicit scope ALSO excludes (PA11 Codex P2 fold).
    expect(store.listTasks({ source_id: hubspotTask })).toHaveLength(0);
    // `include_disabled: true` opt-in returns the row even with
    // explicit scope (admin / debug).
    const scoped = store.listTasks({
      source_id: hubspotTask,
      include_disabled: true,
    });
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.title).toBe('HubSpot task');
  });

  it('include_disabled: true opt-in returns disabled-Source rows', () => {
    const hubspotTask = CONNECTION_SOURCE_ID('hubspot', 'conn-42', 'task');
    store.registerSource({
      id: hubspotTask,
      top_tier_kind: 'task',
      source_kind: 'connection',
      source_label: 'HubSpot Tasks (conn-42)',
      write_capable: true,
      mcp_exposed: false,
      registered_at: NOW,
    });
    store.writeTask({
      title: 'HubSpot task',
      source_id: hubspotTask,
      source_record_id: 'hub-3',
    });
    store.setSourceEnabled(hubspotTask, false);
    expect(store.listByKind('task')).toHaveLength(0);
    expect(store.listByKind('task', { include_disabled: true })).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────
// Boot-wire UPSERT idempotency — user toggle survives re-register
// ────────────────────────────────────────────────────────────────

describe('PA11 registerSource UPSERT preserves enabled', () => {
  it('re-registering a disabled Source does NOT silently re-enable', () => {
    const id = RECUED_BUILTIN_SOURCE_ID('task');
    store.setSourceEnabled(id, false);
    expect(store.getSource(id)?.enabled).toBe(false);
    // Boot wire re-registers — must NOT flip `enabled` back to true.
    const after_register = store.registerSource({
      id,
      top_tier_kind: 'task',
      source_kind: 'builtin',
      source_label: 'Recued built-in',
      write_capable: true,
      mcp_exposed: false,
      registered_at: NOW,
    });
    expect(after_register.enabled).toBe(false);
    expect(store.getSource(id)?.enabled).toBe(false);
  });

  it('first-registration enabled flag honors caller-supplied value', () => {
    const fresh = CONNECTION_SOURCE_ID('hubspot', 'conn-99', 'task');
    const reg = store.registerSource({
      id: fresh,
      top_tier_kind: 'task',
      source_kind: 'connection',
      source_label: 'HubSpot Tasks (conn-99)',
      write_capable: true,
      mcp_exposed: false,
      enabled: false,
      registered_at: NOW,
    });
    expect(reg.enabled).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// Resolver passthrough
// ────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────
// Codex P1 fold (finding 5) — default-Source × disabled invariants
// ────────────────────────────────────────────────────────────────

describe('PA11 default-Source × disabled invariants', () => {
  it('setDefaultSource rejects pinning a disabled Source', () => {
    const id = RECUED_BUILTIN_SOURCE_ID('task');
    store.setSourceEnabled(id, false);
    expect(() => store.setDefaultSource('task', id)).toThrow(
      /disabled/i,
    );
  });

  it('disabling a Source auto-clears any pinned default that points at it', () => {
    const id = RECUED_BUILTIN_SOURCE_ID('task');
    store.setDefaultSource('task', id);
    expect(store.getDefaultSource('task')).toBe(id);
    store.setSourceEnabled(id, false);
    expect(store.getDefaultSource('task')).toBeNull();
  });

  it('disabling a Source does NOT clear other kinds defaults', () => {
    const taskId = RECUED_BUILTIN_SOURCE_ID('task');
    const noteId = RECUED_BUILTIN_SOURCE_ID('note');
    store.setDefaultSource('task', taskId);
    store.setDefaultSource('note', noteId);
    store.setSourceEnabled(taskId, false);
    expect(store.getDefaultSource('task')).toBeNull();
    expect(store.getDefaultSource('note')).toBe(noteId);
  });

  it('re-enabling a Source does NOT auto-restore the cleared default', () => {
    // Once cleared, the default stays cleared. Re-enabling is a
    // separate user action; pinning the default again is also a
    // separate user action.
    const id = RECUED_BUILTIN_SOURCE_ID('task');
    store.setDefaultSource('task', id);
    store.setSourceEnabled(id, false);
    store.setSourceEnabled(id, true);
    expect(store.getDefaultSource('task')).toBeNull();
  });
});

describe('PA11 resolver passthrough', () => {
  it('listSources surfaces every Source including disabled (Settings UI)', () => {
    const id = RECUED_BUILTIN_SOURCE_ID('task');
    store.setSourceEnabled(id, false);
    const resolver = createWorkEntityResolver(store);
    const sources = resolver.listSources('task');
    const disabled_in_list = sources.find((s) => s.id === id);
    expect(disabled_in_list).toBeDefined();
    expect(disabled_in_list?.enabled).toBe(false);
  });

  it('resolver setSourceEnabled / setSourceMcpExposed pass through', () => {
    const id = RECUED_BUILTIN_SOURCE_ID('task');
    const resolver = createWorkEntityResolver(store);
    const after_disable = resolver.setSourceEnabled(id, false);
    expect(after_disable.enabled).toBe(false);
    const after_mcp = resolver.setSourceMcpExposed(id, true);
    expect(after_mcp.mcp_exposed).toBe(true);
  });

  it('resolver listByKind honors the disabled filter', () => {
    const taskBuiltin = RECUED_BUILTIN_SOURCE_ID('task');
    const hubspotTask = CONNECTION_SOURCE_ID('hubspot', 'conn-42', 'task');
    store.registerSource({
      id: hubspotTask,
      top_tier_kind: 'task',
      source_kind: 'connection',
      source_label: 'HubSpot Tasks (conn-42)',
      write_capable: true,
      mcp_exposed: false,
      registered_at: NOW,
    });
    store.writeTask({ title: 'Recued task', source_id: taskBuiltin });
    store.writeTask({
      title: 'HubSpot task',
      source_id: hubspotTask,
      source_record_id: 'hub-r',
    });
    store.setSourceEnabled(hubspotTask, false);
    const resolver = createWorkEntityResolver(store);
    expect(resolver.listByKind('task')).toHaveLength(1);
  });
});

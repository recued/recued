/** D-145 PA11 — `work_entity.source.*` rpc handler tests.
 *
 *  Covers list / set_enabled / set_mcp_exposed / set_default /
 *  clear_default round-trips against an in-memory store + resolver.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RECUED_BUILTIN_SOURCE_ID,
  RpcError,
  WORK_ENTITY_KINDS,
} from '@recued/contracts';

import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import {
  handleWorkEntitySourceClearDefault,
  handleWorkEntitySourceList,
  handleWorkEntitySourceSetDefault,
  handleWorkEntitySourceSetEnabled,
  handleWorkEntitySourceSetMcpExposed,
  makeWorkEntitySourceHandlers,
  type WorkEntitySourceRpcDeps,
} from '../work-entity-source-handler.js';

let dir: string;
let db: Database.Database;
let store: WorkEntityStore;
let deps: WorkEntitySourceRpcDeps;

const NOW = 1_700_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd145-pa11-handler-'));
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
  deps = { resolver: createWorkEntityResolver(store) };
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('PA11 work_entity.source.list', () => {
  it('returns every registered Source + per-kind defaults map', async () => {
    store.setDefaultSource('task', RECUED_BUILTIN_SOURCE_ID('task'));
    const out = await handleWorkEntitySourceList(deps);
    expect(out.sources).toHaveLength(WORK_ENTITY_KINDS.length);
    expect(out.defaults_by_kind.task).toBe(RECUED_BUILTIN_SOURCE_ID('task'));
    expect(out.defaults_by_kind.note).toBeUndefined();
  });

  it('omits per-kind entries with no default pinned', async () => {
    const out = await handleWorkEntitySourceList(deps);
    expect(out.defaults_by_kind).toEqual({});
  });
});

describe('PA11 work_entity.source.set_enabled', () => {
  it('flips the column and returns the post-write row', async () => {
    const id = RECUED_BUILTIN_SOURCE_ID('task');
    const out = await handleWorkEntitySourceSetEnabled(deps, {
      source_id: id,
      enabled: false,
    });
    expect(out.ok).toBe(true);
    expect(out.effective.enabled).toBe(false);
    expect(out.effective.id).toBe(id);
  });

  it('rejects missing source_id with bad_request', async () => {
    await expect(
      handleWorkEntitySourceSetEnabled(deps, {
        source_id: '',
        enabled: false,
      }),
    ).rejects.toThrow(RpcError);
  });

  it('rejects unknown source_id with not_found', async () => {
    await expect(
      handleWorkEntitySourceSetEnabled(deps, {
        source_id: 'does.not.exist',
        enabled: false,
      }),
    ).rejects.toMatchObject({
      name: 'RpcError',
      code: 'not_found',
    });
  });

  it('rejects non-boolean enabled with bad_request', async () => {
    await expect(
      handleWorkEntitySourceSetEnabled(deps, {
        source_id: RECUED_BUILTIN_SOURCE_ID('task'),
        // @ts-expect-error — runtime guard
        enabled: 'yes',
      }),
    ).rejects.toMatchObject({
      name: 'RpcError',
      code: 'bad_request',
    });
  });
});

describe('PA11 work_entity.source.set_mcp_exposed', () => {
  it('flips the column and returns the post-write row', async () => {
    const id = RECUED_BUILTIN_SOURCE_ID('note');
    const out = await handleWorkEntitySourceSetMcpExposed(deps, {
      source_id: id,
      mcp_exposed: true,
    });
    expect(out.ok).toBe(true);
    expect(out.effective.mcp_exposed).toBe(true);
  });

  it('rejects unknown source_id with not_found', async () => {
    await expect(
      handleWorkEntitySourceSetMcpExposed(deps, {
        source_id: 'does.not.exist',
        mcp_exposed: true,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('PA11 work_entity.source.set_default', () => {
  it('pins a per-kind default Source', async () => {
    const out = await handleWorkEntitySourceSetDefault(deps, {
      kind: 'task',
      source_id: RECUED_BUILTIN_SOURCE_ID('task'),
    });
    expect(out.ok).toBe(true);
    expect(deps.resolver.getDefaultSource('task')).toBe(
      RECUED_BUILTIN_SOURCE_ID('task'),
    );
  });

  it('rejects unknown kind with bad_request', async () => {
    await expect(
      handleWorkEntitySourceSetDefault(deps, {
        // @ts-expect-error — runtime guard
        kind: 'memo',
        source_id: RECUED_BUILTIN_SOURCE_ID('task'),
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects cross-kind pin with bad_request', async () => {
    await expect(
      handleWorkEntitySourceSetDefault(deps, {
        kind: 'task',
        source_id: RECUED_BUILTIN_SOURCE_ID('note'),
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects pin of disabled Source with bad_request (Codex P1 fold)', async () => {
    const id = RECUED_BUILTIN_SOURCE_ID('task');
    store.setSourceEnabled(id, false);
    await expect(
      handleWorkEntitySourceSetDefault(deps, { kind: 'task', source_id: id }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('disable rpc auto-clears the per-kind default (Codex P1 fold)', async () => {
    const id = RECUED_BUILTIN_SOURCE_ID('task');
    store.setDefaultSource('task', id);
    expect(deps.resolver.getDefaultSource('task')).toBe(id);
    await handleWorkEntitySourceSetEnabled(deps, {
      source_id: id,
      enabled: false,
    });
    expect(deps.resolver.getDefaultSource('task')).toBeNull();
  });
});

describe('PA11 work_entity.source.clear_default', () => {
  it('drops the per-kind default and reports cleared', async () => {
    store.setDefaultSource('task', RECUED_BUILTIN_SOURCE_ID('task'));
    const out = await handleWorkEntitySourceClearDefault(deps, {
      kind: 'task',
    });
    expect(out.ok).toBe(true);
    expect(out.cleared).toBe(true);
    expect(deps.resolver.getDefaultSource('task')).toBeNull();
  });

  it('returns cleared=false when nothing was pinned', async () => {
    const out = await handleWorkEntitySourceClearDefault(deps, {
      kind: 'note',
    });
    expect(out.cleared).toBe(false);
  });
});

describe('PA11 makeWorkEntitySourceHandlers slice', () => {
  it('returns undefined when deps absent', () => {
    expect(makeWorkEntitySourceHandlers(undefined)).toBeUndefined();
  });

  it('claims exactly the five PA11 methods', () => {
    const slice = makeWorkEntitySourceHandlers(deps);
    expect(slice).toBeDefined();
    expect(slice!.methods).toEqual([
      'work_entity.source.list',
      'work_entity.source.set_enabled',
      'work_entity.source.set_mcp_exposed',
      'work_entity.source.set_default',
      'work_entity.source.clear_default',
    ]);
  });
});

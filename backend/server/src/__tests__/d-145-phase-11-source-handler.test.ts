/** D-145 PA11 — `work_entity.source.*` rpc handler tests.
 *
 *  Covers list / set_enabled / set_default /
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
  handleWorkEntitySourceList,
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
      registered_at: NOW,
    });
  }
  deps = { resolver: createWorkEntityResolver(store) };
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});





describe('PA11 makeWorkEntitySourceHandlers slice', () => {
  it('returns undefined when deps absent', () => {
    expect(makeWorkEntitySourceHandlers(undefined)).toBeUndefined();
  });

  it('claims exactly ONE method — list; the writers are gone', () => {
    const slice = makeWorkEntitySourceHandlers(deps);
    expect(slice).toBeDefined();
    // D-187 Sources half — a Source is declared by a PACK, so pack
    // install/uninstall is its lifecycle and this family has no writers left.
    expect(slice!.methods).toEqual(['work_entity.source.list']);
  });
});

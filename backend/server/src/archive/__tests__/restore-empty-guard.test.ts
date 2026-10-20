/** M5 S3.1 — the not-enrolled restore guard's `isLiveWarehouseEmpty` backstop.
 *
 *  The guard authorizes a DESTRUCTIVE pre-enrollment restore only on an empty
 *  warehouse, and FAILS CLOSED: it counts every table except
 *  `RESTORE_GUARD_NON_USER_TABLES` (system/seed/config + pairing/upload flow).
 *  These tests pin both directions:
 *    - a freshly-composed server db (real boot seed) reads EMPTY — so the
 *      denylist is complete for a fresh server (a new seed table that slips in
 *      uncounted flips this red, and the failure names it);
 *    - any non-denylisted table with a row flips it to NOT empty — so a user (or
 *      a future, unclassified) surface blocks the restore. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRuntimeConfigStore } from '@recued/config';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { createBootTrace } from '../../cli/boot-trace.js';
import { createLLMConfigManager } from '../../llm-config.js';
import { composeStorageContext } from '../../serve/compose-storage-context.js';
import {
  isLiveWarehouseEmpty,
  restoreGuardUserDataTables,
  RESTORE_GUARD_NON_USER_TABLES,
} from '../archive-runtime.js';

import { createAssetClassStore, STARTER_ASSET_CLASSES } from '../../situations/asset-classes.js';

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

const composeFreshDb = async (): Promise<Database.Database> => {
  tmp = mkdtempSync(join(tmpdir(), 'recued-restore-guard-'));
  const ctx = await composeStorageContext({
    dbPath: join(tmp, 'server.db'),
    bootTrace: createBootTrace({
      entrypoint: 'serve-entry',
      profile: 'serve',
      command: 'serve',
      env: {},
      now: () => 1000,
      sink: () => {},
    }),
    runtimeConfig: createRuntimeConfigStore({}),
    vaultQuotas: { perPublisherBytes: 1_000_000, totalBytes: 5_000_000 },
  });
  return ctx.db;
};

describe('M5 S3.1 — isLiveWarehouseEmpty (not-enrolled restore guard)', () => {
  it('the real empty-model migration marker is bookkeeping while actual LLM and Chat settings still block', async () => {
    const db = await composeFreshDb();
    const llm = createLLMConfigManager(db);
    expect(llm.deriveTranscriptionSlotOnce()).toBe('no_candidate');
    expect(db.prepare('SELECT key,value FROM llm_config').all()).toEqual([{ key: 'transcription_slot.derived', value: '1' }]);
    expect(restoreGuardUserDataTables(db)).toEqual([]);
    const insert = db.prepare('INSERT INTO llm_config (key,value) VALUES (?,?)');
    for (const key of ['slot_1.model', 'slot_1.api_key', 'usage.2026-10-18', 'transcription_slot.derived.extra']) {
      insert.run(key, 'fixture');
      expect(restoreGuardUserDataTables(db)).toContain('llm_config');
      db.prepare('DELETE FROM llm_config WHERE key=?').run(key);
    }
    db.prepare("UPDATE llm_config SET value='0'").run();
    expect(restoreGuardUserDataTables(db)).toContain('llm_config');
    db.prepare("UPDATE llm_config SET value='1'").run();
    db.exec("CREATE TABLE IF NOT EXISTS chat_config (key TEXT PRIMARY KEY,value TEXT NOT NULL)");
    db.prepare('INSERT INTO chat_config (key,value) VALUES (?,?)').run('rolling_brief_enabled', '0');
    expect(restoreGuardUserDataTables(db)).toContain('chat_config');
  });

  it('ignores only exact asset class seeds and keeps owner or altered classes restore-blocking', async () => {
    const db = await composeFreshDb(); const classes = createAssetClassStore(db);
    expect(RESTORE_GUARD_NON_USER_TABLES.has('asset_class_presets')).toBe(false);
    expect(isLiveWarehouseEmpty(db)).toBe(true);
    classes.saveOwner({ ...STARTER_ASSET_CLASSES[0]!, id: 'owner_copy', origin: 'owner' });
    expect(restoreGuardUserDataTables(db)).toContain('asset_class_presets');
    classes.deleteOwner('owner_copy'); expect(isLiveWarehouseEmpty(db)).toBe(true);
    db.prepare('UPDATE asset_class_presets SET value=? WHERE id=?').run('{}', STARTER_ASSET_CLASSES[0]!.id);
    expect(restoreGuardUserDataTables(db)).toContain('asset_class_presets');
  });
  it('a freshly-composed server db reads EMPTY (denylist covers the boot seed)', async () => {
    const db = await composeFreshDb();
    // A red here NAMES the seeded table to add to RESTORE_GUARD_NON_USER_TABLES
    // (the guard's own logic — denylist + FTS exclusion — so no false reports).
    expect(restoreGuardUserDataTables(db)).toEqual([]);
    expect(isLiveWarehouseEmpty(db)).toBe(true);
  });

  it('the denylist contains ZERO user-content / activity surfaces (would mask data loss)', async () => {
    // Defense against the opposite gap: a user-content table wrongly denylisted
    // would read as empty even when full. These must NEVER be denylisted —
    // including the post-USE EXECUTION/activity tables (audit ENTRIES, schedules,
    // BYOK config, authoring) a server gains only by being used. (NOTE:
    // `collection_instances` / `audit_activities` / `event_triggers` are NOT here
    // — a real boot seeds them, so they ARE denylisted; see the next test.)
    for (const userTable of [
      'contacts',
      'connections',
      'chat_sessions',
      'shared_store',
      'data_task',
      'data_enrichment',
      'dishes',
      'engagements',
      'reception_form_submission',
      'links',
      'annotation',
      'commits',
      'checkpoints',
      'gated_action_receipts',
      // M5 S3 — execution + user config/authoring, COUNTED (not boot-seeded)
      'audit_entries',
      'schedules',
      'llm_config',
      'ingredient_draft',
      'bundle',
      'enrichment_trust',
    ]) {
      expect(RESTORE_GUARD_NON_USER_TABLES.has(userTable)).toBe(false);
    }
  });

  it('M5 S3 — execution activity blocks restore via audit_ENTRIES (runs), still counted', async () => {
    const db = await composeFreshDb();
    expect(isLiveWarehouseEmpty(db)).toBe(true);
    // A single `audit_entries` row — what a recipe RUN writes — must make a
    // not-enrolled server read as non-empty so its Runs/timeline history can't be
    // clobbered. (`audit_entries` is EMPTY on a fresh boot, unlike the boot-
    // polluted `audit_activities`, so it stays a clean user-activity signal.)
    db.exec(`INSERT INTO audit_entries (key, data) VALUES ('run-1', '{}')`);
    expect(restoreGuardUserDataTables(db)).toContain('audit_entries');
    expect(isLiveWarehouseEmpty(db)).toBe(false);
  });

  it('M5 S3 (regression, live wet-run 2026-06-27) — the tables a real boot seeds ARE denylisted', async () => {
    // The bug: a genuinely fresh `bin.ts` server has rows in these three (the
    // collection-registry default, boot audit events, the seed recipes'
    // triggers), so the guard hit `target_not_empty` on a CLEAN server. The
    // `composeStorageContext` fresh-baseline above under-seeds (creates the
    // tables but leaves them empty), which is exactly why it missed the gap.
    // Pin the membership so removing any of them turns this red. (That their
    // rows then don't count is the denylist's contract — proven end-to-end by
    // the `recipes` test below.)
    for (const t of [
      'collection_instances',
      'audit_activities',
      'event_triggers',
      'gated_action_change_sequence',
    ]) {
      expect(RESTORE_GUARD_NON_USER_TABLES.has(t)).toBe(true);
    }
    // And a fresh-composed db (these tables present) still reads empty.
    const db = await composeFreshDb();
    expect(isLiveWarehouseEmpty(db)).toBe(true);
  });

  it('any non-denylisted table with a row flips it to NOT empty (fail-closed)', async () => {
    const db = await composeFreshDb();
    expect(isLiveWarehouseEmpty(db)).toBe(true);
    // A table the denylist has never heard of — simulates a user-content row OR
    // a future warehouse surface we forgot to classify. Either way it must block.
    db.exec(`CREATE TABLE some_future_user_surface (id INTEGER PRIMARY KEY)`);
    db.exec(`INSERT INTO some_future_user_surface (id) VALUES (1)`);
    expect(isLiveWarehouseEmpty(db)).toBe(false);
  });

  it('rows in DENYLISTED seed tables do not count (fresh db has them + still empty)', async () => {
    // The fresh db already carries rows in `recipes` / `server_config` / … yet
    // reads empty — proving the denylist exclusion works end to end.
    const db = await composeFreshDb();
    const recipeRows = db.prepare(`SELECT COUNT(*) AS n FROM recipes`).get() as { n: number };
    expect(recipeRows.n).toBeGreaterThan(0); // boot seeded
    expect(isLiveWarehouseEmpty(db)).toBe(true);
  });
});

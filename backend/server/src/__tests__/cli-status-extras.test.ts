/** D-116 follow-up — CLI status auto-disabled read-out.
 *  Uses a temp on-disk SQLite (better-sqlite3 readonly opens require
 *  an actual file path; in-memory shared isn't enough). */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { readAutoDisabledFromDb, renderAutoDisabledTable } from '../cli-status-extras.js';
import { createCircuitBreakerStore } from '../auto-run-scheduler.js';

const setupDb = (
  dir: string,
): { dbPath: string; db: Database.Database } => {
  const dbPath = join(dir, 'recued-server.db');
  const db = new Database(dbPath);
  // Bootstrap the two tables the read-out joins.
  createCircuitBreakerStore(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS recipes (
      recipe_id    TEXT PRIMARY KEY,
      publisher_id TEXT NOT NULL,
      version      INTEGER NOT NULL,
      recipe_hash  TEXT NOT NULL,
      recipe_json  TEXT NOT NULL,
      source       TEXT NOT NULL,
      installed_at INTEGER NOT NULL,
      upstream_version INTEGER,
      upstream_hash    TEXT,
      last_checked_at  INTEGER
    );
  `);
  return { dbPath, db };
};

const seedRecipe = (
  db: Database.Database,
  recipe_id: string,
  publisher_id: string,
  name: string,
): void => {
  const recipe = { recipe_id, version: 1, ttl: 60, metadata: { name, description: '', author: 'a', supported_platforms: [] } };
  db.prepare(
    'INSERT INTO recipes VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)',
  ).run(recipe_id, publisher_id, 1, 'h', JSON.stringify(recipe), 'imported', Date.now());
};

describe('readAutoDisabledFromDb', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'recued-cli-status-'));
    const setup = setupDb(tmpDir);
    dbPath = setup.dbPath;
    db = setup.db;
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns [] when the database does not exist', async () => {
    const fake = join(tmpDir, 'no-such.db');
    expect(await readAutoDisabledFromDb(fake)).toEqual([]);
  });

  it('returns [] when no rows are auto-disabled', async () => {
    const store = createCircuitBreakerStore(db);
    store.set({
      recipe_id: 'r1', consecutive_failures: 2, auto_disabled: false,
    });
    db.close();
    expect(await readAutoDisabledFromDb(dbPath)).toEqual([]);
  });

  it('reads only auto-disabled rows', async () => {
    const store = createCircuitBreakerStore(db);
    seedRecipe(db, 'r-disabled', 'recued-core', 'Disabled Recipe');
    seedRecipe(db, 'r-active', 'recued-core', 'Active Recipe');
    store.set({
      recipe_id: 'r-disabled', consecutive_failures: 5, auto_disabled: true,
      last_failure_at: 1714_000_000_000, last_failure_reason: 'NETWORK_ERROR',
    });
    store.set({
      recipe_id: 'r-active', consecutive_failures: 1, auto_disabled: false,
    });
    db.close();
    const rows = await readAutoDisabledFromDb(dbPath);
    expect(rows).toHaveLength(1);
    expect(rows[0].recipe_id).toBe('r-disabled');
    expect(rows[0].name).toBe('Disabled Recipe');
    expect(rows[0].publisher_id).toBe('recued-core');
    expect(rows[0].consecutive_failures).toBe(5);
    expect(rows[0].last_failure_at).toBe(1714_000_000_000);
    expect(rows[0].last_failure_reason).toBe('NETWORK_ERROR');
  });

  it('falls back to recipe_id when the recipes row is missing', async () => {
    const store = createCircuitBreakerStore(db);
    store.set({
      recipe_id: 'orphan', consecutive_failures: 8, auto_disabled: true,
    });
    db.close();
    const rows = await readAutoDisabledFromDb(dbPath);
    expect(rows[0].name).toBe('orphan');
    expect(rows[0].publisher_id).toBe('');
  });

  it('orders rows by recipe_id', async () => {
    const store = createCircuitBreakerStore(db);
    for (const id of ['charlie', 'alpha', 'bravo']) {
      store.set({
        recipe_id: id, consecutive_failures: 5, auto_disabled: true,
      });
    }
    db.close();
    const rows = await readAutoDisabledFromDb(dbPath);
    expect(rows.map((r) => r.recipe_id)).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('returns [] when auto_run_circuit table does not exist', async () => {
    // Fresh db that never created the circuit table.
    const bareDir = mkdtempSync(join(tmpdir(), 'recued-cli-bare-'));
    const barePath = join(bareDir, 'bare.db');
    const bare = new Database(barePath);
    bare.exec('CREATE TABLE foo (x INTEGER)');
    bare.close();
    expect(await readAutoDisabledFromDb(barePath)).toEqual([]);
    rmSync(bareDir, { recursive: true, force: true });
  });
});

describe('renderAutoDisabledTable', () => {
  it('renders single-line "none" for empty input', () => {
    expect(renderAutoDisabledTable([])).toBe('Auto-disabled: none');
  });

  it('renders header + one block per row', () => {
    const out = renderAutoDisabledTable([
      {
        recipe_id: 'watch-mail', publisher_id: 'recued-core',
        name: 'Watch Mail', consecutive_failures: 5,
        last_failure_at: 1714_000_000_000, last_failure_reason: 'NETWORK_ERROR',
      },
    ]);
    expect(out).toContain('Auto-disabled: 1 recipe');
    expect(out).toContain('watch-mail');
    expect(out).toContain('Watch Mail');
    expect(out).toContain('failures:  5');
    expect(out).toContain('NETWORK_ERROR');
    expect(out).toContain('Reset via:');
  });

  it('uses plural copy for count > 1', () => {
    const out = renderAutoDisabledTable([
      {
        recipe_id: 'a', publisher_id: 'p', name: 'A',
        consecutive_failures: 1, last_failure_at: null, last_failure_reason: null,
      },
      {
        recipe_id: 'b', publisher_id: 'p', name: 'B',
        consecutive_failures: 2, last_failure_at: null, last_failure_reason: null,
      },
    ]);
    expect(out).toContain('Auto-disabled: 2 recipes');
  });

  it('renders "never" for missing failure timestamp + "(no recorded reason)" for missing reason', () => {
    const out = renderAutoDisabledTable([
      {
        recipe_id: 'r', publisher_id: 'p', name: 'R',
        consecutive_failures: 5, last_failure_at: null, last_failure_reason: null,
      },
    ]);
    expect(out).toContain('last:      never');
    expect(out).toContain('reason:    (no recorded reason)');
  });

  it('renders em-dash for empty publisher_id', () => {
    const out = renderAutoDisabledTable([
      {
        recipe_id: 'r', publisher_id: '', name: 'R',
        consecutive_failures: 5, last_failure_at: null, last_failure_reason: null,
      },
    ]);
    expect(out).toContain('publisher: —');
  });
});

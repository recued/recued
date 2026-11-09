/** D-341 slice B1 — the owner's standing pre-approvals on triggers, kept in the server's
 *  database. Two tables:
 *  `trigger_preapprovals`: one row per pre-approval, with the trigger (its kind and the id its
 *  own store knows it by), the recipe and the version it was granted for, the ops it allows, its
 *  cap per run and the uses it has let through. It has no end date and no use cap: it lasts until
 *  the owner ends it (ruling 10, 2026-11-08; a table made before is rebuilt without them).
 *  `trigger_preapproval_runs`: the uses each run has spent, per op: the cap per run is counted
 *  against their sum, and the run's outcome lists them (what ran without asking).
 *  ⛔ A use is spent in the same transaction that checks the run's cap. Two writes of one run
 *  racing for its last write cannot both get it. */

import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';
import {
  triggerFromRef,
  triggerPreapprovalCovers,
  triggerRefOf,
  type TriggeredRun,
  type TriggerPreapprovalKind,
  type TriggerPreapprovalRow,
  type TriggerPreapprovalTrigger,
} from '@recued/contracts';

/** A refusal the rpc reports as its code. */
export class TriggerPreapprovalError extends Error {
  constructor(readonly code: 'not_found' | 'bad_request', message: string) {
    super(message);
    this.name = 'TriggerPreapprovalError';
  }
}

export interface TriggerPreapprovalStore {
  /** Keep a pre-approval the owner granted. */
  grant(input: {
    readonly trigger: TriggerPreapprovalTrigger;
    readonly door_contract_id?: string;
    /** B6 — a recipe a scheduled prompt starts: the prompt's version too. */
    readonly prompt_sha256?: string;
    readonly recipe_id: string;
    readonly recipe_sha256: string;
    readonly writes: readonly string[];
    readonly max_per_run: number;
    readonly now: number;
  }): TriggerPreapprovalRow;
  /** Every pre-approval, newest first; the caller works out each one's state. */
  list(): TriggerPreapprovalRow[];
  get(id: string): TriggerPreapprovalRow | undefined;
  /** End one now. Ending one already ended changes nothing. */
  revoke(id: string, now: number): TriggerPreapprovalRow;
  /** Spend one use on the pre-approval covering this write in this run, or none: undefined
   *  (⇒ the write asks). The one granted first is spent first. */
  use(call: TriggeredRun & {
    readonly recipe_id: string;
    readonly recipe_sha256: string;
    readonly op: string;
    readonly run_id: string;
  }, now: number): TriggerPreapprovalRow | undefined;
  /** The uses a run has spent on one. */
  runUses(id: string, run_id: string): number;
  /** What a run made without asking: each pre-approval and op it spent uses on, in the order they
   *  were first spent. */
  runWrites(run_id: string): Array<{ readonly preapproval_id: string; readonly op: string; readonly uses: number }>;
}

interface Row {
  id: string; trigger_kind: string; trigger_ref: string; door_contract_id: string | null;
  recipe_id: string; recipe_sha256: string; prompt_sha256: string | null;
  writes: string; max_per_run: number; uses: number;
  created_at: number; revoked_at: number | null; last_used_at: number | null;
}

const toRow = (row: Row): TriggerPreapprovalRow => ({
  id: row.id,
  trigger: triggerFromRef(row.trigger_kind as TriggerPreapprovalKind, row.trigger_ref),
  ...(row.door_contract_id !== null ? { door_contract_id: row.door_contract_id } : {}),
  recipe_id: row.recipe_id,
  recipe_sha256: row.recipe_sha256,
  ...(row.prompt_sha256 !== null && row.prompt_sha256 !== undefined ? { prompt_sha256: row.prompt_sha256 } : {}),
  writes: JSON.parse(row.writes) as string[],
  max_per_run: row.max_per_run,
  uses: row.uses,
  created_at: row.created_at,
  ...(row.revoked_at !== null ? { revoked_at: row.revoked_at } : {}),
  ...(row.last_used_at !== null ? { last_used_at: row.last_used_at } : {}),
});

const COLUMNS = [
  'id', 'trigger_kind', 'trigger_ref', 'door_contract_id', 'recipe_id', 'recipe_sha256', 'writes',
  'max_per_run', 'uses', 'created_at', 'revoked_at', 'last_used_at',
] as const;

const tableDdl = (name: string): string => `
  CREATE TABLE IF NOT EXISTS ${name} (
    id TEXT PRIMARY KEY,
    trigger_kind TEXT NOT NULL,
    trigger_ref TEXT NOT NULL,
    door_contract_id TEXT,
    recipe_id TEXT NOT NULL,
    recipe_sha256 TEXT NOT NULL,
    prompt_sha256 TEXT,
    writes TEXT NOT NULL,
    max_per_run INTEGER NOT NULL,
    uses INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    last_used_at INTEGER
  )`;

export const createTriggerPreapprovalStore = (db: Database.Database): TriggerPreapprovalStore => {
  db.exec(tableDdl('trigger_preapprovals'));
  // Ruling 10 — a table made before it carried an end date and a use cap, both NOT NULL. Rebuilt
  // without them in one transaction (a crash leaves the old table as it was); its rows last until
  // the owner ends them, like every new one.
  const columns = (db.prepare('PRAGMA table_info(trigger_preapprovals)').all() as Array<{ name: string }>).map((c) => c.name);
  if (columns.includes('expires_at') || columns.includes('max_uses')) {
    const kept = COLUMNS.join(', ');
    db.transaction(() => {
      db.exec('DROP TABLE IF EXISTS trigger_preapprovals_rebuild');
      db.exec(tableDdl('trigger_preapprovals_rebuild'));
      db.exec(`INSERT INTO trigger_preapprovals_rebuild (${kept}) SELECT ${kept} FROM trigger_preapprovals`);
      db.exec('DROP TABLE trigger_preapprovals');
      db.exec('ALTER TABLE trigger_preapprovals_rebuild RENAME TO trigger_preapprovals');
    })();
  }
  // B6 — a table made before a recipe a scheduled prompt starts could be pre-approved.
  const now = (db.prepare('PRAGMA table_info(trigger_preapprovals)').all() as Array<{ name: string }>).map((c) => c.name);
  if (!now.includes('prompt_sha256')) db.exec('ALTER TABLE trigger_preapprovals ADD COLUMN prompt_sha256 TEXT');
  // ⚠ After the rebuild: dropping the table takes its index with it.
  db.exec(`
    CREATE INDEX IF NOT EXISTS trigger_preapprovals_by_trigger
      ON trigger_preapprovals(trigger_kind, trigger_ref, recipe_id);
    CREATE TABLE IF NOT EXISTS trigger_preapproval_runs (
      preapproval_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      op TEXT NOT NULL,
      uses INTEGER NOT NULL,
      first_used_at INTEGER NOT NULL,
      PRIMARY KEY (preapproval_id, run_id, op)
    );
    CREATE INDEX IF NOT EXISTS trigger_preapproval_runs_by_run ON trigger_preapproval_runs(run_id);
  `);
  const select = db.prepare('SELECT * FROM trigger_preapprovals WHERE id = ?');
  const candidates = db.prepare(`
    SELECT * FROM trigger_preapprovals
    WHERE trigger_kind = ? AND trigger_ref = ? AND recipe_id = ? AND revoked_at IS NULL
    ORDER BY created_at, id
  `);
  const runUses = db.prepare('SELECT COALESCE(SUM(uses), 0) AS uses FROM trigger_preapproval_runs WHERE preapproval_id = ? AND run_id = ?');
  const runWrites = db.prepare(`
    SELECT preapproval_id, op, uses FROM trigger_preapproval_runs WHERE run_id = ? ORDER BY first_used_at, rowid
  `);
  const spend = db.prepare('UPDATE trigger_preapprovals SET uses = uses + 1, last_used_at = ? WHERE id = ? AND revoked_at IS NULL');
  const spendRun = db.prepare(`
    INSERT INTO trigger_preapproval_runs (preapproval_id, run_id, op, uses, first_used_at) VALUES (?, ?, ?, 1, ?)
    ON CONFLICT (preapproval_id, run_id, op) DO UPDATE SET uses = uses + 1
  `);

  const use = db.transaction((call: Parameters<TriggerPreapprovalStore['use']>[0], now: number) => {
    for (const raw of candidates.all(call.trigger.kind, triggerRefOf(call.trigger), call.recipe_id) as Row[]) {
      const row = toRow(raw);
      if (!triggerPreapprovalCovers(row, call)) continue;
      const spent = (runUses.get(row.id, call.run_id) as { uses: number }).uses;
      if (spent >= row.max_per_run) continue;
      if (spend.run(now, row.id).changes !== 1) continue;
      spendRun.run(row.id, call.run_id, call.op, now);
      return toRow(select.get(row.id) as Row);
    }
    return undefined;
  });

  return {
    grant(input) {
      const id = `tpa_${randomUUID().replace(/-/gu, '')}`;
      db.prepare(`
        INSERT INTO trigger_preapprovals
          (id, trigger_kind, trigger_ref, door_contract_id, recipe_id, recipe_sha256, prompt_sha256, writes, max_per_run, uses,
           created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      `).run(id, input.trigger.kind, triggerRefOf(input.trigger), input.door_contract_id ?? null, input.recipe_id, input.recipe_sha256,
        input.prompt_sha256 ?? null, JSON.stringify(input.writes), input.max_per_run, input.now);
      return toRow(select.get(id) as Row);
    },
    list() {
      return (db.prepare('SELECT * FROM trigger_preapprovals ORDER BY created_at DESC, id DESC').all() as Row[]).map(toRow);
    },
    get(id) {
      const row = select.get(id) as Row | undefined;
      return row === undefined ? undefined : toRow(row);
    },
    revoke(id, now) {
      const row = select.get(id) as Row | undefined;
      if (row === undefined) throw new TriggerPreapprovalError('not_found', `no pre-approval ${id}`);
      if (row.revoked_at === null) db.prepare('UPDATE trigger_preapprovals SET revoked_at = ? WHERE id = ?').run(now, id);
      return toRow(select.get(id) as Row);
    },
    use: (call, now) => use(call, now),
    runUses(id, run_id) {
      return (runUses.get(id, run_id) as { uses: number }).uses;
    },
    runWrites(run_id) {
      return runWrites.all(run_id) as Array<{ preapproval_id: string; op: string; uses: number }>;
    },
  };
};

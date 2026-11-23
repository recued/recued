/** D-341 slice B1 — the owner's standing pre-approvals on triggers, kept in the server's
 *  database. Three tables:
 *  `trigger_preapprovals`: one row per pre-approval, with the trigger (its kind and the id its
 *  own store knows it by), the recipe and the version it was granted for, the ops it allows, its
 *  cap per run and the uses it has let through. It has no end date and no use cap: it lasts until
 *  the owner ends it (ruling 10, 2026-11-08; a table made before is rebuilt without them).
 *  `trigger_preapproval_runs`: the uses each run has spent, per op: the cap per run is counted
 *  against their sum, and the run's outcome lists them (what ran without asking).
 *  `trigger_preapproval_decisions`: the grant each durable approval selected,
 *  including a reused grant. Its binding outlives revocation.
 *  ⛔ A use is spent in the same transaction that checks the run's cap. Two writes of one run
 *  racing for its last write cannot both get it.
 *
 *  D-402 slice F2 — the same table keeps the pre-approvals a caller holds (§7.6): the owner's chats or
 *  an AI app, by `trigger_kind` and `trigger_ref` (`owner_chat` / `owner`, `ai_app` / its contract),
 *  each covering the whole recipe (`writes` `["*"]`, cap 0, ruling 5), a one-run row naming its run
 *  (`run_id`). They have methods of their own (`grantCaller`, `useCaller`, `listCallers`,
 *  `revokeCaller`): the trigger's (`list`, `get`, `revoke`, `use`) see trigger rows only, so a
 *  trigger's page and its rpc are unchanged. A whole-recipe trigger row spends no cap. */

import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';
import {
  readPreapprovalBrowsers,
  readPreapprovalNested,
  type PreapprovalBrowsers,
  type PreapprovalNested,
  callerPreapprovalCovers,
  coversWholeRecipe,
  PREAPPROVAL_CALLER_KINDS,
  preapprovalCallerRef,
  TRIGGER_PREAPPROVAL_ALL_WRITES,
  TRIGGER_PREAPPROVAL_WHOLE_RECIPE,
  triggerFromRef,
  triggerPreapprovalCovers,
  triggerRefOf,
  type CallerPreapprovalRow,
  type PreapprovalCaller,
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

export interface TriggerPreapprovalGrantInput {
  readonly trigger: TriggerPreapprovalTrigger;
  readonly door_contract_id?: string;
  /** B6 — a recipe a scheduled prompt starts: the prompt's version too. */
  readonly prompt_sha256?: string;
  readonly recipe_id: string;
  readonly recipe_sha256: string;
  readonly writes: readonly string[];
  readonly max_per_run: number;
  readonly now: number;
}

export interface TriggerPreapprovalGrantDecision {
  readonly approval_ref: string;
  readonly offer_sha256: string;
}

export interface TriggerPreapprovalStore {
  /** Keep a fresh pre-approval explicitly granted by the owner. */
  grant(input: TriggerPreapprovalGrantInput): TriggerPreapprovalRow;
  /** Return the original selection even after its grant is revoked. */
  getDecision(decision: TriggerPreapprovalGrantDecision): TriggerPreapprovalRow | undefined;
  /** Bind one approval to a live covering grant or a newly created one,
   * atomically. A replay never replaces its original grant. */
  grantForDecision(input: TriggerPreapprovalGrantInput, decision: TriggerPreapprovalGrantDecision): {
    row: TriggerPreapprovalRow; created: boolean;
  };
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
  /** D-402 slice F2 — a caller's pre-approval of one recipe version, covering the whole recipe; with
   *  `run_id`, for that run alone ("Yes, this time"). */
  grantCaller(input: CallerPreapprovalGrantInput): CallerPreapprovalRow;
  /** Spend a use on the caller's pre-approval covering this write of this run, or none: undefined
   *  (⇒ the write asks). This run's own row first, then a standing one, the one granted first. */
  useCaller(call: {
    /** D-402 slice H4 — the browsers the run's settings name: a row holds each site's writes to its own. */
    readonly browsers?: PreapprovalBrowsers;
    /** D-402 ruling 17 — a write of a recipe the run started: the outer run's row must name it at this version. */
    readonly nested?: { readonly recipe_id: string; readonly recipe_sha256: string };
    readonly caller: PreapprovalCaller;
    readonly recipe_id: string;
    readonly recipe_sha256: string;
    readonly op: string;
    readonly run_id: string;
  }, now: number): CallerPreapprovalRow | undefined;
  /** Every caller's pre-approval, newest first. */
  listCallers(): CallerPreapprovalRow[];
  getCaller(id: string): CallerPreapprovalRow | undefined;
  /** End a caller's pre-approval now. Ending one already ended changes nothing. */
  revokeCaller(id: string, now: number): CallerPreapprovalRow;
  /** D-402 slice F5 (§7.10) — who is told of each change: a grant, a use spent, an end (a revoke, a
   *  "Stop allowing", a run's own row ending with it). The bus fans it as
   *  `contract.preapproval_changed`. A listener that throws changes nothing. */
  onChange(listener: (change: PreapprovalChange) => void): () => void;
}

/** D-402 slice F5 — one change to a pre-approval, as the bus fans it: which row, whose (a trigger's or
 *  a caller's), and what happened. Never its writes or its caller. */
export interface PreapprovalChange {
  readonly change: 'granted' | 'used' | 'ended';
  readonly id: string;
  readonly holder: 'trigger' | 'caller';
}

export interface CallerPreapprovalGrantInput {
  readonly caller: PreapprovalCaller;
  readonly recipe_id: string;
  readonly recipe_sha256: string;
  readonly run_id?: string;
  /** D-402 slice H4 — the browsers the run's settings named when the owner answered. */
  readonly browsers?: PreapprovalBrowsers;
  /** D-402 ruling 17 — the recipes the run starts, at the versions the question saw. */
  readonly nested?: PreapprovalNested;
  readonly now: number;
}

interface Row {
  id: string; trigger_kind: string; trigger_ref: string; door_contract_id: string | null;
  recipe_id: string; recipe_sha256: string; prompt_sha256: string | null;
  writes: string; max_per_run: number; uses: number;
  created_at: number; revoked_at: number | null; last_used_at: number | null;
  /** D-402 slice F2 — a one-run row's run. */
  run_id?: string | null;
  /** D-402 slice H4 — a caller row's browsers, JSON. */
  browsers?: string | null;
  /** D-402 ruling 17 — a caller row's nested recipes, JSON. */
  nested?: string | null;
}

/** D-402 slice F2 — whether a row is a caller's, not a trigger's. */
const isCallerKind = (kind: string): boolean => (PREAPPROVAL_CALLER_KINDS as readonly string[]).includes(kind);
const CALLER_KINDS_SQL = PREAPPROVAL_CALLER_KINDS.map((kind) => `'${kind}'`).join(', ');

const toCallerRow = (row: Row): CallerPreapprovalRow => ({
  id: row.id,
  caller: row.trigger_kind === 'ai_app' ? { kind: 'ai_app', contract_id: row.trigger_ref } : { kind: 'owner_chat' },
  recipe_id: row.recipe_id,
  recipe_sha256: row.recipe_sha256,
  ...(row.run_id !== null && row.run_id !== undefined ? { run_id: row.run_id } : {}),
  ...(() => {
    if (row.browsers === null || row.browsers === undefined) return {};
    // ⛔ A record this version cannot read covers no recipe that names a browser, never every browser.
    let parsed: unknown;
    try { parsed = JSON.parse(row.browsers); } catch { parsed = undefined; }
    return { browsers: readPreapprovalBrowsers(parsed) ?? { '': '' } };
  })(),
  ...(() => {
    if (row.nested === null || row.nested === undefined) return {};
    // ⛔ A record this version cannot read covers no recipe the run starts, never every one.
    let parsed: unknown;
    try { parsed = JSON.parse(row.nested); } catch { parsed = undefined; }
    return { nested: readPreapprovalNested(parsed) ?? {} };
  })(),
  uses: row.uses,
  created_at: row.created_at,
  ...(row.revoked_at !== null ? { revoked_at: row.revoked_at } : {}),
  ...(row.last_used_at !== null ? { last_used_at: row.last_used_at } : {}),
});

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
  // D-402 slice F2 — a table made before a caller's one-run row ("Yes, this time") named its run.
  if (!now.includes('run_id')) db.exec('ALTER TABLE trigger_preapprovals ADD COLUMN run_id TEXT');
  // D-402 slice H4 — a table made before a caller's row held the browsers its run's settings named.
  if (!now.includes('browsers')) db.exec('ALTER TABLE trigger_preapprovals ADD COLUMN browsers TEXT');
  // D-402 ruling 17 — a table made before a caller's row named the recipes its run starts.
  if (!now.includes('nested')) db.exec('ALTER TABLE trigger_preapprovals ADD COLUMN nested TEXT');
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
    CREATE TABLE IF NOT EXISTS trigger_preapproval_decisions (
      approval_ref TEXT PRIMARY KEY,
      offer_sha256 TEXT NOT NULL,
      preapproval_id TEXT NOT NULL
    );
  `);
  const selectAny = db.prepare('SELECT * FROM trigger_preapprovals WHERE id = ?');
  // A trigger's methods see trigger rows only; a caller's, callers' (D-402 slice F2).
  const select = { get: (id: string) => { const row = selectAny.get(id) as Row | undefined; return row !== undefined && !isCallerKind(row.trigger_kind) ? row : undefined; } };
  const selectCaller = (id: string): Row | undefined => {
    const row = selectAny.get(id) as Row | undefined;
    return row !== undefined && isCallerKind(row.trigger_kind) ? row : undefined;
  };
  const callerCandidates = db.prepare(`
    SELECT * FROM trigger_preapprovals
    WHERE trigger_kind = ? AND trigger_ref = ? AND recipe_id = ? AND revoked_at IS NULL
      AND (run_id IS NULL OR run_id = ?)
    ORDER BY run_id IS NULL, created_at, id
  `);
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
      // Ruling 5 — a row covering the whole recipe has no cap a run.
      if (!coversWholeRecipe(row) && spent >= row.max_per_run) continue;
      if (spend.run(now, row.id).changes !== 1) continue;
      spendRun.run(row.id, call.run_id, call.op, now);
      return toRow(select.get(row.id) as Row);
    }
    return undefined;
  });

  const useCaller = db.transaction((call: Parameters<TriggerPreapprovalStore['useCaller']>[0], now: number) => {
    for (const raw of callerCandidates.all(call.caller.kind, preapprovalCallerRef(call.caller), call.recipe_id, call.run_id) as Row[]) {
      const row = toCallerRow(raw);
      if (!callerPreapprovalCovers(row, call)) continue;
      if (spend.run(now, row.id).changes !== 1) continue;
      spendRun.run(row.id, call.run_id, call.op, now);
      return toCallerRow(selectCaller(row.id)!);
    }
    return undefined;
  });

  const insertCaller = (input: CallerPreapprovalGrantInput): CallerPreapprovalRow => {
    const id = `cpa_${randomUUID().replace(/-/gu, '')}`;
    db.prepare(`
      INSERT INTO trigger_preapprovals
        (id, trigger_kind, trigger_ref, door_contract_id, recipe_id, recipe_sha256, prompt_sha256, writes, max_per_run, uses,
         created_at, run_id, browsers, nested)
      VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, ?, 0, ?, ?, ?, ?)
    `).run(id, input.caller.kind, preapprovalCallerRef(input.caller), input.recipe_id, input.recipe_sha256,
      JSON.stringify([TRIGGER_PREAPPROVAL_ALL_WRITES]), TRIGGER_PREAPPROVAL_WHOLE_RECIPE, input.now, input.run_id ?? null,
      input.browsers !== undefined && Object.keys(input.browsers).length > 0 ? JSON.stringify(input.browsers) : null,
      input.nested !== undefined && Object.keys(input.nested).length > 0 ? JSON.stringify(input.nested) : null);
    return toCallerRow(selectCaller(id)!);
  };

  const insertGrant = (input: TriggerPreapprovalGrantInput): TriggerPreapprovalRow => {
    const id = `tpa_${randomUUID().replace(/-/gu, '')}`;
    db.prepare(`
      INSERT INTO trigger_preapprovals
        (id, trigger_kind, trigger_ref, door_contract_id, recipe_id, recipe_sha256, prompt_sha256, writes, max_per_run, uses,
         created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(id, input.trigger.kind, triggerRefOf(input.trigger), input.door_contract_id ?? null, input.recipe_id, input.recipe_sha256,
      input.prompt_sha256 ?? null, JSON.stringify(input.writes), input.max_per_run, input.now);
    return toRow(select.get(id) as Row);
  };
  const getDecision = (decision: TriggerPreapprovalGrantDecision): TriggerPreapprovalRow | undefined => {
    if (!decision.approval_ref || !/^[a-f0-9]{64}$/.test(decision.offer_sha256)) {
      throw new TriggerPreapprovalError('bad_request', 'invalid trigger approval decision');
    }
    const saved = db.prepare('SELECT * FROM trigger_preapproval_decisions WHERE approval_ref=?')
      .get(decision.approval_ref) as { offer_sha256: string; preapproval_id: string } | undefined;
    if (saved === undefined) return undefined;
    if (saved.offer_sha256 !== decision.offer_sha256) {
      throw new TriggerPreapprovalError('bad_request', 'trigger approval identity was reused with a different offer');
    }
    const row = select.get(saved.preapproval_id) as Row | undefined;
    if (row === undefined) throw new TriggerPreapprovalError('not_found', 'trigger approval refers to a missing pre-approval');
    return toRow(row);
  };
  const grantForDecision = db.transaction((input: TriggerPreapprovalGrantInput, decision: TriggerPreapprovalGrantDecision) => {
    const prior = getDecision(decision);
    if (prior !== undefined) return { row: prior, created: false };
    const covering = (db.prepare(`SELECT * FROM trigger_preapprovals WHERE trigger_kind NOT IN (${CALLER_KINDS_SQL})
      ORDER BY created_at DESC, id DESC`).all() as Row[])
      .map(toRow).find(row => input.writes.every(op => triggerPreapprovalCovers(row, { ...input, op })));
    const row = covering ?? insertGrant(input);
    db.prepare('INSERT INTO trigger_preapproval_decisions VALUES(?,?,?)')
      .run(decision.approval_ref, decision.offer_sha256, row.id);
    return { row, created: covering === undefined };
  });

  // D-402 slice F5 — told after the change is written, never inside its transaction.
  const listeners = new Set<(change: PreapprovalChange) => void>();
  const tell = (change: PreapprovalChange): void => {
    for (const listener of listeners) {
      try { listener(change); } catch { /* a listener that throws changes nothing */ }
    }
  };
  return {
    grant: (input) => {
      const row = insertGrant(input);
      tell({ change: 'granted', id: row.id, holder: 'trigger' });
      return row;
    },
    getDecision,
    grantForDecision: (input, decision) => {
      const bound = grantForDecision.immediate(input, decision);
      if (bound.created) tell({ change: 'granted', id: bound.row.id, holder: 'trigger' });
      return bound;
    },
    list() {
      return (db.prepare(`SELECT * FROM trigger_preapprovals WHERE trigger_kind NOT IN (${CALLER_KINDS_SQL})
        ORDER BY created_at DESC, id DESC`).all() as Row[]).map(toRow);
    },
    get(id) {
      const row = select.get(id) as Row | undefined;
      return row === undefined ? undefined : toRow(row);
    },
    revoke(id, now) {
      const row = select.get(id) as Row | undefined;
      if (row === undefined) throw new TriggerPreapprovalError('not_found', `no pre-approval ${id}`);
      if (row.revoked_at === null) {
        db.prepare('UPDATE trigger_preapprovals SET revoked_at = ? WHERE id = ?').run(now, id);
        tell({ change: 'ended', id, holder: 'trigger' });
      }
      return toRow(select.get(id) as Row);
    },
    use: (call, now) => {
      const used = use(call, now);
      if (used !== undefined) tell({ change: 'used', id: used.id, holder: 'trigger' });
      return used;
    },
    runUses(id, run_id) {
      return (runUses.get(id, run_id) as { uses: number }).uses;
    },
    runWrites(run_id) {
      return runWrites.all(run_id) as Array<{ preapproval_id: string; op: string; uses: number }>;
    },
    grantCaller: (input) => {
      const row = insertCaller(input);
      tell({ change: 'granted', id: row.id, holder: 'caller' });
      return row;
    },
    useCaller: (call, now) => {
      const used = useCaller(call, now);
      if (used !== undefined) tell({ change: 'used', id: used.id, holder: 'caller' });
      return used;
    },
    listCallers() {
      return (db.prepare(`SELECT * FROM trigger_preapprovals WHERE trigger_kind IN (${CALLER_KINDS_SQL})
        ORDER BY created_at DESC, id DESC`).all() as Row[]).map(toCallerRow);
    },
    getCaller(id) {
      const row = selectCaller(id);
      return row === undefined ? undefined : toCallerRow(row);
    },
    revokeCaller(id, now) {
      const row = selectCaller(id);
      if (row === undefined) throw new TriggerPreapprovalError('not_found', `no pre-approval ${id}`);
      if (row.revoked_at === null) {
        db.prepare('UPDATE trigger_preapprovals SET revoked_at = ? WHERE id = ?').run(now, id);
        tell({ change: 'ended', id, holder: 'caller' });
      }
      return toCallerRow(selectCaller(id)!);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
};

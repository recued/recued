import type Database from 'better-sqlite3';
import type { Asset, AssetReading, AssetRule, Commitment } from '@recued/contracts';

/** Identity and service receipts only. Due and lifecycle are read from the
 * canonical commitment, never copied into this table. */
export interface AssetOccurrence {
  id: string;
  asset_id: string;
  /** Absent on legacy asset receipts. Occasion ids refer to the private
   * proactive store, never to an asset or a new WorkEntity kind. */
  subject_kind?: 'asset' | 'occasion';
  rule_id: string;
  cycle: string;
  commitment_id: string | null;
  question: boolean;
  trigger_kind: 'rule' | 'retirement';
  created_at: number;
  close_processed_at: number | null;
  rearmed_at: number | null;
}
export interface OccurrenceCloseOutcome { occurrence: AssetOccurrence; commitment: Commitment; asset: Asset; rule?: AssetRule }
export const createAssetOccurrenceStore = (db: Database.Database) => {
  db.exec(`CREATE TABLE IF NOT EXISTS asset_occurrences (
    id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, rule_id TEXT NOT NULL, cycle TEXT NOT NULL,
    commitment_id TEXT UNIQUE, question INTEGER NOT NULL,
    trigger_kind TEXT NOT NULL, created_at INTEGER NOT NULL,
    close_processed_at INTEGER, rearmed_at INTEGER,
    UNIQUE(asset_id,rule_id,cycle)
  );
  CREATE INDEX IF NOT EXISTS asset_occurrence_asset_rule ON asset_occurrences(asset_id,rule_id,created_at);
  CREATE TABLE IF NOT EXISTS occurrence_rule_events (
    occurrence_id TEXT PRIMARY KEY, at INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS occurrence_close_events (
    occurrence_id TEXT PRIMARY KEY, payload TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS occurrence_completion_evidence (
    occurrence_id TEXT PRIMARY KEY, answered_at INTEGER NOT NULL, reading TEXT
  );`);
  const completionColumns = new Set((db.prepare('PRAGMA table_info(occurrence_completion_evidence)').all() as { name: string }[]).map(row => row.name));
  if (!completionColumns.has('known')) db.exec('ALTER TABLE occurrence_completion_evidence ADD COLUMN known INTEGER NOT NULL DEFAULT 1');
  if (!completionColumns.has('confirmed_on')) db.exec('ALTER TABLE occurrence_completion_evidence ADD COLUMN confirmed_on TEXT');
  if (!completionColumns.has('owner_action')) db.exec('ALTER TABLE occurrence_completion_evidence ADD COLUMN owner_action INTEGER NOT NULL DEFAULT 0');
  db.exec(`CREATE TABLE IF NOT EXISTS occurrence_service_evidence (
    id TEXT PRIMARY KEY,asset_id TEXT NOT NULL,rule_id TEXT NOT NULL,on_date TEXT NOT NULL,evidence_ref TEXT NOT NULL,at INTEGER NOT NULL
  )`);
  const columns = new Set((db.prepare('PRAGMA table_info(asset_occurrences)').all() as { name: string }[]).map(row => row.name));
  if (!columns.has('reaction_kind')) db.transaction(() => {
    db.exec(`ALTER TABLE asset_occurrences RENAME TO asset_occurrences_legacy;
      CREATE TABLE asset_occurrences (
        id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, subject_kind TEXT NOT NULL DEFAULT 'asset',
        reaction_kind TEXT NOT NULL,
        rule_id TEXT NOT NULL, cycle TEXT NOT NULL, commitment_id TEXT UNIQUE, question INTEGER NOT NULL,
        trigger_kind TEXT NOT NULL, created_at INTEGER NOT NULL, close_processed_at INTEGER, rearmed_at INTEGER,
        UNIQUE(subject_kind,asset_id,rule_id,cycle,reaction_kind)
      );
      INSERT INTO asset_occurrences(id,asset_id,subject_kind,reaction_kind,rule_id,cycle,commitment_id,question,trigger_kind,created_at,close_processed_at,rearmed_at)
        SELECT id,asset_id,${columns.has('subject_kind') ? 'subject_kind' : "'asset'"},CASE WHEN commitment_id IS NULL THEN 'notice' ELSE 'action' END,
          rule_id,cycle,commitment_id,question,trigger_kind,created_at,close_processed_at,rearmed_at FROM asset_occurrences_legacy;
      DROP TABLE asset_occurrences_legacy;
      CREATE INDEX asset_occurrence_asset_rule ON asset_occurrences(subject_kind,asset_id,rule_id,created_at);`);
  })();
  type Row = Omit<AssetOccurrence, 'question'> & { question: number; reaction_kind: string };
  const decode = ({ subject_kind, reaction_kind: _reaction, ...row }: Row): AssetOccurrence => ({ ...row, question: row.question === 1,
    ...(subject_kind === 'occasion' ? { subject_kind } : {}) });
  const get = (id: string): AssetOccurrence | null => {
    const row = db.prepare('SELECT * FROM asset_occurrences WHERE id=?').get(id) as Row | undefined;
    return row ? decode(row) : null;
  };
  /** Same DTOs and per-asset order as byAsset, with bounded reads and no cache. */
  const byAssets = (asset_ids: readonly string[]): Map<string, AssetOccurrence[]> => {
    const keys = [...new Set(asset_ids)]; const result = new Map(keys.map(id => [id, [] as AssetOccurrence[]]));
    for (let offset = 0; offset < keys.length; offset += 200) {
      const page = keys.slice(offset, offset + 200);
      const rows = db.prepare(`SELECT * FROM asset_occurrences WHERE subject_kind='asset' AND asset_id IN (${page.map(() => '?').join(',')})
        ORDER BY asset_id,created_at DESC,id DESC`).all(...page) as Row[];
      for (const row of rows) result.get(row.asset_id)!.push(decode(row));
    }
    return result;
  };
  return {
    get,
    byCommitment: (id: string): AssetOccurrence | null => {
      const row = db.prepare('SELECT * FROM asset_occurrences WHERE commitment_id=?').get(id) as Row | undefined;
      return row ? decode(row) : null;
    },
    byAsset: (asset_id: string): AssetOccurrence[] => (db.prepare("SELECT * FROM asset_occurrences WHERE subject_kind='asset' AND asset_id=? ORDER BY created_at DESC,id DESC").all(asset_id) as Row[]).map(decode),
    byAssets,
    byOccasion: (id: string): AssetOccurrence[] => (db.prepare("SELECT * FROM asset_occurrences WHERE subject_kind='occasion' AND asset_id=? ORDER BY created_at DESC,id DESC").all(id) as Row[]).map(decode),
    all: (): AssetOccurrence[] => (db.prepare('SELECT * FROM asset_occurrences ORDER BY created_at,id').all() as Row[]).map(decode),
    questionCommitments: (): string[] => (db.prepare('SELECT commitment_id FROM asset_occurrences WHERE question=1 AND commitment_id IS NOT NULL')
      .all() as { commitment_id: string }[]).map(row => row.commitment_id),
    completion(id: string): { answered_at: number; reading: AssetReading | null; known?: false; confirmed_on?: string; owner_action?: true } | null {
      const row = db.prepare('SELECT answered_at,reading,known,confirmed_on,owner_action FROM occurrence_completion_evidence WHERE occurrence_id=?')
        .get(id) as { answered_at: number; reading: string | null; known: number; confirmed_on: string | null; owner_action: number } | undefined;
      return row ? { answered_at: row.answered_at, reading: row.reading ? JSON.parse(row.reading) : null,
        ...(row.known === 0 ? { known: false as const } : {}), ...(row.confirmed_on ? { confirmed_on: row.confirmed_on } : {}), ...(row.owner_action === 1 ? { owner_action: true as const } : {}) } : null;
    },
    recordCompletion(id: string, answered_at: number, reading: AssetReading | null, known = true, owner_action = false): void {
      db.prepare('INSERT OR IGNORE INTO occurrence_completion_evidence(occurrence_id,answered_at,reading,known,owner_action) VALUES(?,?,?,?,?)')
        .run(id, answered_at, reading ? JSON.stringify(reading) : null, Number(known), Number(owner_action));
    },
    confirmCompletion(id: string, on: string, reading: AssetReading | null): void {
      db.prepare('UPDATE occurrence_completion_evidence SET known=1,owner_action=1,confirmed_on=?,reading=? WHERE occurrence_id=? AND (known=0 OR owner_action=0)')
        .run(on, reading ? JSON.stringify(reading) : null, id);
    },
    recordService(input: { id: string; asset_id: string; rule_id: string; on: string; evidence_ref: string; at: number }): void {
      db.prepare('INSERT OR IGNORE INTO occurrence_service_evidence(id,asset_id,rule_id,on_date,evidence_ref,at) VALUES(?,?,?,?,?,?)')
        .run(input.id, input.asset_id, input.rule_id, input.on, input.evidence_ref, input.at);
    },
    services(): Array<{ id: string; asset_id: string; rule_id: string; on_date: string; evidence_ref: string; at: number }> {
      return db.prepare('SELECT * FROM occurrence_service_evidence ORDER BY on_date,id').all() as Array<{ id: string; asset_id: string; rule_id: string; on_date: string; evidence_ref: string; at: number }>;
    },
    ensure(input: Omit<AssetOccurrence, 'close_processed_at' | 'rearmed_at'>): AssetOccurrence {
      db.prepare(`INSERT INTO asset_occurrences(id,asset_id,subject_kind,reaction_kind,rule_id,cycle,commitment_id,question,trigger_kind,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(subject_kind,asset_id,rule_id,cycle,reaction_kind) DO NOTHING`)
        .run(input.id, input.asset_id, input.subject_kind ?? 'asset', input.commitment_id ? 'action' : 'notice', input.rule_id, input.cycle, input.commitment_id,
          input.question ? 1 : 0, input.trigger_kind, input.created_at);
      const row = get(input.id);
      if (!row || row.asset_id !== input.asset_id || row.rule_id !== input.rule_id || row.cycle !== input.cycle
        || (row.subject_kind ?? 'asset') !== (input.subject_kind ?? 'asset') || row.commitment_id !== input.commitment_id) throw new Error('Occurrence identity conflict');
      return row;
    },
    markCloseProcessed(id: string, at: number): void { db.prepare('UPDATE asset_occurrences SET close_processed_at=? WHERE id=? AND close_processed_at IS NULL').run(at, id); },
    rearm(id: string, at: number): void { db.prepare('UPDATE asset_occurrences SET rearmed_at=? WHERE id=? AND (rearmed_at IS NULL OR rearmed_at<?)').run(at, id, at); },
    queueRuleEvent(id: string, at: number): void { db.prepare('INSERT OR IGNORE INTO occurrence_rule_events(occurrence_id,at) VALUES(?,?)').run(id, at); },
    pendingRuleEvents: (): Array<{ occurrence_id: string; at: number }> => db.prepare('SELECT occurrence_id,at FROM occurrence_rule_events WHERE delivered=0 ORDER BY at,occurrence_id').all() as Array<{ occurrence_id: string; at: number }>,
    acknowledgeRuleEvent(id: string): void { db.prepare('UPDATE occurrence_rule_events SET delivered=1 WHERE occurrence_id=?').run(id); },
    queueCloseOutcome(outcome: OccurrenceCloseOutcome): void {
      db.prepare('INSERT OR IGNORE INTO occurrence_close_events(occurrence_id,payload) VALUES(?,?)').run(outcome.occurrence.id, JSON.stringify(outcome));
    },
    pendingCloseOutcomes: (): OccurrenceCloseOutcome[] => (db.prepare('SELECT payload FROM occurrence_close_events WHERE delivered=0 ORDER BY occurrence_id').all() as { payload: string }[]).map(row => JSON.parse(row.payload)),
    acknowledgeCloseOutcome(id: string): void { db.prepare('UPDATE occurrence_close_events SET delivered=1 WHERE occurrence_id=?').run(id); },
    /** Retention: a delivered close outcome was processed, and `close_processed_at`,
     * set as it was queued, stops a second. A rule event stays with its occurrence:
     * the clock queues its cycle's event again on every pass. */
    pruneDelivered: (): number => db.prepare('DELETE FROM occurrence_close_events WHERE delivered=1').run().changes,
    /** Retention: the learner reads confirmed services for its lookback. */
    pruneServices: (before: number): number => db.prepare('DELETE FROM occurrence_service_evidence WHERE at<?').run(before).changes,
    /** Retention: when the cycle itself last changed, and whether an event for it waits. */
    lastActivity: (id: string): number => (db.prepare(`SELECT max(coalesce(o.close_processed_at,0),coalesce(o.rearmed_at,0),o.created_at,
      coalesce((SELECT answered_at FROM occurrence_completion_evidence WHERE occurrence_id=o.id),0),
      coalesce((SELECT at FROM occurrence_rule_events WHERE occurrence_id=o.id),0)) AS at FROM asset_occurrences o WHERE o.id=?`).get(id) as { at: number } | undefined)?.at ?? 0,
    undelivered: (id: string): boolean => !!db.prepare(`SELECT 1 FROM occurrence_rule_events WHERE occurrence_id=@id AND delivered=0
      UNION ALL SELECT 1 FROM occurrence_close_events WHERE occurrence_id=@id AND delivered=0`).get({ id }),
    remove: (id: string): void => db.transaction(() => {
      for (const table of ['occurrence_completion_evidence', 'occurrence_rule_events', 'occurrence_close_events']) db.prepare(`DELETE FROM ${table} WHERE occurrence_id=?`).run(id);
      db.prepare('DELETE FROM asset_occurrences WHERE id=?').run(id);
    })(),
  };
};
export type AssetOccurrenceStore = ReturnType<typeof createAssetOccurrenceStore>;

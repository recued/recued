import type Database from 'better-sqlite3';
import type { SituationRef, Sphere } from '@recued/contracts';
import type { ClockLearningSignal, KindLearningSignal } from '../situations/learning.js';

export interface LearnedSituationRelation { key: string; from: 'trip'; target_class: string; sphere?: Sphere; evidence: SituationRef[] }
export const createProactiveLearningStore = (db: Database.Database) => {
  db.exec(`CREATE TABLE IF NOT EXISTS proactive_learning_signals (id TEXT PRIMARY KEY,pool TEXT NOT NULL,at INTEGER NOT NULL,value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS proactive_learning_pool ON proactive_learning_signals(pool,at);
    CREATE TABLE IF NOT EXISTS proactive_ranking (pool TEXT PRIMARY KEY,factor REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS proactive_relations (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS proactive_navigation_context (owner_client TEXT PRIMARY KEY,at INTEGER NOT NULL,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS proactive_relation_evidence (id TEXT PRIMARY KEY,target_class TEXT NOT NULL,sphere TEXT NOT NULL,value TEXT NOT NULL);`);
  return {
    record(signal: ClockLearningSignal): void {
      if (!['fulfilled', 'dismissed', 'lapsed'].includes(signal.outcome) || !['owner', 'system'].includes(signal.actor)
        || signal.actor === 'system' && signal.outcome !== 'lapsed' || !Number.isSafeInteger(signal.at)) throw new Error('Learning requires an owner outcome or a canonical lapse');
      db.prepare('INSERT OR IGNORE INTO proactive_learning_signals(id,pool,at,value) VALUES(?,?,?,?)').run(signal.id, signal.pool, signal.at, JSON.stringify(signal));
    },
    /** D-325 §8 — what the owner did with a Today item of a kind no rule raises. */
    recordKind(signal: KindLearningSignal): void {
      if (!['opened', 'dismissed'].includes(signal.outcome) || signal.actor !== 'owner' || !signal.kind
        || signal.pool !== JSON.stringify(['kind', signal.kind]) || !Number.isSafeInteger(signal.at)) throw new Error('Learning requires an owner outcome on a kind');
      db.prepare('INSERT OR IGNORE INTO proactive_learning_signals(id,pool,at,value) VALUES(?,?,?,?)').run(signal.id, signal.pool, signal.at, JSON.stringify(signal));
    },
    kindSignals(since: number): KindLearningSignal[] {
      return (db.prepare(`SELECT value FROM proactive_learning_signals WHERE pool LIKE '["kind",%' AND at>=? ORDER BY at,id`).all(since) as { value: string }[]).map(row => JSON.parse(row.value));
    },
    /** Undo of an answer takes back what it taught. */
    forget(id: string): void { db.prepare('DELETE FROM proactive_learning_signals WHERE id=?').run(id); },
    signals(pool: string, since: number): ClockLearningSignal[] {
      return (db.prepare('SELECT value FROM proactive_learning_signals WHERE pool=? AND at>=? ORDER BY at,id').all(pool, since) as { value: string }[]).map(row => JSON.parse(row.value));
    },
    weight(pool: string): number { return (db.prepare('SELECT factor FROM proactive_ranking WHERE pool=?').get(pool) as { factor: number } | undefined)?.factor ?? 1; },
    setWeight(pool: string, factor: number): void {
      if (!Number.isFinite(factor) || factor < 0.5 || factor > 1.5) throw new Error('Ranking factor must be from 0.5 to 1.5');
      db.prepare('INSERT INTO proactive_ranking(pool,factor) VALUES(?,?) ON CONFLICT(pool) DO UPDATE SET factor=excluded.factor').run(pool, factor);
    },
    relations(): LearnedSituationRelation[] { return (db.prepare('SELECT value FROM proactive_relations ORDER BY key').all() as { value: string }[]).map(row => JSON.parse(row.value)); },
    setRelation(value: LearnedSituationRelation): void {
      if (value.from !== 'trip' || !value.target_class || !value.key || value.sphere !== undefined && !['personal', 'professional'].includes(value.sphere)) throw new Error('Choose the class and sphere for the trip relation');
      db.prepare('INSERT INTO proactive_relations(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(value.key, JSON.stringify(value));
    },
    context(client: string): { at: number; ref: SituationRef; sphere?: Sphere } | null {
      const row = db.prepare('SELECT at,value FROM proactive_navigation_context WHERE owner_client=?').get(client) as { at: number; value: string } | undefined;
      return row ? { at: row.at, ...JSON.parse(row.value) } : null;
    },
    setContext(client: string, ref: SituationRef, sphere: Sphere | undefined, at: number): void {
      db.prepare('INSERT INTO proactive_navigation_context(owner_client,at,value) VALUES(?,?,?) ON CONFLICT(owner_client) DO UPDATE SET at=excluded.at,value=excluded.value')
        .run(client, at, JSON.stringify({ ref, ...(sphere ? { sphere } : {}) }));
      db.prepare('DELETE FROM proactive_navigation_context WHERE at<?').run(at - 300_000);
    },
    clearContext(client: string): void { db.prepare('DELETE FROM proactive_navigation_context WHERE owner_client=?').run(client); },
    relationEvidence(input: { id: string; target_class: string; sphere?: Sphere; from: SituationRef; target: SituationRef; at: number }): void {
      db.prepare('INSERT OR IGNORE INTO proactive_relation_evidence(id,target_class,sphere,value) VALUES(?,?,?,?)').run(input.id, input.target_class, input.sphere ?? 'unsorted', JSON.stringify(input));
    },
    relationGroups(): Array<{ target_class: string; sphere?: Sphere; evidence: Array<{ from: SituationRef; target: SituationRef; at: number }> }> {
      const groups = new Map<string, { target_class: string; sphere?: Sphere; evidence: Array<{ from: SituationRef; target: SituationRef; at: number }> }>();
      for (const row of db.prepare('SELECT target_class,sphere,value FROM proactive_relation_evidence ORDER BY id').all() as { target_class: string; sphere: string; value: string }[]) {
        const key = JSON.stringify([row.target_class, row.sphere]); const group = groups.get(key) ?? { target_class: row.target_class, ...(row.sphere !== 'unsorted' ? { sphere: row.sphere as Sphere } : {}), evidence: [] };
        group.evidence.push(JSON.parse(row.value)); groups.set(key, group);
      }
      return [...groups.values()];
    },
    /** Retention: signals and relation evidence older than the learner reads, and
     * the evidence of a relation question already settled. */
    prune(input: { signalsBefore: number; evidenceBefore: number; settled(target_class: string, sphere: Sphere | undefined): boolean }): { signals: number; evidence: number } {
      return db.transaction(() => {
        const signals = db.prepare('DELETE FROM proactive_learning_signals WHERE at<?').run(input.signalsBefore).changes;
        let evidence = db.prepare("DELETE FROM proactive_relation_evidence WHERE json_extract(value,'$.at')<?").run(input.evidenceBefore).changes;
        for (const group of db.prepare('SELECT DISTINCT target_class,sphere FROM proactive_relation_evidence').all() as { target_class: string; sphere: string }[]) {
          if (input.settled(group.target_class, group.sphere === 'unsorted' ? undefined : group.sphere as Sphere)) {
            evidence += db.prepare('DELETE FROM proactive_relation_evidence WHERE target_class=? AND sphere=?').run(group.target_class, group.sphere).changes;
          }
        }
        return { signals, evidence };
      })();
    },
  };
};
export type ProactiveLearningStore = ReturnType<typeof createProactiveLearningStore>;

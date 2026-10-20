import type Database from 'better-sqlite3';
import type { SituationRevision, SituationSnapshot, SituationState } from '@recued/contracts';
import type { WarehouseEvent, WarehouseEventBus } from '@recued/warehouse-events';

export const ensureSituationSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS situations (
      id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS situation_revisions (
      revision INTEGER PRIMARY KEY AUTOINCREMENT, situation_id TEXT NOT NULL,
      at INTEGER NOT NULL, cause TEXT NOT NULL, changed_fields TEXT NOT NULL,
      before_snapshot TEXT, after_snapshot TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS situation_revisions_subject ON situation_revisions(situation_id, revision);
    CREATE TABLE IF NOT EXISTS situation_subscribers (
      subscriber_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS situation_subscriber_runs (
      subscriber_id TEXT NOT NULL, revision INTEGER NOT NULL, run_id TEXT NOT NULL,
      state TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(subscriber_id,revision)
    );
    CREATE TABLE IF NOT EXISTS proactive_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS proactive_measures (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, name TEXT NOT NULL,
      value REAL NOT NULL, dimensions TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proactive_measure_receipts (receipt TEXT PRIMARY KEY);
  `);
  // A receipt keeps its event's time so retention can drop it. One written before
  // that takes the latest measure's, which is no earlier than its own event.
  if (!(db.prepare('PRAGMA table_info(proactive_measure_receipts)').all() as { name: string }[]).some(column => column.name === 'at')) {
    db.exec('ALTER TABLE proactive_measure_receipts ADD COLUMN at INTEGER');
    db.exec('UPDATE proactive_measure_receipts SET at=(SELECT max(at) FROM proactive_measures)');
  }
};

/** Stable object keys and semantic fields only. An adapter's fresh read time
 * cannot make an unchanged situation look new every time the service runs. */
const stable = (value: unknown): string => {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input)
      .filter(([key, field]) => key !== 'updated_at' && field !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, field]) => [key, normalize(field)]));
    return input;
  };
  return JSON.stringify(normalize(value));
};
interface RevisionRow { revision: number; situation_id: string; at: number; cause: string; changed_fields: string; before_snapshot: string | null; after_snapshot: string }
const readRevision = (row: RevisionRow): SituationRevision => ({
  revision: row.revision, situation_id: row.situation_id, at: row.at,
  cause: JSON.parse(row.cause), changed_fields: JSON.parse(row.changed_fields),
  before: row.before_snapshot ? JSON.parse(row.before_snapshot) : null, after: JSON.parse(row.after_snapshot),
});
export const situationRevisionEvent = (revision: SituationRevision): WarehouseEvent => ({
  platform: 'situation', slug: 'windows', entity_type: 'situation',
  event_kind: revision.before === null ? 'created' : revision.before.state !== revision.after.state ? 'state_changed' : 'updated',
  record_id: revision.situation_id, at: revision.at, record: revision.after as unknown as Record<string, unknown>,
  changed_fields: revision.changed_fields,
  prev: { record: revision.before, revision: revision.revision, cause: revision.cause, changed_fields: revision.changed_fields },
});
const states: ReadonlySet<SituationState> = new Set(['new', 'proposed', 'accepted', 'dismissed', 'resolved']);
export interface SituationStore {
  get(id: string): { snapshot: SituationSnapshot; revision: number } | null;
  list(limit?: number): Array<{ snapshot: SituationSnapshot; revision: number }>;
  walk(after_id?: string, limit?: number): Array<{ snapshot: SituationSnapshot; revision: number }>;
  /** Owns its transaction: the durable revision precedes every doorbell. */
  save(snapshot: SituationSnapshot, cause: SituationRevision['cause'], at: number): SituationRevision | null;
  /** §4.9 — a forgotten situation keeps its revision numbers and states, and nothing
   * else, so the withdrawal that follows carries no copy of what was forgotten. */
  forget(situation_id: string): void;
  /** Retention: a revision older than `before` goes once every subscriber still
   * listed has handled it; one with no checkpoint yet holds them all. A completed
   * run's receipt goes once its checkpoint passes it, a run in doubt stays until
   * the owner reconciles it, and an unlisted subscriber's checkpoint goes. A
   * resolved situation last changed before `before` goes too: if it comes back,
   * it is new again, as a resolved one would be. */
  prune(input: { before: number; subscribers: readonly string[] }): { revisions: number; runs: number; checkpoints: number; situations: number };
  /** Retention for a producer that re-lists its situations: those of `ids` still
   * new go. One in any other state stays, since it carries the owner's answer. */
  dropNew(ids: readonly string[]): number;
  /** Retention for opt-in measures: a measure older than `before` goes with its
   * receipt, and an event that old is refused from then on, so a producer that
   * rescans its history cannot count it twice. */
  pruneMeasures(before: number): { measures: number; measure_receipts: number };
  revisionsAfter(revision: number, limit?: number): SituationRevision[];
  checkpoint(subscriber: string): number;
  acknowledge(subscriber: string, revision: number): void;
  subscriberRun(subscriber: string, revision: number): { run_id: string; state: 'started' | 'completed' | 'in_doubt' } | null;
  beginSubscriberRun(subscriber: string, revision: number, run_id: string, at: number): boolean;
  finishSubscriberRun(subscriber: string, revision: number, state: 'completed' | 'in_doubt', at: number): void;
  /** One consumer at a time per subscriber, failure leaves its checkpoint. */
  catchUp(subscriber: string, receive: (revision: SituationRevision) => Promise<boolean>, options?: {
    isOpen?: () => boolean; cause_source?: string; limit?: number;
  }): Promise<number>;
  readSetting<T>(key: string, fallback: T): T;
  writeSetting(key: string, value: unknown): void;
  measure(name: string, value: number, dimensions: Record<string, string | number | boolean>, at: number, receipt?: string): boolean;
}

export const createSituationStore = (db: Database.Database, bus?: Pick<WarehouseEventBus, 'emit'>): SituationStore => {
  ensureSituationSchema(db);
  const get: SituationStore['get'] = id => {
    const row = db.prepare('SELECT snapshot, revision FROM situations WHERE id=?').get(id) as { snapshot: string; revision: number } | undefined;
    return row ? { snapshot: JSON.parse(row.snapshot), revision: row.revision } : null;
  };
  const revisionsAfter: SituationStore['revisionsAfter'] = (revision, limit = 100) => {
    if (!Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid situation revision cursor');
    return (db.prepare('SELECT * FROM situation_revisions WHERE revision>? ORDER BY revision LIMIT ?').all(revision, limit) as RevisionRow[]).map(readRevision);
  };
  const checkpoint: SituationStore['checkpoint'] = subscriber =>
    (db.prepare('SELECT revision FROM situation_subscribers WHERE subscriber_id=?').get(subscriber) as { revision: number } | undefined)?.revision ?? 0;
  const inFlight = new Set<string>();
  const readSetting: SituationStore['readSetting'] = <T>(key: string, fallback: T): T => {
    const row = db.prepare('SELECT value FROM proactive_settings WHERE key=?').get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : fallback;
  };
  const writeSetting: SituationStore['writeSetting'] = (key, value) => {
    if (!key.trim() || key.length > 200) throw new Error('Invalid proactive setting');
    const encoded = JSON.stringify(value);
    if (encoded === undefined || encoded.length > 128_000) throw new Error('Invalid proactive setting value');
    db.prepare(`INSERT INTO proactive_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, encoded);
  };
  const acknowledge: SituationStore['acknowledge'] = (subscriber, revision) => {
    db.transaction(() => {
      const current = checkpoint(subscriber);
      if (revision <= current) return;
      if (revisionsAfter(current, 1)[0]?.revision !== revision) throw new Error('Situation checkpoints advance in feed order');
      db.prepare(`INSERT INTO situation_subscribers(subscriber_id,revision) VALUES(?,?)
        ON CONFLICT(subscriber_id) DO UPDATE SET revision=excluded.revision`).run(subscriber, revision);
    })();
  };
  return {
    get,
    walk: (after_id = '', limit = 500) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid situation walk limit');
      return (db.prepare('SELECT snapshot,revision FROM situations WHERE id>? ORDER BY id LIMIT ?').all(after_id, limit) as { snapshot: string; revision: number }[])
        .map(row => ({ snapshot: JSON.parse(row.snapshot), revision: row.revision }));
    },
    list: (limit = 100) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid situation list limit');
      return (db.prepare('SELECT snapshot,revision FROM situations ORDER BY updated_at DESC,id LIMIT ?').all(limit) as { snapshot: string; revision: number }[])
        .map(row => ({ snapshot: JSON.parse(row.snapshot), revision: row.revision }));
    },
    save(snapshot, cause, at) {
      if (db.inTransaction) throw new Error('Situation save owns the commit before publishing');
      if (!snapshot.id || snapshot.id !== snapshot.cluster.id || !states.has(snapshot.state)
        || !Number.isSafeInteger(at) || !cause.source?.trim()) throw new Error('Invalid situation snapshot or cause');
      if (snapshot.state === 'dismissed' && !['not_now', 'not_this_one', 'never_this_kind', 'wrong'].includes(snapshot.dismissal ?? '')) throw new Error('A dismissal needs a code');
      const revision = db.transaction(() => {
        const before = get(snapshot.id)?.snapshot ?? null;
        if (before && stable(before) === stable(snapshot)) return null;
        const changed_fields = before === null ? Object.keys(snapshot).sort()
          : [...new Set([...Object.keys(before), ...Object.keys(snapshot)])].filter(key => stable(before[key as keyof SituationSnapshot]) !== stable(snapshot[key as keyof SituationSnapshot])).sort();
        const result = db.prepare(`INSERT INTO situation_revisions(situation_id,at,cause,changed_fields,before_snapshot,after_snapshot)
          VALUES(?,?,?,?,?,?)`).run(snapshot.id, at, JSON.stringify(cause), JSON.stringify(changed_fields), before ? JSON.stringify(before) : null, JSON.stringify(snapshot));
        const number = Number(result.lastInsertRowid);
        db.prepare(`INSERT INTO situations(id,snapshot,revision,updated_at) VALUES(?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot,revision=excluded.revision,updated_at=excluded.updated_at`)
          .run(snapshot.id, JSON.stringify(snapshot), number, at);
        return { revision: number, situation_id: snapshot.id, at, cause, changed_fields, before, after: snapshot };
      })();
      if (revision) { try { bus?.emit(situationRevisionEvent(revision)); } catch { /* Durable feed owns catch-up. */ } }
      return revision;
    },
    forget(id) {
      const bare = (value: string | null): string | null => {
        if (value === null) return null;
        const snapshot = JSON.parse(value) as SituationSnapshot;
        return JSON.stringify({ id: snapshot.id, state: snapshot.state, urgency: snapshot.urgency,
          ...(snapshot.dismissal ? { dismissal: snapshot.dismissal } : {}),
          cluster: { id: snapshot.cluster.id, subjects: [], span: null, omitted: 0, items: [] } });
      };
      db.transaction(() => {
        for (const row of db.prepare('SELECT revision,before_snapshot,after_snapshot FROM situation_revisions WHERE situation_id=?').all(id) as
          { revision: number; before_snapshot: string | null; after_snapshot: string }[]) {
          db.prepare('UPDATE situation_revisions SET before_snapshot=?,after_snapshot=? WHERE revision=?').run(bare(row.before_snapshot), bare(row.after_snapshot), row.revision);
        }
        const current = db.prepare('SELECT snapshot FROM situations WHERE id=?').get(id) as { snapshot: string } | undefined;
        if (current) db.prepare('UPDATE situations SET snapshot=? WHERE id=?').run(bare(current.snapshot), id);
      })();
    },
    prune({ before, subscribers }) {
      if (!Number.isSafeInteger(before) || subscribers.some(subscriber => !subscriber.trim())) throw new Error('Invalid situation retention');
      const listed = JSON.stringify([...new Set(subscribers)]);
      return db.transaction(() => {
        const handled = subscribers.reduce((lowest, subscriber) => Math.min(lowest, checkpoint(subscriber)), Number.MAX_SAFE_INTEGER);
        const revisions = db.prepare('DELETE FROM situation_revisions WHERE revision<=? AND at<?').run(handled, before).changes;
        const runs = db.prepare(`DELETE FROM situation_subscriber_runs WHERE state='completed' AND (subscriber_id NOT IN (SELECT value FROM json_each(?))
          OR revision<=(SELECT revision FROM situation_subscribers WHERE subscriber_id=situation_subscriber_runs.subscriber_id))`).run(listed).changes;
        const checkpoints = db.prepare('DELETE FROM situation_subscribers WHERE subscriber_id NOT IN (SELECT value FROM json_each(?))').run(listed).changes;
        const situations = db.prepare("DELETE FROM situations WHERE updated_at<? AND json_extract(snapshot,'$.state')='resolved'").run(before).changes;
        return { revisions, runs, checkpoints, situations };
      })();
    },
    dropNew(ids) {
      return db.prepare("DELETE FROM situations WHERE id IN (SELECT value FROM json_each(?)) AND json_extract(snapshot,'$.state')='new'")
        .run(JSON.stringify([...new Set(ids)])).changes;
    },
    pruneMeasures(before) {
      if (!Number.isSafeInteger(before)) throw new Error('Invalid measure retention');
      return db.transaction(() => {
        if (before > readSetting('metrics.kept_since', 0)) writeSetting('metrics.kept_since', before);
        return { measures: db.prepare('DELETE FROM proactive_measures WHERE at<?').run(before).changes,
          measure_receipts: db.prepare('DELETE FROM proactive_measure_receipts WHERE at<?').run(before).changes };
      })();
    },
    revisionsAfter, checkpoint, acknowledge,
    subscriberRun(subscriber, revision) {
      return db.prepare('SELECT run_id,state FROM situation_subscriber_runs WHERE subscriber_id=? AND revision=?').get(subscriber, revision) as ReturnType<SituationStore['subscriberRun']> ?? null;
    },
    beginSubscriberRun(subscriber, revision, run_id, at) {
      if (!subscriber.trim() || !run_id.trim() || !Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(at)) throw new Error('Invalid subscriber run receipt');
      return db.prepare("INSERT OR IGNORE INTO situation_subscriber_runs(subscriber_id,revision,run_id,state,at) VALUES(?,?,?,'started',?)")
        .run(subscriber, revision, run_id, at).changes === 1;
    },
    finishSubscriberRun(subscriber, revision, state, at) {
      db.prepare("UPDATE situation_subscriber_runs SET state=?,at=? WHERE subscriber_id=? AND revision=? AND state!='completed'").run(state, at, subscriber, revision);
    },
    async catchUp(subscriber, receive, options = {}) {
      if (!subscriber.trim()) throw new Error('A subscriber needs an identity');
      if (inFlight.has(subscriber)) return 0;
      inFlight.add(subscriber);
      let handled = 0;
      try {
        for (const revision of revisionsAfter(checkpoint(subscriber), options.limit ?? 100)) {
          if (options.isOpen?.() === false) break;
          if (revision.cause.source !== (options.cause_source ?? subscriber)) {
            try { if (!await receive(revision)) break; } catch { break; }
          }
          acknowledge(subscriber, revision.revision); handled += 1;
        }
      } finally { inFlight.delete(subscriber); }
      return handled;
    },
    readSetting, writeSetting,
    measure(name, value, dimensions, at, receipt) {
      if (!readSetting('metrics.opt_in', false) || at < readSetting('metrics.enabled_at', 0) || at < readSetting('metrics.kept_since', 0)) return false;
      if (!/^[a-z][a-z0-9_.]{0,99}$/u.test(name) || !Number.isFinite(value) || !Number.isSafeInteger(at)
        || Object.values(dimensions).some(field => !['string', 'number', 'boolean'].includes(typeof field)
          || (typeof field === 'number' && !Number.isFinite(field)))) throw new Error('Invalid local measure');
      return db.transaction(() => {
        if (receipt && db.prepare('INSERT OR IGNORE INTO proactive_measure_receipts(receipt,at) VALUES(?,?)').run(receipt, at).changes === 0) return false;
        db.prepare('INSERT INTO proactive_measures(at,name,value,dimensions) VALUES(?,?,?,?)').run(at, name, value, JSON.stringify(dimensions));
        return true;
      })();
    },
  };
};

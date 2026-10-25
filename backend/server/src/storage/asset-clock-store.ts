import type Database from 'better-sqlite3';
import { ASSET_TABLE, ensureWorkEntitySchema } from './work-entity-store.js';

/** D-325 §6.3 — each asset rule's act-by, stored when the occurrence service
 * evaluates the asset, so a situation read finds what falls in its window by
 * index instead of evaluating every asset's clocks. The rows only narrow which
 * assets a read evaluates. Any write to an asset or its readings marks it dirty
 * until it is evaluated again, and a dirty asset is always read. */
export interface AssetClockRow {
  rule_id: string;
  /** What a text question matches the rule's fact by, with the asset's name. */
  title: string;
  /** The owner's view of the cycle the row stands for. */
  cycle: string;
  act_by_at: number | null;
  /** A notice's act-by no longer counts after this instant. */
  lapses_at: number | null;
  /** The due day of a notice, which a lapsed notice still matches. */
  when_from: number | null;
  when_to: number | null;
}
// Only an asset a read could walk is tracked: a tombstone or a row that is not
// live never yields a situation fact.
const WALKABLE = `NEW.deleted_at IS NULL AND NEW.sync_state IN ('live','stale_unreachable')`;
const dirty = (id: string): string => `INSERT INTO asset_clock_state(asset_id,dirty) SELECT id,1 FROM ${ASSET_TABLE}
      WHERE id=${id} AND deleted_at IS NULL AND sync_state IN ('live','stale_unreachable') AND NOT EXISTS (SELECT 1 FROM asset_clock_state WHERE asset_id=${id});
    UPDATE asset_clock_state SET dirty=1 WHERE asset_id=${id};`;
const forgotten = (id: string): string => `DELETE FROM asset_rule_clocks WHERE asset_id=${id}; DELETE FROM asset_clock_state WHERE asset_id=${id};`;
export const createAssetClockStore = (db: Database.Database) => {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(ASSET_TABLE)) ensureWorkEntitySchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS asset_clock_state (
    asset_id TEXT PRIMARY KEY, dirty INTEGER NOT NULL, zone TEXT, evaluated_at INTEGER,
    class_id TEXT, travel_document INTEGER NOT NULL DEFAULT 0, places TEXT
  );
  CREATE INDEX IF NOT EXISTS asset_clock_state_dirty ON asset_clock_state(asset_id) WHERE dirty=1;
  CREATE INDEX IF NOT EXISTS asset_clock_state_zone ON asset_clock_state(zone);
  CREATE INDEX IF NOT EXISTS asset_clock_state_class ON asset_clock_state(class_id);
  CREATE INDEX IF NOT EXISTS asset_clock_state_travel ON asset_clock_state(asset_id) WHERE travel_document=1;
  CREATE INDEX IF NOT EXISTS asset_clock_state_places ON asset_clock_state(asset_id) WHERE places IS NOT NULL;
  -- What a situation read asks of the asset table: what changed since a cursor.
  CREATE INDEX IF NOT EXISTS asset_clock_updated ON ${ASSET_TABLE}(updated_at);
  CREATE TABLE IF NOT EXISTS asset_rule_clocks (
    asset_id TEXT NOT NULL, rule_id TEXT NOT NULL, title TEXT NOT NULL, cycle TEXT NOT NULL,
    act_by_at INTEGER, lapses_at INTEGER, when_from INTEGER, when_to INTEGER,
    PRIMARY KEY(asset_id,rule_id)
  );
  CREATE INDEX IF NOT EXISTS asset_rule_clock_act_by ON asset_rule_clocks(act_by_at) WHERE act_by_at IS NOT NULL;
  CREATE INDEX IF NOT EXISTS asset_rule_clock_when ON asset_rule_clocks(when_from) WHERE when_from IS NOT NULL;`);
  // Recreated on every start, so a database always carries the current bodies.
  // They avoid conflict clauses: the statement that fires a trigger imposes its
  // own, so one could otherwise fail the owner's asset write.
  const triggers: Record<string, string> = {
    asset_clock_insert: `AFTER INSERT ON ${ASSET_TABLE} WHEN ${WALKABLE} BEGIN ${dirty('NEW.id')} END`,
    asset_clock_update: `AFTER UPDATE ON ${ASSET_TABLE} WHEN ${WALKABLE} BEGIN ${dirty('NEW.id')} END`,
    asset_clock_unwalkable: `AFTER UPDATE ON ${ASSET_TABLE} WHEN NOT (${WALKABLE}) BEGIN ${forgotten('NEW.id')} END`,
    asset_clock_delete: `AFTER DELETE ON ${ASSET_TABLE} BEGIN ${forgotten('OLD.id')} END`,
    asset_clock_reading_insert: `AFTER INSERT ON asset_reading_history BEGIN ${dirty('NEW.asset_id')} END`,
    asset_clock_reading_update: `AFTER UPDATE ON asset_reading_history BEGIN ${dirty('NEW.asset_id')} END`,
    asset_clock_reading_delete: `AFTER DELETE ON asset_reading_history BEGIN ${dirty('OLD.asset_id')} END`,
  };
  db.transaction(() => { for (const [name, body] of Object.entries(triggers)) db.exec(`DROP TRIGGER IF EXISTS ${name}; CREATE TRIGGER ${name} ${body};`); })();
  // Assets written before these triggers existed wait for their first evaluation.
  db.exec(`INSERT INTO asset_clock_state(asset_id,dirty) SELECT id,1 FROM ${ASSET_TABLE}
    WHERE deleted_at IS NULL AND sync_state IN ('live','stale_unreachable') AND id NOT IN (SELECT asset_id FROM asset_clock_state)`);
  const select = db.prepare('SELECT rule_id,title,cycle,act_by_at,lapses_at,when_from,when_to FROM asset_rule_clocks WHERE asset_id=?');
  const sorted = (rows: readonly AssetClockRow[]): string => JSON.stringify([...rows].sort((a, b) => a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0)
    .map(row => [row.rule_id, row.title, row.cycle, row.act_by_at, row.lapses_at, row.when_from, row.when_to]));
  return {
    /** The rows evaluated for one asset, written only when they changed. The
     * class and travel-document flag let a relation find its assets; the asset's
     * own place labels let a named place find it. */
    write(asset_id: string, rows: readonly AssetClockRow[], tags: { zone: string; class_id: string | null; travel_document: boolean; places: readonly string[] }, at: number): void {
      const places = tags.places.length ? JSON.stringify(tags.places) : null;
      db.transaction(() => {
        const state = db.prepare('SELECT dirty,zone,class_id,travel_document,places FROM asset_clock_state WHERE asset_id=?').get(asset_id) as
          { dirty: number; zone: string | null; class_id: string | null; travel_document: number; places: string | null } | undefined;
        if (state?.dirty === 0 && state.zone === tags.zone && state.class_id === tags.class_id && state.travel_document === Number(tags.travel_document)
          && state.places === places && sorted(rows) === sorted(select.all(asset_id) as AssetClockRow[])) return;
        db.prepare('DELETE FROM asset_rule_clocks WHERE asset_id=?').run(asset_id);
        const insert = db.prepare('INSERT INTO asset_rule_clocks(asset_id,rule_id,title,cycle,act_by_at,lapses_at,when_from,when_to) VALUES(?,?,?,?,?,?,?,?)');
        for (const row of rows) insert.run(asset_id, row.rule_id, row.title, row.cycle, row.act_by_at, row.lapses_at, row.when_from, row.when_to);
        db.prepare(`INSERT INTO asset_clock_state(asset_id,dirty,zone,evaluated_at,class_id,travel_document,places) VALUES(?,0,?,?,?,?,?)
          ON CONFLICT(asset_id) DO UPDATE SET dirty=0,zone=excluded.zone,evaluated_at=excluded.evaluated_at,class_id=excluded.class_id,
            travel_document=excluded.travel_document,places=excluded.places`)
          .run(asset_id, tags.zone, at, tags.class_id, Number(tags.travel_document), places);
      })();
    },
    forget(asset_id: string): void {
      db.transaction(() => {
        db.prepare('DELETE FROM asset_rule_clocks WHERE asset_id=?').run(asset_id);
        db.prepare('DELETE FROM asset_clock_state WHERE asset_id=?').run(asset_id);
      })();
    },
    rows: (asset_id: string): AssetClockRow[] => select.all(asset_id) as AssetClockRow[],
    /** Every class an evaluated asset has. */
    classes: (): string[] => (db.prepare('SELECT DISTINCT class_id FROM asset_clock_state WHERE class_id IS NOT NULL')
      .all() as { class_id: string }[]).map(row => row.class_id),
    /** Evaluated travel documents and assets of these classes. An asset not yet
     * evaluated is always a candidate, so it needs no tag here. */
    relations(classes: readonly string[]): string[] {
      return (db.prepare(`SELECT asset_id FROM asset_clock_state WHERE travel_document=1
        UNION SELECT asset_id FROM asset_clock_state WHERE class_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(classes)) as { asset_id: string }[]).map(row => row.asset_id);
    },
    /** What has not been evaluated since its last write or in this zone. Its
     * stored rows, titles and places may be stale, so a read takes it whole. */
    unevaluated: (zone: string): string[] => (db.prepare(`SELECT asset_id FROM asset_clock_state WHERE dirty=1
      UNION SELECT asset_id FROM asset_clock_state WHERE zone IS NULL OR zone<@zone OR zone>@zone`).all({ zone }) as { asset_id: string }[]).map(row => row.asset_id),
    /** Every asset a read of this window must evaluate: the unevaluated ones,
     * and every rule whose act-by has come by the window's end, or whose lapsed
     * notice day meets the window. */
    candidates(input: { from: number; to: number; now: number; zone: string }): string[] {
      return (db.prepare(`SELECT asset_id FROM asset_clock_state WHERE dirty=1
        UNION SELECT asset_id FROM asset_clock_state WHERE zone IS NULL OR zone<@zone OR zone>@zone
        UNION SELECT asset_id FROM asset_rule_clocks WHERE act_by_at<=@to AND (lapses_at IS NULL OR lapses_at>=@now)
        UNION SELECT asset_id FROM asset_rule_clocks WHERE when_from<=@to AND when_to>=@from`).all(input) as { asset_id: string }[]).map(row => row.asset_id);
    },
    /** The enabled rules' titles of each evaluated asset. */
    ruleTitles(): Map<string, string[]> {
      const titles = new Map<string, string[]>();
      for (const row of db.prepare('SELECT asset_id,title FROM asset_rule_clocks').all() as { asset_id: string; title: string }[]) {
        const list = titles.get(row.asset_id) ?? []; list.push(row.title); titles.set(row.asset_id, list);
      }
      return titles;
    },
    /** Each evaluated asset's own place labels. */
    places: (): Array<{ asset_id: string; places: string[] }> => (db.prepare('SELECT asset_id,places FROM asset_clock_state WHERE places IS NOT NULL').all() as { asset_id: string; places: string }[])
      .map(row => ({ asset_id: row.asset_id, places: JSON.parse(row.places) as string[] })),
  };
};
export type AssetClockStore = ReturnType<typeof createAssetClockStore>;

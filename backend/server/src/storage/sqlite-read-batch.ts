import type Database from 'better-sqlite3';

export interface SqliteReadVersion { readonly writes: number; readonly data_version: number; readonly schema_version: number }
export interface SqliteReadBatch {
  current(): boolean;
  wrote(rows: number, connection: Database.Database): boolean;
  invalidate(): void;
}
interface Observer { load(version: SqliteReadVersion): void; clear(): void; loaded: boolean }
interface State { connection: Database.Database; active: boolean; observers: Observer[]; frame?: { current: boolean } }
const states = new WeakMap<SqliteReadBatch, State>();
const aliases = new WeakMap<object, { state: State; usable: () => boolean }>();

/** One existing freshness check can validate several native readers. Lazy
 * observers load only in an owned read frame, after that check succeeds. */
export const createSqliteReadBatch = (db: Database.Database): SqliteReadBatch => {
  const counter = db.prepare('SELECT total_changes() AS writes,data_version,schema_version FROM pragma_data_version,pragma_schema_version');
  const version = (): SqliteReadVersion => {
    const row = counter.get() as SqliteReadVersion;
    if (!Object.values(row).every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Unsupported SQLite read version');
    return row;
  };
  const expected = { ...version() }; const state: State = { connection: db, active: true, observers: [] };
  const invalidate = () => { state.active = false; for (const observer of state.observers) observer.clear(); };
  const batch: SqliteReadBatch = {
    invalidate,
    current() {
      if (!state.active) return false;
      try {
        const now = version();
        if (now.writes !== expected.writes || now.data_version !== expected.data_version || now.schema_version !== expected.schema_version) {
          invalidate(); return false;
        }
        if (state.frame && db.inTransaction) {
          for (const observer of state.observers) if (!observer.loaded) { observer.load(expected); observer.loaded = true; }
          state.frame.current = true;
        }
        return state.active;
      } catch (error) { invalidate(); throw error; }
    },
    wrote(rows, connection) {
      if (connection !== db || !Number.isSafeInteger(rows) || rows < 0 || !Number.isSafeInteger(expected.writes + rows)) invalidate();
      else expected.writes += rows;
      return state.active;
    },
  };
  states.set(batch, state); return batch;
};

/** Only a native reader without user callbacks may lend its transaction view. */
export const bindSqliteReadBatch = (reader: object, batch: SqliteReadBatch, usable: () => boolean): void => {
  const state = states.get(batch); if (state) aliases.set(reader, { state, usable });
};
export const observeSqliteReadBatch = (reader: object, db: Database.Database,
  observer: Pick<Observer, 'load' | 'clear'>) => {
  const owned = aliases.get(reader); if (!owned || owned.state.connection !== db || !owned.state.active || !owned.usable()) return undefined;
  const { state } = owned; state.observers.push({ ...observer, loaded: false });
  return {
    usable: () => state.active && owned.usable(),
    current: () => state.active && db.inTransaction && state.frame?.current === true,
    inRead<T>(read: () => T): T {
      const previous = state.frame; state.frame = { current: false };
      try { return read(); } finally { state.frame = previous; }
    },
  };
};

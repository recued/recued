/** Supervision feature — durable enrolled-daemon config (SQLite).
 *
 *  A supervised daemon is the keep-alive instance of a pack's detached cli
 *  daemon op (a `CliMethodBinding.detached.supervision`-bearing op — e.g.
 *  `cloudflared`/`tunnel.run_detached`, `ollama`/`serve.run_detached`). There
 *  is at most ONE per `(ingredient_slug, op)` — the single-instance-per-server
 *  identity is the binary/op being supervised, not the pack it ships in — so the
 *  op identity IS the natural key; no minted instance id, no default-per-recipe
 *  machinery (cf. the D-179 dish). A docker-compose multi-instance future would
 *  ADD an instance segment, not re-key.
 *
 *  This store holds only the DURABLE config — what's enrolled, its mode, its
 *  args. It must survive a restart: that is the whole point of
 *  `restart_on_server_start`. Runtime facts (pid / crash counter / live state)
 *  are ephemeral and live in the supervisor's in-memory map, cleared on boot —
 *  mirroring the D-118 service split (durable `collection_instances` vs the
 *  boot-cleared `service-state-table`).
 *
 *  Persistence idiom mirrors `dish-store.ts`: a JSON `data` blob keyed by the
 *  composite `(ingredient_slug, op)` primary key.
 */
import type Database from 'better-sqlite3';
import type { ServiceRestartPolicy } from '@recued/contracts';

/** One enrolled supervised daemon — the durable record. */
export interface SupervisedDaemonConfig {
  /** The catalog ingredient whose `surfaces.connector.executes[op]` carries the
   *  `CliMethodBinding` — the single-instance key. */
  ingredient_slug: string;
  /** The daemon operation key, e.g. `tunnel.run_detached`. */
  op: string;
  /** Crash behaviour. The manual/auto flip maps to this: manual = `'never'`
   *  (UI start/stop, no auto-restart); auto = the pack's declared policy
   *  (`'on-crash'` / `'always'`). */
  restart_policy: ServiceRestartPolicy;
  /** Re-launch this daemon when the server (re)starts — `false` for a manual
   *  daemon, the pack's declared value for an auto one. */
  restart_on_server_start: boolean;
  /** User run-intent. `true` = should be running now (a manual daemon's Start);
   *  `false` = stopped by the user. Orthogonal to `restart_policy`, which only
   *  governs what happens on a CRASH while enabled. */
  enabled: boolean;
  /** The op's business args (e.g. `{ tunnel_name }`). `result_dir` / `key` are
   *  NOT stored here — the supervisor injects server-owned values at launch so
   *  marker files always land in a confined, server-controlled directory. */
  args: Record<string, unknown>;
}

export interface SupervisedDaemonStore {
  /** Every enrolled daemon, ordered by `(ingredient_slug, op)`. */
  list(): SupervisedDaemonConfig[];
  get(ingredient_slug: string, op: string): SupervisedDaemonConfig | null;
  /** Insert or replace the row for `(ingredient_slug, op)`. */
  upsert(config: SupervisedDaemonConfig): void;
  /** Remove the row. Returns true when a row existed. */
  delete(ingredient_slug: string, op: string): boolean;
}

export interface CreateSupervisedDaemonStoreOptions {
  /** Gate-byte hook — same contract as the dish / schedule stores: each
   *  `upsert` / `delete` reports the signed byte delta of the serialized row.
   *  Sink exceptions are swallowed. */
  onBytesChanged?: (delta: number) => void;
}

/** Create a SQLite-backed supervised-daemon config store. Auto-creates the
 *  table. */
export const createSupervisedDaemonStore = (
  db: Database.Database,
  options: CreateSupervisedDaemonStoreOptions = {},
): SupervisedDaemonStore => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS supervised_daemons (
      ingredient_slug TEXT NOT NULL,
      op              TEXT NOT NULL,
      data            TEXT NOT NULL,
      PRIMARY KEY (ingredient_slug, op)
    );
  `);

  const onBytesChanged = options.onBytesChanged;
  const reportDelta = (delta: number): void => {
    if (!onBytesChanged || delta === 0) return;
    try { onBytesChanged(delta); } catch (_err) { /* never break writes */ }
  };

  const rowToConfig = (row: { data: string }): SupervisedDaemonConfig =>
    JSON.parse(row.data) as SupervisedDaemonConfig;

  const priorBytes = (ingredient_slug: string, op: string): number => {
    const row = db
      .prepare(`SELECT length(data) AS len FROM supervised_daemons WHERE ingredient_slug = ? AND op = ?`)
      .get(ingredient_slug, op) as { len: number } | undefined;
    return row?.len ?? 0;
  };

  return {
    list() {
      const rows = db
        .prepare(`SELECT data FROM supervised_daemons ORDER BY ingredient_slug, op`)
        .all() as { data: string }[];
      return rows.map(rowToConfig);
    },

    get(ingredient_slug, op) {
      const row = db
        .prepare(`SELECT data FROM supervised_daemons WHERE ingredient_slug = ? AND op = ?`)
        .get(ingredient_slug, op) as { data: string } | undefined;
      return row ? rowToConfig(row) : null;
    },

    upsert(config) {
      const serialized = JSON.stringify(config);
      const prev = priorBytes(config.ingredient_slug, config.op);
      db.prepare(`
        INSERT INTO supervised_daemons (ingredient_slug, op, data) VALUES (?, ?, ?)
        ON CONFLICT (ingredient_slug, op) DO UPDATE SET data = excluded.data
      `).run(config.ingredient_slug, config.op, serialized);
      reportDelta(serialized.length - prev);
    },

    delete(ingredient_slug, op) {
      const prev = priorBytes(ingredient_slug, op);
      const result = db
        .prepare(`DELETE FROM supervised_daemons WHERE ingredient_slug = ? AND op = ?`)
        .run(ingredient_slug, op);
      if (result.changes > 0 && prev > 0) reportDelta(-prev);
      return result.changes > 0;
    },
  };
};

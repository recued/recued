/** D-178 — persisted release-check state (rollout salt + anti-replay floor).
 *
 *  Two small facts the `update.check` orchestrator must remember across runs:
 *    - a per-install random `salt`, generated once, that drives staged-rollout
 *      cohort membership LOCALLY (no identifier ever leaves the box — I-1/I-7);
 *    - the highest manifest `sequence` ever accepted, the I-10 anti-replay
 *      floor (a replayed old-but-valid manifest can't freeze/downgrade us).
 *
 *  Persistence piggy-backs on the existing `server_state` SQLite table under
 *  `release.*` keys, mirroring `upgrade-state.ts`. NOTE: this is config-ish
 *  state, NOT the update LEDGER — the ledger lives OUTSIDE SQLite by design
 *  (spec rev 2) so a migration-snapshot rollback can't erase its own audit
 *  trail; that lands with the apply machinery (slice 3).
 */

import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

export interface ReleaseCheckState {
  /** Per-install rollout salt (hex), generated once. */
  salt: string;
  /** Highest manifest sequence ever accepted (anti-replay floor). */
  highest_accepted_sequence: number;
}

export interface ReleaseStateStore {
  /** Read current state, generating + persisting a salt on first call. */
  load(): ReleaseCheckState;
  save(state: ReleaseCheckState): void;
}

const TABLE = 'server_state';
const KEY = 'release.check_state';

/** Generate a fresh rollout salt — 16 random bytes, hex. */
export const generateSalt = (): string => randomBytes(16).toString('hex');

export const createReleaseStateStore = (db: Database.Database): ReleaseStateStore => {
  // Shares the `server_state` table with the lifecycle / crash-loop / pressure
  // stores; create idempotently so wiring order can't leave us table-less.
  db.exec(`
    CREATE TABLE IF NOT EXISTS server_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const read = (): ReleaseCheckState | null => {
    try {
      const row = db.prepare(`SELECT value FROM ${TABLE} WHERE key = ?`).get(KEY) as { value: string } | undefined;
      if (!row) return null;
      const parsed = JSON.parse(row.value) as Partial<ReleaseCheckState>;
      if (typeof parsed.salt !== 'string' || parsed.salt.length === 0) return null;
      return {
        salt: parsed.salt,
        highest_accepted_sequence:
          typeof parsed.highest_accepted_sequence === 'number' && Number.isFinite(parsed.highest_accepted_sequence)
            ? parsed.highest_accepted_sequence
            : 0,
      };
    } catch {
      return null;
    }
  };
  const write = (state: ReleaseCheckState): void => {
    db.prepare(`INSERT OR REPLACE INTO ${TABLE} (key, value, updated_at) VALUES (?, ?, ?)`)
      .run(KEY, JSON.stringify(state), Date.now());
  };
  return {
    load() {
      const existing = read();
      if (existing) return existing;
      // First run — mint + persist the salt so cohort membership is stable.
      const fresh: ReleaseCheckState = { salt: generateSalt(), highest_accepted_sequence: 0 };
      write(fresh);
      return fresh;
    },
    save(state) {
      write(state);
    },
  };
};

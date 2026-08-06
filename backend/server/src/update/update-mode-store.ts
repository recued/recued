/** D-178 slice 3 — apply-policy (`update.mode`) persistence + resolution.
 *
 *  The user's chosen mode is a stored preference; the EFFECTIVE mode resolves
 *  it against `RECUED_SELF_UPDATE` (env wins inside containers — spec § Update
 *  machinery) and a channel-derived default (`auto` on `docker-thin` alone,
 *  `notify` everywhere else — see `channelDefaultMode`). Persistence shares the
 *  `server_state` table (config-ish, not the ledger), mirroring
 *  `release-state-store.ts`.
 */

import type Database from 'better-sqlite3';
import type { UpdateMode, UpdateModeStatus } from '@recued/contracts';

const TABLE = 'server_state';
const KEY = 'release.update_mode';

const isMode = (v: unknown): v is UpdateMode => v === 'auto' || v === 'notify' || v === 'off';

export interface UpdateModeStore {
  /** The user override, or null when unset (→ channel default). */
  readUserMode(): UpdateMode | null;
  setUserMode(mode: UpdateMode): void;
}

export const createUpdateModeStore = (db: Database.Database): UpdateModeStore => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS server_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return {
    readUserMode() {
      // Deliberately do NOT swallow read errors: returning null on a transient
      // failure would silently fall through to the channel default (`auto` on
      // self-updating channels), re-enabling auto-apply for a user who chose
      // `off`/`notify`. A genuinely-absent row returns undefined → null; a real
      // error propagates so the caller surfaces it instead of mis-resolving.
      const row = db.prepare(`SELECT value FROM ${TABLE} WHERE key = ?`).get(KEY) as { value: string } | undefined;
      return row && isMode(row.value) ? row.value : null;
    },
    setUserMode(mode) {
      db.prepare(`INSERT OR REPLACE INTO ${TABLE} (key, value, updated_at) VALUES (?, ?, ?)`).run(KEY, mode, Date.now());
    },
  };
};

/** The four distribution channels carry their apply-default at build (I-8). */
export type DistributionChannel = 'binary' | 'docker-baked' | 'docker-thin' | 'source';

/** Channel-derived default.
 *
 *  ⛔ `binary` DEFAULTS TO `notify`, AND THAT IS THE POINT. A self-hosted binary
 *  install holds the owner's warehouse on their own machine, and an apply runs
 *  migrations against it on the next boot. Unattended is a reasonable thing to
 *  WANT and an unreasonable thing to ASSUME: consent that arrives via a default
 *  nobody was shown is not consent. `notify` still surfaces the update card the
 *  moment a release lands — the owner just decides when it lands on their data.
 *
 *  ⚠ `docker-thin` keeps `auto`. It swaps its own image, and an operator who
 *  chose a thin container has already opted into infrastructure that updates
 *  itself; the same argument does not transfer.
 *
 *  `docker-baked` and `source` are `notify` because apply is delegated to the
 *  ecosystem — the host rebuilds the image or pulls the source. */
export const channelDefaultMode = (channel: DistributionChannel): UpdateMode =>
  channel === 'docker-thin' ? 'auto' : 'notify';

export interface ResolveModeInputs {
  channel: DistributionChannel;
  userMode: UpdateMode | null;
  /** Raw `RECUED_SELF_UPDATE` value (env wins when a valid mode). */
  envMode?: string;
}

/** Resolve the effective mode: env > user override > channel default. */
export const resolveUpdateMode = (inputs: ResolveModeInputs): UpdateModeStatus => {
  const channelDefault = channelDefaultMode(inputs.channel);
  if (isMode(inputs.envMode)) {
    return { mode: inputs.envMode, source: 'env', env_locked: true, channel_default: channelDefault };
  }
  if (inputs.userMode) {
    return { mode: inputs.userMode, source: 'user', env_locked: false, channel_default: channelDefault };
  }
  return { mode: channelDefault, source: 'default', env_locked: false, channel_default: channelDefault };
};

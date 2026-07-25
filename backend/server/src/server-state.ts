/** Small key/value SQLite store for server-local state that changes
 *  more often than the TOML config should (kill switch, staged
 *  bootstrap patch). The config file is the wrong home for frequent
 *  toggles — repeated atomic rewrites both thrash the filesystem and
 *  make concurrent daemon reloads racy. Everything here lives alongside
 *  the existing `server_config` / `server_dek` tables in SQLite. */

import type Database from 'better-sqlite3';
import type { BootstrapConfig } from '@recued/config';
import type { QualityGateSwitchStatus } from '@recued/contracts';

const TABLE = 'server_state';

const KEY_CRASH_HALT_ACTIVE = 'crash_halt.active';
const KEY_CRASH_HALT_SINCE = 'crash_halt.since';
// D-188 — the master "Pause server" circuit-breaker. A DELIBERATELY
// separate axis from the kill switch (which is the crash-loop write-halt):
// pause denies door + owner-AI ops + freezes autonomous execution, but
// never halts storage writes, so the owner stays paired-live + in control.
const KEY_PAUSED_ACTIVE = 'paused.active';
const KEY_PAUSED_SINCE = 'paused.since';
// D-202 — the two-switch quality kill-switch (Switch A = pause both delegation
// axes; Switch B = pause the quality axis only). Persisted like the master
// pause so a paused axis stays paused across restart — the failsafe posture
// (silently resuming auto-accept on a restart would defeat the switch's point).
const KEY_QGATE_ALL_ACTIVE = 'quality_gate.all_paused';
const KEY_QGATE_ALL_SINCE = 'quality_gate.all_since';
const KEY_QGATE_QUALITY_ACTIVE = 'quality_gate.quality_paused';
const KEY_QGATE_QUALITY_SINCE = 'quality_gate.quality_since';
const KEY_STAGED_BOOTSTRAP = 'bootstrap.staged';

export interface ServerStateStore {
  /** Is the kill switch currently engaged? */
  isCrashHaltActive(): boolean;
  /** Unix-ms epoch when the kill switch was last engaged. Null when
   *  inactive OR when activation predates this upgrade (missing row). */
  crashHaltSince(): number | null;
  /** Engage / release the kill switch. Records the activation time on
   *  rising edge; clears it on release. Returns the new state + the
   *  activation timestamp (null when disengaged). */
  setCrashHalt(active: boolean, now?: number): { active: boolean; active_since: number | null };

  /** D-188 — is the master "Pause server" circuit-breaker engaged? A
   *  distinct axis from the kill switch: pause denies door + owner-AI
   *  ops and freezes autonomous execution, but never halts storage
   *  writes (the owner's direct HID stays live to inspect + resume). */
  isPaused(): boolean;
  /** Unix-ms epoch when pause was last engaged. Null when not paused OR
   *  when activation predates this upgrade (missing row). */
  pausedSince(): number | null;
  /** Engage / release the master pause. Records activation time on the
   *  rising edge; clears it on release. Returns the new state + the
   *  activation timestamp (null when resumed). */
  setPaused(active: boolean, now?: number): { active: boolean; active_since: number | null };

  /** D-202 — the current two-switch quality kill-switch status (Switch A =
   *  pause both delegation axes; Switch B = pause the quality axis only). Both
   *  default OFF; each carries a rising-edge `*_since` for the §4
   *  self-evidencing status surface. A GATE-OVERRIDE — the gate reads this to
   *  suppress the matching delegation without ever touching learner state. */
  getQualityGateSwitches(): QualityGateSwitchStatus;
  /** Engage / release ONE quality switch (`'all'` = Switch A, `'quality'` =
   *  Switch B). Records the rising-edge `*_since` on engage; clears it on
   *  release (mirrors the master-pause `since` semantics — re-assert preserves
   *  the prior timestamp). Returns the full post-write status. */
  setQualityGateSwitch(
    which: 'all' | 'quality',
    active: boolean,
    now?: number,
  ): QualityGateSwitchStatus;

  /** Staged bootstrap patch pending the next restart. Null when clear. */
  getStagedBootstrap(): Partial<BootstrapConfig> | null;
  /** Overwrite the staged patch. Pass an empty object to clear it. */
  setStagedBootstrap(patch: Partial<BootstrapConfig>): void;
  /** Drop the staged patch (e.g. on successful restart). */
  clearStagedBootstrap(): void;
}

export const createServerStateStore = (db: Database.Database): ServerStateStore => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  const get = (key: string): string | undefined => {
    const row = db.prepare(`SELECT value FROM ${TABLE} WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  };

  const put = (key: string, value: string, updatedAt: number): void => {
    db.prepare(
      `INSERT OR REPLACE INTO ${TABLE} (key, value, updated_at) VALUES (?, ?, ?)`,
    ).run(key, value, updatedAt);
  };

  const del = (key: string): void => {
    db.prepare(`DELETE FROM ${TABLE} WHERE key = ?`).run(key);
  };

  return {
    isCrashHaltActive() {
      return get(KEY_CRASH_HALT_ACTIVE) === '1';
    },

    crashHaltSince() {
      if (get(KEY_CRASH_HALT_ACTIVE) !== '1') return null;
      const raw = get(KEY_CRASH_HALT_SINCE);
      if (!raw) return null;
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? n : null;
    },

    setCrashHalt(active, now = Date.now()) {
      const wasActive = this.isCrashHaltActive();
      if (active) {
        // Preserve the prior `since` timestamp when re-asserting an
        // already-active switch so repeated calls don't reset the clock
        // — lets status consumers show "halted since …" correctly.
        if (!wasActive) put(KEY_CRASH_HALT_SINCE, String(now), now);
        put(KEY_CRASH_HALT_ACTIVE, '1', now);
        return { active: true, active_since: this.crashHaltSince() };
      }
      del(KEY_CRASH_HALT_ACTIVE);
      del(KEY_CRASH_HALT_SINCE);
      return { active: false, active_since: null };
    },

    isPaused() {
      return get(KEY_PAUSED_ACTIVE) === '1';
    },

    pausedSince() {
      if (get(KEY_PAUSED_ACTIVE) !== '1') return null;
      const raw = get(KEY_PAUSED_SINCE);
      if (!raw) return null;
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? n : null;
    },

    setPaused(active, now = Date.now()) {
      const wasActive = this.isPaused();
      if (active) {
        // Preserve the prior `since` on re-assert so repeated calls don't
        // reset the clock — mirrors the kill-switch semantics.
        if (!wasActive) put(KEY_PAUSED_SINCE, String(now), now);
        put(KEY_PAUSED_ACTIVE, '1', now);
        return { active: true, active_since: this.pausedSince() };
      }
      del(KEY_PAUSED_ACTIVE);
      del(KEY_PAUSED_SINCE);
      return { active: false, active_since: null };
    },

    getQualityGateSwitches() {
      const readSince = (activeKey: string, sinceKey: string): number | null => {
        if (get(activeKey) !== '1') return null;
        const raw = get(sinceKey);
        if (!raw) return null;
        const n = parseInt(raw, 10);
        return Number.isFinite(n) ? n : null;
      };
      return {
        all_paused: get(KEY_QGATE_ALL_ACTIVE) === '1',
        all_since: readSince(KEY_QGATE_ALL_ACTIVE, KEY_QGATE_ALL_SINCE),
        quality_paused: get(KEY_QGATE_QUALITY_ACTIVE) === '1',
        quality_since: readSince(KEY_QGATE_QUALITY_ACTIVE, KEY_QGATE_QUALITY_SINCE),
      };
    },

    setQualityGateSwitch(which, active, now = Date.now()) {
      const activeKey =
        which === 'all' ? KEY_QGATE_ALL_ACTIVE : KEY_QGATE_QUALITY_ACTIVE;
      const sinceKey =
        which === 'all' ? KEY_QGATE_ALL_SINCE : KEY_QGATE_QUALITY_SINCE;
      const wasActive = get(activeKey) === '1';
      if (active) {
        // Preserve the prior `since` on re-assert so repeated calls don't reset
        // the clock — mirrors the master-pause / kill-switch semantics.
        if (!wasActive) put(sinceKey, String(now), now);
        put(activeKey, '1', now);
      } else {
        del(activeKey);
        del(sinceKey);
      }
      return this.getQualityGateSwitches();
    },

    getStagedBootstrap() {
      const raw = get(KEY_STAGED_BOOTSTRAP);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Partial<BootstrapConfig>;
        }
      } catch { /* malformed row — treat as absent */ }
      return null;
    },

    setStagedBootstrap(patch) {
      if (!patch || Object.keys(patch).length === 0) {
        del(KEY_STAGED_BOOTSTRAP);
        return;
      }
      put(KEY_STAGED_BOOTSTRAP, JSON.stringify(patch), Date.now());
    },

    clearStagedBootstrap() {
      del(KEY_STAGED_BOOTSTRAP);
    },
  };
};

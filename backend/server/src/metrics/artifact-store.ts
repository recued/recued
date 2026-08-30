/** D-250 § D8.1 slice 1 — the local artifact store: `{key: value}`, advanced forward.
 *
 *  🔑 THE PROPERTY THAT MAKES THIS SIT INSIDE amendment 16's "no history" RULING: a
 *  value here ADVANCES FROM YESTERDAY'S SINGLE VALUE and is never derived by scanning
 *  the past. The history is not needed — only the prior key. So the snapshot keeps its
 *  purity (recompute, replace, no memory) while the earned facts stop depending on
 *  audit retention.
 *
 *  ⛔⛔ THERE IS DELIBERATELY NO GENERIC `set(key, value)`. A raw setter is all it would
 *  take for a quiet week to LOWER Burst's record, or a re-run to re-stamp a milestone
 *  with a later date — the exact failures the advance model exists to prevent. Three
 *  typed writers instead, each enforcing its own semantics, with the KIND pinned on
 *  first write so the wrong writer is rejected rather than silently accepted. Same move
 *  as D-250 amendment 10's `latest` → `highest`: turn a warning into a guarantee.
 *
 *  ⚠ MILESTONES ARE NOT PUBLISHABLE AND NOTHING HERE PUBLISHES (amendment 17). Never
 *  reaching the cloud is what puts them outside § B3's retention, outside seasons and
 *  outside the board key entirely.
 */

import type Database from 'better-sqlite3';

import { ensureMetricSchema } from './schema.js';

export type ArtifactKind = 'record' | 'once' | 'counter';

export interface MilestoneResult {
  /** True only on the write that first earned it — the caller's cue to celebrate. */
  readonly newly_earned: boolean;
  readonly earned_at: number;
}

export interface MetricArtifactStore {
  /** A record's current best, or `undefined` if never set. */
  readRecord(key: string): number | undefined;
  /** Fold one observation into a record. Returns the record AFTER the fold.
   *  ⛔ MAX SEMANTICS AND THEREFORE IDEMPOTENT: replaying the same observation, or
   *  handing it a lower one from a quieter window, changes nothing. That is what lets
   *  the caller pass a WINDOW OBSERVATION (which is all `computeActivityMetrics`
   *  produces for Burst) without a quiet week erasing a standing best. */
  advanceRecord(key: string, observation: number, now: number): number;

  hasMilestone(key: string): boolean;
  readMilestone(key: string): number | undefined;
  /** Earn a milestone. ⛔ FIRST WRITE WINS — a later call returns the ORIGINAL
   *  `earned_at`, because "first pack published" is a fact about a moment and
   *  re-stamping it on every cycle would make it read as if it happened today. */
  earnMilestone(key: string, now: number): MilestoneResult;

  readCounter(key: string): number | undefined;
  /** A freely-moving value — a streak's CURRENT run, which legitimately resets to 0.
   *  ⚠ Its LONGEST companion is a `record`, not a counter, and the two are separate
   *  keys precisely so the reset cannot reach the best. */
  setCounter(key: string, value: number, now: number): void;

  /** Everything stored, for the dashboard. */
  /** ⛔⛔ THE ONE WAY A VALUE COMES BACK DOWN, AND IT IS NAMED FOR ITS ONLY REASON.
   *
   *  Every setter here is guarded — `advanceRecord` only raises, `earnMilestone` only
   *  fires once — because a record that can be lowered is not a record. But when the
   *  RULE that minted a value is replaced, the old value is not a smaller record, it is
   *  a value of a different quantity, and leaving it standing publishes a number no
   *  current rule would produce.
   *
   *  ⚠ IT DELETES RATHER THAN ZEROING. "No record yet" is the truth after a rule change;
   *  a stored 0 would render as an achievement of zero, and would also claim the key had
   *  been legitimately measured under the new rule. */
  retireForRuleChange(key: string): void;

  entries(): ReadonlyArray<{ key: string; kind: ArtifactKind; value: number; updated_at: number }>;
}

interface Row {
  kind: ArtifactKind;
  value: string;
  updated_at: number;
}

export const createMetricArtifactStore = (db: Database.Database): MetricArtifactStore => {
  ensureMetricSchema(db);
  const get = db.prepare(`SELECT kind, value, updated_at FROM metric_artifact WHERE key = ?`);
  const put = db.prepare(
    `INSERT INTO metric_artifact (key, kind, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const all = db.prepare(
    `SELECT key, kind, value, updated_at FROM metric_artifact ORDER BY key`,
  );
  const del = db.prepare(`DELETE FROM metric_artifact WHERE key = ?`);

  /** Read a key and assert it is the kind the caller expects.
   *  ⛔ A KIND MISMATCH THROWS RATHER THAN COERCING. Accepting a `record` key through
   *  `setCounter` would hand back exactly the unguarded setter this file refuses to
   *  have, one call further down. */
  const readAs = (key: string, expected: ArtifactKind): Row | undefined => {
    const row = get.get(key) as Row | undefined;
    if (row !== undefined && row.kind !== expected) {
      throw new Error(
        `metric artifact '${key}' is a '${row.kind}' and cannot be used as a '${expected}'`,
      );
    }
    return row;
  };

  return {
    readRecord(key) {
      const row = readAs(key, 'record');
      return row === undefined ? undefined : Number(row.value);
    },

    advanceRecord(key, observation, now) {
      const row = readAs(key, 'record');
      const prior = row === undefined ? undefined : Number(row.value);
      // ⚠ STRICTLY GREATER, so an equal observation does not churn `updated_at`. A
      // record's timestamp answers "when was this best set", and re-stamping it every
      // cycle would make a months-old best look like today's.
      if (prior !== undefined && observation <= prior) return prior;
      put.run(key, 'record', String(observation), now);
      return observation;
    },

    hasMilestone(key) {
      return readAs(key, 'once') !== undefined;
    },

    readMilestone(key) {
      const row = readAs(key, 'once');
      return row === undefined ? undefined : Number(row.value);
    },

    earnMilestone(key, now) {
      const row = readAs(key, 'once');
      if (row !== undefined) return { newly_earned: false, earned_at: Number(row.value) };
      put.run(key, 'once', String(now), now);
      return { newly_earned: true, earned_at: now };
    },

    readCounter(key) {
      const row = readAs(key, 'counter');
      return row === undefined ? undefined : Number(row.value);
    },

    setCounter(key, value, now) {
      readAs(key, 'counter');
      put.run(key, 'counter', String(value), now);
    },

    retireForRuleChange(key) {
      del.run(key);
    },

    entries() {
      return (all.all() as Array<{ key: string; kind: ArtifactKind; value: string; updated_at: number }>)
        .map((r) => ({ key: r.key, kind: r.kind, value: Number(r.value), updated_at: r.updated_at }));
    },
  };
};

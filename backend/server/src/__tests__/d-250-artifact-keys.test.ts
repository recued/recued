/** D-250 — every artifact key a producer writes is CLASSIFIED, one way or the other.
 *
 *  🔑 WHY THIS TEST EXISTS, AND WHY IT LIVES HERE. `stats-panel.ts` renders only the
 *  artifact keys it names, because the fallback `?? a.key` published the producers'
 *  bookkeeping as owner-facing records — a live server showed `20693 ·
 *  hands_off.last_day`, an epoch day index scored like an achievement. But silence as a
 *  fallback hides a genuinely NEW record exactly as quietly as it hides a cursor.
 *
 *  ⛔⛔ SO NEITHER SIDE CAN DECIDE THIS ALONE. `packages/` may not import `backend/`, so
 *  the panel cannot see the producers; the producers have no business holding UI copy.
 *  The SERVER suite is the only place that sees both. A new key that is neither labelled
 *  in the panel nor declared internal below turns this red instead of vanishing.
 *
 *  ⚠ THE KEYS ARE OBSERVED, NOT GREPPED. A scan for `setCounter('...')` would miss
 *  `recipeRunsKey(id)`, which is built at runtime — the exact shape most likely to leak
 *  a row per recipe. So this drives the producers and reads the store back.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { METRIC_REGISTRY } from '@recued/contracts';
import { artifactLabel } from '@recued/ui-shared';

import { createMetricArtifactStore, type MetricArtifactStore } from '../metrics/artifact-store.js';
import { advanceDailyStreaks } from '../metrics/daily-streaks.js';

const DAY = 86_400_000;
const D0 = Math.floor(1_700_000_000_000 / DAY) * DAY;
const at = (d: number, hour = 10): number => D0 + d * DAY + hour * 3_600_000;

/** Producer bookkeeping: real keys, deliberately NOT shown to the owner.
 *
 *  ⚠ EXACT PARITY, not a superset — a stale entry here means a producer key was removed
 *  and nobody noticed, which is how a list like this rots into a permanent excuse. */
const INTERNAL_ARTIFACT_KEYS: readonly string[] = [
  // The last complete day already folded. A cursor, and an epoch DAY INDEX at that.
  'hands_off.last_day',
  // Which rule the stored streak numbers were computed under. Bookkeeping for the
  // one-time v1 retirement. ⚠ This test is how it was classified at all: it was added
  // as a producer key and turned this red on the next run.
  'hands_off.rule_version',
];
/** Same, for keys built at runtime from an id. */
const INTERNAL_ARTIFACT_PREFIXES: readonly string[] = [
  // One accumulator per recipe, backing the century badge — dozens of rows on a busy
  // server, none of them a record the owner would recognise.
  'recipe_runs.',
];

let dir: string;
let db: Database.Database;
let art: MetricArtifactStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-250-keys-'));
  db = new Database(join(dir, 'test.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_entries (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_activities (key TEXT PRIMARY KEY, data TEXT NOT NULL);
  `);
  art = createMetricArtifactStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** ⚠ `once` IS OUT OF SCOPE, AND THAT MIRRORS THE PANEL. Milestones are stored in the
 *  same table with `kind: 'once'`, and the panel filters them out of the records list
 *  because they render from `data.milestones` with their own registry labels. This test
 *  found them on its first run — which is the ratchet working, not a false alarm: the
 *  classification question only applies to rows that would otherwise reach the list. */
const renderableKeys = (): string[] =>
  art.entries().filter((e) => e.kind !== 'once').map((e) => e.key);

/** Exercise every branch that writes an artifact: a quiet working day, an unattended
 *  day, an answered approval, and a run carrying a recipe_id. */
const driveEveryProducer = (): void => {
  let seq = 0;
  const run = (d: number, trigger: string, recipe_id?: string): void => {
    seq += 1;
    db.prepare('INSERT INTO audit_entries (key, data) VALUES (?, ?)').run(
      `r${seq}`,
      JSON.stringify({ started_at: at(d, 9), trigger_source: trigger, ...(recipe_id === undefined ? {} : { recipe_id }) }),
    );
  };
  const approval = (d: number): void => {
    seq += 1;
    db.prepare('INSERT INTO audit_activities (key, data) VALUES (?, ?)').run(
      `a${seq}`,
      JSON.stringify({ activity_id: `a${seq}`, timestamp: at(d, 14), action: 'approval_allow', target: 'x' }),
    );
  };
  advanceDailyStreaks(db, art, at(1));
  for (let d = 1; d <= 5; d += 1) run(d, 'schedule', 'recued-core/inbox-triage');
  run(3, 'manual');
  approval(4);
  for (let d = 2; d <= 6; d += 1) advanceDailyStreaks(db, art, at(d));
};

describe('D-250 — the artifact store is producers AND owner-facing rows, and they are told apart', () => {
  it('⛔⛔ EVERY KEY A PRODUCER WRITES IS EITHER LABELLED OR DECLARED INTERNAL', () => {
    driveEveryProducer();
    const written = renderableKeys();
    expect(written.length).toBeGreaterThan(0); // the drive must actually write something

    const unclassified = written.filter((k) =>
      artifactLabel(k) === undefined
      && !INTERNAL_ARTIFACT_KEYS.includes(k)
      && !INTERNAL_ARTIFACT_PREFIXES.some((p) => k.startsWith(p)));
    expect(unclassified).toEqual([]);
  });

  it('⛔ THE INTERNAL LIST IS EXACT — a stale entry means a producer key quietly went away', () => {
    driveEveryProducer();
    const written = renderableKeys();
    for (const k of INTERNAL_ARTIFACT_KEYS) expect(written).toContain(k);
    for (const p of INTERNAL_ARTIFACT_PREFIXES) {
      expect(written.some((k) => k.startsWith(p))).toBe(true);
    }
  });

  it('⛔ AND NOTHING IS BOTH — a key cannot be labelled and hidden at once', () => {
    for (const k of INTERNAL_ARTIFACT_KEYS) expect(artifactLabel(k)).toBeUndefined();
  });

  it('⛔⛔ A RECORD-SHAPED METRIC IS LABELLED, or it computes into an invisible row', () => {
    // `owner-metrics-compute` writes `advanceRecord(m.metric_id, …)` for every artifact
    // record metric, so adding one to METRIC_REGISTRY silently creates an artifact key.
    const recordMetrics = Object.values(METRIC_REGISTRY)
      .filter((m) => m.store === 'artifact' && m.shape === 'record')
      .map((m) => m.metric_id);
    expect(recordMetrics.length).toBeGreaterThan(0);
    expect(recordMetrics.filter((id) => artifactLabel(id) === undefined)).toEqual([]);
  });
});

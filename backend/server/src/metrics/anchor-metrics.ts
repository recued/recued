/** D-250 § D8.1 slice 2 — the three metrics computable from the RUN ANCHOR alone.
 *
 *  🔑 WHY THESE THREE ARE ONE SLICE: it is a DATA-SOURCE boundary, not a thematic one.
 *  Autopilot, Economy and Throughput read only `audit_entries`, whose
 *  `json_extract(data, '$.started_at')` index already exists (`audit-indexes.ts`), so
 *  all three fall out of ONE indexed scan with no new index and no `operation_id` →
 *  risk resolution. Toolmaker / Waved through / Creator / Burst need both and are a
 *  separate slice.
 *
 *  ⛔ THE AUDIT LOG IS OPAQUE JSON, NOT COLUMNS — `audit_entries` is
 *  `(key TEXT PRIMARY KEY, data TEXT NOT NULL)`. Every predicate is a `json_extract`
 *  expression, and D-230 raised the quota default to 5 GB, so aggregating in SQL rather
 *  than pulling rows into JS is not a micro-optimisation: it is the difference between
 *  one indexed scan and parsing millions of JSON blobs.
 *
 *  ⛔⛔ ABSENT, NEVER ZERO. A metric whose denominator is empty returns `undefined`, and
 *  the caller must render that as "no data" rather than 0. On a share, 0 means "nothing
 *  ran unattended" — a real and bad reading; on an empty window it would be a lie about
 *  a server that simply did nothing. Same rule the § D5.3 note applies to Waved through.
 */

import type Database from 'better-sqlite3';

import {
  AUTOPILOT_TRIGGER_CLASS,
  METRIC_REGISTRY,
  metricRatio,
  type AutopilotClass,
  type MetricReading,
} from '@recued/contracts';

/** One computed metric. See {@link MetricReading} for why `reading` has three states
 *  rather than a nullable number. */
export interface AnchorMetricValue {
  readonly metric_id: string;
  readonly metric_version: number;
  readonly reading: MetricReading;
  /** ⚠ LOCAL ONLY — § D2 publishes the ratio and never the counts, because a count
   *  publishes VOLUME (how much server you own) where a ratio publishes SKILL.
   *  🔑 BOTH SIDES ARE CARRIED, and the numerator is not decoration: § D7's publish
   *  dialog must show *"here are your daily tokens, here are your daily ops, here is the
   *  ratio, and the ratio is the only thing that leaves"*. Reconstructing it as
   *  `value × denominator` would be arithmetic, not the measurement — and would round. */
  readonly numerator: number;
  readonly denominator: number;
}

export interface AnchorMetricsResult {
  readonly window: { readonly from: number; readonly to: number };
  readonly metrics: readonly AnchorMetricValue[];
  /** Runs whose `trigger_source` is a non-null string this build does not classify.
   *  ⛔ NOT AN ERROR COUNTER — it is the DRIFT DETECTOR. A `trigger_source` added
   *  elsewhere in the codebase lands here instead of silently joining a bucket and
   *  changing what Autopilot means without a `metric_version` bump. Surface it. */
  readonly unclassified_runs: number;
  /** Runs with a null `trigger_source`, kept separate from the above because
   *  "never recorded one" and "recorded one we do not know" are different facts and a
   *  single counter cannot tell them apart. */
  readonly null_trigger_runs: number;
  /** § D5.4's local FAMILY — shown on the dashboard, never published. Partial in this
   *  slice: `tokens_per_write` needs the risk resolution that arrives with slice 3. */
  readonly economy_family: {
    readonly tokens_per_run: number | undefined;
    readonly tokens_per_item: number | undefined;
  };
}

/** SQL fragment listing the sources in one Autopilot class.
 *
 *  🔑 GENERATED FROM THE REGISTRY RATHER THAN HAND-WRITTEN. Two hand-maintained copies
 *  of one closed vocabulary is how the SQL and the map drift apart while both keep
 *  looking correct — and drift here changes the metric's meaning with no version bump,
 *  which is precisely what `metric_version` cannot detect. */
const sourcesIn = (cls: AutopilotClass): string => {
  const list = Object.entries(AUTOPILOT_TRIGGER_CLASS)
    .filter(([, v]) => v === cls)
    .map(([k]) => `'${k}'`);
  // An empty IN () is a SQL syntax error; a never-matching literal keeps the shape.
  return list.length > 0 ? list.join(', ') : `''`;
};

const TS = `json_extract(data, '$.trigger_source')`;
const ITEMS = `COALESCE(json_extract(data, '$.run_yield.items_total'), 0)`;
const FAILED = `COALESCE(json_extract(data, '$.run_yield.items_failed'), 0)`;
const TOKENS = `COALESCE(json_extract(data, '$.total_usage.total_tokens'), 0)`;
const DUR = `COALESCE(json_extract(data, '$.duration_ms'), 0)`;

/** ⛔ EXCLUDED FROM ALL THREE: a backfill is a bulk catch-up loop, thousands of rows
 *  describing a migration rather than how the owner works. D-120 tags them precisely so
 *  they do not pollute activity feeds, and the same reasoning applies here. The
 *  `trigger_source` list excludes `backfill` too; this catches a backfill `run_mode`
 *  arriving under some other trigger. */
const NOT_BACKFILL = `COALESCE(json_extract(data, '$.run_mode'), 'live') <> 'backfill'`;

/** ⛔⛔ EVERY AGGREGATE IS `COALESCE(SUM(...), 0)`, AND THE BARE FORM IS A REAL BUG.
 *  `SUM()` over zero rows returns NULL in SQLite, not 0 — and the `as Row` cast below
 *  is an ASSERTION, not a check, so TypeScript happily hands a `null` to a field typed
 *  `number`. It then coerces silently: `null / 1000 === 0` in JS, so an empty window
 *  would produce a confident 0 rather than the "absent" this file exists to preserve.
 *  Caught by the empty-window test, not by the compiler. */
interface Row {
  autopilot_num: number;
  autopilot_den: number;
  unclassified: number;
  null_trigger: number;
  econ_items: number;
  econ_tokens: number;
  thru_items: number;
  thru_ms: number;
  token_runs: number;
  token_run_tokens: number;
}

export const computeAnchorMetrics = (
  db: Database.Database,
  window: { from: number; to: number },
): AnchorMetricsResult => {
  const known = [...Object.keys(AUTOPILOT_TRIGGER_CLASS).map((k) => `'${k}'`)].join(', ');

  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN ${TS} IN (${sourcesIn('unattended')}) THEN 1 ELSE 0 END), 0) AS autopilot_num,
         COALESCE(SUM(CASE WHEN ${TS} IN (${sourcesIn('unattended')}, ${sourcesIn('attended')})
                  THEN 1 ELSE 0 END), 0) AS autopilot_den,
         COALESCE(SUM(CASE WHEN ${TS} IS NOT NULL AND ${TS} NOT IN (${known})
                  THEN 1 ELSE 0 END), 0) AS unclassified,
         COALESCE(SUM(CASE WHEN ${TS} IS NULL THEN 1 ELSE 0 END), 0) AS null_trigger,
         -- Economy scope: BOTH items and tokens. A run that spent tokens without
         -- processing items is different work, not inefficiency, and putting its
         -- tokens in the denominator with nothing in the numerator would punish it.
         COALESCE(SUM(CASE WHEN ${ITEMS} > 0 AND ${TOKENS} > 0
                  THEN ${ITEMS} - ${FAILED} ELSE 0 END), 0) AS econ_items,
         COALESCE(SUM(CASE WHEN ${ITEMS} > 0 AND ${TOKENS} > 0 THEN ${TOKENS} ELSE 0 END), 0) AS econ_tokens,
         COALESCE(SUM(CASE WHEN ${ITEMS} > 0 AND ${DUR} > 0
                  THEN ${ITEMS} - ${FAILED} ELSE 0 END), 0) AS thru_items,
         COALESCE(SUM(CASE WHEN ${ITEMS} > 0 AND ${DUR} > 0 THEN ${DUR} ELSE 0 END), 0) AS thru_ms,
         COALESCE(SUM(CASE WHEN ${TOKENS} > 0 THEN 1 ELSE 0 END), 0) AS token_runs,
         COALESCE(SUM(CASE WHEN ${TOKENS} > 0 THEN ${TOKENS} ELSE 0 END), 0) AS token_run_tokens
       FROM audit_entries
       WHERE json_extract(data, '$.started_at') >= ?
         AND json_extract(data, '$.started_at') < ?
         AND ${NOT_BACKFILL}`,
    )
    .get(window.from, window.to) as Row | undefined;

  const r: Row = row ?? {
    autopilot_num: 0, autopilot_den: 0, unclassified: 0, null_trigger: 0,
    econ_items: 0, econ_tokens: 0, thru_items: 0, thru_ms: 0,
    token_runs: 0, token_run_tokens: 0,
  };

  return {
    window: { from: window.from, to: window.to },
    metrics: [
      {
        metric_id: 'autopilot',
        metric_version: METRIC_REGISTRY.autopilot!.metric_version,
        reading: metricRatio(r.autopilot_num, r.autopilot_den),
        numerator: r.autopilot_num,
        denominator: r.autopilot_den,
      },
      {
        // § D5.4 — MPG, not L/100km: items per 1,000 tokens, higher is better. The
        // x1000 scaling is not cosmetic; raw items ÷ tokens is ~0.002 and § B3.6's
        // four-place floor would flatten the band where batching visibly moves it.
        metric_id: 'economy',
        metric_version: METRIC_REGISTRY.economy!.metric_version,
        reading: metricRatio(r.econ_items, r.econ_tokens / 1000),
        numerator: r.econ_items,
        denominator: r.econ_tokens,
      },
      {
        metric_id: 'throughput',
        metric_version: METRIC_REGISTRY.throughput!.metric_version,
        reading: metricRatio(r.thru_items, r.thru_ms / 60_000),
        numerator: r.thru_items,
        denominator: r.thru_ms,
      },
    ],
    unclassified_runs: r.unclassified,
    null_trigger_runs: r.null_trigger,
    economy_family: {
      tokens_per_run: r.token_runs > 0 ? r.token_run_tokens / r.token_runs : undefined,
      tokens_per_item: r.econ_items > 0 ? r.econ_tokens / r.econ_items : undefined,
    },
  };
};

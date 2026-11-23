/** D-339 slice 10 (2026-11-17) — a Body reading's days, from Records, for the line on its page.
 *
 *  The line was the Body's reading history: a point each time the summary wrote a reading, dated
 *  when its post arrived. Measured live (`scripts/drives/d-339-body-lenses-live.mjs`): 14 days sent
 *  at once drew no line; a phone that caught up drew only the newest day; and a night that arrived
 *  on another day landed on that day, a day off the usual the Body's states judge with.
 *
 *  A reading whose writer cites a Body signals row (`body-signals.daily_metric`, keyed
 *  `<body_id>:<day>:<source>:<metric>`, as the summary cites each reading's row) now draws that
 *  source's rows of that measure: one a day, each on its own day. They are the days the states
 *  judge with, whenever each arrived. Any other reading keeps its history. */
import { isAssetDate, type Asset, type AssetReading } from '@recued/contracts';
import type { RecordsStore } from '../records/store.js';

/** D-339 §3.4 — the Body's daily rows: the pack that keeps them and its entity. The summary cites
 *  them as `body-signals.daily_metric`, and the webclient's evidence lines name the same rows
 *  (`apps/webclient/src/yours/reading-words.ts`). */
export const BODY_SIGNALS_DAYS = { owner: { publisher: 'recued-core', pack_slug: 'body-signals' }, entity: 'daily_metric' } as const;
const COLLECTION = `${BODY_SIGNALS_DAYS.owner.pack_slug}.${BODY_SIGNALS_DAYS.entity}`;
/** A Records page: more than the 91 days the page reaches, a row a day. */
const PAGE = 200;

/** A day of a reading, on the day it is for. `as_of` places it on the line. */
export type AssetReadingDay = AssetReading & { day: string };

/** The source of the Body signals row a reading's writer cites for this asset and measure, or
 *  undefined when it cites none. */
export const citedBodySignalsSource = (reading: AssetReading | null | undefined, assetId: string, field: string): string | undefined => {
  for (const entry of reading?.evidence ?? []) {
    if (entry.collection !== COLLECTION || typeof entry.id !== 'string') continue;
    const [body, day, source, metric, ...rest] = entry.id.split(':');
    if (body === assetId && isAssetDate(day) && source && metric === field && !rest.length) return source;
  }
  return undefined;
};

/** The page's history for a Body reading: its cited source's days in Records since `since`, newest
 *  first, each at the instant its day started (`day_start`). Undefined when the reading cites no
 *  Body signals row or Records cannot be read, so the page draws the reading's history instead. */
export const createAssetReadingDays = (records: Pick<RecordsStore, 'ownerSearch'>) =>
  (asset: Pick<Asset, 'id' | 'readings'>, field: string, limit: number, since: number): AssetReadingDay[] | undefined => {
    const source = citedBodySignalsSource(asset.readings[field], asset.id, field);
    if (source === undefined) return undefined;
    let rows: ReadonlyArray<Record<string, unknown>>;
    try {
      rows = records.ownerSearch({ ...BODY_SIGNALS_DAYS, sort: '-day_start', limit: Math.max(1, Math.min(limit, PAGE)),
        filters: { body_id: asset.id, metric: field, source, day_start: { op: 'gte', value: new Date(since).toISOString() } } }).records;
    } catch { return undefined; }
    return rows.flatMap((row) => {
      const at = typeof row.day_start === 'string' ? Date.parse(row.day_start) : NaN;
      const day = typeof row.day === 'string' ? row.day.slice(0, 10) : '';
      return typeof row.value === 'number' && Number.isFinite(row.value) && typeof row.unit === 'string' && Number.isFinite(at) && isAssetDate(day)
        ? [{ value: row.value, unit: row.unit, as_of: at, day, evidence: [] }] : [];
    });
  };

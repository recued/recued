/** D-325 P39 — arithmetic over a supplied window. No I/O, wall clock or cursor.
 * Malformed samples never become zero. Equal-time conflicting samples make the
 * verdict unknown rather than using input order as evidence. */
import { getField } from './evaluate.js';
import type { TransformFn } from './types.js';

type Row = Record<string, unknown>;
interface Sample { at: number; value: string | number | boolean; row: Row }
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const scalar = (value: unknown): value is Sample['value'] =>
  typeof value === 'string' || typeof value === 'boolean' || finite(value);
const field = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const instant = (value: unknown): number | null => {
  if (finite(value) && Math.abs(value) <= 8.64e15) return value;
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
};
const samples = (p: Row, valueField: unknown, numeric = false): Sample[] | null => {
  if (!Array.isArray(p.rows) || !field(p.time_field) || !field(valueField) || !finite(p.now)) return null;
  const result: Sample[] = [];
  for (const row of p.rows) {
    if (!object(row)) continue;
    const at = instant(getField(row, p.time_field));
    const value = getField(row, valueField);
    if (at === null || at > p.now || !(numeric ? finite(value) : scalar(value))) continue;
    result.push({ at, value: value as Sample['value'], row });
  }
  result.sort((a, b) => a.at - b.at);
  const unique: Sample[] = [];
  for (const sample of result) {
    const prior = unique[unique.length - 1];
    if (prior?.at === sample.at) {
      if (prior.value !== sample.value) return null;
    } else unique.push(sample);
  }
  return unique;
};

export const held: TransformFn = (p) => {
  const points = samples(p, p.state_field);
  const unknown = { status: 'unknown', value: null, since: null, evidence: [] };
  if (!points?.length || !finite(p.hold_ms) || p.hold_ms < 0) return unknown;
  const latest = points[points.length - 1]!;
  let start = points.length - 1;
  while (start > 0 && points[start - 1]!.value === latest.value) start -= 1;
  const since = points[start]!.at;
  return {
    // A single sample supplies a state, not evidence that it held.
    status: points.length >= 2 && (p.now as number) - since >= p.hold_ms ? 'settled' : 'pending',
    value: latest.value,
    since,
    evidence: points.slice(Math.max(0, start - 1)).map(point => point.row),
  };
};

export const transitions: TransformFn = (p) => {
  const points = samples(p, p.state_field);
  const unknown = { count: null, flickering: 'unknown', first_change: null, last_change: null, evidence: [] };
  if (!points || !finite(p.window_ms) || p.window_ms <= 0
    || !finite(p.min_count) || !Number.isInteger(p.min_count) || p.min_count < 1) return unknown;
  const start = (p.now as number) - p.window_ms;
  // Retain the one sample just before the boundary: it establishes the state
  // from which the first in-window change happened.
  const before = points.filter(point => point.at < start).slice(-1);
  const window = [...before, ...points.filter(point => point.at >= start)];
  if (window.length < 2) return unknown;
  const changes = window.filter((point, i) => i > 0 && point.at >= start && point.value !== window[i - 1]!.value);
  return {
    count: changes.length,
    flickering: changes.length >= p.min_count ? true : window[0]!.at <= start ? false : 'unknown',
    first_change: changes[0]?.at ?? null,
    last_change: changes[changes.length - 1]?.at ?? null,
    evidence: window.map(point => point.row),
  };
};

export const window_change: TransformFn = (p) => {
  const points = samples(p, p.value_field, true);
  const unknown = { status: 'unknown', percent_change: null, from: null, to: null, evidence: [] };
  if (!points || !finite(p.window_ms) || p.window_ms <= 0) return unknown;
  const window = points.filter(point => point.at >= (p.now as number) - (p.window_ms as number));
  if (window.length < 2) return unknown;
  const from = window[0]!;
  const to = window[window.length - 1]!;
  if (from.value === 0) return { ...unknown, evidence: [from.row, to.row] };
  const change = ((to.value as number) - (from.value as number)) / Math.abs(from.value as number) * 100;
  if (!Number.isFinite(change)) return unknown;
  return {
    status: 'known', percent_change: change,
    from: { value: from.value, at: from.at }, to: { value: to.value, at: to.at },
    evidence: [from.row, to.row],
  };
};

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** D-339 — the window's latest value against its own usual: the median of the
 * window's earlier samples, never the latest itself, with the median absolute
 * deviation beside it for a "usual range". The latest is reported whenever it
 * exists; with too few earlier samples (`count` says how many) or a latest
 * older than `max_age_ms`, there is no usual to compare it with. */
const usual = (p: Row) => {
  const none = { status: 'unknown', latest: null, median: null, mad: null, count: null,
    difference: null, percent_difference: null, evidence: [] as Row[] };
  const points = samples(p, p.value_field, true);
  if (!points || !finite(p.window_ms) || p.window_ms <= 0
    || !finite(p.min_count) || !Number.isInteger(p.min_count) || p.min_count < 1
    || (p.max_age_ms !== undefined && (!finite(p.max_age_ms) || p.max_age_ms < 0))) return none;
  const window = points.filter(point => point.at >= (p.now as number) - (p.window_ms as number));
  const last = window[window.length - 1];
  if (!last) return none;
  const latest = { value: last.value as number, at: last.at };
  if (p.max_age_ms !== undefined && (p.now as number) - last.at > (p.max_age_ms as number)) {
    return { ...none, latest, evidence: [last.row] };
  }
  const earlier = window.slice(0, -1).map(point => point.value as number);
  const evidence = window.map(point => point.row);
  if (earlier.length < (p.min_count as number)) return { ...none, latest, count: earlier.length, evidence };
  const middle = median(earlier);
  const mad = median(earlier.map(value => Math.abs(value - middle)));
  const difference = latest.value - middle;
  const percent_difference = middle === 0 ? null : difference / Math.abs(middle) * 100;
  if (![middle, mad, difference, percent_difference ?? 0].every(Number.isFinite)) return none;
  return { status: 'known', latest, median: middle, mad, count: earlier.length, difference, percent_difference, evidence };
};

/** The two-sided 95% bound of the Mann–Kendall test's z. */
const TREND_Z = 1.96;
/** The most samples one window may hold: the slope takes every pair of them. A recipe with more,
 *  a reading every minute say, summarizes them per day first. */
export const TREND_MAX_SAMPLES = 1000;
const DAY_MS = 86_400_000;

/** D-339 slice 9 — which way the window's values are going. The slope is Theil–Sen's: the median of
 * the slopes between every two samples, so one odd day moves it little. The direction is `rising` or
 * `falling` only when both of these hold, and `steady` otherwise:
 * - the order of the values is more than chance: the Mann–Kendall test, two-sided at 95%, with its
 *   correction for tied values;
 * - the change across the samples is larger than their spread around the line (the median absolute
 *   residual), so a steady drift smaller than an ordinary day's wobble is not called a trend.
 * `slope` is per day of the time field, `change` the slope across the samples' span, both in the
 * values' unit. Fewer than `min_count` samples, more than `TREND_MAX_SAMPLES`, or a latest older
 * than `max_age_ms` give unknown, still saying how many and what the latest is. */
const direction = (p: Row) => {
  const none = { status: 'unknown', direction: null, slope: null, change: null, spread: null, count: null,
    latest: null, evidence: [] as Row[] };
  const points = samples(p, p.value_field, true);
  if (!points || !finite(p.window_ms) || p.window_ms <= 0
    || !finite(p.min_count) || !Number.isInteger(p.min_count) || p.min_count < 2
    || (p.max_age_ms !== undefined && (!finite(p.max_age_ms) || p.max_age_ms < 0))) return none;
  const window = points.filter(point => point.at >= (p.now as number) - (p.window_ms as number));
  const last = window[window.length - 1];
  if (!last) return none;
  const latest = { value: last.value as number, at: last.at };
  if (p.max_age_ms !== undefined && (p.now as number) - last.at > (p.max_age_ms as number)) {
    return { ...none, latest, evidence: [last.row] };
  }
  const evidence = window.map(point => point.row);
  const n = window.length;
  if (n < (p.min_count as number) || n > TREND_MAX_SAMPLES) return { ...none, latest, count: n, evidence };
  // Times from the first sample, so the line's arithmetic never works near an epoch's size.
  const t = window.map(point => point.at - window[0]!.at);
  const v = window.map(point => point.value as number);
  const slopes: number[] = [];
  let s = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      slopes.push((v[j]! - v[i]!) / (t[j]! - t[i]!));
      s += Math.sign(v[j]! - v[i]!);
    }
  }
  const slope = median(slopes);
  const intercept = median(v.map((value, i) => value - slope * t[i]!));
  const spread = median(v.map((value, i) => Math.abs(value - intercept - slope * t[i]!)));
  const change = slope * t[n - 1]!;
  const tied = new Map<number, number>();
  for (const value of v) tied.set(value, (tied.get(value) ?? 0) + 1);
  let variance = n * (n - 1) * (2 * n + 5);
  for (const count of tied.values()) variance -= count * (count - 1) * (2 * count + 5);
  const z = variance > 0 ? (s - Math.sign(s)) / Math.sqrt(variance / 18) : 0;
  const perDay = slope * DAY_MS;
  if (![perDay, change, spread, z].every(Number.isFinite)) return none;
  const moving = Math.abs(z) >= TREND_Z && Math.sign(change) === Math.sign(s) && Math.abs(change) > spread;
  return { status: 'known', direction: moving ? (change > 0 ? 'rising' : 'falling') : 'steady',
    slope: perDay, change, spread, count: n, latest, evidence };
};

/** With `series_fields`, one result per series (a metric from one source, say),
 * sorted by its key, so each is read only against its own history. A row
 * missing a key part belongs to no series; a malformed field list gives []. */
const perSeries = (p: Row, compute: (p: Row) => Row): Row | Row[] => {
  if (p.series_fields === undefined) return compute(p);
  const fields = p.series_fields;
  if (!Array.isArray(fields) || !fields.length || !fields.every(name => field(name)) || !Array.isArray(p.rows)) return [];
  const series = new Map<string, { key: Row; rows: Row[] }>();
  for (const row of p.rows) {
    if (!object(row)) continue;
    const parts = fields.map(name => getField(row, name as string));
    if (!parts.every(scalar)) continue;
    const id = JSON.stringify(parts);
    const entry = series.get(id) ?? { key: Object.fromEntries(fields.map((name, i) => [name, parts[i]])), rows: [] };
    entry.rows.push(row);
    series.set(id, entry);
  }
  return [...series.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, entry]) => ({ series: entry.key, ...compute({ ...p, rows: entry.rows }) }));
};

export const baseline: TransformFn = (p) => perSeries(p, usual);
export const trend: TransformFn = (p) => perSeries(p, direction);

const coordinate = (lat: unknown, lon: unknown): lat is number =>
  finite(lat) && finite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
const radians = (degrees: number): number => degrees * Math.PI / 180;

export const within_distance: TransformFn = (p) => {
  const unknown = { status: 'unknown', nearest_km: null, matches: [], evidence: [] };
  if (!object(p.place) || !coordinate(p.place.latitude, p.place.longitude)
    || !Array.isArray(p.rows) || !field(p.latitude_field) || !field(p.longitude_field)
    || !finite(p.radius_km) || p.radius_km < 0) return unknown;
  const latitude = p.place.latitude;
  const longitude = p.place.longitude as number;
  const distances: Array<{ distance_km: number; row: Row }> = [];
  for (const row of p.rows) {
    if (!object(row)) continue;
    const lat = getField(row, p.latitude_field);
    const lon = getField(row, p.longitude_field);
    if (!coordinate(lat, lon)) continue;
    const a = Math.sin(radians(lat - latitude) / 2) ** 2
      + Math.cos(radians(latitude)) * Math.cos(radians(lat)) * Math.sin(radians((lon as number) - longitude) / 2) ** 2;
    const distance_km = 6371.0088 * 2 * Math.atan2(Math.sqrt(Math.min(1, a)), Math.sqrt(Math.max(0, 1 - a)));
    distances.push({ distance_km, row });
  }
  if (!distances.length) return unknown;
  distances.sort((a, b) => a.distance_km - b.distance_km);
  const matches = distances.filter(point => point.distance_km <= (p.radius_km as number));
  return { status: 'known', nearest_km: distances[0]!.distance_km, matches,
    evidence: (matches.length ? matches : distances.slice(0, 1)).map(point => point.row) };
};

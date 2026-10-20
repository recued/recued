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

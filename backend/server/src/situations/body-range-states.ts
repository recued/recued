/** D-339 slice 17 (D-339 §6) — a Body's readings outside the owner's own ranges (slice 16), as
 *  states: "Weight over your range · Ben's body", at the top of Today while they hold, as the summary's are.
 *
 *  Worked out on each read from the Body's readings and its ranges, never written. The summary's states are
 *  conditions it writes through its binding; one more would need the Body type's next version and the summary
 *  enrolled again, and a Body with a field its binding lacks refuses every write (slice 14), so the Body would
 *  stop updating in between. A range is the owner's own setting on the Body, so its state is the readings
 *  and the ranges read together, as slice 14's staleness and slice 15's goal progress are.
 *
 *  - A reading in another unit than its range says nothing; so does one that has probably changed (slice 14):
 *    a weight weighed 40 days ago is over nothing today. Staleness that cannot be read says nothing either.
 *  - Its title names the reading and the side, never a number: a state goes into the daily stream. */
import { bodyRangePlace, readBodyRanges, type Asset, type AssetReading, type BodyGoalField, type BodyRange } from '@recued/contracts';
import { assetReadingStaleness } from './asset-reading-staleness.js';
import type { BodyReadingHistory } from './body-goals.js';
import { readingWords } from './values-on-request.js';

export interface BodyRangeState {
  field: BodyGoalField;
  place: 'over' | 'under';
  reading: AssetReading;
}

export const bodyRangeStates = (
  asset: Pick<Asset, 'readings' | 'settings' | 'dates'>,
  /** The Body's samples of a reading since a moment, each on the day it is for (`readingDays`). */
  history: BodyReadingHistory,
  now: number,
  timeZone: string,
): BodyRangeState[] => {
  const ranges = Object.entries(readBodyRanges(asset.settings)) as Array<[BodyGoalField, BodyRange]>;
  if (!ranges.length) return [];
  let stale: ReadonlySet<string>;
  try { stale = new Set(assetReadingStaleness(asset, history, now, timeZone).map(row => row.field)); } catch { return []; }
  return ranges.flatMap(([field, range]): BodyRangeState[] => {
    const reading = asset.readings[field] ?? null;
    if (!reading || !Number.isFinite(reading.value) || reading.unit !== range.unit || stale.has(field)) return [];
    const { place } = bodyRangePlace(range, reading.value);
    return place === 'in' ? [] : [{ field, place, reading }];
  });
};

/** "Weight over your range · Ben's body". */
export const bodyRangeStateTitle = (state: Pick<BodyRangeState, 'field' | 'place'>, name: string): string => {
  const words = readingWords(state.field);
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} ${state.place} your range · ${name}`;
};

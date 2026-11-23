/** D-339 slice 18 (D-339 §3.6) — a weight or height the owner types on a Body's page is a
 *  measurement: a row in Records from `typed`, saved by the Body signals pack's `record-body-measurement`,
 *  never the Body's own reading. The summary runs after it and shows it until a reading from a newer day
 *  comes from any source. The owner's own value would outrank the summary's writes until the owner chose
 *  "Allow automatic updates" on it, and then even an older weigh-in would replace it.
 *
 *  - `record`: runs the recipe as the owner's own run, and fails with the run's reason when it saved nothing
 *    ("A weight is between 2 and 500 kg. Nothing was saved.").
 *  - `BODY_MEASUREMENT_UNITS`: the unit each measurement is kept in, the pack's own. */
import type { AssetPatch, ServerExecuteResponse } from '@recued/contracts';

export const BODY_MEASUREMENT_RECIPE = 'record-body-measurement';

/** What a typed measurement is kept in: the Body signals pack's own units. */
export const BODY_MEASUREMENT_UNITS = Object.freeze({ weight: 'kg', height: 'cm' } as const);
export type BodyMeasurementField = keyof typeof BODY_MEASUREMENT_UNITS;

export const isBodyMeasurementField = (field: string): field is BodyMeasurementField => Object.hasOwn(BODY_MEASUREMENT_UNITS, field);

export interface BodyMeasureArgs {
  asset_id: string;
  weight?: number;
  height?: number;
  /** The day measured, `YYYY-MM-DD`; today in the server's zone when absent. */
  day?: string;
}

/** What the page says once a typed measurement is saved: the summary that shows it runs after the save. */
export const BODY_MEASURED_WORDS = 'Saved as typed by you. The Body shows it once its summary has run, in a moment.';

/** What the page's reading editor says of a typed weight or height on a Body, in place of "Your entry takes
 *  priority over automatic updates to this field". */
export const BODY_MEASUREMENT_PRIORITY_WORDS = 'Saved as typed by you. A reading from a newer day, from any source, replaces it.';

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const localDay = (at: number): string => {
  const date = new Date(at);
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

/** The measurement a reading editor's patch makes on a Body: exactly one weight in kg or height in cm, on the
 *  day it was observed (this device's day; left to the server when it is today, so the owner's zone decides).
 *  Anything else is not one, and is saved as the editor saves it. */
export const bodyMeasurementFromPatch = (assetId: string, patch: AssetPatch, now = Date.now()): BodyMeasureArgs | undefined => {
  if (patch.observations !== undefined) return undefined;
  const entries = Object.entries(patch.readings ?? {});
  if (entries.length !== 1) return undefined;
  const [field, reading] = entries[0]!;
  if (!reading || !isBodyMeasurementField(field) || reading.unit !== BODY_MEASUREMENT_UNITS[field] || !Number.isFinite(reading.value)) return undefined;
  const day = localDay(reading.as_of);
  return { asset_id: assetId, [field]: reading.value, ...(DAY.test(day) && day !== localDay(now) ? { day } : {}) };
};

/** The `execute` rpc, as the bootstrap calls it for a run the owner starts (`trigger_source: 'manual'`). */
export type BodyMeasureExecute = (args: { recipe_id: string; config: Record<string, unknown> }) => Promise<ServerExecuteResponse>;

export interface BodyMeasure {
  record(args: BodyMeasureArgs): Promise<void>;
}

/** The first reason a run gives for saving nothing, in its own words. */
const reasonOf = (result: ServerExecuteResponse): string | undefined => {
  for (const error of result.errors ?? []) {
    if (typeof error === 'string' && error.trim()) return error.trim();
    if (error !== null && typeof error === 'object') {
      const { message, reason } = error as { message?: unknown; reason?: unknown };
      if (typeof reason === 'string' && reason.trim()) return reason.trim();
      if (typeof message === 'string' && message.trim()) return message.trim();
    }
  }
  return undefined;
};

export const createBodyMeasure = (deps: { execute: BodyMeasureExecute }): BodyMeasure => ({
  record: async ({ asset_id, weight, height, day }) => {
    const config: Record<string, unknown> = { asset_id,
      ...(weight !== undefined ? { weight } : {}), ...(height !== undefined ? { height } : {}), ...(day !== undefined ? { day } : {}) };
    const result = await deps.execute({ recipe_id: BODY_MEASUREMENT_RECIPE, config });
    if (result.awaiting_approval) throw new Error('Saving the measurement is waiting for your approval in Approvals. Nothing was saved yet.');
    if (!result.success) throw new Error(reasonOf(result) ?? 'The measurement was not saved.');
  },
});

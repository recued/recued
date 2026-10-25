import type { Asset, SituationAssetDetails } from '@recued/contracts';

/** One asset's details as JSON, at most, before `left_out`. In the chat lookup's
 * 6,000 bytes they give way before their item does (`prefetch.ts`). */
export const SITUATION_ASSET_DETAILS_MAX_BYTES = 900;
/** One text value, in characters; a longer one says how many it lost. */
export const SITUATION_ASSET_TEXT_MAX = 200;
const LEFT_OUT_NAMES = 5;
const NAME_MAX = 64;

const size = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
const shortened = (value: string): string => {
  const characters = [...value];
  return characters.length <= SITUATION_ASSET_TEXT_MAX ? value
    : `${characters.slice(0, SITUATION_ASSET_TEXT_MAX).join('')}… (${characters.length - SITUATION_ASSET_TEXT_MAX} more characters)`;
};

/** What a model reads of an asset beside its clocks. Settings and attributes are
 * what the owner typed, and are shown as typed. A removed attribute (stored as
 * null) is not shown; a null date or reading is, since the asset says it is
 * unknown. */
export const situationAssetDetails = (
  asset: Pick<Asset, 'class_id' | 'status' | 'dates' | 'readings' | 'settings' | 'attributes'>,
): SituationAssetDetails => {
  const details: SituationAssetDetails = { ...(asset.class_id ? { class_id: asset.class_id } : {}), status: asset.status };
  const left: string[] = [];
  const leave = (group: string, name: string) => left.push(`${group}.${name.length > NAME_MAX ? `${name.slice(0, NAME_MAX)}…` : name}`);
  // Each field is kept only if the whole block still fits; one that does not is
  // named instead, and a smaller one after it may still fit.
  const fits = (undo: () => void, group: string, name: string): void => {
    if (size(details) <= SITUATION_ASSET_DETAILS_MAX_BYTES) return;
    undo(); leave(group, name);
  };
  const put = (group: 'dates' | 'readings' | 'settings' | 'attributes', name: string, value: unknown): void => {
    const map = (details[group] ??= {}) as Record<string, unknown>;
    map[name] = value;
    fits(() => { delete map[name]; if (!Object.keys(map).length) delete details[group]; }, group, name);
  };
  for (const [name, value] of Object.entries(asset.dates ?? {})) put('dates', name, value);
  for (const [name, reading] of Object.entries(asset.readings ?? {})) {
    put('readings', name, reading ? { value: reading.value, unit: reading.unit, as_of: reading.as_of } : null);
  }
  for (const group of ['settings', 'attributes'] as const) {
    for (const [name, raw] of Object.entries(asset[group] ?? {})) {
      if (raw === null || raw === undefined) continue;
      if (typeof raw === 'string') put(group, name, shortened(raw));
      else if (typeof raw === 'boolean' || (typeof raw === 'number' && Number.isFinite(raw))) put(group, name, raw);
      else leave(group, name);
    }
  }
  if (left.length) details.left_out = left.length > LEFT_OUT_NAMES ? [...left.slice(0, LEFT_OUT_NAMES), `+${left.length - LEFT_OUT_NAMES} more`] : left;
  return details;
};

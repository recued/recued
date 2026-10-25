import type { SituationPlace } from '@recued/contracts';

let names: Intl.DisplayNames | undefined;
const regionName = (code: string): string => {
  try { return (names ??= new Intl.DisplayNames(['en'], { type: 'region' })).of(code) ?? code; } catch { return code; }
};
/** A country as a place, for a trip the owner repeats: keyed by its two-letter
 * code (`country:JP`) and named in English ("Japan"). */
export const countryPlace = (code: string): SituationPlace => ({ key: `country:${code}`, name: regionName(code) });
/** The country a place stands for, when it is one. */
export const placeCountry = (place: SituationPlace | undefined): string | undefined => /^country:([A-Z]{2})$/u.exec(place?.key ?? '')?.[1];

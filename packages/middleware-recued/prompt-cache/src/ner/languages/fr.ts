/** French NER rules: Unicode Latin names, including particles, compound
 * atoms, and French diacritics. Universal email/date/time rules live in the
 * shared extractor. */

import type { LanguageRules } from '../extract.js';
import { extractLatinNames } from './latin.js';

export const FR_RULES: LanguageRules = {
  locale: 'fr',
  extract: extractLatinNames,
};

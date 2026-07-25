/** Spanish NER rules: Unicode Latin names, including particles, compound
 * atoms, and Spanish diacritics. Universal email/date/time rules live in the
 * shared extractor. */

import type { LanguageRules } from '../extract.js';
import { extractLatinNames } from './latin.js';

export const ES_RULES: LanguageRules = {
  locale: 'es',
  extract: extractLatinNames,
};

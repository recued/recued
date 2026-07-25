/** German NER rules: Unicode Latin names, including particles, compound
 * atoms, and German diacritics. Universal email/date/time rules live in the
 * shared extractor. */

import type { LanguageRules } from '../extract.js';
import { extractLatinNames } from './latin.js';

export const DE_RULES: LanguageRules = {
  locale: 'de',
  extract: extractLatinNames,
};

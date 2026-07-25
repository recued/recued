/** Portuguese NER rules: Unicode Latin names, including particles, compound
 * atoms, and Portuguese diacritics. Universal email/date/time rules live in
 * the shared extractor. */

import type { LanguageRules } from '../extract.js';
import { extractLatinNames } from './latin.js';

export const PT_RULES: LanguageRules = {
  locale: 'pt',
  extract: extractLatinNames,
};

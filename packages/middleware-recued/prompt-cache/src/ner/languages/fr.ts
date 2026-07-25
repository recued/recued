/** D-164 P4d — French language stub.
 *
 *  Placeholder rule bundle. Locale is registered so the substrate can
 *  route French prompts here, but no locale-specific patterns are
 *  defined yet — the language-agnostic patterns in `../extract.ts`
 *  (email / ISO date / 24-hour time) carry the load until French
 *  name / locale-date / locale-time rules land.
 *
 *  Returning an empty array is the stub contract: "this locale has
 *  nothing to add beyond the universal patterns." See the English
 *  module (`en.ts`) for the substantive reference shape.
 *
 *  See: docs/d-164-prompt-cache-consolidation-pending-design.md
 *  § 1 ner/languages. */

import type { LanguageRules } from '../extract.js';

export const FR_RULES: LanguageRules = {
  locale: 'fr',
  extract: () => [],
};

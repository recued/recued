/** Chinese NER rules. CJK names are emitted only beside a supported
 * deterministic contact/calendar/mail intent; the exact contact lookup is
 * the second certainty check. */

import type { LanguageRules } from '../extract.js';
import { extractContextualCjkNames } from './cjk.js';

export const ZH_RULES: LanguageRules = {
  locale: 'zh',
  extract: (text) => extractContextualCjkNames(text, 'zh'),
};

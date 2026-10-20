import { contactExcludedFromProactive } from '@recued/contracts';
import { PROSE_FUNCTION_WORDS } from '@recued/middleware-prompt-cache';
import type { ContactStore } from '../storage/contact-store.js';
import type { SituationReadContext } from './query.js';

/** Index-backed local name resolution. Both contact grants pass before this
 * read; each candidate's sphere is fenced before correlation. */
export const createSituationNamedPeople = (contacts: ContactStore) => (text: string, context: SituationReadContext): Array<{ id: string; name: string }> => {
  const tokens = [...new Set(text.toLocaleLowerCase('en').match(/[\p{L}\p{N}]+/gu) ?? [])]
    .filter(token => [...token].length >= 2 && !PROSE_FUNCTION_WORDS.has(token)).slice(0, 32);
  if (!tokens.length) return [];
  const candidates = contacts.prefetchCandidates({ tokens, forms: [], emails: [] });
  // A saturated name set needs a narrower explicit question.
  if (candidates.length > 100) return [];
  return candidates.flatMap(candidate => {
    const contact = contacts.get(candidate.email); if (!contact || contactExcludedFromProactive(contact) || !contact.name) return [];
    const id = contact.contact_id ?? contact.email; const sphere = context.referenceSphere?.({ collection: 'contact', id });
    if (!context.owner && !context.all_spheres && (!sphere || !context.spheres?.includes(sphere))) return [];
    const words = contact.name.toLocaleLowerCase('en').match(/[\p{L}\p{N}]+/gu) ?? [];
    if (!words.some(word => tokens.includes(word))) return [];
    return [{ id, name: contact.name }];
  });
};

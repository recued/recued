import { contactExcludedFromProactive, type ContactRecord } from '@recued/contracts';
import { PROSE_FUNCTION_WORDS } from '@recued/middleware-prompt-cache';
import type { ContactStore } from '../storage/contact-store.js';
import type { SituationReadContext } from './query.js';

const nameWords = (value: string): string[] => value.toLocaleLowerCase('en').match(/[\p{L}\p{N}]+/gu) ?? [];

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
    if (!nameWords(contact.name).some(word => tokens.includes(word))) return [];
    return [{ id, name: contact.name }];
  });
};

/** The contacts one `people` entry of a query names. A model names people as the
 * owner does, by name or address, and cannot know a contact's id. An entry that is
 * a contact's id or address is that contact; any other is every contact whose name
 * holds each of its words (an initial is skipped), so "Ana" can name several. */
export const createSituationPeopleFor = (contacts: ContactStore) => (entry: string, context: SituationReadContext): string[] => {
  const idOf = (contact: ContactRecord | null): string[] => {
    if (!contact || contactExcludedFromProactive(contact)) return [];
    const id = contact.contact_id ?? contact.email; const sphere = context.referenceSphere?.({ collection: 'contact', id });
    return context.owner || context.all_spheres || (sphere && context.spheres?.includes(sphere)) ? [id] : [];
  };
  const value = entry.trim();
  const named = contacts.getByContactIdResolved(value) ?? contacts.get(value);
  if (named) return idOf(named);
  const tokens = [...new Set(nameWords(value))].filter(token => [...token].length >= 2);
  if (!tokens.length) return [];
  return [...new Set(contacts.prefetchCandidates({ tokens, forms: [], emails: [] }).flatMap(candidate => {
    const contact = contacts.get(candidate.email); const words = nameWords(contact?.name ?? '');
    return tokens.every(token => words.includes(token)) ? idOf(contact) : [];
  }))];
};

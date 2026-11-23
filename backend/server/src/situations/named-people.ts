import { contactExcludedFromProactive, type ContactRecord } from '@recued/contracts';
import { PROSE_FUNCTION_WORDS } from '@recued/middleware-prompt-cache';
import type { ContactStore } from '../storage/contact-store.js';
import { contactIdRunsIn, pickedContacts } from '../chat-picked-contacts.js';
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

/** D-406 follow-up (2026-11-20) — a contact the owner picked settles its own name (`chat-picked-contacts.ts`).
 * For a message that carries a picked contact by its exact id, whether a person is that contact's namesake: a
 * contact reached only through words of a picked contact's name or company, so not one the owner could mean
 * beside the pick. The situation lookup leaves out such a person's items (`prefetch.ts`). Null when the message
 * carries no pick, and then nothing changes. A person the owner's own words reach by any other word stays: beside
 * a picked Priya Raman at Lumen Studio, a Priya Raman at Northgate is her namesake until the message says
 * "Northgate". */
export const createSituationPickSettlement = (contacts: ContactStore | undefined) =>
  (message: string): ((personId: string) => boolean) | null => {
    if (!contacts) return null;
    const picked = pickedContacts(contactIdRunsIn(message), contacts);
    if (!picked.length) return null;
    const words = (contact: ContactRecord): string[] => [...nameWords(contact.name ?? ''), ...nameWords(contact.company ?? '')];
    const tokens = new Set(nameWords(message).filter(token => [...token].length >= 2 && !PROSE_FUNCTION_WORDS.has(token)));
    const explained = new Set(picked.flatMap(words));
    const pickedIds = new Set(picked.map(contact => contact.contact_id ?? contact.email));
    return (personId: string): boolean => {
      if (pickedIds.has(personId)) return false;
      const contact = contacts.getByContactIdResolved(personId) ?? contacts.get(personId);
      if (!contact || pickedIds.has(contact.contact_id ?? contact.email)) return false;
      const reached = words(contact).filter(word => tokens.has(word));
      return reached.length > 0 && reached.every(word => explained.has(word));
    };
  };

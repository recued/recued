import { contactExcludedFromProactive, type ContactRecord } from '@recued/contracts';
import type { ContactStore } from './storage/contact-store.js';

/** D-406 follow-up (2026-11-20) — a contact the owner picked settles its own name.
 *
 *  "Add records" puts a picked contact's exact id in the message beside its name, and "Chat about this" puts its
 *  id beside its email. Both lookups that run before the first round match contacts by the words of their names,
 *  so a same-named contact came back as a second candidate:
 *  - the situation lookup showed both people's birthdays, each `ambiguous`, under "ask which one before acting";
 *  - the contact lookup said "Do NOT assume which one is meant: ask the user", or, on "Chat about this", listed the
 *    namesake as a confident match.
 *  The pick had already said which. Measured live (qwen3.7-plus, 4 turns each, side by side): with a same-named
 *  contact an "Add records" turn took a median 40 s and 1,667 reasoning tokens, against 26 s and 794 with the other
 *  contact named otherwise. Every answer was the picked one's either way, on agnes-3.0-flash too.
 *
 *  A contact's id is 32 hex digits, and only a pick puts one in a message: the owner never types one. Keyed on it,
 *  a message with no pick is matched exactly as before. */
export const CONTACT_ID_PATTERN = /^[0-9a-f]{32}$/u;
const CONTACT_ID_RUN = /(?<![\p{L}\p{N}])[0-9a-f]{32}(?![\p{L}\p{N}])/gu;
/** "Add records" adds at most 20 records to a message; more ids than that are not picks. */
const PICKED_CONTACT_LOOKUPS_MAX = 20;

/** The 32-hex runs in a message, each once, in order. */
export const contactIdRunsIn = (text: string): string[] => [...new Set(text.match(CONTACT_ID_RUN) ?? [])];

/** The contacts these strings name by their exact id, each once (a merged contact as its survivor). A string that
 *  is no contact's id adds none, nor does a contact the owner keeps out of what Recued brings up by itself. */
export const pickedContacts = (
  ids: Iterable<string>,
  contacts: Pick<ContactStore, 'getByContactIdResolved'> | undefined,
): ContactRecord[] => {
  if (!contacts) return [];
  const seen = new Set<string>();
  const found: ContactRecord[] = [];
  let looked = 0;
  for (const id of ids) {
    if (!CONTACT_ID_PATTERN.test(id)) continue;
    looked += 1;
    if (looked > PICKED_CONTACT_LOOKUPS_MAX) break;
    const contact = contacts.getByContactIdResolved(id);
    if (!contact || contactExcludedFromProactive(contact)) continue;
    const key = contact.contact_id ?? contact.email;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(contact);
  }
  return found;
};

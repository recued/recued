import { TASK_TITLE_MAX, type ContactRecord } from '@recued/contracts';
import { serializeShellRoute } from '../shell/route.js';

export type ContactFollowUpKind = 'task' | 'note';

/** A follow-up belongs to the selected person, including after an email change.
 * A merged or replaced contact requires the owner to reopen the right profile. */
export const requireFollowUpContact = (original: ContactRecord, current: ContactRecord | null): ContactRecord => {
  if (!original.contact_id || !current?.contact_id || original.contact_id !== current.contact_id
    || original.merged_into !== undefined || current.merged_into !== undefined || original.created_at !== current.created_at) {
    throw new Error('This contact is no longer available with the same identity. Reopen its profile before continuing.');
  }
  return current;
};

export const contactFollowUpValues = (kind: ContactFollowUpKind, contact: ContactRecord, clientUrl: string): Record<string, unknown> => {
  requireFollowUpContact(contact, contact);
  if (kind === 'note') return { title: '', body: '', related_contact: [contact.contact_id!] };
  const url = new URL(clientUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('The contact link is unavailable. Reopen the profile before creating a task.');
  url.search = ''; url.username = ''; url.password = '';
  url.hash = serializeShellRoute('data', 'contact', contact.contact_id!);
  const title = `Follow up with ${contact.name?.trim() || contact.email}`;
  let bounded = '';
  for (const character of title) { if (bounded.length + character.length > TASK_TITLE_MAX) break; bounded += character; }
  // The person is the context, not an inferred assignee. The editor owns all
  // scheduling, destination and assignment choices.
  return { title: bounded, body: `Contact: ${url.href}`, done: false, due_at: null };
};

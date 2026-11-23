import { isMailboxAddress, isMentionOnlyEmail, type ContactRecord } from '@recued/contracts';
import { serializeShellRoute } from '../shell/route.js';

/** A selected identity and its display label, never a snapshot of contact facts. */
export interface SelectedContactContext { readonly id: string; readonly name: string; readonly email?: string }

export const readSelectedContactContext = (raw: unknown): SelectedContactContext | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !['id', 'name', 'email'].includes(key))
    || typeof value.id !== 'string' || !value.id || value.id.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value.id)
    || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 2048
    || value.email !== undefined && (typeof value.email !== 'string' || !isMailboxAddress(value.email) || isMentionOnlyEmail(value.email))) return null;
  return { id: value.id, name: value.name, ...(typeof value.email === 'string' ? { email: value.email } : {}) };
};

export const selectedContactContext = (contact: Pick<ContactRecord, 'contact_id' | 'email' | 'name'>): SelectedContactContext | null =>
  readSelectedContactContext({ id: contact.contact_id || contact.email,
    name: (contact.name?.trim() || (isMentionOnlyEmail(contact.email) ? 'Contact' : contact.email)).slice(0, 2048),
    ...(isMailboxAddress(contact.email) && !isMentionOnlyEmail(contact.email) ? { email: contact.email } : {}) });

export const contactContextHref = (context: Pick<SelectedContactContext, 'id'>): string =>
  serializeShellRoute('data', 'contact', context.id);

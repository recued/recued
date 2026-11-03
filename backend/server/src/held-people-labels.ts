/** D-336 (spec §40–§41) — how an approval names the people a held call carries.
 *
 *  Told "Email Mia …" beside a contact Mia Whitfield, the AI emailed her without asking in 6
 *  of 6 runs, and the approval showed only her address; the owner chose to have the approval
 *  name the contact (§40). The same holds for any action aimed at a person: a calendar
 *  event's attendees, a task's assignee, a commitment's counterparty. So every string the
 *  held call carries, at any depth and under any argument, that is the address of a named
 *  contact reads `Mia Whitfield <mia.whitfield@example.test>`, and a Recued contact id reads
 *  `Mia Whitfield` (`ANY_ARGUMENT`). §44: a phone number one contact has reads
 *  `Mia Whitfield (+15551234567)`.
 *
 *  Display only: the labels are written into the owner's approval (the held run's checkpoint),
 *  never into what the caller is told of the hold, so an AI app learns no name from them. A
 *  lookup that fails costs the label, never the hold. */

import {
  ANY_ARGUMENT, canonicalizePhone, isMentionOnlyEmail, readEncodedEmailHeaders, type ApprovalValueLabels,
} from '@recued/contracts';

import type { ContactStore } from './storage/contact-store.js';

/** What the labels read contacts through. */
export type PeopleLookups = Pick<ContactStore, 'resolveCanonicalEmail' | 'get' | 'getByContactIdResolved' | 'findByPhone'>;

/** A whole value that is an address, not text that mentions one. */
const ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
/** A Recued contact id: a UUID's 32 hex digits (`contact-store.ts`, `newContactId`). */
const CONTACT_ID = /^[0-9a-f]{32}$/;
/** D-336 (spec §44) — a whole value written as a phone number: digits, a leading `+`, spaces,
 *  brackets, dots and dashes. */
const PHONE = /^\+?[\d\s().-]+$/;

/** The number in the E.164 form contacts keep, or undefined. Given no country, the helper takes
 *  only a number written with its `+` and 7 to 15 digits, so a date, an amount or a local number
 *  is never looked up. */
const phoneOf = (value: string): string | undefined =>
  PHONE.test(value) ? canonicalizePhone(value) ?? undefined : undefined;
/** Bounds: a held call is read as far as a person reads it, never as far as it goes. */
const MAX_DEPTH = 8;
const MAX_STRINGS = 500;
const MAX_LOOKUPS = 100;

/** A name that says more than the address it would stand beside. */
const nameOf = (name: string | undefined, address?: string): string | undefined => {
  const trimmed = name?.trim();
  return trimmed === undefined || trimmed === '' || trimmed.includes('@')
    || (address !== undefined && trimmed.toLowerCase() === address.toLowerCase()) ? undefined : trimmed;
};

/** The contact an address is, through a merge or as a second address, as `contact.resolve`
 *  finds it. A placeholder address is none: no mail reaches it. */
const nameByAddress = (contacts: PeopleLookups, address: string): string | undefined =>
  isMentionOnlyEmail(address) ? undefined
    : nameOf(contacts.get(contacts.resolveCanonicalEmail(address).canonical_email)?.name, address);

export const heldPeopleValueLabels = (
  held: readonly unknown[],
  contacts: PeopleLookups | undefined,
): ApprovalValueLabels | undefined => {
  if (contacts === undefined) return undefined;
  const named = new Map<string, string>();
  const seen = new Set<string>();
  let strings = 0;
  let lookups = 0;
  const consider = (value: string): void => {
    if (seen.has(value)) return;
    seen.add(value);
    const trimmed = value.trim();
    const isAddress = ADDRESS.test(trimmed);
    const isContactId = !isAddress && CONTACT_ID.test(trimmed);
    const phone = isAddress || isContactId ? undefined : phoneOf(trimmed);
    if (!isAddress && !isContactId && phone === undefined) {
      // D-336 (spec §42) — an email passed encoded: the people its headers send to.
      const headers = readEncodedEmailHeaders(trimmed);
      for (const address of headers === undefined ? [] : [...headers.to, ...headers.cc, ...headers.bcc]) consider(address);
      return;
    }
    if (lookups >= MAX_LOOKUPS) return;
    lookups += 1;
    let label: string | undefined;
    try {
      if (isAddress) {
        const name = nameByAddress(contacts, trimmed);
        if (name !== undefined) label = `${name} <${trimmed}>`;
      } else if (phone !== undefined) {
        // Only a number one contact has: a shared number names no one (`findByPhone`).
        const name = nameOf(contacts.findByPhone(phone).contact?.name);
        if (name !== undefined) label = `${name} (${trimmed})`;
      } else {
        label = nameOf(contacts.getByContactIdResolved(trimmed)?.name);
      }
    } catch {
      // A label is never worth the hold.
      return;
    }
    if (label !== undefined) named.set(value, label);
  };
  const visit = (value: unknown, depth: number): void => {
    if (strings >= MAX_STRINGS) return;
    if (typeof value === 'string') {
      strings += 1;
      consider(value);
      return;
    }
    if (value === null || typeof value !== 'object' || depth >= MAX_DEPTH) return;
    for (const member of Array.isArray(value) ? value : Object.values(value)) visit(member, depth + 1);
  };
  for (const args of held) visit(args, 0);
  return named.size > 0 ? { [ANY_ARGUMENT]: Object.fromEntries(named) } : undefined;
};

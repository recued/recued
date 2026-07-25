/** D-121 Phase 1 — contact derivation from mail / calendar inserts.
 *
 *  Two pure functions that turn one source record (mail message or
 *  calendar event) into a list of contact observations the contact
 *  store can apply via `observeBatch`. Pure on purpose — no DB
 *  access, no IO; the caller pipes the output into the store and
 *  decides whether to swallow / report errors.
 *
 *  Header parsing is deliberately tolerant: `parseAddress` returns
 *  null on garbage; `splitAddressList` defends against quoted display
 *  names containing commas. Both come from `@recued/contracts/contact`
 *  so the canonicalization rules stay symmetric across the codebase. */

import {
  canonicalizeEmail,
  parseAddress,
  splitAddressList,
  type ContactSource,
} from '@recued/contracts';
import type { ContactObservation } from '../storage/contact-store.js';
import type { CanonicalMessage } from '../collections/mail/provider.js';
import type { CanonicalEvent } from '@recued/contracts';

/** Parse one mail header into observations. `event_at` carries the
 *  message's `Date:` header (mail's `received_at` field) so the
 *  contact's `first_seen` reflects the underlying email's chronology
 *  rather than today's ingestion clock (per D-120 7.5 bistemporal
 *  stamping). The caller folds the From / To / CC slices into one
 *  list before calling `observeBatch`. */
export const deriveContactsFromMail = (msg: CanonicalMessage): ContactObservation[] => {
  const observations: ContactObservation[] = [];
  const eventAt = msg.received_at;

  // From — single sender, source = email_from.
  for (const raw of splitAddressList(msg.from)) {
    const parsed = parseAddress(raw);
    if (!parsed) continue;
    const obs: ContactObservation = {
      email: parsed.email,
      source: 'email_from',
      event_at: eventAt,
    };
    if (parsed.name) obs.name = parsed.name;
    observations.push(obs);
  }

  // To / CC — recipients, source = email_to (these are people *we*
  // wrote to or were CC'd alongside on a thread we're part of).
  const recipientHeaders = [...(msg.to ?? []), ...(msg.cc ?? [])];
  for (const headerValue of recipientHeaders) {
    for (const raw of splitAddressList(headerValue)) {
      const parsed = parseAddress(raw);
      if (!parsed) continue;
      const obs: ContactObservation = {
        email: parsed.email,
        source: 'email_to',
        event_at: eventAt,
      };
      if (parsed.name) obs.name = parsed.name;
      observations.push(obs);
    }
  }

  return observations;
};

/** Parse a canonical calendar event into observations. Organizer +
 *  attendees become contacts. The event's `start_at` is the
 *  bistemporal anchor — backfilled events from 2023 carry their real
 *  start date as `first_seen`, not the ingestion timestamp. */
export const deriveContactsFromCalendar = (event: CanonicalEvent): ContactObservation[] => {
  const observations: ContactObservation[] = [];
  const eventAt = event.start_at;
  const SOURCE: ContactSource = 'calendar_attendee';

  if (event.organizer?.email) {
    const email = canonicalizeEmail(event.organizer.email);
    if (email) {
      const obs: ContactObservation = {
        email,
        source: SOURCE,
        event_at: eventAt,
      };
      if (event.organizer.display_name) obs.name = event.organizer.display_name;
      observations.push(obs);
    }
  }

  for (const attendee of event.attendees ?? []) {
    if (!attendee?.email) continue;
    const email = canonicalizeEmail(attendee.email);
    if (!email) continue;
    const obs: ContactObservation = {
      email,
      source: SOURCE,
      event_at: eventAt,
    };
    if (attendee.display_name) obs.name = attendee.display_name;
    observations.push(obs);
  }

  return observations;
};

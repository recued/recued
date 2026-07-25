/** D-121 Phase 1 — contact derivation tests.
 *
 *  Pure-function tests on `deriveContactsFromMail` /
 *  `deriveContactsFromCalendar` plus an integration test that pipes
 *  the deriver output through the contact store with a fake mail
 *  message + calendar event. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deriveContactsFromMail,
  deriveContactsFromCalendar,
} from '../warehouse/contact-derive.js';
import { createContactStore, type ContactStore } from '../storage/contact-store.js';
import type { CanonicalMessage } from '../collections/mail/provider.js';
import type { CanonicalEvent } from '@recued/contracts';

const sampleMessage = (overrides: Partial<CanonicalMessage> = {}): CanonicalMessage => ({
  source_id: 'm1',
  from: 'Bob <bob@x.com>',
  to: ['alice@x.com'],
  cc: [],
  subject: 'Hello',
  thread_id: 't1',
  folder_or_label: 'INBOX',
  is_read: false,
  has_attachments: false,
  received_at: 1_000_000,
  body_text: 'Hi there',
  ...overrides,
});

const sampleEvent = (overrides: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
  source_id: 'e1',
  ical_uid: 'uid1',
  calendar_id: 'cal-primary',
  summary: 'Sync',
  start_at: 2_000_000,
  end_at: 2_003_600,
  timezone: 'UTC',
  is_all_day: false,
  status: 'confirmed',
  created_at: 0,
  updated_at: 0,
  organizer: { email: 'organizer@x.com', display_name: 'Org Anizer' },
  attendees: [
    { email: 'A@example.com', display_name: 'Alice', response_status: 'accepted' },
    { email: 'b@example.com', response_status: 'tentative' },
  ],
  ...overrides,
});

describe('deriveContactsFromMail', () => {
  it('extracts sender as email_from and recipients as email_to', () => {
    const obs = deriveContactsFromMail(sampleMessage());
    expect(obs).toEqual([
      { email: 'bob@x.com', name: 'Bob', source: 'email_from', event_at: 1_000_000 },
      { email: 'alice@x.com', source: 'email_to', event_at: 1_000_000 },
    ]);
  });

  it('handles multi-address recipients with quoted display names', () => {
    const obs = deriveContactsFromMail(
      sampleMessage({
        to: ['"Smith, John" <john@x.com>, jane@x.com'],
        cc: ['support@x.com (Help)'],
      }),
    );
    const emails = obs.map((o) => o.email);
    expect(emails).toContain('john@x.com');
    expect(emails).toContain('jane@x.com');
    expect(emails).toContain('support@x.com');
    const support = obs.find((o) => o.email === 'support@x.com');
    expect(support?.name).toBe('Help');
    const john = obs.find((o) => o.email === 'john@x.com');
    expect(john?.name).toBe('Smith, John');
  });

  it('preserves the source record date as event_at', () => {
    const obs = deriveContactsFromMail(sampleMessage({ received_at: 555 }));
    expect(obs.every((o) => o.event_at === 555)).toBe(true);
  });

  it('skips garbage entries silently', () => {
    const obs = deriveContactsFromMail(
      sampleMessage({ to: ['not-an-email'], cc: [''] }),
    );
    // Just the From-derived entry survives.
    expect(obs.map((o) => o.email)).toEqual(['bob@x.com']);
  });

  it('canonicalizes mixed-case addresses', () => {
    const obs = deriveContactsFromMail(sampleMessage({ from: 'BOB@X.COM' }));
    expect(obs[0]?.email).toBe('bob@x.com');
  });
});

describe('deriveContactsFromCalendar', () => {
  it('extracts organizer + attendees as calendar_attendee', () => {
    const obs = deriveContactsFromCalendar(sampleEvent());
    expect(obs.map((o) => o.email)).toEqual([
      'organizer@x.com',
      'a@example.com', // canonicalized from `A@example.com`
      'b@example.com',
    ]);
    expect(obs.every((o) => o.source === 'calendar_attendee')).toBe(true);
  });

  it('uses event start_at as event_at for bistemporal stamping', () => {
    const obs = deriveContactsFromCalendar(sampleEvent({ start_at: 99_999 }));
    expect(obs.every((o) => o.event_at === 99_999)).toBe(true);
  });

  it('skips attendees with empty email', () => {
    const obs = deriveContactsFromCalendar(
      sampleEvent({
        attendees: [
          { email: '', response_status: 'accepted' },
          { email: 'real@x.com', response_status: 'accepted' },
        ],
      }),
    );
    expect(obs.map((o) => o.email).filter((e) => e !== 'organizer@x.com')).toEqual(['real@x.com']);
  });

  it('returns empty array when neither organizer nor attendees are present', () => {
    const obs = deriveContactsFromCalendar(
      sampleEvent({
        attendees: undefined,
        ...({ organizer: undefined } as Partial<CanonicalEvent>),
      }),
    );
    expect(obs).toEqual([]);
  });
});

describe('integration — mail + calendar derivation through the store', () => {
  let dir: string;
  let db: Database.Database;
  let store: ContactStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'contact-derive-'));
    db = new Database(join(dir, 'test.db'));
    db.pragma('journal_mode = WAL');
    store = createContactStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('first-seen-wins: mail email_from outranks subsequent calendar_attendee', () => {
    store.observeBatch(deriveContactsFromMail(sampleMessage({ received_at: 100 })));
    store.observeBatch(
      deriveContactsFromCalendar(
        sampleEvent({
          start_at: 200,
          attendees: [{ email: 'bob@x.com', response_status: 'accepted' }],
        }),
      ),
    );
    const bob = store.get('bob@x.com');
    expect(bob?.source).toBe('email_from');
    expect(bob?.first_seen).toBe(100);
    expect(bob?.last_interaction).toBe(200);
    expect(bob?.interaction_count).toBe(2);
  });

  it('respects the older event_at on out-of-order ingest', () => {
    // Calendar event from 2023 ingests today; mail from 2024 already
    // landed yesterday. last_interaction should be the *newer* of
    // 2024 and 2023, not the moment we ingested.
    store.observeBatch(deriveContactsFromMail(sampleMessage({ from: 'X <x@y.com>', received_at: 1_700_000_000_000 })));
    store.observeBatch(
      deriveContactsFromCalendar(
        sampleEvent({
          start_at: 1_690_000_000_000,
          organizer: { email: 'x@y.com' },
          attendees: [],
        }),
      ),
    );
    const x = store.get('x@y.com');
    expect(x?.last_interaction).toBe(1_700_000_000_000);
    expect(x?.first_seen).toBe(1_700_000_000_000);
  });
});

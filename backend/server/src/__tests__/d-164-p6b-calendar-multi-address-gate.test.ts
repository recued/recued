/** D-164 P6b — calendar next-meeting over a contact's COMPLETE address set.
 *
 *  The prompt-cache answer is a short-circuit, so being confidently wrong is
 *  worse than passing through to the LLM. This suite pins the widened backend
 *  lookup at the real `createPromptCacheGateDeps` seam: "next" means the
 *  minimum future attendee event over every linked address Recued knows for
 *  the resolved contact (canonical + D-138 merged-away), not just the current
 *  canonical row. It also locks the split-response ambiguity rule: if an
 *  event has Pat declined under one linked address and non-declined under
 *  another, the event becomes an inconclusive horizon; a horizon before the
 *  clean best defers rather than risking a later false "next" answer. */

import { describe, expect, it } from 'vitest';

import { CALENDAR_NEXT_MEETING_TEMPLATE } from '@recued/middleware-prompt-cache';
import type { CanonicalEvent } from '@recued/contracts';

import { createPromptCacheGateDeps } from '../chat-prompt-cache-gate.js';
import type { CalendarCollection } from '../collections/calendar/calendar-collection.js';
import type { Collection } from '../collections/types.js';
import type { CollectionRegistry } from '../collections/registry.js';
import type { ContactStore } from '../storage/contact-store.js';

const DAY_MS = 86_400_000;

const NAME_SLOT = {
  kind: 'entity.name',
  value: 'Pat Lee',
  raw: 'Pat Lee',
  position: 25,
} as const;

const contactStore = (
  rows: ReadonlyArray<{ email: string; name?: string }>,
  mergedSourceEmails: readonly string[] = ['old-pat@y.com'],
): ContactStore =>
  ({
    list: () => rows,
    // D-205 #3.5b — addressSet is the COMPLETE set: the anchor UNIONED with the
    // merged-away addresses (deduped + sorted, as the real walk returns them).
    addressSet: (email: string) => [...new Set([email, ...mergedSourceEmails])].sort(),
  }) as unknown as ContactStore;

const patStore = (
  mergedSourceEmails: readonly string[] = ['old-pat@y.com'],
): ContactStore => contactStore([{ email: 'pat@x.com', name: 'Pat Lee' }], mergedSourceEmails);

const event = (over: Partial<CanonicalEvent>): CanonicalEvent =>
  ({
    source_id: 's',
    ical_uid: 'u',
    calendar_id: 'primary',
    calendar_name: 'Primary',
    summary: 'Quarterly business review',
    description: '',
    location: 'Zoom',
    start_at: 0,
    end_at: 0,
    timezone: 'America/New_York',
    is_all_day: false,
    organizer: { email: 'me@x.com', display_name: 'Me' },
    attendees: [
      { email: 'pat@x.com', display_name: 'Pat Lee', response_status: 'accepted' },
    ],
    status: 'confirmed',
    created_at: 0,
    updated_at: 0,
    ...over,
  }) as CanonicalEvent;

const fakeCalendar = (events: ReadonlyArray<CanonicalEvent>): Collection =>
  ({
    platform: 'calendar',
    slug: 'cal',
    table: {
      listSnapshots: (q: { start_since?: number; limit?: number }) =>
        events
          .filter((e) => e.start_at >= (q.start_since ?? 0))
          .slice()
          .sort((a, b) => a.start_at - b.start_at)
          .slice(0, q.limit ?? 1000)
          .map((e) => ({ event: e })),
    },
  }) as unknown as CalendarCollection as Collection;

const registry = (...collections: Collection[]): CollectionRegistry =>
  ({ list: () => collections }) as unknown as CollectionRegistry;

const probeCalendar = async (
  getRegistry: () => CollectionRegistry | undefined,
  store: ContactStore | undefined = patStore(),
) => {
  const deps = createPromptCacheGateDeps(() => store, getRegistry);
  return await deps.probeData({
    template: CALENDAR_NEXT_MEETING_TEMPLATE,
    slots: [NAME_SLOT],
  });
};

describe('D-164 P6b backend calendar next-meeting multi-address gate', () => {
  it('fires via a merged-away attendee address', async () => {
    const now = Date.now();
    const out = await probeCalendar(() =>
      registry(
        fakeCalendar([
          event({
            summary: 'Former-address planning',
            start_at: now + 3 * DAY_MS,
            attendees: [
              { email: 'old-pat@y.com', display_name: 'Pat Lee', response_status: 'accepted' },
            ],
          }),
        ]),
      ),
    );
    expect(out?.data).toMatchObject({ name: 'Pat Lee', summary: 'Former-address planning' });
  });

  it('treats next as the earliest event across canonical and merged-away addresses', async () => {
    const now = Date.now();
    const out = await probeCalendar(() =>
      registry(
        fakeCalendar([
          event({
            source_id: 'later-canonical',
            summary: 'Canonical later',
            start_at: now + 9 * DAY_MS,
            attendees: [
              { email: 'pat@x.com', display_name: 'Pat Lee', response_status: 'accepted' },
            ],
          }),
          event({
            source_id: 'earlier-merged',
            summary: 'Merged earlier',
            start_at: now + 2 * DAY_MS,
            attendees: [
              { email: 'old-pat@y.com', display_name: 'Pat Lee', response_status: 'accepted' },
            ],
          }),
        ]),
      ),
    );
    expect(out?.data.summary).toBe('Merged earlier');
  });

  it('defers when a response split could be the next meeting', async () => {
    const now = Date.now();
    const out = await probeCalendar(() =>
      registry(
        fakeCalendar([
          event({
            source_id: 'split-earlier',
            summary: 'Ambiguous earlier',
            start_at: now + 2 * DAY_MS,
            attendees: [
              { email: 'pat@x.com', display_name: 'Pat Lee', response_status: 'declined' },
              { email: 'old-pat@y.com', display_name: 'Pat Lee', response_status: 'accepted' },
            ],
          }),
          event({
            source_id: 'clean-later',
            summary: 'Clean later',
            start_at: now + 6 * DAY_MS,
            attendees: [
              { email: 'old-pat@y.com', display_name: 'Pat Lee', response_status: 'accepted' },
            ],
          }),
        ]),
      ),
    );
    expect(out).toBeNull();
  });

  it('does not defer when a later response split cannot beat the clean best', async () => {
    const now = Date.now();
    const out = await probeCalendar(() =>
      registry(
        fakeCalendar([
          event({
            source_id: 'clean-earlier',
            summary: 'Clean earlier',
            start_at: now + 2 * DAY_MS,
            attendees: [
              { email: 'pat@x.com', display_name: 'Pat Lee', response_status: 'accepted' },
            ],
          }),
        ]),
        fakeCalendar([
          event({
            source_id: 'split-later',
            summary: 'Ambiguous later',
            start_at: now + 8 * DAY_MS,
            attendees: [
              { email: 'pat@x.com', display_name: 'Pat Lee', response_status: 'declined' },
              { email: 'old-pat@y.com', display_name: 'Pat Lee', response_status: 'accepted' },
            ],
          }),
        ]),
      ),
    );
    expect(out?.data.summary).toBe('Clean earlier');
  });

  it('skips an all-declined event across both addresses in favour of a later clean one', async () => {
    const now = Date.now();
    const out = await probeCalendar(() =>
      registry(
        fakeCalendar([
          event({
            source_id: 'declined-both',
            summary: 'Declined on both',
            start_at: now + 2 * DAY_MS,
            attendees: [
              { email: 'pat@x.com', display_name: 'Pat Lee', response_status: 'declined' },
              { email: 'old-pat@y.com', display_name: 'Pat Lee', response_status: 'declined' },
            ],
          }),
          event({
            source_id: 'accepted-later',
            summary: 'Accepted later',
            start_at: now + 7 * DAY_MS,
            attendees: [
              { email: 'old-pat@y.com', display_name: 'Pat Lee', response_status: 'accepted' },
            ],
          }),
        ]),
      ),
    );
    expect(out?.data.summary).toBe('Accepted later');
  });

  it('matches a merged-away attendee address case-insensitively', async () => {
    const now = Date.now();
    const out = await probeCalendar(() =>
      registry(
        fakeCalendar([
          event({
            summary: 'Uppercase former-address review',
            start_at: now + 4 * DAY_MS,
            attendees: [
              { email: 'OLD-PAT@Y.COM', display_name: 'Pat Lee', response_status: 'accepted' },
            ],
          }),
        ]),
      ),
    );
    expect(out?.data.summary).toBe('Uppercase former-address review');
  });

  it('defers when the merged-away address enumeration reaches the completeness cap', async () => {
    const now = Date.now();
    const atCapMerged = Array.from({ length: 64 }, (_, i) => `m${i}@y.com`);
    const out = await probeCalendar(
      () =>
        registry(
          fakeCalendar([
            event({
              summary: 'Canonical match but incomplete set',
              start_at: now + 3 * DAY_MS,
              attendees: [
                { email: 'pat@x.com', display_name: 'Pat Lee', response_status: 'accepted' },
              ],
            }),
          ]),
        ),
      patStore(atCapMerged),
    );
    expect(out).toBeNull();
  });

  it('dedupes canonical addresses repeated in the merged-away list', async () => {
    const now = Date.now();
    const out = await probeCalendar(
      () =>
        registry(
          fakeCalendar([
            event({
              summary: 'Deduped former-address review',
              start_at: now + 5 * DAY_MS,
              attendees: [
                { email: 'old-pat@y.com', display_name: 'Pat Lee', response_status: 'accepted' },
              ],
            }),
          ]),
        ),
      patStore(['pat@x.com', 'old-pat@y.com']),
    );
    expect(out?.data.summary).toBe('Deduped former-address review');
  });
});

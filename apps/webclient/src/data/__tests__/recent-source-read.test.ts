import { expect, it, vi } from 'vitest';
import type { CalendarEventSnapshot, MailMessageSnapshot } from '@recued/contracts';
import { createMailMessageSurface } from '../mail-message-surface.js';
import { createCalendarEventSurface } from '../calendar-event-surface.js';

it('keeps a prepared mail identity bound through the reader read and releases that binding on an ordinary new visit', async () => {
  const original: MailMessageSnapshot = { slug: 'work', record_id: 'same/id', received_at: 1, subject: 'Original', from: 'riley@example.test',
    to: [], cc: [], body: 'Original body', body_truncated: false, read: 'stored', reply: null };
  const surface = createMailMessageSurface({ document: { defaultView: null } as Document, actionAttr: 'data-action', render: vi.fn(), callers: {
    get: async ref => ({ ...original, ...ref, received_at: 2, subject: 'Replacement', body: 'Different identity body' }),
  } });
  await surface.open({ slug: 'work', record_id: original.record_id }, original);
  expect(surface.render()).toContain('different identity'); expect(surface.render()).not.toContain('Different identity body'); expect(surface.recentSnapshot()).toBeNull();
  await surface.open({ slug: 'home', record_id: original.record_id });
  expect(surface.recentSnapshot()).toMatchObject({ slug: 'home', received_at: 2, subject: 'Replacement' });
  surface.dispose();
});

it('rejects a calendar replacement after preparation without leaking the replacement snapshot into history', async () => {
  const original: CalendarEventSnapshot = { event: { record_id: 'occurrence', source_id: 'provider-event', calendar_id: 'work', summary: 'Original',
    updated_at: 1, description: '', location: '', start_at: 1, end_at: 2, timezone: 'UTC', is_all_day: false, is_recurring: true, status: 'confirmed' },
    record: { record_id: 'occurrence', source_id: 'provider-event', received_at: 1, modified_at: 1, size_bytes: 0, hot_fields: {} },
    resource_version: 'v1', incarnation: 'calendar-1', editable: false };
  const surface = createCalendarEventSurface({ actionAttr: 'data-action', render: vi.fn(), onSaved: vi.fn(), onRemoved: vi.fn(), callers: {
    get: async () => ({ ...original, incarnation: 'calendar-2', event: { ...original.event, summary: 'Replacement' } }),
  } });
  const ref = { slug: 'work', source_id: 'provider-event' };
  await surface.open(ref, original.event.record_id, original);
  expect(surface.render()).toContain('different identity'); expect(surface.render()).not.toContain('Replacement'); expect(surface.recentSnapshot()).toBeNull();
  await surface.open(ref, original.event.record_id);
  expect(surface.recentSnapshot()?.snapshot.incarnation).toBe('calendar-2'); surface.dispose();
});

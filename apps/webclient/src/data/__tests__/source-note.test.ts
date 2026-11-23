import { describe, expect, it } from 'vitest';
import { NOTE_TITLE_MAX, type CalendarEventSnapshot, type MailMessageSnapshot } from '@recued/contracts';
import { calendarNoteValues, mailNoteValues } from '../source-note.js';
import { parseShellRoute, parseSourceRecordAddress } from '../../shell/route.js';
import { renderTaskNotes } from '../../../../../packages/ui-shared/src/work-entity-page/task-notes.js';
import { renderNoteMarkdown } from '../../../../../packages/ui-shared/src/work-entity-page/note-markdown.js';

const message: MailMessageSnapshot = { slug: 'work/one', record_id: "mail?二.)!'*", from: 'Alex <alex@example.test>', to: [], cc: [],
  subject: ' Review the quote ', received_at: 1, body: 'Private original body', body_truncated: false, read: 'stored', reply: null };
const snapshot: CalendarEventSnapshot = { event: { record_id: 'occurrence/one?二', source_id: 'provider-uid', calendar_id: 'work', calendar_name: 'Planning',
  summary: ' Launch planning ', description: 'Original event notes', location: '', updated_at: 1, start_at: 1, end_at: 2,
  timezone: 'UTC', is_all_day: false, is_recurring: true, status: 'confirmed' },
  record: { record_id: 'occurrence/one?二', source_id: 'provider-uid', received_at: 1, modified_at: 1, size_bytes: 0, hot_fields: {} },
  resource_version: 'v1', incarnation: 'work-1', editable: false };
const client = 'https://owner:secret@recued.example/client/?token=private#data/calendar';

describe('notes from an exact email or calendar occurrence', () => {
  it.each(['mail', 'calendar'] as const)('seeds a %s note with a qualified source link and no inferred relationships', kind => {
    const values = kind === 'mail' ? mailNoteValues(message, client) : calendarNoteValues({ slug: 'work/one', source_id: 'provider-uid' }, snapshot, client);
    expect(Object.keys(values).sort()).toEqual(['body', 'title']);
    expect(values.title).toBe(kind === 'mail' ? 'Notes: Review the quote' : 'Notes: Launch planning');
    const body = String(values.body), href = body.match(/<([^>]+)>/)![1]!;
    expect(body.endsWith('>\n\n')).toBe(true);
    const url = new URL(href);
    expect(url.origin + url.pathname).toBe('https://recued.example/client/');
    expect(url.username + url.password + url.search).toBe('');
    expect(parseSourceRecordAddress(parseShellRoute(url.hash))).toEqual({ tab: kind, collectionSlug: 'work/one', recordId: kind === 'mail' ? message.record_id : snapshot.event.record_id });
    const escaped = href.replace(/'/g, '&#39;');
    for (const html of [renderTaskNotes(body, 'note'), renderNoteMarkdown(body).html]) {
      expect(html).toContain(`href="${escaped}"`); expect(html).toContain('data-note-note-link=');
    }
    expect(message.body).toBe('Private original body'); expect(snapshot.event.summary).toBe(' Launch planning ');
  });

  it('bounds imported titles without splitting Unicode and keeps a useful fallback', () => {
    expect(mailNoteValues({ ...message, subject: 'x'.repeat(NOTE_TITLE_MAX - 8) + '🧾tail' }, client).title).toBe('Notes: ' + 'x'.repeat(NOTE_TITLE_MAX - 8));
    expect(mailNoteValues({ ...message, subject: ' ' }, client).title).toBe('Notes: Email');
    expect(calendarNoteValues({ slug: 'work', source_id: 'provider-uid' }, { ...snapshot, event: { ...snapshot.event, summary: ' ' } }, client).title).toBe('Notes: Calendar event');
  });

  it('refuses a mismatched calendar record or provider identity and unusable original links', () => {
    expect(() => calendarNoteValues({ slug: 'work', source_id: 'other' }, snapshot, client)).toThrow('could not be confirmed');
    expect(() => calendarNoteValues({ slug: 'work', source_id: 'provider-uid' }, { ...snapshot, record: { ...snapshot.record, record_id: 'other' } }, client)).toThrow('could not be confirmed');
    expect(() => mailNoteValues({ ...message, slug: '' }, client)).toThrow('could not be confirmed');
    expect(() => mailNoteValues(message, 'file:///client/')).toThrow('link is unavailable');
  });

  it('keeps plain note markup literal and only adds safe source links', () => {
    const body = '<img src=x> **plain** https://external.test/path javascript:alert(1)\n#data/calendar/record/work/event';
    const html = renderTaskNotes(body, 'note');
    expect(html).toContain('&lt;img src=x&gt; **plain** https://external.test/path javascript:alert(1)');
    expect(html).not.toMatch(/<img|<strong/); expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain('href="#data/calendar/record/work/event"');
  });
});

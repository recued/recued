import { describe, expect, it } from 'vitest';
import { selectedContactContext, contactContextHref, readSelectedContactContext } from '../../contacts/contact-context.js';
import { assetChatMessage, readAssetChatMessage } from '../asset-context.js';
import { recordChatMessage, readRecordChatMessage, recordContextFromRecovery, recordContextRecovery, withSelectedRecords } from '../record-context.js';
import { serializeShellRoute } from '../../shell/route.js';
import type { PreparedRecordLink } from '../../data/record-link-insert.js';
import { copyComposerRecoveryDraft, hasComposerRecoveryDraft, hasProtectedChatRecoveryDraft } from '../draft-recovery.js';
import { calendarEventContextHref, readSelectedCalendarEventContext, selectedCalendarEventContext } from '../../calendar/event-context.js';
import type { CalendarEventSnapshot } from '@recued/contracts';

describe('Selected contact context', () => {
  const contact = { contact_id: 'contact:alex/one', email: 'alex@example.test', name: 'Alex Rivera' };
  it('sends only the selected identity and question, and resolves the return link to that identity', () => {
    const selected = selectedContactContext(contact)!;
    const context = recordContextFromRecovery({ contactContext: selected })!;
    const message = recordChatMessage('Which commitments need attention?', context);
    expect(message).toContain('"id":"contact:alex/one"');
    expect(message).not.toContain('Alex Rivera');
    expect(readRecordChatMessage(message)).toMatchObject({ question: 'Which commitments need attention?',
      context: { kind: 'contact', id: contact.contact_id, email: contact.email }, href: '#data/contact/contact%3Aalex%2Fone' });
    expect(contactContextHref(selected)).toBe('#data/contact/contact%3Aalex%2Fone');
    const noEmail = selectedContactContext({ contact_id: 'no-email', email: 'mention-only-no-email@_recued.invalid', name: 'Alex' })!;
    expect(noEmail).toEqual({ id: 'no-email', name: 'Alex' });
  });

  it('names the reader and its argument, and still reads back a question sent in the earlier words', () => {
    // D-406 follow-up (2026-11-20): told only to "read the current saved contact", the model looked the contact up
    // by its email before reading it in 11 of 16 turns.
    const context = recordContextFromRecovery({ contactContext: selectedContactContext(contact)! })!;
    const message = recordChatMessage('When is their birthday?', context);
    expect(message).toContain('Read the current saved contact with contact.read, its id below as the target_id, before answering about them.');
    const earlier = 'When is their birthday?\n\nRead the current saved contact using the exact contact reference below before answering '
      + 'about them. This reference is not a snapshot, evidence that anything has been read, or permission to change anything. Use the '
      + 'ordinary governed readers, distinguish saved facts from inference, and say what is unavailable.\n'
      + '{"kind":"recued.contact_question","version":1,"contact":{"id":"contact:alex/one","email":"alex@example.test"}}';
    expect(readRecordChatMessage(earlier)).toMatchObject({ question: 'When is their birthday?',
      context: { kind: 'contact', id: contact.contact_id, email: contact.email }, href: '#data/contact/contact%3Aalex%2Fone' });
    // As strict as today's words: an extended envelope, or one the webclient did not write, stays text.
    expect(readRecordChatMessage(earlier.replace('"email":"alex@example.test"}}', '"email":"alex@example.test","x":1}}'))).toBeNull();
    expect(readRecordChatMessage(earlier.replace('{"id":"contact:alex/one","email":"alex@example.test"}',
      '{"email":"alex@example.test","id":"contact:alex/one"}'))).toBeNull();
    // And as the base of a records question, with a note added beside the contact.
    const note: PreparedRecordLink = { reference: { key: 'n1', target: { tab: 'note', id: 'n1', hash: serializeShellRoute('data', 'note', 'n1') },
      identity: JSON.stringify(['note', 'n1', 'recued.note', null, 1]), href: '#data/note/n1', title: 'Quote notes', details: [] } };
    const withRecord = recordChatMessage('When is their birthday?', withSelectedRecords(context, [note])!);
    const stored = withRecord.replace(message, earlier);
    expect(stored).not.toBe(withRecord);
    for (const sent of [stored, withRecord]) {
      expect(readRecordChatMessage(sent)).toMatchObject({ question: 'When is their birthday?',
        context: { kind: 'records', base: { kind: 'contact', id: contact.contact_id }, records: [{ reference: { target: { tab: 'note', id: 'n1' } } }] } });
    }
  });

  it('keeps malformed and extended envelopes as ordinary text', () => {
    const context = recordContextFromRecovery({ contactContext: selectedContactContext(contact)! })!;
    const message = recordChatMessage('Check the latest details.', context);
    expect(readRecordChatMessage(message.replace('"version":1', '"version":2'))).toBeNull();
    expect(readRecordChatMessage(message.replace('"id":"contact:alex/one"', '"id":"contact:alex/one","phone":"made up"'))).toBeNull();
    expect(readRecordChatMessage(message + '\nextra')).toBeNull();
    expect(readSelectedContactContext({ id: 'contact\nother', name: 'Alex' })).toBeNull();
    expect(readSelectedContactContext({ id: 'contact', name: 'Alex', email: 'mention-only-a@_recued.invalid' })).toBeNull();
  });

  it('preserves a context-only draft and copies it without sharing mutable recovery state', () => {
    const draft = { text: '', protected: false, modelSourceId: null, contactContext: selectedContactContext(contact)! };
    const copy = copyComposerRecoveryDraft(draft);
    expect(hasComposerRecoveryDraft(copy)).toBe(true);
    expect(hasProtectedChatRecoveryDraft({ text: '', protected: false, modelSourceId: null, parkedDrafts: [{ sessionId: null, draft: copy }] })).toBe(true);
    expect(recordContextRecovery(recordContextFromRecovery(copy))).toEqual({ contactContext: draft.contactContext });
    (copy.contactContext as { name: string }).name = 'Changed label';
    expect(draft.contactContext.name).toBe('Alex Rivera');
  });

  it('retains the existing asset envelope and recovery contract', () => {
    const asset = { id: 'asset/one', name: 'Boiler', fileIds: ['file:' + '1'.repeat(32)], omittedFiles: 0 };
    expect(recordChatMessage('Read the linked evidence.', asset)).toBe(assetChatMessage('Read the linked evidence.', asset));
    const message = recordChatMessage('Read the linked evidence.', asset);
    expect(readRecordChatMessage(message)).toEqual(readAssetChatMessage(message));
    expect(recordContextRecovery(recordContextFromRecovery({ assetContext: asset }))).toEqual({ assetContext: asset });
  });
});

describe('Selected calendar event context', () => {
  const selected = { slug: 'work/one', sourceId: 'event:shared/id', recordId: 'cal:work:event/one',
    name: 'Launch planning', calendarName: 'Work calendar', incarnation: 'calendar-1' };

  it('carries the exact calendar, source, record and incarnation with no copied event facts', () => {
    const context = recordContextFromRecovery({ calendarContext: selected })!;
    const message = recordChatMessage('Help me prepare.', context);
    expect(JSON.parse(message.slice(message.lastIndexOf('\n') + 1))).toEqual({ kind: 'recued.calendar_question', version: 1,
      event: { calendar: selected.slug, source_id: selected.sourceId, record_id: selected.recordId, incarnation: 'calendar-1' } });
    expect(message).not.toContain(selected.name);
    expect(message).not.toContain(selected.calendarName);
    expect(readRecordChatMessage(message)).toMatchObject({ question: 'Help me prepare.', context: { kind: 'calendar_event',
      slug: selected.slug, sourceId: selected.sourceId, recordId: selected.recordId, incarnation: selected.incarnation },
      href: '#data/calendar/record/work%2Fone/cal%3Awork%3Aevent%2Fone' });
    expect(calendarEventContextHref({ ...selected, slug: 'personal' })).not.toBe(calendarEventContextHref(selected));
    const draft = { text: '', protected: false, modelSourceId: null, calendarContext: selected };
    const copy = copyComposerRecoveryDraft(draft);
    expect(recordContextRecovery(recordContextFromRecovery(copy))).toEqual({ calendarContext: selected });
    expect(hasComposerRecoveryDraft(copy)).toBe(true);
    expect(hasProtectedChatRecoveryDraft({ ...draft, calendarContext: undefined, parkedDrafts: [{ sessionId: null, draft: copy }] })).toBe(true);
    (copy.calendarContext as { name: string }).name = 'Changed label';
    expect(draft.calendarContext.name).toBe('Launch planning');
  });

  it('keeps malformed or extended references as ordinary text and rejects mismatched saved identities', () => {
    const context = recordContextFromRecovery({ calendarContext: selected })!;
    const message = recordChatMessage('Check the saved event.', context);
    for (const invalid of [message.replace('"version":1', '"version":2'),
      message.replace('"calendar":"work/one"', '"calendar":""'),
      message.replace('"incarnation":"calendar-1"', '"incarnation":"calendar-1","description":"untrusted"'),
      message + '\nextra']) expect(readRecordChatMessage(invalid)).toBeNull();
    expect(readSelectedCalendarEventContext({ ...selected, sourceId: 'event\nother' })).toBeNull();
    expect(readSelectedCalendarEventContext({ ...selected, permission: 'edit' })).toBeNull();
    const snapshot = { event: { record_id: selected.recordId, source_id: selected.sourceId,
      summary: selected.name, calendar_name: selected.calendarName },
      record: { record_id: selected.recordId, source_id: selected.sourceId }, incarnation: selected.incarnation } as CalendarEventSnapshot;
    expect(selectedCalendarEventContext({ slug: selected.slug, source_id: selected.sourceId }, snapshot)).toEqual(selected);
    expect(selectedCalendarEventContext({ slug: selected.slug, source_id: 'another-event' }, snapshot)).toBeNull();
    expect(selectedCalendarEventContext({ slug: selected.slug, source_id: selected.sourceId },
      { ...snapshot, record: { ...snapshot.record, record_id: 'another-record' } })).toBeNull();
  });
});

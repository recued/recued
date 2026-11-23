/** D-348 slice 6b — Recued's own deletes a request's rule may let through, by the record each
 *  deletes, and the reads that find such records: two closed lists. Off them, a delete names no
 *  record and a read finds none, so the delete asks. */

import { describe, expect, it } from 'vitest';

import { ownDeleteRecord, ownReadRecords } from '../chain-own-records.js';

describe('D-348 slice 6b — the record each of Recued\'s own deletes deletes', () => {
  it('a task, a note and a booking by id; a message by mailbox and id; an event by calendar and id; a file by folder and path', () => {
    expect(ownDeleteRecord('task-delete', { id: 't_1', tombstone: true })).toBe(JSON.stringify(['work', 'task', 't_1']));
    expect(ownDeleteRecord('note-delete', { id: 'n_1' })).toBe(JSON.stringify(['work', 'note', 'n_1']));
    expect(ownDeleteRecord('booking-delete', { id: 'b_1' })).toBe(JSON.stringify(['work', 'booking', 'b_1']));
    expect(ownDeleteRecord('mail-delete', { slug: 'inbox', record_id: 'm_1' })).toBe(JSON.stringify(['mail', 'inbox', 'm_1']));
    expect(ownDeleteRecord('calendar-delete', { slug: 'home', source_id: 'e_1' })).toBe(JSON.stringify(['calendar', 'home', 'e_1']));
    expect(ownDeleteRecord('file-delete', { slug: 'docs', path: 'old/a.txt' })).toBe(JSON.stringify(['file', 'docs', 'old/a.txt']));
    // The kernel's own prefix names the same delete.
    expect(ownDeleteRecord('core-task-delete', { id: 't_1' })).toBe(ownDeleteRecord('task-delete', { id: 't_1' }));
  });

  it('⛔ a calendar delete only of the one occurrence it names', () => {
    expect(ownDeleteRecord('calendar-delete', { slug: 'home', source_id: 'e_1', scope: 'this_instance' })).toBeDefined();
    expect(ownDeleteRecord('calendar-delete', { slug: 'home', source_id: 'e_1', scope: null })).toBeDefined();
    expect(ownDeleteRecord('calendar-delete', { slug: 'home', source_id: 'e_1', scope: 'this_and_future' })).toBeUndefined();
    expect(ownDeleteRecord('calendar-delete', { slug: 'home', source_id: 'e_1', scope: 'series' })).toBeUndefined();
  });

  it('⛔ none for a delete off the list, or one whose arguments do not name its record', () => {
    expect(ownDeleteRecord('shared-delete-prefix', { prefix: 'seen.' })).toBeUndefined();
    expect(ownDeleteRecord('file-move', { from_slug: 'a', from_path: 'x', to_slug: 'b', to_path: 'y' })).toBeUndefined();
    expect(ownDeleteRecord('hubspot-catalog', { deal_id: '9001' })).toBeUndefined();
    expect(ownDeleteRecord('task-delete', {})).toBeUndefined();
    expect(ownDeleteRecord('mail-delete', { record_id: 'm_1' })).toBeUndefined();
    expect(ownDeleteRecord('file-delete', { slug: 'docs' })).toBeUndefined();
  });
});

describe('D-348 slice 6b — the records each of Recued\'s own reads found', () => {
  it('a store\'s own listing of its records, keyed as its delete names them', () => {
    expect(ownReadRecords('work-entity-list', { kind: 'task' }, { entities: [{ id: 't_1', title: 'A' }, { id: 't_2' }], total: 2 }))
      .toEqual([ownDeleteRecord('task-delete', { id: 't_1' }), ownDeleteRecord('task-delete', { id: 't_2' })]);
    expect(ownReadRecords('email-list', { slug: 'inbox' }, { records: [{ record_id: 'm_1', _id: 'm_1' }] }))
      .toEqual([ownDeleteRecord('mail-delete', { slug: 'inbox', record_id: 'm_1' })]);
    expect(ownReadRecords('email-search', { slug: 'inbox', query: 'newsletter' }, { matches: [{ record_id: 'm_2' }] }))
      .toEqual([ownDeleteRecord('mail-delete', { slug: 'inbox', record_id: 'm_2' })]);
    // A list of every calendar names each row's own; a list of one, its own.
    expect(ownReadRecords('calendar-list', {}, { records: [{ source_id: 'e_1', collection_slug: 'home' }] }))
      .toEqual([ownDeleteRecord('calendar-delete', { slug: 'home', source_id: 'e_1' })]);
    expect(ownReadRecords('calendar-list', { slug: 'work' }, { records: [{ source_id: 'e_2' }] }))
      .toEqual([ownDeleteRecord('calendar-delete', { slug: 'work', source_id: 'e_2' })]);
    expect(ownReadRecords('file-list', { slug: 'docs' }, { records: [{ record_id: 'r', hot_fields: { path: 'old/a.txt' } }] }))
      .toEqual([ownDeleteRecord('file-delete', { slug: 'docs', path: 'old/a.txt' })]);
  });

  it('⛔ a record found in one place lets no delete through in another: mailbox, calendar, folder, kind', () => {
    const notIn = (found: string[], record: string | undefined) => expect(found).not.toContain(record);
    notIn(ownReadRecords('email-list', { slug: 'archive' }, { records: [{ record_id: 'm_1' }] }),
      ownDeleteRecord('mail-delete', { slug: 'inbox', record_id: 'm_1' }));
    notIn(ownReadRecords('calendar-list', { slug: 'work' }, { records: [{ source_id: 'e_1' }] }),
      ownDeleteRecord('calendar-delete', { slug: 'home', source_id: 'e_1' }));
    notIn(ownReadRecords('file-list', { slug: 'scans' }, { records: [{ hot_fields: { path: 'a.txt' } }] }),
      ownDeleteRecord('file-delete', { slug: 'docs', path: 'a.txt' }));
    notIn(ownReadRecords('work-entity-list', { kind: 'booking' }, { entities: [{ id: 'x_1' }] }),
      ownDeleteRecord('task-delete', { id: 'x_1' }));
  });

  it('a record the read\'s own arguments named, it did not find', () => {
    expect(ownReadRecords('email-search', { slug: 'inbox', query: 'm_1' }, { matches: [{ record_id: 'm_1' }, { record_id: 'm_2' }] }))
      .toEqual([ownDeleteRecord('mail-delete', { slug: 'inbox', record_id: 'm_2' })]);
  });

  it('⛔ nothing from a read off the list, however its result is shaped: a content read, a get by id', () => {
    // Shaped like every listing on the list, with every argument they read: still nothing.
    const listed = {
      records: [{ record_id: 'm_1', source_id: 'e_1', collection_slug: 'home', hot_fields: { path: 'a.txt' } }],
      matches: [{ record_id: 'm_1' }],
      entities: [{ id: 't_1' }],
    };
    for (const slug of ['http-get', 'http-read', 'dom-read', 'dom-table', 'csv-rows', 'data-file-read', 'ics-read',
      'mail-body-read', 'mail-thread-reader', 'email-get', 'file-get', 'calendar-get', 'work-entity-get', 'shared-list']) {
      expect(ownReadRecords(slug, { slug: 'inbox', kind: 'task' }, listed), slug).toEqual([]);
    }
  });

  it('⛔ nothing from a row with no id, or a list of another kind', () => {
    expect(ownReadRecords('work-entity-list', { kind: 'task' }, { entities: [{ title: 'no id' }] })).toEqual([]);
    // A note listed is not a task to delete.
    const note = ownReadRecords('work-entity-list', { kind: 'note' }, { entities: [{ id: 'x_1' }] });
    expect(note).not.toContain(ownDeleteRecord('task-delete', { id: 'x_1' }));
  });
});

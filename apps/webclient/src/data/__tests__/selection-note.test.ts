import { expect, test } from 'vitest';
import { NOTE_TITLE_MAX, type Note } from '@recued/contracts';
import { noteDraftOrigin } from '../draft-origin.js';
import { noteDraftOriginal, parseNoteRecovery } from '../note-draft-recovery.js';
import { selectionNoteValues } from '../selection-note.js';

const note: Note & { _kind: 'note' } = { _kind: 'note', id: 'source/二?', source_id: 'recued.note', title: 'Reference', body: 'Existing text  \n',
  created_at: 1, updated_at: 2, last_user_action_at: 1, last_seen_at: 1, sync_state: 'live', conflict_policy: 'recued_wins',
  related_contact_ids: [], related_calendar_event_ids: [], related_mail_thread_ids: [], related_project_ids: ['project'] };

test('quotes every selected line and creates an editable title and credential-free exact source URL', () => {
  const values = selectionNoteValues('First line 二🧾\n\n<script>quoted data</script>', noteDraftOrigin(note)!, 'https://user:secret@app.test/subpath/index.html?token=private#views/old');
  expect(values.title).toBe('First line 二🧾');
  expect(values.body).toBe('Selected passage from note: <https://app.test/subpath/index.html#data/note/source%2F%E4%BA%8C%3F>\n\n> First line 二🧾\n> \n> <script>quoted data</script>');
});

test('appending preserves the existing body byte for byte and leaves other fields untouched', () => {
  const before = structuredClone(note), values = selectionNoteValues('Captured passage', noteDraftOrigin(note)!, 'https://app.test/', note);
  expect(values.body.startsWith(note.body)).toBe(true); expect(values.body).toContain('\n\nSelected passage'); expect(values).not.toHaveProperty('title'); expect(note).toEqual(before);
});

test('bounds Unicode titles and refuses an oversized quotation or combined note before editing', () => {
  const values = selectionNoteValues('🧾'.repeat(NOTE_TITLE_MAX), noteDraftOrigin(note)!, 'https://app.test/');
  expect(values.title!.length).toBeLessThanOrEqual(NOTE_TITLE_MAX); expect(values.title).not.toMatch(/[\ud800-\udbff]$/u);
  expect(() => selectionNoteValues('x'.repeat(4001), noteDraftOrigin(note)!, 'https://app.test/')).toThrow('shorter passage');
  expect(() => selectionNoteValues('New words', noteDraftOrigin(note)!, 'https://app.test/', { ...note, body: 'x'.repeat(100_000) })).toThrow('too long');
});

test('recovery retains a conditional edit revision and rejects malformed stored guards', () => {
  const entry = { id: 'ndr_00000000-0000-4000-8000-000000000001', revision: 1, updatedAt: 1000, sourceId: note.source_id,
    values: noteDraftOriginal(note).values, status: 'editing', original: { ...noteDraftOriginal(note), editRevision: 'a'.repeat(64) } };
  expect(parseNoteRecovery(entry, 1000)?.original?.editRevision).toBe('a'.repeat(64));
  expect(parseNoteRecovery({ ...entry, original: { ...entry.original, editRevision: 'untrusted' } }, 1000)).toBeNull();
});

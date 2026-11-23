/** How a reviewed change reads to the owner: only what it changes, field by field, in the words
 *  the app's own forms use. It used to print both versions as JSON and the version it was checked
 *  against (owner, 2026-11-13: make it read in my words). */

import { describe, expect, it } from 'vitest';
import { OWN_CALENDAR_SLUG, renderResourceReview, type ResourceReview, type ReviewedResource } from '../resource-review.js';
import { RESERVED_LOCAL_CALENDAR_SLUG } from '../kernel-write-locality.js';

const LONDON = { timeZone: 'Europe/London', locale: 'en-GB' };
const review = (...resources: ReviewedResource[]): ResourceReview =>
  ({ schema_version: 1, operation: 'fixture', input_hash: 'a'.repeat(64), captured_at: 1, resources });
const event = (before: Record<string, unknown>, after: Record<string, unknown> | null): ReviewedResource => ({
  kind: 'calendar', key: '["local","primary","meeting"]', label: 'Team sync, on your Recued calendar', binding: 'b', version: 'v-17',
  precondition: { kind: 'local_version', value: 'v-17' }, before, after,
});
const record = (over: Partial<ReviewedResource>): ReviewedResource => ({
  kind: 'records', key: 'note-1', label: 'note note-1', binding: 'b', version: 'rev-3',
  precondition: { kind: 'records_revision', value: 3, incarnation: 'i' }, before: {}, after: {}, ...over,
});
const fields = { timezone: 'UTC', is_all_day: false, status: 'confirmed' };

describe('a calendar event\'s change', () => {
  it('names only what changes, as the event form does, a moment in the viewer\'s zone', () => {
    const text = renderResourceReview(review(event(
      { ...fields, summary: 'Team sync', start_at: Date.UTC(2027, 0, 15, 8), end_at: Date.UTC(2027, 0, 15, 8, 30), location: null },
      { ...fields, summary: 'Team meeting', start_at: Date.UTC(2027, 0, 15, 9), end_at: Date.UTC(2027, 0, 15, 9, 30), location: 'Room 4' },
    )), LONDON);
    expect(text).toBe([
      'Team sync, on your Recued calendar',
      '  Title: Team sync → Team meeting',
      '  Starts: 15 Jan 2027, 08:00 → 15 Jan 2027, 09:00',
      '  Ends: 15 Jan 2027, 08:30 → 15 Jan 2027, 09:30',
      '  Location: (none) → Room 4',
    ].join('\n'));
    // Never the snapshot as JSON, the version it was checked against, or the old header.
    expect(text).not.toMatch(/[{}"]|v-17|Reviewed data|Version:/);
  });

  it('an all-day event\'s are its days, whatever the viewer\'s zone', () => {
    const text = renderResourceReview(review(event(
      { ...fields, summary: 'Holiday', is_all_day: true, start_at: Date.UTC(2026, 11, 24), end_at: Date.UTC(2026, 11, 25) },
      { ...fields, summary: 'Holiday', is_all_day: true, start_at: Date.UTC(2026, 11, 24), end_at: Date.UTC(2026, 11, 27) },
    )), { timeZone: 'America/Los_Angeles', locale: 'en-GB' });
    // The end is exclusive: the 27th's midnight ends the 26th. Read as a moment in Los Angeles, it
    // was the 26th's afternoon.
    expect(text).toBe('Team sync, on your Recued calendar\n  Last day: Thu, 24 Dec 2026 → Sat, 26 Dec 2026');
  });

  it('a delete says so; a change that changes nothing says that', () => {
    expect(renderResourceReview(review(event({ ...fields, summary: 'Team sync' }, null)), LONDON))
      .toBe('Team sync, on your Recued calendar\n  Deleted');
    expect(renderResourceReview(review(event({ ...fields, summary: 'Team sync' }, { ...fields, summary: 'Team sync' })), LONDON))
      .toBe('Team sync, on your Recued calendar\n  Nothing changes');
  });
});

describe('a record\'s change', () => {
  it('a new record lists what it is given: never its id, never an empty field; a nested one as words', () => {
    const text = renderResourceReview(review(record({
      label: 'note new', precondition: { kind: 'records_absent' }, before: {},
      after: { id: 'new', title: 'New', amount: '12.5000', done: false, tags: ['a', 'b'], details: { note: null, owner_id: 'u-1' } },
    })), LONDON);
    expect(text).toBe([
      'note new (new)', '  Title: New', '  Amount: 12.5000', '  Done: No', '  Tags: a, b', '  Details owner ID: u-1',
    ].join('\n'));
  });

  it('a batch reads step by step, numbered as its operations are', () => {
    const text = renderResourceReview(review(record({
      before: { id: 'note-1', title: 'Original' }, after: { id: 'note-1', title: 'Recreated' },
      changes: [
        { operation_index: 0, action: 'update', before: { title: 'Original' }, after: { title: 'Edited' } },
        { operation_index: 1, action: 'upsert', before: { title: 'Edited' }, after: { title: 'Edited again' } },
        { operation_index: 2, action: 'delete', before: { title: 'Edited again' }, after: null },
        { operation_index: 3, action: 'create', before: null, after: { title: 'Recreated' } },
      ],
    })), LONDON);
    expect(text).toBe([
      'note note-1', '  Title: Original → Recreated', '  Step by step:',
      '  1. Change: Title: Original → Edited', '  2. Add or change: Title: Edited → Edited again',
      '  3. Delete', '  4. Add: Title: Recreated',
    ].join('\n'));
  });

  it('one added and deleted in the same batch says so, and its steps show what it held', () => {
    const text = renderResourceReview(review(record({
      label: 'note transient', precondition: { kind: 'records_absent' }, before: {}, after: null,
      changes: [{ operation_index: 0, action: 'create', before: null, after: { title: 'Intermediate' } },
        { operation_index: 1, action: 'delete', before: { title: 'Intermediate' }, after: null }],
    })), LONDON);
    expect(text).toBe(['note transient', '  Added, then deleted, in this same change', '  Step by step:',
      '  1. Add: Title: Intermediate', '  2. Delete'].join('\n'));
  });

  it('a value reads as written, on its own line: markup stays text, line breaks read as spaces', () => {
    const text = renderResourceReview(review(record({
      before: { title: '<script>no()</script>' }, after: { title: 'First line\nsecond   line' },
    })), LONDON);
    expect(text).toBe('note note-1\n  Title: <script>no()</script> → First line second line');
  });

  it('several changes read one after another, a blank line between them', () => {
    const text = renderResourceReview(review(
      record({ label: 'note a', before: { title: 'A' }, after: { title: 'A2' } }),
      record({ label: 'note b', before: { title: 'B' }, after: null }),
    ), LONDON);
    expect(text).toBe('note a\n  Title: A → A2\n\nnote b\n  Deleted');
  });
});

describe('what a change is headed by', () => {
  const stored = (over: Partial<ReviewedResource>): ReviewedResource =>
    record({ key: JSON.stringify(['recued-core', 'notes', 'note', 'n-1']), label: 'note n-1', ...over });

  it('a record by its kind and its title, its ID only when it has none', () => {
    expect(renderResourceReview(review(stored({ before: { title: 'Pay rent' }, after: { title: 'Pay the rent' } })), LONDON))
      .toBe('Note “Pay the rent”\n  Title: Pay rent → Pay the rent');
    expect(renderResourceReview(review(stored({ before: { name: 'Acme' }, after: null })), LONDON))
      .toBe('Note “Acme”\n  Deleted');
    expect(renderResourceReview(review(stored({ before: { amount: '1' }, after: { amount: '2' } })), LONDON))
      .toBe('Note n-1\n  Amount: 1 → 2');
  });

  it('an event by where it is: Recued\'s own calendar in words, another by its name', () => {
    expect(OWN_CALENDAR_SLUG).toBe(RESERVED_LOCAL_CALENDAR_SLUG);
    const other = { ...event({ summary: 'A' }, null), key: '["work","primary","m"]', label: 'Standup (work)' };
    expect(renderResourceReview(review(other), LONDON)).toBe('Standup, on the calendar work\n  Deleted');
    const untitled = { ...event({ summary: '' }, null), label: ' (local)' };
    expect(renderResourceReview(review(untitled), LONDON)).toBe('An event, on your Recued calendar\n  Deleted');
  });

  it('a label it does not know the shape of reads as written', () => {
    expect(renderResourceReview(review(stored({ label: 'Imported note 3', before: { title: 'A' }, after: { title: 'B' } })), LONDON))
      .toBe('Imported note 3\n  Title: A → B');
    expect(renderResourceReview(review({ ...event({ summary: 'A' }, null), key: 'meeting', label: 'Meeting' }), LONDON))
      .toBe('Meeting\n  Deleted');
  });
});

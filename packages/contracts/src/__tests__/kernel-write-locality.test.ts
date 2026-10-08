/** `kernelWriteStaysInRecued` — the proof behind the approval ask's "in Recued"
 *  sentence. A `true` here tells the owner their yes changes nothing outside
 *  Recued, so every arm is pinned from BOTH sides: what it proves, and the
 *  near-miss it must not. */

import { describe, expect, it } from 'vitest';

import {
  kernelWriteStaysInRecued,
  qualifyWorkEntityId,
  RECUED_BUILTIN_SOURCE_ID,
  RESERVED_LOCAL_CALENDAR_SLUG,
} from '../index.js';

describe('kernelWriteStaysInRecued', () => {
  it('a booking or a commitment is local whatever its args — no pack may back one outside', () => {
    for (const id of [
      'booking-create', 'core.work-entity.booking.update', 'commitment-create',
      'core.work-entity.commitment.fulfill', 'commitment-cancel', 'commitment-propose',
    ]) {
      expect(kernelWriteStaysInRecued(id, []), id).toBe(true);
      expect(kernelWriteStaysInRecued(id, [{ id: 'row-1' }]), id).toBe(true);
    }
  });

  it('a task is local only when the call pins it to the built-in Source', () => {
    const builtin = RECUED_BUILTIN_SOURCE_ID('task');
    expect(kernelWriteStaysInRecued('task-create', [{ title: 'x' }])).toBe(true);
    expect(kernelWriteStaysInRecued('task-create', [{ title: 'x', source_id: builtin }])).toBe(true);
    expect(kernelWriteStaysInRecued('task-create', [{ title: 'x', source_id: null }])).toBe(true);
    // A vendor Source is outside.
    expect(kernelWriteStaysInRecued('task-create', [{ title: 'x', source_id: 'todoist.c1.task' }]))
      .toBe(false);
    // Unknown args prove nothing for a kind a pack CAN back outside.
    expect(kernelWriteStaysInRecued('task-create', [])).toBe(false);
    // Every call must be pinned: one vendor task spoils the set.
    expect(kernelWriteStaysInRecued('task-create', [
      { title: 'x' }, { title: 'y', source_id: 'todoist.c1.task' },
    ])).toBe(false);
  });

  it('an id-based task write needs a qualified id naming the built-in Source', () => {
    const local = qualifyWorkEntityId({
      kind: 'task', source_id: RECUED_BUILTIN_SOURCE_ID('task'), local_id: 'abc',
    });
    const vendor = qualifyWorkEntityId({
      kind: 'task', source_id: 'todoist.c1.task', source_record_id: '99', local_id: 'abc',
    });
    expect(kernelWriteStaysInRecued('task-update', [{ id: local }])).toBe(true);
    expect(kernelWriteStaysInRecued('core.work-entity.task.mark-done', [{ id: local }])).toBe(true);
    expect(kernelWriteStaysInRecued('task-update', [{ id: vendor }])).toBe(false);
    // A bare row id does not say which Source the row is on.
    expect(kernelWriteStaysInRecued('task-update', [{ id: 'abc' }])).toBe(false);
    // A malformed qualified id is not proof (and does not throw).
    expect(kernelWriteStaysInRecued('task-update', [{ id: 'we1:task:broken' }])).toBe(false);
    // A qualified id of ANOTHER kind is not proof for this one.
    const note = qualifyWorkEntityId({
      kind: 'note', source_id: RECUED_BUILTIN_SOURCE_ID('note'), local_id: 'abc',
    });
    expect(kernelWriteStaysInRecued('task-update', [{ id: note }])).toBe(false);
    // Even one that names the task Source: the id's own kind must match.
    const crossed = qualifyWorkEntityId({
      kind: 'note', source_id: RECUED_BUILTIN_SOURCE_ID('task'), local_id: 'abc',
    });
    expect(kernelWriteStaysInRecued('task-update', [{ id: crossed }])).toBe(false);
  });

  it('a calendar write is local only on the reserved local calendar', () => {
    const local = { slug: RESERVED_LOCAL_CALENDAR_SLUG };
    expect(kernelWriteStaysInRecued('calendar-create', [local])).toBe(true);
    expect(kernelWriteStaysInRecued('core.data.calendar.update', [local])).toBe(true);
    expect(kernelWriteStaysInRecued('calendar-create', [{ slug: 'work-google' }])).toBe(false);
    expect(kernelWriteStaysInRecued('calendar-create', [])).toBe(false);
    // An RSVP is addressed to the organizer, even from the local calendar.
    expect(kernelWriteStaysInRecued('calendar-rsvp', [local])).toBe(false);
  });

  it('every covered call must be local — one Google event spoils a batch', () => {
    expect(kernelWriteStaysInRecued('calendar-create', [
      { slug: RESERVED_LOCAL_CALENDAR_SLUG }, { slug: RESERVED_LOCAL_CALENDAR_SLUG },
    ])).toBe(true);
    expect(kernelWriteStaysInRecued('calendar-create', [
      { slug: RESERVED_LOCAL_CALENDAR_SLUG }, { slug: 'work-google' },
    ])).toBe(false);
  });

  it('stores with no outside half, and saved drafts, are local', () => {
    for (const id of ['shared-write', 'shared-patch', 'annotation-create', 'link-delete',
      'enrichment-upsert', 'mail-draft-create', 'core.mail.draft.update']) {
      expect(kernelWriteStaysInRecued(id, []), id).toBe(true);
    }
  });

  it('anything that reaches outside, or that it cannot classify, is not', () => {
    for (const id of ['mail-send', 'mail-draft-save-to-mailbox', 'mail-move', 'peer-ask',
      'dom-write', 'contact-upsert', 'file-write', 'notify-booking-visitor',
      'acme/hubspot.deals.update', 'not-a-thing']) {
      expect(kernelWriteStaysInRecued(id, [{ slug: RESERVED_LOCAL_CALENDAR_SLUG }]), id).toBe(false);
    }
  });
});

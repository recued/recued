/** D-172 P2 — attach / detach transitions on the compose dialog.
 *
 *  These exist because `setComposeValuesTransition({attachments})` puts dedup
 *  and the cap on every caller, and each host would get them subtly wrong.
 *  The cases below are the ones a generic patch cannot express: a duplicate
 *  pick that must be a no-op, a cap that must refuse rather than truncate
 *  silently, and a remove that must not disturb its neighbours.
 */

import { describe, it, expect } from 'vitest';
import {
  MAIL_COMPOSE_MAX_ATTACHMENTS,
  addComposeAttachmentsTransition,
  removeComposeAttachmentTransition,
  initialMailComposeState,
  openCreateComposeTransition,
  setComposeSubmitErrorTransition,
  type MailComposeState,
} from '../mail-compose/index.js';

const opened = (): MailComposeState =>
  openCreateComposeTransition(initialMailComposeState(), {
    default_sender_source_id: 'src-1',
  });

const attachments = (s: MailComposeState): readonly string[] =>
  s.dialog?.values.attachments ?? [];

describe('D-172 P2 — addComposeAttachmentsTransition', () => {
  it('appends in argument order', () => {
    const s = addComposeAttachmentsTransition(opened(), ['file:a', 'file:b']);
    expect(attachments(s)).toEqual(['file:a', 'file:b']);
  });

  it('appends after what is already attached', () => {
    const s = addComposeAttachmentsTransition(
      addComposeAttachmentsTransition(opened(), ['file:a']),
      ['file:b'],
    );
    expect(attachments(s)).toEqual(['file:a', 'file:b']);
  });

  it('re-picking the same file is a no-op, and returns the SAME reference', () => {
    const first = addComposeAttachmentsTransition(opened(), ['file:a']);
    const again = addComposeAttachmentsTransition(first, ['file:a']);
    expect(attachments(again)).toEqual(['file:a']);
    // Identity, not just equality — a host diffing on reference must not
    // re-render (and must not lose focus) because of a duplicate pick.
    expect(again).toBe(first);
  });

  it('dedups WITHIN one call as well as against existing', () => {
    const s = addComposeAttachmentsTransition(opened(), ['file:a', 'file:a', 'file:b']);
    expect(attachments(s)).toEqual(['file:a', 'file:b']);
  });

  it('trims ids and ignores blank ones', () => {
    const s = addComposeAttachmentsTransition(opened(), ['  file:a  ', '', '   ']);
    expect(attachments(s)).toEqual(['file:a']);
  });

  it('refuses past the cap instead of truncating silently', () => {
    const ids = Array.from({ length: MAIL_COMPOSE_MAX_ATTACHMENTS + 5 }, (_, i) => `file:${i}`);
    const s = addComposeAttachmentsTransition(opened(), ids);
    expect(attachments(s)).toHaveLength(MAIL_COMPOSE_MAX_ATTACHMENTS);
    // The ones that fit are the FIRST ones — a user watching the list sees
    // exactly which picks landed.
    expect(attachments(s)[0]).toBe('file:0');
    expect(attachments(s)[MAIL_COMPOSE_MAX_ATTACHMENTS - 1]).toBe(
      `file:${MAIL_COMPOSE_MAX_ATTACHMENTS - 1}`,
    );
  });

  it('adding to a full list changes nothing', () => {
    const ids = Array.from({ length: MAIL_COMPOSE_MAX_ATTACHMENTS }, (_, i) => `file:${i}`);
    const full = addComposeAttachmentsTransition(opened(), ids);
    expect(addComposeAttachmentsTransition(full, ['file:extra'])).toBe(full);
  });

  it('is a no-op on a closed dialog', () => {
    const closed = initialMailComposeState();
    expect(addComposeAttachmentsTransition(closed, ['file:a'])).toBe(closed);
  });

  it('clears a stale submit_error, matching every other value edit', () => {
    const errored = setComposeSubmitErrorTransition(opened(), 'SMTP said no');
    const s = addComposeAttachmentsTransition(errored, ['file:a']);
    expect(s.dialog?.submit_error).toBeNull();
  });
});

describe('D-172 P2 — removeComposeAttachmentTransition', () => {
  const three = (): MailComposeState =>
    addComposeAttachmentsTransition(opened(), ['file:a', 'file:b', 'file:c']);

  it('removes only the named id and preserves order', () => {
    const s = removeComposeAttachmentTransition(three(), 'file:b');
    expect(attachments(s)).toEqual(['file:a', 'file:c']);
  });

  it('removing an id that is not attached is a no-op, SAME reference', () => {
    const s = three();
    // A double-click on Remove fires twice; the second must not drop a
    // neighbour just because the list shifted under it.
    expect(removeComposeAttachmentTransition(s, 'file:zzz')).toBe(s);
  });

  it('a double remove of the same id leaves the others intact', () => {
    const once = removeComposeAttachmentTransition(three(), 'file:b');
    const twice = removeComposeAttachmentTransition(once, 'file:b');
    expect(attachments(twice)).toEqual(['file:a', 'file:c']);
    expect(twice).toBe(once);
  });

  it('is a no-op on a closed dialog', () => {
    const closed = initialMailComposeState();
    expect(removeComposeAttachmentTransition(closed, 'file:a')).toBe(closed);
  });

  it('leaves the rest of the dialog state untouched', () => {
    const before = three();
    const after = removeComposeAttachmentTransition(before, 'file:a');
    expect(after.dialog?.mode).toBe(before.dialog?.mode);
    expect(after.dialog?.values.sender_source).toBe(before.dialog?.values.sender_source);
    expect(after.dialog?.submitting).toBe(before.dialog?.submitting);
  });
});

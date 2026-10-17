/** D-172 P2 — chat composer attachments.
 *
 *  Driven through the real controller with a fake upload engine, because the
 *  interesting behaviour is all in the bookkeeping between "file selected" and
 *  "id rides on chat.send": what counts as attached, what Send waits on, and
 *  whether a listener still names its own row after a removal.
 */

import { describe, expect, it, vi } from 'vitest';
import { createComposerAttachments, mediaClassForBrowserFile } from '../chat/composer-attachments.js';

// The controller reaches @recued/ui-shared for the engine; rather than mock the
// module graph, drive it through the seam it already exposes by faking the two
// factories on the imported namespace.
const withFakeEngine = async () => {
  const uiShared = await import('@recued/ui-shared');
  const engines: Array<{
    started: { name: string } | null;
    listener: ((p: Record<string, unknown>) => void) | null;
    destroyed: boolean;
  }> = [];
  const createSpy = vi
    .spyOn(uiShared.Upload, 'createUploadEngine')
    .mockImplementation(() => {
      const rec = { started: null as { name: string } | null, listener: null as never, destroyed: false };
      engines.push(rec as never);
      return {
        start: (f: { name: string }) => { (rec as { started: unknown }).started = f; },
        cancel: () => {},
        on: (_e: string, l: (p: Record<string, unknown>) => void) => {
          (rec as { listener: unknown }).listener = l;
          return () => {};
        },
        destroy: () => { rec.destroyed = true; },
      } as never;
    });
  const transportSpy = vi
    .spyOn(uiShared.Upload, 'createWsUploadTransport')
    .mockImplementation(() => ({}) as never);
  return { engines, restore: () => { createSpy.mockRestore(); transportSpy.mockRestore(); } };
};

const file = (name: string, type = 'application/pdf'): File =>
  ({ name, type, size: 10 }) as unknown as File;

describe('D-172 P2 — media class hint', () => {
  it('maps the three browser cases and defaults the unknown one', () => {
    expect(mediaClassForBrowserFile('audio/ogg')).toBe('voice');
    expect(mediaClassForBrowserFile('image/png')).toBe('image');
    expect(mediaClassForBrowserFile('application/pdf')).toBe('document');
    // A browser that reports no type must not be guessed at.
    expect(mediaClassForBrowserFile('')).toBe('other');
  });
});

describe('D-172 P2 — composer attachments', () => {
  it('rescues unfinished duplicate filenames and completed references without restarting uploads', async () => {
    const { engines, restore } = await withFakeEngine();
    try {
      const original = createComposerAttachments({ callers: {} as never, connect: {} as never, onChange: vi.fn() });
      original.activateDraft('first');
      original.attach(file('Same.pdf')); original.attach(file('Same.pdf')); original.attach(file('Done.png', 'image/png'));
      engines[1].listener?.({ sent: 2, total: 10, error: 'Connection lost' });
      engines[2].listener?.({ sent: 10, total: 10, recordId: 'file:done' });
      const interrupted = original.recoveryUploads(); const completed = original.payload();
      expect(interrupted).toHaveLength(2);
      expect(interrupted[0]!.id).not.toBe(interrupted[1]!.id);
      expect(original.recoveryUploads()).toEqual(interrupted);
      original.destroy();
      expect(engines.every(engine => engine.destroyed)).toBe(true);
      engines[0].listener?.({ sent: 10, total: 10, recordId: 'file:too-late' });
      expect(original.payload('first')).toEqual([]);
      const onChange = vi.fn(); const recovered = createComposerAttachments({ onChange });
      recovered.restore(completed, 'first'); recovered.restoreInterrupted(interrupted, 'first');
      recovered.restoreInterrupted(interrupted, 'first');
      expect(onChange).not.toHaveBeenCalled(); expect(engines).toHaveLength(3);
      recovered.activateDraft('first');
      expect(recovered.rows().map(row => row.phase)).toEqual(['attached', 'needs-file', 'needs-file']);
      expect(recovered.payload()).toEqual(completed); expect(recovered.hasUnfinished()).toBe(true);
      expect(recovered.hasInFlight()).toBe(false); expect(recovered.recoveryUploads()).toEqual(interrupted);
      const again = createComposerAttachments({ onChange: vi.fn() });
      again.restoreInterrupted(recovered.recoveryUploads());
      expect(again.recoveryUploads()).toEqual(interrupted);
      recovered.clear(); expect(recovered.hasUnfinished()).toBe(false);
      expect(again.recoveryUploads()).toEqual(interrupted);
      recovered.destroy(); again.destroy();
    } finally { restore(); }
  });

  it('replaces an unfinished row in its original draft and ignores retired upload progress', async () => {
    const { engines, restore } = await withFakeEngine();
    try {
      const onChange = vi.fn();
      const attachments = createComposerAttachments({ callers: {} as never, connect: {} as never, onChange });
      attachments.activateDraft('first'); const id = attachments.attach(file('Original.pdf'))!;
      engines[0].listener?.({ sent: 0, total: 10, error: 'Disconnected' });
      attachments.activateDraft('second'); attachments.restore([{ file_id: 'file:second', media_class: 'image' }]);
      onChange.mockClear();
      expect(attachments.retry(id, file('Chosen.pdf'))).toBe(id);
      expect(attachments.retry(id, file('Duplicate.pdf'))).toBeUndefined();
      expect(engines).toHaveLength(2); expect(onChange).not.toHaveBeenCalled();
      engines[0].listener?.({ sent: 10, total: 10, recordId: 'file:stale' });
      expect(attachments.payload('first')).toEqual([]);
      engines[1].listener?.({ sent: 10, total: 10, recordId: 'file:chosen' });
      expect(onChange).not.toHaveBeenCalled();
      expect(attachments.payload('first')).toEqual([{ file_id: 'file:chosen', media_class: 'document', filename: 'Chosen.pdf' }]);
      expect(attachments.payload()[0]!.file_id).toBe('file:second');
      attachments.activateDraft('first');
      expect(attachments.rows()).toHaveLength(1); expect(attachments.hasUnfinished()).toBe(false);
      expect(attachments.recoveryUploads()).toEqual([]);
      attachments.destroy();
    } finally { restore(); }
  });

  it('keeps an interrupted entry when no upload transport is available and retires removed entries', async () => {
    const interrupted = [{ id: 'pending', filename: 'Pending.pdf', media_class: 'document' }];
    const unavailable = createComposerAttachments({ onChange: vi.fn() });
    unavailable.restoreInterrupted(interrupted);
    const id = unavailable.rows()[0]!.id;
    expect(unavailable.retry(id, file('Again.pdf'))).toBeUndefined();
    expect(unavailable.recoveryUploads()).toEqual(interrupted);
    unavailable.remove(id); expect(unavailable.retry(id, file('Again.pdf'))).toBeUndefined();
    expect(unavailable.hasDrafts()).toBe(false); unavailable.destroy();
  });

  it('restores and snapshots another draft without changing the visible files or repainting it', () => {
    const onChange = vi.fn();
    const attachments = createComposerAttachments({ onChange });
    attachments.activateDraft('visible');
    const file = { file_id: 'file:other', media_class: 'document', filename: 'Other.pdf', selection_revision: 'e'.repeat(64) };
    attachments.restore([file], 'parked');
    expect(attachments.payload()).toEqual([]);
    expect(attachments.payload('parked')).toEqual([file]);
    expect(onChange).not.toHaveBeenCalled();
    attachments.activateDraft('parked'); expect(attachments.payload()).toEqual([file]);
    const snapshot = attachments.payload('parked');
    attachments.clear(); expect(snapshot).toEqual([file]);
    attachments.destroy();
  });

  it('keeps uploads with their own draft and suppresses background progress paint', async () => {
    const { engines, restore } = await withFakeEngine();
    try {
      const onChange = vi.fn();
      const attachments = createComposerAttachments({ callers: {} as never, connect: {} as never, onChange });
      attachments.activateDraft('first');
      const first = attachments.attach(file('First.pdf'))!;
      attachments.activateDraft('second');
      attachments.attach(file('Second.pdf'));
      onChange.mockClear();
      engines[0].listener?.({ sent: 10, total: 10, recordId: 'file:first' });
      expect(onChange).not.toHaveBeenCalled();
      expect(attachments.payload()).toEqual([]);
      expect(attachments.hasInFlight()).toBe(true);
      attachments.activateDraft('first');
      expect(attachments.payload()).toEqual([{ file_id: 'file:first', filename: 'First.pdf', media_class: 'document' }]);
      expect(attachments.hasInFlight()).toBe(false);
      attachments.activateDraft('second');
      // A late acknowledgement removes its submitted row, even off screen.
      attachments.remove(first);
      expect(attachments.rows()[0]?.filename).toBe('Second.pdf');
      expect(attachments.hasDraft('first')).toBe(false);
      attachments.clear();
      expect(engines[1].destroyed).toBe(true);
      expect(attachments.hasDrafts()).toBe(false);
      attachments.destroy();
    } finally { restore(); }
  });

  it('moves a new draft on lazy creation and clears only its own uploads', async () => {
    const { engines, restore } = await withFakeEngine();
    try {
      const attachments = createComposerAttachments({ callers: {} as never, connect: {} as never, onChange: vi.fn() });
      attachments.attach(file('New.pdf'));
      attachments.moveDraft(null, 'created');
      attachments.activateDraft('other');
      attachments.attach(file('Other.pdf'));
      attachments.clear();
      expect(engines[0].destroyed).toBe(false);
      expect(engines[1].destroyed).toBe(true);
      attachments.activateDraft('created');
      engines[0].listener?.({ sent: 10, total: 10, recordId: 'file:new' });
      expect(attachments.payload()[0]?.file_id).toBe('file:new');
      attachments.activateDraft(null);
      expect(attachments.rows()).toEqual([]);
      attachments.destroy();
      expect(attachments.hasDrafts()).toBe(false);
    } finally { restore(); }
  });

  it('cancels a deleted draft and retains a failed upload in another', async () => {
    const { engines, restore } = await withFakeEngine();
    try {
      const attachments = createComposerAttachments({ callers: {} as never, connect: {} as never, onChange: vi.fn() });
      attachments.activateDraft('deleted'); attachments.attach(file('Deleted.pdf'));
      attachments.activateDraft('retained'); attachments.attach(file('Retry.pdf'));
      engines[1].listener?.({ sent: 0, total: 10, error: 'Disconnected' });
      attachments.discardDraft('deleted');
      expect(engines[0].destroyed).toBe(true);
      engines[0].listener?.({ sent: 10, total: 10, recordId: 'too-late' });
      attachments.activateDraft('deleted'); expect(attachments.rows()).toEqual([]);
      attachments.activateDraft('retained');
      expect(attachments.rows()[0]).toMatchObject({ filename: 'Retry.pdf', phase: 'failed', error: 'Disconnected' });
      attachments.destroy();
    } finally { restore(); }
  });

  it('restores finalized references without an upload transport and removes only the submitted rows', () => {
    const attachments = createComposerAttachments({ onChange: vi.fn() });
    const first = { file_id: 'file:first', media_class: 'image', filename: 'Photo.png', selection_revision: 'a'.repeat(64) };
    const later = { file_id: 'file:later', media_class: 'document', filename: 'Attachment' };
    attachments.restore([first]);
    attachments.restore([first]); // Selecting it twice does not duplicate the chip.
    expect(attachments.rows()).toHaveLength(1);
    const submitted = attachments.rows()[0]!.id;
    expect(attachments.hasInFlight()).toBe(false);
    expect(attachments.payload()).toEqual([first]);
    attachments.restore([later]);
    attachments.remove(submitted);
    expect(attachments.payload()).toEqual([later]);
    attachments.clear();
    expect(attachments.rows()).toEqual([]);
  });
  it('is NOT attachable until the record id lands', async () => {
    const { engines, restore } = await withFakeEngine();
    try {
      const onChange = vi.fn();
      const a = createComposerAttachments({
        callers: {} as never, connect: {} as never, onChange,
      });
      a.attach(file('contract.pdf'));

      // Selected, climbing — visible, but NOT in the send payload. Showing it
      // as attached here would let Send fire on a file the server does not
      // have, and the message would go without it, silently.
      expect(a.rows()).toHaveLength(1);
      expect(a.rows()[0].phase).toBe('uploading');
      expect(a.payload()).toEqual([]);
      expect(a.hasInFlight()).toBe(true);

      engines[0].listener?.({ sent: 5, total: 10 });
      expect(a.payload()).toEqual([]);
      expect(a.hasInFlight()).toBe(true);

      engines[0].listener?.({ sent: 10, total: 10, recordId: 'file:abc' });
      expect(a.rows()[0].phase).toBe('attached');
      expect(a.payload()).toEqual([{ file_id: 'file:abc', media_class: 'document', filename: 'contract.pdf' }]);
      expect(a.hasInFlight()).toBe(false);
    } finally {
      restore();
    }
  });

  it('a completed upload with NO record id is not attached', async () => {
    const { engines, restore } = await withFakeEngine();
    try {
      const a = createComposerAttachments({
        callers: {} as never, connect: {} as never, onChange: () => {},
      });
      a.attach(file('x.pdf'));
      // Bytes are up but nothing was named — there is no id to send.
      engines[0].listener?.({ sent: 10, total: 10 });
      expect(a.payload()).toEqual([]);
      expect(a.rows()[0].phase).toBe('uploading');
    } finally {
      restore();
    }
  });

  it('a failed upload is surfaced and never sent', async () => {
    const { engines, restore } = await withFakeEngine();
    try {
      const a = createComposerAttachments({
        callers: {} as never, connect: {} as never, onChange: () => {},
      });
      a.attach(file('x.pdf'));
      engines[0].listener?.({ sent: 3, total: 10, error: 'socket closed' });
      expect(a.rows()[0]).toMatchObject({ phase: 'failed', error: 'socket closed' });
      expect(a.payload()).toEqual([]);
      // A failure must not hold Send hostage.
      expect(a.hasInFlight()).toBe(false);
      expect(engines[0].destroyed).toBe(true);
    } finally {
      restore();
    }
  });

  it('⛔ a listener still names its OWN row after an earlier row is removed', async () => {
    const { engines, restore } = await withFakeEngine();
    try {
      const a = createComposerAttachments({
        callers: {} as never, connect: {} as never, onChange: () => {},
      });
      a.attach(file('first.pdf'));
      a.attach(file('second.pdf'));
      const secondId = a.rows()[1].id;

      // Drop the FIRST row while the second is still climbing. With a
      // positional index captured at attach time, the second engine's listener
      // would now write to a row that is not its own — or past the end.
      a.remove(a.rows()[0].id);
      engines[1].listener?.({ sent: 10, total: 10, recordId: 'file:second' });

      expect(a.rows()).toHaveLength(1);
      expect(a.rows()[0].id).toBe(secondId);
      expect(a.rows()[0].filename).toBe('second.pdf');
      expect(a.payload()).toEqual([{ file_id: 'file:second', media_class: 'document', filename: 'second.pdf' }]);
    } finally {
      restore();
    }
  });

  it('removing a row cancels ITS engine, not a neighbour', async () => {
    const { engines, restore } = await withFakeEngine();
    try {
      const a = createComposerAttachments({
        callers: {} as never, connect: {} as never, onChange: () => {},
      });
      a.attach(file('first.pdf'));
      a.attach(file('second.pdf'));
      a.remove(a.rows()[0].id);
      expect(engines[0].destroyed).toBe(true);
      expect(engines[1].destroyed).toBe(false);
    } finally {
      restore();
    }
  });

  it('a tick for a row removed mid-flight is dropped, not applied', async () => {
    const { engines, restore } = await withFakeEngine();
    try {
      const a = createComposerAttachments({
        callers: {} as never, connect: {} as never, onChange: () => {},
      });
      a.attach(file('gone.pdf'));
      const id = a.rows()[0].id;
      a.remove(id);
      expect(() => engines[0].listener?.({ sent: 10, total: 10, recordId: 'file:late' })).not.toThrow();
      expect(a.rows()).toHaveLength(0);
      expect(a.payload()).toEqual([]);
    } finally {
      restore();
    }
  });

  it('clear() empties the set after a send', async () => {
    const { engines, restore } = await withFakeEngine();
    try {
      const a = createComposerAttachments({
        callers: {} as never, connect: {} as never, onChange: () => {},
      });
      a.attach(file('x.pdf'));
      engines[0].listener?.({ sent: 10, total: 10, recordId: 'file:x' });
      expect(a.payload()).toHaveLength(1);
      a.clear();
      expect(a.rows()).toEqual([]);
      expect(a.payload()).toEqual([]);
    } finally {
      restore();
    }
  });

  it('notifies the host on every state change so the composer repaints', async () => {
    const { engines, restore } = await withFakeEngine();
    try {
      const onChange = vi.fn();
      const a = createComposerAttachments({
        callers: {} as never, connect: {} as never, onChange,
      });
      a.attach(file('x.pdf'));
      const afterAttach = onChange.mock.calls.length;
      engines[0].listener?.({ sent: 5, total: 10 });
      expect(onChange.mock.calls.length).toBeGreaterThan(afterAttach);
    } finally {
      restore();
    }
  });
});

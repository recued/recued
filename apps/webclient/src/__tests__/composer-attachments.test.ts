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

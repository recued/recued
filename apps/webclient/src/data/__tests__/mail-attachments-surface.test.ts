import { expect, it, vi } from 'vitest';
import type { MailMessageAttachmentsSnapshot } from '@recued/contracts';
import { createMailAttachmentsSurface, type MailAttachmentsCaller } from '../mail-attachments-surface.js';

const id = 'file:' + '1'.repeat(32), hash = 'a'.repeat(64);
const reply = (record_id = 'mail:one'): MailMessageAttachmentsSnapshot => ({
  slug: 'work', record_id, incarnation: 'enrollment-1', truncated: false, warnings: [],
  items: [{ file_id: id, filename: 'Invoice.pdf', mime_type: 'application/pdf', size: 10, content_hash: hash, selection_revision: hash }],
});
const target = { getAttribute: () => id } as unknown as HTMLElement;
const setup = (get: MailAttachmentsCaller) => {
  const document = { querySelector: vi.fn(() => null), createElement: vi.fn() } as unknown as Document;
  const files = { preview: vi.fn(), read: vi.fn() };
  const render = vi.fn();
  return { surface: createMailAttachmentsSurface({ document, get, files, render, actionAttr: 'data-action' }), files, document };
};

it('keeps a newer message selected when an older attachment list arrives late', async () => {
  let resolve!: (value: MailMessageAttachmentsSnapshot) => void;
  const get = vi.fn<MailAttachmentsCaller>().mockImplementationOnce(() => new Promise(done => { resolve = done; }))
    .mockResolvedValueOnce({ ...reply('mail:two'), items: [{ ...reply().items[0]!, filename: 'Second.pdf' }] });
  const { surface } = setup(get);
  surface.open({ slug: 'work', record_id: 'mail:one' }, true);
  surface.open({ slug: 'work', record_id: 'mail:two' }, true);
  await vi.waitFor(() => expect(surface.render()).toContain('Second.pdf'));
  resolve(reply()); await Promise.resolve();
  expect(surface.render()).not.toContain('Invoice.pdf'); expect(surface.render()).toContain('Second.pdf'); surface.dispose();
});

it('checks the reviewed enrollment and file revision before any preview or download', async () => {
  const get = vi.fn<MailAttachmentsCaller>().mockResolvedValueOnce(reply()).mockResolvedValueOnce({
    ...reply(), items: [{ ...reply().items[0]!, filename: 'Revised.pdf', selection_revision: 'b'.repeat(64) }],
  });
  const { surface, files } = setup(get); surface.open({ slug: 'work', record_id: 'mail:one' }, true);
  await vi.waitFor(() => expect(surface.render()).toContain('Invoice.pdf'));
  surface.handleAction('mail-message-attachment-preview', target);
  await vi.waitFor(() => expect(surface.render()).toContain('choose it again'));
  expect(surface.render()).toContain('Revised.pdf');
  expect(get.mock.calls[1]?.[0].expected_incarnation).toBe('enrollment-1');
  expect(files.preview).not.toHaveBeenCalled(); expect(files.read).not.toHaveBeenCalled(); surface.dispose();
});

it('does not save bytes from a download that finishes after changing messages', async () => {
  let resolve!: (value: { record_id: string; filename: string; mime_type: string; bytes_b64: string }) => void;
  const get = vi.fn<MailAttachmentsCaller>().mockResolvedValue(reply());
  const { surface, files, document } = setup(get);
  files.read.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  surface.open({ slug: 'work', record_id: 'mail:one' }, true);
  await vi.waitFor(() => expect(surface.render()).toContain('Invoice.pdf'));
  surface.handleAction('mail-message-attachment-download', target);
  await vi.waitFor(() => expect(files.read).toHaveBeenCalledTimes(1));
  surface.reset(); resolve({ record_id: id, filename: 'Invoice.pdf', mime_type: 'application/pdf', bytes_b64: 'eA==' });
  await Promise.resolve(); await Promise.resolve();
  expect(document.createElement).not.toHaveBeenCalled(); expect(surface.render()).toBe(''); surface.dispose();
});

it('discloses unretained files and incomplete lists without offering file actions', async () => {
  const { surface, files } = setup(async () => ({ ...reply(), truncated: true, warnings: ['Some saved links could not be checked.'],
    items: [{ file_id: id, filename: '<Invoice>', mime_type: 'application/pdf', size: null, unavailable_reason: 'The saved bytes are missing.' }] }));
  surface.open({ slug: 'work', record_id: 'mail:one' }, true);
  await vi.waitFor(() => expect(surface.render()).toContain('bytes are missing'));
  expect(surface.render()).toContain('&lt;Invoice&gt;'); expect(surface.render()).toContain('list is incomplete');
  expect(surface.render()).not.toContain('mail-message-attachment-preview');
  surface.handleAction('mail-message-attachment-download', target);
  expect(files.read).not.toHaveBeenCalled(); surface.dispose();
});

it('shows attachment read errors independently and refuses malformed or stale replies', async () => {
  const invalid = reply(); Reflect.deleteProperty(invalid.items[0]!, 'selection_revision');
  const get = vi.fn<MailAttachmentsCaller>().mockRejectedValueOnce(new Error('Saved attachments are offline.'))
    .mockResolvedValueOnce(invalid).mockResolvedValueOnce(reply());
  const { surface } = setup(get); surface.open({ slug: 'work', record_id: 'mail:one' }, true);
  await vi.waitFor(() => expect(surface.render()).toContain('offline'));
  surface.handleAction('mail-message-attachments-refresh');
  await vi.waitFor(() => expect(surface.render()).toContain('could not be confirmed'));
  surface.handleAction('mail-message-attachments-refresh');
  await vi.waitFor(() => expect(surface.render()).toContain('Invoice.pdf')); surface.dispose();
});

it('keeps the original mailbox identity across an attachment failure and retry', async () => {
  const get = vi.fn<MailAttachmentsCaller>().mockResolvedValueOnce(reply())
    .mockRejectedValueOnce(new Error('Temporarily offline'))
    .mockResolvedValueOnce({ ...reply(), incarnation: 'replacement' });
  const { surface, files } = setup(get); surface.open({ slug: 'work', record_id: 'mail:one' }, true);
  await vi.waitFor(() => expect(surface.render()).toContain('Invoice.pdf'));
  surface.handleAction('mail-message-attachments-refresh');
  await vi.waitFor(() => expect(surface.render()).toContain('Temporarily offline'));
  surface.handleAction('mail-message-attachments-refresh');
  await vi.waitFor(() => expect(surface.render()).toContain('could not be confirmed'));
  expect(get.mock.calls[2]?.[0].expected_incarnation).toBe('enrollment-1');
  expect(surface.render()).not.toContain('Invoice.pdf');
  expect(files.read).not.toHaveBeenCalled(); surface.dispose();
});

it('retires an older file-open check when a newer refresh of the same email wins', async () => {
  let resolve!: (value: MailMessageAttachmentsSnapshot) => void;
  const newer = { ...reply(), items: [{ ...reply().items[0]!, filename: 'Newer.pdf', selection_revision: 'b'.repeat(64) }] };
  const get = vi.fn<MailAttachmentsCaller>().mockResolvedValueOnce(reply())
    .mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValueOnce(newer);
  const { surface, files, document } = setup(get);
  const ref = { slug: 'work', record_id: 'mail:one' }; surface.open(ref, true);
  await vi.waitFor(() => expect(surface.render()).toContain('Invoice.pdf'));
  surface.handleAction('mail-message-attachment-preview', target);
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  surface.open(ref, true);
  await vi.waitFor(() => expect(surface.render()).toContain('Newer.pdf'));
  resolve(reply()); await Promise.resolve(); await Promise.resolve();
  expect(surface.render()).toContain('Newer.pdf'); expect(surface.render()).not.toContain('Invoice.pdf');
  expect(document.createElement).not.toHaveBeenCalled(); expect(files.preview).not.toHaveBeenCalled(); surface.dispose();
});

it('rejects malformed availability reasons and incomplete readable-file metadata before rendering', async () => {
  const corrupt = [
    (value: MailMessageAttachmentsSnapshot) => Reflect.set(value.items[0]!, 'unavailable_reason', 42),
    (value: MailMessageAttachmentsSnapshot) => { Reflect.set(value.items[0]!, 'unavailable_reason', ''); Reflect.deleteProperty(value.items[0]!, 'content_hash'); },
    (value: MailMessageAttachmentsSnapshot) => Reflect.set(value.items[0]!, 'size', null),
  ];
  for (const change of corrupt) {
    const value = reply(); change(value);
    const { surface, files } = setup(async () => value); surface.open({ slug: 'work', record_id: 'mail:one' }, true);
    await Promise.resolve(); await Promise.resolve();
    expect(() => surface.render()).not.toThrow();
    expect(surface.render()).toContain('could not be confirmed');
    expect(surface.render()).not.toContain('mail-message-attachment-preview');
    expect(files.read).not.toHaveBeenCalled(); surface.dispose();
  }
});

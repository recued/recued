/** D-172 P2 — the compose dialog's attachment control.
 *
 *  Two things are pinned here that the generic form renderer could not give
 *  us, and that a screenshot would not catch either:
 *
 *    1. The `attachments` field NEVER reaches the generic form. It arrives as
 *       `array<ref data.file>`, and the renderer upgrades a ref to a picker
 *       ONLY for `data.contact` — so leaving it in produced a bare text box
 *       expecting a typed `file:9a3c…` id. The strip is asserted against a
 *       definition built from the REAL canonical schema, not a hand-made one,
 *       so a schema rename shows up here.
 *    2. An id the host could not resolve still renders. "Attached but
 *       unresolved" and "silently dropped" must not look the same.
 */

import { describe, it, expect } from 'vitest';
import {
  MAIL_COMPOSE_MAX_ATTACHMENTS,
  MAIL_SEND_ATTACHMENT_MAX_BYTES,
  MAIL_MESSAGE_SCHEMA,
  EMPTY_MAIL_COMPOSE_VALUES,
  formFromCanonicalSchema,
  type MailComposeAttachment,
  type MailComposeDialogState,
  type MailSenderSourceOption,
} from '@recued/contracts';
import {
  renderMailComposeAttachmentPicker,
  humanFileSize,
} from '../mail-compose/attachment-picker.js';
import { renderMailComposeDialog } from '../mail-compose/dialog.js';

const file = (
  id: string,
  filename: string,
  size_bytes?: number,
): MailComposeAttachment =>
  size_bytes === undefined ? { id, filename } : { id, filename, size_bytes };

describe('D-172 P2 — humanFileSize', () => {
  it('renders each unit band', () => {
    expect(humanFileSize(0)).toBe('0 B');
    expect(humanFileSize(512)).toBe('512 B');
    expect(humanFileSize(2048)).toBe('2 KB');
    expect(humanFileSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });

  it('keeps one decimal at MB so the cap boundary is legible', () => {
    // 2.9 vs 3.1 is precisely the distinction the over-cap mark turns on;
    // rounding to whole MB would print "3 MB" for both.
    expect(humanFileSize(2.9 * 1024 * 1024)).toBe('2.9 MB');
    expect(humanFileSize(3.1 * 1024 * 1024)).toBe('3.1 MB');
  });

  it('does not invent a size for a nonsense input', () => {
    expect(humanFileSize(Number.NaN)).toBe('—');
    expect(humanFileSize(-1)).toBe('—');
  });
});

describe('D-172 P2 — attachment picker rendering', () => {
  it('renders an empty state, not an empty list', () => {
    const html = renderMailComposeAttachmentPicker({
      attachment_ids: [], known: [], submitting: false,
    });
    expect(html).toContain('No files attached.');
    expect(html).not.toContain('mail-compose-attachment-list');
  });

  it('renders one chip per id, in the order of the ids', () => {
    const html = renderMailComposeAttachmentPicker({
      attachment_ids: ['file:b', 'file:a'],
      // Deliberately supplied in the OPPOSITE order — display order must come
      // from the values array, which is what the send payload carries.
      known: [file('file:a', 'a.pdf', 100), file('file:b', 'b.pdf', 200)],
      submitting: false,
    });
    expect(html.indexOf('b.pdf')).toBeLessThan(html.indexOf('a.pdf'));
  });

  it('an unresolved id still renders, labelled by its id and marked unknown', () => {
    const html = renderMailComposeAttachmentPicker({
      attachment_ids: ['file:ghost'], known: [], submitting: false,
    });
    expect(html).toContain('file:ghost');
    expect(html).toContain('size unknown');
    expect(html).toContain('data-attachment-id="file:ghost"');
  });

  it('marks an over-cap file in WORDS, and does not remove it', () => {
    const html = renderMailComposeAttachmentPicker({
      attachment_ids: ['file:big'],
      known: [file('file:big', 'huge.bin', MAIL_SEND_ATTACHMENT_MAX_BYTES + 1)],
      submitting: false,
    });
    expect(html).toContain('data-attachment-over-cap="true"');
    expect(html).toContain('will not be sent');
    // Still present — the server is the authority on the drop; the UI warns.
    expect(html).toContain('huge.bin');
  });

  it('a file exactly AT the cap is not over it', () => {
    const html = renderMailComposeAttachmentPicker({
      attachment_ids: ['file:edge'],
      known: [file('file:edge', 'edge.bin', MAIL_SEND_ATTACHMENT_MAX_BYTES)],
      submitting: false,
    });
    expect(html).not.toContain('data-attachment-over-cap');
    expect(html).not.toContain('will not be sent');
  });

  it('locks add + remove while submitting', () => {
    const html = renderMailComposeAttachmentPicker({
      attachment_ids: ['file:a'],
      known: [file('file:a', 'a.pdf', 10)],
      submitting: true,
    });
    // Both controls, not just one — a remove that fires mid-send would mutate
    // values the dispatch already read.
    expect(html).toMatch(/mail-compose-attachment-add[\s\S]*?disabled/);
    expect(html).toMatch(/mail-compose-attachment-remove[\s\S]*?disabled/);
  });

  it('disables ADD at the cap without touching what is already attached', () => {
    const ids = Array.from({ length: MAIL_COMPOSE_MAX_ATTACHMENTS }, (_, i) => `file:${i}`);
    const html = renderMailComposeAttachmentPicker({
      attachment_ids: ids,
      known: ids.map((id, i) => file(id, `f${i}.txt`, 10)),
      submitting: false,
    });
    expect(html).toMatch(/mail-compose-attachment-add[\s\S]*?disabled/);
    expect(html).toContain('Attachment limit reached');
    // Every chip still rendered + still removable.
    for (const id of ids) expect(html).toContain(`data-attachment-id="${id}"`);
    expect(html).not.toMatch(/mail-compose-attachment-remove[\s\S]*?disabled/);
  });

  it('escapes a filename that would otherwise inject markup', () => {
    const html = renderMailComposeAttachmentPicker({
      attachment_ids: ['file:x'],
      known: [file('file:x', '<img src=x onerror=alert(1)>.pdf', 10)],
      submitting: false,
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });
});

describe('D-172 P2 — the dialog owns attachments, so the generic form must not', () => {
  const state = (
    attachments: readonly string[],
  ): MailComposeDialogState => ({
    mode: 'create',
    values: { ...EMPTY_MAIL_COMPOSE_VALUES, attachments, sender_source: 'src-1' },
    errors: {},
    submitting: false,
    submit_error: null,
  });
  const sources: MailSenderSourceOption[] = [
    {
      id: 'src-1',
      label: 'alice@example.com (IMAP)',
      account_email: 'alice@example.com',
      send_capable: true,
      draft_capable: false,
      mail_instance_slug: 'work',
    },
  ];

  // Built from the REAL schema — a rename of the `attachments` relationship
  // makes the strip a silent no-op, and this is what notices.
  const definition = formFromCanonicalSchema(MAIL_MESSAGE_SCHEMA);

  it('the canonical schema really does carry attachments as array<ref data.file>', () => {
    const field = definition.fields.find((f) => f.name === 'attachments');
    expect(field).toBeDefined();
    expect(field?.type).toBe('array');
    expect(field?.item_type).toBe('ref');
    expect(field?.ref_target).toBe('data.file');
  });

  it('renders the picker and NOT a raw-id text input for attachments', () => {
    const html = renderMailComposeDialog({
      definition,
      state: state(['file:a']),
      sources,
      attachments: [file('file:a', 'contract.pdf', 2048)],
    });
    expect(html).toContain('mail-compose-attachments');
    expect(html).toContain('contract.pdf');
    // The generic renderer's array-of-ref control must be absent for this field.
    expect(html).not.toContain('data-form-array-item="attachments"');
    expect(html).not.toContain('data-form-ref-target="data.file"');
  });

  it('renders attachments even when the host supplies no metadata at all', () => {
    const html = renderMailComposeDialog({
      definition,
      state: state(['file:a']),
      sources,
    });
    expect(html).toContain('data-attachment-id="file:a"');
    expect(html).toContain('size unknown');
  });

  it('still strips sender_source (the pre-existing filter survived the widening)', () => {
    const html = renderMailComposeDialog({
      definition, state: state([]), sources,
    });
    expect(html).not.toContain('data-form-field="sender_source"');
    expect(html).toContain('mail-compose-sender-static');
  });
});

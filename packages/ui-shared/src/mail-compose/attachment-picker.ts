/** D-172 P2 — the compose dialog's attachment control.
 *
 *  ── What this replaces ────────────────────────────────────────────
 *  `attachments` reaches the form renderer as `array` / `item_type: 'ref'` /
 *  `ref_target: 'data.file'` (from `MAIL_MESSAGE_SCHEMA`). The renderer's
 *  ref-PICKER upgrade is hard-gated to `data.contact`
 *  (`render.ts` — `refTarget === CONTACT_REF_TARGET`), so every other ref
 *  target, `data.file` included, falls through to a **bare text input the
 *  user is expected to type a raw `file:9a3c…` record id into.** That is not
 *  an attachment control; it is the raw-id box the IA audit lists as gap #8.
 *
 *  So the dialog strips `attachments` from the generic form the same way it
 *  already strips `sender_source`, and renders this instead.
 *
 *  ── What it shows ─────────────────────────────────────────────────
 *  Selected files as removable chips (name + human size), plus an add control
 *  over the host's file inventory. Two states are surfaced rather than hidden,
 *  because both otherwise become a surprise AFTER the send:
 *
 *    · OVER-CAP — a file past `MAIL_SEND_ATTACHMENT_MAX_BYTES` is marked here.
 *      ⚠ It is NOT removed and NOT blocked: the server is the authority and
 *      drops + warns (D-172 I-6). Marking it makes the outcome visible while
 *      the user can still act; silently dropping it client-side would be the
 *      same defect one layer up.
 *    · UNKNOWN SIZE — the host could not resolve the record behind an id. The
 *      chip says so and shows the id. It does NOT guess a size, and it does
 *      NOT quietly drop the id: an attachment the user chose must stay
 *      visible even when its metadata read failed, or "I attached it" and
 *      "it vanished" become indistinguishable.
 *
 *  ── What it is not ────────────────────────────────────────────────
 *  ⛔ No bytes. The chips are labels over `data.file` record ids; the ids are
 *  what ride in `MailComposeValues.attachments`, in the send payload, and into
 *  the Gateway-gated `file.read` that resolves them server-side. Nothing here
 *  reads, uploads, or re-encodes file content.
 *
 *  Host wiring (all `data-action`, consistent with the rest of the dialog):
 *    · `mail-compose-attachment-add`    — open the host's file picker /
 *      inventory browser; the host then calls
 *      `addComposeAttachmentsTransition`.
 *    · `mail-compose-attachment-remove` — carries
 *      `data-attachment-id`; the host calls
 *      `removeComposeAttachmentTransition` with it.
 *
 *  Spec: D-145 § A.5 (Email compose UI) + D-172 P2. */

import {
  MAIL_COMPOSE_MAX_ATTACHMENTS,
  MAIL_SEND_ATTACHMENT_MAX_BYTES,
  type MailComposeAttachment,
} from '@recued/contracts';
import { e } from '../template.js';

export interface MailComposeAttachmentPickerProps {
  /** The ids currently attached — the authoritative list, straight from
   *  `MailComposeValues.attachments`. Render order is this order. */
  attachment_ids: readonly string[];
  /** Display metadata the host resolved for those ids, in any order. An id
   *  with no entry renders as an unresolved chip rather than disappearing. */
  known: readonly MailComposeAttachment[];
  /** Mirror of `MailComposeDialogState.submitting` — add/remove lock while the
   *  send is in flight, matching the rest of the dialog's controls. */
  submitting: boolean;
}

/** Bytes → a short human string. Binary units (KiB semantics, KB label) to
 *  match how the cap itself is expressed (3 * 1024 * 1024). Whole numbers
 *  below MB, one decimal above — enough to tell 2.9 MB from 3.1 MB, which is
 *  exactly the distinction the cap mark turns on. */
export const humanFileSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
};

const CAP_LABEL = humanFileSize(MAIL_SEND_ATTACHMENT_MAX_BYTES);

const renderChip = (
  id: string,
  meta: MailComposeAttachment | undefined,
  lockAttr: string,
): string => {
  const resolved = meta !== undefined && typeof meta.size_bytes === 'number';
  const overCap = resolved && (meta as MailComposeAttachment).size_bytes! > MAIL_SEND_ATTACHMENT_MAX_BYTES;
  const label = meta?.filename && meta.filename.length > 0 ? meta.filename : id;

  const note = !resolved
    ? '<span class="mail-compose-attachment-note" data-attachment-state="unresolved">size unknown</span>'
    : overCap
      ? `<span class="mail-compose-attachment-note" data-attachment-state="over-cap" role="status">${e(
        `${humanFileSize(meta!.size_bytes!)} — over the ${CAP_LABEL} limit, will not be sent`,
      )}</span>`
      : `<span class="mail-compose-attachment-size">${e(humanFileSize(meta!.size_bytes!))}</span>`;

  return `
    <li
      class="mail-compose-attachment"
      data-attachment-id="${e(id)}"
      ${overCap ? 'data-attachment-over-cap="true"' : ''}
    >
      <span class="mail-compose-attachment-name" title="${e(label)}">${e(label)}</span>
      ${note}
      <button
        type="button"
        class="mail-compose-attachment-remove"
        data-action="mail-compose-attachment-remove"
        data-attachment-id="${e(id)}"
        aria-label="${e(`Remove attachment ${label}`)}"${lockAttr}
      >×</button>
    </li>
  `;
};

export const renderMailComposeAttachmentPicker = (
  props: MailComposeAttachmentPickerProps,
): string => {
  const lockAttr = props.submitting === true ? ' disabled aria-disabled="true"' : '';
  const byId = new Map(props.known.map((a) => [a.id, a]));

  // At the cap the ADD control disables, but nothing already attached is
  // touched — the ceiling constrains what you may add next, never what you
  // already chose.
  const atCap = props.attachment_ids.length >= MAIL_COMPOSE_MAX_ATTACHMENTS;
  const addLockAttr = props.submitting === true || atCap
    ? ' disabled aria-disabled="true"'
    : '';

  const chips = props.attachment_ids
    .map((id) => renderChip(id, byId.get(id), lockAttr))
    .join('');

  const list = props.attachment_ids.length === 0
    ? '<p class="mail-compose-attachment-empty">No files attached.</p>'
    : `<ul class="mail-compose-attachment-list">${chips}</ul>`;

  const capNote = atCap
    ? `<p class="mail-compose-attachment-cap" role="status">${e(
      `Attachment limit reached (${MAIL_COMPOSE_MAX_ATTACHMENTS}).`,
    )}</p>`
    : '';

  return `
    <div class="mail-compose-attachments" data-form-field="attachments">
      <div class="mail-compose-attachment-header">
        <span class="mail-compose-attachment-label" id="mail-compose-attachments-label">Attachments</span>
        <button
          type="button"
          class="mail-compose-attachment-add"
          data-action="mail-compose-attachment-add"
          aria-label="Attach a file"${addLockAttr}
        >Attach file</button>
      </div>
      <div aria-labelledby="mail-compose-attachments-label">
        ${list}
      </div>
      ${capNote}
    </div>
  `;
};

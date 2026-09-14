/** D-264 — `core.mail.draft.save-to-mailbox`: push a SAVED draft into the mailbox's own
 *  Drafts folder.
 *
 *  ── Why the input is a draft_id and not a message ─────────────────
 *  ⛔ The caller names a draft; it never hands over content. The draft already
 *  lives in `mail_drafts`, so the server reads the row and exports THOSE bytes.
 *  Accepting a message instead would let a caller export something the owner
 *  never saved, under the authority of a draft they did — and the exported
 *  message and the reviewed message would be the same only by agreement, not by
 *  construction.
 *
 *  ── Re-export supersedes, and says whether it managed to ──────────
 *  The row carries `mailbox_copy_id` from the last successful export. It is
 *  handed back as `prior` so Graph `PATCH` / Gmail `PUT` update in place. The
 *  returned `replaced` is the PROVIDER'S answer, never an assumption: IMAP has
 *  no update verb and may leave the old copy behind, in which case the owner
 *  has two and the warning says so.
 *
 *  ⚠ The stored id is only advanced on success, and only to what the provider
 *  actually returned. A failed export leaves the prior id in place so the NEXT
 *  attempt still tries to supersede rather than starting a fresh chain of
 *  copies.
 */
import { RpcError, normalizeMailSend } from '@recued/contracts';
import type { MailDraftPrincipal, MailDraftStore } from '../../storage/mail-drafts.js';
import type { CollectionRegistry } from '../registry.js';
import type { MailCollection } from './mail-collection.js';

export interface MailDraftSaveToMailboxDeps {
  registry: CollectionRegistry;
  drafts: MailDraftStore;
}

export interface MailDraftSaveToMailboxResult {
  draft_id: string;
  source_id: string;
  saved_at: number;
  replaced: boolean;
  warnings?: Array<{ code: string; message: string }>;
}

export const handleMailDraftSaveToMailbox = async (
  deps: MailDraftSaveToMailboxDeps,
  args: { draft_id?: unknown },
  principal: MailDraftPrincipal,
): Promise<MailDraftSaveToMailboxResult> => {
  const draft_id = typeof args.draft_id === 'string' && args.draft_id.length > 0
    ? args.draft_id
    : (() => { throw new RpcError('bad_request', 'draft_id must be a non-empty string', 400); })();

  // Reads through the ordinary draft gate — the caller needs `core.mail.draft.read`
  // authority over this draft before its content can leave Recued.
  const draft = await deps.drafts.get({ draft_id }, principal);
  const content = normalizeMailSend(draft.content);
  const slug = content.instance;

  const collection = deps.registry.get('mail', slug) as MailCollection | undefined;
  if (!collection) {
    throw new RpcError(
      'not_found',
      `MAIL_INSTANCE_NOT_FOUND: this draft names mail instance '${slug}', which is not enrolled`,
      404,
    );
  }

  // Scoped to THIS mailbox — see `mailboxCopyId`. A draft re-pointed at a
  // different account starts a fresh chain there rather than handing the new
  // provider an id issued by the old one.
  const prior = deps.drafts.mailboxCopyId(draft_id, slug, principal);
  const saved = await collection.saveDraft({
    to: content.to,
    ...(content.cc ? { cc: content.cc } : {}),
    ...(content.bcc ? { bcc: content.bcc } : {}),
    subject: content.subject,
    body_text: content.body_text ?? '',
    ...(content.body_html !== undefined ? { body_html: content.body_html } : {}),
    ...(content.in_reply_to !== undefined ? { in_reply_to: content.in_reply_to } : {}),
    ...(content.references ? { references: content.references } : {}),
    ...(content.reply_to !== undefined ? { reply_to: content.reply_to } : {}),
    ...(prior !== null ? { prior_source_id: prior } : {}),
  });

  const { recorded } = deps.drafts.recordMailboxCopy(draft_id, slug, saved.source_id, prior, principal);

  const warnings = [...(saved.warnings ?? [])];
  if (!recorded) {
    // Another export of this same draft landed while this one was in flight.
    // Both wrote a copy to the mailbox; only one id can be tracked, so say that
    // the other copy exists rather than leaving it to be found later.
    warnings.push({
      code: 'MAIL_DRAFT_PRIOR_NOT_REMOVED',
      message: 'Another export of this draft finished at the same time, so your '
        + 'mailbox has an extra copy. Delete the one you do not want in your mail app.',
    });
  }
  // The draft's own attachments never leave Recued on this path — say so rather
  // than let the owner find a draft in their mailbox with the files missing.
  if (content.attachments && content.attachments.length > 0) {
    warnings.push({
      code: 'MAIL_DRAFT_ATTACHMENTS_OMITTED',
      message: `${content.attachments.length} attachment(s) stayed in Recued — `
        + `the mailbox copy carries the message only.`,
    });
  }
  return {
    draft_id, source_id: saved.source_id, saved_at: saved.saved_at, replaced: saved.replaced,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
};

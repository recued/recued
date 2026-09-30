/** Resolve actual parent-email links; never guess attachment IDs or search by filename. */
import type { CollectionRecord } from '@recued/contracts';
import type { AnnotationStore } from './storage/annotation-store.js';
import type { CollectionRegistry } from './collections/registry.js';
import { parseMailAttachmentSourceId } from './collections/mail/mail-attachment-source-id.js';

export interface MailAttachmentEvidence {
  file_ref: string;
  filename: string;
  mime_type: string;
  content_hash: string | null;
  available: boolean;
}
/** `slug` is the mailbox the email was read from: two IMAP mailboxes can hold
 *  an email under one id, and their links are keyed by that id alone. */
export type MailAttachmentReader = (record: CollectionRecord, slug: string) => { attachments: MailAttachmentEvidence[]; warnings: string[] };
/** `legacyAmbiguous` is `legacyAttachmentsAmbiguousIn(registry)` outside tests. */
export const createMailAttachmentReader = (
  registry: Pick<CollectionRegistry, 'get'>,
  annotations: Pick<AnnotationStore, 'outboundLinksSync'> | undefined,
  legacyAmbiguous: (slug: string, record_id: string) => boolean,
): MailAttachmentReader => (record, slug) => {
  if (!annotations?.outboundLinksSync) return { attachments: [], warnings: ['Attachment links could not be checked.'] };
  const files = registry.get('file', 'received');
  let ambiguous: boolean | undefined;
  // A file named with a mailbox is that mailbox's alone. Any other — the legacy
  // name, a file attached by hand, one gone — is this email's only while no
  // other mailbox holds its id: else it may be the other account's document.
  const ownFile = (file_ref: string): boolean => {
    const file = files?.get(file_ref);
    const source = file?.hot_fields.origin === 'mail_attachment' ? parseMailAttachmentSourceId(file.source_id) : null;
    if (source?.slug) return source.slug === slug;
    ambiguous ??= legacyAmbiguous(slug, record.record_id);
    return !ambiguous;
  };
  const refs = [...new Set(annotations.outboundLinksSync('mail', record.record_id)
    .filter(link => link.role === 'attachment' && link.to_collection === 'file').map(link => link.to_id))].sort().filter(ownFile);
  const attachments = refs.map(file_ref => {
    const file = files?.get(file_ref);
    const fields = file?.hot_fields;
    return { file_ref, filename: typeof fields?.filename === 'string' ? fields.filename : 'Attachment',
      mime_type: typeof fields?.mime_type === 'string' ? fields.mime_type : 'application/octet-stream',
      content_hash: file?.blob_hash ?? null, available: file !== null && file !== undefined };
  });
  const warnings: string[] = [];
  if (record.hot_fields.has_attachments && !refs.length) warnings.push('This email reports attachments, but no attachment files are available yet.');
  if (attachments.some(item => !item.available)) warnings.push('One or more linked attachment files are unavailable.');
  return { attachments, warnings };
};

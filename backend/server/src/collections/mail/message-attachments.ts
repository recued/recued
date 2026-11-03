import { RpcError, type MailMessageAttachment, type MailMessageAttachmentsRequest,
  type MailMessageAttachmentsSnapshot } from '@recued/contracts';
import { createMailAttachmentReader } from '../../mail-attachment-evidence.js';
import type { AnnotationStore } from '../../storage/annotation-store.js';
import type { BlobStore } from '../../storage/blob-store.js';
import type { CollectionRegistry } from '../registry.js';
import type { InboundFileCollection } from '../file/inbound-file-collection.js';
import type { MailCollection } from './mail-collection.js';
import { legacyAttachmentsAmbiguousIn } from './mail-attachment-source-id.js';

const LIMIT = 100;
export interface MailMessageAttachmentDeps {
  registry: CollectionRegistry;
  annotations?: Pick<AnnotationStore, 'outboundLinksSync'>;
  blobs?: Pick<BlobStore, 'has'>;
  getIncarnation(slug: string): string | null;
}

/** Resolve only recorded links, with the existing cross-mailbox ambiguity checks. */
export const getMailMessageAttachments = async (
  deps: MailMessageAttachmentDeps, input: MailMessageAttachmentsRequest,
): Promise<MailMessageAttachmentsSnapshot> => {
  if (!input || typeof input.slug !== 'string' || !input.slug || input.slug.length > 256
    || typeof input.record_id !== 'string' || !input.record_id || input.record_id.length > 4096
    || input.expected_incarnation !== undefined && (typeof input.expected_incarnation !== 'string'
      || !input.expected_incarnation || input.expected_incarnation.length > 256)) {
    throw new RpcError('invalid_args', 'Choose an email to check its saved attachments.', 400);
  }
  const scope = input.conversation;
  if (scope !== undefined && (!scope || typeof scope.incarnation !== 'string' || !scope.incarnation || scope.incarnation.length > 256
    || scope.thread_id !== null && (typeof scope.thread_id !== 'string' || !scope.thread_id || scope.thread_id.length > 4096))) {
    throw new RpcError('invalid_args', 'Choose a valid conversation.', 400);
  }
  const mailbox = deps.registry.get('mail', input.slug) as MailCollection | undefined;
  const record = mailbox?.get(input.record_id);
  if (!mailbox || !record) throw new RpcError('not_found', 'This email is no longer available. Refresh Mail.', 404);
  const incarnation = deps.getIncarnation(input.slug), sourceId = record.source_id, address = mailbox.accountEmail;
  const rfcId = record.hot_fields.rfc_message_id;
  if (!incarnation) throw new RpcError('not_configured', 'Saved email attachments are unavailable here.', 503);
  const changed = () => new RpcError('resource_changed', 'This email or mailbox changed. Reopen it from Mail to check attachments.', 409);
  const assertCurrent = () => {
    const current = mailbox.get(input.record_id);
    if (deps.registry.get('mail', input.slug) !== mailbox || !current || current.source_id !== sourceId
      || current.hot_fields.rfc_message_id !== rfcId || mailbox.accountEmail !== address
      || deps.getIncarnation(input.slug) !== incarnation
      || input.expected_incarnation !== undefined && input.expected_incarnation !== incarnation
      || scope && (scope.incarnation !== incarnation
        || (typeof current.hot_fields.thread_id === 'string' && current.hot_fields.thread_id.trim() ? current.hot_fields.thread_id : null) !== scope.thread_id)) throw changed();
  };
  assertCurrent();
  const readEvidence = createMailAttachmentReader(deps.registry, deps.annotations,
    legacyAttachmentsAmbiguousIn(deps.registry), { limit: LIMIT + 1 });
  const evidence = readEvidence(record, input.slug);
  const files = deps.registry.get('file', 'received') as InboundFileCollection | undefined;
  const items: MailMessageAttachment[] = [], warnings = [...evidence.warnings];
  for (const item of evidence.attachments.slice(0, LIMIT)) {
    if (!/^file:[a-f0-9]{32}$/.test(item.file_ref)) { warnings.push('A saved attachment link could not be resolved.'); continue; }
    const entry: MailMessageAttachment = { file_id: item.file_ref, filename: item.filename, mime_type: item.mime_type, size: null };
    items.push(entry);
    if (!item.available) { entry.unavailable_reason = 'This linked attachment is no longer retained.'; continue; }
    try {
      const selected = files?.attachmentLifecycle?.selection(item.file_ref);
      if (!selected || !item.content_hash || !deps.blobs) {
        entry.unavailable_reason = 'This attachment has no readable retained copy.'; continue;
      }
      entry.filename = selected.filename; entry.mime_type = selected.mime_type; entry.size = selected.size;
      const contentHash = files?.get(item.file_ref)?.blob_hash;
      if (!contentHash || !/^[a-f0-9]{64}$/.test(contentHash)) { entry.unavailable_reason = 'This attachment has no readable retained copy.'; continue; }
      if (!await deps.blobs.has(contentHash)) { entry.unavailable_reason = 'The saved attachment bytes are missing.'; continue; }
      entry.content_hash = contentHash; entry.selection_revision = selected.selection_revision;
    } catch { entry.unavailable_reason = 'The saved attachment could not be checked. Refresh attachments to try again.'; }
  }
  // A later CAS check can outlive earlier files, links or mailbox ownership.
  // Recheck the whole offered set synchronously before returning any authority.
  if (deps.annotations?.outboundLinksSync && items.length) {
    const confirmed = new Map(readEvidence(record, input.slug).attachments.map(item => [item.file_ref, item]));
    for (const item of items) {
      if (!confirmed.has(item.file_id)) {
        item.unavailable_reason = 'This file is no longer confirmed for this email. Refresh attachments.';
      } else if (!item.unavailable_reason) {
        try {
          if (deps.registry.get('file', 'received') !== files
            || confirmed.get(item.file_id)?.content_hash !== item.content_hash
            || files?.attachmentLifecycle?.selection(item.file_id).selection_revision !== item.selection_revision) {
            item.unavailable_reason = 'This saved attachment changed. Refresh attachments before opening it.';
          }
        } catch { item.unavailable_reason = 'The saved attachment could not be checked. Refresh attachments to try again.'; }
      }
      if (item.unavailable_reason) { delete item.content_hash; delete item.selection_revision; }
    }
  }
  assertCurrent();
  const truncated = evidence.truncated === true || evidence.attachments.length > LIMIT;
  return { slug: input.slug, record_id: input.record_id, incarnation, items, warnings,
    truncated };
};

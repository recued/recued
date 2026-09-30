import { createHash } from 'node:crypto';
import { collectionSourceFreshnessFanOut, PII_ENTITY_MARKER_KEY, type CollectionRecord } from '@recued/contracts';
import type { Tier1Handler } from '@recued/middleware/internal-tool-registry/index.js';
import { isCollectionReadGrantedForDispatch, type ChatToolHandlerDeps } from './chat-tool-handlers.js';
import { collectionReadFencedHint } from './read-grant-checker.js';
import { mailEvidenceMetadata } from './mail-evidence.js';
import { readerPage } from './document-read-tool.js';

/** What a reading of a message depends on: its identity and the headers the
 * model reads and cites. Read and flag state, labels, folder and direction
 * change with ordinary mailbox use and do not change what is read. */
const stableMessage = (record: CollectionRecord): unknown[] => {
  const fields = record.hot_fields;
  return [record.record_id, fields.rfc_message_id ?? null, fields.from ?? null, fields.to ?? null, fields.cc ?? null,
    fields.subject ?? null, fields.has_attachments ?? null, record.received_at];
};
const messageSource = (record: CollectionRecord): string =>
  JSON.stringify([...stableMessage(record), record.body_inline ?? null, record.blob_hash ?? null]);

/** Exact mailbox + record lookup, with paged body and explicit attachment coverage. */
export const createMailReadHandler = (deps: ChatToolHandlerDeps): Tier1Handler => async (raw, ctx) => {
  const args = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  if (typeof args.slug !== 'string' || typeof args.record_id !== 'string'
    || (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || Number(args.offset) < 0))
    || (args.read_version !== undefined && (typeof args.read_version !== 'string' || !/^[0-9a-f]{64}$/.test(args.read_version)))
    || (Number(args.offset ?? 0) > 0 && args.read_version === undefined)) {
    return { ok: true, result: { status: 'invalid_arguments', hint: 'Pass the exact slug and record_id; offset must be a nonnegative character offset. Continue with both next_offset and read_version from the previous page.' } };
  }
  const collection = deps.getCollectionRegistry()?.get('mail', args.slug);
  const record = collection?.get(args.record_id);
  if (!record) return { ok: true, result: { status: 'unavailable', hint: 'This message is not available in that mailbox. Do not infer its contents.' } };
  const body = deps.readMailBody ? await deps.readMailBody(record) : record.body_inline ?? null;
  const current = collection!.get(args.record_id);
  if (!isCollectionReadGrantedForDispatch(deps, ctx, 'mail')) return { ok: true, result: { status: 'unavailable', hint: collectionReadFencedHint('mail') } };
  if (!current || messageSource(current) !== messageSource(record)) {
    return { ok: true, result: { status: 'changed', hint: 'This message changed while being read. Read it again before using it.' } };
  }
  const content_hash = createHash('sha256').update(JSON.stringify([...stableMessage(record), body])).digest('hex');
  if (args.read_version !== undefined && args.read_version !== content_hash) {
    return { ok: true, result: { status: 'changed', hint: 'This email changed between pages. Restart at offset 0; do not combine these versions.' } };
  }
  const offset = Number(args.offset ?? 0);
  const page = body === null ? null : readerPage(body, offset);
  const fileGranted = isCollectionReadGrantedForDispatch(deps, ctx, 'file');
  const attached = fileGranted ? deps.mailAttachments?.(record, args.slug) : undefined;
  return { ok: true, result: { status: body === null ? 'unavailable_body' : page === null ? 'invalid_offset' : 'read',
    slug: args.slug, record_id: args.record_id,
    ...mailEvidenceMetadata(args.slug, args.record_id, record.received_at),
    // Mail privacy fields are relative to the headers, not this result envelope.
    hot_fields: { ...record.hot_fields, [PII_ENTITY_MARKER_KEY]: 'mail' }, received_at: record.received_at,
    content_hash, read_version: content_hash,
    body: page?.body ?? '', offset, next_offset: page?.next_offset ?? null,
    body_incomplete: page === null || page.next_offset !== null,
    attachments: attached?.attachments ?? [], attachment_metadata_checked: attached !== undefined,
    attachment_contents_read: false,
    warnings: !fileGranted ? [collectionReadFencedHint('file')] : attached?.warnings ?? ['Attachment links could not be checked.'],
    hint: "Cite source_url beside the claim this message supports; keep owner context and other messages separately attributed. received_at_iso is the message date as stored, usually the sender's Date header: not proof of receipt or of an agreed work date. Read relevant attachments with document.read using these file references. File metadata and mail previews do not establish attachment contents. Continue with next_offset and read_version for the rest of the body.",
    source_freshness: collectionSourceFreshnessFanOut([collection!], (deps.now ?? Date.now)()),
  } };
};

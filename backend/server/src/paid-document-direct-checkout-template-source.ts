/** D-200 Slice 6g.12 — exact local template source reader shared by owner
 * readiness and post-insert claim birth. A canonical file ref is only admitted
 * when its durable record, CAS metadata, loaded bytes, and post-read record all
 * agree. The returned claim contains no template bytes or visitor data. */

import { createHash } from 'node:crypto';

import {
  PAID_DOCUMENT_TEMPLATE_MAX_BYTES,
  type PaidDocumentFulfillmentTemplateState,
  type ReceptionIntakeRecipePairClaimConfigurationBlockerCode,
} from '@recued/contracts';

import type { InboundFileCollection } from './collections/file/inbound-file-collection.js';

const CLAIM_TEMPLATE_MIME_TYPES = new Set(['text/markdown', 'text/plain']);
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

interface ClaimTemplateSourceSnapshot {
  readonly record_id: string;
  readonly blob_hash: string;
  readonly content_hash: string;
  readonly size_bytes: number;
  readonly mime_type: string;
  readonly filename: string;
}

interface ClaimTemplateSourceProbe {
  readonly snapshot: ClaimTemplateSourceSnapshot | null;
  readonly blockers: readonly ReceptionIntakeRecipePairClaimConfigurationBlockerCode[];
}

export type PaidDocumentDirectCheckoutTemplateSourceResult =
  | {
      readonly kind: 'ready';
      readonly claim: PaidDocumentFulfillmentTemplateState;
      readonly blockers: readonly [];
    }
  | {
      readonly kind: 'blocked';
      readonly claim: null;
      readonly blockers: readonly ReceptionIntakeRecipePairClaimConfigurationBlockerCode[];
    };

const inspectClaimTemplateSource = (
  value: unknown,
  expectedRecordId: string,
): ClaimTemplateSourceProbe => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { snapshot: null, blockers: ['template_source_mismatch'] };
    }
    const record = value as Record<string, unknown>;
    if (record.record_id !== expectedRecordId) {
      return { snapshot: null, blockers: ['template_source_mismatch'] };
    }
    const storage = record.storage_ref;
    if (storage === null || typeof storage !== 'object' || Array.isArray(storage)) {
      return { snapshot: null, blockers: ['template_source_mismatch'] };
    }
    const storageRecord = storage as Record<string, unknown>;
    if (storageRecord.kind === 'remote') {
      return { snapshot: null, blockers: ['template_not_local'] };
    }
    if (storageRecord.kind !== 'cas'
      || typeof storageRecord.blob_hash !== 'string'
      || !SHA256_HEX_RE.test(storageRecord.blob_hash)) {
      return { snapshot: null, blockers: ['template_source_mismatch'] };
    }
    const hot = record.hot_fields;
    if (hot === null || typeof hot !== 'object' || Array.isArray(hot)) {
      return { snapshot: null, blockers: ['template_source_mismatch'] };
    }
    const hotRecord = hot as Record<string, unknown>;
    const sizeBytes = record.size_bytes;
    const hotSize = hotRecord.size;
    const filename = hotRecord.filename;
    const mimeType = hotRecord.mime_type;
    const contentHash = hotRecord.content_hash;
    if (!Number.isSafeInteger(sizeBytes)
      || (sizeBytes as number) < 0
      || !Number.isSafeInteger(hotSize)
      || hotSize !== sizeBytes
      || typeof filename !== 'string'
      || filename.length === 0
      || typeof mimeType !== 'string'
      || mimeType.length === 0
      || typeof contentHash !== 'string'
      || !SHA256_HEX_RE.test(contentHash)
      || contentHash !== storageRecord.blob_hash
      || record.blob_hash !== storageRecord.blob_hash) {
      return { snapshot: null, blockers: ['template_source_mismatch'] };
    }
    const snapshot: ClaimTemplateSourceSnapshot = {
      record_id: expectedRecordId,
      blob_hash: storageRecord.blob_hash,
      content_hash: contentHash,
      size_bytes: sizeBytes as number,
      mime_type: mimeType,
      filename,
    };
    const blockers: ReceptionIntakeRecipePairClaimConfigurationBlockerCode[] = [];
    if (snapshot.size_bytes > PAID_DOCUMENT_TEMPLATE_MAX_BYTES) {
      blockers.push('template_too_large');
    }
    if (!CLAIM_TEMPLATE_MIME_TYPES.has(snapshot.mime_type)) {
      blockers.push('template_mime_unsupported');
    }
    return { snapshot, blockers };
  } catch {
    return { snapshot: null, blockers: ['template_source_mismatch'] };
  }
};

const readClaimTemplateSource = (
  files: Pick<InboundFileCollection, 'get'>,
  recordId: string,
): ClaimTemplateSourceProbe => {
  try {
    const record = files.get(recordId);
    return record === null
      ? { snapshot: null, blockers: ['template_missing'] }
      : inspectClaimTemplateSource(record, recordId);
  } catch {
    return { snapshot: null, blockers: ['template_lookup_unavailable'] };
  }
};

const snapshotMatchesLoadedBytes = (
  snapshot: ClaimTemplateSourceSnapshot,
  loaded: { readonly bytes: Buffer; readonly mime_type: string; readonly filename: string },
  contentHash: string,
): boolean => snapshot.blob_hash === contentHash
  && snapshot.content_hash === contentHash
  && snapshot.size_bytes === loaded.bytes.length
  && snapshot.mime_type === loaded.mime_type
  && snapshot.filename === loaded.filename;

export const loadPaidDocumentDirectCheckoutTemplateClaim = async (
  files: Pick<InboundFileCollection, 'get' | 'readBytes'>,
  recordId: string,
): Promise<PaidDocumentDirectCheckoutTemplateSourceResult> => {
  const initial = readClaimTemplateSource(files, recordId);
  if (initial.snapshot === null || initial.blockers.length > 0) {
    return {
      kind: 'blocked',
      claim: null,
      blockers: [...new Set(initial.blockers)],
    };
  }

  const blockers: ReceptionIntakeRecipePairClaimConfigurationBlockerCode[] = [];
  try {
    const loaded = await files.readBytes(recordId);
    if (!Buffer.isBuffer(loaded.bytes)) {
      blockers.push('template_unreadable');
    } else {
      const contentHash = createHash('sha256').update(loaded.bytes).digest('hex');
      if (loaded.bytes.length > PAID_DOCUMENT_TEMPLATE_MAX_BYTES) {
        blockers.push('template_too_large');
      }
      if (!CLAIM_TEMPLATE_MIME_TYPES.has(loaded.mime_type)) {
        blockers.push('template_mime_unsupported');
      }
      if (!snapshotMatchesLoadedBytes(initial.snapshot, loaded, contentHash)) {
        blockers.push('template_source_mismatch');
      }

      // `readBytes` may yield while a same-ref source is replaced. Re-read the
      // durable record before admitting the loaded bytes as the claim.
      const current = readClaimTemplateSource(files, recordId);
      blockers.push(...current.blockers);
      if (current.snapshot !== null
        && current.blockers.length === 0
        && !snapshotMatchesLoadedBytes(current.snapshot, loaded, contentHash)) {
        blockers.push('template_source_mismatch');
      }

      if (blockers.length === 0) {
        return {
          kind: 'ready',
          claim: {
            file_ref: recordId,
            content_sha256: contentHash,
            format: 'markdown',
          },
          blockers: [],
        };
      }
    }
  } catch {
    blockers.push('template_unreadable');
  }

  return {
    kind: 'blocked',
    claim: null,
    blockers: [...new Set(blockers)],
  };
};

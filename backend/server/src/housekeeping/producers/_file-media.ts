import {
  getEnrichmentDefinition,
  type CollectionRecord,
  type EnrichmentTopic,
} from '@recued/contracts';

import type { HousekeepingContext } from '../registry.js';
import type { SourceRecord } from '../source-walkers.js';

type FileMediaClass = 'voice' | 'image' | 'document';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const mediaClassOf = (record: CollectionRecord): string | null => {
  const value = record.hot_fields?.media_class;
  return typeof value === 'string' && value.length > 0 ? value : null;
};

export const isFileMediaClass = (
  record: CollectionRecord,
  mediaClass: FileMediaClass,
): boolean => mediaClassOf(record) === mediaClass;

/** D-262 § B12.2 — the `data.file` origins whose bytes may drive an AI producer
 *  on an UNATTENDED idle cycle.
 *
 *  ⛔ THE OMISSION IS `reception_drop`, AND IT IS THE WHOLE POINT. That origin
 *  is the open-visitor path — `inbound-file-collection.ts` names it exactly
 *  that — so anyone holding a public intake link can put a file in the owner's
 *  warehouse. Every file-scoped AI producer previously selected on
 *  `media_class` and NOTHING ELSE, which meant a stranger's upload was
 *  transcribed, captioned or text-extracted on the owner's credentials, with no
 *  approval, no meter and no cap. The only thing holding it back was
 *  `default_trust_state: 'manual'` — a gate D-132's promotion banner actively
 *  nudges owners past at three manual runs.
 *
 *  ⛔ AN ALLOWLIST, NOT A DENYLIST, and deliberately: a new `FileOrigin` added
 *  later must fail CLOSED. A denylist would silently grant AI spend to the next
 *  ingestion path someone builds, and the person adding it would have no reason
 *  to look here.
 *
 *  ⚠ `mail_attachment` IS allowed, and it is the judgement call in this list.
 *  Anyone who knows the owner's address can attach audio, so it is not strictly
 *  "the owner's own bytes" — but the owner deliberately enrolled that mailbox,
 *  reads it, and having emailed voice notes transcribed is the feature working
 *  rather than a leak. Reception intake is the opposite: a form built for
 *  strangers to submit through. If unattended spend on mail attachments ever
 *  needs bounding, that is a budget question (§ B12.3), not an origin one.
 *
 *  🔑 NOTHING IS LOST, ONLY AUTOMATED. The owner can still transcribe or read a
 *  reception-dropped file by attaching it to a chat turn — an owner-initiated
 *  act, which is exactly the distinction this gate draws. */
const AI_ENRICHABLE_FILE_ORIGINS: ReadonlySet<string> = new Set([
  // The authenticated owner pushed it from Data → Files.
  'webclient_upload',
  // `(messenger × user_self)` — the owner acting through another surface.
  'messenger_media',
  // The owner's own enrolled mailbox (see the ⚠ above).
  'mail_attachment',
  // Written by a granted cli op the owner ran.
  'tool_output',
  // Fetched by a granted REST op the owner configured.
  'connection_download',
]);

export const fileOriginOf = (record: CollectionRecord): string | null => {
  const value = record.hot_fields?.origin;
  return typeof value === 'string' && value.length > 0 ? value : null;
};

/** True when an unattended AI producer may spend tokens on this file.
 *
 *  ⛔ An ABSENT origin returns false. A record whose provenance cannot be read
 *  is not a record whose provenance is safe, and the conservative reading is
 *  the only one that cannot be exploited by a future writer that forgets to
 *  stamp the field.
 *
 *  ⛔ A file its capturing op OPTED OUT is refused whatever its origin
 *  (`hot_fields.ai_enrichment`, stamped `'opt_out'` from the pack's
 *  `response_capture.ai_enrichment`). The origin says who put the file here;
 *  the opt-out says what it is for. A Home Assistant camera snapshot is an
 *  allowed origin and still nothing an AI should describe on an idle cycle.
 *  It stops only the automation: the owner's own recipe can still send it.
 *  ⚠ ANY value refuses, not just `'opt_out'`: the writer only stamps that one,
 *  so anything else is a row whose intent cannot be read, and this module
 *  fails closed on those. */
export const mayAiEnrichFile = (record: CollectionRecord): boolean => {
  if (record.hot_fields?.ai_enrichment !== undefined) return false;
  const origin = fileOriginOf(record);
  return origin !== null && AI_ENRICHABLE_FILE_ORIGINS.has(origin);
};

export const fileMimeTypeOf = (record: CollectionRecord): string => {
  const value = record.hot_fields?.mime_type;
  return typeof value === 'string' && value.length > 0
    ? value
    : 'application/octet-stream';
};

export const fileNameOf = (record: CollectionRecord): string => {
  const hot = record.hot_fields ?? {};
  if (typeof hot.filename === 'string' && hot.filename.length > 0) return hot.filename;
  if (typeof hot.path === 'string' && hot.path.length > 0) return hot.path;
  return 'file';
};

export const fileEventAtOf = (record: CollectionRecord): number =>
  typeof record.modified_at === 'number' && Number.isFinite(record.modified_at)
    ? record.modified_at
    : record.received_at;

const casBlobHashOf = (record: CollectionRecord): string | null => {
  const storageRef = (record as { storage_ref?: unknown }).storage_ref;
  if (
    isObject(storageRef) &&
    storageRef.kind === 'cas' &&
    typeof storageRef.blob_hash === 'string' &&
    storageRef.blob_hash.length > 0
  ) {
    return storageRef.blob_hash;
  }
  return typeof record.blob_hash === 'string' && record.blob_hash.length > 0
    ? record.blob_hash
    : null;
};

export const fetchCasFileBytes = async (
  ctx: HousekeepingContext,
  sourceRecord: SourceRecord<CollectionRecord>,
  producerName: string,
): Promise<Buffer | null> => {
  if (!ctx.blobs) {
    throw new Error(
      `${producerName}_producer_misconfigured: ctx.blobs is required for file byte resolution`,
    );
  }
  const blobHash = casBlobHashOf(sourceRecord.data);
  if (blobHash === null) return null;
  return ctx.blobs.get(blobHash);
};

export const assertRegistryValue = <T>(
  topic: EnrichmentTopic,
  value: T,
  targetId: string,
  producerName: string,
): T => {
  const result = getEnrichmentDefinition(topic).value_schema(value);
  if (!result.ok) {
    throw new Error(
      `${producerName}_output_invalid: value_schema rejected file '${targetId}' (${result.issues.join('; ')})`,
    );
  }
  return value;
};

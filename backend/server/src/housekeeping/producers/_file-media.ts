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

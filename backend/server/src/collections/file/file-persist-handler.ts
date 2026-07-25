import { createHash } from 'node:crypto';

import { RpcError } from '@recued/contracts';
import type { TempFileRef } from '@recued/contracts';

import type { CollectionRegistry } from '../registry.js';
import { readConfinedTempFile } from '../../execution/run-scratch.js';
import { DATA_FILE_RECEIVED_SLUG } from './file-read-handler.js';
import type { InboundFileCollection } from './inbound-file-collection.js';

/** D-185 Slice 4 — `file-persist` (backs `core.storage.file.persist`): the
 *  explicit `temp → cas` keep step. Reads a run-scoped `temp` file_ref's bytes
 *  (CONFINED to the producing run's scratch root — the only authorization on a
 *  temp ref, since the producing op was already gated, §3.2) and ingests them
 *  into the content-addressed `data.file.received` warehouse, returning the
 *  durable `cas_ref` record_id. Mirrors `file-read-handler.ts` (the read
 *  sibling): resolve the collection off the registry, do one CAS IO, shape a
 *  flat result the recipe reads by key. */

export const FILE_PERSIST_INGREDIENT_SLUG = 'file-persist' as const;

export interface FilePersistRequest {
  ref: TempFileRef;
  run_id: string;
  step_id?: string;
}

export interface FilePersistResponse {
  /** The durable content-addressed record_id (`file:<32 hex>`). */
  cas_ref: string;
  /** Alias of `cas_ref` for symmetry with the read sibling's `record_id`. */
  record_id: string;
  mime_type: string;
  filename: string;
  size_bytes: number;
}

export interface FilePersistDeps {
  registry: CollectionRegistry;
}

export const handleFilePersist = async (
  deps: FilePersistDeps,
  args: FilePersistRequest,
): Promise<FilePersistResponse> => {
  const collection = deps.registry.get('file', DATA_FILE_RECEIVED_SLUG) as
    | InboundFileCollection
    | undefined;
  if (!collection || typeof collection.ingest !== 'function') {
    throw new RpcError(
      'collection_not_found',
      'file.persist: data.file.received collection is not registered',
      503,
    );
  }

  // The confined read fails closed on an empty run_id or a path that escapes the
  // run's scratch root (a hand-crafted `{ backing:'temp', path:'/etc/passwd' }`).
  const { bytes_b64, mime_type, filename } = readConfinedTempFile(args.ref, args.run_id);
  const bytes = Buffer.from(bytes_b64, 'base64');

  // `source_id` keys the record (`inboundFileRecordId(origin, source_id)`). The
  // discriminator is the CONTENT hash — NOT the filename — so a `foreach` that
  // persists many same-named temp outputs (ffmpeg always writes `out.mp4`) keys
  // each by its bytes and never overwrites a sibling, while a resumed run's
  // re-persist of the SAME bytes stays idempotent (same record_id). Scoped by
  // `(run, step)` so distinct runs/steps keep distinct provenance. Origin
  // `tool_output`: the persisted bytes ARE a tool/cli output being kept.
  const content_hash = createHash('sha256').update(bytes).digest('hex');
  const source_id = `${args.run_id}:${args.step_id ?? 'persist'}:${content_hash}`;
  const record = await collection.ingest({
    bytes,
    filename,
    mime_type,
    content_hash,
    origin: 'tool_output',
    source_id,
  });

  return {
    cas_ref: record.record_id,
    record_id: record.record_id,
    mime_type,
    filename,
    size_bytes: bytes.length,
  };
};

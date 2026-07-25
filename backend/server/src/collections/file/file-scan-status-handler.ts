import { RpcError } from '@recued/contracts';

import type { CollectionRegistry } from '../registry.js';
import { DATA_FILE_RECEIVED_SLUG } from './file-read-handler.js';
import type {
  FileScanStatus,
  InboundFileCollection,
} from './inbound-file-collection.js';

/** D-173 P5 (scan-gate part B) — `file-set-scan-status` (backs
 *  `core.storage.file.set-scan-status`): the post-scan write-back. A reactive
 *  scan recipe runs a local virus scanner (ClamAV `clamdscan` / Defender) over a
 *  freshly-ingested `data.file.received` record, then calls this op to patch the
 *  record's `scan_status` hot field to the verdict (`clean` / `flagged`). The
 *  reception inbox reads that field back, so a `flagged` upload surfaces a
 *  sharper warning while a `clean` one clears the advisory (D-173 P5 part A).
 *
 *  MCP-RESERVED by construction: the backing ingredient is `author: 'recued'`
 *  and is NOT in `MCP_EXPOSED_KERNEL_INGREDIENTS`, so an external agent can never
 *  call it to forge a `clean` verdict on a malicious file. Mirrors
 *  `file-persist-handler.ts` (the sibling write op): resolve the collection off
 *  the registry, do one hot-field patch, shape a flat result the recipe reads by
 *  key. */

export const FILE_SET_SCAN_STATUS_INGREDIENT_SLUG = 'file-set-scan-status' as const;

/** The verdicts the op accepts — the full `FileScanStatus` union. A scanner
 *  writes `clean` / `flagged` (and may stamp `pending` while a long scan runs);
 *  `unscanned` is admitted for completeness (re-marking an already-unscanned
 *  record is an idempotent no-op in the collection). */
const VALID_SCAN_STATUSES: ReadonlySet<FileScanStatus> = new Set<FileScanStatus>([
  'pending',
  'clean',
  'flagged',
  'unscanned',
]);

const isFileScanStatus = (value: unknown): value is FileScanStatus =>
  typeof value === 'string' && VALID_SCAN_STATUSES.has(value as FileScanStatus);

export interface FileSetScanStatusRequest {
  record_id: string;
  status: FileScanStatus;
}

export interface FileSetScanStatusResponse {
  record_id: string;
  scan_status: FileScanStatus;
}

export interface FileSetScanStatusDeps {
  registry: CollectionRegistry;
}

export const handleFileSetScanStatus = (
  deps: FileSetScanStatusDeps,
  args: { record_id?: unknown; status?: unknown },
): FileSetScanStatusResponse => {
  if (typeof args.record_id !== 'string' || args.record_id.length === 0) {
    throw new RpcError('bad_request', 'file.set_scan_status: record_id is required', 400);
  }
  if (!isFileScanStatus(args.status)) {
    throw new RpcError(
      'bad_request',
      "file.set_scan_status: status must be one of 'pending' | 'clean' | 'flagged' | 'unscanned'",
      400,
    );
  }

  const collection = deps.registry.get('file', DATA_FILE_RECEIVED_SLUG) as
    | InboundFileCollection
    | undefined;
  if (!collection || typeof collection.setScanStatus !== 'function') {
    throw new RpcError(
      'collection_not_found',
      'file.set_scan_status: data.file.received collection is not registered',
      503,
    );
  }

  const record = collection.setScanStatus(args.record_id, args.status);
  if (!record) {
    // The record vanished between the scan and this write-back (retention
    // pruned it). Honest 404 — the recipe step fails rather than silently
    // reporting a verdict that landed nowhere; the file is gone either way.
    throw new RpcError(
      'file_not_found',
      `file.set_scan_status: record '${args.record_id}' not found`,
      404,
    );
  }

  return {
    record_id: record.record_id,
    scan_status: record.hot_fields.scan_status,
  };
};

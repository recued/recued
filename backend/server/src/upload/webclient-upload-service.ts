/** D-172 resumable uploads — WEBCLIENT consumer (server-half).
 *
 *  The authenticated webclient owner is the first real consumer of the shared
 *  chunk-core (build step 4 of the rev-4 locked plan). This module is the
 *  consumer "endpoint wiring" the core's header anticipates: it instantiates
 *  `createUploadChunkCore` with the webclient `policy.finalize` (-> ingest into
 *  `data.file.received` with `origin: 'webclient_upload'`) and exposes the thin
 *  surface the WS layer drives:
 *
 *    - `create` / `probe` / `finalize` / `delete` — the CONTROL plane, called
 *      by the typed `upload.*` rpc handlers over the existing webclient WS. Each
 *      is scope-isolated: the caller's verified `scope_key`
 *      (`WsClient.token_instance_id`) must own the session, so one paired client
 *      can never poke another's upload (the upload_id alone is the capability,
 *      the scope check is defense-in-depth + cross-device hygiene).
 *    - `handleChunkFrame` — the DATA plane, called by the dedicated binary
 *      `/ws/upload` socket. It decodes one `UploadChunkFrame`, scope-checks, and
 *      drives `core.chunk`, returning an `UploadChunkAck`. The bytes never ride
 *      rpc (the rpc WS is text-JSON-only) and the binary socket is separate from
 *      the rpc/event WS, so a multi-minute large upload never head-of-line-blocks
 *      approvals / warehouse pushes.
 *    - `sweepExpired` — the TTL reaper, driven by D-123 housekeeping.
 *
 *  Everything safety-critical (crash-correct positional append, offset-as-truth,
 *  per-chunk checksum, disk caps, fail-closed expiry, the per-upload mutex,
 *  finalize idempotency + delete-before-unlink + orphan backstop) lives in the
 *  shared core; this layer only adds scope isolation + the webclient finalize
 *  target + the rpc/frame mapping.
 *
 *  Spec: `recued-project/handovers/handover_drop_resumable_upload_design.md`
 *  (rev 3 shared-split + rev 4 build order). */

import type Database from 'better-sqlite3';
import {
  decodeUploadChunkFrame,
  UPLOAD_FRAME_HEADER_OFFSET,
  UPLOAD_FRAME_MAX_HEADER_BYTES,
  type UploadChunkAck,
  type UploadCreateRpcResponse,
  type UploadProbeRpcResponse,
  type UploadFinalizeRpcResponse,
  type UploadDeleteRpcResponse,
} from '@recued/contracts';

import type { BlobStore } from '../storage/blob-store.js';
import {
  createUploadSessionStore,
  UPLOAD_CHUNK_MAX_BYTES,
  type UploadSession,
  type UploadSessionStore,
} from '../storage/upload-session-store.js';
import type { InboundFileCollection } from '../collections/file/inbound-file-collection.js';
import {
  createUploadChunkCore,
  type UploadChunkCore,
  type UploadFinalizeInput,
} from './upload-chunk-core.js';

/** Per-upload POLICY ceiling for the authenticated webclient owner — the
 *  absolute hard max on a single file (matching the reception drop hard max),
 *  independent of live storage. The EFFECTIVE create cap is the smaller of this
 *  and the finalize target's live gate headroom (`availableBytes`, below), so a
 *  file that could never fit the `collection:file:received` quota is rejected at
 *  create rather than after a wasted upload. The core enforces
 *  `declared_size <= effective cap` and acks `size_cap_exceeded`. */
export const WEBCLIENT_UPLOAD_SIZE_CAP_BYTES = 1024 * 1024 * 1024; // 1 GiB

/** Max accepted size of ONE binary `/ws/upload` frame: the largest chunk
 *  payload (`UPLOAD_CHUNK_MAX_BYTES`, the core's per-chunk cap) + the fixed
 *  frame prefix + the JSON-header budget. Set as the upload socket's
 *  `maxPayload` (Codex 2026-06-24 fold) so an over-cap frame is rejected at the
 *  WS layer — before a full 100 MiB (`ws`'s default) message buffer lands AND
 *  before the service-side `Buffer.from` copy. A valid 16 MiB chunk + a near-max
 *  header still fits. */
export const UPLOAD_WS_MAX_PAYLOAD_BYTES =
  UPLOAD_CHUNK_MAX_BYTES + UPLOAD_FRAME_HEADER_OFFSET + UPLOAD_FRAME_MAX_HEADER_BYTES;

/** What the webclient finalize hands back to the rpc layer (durable record id +
 *  the content hash the bytes are addressed by). */
export interface WebclientUploadFinalizeResult {
  readonly record_id: string;
  readonly content_hash: string;
  readonly size_bytes: number;
}

export interface WebclientUploadCreateInput {
  readonly scope_key: string;
  readonly filename: string;
  readonly declared_size: number;
  readonly mime_reported: string;
  readonly fingerprint?: string | null;
  readonly now?: number;
}

export interface WebclientUploadProbeInput {
  readonly scope_key: string;
  readonly upload_id: string;
  readonly filename: string;
  readonly declared_size: number;
  readonly fingerprint?: string | null;
  readonly now?: number;
}

export interface WebclientUploadIdInput {
  readonly scope_key: string;
  readonly upload_id: string;
  readonly now?: number;
}

export interface WebclientUploadService {
  create(input: WebclientUploadCreateInput): Promise<UploadCreateRpcResponse>;
  probe(input: WebclientUploadProbeInput): UploadProbeRpcResponse;
  finalize(input: WebclientUploadIdInput): Promise<UploadFinalizeRpcResponse>;
  delete(input: WebclientUploadIdInput): Promise<UploadDeleteRpcResponse>;
  /** Drive one chunk from a decoded binary `/ws/upload` frame. `scope_key` is
   *  the BINARY socket's verified identity (must own the session). Never
   *  throws — every outcome (incl. a malformed frame) maps to an ack. */
  handleChunkFrame(
    scope_key: string,
    frame: Uint8Array,
    now?: number,
  ): Promise<UploadChunkAck>;
  /** TTL + orphan reaper for D-123 housekeeping. */
  sweepExpired(input?: { now?: number; limit?: number }): Promise<{ reaped: number; orphans: number }>;
}

export interface CreateWebclientUploadServiceOptions {
  /** Per-pair SQLite handle — backs the `upload_session` store. */
  readonly db: Database.Database;
  /** Per-pair CAS BlobStore (must be streaming-capable / `putFile`). */
  readonly blobs: BlobStore;
  /** Dedicated scratch tree, a data-volume sibling of the CAS (`upload_blobs`). */
  readonly uploadsRoot: string;
  /** Finalize target — the bytes are already CAS-stored at finalize. */
  readonly inboundFileCollection: InboundFileCollection;
  /** Injectable clock (tests). Production omits it. */
  readonly now?: () => number;
  readonly log?: (level: 'info' | 'warn', msg: string, data?: unknown) => void;
  /** Test seam to make `upload_id`s deterministic. */
  readonly mintUploadId?: () => string;
  /** Override the per-upload size cap (tests / future per-owner config). */
  readonly sizeCapBytes?: number;
  /** The finalize surface's user-content capacity (bytes) — the
   *  `collection:file:received` gate's `available` (quota - reserve), read live
   *  so a reconfigured quota takes effect. When provided, the effective
   *  per-create cap is `min(sizeCapBytes, availableBytes())`, so a single file
   *  too large to EVER fit the surface is rejected at create (acked
   *  `size_cap_exceeded`) instead of being stored over-quota. This is a
   *  per-FILE ceiling, not a usage-aware total-budget admission: the file
   *  ingest path accounts bytes and never rejects, leaving total-storage
   *  pressure to the gate's accounting + pressure machinery (uniform across
   *  every ingest source). Omitted on dbless boots / tests → only the static
   *  policy cap applies. */
  readonly availableBytes?: () => number;
  /** Override the session TTL (tests inject a short window; production uses the
   *  shared `UPLOAD_SESSION_TTL_MS` default in the store). */
  readonly ttlMs?: number;
}

export const createWebclientUploadService = (
  options: CreateWebclientUploadServiceOptions,
): WebclientUploadService => {
  const { db, blobs, uploadsRoot, inboundFileCollection, log } = options;
  const sizeCapBytes = options.sizeCapBytes ?? WEBCLIENT_UPLOAD_SIZE_CAP_BYTES;

  const store: UploadSessionStore = createUploadSessionStore(db);

  // Webclient finalize: the scratch is already content-addressed in the CAS by
  // the core's `putFile`, so ingest a pre-stored `cas` storage_ref. `source_id`
  // = `upload_id` keys the durable record deterministically, so a retried
  // finalize (the core re-runs the policy if a prior attempt threw after putFile)
  // upserts the SAME `data.file.received` row — idempotent. No magic-byte gate
  // here: that is the reception allowlist's job; the webclient owner is trusted.
  const finalize = async (
    input: UploadFinalizeInput,
  ): Promise<WebclientUploadFinalizeResult> => {
    const record = await inboundFileCollection.ingest({
      storage_ref: { kind: 'cas', blob_hash: input.content_hash },
      content_hash: input.content_hash,
      size_bytes: input.size_bytes,
      filename: input.session.filename,
      mime_type: input.session.mime_reported,
      origin: 'webclient_upload',
      source_id: input.session.upload_id,
    });
    return {
      record_id: record.record_id,
      content_hash: input.content_hash,
      size_bytes: input.size_bytes,
    };
  };

  const core: UploadChunkCore<WebclientUploadFinalizeResult> = createUploadChunkCore({
    store,
    blobs,
    uploadsRoot,
    policy: { finalize },
    ...(options.now ? { now: options.now } : {}),
    ...(options.mintUploadId ? { mintUploadId: options.mintUploadId } : {}),
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    ...(log ? { log } : {}),
  });

  /** Scope-ownership gate — the session must exist AND belong to this webclient
   *  scope. A miss returns null; callers map that to a non-leaking "not found"
   *  so a wrong-scope caller can't distinguish "absent" from "not yours". */
  const ownedSession = (upload_id: string, scope_key: string): UploadSession | null => {
    const s = store.get(upload_id);
    if (!s || s.scope_kind !== 'webclient' || s.scope_key !== scope_key) return null;
    return s;
  };

  return {
    async create(input) {
      // The effective ceiling is the smaller of the owner policy cap and the
      // finalize surface's user-content capacity (D-172 size-cap alignment) —
      // reject a file too big to ever fit the surface up front, rather than
      // storing it over-quota.
      const capacity = options.availableBytes?.();
      const effectiveCap =
        capacity === undefined
          ? sizeCapBytes
          : Math.min(sizeCapBytes, Math.max(0, capacity));
      const result = await core.create({
        scope_kind: 'webclient',
        scope_key: input.scope_key,
        filename: input.filename,
        declared_size: input.declared_size,
        mime_reported: input.mime_reported,
        size_cap_bytes: effectiveCap,
        ...(input.fingerprint !== undefined ? { fingerprint: input.fingerprint } : {}),
        ...(input.now !== undefined ? { now: input.now } : {}),
      });
      if (result.ok) return { status: 'created', upload_id: result.upload_id };
      return {
        status: 'rejected',
        reason: result.reason,
        ...(result.detail !== undefined ? { detail: result.detail } : {}),
      };
    },

    probe(input) {
      if (!ownedSession(input.upload_id, input.scope_key)) {
        return { resumable: false, reason: 'not_found' };
      }
      const r = core.probe({
        upload_id: input.upload_id,
        filename: input.filename,
        declared_size: input.declared_size,
        ...(input.fingerprint !== undefined ? { fingerprint: input.fingerprint } : {}),
        ...(input.now !== undefined ? { now: input.now } : {}),
      });
      if (r.ok) return { resumable: true, offset: r.offset, complete: r.complete };
      return { resumable: false, reason: r.reason };
    },

    async finalize(input) {
      if (!ownedSession(input.upload_id, input.scope_key)) {
        return { status: 'gone', reason: 'not_found' };
      }
      const r = await core.finalize({
        upload_id: input.upload_id,
        ...(input.now !== undefined ? { now: input.now } : {}),
      });
      if (r.ok) {
        return {
          status: 'finalized',
          record_id: r.result.record_id,
          content_hash: r.result.content_hash,
          size_bytes: r.result.size_bytes,
        };
      }
      if (r.reason === 'incomplete') {
        return { status: 'pending', reason: 'incomplete', offset: r.offset };
      }
      return { status: 'gone', reason: r.reason };
    },

    async delete(input) {
      if (!ownedSession(input.upload_id, input.scope_key)) {
        return { deleted: false };
      }
      const r = await core.delete(input.upload_id);
      return { deleted: r.ok };
    },

    async handleChunkFrame(scope_key, frame, now) {
      const decoded = decodeUploadChunkFrame(frame);
      if (!decoded.ok) return { type: 'upload_error', reason: decoded.reason };
      const { req_id, upload_id, offset, checksum, bytes } = decoded.frame;

      if (!ownedSession(upload_id, scope_key)) {
        return { type: 'upload_ack', req_id, ok: false, reason: 'forbidden' };
      }

      // Copy the payload out of the (possibly pooled) WS frame buffer before the
      // async fs write — the core fsyncs it, so an alias hazard would be subtle.
      const r = await core.chunk({
        upload_id,
        expected_offset: offset,
        bytes: Buffer.from(bytes),
        ...(checksum !== undefined ? { checksum } : {}),
        ...(now !== undefined ? { now } : {}),
      });
      if (r.ok) {
        return { type: 'upload_ack', req_id, ok: true, offset: r.offset, complete: r.complete };
      }
      if (r.reason === 'offset_conflict') {
        return { type: 'upload_ack', req_id, ok: false, reason: 'offset_conflict', offset: r.offset };
      }
      return { type: 'upload_ack', req_id, ok: false, reason: r.reason };
    },

    async sweepExpired(input) {
      const r = await core.sweepExpired(input);
      return { reaped: r.reaped, orphans: r.orphans };
    },
  };
};

/** D-172 resumable uploads — RECEPTION consumer (server-half).
 *
 *  The open drop-link VISITOR is the SECOND real consumer of the shared
 *  chunk-core (build step 5 of the rev-4 locked plan; the webclient owner is
 *  the first — `webclient-upload-service.ts`). This module is the consumer
 *  "endpoint wiring" the core's header anticipates: it instantiates
 *  `createUploadChunkCore` with the reception `policy.finalize` (→ the EXISTING
 *  single-POST tail: magic-byte/MIME cross-check on the captured head, PII seal,
 *  a `reception_drop_blob_metadata` `pending` row, the signed `drop_blob.received`
 *  audit row, and the `one_time` self-revoke) and exposes the thin surface the
 *  HTTP layer drives:
 *
 *    - `create` / `probe` / `chunk` / `finalize` / `delete` — every method is
 *      scoped to one drop-link `endpoint_id` (the reception `scope_key`): the
 *      session must belong to that endpoint, so an `upload_id` minted under one
 *      drop link can never be poked through another's URL (the `upload_id` alone
 *      is the capability; the scope check is defense-in-depth, mirroring the
 *      webclient's `WsClient.token_instance_id` isolation).
 *    - `sweepExpired` — the TTL/orphan reaper. Reception SHARES the one
 *      `upload_session` table + the one `upload_blobs` scratch root with the
 *      webclient consumer, so the already-registered `upload-session-sweep`
 *      housekeeping task (global `listExpired` + the shared orphan dir) reaps
 *      reception's sessions too; this method is exposed for headless tests + a
 *      future dedicated registration.
 *
 *  Transport DIFFERS from the webclient (rev 5): reception is HTTP (a visitor on
 *  a page the server itself renders), so the chunk BYTES arrive in an HTTP body,
 *  not a binary WS frame. The shared chunk-core is unchanged — it takes
 *  `bytes: Buffer` and does not care how they arrived. Everything safety-critical
 *  (crash-correct positional append, offset-as-truth, per-chunk checksum, disk
 *  caps, fail-closed expiry, the per-upload mutex, finalize idempotency +
 *  delete-before-unlink + orphan backstop) lives in the shared core; this layer
 *  adds scope isolation, the reception admission gate (single-use form-nonce +
 *  the per-endpoint daily cap, which COUNTS COMPLETED uploads), and the reception
 *  finalize target.
 *
 *  Reception ABUSE caps are ADMISSION gates (refuse `create` past the
 *  concurrent-session / pending-bytes / daily caps) — UNLIKE the webclient's
 *  capacity cap (accounting-not-admission). The per-IP CREATE rate-limit is the
 *  reception dispatcher's `consumePreVerify` (the resumable data plane bypasses
 *  the link-style request limiter — a chunked GiB upload is 60+ requests, which
 *  would blow the drop_link 5/hr + 50/day buckets; the unguessable `upload_id`
 *  + the disk caps bound it instead).
 *
 *  Spec: internal design notes
 *  (rev 2 protocol + rev 3 shared-split + rev 4 build order + rev 5 transports). */

import { randomUUID } from 'node:crypto';

import type {
  DropLinkConfig,
  DropLinkProcessingOutcome,
  DropLinkUploadInput,
  DropLinkUploadValidationFailure,
} from '@recued/contracts';
import { validateDropLinkUpload } from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';

import type Database from 'better-sqlite3';
import type { BlobStore } from '../storage/blob-store.js';
import {
  createUploadSessionStore,
  type UploadSession,
  type UploadSessionStore,
} from '../storage/upload-session-store.js';
import type { DropBlobStore } from '../storage/reception-drop-store.js';
import type { PublicEndpointRegistryStore } from '../storage/public-endpoint-registry-store.js';
import { detectMagicBytes, sanitizeFilename } from '../ports/reception/drop-blob-storage.js';
import { sealDropBlobPiiField } from '../ports/reception/drop-pii.js';
import type { DropLinkNonceStore } from '../ports/reception/handlers/drop-link.js';
import { parseDropLinkConfig } from '../ports/reception/transformations/drop-link.js';
import {
  createUploadChunkCore,
  type UploadChunkCore,
  type UploadFinalizeInput,
} from './upload-chunk-core.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Minimum size of a NON-FINAL chunk on the OPEN reception surface. The
 *  resumable data plane bypasses the link-style request limiter (gated by the
 *  unguessable `upload_id` + the disk caps), so without a floor an abuser with
 *  one valid link could turn a single allowed upload into up to `declared_size`
 *  synchronous truncate/write/fsync ops (1-byte chunks) — the disk caps bound
 *  STORAGE, not operation COUNT. This floor bounds the per-upload chunk (→
 *  fsync) count to ~ceil(declared_size / this) (a 1 GiB upload ≤ 4096 chunks).
 *  The FINAL chunk (the remainder) is exempt, so small files + the tail are
 *  unaffected; a real client sends MiB-scale chunks far above the floor. */
const MIN_RECEPTION_CHUNK_BYTES = 256 * 1024; // 256 KiB

/** What the reception finalize hands back to the HTTP layer. `outcome`
 *  is the persisted `reception_drop_blob_metadata.processing_outcome` —
 *  `'pending'` ⇒ accepted (the drain materializes `data.file.received`);
 *  a `rejected_*` value ⇒ the row is still persisted (the Abuse Inbox reads
 *  it) but the HTTP layer maps it to the matching 4xx, exactly as the
 *  single-POST path returns 413 / 415 / 400 on a rejection. */
export interface ReceptionUploadFinalizeRecord {
  readonly blob_id: string;
  readonly outcome: DropLinkProcessingOutcome;
  readonly content_hash: string;
  readonly size_bytes: number;
}

/** Visitor-typed fields carried on the finalize request and sealed at
 *  finalize (exactly as the single-POST path seals them) — they ride
 *  FINALIZE, not create, so the in-flight session row stays pure transport
 *  (no PII at rest mid-upload). Forwarded to `policy.finalize` verbatim via
 *  the core's `finalize_context`. */
export interface ReceptionUploadFinalizeContext {
  readonly visitor_name?: string;
  readonly visitor_email?: string;
  readonly visitor_description?: string;
}

export type ReceptionUploadCreateResult =
  | { readonly status: 'created'; readonly upload_id: string }
  | {
      readonly status: 'rejected';
      readonly reason:
        | 'not_configured'
        | 'invalid_nonce'
        | 'daily_cap'
        | 'invalid_declared_size'
        | 'size_cap_exceeded'
        | 'too_many_sessions'
        | 'pending_bytes_exceeded'
        | 'rejected';
      readonly detail?: string;
    };

export type ReceptionUploadProbeResult =
  | { readonly resumable: true; readonly offset: number; readonly complete: boolean }
  | { readonly resumable: false; readonly reason: 'not_found' | 'expired' | 'file_mismatch' };

export type ReceptionUploadChunkResult =
  | { readonly ok: true; readonly offset: number; readonly complete: boolean }
  | { readonly ok: false; readonly reason: 'offset_conflict'; readonly offset: number }
  | {
      readonly ok: false;
      readonly reason:
        | 'not_found'
        | 'expired'
        | 'empty_chunk'
        | 'chunk_too_large'
        | 'chunk_too_small'
        | 'overflow'
        | 'checksum_mismatch'
        | 'scratch_missing'
        | 'forbidden';
    };

export type ReceptionUploadFinalizeResult =
  | {
      readonly status: 'finalized';
      readonly outcome: DropLinkProcessingOutcome;
      readonly blob_id: string;
      readonly content_hash: string;
      readonly size_bytes: number;
    }
  | { readonly status: 'pending'; readonly reason: 'incomplete'; readonly offset: number }
  | { readonly status: 'gone'; readonly reason: 'not_found' | 'expired' };

export interface ReceptionUploadCreateInput {
  readonly endpoint_id: string;
  readonly filename: string;
  readonly declared_size: number;
  readonly mime_reported: string;
  /** Single-use form-nonce minted by the GET render (the same hidden field the
   *  single-POST consumes) — consumed here as the CSRF + admission gate. */
  readonly form_nonce: string;
  readonly fingerprint?: string | null;
  readonly source_ip_hash?: string | null;
  readonly now?: number;
}

export interface ReceptionUploadProbeInput {
  readonly endpoint_id: string;
  readonly upload_id: string;
  readonly filename: string;
  readonly declared_size: number;
  readonly fingerprint?: string | null;
  readonly now?: number;
}

export interface ReceptionUploadChunkInput {
  readonly endpoint_id: string;
  readonly upload_id: string;
  readonly expected_offset: number;
  readonly bytes: Buffer;
  readonly checksum?: string;
  readonly now?: number;
}

export interface ReceptionUploadFinalizeInput {
  readonly endpoint_id: string;
  readonly upload_id: string;
  readonly visitor_fields: ReceptionUploadFinalizeContext;
  readonly now?: number;
}

export interface ReceptionUploadIdInput {
  readonly endpoint_id: string;
  readonly upload_id: string;
  readonly now?: number;
}

export interface ReceptionUploadService {
  create(input: ReceptionUploadCreateInput): Promise<ReceptionUploadCreateResult>;
  probe(input: ReceptionUploadProbeInput): ReceptionUploadProbeResult;
  chunk(input: ReceptionUploadChunkInput): Promise<ReceptionUploadChunkResult>;
  finalize(input: ReceptionUploadFinalizeInput): Promise<ReceptionUploadFinalizeResult>;
  delete(input: ReceptionUploadIdInput): Promise<{ deleted: boolean }>;
  /** TTL + orphan reaper. Reception shares the sweep with the webclient
   *  consumer (one table, one scratch root); exposed for tests + future
   *  dedicated registration. */
  sweepExpired(input?: { now?: number; limit?: number }): Promise<{ reaped: number; orphans: number }>;
}

export interface CreateReceptionUploadServiceOptions {
  /** Per-pair SQLite handle — backs the shared `upload_session` store. */
  readonly db: Database.Database;
  /** Per-pair CAS BlobStore (must be streaming-capable / `putFile`). */
  readonly blobs: BlobStore;
  /** Shared resumable scratch tree (the webclient consumer's `upload_blobs`
   *  data-volume sibling of the CAS). One root for the one shared core/table. */
  readonly uploadsRoot: string;
  /** Finalize target — the `reception_drop_blob_metadata` store the existing
   *  single-POST tail + the D-172 P3 drop drain already share. */
  readonly dropBlobStore: DropBlobStore;
  /** Registry — loads the per-endpoint `DropLinkConfig` (size cap / allowlist /
   *  visitor-field requirements / daily cap / `link_kind`) at create + finalize. */
  readonly getStore: () => PublicEndpointRegistryStore;
  /** The shared single-use form-nonce store (same instance the GET render +
   *  single-POST use) — `create` consumes the nonce as the admission gate. */
  readonly getDropLinkNonceStore: () => DropLinkNonceStore;
  /** Drop-blob PII AEAD key (derived from the reception sub-DEK) — seals the
   *  visitor fields at finalize, exactly as the single-POST path does. */
  readonly getDropBlobPiiKey: () => Uint8Array;
  /** D-120 audit emitter — the signed `drop_blob.received` row at finalize. */
  readonly auditLog: AuditLogStore;
  /** § Must Hold I-5 — drop the visitor-facing registry-cache entry when a
   *  `one_time` link self-revokes on a clean finalize (mirrors the single-POST
   *  hook). Absent ⇒ rely on the 60s staleness ceiling. */
  readonly invalidateRegistryCache?: (endpoint_id: string) => void;
  /** Injectable clock (tests). Production omits it. */
  readonly now?: () => number;
  readonly log?: (level: 'info' | 'warn', msg: string, data?: unknown) => void;
  /** Test seam to make `upload_id`s deterministic. */
  readonly mintUploadId?: () => string;
  /** Override the session TTL (tests inject a short window; production uses the
   *  shared default). */
  readonly ttlMs?: number;
  /** Override the minimum NON-FINAL chunk size (tests inject a tiny floor so
   *  small-chunk fixtures stay fast; production uses `MIN_RECEPTION_CHUNK_BYTES`
   *  to bound the per-upload fsync count). */
  readonly minChunkBytes?: number;
}

/** Map a validation failure → the persisted processing outcome (matches the
 *  single-POST `outcomeFromFailure`). */
const outcomeFromFailure = (
  f: DropLinkUploadValidationFailure,
): DropLinkProcessingOutcome => {
  switch (f.code) {
    case 'size_cap_exceeded':
      return 'rejected_size';
    case 'mime_type_not_allowed':
      return 'rejected_mime';
    case 'filename_invalid':
      return 'rejected_filename';
    case 'visitor_email_domain_rejected':
      return 'rejected_domain';
    default:
      return 'failed';
  }
};

export const createReceptionUploadService = (
  options: CreateReceptionUploadServiceOptions,
): ReceptionUploadService => {
  const {
    db,
    blobs,
    uploadsRoot,
    dropBlobStore,
    getStore,
    getDropLinkNonceStore,
    getDropBlobPiiKey,
    auditLog,
    log,
  } = options;
  const nowOf = (): number => options.now?.() ?? Date.now();
  const minChunkBytes = options.minChunkBytes ?? MIN_RECEPTION_CHUNK_BYTES;

  const store: UploadSessionStore = createUploadSessionStore(db);

  const loadConfig = (endpoint_id: string): DropLinkConfig | null => {
    const row = getStore().findById(endpoint_id);
    if (!row) return null;
    return parseDropLinkConfig(row.metadata);
  };

  /** Reception finalize: the EXISTING single-POST tail. The scratch is already
   *  content-addressed in the CAS by the core's `putFile` (so `content_hash`
   *  IS the CAS key); this seals the visitor PII, runs the validator +
   *  magic-byte/MIME cross-check over the captured head, persists ONE
   *  `reception_drop_blob_metadata` row (the drain reacts to `pending`), emits
   *  the signed audit row, and self-revokes a `one_time` link on a clean upload.
   *
   *  IDEMPOTENT (the core re-runs the policy if a prior finalize threw after
   *  `putFile`): `blob_id` is DERIVED from `upload_id` (deterministic, unique),
   *  and an existing row short-circuits to success so the core reaps the
   *  session instead of double-inserting. */
  const finalize = async (
    input: UploadFinalizeInput,
  ): Promise<ReceptionUploadFinalizeRecord> => {
    const { session, content_hash, size_bytes, head_bytes } = input;
    const at = nowOf();
    const endpoint_id = session.scope_key;
    const blob_id = `drop_resumable_${session.upload_id}`;

    // Idempotent `one_time` self-revoke on a CLEAN upload — factored out so BOTH
    // the first finalize AND a retry that finds the row already persisted close
    // the link. Re-attemptable: a crash between the metadata insert and the
    // revoke must not leave the `one_time` link live (registry revoke is
    // idempotent). Gated on `outcome === 'pending'` so a rejected upload doesn't
    // burn the link.
    const revokeIfOneTime = (
      outcome: DropLinkProcessingOutcome,
      config: DropLinkConfig | null,
    ): void => {
      if (outcome === 'pending' && config?.link_kind === 'one_time') {
        try {
          getStore().revoke({ endpoint_id, now: at, reason: 'one_time_drop_consumed' });
          options.invalidateRegistryCache?.(endpoint_id);
        } catch {
          /* swallow — blob persisted */
        }
      }
    };

    // Idempotent retry short-circuit — a prior finalize already persisted this
    // row (crash after insert, before the core reaped the session). Re-run the
    // interruptible side effect (the `one_time` revoke may not have happened)
    // then return its outcome so the core reaps the session + scratch (no
    // double-insert / no duplicate audit).
    const existing = dropBlobStore.findById(blob_id);
    if (existing) {
      revokeIfOneTime(existing.processing_outcome, loadConfig(endpoint_id));
      return {
        blob_id,
        outcome: existing.processing_outcome,
        content_hash,
        size_bytes,
      };
    }

    const visitor = (input.finalize_context ?? {}) as ReceptionUploadFinalizeContext;
    const config = loadConfig(endpoint_id);

    const filename_sanitized = sanitizeFilename(session.filename);
    const detected = detectMagicBytes(head_bytes);
    const reported = session.mime_reported;
    const magicMismatch =
      detected === null || (reported.length > 0 && detected !== reported);

    // Determine the processing outcome. Without a config (endpoint revoked
    // between create + finalize — unreachable in practice, the dispatcher 410s
    // a revoked endpoint at verify) we can't validate, so record `failed`.
    let outcome: DropLinkProcessingOutcome = 'pending';
    let failures: ReadonlyArray<DropLinkUploadValidationFailure> = [];
    if (!config) {
      outcome = 'failed';
    } else if (filename_sanitized === null) {
      outcome = 'rejected_filename';
    } else {
      const uploadInput: DropLinkUploadInput = {
        ...(visitor.visitor_name ? { visitor_name: visitor.visitor_name } : {}),
        ...(visitor.visitor_email ? { visitor_email: visitor.visitor_email } : {}),
        ...(visitor.visitor_description
          ? { visitor_description: visitor.visitor_description }
          : {}),
        mime_type_reported: reported,
        filename: filename_sanitized,
        size_bytes,
      };
      failures = validateDropLinkUpload(uploadInput, config);
      if (failures.length > 0) {
        outcome = outcomeFromFailure(failures[0]!);
      } else if (magicMismatch) {
        outcome = 'rejected_mime';
      }
    }

    // Seal the visitor PII (AAD bound to (endpoint_id, blob_id, field)).
    const key = getDropBlobPiiKey();
    const [
      visitor_email_encrypted,
      visitor_name_encrypted,
      visitor_description_encrypted,
    ] = await Promise.all([
      sealDropBlobPiiField({
        key,
        endpoint_id,
        blob_id,
        field: 'visitor_email',
        plaintext: visitor.visitor_email ?? null,
      }),
      sealDropBlobPiiField({
        key,
        endpoint_id,
        blob_id,
        field: 'visitor_name',
        plaintext: visitor.visitor_name ?? null,
      }),
      sealDropBlobPiiField({
        key,
        endpoint_id,
        blob_id,
        field: 'visitor_description',
        plaintext: visitor.visitor_description ?? null,
      }),
    ]);

    // Persist the metadata row regardless of outcome (the Abuse Inbox reads
    // rejected outcomes; the drain reactive trigger fires only on `pending`).
    // `storage_path` = the CAS hash, exactly as the single-POST path stores it.
    dropBlobStore.insert({
      blob_id,
      endpoint_id,
      uploaded_at: at,
      source_ip_hash: null, // the dispatcher access-log carries the per-IP hash
      visitor_email_encrypted,
      visitor_name_encrypted,
      visitor_description_encrypted,
      filename_sanitized: filename_sanitized ?? '(rejected)',
      mime_type_reported: reported,
      mime_type_detected: detected ?? '',
      size_bytes,
      content_hash,
      storage_path: content_hash,
      scan_status: 'unscanned',
      processing_outcome: outcome,
    });

    // Signed `drop_blob.received` audit row (one per upload). Deterministic
    // `activity_id` (no wall-clock) so a finalize retry doesn't double-log.
    // Best-effort — an audit failure must not block the row / the response.
    try {
      await auditLog.logActivity({
        activity_id: `drop_blob.received-${blob_id}`,
        timestamp: at,
        action: 'drop_blob.received',
        target: endpoint_id,
        detail: JSON.stringify({
          blob_id,
          processing_outcome: outcome,
          content_hash,
          size_bytes,
          mime_type_reported: reported,
          mime_type_detected: detected,
          transport: 'resumable',
        }),
        reserve: true,
      });
    } catch {
      /* swallow — row persisted */
    }

    // `one_time` self-revoke on a CLEAN upload (validation passed + magic-byte
    // match) so the visitor can't reload for a fresh nonce + upload again.
    revokeIfOneTime(outcome, config);

    return { blob_id, outcome, content_hash, size_bytes };
  };

  const core: UploadChunkCore<ReceptionUploadFinalizeRecord> = createUploadChunkCore({
    store,
    blobs,
    uploadsRoot,
    policy: { finalize },
    ...(options.now ? { now: options.now } : {}),
    ...(options.mintUploadId ? { mintUploadId: options.mintUploadId } : {}),
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    ...(log ? { log } : {}),
  });

  /** Scope-ownership gate — the session must exist AND belong to this drop-link
   *  endpoint. A miss returns null; callers map that to a non-leaking
   *  "not found" so a wrong-endpoint caller can't tell "absent" from "not
   *  yours". */
  const ownedSession = (
    upload_id: string,
    endpoint_id: string,
  ): UploadSession | null => {
    const s = store.get(upload_id);
    if (!s || s.scope_kind !== 'reception' || s.scope_key !== endpoint_id) return null;
    return s;
  };

  return {
    async create(input) {
      const now = input.now ?? nowOf();
      const config = loadConfig(input.endpoint_id);
      if (!config) return { status: 'rejected', reason: 'not_configured' };

      // Per-endpoint daily cap — counts COMPLETED uploads (the store's
      // `countWithinWindow` excludes `rejected_*` outcomes), so churn of
      // abandoned sessions doesn't consume a visitor's legit daily quota (it
      // DOES burn the concurrent-session + pending-bytes budget, which the
      // sweeper frees). Checked BEFORE the nonce is consumed (cheap, no side
      // effect) so a capped endpoint doesn't burn the visitor's nonce.
      const dayCount = dropBlobStore.countWithinWindow({
        endpoint_id: input.endpoint_id,
        window_start_at: now - DAY_MS,
        now,
      });
      if (dayCount >= config.max_uploads_per_endpoint_per_day) {
        return { status: 'rejected', reason: 'daily_cap' };
      }

      // Single-use form-nonce (CSRF + admission). Consumed before `core.create`
      // so a replay never even allocates a session. A later core rejection
      // (concurrent / pending cap) burns the nonce — rare + self-healing (the
      // visitor reloads for a fresh one).
      if (!getDropLinkNonceStore().consume(input.endpoint_id, input.form_nonce, now)) {
        return { status: 'rejected', reason: 'invalid_nonce' };
      }

      const result = await core.create({
        scope_kind: 'reception',
        scope_key: input.endpoint_id,
        filename: input.filename,
        declared_size: input.declared_size,
        mime_reported: input.mime_reported,
        size_cap_bytes: config.size_cap_bytes,
        ...(input.fingerprint !== undefined ? { fingerprint: input.fingerprint } : {}),
        ...(input.source_ip_hash !== undefined
          ? { source_ip_hash: input.source_ip_hash }
          : {}),
        now,
      });
      if (result.ok) return { status: 'created', upload_id: result.upload_id };
      return {
        status: 'rejected',
        reason: result.reason,
        ...(result.detail !== undefined ? { detail: result.detail } : {}),
      };
    },

    probe(input) {
      if (!ownedSession(input.upload_id, input.endpoint_id)) {
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

    async chunk(input) {
      const session = ownedSession(input.upload_id, input.endpoint_id);
      if (!session) {
        return { ok: false, reason: 'forbidden' };
      }
      // Per-upload WORK bound: reject a sub-minimum NON-FINAL chunk so the
      // limiter-bypassing data plane can't be turned into `declared_size` tiny
      // fsync writes. The final chunk (offset + len === declared_size) is exempt
      // (the remainder is legitimately small); a 0-byte chunk falls through to
      // the core's `empty_chunk`.
      const len = input.bytes.length;
      const isFinalChunk = input.expected_offset + len === session.declared_size;
      if (len > 0 && len < minChunkBytes && !isFinalChunk) {
        return { ok: false, reason: 'chunk_too_small' };
      }
      const r = await core.chunk({
        upload_id: input.upload_id,
        expected_offset: input.expected_offset,
        bytes: input.bytes,
        ...(input.checksum !== undefined ? { checksum: input.checksum } : {}),
        ...(input.now !== undefined ? { now: input.now } : {}),
      });
      if (r.ok) return { ok: true, offset: r.offset, complete: r.complete };
      if (r.reason === 'offset_conflict') {
        return { ok: false, reason: 'offset_conflict', offset: r.offset };
      }
      return { ok: false, reason: r.reason };
    },

    async finalize(input) {
      if (!ownedSession(input.upload_id, input.endpoint_id)) {
        return { status: 'gone', reason: 'not_found' };
      }
      const r = await core.finalize({
        upload_id: input.upload_id,
        finalize_context: input.visitor_fields,
        ...(input.now !== undefined ? { now: input.now } : {}),
      });
      if (r.ok) {
        return {
          status: 'finalized',
          outcome: r.result.outcome,
          blob_id: r.result.blob_id,
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
      if (!ownedSession(input.upload_id, input.endpoint_id)) {
        return { deleted: false };
      }
      const r = await core.delete(input.upload_id);
      return { deleted: r.ok };
    },

    async sweepExpired(input) {
      const r = await core.sweepExpired(input);
      return { reaped: r.reaped, orphans: r.orphans };
    },
  };
};

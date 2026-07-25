/** D-172 step 5a — resumable drop-link upload HTTP transport.
 *
 *  The reception consumer's DATA + CONTROL plane is plain HTTP (rev 5: a visitor
 *  on a page the server itself renders, at a server-controlled origin — unlike
 *  the webclient's binary `/ws/upload` socket). This module is the thin HTTP
 *  layer over `ReceptionUploadService`: it parses each request shape, calls the
 *  service, and maps the service's discriminated result onto a status code +
 *  JSON body. All the safety-critical mechanics live in the shared chunk-core
 *  (via the service); this layer is transport-only.
 *
 *  URL space (mounted by the reception dispatcher under the existing drop-link
 *  prefix, alongside the JS-free single-POST `<form>` which stays the no-JS
 *  fallback):
 *
 *    POST   /reception/drop/<endpoint_id>/uploads                    create
 *    GET    /reception/drop/<endpoint_id>/uploads/<upload_id>        probe (resume)
 *    POST   /reception/drop/<endpoint_id>/uploads/<upload_id>        chunk
 *    POST   /reception/drop/<endpoint_id>/uploads/<upload_id>/finalize  finalize
 *    DELETE /reception/drop/<endpoint_id>/uploads/<upload_id>        delete
 *
 *  The bearer (`?t=`) + the unguessable `upload_id` are the capability; the
 *  dispatcher has already verified the bearer + endpoint state + (for create)
 *  the per-IP rate limit before this runs. Same-origin is re-checked here on
 *  every state-changing verb (CSRF defense-in-depth, mirroring the single-POST).
 *
 *  Spec: internal design notes. */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { DropLinkProcessingOutcome } from '@recued/contracts';

import { writeJson } from '../../common/respond.js';
import { UPLOAD_CHUNK_MAX_BYTES } from '../../../storage/upload-session-store.js';
import type {
  ReceptionUploadFinalizeContext,
  ReceptionUploadService,
} from '../../../upload/reception-upload-service.js';
import type { ReceptionEndpointContext } from '../redacted-packet.js';
import { verifyReceptionSameOrigin } from './same-origin.js';

/** Max bytes of a control-plane JSON body (create / finalize). The shapes are a
 *  handful of small fields; anything larger is malformed / hostile. */
const MAX_JSON_BODY_BYTES = 64 * 1024;

/** The five resumable verbs, classified by the dispatcher from the method +
 *  the upload sub-path. */
export type ReceptionUploadOp = 'create' | 'probe' | 'chunk' | 'finalize' | 'delete';

export interface DropUploadDispatchInput {
  readonly endpoint: ReceptionEndpointContext;
  readonly op: ReceptionUploadOp;
  /** The `<upload_id>` path segment — `null` only for `create`. */
  readonly upload_id: string | null;
  /** Endpoint-scoped source-IP hash (persisted onto the session for forensics). */
  readonly source_ip_hash: string | null;
  /** Fire the verified-mutation warehouse arrival — called ONCE per upload, on a
   *  CLEAN finalize (so reactive recipes see one upload, not N chunks). */
  readonly emitArrival: () => void;
}

export interface DropUploadHandlerDeps {
  readonly getService: () => ReceptionUploadService;
  /** Trust `X-Forwarded-Proto` for the same-origin scheme check — true only
   *  behind a trusted proxy (the dispatcher's `trustForwardedFor` toggle). */
  readonly trustForwardedProto?: boolean;
}

// ────────────────────────────────────────────────────────────────
// Body readers
// ────────────────────────────────────────────────────────────────

type BodyReadResult =
  | { readonly ok: true; readonly body: Buffer }
  | { readonly ok: false; readonly reason: 'too_large' | 'stream_error' };

const readBody = (req: IncomingMessage, maxBytes: number): Promise<BodyReadResult> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const fail = (reason: 'too_large' | 'stream_error'): void => {
      if (done) return;
      done = true;
      req.removeAllListeners('data');
      resolve({ ok: false, reason });
    };
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > maxBytes) {
        req.pause();
        fail('too_large');
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve({ ok: true, body: Buffer.concat(chunks) });
    });
    req.on('error', () => fail('stream_error'));
    req.on('aborted', () => fail('stream_error'));
  });

const parseJsonObject = (buf: Buffer): Record<string, unknown> | null => {
  if (buf.length === 0) return {};
  try {
    const parsed = JSON.parse(buf.toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};

// ────────────────────────────────────────────────────────────────
// Result → status mappers
// ────────────────────────────────────────────────────────────────

/** Create rejection reason → HTTP status. */
const createRejectStatus = (
  reason:
    | 'not_configured'
    | 'invalid_nonce'
    | 'daily_cap'
    | 'invalid_declared_size'
    | 'size_cap_exceeded'
    | 'too_many_sessions'
    | 'pending_bytes_exceeded'
    | 'rejected',
): number => {
  switch (reason) {
    case 'not_configured':
      return 503;
    case 'invalid_nonce':
    case 'invalid_declared_size':
    case 'rejected':
      return 400;
    case 'size_cap_exceeded':
      return 413;
    case 'daily_cap':
    case 'too_many_sessions':
    case 'pending_bytes_exceeded':
      return 429;
  }
};

/** Chunk failure reason → HTTP status (offset_conflict handled separately). */
const chunkErrorStatus = (
  reason:
    | 'not_found'
    | 'expired'
    | 'empty_chunk'
    | 'chunk_too_large'
    | 'chunk_too_small'
    | 'overflow'
    | 'checksum_mismatch'
    | 'scratch_missing'
    | 'forbidden',
): number => {
  switch (reason) {
    case 'not_found':
    case 'forbidden': // wrong endpoint → 404, no existence leak
      return 404;
    case 'expired':
    case 'scratch_missing':
      return 410;
    case 'empty_chunk':
    // A sub-minimum non-final chunk — the client must coalesce into a larger
    // chunk (the open-surface per-upload fsync-work bound). Client error.
    case 'chunk_too_small':
      return 400;
    case 'chunk_too_large':
    case 'overflow':
      return 413;
    case 'checksum_mismatch':
      return 422;
  }
};

/** A finalize that persisted a REJECTED outcome → the matching 4xx (mirrors the
 *  single-POST 413 / 415 / 400 rejection surface). `pending` is the accepted
 *  case (handled by the caller). */
const rejectedOutcomeStatus = (outcome: DropLinkProcessingOutcome): number => {
  switch (outcome) {
    case 'rejected_size':
      return 413;
    case 'rejected_mime':
      return 415;
    case 'rejected_filename':
    case 'rejected_domain':
      return 400;
    default:
      return 422; // 'failed' / any other non-pending
  }
};

// ────────────────────────────────────────────────────────────────
// Handler
// ────────────────────────────────────────────────────────────────

export const createDropUploadHandler = (
  deps: DropUploadHandlerDeps,
): ((req: IncomingMessage, res: ServerResponse, input: DropUploadDispatchInput) => Promise<void>) => {
  const trustForwardedProto = deps.trustForwardedProto === true;

  return async (req, res, input) => {
    const endpoint_id = input.endpoint.endpoint_id;
    if (!endpoint_id) {
      writeJson(res, 503, { error: { code: 'not_configured' } });
      return;
    }
    const service = deps.getService();

    // CSRF defense-in-depth — same-origin on every state-changing verb (probe
    // is a read-only GET).
    if (input.op !== 'probe' && !verifyReceptionSameOrigin(req, trustForwardedProto)) {
      writeJson(res, 403, { error: { code: 'forbidden_origin' } });
      return;
    }

    // upload_id is required for every verb except create.
    if (input.op !== 'create' && (!input.upload_id || input.upload_id.length === 0)) {
      writeJson(res, 400, { error: { code: 'bad_request' } });
      return;
    }
    const upload_id = input.upload_id ?? '';

    // ── create ──────────────────────────────────────────────────
    if (input.op === 'create') {
      const read = await readBody(req, MAX_JSON_BODY_BYTES);
      if (!read.ok) {
        writeJson(res, read.reason === 'too_large' ? 413 : 400, {
          error: { code: read.reason },
        });
        return;
      }
      const body = parseJsonObject(read.body);
      if (
        !body ||
        typeof body.filename !== 'string' ||
        typeof body.declared_size !== 'number' ||
        typeof body.mime_reported !== 'string' ||
        typeof body.form_nonce !== 'string'
      ) {
        writeJson(res, 400, { error: { code: 'bad_request' } });
        return;
      }
      const result = await service.create({
        endpoint_id,
        filename: body.filename,
        declared_size: body.declared_size,
        mime_reported: body.mime_reported,
        form_nonce: body.form_nonce,
        ...(typeof body.fingerprint === 'string' ? { fingerprint: body.fingerprint } : {}),
        source_ip_hash: input.source_ip_hash,
      });
      if (result.status === 'created') {
        writeJson(res, 201, { upload_id: result.upload_id, offset: 0 });
        return;
      }
      writeJson(res, createRejectStatus(result.reason), {
        error: { code: result.reason },
      });
      return;
    }

    // ── probe (resume) ──────────────────────────────────────────
    if (input.op === 'probe') {
      const url = new URL(req.url ?? '/', 'http://x');
      const filename = url.searchParams.get('filename');
      const declaredRaw = url.searchParams.get('declared_size');
      const declared_size = declaredRaw === null ? NaN : Number(declaredRaw);
      if (filename === null || !Number.isFinite(declared_size)) {
        writeJson(res, 400, { error: { code: 'bad_request' } });
        return;
      }
      const fingerprint = url.searchParams.get('fingerprint');
      const r = service.probe({
        endpoint_id,
        upload_id,
        filename,
        declared_size,
        ...(fingerprint !== null ? { fingerprint } : {}),
      });
      if (r.resumable) {
        writeJson(res, 200, { offset: r.offset, complete: r.complete });
        return;
      }
      const status = r.reason === 'expired' ? 410 : r.reason === 'file_mismatch' ? 409 : 404;
      writeJson(res, status, { error: { code: r.reason } });
      return;
    }

    // ── chunk ───────────────────────────────────────────────────
    if (input.op === 'chunk') {
      const offsetRaw = req.headers['upload-offset'];
      const expected_offset =
        typeof offsetRaw === 'string' ? Number(offsetRaw) : NaN;
      if (!Number.isSafeInteger(expected_offset) || expected_offset < 0) {
        writeJson(res, 400, { error: { code: 'bad_offset' } });
        return;
      }
      const checksumRaw = req.headers['upload-checksum'];
      const checksum = typeof checksumRaw === 'string' && checksumRaw.length > 0 ? checksumRaw : undefined;

      const read = await readBody(req, UPLOAD_CHUNK_MAX_BYTES);
      if (!read.ok) {
        // An over-cap body is a too-large chunk; a stream fault is a 400.
        writeJson(res, read.reason === 'too_large' ? 413 : 400, {
          error: { code: read.reason === 'too_large' ? 'chunk_too_large' : 'stream_error' },
        });
        return;
      }
      const r = await service.chunk({
        endpoint_id,
        upload_id,
        expected_offset,
        bytes: read.body,
        ...(checksum !== undefined ? { checksum } : {}),
      });
      if (r.ok) {
        writeJson(res, 200, { offset: r.offset, complete: r.complete });
        return;
      }
      if (r.reason === 'offset_conflict') {
        // 409 carrying the real persisted offset so a stale client re-syncs.
        writeJson(res, 409, { error: { code: 'offset_conflict' }, offset: r.offset });
        return;
      }
      writeJson(res, chunkErrorStatus(r.reason), { error: { code: r.reason } });
      return;
    }

    // ── finalize ────────────────────────────────────────────────
    if (input.op === 'finalize') {
      const read = await readBody(req, MAX_JSON_BODY_BYTES);
      if (!read.ok) {
        writeJson(res, read.reason === 'too_large' ? 413 : 400, {
          error: { code: read.reason },
        });
        return;
      }
      const body = parseJsonObject(read.body);
      if (!body) {
        writeJson(res, 400, { error: { code: 'bad_request' } });
        return;
      }
      const visitor_fields: ReceptionUploadFinalizeContext = {
        ...(typeof body.visitor_name === 'string' ? { visitor_name: body.visitor_name } : {}),
        ...(typeof body.visitor_email === 'string' ? { visitor_email: body.visitor_email } : {}),
        ...(typeof body.visitor_description === 'string'
          ? { visitor_description: body.visitor_description }
          : {}),
      };
      const r = await service.finalize({ endpoint_id, upload_id, visitor_fields });
      if (r.status === 'finalized') {
        if (r.outcome === 'pending') {
          // Accepted — ring the verified-mutation doorbell ONCE (the drain
          // materializes `data.file.received` off the persisted row).
          input.emitArrival();
          writeJson(res, 200, { status: 'accepted', blob_id: r.blob_id });
          return;
        }
        // Persisted but rejected (magic-byte / size / filename / domain) — the
        // row stays for the Abuse Inbox; surface the matching 4xx.
        writeJson(res, rejectedOutcomeStatus(r.outcome), { error: { code: r.outcome } });
        return;
      }
      if (r.status === 'pending') {
        writeJson(res, 409, { error: { code: 'incomplete' }, offset: r.offset });
        return;
      }
      writeJson(res, r.reason === 'expired' ? 410 : 404, { error: { code: r.reason } });
      return;
    }

    // ── delete ──────────────────────────────────────────────────
    // op === 'delete'. A miss / wrong-endpoint returns `deleted: false` (no
    // existence leak) at 200 — the explicit cancel is best-effort.
    const r = await service.delete({ endpoint_id, upload_id });
    writeJson(res, 200, { deleted: r.deleted });
  };
};

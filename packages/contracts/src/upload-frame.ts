/** D-172 resumable uploads — webclient transport contract (shared wire format).
 *
 *  The webclient WS rpc channel is text-JSON only (binary frames are dropped by
 *  design), so the chunk BYTES travel a DEDICATED binary `/ws/upload` socket
 *  while the control plane (create / probe / finalize / delete) rides the typed
 *  rpc registry. This module is the single source of truth for BOTH halves of
 *  the binary path: the client encodes a chunk frame, the server decodes it, and
 *  the server acks with a small JSON text frame. Pure `Uint8Array` / `DataView`
 *  / `TextEncoder` so it runs unchanged in the browser PWA and in node.
 *
 *  Frame layout (client -> server, ONE binary WS frame per chunk):
 *
 *    byte 0          version           (UPLOAD_FRAME_VERSION)
 *    byte 1          type              (UPLOAD_FRAME_TYPE_CHUNK)
 *    bytes 2..6      header length     (uint32, big-endian)
 *    bytes 6..6+H    header            (UTF-8 JSON: UploadChunkFrameHeader)
 *    bytes 6+H..     chunk payload     (raw bytes, appended at `offset`)
 *
 *  The header carries the routing + integrity fields (upload_id, offset,
 *  optional per-chunk sha256). The capability is the connection's verified
 *  bearer (the socket is authenticated at upgrade) PLUS the unguessable
 *  `upload_id`; the server additionally checks the session's scope ownership.
 *
 *  Ack (server -> client) is a JSON TEXT frame (`UploadChunkAck`) correlated by
 *  `req_id`. A frame the server cannot even parse acks as `upload_error` (no
 *  `req_id` to echo).
 *
 *  Spec: `recued-project/handovers/handover_drop_resumable_upload_design.md`. */

export const UPLOAD_FRAME_VERSION = 1;
export const UPLOAD_FRAME_TYPE_CHUNK = 1;

/** The fixed prefix before the JSON header: version + type + uint32 length. */
export const UPLOAD_FRAME_HEADER_OFFSET = 6;

/** Hard ceiling on the JSON header length — the header is a handful of small
 *  fields; anything larger is a malformed / hostile frame, rejected before the
 *  `TextDecoder` runs. */
export const UPLOAD_FRAME_MAX_HEADER_BYTES = 4096;

/** Routing + integrity header carried in every chunk frame. */
export interface UploadChunkFrameHeader {
  /** Client-minted correlation id; the ack echoes it. */
  readonly req_id: string;
  /** The session capability (256-bit hex) minted by `upload.create`. */
  readonly upload_id: string;
  /** Byte offset this chunk appends at — must equal the persisted offset. */
  readonly offset: number;
  /** Optional sha256 (hex) of the chunk payload — mismatch -> retry in place. */
  readonly checksum?: string;
}

export interface DecodedUploadChunkFrame extends UploadChunkFrameHeader {
  /** Zero-copy view into the source buffer (the trailing payload bytes). */
  readonly bytes: Uint8Array;
}

export type UploadFrameDecodeError =
  | 'too_short'
  | 'bad_version'
  | 'bad_type'
  | 'bad_header_len'
  | 'bad_header_json'
  | 'missing_field';

export type UploadFrameDecodeResult =
  | { readonly ok: true; readonly frame: DecodedUploadChunkFrame }
  | { readonly ok: false; readonly reason: UploadFrameDecodeError };

/** Ack sent back over the SAME binary socket as a JSON text frame. `upload_ack`
 *  is correlated by `req_id`; `upload_error` is the un-correlatable case (a
 *  frame so malformed there is no trustworthy `req_id` to echo). */
export type UploadChunkAck =
  | {
      readonly type: 'upload_ack';
      readonly req_id: string;
      readonly ok: true;
      readonly offset: number;
      readonly complete: boolean;
    }
  | {
      readonly type: 'upload_ack';
      readonly req_id: string;
      readonly ok: false;
      /** Mirrors the chunk-core / scope reasons (offset_conflict carries the
       *  real persisted offset so a stale client re-syncs without re-creating). */
      readonly reason:
        | 'not_found'
        | 'expired'
        | 'empty_chunk'
        | 'chunk_too_large'
        | 'overflow'
        | 'checksum_mismatch'
        | 'scratch_missing'
        | 'offset_conflict'
        | 'forbidden';
      readonly offset?: number;
    }
  | {
      readonly type: 'upload_error';
      readonly reason: UploadFrameDecodeError;
    };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Encode one chunk frame (client side). `bytes` is appended verbatim. */
export const encodeUploadChunkFrame = (
  header: UploadChunkFrameHeader,
  bytes: Uint8Array,
): Uint8Array => {
  const headerJson = textEncoder.encode(JSON.stringify(header));
  const out = new Uint8Array(UPLOAD_FRAME_HEADER_OFFSET + headerJson.length + bytes.length);
  out[0] = UPLOAD_FRAME_VERSION;
  out[1] = UPLOAD_FRAME_TYPE_CHUNK;
  new DataView(out.buffer).setUint32(2, headerJson.length, false);
  out.set(headerJson, UPLOAD_FRAME_HEADER_OFFSET);
  out.set(bytes, UPLOAD_FRAME_HEADER_OFFSET + headerJson.length);
  return out;
};

/** Decode one chunk frame (server side). Never throws — a malformed frame
 *  returns `{ ok: false, reason }` so the caller acks an `upload_error` instead
 *  of tearing down the socket. */
export const decodeUploadChunkFrame = (buf: Uint8Array): UploadFrameDecodeResult => {
  if (buf.length < UPLOAD_FRAME_HEADER_OFFSET) return { ok: false, reason: 'too_short' };
  if (buf[0] !== UPLOAD_FRAME_VERSION) return { ok: false, reason: 'bad_version' };
  if (buf[1] !== UPLOAD_FRAME_TYPE_CHUNK) return { ok: false, reason: 'bad_type' };

  const headerLen = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(2, false);
  if (
    headerLen === 0 ||
    headerLen > UPLOAD_FRAME_MAX_HEADER_BYTES ||
    UPLOAD_FRAME_HEADER_OFFSET + headerLen > buf.length
  ) {
    return { ok: false, reason: 'bad_header_len' };
  }

  const headerBytes = buf.subarray(UPLOAD_FRAME_HEADER_OFFSET, UPLOAD_FRAME_HEADER_OFFSET + headerLen);
  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(headerBytes));
  } catch {
    return { ok: false, reason: 'bad_header_json' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, reason: 'bad_header_json' };
  }
  const h = parsed as Record<string, unknown>;
  if (
    typeof h.req_id !== 'string' ||
    typeof h.upload_id !== 'string' ||
    typeof h.offset !== 'number' ||
    !Number.isSafeInteger(h.offset) ||
    h.offset < 0 ||
    (h.checksum !== undefined && typeof h.checksum !== 'string')
  ) {
    return { ok: false, reason: 'missing_field' };
  }

  const bytes = buf.subarray(UPLOAD_FRAME_HEADER_OFFSET + headerLen);
  return {
    ok: true,
    frame: {
      req_id: h.req_id,
      upload_id: h.upload_id,
      offset: h.offset,
      ...(h.checksum !== undefined ? { checksum: h.checksum as string } : {}),
      bytes,
    },
  };
};

// ────────────────────────────────────────────────────────────────
// Control-plane rpc shapes (text JSON over the existing webclient WS rpc).
// `scope_key` is NEVER in the payload — the server resolves it from the
// verified bearer (`WsClient.token_instance_id`), so one client can't author
// another's scope. Business outcomes are in-band discriminated unions (the
// client switches on them); the handler throws `RpcError` only for unauthorized
// / not_configured / internal.
// ────────────────────────────────────────────────────────────────

export interface UploadCreateRpcRequest {
  readonly filename: string;
  readonly declared_size: number;
  readonly mime_reported: string;
  readonly fingerprint?: string | null;
}

export type UploadCreateRpcResponse =
  | { readonly status: 'created'; readonly upload_id: string }
  | {
      readonly status: 'rejected';
      readonly reason:
        | 'invalid_declared_size'
        | 'size_cap_exceeded'
        | 'too_many_sessions'
        | 'pending_bytes_exceeded'
        // M5 S3 — live free disk can't fit the declared upload plus headroom
        // (archive restore's statfs pre-flight; other consumers never emit it).
        | 'insufficient_disk'
        | 'rejected';
      readonly detail?: string;
    };

export interface UploadProbeRpcRequest {
  readonly upload_id: string;
  readonly filename: string;
  readonly declared_size: number;
  readonly fingerprint?: string | null;
}

export type UploadProbeRpcResponse =
  | { readonly resumable: true; readonly offset: number; readonly complete: boolean }
  | { readonly resumable: false; readonly reason: 'not_found' | 'expired' | 'file_mismatch' };

export interface UploadFinalizeRpcRequest {
  readonly upload_id: string;
}

export type UploadFinalizeRpcResponse =
  | {
      readonly status: 'finalized';
      readonly record_id: string;
      readonly content_hash: string;
      readonly size_bytes: number;
    }
  | { readonly status: 'pending'; readonly reason: 'incomplete'; readonly offset: number }
  | { readonly status: 'gone'; readonly reason: 'not_found' | 'expired' };

export interface UploadDeleteRpcRequest {
  readonly upload_id: string;
}

export interface UploadDeleteRpcResponse {
  readonly deleted: boolean;
}

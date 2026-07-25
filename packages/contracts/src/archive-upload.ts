/** M4b.1 — archive-upload control-plane contract (no-SSH migrate: upload → stage).
 *
 *  The other half of M4a's browser download. A no-SSH user restores by UPLOADING
 *  a `.recued.archive` to the server, which STAGES it to a server-disk path the
 *  existing `server.archive.import` then consumes (the M4b.0 streaming importer
 *  never holds the whole archive in RAM).
 *
 *  Transport reuses D-172's resumable machinery WHOLESALE: the chunk BYTES ride a
 *  dedicated binary `/ws/archive-upload` socket as `UploadChunkFrame`s (the SAME
 *  generic `upload-frame.ts` wire format the webclient/reception consumers use —
 *  the frame is pure transport, blind to the finalize policy), while this
 *  control plane (create / probe / finalize / delete) rides the typed rpc
 *  registry as `server.archive.upload.*`.
 *
 *  Where it DIFFERS from `upload.*` (webclient): finalize does NOT ingest a
 *  `data.file.received` warehouse row — it STAGES the assembled archive to
 *  `<data>/exports/` under a non-generated name (so the export GC + the download
 *  socket both ignore it) and returns that `staged_name` for `server.archive.import`
 *  to resolve. Owner-only (recovery-key-gated at import); off MCP by catalog
 *  omission, exactly like the sibling `server.archive.{export,status,import}`. */

// ────────────────────────────────────────────────────────────────
// Control-plane rpc shapes (text JSON over the existing webclient WS rpc).
// `scope_key` is NEVER in the payload — the server resolves it from the verified
// bearer (`WsClient.token_instance_id`), so one client can't author another's
// scope. Business outcomes are in-band discriminated unions; the handler throws
// `RpcError` only for unauthorized / not_configured / internal. The chunk frame
// + ack reuse `UploadChunkFrame` / `UploadChunkAck` from `upload-frame.ts`.
// ────────────────────────────────────────────────────────────────

export interface ArchiveUploadCreateRpcRequest {
  /** Display name the client is uploading (advisory — the staged name is
   *  server-minted; this only rides the session for resume identity). */
  readonly filename: string;
  /** Total archive byte length — the offset-as-truth completion target. */
  readonly declared_size: number;
  /** Optional head/tail fingerprint so a stale resume can't append into the
   *  wrong scratch (same identity binding as `upload.create`). */
  readonly fingerprint?: string | null;
}

export type ArchiveUploadCreateRpcResponse =
  | { readonly status: 'created'; readonly upload_id: string }
  | {
      readonly status: 'rejected';
      readonly reason:
        | 'invalid_declared_size'
        | 'size_cap_exceeded'
        | 'too_many_sessions'
        | 'pending_bytes_exceeded'
        // M5 S3 — live free disk can't fit the declared archive plus the
        // restore's unpack/swap headroom; refused at create, before any bytes.
        | 'insufficient_disk'
        | 'rejected';
      readonly detail?: string;
    };

export interface ArchiveUploadProbeRpcRequest {
  readonly upload_id: string;
  readonly filename: string;
  readonly declared_size: number;
  readonly fingerprint?: string | null;
}

export type ArchiveUploadProbeRpcResponse =
  | { readonly resumable: true; readonly offset: number; readonly complete: boolean }
  | { readonly resumable: false; readonly reason: 'not_found' | 'expired' | 'file_mismatch' };

export interface ArchiveUploadFinalizeRpcRequest {
  readonly upload_id: string;
}

export type ArchiveUploadFinalizeRpcResponse =
  | {
      readonly status: 'finalized';
      /** Basename of the staged archive under `<data>/exports/`. Pass it as
       *  `server.archive.import`'s `path` — `resolveImportPath` resolves a
       *  relative name under `exports/`. NEVER a generated export slot name
       *  (`isGeneratedExportName` is false for it), so the export GC + the
       *  `/ws/download` socket both leave it alone. */
      readonly staged_name: string;
      readonly size_bytes: number;
    }
  | { readonly status: 'pending'; readonly reason: 'incomplete'; readonly offset: number }
  | { readonly status: 'gone'; readonly reason: 'not_found' | 'expired' };

export interface ArchiveUploadDeleteRpcRequest {
  readonly upload_id: string;
}

export interface ArchiveUploadDeleteRpcResponse {
  readonly deleted: boolean;
}

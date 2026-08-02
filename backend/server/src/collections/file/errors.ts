/** Phase 7 — file-adapter error taxonomy.
 *
 *  Raw errors from the underlying transport (Node fs `ENOENT`,
 *  `EACCES`, `ENOSPC`; S3 `NoSuchKey`, `AccessDenied`, HTTP 5xx;
 *  extension download API rejections) get classified at the adapter
 *  boundary into a narrow, recipe-visible shape so the dispatcher
 *  can map cleanly onto `RpcError` codes without knowing the
 *  underlying transport.
 *
 *  Four codes cover the cases recipes need to distinguish:
 *
 *    not_found         The specific record isn't present (distinct
 *                      from FILE_INSTANCE_NOT_FOUND which is about
 *                      the slug). `file-read` / `file-delete` /
 *                      `file-move` raise this; `file-stat` swallows
 *                      it into `{ exists: false }`.
 *    permission_denied The backing store rejected the op with a
 *                      permission-shaped error (EACCES / 403). The
 *                      caps check already rejects at a higher layer;
 *                      this covers *runtime* permission drift — a
 *                      probe passed at enroll but ACLs tightened
 *                      since.
 *    too_large         Body exceeds the adapter's v1 ceiling
 *                      (currently: S3 5 MB non-multipart).
 *    io_error          Everything else — network glitch, disk full
 *                      (ENOSPC), malformed response, etc. Callers
 *                      surface this as a generic "transient adapter
 *                      error" that recipes can retry.
 */

export type FileAdapterErrorCode =
  | 'not_found'
  | 'permission_denied'
  | 'too_large'
  | 'io_error';

export class FileAdapterError extends Error {
  constructor(
    public readonly code: FileAdapterErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'FileAdapterError';
  }
}

/** Classify a Node fs/promises error (`ENOENT`, `EACCES`, ...) into
 *  the typed `FileAdapterError` the dispatcher expects. Unknown codes
 *  collapse to `io_error` — we prefer a coarse-grained fallback over
 *  misclassification. */
export const classifyNodeFsError = (err: unknown, path: string): FileAdapterError => {
  if (!(err instanceof Error)) {
    return new FileAdapterError('io_error', `file op failed for '${path}': ${String(err)}`, err);
  }
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') {
    return new FileAdapterError('not_found', `file not found: ${path}`, err);
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new FileAdapterError(
      'permission_denied',
      `file operation refused by filesystem for '${path}' (${code})`,
      err,
    );
  }
  if (code === 'EISDIR' || code === 'ENOTDIR') {
    return new FileAdapterError(
      'io_error',
      `path '${path}' is the wrong kind (${code})`,
      err,
    );
  }
  if (code === 'ENOSPC') {
    return new FileAdapterError(
      'io_error',
      `filesystem out of space while writing '${path}'`,
      err,
    );
  }
  return new FileAdapterError(
    'io_error',
    `file op failed for '${path}': ${err.message}`,
    err,
  );
};

/** Classify an S3Error-shaped failure. We read `err.code` (AWS
 *  error code) first, then the HTTP status as a fallback. */
export const classifyS3Error = (err: unknown, path: string): FileAdapterError => {
  if (!(err instanceof Error)) {
    return new FileAdapterError('io_error', `s3 op failed for '${path}': ${String(err)}`, err);
  }
  const anyErr = err as { code?: string; status?: number };
  const code = anyErr.code ?? '';
  const status = anyErr.status ?? 0;
  if (code === 'NoSuchKey' || code === 'NoSuchBucket' || status === 404) {
    return new FileAdapterError('not_found', `s3 object not found: ${path}`, err);
  }
  if (code === 'AccessDenied' || status === 403 || status === 401) {
    return new FileAdapterError('permission_denied', `s3 refused access to '${path}'`, err);
  }
  if (code === 'TOO_LARGE' || code === 'EntityTooLarge') {
    return new FileAdapterError('too_large', err.message, err);
  }
  return new FileAdapterError('io_error', `s3 op failed for '${path}': ${err.message}`, err);
};

/** Narrow runtime check so the dispatcher can recognize errors
 *  adapters threw deliberately vs. unexpected throws that deserve
 *  a 500. */
export const isFileAdapterError = (err: unknown): err is FileAdapterError =>
  err instanceof Error && err.name === 'FileAdapterError';

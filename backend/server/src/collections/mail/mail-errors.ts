/** D-239 — mail write-back dispatcher error helpers.
 *
 *  The sibling of `collections/calendar/errors.ts`, deliberately the same
 *  shape so a reader of either follows one vocabulary. Two layers land here:
 *
 *  1. Instance / access gate (pre-adapter), raised by the dispatcher:
 *     - MAIL_INSTANCE_NOT_FOUND    (collection_not_found) slug not enrolled.
 *     - MAIL_MUTATION_UNSUPPORTED  (forbidden)  the grant / client cannot
 *                                               mutate message state.
 *     - MAIL_RECORD_NOT_FOUND      (not_found)  no such warehouse row.
 *
 *  2. Adapter runtime, from `MailAdapterError`: the mapping table below.
 *
 *  ⛔ `io_error` IS THE ONE THAT MATTERS. It means the mutation's outcome is
 *  UNKNOWN — it may have landed at the provider — so the warehouse is never
 *  written on it and the next sync tick reconciles reality. Every other code
 *  is a definite answer. A recipe that must tell "definitely failed" from
 *  "might have worked" gates on `MAIL_IO_ERROR` explicitly in `fail_on`;
 *  collapsing the two would make a mark-read safe to retry and a move not,
 *  with nothing in the error to say which one you got.
 */

import { RpcError } from '@recued/contracts';
import { MailAdapterError, type MailAdapterErrorCode } from '@recued/contracts';

/** Type guard. Prefers `instanceof` but falls back to the structural `name`
 *  check, so an error that crossed a boundary preserving data-but-not-
 *  prototypes still classifies. Mirrors `isCalendarAdapterError`. */
export const isMailAdapterError = (err: unknown): err is MailAdapterError => {
  if (err instanceof MailAdapterError) return true;
  return (
    !!err
    && typeof err === 'object'
    && (err as { name?: unknown }).name === 'MailAdapterError'
  );
};

const ADAPTER_ERROR_MAP: Record<
  MailAdapterErrorCode,
  { rpcCode: string; userCode: string; status: number }
> = {
  message_not_found: {
    rpcCode: 'not_found',
    userCode: 'MAIL_MESSAGE_NOT_FOUND',
    status: 404,
  },
  folder_not_found: {
    rpcCode: 'bad_request',
    userCode: 'MAIL_FOLDER_NOT_FOUND',
    status: 400,
  },
  permission_denied: {
    rpcCode: 'forbidden',
    userCode: 'MAIL_PERMISSION_DENIED',
    status: 403,
  },
  quota_exceeded: {
    rpcCode: 'quota_exceeded',
    userCode: 'MAIL_QUOTA_EXCEEDED',
    status: 429,
  },
  auth_expired: {
    rpcCode: 'unauthorized',
    userCode: 'MAIL_AUTH_EXPIRED',
    status: 401,
  },
  io_error: {
    rpcCode: 'upstream_error',
    userCode: 'MAIL_IO_ERROR',
    status: 502,
  },
};

/** Translate a `MailAdapterError` into the dispatcher's `RpcError`. The
 *  message keeps the slug + verb so a log reader sees which call failed
 *  without walking the stack. */
export const mailAdapterErrorToRpc = (
  err: MailAdapterError,
  slug: string,
  verb: string,
): RpcError => {
  const mapped = ADAPTER_ERROR_MAP[err.code];
  return new RpcError(
    mapped.rpcCode,
    `${mapped.userCode}: ${verb} on mail instance '${slug}' failed — ${err.message}`,
    mapped.status,
  );
};

/** Run an adapter call and classify `MailAdapterError`.
 *
 *  ⚠ A non-`MailAdapterError` throw is a BUG, not a provider outcome, and is
 *  rethrown unchanged so the rpc layer turns it into a 500. Do not widen this
 *  to catch everything: an adapter that throws a raw `TypeError` after
 *  mutating would then be reported as a clean typed failure, and the
 *  warehouse would stay unwritten on a change that landed. The providers each
 *  wrap their own transport failures into `io_error` precisely so that
 *  ambiguity is expressed rather than swallowed here. */
export const callMailAdapter = async <T>(
  slug: string,
  verb: string,
  fn: () => Promise<T>,
): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    if (isMailAdapterError(err)) throw mailAdapterErrorToRpc(err, slug, verb);
    throw err;
  }
};

export { MailAdapterError };

/** The kernel and deferred review use the same concrete mail-send payload.
 * This is pure normalization; it does not grant access, read files or send. */
import { RpcError } from '../rpc/types.js';
import { isMailReconciliationId } from '../mail.js';
import { isTempFileRef, type TempFileRef } from '../ingredient-catalog.js';

export interface NormalizedMailSend {
  instance: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body_text: string;
  body_html?: string;
  in_reply_to?: string;
  references?: string[];
  reply_to?: string;
  reconciliation_id?: string;
  /** ⛔⛔ A DURABLE RECORD ID, OR A RUN-SCOPED TEMP REF — AND THE DIFFERENCE IS
   *  THE LIFECYCLE, not a flag the sender sets.
   *
   *  A `file:<32 hex>` id names something the owner KEEPS: it is read, sent, and
   *  never touched. A `TempFileRef` names bytes the caller produced IN THIS RUN
   *  purely in order to send them: they are read, sent, and reclaimed with the
   *  run scratch. Nothing durable is created, so there is nothing to delete and
   *  no destructive authority anywhere on this path.
   *
   *  🔑 WHY THE TYPE AND NOT A `{ file, cleanup_after }` FLAG. A flag is the
   *  CALLER asserting "you may destroy this", which is authority on the wire. A
   *  recipe can enumerate the owner's whole `received` warehouse (`file-list`
   *  takes a caller-supplied slug) and would then be able to name any file of
   *  theirs as disposable — destroying it under the SEND's `write` risk tier
   *  instead of `destructive`'s `always` approval floor. A temp ref cannot be
   *  forged that way: `readConfinedTempFile` confines it to the producing run's
   *  scratch root, so the caller can only ever name bytes it just made. */
  attachments?: (string | TempFileRef)[];
  /** Required only when `attachments` carries a `TempFileRef` — the scratch-root
   *  confinement for reading it back. Threaded from `StepMeta.run_id`. */
  run_id?: string;
}

export const normalizeMailSend = (input: Record<string, unknown>): NormalizedMailSend => {
  const bad = (message: string): never => { throw new RpcError('BAD_INPUT', `mail-send: ${message}`, 400); };
  const strings = (value: unknown, name: string): string[] => typeof value === 'string' ? [value]
    : Array.isArray(value) && value.every(item => typeof item === 'string') ? [...value]
      : bad(`${name} must be a string or array of strings`);
  if (typeof input.sender_mail_instance !== 'string' || !input.sender_mail_instance.length) bad('sender_mail_instance is required');
  const to = strings(input.to, 'to');
  if (!to.length) bad('to must contain at least one recipient');
  if (typeof input.subject !== 'string') bad('subject is required');
  if (typeof input.body !== 'string') bad('body is required');
  const result: NormalizedMailSend = { instance: input.sender_mail_instance as string,
    to, subject: input.subject as string, body_text: input.body_format === 'html' ? '' : input.body as string };
  if (input.body_format === 'html') result.body_html = input.body as string;
  for (const key of ['cc', 'bcc', 'references'] as const) {
    if (input[key] !== undefined && input[key] !== null) {
      const entries = strings(input[key], key); if (entries.length) result[key] = entries;
    }
  }
  for (const key of ['in_reply_to', 'reply_to'] as const) {
    if (typeof input[key] === 'string' && input[key].length) result[key] = input[key];
  }
  if (input.reconciliation_id !== undefined && input.reconciliation_id !== null) {
    if (!isMailReconciliationId(input.reconciliation_id)) bad('reconciliation_id must be a bounded ASCII header token');
    result.reconciliation_id = input.reconciliation_id as string;
  }
  if (input.attachments !== undefined && input.attachments !== null) {
    const raw = Array.isArray(input.attachments) ? input.attachments : [input.attachments];
    const attachments = raw.map((item) => {
      if (typeof item === 'string') return item;
      if (isTempFileRef(item)) return item;
      return bad('attachments must be record-id strings or run-scoped temp file_refs');
    });
    if (attachments.length) result.attachments = attachments;
  }
  return result;
};

/** The kernel and deferred review use the same concrete mail-send payload.
 * This is pure normalization; it does not grant access, read files or send. */
import { RpcError } from '../rpc/types.js';
import { isMailReconciliationId } from '../mail.js';

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
  attachments?: string[];
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
    const attachments = strings(input.attachments, 'attachments');
    if (attachments.length) result.attachments = attachments;
  }
  return result;
};

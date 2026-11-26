import { RpcError } from './rpc/types.js';
import { canonicalizeEmail, parseAddress } from './contact.js';
import { readMailFollowUpTaskContinuation, type MailFollowUpTaskContinuation } from './mail-follow-up-task.js';
import { readMailFollowUpWaitingFor, type MailFollowUpWaitingFor } from './mail-follow-up-recipient.js';

/** A local preference. It never authorizes sending an email. */
export interface MailFollowUpPreference { after_ms: number; notify_on_reply?: boolean; continue_task?: MailFollowUpTaskContinuation; waiting_for?: MailFollowUpWaitingFor }
export interface MailFollowUpSendRequest extends MailFollowUpPreference { request_id: string }
export type MailFollowUpSendState = 'awaiting_send' | 'awaiting_approval' | 'awaiting_sync' | 'needs_attention' | 'not_sent' | 'armed' | 'cancelled';
export interface MailFollowUpSendIntent {
  id: string; revision: number; subject: string; mailbox: string;
  after_ms: number; notify_on_reply?: boolean; waiting_for?: MailFollowUpWaitingFor; state: MailFollowUpSendState;
  created_at: number; updated_at: number; run_id?: string; watch_id?: string; detail?: string;
  future_execution_ref?: string; scheduled_for?: number;
}
export const mailFollowUpRecipientReason = (to: readonly string[], cc: readonly string[], account: string): string | null => {
  const address = (raw: string) => canonicalizeEmail(parseAddress(raw)?.email ?? '');
  const own = address(account), recipients = new Set([...to, ...cc].map(address).filter(value => value && value !== own));
  return recipients.size === 0 ? 'Choose a To or Cc recipient other than the sending mailbox for a reply watch.'
    : recipients.size > 20 ? 'Reply watches support up to 20 To and Cc recipients. Turn off the watch to send to a larger group.' : null;
};
export const parseMailFollowUpPreference = (raw: unknown): MailFollowUpPreference => {
  const value = raw as Record<string, unknown> | null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['after_ms', 'notify_on_reply', 'continue_task', 'waiting_for'].includes(key))
    || !Number.isSafeInteger(value.after_ms) || (value.after_ms as number) < 3600_000 || (value.after_ms as number) > 30 * 86400000
    || value.notify_on_reply !== undefined && typeof value.notify_on_reply !== 'boolean'
    || value.continue_task !== undefined && !readMailFollowUpTaskContinuation(value.continue_task)
    || value.waiting_for !== undefined && !readMailFollowUpWaitingFor(value.waiting_for))
    throw new RpcError('bad_request', 'Choose a reply check between one hour and thirty days after sending.', 400);
  return { after_ms: value.after_ms as number, ...(value.notify_on_reply === true ? { notify_on_reply: true } : {}),
    ...(value.continue_task !== undefined ? { continue_task: readMailFollowUpTaskContinuation(value.continue_task)! } : {}),
    ...(value.waiting_for !== undefined ? { waiting_for: readMailFollowUpWaitingFor(value.waiting_for)! } : {}) };
};

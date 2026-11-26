/** Owner-selected watches over one retained sent message and its mailbox thread. */
import type { ReminderMailReference } from './reminder.js';

export const MAIL_FOLLOW_UP_STATES = ['waiting', 'needs_attention', 'draft_ready', 'delivery_failed', 'replied', 'superseded', 'cancelled'] as const;
export type MailFollowUpState = typeof MAIL_FOLLOW_UP_STATES[number];
export const MAIL_FOLLOW_UP_LABELS: Record<MailFollowUpState, string> = {
  waiting: 'Waiting for a reply', needs_attention: 'Needs attention', draft_ready: 'Draft ready for review',
  delivery_failed: 'Delivery failed', replied: 'Reply received', superseded: 'A newer email was sent', cancelled: 'Cancelled',
};
export const mailFollowUpLabel = (watch: MailFollowUp): string =>
  watch.state === 'delivery_failed' && watch.delivery_failure ? `Delivery failed for ${watch.delivery_failure.recipient}` : watch.state === 'waiting' && watch.draft_id ? 'Follow-up snoozed' : MAIL_FOLLOW_UP_LABELS[watch.state];
export interface MailFollowUpFilters { state?: MailFollowUpState; mailbox?: string }
export const parseMailFollowUpFilters = (raw: unknown): MailFollowUpFilters | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== 'state' && key !== 'mailbox')
    || value.state !== undefined && !MAIL_FOLLOW_UP_STATES.includes(value.state as MailFollowUpState)
    || value.mailbox !== undefined && (typeof value.mailbox !== 'string' || !value.mailbox.trim() || value.mailbox.length > 128)) return null;
  return { ...(value.state !== undefined ? { state: value.state as MailFollowUpState } : {}),
    ...(typeof value.mailbox === 'string' ? { mailbox: value.mailbox.trim() } : {}) };
};
export interface MailFollowUp {
  id: string;
  revision: number;
  mail_ref: ReminderMailReference;
  subject: string;
  check_at: number;
  /** Alert cycle. Absent on watches created before time changes were supported. */
  schedule_version?: number;
  state: MailFollowUpState;
  created_at: number;
  updated_at: number;
  checked_at?: number;
  detail?: string;
  reply_record_id?: string;
  reply_ref?: ReminderMailReference;
  notify_on_reply?: boolean;
  draft_id?: string;
  task_ref?: import('./mail-follow-up-task.js').MailFollowUpTaskRef;
  task_link_version?: number;
  waiting_for?: import('./mail-follow-up-recipient.js').MailFollowUpWaitingFor;
  other_reply_count?: number;
  automatic_reply_count?: number;
  replacement_draft_id?: string;
  delivery_failure?: MailFollowUpDeliveryFailure;
}
export interface MailFollowUpDeliveryFailure {
  recipient: string;
  status: string;
  reason?: string;
  report_ref: ReminderMailReference;
}
export const mailFollowUpAutomaticReplyNotice = (watch: MailFollowUp): string | null => (watch.automatic_reply_count ?? 0) > 0
  && !watch.delivery_failure && ['waiting', 'needs_attention', 'draft_ready'].includes(watch.state)
  ? `Automatic reply received. Still waiting for ${watch.waiting_for?.address ?? 'a recipient reply'}.` : null;
export interface MailFollowUpStart {
  creation_id: string;
  mail_ref: ReminderMailReference;
  check_at: number;
  notify_on_reply?: boolean;
  waiting_for?: import('./mail-follow-up-recipient.js').MailFollowUpWaitingFor;
}
export interface MailFollowUpReplyTarget { watch: MailFollowUp; mail_ref: ReminderMailReference }
export interface MailFollowUpReplyNotification { id: string; expected_revision: number; enabled: boolean }
export interface MailFollowUpGet { eligible: boolean; reason?: string; watch: MailFollowUp | null; recipients?: string[] }
export interface MailFollowUpReschedule {
  id: string;
  expected_revision: number;
  request_id: string;
  check_at: number;
}
export interface MailFollowUpCursor { updated_at: number; id: string }
export interface MailFollowUpPage {
  watches: MailFollowUp[]; next_cursor: MailFollowUpCursor | null;
  /** Only the unfiltered Mail manager includes pending compose requests. */
  pending_sends?: import('./mail-follow-up-send.js').MailFollowUpSendIntent[];
}
export interface MailFollowUpList extends MailFollowUpFilters {
  cursor?: MailFollowUpCursor;
  query?: string;
  limit?: number;
  /** Today: due waiting checks, ready drafts, and watches needing attention. */
  attention_at?: number;
}
/** Text matching happens after decryption; clients also verify the returned
 * scope so an older server cannot silently ignore new search filters. */
export const matchesMailFollowUp = (watch: MailFollowUp, request: MailFollowUpList): boolean => {
  if (request.state && request.state !== watch.state || request.mailbox && request.mailbox !== watch.mail_ref.slug) return false;
  if (request.attention_at !== undefined && !(watch.state === 'draft_ready' || watch.state === 'needs_attention' || watch.state === 'delivery_failed'
    || watch.state === 'waiting' && watch.check_at <= request.attention_at)) return false;
  const fold = (text: string) => text.normalize('NFKC').toLowerCase();
  const text = fold([watch.subject, watch.mail_ref.slug, watch.state.replaceAll('_', ' '), mailFollowUpLabel(watch), watch.delivery_failure?.recipient ?? '', watch.delivery_failure?.reason ?? ''].join(' '));
  return fold(request.query ?? '').split(/\s+/u).filter(Boolean).every(term => text.includes(term));
};

const WATCH_ID = /^mfw_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DRAFT_ID = /^mad_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface MailFollowUpAddress { id: string; draft_id?: string; schedule_version?: number; open_reply?: true; open_report?: true; edit_time?: true }
/** An owner link carries identities, never email content or permission to send. */
export const parseMailFollowUpAddress = (segments: readonly string[]): MailFollowUpAddress | null => {
  if (segments[0] !== 'reply-watch' || !WATCH_ID.test(segments[1] ?? '')) return null;
  if (segments.length === 2) return { id: segments[1]! };
  if (segments.length === 3 && segments[2] === 'report') return { id: segments[1]!, open_report: true };
  if (segments.length === 3 && segments[2] === 'reply') return { id: segments[1]!, open_reply: true };
  if (segments.length === 3 && segments[2] === 'time') return { id: segments[1]!, edit_time: true };
  if (segments[2] !== 'draft' || !DRAFT_ID.test(segments[3] ?? '')) return null;
  const address = { id: segments[1]!, draft_id: segments[3]! };
  if (segments.length === 4) return address;
  const version = Number(segments[5]);
  return segments.length === 6 && segments[4] === 'cycle' && /^[1-9][0-9]*$/.test(segments[5] ?? '') && Number.isSafeInteger(version)
    ? { ...address, schedule_version: version } : null;
};
export const mailFollowUpHref = (id: string, draftId?: string, version = 0): string => {
  const segments = ['reply-watch', id, ...(draftId ? ['draft', draftId] : []), ...(version !== 0 ? ['cycle', String(version)] : [])];
  if (!parseMailFollowUpAddress(segments)) throw new Error('Invalid reply watch link.');
  return '#mail/' + segments.join('/');
};
export const isMailFollowUpLink = (value: string): boolean => {
  if (!value.startsWith('#mail/')) return false;
  return parseMailFollowUpAddress(value.slice('#mail/'.length).split('/')) !== null;
};
export const mailFollowUpReplyHref = (id: string): string => mailFollowUpHref(id) + '/reply';
export const mailFollowUpTimeHref = (id: string): string => mailFollowUpHref(id) + '/time';

export const mailFollowUpReportHref = (id: string): string => mailFollowUpHref(id) + '/report';

export interface MailFollowUpReplacementCreate { id: string; expected_revision: number; request_id: string }

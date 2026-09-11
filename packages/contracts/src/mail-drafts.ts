/** Local saved drafts. None of these methods sends, schedules or approves. */
import { RpcError } from './rpc/types.js';
import { normalizeMailSend } from './mail-compose/normalize.js';
import { MAIL_MESSAGE_SUBJECT_MAX } from './mail.js';
import { PREAPPROVAL_LIMITS, parsePreapprovalJson, type PreapprovalJson } from './preapproval.js';

export type MailDraftContent = Record<string, PreapprovalJson> & {
  sender_mail_instance: string; to: string[]; subject: string; body: string; body_format: 'text' | 'html';
};
export interface MailDraft {
  draft_id: string; incarnation: string; revision: number; content: MailDraftContent;
  origin_contract_id: string | null; created_at: number; updated_at: number;
}
export type MailDraftSummary = Omit<MailDraft, 'content'> & { subject: string; sender_mail_instance: string };
export interface MailDraftCreateRequest { idempotency_key: string; content: MailDraftContent }
export interface MailDraftUpdateRequest { draft_id: string; expected_revision: number; content: MailDraftContent }
export interface MailDraftDeleteRequest { draft_id: string; expected_revision: number }
export type MailDraftErrorCode = 'mail_draft_not_found' | 'mail_draft_stale' | 'mail_draft_conflict';
const bad = (message: string): never => { throw new RpcError('BAD_INPUT', message, 400); };
const object = (value: unknown, keys: string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    return bad('Invalid saved draft fields.');
  }
  return value as Record<string, unknown>;
};
export const parseMailDraftId = (value: unknown): string => typeof value === 'string'
  && /^mad_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) ? value : bad('Invalid saved draft ID.');
const revision = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
  ? value : bad('The current draft revision is required.');
export const parseMailDraftContent = (value: unknown): MailDraftContent => {
  const raw = object(value, ['sender_mail_instance', 'to', 'cc', 'bcc', 'subject', 'body', 'body_format',
    'in_reply_to', 'references', 'reply_to', 'reconciliation_id', 'attachments']);
  parsePreapprovalJson(raw);
  if (raw.body_format !== undefined && raw.body_format !== 'text' && raw.body_format !== 'html') bad('Body format must be text or html.');
  const normalized = normalizeMailSend(raw);
  if (normalized.subject.length > MAIL_MESSAGE_SUBJECT_MAX) bad('The draft subject is too long.');
  const content: MailDraftContent = { sender_mail_instance: normalized.instance, to: normalized.to, subject: normalized.subject,
    body: normalized.body_html ?? normalized.body_text, body_format: normalized.body_html !== undefined ? 'html' : 'text' };
  for (const key of ['cc', 'bcc', 'in_reply_to', 'references', 'reply_to', 'reconciliation_id', 'attachments'] as const) {
    if (normalized[key] !== undefined) content[key] = normalized[key]!;
  }
  if (new TextEncoder().encode(JSON.stringify(content)).length > PREAPPROVAL_LIMITS.plan_bytes) bad('The saved draft is too large for review.');
  return content;
};
export const parseMailDraftCreate = (value: unknown): MailDraftCreateRequest => {
  const row = object(value, ['idempotency_key', 'content']);
  if (typeof row.idempotency_key !== 'string' || !row.idempotency_key.length || row.idempotency_key.length > 128) bad('A draft save request key is required.');
  return { idempotency_key: row.idempotency_key as string, content: parseMailDraftContent(row.content) };
};
export const parseMailDraftGet = (value: unknown): { draft_id: string } => {
  const row = object(value, ['draft_id']); return { draft_id: parseMailDraftId(row.draft_id) };
};
export const parseMailDraftUpdate = (value: unknown): MailDraftUpdateRequest => {
  const row = object(value, ['draft_id', 'expected_revision', 'content']);
  return { draft_id: parseMailDraftId(row.draft_id), expected_revision: revision(row.expected_revision), content: parseMailDraftContent(row.content) };
};
export const parseMailDraftDelete = (value: unknown): MailDraftDeleteRequest => {
  const row = object(value, ['draft_id', 'expected_revision']);
  return { draft_id: parseMailDraftId(row.draft_id), expected_revision: revision(row.expected_revision) };
};
export const parseMailDraftList = (value: unknown): { cursor: string; limit: number } => {
  const row = object(value ?? {}, ['cursor', 'limit']); const limit = row.limit ?? 25;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) bad('Draft page limit must be 1 to 100.');
  return { cursor: row.cursor === undefined ? '' : parseMailDraftId(row.cursor), limit: limit as number };
};

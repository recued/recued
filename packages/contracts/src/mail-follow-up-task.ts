import type { MailFollowUp } from './mail-follow-up.js';
import type { WorkEntity } from './work-entities.js';

export interface MailFollowUpTaskRef { id: string; source_id: string; source_record_id?: string; created_at: number }
export const readMailFollowUpTaskRef = (raw: unknown): MailFollowUpTaskRef | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !['id', 'source_id', 'source_record_id', 'created_at'].includes(key))
    || typeof value.id !== 'string' || !value.id || value.id.length > 2048 || typeof value.source_id !== 'string' || !value.source_id || value.source_id.length > 2048
    || value.source_record_id !== undefined && (typeof value.source_record_id !== 'string' || !value.source_record_id || value.source_record_id.length > 4096)
    || !Number.isSafeInteger(value.created_at)) return null;
  return { id: value.id, source_id: value.source_id, ...(typeof value.source_record_id === 'string' ? { source_record_id: value.source_record_id } : {}), created_at: value.created_at as number };
};
export const mailFollowUpTaskRef = (entity: WorkEntity): MailFollowUpTaskRef | null => entity._kind === 'task'
  ? readMailFollowUpTaskRef({ id: entity.id, source_id: entity.source_id, ...(entity.source_record_id ? { source_record_id: entity.source_record_id } : {}), created_at: entity.created_at }) : null;
export const sameMailFollowUpTaskRef = (a: MailFollowUpTaskRef, b: MailFollowUpTaskRef): boolean =>
  a.id === b.id && a.source_id === b.source_id && a.source_record_id === b.source_record_id && a.created_at === b.created_at;
export interface MailFollowUpTaskSet { id: string; expected_revision: number; request_id: string; task_id: string | null }
/** One owner-reviewed local task, created together with its watch link. */
export interface MailFollowUpTaskCreate {
  id: string; expected_revision: number; request_id: string; title: string; due_on?: string;
  /** Current webclient page without credentials, query, or fragment. */
  client_url: string;
}
export interface MailFollowUpTaskView {
  available: boolean; watch: MailFollowUp;
  can_create?: boolean;
  task: { ref: MailFollowUpTaskRef; title: string; done: boolean } | null;
  reason?: string;
}
export interface MailFollowUpTaskLinks {
  available: boolean;
  links: Array<{ task_ref: MailFollowUpTaskRef; watch: MailFollowUp }>;
  unavailable: MailFollowUpTaskRef[];
}

/** The exact task association accepted with a one-off follow-up send. Watch
 * checks do not advance link_version; changing or clearing its task does. Delivery failure retires older selections. */
export interface MailFollowUpTaskContinuation {
  watch_id: string; draft_id: string; task_ref: MailFollowUpTaskRef; link_version: number; task_hash: string;
  /** Explicit replacement draft, bound to the verified failure. Ordinary follow-ups omit this. */
  replacement_hash?: string;
}
export interface MailFollowUpTaskContext {
  available: boolean; selection: MailFollowUpTaskContinuation | null; title?: string; reason?: string;
}
export const readMailFollowUpTaskContinuation = (raw: unknown): MailFollowUpTaskContinuation | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>, ref = readMailFollowUpTaskRef(value.task_ref);
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  if (Object.keys(value).some(key => !['watch_id', 'draft_id', 'task_ref', 'link_version', 'task_hash', 'replacement_hash'].includes(key))
    || typeof value.watch_id !== 'string' || !new RegExp('^mfw_' + uuid + '$').test(value.watch_id)
    || typeof value.draft_id !== 'string' || !new RegExp('^mad_' + uuid + '$').test(value.draft_id)
    || !ref || !Number.isSafeInteger(value.link_version) || (value.link_version as number) < 0
    || value.replacement_hash !== undefined && (typeof value.replacement_hash !== 'string' || !/^[0-9a-f]{64}$/.test(value.replacement_hash))
    || typeof value.task_hash !== 'string' || !/^[0-9a-f]{64}$/.test(value.task_hash)) return null;
  return { watch_id: value.watch_id, draft_id: value.draft_id, task_ref: ref, link_version: value.link_version as number, task_hash: value.task_hash, ...(typeof value.replacement_hash === 'string' ? { replacement_hash: value.replacement_hash } : {}) };
};

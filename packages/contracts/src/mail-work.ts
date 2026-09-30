/** Owner-led work reconstructed from mail. A brief is advice, never execution authority. */
export interface MailWorkEmailRef { slug: string; record_id: string }
export interface MailWorkThread {
  slug: string;
  thread_id: string | null;
  seed_record_id: string;
  subject: string;
}
export type MailWorkStatus = 'active' | 'resolved' | 'archived';
export const MAIL_WORK_CLAIM_KINDS = [
  'request', 'agreement', 'progress', 'dependency', 'question', 'next_action', 'completion_condition',
] as const;
export type MailWorkClaimKind = typeof MAIL_WORK_CLAIM_KINDS[number];
export interface MailWorkClaim {
  kind: MailWorkClaimKind;
  text: string;
  basis: 'email' | 'owner' | 'inference';
  evidence: MailWorkEmailRef[];
}
export interface MailWorkBrief {
  claims: MailWorkClaim[];
  search_queries: string[];
  warnings: string[];
  reviewed_at: number;
}
export interface MailWork {
  id: string;
  revision: number;
  title: string;
  goal: string;
  owner_notes: string;
  status: MailWorkStatus;
  resolution_note: string;
  threads: MailWorkThread[];
  brief: MailWorkBrief | null;
  reviewed_fingerprint: string | null;
  created_at: number;
  updated_at: number;
}
export interface MailWorkSource extends MailWorkEmailRef {
  subject: string;
  from: string;
  date: string;
  /** True when not present in the previous reviewed source set, or changed. */
  changed: boolean;
}
export interface MailWorkDetail {
  work: MailWork;
  /** A creation request found work already following the selected conversation. */
  existing_work?: boolean;
  investigation_started?: boolean;
  /** Stable Chat creation ID for this work, including work saved before Chat entry existed.
   * The ordinary chat.session.create RPC creates/resumes it on explicit entry. */
  chat_session_id: string;
  needs_review: boolean;
  sources: MailWorkSource[];
  warnings: string[];
}
export interface MailWorkSummary {
  id: string; title: string; status: MailWorkStatus; updated_at: number; needs_review: boolean;
}
export interface MailWorkCursor { updated_at: number; id: string }
export interface MailWorkListRequest { before?: MailWorkCursor; email?: MailWorkEmailRef }
export interface MailWorkListResult {
  works: MailWorkSummary[];
  next_cursor: MailWorkCursor | null;
  /** Confirms this server applied the exact email association filter. */
  matched_email?: MailWorkEmailRef;
}
export interface MailWorkCreateRequest {
  /** Stable across a retry, fresh for another matter in the same conversation. */
  request_id: string;
  email: MailWorkEmailRef;
  title?: string;
  goal?: string;
  /** Explicitly start another investigation in the same conversation. */
  separate?: boolean;
}
export interface MailWorkUpdateRequest {
  id: string;
  expected_revision: number;
  title?: string;
  goal?: string;
  owner_notes?: string;
  status?: MailWorkStatus;
  resolution_note?: string;
  link_email?: MailWorkEmailRef;
  unlink_thread?: MailWorkThread;
}
/** Removes the workbook and its reviewed-source data. The linked Chat is a
 * separate object; the owner deletes it in Chat. */
export interface MailWorkDeleteRequest { id: string; expected_revision: number }
export interface MailWorkDeleteResult { id: string; deleted: true }
export interface MailWorkSearchResult {
  emails: Array<MailWorkEmailRef & { subject: string; from: string; thread_id: string | null }>;
  warnings: string[];
}
export const MAIL_WORK_REVIEW_TIMEOUT_MS = 120_000;

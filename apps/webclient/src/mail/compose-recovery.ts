import { readStoredMailDraftContent, type MailComposeDialogState, type MailDraft, type MailDraftContent, type MailReplyContext } from '@recued/contracts';
import { readSelectedContactContext, type SelectedContactContext } from '../contacts/contact-context.js';

export interface MailRecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export type MailRecoveryStatus = 'editing' | 'pending' | 'unknown' | 'held' | 'review';
export interface MailRecoveryEntry {
  id: string;
  updatedAt: number;
  mailbox: { id: string; slug: string; email: string };
  dialog: Pick<MailComposeDialogState, 'mode' | 'values' | 'reply_all' | 'original_attachments_omitted'>;
  brief: string;
  replyContext: MailReplyContext | null;
  contactContext?: SelectedContactContext;
  copyRecipientsOpen: boolean;
  saved: MailDraft | null;
  prior?: MailDraftContent;
  status: MailRecoveryStatus;
  attempt?: string;
  proposalId?: string;
}
export const MAIL_RECOVERY_LIMITS = { entries: 8, entryBytes: 256 * 1024, bytes: 1024 * 1024, age: 7 * 86_400_000 } as const;
const PREFIX = 'recued.mail.compose-recovery.v1:';
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const string = (value: unknown, max = 100_000): value is string => typeof value === 'string' && value.length <= max;
const strings = (value: unknown, count = 100): value is string[] => Array.isArray(value) && value.length <= count && value.every(item => string(item, 2048));
const bytes = (value: string): number => new TextEncoder().encode(value).length;

/** Form checkpoints deliberately accept unfinished recipient text. They are
 * never accepted as a mail send payload or as a saved draft without the normal
 * compose validation, fresh mailbox check and governed execution path. */
export const parseMailRecovery = (value: unknown, now: number): MailRecoveryEntry | null => {
  const row = object(value), mailbox = object(row?.mailbox), dialog = object(row?.dialog), values = object(dialog?.values);
  if (!row || !mailbox || !dialog || !values || !string(row.id, 80) || !/^mcr_[0-9a-f-]{36}$/.test(row.id)
    || typeof row.updatedAt !== 'number' || !Number.isSafeInteger(row.updatedAt)
    || row.updatedAt < now - MAIL_RECOVERY_LIMITS.age || row.updatedAt > now + 60_000
    || !string(mailbox.id, 512) || !mailbox.id || !string(mailbox.slug, 512) || !mailbox.slug || !string(mailbox.email, 512) || !mailbox.email
    || !['create', 'reply', 'forward'].includes(String(dialog.mode)) || !['editing', 'pending', 'unknown', 'held', 'review'].includes(String(row.status))
    || !strings(values.to) || !strings(values.cc) || !strings(values.bcc) || !strings(values.attachments, 20)
    || !string(values.subject) || !string(values.body) || !string(values.sender_source, 512) || values.sender_source !== mailbox.id
    || values.in_reply_to !== null && !string(values.in_reply_to, 2048)
    || values.references !== undefined && !strings(values.references)
    || !string(row.brief, 16_000) || typeof row.copyRecipientsOpen !== 'boolean'
    || row.attempt !== undefined && !string(row.attempt, 80) || row.status !== 'editing' && !row.attempt
    || row.proposalId !== undefined && !string(row.proposalId, 512)) return null;
  let replyContext: MailReplyContext | null = null;
  if (row.replyContext !== null) {
    const context = object(row.replyContext), original = object(context?.original_message);
    if (!context || !original || context.original_source_id !== mailbox.id || !string(original.id, 2048)
      || original.id !== values.in_reply_to || !string(original.subject) || !string(original.from, 2048)
      || original.body !== undefined && !string(original.body)
      || original.body_truncated !== undefined && typeof original.body_truncated !== 'boolean'
      || context.mailbox_address !== undefined && (!string(context.mailbox_address, 512) || context.mailbox_address.trim().toLowerCase() !== mailbox.email)
      || ['to', 'cc', 'reply_to', 'references'].some(key => original[key] !== undefined && !strings(original[key]))) return null;
    replyContext = { original_source_id: mailbox.id, ...(context.mailbox_address ? { mailbox_address: context.mailbox_address as string } : {}),
      original_message: { id: original.id, subject: original.subject, from: original.from,
        ...(original.body !== undefined ? { body: original.body as string } : {}),
        ...(original.body_truncated !== undefined ? { body_truncated: original.body_truncated as boolean } : {}),
        ...Object.fromEntries(['to', 'cc', 'reply_to', 'references'].filter(key => original[key] !== undefined).map(key => [key, original[key]])) } };
  }
  let saved: MailDraft | null = null;
  let prior: MailDraftContent | undefined;
  if (row.prior !== undefined) {
    try { prior = readStoredMailDraftContent(row.prior); } catch { return null; }
    if (prior.sender_mail_instance !== mailbox.slug) return null;
  }
  if (row.saved !== null) {
    const draft = object(row.saved);
    if (!draft || !string(draft.draft_id, 80) || !string(draft.incarnation, 256) || !Number.isSafeInteger(draft.revision)
      || Number(draft.revision) < 1) return null;
    try {
      saved = { draft_id: draft.draft_id, incarnation: draft.incarnation, revision: Number(draft.revision),
        content: readStoredMailDraftContent(draft.content), origin_contract_id: null, created_at: 0, updated_at: 0 };
    } catch { return null; }
    if (saved.content.sender_mail_instance !== mailbox.slug) return null;
  }
  const contactContext = readSelectedContactContext(row.contactContext);
  const matchesContact = contactContext?.email && values.to.some(value => value.trim().toLowerCase() === contactContext.email!.trim().toLowerCase());
  return { id: row.id, updatedAt: row.updatedAt, mailbox: { id: mailbox.id, slug: mailbox.slug, email: mailbox.email },
    dialog: { mode: dialog.mode as MailComposeDialogState['mode'],
      ...(dialog.reply_all === true ? { reply_all: true } : {}),
      ...(dialog.original_attachments_omitted === true ? { original_attachments_omitted: true } : {}),
      values: { to: [...values.to], cc: [...values.cc], bcc: [...values.bcc], attachments: [...values.attachments],
        subject: values.subject, body: values.body, sender_source: values.sender_source, in_reply_to: values.in_reply_to as string | null,
        ...(values.references ? { references: [...values.references as string[]] } : {}) } },
    brief: row.brief, replyContext, ...(matchesContact ? { contactContext: contactContext! } : {}), copyRecipientsOpen: row.copyRecipientsOpen, saved, ...(prior ? { prior } : {}), status: row.status as MailRecoveryStatus,
    ...(row.attempt ? { attempt: row.attempt as string } : {}), ...(row.proposalId ? { proposalId: row.proposalId as string } : {}) };
};

export const createMailRecoveryStore = (opts: { scope: string; storage?: MailRecoveryStorage | null; now?: () => number }) => {
  const now = opts.now ?? Date.now, key = PREFIX + encodeURIComponent(opts.scope);
  let storage = opts.storage;
  if (storage === undefined) { try { storage = globalThis.sessionStorage; } catch { storage = null; } }
  const read = (): MailRecoveryEntry[] | null => {
    try {
      const raw = storage?.getItem(key); if (!raw) return [];
      if (bytes(raw) > MAIL_RECOVERY_LIMITS.bytes) return null;
      const value: unknown = JSON.parse(raw); if (!Array.isArray(value) || value.length > MAIL_RECOVERY_LIMITS.entries) return null;
      return value.map(item => bytes(JSON.stringify(item)) <= MAIL_RECOVERY_LIMITS.entryBytes ? parseMailRecovery(item, now()) : null)
        .filter((entry): entry is MailRecoveryEntry => entry !== null)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    } catch { return null; }
  };
  const list = (): MailRecoveryEntry[] => read() ?? [];
  const write = (entries: MailRecoveryEntry[]): boolean => {
    if (!storage) return false;
    try {
      const raw = JSON.stringify(entries);
      if (entries.length > MAIL_RECOVERY_LIMITS.entries || bytes(raw) > MAIL_RECOVERY_LIMITS.bytes) return false;
      if (entries.length) storage.setItem(key, raw); else storage.removeItem(key);
      return true;
    } catch { return false; }
  };
  const save = (input: MailRecoveryEntry): boolean => {
    const entry = parseMailRecovery(input, now());
    if (!entry || bytes(JSON.stringify(entry)) > MAIL_RECOVERY_LIMITS.entryBytes) return false;
    const existing = read();
    return existing !== null && write([entry, ...existing.filter(old => old.id !== entry.id)]);
  };
  const remove = (id: string): boolean => { const existing = read(); return existing !== null && write(existing.filter(entry => entry.id !== id)); };
  return { list, get: (id: string) => list().find(entry => entry.id === id) ?? null, save, remove,
    inspect: () => { const entries = read(); return { entries: entries ?? [], unavailable: !storage || entries === null }; },
    /** A late response belongs only to the exact attempt still in this slot. */
    settle(id: string, attempt: string, status: Exclude<MailRecoveryStatus, 'editing' | 'pending'> | 'sent', proposalId?: string): boolean {
      const current = list().find(entry => entry.id === id);
      if (!current || current.attempt !== attempt) return false;
      return status === 'sent' ? remove(id) : save({ ...current, updatedAt: now(), status, ...(proposalId ? { proposalId } : {}) });
    },
  };
};
export type MailRecoveryStore = ReturnType<typeof createMailRecoveryStore>;
export const mailRecoveryStatusText = (status: MailRecoveryStatus): string => status === 'editing' ? 'Unfinished message'
  : status === 'held' ? 'Waiting for your approval'
  : status === 'review' ? 'Scheduled-send review prepared'
  : 'Send outcome not confirmed. Check Approvals or run history before sending another copy.';

/** D-406 — an email the owner picked for a chat message: the message names it by its mailbox and record id,
 *  never by its text (ruling P2), and the turn reads it with `mail.read` before its first round (P3).
 *
 *  The sender, subject and date are the server's, read from the stored email when the message is sent, so the
 *  conversation can show which email it was. They are data, shown as such; the model reads the email itself
 *  through its `mail.read` call. */

/** At most this many emails per message (ruling Q1, as D-335 reads at most 3 named pages). */
export const CHAT_MAIL_REFS_MAX = 3;

/** An email picked for a message, as `chat.send` takes it: which mailbox, which stored record. */
export interface ChatMailRefInput {
  readonly slug: string;
  readonly record_id: string;
}

/** An email picked for a message, as the message keeps it. */
export interface ChatMailRef extends ChatMailRefInput {
  /** The sender, as the email's headers name them. */
  readonly from?: string;
  readonly subject?: string;
  /** When it was received, epoch ms. */
  readonly received_at?: number;
}

const SLUG_MAX = 256;
const RECORD_ID_MAX = 4096;
const TEXT_MAX = 1024;

const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, max) : undefined;

/** The picked emails a value holds: each well-formed one once, in order, at most {@link CHAT_MAIL_REFS_MAX}. A
 *  malformed entry is dropped (a stored message is read back whatever it holds); `chat.send` refuses one
 *  instead, through {@link chatMailRefInputsOf}. */
export const chatMailRefsOf = (value: unknown): ChatMailRef[] => {
  if (!Array.isArray(value)) return [];
  const refs: ChatMailRef[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (refs.length >= CHAT_MAIL_REFS_MAX) break;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const slug = typeof row.slug === 'string' && row.slug.length > 0 && row.slug.length <= SLUG_MAX ? row.slug : undefined;
    const record_id = typeof row.record_id === 'string' && row.record_id.length > 0 && row.record_id.length <= RECORD_ID_MAX
      ? row.record_id : undefined;
    if (slug === undefined || record_id === undefined) continue;
    const key = JSON.stringify([slug, record_id]);
    if (seen.has(key)) continue;
    seen.add(key);
    const from = text(row.from, TEXT_MAX);
    const subject = text(row.subject, TEXT_MAX);
    const received_at = Number.isSafeInteger(row.received_at) && Number(row.received_at) >= 0 ? Number(row.received_at) : undefined;
    refs.push({ slug, record_id, ...(from !== undefined ? { from } : {}), ...(subject !== undefined ? { subject } : {}),
      ...(received_at !== undefined ? { received_at } : {}) });
  }
  return refs;
};

/** What `chat.send` was handed, checked: the picked emails, each once, or why they cannot be taken. Never a
 *  silent drop: the owner chose each one. */
export const chatMailRefInputsOf = (value: unknown): { readonly refs: ChatMailRefInput[] } | { readonly error: string } => {
  if (value === undefined) return { refs: [] };
  if (!Array.isArray(value)) return { error: 'The picked emails must be a list.' };
  const refs: ChatMailRefInput[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const row = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const slug = row !== null && typeof row.slug === 'string' && row.slug.length > 0 && row.slug.length <= SLUG_MAX ? row.slug : undefined;
    const record_id = row !== null && typeof row.record_id === 'string' && row.record_id.length > 0 && row.record_id.length <= RECORD_ID_MAX
      ? row.record_id : undefined;
    if (slug === undefined || record_id === undefined) return { error: 'A picked email is not one. Pick it again.' };
    const key = JSON.stringify([slug, record_id]);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ slug, record_id });
  }
  if (refs.length > CHAT_MAIL_REFS_MAX) return { error: `Pick at most ${String(CHAT_MAIL_REFS_MAX)} emails for one message.` };
  return { refs };
};

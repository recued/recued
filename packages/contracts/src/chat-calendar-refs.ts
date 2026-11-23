/** D-406 (Q4) — a calendar event the owner picked for a chat message, as D-406 picks an email
 *  (`chat-mail-refs.ts`): the message names it by its calendar and record id, never by its text (ruling P2), and the
 *  turn reads that one event (`calendar.search` with `slug` and `record_id`) before its first round (P3).
 *
 *  The title and start are the server's, read from the stored event when the message is sent, so the conversation
 *  can show which event it was. They are data, shown as such; the model reads the event itself through its call. */

/** At most this many events per message, as for emails (ruling Q1). */
export const CHAT_CALENDAR_REFS_MAX = 3;

/** An event picked for a message, as `chat.send` takes it: which calendar (its collection slug), which stored record. */
export interface ChatCalendarRefInput {
  readonly slug: string;
  readonly record_id: string;
}

/** An event picked for a message, as the message keeps it. */
export interface ChatCalendarRef extends ChatCalendarRefInput {
  readonly title?: string;
  /** When it starts, epoch ms. */
  readonly start_at?: number;
}

const SLUG_MAX = 256;
const RECORD_ID_MAX = 4096;
const TEXT_MAX = 1024;

const slugOf = (row: Record<string, unknown>): string | undefined =>
  typeof row.slug === 'string' && row.slug.length > 0 && row.slug.length <= SLUG_MAX ? row.slug : undefined;
const recordIdOf = (row: Record<string, unknown>): string | undefined =>
  typeof row.record_id === 'string' && row.record_id.length > 0 && row.record_id.length <= RECORD_ID_MAX ? row.record_id : undefined;

/** The picked events a value holds: each well-formed one once, in order, at most {@link CHAT_CALENDAR_REFS_MAX}. A
 *  malformed entry is dropped (a stored message is read back whatever it holds); `chat.send` refuses one instead,
 *  through {@link chatCalendarRefInputsOf}. */
export const chatCalendarRefsOf = (value: unknown): ChatCalendarRef[] => {
  if (!Array.isArray(value)) return [];
  const refs: ChatCalendarRef[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (refs.length >= CHAT_CALENDAR_REFS_MAX) break;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const slug = slugOf(row);
    const record_id = recordIdOf(row);
    if (slug === undefined || record_id === undefined) continue;
    const key = JSON.stringify([slug, record_id]);
    if (seen.has(key)) continue;
    seen.add(key);
    const title = typeof row.title === 'string' && row.title.trim().length > 0 ? row.title.trim().slice(0, TEXT_MAX) : undefined;
    const start_at = Number.isSafeInteger(row.start_at) ? Number(row.start_at) : undefined;
    refs.push({ slug, record_id, ...(title !== undefined ? { title } : {}), ...(start_at !== undefined ? { start_at } : {}) });
  }
  return refs;
};

/** What `chat.send` was handed, checked: the picked events, each once, or why they cannot be taken. Never a silent
 *  drop: the owner chose each one. */
export const chatCalendarRefInputsOf = (value: unknown): { readonly refs: ChatCalendarRefInput[] } | { readonly error: string } => {
  if (value === undefined) return { refs: [] };
  if (!Array.isArray(value)) return { error: 'The picked events must be a list.' };
  const refs: ChatCalendarRefInput[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const row = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const slug = row !== null ? slugOf(row) : undefined;
    const record_id = row !== null ? recordIdOf(row) : undefined;
    if (slug === undefined || record_id === undefined) return { error: 'A picked event is not one. Pick it again.' };
    const key = JSON.stringify([slug, record_id]);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ slug, record_id });
  }
  if (refs.length > CHAT_CALENDAR_REFS_MAX) return { error: `Pick at most ${String(CHAT_CALENDAR_REFS_MAX)} events for one message.` };
  return { refs };
};

/** D-338 — notices: what Recued sends the owner on a messenger they chat with
 *  Recued on, without being asked (a reminder, the Agenda, an alert).
 *
 *  Each linked Telegram, Slack or Discord chat is ONE conversation
 *  (`chat_messenger_bindings`, unique per vendor, chat and bot). A notification
 *  used to go out beside it, through the notification channels, and was never
 *  part of it — so a reply on the phone landed in a conversation where the
 *  notification had never happened. The owner's rulings (2026-11-03):
 *
 *  - A notification is stored in that conversation as a `notice` row. The model
 *    never sees one: the history window, recall and the brief read `user` /
 *    `assistant` rows only, and the mirror trigger copies only those out, so a
 *    notice is not sent twice either.
 *  - The ONLY way in is a reply that quotes it. Its messenger message id is kept
 *    here, and a quoted reply resolves to it (`chat-messenger-bridge.ts`
 *    `nativeReply`), so the model gets its text with the reply.
 *  - It looks different, so the owner can tell what the model can see: a last
 *    line saying it is Recued's and that the chat sees it once they reply to it.
 *    Chat replies never carry it. (It opened with "Notice · <title>" too, and
 *    ended "Not part of your chat with Recued. To ask about it, use Reply on this
 *    message."; the owner, 2026-11-14, reading one on Telegram, chose the title
 *    alone and this plainer last line.)
 *
 *  Only the owner's own linked chat counts: the notification's bot must be the
 *  bot the chat is bound to. A household group, or a messenger the owner does
 *  not chat on, gets the notification as before. Spec: D-338. */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ChatMessage, RecuedServerSignature } from '@recued/contracts';
import type { RemoteNoticeHook } from '@recued/notification';
import type { ChatStore } from './storage/chat-store.js';

/** The messengers a chat with Recued runs on: the ones whose conversation is
 *  mirrored (`wire-messenger-turn.ts` `mirrored`). A notice anywhere else could
 *  never be quoted back. */
export const NOTICE_VENDORS: ReadonlySet<string> = new Set(['telegram', 'slack', 'discord']);

/** A notice's first line: its own title (D-343, the owner 2026-11-14: no "Notice ·" before it). */
export const noticeTitleLine = (title: string | undefined): string => {
  const trimmed = title?.trim();
  return trimmed ? trimmed : 'From Recued';
};

/** The last line every notice carries, and no chat reply does: whose it is, and that the chat sees
 *  it once the owner replies to it, in that messenger's words (on Slack, in its thread). */
export const noticeRuleLine = (vendor: string): string => vendor === 'slack'
  ? '— Sent by Recued. The chat sees it once you reply in its thread.'
  : '— Sent by Recued. The chat sees it once you reply to it.';

/** What a quoted notice gives the model: what the owner saw, without the two
 *  lines that only explain the rule. */
export const noticeQuoteText = (message: Pick<ChatMessage, 'content' | 'notice'>): string =>
  message.notice?.title ? `${message.notice.title}\n${message.content}` : message.content;

/** Where each notice's messenger message id is kept. Created by the bridge (which
 *  reads it to resolve a quote) and by the recorder (which writes it), so either
 *  can be built first. */
export const ensureChatNoticeTables = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_notice_receipts (
      session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
      vendor TEXT NOT NULL,
      vendor_message_id TEXT NOT NULL,
      message_id TEXT NOT NULL REFERENCES chat_messages(message_id) ON DELETE CASCADE,
      PRIMARY KEY (session_id, vendor, vendor_message_id)
    );
    CREATE INDEX IF NOT EXISTS chat_notice_receipts_message ON chat_notice_receipts(session_id, message_id);
  `);
};

/** The bindings table belongs to the messenger bridge, which a server without a
 *  messenger never builds; with no table there is no chat to post a notice in. */
const bindingsExist = (db: Database.Database): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chat_messenger_bindings'").get() !== undefined;

const bindingFor = (db: Database.Database, vendor: string, recipient: string, account: string): { session_id: string } | undefined =>
  bindingsExist(db)
    ? db.prepare('SELECT session_id FROM chat_messenger_bindings WHERE vendor = ? AND recipient = ? AND account = ?')
      .get(vendor, recipient, account) as { session_id: string } | undefined
    : undefined;

/** Whether any chat is bound to this messenger and recipient, whatever its bot. Checked before
 *  the bot's identity is asked of the vendor, so a notification to a messenger the owner does not
 *  chat on costs no call beyond its own send. */
const anyBindingTo = (db: Database.Database, vendor: string, recipient: string): boolean =>
  bindingsExist(db)
  && db.prepare('SELECT 1 FROM chat_messenger_bindings WHERE vendor = ? AND recipient = ? LIMIT 1').get(vendor, recipient) !== undefined;

/** D-338 — whether a conversation is a chat on a messenger its notices go to, so
 *  its model is told that notices it cannot see are there. */
export const conversationHoldsNotices = (db: Database.Database, session_id: string): boolean => {
  if (session_id === APP_DAY_SESSION_ID) return true;
  if (!bindingsExist(db)) return false;
  const row = db.prepare('SELECT vendor FROM chat_messenger_bindings WHERE session_id = ?').get(session_id) as { vendor: string } | undefined;
  return row !== undefined && NOTICE_VENDORS.has(row.vendor);
};

export interface ChatNoticeDeps {
  readonly db: Database.Database;
  readonly chatStore: Pick<ChatStore, 'appendMessage'>;
  /** The bot account a token belongs to, verified with the vendor (the same
   *  identity a binding is keyed by). */
  readonly accountFor: (vendor: string, token: string) => Promise<string>;
  /** Whether the chat key is open. A notice is stored encrypted, so with the
   *  vault sealed the notification goes out plain rather than promising a reply
   *  that could not find it. */
  readonly keyReady: () => boolean;
  readonly signature: RecuedServerSignature;
  /** Shows a new notice in an open app at once. */
  readonly broadcast?: { emit(event: { kind: 'chat.message_complete'; session_id: string; turn_id: string; final: unknown }): void };
  readonly now?: () => number;
}

/** A notice row in a conversation: its text, and its title and where it went encrypted beside it,
 *  shown in an open app at once. The messenger's notices and the app's own (D-343) are written so. */
const appendNotice = async (deps: Pick<ChatNoticeDeps, 'chatStore' | 'signature' | 'broadcast'>, session_id: string,
  vendor: string, message: { text: string; title?: string; link_url?: string }, ts: number,
  identity?: { message_id: string; assert_active: () => void }): Promise<ChatMessage> => {
  const id = identity?.message_id ?? `notice:${randomUUID()}`;
  const written = await deps.chatStore.appendMessage({
    id,
    session_id,
    role: 'notice',
    content: message.text,
    target_server: 'self',
    picker_at_send: { display_name: 'self', signature: deps.signature },
    model_used: { provider: 'recued', model_id: 'notice' },
    notice: {
      vendor,
      ...(message.title !== undefined && message.title.trim() ? { title: message.title.trim() } : {}),
      ...(message.link_url !== undefined ? { link_url: message.link_url } : {}),
    },
    ts,
    ...(identity ? { assert_active: identity.assert_active } : {}),
  });
  try {
    deps.broadcast?.emit({ kind: 'chat.message_complete', session_id, turn_id: id, final: written });
  } catch { /* the conversation shows it on its next read */ }
  return written;
};

/** Where an app conversation's own notice says it went: the app, not a messenger. */
export const APP_NOTICE_VENDOR = 'app';

/** Trusted ingress reserves these before opening, so an interrupted open can finish in place. */
export interface NoticeConversationIdentity {
  session_id: string;
  message_id: string;
  assert_active: () => void;
}
export type NoticeConversationOpener = ((notice: { title: string; text: string }, identity?: NoticeConversationIdentity)
  => Promise<{ session_id: string; message_id: string }>) & {
  /** Keeps a notice that went out (the daily and weekly streams, the Agenda, Close the day) in the
   *  app's "Your day" conversation, once: one already there with the same title and text is kept. */
  readonly record?: (notice: { title: string; text: string }) => Promise<void>;
};

/** D-343 (the owner, 2026-11-15: "a dedicated session ... in the webclient chat ... where the system
 *  generated result is copied there") — the app's one conversation for the day's notices, as a
 *  linked Telegram chat is one conversation for its own. The morning's "Your day", the Agenda and the
 *  evening's "Close the day" are kept in it as notices, out of the model's sight until a reply quotes
 *  one (D-338); Today's "Close the day" and a reply by email close the day in it, so a morning change
 *  and the evening's close are one conversation, and two replies about one day queue in it rather
 *  than race in two. Amends ruling 20 ("a new conversation holding today's evening notice"). */
export const APP_DAY_SESSION_ID = 'app-your-day';
export const APP_DAY_SESSION_TITLE = 'Your day';
/** How far back a notice already kept is looked for: a few days of streams and closings. */
const APP_DAY_NOTICE_LOOKBACK = 50;

/** D-343 slice 4 (ruling 20, amended 2026-11-15) — Today's "Close the day", and a reply by email:
 *  the app's "Your day" conversation, at the evening notice, so the app's reply quotes it as a
 *  messenger reply quotes one there, with or without a messenger. Its notice is the one already kept
 *  there with the same title and text (the evening notice that went out), else a new one. An email's
 *  reply reserves its own notice (`identity`), so an interrupted open finishes in place; one reserved
 *  before the conversation was the app's own keeps the conversation it reserved. */
export const createNoticeConversationOpener = (deps: Pick<ChatNoticeDeps, 'signature' | 'broadcast' | 'now'> & {
  readonly chatStore: Pick<ChatStore, 'appendMessage' | 'createSession' | 'getSession' | 'listMessagePage'>;
}): NoticeConversationOpener => {
  const now = deps.now ?? Date.now;
  const ensure = (session_id: string, title: string): void => {
    if (!deps.chatStore.getSession(session_id)) {
      deps.chatStore.createSession({ id: session_id, title: session_id === APP_DAY_SESSION_ID ? APP_DAY_SESSION_TITLE : title, now: now() });
    }
  };
  /** The latest notice in "Your day" with this title, and this text unless `anyText`. */
  const kept = async (notice: { title: string; text: string }, anyText = false): Promise<ChatMessage | undefined> => {
    const page = await deps.chatStore.listMessagePage(APP_DAY_SESSION_ID, APP_DAY_NOTICE_LOOKBACK);
    return [...page.messages].reverse().find(message => message.role === 'notice'
      && (message.notice?.title ?? '') === notice.title.trim() && (anyText || message.content === notice.text));
  };
  // Two opens of one notice at once (a press and the evening's send) keep one: each waits its turn.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work); queue = next.catch(() => undefined); return next;
  };
  // `sameDay` — Today's button: the evening notice already there for today, even where its lines have
  // changed since (a task ticked off in the close that followed it), rather than a second one. The
  // close reads the day's items fresh, so the quote's text is the owner's reference only.
  const keep = (notice: { title: string; text: string }, sameDay = false): Promise<string> => serial(async () => {
    ensure(APP_DAY_SESSION_ID, notice.title);
    const existing = await kept(notice, sameDay);
    if (existing) return existing.id;
    return (await appendNotice(deps, APP_DAY_SESSION_ID, APP_NOTICE_VENDOR, notice, now())).id;
  });
  const open = async (notice: { title: string; text: string }, identity?: NoticeConversationIdentity) => {
    if (!identity) return { session_id: APP_DAY_SESSION_ID, message_id: await keep(notice, true) };
    const session_id = identity.session_id;
    identity.assert_active();
    ensure(session_id, notice.title);
    const page = await deps.chatStore.listMessagePage(session_id, 1, undefined, { around_message_id: identity.message_id });
    identity.assert_active();
    const existing = page.messages.find(message => message.id === identity.message_id);
    if (existing) {
      if (existing.role !== 'notice') throw new Error('The saved notice is no longer available.');
      return { session_id, message_id: existing.id };
    }
    const written = await appendNotice(deps, session_id, APP_NOTICE_VENDOR, notice, now(), identity);
    return { session_id, message_id: written.id };
  };
  return Object.assign(open, { record: async (notice: { title: string; text: string }) => { await keep(notice); } });
};

/** The hook the messenger channels call before a notify goes out. */
export const createChatNotices = (deps: ChatNoticeDeps): RemoteNoticeHook => {
  ensureChatNoticeTables(deps.db);
  const now = deps.now ?? Date.now;
  const receiptStmt = deps.db.prepare(
    'INSERT OR IGNORE INTO chat_notice_receipts (session_id, vendor, vendor_message_id, message_id) VALUES (?, ?, ?, ?)',
  );
  return {
    async prepare({ vendor, recipient, token, message }) {
      if (!NOTICE_VENDORS.has(vendor) || !deps.keyReady() || !anyBindingTo(deps.db, vendor, recipient)) return undefined;
      const account = await deps.accountFor(vendor, token);
      const binding = bindingFor(deps.db, vendor, recipient, account);
      if (binding === undefined) return undefined;
      const session_id = binding.session_id;
      return {
        title: noticeTitleLine(message.title),
        text: `${message.text}\n\n${noticeRuleLine(vendor)}`,
        async sent(vendor_message_id) {
          const written = await appendNotice(deps, session_id, vendor, message, now());
          if (vendor_message_id !== undefined && vendor_message_id.length > 0) {
            receiptStmt.run(session_id, vendor, vendor_message_id, written.id);
          }
        },
      };
    },
  };
};

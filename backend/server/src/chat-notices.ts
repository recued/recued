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
 *  - It looks different, so the owner can tell what the model can see: a
 *    "Notice · <title>" first line and a last line saying how to ask about it.
 *    Chat replies never carry either.
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

/** The first line every notice carries, and no chat reply does. */
export const noticeTitleLine = (title: string | undefined): string => {
  const trimmed = title?.trim();
  return trimmed ? `Notice · ${trimmed}` : 'Notice';
};

/** The last line: the rule, in that messenger's own words for replying to a
 *  message. On Slack the reply goes in the message's thread. */
export const noticeRuleLine = (vendor: string): string => vendor === 'slack'
  ? "Not part of your chat with Recued. To ask about it, reply in this message's thread."
  : 'Not part of your chat with Recued. To ask about it, use Reply on this message.';

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
          const id = `notice:${randomUUID()}`;
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
            ts: now(),
          });
          if (vendor_message_id !== undefined && vendor_message_id.length > 0) {
            receiptStmt.run(session_id, vendor, vendor_message_id, id);
          }
          try {
            deps.broadcast?.emit({ kind: 'chat.message_complete', session_id, turn_id: id, final: written });
          } catch { /* the conversation shows it on its next read */ }
        },
      };
    },
  };
};

/** D-318 step 3 — the email chat door's conversations (§4.13).
 *
 *  A provider's thread is not stable enough to be the conversation: a Gmail
 *  reply sent without Gmail's thread id lands in a new thread, a changed subject
 *  splits a Gmail thread, and each provider threads its own way. So a
 *  conversation is Recued's own id, recorded against every Message-ID in it —
 *  each request, and each answer as its Sent copy shows it (step 5). A new
 *  request whose `In-Reply-To` or `References` names a recorded Message-ID joins
 *  that conversation, whatever thread its provider files it in; one that names
 *  none starts a new conversation.
 *
 *  Kept per chat mailbox: the same Message-ID under another chat mailbox is
 *  another door's message. */

import type Database from 'better-sqlite3';

/** Most References headers name a handful of messages; a long one is cut to the
 *  nearest this many (In-Reply-To first, then References from its end). */
export const MAIL_CHAT_MAX_REFERENCES = 50;

export type MailChatConversationRole = 'request' | 'answer';

export interface MailChatConversations {
  /** The conversation this message is part of, or `null`. */
  conversationOf(chat_slug: string, rfc_message_id: string): string | null;
  /** The conversation of the first of `references` that is recorded — pass
   *  them nearest first (`mailChatReferences` orders them so) — or `null`. */
  find(chat_slug: string, references: readonly string[]): string | null;
  /** Record a message as part of a conversation. A message already recorded
   *  keeps the conversation it has, which is returned. */
  record(
    chat_slug: string,
    rfc_message_id: string,
    conversation_id: string,
    role: MailChatConversationRole,
    at: number,
  ): string;
  /** The audit — how many requests in a row, this one included, a conversation
   *  has had with these same words (`text_hash`). Asking again for the same
   *  request counts it once. */
  repeats(chat_slug: string, conversation_id: string, rfc_message_id: string, text_hash: string, at: number): number;
}

/** `<a@x> <b@y>` → `['a@x', 'b@y']`: the Message-IDs a header names, brackets
 *  removed. Text outside brackets (comments, a bare token) names nothing. */
const messageIdsIn = (header: string | undefined): string[] => {
  if (header === undefined) return [];
  const ids: string[] = [];
  for (const match of header.matchAll(/<([^<>\s]{1,500})>/g)) ids.push(match[1]!);
  return ids;
};

/** The Message-IDs a request refers to, nearest first: its `In-Reply-To`, then
 *  its `References` from the end (the parent) back. Deduplicated, and at most
 *  `MAIL_CHAT_MAX_REFERENCES`. */
export const mailChatReferences = (headers: Readonly<Record<string, string>> | undefined): string[] => {
  const ordered = [
    ...messageIdsIn(headers?.['in-reply-to']),
    ...messageIdsIn(headers?.['references']).reverse(),
  ];
  return [...new Set(ordered)].slice(0, MAIL_CHAT_MAX_REFERENCES);
};

export const createMailChatConversations = (db: Database.Database): MailChatConversations => {
  db.exec(`CREATE TABLE IF NOT EXISTS mail_chat_conversation_messages (
    chat_slug TEXT NOT NULL,
    rfc_message_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('request', 'answer')),
    recorded_at INTEGER NOT NULL,
    PRIMARY KEY (chat_slug, rfc_message_id)
  )`);
  const selectOne = db.prepare(`SELECT conversation_id FROM mail_chat_conversation_messages
    WHERE chat_slug = ? AND rfc_message_id = ?`);
  const insert = db.prepare(`INSERT OR IGNORE INTO mail_chat_conversation_messages
    (chat_slug, rfc_message_id, conversation_id, role, recorded_at) VALUES (?, ?, ?, ?, ?)`);
  db.exec(`CREATE TABLE IF NOT EXISTS mail_chat_conversation_repeats (
    chat_slug TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    last_message_id TEXT NOT NULL,
    repeats INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (chat_slug, conversation_id)
  )`);
  const selectRepeats = db.prepare(`SELECT text_hash, last_message_id, repeats FROM mail_chat_conversation_repeats
    WHERE chat_slug = ? AND conversation_id = ?`);
  const upsertRepeats = db.prepare(`INSERT INTO mail_chat_conversation_repeats
    (chat_slug, conversation_id, text_hash, last_message_id, repeats, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (chat_slug, conversation_id) DO UPDATE SET text_hash = excluded.text_hash,
      last_message_id = excluded.last_message_id, repeats = excluded.repeats, updated_at = excluded.updated_at`);

  const conversationOf = (chat_slug: string, rfc_message_id: string): string | null =>
    (selectOne.get(chat_slug, rfc_message_id) as { conversation_id: string } | undefined)?.conversation_id ?? null;

  return {
    conversationOf,
    find(chat_slug, references) {
      for (const id of references) {
        const conversation = conversationOf(chat_slug, id);
        if (conversation !== null) return conversation;
      }
      return null;
    },
    record(chat_slug, rfc_message_id, conversation_id, role, at) {
      insert.run(chat_slug, rfc_message_id, conversation_id, role, at);
      return conversationOf(chat_slug, rfc_message_id) ?? conversation_id;
    },
    repeats(chat_slug, conversation_id, rfc_message_id, text_hash, at) {
      const last = selectRepeats.get(chat_slug, conversation_id) as
        | { text_hash: string; last_message_id: string; repeats: number } | undefined;
      if (last !== undefined && last.last_message_id === rfc_message_id) return last.repeats;
      const repeats = last !== undefined && last.text_hash === text_hash ? last.repeats + 1 : 1;
      upsertRepeats.run(chat_slug, conversation_id, text_hash, rfc_message_id, repeats, at);
      return repeats;
    },
  };
};

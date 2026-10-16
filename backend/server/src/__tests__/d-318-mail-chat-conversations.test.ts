/** D-318 step 3 — the email chat door's conversations (§4.13): Recued's own id,
 *  recorded against each Message-ID in a conversation, and found again through
 *  the Message-IDs a new email refers to. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createMailChatConversations,
  MAIL_CHAT_MAX_REFERENCES,
  mailChatReferences,
} from '../mail-chat-door/conversations.js';

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const store = () => {
  const db = new Database(':memory:');
  dbs.push(db);
  return createMailChatConversations(db);
};

describe('mailChatReferences', () => {
  it('reads In-Reply-To first, then References from the parent back, each once', () => {
    expect(mailChatReferences({
      'in-reply-to': '<answer-2@chat.example>',
      references: '<req-1@owner.example>\r\n <answer-1@chat.example> <req-2@owner.example> <answer-2@chat.example>',
    })).toEqual(['answer-2@chat.example', 'req-2@owner.example', 'answer-1@chat.example', 'req-1@owner.example']);
  });

  it('names nothing for text outside brackets, a missing header, or no headers at all', () => {
    expect(mailChatReferences({ 'in-reply-to': 'your message of Monday', references: 'req-1@owner.example' })).toEqual([]);
    expect(mailChatReferences({})).toEqual([]);
    expect(mailChatReferences(undefined)).toEqual([]);
  });

  it(`keeps the nearest ${MAIL_CHAT_MAX_REFERENCES} of a long References`, () => {
    const ids = Array.from({ length: 80 }, (_, i) => `m${i}@x.example`);
    const references = mailChatReferences({ references: ids.map((id) => `<${id}>`).join(' ') });
    expect(references).toHaveLength(MAIL_CHAT_MAX_REFERENCES);
    expect(references[0]).toBe('m79@x.example');
  });
});

describe('createMailChatConversations', () => {
  it('finds the conversation of the nearest recorded message, and nothing for unknown ones', () => {
    const conversations = store();
    conversations.record('chat', 'req-1@owner.example', 'conv-a', 'request', 1);
    conversations.record('chat', 'req-9@owner.example', 'conv-b', 'request', 2);

    expect(conversations.find('chat', ['unknown@x.example', 'req-9@owner.example', 'req-1@owner.example'])).toBe('conv-b');
    expect(conversations.find('chat', ['unknown@x.example'])).toBeNull();
    expect(conversations.find('chat', [])).toBeNull();
  });

  it('a message keeps the conversation it was first given', () => {
    const conversations = store();
    expect(conversations.record('chat', 'req-1@owner.example', 'conv-a', 'request', 1)).toBe('conv-a');
    expect(conversations.record('chat', 'req-1@owner.example', 'conv-z', 'request', 2)).toBe('conv-a');
    expect(conversations.conversationOf('chat', 'req-1@owner.example')).toBe('conv-a');
  });

  it('keeps each chat mailbox apart', () => {
    const conversations = store();
    conversations.record('chat-a', 'req-1@owner.example', 'conv-a', 'request', 1);
    expect(conversations.find('chat-b', ['req-1@owner.example'])).toBeNull();
    expect(conversations.conversationOf('chat-b', 'req-1@owner.example')).toBeNull();
  });
});

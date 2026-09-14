import type { ChatMessage, ChatMessageReply } from '@recued/contracts';

export interface ChatReplyDraft {
  sessionId: string;
  messageId: string;
  preview?: { role: 'user' | 'assistant'; text: string };
}

export const replyDraftForMessage = (message: ChatMessage): ChatReplyDraft => {
  const text = message.content.replace(/\s+/gu, ' ').trim()
    || (message.attachments?.length ? 'Attachment' : 'Recued cannot show this message');
  const chars = Array.from(text);
  return { sessionId: message.session_id, messageId: message.id, preview: {
    role: message.role === 'user' ? 'user' : 'assistant',
    text: chars.slice(0, 240).join('') + (chars.length > 240 ? '…' : ''),
  } };
};

export const buildChatQuote = (
  doc: Document, reply: ChatMessageReply, open: (messageId: string) => void, draft = false,
): HTMLElement => {
  const available = 'message_id' in reply && reply.preview !== undefined;
  const root = doc.createElement(available ? 'button' : 'div');
  root.className = 'chat-quote';
  root.setAttribute('data-chat-quote', '');
  root.setAttribute('data-available', String(available));
  if ('message_id' in reply && reply.preview) {
    const id = reply.message_id;
    root.setAttribute('type', 'button');
    root.setAttribute('data-chat-quote-target', id);
    root.setAttribute('data-chat-reply-control', `quote:${id}`);
    root.setAttribute('aria-label', `See the message being replied to: ${reply.preview.text}`);
    const label = doc.createElement('strong');
    label.textContent = `${draft ? 'Replying to ' : ''}${reply.preview.role === 'user' ? 'You' : 'Recued'}`;
    const text = doc.createElement('span'); text.textContent = reply.preview.text;
    root.appendChild(label); root.appendChild(text);
    root.addEventListener('click', () => open(id));
  } else {
    root.textContent = 'message_id' in reply
      ? 'The message being replied to is gone.'
      : 'The Messenger message being replied to is not in this chat.';
  }
  return root;
};

export const buildChatReplyDraft = (
  doc: Document, draft: ChatReplyDraft, open: (id: string) => void, clear: () => void,
): HTMLElement => {
  const root = doc.createElement('div');
  root.className = 'chat-reply-draft'; root.setAttribute('data-chat-reply-draft', draft.messageId);
  root.setAttribute('role', 'group'); root.setAttribute('aria-label', 'Replying to a message');
  const quote = buildChatQuote(doc, { message_id: draft.messageId, ...(draft.preview ? { preview: draft.preview } : {}) }, open, true);
  root.appendChild(quote);
  const remove = doc.createElement('button'); remove.type = 'button';
  remove.textContent = 'Remove reply'; remove.setAttribute('data-chat-reply-control', 'clear');
  remove.addEventListener('click', clear); root.appendChild(remove);
  return root;
};

export const CHAT_QUOTED_REPLY_STYLES = `
.chat-quote { display:flex; flex-direction:column; gap:3px; min-width:0; max-width:100%;
  text-align:start; white-space:normal; overflow-wrap:anywhere; padding:8px 12px;
  margin:6px 0; border:0; border-inline-start:3px solid var(--fg-muted,#888);
  border-radius:4px; color:inherit; background:var(--surface-subtle,rgba(127,127,127,.08)); font:inherit; font-size:.875rem; }
button.chat-quote { cursor:pointer; }
.chat-quote[data-available="false"] { color:var(--fg-muted,#888); }
.chat-reply-draft { display:flex; align-items:center; gap:8px; min-width:0; }
.chat-reply-draft .chat-quote { flex:1; }
.chat-reply-draft > button { flex-shrink:0; }
.chat-reply-draft > button, [data-chat-reply-action] { min-height:32px; padding:4px 10px;
  border:1px solid var(--border-subtle,#7775); border-radius:var(--chat-radius-pill,16px);
  background:transparent; color:var(--muted,#888); font:inherit; font-size:12px; cursor:pointer; }
[data-chat-reply-action] { justify-self:start; margin:2px 0; }
.chat-reply-draft > button:hover, .chat-reply-draft > button:focus-visible,
[data-chat-reply-action]:hover, [data-chat-reply-action]:focus-visible { color:var(--fg,inherit); border-color:var(--accent,#888); }
`;

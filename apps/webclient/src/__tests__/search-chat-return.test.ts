import { describe, expect, it } from 'vitest';
import { readSearchChatReturn, saveSearchChatReturn, trackSearchChatRoute } from '../shell/search-chat-return.js';
import { serializeChatAnswerAddress } from '../shell/route.js';

describe('universal search return from an exact chat message', () => {
  it('scopes hints to the document and connection and keeps Back/Forward through the exact message visit', () => {
    const doc = {} as Document, otherDoc = {} as Document, owner = {}, otherOwner = {};
    const saved = { sessionId: 'conversation/one', messageId: 'message #1', returnHash: '#views/research',
      state: { query: 'needle' }, scroll: { top: 550, left: 0 } };
    saveSearchChatReturn(doc, owner, saved);
    expect(readSearchChatReturn(doc, otherOwner)).toBeUndefined();
    expect(readSearchChatReturn(otherDoc, owner)).toBeUndefined();
    for (const hash of [serializeChatAnswerAddress(saved), saved.returnHash, serializeChatAnswerAddress(saved)]) {
      trackSearchChatRoute(doc, owner, hash); expect(readSearchChatReturn(doc, owner)).toEqual(saved);
    }
    trackSearchChatRoute(doc, owner, serializeChatAnswerAddress({ ...saved, messageId: 'another' }));
    expect(readSearchChatReturn(doc, owner)).toBeUndefined();
  });
  it('retires a hint on unrelated navigation even if that navigation later returns to the same chat', () => {
    const doc = {} as Document, owner = {};
    const saved = { sessionId: 'one', messageId: 'm1', returnHash: '#data/search', state: {}, scroll: { top: 0, left: 0 } };
    saveSearchChatReturn(doc, owner, saved); trackSearchChatRoute(doc, owner, '#data/task');
    trackSearchChatRoute(doc, owner, serializeChatAnswerAddress(saved));
    expect(readSearchChatReturn(doc, owner)).toBeUndefined();
  });
});

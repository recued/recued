import { serializeChatAnswerAddress } from './route.js';
import { forgetListContinuity, readListContinuity, updateListContinuity, type ListScrollPosition } from './list-preview-continuity.js';

const owners = new WeakMap<object, string>();
let sequence = 0;
const keyFor = (owner: object): string => {
  let key = owners.get(owner);
  if (!key) { key = `search-chat-return-${++sequence}`; owners.set(owner, key); }
  return key;
};
export interface SearchChatReturn<State> {
  sessionId: string;
  messageId: string;
  returnHash: string;
  state: State;
  scroll: ListScrollPosition;
}
export const saveSearchChatReturn = <State>(doc: Document, owner: object, value: SearchChatReturn<State>): void => {
  updateListContinuity(doc, keyFor(owner), { filter: value });
};
export const readSearchChatReturn = <State>(doc: Document, owner: object): SearchChatReturn<State> | undefined =>
  readListContinuity<SearchChatReturn<State>>(doc, keyFor(owner))?.filter;

/** The hint belongs to one message visit and server connection. Following
 * another route retires it; Back/Forward keeps this search/message pair. */
export const trackSearchChatRoute = (doc: Document, owner: object, hash: string): void => {
  const saved = readSearchChatReturn(doc, owner);
  if (saved && hash !== saved.returnHash && hash !== serializeChatAnswerAddress(saved)) forgetListContinuity(doc, keyFor(owner));
};

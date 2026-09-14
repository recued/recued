import { MESSENGER_VENDOR_SLUGS } from './messenger-vendors.js';
import type { ChatSessionSummary } from './chat.js';
import type { ChatMessengerSessionStatus } from './chat-delivery.js';

export const CHAT_HISTORY_SOURCES = ['all', 'webclient', 'messenger'] as const;
export const CHAT_HISTORY_VENDORS = ['all', ...MESSENGER_VENDOR_SLUGS] as const;
export interface ChatHistoryFilters {
  source: typeof CHAT_HISTORY_SOURCES[number];
  vendor: typeof CHAT_HISTORY_VENDORS[number];
  needs_attention: boolean;
}
export const DEFAULT_CHAT_HISTORY_FILTERS: Readonly<ChatHistoryFilters> = {
  source: 'all', vendor: 'all', needs_attention: false,
};
export const parseChatHistoryFilters = (value: unknown): ChatHistoryFilters | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { source = 'all', vendor = 'all', needs_attention = false } = value as Record<string, unknown>;
  const parsedSource = CHAT_HISTORY_SOURCES.find(candidate => candidate === source);
  const parsedVendor = CHAT_HISTORY_VENDORS.find(candidate => candidate === vendor);
  if (!parsedSource || !parsedVendor || typeof needs_attention !== 'boolean') return null;
  return { source: parsedSource, vendor: parsedVendor, needs_attention };
};
export const hasChatHistoryFilters = (filters: ChatHistoryFilters): boolean =>
  filters.source !== 'all' || filters.vendor !== 'all' || filters.needs_attention;

/** Legacy identities are useful even when the server predates bindings. A
 * renamed title is never evidence of a vendor or destination. */
export const chatSessionMessengerIdentity = (session: Pick<ChatSessionSummary, 'id' | 'messenger'>):
  { vendor: string; recipient: string } | null => {
  if (session.messenger) return { vendor: session.messenger.vendor, recipient: session.messenger.recipient };
  const legacy = /^messenger:([^:]+):(.+)$/.exec(session.id);
  return legacy ? { vendor: legacy[1]!, recipient: legacy[2]! } : null;
};
export const chatMessengerNeedsAttention = (status: ChatMessengerSessionStatus | undefined, stale = false): boolean => {
  if (stale || !status) return true;
  return !['active', 'webhook', 'connecting', 'checking'].includes(status.receive)
    || status.delivery === null || status.delivery.failed_count > 0
    || status.delivery.unknown_count > 0 || status.delivery.skipped_count > 0;
};
export const chatSessionMatchesFilters = (
  session: Pick<ChatSessionSummary, 'id' | 'messenger'>,
  filters: ChatHistoryFilters,
  stale = false,
): boolean => {
  const messenger = chatSessionMessengerIdentity(session);
  if ((filters.source === 'webclient' && messenger) || (filters.source === 'messenger' && !messenger)) return false;
  if (filters.vendor !== 'all' && messenger?.vendor !== filters.vendor) return false;
  return !filters.needs_attention || messenger !== null && chatMessengerNeedsAttention(session.messenger, stale);
};

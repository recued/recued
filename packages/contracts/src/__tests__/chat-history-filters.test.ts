import { describe, expect, it } from 'vitest';
import { chatSessionMatchesFilters, chatMessengerNeedsAttention, DEFAULT_CHAT_HISTORY_FILTERS, parseChatHistoryFilters } from '../chat-history-filters.js';
import type { ChatMessengerReceiveState, ChatMessengerSessionStatus } from '../chat-delivery.js';
import { applyPrefsPatch, DEFAULT_INSTANCE_PREFS, getPref } from '../prefs.js';

const healthy: ChatMessengerSessionStatus = { vendor: 'telegram', recipient: '42', linked: true, receive: 'active',
  delivery: { pending_count: 0, sending_count: 0, failed_count: 0, unknown_count: 0, skipped_count: 0 } };
describe('Chats filter semantics', () => {
  it('classifies structured and legacy identities independently of editable titles', () => {
    const telegram = { ...DEFAULT_CHAT_HISTORY_FILTERS, vendor: 'telegram' as const };
    expect(chatSessionMatchesFilters({ id: 'renamed-uuid', messenger: healthy }, telegram)).toBe(true);
    expect(chatSessionMatchesFilters({ id: 'messenger:telegram:42' }, telegram)).toBe(true);
    expect(chatSessionMatchesFilters({ id: 'web' }, telegram)).toBe(false);
    expect(chatSessionMatchesFilters({ id: 'web' }, { ...telegram, source: 'webclient' })).toBe(false);
  });
  it.each<ChatMessengerReceiveState>(['retrying', 'error', 'stopped', 'locked', 'invalid', 'paused', 'unknown', 'unavailable', 'connection_changed', 'not_connected', 'unlinked'])(
    'includes receive state %s even with no pending deliveries', receive => {
      expect(chatMessengerNeedsAttention({ ...healthy, receive })).toBe(true);
    },
  );
  it.each<ChatMessengerReceiveState>(['active', 'webhook', 'connecting', 'checking'])(
    'does not confuse ordinary pending delivery or %s with a failed connection', receive => {
      expect(chatMessengerNeedsAttention({ ...healthy, receive, delivery: { ...healthy.delivery!, pending_count: 4, sending_count: 1 } })).toBe(false);
    },
  );
  it('includes failed, unknown, skipped and unavailable delivery status', () => {
    for (const name of ['failed_count', 'unknown_count', 'skipped_count'] as const) {
      expect(chatMessengerNeedsAttention({ ...healthy, delivery: { ...healthy.delivery!, [name]: 1 } })).toBe(true);
    }
    expect(chatMessengerNeedsAttention({ ...healthy, delivery: null })).toBe(true);
    expect(chatMessengerNeedsAttention(healthy, true)).toBe(true);
    expect(chatSessionMatchesFilters({ id: 'web' }, { ...DEFAULT_CHAT_HISTORY_FILTERS, needs_attention: true })).toBe(false);
  });
  it('preserves legacy preference defaults and validates persisted selections', () => {
    expect(getPref({}, 'ui.chat.history.source')).toBe('all');
    expect(getPref({}, 'ui.chat.history.scope')).toBe('all');
    expect(parseChatHistoryFilters({})).toEqual(DEFAULT_CHAT_HISTORY_FILTERS);
    const prefs = applyPrefsPatch(DEFAULT_INSTANCE_PREFS, {
      'ui.chat.history.vendor': 'telegram', 'ui.chat.history.scope': 'current', 'ui.chat.history.needs_attention': true,
      'ui.chat.history.query': 'never saved', 'ui.chat.history.cursor': { ts: 42 },
    });
    expect(getPref(prefs, 'ui.chat.history.vendor')).toBe('telegram');
    expect(prefs).not.toHaveProperty('ui.chat.history.query'); expect(prefs).not.toHaveProperty('ui.chat.history.cursor');
    expect(getPref(applyPrefsPatch(prefs, { 'ui.chat.history.vendor': 'email' }), 'ui.chat.history.vendor')).toBe('telegram');
  });
});

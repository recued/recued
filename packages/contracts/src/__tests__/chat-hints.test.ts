/** D-405 slice 3 — "Not now" on a hint under a chat answer: one key per hint, wherever it comes from,
 *  and the list the app reads back, each row checked. */
import { describe, expect, it } from 'vitest';

import { chatFixesOf } from '../chat-fixes.js';
import {
  CHAT_HINT_LABEL_MAX,
  CHAT_HINT_NOT_NOW_DAYS,
  CHAT_HINT_NOT_NOW_MS,
  CHAT_HINTS_NOT_NOW_LIMIT,
  chatHintKeyOfFix,
  chatHintKeyOfOffer,
  chatHintsNotNowOf,
  isChatHintKey,
} from '../chat-hints.js';

describe('a hint\'s key', () => {
  it('a thing to add, a pack\'s setup, a feature to connect, a pack or a recipe to get', () => {
    const [thing, source, feature] = chatFixesOf([
      { kind: 'thing', type_id: 'passport', type_name: 'Passport' },
      { kind: 'source', thing_name: 'Anna’s body', pack_slug: 'body-signals-apple-health', pack_name: 'Body signals from Apple Health' },
      { kind: 'feature', feature: 'mail' },
    ]);
    expect([thing, source, feature].map((fix) => chatHintKeyOfFix(fix!)))
      .toEqual(['thing:passport', 'source:body-signals-apple-health', 'feature:mail']);
    expect(chatHintKeyOfOffer({ kind: 'pack', slug: 'rental-book' })).toBe('offer:pack:rental-book');
    expect(chatHintKeyOfOffer({ kind: 'recipe', slug: 'track-parcel.v2' })).toBe('offer:recipe:track-parcel.v2');
  });

  it('⛔ none for a fix that answers the request itself: a switch, a run\'s need', () => {
    const [grant, need] = chatFixesOf([
      { kind: 'switch', entry_key: 'primitive.mail.search', label: 'Search your mail' },
      { kind: 'run_need', need: { kind: 'connection', step_id: 'deal', problem: 'reconnect', slot: 'hubspot' } },
    ]);
    expect(chatHintKeyOfFix(grant!)).toBeNull();
    expect(chatHintKeyOfFix(need!)).toBeNull();
  });

  it('every key a fix or an offer makes is one the server takes; nothing else is', () => {
    for (const key of ['thing:passport', 'source:body-signals-apple-health', 'feature:mail', 'feature:calendar', 'feature:file',
      'offer:pack:rental-book', 'offer:recipe:track-parcel.v2']) expect(isChatHintKey(key)).toBe(true);
    for (const key of ['switch:data.task', 'thing:Passport', 'feature:contacts', 'offer:app:x', 'offer:pack:../x', 'thing:', '', 7, null]) {
      expect(isChatHintKey(key)).toBe(false);
    }
  });
});

describe('the hints set aside, read back', () => {
  it('keeps each well-formed row once, its label trimmed and cut', () => {
    expect(chatHintsNotNowOf([
      { key: 'feature:mail', label: '  Connect your mail ', until: 5 },
      { key: 'feature:mail', label: 'again', until: 6 },
      { key: 'offer:pack:rental-book', label: 'x'.repeat(400), until: 7 },
    ])).toEqual([
      { key: 'feature:mail', label: 'Connect your mail', until: 5 },
      { key: 'offer:pack:rental-book', label: 'x'.repeat(CHAT_HINT_LABEL_MAX), until: 7 },
    ]);
  });

  it('⛔ drops a key no hint has, a blank label, a time that is not one, and anything malformed', () => {
    expect(chatHintsNotNowOf([
      { key: 'switch:data.task', label: 'x', until: 1 },
      { key: 'feature:mail', label: '  ', until: 1 },
      { key: 'feature:mail', label: 'x', until: Number.NaN },
      { key: 'feature:mail', label: 'x', until: '1' },
      'feature:mail',
      null,
    ])).toEqual([]);
    expect(chatHintsNotNowOf('not a list')).toEqual([]);
  });

  it('reads at most a list\'s worth, and "Not now" lasts the days it says', () => {
    const many = Array.from({ length: CHAT_HINTS_NOT_NOW_LIMIT + 5 }, (_, i) => ({ key: `thing:t${String(i)}`, label: 'x', until: 1 }));
    expect(chatHintsNotNowOf(many)).toHaveLength(CHAT_HINTS_NOT_NOW_LIMIT);
    expect(CHAT_HINT_NOT_NOW_MS).toBe(CHAT_HINT_NOT_NOW_DAYS * 86_400_000);
  });
});

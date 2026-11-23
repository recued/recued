/** D-404 slice B1 — the steps under a chat answer that can land, read the same way by the question
 *  the app asks and the answer the server gives. */
import { describe, expect, it } from 'vitest';

import { CHAT_NEXT_STEPS_LIMIT, chatNextStepKey, chatNextStepRefsOf, chatNextStepsOfMessage } from '../chat-next-steps.js';
import type { ChatMessage } from '../chat.js';

describe('chatNextStepRefsOf', () => {
  it('keeps a pack, a recipe and a thing, each once', () => {
    expect(chatNextStepRefsOf([
      { kind: 'pack', id: 'rental-book' },
      { kind: 'recipe', id: 'track-parcel.v2' },
      { kind: 'thing', id: 'travel_passport' },
      { kind: 'pack', id: 'rental-book' },
    ])).toEqual([
      { kind: 'pack', id: 'rental-book' },
      { kind: 'recipe', id: 'track-parcel.v2' },
      { kind: 'thing', id: 'travel_passport' },
    ]);
  });

  it('drops an unknown kind, an id no offer or type can have, and anything malformed', () => {
    expect(chatNextStepRefsOf([
      { kind: 'switch', id: 'data.task' },
      { kind: 'pack', id: '../etc' },
      { kind: 'pack', id: 'Rental Book' },
      { kind: 'thing' },
      'pack:x',
      null,
    ])).toEqual([]);
    expect(chatNextStepRefsOf('not a list')).toEqual([]);
  });

  it('asks about at most a few answers\' worth', () => {
    const many = Array.from({ length: CHAT_NEXT_STEPS_LIMIT + 5 }, (_, i) => ({ kind: 'pack', id: `p${String(i)}` }));
    expect(chatNextStepRefsOf(many)).toHaveLength(CHAT_NEXT_STEPS_LIMIT);
  });

  it('keeps a feature to connect by its lane, and no other (D-405 slice 2)', () => {
    expect(chatNextStepRefsOf([
      { kind: 'feature', id: 'mail' },
      { kind: 'feature', id: 'calendar' },
      { kind: 'feature', id: 'file' },
      { kind: 'feature', id: 'contacts' },
      { kind: 'feature', id: 'others' },
    ])).toEqual([
      { kind: 'feature', id: 'mail' },
      { kind: 'feature', id: 'calendar' },
      { kind: 'feature', id: 'file' },
    ]);
  });

  it('keys a step by its kind and id', () => {
    expect(chatNextStepKey({ kind: 'thing', id: 'passport' })).toBe('thing:passport');
  });
});

describe('chatNextStepsOfMessage', () => {
  const answer = (patch: Partial<ChatMessage>) => ({ role: 'assistant', ...patch }) as Pick<ChatMessage, 'role' | 'install_offers' | 'fixes'>;

  it('are its install offers and its things to add; a run\'s need or a switch is done in place', () => {
    expect(chatNextStepsOfMessage(answer({
      install_offers: [
        { kind: 'pack', slug: 'rental-book', name: 'Rental Book', publisher: 'recued-core', recipes: [] },
        { kind: 'recipe', slug: 'track-parcel', name: 'Track a parcel', publisher: 'recued-core', recipes: [] },
      ],
      fixes: [
        { kind: 'thing', type_id: 'boiler', type_name: 'Boiler' },
        { kind: 'switch', entry_key: 'data.task', label: 'Your tasks' },
      ],
    }))).toEqual([
      { kind: 'pack', id: 'rental-book' },
      { kind: 'recipe', id: 'track-parcel' },
      { kind: 'thing', id: 'boiler' },
    ]);
  });

  it('a feature to connect is one too (D-405 slice 2)', () => {
    expect(chatNextStepsOfMessage(answer({
      fixes: [{ kind: 'feature', feature: 'calendar' }, { kind: 'thing', type_id: 'boiler', type_name: 'Boiler' }],
    }))).toEqual([{ kind: 'feature', id: 'calendar' }, { kind: 'thing', id: 'boiler' }]);
  });

  it('none for the owner\'s own message, or an answer with nothing under it', () => {
    expect(chatNextStepsOfMessage({ role: 'user', fixes: [{ kind: 'thing', type_id: 'boiler', type_name: 'Boiler' }] } as never)).toEqual([]);
    expect(chatNextStepsOfMessage(answer({}))).toEqual([]);
  });
});

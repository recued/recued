/** D-346 follow-up (2026-11-08) — the fixes an owner's chat answer offers, read back through one
 *  reader: what the server stamped and what a stored message holds. */
import { describe, expect, it } from 'vitest';

import { CHAT_FIX_LIMIT, chatFixesOf } from '../chat-fixes.js';

describe('chatFixesOf', () => {
  it('keeps a run need and an owner switch', () => {
    expect(chatFixesOf([
      { kind: 'run_need', need: { kind: 'connection', step_id: 'deal', problem: 'reconnect', slot: 'hubspot' } },
      { kind: 'switch', entry_key: 'primitive.mail.search', label: 'Search your mail' },
    ])).toEqual([
      { kind: 'run_need', need: { kind: 'connection', step_id: 'deal', problem: 'reconnect', slot: 'hubspot' } },
      { kind: 'switch', entry_key: 'primitive.mail.search', label: 'Search your mail' },
    ]);
  });

  it('drops a switch that is not one of the owner\'s own, and anything malformed', () => {
    expect(chatFixesOf([
      { kind: 'switch', entry_key: 'recued-core/hubspot-catalog.deal.update', label: 'x' },
      { kind: 'switch', entry_key: 'data.task' },
      { kind: 'run_need', need: { kind: 'nope', step_id: 's' } },
      'text',
      null,
    ])).toEqual([]);
    expect(chatFixesOf('not a list')).toEqual([]);
  });

  it('says each fix once, and at most a few', () => {
    const off = { kind: 'switch', entry_key: 'data.task', label: 'Your tasks' };
    expect(chatFixesOf([off, off])).toHaveLength(1);
    const many = Array.from({ length: 9 }, (_, i) => ({ kind: 'switch', entry_key: `data.k${i}`, label: `k${i}` }));
    expect(chatFixesOf(many)).toHaveLength(CHAT_FIX_LIMIT);
  });
});

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createPeerAdmissionStore } from '../storage/peer-admission-store.js';

describe('D-234 peer admission — one pending owner ask per message', () => {
  it('reserves once, releases failed raises, and clears the reservation on answer', () => {
    const store = createPeerAdmissionStore(new Database(':memory:'));

    expect(store.reserveAsk('message-a')).toBe(true);
    expect(store.reserveAsk('message-a')).toBe(false);
    store.releaseAsk('message-a');
    expect(store.reserveAsk('message-a')).toBe(true);

    store.record({
      admission_identity: 'message-a',
      decision: 'accepted',
      contract_id: 'ct_peer',
      recipe_id: 'landing',
      decided_at: 7,
      ask_id: 'ask_1',
    });
    expect(store.claim('message-a')).toMatchObject({ decision: 'accepted' });
    expect(store.reserveAsk('message-a')).toBe(true);
  });
});

import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { createSituationStore } from '../storage/situation-store.js';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import { collectProposalMeasures, recordDigestResponse, recordFirstDigest } from '../situations/measures.js';
import { proposalSituation } from '../situations/proposal-events.js';

it('counts owner responses and coded outcomes once during local opt-in, without counting opens or source withdrawals', () => {
  const db = new Database(':memory:');
  try {
    const store = createSituationStore(db); const proposals = createProactiveProposalStore(db); const subject = { collection: 'asset', id: 'boiler' };
    const offer = (key: string, at: number) => proposals.ensure({ key, kind: 'schedule', title: 'Review timing', explanation: 'Owner outcomes', origin: 'learner', confidence: 'medium', sources: [], subject, payload: {} }, at);
    const first = offer('first', 10); const cluster = proposalSituation(first).cluster;
    recordFirstDigest(store, [cluster], 10); expect(store.readSetting('metrics.first_digest', null)).toBeNull();
    store.writeSetting('metrics.opt_in', true); store.writeSetting('metrics.enabled_at', 20);
    proposals.outcome(first.id, 'not_now', 15); collectProposalMeasures(proposals, store);
    expect(db.prepare('SELECT * FROM proactive_measures').all()).toEqual([]);
    recordFirstDigest(store, [cluster], 20); recordDigestResponse(store, [{ collection: 'asset', id: 'unrelated' }], 21);
    expect(db.prepare('SELECT * FROM proactive_measures').all()).toEqual([]);
    recordDigestResponse(store, [subject], 22); recordDigestResponse(store, [subject], 23);
    const next = offer('second', 24); proposals.markShown(next.id, 25); proposals.outcome(next.id, 'never_this_kind', 26);
    const retracted = offer('third', 27); proposals.outcome(retracted.id, 'retracted', 28);
    collectProposalMeasures(proposals, store); collectProposalMeasures(proposals, store);
    expect(db.prepare('SELECT name,dimensions FROM proactive_measures ORDER BY id').all()).toEqual([
      { name: 'digest.first_response', dimensions: JSON.stringify({ outcome: 'owner_responded' }) },
      { name: 'proposal.outcome', dimensions: JSON.stringify({ outcome: 'never_this_kind', kind: 'schedule' }) },
    ]);
    store.writeSetting('metrics.opt_in', false); expect(store.measure('clock.answer', 1, { channel: 'telegram' }, 30, 'new')).toBe(false);
    expect(db.prepare('SELECT count(*) AS n FROM proactive_measures').get()).toEqual({ n: 2 });
  } finally { db.close(); }
});

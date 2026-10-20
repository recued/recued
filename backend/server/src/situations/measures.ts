import type { SituationCluster, SituationRef } from '@recued/contracts';
import type { SituationStore } from '../storage/situation-store.js';
import type { ProactiveProposalStore } from '../storage/proactive-proposal-store.js';

const key = (ref: SituationRef) => JSON.stringify([ref.collection, ref.id]);
interface FirstDigest { at: number; refs: string[] }
export const recordFirstDigest = (store: SituationStore, clusters: readonly SituationCluster[], at: number): void => {
  if (!store.readSetting('metrics.opt_in', false) || store.readSetting<FirstDigest | null>('metrics.first_digest', null)) return;
  store.writeSetting('metrics.first_digest', { at, refs: [...new Set(clusters.flatMap(cluster => [...cluster.subjects, ...cluster.items.map(item => item.ref)]).map(key))] });
};
export const recordDigestResponse = (store: SituationStore, refs: readonly SituationRef[], at: number): void => {
  if (!store.readSetting('metrics.opt_in', false)) return;
  const first = store.readSetting<FirstDigest | null>('metrics.first_digest', null);
  if (first && at >= first.at && refs.some(ref => first.refs.includes(key(ref)))) store.measure('digest.first_response', 1, { outcome: 'owner_responded' }, at, 'digest:first-response');
};
/** Reads actual decisions only. Receipt keys make retries and restarts inert;
 * the opt-in store never writes counts for merely opening a page. */
export const collectProposalMeasures = (proposals: ProactiveProposalStore, store: SituationStore): void => {
  if (!store.readSetting('metrics.opt_in', false)) return;
  let cursor = store.readSetting('metrics.proposal_cursor', 0);
  for (;;) {
    const rows = proposals.outcomes(cursor); if (!rows.length) break;
    for (const outcome of rows) {
      if (outcome.actor === 'owner') {
        const proposal = proposals.read(outcome.proposal_id);
        store.measure('proposal.outcome', 1, { outcome: outcome.outcome, kind: proposal?.kind ?? 'deleted' }, outcome.at, `proposal-outcome:${outcome.id}`);
        if (proposal?.subject) recordDigestResponse(store, [proposal.subject], outcome.at);
      }
      cursor = outcome.id;
    }
    store.writeSetting('metrics.proposal_cursor', cursor);
  }
};

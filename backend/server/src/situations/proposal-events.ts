import { isAssetDate, calendarDayMs, type ProactiveProposal, type SituationSnapshot } from '@recued/contracts';
import type { ProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import type { SituationStore } from '../storage/situation-store.js';
import type { SphereStore } from '../storage/sphere-store.js';

export const proposalSituation = (proposal: ProactiveProposal, spheres?: SphereStore): SituationSnapshot => {
  const target = proposal.subject ?? proposal.result ?? proposal.sources[0] ?? { collection: 'proposal', id: proposal.id };
  const evidence = proposal.sources; const basis = proposal.origin === 'owner' ? 'declared' as const : 'inferred' as const;
  const sphere = spheres?.resolve(target).sphere;
  const at = isAssetDate(proposal.payload.occasion_on) ? calendarDayMs(proposal.payload.occasion_on)! : null;
  const span = at === null ? null : { from: at, to: at };
  return { id: `proposal:${proposal.id}`, state: proposal.state === 'retracted' ? 'resolved' : proposal.state,
    urgency: 'routine', proposal: { kind: proposal.kind, text: proposal.explanation, target },
    ...(proposal.dismissal && proposal.dismissal !== 'not_an_asset' ? { dismissal: proposal.dismissal } : {}),
    cluster: { id: `proposal:${proposal.id}`, subjects: [target], span, omitted: 0, items: [{ ref: target, kind: 'proposal',
      what: { value: proposal.title, verdict: 'match', basis, evidence }, when: { value: span, verdict: span ? 'match' : 'unknown', basis, evidence },
      where: { value: null, verdict: 'unknown', basis, evidence }, who: { value: null, verdict: 'unknown', basis, evidence },
      basis, evidence, reasons: ['related'], consequence: 'routine', ...(sphere ? { sphere } : {}), updated_at: proposal.updated_at }] } };
};

/** The proposal write and outbox entry share one transaction. Replaying after
 * a failed acknowledgement reuses the semantic situation revision. */
export const publishProposalEvents = (proposals: ProactiveProposalStore, situations: SituationStore, spheres?: SphereStore): void => {
  for (;;) {
    const page = proposals.pendingEvents(100); if (!page.length) return;
    for (const event of page) {
      situations.save(proposalSituation(event.proposal, spheres), { source: `proposal:${event.proposal.id}`, revision: event.revision }, event.at);
      proposals.acknowledgeEvent(event.revision);
    }
  }
};

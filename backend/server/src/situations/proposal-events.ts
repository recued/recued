import { isAssetDate, calendarDayMs, type ProactiveProposal, type SituationSnapshot } from '@recued/contracts';
import { hasNativeProposalEvents, type ProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import type { PublicationSituationBatch, SituationStore } from '../storage/situation-store.js';
import type { SpherePlacement, SphereStore } from '../storage/sphere-store.js';

const proposalTarget = (proposal: ProactiveProposal) => proposal.subject ?? proposal.result ?? proposal.sources[0] ?? { collection: 'proposal', id: proposal.id };
export const proposalSituation = (proposal: ProactiveProposal, spheres?: SphereStore, placement?: SpherePlacement): SituationSnapshot => {
  const target = proposalTarget(proposal);
  const evidence = proposal.sources; const basis = proposal.origin === 'owner' ? 'declared' as const : 'inferred' as const;
  const sphere = (placement ?? spheres?.resolve(target))?.sphere;
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
    let assets: ReturnType<SphereStore['prefetchAssetPlacements']>;
    let priors: PublicationSituationBatch | undefined;
    let nativeEvents = false;
    try { nativeEvents = hasNativeProposalEvents(proposals); } catch { /* Custom event readers keep their original path. */ }
    let attempted = false;
    for (let index = 0; index < page.length; index++) {
      const event = page[index]!;
      const target = proposalTarget(event.proposal);
      const cached = target.collection === 'asset' ? priors : undefined;
      // A non-asset save can update a later asset event's situation without
      // consuming its cached prior. Keep fresh priors for the rest of this page.
      if (target.collection !== 'asset') priors = undefined;
      const project = () => {
        const placement = target.collection === 'asset' ? assets?.read(target.id) ?? spheres?.resolve(target) : undefined;
        // Pins keep their cheap point path. The first event starts a batch for
        // later events; native prior reads share its existing freshness checks.
        if (!attempted && placement && !placement.pinned) {
          attempted = true;
          try {
            const later = page.slice(index + 1).map(row => ({ row, target: proposalTarget(row.proposal) })).filter(next => next.target.collection === 'asset');
            if (later.length > 1) assets = spheres?.prefetchAssetPlacements(later.map(next => next.target.id));
            if (assets && nativeEvents) priors = situations.prefetchForPublication?.(later.map(next => `proposal:${next.row.proposal.id}`), assets);
          } catch { /* Ordered point reads retain earlier saves before a later legacy error. */ }
        }
        return proposalSituation(event.proposal, spheres, placement);
      };
      let saved = false; let acknowledged = false;
      const wrote: Parameters<SituationStore['save']>[3] = (rows, connection) => { saved = true; assets?.wrote(rows, connection); };
      if (cached) cached.save(project, { source: `proposal:${event.proposal.id}`, revision: event.revision }, event.at, wrote);
      else situations.save(project(), { source: `proposal:${event.proposal.id}`, revision: event.revision }, event.at, wrote);
      if (!saved) { assets?.invalidate(); assets = undefined; }
      proposals.acknowledgeEvent(event.revision, (rows, connection) => { acknowledged = true; assets?.wrote(rows, connection); });
      if (!acknowledged) { assets?.invalidate(); assets = undefined; }
    }
  }
};

/** D-261 prompts project the same proposal/decision as the owner UI. They
 * cannot turn a generic notification answer into a grant. */
import { PREAPPROVAL_NOTIFICATION_HANDLER } from '@recued/contracts';
import { preflightAskHolds } from '@recued/gateway';
import { createProtectedAskController, type NotificationBlock } from '@recued/notification';
import type { PreapprovalRepository, PreapprovalPrompt } from './storage/preapproval-repository.js';
import type { GatedActionStore } from './gated-action-store.js';

/** Close the approvals of holds whose reviewed execution stopped: each such hold's receipt is
 *  closed, and the approval with it. A round's gathered approval (D-177 §N.15.9) answers several
 *  holds: it closes once every one of them stopped, and until then a yes passes over a stopped
 *  one, whose receipt is closed. */
export const closeStoppedHoldAsks = async (deps: {
  readonly block: Pick<NotificationBlock, 'listOpenAsks' | 'cancelAsk'>;
  readonly checkpointWasStopped: (checkpoint_id: string, run_id: string) => boolean;
  readonly gatedActions?: Pick<GatedActionStore, 'getByCheckpoint' | 'finish'>;
}): Promise<void> => {
  for (const ask of await deps.block.listOpenAsks()) {
    const holds = preflightAskHolds(ask);
    const stopped = holds.flatMap(({ checkpoint_id, run_id }) =>
      checkpoint_id !== undefined && run_id !== undefined && deps.checkpointWasStopped(checkpoint_id, run_id)
        ? [{ checkpoint_id, run_id }] : []);
    for (const { checkpoint_id, run_id } of stopped) {
      const receipt = await deps.gatedActions?.getByCheckpoint(checkpoint_id);
      if (receipt?.run_id === run_id) await deps.gatedActions!.finish(receipt.action_ref, {
        status: 'cancelled', status_message: 'The enclosing reviewed execution stopped.', result: null,
        awaiting_checkpoint: { run_id, checkpoint_id },
      });
    }
    if (stopped.length > 0 && stopped.length === holds.length) await deps.block.cancelAsk(ask.ask_id);
  }
};

const promptPayload = (prompt: PreapprovalPrompt): Record<string, unknown> => ({
  proposal_id: prompt.proposal_id, proposal_revision: prompt.proposal_revision, review_digest: prompt.review_digest,
});
export const createPreapprovalNotifications = (deps: {
  repository: PreapprovalRepository;
  block: NotificationBlock;
  gatedActions?: GatedActionStore;
  /** Paired webclient route, never the public bearer /ask landing. */
  reviewLink(proposalId: string): string | null;
}) => {
  const controller = createProtectedAskController(deps.block, PREAPPROVAL_NOTIFICATION_HANDLER, {
    canDeliverTo: channel => channel.name === 'ui',
    async validatePrompt(askId, payload) { deps.repository.validatePrompt(askId, payload); },
    async resolveProjection(ask) {
      const projection = deps.repository.projectPrompt(ask.ask_id, ask.handler_payload);
      if (projection.kind === 'pending') return null;
      if (projection.kind === 'stopped') return projection;
      return { kind: 'decision', decision_id: projection.receipt.decision_id,
        answer: { option: projection.receipt.decision, answered_at: projection.receipt.decided_at },
        via: projection.channel === 'webclient' ? 'ui' : 'telegram' };
    },
  });
  return {
    async closeStoppedAsks(): Promise<void> {
      await closeStoppedHoldAsks({
        block: deps.block,
        checkpointWasStopped: (checkpoint_id, run_id) => deps.repository.checkpointWasStopped(checkpoint_id, run_id),
        ...(deps.gatedActions !== undefined ? { gatedActions: deps.gatedActions } : {}),
      });
    },
    /** Called by the shared outbox for review/decision/stop events, and for
     * pending proposals at boot. It never leases or discards activation work. */
    async project(proposalId: string): Promise<void> {
      const current = deps.repository.reservePrompt(proposalId);
      for (const prompt of deps.repository.listPrompts(proposalId)) {
        if (await deps.block.getAsk(prompt.ask_id)) await controller.project(prompt.ask_id);
      }
      if (!current) return;
      const link = deps.reviewLink(proposalId);
      await controller.ask({ title: 'Review future execution',
        text: 'Review the selected operations and their required reads before this action runs.',
        ...(link ? { link_url: link } : {}) }, [
        { id: 'approve', label: 'Review and approve' },
        { id: 'deny', label: 'Decline' },
        { id: 'cancel', label: 'Cancel action' },
      ], promptPayload(current), { intent: 'interactive' }, {
        reserved_ask_id: current.ask_id,
        // Exact replay redelivers an interrupted notification from this
        // durable reservation; no process-local delivery map is authority.
        on_persisted: async askId => { deps.repository.validatePrompt(askId, promptPayload(current)); },
      });
      // The owner may have decided while channel delivery was awaiting I/O.
      // Re-project that receipt so a late render cannot leave an open prompt.
      await controller.project(current.ask_id);
    },
  };
};

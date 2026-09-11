/** Delivery projects a durable proposal. It cannot decide or activate it. */
import type { PreapprovalStorage } from './storage/preapproval-storage.js';
import type { PreapprovalActivations } from './storage/preapproval-activations.js';
import type { createPreapprovalNotifications } from './preapproval-notifications.js';
import type { createPreapprovalTelegramDelivery } from './preapproval-telegram-delivery.js';

export const createPreapprovalOutbox = (deps: {
  storage: PreapprovalStorage; activations: PreapprovalActivations;
  notifications: ReturnType<typeof createPreapprovalNotifications>;
  telegram?: ReturnType<typeof createPreapprovalTelegramDelivery>;
  maintain?: () => void | Promise<void>;
  onActivationChanged?: () => void | Promise<void>;
  onError?: (error: unknown) => void;
}) => ({
  async drain(): Promise<void> {
    if (!deps.storage.isReady()) return;
    await deps.maintain?.();
    await deps.notifications.closeStoppedAsks();
    const repository = deps.storage.repository;
    const workerId = deps.storage.workers.worker_id;
    for (const item of repository.takeOutbox(workerId)) {
      try {
        const state = await repository.inspectExecution(item.future_ref);
        const prompts = repository.listPrompts(state.proposal_id);
        if (item.kind === 'review_requested' || prompts.length > 0) {
          await deps.notifications.project(state.proposal_id);
          if (state.status === 'awaiting_owner') await deps.telegram?.deliver(state.proposal_id);
          else await deps.telegram?.close(state.proposal_id);
        }
        deps.activations.retire(item.future_ref);
        if (item.kind === 'decision' || item.kind.startsWith('execution_') || item.kind.startsWith('reconciliation:')) {
          await deps.onActivationChanged?.();
        }
        repository.finishOutbox(item.event_id, workerId);
      } catch (error) {
        // The lease is retried by the owned scheduler; persistence and owner
        // decision remain authoritative even when a delivery channel fails.
        if (deps.onError) deps.onError(error);
        else console.warn('[preapproval] owner review delivery pending', error);
      }
    }
    await repository.retireReviewContent();
  },
});

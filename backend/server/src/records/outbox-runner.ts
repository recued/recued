import { RECORDS_MAX_CAUSAL_DEPTH } from '@recued/contracts';

import type { RecordsStore } from './store.js';
import type { RecordsSubscriberBinding } from './subscribers.js';

export interface RecordsWatcherDispatch {
  event: ReturnType<RecordsStore['listOutbox']>[number];
  subscriber: RecordsSubscriberBinding;
  mutation_context: {
    root_event_id: string;
    causal_depth: number;
    watcher_digest: string;
  };
}

export interface RecordsOutboxRuntime {
  /** Re-check recipe body, trigger registration, grants/config and revocation
   * against the exact installed binding before crossing a side-effect seam. */
  admit(subscriber: RecordsSubscriberBinding): boolean | Promise<boolean>;
  deliver(dispatch: RecordsWatcherDispatch): Promise<void>;
}

export interface RecordsOutboxDrainResult {
  attempted: number;
  delivered: number;
  retried: number;
  dead_lettered: number;
}

export const drainRecordsOutboxOnce = async (
  store: RecordsStore,
  runtime: RecordsOutboxRuntime,
  options: { limit?: number; max_retries?: number } = {},
): Promise<RecordsOutboxDrainResult> => {
  const deliveries = store.listPendingDeliveries(options.limit);
  const result: RecordsOutboxDrainResult = {
    attempted: deliveries.length,
    delivered: 0,
    retried: 0,
    dead_lettered: 0,
  };
  for (const delivery of deliveries) {
    const { event, subscriber } = delivery;
    const namespace = store.getNamespace(event.owner);
    const bindingCurrent = namespace?.state.state === 'ready'
      && namespace.activation_generation === event.activation_generation
      && namespace.subscriber_digest === event.subscriber_digest
      && await runtime.admit(subscriber);
    const recursion = delivery.watcher_digest === subscriber.binding_digest;
    const exhausted = delivery.causal_depth >= RECORDS_MAX_CAUSAL_DEPTH;
    if (!bindingCurrent || recursion || exhausted) {
      const reason = !bindingCurrent
        ? 'Records watcher binding/activation is no longer admitted'
        : recursion
          ? 'Records watcher direct recursion refused'
          : 'Records watcher causal depth exhausted';
      if (store.failDelivery(event.event_id, subscriber.binding_digest, reason, 1)) {
        result.dead_lettered += 1;
      }
      continue;
    }
    try {
      await runtime.deliver({
        event,
        subscriber,
        mutation_context: {
          root_event_id: delivery.root_event_id,
          causal_depth: delivery.causal_depth + 1,
          watcher_digest: subscriber.binding_digest,
        },
      });
      if (store.acknowledgeDelivery(event.event_id, subscriber.binding_digest)) {
        result.delivered += 1;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const maxRetries = options.max_retries ?? 10;
      if (store.failDelivery(event.event_id, subscriber.binding_digest, reason, maxRetries)) {
        if (delivery.retry_count + 1 >= maxRetries) result.dead_lettered += 1;
        else result.retried += 1;
      }
    }
  }
  return result;
};

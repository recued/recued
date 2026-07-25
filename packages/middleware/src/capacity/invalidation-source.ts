/** D-145 PB1.3 — default in-process `CapacityInvalidationSource`.
 *
 *  Thin pub/sub keyed by topic. Each underlying source-store
 *  (PA11 work-entity store, D-125 connection store, ingredient
 *  store, D-132 quota store, D-148 Bridge state probe) calls
 *  `publish()` from its existing mutation paths; the cache
 *  subscribes per-topic at boot.
 *
 *  Spec: § B.4. Design: § PB1.3 + § N.11. */

import type {
  CapacityInvalidationPayload,
  CapacityInvalidationSource,
  CapacityInvalidationSubscription,
  CapacityInvalidationTopic,
} from '@recued/contracts';

type Handler = (payload: CapacityInvalidationPayload) => void;

export const createCapacityInvalidationSource = (): CapacityInvalidationSource => {
  const handlers = new Map<CapacityInvalidationTopic, Set<Handler>>();

  return {
    subscribe(topic, handler): CapacityInvalidationSubscription {
      let set = handlers.get(topic);
      if (!set) {
        set = new Set();
        handlers.set(topic, set);
      }
      set.add(handler);
      return {
        topic,
        unsubscribe: () => {
          const s = handlers.get(topic);
          if (!s) return;
          s.delete(handler);
          if (s.size === 0) handlers.delete(topic);
        },
      };
    },
    publish(payload): void {
      const s = handlers.get(payload.topic);
      if (!s) return;
      // Snapshot the handler set in case a handler unsubscribes
      // mid-iteration; sync dispatch keeps cache invalidation
      // ordering deterministic with the publishing mutation.
      for (const h of [...s]) h(payload);
    },
  };
};

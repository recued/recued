/** D-121 / D-138 — contact substrate composer.
 *
 *  Builds the `data.contact` warehouse store + its merge collaborators
 *  (re-merge prompt store, cycle observer) + the upstream-merge outbox
 *  store, and kicks the boot backfill. Gated on `db` — dbless harnesses
 *  leave every field undefined so the rpc surface returns
 *  `not_configured`.
 *
 *  Self-references inside the cluster (the contact store's
 *  `onContactUpserted` reads its own `detectInlineMergeCandidates`
 *  result; `onPlatformLinkChanged` routes to the cycle observer
 *  constructed below the store) flow through forward-declared `let`
 *  bindings the closures capture by reference. The construction order
 *  inside the composer matches the prior inline ordering in bin.ts. */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { WarehouseEventBus } from '@recued/warehouse-events';

import type { EventBus } from '../../events/bus.js';
import type { CascadeEngine } from '../../storage/enrichment-cascade.js';
import {
  createContactStore,
  detectInlineMergeCandidates,
  type ContactStore,
} from '../../storage/contact-store.js';
import {
  createRemergePromptStore,
  type ServerRemergePromptStore,
} from '../../contact-merge-prompt-store.js';
import {
  createContactMergeCycleObserver,
  type ContactMergeCycleObserver,
} from '../../contact-merge-cycle-observer.js';
import {
  createUpstreamMergeStore,
  type UpstreamMergeStore,
} from '../../storage/upstream-merge-store.js';
import { backfillContacts } from '../../warehouse/contact-backfill.js';

export interface ComposeContactStoreDeps {
  /** SQLite handle. Undefined → composer returns all-undefined bundle. */
  db: Database.Database | undefined;
  /** Warehouse bus the store emits `data.contact.*` events onto. */
  warehouseBus: WarehouseEventBus;
  /** Broadcast bus the inline-detector emits `merge_candidate.inserted`
   *  events onto. */
  eventBus: EventBus;
  /** Optional enrichment cascade. When provided, contact deletes
   *  cascade per-record enrichment rows + trim members_list aggregates
   *  that referenced the email (D-122 Phase 4.5). The original wiring
   *  pinned the cascade by closure at construction time — same here:
   *  pass it in only when it's already composed. */
  enrichmentCascade?: CascadeEngine;
}

export interface ContactStoreBundle {
  contactStore: ContactStore | undefined;
  remergePromptStore: ServerRemergePromptStore | undefined;
  contactMergeCycleObserver: ContactMergeCycleObserver | undefined;
  upstreamMergeStore: UpstreamMergeStore | undefined;
  /** Completion of the one-shot boot backfill. Rejections are contained, but
   *  shutdown must await settlement before closing SQLite. */
  backfillDone: Promise<void> | undefined;
}

export const composeContactStore = (
  deps: ComposeContactStoreDeps,
): ContactStoreBundle => {
  const { db, warehouseBus, eventBus, enrichmentCascade } = deps;

  if (!db) {
    return {
      contactStore: undefined,
      remergePromptStore: undefined,
      contactMergeCycleObserver: undefined,
      upstreamMergeStore: undefined,
      backfillDone: undefined,
    };
  }

  // Forward-declared so the store's `onContactUpserted` /
  // `onPlatformLinkChanged` callbacks can reference the store + the
  // observer constructed below. Both bindings are assigned before any
  // external caller can drive a mutation: `store` is set on the next
  // line, and `observer` is set before the composer returns
  // (`backfillContacts` only writes through `store.observeBatch`,
  // which doesn't trigger `onPlatformLinkChanged`).
  let store: ContactStore | undefined;
  let observer: ContactMergeCycleObserver | undefined;

  store = createContactStore(db, {
    bus: warehouseBus,
    // D-122 Phase 4.5 — drop the deleted contact's per-record
    // enrichment rows + trim members_list cascades that referenced
    // the email. D-145 § A.7.9 widened deletion from `dependent` to
    // every per-record policy except `independent`; the cascade
    // engine handles the per-policy dispatch. Best-effort —
    // exceptions inside the cascade are swallowed by the store
    // wrapper.
    ...(enrichmentCascade
      ? {
          onDelete: (email: string) => {
            enrichmentCascade.cascadeForSourceDelete('contact', email);
          },
        }
      : {}),
    // D-138 P1 — inline-detection hook. Every contact upsert that
    // didn't auto-merge on email-match runs the predicate against
    // the existing graph and enqueues candidates that pass.
    // Fire-and-forget; the store catches exceptions so an over-
    // budget scan can't break the underlying write. Inserted
    // candidates flow onto the broadcast bus via the contact-merge
    // handler's `emitMergeCandidate` dep — for inline-detected rows
    // we emit directly here so the Settings badge updates without
    // routing through an rpc.
    onContactUpserted: (record) => {
      if (!store) return;
      try {
        const candidates = detectInlineMergeCandidates(store, record, {
          nowFn: () => Date.now(),
          idFactory: () => randomUUID(),
          detected_by: 'inline',
        });
        for (const cand of candidates) {
          try {
            eventBus.emit({
              kind: 'merge_candidate',
              subkind: 'inserted',
              candidate_id: cand.id,
              pair_key: cand.pair_key,
            });
          } catch {
            /* bus emit is best-effort */
          }
        }
      } catch {
        /* detection is best-effort */
      }
    },
    // D-138 P3 — platform-link change hook routes to the cycle
    // observer (constructed below). Outside an active cycle the
    // observer's record() is a no-op (per spec § A.10 Reviewer #11
    // — between-cycle webhook deletes don't trigger A.10 prompts).
    onPlatformLinkChanged: (change) => {
      observer?.recordChange(change);
    },
  });

  const remergePromptStore = createRemergePromptStore(db);
  observer = createContactMergeCycleObserver({
    store,
    promptStore: remergePromptStore,
    eventBus,
  });

  // D-138 P5 — outbox store. The vendor-merger registry that
  // accompanies it is populated later in bin.ts once the connection
  // store + auth-refresh hook are composed; the store itself only
  // needs the SQLite handle.
  const upstreamMergeStore = createUpstreamMergeStore(db);

  // D-121 Phase 1 — boot backfill. Idempotent (first-seen-wins per
  // canonical email); subsequent boots only bump interaction_count
  // on contacts that survived prior runs. Errors swallowed so a
  // corrupt warehouse row never blocks startup.
  const backfillDone = backfillContacts(db, store).then(
    () => undefined,
    () => {
      // Best-effort — the broadcast bus (Phase 6) surfaces per-batch
      // progress + per-row errors; a console breadcrumb is enough.
    },
  );

  return {
    contactStore: store,
    remergePromptStore,
    contactMergeCycleObserver: observer,
    upstreamMergeStore,
    backfillDone,
  };
};

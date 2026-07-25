/** D-145 PB13 — RecuedPlan store composer (substrate slice).
 *
 *  Produces the signing-wrapped `RecuedPlanStore` + a `persist`
 *  callback whose shape matches `ExecuteRecuedRequestContext.persist?`
 *  in `packages/middleware/src/orchestrator/execute-recued-request.ts`.
 *  The D-173 reception compose-propose path is the live producer:
 *  `reception-rpc-handler.ts` runs `executeRecuedRequest` with this
 *  `persist` callback, so a `RecuedPlan` is written per compose
 *  request. Future readers (the un-implemented `context_packet_quality`
 *  PA9 producer / a `recued.plan.list` rpc) consume the same store.
 *
 *  Storage backing: caller-injected + REQUIRED — no default. The choice
 *  of where audit records live is durability-critical, so each caller
 *  picks it explicitly (matching the `createCommitStore` /
 *  `composeNotificationBlock` convention). Production threads a
 *  SQLite-backed `Collection<RecuedPlan>`
 *  (`createSQLiteCollection(db, 'recued_plans')` at
 *  `serve/compose-storage-context.ts`) so the signed plan — a
 *  tamper-evident audit record of each AI compose decision — survives
 *  restart; tests + ephemeral callers pass
 *  `createInMemoryCollection<RecuedPlan>()`. The store + signing wrapper
 *  are backing-agnostic by construction
 *  (`packages/storage/src/recued-plan.ts`).
 *
 *  Signing gate: the `createSigningRecuedPlanStore` wrapper auto-signs
 *  plans whose `audit_policy.high_assurance: true` and passes others
 *  through unsigned. `getServerIdentity` is invoked per `append` (not
 *  cached) so post-rotation writes use the fresh key automatically. */

import {
  createRecuedPlanStore,
  type Collection,
  type RecuedPlanStore,
} from '@recued/storage';
import type { RecuedPlan } from '@recued/contracts';

import type { Ed25519Keypair } from '../../keys/index.js';
import { createSigningRecuedPlanStore } from '../../recued-plan/signing.js';

export interface ComposeRecuedPlanStoreInput {
  /** Resolver for the current `server_identity_key`. Wrapped by the
   *  signing store and invoked per `append` so post-rotation writes
   *  use the new key without the composer reaching for the
   *  `ServerIdentity` again. Production threads
   *  `() => serverIdentity.serverIdentityKey()`; tests pass a
   *  one-shot static resolver. */
  getServerIdentity: () => Ed25519Keypair;
  /** Backing collection for the plan store. Required — the durability
   *  of a signed audit record is too important to default silently.
   *  Production threads a SQLite-backed collection
   *  (`createSQLiteCollection<RecuedPlan>(db, 'recued_plans')`) so plans
   *  survive restart; tests + ephemeral callers pass
   *  `createInMemoryCollection<RecuedPlan>()`. The store + signing
   *  wrapper are backing-agnostic by construction
   *  (`packages/storage/src/recued-plan.ts`). */
  backing: Collection<RecuedPlan>;
}

export interface RecuedPlanStoreBundle {
  /** The signing-wrapped store. Exposed so direct callers (housekeeping
   *  producers like `context_packet_quality`, future `recued.plan.list`
   *  rpcs) can read persisted plans without re-constructing the
   *  signing chain. */
  recuedPlanStore: RecuedPlanStore;
  /** Callback shape compatible with
   *  `ExecuteRecuedRequestContext.persist?` in
   *  `packages/middleware/src/orchestrator/execute-recued-request.ts`.
   *  Pre-bound to the signing store's `append` so consumers don't
   *  re-resolve the store at call time. */
  executeRecuedRequestPersist: (plan: RecuedPlan) => Promise<void>;
}

export const composeRecuedPlanStore = (
  input: ComposeRecuedPlanStoreInput,
): RecuedPlanStoreBundle => {
  const base = createRecuedPlanStore(input.backing);
  const signing = createSigningRecuedPlanStore(base, {
    getServerIdentity: input.getServerIdentity,
  });
  return {
    recuedPlanStore: signing,
    executeRecuedRequestPersist: (plan) => signing.append(plan),
  };
};

/** One D-261 repository per realm. Late host composition can supply live
 * authority/activation resolvers only; actual receipt and commit writes are
 * fixed here to the same SQLite connection. Unwired calls fail closed. */
import type Database from 'better-sqlite3';
import { RpcError } from '@recued/contracts';
import type { SqliteGatedActionChangeClock } from '../gated-action-store.js';
import { createPreapprovalCodec } from './preapproval-codec.js';
import { createSqlitePreapprovalDispatchParticipant } from './preapproval-dispatch-participant.js';
import { PreapprovalRepository, type PreapprovalAtomicHooks } from './preapproval-repository.js';
import { createPreapprovalWorkers, type PreapprovalWorkers } from './preapproval-workers.js';
import { registerPreapprovalInvalidator } from './preapproval-lifecycle.js';
import { createMailDraftStore, type MailDraftStore } from './mail-drafts.js';
import { createPreapprovalTriggerIngress, type PreapprovalTriggerIngress } from './preapproval-trigger-ingress.js';
import type { PreapprovalRequestLimits } from '../preapproval-limits.js';

export type PreapprovalHostRuntime = Omit<PreapprovalAtomicHooks, 'createDispatch' | 'settleDispatch'> & {
  buildPendingCommit: Parameters<typeof createSqlitePreapprovalDispatchParticipant>[2]['buildPendingCommit'];
};
export interface PreapprovalStorage {
  repository: PreapprovalRepository;
  workers: PreapprovalWorkers;
  drafts: MailDraftStore;
  triggerIngress: PreapprovalTriggerIngress;
  /** False while locked; no D-261 request or activation may run until this
   * succeeds. The normal unlock UI remains available during that interval. */
  recover(): Promise<boolean>;
  isReady(): boolean;
  /** Host boot only; this is never an RPC, kernel dispatcher or recipe field. */
  configureRuntime(runtime: PreapprovalHostRuntime): void;
}
export const createPreapprovalStorage = (
  db: Database.Database, clock: SqliteGatedActionChangeClock,
  getKey: () => Uint8Array | null,
  options: { now?: () => number; limits?: Partial<PreapprovalRequestLimits> } = {},
): PreapprovalStorage => {
  let runtime: PreapprovalHostRuntime | undefined;
  let recovered = false;
  let recovering: Promise<boolean> | undefined;
  const requireRuntime = (): PreapprovalHostRuntime => {
    if (!runtime) throw new RpcError('preapproval_unsupported', 'Pre-approval runtime is not configured.', 503);
    if (!recovered) throw new RpcError('preapproval_unsupported', 'Pre-approval recovery is not complete.', 503);
    return runtime;
  };
  const participants = createSqlitePreapprovalDispatchParticipant(db, clock, {
    ...(options.now ? { now: options.now } : {}),
    buildPendingCommit: (claim, member, plan) => requireRuntime().buildPendingCommit(claim, member, plan),
  });
  const workers = createPreapprovalWorkers(db);
  const codec = createPreapprovalCodec(getKey);
  const drafts = createMailDraftStore(db, codec, options.now);
  const repository = new PreapprovalRepository(db, {
    codec, workers,
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.now ? { now: options.now } : {}),
    hooks: {
      ...participants,
      validateLive: (plan, stage, member) => requireRuntime().validateLive(plan, stage, member),
      validateOrdinaryRecipe: (plan, continuation) => {
        const validate = requireRuntime().validateOrdinaryRecipe;
        if (!validate) throw new RpcError('preapproval_unsupported', 'Ordinary nested continuations are unavailable.', 503);
        validate(plan, continuation);
      },
      validateResponder: responder => requireRuntime().validateResponder(responder),
      activate: (plan, activation) => requireRuntime().activate(plan, activation),
      selectOccurrence: (plan, candidate) => requireRuntime().selectOccurrence(plan, candidate),
      stop: (plan, futureRef, reason) => requireRuntime().stop(plan, futureRef, reason),
    },
  });
  registerPreapprovalInvalidator(db, (kind, key, incarnation) => repository.invalidateDependency(kind, key, incarnation));
  const triggerIngress = createPreapprovalTriggerIngress(db, codec, options.now, futureRef => repository.stopOversizedTrigger(futureRef));
  return {
    repository, workers, drafts, triggerIngress,
    isReady: () => recovered && runtime !== undefined && getKey() !== null,
    recover() {
      if (recovered) return Promise.resolve(true);
      if (recovering) return recovering;
      recovering = (async () => {
        try {
          let cursor = '';
          while (true) {
            const batch = await repository.recoverInterruptedRuns(workers.worker_id, 100, cursor);
            if (batch.length < 100) break;
            cursor = batch[batch.length - 1]!.future_execution_ref;
          }
          recovered = true;
          return true;
        } catch (error) {
          if (error instanceof RpcError && error.code === 'server_locked') return false;
          throw error;
        } finally { recovering = undefined; }
      })();
      return recovering;
    },
    configureRuntime(value) {
      if (runtime && runtime !== value) throw new Error('The realm pre-approval runtime is already configured.');
      runtime = value;
    },
  };
};

import { RpcError, type ExecutionSource } from '@recued/contracts';
import { canonicalHash, recordsCatalogSlug } from '@recued/ingredient-authoring';

import { handleExecute, type ExecuteHandlerDeps } from '../../execute-handler.js';
import { settleWithin, STOP_GRACE_MS } from '../../lifecycle/settle-within.js';
import type { RecipeStore } from '../../recipe-store.js';
import type { ContractStore } from '../../storage/contract-store.js';
import {
  deriveRecordsSubscriberBindings,
  drainRecordsOutboxOnce,
  RecordsOutboxStopping,
  recordsSubscriberGrantSnapshotMatches,
  type RecordsStore,
  type RecordsSubscriberBinding,
} from '../../records/index.js';
import type { BackgroundServiceRegistry } from './wire-background-services.js';

export interface ComposeRecordsOutboxInput {
  recordsStore: RecordsStore;
  recipeStore: RecipeStore;
  contractStore?: Pick<ContractStore, 'scan'>;
  executeDeps: ExecuteHandlerDeps;
  backgroundServices: BackgroundServiceRegistry;
  intervalMs?: number;
  /** The server has begun stopping (its restart drain): no pass starts, and a
   *  pass in progress delivers nothing more. Absent ⇒ the execute path's own
   *  drain signal, `executeDeps.isDraining`, read on every check (it is bound
   *  late, where the lifecycle exists). */
  isStopping?: () => boolean;
}

const REACTIVE_SYSTEM: ExecutionSource = {
  channel: 'reactive',
  actor: 'system',
  event_kind: 'records.outbox',
  source_recipe: 'records-outbox',
};

/** Start the production durable Records watcher drain.
 *
 *  Stopping (a restart): a pass runs watcher recipes one after another, up to a
 *  hundred, and used to be stopped only by the timer drain late in the restart,
 *  which waited for the whole pass — while the 1 s timer kept starting new
 *  passes whose runs the draining server refused, each refusal counting toward
 *  the delivery's retry cap. Now no pass starts once the server is stopping, a
 *  pass in progress ends before its next delivery with that one and every one
 *  after it still pending for the next boot, and `stop()` waits for the run in
 *  flight at most `STOP_GRACE_MS`. A run the server refused (`draining`) or the
 *  restart stopped counts no retry (`RecordsOutboxStopping`): as after a crash,
 *  its delivery is simply still pending. */
export const composeRecordsOutbox = (input: ComposeRecordsOutboxInput): void => {
  // `admit` cannot clear a delivery without the grant store, and a refused
  // admission DEAD-LETTERS on the first attempt (`failDelivery(..., 1)`) — that
  // is correct for a revoked grant and wrong for an absent store, where the
  // answer is unknown rather than no. Running the drain grant-blind would
  // destroy every queued watcher event on the first tick, so it does not run:
  // deliveries stay pending until a boot that can actually authorize them.
  if (!input.contractStore) {
    console.warn(
      '[records-outbox] no contract grant store — watcher drain not started; '
      + 'queued Records events stay pending rather than dead-lettering unauthorized',
    );
    return;
  }
  const serverStopping = input.isStopping ?? ((): boolean => input.executeDeps.isDraining?.() === true);
  let stopped = false;
  /** Stopped, or the server stopping. A throwing predicate reads as
   *  stopping: delivering on an unknown answer could spend retries on runs
   *  the server refuses. */
  const stopping = (): boolean => {
    if (stopped) return true;
    try {
      return serverStopping();
    } catch {
      return true;
    }
  };
  let running: Promise<void> | null = null;
  const admit = async (subscriber: RecordsSubscriberBinding): Promise<boolean> => {
    // ⛔ THROWN, NOT ANSWERED `false`. `drainRecordsOutboxOnce` dead-letters a
    // delivery `admit` refuses (`failDelivery(..., 1)`) — right for a revoked
    // binding, and the destruction of every queued event if a stop answered
    // that way. A throw from here ends the pass before this delivery is
    // touched, leaving it and every one after it pending for the next boot.
    if (stopping()) throw new RecordsOutboxStopping();
    const stored = input.recipeStore.getStored(subscriber.recipe_id);
    const effective = input.recipeStore.get(subscriber.recipe_id);
    if (!stored || !effective
      || stored.publisher_id !== subscriber.publisher_id) return false;
    let storedBody: unknown;
    try { storedBody = JSON.parse(stored.recipe_json); } catch { return false; }
    if (await canonicalHash(storedBody) !== subscriber.recipe_digest
      || await canonicalHash(effective) !== subscriber.recipe_digest) return false;
    if (!subscriber.grant_snapshot
      || !input.contractStore
      || !recordsSubscriberGrantSnapshotMatches(
      subscriber.grant_snapshot,
      input.contractStore.scan('grant', [subscriber.grant_snapshot.installed_pack_id]),
    )) return false;
    let namespace: ReturnType<RecordsStore['listNamespaces']>[number] | undefined;
    for (const candidate of input.recordsStore.listNamespaces()) {
      if (candidate.owner.publisher !== subscriber.publisher_id
        || candidate.subscriber_digest.length === 0
        || stored.pack_slug === null) continue;
      if (stored.pack_slug === await recordsCatalogSlug(candidate.owner)) {
        namespace = candidate;
        break;
      }
    }
    if (!namespace) return false;
    const derived = deriveRecordsSubscriberBindings(namespace.owner, [{
      recipe: effective,
      publisher_id: stored.publisher_id,
      recipe_digest: subscriber.recipe_digest,
    }], subscriber.grant_snapshot);
    return derived.bindings.some((candidate) =>
      candidate.binding_digest === subscriber.binding_digest
      && candidate.trigger_index === subscriber.trigger_index);
  };
  const tick = (): void => {
    if (running !== null || stopping()) return;
    running = drainRecordsOutboxOnce(input.recordsStore, {
      admit,
      deliver: async ({ event, subscriber, mutation_context }) => {
        const namespace = input.recordsStore.getNamespace(event.owner);
        let result: Awaited<ReturnType<typeof handleExecute>>;
        try {
          result = await handleExecute(input.executeDeps, {
            recipe_id: subscriber.recipe_id,
            trigger_source: 'event_trigger',
            execution_source: REACTIVE_SYSTEM,
            context: {
              event: {
                type: event.type,
                event_id: event.event_id,
                pack_ref: `${event.owner.publisher}/${event.owner.pack_slug}`,
                pack_version: namespace?.state.state === 'ready'
                  ? namespace.state.version
                  : undefined,
                kind: event.entity,
                id: event.id,
                revision: event.revision,
                changed_fields: event.changed_fields,
                cause: event.cause,
              },
            },
          }, { records_event: mutation_context });
        } catch (error) {
          // The server refused the run because it is restarting: `admit` read
          // the same signal an instant before, and the drain began between the
          // two checks. Nothing ran.
          if (error instanceof RpcError && error.code === 'draining') throw new RecordsOutboxStopping();
          throw error;
        }
        if (!result.success && !result.trigger_skipped) {
          const first = result.errors[0] as { code?: string; message?: string } | undefined;
          // The restart stopped the run (its drain kills what is still running
          // once the grace is up): the server going away, not the watcher
          // failing. An owner's own kill outside a stop still counts.
          if ((result.run_terminated === 'killed' || first?.code === 'run_killed') && stopping()) {
            throw new RecordsOutboxStopping();
          }
          throw new Error(first?.message ?? 'Records watcher execution failed');
        }
      },
    }).then(() => undefined).catch((error) => {
      // A pass a stop ended is not a failed drain.
      if (error instanceof RecordsOutboxStopping) return;
      console.warn('[records-outbox] drain failed', error);
    }).finally(() => { running = null; });
  };
  // Its own interval rather than `registerInterval`, whose stop waits for the
  // whole tick — here a pass of watcher runs.
  const timer = setInterval(tick, input.intervalMs ?? 1_000);
  timer.unref?.();
  input.backgroundServices.register({
    name: 'records-outbox',
    kind: 'timer',
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      // The pass delivers nothing more (`admit` throws), so what is left is the
      // watcher run in flight — the restart drain's to kill, which leaves its
      // delivery pending. It gets the grace and no more.
      const pass = running;
      if (pass !== null) await settleWithin(pass, STOP_GRACE_MS);
    },
  });
  // A restart's backlog drains without waiting a full interval.
  tick();
};

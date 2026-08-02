import type { ExecutionSource } from '@recued/contracts';
import { canonicalHash, recordsCatalogSlug } from '@recued/ingredient-authoring';

import { handleExecute, type ExecuteHandlerDeps } from '../../execute-handler.js';
import type { RecipeStore } from '../../recipe-store.js';
import type { ContractStore } from '../../storage/contract-store.js';
import {
  deriveRecordsSubscriberBindings,
  drainRecordsOutboxOnce,
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
}

const REACTIVE_SYSTEM: ExecutionSource = {
  channel: 'reactive',
  actor: 'system',
  event_kind: 'records.outbox',
  source_recipe: 'records-outbox',
};

/** Start the production durable Records watcher drain. */
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
  let running = false;
  const admit = async (subscriber: RecordsSubscriberBinding): Promise<boolean> => {
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
  const tick = (): Promise<void> | void => {
    if (running) return;
    running = true;
    return drainRecordsOutboxOnce(input.recordsStore, {
      admit,
      deliver: async ({ event, subscriber, mutation_context }) => {
        const namespace = input.recordsStore.getNamespace(event.owner);
        const result = await handleExecute(input.executeDeps, {
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
        if (!result.success && !result.trigger_skipped) {
          const first = result.errors[0] as { message?: string } | undefined;
          throw new Error(first?.message ?? 'Records watcher execution failed');
        }
      },
    }).then(() => undefined).catch((error) => {
      console.warn('[records-outbox] drain failed', error);
    }).finally(() => { running = false; });
  };
  input.backgroundServices.registerInterval({
    name: 'records-outbox',
    intervalMs: input.intervalMs ?? 1_000,
    tick,
    fireImmediate: true,
  });
};

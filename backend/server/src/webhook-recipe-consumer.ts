/** D-201 Slices 4/5B2A — recipe fan-out, owner holds, and scoped event reads.
 *
 * One delivery outbox item may target multiple installed recipes. The consumer
 * store creates one durable dispatch identity per exact trigger, while the
 * injected runner must create-or-reuse a recipe run on the supplied `run_id`.
 * A crash after a run side effect therefore retries the same run identity, not
 * a second business run. Payload bytes remain behind the active-run reader.
 */

import {
  webhookProfile,
  type AcceptedWebhookDeliveryRecord,
  type AcceptedWebhookEventRecord,
  type WebhookSourceTruthPolicy,
  type WebhookTriggerContext,
} from '@recued/contracts';
import type {
  WebhookDeliveryStore,
} from './storage/webhook-delivery-store.js';
import type {
  WebhookConsumerStore,
  WebhookDispatchClaim,
} from './storage/webhook-consumer-store.js';
import type {
  WebhookEventOutboxSink,
  WebhookOutboxDispatchInput,
} from './webhook-outbox-dispatcher.js';

export interface WebhookRecipeRunRequest {
  /** Stable create-or-reuse key. Implementations must never mint a second run
   * when this value is retried after a process or lease failure. */
  run_id: string;
  idempotency_key: string;
  recipe_id: string;
  publisher_id: string;
  context: { webhook: WebhookTriggerContext };
  execution_source: {
    channel: 'webhook';
    /** D-209 #1 W3 — `anonymous`: a webhook fire is an EXTERNAL party's dispatch
     * under the recipe's webhook DOOR, never the server's own `system` (the actor
     * propagates into every row the run writes — `origin_actor`). */
    actor: 'anonymous';
    vendor: string;
    /** Legacy ExecutionSource field name; D-201 stores the ingress identity,
     * never a secret or credential-set reference. */
    webhook_secret_id: string;
    /** The claimed trigger row's stamped door contract (W2b). SERVER-DERIVED
     * from the dispatch claim — a vendor cannot name a contract. Absent
     * (unstamped row) ⇒ the gate floors to `PUBLIC_CONTRACT_ID` and denies. */
    contract_id?: string;
  };
}

export type WebhookRecipeRunResult =
  | 'completed'
  | 'awaiting_approval'
  | 'terminal_non_success';

export interface WebhookRecipeRunner {
  /** An owner-approval pause is a successful durable handoff, not a dispatch
   * failure. `terminal_non_success` closes the target without retrying it. */
  run(input: WebhookRecipeRunRequest): Promise<WebhookRecipeRunResult>;
}

export type WebhookEventAccessErrorCode =
  | 'not_authorized'
  | 'payload_unavailable';

export class WebhookEventAccessError extends Error {
  constructor(
    readonly code: WebhookEventAccessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WebhookEventAccessError';
  }
}

export interface ScopedWebhookEventRead {
  event: {
    event_id: string;
    delivery_id: string;
    ingress_id: string;
    provider_event_id: string | null;
    provider_resource_id: string | null;
    provider_event_type: string;
    provider_occurred_at: number | null;
  };
  delivery: {
    delivery_id: string;
    ingress_id: string;
    profile_id: AcceptedWebhookDeliveryRecord['profile_id'];
    environment: AcceptedWebhookDeliveryRecord['environment'];
    received_at: number;
    decoded_content_type: string;
    decoded_schema_id: string;
    transport_assurance: AcceptedWebhookDeliveryRecord['transport_assurance'];
    minimum_source_truth_policy: AcceptedWebhookDeliveryRecord['minimum_source_truth_policy'];
    freshness_checked: boolean;
  };
  payload: unknown;
}

const strongerSourceTruth = (
  left: WebhookSourceTruthPolicy,
  right: WebhookSourceTruthPolicy,
): WebhookSourceTruthPolicy => left === 'provider_readback_required'
  || right === 'provider_readback_required'
  ? 'provider_readback_required'
  : 'delivery_payload_allowed';

const triggerContextFor = (
  claim: WebhookDispatchClaim,
  input: WebhookOutboxDispatchInput,
): WebhookTriggerContext => ({
  kind: 'webhook',
  binding: claim.logical_binding,
  event_ref: input.event.event_id,
  delivery_ref: input.delivery.delivery_id,
  event_id: input.event.event_id,
  ingress_id: input.event.ingress_id,
  profile_id: input.delivery.profile_id,
  transport_assurance: input.delivery.transport_assurance,
  source_truth_policy: strongerSourceTruth(
    input.delivery.minimum_source_truth_policy,
    claim.source_truth_policy,
  ),
  provider_event_id: input.event.provider_event_id,
  provider_resource_id: input.event.provider_resource_id,
  provider_event_type: input.event.provider_event_type,
  provider_occurred_at: input.event.provider_occurred_at,
  received_at: input.delivery.received_at,
  duplicate: false,
});

/** Build the idempotent fan-out sink consumed by the Slice-2 outbox runtime. */
export const createWebhookRecipeOutboxSink = (
  consumerStore: WebhookConsumerStore,
  runner: WebhookRecipeRunner,
): WebhookEventOutboxSink => ({
  async dispatch(input) {
    const prepared = consumerStore.prepareDispatches({
      event: input.event,
      delivery: input.delivery,
    });
    for (const target of prepared) {
      if (target.state === 'dispatched'
        || target.state === 'cancelled'
        || target.state === 'awaiting_approval') continue;
      const claim = consumerStore.beginDispatch({
        dispatch_id: target.dispatch_id,
        event: input.event,
        delivery: input.delivery,
      });
      if (!claim) continue;
      const descriptor = webhookProfile(input.delivery.profile_id);
      if (!descriptor) {
        try {
          consumerStore.markDispatchFailed(claim.dispatch_id, claim.claim_token);
        } catch {
          // A newer claimant owns recovery; preserve the registry failure.
        }
        throw new Error('webhook recipe consumer: delivery profile is no longer registered');
      }
      let runResult: WebhookRecipeRunResult;
      try {
        runResult = await runner.run({
          run_id: claim.run_id,
          idempotency_key: claim.run_id,
          recipe_id: claim.recipe_id,
          publisher_id: claim.publisher_id,
          context: { webhook: triggerContextFor(claim, input) },
          execution_source: {
            channel: 'webhook',
            actor: 'anonymous',
            vendor: descriptor.vendor,
            webhook_secret_id: input.delivery.ingress_id,
            // D-209 #1 W3 — the claimed trigger row's stamped door contract.
            // A NULL stamp (pre-mint crash window, legacy row) builds a
            // door-less source: the gate floors it to `PUBLIC_CONTRACT_ID`
            // (denies every op) and the owner's remedy is re-save.
            ...(claim.contract_id !== null
              ? { contract_id: claim.contract_id }
              : {}),
          },
        });
      } catch (error) {
        // Preserve the recipe failure as the outbox error even if a concurrent
        // lease recovery already replaced this claim. The newer claimant owns
        // the row in that case; this stale worker must not overwrite it.
        try {
          consumerStore.markDispatchFailed(claim.dispatch_id, claim.claim_token);
        } catch {
          // Stale-claim recovery is handled by the current worker/outbox lease.
        }
        throw error;
      }
      // Keep durable handoff/completion outside the recipe-error catch. A stale
      // claim is an infrastructure race and must surface as such; it must not be
      // followed by an invalid attempt to requeue the newer worker's claim.
      if (runResult === 'awaiting_approval') {
        consumerStore.markDispatchAwaitingApproval(
          claim.dispatch_id,
          claim.claim_token,
        );
      } else if (runResult === 'terminal_non_success') {
        consumerStore.markDispatchCancelled(claim.dispatch_id, claim.claim_token);
      } else {
        consumerStore.markDispatchSucceeded(claim.dispatch_id, claim.claim_token);
      }
    }
  },
});

export interface ScopedWebhookEventReader {
  read(input: {
    event_ref: string;
    recipe_id: string;
    run_id: string;
  }): Promise<ScopedWebhookEventRead>;
}

/** Create the backing service for `core.webhook.event.get`. `event_ref` is only
 * a locator: authority is rechecked both before and after async decryption so
 * an uninstall/unbind racing the read cannot return the payload. */
export const createScopedWebhookEventReader = (
  consumerStore: WebhookConsumerStore,
  deliveryStore: Pick<
    WebhookDeliveryStore,
    'getEvent' | 'getDelivery' | 'readEventPayload'
  >,
): ScopedWebhookEventReader => ({
  async read(input) {
    const event = deliveryStore.getEvent(input.event_ref);
    const delivery = event ? deliveryStore.getDelivery(event.delivery_id) : null;
    const authorized = event !== null
      && delivery !== null
      && consumerStore.isRunAuthorized({
        run_id: input.run_id,
        recipe_id: input.recipe_id,
        event,
        delivery,
        require_payload_access: true,
      });
    if (!authorized || event === null || delivery === null) {
      throw new WebhookEventAccessError(
        'not_authorized',
        'webhook event is unavailable to this recipe run',
      );
    }
    const payload = await deliveryStore.readEventPayload(event.event_id);
    if (payload === null) {
      throw new WebhookEventAccessError(
        'payload_unavailable',
        'webhook event payload is no longer retained',
      );
    }
    if (!consumerStore.isRunAuthorized({
      run_id: input.run_id,
      recipe_id: input.recipe_id,
      event,
      delivery,
      require_payload_access: true,
    })) {
      throw new WebhookEventAccessError(
        'not_authorized',
        'webhook event is unavailable to this recipe run',
      );
    }
    return {
      event: {
        event_id: event.event_id,
        delivery_id: event.delivery_id,
        ingress_id: event.ingress_id,
        provider_event_id: event.provider_event_id,
        provider_resource_id: event.provider_resource_id,
        provider_event_type: event.provider_event_type,
        provider_occurred_at: event.provider_occurred_at,
      },
      delivery: {
        delivery_id: delivery.delivery_id,
        ingress_id: delivery.ingress_id,
        profile_id: delivery.profile_id,
        environment: delivery.environment,
        received_at: delivery.received_at,
        decoded_content_type: delivery.decoded_content_type,
        decoded_schema_id: delivery.decoded_schema_id,
        transport_assurance: delivery.transport_assurance,
        minimum_source_truth_policy: delivery.minimum_source_truth_policy,
        freshness_checked: delivery.freshness_checked,
      },
      payload,
    };
  },
});

/** Compile-time assertion that the consumer sink stays compatible with the
 * outbox boundary without widening it to raw bodies or credentials. */
const _outboxSinkCompatibility: (
  store: WebhookConsumerStore,
  runner: WebhookRecipeRunner,
) => WebhookEventOutboxSink = createWebhookRecipeOutboxSink;
void _outboxSinkCompatibility;

/** Keep the imported event types visible in emitted declarations. */
export type WebhookConsumerEventEvidence = {
  event: AcceptedWebhookEventRecord;
  delivery: AcceptedWebhookDeliveryRecord;
};

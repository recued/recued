/** First-create event bridge for accepted Reception form responses.
 *
 * One canonical insert fans to two independent in-process buses:
 *
 * - the realtime bus invalidates the paired owner's Data browser;
 * - the warehouse bus signals declarative/private recipe triggers using the
 *   substrate's existing at-most-once delivery contract.
 *
 * The warehouse event carries only routing metadata. Arbitrary submitted
 * values, the frozen schema, visitor identity, and free-form metadata never
 * ride the trigger bus; a later recipe-side reader must enforce the explicit
 * `data.form_response` grant before exposing those fields.
 */

import {
  FORM_RESPONSE_EVENT_ENTITY_TYPE,
  FORM_RESPONSE_EVENT_PLATFORM,
  FORM_RESPONSE_EVENT_SLUG,
  type FormResponse,
  type FormResponseTriggerRecord,
} from '@recued/contracts';
import type { WarehouseEventBus } from '@recued/warehouse-events';

import type { EventBus } from './events/bus.js';

export interface FormResponseCreatedEventDeps {
  readonly realtimeBus: Pick<EventBus, 'emit'>;
  readonly warehouseBus: Pick<WarehouseEventBus, 'emit'>;
}

/** Build the deliberately small record visible to trigger filters/context.
 *
 * INVARIANT: the emitted event must always carry this `record` with
 * `endpoint_id` + `form_definition_id`. A `where`-narrowed accepted-response
 * recipe lowers to a `record.<field>` dispatch filter, and the dispatcher's
 * missing-path posture PASSES an absent path (`matchesTriggerDispatchFilter`).
 * So if this record were ever dropped, or shed those routing fields, every
 * narrowed recipe would silently over-fire across all forms (spec §9). The
 * event-bridge test pins this shape precisely for that reason. */
export const toFormResponseTriggerRecord = (
  response: FormResponse,
): FormResponseTriggerRecord => ({
  _id: response.submission_id,
  _collection: 'form_response',
  submission_id: response.submission_id,
  endpoint_id: response.endpoint_id,
  form_definition_id: response.form_definition_id,
  submitted_at: response.submitted_at,
  accepted_at: response.accepted_at,
});

/** Best-effort fan-out after the canonical insert. Each bus is isolated: a
 * broken UI subscriber must not suppress the recipe trigger, and a broken
 * trigger subscriber must not suppress owner refresh. Neither may roll back a
 * response that is already durable. */
export const emitFormResponseCreatedEvents = (
  deps: FormResponseCreatedEventDeps,
  response: FormResponse,
): void => {
  const record = toFormResponseTriggerRecord(response);
  try {
    deps.warehouseBus.emit({
      platform: FORM_RESPONSE_EVENT_PLATFORM,
      slug: FORM_RESPONSE_EVENT_SLUG,
      entity_type: FORM_RESPONSE_EVENT_ENTITY_TYPE,
      event_kind: 'created',
      record_id: response.submission_id,
      at: response.accepted_at,
      record: { ...record },
    });
  } catch {
    // Warehouse delivery is fire-and-forget / at-most-once. It never changes
    // canonical acceptance; the durable response remains owner-browseable.
  }

  try {
    deps.realtimeBus.emit({
      kind: 'warehouse',
      collection: 'form_response',
      op: 'insert',
      id: response.submission_id,
    });
  } catch {
    // The paired client recovers through list refresh/reconnect.
  }
};

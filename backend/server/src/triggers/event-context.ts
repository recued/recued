/** One canonical recipe context for live dispatch and a stored reviewed event. */
import {
  composePlatformRecordTargetId,
  CONNECTION_NAME_REGEX,
  CONNECTION_VENDOR_ENTITIES,
  parsePlatformRecordTargetId,
  parseVendorEntityScope,
} from '@recued/contracts';
import { eventPath, type WarehouseEvent } from '@recued/warehouse-events';

/** D-320 ruling 20 — a CRM record a trigger hands a recipe says which connection it
 *  came from, as a search's rows do: `connection_name`, and for a pair the D-190
 *  parser reads, `target_id`, the id a later step routes by (D-254). Beside the
 *  record's own fields, never over one.
 *
 *  Added here, where the event becomes the recipe's context, and not by the poll or
 *  the reconciler that produce it. The poll hashes each record it keeps to see what
 *  changed, so a field added there would read as a change to every watched record on
 *  the first poll after an upgrade and fire each `updated` trigger once per record.
 *  And the two name a record differently: the poll's `record_id` is the vendor's id,
 *  the reconciler's the composed one. This says the same either way. */
const routingOf = (event: WarehouseEvent): Record<string, string> | undefined => {
  const scope = parseVendorEntityScope(event.platform);
  if (scope === null || !CONNECTION_NAME_REGEX.test(event.slug)) return undefined;
  const parseable = CONNECTION_VENDOR_ENTITIES.some((e) => e.vendor === scope.vendor && e.entity === scope.entity);
  if (!parseable) return { connection_name: event.slug };
  const own = parsePlatformRecordTargetId(event.record_id);
  if (own === null) {
    return {
      target_id: composePlatformRecordTargetId(scope.vendor, scope.entity, event.slug, event.record_id),
      connection_name: event.slug,
    };
  }
  // Already composed: kept when it is this record's own, never guessed at otherwise.
  return own.vendor === scope.vendor && own.entity === scope.entity && own.connection_name === event.slug
    ? { target_id: event.record_id, connection_name: event.slug }
    : { connection_name: event.slug };
};

export const triggerEventContext = (triggerId: string, event: WarehouseEvent): Record<string, unknown> => {
  const routing = routingOf(event);
  const routed = (record: Record<string, unknown>) => (routing === undefined ? record : { ...routing, ...record });
  return {
    event: {
      topic: eventPath(event.platform, event.slug, event.entity_type, event.event_kind).split('.'),
      kind: event.event_kind,
      payload: {
        record_id: event.record_id, at: event.at, platform: event.platform, slug: event.slug, entity_type: event.entity_type,
        ...(event.prev !== undefined ? { prev: routed(event.prev) } : {}),
        ...(event.record !== undefined ? { record: routed(event.record) } : {}),
        ...(event.changed_fields !== undefined ? { changed_fields: event.changed_fields } : {}),
      },
      trigger_id: triggerId,
    },
  };
};

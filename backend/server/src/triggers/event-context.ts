/** One canonical recipe context for live dispatch and a stored reviewed event. */
import { eventPath, type WarehouseEvent } from '@recued/warehouse-events';

export const triggerEventContext = (triggerId: string, event: WarehouseEvent): Record<string, unknown> => ({
  event: {
    topic: eventPath(event.platform, event.slug, event.entity_type, event.event_kind).split('.'),
    kind: event.event_kind,
    payload: {
      record_id: event.record_id, at: event.at, platform: event.platform, slug: event.slug, entity_type: event.entity_type,
      ...(event.prev !== undefined ? { prev: event.prev } : {}),
      ...(event.record !== undefined ? { record: event.record } : {}),
      ...(event.changed_fields !== undefined ? { changed_fields: event.changed_fields } : {}),
    },
    trigger_id: triggerId,
  },
});

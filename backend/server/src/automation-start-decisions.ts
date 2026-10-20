/** Shared read-only selection logic. Later execution and authority gates still apply. */
import type { Schedule } from '@recued/scheduler';
import { cronMatchesAt, resolveMissedAction } from '@recued/scheduler';
import { cronZoneFor, MAIL_FACT_EVENT_PLATFORM, matchesTriggerDispatchFilter, type EventTrigger } from '@recued/contracts';
import { eventPath, matchesPattern, RUN_OUTCOME_PLATFORM, type WarehouseEvent } from '@recued/warehouse-events';

export const isTriggerRunOutcomeLoop = (trigger: Pick<EventTrigger, 'trigger_id' | 'recipe_id'>, event: WarehouseEvent,
  origin: (id: string) => Pick<EventTrigger, 'recipe_id'> | null): boolean => {
  if (event.platform !== RUN_OUTCOME_PLATFORM) return false;
  const id = event.record?.origin_trigger_id;
  return id === trigger.trigger_id || typeof id === 'string' && origin(id)?.recipe_id === trigger.recipe_id;
};

export const selectRecurringScheduleTick = (schedule: Schedule, at: number, serverTimeZone?: string): 'regular' | 'fire' | 'ask' | 'skip' | 'none' => {
  const parts = schedule.cron_expression.trim().split(/\s+/);
  if (parts.length !== 5) return 'none';
  const zone = cronZoneFor(schedule, serverTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  return cronMatchesAt(parts, new Date(Math.floor(at / 60_000) * 60_000), zone) ? 'regular' : resolveMissedAction(schedule, at);
};
export const selectTriggerEvent = (trigger: EventTrigger, event: WarehouseEvent): boolean => {
  if (!matchesPattern(trigger.pattern, eventPath(event.platform, event.slug, event.entity_type, event.event_kind))) return false;
  if ((trigger.filter !== undefined || trigger.fields !== undefined || event.platform === MAIL_FACT_EVENT_PLATFORM)
    && !matchesTriggerDispatchFilter(trigger, { record_id: event.record_id, at: event.at, platform: event.platform, slug: event.slug, entity_type: event.entity_type,
      ...(event.prev === undefined ? {} : { prev: event.prev }), ...(event.record === undefined ? {} : { record: event.record }),
      ...(event.changed_fields === undefined ? {} : { changed_fields: event.changed_fields }) })) return false;
  return true;
};

import { RpcError, type CanonicalEvent, type ReviewedResource } from '@recued/contracts';
import type { CalendarDispatcherDeps } from './calendar-dispatcher.js';
import { resourceReviewHash } from '../../resource-review.js';
import { normalizeCalendarMutationPatch } from './mutation-patch.js';

/** Capture the fields and validator from ONE warehouse version. Fetching a
 * newer ETag and attaching it to an older event would authorize unseen data. */
export const captureCalendarResource = (deps: CalendarDispatcherDeps,
  operation: 'calendar-update' | 'calendar-delete', input: Record<string, unknown>): ReviewedResource => {
  const slug = String(input.slug);
  const collection = deps.getCollection(slug);
  const instance = deps.instances.get('calendar', slug);
  const row = collection?.table.get(String(input.source_id));
  if (!collection || !instance || !row) throw new RpcError('not_found', 'Calendar event is unavailable. Refresh the calendar.', 404);
  const incarnation = deps.instances.getIncarnation?.('calendar', slug);
  if (!incarnation) throw new RpcError('resource_version_unavailable', 'Calendar identity is unavailable. Request a new review after restarting the calendar.', 409);
  // Optional manifest defaults are null; the kernel dispatch treats those as
  // omitted, so capture must review that same single-occurrence operation.
  if (input.scope !== undefined && input.scope !== null && input.scope !== 'this_instance') {
    throw new RpcError('resource_review_unsupported',
      'Version-bound review currently supports one calendar occurrence. Review series changes in your calendar provider.', 400);
  }
  if (collection.provider.kind === 'graph') {
    throw new RpcError('resource_review_unsupported',
      'Version-bound Outlook changes are not available yet. Review this change in Outlook.', 400);
  }
  const local = collection.provider.kind === 'local';
  if (!local && (!row.etag || !/^"[^"\r\n]+"$/.test(row.etag))) {
    throw new RpcError('resource_version_unavailable',
      'This calendar event has no usable provider version. Sync the calendar, then request a new review.', 409);
  }
  const patch = operation === 'calendar-update'
    ? normalizeCalendarMutationPatch(input.patch as Partial<CanonicalEvent>, row.event) : undefined;
  const keys = new Set(['summary', 'start_at', 'end_at', 'timezone', 'is_all_day', 'status', 'location',
    ...Object.keys(patch ?? {})]);
  const before: Record<string, unknown> = {};
  for (const key of keys) before[key] = (row.event as unknown as Record<string, unknown>)[key] ?? null;
  return {
    kind: 'calendar', key: JSON.stringify([slug, row.event.calendar_id, row.source_id]),
    label: row.event.summary + ' (' + slug + ')',
    // Cursor, polling and token refresh do not change the account binding.
    binding: resourceReviewHash({ slug, provider: collection.provider.kind, incarnation,
      account_slug: instance.config.account_slug ?? null, server_url: instance.config.server_url ?? null,
      username: instance.config.username ?? null }),
    version: row.resource_version,
    precondition: local ? { kind: 'local_version', value: row.resource_version }
      : { kind: 'etag', value: row.etag! },
    before,
    after: operation === 'calendar-delete' ? null : Object.fromEntries(
      Object.entries({ ...before, ...patch }).map(([key, value]) => [key, value ?? null])),
  };
};

import { RpcError } from '@recued/contracts';
import { DEFAULT_LOCAL_CALENDAR_SLUG } from './local-provider.js';

/** One normalization for Chat's proposed diff and its eventual mutation. */
export const calendarChatUpdateInput = (args: Record<string, unknown>) => {
  const source_id = typeof args.source_id === 'string' ? args.source_id.trim() : '';
  if (!source_id) throw new RpcError('bad_request', 'calendar.update requires the source_id of the event to change', 400);
  const patch: Record<string, unknown> = {};
  for (const key of ['summary', 'timezone']) {
    if (typeof args[key] === 'string' && args[key].trim()) patch[key] = args[key].trim();
  }
  if (typeof args.description === 'string') patch.description = args.description;
  for (const key of ['start_at', 'end_at']) {
    if (typeof args[key] === 'number' && Number.isFinite(args[key])) patch[key] = args[key];
  }
  if (args.status === 'confirmed' || args.status === 'cancelled') patch.status = args.status;
  if (Object.keys(patch).length === 0) throw new RpcError('bad_request',
    'calendar.update: send at least one field to change (summary / start_at / end_at / timezone / status)', 400);
  if (typeof patch.start_at === 'number' && typeof patch.end_at === 'number' && patch.end_at <= patch.start_at) {
    throw new RpcError('bad_request', 'calendar.update: end_at must be after start_at', 400);
  }
  const slug = typeof args.calendar_id === 'string' && args.calendar_id.trim()
    ? args.calendar_id.trim() : DEFAULT_LOCAL_CALENDAR_SLUG;
  return { slug, source_id, patch };
};

import { createHash } from 'node:crypto';
import {
  formatReminderWhen, resolveQuietHoursOccurrence, shouldSuppressForQuietHours,
  type Reminder, type ReminderView, type ReminderTriageAction, type ReminderTriagePreviewRequest,
  type ReminderTriagePreview, type ReminderTriageApplyRequest, type ReminderTriageResult,
} from '@recued/contracts';
import { ReminderInputError, type ReminderServiceDeps } from './reminder-service.js';
import { reminderRevision } from './reminder-revision.js';

export interface ReminderTriageDispatchers {
  reminderTriagePreview(input: ReminderTriagePreviewRequest): Promise<ReminderTriagePreview>;
  reminderTriageApply(input: ReminderTriageApplyRequest): Promise<ReminderTriageResult>;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const actionKey = (a: ReminderTriageAction) => a.kind === 'cancel' ? ['cancel'] : ['move', a.at, a.time_zone];

export const createReminderTriageDispatchers = (deps: ReminderServiceDeps, view: (r: Reminder, now: number) => ReminderView): ReminderTriageDispatchers => {
  const now = deps.now ?? Date.now;
  const refusal = (r: Reminder | null): string | undefined => !r ? 'This reminder is no longer available.'
    : r.clock ? 'This reminder is managed in Yours.'
    : r.state === 'delivered' ? 'This reminder has already rung.'
    : r.state === 'cancelled' ? 'This reminder was cancelled.' : undefined;
  const review = (r: Reminder, action: ReminderTriageAction, current: number) => {
    if (action.kind === 'cancel') return { review_token: hash([reminderRevision(r), actionKey(action)]), message: 'Cancel this reminder. It will not ring.' };
    const zone = deps.timeZone(), policy = deps.quietHours();
    const quiet = shouldSuppressForQuietHours({ policy, instant: action.at, timeZone: zone });
    const occurrence = quiet ? resolveQuietHoursOccurrence(policy, zone, action.at) : null;
    if (quiet && !occurrence?.active) throw new ReminderInputError('The quiet-hours delay could not be confirmed. Choose another time.');
    const delivery = quiet ? occurrence!.end : action.at;
    return {
      review_token: hash([reminderRevision(r), actionKey(action), zone, policy.enabled, policy.from_minute, policy.to_minute, policy.applies_to.includes('notification')]),
      delivery_not_before: delivery,
      message: `Move to ${formatReminderWhen(action.at, r.time_zone ?? zone, current)} (${r.time_zone ?? zone}).`
        + (quiet ? ` Quiet hours hold delivery until ${formatReminderWhen(delivery, zone, current)} (${zone}).` : ' Outside quiet hours.'),
    };
  };
  return {
    reminderTriagePreview: async input => {
      if (input.action.kind === 'move' && (input.action.at <= now() || input.action.time_zone !== deps.timeZone()))
        throw new ReminderInputError('Choose a future time in the current server time zone. Refresh Reminders if the time zone changed.');
      return { action: input.action, items: input.reminder_ids.map(reminder_id => {
        const reminder = deps.store.get(reminder_id), message = refusal(reminder);
        return { reminder_id, ...(reminder ? { reminder: view(reminder, now()) } : {}),
          ...(message ? { message } : review(reminder!, input.action, now())) };
      }) };
    },
    reminderTriageApply: async input => ({ items: input.items.map(item => {
      try {
        const current = now(), r = deps.store.get(item.reminder_id);
        const eligible = !refusal(r) && (input.action.kind === 'cancel'
          || input.action.at > current && input.action.time_zone === deps.timeZone());
        const checked = eligible ? review(r!, input.action, current) : undefined;
        const out = deps.store.applyReviewed({ request_id: input.request_id, reminder_id: item.reminder_id,
          fingerprint: hash([actionKey(input.action), item.review_token]),
          ...(checked?.review_token === item.review_token && r ? { expected_revision: reminderRevision(r) } : {}),
          ...(input.action.kind === 'move' ? { at: input.action.at } : {}),
        }, current);
        return { reminder_id: item.reminder_id,
          status: out.applied ? 'applied' as const : 'needs_review' as const,
          ...(out.reminder ? { reminder: view(out.reminder, current) } : {}),
          ...(out.replayed ? { replayed: true as const } : {}),
          message: out.applied ? (out.replayed ? 'Confirmed the earlier change. ' : '')
            + (input.action.kind === 'cancel' ? 'Cancelled: it will not ring.' : 'Moved to the reviewed time.')
            : refusal(out.reminder) ?? 'The reminder, chosen time, or quiet hours changed since review. Review it again before applying.',
        };
      } catch {
        return { reminder_id: item.reminder_id, status: 'failed' as const, message: 'This reminder could not be changed. Retry this item to confirm the result.' };
      }
    }) }),
  };
};

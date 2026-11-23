import { createHash } from 'node:crypto';
import type { Reminder } from '@recued/contracts';

/** Content and lifetime, including same-millisecond edits and delivery attempts. */
export const reminderRevision = (r: Reminder): string => createHash('sha256').update(JSON.stringify([
  r.reminder_id, r.created_at, r.updated_at, r.state, r.text, r.at, r.time_zone,
  r.record_ref ? [r.record_ref.kind, r.record_ref.id, r.record_ref.source_id, r.record_ref.source_record_id, r.record_ref.created_at] : null,
  r.mail_ref ? [r.mail_ref.slug, r.mail_ref.record_id, r.mail_ref.source_id, r.mail_ref.received_at, r.mail_ref.incarnation] : null,
  r.clock ? [r.clock.occurrence_id, r.clock.point_key, r.clock.ask_id] : null,
  r.attempts, r.delivered_at,
])).digest('hex');

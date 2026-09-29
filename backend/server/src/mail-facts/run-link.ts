/**
 * D-315 §6.4 — a recipe run a mail fact's event started, linked to the email
 * that caused it.
 *
 * The dispatcher's `trigger_fired` entry names the event's record, which for a
 * fact trigger is the THING — shared by every email about it (the order, the
 * shipping notice, the delivery). The facts list shows a run on the row of the
 * fact that started it, so the link names the email, from the fact the event's
 * record carries (`record.fact.email`).
 */

import { MAIL_FACT_EVENT_PLATFORM, type MailFactEmailRef } from '@recued/contracts';

import type { MailFactRunLink } from '../storage/mail-fact-store.js';
import type { TriggerFire } from '../triggers/dispatcher.js';

const isEmailRef = (value: unknown): value is MailFactEmailRef =>
  value !== null
  && typeof value === 'object'
  && typeof (value as { slug?: unknown }).slug === 'string'
  && typeof (value as { record_id?: unknown }).record_id === 'string';

/** The link to record for a fire, or `null` when the fire was not a fact's. */
export const mailFactRunLinkOf = (fire: TriggerFire): MailFactRunLink | null => {
  if (fire.event.platform !== MAIL_FACT_EVENT_PLATFORM) return null;
  const email = (fire.event.record as { fact?: { email?: unknown } } | undefined)?.fact?.email;
  if (!isEmailRef(email)) return null;
  return {
    email: { slug: email.slug, record_id: email.record_id },
    thing_id: fire.event.record_id,
    trigger_id: fire.trigger.trigger_id,
    recipe_id: fire.trigger.recipe_id,
    ...(fire.run_id !== undefined ? { run_id: fire.run_id } : {}),
    outcome: fire.outcome,
    at: fire.at,
  };
};

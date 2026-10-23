/** D-207 — telling the owner that a public form turned a visitor away.
 *
 *  A paired form that cannot do what it promised shows the visitor an error page: "We
 *  recorded your details, but could not start the payment … contact us and we will pick it
 *  up from here". Until this, the owner heard nothing. No inbox row, no Form response, no
 *  tray item, and no run when the refusal came before the recipe started. The only trace was
 *  a draft order that looked like any order still waiting for payment. A live drive found it
 *  (2026-10-22, D-207).
 *
 *  The notice follows the other owner notices: the `notification_fired` history row first,
 *  then the push to the owner's channels, best-effort.
 *
 *  ⛔ IT CARRIES NOTHING THE VISITOR TYPED. Their answers stay sealed until the owner opens
 *  them (D-149 § N.6, D-173 I-3). A history row is readable by the owner's AI, and a push can
 *  leave the server. The form's name and the offer's name and ID are the owner's own words.
 *
 *  ⚠ ONE NOTICE PER FORM AND REASON, AN HOUR. A broken offer turns away every buyer until it
 *  is fixed, and Reception → Records already lists each one. The owner needs to hear it once,
 *  not once per buyer. The hour lives in memory, so a restart can repeat a notice. */

import type { SellerOffer, SellerOfferState } from '@recued/contracts';
import type { NotificationBlock, NotificationMessage } from '@recued/notification';
import type { AuditLogStore } from '@recued/storage';

import type { IntakeFormTurnedAwayEvent } from './ports/reception/handlers/intake-form.js';

export const RECEPTION_TURNED_AWAY_QUIET_MS = 60 * 60 * 1000;

/** How the notice says an offer cannot be sold. `active` never reaches it. */
const OFFER_STATE: Readonly<Record<SellerOfferState, string>> = {
  draft: 'is not active yet, so it cannot be sold',
  active: 'is active',
  paused: 'is paused, so it cannot be sold',
  archived: 'is put away, so it cannot be sold again',
};

const RECORDS_HASH = '#reception/records';

/** A name as a notice line can carry it: one line, bounded. They are the owner's words, but
 *  they leave the server in a push. */
const label = (text: string): string => text.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120);

/** The owner's notice, and the app address it opens. */
export const receptionTurnedAwayMessage = (
  event: IntakeFormTurnedAwayEvent,
  offerName: string | null,
  publicBaseUrl?: string | null,
): { readonly message: NotificationMessage; readonly hash: string } => {
  const form = `“${label(event.form_name)}”`;
  const refusal = event.refusal;
  let title: string;
  let what: string[];
  let fix: string | null;
  let hash: string;
  if (refusal === undefined) {
    title = `Someone could not use your form ${form}`;
    what = [`Someone sent your form ${form}, but Recued could not finish the recipe that answers it.`];
    fix = null;
    hash = RECORDS_HASH;
  } else {
    const offer = label(offerName ?? refusal.offer_id);
    const offerPage = `#settings/seller/offers/detail/${encodeURIComponent(refusal.offer_id)}`;
    const recipePage = `#recipes/${encodeURIComponent(refusal.recipe_id)}`;
    title = `A buyer could not pay for ${offer}`;
    switch (refusal.reason) {
      case 'no_checkout_link':
        what = [
          `Someone sent your form ${form} to buy ${offer}.`,
          'The offer has no checkout link, so Recued could not start their payment.',
        ];
        fix = 'Add the link in Settings → Seller → Offers.';
        hash = offerPage;
        break;
      case 'checkout_link_unusable':
        what = [
          `Someone sent your form ${form} to buy ${offer}.`,
          'The offer’s checkout link is too long once Recued adds the order’s '
            + 'reference to it, so Recued could not start their payment.',
        ];
        fix = 'Use a shorter link in Settings → Seller → Offers.';
        hash = offerPage;
        break;
      case 'offer_not_active':
        what = [
          `Someone sent your form ${form} to buy ${offer}.`,
          `${offer} ${OFFER_STATE[refusal.state]}.`,
        ];
        if (refusal.state === 'archived') {
          fix = 'Choose another offer in the settings of the recipe that answers the form, '
            + 'or switch the form off in Reception.';
          hash = recipePage;
        } else {
          fix = 'Make it active in Settings → Seller → Offers, or switch the form off in Reception.';
          hash = offerPage;
        }
        break;
      case 'offer_missing':
        title = `A buyer could not pay on your form ${form}`;
        what = [
          `Someone sent your form ${form} to buy the offer with the ID “${label(refusal.offer_id)}”, `
            + 'but there is no such offer.',
        ];
        fix = 'Check Offer to sell in the settings of the recipe that answers the form.';
        hash = recipePage;
        break;
    }
  }
  const text = [
    ...what,
    'They were told nothing was charged and that you would be in touch.',
    ...(fix === null ? [] : [fix]),
    'Their request is in Reception → Records.',
    'Recued will not repeat this notice for an hour.',
  ].join(' ');
  const base = publicBaseUrl?.replace(/\/+$/, '');
  return {
    hash,
    message: { title, text, ...(base ? { link_url: `${base}/${hash}` } : {}) },
  };
};

export interface ReceptionTurnedAwayNoticeDeps {
  readonly auditLog: Pick<AuditLogStore, 'logActivity'>;
  readonly notifier: Pick<NotificationBlock, 'notify'>;
  /** The offer's name for the notice. Without it the notice names the offer by its ID. */
  readonly getOffer?: (offer_id: string) => Pick<SellerOffer, 'display_name'> | null;
  /** Read per notice: the server's public address can appear or change while it runs. */
  readonly getPublicBaseUrl?: () => string | null;
  readonly quietMs?: number;
}

/** Tell the owner, once per form and reason an hour. Resolves `true` when it told them.
 *  Never throws: the history row and the push are each best-effort. */
export const createReceptionTurnedAwayNotice = (
  deps: ReceptionTurnedAwayNoticeDeps,
): ((event: IntakeFormTurnedAwayEvent) => Promise<boolean>) => {
  const quietMs = deps.quietMs ?? RECEPTION_TURNED_AWAY_QUIET_MS;
  const lastToldAt = new Map<string, number>();
  return async (event) => {
    const key = `${event.endpoint_id}\u0000${event.refusal?.reason ?? 'could_not_finish'}`;
    const last = lastToldAt.get(key);
    if (last !== undefined && event.at - last < quietMs) return false;
    lastToldAt.set(key, event.at);
    if (lastToldAt.size > 256) {
      for (const [k, at] of lastToldAt) if (event.at - at >= quietMs) lastToldAt.delete(k);
    }

    const read = <T>(fn: () => T): T | null => {
      try { return fn(); } catch { return null; }
    };
    const refusal = event.refusal;
    const offerName = refusal === undefined || refusal.reason === 'offer_missing'
      ? null
      : read(() => deps.getOffer?.(refusal.offer_id)?.display_name ?? null);
    const { message, hash } = receptionTurnedAwayMessage(
      event,
      offerName,
      read(() => deps.getPublicBaseUrl?.() ?? null),
    );
    const persisted_activity_id = `reception-turned-away:${event.submission_id}`;
    try {
      await deps.auditLog.logActivity({
        activity_id: persisted_activity_id,
        timestamp: event.at,
        action: 'notification_fired',
        target: event.endpoint_id,
        detail: JSON.stringify({ ...message, link_url: message.link_url ?? hash }),
      });
    } catch {
      // The push below still reaches the owner.
    }
    try {
      await deps.notifier.notify(message, undefined, { persisted_activity_id, ui_link_url: hash });
    } catch {
      // Best-effort, like every owner notice; the history row above holds it.
    }
    return true;
  };
};

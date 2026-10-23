/** D-207 — the owner's notice when a public form turns a visitor away. */
import { describe, expect, it, vi } from 'vitest';

import type { IntakeFormTurnedAwayEvent } from '../ports/reception/handlers/intake-form.js';
import type { ReceptionSaleRefusal } from '../reception-recipe-runner.js';
import {
  RECEPTION_TURNED_AWAY_QUIET_MS,
  createReceptionTurnedAwayNotice,
  receptionTurnedAwayMessage,
} from '../reception-turned-away-notice.js';

const AT = 1_792_000_000_000;

const event = (
  refusal?: ReceptionSaleRefusal,
  over: Partial<IntakeFormTurnedAwayEvent> = {},
): IntakeFormTurnedAwayEvent => ({
  endpoint_id: 'ep_kit',
  submission_id: 'sub_1',
  form_name: 'Buy the kit',
  at: AT,
  ...(refusal === undefined ? {} : { refusal }),
  ...over,
});

const sale = (reason: ReceptionSaleRefusal['reason'], extra: object = {}): ReceptionSaleRefusal =>
  ({ reason, offer_id: 'client-kit', recipe_id: 'show-order-checkout-link', ...extra }) as ReceptionSaleRefusal;

describe('what the notice says', () => {
  it('names the offer, the reason and where to fix it, for each reason the owner can fix', () => {
    const cases = [
      [sale('no_checkout_link'), 'A buyer could not pay for Freelance Client Kit',
        'The offer has no checkout link', 'Add the link in Settings → Seller → Offers.',
        '#settings/seller/offers/detail/client-kit'],
      [sale('checkout_link_unusable'), 'A buyer could not pay for Freelance Client Kit',
        'is too long once Recued adds the order’s reference', 'Use a shorter link in Settings → Seller → Offers.',
        '#settings/seller/offers/detail/client-kit'],
      [sale('offer_not_active', { state: 'paused' }), 'A buyer could not pay for Freelance Client Kit',
        'Freelance Client Kit is paused, so it cannot be sold.',
        'Make it active in Settings → Seller → Offers, or switch the form off in Reception.',
        '#settings/seller/offers/detail/client-kit'],
      [sale('offer_not_active', { state: 'draft' }), 'A buyer could not pay for Freelance Client Kit',
        'Freelance Client Kit is not active yet, so it cannot be sold.',
        'Make it active', '#settings/seller/offers/detail/client-kit'],
      // A put-away offer cannot come back, so the fix is the form's setting, not the offer.
      [sale('offer_not_active', { state: 'archived' }), 'A buyer could not pay for Freelance Client Kit',
        'is put away, so it cannot be sold again.',
        'Choose another offer in the settings of the recipe that answers the form',
        '#recipes/show-order-checkout-link'],
    ] as const;
    for (const [refusal, title, why, fix, hash] of cases) {
      const { message, hash: opened } = receptionTurnedAwayMessage(event(refusal), 'Freelance Client Kit');
      expect(message.title, refusal.reason).toBe(title);
      expect(message.text).toContain('Someone sent your form “Buy the kit” to buy Freelance Client Kit.');
      expect(message.text).toContain(why);
      expect(message.text).toContain(fix);
      expect(message.text).toContain('They were told nothing was charged and that you would be in touch.');
      expect(message.text).toContain('Their request is in Reception → Records.');
      expect(opened).toBe(hash);
    }
  });

  it('says plainly when the form names an offer that does not exist', () => {
    const { message, hash } = receptionTurnedAwayMessage(event(sale('offer_missing')), null);
    expect(message.title).toBe('A buyer could not pay on your form “Buy the kit”');
    expect(message.text).toContain(
      'to buy the offer with the ID “client-kit”, but there is no such offer.',
    );
    expect(message.text).toContain('Check Offer to sell in the settings of the recipe that answers the form.');
    expect(hash).toBe('#recipes/show-order-checkout-link');
  });

  it('tells any other failure as "could not finish", and points at the requests list', () => {
    const { message, hash } = receptionTurnedAwayMessage(event(), null);
    expect(message.title).toBe('Someone could not use your form “Buy the kit”');
    expect(message.text).toBe(
      'Someone sent your form “Buy the kit”, but Recued could not finish the recipe that answers it. '
        + 'They were told nothing was charged and that you would be in touch. '
        + 'Their request is in Reception → Records. Recued will not repeat this notice for an hour.',
    );
    expect(hash).toBe('#reception/records');
  });

  it('carries no store code, field name or internal id — only the owner’s own words', () => {
    for (const refusal of [undefined, sale('no_checkout_link'), sale('offer_missing'),
      sale('checkout_link_unusable'), sale('offer_not_active', { state: 'archived' })]) {
      const { message } = receptionTurnedAwayMessage(event(refusal), 'Freelance Client Kit');
      expect(`${message.title} ${message.text}`).not.toMatch(
        /seller_store|checkout_url|recipe_id|offer_id|endpoint|sub_1|ep_kit|show-order-checkout-link/,
      );
    }
  });

  it('names the offer by its ID when its name is not known', () => {
    const { message } = receptionTurnedAwayMessage(event(sale('no_checkout_link')), null);
    expect(message.title).toBe('A buyer could not pay for client-kit');
  });

  it('keeps each name on one line and bounded — a push can carry it off the server', () => {
    const { message } = receptionTurnedAwayMessage(
      event(sale('no_checkout_link'), { form_name: `Line one\nLine two${'x'.repeat(300)}` }),
      'Kit\u0007',
    );
    expect(message.text).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(message.text).toContain('“Line one Line two');
    expect(message.text).not.toContain('x'.repeat(130));
  });

  it('links outside the app only when the server knows its own address', () => {
    expect(receptionTurnedAwayMessage(event(sale('no_checkout_link')), 'Kit', 'https://me.example//').message.link_url)
      .toBe('https://me.example/#settings/seller/offers/detail/client-kit');
    expect(receptionTurnedAwayMessage(event(sale('no_checkout_link')), 'Kit', null).message)
      .not.toHaveProperty('link_url');
    // An offer id is escaped into the address, never spliced raw.
    expect(receptionTurnedAwayMessage(
      event({ reason: 'no_checkout_link', offer_id: 'a b/c', recipe_id: 'r' }), 'Kit',
    ).hash).toBe('#settings/seller/offers/detail/a%20b%2Fc');
  });
});

describe('telling the owner', () => {
  const harness = (over: { logFails?: boolean; notifyFails?: boolean; getOfferFails?: boolean } = {}) => {
    const order: string[] = [];
    const auditLog = {
      logActivity: vi.fn(async (_row: Record<string, unknown>) => {
        order.push('history');
        if (over.logFails) throw new Error('disk full');
      }),
    };
    const notifier = {
      notify: vi.fn(async () => {
        order.push('push');
        if (over.notifyFails) throw new Error('telegram down');
      }),
    };
    const getOffer = vi.fn((id: string) => {
      if (over.getOfferFails) throw new Error('db closed');
      return id === 'client-kit' ? { display_name: 'Freelance Client Kit' } : null;
    });
    const notice = createReceptionTurnedAwayNotice({
      auditLog: auditLog as never,
      notifier,
      getOffer,
      getPublicBaseUrl: () => 'https://me.example',
    });
    return { notice, auditLog, notifier, getOffer, order };
  };

  it('writes the history row first, then pushes — with the offer’s own name', async () => {
    const h = harness();
    await expect(h.notice(event(sale('no_checkout_link')))).resolves.toBe(true);

    expect(h.order).toEqual(['history', 'push']);
    const [row] = h.auditLog.logActivity.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(row).toMatchObject({
      activity_id: 'reception-turned-away:sub_1',
      timestamp: AT,
      action: 'notification_fired',
      target: 'ep_kit',
    });
    expect(JSON.parse(row.detail as string)).toMatchObject({
      title: 'A buyer could not pay for Freelance Client Kit',
      link_url: 'https://me.example/#settings/seller/offers/detail/client-kit',
    });
    expect(h.notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'A buyer could not pay for Freelance Client Kit' }),
      undefined,
      {
        persisted_activity_id: 'reception-turned-away:sub_1',
        ui_link_url: '#settings/seller/offers/detail/client-kit',
      },
    );
  });

  it('tells the owner once an hour per form and reason, not once per buyer', async () => {
    const h = harness();
    expect(await h.notice(event(sale('no_checkout_link')))).toBe(true);
    expect(await h.notice(event(sale('no_checkout_link'), {
      submission_id: 'sub_2', at: AT + RECEPTION_TURNED_AWAY_QUIET_MS - 1,
    }))).toBe(false);
    // Another reason, or another form, is news.
    expect(await h.notice(event(sale('offer_not_active', { state: 'paused' }), { submission_id: 'sub_3' })))
      .toBe(true);
    expect(await h.notice(event(sale('no_checkout_link'), { endpoint_id: 'ep_other', submission_id: 'sub_4' })))
      .toBe(true);
    // And the same one again once the hour is up.
    expect(await h.notice(event(sale('no_checkout_link'), {
      submission_id: 'sub_5', at: AT + RECEPTION_TURNED_AWAY_QUIET_MS,
    }))).toBe(true);

    expect(h.notifier.notify).toHaveBeenCalledTimes(4);
    expect(h.auditLog.logActivity.mock.calls.map(([row]) => row.activity_id))
      .toEqual([
        'reception-turned-away:sub_1',
        'reception-turned-away:sub_3',
        'reception-turned-away:sub_4',
        'reception-turned-away:sub_5',
      ]);
  });

  it('still pushes when the history cannot be written, and never throws', async () => {
    const h = harness({ logFails: true });
    await expect(h.notice(event(sale('no_checkout_link')))).resolves.toBe(true);
    expect(h.notifier.notify).toHaveBeenCalledTimes(1);

    const down = harness({ notifyFails: true });
    await expect(down.notice(event(sale('no_checkout_link')))).resolves.toBe(true);
    expect(down.auditLog.logActivity).toHaveBeenCalledTimes(1);
  });

  it('falls back to the offer’s ID when its name cannot be read', async () => {
    const h = harness({ getOfferFails: true });
    await h.notice(event(sale('no_checkout_link')));
    expect(h.notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'A buyer could not pay for client-kit' }),
      undefined,
      expect.anything(),
    );
  });

  it('does not look up an offer that does not exist', async () => {
    const h = harness();
    await h.notice(event(sale('offer_missing')));
    expect(h.getOffer).not.toHaveBeenCalled();
  });
});

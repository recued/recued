/** D-127 Phase 3.3 — `notification-send` fan-out picks up the email
 *  channel via the same dispatcher map as slack / telegram / in_app.
 *
 *  The handler in `notification-handler.ts` is channel-agnostic: it
 *  reads the per-channel dispatcher off the deps map and forwards the
 *  payload. P3.1 lit up the email subhandler under the connection
 *  adapter; P3.2 added the `mail-post` wrapper; P3.3 pins the
 *  end-of-fan-out contract — a `notification-send` recipe step naming
 *  email in `channels[]` lands in the email dispatcher slot the same
 *  way slack does, mixed-success aggregation works as documented, and
 *  per-channel audit rows are the dispatcher's responsibility (the
 *  fan-out handler is just an aggregator — it doesn't double-emit).
 *
 *  Architecture invariant pinned here: when a recipe author chooses
 *  `channels: ['slack', 'email']` in a notification-send call, the
 *  email leg routes through `connection.notification.email` exactly
 *  like the slack leg routes through `connection.notification.slack` —
 *  the wrapper / picker / dispatcher path is symmetric. The actual
 *  audit emission inside the email path lives in `MailCollection.send`
 *  (P1.7's `mail_send` activity row), distinct from the
 *  `connection_notification` rows the connection adapter emits on the
 *  slack leg. Both rows surface in the activity feed when both legs
 *  fire — the test verifies the fan-out invokes both dispatchers in
 *  one call and the aggregator separates `delivered_to[]` /
 *  `failed[]` correctly when one of the legs is wired to fail. */

import { describe, expect, it } from 'vitest';
import {
  handleNotificationSend,
  type NotificationDispatchResult,
  type NotificationPayload,
} from '../notification-handler.js';

describe('D-127 P3.3 — notification-send fan-out across slack + email', () => {
  it('fans out across slack + email, mixed success aggregates per-channel', async () => {
    const calls: NotificationPayload[] = [];
    const out = await handleNotificationSend(
      {
        dispatchers: {
          slack: async (payload) => {
            calls.push(payload);
            return { ok: true } as NotificationDispatchResult;
          },
          email: async (payload) => {
            calls.push(payload);
            // Mirror a real-world MAIL_SEND_RECIPIENT_INVALID rejection
            // — the email subhandler from P3.1 surfaces it as an
            // IngredientError, the connection adapter catches it into
            // `connection_notification` status='error', then the
            // dispatcher relays via `{ ok: false, reason }` so the
            // fan-out aggregates rather than throws.
            return {
              ok: false,
              reason: 'MAIL_SEND_RECIPIENT_INVALID',
            } as NotificationDispatchResult;
          },
        },
      },
      {
        channels: ['slack', 'email'],
        text: 'Deal at risk: Acme renewal',
        title: 'Sales alert',
        link_url: 'https://app.hubspot.com/deal/123',
      } as Parameters<typeof handleNotificationSend>[1],
    );

    // Both dispatchers invoked exactly once.
    expect(calls).toHaveLength(2);
    const channels = calls.map((c) => c.channel).sort();
    expect(channels).toEqual(['email', 'slack']);

    // Both received identical payload shape (text + title + link_url
    // forwarded uniformly — this is what makes the email subhandler's
    // `text` fan-out fallback work end-to-end without a wrapper rewrite).
    for (const c of calls) {
      expect(c.text).toBe('Deal at risk: Acme renewal');
      expect(c.title).toBe('Sales alert');
      expect(c.link_url).toBe('https://app.hubspot.com/deal/123');
    }

    // Mixed-success aggregation: slack succeeded, email failed.
    expect(out.delivered_to).toEqual(['slack']);
    expect(out.failed).toEqual(['email']);
  });
});

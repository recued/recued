/** A delivered notification says WHICH RECIPE sent it.
 *
 *  ⛔ THIS CLOSES A GAP THE SAME DAY'S RETIER OPENED. Until
 *  `core.notification.send` became `read` (2026-08-20), every recipe
 *  notification was preceded by an approval ask, and that ask named the sender
 *  — "Recipe X wants to run core-notification-send". Removing the gate removed
 *  the only thing saying who was talking. The gate was the wrong place to carry
 *  it (it charged the owner a decision to learn a name), but the name mattered:
 *  an unattributed push channel that any installed recipe can reach is a decent
 *  phishing primitive.
 *
 *  ⛔⛔ THE ATTRIBUTION IS ENGINE-STAMPED AND UNFORGEABLE. It comes from
 *  `stepMeta.recipe_id`, never from the step's own args — a "sent by" line a
 *  recipe could write is worse than none, because it invites exactly the trust
 *  it cannot earn.
 */

import { describe, expect, it, vi } from 'vitest';
import { createKernelAdapter } from '@recued/ingredients';
import {
  handleNotificationSend,
  type NotificationPayload,
} from '../notification-handler.js';

const capturing = () => {
  const seen: NotificationPayload[] = [];
  return {
    seen,
    dispatchers: {
      in_app: async (p: NotificationPayload) => { seen.push(p); return { ok: true }; },
      email: async (p: NotificationPayload) => { seen.push(p); return { ok: true }; },
    },
  };
};

describe('handleNotificationSend — the attribution line', () => {
  it('appends the sending recipe to the delivered body', async () => {
    const { seen, dispatchers } = capturing();
    await handleNotificationSend(
      { dispatchers } as never,
      { channels: ['in_app'], text: '3 things happened', source_recipe_id: 'nightly-digest' },
    );
    expect(seen[0]!.text).toBe('3 things happened\n\n— sent by recipe nightly-digest');
  });

  it('reaches EVERY channel, not just the first', async () => {
    // The reason it is folded into `text` rather than added as a new field on
    // `NotificationPayload`: four independently-written channel dispatchers
    // read that shape, and a new optional field is silently dropped by each
    // until it is taught to render it.
    const { seen, dispatchers } = capturing();
    await handleNotificationSend(
      { dispatchers } as never,
      { channels: ['in_app', 'email'], text: 'x', source_recipe_id: 'r1' },
    );
    expect(seen).toHaveLength(2);
    for (const p of seen) expect(p.text).toContain('— sent by recipe r1');
  });

  it('⚠ CONTROL — no attribution, byte-identical to before', async () => {
    // The rpc surface passes no recipe id. Without this, "attribution is
    // appended" could be satisfied by an implementation that appends an empty
    // marker to every notification the server itself sends.
    const { seen, dispatchers } = capturing();
    await handleNotificationSend(
      { dispatchers } as never,
      { channels: ['in_app'], text: 'server-side notice' },
    );
    expect(seen[0]!.text).toBe('server-side notice');
  });

  it.each([['   '], ['']])('a blank id (%j) adds nothing rather than a dangling dash', async (id) => {
    const { seen, dispatchers } = capturing();
    await handleNotificationSend(
      { dispatchers } as never,
      { channels: ['in_app'], text: 'x', source_recipe_id: id },
    );
    expect(seen[0]!.text).toBe('x');
  });

  it('caps a pathological id so it cannot dominate a push preview', async () => {
    const { seen, dispatchers } = capturing();
    await handleNotificationSend(
      { dispatchers } as never,
      { channels: ['in_app'], text: 'x', source_recipe_id: 'a'.repeat(500) },
    );
    expect(seen[0]!.text.length).toBeLessThan(120);
  });
});

describe('the kernel adapter stamps the sender', () => {
  const runNotify = async (
    stepMeta: Record<string, unknown> | undefined,
    input: Record<string, unknown> = { text: 'hello', channels: ['in_app'] },
  ) => {
    const notificationSend = vi.fn().mockResolvedValue({ delivered_to: ['in_app'], failed: [] });
    const adapter = createKernelAdapter({ notificationSend } as never);
    await adapter(
      { slug: 'notification-send', input, ...(stepMeta !== undefined ? { stepMeta } : {}) } as never,
    );
    return notificationSend.mock.calls[0]![0] as { source_recipe_id?: string };
  };

  it('takes the recipe id from stepMeta', async () => {
    expect((await runNotify({ recipe_id: 'nightly-digest' })).source_recipe_id)
      .toBe('nightly-digest');
  });

  it('⛔ IGNORES a recipe-authored `source_recipe_id` in the step args', async () => {
    // THE ASSERTION THAT MATTERS. A recipe naming itself "recued-core/security"
    // in its own args must not be able to speak as it. The engine's stamp wins;
    // an absent stamp means NO attribution, never the authored value.
    const forged = await runNotify(
      { recipe_id: 'some-third-party-recipe' },
      { text: 'Your session expired', channels: ['in_app'], source_recipe_id: 'recued-core/security' },
    );
    expect(forged.source_recipe_id).toBe('some-third-party-recipe');

    const unstamped = await runNotify(
      undefined,
      { text: 'Your session expired', channels: ['in_app'], source_recipe_id: 'recued-core/security' },
    );
    expect(unstamped.source_recipe_id).toBeUndefined();
  });
});

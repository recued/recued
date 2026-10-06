/** D-209 — what the owner is told when saving a dish's settings moved a webhook
 *  door. The server returns the change on the dish rpc (`webhook_doors`); these
 *  pin how each one reads, and that a notice can never turn a committed save
 *  into a failure on the screen that saved. The bootstrap's wiring of the shared
 *  dish callers is pinned in `webclient-bootstrap.test.ts`. */

import { describe, expect, it } from 'vitest';
import { DISH_WEBHOOK_DOOR_RPCS } from '@recued/contracts';
import {
  announcingWebhookDoors,
  webhookDoorToasts,
  withWebhookDoorNotices,
  type WebhookDoorToast,
} from '../webhook-door-notices.js';

const result = (...webhook_doors: unknown[]) => ({ dish: { dish_id: 'dsh_1' }, webhook_doors });

describe('webhookDoorToasts — one notice per door a save moved', () => {
  it('a door that opens says the webhook works now, and lists what it may use', () => {
    expect(webhookDoorToasts(result({
      recipe_id: 'alert-camera-home-assistant',
      recipe_name: 'Home Assistant camera alert',
      state: 'opened',
      was_open: false,
      operation_ids: ['recued-core.home-assistant.camera.snapshot'],
      added: ['recued-core.home-assistant.camera.snapshot', 'ingredient:core-ai-classify', 'connection:home-assistant'],
      removed: [],
    }))).toEqual([{
      title: 'Webhook on: Home Assistant camera alert',
      text: 'Messages coming in now run with these settings. They may use: '
        + 'recued-core.home-assistant.camera.snapshot, core-ai-classify, the home-assistant account.',
      sticky: true,
    }]);
  });

  it('a door that changes names what messages coming in may now use, and no longer may', () => {
    const [swap] = webhookDoorToasts(result({
      recipe_id: 'acme-order-paid',
      recipe_name: 'Acme order paid',
      state: 'opened',
      was_open: true,
      added: ['connection:acme-staging'],
      removed: ['connection:acme-prod'],
    }));
    expect(swap).toEqual({
      title: 'Webhook changed: Acme order paid',
      text: 'These settings changed what messages coming in may use. '
        + 'Now: the acme-staging account. No longer: the acme-prod account.',
      sticky: true,
    });
    const [widened] = webhookDoorToasts(result({
      recipe_id: 'acme-order-paid', state: 'opened', was_open: true, added: ['acme.orders.refund'], removed: [],
    }));
    expect(widened!.text).toBe('These settings changed what messages coming in may use. Now also: acme.orders.refund.');
  });

  it('a door that closes says messages coming in are refused, and how the owner fixes it', () => {
    expect(webhookDoorToasts(result(
      { recipe_id: 'acme-order-paid', recipe_name: 'Acme order paid', state: 'closed', was_open: true,
        reason: "step 'order' resolves its connection at runtime ({{config.acme}}), so …", reason_code: 'no_account' },
      { recipe_id: 'acme-order-refunded', state: 'closed', was_open: false,
        reason: "step 'pick' chooses what to run at runtime (ingredient)", reason_code: 'refused' },
      { recipe_id: 'acme-order-voided', state: 'closed', was_open: true, reason: 'disk I/O error', reason_code: 'fault' },
    ))).toEqual([
      {
        title: 'Webhook off: Acme order paid',
        text: 'Messages coming in are refused until its settings choose an account.',
        sticky: true,
      },
      {
        title: 'Webhook still off: acme-order-refunded',
        text: "Messages coming in are refused: step 'pick' chooses what to run at runtime (ingredient).",
        sticky: true,
      },
      {
        title: 'Webhook off: acme-order-voided',
        text: 'Recued could not update this webhook, so messages coming in are refused for now. '
          + 'Save its settings again to retry.',
        sticky: true,
      },
    ]);
  });

  it('a door its owner turned off says a settings change does not turn it back on', () => {
    expect(webhookDoorToasts(result({
      recipe_id: 'acme-order-paid', recipe_name: 'Acme order paid', state: 'kept_revoked', was_open: false,
    }))).toEqual([{
      title: 'Webhook still off: Acme order paid',
      text: 'Its access was turned off, and changing its settings does not turn it back on.',
      sticky: true,
    }]);
  });

  it('says nothing for an unchanged door, a result without doors, or a malformed one', () => {
    expect(webhookDoorToasts(result({ recipe_id: 'r', state: 'unchanged', was_open: true }))).toEqual([]);
    expect(webhookDoorToasts({ dish: { dish_id: 'dsh_1' } })).toEqual([]);
    expect(webhookDoorToasts({ deleted: true })).toEqual([]);
    expect(webhookDoorToasts(null)).toEqual([]);
    expect(webhookDoorToasts(result(
      null,
      'opened',
      { state: 'opened' },
      { recipe_id: 'r', state: 'open_sesame' },
      { recipe_id: 7, state: 'closed' },
    ))).toEqual([]);
  });

  it('names a recipe without a name by its id, and reads a missing was_open as closed before', () => {
    expect(webhookDoorToasts(result({ recipe_id: 'acme-order-paid', recipe_name: '  ', state: 'opened' })))
      .toEqual([{
        title: 'Webhook on: acme-order-paid',
        text: 'Messages coming in now run with these settings.',
        sticky: true,
      }]);
  });
});

describe('announcingWebhookDoors — the dish rpc, with its door news told', () => {
  it('passes the result through and presents each change', async () => {
    const shown: WebhookDoorToast[] = [];
    const saved = result({ recipe_id: 'r', recipe_name: 'R', state: 'kept_revoked', was_open: false });
    const call = announcingWebhookDoors(async (args: { dish_id: string }) => {
      expect(args).toEqual({ dish_id: 'dsh_1' });
      return saved;
    }, (toast) => { shown.push(toast); });

    await expect(call({ dish_id: 'dsh_1' })).resolves.toBe(saved);
    expect(shown.map((t) => t.title)).toEqual(['Webhook still off: R']);
  });

  it('⛔ a notice that cannot be shown never fails the save it reports on', async () => {
    const saved = result({ recipe_id: 'r', state: 'closed', was_open: true, reason_code: 'no_account' });
    const call = announcingWebhookDoors(async () => saved, () => { throw new Error('the toast stack is gone'); });
    await expect(call()).resolves.toBe(saved);
  });

  it('leaves a failed rpc failed, and shows nothing for it', async () => {
    const shown: WebhookDoorToast[] = [];
    const call = announcingWebhookDoors(async () => { throw new Error('dish not found'); }, (t) => { shown.push(t); });
    await expect(call()).rejects.toThrow('dish not found');
    expect(shown).toEqual([]);
  });
});

describe('withWebhookDoorNotices — the app\'s one connection tells every door a result moved', () => {
  const door = (recipe_name: string) => ({ recipe_id: 'r', recipe_name, state: 'kept_revoked', was_open: false });
  const fakeConn = () => {
    const seen: Array<[string, unknown]> = [];
    const conn = {
      call: async (method: string, args?: unknown) => {
        seen.push([method, args]);
        return { echoed: method, webhook_doors: [door(method)] };
      },
      dispose: () => undefined,
      pendingCount: () => 7,
    };
    return { conn, seen };
  };

  it('announces the result of every rpc that can make or change a main dish', async () => {
    const { conn, seen } = fakeConn();
    const shown: string[] = [];
    const wrapped = withWebhookDoorNotices(conn, (toast) => { shown.push(toast.title); });

    for (const method of DISH_WEBHOOK_DOOR_RPCS) {
      await expect(wrapped.call(method, { a: 1 })).resolves.toMatchObject({ echoed: method });
    }
    expect(shown).toEqual(DISH_WEBHOOK_DOOR_RPCS.map((method) => `Webhook still off: ${method}`));
    expect(seen.map(([method]) => method)).toEqual([...DISH_WEBHOOK_DOOR_RPCS]);
    expect(seen.every(([, args]) => (args as { a?: number })?.a === 1)).toBe(true);
  });

  it('passes every other call straight through, and keeps the connection\'s other members', async () => {
    const { conn } = fakeConn();
    const shown: string[] = [];
    const wrapped = withWebhookDoorNotices(conn, (toast) => { shown.push(toast.title); });

    await wrapped.call('dishes.list', {});
    await wrapped.call('schedules.list');
    expect(shown).toEqual([]);
    expect(wrapped.pendingCount()).toBe(7);
    expect(wrapped.dispose).toBe(conn.dispose);
  });

  it('lists exactly the rpcs the server returns door changes from', () => {
    expect([...DISH_WEBHOOK_DOOR_RPCS].sort()).toEqual([
      'auto_run.update', 'dishes.create', 'dishes.delete', 'dishes.update', 'schedules.create', 'triggers.create',
    ]);
  });
});

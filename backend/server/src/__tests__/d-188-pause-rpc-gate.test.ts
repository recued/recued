/** D-188 — the owner's direct actions that reach outside the server wait while it is paused
 *  (the owner's ruling of 2026-11-08: the pause is the emergency stop; nothing leaves and
 *  nothing comes in until Resume, the owner's own hands included). */
import { describe, expect, it, vi } from 'vitest';
import { SERVER_RPC_METHOD_SET } from '@recued/contracts';

import { createRpcDispatcher } from '../rpc-dispatcher.js';
import { PAUSED_RPC_REFUSAL, PAUSE_OPEN_OUTSIDE, PAUSE_REFUSED_METHODS, pauseRefusesRpc } from '../pause-rpc-gate.js';
import { PAUSE_LOCAL_METHODS } from '../pause-rpc-local-methods.js';

describe('the list of actions a pause refuses', () => {
  // ⛔ A NEW METHOD FAILS HERE UNTIL SOMEONE DECIDES WHAT THE PAUSE DOES WITH IT. Reaches an
  // account, a vendor, a model or a third party: PAUSE_REFUSED_METHODS. Reaches outside but must
  // stay open (a stop needs it, or it keeps the owner connected): PAUSE_OPEN_OUTSIDE, with why.
  // Only reads or changes what this server holds: PAUSE_LOCAL_METHODS.
  it('places every server method in exactly one of: refused, open on purpose, local', () => {
    const placed = new Map<string, string[]>();
    const put = (kind: string) => (method: string): void => {
      placed.set(method, [...(placed.get(method) ?? []), kind]);
    };
    [...PAUSE_REFUSED_METHODS.keys()].forEach(put('refused'));
    [...PAUSE_OPEN_OUTSIDE.keys()].forEach(put('open'));
    [...PAUSE_LOCAL_METHODS].forEach(put('local'));
    const unplaced = [...SERVER_RPC_METHOD_SET].filter((method) => !placed.has(method));
    const twice = [...placed].filter(([, kinds]) => kinds.length > 1).map(([method]) => method);
    const unknown = [...placed.keys()].filter((method) => !SERVER_RPC_METHOD_SET.has(method));
    expect({ unplaced, twice, unknown }).toEqual({ unplaced: [], twice: [], unknown: [] });
  });

  it('says why each open method reaches outside', () => {
    for (const [method, why] of PAUSE_OPEN_OUTSIDE) expect(why.length, method).toBeGreaterThan(10);
  });

  it('names only methods the server has, so a rename cannot drop one out quietly', () => {
    const unknown = [...PAUSE_REFUSED_METHODS.keys()].filter((method) => !SERVER_RPC_METHOD_SET.has(method));
    expect(unknown).toEqual([]);
  });

  it('refuses a live read, a change and a sign-in at an account', () => {
    for (const method of ['collection.calendar.event.destinations', 'collection.calendar.event.create',
      'collection.mail.message.updateState', 'collection.connection.probe', 'collection.calendar.enrollOAuth',
      'housekeeping.task.run_now']) {
      expect(pauseRefusesRpc(method, {})).toBe(true);
    }
  });

  it('refuses a mostly local action only when its arguments reach outside', () => {
    expect(pauseRefusesRpc('data.file.read', { record_id: 'file:remote:abc:def' })).toBe(true);
    expect(pauseRefusesRpc('data.file.read', { record_id: 'a'.repeat(64) })).toBe(false);
    expect(pauseRefusesRpc('collection.calendar.update', { slug: 'work', config_patch: {}, reprobe: true })).toBe(true);
    expect(pauseRefusesRpc('collection.calendar.update', { slug: 'work', config_patch: { color: 'blue' } })).toBe(false);
    expect(pauseRefusesRpc('server.oauthApps', { action: 'renewal_run' })).toBe(true);
    expect(pauseRefusesRpc('server.oauthApps', { action: 'list' })).toBe(false);
    expect(pauseRefusesRpc('yours.change', { action: 'household.home_assistant', connection_name: 'ha' })).toBe(true);
    expect(pauseRefusesRpc('yours.change', { action: 'asset.create' })).toBe(false);
    expect(pauseRefusesRpc('server.archive.export', { recoveryKey: 'k', remote: { kind: 's3' } })).toBe(true);
    expect(pauseRefusesRpc('server.archive.export', { recoveryKey: 'k' })).toBe(false);
    expect(pauseRefusesRpc('server.seller.issueManualCustomer', { send_claim_email: true })).toBe(true);
    expect(pauseRefusesRpc('server.seller.issueManualCustomer', {})).toBe(false);
  });

  it('leaves open what a stop needs and what only reads or changes what is stored here', () => {
    for (const method of ['notification.submitAnswer', 'webhook.ingress.disable', 'webhook.ingress.retire',
      'server.setPaused', 'server.getPauseState', 'chat.delivery.skip', 'collection.connection.list',
      'contact.upsert', 'recipe.list',
      'work_entity.project.attention',
      // Opening an email or an event shows the stored copy; the handler holds the live read.
      'collection.mail.message.get', 'collection.calendar.event.get']) {
      expect(pauseRefusesRpc(method, {})).toBe(false);
    }
  });
});

describe('the rpc dispatcher while the server is paused', () => {
  const setup = (paused: boolean) => {
    const handler = vi.fn(async () => ({ ok: true }));
    const handlers = {
      'collection.calendar.event.create': handler,
      'collection.connection.list': handler,
      'work_entity.project.attention': handler,
    };
    const dispatch = createRpcDispatcher(handlers as never, { serverPaused: () => paused });
    return { dispatch, handler };
  };

  it('refuses a listed action before its handler runs, in the owner\'s words', async () => {
    const { dispatch, handler } = setup(true);
    const result = await dispatch('collection.calendar.event.create', {}, {} as never);
    expect(result).toEqual({ ok: false, status: 409, error: { code: 'server_paused', message: PAUSED_RPC_REFUSAL } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs everything else, and every action once resumed', async () => {
    const paused = setup(true);
    expect((await paused.dispatch('collection.connection.list', {}, {} as never)).ok).toBe(true);
    expect((await paused.dispatch('work_entity.project.attention', {}, {} as never)).ok).toBe(true);
    const running = setup(false);
    expect((await running.dispatch('collection.calendar.event.create', {}, {} as never)).ok).toBe(true);
    expect(running.handler).toHaveBeenCalledTimes(1);
  });
});

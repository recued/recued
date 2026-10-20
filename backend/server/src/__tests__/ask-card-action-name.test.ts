/** The approval card's "Action" row names the action the way the owner knows it.
 *
 *  ⛔ It read "mail-send" under a title in the owner's words (owner,
 *  2026-10-19). The server names the held action from the id its ask prints:
 *  an ingredient's manifest name, or a catalog operation's id composed into
 *  words. `notification.pending_asks` carries it, and only when there is one. */

import { describe, expect, it } from 'vitest';
import { buildPreflightAsk } from '@recued/gateway';
import type { Checkpoint } from '@recued/contracts';

import { createAskActionNamer, heldActionName } from '../ask-card-action-name.js';
import { handlePendingAsks } from '../history-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';

const manifests = createManifestRegistry();
const getManifest = (slug: string) => manifests.get(slug);

describe('the held action, by name', () => {
  it('a built-in action is named by its manifest, by slug or by op id', () => {
    expect(heldActionName('mail-send', getManifest)).toBe('Send mail');
    expect(heldActionName('core.mail.send', getManifest)).toBe('Send mail');
  });

  it('a catalog operation is named from its id', () => {
    expect(heldActionName('recued-core/hubspot.deal.update', getManifest)).toBe('Update deal · HubSpot');
  });

  it('an id that leads to no name gets none, rather than itself back', () => {
    // A catalog id whose action is not a verb the phrase knows.
    expect(heldActionName('recued-core/reception-intake.intake.materialize', getManifest)).toBeUndefined();
    expect(heldActionName('no-such-ingredient', getManifest)).toBeUndefined();
    expect(heldActionName('deal.update', getManifest)).toBeUndefined();
    // A manifest with a blank name names nothing.
    expect(heldActionName('mail-send', () => ({ name: '  ' }))).toBeUndefined();
  });
});

describe('naming the action an ask holds', () => {
  const namer = createAskActionNamer({ getManifest });
  const held = (tool_slug: string, extra: Record<string, unknown> = {}) => {
    const ask = buildPreflightAsk({
      checkpoint: {
        checkpoint_id: 'cp1', run_id: 'run1', recipe_id: 'send-composed-mail', gated_step_id: 'send',
        step_state: { send: { input: { to: ['sam@example.test'] } } }, created_at: 0,
        preflight_context: { recipe_title: 'Send a composed email' },
      } as Checkpoint,
      context: { recipe_id: 'send-composed-mail', gated_step_id: 'send', tool_slug, risk_tier: 'write' },
    });
    return { ask, payload: { handler_kind: ask.handler.kind, handler_payload: { ...ask.handler.payload, ...extra } } };
  };

  it('names the action the ask\'s Technical line prints', () => {
    const { ask, payload } = held('mail-send');
    expect(ask.message.text).toContain('action mail-send.');
    expect(namer(payload)).toBe('Send mail');
  });

  it('names nothing for another kind of ask, an AI agent\'s raw op, or no action', () => {
    const { payload } = held('mail-send');
    expect(namer({ ...payload, handler_kind: 'peer.ask' } as never)).toBeNull();
    expect(namer(held('mail-send', { raw_op_id: 'recued_op_x.y.z' }).payload)).toBeNull();
    expect(namer({ handler_kind: payload.handler_kind, handler_payload: { checkpoint_id: 'cp1' } })).toBeNull();
  });

  it('a lookup that throws names nothing', () => {
    const throwing = createAskActionNamer({ getManifest: () => { throw new Error('store gone'); } });
    expect(throwing(held('mail-send').payload)).toBeNull();
  });
});

describe('notification.pending_asks carries the name', () => {
  const pending = (id: string): never => ({
    ask_id: id,
    message: { text: `ask ${id}` },
    options: [{ id: 'approve', label: 'Approve' }],
    handler_kind: 'gateway.preflight',
    handler_payload: { checkpoint_id: `cp-${id}`, tool_slug: id === 'named' ? 'mail-send' : 'no-such-ingredient' },
    status: 'open',
    created_at: id === 'named' ? 2 : 1,
    fanout_channels: [],
  } as never);

  it('on the ask it names, and on no other', async () => {
    const out = await handlePendingAsks({
      listOpenAsks: async () => [pending('named'), pending('unnamed')],
      nameAskAction: createAskActionNamer({ getManifest }),
    } as never);
    expect(out.asks.map((a) => [a.ask_id, a.action_name])).toEqual([['named', 'Send mail'], ['unnamed', undefined]]);
    expect(out.asks[1]).not.toHaveProperty('action_name');
  });

  it('a namer that throws costs the name, never the list', async () => {
    const out = await handlePendingAsks({
      listOpenAsks: async () => [pending('named')],
      nameAskAction: () => { throw new Error('boom'); },
    } as never);
    expect(out.asks).toHaveLength(1);
    expect(out.asks[0]).not.toHaveProperty('action_name');
  });

  it('no namer wired: no name, as before', async () => {
    const out = await handlePendingAsks({ listOpenAsks: async () => [pending('named')] } as never);
    expect(out.asks[0]).not.toHaveProperty('action_name');
  });
});

/** The side panel's Disconnect (`disconnect.ts`): it asks first, and only then does the worker
 *  tell the server and forget the pairing. */

import { describe, expect, it, vi } from 'vitest';

import { BRIDGE_DISCONNECT_MESSAGE_TYPE, createDisconnectControls } from '../disconnect.js';
import type { SidePanelDisconnectState } from '../store/local-store.js';

const controls = (send: (message: unknown) => Promise<unknown>) => {
  const states: SidePanelDisconnectState[] = [];
  return { states, handlers: createDisconnectControls(send, (next) => { states.push(next); }) };
};

describe('the side panel\'s Disconnect', () => {
  it('asks first, and Cancel goes back to the button without sending anything', () => {
    const send = vi.fn(async () => ({ ok: true }));
    const t = controls(send);
    t.handlers.onAsk();
    t.handlers.onCancel();
    expect(t.states).toEqual([{ phase: 'confirming', message: '' }, { phase: 'idle', message: '' }]);
    expect(send).not.toHaveBeenCalled();
  });

  it('a confirmed one asks the worker, saying it is under way until the worker answers', async () => {
    const send = vi.fn(async () => ({ ok: true, told_server: true }));
    const t = controls(send);
    await t.handlers.onConfirm();
    expect(send).toHaveBeenCalledWith({ type: BRIDGE_DISCONNECT_MESSAGE_TYPE });
    expect(t.states).toEqual([{ phase: 'working', message: '' }, { phase: 'idle', message: '' }]);
  });

  it('one that did not go through says why', async () => {
    const refused = controls(async () => ({ ok: false, error: 'bridge_not_ready' }));
    await refused.handlers.onConfirm();
    expect(refused.states.at(-1)).toEqual({ phase: 'idle', message: 'This bridge could not be disconnected: bridge_not_ready.' });
    const silent = controls(async () => undefined);
    await silent.handlers.onConfirm();
    expect(silent.states.at(-1)?.message).toBe('This bridge could not be disconnected: no answer from the bridge.');
    const thrown = controls(async () => { throw new Error('Receiving end does not exist'); });
    await thrown.handlers.onConfirm();
    expect(thrown.states.at(-1)?.message).toBe('This bridge could not be disconnected: Receiving end does not exist.');
  });
});

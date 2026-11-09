/** The side panel's Disconnect: the owner takes this bridge off its server from the Server
 *  status section. Asking first, since it is undone only by pairing again; then the worker tells
 *  the server and forgets the pairing (`service-worker-bootstrap.ts`, `disconnect`), and the
 *  panel, watching the stored pair, shows the pair form. */

import type { SidePanelDisconnectState } from './store/local-store.js';

export const BRIDGE_DISCONNECT_MESSAGE_TYPE = 'recued.bridge.side-panel.disconnect';

export interface DisconnectHandlers {
  /** Show the confirmation. */
  onAsk?: () => void;
  /** Back to the button. */
  onCancel?: () => void;
  /** Disconnect now. */
  onConfirm?: () => Promise<void>;
}

/** The handlers, over the worker's message and the store's Disconnect state. */
export const createDisconnectControls = (
  send: (message: unknown) => Promise<unknown>,
  apply: (next: SidePanelDisconnectState) => void,
): Required<DisconnectHandlers> => ({
  onAsk: () => apply({ phase: 'confirming', message: '' }),
  onCancel: () => apply({ phase: 'idle', message: '' }),
  onConfirm: async () => {
    apply({ phase: 'working', message: '' });
    let answer: unknown;
    try {
      answer = await send({ type: BRIDGE_DISCONNECT_MESSAGE_TYPE });
    } catch (err) {
      answer = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const reply = answer as { ok?: unknown; error?: unknown } | null | undefined;
    if (reply?.ok === true) {
      // The pairing is gone; the pair form replaces this section. Idle, should it stay a moment.
      apply({ phase: 'idle', message: '' });
      return;
    }
    const why = typeof reply?.error === 'string' && reply.error !== '' ? reply.error : 'no answer from the bridge';
    apply({ phase: 'idle', message: `This bridge could not be disconnected: ${why}.` });
  },
});

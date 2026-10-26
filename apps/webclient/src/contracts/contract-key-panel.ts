/** The Connect tab's key — ONE per agreement.
 *
 *  An AI app connects as an agreement by presenting that agreement's key. The
 *  key carries no permissions of its own: what it may do is the agreement's
 *  Ops, Entities and Recipes, and nothing is allowed until the owner switches
 *  it on there. So this panel only creates the key, shows it once, and turns it
 *  off.
 *
 *  ⛔ IT LISTS ONLY KEYS BOUND TO THIS AGREEMENT. The panel it replaced managed
 *  one server-wide key ("The door for AI apps") from every agreement's page,
 *  bound to a separate contract the server made for it — so the Door boxes,
 *  Ops and Entities on the page it sat in governed nothing that key could
 *  reach. Every read and write here is keyed on `contractId`.
 *
 *  ⚠ The bearer is surfaced exactly once, by the issue rpc. It is held in
 *  memory for this mount only (never persisted), and shown only while the
 *  active key is the one THIS mount issued — a key made on another device, or
 *  before a reload, reads as "made on <date>" with no value. */

import type {
  IssuedMcpInboundToken,
  McpInboundTokenRecord,
} from '@recued/contracts';
import { isMcpInboundTokenActive } from '@recued/contracts';
import { formatClientDateTime } from '@recued/ui-shared';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

/** The panel root. Carries `data-state` = the {@link ContractKeyState}. */
export const CONTRACT_KEY_PANEL_ATTR = 'data-recued-contract-key';
/** "Create a key". */
export const CONTRACT_KEY_CREATE_ATTR = 'data-recued-contract-key-create';
/** The one-time key value (only right after this mount created it). */
export const CONTRACT_KEY_VALUE_ATTR = 'data-recued-contract-key-value';
/** Copy the one-time key value. */
export const CONTRACT_KEY_COPY_ATTR = 'data-recued-contract-key-copy';
/** "Turn off this key" — first stage, arms the confirm. */
export const CONTRACT_KEY_TURN_OFF_ATTR = 'data-recued-contract-key-turn-off';
/** The armed confirm button (second stage — revokes). */
export const CONTRACT_KEY_CONFIRM_ATTR = 'data-recued-contract-key-confirm';
/** The armed cancel button. */
export const CONTRACT_KEY_CANCEL_ATTR = 'data-recued-contract-key-cancel';
/** An error line (list / create / turn-off failure). */
export const CONTRACT_KEY_ERROR_ATTR = 'data-recued-contract-key-error';

export type ContractKeyState = 'loading' | 'none' | 'active' | 'unavailable';

/** `chat.inbound_token.list`. */
export type ContractKeyListCaller = () => Promise<{
  tokens: ReadonlyArray<McpInboundTokenRecord>;
}>;

/** `chat.inbound_token.issue`, narrowed to what an agreement's key sends. */
export type ContractKeyIssueCaller = (args: {
  label: string;
  contract_id: string;
  grants: Readonly<Record<string, boolean>>;
  concurrency_tier: 5;
  chat_mode: null;
}) => Promise<IssuedMcpInboundToken>;

/** `chat.inbound_token.revoke`. */
export type ContractKeyRevokeCaller = (args: {
  token_id: string;
}) => Promise<{ revoked: boolean; token: McpInboundTokenRecord }>;

export interface ContractKeyPanelOptions {
  host: HTMLElement;
  document: Document;
  contractId: string;
  /** The agreement's name — the key's label, so audit rows read as the agreement. */
  contractName: string;
  /** Why no key can be created here, shown in place of "Create a key"; `null`
   *  when one can. The route says it for an agreement that is off, and for an
   *  agreement made before D-327, whose key would keep its own tool list. A key
   *  that already exists can still be turned off either way. */
  createBlockedReason: string | null;
  runList: ContractKeyListCaller;
  runIssue: ContractKeyIssueCaller;
  runRevoke: ContractKeyRevokeCaller;
  subscribe?: BroadcastSubscriber['on'];
  now?: () => number;
}

export interface ContractKeyPanelMount {
  readonly root: HTMLElement;
  whenLoaded(): Promise<void>;
  refresh(): Promise<void>;
  hasInFlightWork(): boolean;
  /** Test/host introspection. */
  getState(): ContractKeyState;
  dispose(): void;
}

/** The active keys bound to `contractId`, newest first. An agreement holds one;
 *  more than one can only come from before that rule, and turning off revokes
 *  them all so none survives the owner's "off". */
export const activeKeysForContract = (
  tokens: ReadonlyArray<McpInboundTokenRecord>,
  contractId: string,
  now: number,
): McpInboundTokenRecord[] =>
  tokens
    .filter((t) => t.contract_id === contractId && isMcpInboundTokenActive(t, now))
    .sort((a, b) => b.created_at - a.created_at);

export const CONTRACT_KEY_PANEL_STYLES = `
[${CONTRACT_KEY_PANEL_ATTR}] { display: grid; gap: 10px; margin-bottom: 18px; }
[${CONTRACT_KEY_PANEL_ATTR}] > h3 { margin: 0; font-size: 15px; line-height: 1.4; }
[${CONTRACT_KEY_PANEL_ATTR}] .contract-key-copy-text { margin: 0; max-width: 70ch; color: var(--muted); font-size: 13px; line-height: 1.5; }
[${CONTRACT_KEY_PANEL_ATTR}] .contract-key-value-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
[${CONTRACT_KEY_PANEL_ATTR}] [${CONTRACT_KEY_VALUE_ATTR}] { flex: 1 1 280px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--wc-radius, 6px); background: var(--surface-subtle); font-family: var(--mono, ui-monospace, monospace); font-size: 13px; overflow-wrap: anywhere; user-select: all; }
[${CONTRACT_KEY_PANEL_ATTR}] .contract-key-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
[${CONTRACT_KEY_PANEL_ATTR}] .contract-key-warning { flex-basis: 100%; margin: 0; font-size: 13px; }
[${CONTRACT_KEY_PANEL_ATTR}] button { box-sizing: border-box; min-height: 36px; appearance: none; border: 1px solid var(--border); border-radius: 7px; background: none; padding: 5px 11px; font-size: 12px; font-weight: 600; cursor: pointer; color: var(--fg); }
[${CONTRACT_KEY_PANEL_ATTR}] [${CONTRACT_KEY_CREATE_ATTR}] { color: var(--accent); border-color: var(--accent); }
[${CONTRACT_KEY_PANEL_ATTR}] :is([${CONTRACT_KEY_TURN_OFF_ATTR}], [${CONTRACT_KEY_CONFIRM_ATTR}]) { color: var(--danger, #b3261e); border-color: var(--danger, #b3261e); }
[${CONTRACT_KEY_PANEL_ATTR}] button[disabled] { opacity: 0.6; cursor: default; }
[${CONTRACT_KEY_PANEL_ATTR}] [${CONTRACT_KEY_ERROR_ATTR}] { margin: 0; padding: 10px 12px; border-left: 3px solid var(--danger); background: var(--surface-subtle); font-size: 13px; }
`;

export const mountContractKeyPanel = (
  opts: ContractKeyPanelOptions,
): ContractKeyPanelMount => {
  const doc = opts.document;
  const now = opts.now ?? Date.now;
  const root = doc.createElement('section');
  root.setAttribute(CONTRACT_KEY_PANEL_ATTR, '');
  root.setAttribute('aria-label', 'This contract’s key');
  opts.host.appendChild(root);

  let disposed = false;
  let tokens: ReadonlyArray<McpInboundTokenRecord> | null = null;
  let listError: string | null = null;
  let actionError: string | null = null;
  let busy = false;
  let confirming = false;
  let copied = false;
  // The one-time bearer and the key it belongs to. Shown only while that key
  // is still the active one, so a key turned off and re-made elsewhere never
  // shows this mount's stale value.
  let plaintext: { token_id: string; value: string } | null = null;
  let generation = 0;
  let pendingLoad: Promise<void> = Promise.resolve();

  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    parent: HTMLElement,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    parent.appendChild(node);
    return node;
  };
  const button = (
    parent: HTMLElement,
    attr: string,
    text: string,
    onClick: () => void,
  ): HTMLButtonElement => {
    const node = el('button', parent, undefined, text);
    node.setAttribute('type', 'button');
    node.setAttribute(attr, '');
    if (busy) node.setAttribute('disabled', '');
    else node.addEventListener('click', onClick);
    return node;
  };

  const stateOf = (): ContractKeyState => {
    if (tokens === null) return listError === null ? 'loading' : 'unavailable';
    return activeKeysForContract(tokens, opts.contractId, now()).length > 0 ? 'active' : 'none';
  };

  const render = (): void => {
    if (disposed) return;
    while (root.firstChild !== null) root.removeChild(root.firstChild);
    const state = stateOf();
    root.setAttribute('data-state', state);
    root.setAttribute('aria-busy', busy ? 'true' : 'false');
    el('h3', root, undefined, 'Key');

    if (state === 'loading') {
      el('p', root, 'contract-key-copy-text', 'Checking for this contract’s key…');
      return;
    }
    if (state === 'unavailable') {
      const line = el('p', root, undefined, `Recued could not check this contract’s key: ${listError}`);
      line.setAttribute(CONTRACT_KEY_ERROR_ATTR, '');
      line.setAttribute('role', 'alert');
      return;
    }

    const active = activeKeysForContract(tokens ?? [], opts.contractId, now());
    const current = active[0];
    if (current === undefined) {
      if (opts.createBlockedReason !== null) {
        el('p', root, 'contract-key-copy-text', opts.createBlockedReason);
      } else {
        el(
          'p',
          root,
          'contract-key-copy-text',
          'An AI app connects to this contract with its key. The app can do only what '
            + 'this contract allows under Ops, Entities and Recipes, and nothing is '
            + 'allowed until you switch it on there.',
        );
        const actions = el('div', root, 'contract-key-actions');
        button(actions, CONTRACT_KEY_CREATE_ATTR, busy ? 'Creating…' : 'Create a key', () => {
          void createKey();
        });
      }
    } else {
      const shown = plaintext !== null && plaintext.token_id === current.token_id
        ? plaintext.value
        : null;
      if (shown !== null) {
        el(
          'p',
          root,
          'contract-key-copy-text',
          'Copy this key into your AI app now. You will not see it again.',
        );
        const row = el('div', root, 'contract-key-value-row');
        const value = el('code', row, undefined, shown);
        value.setAttribute(CONTRACT_KEY_VALUE_ATTR, '');
        button(row, CONTRACT_KEY_COPY_ATTR, copied ? 'Copied' : 'Copy', () => {
          copyToClipboard(shown);
        });
      } else {
        el(
          'p',
          root,
          'contract-key-copy-text',
          `This contract has a key, made ${formatClientDateTime(current.created_at, { invalidText: String(current.created_at) })}. `
            + 'Recued shows a key only once. If you no longer have it, turn it off and create a new one.',
        );
      }
      const actions = el('div', root, 'contract-key-actions');
      if (confirming) {
        el(
          'p',
          actions,
          'contract-key-warning',
          'Every app using this key stops working at once. A new key is a different key, '
            + 'so you would paste it into each app again.',
        );
        button(actions, CONTRACT_KEY_CONFIRM_ATTR, busy ? 'Turning off…' : 'Turn the key off', () => {
          void turnOff();
        });
        button(actions, CONTRACT_KEY_CANCEL_ATTR, 'Cancel', () => {
          confirming = false;
          render();
        });
      } else {
        button(actions, CONTRACT_KEY_TURN_OFF_ATTR, 'Turn off this key', () => {
          confirming = true;
          actionError = null;
          render();
        });
      }
    }

    const error = actionError ?? listError;
    if (error !== null) {
      const line = el('p', root, undefined, error);
      line.setAttribute(CONTRACT_KEY_ERROR_ATTR, '');
      line.setAttribute('role', 'alert');
    }
  };

  /** Best-effort clipboard copy. The value stays on screen for a manual copy
   *  when the clipboard is unavailable or refuses. */
  const copyToClipboard = (text: string): void => {
    const clipboard = (
      globalThis as { navigator?: { clipboard?: { writeText?: (t: string) => Promise<void> } } }
    ).navigator?.clipboard;
    if (typeof clipboard?.writeText !== 'function') return;
    try {
      void clipboard.writeText(text).then(
        () => {
          if (disposed) return;
          copied = true;
          render();
        },
        () => {},
      );
    } catch {
      // the value is on screen for a manual copy
    }
  };

  const load = (): Promise<void> => {
    const gen = ++generation;
    pendingLoad = (async () => {
      try {
        const result = await opts.runList();
        if (disposed || gen !== generation) return;
        tokens = result.tokens;
        listError = null;
      } catch (err) {
        if (disposed || gen !== generation) return;
        // Keep a prior list on a re-list failure, so a transient error cannot
        // flip a live key to "no key" on this security surface.
        listError = humanizeRpcError(err);
      }
      render();
    })();
    return pendingLoad;
  };

  const createKey = async (): Promise<void> => {
    if (busy || disposed || opts.createBlockedReason !== null) return;
    busy = true;
    actionError = null;
    copied = false;
    render();
    try {
      const issued = await opts.runIssue({
        label: opts.contractName,
        contract_id: opts.contractId,
        // The key carries no permissions; the agreement's grants are the gate.
        grants: {},
        concurrency_tier: 5,
        chat_mode: null,
      });
      if (disposed) return;
      plaintext = { token_id: issued.record.token_id, value: issued.bearer_plaintext };
      // Fold the new key in before the re-list, so the value shows even if the
      // re-list is slow or fails.
      tokens = [issued.record, ...(tokens ?? []).filter((t) => t.token_id !== issued.record.token_id)];
      generation += 1;
    } catch (err) {
      if (disposed) return;
      actionError = `Recued could not create the key: ${humanizeRpcError(err)}`;
    } finally {
      busy = false;
      if (!disposed) render();
    }
    if (!disposed) void load();
  };

  const turnOff = async (): Promise<void> => {
    if (busy || disposed) return;
    const targets = activeKeysForContract(tokens ?? [], opts.contractId, now());
    confirming = false;
    if (targets.length === 0) {
      render();
      return;
    }
    busy = true;
    actionError = null;
    render();
    try {
      const revoked: McpInboundTokenRecord[] = [];
      for (const target of targets) {
        if (disposed) return;
        const { token } = await opts.runRevoke({ token_id: target.token_id });
        revoked.push(token);
      }
      if (disposed) return;
      const byId = new Map(revoked.map((t) => [t.token_id, t] as const));
      tokens = (tokens ?? []).map((t) => byId.get(t.token_id) ?? t);
      plaintext = null;
      copied = false;
      generation += 1;
    } catch (err) {
      if (disposed) return;
      actionError = `Recued could not turn the key off: ${humanizeRpcError(err)}`;
    } finally {
      busy = false;
      if (!disposed) render();
    }
    if (!disposed) void load();
  };

  const unsubscribe = opts.subscribe?.('chat.inbound_token_changed', () => {
    if (!busy) void load();
  });

  render();
  void load();

  return {
    root,
    whenLoaded: () => pendingLoad,
    refresh: load,
    hasInFlightWork: () => busy,
    getState: stateOf,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      plaintext = null;
      unsubscribe?.();
      root.remove();
    },
  };
};

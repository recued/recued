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
export const CONTRACT_KEY_RETRY_ATTR = 'data-recued-contract-key-retry';
export const CONTRACT_KEY_COPY_STATUS_ATTR = 'data-recued-contract-key-copy-status';
const CONTRACT_KEY_HEADING_ATTR = 'data-recued-contract-key-heading';

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
[${CONTRACT_KEY_PANEL_ATTR}] button { box-sizing: border-box; min-height: 44px; appearance: none; border: 1px solid var(--border); border-radius: 7px; background: none; padding: 5px 11px; font-size: 12px; font-weight: 600; cursor: pointer; color: var(--fg); }
[${CONTRACT_KEY_PANEL_ATTR}] [${CONTRACT_KEY_CREATE_ATTR}] { color: var(--accent); border-color: var(--accent); }
[${CONTRACT_KEY_PANEL_ATTR}] :is([${CONTRACT_KEY_TURN_OFF_ATTR}], [${CONTRACT_KEY_CONFIRM_ATTR}]) { color: var(--danger, #b3261e); border-color: var(--danger, #b3261e); }
[${CONTRACT_KEY_PANEL_ATTR}] button[aria-disabled="true"] { opacity: 0.6; cursor: default; }
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
  let actionStatus: string | null = null;
  let confirmedTurnOff: readonly string[] | null = null;
  let operation: 'create' | 'turnOff' | null = null;
  let reading = false;
  let needsCheck = false;
  let confirming: readonly string[] | null = null;
  let copyState: 'idle' | 'copying' | 'copied' | 'failed' = 'idle';
  type Plaintext = { token_id: string; value: string };
  // The bearer stays in memory only for this mount and its confirmed active key.
  let plaintext: Plaintext | null = null;
  let copyGeneration = 0;
  let generation = 0;
  let pendingLoad: Promise<void> = Promise.resolve();
  const activeKeys = (): McpInboundTokenRecord[] => activeKeysForContract(tokens ?? [], opts.contractId, now());
  const keyIds = (): string[] => activeKeys().map(token => token.token_id).sort();
  const sameIds = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((id, i) => id === right[i]);
  const resetCopy = (): void => { copyGeneration++; copyState = 'idle'; };
  const controlAttrs = [CONTRACT_KEY_CREATE_ATTR, CONTRACT_KEY_COPY_ATTR, CONTRACT_KEY_TURN_OFF_ATTR,
    CONTRACT_KEY_CONFIRM_ATTR, CONTRACT_KEY_CANCEL_ATTR, CONTRACT_KEY_RETRY_ATTR] as const;
  type ControlKind = 'write' | 'copy' | 'cancel' | 'retry';
  const blocked = (kind: ControlKind): boolean => operation !== null
    || (kind === 'copy' ? copyState === 'copying' : kind === 'cancel' ? false
      : kind === 'retry' ? reading : reading || listError !== null || needsCheck);

  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K, parent: HTMLElement, className?: string, text?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    parent.appendChild(node);
    return node;
  };
  const button = (parent: HTMLElement, attr: string, text: string, kind: ControlKind, onClick: () => void): void => {
    const node = el('button', parent, undefined, text);
    node.setAttribute('type', 'button'); node.setAttribute(attr, '');
    if (blocked(kind)) node.setAttribute('aria-disabled', 'true');
    if (attr === CONTRACT_KEY_CREATE_ATTR && operation === 'create'
      || attr === CONTRACT_KEY_CONFIRM_ATTR && operation === 'turnOff'
      || kind === 'copy' && copyState === 'copying' || kind === 'retry' && reading) node.setAttribute('aria-busy', 'true');
    node.addEventListener('click', () => {
      if (!disposed && node.isConnected !== false && !blocked(kind)) onClick();
    });
  };
  const status = (text: string, attr?: string): void => {
    const line = el('p', root, 'contract-key-copy-text', text);
    line.setAttribute('role', 'status');
    if (attr) line.setAttribute(attr, '');
  };
  const stateOf = (): ContractKeyState => {
    if (tokens === null) return listError === null ? 'loading' : 'unavailable';
    return activeKeys().length > 0 ? 'active' : 'none';
  };
  const paint = (): void => {
    while (root.firstChild !== null) root.removeChild(root.firstChild);
    const state = stateOf();
    root.setAttribute('data-state', state);
    root.setAttribute('aria-busy', String(reading || operation !== null));
    const heading = el('h3', root, undefined, 'Key');
    heading.setAttribute(CONTRACT_KEY_HEADING_ATTR, ''); heading.setAttribute('tabindex', '-1');
    if (state === 'loading') el('p', root, 'contract-key-copy-text', 'Checking for this contract’s key…');
    const current = activeKeys()[0];
    if (state === 'none') {
      if (opts.createBlockedReason !== null) el('p', root, 'contract-key-copy-text', opts.createBlockedReason);
      else {
        el('p', root, 'contract-key-copy-text', 'An AI app connects to this contract with its key. The app can do only what '
          + 'this contract allows under Ops, Entities and Recipes, and nothing is allowed until you switch it on there.');
        const actions = el('div', root, 'contract-key-actions');
        button(actions, CONTRACT_KEY_CREATE_ATTR, operation === 'create' ? 'Creating…' : 'Create a key', 'write', () => { void createKey(); });
      }
    } else if (current !== undefined) {
      const shown = plaintext?.token_id === current.token_id ? plaintext : null;
      if (shown !== null) {
        el('p', root, 'contract-key-copy-text', 'Copy this key into your AI app now. You will not see it again.');
        const row = el('div', root, 'contract-key-value-row');
        const value = el('code', row, undefined, shown.value);
        value.setAttribute(CONTRACT_KEY_VALUE_ATTR, ''); value.setAttribute('data-token-id', shown.token_id);
        button(row, CONTRACT_KEY_COPY_ATTR, copyState === 'copying' ? 'Copying…' : copyState === 'copied' ? 'Copied' : 'Copy', 'copy', () => { void copyToClipboard(shown); });
        if (copyState !== 'idle') status(copyState === 'copying' ? 'Copying the key…' : copyState === 'copied' ? 'Key copied.'
          : 'Could not copy the key. Select the key above and copy it manually.', CONTRACT_KEY_COPY_STATUS_ATTR);
      } else {
        el('p', root, 'contract-key-copy-text', 'This contract has a key, made '
          + formatClientDateTime(current.created_at, { invalidText: String(current.created_at) })
          + '. Recued shows a key only once. If you no longer have it, turn it off and create a new one.');
      }
      const actions = el('div', root, 'contract-key-actions');
      if (confirming !== null) {
        el('p', actions, 'contract-key-warning', 'Every app using this key stops working at once. A new key is a different key, '
          + 'so you would paste it into each app again.');
        button(actions, CONTRACT_KEY_CONFIRM_ATTR, operation === 'turnOff' ? 'Turning off…' : 'Turn the key off', 'write', () => { void turnOff(); });
        button(actions, CONTRACT_KEY_CANCEL_ATTR, 'Cancel', 'cancel', () => { confirming = null; render(); });
      } else {
        button(actions, CONTRACT_KEY_TURN_OFF_ATTR, 'Turn off this key', 'write', () => {
          confirming = keyIds(); actionError = null; actionStatus = null; confirmedTurnOff = null; render();
        });
      }
    }
    if (actionStatus !== null) status(actionStatus);
    const error = actionError ?? listError;
    if (error !== null) {
      const line = el('p', root, undefined, error);
      line.setAttribute(CONTRACT_KEY_ERROR_ATTR, ''); line.setAttribute('role', 'alert');
    }
    if (listError !== null && tokens !== null) el('p', root, 'contract-key-copy-text',
      'Showing the last confirmed key state. Check it again before creating or turning off a key.');
    if (listError !== null || needsCheck) {
      button(root, CONTRACT_KEY_RETRY_ATTR, reading ? 'Checking…' : 'Retry key lookup', 'retry', () => { void load(); });
    }
  };
  const render = (): void => {
    if (disposed) return;
    const focused = doc.activeElement;
    const held = focused ? controlAttrs.find(attr => root.querySelector('[' + attr + ']') === focused) : undefined;
    const oldValue = root.querySelector<HTMLElement>('[' + CONTRACT_KEY_VALUE_ATTR + ']');
    const selection = doc.getSelection?.();
    const selected = oldValue && selection?.anchorNode === oldValue.firstChild && selection?.focusNode === oldValue.firstChild
      ? { token: oldValue.getAttribute('data-token-id'), text: oldValue.textContent, start: selection.anchorOffset, end: selection.focusOffset } : null;
    paint();
    if (held && (doc.activeElement === focused || doc.activeElement === doc.body)) {
      let next = root.querySelector<HTMLElement>('[' + held + ']');
      if (!next && held === CONTRACT_KEY_TURN_OFF_ATTR) next = root.querySelector('[' + CONTRACT_KEY_CONFIRM_ATTR + ']');
      if (!next && held === CONTRACT_KEY_CANCEL_ATTR) next = root.querySelector('[' + CONTRACT_KEY_TURN_OFF_ATTR + ']');
      next ??= root.querySelector('[' + CONTRACT_KEY_COPY_ATTR + ']') ?? root.querySelector('[' + CONTRACT_KEY_CREATE_ATTR + ']')
        ?? root.querySelector('[' + CONTRACT_KEY_TURN_OFF_ATTR + ']') ?? root.querySelector('[' + CONTRACT_KEY_RETRY_ATTR + ']')
        ?? root.querySelector('[' + CONTRACT_KEY_HEADING_ATTR + ']');
      next?.focus({ preventScroll: true });
    }
    const value = root.querySelector<HTMLElement>('[' + CONTRACT_KEY_VALUE_ATTR + ']');
    if (selected && value?.firstChild && value.getAttribute('data-token-id') === selected.token && value.textContent === selected.text) {
      selection?.setBaseAndExtent(value.firstChild, selected.start, value.firstChild, selected.end);
    }
  };
  const reconcile = (): void => {
    if (plaintext !== null && activeKeys()[0]?.token_id !== plaintext.token_id) { plaintext = null; resetCopy(); }
    if (confirming !== null && !sameIds(confirming, keyIds())) {
      confirming = null; actionStatus = 'The saved key changed. Review it before turning it off.';
    }
    const turnedOff = confirmedTurnOff, active = keyIds();
    if (turnedOff !== null && active.length > 0) {
      actionStatus = active.some(id => turnedOff.includes(id))
        ? 'A saved key is still active. Review it before trying again.'
        : (turnedOff.length === 1 ? 'The previous key was turned off. ' : 'The previous keys were turned off. ')
          + 'A different key is now active for this contract.';
    }
  };
  const copyToClipboard = async (owner: Plaintext): Promise<void> => {
    if (disposed || blocked('copy') || plaintext !== owner || activeKeys()[0]?.token_id !== owner.token_id) return;
    const copy = ++copyGeneration;
    copyState = 'copying'; render();
    let succeeded = false;
    try {
      const clipboard = (doc.defaultView?.navigator ?? globalThis.navigator)?.clipboard;
      if (typeof clipboard?.writeText === 'function') { await clipboard.writeText(owner.value); succeeded = true; }
    } catch { /* The generic manual-copy help must never repeat a credential or browser exception. */ }
    if (disposed || copy !== copyGeneration || plaintext !== owner || activeKeys()[0]?.token_id !== owner.token_id) return;
    copyState = succeeded ? 'copied' : 'failed'; render();
  };
  const load = (): Promise<void> => {
    if (disposed || operation !== null) return pendingLoad;
    const gen = ++generation; reading = true; render();
    pendingLoad = (async () => {
      try {
        const result = await opts.runList();
        if (disposed || gen !== generation) return;
        tokens = result.tokens; listError = null; needsCheck = false; reconcile();
      } catch (err) {
        if (disposed || gen !== generation) return;
        listError = 'Could not check this contract’s key: ' + (humanizeRpcError(err).trim() || 'Try again in a moment.');
      } finally {
        if (!disposed && gen === generation) { reading = false; render(); }
      }
    })();
    return pendingLoad;
  };
  const beginWrite = (kind: 'create' | 'turnOff'): void => {
    operation = kind; generation++; reading = false; actionError = null; actionStatus = null; confirmedTurnOff = null; resetCopy(); render();
  };
  const finishWrite = (): void => {
    operation = null;
    if (!disposed) { needsCheck = true; render(); void load(); }
  };
  const createKey = async (): Promise<void> => {
    if (disposed || blocked('write') || tokens === null || activeKeys().length > 0 || opts.createBlockedReason !== null) return;
    beginWrite('create');
    try {
      const issued = await opts.runIssue({ label: opts.contractName, contract_id: opts.contractId, grants: {}, concurrency_tier: 5, chat_mode: null });
      if (disposed) return;
      plaintext = { token_id: issued.record.token_id, value: issued.bearer_plaintext };
      tokens = [issued.record, ...(tokens ?? []).filter(token => token.token_id !== issued.record.token_id)];
    } catch (err) {
      if (!disposed) actionError = 'Couldn’t confirm key creation: ' + humanizeRpcError(err) + ' Check the saved key before trying again.';
    } finally { finishWrite(); }
  };
  const turnOff = async (): Promise<void> => {
    if (disposed || blocked('write') || confirming === null || !sameIds(confirming, keyIds())) return;
    const targets = activeKeys();
    if (targets.length === 0) return;
    beginWrite('turnOff');
    try {
      for (const target of targets) {
        if (disposed) return;
        const { token } = await opts.runRevoke({ token_id: target.token_id });
        if (disposed) return;
        if (token.token_id !== target.token_id || isMcpInboundTokenActive(token, now())) throw new Error('The server did not confirm that this key is off.');
        // Each acknowledgement remains confirmed even if another older key or the next read fails.
        tokens = (tokens ?? []).map(old => old.token_id === token.token_id ? token : old);
        if (plaintext?.token_id === token.token_id) { plaintext = null; resetCopy(); }
      }
      confirmedTurnOff = targets.map(token => token.token_id);
      actionStatus = 'Key turned off.';
    } catch (err) {
      if (!disposed) actionError = 'Couldn’t confirm the key was turned off: ' + humanizeRpcError(err) + ' Check the saved key before trying again.';
    } finally { confirming = null; finishWrite(); }
  };
  const unsubscribe = opts.subscribe?.('chat.inbound_token_changed', () => { if (operation === null) void load(); });
  void load();
  return {
    root, whenLoaded: () => pendingLoad, refresh: load, hasInFlightWork: () => operation !== null, getState: stateOf,
    dispose(): void {
      if (disposed) return;
      disposed = true; plaintext = null; resetCopy(); generation++; unsubscribe?.(); root.remove();
    },
  };
};

/** D-174 — Settings -> Account recued.com binding touchpoint.
 *
 *  Reads secret-free binding status from the paired server, mints the
 *  Worker-issued binding token through the auth cookie session, relays
 *  only that token via `account.bind`, and renders Pro-convenience
 *  posture from `pro_convenience.status`.
 *
 *  ⛔ The recued.com session read (`runReadSession` -> the auth Worker's
 *  `/v1/auth/session`) is the ONLY cross-origin call this panel makes, and it
 *  is gated: it runs on refresh ONLY when the paired server holds an account
 *  binding, plus inside the user-initiated connect action. A self-hosted
 *  server with no account never reaches recued.com just because the owner
 *  opened Settings — the Settings route mounts every section eagerly, so an
 *  ungated read made opening ANY settings surface a cloud call.
 */

import type {
  AccountBindRelayRequest,
  AccountBindResult,
  AccountBindingStatusResponse,
  AccountBindingSummary,
  AccountUnbindResult,
  ProConvenienceItem,
  ProConvenienceStatusResponse,
} from '@recued/contracts';
import { formatClientDateTime } from '@recued/ui-shared';

import type {
  AccountBindingAuthSession,
  BindingTokenMintResponse,
} from './account-binding-auth-client.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

export type AccountBindingStatusCaller = () => Promise<AccountBindingStatusResponse>;
export type AccountBindCaller = (args: AccountBindRelayRequest) => Promise<AccountBindResult>;
export type AccountUnbindCaller = () => Promise<AccountUnbindResult>;
export type ProConvenienceStatusCaller = () => Promise<ProConvenienceStatusResponse>;
export type AccountBindingTokenMintCaller = () => Promise<BindingTokenMintResponse>;
export type AccountBindingSessionCaller = () => Promise<AccountBindingAuthSession>;
export type AccountSignOutCaller = () => Promise<void>;

export type AccountBindingPanelPhase = 'loading' | 'ready';
export type AccountBindingActionPhase =
  | 'idle'
  | 'refreshing'
  | 'connecting'
  | 'confirming'
  | 'unbinding'
  | 'signing-out';
export type AccountBindingViewState =
  | 'not-connected'
  | 'connected-no-server'
  | 'bound-active'
  | 'conflict';

export interface AccountBindingPanelState {
  phase: AccountBindingPanelPhase;
  action: AccountBindingActionPhase;
  bindingStatus: AccountBindingStatusResponse | null;
  proStatus: ProConvenienceStatusResponse | null;
  session: AccountBindingAuthSession | null;
  conflict: Extract<AccountBindResult, { outcome: 'conflict' }> | null;
  errors: {
    bindingStatus: string | null;
    proStatus: string | null;
    session: string | null;
    action: string | null;
  };
  actionMessage: string | null;
}

export interface MountAccountBindingPanelOptions {
  host: HTMLElement;
  document?: Document;
  runBindingStatus: AccountBindingStatusCaller;
  runBind: AccountBindCaller;
  runUnbind: AccountUnbindCaller;
  runProStatus: ProConvenienceStatusCaller;
  mintBindingToken: AccountBindingTokenMintCaller;
  runReadSession?: AccountBindingSessionCaller;
  /** Optional recued.com session sign-out (Worker `/v1/auth/signout`, local
   *  scope). When wired, the recued.com card offers a "Sign out" action while
   *  a browser session is live; absent → no sign-out affordance. */
  runSignOut?: AccountSignOutCaller;
  dashboardUrl?: string;
}

export interface AccountBindingPanelMount {
  getState(): AccountBindingPanelState;
  viewState(): AccountBindingViewState;
  /** A user-started account mutation whose authoritative refresh has not
   *  settled yet. Eager/read-recovery status loads are deliberately excluded. */
  hasInFlightWork(): boolean;
  refresh(): Promise<void>;
  whenLoaded(): Promise<void>;
  connect(): Promise<void>;
  confirmRebind(): Promise<void>;
  cancelRebind(): void;
  unbind(): Promise<void>;
  signOut(): Promise<void>;
  dispose(): void;
}

export const ACCOUNT_BINDING_PANEL_ATTR = 'data-recued-account-binding-panel';
export const ACCOUNT_BINDING_PANEL_STATE_ATTR = 'data-recued-account-binding-state';
export const ACCOUNT_BINDING_LOADING_ATTR = 'data-recued-account-binding-loading';
export const ACCOUNT_BINDING_ERROR_ATTR = 'data-recued-account-binding-error';
export const ACCOUNT_BINDING_RETRY_ATTR = 'data-recued-account-binding-retry';
export const ACCOUNT_BINDING_STATUS_CHIP_ATTR = 'data-recued-account-binding-status-chip';
export const ACCOUNT_BINDING_SUMMARY_ATTR = 'data-recued-account-binding-summary';
export const ACCOUNT_BINDING_CONNECT_ATTR = 'data-recued-account-binding-connect';
export const ACCOUNT_BINDING_CONFIRM_REBIND_ATTR = 'data-recued-account-binding-confirm-rebind';
export const ACCOUNT_BINDING_CANCEL_REBIND_ATTR = 'data-recued-account-binding-cancel-rebind';
export const ACCOUNT_BINDING_UNBIND_ATTR = 'data-recued-account-binding-unbind';
export const ACCOUNT_BINDING_UNBIND_CONFIRMATION_ATTR = 'data-recued-account-binding-unbind-confirmation';
export const ACCOUNT_BINDING_CONFIRM_UNBIND_ATTR = 'data-recued-account-binding-confirm-unbind';
export const ACCOUNT_BINDING_CANCEL_UNBIND_ATTR = 'data-recued-account-binding-cancel-unbind';
export const ACCOUNT_BINDING_SIGNOUT_ATTR = 'data-recued-account-binding-signout';
export const ACCOUNT_BINDING_SESSION_ATTR = 'data-recued-account-binding-session';
export const ACCOUNT_BINDING_DASHBOARD_LINK_ATTR = 'data-recued-account-binding-dashboard-link';
export const ACCOUNT_BINDING_FREE_CARD_ATTR = 'data-recued-account-binding-free-card';
export const ACCOUNT_BINDING_FREE_HANDLE_ATTR = 'data-recued-account-binding-free-handle';
export const ACCOUNT_BINDING_FREE_CLAIM_ATTR = 'data-recued-account-binding-free-claim';
export const ACCOUNT_BINDING_PUBLISHING_LINK_ATTR = 'data-recued-account-binding-publishing-link';
export const ACCOUNT_BINDING_PRO_ITEM_ATTR = 'data-recued-account-binding-pro-item';
export const ACCOUNT_BINDING_PRO_LIFECYCLE_ATTR = 'data-recued-account-binding-pro-lifecycle';
export const ACCOUNT_BINDING_PRO_SUBSCRIBE_ATTR = 'data-recued-account-binding-pro-subscribe';
export const ACCOUNT_BINDING_ACTION_MESSAGE_ATTR = 'data-recued-account-binding-action-message';

const DEFAULT_DASHBOARD_URL = 'https://dashboard.recued.com/';

const errMessage = (err: unknown): string =>
  humanizeRpcError(err);

const readErrorMessage = (
  err: unknown,
  source: 'server' | 'recued.com',
): string => {
  const message = errMessage(err);
  if (!/(failed to fetch|network request failed|load failed|networkerror)/i.test(message)) {
    return message;
  }
  return source === 'recued.com'
    ? 'Couldn’t reach recued.com. Your local Recued server is still connected.'
    : 'Couldn’t load account status from your Recued server. Try again.';
};

const clearChildren = (el: HTMLElement): void => {
  while (el.firstChild) el.removeChild(el.firstChild);
};

const append = <K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  parent: HTMLElement,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] => {
  const child = doc.createElement(tag);
  if (className !== undefined) child.className = className;
  parent.appendChild(child);
  return child;
};

const formatTimestamp = (value: number | undefined): string =>
  typeof value === 'number' && Number.isFinite(value)
    ? formatClientDateTime(value, { invalidText: 'Not set' })
    : 'Not set';

const accountLabel = (
  value: { account_id: string; publisher_handle?: string },
): string => {
  const handle = value.publisher_handle ? ` (@${value.publisher_handle})` : '';
  return `${value.account_id}${handle}`;
};

// Post-R27 the marketplace handle is a Free-account item, not a Pro
// convenience; the Pro card carries only the DDNS web address + ACME cert.
const itemLabel = (item: 'ddns' | 'acme'): string => {
  switch (item) {
    case 'ddns':
      return 'Web address';
    case 'acme':
      return 'HTTPS certificate';
  }
};

const entitlementLabel = (value: ProConvenienceStatusResponse['entitlement']): string => {
  switch (value) {
    case 'entitled':
      return 'Active';
    case 'not_entitled':
      return 'Free';
    case 'unbound':
      return 'Awaiting server';
    case 'pending':
      return 'Pending';
    case 'unavailable':
      return 'Unavailable';
  }
};

// The Pro lifecycle line. The contract today carries only the five
// `entitlement` states below; the richer paid lifecycle (past-due /
// suspended / cancelled) arrives with the shared Pro-status feed (treemap
// §ACCOUNT "needs the shared Pro-status + handle FEED") — a marked seam.
const lifecycleLabel = (value: ProConvenienceStatusResponse['entitlement']): string => {
  switch (value) {
    case 'entitled':
      return 'Pro — active';
    case 'not_entitled':
      return 'Free account';
    case 'unbound':
      return 'No account connected';
    case 'pending':
      return 'Checking subscription…';
    case 'unavailable':
      return 'Status unavailable';
  }
};

const itemStateLabel = (state: ProConvenienceItem['state']): string => {
  switch (state) {
    case 'active':
      return 'Active';
    case 'error':
      return 'Error';
    case 'awaiting-server':
      return 'Awaiting server';
    case 'awaiting-reachability':
      return 'Awaiting reachability';
    case 'inactive-free':
      return 'Free account';
    case 'pending':
      return 'Pending';
  }
};

// Human copy for the closed-list detail code on a non-active Pro item; the raw
// code is a display hint, never shown verbatim. Exhaustive over
// PRO_CONVENIENCE_DETAIL_CODES (tsc flags a missing arm if a code is added).
const proDetailCopy = (detail: NonNullable<ProConvenienceItem['detail']>): string => {
  switch (detail) {
    case 'entitlement_endpoint_pending':
      return 'Subscription check coming soon';
    case 'entitlement_unavailable':
      return "Couldn't verify subscription";
    case 'no_binding':
      return 'Connect your account first';
    case 'not_reachable':
      return 'Waiting for your server to be reachable';
    case 'free_account':
      return 'Included with Pro';
    case 'cert_expired':
      return 'Certificate expired';
    case 'not_provisioned':
      return 'Not set up yet';
  }
};

const renderError = (
  doc: Document,
  parent: HTMLElement,
  scope: string,
  message: string,
): void => {
  const chip = append(doc, parent, 'p', 'account-bind-error');
  chip.setAttribute(ACCOUNT_BINDING_ERROR_ATTR, scope);
  chip.setAttribute('role', 'alert');
  chip.textContent = message;
};

const renderLabelValue = (
  doc: Document,
  parent: HTMLElement,
  label: string,
  value: string,
): void => {
  const row = append(doc, parent, 'div', 'account-bind-kv');
  const k = append(doc, row, 'span', 'account-bind-k');
  k.textContent = label;
  const v = append(doc, row, 'span', 'account-bind-v');
  v.textContent = value;
};

const cloneState = (state: AccountBindingPanelState): AccountBindingPanelState => ({
  ...state,
  errors: { ...state.errors },
});

export const mountAccountBindingPanel = (
  opts: MountAccountBindingPanelOptions,
): AccountBindingPanelMount => {
  const docMaybe = opts.document ?? (globalThis as { document?: Document }).document;
  if (docMaybe === undefined) {
    throw new Error(
      'mountAccountBindingPanel: no document available - pass `opts.document` for non-browser environments',
    );
  }
  const doc: Document = docMaybe;
  const dashboardUrl = opts.dashboardUrl ?? DEFAULT_DASHBOARD_URL;

  let state: AccountBindingPanelState = {
    phase: 'loading',
    action: 'idle',
    bindingStatus: null,
    proStatus: null,
    session: null,
    conflict: null,
    errors: {
      bindingStatus: null,
      proStatus: null,
      session: null,
      action: null,
    },
    actionMessage: null,
  };
  let disposed = false;
  let loadGeneration = 0;
  let pendingLoad: Promise<void> = Promise.resolve();
  let unbindConfirmationOpen = false;
  let mutationInFlight = false;

  const root = doc.createElement('div');
  root.setAttribute(ACCOUNT_BINDING_PANEL_ATTR, '');
  opts.host.appendChild(root);

  const viewState = (): AccountBindingViewState => {
    if (state.conflict !== null) return 'conflict';
    if (state.bindingStatus?.status === 'bound') return 'bound-active';
    if (state.session?.authenticated === true) return 'connected-no-server';
    return 'not-connected';
  };

  const isBusy = (): boolean => state.action !== 'idle';

  const hasReadError = (): boolean =>
    state.errors.bindingStatus !== null
    || state.errors.proStatus !== null
    || state.errors.session !== null;

  const findControl = (attr: string): HTMLElement | null => {
    if (typeof root.querySelector !== 'function') return null;
    return root.querySelector<HTMLElement>(`[${attr}]`);
  };

  const focusControl = (attr: string): void => {
    const control = findControl(attr);
    if (control === null) return;
    control.focus({ preventScroll: true });
    control.scrollIntoView?.({ block: 'nearest' });
  };

  const controlHasFocus = (attr: string): boolean => {
    const active = doc.activeElement as HTMLElement | null | undefined;
    return active !== null
      && active !== undefined
      && typeof active.hasAttribute === 'function'
      && active.hasAttribute(attr);
  };

  const focusIsUnowned = (): boolean =>
    doc.activeElement === null
    || doc.activeElement === undefined
    || doc.activeElement === doc.body;

  const setState = (patch: Partial<AccountBindingPanelState>): void => {
    if (disposed) return;
    state = { ...state, ...patch };
    render();
  };

  const setActionError = (message: string): void => {
    setState({
      action: 'idle',
      errors: { ...state.errors, action: message },
    });
  };

  const renderStatusSummary = (parent: HTMLElement, binding: AccountBindingSummary): void => {
    const summary = append(doc, parent, 'div', 'account-bind-summary');
    summary.setAttribute(ACCOUNT_BINDING_SUMMARY_ATTR, '');
    renderLabelValue(doc, summary, 'Account', accountLabel(binding));
    renderLabelValue(doc, summary, 'Bound at', formatTimestamp(binding.bound_at));
    if (binding.rebound_at !== undefined) {
      renderLabelValue(doc, summary, 'Rebound at', formatTimestamp(binding.rebound_at));
    }
    if (binding.credential_expires_at !== undefined) {
      renderLabelValue(doc, summary, 'Credential expires', formatTimestamp(binding.credential_expires_at));
    }
  };

  const renderActions = (parent: HTMLElement): void => {
    const actions = append(doc, parent, 'div', 'account-bind-actions');
    // Binding mutations require a confirmed-current status read. When the
    // latest read failed, the dedicated Retry owns recovery instead of
    // presenting "Connect" from an unknown/null state.
    if (
      state.bindingStatus !== null
      && state.errors.bindingStatus === null
    ) {
      const connect = append(doc, actions, 'button', 'rx-btn rx-btn-primary');
      connect.setAttribute('type', 'button');
      connect.setAttribute(ACCOUNT_BINDING_CONNECT_ATTR, '');
      const connecting = state.action === 'connecting';
      connect.textContent = connecting
        ? 'Connecting…'
        : state.bindingStatus.status === 'bound'
          ? 'Refresh binding'
          : 'Connect your recued.com account';
      if (isBusy()) connect.setAttribute('aria-disabled', 'true');
      if (connecting) connect.setAttribute('aria-busy', 'true');
      connect.addEventListener('click', () => {
        void connectFlow(false, true);
      });

      if (state.bindingStatus.status === 'bound') {
        const unbind = append(doc, actions, 'button', 'rx-btn rx-btn-secondary');
        unbind.setAttribute('type', 'button');
        unbind.setAttribute(ACCOUNT_BINDING_UNBIND_ATTR, '');
        unbind.textContent = 'Disconnect';
        unbind.disabled = isBusy();
        unbind.addEventListener('click', () => {
          openUnbindConfirmation(true);
        });
      }
    }

    // Sign out of the recued.com browser session (Worker local-scope signout).
    // Independent of the server binding: it shows whenever a session is live,
    // leaves the pairing intact, and is deliberately NOT "Disconnect" (unbind).
    if (opts.runSignOut !== undefined && state.session?.authenticated === true) {
      const signOutBtn = append(doc, actions, 'button', 'rx-btn rx-btn-secondary');
      signOutBtn.setAttribute('type', 'button');
      signOutBtn.setAttribute(ACCOUNT_BINDING_SIGNOUT_ATTR, '');
      const signingOut = state.action === 'signing-out';
      signOutBtn.textContent = signingOut ? 'Signing out…' : 'Sign out';
      if (isBusy()) signOutBtn.setAttribute('aria-disabled', 'true');
      if (signingOut) signOutBtn.setAttribute('aria-busy', 'true');
      signOutBtn.addEventListener('click', () => {
        void signOutFlow(true);
      });
    }

    const dashboard = append(
      doc,
      actions,
      'a',
      'account-bind-dashboard-link rx-btn rx-btn-secondary',
    );
    dashboard.setAttribute('href', dashboardUrl);
    dashboard.setAttribute('target', '_blank');
    dashboard.setAttribute('rel', 'noopener noreferrer');
    dashboard.setAttribute(ACCOUNT_BINDING_DASHBOARD_LINK_ATTR, '');
    dashboard.textContent = 'Open dashboard';
  };

  const renderReadRecovery = (parent: HTMLElement): void => {
    const refreshing = state.action === 'refreshing';
    if (!refreshing && !hasReadError()) return;
    const retry = append(doc, parent, 'button', 'rx-btn rx-btn-secondary');
    retry.setAttribute('type', 'button');
    retry.setAttribute(ACCOUNT_BINDING_RETRY_ATTR, '');
    retry.textContent = refreshing
      ? 'Retrying account status…'
      : 'Retry account status';
    if (refreshing) {
      retry.setAttribute('aria-disabled', 'true');
      retry.setAttribute('aria-busy', 'true');
    }
    retry.addEventListener('click', () => {
      void retryAndTrack(true);
    });
  };

  const renderConflict = (parent: HTMLElement): void => {
    if (state.conflict === null) return;
    const box = append(doc, parent, 'div', 'account-bind-conflict');
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-labelledby', 'account-binding-conflict-title');
    const title = append(doc, box, 'h4');
    title.setAttribute('id', 'account-binding-conflict-title');
    title.textContent = 'Binding conflict';
    renderLabelValue(doc, box, 'Current owner', accountLabel(state.conflict.current_owner));
    renderLabelValue(doc, box, 'Incoming account', accountLabel(state.conflict.incoming));
    const actions = append(doc, box, 'div', 'account-bind-actions');
    const confirm = append(doc, actions, 'button', 'rx-btn rx-btn-primary');
    confirm.setAttribute('type', 'button');
    confirm.setAttribute(ACCOUNT_BINDING_CONFIRM_REBIND_ATTR, '');
    const confirming = state.action === 'confirming';
    confirm.textContent = confirming ? 'Rebinding…' : 'Confirm rebind';
    if (isBusy()) confirm.setAttribute('aria-disabled', 'true');
    if (confirming) confirm.setAttribute('aria-busy', 'true');
    confirm.addEventListener('click', () => {
      void connectFlow(true, true);
    });
    const cancel = append(doc, actions, 'button', 'rx-btn rx-btn-secondary');
    cancel.setAttribute('type', 'button');
    cancel.setAttribute(ACCOUNT_BINDING_CANCEL_REBIND_ATTR, '');
    cancel.textContent = 'Cancel';
    if (isBusy()) cancel.setAttribute('aria-disabled', 'true');
    cancel.addEventListener('click', () => cancelRebind(true));
  };

  const renderUnbindConfirmation = (parent: HTMLElement): void => {
    if (!unbindConfirmationOpen) return;
    const box = append(doc, parent, 'div', 'account-bind-conflict');
    box.setAttribute(ACCOUNT_BINDING_UNBIND_CONFIRMATION_ATTR, '');
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-labelledby', 'account-binding-unbind-title');
    box.setAttribute('aria-describedby', 'account-binding-unbind-description');
    const title = append(doc, box, 'h4');
    title.setAttribute('id', 'account-binding-unbind-title');
    title.textContent = 'Disconnect this server?';
    const description = append(doc, box, 'p', 'account-bind-message');
    description.setAttribute('id', 'account-binding-unbind-description');
    description.textContent =
      'This removes the server’s recued.com binding. Your browser stays signed in, and you can reconnect the server later.';
    const actions = append(doc, box, 'div', 'account-bind-actions');
    const confirm = append(doc, actions, 'button', 'rx-btn rx-btn-danger');
    confirm.setAttribute('type', 'button');
    confirm.setAttribute(ACCOUNT_BINDING_CONFIRM_UNBIND_ATTR, '');
    const unbinding = state.action === 'unbinding';
    confirm.textContent = unbinding ? 'Disconnecting…' : 'Disconnect server';
    if (isBusy()) confirm.setAttribute('aria-disabled', 'true');
    if (unbinding) confirm.setAttribute('aria-busy', 'true');
    confirm.addEventListener('click', () => {
      void unbindFlow(true);
    });
    const cancel = append(doc, actions, 'button', 'rx-btn rx-btn-secondary');
    cancel.setAttribute('type', 'button');
    cancel.setAttribute(ACCOUNT_BINDING_CANCEL_UNBIND_ATTR, '');
    cancel.textContent = 'Cancel';
    if (isBusy()) cancel.setAttribute('aria-disabled', 'true');
    cancel.addEventListener('click', () => cancelUnbind(true));
  };

  const renderConnectionCard = (parent: HTMLElement): void => {
    const card = append(doc, parent, 'section', 'account-bind-card');
    const header = append(doc, card, 'div', 'account-bind-card-head');
    const title = append(doc, header, 'h3');
    title.textContent = 'recued.com account';
    const chip = append(doc, header, 'span', 'account-bind-chip');
    chip.setAttribute(ACCOUNT_BINDING_STATUS_CHIP_ATTR, viewState());

    switch (viewState()) {
      case 'bound-active':
        chip.textContent = 'Bound';
        break;
      case 'connected-no-server':
        chip.textContent = 'Connected, server not bound';
        break;
      case 'conflict':
        chip.textContent = 'Conflict';
        break;
      case 'not-connected':
        chip.textContent = state.errors.bindingStatus && state.bindingStatus === null
          ? 'Status unavailable'
          : 'Not connected';
        break;
    }

    if (state.errors.session !== null) {
      renderError(doc, card, 'session', state.errors.session);
    }
    if (state.errors.bindingStatus !== null) {
      renderError(doc, card, 'bindingStatus', state.errors.bindingStatus);
    }
    if (state.actionMessage !== null) {
      const msg = append(doc, card, 'p', 'account-bind-message');
      msg.setAttribute(ACCOUNT_BINDING_ACTION_MESSAGE_ATTR, '');
      msg.textContent = state.actionMessage;
    }
    if (state.errors.action !== null) {
      renderError(doc, card, 'action', state.errors.action);
    }
    renderReadRecovery(card);

    if (state.session?.authenticated === true && state.session.user !== null) {
      const signedIn = append(doc, card, 'p', 'account-bind-message');
      signedIn.setAttribute(ACCOUNT_BINDING_SESSION_ATTR, '');
      signedIn.textContent = 'Signed in as ' + state.session.user.email;
    }

    const binding = state.bindingStatus?.binding ?? null;
    if (binding !== null) renderStatusSummary(card, binding);
    renderConflict(card);
    renderUnbindConfirmation(card);
    renderActions(card);
  };

  const renderProItem = (
    parent: HTMLElement,
    key: 'ddns' | 'acme',
    item: ProConvenienceItem,
    value?: string,
  ): void => {
    const row = append(doc, parent, 'div', 'account-bind-pro-item');
    row.setAttribute(ACCOUNT_BINDING_PRO_ITEM_ATTR, key);
    const label = append(doc, row, 'span', 'account-bind-pro-label');
    label.textContent = itemLabel(key);
    if (value !== undefined && value.length > 0) {
      const valueEl = append(doc, row, 'span', 'account-bind-pro-value');
      valueEl.textContent = value;
    }
    const stateEl = append(doc, row, 'span', 'account-bind-pro-state');
    stateEl.textContent = itemStateLabel(item.state);
    if (item.detail !== undefined) {
      const detail = append(doc, row, 'span', 'account-bind-pro-detail');
      detail.textContent = proDetailCopy(item.detail);
    }
    if (item.expires_at !== undefined) {
      const expiry = append(doc, row, 'span', 'account-bind-pro-detail');
      expiry.textContent = 'Expires ' + formatTimestamp(item.expires_at);
    }
  };

  // Free-account card (R27): the marketplace publisher handle is a Free, not a
  // Pro, item — the same handle string the Pro DDNS/ACME conveniences face. The
  // proStatus read backs both this card and the Pro card; its error surfaces
  // ONCE here (the first pro-derived card), then both no-op on a null status.
  const renderFreeAccountCard = (parent: HTMLElement): void => {
    const card = append(doc, parent, 'section', 'account-bind-card');
    card.setAttribute(ACCOUNT_BINDING_FREE_CARD_ATTR, '');
    const header = append(doc, card, 'div', 'account-bind-card-head');
    const title = append(doc, header, 'h3');
    title.textContent = 'Free account';

    const blurb = append(doc, card, 'p', 'account-bind-message');
    blurb.textContent =
      'Your recued.com account is free. It reserves a marketplace publisher handle so you can share recipes and packs.';

    if (state.errors.proStatus !== null) {
      renderError(doc, card, 'proStatus', state.errors.proStatus);
    }
    if (state.proStatus === null) return;

    const handle = state.proStatus.publisher_handle;
    if (handle !== undefined && handle.length > 0) {
      const handleRow = append(doc, card, 'div', 'account-bind-kv');
      handleRow.setAttribute(ACCOUNT_BINDING_FREE_HANDLE_ATTR, '');
      const handleKey = append(doc, handleRow, 'span', 'account-bind-k');
      handleKey.textContent = 'Marketplace handle';
      const handleValue = append(doc, handleRow, 'span', 'account-bind-v');
      handleValue.textContent = '@' + handle;

      const pubRow = append(doc, card, 'div', 'account-bind-kv');
      const pubKey = append(doc, pubRow, 'span', 'account-bind-k');
      pubKey.textContent = 'Publishing';
      const pubValue = append(doc, pubRow, 'span', 'account-bind-v');
      pubValue.textContent = 'Free';
      const manage = append(
        doc,
        pubRow,
        'a',
        'account-bind-dashboard-link account-bind-dashboard-inline',
      );
      manage.setAttribute('href', dashboardUrl);
      manage.setAttribute('target', '_blank');
      manage.setAttribute('rel', 'noopener noreferrer');
      manage.setAttribute(ACCOUNT_BINDING_PUBLISHING_LINK_ATTR, '');
      manage.textContent = 'Manage in dashboard';
    } else {
      const claim = append(doc, card, 'p', 'account-bind-message');
      claim.setAttribute(ACCOUNT_BINDING_FREE_CLAIM_ATTR, '');
      claim.textContent = 'No marketplace handle reserved yet.';
      const link = append(
        doc,
        card,
        'a',
        'account-bind-dashboard-link rx-btn rx-btn-secondary',
      );
      link.setAttribute('href', dashboardUrl);
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
      link.setAttribute(ACCOUNT_BINDING_PUBLISHING_LINK_ATTR, '');
      link.textContent = 'Claim your handle in the dashboard';
    }
  };

  const renderProCard = (parent: HTMLElement): void => {
    const card = append(doc, parent, 'section', 'account-bind-card');
    const header = append(doc, card, 'div', 'account-bind-card-head');
    const title = append(doc, header, 'h3');
    title.textContent = 'Pro conveniences';
    if (state.proStatus !== null) {
      const chip = append(doc, header, 'span', 'account-bind-chip');
      chip.textContent = entitlementLabel(state.proStatus.entitlement);
    }
    const blurb = append(doc, card, 'p', 'account-bind-message');
    blurb.textContent =
      'Optional $5.99/mo conveniences that save setup work — a ready-to-use web address (DDNS) and an auto-renewing HTTPS certificate (ACME). You can set these up yourself for free instead.';
    // proStatus errors surface once on the Free card above.
    if (state.proStatus === null) return;

    const lifecycleRow = append(doc, card, 'div', 'account-bind-kv');
    lifecycleRow.setAttribute(ACCOUNT_BINDING_PRO_LIFECYCLE_ATTR, '');
    const lifecycleKey = append(doc, lifecycleRow, 'span', 'account-bind-k');
    lifecycleKey.textContent = 'Plan';
    const lifecycleValue = append(doc, lifecycleRow, 'span', 'account-bind-v');
    lifecycleValue.textContent = lifecycleLabel(state.proStatus.entitlement);

    const items = append(doc, card, 'div', 'account-bind-pro-items');
    renderProItem(items, 'ddns', state.proStatus.items.ddns, state.proStatus.ddns_hostname);
    renderProItem(items, 'acme', state.proStatus.items.acme);

    // DDNS on/off + cert renew live on Server ▸ Hostnames (fork 1); Account
    // reflects status only. The CTA links out to the dashboard for billing —
    // "Subscribe" when not yet on Pro, "Manage billing" when active.
    const entitled = state.proStatus.entitlement === 'entitled';
    const cta = append(
      doc,
      card,
      'a',
      'account-bind-dashboard-link rx-btn rx-btn-secondary',
    );
    cta.setAttribute('href', dashboardUrl);
    cta.setAttribute('target', '_blank');
    cta.setAttribute('rel', 'noopener noreferrer');
    cta.setAttribute(ACCOUNT_BINDING_PRO_SUBSCRIBE_ATTR, '');
    cta.textContent = entitled ? 'Manage billing in dashboard' : 'Subscribe in dashboard';
  };

  function render(): void {
    if (disposed) return;
    root.setAttribute(ACCOUNT_BINDING_PANEL_STATE_ATTR, state.phase === 'loading' ? 'loading' : viewState());
    clearChildren(root);
    if (state.phase === 'loading') {
      const loading = append(doc, root, 'div', 'account-bind-loading');
      loading.setAttribute(ACCOUNT_BINDING_LOADING_ATTR, '');
      loading.textContent = 'Loading account status...';
      return;
    }
    renderConnectionCard(root);
    renderFreeAccountCard(root);
    renderProCard(root);
  }

  const refresh = async (
    fromRetry = false,
    ownFocus = false,
  ): Promise<void> => {
    if (fromRetry && (disposed || isBusy())) return;
    const generation = ++loadGeneration;
    state = {
      ...state,
      phase: fromRetry
        ? 'ready'
        : state.bindingStatus === null && state.proStatus === null
          ? 'loading'
          : 'ready',
      action: fromRetry ? 'refreshing' : state.action,
      errors: {
        ...state.errors,
        bindingStatus: null,
        proStatus: null,
        session: null,
      },
    };
    render();
    if (fromRetry && ownFocus) focusControl(ACCOUNT_BINDING_RETRY_ATTR);

    // Both server reads first — they are local pair-rpcs and always safe.
    const [binding, pro] = await Promise.allSettled([
      opts.runBindingStatus(),
      opts.runProStatus(),
    ]);
    if (disposed || generation !== loadGeneration) return;
    const nextBindingStatus =
      binding.status === 'fulfilled' ? binding.value : state.bindingStatus;

    // …then the recued.com session, ONLY when this server is bound to an
    // account. An unbound server has no account to ask about, so a background
    // probe would be a cloud call the owner never asked for; `connectFlow`
    // reads the session explicitly when they press Connect. A skipped read
    // keeps the last known session (an unbind does not sign the browser out).
    let session: AccountBindingAuthSession | null = state.session;
    let sessionError: string | null = null;
    if (opts.runReadSession !== undefined && nextBindingStatus?.status === 'bound') {
      try {
        session = await opts.runReadSession();
      } catch (err) {
        sessionError = readErrorMessage(err, 'recued.com');
      }
      if (disposed || generation !== loadGeneration) return;
    }

    const returnFromRetry = fromRetry
      && ownFocus
      && controlHasFocus(ACCOUNT_BINDING_RETRY_ATTR);
    state = {
      ...state,
      phase: 'ready',
      action: fromRetry ? 'idle' : state.action,
      bindingStatus: nextBindingStatus,
      proStatus: pro.status === 'fulfilled' ? pro.value : state.proStatus,
      session,
      errors: {
        ...state.errors,
        bindingStatus: binding.status === 'rejected'
          ? readErrorMessage(binding.reason, 'server')
          : null,
        proStatus: pro.status === 'rejected'
          ? readErrorMessage(pro.reason, 'server')
          : null,
        session: sessionError,
      },
    };
    render();
    if (returnFromRetry) {
      focusControl(hasReadError()
        ? ACCOUNT_BINDING_RETRY_ATTR
        : ACCOUNT_BINDING_CONNECT_ATTR);
    }
  };

  const refreshAndTrack = (): Promise<void> => {
    pendingLoad = refresh();
    return pendingLoad;
  };

  const retryAndTrack = (ownFocus = false): Promise<void> => {
    if (disposed || isBusy()) return pendingLoad;
    pendingLoad = refresh(true, ownFocus);
    return pendingLoad;
  };

  const connectFlow = async (
    confirm_rebind: boolean,
    ownFocus = false,
  ): Promise<void> => {
    if (disposed || isBusy() || mutationInFlight) return;
    const actionAttr = confirm_rebind
      ? ACCOUNT_BINDING_CONFIRM_REBIND_ATTR
      : ACCOUNT_BINDING_CONNECT_ATTR;
    mutationInFlight = true;
    try {
      setState({
        action: confirm_rebind ? 'confirming' : 'connecting',
        errors: { ...state.errors, action: null },
        actionMessage: null,
      });
      if (ownFocus) focusControl(actionAttr);
      // The one place an UNBOUND server may reach the auth Worker: the owner
      // pressed Connect, so the cloud call is the action they asked for. It
      // costs no extra request — `mintBindingToken` fetches the same session
      // itself when it holds no CSRF token — and reading it here lets the card
      // name who is signed in even when the bind that follows doesn't land.
      if (opts.runReadSession !== undefined) {
        try {
          const session = await opts.runReadSession();
          if (disposed) return;
          const preserveActionFocus = ownFocus && controlHasFocus(actionAttr);
          setState({ session });
          if (preserveActionFocus) focusControl(actionAttr);
        } catch {
          // The mint below fails the same way and owns the error copy.
        }
      }
      const token = await opts.mintBindingToken();
      const result = await opts.runBind({
        binding_token: token.binding_token,
        ...(confirm_rebind ? { confirm_rebind: true } : {}),
      });
      if (result.outcome === 'conflict') {
        const returnToConflict = ownFocus && controlHasFocus(actionAttr);
        setState({
          action: 'idle',
          conflict: result,
          actionMessage: 'Confirm before this server is rebound.',
        });
        if (returnToConflict) {
          focusControl(confirm_rebind
            ? ACCOUNT_BINDING_CONFIRM_REBIND_ATTR
            : ACCOUNT_BINDING_CANCEL_REBIND_ATTR);
        }
        return;
      }
      const returnToConnect = ownFocus && controlHasFocus(actionAttr);
      setState({
        action: 'idle',
        conflict: null,
        actionMessage:
          result.outcome === 'rebound'
            ? 'Server rebound to this recued.com account.'
            : 'Server bound to this recued.com account.',
      });
      const refreshPromise = refreshAndTrack();
      if (returnToConnect) focusControl(ACCOUNT_BINDING_CONNECT_ATTR);
      await refreshPromise;
      if (returnToConnect && focusIsUnowned()) {
        focusControl(ACCOUNT_BINDING_CONNECT_ATTR);
      }
    } catch (err) {
      const returnToAction = ownFocus && controlHasFocus(actionAttr);
      setActionError(errMessage(err));
      if (returnToAction) focusControl(actionAttr);
    } finally {
      mutationInFlight = false;
    }
  };

  const cancelRebind = (ownFocus = false): void => {
    if (disposed || isBusy()) return;
    const returnToConnect = ownFocus
      && controlHasFocus(ACCOUNT_BINDING_CANCEL_REBIND_ATTR);
    setState({
      conflict: null,
      actionMessage: 'Rebind cancelled.',
      errors: { ...state.errors, action: null },
    });
    if (returnToConnect) focusControl(ACCOUNT_BINDING_CONNECT_ATTR);
  };

  const openUnbindConfirmation = (ownFocus = false): void => {
    if (disposed || isBusy() || unbindConfirmationOpen) return;
    const moveToSafeAction = ownFocus
      && controlHasFocus(ACCOUNT_BINDING_UNBIND_ATTR);
    unbindConfirmationOpen = true;
    render();
    if (moveToSafeAction) focusControl(ACCOUNT_BINDING_CANCEL_UNBIND_ATTR);
  };

  const cancelUnbind = (ownFocus = false): void => {
    if (disposed || isBusy() || !unbindConfirmationOpen) return;
    const returnToUnbind = ownFocus
      && controlHasFocus(ACCOUNT_BINDING_CANCEL_UNBIND_ATTR);
    unbindConfirmationOpen = false;
    render();
    if (returnToUnbind) focusControl(ACCOUNT_BINDING_UNBIND_ATTR);
  };

  const unbindFlow = async (ownFocus = false): Promise<void> => {
    if (disposed || isBusy() || mutationInFlight) return;
    mutationInFlight = true;
    try {
      setState({
        action: 'unbinding',
        errors: { ...state.errors, action: null },
        actionMessage: null,
      });
      if (ownFocus) focusControl(ACCOUNT_BINDING_CONFIRM_UNBIND_ATTR);
      const result = await opts.runUnbind();
      const advanceToConnect = ownFocus
        && controlHasFocus(ACCOUNT_BINDING_CONFIRM_UNBIND_ATTR);
      unbindConfirmationOpen = false;
      setState({
        action: 'idle',
        conflict: null,
        actionMessage: result.outcome === 'not_bound'
          ? 'No binding was stored on this server.'
          : 'Server disconnected from recued.com.',
      });
      const refreshPromise = refreshAndTrack();
      if (advanceToConnect) focusControl(ACCOUNT_BINDING_CONNECT_ATTR);
      await refreshPromise;
      if (advanceToConnect && focusIsUnowned()) {
        focusControl(ACCOUNT_BINDING_CONNECT_ATTR);
      }
    } catch (err) {
      const returnToConfirm = ownFocus
        && controlHasFocus(ACCOUNT_BINDING_CONFIRM_UNBIND_ATTR);
      setActionError(errMessage(err));
      if (returnToConfirm) focusControl(ACCOUNT_BINDING_CONFIRM_UNBIND_ATTR);
    } finally {
      mutationInFlight = false;
    }
  };

  // Signs out of the recued.com browser session ONLY (Worker local scope). The
  // server↔account binding is untouched — this is not an unbind. After it
  // resolves, refresh() re-reads the session (now unauthenticated) so the
  // "Signed in as" line + Sign out button drop away.
  const signOutFlow = async (ownFocus = false): Promise<void> => {
    if (
      disposed
      || isBusy()
      || mutationInFlight
      || opts.runSignOut === undefined
    ) return;
    mutationInFlight = true;
    try {
      setState({
        action: 'signing-out',
        errors: { ...state.errors, action: null },
        actionMessage: null,
      });
      if (ownFocus) focusControl(ACCOUNT_BINDING_SIGNOUT_ATTR);
      await opts.runSignOut();
      const advanceToConnect = ownFocus
        && controlHasFocus(ACCOUNT_BINDING_SIGNOUT_ATTR);
      // Clear the session LOCALLY the instant sign-out succeeds — do not wait
      // for (or trust) the follow-up read. This drops the "Signed in as" line +
      // the Sign out button immediately (no enabled-button window for a
      // duplicate POST), and survives a failed re-read: refresh() preserves the
      // previous session on a rejected read, so a stale authenticated value
      // would otherwise re-appear after the cookie was already cleared.
      setState({
        action: 'idle',
        session: null,
        actionMessage:
          'Signed out of recued.com on this browser. Your server pairing is unchanged.',
      });
      const refreshPromise = refreshAndTrack();
      if (advanceToConnect) focusControl(ACCOUNT_BINDING_CONNECT_ATTR);
      await refreshPromise;
      if (advanceToConnect && focusIsUnowned()) {
        focusControl(ACCOUNT_BINDING_CONNECT_ATTR);
      }
    } catch (err) {
      const returnToSignOut = ownFocus
        && controlHasFocus(ACCOUNT_BINDING_SIGNOUT_ATTR);
      setActionError(errMessage(err));
      if (returnToSignOut) focusControl(ACCOUNT_BINDING_SIGNOUT_ATTR);
    } finally {
      mutationInFlight = false;
    }
  };

  render();
  pendingLoad = refresh();

  return {
    getState: () => cloneState(state),
    viewState,
    hasInFlightWork: () => !disposed && mutationInFlight,
    refresh: refreshAndTrack,
    whenLoaded: () => pendingLoad,
    connect: () => connectFlow(false),
    confirmRebind: () => connectFlow(true),
    cancelRebind: () => cancelRebind(false),
    unbind: unbindFlow,
    signOut: signOutFlow,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      root.remove();
    },
  };
};

export const ACCOUNT_BINDING_PANEL_STYLES = `
[${ACCOUNT_BINDING_PANEL_ATTR}] {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
[${ACCOUNT_BINDING_PANEL_ATTR}] .account-bind-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--surface);
}
[${ACCOUNT_BINDING_PANEL_ATTR}] .account-bind-card-head,
[${ACCOUNT_BINDING_PANEL_ATTR}] .account-bind-actions,
[${ACCOUNT_BINDING_PANEL_ATTR}] .account-bind-pro-item,
[${ACCOUNT_BINDING_PANEL_ATTR}] .account-bind-kv {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
[${ACCOUNT_BINDING_PANEL_ATTR}] h3,
[${ACCOUNT_BINDING_PANEL_ATTR}] h4 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}
[${ACCOUNT_BINDING_PANEL_ATTR}] .account-bind-chip {
  font-size: 11px;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 7px;
}
[${ACCOUNT_BINDING_PANEL_ATTR}] .account-bind-k {
  color: var(--muted);
  min-width: 112px;
}
[${ACCOUNT_BINDING_PANEL_ATTR}] .account-bind-v,
[${ACCOUNT_BINDING_PANEL_ATTR}] .account-bind-pro-state {
  font-weight: 600;
}
[${ACCOUNT_BINDING_PANEL_ATTR}] .account-bind-pro-value {
  font-weight: 600;
  word-break: break-all;
}
[${ACCOUNT_BINDING_PANEL_ATTR}] .account-bind-error {
  margin: 0;
  color: var(--danger);
  font-size: 12px;
}
[${ACCOUNT_BINDING_PANEL_ATTR}] .account-bind-message,
[${ACCOUNT_BINDING_PANEL_ATTR}] .account-bind-loading {
  margin: 0;
  color: var(--muted);
}
[${ACCOUNT_BINDING_PANEL_ATTR}] .account-bind-conflict {
  border: 1px solid var(--danger);
  border-radius: 8px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
[${ACCOUNT_BINDING_PANEL_ATTR}] .account-bind-pro-items {
  display: grid;
  gap: 6px;
}
[${ACCOUNT_BINDING_PANEL_ATTR}] .account-bind-pro-label {
  min-width: 64px;
}
[${ACCOUNT_BINDING_PANEL_ATTR}] .account-bind-pro-detail {
  color: var(--muted);
  font-size: 12px;
}
[${ACCOUNT_BINDING_PANEL_ATTR}] .account-bind-dashboard-link {
  color: var(--accent);
  text-decoration: none;
  font-size: 13px;
}
[${ACCOUNT_BINDING_PANEL_ATTR}] .account-bind-dashboard-link:hover {
  text-decoration: underline;
}
[${ACCOUNT_BINDING_PANEL_ATTR}] .account-bind-dashboard-link.rx-btn:hover {
  text-decoration: none;
}
[${ACCOUNT_BINDING_PANEL_ATTR}] .account-bind-dashboard-link.rx-btn {
  box-sizing: border-box;
}
[${ACCOUNT_BINDING_PANEL_ATTR}] .account-bind-dashboard-inline {
  box-sizing: border-box;
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  padding: 4px 2px;
  border-radius: 5px;
}
`;

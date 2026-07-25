/** D-174 — Settings -> Account recued.com binding touchpoint.
 *
 *  Reads secret-free binding status from the paired server, mints the
 *  Worker-issued binding token through the auth cookie session, relays
 *  only that token via `account.bind`, and renders Pro-convenience
 *  posture from `pro_convenience.status`.
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
export const ACCOUNT_BINDING_STATUS_CHIP_ATTR = 'data-recued-account-binding-status-chip';
export const ACCOUNT_BINDING_SUMMARY_ATTR = 'data-recued-account-binding-summary';
export const ACCOUNT_BINDING_CONNECT_ATTR = 'data-recued-account-binding-connect';
export const ACCOUNT_BINDING_CONFIRM_REBIND_ATTR = 'data-recued-account-binding-confirm-rebind';
export const ACCOUNT_BINDING_CANCEL_REBIND_ATTR = 'data-recued-account-binding-cancel-rebind';
export const ACCOUNT_BINDING_UNBIND_ATTR = 'data-recued-account-binding-unbind';
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
    ? new Date(value).toISOString()
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
    const connect = append(doc, actions, 'button', 'rx-btn rx-btn-primary');
    connect.setAttribute('type', 'button');
    connect.setAttribute(ACCOUNT_BINDING_CONNECT_ATTR, '');
    connect.textContent = state.bindingStatus?.status === 'bound'
      ? 'Refresh binding'
      : 'Connect your recued.com account';
    connect.disabled = isBusy();
    connect.addEventListener('click', () => {
      void connectFlow(false);
    });

    if (state.bindingStatus?.status === 'bound') {
      const unbind = append(doc, actions, 'button', 'rx-btn rx-btn-secondary');
      unbind.setAttribute('type', 'button');
      unbind.setAttribute(ACCOUNT_BINDING_UNBIND_ATTR, '');
      unbind.textContent = 'Disconnect';
      unbind.disabled = isBusy();
      unbind.addEventListener('click', () => {
        void unbindFlow();
      });
    }

    // Sign out of the recued.com browser session (Worker local-scope signout).
    // Independent of the server binding: it shows whenever a session is live,
    // leaves the pairing intact, and is deliberately NOT "Disconnect" (unbind).
    if (opts.runSignOut !== undefined && state.session?.authenticated === true) {
      const signOutBtn = append(doc, actions, 'button', 'rx-btn rx-btn-secondary');
      signOutBtn.setAttribute('type', 'button');
      signOutBtn.setAttribute(ACCOUNT_BINDING_SIGNOUT_ATTR, '');
      signOutBtn.textContent = 'Sign out';
      signOutBtn.disabled = isBusy();
      signOutBtn.addEventListener('click', () => {
        void signOutFlow();
      });
    }

    const dashboard = append(doc, actions, 'a', 'account-bind-dashboard-link');
    dashboard.setAttribute('href', dashboardUrl);
    dashboard.setAttribute('target', '_blank');
    dashboard.setAttribute('rel', 'noopener noreferrer');
    dashboard.setAttribute(ACCOUNT_BINDING_DASHBOARD_LINK_ATTR, '');
    dashboard.textContent = 'Open dashboard';
  };

  const renderConflict = (parent: HTMLElement): void => {
    if (state.conflict === null) return;
    const box = append(doc, parent, 'div', 'account-bind-conflict');
    const title = append(doc, box, 'h4');
    title.textContent = 'Binding conflict';
    renderLabelValue(doc, box, 'Current owner', accountLabel(state.conflict.current_owner));
    renderLabelValue(doc, box, 'Incoming account', accountLabel(state.conflict.incoming));
    const actions = append(doc, box, 'div', 'account-bind-actions');
    const confirm = append(doc, actions, 'button', 'rx-btn rx-btn-primary');
    confirm.setAttribute('type', 'button');
    confirm.setAttribute(ACCOUNT_BINDING_CONFIRM_REBIND_ATTR, '');
    confirm.textContent = 'Confirm rebind';
    confirm.disabled = isBusy();
    confirm.addEventListener('click', () => {
      void connectFlow(true);
    });
    const cancel = append(doc, actions, 'button', 'rx-btn rx-btn-secondary');
    cancel.setAttribute('type', 'button');
    cancel.setAttribute(ACCOUNT_BINDING_CANCEL_REBIND_ATTR, '');
    cancel.textContent = 'Cancel';
    cancel.disabled = isBusy();
    cancel.addEventListener('click', () => cancelRebind());
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

    if (state.session?.authenticated === true && state.session.user !== null) {
      const signedIn = append(doc, card, 'p', 'account-bind-message');
      signedIn.setAttribute(ACCOUNT_BINDING_SESSION_ATTR, '');
      signedIn.textContent = 'Signed in as ' + state.session.user.email;
    }

    const binding = state.bindingStatus?.binding ?? null;
    if (binding !== null) renderStatusSummary(card, binding);
    renderConflict(card);
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
      const manage = append(doc, pubRow, 'a', 'account-bind-dashboard-link');
      manage.setAttribute('href', dashboardUrl);
      manage.setAttribute('target', '_blank');
      manage.setAttribute('rel', 'noopener noreferrer');
      manage.setAttribute(ACCOUNT_BINDING_PUBLISHING_LINK_ATTR, '');
      manage.textContent = 'Manage in dashboard';
    } else {
      const claim = append(doc, card, 'p', 'account-bind-message');
      claim.setAttribute(ACCOUNT_BINDING_FREE_CLAIM_ATTR, '');
      claim.textContent = 'No marketplace handle reserved yet.';
      const link = append(doc, card, 'a', 'account-bind-dashboard-link');
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
    const cta = append(doc, card, 'a', 'account-bind-dashboard-link');
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

  const refresh = async (): Promise<void> => {
    const generation = ++loadGeneration;
    state = {
      ...state,
      phase: state.bindingStatus === null && state.proStatus === null ? 'loading' : 'ready',
      errors: {
        ...state.errors,
        bindingStatus: null,
        proStatus: null,
        session: null,
      },
    };
    render();

    const [binding, pro, session] = await Promise.allSettled([
      opts.runBindingStatus(),
      opts.runProStatus(),
      opts.runReadSession !== undefined ? opts.runReadSession() : Promise.resolve(null),
    ]);
    if (disposed || generation !== loadGeneration) return;

    state = {
      ...state,
      phase: 'ready',
      bindingStatus: binding.status === 'fulfilled' ? binding.value : state.bindingStatus,
      proStatus: pro.status === 'fulfilled' ? pro.value : state.proStatus,
      session: session.status === 'fulfilled' ? session.value : state.session,
      errors: {
        ...state.errors,
        bindingStatus: binding.status === 'rejected'
          ? readErrorMessage(binding.reason, 'server')
          : null,
        proStatus: pro.status === 'rejected'
          ? readErrorMessage(pro.reason, 'server')
          : null,
        session: session.status === 'rejected'
          ? readErrorMessage(session.reason, 'recued.com')
          : null,
      },
    };
    render();
  };

  const refreshAndTrack = (): Promise<void> => {
    pendingLoad = refresh();
    return pendingLoad;
  };

  const connectFlow = async (confirm_rebind: boolean): Promise<void> => {
    if (disposed || isBusy()) return;
    setState({
      action: confirm_rebind ? 'confirming' : 'connecting',
      errors: { ...state.errors, action: null },
      actionMessage: null,
    });
    try {
      const token = await opts.mintBindingToken();
      const result = await opts.runBind({
        binding_token: token.binding_token,
        ...(confirm_rebind ? { confirm_rebind: true } : {}),
      });
      if (result.outcome === 'conflict') {
        setState({
          action: 'idle',
          conflict: result,
          actionMessage: 'Confirm before this server is rebound.',
        });
        return;
      }
      setState({
        action: 'idle',
        conflict: null,
        actionMessage:
          result.outcome === 'rebound'
            ? 'Server rebound to this recued.com account.'
            : 'Server bound to this recued.com account.',
      });
      await refreshAndTrack();
    } catch (err) {
      setActionError(errMessage(err));
    }
  };

  const cancelRebind = (): void => {
    if (disposed || isBusy()) return;
    setState({
      conflict: null,
      actionMessage: 'Rebind cancelled.',
      errors: { ...state.errors, action: null },
    });
  };

  const unbindFlow = async (): Promise<void> => {
    if (disposed || isBusy()) return;
    setState({
      action: 'unbinding',
      errors: { ...state.errors, action: null },
      actionMessage: null,
    });
    try {
      const result = await opts.runUnbind();
      setState({
        action: 'idle',
        conflict: null,
        actionMessage: result.outcome === 'not_bound'
          ? 'No binding was stored on this server.'
          : 'Server disconnected from recued.com.',
      });
      await refreshAndTrack();
    } catch (err) {
      setActionError(errMessage(err));
    }
  };

  // Signs out of the recued.com browser session ONLY (Worker local scope). The
  // server↔account binding is untouched — this is not an unbind. After it
  // resolves, refresh() re-reads the session (now unauthenticated) so the
  // "Signed in as" line + Sign out button drop away.
  const signOutFlow = async (): Promise<void> => {
    if (disposed || isBusy() || opts.runSignOut === undefined) return;
    setState({
      action: 'signing-out',
      errors: { ...state.errors, action: null },
      actionMessage: null,
    });
    try {
      await opts.runSignOut();
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
      await refreshAndTrack();
    } catch (err) {
      setActionError(errMessage(err));
    }
  };

  render();
  pendingLoad = refresh();

  return {
    getState: () => cloneState(state),
    viewState,
    refresh: refreshAndTrack,
    whenLoaded: () => pendingLoad,
    connect: () => connectFlow(false),
    confirmRebind: () => connectFlow(true),
    cancelRebind,
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
`;

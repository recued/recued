import { createCollectionAuthenticationPanel } from './collection-authentication-panel.js';
import { createCollectionOAuthAppSwitchPanel } from './collection-oauth-app-switch-panel.js';
import { createAccountPasswordPanel, type AccountPasswordRepair } from './account-password-panel.js';
import type { AccountSetupContinuity } from './account-setup-continuity.js';
import { createBulkCollectionOAuthAppSwitchPanel, type BulkOAuthAppAccount } from './bulk-collection-oauth-app-switch-panel.js';
import { createOAuthTroubleshooting, oauthHelpPopupObservation, oauthHelpPlan } from './oauth-troubleshooting.js';
/** Connections ▸ foundational account lanes — webclient mount.
 *
 *  The state machine + rpc caller seams + dispatchers behind the pure
 *  `renderAccountsPanel` renderer (`@recued/ui-shared`). This is the
 *  FOUNDATIONAL half of the restructured Connections surface (treemap
 *  §6, R13–R16): Mail / Calendar / Files bound through the coded
 *  `collection.{mail,calendar,file}.*` adapters — distinct from the
 *  generic `connection.*` REACH lane (`connections-enroll-panel.ts`).
 *
 *  Render model mirrors the enroll panel: `host.innerHTML = render(...)`,
 *  a `createActionDispatcher` for `data-action` clicks, and a sibling
 *  delegated `input` / `change` listener for `data-acct-field` controls.
 *  Ordinary field edits preserve focus and update only Submit's readiness.
 *  Switching direct/managed OAuth replaces the credential fields and clears
 *  secrets and method-specific write switches; the common send choice is kept. Submission revalidates the selection.
 *
 *  Mail supports IMAP and direct/managed Google or Microsoft OAuth.
 *  Calendar supports CalDAV and direct/managed OAuth. Files enroll local fs
 *  here and list cloud sources with links to the existing API setup. Each lane reports missing server
 *  capabilities when its caller seam is absent. */

import {
  buildMailAuthorizeUrl,
  buildCalendarAuthorizeUrl,
  buildOpenerRelayRedirectUri,
  oauthAppIssuerForProvider,
  savedOAuthAppsForIssuer,
  oauthAppStatusForSelection,
  type CollectionInstanceRow,
  type MailOAuthProvider,
  type CalendarOAuthAdapter,
  type OAuthAppConfigSnapshot,
  type OAuthAppIssuer,
  type SetOAuthAppConfigArgs,
  type ConnectionView,
  type MailSyncStatus,
  type CloudFileSource,
} from '@recued/contracts';
import {
  canSubmitAccountForm,
  managedConnectionsForAccount,
  renderAccountsPanel,
  findAccountLane,
  findAccountProvider,
  initialAccountsPanelState,
  isOAuthAccountTransport,
  seedAccountFormValues,
  validateAccountForm,
  wireFocusTrap,
  type AccountFormValues,
  type AccountLaneId,
  type AccountProvider,
  type AccountRow,
  type AccountsPanelState,
  type FocusTrapHandle,
} from '@recued/ui-shared';
import {
  createActionDispatcher,
  type ActionHandlers,
} from '@recued/ui-shared/action-dispatcher';
import {
  openOAuthPopup,
  defaultFoundationalOAuthEnv,
  type FoundationalOAuthEnv,
  type FoundationalOAuthPopupHandle,
} from './foundational-oauth-popup.js';
import {
  createFoundationalOAuthContinuity,
  type FoundationalOAuthContinuity,
  type FoundationalOAuthContinuityState,
  type FoundationalOAuthTerminalState,
} from './foundational-oauth-continuity.js';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';

// ════════════════════════════════════════════════════════════════
// Caller seams (per lane)
// ════════════════════════════════════════════════════════════════

/** `collection.mail.list` row — wider than `CollectionInstanceRow`
 *  (adds `send_capable` + `account_email`). Only the fields the panel
 *  reads are typed; structurally wider returns are accepted. */
export interface MailAccountListRow {
  slug: string;
  adapter_type: string;
  auth_state: CollectionInstanceRow['auth_state'];
  last_synced_at: number | null;
  sync_status?: MailSyncStatus;
  send_capable: boolean;
  account_email: string;
  managed_connection_name?: string;
  source_authentication?: 'direct_oauth' | 'broker';
}

export interface MailLaneCallers {
  updateCredentials?: AccountPasswordRepair;
  list: () => Promise<{ instances: ReadonlyArray<MailAccountListRow> }>;
  enrollImap: (args: Record<string, unknown>) => Promise<{ slug: string; send_capable: boolean }>;
  enrollSmtp?: (args: Record<string, unknown>) => Promise<{ slug: string; send_capable: boolean }>;
  /** OAuth enrollment — the popup-captured code + the byte-matched
   *  redirect_uri. Optional so older mounts without it still type. */
  enrollOAuth?: (args: {
    provider: MailOAuthProvider;
    backfill_days?: number;
    account_slug: string;
    code: string;
    redirect_uri: string;
    oauth_app_id?: string;
    oauth_client_id?: string;
  }) => Promise<{ ok: true; account_key_prefix: string }>;
  enrollManagedOAuth?: (args: {
    provider: MailOAuthProvider;
    backfill_days?: number;
    account_slug: string;
    connection_name: string;
    send_enabled: boolean;
    mutation_enabled: boolean;
  }) => Promise<{ slug: string }>;
  delete: (args: { slug: string }) => Promise<{ ok: true }>;
  /** `collection.mail.resync` — rebuild the mailbox's connection and sync it
   *  again, as after a restart. Optional so older mounts still type. */
  resync?: (args: { slug: string }) => Promise<unknown>;
}

/** `server.getOAuthClientConfig` result — per-provider client id, `null`
 *  when the matching `RECUED_*_CLIENT_ID` env var is unset. */
export interface OAuthClientConfigResult {
  gmail: { client_id: string } | null;
  gcal: { client_id: string } | null;
  graph: { client_id: string } | null;
}

/** Injectable popup/env seam for the OAuth flow — tests pass a fake;
 *  production defaults to the real browser env (`defaultAccountsOAuthEnv`). */
export interface AccountsOAuthEnv {
  /** Open the blank popup SYNCHRONOUSLY (the caller is in the click
   *  gesture). `null` = the browser blocked it. */
  openPopup: () => FoundationalOAuthPopupHandle | null;
  /** Driver env: origin (postMessage check + redirect_uri), state mint,
   *  message + timer seams. */
  env: FoundationalOAuthEnv;
}

const defaultAccountsOAuthEnv = (): AccountsOAuthEnv => ({
  openPopup: () => openOAuthPopup(),
  env: defaultFoundationalOAuthEnv(),
});

export interface CalendarLaneCallers {
  updateCredentials?: AccountPasswordRepair;
  list: () => Promise<{ instances: ReadonlyArray<CollectionInstanceRow> }>;
  delete: (args: { slug: string }) => Promise<{ ok: true }>;
  resync?: (args: { slug: string }) => Promise<unknown>;
  reauth?: (args: { slug: string }) => Promise<unknown>;
  /** OAuth enrollment — popup-captured code + byte-matched redirect_uri. The
   *  calendar wire fields differ from mail (`adapter` / `oauth_code` /
   *  `oauth_redirect_uri`). Optional so older mounts still type. */
  enrollOAuth?: (args: {
    slug: string;
    adapter: CalendarOAuthAdapter;
    oauth_code: string;
    oauth_redirect_uri: string;
    oauth_app_id?: string;
    oauth_client_id?: string;
  }) => Promise<{ slug: string }>;
  enrollManagedOAuth?: (args: {
    adapter: CalendarOAuthAdapter;
    slug: string;
    connection_name: string;
    write_enabled: boolean;
  }) => Promise<{ slug: string }>;
  /** Microsoft-only — adopt the calendar lane onto the `graph` grant the mail
   *  enroll just persisted, with no second consent. Optional so older mounts
   *  still type; absent, the "Also connect Calendar" box degrades to
   *  mail-only + a warning rather than silently pretending it worked. */
  attachGraphGrant?: (args: { slug: string }) => Promise<{ slug: string }>;
  /** CalDAV basic-auth enrollment (field form, Slice 2a backend). */
  enrollBasic?: (args: Record<string, unknown>) => Promise<{ slug: string }>;
}

export interface FileLaneCallers {
  /** `collection.listInstances` filtered to `{ type: 'file' }`. */
  list: () => Promise<{ instances: ReadonlyArray<CollectionInstanceRow> }>;
  enroll: (args: Record<string, unknown>) => Promise<{
    instance: CollectionInstanceRow;
    probe_result: unknown;
  }>;
  delete: (args: { slug: string }) => Promise<{ ok: true }>;
  resync?: (args: { slug: string }) => Promise<unknown>;
}

/** One-shot scheduler used while a newly connected account is waiting for its
 *  first successful sync. Returning a cancel function keeps route teardown and
 *  explicit refreshes leak-free. */
export interface AccountsFirstSyncPollScheduler {
  schedule(handler: () => void, delayMs: number): () => void;
}

export interface AccountsChatHandoff {
  readonly lane: AccountLaneId;
  readonly providerId: string;
  readonly slug: string;
}

export interface MountAccountsLanePanelOptions {
  host: HTMLElement;
  document?: Document;
  /** Deep-link entry — the lane (and optional detail account) to open. */
  initialLane?: AccountLaneId;
  initialDetailSlug?: string;
  /** Opens the existing authentication editor once, after the saved account list is loaded. */
  initialManageAuthentication?: string;
  /** Fired on lane / detail navigation so the route can sync the hash
   *  (`#connections/<lane>[/<slug>]`). Optional — navigation works
   *  internally without it. */
  onNavigate?: (lane: AccountLaneId, detailSlug: string | null) => void;
  /** Post-connect next actions. The route supplies hash-aware callbacks so
   *  these also work with injected/manual hash sources. */
  onGoToChat?: (source: AccountsChatHandoff) => void;
  onOpenLane?: (lane: AccountLaneId) => void;
  onFirstMailboxConnected?: () => void;
  mail?: MailLaneCallers;
  calendar?: CalendarLaneCallers;
  file?: FileLaneCallers;
  listManagedConnections?: () => Promise<{ connections: readonly ConnectionView[] }>;
  onOpenManagedConnections?: (name?: string) => void;
  onManageSavedApps?: () => void;
  setupContinuity?: AccountSetupContinuity;
  onSetupHandoff?: (destination: 'apps' | 'connection') => void;
  listCloudFiles?: () => Promise<{ sources: CloudFileSource[] }>;
  onAuthenticationChanged?: () => void;
  runCollectionAuthentication?: import('../settings/managed-oauth-panel.js').ManagedOAuthCaller;
  /** `server.getOAuthClientConfig` caller — required for the OAuth lanes
   *  (Mail/Calendar sign-in). Absent → the Connect button errors. */
  getOAuthClientConfig?: () => Promise<OAuthClientConfigResult>;
  /** BYO OAuth-app config callers. Both optional — absent → the OAuth form
   *  keeps the legacy optional-settings path. `getOAuthAppConfig` is fetched
   *  on the Mail / Calendar lanes to pre-fill the client_id and choose between
   *  the compact ready state and the one-time setup checklist;
   *  `setOAuthAppConfig` persists entered credentials as part of Connect. */
  getOAuthAppConfig?: () => Promise<OAuthAppConfigSnapshot>;
  setOAuthAppConfig?: (args: SetOAuthAppConfigArgs) => Promise<{ ok: true }>;
  /** Test seam for the OAuth popup; production uses the real browser env. */
  oauthEnv?: AccountsOAuthEnv;
  /** Boot-owned OAuth transaction. When omitted, a mount owns a private
   * controller and disposal retains the legacy cancel-on-unmount behavior. */
  oauthContinuity?: FoundationalOAuthContinuity;
  /** Exact lane route exposed through route-independent Account chrome. */
  oauthReturnHref?: string;
  /** Test seam for the callback-URI Copy action. Production uses the active
   *  document's Clipboard API; absence degrades to manual selection. */
  copyText?: (value: string) => Promise<void>;
  /** First-sync status polling seam. Production uses the mounted document's
   *  window timer; non-browser mounts do not poll unless this is injected. */
  firstSyncPoll?: AccountsFirstSyncPollScheduler;
  /** Defaults to 2500ms. */
  firstSyncPollIntervalMs?: number;
  /** Optional polling cap. By default checks continue while mounted, slowing
   * after the first minute so a long import does not lose its completion. */
  firstSyncPollMaxAttempts?: number;
  /** Clock + short grace used by reload recovery before a second clean miss
   * may unlock fresh consent. Production waits five seconds from dispatch. */
  now?: () => number;
  oauthReloadRetryGraceMs?: number;
  /** Lane settings shown under the account list (the route's "Personal or
   *  work" card). Asked for after every render, which detaches it; null
   *  leaves the list without one. List stage only. */
  listFooter?: () => HTMLElement | null;
}

export interface AccountsLanePanelMount {
  getState(): AccountsPanelState;
  /** Re-list the current lane. */
  refresh(): Promise<void>;
  /** Initial / most-recent load promise. */
  whenLoaded(): Promise<void>;
  /** Enrollment, OAuth, resync, reauth, or removal is awaiting authority. */
  hasInFlightWork(): boolean;
  hasUnsavedChanges(): boolean;
  dispose(): void;
}

// ════════════════════════════════════════════════════════════════
// Action union + helpers
// ════════════════════════════════════════════════════════════════

type AccountsAction =
  | 'accounts-open-add'
  | 'accounts-pick-provider'
  | 'accounts-back-to-list'
  | 'accounts-submit-form'
  | 'accounts-oauth-connect'
  | 'accounts-open-managed-connection'
  | 'accounts-manage-saved-apps'
  | 'accounts-update-credentials'
  | 'accounts-clear-filters'
  | 'accounts-manage-authentication'
  | 'accounts-authentication-choice'
  | 'accounts-switch-authentication'
  | 'accounts-switch-oauth-app'
  | 'accounts-bulk-switch-oauth-app'
  | 'accounts-copy-oauth-redirect'
  | 'accounts-oauth-dismiss'
  | 'accounts-oauth-cancel'
  | 'accounts-oauth-recovery-check'
  | 'accounts-oauth-recovery-restart'
  | 'accounts-success-go-chat'
  | 'accounts-success-open-lane'
  | 'accounts-success-refresh'
  | 'accounts-dismiss-success'
  | 'accounts-open-detail'
  | 'accounts-delete'
  | 'accounts-delete-cancel'
  | 'accounts-delete-confirm'
  | 'accounts-resync'
  | 'accounts-reauth';

// Matches whichever primary button the form rendered (field-submit OR the
// OAuth connect button) — a form has exactly one.
const SUBMIT_SELECTOR =
  '[data-action="accounts-submit-form"],[data-action="accounts-oauth-connect"]';

const errMessage = (err: unknown): string =>
  humanizeRpcError(err);

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

export const mountAccountsLanePanel = (
  opts: MountAccountsLanePanelOptions,
): AccountsLanePanelMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountAccountsLanePanel: no document available — pass `opts.document` for non-browser environments',
    );
  }

  const { host } = opts;
  const state: AccountsPanelState = initialAccountsPanelState(
    opts.initialLane ?? 'mail',
  );
  const draftValues = new Map<string, string>();
  let handingOffSetup = false;
  const changedSetup = () => state.stage === 'form' && [...draftValues].some(([key, value]) =>
    (key.startsWith('credential.') ? state.oauthCredValues[key.slice(11) as keyof typeof state.oauthCredValues] : state.values[key]) !== value);
  const rememberEdit = (key: string, value: string) => { if (!draftValues.has(key)) draftValues.set(key, value); };
  const confirmDiscardSetup = () => !changedSetup() || (doc.defaultView?.confirm?.('Discard this account setup? Credentials entered here cannot be restored.') ?? true);
  // Seed the app origin so the OAuth forms can surface the exact redirect URI
  // to register — the SAME origin the flow uses for the redirect_uri (the
  // injected env in tests, the browser's location in production). A direct
  // guarded read (vs forcing `resolveOAuthEnv()`) keeps mount from touching
  // `window` on non-OAuth lanes / non-browser hosts; absent → hint omitted.
  const seededOrigin =
    opts.oauthEnv?.env.origin
    ?? (typeof window !== 'undefined' ? window.location.origin : undefined);
  // Truthy guard, not just non-undefined: an empty origin would render a
  // bare relative `/oauth-callback?...` as the URI to register (useless).
  if (seededOrigin) state.appOrigin = seededOrigin;
  if (opts.initialDetailSlug !== undefined) {
    state.stage = 'detail';
    state.detailSlug = opts.initialDetailSlug;
  }
  let disposed = false;
  const passwordPanel = createAccountPasswordPanel({ host, changed: async () => { await doRefresh(false, true); opts.onAuthenticationChanged?.(); },
    closed: slug => {
      for (const control of host.querySelectorAll?.<HTMLElement>('[data-action="accounts-update-credentials"]') ?? []) {
        if (control.dataset.slug === slug) control.focus();
      }
    } });
  const oauthHelp = createOAuthTroubleshooting({ ...(opts.copyText ? { copy: opts.copyText } : {}) });
  // Bumped before every list await; a post-await write only lands when its
  // captured generation is still current (a lane switch / refresh overtaking
  // a slow in-flight list must not clobber the newer view).
  const managementUpdated = (): void => {
    const busy = authenticationPanel?.busy() === true || oauthAppSwitchPanel?.busy() === true;
    state.authenticationManagementBusy = busy;
    for (const control of host.querySelectorAll?.<HTMLButtonElement>('[data-action="accounts-authentication-choice"]') ?? []) control.disabled = busy;
  };
  const openSavedApps = (): void => {
    if (opts.onManageSavedApps) opts.onManageSavedApps();
    else opts.onOpenManagedConnections?.();
  };
  const authenticationPanel = opts.runCollectionAuthentication ? createCollectionAuthenticationPanel({
    host, call: opts.runCollectionAuthentication, changed: () => { void doRefresh(false, true); opts.onAuthenticationChanged?.(); },
    openConnections: name => opts.onOpenManagedConnections?.(name), updated: managementUpdated,
  }) : undefined;
  const oauthAppSwitchPanel = opts.runCollectionAuthentication ? createCollectionOAuthAppSwitchPanel({
    host, call: opts.runCollectionAuthentication, changed: () => { void doRefresh(false, true); opts.onAuthenticationChanged?.(); },
    openApps: openSavedApps, oauth: () => resolveOAuthEnv(), updated: managementUpdated,
  }) : undefined;
  const bulkAppSwitchPanel = opts.runCollectionAuthentication && opts.getOAuthAppConfig ? createBulkCollectionOAuthAppSwitchPanel({
    host, call: opts.runCollectionAuthentication, apps: opts.getOAuthAppConfig,
    accounts: async () => {
      const [mail, calendar] = await Promise.all([opts.mail?.list(), opts.calendar?.list()]);
      const found: BulkOAuthAppAccount[] = [];
      for (const [platform, rows] of [['mail', mail?.instances ?? []], ['calendar', calendar?.instances ?? []]] as const) {
        for (const row of rows) {
          if (row.managed_connection_name || row.source_authentication === 'broker' || !['gmail', 'gcal', 'graph'].includes(row.adapter_type)) continue;
          found.push({ platform, slug: row.slug, issuer: row.adapter_type === 'graph' ? 'microsoft' : 'google',
            ...('account_email' in row && typeof row.account_email === 'string' && row.account_email ? { email: row.account_email } : {}) });
        }
      }
      return found;
    }, changed: () => { void doRefresh(false, true); opts.onAuthenticationChanged?.(); }, openApps: openSavedApps, oauth: () => resolveOAuthEnv(),
  }) : undefined;
  state.bulkOAuthAppSwitchAvailable = bulkAppSwitchPanel !== undefined;
  let loadGeneration = 0;
  let pendingLoad: Promise<void> = Promise.resolve();
  // Survives stage navigation — blocks a second enroll write while one is
  // still settling (server CAS is the real cross-client guard; this fences
  // one mounted panel).
  let submitInFlight = false;
  const ownsOAuthContinuity = opts.oauthContinuity === undefined;
  const oauthContinuity = opts.oauthContinuity
    ?? createFoundationalOAuthContinuity();
  let detachOAuthContinuity = (): void => undefined;
  // OAuth "Keep working" escape: true once the owner dismisses the transaction
  // presentation. The boot-scoped flow keeps running and routes its eventual
  // result to the list instead of pulling the owner back into the form.
  let oauthDismissed = false;
  let oauthReloadVerificationInFlight = false;
  let oauthReloadVerificationMisses = 0;
  let deleteFocusTrap: FocusTrapHandle | null = null;
  const now = opts.now ?? Date.now;
  const oauthReloadRetryGraceMs = opts.oauthReloadRetryGraceMs ?? 5_000;
  const timerWindow = doc.defaultView;
  const firstSyncPoll = opts.firstSyncPoll
    ?? (timerWindow === undefined || timerWindow === null
      ? null
      : {
          schedule: (handler: () => void, delayMs: number): (() => void) => {
            const handle = timerWindow.setTimeout(handler, delayMs);
            return () => timerWindow.clearTimeout(handle);
          },
        });
  const firstSyncPollIntervalMs = opts.firstSyncPollIntervalMs ?? 2_500;
  const firstSyncPollMaxAttempts = opts.firstSyncPollMaxAttempts ?? Infinity;
  let firstSyncPollAttempts = 0;
  let mailboxHandedOff = false;
  const openFirstMailboxProposals = (slug: string) => {
    if (disposed || mailboxHandedOff || state.lane !== 'mail' || !opts.onFirstMailboxConnected
      || state.rows.some(row => row.slug === slug && row.adapterType === 'smtp')
      || state.rows.some(row => row.slug !== slug && row.adapterType !== 'smtp')) return;
    mailboxHandedOff = true; opts.onFirstMailboxConnected();
  };
  let firstSyncPollCancel: (() => void) | null = null;
  let firstSyncBackgroundLoadGeneration: number | null = null;

  const cancelFirstSyncPoll = (): void => {
    firstSyncPollCancel?.();
    firstSyncPollCancel = null;
  };

  const clearConnectionSuccess = (): void => {
    cancelFirstSyncPoll();
    // A scheduled timer is cancellable; an rpc it already started is not.
    // Retire only that quiet read's generation so it cannot re-render a form
    // the user opened while the status request was in flight. Foreground
    // refreshes remain live and can still settle the ordinary account list.
    if (
      firstSyncBackgroundLoadGeneration !== null
      && firstSyncBackgroundLoadGeneration === loadGeneration
    ) {
      loadGeneration += 1;
      firstSyncBackgroundLoadGeneration = null;
    }
    state.connectionSuccess = null;
  };

  interface PanelFocusSnapshot {
    /** Full data-* identity of the active delegated action. */
    actionDataset: Readonly<Record<string, string>> | null;
    /** Full data-* identity + caret state of the active form control. */
    field: {
      dataset: Readonly<Record<string, string>>;
      selection: {
        start: number;
        end: number;
        direction: 'forward' | 'backward' | 'none';
      } | null;
    } | null;
    /** The active element lived inside the post-connect card. */
    inConnectionSuccess: boolean;
  }

  const copyDataset = (
    element: HTMLElement,
  ): Readonly<Record<string, string>> =>
    Object.fromEntries(
      Object.entries(element.dataset).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );

  const capturePanelFocus = (): PanelFocusSnapshot | null => {
    const active = doc.activeElement as HTMLElement | null | undefined;
    if (
      active === undefined
      || active === null
      || typeof active.closest !== 'function'
      || !host.contains(active)
    ) return null;
    const action = active.closest('[data-action]') as HTMLElement | null;
    const field = (
      active.closest('[data-acct-field]')
      ?? active.closest('[data-oauth-cred-field]')
      ?? active.closest('[data-acct-filter]')
    ) as (HTMLElement & {
      selectionStart?: number | null;
      selectionEnd?: number | null;
      selectionDirection?: 'forward' | 'backward' | 'none' | null;
    }) | null;
    const selection = field !== null
      && typeof field.selectionStart === 'number'
      && typeof field.selectionEnd === 'number'
      ? {
          start: field.selectionStart,
          end: field.selectionEnd,
          direction: field.selectionDirection ?? 'none' as const,
        }
      : null;
    return {
      actionDataset: action === null ? null : copyDataset(action),
      field: field === null
        ? null
        : { dataset: copyDataset(field), selection },
      inConnectionSuccess:
        active.closest('[data-accounts-connection-success]') !== null,
    };
  };

  const focusConnectionSuccess = (preventScroll = false): void => {
    const card = host.querySelector(
      '[data-accounts-connection-success]',
    ) as HTMLElement | null;
    card?.focus?.({ preventScroll });
  };

  const focusPanelElement = (selector: string): void => {
    const element = host.querySelector(selector) as HTMLElement | null;
    element?.focus?.({ preventScroll: true });
    element?.scrollIntoView?.({ block: 'nearest' });
  };

  const focusProviderChoice = (providerId: string): void => {
    // Provider ids come from the static lane catalog (not user input).
    focusPanelElement(
      `[data-action="accounts-pick-provider"][data-provider="${providerId}"]`,
    );
  };

  const focusAccountRow = (slug: string): boolean => {
    // Slugs are server-owned identities, so match datasets instead of
    // interpolating one into a CSS selector.
    if (typeof host.querySelectorAll !== 'function') return false;
    const rows = host.querySelectorAll('[data-action="accounts-open-detail"]');
    for (const candidate of Array.from(rows)) {
      const element = candidate as HTMLElement;
      if (element.dataset.slug !== slug) continue;
      element.focus?.({ preventScroll: true });
      return true;
    }
    return false;
  };

  const focusSlugAction = (action: 'accounts-delete', slug: string): void => {
    if (typeof host.querySelectorAll !== 'function') return;
    const actions = host.querySelectorAll(`[data-action="${action}"]`);
    for (const candidate of Array.from(actions)) {
      const element = candidate as HTMLElement;
      if (element.dataset.slug !== slug) continue;
      element.focus?.({ preventScroll: true });
      return;
    }
  };

  const deleteDialog = (): HTMLElement | null =>
    host.querySelector('[data-accounts-delete-dialog]') as HTMLElement | null;

  const armDeleteFocusTrap = (): void => {
    deleteFocusTrap?.release();
    deleteFocusTrap = wireFocusTrap({
      document: doc,
      getContainer: deleteDialog,
      restoreFocus: false,
    });
  };

  const releaseDeleteFocusTrap = (): void => {
    deleteFocusTrap?.release();
    deleteFocusTrap = null;
  };

  const restorePanelFocus = (snapshot: PanelFocusSnapshot | null): void => {
    if (snapshot === null) return;
    if (snapshot.actionDataset !== null) {
      const actions = host.querySelectorAll('[data-action]');
      for (const candidate of Array.from(actions)) {
        const element = candidate as HTMLElement;
        const matches = Object.entries(snapshot.actionDataset).every(
          ([key, value]) => element.dataset[key] === value,
        );
        if (matches) {
          element.focus?.({ preventScroll: true });
          return;
        }
      }
    }
    if (snapshot.field !== null) {
      const fields = host.querySelectorAll(
        '[data-acct-field],[data-oauth-cred-field],[data-acct-filter]',
      );
      for (const candidate of Array.from(fields)) {
        const element = candidate as HTMLElement & {
          setSelectionRange?: (
            start: number,
            end: number,
            direction?: 'forward' | 'backward' | 'none',
          ) => void;
        };
        const matches = Object.entries(snapshot.field.dataset).every(
          ([key, value]) => element.dataset[key] === value,
        );
        if (!matches) continue;
        element.focus?.({ preventScroll: true });
        if (
          snapshot.field.selection !== null
          && typeof element.setSelectionRange === 'function'
        ) {
          const { start, end, direction } = snapshot.field.selection;
          element.setSelectionRange(start, end, direction);
        }
        return;
      }
    }
    // A status transition can legitimately remove an action (for example the
    // unknown-state Retry button). Keep focus at the card, not on <body>.
    if (snapshot.inConnectionSuccess) focusConnectionSuccess(true);
  };

  const render = (preserveFocus = false): void => {
    if (disposed) return;
    const focus = preserveFocus ? capturePanelFocus() : null;
    const active = doc.activeElement as HTMLElement | null | undefined;
    const keepDeleteDialogFocus = deleteFocusTrap !== null
      && state.deleteConfirm !== null
      && active !== undefined
      && active !== null
      && typeof active.closest === 'function'
      && active.closest('[data-accounts-delete-dialog]') !== null;
    if (state.stage !== 'detail' || state.authenticationManagement?.slug !== state.detailSlug) delete state.authenticationManagement;
    state.authenticationManagementBusy = authenticationPanel?.busy() === true || oauthAppSwitchPanel?.busy() === true;
    // Re-rendering detaches the footer, which drops its focus; put it back.
    const footer = opts.listFooter?.() ?? null;
    const footerFocus = footer !== null && active && footer.contains(active) ? active : null;
    host.innerHTML = renderAccountsPanel({ state });
    const footerHost = footer !== null
      ? host.querySelector?.<HTMLElement>('[data-accounts-list-footer-host]') ?? null
      : null;
    if (footerHost !== null && footer !== null) {
      footerHost.appendChild(footer);
      if (footerFocus !== null && doc.activeElement !== footerFocus) footerFocus.focus?.({ preventScroll: true });
    }
    // Explicit tab stops keep Safari inside this modal even when the system
    // keyboard preference skips ordinary buttons in the native Tab order.
    if (state.deleteConfirm !== null) {
      for (const control of host.querySelectorAll?.<HTMLButtonElement>('[data-accounts-delete-dialog] button') ?? []) control.tabIndex = 0;
    }
    const oauthRow = state.stage === 'detail' ? state.rows.find(row => row.slug === state.detailSlug) : undefined;
    const oauthProvider = state.stage === 'form' ? state.providerId : oauthRow?.adapterType;
    const oauthIssuer = oauthProvider && ['gmail', 'gcal', 'graph'].includes(oauthProvider) ? oauthAppIssuerForProvider(oauthProvider as 'gmail' | 'gcal' | 'graph') : undefined;
    const broker = state.stage === 'form' ? state.values.auth_method === 'managed_oauth' : oauthRow?.sourceAuthentication === 'broker';
    oauthHelp.mount(host.querySelector<HTMLElement>('[data-account-oauth-help-host]'), oauthIssuer ? {
      key: JSON.stringify([state.lane, state.stage, oauthProvider, state.values.oauth_app_id, state.values.connection_name, oauthRow?.slug, oauthRow?.managedConnectionName]),
      route: broker ? 'broker' : 'direct', issuer: oauthIssuer,
      ...(state.stage === 'form' && !broker && state.appOrigin ? { callbackUrl: buildOpenerRelayRedirectUri(state.appOrigin, oauthIssuer === 'microsoft') } : {}),
      savedApp: !oauthRow?.managedConnectionName, pending: state.saving || state.oauthFinishing || state.oauthReloadRecovery !== null,
    } : null);
    authenticationPanel?.context(state.lane, state.stage === 'detail' ? state.detailSlug : null);
    authenticationPanel?.render();
    oauthAppSwitchPanel?.context(state.lane, state.stage === 'detail' ? state.detailSlug : null);
    oauthAppSwitchPanel?.render();
    passwordPanel.context(state.lane, state.stage === 'detail' ? state.detailSlug : null);
    passwordPanel.render();
    bulkAppSwitchPanel?.context(state.lane, state.stage);
    bulkAppSwitchPanel?.render();
    if (preserveFocus) restorePanelFocus(focus);
    if (keepDeleteDialogFocus) {
      const currentDialog = deleteDialog();
      const currentActive = doc.activeElement as Node | null | undefined;
      if (
        currentActive === undefined
        || currentActive === null
        || currentDialog?.contains(currentActive) !== true
      ) {
        deleteFocusTrap?.focusInitial();
      }
    }
  };

  const laneCallers = (
    lane: AccountLaneId,
  ): MailLaneCallers | CalendarLaneCallers | FileLaneCallers | undefined =>
    lane === 'mail' ? opts.mail : lane === 'calendar' ? opts.calendar : opts.file;

  const normalizeRows = (
    lane: AccountLaneId,
    raw: ReadonlyArray<MailAccountListRow | CollectionInstanceRow>,
  ): AccountRow[] =>
    raw.map((r): AccountRow => {
      if (lane === 'mail') {
        const m = r as MailAccountListRow;
        return {
          slug: m.slug,
          adapterType: m.adapter_type,
          authState: m.auth_state,
          ...(m.account_email ? { sublabel: m.account_email } : {}),
          sendCapable: m.send_capable,
          ...(m.managed_connection_name ? { managedConnectionName: m.managed_connection_name } : {}),
          ...(m.source_authentication ? { sourceAuthentication: m.source_authentication } : {}),
          authenticationSwitchAvailable: authenticationPanel !== undefined,
          oauthAppSwitchAvailable: oauthAppSwitchPanel !== undefined,
          passwordRepairAvailable: ['imap', 'smtp'].includes(m.adapter_type) && opts.mail?.updateCredentials !== undefined,
          lastSyncedAt: m.last_synced_at,
          ...(m.adapter_type !== 'smtp' && m.sync_status !== undefined ? { mailSync: m.sync_status } : {}),
        };
      }
      const c = r as CollectionInstanceRow;
      return {
        slug: c.slug,
        adapterType: c.adapter_type,
        authState: c.auth_state,
        reauthAvailable:
          lane === 'calendar' && !c.managed_connection_name && (c.caps as { auth?: unknown }).auth === 'oauth',
        ...(c.managed_connection_name ? { managedConnectionName: c.managed_connection_name } : {}),
        ...(c.source_authentication ? { sourceAuthentication: c.source_authentication } : {}),
        authenticationSwitchAvailable: authenticationPanel !== undefined,
        oauthAppSwitchAvailable: oauthAppSwitchPanel !== undefined,
        passwordRepairAvailable: c.adapter_type === 'caldav' && opts.calendar?.updateCredentials !== undefined,
        lastSyncedAt: c.last_synced_at,
      };
    });

  /** Ignore unrelated completed rows while tracking an import, including after
   * a return to Connections when its one-time success receipt is gone. */
  const firstSyncViewKey = (): string => {
    const success = state.connectionSuccess;
    return JSON.stringify({
      error: state.error,
      rows: state.rows.filter((row) => row.slug === success?.slug
        || (row.mailSync !== undefined && !row.mailSync.initial_sync_complete)),
    });
  };

  // ── BYO OAuth-app config (snapshot fetch + load) ──────────────
  // Tolerant: absent caller OR a rejected fetch both resolve to null (leave
  // the snapshot untouched → the OAuth form degrades to the legacy Connect
  // button + operator env-var error). A real fetch always returns a full
  // per-issuer snapshot, so null is unambiguous.
  const fetchOAuthAppConfigSnapshot =
    async (): Promise<OAuthAppConfigSnapshot | null> => {
      if (opts.getOAuthAppConfig === undefined) return null;
      try {
        return await opts.getOAuthAppConfig();
      } catch {
        return null;
      }
    };

  // Load-path fetch — only the OAuth lanes carry app config; generation-guarded
  // like the list load so a lane switch overtaking it can't clobber the view.
  const loadOAuthAppConfig = async (
    gen: number,
    preserveFocus = false,
  ): Promise<void> => {
    if (state.lane !== 'mail' && state.lane !== 'calendar') return;
    const snapshot = await fetchOAuthAppConfigSnapshot();
    if (snapshot === null) return;
    if (disposed || gen !== loadGeneration) return;
    state.oauthAppConfig = snapshot;
    if (state.stage === 'form' && !state.saving && state.values.oauth_app_id === undefined
      && !state.oauthCredValues.client_id && !state.oauthCredValues.client_secret) {
      const provider = activeProvider();
      if (provider && isOAuthAccountTransport(provider.transport)) {
        const issuer = oauthAppIssuerForProvider(provider.id as 'gmail' | 'gcal' | 'graph');
        const first = snapshot[issuer].apps?.find(app => app.has_secret);
        if (first) { state.values.oauth_app_id = first.id; state.oauthCredValues.client_id = first.client_id; }
      }
    }
    render(preserveFocus);
  };

  const loadManagedConnections = async (gen: number): Promise<void> => {
    if (!opts.listManagedConnections || (state.lane !== 'mail' && state.lane !== 'calendar')) return;
    try {
      const { connections } = await opts.listManagedConnections();
      if (disposed || gen !== loadGeneration) return;
      state.managedConnections = connections.flatMap(connection => {
        if (connection.kind !== 'api' || connection.auth_type !== 'managed_oauth' || !connection.managed_oauth) return [];
        try {
          const base = new URL(typeof connection.base_url === 'string' ? connection.base_url : '');
          if (base.origin !== connection.managed_oauth.target_origin) return [];
          return [{ name: connection.name, label: connection.display_name || connection.name,
            origin: base.origin, basePath: base.pathname }];
        } catch { return []; }
      });
      state.managedConnectionsError = null;
      if (state.stage === 'form' && state.values.auth_method === 'managed_oauth' && !state.values.connection_name) {
        const compatible = managedConnectionsForAccount(state.providerId ?? '', state.managedConnections);
        if (compatible.length === 1) state.values.connection_name = compatible[0]!.name;
      }
    } catch (error) {
      if (disposed || gen !== loadGeneration) return;
      state.managedConnections = [];
      state.managedConnectionsError = errMessage(error);
    }
  };

  // ── List load (generation-guarded) ────────────────────────────
  const shouldPollFirstSync = (): boolean => {
    const success = state.connectionSuccess;
    if (
      state.stage !== 'list'
      || state.loading
      || firstSyncPoll === null
      || firstSyncPollAttempts >= firstSyncPollMaxAttempts
    ) return false;
    if (state.lane === 'mail' && state.rows.some((row) => row.mailSync !== undefined
      && !row.mailSync.initial_sync_complete && row.authState !== 'expired' && row.authState !== 'unauthorized')) return true;
    if (success === null) return false;
    // A foreground post-connect refresh may have left a stale pre-enroll row.
    // Keep checking until one authoritative list read succeeds; the renderer
    // likewise refuses to call that stale timestamp "ready" while error is set.
    if (state.error !== null) return true;
    const row = state.rows.find((candidate) => candidate.slug === success.slug);
    if (row?.adapterType === 'smtp') return false;
    if (row?.mailSync !== undefined) {
      return row.authState !== 'expired' && row.authState !== 'unauthorized'
        && !row.mailSync.initial_sync_complete;
    }
    return row === undefined
      || (row.authState === 'healthy'
        && (row.lastSyncedAt === undefined || row.lastSyncedAt === null));
  };

  const scheduleFirstSyncPoll = (): void => {
    cancelFirstSyncPoll();
    if (!shouldPollFirstSync()) return;
    firstSyncPollCancel = firstSyncPoll!.schedule(() => {
      firstSyncPollCancel = null;
      if (disposed || !shouldPollFirstSync()) return;
      firstSyncPollAttempts += 1;
      void doRefresh(true);
    }, firstSyncPollAttempts < 24 ? firstSyncPollIntervalMs : Math.max(firstSyncPollIntervalMs, 15_000));
  };

  /** Refresh the active lane. First-sync polls are background reads: a brief
   *  transport miss keeps the last truthful row/card instead of replacing it
   *  with a flashing lane error. User-initiated refreshes retain the ordinary
   *  loading + error treatment. */
  const doRefresh = (
    background = false,
    preserveFocus = false,
  ): Promise<void> => {
    cancelFirstSyncPoll();
    const previousFirstSyncView = background ? firstSyncViewKey() : null;
    const gen = ++loadGeneration;
    if (background) firstSyncBackgroundLoadGeneration = gen;
    const lane = state.lane;
    const callers = laneCallers(lane);
    if (!background) {
      state.loading = true;
      state.error = null;
      render(preserveFocus);
    }
    pendingLoad = (async () => {
      // Fetch OAuth-app status alongside the list. The lane stays in its
      // loading state until both settle so a fast list response cannot expose
      // Connect, then replace the active form (and its focus) when the slower
      // status response chooses ready vs one-time setup.
      const configLoad = background
        ? Promise.resolve()
        : Promise.all([loadOAuthAppConfig(gen, preserveFocus), loadManagedConnections(gen)]);
      try {
        if (callers === undefined) {
          await configLoad;
          if (disposed || gen !== loadGeneration) return;
          if (background) return;
          state.loading = false;
          state.rows = [];
          state.error = 'This server cannot do this yet.';
          render(preserveFocus);
          return;
        }
        const [local, cloud] = await Promise.allSettled([callers.list(), lane === 'file' && opts.listCloudFiles ? opts.listCloudFiles() : Promise.resolve(undefined)]);
        if (local.status === 'rejected' && !(lane === 'file' && cloud.status === 'fulfilled' && cloud.value !== undefined)) throw local.reason;
        const instances = local.status === 'fulfilled' ? local.value.instances : [];
        await configLoad;
        if (disposed || gen !== loadGeneration) return;
        state.rows = normalizeRows(lane, instances);
        if (lane === 'file') {
          state.localFilesError = local.status === 'rejected' ? 'Local folders could not be loaded. Refresh the file sources to try again.' : undefined;
          state.cloudFilesError = cloud.status === 'rejected' ? 'Cloud file sources could not be loaded. Refresh the file sources to try again.' : undefined;
          if (cloud.status === 'fulfilled' && cloud.value) state.rows = [...state.rows, ...cloud.value.sources.map(source => ({
            slug: 'remote:' + source.source_id, adapterType: source.provider, authState: 'healthy' as const,
            cloudSource: source, lastSyncedAt: source.last_synced_at,
          }))];
        }
        state.loading = false;
        state.error = null;
        if (!background || previousFirstSyncView !== firstSyncViewKey()) {
          render(background || preserveFocus);
        }
      } catch (err) {
        await configLoad;
        if (disposed || gen !== loadGeneration) return;
        if (background) return;
        state.loading = false;
        state.error = errMessage(err);
        render(preserveFocus);
      } finally {
        if (firstSyncBackgroundLoadGeneration === gen) {
          firstSyncBackgroundLoadGeneration = null;
        }
        if (!disposed && gen === loadGeneration) scheduleFirstSyncPoll();
      }
    })();
    return pendingLoad;
  };

  // ── Imperative Submit-disabled sync (focus-preserving) ─────────
  const activeProvider = (): AccountProvider | undefined => {
    if (state.providerId === null) return undefined;
    const lane = findAccountLane(state.lane);
    return lane !== undefined
      ? findAccountProvider(lane, state.providerId)
      : undefined;
  };

  const syncSubmitDisabled = (): void => {
    if (typeof host.querySelector !== 'function') return;
    const provider = activeProvider();
    if (provider === undefined) return;
    const btn = host.querySelector(SUBMIT_SELECTOR);
    if (btn === null) return;
    const ready = canSubmitAccountForm(provider, state);
    if (ready && !state.saving) btn.removeAttribute('disabled');
    else btn.setAttribute('disabled', '');
  };

  // ── Add flow ──────────────────────────────────────────────────
  const openProvider = (provider: AccountProvider): void => {
    draftValues.clear(); handingOffSetup = false;
    clearConnectionSuccess();
    state.stage = 'form';
    state.providerId = provider.id;
    state.values = seedAccountFormValues(provider);
    state.formError = null;
    // Seed the inline OAuth-app credential fields: pre-fill client_id from the
    // effective (stored/env) id so a configured app shows it; the secret is
    // write-only so it always starts blank.
    if (isOAuthAccountTransport(provider.transport)) {
      const issuer = oauthAppIssuerForProvider(provider.id as 'gmail' | 'gcal' | 'graph');
      const profiles = savedOAuthAppsForIssuer(state.oauthAppConfig, issuer).filter(app => app.has_secret);
      if (state.oauthAppConfig?.[issuer].apps !== undefined && profiles.length) state.values.oauth_app_id = profiles[0]!.id;
      const status = oauthAppStatusForSelection(state.oauthAppConfig, issuer, state.values.oauth_app_id);
      state.oauthCredValues = { client_id: status?.client_id ?? '', client_secret: '' };
    } else {
      state.oauthCredValues = { client_id: '', client_secret: '' };
    }
    render();
    focusPanelElement('[data-accounts-form-heading]');
  };

  const openAdd = (): void => {
    const lane = findAccountLane(state.lane);
    if (lane === undefined || lane.providers.length === 0) return;
    const returnProviderId = state.stage === 'form' ? state.providerId : null;
    clearConnectionSuccess();
    if (lane.providers.length === 1) {
      openProvider(lane.providers[0]!);
      return;
    }
    state.stage = 'provider-picker';
    state.providerId = null;
    state.values = {};
    // Drop any typed OAuth secret when leaving a form for the picker.
    state.oauthCredValues = { client_id: '', client_secret: '' };
    state.formError = null;
    render();
    if (returnProviderId !== null) focusProviderChoice(returnProviderId);
    else focusPanelElement('[data-accounts-picker-heading]');
  };

  const backToList = (): void => {
    const returnToAddTrigger = state.stage === 'provider-picker' || state.stage === 'form';
    const returnDetailSlug = state.stage === 'detail' ? state.detailSlug : null;
    state.stage = 'list';
    state.providerId = null;
    state.values = {};
    // Don't let a typed OAuth client secret linger in mount state after the
    // user leaves the form without connecting.
    state.oauthCredValues = { client_id: '', client_secret: '' };
    state.formError = null;
    state.detailSlug = null;
    render();
    if (returnToAddTrigger) {
      focusPanelElement('[data-action="accounts-open-add"]');
    } else if (returnDetailSlug !== null) {
      focusAccountRow(returnDetailSlug);
    }
    opts.onNavigate?.(state.lane, null);
  };

  // ── Submit (enroll) ───────────────────────────────────────────
  const submitForm = async (): Promise<void> => {
    if (submitInFlight || state.saving) return;
    const provider = activeProvider();
    if (provider === undefined) {
      state.formError = 'Pick a provider to continue.';
      render();
      return;
    }
    const invalid = validateAccountForm(provider, state.values);
    if (invalid !== null) {
      state.formError = invalid;
      render();
      return;
    }
    const payload = provider.project(state.values);
    submitInFlight = true;
    state.saving = true;
    state.formError = null;
    // The busy primary is aria-disabled (the guard above owns re-entrancy), so
    // it can remain the keyboard anchor across this full-form replacement.
    render(true);
    try {
      let enrolledSlug: string;
      if (isOAuthAccountTransport(provider.transport) && state.values.auth_method === 'managed_oauth') {
        if (!canSubmitAccountForm(provider, state)) throw new Error('Select a compatible managed API connection.');
        const name = state.values.name!.trim();
        if (state.rows.some(row => row.slug === name)) throw new Error('An account with this name already exists.');
        if (provider.transport === 'mail-oauth') {
          if (!opts.mail?.enrollManagedOAuth) throw new Error('Managed OAuth is not available for Mail on this server.');
          enrolledSlug = (await opts.mail.enrollManagedOAuth({ provider: provider.id as MailOAuthProvider,
            account_slug: name, connection_name: state.values.connection_name!, backfill_days: Number(state.values.backfill_days || '400'),
            send_enabled: state.values.send_enabled === 'true', mutation_enabled: state.values.mutation_enabled === 'true' })).slug;
        } else {
          if (!opts.calendar?.enrollManagedOAuth) throw new Error('Managed OAuth is not available for Calendar on this server.');
          enrolledSlug = (await opts.calendar.enrollManagedOAuth({ adapter: provider.id as CalendarOAuthAdapter,
            slug: name, connection_name: state.values.connection_name!, write_enabled: state.values.write_enabled === 'true' })).slug;
        }
      } else if (provider.transport === 'mail-imap') {
        if (opts.mail === undefined) throw new Error('You cannot set up Mail here.');
        const enrolled = await opts.mail.enrollImap(payload);
        enrolledSlug = enrolled.slug;
      } else if (provider.transport === 'mail-smtp') {
        if (!opts.mail?.enrollSmtp) throw new Error('SMTP-only accounts are unavailable on this server.');
        enrolledSlug = (await opts.mail.enrollSmtp(payload)).slug;
      } else if (provider.transport === 'calendar-caldav') {
        if (opts.calendar?.enrollBasic === undefined) {
          throw new Error('You cannot set up CalDAV here.');
        }
        const enrolled = await opts.calendar.enrollBasic(payload);
        enrolledSlug = enrolled.slug;
      } else {
        if (opts.file === undefined) throw new Error('You cannot set up Files here.');
        const enrolled = await opts.file.enroll(payload);
        enrolledSlug = enrolled.instance.slug;
      }
      if (disposed) return;
      state.connectionSuccess = {
        slug: enrolledSlug,
        providerId: provider.id,
      };
      state.stage = 'list';
      state.providerId = null;
      state.values = {};
      state.saving = false;
      state.detailSlug = null;
      firstSyncPollAttempts = 0;
      const refresh = doRefresh(false, true);
      focusConnectionSuccess();
      await refresh;
      if (provider.transport !== 'mail-smtp') openFirstMailboxProposals(enrolledSlug);
    } catch (err) {
      if (disposed) return;
      state.saving = false;
      if (state.values.auth_method === 'managed_oauth' && err !== null && typeof err === 'object'
        && 'code' in err && err.code === 'adapter_start_failed') {
        const message = errMessage(err);
        state.stage = 'list'; state.providerId = null; state.values = {}; state.formError = null;
        await doRefresh(false, true);
        if (disposed) return;
        state.error = message;
        render(true);
        return;
      }
      state.formError = errMessage(err);
      // The retry action has the same semantic identity as the busy action.
      render(true);
    } finally {
      submitInFlight = false;
    }
  };

  // ── OAuth connect (mail / calendar) ───────────────────────────
  let oauthEnvCache: AccountsOAuthEnv | null = null;
  const resolveOAuthEnv = (): AccountsOAuthEnv => {
    if (opts.oauthEnv) return opts.oauthEnv;
    oauthEnvCache ??= defaultAccountsOAuthEnv();
    return oauthEnvCache;
  };

  const emptyOAuthAppConfig = (): OAuthAppConfigSnapshot => ({
    google: { client_id: null, has_secret: false, source: null },
    microsoft: { client_id: null, has_secret: false, source: null },
  });

  const oauthFailureMessage = (
    reason: 'popup_blocked' | 'denied' | 'timeout' | 'closed' | 'error',
    detail?: string,
    issuer: OAuthAppIssuer | null = null,
  ): string => {
    oauthHelp.observePopup(reason, detail);
    const observed = oauthHelpPopupObservation(reason, detail);
    const plan = oauthHelpPlan({ key: '', route: 'direct', ...(issuer ? { issuer } : {}) }, observed.issue);
    switch (reason) {
      case 'popup_blocked':
        return 'Popup blocked — allow popups for this site and try again.';
      case 'denied':
        return observed.label + ' ' + (observed.issue === 'credentials' ? plan.steps[0] : plan.explanation);
      case 'timeout':
        return 'Sign-in timed out. Please try again.';
      case 'closed':
        return 'Sign-in window closed before finishing.';
      default:
        return observed.label + ' Open Troubleshoot OAuth for the next checks.';
    }
  };

  // Per-lane wiring of the otherwise-identical popup→code→enroll flow. The
  // mail/calendar arg shapes, builders, and config keys differ; boot-scoped
  // continuity owns everything after the synchronous popup open.
  interface OAuthLaneSpec {
    providerId: string;
    providerLabel: string;
    slug: string;
    /** OAuth-app issuer (`google` covers gmail + gcal; `microsoft` covers
     *  graph mail + calendar) — the key for the inline BYO credentials. */
    issuer: OAuthAppIssuer;
    clientId: (cfg: OAuthClientConfigResult) => string | null;
    authorizeUrl: (args: { client_id: string; redirect_uri: string; state: string }) => string;
    enroll: (args: {
      code: string;
      redirect_uri: string;
    }) => Promise<{ note?: string } | void>;
  }

  const mailOAuthSpec = (provider: AccountProvider): OAuthLaneSpec | null => {
    if (opts.mail?.enrollOAuth === undefined) return null;
    const p = provider.id as MailOAuthProvider;
    const appId = state.values.oauth_app_id;
    const appClientId = state.oauthCredValues.client_id.trim() || oauthAppStatusForSelection(state.oauthAppConfig, oauthAppIssuerForProvider(p), appId)?.client_id || '';
    const slug = (state.values['name'] ?? '').trim();
    const sendEnabled = state.values['send_enabled'] === 'true';
    const backfillDays = Number(state.values.backfill_days || '400');
    // Microsoft ONLY — `graph` mail and calendar share one grant + one token
    // prefix, so one consent can serve both. The field is absent from the Gmail
    // form and the authorize builder ignores it there regardless.
    const calendarToo = p === 'graph' && state.values['calendar_enabled'] === 'true';
    return {
      providerId: provider.id,
      providerLabel: provider.label,
      slug,
      issuer: oauthAppIssuerForProvider(p),
      clientId: (cfg) => (p === 'gmail' ? cfg.gmail : cfg.graph)?.client_id ?? null,
      authorizeUrl: (a) =>
        buildMailAuthorizeUrl(p, {
          ...a,
          send_enabled: sendEnabled,
          calendar_enabled: calendarToo,
        }),
      enroll: async (a) => {
        await opts.mail!.enrollOAuth!({
          provider: p,
          account_slug: slug,
          backfill_days: backfillDays,
          code: a.code,
          redirect_uri: a.redirect_uri,
          ...(appId ? { oauth_app_id: appId, oauth_client_id: appClientId } : {}),
        });
        if (!calendarToo) return;
        // The code is spent, so the calendar lane ADOPTS the stored grant
        // instead of exchanging again. Deliberately non-fatal: the mailbox the
        // owner asked for is already connected and working, so a calendar
        // failure must not roll it back or read as "nothing happened". They can
        // add the calendar from its own lane, reusing this same grant.
        const attach = opts.calendar?.attachGraphGrant;
        if (attach === undefined) {
          return {
            note: 'Mail connected. Calendar could not be added on this client.',
          };
        }
        try {
          await attach({ slug });
        } catch (err) {
          return {
            note:
              `Mail connected. Calendar was not added: ${errMessage(err)}. `
              + 'You can add it from the Calendar lane — this sign-in already covers it.',
          };
        }
      },
    };
  };

  const calendarOAuthSpec = (provider: AccountProvider): OAuthLaneSpec | null => {
    if (opts.calendar?.enrollOAuth === undefined) return null;
    const adapter = provider.id as CalendarOAuthAdapter;
    const appId = state.values.oauth_app_id;
    const appClientId = state.oauthCredValues.client_id.trim() || oauthAppStatusForSelection(state.oauthAppConfig, oauthAppIssuerForProvider(adapter), appId)?.client_id || '';
    const slug = (state.values['name'] ?? '').trim();
    return {
      providerId: provider.id,
      providerLabel: provider.label,
      slug,
      issuer: oauthAppIssuerForProvider(adapter),
      clientId: (cfg) => (adapter === 'gcal' ? cfg.gcal : cfg.graph)?.client_id ?? null,
      authorizeUrl: (a) => buildCalendarAuthorizeUrl(adapter, a),
      enroll: async (a) => {
        await opts.calendar!.enrollOAuth!({
          slug,
          adapter,
          oauth_code: a.code,
          oauth_redirect_uri: a.redirect_uri,
          ...(appId ? { oauth_app_id: appId, oauth_client_id: appClientId } : {}),
        });
      },
    };
  };

  const applySavedOAuthAppConfig = (
    flow: Exclude<FoundationalOAuthContinuityState, { status: 'idle' }>,
  ): void => {
    const saved = flow.savedAppConfig;
    if (saved === undefined) return;
    state.oauthAppConfig = {
      ...(state.oauthAppConfig ?? emptyOAuthAppConfig()),
      [saved.issuer]: {
        ...state.oauthAppConfig?.[saved.issuer],
        client_id: saved.clientId,
        has_secret: true,
        source: 'stored' as const,
      },
    };
  };

  const safeOAuthClientId = (
    flow: Exclude<FoundationalOAuthContinuityState, { status: 'idle' }>,
  ): string => flow.savedAppConfig?.clientId
    || flow.clientId
    || state.oauthAppConfig?.[flow.issuer].client_id
    || '';

  const applyPendingOAuth = (
    flow: Extract<FoundationalOAuthContinuityState, { status: 'pending' }>,
  ): void => {
    if (flow.lane !== state.lane) return;
    applySavedOAuthAppConfig(flow);
    submitInFlight = true;
    state.stage = 'form';
    state.providerId = flow.providerId;
    state.values = { ...flow.accountValues };
    // The write-only secret is never restored into a remount. If saving it
    // failed, the correction loop asks for it again instead of retaining it in
    // route-independent state.
    state.oauthCredValues = {
      client_id: safeOAuthClientId(flow),
      client_secret: '',
    };
    state.saving = true;
    state.oauthFinishing = true;
    state.oauthProgressStage = flow.stage;
    state.oauthReloadRecovery = null;
    state.formError = null;
    render(true);
  };

  const restoreInterruptedOAuthForm = (
    terminal: Extract<FoundationalOAuthTerminalState, { status: 'failed' }>,
    message: string,
  ): void => {
    applySavedOAuthAppConfig(terminal);
    submitInFlight = false;
    state.saving = false;
    state.oauthFinishing = false;
    state.oauthProgressStage = null;
    state.oauthReloadRecovery = null;
    state.connectionSuccess = null;
    state.stage = 'form';
    state.providerId = terminal.providerId;
    state.values = { ...terminal.accountValues };
    state.oauthCredValues = {
      client_id: safeOAuthClientId(terminal),
      client_secret: '',
    };
    state.error = null;
    state.formError = message;
    render();
  };

  /** A reload after code delivery has an ambiguous server outcome. Query the
   * lane directly before consuming the recovery result. One miss can race a
   * still-settling request; repeated clean reads plus a short dispatch grace
   * unlock fresh consent. */
  const verifyInterruptedOAuth = async (
    flow: Extract<FoundationalOAuthTerminalState, { status: 'failed' }>,
  ): Promise<void> => {
    if (oauthReloadVerificationInFlight || flow.lane !== state.lane) return;
    const current = oauthContinuity.snapshot();
    if (current.status !== 'failed' || current.id !== flow.id) return;
    const callers = laneCallers(flow.lane);
    oauthReloadVerificationInFlight = true;
    const gen = ++loadGeneration;
    state.stage = 'list';
    state.providerId = null;
    state.values = {};
    state.oauthCredValues = { client_id: '', client_secret: '' };
    state.saving = false;
    state.oauthFinishing = false;
    state.oauthProgressStage = null;
    state.connectionSuccess = null;
    state.loading = true;
    state.error = null;
    state.oauthReloadRecovery = {
      providerLabel: flow.providerLabel,
      slug: flow.slug,
      status: 'checking',
    };
    render(true);

    try {
      if (callers === undefined) {
        throw new Error('This account lane is not available on this server yet.');
      }
      // App-config hydration is useful if recovery returns to the form, but it
      // is not authority for whether enrollment committed. Do not let a slow
      // optional config read hold the verify-before-retry decision hostage.
      void loadOAuthAppConfig(gen, true);
      const { instances } = await callers.list();
      if (disposed || gen !== loadGeneration) return;
      const snapshot = oauthContinuity.snapshot();
      if (snapshot.status !== 'failed' || snapshot.id !== flow.id) return;
      state.rows = normalizeRows(flow.lane, instances);
      state.loading = false;
      state.error = null;
      const sameSlug = state.rows.find((row) => row.slug === flow.slug);
      if (sameSlug !== undefined && sameSlug.adapterType === flow.providerId) {
        const alsoRequestedCalendar = flow.lane === 'mail'
          && flow.providerId === 'graph'
          && flow.accountValues['calendar_enabled'] === 'true';
        const terminal = oauthContinuity.takeTerminal(flow.id);
        if (terminal === null) return;
        applySavedOAuthAppConfig(terminal);
        state.oauthReloadRecovery = null;
        state.connectionSuccess = {
          slug: terminal.slug,
          providerId: terminal.providerId,
          ...(alsoRequestedCalendar
            ? {
                note: opts.calendar === undefined
                  ? 'Mail connected. This client could not verify the requested calendar; check the Calendar lane. You do not need to repeat mail sign-in.'
                  : 'Mail connected. Checking the requested calendar; you do not need to repeat mail sign-in.',
              }
            : {}),
        };
        firstSyncPollAttempts = 0;
        render(true);
        focusConnectionSuccess();
        scheduleFirstSyncPoll();
        // Mail is already authoritative and useful, so an optional secondary
        // calendar read cannot hold its recovery receipt open. Refine the note
        // in the background when that lane is available.
        if (alsoRequestedCalendar && opts.calendar !== undefined) {
          void (async () => {
            let note: string | undefined;
            try {
              const calendar = await opts.calendar!.list();
              const calendarFound = calendar.instances.some(
                (row) => row.slug === flow.slug && row.adapter_type === 'graph',
              );
              if (!calendarFound) {
                note = 'Mail connected. The requested calendar is not visible yet; check the Calendar lane. You do not need to repeat mail sign-in.';
              }
            } catch {
              note = 'Mail connected. Recued could not verify the requested calendar; check the Calendar lane. You do not need to repeat mail sign-in.';
            }
            if (
              disposed
              || state.connectionSuccess?.slug !== terminal.slug
              || state.connectionSuccess.providerId !== terminal.providerId
            ) return;
            state.connectionSuccess = {
              slug: terminal.slug,
              providerId: terminal.providerId,
              ...(note !== undefined ? { note } : {}),
            };
            render(true);
            openFirstMailboxProposals(terminal.slug);
          })();
        } else openFirstMailboxProposals(terminal.slug);
        return;
      }
      if (sameSlug !== undefined) {
        const terminal = oauthContinuity.takeTerminal(flow.id);
        if (terminal === null || terminal.status !== 'failed') return;
        restoreInterruptedOAuthForm(
          terminal,
          `An account named ${flow.slug} already exists with another provider. Go back to open it, or choose another name before restarting sign-in.`,
        );
        return;
      }

      oauthReloadVerificationMisses += 1;
      const retryGraceRemainingMs = flow.reloadInterruption === undefined
        ? oauthReloadRetryGraceMs
        : Math.max(
            0,
            flow.reloadInterruption.phaseStartedAt
              + oauthReloadRetryGraceMs
              - now(),
          );
      const pastRetryGrace = retryGraceRemainingMs === 0;
      state.oauthReloadRecovery = {
        providerLabel: flow.providerLabel,
        slug: flow.slug,
        status: oauthReloadVerificationMisses >= 2 && pastRetryGrace
          ? 'ready_to_retry'
          : 'check_again',
        ...(retryGraceRemainingMs > 0
          ? { retryAfterSeconds: Math.ceil(retryGraceRemainingMs / 1_000) }
          : {}),
      };
      render(true);
    } catch (error) {
      if (disposed || gen !== loadGeneration) return;
      state.loading = false;
      state.error = null;
      state.oauthReloadRecovery = {
        providerLabel: flow.providerLabel,
        slug: flow.slug,
        status: 'check_again',
        error: errMessage(error),
      };
      render(true);
    } finally {
      oauthReloadVerificationInFlight = false;
    }
  };

  const applyTerminalOAuth = (
    flow: FoundationalOAuthTerminalState,
  ): void => {
    if (flow.lane !== state.lane) return;
    if (
      flow.status === 'failed'
      && flow.reloadInterruption?.phase === 'during_exchange'
    ) {
      pendingLoad = verifyInterruptedOAuth(flow);
      void pendingLoad;
      return;
    }
    const terminal = oauthContinuity.takeTerminal(flow.id);
    if (terminal === null) return;
    applySavedOAuthAppConfig(terminal);
    submitInFlight = false;
    state.saving = false;
    state.oauthFinishing = false;
    state.oauthProgressStage = null;
    state.oauthReloadRecovery = null;
    if (terminal.status === 'succeeded') {
      state.connectionSuccess = {
        slug: terminal.slug,
        providerId: terminal.providerId,
        ...(terminal.note !== undefined ? { note: terminal.note } : {}),
      };
      state.error = null;
      state.formError = null;
      state.stage = 'list';
      state.providerId = null;
      state.values = {};
      state.oauthCredValues = { client_id: '', client_secret: '' };
      firstSyncPollAttempts = 0;
      const refresh = doRefresh(false, true);
      if (!oauthDismissed && !disposed) focusConnectionSuccess();
      void refresh.then(() => openFirstMailboxProposals(terminal.slug));
      return;
    }

    state.connectionSuccess = null;
    if (
      terminal.reloadInterruption?.phase === 'before_exchange'
      && !oauthDismissed
    ) {
      restoreInterruptedOAuthForm(terminal, terminal.error);
      return;
    }
    if (oauthDismissed) {
      state.stage = 'list';
      state.providerId = null;
      state.values = {};
      state.oauthCredValues = { client_id: '', client_secret: '' };
      state.formError = null;
      state.error = terminal.error;
    } else {
      state.stage = 'form';
      state.providerId = terminal.providerId;
      state.values = { ...terminal.accountValues };
      state.oauthCredValues = {
        client_id: safeOAuthClientId(terminal),
        client_secret: '',
      };
      state.error = null;
      state.formError = terminal.error;
    }
    render();
  };

  const onOAuthContinuity = (
    flow: FoundationalOAuthContinuityState,
  ): void => {
    if (disposed || flow.status === 'idle' || flow.lane !== state.lane) return;
    if (flow.status === 'pending') {
      submitInFlight = true;
      // A stage transition (consent → exchange) must not pull an owner who
      // chose Keep working back into the waiting card on the same mount.
      if (!oauthDismissed) applyPendingOAuth(flow);
    } else {
      applyTerminalOAuth(flow);
    }
  };

  /** Route-independent state needs only enough information to reconstruct the
   * foundational OAuth form. Keep this allowlist narrow so a future provider
   * field cannot silently become boot-lived (credentials already live in the
   * separate write-only OAuth-app structure). */
  const continuityAccountValues = (): AccountFormValues => {
    const safe: AccountFormValues = {};
    for (const key of ['name', 'send_enabled', 'calendar_enabled', 'oauth_app_id'] as const) {
      const value = state.values[key];
      if (value !== undefined) safe[key] = key === 'name' ? value.trim() : value;
    }
    return safe;
  };

  const driveOAuth = (): void => {
    if (state.saving) return;
    const provider = activeProvider();
    if (provider === undefined || !isOAuthAccountTransport(provider.transport)) return;
    if (state.values.auth_method === 'managed_oauth') {
      void submitForm();
      return;
    }
    // "Keep working" deliberately returns to an interactive account list. If
    // the owner opens another OAuth form while the first consent is still
    // boot-owned, explain the conflict instead of leaving an enabled Connect
    // button that appears to do nothing.
    const existingOAuth = oauthContinuity.snapshot();
    if (existingOAuth.status !== 'idle') {
      state.formError = existingOAuth.status === 'pending'
        ? `Finish the ${existingOAuth.providerLabel} sign-in already in progress.`
        : `Review the ${existingOAuth.providerLabel} sign-in result before starting another.`;
      render();
      return;
    }
    if (submitInFlight) return;
    const invalid = validateAccountForm(provider, state.values);
    if (invalid !== null) {
      state.formError = invalid;
      render();
      return;
    }
    const spec =
      opts.getOAuthClientConfig === undefined
        ? null
        : state.lane === 'mail'
          ? mailOAuthSpec(provider)
          : state.lane === 'calendar'
            ? calendarOAuthSpec(provider)
            : null;
    if (spec === null) {
      state.formError = 'Sign-in is not available.';
      render();
      return;
    }
    if (state.rows.some((row) => row.slug === spec.slug)) {
      state.formError = `An account named ${spec.slug} already exists. Go back to open it, or choose another name.`;
      render();
      return;
    }
    // Resolve the inline BYO app credentials. The SECRET drives whether to save:
    // a fresh secret ⇒ save (the client_id must accompany it, since the secret
    // is write-only and can't be partially preserved); a BLANK secret ⇒ reuse a
    // saved/env app (the prefilled client_id is just display). Blank secret with
    // no configured app errors — UNLESS the snapshot hasn't loaded (caller
    // absent), where we fall through to the legacy path and let
    // getOAuthClientConfig decide + surface its own error.
    const appConfigLoaded = state.oauthAppConfig !== null;
    const status = oauthAppStatusForSelection(state.oauthAppConfig, spec.issuer, state.values.oauth_app_id);
    // Reusable WITHOUT entering a secret only if a usable secret is already
    // available (stored or env). `source !== null` alone isn't enough — an env
    // app with a client_id but no secret (`RECUED_*_CLIENT_ID` set, secret
    // unset) reports `source: 'env', has_secret: false` and CANNOT complete the
    // exchange, so a blank-secret Connect must still demand the secret.
    const reusable = status !== null && status.source !== null && status.has_secret === true;
    const clientId = (state.oauthCredValues.client_id ?? '').trim();
    // Match the server's credential normalization so whitespace cannot make a
    // disabled setup look complete and then fail only after the popup opens.
    const clientSecret = (state.oauthCredValues.client_secret ?? '').trim();
    let saveArgs: SetOAuthAppConfigArgs | null = null;
    if (clientSecret.length > 0 && state.values.oauth_app_id && state.values.oauth_app_id !== 'default') {
      state.formError = 'Edit this named app in Apps & APIs, then select it and connect.'; render(); return;
    }
    if (clientSecret.length > 0) {
      if (clientId.length === 0) {
        state.formError = 'Enter the Client ID alongside the Client secret.';
        render();
        return;
      }
      if (opts.setOAuthAppConfig === undefined) {
        state.formError = 'This server cannot save sign-in keys.';
        render();
        return;
      }
      saveArgs = { issuer: spec.issuer, client_id: clientId, client_secret: clientSecret };
    } else if (
      reusable
      && clientId.length > 0
      && clientId !== (status?.client_id?.trim() ?? '')
    ) {
      state.formError = 'Enter the matching Client secret to replace this sign-in app.';
      render();
      return;
    } else if (appConfigLoaded && !reusable) {
      // Blank secret + no usable saved/env app — nothing to reuse.
      state.formError = clientId.length > 0
        ? 'Enter the Client secret to finish sign-in setup.'
        : "Enter your OAuth app's Client ID and secret to connect.";
      render();
      return;
    } else if (!appConfigLoaded && clientId.length > 0) {
      state.formError = 'Enter the matching Client secret, or clear the Client ID to use server settings.';
      render();
      return;
    }
    // Open the popup SYNCHRONOUSLY in the click gesture — a popup opened
    // after an await is blocked.
    const oenv = resolveOAuthEnv();
    const popup = oenv.openPopup();
    if (popup === null) {
      state.formError = oauthFailureMessage('popup_blocked');
      render();
      return;
    }
    oauthDismissed = false;
    submitInFlight = true;
    state.saving = true;
    state.formError = null;
    // Show truthful progress for the WHOLE connect span (popup preparation →
    // consent → code exchange), not just post-consent, so the wait never reads
    // as a stuck form.
    state.oauthFinishing = true;
    state.oauthProgressStage = 'preparing';
    render();
    const appConfigToSave = saveArgs;
    const selectedAppId = state.values.oauth_app_id;
    const selectedClientId = clientId || status?.client_id;
    const started = oauthContinuity.start({
      lane: state.lane as Extract<AccountLaneId, 'mail' | 'calendar'>,
      providerId: spec.providerId,
      providerLabel: spec.providerLabel,
      slug: spec.slug,
      issuer: spec.issuer,
      returnHref: opts.oauthReturnHref ?? `#connections/${state.lane}`,
      accountValues: continuityAccountValues(),
      clientId,
      popup,
      env: oenv.env,
      ...(appConfigToSave !== null
        ? {
            saveAppConfig: {
              issuer: appConfigToSave.issuer,
              clientId: appConfigToSave.client_id,
              run: () => opts.setOAuthAppConfig!(appConfigToSave),
            },
          }
        : {}),
      resolveClientId: async () => {
        const appToResolve = selectedAppId ?? (appConfigToSave && opts.getOAuthAppConfig ? 'default' : undefined);
        if (!appToResolve) return spec.clientId(await opts.getOAuthClientConfig!());
        if (!opts.getOAuthAppConfig) throw new Error('Refresh the saved OAuth apps before connecting.');
        const latest = await opts.getOAuthAppConfig();
        const app = savedOAuthAppsForIssuer(latest, spec.issuer).find(app => app.id === appToResolve && app.has_secret);
        if (!app || app.client_id !== selectedClientId) throw new Error('The selected OAuth app changed or was removed. Refresh and connect again.');
        if (!disposed) state.oauthAppConfig = latest;
        return app.client_id;
      },
      buildAuthorizeUrl: spec.authorizeUrl,
      enroll: spec.enroll,
      missingClientIdMessage:
        `Couldn't load your ${spec.providerLabel} app credentials. `
        + 'Re-enter the Client ID and secret and try again.',
      popupFailureMessage: (reason, detail) =>
        oauthFailureMessage(reason, detail, spec.issuer),
      errorMessage: error => { oauthHelp.observeFailure(error); return errMessage(error); },
    });
    if (!started.ok) {
      submitInFlight = false;
      state.saving = false;
      state.oauthFinishing = false;
      state.oauthProgressStage = null;
      state.formError = started.reason === 'busy'
        ? 'Another sign-in is already in progress. Finish or cancel it first.'
        : 'Sign-in is no longer available in this tab.';
      render();
    }
  };

  // ── Detail ────────────────────────────────────────────────────
  const openDetail = (slug: string): void => {
    clearConnectionSuccess();
    state.stage = 'detail';
    state.detailSlug = slug;
    render();
    focusPanelElement('[data-accounts-detail-heading]');
    opts.onNavigate?.(state.lane, slug);
  };

  const rowBusyKey = (op: string, slug: string): string => `${op}:${slug}`;

  const setRowBusy = (op: string, slug: string, busy: boolean): void => {
    const next = new Set(state.rowBusy);
    if (busy) next.add(rowBusyKey(op, slug));
    else next.delete(rowBusyKey(op, slug));
    state.rowBusy = next;
  };

  const setRowError = (slug: string, message: string | null): void => {
    const next = { ...state.rowError };
    if (message === null) delete next[slug];
    else next[slug] = message;
    state.rowError = next;
  };

  const runRowAction = async (
    op: 'delete' | 'resync' | 'reauth',
    slug: string,
    call: () => Promise<unknown>,
    afterSuccess: 'reload-list' | 'reload-stay',
  ): Promise<void> => {
    if (state.rowBusy.has(rowBusyKey(op, slug))) return;
    const preserveActionFocus = true;
    setRowBusy(op, slug, true);
    setRowError(slug, null);
    render(preserveActionFocus);
    try {
      await call();
      if (disposed) return;
      setRowBusy(op, slug, false);
      if (afterSuccess === 'reload-list') {
        state.stage = 'list';
        state.detailSlug = null;
        await doRefresh(false, preserveActionFocus);
        opts.onNavigate?.(state.lane, null);
      } else {
        await doRefresh(false, preserveActionFocus);
      }
    } catch (err) {
      if (disposed) return;
      setRowBusy(op, slug, false);
      setRowError(slug, errMessage(err));
      render(preserveActionFocus);
    }
  };

  /** Open the removal prompt. Removal used to fire straight from the row button;
   *  it is irreversible without re-running the whole OAuth consent, and the
   *  button sits inline in a list where a mis-click is easy. */
  const askDeleteAccount = (slug: string): void => {
    if (laneCallers(state.lane) === undefined) return;
    const lane = findAccountLane(state.lane);
    const row = state.rows.find((r) => r.slug === slug);
    // Resolve the label NOW: the row can leave `rows` while the delete is in
    // flight, and the prompt must not go blank mid-removal.
    const providerLabel = (lane !== undefined && row !== undefined
      ? findAccountProvider(lane, row.adapterType)?.label
      : undefined) ?? 'account';
    state.deleteConfirm = {
      slug,
      providerLabel,
      // A folder's records go with it (its files stay): the prompt says so.
      ...(state.lane === 'file' && row?.adapterType === 'fs' ? { localFolder: true as const } : {}),
      deleting: false,
    };
    render();
    armDeleteFocusTrap();
  };

  const cancelDeleteAccount = (): void => {
    // Ignore Cancel once the delete is in flight — the rpc cannot be recalled,
    // so closing the prompt would only hide an action that is still happening.
    if (state.deleteConfirm === null || state.deleteConfirm.deleting) return;
    const { slug } = state.deleteConfirm;
    state.deleteConfirm = null;
    releaseDeleteFocusTrap();
    render();
    focusSlugAction('accounts-delete', slug);
  };

  const confirmDeleteAccount = async (): Promise<void> => {
    const dc = state.deleteConfirm;
    // ⚠ `dc.deleting` here is defence-in-depth, not the double-submit guard —
    // `runRowAction` already refuses a second call for a busy (op, slug) via
    // `rowBusy`, and removing this check leaves every test green. Its LOAD-
    // BEARING job is the flag it sets below: the disabled buttons + "Removing…"
    // label, and gating Cancel.
    if (dc === null || dc.deleting) return;
    const callers = laneCallers(state.lane);
    if (callers === undefined) return;
    dc.deleting = true;
    // The confirm stays focusable under aria-disabled/aria-busy, so preserve
    // its exact action identity instead of dropping focus to the dialog.
    render(true);
    try {
      await runRowAction('delete', dc.slug, () => callers.delete({ slug: dc.slug }), 'reload-list');
    } finally {
      // Cleared on BOTH paths: `runRowAction` surfaces its own row-level error,
      // and leaving the prompt up over a failed delete would strand the panel
      // behind a modal with no way back.
      const returnedToList = state.stage === 'list';
      state.deleteConfirm = null;
      releaseDeleteFocusTrap();
      render();
      if (returnedToList) focusPanelElement('[data-action="accounts-open-add"]');
      else focusSlugAction('accounts-delete', dc.slug);
    }
  };

  const resyncAccount = (slug: string): void => {
    const callers = laneCallers(state.lane);
    if (
      callers === undefined
      || (callers as MailLaneCallers | CalendarLaneCallers | FileLaneCallers).resync === undefined
    ) {
      setRowError(slug, 'Re-sync is not available for this account.');
      render(true);
      return;
    }
    const resync = (callers as MailLaneCallers | CalendarLaneCallers | FileLaneCallers).resync!;
    // A server from before mail Re-sync has no such call, and the webclient
    // updates separately: say what to do instead of naming the missing call.
    const call = state.lane === 'mail'
      ? () => resync({ slug }).catch((err: unknown) => {
          if (classifyRpcError(err).code === 'unknown_method') throw new Error('Update this server to re-sync mail.');
          throw err;
        })
      : () => resync({ slug });
    void runRowAction('resync', slug, call, 'reload-stay');
  };

  const openAuthenticationManagement = async (slug: string): Promise<void> => {
    const row = state.rows.find(r => r.slug === slug);
    if (!row || state.stage !== 'detail' || state.saving || authenticationPanel?.busy() || oauthAppSwitchPanel?.busy() || bulkAppSwitchPanel?.busy()
      || !['mail', 'calendar'].includes(state.lane) || !['gmail', 'gcal', 'graph'].includes(row.adapterType)) return;
    authenticationPanel?.close(); oauthAppSwitchPanel?.close(); bulkAppSwitchPanel?.close();
    state.authenticationManagement = { slug: row.slug, action: 'reauthorize' }; render();
    host.querySelector<HTMLElement>('[data-manage-authentication-heading]')?.focus();
    if (!row.managedConnectionName) await oauthAppSwitchPanel?.reauthorize(state.lane as 'mail' | 'calendar', row.slug);
    else await authenticationPanel?.permissions(state.lane as 'mail' | 'calendar', row.slug, row.managedConnectionName);
  };

  /** Best-effort copy for the exact provider callback URI. The URI remains
   *  visible beside the action, so unavailable/denied clipboard access never
   *  blocks setup. */
  const copyOAuthRedirect = (
    value: string | undefined,
    element: HTMLElement,
  ): void => {
    if (value === undefined || value === '') return;
    element.setAttribute('aria-live', 'polite');
    element.setAttribute('aria-atomic', 'true');
    const feedback = (visible: string, accessible: string): void => {
      element.textContent = visible;
      // The rendered button starts with a contextual aria-label. Keep that
      // accessible name in sync with the visible async outcome; otherwise the
      // label masks the live-region text and a screen reader still hears Copy.
      element.setAttribute('aria-label', accessible);
    };
    const copy = opts.copyText
      ?? (doc.defaultView?.navigator.clipboard?.writeText === undefined
        ? undefined
        : (text: string) => doc.defaultView!.navigator.clipboard.writeText(text));
    if (copy === undefined) {
      feedback('Copy manually', 'Recued could not copy it. Select the address to come back to and copy it yourself.');
      return;
    }
    try {
      void copy(value)
        .then(() => {
          if (!disposed) feedback('Copied', 'Callback URL copied.');
        })
        .catch(() => {
          if (!disposed) {
            feedback('Copy manually', 'Copy failed. Select and copy the callback URL manually.');
          }
        });
    } catch {
      feedback('Copy manually', 'Copy failed. Select and copy the callback URL manually.');
    }
  };

  // ── Action handlers ───────────────────────────────────────────
  const handoffSetup = (destination: 'apps' | 'connection'): void => {
    if (state.stage !== 'form') { openSavedApps(); return; }
    const provider = state.providerId;
    if ((state.lane !== 'mail' && state.lane !== 'calendar') || (provider !== 'gmail' && provider !== 'gcal' && provider !== 'graph')) return;
    if (!opts.setupContinuity || !opts.onSetupHandoff) {
      if (destination === 'apps') openSavedApps(); else opts.onOpenManagedConnections?.();
      return;
    }
    if (state.oauthCredValues.client_secret && !(doc.defaultView?.confirm?.('Open authentication settings? Your account name and choices will be kept for the return. The unsaved client secret will be discarded.') ?? true)) return;
    opts.setupContinuity.save({ lane: state.lane, providerId: provider, destination, values: state.values });
    state.oauthCredValues = { client_id: '', client_secret: '' }; handingOffSetup = true;
    opts.onSetupHandoff(destination);
  };
  const handlers: ActionHandlers<AccountsAction> = {
    'accounts-open-add': () => {
      if (!confirmDiscardSetup()) return;
      openAdd();
    },
    'accounts-pick-provider': (dataset) => {
      const lane = findAccountLane(state.lane);
      if (lane === undefined || dataset.provider === undefined) return;
      const provider = findAccountProvider(lane, dataset.provider);
      if (provider === undefined) return;
      openProvider(provider);
    },
    'accounts-back-to-list': () => {
      if (!confirmDiscardSetup() || passwordPanel.hasDraft() && !(doc.defaultView?.confirm?.('Discard the replacement password?') ?? true)) return;
      backToList();
    },
    'accounts-submit-form': () => {
      void submitForm();
    },
    'accounts-oauth-connect': () => {
      driveOAuth();
    },
    'accounts-manage-authentication': (dataset) => { if (dataset.slug) void openAuthenticationManagement(dataset.slug); },
    'accounts-authentication-choice': (dataset) => {
      const selection = state.authenticationManagement;
      const row = state.rows.find(r => r.slug === selection?.slug);
      if (!selection || !row || !['reauthorize', 'app', 'method'].includes(dataset.choice ?? '') || state.saving
        || authenticationPanel?.busy() || oauthAppSwitchPanel?.busy() || bulkAppSwitchPanel?.busy()) return;
      if (dataset.choice === 'app' && row.managedConnectionName) return;
      authenticationPanel?.close(); oauthAppSwitchPanel?.close();
      selection.action = dataset.choice as 'reauthorize' | 'app' | 'method'; render();
      if (selection.action === 'method') void authenticationPanel?.open(state.lane as 'mail' | 'calendar', row.slug, row.managedConnectionName);
      else if (selection.action === 'app') void oauthAppSwitchPanel?.open(state.lane as 'mail' | 'calendar', row.slug);
      else if (!row.managedConnectionName) void oauthAppSwitchPanel?.reauthorize(state.lane as 'mail' | 'calendar', row.slug);
      else void authenticationPanel?.permissions(state.lane as 'mail' | 'calendar', row.slug, row.managedConnectionName);
    },
    'accounts-switch-authentication': (dataset) => {
      const row = state.rows.find(r => r.slug === dataset.slug);
      if (!row || state.saving || authenticationPanel?.busy() || oauthAppSwitchPanel?.busy() || bulkAppSwitchPanel?.busy() || !['mail', 'calendar'].includes(state.lane)) return;
      bulkAppSwitchPanel?.close();
      oauthAppSwitchPanel?.close();
      void authenticationPanel?.open(state.lane as 'mail' | 'calendar', row.slug, row.managedConnectionName);
    },
    'accounts-switch-oauth-app': (dataset) => {
      const row = state.rows.find(r => r.slug === dataset.slug);
      if (!row || row.managedConnectionName || state.saving || authenticationPanel?.busy() || oauthAppSwitchPanel?.busy() || bulkAppSwitchPanel?.busy()
        || !['mail', 'calendar'].includes(state.lane) || !['gmail', 'gcal', 'graph'].includes(row.adapterType)) return;
      authenticationPanel?.close();
      bulkAppSwitchPanel?.close();
      void oauthAppSwitchPanel?.open(state.lane as 'mail' | 'calendar', row.slug);
    },
    'accounts-bulk-switch-oauth-app': () => {
      if (state.stage !== 'list' || !['mail', 'calendar'].includes(state.lane) || state.saving || authenticationPanel?.busy() || oauthAppSwitchPanel?.busy() || bulkAppSwitchPanel?.busy()) return;
      authenticationPanel?.close(); oauthAppSwitchPanel?.close(); void bulkAppSwitchPanel?.open(state.lane);
    },
    'accounts-open-managed-connection': () => {
      if (state.saving) return;
      if (state.stage === 'form') handoffSetup('connection');
      else opts.onOpenManagedConnections?.(state.rows.find(row => row.slug === state.detailSlug)?.managedConnectionName);
    },
    'accounts-manage-saved-apps': () => { if (!state.saving) handoffSetup('apps'); },
    'accounts-update-credentials': dataset => {
      if (state.saving || passwordPanel.busy() || passwordPanel.hasDraft() || !dataset.slug) return;
      const row = state.rows.find(row => row.slug === dataset.slug);
      const call = state.lane === 'mail' ? opts.mail?.updateCredentials : opts.calendar?.updateCredentials;
      if (row?.passwordRepairAvailable && call) passwordPanel.open(state.lane, row.slug, row.sendCapable === true && row.adapterType !== 'smtp', call, row.adapterType === 'smtp');
    },
    'accounts-clear-filters': () => { state.filters = undefined; render(); host.querySelector<HTMLElement>('[data-acct-filter="query"]')?.focus(); },
    'accounts-copy-oauth-redirect': (dataset, _event, element) => {
      copyOAuthRedirect(dataset.copyValue, element);
    },
    'accounts-oauth-dismiss': () => {
      // Immediate escape from the OAuth progress card. The boot-owned flow
      // keeps running and stays discoverable through Account; its one-shot
      // result returns here instead of being lost with this presentation.
      oauthDismissed = true;
      state.oauthFinishing = false;
      state.oauthProgressStage = null;
      state.saving = false;
      state.stage = 'list';
      state.providerId = null;
      state.values = {};
      state.oauthCredValues = { client_id: '', client_secret: '' };
      state.detailSlug = null;
      render();
      opts.onNavigate?.(state.lane, null);
    },
    'accounts-oauth-cancel': () => {
      const flow = oauthContinuity.snapshot();
      if (
        flow.status !== 'pending'
        || flow.lane !== state.lane
        || flow.stage === 'finishing'
      ) return;
      oauthDismissed = false;
      oauthContinuity.cancel(flow.id);
    },
    'accounts-oauth-recovery-check': () => {
      const flow = oauthContinuity.snapshot();
      if (
        flow.status !== 'failed'
        || flow.lane !== state.lane
        || flow.reloadInterruption?.phase !== 'during_exchange'
      ) return;
      pendingLoad = verifyInterruptedOAuth(flow);
      void pendingLoad;
    },
    'accounts-oauth-recovery-restart': () => {
      if (state.oauthReloadRecovery?.status !== 'ready_to_retry') return;
      const flow = oauthContinuity.snapshot();
      if (
        flow.status !== 'failed'
        || flow.lane !== state.lane
        || flow.reloadInterruption?.phase !== 'during_exchange'
      ) return;
      const terminal = oauthContinuity.takeTerminal(flow.id);
      if (terminal === null || terminal.status !== 'failed') return;
      restoreInterruptedOAuthForm(
        terminal,
        'Repeated checks did not find this connection. Start a fresh sign-in; the interrupted authorization code will not be reused.',
      );
    },
    'accounts-success-go-chat': () => {
      const success = state.connectionSuccess;
      if (success === null) return;
      opts.onGoToChat?.({
        lane: state.lane,
        providerId: success.providerId,
        slug: success.slug,
      });
    },
    'accounts-success-open-lane': (dataset) => {
      if (dataset.lane === undefined) return;
      const lane = findAccountLane(dataset.lane);
      if (lane === undefined) return;
      opts.onOpenLane?.(lane.id);
    },
    'accounts-success-refresh': () => {
      firstSyncPollAttempts = 0;
      void doRefresh(false, true);
    },
    'accounts-dismiss-success': () => {
      const success = state.connectionSuccess;
      if (success === null) return;
      clearConnectionSuccess();
      render();
      if (!focusAccountRow(success.slug)) {
        focusPanelElement('[data-action="accounts-open-add"]');
      }
      scheduleFirstSyncPoll();
    },
    'accounts-open-detail': (dataset) => {
      if (dataset.slug === undefined) return;
      openDetail(dataset.slug);
    },
    'accounts-delete': (dataset) => {
      if (dataset.slug === undefined) return;
      askDeleteAccount(dataset.slug);
    },
    'accounts-delete-cancel': () => {
      cancelDeleteAccount();
    },
    'accounts-delete-confirm': () => {
      void confirmDeleteAccount();
    },
    'accounts-resync': (dataset) => {
      if (dataset.slug === undefined) return;
      resyncAccount(dataset.slug);
    },
    'accounts-reauth': (dataset) => {
      if (dataset.slug === undefined) return;
      openAuthenticationManagement(dataset.slug);
    },
  };

  // ── Field-edit delegation (`data-acct-field`) ─────────────────
  // Silent value capture, focus-preserving — these forms have no
  // conditional visibility so no edit ever re-renders the field grid.
  type FieldElement = HTMLElement & { value?: string };
  const onFieldEvent = (event: Event): void => {
    const target = event.target as FieldElement | null;
    if (target === null || typeof target.closest !== 'function') return;

    // Inline OAuth-app credential fields (client_id / client_secret) — captured
    // into the separate `oauthCredValues` sub-state so the secret never mixes
    // with the enroll-bound account `values`. Matched first; the dataset-key
    // guard keeps a fake-DOM `closest` (which ignores the selector) from
    // swallowing account-field events.
    const credEl = target.closest('[data-oauth-cred-field]') as FieldElement | null;
    if (
      credEl !== null
      && host.contains(credEl)
      && credEl.dataset.oauthCredField !== undefined
    ) {
      const credKey = credEl.dataset.oauthCredField;
      if ((credEl.tagName === 'SELECT' ? 'change' : 'input') !== event.type) return;
      if (state.saving || state.values.oauth_app_id && state.values.oauth_app_id !== 'default') return;
      rememberEdit('credential.' + credKey, state.oauthCredValues[credKey as keyof typeof state.oauthCredValues] ?? '');
      state.oauthCredValues = { ...state.oauthCredValues, [credKey]: credEl.value ?? '' };
      // Clear a stale form error on the first edit after a failed connect.
      if (state.formError !== null) {
        state.formError = null;
        render(true);
      } else {
        syncSubmitDisabled();
      }
      return;
    }

    const filter = target.closest('[data-acct-filter]') as FieldElement | null;
    if (filter?.dataset.acctFilter && host.contains(filter)) {
      if ((filter.tagName === 'SELECT' ? 'change' : 'input') !== event.type) return;
      state.filters = { ...state.filters, [filter.dataset.acctFilter]: filter.value ?? '' }; render(true); return;
    }
    const el = target.closest('[data-acct-field]') as FieldElement | null;
    if (el === null || !host.contains(el)) return;
    const key = el.dataset.acctField;
    if (key === undefined) return;
    const isSelect = el.tagName === 'SELECT';
    if ((isSelect ? 'change' : 'input') !== event.type) return;
    if (state.saving) return;
    rememberEdit(key, state.values[key] ?? '');
    if (key === 'oauth_app_id') {
      const provider = activeProvider();
      if (!provider || !isOAuthAccountTransport(provider.transport)) return;
      const issuer = oauthAppIssuerForProvider(provider.id as 'gmail' | 'gcal' | 'graph');
      const app = savedOAuthAppsForIssuer(state.oauthAppConfig, issuer).find(app => app.id === el.value && app.has_secret);
      if (!app) return;
      state.values = { ...state.values, oauth_app_id: app.id };
      state.oauthCredValues = { client_id: app.client_id, client_secret: '' }; state.formError = null; render(true); return;
    }
    state.values = { ...state.values, [key]: el.value ?? '' };
    if (key === 'auth_method') {
      // Changing modes discards the write choices and any direct-app secret draft.
      state.oauthCredValues = { client_id: '', client_secret: '' };
      state.values = { ...state.values, mutation_enabled: 'false',
        write_enabled: 'false', calendar_enabled: 'false', connection_name: '' };
      const provider = activeProvider();
      const compatible = provider ? managedConnectionsForAccount(provider.id, state.managedConnections ?? []) : [];
      if (compatible.length === 1) state.values.connection_name = compatible[0]!.name;
      state.formError = null;
      render(true);
      return;
    }
    if (key === 'connection_name') { state.formError = null; render(true); return; }
    if (state.formError !== null) {
      // First edit after a failed submit clears the stale error and re-enables
      // Submit without dropping the corrected field's focus or caret.
      state.formError = null;
      render(true);
      return;
    }
    syncSubmitDisabled();
  };

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || state.deleteConfirm === null) return;
    // Keep Escape owned by the modal even while its irreversible write is in
    // flight; once started, the prompt deliberately cannot be dismissed.
    event.preventDefault();
    event.stopPropagation();
    if (!state.deleteConfirm.deleting) cancelDeleteAccount();
  };

  // ── Wire dispatchers + seed load ──────────────────────────────
  const detachActions = createActionDispatcher<AccountsAction>({
    root: host,
    handlers,
  });
  host.addEventListener('input', onFieldEvent);
  host.addEventListener('change', onFieldEvent);
  host.addEventListener('keydown', onKeydown);

  render();
  const restoredSetup = opts.initialDetailSlug === undefined ? opts.setupContinuity?.take(state.lane) : undefined;
  if (restoredSetup) {
    const provider = findAccountProvider(findAccountLane(state.lane)!, restoredSetup.providerId);
    if (provider) { openProvider(provider); for (const key of Object.keys(restoredSetup.values)) rememberEdit(key, state.values[key] ?? '');
      state.values = { ...state.values, ...restoredSetup.values }; render(); focusPanelElement('[data-accounts-form-heading]'); }
  }
  void doRefresh();
  if (opts.initialManageAuthentication && opts.initialManageAuthentication === opts.initialDetailSlug) {
    const slug = opts.initialManageAuthentication; const lane = state.lane; const gen = loadGeneration;
    pendingLoad = pendingLoad.then(async () => {
      if (disposed || gen !== loadGeneration || state.error || state.lane !== lane || state.stage !== 'detail' || state.detailSlug !== slug || state.authenticationManagement) return;
      const row = state.rows.find(r => r.slug === slug);
      const updateCredentials = lane === 'mail' ? opts.mail?.updateCredentials : lane === 'calendar' ? opts.calendar?.updateCredentials : undefined;
      if (row?.passwordRepairAvailable && updateCredentials) {
        passwordPanel.open(lane, row.slug, row.sendCapable === true && row.adapterType !== 'smtp', updateCredentials, row.adapterType === 'smtp');
        return;
      }
      if (!row || !['mail', 'calendar'].includes(lane) || !['gmail', 'gcal', 'graph'].includes(row.adapterType) || !opts.runCollectionAuthentication) {
        state.error = 'This account cannot open an authentication review. Refresh and choose a current Mail or Calendar account.'; render(); return;
      }
      await openAuthenticationManagement(slug);
    });
  }
  detachOAuthContinuity = oauthContinuity.subscribe(onOAuthContinuity);

  return {
    getState: () => state,
    refresh: () => doRefresh(false, true),
    whenLoaded: () => pendingLoad,
    hasUnsavedChanges: () => !handingOffSetup && (changedSetup() || passwordPanel.hasDraft()),
    hasInFlightWork: () => passwordPanel.busy() || authenticationPanel?.busy() === true || oauthAppSwitchPanel?.busy() === true || bulkAppSwitchPanel?.busy() === true || submitInFlight
      || state.saving
      || oauthReloadVerificationInFlight
      || state.rowBusy.size > 0
      || state.deleteConfirm?.deleting === true,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      authenticationPanel?.dispose();
      passwordPanel.dispose();
      oauthHelp.dispose();
      oauthAppSwitchPanel?.dispose();
      bulkAppSwitchPanel?.dispose();
      cancelFirstSyncPoll();
      releaseDeleteFocusTrap();
      detachOAuthContinuity();
      if (ownsOAuthContinuity) oauthContinuity.dispose();
      detachActions();
      host.removeEventListener('input', onFieldEvent);
      host.removeEventListener('change', onFieldEvent);
      host.removeEventListener('keydown', onKeydown);
      host.innerHTML = '';
    },
  };
};

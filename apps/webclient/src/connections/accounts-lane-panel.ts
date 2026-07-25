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
 *  These forms have NO conditional field visibility, so every field edit
 *  is SILENT (focus-preserving) — only the Submit button's disabled
 *  attribute is synced imperatively, and the submit handler re-validates
 *  before firing the rpc (the visual state is never load-bearing).
 *
 *  ── Slice 1 (non-OAuth enrollment) ──────────────────────────────────
 *  Mail → IMAP (`collection.mail.enrollImap`); Files → fs + s3
 *  (`collection.file.enroll`). Calendar lists + manages existing
 *  accounts but has no enrollable provider yet (OAuth + CalDAV land
 *  later). Each lane's actions degrade honestly when its caller seam is
 *  absent. */

import {
  buildMailAuthorizeUrl,
  buildCalendarAuthorizeUrl,
  buildOpenerRelayRedirectUri,
  oauthAppIssuerForProvider,
  type CollectionInstanceRow,
  type MailOAuthProvider,
  type CalendarOAuthAdapter,
  type OAuthAppConfigSnapshot,
  type OAuthAppIssuer,
  type SetOAuthAppConfigArgs,
} from '@recued/contracts';
import {
  canSubmitAccountForm,
  renderAccountsPanel,
  findAccountLane,
  findAccountProvider,
  initialAccountsPanelState,
  isOAuthAccountTransport,
  seedAccountFormValues,
  validateAccountForm,
  type AccountFormValues,
  type AccountLaneId,
  type AccountProvider,
  type AccountRow,
  type AccountsPanelState,
} from '@recued/ui-shared';
import {
  createActionDispatcher,
  type ActionHandlers,
} from '@recued/ui-shared/action-dispatcher';
import {
  runOAuthPopup,
  openOAuthPopup,
  defaultFoundationalOAuthEnv,
  type FoundationalOAuthEnv,
  type FoundationalOAuthPopupHandle,
} from './foundational-oauth-popup.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

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
  send_capable: boolean;
  account_email: string;
}

export interface MailLaneCallers {
  list: () => Promise<{ instances: ReadonlyArray<MailAccountListRow> }>;
  enrollImap: (args: Record<string, unknown>) => Promise<{ slug: string; send_capable: boolean }>;
  /** OAuth enrollment — the popup-captured code + the byte-matched
   *  redirect_uri. Optional so older mounts without it still type. */
  enrollOAuth?: (args: {
    provider: MailOAuthProvider;
    account_slug: string;
    code: string;
    redirect_uri: string;
  }) => Promise<{ ok: true; account_key_prefix: string }>;
  delete: (args: { slug: string }) => Promise<{ ok: true }>;
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
  }) => Promise<{ slug: string }>;
  /** CalDAV basic-auth enrollment (field form, Slice 2a backend). */
  enrollBasic?: (args: Record<string, unknown>) => Promise<{ slug: string }>;
}

export interface FileLaneCallers {
  /** `collection.listInstances` filtered to `{ type: 'file' }`. */
  list: () => Promise<{ instances: ReadonlyArray<CollectionInstanceRow> }>;
  enroll: (args: Record<string, unknown>) => Promise<unknown>;
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
  /** Fired on lane / detail navigation so the route can sync the hash
   *  (`#connections/<lane>[/<slug>]`). Optional — navigation works
   *  internally without it. */
  onNavigate?: (lane: AccountLaneId, detailSlug: string | null) => void;
  /** Post-connect next actions. The route supplies hash-aware callbacks so
   *  these also work with injected/manual hash sources. */
  onGoToChat?: (source: AccountsChatHandoff) => void;
  onOpenLane?: (lane: AccountLaneId) => void;
  mail?: MailLaneCallers;
  calendar?: CalendarLaneCallers;
  file?: FileLaneCallers;
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
  /** Test seam for the callback-URI Copy action. Production uses the active
   *  document's Clipboard API; absence degrades to manual selection. */
  copyText?: (value: string) => Promise<void>;
  /** First-sync status polling seam. Production uses the mounted document's
   *  window timer; non-browser mounts do not poll unless this is injected. */
  firstSyncPoll?: AccountsFirstSyncPollScheduler;
  /** Defaults to 2500ms. */
  firstSyncPollIntervalMs?: number;
  /** Bounded by default to 24 checks (about one minute). */
  firstSyncPollMaxAttempts?: number;
}

export interface AccountsLanePanelMount {
  getState(): AccountsPanelState;
  /** Re-list the current lane. */
  refresh(): Promise<void>;
  /** Initial / most-recent load promise. */
  whenLoaded(): Promise<void>;
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
  | 'accounts-copy-oauth-redirect'
  | 'accounts-oauth-dismiss'
  | 'accounts-success-go-chat'
  | 'accounts-success-open-lane'
  | 'accounts-success-refresh'
  | 'accounts-dismiss-success'
  | 'accounts-open-detail'
  | 'accounts-delete'
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
  // Bumped before every list await; a post-await write only lands when its
  // captured generation is still current (a lane switch / refresh overtaking
  // a slow in-flight list must not clobber the newer view).
  let loadGeneration = 0;
  let pendingLoad: Promise<void> = Promise.resolve();
  // Survives stage navigation — blocks a second enroll write while one is
  // still settling (server CAS is the real cross-client guard; this fences
  // one mounted panel).
  let submitInFlight = false;
  // OAuth "Back to accounts" escape: true once the user dismissed the
  // post-consent "Finishing sign-in…" card while the code-exchange was still
  // in flight. Routes the eventual result to the list (success → the account
  // appears via refresh; failure → a lane-level error) instead of back to the
  // form. Reset at the start of each OAuth attempt.
  let oauthDismissed = false;
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
  const firstSyncPollMaxAttempts = opts.firstSyncPollMaxAttempts ?? 24;
  let firstSyncPollAttempts = 0;
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
    /** The active element lived inside the post-connect card. */
    inConnectionSuccess: boolean;
  }

  const capturePanelFocus = (): PanelFocusSnapshot | null => {
    const active = doc.activeElement as HTMLElement | null | undefined;
    if (
      active === undefined
      || active === null
      || typeof active.closest !== 'function'
      || !host.contains(active)
    ) return null;
    const action = active.closest('[data-action]') as HTMLElement | null;
    return {
      actionDataset: action === null
        ? null
        : Object.fromEntries(
            Object.entries(action.dataset).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
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
    // A status transition can legitimately remove an action (for example the
    // unknown-state Retry button). Keep focus at the card, not on <body>.
    if (snapshot.inConnectionSuccess) focusConnectionSuccess(true);
  };

  const render = (preserveFocus = false): void => {
    if (disposed) return;
    const focus = preserveFocus ? capturePanelFocus() : null;
    host.innerHTML = renderAccountsPanel({ state });
    if (preserveFocus) restorePanelFocus(focus);
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
          lastSyncedAt: m.last_synced_at,
        };
      }
      const c = r as CollectionInstanceRow;
      return {
        slug: c.slug,
        adapterType: c.adapter_type,
        authState: c.auth_state,
        reauthAvailable:
          lane === 'calendar' && (c.caps as { auth?: unknown }).auth === 'oauth',
        lastSyncedAt: c.last_synced_at,
      };
    });

  /** Only the newly connected row + current load error can change the
   *  post-connect presentation. Background polls deliberately ignore unrelated
   *  row churn so an unchanged pending status does not repaint the panel. */
  const firstSyncViewKey = (): string | null => {
    const success = state.connectionSuccess;
    if (success === null) return null;
    return JSON.stringify({
      error: state.error,
      row: state.rows.find((candidate) => candidate.slug === success.slug) ?? null,
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
    render(preserveFocus);
  };

  // ── List load (generation-guarded) ────────────────────────────
  const shouldPollFirstSync = (): boolean => {
    const success = state.connectionSuccess;
    if (
      success === null
      || state.stage !== 'list'
      || state.loading
      || firstSyncPoll === null
      || firstSyncPollAttempts >= firstSyncPollMaxAttempts
    ) return false;
    // A foreground post-connect refresh may have left a stale pre-enroll row.
    // Keep checking until one authoritative list read succeeds; the renderer
    // likewise refuses to call that stale timestamp "ready" while error is set.
    if (state.error !== null) return true;
    const row = state.rows.find((candidate) => candidate.slug === success.slug);
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
    }, firstSyncPollIntervalMs);
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
        : loadOAuthAppConfig(gen, preserveFocus);
      try {
        if (callers === undefined) {
          await configLoad;
          if (disposed || gen !== loadGeneration) return;
          if (background) return;
          state.loading = false;
          state.rows = [];
          state.error = 'This lane is not available on this server yet.';
          render(preserveFocus);
          return;
        }
        const { instances } = await callers.list();
        await configLoad;
        if (disposed || gen !== loadGeneration) return;
        state.rows = normalizeRows(lane, instances);
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
      const status = state.oauthAppConfig?.[issuer] ?? null;
      state.oauthCredValues = { client_id: status?.client_id ?? '', client_secret: '' };
    } else {
      state.oauthCredValues = { client_id: '', client_secret: '' };
    }
    render();
  };

  const openAdd = (): void => {
    const lane = findAccountLane(state.lane);
    if (lane === undefined || lane.providers.length === 0) return;
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
  };

  const backToList = (): void => {
    state.stage = 'list';
    state.providerId = null;
    state.values = {};
    // Don't let a typed OAuth client secret linger in mount state after the
    // user leaves the form without connecting.
    state.oauthCredValues = { client_id: '', client_secret: '' };
    state.formError = null;
    state.detailSlug = null;
    render();
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
    render();
    try {
      if (provider.transport === 'mail-imap') {
        if (opts.mail === undefined) throw new Error('Mail enrollment is not available.');
        await opts.mail.enrollImap(payload);
      } else if (provider.transport === 'calendar-caldav') {
        if (opts.calendar?.enrollBasic === undefined) {
          throw new Error('CalDAV enrollment is not available.');
        }
        await opts.calendar.enrollBasic(payload);
      } else {
        if (opts.file === undefined) throw new Error('File enrollment is not available.');
        await opts.file.enroll(payload);
      }
      if (disposed) return;
      state.stage = 'list';
      state.providerId = null;
      state.values = {};
      state.saving = false;
      await doRefresh();
    } catch (err) {
      if (disposed) return;
      state.saving = false;
      state.formError = errMessage(err);
      render();
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
  ): string => {
    switch (reason) {
      case 'popup_blocked':
        return 'Popup blocked — allow popups for this site and try again.';
      case 'denied':
        return detail ? `Sign-in was declined: ${detail}` : 'Sign-in was declined.';
      case 'timeout':
        return 'Sign-in timed out. Please try again.';
      case 'closed':
        return 'Sign-in window closed before finishing.';
      default:
        return detail ?? 'Sign-in failed.';
    }
  };

  // Per-lane wiring of the otherwise-identical popup→code→enroll flow. The
  // mail/calendar arg shapes, builders, and config keys differ; everything
  // else (sync popup open, config fetch, byte-matched redirect, error +
  // dispose handling) is shared in `completeOAuth`.
  interface OAuthLaneSpec {
    providerId: string;
    providerLabel: string;
    slug: string;
    /** OAuth-app issuer (`google` covers gmail + gcal; `microsoft` covers
     *  graph mail + calendar) — the key for the inline BYO credentials. */
    issuer: OAuthAppIssuer;
    clientId: (cfg: OAuthClientConfigResult) => string | null;
    authorizeUrl: (args: { client_id: string; redirect_uri: string; state: string }) => string;
    enroll: (args: { code: string; redirect_uri: string }) => Promise<unknown>;
  }

  const mailOAuthSpec = (provider: AccountProvider): OAuthLaneSpec | null => {
    if (opts.mail?.enrollOAuth === undefined) return null;
    const p = provider.id as MailOAuthProvider;
    const slug = (state.values['name'] ?? '').trim();
    const sendEnabled = state.values['send_enabled'] === 'true';
    return {
      providerId: provider.id,
      providerLabel: provider.label,
      slug,
      issuer: oauthAppIssuerForProvider(p),
      clientId: (cfg) => (p === 'gmail' ? cfg.gmail : cfg.graph)?.client_id ?? null,
      authorizeUrl: (a) => buildMailAuthorizeUrl(p, { ...a, send_enabled: sendEnabled }),
      enroll: (a) =>
        opts.mail!.enrollOAuth!({
          provider: p,
          account_slug: slug,
          code: a.code,
          redirect_uri: a.redirect_uri,
        }),
    };
  };

  const calendarOAuthSpec = (provider: AccountProvider): OAuthLaneSpec | null => {
    if (opts.calendar?.enrollOAuth === undefined) return null;
    const adapter = provider.id as CalendarOAuthAdapter;
    const slug = (state.values['name'] ?? '').trim();
    return {
      providerId: provider.id,
      providerLabel: provider.label,
      slug,
      issuer: oauthAppIssuerForProvider(adapter),
      clientId: (cfg) => (adapter === 'gcal' ? cfg.gcal : cfg.graph)?.client_id ?? null,
      authorizeUrl: (a) => buildCalendarAuthorizeUrl(adapter, a),
      enroll: (a) =>
        opts.calendar!.enrollOAuth!({
          slug,
          adapter,
          oauth_code: a.code,
          oauth_redirect_uri: a.redirect_uri,
        }),
    };
  };

  const driveOAuth = (): void => {
    if (submitInFlight || state.saving) return;
    const provider = activeProvider();
    if (provider === undefined || !isOAuthAccountTransport(provider.transport)) return;
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
    // Resolve the inline BYO app credentials. The SECRET drives whether to save:
    // a fresh secret ⇒ save (the client_id must accompany it, since the secret
    // is write-only and can't be partially preserved); a BLANK secret ⇒ reuse a
    // saved/env app (the prefilled client_id is just display). Blank secret with
    // no configured app errors — UNLESS the snapshot hasn't loaded (caller
    // absent), where we fall through to the legacy path and let
    // getOAuthClientConfig decide + surface its own error.
    const appConfigLoaded = state.oauthAppConfig !== null;
    const status = state.oauthAppConfig?.[spec.issuer] ?? null;
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
    if (clientSecret.length > 0) {
      if (clientId.length === 0) {
        state.formError = 'Enter the Client ID alongside the Client secret.';
        render();
        return;
      }
      if (opts.setOAuthAppConfig === undefined) {
        state.formError = 'Saving sign-in credentials is not available on this server.';
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
    // Show the "Signing in…" overlay for the WHOLE connect span (popup open →
    // consent → code-exchange), not just post-consent, so the wait never reads
    // as a stuck form.
    state.oauthFinishing = true;
    render();
    void completeOAuth(spec, oenv, popup, saveArgs);
  };

  const completeOAuth = async (
    spec: OAuthLaneSpec,
    oenv: AccountsOAuthEnv,
    popup: FoundationalOAuthPopupHandle,
    saveArgs: SetOAuthAppConfigArgs | null,
  ): Promise<void> => {
    try {
      // Persist any entered BYO credentials first — the server reads the
      // client_secret during the token exchange, so it must be stored before
      // enroll. (The popup is already open + blank, so this await is safe.)
      if (saveArgs !== null) {
        await opts.setOAuthAppConfig!(saveArgs);
        if (disposed) return;
        // Reflect the save locally so a later return-to-form (e.g. consent
        // declined) shows the app as configured, and drop the now-persisted
        // secret from form state (keep the client_id pre-filled).
        state.oauthAppConfig = {
          ...(state.oauthAppConfig ?? emptyOAuthAppConfig()),
          [saveArgs.issuer]: {
            client_id: saveArgs.client_id,
            has_secret: true,
            source: 'stored' as const,
          },
        };
        state.oauthCredValues = { client_id: saveArgs.client_id, client_secret: '' };
      }
      const cfg = await opts.getOAuthClientConfig!();
      const clientId = spec.clientId(cfg);
      if (clientId === null || clientId.length === 0) {
        throw new Error(
          `Couldn't load your ${spec.providerLabel} app credentials. Re-enter the Client ID and secret and try again.`,
        );
      }
      // Microsoft Entra rejects query strings in redirect URIs, so the graph
      // flow omits the `recued_relay` marker (the loopback relay page gates on
      // the `frelay_` state prefix instead). The SAME value is registered, used
      // in the authorize URL, and passed to enrollOAuth — byte-match holds.
      const redirectUri = buildOpenerRelayRedirectUri(
        oenv.env.origin,
        spec.issuer === 'microsoft',
      );
      const result = await runOAuthPopup(oenv.env, {
        popup,
        // The callback posts FROM the redirect_uri's host (the cloud callback),
        // which is cross-origin from a self-served PWA — so trust THAT origin,
        // not the PWA's own (R26.2).
        expectedSenderOrigin: new URL(redirectUri).origin,
        buildAuthorizeUrl: (oauthState) =>
          spec.authorizeUrl({ client_id: clientId, redirect_uri: redirectUri, state: oauthState }),
      });
      if (!result.ok) {
        throw new Error(oauthFailureMessage(result.reason, result.detail));
      }
      // Don't initiate the server enroll after the panel was torn down
      // mid-flight (the consent window can be long). The "Signing in…" overlay
      // is already up (set at popup-open), so no extra render here.
      if (disposed) return;
      await spec.enroll({ code: result.code, redirect_uri: redirectUri });
      if (disposed) return;
      state.connectionSuccess = {
        slug: spec.slug,
        providerId: spec.providerId,
      };
      firstSyncPollAttempts = 0;
      state.oauthFinishing = false;
      state.stage = 'list';
      state.providerId = null;
      state.values = {};
      state.oauthCredValues = { client_id: '', client_secret: '' };
      state.saving = false;
      const focusSuccess = !oauthDismissed;
      // Paint + focus the confirmation immediately, then preserve that focus
      // while the authoritative list read turns checking into pending/ready.
      // A slow server should not leave keyboard focus on the removed form.
      const refresh = doRefresh(false, true);
      if (focusSuccess && !disposed) focusConnectionSuccess();
      await refresh;
    } catch (err) {
      // Close the popup on any failure. For failures BEFORE runOAuthPopup
      // takes ownership (save / config fetch reject) this is the only cleanup;
      // after, runOAuthPopup already closed it. Skip when already closed to
      // avoid a COOP `window.close` warning on the cross-origin case.
      try { if (!popup.closed) popup.close(); } catch { /* cross-origin close may throw */ }
      if (disposed) return;
      state.oauthFinishing = false;
      state.saving = false;
      if (oauthDismissed) {
        // The user already left to the list via "Back to accounts"; surface
        // the failure there as a lane-level error rather than yanking them
        // back to a form they walked away from.
        state.error = errMessage(err);
      } else {
        // Still on the form / finishing card — show the error on the form
        // (its values are intact) so the user can retry.
        state.stage = 'form';
        state.formError = errMessage(err);
      }
      render();
    } finally {
      submitInFlight = false;
    }
  };

  // ── Detail ────────────────────────────────────────────────────
  const openDetail = (slug: string): void => {
    clearConnectionSuccess();
    state.stage = 'detail';
    state.detailSlug = slug;
    render();
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
    setRowBusy(op, slug, true);
    setRowError(slug, null);
    render();
    try {
      await call();
      if (disposed) return;
      setRowBusy(op, slug, false);
      if (afterSuccess === 'reload-list') {
        state.stage = 'list';
        state.detailSlug = null;
        await doRefresh();
        opts.onNavigate?.(state.lane, null);
      } else {
        await doRefresh();
      }
    } catch (err) {
      if (disposed) return;
      setRowBusy(op, slug, false);
      setRowError(slug, errMessage(err));
      render();
    }
  };

  const deleteAccount = (slug: string): void => {
    const callers = laneCallers(state.lane);
    if (callers === undefined) return;
    void runRowAction('delete', slug, () => callers.delete({ slug }), 'reload-list');
  };

  const resyncAccount = (slug: string): void => {
    const callers = laneCallers(state.lane);
    if (
      callers === undefined
      || state.lane === 'mail'
      || (callers as CalendarLaneCallers | FileLaneCallers).resync === undefined
    ) {
      setRowError(slug, 'Re-sync is not available for this account.');
      render();
      return;
    }
    const resync = (callers as CalendarLaneCallers | FileLaneCallers).resync!;
    void runRowAction('resync', slug, () => resync({ slug }), 'reload-stay');
  };

  const reauthAccount = (slug: string): void => {
    const callers = laneCallers(state.lane);
    if (
      callers === undefined
      || state.lane !== 'calendar'
      || (callers as CalendarLaneCallers).reauth === undefined
    ) {
      setRowError(slug, 'Re-authorize is not available for this account.');
      render();
      return;
    }
    const reauth = (callers as CalendarLaneCallers).reauth!;
    void runRowAction('reauth', slug, () => reauth({ slug }), 'reload-stay');
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
      feedback('Copy manually', 'Clipboard unavailable. Select and copy the callback URL manually.');
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
  const handlers: ActionHandlers<AccountsAction> = {
    'accounts-open-add': () => {
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
      backToList();
    },
    'accounts-submit-form': () => {
      void submitForm();
    },
    'accounts-oauth-connect': () => {
      driveOAuth();
    },
    'accounts-copy-oauth-redirect': (dataset, _event, element) => {
      copyOAuthRedirect(dataset.copyValue, element);
    },
    'accounts-oauth-dismiss': () => {
      // Immediate escape from the "Signing in…" overlay. The in-flight connect
      // keeps running (submitInFlight still fences it); its result lands on the
      // list (success → refresh shows the account; failure → lane error) via
      // the oauthDismissed branch in completeOAuth.
      oauthDismissed = true;
      state.oauthFinishing = false;
      state.saving = false;
      state.stage = 'list';
      state.providerId = null;
      state.values = {};
      state.oauthCredValues = { client_id: '', client_secret: '' };
      state.detailSlug = null;
      render();
      opts.onNavigate?.(state.lane, null);
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
      clearConnectionSuccess();
      render();
    },
    'accounts-open-detail': (dataset) => {
      if (dataset.slug === undefined) return;
      openDetail(dataset.slug);
    },
    'accounts-delete': (dataset) => {
      if (dataset.slug === undefined) return;
      deleteAccount(dataset.slug);
    },
    'accounts-resync': (dataset) => {
      if (dataset.slug === undefined) return;
      resyncAccount(dataset.slug);
    },
    'accounts-reauth': (dataset) => {
      if (dataset.slug === undefined) return;
      reauthAccount(dataset.slug);
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
      if (state.saving) return;
      state.oauthCredValues = { ...state.oauthCredValues, [credKey]: credEl.value ?? '' };
      // Clear a stale form error on the first edit after a failed connect.
      if (state.formError !== null) {
        state.formError = null;
        render();
      } else {
        syncSubmitDisabled();
      }
      return;
    }

    const el = target.closest('[data-acct-field]') as FieldElement | null;
    if (el === null || !host.contains(el)) return;
    const key = el.dataset.acctField;
    if (key === undefined) return;
    const isSelect = el.tagName === 'SELECT';
    if ((isSelect ? 'change' : 'input') !== event.type) return;
    if (state.saving) return;
    state.values = { ...state.values, [key]: el.value ?? '' };
    if (state.formError !== null) {
      // First edit after a failed submit clears the stale error (the one
      // deliberate focus cost — re-enables Submit by re-render).
      state.formError = null;
      render();
      return;
    }
    syncSubmitDisabled();
  };

  // ── Wire dispatchers + seed load ──────────────────────────────
  const detachActions = createActionDispatcher<AccountsAction>({
    root: host,
    handlers,
  });
  host.addEventListener('input', onFieldEvent);
  host.addEventListener('change', onFieldEvent);

  render();
  void doRefresh();

  return {
    getState: () => state,
    refresh: () => doRefresh(false, true),
    whenLoaded: () => pendingLoad,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      cancelFirstSyncPoll();
      detachActions();
      host.removeEventListener('input', onFieldEvent);
      host.removeEventListener('change', onFieldEvent);
      host.innerHTML = '';
    },
  };
};

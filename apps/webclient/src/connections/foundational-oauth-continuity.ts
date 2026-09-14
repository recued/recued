/** Boot-scoped continuity for the foundational Gmail/Microsoft OAuth flow.
 *
 * The Accounts panel opens the blank popup synchronously (inside the owner's
 * click), then hands the transaction here. This controller deliberately owns
 * the remaining save -> consent -> exchange sequence so an ordinary route
 * change can detach and later reattach a panel without losing the callback,
 * spending the authorization code twice, or replaying the final receipt.
 *
 * Secrets are never copied into the public snapshot. An optional credential
 * save is represented by a short-lived closure and that reference is cleared
 * immediately after the save settles. */

import {
  buildOpenerRelayRedirectUri,
  type OAuthAppIssuer,
} from '@recued/contracts';
import type { AccountFormValues, AccountLaneId } from '@recued/ui-shared';
import {
  runOAuthPopup,
  type FoundationalOAuthEnv,
  type FoundationalOAuthPopupHandle,
  type RunOAuthPopupResult,
} from './foundational-oauth-popup.js';
import {
  createFoundationalOAuthReloadStore,
  retainFoundationalOAuthAccountValues,
  type FoundationalOAuthContinuityStorage,
  type FoundationalOAuthReloadPhase,
} from './foundational-oauth-reload.js';

export interface FoundationalOAuthSavedAppConfig {
  readonly issuer: OAuthAppIssuer;
  readonly clientId: string;
}

interface FoundationalOAuthFlowIdentity {
  readonly id: string;
  readonly lane: Extract<AccountLaneId, 'mail' | 'calendar'>;
  readonly providerId: string;
  readonly providerLabel: string;
  readonly slug: string;
  readonly issuer: OAuthAppIssuer;
  readonly returnHref: string;
  readonly accountValues: Readonly<AccountFormValues>;
  readonly clientId: string;
  readonly savedAppConfig?: FoundationalOAuthSavedAppConfig;
}

export type FoundationalOAuthPendingStage =
  | 'preparing'
  | 'waiting_for_consent'
  | 'finishing';

export type FoundationalOAuthContinuityState =
  | { readonly status: 'idle' }
  | (FoundationalOAuthFlowIdentity & {
      readonly status: 'pending';
      readonly stage: FoundationalOAuthPendingStage;
    })
  | (FoundationalOAuthFlowIdentity & {
      readonly status: 'succeeded';
      readonly note?: string;
    })
  | (FoundationalOAuthFlowIdentity & {
      readonly status: 'failed';
      readonly error: string;
      /** Present only when this terminal result was reconstructed from a
       * privacy-safe reload marker. Before exchange can restart immediately;
       * during exchange must verify the server result first. */
      readonly reloadInterruption?: {
        readonly phase: FoundationalOAuthReloadPhase;
        readonly phaseStartedAt: number;
      };
    });

export type FoundationalOAuthTerminalState = Extract<
  FoundationalOAuthContinuityState,
  { status: 'succeeded' | 'failed' }
>;

export interface FoundationalOAuthWorkLease {
  (): void;
  update(details: {
    label?: string;
    returnLabel?: string;
    phase?: 'working' | 'result_ready';
  }): void;
}

export interface FoundationalOAuthContinuityOptions {
  /** Optional route-independent work projection (the webclient supplies the
   * server-switch tracker; direct panel mounts can omit it). */
  beginWork?: (details: {
    id: string;
    label: string;
    returnHref: string;
    returnLabel: string;
  }) => FoundationalOAuthWorkLease;
  /** Session-scoped reload marker. `undefined` uses sessionStorage, `null`
   * disables persistence. Markers are trusted only with the exact active
   * server-profile id. */
  storage?: FoundationalOAuthContinuityStorage | null;
  scopeId?: string | null;
  now?: () => number;
  reloadMarkerMaxAgeMs?: number;
}

export interface FoundationalOAuthStartRequest {
  lane: Extract<AccountLaneId, 'mail' | 'calendar'>;
  providerId: string;
  providerLabel: string;
  slug: string;
  issuer: OAuthAppIssuer;
  returnHref: string;
  accountValues: Readonly<AccountFormValues>;
  /** Safe form value only. The client secret lives exclusively in the
   * short-lived `saveAppConfig.run` closure below. */
  clientId: string;
  popup: FoundationalOAuthPopupHandle;
  env: FoundationalOAuthEnv;
  saveAppConfig?: {
    issuer: OAuthAppIssuer;
    clientId: string;
    run: () => Promise<unknown>;
  };
  resolveClientId: () => Promise<string | null>;
  buildAuthorizeUrl: (args: {
    client_id: string;
    redirect_uri: string;
    state: string;
  }) => string;
  enroll: (args: {
    code: string;
    redirect_uri: string;
  }) => Promise<{ note?: string } | void>;
  missingClientIdMessage: string;
  popupFailureMessage: (
    reason: Exclude<
      Extract<RunOAuthPopupResult, { ok: false }>['reason'],
      'cancelled'
    >,
    detail?: string,
  ) => string;
  errorMessage: (error: unknown) => string;
}

export type FoundationalOAuthStartResult =
  | { readonly ok: true; readonly flowId: string }
  | {
      readonly ok: false;
      readonly reason: 'busy' | 'disposed';
      readonly current: FoundationalOAuthContinuityState;
    };

export interface FoundationalOAuthContinuity {
  start(request: FoundationalOAuthStartRequest): FoundationalOAuthStartResult;
  snapshot(): FoundationalOAuthContinuityState;
  subscribe(
    listener: (state: FoundationalOAuthContinuityState) => void,
  ): () => void;
  /** Explicit owner cancellation. Produces one recoverable failure result so
   * the mounted form can explain that nothing was connected. */
  cancel(flowId: string): boolean;
  /** Atomically consume a terminal result. A second mount gets null, which is
   * what prevents success/error receipts from replaying. */
  takeTerminal(flowId: string): FoundationalOAuthTerminalState | null;
  dispose(): void;
}

const cloneState = (
  state: FoundationalOAuthContinuityState,
): FoundationalOAuthContinuityState => {
  if (state.status === 'idle') return state;
  return {
    ...state,
    accountValues: { ...state.accountValues },
    ...(state.savedAppConfig !== undefined
      ? { savedAppConfig: { ...state.savedAppConfig } }
      : {}),
  };
};

const closePopupQuietly = (popup: FoundationalOAuthPopupHandle): void => {
  try {
    if (!popup.closed) popup.close();
  } catch {
    /* a COOP-severed, cross-origin popup may reject close() */
  }
};

export const createFoundationalOAuthContinuity = (
  options: FoundationalOAuthContinuityOptions = {},
): FoundationalOAuthContinuity => {
  let state: FoundationalOAuthContinuityState = { status: 'idle' };
  let nextFlowId = 0;
  let disposed = false;
  let active: {
    readonly flowId: string;
    readonly popup: FoundationalOAuthPopupHandle;
    readonly abort: AbortController;
    markerArmed: boolean;
  } | null = null;
  let workLease: FoundationalOAuthWorkLease | null = null;
  const listeners = new Set<(
    state: FoundationalOAuthContinuityState,
  ) => void>();
  const now = options.now ?? Date.now;
  const reloadStore = createFoundationalOAuthReloadStore({
    storage: options.storage,
    scopeId: options.scopeId,
    now,
    ...(options.reloadMarkerMaxAgeMs !== undefined
      ? { maxAgeMs: options.reloadMarkerMaxAgeMs }
      : {}),
  });

  const writeReloadMarker = (
    flow: FoundationalOAuthFlowIdentity,
    phase: FoundationalOAuthReloadPhase,
    phaseStartedAt: number,
  ): boolean => reloadStore.write({
    lane: flow.lane,
    providerId: flow.providerId,
    slug: flow.slug,
    accountValues: flow.accountValues,
    clientId: flow.clientId,
    phase,
    phaseStartedAt,
  });

  const notify = (): void => {
    for (const listener of listeners) {
      try {
        listener(cloneState(state));
      } catch {
        /* presentation observers never own the OAuth transaction */
      }
    }
  };

  const publish = (next: FoundationalOAuthContinuityState): void => {
    state = next;
    notify();
  };

  const currentFlow = (flowId: string): boolean =>
    !disposed
    && active?.flowId === flowId
    && state.status === 'pending'
    && state.id === flowId;

  const updateWork = (
    details: Parameters<FoundationalOAuthWorkLease['update']>[0],
  ): void => {
    try {
      workLease?.update(details);
    } catch {
      /* route-independent chrome never owns transaction settlement */
    }
  };

  const releaseWork = (): void => {
    const release = workLease;
    workLease = null;
    try {
      release?.();
    } catch {
      /* route-independent chrome never owns transaction settlement */
    }
  };

  const finishFailed = (
    flow: FoundationalOAuthFlowIdentity,
    error: string,
  ): void => {
    active = null;
    reloadStore.retire();
    updateWork({
      label: `${flow.providerLabel} sign-in needs attention`,
      returnLabel: 'Look at this sign-in',
      phase: 'result_ready',
    });
    publish({ ...flow, status: 'failed', error });
  };

  const run = async (
    flowId: string,
    initialFlow: FoundationalOAuthFlowIdentity,
    request: Omit<FoundationalOAuthStartRequest, 'saveAppConfig'>,
    initialSaveAppConfig: FoundationalOAuthStartRequest['saveAppConfig'],
  ): Promise<void> => {
    let flow = initialFlow;
    // The only object allowed to retain the write-only secret is this closure.
    // Clear it in a finally block as soon as the save attempt settles.
    let saveAppConfig = initialSaveAppConfig ?? null;
    initialSaveAppConfig = undefined;
    try {
      if (saveAppConfig !== null) {
        const saved = {
          issuer: saveAppConfig.issuer,
          clientId: saveAppConfig.clientId,
        } satisfies FoundationalOAuthSavedAppConfig;
        try {
          await saveAppConfig.run();
        } finally {
          saveAppConfig = null;
        }
        if (!currentFlow(flowId)) return;
        flow = { ...flow, clientId: saved.clientId, savedAppConfig: saved };
        publish({ ...flow, status: 'pending', stage: 'preparing' });
      }

      const resolvedClientId = await request.resolveClientId();
      if (!currentFlow(flowId)) return;
      if (resolvedClientId === null || resolvedClientId.trim().length === 0) {
        throw new Error(request.missingClientIdMessage);
      }
      flow = { ...flow, clientId: resolvedClientId };

      // Microsoft Entra rejects query strings in registered redirect URIs. The
      // same builder and issuer distinction used before continuity remains the
      // single source of truth for the authorize URL and enrollment exchange.
      const redirectUri = buildOpenerRelayRedirectUri(
        request.env.origin,
        request.issuer === 'microsoft',
      );
      // Capture before publishing: a presentation observer may synchronously
      // cancel from the waiting-state notification. The captured signal then
      // reaches the popup driver already aborted instead of dereferencing an
      // active flow that the observer legitimately cleared.
      const abortSignal = active!.abort.signal;
      publish({ ...flow, status: 'pending', stage: 'waiting_for_consent' });
      const popupResult = await runOAuthPopup(request.env, {
        popup: request.popup,
        expectedSenderOrigin: new URL(redirectUri).origin,
        buildAuthorizeUrl: (oauthState) => request.buildAuthorizeUrl({
          client_id: resolvedClientId,
          redirect_uri: redirectUri,
          state: oauthState,
        }),
        // Route mounts are only observers and never abort this signal;
        // explicit cancellation / boot teardown do.
        signal: abortSignal,
      });
      if (!currentFlow(flowId)) return;
      if (!popupResult.ok) {
        if (popupResult.reason === 'cancelled') return;
        finishFailed(
          flow,
          request.popupFailureMessage(popupResult.reason, popupResult.detail),
        );
        return;
      }

      // Once this marker says `during_exchange`, a reload may only recover by
      // checking the authoritative account list. Make that transition durable
      // BEFORE handing the one-use code to the server. If an already-armed
      // marker cannot be advanced, stop here instead of leaving a stale
      // "nothing was sent" receipt beside a request we did dispatch.
      if (
        active?.markerArmed === true
        && !writeReloadMarker(flow, 'during_exchange', now())
      ) {
        reloadStore.retire();
        throw new Error(
          'Recued could not hold on to this sign-in through a reload. Nothing was sent to your server. Start signing in again.',
        );
      }
      updateWork({ label: `Finishing ${flow.providerLabel} connection` });
      publish({ ...flow, status: 'pending', stage: 'finishing' });
      const enrollment = await request.enroll({
        code: popupResult.code,
        redirect_uri: redirectUri,
      });
      if (!currentFlow(flowId)) return;
      active = null;
      reloadStore.retire();
      updateWork({
        label: `${flow.providerLabel} is connected — see what to do next`,
        returnLabel: 'See the Connection',
        phase: 'result_ready',
      });
      publish({
        ...flow,
        status: 'succeeded',
        ...(enrollment?.note !== undefined ? { note: enrollment.note } : {}),
      });
    } catch (error) {
      saveAppConfig = null;
      closePopupQuietly(request.popup);
      if (!currentFlow(flowId)) return;
      finishFailed(flow, request.errorMessage(error));
    }
  };

  // A reload cannot reattach the provider popup or revive its one-use state.
  // Consume the marker up front (before any observer exists), then expose one
  // route-independent recovery result. No success is inferred here: an
  // exchange-phase interruption remains explicitly unverified until the lane
  // performs an authoritative list read.
  const interrupted = reloadStore.consume();
  if (interrupted !== null) {
    // Re-arm the validated marker until the exact lane actually consumes its
    // recovery. This keeps a later boot failure or another intentional reload
    // from losing the handoff, while `consume()` still prevents trusting a
    // value that could not first be made inert.
    reloadStore.write({
      lane: interrupted.lane,
      providerId: interrupted.providerId,
      slug: interrupted.slug,
      accountValues: interrupted.accountValues,
      clientId: interrupted.clientId,
      phase: interrupted.phase,
      phaseStartedAt: interrupted.phaseStartedAt,
    });
    const flow: FoundationalOAuthFlowIdentity = {
      id: `foundational-oauth-reload-${Math.trunc(interrupted.phaseStartedAt)}`,
      lane: interrupted.lane,
      providerId: interrupted.providerId,
      providerLabel: interrupted.providerLabel,
      slug: interrupted.slug,
      issuer: interrupted.issuer,
      returnHref: interrupted.returnHref,
      accountValues: { ...interrupted.accountValues },
      clientId: interrupted.clientId,
    };
    const duringExchange = interrupted.phase === 'during_exchange';
    state = {
      ...flow,
      status: 'failed',
      error: duringExchange
        ? `This tab reloaded while Recued may have been saving ${flow.slug}. Check the server before signing in again.`
        : 'This tab reloaded before you finished signing in. Close the old sign-in window if it is still open, then start again.',
      reloadInterruption: {
        phase: interrupted.phase,
        phaseStartedAt: interrupted.phaseStartedAt,
      },
    };
    try {
      workLease = options.beginWork?.({
        id: `connections:oauth:${flow.id}`,
        label: duringExchange
          ? `Recued was stopped while checking your ${flow.providerLabel} sign-in`
          : `${flow.providerLabel} sign-in was interrupted`,
        returnHref: flow.returnHref,
        returnLabel: duringExchange ? 'Check the Connection' : 'Start signing in again',
      }) ?? null;
      updateWork({ phase: 'result_ready' });
    } catch {
      workLease = null;
    }
  }

  return {
    start(request) {
      if (disposed) {
        closePopupQuietly(request.popup);
        return { ok: false, reason: 'disposed', current: cloneState(state) };
      }
      if (state.status !== 'idle') {
        closePopupQuietly(request.popup);
        return { ok: false, reason: 'busy', current: cloneState(state) };
      }
      const flowId = `foundational-oauth-${++nextFlowId}`;
      const flow: FoundationalOAuthFlowIdentity = {
        id: flowId,
        lane: request.lane,
        providerId: request.providerId,
        providerLabel: request.providerLabel,
        slug: request.slug,
        issuer: request.issuer,
        returnHref: request.returnHref,
        accountValues: retainFoundationalOAuthAccountValues(request.accountValues),
        clientId: request.clientId,
      };
      const abort = new AbortController();
      const markerArmed = writeReloadMarker(flow, 'before_exchange', now());
      active = { flowId, popup: request.popup, abort, markerArmed };
      try {
        workLease = options.beginWork?.({
          id: `connections:oauth:${flowId}`,
          label: `Waiting for ${flow.providerLabel} sign-in`,
          returnHref: flow.returnHref,
          returnLabel: 'Finish connecting',
        }) ?? null;
      } catch {
        // Account chrome is a projection of the transaction, not part of its
        // trust path. A presentation failure must not strand the OAuth popup.
        workLease = null;
      }
      publish({ ...flow, status: 'pending', stage: 'preparing' });
      const { saveAppConfig, ...requestWithoutSecret } = request;
      void run(flowId, flow, requestWithoutSecret, saveAppConfig);
      return { ok: true, flowId };
    },
    snapshot: () => cloneState(state),
    subscribe(listener) {
      listeners.add(listener);
      try {
        listener(cloneState(state));
      } catch {
        /* match update isolation */
      }
      return () => listeners.delete(listener);
    },
    cancel(flowId) {
      if (!currentFlow(flowId) || state.status !== 'pending') return false;
      // Once enroll has started, its server side effect is not cancellable.
      // Refuse to promise cancellation at that point; the presentation swaps
      // to a non-cancellable "Finishing connection" state before the call.
      if (state.stage === 'finishing') return false;
      const flow: FoundationalOAuthFlowIdentity = {
        id: state.id,
        lane: state.lane,
        providerId: state.providerId,
        providerLabel: state.providerLabel,
        slug: state.slug,
        issuer: state.issuer,
        returnHref: state.returnHref,
        accountValues: { ...state.accountValues },
        clientId: state.clientId,
        ...(state.savedAppConfig !== undefined
          ? { savedAppConfig: { ...state.savedAppConfig } }
          : {}),
      };
      active?.abort.abort();
      if (active !== null) closePopupQuietly(active.popup);
      finishFailed(flow, 'You stopped signing in. No account was connected.');
      return true;
    },
    takeTerminal(flowId) {
      if (
        (state.status !== 'succeeded' && state.status !== 'failed')
        || state.id !== flowId
      ) return null;
      const terminal = cloneState(state) as FoundationalOAuthTerminalState;
      if (
        terminal.status === 'failed'
        && terminal.reloadInterruption !== undefined
      ) reloadStore.retire();
      releaseWork();
      publish({ status: 'idle' });
      return terminal;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // Before exchange the abort below proves there is no server outcome to
      // recover. During exchange cannot be cancelled, so retain that marker for
      // the next boot's verify-before-retry handoff.
      if (state.status === 'pending' && state.stage !== 'finishing') {
        reloadStore.retire();
      }
      active?.abort.abort();
      if (active !== null) closePopupQuietly(active.popup);
      active = null;
      releaseWork();
      state = { status: 'idle' };
      listeners.clear();
    },
  };
};

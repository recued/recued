/** Cross-tab notification for durable webclient credential-state changes.
 *
 * IndexedDB does not expose a change event, so a sibling tab that already
 * mounted either the app or the pair form cannot otherwise know that another
 * tab completed, replaced, or cleared the five-field pair. Notifications carry
 * no credential or server detail: listeners must re-read and verify their own
 * same-origin store before changing UI. Pair forms use a short poll fallback;
 * long-lived mounted sessions stay event/focus-driven to avoid permanent IDB
 * reads. */

export const PAIR_TAB_CONVERGENCE_CHANNEL_NAME =
  'recued.webclient.pair-complete.v1' as const;

const PAIR_TAB_CONVERGENCE_MESSAGE = Object.freeze({
  type: 'recued.webclient.pair-complete',
  version: 1,
} as const);

const CREDENTIAL_STATE_CHANGED_MESSAGE = Object.freeze({
  type: 'recued.webclient.credential-state-changed',
  version: 1,
} as const);

const ACTIVE_SERVER_PROFILE_CHANGED_MESSAGE = Object.freeze({
  type: 'recued.webclient.active-server-profile-changed',
  version: 1,
} as const);

const PAIR_TRANSITION_STARTED_MESSAGE = Object.freeze({
  type: 'recued.webclient.pair-transition-started',
  version: 1,
} as const);

const PAIR_TAKEOVER_STARTED_MESSAGE = Object.freeze({
  type: 'recued.webclient.pair-takeover-started',
  version: 1,
} as const);

const PAIR_TAKEOVER_NEEDS_ATTENTION_MESSAGE = Object.freeze({
  type: 'recued.webclient.pair-takeover-needs-attention',
  version: 1,
} as const);

const PAIR_RECOVERY_SUCCESSOR_CHOSEN_MESSAGE = Object.freeze({
  type: 'recued.webclient.pair-recovery-successor-chosen',
  version: 1,
} as const);

/** Separate from the pair-finalize lock: the chosen recovery tab holds this
 * lease while its retry is merely visible, before the user acts. A closing tab
 * releases Web Locks automatically, allowing exactly one waiting sibling to
 * become the next recovery owner. */
export const PAIR_RECOVERY_SUCCESSOR_LOCK_NAME =
  'recued.webclient.pair-recovery-successor' as const;

const DEFAULT_PAIR_TAB_POLL_MS = 1_200;

export type PairTabConvergenceHint =
  | 'pair_complete'
  | 'credential_state_changed'
  | 'active_server_profile_changed'
  | 'pair_transition_started'
  | 'pair_takeover_started'
  | 'pair_takeover_needs_attention'
  | 'pair_recovery_successor_chosen'
  | 'reconcile';

export interface PairRecoverySuccessorLease {
  /** Idempotently yield this tab's recovery-owner claim. Closing the browser
   * context also releases the underlying Web Lock. */
  release(): void;
}

export interface PairTabConvergence {
  /** True only when this instance can deliver low-latency ownership hints to
   * sibling tabs. Poll/focus reconciliation can still adopt durable state but
   * cannot support one-live-owner UI or its heartbeat lease. */
  readonly supportsImmediateSignals: boolean;
  /** True only when this instance has both immediate sibling signals and an
   * atomic browser lock for choosing one successor after owner loss. */
  readonly supportsRecoverySuccessorElection: boolean;
  /** Best-effort signal. Durable storage remains the source of truth. */
  notifyPairComplete(): void;
  /** Best-effort hint that a mounted tab cleared or replaced credentials. */
  notifyCredentialStateChanged(): void;
  /** Best-effort, detail-free hint that the origin-wide active profile moved.
   * Siblings pause immediately, then re-read the durable pointer themselves. */
  notifyActiveServerProfileChanged(): void;
  /** Best-effort, credential-free hint sent immediately after `/auth/pair`
   * succeeds, before local finalization. Sibling forms can retire a possibly
   * consumed one-time code even if the source closes before its first write. */
  notifyPairTransitionStarted(): void;
  /** Best-effort, credential-free hint that a queued guided contender owns
   * the exclusive lock and is continuing before its `/auth/pair` request. */
  notifyPairTakeoverStarted(): void;
  /** Best-effort hint that the current takeover owner now holds the one
   * actionable recovery error. Carries no error or credential detail. */
  notifyPairTakeoverNeedsAttention(): void;
  /** Best-effort heartbeat for the tab atomically selected after the prior
   * recovery owner disappears. No tab id, error, or credential crosses. */
  notifyPairRecoverySuccessorChosen(): void;
  /** Attempt a non-blocking atomic claim. A winner holds the returned lease
   * until it completes, yields, or closes; losers receive null and stay
   * passive. */
  claimPairRecoverySuccessor(): Promise<PairRecoverySuccessorLease | null>;
  /** Subscribe to hints that the caller should reconcile durable pair state. */
  subscribe(listener: (hint: PairTabConvergenceHint) => void): () => void;
  close(): void;
}

interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  close(): void;
}

interface PairTabWindowLike {
  readonly BroadcastChannel?: new (name: string) => BroadcastChannelLike;
  readonly navigator?: {
    readonly locks?: PairRecoverySuccessorLockProvider;
  };
  setInterval?(listener: () => void, delay: number): number;
  clearInterval?(handle: number): void;
  addEventListener?(type: 'focus', listener: () => void): void;
  removeEventListener?(type: 'focus', listener: () => void): void;
}

interface PairTabDocumentLike {
  readonly defaultView: PairTabWindowLike | null;
  readonly visibilityState?: DocumentVisibilityState;
  addEventListener?(type: 'visibilitychange', listener: () => void): void;
  removeEventListener?(type: 'visibilitychange', listener: () => void): void;
}

export interface BrowserPairTabConvergenceOptions {
  readonly document?: Document;
  /** Test seam; production pair forms use a modest 1.2 second fallback.
   * `null` keeps long-lived mounted sessions event/focus-driven. */
  readonly pollMs?: number | null;
  /** Deterministic test seam. `undefined` resolves `navigator.locks`; null
   * explicitly disables atomic successor election. */
  readonly recoverySuccessorLockProvider?:
    | PairRecoverySuccessorLockProvider
    | null;
}

interface PairRecoverySuccessorLock {
  readonly name: string;
}

export interface PairRecoverySuccessorLockProvider {
  request(
    name: string,
    options: { mode: 'exclusive'; ifAvailable: true },
    callback: (
      lock: PairRecoverySuccessorLock | null,
    ) => Promise<void>,
  ): Promise<void>;
}

const hintFromMessage = (value: unknown): PairTabConvergenceHint | null => {
  if (
    value === null
    || typeof value !== 'object'
    || (value as { version?: unknown }).version
      !== PAIR_TAB_CONVERGENCE_MESSAGE.version
  ) return null;
  const type = (value as { type?: unknown }).type;
  if (type === PAIR_TAB_CONVERGENCE_MESSAGE.type) return 'pair_complete';
  if (type === CREDENTIAL_STATE_CHANGED_MESSAGE.type) {
    return 'credential_state_changed';
  }
  if (type === ACTIVE_SERVER_PROFILE_CHANGED_MESSAGE.type) {
    return 'active_server_profile_changed';
  }
  if (type === PAIR_TRANSITION_STARTED_MESSAGE.type) {
    return 'pair_transition_started';
  }
  if (type === PAIR_TAKEOVER_STARTED_MESSAGE.type) {
    return 'pair_takeover_started';
  }
  if (type === PAIR_TAKEOVER_NEEDS_ATTENTION_MESSAGE.type) {
    return 'pair_takeover_needs_attention';
  }
  if (type === PAIR_RECOVERY_SUCCESSOR_CHOSEN_MESSAGE.type) {
    return 'pair_recovery_successor_chosen';
  }
  return null;
};

/** Build one channel per mounted pair form. Returns null outside a browser or
 * when neither BroadcastChannel nor a timer fallback is available. */
export const createBrowserPairTabConvergence = (
  options: BrowserPairTabConvergenceOptions = {},
): PairTabConvergence | null => {
  const doc = (options.document
    ?? (globalThis as { document?: Document }).document) as
    | PairTabDocumentLike
    | undefined;
  const view = doc?.defaultView;
  if (view === null || view === undefined) return null;

  let broadcast: BroadcastChannelLike | null = null;
  if (typeof view.BroadcastChannel === 'function') {
    try {
      broadcast = new view.BroadcastChannel(
        PAIR_TAB_CONVERGENCE_CHANNEL_NAME,
      );
    } catch {
      // Poll/focus reconciliation below remains available.
    }
  }
  if (broadcast === null && typeof view.setInterval !== 'function') {
    return null;
  }
  const recoverySuccessorLockCandidate =
    options.recoverySuccessorLockProvider !== undefined
      ? options.recoverySuccessorLockProvider
      : view.navigator?.locks ?? null;
  const recoverySuccessorLockProvider =
    recoverySuccessorLockCandidate !== null
    && typeof recoverySuccessorLockCandidate.request === 'function'
      ? recoverySuccessorLockCandidate
      : null;

  const listeners = new Set<(hint: PairTabConvergenceHint) => void>();
  const recoverySuccessorLeases = new Set<PairRecoverySuccessorLease>();
  let closed = false;
  const emit = (hint: PairTabConvergenceHint): void => {
    if (closed) return;
    for (const listener of [...listeners]) listener(hint);
  };
  const onMessage = (event: MessageEvent<unknown>): void => {
    const hint = hintFromMessage(event.data);
    if (hint !== null) emit(hint);
  };
  const onFocus = (): void => emit('reconcile');
  const onVisibilityChange = (): void => {
    if (doc?.visibilityState === 'visible') emit('reconcile');
  };

  broadcast?.addEventListener('message', onMessage);
  view.addEventListener?.('focus', onFocus);
  doc?.addEventListener?.('visibilitychange', onVisibilityChange);
  const pollMs = options.pollMs === undefined
    ? DEFAULT_PAIR_TAB_POLL_MS
    : options.pollMs;
  const pollHandle = pollMs !== null && typeof view.setInterval === 'function'
    ? view.setInterval(() => emit('reconcile'), pollMs)
    : null;

  const post = (message: unknown): void => {
    if (closed || broadcast === null) return;
    try {
      broadcast.postMessage(message);
    } catch {
      // Notification failure cannot roll back a durable store transition. A
      // sibling's focus (and the pair form's poll) still reconciles state.
    }
  };

  const claimPairRecoverySuccessor = async ():
    Promise<PairRecoverySuccessorLease | null> => {
    if (
      closed
      || broadcast === null
      || recoverySuccessorLockProvider === null
    ) return null;

    return new Promise<PairRecoverySuccessorLease | null>((resolve) => {
      let settled = false;
      const settle = (lease: PairRecoverySuccessorLease | null): void => {
        if (settled) return;
        settled = true;
        resolve(lease);
      };
      try {
        void recoverySuccessorLockProvider.request(
          PAIR_RECOVERY_SUCCESSOR_LOCK_NAME,
          { mode: 'exclusive', ifAvailable: true },
          async (lock) => {
            if (lock === null || closed) {
              settle(null);
              return;
            }
            let releaseHeldLock = (): void => undefined;
            const held = new Promise<void>((release) => {
              releaseHeldLock = release;
            });
            let released = false;
            const lease: PairRecoverySuccessorLease = {
              release() {
                if (released) return;
                released = true;
                recoverySuccessorLeases.delete(lease);
                releaseHeldLock();
              },
            };
            recoverySuccessorLeases.add(lease);
            settle(lease);
            await held;
          },
        ).catch(() => settle(null));
      } catch {
        settle(null);
      }
    });
  };

  return {
    supportsImmediateSignals: broadcast !== null,
    supportsRecoverySuccessorElection:
      broadcast !== null && recoverySuccessorLockProvider !== null,
    notifyPairComplete() {
      post(PAIR_TAB_CONVERGENCE_MESSAGE);
    },
    notifyCredentialStateChanged() {
      post(CREDENTIAL_STATE_CHANGED_MESSAGE);
    },
    notifyActiveServerProfileChanged() {
      post(ACTIVE_SERVER_PROFILE_CHANGED_MESSAGE);
    },
    notifyPairTransitionStarted() {
      post(PAIR_TRANSITION_STARTED_MESSAGE);
    },
    notifyPairTakeoverStarted() {
      post(PAIR_TAKEOVER_STARTED_MESSAGE);
    },
    notifyPairTakeoverNeedsAttention() {
      post(PAIR_TAKEOVER_NEEDS_ATTENTION_MESSAGE);
    },
    notifyPairRecoverySuccessorChosen() {
      // New tabs render the exact successor handoff. The legacy owner
      // heartbeat immediately after it keeps an already-open prior bundle
      // passive as well; same-channel delivery order means new tabs process
      // the richer hint first, then treat the compatibility hint as a silent
      // lease renewal rather than replacing the live region.
      post(PAIR_RECOVERY_SUCCESSOR_CHOSEN_MESSAGE);
      post(PAIR_TAKEOVER_NEEDS_ATTENTION_MESSAGE);
    },
    claimPairRecoverySuccessor,
    subscribe(listener) {
      if (closed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      listeners.clear();
      for (const lease of [...recoverySuccessorLeases]) lease.release();
      broadcast?.removeEventListener('message', onMessage);
      try {
        broadcast?.close();
      } catch {
        /* best-effort teardown */
      }
      if (pollHandle !== null) view.clearInterval?.(pollHandle);
      view.removeEventListener?.('focus', onFocus);
      doc?.removeEventListener?.('visibilitychange', onVisibilityChange);
    },
  };
};

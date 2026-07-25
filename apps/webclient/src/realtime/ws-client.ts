/** D-148 § A.4.2 + § A.4.4 — webclient WS client.
 *
 *  Connection lifecycle for the webclient's per-pair WS:
 *
 *   - Connect with `Authorization: Bearer <unwrapped webclient_token>`.
 *   - Subscribe to the broadcast bus (per `WEBCLIENT_DEFAULT_SUBSCRIPTIONS`).
 *   - Stream events.
 *   - On disconnect, exponential-backoff-with-jitter reconnect (1s →
 *     2s → ... → 30s cap, ±20% jitter) until success or until the user
 *     clicks Stop.
 *   - On 401 (rotated bearer / expired token / authority revoked), the
 *     client moves to the `reauth_required` state. The reconnect loop
 *     stops; the UI prompts the user (or, when a `token.rotated`
 *     broadcast brought a fresh token in advance, the runtime calls
 *     `applyRotatedBearer()` and the client resumes).
 *   - `send()` queues while disconnected and drains on the next
 *     `connected` transition. On `reauth_required` the queue clears
 *     (and the caller surfaces "actions discarded; retry?" per
 *     spec line 569).
 *
 *  The transport is abstracted over `WebclientWsTransport` so tests
 *  inject a deterministic in-memory loopback + production wires
 *  `WebSocket` (or a SW-derived MessageChannel for the cold-load
 *  path).
 */

export const WEBCLIENT_WS_RECONNECT_INITIAL_MS = 1_000;
export const WEBCLIENT_WS_RECONNECT_MAX_MS = 30_000;

/** Codex P3 #4 fold — multiplicative jitter range. ±20% spreads
 *  fleet reconnects so a user with multiple paired clients (or a
 *  cohort hit by one server outage) doesn't synchronize on the
 *  exact 1/2/4/... cadence. */
export const WEBCLIENT_WS_RECONNECT_JITTER_RATIO = 0.2;

/** Codex P2 #2 fold — outbound queue cap during disconnect. Caps
 *  memory growth if a pathological caller fires sends in a tight
 *  loop while the client is reauth-blocked. The default is generous;
 *  past this we drop oldest. */
export const WEBCLIENT_WS_SEND_QUEUE_MAX = 256;

export type WebclientWsState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'reauth_required'
  | 'closed';

/** Codex P2 #1 fold — explicit transport-level reauth signal. The
 *  transport raises this when the WS handshake responds with 401 or
 *  the auth subprotocol explicitly tells the client to discard its
 *  bearer. Production wires this from a 401 in the upgrade handshake;
 *  tests fire it directly. */
export class WebclientReauthRequiredError extends Error {
  readonly code = 'webclient_reauth_required' as const;
  constructor(public readonly reason: string = 'bearer_rejected') {
    super(`webclient: reauth required — ${reason}`);
  }
}

export interface WebclientWsTransport {
  /** Open a connection. Resolves once the transport has reached the
   *  `connected` state (auth handshake complete). Rejects on auth
   *  failure / network error / TLS-pin failure. The transport
   *  signals "401 / bearer rejected" by rejecting with a
   *  `WebclientReauthRequiredError`; other rejection modes trigger
   *  reconnect. */
  open(args: { server_url: string; bearer: string }): Promise<void>;
  /** Close the connection. Idempotent. */
  close(): Promise<void>;
  /** Send a JSON-serializable rpc envelope. */
  send(message: unknown): Promise<void>;
  /** Subscribe to inbound messages. Returns an unsubscribe fn. */
  onMessage(listener: (message: unknown) => void): () => void;
  /** Subscribe to transport state transitions. */
  onState(listener: (state: WebclientWsState) => void): () => void;
  /** Codex P1 fold — clear any sticky auth-block carried from a prior
   *  post-open auth close. The ws-client calls this from
   *  `applyRotatedBearer()` so a freshly-persisted bearer isn't
   *  blocked by the OLD WS's auth-close-deferred reauth signal (the
   *  browser-transport stamps `pendingReauthReason` on auth close
   *  codes 1008/4001/4401 and rejects the NEXT `open()` with
   *  `WebclientReauthRequiredError`; that defense is correct when no
   *  fresh bearer is available, wrong when one is). Implementations
   *  with no sticky-flag state implement as a no-op. */
  clearAuthBlock?(): void;
}

export interface WebclientWsClient {
  state(): WebclientWsState;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Send a message. Drops to the offline queue when not connected
   *  + drains on the next `connected` transition. Caller can detect
   *  drop via the returned promise resolving without dispatch (the
   *  state listener is the source of truth). */
  send(message: unknown): Promise<void>;
  /** Apply a freshly-rotated bearer (received via the `token.rotated`
   *  broadcast event). Clears the `reauth_required` state + resumes
   *  the reconnect loop. No-op when the client isn't in
   *  `reauth_required`. */
  applyRotatedBearer(): void;
  /** Snapshot of the offline send queue depth — diagnostics + tests. */
  queuedSends(): number;
  /** Drop every queued-while-disconnected send WITHOUT dispatching it.
   *  Called when a consumer has decided the connection is genuinely
   *  offline + has already failed the corresponding callers fast (see
   *  `rpc-conn.ts` server_offline path): without this the queued
   *  envelopes would drain on the next `connected` transition + re-fire
   *  side-effecting writes (`approval.resolve`, …) the caller already
   *  abandoned. Does not touch the reconnect loop. */
  clearSendQueue(): void;
  onMessage(listener: (message: unknown) => void): () => void;
  onState(listener: (state: WebclientWsState) => void): () => void;
}

interface WsClientOptions {
  transport: WebclientWsTransport;
  resolveServerUrl(): Promise<string>;
  resolveBearer(): Promise<string>;
  /** Override exponential backoff sequence (tests). The first
   *  element is the initial delay; each subsequent element is the
   *  next delay. Defaults to `[1000, 2000, 4000, 8000, 16000, 30000]`. */
  reconnect_schedule_ms?: ReadonlyArray<number>;
  /** Schedule a delayed callback (tests inject deterministic timer). */
  setTimer?(handler: () => void, delay_ms: number): { cancel: () => void };
  /** Random source for jitter (tests inject deterministic). */
  random?(): number;
  /** Override the offline queue cap (tests). */
  send_queue_max?: number;
}

const DEFAULT_BACKOFF = [
  1_000, 2_000, 4_000, 8_000, 16_000, 30_000,
] as const satisfies ReadonlyArray<number>;

const realTimer = (handler: () => void, delay_ms: number): { cancel: () => void } => {
  const id = setTimeout(handler, delay_ms);
  return { cancel: () => clearTimeout(id) };
};

const isReauthError = (err: unknown): err is WebclientReauthRequiredError => {
  if (err instanceof WebclientReauthRequiredError) return true;
  if (
    err &&
    typeof err === 'object' &&
    (err as { code?: string }).code === 'webclient_reauth_required'
  ) {
    return true;
  }
  return false;
};

export const createWebclientWsClient = (options: WsClientOptions): WebclientWsClient => {
  const setTimer = options.setTimer ?? realTimer;
  const random = options.random ?? Math.random;
  const queueMax = options.send_queue_max ?? WEBCLIENT_WS_SEND_QUEUE_MAX;
  const schedule = options.reconnect_schedule_ms ?? DEFAULT_BACKOFF;
  let attempt = 0;
  let pending: { cancel: () => void } | null = null;
  let active = false;
  let cur_state: WebclientWsState = 'disconnected';
  const stateListeners = new Set<(s: WebclientWsState) => void>();
  const messageListeners = new Set<(m: unknown) => void>();
  /** Outbound send queue used when disconnected. Codex P2 #2 fold. */
  let outbound: unknown[] = [];
  /** Codex P3 #5 fold — listener detachers. We re-register on every
   *  `connect()` instead of permanently detaching at `disconnect()`. */
  let detachState: (() => void) | null = null;
  let detachMessages: (() => void) | null = null;

  const setState = (next: WebclientWsState): void => {
    if (cur_state === next) return;
    cur_state = next;
    for (const l of [...stateListeners]) {
      try {
        l(cur_state);
      } catch {
        // Listener errors isolated.
      }
    }
  };

  const drainOutbound = async (): Promise<void> => {
    if (outbound.length === 0) return;
    const drained = outbound;
    outbound = [];
    for (const msg of drained) {
      try {
        await options.transport.send(msg);
      } catch {
        // Re-enqueue for the next reconnect.
        outbound.push(msg);
      }
    }
  };

  const wireTransportListeners = (): void => {
    if (detachState && detachMessages) return;
    detachState = options.transport.onState((s) => {
      if (s === 'connected') {
        attempt = 0;
        setState('connected');
        // Drain queued sends best-effort.
        void drainOutbound();
        return;
      }
      if (s === 'connecting') {
        setState('connecting');
        return;
      }
      if (!active) {
        setState(s);
        return;
      }
      // Codex P2 #1 fold — preserve `reauth_required` across raw
      // transport drops; the user must apply a rotated bearer or
      // re-pair before any reconnect attempt.
      if (cur_state === 'reauth_required') return;
      setState('reconnecting');
      queueReconnect();
    });
    detachMessages = options.transport.onMessage((m) => {
      for (const l of [...messageListeners]) {
        try {
          l(m);
        } catch {
          // Listener errors isolated.
        }
      }
    });
  };

  const computeDelayMs = (idx: number): number => {
    const base = schedule[Math.min(idx, schedule.length - 1)] ?? WEBCLIENT_WS_RECONNECT_MAX_MS;
    // Codex P3 #4 fold — apply ±jitter so a fleet doesn't sync on
    // the exact deterministic backoff.
    const jitter = (random() * 2 - 1) * WEBCLIENT_WS_RECONNECT_JITTER_RATIO;
    return Math.max(0, Math.round(base * (1 + jitter)));
  };

  const queueReconnect = (): void => {
    if (!active) return;
    if (cur_state === 'reauth_required') return;
    if (pending) {
      pending.cancel();
      pending = null;
    }
    const delay = computeDelayMs(attempt);
    attempt += 1;
    pending = setTimer(async () => {
      if (!active) return;
      if (cur_state === 'reauth_required') return;
      try {
        await openOnce();
      } catch (err) {
        if (isReauthError(err)) {
          // Codex P2 #1 fold — explicit reauth signal. Stop the
          // reconnect loop + clear the queued sends so the caller
          // can prompt the user; spec § A.4.4 line 569.
          outbound = [];
          if (pending) {
            pending.cancel();
            pending = null;
          }
          setState('reauth_required');
          return;
        }
        if (!active) return;
        setState('reconnecting');
        queueReconnect();
      }
    }, delay);
  };

  const openOnce = async (): Promise<void> => {
    setState('connecting');
    const server_url = await options.resolveServerUrl();
    const bearer = await options.resolveBearer();
    await options.transport.open({ server_url, bearer });
  };

  return {
    state: () => cur_state,
    queuedSends: () => outbound.length,
    clearSendQueue() {
      outbound = [];
    },
    async connect() {
      if (active) return;
      active = true;
      attempt = 0;
      // Codex P3 #5 fold — re-register transport listeners every
      // connect() (idempotent on re-entry; permanently-detached
      // listeners would silently drop state changes after reconnect).
      wireTransportListeners();
      try {
        await openOnce();
      } catch (err) {
        if (isReauthError(err)) {
          outbound = [];
          setState('reauth_required');
          return;
        }
        setState('reconnecting');
        queueReconnect();
      }
    },
    async disconnect() {
      active = false;
      if (pending) {
        pending.cancel();
        pending = null;
      }
      if (detachState) {
        detachState();
        detachState = null;
      }
      if (detachMessages) {
        detachMessages();
        detachMessages = null;
      }
      outbound = [];
      await options.transport.close();
      setState('closed');
    },
    async send(message) {
      if (cur_state === 'reauth_required') {
        // Spec § A.4.4 line 569 — discard with caller-visible drop.
        // We model this as a thrown error so the UI's "Retry?"
        // prompt fires; alternative would be silent drop, but the
        // user-visible signal is more honest.
        throw new WebclientReauthRequiredError('queued send dropped — token rotation pending');
      }
      if (cur_state === 'connected') {
        try {
          await options.transport.send(message);
          return;
        } catch (err) {
          if (isReauthError(err)) {
            outbound = [];
            setState('reauth_required');
            throw err;
          }
          // Transport drop mid-send — fall through to enqueue.
        }
      }
      // Codex P2 #2 fold — queue while not connected; drains on
      // next `connected`.
      if (outbound.length >= queueMax) {
        // Drop oldest to bound memory.
        outbound.shift();
      }
      outbound.push(message);
    },
    applyRotatedBearer() {
      // Codex P1 fold — clear the transport's sticky auth-block (set
      // by a prior post-open auth close on the OLD bearer) so the
      // first reconnect attempt with the FRESH bearer actually opens
      // instead of rejecting with `WebclientReauthRequiredError`.
      // Always called — safe whether the WS is currently `connected`
      // (rotation broadcast arrived before the auth-close that
      // motivates the sticky flag — the close may still arrive in
      // a later tick) or `reauth_required` (rotation broadcast arrived
      // after the auth close). The cost is one transport method call.
      try {
        options.transport.clearAuthBlock?.();
      } catch {
        // Defensive — `clearAuthBlock` is documented as side-effect-
        // free; a buggy transport must not derail the rotation flow.
      }
      if (cur_state !== 'reauth_required') return;
      // Caller has already wired a fresh bearer into resolveBearer().
      attempt = 0;
      setState('reconnecting');
      queueReconnect();
    },
    onMessage(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
  };
};

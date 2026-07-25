/** D-130 Phase 5.2 — Salesforce CometD long-poll subscriber.
 *
 *  Implements the Bayeux 1.0 protocol against
 *  `<instance_url>/cometd/<API_VERSION>/` with Salesforce's `replay`
 *  extension wired into every subscribe payload — driving:
 *
 *    1. **Handshake** (`/meta/handshake`) — opens the Bayeux session,
 *       captures the server-issued `clientId`. The Salesforce server
 *       returns a fresh `clientId` per session; after a transport
 *       failure the subscriber must hand-shake again rather than
 *       reusing a stale id.
 *    2. **Subscribe** (`/meta/subscribe`) — once per PushTopic
 *       channel (`/topic/RecuedOpportunityFeed` etc.), with the
 *       replay-extension `ext: { replay: { '<channel>': <replayId> } }`
 *       block populated from the shared `SalesforceReplayIdTracker`.
 *       First-time subscribe uses replay value `-1` ("from now"); a
 *       reconnect after observed events uses the highest seen replayId
 *       per channel so events that fired during disconnect aren't lost.
 *    3. **Long-poll connect** (`/meta/connect`) — the subscriber posts
 *       a connect message, the server holds the response open until
 *       events arrive or `~110s` elapses. The response carries the
 *       `/meta/connect` ack alongside zero or more `/topic/<name>`
 *       event messages. The subscriber forwards each `/topic/*` event
 *       through `onEvent` (which the boot wire bridges into the
 *       webhook funnel) and posts the next connect immediately.
 *    4. **Disconnect** (`/meta/disconnect`) — graceful termination
 *       on `stop()`. Best-effort — the abort controller cancels any
 *       in-flight long-poll first so the disconnect doesn't race.
 *
 *  Reconnect strategy:
 *    - Any transport failure (non-OK HTTP, JSON parse error,
 *      `successful: false` on /meta/handshake or /meta/connect with
 *      `advice.reconnect: 'handshake'`) tears the session down and
 *      restarts from handshake after a small exponential backoff
 *      (`reconnectBaseMs * 2^attempts`, capped at `reconnectMaxMs`).
 *    - 401 from any Bayeux call triggers a single-flight refresh + a
 *      handshake retry within the same attempt. Subsequent 401s in
 *      the same attempt surface as transport failures (caller's
 *      `lookupConnection` is expected to return the rotated auth
 *      after `refreshAuth` persists the new token).
 *    - The replayId per channel is sourced fresh from the shared
 *      tracker on every handshake — the `parseEvents` step on the
 *      webhook funnel side updates the tracker as each event lands,
 *      so the next reconnect picks up exactly where the last event
 *      left off.
 *
 *  Spec: D-130 § A.4 + § Phase 5. */

import {
  SALESFORCE_COMETD_PATH,
  SALESFORCE_ENGAGEMENT_PUSHTOPIC_NAMES,
  SALESFORCE_ENTITY_NAMES,
  SALESFORCE_PUSHTOPIC_CHANNEL_PREFIX,
  SALESFORCE_PUSHTOPIC_NAMES,
  type ConnectionAuth,
  type ConnectionRecord,
  type SalesforceEngagementEntityName,
  type SalesforceRelationshipEntityName,
} from '@recued/contracts';

import type { ConnectionLookup } from '../../housekeeping/reconciliation/vendor-reconciler.js';
import type {
  SalesforceCometDEvent,
  SalesforceReplayIdTracker,
} from './webhook-processor.js';

// ────────────────────────────────────────────────────────────────
// Bayeux protocol channels
// ────────────────────────────────────────────────────────────────

/** Bayeux 1.0 protocol channels. CometD is Bayeux over HTTP long-poll;
 *  Salesforce's Streaming API is the Bayeux server. */
const BAYEUX_HANDSHAKE = '/meta/handshake';
const BAYEUX_CONNECT = '/meta/connect';
const BAYEUX_SUBSCRIBE = '/meta/subscribe';
const BAYEUX_DISCONNECT = '/meta/disconnect';

/** Replay-extension sentinel meaning "from current tip" — used at
 *  first subscribe when the tracker has no recorded replayId for the
 *  channel. After observed events, the tracker's highest replayId
 *  replaces this for reconnect-with-resume semantics. */
const REPLAY_FROM_TIP = -1;

/** Long-poll timeout — Salesforce's CometD endpoint holds /meta/connect
 *  open up to 110s before responding with an empty event set. The
 *  subscriber's per-call timeout sits a hair above to absorb network
 *  jitter without false-positive aborts. */
const DEFAULT_LONG_POLL_TIMEOUT_MS = 120_000;

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

export interface SalesforceCometDSubscriber {
  /** Bring the subscriber online. Resolves once handshake + subscribe
   *  complete (so enrollment-time misconfiguration surfaces in the
   *  caller's await chain). The long-poll loop continues in the
   *  background after this resolves. */
  start(): Promise<void>;
  /** Tear the session down gracefully — abort any in-flight long-poll,
   *  POST /meta/disconnect best-effort, await the loop. Idempotent;
   *  safe to call before `start()` settles. */
  stop(): Promise<void>;
  /** Test-only — current state diagnostic. Production code never reads. */
  state(): SubscriberState;
}

export type SubscriberState =
  | 'idle'
  | 'handshaking'
  | 'subscribing'
  | 'connected'
  | 'reconnecting'
  | 'stopped';

export interface BuildSalesforceCometDSubscriberInput {
  /** User-enrolled connection name. The boot wire instantiates one
   *  subscriber per Salesforce connection. */
  connection_name: string;
  /** Resolve the live connection record. Refetched at every handshake
   *  + after every refresh so config edits + auth rotation surface
   *  on the next attempt. The lookup must return a live record;
   *  `null` shuts the subscriber down (the connection was deleted
   *  out-of-band). */
  lookupConnection: ConnectionLookup;
  /** OAuth refresh hook — fired on 401 from any Bayeux call. Returns
   *  the rotated `ConnectionAuth`; the boot wire wires this to the
   *  connection adapter's existing single-flight refresh path. */
  refreshAuth: (connection: ConnectionRecord) => Promise<ConnectionAuth>;
  /** Shared replayId tracker across the trio. Sourced for replay-
   *  extension headers at subscribe time; updated by the webhook
   *  funnel + processors after each event flows through. */
  replayIdTracker: SalesforceReplayIdTracker;
  /** Per-event delivery callback. The boot wire bridges this into
   *  the webhook funnel (constructing a synthetic `WebhookFunnelInput`
   *  per event so HMAC-skip + dedup-ring + processor dispatch reuse
   *  the same path HubSpot's HTTP webhooks take). Awaited so per-event
   *  errors propagate to the long-poll loop's retry decision; the
   *  loop catches + logs without rethrowing. */
  onEvent: (event: SalesforceCometDEvent) => void | Promise<void>;
  /** HTTP fetcher. Defaults to `globalThis.fetch`. Tests inject a
   *  per-call stub. */
  fetcher?: typeof fetch;
  /** Sleep — used between reconnect-backoff attempts. Defaults to a
   *  setTimeout-promise. Tests pass a deterministic stub. */
  sleep?: (ms: number) => Promise<void>;
  /** Best-effort logger. Production wires to the daemon's structured
   *  log; tests pass a sink to assert lifecycle traces. */
  log?: (
    level: 'info' | 'warn' | 'error',
    message: string,
    meta?: Record<string, unknown>,
  ) => void;
  /** D-139 P1b — engagement entities to subscribe alongside the CRM
   *  trio. The boot wire passes the per-(connection, entity) capability
   *  set filtered to `push_topic_supported = true` AND `available =
   *  true` AND `cdc_supported = false` (PushTopic preferred when CDC
   *  unavailable per § A.4 streaming preference order). When omitted,
   *  the subscriber binds only the CRM trio (D-130 P5 baseline). */
  engagementEntities?: ReadonlyArray<
    SalesforceEngagementEntityName | SalesforceRelationshipEntityName
  >;
  /** Initial reconnect-backoff (ms). Defaults to 1_000. */
  reconnectBaseMs?: number;
  /** Max reconnect-backoff (ms). Defaults to 60_000. */
  reconnectMaxMs?: number;
  /** Long-poll timeout (ms). Defaults to 120_000 (~110s server-side
   *  + jitter buffer). */
  longPollTimeoutMs?: number;
  /** Fired after every successful long-poll response. Production
   *  ignores; tests use it to know when to call `stop()`. */
  onLongPollSettle?: (info: {
    eventCount: number;
    advice?: BayeuxAdvice;
  }) => void;
}

// ────────────────────────────────────────────────────────────────
// Bayeux wire shapes
// ────────────────────────────────────────────────────────────────

interface BayeuxAdvice {
  reconnect?: 'retry' | 'handshake' | 'none';
  interval?: number;
  timeout?: number;
}

interface BayeuxBaseMessage {
  channel: string;
  clientId?: string;
  successful?: boolean;
  error?: string;
  advice?: BayeuxAdvice;
  ext?: Record<string, unknown>;
  id?: string;
}

interface BayeuxHandshakeResponse extends BayeuxBaseMessage {
  channel: '/meta/handshake';
  version?: string;
  supportedConnectionTypes?: ReadonlyArray<string>;
  clientId?: string;
}

interface BayeuxSubscribeResponse extends BayeuxBaseMessage {
  channel: '/meta/subscribe';
  subscription?: string;
}

interface BayeuxEventMessage {
  channel: string;
  data?: unknown;
  ext?: Record<string, unknown>;
}

// ────────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────────

export const buildSalesforceCometDSubscriber = (
  input: BuildSalesforceCometDSubscriberInput,
): SalesforceCometDSubscriber => {
  const fetcher = input.fetcher ?? globalThis.fetch.bind(globalThis);
  const sleep = input.sleep ?? defaultSleep;
  const log = input.log ?? noopLog;
  const reconnectBaseMs = input.reconnectBaseMs ?? 1_000;
  const reconnectMaxMs = input.reconnectMaxMs ?? 60_000;
  const longPollTimeoutMs = input.longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;

  let state: SubscriberState = 'idle';
  let clientId: string | null = null;
  let messageIdSeq = 0;
  let runningAuth: ConnectionAuth | null = null;
  let abortController: AbortController | null = null;
  let loopPromise: Promise<void> | null = null;
  /** Set when stop() is called. Long-poll loop sees this and bails. */
  let stopRequested = false;

  /** Build a stable URL — the connection's `instance_url` (= base_url)
   *  plus the versioned CometD endpoint. Refetched per handshake so a
   *  connection-config edit (e.g. instance_url after sandbox refresh)
   *  takes effect on the next reconnect. */
  const buildEndpoint = (connection: ConnectionRecord): string => {
    const base = connection.config.base_url;
    if (typeof base !== 'string' || base.length === 0) {
      throw new Error(
        `Salesforce connection '${connection.name}' has no config.base_url — cannot subscribe`,
      );
    }
    const trimmed = base.endsWith('/') ? base.slice(0, -1) : base;
    return `${trimmed}${SALESFORCE_COMETD_PATH}`;
  };

  /** Resolve the per-call access token from `runningAuth`. The
   *  long-poll loop refreshes this when the server returns 401; the
   *  `lookupConnection` callback re-pulls before each handshake. */
  const readAccessToken = (
    auth: ConnectionAuth,
    connectionName: string,
  ): string => {
    if (auth.type !== 'oauth2_refresh') {
      throw new Error(
        `Salesforce connection '${connectionName}' is not oauth2_refresh — cannot subscribe`,
      );
    }
    if (
      typeof auth.current_access_token !== 'string' ||
      auth.current_access_token === ''
    ) {
      throw new Error(
        `Salesforce connection '${connectionName}' has no current_access_token — refresh required`,
      );
    }
    return auth.current_access_token;
  };

  /** Post a Bayeux message batch to `endpoint`. Returns the parsed
   *  response array (Bayeux always returns an array, even for a
   *  single-message batch). */
  const postBayeux = async (
    endpoint: string,
    accessToken: string,
    messages: ReadonlyArray<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<BayeuxBaseMessage>> => {
    const fetchOptions: RequestInit = {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(messages),
    };
    if (signal) {
      (fetchOptions as RequestInit & { signal?: AbortSignal }).signal = signal;
    }
    const response = await fetcher(endpoint, fetchOptions);
    if (response.status === 401) {
      throw new BayeuxAuthExpired();
    }
    if (!response.ok) {
      const body = await safeReadText(response);
      throw new BayeuxTransportError(
        `bayeux post returned ${response.status}: ${truncate(body, 200)}`,
      );
    }
    const body = await response.json();
    if (!Array.isArray(body)) {
      throw new BayeuxTransportError('bayeux response was not an array');
    }
    return body as ReadonlyArray<BayeuxBaseMessage>;
  };

  /** /meta/handshake → captures `clientId`. */
  const doHandshake = async (
    endpoint: string,
    accessToken: string,
  ): Promise<string> => {
    const response = await postBayeux(endpoint, accessToken, [
      {
        channel: BAYEUX_HANDSHAKE,
        version: '1.0',
        minimumVersion: '1.0',
        supportedConnectionTypes: ['long-polling'],
        ext: { replay: true },
        id: nextMessageId(),
      },
    ]);
    const ack = response.find(
      (m): m is BayeuxHandshakeResponse => m.channel === BAYEUX_HANDSHAKE,
    );
    if (!ack || ack.successful !== true || typeof ack.clientId !== 'string') {
      throw new BayeuxTransportError(
        `handshake failed: ${ack?.error ?? 'no /meta/handshake ack'}`,
      );
    }
    return ack.clientId;
  };

  /** /meta/subscribe one channel at a time, populating the replay-
   *  extension header from the shared tracker. Salesforce's replay
   *  extension is per-subscription, not per-handshake. */
  const doSubscribe = async (
    endpoint: string,
    accessToken: string,
    activeClientId: string,
  ): Promise<void> => {
    const replayBlock: Record<string, number> = {};
    const channels: string[] = [];
    for (const entity of SALESFORCE_ENTITY_NAMES) {
      const channel = `${SALESFORCE_PUSHTOPIC_CHANNEL_PREFIX}${SALESFORCE_PUSHTOPIC_NAMES[entity]}`;
      channels.push(channel);
      const lastSeen = input.replayIdTracker.getLastReplayId(
        input.connection_name,
        channel,
      );
      replayBlock[channel] = lastSeen ?? REPLAY_FROM_TIP;
    }
    // D-139 P1b — engagement channels widen the subscription surface
    // when the boot wire supplies the per-(connection, entity)
    // PushTopic-streamable list.
    if (input.engagementEntities !== undefined) {
      for (const entity of input.engagementEntities) {
        const channel = `${SALESFORCE_PUSHTOPIC_CHANNEL_PREFIX}${SALESFORCE_ENGAGEMENT_PUSHTOPIC_NAMES[entity]}`;
        channels.push(channel);
        const lastSeen = input.replayIdTracker.getLastReplayId(
          input.connection_name,
          channel,
        );
        replayBlock[channel] = lastSeen ?? REPLAY_FROM_TIP;
      }
    }

    const messages = channels.map((channel) => ({
      channel: BAYEUX_SUBSCRIBE,
      clientId: activeClientId,
      subscription: channel,
      ext: { replay: { [channel]: replayBlock[channel] } },
      id: nextMessageId(),
    }));

    const response = await postBayeux(endpoint, accessToken, messages);
    const acks = response.filter(
      (m): m is BayeuxSubscribeResponse => m.channel === BAYEUX_SUBSCRIBE,
    );
    for (const ack of acks) {
      if (ack.successful !== true) {
        throw new BayeuxTransportError(
          `subscribe failed for '${ack.subscription ?? '?'}': ${ack.error ?? 'no ack'}`,
        );
      }
    }
    if (acks.length < channels.length) {
      throw new BayeuxTransportError(
        `subscribe response missing acks (got ${acks.length}, expected ${channels.length})`,
      );
    }
  };

  /** /meta/connect — the long-poll. Server holds the response open
   *  until events arrive or ~110s elapses. Returns the events parsed
   *  out of the response + the connect-channel advice block (used to
   *  decide reconnect strategy). */
  const doConnect = async (
    endpoint: string,
    accessToken: string,
    activeClientId: string,
    signal: AbortSignal,
  ): Promise<{
    events: ReadonlyArray<SalesforceCometDEvent>;
    advice?: BayeuxAdvice;
  }> => {
    const response = await postBayeux(
      endpoint,
      accessToken,
      [
        {
          channel: BAYEUX_CONNECT,
          clientId: activeClientId,
          connectionType: 'long-polling',
          id: nextMessageId(),
        },
      ],
      signal,
    );

    const events: SalesforceCometDEvent[] = [];
    let advice: BayeuxAdvice | undefined;
    let connectAck: BayeuxBaseMessage | null = null;
    for (const m of response) {
      if (m.channel === BAYEUX_CONNECT) {
        connectAck = m;
        if (m.advice) advice = m.advice;
        continue;
      }
      // Topic event message — coerce into the SalesforceCometDEvent shape
      // for downstream processors.
      const eventMsg = m as BayeuxEventMessage & BayeuxBaseMessage;
      const data = eventMsg.data;
      if (data === null || typeof data !== 'object' || Array.isArray(data)) continue;
      events.push({
        channel: eventMsg.channel,
        data: data as SalesforceCometDEvent['data'],
      });
    }
    if (!connectAck || connectAck.successful !== true) {
      const reason = connectAck?.error ?? 'no /meta/connect ack';
      const handshakeAdvice =
        advice?.reconnect === 'handshake' ? 'reconnect-handshake' : 'unspecified';
      throw new BayeuxConnectFailed(
        `connect failed (${handshakeAdvice}): ${reason}`,
        advice,
      );
    }
    return advice ? { events, advice } : { events };
  };

  /** /meta/disconnect — best-effort. Failures are swallowed (the
   *  connection might already be gone if the user deleted it out-of-
   *  band). */
  const doDisconnect = async (
    endpoint: string,
    accessToken: string,
    activeClientId: string,
  ): Promise<void> => {
    try {
      await postBayeux(endpoint, accessToken, [
        {
          channel: BAYEUX_DISCONNECT,
          clientId: activeClientId,
          id: nextMessageId(),
        },
      ]);
    } catch (e) {
      log('warn', 'cometd-disconnect failed (ignored)', {
        connection: input.connection_name,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  /** Resolve the live connection + auth before each handshake. A null
   *  return shuts the subscriber down (the connection was deleted out-
   *  of-band; the boot wire's delete hook stops us anyway, this is the
   *  defence-in-depth path). */
  const resolveConnection = async (): Promise<{
    record: ConnectionRecord;
    auth: ConnectionAuth;
  } | null> => {
    const record = await input.lookupConnection(input.connection_name);
    if (!record) return null;
    runningAuth = record.auth;
    return { record, auth: record.auth };
  };

  /** Run handshake + subscribe under a single `runningAuth` lifetime,
   *  with a one-shot 401 → refresh retry. Returns the active clientId
   *  on success; throws BayeuxTransportError / BayeuxAuthExpired on
   *  unrecoverable failure. */
  const handshakeAndSubscribe = async (): Promise<{
    record: ConnectionRecord;
    clientId: string;
  }> => {
    const resolved = await resolveConnection();
    if (!resolved) throw new BayeuxStoppedError('connection_not_found');

    let endpoint = buildEndpoint(resolved.record);
    let auth = resolved.auth;
    let refreshed = false;

    while (true) {
      try {
        const accessToken = readAccessToken(auth, input.connection_name);
        const newClientId = await doHandshake(endpoint, accessToken);
        await doSubscribe(endpoint, accessToken, newClientId);
        return { record: resolved.record, clientId: newClientId };
      } catch (e) {
        if (e instanceof BayeuxAuthExpired && !refreshed) {
          refreshed = true;
          auth = await input.refreshAuth(resolved.record);
          runningAuth = auth;
          // Refetch the connection record after refresh — the auth
          // adapter's persist step rotates the access token + the
          // store re-emits the row; the next call observes the
          // freshest config.base_url alongside the rotated token.
          const reread = await input.lookupConnection(input.connection_name);
          if (reread) {
            endpoint = buildEndpoint(reread);
            auth = reread.auth;
            runningAuth = auth;
          }
          continue;
        }
        throw e;
      }
    }
  };

  /** Long-poll loop body — runs until `stopRequested` flips true or
   *  an unrecoverable error trips. Errors fall back into the reconnect
   *  branch in `runForever`. */
  const longPollUntilFailure = async (
    record: ConnectionRecord,
    activeClientId: string,
  ): Promise<void> => {
    const endpoint = buildEndpoint(record);

    while (!stopRequested) {
      abortController = new AbortController();
      const cycleSignal = abortController.signal;

      // Per-cycle timeout. Server holds /meta/connect for ~110s; the
      // local timeout sits at `longPollTimeoutMs` to absorb jitter.
      const cycleTimeout = setTimeoutSafe(() => {
        try { abortController?.abort(); } catch { /* best-effort */ }
      }, longPollTimeoutMs);

      try {
        const auth = runningAuth ?? record.auth;
        const accessToken = readAccessToken(auth, input.connection_name);
        const result = await doConnect(
          endpoint,
          accessToken,
          activeClientId,
          cycleSignal,
        );
        clearTimeoutSafe(cycleTimeout);

        for (const event of result.events) {
          try {
            await input.onEvent(event);
          } catch (e) {
            log('warn', 'cometd-onEvent threw (continuing)', {
              connection: input.connection_name,
              channel: event.channel,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }

        input.onLongPollSettle?.(
          result.advice
            ? { eventCount: result.events.length, advice: result.advice }
            : { eventCount: result.events.length },
        );

        // Server can advise us to handshake again — typical at session
        // expiry or after a server-side restart.
        if (result.advice?.reconnect === 'handshake') {
          throw new BayeuxConnectFailed(
            'server requested handshake',
            result.advice,
          );
        }
      } catch (e) {
        clearTimeoutSafe(cycleTimeout);
        if (stopRequested) return; // abort during stop() — exit cleanly
        throw e;
      } finally {
        abortController = null;
      }
    }
  };

  /** Outer driver — handshake + subscribe + long-poll, restarting on
   *  any error with exponential backoff. Exits when `stopRequested`. */
  const runForever = async (): Promise<void> => {
    let attempts = 0;
    while (!stopRequested) {
      try {
        state = 'handshaking';
        const { record, clientId: newClientId } = await handshakeAndSubscribe();
        clientId = newClientId;
        state = 'connected';
        attempts = 0; // reset backoff after a successful handshake + subscribe
        await longPollUntilFailure(record, newClientId);
      } catch (e) {
        if (e instanceof BayeuxStoppedError) {
          log('info', 'cometd-stopped: connection_not_found', {
            connection: input.connection_name,
          });
          return;
        }
        if (stopRequested) return;
        state = 'reconnecting';
        attempts += 1;
        const backoff = Math.min(
          reconnectBaseMs * Math.pow(2, attempts - 1),
          reconnectMaxMs,
        );
        log('warn', 'cometd-error: backing off', {
          connection: input.connection_name,
          attempts,
          backoff_ms: backoff,
          error: e instanceof Error ? e.message : String(e),
        });
        await sleep(backoff);
      }
    }
  };

  return {
    async start(): Promise<void> {
      if (state !== 'idle') return;
      stopRequested = false;
      // Initial handshake + subscribe surfaces synchronously so
      // enrollment-time misconfiguration (no instance_url, expired
      // refresh token, etc.) lands in the caller's await chain. After
      // that, long-poll runs in the background.
      state = 'handshaking';
      const { record, clientId: newClientId } = await handshakeAndSubscribe();
      clientId = newClientId;
      state = 'connected';

      // Detached long-poll loop — caller doesn't await this. Errors
      // already get logged inside the loop; we add a safety-net catch
      // for the unlikely case that the loop's own try/catch escapes.
      loopPromise = (async () => {
        try {
          await longPollUntilFailure(record, newClientId);
          if (stopRequested) return;
          await runForever();
        } catch (e) {
          if (stopRequested) return;
          // Detached background error — log + restart from runForever
          // so a crashing cycle still resumes after backoff.
          log('error', 'cometd-loop crashed (restarting)', {
            connection: input.connection_name,
            error: e instanceof Error ? e.message : String(e),
          });
          try {
            await runForever();
          } catch (innerE) {
            log('error', 'cometd-loop double-crash (giving up)', {
              connection: input.connection_name,
              error: innerE instanceof Error ? innerE.message : String(innerE),
            });
          }
        }
      })();
    },
    async stop(): Promise<void> {
      if (state === 'stopped') return;
      stopRequested = true;
      try { abortController?.abort(); } catch { /* best-effort */ }

      // Best-effort disconnect — fire-and-forget rather than block on
      // network. A connection that's already been deleted server-side
      // would 401; we don't want stop() to retry on that.
      const activeClientId = clientId;
      const auth = runningAuth;
      if (activeClientId !== null && auth !== null) {
        try {
          const record = await input.lookupConnection(input.connection_name);
          if (record) {
            const endpoint = buildEndpoint(record);
            const token = readAccessToken(auth, input.connection_name);
            await doDisconnect(endpoint, token, activeClientId);
          }
        } catch {
          // Best-effort — connection might already be deleted.
        }
      }

      if (loopPromise) {
        try {
          await loopPromise;
        } catch {
          // Already logged inside the loop.
        }
      }

      state = 'stopped';
      clientId = null;
      runningAuth = null;
      abortController = null;
      loopPromise = null;
    },
    state(): SubscriberState {
      return state;
    },
  };

  function nextMessageId(): string {
    messageIdSeq += 1;
    return String(messageIdSeq);
  }
};

// ────────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────────

class BayeuxAuthExpired extends Error {
  readonly code = 'BAYEUX_AUTH_EXPIRED';
  constructor() {
    super('bayeux 401 — refresh required');
    this.name = 'BayeuxAuthExpired';
  }
}

class BayeuxTransportError extends Error {
  readonly code = 'BAYEUX_TRANSPORT_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'BayeuxTransportError';
  }
}

class BayeuxConnectFailed extends Error {
  readonly code = 'BAYEUX_CONNECT_FAILED';
  readonly advice?: BayeuxAdvice;
  constructor(message: string, advice?: BayeuxAdvice) {
    super(message);
    this.name = 'BayeuxConnectFailed';
    if (advice) this.advice = advice;
  }
}

class BayeuxStoppedError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`subscriber stopped: ${code}`);
    this.name = 'BayeuxStoppedError';
    this.code = code;
  }
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const noopLog: NonNullable<BuildSalesforceCometDSubscriberInput['log']> = () => {};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const safeReadText = async (response: Response): Promise<string> => {
  try {
    return await response.text();
  } catch {
    return '';
  }
};

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;

const setTimeoutSafe = (
  fn: () => void,
  ms: number,
): ReturnType<typeof setTimeout> => setTimeout(fn, ms);

const clearTimeoutSafe = (handle: ReturnType<typeof setTimeout>): void => {
  clearTimeout(handle);
};

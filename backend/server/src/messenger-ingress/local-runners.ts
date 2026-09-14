import { WebSocket } from 'ws';

import { makeBoundedOriginApiFetch } from '../bounded-origin-http-fetcher.js';
import type { MessengerIngressStateStore } from '../storage/messenger-ingress-state-store.js';
import type { MessengerWebhookDispatch } from '../composition/bin/wire-inbound-answer-dispatcher.js';

export type MessengerIngressRunnerState =
  | 'connecting'
  | 'active'
  | 'retrying'
  | 'error'
  | 'stopped';

export interface MessengerLocalIngressRunner {
  start(): void;
  stop(): Promise<void>;
}

export interface WebSocketLike {
  readonly readyState: number;
  on(event: 'open', listener: () => void): this;
  on(event: 'message', listener: (data: unknown) => void): this;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type MessengerWebSocketFactory = (url: string) => WebSocketLike;

interface CommonRunnerOptions {
  connectionName: string;
  credentialFingerprint: string;
  dispatch: MessengerWebhookDispatch;
  stateStore: MessengerIngressStateStore;
  fetchImpl?: typeof fetch;
  webSocketFactory?: MessengerWebSocketFactory;
  onState?: (state: MessengerIngressRunnerState, detail?: string) => void;
  log?: (level: 'info' | 'warn', message: string, data?: Record<string, unknown>) => void;
  random?: () => number;
}

export interface TelegramPollRunnerOptions extends CommonRunnerOptions {
  botToken: string;
  pollTimeoutSeconds?: number;
}

export interface SlackSocketRunnerOptions extends CommonRunnerOptions {
  appToken: string;
}

export interface DiscordGatewayRunnerOptions extends CommonRunnerOptions {
  botToken: string;
  /** The connection's bound `config.channel_id`. Discord is the only vendor
   *  whose protocol has no per-conversation subscription: `GUILD_MESSAGES`
   *  delivers every channel the bot can read in every guild it joined, while
   *  Slack's Socket Mode carries only its subscribed events and a Telegram bot
   *  only sees its own chats. The messenger layer is one bound conversation
   *  (`recipient.field`, enforced at the turn and at live control), so the
   *  surplus is dropped HERE rather than allowed into the layer — a wider
   *  intake is a different product surface with its own consent, not a
   *  side effect of which transport a connection happens to use.
   *
   *  Absent ⇒ no filter, so a row with no bound channel behaves as before. */
  boundChannelId?: string;
}

const WS_OPEN = 1;
const WS_CONNECTING = 0;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const WEBSOCKET_HANDSHAKE_TIMEOUT_MS = 30_000;
const MAX_WEBSOCKET_MESSAGE_BYTES = 1024 * 1024;

class PermanentIngressError extends Error {
  override readonly name = 'PermanentIngressError';
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Runner errors become durable-ish health detail and operator logs. Vendors,
 * fetch shims, and network stacks are allowed to echo request material, so
 * scrub every representation of the credential before surfacing it. */
const redactCredential = (message: string, credential: string): string => {
  const renderings = [credential];
  try { renderings.push(encodeURI(credential)); } catch { /* raw still covered */ }
  try { renderings.push(encodeURIComponent(credential)); } catch { /* raw still covered */ }
  return renderings
    .filter((rendering, index, all) => rendering.length > 0 && all.indexOf(rendering) === index)
    .reduce((redacted, rendering) => redacted.split(rendering).join('***'), message);
};

const retryDelay = (attempt: number, random: () => number): number => {
  const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempt, 5));
  return Math.max(250, Math.floor(ceiling * (0.5 + random() * 0.5)));
};

const waitFor = (ms: number, signal: AbortSignal): Promise<boolean> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted);
      resolve(true);
    }, ms);
    timer.unref?.();
    const aborted = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', aborted, { once: true });
  });

const jsonFromResponse = async (response: Response, label: string): Promise<Record<string, unknown>> => {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${label}: invalid JSON response (${response.status})`);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`${label}: invalid response envelope (${response.status})`);
  }
  return body as Record<string, unknown>;
};

const websocketText = (data: unknown): string | null => {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data) && data.every(Buffer.isBuffer)) {
    return Buffer.concat(data).toString('utf8');
  }
  return null;
};

const defaultWebSocketFactory: MessengerWebSocketFactory = (url) => new WebSocket(url, {
  handshakeTimeout: WEBSOCKET_HANDSHAKE_TIMEOUT_MS,
  maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES,
  perMessageDeflate: false,
});

const providerWebSocketUrl = (
  base: string,
  provider: string,
  allowedRoot: string,
): URL => {
  const url = new URL(base);
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== 'wss:'
    || (url.port !== '' && url.port !== '443')
    || url.username.length > 0
    || url.password.length > 0
    || (hostname !== allowedRoot && !hostname.endsWith(`.${allowedRoot}`))
  ) {
    throw new Error(`${provider} returned an untrusted WebSocket URL`);
  }
  return url;
};

/** Telegram Bot API long polling. Offset advances only after the shared inbound
 * dispatcher resolves, so a storage failure or server pause is retried rather
 * than acknowledged and lost. */
export const createTelegramPollRunner = (
  options: TelegramPollRunnerOptions,
): MessengerLocalIngressRunner => {
  const fetchImpl = options.fetchImpl ?? makeBoundedOriginApiFetch();
  const random = options.random ?? Math.random;
  const timeout = Math.max(1, Math.min(50, options.pollTimeoutSeconds ?? 25));
  const controller = new AbortController();
  let task: Promise<void> | null = null;

  const endpoint = (method: string): string =>
    `https://api.telegram.org/bot${options.botToken}/${method}`;

  const post = async (method: string, body: unknown): Promise<Record<string, unknown>> => {
    const response = await fetchImpl(endpoint(method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const envelope = await jsonFromResponse(response, `Telegram ${method}`);
    if (!response.ok || envelope.ok !== true) {
      const detail = typeof envelope.description === 'string'
        ? envelope.description
        : `http ${response.status}`;
      const ErrorClass = response.status === 401 || response.status === 403
        ? PermanentIngressError
        : Error;
      throw new ErrorClass(`Telegram ${method}: ${detail}`);
    }
    return envelope;
  };

  const run = async (): Promise<void> => {
    let attempt = 0;
    let offset = 0;
    let stateLoaded = false;
    let webhookDeleted = false;
    while (!controller.signal.aborted) {
      try {
        if (!stateLoaded) {
          const saved = options.stateStore.get('telegram', options.connectionName);
          offset = saved?.mode === 'poll'
            && saved.credential_fingerprint === options.credentialFingerprint
            && typeof saved.state.offset === 'number'
            ? Math.max(0, Math.floor(saved.state.offset))
            : 0;
          stateLoaded = true;
        }
        options.onState?.(webhookDeleted ? 'active' : 'connecting');
        if (!webhookDeleted) {
          await post('deleteWebhook', { drop_pending_updates: false });
          webhookDeleted = true;
          // The provider has accepted local polling authority. Do not leave
          // health in `connecting` for the entire first long-poll timeout when
          // an empty queue is the healthy steady state.
          options.onState?.('active');
        }
        const envelope = await post('getUpdates', {
          offset,
          timeout,
          allowed_updates: ['message', 'callback_query'],
        });
        const updates = envelope.result;
        if (!Array.isArray(updates)) throw new Error('Telegram getUpdates: result is not an array');
        options.onState?.('active');
        attempt = 0;
        for (const update of updates) {
          if (controller.signal.aborted) return;
          if (update === null || typeof update !== 'object' || Array.isArray(update)) continue;
          const rawId = (update as Record<string, unknown>).update_id;
          if (typeof rawId !== 'number' || !Number.isSafeInteger(rawId) || rawId < offset) continue;
          await options.dispatch({
            connection_name: options.connectionName,
            payload: update,
            update_id: String(rawId),
          } as Parameters<MessengerWebhookDispatch>[0]);
          const nextOffset = rawId + 1;
          options.stateStore.put({
            vendor: 'telegram',
            connection_name: options.connectionName,
            mode: 'poll',
            credential_fingerprint: options.credentialFingerprint,
            state: { offset: nextOffset },
          });
          // Keep the in-memory cursor behind the durable write. If SQLite is
          // unavailable, the retry must ask Telegram for this update again;
          // sending the advanced offset would acknowledge it remotely without
          // leaving a restart-safe local record.
          offset = nextOffset;
        }
      } catch (error) {
        if (controller.signal.aborted) break;
        const detail = redactCredential(errorMessage(error), options.botToken);
        if (error instanceof PermanentIngressError) {
          options.onState?.('error', detail);
          options.log?.('warn', 'Telegram polling stopped after credential rejection', {
            connection_name: options.connectionName,
            error: detail,
          });
          return;
        }
        options.onState?.('retrying', detail);
        options.log?.('warn', 'Telegram polling failed; retrying', {
          connection_name: options.connectionName,
          error: detail,
        });
        if (!await waitFor(retryDelay(attempt++, random), controller.signal)) break;
      }
    }
    options.onState?.('stopped');
  };

  return {
    start() {
      if (task !== null) return;
      task = run();
    },
    async stop() {
      controller.abort();
      await task;
      options.onState?.('stopped');
    },
  };
};

/** Slack Socket Mode. Every envelope is acknowledged only after the existing
 * inbound dispatcher resolves; a failed dispatch remains eligible for Slack's
 * retry behavior. */
export const createSlackSocketRunner = (
  options: SlackSocketRunnerOptions,
): MessengerLocalIngressRunner => {
  const fetchImpl = options.fetchImpl ?? makeBoundedOriginApiFetch();
  const socketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
  const random = options.random ?? Math.random;
  const controller = new AbortController();
  let socket: WebSocketLike | null = null;
  let task: Promise<void> | null = null;

  const openUrl = async (): Promise<string> => {
    const response = await fetchImpl('https://slack.com/api/apps.connections.open', {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.appToken}` },
      signal: controller.signal,
    });
    const envelope = await jsonFromResponse(response, 'Slack apps.connections.open');
    if (!response.ok || envelope.ok !== true || typeof envelope.url !== 'string') {
      const detail = typeof envelope.error === 'string' ? envelope.error : `http ${response.status}`;
      const permanent = response.status === 401
        || response.status === 403
        || ['invalid_auth', 'not_authed', 'token_revoked', 'account_inactive']
          .includes(detail);
      const ErrorClass = permanent ? PermanentIngressError : Error;
      throw new ErrorClass(`Slack apps.connections.open: ${detail}`);
    }
    const parsed = providerWebSocketUrl(envelope.url, 'Slack', 'slack.com');
    return parsed.toString();
  };

  const connectOnce = async (url: string): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      const ws = socketFactory(url);
      socket = ws;
      let queue = Promise.resolve();
      let settled = false;
      let lastError: Error | null = null;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        socket = null;
        void queue.then(
          () => lastError ? reject(lastError) : resolve(),
          reject,
        );
      };
      ws.on('open', () => options.onState?.('active'));
      ws.on('error', (error) => {
        // Slack's short-lived Socket Mode ticket rides in the WSS URL. Some
        // WebSocket stacks include that URL in connection errors, so scrub the
        // complete URL and every query value before the supervisor persists or
        // logs the detail.
        let detail = redactCredential(errorMessage(error), url);
        try {
          for (const value of new URL(url).searchParams.values()) {
            detail = redactCredential(detail, value);
          }
        } catch { /* URL was already validated by openUrl */ }
        lastError = new Error(detail);
      });
      ws.on('close', finish);
      ws.on('message', (raw) => {
        const text = websocketText(raw);
        if (text === null) return;
        let envelope: Record<string, unknown>;
        try {
          const parsed = JSON.parse(text) as unknown;
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
          envelope = parsed as Record<string, unknown>;
        } catch {
          return;
        }
        if (envelope.type === 'disconnect') {
          ws.close(4000, 'slack refresh requested');
          return;
        }
        const envelopeId = envelope.envelope_id;
        if (typeof envelopeId !== 'string' || envelopeId.length === 0) return;
        queue = queue.then(async () => {
          await options.dispatch({
            connection_name: options.connectionName,
            payload: envelope.payload,
            event_id: typeof (envelope.payload as Record<string, unknown> | null)?.event_id === 'string'
              ? (envelope.payload as Record<string, unknown>).event_id
              : envelopeId,
          } as Parameters<MessengerWebhookDispatch>[0]);
          if (ws.readyState === WS_OPEN) {
            ws.send(JSON.stringify({ envelope_id: envelopeId }));
          }
        }).catch((error) => {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (ws.readyState === WS_OPEN || ws.readyState === WS_CONNECTING) {
            ws.close(4000, 'dispatch failed');
          }
          // `finish()` observes `lastError` after this queue settles. Resolve
          // this recovery link so a real socket whose close event arrives on a
          // later turn never leaves a temporarily unhandled rejection.
        });
      });
      if (controller.signal.aborted) ws.close(1000, 'server stopping');
    });
  };

  const run = async (): Promise<void> => {
    let attempt = 0;
    while (!controller.signal.aborted) {
      try {
        options.onState?.('connecting');
        await connectOnce(await openUrl());
        attempt = 0;
      } catch (error) {
        if (controller.signal.aborted) break;
        const detail = redactCredential(errorMessage(error), options.appToken);
        if (error instanceof PermanentIngressError) {
          options.onState?.('error', detail);
          options.log?.('warn', 'Slack Socket Mode stopped after credential rejection', {
            connection_name: options.connectionName,
            error: detail,
          });
          return;
        }
        options.onState?.('retrying', detail);
        options.log?.('warn', 'Slack Socket Mode disconnected; retrying', {
          connection_name: options.connectionName,
          error: detail,
        });
      }
      if (!controller.signal.aborted) {
        if (!await waitFor(retryDelay(attempt++, random), controller.signal)) break;
      }
    }
    options.onState?.('stopped');
  };

  return {
    start() {
      if (task !== null) return;
      task = run();
    },
    async stop() {
      controller.abort();
      if (socket && (socket.readyState === WS_OPEN || socket.readyState === WS_CONNECTING)) {
        socket.close(1000, 'server stopping');
      }
      await task;
      options.onState?.('stopped');
    },
  };
};

interface DiscordResumeState {
  sequence?: number;
  session_id?: string;
  resume_gateway_url?: string;
}

const readDiscordState = (
  store: MessengerIngressStateStore,
  connectionName: string,
  credentialFingerprint: string,
): DiscordResumeState => {
  const row = store.get('discord', connectionName);
  if (
    row?.mode !== 'socket'
    || row.credential_fingerprint !== credentialFingerprint
  ) return {};
  const state: DiscordResumeState = {};
  if (typeof row.state.sequence === 'number' && Number.isSafeInteger(row.state.sequence)) {
    state.sequence = row.state.sequence;
  }
  if (typeof row.state.session_id === 'string') state.session_id = row.state.session_id;
  if (typeof row.state.resume_gateway_url === 'string') {
    state.resume_gateway_url = row.state.resume_gateway_url;
  }
  return state;
};

const discordGatewayUrl = (base: string): string => {
  // Identify/Resume sends the bot token over this socket. Pin both the API
  // result and persisted READY resume URL to Discord-owned hosts so a corrupt
  // state row cannot turn the client into a credential exfiltration path.
  const url = providerWebSocketUrl(base, 'Discord', 'discord.gg');
  url.searchParams.set('v', '10');
  url.searchParams.set('encoding', 'json');
  return url.toString();
};

const DISCORD_FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const DISCORD_INTENTS = 1 | 512 | 4096 | 32768;

/** Discord Gateway v10 with heartbeat ACK enforcement and resumable sessions.
 * Component interactions are deferred over Discord's HTTP callback immediately,
 * then flow through the same approval dispatcher as the Ed25519 webhook path. */
export const createDiscordGatewayRunner = (
  options: DiscordGatewayRunnerOptions,
): MessengerLocalIngressRunner => {
  const fetchImpl = options.fetchImpl ?? makeBoundedOriginApiFetch();
  const socketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
  const random = options.random ?? Math.random;
  const controller = new AbortController();
  let socket: WebSocketLike | null = null;
  let task: Promise<void> | null = null;
  let resume = readDiscordState(
    options.stateStore,
    options.connectionName,
    options.credentialFingerprint,
  );
  let fatal: string | null = null;
  let requestedRetryDelayMs = 0;

  const persistResume = (next: DiscordResumeState): void => {
    options.stateStore.put({
      vendor: 'discord',
      connection_name: options.connectionName,
      mode: 'socket',
      credential_fingerprint: options.credentialFingerprint,
      state: { ...next },
    });
    // Reconnect in this process must use the same committed cursor a restarted
    // process would read. A failed put must not advance the in-memory cursor.
    resume = next;
  };

  const fetchGateway = async (): Promise<string> => {
    if (resume.resume_gateway_url) {
      try {
        return discordGatewayUrl(resume.resume_gateway_url);
      } catch {
        // A corrupt/obsolete persisted URL must not trap the runner in an
        // endless retry loop. Discard the whole session and obtain a fresh
        // Gateway URL before identifying again.
        resume = {};
        options.stateStore.delete('discord', options.connectionName);
      }
    }
    const response = await fetchImpl('https://discord.com/api/v10/gateway/bot', {
      headers: { Authorization: `Bot ${options.botToken}` },
      signal: controller.signal,
    });
    const envelope = await jsonFromResponse(response, 'Discord gateway/bot');
    if (!response.ok || typeof envelope.url !== 'string') {
      const ErrorClass = response.status === 401 || response.status === 403
        ? PermanentIngressError
        : Error;
      throw new ErrorClass(`Discord gateway/bot: http ${response.status}`);
    }
    const limit = envelope.session_start_limit;
    if (limit !== null && typeof limit === 'object' && !Array.isArray(limit)) {
      const remaining = (limit as Record<string, unknown>).remaining;
      const resetAfter = (limit as Record<string, unknown>).reset_after;
      if (remaining === 0) {
        requestedRetryDelayMs = typeof resetAfter === 'number' && Number.isFinite(resetAfter)
          ? Math.max(1_000, Math.floor(resetAfter))
          : RETRY_MAX_MS;
        throw new Error('Discord identify session-start limit is exhausted');
      }
    }
    return discordGatewayUrl(envelope.url);
  };

  const ackInteraction = async (payload: Record<string, unknown>): Promise<void> => {
    const id = payload.id;
    const token = payload.token;
    if (typeof id !== 'string' || typeof token !== 'string') return;
    let response: Response;
    try {
      response = await fetchImpl(
        `https://discord.com/api/v10/interactions/${encodeURIComponent(id)}/${encodeURIComponent(token)}/callback`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ type: 6 }),
          signal: controller.signal,
        },
      );
    } catch (error) {
      throw new Error(
        `Discord interaction callback: ${redactCredential(errorMessage(error), token)}`,
      );
    }
    if (!response.ok) throw new Error(`Discord interaction callback: http ${response.status}`);
  };

  const connectOnce = async (url: string): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      const ws = socketFactory(url);
      socket = ws;
      let queue = Promise.resolve();
      let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
      let heartbeatInterval = 0;
      let awaitingHeartbeatAck = false;
      // Heartbeats report the latest sequence RECEIVED, while persisted resume
      // state advances only after the corresponding dispatch completes. Keeping
      // those notions separate satisfies the Gateway protocol without turning a
      // crash during dispatch into an acknowledged/lost event.
      let latestReceivedSequence = resume.sequence;
      let lastError: Error | null = null;
      let dispatchFailed = false;
      let settled = false;

      const clearHeartbeat = (): void => {
        if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      };
      const send = (op: number, d: unknown): void => {
        if (ws.readyState !== WS_OPEN) return;
        try {
          ws.send(JSON.stringify({ op, d }));
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          ws.close(4000, 'Gateway send failed');
        }
      };
      const scheduleHeartbeat = (delay: number): void => {
        clearHeartbeat();
        heartbeatTimer = setTimeout(() => {
          if (awaitingHeartbeatAck) {
            lastError = new Error('Discord heartbeat acknowledgement missed');
            ws.close(4000, 'heartbeat ack missed');
            return;
          }
          awaitingHeartbeatAck = true;
          send(1, latestReceivedSequence ?? null);
          scheduleHeartbeat(heartbeatInterval);
        }, delay);
        heartbeatTimer.unref?.();
      };
      const finish = (code: number): void => {
        if (settled) return;
        settled = true;
        clearHeartbeat();
        socket = null;
        // Discord explicitly marks these sessions non-resumable. Retaining
        // their sequence/session tuple would reconnect with RESUME forever and
        // receive the same close code on every attempt.
        if (code === 4007 || code === 4009) {
          resume = {};
          try {
            options.stateStore.delete('discord', options.connectionName);
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
          }
        }
        if (DISCORD_FATAL_CLOSE_CODES.has(code)) {
          fatal = `Discord Gateway closed with fatal code ${code}`;
          lastError = new Error(fatal);
        }
        void queue.then(
          () => lastError ? reject(lastError) : resolve(),
          reject,
        );
      };

      ws.on('open', () => options.onState?.('connecting'));
      ws.on('error', (error) => { lastError = error; });
      ws.on('close', (code) => finish(code));
      ws.on('message', (raw) => {
        const text = websocketText(raw);
        if (text === null) return;
        let envelope: Record<string, unknown>;
        try {
          const parsed = JSON.parse(text) as unknown;
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
          envelope = parsed as Record<string, unknown>;
        } catch {
          return;
        }
        const op = envelope.op;
        if (op === 10) {
          const d = envelope.d;
          if (d === null || typeof d !== 'object') return;
          const interval = (d as Record<string, unknown>).heartbeat_interval;
          if (typeof interval !== 'number' || !Number.isFinite(interval) || interval <= 0) return;
          heartbeatInterval = interval;
          scheduleHeartbeat(Math.floor(interval * random()));
          if (
            resume.session_id !== undefined
            && resume.sequence !== undefined
            && resume.resume_gateway_url !== undefined
          ) {
            send(6, {
              token: options.botToken,
              session_id: resume.session_id,
              seq: resume.sequence,
            });
          } else {
            send(2, {
              token: options.botToken,
              intents: DISCORD_INTENTS,
              properties: { os: process.platform, browser: 'recued', device: 'recued' },
            });
          }
          return;
        }
        if (op === 11) {
          awaitingHeartbeatAck = false;
          return;
        }
        if (op === 1) {
          awaitingHeartbeatAck = true;
          send(1, latestReceivedSequence ?? null);
          return;
        }
        if (op === 7) {
          ws.close(4000, 'Discord requested reconnect');
          return;
        }
        if (op === 9) {
          requestedRetryDelayMs = Math.max(
            requestedRetryDelayMs,
            1_000 + Math.floor(random() * 4_000),
          );
          if (envelope.d !== true) {
            resume = {};
            try {
              options.stateStore.delete('discord', options.connectionName);
            } catch (error) {
              lastError = error instanceof Error ? error : new Error(String(error));
            }
          }
          ws.close(4000, 'Discord invalid session');
          return;
        }
        if (op !== 0) return;
        const sequence = envelope.s;
        const eventType = envelope.t;
        const data = envelope.d;
        if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence)) return;
        latestReceivedSequence = sequence;
        if (data === null || typeof data !== 'object' || Array.isArray(data)) return;
        const payload = data as Record<string, unknown>;
        // READY is the first dispatch on a new session. Keep its identity
        // commit synchronous so an immediate non-resumable close can clear it.
        // RESUMED, in contrast, follows replayed events and is queued below.
        if (eventType === 'READY') {
          try {
            if (typeof payload.session_id !== 'string' || typeof payload.resume_gateway_url !== 'string') {
              throw new Error('Discord READY omitted resume state');
            }
            persistResume({ sequence, session_id: payload.session_id, resume_gateway_url: payload.resume_gateway_url });
            options.onState?.('active');
          } catch (error) {
            dispatchFailed = true;
            lastError = error instanceof Error ? error : new Error(String(error));
            ws.close(4000, 'resume state write failed');
          }
          return;
        }
        // The bound-conversation filter, applied at the ingress boundary so a
        // guild's traffic never enters the messenger layer at all. Interactions
        // are deliberately NOT filtered: one can only exist on a prompt Recued
        // itself posted, and both the live-control press and the ask reply
        // re-gate on the CURRENTLY-bound conversation downstream, which is the
        // check that survives a rebind.
        const shouldDispatch = eventType === 'INTERACTION_CREATE'
          || (eventType === 'MESSAGE_CREATE'
            && (options.boundChannelId === undefined
              || payload.channel_id === options.boundChannelId));

        // Start the 3-second interaction acknowledgement immediately, outside
        // the sequential dispatch queue. Convert rejection to a value now so a
        // slow prior dispatch cannot leave a rejected ack Promise temporarily
        // unhandled while it waits its turn to be logged.
        const ack = eventType === 'INTERACTION_CREATE' && payload.type === 3
          ? ackInteraction(payload).then(
              () => null,
              (error: unknown) => error,
            )
          : Promise.resolve(null);
        void ack.then((ackError) => {
          if (ackError !== null) {
            options.log?.('warn', 'Discord interaction acknowledgement failed', {
              connection_name: options.connectionName,
              error: errorMessage(ackError),
            });
          }
        }).catch(() => undefined);
        queue = queue.then(async () => {
          // A cumulative resume cursor cannot cross a failed admission. The
          // socket close is asynchronous: later messages, filtered events and
          // RESUMED may already be queued when the first dispatch rejects.
          if (dispatchFailed) return;
          // The callback request is already in flight and independently
          // observed above. Business dispatch and its durable sequence fence
          // must not wait up to the HTTP timeout for Discord's empty response.
          // A filtered message still advances the sequence below — it was
          // received and consumed, it simply had no business here.
          if (shouldDispatch) {
            await options.dispatch({
              connection_name: options.connectionName,
              payload,
              interaction_id: typeof payload.id === 'string'
                ? payload.id
                : String(sequence),
            } as Parameters<MessengerWebhookDispatch>[0]);
          }
          persistResume({ ...resume, sequence });
          if (eventType === 'RESUMED') options.onState?.('active');
        }).catch((error) => {
          dispatchFailed = true;
          lastError = error instanceof Error ? error : new Error(String(error));
          if (ws.readyState === WS_OPEN || ws.readyState === WS_CONNECTING) {
            ws.close(4000, 'dispatch failed');
          }
          // `finish()` turns `lastError` into the connectOnce rejection after
          // the socket closes; keep the queue itself observed in the interim.
        });
      });
      if (controller.signal.aborted) ws.close(1000, 'server stopping');
    });
  };

  const run = async (): Promise<void> => {
    let attempt = 0;
    while (!controller.signal.aborted && fatal === null) {
      try {
        options.onState?.('connecting');
        await connectOnce(await fetchGateway());
        attempt = 0;
      } catch (error) {
        if (controller.signal.aborted) break;
        const detail = redactCredential(errorMessage(error), options.botToken);
        if (error instanceof PermanentIngressError) {
          fatal = detail;
          options.onState?.('error', detail);
          options.log?.('warn', 'Discord Gateway stopped after credential rejection', {
            connection_name: options.connectionName,
            error: detail,
          });
          break;
        }
        if (fatal !== null) {
          options.onState?.('error', detail);
          options.log?.('warn', 'Discord Gateway stopped after a fatal close', {
            connection_name: options.connectionName,
            error: detail,
          });
          break;
        }
        options.onState?.('retrying', detail);
        options.log?.('warn', 'Discord Gateway disconnected; retrying', {
          connection_name: options.connectionName,
          error: detail,
        });
      }
      if (!controller.signal.aborted && fatal === null) {
        const delay = Math.max(retryDelay(attempt++, random), requestedRetryDelayMs);
        requestedRetryDelayMs = 0;
        if (!await waitFor(delay, controller.signal)) break;
      }
    }
    if (fatal === null) options.onState?.('stopped');
  };

  return {
    start() {
      if (task !== null) return;
      task = run();
    },
    async stop() {
      controller.abort();
      if (socket && (socket.readyState === WS_OPEN || socket.readyState === WS_CONNECTING)) {
        socket.close(1000, 'server stopping');
      }
      await task;
      // Close code 1000 invalidates the session, so never offer that state to a
      // later process as resumable.
      try {
        options.stateStore.delete('discord', options.connectionName);
      } catch (error) {
        options.log?.('warn', 'Discord resume-state cleanup failed during shutdown', {
          connection_name: options.connectionName,
          error: errorMessage(error),
        });
      }
      options.onState?.('stopped');
    },
  };
};

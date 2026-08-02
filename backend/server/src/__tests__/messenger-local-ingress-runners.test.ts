import { describe, expect, it, vi } from 'vitest';

import {
  createDiscordGatewayRunner,
  createSlackSocketRunner,
  createTelegramPollRunner,
  type WebSocketLike,
} from '../messenger-ingress/local-runners.js';
import type { MessengerIngressStateStore } from '../storage/messenger-ingress-state-store.js';
import type { MessengerWebhookDispatch } from '../composition/bin/wire-inbound-answer-dispatcher.js';

const CREDENTIAL_FINGERPRINT = 'credential-fingerprint-a';

const eventually = async (predicate: () => boolean): Promise<void> => {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('condition was not reached');
};

const memoryState = (): MessengerIngressStateStore => {
  const rows = new Map<string, Parameters<MessengerIngressStateStore['put']>[0]>();
  return {
    get(vendor, connectionName) {
      const row = rows.get(`${vendor}/${connectionName}`);
      return row
        ? { ...row, updated_at: row.updated_at ?? 1 }
        : null;
    },
    put(row) { rows.set(`${row.vendor}/${row.connection_name}`, row); },
    delete(vendor, connectionName) { rows.delete(`${vendor}/${connectionName}`); },
  };
};

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  private listeners = new Map<string, Array<(...args: never[]) => void>>();

  on(event: 'open' | 'message' | 'close' | 'error', listener: (...args: never[]) => void): this {
    const current = this.listeners.get(event) ?? [];
    current.push(listener);
    this.listeners.set(event, current);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args as never[]);
    }
  }

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  message(value: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(value)));
  }

  send(data: string): void { this.sent.push(data); }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', code, Buffer.from(reason));
  }
}

const abortedFetch = (signal: AbortSignal | null | undefined): Promise<Response> =>
  new Promise((_resolve, reject) => {
    const abort = (): void => reject(new DOMException('aborted', 'AbortError'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });

describe('local messenger ingress runners', () => {
  it('Telegram deletes the webhook, dispatches in order, then durably advances offset', async () => {
    const stateStore = memoryState();
    stateStore.put({
      vendor: 'telegram',
      connection_name: 'telegram',
      mode: 'poll',
      credential_fingerprint: 'replaced-credential',
      state: { offset: 9_999 },
    });
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    let request = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      request++;
      if (request === 1) return Response.json({ ok: true, result: true });
      if (request === 2) {
        return Response.json({
          ok: true,
          result: [{ update_id: 41, message: { text: 'hello' } }],
        });
      }
      return abortedFetch(init?.signal);
    });
    const dispatch = vi.fn(async (_event: Parameters<MessengerWebhookDispatch>[0]) => undefined);
    const runner = createTelegramPollRunner({
      connectionName: 'telegram',
      credentialFingerprint: CREDENTIAL_FINGERPRINT,
      botToken: 'bot-token',
      stateStore,
      dispatch,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    runner.start();
    await eventually(() => dispatch.mock.calls.length === 1);
    expect(calls[0]!.url).toContain('/deleteWebhook');
    expect(calls[0]!.body).toEqual({ drop_pending_updates: false });
    expect(calls[1]!.url).toContain('/getUpdates');
    expect(calls[1]!.body).toMatchObject({
      offset: 0,
      allowed_updates: ['message', 'callback_query'],
    });
    expect(dispatch.mock.calls[0]![0]).toMatchObject({
      connection_name: 'telegram',
      update_id: '41',
    });
    expect(stateStore.get('telegram', 'telegram')?.state).toEqual({ offset: 42 });
    expect(stateStore.get('telegram', 'telegram')?.credential_fingerprint)
      .toBe(CREDENTIAL_FINGERPRINT);
    await runner.stop();
  });

  it('Telegram never acknowledges an update past a failed durable cursor write', async () => {
    const durable = memoryState();
    let putCalls = 0;
    const stateStore: MessengerIngressStateStore = {
      get: durable.get,
      delete: durable.delete,
      put(row) {
        putCalls++;
        if (putCalls === 1) throw new Error('sqlite unavailable');
        durable.put(row);
      },
    };
    const pollBodies: Record<string, unknown>[] = [];
    let request = 0;
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      request++;
      if (request === 1) return Response.json({ ok: true, result: true });
      pollBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (request <= 3) {
        return Response.json({
          ok: true,
          result: [{ update_id: 41, message: { text: 'retry me' } }],
        });
      }
      return abortedFetch(init?.signal);
    });
    const dispatch = vi.fn(async (_event: Parameters<MessengerWebhookDispatch>[0]) => undefined);
    const runner = createTelegramPollRunner({
      connectionName: 'telegram',
      credentialFingerprint: CREDENTIAL_FINGERPRINT,
      botToken: 'bot-token',
      stateStore,
      dispatch,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      random: () => 0,
    });

    runner.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 600));
    await eventually(() => dispatch.mock.calls.length === 2);
    expect(pollBodies[0]).toMatchObject({ offset: 0 });
    expect(pollBodies[1]).toMatchObject({ offset: 0 });
    expect(durable.get('telegram', 'telegram')?.state).toEqual({ offset: 42 });
    await runner.stop();
  });

  it('Telegram stops on rejected credentials without leaking the bot token in status', async () => {
    const states: Array<{ state: string; detail?: string }> = [];
    const runner = createTelegramPollRunner({
      connectionName: 'telegram',
      credentialFingerprint: CREDENTIAL_FINGERPRINT,
      botToken: 'secret-bot-token',
      stateStore: memoryState(),
      dispatch: vi.fn(async () => undefined),
      fetchImpl: vi.fn(async () => Response.json(
        { ok: false, description: 'rejected secret-bot-token' },
        { status: 401 },
      )) as unknown as typeof fetch,
      onState: (state, detail) => states.push({ state, ...(detail ? { detail } : {}) }),
    });

    runner.start();
    await eventually(() => states.some(({ state }) => state === 'error'));
    expect(states.at(-1)).toEqual({ state: 'error', detail: 'Telegram deleteWebhook: rejected ***' });
    await runner.stop();
  });

  it('Slack opens Socket Mode and acknowledges only after shared dispatch succeeds', async () => {
    const socket = new FakeSocket();
    let socketCreated = false;
    let release!: () => void;
    const dispatched = new Promise<void>((resolve) => { release = resolve; });
    const dispatch = vi.fn((_event: Parameters<MessengerWebhookDispatch>[0]) => dispatched);
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({
      ok: true,
      url: 'wss://wss-primary.slack.com/link/?ticket=opaque',
    }));
    const runner = createSlackSocketRunner({
      connectionName: 'slack',
      credentialFingerprint: CREDENTIAL_FINGERPRINT,
      appToken: 'xapp-test',
      stateStore: memoryState(),
      dispatch,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      webSocketFactory: () => { socketCreated = true; return socket; },
    });

    runner.start();
    await eventually(() => socketCreated);
    socket.open();
    socket.message({
      envelope_id: 'env-1',
      type: 'events_api',
      payload: { event_id: 'Ev-1', type: 'event_callback', event: { type: 'message' } },
    });
    await eventually(() => dispatch.mock.calls.length === 1);
    expect(socket.sent).toEqual([]);
    release();
    await eventually(() => socket.sent.length === 1);
    expect(JSON.parse(socket.sent[0]!)).toEqual({ envelope_id: 'env-1' });
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer xapp-test' },
    });
    await runner.stop();
  });

  it('Slack refuses a Socket Mode ticket outside Slack-owned WSS hosts', async () => {
    const states: string[] = [];
    const socketFactory = vi.fn(() => new FakeSocket());
    const runner = createSlackSocketRunner({
      connectionName: 'slack',
      credentialFingerprint: CREDENTIAL_FINGERPRINT,
      appToken: 'xapp-test',
      stateStore: memoryState(),
      dispatch: vi.fn(async () => undefined),
      fetchImpl: vi.fn(async () => Response.json({
        ok: true,
        url: 'wss://attacker.example/link/?ticket=stolen',
      })) as unknown as typeof fetch,
      webSocketFactory: socketFactory,
      onState: (state) => states.push(state),
      random: () => 0,
    });

    runner.start();
    await eventually(() => states.includes('retrying'));
    expect(socketFactory).not.toHaveBeenCalled();
    await runner.stop();
  });

  it('Discord identifies, persists READY, dispatches messages, and defers interactions over HTTP', async () => {
    const socket = new FakeSocket();
    let socketCreated = false;
    const stateStore = memoryState();
    const dispatch = vi.fn(async (_event: Parameters<MessengerWebhookDispatch>[0]) => undefined);
    let releaseInteractionAck!: () => void;
    const interactionAck = new Promise<Response>((resolve) => {
      releaseInteractionAck = () => resolve(new Response(null, { status: 204 }));
    });
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/gateway/bot')) {
        return Response.json({ url: 'wss://gateway.discord.gg' });
      }
      if (url.includes('/interactions/I-1/tok/callback')) {
        return interactionAck;
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const runner = createDiscordGatewayRunner({
      connectionName: 'discord',
      credentialFingerprint: CREDENTIAL_FINGERPRINT,
      botToken: 'discord-token',
      stateStore,
      dispatch,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      webSocketFactory: () => { socketCreated = true; return socket; },
      random: () => 1,
    });

    runner.start();
    await eventually(() => socketCreated);
    socket.open();
    socket.message({ op: 10, d: { heartbeat_interval: 60_000 } });
    await eventually(() => socket.sent.length === 1);
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      op: 2,
      d: { token: 'discord-token', intents: 37377 },
    });
    socket.message({
      op: 0,
      t: 'READY',
      s: 10,
      d: { session_id: 'session-1', resume_gateway_url: 'wss://gateway-us-east1-b.discord.gg' },
    });
    expect(stateStore.get('discord', 'discord')?.state).toMatchObject({
      sequence: 10,
      session_id: 'session-1',
    });
    socket.message({
      op: 0,
      t: 'MESSAGE_CREATE',
      s: 11,
      d: { id: 'M-1', channel_id: 'C-1', content: 'hello', author: { id: 'U-1' } },
    });
    socket.message({
      op: 0,
      t: 'INTERACTION_CREATE',
      s: 12,
      d: { id: 'I-1', token: 'tok', type: 3, channel_id: 'C-1', data: {} },
    });
    await eventually(() => dispatch.mock.calls.length === 2);
    // A slow callback response must not hold the actual approval/message
    // dispatch or the sequence cursor behind it.
    expect(dispatch.mock.calls[0]![0]).toMatchObject({ interaction_id: 'M-1' });
    expect(dispatch.mock.calls[1]![0]).toMatchObject({ interaction_id: 'I-1' });
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/interactions/I-1/tok/callback'))).toBe(true);
    await eventually(() => stateStore.get('discord', 'discord')?.state.sequence === 12);
    expect(stateStore.get('discord', 'discord')?.state).toMatchObject({ sequence: 12 });
    releaseInteractionAck();
    await runner.stop();
    expect(stateStore.get('discord', 'discord')).toBeNull();
  });

  it('Discord drops guild traffic outside the bound channel and still advances the cursor', async () => {
    const socket = new FakeSocket();
    let socketCreated = false;
    const stateStore = memoryState();
    const dispatch = vi.fn(async (_event: Parameters<MessengerWebhookDispatch>[0]) => undefined);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/gateway/bot')) return Response.json({ url: 'wss://gateway.discord.gg' });
      if (url.includes('/callback')) return new Response(null, { status: 204 });
      throw new Error(`unexpected URL ${url}`);
    });
    const runner = createDiscordGatewayRunner({
      connectionName: 'discord',
      credentialFingerprint: CREDENTIAL_FINGERPRINT,
      botToken: 'discord-token',
      boundChannelId: 'C-BOUND',
      stateStore,
      dispatch,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      webSocketFactory: () => { socketCreated = true; return socket; },
      random: () => 1,
    });

    runner.start();
    await eventually(() => socketCreated);
    socket.open();
    socket.message({ op: 10, d: { heartbeat_interval: 60_000 } });
    await eventually(() => socket.sent.length === 1);
    socket.message({
      op: 0,
      t: 'READY',
      s: 10,
      d: { session_id: 'session-1', resume_gateway_url: 'wss://gateway-us-east1-b.discord.gg' },
    });

    // The message the Gateway delivers ONLY because the bot can read the
    // channel — the exact payload that would reach the warehouse bus if the
    // filter were gone. `GUILD_MESSAGES` has no per-channel subscription, so
    // this is the arrival every unrelated channel in every joined guild makes.
    socket.message({
      op: 0,
      t: 'MESSAGE_CREATE',
      s: 11,
      d: { id: 'M-OTHER', channel_id: 'C-OTHER', content: 'unrelated', author: { id: 'U-9' } },
    });
    // An interaction is NOT filtered: it can only exist on a prompt Recued
    // posted, and the downstream press path re-gates on the bound conversation.
    socket.message({
      op: 0,
      t: 'INTERACTION_CREATE',
      s: 12,
      d: { id: 'I-1', token: 'tok', type: 3, channel_id: 'C-OTHER', data: {} },
    });
    socket.message({
      op: 0,
      t: 'MESSAGE_CREATE',
      s: 13,
      d: { id: 'M-BOUND', channel_id: 'C-BOUND', content: 'hello', author: { id: 'U-1' } },
    });

    await eventually(() => dispatch.mock.calls.length === 2);
    expect(dispatch.mock.calls[0]![0]).toMatchObject({ interaction_id: 'I-1' });
    expect(dispatch.mock.calls[1]![0]).toMatchObject({ interaction_id: 'M-BOUND' });
    // The filtered message was consumed, not skipped: leaving the sequence at
    // 10 would make every reconnect replay it forever.
    await eventually(() => stateStore.get('discord', 'discord')?.state.sequence === 13);
    // Every message has now drained through the queue, so the unbound one was
    // dropped outright rather than merely arriving later.
    expect(dispatch).toHaveBeenCalledTimes(2);
    await runner.stop();
  });

  it('Discord discards an invalid persisted resume URL and obtains a fresh Gateway URL', async () => {
    const socket = new FakeSocket();
    const stateStore = memoryState();
    stateStore.put({
      vendor: 'discord',
      connection_name: 'discord',
      mode: 'socket',
      credential_fingerprint: CREDENTIAL_FINGERPRINT,
      state: {
        sequence: 8,
        session_id: 'stale-session',
        resume_gateway_url: 'wss://attacker.example',
      },
    });
    const fetchImpl = vi.fn(async () => Response.json({ url: 'wss://gateway.discord.gg' }));
    let socketCreated = false;
    const runner = createDiscordGatewayRunner({
      connectionName: 'discord',
      credentialFingerprint: CREDENTIAL_FINGERPRINT,
      botToken: 'discord-token',
      stateStore,
      dispatch: vi.fn(async () => undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      webSocketFactory: () => { socketCreated = true; return socket; },
    });

    runner.start();
    await eventually(() => socketCreated);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://discord.com/api/v10/gateway/bot',
      expect.objectContaining({ headers: { Authorization: 'Bot discord-token' } }),
    );
    await runner.stop();
  });

  it('Discord converts a synchronous READY state-write failure into a retry', async () => {
    const socket = new FakeSocket();
    const durable = memoryState();
    const stateStore: MessengerIngressStateStore = {
      get: durable.get,
      delete: durable.delete,
      put() { throw new Error('sqlite unavailable'); },
    };
    const states: string[] = [];
    let socketCreated = false;
    const runner = createDiscordGatewayRunner({
      connectionName: 'discord',
      credentialFingerprint: CREDENTIAL_FINGERPRINT,
      botToken: 'discord-token',
      stateStore,
      dispatch: vi.fn(async () => undefined),
      fetchImpl: vi.fn(async () => Response.json({
        url: 'wss://gateway.discord.gg',
      })) as unknown as typeof fetch,
      webSocketFactory: () => { socketCreated = true; return socket; },
      onState: (state) => states.push(state),
      random: () => 0,
    });

    runner.start();
    await eventually(() => socketCreated);
    socket.open();
    socket.message({ op: 10, d: { heartbeat_interval: 60_000 } });
    expect(() => socket.message({
      op: 0,
      t: 'READY',
      s: 1,
      d: {
        session_id: 'session-1',
        resume_gateway_url: 'wss://gateway.discord.gg',
      },
    })).not.toThrow();
    await eventually(() => states.includes('retrying'));
    expect(socket.readyState).toBe(3);
    await runner.stop();
  });

  it('Discord discards a non-resumable session before reconnecting with IDENTIFY', async () => {
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const sockets = [firstSocket, secondSocket];
    const socketUrls: string[] = [];
    const stateStore = memoryState();
    stateStore.put({
      vendor: 'discord',
      connection_name: 'discord',
      mode: 'socket',
      credential_fingerprint: CREDENTIAL_FINGERPRINT,
      state: {
        sequence: 8,
        session_id: 'expired-session',
        resume_gateway_url: 'wss://gateway-us-east1-b.discord.gg',
      },
    });
    const fetchImpl = vi.fn(async () => Response.json({ url: 'wss://gateway.discord.gg' }));
    const runner = createDiscordGatewayRunner({
      connectionName: 'discord',
      credentialFingerprint: CREDENTIAL_FINGERPRINT,
      botToken: 'discord-token',
      stateStore,
      dispatch: vi.fn(async () => undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      webSocketFactory: (url) => {
        socketUrls.push(url);
        const socket = sockets.shift();
        if (!socket) throw new Error('unexpected extra socket');
        return socket;
      },
      random: () => 0,
    });

    runner.start();
    await eventually(() => socketUrls.length === 1);
    expect(socketUrls[0]).toContain('gateway-us-east1-b.discord.gg');
    firstSocket.open();
    firstSocket.message({ op: 10, d: { heartbeat_interval: 60_000 } });
    await eventually(() => firstSocket.sent.length === 1);
    expect(JSON.parse(firstSocket.sent[0]!)).toMatchObject({ op: 6 });

    firstSocket.close(4009, 'session timed out');
    expect(stateStore.get('discord', 'discord')).toBeNull();
    await new Promise<void>((resolve) => setTimeout(resolve, 550));
    await eventually(() => socketUrls.length === 2);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://discord.com/api/v10/gateway/bot',
      expect.objectContaining({ headers: { Authorization: 'Bot discord-token' } }),
    );
    expect(socketUrls[1]).toContain('gateway.discord.gg');
    secondSocket.open();
    secondSocket.message({ op: 10, d: { heartbeat_interval: 60_000 } });
    await eventually(() => secondSocket.sent.length === 1);
    expect(JSON.parse(secondSocket.sent[0]!)).toMatchObject({ op: 2 });
    await runner.stop();
  });

  it('Discord treats rejected bot credentials as terminal instead of retrying forever', async () => {
    const states: string[] = [];
    const fetchImpl = vi.fn(async () => Response.json(
      { message: '401: Unauthorized' },
      { status: 401 },
    ));
    const runner = createDiscordGatewayRunner({
      connectionName: 'discord',
      credentialFingerprint: CREDENTIAL_FINGERPRINT,
      botToken: 'bad-token',
      stateStore: memoryState(),
      dispatch: vi.fn(async () => undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      webSocketFactory: () => { throw new Error('socket must not be opened'); },
      onState: (state) => states.push(state),
    });

    runner.start();
    await eventually(() => states.includes('error'));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toBe('error');
    await runner.stop();
  });
});

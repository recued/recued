import dns from 'node:dns';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { getJson, postJson } from '../http.js';
import { sendTelegramAttachment } from '../attachments.js';
import {
  createDiscordTransport, createSlackTransport, createTeamsTransport, createTelegramTransport,
  createWhatsAppTransport, type Transport,
} from '../index.js';

const listen = (server: Server) => new Promise<number>(done =>
  server.listen(0, '127.0.0.1', () => done((server.address() as { port: number }).port)));
const close = (server: Server) => new Promise<void>(done => server.close(() => done()));
/** A real refused connection: a port that was just free. */
const refusedPort = async () => { const server = createServer(); const port = await listen(server); await close(server); return port; };
/** Every vendor URL goes to the local port instead, through the real fetch. */
const localFetch = (port: number): typeof fetch => (_input, init) => fetch(`http://127.0.0.1:${port}/`, init);

describe('transport JSON HTTP lifecycle', () => {
  it('requires native fetch to refuse redirects on credential-bearing control calls', async () => {
    const fetchImpl = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => new Response(null, {
      status: 307,
      headers: { location: 'https://collector.invalid/steal' },
    }));

    const outcome = await postJson('https://slack.com/api/chat.postMessage', {
      headers: { authorization: 'Bearer SECRET-bot-token' },
      body: '{"text":"launch"}',
      timeoutMs: 1_000,
      fetchImpl,
    });

    expect(outcome).toMatchObject({ ok: false, kind: 'http_error', status: 307 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      redirect: 'error',
    });
  });

  it('cancels a length-less success body as soon as it crosses the cap', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(3));
      },
      cancel() {
        cancelled = true;
      },
    });

    const outcome = await postJson('https://api.telegram.org/botSECRET/sendMessage', {
      headers: {},
      body: '{}',
      timeoutMs: 1_000,
      maxResponseBytes: 4,
      fetchImpl: async () => new Response(body),
    });

    expect(outcome).toEqual({
      ok: false,
      kind: 'network',
      detail: 'response body exceeded 4 bytes',
    });
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it('rejects a declared oversized body and releases it unread', async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel });

    const outcome = await getJson('https://graph.facebook.com/v22.0/media', {
      timeoutMs: 1_000,
      maxResponseBytes: 8,
      fetchImpl: async () => new Response(body, {
        headers: { 'content-length': '9' },
      }),
    });

    expect(outcome).toEqual({
      ok: false,
      kind: 'network',
      detail: 'response body exceeded 8 bytes',
    });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    // Node may pre-pull one chunk while constructing the stream, before the
    // Response consumer sees Content-Length. The reader itself never opens.
    expect(pull.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('keeps the deadline active while a success body stalls', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetchImpl: typeof fetch = async (_input, init) => {
        signal = init?.signal ?? undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const abort = (): void => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              controller.error(error);
            };
            if (signal?.aborted) abort();
            else signal?.addEventListener('abort', abort, { once: true });
          },
        });
        return new Response(body);
      };

      const pending = postJson('https://discord.com/api/v10/channels/1/messages', {
        headers: { authorization: 'Bot SECRET-token' },
        body: '{}',
        timeoutMs: 20,
        fetchImpl,
      });
      await vi.advanceTimersByTimeAsync(20);

      await expect(pending).resolves.toEqual({
        ok: false,
        kind: 'timeout',
        detail: 'response body read timed out after 20ms',
      });
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds and releases error bodies while preserving the HTTP classification', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(5));
      },
      cancel() {
        cancelled = true;
      },
    });

    const outcome = await postJson('https://slack.com/api/chat.postMessage', {
      headers: {},
      body: '{}',
      timeoutMs: 1_000,
      maxResponseBytes: 8,
      fetchImpl: async () => new Response(body, {
        status: 500,
        statusText: 'Internal Server Error',
      }),
    });

    expect(outcome).toEqual({
      ok: false,
      kind: 'http_error',
      status: 500,
      detail: '500 Internal Server Error',
    });
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it('fails closed on an invalid trusted response ceiling without touching the network', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'));

    const outcome = await postJson('https://slack.com/api/chat.postMessage', {
      headers: {},
      body: '{}',
      timeoutMs: 1_000,
      maxResponseBytes: 0,
      fetchImpl,
    });

    expect(outcome).toEqual({
      ok: false,
      kind: 'network',
      detail: 'response body limit must be a positive safe integer',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('marks a connection that never opened as not sent, and a connection dropped mid-request as maybe sent', async () => {
    const options = { headers: {}, body: '{}', timeoutMs: 5_000 };
    await expect(postJson('https://api.telegram.org/botSECRET/sendMessage', { ...options, fetchImpl: localFetch(await refusedPort()) }))
      .resolves.toMatchObject({ ok: false, kind: 'network', not_sent: true });

    const dropping = createServer(socket => socket.once('data', () => socket.destroy()));
    const port = await listen(dropping);
    try {
      const outcome = await postJson('https://api.telegram.org/botSECRET/sendMessage', { ...options, fetchImpl: localFetch(port) });
      expect(outcome).toMatchObject({ ok: false, kind: 'network' });
      expect(outcome).not.toHaveProperty('not_sent');
    } finally { await close(dropping); }
  });

  it('marks a name that does not resolve as not sent, through the real fetch', async () => {
    // This machine's resolver answers every name, so the lookup is made to fail. A
    // reserved `.invalid` host keeps a lookup that slipped through from reaching anyone.
    const lookup = vi.spyOn(dns, 'lookup').mockImplementation(((host: string, options: unknown, callback?: (error: Error) => void) => {
      const done = typeof options === 'function' ? options as (error: Error) => void : callback!;
      process.nextTick(() => done(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: host })));
    }) as unknown as typeof dns.lookup);
    try {
      await expect(postJson('https://name-check.invalid/send', { headers: {}, body: '{}', timeoutMs: 5_000, fetchImpl: fetch }))
        .resolves.toMatchObject({ ok: false, kind: 'network', not_sent: true });
      expect(lookup).toHaveBeenCalled();
    } finally { lookup.mockRestore(); }
  });

  it.each([
    { name: 'Slack', send: (fetchImpl: typeof fetch): Transport => createSlackTransport({ fetchImpl }) },
    { name: 'Telegram', send: (fetchImpl: typeof fetch): Transport => createTelegramTransport({ fetchImpl }) },
    { name: 'Discord', send: (fetchImpl: typeof fetch): Transport => createDiscordTransport({ fetchImpl }), recipient: '987654321098765432' },
    { name: 'Teams', send: (fetchImpl: typeof fetch): Transport => createTeamsTransport({ fetchImpl }), recipient: '19:abc@thread.v2' },
    { name: 'WhatsApp', send: (fetchImpl: typeof fetch): Transport => createWhatsAppTransport({ fetchImpl }), recipient: '123456789012345/16505551234' },
  ])('$name reports a refused connection as not sent', async ({ send, recipient }) => {
    const transport = send(localFetch(await refusedPort()));
    await expect(transport.send({ recipient: recipient ?? 'dest', token: 'token', text: 'hello' }))
      .resolves.toMatchObject({ ok: false, error: { kind: 'network', not_sent: true } });
  });

  it('reports a refused attachment upload as not sent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'not-sent-'));
    const path = join(dir, 'note.txt');
    await writeFile(path, 'hello');
    try {
      await expect(sendTelegramAttachment({ recipient: '42', token: 'token', path, size: 5, mime_type: 'text/plain', filename: 'note.txt' },
        { fetchImpl: localFetch(await refusedPort()), timeoutMs: 5_000 }))
        .resolves.toMatchObject({ ok: false, error: { kind: 'network', not_sent: true } });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

/** D-196 v1.x — SSE streaming on the OpenAI-compatible llm_gateway door.
 *
 *  Two harnesses on purpose. The fake response proves the frame sequence and
 *  the keep-alive / disconnect logic without a socket. The real `http` server
 *  proves what a fake cannot: that the headers and the first keep-alive reach
 *  a real client BEFORE the provider has answered, through Node's actual
 *  chunked encoding, and that a spec-conformant SSE parser (comment lines
 *  dropped, `data:` accumulated, blank-line dispatch, `[DONE]`) reassembles the
 *  answer. ⚠ The parser is written to the SSE spec rather than borrowed from
 *  the `openai` package, which is not a dependency of this repo; its rules are
 *  the ones openai-node's `SSEDecoder` and the Python SDK apply. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpInboundTokenRecord } from '@recued/contracts';
import { LLMError, type LLMConfig } from '@recued/llm';

import { ChatContextLengthError } from '../chat-turn-executor.js';
import {
  createLlmGatewayPortHandler,
  type LlmGatewayCompletionProvider,
  type LlmGatewayHandlerDeps,
} from '../ports/llm-gateway/handler.js';
import {
  completionStreamFrames,
  errorStreamFrame,
  openLlmGatewayStream,
  splitStreamContent,
  SSE_DONE,
  SSE_KEEPALIVE,
  type LlmGatewayStreamTimers,
} from '../ports/llm-gateway/streaming.js';

const NOW = 1_720_000_000_000;

const makeToken = (overrides: Partial<McpInboundTokenRecord> = {}): McpInboundTokenRecord => ({
  token_id: 'inbound-token-1',
  bearer_hash: 'hash',
  label: 'External door',
  created_at: 1_000,
  revoked_at: null,
  grants: {},
  concurrency_tier: 3,
  chat_mode: null,
  contract_id: 'ct_customer_1',
  updated_at: 1_000,
  ...overrides,
});

const baseConfig = (): LLMConfig => ({
  llm_gateway_default_route: 'slot:slot_1',
  llm_gateway_model_alias: 'seller-primary',
  slot_1: {
    provider: 'openai',
    model: 'gpt-4o-mini',
    api_key: 'sk-test',
    speed: 'fast',
    supports_json: true,
    context_window_tokens: 128_000,
  },
});

const ANSWER = 'Hello from the seller model. This answer is long enough to be cut into more than one frame, so a client can paint it as it arrives.';

const makeProvider = (
  impl?: LlmGatewayCompletionProvider['complete'],
): LlmGatewayCompletionProvider => ({
  complete: vi.fn(impl ?? (async () => ({
    id: 'chatcmpl_test',
    content: ANSWER,
    usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
  }))),
});

const makeDeps = (provider: LlmGatewayCompletionProvider): LlmGatewayHandlerDeps => ({
  inboundTokenStore: { verifyBearer: vi.fn(() => makeToken()) },
  contractOverlay: {
    isContractLive: vi.fn(() => true),
    permitsDoorType: vi.fn(() => true),
  },
  getLlmConfig: vi.fn(() => baseConfig()),
  completionProvider: provider,
  now: () => NOW,
});

const makeBody = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    model: 'seller-primary',
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  });

const buildReq = (body: string): IncomingMessage => {
  const stream = Readable.from([Buffer.from(body, 'utf8')]) as unknown as IncomingMessage;
  (stream as unknown as { url: string }).url = '/v1/chat/completions';
  (stream as unknown as { method: string }).method = 'POST';
  (stream as unknown as { headers: Record<string, string> }).headers = {
    authorization: 'Bearer bearer-1',
  };
  return stream;
};

/** The subset of `ServerResponse` the streaming path touches, recording every
 *  write so the wire can be read back as one string. `end()` emits `close`
 *  afterwards, as Node does, so the "close before end means the client left"
 *  distinction is exercised rather than assumed. */
class FakeStreamRes {
  statusCode = 0;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  flushed = 0;
  destroyed = false;
  private ended = false;
  private listeners = new Map<string, Array<() => void>>();

  get writableEnded(): boolean { return this.ended; }
  get body(): string { return this.chunks.join(''); }
  setHeader(key: string, value: string): void { this.headers[key.toLowerCase()] = value; }
  getHeader(key: string): string | undefined { return this.headers[key.toLowerCase()]; }
  flushHeaders(): void { this.flushed += 1; }
  write(chunk: string): boolean {
    if (this.ended) throw new Error('write after end');
    this.chunks.push(chunk);
    return true;
  }
  end(body?: string): void {
    if (body !== undefined) this.chunks.push(body);
    this.ended = true;
    this.emit('close');
  }
  on(event: string, fn: () => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(fn);
    this.listeners.set(event, list);
  }
  once(event: string, fn: () => void): void { this.on(event, fn); }
  emit(event: string): void {
    const list = this.listeners.get(event) ?? [];
    this.listeners.set(event, []);
    for (const fn of list) fn();
  }
}

const asRes = (res: FakeStreamRes): ServerResponse => res as unknown as ServerResponse;

/** SSE per the WHATWG spec: a line starting with `:` is a comment and is
 *  dropped; `data:` values accumulate; a blank line dispatches. */
const parseSse = (text: string): string[] => {
  const events: string[] = [];
  let data: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line === '') {
      if (data.length > 0) events.push(data.join('\n'));
      data = [];
      continue;
    }
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
  }
  if (data.length > 0) events.push(data.join('\n'));
  return events;
};

type Chunk = {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{ index: number; delta: Record<string, unknown>; finish_reason: string | null }>;
  usage?: unknown;
  recued_outcome?: unknown;
  error?: { message: string; type: string; code: string };
};

const parseChunks = (text: string): Array<Chunk | '[DONE]'> =>
  parseSse(text).map((event) => (event === '[DONE]' ? '[DONE]' : JSON.parse(event) as Chunk));

const assembled = (chunks: ReadonlyArray<Chunk | '[DONE]'>): string =>
  chunks
    .filter((c): c is Chunk => c !== '[DONE]')
    .map((c) => (typeof c.choices[0]?.delta.content === 'string' ? c.choices[0].delta.content : ''))
    .join('');

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
};

afterEach(() => {
  vi.useRealTimers();
});

describe('splitStreamContent', () => {
  it('joins back to the original and never cuts a word when the window holds whitespace', () => {
    const pieces = splitStreamContent(ANSWER, 20);
    expect(pieces.join('')).toBe(ANSWER);
    for (const piece of pieces.slice(0, -1)) {
      expect(piece.length).toBeLessThanOrEqual(20);
      // A boundary keeps the whitespace with the piece before it.
      expect(/\s$/.test(piece)).toBe(true);
    }
  });

  it('returns nothing for empty content and hard-splits a word longer than the window', () => {
    expect(splitStreamContent('')).toEqual([]);
    const word = 'x'.repeat(25);
    expect(splitStreamContent(word, 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  });

  it('never leaves a lone high surrogate at the end of a piece', () => {
    const content = `${'a'.repeat(9)}😀tail`;
    const pieces = splitStreamContent(content, 10);
    expect(pieces.join('')).toBe(content);
    for (const piece of pieces) {
      const last = piece.charCodeAt(piece.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });
});

describe('completionStreamFrames', () => {
  const frame = { id: 'chatcmpl_x', created: 1_720_000_000, model: 'seller-primary' };
  const usage = { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 };

  it('emits role, content pieces, finish, then [DONE], with no usage chunk unless asked', () => {
    const frames = completionStreamFrames(frame, {
      content: ANSWER, finish_reason: 'stop', usage, include_usage: false, chunk_chars: 40,
    });
    expect(frames[frames.length - 1]).toBe(SSE_DONE);
    const chunks = parseChunks(frames.join(''));
    const first = chunks[0] as Chunk;
    expect(first.choices[0]?.delta).toEqual({ role: 'assistant', content: '' });
    expect(first).toMatchObject({ id: 'chatcmpl_x', object: 'chat.completion.chunk', model: 'seller-primary' });
    expect(assembled(chunks)).toBe(ANSWER);
    const finish = chunks[chunks.length - 2] as Chunk;
    expect(finish.choices[0]?.finish_reason).toBe('stop');
    expect(chunks.filter((c) => c !== '[DONE]' && (c as Chunk).usage !== undefined)).toHaveLength(0);
    expect(chunks.length).toBeGreaterThan(4);
  });

  it('mirrors OpenAI exactly when usage is requested: usage null everywhere, then one usage chunk with empty choices', () => {
    const frames = completionStreamFrames(frame, {
      content: 'short', finish_reason: 'length', usage, include_usage: true, recued_outcome: { held: true },
    });
    const chunks = parseChunks(frames.join('')).filter((c): c is Chunk => c !== '[DONE]');
    const usageChunk = chunks[chunks.length - 1]!;
    expect(usageChunk.choices).toEqual([]);
    expect(usageChunk.usage).toEqual(usage);
    for (const c of chunks.slice(0, -1)) expect(c.usage).toBeNull();
    const finish = chunks[chunks.length - 2]!;
    expect(finish.choices[0]?.finish_reason).toBe('length');
    expect(finish.recued_outcome).toEqual({ held: true });
  });

  it('shapes an in-band error the way the SDKs raise on', () => {
    expect(parseChunks(errorStreamFrame({ message: 'boom', type: 'server_error', code: 'x' }))[0])
      .toEqual({ error: { message: 'boom', type: 'server_error', code: 'x' } });
  });
});

describe('openLlmGatewayStream', () => {
  const fakeTimers = () => {
    const calls: { set: number; cleared: number; tick?: () => void } = { set: 0, cleared: 0 };
    const timers: LlmGatewayStreamTimers = {
      setInterval: (fn) => { calls.set += 1; calls.tick = fn; return 'handle'; },
      clearInterval: () => { calls.cleared += 1; },
    };
    return { timers, calls };
  };

  it('sends the headers and a keep-alive at once, ticks keep-alives, and ends after the frames', () => {
    const res = new FakeStreamRes();
    const { timers, calls } = fakeTimers();
    const stream = openLlmGatewayStream(asRes(res), { timers });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(res.flushed).toBe(1);
    expect(res.chunks).toEqual([SSE_KEEPALIVE]);
    calls.tick?.();
    expect(res.chunks).toEqual([SSE_KEEPALIVE, SSE_KEEPALIVE]);

    stream.complete({ id: 'c', created: 1, model: 'm' }, {
      content: 'hi', finish_reason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, include_usage: false,
    });
    expect(res.writableEnded).toBe(true);
    expect(calls.cleared).toBe(1);
    expect(res.body.endsWith(SSE_DONE)).toBe(true);
    const before = res.chunks.length;
    stream.fail({ message: 'late', type: 'server_error', code: 'x' });
    expect(res.chunks).toHaveLength(before);
  });

  it('stops writing once the client has gone, and does not end a closed response', () => {
    const res = new FakeStreamRes();
    const { timers, calls } = fakeTimers();
    const stream = openLlmGatewayStream(asRes(res), { timers });
    res.emit('close');
    expect(stream.clientGone()).toBe(true);
    expect(calls.cleared).toBe(1);
    const before = res.chunks.length;
    stream.complete({ id: 'c', created: 1, model: 'm' }, {
      content: 'hi', finish_reason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, include_usage: false,
    });
    expect(res.chunks).toHaveLength(before);
    expect(res.writableEnded).toBe(false);
  });
});

describe('createLlmGatewayPortHandler with stream: true', () => {
  it('answers as text/event-stream chunks that reassemble to the completion, ending with [DONE]', async () => {
    const provider = makeProvider();
    const handler = createLlmGatewayPortHandler(makeDeps(provider));
    const res = new FakeStreamRes();

    await handler(buildReq(makeBody({ stream: true })), asRes(res));

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-cache, no-transform');
    expect(res.chunks[0]).toBe(SSE_KEEPALIVE);
    expect(res.writableEnded).toBe(true);
    const chunks = parseChunks(res.body);
    expect(chunks[chunks.length - 1]).toBe('[DONE]');
    expect(assembled(chunks)).toBe(ANSWER);
    const first = chunks[0] as Chunk;
    expect(first).toMatchObject({
      id: 'chatcmpl_test',
      object: 'chat.completion.chunk',
      created: Math.floor(NOW / 1000),
      model: 'seller-primary',
    });
    expect(first.choices[0]?.delta).toEqual({ role: 'assistant', content: '' });
    expect((chunks[chunks.length - 2] as Chunk).choices[0]?.finish_reason).toBe('stop');
    expect(chunks.some((c) => c !== '[DONE]' && (c as Chunk).usage !== undefined)).toBe(false);
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it('adds the usage chunk when stream_options.include_usage is set, from the provider report', async () => {
    const handler = createLlmGatewayPortHandler(makeDeps(makeProvider()));
    const res = new FakeStreamRes();

    await handler(buildReq(makeBody({ stream: true, stream_options: { include_usage: true } })), asRes(res));

    const chunks = parseChunks(res.body).filter((c): c is Chunk => c !== '[DONE]');
    const usageChunk = chunks[chunks.length - 1]!;
    expect(usageChunk.choices).toEqual([]);
    expect(usageChunk.usage).toEqual({ prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 });
  });

  it('still refuses a malformed stream field with a status code, before anything is written', async () => {
    const provider = makeProvider();
    const handler = createLlmGatewayPortHandler(makeDeps(provider));
    for (const body of [
      makeBody({ stream: 'yes' }),
      makeBody({ stream_options: { include_usage: true } }),
      makeBody({ stream: true, stream_options: 'all' }),
      makeBody({ stream: true, stream_options: { include_usage: 1 } }),
    ]) {
      const res = new FakeStreamRes();
      await handler(buildReq(body), asRes(res));
      expect(res.statusCode).toBe(400);
      expect(res.headers['content-type']).toContain('application/json');
      expect((JSON.parse(res.body) as { error: { code: string } }).error.code).toBe('bad_request');
    }
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('leaves the JSON shape untouched for stream: false', async () => {
    const handler = createLlmGatewayPortHandler(makeDeps(makeProvider()));
    const res = new FakeStreamRes();
    await handler(buildReq(makeBody({ stream: false })), asRes(res));
    expect(res.headers['content-type']).toContain('application/json');
    const body = JSON.parse(res.body) as { object: string; choices: Array<{ message: { content: string } }> };
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0]?.message.content).toBe(ANSWER);
  });

  it('turns a provider failure after the headers into an in-band error event with the JSON path\'s own mapping', async () => {
    const cases: Array<[unknown, string]> = [
      [new Error('upstream exploded'), 'llm_gateway_provider_failed'],
      [new ChatContextLengthError(), 'context_length_exceeded'],
      [new LLMError('AI_TOKEN_BUDGET_EXCEEDED', 'over budget'), 'context_length_exceeded'],
    ];
    for (const [error, code] of cases) {
      const handler = createLlmGatewayPortHandler(makeDeps(makeProvider(async () => { throw error; })));
      const res = new FakeStreamRes();
      await handler(buildReq(makeBody({ stream: true })), asRes(res));
      expect(res.statusCode).toBe(200);
      expect(res.writableEnded).toBe(true);
      const chunks = parseChunks(res.body);
      expect(chunks).toHaveLength(1);
      expect((chunks[0] as Chunk).error?.code).toBe(code);
      expect(res.body.includes('[DONE]')).toBe(false);
    }
  });

  it('keeps the connection alive with comment lines while the governed turn is still running', async () => {
    vi.useFakeTimers();
    const pending = deferred<{ id: string; content: string }>();
    const handler = createLlmGatewayPortHandler(makeDeps(makeProvider(() => pending.promise)));
    const res = new FakeStreamRes();

    const done = handler(buildReq(makeBody({ stream: true })), asRes(res));
    await vi.advanceTimersByTimeAsync(0);
    expect(res.chunks).toEqual([SSE_KEEPALIVE]);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(res.chunks.filter((c) => c === SSE_KEEPALIVE).length).toBeGreaterThanOrEqual(3);
    expect(res.writableEnded).toBe(false);

    pending.resolve({ id: 'chatcmpl_slow', content: 'finally' });
    await done;
    expect(res.writableEnded).toBe(true);
    const chunks = parseChunks(res.body);
    expect(assembled(chunks)).toBe('finally');
    expect(chunks[chunks.length - 1]).toBe('[DONE]');
  });

  it('lets the turn finish but writes nothing more once the client disconnected mid-turn', async () => {
    const pending = deferred<{ id: string; content: string }>();
    const provider = makeProvider(() => pending.promise);
    const handler = createLlmGatewayPortHandler(makeDeps(provider));
    const res = new FakeStreamRes();

    const done = handler(buildReq(makeBody({ stream: true })), asRes(res));
    await flush();
    expect(res.chunks).toEqual([SSE_KEEPALIVE]);
    res.emit('close');
    pending.resolve({ id: 'chatcmpl_gone', content: 'nobody is listening' });
    await done;

    expect(res.chunks).toEqual([SSE_KEEPALIVE]);
    expect(res.writableEnded).toBe(false);
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });
});

describe('over a real http server', () => {
  let server: Server | undefined;
  afterEach(async () => {
    const s = server;
    server = undefined;
    if (s) {
      s.closeAllConnections();
      await new Promise<void>((resolve) => { s.close(() => resolve()); });
    }
  });

  it('delivers the headers and the first keep-alive before the provider answers, then a parseable stream', async () => {
    const pending = deferred<{ id: string; content: string; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }>();
    let providerCalled = false;
    const provider = makeProvider(() => { providerCalled = true; return pending.promise; });
    const handler = createLlmGatewayPortHandler(makeDeps(provider));
    server = createServer((req, res) => { void handler(req, res); });
    await new Promise<void>((resolve) => { server!.listen(0, '127.0.0.1', () => resolve()); });
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer bearer-1', 'content-type': 'application/json' },
      body: makeBody({ stream: true, stream_options: { include_usage: true } }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('transfer-encoding')).toBe('chunked');

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(decoder.decode(first.value)).toContain(': keep-alive');
    // The bytes above arrived while the turn was still running.
    expect(providerCalled).toBe(true);

    pending.resolve({ id: 'chatcmpl_live', content: ANSWER, usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 } });
    let text = decoder.decode(first.value);
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      text += decoder.decode(next.value, { stream: true });
    }
    const chunks = parseChunks(text);
    expect(chunks[chunks.length - 1]).toBe('[DONE]');
    expect(assembled(chunks)).toBe(ANSWER);
    const usageChunk = chunks[chunks.length - 2] as Chunk;
    expect(usageChunk.usage).toEqual({ prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 });
    expect((chunks[0] as Chunk).id).toBe('chatcmpl_live');
  });
});

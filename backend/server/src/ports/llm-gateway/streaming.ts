/** D-196 v1.x — SSE streaming for the OpenAI-compatible `llm_gateway` door.
 *
 *  ⛔ WHAT THIS IS, AND IS NOT. The governed turn behind `/v1/chat/completions`
 *  produces its answer whole: neither `@recued/llm` nor the chat turn executor
 *  emits tokens progressively (the executor streams the FINAL synthesis as one
 *  delta, and `packages/llm/src/timeout.ts` records that adapter streaming is
 *  not implemented). So `stream: true` is a WIRE format, not a different turn.
 *  Every admission step, authority re-check, preflight and `chat_turn`
 *  reservation runs before the first byte, exactly as for a JSON response, and
 *  only the provider call runs behind an open `text/event-stream`.
 *
 *  What the open stream buys a client is real even without token deltas:
 *  - clients that can only speak streaming (most chat apps) work at all;
 *  - the connection carries SSE comment lines while a long governed turn (a
 *    tool loop, a held approval) runs, so proxies and client timeouts that
 *    would kill a silent multi-minute request leave it alone;
 *  - the answer arrives in OpenAI-shaped chunks, so a UI renders it the way it
 *    renders every other provider.
 *
 *  ⚠ A turn that hits an approval does NOT keep the stream open waiting for
 *  the owner. It settles as held, its final message says so, and the stream
 *  ends normally with that message. D-259's in-flight injection is what lets
 *  the NEXT turn talk about the held run. Holding the socket instead would turn
 *  a durable approval into a connection-lifetime one.
 *
 *  ⚠ A provider failure AFTER the headers went out cannot change the status
 *  code any more. It becomes an in-band `{"error": …}` event, the shape the
 *  OpenAI SDKs raise on, and the stream ends without `[DONE]`.
 *
 *  🔑 If token-level streaming ever lands in the LLM package, it slots in
 *  here: the frame builders already take the content in pieces.
 */

import type { ServerResponse } from 'node:http';

export const LLM_GATEWAY_STREAM_KEEPALIVE_MS = 15_000;
/** Pieces the final text is cut into. A cosmetic size: small enough that a UI
 *  paints the answer progressively, large enough that a long answer is not a
 *  thousand frames. */
export const LLM_GATEWAY_STREAM_CHUNK_CHARS = 96;

export const SSE_DONE = 'data: [DONE]\n\n';
/** An SSE comment. Every spec-conformant parser — openai-node's `SSEDecoder`,
 *  the Python SDK, the browser `EventSource` — drops a line that starts with
 *  `:`, so this keeps the connection alive without reaching the client's
 *  chunk handler. */
export const SSE_KEEPALIVE = ': keep-alive\n\n';

export const sseData = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

/** Cut `content` into pieces of at most `maxChars` UTF-16 units, breaking after
 *  whitespace where a window contains any, so a word never straddles two
 *  frames and `pieces.join('')` is identity. A single word longer than the
 *  window is hard-split, never inside a surrogate pair — a lone half would
 *  survive `JSON.stringify` as an escape and then fail to recombine in a
 *  client that does not concatenate code units. */
export const splitStreamContent = (
  content: string,
  maxChars: number = LLM_GATEWAY_STREAM_CHUNK_CHARS,
): string[] => {
  if (content.length === 0) return [];
  const limit = Math.max(1, Math.floor(maxChars));
  const pieces: string[] = [];
  let rest = content;
  while (rest.length > limit) {
    let cut = -1;
    for (let i = limit; i > 0; i -= 1) {
      if (/\s/.test(rest.charAt(i - 1))) { cut = i; break; }
    }
    if (cut <= 0) {
      cut = limit;
      if (isHighSurrogate(rest.charCodeAt(cut - 1))) cut += 1;
    }
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
};

export interface LlmGatewayStreamFrame {
  readonly id: string;
  readonly created: number;
  readonly model: string;
}

export interface LlmGatewayStreamUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
}

export interface LlmGatewayStreamCompletion {
  readonly content: string;
  readonly finish_reason: 'stop' | 'length' | 'content_filter';
  readonly usage: LlmGatewayStreamUsage;
  /** `stream_options.include_usage` from the request. When set, OpenAI's wire
   *  shape carries `usage: null` on every chunk and one extra final chunk with
   *  empty `choices` and the usage filled in; that shape is mirrored exactly. */
  readonly include_usage: boolean;
  /** The same `recued_outcome` extension the JSON response carries, on the
   *  finish chunk. SDKs ignore unknown top-level fields on a chunk. */
  readonly recued_outcome?: unknown;
  readonly chunk_chars?: number;
}

export interface LlmGatewayStreamError {
  readonly message: string;
  readonly type: string;
  readonly code: string;
}

const chunkObject = (
  frame: LlmGatewayStreamFrame,
  choices: ReadonlyArray<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: frame.id,
  object: 'chat.completion.chunk',
  created: frame.created,
  model: frame.model,
  choices,
  ...extra,
});

/** Every SSE line the stream writes for a completed turn, in order: the role
 *  chunk, the content in pieces, the finish chunk, the optional usage chunk,
 *  `[DONE]`. Pure, so the wire shape is testable without a socket. */
export const completionStreamFrames = (
  frame: LlmGatewayStreamFrame,
  completion: LlmGatewayStreamCompletion,
): string[] => {
  const usageNull = completion.include_usage ? { usage: null } : {};
  const frames: string[] = [];
  frames.push(sseData(chunkObject(frame, [
    { index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null },
  ], usageNull)));
  for (const piece of splitStreamContent(completion.content, completion.chunk_chars)) {
    frames.push(sseData(chunkObject(frame, [
      { index: 0, delta: { content: piece }, finish_reason: null },
    ], usageNull)));
  }
  frames.push(sseData(chunkObject(frame, [
    { index: 0, delta: {}, finish_reason: completion.finish_reason },
  ], {
    ...usageNull,
    ...(completion.recued_outcome !== undefined
      ? { recued_outcome: completion.recued_outcome }
      : {}),
  })));
  if (completion.include_usage) {
    frames.push(sseData(chunkObject(frame, [], { usage: completion.usage })));
  }
  frames.push(SSE_DONE);
  return frames;
};

export const errorStreamFrame = (error: LlmGatewayStreamError): string =>
  sseData({ error: { message: error.message, type: error.type, code: error.code } });

export interface LlmGatewayStreamTimers {
  readonly setInterval: (fn: () => void, ms: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
}

export interface LlmGatewayOpenStream {
  /** True once the client went away before the stream was finished. The turn
   *  keeps running — aborting a billed provider call would discard a result
   *  the owner already paid for — but nothing more is written. */
  readonly clientGone: () => boolean;
  complete(frame: LlmGatewayStreamFrame, completion: LlmGatewayStreamCompletion): void;
  fail(error: LlmGatewayStreamError): void;
}

/** Send the SSE headers now, start the keep-alive, and hand back the two ways
 *  the stream can end. Both are idempotent; both stop the keep-alive. */
export const openLlmGatewayStream = (
  res: ServerResponse,
  options: {
    readonly keepalive_ms?: number;
    readonly timers?: LlmGatewayStreamTimers;
  } = {},
): LlmGatewayOpenStream => {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  // Nginx-style proxies buffer a response by default; this asks them not to,
  // so the keep-alive comments reach the client instead of a proxy buffer.
  res.setHeader('x-accel-buffering', 'no');

  let ended = false;
  let gone = false;
  const alive = (): boolean => !ended && !gone && !res.destroyed && !res.writableEnded;
  const write = (frame: string): void => { if (alive()) res.write(frame); };

  const timers: LlmGatewayStreamTimers = options.timers ?? {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  };
  const every = Math.max(1_000, options.keepalive_ms ?? LLM_GATEWAY_STREAM_KEEPALIVE_MS);
  let timer: unknown = null;
  const stop = (): void => {
    if (timer !== null) { timers.clearInterval(timer); timer = null; }
  };
  // 'close' also fires after a normal end; only a close BEFORE we ended is
  // the client leaving.
  res.once('close', () => { if (!ended) gone = true; stop(); });

  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  write(SSE_KEEPALIVE);
  timer = timers.setInterval(() => write(SSE_KEEPALIVE), every);
  (timer as { unref?: () => void } | null)?.unref?.();

  const finish = (frames: ReadonlyArray<string>): void => {
    if (ended) return;
    stop();
    for (const frame of frames) write(frame);
    ended = true;
    if (!gone && !res.writableEnded) res.end();
  };

  return {
    clientGone: () => gone,
    complete: (frame, completion) => finish(completionStreamFrames(frame, completion)),
    fail: (error) => finish([errorStreamFrame(error)]),
  };
};

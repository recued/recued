/** D-160 P0 -- shared Slack / Telegram transport leaf block.
 *
 *  These tests keep the transport pure-HTTP and deterministic: every
 *  outbound send uses an injected fetch implementation, and inbound
 *  parsing accepts only already-verified user text payloads.
 *
 *  Spec: D-160 sections N.5 / N.7 / A.5 + invariant I-10.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSlackTransport,
  createTelegramTransport,
  type Transport,
} from '@recued/transport';
import { downloadToFile } from '../http.js';

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

const statusText = (status: number): string => {
  if (status === 401) return 'Unauthorized';
  if (status === 403) return 'Forbidden';
  if (status === 429) return 'Too Many Requests';
  if (status === 500) return 'Internal Server Error';
  return 'Bad Request';
};

const jsonFetch = (
  json: unknown,
  options: { status?: number } = {},
): { fetchImpl: typeof fetch; calls: FetchCall[] } => {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(json), {
      status: options.status ?? 200,
      statusText: statusText(options.status ?? 200),
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
};

const malformedJsonFetch = (): typeof fetch => async () =>
  new Response('{not-json', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const throwingFetch = (error: Error): typeof fetch => async () => {
  throw error;
};

const requestBody = (call: FetchCall): unknown => {
  expect(typeof call.init?.body).toBe('string');
  return JSON.parse(call.init?.body as string) as unknown;
};

const requestHeaders = (call: FetchCall): Record<string, string> => {
  expect(call.init?.headers).toBeTypeOf('object');
  return call.init?.headers as Record<string, string>;
};

describe('D-160 P0 transport outbound sends', () => {
  it('Slack send posts chat.postMessage with bearer auth, composed text, and returns the Slack ts', async () => {
    const { fetchImpl, calls } = jsonFetch({
      ok: true,
      ts: '1716141000.000200',
      channel: 'C123',
    });
    const transport = createSlackTransport({ fetchImpl, timeoutMs: 1234 });

    await expect(
      transport.send({
        recipient: 'C123',
        token: 'xoxb-test-token',
        title: 'Build ready',
        text: 'Deploy finished',
        link_url: 'https://recued.test/runs/1',
      }),
    ).resolves.toEqual({ ok: true, vendor_message_id: '1716141000.000200' });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://slack.com/api/chat.postMessage');
    expect(calls[0].init?.method).toBe('POST');
    expect(requestHeaders(calls[0])).toEqual({
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: 'Bearer xoxb-test-token',
    });
    expect(requestBody(calls[0])).toEqual({
      channel: 'C123',
      text: '*Build ready*\nDeploy finished\nhttps://recued.test/runs/1',
    });
  });

  it('Telegram send posts /bot<token>/sendMessage with the bound chat id and returns message_id', async () => {
    const { fetchImpl, calls } = jsonFetch({
      ok: true,
      result: { message_id: 42 },
    });
    const transport = createTelegramTransport({ fetchImpl, timeoutMs: 1234 });

    await expect(
      transport.send({
        recipient: '@recued_channel',
        token: '12345:telegram-secret',
        title: 'Build ready',
        text: 'Deploy finished',
        link_url: 'https://recued.test/runs/1',
      }),
    ).resolves.toEqual({ ok: true, vendor_message_id: '42' });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      'https://api.telegram.org/bot12345:telegram-secret/sendMessage',
    );
    expect(calls[0].init?.method).toBe('POST');
    expect(requestHeaders(calls[0])).toEqual({
      'Content-Type': 'application/json; charset=utf-8',
    });
    expect(requestBody(calls[0])).toEqual({
      chat_id: '@recued_channel',
      text: 'Build ready\n\nDeploy finished\nhttps://recued.test/runs/1',
    });
  });

  it.each([
    {
      name: 'Slack',
      transport: (fetchImpl: typeof fetch): Transport =>
        createSlackTransport({ fetchImpl }),
      envelope: { ok: false, error: 'channel_not_found' },
      detail: 'Slack: channel_not_found',
    },
    {
      name: 'Telegram',
      transport: (fetchImpl: typeof fetch): Transport =>
        createTelegramTransport({ fetchImpl }),
      envelope: { ok: false, description: 'chat not found' },
      detail: 'Telegram: chat not found',
    },
  ])('$name maps vendor ok:false envelopes to vendor_error', async (c) => {
    const { fetchImpl } = jsonFetch(c.envelope);
    const transport = c.transport(fetchImpl);

    await expect(
      transport.send({ recipient: 'dest', token: 'token', text: 'hello' }),
    ).resolves.toEqual({
      ok: false,
      error: { kind: 'vendor_error', detail: c.detail },
    });
  });

  it.each([
    {
      name: 'Slack',
      transport: (fetchImpl: typeof fetch): Transport =>
        createSlackTransport({ fetchImpl }),
      detail: 'Slack: unknown_error',
    },
    {
      name: 'Telegram',
      transport: (fetchImpl: typeof fetch): Transport =>
        createTelegramTransport({ fetchImpl }),
      detail: 'Telegram: unknown_error',
    },
  ])('$name requires ok === true in the vendor envelope', async (c) => {
    const { fetchImpl } = jsonFetch({});
    const transport = c.transport(fetchImpl);

    await expect(
      transport.send({ recipient: 'dest', token: 'token', text: 'hello' }),
    ).resolves.toEqual({
      ok: false,
      error: { kind: 'vendor_error', detail: c.detail },
    });
  });

  it.each([
    { vendor: 'Slack', status: 401, kind: 'auth' },
    { vendor: 'Slack', status: 403, kind: 'auth' },
    { vendor: 'Slack', status: 429, kind: 'rate_limited' },
    { vendor: 'Slack', status: 500, kind: 'server_error' },
    { vendor: 'Slack', status: 418, kind: 'network' },
    { vendor: 'Telegram', status: 401, kind: 'auth' },
    { vendor: 'Telegram', status: 403, kind: 'auth' },
    { vendor: 'Telegram', status: 429, kind: 'rate_limited' },
    { vendor: 'Telegram', status: 500, kind: 'server_error' },
    { vendor: 'Telegram', status: 418, kind: 'network' },
  ] as const)('$vendor maps HTTP $status to $kind', async (c) => {
    const { fetchImpl } = jsonFetch({ ok: true }, { status: c.status });
    const transport =
      c.vendor === 'Slack'
        ? createSlackTransport({ fetchImpl })
        : createTelegramTransport({ fetchImpl });

    const result = await transport.send({
      recipient: 'dest',
      token: 'token',
      text: 'hello',
    });

    expect(result).toMatchObject({
      ok: false,
      error: { kind: c.kind },
    });
  });

  it.each([
    {
      name: 'Slack',
      transport: (fetchImpl: typeof fetch): Transport =>
        createSlackTransport({ fetchImpl, timeoutMs: 5 }),
    },
    {
      name: 'Telegram',
      transport: (fetchImpl: typeof fetch): Transport =>
        createTelegramTransport({ fetchImpl, timeoutMs: 5 }),
    },
  ])('$name maps AbortError throws to timeout', async (c) => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    const transport = c.transport(throwingFetch(error));

    await expect(
      transport.send({ recipient: 'dest', token: 'token', text: 'hello' }),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: 'timeout' },
    });
  });

  it.each([
    {
      name: 'Slack',
      transport: (fetchImpl: typeof fetch): Transport =>
        createSlackTransport({ fetchImpl }),
    },
    {
      name: 'Telegram',
      transport: (fetchImpl: typeof fetch): Transport =>
        createTelegramTransport({ fetchImpl }),
    },
  ])('$name maps non-abort fetch throws to network', async (c) => {
    const transport = c.transport(throwingFetch(new Error('socket reset')));

    await expect(
      transport.send({ recipient: 'dest', token: 'token', text: 'hello' }),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: 'network' },
    });
  });

  it.each([
    {
      name: 'Slack',
      transport: (fetchImpl: typeof fetch): Transport =>
        createSlackTransport({ fetchImpl }),
    },
    {
      name: 'Telegram',
      transport: (fetchImpl: typeof fetch): Transport =>
        createTelegramTransport({ fetchImpl }),
    },
  ])('$name maps malformed JSON bodies to network', async (c) => {
    const transport = c.transport(malformedJsonFetch());

    await expect(
      transport.send({ recipient: 'dest', token: 'token', text: 'hello' }),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: 'network' },
    });
  });
});

describe('D-160 P0 Slack parseInbound', () => {
  const slack = createSlackTransport({ fetchImpl: jsonFetch({ ok: true }).fetchImpl });

  it('parses event_callback message payloads into user text', () => {
    expect(
      slack.parseInbound({
        type: 'event_callback',
        event: {
          type: 'message',
          user: 'U123',
          text: 'hello from Slack',
          ts: '1716141000.000200',
        },
      }),
    ).toEqual({
      from: 'U123',
      text: 'hello from Slack',
      vendor_message_id: '1716141000.000200',
    });
  });

  it('ignores Slack url_verification payloads', () => {
    expect(slack.parseInbound({ type: 'url_verification', challenge: 'abc' })).toBeNull();
  });

  it('ignores bot messages', () => {
    expect(
      slack.parseInbound({
        type: 'event_callback',
        event: { type: 'message', user: 'B123', text: 'bot echo', bot_id: 'B999' },
      }),
    ).toBeNull();
  });

  it('ignores message subtype events', () => {
    expect(
      slack.parseInbound({
        type: 'event_callback',
        event: { type: 'message', user: 'U123', text: 'edited', subtype: 'message_changed' },
      }),
    ).toBeNull();
  });

  it('surfaces file_share media and keeps media-only messages', () => {
    expect(
      slack.parseInbound({
        type: 'event_callback',
        event: {
          type: 'message',
          subtype: 'file_share',
          user: 'U123',
          text: '',
          ts: '1716141000.000300',
          files: [
            {
              id: 'F123',
              filetype: 'png',
              mimetype: 'image/png',
              size: 12345,
              url_private_download:
                'https://files.slack.com/files-pri/T123-F123/download/cat.png',
            },
          ],
        },
      }),
    ).toEqual({
      from: 'U123',
      text: '',
      vendor_message_id: '1716141000.000300',
      media: [
        {
          type: 'png',
          mime: 'image/png',
          size: 12345,
          remote_id: 'F123',
          remote_url: 'https://files.slack.com/files-pri/T123-F123/download/cat.png',
        },
      ],
    });
  });

  it.each([
    { field: 'text', event: { type: 'message', user: 'U123', text: '' } },
    { field: 'user', event: { type: 'message', user: '', text: 'hello' } },
  ])('ignores Slack messages with empty $field', (c) => {
    expect(slack.parseInbound({ type: 'event_callback', event: c.event })).toBeNull();
  });

  it.each([null, 'not-an-object', 42])('ignores non-object payload %#', (payload) => {
    expect(slack.parseInbound(payload)).toBeNull();
  });
});

describe('D-160 P0 Telegram parseInbound', () => {
  const telegram = createTelegramTransport({ fetchImpl: jsonFetch({ ok: true }).fetchImpl });

  it('parses message.text from non-bot senders into user text', () => {
    expect(
      telegram.parseInbound({
        update_id: 1,
        message: {
          message_id: 88,
          text: 'hello from Telegram',
          from: { id: 7001, is_bot: false },
        },
      }),
    ).toEqual({
      from: '7001',
      text: 'hello from Telegram',
      vendor_message_id: '88',
    });
  });

  it('surfaces the largest photo and preserves the caption as text', () => {
    expect(
      telegram.parseInbound({
        update_id: 1,
        message: {
          message_id: 89,
          caption: 'look at this',
          photo: [
            { file_id: 'photo-small', file_size: 1200, width: 90, height: 90 },
            { file_id: 'photo-large', file_size: 9000, width: 900, height: 600 },
          ],
          from: { id: 7001, is_bot: false },
        },
      }),
    ).toEqual({
      from: '7001',
      text: 'look at this',
      vendor_message_id: '89',
      media: [
        {
          type: 'photo',
          mime: 'image/jpeg',
          size: 9000,
          remote_id: 'photo-large',
        },
      ],
    });
  });

  it('keeps voice-only messages as empty text plus media', () => {
    expect(
      telegram.parseInbound({
        update_id: 1,
        message: {
          message_id: 90,
          voice: { file_id: 'voice-1', mime_type: 'audio/ogg', file_size: 555 },
          from: { id: 7001, is_bot: false },
        },
      }),
    ).toEqual({
      from: '7001',
      text: '',
      vendor_message_id: '90',
      media: [
        {
          type: 'voice',
          mime: 'audio/ogg',
          size: 555,
          remote_id: 'voice-1',
        },
      ],
    });
  });

  it('ignores bot-authored messages', () => {
    expect(
      telegram.parseInbound({
        update_id: 1,
        message: {
          message_id: 88,
          text: 'bot echo',
          from: { id: 7001, is_bot: true },
        },
      }),
    ).toBeNull();
  });

  it('ignores edited_message-only updates', () => {
    expect(
      telegram.parseInbound({
        update_id: 1,
        edited_message: {
          message_id: 88,
          text: 'edited',
          from: { id: 7001, is_bot: false },
        },
      }),
    ).toBeNull();
  });

  it('ignores messages without text or media', () => {
    expect(
      telegram.parseInbound({
        update_id: 1,
        message: {
          message_id: 88,
          from: { id: 7001, is_bot: false },
        },
      }),
    ).toBeNull();
  });
});

describe('D-172 P4.1 transport fetchMedia', () => {
  it('Slack resolves files.info and GETs url_private with bearer auth', async () => {
    const calls: FetchCall[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      if (String(input) === 'https://slack.com/api/files.info') {
        return new Response(
          JSON.stringify({
            ok: true,
            file: {
              name: '../../voice note.ogg',
              mimetype: 'audio/ogg',
              url_private: 'https://files.slack.com/files-pri/T123-F123/voice.ogg',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': 'audio/ogg; charset=binary' },
      });
    };
    const downloadDir = mkdtempSync(join(tmpdir(), 'slack-media-'));
    try {
      const slack = createSlackTransport({ fetchImpl, timeoutMs: 1234, downloadDir });

      const media = await slack.fetchMedia!(
        { type: 'voice', mime: 'application/octet-stream', size: 3, remote_id: 'F123' },
        'xoxb-test-token',
      );

      expect(media.filename).toBe('voice note.ogg');
      expect(media.mime_type).toBe('audio/ogg');
      // D-172 streaming: the body lands in a temp file, never an in-memory Buffer.
      expect(media.temp_path.startsWith(downloadDir)).toBe(true);
      expect(media.size).toBe(3);
      expect(Array.from(readFileSync(media.temp_path))).toEqual([1, 2, 3]);
      expect(Array.from(media.head_bytes)).toEqual([1, 2, 3]);
      expect(calls).toHaveLength(2);
      expect(calls[0].url).toBe('https://slack.com/api/files.info');
      expect(calls[0].init?.method).toBe('POST');
      expect(requestHeaders(calls[0]).Authorization).toBe('Bearer xoxb-test-token');
      expect(requestBody(calls[0])).toEqual({ file: 'F123' });
      expect(calls[1].url).toBe(
        'https://files.slack.com/files-pri/T123-F123/voice.ogg',
      );
      expect(calls[1].init?.method).toBe('GET');
      expect(requestHeaders(calls[1])).toEqual({ Authorization: 'Bearer xoxb-test-token' });
    } finally {
      rmSync(downloadDir, { recursive: true, force: true });
    }
  });

  it('Telegram resolves getFile and downloads through the file API URL', async () => {
    const calls: FetchCall[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith('/getFile')) {
        return new Response(
          JSON.stringify({ ok: true, result: { file_path: 'voice/file_1.ogg' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(new Uint8Array([4, 5, 6]), {
        status: 200,
        headers: { 'Content-Type': 'audio/ogg' },
      });
    };
    const downloadDir = mkdtempSync(join(tmpdir(), 'telegram-media-'));
    try {
      const telegram = createTelegramTransport({ fetchImpl, timeoutMs: 1234, downloadDir });

      const media = await telegram.fetchMedia!(
        { type: 'voice', mime: 'audio/ogg', size: 3, remote_id: 'voice-1' },
        '12345:telegram-secret',
      );

      expect(media.filename).toBe('file_1.ogg');
      expect(media.mime_type).toBe('audio/ogg');
      expect(media.temp_path.startsWith(downloadDir)).toBe(true);
      expect(media.size).toBe(3);
      expect(Array.from(readFileSync(media.temp_path))).toEqual([4, 5, 6]);
      expect(Array.from(media.head_bytes)).toEqual([4, 5, 6]);
      expect(calls).toHaveLength(2);
      expect(calls[0].url).toBe(
        'https://api.telegram.org/bot12345:telegram-secret/getFile',
      );
      expect(calls[0].init?.method).toBe('POST');
      expect(requestBody(calls[0])).toEqual({ file_id: 'voice-1' });
      expect(calls[1].url).toBe(
        'https://api.telegram.org/file/bot12345:telegram-secret/voice/file_1.ogg',
      );
      expect(calls[1].init?.method).toBe('GET');
    } finally {
      rmSync(downloadDir, { recursive: true, force: true });
    }
  });
});

describe('D-172 downloadToFile resilience', () => {
  it('resolves { ok:false } on a write-stream error (never an unhandled crash)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dl-werr-'));
    try {
      // destPath is an existing DIRECTORY → createWriteStream errors (EISDIR).
      // pipeline must surface it as a clean failure, not an unhandled writable
      // 'error' that crashes the process (the Codex review-of-fix HIGH).
      const destPath = join(dir, 'is-a-dir');
      mkdirSync(destPath);
      const fetchImpl: typeof fetch = async () =>
        new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
      const res = await downloadToFile('https://files.slack.com/x', {
        destPath,
        idleTimeoutMs: 1_000,
        fetchImpl,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.kind).toBe('network');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('aborts a stalled download via the idle timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dl-stall-'));
    try {
      const destPath = join(dir, 'stall.bin');
      // A body that never enqueues but honors the abort signal → the idle timer
      // fires, aborts the fetch, the body errors, pipeline rejects → timeout.
      const fetchImpl: typeof fetch = async (_url, init) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener('abort', () =>
              controller.error(new Error('aborted')),
            );
          },
        });
        return new Response(body, { status: 200 });
      };
      const res = await downloadToFile('https://files.slack.com/x', {
        destPath,
        idleTimeoutMs: 40,
        fetchImpl,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.kind).toBe('timeout');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('streams a body to disk and captures the head + size', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dl-ok-'));
    try {
      const destPath = join(dir, 'ok.bin');
      const payload = new Uint8Array([10, 20, 30, 40, 50]);
      const fetchImpl: typeof fetch = async () =>
        new Response(payload, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      const res = await downloadToFile('https://files.slack.com/x', {
        destPath,
        idleTimeoutMs: 1_000,
        fetchImpl,
        headCaptureBytes: 3,
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.size).toBe(5);
        expect(Array.from(res.headBytes)).toEqual([10, 20, 30]);
        expect(res.contentType).toBe('image/png');
        expect(Array.from(readFileSync(destPath))).toEqual([10, 20, 30, 40, 50]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

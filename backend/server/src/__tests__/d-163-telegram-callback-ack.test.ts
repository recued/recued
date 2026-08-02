/** D-163 polish — `composeTelegramCallbackAck` tests.
 *
 *  Pins the contract:
 *    - Recognized callback_query payload → POSTs answerCallbackQuery
 *      to api.telegram.org with the correct callback_query_id, bearer
 *      token interpolated from the connection.notification row.
 *    - Non-callback payload (plain message, malformed envelope) →
 *      silent no-op (no fetch call).
 *    - Connection row absent → silent no-op (the inbound webhook would
 *      have 401'd upstream, so this is structurally unreachable, but
 *      the defense-in-depth check matters when the row is deleted
 *      between webhook delivery and ack dispatch).
 *    - Non-bearer auth (config drift) → silent no-op.
 *    - Fetch failure → throws (caller responsible for catching).
 *    - Abort timeout → throws AbortError (caller catches). */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ConnectionRow } from '@recued/contracts';
import { composeTelegramCallbackAck } from '../composition/bin/wire-telegram-callback-ack.js';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';

// Mock the connection-handler.decodeAuthFromStorage path. The composer
// resolves the bearer token via this helper; tests stub it to return a
// known token without standing up the real sub-DEK + crypto pipeline.
vi.mock('../connection-handler.js', () => ({
  decodeAuthFromStorage: vi.fn(async () => ({
    type: 'bearer',
    token: '12345:test-bot-secret',
  })),
}));

const NOW = Date.parse('2026-05-27T12:00:00.000Z');

const stubConnectionRow = (overrides: Partial<ConnectionRow> = {}): ConnectionRow => ({
  pk: 'notification:telegram',
  kind: 'notification',
  name: 'telegram',
  display_name: 'telegram',
  config_json: '{}',
  auth_ciphertext: 'mock-ciphertext',
  enrolled_at: NOW,
  updated_at: NOW,
  ...overrides,
});

const stubConnectionStore = (
  row: ConnectionRow | null,
): ConnectionStoreSqlite =>
  ({
    get: vi.fn(() => row),
  }) as unknown as ConnectionStoreSqlite;

const callbackQueryPayload = (id: string): unknown => ({
  update_id: 42,
  callback_query: {
    id,
    data: 'ask-42|approve',
    from: { id: 7001, is_bot: false },
    message: { message_id: 99 },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('D-163 polish — composeTelegramCallbackAck', () => {
  it('refuses a cross-origin redirect before replaying the bot-token URL', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, {
      status: 307,
      headers: { location: 'https://collector.invalid/steal' },
    }));
    const ack = composeTelegramCallbackAck({
      connectionStore: stubConnectionStore(stubConnectionRow()),
      fetchImpl,
    });

    await expect(ack(callbackQueryPayload('cb-abc'), 'telegram'))
      .rejects.toThrow(/redirect refused/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });

  it('cancels the unused Telegram response body', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const ack = composeTelegramCallbackAck({
      connectionStore: stubConnectionStore(stubConnectionRow()),
      fetchImpl: async () => new Response(body),
    });

    await ack(callbackQueryPayload('cb-abc'), 'telegram');
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it('POSTs answerCallbackQuery with the extracted callback_query_id', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ) as unknown as typeof fetch;
    const connectionStore = stubConnectionStore(stubConnectionRow());

    const ack = composeTelegramCallbackAck({ connectionStore, fetchImpl });
    await ack(callbackQueryPayload('cb-abc'), 'telegram');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    // URL contains the URL-encoded bot token + the answerCallbackQuery method.
    expect(url).toBe(
      'https://api.telegram.org/bot12345%3Atest-bot-secret/answerCallbackQuery',
    );
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json; charset=utf-8',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      callback_query_id: 'cb-abc',
    });
  });

  it('no-ops silently for a payload with no callback_query', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const connectionStore = stubConnectionStore(stubConnectionRow());

    const ack = composeTelegramCallbackAck({ connectionStore, fetchImpl });
    await ack({ update_id: 100, message: { text: 'hi' } }, 'telegram');

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('no-ops silently when the connection row is missing', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const connectionStore = stubConnectionStore(null);

    const ack = composeTelegramCallbackAck({ connectionStore, fetchImpl });
    await ack(callbackQueryPayload('cb-abc'), 'telegram');

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('no-ops silently when the decoded auth is not bearer', async () => {
    const { decodeAuthFromStorage } = await import('../connection-handler.js');
    (decodeAuthFromStorage as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'none',
    });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const connectionStore = stubConnectionStore(stubConnectionRow());

    const ack = composeTelegramCallbackAck({ connectionStore, fetchImpl });
    await ack(callbackQueryPayload('cb-abc'), 'telegram');

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('no-ops silently when the bearer token is empty', async () => {
    const { decodeAuthFromStorage } = await import('../connection-handler.js');
    (decodeAuthFromStorage as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'bearer',
      token: '',
    });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const connectionStore = stubConnectionStore(stubConnectionRow());

    const ack = composeTelegramCallbackAck({ connectionStore, fetchImpl });
    await ack(callbackQueryPayload('cb-abc'), 'telegram');

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('propagates a fetch throw (caller is responsible for catching)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('NETWORK_DOWN');
    }) as unknown as typeof fetch;
    const connectionStore = stubConnectionStore(stubConnectionRow());

    const ack = composeTelegramCallbackAck({ connectionStore, fetchImpl });
    await expect(
      ack(callbackQueryPayload('cb-abc'), 'telegram'),
    ).rejects.toThrow('NETWORK_DOWN');
  });

  it('aborts the fetch on timeout and propagates', async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      }),
    ) as unknown as typeof fetch;
    const connectionStore = stubConnectionStore(stubConnectionRow());

    const ack = composeTelegramCallbackAck({
      connectionStore,
      fetchImpl,
      timeoutMs: 10,
    });
    await expect(ack(callbackQueryPayload('cb-abc'), 'telegram')).rejects.toThrow();
  });

  it('looks up the connection row by the supplied connection_name', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const get = vi.fn(() => stubConnectionRow({ name: 'telegram-work' }));
    const connectionStore = { get } as unknown as ConnectionStoreSqlite;

    const ack = composeTelegramCallbackAck({ connectionStore, fetchImpl });
    await ack(callbackQueryPayload('cb-abc'), 'telegram-work');

    expect(get).toHaveBeenCalledWith('notification', 'telegram-work');
  });

  it('does not call decodeAuthFromStorage before the payload check passes', async () => {
    const { decodeAuthFromStorage } = await import('../connection-handler.js');
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const connectionStore = stubConnectionStore(stubConnectionRow());

    const ack = composeTelegramCallbackAck({ connectionStore, fetchImpl });
    await ack({ update_id: 100 }, 'telegram');

    expect(decodeAuthFromStorage).not.toHaveBeenCalled();
  });
});

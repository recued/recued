/** D-238 § 3a — the Teams Graph poll runner.
 *
 *  ⛔ Weighted toward the failures that stay GREEN. Every one of the four below
 *  produces a runner that polls, dispatches, advances its cursor and reports
 *  healthy — while being wrong:
 *
 *    - a drifted `$orderby`/`$filter` pair (Graph IGNORES the filter, so the
 *      poll re-reads recent history forever and the cursor looks fine);
 *    - a bare `id` dedup key (collides across chats; a one-chat test cannot see
 *      it, so the test below drives TWO);
 *    - dispatching a DESC page in the order Graph returned it (the cursor jumps
 *      to the newest and every older message in that page is skipped forever);
 *    - a token captured at start() (works for an hour, then 401s forever —
 *      the one that would reach production, because an hour is longer than
 *      anyone watches a new integration).
 */

import { describe, expect, it, vi } from 'vitest';

import type { MessengerIngressStateStore } from '../storage/messenger-ingress-state-store.js';
import {
  buildTeamsPollUrl,
  createTeamsPollRunner,
  isTeamsUserMessage,
  teamsInboundId,
  TEAMS_POLL_MIN_INTERVAL_MS,
} from '../messenger-ingress/teams-poll.js';

const CHAT = '19:abc@thread.v2';

const userMessage = (over: Record<string, unknown> = {}) => ({
  id: '1727366299993',
  chatId: CHAT,
  messageType: 'message',
  lastModifiedDateTime: '2024-09-26T15:58:19.993Z',
  from: { user: { id: 'u1', displayName: 'Dana' } },
  body: { contentType: 'text', content: 'approve' },
  ...over,
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const memoryStore = () => {
  const rows = new Map<string, Record<string, unknown>>();
  const store = {
    get: (vendor: string, name: string) => (rows.get(`${vendor}:${name}`) ?? null) as never,
    put: (input: Record<string, unknown>) => {
      rows.set(`${String(input.vendor)}:${String(input.connection_name)}`, input);
    },
    delete: (vendor: string, name: string) => void rows.delete(`${vendor}:${name}`),
  } as unknown as MessengerIngressStateStore;
  return { store, rows };
};

describe('buildTeamsPollUrl', () => {
  /** ⛔ Graph: "You can only filter results if the request URL contains the
   *  $orderby and $filter query parameters configured for the SAME property;
   *  otherwise, the $filter query option is IGNORED." Ignored, not rejected. */
  it('names the SAME property in $orderby and $filter', () => {
    const url = new URL(buildTeamsPollUrl(CHAT, '2024-09-26T00:00:00.000Z'));
    const orderby = url.searchParams.get('$orderby') ?? '';
    const filter = url.searchParams.get('$filter') ?? '';

    const orderProp = orderby.split(/\s+/)[0];
    const filterProp = filter.split(/\s+/)[0];
    expect(orderProp).toBe(filterProp);
    // And it is the modification stamp, not creation — an EDITED older message
    // must resurface, which is why dedup is by key rather than by cursor alone.
    expect(orderProp).toBe('lastModifiedDateTime');
  });

  it('asks for descending order and caps the page at Graph’s maximum', () => {
    const url = new URL(buildTeamsPollUrl(CHAT, '2024-09-26T00:00:00.000Z'));
    expect(url.searchParams.get('$orderby')).toBe('lastModifiedDateTime desc');
    expect(url.searchParams.get('$top')).toBe('50');
  });

  it('escapes the chat id into the path', () => {
    expect(buildTeamsPollUrl(CHAT, 'x')).toContain('19%3Aabc%40thread.v2');
  });
});

describe('teamsInboundId', () => {
  /** ⛔ `chatMessage.id` is epoch MILLISECONDS and unique only WITHIN a chat.
   *  A single-chat test passes whether the key is composite or bare, so this
   *  drives two chats that share an id — the only shape that can tell them
   *  apart. */
  it('separates the same message id in two different chats', () => {
    const a = teamsInboundId('19:one@thread.v2', '1727366299993');
    const b = teamsInboundId('19:two@thread.v2', '1727366299993');
    expect(a).not.toBe(b);
  });
});

describe('isTeamsUserMessage', () => {
  it('accepts a message a human wrote', () => {
    expect(isTeamsUserMessage(userMessage())).toBe(true);
  });

  it('rejects a systemEventMessage on BOTH of its markers', () => {
    expect(isTeamsUserMessage(userMessage({ messageType: 'systemEventMessage' }))).toBe(false);
    expect(isTeamsUserMessage(userMessage({ from: null }))).toBe(false);
  });
});

describe('createTeamsPollRunner', () => {
  const drive = async (opts: {
    pages: unknown[][];
    saved?: Record<string, unknown>;
    dispatch?: (e: unknown) => Promise<void>;
  }) => {
    const { store, rows } = memoryStore();
    if (opts.saved) rows.set('teams:teams', opts.saved);

    const dispatched: unknown[] = [];
    const tokens: string[] = [];
    let call = 0;
    // ⚠ NOT `Promise.withResolvers()`. It is ES2024 and this monorepo compiles
    // against `lib: ["ES2022"]` (tsconfig.base.json), so it typechecks nowhere
    // even though the Node running vitest provides it — which is exactly how it
    // passed locally and failed `typecheck:tests`. Same three fields, no lib bump.
    let resolveSettled!: () => void;
    const settled = {
      promise: new Promise<void>((res) => { resolveSettled = res; }),
      resolve: (): void => { resolveSettled(); },
    };

    const fetchImpl = (async () => {
      const page = opts.pages[Math.min(call, opts.pages.length - 1)] ?? [];
      call += 1;
      if (call >= opts.pages.length) queueMicrotask(() => settled.resolve());
      return jsonResponse({ value: page });
    }) as unknown as typeof fetch;

    const runner = createTeamsPollRunner({
      connectionName: 'teams',
      credentialFingerprint: 'fp',
      chatId: CHAT,
      getAccessToken: async () => {
        const t = `at-${tokens.length}`;
        tokens.push(t);
        return t;
      },
      dispatch: (async (e: unknown) => {
        dispatched.push(e);
        if (opts.dispatch) await opts.dispatch(e);
      }) as never,
      stateStore: store,
      pollIntervalMs: TEAMS_POLL_MIN_INTERVAL_MS,
      fetchImpl,
      now: () => Date.parse('2024-09-26T00:00:00.000Z'),
    });

    runner.start();
    await settled.promise;
    await runner.stop();
    return { dispatched, tokens, rows, calls: call };
  };

  it('starts a fresh enrolment at NOW — never backfills the whole chat', async () => {
    const urls: string[] = [];
    const { store } = memoryStore();
    const fetchImpl = (async (input: unknown) => {
      urls.push(String(input));
      return jsonResponse({ value: [] });
    }) as unknown as typeof fetch;

    const runner = createTeamsPollRunner({
      connectionName: 'teams',
      credentialFingerprint: 'fp',
      chatId: CHAT,
      getAccessToken: async () => 'at',
      dispatch: (async () => {}) as never,
      stateStore: store,
      pollIntervalMs: TEAMS_POLL_MIN_INTERVAL_MS,
      fetchImpl,
      now: () => Date.parse('2024-09-26T00:00:00.000Z'),
    });
    runner.start();
    await vi.waitFor(() => expect(urls.length).toBeGreaterThan(0));
    await runner.stop();

    expect(decodeURIComponent(urls[0]!)).toContain('gt 2024-09-26T00:00:00.000Z');
  });

  it('resumes from the persisted cursor', async () => {
    const urls: string[] = [];
    const { store, rows } = memoryStore();
    rows.set('teams:teams', {
      mode: 'poll',
      credential_fingerprint: 'fp',
      state: { cursor: '2024-09-20T10:00:00.000Z' },
    });
    const fetchImpl = (async (input: unknown) => {
      urls.push(String(input));
      return jsonResponse({ value: [] });
    }) as unknown as typeof fetch;

    const runner = createTeamsPollRunner({
      connectionName: 'teams',
      credentialFingerprint: 'fp',
      chatId: CHAT,
      getAccessToken: async () => 'at',
      dispatch: (async () => {}) as never,
      stateStore: store,
      pollIntervalMs: TEAMS_POLL_MIN_INTERVAL_MS,
      fetchImpl,
      now: () => Date.parse('2024-09-26T00:00:00.000Z'),
    });
    runner.start();
    await vi.waitFor(() => expect(urls.length).toBeGreaterThan(0));
    await runner.stop();

    expect(decodeURIComponent(urls[0]!)).toContain('gt 2024-09-20T10:00:00.000Z');
  });

  /** ⛔ Graph returns DESC and offers no ascending order. Dispatching in the
   *  order received would advance the cursor to the NEWEST of the page; a
   *  failure partway then skips every older message in it permanently. */
  it('dispatches a DESC page oldest-first', async () => {
    const newer = userMessage({ id: '300', lastModifiedDateTime: '2024-09-26T03:00:00.000Z' });
    const older = userMessage({ id: '100', lastModifiedDateTime: '2024-09-26T01:00:00.000Z' });
    const { dispatched } = await drive({ pages: [[newer, older], []] });

    expect(dispatched.map((d) => (d as { message_id: string }).message_id)).toEqual([
      teamsInboundId(CHAT, '100'),
      teamsInboundId(CHAT, '300'),
    ]);
  });

  it('dispatches with the COMPOSITE id, not the bare message id', async () => {
    const { dispatched } = await drive({ pages: [[userMessage()], []] });
    expect((dispatched[0] as { message_id: string }).message_id).toBe(
      `${CHAT}:1727366299993`,
    );
  });

  /** ⛔ The cursor must never move past a message whose dispatch did not
   *  resolve — that is the difference between "retried" and "lost". */
  it('does NOT advance the cursor when dispatch throws', async () => {
    const { store, rows } = memoryStore();
    const fetchImpl = (async () =>
      jsonResponse({ value: [userMessage()] })) as unknown as typeof fetch;

    let attempted = 0;
    const runner = createTeamsPollRunner({
      connectionName: 'teams',
      credentialFingerprint: 'fp',
      chatId: CHAT,
      getAccessToken: async () => 'at',
      dispatch: (async () => {
        attempted += 1;
        throw new Error('storage unavailable');
      }) as never,
      stateStore: store,
      pollIntervalMs: TEAMS_POLL_MIN_INTERVAL_MS,
      fetchImpl,
      now: () => Date.parse('2024-09-26T00:00:00.000Z'),
    });
    runner.start();
    await vi.waitFor(() => expect(attempted).toBeGreaterThan(0));
    await runner.stop();

    expect(rows.get('teams:teams')).toBeUndefined();
  });

  it('advances past a skipped system message so it is not re-read forever', async () => {
    const system = userMessage({
      id: '200',
      messageType: 'systemEventMessage',
      from: null,
      lastModifiedDateTime: '2024-09-26T02:00:00.000Z',
    });
    const { dispatched, rows } = await drive({ pages: [[system], []] });

    expect(dispatched).toHaveLength(0);
    expect(
      (rows.get('teams:teams')?.state as { cursor: string }).cursor,
    ).toBe('2024-09-26T02:00:00.000Z');
  });

  /** ⛔ THE ONE THAT REACHES PRODUCTION. A Graph delegated token lives about an
   *  hour. A runner that captured it at start() works all afternoon in testing
   *  and then 401s forever, at a moment nobody is watching. Asserting the
   *  provider is called PER TICK is what pins that. */
  it('resolves a fresh credential on every poll, not once at start', async () => {
    const { tokens, calls } = await drive({ pages: [[], [], []] });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(tokens.length).toBe(calls);
    // Distinct values prove the provider was re-consulted rather than memoised.
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it('refuses to poll faster than Graph’s documented ceiling', async () => {
    const { store } = memoryStore();
    const stamps: number[] = [];
    const fetchImpl = (async () => {
      stamps.push(Date.now());
      return jsonResponse({ value: [] });
    }) as unknown as typeof fetch;

    const runner = createTeamsPollRunner({
      connectionName: 'teams',
      credentialFingerprint: 'fp',
      chatId: CHAT,
      getAccessToken: async () => 'at',
      dispatch: (async () => {}) as never,
      stateStore: store,
      // Ask for something abusive; the runner must clamp it.
      pollIntervalMs: 5,
      fetchImpl,
      now: () => Date.parse('2024-09-26T00:00:00.000Z'),
    });
    runner.start();
    await vi.waitFor(() => expect(stamps.length).toBeGreaterThanOrEqual(2), { timeout: 4_000 });
    await runner.stop();

    expect(stamps[1]! - stamps[0]!).toBeGreaterThanOrEqual(TEAMS_POLL_MIN_INTERVAL_MS - 50);
  });
});

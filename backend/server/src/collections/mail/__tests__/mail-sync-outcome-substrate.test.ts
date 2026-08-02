/** Per-attempt mail sync-outcome substrate.
 *
 *  These tests stay below MailCollection's durable state transitions (covered
 *  by mail-sync-outcome-reporting.test.ts). They pin the reporter's attempt
 *  semantics, provider-side error classification, and the Gmail / IMAP paths
 *  that swallow transport failures before returning to their callers.
 */

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  FetchMessageObject,
  FetchQueryObject,
  MailboxObject,
  SearchObject,
} from 'imapflow';

import {
  createGmailProvider,
  type GmailProviderConfig,
} from '../gmail-provider.js';
import {
  createImapProvider,
  type ImapClient,
  type ImapProviderConfig,
} from '../imap-provider.js';
import {
  parseOAuthErrorField,
  type HttpFetcher,
  type OAuthAccountStore,
  type OAuthProviderConfig,
} from '../oauth.js';
import {
  classifyMailApiStatus,
  classifyOAuthFailure,
  createMailSyncOutcomeReporter,
  type MailProvider,
  type MailSyncFailureKind,
  type MailSyncOutcome,
} from '../provider.js';

const NOW = 1_700_000_000_000;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const waitFor = async (predicate: () => boolean): Promise<void> => {
  await vi.waitFor(() => {
    expect(predicate()).toBe(true);
  });
};

const providers: MailProvider[] = [];

afterEach(async () => {
  for (const provider of providers) await provider.close();
  providers.length = 0;
});

describe('createMailSyncOutcomeReporter', () => {
  const newReporter = (
    classifyError?: (err: unknown) => MailSyncFailureKind,
  ) => {
    const classify = classifyError ?? vi.fn((): MailSyncFailureKind => 'transient');
    const reporter = createMailSyncOutcomeReporter({
      now: () => NOW,
      classifyError: classify,
    });
    const outcomes: MailSyncOutcome[] = [];
    reporter.subscribe((outcome) => { outcomes.push(outcome); });
    return { reporter, outcomes, classifyError: classify };
  };

  it('emits exactly one successful outcome for a clean attempt', async () => {
    const { reporter, outcomes, classifyError } = newReporter();

    await expect(reporter.run('poll', async () => 'value')).resolves.toBe('value');

    expect(outcomes).toEqual([{ phase: 'poll', ok: true, at: NOW }]);
    expect(classifyError).not.toHaveBeenCalled();
  });

  it('emits exactly one failed outcome when the attempt notes a swallowed failure', async () => {
    const { reporter, outcomes, classifyError } = newReporter();

    await expect(reporter.run('initial_scan', async () => {
      reporter.noteFailure('transient');
      return 'continued';
    })).resolves.toBe('continued');

    expect(outcomes).toEqual([{
      phase: 'initial_scan',
      ok: false,
      failure: 'transient',
      at: NOW,
    }]);
    expect(classifyError).not.toHaveBeenCalled();
  });

  it('rethrows the original error and classifies an unnoted throw', async () => {
    const thrown = new Error('poll exploded');
    const classifyError = vi.fn((): MailSyncFailureKind => 'auth');
    const { reporter, outcomes } = newReporter(classifyError);

    await expect(reporter.run('poll', async () => { throw thrown; })).rejects.toBe(thrown);

    expect(classifyError).toHaveBeenCalledOnce();
    expect(classifyError).toHaveBeenCalledWith(thrown);
    expect(outcomes).toEqual([{
      phase: 'poll',
      ok: false,
      failure: 'auth',
      at: NOW,
    }]);
  });

  it("keeps an auth note when a later note is transient", async () => {
    const { reporter, outcomes } = newReporter();

    await reporter.run('poll', async () => {
      reporter.noteFailure('auth');
      reporter.noteFailure('transient');
    });

    expect(outcomes).toEqual([{
      phase: 'poll',
      ok: false,
      failure: 'auth',
      at: NOW,
    }]);
  });

  it('scopes noted failures to overlapping attempts', async () => {
    const { reporter, outcomes } = newReporter();
    const attemptAStarted = deferred<void>();
    const allowAttemptAToNote = deferred<void>();
    const attemptANoted = deferred<void>();
    const finishAttemptA = deferred<void>();
    const attemptBStarted = deferred<void>();
    const finishAttemptB = deferred<void>();

    const attemptA = reporter.run('poll', async () => {
      attemptAStarted.resolve();
      await allowAttemptAToNote.promise;
      reporter.noteFailure('transient');
      attemptANoted.resolve();
      await finishAttemptA.promise;
    });
    await attemptAStarted.promise;

    const attemptB = reporter.run('poll', async () => {
      attemptBStarted.resolve();
      await finishAttemptB.promise;
    });
    await attemptBStarted.promise;

    allowAttemptAToNote.resolve();
    await attemptANoted.promise;
    finishAttemptB.resolve();
    await attemptB;
    finishAttemptA.resolve();
    await attemptA;

    // B completes first and must not consume A's note. A then reports its own
    // failure when it is allowed to complete.
    expect(outcomes).toEqual([
      { phase: 'poll', ok: true, at: NOW },
      { phase: 'poll', ok: false, failure: 'transient', at: NOW },
    ]);
  });

  it('treats noteFailure outside an attempt as a non-throwing no-op', async () => {
    const { reporter, outcomes } = newReporter();

    expect(() => { reporter.noteFailure('auth'); }).not.toThrow();
    await reporter.run('poll', async () => undefined);

    expect(outcomes).toEqual([{ phase: 'poll', ok: true, at: NOW }]);
  });

  it('reports directly and unsubscribe stops delivery', () => {
    const reporter = createMailSyncOutcomeReporter({
      now: () => NOW,
      classifyError: () => 'transient',
    });
    const outcomes: MailSyncOutcome[] = [];
    const unsubscribe = reporter.subscribe((outcome) => { outcomes.push(outcome); });

    reporter.report('reconnect', false, 'auth');
    unsubscribe();
    reporter.report('reconnect', true);

    expect(outcomes).toEqual([{
      phase: 'reconnect',
      ok: false,
      failure: 'auth',
      at: NOW,
    }]);
  });

  it('does not let a throwing listener break an attempt or later listeners', async () => {
    const reporter = createMailSyncOutcomeReporter({
      now: () => NOW,
      classifyError: () => 'transient',
    });
    const outcomes: MailSyncOutcome[] = [];
    reporter.subscribe(() => { throw new Error('listener failed'); });
    reporter.subscribe((outcome) => { outcomes.push(outcome); });

    await expect(reporter.run('poll', async () => 42)).resolves.toBe(42);

    expect(outcomes).toEqual([{ phase: 'poll', ok: true, at: NOW }]);
  });
});

describe('mail sync failure classifiers', () => {
  it.each([
    { status: 400, reason: 'invalid_grant', expected: 'auth' },
    { status: 400, reason: 'invalid_client', expected: 'transient' },
    { status: 400, reason: 'invalid_scope', expected: 'transient' },
    { status: 400, reason: 'unsupported_grant_type', expected: 'transient' },
    { status: 400, reason: 'invalid_request', expected: 'transient' },
    { status: 401, reason: undefined, expected: 'auth' },
    { status: 400, reason: undefined, expected: 'transient' },
    { status: 429, reason: 'invalid_grant', expected: 'transient' },
    { status: 503, reason: 'invalid_grant', expected: 'transient' },
  ] as const)(
    'classifies OAuth $status/$reason as $expected',
    ({ status, reason, expected }) => {
      expect(classifyOAuthFailure(status, reason)).toBe(expected);
    },
  );

  it.each([
    { status: 401, body: undefined, expected: 'auth' },
    {
      status: 403,
      body: JSON.stringify({ error: { errors: [{ reason: 'rateLimitExceeded' }] } }),
      expected: 'transient',
    },
    {
      status: 403,
      body: JSON.stringify({ error: { errors: [{ reason: 'insufficientPermissions' }] } }),
      expected: 'auth',
    },
    { status: 403, body: undefined, expected: 'transient' },
    { status: 429, body: undefined, expected: 'transient' },
    { status: 500, body: undefined, expected: 'transient' },
  ] as const)(
    'classifies mail API $status as $expected',
    ({ status, body, expected }) => {
      expect(classifyMailApiStatus(status, body)).toBe(expected);
    },
  );
});

describe('parseOAuthErrorField', () => {
  it("extracts the token endpoint's string error field", () => {
    expect(parseOAuthErrorField('{"error":"invalid_grant","error_description":"revoked"}'))
      .toBe('invalid_grant');
  });

  it.each([
    { label: 'non-JSON', body: '<html>bad gateway</html>' },
    { label: 'JSON without error', body: '{"error_description":"missing"}' },
    { label: 'a non-string error', body: '{"error":400}' },
    { label: 'an empty error', body: '{"error":""}' },
  ])('returns undefined for $label', ({ body }) => {
    expect(parseOAuthErrorField(body)).toBeUndefined();
  });
});

// Gmail's existing provider tests use a Map-backed account store and a
// scripted HttpFetcher. Keep that seam here, but drive scheduled ticks and
// observe per-attempt outcomes rather than re-covering message translation.

const GMAIL_HISTORY_KEY = 'gmail.work.history_id';
const OAUTH_CONFIG: OAuthProviderConfig = {
  tokenUrl: 'https://oauth2.googleapis.com/token',
  clientId: 'client-id',
  clientSecret: 'client-secret',
};

const makeAccountStore = (
  seed: Record<string, string>,
): OAuthAccountStore & { data: Map<string, string> } => {
  const data = new Map(Object.entries(seed));
  return {
    data,
    async get(key) { return data.get(key) ?? null; },
    async set(key, value) { data.set(key, value); },
    async delete(key) { data.delete(key); },
  };
};

const httpResponse = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  async json() { return body; },
  async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
});

interface GmailHarness {
  provider: MailProvider;
  store: ReturnType<typeof makeAccountStore>;
  outcomes: MailSyncOutcome[];
  tick(): Promise<void>;
}

const newGmailHarness = (opts: {
  historyId?: string;
  fetcher: HttpFetcher;
}): GmailHarness => {
  const store = makeAccountStore({
    'gmail.work.access_token': 'access-token',
    'gmail.work.expires_at': String(NOW + 3_600_000),
    'gmail.work.refresh_token': 'refresh-token',
    ...(opts.historyId === undefined ? {} : { [GMAIL_HISTORY_KEY]: opts.historyId }),
  });
  let scheduledTick: (() => Promise<void>) | undefined;
  const config = (): GmailProviderConfig => ({
    account_slug: 'work',
    backfill_days: 7,
    poll_seconds: 30,
  });
  const provider = createGmailProvider({
    slug: 'work',
    config,
    accountStore: store,
    providerConfig: OAUTH_CONFIG,
    fetcher: opts.fetcher,
    now: () => NOW,
    scheduler(cb) {
      scheduledTick = cb;
      return () => undefined;
    },
  });
  providers.push(provider);
  const outcomes: MailSyncOutcome[] = [];
  provider.onSyncOutcome!((outcome) => { outcomes.push(outcome); });
  return {
    provider,
    store,
    outcomes,
    async tick() {
      if (!scheduledTick) throw new Error('gmail scheduler has not been installed');
      await scheduledTick();
    },
  };
};

describe('GmailProvider sync outcomes and stale history recovery', () => {
  it('reports a stale history cursor as failed, clears it, then re-seeds next tick', async () => {
    let historyCalls = 0;
    let profileCalls = 0;
    const h = newGmailHarness({
      historyId: 'stale-100',
      fetcher: async (url) => {
        if (url.includes('/history?')) {
          historyCalls++;
          return httpResponse(404, { error: { message: 'Requested entity was not found.' } });
        }
        if (url.endsWith('/profile')) {
          profileCalls++;
          return httpResponse(200, { historyId: 'fresh-900', emailAddress: 'me@example.com' });
        }
        return httpResponse(500, { error: 'unexpected request', url });
      },
    });

    await h.provider.connect();
    await h.provider.startSync(async () => undefined);

    expect(h.outcomes).toEqual([{
      phase: 'poll',
      ok: false,
      failure: 'transient',
      at: NOW,
    }]);
    expect(h.store.data.has(GMAIL_HISTORY_KEY)).toBe(false);
    expect(historyCalls).toBe(1);

    await h.tick();

    expect(profileCalls).toBe(1);
    expect(historyCalls).toBe(1);
    expect(h.store.data.get(GMAIL_HISTORY_KEY)).toBe('fresh-900');
    expect(h.outcomes).toEqual([
      { phase: 'poll', ok: false, failure: 'transient', at: NOW },
      { phase: 'poll', ok: true, at: NOW },
    ]);
  });

  it('treats a message-detail 404 as benign and leaves the watermark untouched', async () => {
    const h = newGmailHarness({
      historyId: '100',
      fetcher: async (url) => {
        if (url.includes('/history?')) {
          return httpResponse(200, {
            history: [{
              id: '100',
              messagesAdded: [{ message: { id: 'already-gone', threadId: 'thread-1' } }],
            }],
            historyId: '100',
          });
        }
        if (url.includes('/messages/already-gone?format=raw')) {
          return httpResponse(404, { error: { message: 'Message not found' } });
        }
        return httpResponse(500, { error: 'unexpected request', url });
      },
    });

    await h.provider.connect();
    await h.provider.startSync(async () => undefined);

    expect(h.outcomes).toEqual([{ phase: 'poll', ok: true, at: NOW }]);
    expect(h.store.data.get(GMAIL_HISTORY_KEY)).toBe('100');
  });

  it('reports an empty successful history tick as healthy', async () => {
    const h = newGmailHarness({
      historyId: '100',
      fetcher: async (url) => {
        if (url.includes('/history?')) {
          return httpResponse(200, { history: [], historyId: '100' });
        }
        return httpResponse(500, { error: 'unexpected request', url });
      },
    });

    await h.provider.connect();
    await h.provider.startSync(async () => undefined);

    expect(h.outcomes).toEqual([{ phase: 'poll', ok: true, at: NOW }]);
  });
});

// IMAP follows the existing injected ImapClient pattern. This fake adds only
// two controls needed here: fetch failures and per-folder mailbox-open failures
// for deterministic reconnect interleaving.

interface FakeImapMessage {
  uid: number;
  source: Buffer;
  flags?: Set<string>;
  internalDate?: Date;
}

interface FakeImapFolder {
  path: string;
  messages: FakeImapMessage[];
}

interface FakeImapState {
  folders: Map<string, FakeImapFolder>;
  clients: FakeImapClient[];
  fetchError?: unknown;
  nextConnectWait?: Promise<void>;
  mailboxOpenFailures: Map<string, unknown[]>;
}

class FakeImapClient extends EventEmitter implements ImapClient {
  usable = false;
  path = '';

  constructor(private readonly state: FakeImapState) {
    super();
    state.clients.push(this);
  }

  async connect(): Promise<void> {
    const wait = this.state.nextConnectWait;
    this.state.nextConnectWait = undefined;
    await wait;
    this.usable = true;
  }

  async logout(): Promise<void> {
    this.usable = false;
  }

  close(): void {
    this.usable = false;
  }

  async mailboxOpen(path: string): Promise<MailboxObject> {
    this.path = path;
    const failure = this.state.mailboxOpenFailures.get(path)?.shift();
    if (failure !== undefined) throw failure;
    return {
      path,
      delimiter: '/',
      flags: new Set(),
      exists: this.state.folders.get(path)?.messages.length ?? 0,
    } as unknown as MailboxObject;
  }

  async search(_query: SearchObject, _opts?: { uid?: boolean }): Promise<number[] | false> {
    return (this.state.folders.get(this.path)?.messages ?? []).map((message) => message.uid);
  }

  async *fetch(
    range: string | number[],
    _query: FetchQueryObject,
    _opts?: { uid?: boolean },
  ): AsyncIterable<FetchMessageObject> {
    if (this.state.fetchError !== undefined) throw this.state.fetchError;
    const uids = Array.isArray(range) ? range : [];
    const messages = this.state.folders.get(this.path)?.messages ?? [];
    for (const uid of uids) {
      const message = messages.find((candidate) => candidate.uid === uid);
      if (!message) continue;
      yield {
        seq: uid,
        uid,
        source: message.source,
        flags: message.flags,
        internalDate: message.internalDate,
      } as unknown as FetchMessageObject;
    }
  }

  async idle(): Promise<boolean> {
    return true;
  }
}

const rfc822 = (uid: number): Buffer => Buffer.from([
  'From: alice@example.com',
  'To: me@example.com',
  `Subject: message ${uid}`,
  `Message-ID: <message-${uid}@example.com>`,
  'Date: Mon, 1 Jan 2024 10:00:00 +0000',
  'Content-Type: text/plain; charset="utf-8"',
  '',
  'hello',
].join('\r\n'));

interface ImapHarness {
  provider: MailProvider;
  state: FakeImapState;
  outcomes: MailSyncOutcome[];
}

const newImapHarness = (opts: {
  seed?: Record<string, FakeImapMessage[]>;
  fetchError?: unknown;
  sleep?: (ms: number) => Promise<void>;
} = {}): ImapHarness => {
  const seed = opts.seed ?? { INBOX: [] };
  const state: FakeImapState = {
    folders: new Map(
      Object.entries(seed).map(([path, messages]) => [path, { path, messages }]),
    ),
    clients: [],
    fetchError: opts.fetchError,
    mailboxOpenFailures: new Map(),
  };
  const config = (): ImapProviderConfig => ({
    host: 'imap.example.com',
    port: 993,
    secure: true,
    username: 'me@example.com',
    password: 'password',
    folders: Object.keys(seed),
    reconnectInitialMs: 1,
    reconnectCapMs: 4,
  });
  const provider = createImapProvider({
    slug: 'work',
    config,
    clientFactory: () => new FakeImapClient(state),
    now: () => NOW,
    sleep: opts.sleep ?? (() => Promise.resolve()),
  });
  providers.push(provider);
  const outcomes: MailSyncOutcome[] = [];
  provider.onSyncOutcome!((outcome) => { outcomes.push(outcome); });
  return { provider, state, outcomes };
};

describe('ImapProvider per-attempt sync outcomes', () => {
  it('reopens reconnect admission after a close and reconnect cycle', async () => {
    const h = newImapHarness();
    await h.provider.connect();
    await h.provider.startSync(async () => undefined);
    await h.provider.close();

    await h.provider.connect();
    await h.provider.startSync(async () => undefined);
    expect(h.state.clients).toHaveLength(2);
    h.state.clients[1].emit('close');
    await waitFor(() => h.state.clients.length === 3);

    expect(h.state.clients[2].path).toBe('INBOX');
  });

  it('close waits for and seals a reconnect whose connect finishes late', async () => {
    const h = newImapHarness();
    await h.provider.connect();
    await h.provider.startSync(async () => undefined);
    const reconnectConnect = deferred<void>();
    h.state.nextConnectWait = reconnectConnect.promise;

    h.state.clients[0].emit('close');
    await waitFor(() => h.state.clients.length === 2);
    const lateClient = h.state.clients[1]!;
    let closed = false;
    const closing = h.provider.close().then(() => { closed = true; });
    await Promise.resolve();

    expect(closed).toBe(false);
    reconnectConnect.resolve();
    await closing;

    expect(lateClient.usable).toBe(false);
    expect(h.state.clients).toHaveLength(2);
  });

  it("reports a failed poll when an IDLE 'exists' fetch throws", async () => {
    const h = newImapHarness({
      seed: { INBOX: [{ uid: 1, source: rfc822(1), internalDate: new Date() }] },
      fetchError: new Error('socket closed during fetch'),
    });
    await h.provider.connect();
    await h.provider.startSync(async () => undefined);

    h.state.clients[0].emit('exists', { count: 1, prevCount: 0, path: 'INBOX' });
    await waitFor(() => h.outcomes.length === 1);

    expect(h.outcomes).toEqual([{
      phase: 'poll',
      ok: false,
      failure: 'transient',
      at: NOW,
    }]);
  });

  it("reports one poll outcome for an 'exists' batch containing three messages", async () => {
    const h = newImapHarness({
      seed: {
        INBOX: [1, 2, 3].map((uid) => ({
          uid,
          source: rfc822(uid),
          internalDate: new Date(),
        })),
      },
    });
    const delivered: number[] = [];
    await h.provider.connect();
    await h.provider.startSync(async (event) => {
      delivered.push(Number(event.source_id.split('@')[0]));
    });

    h.state.clients[0].emit('exists', { count: 3, prevCount: 0, path: 'INBOX' });
    await waitFor(() => delivered.length === 3 && h.outcomes.length >= 1);

    expect(delivered).toEqual([1, 2, 3]);
    expect(h.outcomes).toEqual([{ phase: 'poll', ok: true, at: NOW }]);
  });

  it.each([
    {
      label: 'an imapflow authentication failure',
      error: { authenticationFailed: true },
      expected: 'auth',
    },
    {
      label: 'a plain socket error',
      error: new Error('socket hang up'),
      expected: 'transient',
    },
  ] as const)('classifies $label as $expected', async ({ error, expected }) => {
    const h = newImapHarness({
      seed: { INBOX: [{ uid: 1, source: rfc822(1), internalDate: new Date() }] },
      fetchError: error,
    });
    await h.provider.connect();

    await h.provider.initialScan({
      backfill_days: 30,
      onMessage: async () => true,
    });

    expect(h.outcomes).toEqual([{
      phase: 'initial_scan',
      ok: false,
      failure: expected,
      at: NOW,
    }]);
  });

  it('reports reconnect success only after every configured folder is back', async () => {
    const sleeps: Array<Deferred<void>> = [];
    const h = newImapHarness({
      seed: { INBOX: [], Archive: [] },
      sleep: () => {
        const gate = deferred<void>();
        sleeps.push(gate);
        return gate.promise;
      },
    });
    await h.provider.connect();
    await h.provider.startSync(async () => undefined);
    const inbox = h.state.clients.find((client) => client.path === 'INBOX')!;
    const archive = h.state.clients.find((client) => client.path === 'Archive')!;
    h.state.mailboxOpenFailures.set('INBOX', [new Error('inbox unavailable')]);
    h.state.mailboxOpenFailures.set('Archive', [new Error('archive unavailable')]);

    inbox.emit('close');
    await waitFor(() => sleeps.length === 1);
    sleeps[0].resolve();
    await waitFor(() => h.outcomes.length === 1 && sleeps.length === 2);

    archive.emit('close');
    await waitFor(() => sleeps.length === 3);
    sleeps[2].resolve();
    await waitFor(() => h.outcomes.length === 2 && sleeps.length === 4);

    // INBOX's second attempt succeeds, but Archive is still represented in the
    // aggregate down-folder set, so provider-wide success would be false.
    sleeps[1].resolve();
    await waitFor(() => h.state.clients.filter((client) => client.path === 'INBOX').length === 3);
    expect(h.outcomes.some((outcome) => outcome.phase === 'reconnect' && outcome.ok)).toBe(false);

    sleeps[3].resolve();
    await waitFor(() => h.outcomes.some(
      (outcome) => outcome.phase === 'reconnect' && outcome.ok,
    ));

    expect(h.outcomes).toEqual([
      { phase: 'reconnect', ok: false, failure: 'transient', at: NOW },
      { phase: 'reconnect', ok: false, failure: 'transient', at: NOW },
      { phase: 'reconnect', ok: true, at: NOW },
    ]);
  });
});

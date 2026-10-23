/** Phase D (D-106) — IMAP provider tests (Commit 13).
 *
 *  Exercises `createImapProvider` against an in-memory fake client so
 *  we don't need a wildduck / dovecot harness. The fake mimics the
 *  imapflow surface: connect / logout / mailboxOpen / search / fetch /
 *  idle + `exists` / `expunge` / `flags` / `close` event emission.
 *
 *  Coverage targets:
 *    - connect opens every configured folder
 *    - initialScan fetches the UIDs matching `since:` and streams
 *      canonical messages to the callback
 *    - onMessage returning false aborts the scan early
 *    - live sync: exists / expunge / flags translate to created /
 *      deleted / updated events
 *    - reconnect path: a `close` event while not stopping triggers
 *      client recreation
 *    - close()/logout(): clean teardown + double-close is a no-op
 *    - health surfaces last_successful_sync / error_count
 *    - canonicalizer folds RFC-822 → CanonicalMessage correctly
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  FetchMessageObject,
  FetchQueryObject,
  MailboxObject,
  SearchObject,
} from 'imapflow';

import {
  canonicalizeImap,
  createImapProvider,
  imapMessageDirectionForMailbox,
  type ImapClient,
  type ImapClientFactory,
  type ImapProviderConfig,
} from '../collections/mail/imap-provider.js';
import type {
  MailProvider,
  ProviderSyncCallback,
  ProviderSyncEvent,
} from '../collections/mail/provider.js';
import type { OAuthAccountStore } from '../collections/mail/oauth.js';

// ────────────────────────────────────────────────────────────────
// Fake IMAP client — programmatic messages + events per folder.
// ────────────────────────────────────────────────────────────────

interface FakeMessage {
  uid: number;
  seq?: number;
  source: Buffer;
  flags?: Set<string>;
  internalDate?: Date;
}

interface FakeFolder {
  path: string;
  messages: FakeMessage[];
  /** UIDNEXT as SELECT reports it; defaults to one past the highest UID. */
  uidNext?: number;
}

/** An IMAP UID set (`3`, `2:4`, `5:*`, `1,4,9`) against the folder's UIDs;
 *  `*` is the highest UID, and a range's ends may come in either order. */
const inUidSet = (set: string, uid: number, highest: number): boolean =>
  set.split(',').some((part) => {
    const [a, b = a] = part.split(':').map((end) => (end === '*' ? highest : Number(end)));
    return uid >= Math.min(a, b) && uid <= Math.max(a, b);
  });

interface FakeState {
  folders: Map<string, FakeFolder>;
  clients: FakeClient[];
  mailboxes?: Array<{ path: string; specialUse?: string }>;
  connectError?: Error;
  mailboxOpenError?: Error;
  mailboxOpenErrorPath?: string;
  fetchThrows?: boolean;
  fetches: Array<{ range: string | number[]; uidMode: boolean }>;
  /** UIDVALIDITY as SELECT reports it; 1 when unset. */
  uidValidity?: number;
  /** Messages the open folder claims beyond those it holds: a FETCH then
   *  comes back short of its EXISTS count. */
  phantomExists?: number;
}

class FakeClient extends EventEmitter implements ImapClient {
  usable = false;
  path = '';
  closed = false;

  constructor(private readonly state: FakeState) {
    super();
    state.clients.push(this);
  }

  async connect(): Promise<void> {
    if (this.state.connectError) throw this.state.connectError;
    this.usable = true;
  }

  async logout(): Promise<void> {
    this.usable = false;
    this.closed = true;
  }

  close(): void {
    this.usable = false;
    this.closed = true;
  }

  async mailboxOpen(path: string): Promise<MailboxObject> {
    if (
      this.state.mailboxOpenError
      && (this.state.mailboxOpenErrorPath === undefined
        || this.state.mailboxOpenErrorPath === path)
    ) {
      throw this.state.mailboxOpenError;
    }
    this.path = path;
    const folder = this.state.folders.get(path);
    const highest = Math.max(0, ...(folder?.messages.map((m) => m.uid) ?? []));
    return {
      path,
      delimiter: '/',
      flags: new Set(),
      exists: folder?.messages.length ?? 0,
      uidValidity: BigInt(this.state.uidValidity ?? 1),
      uidNext: folder?.uidNext ?? highest + 1,
    } as unknown as MailboxObject;
  }

  /** The open folder as the server last described it, as imapflow keeps it. */
  get mailbox(): MailboxObject | false {
    const folder = this.path ? this.state.folders.get(this.path) : undefined;
    if (!folder) return false;
    return { path: this.path, exists: folder.messages.length + (this.state.phantomExists ?? 0) } as unknown as MailboxObject;
  }

  async list(): Promise<Array<{ path: string; specialUse?: string }>> {
    return this.state.mailboxes ?? [...this.state.folders.keys()].map((path) => ({ path }));
  }

  async search(query: SearchObject, _o?: { uid?: boolean }): Promise<number[] | false> {
    const folder = this.state.folders.get(this.path);
    if (!folder) return [];
    const since = query.since ? new Date(query.since as string) : null;
    const uidSet = typeof query.uid === 'string' ? query.uid : null;
    const highest = Math.max(0, ...folder.messages.map((m) => m.uid));
    const out: number[] = [];
    for (const m of folder.messages) {
      const when = m.internalDate ?? new Date(0);
      if (since && when.getTime() < since.getTime()) continue;
      if (uidSet !== null && !inUidSet(uidSet, m.uid, highest)) continue;
      out.push(m.uid);
    }
    return out;
  }

  async *fetch(
    range: string | number[],
    _q: FetchQueryObject,
    _o?: { uid?: boolean },
  ): AsyncIterable<FetchMessageObject> {
    if (this.state.fetchThrows) throw new Error('boom');
    this.state.fetches.push({ range, uidMode: _o?.uid === true });
    const folder = this.state.folders.get(this.path);
    if (!folder) return;
    const highest = Math.max(0, ...folder.messages.map((m) => m.uid));
    const selected = Array.isArray(range)
      ? (_o?.uid === true
          ? range.map((uid) => folder.messages.find((message) => message.uid === uid))
          : range.map((seq) => folder.messages.find(
              (message, index) => (message.seq ?? index + 1) === seq,
            )))
      : _o?.uid === true
        ? folder.messages.filter((message) => inUidSet(range, message.uid, highest))
      : range.split(',').flatMap((part) => {
          const seq = Number.parseInt(part, 10);
          if (!Number.isSafeInteger(seq)) return [];
          const message = folder.messages.find(
            (candidate, index) => (candidate.seq ?? index + 1) === seq,
          );
          return message ? [message] : [];
        });
    for (const m of selected) {
      if (!m) continue;
      const index = folder.messages.indexOf(m);
      yield {
        seq: m.seq ?? index + 1,
        uid: m.uid,
        source: m.source,
        flags: m.flags,
        internalDate: m.internalDate,
      } as unknown as FetchMessageObject;
    }
  }

  async idle(): Promise<boolean> {
    return true;
  }
}

const makeFactory = (state: FakeState): ImapClientFactory => () =>
  new FakeClient(state);

const makeDeliveryStore = (): OAuthAccountStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    async get(key) { return data.get(key) ?? null; },
    async set(key, value) { data.set(key, value); },
    async delete(key) { data.delete(key); },
    async getAll() { return Object.fromEntries(data); },
  };
};

const makeRfc822 = (opts: {
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  body?: string;
  messageId?: string;
  references?: string;
  date?: string;
}): Buffer => {
  const lines = [
    `From: ${opts.from ?? 'alice@example.com'}`,
    `To: ${opts.to ?? 'bob@example.com'}`,
    ...(opts.cc ? [`Cc: ${opts.cc}`] : []),
    `Subject: ${opts.subject ?? 'hello'}`,
    `Message-ID: <${opts.messageId ?? 'msg-1@example.com'}>`,
    ...(opts.references ? [`References: <${opts.references}>`] : []),
    `Date: ${opts.date ?? 'Mon, 1 Jan 2024 10:00:00 +0000'}`,
    'Content-Type: text/plain; charset="utf-8"',
    '',
    opts.body ?? 'body text',
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8');
};

const makeRfc822WithAttachment = (opts: {
  filename?: string;
  mime?: string;
  bytes: Buffer;
}): Buffer => {
  const boundary = 'recued-test-boundary';
  const lines = [
    'From: alice@example.com',
    'To: bob@example.com',
    'Subject: attachment',
    'Message-ID: <attach@example.com>',
    'Date: Mon, 1 Jan 2024 10:00:00 +0000',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    '',
    'body',
    `--${boundary}`,
    `Content-Type: ${opts.mime ?? 'application/pdf'}`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${opts.filename ?? 'report.pdf'}"`,
    '',
    opts.bytes.toString('base64'),
    `--${boundary}--`,
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8');
};

const mkConfig = (overrides: Partial<ImapProviderConfig> = {}): ImapProviderConfig => ({
  host: 'imap.example.com',
  port: 993,
  secure: true,
  username: 'user',
  password: 'pass',
  folders: ['INBOX'],
  reconnectInitialMs: 1,
  reconnectCapMs: 4,
  ...overrides,
});

interface Harness {
  state: FakeState;
  provider: MailProvider;
  events: ProviderSyncEvent[];
  cb: ProviderSyncCallback;
  cfg: () => ImapProviderConfig;
}

const newHarness = (opts: {
  cfg?: Partial<ImapProviderConfig>;
  seed?: Record<string, FakeMessage[]>;
  connectError?: Error;
  mailboxOpenError?: Error;
  mailboxOpenErrorPath?: string;
  mailboxes?: Array<{ path: string; specialUse?: string }>;
  deliveryStore?: OAuthAccountStore;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
} = {}): Harness => {
  const state: FakeState = {
    folders: new Map(),
    clients: [],
    connectError: opts.connectError,
    mailboxOpenError: opts.mailboxOpenError,
    mailboxOpenErrorPath: opts.mailboxOpenErrorPath,
    mailboxes: opts.mailboxes,
    fetches: [],
  };
  const seed = opts.seed ?? { INBOX: [] };
  for (const [path, messages] of Object.entries(seed)) {
    state.folders.set(path, { path, messages });
  }
  const cfg = (): ImapProviderConfig => mkConfig({ folders: Object.keys(seed), ...opts.cfg });
  const provider = createImapProvider({
    slug: 'work',
    config: cfg,
    clientFactory: makeFactory(state),
    sleep: opts.sleep ?? (() => Promise.resolve()),
    ...(opts.deliveryStore ? { deliveryStore: opts.deliveryStore } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  const events: ProviderSyncEvent[] = [];
  const cb: ProviderSyncCallback = async (e) => { events.push(e); };
  return { state, provider, events, cb, cfg };
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitForEvent = async (
  events: readonly ProviderSyncEvent[],
  predicate: (event: ProviderSyncEvent) => boolean,
): Promise<ProviderSyncEvent | undefined> => {
  const deadline = Date.now() + 3_000;
  do {
    const event = events.find(predicate);
    if (event) return event;
    await sleep(25);
  } while (Date.now() < deadline);
  return events.find(predicate);
};

const waitForCondition = async (predicate: () => boolean): Promise<boolean> => {
  const deadline = Date.now() + 3_000;
  do {
    if (predicate()) return true;
    await sleep(25);
  } while (Date.now() < deadline);
  return predicate();
};

let h: Harness;
afterEach(async () => { await h?.provider.close(); });

// ────────────────────────────────────────────────────────────────
// connect + initialScan
// ────────────────────────────────────────────────────────────────

describe('ImapProvider — connect', () => {
  it('does not resume before it is connected, nor without a stored cursor', async () => {
    h = newHarness();
    expect(h.provider.resumesFromCursor).toBe(false);
    await h.provider.connect();
    expect(h.provider.resumesFromCursor).toBe(false);
  });

  it('opens one client per configured folder', async () => {
    h = newHarness({ seed: { INBOX: [], Archive: [] } });
    await h.provider.connect();
    expect(h.state.clients.length).toBe(2);
    expect(h.state.clients[0].path).toBe('INBOX');
    expect(h.state.clients[1].path).toBe('Archive');
  });

  it('carries a localized folder special-use direction through real provider ingest', async () => {
    h = newHarness({
      seed: {
        Gesendet: [{
          uid: 1,
          source: makeRfc822({ from: 'owner@example.com' }),
          flags: new Set(),
          internalDate: new Date(),
        }],
      },
      mailboxes: [{ path: 'Gesendet', specialUse: '\\Sent' }],
    });
    await h.provider.connect();
    const directions: unknown[] = [];
    await h.provider.initialScan({
      backfill_days: 30,
      onMessage: async (message) => {
        directions.push(message.direction);
        return true;
      },
    });

    expect(directions).toEqual(['outbound']);
  });

  it('surfaces connect errors to the caller', async () => {
    h = newHarness({ connectError: new Error('offline') });
    await expect(h.provider.connect()).rejects.toThrow(/offline/);
  });

  it('surfaces mailboxOpen errors to the caller', async () => {
    h = newHarness({ mailboxOpenError: new Error('no such folder') });
    await expect(h.provider.connect()).rejects.toThrow(/no such folder/);
  });

  it('closes folders opened before a later folder fails to connect', async () => {
    h = newHarness({
      seed: { INBOX: [], Archive: [] },
      mailboxOpenError: new Error('archive unavailable'),
      mailboxOpenErrorPath: 'Archive',
    });

    await expect(h.provider.connect()).rejects.toThrow('archive unavailable');

    expect(h.state.clients).toHaveLength(2);
    expect(h.state.clients[0]?.path).toBe('INBOX');
    expect(h.state.clients.every((client) => client.closed || !client.usable)).toBe(true);
  });
});

describe('ImapProvider — initialScan', () => {
  it('streams canonical messages matching since:', async () => {
    const msg1 = {
      uid: 1,
      source: makeRfc822({ subject: 'first', messageId: 'a@x' }),
      flags: new Set<string>(['\\Seen']),
      internalDate: new Date('2026-04-01T00:00:00Z'),
    };
    const msg2 = {
      uid: 2,
      source: makeRfc822({ subject: 'second', messageId: 'b@x' }),
      flags: new Set<string>(),
      internalDate: new Date('2026-04-15T00:00:00Z'),
    };
    h = newHarness({ seed: { INBOX: [msg1, msg2] } });
    await h.provider.connect();

    const got: string[] = [];
    await h.provider.initialScan({
      backfill_days: 365,
      onMessage: async (m) => { got.push(m.subject); return true; },
    });
    expect(got.sort()).toEqual(['first', 'second']);
  });

  it('honors onMessage returning false (abort)', async () => {
    const msgs = [1, 2, 3].map((uid) => ({
      uid,
      source: makeRfc822({ subject: `s${uid}`, messageId: `id-${uid}@x` }),
      flags: new Set<string>(),
      internalDate: new Date(),
    }));
    h = newHarness({ seed: { INBOX: msgs } });
    await h.provider.connect();
    const got: string[] = [];
    await h.provider.initialScan({
      backfill_days: 30,
      onMessage: async (m) => { got.push(m.subject); return got.length < 2; },
    });
    expect(got.length).toBe(2);
  });

  it('throws when called before connect()', async () => {
    h = newHarness();
    await expect(h.provider.initialScan({ backfill_days: 7, onMessage: async () => true }))
      .rejects.toThrow(/before connect/);
  });

  it('rejects an incomplete folder scan after recording the error', async () => {
    h = newHarness({ seed: { INBOX: [{
      uid: 1,
      source: makeRfc822({}),
      flags: new Set(),
      internalDate: new Date(),
    }] } });
    await h.provider.connect();
    h.state.fetchThrows = true;
    await expect(h.provider.initialScan({
      backfill_days: 30,
      onMessage: async () => true,
    })).rejects.toThrow('imap initial scan was incomplete');
    expect(h.provider.health().error_count_24h).toBeGreaterThan(0);
  });

  it('rejects an initial scan item whose RFC-822 source is missing', async () => {
    h = newHarness({ seed: { INBOX: [{
      uid: 7,
      source: undefined as unknown as Buffer,
      flags: new Set(),
      internalDate: new Date(),
    }] } });
    await h.provider.connect();

    await expect(h.provider.initialScan({
      backfill_days: 30,
      onMessage: async () => true,
    })).rejects.toThrow('imap initial scan was incomplete');
  });
});

// ────────────────────────────────────────────────────────────────
// Live sync via event emission
// ────────────────────────────────────────────────────────────────

describe('ImapProvider — live sync', () => {
  it('translates exists → created for each new UID', async () => {
    h = newHarness({ seed: { INBOX: [] } });
    await h.provider.connect();
    const stop = await h.provider.startSync(h.cb);

    // Arriving message — seed the folder then simulate an EXISTS push.
    h.state.folders.get('INBOX')!.messages.push({
      uid: 900,
      source: makeRfc822({ subject: 'new' }),
      flags: new Set(),
      internalDate: new Date(),
    });
    h.state.clients[0].emit('exists', { count: 1, prevCount: 0, path: 'INBOX' });

    const created = await waitForEvent(h.events, (e) => e.kind === 'created');
    expect(created).toBeDefined();
    expect(created?.message?.subject).toBe('new');
    expect(created?.source_id).toBe('900@INBOX');
    expect(h.state.fetches).toContainEqual({ range: '1', uidMode: false });
    await stop();
  });

  it('replays a rejected IDLE delivery from the durable journal after restart', async () => {
    const deliveryStore = makeDeliveryStore();
    const never = (): Promise<void> => new Promise(() => {});
    const first = newHarness({
      seed: { INBOX: [{
        uid: 41,
        source: makeRfc822({ subject: 'retry me', messageId: 'retry@example.com' }),
        flags: new Set(),
        internalDate: new Date(),
      }] },
      deliveryStore,
      sleep: never,
    });
    h = first;
    await first.provider.connect();
    await first.provider.startSync(async () => {
      throw new Error('collection unavailable');
    });
    first.state.clients[0].emit('exists', { count: 1, prevCount: 0, path: 'INBOX' });

    // The folder's UID cursor is kept beside the journal.
    const journal = (): string[] => [...deliveryStore.data.keys()].filter((key) => key.includes('.pending_delivery.'));
    expect(await waitForCondition(() => journal().length === 1)).toBe(true);
    await first.provider.close();

    const recovered = newHarness({
      seed: { INBOX: [{
        uid: 41,
        source: makeRfc822({ subject: 'retry me', messageId: 'retry@example.com' }),
        flags: new Set(),
        internalDate: new Date(),
      }] },
      deliveryStore,
    });
    h = recovered;
    await recovered.provider.connect();
    await recovered.provider.startSync(recovered.cb);

    const replayed = await waitForEvent(
      recovered.events,
      (event) => event.kind === 'created' && event.source_id === '41@INBOX',
    );
    expect(replayed).toBeDefined();
    expect(journal()).toHaveLength(0);
  });

  it('drains an admitted IDLE callback before the sync stop resolves', async () => {
    h = newHarness({ seed: { INBOX: [{
      uid: 12,
      source: makeRfc822({ subject: 'in flight' }),
      flags: new Set(),
      internalDate: new Date(),
    }] } });
    await h.provider.connect();
    let release!: () => void;
    let markStarted!: () => void;
    const callbackWait = new Promise<void>((resolve) => { release = resolve; });
    const callbackStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const stop = await h.provider.startSync(async () => {
      markStarted();
      await callbackWait;
    });
    h.state.clients[0].emit('exists', { count: 1, prevCount: 0, path: 'INBOX' });
    await callbackStarted;

    let stopped = false;
    const stopping = stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    release();
    await stopping;
    expect(stopped).toBe(true);
  });

  it('translates expunge → deleted', async () => {
    h = newHarness({ seed: { INBOX: [] } });
    await h.provider.connect();
    const stop = await h.provider.startSync(h.cb);
    h.state.clients[0].emit('expunge', { uid: 7, seq: 7, path: 'INBOX' });
    const deleted = await waitForEvent(
      h.events,
      (e) => e.kind === 'deleted' && e.source_id === '7@INBOX',
    );
    expect(deleted).toBeDefined();
    await stop();
  });

  it('translates flags → updated with the new canonical message', async () => {
    h = newHarness({ seed: { INBOX: [{
      uid: 3,
      source: makeRfc822({ subject: 'flagged' }),
      flags: new Set(['\\Seen']),
      internalDate: new Date(),
    }] } });
    await h.provider.connect();
    const stop = await h.provider.startSync(h.cb);
    h.state.clients[0].emit('flags', { uid: 3, seq: 3, path: 'INBOX', flags: new Set(['\\Seen']) });
    const updated = await waitForEvent(h.events, (e) => e.kind === 'updated');
    expect(updated?.message?.is_read).toBe(true);
    await stop();
  });

  it('throws when startSync called before connect', async () => {
    h = newHarness();
    await expect(h.provider.startSync(h.cb)).rejects.toThrow(/before connect/);
  });
});

// ────────────────────────────────────────────────────────────────
// Reconnect on close
// ────────────────────────────────────────────────────────────────

// IDLE reports only what happens while it is attached: mail that came while a
// folder's connection was down was counted into its size and never fetched
// until a restart's re-list, and a message expunged meanwhile stayed.
describe('ImapProvider — catching up on what it missed', () => {
  const DAY = 86_400_000;
  const T0 = Date.UTC(2026, 9, 21, 12);
  const mail = (uid: number, at: number): FakeMessage => ({
    uid,
    source: makeRfc822({ subject: `uid ${uid}`, messageId: `<uid-${uid}@example.com>` }),
    internalDate: new Date(at),
  });
  const reconnect = async (): Promise<void> => {
    const before = h.state.clients.length;
    h.state.clients[before - 1].emit('close');
    expect(await waitForCondition(() => h.state.clients.length > before)).toBe(true);
  };
  const scan = async (days: number): Promise<void> => {
    await h.provider.initialScan({ backfill_days: days, onMessage: async () => true });
  };

  it('fetches the mail that arrived while the connection was down', async () => {
    h = newHarness({ seed: { INBOX: [mail(1, Date.now())] } });
    await h.provider.connect();
    await scan(30);
    await h.provider.startSync(h.cb);
    h.state.folders.get('INBOX')!.messages.push(mail(2, Date.now()));
    await reconnect();
    expect(await waitForEvent(h.events, (e) => e.kind === 'created' && e.source_id === '2@INBOX')).toBeDefined();
    await sleep(50);
    expect(h.events.filter((e) => e.source_id === '2@INBOX')).toHaveLength(1);
    expect(h.events.some((e) => e.source_id === '1@INBOX')).toBe(false);
  });

  it('reports a message expunged meanwhile, and not one that only left the window', async () => {
    let now = T0;
    h = newHarness({ seed: { INBOX: [mail(1, T0 - 2 * DAY), mail(2, T0)] }, now: () => now });
    await h.provider.connect();
    await scan(3);
    await h.provider.startSync(h.cb);
    // Two days on, uid 1 is older than the window; uid 2 was deleted.
    now = T0 + 2 * DAY;
    const inbox = h.state.folders.get('INBOX')!;
    inbox.messages = inbox.messages.filter((m) => m.uid !== 2);
    await reconnect();
    expect(await waitForEvent(h.events, (e) => e.kind === 'deleted' && e.source_id === '2@INBOX')).toBeDefined();
    await sleep(50);
    expect(h.events.some((e) => e.source_id === '1@INBOX')).toBe(false);
  });

  it('fetches mail that arrived after the first scan, before IDLE attached', async () => {
    h = newHarness({ seed: { INBOX: [mail(1, Date.now())] } });
    await h.provider.connect();
    await scan(30);
    h.state.folders.get('INBOX')!.messages.push(mail(2, Date.now()));
    await h.provider.startSync(h.cb);
    expect(await waitForEvent(h.events, (e) => e.kind === 'created' && e.source_id === '2@INBOX')).toBeDefined();
    expect(h.events.some((e) => e.source_id === '1@INBOX')).toBe(false);
  });

  // A restart: the stored UID cursor reaches what was added while the server
  // was down, so the collection lists only the days since the last sync.
  describe('across a restart, from the stored cursor', () => {
    const cursorOf = (store: ReturnType<typeof makeDeliveryStore>): number | undefined => {
      const raw = store.data.get(`imap.work.cursor.${Buffer.from('INBOX', 'utf8').toString('base64url')}`);
      return raw === undefined ? undefined : (JSON.parse(raw) as { uid_next: number }).uid_next;
    };
    const firstSession = async (store: ReturnType<typeof makeDeliveryStore>): Promise<void> => {
      h = newHarness({ seed: { INBOX: [mail(1, Date.now())] }, deliveryStore: store });
      await h.provider.connect();
      expect(h.provider.resumesFromCursor).toBe(false);
      await scan(30);
      await h.provider.startSync(h.cb);
      expect(await waitForCondition(() => cursorOf(store) === 2)).toBe(true);
      await h.provider.close();
    };

    it('fetches mail moved in while the server was down, though its date is older than the listed days', async () => {
      const store = makeDeliveryStore();
      await firstSession(store);
      // While down: a message moved in from another folder (its date is old)
      // and one that arrived today.
      h = newHarness({ seed: { INBOX: [mail(1, Date.now()), mail(2, Date.now() - 200 * DAY), mail(3, Date.now())] }, deliveryStore: store });
      await h.provider.connect();
      expect(h.provider.resumesFromCursor).toBe(true);
      const scanned: string[] = [];
      await h.provider.initialScan({ backfill_days: 2, onMessage: async (m) => { scanned.push(m.source_id); return true; } });
      await h.provider.startSync(h.cb);
      expect(await waitForEvent(h.events, (e) => e.kind === 'created' && e.source_id === '2@INBOX')).toBeDefined();
      expect(scanned.sort()).toEqual(['1@INBOX', '3@INBOX']);
      expect(h.events.some((e) => e.source_id === '3@INBOX')).toBe(false);
      expect(await waitForCondition(() => cursorOf(store) === 4)).toBe(true);
    });

    it('does not resume a mailbox renumbered while the server was down', async () => {
      const store = makeDeliveryStore();
      await firstSession(store);
      h = newHarness({ seed: { INBOX: [mail(5, Date.now())] }, deliveryStore: store });
      h.state.uidValidity = 2;
      await h.provider.connect();
      expect(h.provider.resumesFromCursor).toBe(false);
    });

    it('moves past what IDLE delivers, and holds after a batch it could not deliver', async () => {
      const store = makeDeliveryStore();
      await firstSession(store);
      h = newHarness({ seed: { INBOX: [mail(1, Date.now())] }, deliveryStore: store });
      await h.provider.connect();
      await scan(2);
      let refuse = false;
      await h.provider.startSync(async (event) => {
        if (refuse) throw new Error('collection unavailable');
        h.events.push(event);
      });
      const inbox = h.state.folders.get('INBOX')!;
      inbox.messages.push(mail(2, Date.now()));
      h.state.clients[h.state.clients.length - 1].emit('exists', { count: 2, prevCount: 1, path: 'INBOX' });
      expect(await waitForCondition(() => cursorOf(store) === 3)).toBe(true);

      refuse = true;
      inbox.messages.push(mail(3, Date.now()));
      h.state.clients[h.state.clients.length - 1].emit('exists', { count: 3, prevCount: 2, path: 'INBOX' });
      await sleep(100);
      expect(cursorOf(store)).toBe(3);
    });

    const flagged = (message: FakeMessage, ...flags: string[]): FakeMessage => ({ ...message, flags: new Set(flags) });
    const firstOfThree = async (store: ReturnType<typeof makeDeliveryStore>): Promise<void> => {
      h = newHarness({ seed: { INBOX: [mail(1, Date.now() - 90 * DAY), mail(2, Date.now() - 60 * DAY), mail(3, Date.now() - 30 * DAY)] }, deliveryStore: store });
      await h.provider.connect();
      await scan(400);
      await h.provider.startSync(h.cb);
      expect(await waitForCondition(() => cursorOf(store) === 4)).toBe(true);
      // A first start has no numbering to check its rows against.
      expect(h.events.some((e) => e.kind === 'folder')).toBe(false);
      await h.provider.close();
    };

    it('reads every message\'s flags once, and hands the folder to the collection', async () => {
      const store = makeDeliveryStore();
      await firstOfThree(store);
      // While down, on another client: 1 read, 2 deleted, 3 starred.
      h = newHarness({
        seed: { INBOX: [flagged(mail(1, Date.now() - 90 * DAY), '\\Seen'), flagged(mail(3, Date.now() - 30 * DAY), '\\Flagged')] },
        deliveryStore: store,
      });
      await h.provider.connect();
      await scan(2);
      const before = h.state.fetches.length;
      await h.provider.startSync(h.cb);
      const folder = await waitForEvent(h.events, (e) => e.kind === 'folder');
      expect(folder).toMatchObject({ source_id: 'INBOX', folder: { folder: 'INBOX' } });
      expect([...folder!.folder!.messages]).toEqual([
        ['1@INBOX', { is_read: true, is_flagged: false }],
        ['3@INBOX', { is_read: false, is_flagged: true }],
      ]);
      // One FETCH of flags, not one per message; and the provider reports no
      // deletion of its own: the collection decides from the rows it holds.
      expect(h.state.fetches.slice(before)).toEqual([{ range: '1:*', uidMode: true }]);
      expect(h.events.filter((e) => e.kind !== 'folder')).toEqual([]);
    });

    it('hands over nothing when the read comes back short of what the folder holds', async () => {
      const store = makeDeliveryStore();
      await firstOfThree(store);
      h = newHarness({ seed: { INBOX: [mail(1, Date.now() - 90 * DAY)] }, deliveryStore: store });
      h.state.phantomExists = 1;
      await h.provider.connect();
      await scan(2);
      await h.provider.startSync(h.cb);
      expect(await waitForCondition(() => h.state.fetches.some((f) => f.range === '1:*'))).toBe(true);
      await sleep(50);
      expect(h.events).toEqual([]);
      expect(h.provider.health().error_count_24h).toBeGreaterThan(0);
    });
  });

  it('compares nothing when the mailbox was renumbered (UIDVALIDITY changed)', async () => {
    h = newHarness({ seed: { INBOX: [mail(1, Date.now())] } });
    await h.provider.connect();
    await scan(30);
    await h.provider.startSync(h.cb);
    h.state.uidValidity = 2;
    h.state.folders.get('INBOX')!.messages = [mail(7, Date.now())];
    await reconnect();
    await sleep(100);
    expect(h.events).toEqual([]);
  });
});

describe('ImapProvider — reconnect', () => {
  it('re-opens the client when the underlying connection drops', async () => {
    h = newHarness({ seed: { INBOX: [] } });
    await h.provider.connect();
    await h.provider.startSync(h.cb);

    const firstClient = h.state.clients[0];
    firstClient.emit('close');
    // Reconnect sleeps via our injected zero-sleep hook; give the
    // event loop one more tick for the async factory + connect chain.
    expect(await waitForCondition(() => h.state.clients.length > 1)).toBe(true);
    const latest = h.state.clients[h.state.clients.length - 1];
    expect(latest.path).toBe('INBOX');
  });

  it('does not reconnect after close()', async () => {
    h = newHarness({ seed: { INBOX: [] } });
    await h.provider.connect();
    await h.provider.startSync(h.cb);
    await h.provider.close();
    const before = h.state.clients.length;
    // Even if a residual close event fires, provider is stopped.
    await sleep(20);
    expect(h.state.clients.length).toBe(before);
  });
});

// ────────────────────────────────────────────────────────────────
// close / idempotency / health
// ────────────────────────────────────────────────────────────────

describe('ImapProvider — close + health', () => {
  it('logs out every client on close() and is idempotent', async () => {
    h = newHarness({ seed: { INBOX: [], Archive: [] } });
    await h.provider.connect();
    await h.provider.close();
    expect(h.state.clients.every((c) => c.closed || !c.usable)).toBe(true);
    await h.provider.close();
  });

  it('health reflects sync progress + errors', async () => {
    h = newHarness({ seed: { INBOX: [{
      uid: 1,
      source: makeRfc822({}),
      flags: new Set(),
      internalDate: new Date('2026-04-10T00:00:00Z'),
    }] } });
    await h.provider.connect();
    await h.provider.initialScan({ backfill_days: 30, onMessage: async () => true });
    const hr = h.provider.health();
    expect(hr.last_successful_sync_at).toBeGreaterThan(0);
    expect(hr.error_count_24h).toBe(0);
    expect(hr.pending_queue_size).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Canonicalizer — direct unit tests
// ────────────────────────────────────────────────────────────────

describe('canonicalizeImap', () => {
  it('extracts from / to / cc / subject / body', async () => {
    const source = makeRfc822({
      from: 'alice@example.com',
      to: 'bob@example.com',
      cc: 'carol@example.com',
      subject: 'Q3 review',
      body: 'plain body',
    });
    const canonical = await canonicalizeImap(source, {
      uid: 42,
      folder: 'INBOX',
      flags: new Set(['\\Seen']),
      internalDate: new Date('2026-04-10T00:00:00Z'),
    });
    expect(canonical.from).toBe('alice@example.com');
    expect(canonical.to).toEqual(['bob@example.com']);
    expect(canonical.cc).toEqual(['carol@example.com']);
    expect(canonical.subject).toBe('Q3 review');
    expect(canonical.body_text.trim()).toBe('plain body');
    expect(canonical.is_read).toBe(true);
    expect(canonical.folder_or_label).toBe('INBOX');
    expect(canonical.direction).toBe('inbound');
    expect(canonical.source_id).toBe('42@INBOX');
  });

  it('uses RFC special-use flags for localized Sent and Drafts folder names', () => {
    const mailboxes = [
      { path: 'Gesendet', specialUse: '\\Sent' },
      { path: 'Brouillons', specialUse: '\\Drafts' },
    ];

    expect(imapMessageDirectionForMailbox('Gesendet', mailboxes)).toBe('outbound');
    expect(imapMessageDirectionForMailbox('Brouillons', mailboxes)).toBe('draft');
    expect(imapMessageDirectionForMailbox('Projet secret', mailboxes)).toBe('unknown');
  });

  it('names Sent and Drafts by the folders the send and draft lookups fall back to, when no folder is flagged', () => {
    const plain = [{ path: 'INBOX' }, { path: 'Sent Items' }, { path: 'Sent' }, { path: 'Drafts' }, { path: 'Archive' }];
    // The first candidate the server lists, as `findSentFolder` picks it.
    expect(imapMessageDirectionForMailbox('Sent', plain)).toBe('outbound');
    expect(imapMessageDirectionForMailbox('Sent Items', plain)).toBe('unknown');
    expect(imapMessageDirectionForMailbox('Drafts', plain)).toBe('draft');
    expect(imapMessageDirectionForMailbox('Archive', plain)).toBe('unknown');
    // A flagged folder is the one: a plain "Sent" beside it is not.
    const flagged = [...plain, { path: 'Gesendet', specialUse: '\\Sent' }];
    expect(imapMessageDirectionForMailbox('Sent', flagged)).toBe('unknown');
    expect(imapMessageDirectionForMailbox('Gesendet', flagged)).toBe('outbound');
  });

  it('derives thread_id from References header', async () => {
    const source = makeRfc822({
      messageId: 'child@x',
      references: 'root@x',
    });
    const canonical = await canonicalizeImap(source, {
      uid: 1,
      folder: 'INBOX',
      flags: new Set(),
      internalDate: new Date(),
    });
    expect(canonical.thread_id).toBe('root@x');
  });

  it('falls back to Message-ID when no references', async () => {
    const source = makeRfc822({ messageId: 'only@x' });
    const canonical = await canonicalizeImap(source, {
      uid: 1,
      folder: 'INBOX',
      flags: new Set(),
      internalDate: new Date(),
    });
    expect(canonical.thread_id).toBe('only@x');
  });

  it('strips HTML when no plaintext present', async () => {
    const html = [
      'From: a@x',
      'To: b@x',
      'Subject: html only',
      'Message-ID: <h@x>',
      'Content-Type: text/html',
      '',
      '<p>Hello <b>world</b></p>',
    ].join('\r\n');
    const canonical = await canonicalizeImap(Buffer.from(html), {
      uid: 1,
      folder: 'INBOX',
      flags: new Set(),
      internalDate: new Date(),
    });
    expect(canonical.body_text).toContain('Hello');
    expect(canonical.body_text).toContain('world');
    expect(canonical.body_text).not.toContain('<b>');
    expect(canonical.body_html).toBeDefined();
  });

  it('surfaces MIME attachment parts with copied bytes', async () => {
    const bytes = Buffer.from('%PDF-1.4 imap attachment bytes');
    const canonical = await canonicalizeImap(
      makeRfc822WithAttachment({
        filename: '../report.pdf',
        mime: 'application/pdf',
        bytes,
      }),
      {
        uid: 1,
        folder: 'INBOX',
        flags: new Set(),
        internalDate: new Date(),
      },
    );
    const part = canonical.attachments![0];
    expect(part).toMatchObject({
      filename: 'report.pdf',
      mime_type: 'application/pdf',
      size: bytes.length,
      source_part_id: 'part-0',
    });
    await expect(part.fetchBytes()).resolves.toEqual(bytes);
  });
});

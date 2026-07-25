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
  type ImapClient,
  type ImapClientFactory,
  type ImapProviderConfig,
} from '../collections/mail/imap-provider.js';
import type {
  MailProvider,
  ProviderSyncCallback,
  ProviderSyncEvent,
} from '../collections/mail/provider.js';

// ────────────────────────────────────────────────────────────────
// Fake IMAP client — programmatic messages + events per folder.
// ────────────────────────────────────────────────────────────────

interface FakeMessage {
  uid: number;
  source: Buffer;
  flags?: Set<string>;
  internalDate?: Date;
}

interface FakeFolder {
  path: string;
  messages: FakeMessage[];
}

interface FakeState {
  folders: Map<string, FakeFolder>;
  clients: FakeClient[];
  connectError?: Error;
  mailboxOpenError?: Error;
  fetchThrows?: boolean;
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
    if (this.state.mailboxOpenError) throw this.state.mailboxOpenError;
    this.path = path;
    return {
      path,
      delimiter: '/',
      flags: new Set(),
      exists: this.state.folders.get(path)?.messages.length ?? 0,
    } as unknown as MailboxObject;
  }

  async search(query: SearchObject, _o?: { uid?: boolean }): Promise<number[] | false> {
    const folder = this.state.folders.get(this.path);
    if (!folder) return [];
    const since = query.since ? new Date(query.since as string) : null;
    if (!since) return folder.messages.map((m) => m.uid);
    const out: number[] = [];
    for (const m of folder.messages) {
      const when = m.internalDate ?? new Date(0);
      if (when.getTime() >= since.getTime()) out.push(m.uid);
    }
    return out;
  }

  async *fetch(
    range: string | number[],
    _q: FetchQueryObject,
    _o?: { uid?: boolean },
  ): AsyncIterable<FetchMessageObject> {
    if (this.state.fetchThrows) throw new Error('boom');
    const folder = this.state.folders.get(this.path);
    if (!folder) return;
    const uids = Array.isArray(range) ? range : [];
    for (const uid of uids) {
      const m = folder.messages.find((x) => x.uid === uid);
      if (!m) continue;
      yield {
        seq: uid,
        uid,
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
} = {}): Harness => {
  const state: FakeState = {
    folders: new Map(),
    clients: [],
    connectError: opts.connectError,
    mailboxOpenError: opts.mailboxOpenError,
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
    sleep: () => Promise.resolve(),
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
  it('opens one client per configured folder', async () => {
    h = newHarness({ seed: { INBOX: [], Archive: [] } });
    await h.provider.connect();
    expect(h.state.clients.length).toBe(2);
    expect(h.state.clients[0].path).toBe('INBOX');
    expect(h.state.clients[1].path).toBe('Archive');
  });

  it('surfaces connect errors to the caller', async () => {
    h = newHarness({ connectError: new Error('offline') });
    await expect(h.provider.connect()).rejects.toThrow(/offline/);
  });

  it('surfaces mailboxOpen errors to the caller', async () => {
    h = newHarness({ mailboxOpenError: new Error('no such folder') });
    await expect(h.provider.connect()).rejects.toThrow(/no such folder/);
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

  it('marks errors when fetch throws but keeps the provider alive', async () => {
    h = newHarness({ seed: { INBOX: [{
      uid: 1,
      source: makeRfc822({}),
      flags: new Set(),
      internalDate: new Date(),
    }] } });
    await h.provider.connect();
    h.state.fetchThrows = true;
    await h.provider.initialScan({ backfill_days: 30, onMessage: async () => true });
    expect(h.provider.health().error_count_24h).toBeGreaterThan(0);
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
      uid: 1,
      source: makeRfc822({ subject: 'new' }),
      flags: new Set(),
      internalDate: new Date(),
    });
    h.state.clients[0].emit('exists', { count: 1, prevCount: 0, path: 'INBOX' });

    const created = await waitForEvent(h.events, (e) => e.kind === 'created');
    expect(created).toBeDefined();
    expect(created?.message?.subject).toBe('new');
    await stop();
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
    expect(canonical.source_id).toBe('42@INBOX');
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

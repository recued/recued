/** D-264 slice 1 — `draft_capable` is its OWN axis.
 *
 *  The whole point of the field is that it is not a synonym. Two aliases would
 *  satisfy any test that only ever checks them together, so every case here
 *  drives them APART:
 *
 *    - `draft_capable` vs `send_capable` — independent in BOTH directions.
 *      IMAP without SMTP can APPEND; a Gmail grant of `gmail.send` without
 *      `gmail.modify` can send and cannot draft.
 *    - `draftCapable` vs `mutationCapable` on the IMAP provider — same lazy
 *      shape, different PROBE. D-239 asks for the flag/move/delete quartet;
 *      drafting asks for `list` + `append`, which is what the Sent-folder
 *      APPEND path already requires.
 *
 *  A single shared boolean behind either pair would pass a test that asserts
 *  only agreement, so the fixtures below deliberately make each pair disagree.
 */

import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import type { MailboxObject } from 'imapflow';
import { createBlobStore } from '../../../storage/blob-store.js';
import { createMailCollection } from '../mail-collection.js';
import type { MailProvider } from '../provider.js';
import { handleMailEnrollImap, handleMailList, type MailEnrollDeps } from '../enroll.js';
import {
  createImapProvider,
  type ImapClient,
  type ImapClientFactory,
  type ImapProviderConfig,
} from '../imap-provider.js';
import { createInstanceStore, type CollectionInstanceStore } from '../../instance-store.js';
import type { OAuthAccountStore } from '../oauth.js';

// ────────────────────────────────────────────────────────────────
// Doubles
// ────────────────────────────────────────────────────────────────

const makeStore = (): OAuthAccountStore => {
  const data = new Map<string, string>();
  return {
    async get(k) { return data.get(k) ?? null; },
    async set(k, v) { data.set(k, v); },
    async delete(k) { data.delete(k); },
    async getAll() { return Object.fromEntries(data); },
  };
};

/** The required surface only. Every optional verb is absent, so this client is
 *  neither mutation- nor draft-capable — the floor both probes start from. */
class BareImapClient extends EventEmitter implements ImapClient {
  usable = true;
  async connect(): Promise<void> { /* no-op */ }
  async logout(): Promise<void> { this.usable = false; }
  close(): void { this.usable = false; }
  async mailboxOpen(path: string): Promise<MailboxObject> {
    return { path, delimiter: '/', flags: new Set(), exists: 0 } as unknown as MailboxObject;
  }
  async search(): Promise<number[]> { return []; }
  async *fetch(): AsyncIterable<never> { /* yields nothing */ }
  async idle(): Promise<boolean> { return true; }
}

/** `list` + `append` — what an APPEND into `\Drafts` needs, and nothing else. */
class DraftOnlyImapClient extends BareImapClient {
  async list(): Promise<Array<{ path: string; specialUse?: string }>> {
    return [{ path: 'Drafts', specialUse: '\\Drafts' }];
  }
  async append(): Promise<void> { /* accepted */ }
}

/** D-239's quartet, and NOT the draft pair. */
class MutateOnlyImapClient extends BareImapClient {
  async messageFlagsAdd(): Promise<boolean> { return true; }
  async messageFlagsRemove(): Promise<boolean> { return true; }
  async messageMove(): Promise<boolean> { return true; }
  async messageDelete(): Promise<boolean> { return true; }
}

class FullImapClient extends DraftOnlyImapClient {
  async messageFlagsAdd(): Promise<boolean> { return true; }
  async messageFlagsRemove(): Promise<boolean> { return true; }
  async messageMove(): Promise<boolean> { return true; }
  async messageDelete(): Promise<boolean> { return true; }
}

const factoryFor = (make: () => ImapClient): ImapClientFactory => () => make();

const imapProviderWith = (make: () => ImapClient, smtp?: Record<string, unknown>) =>
  createImapProvider({
    slug: 'probe',
    config: (): ImapProviderConfig => ({
      host: 'imap.example.com', port: 993, secure: true,
      username: 'me@example.com', folders: ['INBOX'],
      ...(smtp ? { smtp } : {}),
    } as ImapProviderConfig),
    clientFactory: factoryFor(make),
  });

interface Harness {
  deps: MailEnrollDeps;
  instances: CollectionInstanceStore;
}

const newHarness = (draftCapable?: (slug: string) => boolean | undefined): Harness => {
  const db = new Database(':memory:');
  const instances = createInstanceStore({ db });
  const deps: MailEnrollDeps = {
    instances,
    accountStore: makeStore(),
    ...(draftCapable ? { draftCapable } : {}),
  };
  return { deps, instances };
};

// ────────────────────────────────────────────────────────────────
// The provider probes, held apart
// ────────────────────────────────────────────────────────────────

describe('D-264 — the IMAP draft probe is not the D-239 mutation probe', () => {
  it('answers each pair from its OWN methods, and the two disagree in both directions', () => {
    const draftOnly = imapProviderWith(() => new DraftOnlyImapClient());
    expect(draftOnly.draftCapable).toBe(true);
    expect(draftOnly.mutationCapable).toBe(false);

    const mutateOnly = imapProviderWith(() => new MutateOnlyImapClient());
    expect(mutateOnly.draftCapable).toBe(false);
    expect(mutateOnly.mutationCapable).toBe(true);
  });

  it('agrees only when the client actually carries both groups', () => {
    const bare = imapProviderWith(() => new BareImapClient());
    expect(bare.draftCapable).toBe(false);
    expect(bare.mutationCapable).toBe(false);

    const full = imapProviderWith(() => new FullImapClient());
    expect(full.draftCapable).toBe(true);
    expect(full.mutationCapable).toBe(true);
  });

  it('is independent of sendCapable — APPEND needs no SMTP', () => {
    // The case D-264 exists for: a read-only-to-send mailbox that can still
    // park a draft.
    const noSmtp = imapProviderWith(() => new DraftOnlyImapClient());
    expect(noSmtp.sendCapable).toBe(false);
    expect(noSmtp.draftCapable).toBe(true);

    // And the reverse: SMTP configured, but a client that cannot APPEND.
    const smtpOnly = imapProviderWith(() => new BareImapClient(), { host: 'smtp.example.com' });
    expect(smtpOnly.sendCapable).toBe(true);
    expect(smtpOnly.draftCapable).toBe(false);
  });

  it('probes lazily — constructing a provider asks the factory nothing', () => {
    let built = 0;
    const provider = imapProviderWith(() => { built += 1; return new FullImapClient(); });
    expect(built).toBe(0);
    expect(provider.draftCapable).toBe(true);
    const afterFirst = built;
    expect(afterFirst).toBeGreaterThan(0);
    // Memoized: a second read costs no further client.
    expect(provider.draftCapable).toBe(true);
    expect(built).toBe(afterFirst);
  });
});

// ────────────────────────────────────────────────────────────────
// The wire
// ────────────────────────────────────────────────────────────────

describe('D-264 — collection.mail.list carries the axis', () => {
  it('reports the live provider’s answer, disagreeing with send_capable both ways', async () => {
    // `imap-readonly` has no SMTP (cannot send) but a client that can APPEND.
    // `imap-send` has SMTP (can send) and a client that cannot.
    const h = newHarness((slug) => slug === 'imap-readonly');
    for (const [name, smtp] of [
      ['imap-readonly', undefined],
      ['imap-send', { host: 'smtp.example.com' }],
    ] as const) {
      await handleMailEnrollImap(h.deps, {
        name, host: 'imap.example.com', port: 993, secure: true,
        username: 'me@example.com', password: 'pw', folders: ['INBOX'],
        ...(smtp ? { smtp } : {}),
      });
    }
    const { instances } = await handleMailList(h.deps);
    const readonly = instances.find((i) => i.slug === 'imap-readonly');
    const send = instances.find((i) => i.slug === 'imap-send');

    expect(readonly?.send_capable).toBe(false);
    expect(readonly?.draft_capable).toBe(true);
    expect(send?.send_capable).toBe(true);
    expect(send?.draft_capable).toBe(false);
  });

  it('reports false for a slug with no live collection, even when it can send', async () => {
    // The seam answers `undefined` — never started, auth broken, stopped. A
    // mailbox we cannot ask is a mailbox we do not advertise.
    const h = newHarness(() => undefined);
    await handleMailEnrollImap(h.deps, {
      name: 'imap-send', host: 'imap.example.com', port: 993, secure: true,
      username: 'me@example.com', password: 'pw', folders: ['INBOX'],
      smtp: { host: 'smtp.example.com' },
    });
    const { instances } = await handleMailList(h.deps);
    expect(instances[0]?.send_capable).toBe(true);
    expect(instances[0]?.draft_capable).toBe(false);
  });

  it('reports false when the seam is unwired at all', async () => {
    const h = newHarness();
    await handleMailEnrollImap(h.deps, {
      name: 'imap-send', host: 'imap.example.com', port: 993, secure: true,
      username: 'me@example.com', password: 'pw', folders: ['INBOX'],
      smtp: { host: 'smtp.example.com' },
    });
    const { instances } = await handleMailList(h.deps);
    expect(instances[0]?.draft_capable).toBe(false);
  });

  it('never omits the field — every row answers the question', async () => {
    const h = newHarness((slug) => slug === 'a');
    for (const name of ['a', 'b']) {
      await handleMailEnrollImap(h.deps, {
        name, host: 'imap.example.com', port: 993, secure: true,
        username: 'me@example.com', password: 'pw', folders: ['INBOX'],
      });
    }
    const { instances } = await handleMailList(h.deps);
    expect(instances).toHaveLength(2);
    for (const row of instances) {
      expect(typeof row.draft_capable).toBe('boolean');
    }
  });
});

// ────────────────────────────────────────────────────────────────
// The collection mirror — the seam the composition root actually reads
// ────────────────────────────────────────────────────────────────

describe('D-264 — MailCollection mirrors the provider’s DRAFT flag', () => {
  const withCollection = (
    overrides: Partial<MailProvider>,
    assert: (collection: { draftCapable: boolean; mutationCapable: boolean }) => void,
  ): void => {
    const dir = mkdtempSync(join(tmpdir(), 'd264-'));
    mkdirSync(join(dir, 'cas'), { recursive: true });
    const db = new Database(':memory:');
    try {
      const provider: MailProvider = {
        kind: 'imap', slug: 'inbox',
        sendCapable: false, mutationCapable: false, accountEmail: 'owner@example.com',
        async connect() { /* no-op */ },
        async initialScan() { /* no messages */ },
        async startSync() { return async () => {}; },
        async close() { /* no-op */ },
        health() { return { last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 }; },
        ...overrides,
      };
      assert(createMailCollection({
        db,
        blobs: createBlobStore(join(dir, 'cas')),
        gate: createStorageGate({ quota: 64 * 1024 * 1024, reservePct: 10, surface: 'collection:mail:inbox' }),
        bus: createWarehouseEventBus(),
        slug: 'inbox',
        provider,
        config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: 64 * 1024 * 1024 }),
      }));
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('reads draftCapable, NOT mutationCapable — in both directions', () => {
    withCollection({ draftCapable: true, mutationCapable: false }, (collection) => {
      expect(collection.draftCapable).toBe(true);
      expect(collection.mutationCapable).toBe(false);
    });
    withCollection({ draftCapable: false, mutationCapable: true }, (collection) => {
      expect(collection.draftCapable).toBe(false);
      expect(collection.mutationCapable).toBe(true);
    });
  });

  it('treats an undeclared provider flag as NOT capable', () => {
    // The out-of-tree adapter case: `draftCapable` absent entirely. It must
    // narrow to `false`, never to `undefined` and never to a neighbour's value.
    withCollection({ mutationCapable: true }, (collection) => {
      expect(collection.draftCapable).toBe(false);
    });
  });
});

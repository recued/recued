/** D-127 wire-up — mail enroll rpc handlers + compose root.
 *
 *  Exercises the substrate that bridges D-127 (substrate) to the
 *  Connections UI: `handleMailEnrollImap` accepts the form payload,
 *  persists creds via the account store, writes the row, and invokes
 *  the `onEnrolled` hook so the compose root spins up a live
 *  `MailCollection`. `handleMailList` projects rows to the picker
 *  shape with `send_capable` derived per adapter. `handleMailDelete`
 *  drops the row + wipes credentials.
 *
 *  Compose-root coverage is shape-only: starts/stops live `imap`
 *  rows through the shared instance store. No real IMAP server —
 *  `createImapProvider`'s factory is replaced with a fake elsewhere
 *  (see d-127-phase-1-5-imap-provider-send.test.ts); this test
 *  drives the orchestration plumbing only.
 */

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { RpcError } from '@recued/contracts';
import {
  handleMailEnrollImap,
  handleMailList,
  handleMailDelete,
  readImapPassword,
  readImapSmtpPassword,
  type MailEnrollDeps,
} from '../enroll.js';
import {
  createInstanceStore,
  type CollectionInstanceStore,
} from '../../instance-store.js';
import type { OAuthAccountStore } from '../oauth.js';
import type { CollectionInstanceRow } from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Test doubles
// ────────────────────────────────────────────────────────────────

const makeStore = (): OAuthAccountStore & {
  data: Map<string, string>;
} => {
  const data = new Map<string, string>();
  return {
    data,
    async get(k) { return data.get(k) ?? null; },
    async set(k, v) { data.set(k, v); },
    async delete(k) { data.delete(k); },
    async getAll() { return Object.fromEntries(data); },
  };
};

const newDb = (): Database.Database => {
  const db = new Database(':memory:');
  return db;
};

interface Harness {
  deps: MailEnrollDeps;
  instances: CollectionInstanceStore;
  store: ReturnType<typeof makeStore>;
  enrolled: CollectionInstanceRow[];
  deleted: string[];
}

const newHarness = (): Harness => {
  const db = newDb();
  const instances = createInstanceStore({ db });
  const store = makeStore();
  const enrolled: CollectionInstanceRow[] = [];
  const deleted: string[] = [];
  const deps: MailEnrollDeps = {
    instances,
    accountStore: store,
    onEnrolled: (row) => { enrolled.push(row); },
    onDeleted: (slug) => { deleted.push(slug); },
  };
  return { deps, instances, store, enrolled, deleted };
};

// ────────────────────────────────────────────────────────────────
// enrollImap — happy path
// ────────────────────────────────────────────────────────────────

describe('handleMailEnrollImap', () => {
  it('persists row + IMAP password without SMTP block', async () => {
    const h = newHarness();
    const result = await handleMailEnrollImap(h.deps, {
      name: 'work-imap',
      host: 'imap.example.com',
      port: 993,
      secure: true,
      username: 'me@example.com',
      password: 'super-secret',
      folders: ['INBOX'],
    });
    expect(result).toEqual({ slug: 'work-imap', send_capable: false });
    // Password lives in the account store, not in the row.
    expect(h.store.data.get('imap.work-imap.password')).toBe('super-secret');
    const row = h.instances.get('mail', 'work-imap');
    expect(row?.adapter_type).toBe('imap');
    expect(row?.config.password).toBeUndefined();
    expect(row?.config.host).toBe('imap.example.com');
    expect(row?.config.smtp).toBeUndefined();
    // onEnrolled hook fired with the public row shape.
    expect(h.enrolled).toHaveLength(1);
    expect(h.enrolled[0].slug).toBe('work-imap');
    expect(h.enrolled[0].adapter_type).toBe('imap');
  });

  it('persists SMTP block + smtp_password when send is enabled', async () => {
    const h = newHarness();
    const result = await handleMailEnrollImap(h.deps, {
      name: 'work-imap',
      host: 'imap.example.com',
      port: 993,
      secure: true,
      username: 'me@example.com',
      password: 'imap-pw',
      folders: ['INBOX'],
      smtp: {
        host: 'smtp.example.com',
        port: 587,
        username: 'me@example.com',
        password: 'smtp-pw',
        from: 'me@example.com',
      },
    });
    expect(result.send_capable).toBe(true);
    expect(h.store.data.get('imap.work-imap.password')).toBe('imap-pw');
    expect(h.store.data.get('imap.work-imap.smtp_password')).toBe('smtp-pw');
    const row = h.instances.get('mail', 'work-imap');
    const smtp = row?.config.smtp as Record<string, unknown>;
    expect(smtp.host).toBe('smtp.example.com');
    expect(smtp.password).toBeUndefined();
    expect(smtp.from).toBe('me@example.com');
  });

  it('rejects duplicate slug', async () => {
    const h = newHarness();
    await handleMailEnrollImap(h.deps, {
      name: 'work-imap',
      host: 'imap.example.com',
      port: 993,
      secure: true,
      username: 'me@example.com',
      password: 'pw',
      folders: ['INBOX'],
    });
    await expect(
      handleMailEnrollImap(h.deps, {
        name: 'work-imap',
        host: 'imap.example.com',
        port: 993,
        secure: true,
        username: 'me@example.com',
        password: 'pw',
        folders: ['INBOX'],
      }),
    ).rejects.toThrow(/already exists/);
  });

  it('rejects malformed slug', async () => {
    const h = newHarness();
    await expect(
      handleMailEnrollImap(h.deps, {
        name: 'WORK!',
        host: 'imap.example.com',
        port: 993,
        secure: true,
        username: 'a',
        password: 'b',
        folders: ['INBOX'],
      }),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('rejects port outside [1, 65535]', async () => {
    const h = newHarness();
    await expect(
      handleMailEnrollImap(h.deps, {
        name: 'work',
        host: 'imap.example.com',
        port: 0,
        secure: true,
        username: 'a',
        password: 'b',
        folders: ['INBOX'],
      }),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('rejects empty folders array', async () => {
    const h = newHarness();
    await expect(
      handleMailEnrollImap(h.deps, {
        name: 'work',
        host: 'imap.example.com',
        port: 993,
        secure: true,
        username: 'a',
        password: 'b',
        folders: [],
      }),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('clears stale smtp_password when re-enrolled without SMTP block', async () => {
    const h = newHarness();
    h.store.data.set('imap.work.smtp_password', 'leftover');
    await handleMailEnrollImap(h.deps, {
      name: 'work',
      host: 'imap.example.com',
      port: 993,
      secure: true,
      username: 'a',
      password: 'b',
      folders: ['INBOX'],
    });
    expect(h.store.data.has('imap.work.smtp_password')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// list — picker source
// ────────────────────────────────────────────────────────────────

describe('handleMailList', () => {
  it('returns IMAP rows with send_capable derived from smtp block presence', async () => {
    const h = newHarness();
    await handleMailEnrollImap(h.deps, {
      name: 'imap-readonly',
      host: 'imap.example.com',
      port: 993,
      secure: true,
      username: 'me@example.com',
      password: 'pw',
      folders: ['INBOX'],
    });
    await handleMailEnrollImap(h.deps, {
      name: 'imap-send',
      host: 'imap.example.com',
      port: 993,
      secure: true,
      username: 'me@example.com',
      password: 'pw',
      folders: ['INBOX'],
      smtp: { host: 'smtp.example.com' },
    });
    const res = await handleMailList(h.deps);
    expect(res.instances).toHaveLength(2);
    const readonly = res.instances.find((i) => i.slug === 'imap-readonly');
    const send = res.instances.find((i) => i.slug === 'imap-send');
    expect(readonly?.send_capable).toBe(false);
    expect(send?.send_capable).toBe(true);
    // account_email falls back to smtp.from → username for IMAP.
    expect(readonly?.account_email).toBe('me@example.com');
    expect(send?.account_email).toBe('me@example.com');
  });

  it('returns gmail row with send_capable=true when granted_scopes includes gmail.send', async () => {
    const h = newHarness();
    h.instances.upsert({
      platform: 'mail',
      slug: 'work-gmail',
      adapter_type: 'gmail',
      config: { account_slug: 'work-gmail', account_email: 'me@gmail.com' },
      caps: { read: 'yes', write: 'no', delete: 'no', watch: 'realtime', mirror: 'required', auth: 'oauth', path_style: 'uri' },
      auth_state: 'healthy',
      last_synced_at: null,
    });
    await h.store.set(
      'gmail.work-gmail.granted_scopes',
      'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
    );
    const res = await handleMailList(h.deps);
    expect(res.instances).toHaveLength(1);
    expect(res.instances[0].send_capable).toBe(true);
    expect(res.instances[0].account_email).toBe('me@gmail.com');
  });

  it('returns gmail row with send_capable=false when only readonly is granted', async () => {
    const h = newHarness();
    h.instances.upsert({
      platform: 'mail',
      slug: 'work-gmail',
      adapter_type: 'gmail',
      config: { account_slug: 'work-gmail', account_email: 'me@gmail.com' },
      caps: { read: 'yes', write: 'no', delete: 'no', watch: 'realtime', mirror: 'required', auth: 'oauth', path_style: 'uri' },
      auth_state: 'healthy',
      last_synced_at: null,
    });
    await h.store.set(
      'gmail.work-gmail.granted_scopes',
      'https://www.googleapis.com/auth/gmail.readonly',
    );
    const res = await handleMailList(h.deps);
    expect(res.instances[0].send_capable).toBe(false);
  });

  it('returns graph row with send_capable=true when Mail.Send is granted', async () => {
    const h = newHarness();
    h.instances.upsert({
      platform: 'mail',
      slug: 'work-graph',
      adapter_type: 'graph',
      config: { account_slug: 'work-graph', account_email: 'me@example.com' },
      caps: { read: 'yes', write: 'no', delete: 'no', watch: 'realtime', mirror: 'required', auth: 'oauth', path_style: 'uri' },
      auth_state: 'healthy',
      last_synced_at: null,
    });
    await h.store.set(
      'graph.work-graph.granted_scopes',
      'Mail.Read offline_access Mail.Send',
    );
    const res = await handleMailList(h.deps);
    expect(res.instances[0].send_capable).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// delete — drops row + creds + invokes onDeleted
// ────────────────────────────────────────────────────────────────

describe('handleMailDelete', () => {
  it('removes row, credentials, and fires onDeleted for IMAP', async () => {
    const h = newHarness();
    await handleMailEnrollImap(h.deps, {
      name: 'work',
      host: 'imap.example.com',
      port: 993,
      secure: true,
      username: 'me@example.com',
      password: 'pw',
      folders: ['INBOX'],
      smtp: { host: 'smtp.example.com', password: 'smtp-pw' },
    });
    expect(h.instances.get('mail', 'work')).not.toBeNull();
    expect(await readImapPassword(h.store, 'work')).toBe('pw');
    expect(await readImapSmtpPassword(h.store, 'work')).toBe('smtp-pw');
    h.store.data.set(
      'imap.work.pending_delivery.SU5CT1g.7.created',
      '{"schema_version":1}',
    );
    h.store.data.set('imap.other.pending_delivery.SU5CT1g.7.created', 'keep');

    const result = await handleMailDelete(h.deps, { slug: 'work' });
    expect(result).toEqual({ ok: true });
    expect(h.instances.get('mail', 'work')).toBeNull();
    expect(await readImapPassword(h.store, 'work')).toBeNull();
    expect(await readImapSmtpPassword(h.store, 'work')).toBeNull();
    expect(h.store.data.has('imap.work.pending_delivery.SU5CT1g.7.created')).toBe(false);
    expect(h.store.data.get('imap.other.pending_delivery.SU5CT1g.7.created')).toBe('keep');
    expect(h.deleted).toEqual(['work']);
  });

  it('removes OAuth tokens for gmail row on delete', async () => {
    const h = newHarness();
    h.instances.upsert({
      platform: 'mail',
      slug: 'work-gmail',
      adapter_type: 'gmail',
      config: { account_slug: 'work-gmail' },
      caps: { read: 'yes', write: 'no', delete: 'no', watch: 'realtime', mirror: 'required', auth: 'oauth', path_style: 'uri' },
      auth_state: 'healthy',
      last_synced_at: null,
    });
    await h.store.set('gmail.work-gmail.access_token', 'at');
    await h.store.set('gmail.work-gmail.refresh_token', 'rt');
    await h.store.set('gmail.work-gmail.expires_at', '12345');
    await h.store.set('gmail.work-gmail.granted_scopes', 'scope-list');

    await handleMailDelete(h.deps, { slug: 'work-gmail' });

    expect(h.store.data.has('gmail.work-gmail.access_token')).toBe(false);
    expect(h.store.data.has('gmail.work-gmail.refresh_token')).toBe(false);
    expect(h.store.data.has('gmail.work-gmail.expires_at')).toBe(false);
    expect(h.store.data.has('gmail.work-gmail.granted_scopes')).toBe(false);
  });

  it('throws not_found when slug is unknown', async () => {
    const h = newHarness();
    await expect(
      handleMailDelete(h.deps, { slug: 'never-was' }),
    ).rejects.toThrow(/not found/);
  });
});

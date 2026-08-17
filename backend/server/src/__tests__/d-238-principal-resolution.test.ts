/** D-238 — the enrolled principal is resolved at enrol time.
 *
 *  ⛔⛔ The gap this closes was mine and it was invisible: the Teams card
 *  declared `config.principal_id` as `autofilled`, and NOTHING autofilled it.
 *  The finding-12 guard then refused every typed reply — correct posture, dead
 *  feature. The owner would have got notifications and the answer link, never a
 *  typed answer, with no error anywhere saying why.
 *
 *  🔑 Enrolment is the right place: it already holds the full credential and is
 *  about to write the row, so the value lands with no rpc shape change, no form
 *  field, and no extra round-trip in the consent popup. Same shape as the
 *  D-192 SharePoint drive-id resolver next to it. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MESSENGER_PRINCIPAL_CONFIG_KEY,
  type ConnectionAuth,
} from '@recued/contracts';

import { createConnectionStore, type ConnectionStoreSqlite } from '../storage/connection-store.js';
import { handleConnectionEnroll } from '../connection-handler.js';

let dir: string;
let db: Database.Database;
let store: ConnectionStoreSqlite;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd238-principal-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createConnectionStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const OAUTH: ConnectionAuth = {
  type: 'oauth2_refresh',
  refresh_token: 'rt-original',
  client_id: 'cid',
  token_endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** A fetch that answers the token exchange then the identity call. */
const graphFetch = (
  over: { me?: () => Response; rotated?: string; chats?: () => Response } = {},
) => {
  const calls: string[] = [];
  const impl = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/oauth2/v2.0/token')) {
      return json({
        access_token: 'at-fresh',
        refresh_token: over.rotated ?? 'rt-rotated',
        expires_in: 3600,
      });
    }
    // The capability probe — a work/school account can list its chats.
    if (url.includes('/me/chats')) {
      return over.chats ? over.chats() : json({ value: [] });
    }
    return over.me ? over.me() : json({ id: 'owner-entra-id', displayName: 'Dana' });
  }) as unknown as typeof fetch;
  return { impl, calls };
};

const enrollTeams = (fetchImpl: typeof fetch, config: Record<string, unknown> = {}) =>
  handleConnectionEnroll(
    { store, resolveFetch: fetchImpl } as never,
    {
      name: 'teams',
      kind: 'notification',
      subtype: 'teams',
      display_name: 'Microsoft Teams',
      config,
      auth: OAUTH,
    } as never,
  );

const storedConfig = (): Record<string, unknown> =>
  JSON.parse(store.get('notification', 'teams')!.config_json) as Record<string, unknown>;

describe('the enrolled principal lands on the row', () => {
  it('resolves the signed-in user and writes it to config', async () => {
    const { impl, calls } = graphFetch();
    await enrollTeams(impl);

    expect(storedConfig()[MESSENGER_PRINCIPAL_CONFIG_KEY]).toBe('owner-entra-id');
    // Read from the declared health-probe endpoint — the cheapest authenticated
    // call the vendor already names, rather than a second hard-coded URL.
    expect(calls.some((u) => u.includes('graph.microsoft.com/v1.0/me'))).toBe(true);
  });

  /** ⛔ Microsoft ROTATES the refresh token on refresh. Persisting the
   *  pre-refresh one leaves a credential the provider has already invalidated —
   *  the row would be dead on arrival and only discoverable an hour later. The
   *  SharePoint resolver beside this one carries the same warning. */
  it('persists the ROTATED refresh token, never the one it was handed', async () => {
    const { impl } = graphFetch({ rotated: 'rt-rotated-by-microsoft' });
    await enrollTeams(impl);

    const row = store.get('notification', 'teams')!;
    const auth = JSON.parse(
      Buffer.from(row.auth_ciphertext, 'base64').toString('utf8'),
    ) as { refresh_token?: string };
    expect(auth.refresh_token).toBe('rt-rotated-by-microsoft');
  });

  /** ⛔ BEST-EFFORT BY DESIGN. An unreachable Graph must not mean "you cannot add
   *  Teams at all" — the connection still notifies and still answers by link.
   *  What it loses is typed answers, which fail closed. Degraded, never unsafe. */
  it('still enrols when the identity call fails', async () => {
    const { impl } = graphFetch({ me: () => json({ error: 'nope' }, 503) });
    await expect(enrollTeams(impl)).resolves.toBeDefined();

    expect(store.get('notification', 'teams')).not.toBeNull();
    expect(storedConfig()[MESSENGER_PRINCIPAL_CONFIG_KEY]).toBeUndefined();
  });

  it('still enrols when the identity response carries no id', async () => {
    const { impl } = graphFetch({ me: () => json({ displayName: 'Dana' }) });
    await expect(enrollTeams(impl)).resolves.toBeDefined();
    expect(storedConfig()[MESSENGER_PRINCIPAL_CONFIG_KEY]).toBeUndefined();
  });

  it('does not overwrite a principal the config already carries', async () => {
    const { impl, calls } = graphFetch();
    await enrollTeams(impl, { [MESSENGER_PRINCIPAL_CONFIG_KEY]: 'already-bound' });

    expect(storedConfig()[MESSENGER_PRINCIPAL_CONFIG_KEY]).toBe('already-bound');
    expect(calls.some((u) => u.includes('/v1.0/me'))).toBe(false);
  });

  /** A vendor that cannot name its senders declares no `principal_id_field`, and
   *  must pay no network round-trip for a resolution that cannot succeed. */
  it('is a no-op for a vendor that declares no principal field', async () => {
    const { impl, calls } = graphFetch();
    await handleConnectionEnroll(
      { store, resolveFetch: impl } as never,
      {
        name: 'slack',
        kind: 'notification',
        subtype: 'slack',
        display_name: 'Slack',
        config: { channel_id: 'C1' },
        auth: { type: 'bearer', token: 'xoxb-1' },
      } as never,
    );
    expect(calls.some((u) => u.includes('/v1.0/me'))).toBe(false);
  });
});

describe('a personal Microsoft account is refused at enrolment', () => {
  /** ⛔⛔ THE SHAPE THIS EXISTS FOR, and a live drive nearly walked into it.
   *  Graph's `/me` SUPPORTS a personal Microsoft account, while every Teams
   *  messaging API is work-or-school only. So a consumer account consents
   *  cleanly on the `/common/` authorize URL, resolves a principal, probes
   *  GREEN — and then 403s on every send. Enrolled, healthy, and mute.
   *
   *  🔑 The probe asks the CAPABILITY question, not the account-type question:
   *  it calls the API we actually need rather than inferring a proxy for it,
   *  which also covers a trimmed scope or a tenant policy blocking Teams. */
  it('refuses when the account cannot use the Teams API at all', async () => {
    const { impl } = graphFetch({
      chats: () => json({ error: { code: 'UnknownError' } }, 403),
    });
    await expect(enrollTeams(impl)).rejects.toThrow(/work or school/i);
    // ⛔ And NOTHING is persisted. A row written here would be the green-and-mute
    // connection itself — the refusal has to land before the write.
    expect(store.get('notification', 'teams')).toBeNull();
  });

  it('names the fix rather than the status code', async () => {
    const { impl } = graphFetch({ chats: () => json({}, 403) });
    await expect(enrollTeams(impl)).rejects.toThrow(/teams\.microsoft\.com/);
  });

  /** ⚠ A transient failure must NOT block. An unreachable Graph meaning "you
   *  cannot add Teams at all" is a worse trade than enrolling and finding out
   *  on first send — and 429 says nothing about capability. */
  it('still enrols through a transient failure', async () => {
    for (const status of [500, 503, 429]) {
      store.delete?.('notification', 'teams');
      const { impl } = graphFetch({ chats: () => json({ e: 1 }, status) });
      await expect(enrollTeams(impl)).resolves.toBeDefined();
      expect(store.get('notification', 'teams')).not.toBeNull();
    }
  });

  it('probes capability BEFORE resolving the principal', async () => {
    const { impl, calls } = graphFetch({ chats: () => json({}, 403) });
    await expect(enrollTeams(impl)).rejects.toThrow();
    // `/me` is never reached: there is no point naming an approver for an
    // account that cannot deliver.
    expect(calls.some((u) => u.endsWith('/v1.0/me'))).toBe(false);
  });
});

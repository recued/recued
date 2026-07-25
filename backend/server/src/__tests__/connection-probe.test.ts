import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MESSENGER_PROBE_TOKEN_PLACEHOLDER,
  getMessengerVendorDeclaration,
  listMessengerVendors,
} from '@recued/contracts';
import type { ConnectionAuth, ConnectionHealth, ConnectionKind } from '@recued/contracts';

import {
  encodeAuthForStorage,
  handleConnectionEnroll,
  handleConnectionProbe,
} from '../connection-handler.js';
import type { HttpFetcher } from '../connection-vendor-oauth.js';
import {
  createConnectionStore,
  type ConnectionStoreSqlite,
} from '../storage/connection-store.js';

const NOW = 1_700_000_000_000;
const key = new Uint8Array(32).fill(7);
const getEncryptionKey = (): Uint8Array => key;

let db: Database.Database;
let store: ConnectionStoreSqlite;

beforeEach(() => {
  db = new Database(':memory:');
  store = createConnectionStore(db);
});

afterEach(() => {
  db.close();
});

const jsonResponse = (
  status: number,
  body: unknown = {},
): Awaited<ReturnType<HttpFetcher>> => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const enroll = async (
  kind: ConnectionKind,
  overrides: {
    name?: string;
    subtype?: string;
    config?: Record<string, unknown>;
    auth?: ConnectionAuth;
    publisher_id?: string;
    subresource_path?: string;
  } = {},
): Promise<string> => {
  const name = overrides.name ?? `${kind}-probe`;
  const auth = overrides.auth ?? { type: 'bearer', token: 'secret' };
  const config = overrides.config ?? (
    kind === 'api'
      ? { base_url: 'https://api.example.test/root' }
      : kind === 'mcp'
        ? { endpoint: 'https://mcp.example.test/rpc', transport: 'sse' }
        : {}
  );
  await handleConnectionEnroll(
    {
      store,
      now: () => NOW,
      getEncryptionKey,
    },
    {
      name,
      kind,
      ...(overrides.subtype !== undefined ? { subtype: overrides.subtype } : {}),
      display_name: name,
      ...(overrides.publisher_id !== undefined ? { publisher_id: overrides.publisher_id } : {}),
      config,
      auth,
      ...(overrides.subresource_path !== undefined ? { subresource_path: overrides.subresource_path } : {}),
    },
  );
  return name;
};

const probe = async (
  kind: ConnectionKind,
  name: string,
  fetcher: HttpFetcher,
): Promise<ConnectionHealth> => {
  const result = await handleConnectionProbe(
    {
      store,
      now: () => NOW + 1_000,
      getEncryptionKey,
      fetcher,
    },
    { kind, name },
  );
  return result.health;
};

const storedHealth = (kind: ConnectionKind, name: string): ConnectionHealth =>
  JSON.parse(store.get(kind, name)!.health_json!) as ConnectionHealth;

describe('handleConnectionProbe real health probes', () => {
  it('classifies an authed api HEAD response as ok and preserves row fields', async () => {
    const name = await enroll('api', {
      publisher_id: 'pub.api',
      subresource_path: '/accounts/123',
    });
    const fetcher = vi.fn<HttpFetcher>(async (url, init) => {
      expect(url).toBe('https://api.example.test/root');
      expect(init?.method).toBe('HEAD');
      expect(init?.headers?.Authorization).toBe('Bearer secret');
      return jsonResponse(204);
    });

    const health = await probe('api', name, fetcher);

    expect(health.status).toBe('ok');
    expect(storedHealth('api', name).status).toBe('ok');
    const row = store.get('api', name)!;
    expect(row.publisher_id).toBe('pub.api');
    expect(row.subresource_path).toBe('/accounts/123');
  });

  it('classifies api 401/403 as auth_failed', async () => {
    const name = await enroll('api');

    const health = await probe('api', name, async () => jsonResponse(401));

    expect(health.status).toBe('auth_failed');
    expect(health.last_error).toBe('http_status_401');
  });

  it('mints an OAuth2 client-credentials token before probing an api connection', async () => {
    const name = await enroll('api', {
      name: 'airbyte',
      config: { base_url: 'https://api.airbyte.com/v1' },
      auth: {
        type: 'oauth2_client_credentials',
        client_id: 'airbyte-client',
        client_secret: 'airbyte-secret',
        token_endpoint: 'https://api.airbyte.com/v1/applications/token',
      },
    });
    const tokenFetch = vi.fn<typeof fetch>(async (input, init) => {
      expect(input.toString()).toBe('https://api.airbyte.com/v1/applications/token');
      expect(init?.method).toBe('POST');
      expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
        grant_type: 'client_credentials',
        client_id: 'airbyte-client',
        client_secret: 'airbyte-secret',
      });
      return new Response(JSON.stringify({
        access_token: 'airbyte-access',
        token_type: 'Bearer',
        expires_in: 180,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const apiFetch = vi.fn<HttpFetcher>(async (url, init) => {
      expect(url).toBe('https://api.airbyte.com/v1');
      expect(init?.method).toBe('HEAD');
      expect(init?.headers?.Authorization).toBe('Bearer airbyte-access');
      return jsonResponse(204);
    });

    const result = await handleConnectionProbe(
      {
        store,
        now: () => NOW + 1_000,
        getEncryptionKey,
        fetcher: apiFetch,
        resolveFetch: tokenFetch,
      },
      { kind: 'api', name },
    );

    expect(result.health.status).toBe('ok');
    expect(tokenFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('maps an OAuth2 client-credentials exchange failure to auth_failed without probing', async () => {
    const name = await enroll('api', {
      name: 'airbyte',
      config: { base_url: 'https://api.airbyte.com/v1' },
      auth: {
        type: 'oauth2_client_credentials',
        client_id: 'airbyte-client',
        client_secret: 'airbyte-secret',
        token_endpoint: 'https://api.airbyte.com/v1/applications/token',
      },
    });
    const apiFetch = vi.fn<HttpFetcher>();

    const result = await handleConnectionProbe(
      {
        store,
        now: () => NOW + 1_000,
        getEncryptionKey,
        fetcher: apiFetch,
        resolveFetch: vi.fn<typeof fetch>(async () => new Response(
          JSON.stringify({ error: 'invalid_client' }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        )),
      },
      { kind: 'api', name },
    );

    expect(result.health).toMatchObject({
      status: 'auth_failed',
      last_error: 'token_exchange_failed',
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('falls back from api HEAD to GET and treats other HTTP statuses as reachable', async () => {
    const name = await enroll('api');
    const fetcher = vi.fn<HttpFetcher>(async (_url, init) => (
      init?.method === 'HEAD' ? jsonResponse(405) : jsonResponse(500)
    ));

    const health = await probe('api', name, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(health.status).toBe('ok');
    expect(health.last_error).toBe('http_status_500');
  });

  it('maps api fetch throws to unreachable without throwing the rpc', async () => {
    const name = await enroll('api');

    const health = await probe('api', name, async () => {
      throw new Error('dns failed');
    });

    expect(health.status).toBe('unreachable');
    expect(health.last_error).toBe('dns failed');
  });

  it('runs mcp initialize then tools/list and caches tool names', async () => {
    const name = await enroll('mcp', { subtype: 'sse' });
    const fetcher = vi.fn<HttpFetcher>(async (_url, init) => {
      const body = JSON.parse(init?.body ?? '{}') as { method?: string };
      if (body.method === 'initialize') {
        return jsonResponse(200, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05' } });
      }
      expect(body.method).toBe('tools/list');
      return jsonResponse(200, {
        jsonrpc: '2.0',
        id: 2,
        result: { tools: [{ name: 'search' }, { name: 'write-note' }] },
      });
    });

    const health = await probe('mcp', name, fetcher);

    expect(health.status).toBe('ok');
    expect(health.tools).toEqual(['search', 'write-note']);
    expect(storedHealth('mcp', name).tools).toEqual(['search', 'write-note']);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('maps mcp JSON-RPC error envelopes to auth_failed', async () => {
    const name = await enroll('mcp', { subtype: 'sse' });

    const health = await probe('mcp', name, async () => jsonResponse(200, {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32001, message: 'unauthorized' },
    }));

    expect(health.status).toBe('auth_failed');
    expect(health.last_error).toBe('jsonrpc_initialize_error');
  });

  it('maps mcp transport failures to unreachable', async () => {
    const name = await enroll('mcp', { subtype: 'sse' });

    const health = await probe('mcp', name, async () => {
      throw new Error('connection refused');
    });

    expect(health.status).toBe('unreachable');
    expect(health.last_error).toBe('connection refused');
  });

  it('classifies notification in-app locally as ok', async () => {
    const name = await enroll('notification', {
      subtype: 'in-app',
      auth: { type: 'none' },
    });

    const health = await probe('notification', name, async () => {
      throw new Error('should not fetch');
    });

    expect(health.status).toBe('ok');
  });

  it('classifies notification slack auth.test failures as auth_failed', async () => {
    const name = await enroll('notification', { subtype: 'slack' });

    const health = await probe('notification', name, async (url, init) => {
      expect(url).toBe('https://slack.com/api/auth.test');
      expect(init?.headers?.Authorization).toBe('Bearer secret');
      return jsonResponse(200, { ok: false, error: 'invalid_auth' });
    });

    expect(health.status).toBe('auth_failed');
    expect(health.last_error).toBe('invalid_auth');
  });

  it('classifies notification telegram getMe transport failures as unreachable', async () => {
    const name = await enroll('notification', { subtype: 'telegram' });

    const health = await probe('notification', name, async () => {
      throw new Error('telegram timeout');
    });

    expect(health.status).toBe('unreachable');
    expect(health.last_error).toBe('telegram timeout');
  });

  it('classifies a notification email connection with a sender_mail_instance as ok (config readiness, no network)', async () => {
    const name = await enroll('notification', {
      subtype: 'email',
      auth: { type: 'none' },
      config: { sender_mail_instance: 'my-mailbox' },
    });

    // The email subtype is a façade over a mail instance, so the probe is a
    // config-readiness check — the fetcher must NOT fire.
    const health = await probe('notification', name, async () => {
      throw new Error('should not fetch');
    });

    expect(health.status).toBe('ok');
  });

  it('classifies a notification email connection missing sender_mail_instance as unreachable', async () => {
    const name = await enroll('notification', {
      subtype: 'email',
      auth: { type: 'none' },
      config: {},
    });

    const health = await probe('notification', name, async () => {
      throw new Error('should not fetch');
    });

    expect(health.status).toBe('unreachable');
    expect(health.last_error).toBe('email_no_sender_mail_instance');
  });

  it('treats a blank sender_mail_instance as unreachable', async () => {
    const name = await enroll('notification', {
      subtype: 'email',
      auth: { type: 'none' },
      config: { sender_mail_instance: '   ' },
    });

    const health = await probe('notification', name, async () => {
      throw new Error('should not fetch');
    });

    expect(health.status).toBe('unreachable');
    expect(health.last_error).toBe('email_no_sender_mail_instance');
  });

  it('treats a surrounding-whitespace sender_mail_instance as unreachable (send uses the exact key)', async () => {
    const name = await enroll('notification', {
      subtype: 'email',
      auth: { type: 'none' },
      config: { sender_mail_instance: ' my-mailbox ' },
    });

    const health = await probe('notification', name, async () => {
      throw new Error('should not fetch');
    });

    expect(health.status).toBe('unreachable');
    expect(health.last_error).toBe('email_no_sender_mail_instance');
  });

  it('maps a locked vault to unknown plus vault_locked without decoding auth', async () => {
    const name = 'locked-api';
    store.upsert({
      kind: 'api',
      name,
      display_name: name,
      config_json: JSON.stringify({ base_url: 'https://api.example.test/root' }),
      auth_ciphertext: await encodeAuthForStorage(
        { type: 'bearer', token: 'secret' },
        { kind: 'api', name },
        getEncryptionKey,
      ),
      enrolled_at: NOW,
      updated_at: NOW,
    });
    const fetcher = vi.fn<HttpFetcher>();

    const result = await handleConnectionProbe(
      {
        store,
        now: () => NOW + 1_000,
        getEncryptionKey: () => null,
        fetcher,
      },
      { kind: 'api', name },
    );

    expect(result.health.status).toBe('unknown');
    expect(result.health.last_error).toBe('vault_locked');
    expect(fetcher).not.toHaveBeenCalled();
    expect(storedHealth('api', name).last_error).toBe('vault_locked');
  });
});

/** D-192 CORE #6 seam 8 — the notification probe's per-vendor `switch (subtype)`
 *  is gone: the URL, the method + where the credential rides are now DECLARED
 *  facts on each messenger vendor's `health_probe` facet, and one generic prober
 *  reads them. The table below iterates the LIVE registry rather than naming
 *  slack/telegram, so a newly-declared vendor (Teams) is covered here the moment
 *  it is declared — with no edit to this file. That is the property under test. */
describe('D-192 seam 8 — registry-driven messenger health probes', () => {
  const TOKEN = 'bot-secret-123:AAH';

  it.each(listMessengerVendors().map((v) => [v] as const))(
    'probes %s exactly as its health_probe facet declares',
    async (vendor) => {
      const probeFacet = getMessengerVendorDeclaration(vendor)!.health_probe;
      const name = await enroll('notification', {
        subtype: vendor,
        auth: { type: 'bearer', token: TOKEN },
      });
      const fetcher = vi.fn<HttpFetcher>(async () => jsonResponse(200, { ok: true }));

      const health = await probe('notification', name, fetcher);

      expect(health.status).toBe('ok');
      const [url, init] = fetcher.mock.calls[0]!;
      expect(url).toBe(
        probeFacet.url.split(MESSENGER_PROBE_TOKEN_PLACEHOLDER).join(TOKEN),
      );
      expect(init?.method).toBe(probeFacet.method);
      // EXHAUSTIVE over the placements, not a binary if/else.
      //
      // This was `if (bearer_header) … else …`, which quietly assumed there would
      // only ever be two. When Discord arrived with `bot_header` it fell into the
      // `else` — the `url_token` branch — and asserted that no Authorization header
      // was sent, on a vendor whose entire credential IS an Authorization header. The
      // it.each above is registry-driven, so it CAUGHT the new vendor for free; the
      // assertion body was the part that had a hand-spelled enumeration hiding in it.
      //
      // A placement with no arm here now fails loudly instead of inheriting whatever
      // the last `else` happened to assert.
      switch (probeFacet.auth) {
        case 'bearer_header':
          // Rides in the header, NEVER in the URL.
          expect(init?.headers?.Authorization).toBe(`Bearer ${TOKEN}`);
          expect(url).not.toContain(TOKEN);
          break;
        case 'bot_header':
          // ⚠ `Bot`, not `Bearer`. Discord reads `Bearer` as an OAuth2 user token, so
          // the wrong scheme would 401 a perfectly valid bot token — reporting
          // `auth_failed` on a healthy channel, indistinguishable from a revoked one.
          expect(init?.headers?.Authorization).toBe(`Bot ${TOKEN}`);
          expect(url).not.toContain(TOKEN);
          break;
        case 'url_token':
          // Rides in the path and sends NO Authorization header at all.
          expect(init?.headers?.Authorization).toBeUndefined();
          expect(url).toContain(TOKEN);
          break;
        default:
          throw new Error(
            `unhandled health_probe.auth placement '${String(probeFacet.auth)}' — `
            + 'add an arm rather than letting it inherit another placement\'s assertions',
          );
      }
    },
  );

  // RETIRED (D-192 CORE #6 make-live) — 'resolves an oauth2_refresh credential via
  // its access token (an OAuth vendor needs no prober edit)'.
  //
  // It asserted that a `slack` row enrolled with `oauth2_refresh` probes GREEN. It
  // did — and that was the DEFECT, not the feature. The send path could not use
  // that credential and silently dropped every message, so the row sat green,
  // ready, and mute. The claim in the test's own name was half-true in the way that
  // matters least: the PROBER needed no edit, but the SEND path did, and nobody had
  // checked it.
  //
  // The shape also contradicted Slack's own declaration (`auth: 'bot_token'`).
  // Enrollment now enforces that declaration, so the row can no longer exist — see
  // `d-192-messenger-auth-deliverability.test.ts`. Deliberately not restored: it
  // pinned a state that must never be reachable again.

  it('keeps auth_failed (NOT unknown) for a messenger row holding a non-bearer credential', async () => {
    // The enroll gate refuses this shape now, so — like the store-write tests below
    // — the row can only be created directly. The prober's fail-closed floor sits
    // BENEATH that gate and still has to hold. The status is load-bearing
    // downstream: `reasonsFromConnectionHealth` maps `auth_failed` →
    // `permission_revoked` and `unknown` → no reason at all, so reporting `unknown`
    // here would silently drop a degradation signal.
    const name = 'slack-oauth-row';
    store.upsert({
      kind: 'notification',
      name,
      subtype: 'slack',
      display_name: name,
      config_json: '{}',
      auth_ciphertext: await encodeAuthForStorage(
        {
          type: 'oauth2_refresh',
          refresh_token: 'r',
          client_id: 'c',
          token_endpoint: 'https://slack.com/api/oauth.v2.access',
        },
        { kind: 'notification', name },
        getEncryptionKey,
      ),
      enrolled_at: NOW,
      updated_at: NOW,
    });

    const health = await probe('notification', name, async () => {
      throw new Error('should not fetch');
    });

    expect(health.status).toBe('auth_failed');
    expect(health.last_error).toBe('auth_type_oauth2_refresh');
  });

  it('fails closed on a whitespace-only bearer token instead of probing with a blank credential', async () => {
    // The shared `resolveBearerAccessToken` admits `'   '` (`length > 0`); the
    // `authString` it replaced did not. Enrollment rejects it, so this needs a
    // direct store write — but it must fail closed, not put `Bearer    ` on the
    // wire.
    const name = 'slack-blank-token';
    store.upsert({
      kind: 'notification',
      name,
      subtype: 'slack',
      display_name: name,
      config_json: '{}',
      auth_ciphertext: await encodeAuthForStorage(
        { type: 'bearer', token: '   ' },
        { kind: 'notification', name },
        getEncryptionKey,
      ),
      enrolled_at: NOW,
      updated_at: NOW,
    });
    const fetcher = vi.fn<HttpFetcher>();

    const health = await probe('notification', name, fetcher);

    expect(health.status).toBe('unknown');
    expect(health.last_error).toBe('auth.token_missing');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('redacts a percent-encoded rendering of the credential, not just the raw one', async () => {
    // A token holding URL-significant characters is normalized into the path, so
    // an error echoing the URL carries it ENCODED — a raw-substring scrub alone
    // would miss it.
    const rawToken = 'tok en/with?chars';
    const name = 'telegram-urlish-token';
    store.upsert({
      kind: 'notification',
      name,
      subtype: 'telegram',
      display_name: name,
      config_json: '{}',
      auth_ciphertext: await encodeAuthForStorage(
        { type: 'bearer', token: rawToken },
        { kind: 'notification', name },
        getEncryptionKey,
      ),
      enrolled_at: NOW,
      updated_at: NOW,
    });

    const health = await probe('notification', name, async (url) => {
      // Mimic a fetch error that echoes the NORMALIZED url — this is the exact
      // rendering that leaks: URL normalization escapes the space but leaves `/`
      // and `?` structural, i.e. `encodeURI`, NOT `encodeURIComponent`. Scrubbing
      // only the raw token (or only the fully component-escaped one) would let
      // this through — assert on the rendering that actually appears.
      throw new Error(`request to ${new URL(url).toString()} failed`);
    });
    const leaked = encodeURI(rawToken); // → `tok%20en/with?chars`

    expect(health.status).toBe('unreachable');
    expect(leaked).not.toBe(rawToken); // guard: the fixture must actually re-encode
    expect(health.last_error).not.toContain(rawToken);
    expect(health.last_error).not.toContain(leaked);
    expect(health.last_error).not.toContain(encodeURIComponent(rawToken));
    expect(storedHealth('notification', name).last_error).not.toContain(leaked);
  });

  it('never persists the credential in last_error, even when the token rides in the URL', async () => {
    // Telegram bakes the bot token into the path, so a fetcher/vendor error that
    // echoes the URL would otherwise write the live token into `health_json`
    // (and onto the Settings surface).
    const name = await enroll('notification', {
      subtype: 'telegram',
      auth: { type: 'bearer', token: TOKEN },
    });

    const health = await probe('notification', name, async (url) => {
      throw new Error(`connect ECONNREFUSED for ${url}`);
    });

    expect(health.status).toBe('unreachable');
    expect(health.last_error).not.toContain(TOKEN);
    expect(health.last_error).toContain('***');
    expect(storedHealth('notification', name).last_error).not.toContain(TOKEN);
  });

  it('redacts a credential echoed back in the vendor error envelope too', async () => {
    const name = await enroll('notification', {
      subtype: 'slack',
      auth: { type: 'bearer', token: TOKEN },
    });

    const health = await probe('notification', name, async () =>
      jsonResponse(200, { ok: false, error: `invalid_auth for ${TOKEN}` }),
    );

    expect(health.status).toBe('auth_failed');
    expect(health.last_error).not.toContain(TOKEN);
  });

  it('fails a messenger subtype whose credential carries no bearer token', async () => {
    // Same fail-closed floor, the other undeliverable shape. Enrollment refuses a
    // credential-less chat transport now (a `none` auth cannot send), so the row
    // needs a direct store write — but the prober must still refuse it rather than
    // report a healthy transport that can never deliver.
    const name = 'telegram-no-credential';
    store.upsert({
      kind: 'notification',
      name,
      subtype: 'telegram',
      display_name: name,
      config_json: '{}',
      auth_ciphertext: await encodeAuthForStorage(
        { type: 'none' },
        { kind: 'notification', name },
        getEncryptionKey,
      ),
      enrolled_at: NOW,
      updated_at: NOW,
    });

    const health = await probe('notification', name, async () => {
      throw new Error('should not fetch');
    });

    expect(health.status).toBe('auth_failed');
    expect(health.last_error).toBe('auth_type_none');
  });

  it('surfaces a bearer-shaped credential with an empty token as unknown', async () => {
    // Enrollment already rejects an empty bearer token, so this row can only
    // exist via a direct store write — the branch is defensive, and it holds the
    // pre-registry behavior (`authString` threw; the caller mapped it to
    // `unknown`) rather than probing with an empty credential.
    const name = 'slack-empty-token';
    store.upsert({
      kind: 'notification',
      name,
      subtype: 'slack',
      display_name: name,
      config_json: '{}',
      auth_ciphertext: await encodeAuthForStorage(
        { type: 'bearer', token: '' },
        { kind: 'notification', name },
        getEncryptionKey,
      ),
      enrolled_at: NOW,
      updated_at: NOW,
    });

    const health = await probe('notification', name, async () => {
      throw new Error('should not fetch');
    });

    expect(health.status).toBe('unknown');
    expect(health.last_error).toBe('auth.token_missing');
  });

  it('enrolls every declared messenger vendor (the subtype gate reads the registry)', async () => {
    // If a vendor were declared but not enrollable, its `health_probe` facet
    // would be unreachable — the enrollment gate is the other half of seam 8.
    for (const vendor of listMessengerVendors()) {
      await expect(
        enroll('notification', { name: `enroll-${vendor}`, subtype: vendor }),
      ).resolves.toBe(`enroll-${vendor}`);
    }
  });

  it('still rejects an undeclared notification subtype', async () => {
    // ⚠ The fixture was the literal `whatsapp` — a vendor that did not exist yet.
    // The day it shipped, this stopped asserting "an undeclared subtype is refused"
    // and started asserting that a REAL one was. Name something that can never be a
    // chat transport instead.
    await expect(
      enroll('notification', { name: 'nope', subtype: 'not_a_transport' }),
    ).rejects.toThrow(/subtype/i);
  });
});

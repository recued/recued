/** D-125 Phase 2.1 — `collection.connection.*` rpc handler tests.
 *
 *  Covers all five methods end-to-end against a real SQLite store:
 *    - list: empty / by kind / cross-kind ordering
 *    - enroll: full path + display_name validation + auth shape +
 *      ON CONFLICT preserves enrolled_at + view auth-exclusion
 *    - update: patch round-trip + immutable identity + not_found +
 *      partial patch (one field at a time)
 *    - delete: live + missing
 *    - probe: not_found + placeholder shape + stamps row.health
 *
 *  Real per-kind probe handlers ship in P4.x; P2.1 only verifies
 *  the placeholder + the row's health_json round-trips. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RpcError,
  CONNECTION_VENDOR_ENTITIES,
  type ConnectionAuth,
  type ConnectionVendorEntity,
} from '@recued/contracts';

import {
  createConnectionStore,
  type ConnectionStoreSqlite,
} from '../storage/connection-store.js';
import {
  encodeAuthForStorage,
  handleConnectionDelete,
  handleConnectionEnroll,
  handleConnectionList,
  handleConnectionProbe,
  handleConnectionRotateCredentials,
  handleConnectionUpdate,
} from '../connection-handler.js';

let dir: string;
let db: Database.Database;
let store: ConnectionStoreSqlite;
let now = 1_700_000_000_000;
const tickNow = (): number => now;
const advanceClock = (ms = 1_000): void => { now += ms; };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'connection-handler-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createConnectionStore(db);
  now = 1_700_000_000_000;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const bearer = (token: string): ConnectionAuth => ({ type: 'bearer', token });

describe('handleConnectionEnroll', () => {
  it('rejects non-object rpc args instead of throwing a raw TypeError', async () => {
    await expect(
      handleConnectionEnroll({ store }, null as unknown as Parameters<typeof handleConnectionEnroll>[1]),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('inserts a new row + returns auth-excluded view + an unstamped pre-probe baseline', async () => {
    const result = await handleConnectionEnroll(
      { store, now: tickNow },
      {
        name: 'hubspot',
        kind: 'api',
        display_name: 'HubSpot Production',
        config: { base_url: 'https://api.hubapi.com' },
        auth: bearer('SECRET-TOKEN-DO-NOT-LEAK'),
      },
    );
    expect(result.connection.name).toBe('hubspot');
    expect(result.connection.kind).toBe('api');
    expect(result.connection.display_name).toBe('HubSpot Production');
    expect(result.connection.base_url).toBe('https://api.hubapi.com');
    // Auth-exclusion guard — the projection must never surface the
    // raw token via any field key.
    const flat = JSON.stringify(result.connection);
    expect(flat.includes('SECRET-TOKEN-DO-NOT-LEAK')).toBe(false);
    expect(result.probe).toEqual({ status: 'unknown' });
    expect(store.get('api', 'hubspot')?.health_json).toBe('{"status":"unknown"}');
  });

  it('enrolls a MULTI-header auth (Plaid PLAID-CLIENT-ID + PLAID-SECRET); view leaks neither value', async () => {
    const result = await handleConnectionEnroll(
      { store, now: tickNow },
      {
        name: 'plaid',
        kind: 'api',
        display_name: 'Plaid Production',
        config: { base_url: 'https://production.plaid.com' },
        auth: {
          type: 'header',
          headers: [
            { header_name: 'PLAID-CLIENT-ID', value: 'CID-SECRET-DO-NOT-LEAK' },
            { header_name: 'PLAID-SECRET', value: 'SEC-SECRET-DO-NOT-LEAK' },
          ],
        },
      },
    );
    expect(result.connection.name).toBe('plaid');
    const flat = JSON.stringify(result.connection);
    expect(flat.includes('CID-SECRET-DO-NOT-LEAK')).toBe(false);
    expect(flat.includes('SEC-SECRET-DO-NOT-LEAK')).toBe(false);
  });

  it('preserves enrolled_at across re-enrollments (first sight wins)', async () => {
    await handleConnectionEnroll(
      { store, now: tickNow },
      {
        name: 'hubspot', kind: 'api',
        display_name: 'HubSpot Production',
        config: { base_url: 'https://api.hubapi.com' },
        auth: bearer('t1'),
      },
    );
    advanceClock(60_000);
    await handleConnectionEnroll(
      { store, now: tickNow },
      {
        name: 'hubspot', kind: 'api',
        display_name: 'HubSpot Sandbox',
        config: { base_url: 'https://sandbox.api.hubapi.com' },
        auth: bearer('t2'),
      },
    );
    const row = store.get('api', 'hubspot');
    expect(row?.enrolled_at).toBe(1_700_000_000_000);
    expect(row?.updated_at).toBe(1_700_000_060_000);
    expect(row?.display_name).toBe('HubSpot Sandbox');
  });

  it('rejects missing / blank display_name', async () => {
    await expect(
      handleConnectionEnroll(
        { store },
        {
          name: 'hubspot', kind: 'api', display_name: '   ',
          config: {}, auth: bearer('t'),
        },
      ),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it.each([
    ['no app_password', { type: 'atproto_session', identifier: 'alice.bsky.social' }],
    ['no identifier', { type: 'atproto_session', app_password: 'abcd-efgh' }],
    ['blank app_password', {
      type: 'atproto_session', identifier: 'alice.bsky.social', app_password: '',
    }],
  ])('D-218 — rejects an atproto_session enroll with %s', async (_label, auth) => {
    // ⚠ A half-filled credential row would enroll a connection that can never
    // exchange a session, and the failure would surface much later as a
    // dispatch error rather than here, where the owner is actually looking.
    await expect(
      handleConnectionEnroll(
        { store },
        {
          name: 'bluesky', kind: 'api', display_name: 'Bluesky',
          config: { base_url: 'https://bsky.social' },
          auth: auth as never,
        },
      ),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('D-218 — accepts a complete atproto_session enroll with NO endpoint field', async () => {
    // ⛔ The absence is the point (§ 7.5b): the session URLs derive from
    // base_url, so there is no destination field to fill in and none to get
    // wrong. A row enrolls with exactly two credential fields.
    await expect(
      handleConnectionEnroll(
        { store },
        {
          name: 'bluesky', kind: 'api', display_name: 'Bluesky',
          config: { base_url: 'https://bsky.social' },
          auth: {
            type: 'atproto_session',
            identifier: 'alice.bsky.social',
            app_password: 'abcd-efgh-ijkl-mnop',
          } as never,
        },
      ),
    ).resolves.toBeDefined();
  });

  it('rejects invalid kind values', async () => {
    await expect(
      handleConnectionEnroll(
        { store },
        {
          name: 'foo',
          kind: 'webhook' as unknown as 'api',
          display_name: 'Foo',
          config: {},
          auth: bearer('t'),
        },
      ),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('rejects names outside the connection identifier regex', async () => {
    for (const name of ['HubSpot', 'hub_spot', '-hubspot', 'a'.repeat(49)]) {
      await expect(
        handleConnectionEnroll(
          { store },
          {
            name, kind: 'api', display_name: 'Hubspot',
            config: {}, auth: bearer('t'),
          },
        ),
      ).rejects.toBeInstanceOf(RpcError);
    }
  });

  it('rejects malformed subtype and publisher metadata', async () => {
    const invalidRows = [
      { kind: 'mcp' as const, subtype: undefined },
      { kind: 'mcp' as const, subtype: 'ftp' },
      { kind: 'notification' as const, subtype: undefined },
      { kind: 'notification' as const, subtype: 'sms' },
      { kind: 'api' as const, subtype: 42 },
      { kind: 'api' as const, publisher_id: 42 },
    ];

    for (const row of invalidRows) {
      await expect(
        handleConnectionEnroll(
          { store },
          {
            name: 'hubspot',
            kind: row.kind,
            ...(row.subtype !== undefined ? { subtype: row.subtype as string } : {}),
            ...(row.publisher_id !== undefined
              ? { publisher_id: row.publisher_id as unknown as string }
              : {}),
            display_name: 'Hubspot',
            config: {},
            auth: bearer('t'),
          },
        ),
      ).rejects.toBeInstanceOf(RpcError);
    }

    expect(store.count()).toBe(0);
  });

  it('rejects auth without a discriminant type', async () => {
    await expect(
      handleConnectionEnroll(
        { store },
        {
          name: 'hubspot', kind: 'api', display_name: 'Hubspot',
          config: {},
          auth: { tokenButNoType: 't' } as unknown as ConnectionAuth,
        },
      ),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('rejects unsupported or incomplete auth variants', async () => {
    const invalidAuths: unknown[] = [
      { type: 'cookie', value: 'sid=1' },
      { type: 'bearer' },
      { type: 'basic', username: 'u' },
      { type: 'header', headers: [] }, // empty array
      { type: 'header', headers: [{ value: 'secret' }] }, // entry missing header_name
      { type: 'header', headers: [{ header_name: '__proto__', value: 'secret' }] }, // proto-sensitive name
      { type: 'header', headers: [{ header_name: 'X-Key', value: '' }] }, // empty value
      { type: 'query', param_name: 'api_key' },
      { type: 'query', param_name: 'constructor', value: 'secret' },
      { type: 'oauth2_refresh', refresh_token: 'r', client_id: 'cid' },
      { type: 'oauth2_client_credentials', client_id: 'cid', token_endpoint: 'https://oauth.example.com/token' },
      {
        type: 'oauth2_refresh',
        refresh_token: 'r',
        client_id: 'cid',
        token_endpoint: 'https://oauth.example.com/token',
        expires_at: 'tomorrow',
      },
      {
        type: 'oauth2_client_credentials',
        client_id: 'cid',
        client_secret: 'secret',
        token_endpoint: 'https://oauth.example.com/token',
        scope: 42,
      },
    ];

    for (const auth of invalidAuths) {
      await expect(
        handleConnectionEnroll(
          { store },
          {
            name: 'hubspot', kind: 'api', display_name: 'Hubspot',
            config: {}, auth: auth as ConnectionAuth,
          },
        ),
      ).rejects.toBeInstanceOf(RpcError);
    }

    expect(store.count()).toBe(0);
  });

  it('rejects unsafe OAuth credential destinations without persisting a row', async () => {
    const unsafeAuths: unknown[] = [
      {
        type: 'oauth2_refresh',
        refresh_token: 'refresh-secret',
        client_id: 'client-id',
        token_endpoint: 'http://oauth.example.com/token',
      },
      {
        type: 'oauth2_refresh',
        refresh_token: 'refresh-secret',
        client_id: 'client-id',
        token_endpoint: 'https://owner:password@oauth.example.com/token',
      },
      {
        type: 'oauth2_client_credentials',
        client_id: 'client-id',
        client_secret: 'client-secret',
        token_endpoint: 'https:oauth.example.com/token',
      },
      {
        type: 'oauth2_client_credentials',
        client_id: 'client-id',
        client_secret: 'client-secret',
        token_endpoint: 'https://oauth.example.com/token#ignored',
      },
    ];

    for (const [index, auth] of unsafeAuths.entries()) {
      await expect(
        handleConnectionEnroll(
          { store },
          {
            name: `unsafe-oauth-${index}`,
            kind: 'api',
            display_name: 'Unsafe OAuth',
            config: {},
            auth: auth as ConnectionAuth,
          },
        ),
      ).rejects.toThrow(/auth\.token_endpoint must be a complete HTTPS URL/);
    }

    expect(store.count()).toBe(0);
  });
});

describe('handleConnectionList', () => {
  beforeEach(async () => {
    await handleConnectionEnroll(
      { store, now: () => 1_700_000_010_000 },
      {
        name: 'hubspot', kind: 'api',
        display_name: 'HubSpot',
        config: { base_url: 'https://api.hubapi.com' },
        auth: bearer('t1'),
      },
    );
    await handleConnectionEnroll(
      { store, now: () => 1_700_000_020_000 },
      {
        name: 'gh-mcp', kind: 'mcp', subtype: 'sse',
        display_name: 'GitHub MCP',
        config: { endpoint: 'https://mcp.github.com/sse' },
        auth: bearer('t2'),
      },
    );
  });

  it('returns every connection when called with no args', async () => {
    const { connections } = await handleConnectionList({ store }, undefined);
    expect(connections.map((c) => c.name).sort()).toEqual(['gh-mcp', 'hubspot']);
    expect(connections.find((c) => c.name === 'hubspot')?.updated_at)
      .toBe(1_700_000_010_000);
    expect(connections.find((c) => c.name === 'gh-mcp')?.updated_at)
      .toBe(1_700_000_020_000);
  });

  it('filters by kind', async () => {
    const { connections } = await handleConnectionList({ store }, { kind: 'api' });
    expect(connections.map((c) => c.name)).toEqual(['hubspot']);
    const mcp = await handleConnectionList({ store }, { kind: 'mcp' });
    expect(mcp.connections.map((c) => c.name)).toEqual(['gh-mcp']);
  });

  it('omits auth from every projected view', async () => {
    const { connections } = await handleConnectionList({ store }, undefined);
    const flat = JSON.stringify(connections);
    expect(flat.includes('t1')).toBe(false);
    expect(flat.includes('t2')).toBe(false);
  });

  it('surfaces only the non-secret auth discriminant for reuse matching', async () => {
    const { connections } = await handleConnectionList({ store }, undefined);
    expect(connections.map((c) => [c.name, c.auth_type]).sort())
      .toEqual([['gh-mcp', 'bearer'], ['hubspot', 'bearer']]);
    expect(JSON.stringify(connections)).not.toContain('"token"');
  });

  it('reads the auth discriminant through vault encryption and fails closed while locked', async () => {
    const key = new Uint8Array(32).fill(7);
    const row = store.get('api', 'hubspot')!;
    store.upsert({
      ...row,
      auth_ciphertext: await encodeAuthForStorage(
        bearer('encrypted-token'),
        { kind: 'api', name: 'hubspot' },
        () => key,
      ),
    });

    const unlocked = await handleConnectionList(
      { store, getEncryptionKey: () => key },
      { kind: 'api' },
    );
    expect(unlocked.connections[0]?.auth_type).toBe('bearer');
    expect(JSON.stringify(unlocked.connections)).not.toContain('encrypted-token');

    const locked = await handleConnectionList(
      { store, getEncryptionKey: () => null },
      { kind: 'api' },
    );
    expect(locked.connections[0]?.auth_type).toBeUndefined();
  });

  it('D-194 #6 — stamps bound_pack_slugs on api rows from the closure (mcp + unwired left undefined)', async () => {
    // Wired: api rows carry the grant-store pack set; mcp rows never do.
    const wired = await handleConnectionList(
      { store, boundPackSlugsForConnection: (name) => (name === 'hubspot' ? ['sales-pack'] : []) },
      undefined,
    );
    const hs = wired.connections.find((c) => c.name === 'hubspot');
    const mcp = wired.connections.find((c) => c.name === 'gh-mcp');
    expect(hs?.bound_pack_slugs).toEqual(['sales-pack']);
    expect(mcp?.bound_pack_slugs).toBeUndefined(); // api-only stamp

    // Unwired (dbless): the field is left off entirely → the UI falls back to vendor-match.
    const unwired = await handleConnectionList({ store }, { kind: 'api' });
    expect(unwired.connections[0].bound_pack_slugs).toBeUndefined();
  });

  it('D-194 #6 — a config key named bound_pack_slugs cannot spoof the stamp (reserved-field strip)', async () => {
    // A stored config key of the reserved name — must never shadow the code-set field.
    await handleConnectionEnroll(
      { store, now: () => 1_700_000_030_000 },
      {
        name: 'spoofy', kind: 'api', display_name: 'Spoofy',
        config: { base_url: 'https://api.spoof.com', bound_pack_slugs: 'evil-not-an-array' },
        auth: bearer('t3'),
      },
    );
    // Unwired: connectionViewFromRow STRIPS the reserved key → not leaked (no stamp either).
    const unwired = await handleConnectionList({ store }, { kind: 'api' });
    expect(unwired.connections.find((c) => c.name === 'spoofy')?.bound_pack_slugs).toBeUndefined();
    // Wired: the handler's grant-store stamp (an array) wins, never the config string.
    const wired = await handleConnectionList(
      { store, boundPackSlugsForConnection: (name) => (name === 'spoofy' ? ['real-pack'] : []) },
      undefined,
    );
    expect(wired.connections.find((c) => c.name === 'spoofy')?.bound_pack_slugs).toEqual(['real-pack']);
  });

  it('throws on invalid kind in args', async () => {
    await expect(
      handleConnectionList(
        { store },
        { kind: 'webhook' as unknown as 'api' },
      ),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('throws on non-object args', async () => {
    await expect(
      handleConnectionList(
        { store },
        'api' as unknown as Parameters<typeof handleConnectionList>[1],
      ),
    ).rejects.toBeInstanceOf(RpcError);
  });
});

describe('handleConnectionList — D-192 S5 supports_engagement_health', () => {
  // A fake PACK-declared engagement vendor. `vendorHasEngagement` only reads
  // `.vendor` + `.engagement`, so this minimal (but type-complete) entity proves
  // the stamp follows the LIVE merged registry — not a hardcoded
  // [hubspot, salesforce] list — the whole point of the de-hardcode.
  const packRegistry: ReadonlyArray<ConnectionVendorEntity> = [
    ...CONNECTION_VENDOR_ENTITIES,
    {
      vendor: 'dynamics',
      entity: 'email',
      scope: 'connection.api.dynamics.email',
      display_name: 'Dynamics Email',
      meta_fields: [],
      engagement: { capability: 'always', sync_kind: 'delta_cursor' },
    },
  ];

  beforeEach(async () => {
    // hubspot = a BUILT-IN engagement vendor; dynamics = a PACK vendor absent
    // from the built-ins; stripe = a vendor-less non-engagement api row.
    await handleConnectionEnroll(
      { store, now: tickNow },
      { name: 'acme-hubspot', kind: 'api', display_name: 'Acme HubSpot',
        config: { base_url: 'https://api.hubapi.com', vendor: 'hubspot' }, auth: bearer('t1') },
    );
    await handleConnectionEnroll(
      { store, now: tickNow },
      { name: 'acme-dynamics', kind: 'api', display_name: 'Acme Dynamics',
        config: { base_url: 'https://acme.crm.dynamics.com', vendor: 'dynamics' }, auth: bearer('t2') },
    );
    await handleConnectionEnroll(
      { store, now: tickNow },
      { name: 'stripe', kind: 'api', display_name: 'Stripe',
        config: { base_url: 'https://api.stripe.com' }, auth: bearer('t3') },
    );
    await handleConnectionEnroll(
      { store, now: tickNow },
      { name: 'gh-mcp', kind: 'mcp', subtype: 'sse', display_name: 'GitHub MCP',
        config: { endpoint: 'https://mcp.github.com/sse' }, auth: bearer('t4') },
    );
  });

  it('stamps true for a built-in engagement vendor (hubspot)', async () => {
    const { connections } = await handleConnectionList(
      { store, resolveVendorRegistry: () => CONNECTION_VENDOR_ENTITIES },
      { kind: 'api' },
    );
    expect(connections.find((c) => c.name === 'acme-hubspot')?.supports_engagement_health).toBe(true);
  });

  it('stamps true for a PACK-declared engagement vendor the built-in list omits (dynamics)', async () => {
    // Built-in registry doesn't know dynamics → false (the stamp reads the registry).
    const builtinOnly = await handleConnectionList(
      { store, resolveVendorRegistry: () => CONNECTION_VENDOR_ENTITIES },
      { kind: 'api' },
    );
    expect(
      builtinOnly.connections.find((c) => c.name === 'acme-dynamics')?.supports_engagement_health,
    ).toBe(false);
    // Live merged registry (built-ins + the dynamics pack) → true, no code edit.
    const live = await handleConnectionList(
      { store, resolveVendorRegistry: () => packRegistry },
      { kind: 'api' },
    );
    expect(
      live.connections.find((c) => c.name === 'acme-dynamics')?.supports_engagement_health,
    ).toBe(true);
  });

  it('stamps false for a vendor-less / non-engagement api row (stripe)', async () => {
    const { connections } = await handleConnectionList(
      { store, resolveVendorRegistry: () => packRegistry },
      { kind: 'api' },
    );
    expect(connections.find((c) => c.name === 'stripe')?.supports_engagement_health).toBe(false);
  });

  it('never stamps mcp rows; leaves the field off entirely when unwired (dbless)', async () => {
    const wired = await handleConnectionList(
      { store, resolveVendorRegistry: () => CONNECTION_VENDOR_ENTITIES },
      undefined,
    );
    expect(
      wired.connections.find((c) => c.name === 'gh-mcp')?.supports_engagement_health,
    ).toBeUndefined(); // api-only stamp

    const unwired = await handleConnectionList({ store }, { kind: 'api' });
    expect(unwired.connections.every((c) => c.supports_engagement_health === undefined)).toBe(true);
  });

  it('a config key named supports_engagement_health cannot spoof the stamp (reserved-field strip)', async () => {
    await handleConnectionEnroll(
      { store, now: tickNow },
      { name: 'spoofy', kind: 'api', display_name: 'Spoofy',
        config: {
          base_url: 'https://api.spoof.com',
          vendor: 'stripe',
          supports_engagement_health: 'yes-trust-me',
        },
        auth: bearer('t5') },
    );
    // Unwired: connectionViewFromRow STRIPS the reserved key → not leaked (no stamp).
    const unwired = await handleConnectionList({ store }, { kind: 'api' });
    expect(
      unwired.connections.find((c) => c.name === 'spoofy')?.supports_engagement_health,
    ).toBeUndefined();
    // Wired: the code-computed boolean (stripe → false) wins, never the config string.
    const wired = await handleConnectionList(
      { store, resolveVendorRegistry: () => packRegistry },
      { kind: 'api' },
    );
    expect(
      wired.connections.find((c) => c.name === 'spoofy')?.supports_engagement_health,
    ).toBe(false);
  });
});

describe('handleConnectionUpdate', () => {
  beforeEach(async () => {
    await handleConnectionEnroll(
      { store, now: () => 1_700_000_010_000 },
      {
        name: 'hubspot', kind: 'api',
        display_name: 'HubSpot Prod',
        config: { base_url: 'https://api.hubapi.com' },
        auth: bearer('t-original'),
      },
    );
  });

  it('round-trips a display_name patch + bumps updated_at', async () => {
    const result = await handleConnectionUpdate(
      { store, now: () => 1_700_000_050_000 },
      {
        name: 'hubspot', kind: 'api',
        patch: { display_name: 'HubSpot Sandbox' },
      },
    );
    expect(result.connection.display_name).toBe('HubSpot Sandbox');
    const row = store.get('api', 'hubspot');
    expect(row?.updated_at).toBe(1_700_000_050_000);
    expect(row?.enrolled_at).toBe(1_700_000_010_000);
    // Untouched fields preserved.
    expect(row?.config_json).toContain('api.hubapi.com');
  });

  it('rejects non-object rpc args instead of throwing a raw TypeError', async () => {
    await expect(
      handleConnectionUpdate(
        { store },
        null as unknown as Parameters<typeof handleConnectionUpdate>[1],
      ),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('round-trips a config patch in isolation', async () => {
    await handleConnectionUpdate(
      { store, now: () => 1_700_000_060_000 },
      {
        name: 'hubspot', kind: 'api',
        patch: { config: { base_url: 'https://eu.api.hubapi.com' } },
      },
    );
    const row = store.get('api', 'hubspot');
    expect(row?.config_json).toContain('eu.api.hubapi.com');
    expect(row?.display_name).toBe('HubSpot Prod'); // Untouched.
  });

  it('rejects a stale editor revision and advances a matching revision monotonically', async () => {
    const before = store.get('api', 'hubspot')!;
    await expect(handleConnectionUpdate(
      { store, now: () => before.updated_at },
      {
        name: 'hubspot',
        kind: 'api',
        expected_updated_at: before.updated_at - 1,
        patch: { display_name: 'Must not land' },
      },
    )).rejects.toMatchObject({
      code: 'conflict',
      details: { existing_credential_preserved: true },
    });
    expect(store.get('api', 'hubspot')).toEqual(before);

    await handleConnectionUpdate(
      { store, now: () => before.updated_at },
      {
        name: 'hubspot',
        kind: 'api',
        expected_updated_at: before.updated_at,
        patch: { display_name: 'Current editor' },
      },
    );
    expect(store.get('api', 'hubspot')).toMatchObject({
      display_name: 'Current editor',
      updated_at: before.updated_at + 1,
    });
  });

  it('rejects the legacy unverified auth-patch path without changing the row', async () => {
    const before = store.get('api', 'hubspot');
    await expect(handleConnectionUpdate(
      { store },
      {
        name: 'hubspot', kind: 'api',
        patch: { auth: bearer('NEW-SECRET-DO-NOT-LEAK') },
      },
    )).rejects.toMatchObject({
      code: 'credential_verification_required',
      details: { existing_credential_preserved: true },
    });
    expect(store.get('api', 'hubspot')).toEqual(before);
  });

  it('throws not_found when the connection does not exist', async () => {
    await expect(
      handleConnectionUpdate(
        { store },
        {
          name: 'salesforcedev', kind: 'api',
          patch: { display_name: 'Salesforce Dev' },
        },
      ),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('rejects invalid patch shapes before corrupting the stored row', async () => {
    const invalidPatches = [
      { display_name: '   ' },
      { config: null as unknown as Record<string, unknown> },
      { config: [] as unknown as Record<string, unknown> },
    ];

    for (const patch of invalidPatches) {
      await expect(
        handleConnectionUpdate(
          { store },
          { name: 'hubspot', kind: 'api', patch },
        ),
      ).rejects.toBeInstanceOf(RpcError);
    }
    const invalidAuth = [
      { tokenButNoType: 't' } as unknown as ConnectionAuth,
      { type: 'cookie', value: 'sid=1' } as unknown as ConnectionAuth,
      { type: 'bearer' } as unknown as ConnectionAuth,
      {
        type: 'oauth2_refresh',
        refresh_token: 'r',
        client_id: 'cid',
      } as unknown as ConnectionAuth,
    ];
    for (const auth of invalidAuth) {
      await expect(
        handleConnectionRotateCredentials(
          { store },
          {
            attempt_id: 'rotation-invalid-test-0001',
            name: 'hubspot',
            kind: 'api',
            patch: { auth },
          },
        ),
      ).rejects.toBeInstanceOf(RpcError);
    }

    const row = store.get('api', 'hubspot');
    expect(row?.display_name).toBe('HubSpot Prod');
    expect(JSON.parse(row!.config_json)).toEqual({ base_url: 'https://api.hubapi.com' });
  });

  it('rejects an unsafe OAuth endpoint patch without changing the stored row', async () => {
    const before = store.get('api', 'hubspot');

    await expect(
      handleConnectionRotateCredentials(
        { store, now: () => 1_700_000_090_000 },
        {
          attempt_id: 'rotation-unsafe-url-0001',
          name: 'hubspot',
          kind: 'api',
          patch: {
            auth: {
              type: 'oauth2_refresh',
              refresh_token: 'replacement-refresh-token',
              client_id: 'replacement-client-id',
              token_endpoint: 'https://owner:password@oauth.example.com/token',
            },
          },
        },
      ),
    ).rejects.toThrow(/auth\.token_endpoint must be a complete HTTPS URL/);

    expect(store.get('api', 'hubspot')).toEqual(before);
  });
});

describe('handleConnectionDelete', () => {
  it('returns deleted: true when a row was removed', async () => {
    await handleConnectionEnroll(
      { store, now: tickNow },
      {
        name: 'hubspot', kind: 'api',
        display_name: 'HubSpot',
        config: {}, auth: bearer('t'),
      },
    );
    const result = await handleConnectionDelete(
      { store },
      { name: 'hubspot', kind: 'api' },
    );
    expect(result.deleted).toBe(true);
    expect(store.get('api', 'hubspot')).toBeNull();
  });

  it('returns deleted: false when no matching row existed', async () => {
    const result = await handleConnectionDelete(
      { store },
      { name: 'never-enrolled', kind: 'api' },
    );
    expect(result.deleted).toBe(false);
  });

  it('rejects non-object rpc args instead of throwing a raw TypeError', async () => {
    await expect(
      handleConnectionDelete(
        { store },
        null as unknown as Parameters<typeof handleConnectionDelete>[1],
      ),
    ).rejects.toBeInstanceOf(RpcError);
  });
});

describe('handleConnectionProbe', () => {
  it('throws not_found when the connection does not exist', async () => {
    await expect(
      handleConnectionProbe(
        { store },
        { name: 'never-enrolled', kind: 'api' },
      ),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('rejects non-object rpc args instead of throwing a raw TypeError', async () => {
    await expect(
      handleConnectionProbe(
        { store },
        null as unknown as Parameters<typeof handleConnectionProbe>[1],
      ),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('returns the placeholder health shape and stamps the row', async () => {
    await handleConnectionEnroll(
      { store, now: () => 1_700_000_010_000 },
      {
        name: 'hubspot', kind: 'api',
        display_name: 'HubSpot',
        config: {}, auth: bearer('t'),
      },
    );
    const result = await handleConnectionProbe(
      { store, now: () => 1_700_000_050_000 },
      { name: 'hubspot', kind: 'api' },
    );
    expect(result.health).toEqual({
      status: 'unknown',
      last_probed_at: 1_700_000_050_000,
    });
    // Row's health_json updated.
    const row = store.get('api', 'hubspot');
    expect(row?.health_json).toContain('"status":"unknown"');
    expect(row?.updated_at).toBe(1_700_000_050_000);
  });
});

describe('granted_scopes capture + preservation', () => {
  const enroll = (
    extra: Partial<Parameters<typeof handleConnectionEnroll>[1]> = {},
  ): Promise<unknown> =>
    handleConnectionEnroll(
      { store, now: tickNow },
      {
        name: 'hubspot', kind: 'api',
        display_name: 'HubSpot',
        config: { base_url: 'https://api.hubapi.com' },
        auth: bearer('t'),
        ...extra,
      },
    );

  it('captures granted_scopes on enroll → row column + view (non-secret)', async () => {
    const result = await handleConnectionEnroll(
      { store, now: tickNow },
      {
        name: 'hubspot', kind: 'api',
        display_name: 'HubSpot',
        config: {}, auth: bearer('t'),
        granted_scopes: ['crm.objects.deals.read', 'crm.objects.contacts.read'],
      },
    );
    expect(result.connection.granted_scopes).toEqual([
      'crm.objects.deals.read',
      'crm.objects.contacts.read',
    ]);
    const row = store.get('api', 'hubspot');
    expect(JSON.parse(row?.granted_scopes_json ?? 'null')).toEqual([
      'crm.objects.deals.read',
      'crm.objects.contacts.read',
    ]);
  });

  it('trims + de-dupes captured scopes, preserving first-seen order', async () => {
    await enroll({ granted_scopes: [' a ', 'b', 'a', '  ', 'b'] });
    expect(JSON.parse(store.get('api', 'hubspot')?.granted_scopes_json ?? 'null'))
      .toEqual(['a', 'b']);
  });

  it('leaves the column absent when no scopes are supplied', async () => {
    const result = await enroll();
    expect(result).toBeDefined();
    expect(store.get('api', 'hubspot')?.granted_scopes_json).toBeUndefined();
    const list = await handleConnectionList({ store }, { kind: 'api' });
    expect(list.connections[0]?.granted_scopes).toBeUndefined();
  });

  it('folds an empty / whitespace-only array to "unknown" (not a stored [])', async () => {
    await enroll({ granted_scopes: [] });
    expect(store.get('api', 'hubspot')?.granted_scopes_json).toBeUndefined();
    advanceClock(1_000);
    await enroll({ granted_scopes: ['   ', ''] });
    expect(store.get('api', 'hubspot')?.granted_scopes_json).toBeUndefined();
  });

  it('preserves the stored set on a re-enroll that omits scopes (no silent wipe)', async () => {
    await enroll({ granted_scopes: ['crm.objects.deals.read'] });
    advanceClock(60_000);
    await enroll({ display_name: 'HubSpot v2' }); // token-refresh-style re-enroll
    expect(JSON.parse(store.get('api', 'hubspot')?.granted_scopes_json ?? 'null'))
      .toEqual(['crm.objects.deals.read']);
  });

  it('replaces with a narrower set when a re-authorize grants fewer scopes', async () => {
    await enroll({ granted_scopes: ['a', 'b', 'c'] });
    advanceClock(60_000);
    await enroll({ granted_scopes: ['a'] });
    expect(JSON.parse(store.get('api', 'hubspot')?.granted_scopes_json ?? 'null'))
      .toEqual(['a']);
  });

  it('preserves granted_scopes across an update (config patch never wipes it)', async () => {
    await enroll({ granted_scopes: ['crm.objects.deals.read'] });
    await handleConnectionUpdate(
      { store, now: tickNow },
      { name: 'hubspot', kind: 'api', patch: { config: { base_url: 'https://x' } } },
    );
    expect(JSON.parse(store.get('api', 'hubspot')?.granted_scopes_json ?? 'null'))
      .toEqual(['crm.objects.deals.read']);
  });

  it('preserves granted_scopes across a probe re-stamp', async () => {
    await enroll({ granted_scopes: ['crm.objects.deals.read'] });
    await handleConnectionProbe({ store, now: tickNow }, { name: 'hubspot', kind: 'api' });
    expect(JSON.parse(store.get('api', 'hubspot')?.granted_scopes_json ?? 'null'))
      .toEqual(['crm.objects.deals.read']);
  });

  it('rejects a non-array granted_scopes', async () => {
    await expect(
      enroll({ granted_scopes: 'crm.objects.deals.read' as unknown as string[] }),
    ).rejects.toThrow(/granted_scopes must be an array/);
  });

  it('rejects a non-string element', async () => {
    await expect(
      enroll({ granted_scopes: ['ok', 42 as unknown as string] }),
    ).rejects.toThrow(/granted_scopes must be an array/);
  });
});

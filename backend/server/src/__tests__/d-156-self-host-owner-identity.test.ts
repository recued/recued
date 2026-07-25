/** D-156 follow-on — self-host owner identity for the Devices roster.
 *
 *  The bearer-derived-instance fix (`d-151-bearer-derived-instance.test.ts`)
 *  let a bearer-only webclient PASS the instance-gated rpcs, but the Devices
 *  roster (`pair.list` / `pair.revoke`) authorizes/enumerates by the caller's
 *  `user_id`, which a webclient never reports — and `/auth/pair` seeded its
 *  durable row with `user_id: ''`. So a paired webclient never appeared, and
 *  the wired "This device" marker had no row to mark. The fix records the row
 *  under (and resolves the gate to) a stable `SELF_HOST_OWNER_ID` for any
 *  verified-bearer client lacking a reported `user_id`, fails closed for
 *  anonymous connections, and makes the roster's `connected` flag + a webclient
 *  revoke account for the bearer-only socket (whose paired identity lives in
 *  `token_instance_id`, not the live map's `instance_id`).
 *
 *  Covers:
 *    - `resolveGatedClientOwnerId` (pure) — cloud-user wins, bearer fallback,
 *      anonymous fail-closed; the `SELF_HOST_OWNER_ID` constant pin.
 *    - `handlePairList` / `makePairHandlers` — a SELF_HOST_OWNER_ID-seeded
 *      webclient row enumerates + flags connected when its token-derived id is
 *      live; the empty-owner guard is unchanged; an anonymous caller gets [].
 *    - `pair.revoke` from a webclient — passes the cross-account guard, closes
 *      its socket, records the webclient as the revoker.
 *    - live ws-server roster — a never-registered bearer webclient appears in
 *      `listConnectedPairedInstances` (but NOT the extension-only
 *      `listConnectedInstances`), and `revokeConnectedInstance` matches it on
 *      `token_instance_id`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import WebSocket from 'ws';
import Database from 'better-sqlite3';

import {
  // exercised via the back-compat re-export surface (callers + the older
  // test import these from `../ws-server.js`, not the leaf module)
  resolveGatedClientOwnerId,
  SELF_HOST_OWNER_ID,
  type WsClient,
  type WsServerHandle,
} from '../ws-server.js';
import { handlePairList, makePairHandlers } from '../pair-handler.js';
import {
  createPairedInstancesStore,
  type PairedInstancesStore,
} from '../paired-instances-store.js';
import { startServer, type RunningServer } from '../server.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { createClientTokenStore } from '../pairing/client-tokens.js';
import {
  STRUCTURED_BEARER_LEN,
  STRUCTURED_BEARER_TOKEN_ID_LEN,
} from '../ws-server.js';
import type { RecipeDefinition } from '@recued/contracts';

// ════════════════════════════════════════════════════════════════
// resolveGatedClientOwnerId — pure
// ════════════════════════════════════════════════════════════════

describe('resolveGatedClientOwnerId', () => {
  it('keeps a reported cloud user_id (signed-in extension)', () => {
    expect(
      resolveGatedClientOwnerId({
        user_id: 'cloud-mary',
        client_token_id: 'ctok',
        instance_id: null,
      }),
    ).toBe('cloud-mary');
  });

  it('falls back to SELF_HOST_OWNER_ID for a verified bearer with a valid paired identity (webclient)', () => {
    // A live webclient: verified bearer + token-derived paired identity.
    expect(
      resolveGatedClientOwnerId({
        client_token_id: 'ctok',
        instance_id: null,
        token_instance_id: 'wc-1',
      }),
    ).toBe(SELF_HOST_OWNER_ID);
    // An explicit empty-string user_id is treated as "no user reported".
    expect(
      resolveGatedClientOwnerId({
        user_id: '',
        client_token_id: 'ctok',
        instance_id: null,
        token_instance_id: 'wc-1',
      }),
    ).toBe(SELF_HOST_OWNER_ID);
    // A registered-but-not-signed-in self-host extension: explicit instance_id
    // is a valid paired identity too.
    expect(
      resolveGatedClientOwnerId({
        client_token_id: 'ctok',
        instance_id: 'ext-1',
        token_instance_id: null,
      }),
    ).toBe(SELF_HOST_OWNER_ID);
  });

  it('returns "" for a revoked bearer whose token survives but paired identity is gone (Codex HIGH — revoke gate)', () => {
    // `pair.revoke` marks the paired row revoked + closes the socket but does
    // NOT revoke the `client_tokens` row, so a revoked device that reconnects
    // still carries a `client_token_id`. `deriveBearerInstanceId` revoke-gates
    // `token_instance_id` to null, so both ids are null here — the owner gate
    // must DENY (else the revoked webclient could re-enumerate/re-revoke).
    expect(
      resolveGatedClientOwnerId({
        client_token_id: 'ctok-revoked',
        instance_id: null,
        token_instance_id: null,
      }),
    ).toBe('');
  });

  it('returns "" for an anonymous / un-bearer-verified connection (fail-closed)', () => {
    expect(resolveGatedClientOwnerId({ instance_id: null })).toBe('');
    // Even with a live paired identity, no verified bearer (`client_token_id`)
    // → no owner. The db-less legacy accept-any path lands here.
    expect(
      resolveGatedClientOwnerId({
        user_id: '',
        client_token_id: undefined,
        instance_id: null,
        token_instance_id: 'wc-1',
      }),
    ).toBe('');
  });

  it('cloud user_id wins even when a client_token_id is also present', () => {
    expect(
      resolveGatedClientOwnerId({
        user_id: 'abc',
        client_token_id: 'ctok',
        instance_id: null,
      }),
    ).toBe('abc');
  });
});

describe('SELF_HOST_OWNER_ID', () => {
  it('is the stable "self" constant (regression pin)', () => {
    expect(SELF_HOST_OWNER_ID).toBe('self');
  });
});

// ════════════════════════════════════════════════════════════════
// handlePairList / makePairHandlers — owner resolution + connected flag
// ════════════════════════════════════════════════════════════════

/** Test handle stub. `livePaired` seeds the new
 *  `listConnectedPairedInstances` accessor (the one `handlePairList` now reads
 *  for the `connected` / `connected_at` columns). `closedIds` records every
 *  `revokeConnectedInstance` target. */
const stubWsServer = (
  livePaired: Array<{ instance_id: string; connected_at: number }> = [],
): WsServerHandle & { closedIds: string[] } => {
  const closedIds: string[] = [];
  return {
    clientCount: () => 0,
    listConnectedInstances: () => [],
    listConnectedPairedInstances: () => livePaired,
    getPairedUserId: () => undefined,
    revokeConnectedInstance: (id: string) => {
      closedIds.push(id);
      return { revoked: true };
    },
    revokeAllConnectedInstances: () => 0,
    closeAllForWsLockout: () => 0,
    closedIds,
  } as unknown as WsServerHandle & { closedIds: string[] };
};

/** A bearer-only webclient connection: null `instance_id` (never registered),
 *  paired identity in `token_instance_id`, verified bearer
 *  (`client_token_id`), no reported cloud `user_id`. */
const webclientCtx = (over: Partial<WsClient> = {}): WsClient =>
  ({
    ws: null,
    realm: 'recued',
    instance_id: null,
    token_instance_id: 'wc-1',
    client_token_id: 'ctok-wc',
    display_name: 'unknown',
    connected_at: Date.now(),
    ...over,
  }) as unknown as WsClient;

describe('handlePairList — webclient roster', () => {
  let db: Database.Database;
  let paired: PairedInstancesStore;

  beforeEach(() => {
    db = new Database(':memory:');
    paired = createPairedInstancesStore(db);
    paired.addOrRefresh({
      instance_id: 'wc-1',
      user_id: SELF_HOST_OWNER_ID,
      display_name: 'My browser',
    });
  });

  it('lists a SELF_HOST_OWNER_ID-seeded webclient row + marks it connected when its token-derived id is live', async () => {
    const ws = stubWsServer([{ instance_id: 'wc-1', connected_at: 1700 }]);
    const { devices } = await handlePairList({ paired, wsServer: ws }, SELF_HOST_OWNER_ID);
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      instance_id: 'wc-1',
      display_name: 'My browser',
      connected: true,
      connected_at: 1700,
    });
  });

  it('marks the row disconnected (no connected_at) when no live paired instance matches', async () => {
    const ws = stubWsServer([]);
    const { devices } = await handlePairList({ paired, wsServer: ws }, SELF_HOST_OWNER_ID);
    expect(devices[0]!.connected).toBe(false);
    expect('connected_at' in devices[0]!).toBe(false);
  });

  it('returns an empty roster for an empty owner id (anonymous gate unchanged)', async () => {
    const ws = stubWsServer([{ instance_id: 'wc-1', connected_at: 1700 }]);
    const { devices } = await handlePairList({ paired, wsServer: ws }, '');
    expect(devices).toEqual([]);
  });

  it('D-156 P10 — carries the per-device kind through to ServerPairedDevice', async () => {
    // The seeded wc-1 has no explicit kind → defaults to webclient.
    paired.addOrRefresh({
      instance_id: 'br-1',
      user_id: SELF_HOST_OWNER_ID,
      display_name: 'Laptop bridge',
      kind: 'bridge',
    });
    const ws = stubWsServer([]);
    const { devices } = await handlePairList({ paired, wsServer: ws }, SELF_HOST_OWNER_ID);
    const byId = Object.fromEntries(devices.map((d) => [d.instance_id, d.kind]));
    expect(byId).toEqual({ 'wc-1': 'webclient', 'br-1': 'bridge' });
  });
});

describe('makePairHandlers — owner resolution', () => {
  let db: Database.Database;
  let paired: PairedInstancesStore;
  let ws: WsServerHandle & { closedIds: string[] };

  beforeEach(() => {
    db = new Database(':memory:');
    paired = createPairedInstancesStore(db);
    paired.addOrRefresh({
      instance_id: 'wc-1',
      user_id: SELF_HOST_OWNER_ID,
      display_name: 'My browser',
    });
    ws = stubWsServer([{ instance_id: 'wc-1', connected_at: 1700 }]);
  });

  it('pair.list resolves a bearer webclient to SELF_HOST_OWNER_ID → its rows enumerate', async () => {
    const slice = makePairHandlers(paired, () => ws);
    const result = (await slice!.handlers['pair.list'](undefined as never, webclientCtx())) as {
      devices: Array<{ instance_id: string }>;
    };
    expect(result.devices.map((d) => d.instance_id)).toEqual(['wc-1']);
  });

  it('pair.list from an anonymous connection (no client_token_id) → empty roster (fail-closed)', async () => {
    const slice = makePairHandlers(paired, () => ws);
    const result = (await slice!.handlers['pair.list'](
      undefined as never,
      webclientCtx({ client_token_id: undefined }),
    )) as { devices: unknown[] };
    expect(result.devices).toEqual([]);
  });

  it('pair.revoke from a webclient revokes its own row, closes its socket, and records the webclient as revoker', async () => {
    const audit: Array<{ detail?: string }> = [];
    const slice = makePairHandlers(paired, () => ws, {
      logActivity: async (entry: { detail?: string }) => {
        audit.push(entry.detail !== undefined ? { detail: entry.detail } : {});
      },
    });
    const res = await slice!.handlers['pair.revoke'](
      { instance_id: 'wc-1' },
      webclientCtx(),
    );
    expect(res).toEqual({ ok: true });
    // Cross-account guard passed: row.user_id ('self') === resolved owner ('self').
    expect(paired.isRevoked('wc-1')).toBe(true);
    expect(ws.closedIds).toEqual(['wc-1']);
    // Best-effort audit emit is fire-and-forget.
    await new Promise((r) => setTimeout(r, 0));
    const detail = JSON.parse(audit[0]!.detail!) as Record<string, unknown>;
    expect(detail.revoked_by_user_id).toBe(SELF_HOST_OWNER_ID);
    // ctx.instance_id resolves to the webclient's token-derived id, so the
    // revoker is recorded even though the live `instance_id` is null.
    expect(detail.revoked_by_instance_id).toBe('wc-1');
  });

  it('pair.revoke from a non-owner cloud user cannot revoke a self-host row (cross-account guard holds)', async () => {
    const slice = makePairHandlers(paired, () => ws);
    await expect(
      slice!.handlers['pair.revoke'](
        { instance_id: 'wc-1' },
        webclientCtx({ user_id: 'eve-cloud' }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(paired.isRevoked('wc-1')).toBe(false);
    expect(ws.closedIds).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════
// Live ws-server roster — never-registered bearer webclient
// ════════════════════════════════════════════════════════════════

const FAST_ARGON2 = { t: 1, m: 8, p: 1 };

const RECIPE: RecipeDefinition = {
  recipe_id: 'self-host-owner-test',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Self-host owner test',
    description: 't',
    author: 't',
    supported_platforms: ['t'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 'x', transform: 'template', template: 'ok' }],
  output: { sidebar: [{ type: 'text', source: 'step.x' }] },
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const connect = (
  port: number,
  token: string,
): Promise<{ ws: WebSocket; opened: boolean }> =>
  new Promise((resolve) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`,
    );
    let settled = false;
    ws.on('open', () => {
      if (settled) return;
      settled = true;
      resolve({ ws, opened: true });
    });
    const fail = () => {
      if (settled) return;
      settled = true;
      resolve({ ws, opened: false });
    };
    ws.on('error', fail);
    ws.on('unexpected-response', fail);
  });

describe('ws-server live roster — bearer webclient (never registers)', () => {
  let server: RunningServer | undefined;
  let db: Database.Database;
  let tokenId: string;
  let bearer: string;

  beforeAll(async () => {
    const manifests = createManifestRegistry('/nonexistent');
    const recipeStore = createRecipeStore('/nonexistent');
    recipeStore.register(RECIPE);

    db = new Database(':memory:');
    const clientTokens = createClientTokenStore(db, { argon2_params: FAST_ARGON2 });
    // The webclient's paired identity is carried in token metadata (stamped at
    // `/auth/pair`); the WS upgrade derives `token_instance_id` from it.
    const issued = await clientTokens.issue({
      client_kind: 'webclient',
      client_label: 'Test webclient',
      metadata: { instance_id: 'wc-live' },
    });
    tokenId = issued.token_id;
    bearer = issued.bearer;
    // sanity: the structured bearer the upgrade path expects
    expect(tokenId.length).toBe(STRUCTURED_BEARER_TOKEN_ID_LEN);
    expect(bearer.length).toBe(STRUCTURED_BEARER_LEN);

    server = await startServer(0, {
      executeDeps: {
        recipeStore,
        executorConfig: { manifests },
        baseVault: {},
      },
      clientTokens,
    });
  });

  afterAll(async () => {
    await server?.close();
    db.close();
  });

  it('listConnectedPairedInstances includes a never-registered webclient; listConnectedInstances (extension-only) does not', async () => {
    const { ws, opened } = await connect(server!.port, `${tokenId}.${bearer}`);
    expect(opened).toBe(true);
    await wait(30);
    const paired = server!.wsServer.listConnectedPairedInstances();
    expect(paired.some((r) => r.instance_id === 'wc-live')).toBe(true);
    const ext = server!.wsServer.listConnectedInstances();
    expect(ext.some((r) => r.instance_id === 'wc-live')).toBe(false);
    ws.close();
    await wait(30);
  });

  it('revokeConnectedInstance matches the webclient on token_instance_id (closes the live socket with 4003 + returns its client_token_id)', async () => {
    const { ws, opened } = await connect(server!.port, `${tokenId}.${bearer}`);
    expect(opened).toBe(true);
    await wait(30);
    // Capture the server-side close code BEFORE revoking so the assertion
    // can't pass on a wrong/absent code (Codex LOW).
    const closed = new Promise<number>((resolve) => {
      ws.on('close', (code: number) => resolve(code));
    });
    const result = server!.wsServer.revokeConnectedInstance('wc-live');
    expect(result.revoked).toBe(true);
    expect(result.client_token_id).toBe(tokenId);
    // 4003 = instance_revoked → the webclient transport maps this exact code
    // to its reauth / re-pair path.
    const code = await closed;
    expect(code).toBe(4003);
  });
});

// ════════════════════════════════════════════════════════════════
// D-156 P10 — the WS register / replace paths record the verified
// client-token kind on the durable roster row.
// ════════════════════════════════════════════════════════════════

describe('ws-server register path — records the verified client kind (D-156 P10)', () => {
  let server: RunningServer | undefined;
  let db: Database.Database;
  let paired: PairedInstancesStore;
  let bridgeTokenId: string;
  let bridgeBearer: string;

  beforeAll(async () => {
    const manifests = createManifestRegistry('/nonexistent');
    const recipeStore = createRecipeStore('/nonexistent');
    recipeStore.register(RECIPE);

    db = new Database(':memory:');
    paired = createPairedInstancesStore(db);
    const clientTokens = createClientTokenStore(db, { argon2_params: FAST_ARGON2 });
    const issued = await clientTokens.issue({
      client_kind: 'bridge',
      client_label: 'Test bridge',
      metadata: { instance_id: 'br-live' },
    });
    bridgeTokenId = issued.token_id;
    bridgeBearer = issued.bearer;

    server = await startServer(0, {
      executeDeps: { recipeStore, executorConfig: { manifests }, baseVault: {} },
      clientTokens,
      pairedInstances: paired,
    });
  });

  afterAll(async () => {
    await server?.close();
    db.close();
  });

  it('register from a bridge token seeds the durable row with kind="bridge"', async () => {
    const { ws, opened } = await connect(server!.port, `${bridgeTokenId}.${bridgeBearer}`);
    expect(opened).toBe(true);
    ws.send(JSON.stringify({ type: 'register', instance_id: 'br-live', user_id: 'u1' }));
    await wait(40);
    expect(paired.get('br-live')?.kind).toBe('bridge');
    ws.close();
    await wait(20);
  });

  it('replace from a bridge token carries kind="bridge" onto the new row', async () => {
    // Seed an old row to be replaced (kind irrelevant — the replace upserts new).
    paired.addOrRefresh({ instance_id: 'old-dev', user_id: 'u1', display_name: 'Old', kind: 'webclient' });
    const { ws, opened } = await connect(server!.port, `${bridgeTokenId}.${bridgeBearer}`);
    expect(opened).toBe(true);
    ws.send(JSON.stringify({
      type: 'register',
      intent: 'replace',
      replace_old: 'old-dev',
      instance_id: 'new-dev',
      user_id: 'u1',
    }));
    await wait(40);
    expect(paired.get('new-dev')?.kind).toBe('bridge');
    expect(paired.get('old-dev')?.revoked_at).not.toBeNull();
    ws.close();
    await wait(20);
  });
});

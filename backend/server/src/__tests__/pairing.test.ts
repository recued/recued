import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { createPairingManager } from '../pairing.js';
import { startServer, type RunningServer } from '../server.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { createClientTokenStore, type ClientTokenStore } from '../pairing/client-tokens.js';
import { createPairedInstancesStore, type PairedInstancesStore } from '../paired-instances-store.js';
import { generateEd25519Keypair } from '../keys/index.js';
import type { PassportFetchRpcDeps } from '../passport/fetch-handler.js';
import type { PassportBlockProviders } from '../passport/index.js';

const FAST_ARGON2 = { t: 1, m: 8, p: 1 };

const buildPassportDeps = (): PassportFetchRpcDeps => {
  const serverIdentity = generateEd25519Keypair('server_identity_key');
  const providers: PassportBlockProviders = {
    loadIdentity: () => ({
      server_public_key: serverIdentity.public_key_b64,
      server_identity_fingerprint: 'sha256:identity',
      publisher_id: 'pub-1',
      current_handle: 'alice',
      handle_history: [],
      publisher_identity_fingerprint: 'sha256:publisher',
    }),
    loadNetwork: () => ({
      lan_urls: ['http://localhost:3001'],
      cert_fingerprint: 'sha256:cert',
      cert_expires_at: 1_710_000_000_000,
      derived_preset_label: 'lan_only',
      public_mcp_acknowledgement: { acknowledged: false },
      per_path: {
        health: { resolution: { lan: true, public: false } },
        ws: { resolution: { lan: true, public: false } },
        mcp: { resolution: { lan: true, public: false } },
        llm_gateway: { resolution: { lan: true, public: false } },
        webhooks: { resolution: { lan: false, public: false } },
        reception: { resolution: { lan: false, public: false } },
        oauth: { resolution: { lan: false, public: false } },
        ask: { resolution: { lan: false, public: false } },
        webclient: { resolution: { lan: true, public: false } },
      },
    }),
    loadClients: () => [],
    loadCapabilities: () => ({
      software_version: '0.2.0',
      os: 'linux',
      arch: 'x64',
      storage_size_bytes: 1024,
      ai_pool_configured: false,
      byok_slots_configured: 0,
      scheduled_recipes_count: 0,
      reactive_recipes_count: 0,
      installed_packs: [],
      connections: [],
    }),
    loadRecovery: () => ({
      backup_status: 'configured',
      filevault_recovery_key_status: 'present',
    }),
    loadKeyHealth: () => ({
      master_dek: { status: 'healthy' },
      sub_dek: { status: 'healthy' },
      server_identity_key: { status: 'healthy' },
      publisher_identity_key: { status: 'healthy' },
      tls_private_key: { status: 'healthy' },
      webclient_token: { status: 'healthy' },
      webhook_secret: { status: 'healthy' },
    }),
  };
  return {
    providers,
    serverIdentity: () => serverIdentity,
    now: () => 1_700_000_000_000,
    mintId: () => 'passport-auth-pair-test',
  };
};

// ────────────────────────────────────────────────────────────────
// Unit tests (PairingManager)
// ────────────────────────────────────────────────────────────────

describe('PairingManager', () => {
  it('generates a code on creation', () => {
    const pm = createPairingManager();
    const code = pm.getCode();
    expect(code).not.toBeNull();
    expect(code!.length).toBe(8);
    expect(/^[A-Z0-9]+$/.test(code!)).toBe(true);
  });

  it('pair succeeds with correct code', () => {
    const pm = createPairingManager();
    const code = pm.getCode()!;
    const token = pm.pair(code);
    expect(token).not.toBeNull();
    expect(token!.startsWith('realm-')).toBe(true);
  });

  it('pair is case-insensitive', () => {
    const pm = createPairingManager();
    const code = pm.getCode()!;
    const token = pm.pair(code.toLowerCase());
    expect(token).not.toBeNull();
  });

  it('pair fails with wrong code', () => {
    const pm = createPairingManager();
    expect(pm.pair('WRONGCODE')).toBeNull();
  });

  it('pair fails with a wrong SAME-LENGTH code (constant-time compare path)', () => {
    const pm = createPairingManager();
    const code = pm.getCode()!;
    // '0' is excluded from the code alphabet (no 0/O/I/1), so an all-zeros
    // string can NEVER equal a real code — guaranteed mismatch — while
    // matching its length so the compare runs through timingSafeEqual
    // rather than the length-mismatch early-out.
    const wrong = '0'.repeat(code.length);
    expect(pm.pair(wrong)).toBeNull();
    // A failed attempt does NOT consume the code — the real one still works.
    expect(pm.pair(code)).toBe(pm.getRealmToken());
  });

  it('code is consumed after successful pair', () => {
    const pm = createPairingManager();
    const code = pm.getCode()!;
    pm.pair(code);
    expect(pm.pair(code)).toBeNull();
    expect(pm.getCode()).toBeNull();
  });

  it('code expires after TTL', () => {
    let now = 1000;
    const pm = createPairingManager({ codeTtlMs: 100, now: () => now });
    const code = pm.getCode()!;
    now = 1200; // 200ms later, past the 100ms TTL
    expect(pm.getCode()).toBeNull();
    expect(pm.pair(code)).toBeNull();
  });

  it('refreshCode generates a new code', () => {
    const pm = createPairingManager();
    const code1 = pm.getCode()!;
    pm.pair(code1); // consume
    const code2 = pm.refreshCode();
    expect(code2).not.toBe(code1);
    expect(pm.getCode()).toBe(code2);
  });

  it('uses provided realmToken', () => {
    const pm = createPairingManager({ realmToken: 'my-token' });
    expect(pm.getRealmToken()).toBe('my-token');
    const token = pm.pair(pm.getCode()!);
    expect(token).toBe('my-token');
  });

  it('timeRemaining returns correct value', () => {
    let now = 0;
    const pm = createPairingManager({ codeTtlMs: 10_000, now: () => now });
    expect(pm.timeRemaining()).toBe(10_000);
    now = 5_000;
    expect(pm.timeRemaining()).toBe(5_000);
    now = 15_000;
    expect(pm.timeRemaining()).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Integration test (HTTP /auth/pair endpoint)
// ────────────────────────────────────────────────────────────────

describe('POST /auth/pair', () => {
  let server: RunningServer | undefined;
  let pairing: ReturnType<typeof createPairingManager>;

  beforeAll(async () => {
    pairing = createPairingManager({ realmToken: 'test-realm-token' });
    const manifests = createManifestRegistry('/nonexistent');
    const recipeStore = createRecipeStore('/nonexistent');

    server = await startServer(0, {
      executeDeps: { recipeStore, executorConfig: { manifests }, baseVault: {} },
      pairing,
    });
  });

  afterAll(async () => {
    await server?.close();
  });

  it('returns token with correct code', async () => {
    const code = pairing.getCode()!;
    const res = await fetch(`http://127.0.0.1:${server!.port}/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { token: string };
    expect(body.token).toBe('test-realm-token');
  });

  it('rejects after code is consumed', async () => {
    const res = await fetch(`http://127.0.0.1:${server!.port}/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'ANYCODE' }),
    });
    expect(res.status).toBe(401);
  });

  it('paired token works for authenticated requests', async () => {
    const res = await fetch(`http://127.0.0.1:${server!.port}/health`, {
      headers: { 'Authorization': 'Bearer test-realm-token' },
    });
    expect(res.status).toBe(200);
  });

  it('rejects requests without code', async () => {
    pairing.refreshCode();
    const res = await fetch(`http://127.0.0.1:${server!.port}/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /auth/pair client_tokens issuance', () => {
  let server: RunningServer | undefined;
  let pairing: ReturnType<typeof createPairingManager>;
  let db: Database.Database;
  let clientTokens: ClientTokenStore;
  let pairedInstances: PairedInstancesStore;

  beforeAll(async () => {
    pairing = createPairingManager({ realmToken: 'legacy-realm-token' });
    db = new Database(':memory:');
    clientTokens = createClientTokenStore(db, { argon2_params: FAST_ARGON2 });
    pairedInstances = createPairedInstancesStore(db);
    const manifests = createManifestRegistry('/nonexistent');
    const recipeStore = createRecipeStore('/nonexistent');

    server = await startServer(0, {
      executeDeps: { recipeStore, executorConfig: { manifests }, baseVault: {} },
      pairing,
      clientTokens,
      pairedInstances,
      passportFetchDeps: buildPassportDeps(),
    });
  });

  afterAll(async () => {
    await server?.close();
    db.close();
  });

  it('issues and persists a durable client_tokens row and returns token_id, bearer, passport', async () => {
    const code = pairing.getCode()!;
    const res = await fetch(`http://127.0.0.1:${server!.port}/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        clientKind: 'webclient',
        displayName: 'MacBook',
        instanceId: 'webclient-iid',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      token: string;
      token_id: string;
      bearer: string;
      passport: { identity?: { server_public_key?: string } };
    };
    expect(body.token_id).toHaveLength(16);
    expect(body.bearer).toHaveLength(44);
    expect(body.token).toBe(body.bearer);
    expect(body.passport.identity?.server_public_key).toEqual(expect.any(String));

    const record = clientTokens.get(body.token_id);
    expect(record).toMatchObject({
      token_id: body.token_id,
      client_kind: 'webclient',
      client_label: 'MacBook',
      revoked_at: null,
    });
    await expect(clientTokens.verify(body.token_id, body.bearer)).resolves.toMatchObject({
      ok: true,
      record: expect.objectContaining({ token_id: body.token_id }),
    });
    // D-156 P10 — the seeded paired_instances row records the client kind.
    expect(pairedInstances.get('webclient-iid')?.kind).toBe('webclient');
  });

  it('D-156 P10 — seeds the paired_instances row with the posted clientKind (bridge)', async () => {
    // The prior test consumed the one-shot code; mint a fresh one.
    const code = pairing.refreshCode();
    const res = await fetch(`http://127.0.0.1:${server!.port}/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        clientKind: 'bridge',
        displayName: 'Laptop bridge',
        instanceId: 'bridge-iid',
      }),
    });
    expect(res.status).toBe(200);
    expect(pairedInstances.get('bridge-iid')?.kind).toBe('bridge');
  });

  it('a rejected clientKind does NOT burn the pairing code — the retry still works', async () => {
    // ⛔ `clientKind` used to be validated AFTER `pairing.pair(code)`, which
    // CONSUMES the code. So a client that sent a typo'd kind paid for its 400
    // with the user's one-shot code: the corrected retry then came back 401
    // `invalid_code` for a code the user had just been shown, and the only way
    // forward was a fresh code from the terminal. Validation now happens ahead
    // of the consume.
    //
    // The retry is the assertion. A 400 on the first request proves nothing on
    // its own — it was always 400; what changed is what the code is worth
    // afterwards.
    const code = pairing.refreshCode();
    const bad = await fetch(`http://127.0.0.1:${server!.port}/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, clientKind: 'webclientt', instanceId: 'typo-iid' }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json() as { error: { code: string } }).error.code).toBe('bad_request');
    // Nothing was seeded on the way to the refusal (the fake returns null for
    // an absent row).
    expect(pairedInstances.get('typo-iid') ?? null).toBeNull();

    const retry = await fetch(`http://127.0.0.1:${server!.port}/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, clientKind: 'webclient', instanceId: 'typo-iid' }),
    });
    expect(retry.status).toBe(200);
    expect(pairedInstances.get('typo-iid')?.kind).toBe('webclient');
  });

  it('a malformed JSON body is a 400, not a 500', async () => {
    // `readJsonBody` throws on a syntax error and the outer handler had no arm
    // for it, so the failure fell to the catch-all: a 500 whose message was the
    // raw parser text. A server-fault status for a caller-fault input, on a
    // PRE-AUTH surface.
    const res = await fetch(`http://127.0.0.1:${server!.port}/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not json',
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('bad_request');
  });

  it('rejects a re-pair that reuses a REVOKED instance_id (403, no resurrection)', async () => {
    const iid = 'revoked-resurrect-iid';
    // First pair seeds the durable row.
    const code1 = pairing.refreshCode();
    const seed = await fetch(`http://127.0.0.1:${server!.port}/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code1, clientKind: 'webclient', instanceId: iid }),
    });
    expect(seed.status).toBe(200);

    // Owner revokes the device.
    pairedInstances.revoke(iid);
    expect(pairedInstances.isRevoked(iid)).toBe(true);

    // A re-pair reusing the SAME (revoked) instance_id is rejected — the
    // upsert must not clear revoked_at (which would resurrect the device
    // and let a later re-revoke clobber the original signed audit row).
    const code2 = pairing.refreshCode();
    const replay = await fetch(`http://127.0.0.1:${server!.port}/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code2, clientKind: 'webclient', instanceId: iid }),
    });
    expect(replay.status).toBe(403);
    const err = await replay.json() as { error?: { code?: string } };
    expect(err.error?.code).toBe('instance_revoked');
    // Still revoked — never resurrected.
    expect(pairedInstances.isRevoked(iid)).toBe(true);
  });

  it('rejects an oversized /auth/pair body with 413 before validation', async () => {
    const code = pairing.refreshCode();
    // > 16 KiB body — bounded before any code validation runs.
    const huge = 'x'.repeat(32 * 1024);
    const res = await fetch(`http://127.0.0.1:${server!.port}/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, displayName: huge }),
    });
    expect(res.status).toBe(413);
    const err = await res.json() as { error?: { code?: string } };
    expect(err.error?.code).toBe('payload_too_large');
    // The code was NOT consumed (rejected before pair()) — it still works.
    const ok = await fetch(`http://127.0.0.1:${server!.port}/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, clientKind: 'webclient', instanceId: 'post-413-iid' }),
    });
    expect(ok.status).toBe(200);
  });
});

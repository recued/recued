/** D-121 Phase 5 — `/auth/pair` extended with optional recoveryKey
 *  + CORS preflight + cross-origin headers. Integration test against
 *  the real Node http server. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { startServer, type RunningServer } from '../server.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { createPairingManager, type PairingManager } from '../pairing.js';
import { createRecoveryKeyCheckStore } from '../recovery-key-store.js';
import { generateRecoveryKey } from '@recued/crypto';

describe('POST /auth/pair (D-121 Phase 5 — webapp path-1 entry)', () => {
  let server: RunningServer;
  let pairing: PairingManager;
  let recoveryKeyCheck: ReturnType<typeof createRecoveryKeyCheckStore>;
  let db: Database.Database;
  const realmRecoveryKey = generateRecoveryKey().mnemonic;

  beforeAll(async () => {
    pairing = createPairingManager({ realmToken: 'test-realm-token' });
    db = new Database(':memory:');
    recoveryKeyCheck = createRecoveryKeyCheckStore(db);
    // Pre-enroll the realm so subsequent recovery_key checks verify
    // against this key.
    const { processRecoveryKey } = await import('../recovery-key-processor.js');
    await processRecoveryKey(recoveryKeyCheck, realmRecoveryKey);

    const manifests = createManifestRegistry('/nonexistent');
    const recipeStore = createRecipeStore('/nonexistent');
    server = await startServer(0, {
      executeDeps: { recipeStore, executorConfig: { manifests }, baseVault: {} },
      pairing,
      recoveryKeyCheck,
    });
  });

  afterAll(async () => {
    await server.close();
    db.close();
  });

  // ────────────────────────────────────────────────────────────────
  // Existing extension flow — code only
  // ────────────────────────────────────────────────────────────────

  it('accepts code-only POST (existing extension behaviour unchanged)', async () => {
    const code = pairing.refreshCode();
    const res = await fetch(`http://127.0.0.1:${server.port}/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { token: string };
    expect(body.token).toBe('test-realm-token');
  });

  // ────────────────────────────────────────────────────────────────
  // Webapp path-1: code + recoveryKey
  // ────────────────────────────────────────────────────────────────

  it('accepts code + matching recoveryKey + instanceId/displayName (webapp path 1)', async () => {
    const code = pairing.refreshCode();
    const res = await fetch(`http://127.0.0.1:${server.port}/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        recoveryKey: realmRecoveryKey,
        instanceId: 'webapp-iid-1',
        displayName: 'MacBook App',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { token: string; message: string };
    expect(body.token).toBe('test-realm-token');
  });

  it('rejects with 401 + recovery_key_invalid when recoveryKey mismatches realm', async () => {
    const code = pairing.refreshCode();
    const wrongKey = generateRecoveryKey().mnemonic;
    const res = await fetch(`http://127.0.0.1:${server.port}/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        recoveryKey: wrongKey,
        instanceId: 'webapp-iid-2',
      }),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('recovery_key_invalid');
  });

  it('does NOT consume the code when recoveryKey is wrong', async () => {
    const code = pairing.refreshCode();
    // First attempt: wrong recovery key
    const wrong = await fetch(`http://127.0.0.1:${server.port}/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        recoveryKey: generateRecoveryKey().mnemonic,
      }),
    });
    expect(wrong.status).toBe(401);

    // Second attempt with correct recovery key — code should still be valid
    const right = await fetch(`http://127.0.0.1:${server.port}/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        recoveryKey: realmRecoveryKey,
      }),
    });
    expect(right.status).toBe(200);
  });

  it('rejects with 401 + invalid_code when code is wrong (recoveryKey ok)', async () => {
    pairing.refreshCode(); // there's a current code; pass a wrong one
    const res = await fetch(`http://127.0.0.1:${server.port}/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: 'WRONG999',
        recoveryKey: realmRecoveryKey,
      }),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('invalid_code');
  });

  // ────────────────────────────────────────────────────────────────
  // CORS
  // ────────────────────────────────────────────────────────────────

  it('responds to OPTIONS preflight with permissive CORS headers', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/auth/pair`, {
      method: 'OPTIONS',
      headers: {
        'Origin': 'https://app.recued.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect((res.headers.get('access-control-allow-methods') ?? '').toUpperCase()).toContain('POST');
    expect((res.headers.get('access-control-allow-headers') ?? '').toLowerCase()).toContain('content-type');
  });

  it('includes Access-Control-Allow-Origin on the POST response', async () => {
    const code = pairing.refreshCode();
    const res = await fetch(`http://127.0.0.1:${server.port}/auth/pair`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Origin': 'https://app.recued.com',
      },
      body: JSON.stringify({ code }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('does NOT add CORS headers to non-pair paths', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  // ────────────────────────────────────────────────────────────────
  // Code optional once realm is enrolled
  // ────────────────────────────────────────────────────────────────

  it('accepts recoveryKey-only on enrolled server (code optional)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        recoveryKey: realmRecoveryKey,
        instanceId: 'webapp-recovery-only',
        displayName: 'Re-pair from bundle',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { token: string };
    expect(body.token).toBe('test-realm-token');
  });

  it('rejects with 401 + recovery_key_invalid on recoveryKey-only with wrong key', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        recoveryKey: generateRecoveryKey().mnemonic,
        instanceId: 'attacker',
      }),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('recovery_key_invalid');
  });

  it('rejects with 400 when neither code nor recoveryKey is supplied', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('bad_request');
  });

  // ────────────────────────────────────────────────────────────────
  // /auth/recover-pair removed
  // ────────────────────────────────────────────────────────────────

  it('returns 404 for the removed /auth/recover-pair endpoint', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/auth/recover-pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recoveryKey: realmRecoveryKey, instanceId: 'x', mode: 'replace' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /auth/pair on a fresh (un-enrolled) server', () => {
  let server: RunningServer;
  let pairing: PairingManager;
  let db: Database.Database;

  beforeAll(async () => {
    pairing = createPairingManager({ realmToken: 'fresh-realm' });
    db = new Database(':memory:');
    const recoveryKeyCheck = createRecoveryKeyCheckStore(db);
    // Wired but never enrolled.
    void recoveryKeyCheck;

    const manifests = createManifestRegistry('/nonexistent');
    const recipeStore = createRecipeStore('/nonexistent');
    server = await startServer(0, {
      executeDeps: { recipeStore, executorConfig: { manifests }, baseVault: {} },
      pairing,
      recoveryKeyCheck,
    });
  });

  afterAll(async () => {
    await server.close();
    db.close();
  });

  it('rejects recoveryKey-only with 400 (fresh server requires CLI code)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        recoveryKey: generateRecoveryKey().mnemonic,
        instanceId: 'first',
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toMatch(/code is required/i);
  });

  it('accepts code + recoveryKey on first pair (enrolls the realm)', async () => {
    const code = pairing.refreshCode();
    const fresh = generateRecoveryKey().mnemonic;
    const res = await fetch(`http://127.0.0.1:${server.port}/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        recoveryKey: fresh,
        instanceId: 'first-paired',
      }),
    });
    expect(res.status).toBe(200);

    // Subsequent recoveryKey-only call with the same key now succeeds
    // (realm is enrolled).
    const code2 = pairing.refreshCode();
    void code2;
    const res2 = await fetch(`http://127.0.0.1:${server.port}/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recoveryKey: fresh, instanceId: 'second-paired' }),
    });
    expect(res2.status).toBe(200);
  });
});

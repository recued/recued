/** Auth rpc handler tests — request-response + integration with KeyManager + storage. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { RpcError } from '@recued/contracts';
import {
  handleAuthState, handleAuthInit, handleAuthUnlock, handleAuthLock,
  type AuthDeps,
} from '../auth-handler.js';
import { createKeyManager } from '../key-manager.js';
import { createBundleStore } from '../bundle-store.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createSQLiteCacheStore } from '../storage/index.js';
import type { CacheEntry } from '@recued/cache';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'recued-auth-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const mkDeps = (): { deps: AuthDeps; db: Database.Database } => {
  const db = new Database(join(workDir, 'test.db'));
  const bundleStore = createBundleStore(db);
  const keys = createKeyManager({
    loadBundle: () => bundleStore.load(),
    saveBundle: (b) => bundleStore.save(b),
    argon2Params: { t: 1, m: 1024, p: 1 },
  });
  return { deps: { keys }, db };
};

// ────────────────────────────────────────────────────────────────
// auth.state
// ────────────────────────────────────────────────────────────────

describe('auth.state', () => {
  it('reports uninitialized on fresh server', async () => {
    const { deps, db } = mkDeps();
    const res = await handleAuthState(deps);
    expect(res.state).toBe('uninitialized');
    db.close();
  });

  it('reports locked after init + lock + fresh KM', async () => {
    const { deps, db } = mkDeps();
    await handleAuthInit(deps, { password: 'pw' });
    await handleAuthLock(deps);
    const res = await handleAuthState(deps);
    expect(res.state).toBe('locked');
    db.close();
  });

  it('reports unlocked after init', async () => {
    const { deps, db } = mkDeps();
    await handleAuthInit(deps, { password: 'pw' });
    const res = await handleAuthState(deps);
    expect(res.state).toBe('unlocked');
    db.close();
  });
});

// ────────────────────────────────────────────────────────────────
// auth.init
// ────────────────────────────────────────────────────────────────

describe('auth.init', () => {
  it('returns recovery key on first init', async () => {
    const { deps, db } = mkDeps();
    const res = await handleAuthInit(deps, { password: 'pw' });
    expect(res.state).toBe('unlocked');
    expect(res.recoveryKey.split(/\s+/).length).toBe(24);
    db.close();
  });

  it('rejects missing password', async () => {
    const { deps, db } = mkDeps();
    await expect(handleAuthInit(deps, {})).rejects.toMatchObject({
      code: 'bad_request',
      status: 400,
    });
    db.close();
  });

  it('returns 409 when bundle already exists (prevents orphan warning)', async () => {
    const { deps, db } = mkDeps();
    await handleAuthInit(deps, { password: 'pw' });
    await handleAuthLock(deps);
    try {
      await handleAuthInit(deps, { password: 'different' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).toBe('already_initialized');
      expect((err as RpcError).status).toBe(409);
      // Message explains the "would orphan data" concern
      expect((err as RpcError).message).toMatch(/orphan|rotate|wipe/i);
    }
    db.close();
  });
});

// ────────────────────────────────────────────────────────────────
// auth.unlock
// ────────────────────────────────────────────────────────────────

describe('auth.unlock', () => {
  it('password unlock succeeds', async () => {
    const { deps, db } = mkDeps();
    await handleAuthInit(deps, { password: 'the-pw' });
    await handleAuthLock(deps);
    const res = await handleAuthUnlock(deps, { password: 'the-pw' });
    expect(res.state).toBe('unlocked');
    db.close();
  });

  it('recovery-key unlock succeeds', async () => {
    const { deps, db } = mkDeps();
    const init = await handleAuthInit(deps, { password: 'pw' });
    const recoveryKey = init.recoveryKey;
    await handleAuthLock(deps);
    const res = await handleAuthUnlock(deps, { recoveryKey });
    expect(res.state).toBe('unlocked');
    db.close();
  });

  it('wrong password → 401 (uniform, does not reveal bundle state)', async () => {
    const { deps, db } = mkDeps();
    await handleAuthInit(deps, { password: 'correct' });
    await handleAuthLock(deps);
    await expect(handleAuthUnlock(deps, { password: 'wrong' })).rejects.toMatchObject({
      code: 'unauthorized',
      status: 401,
      message: 'invalid credentials',
    });
    db.close();
  });

  it('wrong recovery key → 401', async () => {
    const { deps, db } = mkDeps();
    await handleAuthInit(deps, { password: 'pw' });
    await handleAuthLock(deps);
    const garbage = Array(24).fill('abandon').join(' ');
    await expect(handleAuthUnlock(deps, { recoveryKey: garbage })).rejects.toMatchObject({
      status: 401,
    });
    db.close();
  });

  it('unlock without bundle → 409 not_initialized', async () => {
    const { deps, db } = mkDeps();
    await expect(handleAuthUnlock(deps, { password: 'pw' })).rejects.toMatchObject({
      code: 'not_initialized',
      status: 409,
    });
    db.close();
  });

  it('rejects missing credentials', async () => {
    const { deps, db } = mkDeps();
    await expect(handleAuthUnlock(deps, {})).rejects.toMatchObject({
      code: 'bad_request',
      status: 400,
    });
    db.close();
  });
});

// ────────────────────────────────────────────────────────────────
// Integration with storage
// ────────────────────────────────────────────────────────────────

describe('auth integration — storage respects lock/unlock', () => {
  const mkEntry = (overrides: Partial<CacheEntry> = {}): CacheEntry => ({
    key: 'v1:pair:x@1:abc',
    value: { data: 'secret' },
    expires_at: Date.now() + 60_000,
    recipe_id: 'r',
    ingredient_slug: 'x',
    size_bytes: 20,
    created_at: Date.now(),
    last_accessed_at: Date.now(),
    category: 'data',
    risk_tier: 'read',
    ...overrides,
  });

  it('storage configured with keyProvider works when unlocked, fails when locked', async () => {
    const { deps, db } = mkDeps();
    await handleAuthInit(deps, { password: 'pw' });

    const blobs = createBlobStore(join(workDir, 'blobs'), {
      getEncryptionKey: deps.keys.keyProvider('blob-store'),
    });
    const store = createSQLiteCacheStore(db, blobs, {
      getEncryptionKey: deps.keys.keyProvider('server-data'),
    });

    // Write while unlocked
    await store.set(mkEntry());
    const got = await store.get('v1:pair:x@1:abc');
    expect(got?.value).toEqual({ data: 'secret' });

    // Lock → new ops should throw
    await handleAuthLock(deps);
    await expect(store.set(mkEntry({ key: 'later' }))).rejects.toThrow('locked');
    await expect(store.get('v1:pair:x@1:abc')).rejects.toThrow('locked');

    // Unlock → access restored
    await handleAuthUnlock(deps, { password: 'pw' });
    const reGot = await store.get('v1:pair:x@1:abc');
    expect(reGot?.value).toEqual({ data: 'secret' });

    db.close();
  });

  it('bundle persists across a fresh KeyManager (simulating server restart)', async () => {
    const { deps, db } = mkDeps();
    await handleAuthInit(deps, { password: 'pw' });

    const blobs = createBlobStore(join(workDir, 'blobs'), {
      getEncryptionKey: deps.keys.keyProvider('blob-store'),
    });
    const store = createSQLiteCacheStore(db, blobs, {
      getEncryptionKey: deps.keys.keyProvider('server-data'),
    });
    await store.set(mkEntry({ value: 'across-restart' }));

    // Simulate server restart: fresh KeyManager reading the same db
    const bundleStore2 = createBundleStore(db);
    const keys2 = createKeyManager({
      loadBundle: () => bundleStore2.load(),
      saveBundle: (b) => bundleStore2.save(b),
      argon2Params: { t: 1, m: 1024, p: 1 },
    });
    expect(keys2.state()).toBe('locked'); // bundle found → locked

    // Build a fresh store with the new KM
    const blobs2 = createBlobStore(join(workDir, 'blobs'), {
      getEncryptionKey: keys2.keyProvider('blob-store'),
    });
    const store2 = createSQLiteCacheStore(db, blobs2, {
      getEncryptionKey: keys2.keyProvider('server-data'),
    });

    // Can't read while locked
    await expect(store2.get('v1:pair:x@1:abc')).rejects.toThrow('locked');

    // Unlock and read → recovers the pre-restart data
    await keys2.unlock({ password: 'pw' });
    const got = await store2.get('v1:pair:x@1:abc');
    expect(got?.value).toBe('across-restart');

    db.close();
  });
});

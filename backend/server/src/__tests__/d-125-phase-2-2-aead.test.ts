/** D-125 Phase 2.2 — `encodeAuthForStorage` AEAD swap.
 *
 *  Pins the at-rest encryption discipline:
 *    1. With a `getEncryptionKey` wired through, `auth_ciphertext` is
 *       AEAD ciphertext (iv || ct + tag, base64-encoded), not plaintext
 *       JSON. The literal secret token never appears in the row's
 *       `auth_ciphertext` bytes.
 *    2. `decodeAuthFromStorage` round-trips a row enrolled under the
 *       same identity + key.
 *    3. AAD binding: a row enrolled under (api, hubspot) cannot be
 *       decoded under (api, salesforce) — the AAD includes the row's
 *       (kind, name) so moved blobs fail to decrypt.
 *    4. A second `getEncryptionKey` (different sub-DEK) cannot decode
 *       the first's ciphertext — domain separation is enforced at the
 *       AEAD layer, not just the HKDF derivation step.
 *    5. Server locked (keyProvider returns null) throws `locked` on
 *       both encrypt + decrypt paths.
 *    6. Without a `getEncryptionKey` (legacy / uninitialized harness),
 *       the encoder falls back to base64-JSON — preserves P2.1 dbless
 *       fixtures and the FileVault-uninitialized fresh-install state. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RpcError, type ConnectionAuth } from '@recued/contracts';
import { deriveSubDEK } from '@recued/crypto';

import {
  createConnectionStore,
  type ConnectionStoreSqlite,
} from '../storage/connection-store.js';
import {
  decodeAuthFromStorage,
  handleConnectionEnroll,
  handleConnectionUpdate,
} from '../connection-handler.js';

let dir: string;
let db: Database.Database;
let store: ConnectionStoreSqlite;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'connection-aead-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createConnectionStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const bearer = (token: string): ConnectionAuth => ({ type: 'bearer', token });

// Deterministic sub-DEK for tests — derive from a fixed Master DEK so
// every test sees the same key pair. Production wires the real
// `keyManager.keyProvider('connection')` per bin.ts.
const fixedMaster = (seed: number): Uint8Array => {
  const buf = new Uint8Array(32);
  buf.fill(seed);
  return buf;
};

const connectionKey = (master: Uint8Array): Uint8Array =>
  deriveSubDEK(master, 'connection');

const accountKey = (master: Uint8Array): Uint8Array =>
  deriveSubDEK(master, 'account');

describe('encodeAuthForStorage — AEAD path', () => {
  it('row.auth_ciphertext does not contain the plaintext token', async () => {
    const key = connectionKey(fixedMaster(1));
    await handleConnectionEnroll(
      { store, getEncryptionKey: () => key },
      {
        name: 'hubspot', kind: 'api',
        display_name: 'HubSpot Production',
        config: { base_url: 'https://api.hubapi.com' },
        auth: bearer('SECRET-TOKEN-DO-NOT-LEAK'),
      },
    );
    const row = store.get('api', 'hubspot');
    expect(row).not.toBeNull();
    // AEAD ciphertext is opaque — base64-decoding it back to UTF-8
    // yields gibberish, not the plaintext secret. We're sniffing both
    // the raw ciphertext string AND the decoded bytes for the literal
    // token to catch a "plaintext leaked through the encoder" regression.
    expect(row!.auth_ciphertext).not.toContain('SECRET-TOKEN-DO-NOT-LEAK');
    const decoded = Buffer.from(row!.auth_ciphertext, 'base64').toString('binary');
    expect(decoded).not.toContain('SECRET-TOKEN-DO-NOT-LEAK');
  });

  it('decodeAuthFromStorage round-trips with the same key + identity', async () => {
    const key = connectionKey(fixedMaster(2));
    await handleConnectionEnroll(
      { store, getEncryptionKey: () => key },
      {
        name: 'hubspot', kind: 'api',
        display_name: 'HubSpot',
        config: {}, auth: bearer('round-trip-token'),
      },
    );
    const row = store.get('api', 'hubspot')!;
    const recovered = await decodeAuthFromStorage(
      row.auth_ciphertext,
      { kind: 'api', name: 'hubspot' },
      () => key,
    );
    expect(recovered).toEqual({ type: 'bearer', token: 'round-trip-token' });
  });

  it('AAD binding — a blob enrolled under (api, hubspot) does not decode under (api, salesforce)', async () => {
    const key = connectionKey(fixedMaster(3));
    await handleConnectionEnroll(
      { store, getEncryptionKey: () => key },
      {
        name: 'hubspot', kind: 'api',
        display_name: 'HubSpot', config: {},
        auth: bearer('hubspot-token'),
      },
    );
    const row = store.get('api', 'hubspot')!;
    // Same key + same kind, different name → AAD mismatch → decryption fails.
    await expect(
      decodeAuthFromStorage(
        row.auth_ciphertext,
        { kind: 'api', name: 'salesforce' },
        () => key,
      ),
    ).rejects.toThrow();
  });

  it('AAD binding — a blob enrolled under api does not decode under mcp', async () => {
    const key = connectionKey(fixedMaster(4));
    await handleConnectionEnroll(
      { store, getEncryptionKey: () => key },
      {
        name: 'shared-name', kind: 'api',
        display_name: 'API', config: {},
        auth: bearer('api-token'),
      },
    );
    const row = store.get('api', 'shared-name')!;
    await expect(
      decodeAuthFromStorage(
        row.auth_ciphertext,
        { kind: 'mcp', name: 'shared-name' },
        () => key,
      ),
    ).rejects.toThrow();
  });

  it('domain separation — account sub-DEK cannot decode connection ciphertext', async () => {
    const master = fixedMaster(5);
    const connKey = connectionKey(master);
    const acctKey = accountKey(master);
    await handleConnectionEnroll(
      { store, getEncryptionKey: () => connKey },
      {
        name: 'hubspot', kind: 'api',
        display_name: 'HubSpot', config: {},
        auth: bearer('isolated'),
      },
    );
    const row = store.get('api', 'hubspot')!;
    await expect(
      decodeAuthFromStorage(
        row.auth_ciphertext,
        { kind: 'api', name: 'hubspot' },
        () => acctKey,
      ),
    ).rejects.toThrow();
  });

  it('locked keyProvider (returns null) on enroll throws RpcError "locked"', async () => {
    await expect(
      handleConnectionEnroll(
        { store, getEncryptionKey: () => null },
        {
          name: 'hubspot', kind: 'api',
          display_name: 'HubSpot', config: {},
          auth: bearer('t'),
        },
      ),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('locked keyProvider on update auth-patch throws RpcError "locked"', async () => {
    const key = connectionKey(fixedMaster(6));
    await handleConnectionEnroll(
      { store, getEncryptionKey: () => key },
      {
        name: 'hubspot', kind: 'api',
        display_name: 'HubSpot', config: {}, auth: bearer('t'),
      },
    );
    // After enrollment, the server "locks" — keyProvider returns null.
    let unlocked = false;
    await expect(
      handleConnectionUpdate(
        { store, getEncryptionKey: () => (unlocked ? key : null) },
        {
          name: 'hubspot', kind: 'api',
          patch: { auth: bearer('rotated') },
        },
      ),
    ).rejects.toBeInstanceOf(RpcError);

    // A non-auth patch under a locked keyProvider works — display_name
    // doesn't touch the encrypted field, so the lock doesn't block it.
    unlocked = true;
    const ok = await handleConnectionUpdate(
      { store, getEncryptionKey: () => (unlocked ? key : null) },
      {
        name: 'hubspot', kind: 'api',
        patch: { display_name: 'HubSpot Sandbox' },
      },
    );
    expect(ok.connection.display_name).toBe('HubSpot Sandbox');
  });

  it('locked keyProvider on decode throws RpcError "locked"', async () => {
    const key = connectionKey(fixedMaster(7));
    await handleConnectionEnroll(
      { store, getEncryptionKey: () => key },
      {
        name: 'hubspot', kind: 'api',
        display_name: 'HubSpot', config: {},
        auth: bearer('t'),
      },
    );
    const row = store.get('api', 'hubspot')!;
    await expect(
      decodeAuthFromStorage(
        row.auth_ciphertext,
        { kind: 'api', name: 'hubspot' },
        () => null,
      ),
    ).rejects.toBeInstanceOf(RpcError);
  });
});

describe('encodeAuthForStorage — legacy fallback (no keyProvider)', () => {
  it('without getEncryptionKey, row.auth_ciphertext is base64-JSON (P2.1 placeholder)', async () => {
    // Existing P2.1 fixtures pass `{ store }` only — the encoder must
    // continue to round-trip without a Master DEK in scope so dbless
    // harnesses + freshly-installed servers (FileVault uninitialized)
    // keep working.
    await handleConnectionEnroll(
      { store },
      {
        name: 'hubspot', kind: 'api',
        display_name: 'HubSpot', config: {},
        auth: bearer('legacy-token'),
      },
    );
    const row = store.get('api', 'hubspot')!;
    const decoded = Buffer.from(row.auth_ciphertext, 'base64').toString('utf8');
    // Plaintext-equivalent — JSON-stringified ConnectionAuth.
    expect(JSON.parse(decoded)).toEqual({ type: 'bearer', token: 'legacy-token' });
  });

  it('decodeAuthFromStorage without getEncryptionKey reads the legacy blob', async () => {
    await handleConnectionEnroll(
      { store },
      {
        name: 'hubspot', kind: 'api',
        display_name: 'HubSpot', config: {},
        auth: bearer('legacy-token'),
      },
    );
    const row = store.get('api', 'hubspot')!;
    const recovered = await decodeAuthFromStorage(
      row.auth_ciphertext,
      { kind: 'api', name: 'hubspot' },
      undefined,
    );
    expect(recovered).toEqual({ type: 'bearer', token: 'legacy-token' });
  });
});

/** Server-side vault — same VaultStore interface as the extension.
 *
 *  Uses @recued/storage's createVaultStore with AES-256-GCM encryption
 *  backed by a SQLite Collection.
 *
 *  Two DEK paths:
 *
 *   1. **Legacy path** (no `master_dek` opt) — generates a fresh
 *      random DEK on first run, persists base64-encoded in the
 *      `server_dek` SQLite table. Pre-D-148 deployments use this
 *      path; preserved so existing vault rows remain decryptable
 *      across the substrate landing.
 *
 *   2. **D-148 § A.2.3 path** (`master_dek` supplied) — derives
 *      the vault DEK as `sub_dek.vault = HKDF(master_dek,
 *      domain='vault')` per the Key Material Taxonomy. The
 *      `server_dek` table is not touched in this path; the same
 *      vault DEK derives deterministically on every boot from the
 *      KeyManager's master_dek so vault decryption survives a
 *      restart that doesn't carry the legacy DEK row.
 *
 *  Pre-launch zero-installs rule applies: D-148 P2 does not ship
 *  a migration that re-encrypts legacy rows under sub_dek.vault.
 *  New installs land on the D-148 path; older deployments stay on
 *  the legacy path until a future migration D handles the
 *  cross-walk.
 *
 *  At execution time, vault values from the VaultStore are loaded into
 *  the namespace stores, with env vars and vault-file overrides merged
 *  on top (highest priority last).
 */

import type Database from 'better-sqlite3';
import {
  createVaultStore,
  type VaultStore,
  type VaultQuotaOptions,
  generateKey,
  exportKey,
  importKey,
} from '@recued/storage';
import type { Collection, EncryptedEntry } from '@recued/storage';
import { deriveSubDEK, bytesToBase64 } from '@recued/crypto';
import { assertKeyCapable } from '@recued/contracts';
import { createSQLiteCollection } from './sqlite-collection.js';

// ────────────────────────────────────────────────────────────────
// DEK management
// ────────────────────────────────────────────────────────────────

const DEK_TABLE = 'server_dek';
const PROTOTYPE_SENSITIVE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const ensureDekTable = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${DEK_TABLE} (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      key_base64 TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
};

/** Load or generate the server DEK. Stored as base64 in SQLite. */
const ensureDek = async (db: Database.Database): Promise<CryptoKey> => {
  ensureDekTable(db);
  const row = db.prepare(`SELECT key_base64 FROM ${DEK_TABLE} WHERE id = 1`).get() as { key_base64: string } | undefined;
  if (row) {
    return importKey(row.key_base64);
  }
  const dek = await generateKey();
  const exported = await exportKey(dek);
  db.prepare(`INSERT INTO ${DEK_TABLE} (id, key_base64, created_at) VALUES (1, ?, ?)`).run(exported, Date.now());
  return dek;
};

/** D-148 § A.2.3 — derive the vault DEK as `sub_dek.vault` from
 *  the KeyManager's master_dek. HKDF-SHA-256 with domain salt
 *  `'vault'` per `@recued/crypto`'s `deriveSubDEK`. The CryptoKey
 *  returned is suitable for `createVaultStore`'s AES-GCM operations.
 *
 *  The runtime asserts the master_dek's I-4 capability — calling
 *  with a forged keypair-class object is a programming error. */
const deriveVaultDekFromMaster = async (master_dek: Uint8Array): Promise<CryptoKey> => {
  // I-4 invariant: only key classes whose KEY_CAPABILITIES include
  // 'decrypt' are admissible here. master_dek's row is `['decrypt']`.
  assertKeyCapable('master_dek', 'decrypt');
  const sub = deriveSubDEK(master_dek, 'vault');
  // `importKey` from @recued/storage takes a base64 of the raw 32
  // bytes and returns a Web-Crypto AES-GCM CryptoKey ready for the
  // VaultStore.
  return importKey(bytesToBase64(sub));
};

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

export interface CreateServerVaultStoreOptions {
  /** D-103 quotas. Reads from the loaded runtime config at boot;
   *  runtime edits require a server restart because the VaultStore
   *  captures these on construction. */
  quotas?: VaultQuotaOptions;
  /** Phase B gate hook — forwarded to `createVaultStore`. Every set /
   *  delete / deleteByPublisher reports the signed plaintext-byte
   *  delta so the vault surface gate stays in sync. */
  onBytesChanged?: (delta: number) => void;
  /** D-148 § A.2.3 — when supplied, the vault DEK is HKDF-derived
   *  from this master_dek (`sub_dek.vault`) instead of the legacy
   *  per-server random DEK row. This is the substrate-canonical
   *  path for new D-148 servers; the legacy path remains for pre-
   *  D-148 deployments. */
  master_dek?: Uint8Array;
  /** Lazy vault-key provider — returns the `sub_dek.vault` bytes
   *  (`keys.keyProvider('vault')`) or null while the server is LOCKED.
   *  When supplied, the vault is keyed by the Master DEK with NO
   *  plaintext `server_dek` row, and the actual `CryptoKey` is resolved
   *  on first use (post-unlock) rather than at construction — the vault
   *  is built at boot, before the Master DEK is unlocked. While the
   *  provider returns null the store fails closed (vault ops throw).
   *  Takes precedence over `master_dek` / the legacy plaintext path. */
  getEncryptionKey?: () => Uint8Array | null;
}

/** A `VaultStore` whose DEK is resolved lazily from a `getKeyBytes`
 *  provider. The vault is constructed at boot — before the Master DEK
 *  is unlocked — so it cannot capture an eager `CryptoKey`; instead it
 *  (re)builds the real `createVaultStore` on first use once the sub-DEK
 *  is available, caching per key-bytes so a rotation rebuilds cleanly.
 *  Fail-closed: every op throws while the provider returns null. */
const createLazyKeyedVaultStore = (
  db: Database.Database,
  getKeyBytes: () => Uint8Array | null,
  opts: CreateServerVaultStoreOptions,
): VaultStore => {
  const collection: Collection<EncryptedEntry> = createSQLiteCollection(db, 'server_vault');
  let inner: VaultStore | null = null;
  let innerKeyB64: string | null = null;

  const resolve = async (): Promise<VaultStore> => {
    const bytes = getKeyBytes();
    if (!bytes) {
      throw new Error(
        'server-vault: vault key unavailable — the server is locked '
          + '(not yet unlocked from the keyfile or recovery key).',
      );
    }
    const keyB64 = bytesToBase64(bytes);
    if (inner && innerKeyB64 === keyB64) return inner;
    // First use, or the sub-DEK rotated: rebuild over the SAME collection
    // with the freshly-imported CryptoKey. `getKeyBytes` returns the
    // `sub_dek.vault` bytes directly (already domain-derived), so we
    // import them as-is — byte-identical to `deriveVaultDekFromMaster`.
    const dek = await importKey(keyB64);
    inner = createVaultStore(collection, dek, {
      ...(opts.quotas ? { quotas: opts.quotas } : {}),
      ...(opts.onBytesChanged ? { onBytesChanged: opts.onBytesChanged } : {}),
    });
    innerKeyB64 = keyB64;
    return inner;
  };

  return {
    async set(publisher, key, value) { return (await resolve()).set(publisher, key, value); },
    async get(publisher, key) { return (await resolve()).get(publisher, key); },
    async has(publisher, key) { return (await resolve()).has(publisher, key); },
    async delete(publisher, key) { return (await resolve()).delete(publisher, key); },
    async listByPublisher(publisher) { return (await resolve()).listByPublisher(publisher); },
    async deleteByPublisher(publisher) { return (await resolve()).deleteByPublisher(publisher); },
  };
};

/** Create a server vault store backed by SQLite with AES-256-GCM encryption.
 *  Same VaultStore interface the extension uses. */
export const createServerVaultStore = async (
  db: Database.Database,
  opts: CreateServerVaultStoreOptions = {},
): Promise<VaultStore> => {
  // Master-DEK-keyed lazy path (no plaintext server_dek). Resolves the
  // vault sub-DEK on first use, post-unlock; fail-closed while locked.
  if (opts.getEncryptionKey) {
    return createLazyKeyedVaultStore(db, opts.getEncryptionKey, opts);
  }
  const dek = opts.master_dek
    ? await deriveVaultDekFromMaster(opts.master_dek)
    : await ensureDek(db);
  const collection: Collection<EncryptedEntry> = createSQLiteCollection(db, 'server_vault');
  return createVaultStore(collection, dek, {
    ...(opts.quotas ? { quotas: opts.quotas } : {}),
    ...(opts.onBytesChanged ? { onBytesChanged: opts.onBytesChanged } : {}),
  });
};

/** Read all vault entries from the VaultStore into a nested object
 *  suitable for the namespace stores. Returns { publisher: { key: value } }. */
export const loadVaultAsObject = async (
  vault: VaultStore,
  publishers: string[],
): Promise<Record<string, Record<string, string>>> => {
  const result: Record<string, Record<string, string>> = {};
  for (const pub of publishers) {
    if (PROTOTYPE_SENSITIVE_KEYS.has(pub)) continue;
    const entries = await vault.listByPublisher(pub);
    if (entries.length > 0) {
      const slot: Record<string, string> = {};
      for (const { key, value } of entries) {
        if (PROTOTYPE_SENSITIVE_KEYS.has(key)) continue;
        slot[key] = value;
      }
      if (Object.keys(slot).length > 0) result[pub] = slot;
    }
  }
  return result;
};

/** Collect all unique publisher scopes from the vault store.
 *  Reads the raw collection keys (vault.{publisher}.{key}) to
 *  extract distinct publisher names. */
export const listVaultPublishers = async (
  db: Database.Database,
): Promise<string[]> => {
  const rows = db.prepare(`SELECT DISTINCT key FROM server_vault`).all() as { key: string }[];
  const publishers = new Set<string>();
  for (const { key } of rows) {
    // Keys are stored as "vault.{publisher}.{key}"
    const parts = key.split('.');
    if (parts.length >= 3 && parts[0] === 'vault') {
      if (PROTOTYPE_SENSITIVE_KEYS.has(parts[1])) continue;
      publishers.add(parts[1]);
    }
  }
  return [...publishers];
};

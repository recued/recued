/** D-148 § A.2.1 — disk-backed `ServerKeyStore`.
 *
 *  P1 shipped the `ServerKeyStore` interface + an in-memory
 *  implementation for tests. P2 lands the production-shape disk store
 *  with two persistence modes:
 *
 *   1. **Plain JSON** (default) — `<filePath>` holds a single JSON
 *      document with `{ version: 1, server_identity?, publisher_identity? }`.
 *      File mode 0600 — owner read/write only. The plaintext bytes
 *      live on disk; physical access to the disk is the trust
 *      boundary. Suitable for self-hosted servers running on
 *      hardware the operator controls.
 *
 *   2. **Passphrase-encrypted** — when `passphrase` is supplied, the
 *      same JSON document AEAD-seals under a passphrase-derived KEK
 *      (Argon2id-based). Suitable for servers running on shared
 *      infrastructure where disk-level access is not the trust
 *      boundary.
 *
 *  The OS-keyring path the spec mentions as a third mode is left for
 *  a follow-up — the platform-keyring surface is OS-specific (macOS
 *  Keychain / Windows Credential Manager / Linux Secret Service)
 *  and pulls in a native-bindings dependency that's outside the P2
 *  substrate scope. The interface is identical, so swapping the
 *  store at boot is a one-line change.
 *
 *  The store reads + writes atomically (write-to-tmp + rename) so
 *  a crash mid-write never leaves the file half-populated.
 *
 *  Forge-rejection: `saveServerIdentityKey` and
 *  `savePublisherIdentityKey` reject mismatched key_class at the
 *  store boundary (I-7 storage discipline). The on-disk JSON also
 *  carries the `key_class` field so a tampered file that swaps
 *  classes is caught at load time.
 */

import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  bytesToBase64,
  base64ToBytes,
  encrypt as aeadEncrypt,
  decrypt as aeadDecrypt,
  encodeCiphertext,
  decodeCiphertext,
  randomBytes,
  deriveKEKFromPassword,
  SALT_LEN,
} from '@recued/crypto';
import {
  type Ed25519Keypair,
  type ServerKeyStore,
  type StoredAccountBinding,
} from './index.js';

/** On-disk JSON shape. `encrypted: true` means the `payload` field
 *  is an AEAD-sealed base64 string; otherwise the payload contains
 *  the cleartext keypairs directly. */
interface KeyFileVersionedDoc {
  version: 1;
  encrypted: boolean;
  /** When `encrypted: true`, salt for the passphrase KEK derivation
   *  (base64). Different per file so the same passphrase across
   *  servers produces different KEKs. */
  kdf_salt_b64?: string;
  /** When `encrypted: true`, Argon2id parameters used. Persisted so
   *  verify-side params match. */
  kdf_params?: { t: number; m: number; p: number };
  /** When `encrypted: true`, base64 of `iv || ct` (per
   *  `encodeCiphertext`). When `encrypted: false`, base64 of the
   *  inner JSON document so unsigned files still roundtrip via the
   *  same loader. */
  payload: string;
}

/** Cleartext inner shape — what the encrypted payload decrypts to. */
interface KeyFileInnerPayload {
  server_identity?: SerializedKeypair;
  publisher_identity?: SerializedKeypair;
  /** D-175 P5 — the recued.com account binding (server-scoped
   *  credential + metadata). Rides the same doc as the signing keys so
   *  it inherits the file's at-rest protection (plaintext under disk-
   *  access trust, or AEAD-sealed under the passphrase). */
  account_binding?: StoredAccountBinding;
  /** Server vault key (base64 of 32 random bytes) — the keyfile-side
   *  factor that auto-unlocks the Master DEK at boot. SECRET; rides the
   *  same at-rest protection as the signing keys. Absent until first-boot
   *  encryption enrollment writes it. Kept in THIS file (not the db) on
   *  purpose: a db-only backup then cannot unwrap the Master DEK. */
  server_vault_key_b64?: string;
}

interface SerializedKeypair {
  key_class: Ed25519Keypair['key_class'];
  private_key_b64: string;
  public_key_b64: string;
  public_key_fingerprint: string;
  created_at: number;
}

const FILE_VERSION = 1 as const;

/** Argon2id parameters for KEK derivation. Tighter than the user-
 *  password defaults because we expect operators to set a strong
 *  passphrase + the file rests on disk where disk-level access is
 *  the threat. 64 MiB / 3 iter / 4 lanes — OWASP 2024 baseline. */
const KEK_ARGON2_PARAMS = Object.freeze({
  t: 3,
  m: 65_536,
  p: 4,
});

const toSerialized = (kp: Ed25519Keypair): SerializedKeypair => ({
  key_class: kp.key_class,
  private_key_b64: kp.private_key_b64,
  public_key_b64: kp.public_key_b64,
  public_key_fingerprint: kp.public_key_fingerprint,
  created_at: kp.created_at,
});

const fromSerialized = (s: SerializedKeypair): Ed25519Keypair => ({
  key_class: s.key_class,
  private_key_b64: s.private_key_b64,
  public_key_b64: s.public_key_b64,
  public_key_fingerprint: s.public_key_fingerprint,
  created_at: s.created_at,
});

const isSerializedKeypair = (
  v: unknown,
  expected_class: Ed25519Keypair['key_class'],
): v is SerializedKeypair => {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    r.key_class === expected_class &&
    typeof r.private_key_b64 === 'string' &&
    typeof r.public_key_b64 === 'string' &&
    typeof r.public_key_fingerprint === 'string' &&
    typeof r.created_at === 'number'
  );
};

/** D-175 P5 — minimal shape guard for a persisted account binding.
 *  Returns null on a malformed / partial record rather than throwing:
 *  unlike the signing keypairs (whose tamper guards throw to surface a
 *  swapped key_class), a corrupt binding degrades to "unbound" — the
 *  server is simply re-bindable, and a half-written record must not
 *  brick boot. */
const asStoredAccountBinding = (v: unknown): StoredAccountBinding | null => {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (
    typeof r.account_id !== 'string' ||
    typeof r.server_scoped_credential !== 'string' ||
    typeof r.server_fingerprint !== 'string' ||
    typeof r.bound_at !== 'number' ||
    typeof r.credential_issued_at !== 'number'
  ) {
    return null;
  }
  return r as unknown as StoredAccountBinding;
};

const writeAtomic = (path: string, body: string): void => {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  // 0o600 = owner rw; nobody else.
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    // Best-effort cleanup of the tmp file on rename failure.
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
};

const readDoc = (path: string): KeyFileVersionedDoc | null => {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`createFileServerKeyStore: ${path} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`createFileServerKeyStore: ${path} is not a JSON object`);
  }
  const r = parsed as Record<string, unknown>;
  if (r.version !== FILE_VERSION) {
    throw new Error(
      `createFileServerKeyStore: ${path} has unsupported version ${String(r.version)} (expected ${FILE_VERSION})`,
    );
  }
  if (typeof r.encrypted !== 'boolean' || typeof r.payload !== 'string') {
    throw new Error(`createFileServerKeyStore: ${path} is malformed`);
  }
  return parsed as KeyFileVersionedDoc;
};

const decodeInner = async (
  doc: KeyFileVersionedDoc,
  passphrase: string | undefined,
): Promise<KeyFileInnerPayload> => {
  if (doc.encrypted) {
    if (!passphrase) {
      throw new Error(
        'createFileServerKeyStore: file is encrypted but no passphrase supplied',
      );
    }
    if (!doc.kdf_salt_b64 || !doc.kdf_params) {
      throw new Error('createFileServerKeyStore: encrypted file missing kdf fields');
    }
    const salt = base64ToBytes(doc.kdf_salt_b64);
    const kek = await deriveKEKFromPassword(passphrase, salt, doc.kdf_params);
    let plaintext: Uint8Array;
    try {
      plaintext = await aeadDecrypt(kek, decodeCiphertext(doc.payload));
    } catch {
      throw new Error('createFileServerKeyStore: decryption failed (wrong passphrase or tampered file)');
    }
    return JSON.parse(new TextDecoder().decode(plaintext)) as KeyFileInnerPayload;
  }
  if (passphrase) {
    throw new Error(
      'createFileServerKeyStore: file is unencrypted but a passphrase was supplied',
    );
  }
  return JSON.parse(
    new TextDecoder().decode(base64ToBytes(doc.payload)),
  ) as KeyFileInnerPayload;
};

const encodeInner = async (
  inner: KeyFileInnerPayload,
  passphrase: string | undefined,
  params: { t: number; m: number; p: number },
): Promise<KeyFileVersionedDoc> => {
  const innerJson = JSON.stringify(inner);
  if (passphrase) {
    const salt = randomBytes(SALT_LEN);
    const kek = await deriveKEKFromPassword(passphrase, salt, params);
    const ct = await aeadEncrypt(kek, new TextEncoder().encode(innerJson));
    return {
      version: FILE_VERSION,
      encrypted: true,
      kdf_salt_b64: bytesToBase64(salt),
      kdf_params: { ...params },
      payload: encodeCiphertext(ct),
    };
  }
  return {
    version: FILE_VERSION,
    encrypted: false,
    payload: bytesToBase64(new TextEncoder().encode(innerJson)),
  };
};

export interface CreateFileServerKeyStoreOptions {
  /** Absolute path to the keys file. The directory is created with
   *  `mkdir -p` when missing. */
  filePath: string;
  /** Optional passphrase. When supplied, the on-disk payload is
   *  AEAD-sealed under an Argon2id-derived KEK. When omitted, the
   *  file holds cleartext keypair bytes; physical disk access is
   *  the trust boundary. */
  passphrase?: string;
  /** Override Argon2id parameters for KEK derivation. Tests pass
   *  weaker params for speed; production callers should leave this
   *  unset to use `KEK_ARGON2_PARAMS` (OWASP 2024 baseline). The
   *  parameters used at write time persist in the file so the
   *  read-side picks them up automatically; cost can evolve over
   *  time without breaking older files. */
  argon2_params?: { t: number; m: number; p: number };
}

/** Build a disk-backed `ServerKeyStore`. Synchronous load on
 *  construction so callers see whatever's already persisted; async
 *  Argon2id derivation only fires on saves under encrypted mode.
 *
 *  Construction throws if the on-disk file is corrupt or fails
 *  decrypt — the caller is expected to surface that to the operator
 *  rather than overwrite.
 *
 *  Concurrency is single-process: this store is not safe for
 *  multiple processes writing the same file simultaneously. The
 *  server runs as one process; the key-rotation flow is single-
 *  threaded by construction. */
export const createFileServerKeyStore = async (
  options: CreateFileServerKeyStoreOptions,
): Promise<ServerKeyStore> => {
  const { filePath, passphrase } = options;
  // Read-side Argon2 params come from the on-disk doc when present
  // (verify-side correctness). Write-side falls back to caller
  // override or KEK_ARGON2_PARAMS for fresh files.
  const writeParams = options.argon2_params ?? KEK_ARGON2_PARAMS;
  let cache: KeyFileInnerPayload = {};

  const initialDoc = readDoc(filePath);
  if (initialDoc) {
    cache = await decodeInner(initialDoc, passphrase);
  }

  const persist = async (): Promise<void> => {
    const doc = await encodeInner(cache, passphrase, writeParams);
    writeAtomic(filePath, JSON.stringify(doc));
  };

  // Saves are sync at the interface boundary (matches in-memory
  // store) but the async persist() is fire-and-forget by design —
  // the on-disk file will be flushed before the next save anyway,
  // and the in-memory cache is the source of truth for in-flight
  // signing. When encryption is enabled, callers that need a strict
  // "key is on disk before I return" guarantee should call
  // `flushFileServerKeyStore` after save (exposed below).
  let pendingFlush: Promise<void> | null = null;
  const schedulePersist = (): void => {
    pendingFlush = (pendingFlush ?? Promise.resolve()).then(persist);
  };

  const store: ServerKeyStore = {
    loadServerIdentityKey: () => {
      const s = cache.server_identity;
      if (!s) return null;
      if (!isSerializedKeypair(s, 'server_identity_key')) {
        throw new Error(
          `createFileServerKeyStore: ${filePath} server_identity has wrong key_class — file may be tampered`,
        );
      }
      return fromSerialized(s);
    },

    saveServerIdentityKey: (k) => {
      if (k.key_class !== 'server_identity_key') {
        throw new Error(
          `ServerKeyStore: refusing to save key_class '${k.key_class}' as server_identity_key`,
        );
      }
      cache = { ...cache, server_identity: toSerialized(k) };
      schedulePersist();
    },

    loadPublisherIdentityKey: () => {
      const s = cache.publisher_identity;
      if (!s) return null;
      if (!isSerializedKeypair(s, 'publisher_identity_key')) {
        throw new Error(
          `createFileServerKeyStore: ${filePath} publisher_identity has wrong key_class — file may be tampered`,
        );
      }
      return fromSerialized(s);
    },

    savePublisherIdentityKey: (k) => {
      if (k.key_class !== 'publisher_identity_key') {
        throw new Error(
          `ServerKeyStore: refusing to save key_class '${k.key_class}' as publisher_identity_key`,
        );
      }
      cache = { ...cache, publisher_identity: toSerialized(k) };
      schedulePersist();
    },

    loadAccountBinding: () => asStoredAccountBinding(cache.account_binding),

    saveAccountBinding: (b) => {
      cache = { ...cache, account_binding: b };
      schedulePersist();
    },

    clearAccountBinding: () => {
      // Drop the key entirely (rather than persist `undefined`) so the
      // on-disk doc reads clean as "unbound".
      const { account_binding: _dropped, ...rest } = cache;
      cache = rest;
      schedulePersist();
    },

    loadServerVaultKey: () => {
      const b = cache.server_vault_key_b64;
      return b ? base64ToBytes(b) : null;
    },

    saveServerVaultKey: (k) => {
      cache = { ...cache, server_vault_key_b64: bytesToBase64(k) };
      schedulePersist();
    },

    /** Codex P2 #4 fold — disk-fence helper for rotation paths.
     *  Awaits any pending persist scheduled by prior save* calls
     *  before returning. Identity rotation MUST await this before
     *  notifying clients (`pair.required` broadcast) so a crash
     *  between save + broadcast cannot leave clients chasing a key
     *  that's not on disk. */
    flush: async () => {
      if (pendingFlush) await pendingFlush;
    },
  };

  return store;
};

/** Test/production helper: await any pending persists fired by save
 *  calls. Exposed because the synchronous interface schedules
 *  encrypted writes on a background promise chain. Equivalent to
 *  calling `store.flush?.()`. */
export const flushFileServerKeyStore = async (
  store: ServerKeyStore,
): Promise<void> => {
  if (store.flush) await store.flush();
};

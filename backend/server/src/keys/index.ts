/** D-148 § A.8 — server-side key primitives.
 *
 *  Primitives shipped at P1:
 *   - Ed25519 keypair generation + sign/verify (Node's built-in crypto)
 *   - Argon2id token hash + constant-time verify (via `@recued/crypto`'s
 *     `@noble/hashes` argon2 binding)
 *   - HKDF sub-DEK derivation (delegates to `@recued/crypto`)
 *   - Key storage abstraction (`ServerKeyStore`) for `server_identity_key`
 *     + `publisher_identity_key` — OS keyring or passphrase-encrypted file
 *     fallback.
 *
 *  The substrate enforces D-148 invariant I-4 (encryption keys never sign;
 *  signing keys never decrypt) at every API boundary by reading
 *  `KEY_CAPABILITIES` from `@recued/contracts/keys`. Compile-time
 *  discriminated-union narrowing + runtime `assertKeyCapable` together
 *  catch any drift.
 *
 *  P2 wires: server identity persistence, pair-blob signing path, audit-
 *  row signing path, key rotation flows.
 */

import { argon2idAsync } from '@noble/hashes/argon2.js';
import {
  randomBytes,
  base64ToBytes,
  bytesToBase64,
  deriveSubDEK,
  type SubDEKDomain,
} from '@recued/crypto';
import {
  assertKeyCapable,
  KEY_CAPABILITIES,
  type KeyClass,
} from '@recued/contracts';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';

// ────────────────────────────────────────────────────────────────
// Ed25519 sign / verify
// ────────────────────────────────────────────────────────────────

/** Ed25519 keypair — distinct shape from `tls_private_key` (which is a
 *  TLS-internal class that never crosses the application boundary).
 *  Both `server_identity_key` and `publisher_identity_key` use this
 *  shape; the `key_class` field is what distinguishes their semantics. */
export interface Ed25519Keypair {
  key_class: 'server_identity_key' | 'publisher_identity_key';
  /** Private half. PKCS8 DER-encoded, base64 string. */
  private_key_b64: string;
  /** Public half. SPKI DER-encoded, base64 string. */
  public_key_b64: string;
  /** SHA-256 fingerprint of the public-key bytes. Stable identity for
   *  the keypair; surfaced in the Server Passport + audit rows. */
  public_key_fingerprint: string;
  /** Unix-ms creation timestamp. */
  created_at: number;
}

/** D-175 P5 — the server's recued.com account binding, persisted as
 *  identity-root material alongside the signing keypairs.
 *
 *  This is the SECRET-bearing at-rest record (it carries
 *  `server_scoped_credential`). It rides the same `ServerKeyStore` /
 *  identity-keys file as `server_identity_key` so it inherits that
 *  file's at-rest protection — 0600 mode + atomic write; cleartext
 *  under the disk-access trust boundary by default (matching the
 *  cleartext server db + the signing keys themselves), or AEAD-sealed
 *  under `RECUED_IDENTITY_PASSPHRASE`. It is account-coordination
 *  material (the one cloud exception, D-175 D10) — never user data.
 *
 *  The single slot enforces "one server → one owning account at a
 *  time" (D-175 D10): a bind from a different account overwrites it,
 *  but only under explicit confirmation at the manager layer (no silent
 *  rebind). Only the secret-free `AccountBindingSummary` projection of
 *  this record ever crosses an rpc. */
export interface StoredAccountBinding {
  /** recued.com account id that owns this server. */
  account_id: string;
  /** Publisher handle when the account has reserved one. */
  publisher_handle?: string;
  /** SECRET — the server-scoped account credential the Worker returned.
   *  Drives Pro cloud conveniences (DDNS/ACME) server-side. Never
   *  returned over any `account.*` rpc. */
  server_scoped_credential: string;
  /** `sha256:<hex>` of the server_identity_key public half this binding
   *  is anchored to. Lets a rotation surface detect a binding minted
   *  under a retired identity. */
  server_fingerprint: string;
  /** Unix-ms the binding was first established. Preserved across an
   *  in-place credential refresh (same account re-binds). */
  bound_at: number;
  /** Unix-ms of the most recent confirmed rebind (a different account
   *  took over). Absent until a rebind happens. */
  rebound_at?: number;
  /** Unix-ms the credential was issued by the Worker. */
  credential_issued_at: number;
  /** Unix-ms the credential expires, when bounded. */
  credential_expires_at?: number;
}

/** Generate a fresh Ed25519 keypair. Uses Node's crypto.generateKeyPair. */
export const generateEd25519Keypair = (
  key_class: Ed25519Keypair['key_class'],
): Ed25519Keypair => {
  assertKeyCapable(key_class, 'sign');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const public_key_der = publicKey.export({ type: 'spki', format: 'der' });
  const private_key_der = privateKey.export({ type: 'pkcs8', format: 'der' });
  return {
    key_class,
    private_key_b64: bytesToBase64(new Uint8Array(private_key_der)),
    public_key_b64: bytesToBase64(new Uint8Array(public_key_der)),
    public_key_fingerprint: ed25519PublicKeyFingerprint(
      new Uint8Array(public_key_der),
    ),
    created_at: Date.now(),
  };
};

/** Compute the SHA-256 fingerprint of an Ed25519 public key (SPKI DER).
 *  Returns `sha256:<hex>` for stable display. D-148 follow-up #6 lifted
 *  `createHash` to a top-level `node:crypto` import — the prior dynamic
 *  `require('node:crypto')` survived as a no-cost choice while the
 *  fingerprint path was lazy, but bin.ts's identity-boot wiring calls
 *  it at module load, and the esbuild bundle for `dist/bin.js` can't
 *  resolve dynamic `require()` under ESM output. The top-level import
 *  was already pulling `generateKeyPairSync` + friends from the same
 *  module, so there's no extra dependency-graph hop. */
export const ed25519PublicKeyFingerprint = (
  public_key_spki_der: Uint8Array,
): string => {
  return 'sha256:' + createHash('sha256').update(public_key_spki_der).digest('hex');
};

/** Load a private KeyObject from base64-encoded PKCS8 DER. */
const loadPrivateKey = (private_key_b64: string): KeyObject => {
  const der = base64ToBytes(private_key_b64);
  return createPrivateKey({ key: Buffer.from(der), format: 'der', type: 'pkcs8' });
};

/** Load a public KeyObject from base64-encoded SPKI DER. */
const loadPublicKey = (public_key_b64: string): KeyObject => {
  const der = base64ToBytes(public_key_b64);
  return createPublicKey({ key: Buffer.from(der), format: 'der', type: 'spki' });
};

/** Sign a payload with an Ed25519 keypair. The keypair's `key_class`
 *  must declare the `sign` capability — D-148 invariant I-4 enforced
 *  via `assertKeyCapable`. Returns the signature as a base64 string. */
export const ed25519Sign = (
  keypair: Ed25519Keypair,
  payload: Uint8Array | string,
): string => {
  assertKeyCapable(keypair.key_class, 'sign');
  const data = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
  const key = loadPrivateKey(keypair.private_key_b64);
  // Ed25519 in Node uses null algorithm parameter.
  const sig = nodeSign(null, data, key);
  return bytesToBase64(new Uint8Array(sig));
};

/** Verify an Ed25519 signature. Public key in base64 SPKI DER form;
 *  signature in base64. Returns boolean — never throws on bad input
 *  shape; returns false instead. */
export const ed25519Verify = (
  public_key_b64: string,
  payload: Uint8Array | string,
  signature_b64: string,
): boolean => {
  try {
    const data = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
    const sig = base64ToBytes(signature_b64);
    const key = loadPublicKey(public_key_b64);
    return nodeVerify(null, data, key, sig);
  } catch {
    return false;
  }
};

// ────────────────────────────────────────────────────────────────
// Argon2id bearer token hash + constant-time verify
// ────────────────────────────────────────────────────────────────

/** Default Argon2id params for bearer tokens. Tighter than the user
 *  password defaults (`@recued/crypto`'s DEFAULT_ARGON2_PARAMS at 64
 *  MiB / 3 iter / 4 lanes) because tokens are high-entropy CSPRNG
 *  output, not user-typed strings — the slow KDF protects against
 *  database-leak brute force, not online guessing. 32 MiB / 2 iter /
 *  2 lanes is the OWASP "interactive but high-entropy input" preset. */
export const TOKEN_ARGON2_PARAMS = Object.freeze({
  t: 2,
  m: 32 * 1024,
  p: 2,
});

export interface TokenHashRecord {
  /** Argon2id-hashed bearer token. Base64 string. */
  hash_b64: string;
  /** Salt used in the Argon2id call. Base64 string. */
  salt_b64: string;
  /** Argon2id parameters used. Persisted so verify side can match. */
  params: { t: number; m: number; p: number };
}

/** Hash a bearer token. Returns the persistent record shape — store
 *  this in `client_tokens.token_hash` (encoded as JSON or three
 *  fields per schema preference). */
export const hashBearerToken = async (
  bearer: string,
  params: { t: number; m: number; p: number } = TOKEN_ARGON2_PARAMS,
): Promise<TokenHashRecord> => {
  if (bearer.length === 0) {
    throw new Error('hashBearerToken: bearer must be non-empty');
  }
  const salt = randomBytes(16);
  const hash = await argon2idAsync(bearer, salt, {
    t: params.t,
    m: params.m,
    p: params.p,
    dkLen: 32,
  });
  return {
    hash_b64: bytesToBase64(hash),
    salt_b64: bytesToBase64(salt),
    params,
  };
};

/** Constant-time verify a bearer against a stored hash record.
 *  Returns true iff the bearer regenerates the same hash with the
 *  stored salt + params. */
export const verifyBearerToken = async (
  bearer: string,
  record: TokenHashRecord,
): Promise<boolean> => {
  try {
    if (bearer.length === 0) return false;
    const expected = base64ToBytes(record.hash_b64);
    const salt = base64ToBytes(record.salt_b64);
    const computed = await argon2idAsync(bearer, salt, {
      t: record.params.t,
      m: record.params.m,
      p: record.params.p,
      dkLen: expected.length,
    });
    return timingSafeEqual(Buffer.from(expected), Buffer.from(computed));
  } catch {
    return false;
  }
};

/** Generate a fresh bearer token for client_tokens issuance. 32-byte
 *  CSPRNG output, base64-encoded → 43-char URL-safe-ish string. */
export const generateBearerToken = (): string => bytesToBase64(randomBytes(32));

// ────────────────────────────────────────────────────────────────
// Sub-DEK derivation (delegates to @recued/crypto)
// ────────────────────────────────────────────────────────────────

/** Derive a sub-DEK from the master DEK for a domain. D-148 reuses
 *  the existing `@recued/crypto` HKDF derivation so all encryption
 *  surfaces (vault, audit, enrichment, blob-store, etc.) flow through
 *  one path. */
export const deriveSubDEKForDomain = (
  master_dek: Uint8Array,
  domain: SubDEKDomain,
): Uint8Array => deriveSubDEK(master_dek, domain);

// ────────────────────────────────────────────────────────────────
// Server key store abstraction
// ────────────────────────────────────────────────────────────────

/** Persistence boundary for the server's signing keypairs.
 *
 *  P1 ships the interface + an in-memory implementation for tests.
 *  P2 implements OS-keyring + passphrase-encrypted file fallback +
 *  rotation flow. Keeping this behind an interface lets the P1
 *  contract tests run without touching disk or platform keyring.
 *
 *  Codex P2 #4 fold: `flush?` lets rotation paths await a disk-
 *  durable persist before notifying clients. Disk-backed stores
 *  schedule writes asynchronously for throughput; rotation MUST
 *  fence on durability before broadcast `pair.required` so a crash
 *  between save + broadcast can't leave clients chasing a key
 *  that's not on disk. Implementations without async persistence
 *  (in-memory) leave `flush` undefined; callers treat it as a no-op. */
/** How the keyfile on disk is protected. `none` means its bytes are readable by
 *  anyone who can read the directory — which is the directory the realm database
 *  lives in. */
export type KeyfileSealingPosture = 'machine' | 'passphrase' | 'none';

export interface ServerKeyStore {
  /** How this keyfile is currently sealed. Reported from the file's own header,
   *  not from what the caller asked for, so it answers "what is true" rather
   *  than "what was intended". Absent on stores with no on-disk form. */
  sealingPosture?(): KeyfileSealingPosture;
  /** Read the persisted server_identity_key. Null when never
   *  initialized. */
  loadServerIdentityKey(): Ed25519Keypair | null;
  /** Persist a fresh server_identity_key. Overwrites prior. */
  saveServerIdentityKey(key: Ed25519Keypair): void;
  /** Read the persisted publisher_identity_key. Null when never
   *  initialized — publisher_identity is independent of server
   *  identity per D-148 invariant I-7. */
  loadPublisherIdentityKey(): Ed25519Keypair | null;
  /** Persist a fresh publisher_identity_key. */
  savePublisherIdentityKey(key: Ed25519Keypair): void;
  /** D-175 P5 — read the persisted recued.com account binding. Null
   *  when the server is unbound. Identity-root material co-located with
   *  the signing keys. */
  loadAccountBinding(): StoredAccountBinding | null;
  /** D-175 P5 — persist / overwrite the account binding. The single
   *  slot is the "one server → one owning account at a time" invariant
   *  (D-175 D10); the manager layer gates a different-account overwrite
   *  behind explicit confirmation. */
  saveAccountBinding(binding: StoredAccountBinding): void;
  /** D-175 P5 — drop the account binding (unbind). No-op when already
   *  unbound. */
  clearAccountBinding(): void;
  /** Read the persisted server VAULT key — the random 32-byte secret
   *  that wraps the Master DEK for headless auto-unlock (the server
   *  vault bundle, `@recued/crypto`'s `ServerBundle`). Null when the
   *  server has not enrolled encryption yet. Rides the same `0600`
   *  keyfile as the signing keys, so it inherits that file's at-rest
   *  protection — and a db-only backup (without this keyfile) cannot
   *  unwrap the Master DEK; only the recovery key can. */
  loadServerVaultKey(): Uint8Array | null;
  /** Persist / overwrite the server vault key. Written once, at
   *  first-boot enrollment. The recovery key is the only OTHER factor
   *  that can unwrap the same Master DEK (disaster recovery). */
  saveServerVaultKey(key: Uint8Array): void;
  /** Optional disk-fence helper. Returns when prior `save*` calls
   *  are durable. Disk-backed stores wire this to fsync + rename;
   *  in-memory stores leave undefined. */
  flush?(): Promise<void>;
}

/** In-memory ServerKeyStore. Tests + non-persistent dev runners.
 *  Production callers wire a disk-backed implementation in P2. */
export const createInMemoryServerKeyStore = (): ServerKeyStore => {
  let serverIdentity: Ed25519Keypair | null = null;
  let publisherIdentity: Ed25519Keypair | null = null;
  let accountBinding: StoredAccountBinding | null = null;
  let serverVaultKey: Uint8Array | null = null;
  return {
    loadServerIdentityKey: () => serverIdentity,
    saveServerIdentityKey: (k) => {
      if (k.key_class !== 'server_identity_key') {
        throw new Error(
          `ServerKeyStore: refusing to save key_class '${k.key_class}' as server_identity_key`,
        );
      }
      serverIdentity = k;
    },
    loadPublisherIdentityKey: () => publisherIdentity,
    savePublisherIdentityKey: (k) => {
      if (k.key_class !== 'publisher_identity_key') {
        throw new Error(
          `ServerKeyStore: refusing to save key_class '${k.key_class}' as publisher_identity_key`,
        );
      }
      publisherIdentity = k;
    },
    loadAccountBinding: () => accountBinding,
    saveAccountBinding: (b) => {
      accountBinding = b;
    },
    clearAccountBinding: () => {
      accountBinding = null;
    },
    loadServerVaultKey: () => (serverVaultKey ? new Uint8Array(serverVaultKey) : null),
    saveServerVaultKey: (k) => {
      serverVaultKey = new Uint8Array(k);
    },
  };
};

/** Initialize a server key store with both identity keys. Idempotent
 *  — if either key already exists, leaves it alone and returns. Used
 *  by server boot to ensure both are present. */
export const ensureServerIdentityKeys = (store: ServerKeyStore): {
  server_identity: Ed25519Keypair;
  publisher_identity: Ed25519Keypair;
} => {
  let server_identity = store.loadServerIdentityKey();
  if (!server_identity) {
    server_identity = generateEd25519Keypair('server_identity_key');
    store.saveServerIdentityKey(server_identity);
  }
  let publisher_identity = store.loadPublisherIdentityKey();
  if (!publisher_identity) {
    publisher_identity = generateEd25519Keypair('publisher_identity_key');
    store.savePublisherIdentityKey(publisher_identity);
  }
  return { server_identity, publisher_identity };
};

// ────────────────────────────────────────────────────────────────
// D-148 invariant runtime guards (defense in depth)
// ────────────────────────────────────────────────────────────────

/** Compile-time + runtime guard that the KEY_CAPABILITIES table
 *  preserves the D-148 invariants. Tests call this; the type
 *  system enforces the same shape. */
export const assertKeyTaxonomyInvariants = (): void => {
  // I-4: encryption keys never sign; signing keys never decrypt.
  for (const cls of Object.keys(KEY_CAPABILITIES) as KeyClass[]) {
    const caps = KEY_CAPABILITIES[cls];
    if (caps.includes('sign') && caps.includes('decrypt')) {
      throw new Error(
        `Key class '${cls}' violates I-4: cannot both sign and decrypt`,
      );
    }
  }
  // I-5..7 are storage-discipline invariants enforced at the store
  // layer (saveServerIdentityKey + savePublisherIdentityKey reject
  // mismatched key_class). These are validated in the P1 test suite.
};

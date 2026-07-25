/** Server-side recovery-key enrollment + verification.
 *
 *  Two operations on a single primitive:
 *    - First call (no stored check): build a fresh check from the
 *      supplied recovery key, store it, return ok. The realm becomes
 *      bound to that recovery key forever.
 *    - Subsequent calls (stored check exists): derive the KEK from
 *      the supplied key, try to decrypt the stored check, return ok
 *      if the sentinel matches. Reject otherwise — different account.
 *
 *  The raw recovery key is never persisted. It enters this module
 *  transiently (one rpc), gets converted to entropy → KEK → check
 *  blob, then drops out of scope.
 *
 *  Wire-format compatibility note: the server's KDF + AEAD stack is
 *  `@recued/crypto` (Argon2id-free for recovery keys — uses HKDF
 *  since BIP39 entropy is already cryptographic). The extension's
 *  KDF is PBKDF2 over the normalized mnemonic string. The two are
 *  intentionally NOT byte-compatible — each side enrolls + verifies
 *  using its own primitives. The contract between them is the raw
 *  recovery key string only.
 */

import {
  recoveryKeyToEntropy,
  deriveKEKFromRecoveryKey,
  encrypt,
  decrypt,
  encodeCiphertext,
  decodeCiphertext,
  randomBytes,
  SALT_LEN,
} from '@recued/crypto';
import {
  RpcError,
  type HandlerSlice,
  type ServerRpcRegistry,
} from '@recued/contracts';
import type { RecoveryKeyCheckStore } from './recovery-key-store.js';
import type { WsClient } from './ws-server.js';

/** Public sentinel — the same string the ext uses for its own check.
 *  Embedded as the AEAD plaintext; on decrypt, byte-compare to verify. */
const RECOVERY_SENTINEL = 'recued-bundle-v1';

/** Stored check format: `salt:base64(ciphertext_with_iv)`. The salt
 *  is per-realm (not shared) so two realms with the same recovery
 *  key end up with different on-disk blobs. Salt + ciphertext are
 *  joined with a single `:` so we can split deterministically. */
const SALT_PREFIX_DELIM = ':';

const encodeStoredCheck = (salt: Uint8Array, ciphertext: string): string => {
  // base64 the salt, then `:`, then the encoded ciphertext (already
  // a base64 string from encodeCiphertext). The split-on-first-colon
  // recovers both pieces.
  const saltB64 = Buffer.from(salt).toString('base64');
  return `${saltB64}${SALT_PREFIX_DELIM}${ciphertext}`;
};

const decodeStoredCheck = (blob: string): { salt: Uint8Array; ciphertext: string } | null => {
  const idx = blob.indexOf(SALT_PREFIX_DELIM);
  if (idx <= 0) return null;
  const saltB64 = blob.slice(0, idx);
  const ciphertext = blob.slice(idx + 1);
  try {
    return { salt: new Uint8Array(Buffer.from(saltB64, 'base64')), ciphertext };
  } catch {
    return null;
  }
};

export type ProcessRecoveryKeyResult =
  /** No prior check; we just enrolled the realm with this key. */
  | { ok: true; outcome: 'enrolled' }
  /** A prior check existed and the supplied key matched it. */
  | { ok: true; outcome: 'verified' }
  /** A prior check existed but the supplied key did NOT match. The
   *  realm stays bound to the original key; nothing on disk changed. */
  | { ok: false; code: 'mismatch'; message: string }
  /** The supplied recovery key isn't a valid 24-word BIP39 mnemonic.
   *  Caught by `recoveryKeyToEntropy` throwing on bad checksum / word. */
  | { ok: false; code: 'invalid'; message: string };

/** Outcome of a READ-ONLY verify of a recovery key against the realm's
 *  stored check. Unlike `processRecoveryKey` this NEVER enrolls — an
 *  un-enrolled realm reports `not_enrolled` rather than binding the key. */
export type RealmVerifyResult = 'match' | 'mismatch' | 'not_enrolled';

/** Core verify: does `entropy` decrypt the stored check blob back to the
 *  sentinel? Shared by `processRecoveryKey` (verify branch) and the
 *  read-only `verifyRecoveryKeyAgainstRealm`. A malformed blob / KDF
 *  failure / AEAD failure / sentinel mismatch all resolve `false`. */
const storedCheckMatches = async (
  storedBlob: string,
  entropy: Uint8Array,
): Promise<boolean> => {
  const decoded = decodeStoredCheck(storedBlob);
  if (!decoded) return false;
  let kek: Uint8Array;
  try {
    kek = deriveKEKFromRecoveryKey(entropy, decoded.salt);
  } catch {
    return false;
  }
  const ciphertext = decodeCiphertext(decoded.ciphertext);
  let plaintextBytes: Uint8Array;
  try {
    plaintextBytes = await decrypt(kek, ciphertext);
  } catch {
    return false;
  }
  return new TextDecoder().decode(plaintextBytes) === RECOVERY_SENTINEL;
};

/** Read-only check of `recoveryKey` against the realm's stored sentinel.
 *  NEVER mutates the store (no enroll) — the archive-restore realm gate
 *  (Q2) needs to ask "does this key own the CURRENT realm?" without binding
 *  anything. `not_enrolled` when the realm has no check yet (a fresh /
 *  pre-pair server — the gate treats that as "nothing to defend"). */
export const verifyRecoveryKeyAgainstRealm = async (
  store: RecoveryKeyCheckStore,
  recoveryKey: string,
): Promise<RealmVerifyResult> => {
  const stored = store.read();
  if (stored === null) return 'not_enrolled';
  let entropy: Uint8Array;
  try {
    entropy = recoveryKeyToEntropy(recoveryKey);
  } catch {
    return 'mismatch';
  }
  return (await storedCheckMatches(stored, entropy)) ? 'match' : 'mismatch';
};

/** Enroll-or-verify the realm against `recoveryKey`. The store is
 *  read once + written at most once per call. On verify-success
 *  nothing is rewritten — the original blob is the binding. */
export const processRecoveryKey = async (
  store: RecoveryKeyCheckStore,
  recoveryKey: string,
): Promise<ProcessRecoveryKeyResult> => {
  // Stage 1: parse the mnemonic. Throws on bad word / checksum.
  let entropy: Uint8Array;
  try {
    entropy = recoveryKeyToEntropy(recoveryKey);
  } catch (err) {
    return {
      ok: false,
      code: 'invalid',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const stored = store.read();

  // Stage 2 (no prior check): enroll.
  if (stored === null) {
    const salt = randomBytes(SALT_LEN);
    const kek = deriveKEKFromRecoveryKey(entropy, salt);
    const ciphertext = await encrypt(kek, new TextEncoder().encode(RECOVERY_SENTINEL));
    const blob = encodeStoredCheck(salt, encodeCiphertext(ciphertext));
    store.write(blob);
    return { ok: true, outcome: 'enrolled' };
  }

  // Stage 2 (prior check exists): verify (read-only — never rewrites).
  // A corrupt blob / KDF / AEAD / sentinel failure all collapse to the same
  // client-facing `mismatch` so we don't leak server-state shape.
  if (await storedCheckMatches(stored, entropy)) {
    return { ok: true, outcome: 'verified' };
  }
  return {
    ok: false,
    code: 'mismatch',
    message: 'Recovery key does not match this server\'s account.',
  };
};

// ────────────────────────────────────────────────────────────────
// Handler slice — composeHandlers factory for pair.registerRecoveryKey
// ────────────────────────────────────────────────────────────────

export type RecoveryMethods = 'pair.registerRecoveryKey';

export const makeRecoveryHandlers = (
  store: RecoveryKeyCheckStore | undefined,
): HandlerSlice<ServerRpcRegistry, RecoveryMethods, WsClient> | undefined => {
  if (!store) return undefined;
  return {
    methods: ['pair.registerRecoveryKey'],
    handlers: {
      'pair.registerRecoveryKey': async (args) => {
        if (typeof args.recoveryKey !== 'string' || args.recoveryKey.length === 0) {
          throw new RpcError('bad_request', 'recoveryKey is required', 400);
        }
        const result = await processRecoveryKey(store, args.recoveryKey);
        if (!result.ok) {
          // `mismatch` → 401 (different account); `invalid` → 400
          // (malformed mnemonic). Both are user-actionable on the ext
          // side — different copy per code.
          throw new RpcError(
            result.code,
            result.message,
            result.code === 'mismatch' ? 401 : 400,
          );
        }
        return { outcome: result.outcome };
      },
    },
  };
};

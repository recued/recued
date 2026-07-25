/** D-148 P1 — backend key primitives.
 *
 *  Acceptance per spec § P1:
 *   - Ed25519 sign/verify round-trip with `server_identity_key` /
 *     `publisher_identity_key`.
 *   - Tampered payload fails verify; tampered signature fails verify.
 *   - Argon2id hash + verify constant-time + correct rejection of
 *     wrong bearer.
 *   - HKDF determinism delegated to `@recued/crypto`'s deriveSubDEK
 *     (smoke check; full coverage in @recued/crypto's own suite).
 *   - ServerKeyStore round-trip + ensureServerIdentityKeys idempotent.
 *   - assertKeyTaxonomyInvariants enforces I-4 at runtime.
 */

import { describe, it, expect } from 'vitest';
import {
  generateEd25519Keypair,
  ed25519Sign,
  ed25519Verify,
  ed25519PublicKeyFingerprint,
  hashBearerToken,
  verifyBearerToken,
  generateBearerToken,
  deriveSubDEKForDomain,
  createInMemoryServerKeyStore,
  ensureServerIdentityKeys,
  assertKeyTaxonomyInvariants,
  TOKEN_ARGON2_PARAMS,
  type Ed25519Keypair,
} from '../keys/index.js';
import { base64ToBytes } from '@recued/crypto';

const FAST_ARGON2 = { t: 1, m: 1024, p: 1 };

describe('D-148 P1 — Ed25519 keypair generation', () => {
  it('generates server_identity_key with the right shape', () => {
    const kp = generateEd25519Keypair('server_identity_key');
    expect(kp.key_class).toBe('server_identity_key');
    expect(typeof kp.private_key_b64).toBe('string');
    expect(typeof kp.public_key_b64).toBe('string');
    expect(kp.public_key_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(kp.created_at).toBeGreaterThan(0);
  });

  it('generates publisher_identity_key with the right shape', () => {
    const kp = generateEd25519Keypair('publisher_identity_key');
    expect(kp.key_class).toBe('publisher_identity_key');
  });

  it('two keypairs differ in fingerprint', () => {
    const a = generateEd25519Keypair('server_identity_key');
    const b = generateEd25519Keypair('server_identity_key');
    expect(a.public_key_fingerprint).not.toBe(b.public_key_fingerprint);
  });

  it('public key fingerprint is computed from SPKI DER bytes', () => {
    const kp = generateEd25519Keypair('server_identity_key');
    const der = base64ToBytes(kp.public_key_b64);
    expect(ed25519PublicKeyFingerprint(der)).toBe(kp.public_key_fingerprint);
  });
});

describe('D-148 P1 — Ed25519 sign + verify', () => {
  let kp: Ed25519Keypair;

  beforeEachKeypair: {
    kp = generateEd25519Keypair('server_identity_key');
  }

  it('signs + verifies a canonical payload string', () => {
    const sig = ed25519Sign(kp, 'hello world');
    expect(typeof sig).toBe('string');
    expect(sig.length).toBeGreaterThan(0);
    expect(ed25519Verify(kp.public_key_b64, 'hello world', sig)).toBe(true);
  });

  it('signs + verifies bytes', () => {
    const payload = new TextEncoder().encode('binary payload');
    const sig = ed25519Sign(kp, payload);
    expect(ed25519Verify(kp.public_key_b64, payload, sig)).toBe(true);
  });

  it('tampered payload fails verify', () => {
    const sig = ed25519Sign(kp, 'hello world');
    expect(ed25519Verify(kp.public_key_b64, 'hello world!', sig)).toBe(false);
  });

  it('tampered signature fails verify', () => {
    const sig = ed25519Sign(kp, 'hello world');
    // Flip one base64 char.
    const tampered = sig[0] === 'A' ? 'B' + sig.slice(1) : 'A' + sig.slice(1);
    expect(ed25519Verify(kp.public_key_b64, 'hello world', tampered)).toBe(false);
  });

  it('different keypair fails verify', () => {
    const other = generateEd25519Keypair('server_identity_key');
    const sig = ed25519Sign(kp, 'hello world');
    expect(ed25519Verify(other.public_key_b64, 'hello world', sig)).toBe(false);
  });

  it('malformed signature returns false (not throw)', () => {
    expect(ed25519Verify(kp.public_key_b64, 'hello', 'not-base64')).toBe(false);
  });

  it('malformed public key returns false (not throw)', () => {
    expect(ed25519Verify('not-a-key', 'hello', 'AAAA')).toBe(false);
  });

  it('Codex P2 #7 — forging a non-signing key class throws KeyCapabilityError', () => {
    // TypeScript prevents this at compile time via the
    // discriminated union. The runtime guard fires when a caller
    // bypasses the type system (cast, untrusted input, plugin
    // bridge). Forge a keypair with `master_dek` (decrypt-only) +
    // assert ed25519Sign throws.
    const forged = {
      ...kp,
      key_class: 'master_dek' as Ed25519Keypair['key_class'],
    };
    expect(() => ed25519Sign(forged, 'x')).toThrow(/master_dek.*sign/);
  });

  it('Codex P2 #7 — forging webhook_secret as signing key throws', () => {
    const forged = {
      ...kp,
      key_class: 'webhook_secret' as Ed25519Keypair['key_class'],
    };
    expect(() => ed25519Sign(forged, 'x')).toThrow();
  });
});

describe('D-148 P1 — Argon2id bearer token hash + verify', () => {
  it('hashes a bearer + verifies it', async () => {
    const bearer = 'super-secret-bearer-token';
    const record = await hashBearerToken(bearer, FAST_ARGON2);
    expect(record.hash_b64).toBeTruthy();
    expect(record.salt_b64).toBeTruthy();
    expect(record.params).toEqual(FAST_ARGON2);

    const ok = await verifyBearerToken(bearer, record);
    expect(ok).toBe(true);
  });

  it('rejects wrong bearer', async () => {
    const record = await hashBearerToken('correct', FAST_ARGON2);
    expect(await verifyBearerToken('wrong', record)).toBe(false);
  });

  it('rejects empty bearer', async () => {
    await expect(hashBearerToken('', FAST_ARGON2)).rejects.toThrow();
    const record = await hashBearerToken('x', FAST_ARGON2);
    expect(await verifyBearerToken('', record)).toBe(false);
  });

  it('different salts produce different hashes for the same bearer', async () => {
    const a = await hashBearerToken('same-bearer', FAST_ARGON2);
    const b = await hashBearerToken('same-bearer', FAST_ARGON2);
    expect(a.hash_b64).not.toBe(b.hash_b64);
    expect(a.salt_b64).not.toBe(b.salt_b64);
    // Both verify against the same bearer.
    expect(await verifyBearerToken('same-bearer', a)).toBe(true);
    expect(await verifyBearerToken('same-bearer', b)).toBe(true);
  });

  it('TOKEN_ARGON2_PARAMS uses tighter cost than user-password defaults', () => {
    expect(TOKEN_ARGON2_PARAMS.t).toBe(2);
    expect(TOKEN_ARGON2_PARAMS.m).toBe(32 * 1024);
    expect(TOKEN_ARGON2_PARAMS.p).toBe(2);
  });

  it('verifyBearerToken returns false (not throws) on malformed record', async () => {
    const malformed = { hash_b64: 'not-base64!!!', salt_b64: 'AAAA', params: FAST_ARGON2 };
    expect(await verifyBearerToken('whatever', malformed)).toBe(false);
  });
});

describe('D-148 P1 — generateBearerToken', () => {
  it('produces high-entropy base64 tokens', () => {
    const a = generateBearerToken();
    const b = generateBearerToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(40);
  });
});

describe('D-148 P1 — sub-DEK derivation', () => {
  it('deterministic for the same master + domain', () => {
    const master = new Uint8Array(32).fill(7);
    const a = deriveSubDEKForDomain(master, 'vault');
    const b = deriveSubDEKForDomain(master, 'vault');
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('domain-separated', () => {
    const master = new Uint8Array(32).fill(7);
    const vault = deriveSubDEKForDomain(master, 'vault');
    const audit = deriveSubDEKForDomain(master, 'server-data');
    expect(Array.from(vault)).not.toEqual(Array.from(audit));
  });
});

describe('D-148 P1 — ServerKeyStore', () => {
  it('createInMemoryServerKeyStore round-trip server_identity', () => {
    const store = createInMemoryServerKeyStore();
    expect(store.loadServerIdentityKey()).toBeNull();
    const kp = generateEd25519Keypair('server_identity_key');
    store.saveServerIdentityKey(kp);
    expect(store.loadServerIdentityKey()).toEqual(kp);
  });

  it('round-trip publisher_identity', () => {
    const store = createInMemoryServerKeyStore();
    expect(store.loadPublisherIdentityKey()).toBeNull();
    const kp = generateEd25519Keypair('publisher_identity_key');
    store.savePublisherIdentityKey(kp);
    expect(store.loadPublisherIdentityKey()).toEqual(kp);
  });

  it('rejects mismatched key_class on save (I-7 storage discipline)', () => {
    const store = createInMemoryServerKeyStore();
    const server_identity = generateEd25519Keypair('server_identity_key');
    expect(() => store.savePublisherIdentityKey(server_identity)).toThrow(
      /publisher_identity_key/,
    );
    const publisher_identity = generateEd25519Keypair('publisher_identity_key');
    expect(() => store.saveServerIdentityKey(publisher_identity)).toThrow(
      /server_identity_key/,
    );
  });
});

describe('D-148 P1 — ensureServerIdentityKeys', () => {
  it('initializes both keys on a fresh store', () => {
    const store = createInMemoryServerKeyStore();
    const { server_identity, publisher_identity } = ensureServerIdentityKeys(store);
    expect(server_identity.key_class).toBe('server_identity_key');
    expect(publisher_identity.key_class).toBe('publisher_identity_key');
    expect(store.loadServerIdentityKey()).toEqual(server_identity);
    expect(store.loadPublisherIdentityKey()).toEqual(publisher_identity);
  });

  it('preserves existing keys (idempotent)', () => {
    const store = createInMemoryServerKeyStore();
    const first = ensureServerIdentityKeys(store);
    const second = ensureServerIdentityKeys(store);
    expect(second.server_identity).toEqual(first.server_identity);
    expect(second.publisher_identity).toEqual(first.publisher_identity);
  });

  it('I-7: server + publisher identities are independently rotatable', () => {
    const store = createInMemoryServerKeyStore();
    const { server_identity: original_si, publisher_identity: original_pi } =
      ensureServerIdentityKeys(store);
    // Rotate server identity only — replace the persisted server key.
    const rotated_si = generateEd25519Keypair('server_identity_key');
    store.saveServerIdentityKey(rotated_si);
    expect(store.loadServerIdentityKey()).toEqual(rotated_si);
    expect(store.loadPublisherIdentityKey()).toEqual(original_pi);
    expect(rotated_si.public_key_fingerprint).not.toBe(original_si.public_key_fingerprint);
  });
});

describe('D-148 P1 — assertKeyTaxonomyInvariants (defense in depth)', () => {
  it('passes against the canonical KEY_CAPABILITIES table', () => {
    expect(() => assertKeyTaxonomyInvariants()).not.toThrow();
  });
});

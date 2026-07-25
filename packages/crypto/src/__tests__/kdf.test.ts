import { describe, it, expect } from 'vitest';
import {
  deriveKEKFromPassword,
  deriveKEKFromRecoveryKey,
  deriveSubDEK,
  randomBytes,
  DEFAULT_ARGON2_PARAMS,
  DERIVED_KEY_LEN,
  SALT_LEN,
} from '../kdf.js';

// Argon2 with default params is slow by design — use a tiny variant for
// these tests so the suite stays fast. The fast params still exercise
// the full code path; security posture is covered separately.
const FAST_ARGON2 = { t: 1, m: 1024, p: 1 };

describe('randomBytes', () => {
  it('returns the requested length', () => {
    expect(randomBytes(1).length).toBe(1);
    expect(randomBytes(32).length).toBe(32);
    expect(randomBytes(100).length).toBe(100);
  });

  it('is non-zero (overwhelming probability) and varies', () => {
    const a = randomBytes(32);
    const b = randomBytes(32);
    expect(Array.from(a)).not.toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(new Uint8Array(32)));
  });
});

describe('deriveKEKFromPassword', () => {
  it('returns 32 bytes', async () => {
    const salt = randomBytes(SALT_LEN);
    const kek = await deriveKEKFromPassword('test-password', salt, FAST_ARGON2);
    expect(kek.length).toBe(DERIVED_KEY_LEN);
  });

  it('is deterministic for same password + salt + params', async () => {
    const salt = randomBytes(SALT_LEN);
    const a = await deriveKEKFromPassword('pw', salt, FAST_ARGON2);
    const b = await deriveKEKFromPassword('pw', salt, FAST_ARGON2);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('different passwords → different KEKs', async () => {
    const salt = randomBytes(SALT_LEN);
    const a = await deriveKEKFromPassword('pw1', salt, FAST_ARGON2);
    const b = await deriveKEKFromPassword('pw2', salt, FAST_ARGON2);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('different salts → different KEKs (same password)', async () => {
    const a = await deriveKEKFromPassword('pw', randomBytes(SALT_LEN), FAST_ARGON2);
    const b = await deriveKEKFromPassword('pw', randomBytes(SALT_LEN), FAST_ARGON2);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('rejects empty password', async () => {
    await expect(
      deriveKEKFromPassword('', randomBytes(SALT_LEN), FAST_ARGON2),
    ).rejects.toThrow('non-empty');
  });

  it('rejects wrong-size salt', async () => {
    await expect(
      deriveKEKFromPassword('pw', new Uint8Array(8), FAST_ARGON2),
    ).rejects.toThrow('salt');
  });
});

describe('deriveKEKFromRecoveryKey', () => {
  it('returns 32 bytes', () => {
    const entropy = randomBytes(32);
    const salt = randomBytes(SALT_LEN);
    const kek = deriveKEKFromRecoveryKey(entropy, salt);
    expect(kek.length).toBe(DERIVED_KEY_LEN);
  });

  it('is deterministic', () => {
    const entropy = randomBytes(32);
    const salt = randomBytes(SALT_LEN);
    const a = deriveKEKFromRecoveryKey(entropy, salt);
    const b = deriveKEKFromRecoveryKey(entropy, salt);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('different entropy → different KEK', () => {
    const salt = randomBytes(SALT_LEN);
    const a = deriveKEKFromRecoveryKey(randomBytes(32), salt);
    const b = deriveKEKFromRecoveryKey(randomBytes(32), salt);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('rejects wrong-size entropy', () => {
    expect(() => deriveKEKFromRecoveryKey(new Uint8Array(16), randomBytes(SALT_LEN)))
      .toThrow('32 bytes');
  });
});

describe('deriveSubDEK — domain separation', () => {
  it('different domains produce different sub-DEKs from same Master DEK', () => {
    const master = randomBytes(32);
    const a = deriveSubDEK(master, 'server-data');
    const b = deriveSubDEK(master, 'blob-store');
    const c = deriveSubDEK(master, 'ext-cache');
    expect(Array.from(a)).not.toEqual(Array.from(b));
    expect(Array.from(b)).not.toEqual(Array.from(c));
    expect(Array.from(a)).not.toEqual(Array.from(c));
  });

  it('same domain + same master → same sub-DEK (deterministic)', () => {
    const master = randomBytes(32);
    const a = deriveSubDEK(master, 'server-data');
    const b = deriveSubDEK(master, 'server-data');
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  // D-100 — account surface joins the existing domain set
  it('account domain is distinct from other surfaces', () => {
    const master = randomBytes(32);
    const account = deriveSubDEK(master, 'account');
    expect(Array.from(account)).not.toEqual(Array.from(deriveSubDEK(master, 'vault')));
    expect(Array.from(account)).not.toEqual(Array.from(deriveSubDEK(master, 'cloud-sync')));
    expect(Array.from(account)).not.toEqual(Array.from(deriveSubDEK(master, 'server-data')));
  });

  // D-125 P2.2 — connection surface joins the existing domain set.
  // Distinct from account (the namespace it shares the wire shape with)
  // and from every other surface so a leaked sub-DEK from one tier never
  // unlocks another.
  it('connection domain is distinct from other surfaces', () => {
    const master = randomBytes(32);
    const connection = deriveSubDEK(master, 'connection');
    expect(Array.from(connection)).not.toEqual(Array.from(deriveSubDEK(master, 'account')));
    expect(Array.from(connection)).not.toEqual(Array.from(deriveSubDEK(master, 'vault')));
    expect(Array.from(connection)).not.toEqual(Array.from(deriveSubDEK(master, 'cloud-sync')));
    expect(Array.from(connection)).not.toEqual(Array.from(deriveSubDEK(master, 'server-data')));
  });

  // D-137 P1.2 — chat surface joins the existing domain set. Distinct
  // from every other surface so a leaked sub-DEK from one tier never
  // unlocks chat history (the most personal-context-dense surface in
  // the substrate).
  it('chat domain is distinct from other surfaces', () => {
    const master = randomBytes(32);
    const chat = deriveSubDEK(master, 'chat');
    expect(Array.from(chat)).not.toEqual(Array.from(deriveSubDEK(master, 'account')));
    expect(Array.from(chat)).not.toEqual(Array.from(deriveSubDEK(master, 'connection')));
    expect(Array.from(chat)).not.toEqual(Array.from(deriveSubDEK(master, 'vault')));
    expect(Array.from(chat)).not.toEqual(Array.from(deriveSubDEK(master, 'cloud-sync')));
    expect(Array.from(chat)).not.toEqual(Array.from(deriveSubDEK(master, 'server-data')));
    expect(Array.from(chat)).not.toEqual(Array.from(deriveSubDEK(master, 'blob-store')));
    expect(Array.from(chat)).not.toEqual(Array.from(deriveSubDEK(master, 'ext-cache')));
  });

  it('webhook credential domain is distinct from outbound connection auth', () => {
    const master = randomBytes(32);
    const webhooks = deriveSubDEK(master, 'webhook_secrets');
    expect(Array.from(webhooks)).not.toEqual(Array.from(deriveSubDEK(master, 'connection')));
    expect(Array.from(webhooks)).not.toEqual(Array.from(deriveSubDEK(master, 'reception')));
    expect(Array.from(webhooks)).not.toEqual(Array.from(deriveSubDEK(master, 'server-data')));
  });

  it('webhook payload domain is distinct from ingress credentials and server data', () => {
    const master = randomBytes(32);
    const payloads = deriveSubDEK(master, 'webhook_payloads');
    expect(Array.from(payloads)).not.toEqual(
      Array.from(deriveSubDEK(master, 'webhook_secrets')),
    );
    expect(Array.from(payloads)).not.toEqual(
      Array.from(deriveSubDEK(master, 'server-data')),
    );
  });
});

describe('DEFAULT_ARGON2_PARAMS — OWASP 2024 recommendation', () => {
  it('t=3, m=65536 (64 MiB), p=4', () => {
    expect(DEFAULT_ARGON2_PARAMS).toEqual({ t: 3, m: 65536, p: 4 });
  });

  it('is frozen (cannot be mutated)', () => {
    expect(Object.isFrozen(DEFAULT_ARGON2_PARAMS)).toBe(true);
  });
});

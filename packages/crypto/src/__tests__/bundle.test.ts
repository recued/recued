import { describe, it, expect } from 'vitest';
import {
  createBundle,
  openBundle,
  openBundleWithPassword,
  openBundleWithRecoveryKey,
  rotatePassword,
  rotateRecoveryKey,
  BUNDLE_VERSION,
} from '../bundle.js';

// Argon2 is deliberately slow — use tiny params for tests.
const FAST_ARGON2 = { t: 1, m: 1024, p: 1 };

describe('createBundle', () => {
  it('returns a bundle + recovery key + master DEK', async () => {
    const { bundle, recoveryKey, masterDEK } = await createBundle({
      password: 'correct horse battery staple',
      argon2: FAST_ARGON2,
    });
    expect(bundle.version).toBe(BUNDLE_VERSION);
    expect(bundle.argon2).toEqual(FAST_ARGON2);
    expect(recoveryKey.split(/\s+/).length).toBe(24);
    expect(masterDEK.length).toBe(32);
  });

  it('rejects empty password', async () => {
    await expect(createBundle({ password: '', argon2: FAST_ARGON2 }))
      .rejects.toThrow('password is required');
  });

  it('bundle carries the Argon2 params used', async () => {
    const params = { t: 2, m: 2048, p: 2 };
    const { bundle } = await createBundle({ password: 'pw', argon2: params });
    expect(bundle.argon2).toEqual(params);
  });

  it('two bundles from the same password have different wraps (fresh salts)', async () => {
    const a = await createBundle({ password: 'pw', argon2: FAST_ARGON2 });
    const b = await createBundle({ password: 'pw', argon2: FAST_ARGON2 });
    expect(a.bundle.salt_pw).not.toBe(b.bundle.salt_pw);
    expect(a.bundle.wrapped_pw).not.toBe(b.bundle.wrapped_pw);
  });
});

describe('openBundleWithPassword — happy path', () => {
  it('returns the same Master DEK that was originally generated', async () => {
    const { bundle, masterDEK } = await createBundle({ password: 'pw', argon2: FAST_ARGON2 });
    const opened = await openBundleWithPassword(bundle, 'pw');
    expect(Array.from(opened)).toEqual(Array.from(masterDEK));
  });
});

describe('openBundleWithPassword — failure modes', () => {
  it('wrong password → throws', async () => {
    const { bundle } = await createBundle({ password: 'correct', argon2: FAST_ARGON2 });
    await expect(openBundleWithPassword(bundle, 'wrong')).rejects.toThrow('decryption failed');
  });

  it('tampered wrapped_pw → throws', async () => {
    const { bundle } = await createBundle({ password: 'pw', argon2: FAST_ARGON2 });
    const mangled = { ...bundle, wrapped_pw: bundle.wrapped_pw.slice(0, -4) + 'AAAA' };
    await expect(openBundleWithPassword(mangled, 'pw')).rejects.toThrow('decryption failed');
  });

  it('unsupported bundle version → throws', async () => {
    const { bundle } = await createBundle({ password: 'pw', argon2: FAST_ARGON2 });
    const fromFuture = { ...bundle, version: 999 };
    await expect(openBundleWithPassword(fromFuture, 'pw')).rejects.toThrow('unsupported version');
  });
});

describe('openBundleWithRecoveryKey — happy path', () => {
  it('returns the same Master DEK via recovery key', async () => {
    const { bundle, recoveryKey, masterDEK } = await createBundle({ password: 'pw', argon2: FAST_ARGON2 });
    const opened = await openBundleWithRecoveryKey(bundle, recoveryKey);
    expect(Array.from(opened)).toEqual(Array.from(masterDEK));
  });

  it('accepts whitespace + case variation', async () => {
    const { bundle, recoveryKey, masterDEK } = await createBundle({ password: 'pw', argon2: FAST_ARGON2 });
    const noisy = recoveryKey.toUpperCase().split(' ').join('   ');
    const opened = await openBundleWithRecoveryKey(bundle, noisy);
    expect(Array.from(opened)).toEqual(Array.from(masterDEK));
  });
});

describe('openBundleWithRecoveryKey — failure modes', () => {
  it('wrong recovery key → throws', async () => {
    const { bundle } = await createBundle({ password: 'pw', argon2: FAST_ARGON2 });
    const garbage = Array(24).fill('abandon').join(' '); // valid BIP39 structure but wrong key
    await expect(openBundleWithRecoveryKey(bundle, garbage)).rejects.toThrow();
  });

  it('malformed mnemonic → throws at parse', async () => {
    const { bundle } = await createBundle({ password: 'pw', argon2: FAST_ARGON2 });
    await expect(openBundleWithRecoveryKey(bundle, 'not a mnemonic')).rejects.toThrow('invalid mnemonic');
  });
});

describe('openBundle — convenience wrapper', () => {
  it('opens via password when provided', async () => {
    const { bundle, masterDEK } = await createBundle({ password: 'pw', argon2: FAST_ARGON2 });
    const opened = await openBundle(bundle, { password: 'pw' });
    expect(Array.from(opened)).toEqual(Array.from(masterDEK));
  });

  it('opens via recoveryKey when provided', async () => {
    const { bundle, recoveryKey, masterDEK } = await createBundle({ password: 'pw', argon2: FAST_ARGON2 });
    const opened = await openBundle(bundle, { recoveryKey });
    expect(Array.from(opened)).toEqual(Array.from(masterDEK));
  });

  it('rejects when neither provided', async () => {
    const { bundle } = await createBundle({ password: 'pw', argon2: FAST_ARGON2 });
    await expect(openBundle(bundle, {})).rejects.toThrow('password, recoveryKey');
  });
});

describe('rotatePassword', () => {
  it('old password stops working, new one opens the bundle', async () => {
    const { bundle, masterDEK } = await createBundle({ password: 'old', argon2: FAST_ARGON2 });
    const rotated = await rotatePassword(bundle, 'old', 'new', { argon2: FAST_ARGON2 });

    await expect(openBundleWithPassword(rotated, 'old')).rejects.toThrow('decryption failed');
    const opened = await openBundleWithPassword(rotated, 'new');
    expect(Array.from(opened)).toEqual(Array.from(masterDEK));
  });

  it('recovery key still works after password rotation', async () => {
    const { bundle, recoveryKey, masterDEK } = await createBundle({ password: 'old', argon2: FAST_ARGON2 });
    const rotated = await rotatePassword(bundle, 'old', 'new', { argon2: FAST_ARGON2 });
    const opened = await openBundleWithRecoveryKey(rotated, recoveryKey);
    expect(Array.from(opened)).toEqual(Array.from(masterDEK));
  });

  it('wrong old password → throws, no rotation happens', async () => {
    const { bundle } = await createBundle({ password: 'old', argon2: FAST_ARGON2 });
    await expect(rotatePassword(bundle, 'wrong', 'new', { argon2: FAST_ARGON2 }))
      .rejects.toThrow('decryption failed');
  });

  it('updated_at bumps', async () => {
    const t0 = 1_000_000;
    const t1 = 2_000_000;
    const { bundle } = await createBundle({ password: 'old', argon2: FAST_ARGON2, now: () => t0 });
    const rotated = await rotatePassword(bundle, 'old', 'new', { argon2: FAST_ARGON2, now: () => t1 });
    expect(rotated.updated_at).toBe(t1);
    expect(rotated.updated_at).toBeGreaterThan(bundle.updated_at);
  });

  it('rejects empty new password', async () => {
    const { bundle } = await createBundle({ password: 'old', argon2: FAST_ARGON2 });
    await expect(rotatePassword(bundle, 'old', '', { argon2: FAST_ARGON2 }))
      .rejects.toThrow('newPassword');
  });
});

describe('rotateRecoveryKey', () => {
  it('old recovery key stops working, new one opens', async () => {
    const { bundle, recoveryKey: oldKey } = await createBundle({ password: 'pw', argon2: FAST_ARGON2 });
    const { bundle: rotated, recoveryKey: newKey } = await rotateRecoveryKey(bundle, 'pw');

    expect(newKey).not.toBe(oldKey);
    await expect(openBundleWithRecoveryKey(rotated, oldKey)).rejects.toThrow();

    const opened = await openBundleWithRecoveryKey(rotated, newKey);
    expect(opened.length).toBe(32);
  });

  it('password still works after recovery rotation', async () => {
    const { bundle, masterDEK } = await createBundle({ password: 'pw', argon2: FAST_ARGON2 });
    const { bundle: rotated } = await rotateRecoveryKey(bundle, 'pw');
    const opened = await openBundleWithPassword(rotated, 'pw');
    expect(Array.from(opened)).toEqual(Array.from(masterDEK));
  });
});

describe('AAD domain separation — bundle integrity', () => {
  it('swapping wrapped_pw and wrapped_rec fields fails to decrypt', async () => {
    const { bundle } = await createBundle({ password: 'pw', argon2: FAST_ARGON2 });
    const spliced = { ...bundle, wrapped_pw: bundle.wrapped_rec };
    await expect(openBundleWithPassword(spliced, 'pw')).rejects.toThrow('decryption failed');
  });
});

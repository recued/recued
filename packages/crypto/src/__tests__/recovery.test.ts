import { describe, it, expect } from 'vitest';
import {
  generateRecoveryKey,
  recoveryKeyToEntropy,
  isValidRecoveryKey,
  RECOVERY_KEY_WORD_COUNT,
} from '../recovery.js';

describe('generateRecoveryKey', () => {
  it('returns 24 words', () => {
    const { mnemonic } = generateRecoveryKey();
    const words = mnemonic.split(/\s+/);
    expect(words.length).toBe(RECOVERY_KEY_WORD_COUNT);
    expect(RECOVERY_KEY_WORD_COUNT).toBe(24);
  });

  it('returns 32 bytes of entropy (256 bits)', () => {
    const { entropy } = generateRecoveryKey();
    expect(entropy.length).toBe(32);
  });

  it('entropy matches the mnemonic (round-trip)', () => {
    const { mnemonic, entropy } = generateRecoveryKey();
    const roundTrip = recoveryKeyToEntropy(mnemonic);
    expect(Array.from(roundTrip)).toEqual(Array.from(entropy));
  });

  it('generates unique keys across calls', () => {
    const a = generateRecoveryKey();
    const b = generateRecoveryKey();
    expect(a.mnemonic).not.toBe(b.mnemonic);
  });
});

describe('recoveryKeyToEntropy — normalization', () => {
  it('accepts extra whitespace', () => {
    const { mnemonic, entropy } = generateRecoveryKey();
    const noisy = '   ' + mnemonic.split(' ').join('   ') + '   ';
    expect(Array.from(recoveryKeyToEntropy(noisy))).toEqual(Array.from(entropy));
  });

  it('accepts uppercase input', () => {
    const { mnemonic, entropy } = generateRecoveryKey();
    expect(Array.from(recoveryKeyToEntropy(mnemonic.toUpperCase()))).toEqual(Array.from(entropy));
  });
});

describe('recoveryKeyToEntropy — rejections', () => {
  it('rejects wrong word count', () => {
    expect(() => recoveryKeyToEntropy('abandon abandon abandon'))
      .toThrow('invalid mnemonic');
  });

  it('rejects non-dictionary words', () => {
    const words = Array(24).fill('notarealbipword').join(' ');
    expect(() => recoveryKeyToEntropy(words)).toThrow('invalid mnemonic');
  });

  it('rejects bad checksum', () => {
    const { mnemonic } = generateRecoveryKey();
    const words = mnemonic.split(' ');
    // Replace last word (checksum depends on it) with something that won't checksum
    words[words.length - 1] = 'abandon';
    const tampered = words.join(' ');
    // Either invalid checksum or invalid (we don't control which branch BIP39 hits)
    expect(() => recoveryKeyToEntropy(tampered)).toThrow();
  });
});

describe('isValidRecoveryKey', () => {
  it('true for a freshly generated key', () => {
    const { mnemonic } = generateRecoveryKey();
    expect(isValidRecoveryKey(mnemonic)).toBe(true);
  });

  it('false for garbage', () => {
    expect(isValidRecoveryKey('not a valid mnemonic')).toBe(false);
  });

  it('false for empty string', () => {
    expect(isValidRecoveryKey('')).toBe(false);
  });
});

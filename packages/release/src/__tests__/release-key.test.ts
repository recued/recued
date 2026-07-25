import { describe, expect, it } from 'vitest';
import {
  assertReleaseKeyValid,
  releaseKeyStatus,
  ReleaseKeyError,
  signingKeyMatchesPin,
} from '../release-key.js';
import { generateKeypair, publicKeyFromSeed } from '../minisign.js';

describe('releaseKeyStatus', () => {
  it('empty pin is the honest pre-GA state (not pinned, not valid)', () => {
    expect(releaseKeyStatus('')).toEqual({ pinned: false, valid: false });
  });

  it('a well-formed pin is pinned + valid', () => {
    const kp = generateKeypair();
    expect(releaseKeyStatus(kp.publicKeyText)).toEqual({ pinned: true, valid: true });
  });

  it('a non-empty but malformed pin is pinned but NOT valid', () => {
    expect(releaseKeyStatus('untrusted comment: x\nnot-base64-key!!')).toEqual({
      pinned: true,
      valid: false,
    });
  });
});

describe('assertReleaseKeyValid', () => {
  it('allows an empty pin (pre-GA verifiers fail closed on their own)', () => {
    expect(() => assertReleaseKeyValid('')).not.toThrow();
  });

  it('allows a well-formed pin', () => {
    const kp = generateKeypair();
    expect(() => assertReleaseKeyValid(kp.publicKeyText)).not.toThrow();
  });

  it('throws on a non-empty malformed pin (deploy mistake, fail closed)', () => {
    expect(() => assertReleaseKeyValid('garbage')).toThrow(ReleaseKeyError);
  });
});

describe('publicKeyFromSeed', () => {
  it('derives the same pubkey the keypair generated', () => {
    const kp = generateKeypair();
    expect(publicKeyFromSeed(kp.secretSeed, kp.keyId)).toBe(kp.publicKeyText);
  });
});

describe('signingKeyMatchesPin', () => {
  it('true when the secret derives to the pinned pubkey', () => {
    const kp = generateKeypair();
    expect(signingKeyMatchesPin(kp.secretSeed, kp.keyId, kp.publicKeyText)).toBe(true);
  });

  it('false for a different key (wrong-key publish guard)', () => {
    const a = generateKeypair();
    const b = generateKeypair();
    expect(signingKeyMatchesPin(a.secretSeed, a.keyId, b.publicKeyText)).toBe(false);
  });

  it('false when the key id differs even if the key body matches', () => {
    const kp = generateKeypair();
    const otherId = generateKeypair().keyId;
    const samePubDifferentId = publicKeyFromSeed(kp.secretSeed, otherId);
    expect(signingKeyMatchesPin(kp.secretSeed, kp.keyId, samePubDifferentId)).toBe(false);
  });

  it('false on a malformed pin', () => {
    const kp = generateKeypair();
    expect(signingKeyMatchesPin(kp.secretSeed, kp.keyId, 'nonsense')).toBe(false);
  });
});

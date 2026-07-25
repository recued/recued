/** Recovery-check crypto round-trip — derive KEK + build check + verify
 *  check, all over the real PBKDF2 + AES-GCM stack so the lifted
 *  module's wire shape is exercised end-to-end. */

import { describe, it, expect } from 'vitest';
import {
  deriveKekFromRecoveryKey,
  buildRecoveryKeyCheck,
  verifyRecoveryKeyCheck,
} from '../account/recovery-check-crypto.js';

const KEY =
  'abandon ability able about above absent absorb abstract absurd abuse access accident ' +
  'account accuse achieve acid acoustic acquire across act action actor actress actual';

describe('recovery-check-crypto round-trip', () => {
  it('a check built with KEK_a verifies under KEK_a', async () => {
    const kek = await deriveKekFromRecoveryKey(KEY);
    const check = await buildRecoveryKeyCheck(kek);
    expect(await verifyRecoveryKeyCheck(kek, check)).toBe(true);
  });

  it('a check built with KEK_a does NOT verify under KEK_b (different key)', async () => {
    const kekA = await deriveKekFromRecoveryKey(KEY);
    const otherKey =
      'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo ' +
      'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
    const kekB = await deriveKekFromRecoveryKey(otherKey);
    const check = await buildRecoveryKeyCheck(kekA);
    expect(await verifyRecoveryKeyCheck(kekB, check)).toBe(false);
  });

  it('normalizes whitespace + case so trivially-different entries derive the same KEK', async () => {
    const k1 = await deriveKekFromRecoveryKey(KEY);
    const k2 = await deriveKekFromRecoveryKey(`  ${KEY.toUpperCase()}  `);
    const check = await buildRecoveryKeyCheck(k1);
    // Verify under k2 — if the normalization differs, this would fail
    // because deriveKey would yield a different KEK.
    expect(await verifyRecoveryKeyCheck(k2, check)).toBe(true);
  });

  it('verifyRecoveryKeyCheck returns false (never throws) on malformed input', async () => {
    const kek = await deriveKekFromRecoveryKey(KEY);
    expect(await verifyRecoveryKeyCheck(kek, 'not-json')).toBe(false);
    expect(await verifyRecoveryKeyCheck(kek, '{}')).toBe(false);
    expect(await verifyRecoveryKeyCheck(kek, '{"ciphertext":42}')).toBe(false);
    expect(await verifyRecoveryKeyCheck(kek, '')).toBe(false);
  });
});

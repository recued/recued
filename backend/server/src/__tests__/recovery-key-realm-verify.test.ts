/** M1 slice 2 — read-only `verifyRecoveryKeyAgainstRealm` (the Q2 gate's
 *  realm-ownership primitive). Enrolls a realm, then checks match /
 *  mismatch / not_enrolled WITHOUT ever mutating the store. */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { generateRecoveryKey } from '@recued/crypto';
import { createRecoveryKeyCheckStore } from '../recovery-key-store.js';
import {
  processRecoveryKey,
  verifyRecoveryKeyAgainstRealm,
} from '../recovery-key-processor.js';

const freshStore = () => createRecoveryKeyCheckStore(new Database(':memory:'));

describe('verifyRecoveryKeyAgainstRealm', () => {
  it('returns not_enrolled when the realm has no stored check', async () => {
    const { mnemonic } = generateRecoveryKey();
    expect(await verifyRecoveryKeyAgainstRealm(freshStore(), mnemonic)).toBe('not_enrolled');
  });

  it('returns match for the enrolled key, mismatch for a different one', async () => {
    const store = freshStore();
    const { mnemonic: enrolled } = generateRecoveryKey();
    const { mnemonic: other } = generateRecoveryKey();
    const r = await processRecoveryKey(store, enrolled); // first call binds the realm
    expect(r).toMatchObject({ ok: true, outcome: 'enrolled' });

    expect(await verifyRecoveryKeyAgainstRealm(store, enrolled)).toBe('match');
    expect(await verifyRecoveryKeyAgainstRealm(store, other)).toBe('mismatch');
  });

  it('never mutates the store (a verify does not enroll)', async () => {
    const store = freshStore();
    const { mnemonic } = generateRecoveryKey();
    // Verifying against an un-enrolled realm must NOT bind it.
    expect(await verifyRecoveryKeyAgainstRealm(store, mnemonic)).toBe('not_enrolled');
    expect(store.exists()).toBe(false);
    expect(await verifyRecoveryKeyAgainstRealm(store, mnemonic)).toBe('not_enrolled');
  });

  it('treats an invalid mnemonic as mismatch (no throw)', async () => {
    const store = freshStore();
    const { mnemonic } = generateRecoveryKey();
    await processRecoveryKey(store, mnemonic);
    expect(await verifyRecoveryKeyAgainstRealm(store, 'not a real recovery phrase')).toBe('mismatch');
  });
});

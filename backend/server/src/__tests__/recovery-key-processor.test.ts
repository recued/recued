/** Server-side recovery-key enrollment + verification tests.
 *
 *  Each test exercises the processor against a fresh in-memory SQLite
 *  store. Three real BIP39 mnemonics are used: KEY_A (the realm's
 *  "right" key), KEY_B (a different valid mnemonic — should fail
 *  verification), and INVALID (broken checksum — caught by the BIP39
 *  parser). */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { generateRecoveryKey } from '@recued/crypto';
import {
  createRecoveryKeyCheckStore,
  type RecoveryKeyCheckStore,
} from '../recovery-key-store.js';
import { processRecoveryKey } from '../recovery-key-processor.js';

// Two distinct, real 24-word BIP39 mnemonics. Generated at module load
// so their checksums are valid (server-side parser enforces BIP39).
const KEY_A = generateRecoveryKey().mnemonic;
let KEY_B = generateRecoveryKey().mnemonic;
// Vanishingly unlikely they collide, but be defensive.
while (KEY_B === KEY_A) KEY_B = generateRecoveryKey().mnemonic;
// Three words → wrong word count → rejected by BIP39 parser.
const INVALID = 'abandon abandon abandon';

let db: Database.Database;
let store: RecoveryKeyCheckStore;

beforeEach(() => {
  db = new Database(':memory:');
  store = createRecoveryKeyCheckStore(db);
});

describe('processRecoveryKey — first call (enrollment)', () => {
  it('returns enrolled when no prior check exists, and persists the blob', async () => {
    expect(store.exists()).toBe(false);
    const result = await processRecoveryKey(store, KEY_A);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe('enrolled');
    expect(store.exists()).toBe(true);
    expect(store.read()).not.toBeNull();
  });

  it('rejects an invalid mnemonic before touching the store', async () => {
    const result = await processRecoveryKey(store, INVALID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid');
    expect(store.exists()).toBe(false);
  });
});

describe('processRecoveryKey — verification', () => {
  it('verifies the same key matches an existing enrollment', async () => {
    await processRecoveryKey(store, KEY_A);
    const result = await processRecoveryKey(store, KEY_A);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe('verified');
  });

  it('rejects a different valid mnemonic with mismatch (no rewrite)', async () => {
    await processRecoveryKey(store, KEY_A);
    const blobBefore = store.read();
    const result = await processRecoveryKey(store, KEY_B);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('mismatch');
    // Crucially: the original check is preserved. Mismatch never overwrites.
    expect(store.read()).toBe(blobBefore);
  });

  it('rejects an invalid mnemonic on verify too', async () => {
    await processRecoveryKey(store, KEY_A);
    const blobBefore = store.read();
    const result = await processRecoveryKey(store, INVALID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid');
    expect(store.read()).toBe(blobBefore);
  });

  it('round-trip works after re-instantiating the store (persistence)', async () => {
    await processRecoveryKey(store, KEY_A);
    // Recreate the store on the same db — simulates server restart.
    const store2 = createRecoveryKeyCheckStore(db);
    const result = await processRecoveryKey(store2, KEY_A);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe('verified');
  });

  it('mismatch surfaces a non-leaky message (no implementation hints)', async () => {
    await processRecoveryKey(store, KEY_A);
    const result = await processRecoveryKey(store, KEY_B);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/does not match/i);
    // Should NOT mention the underlying primitive (AEAD / KDF / sentinel).
    expect(result.message).not.toMatch(/AEAD|KDF|sentinel|cipher/i);
  });
});

describe('store — primitive ops', () => {
  it('clear removes the row and exists flips back to false', async () => {
    await processRecoveryKey(store, KEY_A);
    expect(store.exists()).toBe(true);
    store.clear();
    expect(store.exists()).toBe(false);
    expect(store.read()).toBeNull();
  });

  it('clear is idempotent', async () => {
    store.clear();
    store.clear();
    expect(store.exists()).toBe(false);
  });

  it('after clear, processRecoveryKey enrolls fresh — even with the previous KEY_A', async () => {
    await processRecoveryKey(store, KEY_A);
    store.clear();
    const result = await processRecoveryKey(store, KEY_A);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe('enrolled');
  });

  it('after clear, a different key can enroll — the realm rebinds', async () => {
    await processRecoveryKey(store, KEY_A);
    store.clear();
    const result = await processRecoveryKey(store, KEY_B);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe('enrolled');
    // Now KEY_A should fail.
    const result2 = await processRecoveryKey(store, KEY_A);
    expect(result2.ok).toBe(false);
  });
});

/** Recovery-check storage tests — read/write/has/clear round-trips
 *  over an in-memory RecoveryCheckStorage. Ported from
 *  `apps/extension/src/recovery/__tests__/store.test.ts` at `c222acac^`. */

import { describe, it, expect } from 'vitest';
import {
  readRecoveryCheck,
  hasRecoveryCheck,
  writeRecoveryCheck,
  clearRecoveryCheck,
  RECOVERY_CHECK_KEY,
  type RecoveryCheckStorage,
} from '../account/recovery-check-store.js';

const mkStorage = (): RecoveryCheckStorage & { _backing: Map<string, unknown> } => {
  const backing = new Map<string, unknown>();
  return {
    _backing: backing,
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const k of keys) if (backing.has(k)) out[k] = backing.get(k);
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) backing.set(k, v);
    },
    async remove(keys) {
      for (const k of keys) backing.delete(k);
    },
  };
};

describe('recovery check storage', () => {
  it('returns null + hasRecoveryCheck=false on a fresh store', async () => {
    const storage = mkStorage();
    expect(await readRecoveryCheck(storage)).toBeNull();
    expect(await hasRecoveryCheck(storage)).toBe(false);
  });

  it('writes and reads back under RECOVERY_CHECK_KEY', async () => {
    const storage = mkStorage();
    const blob = '{"ciphertext":"abc","iv":"def"}';
    await writeRecoveryCheck(storage, blob);
    expect(storage._backing.get(RECOVERY_CHECK_KEY)).toBe(blob);
    expect(await readRecoveryCheck(storage)).toBe(blob);
    expect(await hasRecoveryCheck(storage)).toBe(true);
  });

  it('clear is idempotent + flips hasRecoveryCheck back to false', async () => {
    const storage = mkStorage();
    await writeRecoveryCheck(storage, 'blob');
    await clearRecoveryCheck(storage);
    expect(await hasRecoveryCheck(storage)).toBe(false);
    // No-op second clear.
    await clearRecoveryCheck(storage);
    expect(await hasRecoveryCheck(storage)).toBe(false);
  });

  it('swallows read errors and reports "not enrolled" rather than throwing', async () => {
    const broken: RecoveryCheckStorage = {
      async get() { throw new Error('idb exploded'); },
      async set() {},
      async remove() {},
    };
    expect(await readRecoveryCheck(broken)).toBeNull();
    expect(await hasRecoveryCheck(broken)).toBe(false);
  });

  it('ignores non-string values gracefully', async () => {
    const storage = mkStorage();
    storage._backing.set(RECOVERY_CHECK_KEY, 42); // corrupt type
    expect(await readRecoveryCheck(storage)).toBeNull();
    expect(await hasRecoveryCheck(storage)).toBe(false);
  });
});

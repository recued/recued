/** Ephemeral verification state for auth.migrate.prepare.
 *
 *  prepare() generates a bundle + Master DEK + recovery key, holds them
 *  here under a random verificationId, and returns the id to the caller.
 *  commit() looks up the id, uses the pre-computed material, and saves
 *  the bundle only on success.
 *
 *  Never persisted. A crash wipes the map — operator must call prepare
 *  again. This is correct: no crypto state should survive a server
 *  restart in the prepare phase.
 */

import type { Bundle } from '@recued/crypto';
import { randomBytes } from '@recued/crypto';

export interface VerificationEntry {
  bundle: Bundle;
  masterDEK: Uint8Array;
  recoveryKey: string;
  password: string;  // kept so commit's password-recheck can be validated
  expiresAt: number;
}

export interface VerificationStore {
  put(entry: Omit<VerificationEntry, 'expiresAt'>, ttlMs: number): string;
  take(id: string): VerificationEntry | null;
  /** Remove expired entries. Called by commit handler + periodic sweep. */
  sweep(): number;
  size(): number;
}

const bytesToHex = (b: Uint8Array): string =>
  Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');

export const createVerificationStore = (now: () => number = () => Date.now()): VerificationStore => {
  const map = new Map<string, VerificationEntry>();

  return {
    put(entry, ttlMs) {
      const id = 'v1_' + bytesToHex(randomBytes(16));
      map.set(id, { ...entry, expiresAt: now() + ttlMs });
      return id;
    },

    take(id) {
      const entry = map.get(id);
      if (!entry) return null;
      map.delete(id);
      if (entry.expiresAt < now()) {
        // Expired — wipe DEK and return null.
        entry.masterDEK.fill(0);
        return null;
      }
      return entry;
    },

    sweep() {
      const t = now();
      let swept = 0;
      for (const [id, entry] of map.entries()) {
        if (entry.expiresAt < t) {
          entry.masterDEK.fill(0);
          map.delete(id);
          swept++;
        }
      }
      return swept;
    },

    size() {
      return map.size;
    },
  };
};

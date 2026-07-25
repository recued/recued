import { scopedVaultKey } from '@recued/contracts';
import type { Collection, EncryptedEntry } from './types.js';
import { encrypt, decrypt } from './crypto.js';

/** A publisher-scoped vault store. Wraps a Collection<EncryptedEntry> with envelope crypto.
 *
 *  Storage layout: keys are stored as `vault.{publisher_id}.{key}` (per D-036).
 *  Values are AES-256-GCM encrypted under the active DEK.
 */
export interface VaultStore {
  set(publisher: string, key: string, value: string): Promise<void>;
  get(publisher: string, key: string): Promise<string | null>;
  has(publisher: string, key: string): Promise<boolean>;
  delete(publisher: string, key: string): Promise<void>;
  /** All entries for a single publisher. Returns decrypted values. */
  listByPublisher(publisher: string): Promise<Array<{ key: string; value: string }>>;
  /** Delete all entries for a publisher. Used during uninstall orphan cleanup. */
  deleteByPublisher(publisher: string): Promise<number>;
}

/** D-103: thrown by `set` when a quota limit would be exceeded. Surface
 *  this at the rpc boundary as `QUOTA_EXCEEDED`. */
export class VaultQuotaExceededError extends Error {
  constructor(
    public readonly scope: 'publisher' | 'total',
    public readonly current: number,
    public readonly limit: number,
    public readonly publisher?: string,
  ) {
    super(
      scope === 'publisher'
        ? `quota_exceeded: publisher '${publisher}' would reach ${current} bytes (limit ${limit})`
        : `quota_exceeded: vault total would reach ${current} bytes (limit ${limit})`,
    );
    this.name = 'VaultQuotaExceededError';
  }
}

export interface VaultQuotaOptions {
  /** Per-publisher byte ceiling (summed across that publisher's keys).
   *  Omit for no per-publisher cap. */
  perPublisherBytes?: number;
  /** Absolute byte ceiling across every publisher. Omit for no total
   *  cap. */
  totalBytes?: number;
}

export interface CreateVaultStoreOptions {
  /** D-103 quotas. When either is set, `set` performs a pre-write size
   *  check and rejects with `VaultQuotaExceededError` if the new total
   *  would cross the limit. */
  quotas?: VaultQuotaOptions;
  /** Phase B gate hook. Every `set` / `delete` / `deleteByPublisher`
   *  reports the signed plaintext-byte delta so the `vault` surface gate
   *  stays aligned with live usage. Exceptions thrown by the sink are
   *  swallowed — a misbehaving gate must not break credential writes. */
  onBytesChanged?: (delta: number) => void;
}

/** Create a vault store backed by an underlying Collection and an active DEK. */
export const createVaultStore = (
  collection: Collection<EncryptedEntry>,
  dek: CryptoKey,
  options: CreateVaultStoreOptions = {},
): VaultStore => {
  const onBytesChanged = options.onBytesChanged;
  const reportDelta = (delta: number): void => {
    if (!onBytesChanged || delta === 0) return;
    try { onBytesChanged(delta); } catch (_err) { /* never break writes */ }
  };

  return {
    async set(publisher, key, value) {
      let delta: number | null = null;
      if (options.quotas) {
        delta = await computeDelta(collection, dek, publisher, key, value);
        if (options.quotas.perPublisherBytes !== undefined) {
          const current = await measurePublisher(collection, dek, publisher);
          if (current + delta > options.quotas.perPublisherBytes) {
            throw new VaultQuotaExceededError(
              'publisher',
              current + delta,
              options.quotas.perPublisherBytes,
              publisher,
            );
          }
        }
        if (options.quotas.totalBytes !== undefined) {
          const total = await measureTotal(collection, dek);
          if (total + delta > options.quotas.totalBytes) {
            throw new VaultQuotaExceededError(
              'total',
              total + delta,
              options.quotas.totalBytes,
            );
          }
        }
      }
      // If `quotas` weren't set we computed no delta above; fall back
      // to a plain delta compute so the Phase B gate stays accurate
      // regardless of whether per-publisher quotas are enforced.
      if (delta === null && onBytesChanged) {
        delta = await computeDelta(collection, dek, publisher, key, value);
      }
      const encrypted = await encrypt(dek, value);
      await collection.set(scopedVaultKey(publisher, key), encrypted);
      if (delta !== null) reportDelta(delta);
    },

    async get(publisher, key) {
      const entry = await collection.get(scopedVaultKey(publisher, key));
      if (!entry) return null;
      return decrypt(dek, entry);
    },

    async has(publisher, key) {
      return collection.has(scopedVaultKey(publisher, key));
    },

    async delete(publisher, key) {
      let freed = 0;
      if (onBytesChanged) {
        const existing = await collection.get(scopedVaultKey(publisher, key));
        if (existing) {
          try { freed = byteLen(await decrypt(dek, existing)); } catch (_err) { /* corrupted row */ }
        }
      }
      await collection.delete(scopedVaultKey(publisher, key));
      if (freed > 0) reportDelta(-freed);
    },

    async listByPublisher(publisher) {
      const prefix = `vault.${publisher}.`;
      const entries = await collection.listByPrefix(prefix);
      const results: Array<{ key: string; value: string }> = [];
      for (const { key: storageKey, value: encrypted } of entries) {
        const userKey = storageKey.slice(prefix.length);
        const decrypted = await decrypt(dek, encrypted);
        results.push({ key: userKey, value: decrypted });
      }
      return results;
    },

    async deleteByPublisher(publisher) {
      let freed = 0;
      if (onBytesChanged) {
        const entries = await collection.listByPrefix(`vault.${publisher}.`);
        for (const { value } of entries) {
          try { freed += byteLen(await decrypt(dek, value)); } catch (_err) { /* corrupted row */ }
        }
      }
      const n = await collection.deleteByPrefix(`vault.${publisher}.`);
      if (freed > 0) reportDelta(-freed);
      return n;
    },
  };
};

// ─── Quota helpers (D-103) ─────────────────────────────────────
//
// Delta: new-value-bytes minus existing-value-bytes for the same key.
// `value.length` in UTF-16 code units is close enough for quota math;
// a 10MB absolute ceiling per-value already caps the worst case.
const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8');

const computeDelta = async (
  collection: Collection<EncryptedEntry>,
  dek: CryptoKey,
  publisher: string,
  key: string,
  newValue: string,
): Promise<number> => {
  const existing = await collection.get(scopedVaultKey(publisher, key));
  if (!existing) return byteLen(newValue);
  try {
    const prev = await decrypt(dek, existing);
    return byteLen(newValue) - byteLen(prev);
  } catch {
    return byteLen(newValue);
  }
};

const measurePublisher = async (
  collection: Collection<EncryptedEntry>,
  dek: CryptoKey,
  publisher: string,
): Promise<number> => {
  const entries = await collection.listByPrefix(`vault.${publisher}.`);
  let total = 0;
  for (const { value } of entries) {
    try { total += byteLen(await decrypt(dek, value)); } catch { /* skip corrupt */ }
  }
  return total;
};

const measureTotal = async (
  collection: Collection<EncryptedEntry>,
  dek: CryptoKey,
): Promise<number> => {
  const entries = await collection.list();
  let total = 0;
  for (const value of entries) {
    try { total += byteLen(await decrypt(dek, value)); } catch { /* skip corrupt */ }
  }
  return total;
};

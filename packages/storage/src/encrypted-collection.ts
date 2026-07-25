/** Encrypted collection wrapper.
 *
 *  Wraps an underlying Collection<EncryptedEntry> with transparent
 *  JSON serialization + AES-256-GCM encryption. Presents the same
 *  Collection<T> interface so callers don't need to change.
 *
 *  Used for platform config that contains secrets (e.g., LLM API keys)
 *  but isn't publisher-scoped like the vault. Same DEK, same crypto,
 *  different storage model.
 */

import type { Collection, EncryptedEntry } from './types.js';
import { encrypt, decrypt } from './crypto.js';

export const createEncryptedCollection = <T>(
  backing: Collection<EncryptedEntry>,
  dek: CryptoKey,
): Collection<T> => ({
  async get(key) {
    const entry = await backing.get(key);
    if (!entry) return null;
    const json = await decrypt(dek, entry);
    return JSON.parse(json) as T;
  },

  async set(key, value) {
    const json = JSON.stringify(value);
    const entry = await encrypt(dek, json);
    await backing.set(key, entry);
  },

  async delete(key) {
    await backing.delete(key);
  },

  async has(key) {
    return backing.has(key);
  },

  async list() {
    const entries = await backing.list();
    const results: T[] = [];
    for (const entry of entries) {
      const json = await decrypt(dek, entry);
      results.push(JSON.parse(json) as T);
    }
    return results;
  },

  async listKeys() {
    return backing.listKeys();
  },

  async listByPrefix(prefix) {
    const entries = await backing.listByPrefix(prefix);
    const results: Array<{ key: string; value: T }> = [];
    for (const { key, value: entry } of entries) {
      const json = await decrypt(dek, entry);
      results.push({ key, value: JSON.parse(json) as T });
    }
    return results;
  },

  async deleteByPrefix(prefix) {
    return backing.deleteByPrefix(prefix);
  },

  async clear() {
    await backing.clear();
  },

  async size() {
    return backing.size();
  },
});

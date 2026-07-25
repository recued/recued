/** A typed key-value collection. The minimal storage primitive.
 *  Concrete backends (in-memory, IndexedDB) implement this interface.
 *  Specialized stores (vault, config) wrap a Collection with extra logic.
 */
export interface Collection<V> {
  get(key: string): Promise<V | null>;
  set(key: string, value: V): Promise<void>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  list(): Promise<V[]>;
  listKeys(): Promise<string[]>;
  /** All entries whose key starts with the given prefix. */
  listByPrefix(prefix: string): Promise<Array<{ key: string; value: V }>>;
  /** Delete all entries whose key starts with the given prefix. Returns count deleted. */
  deleteByPrefix(prefix: string): Promise<number>;
  clear(): Promise<void>;
  size(): Promise<number>;
}

/** Encrypted entry shape — the form vault and llm-slot values take in storage. */
export interface EncryptedEntry {
  ciphertext: string;   // base64
  iv: string;           // base64 (96-bit AES-GCM nonce)
  created_at: number;
  updated_at: number;
}

/** Config entry — a single user variable override for a recipe.
 *  Stored under composite key `${recipe_id}::${key}` in the underlying Collection.
 */
export interface ConfigEntry {
  recipe_id: string;
  key: string;
  value: unknown;
  set_at: number;
}

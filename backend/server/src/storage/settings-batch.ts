type SettingReader = <T>(key: string, fallback: T) => T;
export type SettingsBatchReader<Key extends string> = <T extends Record<string, unknown>>(this: Record<Key, SettingReader>, fallbacks: T) => T;

/** Read related settings without retaining a cache. Custom readers and failed
 * queries keep their point path; JSON is decoded in requested-key order. */
export const createSettingsBatch = <Key extends string>(reader: Key, native: SettingReader,
  load: (keys: readonly string[]) => Array<{ key: string; value: string }>): SettingsBatchReader<Key> => {
  return function settings<T extends Record<string, unknown>>(this: Record<Key, SettingReader>, fallbacks: T): T {
    const keys = Object.keys(fallbacks); if (!keys.length) return {} as T;
    const points = (): T => Object.fromEntries(keys.map(key => [key, this[reader](key, fallbacks[key])])) as T;
    let useNative = false;
    try { useNative = Object.getOwnPropertyDescriptor(this, reader)?.value === native; } catch { /* Retain the custom reader. */ }
    if (!useNative) return points();
    const values = new Map<string, string>();
    try {
      for (let offset = 0; offset < keys.length; offset += 200) {
        for (const row of load(keys.slice(offset, offset + 200))) values.set(row.key, row.value);
      }
    } catch { return points(); }
    return Object.fromEntries(keys.map(key => {
      const value = values.get(key); return [key, value === undefined ? fallbacks[key] : JSON.parse(value)];
    })) as T;
  };
};

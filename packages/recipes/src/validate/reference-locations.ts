import type { AuthoringReferenceSpan } from '@recued/contracts';

export const referencePath = (path: readonly (string | number)[]): string => path.reduce<string>((out, key) => typeof key === 'number'
  ? `${out}[${key}]` : /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${out}${out ? '.' : ''}${key}` : `${out}[${JSON.stringify(key)}]`, '');
interface StringEntry {
  start: number; end: number; encoded: string; path: string; precise: boolean; target: 'key' | 'value'; decoded?: Uint32Array;
}
export interface ReferenceLocation { path: string; reference_span?: AuthoringReferenceSpan }

/** Map existing validator regex matches without changing their JSON-serialized grammar. */
export const referenceLocations = (input: unknown, serialized: string) => {
  const entries: StringEntry[] = [];
  const pending: { value: unknown; path: string; precise: boolean; target: 'key' | 'value' }[] = [{ value: input, path: '', precise: true, target: 'value' }];
  const childPath = (path: string, precise: boolean, key: string | number) => {
    if (!precise || (typeof key === 'string' && path.length + key.length > 512)) return { path, precise: false };
    const suffix = referencePath([key]);
    const next = path + (path && !suffix.startsWith('[') ? '.' : '') + suffix;
    return next.length <= 512 ? { path: next, precise: true } : { path, precise: false };
  };
  let cursor = 0, visited = 0;
  while (pending.length) {
    if (++visited > serialized.length * 2 + 1) { entries.length = 0; break; }
    const { value, path, precise, target } = pending.pop()!;
    if (typeof value === 'string') {
      const encoded = JSON.stringify(value), start = serialized.indexOf(encoded, cursor);
      if (start < 0) { entries.length = 0; break; }
      entries.push({ start, end: start + encoded.length, encoded, path, precise, target }); cursor = start + encoded.length;
    } else if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) pending.push({ value: value[i], ...childPath(path, precise, i), target: 'value' });
    } else if (value !== null && typeof value === 'object') {
      // Custom serializers/accessors are not JSON source. Decline precision rather than guess.
      const prototype = Object.getPrototypeOf(value);
      const converters = [Object.getOwnPropertyDescriptor(value, 'toJSON'), prototype && Object.getOwnPropertyDescriptor(prototype, 'toJSON')];
      if ((prototype && Object.getPrototypeOf(prototype) !== null)
        || converters.some(descriptor => descriptor && (!('value' in descriptor) || typeof descriptor.value === 'function'))) { entries.length = 0; break; }
      const keys = Object.keys(value);
      for (let i = keys.length - 1; i >= 0; i--) {
        const key = keys[i]!, descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor)) { entries.length = 0; pending.length = 0; break; }
        const child: unknown = descriptor.value;
        if (child === undefined || typeof child === 'function' || typeof child === 'symbol') continue;
        const location = childPath(path, precise, key);
        pending.push({ value: child, ...location, target: 'value' }, { value: key, ...location, target: 'key' });
      }
    }
  }
  return (offset: number, length: number): ReferenceLocation | undefined => {
    let low = 0, high = entries.length;
    while (low < high) { const mid = (low + high) >>> 1; if (entries[mid]!.start <= offset) low = mid + 1; else high = mid; }
    const entry = entries[low - 1];
    if (!entry || offset <= entry.start || offset + length >= entry.end) return;
    if (!entry.precise) return { path: entry.path };
    if (!entry.decoded) {
      const decoded = new Uint32Array(entry.encoded.length + 1);
      let character = 0;
      for (let i = 1; i < entry.encoded.length - 1;) {
        const count = entry.encoded[i] === '\\' ? entry.encoded[i + 1] === 'u' ? 6 : 2 : 1;
        for (let k = 0; k < count; k++) decoded[i + k] = character;
        i += count; decoded[i] = ++character;
      }
      entry.decoded = decoded;
    }
    const start = entry.decoded[offset - entry.start]!, end = entry.decoded[offset + length - entry.start]!;
    return { path: entry.path, reference_span: { offset: start, length: end - start, target: entry.target } };
  };
};

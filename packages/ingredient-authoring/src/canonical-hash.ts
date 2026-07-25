const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const canonicalize = (value: unknown): string => {
  if (value === undefined) {
    throw new TypeError('canonicalize: top-level undefined is invalid');
  }
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('canonicalize: non-finite number');
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`canonicalize: unsupported type ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => (
      entry === undefined ? 'null' : canonicalize(entry)
    )).join(',')}]`;
  }
  if (!isPlainObject(value)) {
    throw new TypeError('canonicalize: expected plain JSON-compatible object');
  }
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(',')}}`;
};

const toHex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

export const canonicalHash = async (value: unknown): Promise<string> => {
  const bytes = new TextEncoder().encode(canonicalize(value));
  return toHex(await crypto.subtle.digest('SHA-256', bytes));
};

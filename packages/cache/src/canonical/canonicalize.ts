export class CanonicalizationError extends Error {
  readonly path: string;
  constructor(message: string, path: string = '$') {
    super(`canonicalize: ${message} (at ${path})`);
    this.name = 'CanonicalizationError';
    this.path = path;
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

const escapeString = (s: string): string => {
  const normalized = s.normalize('NFC');
  let out = '"';
  for (let i = 0; i < normalized.length; i++) {
    const code = normalized.charCodeAt(i);
    const ch = normalized[i];
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20) out += '\\u' + code.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
};

const encodeNumber = (n: number, path: string): string => {
  if (Number.isNaN(n)) throw new CanonicalizationError('NaN is not serializable', path);
  if (!Number.isFinite(n)) throw new CanonicalizationError('Infinity is not serializable', path);
  if (Object.is(n, -0)) return '0';
  return String(n);
};

const walk = (value: unknown, path: string, seen: WeakSet<object>): string => {
  if (value === null) return 'null';

  const t = typeof value;

  if (t === 'string') return escapeString(value as string);
  if (t === 'number') return encodeNumber(value as number, path);
  if (t === 'boolean') return value ? 'true' : 'false';

  if (t === 'undefined') {
    throw new CanonicalizationError('undefined is not serializable at top level or in arrays', path);
  }

  if (t === 'bigint') throw new CanonicalizationError('BigInt is not serializable', path);
  if (t === 'symbol') throw new CanonicalizationError('Symbol is not serializable', path);
  if (t === 'function') throw new CanonicalizationError('Function is not serializable', path);

  if (t !== 'object') {
    throw new CanonicalizationError(`unknown type: ${t}`, path);
  }

  if (seen.has(value as object)) {
    throw new CanonicalizationError('circular reference detected', path);
  }
  seen.add(value as object);

  try {
    if (Array.isArray(value)) {
      const parts: string[] = [];
      for (let i = 0; i < value.length; i++) {
        const childPath = `${path}[${i}]`;
        if (!Object.prototype.hasOwnProperty.call(value, i)) {
          parts.push('null');
          continue;
        }
        const item = value[i];
        if (item === undefined) {
          parts.push('null');
        } else {
          parts.push(walk(item, childPath, seen));
        }
      }
      return '[' + parts.join(',') + ']';
    }

    if (!isPlainObject(value)) {
      const ctorName = (value as object)?.constructor?.name ?? 'object';
      throw new CanonicalizationError(
        `non-plain object rejected (${ctorName}) — pass primitives, arrays, or plain objects only`,
        path,
      );
    }

    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    const parts: string[] = [];
    for (const k of keys) {
      parts.push(escapeString(k) + ':' + walk(obj[k], `${path}.${k}`, seen));
    }
    return '{' + parts.join(',') + '}';
  } finally {
    seen.delete(value as object);
  }
};

export const canonicalize = (value: unknown): string => {
  if (value === undefined) {
    throw new CanonicalizationError('undefined is not serializable at top level', '$');
  }
  return walk(value, '$', new WeakSet());
};

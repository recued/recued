import { canonicalize } from './canonicalize.js';

const toHex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

export const canonicalHash = async (value: unknown): Promise<string> => {
  const canonical = canonicalize(value);
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(digest);
};

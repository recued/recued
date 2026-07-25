/** Compute deterministic SHA-256 cache key from ingredient slug + input params.
 *  Input keys are sorted to ensure stability across calls with the same data.
 */
export const computeCacheKey = async (slug: string, input: Record<string, unknown>): Promise<string> => {
  const sortedKeys = Object.keys(input).sort();
  const stable: Record<string, unknown> = Object.create(null);
  for (const k of sortedKeys) stable[k] = input[k];
  const payload = slug + '|' + JSON.stringify(stable);

  const data = new TextEncoder().encode(payload);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
};

/** Estimate JSON-serialized size in bytes (UTF-16 chars × 2). */
export const estimateSize = (value: unknown): number => {
  try {
    return JSON.stringify(value).length * 2;
  } catch {
    return 0;
  }
};

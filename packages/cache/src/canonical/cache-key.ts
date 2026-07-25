import { canonicalHash } from './hash.js';

/** D-103: `instance_id` is no longer part of the cache key. With
 *  instance_id in the hash, two paired instances computing the same
 *  semantic result would land on different keys — the peer broadcast
 *  machinery only helps when the same input converges on the same key.
 *  The pair boundary already isolates realms from each other, so the
 *  old collision-avoidance rationale doesn't apply.
 *
 *  Old format: v1:{instance_id}:{ingredient_slug}@{manifest_version}:{hash}
 *  New format: v1:{ingredient_slug}@{manifest_version}:{hash}
 *
 *  Old-format entries expire naturally via TTL — no migration. */
export interface CacheKeyInput {
  ingredient_slug: string;
  manifest_version: string;
  inputs: Record<string, unknown>;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const VERSION_PATTERN = /^[0-9A-Za-z._-]+$/;

const assertField = (name: string, value: string, pattern: RegExp): void => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`cacheKey: ${name} must be a non-empty string`);
  }
  if (!pattern.test(value)) {
    throw new Error(`cacheKey: ${name} contains disallowed characters: ${JSON.stringify(value)}`);
  }
};

export const cacheKey = async (input: CacheKeyInput): Promise<string> => {
  assertField('ingredient_slug', input.ingredient_slug, SLUG_PATTERN);
  assertField('manifest_version', input.manifest_version, VERSION_PATTERN);

  const hash = await canonicalHash(input.inputs);
  return `v1:${input.ingredient_slug}@${input.manifest_version}:${hash}`;
};

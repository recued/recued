/** D-119 Phase 1 — bundle schema + decentralized-install helpers.
 *
 *  Phase 1 ships:
 *    - `RecipeBundle` + `BundleSignature` types
 *    - `VaultScope` + `InstallSource` discriminated unions
 *    - `deriveVaultScope` + `vaultScopeKey` helpers
 *    - `normalizeUrlForVaultScope` (with redirect-following stub)
 *    - `verifyBundleSignature` (Web Crypto wrapper, 5 result classes)
 *    - `detectVaultScopeCollision` helper
 *    - `canonicalBundleBytes` (stable JSON for signing)
 *    - `isRecipeBundle` predicate
 *
 *  Tests cover vault-key shapes, URL-normalization edge cases,
 *  signature verify happy + sad paths (5 result classes), and
 *  collision detection. No UI / no install-flow integration —
 *  Phase 2 wires these into the install paths.
 */

import { describe, expect, it } from 'vitest';

import type { IngredientManifest, RecipeDefinition } from '../index.js';
import {
  canonicalBundleBytes,
  deriveVaultScope,
  detectVaultScopeCollision,
  isRecipeBundle,
  normalizeUrlForVaultScope,
  vaultScopeKey,
  verifyBundleSignature,
  type BundleSignature,
  type RecipeBundle,
} from '../index.js';

// ────────────────────────────────────────────────────────────────
// Test fixtures
// ────────────────────────────────────────────────────────────────

const sampleRecipe: RecipeDefinition = {
  recipe_id: 'detect-deal-risk-hubspot',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Detect Deal Risk',
    description: 'Flag deals at risk of slipping.',
    author: 'recued-core',
    supported_platforms: ['hubspot'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { sidebar: [] },
};

const sampleIngredient: IngredientManifest = {
  slug: 'deal-reader-hubspot',
  name: 'Deal Reader (HubSpot)',
  description: 'Reads deal records from HubSpot.',
  author: 'recued-core',
  kind: 'http',
  category: 'data',
  risk_tier: 'read',
  input: {},
  output: {},
};

function bytesToBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

async function generateEd25519KeyPair(): Promise<{ publicKey: Uint8Array; sign: (msg: Uint8Array) => Promise<Uint8Array> }> {
  // Cast through unknown for the same reason verifyBundleSignature does
  // — contracts is lib:["ES2022"] so DOM-typed AlgorithmIdentifier isn't
  // visible. Runtime behavior is fine on Node 20+ + modern browsers.
  const algorithm = { name: 'Ed25519' } as unknown as Parameters<typeof crypto.subtle.generateKey>[0];
  const keys = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']) as { publicKey: CryptoKey; privateKey: CryptoKey };
  const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw' as 'jwk', keys.publicKey) as ArrayBuffer);
  const sign = async (msg: Uint8Array): Promise<Uint8Array> => {
    const sig = await crypto.subtle.sign(
      algorithm,
      keys.privateKey,
      msg as unknown as Parameters<typeof crypto.subtle.sign>[2],
    );
    return new Uint8Array(sig);
  };
  return { publicKey: rawPub, sign };
}

async function signBundle(bundle: RecipeBundle): Promise<{ bundle: RecipeBundle; pubkey: string }> {
  const { publicKey, sign } = await generateEd25519KeyPair();
  const data = canonicalBundleBytes(bundle);
  const sigBytes = await sign(data);
  const signature: BundleSignature = {
    algorithm: 'ed25519',
    publisher_pubkey: bytesToBase64(publicKey),
    signature: bytesToBase64(sigBytes),
  };
  return { bundle: { ...bundle, signature }, pubkey: signature.publisher_pubkey };
}

// ────────────────────────────────────────────────────────────────
// vaultScopeKey
// ────────────────────────────────────────────────────────────────

describe('vaultScopeKey', () => {
  it('marketplace → "marketplace:<publisher>/<slug>"', () => {
    expect(vaultScopeKey({ kind: 'marketplace', publisher: 'recued-core', slug: 'detect-deal-risk-hubspot' }))
      .toBe('marketplace:recued-core/detect-deal-risk-hubspot');
  });

  it('bundle-file → "bundle:/<slug>" (single leading slash, no host)', () => {
    expect(vaultScopeKey({ kind: 'bundle-file', slug: 'shared-recipe' }))
      .toBe('bundle:/shared-recipe');
  });

  it('bundle-remote verified → "bundle:<host><path>/<slug>" (no -unverified suffix)', () => {
    expect(vaultScopeKey({
      kind: 'bundle-remote',
      host: 'recipes.example.com',
      path: '/q3/contracts',
      slug: 'renewal-watcher',
      verified: true,
    })).toBe('bundle:recipes.example.com/q3/contracts/renewal-watcher');
  });

  it('bundle-remote unverified → "-unverified" suffix on the host+path segment', () => {
    expect(vaultScopeKey({
      kind: 'bundle-remote',
      host: 'recipes.example.com',
      path: '/q3/contracts',
      slug: 'renewal-watcher',
      verified: false,
    })).toBe('bundle:recipes.example.com/q3/contracts-unverified/renewal-watcher');
  });

  it('bundle-remote with empty path → "-unverified" still attaches cleanly', () => {
    expect(vaultScopeKey({
      kind: 'bundle-remote',
      host: 'x.io',
      path: '',
      slug: 'r',
      verified: false,
    })).toBe('bundle:x.io-unverified/r');
  });

  it('kitchen → "local:<slug>" (matches the existing local-fork prefix)', () => {
    expect(vaultScopeKey({ kind: 'kitchen', slug: 'my-fork' }))
      .toBe('local:my-fork');
  });
});

// ────────────────────────────────────────────────────────────────
// deriveVaultScope
// ────────────────────────────────────────────────────────────────

describe('deriveVaultScope', () => {
  it('passes marketplace through unchanged', () => {
    expect(deriveVaultScope({ kind: 'marketplace', publisher: 'acme', slug: 's' }))
      .toEqual({ kind: 'marketplace', publisher: 'acme', slug: 's' });
  });

  it('passes bundle-file through unchanged', () => {
    expect(deriveVaultScope({ kind: 'bundle-file', slug: 's' }))
      .toEqual({ kind: 'bundle-file', slug: 's' });
  });

  it('passes kitchen through unchanged', () => {
    expect(deriveVaultScope({ kind: 'kitchen', slug: 'fork' }))
      .toEqual({ kind: 'kitchen', slug: 'fork' });
  });

  it('runs bundle-remote URL through normalizeUrlForVaultScope', () => {
    const scope = deriveVaultScope({
      kind: 'bundle-remote',
      url: 'HTTPS://Recipes.Example.COM/Q3/Contracts',
      slug: 'r',
      verified: true,
    });
    expect(scope).toEqual({
      kind: 'bundle-remote',
      host: 'recipes.example.com',
      path: '/q3/contracts',
      slug: 'r',
      verified: true,
    });
  });
});

// ────────────────────────────────────────────────────────────────
// normalizeUrlForVaultScope
// ────────────────────────────────────────────────────────────────

describe('normalizeUrlForVaultScope', () => {
  it('lowercases the host', () => {
    expect(normalizeUrlForVaultScope('https://EXAMPLE.com/p').host).toBe('example.com');
  });

  it('preserves the port in the host', () => {
    expect(normalizeUrlForVaultScope('https://example.com:8443/p').host).toBe('example.com:8443');
  });

  it('strips a trailing slash on the path', () => {
    expect(normalizeUrlForVaultScope('https://x.io/foo/bar/').path).toBe('/foo/bar');
  });

  it('returns empty path for the bare-root URL', () => {
    expect(normalizeUrlForVaultScope('https://x.io/').path).toBe('');
  });

  it('collapses query characters into / segments', () => {
    expect(normalizeUrlForVaultScope('https://x.io/recipes?id=42').path).toBe('/recipes/id/42');
  });

  it('collapses hash fragments into / segments', () => {
    expect(normalizeUrlForVaultScope('https://x.io/recipes#section').path).toBe('/recipes/section');
  });

  it('preserves dot, underscore, and hyphen in path segments', () => {
    expect(normalizeUrlForVaultScope('https://x.io/v1.2/my_recipe-final').path)
      .toBe('/v1.2/my_recipe-final');
  });

  it('runs the injected redirect-follower before normalization', () => {
    const follow = (u: string) => u === 'https://short.ly/x' ? 'https://Real.Example.COM/Recipes/X' : u;
    const result = normalizeUrlForVaultScope('https://short.ly/x', follow);
    expect(result).toEqual({ host: 'real.example.com', path: '/recipes/x' });
  });

  it('uses identity follower by default (no redirects, no network)', () => {
    expect(normalizeUrlForVaultScope('https://example.com/r')).toEqual({ host: 'example.com', path: '/r' });
  });
});

// ────────────────────────────────────────────────────────────────
// verifyBundleSignature — 5 result classes
// ────────────────────────────────────────────────────────────────

describe('verifyBundleSignature', () => {
  const baseBundle: RecipeBundle = { recipe: sampleRecipe, ingredients: [sampleIngredient] };

  it('returns "unverified-not-signed" when no signature block is present', async () => {
    const result = await verifyBundleSignature(baseBundle);
    expect(result.status).toBe('unverified-not-signed');
  });

  it('returns "crypto-invalid" for a non-ed25519 algorithm', async () => {
    const bundle: RecipeBundle = {
      ...baseBundle,
      signature: {
        algorithm: 'rsa' as unknown as 'ed25519',
        publisher_pubkey: 'AA',
        signature: 'BB',
      },
    };
    const result = await verifyBundleSignature(bundle);
    expect(result.status).toBe('crypto-invalid');
  });

  it('returns "crypto-invalid" for malformed base64 in pubkey or signature', async () => {
    const bundle: RecipeBundle = {
      ...baseBundle,
      signature: { algorithm: 'ed25519', publisher_pubkey: '!!!not-base64!!!', signature: '!!!' },
    };
    const result = await verifyBundleSignature(bundle);
    expect(result.status).toBe('crypto-invalid');
  });

  it('returns "crypto-invalid" for wrong-length pubkey or signature', async () => {
    // 2-byte "pubkey" + "signature" — neither matches the ed25519 32 / 64-byte shapes.
    const bundle: RecipeBundle = {
      ...baseBundle,
      signature: { algorithm: 'ed25519', publisher_pubkey: 'AA==', signature: 'AA==' },
    };
    const result = await verifyBundleSignature(bundle);
    expect(result.status).toBe('crypto-invalid');
  });

  it('returns "verified" for a valid signature when no resolver is supplied', async () => {
    const { bundle, pubkey } = await signBundle(baseBundle);
    const result = await verifyBundleSignature(bundle);
    expect(result.status).toBe('verified');
    expect(result.publisher_pubkey).toBe(pubkey);
  });

  it('returns "verified" when the resolver reports the pubkey as known', async () => {
    const { bundle, pubkey } = await signBundle(baseBundle);
    const result = await verifyBundleSignature(bundle, { resolvePubkey: async () => 'known' });
    expect(result.status).toBe('verified');
    expect(result.publisher_pubkey).toBe(pubkey);
  });

  it('returns "unknown-pubkey" when the resolver reports the pubkey as unknown', async () => {
    const { bundle } = await signBundle(baseBundle);
    const result = await verifyBundleSignature(bundle, { resolvePubkey: async () => 'unknown' });
    expect(result.status).toBe('unknown-pubkey');
  });

  it('returns "pubkey-rotated" when the resolver reports a rotated pubkey', async () => {
    const { bundle } = await signBundle(baseBundle);
    const result = await verifyBundleSignature(bundle, { resolvePubkey: async () => 'rotated' });
    expect(result.status).toBe('pubkey-rotated');
  });

  it('returns "crypto-invalid" when the bundle is mutated after signing', async () => {
    const { bundle } = await signBundle(baseBundle);
    const tampered: RecipeBundle = {
      ...bundle,
      recipe: { ...sampleRecipe, version: 999 },
    };
    const result = await verifyBundleSignature(tampered);
    expect(result.status).toBe('crypto-invalid');
  });
});

// ────────────────────────────────────────────────────────────────
// canonicalBundleBytes — used by signer + verifier
// ────────────────────────────────────────────────────────────────

describe('canonicalBundleBytes', () => {
  it('strips the signature field from the canonical bytes', () => {
    const a: RecipeBundle = { recipe: sampleRecipe, ingredients: [sampleIngredient] };
    const b: RecipeBundle = {
      ...a,
      signature: { algorithm: 'ed25519', publisher_pubkey: 'X', signature: 'Y' },
    };
    expect(canonicalBundleBytes(a)).toEqual(canonicalBundleBytes(b));
  });

  it('is stable under top-level key reordering', () => {
    const a: RecipeBundle = { recipe: sampleRecipe, ingredients: [sampleIngredient] };
    const b: RecipeBundle = { ingredients: [sampleIngredient], recipe: sampleRecipe };
    expect(canonicalBundleBytes(a)).toEqual(canonicalBundleBytes(b));
  });
});

// ────────────────────────────────────────────────────────────────
// detectVaultScopeCollision
// ────────────────────────────────────────────────────────────────

describe('detectVaultScopeCollision', () => {
  it('returns collides:false when the scope key has no existing entry', async () => {
    const lookup = async (_k: string) => null;
    const result = await detectVaultScopeCollision('bundle:/x', 'h1', lookup);
    expect(result).toEqual({ collides: false });
  });

  it('returns collides:false when the existing hash matches (idempotent reinstall)', async () => {
    const lookup = async (_k: string) => 'h1';
    const result = await detectVaultScopeCollision('bundle:/x', 'h1', lookup);
    expect(result).toEqual({ collides: false });
  });

  it('returns collides:true with existingHash when the hashes differ', async () => {
    const lookup = async (_k: string) => 'h-old';
    const result = await detectVaultScopeCollision('bundle:/x', 'h-new', lookup);
    expect(result).toEqual({ collides: true, existingHash: 'h-old' });
  });

  it('routes the lookup through the supplied callback (key passes through unchanged)', async () => {
    let seenKey: string | null = null;
    const lookup = async (k: string) => {
      seenKey = k;
      return null;
    };
    await detectVaultScopeCollision('marketplace:acme/r', 'h', lookup);
    expect(seenKey).toBe('marketplace:acme/r');
  });
});

// ────────────────────────────────────────────────────────────────
// isRecipeBundle predicate
// ────────────────────────────────────────────────────────────────

describe('isRecipeBundle', () => {
  it('accepts a bundle with a recipe field', () => {
    expect(isRecipeBundle({ recipe: sampleRecipe })).toBe(true);
  });

  it('accepts a bundle with all optional fields populated', () => {
    expect(isRecipeBundle({
      bundle_version: 1,
      recipe: sampleRecipe,
      ingredients: [sampleIngredient],
      signature: { algorithm: 'ed25519', publisher_pubkey: 'X', signature: 'Y' },
    })).toBe(true);
  });

  it('rejects a bare recipe (no `recipe` wrapper field)', () => {
    expect(isRecipeBundle({ recipe_id: 'x', steps: [] })).toBe(false);
  });

  it('rejects inherited recipe fields', () => {
    const inherited = Object.create({ recipe: sampleRecipe });
    expect(isRecipeBundle(inherited)).toBe(false);
  });

  it('rejects null / non-object inputs', () => {
    expect(isRecipeBundle(null)).toBe(false);
    expect(isRecipeBundle(undefined)).toBe(false);
    expect(isRecipeBundle('string')).toBe(false);
    expect(isRecipeBundle(42)).toBe(false);
  });
});

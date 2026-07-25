/** D-119 Phase 2 — `planBundleInstall` orchestrator.
 *
 *  Covers:
 *    - `invalid` outcome when bundle fails parseBundle
 *    - `ready` outcome when scope key is unused
 *    - `ready` outcome when scope key is reused with the same hash
 *      (idempotent reinstall)
 *    - `collision` outcome when scope key holds a different hash
 *    - vault-scope key shapes per install source kind
 *    - signatureStatus passes through (unverified-not-signed →
 *      unverified-not-signed; bad-shape → crypto-invalid)
 *    - remote trust partition is derived from signature + final transport,
 *      never caller metadata
 */

import { describe, it, expect } from 'vitest';

import type {
  FetchedRemoteBundle,
  InstallSource,
  RecipeBundle,
  RecipeDefinition,
  RedirectResolvedBundleUrl,
} from '@recued/contracts';
import { planBundleInstall } from '../install-plan.js';

const validRecipe: RecipeDefinition = {
  recipe_id: 'detect-deal-risk-hubspot',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Detect Deal Risk',
    description: 'Flag deals at risk of slipping.',
    author: 'recued-core',
    supported_platforms: ['hubspot'],
    tags: ['hubspot', 'sales', 'crm'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [
    { id: 'noop', transform: 'to_list', input: 'x' } as unknown as RecipeDefinition['steps'][number],
  ],
  output: { sidebar: [] },
};

const noopLookup = async (_k: string) => null;

const fetchedRemoteBundle = (
  finalUrl: string,
  bundle: RecipeBundle = { recipe: validRecipe },
): FetchedRemoteBundle => ({
  bundle,
  finalUrl: finalUrl as RedirectResolvedBundleUrl,
});

describe('planBundleInstall — invalid outcome', () => {
  it('returns kind:invalid when bundle fails parseBundle', async () => {
    const out = await planBundleInstall({
      input: { not: 'a bundle' },
      source: { kind: 'bundle-file', slug: 'x' },
      contentHash: 'h1',
      lookupExisting: noopLookup,
    });
    expect(out.kind).toBe('invalid');
  });

  it('returns kind:invalid for a broken recipe in a wrapped bundle', async () => {
    const out = await planBundleInstall({
      input: { recipe: { ...validRecipe, recipe_id: '' } },
      source: { kind: 'bundle-file', slug: 'x' },
      contentHash: 'h1',
      lookupExisting: noopLookup,
    });
    expect(out.kind).toBe('invalid');
  });
});

describe('planBundleInstall — ready outcome', () => {
  it('returns kind:ready with scopeKey when the scope key is unused', async () => {
    const out = await planBundleInstall({
      input: { recipe: validRecipe },
      source: { kind: 'bundle-file', slug: 'detect-deal-risk-hubspot' },
      contentHash: 'h1',
      lookupExisting: noopLookup,
    });
    expect(out.kind).toBe('ready');
    if (out.kind === 'ready') {
      expect(out.scopeKey).toBe('bundle:/detect-deal-risk-hubspot');
      expect(out.signatureStatus.status).toBe('unverified-not-signed');
    }
  });

  it('returns kind:ready when the scope key holds the same content hash (idempotent reinstall)', async () => {
    const out = await planBundleInstall({
      input: { recipe: validRecipe },
      source: { kind: 'bundle-file', slug: 'detect-deal-risk-hubspot' },
      contentHash: 'h-same',
      lookupExisting: async () => 'h-same',
    });
    expect(out.kind).toBe('ready');
  });

  it('returns the correct scopeKey for marketplace install source', async () => {
    const source: InstallSource = { kind: 'marketplace', publisher: 'acme', slug: 'r' };
    const out = await planBundleInstall({
      input: { recipe: validRecipe },
      source,
      contentHash: 'h',
      lookupExisting: noopLookup,
    });
    if (out.kind === 'ready') expect(out.scopeKey).toBe('marketplace:acme/r');
    else expect.fail(`expected ready, got ${out.kind}`);
  });

  it('returns the correct scopeKey for kitchen install source', async () => {
    const out = await planBundleInstall({
      input: { recipe: validRecipe },
      source: { kind: 'kitchen', slug: 'fork' },
      contentHash: 'h',
      lookupExisting: noopLookup,
    });
    if (out.kind === 'ready') expect(out.scopeKey).toBe('local:fork');
    else expect.fail(`expected ready, got ${out.kind}`);
  });

  it('returns the correct scopeKey for bundle-remote install source (URL normalised)', async () => {
    const out = await planBundleInstall({
      fetched: fetchedRemoteBundle('HTTPS://Recipes.Example.COM/Q3/Contracts'),
      source: {
        kind: 'bundle-remote',
        slug: 'r',
      },
      contentHash: 'h',
      lookupExisting: noopLookup,
    });
    if (out.kind === 'ready') {
      expect(out.scopeKey).toBe('bundle:recipes.example.com/q3/contracts/r');
      expect(out.vaultScope).toMatchObject({ kind: 'bundle-remote', verified: true });
    } else expect.fail(`expected ready, got ${out.kind}`);
  });
});

describe('planBundleInstall — remote trust partition', () => {
  it('marks an unsigned HTTP bundle unverified', async () => {
    const out = await planBundleInstall({
      fetched: fetchedRemoteBundle('http://recipes.example.com/q3/contracts'),
      source: { kind: 'bundle-remote', slug: 'r' },
      contentHash: 'h',
      lookupExisting: noopLookup,
    });

    if (out.kind === 'ready') {
      expect(out.signatureStatus.status).toBe('unverified-not-signed');
      expect(out.scopeKey).toBe('bundle:recipes.example.com/q3/contracts-unverified/r');
      expect(out.vaultScope).toMatchObject({ kind: 'bundle-remote', verified: false });
    } else expect.fail(`expected ready, got ${out.kind}`);
  });

  it('keeps a malformed claimed signature unverified even over HTTPS', async () => {
    const out = await planBundleInstall({
      fetched: fetchedRemoteBundle('https://recipes.example.com/q3/contracts', {
        recipe: validRecipe,
        signature: { algorithm: 'ed25519', publisher_pubkey: 'AAAA', signature: 'BBBB' },
      }),
      source: { kind: 'bundle-remote', slug: 'r' },
      contentHash: 'h',
      lookupExisting: noopLookup,
    });

    if (out.kind === 'ready') {
      expect(out.signatureStatus.status).toBe('crypto-invalid');
      expect(out.scopeKey).toBe('bundle:recipes.example.com/q3/contracts-unverified/r');
      expect(out.vaultScope).toMatchObject({ kind: 'bundle-remote', verified: false });
    } else expect.fail(`expected ready, got ${out.kind}`);
  });
});

describe('planBundleInstall — collision outcome', () => {
  it('returns kind:collision with existingHash when the scope key holds a different hash', async () => {
    const out = await planBundleInstall({
      input: { recipe: validRecipe },
      source: { kind: 'bundle-file', slug: 'r' },
      contentHash: 'h-new',
      lookupExisting: async () => 'h-old',
    });
    expect(out.kind).toBe('collision');
    if (out.kind === 'collision') {
      expect(out.existingHash).toBe('h-old');
      expect(out.scopeKey).toBe('bundle:/r');
    }
  });
});

describe('planBundleInstall — signatureStatus pass-through', () => {
  it('passes through unverified-not-signed when no signature is present', async () => {
    const out = await planBundleInstall({
      input: { recipe: validRecipe },
      source: { kind: 'bundle-file', slug: 'r' },
      contentHash: 'h',
      lookupExisting: noopLookup,
    });
    if (out.kind === 'ready') expect(out.signatureStatus.status).toBe('unverified-not-signed');
    else expect.fail(`expected ready, got ${out.kind}`);
  });

  it('reports crypto-invalid for a malformed signature shape (parser passes — sig has all 3 fields — but bytes are bogus)', async () => {
    const out = await planBundleInstall({
      input: {
        recipe: validRecipe,
        signature: { algorithm: 'ed25519', publisher_pubkey: 'AAAA', signature: 'BBBB' },
      },
      source: { kind: 'bundle-file', slug: 'r' },
      contentHash: 'h',
      lookupExisting: noopLookup,
    });
    if (out.kind === 'ready') expect(out.signatureStatus.status).toBe('crypto-invalid');
    else expect.fail(`expected ready, got ${out.kind}`);
  });
});

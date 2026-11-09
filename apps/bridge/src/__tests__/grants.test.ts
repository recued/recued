/** D-148 P3 — per-ingredient grant store + check tests.
 *
 *  Covers spec § A.3.4.1 three-way intersection enforcement: tuple
 *  match + signed allowlist membership + user grant subset. */

import { describe, it, expect } from 'vitest';
import {
  buildGrant,
  checkIngredientGrant,
  createInMemoryBridgeGrantStore,
} from '../permissions/grants.js';
import type { BridgeIngredientRef } from '@recued/contracts';

const ingredient: BridgeIngredientRef = {
  publisher_id: 'recued-core',
  slug: 'draft-email-reader-hubspot',
  version: '1.0.0',
  surface_kind: 'reading',
  domain_allowlist: ['*://app.hubspot.com/*'],
  domain_allowlist_signature: 'PUB_SIG',
};

describe('D-148 P3 — grant store CRUD', () => {
  it('put + get round-trip', async () => {
    const store = createInMemoryBridgeGrantStore();
    const grant = buildGrant(ingredient, ['*://app.hubspot.com/*'], 1_700_000_000_000);
    await store.put(grant);
    const fetched = await store.get(ingredient.publisher_id, ingredient.slug, ingredient.version);
    expect(fetched).toEqual(grant);
  });

  it('different version → no grant inheritance', async () => {
    const store = createInMemoryBridgeGrantStore();
    await store.put(buildGrant(ingredient, ['*://app.hubspot.com/*'], 1));
    const v2 = await store.get(ingredient.publisher_id, ingredient.slug, '2.0.0');
    expect(v2).toBeNull();
  });

  it('list() returns all grants', async () => {
    const store = createInMemoryBridgeGrantStore();
    await store.put(buildGrant(ingredient, ['*://app.hubspot.com/*'], 1));
    await store.put(buildGrant(
      { ...ingredient, slug: 'other-slug' },
      ['*://linkedin.com/*'],
      2,
    ));
    expect(await store.list()).toHaveLength(2);
  });

  it('remove() drops a grant', async () => {
    const store = createInMemoryBridgeGrantStore();
    await store.put(buildGrant(ingredient, ['*://app.hubspot.com/*'], 1));
    await store.remove(ingredient.publisher_id, ingredient.slug, ingredient.version);
    expect(await store.get(ingredient.publisher_id, ingredient.slug, ingredient.version)).toBeNull();
  });

  it('clear() wipes all grants', async () => {
    const store = createInMemoryBridgeGrantStore();
    await store.put(buildGrant(ingredient, ['*://app.hubspot.com/*'], 1));
    await store.clear();
    expect(await store.list()).toHaveLength(0);
  });
});

describe('D-148 P3 — three-way intersection check', () => {
  it('all three axes hold → ok', async () => {
    const store = createInMemoryBridgeGrantStore();
    await store.put(buildGrant(ingredient, ['*://app.hubspot.com/*'], 1));
    const out = await checkIngredientGrant(store, ingredient, '*://app.hubspot.com/contacts/*');
    expect(out.ok).toBe(true);
  });

  it('missing grant → reason: missing_grant', async () => {
    const store = createInMemoryBridgeGrantStore();
    const out = await checkIngredientGrant(store, ingredient, '*://app.hubspot.com/*');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('missing_grant');
  });

  it('pattern outside ingredient signed allowlist → outside_allowlist', async () => {
    const store = createInMemoryBridgeGrantStore();
    await store.put(buildGrant(ingredient, ['*://app.hubspot.com/*'], 1));
    const out = await checkIngredientGrant(store, ingredient, '*://linkedin.com/*');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('pattern_outside_allowlist');
  });

  it('pattern in allowlist but narrower-than-grant → reason: pattern_outside_grant', async () => {
    const store = createInMemoryBridgeGrantStore();
    // Grant only narrow path
    await store.put(buildGrant(ingredient, ['*://app.hubspot.com/contacts/*'], 1));
    const wider_ingredient: BridgeIngredientRef = {
      ...ingredient,
      // Allowlist has both contacts and email
      domain_allowlist: ['*://app.hubspot.com/contacts/*', '*://app.hubspot.com/email/*'],
    };
    // Re-use grant for the same tuple (publisher_id/slug/version unchanged)
    const out = await checkIngredientGrant(store, wider_ingredient, '*://app.hubspot.com/email/*');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('pattern_outside_grant');
  });
});

describe('D-148 P3 — buildGrant constructor', () => {
  it('clones the granted_origins array (defensive copy)', () => {
    const origins = ['*://app.hubspot.com/*'];
    const grant = buildGrant(ingredient, origins, 1);
    origins.push('*://linkedin.com/*');
    expect(grant.granted_origins).toEqual(['*://app.hubspot.com/*']);
  });

  it('binds publisher_id + slug + version', () => {
    const grant = buildGrant(ingredient, ['*://app.hubspot.com/*'], 99);
    expect(grant.publisher_id).toBe(ingredient.publisher_id);
    expect(grant.slug).toBe(ingredient.slug);
    expect(grant.version).toBe(ingredient.version);
    expect(grant.granted_at).toBe(99);
  });
});

/** D-139 P6.B — MCP body-content visibility grant store.
 *
 *  Server/install-scoped grant store keyed by `(pack_slug, publisher,
 *  grant_key)`. `isGranted(key)` is the read-time gate the MCP engagement
 *  read consults; grant/revokeForPack are the install/uninstall lifecycle. */

import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { ENGAGEMENT_BODY_CONTENT_REGISTRY_KEY } from '@recued/contracts';
import {
  createMcpBodyVisibilityStore,
  type McpBodyVisibilityStore,
} from '../storage/mcp-body-visibility-store.js';

const KEY = ENGAGEMENT_BODY_CONTENT_REGISTRY_KEY;
const make = (): McpBodyVisibilityStore =>
  createMcpBodyVisibilityStore(new Database(':memory:'));

describe('D-139 P6.B — McpBodyVisibilityStore', () => {
  it('an unknown key is not granted on a fresh store', () => {
    const store = make();
    expect(store.isGranted(KEY)).toBe(false);
    expect(store.listGrantedKeys()).toEqual([]);
  });

  it('grant makes isGranted true; listGrantedKeys reflects it', () => {
    const store = make();
    store.grant({
      pack_slug: 'crm-commitment-tracker',
      publisher: 'recued-core',
      grants: [KEY],
      granted_at: 1,
    });
    expect(store.isGranted(KEY)).toBe(true);
    expect(store.listGrantedKeys()).toEqual([KEY]);
  });

  it('grant is idempotent (re-grant refreshes granted_at, no duplicate)', () => {
    const store = make();
    const pack = { pack_slug: 'p', publisher: 'recued-core', grants: [KEY] };
    store.grant({ ...pack, granted_at: 1 });
    store.grant({ ...pack, granted_at: 2 });
    expect(store.listGrantedKeys()).toEqual([KEY]); // one distinct key
  });

  it('empty grants is a no-op', () => {
    const store = make();
    store.grant({ pack_slug: 'p', publisher: 'recued-core', grants: [], granted_at: 1 });
    expect(store.isGranted(KEY)).toBe(false);
  });

  it('revokeForPack (no grants) drops every row for the pack + returns the keys', () => {
    const store = make();
    store.grant({ pack_slug: 'p', publisher: 'recued-core', grants: [KEY], granted_at: 1 });
    const removed = store.revokeForPack({ pack_slug: 'p', publisher: 'recued-core' });
    expect(removed).toEqual([KEY]);
    expect(store.isGranted(KEY)).toBe(false);
  });

  it('revokeForPack with explicit grants drops only those keys (rollback path)', () => {
    const store = make();
    store.grant({ pack_slug: 'p', publisher: 'recued-core', grants: [KEY], granted_at: 1 });
    const removed = store.revokeForPack({
      pack_slug: 'p',
      publisher: 'recued-core',
      grants: [KEY],
    });
    expect(removed).toEqual([KEY]);
    expect(store.isGranted(KEY)).toBe(false);
  });

  it('the grant is SERVER-scoped — isGranted is true while ANY pack still grants it', () => {
    const store = make();
    store.grant({ pack_slug: 'a', publisher: 'recued-core', grants: [KEY], granted_at: 1 });
    store.grant({ pack_slug: 'b', publisher: 'recued-core', grants: [KEY], granted_at: 1 });
    // Uninstalling pack 'a' leaves 'b' still granting the key.
    store.revokeForPack({ pack_slug: 'a', publisher: 'recued-core' });
    expect(store.isGranted(KEY)).toBe(true);
    store.revokeForPack({ pack_slug: 'b', publisher: 'recued-core' });
    expect(store.isGranted(KEY)).toBe(false);
  });

  it('revoke is scoped by (pack_slug, publisher) — a sibling pack survives', () => {
    const store = make();
    store.grant({ pack_slug: 'p', publisher: 'pub-a', grants: [KEY], granted_at: 1 });
    store.grant({ pack_slug: 'p', publisher: 'pub-b', grants: [KEY], granted_at: 1 });
    store.revokeForPack({ pack_slug: 'p', publisher: 'pub-a' });
    // The same slug under a different publisher is a different pack identity.
    expect(store.isGranted(KEY)).toBe(true);
  });

  it('revokeForPack on a pack with no rows is a no-op returning []', () => {
    const store = make();
    expect(store.revokeForPack({ pack_slug: 'nope', publisher: 'recued-core' })).toEqual([]);
  });

  it('revokeForPack WITHOUT a publisher drops every grant for the slug across ALL publishers (orphan uninstall recovery)', () => {
    // An orphaned marketplace pack (inventory-write-failed) has no recorded
    // publisher at uninstall, so the whole-pack revoke must drop by slug alone —
    // else body content stays MCP-readable after the pack is "removed".
    const store = make();
    store.grant({ pack_slug: 'p', publisher: 'pub-a', grants: ['key-a'], granted_at: 1 });
    store.grant({ pack_slug: 'p', publisher: 'pub-b', grants: ['key-b'], granted_at: 1 });
    store.grant({ pack_slug: 'other', publisher: 'pub-a', grants: ['key-c'], granted_at: 1 });

    const removed = store.revokeForPack({ pack_slug: 'p' }); // no publisher → slug-wide

    expect(removed.sort()).toEqual(['key-a', 'key-b']);
    expect(store.isGranted('key-a')).toBe(false);
    expect(store.isGranted('key-b')).toBe(false);
    expect(store.isGranted('key-c')).toBe(true); // a different slug is untouched
  });

  it('hasGrantsForPackSlug reports any-publisher existence for a slug (uninstall proof)', () => {
    const store = make();
    expect(store.hasGrantsForPackSlug('p')).toBe(false);
    store.grant({ pack_slug: 'p', publisher: 'pub-x', grants: [KEY], granted_at: 1 });
    expect(store.hasGrantsForPackSlug('p')).toBe(true);
    expect(store.hasGrantsForPackSlug('other')).toBe(false);
    store.revokeForPack({ pack_slug: 'p' });
    expect(store.hasGrantsForPackSlug('p')).toBe(false);
  });

  it('revokeForPack with `grants` but NO publisher throws (guards the destructive fall-through)', () => {
    const store = make();
    store.grant({ pack_slug: 'p', publisher: 'pub-a', grants: ['key-a'], granted_at: 1 });
    store.grant({ pack_slug: 'p', publisher: 'pub-b', grants: ['key-b'], granted_at: 1 });
    // A grants+no-publisher call must NOT silently slug-wide-delete both.
    expect(() => store.revokeForPack({ pack_slug: 'p', grants: ['key-a'] })).toThrow();
    // Nothing was dropped — the throw fired before any delete.
    expect(store.isGranted('key-a')).toBe(true);
    expect(store.isGranted('key-b')).toBe(true);
  });
});

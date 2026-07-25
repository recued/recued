/** D-125 Phase 1.2 — connection-row IDB store tests.
 *
 *  Covers:
 *    - upsert / get / list / listSince / delete / count / clear round-trips
 *    - composite key collision: same name across different kinds is
 *      independent (api.hubspot vs notification.hubspot coexist)
 *    - upsert auto-stamps the `pk` to match `(kind, name)` even when
 *      the caller supplied a stale value
 *    - list ordering: newest updated_at first, name as tiebreak
 *    - listSince: strict greater-than filter, newest first
 *    - delete returns false on missing rows
 *    - clear empties the store
 *
 *  No projection-helper coverage here (that lives in
 *  `packages/contracts/src/__tests__/d-125-phase-1-2-...test.ts`)
 *  — the row store is opaque to ciphertext / config shape. */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ConnectionRow } from '@recued/contracts';
import { createConnectionRowStore, type ConnectionRowStore } from '../connection-store.js';

let counter = 0;
const uniqueDb = (): string => `connection-store-test-${++counter}-${Date.now()}`;

const mkRow = (overrides: Partial<ConnectionRow> = {}): ConnectionRow => ({
  pk: 'api:hubspot',
  kind: 'api',
  name: 'hubspot',
  display_name: 'HubSpot Production',
  config_json: JSON.stringify({ base_url: 'https://api.hubapi.com' }),
  auth_ciphertext: 'AEAD-CIPHERTEXT-BASE64',
  enrolled_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
  ...overrides,
});

describe('createConnectionRowStore — CRUD round-trips', () => {
  let store: ConnectionRowStore;
  beforeEach(() => {
    store = createConnectionRowStore({ dbName: uniqueDb() });
  });

  it('get returns null for an unknown (kind, name)', async () => {
    expect(await store.get('api', 'salesforcedev')).toBeNull();
  });

  it('upsert → get round-trips the row by composite key', async () => {
    const row = mkRow();
    await store.upsert(row);
    expect(await store.get('api', 'hubspot')).toEqual(row);
  });

  it('upsert overwrites an existing row in place', async () => {
    await store.upsert(mkRow({ display_name: 'HubSpot Production' }));
    await store.upsert(mkRow({
      display_name: 'HubSpot Sandbox',
      updated_at: 1_700_000_010_000,
    }));
    const fetched = await store.get('api', 'hubspot');
    expect(fetched?.display_name).toBe('HubSpot Sandbox');
    expect(fetched?.updated_at).toBe(1_700_000_010_000);
  });

  it('upsert force-stamps pk to match (kind, name) even when caller passes a stale value', async () => {
    // A row with a mismatched pk would create a silent corruption —
    // get(kind, name) computes its own pk and would never find the
    // row stored under the stale key. Verify the store rewrites pk.
    await store.upsert(mkRow({ pk: 'STALE-KEY-DO-NOT-TRUST' }));
    const fetched = await store.get('api', 'hubspot');
    expect(fetched?.pk).toBe('api:hubspot');
  });

  it('delete returns true when a row was removed', async () => {
    await store.upsert(mkRow());
    expect(await store.delete('api', 'hubspot')).toBe(true);
    expect(await store.get('api', 'hubspot')).toBeNull();
  });

  it('delete returns false when the row is missing', async () => {
    expect(await store.delete('api', 'never-enrolled')).toBe(false);
  });

  it('count tracks the live row total', async () => {
    expect(await store.count()).toBe(0);
    await store.upsert(mkRow());
    await store.upsert(mkRow({ name: 'hubspot2', pk: 'api:hubspot2' }));
    expect(await store.count()).toBe(2);
    await store.delete('api', 'hubspot');
    expect(await store.count()).toBe(1);
  });

  it('clear empties every row', async () => {
    await store.upsert(mkRow());
    await store.upsert(mkRow({ kind: 'mcp', name: 'gh', pk: 'mcp:gh' }));
    await store.clear();
    expect(await store.count()).toBe(0);
  });
});

describe('createConnectionRowStore — composite key independence', () => {
  let store: ConnectionRowStore;
  beforeEach(() => {
    store = createConnectionRowStore({ dbName: uniqueDb() });
  });

  it('same name across different kinds occupies separate rows', async () => {
    // `connection.api.hubspot` and `connection.notification.hubspot`
    // are two independent records — the spec mandates this so a user
    // can have an HTTP API connection AND a notification destination
    // both nicknamed `hubspot` without collision.
    await store.upsert(mkRow({ kind: 'api', name: 'hubspot' }));
    await store.upsert(mkRow({
      kind: 'notification',
      name: 'hubspot',
      subtype: 'slack',
      display_name: 'HubSpot Slack',
      pk: 'notification:hubspot',
    }));
    expect(await store.count()).toBe(2);
    const api = await store.get('api', 'hubspot');
    const notif = await store.get('notification', 'hubspot');
    expect(api?.display_name).toBe('HubSpot Production');
    expect(notif?.display_name).toBe('HubSpot Slack');
  });
});

describe('createConnectionRowStore — list / listSince ordering', () => {
  let store: ConnectionRowStore;
  beforeEach(async () => {
    store = createConnectionRowStore({ dbName: uniqueDb() });
    await store.upsert(mkRow({
      kind: 'api', name: 'hubspot',
      pk: 'api:hubspot', updated_at: 1_700_000_010_000,
    }));
    await store.upsert(mkRow({
      kind: 'api', name: 'salesforce',
      pk: 'api:salesforce', updated_at: 1_700_000_020_000,
    }));
    await store.upsert(mkRow({
      kind: 'mcp', name: 'gh-mcp', subtype: 'sse',
      pk: 'mcp:gh-mcp', updated_at: 1_700_000_005_000,
    }));
    await store.upsert(mkRow({
      kind: 'notification', name: 'team-slack', subtype: 'slack',
      pk: 'notification:team-slack', updated_at: 1_700_000_030_000,
    }));
  });

  it('list() returns every row, newest updated_at first', async () => {
    const all = await store.list();
    expect(all.map((r) => r.name)).toEqual([
      'team-slack',   // 30k
      'salesforce',   // 20k
      'hubspot',      // 10k
      'gh-mcp',       // 5k
    ]);
  });

  it('list({ kind }) filters to one kind', async () => {
    const apis = await store.list({ kind: 'api' });
    expect(apis.map((r) => r.name)).toEqual(['salesforce', 'hubspot']);
  });

  it('listSince filters strict-greater-than', async () => {
    const recent = await store.listSince(1_700_000_010_000);
    // 10k is NOT included (strict greater-than) — sync delta wire
    // contract is "give me everything newer than my last cursor."
    expect(recent.map((r) => r.name)).toEqual([
      'team-slack',
      'salesforce',
    ]);
  });

  it('listSince with a future cursor returns empty', async () => {
    expect(await store.listSince(2_000_000_000_000)).toEqual([]);
  });
});

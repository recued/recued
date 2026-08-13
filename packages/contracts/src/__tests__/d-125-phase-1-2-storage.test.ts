/** D-125 Phase 1.2 — connection projection helpers tests.
 *
 *  Covers the contract-layer additions in P1.2:
 *    - `ConnectionRow` shape composes from contracts
 *    - `connectionRowKey` builds the composite key
 *    - `connectionViewFromRow` projects with config spread + auth
 *      excluded (literal field check + JSON-stringify ciphertext scan)
 *    - `connectionStoreFromRows` groups by kind for resolver
 *      hydration
 *    - malformed config_json doesn't throw — falls back to empty
 *      config + still surfaces row identity (defensive shape)
 *
 *  D-168: SYNC_OBJECTS registry assertions retired. ⛔ Its named
 *  successor was never built — this claimed the sync surface "is now
 *  declared via D-166's contract.connection_record schema entry
 *  (sync_transport: 'pair')", and neither the entry nor the field
 *  exists in `contract-schema.ts`. There is no connection sync surface
 *  to assert: clients pull via `collection.connection.list` and react
 *  to `recipe_runnability_changed`. Ruled won't-do 2026-08-11 (D-166
 *  amendment) — do not add assertions for a declaration surface that
 *  is not coming.
 */

import { describe, expect, it } from 'vitest';
import {
  connectionRowKey,
  connectionStoreFromRows,
  connectionViewFromRow,
  parseGrantedScopesJson,
  type ConnectionRow,
} from '../index.js';

describe('D-125 P1.2 — connectionRowKey', () => {
  it('composes `${kind}:${name}` deterministically', () => {
    expect(connectionRowKey('api', 'hubspot')).toBe('api:hubspot');
    expect(connectionRowKey('mcp', 'gh-mcp')).toBe('mcp:gh-mcp');
    expect(connectionRowKey('notification', 'team-slack')).toBe(
      'notification:team-slack',
    );
  });

  it('keeps same-name rows across different kinds independent', () => {
    // A user enrolling `connection.api.hubspot` and
    // `connection.notification.hubspot` produces two distinct keys.
    expect(connectionRowKey('api', 'hubspot')).not.toBe(
      connectionRowKey('notification', 'hubspot'),
    );
  });
});

describe('D-125 P1.2 — connectionViewFromRow projection', () => {
  const fullRow: ConnectionRow = {
    pk: 'api:hubspot',
    kind: 'api',
    name: 'hubspot',
    display_name: 'HubSpot Production',
    config_json: JSON.stringify({
      base_url: 'https://api.hubapi.com',
      probe_path: '/oauth/v1/token-info',
    }),
    auth_ciphertext: 'AEAD-CIPHERTEXT-DO-NOT-LEAK-TO-VIEW',
    enrolled_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
  };

  it('spreads config fields top-level on the view', () => {
    const view = connectionViewFromRow(fullRow);
    expect(view.base_url).toBe('https://api.hubapi.com');
    expect(view.probe_path).toBe('/oauth/v1/token-info');
  });

  it('preserves identity fields (name / kind / display_name)', () => {
    const view = connectionViewFromRow(fullRow);
    expect(view.name).toBe('hubspot');
    expect(view.kind).toBe('api');
    expect(view.display_name).toBe('HubSpot Production');
  });

  it('does not let config_json spoof identity fields', () => {
    const row: ConnectionRow = {
      ...fullRow,
      config_json: JSON.stringify({
        name: 'evil',
        kind: 'mcp',
        subtype: 'stdio',
        display_name: 'Spoofed',
        base_url: 'https://api.hubapi.com',
      }),
    };
    const view = connectionViewFromRow(row);
    expect(view.name).toBe('hubspot');
    expect(view.kind).toBe('api');
    expect(view.display_name).toBe('HubSpot Production');
    expect(view.subtype).toBeUndefined();
    expect(view.base_url).toBe('https://api.hubapi.com');
  });

  it('omits auth ciphertext from the projection', () => {
    const view = connectionViewFromRow(fullRow);
    // Belt — literal field check.
    expect((view as { auth_ciphertext?: unknown }).auth_ciphertext).toBeUndefined();
    expect((view as { auth?: unknown }).auth).toBeUndefined();
    // Suspenders — scan all values for the secret string. Catches
    // future projection bugs that copy the row under a different key.
    const flat = JSON.stringify(view);
    expect(flat.includes('AEAD-CIPHERTEXT-DO-NOT-LEAK-TO-VIEW')).toBe(false);
  });

  it('omits storage-only fields (pk / config_json / health_json / enrolled_at)', () => {
    const row: ConnectionRow = {
      ...fullRow,
      config_json: JSON.stringify({
        pk: 'api:evil',
        config_json: '{}',
        auth: { token: 'CONFIG-AUTH-DO-NOT-LEAK-TO-VIEW' },
        auth_ciphertext: 'CONFIG-CIPHERTEXT-DO-NOT-LEAK-TO-VIEW',
        enrolled_at: 1,
        updated_at: 2,
        last_used_at: 3,
        health_json: '{}',
        base_url: 'https://api.hubapi.com',
      }),
    };
    const view = connectionViewFromRow(row);
    // `pk` is an IDB-side composite key — not part of the resolver
    // surface. `config_json` is the unparsed source; the parsed
    // fields are spread instead. enrolled_at / updated_at /
    // last_used_at are config metadata; recipes care about live
    // config values, not the row's bookkeeping timestamps.
    expect((view as { pk?: unknown }).pk).toBeUndefined();
    expect((view as { config_json?: unknown }).config_json).toBeUndefined();
    expect((view as { auth?: unknown }).auth).toBeUndefined();
    expect((view as { auth_ciphertext?: unknown }).auth_ciphertext).toBeUndefined();
    expect((view as { health_json?: unknown }).health_json).toBeUndefined();
    expect((view as { enrolled_at?: unknown }).enrolled_at).toBeUndefined();
    expect((view as { updated_at?: unknown }).updated_at).toBeUndefined();
    expect((view as { last_used_at?: unknown }).last_used_at).toBeUndefined();
    const flat = JSON.stringify(view);
    expect(flat.includes('CONFIG-AUTH-DO-NOT-LEAK-TO-VIEW')).toBe(false);
    expect(flat.includes('CONFIG-CIPHERTEXT-DO-NOT-LEAK-TO-VIEW')).toBe(false);
    expect(view.base_url).toBe('https://api.hubapi.com');
  });

  it('omits prototype-sensitive config keys from the projection', () => {
    const row: ConnectionRow = {
      ...fullRow,
      config_json:
        '{"__proto__":{"polluted":true},"constructor":{"leak":true},"prototype":{"leak":true},"base_url":"https://api.hubapi.com"}',
    };
    const view = connectionViewFromRow(row);

    expect(Object.getPrototypeOf(view)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(view, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(view, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(view, 'prototype')).toBe(false);
    expect(view.base_url).toBe('https://api.hubapi.com');
  });

  it('surfaces subtype when present (mcp transport / notification subtype)', () => {
    const mcpRow: ConnectionRow = {
      ...fullRow,
      pk: 'mcp:gh-mcp',
      kind: 'mcp',
      name: 'gh-mcp',
      subtype: 'sse',
      config_json: JSON.stringify({ endpoint: 'https://mcp.github.com/sse' }),
    };
    const view = connectionViewFromRow(mcpRow);
    expect(view.subtype).toBe('sse');
    expect(view.endpoint).toBe('https://mcp.github.com/sse');
  });

  it('falls back to empty config on malformed config_json — defensive', () => {
    const broken: ConnectionRow = { ...fullRow, config_json: '{not json}' };
    const view = connectionViewFromRow(broken);
    // Identity preserved so the row still appears in Settings.
    expect(view.name).toBe('hubspot');
    expect(view.kind).toBe('api');
    // No spread fields — base_url et al missing.
    expect(view.base_url).toBeUndefined();
  });

  it('falls back to empty config on a non-object config_json (array / scalar)', () => {
    const arr: ConnectionRow = { ...fullRow, config_json: '[1, 2, 3]' };
    expect(connectionViewFromRow(arr).base_url).toBeUndefined();
    const num: ConnectionRow = { ...fullRow, config_json: '42' };
    expect(connectionViewFromRow(num).base_url).toBeUndefined();
  });
});

describe('D-125 P1.2 — connectionStoreFromRows', () => {
  const rows: readonly ConnectionRow[] = [
    {
      pk: 'api:hubspot',
      kind: 'api',
      name: 'hubspot',
      display_name: 'HubSpot Prod',
      config_json: JSON.stringify({ base_url: 'https://api.hubapi.com' }),
      auth_ciphertext: 'CIPHER-A',
      enrolled_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
    },
    {
      pk: 'api:salesforce',
      kind: 'api',
      name: 'salesforce',
      display_name: 'Salesforce',
      config_json: JSON.stringify({ base_url: 'https://my.salesforce.com' }),
      auth_ciphertext: 'CIPHER-B',
      enrolled_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
    },
    {
      pk: 'mcp:gh-mcp',
      kind: 'mcp',
      name: 'gh-mcp',
      subtype: 'sse',
      display_name: 'GitHub MCP',
      config_json: JSON.stringify({ endpoint: 'https://mcp.github.com/sse' }),
      auth_ciphertext: 'CIPHER-C',
      enrolled_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
    },
  ];

  it('groups rows by kind into per-name records', () => {
    const store = connectionStoreFromRows(rows);
    expect(Object.keys(store.api ?? {}).sort()).toEqual(['hubspot', 'salesforce']);
    expect(Object.keys(store.mcp ?? {})).toEqual(['gh-mcp']);
    expect(store.notification).toBeUndefined();
  });

  it('exposes the projected config fields per row', () => {
    const store = connectionStoreFromRows(rows);
    expect(store.api?.hubspot?.base_url).toBe('https://api.hubapi.com');
    expect(store.mcp?.['gh-mcp']?.endpoint).toBe('https://mcp.github.com/sse');
  });

  it('omits auth ciphertext from every projected view', () => {
    const store = connectionStoreFromRows(rows);
    // Single JSON.stringify across the whole store catches a leak in
    // any kind / name / field — equivalent to the per-view scan but
    // covers the hydration boundary used by the resolver.
    const flat = JSON.stringify(store);
    expect(flat.includes('CIPHER-A')).toBe(false);
    expect(flat.includes('CIPHER-B')).toBe(false);
    expect(flat.includes('CIPHER-C')).toBe(false);
  });

  it('uses prototype-safe per-kind maps for legacy row names', () => {
    const store = connectionStoreFromRows([
      {
        pk: 'api:__proto__',
        kind: 'api',
        name: '__proto__',
        display_name: 'Legacy unsafe name',
        config_json: JSON.stringify({ base_url: 'https://legacy.example.com' }),
        auth_ciphertext: 'CIPHER-LEGACY',
        enrolled_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000,
      },
    ]);

    expect(Object.getPrototypeOf(store.api ?? {})).toBe(null);
    expect(Object.prototype.hasOwnProperty.call(store.api, '__proto__')).toBe(true);
    expect(store.api?.['__proto__']?.display_name).toBe('Legacy unsafe name');
    expect(store.api?.['__proto__']?.base_url).toBe('https://legacy.example.com');
  });

  it('skips rows with invalid runtime kinds before grouping', () => {
    const proto = Object.prototype as Record<string, unknown>;
    delete proto.pollutedConnection;
    const store = connectionStoreFromRows([
      {
        pk: '__proto__:pollutedConnection',
        kind: '__proto__' as unknown as ConnectionRow['kind'],
        name: 'pollutedConnection',
        display_name: 'Corrupt row',
        config_json: JSON.stringify({ base_url: 'https://corrupt.example.com' }),
        auth_ciphertext: 'CIPHER-CORRUPT',
        enrolled_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000,
      },
    ]);
    const polluted = Object.prototype.hasOwnProperty.call(proto, 'pollutedConnection');
    delete proto.pollutedConnection;

    expect(polluted).toBe(false);
    expect(store).toEqual({});
  });

  it('produces an empty store for an empty input', () => {
    expect(connectionStoreFromRows([])).toEqual({});
  });
});

describe('granted-scopes projection', () => {
  const baseRow: ConnectionRow = {
    pk: 'api:hubspot',
    kind: 'api',
    name: 'hubspot',
    display_name: 'HubSpot',
    config_json: '{}',
    auth_ciphertext: 'CIPHER',
    enrolled_at: 1,
    updated_at: 1,
  };

  it('surfaces granted_scopes on the view from the JSON column', () => {
    const view = connectionViewFromRow({
      ...baseRow,
      granted_scopes_json: JSON.stringify(['crm.objects.deals.read', 'oauth']),
    });
    expect(view.granted_scopes).toEqual(['crm.objects.deals.read', 'oauth']);
  });

  it('leaves granted_scopes absent when the column is missing (unknown coverage)', () => {
    expect(connectionViewFromRow(baseRow).granted_scopes).toBeUndefined();
  });

  it('leaves granted_scopes absent + keeps the row visible when the column is malformed', () => {
    const view = connectionViewFromRow({
      ...baseRow,
      config_json: JSON.stringify({ base_url: 'https://x' }),
      granted_scopes_json: 'not json',
    });
    expect(view.granted_scopes).toBeUndefined();
    expect(view.base_url).toBe('https://x'); // projection didn't throw
  });

  it('cannot be spoofed by a config_json key of the same name', () => {
    const view = connectionViewFromRow({
      ...baseRow,
      config_json: JSON.stringify({ granted_scopes: ['evil'], granted_scopes_json: 'evil' }),
      granted_scopes_json: JSON.stringify(['real']),
    });
    expect(view.granted_scopes).toEqual(['real']);
  });

  describe('parseGrantedScopesJson', () => {
    it('parses a string array', () => {
      expect(parseGrantedScopesJson('["a","b"]')).toEqual(['a', 'b']);
    });
    it('returns undefined for absent / null', () => {
      expect(parseGrantedScopesJson(undefined)).toBeUndefined();
      expect(parseGrantedScopesJson(null)).toBeUndefined();
    });
    it('returns undefined for malformed or non-string-array JSON', () => {
      expect(parseGrantedScopesJson('not json')).toBeUndefined();
      expect(parseGrantedScopesJson('{"a":1}')).toBeUndefined();
      expect(parseGrantedScopesJson('[1,2]')).toBeUndefined();
      expect(parseGrantedScopesJson('"a"')).toBeUndefined();
    });
  });
});

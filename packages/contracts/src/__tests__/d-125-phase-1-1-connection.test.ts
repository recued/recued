/** D-125 Phase 1.1 — Connection substrate contract types tests.
 *
 *  Substrate-only assertions:
 *    - `connection` registered as a Namespace + NS Set member
 *    - resolver walks `{{connection.<kind>.<name>.<field>}}` refs
 *      end-to-end without touching auth (view projection excludes
 *      ciphertext)
 *    - per-kind constants exposed
 *    - `ConnectionAuth` discriminated-union compiles for every
 *      auth shape the spec mandates
 *
 *  No runtime / sync / SQL assertions — those are P1.2+. This file
 *  only proves the contract types compose and the resolver wiring
 *  doesn't drop the new namespace. */

import { describe, expect, it } from 'vitest';
import {
  CONNECTION_API_TIMEOUT_MS,
  ENRICHMENT_TRUST_MIN_DEFAULT,
  MCP_CLIENT_IDLE_TIMEOUT_MS,
  MAX_HEADER_AUTH_ENTRIES,
  NS,
  OAUTH2_REFRESH_LEAD_MS,
  resolveBearerAccessToken,
  resolveRef,
  validateHeaderAuthEntries,
  type ConnectionAuth,
  type ConnectionRecord,
  type ConnectionStore,
  type ConnectionView,
  type Namespace,
  type NamespaceStores,
} from '../index.js';

describe('D-125 P1.1 — Namespace registry', () => {
  it('exposes "connection" in the Namespace union', () => {
    // Compile-time assertion: this line fails to type-check if the
    // union doesn't include 'connection'.
    const ns: Namespace = 'connection';
    expect(ns).toBe('connection');
  });

  it('registers "connection" in the NS Set', () => {
    expect(NS.has('connection')).toBe(true);
  });

  it('retires "account" from NS post-P5.2 (literal kept reserved in Namespace type)', () => {
    // P5.2 retired the account-namespace runtime + sync atomic with the
    // wrapper migration. NS membership is the resolver gate; dropping
    // it here makes `{{account.*}}` resolve to undefined and lets the
    // recipe / ingredient validators reject fresh references.
    expect(NS.has('account')).toBe(false);
  });
});

describe('D-125 P1.1 — Constants', () => {
  it('exports a 30s api-handler timeout', () => {
    expect(CONNECTION_API_TIMEOUT_MS).toBe(30_000);
  });

  it('exports a 60s oauth2 refresh lead window', () => {
    expect(OAUTH2_REFRESH_LEAD_MS).toBe(60_000);
  });

  it('exports a 5min MCP client idle teardown timeout', () => {
    expect(MCP_CLIENT_IDLE_TIMEOUT_MS).toBe(5 * 60_000);
  });

  it('exports a 0.8 enrichment-or-fetch trust default', () => {
    expect(ENRICHMENT_TRUST_MIN_DEFAULT).toBe(0.8);
  });
});

describe('D-125 P1.1 — ConnectionAuth shape', () => {
  // Compile-time discriminated-union exhaustiveness — each call
  // shape the spec mandates must inhabit the union. Failing to
  // type-check is the actual signal; the runtime asserts pin a
  // sample of each.
  it('admits a "none" auth (in-app notification, no creds)', () => {
    const auth: ConnectionAuth = { type: 'none' };
    expect(auth.type).toBe('none');
  });

  it('admits a bearer auth (api / mcp standard case)', () => {
    const auth: ConnectionAuth = { type: 'bearer', token: 'xoxb-…' };
    expect(auth.type).toBe('bearer');
  });

  it('admits a basic auth (legacy http endpoints)', () => {
    const auth: ConnectionAuth = { type: 'basic', username: 'u', password: 'p' };
    expect(auth.type).toBe('basic');
  });

  it('admits a header auth (custom auth-header schemes)', () => {
    const auth: ConnectionAuth = { type: 'header', headers: [{ header_name: 'X-Api-Key', value: 'k' }] };
    expect(auth.type).toBe('header');
  });

  it('admits a MULTI-header auth (e.g. Plaid PLAID-CLIENT-ID + PLAID-SECRET)', () => {
    const auth: ConnectionAuth = {
      type: 'header',
      headers: [
        { header_name: 'PLAID-CLIENT-ID', value: 'cid' },
        { header_name: 'PLAID-SECRET', value: 'sec' },
      ],
    };
    expect(auth.type).toBe('header');
    if (auth.type === 'header') expect(auth.headers).toHaveLength(2);
  });

  it('admits a query auth (api-key-as-query-param schemes)', () => {
    const auth: ConnectionAuth = { type: 'query', param_name: 'apikey', value: 'k' };
    expect(auth.type).toBe('query');
  });

  it('admits an oauth2_refresh auth (Google / MS Graph etc.)', () => {
    const auth: ConnectionAuth = {
      type: 'oauth2_refresh',
      refresh_token: 'r',
      client_id: 'c',
      token_endpoint: 'https://oauth2.example/token',
      token_auth_style: 'basic',
    };
    expect(auth.type).toBe('oauth2_refresh');
    expect(auth.token_auth_style).toBe('basic');
  });
});

describe('D-125 P1.1 — Resolver wiring', () => {
  // Build a per-pair connection store the way the runtime will
  // hydrate it at recipe-execution start: rows projected to views
  // with config fields spread top-level, auth fields excluded.
  const apiView: ConnectionView = {
    name: 'hubspot',
    kind: 'api',
    display_name: 'HubSpot Production',
    base_url: 'https://api.hubapi.com',
  };
  const mcpView: ConnectionView = {
    name: 'gh-mcp',
    kind: 'mcp',
    subtype: 'sse',
    display_name: 'GitHub MCP',
    endpoint: 'https://mcp.github.com/sse',
  };
  const slackView: ConnectionView = {
    name: 'team-slack',
    kind: 'notification',
    subtype: 'slack',
    display_name: 'Team Slack',
    channel_id: 'C1234567',
  };

  const connectionStore: ConnectionStore = {
    api: { hubspot: apiView },
    mcp: { 'gh-mcp': mcpView },
    notification: { 'team-slack': slackView },
  };

  const stores: NamespaceStores = {
    vault: {},
    config: {},
    context: {},
    meta: {},
    step: {},
    connection: connectionStore as unknown as Record<string, unknown>,
  };

  it('resolves connection.api.<name>.<field> to the spread config field', () => {
    expect(resolveRef('{{connection.api.hubspot.base_url}}', stores))
      .toBe('https://api.hubapi.com');
  });

  it('resolves connection.mcp.<name>.<field> to the spread config field', () => {
    expect(resolveRef('{{connection.mcp.gh-mcp.endpoint}}', stores))
      .toBe('https://mcp.github.com/sse');
  });

  it('resolves connection.notification.<name>.<field> to the spread config field', () => {
    expect(resolveRef('{{connection.notification.team-slack.channel_id}}', stores))
      .toBe('C1234567');
  });

  it('resolves connection.<kind>.<name>.subtype when present', () => {
    expect(resolveRef('{{connection.mcp.gh-mcp.subtype}}', stores)).toBe('sse');
    expect(resolveRef('{{connection.notification.team-slack.subtype}}', stores)).toBe('slack');
  });

  it('resolves connection.<kind>.<name>.display_name uniformly', () => {
    expect(resolveRef('{{connection.api.hubspot.display_name}}', stores))
      .toBe('HubSpot Production');
  });

  it('returns undefined for an unknown connection name', () => {
    expect(resolveRef('{{connection.api.salesforcedev.base_url}}', stores))
      .toBeUndefined();
  });

  it('returns undefined for an unknown connection kind', () => {
    // `webhook` is reserved for future categories that don't fit
    // the three current kinds — must resolve to undefined today.
    expect(resolveRef('{{connection.webhook.foo.url}}', stores))
      .toBeUndefined();
  });

  it('resolves to undefined when the connection store is omitted', () => {
    const empty: NamespaceStores = {
      vault: {}, config: {}, context: {}, meta: {}, step: {},
    };
    expect(resolveRef('{{connection.api.hubspot.base_url}}', empty))
      .toBeUndefined();
  });
});

describe('D-125 P1.1 — ConnectionView projection excludes auth', () => {
  // The spec § 1.6 mandates that the resolver view never exposes the
  // ConnectionAuth ciphertext — only the adapter (D-125 P3) decrypts
  // at call time. This is a structural assertion: the view interface
  // does NOT have an `auth` field. We pin it via a runtime check on
  // a row → view projection that mirrors what the runtime will do.
  const fullRecord: ConnectionRecord = {
    name: 'hubspot',
    kind: 'api',
    display_name: 'HubSpot Production',
    config: { base_url: 'https://api.hubapi.com' },
    auth: { type: 'bearer', token: 'SECRET-TOKEN-DO-NOT-LEAK' },
    enrolled_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
  };

  // Project the runtime way: spread config at the top, never include auth.
  const projectToView = (rec: ConnectionRecord): ConnectionView => ({
    name: rec.name,
    kind: rec.kind,
    subtype: rec.subtype,
    display_name: rec.display_name,
    ...rec.config,
  });

  it('omits auth from the projection', () => {
    const view = projectToView(fullRecord);
    expect((view as { auth?: unknown }).auth).toBeUndefined();
    // Belt + suspenders: scan all values for the secret string. Any
    // future projection bug that "helpfully" copies extra fields will
    // be caught here even if `auth` is not the literal key.
    const flat = JSON.stringify(view);
    expect(flat.includes('SECRET-TOKEN-DO-NOT-LEAK')).toBe(false);
  });

  it('exposes the spread config fields on the view', () => {
    const view = projectToView(fullRecord);
    expect(view.base_url).toBe('https://api.hubapi.com');
    expect(view.display_name).toBe('HubSpot Production');
    expect(view.kind).toBe('api');
  });
});

describe('validateHeaderAuthEntries (shared header-auth validator)', () => {
  it('accepts one or more proto-safe non-empty entries', () => {
    const one = validateHeaderAuthEntries([{ header_name: 'X-API-Key', value: 'k' }]);
    expect(one).toEqual({ ok: true, entries: [{ header_name: 'X-API-Key', value: 'k' }] });
    const two = validateHeaderAuthEntries([
      { header_name: 'PLAID-CLIENT-ID', value: 'cid' },
      { header_name: 'PLAID-SECRET', value: 'sec' },
    ]);
    expect(two.ok).toBe(true);
    if (two.ok) expect(two.entries).toHaveLength(2);
  });

  it('fails closed on every malformed shape with a typed issue', () => {
    expect(validateHeaderAuthEntries(undefined)).toEqual({ ok: false, issue: { code: 'not_array' } });
    expect(validateHeaderAuthEntries('x')).toEqual({ ok: false, issue: { code: 'not_array' } });
    expect(validateHeaderAuthEntries([])).toEqual({ ok: false, issue: { code: 'empty' } });
    expect(validateHeaderAuthEntries([{ value: 'v' }]))
      .toEqual({ ok: false, issue: { code: 'name_missing', index: 0 } });
    expect(validateHeaderAuthEntries([{ header_name: '  ', value: 'v' }]))
      .toEqual({ ok: false, issue: { code: 'name_missing', index: 0 } });
    expect(validateHeaderAuthEntries([{ header_name: 'X', value: '' }]))
      .toEqual({ ok: false, issue: { code: 'value_missing', index: 0 } });
    // an array-as-entry is not an object record → name_missing
    expect(validateHeaderAuthEntries([['header_name', 'X']]))
      .toEqual({ ok: false, issue: { code: 'name_missing', index: 0 } });
  });

  it('rejects prototype-sensitive header names (pollution guard)', () => {
    for (const bad of ['__proto__', 'constructor', 'prototype']) {
      expect(validateHeaderAuthEntries([{ header_name: bad, value: 'v' }]))
        .toEqual({ ok: false, issue: { code: 'name_reserved', index: 0 } });
    }
  });

  it('rejects an array longer than the cap', () => {
    const ok = Array.from({ length: MAX_HEADER_AUTH_ENTRIES }, (_, i) => ({ header_name: `H-${i}`, value: 'v' }));
    expect(validateHeaderAuthEntries(ok).ok).toBe(true);
    expect(validateHeaderAuthEntries([...ok, { header_name: 'H-extra', value: 'v' }]))
      .toEqual({ ok: false, issue: { code: 'too_many' } });
  });

  it('reads OWN properties only — an inherited header_name / value does NOT satisfy validation', () => {
    const inherited = Object.create({ header_name: 'X-Inherited', value: 'v' }) as Record<string, unknown>;
    expect(validateHeaderAuthEntries([inherited]))
      .toEqual({ ok: false, issue: { code: 'name_missing', index: 0 } });
  });
});

describe('resolveBearerAccessToken — the generic auth→token seam', () => {
  it('resolves a static `bearer` token (a HubSpot Service Key)', () => {
    expect(resolveBearerAccessToken({ type: 'bearer', token: 'pat-na1-svc' }))
      .toBe('pat-na1-svc');
  });

  it('resolves an `oauth2_refresh` current access token', () => {
    expect(resolveBearerAccessToken({
      type: 'oauth2_refresh',
      refresh_token: 'r',
      client_id: 'c',
      token_endpoint: 'https://x/token',
      current_access_token: 'tok_live',
    })).toBe('tok_live');
  });

  it('returns undefined for an oauth2_refresh with no/empty current token (pre-first-refresh)', () => {
    const base = {
      type: 'oauth2_refresh' as const,
      refresh_token: 'r',
      client_id: 'c',
      token_endpoint: 'https://x/token',
    };
    expect(resolveBearerAccessToken(base)).toBeUndefined();
    expect(resolveBearerAccessToken({ ...base, current_access_token: '' })).toBeUndefined();
  });

  it('returns undefined for a bearer with an empty token + for non-bearer auth types', () => {
    expect(resolveBearerAccessToken({ type: 'bearer', token: '' })).toBeUndefined();
    expect(resolveBearerAccessToken({ type: 'none' })).toBeUndefined();
    expect(resolveBearerAccessToken({ type: 'basic', username: 'u', password: 'p' })).toBeUndefined();
    expect(resolveBearerAccessToken({ type: 'query', param_name: 'k', value: 'v' })).toBeUndefined();
    expect(resolveBearerAccessToken({ type: 'header', headers: [{ header_name: 'X-Api', value: 'v' }] }))
      .toBeUndefined();
  });
});

/** D-129 Phase 1 — Vendor-flavored connection schema tests.
 *
 *  Covers:
 *  - HubSpot vendor schema fields land in the right order with the
 *    locked-discriminator + pre-filled-OAuth pattern.
 *  - VENDOR_CONNECTION_SCHEMAS registry exposes HubSpot at D-129.
 *  - resolveVendorSchema lookup semantics.
 *  - resolveConnectionSchema(kind, subtype, vendor) — vendor branch
 *    takes precedence + falls through to bare-kind on unknown vendor.
 *  - HUBSPOT_SCHEMA_INITIAL_VALUES seeds the form with the locked
 *    discriminator + OAuth endpoint pre-fills.
 *  - Picker rows render a HubSpot card. */

import { describe, expect, it } from 'vitest';

import {
  HUBSPOT_API_BASE,
  HUBSPOT_OAUTH_TOKEN_URL,
} from '@recued/contracts';

import {
  HUBSPOT_SCHEMA_INITIAL_VALUES,
  VENDOR_CONNECTION_CHOICES,
  VENDOR_CONNECTION_SCHEMAS,
  apiSchema,
  hubspotSchema,
  initialVendorSchemaValues,
  resolveConnectionSchema,
  resolveVendorSchema,
} from '../connection-schemas/index.js';
import { projectConnectionPayload } from '../connections/payload.js';

describe('D-129 P1 — hubspotSchema fields', () => {
  it('declares vendor segment + kind=api', () => {
    expect(hubspotSchema.vendor).toBe('hubspot');
    expect(hubspotSchema.kind).toBe('api');
  });

  it('exposes the user-facing label + description', () => {
    expect(hubspotSchema.label).toBe('HubSpot');
    expect(hubspotSchema.description).toContain('CRM platform');
  });

  it('offers a user-selectable auth.type: Service Key (bearer) + OAuth', () => {
    const authTypeField = hubspotSchema.fields.find((f) => f.key === 'auth.type');
    expect(authTypeField).toBeDefined();
    expect(authTypeField!.type).toBe('select');
    // `bearer` (Service Key) first → the default + recommended path.
    expect(authTypeField!.options).toEqual(['bearer', 'oauth2_refresh']);
    // User-selectable now (not a hidden lock).
    expect(authTypeField!.hidden).toBeFalsy();
  });

  it('offers a Service Key (bearer) field shown only in the bearer mode', () => {
    const svcKey = hubspotSchema.fields.find((f) => f.key === 'auth.token');
    expect(svcKey).toBeDefined();
    expect(svcKey!.type).toBe('secret');
    expect(svcKey!.showWhen!({ 'auth.type': 'bearer' })).toBe(true);
    expect(svcKey!.showWhen!({ 'auth.type': 'oauth2_refresh' })).toBe(false);
    // Default (no auth.type set) is the bearer path → Service Key shows.
    expect(svcKey!.showWhen!({})).toBe(true);
  });

  it('carries the config.vendor discriminator field', () => {
    const vendorField = hubspotSchema.fields.find((f) => f.key === 'config.vendor');
    expect(vendorField).toBeDefined();
    expect(vendorField!.hidden).toBe(true);
  });

  it('gates the OAuth fields behind the oauth2_refresh mode', () => {
    const tokenEndpointField = hubspotSchema.fields.find((f) => f.key === 'auth.token_endpoint');
    expect(tokenEndpointField!.hidden).toBe(true); // still a fixed default
    for (const key of ['auth.client_id', 'auth.client_secret', 'auth.refresh_token', 'auth.token_endpoint']) {
      const field = hubspotSchema.fields.find((f) => f.key === key)!;
      expect(field.showWhen!({ 'auth.type': 'oauth2_refresh' })).toBe(true);
      // Hidden (+ dropped from the payload) in the Service Key mode.
      expect(field.showWhen!({ 'auth.type': 'bearer' })).toBe(false);
    }
  });

  it('asks the user for client_id + client_secret + refresh_token', () => {
    const keys = hubspotSchema.fields.map((f) => f.key);
    expect(keys).toContain('auth.client_id');
    expect(keys).toContain('auth.client_secret');
    expect(keys).toContain('auth.refresh_token');
  });

  it('marks client_secret + refresh_token as secret-typed inputs', () => {
    const clientSecret = hubspotSchema.fields.find((f) => f.key === 'auth.client_secret');
    const refreshToken = hubspotSchema.fields.find((f) => f.key === 'auth.refresh_token');
    expect(clientSecret!.type).toBe('secret');
    expect(refreshToken!.type).toBe('secret');
  });

  it('renders before-OAuth fields (name + display) at the top', () => {
    const firstTwo = hubspotSchema.fields.slice(0, 2).map((f) => f.key);
    expect(firstTwo).toEqual(['name', 'display_name']);
  });
});

describe('D-129 P1 — HUBSPOT_SCHEMA_INITIAL_VALUES', () => {
  it('locks the vendor discriminator to hubspot', () => {
    expect(HUBSPOT_SCHEMA_INITIAL_VALUES['config.vendor']).toBe('hubspot');
  });

  it('pre-fills config.base_url to the production HubSpot API root', () => {
    expect(HUBSPOT_SCHEMA_INITIAL_VALUES['config.base_url']).toBe(HUBSPOT_API_BASE);
  });

  it('defaults auth.type to the Service Key (bearer) path + seeds the token endpoint', () => {
    expect(HUBSPOT_SCHEMA_INITIAL_VALUES['auth.type']).toBe('bearer');
    // Seeded so switching to the OAuth mode renders the fixed endpoint.
    expect(HUBSPOT_SCHEMA_INITIAL_VALUES['auth.token_endpoint']).toBe(HUBSPOT_OAUTH_TOKEN_URL);
  });

  it('does not pre-fill any secret fields', () => {
    expect(HUBSPOT_SCHEMA_INITIAL_VALUES['auth.client_secret']).toBeUndefined();
    expect(HUBSPOT_SCHEMA_INITIAL_VALUES['auth.refresh_token']).toBeUndefined();
    expect(HUBSPOT_SCHEMA_INITIAL_VALUES['auth.client_id']).toBeUndefined();
  });
});

describe('D-129 P1 — VENDOR_CONNECTION_SCHEMAS registry', () => {
  it('exposes hubspot at D-129; D-130 widens with salesforce', () => {
    expect(Object.keys(VENDOR_CONNECTION_SCHEMAS)).toContain('hubspot');
  });

  it('hubspot key resolves to the hubspotSchema object', () => {
    expect(VENDOR_CONNECTION_SCHEMAS.hubspot).toBe(hubspotSchema);
  });
});

describe('D-129 P1 — resolveVendorSchema', () => {
  it('returns the HubSpot schema for vendor=hubspot', () => {
    expect(resolveVendorSchema('hubspot')).toBe(hubspotSchema);
  });

  it('returns undefined for unknown vendors', () => {
    expect(resolveVendorSchema('unknownvendor')).toBeUndefined();
    expect(resolveVendorSchema('nonsense')).toBeUndefined();
    expect(resolveVendorSchema('')).toBeUndefined();
  });
});

describe('D-129 P1 — initialVendorSchemaValues', () => {
  it('returns the HubSpot initial values for vendor=hubspot', () => {
    expect(initialVendorSchemaValues('hubspot')).toBe(HUBSPOT_SCHEMA_INITIAL_VALUES);
  });

  it('returns an empty record for unknown vendors so callers can spread unconditionally', () => {
    expect(initialVendorSchemaValues('unknownvendor')).toEqual({});
    expect(initialVendorSchemaValues('')).toEqual({});
  });
});

describe('D-129 P1 — resolveConnectionSchema(kind, subtype, vendor)', () => {
  it('vendor branch takes precedence when set + registered', () => {
    expect(resolveConnectionSchema('api', undefined, 'hubspot')).toBe(hubspotSchema);
  });

  it('bare-kind path unchanged when vendor is undefined', () => {
    expect(resolveConnectionSchema('api')).toBe(apiSchema);
  });

  it('falls through to bare api schema when vendor is unknown', () => {
    expect(resolveConnectionSchema('api', undefined, 'unknownvendor')).toBe(apiSchema);
  });

  it('vendor segment is ignored on non-api kinds (no vendor schema for mcp/notification today)', () => {
    expect(resolveConnectionSchema('mcp', 'sse', 'hubspot' as string)).toBeDefined();
    expect(resolveConnectionSchema('mcp', 'sse', 'hubspot' as string)?.kind).toBe('mcp');
  });
});

describe('D-129 P1 — VENDOR_CONNECTION_CHOICES picker rows', () => {
  it('renders a HubSpot card; D-130 widens with a Salesforce card', () => {
    const segments = VENDOR_CONNECTION_CHOICES.map((c) => c.vendor);
    expect(segments).toContain('hubspot');
  });

  it('HubSpot label + description mirror the schema metadata', () => {
    const hubspotChoice = VENDOR_CONNECTION_CHOICES.find((c) => c.vendor === 'hubspot')!;
    expect(hubspotChoice.label).toBe(hubspotSchema.label);
    expect(hubspotChoice.description).toBe(hubspotSchema.description);
  });
});

describe('D-129 — HubSpot Service Key (bearer) enrollment projects a clean bearer payload', () => {
  it('projects { auth: { type: bearer, token } } + drops the OAuth fields', () => {
    const payload = projectConnectionPayload(
      hubspotSchema,
      {
        ...HUBSPOT_SCHEMA_INITIAL_VALUES, // seeds vendor / base_url / auth.type=bearer / token_endpoint
        name: 'hubspot',
        display_name: 'HubSpot',
        'auth.token': 'pat-na1-service-key-xyz',
        // Even if stale OAuth values linger in the form, showWhen drops them.
        'auth.client_id': 'should-be-dropped',
        'auth.refresh_token': 'should-be-dropped',
      },
      'api',
      null,
    );
    expect(payload.auth).toEqual({ type: 'bearer', token: 'pat-na1-service-key-xyz' });
    expect(payload.config).toMatchObject({ vendor: 'hubspot', base_url: HUBSPOT_API_BASE });
    // The OAuth fields never rode into the payload (showWhen dropped them).
    const authKeys = Object.keys(payload.auth as Record<string, unknown>);
    expect(authKeys).not.toContain('client_id');
    expect(authKeys).not.toContain('refresh_token');
    expect(authKeys).not.toContain('token_endpoint');
  });

  it('the OAuth mode still projects an oauth2_refresh payload (no regression)', () => {
    const payload = projectConnectionPayload(
      hubspotSchema,
      {
        ...HUBSPOT_SCHEMA_INITIAL_VALUES,
        name: 'hubspot',
        display_name: 'HubSpot',
        'auth.type': 'oauth2_refresh',
        'auth.client_id': 'cid',
        'auth.client_secret': 'csecret',
        'auth.refresh_token': 'rtok',
      },
      'api',
      null,
    );
    expect(payload.auth).toMatchObject({
      type: 'oauth2_refresh',
      client_id: 'cid',
      refresh_token: 'rtok',
      token_endpoint: HUBSPOT_OAUTH_TOKEN_URL,
    });
    // The Service Key field never rode into the OAuth payload.
    expect((payload.auth as Record<string, unknown>).token).toBeUndefined();
  });
});

describe('D-192 S5 — VENDOR_CONNECTION_CHOICES + initialValues are registry-derived', () => {
  it('renders exactly one picker card per registered schema, in registry order', () => {
    // Derived from VENDOR_CONNECTION_SCHEMAS via Object.entries, so adding a
    // vendor is ONE registry entry — no separate hand-widened choices array to
    // keep in sync (the de-hardcode point).
    expect(VENDOR_CONNECTION_CHOICES.map((c) => c.vendor)).toEqual(
      Object.keys(VENDOR_CONNECTION_SCHEMAS),
    );
  });

  it("each choice's label + description mirror its schema", () => {
    for (const choice of VENDOR_CONNECTION_CHOICES) {
      const schema = resolveVendorSchema(choice.vendor)!;
      expect(choice.label).toBe(schema.label);
      expect(choice.description).toBe(schema.description);
    }
  });

  it('initialVendorSchemaValues reads the schema-attached initialValues (same reference)', () => {
    for (const vendor of Object.keys(VENDOR_CONNECTION_SCHEMAS)) {
      const schema = resolveVendorSchema(vendor)!;
      expect(schema.initialValues).toBeDefined();
      expect(initialVendorSchemaValues(vendor)).toBe(schema.initialValues);
    }
    // hubspot's is the exact exported const, not a copy.
    expect(initialVendorSchemaValues('hubspot')).toBe(HUBSPOT_SCHEMA_INITIAL_VALUES);
  });
});

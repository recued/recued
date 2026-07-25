/** D-130 Phase 1 — Salesforce vendor-flavored connection schema tests.
 *
 *  Covers:
 *  - Salesforce schema fields land in the right order with sandbox
 *    toggle + production-default token endpoint.
 *  - VENDOR_CONNECTION_SCHEMAS registry exposes both HubSpot +
 *    Salesforce at D-130.
 *  - resolveVendorSchema('salesforce') resolves the new entry.
 *  - SALESFORCE_SCHEMA_INITIAL_VALUES seeds the form with the
 *    discriminator + sandbox=production default + production
 *    token endpoint.
 *  - The dual `auth.token_endpoint` showWhen rows render the right
 *    placeholder per sandbox-flag value (only one row visible).
 *  - Picker rows render both vendor cards.
 *  - resolveConnectionSchema('api', undefined, 'salesforce') resolves
 *    Salesforce now that it's registered (was a fall-through case
 *    in D-129's tests). */

import { describe, expect, it } from 'vitest';

import {
  PIPEDRIVE_API_BASE,
  PIPEDRIVE_OAUTH_TOKEN_URL,
  SALESFORCE_API_BASE_PLACEHOLDER,
  SALESFORCE_OAUTH_TOKEN_URL_PRODUCTION,
  SALESFORCE_OAUTH_TOKEN_URL_SANDBOX,
} from '@recued/contracts';

import {
  SALESFORCE_SCHEMA_INITIAL_VALUES,
  VENDOR_CONNECTION_CHOICES,
  VENDOR_CONNECTION_SCHEMAS,
  apiSchema,
  applyVendorOAuthResultValues,
  hubspotSchema,
  initialVendorSchemaValues,
  isVendorSandboxSelected,
  PIPEDRIVE_SCHEMA_INITIAL_VALUES,
  pipedriveSchema,
  resolveConnectionSchema,
  resolveVendorSchema,
  salesforceSchema,
  syncVendorOAuthEndpointValue,
} from '../connection-schemas/index.js';

describe('D-130 P1 — salesforceSchema fields', () => {
  it('declares vendor segment + kind=api', () => {
    expect(salesforceSchema.vendor).toBe('salesforce');
    expect(salesforceSchema.kind).toBe('api');
  });

  it('exposes the user-facing label + description', () => {
    expect(salesforceSchema.label).toBe('Salesforce');
    expect(salesforceSchema.description).toContain('CRM platform');
  });

  it('locks auth.type to oauth2_refresh (single option)', () => {
    const authTypeField = salesforceSchema.fields.find((f) => f.key === 'auth.type');
    expect(authTypeField).toBeDefined();
    expect(authTypeField!.type).toBe('select');
    expect(authTypeField!.options).toEqual(['oauth2_refresh']);
  });

  it('carries the config.vendor discriminator field', () => {
    const vendorField = salesforceSchema.fields.find((f) => f.key === 'config.vendor');
    expect(vendorField).toBeDefined();
    expect(vendorField!.hidden).toBe(true);
  });

  it('carries the config.sandbox toggle with production + sandbox options', () => {
    const sandboxField = salesforceSchema.fields.find((f) => f.key === 'config.sandbox');
    expect(sandboxField).toBeDefined();
    expect(sandboxField!.type).toBe('select');
    expect(sandboxField!.options).toEqual(['production', 'sandbox']);
  });

  it('asks the user for client_id + client_secret + refresh_token', () => {
    const keys = salesforceSchema.fields.map((f) => f.key);
    expect(keys).toContain('auth.client_id');
    expect(keys).toContain('auth.client_secret');
    expect(keys).toContain('auth.refresh_token');
  });

  it('keeps provider-owned OAuth/base-url fields locked in the rendered form', () => {
    const authTypeField = salesforceSchema.fields.find((f) => f.key === 'auth.type');
    const tokenFields = salesforceSchema.fields.filter((f) => f.key === 'auth.token_endpoint');
    const baseUrlField = salesforceSchema.fields.find((f) => f.key === 'config.base_url');
    expect(authTypeField!.hidden).toBe(true);
    expect(tokenFields.every((f) => f.hidden)).toBe(true);
    expect(baseUrlField!.readonly).toBe(true);
  });

  it('marks client_secret + refresh_token as secret-typed inputs', () => {
    const clientSecret = salesforceSchema.fields.find((f) => f.key === 'auth.client_secret');
    const refreshToken = salesforceSchema.fields.find((f) => f.key === 'auth.refresh_token');
    expect(clientSecret!.type).toBe('secret');
    expect(refreshToken!.type).toBe('secret');
  });

  it('renders before-OAuth fields (name + display) at the top', () => {
    const firstTwo = salesforceSchema.fields.slice(0, 2).map((f) => f.key);
    expect(firstTwo).toEqual(['name', 'display_name']);
  });

  it('declares a paired auth.token_endpoint with showWhen for sandbox vs production', () => {
    const tokenFields = salesforceSchema.fields.filter((f) => f.key === 'auth.token_endpoint');
    expect(tokenFields).toHaveLength(2);
    // First row — production. Visible when sandbox flag is unset / production.
    expect(tokenFields[0].placeholder).toBe(SALESFORCE_OAUTH_TOKEN_URL_PRODUCTION);
    expect(tokenFields[0].showWhen?.({ 'config.sandbox': 'production' })).toBe(true);
    expect(tokenFields[0].showWhen?.({ 'config.sandbox': 'sandbox' })).toBe(false);
    expect(tokenFields[0].showWhen?.({})).toBe(true);
    // Second row — sandbox. Visible only when sandbox flag is 'sandbox'.
    expect(tokenFields[1].placeholder).toBe(SALESFORCE_OAUTH_TOKEN_URL_SANDBOX);
    expect(tokenFields[1].showWhen?.({ 'config.sandbox': 'sandbox' })).toBe(true);
    expect(tokenFields[1].showWhen?.({ 'config.sandbox': 'production' })).toBe(false);
    expect(tokenFields[1].showWhen?.({})).toBe(false);
  });
});

describe('D-130 P1 — SALESFORCE_SCHEMA_INITIAL_VALUES', () => {
  it('locks the vendor discriminator to salesforce', () => {
    expect(SALESFORCE_SCHEMA_INITIAL_VALUES['config.vendor']).toBe('salesforce');
  });

  it('defaults config.sandbox to production', () => {
    expect(SALESFORCE_SCHEMA_INITIAL_VALUES['config.sandbox']).toBe('production');
  });

  it('pre-fills config.base_url to the Salesforce production OAuth host placeholder', () => {
    expect(SALESFORCE_SCHEMA_INITIAL_VALUES['config.base_url']).toBe(SALESFORCE_API_BASE_PLACEHOLDER);
  });

  it('pre-fills auth.type to oauth2_refresh + the production token endpoint', () => {
    expect(SALESFORCE_SCHEMA_INITIAL_VALUES['auth.type']).toBe('oauth2_refresh');
    expect(SALESFORCE_SCHEMA_INITIAL_VALUES['auth.token_endpoint']).toBe(
      SALESFORCE_OAUTH_TOKEN_URL_PRODUCTION,
    );
  });

  it('does not pre-fill any secret fields', () => {
    expect(SALESFORCE_SCHEMA_INITIAL_VALUES['auth.client_secret']).toBeUndefined();
    expect(SALESFORCE_SCHEMA_INITIAL_VALUES['auth.refresh_token']).toBeUndefined();
    expect(SALESFORCE_SCHEMA_INITIAL_VALUES['auth.client_id']).toBeUndefined();
  });
});

describe('D-130 P1 — VENDOR_CONNECTION_SCHEMAS registry', () => {
  it('contains hubspot + salesforce plus later CRM/finance vendor wedges', () => {
    const keys = Object.keys(VENDOR_CONNECTION_SCHEMAS);
    expect(keys).toContain('hubspot');
    expect(keys).toContain('salesforce');
    expect(keys).toContain('pipedrive');
  });

  it('salesforce key resolves to the salesforceSchema object', () => {
    expect(VENDOR_CONNECTION_SCHEMAS.salesforce).toBe(salesforceSchema);
  });

  it('hubspot key still resolves (D-129 entry untouched)', () => {
    expect(VENDOR_CONNECTION_SCHEMAS.hubspot).toBe(hubspotSchema);
  });

  it('pipedrive key resolves to the pipedriveSchema object', () => {
    expect(VENDOR_CONNECTION_SCHEMAS.pipedrive).toBe(pipedriveSchema);
  });
});

describe('D-130 P1 — resolveVendorSchema', () => {
  it('returns the Salesforce schema for vendor=salesforce', () => {
    expect(resolveVendorSchema('salesforce')).toBe(salesforceSchema);
  });

  it('still returns HubSpot for vendor=hubspot', () => {
    expect(resolveVendorSchema('hubspot')).toBe(hubspotSchema);
  });

  it('returns Pipedrive for vendor=pipedrive', () => {
    expect(resolveVendorSchema('pipedrive')).toBe(pipedriveSchema);
  });

  it('returns undefined for unknown vendors', () => {
    expect(resolveVendorSchema('nonsense')).toBeUndefined();
    expect(resolveVendorSchema('')).toBeUndefined();
  });
});

describe('D-130 P1 — initialVendorSchemaValues', () => {
  it('returns the Salesforce initial values for vendor=salesforce', () => {
    expect(initialVendorSchemaValues('salesforce')).toBe(SALESFORCE_SCHEMA_INITIAL_VALUES);
  });

  it('returns the Pipedrive initial values for vendor=pipedrive', () => {
    expect(initialVendorSchemaValues('pipedrive')).toBe(PIPEDRIVE_SCHEMA_INITIAL_VALUES);
    expect(PIPEDRIVE_SCHEMA_INITIAL_VALUES['config.base_url']).toBe(PIPEDRIVE_API_BASE);
    expect(PIPEDRIVE_SCHEMA_INITIAL_VALUES['auth.token_endpoint']).toBe(PIPEDRIVE_OAUTH_TOKEN_URL);
    expect(PIPEDRIVE_SCHEMA_INITIAL_VALUES['auth.token_auth_style']).toBe('basic');
  });

  it('returns an empty record for unknown vendors so callers can spread unconditionally', () => {
    expect(initialVendorSchemaValues('unknownvendor')).toEqual({});
    expect(initialVendorSchemaValues('')).toEqual({});
  });
});

describe('D-130 P1 — syncVendorOAuthEndpointValue', () => {
  it('keeps Salesforce production values on the production token endpoint', () => {
    const values = syncVendorOAuthEndpointValue('salesforce', {
      ...SALESFORCE_SCHEMA_INITIAL_VALUES,
      'config.sandbox': 'production',
    });
    expect(isVendorSandboxSelected(values)).toBe(false);
    expect(values['auth.token_endpoint']).toBe(SALESFORCE_OAUTH_TOKEN_URL_PRODUCTION);
  });

  it('switches Salesforce sandbox values to the sandbox token endpoint', () => {
    const values = syncVendorOAuthEndpointValue('salesforce', {
      ...SALESFORCE_SCHEMA_INITIAL_VALUES,
      'config.sandbox': 'sandbox',
    });
    expect(isVendorSandboxSelected(values)).toBe(true);
    expect(values['auth.token_endpoint']).toBe(SALESFORCE_OAUTH_TOKEN_URL_SANDBOX);
  });

  it('leaves unknown vendors unchanged', () => {
    const input = {
      'config.vendor': 'unknownvendor',
      'auth.token_endpoint': 'https://example.com/token',
    };
    expect(syncVendorOAuthEndpointValue('unknownvendor', input)).toBe(input);
  });
});

describe('D-130 P1 — applyVendorOAuthResultValues', () => {
  it('pins Salesforce sandbox OAuth results to sandbox endpoint + instance_url', () => {
    const values = applyVendorOAuthResultValues(
      'salesforce',
      {
        ...SALESFORCE_SCHEMA_INITIAL_VALUES,
        'config.sandbox': 'sandbox',
        'auth.token_endpoint': SALESFORCE_OAUTH_TOKEN_URL_PRODUCTION,
      },
      {
        refresh_token: 'refresh-sandbox',
        instance_url: 'https://mycompany--sandbox.sandbox.my.salesforce.com',
      },
      { sandbox: true },
    );

    expect(values['config.sandbox']).toBe('sandbox');
    expect(values['auth.token_endpoint']).toBe(SALESFORCE_OAUTH_TOKEN_URL_SANDBOX);
    expect(values['auth.refresh_token']).toBe('refresh-sandbox');
    expect(values['config.base_url']).toBe(
      'https://mycompany--sandbox.sandbox.my.salesforce.com',
    );
  });

  it('does not invent config.sandbox for vendors without a sandbox split', () => {
    const values = applyVendorOAuthResultValues(
      'hubspot',
      { 'config.vendor': 'hubspot', 'auth.token_endpoint': 'stale' },
      { refresh_token: 'refresh-hubspot' },
    );

    expect(values['auth.refresh_token']).toBe('refresh-hubspot');
    expect(values['config.sandbox']).toBeUndefined();
  });
});

describe('D-130 P1 — resolveConnectionSchema(kind, subtype, vendor)', () => {
  it('resolves Salesforce now that it is registered (was bare-api fall-through pre-D-130)', () => {
    expect(resolveConnectionSchema('api', undefined, 'salesforce')).toBe(salesforceSchema);
  });

  it('still resolves HubSpot via vendor branch', () => {
    expect(resolveConnectionSchema('api', undefined, 'hubspot')).toBe(hubspotSchema);
  });

  it('resolves Pipedrive via vendor branch', () => {
    expect(resolveConnectionSchema('api', undefined, 'pipedrive')).toBe(pipedriveSchema);
  });

  it('falls through to bare api schema when vendor is unknown', () => {
    expect(resolveConnectionSchema('api', undefined, 'unknownvendor')).toBe(apiSchema);
  });
});

describe('D-130 P1 — VENDOR_CONNECTION_CHOICES picker rows', () => {
  it('renders HubSpot + Salesforce + Pipedrive cards', () => {
    const segments = VENDOR_CONNECTION_CHOICES.map((c) => c.vendor);
    expect(segments).toContain('hubspot');
    expect(segments).toContain('salesforce');
    expect(segments).toContain('pipedrive');
  });

  it('Salesforce label + description mirror the schema metadata', () => {
    const choice = VENDOR_CONNECTION_CHOICES.find((c) => c.vendor === 'salesforce')!;
    expect(choice.label).toBe(salesforceSchema.label);
    expect(choice.description).toBe(salesforceSchema.description);
  });
});

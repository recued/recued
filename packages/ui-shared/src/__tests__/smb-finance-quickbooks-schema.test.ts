/** SMB-finance wedge slice 1b — QuickBooks Online vendor connection schema.
 *
 *  QBO mirrors the Salesforce sandbox-toggle + readonly-base_url shape, but:
 *  shares ONE OAuth token endpoint (no showWhen pair) and the sandbox flag
 *  selects the API HOST (via the provider `realm_base`), with `config.base_url`
 *  composed from the OAuth callback realmId. */

import { describe, expect, it } from 'vitest';
import {
  QUICKBOOKS_API_BASE_PLACEHOLDER,
  QUICKBOOKS_OAUTH_TOKEN_URL,
} from '@recued/contracts';
import {
  VENDOR_CONNECTION_SCHEMAS,
  VENDOR_CONNECTION_CHOICES,
  resolveVendorSchema,
  initialVendorSchemaValues,
  quickbooksSchema,
  QUICKBOOKS_SCHEMA_INITIAL_VALUES,
} from '../connection-schemas/index.js';

describe('SMB-finance slice 1b — quickbooksSchema', () => {
  it('is registered + resolvable + in the picker', () => {
    expect(VENDOR_CONNECTION_SCHEMAS.quickbooks).toBe(quickbooksSchema);
    expect(resolveVendorSchema('quickbooks')).toBe(quickbooksSchema);
    expect(VENDOR_CONNECTION_CHOICES.map((c) => c.vendor)).toContain('quickbooks');
  });

  it('declares vendor=quickbooks + kind=api', () => {
    expect(quickbooksSchema.vendor).toBe('quickbooks');
    expect(quickbooksSchema.kind).toBe('api');
  });

  it('locks the config.vendor discriminator (hidden)', () => {
    const f = quickbooksSchema.fields.find((x) => x.key === 'config.vendor');
    expect(f?.hidden).toBe(true);
    expect(QUICKBOOKS_SCHEMA_INITIAL_VALUES['config.vendor']).toBe('quickbooks');
  });

  it('ships a sandbox/production environment toggle', () => {
    const f = quickbooksSchema.fields.find((x) => x.key === 'config.sandbox');
    expect(f?.type).toBe('select');
    expect(f?.options).toEqual(['production', 'sandbox']);
  });

  it('captures config.base_url read-only (composed from the OAuth callback realmId)', () => {
    const f = quickbooksSchema.fields.find((x) => x.key === 'config.base_url');
    expect(f?.readonly).toBe(true);
    expect(f?.placeholder).toBe(QUICKBOOKS_API_BASE_PLACEHOLDER);
  });

  it('has a SINGLE fixed token endpoint (no sandbox showWhen pair, unlike Salesforce)', () => {
    const tokenFields = quickbooksSchema.fields.filter((x) => x.key === 'auth.token_endpoint');
    expect(tokenFields).toHaveLength(1);
    expect(tokenFields[0].showWhen).toBeUndefined();
    expect(QUICKBOOKS_SCHEMA_INITIAL_VALUES['auth.token_endpoint']).toBe(QUICKBOOKS_OAUTH_TOKEN_URL);
  });

  it('exposes initial values via initialVendorSchemaValues', () => {
    expect(initialVendorSchemaValues('quickbooks')).toBe(QUICKBOOKS_SCHEMA_INITIAL_VALUES);
  });
});

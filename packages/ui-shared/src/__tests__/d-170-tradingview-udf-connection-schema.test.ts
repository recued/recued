import { describe, expect, it } from 'vitest';

import {
  TRADINGVIEW_UDF_DEMO_BASE,
  TRADINGVIEW_UDF_SCHEMA_INITIAL_VALUES,
  VENDOR_CONNECTION_CHOICES,
  initialVendorSchemaValues,
  resolveConnectionSchema,
  resolveVendorSchema,
  tradingviewUdfSchema,
} from '../connection-schemas/index.js';
import { projectConnectionPayload } from '../connections/payload.js';
import { validateConnectionForm } from '../connections/page.js';

const field = (key: string) =>
  tradingviewUdfSchema.fields.find((candidate) => candidate.key === key);

describe('TradingView UDF connection enrollment', () => {
  it('is registered for pack deep links with friendly demo defaults', () => {
    expect(resolveVendorSchema('tradingview_udf')).toBe(tradingviewUdfSchema);
    expect(resolveConnectionSchema('api', undefined, 'tradingview_udf'))
      .toBe(tradingviewUdfSchema);
    expect(initialVendorSchemaValues('tradingview_udf'))
      .toBe(TRADINGVIEW_UDF_SCHEMA_INITIAL_VALUES);
    expect(VENDOR_CONNECTION_CHOICES).toContainEqual({
      vendor: 'tradingview_udf',
      label: 'TradingView UDF Datafeed',
      description: tradingviewUdfSchema.description,
    });
  });

  it('defaults to the public demo with real auth.type=none', () => {
    expect(TRADINGVIEW_UDF_SCHEMA_INITIAL_VALUES).toEqual({
      name: 'tradingview',
      display_name: 'TradingView UDF demo',
      'config.vendor': 'tradingview_udf',
      'config.base_url': TRADINGVIEW_UDF_DEMO_BASE,
      'auth.type': 'none',
    });
    expect(field('auth.type')?.options).toEqual([
      'none',
      'bearer',
      'basic',
      'header',
      'query',
    ]);
    expect(tradingviewUdfSchema.probe).toEqual({
      method: 'GET',
      path: '/config',
      description: 'Read the datafeed capabilities advertised by its UDF config.',
    });
  });

  it('validates and projects the no-auth demo enrollment exactly', () => {
    const values = { ...TRADINGVIEW_UDF_SCHEMA_INITIAL_VALUES };

    expect(validateConnectionForm(
      tradingviewUdfSchema,
      values,
      undefined,
      'create',
    )).toBeNull();
    expect(projectConnectionPayload(
      tradingviewUdfSchema,
      values,
      'api',
      null,
    )).toEqual({
      name: 'tradingview',
      kind: 'api',
      display_name: 'TradingView UDF demo',
      config: {
        vendor: 'tradingview_udf',
        base_url: TRADINGVIEW_UDF_DEMO_BASE,
      },
      auth: { type: 'none' },
    });
  });

  it('supports a protected UDF server without exposing unrelated auth fields', () => {
    const values = {
      ...TRADINGVIEW_UDF_SCHEMA_INITIAL_VALUES,
      display_name: 'Private market data',
      'config.base_url': 'https://feed.example.com',
      'auth.type': 'bearer',
      'auth.token': 'private-feed-token',
      'auth.username': 'must-not-leak',
    };

    expect(validateConnectionForm(
      tradingviewUdfSchema,
      values,
      undefined,
      'create',
    )).toBeNull();
    expect(projectConnectionPayload(
      tradingviewUdfSchema,
      values,
      'api',
      null,
    )).toMatchObject({
      config: {
        vendor: 'tradingview_udf',
        base_url: 'https://feed.example.com',
      },
      auth: {
        type: 'bearer',
        token: 'private-feed-token',
      },
    });
    expect(projectConnectionPayload(
      tradingviewUdfSchema,
      values,
      'api',
      null,
    ).auth).not.toHaveProperty('username');
  });

  it('does not claim OAuth modes that UDF does not define', () => {
    expect(field('auth.type')?.options).not.toContain('oauth2_refresh');
    expect(field('auth.type')?.options).not.toContain('oauth2_client_credentials');
  });
});

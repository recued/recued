/** TradingView UDF datafeed enrollment.
 *
 * TradingView's UDF protocol is an HTTP contract implemented by the datafeed
 * operator; it is not a TradingView-account API. The official demo feed is
 * public, so this schema adds the `none` auth mode that the generic API form
 * intentionally omits. Operators may still put a UDF server behind a static
 * bearer/basic/header/query credential, so those generic fields remain
 * available. OAuth is deliberately excluded: UDF does not define it, and this
 * vendor has no registered OAuth provider.
 */

import { apiSchema } from '../api.js';
import type { ConnectionField } from '../types.js';
import type { VendorConnectionSchema } from './hubspot.js';

export const TRADINGVIEW_UDF_DEMO_BASE =
  'https://demo-feed-data.tradingview.com';

const TRADINGVIEW_UDF_AUTH_TYPES = [
  'none',
  'bearer',
  'basic',
  'header',
  'query',
] as const;

const TRADINGVIEW_UDF_FIELDS: readonly ConnectionField[] = apiSchema.fields
  .filter((field) => field.key !== 'subresource_path')
  .map((field): ConnectionField => {
    switch (field.key) {
      case 'name':
        return {
          ...field,
          help:
            'Lowercase identifier used in recipes (for example `tradingview` '
            + 'or `market-data`).',
          placeholder: 'tradingview',
        };
      case 'display_name':
        return {
          ...field,
          placeholder: 'TradingView UDF demo',
        };
      case 'config.base_url':
        return {
          ...field,
          placeholder: TRADINGVIEW_UDF_DEMO_BASE,
          help:
            'HTTPS root of a UDF-compatible datafeed. The prefilled TradingView '
            + 'demo is useful for evaluation but can contain sample, delayed, '
            + 'or stale market data.',
        };
      case 'config.vendor':
        return {
          ...field,
          optional: false,
          help: 'TradingView UDF vendor identifier — locked at enrollment.',
        };
      case 'auth.type':
        return {
          ...field,
          options: TRADINGVIEW_UDF_AUTH_TYPES,
          help:
            'The official demo needs no credential. For a protected UDF server, '
            + 'choose its static bearer, basic, header, or query authentication.',
        };
      default:
        return field;
    }
  });

export const TRADINGVIEW_UDF_SCHEMA_INITIAL_VALUES: Readonly<
  Record<string, string>
> = {
  name: 'tradingview',
  display_name: 'TradingView UDF demo',
  'config.vendor': 'tradingview_udf',
  'config.base_url': TRADINGVIEW_UDF_DEMO_BASE,
  'auth.type': 'none',
};

export const tradingviewUdfSchema: VendorConnectionSchema = {
  vendor: 'tradingview_udf',
  kind: 'api',
  label: 'TradingView UDF Datafeed',
  description:
    'Read symbols, quotes, and chart history from a UDF-compatible market-data '
    + 'server. Defaults to TradingView\'s public demo; no TradingView login is used.',
  fields: TRADINGVIEW_UDF_FIELDS,
  initialValues: TRADINGVIEW_UDF_SCHEMA_INITIAL_VALUES,
  probe: {
    method: 'GET',
    path: '/config',
    description: 'Read the datafeed capabilities advertised by its UDF config.',
  },
};

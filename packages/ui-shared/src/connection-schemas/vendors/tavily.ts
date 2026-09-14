/** Tavily API enrollment.
 *
 * Tavily exposes one fixed API origin and authenticates with a bearer API key.
 * This schema keeps the known origin visible but read-only, locks the vendor and
 * auth discriminators, and asks only for the key the user obtains from
 * app.tavily.com. There is no OAuth provider or automatic probe: the cheapest
 * authenticated content calls consume credits, while /usage exposes private
 * account information.
 */

import type { ConnectionField } from '../types.js';
import type { VendorConnectionSchema } from './hubspot.js';

export const TAVILY_API_BASE = 'https://api.tavily.com';

const TAVILY_FIELDS: readonly ConnectionField[] = [
  {
    key: 'name',
    label: 'Name',
    type: 'identifier',
    help: 'A short lower-case name you use in Recipes, such as `tavily`).',
    placeholder: 'tavily',
  },
  {
    key: 'display_name',
    label: 'Display Name',
    type: 'text',
    placeholder: 'Tavily',
  },
  {
    key: 'config.vendor',
    label: 'Vendor',
    type: 'text',
    help: 'Tavily sets this when you connect. You cannot change it.',
    hidden: true,
  },
  {
    key: 'config.base_url',
    label: 'API Base URL',
    type: 'url',
    help: 'Tavily API origin — fixed by this pack and not sent to another host.',
    readonly: true,
  },
  {
    key: 'auth.type',
    label: 'Auth Type',
    type: 'select',
    options: ['bearer'],
    help: 'Tavily authenticates with a bearer API key.',
    hidden: true,
  },
  {
    key: 'auth.token',
    label: 'Tavily API Key',
    type: 'secret',
    placeholder: 'tvly-…',
    help:
      'Paste the API key from app.tavily.com. Recued stores it in the encrypted '
      + 'connection and never writes it into the pack or a recipe.',
  },
];

export const TAVILY_SCHEMA_INITIAL_VALUES: Readonly<Record<string, string>> = {
  name: 'tavily',
  display_name: 'Tavily',
  'config.vendor': 'tavily',
  'config.base_url': TAVILY_API_BASE,
  'auth.type': 'bearer',
};

export const tavilySchema: VendorConnectionSchema = {
  vendor: 'tavily',
  kind: 'api',
  label: 'Tavily',
  description:
    'Web search, extraction, crawl, and cited research through Tavily. '
    + 'Bring an API key from app.tavily.com; API calls consume Tavily credits.',
  fields: TAVILY_FIELDS,
  initialValues: TAVILY_SCHEMA_INITIAL_VALUES,
};

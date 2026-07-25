/** D-165 P1 - connection.api path interpolation.
 *
 *  Exercises the real wrapper dispatch path used by catalog delegates:
 *  `createIngredientExecutor` -> `createConnectionAdapter` ->
 *  `connection.api`. Bare wrapper path refs such as `{{contact_id}}`
 *  are resolved from the call's own flat input fields after
 *  namespace refs have been resolved by `resolveDeep`.
 */

import { describe, expect, it } from 'vitest';
import {
  resolveDeep,
  type ConnectionAuth,
  type ConnectionRow,
  type IngredientManifest,
  type NamespaceStores,
} from '@recued/contracts';
import { createConnectionApiHandler } from '../connection-api.js';
import type { ConnectionApiHandlerDeps } from '../connection-api.js';
import { createConnectionAdapter } from '../connection.js';
import { createIngredientExecutor } from '../dispatch.js';
import { IngredientError } from '../types.js';

// `contact-reader-hubspot` + `deal-reader-hubspot` were retired by `f4c84d84`
// (D-182 slice4 — the catalog model replaced the per-op reader ingredients). This
// suite exercises the still-live `connection.api` wrapper path-interpolation
// mechanic, so we reconstruct the two retired manifests inline — faithful to the
// retired files' input `path` + `query.properties` — like `staticPathManifest` below.
const contactReaderManifest: IngredientManifest = {
  slug: 'contact-reader-hubspot',
  name: 'HubSpot Contact Reader',
  description: 'Fetch a single contact by ID from HubSpot.',
  author: 'recued-core',
  kind: 'connection',
  version: 3,
  category: 'data',
  risk_tier: 'read',
  input: {
    connection_kind: 'api',
    connection: '{{config.hubspot}}',
    method: 'GET',
    path: '/crm/v3/objects/contacts/{{contact_id}}',
    contact_id: null,
    'query.properties':
      'hs_object_id,firstname,lastname,email,phone,company,jobtitle,lifecyclestage,hs_lead_status,createdate,lastmodifieddate,hubspot_owner_id',
  },
  output: {},
};

const dealReaderManifest: IngredientManifest = {
  slug: 'deal-reader-hubspot',
  name: 'HubSpot Deal Reader',
  description: 'Fetch a single deal by ID from HubSpot.',
  author: 'recued-core',
  kind: 'connection',
  version: 3,
  category: 'data',
  risk_tier: 'read',
  input: {
    connection_kind: 'api',
    connection: '{{config.hubspot}}',
    method: 'GET',
    path: '/crm/v3/objects/deals/{{deal_id}}',
    deal_id: null,
    'query.properties':
      'hs_object_id,dealname,dealstage,pipeline,amount,closedate,createdate,hs_lastmodifieddate,hubspot_owner_id,hs_is_closed,hs_is_closed_won',
  },
  output: {},
};

const mkRow = (overrides: Partial<ConnectionRow> = {}): ConnectionRow => ({
  pk: `${overrides.kind ?? 'api'}:${overrides.name ?? 'my-hubspot'}`,
  kind: overrides.kind ?? 'api',
  name: overrides.name ?? 'my-hubspot',
  display_name: overrides.display_name ?? 'HubSpot',
  config_json: overrides.config_json ?? '{"base_url":"https://api.hubapi.com"}',
  auth_ciphertext: overrides.auth_ciphertext ?? 'opaque-blob',
  enrolled_at: overrides.enrolled_at ?? 1_700_000_000_000,
  updated_at: overrides.updated_at ?? 1_700_000_000_000,
  ...(overrides.subtype !== undefined ? { subtype: overrides.subtype } : {}),
  ...(overrides.publisher_id !== undefined ? { publisher_id: overrides.publisher_id } : {}),
  ...(overrides.last_used_at !== undefined ? { last_used_at: overrides.last_used_at } : {}),
  ...(overrides.health_json !== undefined ? { health_json: overrides.health_json } : {}),
});

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

const captureFetch = (
  responder: (call: FetchCall) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: FetchCall[] } => {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => { headers[k] = v; });
    }
    const captured: FetchCall = {
      url: typeof input === 'string' ? input : input.toString(),
      method: (init?.method ?? 'GET').toUpperCase(),
      headers,
      body: init?.body == null ? undefined : String(init.body),
    };
    calls.push(captured);
    return responder(captured);
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
};

const okJson = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const mkDeps = (
  auth: ConnectionAuth,
  responder: (call: FetchCall) => Response | Promise<Response>,
): { deps: ConnectionApiHandlerDeps; calls: FetchCall[] } => {
  const { fetch: fetchImpl, calls } = captureFetch(responder);
  const deps: ConnectionApiHandlerDeps = {
    decodeAuth: async () => auth,
    persistAuth: async () => {},
    fetchImpl,
  };
  return { deps, calls };
};

const stores = {
  config: { hubspot: 'my-hubspot' },
  vault: {},
  context: {},
  meta: {},
  step: {},
} as unknown as NamespaceStores;

const makeExecutor = (
  manifests: IngredientManifest[],
  responder: (call: FetchCall) => Response | Promise<Response> = () =>
    okJson({ id: 'ok', properties: {} }),
  row: ConnectionRow = mkRow(),
): {
  executor: ReturnType<typeof createIngredientExecutor>;
  calls: FetchCall[];
} => {
  const manifestBySlug = new Map(manifests.map((manifest) => [manifest.slug, manifest]));
  const { deps, calls } = mkDeps({ type: 'bearer', token: 'pat-xxx' }, responder);
  const apiHandler = createConnectionApiHandler(deps);
  const connectionAdapter = createConnectionAdapter({
    store: {
      get: async (kind, name) => (kind === row.kind && name === row.name ? row : null),
    },
    handlers: { api: apiHandler },
  });
  const executor = createIngredientExecutor({
    manifestLoader: async (slug) => manifestBySlug.get(slug) ?? null,
    adapterRegistry: { connection: connectionAdapter },
    resolveRefs: (obj) => resolveDeep(obj, stores) as Record<string, unknown>,
  });
  return { executor, calls };
};

const expectedUrl = (
  base: string,
  path: string,
  query: Record<string, unknown> = {},
): string => {
  const url = new URL(path, base);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.append(key, String(value));
  }
  return url.toString();
};

const expectIngredientCode = async (
  thunk: () => Promise<unknown>,
  code: string,
): Promise<void> => {
  let caught: unknown;
  try {
    await thunk();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(IngredientError);
  expect((caught as IngredientError).code).toBe(code);
};

const staticPathManifest: IngredientManifest = {
  slug: 'static-api-ping',
  name: 'Static API Ping',
  description: 'Static path connection.api wrapper.',
  author: 'recued-test',
  kind: 'connection',
  version: 1,
  category: 'data',
  risk_tier: 'read',
  input: {
    connection_kind: 'api',
    connection: '{{config.hubspot}}',
    method: 'GET',
    path: '/v1/ping',
  },
  output: {},
};

const missingPathParamManifest: IngredientManifest = {
  ...staticPathManifest,
  slug: 'missing-path-param',
  name: 'Missing Path Param',
  input: {
    connection_kind: 'api',
    connection: '{{config.hubspot}}',
    method: 'GET',
    path: '/v1/{{missing}}',
  },
};

describe('D-165 P1 - connection.api path interpolation', () => {
  it('interpolates a real HubSpot contact_id path param from step input', async () => {
    const { executor, calls } = makeExecutor([contactReaderManifest]);

    await executor(
      'contact-reader-hubspot',
      { contact_id: '468420276964', connection: 'my-hubspot' },
      undefined,
      undefined,
      undefined,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe(expectedUrl(
      'https://api.hubapi.com',
      '/crm/v3/objects/contacts/468420276964',
      { properties: contactReaderManifest.input?.['query.properties'] },
    ));
    expect(calls[0]?.url).not.toContain('%7B%7Bcontact_id%7D%7D');
    expect(calls[0]?.url).not.toContain('{{contact_id}}');
  });

  it('interpolates a real HubSpot deal_id path param from step input', async () => {
    const { executor, calls } = makeExecutor([dealReaderManifest]);

    await executor(
      'deal-reader-hubspot',
      { deal_id: '327071234772', connection: 'my-hubspot' },
      undefined,
      undefined,
      undefined,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe(expectedUrl(
      'https://api.hubapi.com',
      '/crm/v3/objects/deals/327071234772',
      { properties: dealReaderManifest.input?.['query.properties'] },
    ));
    expect(calls[0]?.url).not.toContain('%7B%7Bdeal_id%7D%7D');
    expect(calls[0]?.url).not.toContain('{{deal_id}}');
  });

  it('rejects path params containing a slash', async () => {
    const { executor, calls } = makeExecutor([contactReaderManifest]);

    await expectIngredientCode(
      () => executor(
        'contact-reader-hubspot',
        { contact_id: 'a/b', connection: 'my-hubspot' },
        undefined,
        undefined,
        undefined,
      ),
      'URL_REF_INVALID',
    );

    expect(calls).toHaveLength(0);
  });

  it('rejects traversal path params left intact by encodeURIComponent', async () => {
    const { executor, calls } = makeExecutor([contactReaderManifest]);

    await expectIngredientCode(
      () => executor(
        'contact-reader-hubspot',
        { contact_id: '..', connection: 'my-hubspot' },
        undefined,
        undefined,
        undefined,
      ),
      'URL_REF_INVALID',
    );

    expect(calls).toHaveLength(0);
  });

  it('dispatches synthetic static-path wrappers unchanged', async () => {
    const row = mkRow({ config_json: '{"base_url":"https://api.example.test"}' });
    const { executor, calls } = makeExecutor([staticPathManifest], undefined, row);

    await executor(
      'static-api-ping',
      { connection: 'my-hubspot' },
      undefined,
      undefined,
      undefined,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe('https://api.example.test/v1/ping');
  });

  it('leaves missing path params as literal markers for HTTP-adapter parity', async () => {
    const row = mkRow({ config_json: '{"base_url":"https://api.example.test"}' });
    const { executor, calls } = makeExecutor([missingPathParamManifest], undefined, row);

    await executor(
      'missing-path-param',
      { connection: 'my-hubspot' },
      undefined,
      undefined,
      undefined,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.example.test/v1/%7B%7Bmissing%7D%7D');
    expect(
      calls[0]!.url.includes('%7B%7Bmissing%7D%7D')
        || calls[0]!.url.includes('{{missing}}'),
    ).toBe(true);
  });
});

import { OPENAPI_ABSENT_REASONS, type IngredientHttpConfig, type OpenApiAbsentDeclaration,
  type OpenApiAbsentReason, type SchemaSourceRef, type RestExecutionBinding } from '@recued/contracts';
import { restRequestPathSuffix } from '@recued/ingredients/rest-request-policy';

export const API_SCHEMA_SOURCE_KEYS = ['openapi_source', 'graphql_schema_source', 'google_discovery_source'] as const satisfies readonly (keyof IngredientHttpConfig)[];
export type ApiSchemaSourceKey = typeof API_SCHEMA_SOURCE_KEYS[number];
export type ApiSchemaSection = 'http' | 'source' | 'alias' | 'binding' | 'absent';
export interface ApiSchemaField { key: string; type: 'string' | 'object' | 'array'; required: boolean; description: string; values?: readonly { value: string; description: string }[] }
type Shape<T> = T extends string ? 'string' : T extends readonly unknown[] ? 'array' : T extends object ? 'object' : never;
type Fields<T> = { [K in keyof T]-?: { type: Shape<Exclude<T[K], undefined>>; required: {} extends Pick<T, K> ? false : true; description: string } };
const proof = 'Documentation proof metadata only; runtime dispatch still calls path_template. The editor performs no document fetch, hash verification or endpoint proof.';
const http: Fields<Pick<IngredientHttpConfig, ApiSchemaSourceKey>> = {
  openapi_source: { type: 'object', required: false, description: 'Pin an external OpenAPI document by authored URL and SHA-256. Catalog lowering carries pins from the first ingredient HTTP cell. Plain 1x1 API wrappers do not carry schema pins. ' + proof },
  graphql_schema_source: { type: 'object', required: false, description: 'Pin an external GraphQL schema by authored URL and SHA-256. Catalog lowering carries pins from the first ingredient HTTP cell; plain 1x1 API wrappers do not carry schema pins. GraphQL document validation remains separate from this static pin check.' },
  google_discovery_source: { type: 'object', required: false, description: 'Pin an external Google Discovery document by authored URL and SHA-256. Catalog lowering carries pins from the first ingredient HTTP cell; plain 1x1 API wrappers do not carry schema pins. This editor checks declared metadata, without fetching the document or proving its operations.' },
};
const source: Fields<SchemaSourceRef> = {
  url: { type: 'string', required: true, description: 'Authored schema-document URL. Shared catalog validation requires HTTPS, with localhost / 127.0.0.1 / [::1] development exceptions. The editor does not open or fetch this URL.' },
  sha256: { type: 'string', required: true, description: 'Authored SHA-256 digest: exactly 64 lowercase hexadecimal characters. Static validation checks the format; fetching the document and verifying its bytes is a separate publishing check.' },
  path_alias: { type: 'object', required: false, description: 'OpenAPI wire-to-document path mapping: one object or an ordered list of scoped rules. The first matching wire_prefix claims strict descendant paths; unclaimed paths stay unchanged. A catch-all rule without wire_prefix must come last. Per-operation openapi_path overrides the alias. ' + proof },
};
type PathAlias = Exclude<NonNullable<SchemaSourceRef['path_alias']>, readonly unknown[]>;
const alias: Fields<PathAlias> = {
  wire_prefix: { type: 'string', required: false, description: 'Wire path prefix stripped before matching the document path. In a rule list it scopes this rule to strict descendants, with brace parameters matched positionally. Rule order is authored. ' + proof },
  doc_base: { type: 'string', required: false, description: 'Document path prefix prepended for proof when the wire base URL already absorbs it, such as /api/v2. This does not change the request base URL. ' + proof },
  strip_suffix: { type: 'string', required: false, description: 'Dotted format extension stripped from the wire path for proof, such as .json. Shared validation rejects a bare substring. The actual request keeps its authored suffix. ' + proof },
};
const binding: Fields<Pick<RestExecutionBinding, 'openapi_path' | 'openapi_path_param_expansions' | 'openapi_absent'>> = {
  openapi_path: { type: 'string', required: false, description: 'Exact document path used instead of the surface alias for this operation. Must start with /. Mutually exclusive with openapi_absent. Plain 1x1 API wrappers do not carry this proof metadata. ' + proof },
  openapi_path_param_expansions: { type: 'object', required: false, description: 'Map one parameter from the authored openapi_path to an ordered list of at least two safe wire-path argument names. Expansions may not repeat a wire argument. Suggestions come only from local declarations and the authored paths; F12 opens a unique declared wire argument. ' + proof },
  openapi_absent: { type: 'object', required: false, description: 'Declare why the pinned OpenAPI document cannot describe an operation documented elsewhere. Requires an explicit structural reason and HTTPS vendor evidence. Exempt operations are distinct from proven operations. Mutually exclusive with openapi_path. ' + proof },
};
const absent: Fields<OpenApiAbsentDeclaration> = {
  reason: { type: 'string', required: true, description: 'Choose the structural reason the pinned document omits this operation. This attestation is distinct from document proof; no reason is selected automatically.' },
  evidence: { type: 'string', required: true, description: 'Required authored HTTPS vendor-documentation URL defining this operation elsewhere. The editor neither fetches this URL nor verifies the attestation.' },
};
const reasons: Record<OpenApiAbsentReason, string> = {
  odata_nav_not_expanded: 'An OData-derived document does not expand a navigation property beneath another navigation property.',
  odata_function_method_absent: 'OData describes a function as GET-only, while the vendor REST reference defines another method on that URL.',
  undocumented_in_spec: 'The vendor publishes the endpoint in its reference documentation but omits it from the machine-readable specification.',
};
export const apiSchemaFields = (section: ApiSchemaSection, pin?: unknown): ApiSchemaField[] => {
  const fields: Record<string, Omit<ApiSchemaField, 'key'>> = section === 'http' ? http : section === 'source' ? source
    : section === 'alias' ? alias : section === 'binding' ? binding : absent;
  return Object.entries(fields).filter(([key]) => section !== 'source' || key !== 'path_alias' || pin === 'openapi_source')
    .map(([key, field]) => ({ key, ...field, ...(section === 'absent' && key === 'reason'
      ? { values: OPENAPI_ABSENT_REASONS.map(value => ({ value, description: reasons[value] })) } : {}) }));
};
export const API_SCHEMA_CHOICE_LIMIT = 100;
/** Local path spellings only. No external document or successful proof is implied. */
export const openApiDocumentParameters = (path: unknown): string[] => {
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 20_000 || path.includes('{{')) return [];
  const pattern = /\{([A-Za-z0-9._-]+)\}/g, matches = [...path.matchAll(pattern)];
  if (matches.length > API_SCHEMA_CHOICE_LIMIT || /[{}]/.test(path.replace(pattern, ''))) return [];
  return [...new Set(matches.map(match => match[1]!))];
};

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Project existing catalog paths only when lowering retained the authored object identity. No validation rules are repeated. */
export const apiSchemaIssueLocations = (body: unknown, api: unknown): Map<string, string> => {
  const locations = new Map<string, string>();
  if (!object(body) || !object(api)) return locations;
  const ambiguous = new Set<string>();
  const put = (code: string, original: string, target: (string | number)[]) => {
    const key = JSON.stringify([code, original]), path = restRequestPathSuffix(target).slice(1);
    if (ambiguous.has(key)) return;
    if (locations.has(key) && locations.get(key) !== path) { locations.delete(key); ambiguous.add(key); return; }
    locations.set(key, path);
  };
  const ingredients = body.ingredients;
  if (Array.isArray(ingredients)) {
    const primary = ingredients[0], http = object(primary) && primary.http;
    if (object(primary) && typeof primary.slug === 'string' && ingredients.filter(row => object(row) && row.slug === primary.slug).length === 1 && object(http)) {
      for (const pin of API_SCHEMA_SOURCE_KEYS) {
        const value = http[pin]; if (value === undefined || !Object.hasOwn(api, pin) || api[pin] !== value) continue;
        const base = 'surfaces.api.' + pin, target = ['ingredients', 0, 'http', pin];
        put('CATALOG_SURFACE_INVALID', base, target);
        for (const key of ['url', 'sha256', 'path_alias']) put('CATALOG_SURFACE_INVALID', base + '.' + key, [...target, key]);
        if (!object(value)) continue;
        const rules = Array.isArray(value.path_alias) ? value.path_alias : [value.path_alias];
        rules.forEach((rule, index) => {
          const suffix = Array.isArray(value.path_alias) ? '[' + index + ']' : '', parts = Array.isArray(value.path_alias) ? [index] : [];
          put('CATALOG_SURFACE_INVALID', base + '.path_alias' + suffix, [...target, 'path_alias', ...parts]);
          if (object(rule)) for (const key of Object.keys(alias)) put('CATALOG_SURFACE_INVALID', base + '.path_alias' + suffix + '.' + key, [...target, 'path_alias', ...parts, key]);
        });
      }
    }
  }
  if (!Array.isArray(body.operations) || !object(api.executes)) return locations;
  const operations = body.operations, executes = api.executes, counts = new Map<string, number>();
  for (const row of operations) if (object(row) && typeof row.op === 'string') counts.set(row.op, (counts.get(row.op) ?? 0) + 1);
  operations.forEach((row, index) => {
    if (!object(row) || typeof row.op !== 'string' || counts.get(row.op) !== 1 || !object(row.bind) || row.bind.kind !== 'rest'
      || !Object.hasOwn(executes, row.op) || executes[row.op] !== row.bind) return;
    const base = 'surfaces.api.executes.' + row.op, target = ['operations', index, 'bind'];
    const paths: (string | number)[][] = [['openapi_path'], ['openapi_absent'], ['openapi_absent', 'reason'], ['openapi_absent', 'evidence'], ['openapi_path_param_expansions']];
    if (object(row.bind.openapi_path_param_expansions)) for (const key of Object.keys(row.bind.openapi_path_param_expansions)) paths.push(['openapi_path_param_expansions', key]);
    for (const parts of paths) put('CATALOG_BINDING_INVALID', base + '.' + parts.join('.'), [...target, ...parts]);
  });
  return locations;
};

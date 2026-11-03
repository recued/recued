import { BULK_PACK_MAX_CONNECTION_REQUIREMENTS, publisherMayDeclare, validateConnectionRequirementShape, type RestExecutionBinding } from '@recued/contracts';
import { restMergeQueryProblems, restStaticRequestProblems, restRequestPathSuffix } from '@recued/ingredients/rest-request-policy';
import type { ValidationIssue } from '@recued/ingredients/validate';

export interface RestRequestField { key: string; type: 'object' | 'array'; description: string }
type Field = Omit<RestRequestField, 'key'>;
const fields: Record<keyof Pick<RestExecutionBinding, 'static_body' | 'static_query' | 'static_headers' | 'merge_query' | 'auth_body_fields'>, Field> = {
  static_body: { type: 'object', description: 'Fixed top-level JSON body fields, with string values and literal keys without dots. Requires POST/PUT/PATCH. Binding values override matching caller body fields; declaring this object also removes caller body_raw. An empty object emits {} only when no caller body or body.* fields are supplied. Provider values remain authored.' },
  static_query: { type: 'object', description: 'Fixed query parameters with string values. Binding values override matching caller query parameters unless the key is explicitly named in merge_query. Provider names and values remain authored.' },
  static_headers: { type: 'object', description: 'Fixed request headers with string values. Host, Authorization and Cookie remain owned by the connection adapter. Connection authentication is injected separately; header names and values remain authored.' },
  merge_query: { type: 'array', description: 'Names of this binding\'s static_query keys whose comma-separated values union with caller query values. Static values come first and duplicates are removed. Other static query values override caller values. F12 opens the named static key; the editor chooses no merge policy.' },
  auth_body_fields: { type: 'array', description: 'Explicit credential NAMES to inject from this connection\'s body_field auth. Omission or an empty list injects nothing. Requires a JSON body on POST/PUT/PATCH at execution; missing credentials fail the call. Values stay in the encrypted connection. Local suggestions require one matching declared body_field descriptor; F12 opens its field name.' },
};
export const restRequestFields = (): RestRequestField[] => Object.entries(fields).map(([key, field]) => ({ key, ...field }));
export const REST_REQUEST_CHOICE_LIMIT = 100;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const name = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
/** A local key is eligible only when the whole fixed query map has its declared shape. */
export const restMergeQueryNames = (query: unknown): string[] => object(query) && Object.keys(query).length <= REST_REQUEST_CHOICE_LIMIT
  && Object.entries(query).every(([key, value]) => name(key) && typeof value === 'string') ? Object.keys(query) : [];

/** Exact authored base and explicit connection/vendor agreement; no installed account lookup. */
export const restBodyAuthNames = (pack: unknown, connection: unknown, base: unknown): { name: string; requirement: number; field: number }[] => {
  if (!object(pack) || pack.manifest_version !== 2 || !publisherMayDeclare(pack.publisher, 'connection_requirements') || !name(connection) || typeof base !== 'string') return [];
  const requirements = pack.connection_requirements;
  if (!Array.isArray(requirements) || requirements.length > BULK_PACK_MAX_CONNECTION_REQUIREMENTS) return [];
  const rows = requirements.map((entry, index) => ({ entry, index })).filter(({ entry }) => object(entry) && entry.api_base === base
    && typeof entry.vendor === 'string' && entry.vendor.replaceAll('_', '-') === connection.replaceAll('_', '-'));
  if (rows.length !== 1) return [];
  const { entry, index } = rows[0]!;
  if (!object(entry) || validateConnectionRequirementShape(entry).length || !object(entry.auth) || entry.auth.type !== 'body_field') return [];
  const names = entry.auth.field_names;
  if (!Array.isArray(names) || names.length > REST_REQUEST_CHOICE_LIMIT || !names.every(name) || new Set(names).size !== names.length) return [];
  return names.map((name, field) => ({ name, requirement: index, field }));
};

/** Remap only shared request findings actually emitted for the lowered catalog. */
export const restRequestIssueLocations = (operations: unknown, executes: unknown): Map<string, Pick<ValidationIssue, 'path' | 'reference_span'>> => {
  const locations = new Map<string, Pick<ValidationIssue, 'path' | 'reference_span'>>();
  if (!Array.isArray(operations) || !object(executes)) return locations;
  for (const [index, row] of operations.entries()) {
    if (!object(row) || typeof row.op !== 'string' || !object(row.bind) || row.bind.kind !== 'rest' || executes[row.op] !== row.bind) continue;
    for (const problem of [...restStaticRequestProblems(row.bind, row.op), ...restMergeQueryProblems(row.bind, row.op)]) {
      const suffix = restRequestPathSuffix(problem.path), catalogPath = 'surfaces.api.executes.' + row.op + suffix;
      locations.set(JSON.stringify([catalogPath, problem.message]), { path: 'operations[' + index + '].bind' + suffix,
        ...(problem.reference_span ? { reference_span: problem.reference_span } : {}) });
    }
  }
  return locations;
};

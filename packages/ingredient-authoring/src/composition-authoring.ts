import { API_EXECUTION_BINDING_KINDS, CONNECTOR_EXECUTION_BINDING_KINDS, REST_METHODS, OPERATION_ARG_TYPES,
  type OperationArgSpec, type OperationArgType, type RestExecutionBinding, type GraphQLExecutionBinding, type McpExecutionBinding } from '@recued/contracts';
export interface CompositionAuthoringField { key: string; type: 'string' | 'boolean' | 'object'; description: string; required: boolean }
type Field = Omit<CompositionAuthoringField, 'key' | 'required'>;
const argumentsHelp: Record<keyof OperationArgSpec, Field> = {
  key: { type: 'string', description: 'Non-empty caller argument name. A bare string entry is a required string; object entries are optional unless required is true.' },
  type: { type: 'string', description: 'Caller argument type from the shared operation contract. Omit for string. This is the operation argument vocabulary, not arbitrary JSON Schema.' },
  required: { type: 'boolean', description: 'True requires the caller to supply the argument. False or omission on an object entry makes it optional; a bare string entry is always required.' },
  affects_target: { type: 'boolean', description: 'True makes an approval edit re-resolve the action target or destination. Choose from the argument behavior; the editor does not infer authority.' },
};
const typeHelp: Record<OperationArgType, string> = {
  string: 'A string value.', number: 'A numeric value.', boolean: 'A boolean value.', object: 'An object value.', array: 'An array value.',
  file_ref: 'One complete stored file reference.', 'file_ref[]': 'An array of complete stored file references.',
};
const rest: Record<keyof Pick<RestExecutionBinding, 'kind' | 'method' | 'path_template' | 'static_query' | 'static_headers'>, Field> = {
  kind: { type: 'string', description: 'The binding transport. It determines which fields configure the call; changing it requires reviewing the rest of the binding.' },
  method: { type: 'string', description: 'Exact HTTP method owned by this binding. Selecting a method does not choose risk, approval or grants.' },
  path_template: { type: 'string', description: 'Binding-owned request path. Double-brace argument placeholders are expanded at dispatch; callers cannot choose a different endpoint.' },
  static_query: { type: 'object', description: 'Binding-owned fixed query parameters. The binding controls how they compose with caller arguments.' },
  static_headers: { type: 'object', description: 'Binding-owned static headers. Connection authentication is injected separately.' },
};
const graphql: Record<keyof Pick<GraphQLExecutionBinding, 'kind' | 'operation_type' | 'endpoint_path' | 'query' | 'result_data_path' | 'variables_schema' | 'result_schema'>, Field> = {
  kind: rest.kind,
  operation_type: { type: 'string', description: 'GraphQL document operation kind. This HTTP surface dispatches query and mutation; subscriptions require an unavailable WS/SSE transport and are rejected by shared validation. The declared type must agree with the document leading keyword. Risk and approval remain explicit operation policies.' },
  endpoint_path: { type: 'string', description: 'Connection-relative path receiving the GraphQL document and variables.' },
  query: { type: 'string', description: 'The authored GraphQL document. Caller data supplies variables rather than replacing the document. Shared validation classifies its leading keyword after whitespace, commas and comments; leading fragments and descriptions are not classifiable. No full GraphQL parse or provider validation is performed.' },
  result_data_path: { type: 'string', description: "Optional response envelope dot-path used to detect missing or null payloads; omission uses 'data', and an empty string selects the root. Custom paths use safe field names with no empty or prototype-sensitive segments. Partial data can succeed while errors remain in result.errors. The returned body stays wrapped; this path does not hoist or reshape it. Choose it from the actual provider response." },
  variables_schema: { type: 'object', description: 'Informational authored GraphQL variables schema. It does not replace operation args or a closed request_schema and does not enforce runtime input validation.' },
  result_schema: { type: 'object', description: 'Informational authored GraphQL result schema. It does not validate returned values or establish the recipe result envelope.' },
};
const mcp: Record<keyof Pick<McpExecutionBinding, 'kind' | 'tool'>, Field> = {
  kind: rest.kind, tool: { type: 'string', description: 'MCP tool name owned by this binding. Caller arguments cannot replace it; execution still requires the operation grant.' },
};
export const compositionArgumentFields = (): CompositionAuthoringField[] => Object.entries(argumentsHelp).map(([key, field]) => ({ key, ...field, required: key === 'key' }));
export const compositionBindingKinds = (ingredientKind: unknown): readonly string[] => ingredientKind === 'http' || ingredientKind === 'connection'
  ? API_EXECUTION_BINDING_KINDS : ingredientKind === 'cli' ? CONNECTOR_EXECUTION_BINDING_KINDS : [];
/** Basic schema-owned binding fields. Nested payloads and informational schemas stay opaque. */
export const compositionBindingFields = (ingredientKind: unknown, bindingKind: unknown): CompositionAuthoringField[] => {
  if (!compositionBindingKinds(ingredientKind).length) return [];
  const api = ingredientKind === 'http' || ingredientKind === 'connection';
  const fields: Record<string, Field> = api && bindingKind === 'rest' ? rest : api && bindingKind === 'graphql' ? graphql
    : api && bindingKind === 'mcp' ? mcp : { kind: rest.kind };
  return Object.entries(fields).map(([key, field]) => ({ key, ...field, required: !['static_query', 'static_headers', 'result_data_path', 'variables_schema', 'result_schema'].includes(key) }));
};
export const compositionAuthoringChoices = (group: 'argument' | 'binding', field: string, ingredientKind?: unknown, bindingKind?: unknown): { value: string | boolean; description: string }[] => {
  if (group === 'argument') {
    if (field === 'type') return OPERATION_ARG_TYPES.map(value => ({ value, description: typeHelp[value] }));
    if (field === 'required' || field === 'affects_target') return [true, false].map(value => ({ value, description: argumentsHelp[field].description }));
    return [];
  }
  if (field === 'kind') return compositionBindingKinds(ingredientKind).map(value => ({ value, description: rest.kind.description }));
  if (ingredientKind !== 'http' && ingredientKind !== 'connection') return [];
  if (bindingKind === 'rest' && field === 'method') return REST_METHODS.map(value => ({ value, description: rest.method.description }));
  if (bindingKind === 'graphql' && field === 'operation_type') return ['query', 'mutation'].map(value => ({ value, description: graphql.operation_type.description }));
  return [];
};

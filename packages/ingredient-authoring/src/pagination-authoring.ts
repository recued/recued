import { OPERATION_PAGINATION_STYLES, OPERATION_PAGINATION_PLACEMENTS, type OperationPaginationSpec } from '@recued/contracts';

type Style = OperationPaginationSpec['style'];
interface Field { type: 'string' | 'number' | 'object' | 'scalar'; description: string; required?: boolean; values?: readonly string[] }
type RootFields = { [S in Style]: Record<keyof Extract<OperationPaginationSpec, { style: S }>, Field> };
type Selection = Extract<OperationPaginationSpec, { style: 'body_cursor' }>['cursor_from']['select'];
type Increment = Extract<OperationPaginationSpec, { style: 'offset' }>['increment'];
const selections: Record<Selection, string> = { first: 'Read the cursor from the first item.', last: 'Read the cursor from the last item.' };
const increments: Record<Increment, string> = { page: 'Advance the page number by one.', by_page_size: 'Advance the record offset by the declared page_size.value; requires page_size.' };
export const paginationSelectionAllowed = (value: unknown): value is Selection => typeof value === 'string' && Object.hasOwn(selections, value);
export const paginationIncrementAllowed = (value: unknown): value is Increment => typeof value === 'string' && Object.hasOwn(increments, value);
const styleHelp: Record<Style, string> = {
  body_cursor: 'Derive the next cursor from a selected item in the provider body. A missing next_when predicate may require an extra empty-page request.',
  next_path: 'Read the next request path from the provider body. path_prefix can restrict the returned root-relative path.',
  link_header: 'Read the next-page link from a response header. The runtime owns continuation validation and page ceilings.',
  query_token: 'Read a scalar continuation token from the provider body and replay it on the same operation.',
  query_token_link: 'Extract one query parameter from a returned next-page URL and replay that token on the same operation.',
  offset: 'Advance a page number or record offset. Termination and runtime page/record ceilings still apply.',
  graphql_relay: 'Read Relay pageInfo and replay the cursor in a declared GraphQL variable. Page size uses a variable, not a query/body placement.',
  single_page: 'Explicit author assertion that the entire collection fits in one call. Provider completeness is not inferred; runtime record ceilings can still truncate.',
};
const style: Field = { type: 'string', required: true, values: OPERATION_PAGINATION_STYLES, description: 'Reviewed pagination mechanic from the shared contract. Pagination is read-only; selecting a style does not establish provider completeness.' };
const pageSize: Field = { type: 'object', description: 'Explicit per-page request size. Preserve the provider limit and choose the wire placement and parameter yourself.' };
const condition: Field = { type: 'object', description: 'A provider-body path and a scalar equality predicate. Paths exclude the gateway result wrapper; provider fields remain authored.' };
const target: Field = { type: 'object', required: true, description: 'The query/body placement and parameter receiving the next request value.' };
const bodyPath = (description: string): Field => ({ type: 'string', required: true, description: `${description} Path is inside the provider body and excludes the gateway result wrapper.` });
const roots: RootFields = {
  body_cursor: { style, page_size: pageSize, next_when: condition, cursor_from: { type: 'object', required: true, description: 'The item array path, first/last selection and cursor field inside that item.' }, cursor_to: target },
  next_path: { style, page_size: pageSize, path: bodyPath('Location of the next-page path.'), done_when: condition, path_prefix: { type: 'string', description: 'Explicit allowlist prefix for the returned root-relative path.' } },
  link_header: { style, page_size: pageSize, header: { type: 'string', description: 'Response header containing continuation links. Omission uses the runtime link-header default; completion inserts no default.' } },
  query_token: { style, page_size: pageSize, token_from: bodyPath('Location of the next scalar token.'), token_to: target, done_when: condition },
  query_token_link: { style, page_size: pageSize, link_from: bodyPath('Location of the returned next-page URL.'), query_param: { type: 'string', required: true, description: 'Query-string key extracted from that URL; the URL itself does not replace the admitted operation.' }, token_to: target, done_when: condition },
  offset: { style, page_size: pageSize, param: target, start: { type: 'number', required: true, description: 'Explicit first page number or offset, a non-negative integer. Completion chooses no starting value.' }, increment: { type: 'string', required: true, values: Object.keys(increments), description: 'page advances by one; by_page_size advances by page_size.value and requires that declaration.' }, done_when: condition },
  graphql_relay: { style, page_size: { type: 'object', description: 'Explicit GraphQL page-size variable and positive integer value.' }, page_info_path: bodyPath('Location of Relay pageInfo.'), cursor_variable: { type: 'string', required: true, description: 'GraphQL variable receiving the next cursor.' }, has_next_field: { type: 'string', description: 'Continue flag within pageInfo. Omission retains the runtime Relay default.' }, end_cursor_field: { type: 'string', description: 'Cursor field within pageInfo. Omission retains the runtime Relay default.' } },
  single_page: { style, page_size: pageSize },
};
const placement: Field = { type: 'string', required: true, values: OPERATION_PAGINATION_PLACEMENTS, description: 'Where the runtime writes the declared request parameter.' };
const param: Field = { type: 'string', required: true, description: 'Explicit provider request parameter name; it is not inferred from caller arguments.' };
const value: Field = { type: 'number', required: true, description: 'Positive integer page size. No value or provider maximum is guessed.' };
const pageFields: Record<keyof NonNullable<Exclude<OperationPaginationSpec, { style: 'graphql_relay' }>['page_size']>, Field> = { placement, param, value, max: { type: 'number', description: 'Optional documented provider maximum, a positive integer. value must not exceed it.' } };
const relayPageFields: Record<keyof NonNullable<Extract<OperationPaginationSpec, { style: 'graphql_relay' }>['page_size']>, Field> = { variable: { type: 'string', required: true, description: 'GraphQL page-size variable name.' }, value };
const sourceFields: Record<keyof Extract<OperationPaginationSpec, { style: 'body_cursor' }>['cursor_from'], Field> = { path: bodyPath('Location of the current page item array.'), select: { type: 'string', required: true, values: Object.keys(selections), description: 'Select the first or last item before reading the cursor field.' }, field: { type: 'string', required: true, description: 'Explicit cursor field path inside the selected item.' } };
const conditionFields: Record<keyof NonNullable<Extract<OperationPaginationSpec, { style: 'body_cursor' }>['next_when']>, Field> = { path: bodyPath('Location of the continuation/terminal value.'), equals: { type: 'scalar', required: true, description: 'Authored JSON scalar to compare with the provider value; no predicate value is chosen automatically.' } };
export const operationPaginationStyleHelp = (value: unknown): string | undefined => typeof value === 'string' && Object.hasOwn(roots, value) ? styleHelp[value as Style] : undefined;
export const operationPaginationFields = (selected: unknown, path: readonly string[] = [], increment?: unknown) => {
  const known = typeof selected === 'string' && Object.hasOwn(roots, selected), spec: Record<string, Field> = known ? roots[selected as Style] : { style };
  let fields: Record<string, Field> = {};
  if (!path.length) fields = spec;
  else if (known && path.length === 1 && Object.hasOwn(spec, path[0]!)) {
    const key = path[0];
    if (key === 'page_size') fields = selected === 'graphql_relay' ? relayPageFields : pageFields;
    else if (['next_when', 'done_when'].includes(key!)) fields = conditionFields;
    else if (key === 'cursor_from') fields = sourceFields;
    else if (['cursor_to', 'token_to', 'param'].includes(key!)) fields = { placement, param };
  }
  return Object.entries(fields).map(([key, field]) => ({ key, ...field, required: !!field.required || selected === 'offset' && !path.length && key === 'page_size' && increment === 'by_page_size' }));
};
export const collectionResultPathHelp = 'Collection response-envelope path inside the provider body. A non-empty operation result_path overrides the composition primary HTTP default; an empty or absent override inherits it. Paths and provider response shape remain authored.';
/** Source explanation only. Invalid metadata must not masquerade as inheritance. Whitespace is preserved. */
export const authoredCollectionResultPath = (override: unknown, fallback: unknown): { mode: 'override' | 'inherited' | 'root'; path: string } | undefined => {
  if (override !== undefined && typeof override !== 'string' || fallback !== undefined && typeof fallback !== 'string') return;
  if (typeof override === 'string' && override.length > 0) return { mode: 'override', path: override };
  return fallback === undefined ? { mode: 'root', path: '' } : { mode: 'inherited', path: fallback as string };
};

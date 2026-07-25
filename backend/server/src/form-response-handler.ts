/** Owner-facing RPCs for accepted Reception form responses.
 *
 * `form_response.list/get` expose a summary list + canonical detail to the
 * paired webclient's Data browser. `update` changes only the working values and
 * visitor identity, `set_state` changes only lifecycle, and `export` produces a
 * bounded owner download. None mutates the sealed Reception evidence twin.
 *
 * Privacy boundary: rows contain arbitrary visitor-authored values and may
 * contain a visitor email. The slice therefore requires a registered paired
 * client, and the `form_response.` namespace is reserved out of MCP. A future
 * agent reader needs its own explicit grant and redaction design.
 */

import {
  RpcError,
  FORM_RESPONSE_LIFECYCLE_STATES,
  FORM_RESPONSE_LIFECYCLE_STATE_SET,
  type FormResponseGetRpcRequest,
  type FormResponseGetRpcResponse,
  type FormResponseLifecycleState,
  type FormResponseListItem,
  type FormResponseListQuery,
  type FormResponseListRpcResponse,
  type FormResponseSetStateRpcRequest,
  type FormResponseSetStateRpcResponse,
  type FormResponseUpdateRpcRequest,
  type FormResponseUpdateRpcResponse,
  type FormResponseExportRpcRequest,
  type FormResponseExportRpcResponse,
  type FormResponse,
  type HandlerSlice,
  type ServerRpcRegistry,
} from '@recued/contracts';

import type { WsClient } from './ws-server.js';
import {
  FormResponseValidationError,
  type FormResponseListSummary,
  type FormResponseStore,
} from './storage/form-response-store.js';
import {
  FormResponseWorkingContentValidationError,
  validateFormResponseWorkingContent,
} from './form-response-working-content.js';

export interface FormResponseRpcDeps {
  readonly store: FormResponseStore;
  readonly now?: () => number;
}

const DEFAULT_LIST_LIMIT = 50;
/** Keep one slot below the store's 500-row ceiling so the handler can fetch
 * `limit + 1` and emit an honest `next_cursor`. */
const MAX_LIST_LIMIT = 499;

const requireRegisteredClient = (client: WsClient): void => {
  if (!client.instance_id) {
    throw new RpcError(
      'unauthorized',
      'form_response rpc requires a registered paired client',
      401,
    );
  }
};

const mapReadError = (method: string, error: unknown): never => {
  if (error instanceof FormResponseValidationError) {
    throw new RpcError('bad_request', `${method}: ${error.message}`);
  }
  throw error;
};

const listLimit = (value: unknown): number => {
  const limit = value ?? DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_LIST_LIMIT) {
    throw new RpcError(
      'bad_request',
      `form_response.list: limit must be an integer between 1 and ${MAX_LIST_LIMIT}`,
    );
  }
  return limit as number;
};

/** Copy only declared filters from the wire payload. The store owns their
 * strict validation; unknown input properties never cross into its query. */
const listQuery = (
  args: FormResponseListQuery,
  limit: number,
): FormResponseListQuery => ({
  limit: limit + 1,
  ...(args.endpoint_id !== undefined ? { endpoint_id: args.endpoint_id } : {}),
  ...(args.form_definition_id !== undefined
    ? { form_definition_id: args.form_definition_id }
    : {}),
  ...(args.before !== undefined ? { before: args.before } : {}),
  ...(args.lifecycle_states !== undefined
    ? { lifecycle_states: args.lifecycle_states }
    : {}),
});

const toListItem = (response: FormResponseListSummary): FormResponseListItem => {
  const templateRef = response.metadata.template_ref;
  return {
    submission_id: response.submission_id,
    endpoint_id: response.endpoint_id,
    form_definition_id: response.form_definition_id,
    visitor:
      typeof response.visitor.email === 'string' && response.visitor.email.length > 0
        ? { email: response.visitor.email }
        : {},
    submitted_at: response.submitted_at,
    accepted_at: response.accepted_at,
    updated_at: response.updated_at,
    lifecycle_state: response.lifecycle_state,
    state_changed_at: response.state_changed_at,
    ...(typeof templateRef === 'string' && templateRef.length > 0
      ? { template_ref: templateRef }
      : {}),
  };
};

export const handleFormResponseList = async (
  deps: FormResponseRpcDeps,
  args: FormResponseListQuery | undefined,
): Promise<FormResponseListRpcResponse> => {
  if (
    args !== undefined
    && (args === null || typeof args !== 'object' || Array.isArray(args))
  ) {
    throw new RpcError('bad_request', 'form_response.list: args must be an object');
  }
  const normalizedArgs = args ?? {};
  const limit = listLimit(normalizedArgs.limit);
  try {
    const fetched = deps.store.listSummaries(listQuery(normalizedArgs, limit));
    const hasMore = fetched.length > limit;
    const page = hasMore ? fetched.slice(0, limit) : fetched;
    const last = page.at(-1);
    return {
      responses: page.map(toListItem),
      ...(hasMore && last !== undefined
        ? {
            next_cursor: {
              accepted_at: last.accepted_at,
              submission_id: last.submission_id,
            },
          }
        : {}),
    };
  } catch (error) {
    return mapReadError('form_response.list', error);
  }
};

export const handleFormResponseGet = async (
  deps: FormResponseRpcDeps,
  args: FormResponseGetRpcRequest,
): Promise<FormResponseGetRpcResponse> => {
  if (typeof args?.submission_id !== 'string' || args.submission_id.trim().length === 0) {
    throw new RpcError(
      'bad_request',
      'form_response.get: submission_id is required',
    );
  }
  try {
    return { response: deps.store.findById(args.submission_id) };
  } catch (error) {
    return mapReadError('form_response.get', error);
  }
};

/** D-210 A.8 slice 2 — advance the owner-authored lifecycle.
 *
 *  `now` comes from the SERVER, never the caller: `state_changed_at` records
 *  when a state actually moved, and a client that could choose it could
 *  backdate a no-show. */
export const handleFormResponseSetState = async (
  deps: FormResponseRpcDeps,
  args: FormResponseSetStateRpcRequest,
): Promise<FormResponseSetStateRpcResponse> => {
  if (typeof args?.submission_id !== 'string' || args.submission_id.trim().length === 0) {
    throw new RpcError(
      'bad_request',
      'form_response.set_state: submission_id is required',
    );
  }
  // Validate against the contract SET so the accepted vocabulary has exactly
  // one home and this message can never drift from it.
  if (
    typeof args?.lifecycle_state !== 'string'
    || !FORM_RESPONSE_LIFECYCLE_STATE_SET.has(
      args.lifecycle_state as FormResponseLifecycleState,
    )
  ) {
    throw new RpcError(
      'bad_request',
      'form_response.set_state: lifecycle_state must be one of: '
        + FORM_RESPONSE_LIFECYCLE_STATES.join(', '),
    );
  }
  try {
    return {
      response: deps.store.setLifecycleState(
        args.submission_id,
        args.lifecycle_state,
        (deps.now ?? Date.now)(),
      ),
    };
  } catch (error) {
    return mapReadError('form_response.set_state', error);
  }
};

export const handleFormResponseUpdate = async (
  deps: FormResponseRpcDeps,
  args: FormResponseUpdateRpcRequest,
): Promise<FormResponseUpdateRpcResponse> => {
  if (typeof args?.submission_id !== 'string' || args.submission_id.trim().length === 0) {
    throw new RpcError('bad_request', 'form_response.update: submission_id is required');
  }
  try {
    const current = deps.store.findById(args.submission_id);
    if (current === null) return { response: null };
    let working;
    try {
      working = validateFormResponseWorkingContent(current, args);
    } catch (error) {
      if (error instanceof FormResponseWorkingContentValidationError) {
        throw new RpcError(
          'bad_request',
          `form_response.update: ${error.message}`,
        );
      }
      throw error;
    }
    return {
      response: deps.store.updateContent(
        args.submission_id,
        working,
        (deps.now ?? Date.now)(),
      ),
    };
  } catch (error) {
    if (error instanceof RpcError) throw error;
    return mapReadError('form_response.update', error);
  }
};

const EXPORT_MAX_RECORDS = 10_000;
const EXPORT_PAGE_SIZE = 500;

const exportQuery = (
  args: FormResponseExportRpcRequest,
  before?: FormResponseListQuery['before'],
): FormResponseListQuery => ({
  limit: EXPORT_PAGE_SIZE,
  ...(args.endpoint_id !== undefined ? { endpoint_id: args.endpoint_id } : {}),
  ...(args.form_definition_id !== undefined
    ? { form_definition_id: args.form_definition_id }
    : {}),
  ...(args.lifecycle_states !== undefined
    ? { lifecycle_states: args.lifecycle_states }
    : {}),
  // A caller-supplied resume point starts the walk; the in-walk cursor takes
  // over once the first page is read.
  ...(before !== undefined
    ? { before }
    : args.before !== undefined
      ? { before: args.before }
      : {}),
});

const csvCell = (value: unknown): string => {
  let text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  // Neutralize spreadsheet formula execution while preserving the visible
  // owner value. Quoting alone does not stop Excel/Sheets formula evaluation.
  if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};

const exportCsv = (
  records: readonly FormResponse[],
  opts: { header: boolean } = { header: true },
): string => {
  const header = [
    'submission_id', 'endpoint_id', 'form_definition_id', 'lifecycle_state',
    // ⚠ Shipped alongside `lifecycle_state`, never without it: the store's own
    // note calls this the answer to "when did they no-show?", and a state with
    // no transition time cannot answer it. JSON always carried it.
    'state_changed_at',
    'submitted_at', 'accepted_at', 'updated_at', 'visitor_email', 'values_json',
  ].map(csvCell).join(',');
  const rows = records.map((record) => [
    record.submission_id,
    record.endpoint_id,
    record.form_definition_id,
    record.lifecycle_state,
    record.state_changed_at,
    record.submitted_at,
    record.accepted_at,
    record.updated_at,
    record.visitor.email ?? '',
    record.values,
  ].map(csvCell).join(','));
  return opts.header ? [header, ...rows].join('\r\n') : rows.join('\r\n');
};

export const handleFormResponseExport = async (
  deps: FormResponseRpcDeps,
  args: FormResponseExportRpcRequest,
): Promise<FormResponseExportRpcResponse> => {
  if (args?.format !== 'json' && args?.format !== 'csv') {
    throw new RpcError('bad_request', 'form_response.export: format must be json or csv');
  }
  try {
    const records: FormResponse[] = [];
    let before: FormResponseListQuery['before'];
    while (records.length < EXPORT_MAX_RECORDS) {
      const page = deps.store.list(exportQuery(args, before));
      records.push(...page);
      const last = page.at(-1);
      if (page.length < EXPORT_PAGE_SIZE || last === undefined) break;
      before = { accepted_at: last.accepted_at, submission_id: last.submission_id };
    }
    // Past the per-call ceiling this hands back a RESUME POINT rather than
    // refusing. The ceiling bounds one rpc payload; it must not bound the
    // owner's ability to get their own data out.
    let next_cursor: FormResponseListQuery['before'];
    if (records.length >= EXPORT_MAX_RECORDS) {
      const last = records.at(-1)!;
      const probe = {
        accepted_at: last.accepted_at,
        submission_id: last.submission_id,
      };
      const extra = deps.store.list({
        ...exportQuery(args, probe),
        limit: 1,
      });
      if (extra.length > 0) next_cursor = probe;
    }
    const stamp = new Date((deps.now ?? Date.now)()).toISOString().slice(0, 10);
    const json = args.format === 'json';
    return {
      filename: `form-responses-${stamp}.${args.format}`,
      mime_type: json ? 'application/json' : 'text/csv',
      // ⚠ CSV headers ride on the FIRST chunk only, so a caller concatenating
      // chunks gets one well-formed file rather than a header every 10k rows.
      content: json
        ? JSON.stringify(records, null, 2)
        : exportCsv(records, { header: args.before === undefined }),
      record_count: records.length,
      ...(next_cursor !== undefined ? { next_cursor } : {}),
    };
  } catch (error) {
    if (error instanceof RpcError) throw error;
    return mapReadError('form_response.export', error);
  }
};

type FormResponseRpcMethods =
  | 'form_response.list'
  | 'form_response.get'
  | 'form_response.set_state'
  | 'form_response.update'
  | 'form_response.export';

export const makeFormResponseHandlers = (
  deps: FormResponseRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, FormResponseRpcMethods, WsClient> | undefined => {
  if (deps === undefined) return undefined;
  return {
    methods: [
      'form_response.list',
      'form_response.get',
      'form_response.set_state',
      'form_response.update',
      'form_response.export',
    ],
    handlers: {
      'form_response.list': async (args, client) => {
        requireRegisteredClient(client);
        return handleFormResponseList(deps, args as FormResponseListQuery);
      },
      'form_response.get': async (args, client) => {
        requireRegisteredClient(client);
        return handleFormResponseGet(deps, args as FormResponseGetRpcRequest);
      },
      'form_response.set_state': async (args, client) => {
        requireRegisteredClient(client);
        return handleFormResponseSetState(deps, args as FormResponseSetStateRpcRequest);
      },
      'form_response.update': async (args, client) => {
        requireRegisteredClient(client);
        return handleFormResponseUpdate(deps, args as FormResponseUpdateRpcRequest);
      },
      'form_response.export': async (args, client) => {
        requireRegisteredClient(client);
        return handleFormResponseExport(deps, args as FormResponseExportRpcRequest);
      },
    },
  };
};

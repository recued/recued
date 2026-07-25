/** Owner-facing read RPCs for accepted Reception form responses.
 *
 * `form_response.list/get` expose an immutable summary list + canonical detail
 * to the paired webclient's Data browser. They deliberately do not mutate,
 * materialize, or infer a downstream entity: an accepted free-form submission
 * remains useful owner data even when no private workflow is attached.
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
  type HandlerSlice,
  type ServerRpcRegistry,
} from '@recued/contracts';

import type { WsClient } from './ws-server.js';
import {
  FormResponseValidationError,
  type FormResponseListSummary,
  type FormResponseStore,
} from './storage/form-response-store.js';

export interface FormResponseRpcDeps {
  readonly store: FormResponseStore;
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
        Date.now(),
      ),
    };
  } catch (error) {
    return mapReadError('form_response.set_state', error);
  }
};

type FormResponseRpcMethods =
  | 'form_response.list'
  | 'form_response.get'
  | 'form_response.set_state';

export const makeFormResponseHandlers = (
  deps: FormResponseRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, FormResponseRpcMethods, WsClient> | undefined => {
  if (deps === undefined) return undefined;
  return {
    methods: ['form_response.list', 'form_response.get', 'form_response.set_state'],
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
    },
  };
};

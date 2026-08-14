/** D-145 PA11 — `work_entity.source.*` rpc handlers.
 *
 *  ONE method, READ-ONLY: `list` — every registered Source.
 *
 *  ⛔ `set_enabled` / `set_default` / `clear_default` are DELETED with the
 *  Settings → Work Entities page (D-187 Sources half). A Source is declared by
 *  a PACK (`work_entity_sources[]`), so pack install/uninstall is its whole
 *  lifecycle; reads fan out over everything registered and writes carry an
 *  explicit source_id. Live consumers of `list`: the Data route's Source
 *  view-filter and the Reception inbox destination picker.
 *
 *  Spec: D-145 § A.2 + D-187 § 11. */

import {
  RpcError,
  type HandlerSlice,
  type ServerRpcRegistry,
  type SourceRegistration,
} from '@recued/contracts';

import type { WsClient } from './ws-server.js';
import {
  WorkEntityResolverError,
  type WorkEntityResolver,
} from './work-entity-resolver.js';
import {
  SourceRegistrationError,
  WorkEntityValidationError,
} from './storage/work-entity-store.js';

export interface WorkEntitySourceRpcDeps {
  resolver: WorkEntityResolver;
}

/** Convert a typed substrate error into the rpc surface's
 *  `bad_request` / `not_found` shape. The resolver / store raise:
 *    - WorkEntityResolverError code='unknown_source' → not_found
 *    - WorkEntityResolverError code='unknown_kind' / 'kind_source_mismatch' → bad_request
 *    - SourceRegistrationError 'not registered' → not_found
 *    - SourceRegistrationError everything else → bad_request
 *    - WorkEntityValidationError → bad_request
 *  Anything else propagates as-is so unexpected errors surface
 *  cleanly in test failures. */
const mapSourceError = (method: string, err: unknown): never => {
  if (err instanceof WorkEntityResolverError) {
    if (err.code === 'unknown_source') {
      throw new RpcError('not_found', `${method}: ${err.message}`);
    }
    throw new RpcError('bad_request', `${method}: ${err.message}`);
  }
  if (err instanceof SourceRegistrationError) {
    if (/not registered/i.test(err.message)) {
      throw new RpcError('not_found', `${method}: ${err.message}`);
    }
    throw new RpcError('bad_request', `${method}: ${err.message}`);
  }
  if (err instanceof WorkEntityValidationError) {
    throw new RpcError('bad_request', `${method}: ${err.message}`);
  }
  throw err;
};

export const handleWorkEntitySourceList = async (
  deps: WorkEntitySourceRpcDeps,
): Promise<{ sources: ReadonlyArray<SourceRegistration> }> => ({
  sources: deps.resolver.listSources(),
});

type WorkEntitySourceMethods = 'work_entity.source.list';

export const makeWorkEntitySourceHandlers = (
  deps: WorkEntitySourceRpcDeps | undefined,
):
  | HandlerSlice<ServerRpcRegistry, WorkEntitySourceMethods, WsClient>
  | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['work_entity.source.list'],
    handlers: {
      'work_entity.source.list': async () => handleWorkEntitySourceList(deps),
    },
  };
};

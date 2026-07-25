/** D-145 PA11 — `work_entity.source.*` rpc handlers.
 *
 *  Settings → Work Entities panel reads + writes. Five methods:
 *    list                 — registered Sources + per-kind defaults in one
 *                           round-trip (list every Source for the
 *                           Settings panel; recipe-side polymorphic reads
 *                           use the resolver's enabled-filter directly).
 *    set_enabled          — flip the user-driven enable/disable toggle.
 *    set_mcp_exposed      — flip the per-Source MCP exposure boolean.
 *    set_default          — pin a per-kind default Source.
 *    clear_default        — drop a per-kind default.
 *
 *  Spec: `docs/d-145-spec.md` § A.2 + § PA11. */

import {
  RpcError,
  WORK_ENTITY_KINDS,
  WORK_ENTITY_KIND_SET,
  type HandlerSlice,
  type ServerRpcRegistry,
  type SourceRegistration,
  type WorkEntityKind,
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
): Promise<{
  sources: ReadonlyArray<SourceRegistration>;
  defaults_by_kind: Readonly<Partial<Record<WorkEntityKind, string>>>;
}> => {
  const sources = deps.resolver.listSources();
  const defaults_by_kind: Partial<Record<WorkEntityKind, string>> = {};
  for (const kind of WORK_ENTITY_KINDS) {
    const pinned = deps.resolver.getDefaultSource(kind);
    if (pinned !== null) defaults_by_kind[kind] = pinned;
  }
  return { sources, defaults_by_kind };
};

export const handleWorkEntitySourceSetEnabled = async (
  deps: WorkEntitySourceRpcDeps,
  args: { source_id: string; enabled: boolean },
): Promise<{ ok: true; effective: SourceRegistration }> => {
  if (typeof args.source_id !== 'string' || args.source_id.length === 0) {
    throw new RpcError(
      'bad_request',
      'work_entity.source.set_enabled: source_id is required',
    );
  }
  if (typeof args.enabled !== 'boolean') {
    throw new RpcError(
      'bad_request',
      'work_entity.source.set_enabled: enabled must be a boolean',
    );
  }
  try {
    const effective = deps.resolver.setSourceEnabled(args.source_id, args.enabled);
    return { ok: true, effective };
  } catch (err) {
    return mapSourceError('work_entity.source.set_enabled', err);
  }
};

export const handleWorkEntitySourceSetMcpExposed = async (
  deps: WorkEntitySourceRpcDeps,
  args: { source_id: string; mcp_exposed: boolean },
): Promise<{ ok: true; effective: SourceRegistration }> => {
  if (typeof args.source_id !== 'string' || args.source_id.length === 0) {
    throw new RpcError(
      'bad_request',
      'work_entity.source.set_mcp_exposed: source_id is required',
    );
  }
  if (typeof args.mcp_exposed !== 'boolean') {
    throw new RpcError(
      'bad_request',
      'work_entity.source.set_mcp_exposed: mcp_exposed must be a boolean',
    );
  }
  try {
    const effective = deps.resolver.setSourceMcpExposed(
      args.source_id,
      args.mcp_exposed,
    );
    return { ok: true, effective };
  } catch (err) {
    return mapSourceError('work_entity.source.set_mcp_exposed', err);
  }
};

export const handleWorkEntitySourceSetDefault = async (
  deps: WorkEntitySourceRpcDeps,
  args: { kind: WorkEntityKind; source_id: string },
): Promise<{ ok: true }> => {
  if (
    typeof args.kind !== 'string'
    || !WORK_ENTITY_KIND_SET.has(args.kind as WorkEntityKind)
  ) {
    throw new RpcError(
      'bad_request',
      `work_entity.source.set_default: unknown kind '${String(args.kind)}'`,
    );
  }
  if (typeof args.source_id !== 'string' || args.source_id.length === 0) {
    throw new RpcError(
      'bad_request',
      'work_entity.source.set_default: source_id is required',
    );
  }
  try {
    deps.resolver.setDefaultSource(args.kind, args.source_id);
    return { ok: true };
  } catch (err) {
    return mapSourceError('work_entity.source.set_default', err);
  }
};

export const handleWorkEntitySourceClearDefault = async (
  deps: WorkEntitySourceRpcDeps,
  args: { kind: WorkEntityKind },
): Promise<{ ok: true; cleared: boolean }> => {
  if (
    typeof args.kind !== 'string'
    || !WORK_ENTITY_KIND_SET.has(args.kind as WorkEntityKind)
  ) {
    throw new RpcError(
      'bad_request',
      `work_entity.source.clear_default: unknown kind '${String(args.kind)}'`,
    );
  }
  try {
    const cleared = deps.resolver.clearDefaultSource(args.kind);
    return { ok: true, cleared };
  } catch (err) {
    return mapSourceError('work_entity.source.clear_default', err);
  }
};

type WorkEntitySourceMethods =
  | 'work_entity.source.list'
  | 'work_entity.source.set_enabled'
  | 'work_entity.source.set_mcp_exposed'
  | 'work_entity.source.set_default'
  | 'work_entity.source.clear_default';

export const makeWorkEntitySourceHandlers = (
  deps: WorkEntitySourceRpcDeps | undefined,
):
  | HandlerSlice<ServerRpcRegistry, WorkEntitySourceMethods, WsClient>
  | undefined => {
  if (!deps) return undefined;
  return {
    methods: [
      'work_entity.source.list',
      'work_entity.source.set_enabled',
      'work_entity.source.set_mcp_exposed',
      'work_entity.source.set_default',
      'work_entity.source.clear_default',
    ],
    handlers: {
      'work_entity.source.list': async () => handleWorkEntitySourceList(deps),
      'work_entity.source.set_enabled': async (args) =>
        handleWorkEntitySourceSetEnabled(
          deps,
          args as Parameters<typeof handleWorkEntitySourceSetEnabled>[1],
        ),
      'work_entity.source.set_mcp_exposed': async (args) =>
        handleWorkEntitySourceSetMcpExposed(
          deps,
          args as Parameters<typeof handleWorkEntitySourceSetMcpExposed>[1],
        ),
      'work_entity.source.set_default': async (args) =>
        handleWorkEntitySourceSetDefault(
          deps,
          args as Parameters<typeof handleWorkEntitySourceSetDefault>[1],
        ),
      'work_entity.source.clear_default': async (args) =>
        handleWorkEntitySourceClearDefault(
          deps,
          args as Parameters<typeof handleWorkEntitySourceClearDefault>[1],
        ),
    },
  };
};

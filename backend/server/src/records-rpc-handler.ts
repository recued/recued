/** D-221 owner control plane for pack-owned Records.
 *
 * This slice is deliberately separate from the recipe/MCP execution path. A
 * registered paired UI may inspect and administer every full-ref namespace;
 * agents can reach rows only through stamped Tier-P operations and grants.
 */
import {
  RecordsContractError,
  RpcError,
  type HandlerSlice,
  type RecordsExportRequest,
  type RecordsGlobalQuotaSetRequest,
  type RecordsOutboxListRequest,
  type RecordsOutboxRetireRequest,
  type RecordsOwnerDeleteRequest,
  type RecordsOwnerGetRequest,
  type RecordsOwnerSearchRequest,
  type RecordsPackRef,
  type RecordsPurgeRequest,
  type RecordsQuotaSetRequest,
  type RecordsRetentionRunRequest,
  type RecordsRetentionSetRequest,
  type ServerRpcRegistry,
} from '@recued/contracts';
import type { RecordsStore } from './records/store.js';
import type { WsClient } from './ws-server.js';

export interface RecordsRpcDeps {
  store: RecordsStore;
}

const requireRegisteredClient = (client: WsClient): void => {
  if (!client.instance_id) {
    throw new RpcError(
      'unauthorized',
      'records rpc requires a registered paired client',
      401,
    );
  }
};

const requireObject = (value: unknown, method: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RpcError('bad_request', `${method}: args must be an object`, 400);
  }
  return value as Record<string, unknown>;
};

const requireOwner = (value: unknown, method: string): RecordsPackRef => {
  const owner = requireObject(value, method);
  if (
    typeof owner.publisher !== 'string'
    || owner.publisher.length === 0
    || typeof owner.pack_slug !== 'string'
    || owner.pack_slug.length === 0
  ) {
    throw new RpcError(
      'bad_request',
      `${method}: owner.publisher and owner.pack_slug are required`,
      400,
    );
  }
  return { publisher: owner.publisher, pack_slug: owner.pack_slug };
};

const mapStoreError = (error: unknown): never => {
  if (!(error instanceof RecordsContractError)) throw error;
  const status = error.code === 'records_not_found'
    ? 404
    : error.code === 'records_unauthorized'
      ? 403
      : error.code === 'records_conflict' || error.code === 'records_noop'
        ? 409
        : error.code === 'records_not_ready' || error.code === 'records_stale_operation'
          ? 423
          : 400;
  throw new RpcError(error.code, error.message, status, undefined, error.details);
};

const fromStore = <T>(read: () => T): T => {
  try {
    return read();
  } catch (error) {
    return mapStoreError(error);
  }
};

type RecordsRpcMethods =
  | 'records.namespace.list'
  | 'records.kind.list'
  | 'records.search'
  | 'records.get'
  | 'records.delete'
  | 'records.quota.set'
  | 'records.quota.set_global'
  | 'records.retention.list'
  | 'records.retention.set'
  | 'records.retention.run'
  | 'records.export'
  | 'records.outbox.list'
  | 'records.outbox.retire'
  | 'records.purge'
  | 'records.accounting.audit'
  | 'records.accounting.repair';

const METHODS: readonly RecordsRpcMethods[] = [
  'records.namespace.list',
  'records.kind.list',
  'records.search',
  'records.get',
  'records.delete',
  'records.quota.set',
  'records.quota.set_global',
  'records.retention.list',
  'records.retention.set',
  'records.retention.run',
  'records.export',
  'records.outbox.list',
  'records.outbox.retire',
  'records.purge',
  'records.accounting.audit',
  'records.accounting.repair',
];

export const makeRecordsRpcHandlers = (
  deps: RecordsRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, RecordsRpcMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: [...METHODS],
    handlers: {
      'records.namespace.list': async (_args, client) => {
        requireRegisteredClient(client);
        return fromStore(() => ({
          namespaces: deps.store.listNamespaces(),
          global_quota: deps.store.getGlobalQuota(),
        }));
      },
      'records.kind.list': async (args, client) => {
        requireRegisteredClient(client);
        const raw = requireObject(args, 'records.kind.list');
        const owner = requireOwner(raw.owner, 'records.kind.list');
        return { kinds: fromStore(() => deps.store.listKinds(owner)) };
      },
      'records.search': async (args, client) => {
        requireRegisteredClient(client);
        const raw = requireObject(args, 'records.search') as unknown as RecordsOwnerSearchRequest;
        return fromStore(() => deps.store.ownerSearch({
          owner: requireOwner(raw.owner, 'records.search'),
          entity: raw.entity,
          ...(raw.filters !== undefined ? { filters: raw.filters } : {}),
          ...(raw.sort !== undefined ? { sort: raw.sort } : {}),
          ...(raw.cursor !== undefined ? { cursor: raw.cursor } : {}),
          ...(raw.limit !== undefined ? { limit: raw.limit } : {}),
          ...(raw.include_orphaned !== undefined ? { include_orphaned: raw.include_orphaned } : {}),
        }));
      },
      'records.get': async (args, client) => {
        requireRegisteredClient(client);
        const raw = requireObject(args, 'records.get') as unknown as RecordsOwnerGetRequest;
        return fromStore(() => deps.store.ownerInspect(
          requireOwner(raw.owner, 'records.get'),
          raw.entity,
          raw.id,
        ));
      },
      'records.delete': async (args, client) => {
        requireRegisteredClient(client);
        const raw = requireObject(args, 'records.delete') as unknown as RecordsOwnerDeleteRequest;
        return fromStore(() => deps.store.ownerDelete({
          owner: requireOwner(raw.owner, 'records.delete'),
          entity: raw.entity,
          id: raw.id,
          expected_version: raw.expected_version,
          expected_revision: raw.expected_revision,
          principal: 'user_self',
        }));
      },
      'records.quota.set': async (args, client) => {
        requireRegisteredClient(client);
        const raw = requireObject(args, 'records.quota.set') as unknown as RecordsQuotaSetRequest;
        return fromStore(() => deps.store.setQuota(
          requireOwner(raw.owner, 'records.quota.set'),
          {
            ...(raw.row_limit !== undefined ? { row_limit: raw.row_limit } : {}),
            ...(raw.byte_limit !== undefined ? { byte_limit: raw.byte_limit } : {}),
            ...(raw.outbox_limit !== undefined ? { outbox_limit: raw.outbox_limit } : {}),
          },
        ));
      },
      'records.quota.set_global': async (args, client) => {
        requireRegisteredClient(client);
        const raw = requireObject(
          args,
          'records.quota.set_global',
        ) as unknown as RecordsGlobalQuotaSetRequest;
        return fromStore(() => deps.store.setGlobalQuota({
          ...(raw.row_limit !== undefined ? { row_limit: raw.row_limit } : {}),
          ...(raw.byte_limit !== undefined ? { byte_limit: raw.byte_limit } : {}),
          ...(raw.outbox_limit !== undefined ? { outbox_limit: raw.outbox_limit } : {}),
        }));
      },
      'records.retention.list': async (args, client) => {
        requireRegisteredClient(client);
        const raw = requireObject(args, 'records.retention.list');
        const owner = requireOwner(raw.owner, 'records.retention.list');
        return { policies: fromStore(() => deps.store.getRetention(owner)) };
      },
      'records.retention.set': async (args, client) => {
        requireRegisteredClient(client);
        const raw = requireObject(args, 'records.retention.set') as unknown as RecordsRetentionSetRequest;
        fromStore(() => deps.store.setRetention(
          requireOwner(raw.owner, 'records.retention.set'),
          raw.entity,
          raw.policy,
        ));
        return { ok: true as const };
      },
      'records.retention.run': async (args, client) => {
        requireRegisteredClient(client);
        const raw = requireObject(args, 'records.retention.run') as unknown as RecordsRetentionRunRequest;
        return fromStore(() => deps.store.runRetention(
          requireOwner(raw.owner, 'records.retention.run'),
          undefined,
          raw.batch_size,
        ));
      },
      'records.export': async (args, client) => {
        requireRegisteredClient(client);
        const raw = requireObject(args, 'records.export') as unknown as RecordsExportRequest;
        const owner = requireOwner(raw.owner, 'records.export');
        if (raw.format !== undefined && raw.format !== 'json' && raw.format !== 'csv') {
          throw new RpcError('bad_request', 'records.export: format must be json or csv', 400);
        }
        return fromStore(() => raw.format === 'csv'
          ? deps.store.exportNamespaceCsv(owner, raw.entity)
          : deps.store.exportNamespace(owner, raw.entity));
      },
      'records.outbox.list': async (args, client) => {
        requireRegisteredClient(client);
        const raw = requireObject(args, 'records.outbox.list') as unknown as RecordsOutboxListRequest;
        return fromStore(() => deps.store.getOutboxOverview(
          requireOwner(raw.owner, 'records.outbox.list'),
          raw.status,
          raw.limit,
        ));
      },
      'records.outbox.retire': async (args, client) => {
        requireRegisteredClient(client);
        const raw = requireObject(args, 'records.outbox.retire') as unknown as RecordsOutboxRetireRequest;
        return {
          retired: fromStore(() => deps.store.retireOutboxEvent(
            requireOwner(raw.owner, 'records.outbox.retire'),
            raw.event_id,
            raw.confirmation,
          )),
        };
      },
      'records.purge': async (args, client) => {
        requireRegisteredClient(client);
        const raw = requireObject(args, 'records.purge') as unknown as RecordsPurgeRequest;
        return fromStore(() => deps.store.ownerPurgeNamespace(
          requireOwner(raw.owner, 'records.purge'),
          raw.confirmation,
        ));
      },
      'records.accounting.audit': async (args, client) => {
        requireRegisteredClient(client);
        const raw = requireObject(args, 'records.accounting.audit');
        return fromStore(() => deps.store.auditAccounting(
          requireOwner(raw.owner, 'records.accounting.audit'),
        ));
      },
      'records.accounting.repair': async (args, client) => {
        requireRegisteredClient(client);
        const raw = requireObject(args, 'records.accounting.repair');
        return fromStore(() => deps.store.repairAccounting(
          requireOwner(raw.owner, 'records.accounting.repair'),
        ));
      },
    },
  };
};

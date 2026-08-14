/** D-174 #22 — rpc handlers for `work_entity.{list,get,upsert,delete}`.
 *
 *  The webclient Data route's warehouse-CRUD surface over the four
 *  own-it work-entity kinds (task / note / commitment / project). Thin
 *  handlers over the EXISTING substrate — no storage logic is
 *  duplicated:
 *    - `list` / `get` read through the `WorkEntityResolver` (the same
 *      polymorphic + validity-filtered read path recipe-side
 *      `data.<kind>.*` reads use) + the store for the filter-matched
 *      total.
 *    - `upsert` / `delete` route by `(kind, id-presence)` to the
 *      `createWorkEntityDispatchers` create/update/delete slots so every
 *      write fans `emitWorkEntityEvent` (+ enrichment cascade) — the
 *      SAME emitting path the recipe / MCP ingredient channel uses, so
 *      reactive recipes + D-115 triggers + D-136 cascade fire uniformly.
 *
 *  Channel: local-UI / paired-client only. Mirrors `contact.*` exactly
 *  — registered-client gated by the WS-rpc bearer handshake; MCP-channel
 *  agents are on a separate server and reach work-entity writes ONLY
 *  through the gateway-gated ingredient catalog, never this rpc. The
 *  `work_entity.*` namespace is intentionally NOT in
 *  `MCP_RESERVED_RPC_PREFIXES` (matching base `contact.*` +
 *  `work_entity.source.*`): the MCP catalog is a closed `recued_*`
 *  allowlist, so an rpc method name can never bridge onto it.
 *
 *  Spec: D-174 D11 + D-145 § A.1 / A.2. */

import {
  RpcError,
  WORK_ENTITY_KIND_SET,
  type ExecutionSource,
  type HandlerSlice,
  type ServerRpcRegistry,
  type WorkEntity,
  type WorkEntityEdge,
  type WorkEntityEdgeView,
  type WorkEntityKind,
  type WorkEntityListRpcRequest,
  type WorkEntityListRpcResponse,
  type WorkEntityGetRpcRequest,
  type WorkEntityGetRpcResponse,
  type WorkEntityUpsertRpcRequest,
  type WorkEntityUpsertRpcResponse,
  type WorkEntityDeleteRpcRequest,
  type WorkEntityDeleteRpcResponse,
} from '@recued/contracts';

import type { WsClient } from './ws-server.js';
import {
  SourceRegistrationError,
  WorkEntityValidationError,
  type WorkEntityListQuery,
  type WorkEntityStore,
} from './storage/work-entity-store.js';
import type { WorkEntityEdgeStore } from './storage/work-entity-edge-store.js';
import { readThroughSourceIds } from './work-entity-read-resolution.js';
import {
  WorkEntityResolverError,
  type WorkEntityResolver,
} from './work-entity-resolver.js';
import {
  CommitmentLifecycleError,
  WorkEntityContainerPickRequiredError,
  WorkEntityNotFoundError,
  WorkEntityWriteCapabilityError,
  type createWorkEntityDispatchers,
} from './work-entity-ingredients.js';

type WorkEntityDispatchers = ReturnType<typeof createWorkEntityDispatchers>;

export interface WorkEntityCrudRpcDeps {
  /** Read path for `list` count + (via the resolver below) the rows. */
  store: WorkEntityStore;
  /** Validity-filtered polymorphic reads (the recipe-side read path). */
  resolver: WorkEntityResolver;
  /** Event-emitting write path — the SAME dispatcher instance the
   *  engine/ingredient channel uses (wired with the warehouse bus +
   *  enrichment cascade at boot), so pair-RPC writes fan the canonical
   *  warehouse events. */
  dispatchers: WorkEntityDispatchers;
  /** D-192 P5 — work-graph edges: `get` responses carry the row's live
   *  relationship edges when wired. Optional (older composition / no
   *  edge substrate → the field stays absent). */
  edges?: Pick<WorkEntityEdgeStore, 'listByOwner'>;
  /** D-192 P5 — the D-138 `contact_id → survivor` forward-resolver for
   *  contact-edge display (the reader's two-hop resolve: a merge
   *  loser's edge surfaces the SURVIVOR's identity). */
  contactDisplay?: {
    getByContactIdResolved(
      contact_id: string,
    ): { contact_id?: string; name?: string; email: string } | null;
  };
}

/** Project one stored edge into the read-surface view. Contact edges
 *  forward-resolve at READ time — the stored `contact_id` may be a
 *  D-138 merge loser; the view carries the survivor's id + display
 *  identity so the graph converges without rewriting stored edges. */
const edgeToView = (
  edge: WorkEntityEdge,
  contactDisplay: WorkEntityCrudRpcDeps['contactDisplay'],
): WorkEntityEdgeView => {
  const view: WorkEntityEdgeView = {
    local_field: edge.local_field,
    target_kind: edge.target_kind,
    resolved: edge.target_local_id !== undefined,
    ...(edge.target_local_id !== undefined ? { target_local_id: edge.target_local_id } : {}),
    ...(edge.target_remote_entity !== undefined
      ? { target_remote_entity: edge.target_remote_entity }
      : {}),
    ...(edge.target_remote_id !== undefined ? { target_remote_id: edge.target_remote_id } : {}),
  };
  if (
    edge.target_kind === 'contact'
    && edge.target_local_id !== undefined
    && contactDisplay !== undefined
  ) {
    const survivor = contactDisplay.getByContactIdResolved(edge.target_local_id);
    if (survivor !== null) {
      if (survivor.contact_id !== undefined) view.target_local_id = survivor.contact_id;
      view.target_display =
        survivor.name !== undefined && survivor.name.length > 0
          ? survivor.name
          : survivor.email;
    }
  }
  return view;
};

/** Translate a typed substrate error into the rpc surface's
 *  `bad_request` / `not_found` shape. Unknown errors propagate so test
 *  failures surface cleanly. */
const mapCrudError = (method: string, err: unknown): never => {
  if (err instanceof WorkEntityNotFoundError) {
    throw new RpcError('not_found', `${method}: ${err.message}`);
  }
  if (err instanceof WorkEntityResolverError) {
    if (err.code === 'unknown_source') {
      throw new RpcError('not_found', `${method}: ${err.message}`);
    }
    throw new RpcError('bad_request', `${method}: ${err.message}`);
  }
  // D-192 Slice 6a — an ambiguous container dependency: surface the choice set so
  // an agent can re-issue the create with the container selected (Slice 6b replaces
  // this with a D-158 notification.ask at the chat boundary).
  if (err instanceof WorkEntityContainerPickRequiredError) {
    throw new RpcError('bad_request', `${method}: ${err.message}`, 400, method, {
      reason: 'container_pick_required',
      dependency_ref: err.dependency_ref,
      options: err.options,
      can_create: err.can_create,
    });
  }
  if (
    err instanceof WorkEntityWriteCapabilityError
    || err instanceof CommitmentLifecycleError
    || err instanceof WorkEntityValidationError
  ) {
    throw new RpcError('bad_request', `${method}: ${err.message}`);
  }
  if (err instanceof SourceRegistrationError) {
    if (/not registered/i.test(err.message)) {
      throw new RpcError('not_found', `${method}: ${err.message}`);
    }
    throw new RpcError('bad_request', `${method}: ${err.message}`);
  }
  throw err;
};

/** Require a registered paired client. A connection that hasn't
 *  completed the pairing register handshake has `instance_id === null`;
 *  reject it so an unregistered / pre-register (or legacy raw-bearer) WS
 *  caller can neither read nor mutate work entities through this local-UI
 *  surface. Mirrors `account-binding-handler.ts`'s registered-client gate
 *  (the dispatch's "registered-client gated" requirement) — applied to
 *  reads too, so the warehouse stays a registered-local-UI surface. */
const requireRegisteredClient = (client: WsClient): void => {
  if (!client.instance_id) {
    throw new RpcError(
      'unauthorized',
      'work_entity rpc requires a registered paired client',
      401,
    );
  }
};

/** D-192 baseline-admission (S2b follow-on) — the OWNER's `(user, user_self)` HID
 *  ExecutionSource for a paired-client `work_entity.upsert`. A registered paired client
 *  is the owner (pairing is owner-only via the recovery key), acting through their own
 *  local UI — the D-153 `(user, user_self)` cell: contract-free, so the S2 admission
 *  admits their direct vendor create under full permission (an owner-AI revoke, which
 *  keys on the `chat`/`messenger` channel, does NOT reach this direct HID). Mirrors
 *  `execute-handler.ts`'s `buildRpcUserExecutionSource` (the same webclient-rpc source the
 *  `execute` method builds); duplicated locally to keep this focused rpc handler off the
 *  engine module. Built ONLY after `requireRegisteredClient` gates the caller. NB: if
 *  non-owner delegated pairing ever ships, a delegated client must resolve to
 *  `contracted_user`, not `user_self` — revisit here. */
const buildOwnerHidSource = (client: WsClient): ExecutionSource => ({
  channel: 'user',
  actor: 'user_self',
  user_id: client.user_id ?? 'local',
  client_token_id: client.client_token_id ?? client.instance_id ?? 'unregistered',
});

/** Guard + narrow the `kind` discriminator to a known own-it kind. */
const requireKind = (method: string, kind: unknown): WorkEntityKind => {
  if (
    typeof kind !== 'string'
    || !WORK_ENTITY_KIND_SET.has(kind as WorkEntityKind)
  ) {
    throw new RpcError(
      'bad_request',
      `${method}: unknown work entity kind '${String(kind)}'`,
    );
  }
  return kind as WorkEntityKind;
};

/** Require a non-empty string id. */
const requireId = (method: string, id: unknown): string => {
  if (typeof id !== 'string' || id.length === 0) {
    throw new RpcError('bad_request', `${method}: id is required`);
  }
  return id;
};

/** Decide create vs update from the wire payload's `id`, validating it
 *  when present. `id` absent / undefined / null → create; a non-empty
 *  string → update; a present-but-malformed `id` (empty string, number,
 *  object, …) → `bad_request` rather than silently falling through to a
 *  create (which would duplicate a row + emit `created` instead of
 *  `updated`, fooling reactive consumers). */
const upsertMode = (
  method: string,
  args: WorkEntityUpsertRpcRequest,
): 'create' | 'update' => {
  const id = (args as { id?: unknown }).id;
  if (id === undefined || id === null) return 'create';
  if (typeof id !== 'string' || id.length === 0) {
    throw new RpcError(
      'bad_request',
      `${method}: id must be a non-empty string when provided`,
    );
  }
  return 'update';
};

export const handleWorkEntityList = async (
  deps: WorkEntityCrudRpcDeps,
  args: WorkEntityListRpcRequest,
): Promise<WorkEntityListRpcResponse> => {
  const kind = requireKind('work_entity.list', args.kind);
  if (
    kind !== 'booking'
    && (args.search !== undefined || args.booking_lifecycle_states !== undefined)
  ) {
    throw new RpcError(
      'bad_request',
      'work_entity.list: search and booking_lifecycle_states are booking-only filters',
    );
  }
  // Build the store-layer query from the wire request. The resolver
  // applies the default `live` + `stale_unreachable` + enabled-Source
  // filters; `count` reuses the same filters but drops limit/offset.
  const filters: WorkEntityListQuery = {};
  if (args.source_id !== undefined) filters.source_id = args.source_id;
  if (args.sync_states !== undefined) filters.sync_states = args.sync_states;
  if (args.include_deleted !== undefined) filters.include_deleted = args.include_deleted;
  if (kind === 'booking' && args.search !== undefined) filters.search = args.search;
  if (kind === 'booking' && args.booking_lifecycle_states !== undefined) {
    filters.booking_lifecycle_states = args.booking_lifecycle_states;
  }
  try {
    const listQuery: WorkEntityListQuery = { ...filters };
    if (args.limit !== undefined) listQuery.limit = args.limit;
    if (args.offset !== undefined) listQuery.offset = args.offset;
    // A read_through Source materializes no canonical rows. Scoping the list
    // to one cannot be answered here, and an empty list would read as "no
    // records" — the freshness block below still reports the Source as
    // present, so the two halves would contradict each other.
    const readThrough = readThroughSourceIds(deps.store.listSources());
    if (args.source_id !== undefined && readThrough.has(args.source_id)) {
      throw new RpcError(
        'bad_request',
        `work_entity.list: source '${args.source_id}' is read_through and keeps no local rows — `
          + 'it is read on demand through its provider operations, not the canonical tables',
      );
    }
    // Defensive residue filter, matching `work.search` and the recipe-callable
    // list: an interrupted posture migration must never serve rows the
    // declaration says do not exist. `total` stays on the same basis.
    const rows = deps.resolver.listByKind(kind, listQuery);
    const entities = rows.filter((entity) => !readThrough.has(entity.source_id));
    const total = deps.store.countByKind(kind, filters)
      - (rows.length - entities.length);
    // D-192 read resolution — per-Source freshness for the query's
    // scope (same filter composition as the rows), so the client
    // renders staleness honestly (a poll mirror may trail the vendor).
    // Null = no sync substrate wired → field omitted; an EMPTY verdict
    // set on a wired server is carried as `[]` so the two stay
    // distinguishable on the wire (codex fold).
    const source_freshness = deps.resolver.sourceFreshness(kind, {
      ...(args.source_id !== undefined ? { source_id: args.source_id } : {}),
    });
    return {
      entities,
      total,
      ...(source_freshness !== null ? { source_freshness } : {}),
    };
  } catch (err) {
    return mapCrudError('work_entity.list', err);
  }
};

export const handleWorkEntityGet = async (
  deps: WorkEntityCrudRpcDeps,
  args: WorkEntityGetRpcRequest,
): Promise<WorkEntityGetRpcResponse> => {
  const kind = requireKind('work_entity.get', args.kind);
  const id = requireId('work_entity.get', args.id);
  try {
    const entity = deps.resolver.readEntity(kind, id);
    if (entity === null) return { entity };
    // D-192 read resolution — the row own Source verdict.
    const [source_freshness] = deps.resolver.sourceFreshness(kind, {
      source_id: entity.source_id,
    }) ?? [];
    // D-192 P5 — the row's live work-graph edges. Present (possibly
    // empty) whenever the substrate is wired and the kind carries
    // edges (`commitment` never syncs through this substrate); absent
    // otherwise — the source_freshness wire-distinguishability rule.
    const relationship_edges =
      deps.edges !== undefined
      && (kind === 'task' || kind === 'project' || kind === 'note')
        ? deps.edges
            .listByOwner(kind, entity.id)
            .map((edge) => edgeToView(edge, deps.contactDisplay))
        : undefined;
    const booking_history =
      kind === 'booking'
      && entity._kind === 'booking'
      && entity.counterparty_contact_id !== undefined
        ? deps.store.getBookingHistory({
            counterparty_contact_id: entity.counterparty_contact_id,
            exclude_booking_id: entity.id,
            limit: 10,
          })
        : undefined;
    return {
      entity,
      ...(source_freshness !== undefined ? { source_freshness } : {}),
      ...(relationship_edges !== undefined ? { relationship_edges } : {}),
      ...(booking_history !== undefined ? { booking_history } : {}),
    };
  } catch (err) {
    return mapCrudError('work_entity.get', err);
  }
};

export const handleWorkEntityUpsert = async (
  deps: WorkEntityCrudRpcDeps,
  args: WorkEntityUpsertRpcRequest,
  /** D-192 baseline-admission (S2b follow-on) — the SERVER-DERIVED execution source of
   *  the acting client, built by the slice arrow from the authenticated paired client
   *  (never caller-supplied). A registered paired client is the OWNER (pairing is
   *  owner-only), so this is the owner's `(user, user_self)` HID source: contract-free →
   *  the S2 admission admits the direct-UI vendor create (owner = full permission). Absent
   *  (dbless / unit callers) ⇒ the create degrades on `'ask'` as before. */
  callerSource?: ExecutionSource,
): Promise<WorkEntityUpsertRpcResponse> => {
  const kind = requireKind('work_entity.upsert', (args as { kind?: unknown }).kind);
  const update = upsertMode('work_entity.upsert', args) === 'update';
  // D-192 6c.2c + baseline-admission (S2) — the vendor-write admission inputs are
  // ADAPTER/ENGINE-SET ONLY: `work_entity_write_preadmitted` (the create-plan re-run
  // flag) and `origin_execution_source` (the dispatch identity that drives the actor-aware
  // contract-grant admission). On the engine path they ride the kernel adapter's
  // `withCreateOrigin`, which strips any caller-supplied value. This direct wire rpc
  // bypasses that adapter, so a client could otherwise smuggle either — self-admitting a
  // vendor write past its `'ask'` gate (a forged flag) or spoofing a privileged actor (a
  // forged source). Strip BOTH forged inputs, then RE-ATTACH the trusted server-derived
  // `callerSource` (the owner's HID) for a CREATE, so the owner's direct-UI vendor create
  // admits under their full permission. The admission flag stays stripped (no wire source).
  const {
    work_entity_write_preadmitted: _forgedAdmission,
    origin_execution_source: _forgedSource,
    ...stripped
  } = args as WorkEntityUpsertRpcRequest & {
    work_entity_write_preadmitted?: unknown;
    origin_execution_source?: unknown;
  };
  // Create-only: the S2 admission is create-only, and the create dispatchers alone read
  // `origin_execution_source` (update/delete ignore it). Attaching on !update keeps the
  // update path byte-identical.
  const safeArgs =
    !update && callerSource !== undefined
      ? { ...stripped, origin_execution_source: callerSource }
      : stripped;
  try {
    switch (kind) {
      case 'task': {
        const { task } = update
          ? await deps.dispatchers.taskUpdate(
              safeArgs as unknown as Parameters<WorkEntityDispatchers['taskUpdate']>[0],
            )
          : await deps.dispatchers.taskCreate(
              safeArgs as unknown as Parameters<WorkEntityDispatchers['taskCreate']>[0],
            );
        return { entity: { _kind: 'task', ...task } satisfies WorkEntity };
      }
      case 'note': {
        const { note } = update
          ? await deps.dispatchers.noteUpdate(
              safeArgs as unknown as Parameters<WorkEntityDispatchers['noteUpdate']>[0],
            )
          : await deps.dispatchers.noteCreate(
              safeArgs as unknown as Parameters<WorkEntityDispatchers['noteCreate']>[0],
            );
        return { entity: { _kind: 'note', ...note } satisfies WorkEntity };
      }
      case 'commitment': {
        const { commitment } = update
          ? await deps.dispatchers.commitmentUpdate(
              safeArgs as unknown as Parameters<WorkEntityDispatchers['commitmentUpdate']>[0],
            )
          : await deps.dispatchers.commitmentCreate(
              safeArgs as unknown as Parameters<WorkEntityDispatchers['commitmentCreate']>[0],
            );
        return { entity: { _kind: 'commitment', ...commitment } satisfies WorkEntity };
      }
      case 'project': {
        const { project } = update
          ? await deps.dispatchers.projectUpdate(
              safeArgs as unknown as Parameters<WorkEntityDispatchers['projectUpdate']>[0],
            )
          : await deps.dispatchers.projectCreate(
              safeArgs as unknown as Parameters<WorkEntityDispatchers['projectCreate']>[0],
            );
        return { entity: { _kind: 'project', ...project } satisfies WorkEntity };
      }
      case 'booking': {
        const { booking } = update
          ? await deps.dispatchers.bookingUpdate(
              safeArgs as unknown as Parameters<WorkEntityDispatchers['bookingUpdate']>[0],
            )
          : await deps.dispatchers.bookingCreate(
              safeArgs as unknown as Parameters<WorkEntityDispatchers['bookingCreate']>[0],
            );
        return { entity: { _kind: 'booking', ...booking } satisfies WorkEntity };
      }
    }
  } catch (err) {
    return mapCrudError('work_entity.upsert', err);
  }
};

export const handleWorkEntityDelete = async (
  deps: WorkEntityCrudRpcDeps,
  args: WorkEntityDeleteRpcRequest,
): Promise<WorkEntityDeleteRpcResponse> => {
  const kind = requireKind('work_entity.delete', args.kind);
  const id = requireId('work_entity.delete', args.id);
  const input: { id: string; tombstone?: boolean } = { id };
  if (args.tombstone !== undefined) input.tombstone = args.tombstone;
  try {
    switch (kind) {
      case 'task':
        return await deps.dispatchers.taskDelete(input);
      case 'note':
        return await deps.dispatchers.noteDelete(input);
      case 'commitment':
        return await deps.dispatchers.commitmentDelete(input);
      case 'project':
        return await deps.dispatchers.projectDelete(input);
      case 'booking':
        return await deps.dispatchers.bookingDelete(input);
    }
  } catch (err) {
    return mapCrudError('work_entity.delete', err);
  }
};

type WorkEntityCrudMethods =
  | 'work_entity.list'
  | 'work_entity.get'
  | 'work_entity.upsert'
  | 'work_entity.delete';

export const makeWorkEntityCrudHandlers = (
  deps: WorkEntityCrudRpcDeps | undefined,
):
  | HandlerSlice<ServerRpcRegistry, WorkEntityCrudMethods, WsClient>
  | undefined => {
  if (!deps) return undefined;
  return {
    methods: [
      'work_entity.list',
      'work_entity.get',
      'work_entity.upsert',
      'work_entity.delete',
    ],
    handlers: {
      // Registered-client gate (the WS-rpc local-UI boundary) is enforced
      // at the slice arrow — the exported handlers stay client-agnostic +
      // unit-testable. An unregistered / pre-register WS caller is rejected
      // before any read or write.
      'work_entity.list': async (args, client) => {
        requireRegisteredClient(client);
        return handleWorkEntityList(deps, args as WorkEntityListRpcRequest);
      },
      'work_entity.get': async (args, client) => {
        requireRegisteredClient(client);
        return handleWorkEntityGet(deps, args as WorkEntityGetRpcRequest);
      },
      'work_entity.upsert': async (args, client) => {
        requireRegisteredClient(client);
        // The owner's HID source (server-derived from the authenticated paired client)
        // so a direct-UI vendor create admits past the vendor op's `'ask'` gate under the
        // owner's full permission (D-192 baseline-admission S2b follow-on).
        return handleWorkEntityUpsert(
          deps,
          args as WorkEntityUpsertRpcRequest,
          buildOwnerHidSource(client),
        );
      },
      'work_entity.delete': async (args, client) => {
        requireRegisteredClient(client);
        return handleWorkEntityDelete(deps, args as WorkEntityDeleteRpcRequest);
      },
    },
  };
};

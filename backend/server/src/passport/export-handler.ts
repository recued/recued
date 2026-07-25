/** R26.4 Delta 2 (D-148 § A.9 P8) — `passport.export` + `passport.history.list`
 *  rpc handler slices. The user-initiated half of the passport surface.
 *
 *  Sibling to `fetch-handler.ts`. Where `passport.fetch` is the internal
 *  cert-pin verify path (support_redacted only, NO audit, fires every
 *  reconnect), these are the operator's deliberate actions surfaced in
 *  Settings → Backup & Recovery:
 *
 *    - `passport.export` — mints a signed projection at the chosen
 *      profile, emits the `passport.exported` HIGH-ASSURANCE audit row
 *      (records INTENT), and appends to the durable history store. The
 *      webclient renders the signed JSON for download / sharing.
 *    - `passport.history.list` — reads the history store (newest first)
 *      for the export-history view.
 *
 *  Both reuse the SAME `PassportBlockProviders` + per-call
 *  `server_identity_key` getter the fetch substrate composes — the only
 *  additions are a REAL audit emitter + the history store (the fetch
 *  path routes around both by design).
 *
 *  Channel isolation: `passport.` is in `MCP_RESERVED_RPC_PREFIXES`, so
 *  neither handler is reachable from the MCP surface — a compromised
 *  agent must never mint an identity-disclosing passport nor enumerate
 *  export history. Operator-only by construction. */

import {
  PASSPORT_REASON_MAX_BYTES,
  RpcError,
  SERVER_PASSPORT_PROFILES,
  type HandlerSlice,
  type ServerPassportExportOptions,
  type ServerPassportHistoryEntry,
  type ServerPassportHistoryListArgs,
  type ServerPassportProfile,
  type ServerPassportProjection,
  type ServerRpcRegistry,
} from '@recued/contracts';

import type { WsClient } from '../ws-server.js';
import type { Ed25519Keypair } from '../keys/index.js';
import {
  exportServerPassport,
  type PassportAuditEmitter,
  type PassportBlockProviders,
  type PassportHistoryStore,
} from './index.js';
import type { PassportImportRpcDeps } from './import-handler.js';

/** Same sentinel `fetch-handler.ts` uses — a webclient authenticated by
 *  bearer token never sends the legacy `register` message, so
 *  `instance_id` is null. The value flows into the projection metadata +
 *  the audit row's attribution; an export is operator-only behind the
 *  reserved-prefix gate, so a sentinel id is informational, not a
 *  security boundary. */
const UNREGISTERED_WEBCLIENT_BEARER_SENTINEL = 'webclient-bearer-unregistered';

export interface PassportExportRpcDeps {
  /** Substrate block providers — shared with the fetch path. */
  providers: PassportBlockProviders;
  /** Per-call getter for the live `server_identity_key` (a rotation
   *  between deps construction + the call signs with the live key). */
  serverIdentity: () => Ed25519Keypair;
  /** REAL audit emitter — unlike fetch, export records the
   *  `passport.exported` high-assurance row. */
  audit: PassportAuditEmitter;
  /** Durable history cache the export appends to + history.list reads. */
  history: PassportHistoryStore;
  /** Clock seam (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Id mint seam (tests). Defaults to `randomUUID`. */
  mintId?: () => string;
}

export interface PassportHistoryListRpcDeps {
  history: PassportHistoryStore;
}

/** Bundle threaded through boot as a single config field (alongside the
 *  fetch deps) so the two user-facing handlers add only one let-binding
 *  to the wiring chain. */
export interface PassportUserRpcDeps {
  export: PassportExportRpcDeps;
  historyList: PassportHistoryListRpcDeps;
  /** R26.4 Delta 5 — passport import commit (new-server migration). Present
   *  whenever the user-rpc half is (same `auditLog` gate). */
  import: PassportImportRpcDeps;
}

export const handlePassportExport = async (
  deps: PassportExportRpcDeps,
  args: ServerPassportExportOptions,
  ctx: WsClient,
): Promise<{ passport: ServerPassportProjection }> => {
  const profile = args?.profile;
  if (
    !(SERVER_PASSPORT_PROFILES as ReadonlyArray<ServerPassportProfile>).includes(
      profile,
    )
  ) {
    // Validate at the trust boundary even though the webclient also
    // guards — an unknown profile would otherwise flow into the
    // projection switch as a sparse passthrough.
    throw new RpcError('bad_request', 'unknown passport profile', 400);
  }
  if (
    args.reason !== undefined &&
    Buffer.byteLength(args.reason, 'utf8') > PASSPORT_REASON_MAX_BYTES
  ) {
    throw new RpcError(
      'bad_request',
      `reason exceeds ${PASSPORT_REASON_MAX_BYTES} bytes`,
      400,
    );
  }
  const exported_by_client_id =
    ctx.instance_id ?? UNREGISTERED_WEBCLIENT_BEARER_SENTINEL;
  const signed = await exportServerPassport({
    providers: deps.providers,
    serverIdentity: deps.serverIdentity(),
    audit: deps.audit,
    exported_by_client_id,
    options: {
      profile,
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
    },
    history: deps.history,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.mintId !== undefined ? { mintId: deps.mintId } : {}),
  });
  return { passport: signed };
};

export const handlePassportHistoryList = async (
  deps: PassportHistoryListRpcDeps,
  args: ServerPassportHistoryListArgs,
): Promise<{ rows: ServerPassportHistoryEntry[] }> => {
  const rows = await deps.history.list({
    ...(args?.limit !== undefined ? { limit: args.limit } : {}),
    ...(args?.before !== undefined ? { before: args.before } : {}),
  });
  return { rows };
};

export const makePassportExportHandlers = (
  deps: PassportExportRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, 'passport.export', WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['passport.export'],
    handlers: {
      'passport.export': async (args, ctx) => handlePassportExport(deps, args, ctx),
    },
  };
};

export const makePassportHistoryListHandlers = (
  deps: PassportHistoryListRpcDeps | undefined,
):
  | HandlerSlice<ServerRpcRegistry, 'passport.history.list', WsClient>
  | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['passport.history.list'],
    handlers: {
      'passport.history.list': async (args) => handlePassportHistoryList(deps, args),
    },
  };
};

/** R26.4 Delta 5 (D-148 § A.9 import half) — `passport.import` rpc handler.
 *
 *  The COMMIT half of passport migration (model A re-anchor, owner-ratified
 *  2026-06-25). Sibling to `export-handler.ts`: where `passport.export` mints
 *  a signed projection on the OLD server, `passport.import` consumes one on
 *  the NEW server's onboarding flow.
 *
 *  The server RE-VERIFIES the uploaded passport's signature against its
 *  embedded public key (never trusts the client preview), refuses anything
 *  but a `migration_full` profile / a self-import, and records the high-
 *  assurance `passport.imported` provenance row binding the old identity →
 *  the live one. It does NOT claim the handle cloud-side — the pro-convenience
 *  provisioner (`handle-provisioner.ts`) owns that `reReserve` re-anchor; this
 *  handler only reports whether it's still pending.
 *
 *  Channel isolation: `passport.` is in `MCP_RESERVED_RPC_PREFIXES`, so a
 *  compromised MCP agent can never rewrite the server's identity-provenance
 *  ledger. Operator-only by construction. */

import {
  RpcError,
  type HandlerSlice,
  type ServerPassportImportCommitResult,
  type ServerPassportProjection,
  type ServerRpcRegistry,
} from '@recued/contracts';

import type { WsClient } from '../ws-server.js';
import type { Ed25519Keypair } from '../keys/index.js';
import { commitImportedPassport, type PassportAuditEmitter } from './index.js';

/** Same sentinel `export-handler.ts` uses — a bearer-authenticated webclient
 *  never sends the legacy `register` message, so `instance_id` is null. The
 *  value flows into the audit row's attribution; import is operator-only
 *  behind the reserved-prefix gate, so a sentinel id is informational, not a
 *  security boundary. */
const UNREGISTERED_WEBCLIENT_BEARER_SENTINEL = 'webclient-bearer-unregistered';

export interface PassportImportRpcDeps {
  /** Per-call getter for the live `server_identity_key` (a rotation between
   *  deps construction + the call computes the new publisher_id from the live
   *  key). */
  serverIdentity: () => Ed25519Keypair;
  /** High-assurance audit emitter — the `passport.imported` row records the
   *  migration provenance. */
  audit: PassportAuditEmitter;
  /** Optional live handle-state reader (publisher_id + current_handle) used
   *  only to compute `handle_reanchor_pending`. Absent / resolves null when
   *  the server holds no handle. */
  loadHandleState?: () => Promise<{ publisher_id: string; current_handle: string } | null>;
  /** Clock seam (tests). Defaults to `Date.now`. */
  now?: () => number;
}

export const handlePassportImport = async (
  deps: PassportImportRpcDeps,
  args: { passport: ServerPassportProjection },
  ctx: WsClient,
): Promise<ServerPassportImportCommitResult> => {
  const passport = args?.passport;
  if (!passport || typeof passport !== 'object') {
    // Malformed input at the trust boundary — distinct from a well-formed
    // passport that fails verification (those surface as `{ ok: false }`).
    throw new RpcError('bad_request', 'missing or malformed passport', 400);
  }
  const handleState = deps.loadHandleState ? await deps.loadHandleState() : null;
  const imported_by_client_id =
    ctx.instance_id ?? UNREGISTERED_WEBCLIENT_BEARER_SENTINEL;
  return commitImportedPassport({
    passport,
    serverIdentity: deps.serverIdentity(),
    audit: deps.audit,
    imported_by_client_id,
    handleState,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
};

export const makePassportImportHandlers = (
  deps: PassportImportRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, 'passport.import', WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['passport.import'],
    handlers: {
      'passport.import': async (args, ctx) => handlePassportImport(deps, args, ctx),
    },
  };
};

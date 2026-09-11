/** D-169 P0 — RPC handler for `bridge.capabilityProfile.push`.
 *
 *  Paired bridges call this on every (re)connect AND on every
 *  `chrome.permissions.onAdded` / `onRemoved` event, supplying a fresh
 *  `BridgeCapabilityProfile`. The handler stamps the authenticated WS
 *  caller's `client_token_id` as the registry key — the payload doesn't
 *  carry a target id, so a malicious bridge cannot shadow another
 *  bridge's profile. Slice 4's multi-bridge dispatcher consults the
 *  registry's `granted_origins` per bridge at eligibility-filter time;
 *  this handler is the producer side of that read.
 *
 *  Channel-isolation: `bridge.` is in `MCP_RESERVED_RPC_PREFIXES`, so
 *  MCP-channel agents cannot invoke this rpc — the dispatcher rejects at
 *  the prefix gate. The `client_token_id` stamping is a defense-in-depth
 *  measure against a future widening that surfaces the rpc on a less
 *  trusted channel.
 *
 *  No audit emission. The push is best-effort + frequent (fires on
 *  every reconnect + every grant change); writing an audit row per call
 *  would flood the ledger without informing any user-facing surface.
 *  D-120 memory still captures the resulting dispatcher decisions via
 *  the existing execution-complete write path.
 */

import {
  RpcError,
  BRIDGE_REVIEW_DOCUMENT_LIMIT,
  isBridgeDocumentIdentity,
  type BridgeCapabilityProfile,
  type HandlerSlice,
  type ServerRpcRegistry,
} from '@recued/contracts';
import type { BridgeRegistry } from './bridges/registry.js';
import type { WsClient } from './ws-server.js';

export interface BridgeCapabilityHandlerDeps {
  registry: BridgeRegistry;
  /** Clock seam (tests). Defaults to `Date.now`. Pins the
   *  `last_seen_at` stamp on the registry record. */
  now?: () => number;
}

/** Pure handler — invoked by the rpc dispatcher with the resolved
 *  `client_token_id` from the WS context + the validated args. Throws
 *  `RpcError` rather than returning a status code so the dispatcher's
 *  standard error envelope carries the failure to the caller. */
export const handleBridgeCapabilityProfilePush = (
  deps: BridgeCapabilityHandlerDeps,
  client_token_id: string | undefined,
  args: { profile: BridgeCapabilityProfile } | null | undefined,
): { ok: true } => {
  if (!client_token_id) {
    // The bridge MUST authenticate with the structured `<token_id>.<bearer>`
    // shape; the WS upgrade resolves the token_id + writes it onto
    // `WsClient.client_token_id`. Absent = legacy raw-bearer connection
    // (not a real bridge SW) OR a composition that didn't wire the
    // `clientTokens.verify` slice. Either way, we can't pin a registry
    // key without an authenticated identity — reject.
    throw new RpcError(
      'unauthorized',
      'bridge.capabilityProfile.push requires authenticated bridge identity',
      undefined,
      'bridge.capabilityProfile.push',
    );
  }
  if (!args || !args.profile || typeof args.profile !== 'object') {
    throw new RpcError(
      'invalid_argument',
      'bridge.capabilityProfile.push requires a profile object',
      undefined,
      'bridge.capabilityProfile.push',
    );
  }
  const profile = args.profile;
  if (
    typeof profile.software_version !== 'string' ||
    typeof profile.chrome_version !== 'string' ||
    !Array.isArray(profile.permissions_granted) ||
    !Array.isArray(profile.granted_origins) ||
    typeof profile.offscreen_supported !== 'boolean' ||
    typeof profile.alarms_supported !== 'boolean'
  ) {
    throw new RpcError(
      'invalid_argument',
      'bridge.capabilityProfile.push: profile is missing required fields',
      undefined,
      'bridge.capabilityProfile.push',
    );
  }
  // Belt-and-suspenders array-element validation (Codex 2026-05-28
  // Angle 5 fold). The contract types `permissions_granted` /
  // `granted_origins` as `string[]` and the optional `user_agent` as
  // string; the runtime `Array.isArray` checks above don't pin element
  // types. A bridge sending `[123]` would otherwise persist non-string
  // values that downstream consumers (`filterEligible`, side panel
  // renderers) read as strings — quiet corruption.
  if (
    !profile.permissions_granted.every((v) => typeof v === 'string') ||
    !profile.granted_origins.every((v) => typeof v === 'string')
  ) {
    throw new RpcError(
      'invalid_argument',
      'bridge.capabilityProfile.push: permissions_granted / granted_origins must be string arrays',
      undefined,
      'bridge.capabilityProfile.push',
    );
  }
  if (profile.user_agent !== undefined && typeof profile.user_agent !== 'string') {
    throw new RpcError(
      'invalid_argument',
      'bridge.capabilityProfile.push: user_agent must be a string when present',
      undefined,
      'bridge.capabilityProfile.push',
    );
  }
  const documents = profile.dom_documents;
  if (documents !== undefined && (!documents || documents.version !== 1 || !Array.isArray(documents.documents)
    || documents.documents.length > BRIDGE_REVIEW_DOCUMENT_LIMIT || !documents.documents.every(isBridgeDocumentIdentity)
    || new Set(documents.documents.map(row => row.tab_id)).size !== documents.documents.length
    || Object.keys(documents).some(key => !['version', 'documents'].includes(key)))) {
    throw new RpcError('invalid_argument', 'The bridge document inventory is invalid.', undefined, 'bridge.capabilityProfile.push');
  }
  const now = (deps.now ?? Date.now)();
  // The registry returns `false` when no record exists for this
  // `client_token_id` — capability push piggybacks on the WS upgrade's
  // `attach` call rather than auto-creating an orphan record (Codex
  // 2026-05-28 Angle 1 fold). Silent no-op here keeps the bridge from
  // looping on push retries in the pre-WS-upgrade-attach window; the
  // rpc reply stays `{ ok: true }` so the bridge doesn't surface a
  // user-visible error for a state it can't act on.
  deps.registry.updateCapabilities(client_token_id, profile, now);
  return { ok: true };
};

export type BridgeCapabilityMethods = 'bridge.capabilityProfile.push';

/** HandlerSlice factory. Composer-side absence (no `registry`) returns
 *  `undefined` so the rpc dispatcher's sparse-map lookup surfaces
 *  `not_configured` (501) to callers — matches the pair / cache /
 *  shared slice convention. */
export const makeBridgeCapabilityHandlers = (
  deps: BridgeCapabilityHandlerDeps | undefined,
): HandlerSlice<ServerRpcRegistry, BridgeCapabilityMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['bridge.capabilityProfile.push'],
    handlers: {
      'bridge.capabilityProfile.push': async (args, client) =>
        handleBridgeCapabilityProfilePush(deps, client.client_token_id, args),
    },
  };
};

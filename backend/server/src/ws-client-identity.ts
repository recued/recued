/** Pure WS-client identity resolvers — the bearer-derived paired-instance
 *  identity (D-151 follow-on) + the self-host owner id (D-156 follow-on).
 *
 *  These live in their own leaf module (not `ws-server.ts`) so the
 *  `*-handler.ts` files can import them at runtime WITHOUT a circular
 *  dependency: `ws-server.ts` imports every `make*Handlers` factory, so the
 *  handler files only ever `import type` from it. This module imports the
 *  `WsClient` shape type-only (erased at runtime), so the runtime graph is
 *  acyclic — both `ws-server.ts` and `pair-handler.ts` depend INTO this leaf.
 *  `ws-server.ts` re-exports all four symbols for back-compat (existing tests
 *  + callers import them from `../ws-server.js`). */

import type { WsClient } from './ws-server.js';

/** D-151 follow-on — derive the paired-instance identity a verified
 *  client token confers, from its `metadata.instance_id`. Returns null
 *  unless the value is a non-empty string AND the instance is not
 *  revoked — mirroring the `register` path's revoke gate so a device
 *  revoked via `pair.revoke` (which marks the `paired_instances` row +
 *  closes the socket but does NOT revoke the surviving `client_tokens`
 *  row) cannot re-derive a usable identity on reconnect. Exported for
 *  direct unit coverage; the upgrade handler is the only caller. */
export const deriveBearerInstanceId = (
  metadataInstanceId: unknown,
  isRevoked: (instanceId: string) => boolean,
): string | null =>
  typeof metadataInstanceId === 'string' &&
  metadataInstanceId.length > 0 &&
  !isRevoked(metadataInstanceId)
    ? metadataInstanceId
    : null;

/** D-151 follow-on — resolve the instance id the rpc paired-client gate
 *  (`requireCallerInstance`) should see for a connection. A registered
 *  extension/bridge keeps its explicit `instance_id` unchanged; a
 *  bearer-only webclient (null `instance_id`) falls back to its
 *  token-derived `token_instance_id`. Used ONLY to build the gated-client
 *  copy handed to rpc handlers — never to mutate the live `clients` map
 *  entry, so `instance_id`-keyed routing/limit paths are unaffected.
 *  Exported for direct unit coverage. */
export const resolveGatedClientInstanceId = (
  client: Pick<WsClient, 'instance_id' | 'token_instance_id'>,
): string | null => client.instance_id ?? client.token_instance_id ?? null;

/** D-156 follow-on — the stable owner id every locally-paired device on a
 *  self-hosted realm shares. The `paired_instances.user_id` column scopes
 *  rows by account for the Cloud-hosted multi-tenant variant; a self-host
 *  server has exactly one user (see `paired-instances-store.ts` header), and
 *  the recovery key binds the realm — not a cloud account. So a bearer-only
 *  webclient, which never reports a cloud `user_id`, is recorded under (and
 *  enumerates / revokes against) this constant. `/auth/pair` seeds new rows
 *  with it; `resolveGatedClientOwnerId` resolves it for the `pair.list` /
 *  `pair.revoke` gate. A cloud-signed-in extension still reports its real
 *  `user_id` on `register` and the upsert overwrites this seed — so the
 *  Cloud path is unchanged (the constant is only the empty-`user_id`
 *  fallback). Distinct from the D-161 `user_self` actor (origin provenance),
 *  which is a different axis. */
export const SELF_HOST_OWNER_ID = 'self';

/** D-156 follow-on — resolve the owner id the `pair.list` / `pair.revoke`
 *  gate should scope to for a connection. A client that reported a cloud
 *  `user_id` on `register` (signed-in extension) keeps it. A verified-bearer
 *  client with no reported user (the self-host webclient — bearer-only, never
 *  `register`s — and a not-signed-in self-host extension) falls back to the
 *  stable `SELF_HOST_OWNER_ID` so its `/auth/pair`-seeded row is enumerable.
 *  An un-bearer-verified / anonymous WS (no `client_token_id`, e.g. the
 *  db-less legacy accept-any path) resolves to `''`, which `handlePairList`
 *  treats as "no account context → empty roster" — fail-closed, matching the
 *  `client_token_id`-as-auth-signal rule in `execution-control-handler.ts`.
 *
 *  The fallback ALSO requires a non-null `resolveGatedClientInstanceId`, i.e.
 *  a currently-valid paired identity. `pair.revoke` marks the
 *  `paired_instances` row revoked + closes the socket but does NOT revoke the
 *  surviving `client_tokens` row (same as the D-151 instance-gate design); so
 *  a revoked device that reconnects on its surviving bearer would still carry
 *  a `client_token_id`. `deriveBearerInstanceId` already revoke-gates its
 *  derived id to null, so `resolveGatedClientInstanceId(client)` is null for a
 *  revoked bearer — keying the owner fallback on it too denies the revoked
 *  device the roster (mirrors the instance-gate's HIGH#1 revoke check; without
 *  it, a revoked webclient could re-enumerate / re-revoke every `self` row).
 *  Exported for direct unit coverage. */
export const resolveGatedClientOwnerId = (
  client: Pick<
    WsClient,
    'user_id' | 'client_token_id' | 'instance_id' | 'token_instance_id'
  >,
): string =>
  client.user_id && client.user_id.length > 0
    ? client.user_id
    : client.client_token_id && resolveGatedClientInstanceId(client) !== null
      ? SELF_HOST_OWNER_ID
      : '';

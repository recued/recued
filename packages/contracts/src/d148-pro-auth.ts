/** D-148 § A.5.3 / § A.6.5 — Pro auth rpc surface contracts.
 *
 *  Server-side persistence of the `pro_subscription_token` bearer the
 *  ACME helper (`/v1/acme/issue-cert`) + DDNS update API
 *  (`/v1/ddns/update`) validate per call. Minting is external —
 *  Stripe-based per § A.13 (future); the marketplace UI hands the user
 *  a bearer token after subscription start; the user pastes it into
 *  Settings → Pro on their own server. There is no `/v1/pro/auth/*`
 *  cloud endpoint in the six-family `CLOUD_PATH_FAMILIES` list
 *  (`cloud-api.ts`); the cloud surface stays narrowed.
 *
 *  Three rpc handlers:
 *    - `pro.authenticate({pro_subscription_token})` — persists the
 *      token + binds the ACME factory's `ProAuthResolver`. Replaces
 *      any prior token (single-slot per § A.5.3).
 *    - `pro.signOut()` — clears the token + un-binds the resolver.
 *      Next renewal cycle reverts to the
 *      `pro_auth_unavailable` → `subscription_required` surface.
 *    - `pro.current()` — read current authentication state for
 *      Settings → Pro to render. Never returns the bearer itself —
 *      only a 4-char suffix for display ("…ab12") + the
 *      `authenticated_at` stamp.
 *
 *  Channel isolation. `pro.` is in `MCP_RESERVED_RPC_PREFIXES` so
 *  external MCP agents cannot mutate the subscription state. A
 *  compromised agent must never be able to force `signOut()` (which
 *  would stop cert renewals) or `authenticate(...)` (which would
 *  swap in an attacker-controlled bearer). */

/** Closed list of `pro.*` rpc error codes. Same exhaustiveness ratchet
 *  discipline as `HANDLE_RPC_ERROR_CODES` — the unit-test pair (the
 *  D-148 Phase 8 pro-auth wiring test + the contracts ratchet sentinel)
 *  asserts the array's membership equals the type's at compile time so
 *  any future code added to the union extends this array in lockstep. */
export type ProAuthRpcErrorCode =
  | 'pro_auth_token_invalid'
  | 'pro_auth_not_authenticated';

/** Closed enumeration of `ProAuthRpcErrorCode`. Keep in lockstep with
 *  the union literally above. */
export const PRO_AUTH_RPC_ERROR_CODES: ReadonlyArray<ProAuthRpcErrorCode> = [
  'pro_auth_token_invalid',
  'pro_auth_not_authenticated',
] as const;

/** Soft upper bound on `pro_subscription_token` byte length. Stripe's
 *  signed-JWT bearer tokens come in well under 4 KB; the cap rejects
 *  pathological payloads at the rpc boundary before they hit the
 *  store. */
export const PRO_AUTH_TOKEN_MAX_BYTES = 4 * 1024;

/** Lower bound on `pro_subscription_token` byte length. The rpc
 *  surface uses `token.slice(-4)` as the display-only `token_suffix`
 *  in `pro.current`; tokens shorter than this would leak the entire
 *  bearer (or most of it) through that affordance and violate the
 *  display-only contract. Real-world Pro subscription bearers (signed
 *  JWTs / Stripe `sk_*` tokens / opaque cloud tokens) are all well
 *  above this floor; the cap rejects pathological inputs at the rpc
 *  boundary. 16 bytes guarantees the 4-char suffix reveals at most
 *  25% of the token. */
export const PRO_AUTH_TOKEN_MIN_BYTES = 16;

/** `pro.authenticate` rpc request shape. */
export interface ProAuthenticateRequest {
  /** Bearer token from the Pro subscription start flow. Sent as
   *  `Authorization: Bearer <token>` on cloud helper calls. */
  pro_subscription_token: string;
}

/** `pro.authenticate` rpc response shape. */
export interface ProAuthenticateResponse {
  authenticated: true;
  /** Unix-ms when this slot was last (re-)authenticated. The store
   *  resets this on every successful `authenticate` call. */
  authenticated_at: number;
}

/** `pro.signOut` rpc request shape. Empty for now. */
export type ProSignOutRequest = Record<string, never>;

/** `pro.signOut` rpc response shape. */
export interface ProSignOutResponse {
  authenticated: false;
}

/** `pro.current` rpc request shape. Empty for now. */
export type ProCurrentRequest = Record<string, never>;

/** `pro.current` rpc response shape. Never carries the bearer — only
 *  a display fragment ("…ab12") plus the timestamp. */
export type ProCurrentResponse =
  | {
      authenticated: true;
      /** Last 4 chars of the bearer for "you are signed in as …ab12"
       *  affordance. Display only; not a verification path. */
      token_suffix: string;
      authenticated_at: number;
    }
  | { authenticated: false };

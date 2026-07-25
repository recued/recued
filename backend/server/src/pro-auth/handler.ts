/** D-148 § A.5.3 / § A.6.5 — `pro.*` rpc handler slice.
 *
 *  Operator-only surface for managing the `pro_subscription_token`
 *  slot the ACME factory's `ProAuthResolver` reads per renewal cycle.
 *  Three methods:
 *
 *    - `pro.authenticate({pro_subscription_token})` — persists the
 *      bearer + (via the state machine's `onStateChanged` listener
 *      wired in bin.ts) flips the `ProAuthResolver` ref so the next
 *      renewal cycle picks it up.
 *    - `pro.signOut()` — clears the slot. Renewer reverts to
 *      `pro_auth_unavailable` → `subscription_required` (Settings →
 *      Pro UI surface).
 *    - `pro.current()` — read current authentication state for the
 *      Settings → Pro UI. Returns ONLY `authenticated: false` or
 *      `{authenticated: true, token_suffix, authenticated_at}` —
 *      never the bearer itself.
 *
 *  Token validation. The substrate accepts any non-empty string under
 *  `PRO_AUTH_TOKEN_MAX_BYTES`. The cloud helper performs the real
 *  validation per call — a garbage bearer fails as a synthetic HTTP
 *  4xx that the renewer maps to `subscription_required`.
 *
 *  Channel isolation. `pro.` is in `MCP_RESERVED_RPC_PREFIXES` —
 *  external MCP agents cannot reach this handler. The ratchet test in
 *  the D-148 pro-auth wiring test asserts the prefix stays reserved. */

import {
  PRO_AUTH_TOKEN_MAX_BYTES,
  PRO_AUTH_TOKEN_MIN_BYTES,
  RpcError,
} from '@recued/contracts';
import type {
  HandlerSlice,
  ProAuthenticateResponse,
  ProCurrentResponse,
  ProSignOutResponse,
  ServerRpcRegistry,
} from '@recued/contracts';

import type { WsClient } from '../ws-server.js';
import type { ProAuthStateMachine } from './index.js';

export interface ProAuthRpcDeps {
  machine: ProAuthStateMachine;
}

/** Last 4 chars of the bearer — for "you are signed in as …ab12"
 *  affordance only. Safe to call only after `assertValidToken` has
 *  enforced `PRO_AUTH_TOKEN_MIN_BYTES` (≥ 16 bytes guarantees the
 *  suffix reveals at most 25% of the token). The state machine load
 *  path's structural validator already rejects empty tokens; new
 *  inputs through `pro.authenticate` are gated by the rpc validator
 *  below before reaching the store. */
const tokenSuffix = (token: string): string => token.slice(-4);

/** Reject pathological inputs at the rpc boundary:
 *    - non-string (rpc shape violation),
 *    - byte-length below `PRO_AUTH_TOKEN_MIN_BYTES` (the
 *      display-only `token_suffix` would leak too much of the bearer),
 *    - byte-length above `PRO_AUTH_TOKEN_MAX_BYTES` (pathological
 *      payload).
 *
 *  Real-world Pro subscription bearers (signed JWTs / Stripe
 *  `sk_*` tokens / opaque cloud tokens) all sit comfortably above
 *  the lower bound — the validator catches mistakes, not legitimate
 *  tokens. The cloud helper performs the real bearer validation per
 *  call. */
const assertValidToken = (value: unknown): string => {
  if (typeof value !== 'string') {
    throw new RpcError(
      'bad_request',
      'pro.authenticate: pro_subscription_token must be a string',
      400,
    );
  }
  // Byte-length checks against the contract-defined bounds. The
  // server-side substrate runs on Node, so `Buffer.byteLength` is
  // available. The lower bound enforces the display-only contract on
  // `pro.current`'s `token_suffix`; the upper bound rejects
  // pathological payloads before they hit the store.
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < PRO_AUTH_TOKEN_MIN_BYTES) {
    throw new RpcError(
      'bad_request',
      `pro.authenticate: pro_subscription_token must be at least ${PRO_AUTH_TOKEN_MIN_BYTES} bytes ` +
        '(shorter tokens would leak the bearer through the display-only token_suffix)',
      400,
    );
  }
  if (bytes > PRO_AUTH_TOKEN_MAX_BYTES) {
    throw new RpcError(
      'bad_request',
      `pro.authenticate: pro_subscription_token exceeds ${PRO_AUTH_TOKEN_MAX_BYTES} bytes`,
      400,
    );
  }
  return value;
};

export const handleProAuthenticate = async (
  deps: ProAuthRpcDeps,
  args: { pro_subscription_token?: unknown },
  ctx: WsClient,
): Promise<ProAuthenticateResponse> => {
  if (ctx.instance_id === null) {
    throw new RpcError(
      'forbidden',
      'pro.authenticate: operator-only surface — caller must complete pair registration',
      401,
    );
  }
  const token = assertValidToken(args.pro_subscription_token);
  const next = await deps.machine.authenticate({
    pro_subscription_token: token,
  });
  return {
    authenticated: true,
    authenticated_at: next.authenticated_at,
  };
};

export const handleProSignOut = async (
  deps: ProAuthRpcDeps,
  _args: Record<string, unknown>,
  ctx: WsClient,
): Promise<ProSignOutResponse> => {
  if (ctx.instance_id === null) {
    throw new RpcError(
      'forbidden',
      'pro.signOut: operator-only surface — caller must complete pair registration',
      401,
    );
  }
  await deps.machine.signOut();
  return { authenticated: false };
};

export const handleProCurrent = async (
  deps: ProAuthRpcDeps,
  _args: Record<string, unknown>,
  ctx: WsClient,
): Promise<ProCurrentResponse> => {
  if (ctx.instance_id === null) {
    throw new RpcError(
      'forbidden',
      'pro.current: operator-only surface — caller must complete pair registration',
      401,
    );
  }
  const state = await deps.machine.current();
  if (state === null) return { authenticated: false };
  return {
    authenticated: true,
    token_suffix: tokenSuffix(state.pro_subscription_token),
    authenticated_at: state.authenticated_at,
  };
};

export const makeProAuthHandlers = (
  deps: ProAuthRpcDeps | undefined,
):
  | HandlerSlice<
      ServerRpcRegistry,
      'pro.authenticate' | 'pro.signOut' | 'pro.current',
      WsClient
    >
  | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['pro.authenticate', 'pro.signOut', 'pro.current'],
    handlers: {
      'pro.authenticate': async (args, ctx) =>
        handleProAuthenticate(
          deps,
          args as Parameters<typeof handleProAuthenticate>[1],
          ctx,
        ),
      'pro.signOut': async (args, ctx) =>
        handleProSignOut(deps, args as Record<string, unknown>, ctx),
      'pro.current': async (args, ctx) =>
        handleProCurrent(deps, args as Record<string, unknown>, ctx),
    },
  };
};

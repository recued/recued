/** Auth rpc handlers — unlock flow for server-side encryption.
 *
 *  Five methods exposed via the generic rpc envelope:
 *
 *    auth.state()           → { state: 'uninitialized' | 'locked' | 'unlocked' }
 *    auth.init(pw)          → { state, recoveryKey }   // first-time setup
 *    auth.unlock(..)        → { state }                // password or recoveryKey
 *    auth.lock()            → { state }                // manual re-lock
 *    auth.rotatePassword(.) → { ok: true }
 *
 *  Handlers return the bare response on success and throw `RpcError`
 *  on failure. The WS dispatcher wraps the throw into the wire
 *  envelope with the carried `status` and `code`.
 *
 *  Wrong credentials surface as `unauthorized` (401) with a generic
 *  message — we never leak which of password/recoveryKey was tried
 *  or whether a bundle exists (the state rpc surfaces that separately).
 */

import {
  RpcError,
  type HandlerSlice,
  type ServerAuthState,
  type ServerRpcRegistry,
} from '@recued/contracts';
import type { KeyManager } from './key-manager.js';
import type { WsClient } from './ws-server.js';

export interface AuthDeps {
  keys: KeyManager;
}

// ────────────────────────────────────────────────────────────────
// auth.state
// ────────────────────────────────────────────────────────────────

export const handleAuthState = async (
  deps: AuthDeps,
): Promise<{ state: ServerAuthState }> => ({ state: deps.keys.state() });

// ────────────────────────────────────────────────────────────────
// auth.init
// ────────────────────────────────────────────────────────────────

export const handleAuthInit = async (
  deps: AuthDeps,
  args: { password?: unknown },
): Promise<{ state: ServerAuthState; recoveryKey: string }> => {
  const password = typeof args.password === 'string' ? args.password : '';
  if (!password) {
    throw new RpcError('bad_request', 'password is required', 400);
  }

  try {
    const { recoveryKey } = await deps.keys.init({ password });
    return { state: deps.keys.state(), recoveryKey };
  } catch (err) {
    const msg = (err as Error).message ?? 'init failed';
    // State conflict (already initialized) → 409; malformed → 400.
    const conflict = msg.includes('bundle already exists') || msg.includes('already unlocked');
    throw new RpcError(conflict ? 'already_initialized' : 'bad_request', msg, conflict ? 409 : 400);
  }
};

// ────────────────────────────────────────────────────────────────
// auth.unlock
// ────────────────────────────────────────────────────────────────

export const handleAuthUnlock = async (
  deps: AuthDeps,
  args: { password?: unknown; recoveryKey?: unknown },
): Promise<{ state: ServerAuthState }> => {
  const password = typeof args.password === 'string' ? args.password : undefined;
  const recoveryKey = typeof args.recoveryKey === 'string' ? args.recoveryKey : undefined;

  if (!password && !recoveryKey) {
    throw new RpcError('bad_request', 'password or recoveryKey is required', 400);
  }

  try {
    await deps.keys.unlock({ password, recoveryKey });
    return { state: deps.keys.state() };
  } catch (err) {
    const msg = (err as Error).message ?? 'unlock failed';
    if (msg.includes('no bundle exists')) {
      throw new RpcError('not_initialized', msg, 409);
    }
    // Wrong credentials or tampered bundle. Return a uniform 401 so we
    // don't reveal which branch failed.
    throw new RpcError('unauthorized', 'invalid credentials', 401);
  }
};

// ────────────────────────────────────────────────────────────────
// auth.lock
// ────────────────────────────────────────────────────────────────

export const handleAuthLock = async (
  deps: AuthDeps,
): Promise<{ state: ServerAuthState }> => {
  deps.keys.lock();
  return { state: deps.keys.state() };
};

// ────────────────────────────────────────────────────────────────
// auth.rotatePassword
// ────────────────────────────────────────────────────────────────

export const handleAuthRotatePassword = async (
  deps: AuthDeps,
  args: { oldPassword?: unknown; newPassword?: unknown },
): Promise<{ ok: true }> => {
  const oldPassword = typeof args.oldPassword === 'string' ? args.oldPassword : '';
  const newPassword = typeof args.newPassword === 'string' ? args.newPassword : '';
  if (!oldPassword || !newPassword) {
    throw new RpcError('bad_request', 'oldPassword and newPassword are required', 400);
  }

  try {
    await deps.keys.rotatePassword({ oldPassword, newPassword });
    return { ok: true };
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (msg.includes('unlocked state')) {
      throw new RpcError('not_unlocked', 'server must be unlocked before rotating password', 409);
    }
    // Wrong old password (decryption fails inside cryptoRotatePassword) →
    // uniform 401. Same posture as auth.unlock.
    throw new RpcError('unauthorized', 'invalid credentials', 401);
  }
};

// Recovery key is deliberately NOT rotatable via rpc. It's an immutable
// backup keyed to the bundle's lifetime — rotating would create a way
// for operators to lock themselves out (user changes key, forgets to
// update their written copy, then loses the password). If the recovery
// key is compromised, the correct operator response is to treat the
// whole server as compromised: back up, wipe, re-initialize. The
// @recued/crypto primitive rotateRecoveryKey exists for admin tooling
// but is not exposed on the default server rpc surface.

// ────────────────────────────────────────────────────────────────
// Handler slice — composeHandlers factory
// ────────────────────────────────────────────────────────────────

export type AuthMethods =
  | 'auth.state'
  | 'auth.init'
  | 'auth.unlock'
  | 'auth.lock'
  | 'auth.rotatePassword';

export const makeAuthHandlers = (
  deps: AuthDeps | undefined,
): HandlerSlice<ServerRpcRegistry, AuthMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['auth.state', 'auth.init', 'auth.unlock', 'auth.lock', 'auth.rotatePassword'],
    handlers: {
      'auth.state': async () => handleAuthState(deps),
      'auth.init': async (args) => handleAuthInit(deps, args),
      'auth.unlock': async (args) => handleAuthUnlock(deps, args),
      'auth.lock': async () => handleAuthLock(deps),
      'auth.rotatePassword': async (args) => handleAuthRotatePassword(deps, args),
    },
  };
};

/** Runtime role — identifies whether code is running on the server or extension.
 *
 *  Set at build time via esbuild `define` or at startup via `setRole()`.
 *
 *  Extension build (esbuild):
 *    define: { '__RECUED_ROLE__': '"extension"' }
 *    → ROLE.current === 'extension', dead code eliminated
 *
 *  Server (no bundler):
 *    import { setRole } from '@recued/contracts';
 *    setRole('server');
 *
 *  Any package:
 *    import { ROLE } from '@recued/contracts';
 *    if (ROLE.isServer) { ... }
 */

export type RuntimeRole = 'server' | 'extension';

/** Build-time constant. Replaced by esbuild's `define` in bundled builds.
 *  Falls back to undefined when running unbundled (server via tsx). */
declare const __RECUED_ROLE__: RuntimeRole | undefined;

let _role: RuntimeRole | null =
  typeof __RECUED_ROLE__ !== 'undefined' ? __RECUED_ROLE__ : null;

/** The current runtime role. */
export const ROLE = {
  get current(): RuntimeRole {
    if (!_role) throw new Error('ROLE not set — call setRole() at startup or define __RECUED_ROLE__ at build time');
    return _role;
  },
  get isServer(): boolean { return _role === 'server'; },
  get isExtension(): boolean { return _role === 'extension'; },
};

/** Set the runtime role. For unbundled entry points (server CLI).
 *  No-op if already set to the same value (idempotent for re-imports). */
export const setRole = (role: RuntimeRole): void => {
  if (_role && _role !== role) {
    throw new Error(`ROLE already set to '${_role}', cannot change to '${role}'`);
  }
  _role = role;
};

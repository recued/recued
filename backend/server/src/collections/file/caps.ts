/** Phase 7 (D-110) — capability validation + serialization helpers.
 *
 *  `FileCollectionCaps` lives in `@recued/contracts`; this module
 *  holds the server-side helpers that turn adapter probe results into
 *  the canonical caps shape, and gate ingredients / rpc on effective
 *  caps (caps AND auth_state === 'healthy').
 *
 *  The helpers are pure — no DB, no adapter wiring. Callers (enroll
 *  rpc, parseRecipe, ingredient dispatcher) combine them with the
 *  instance-store to make decisions. */

import type {
  CollectionAuthState,
  FileCollectionCaps,
} from '@recued/contracts';

/** Caps keys a recipe step can require. `read` is implicit (every
 *  adapter has it); we only gate on the mutating ones. */
export type CapRequirement = 'write' | 'delete';

/** The contract every file adapter's `probeCaps` returns. Adapters
 *  can promise a subset and let the helper fill in safe defaults —
 *  write/delete default to `'no'`, watch/mirror/auth/path_style have
 *  no defaults and must be provided. */
export type ProbedCaps = Pick<
  FileCollectionCaps,
  'read' | 'write' | 'delete' | 'watch' | 'mirror' | 'auth' | 'path_style'
>;

export const isHealthy = (state: CollectionAuthState): boolean =>
  state === 'healthy';

/** Returns a new caps shape where every field is forced to `'no'` /
 *  `'none'` when auth is not healthy. Used at dispatch time so the
 *  engine's gate uses the effective caps rather than the cached ones
 *  when a token has expired. */
export const effectiveCaps = (
  caps: FileCollectionCaps,
  auth_state: CollectionAuthState,
): FileCollectionCaps => {
  if (isHealthy(auth_state)) return caps;
  return {
    ...caps,
    write: 'no',
    delete: 'no',
    watch: 'none',
  };
};

/** Does this set of caps permit the requested mutation? Callers use
 *  this in the gating layer — parseRecipe at install time, ingredient
 *  dispatcher at runtime. */
export const hasCap = (
  caps: FileCollectionCaps,
  requirement: CapRequirement,
): boolean => caps[requirement] === 'yes';

export class CapsValidationError extends Error {
  constructor(public readonly field: string, message: string) {
    super(message);
    this.name = 'CapsValidationError';
  }
}

const isYesNo = (v: unknown): v is 'yes' | 'no' => v === 'yes' || v === 'no';

const isWatch = (v: unknown): v is FileCollectionCaps['watch'] =>
  v === 'realtime' || v === 'poll' || v === 'none';

const isMirror = (v: unknown): v is FileCollectionCaps['mirror'] =>
  v === 'optional' || v === 'required' || v === 'disabled';

const isAuth = (v: unknown): v is FileCollectionCaps['auth'] =>
  v === 'none' || v === 'oauth' || v === 'keys';

const isPathStyle = (v: unknown): v is FileCollectionCaps['path_style'] =>
  v === 'posix' || v === 's3-key' || v === 'uri';

/** Run a complete shape validation. Used at the enroll-rpc boundary
 *  so a misbehaving adapter can't poison the DB with a malformed
 *  caps record. Throws `CapsValidationError` on the first failing
 *  field. */
export const validateCaps = (
  input: unknown,
): FileCollectionCaps => {
  if (!input || typeof input !== 'object') {
    throw new CapsValidationError('', 'caps must be an object');
  }
  const obj = input as Record<string, unknown>;

  if (obj.read !== 'yes') {
    throw new CapsValidationError('read', `read must be 'yes' (got ${String(obj.read)})`);
  }
  if (!isYesNo(obj.write)) {
    throw new CapsValidationError('write', `write must be 'yes' | 'no'`);
  }
  if (!isYesNo(obj.delete)) {
    throw new CapsValidationError('delete', `delete must be 'yes' | 'no'`);
  }
  if (!isWatch(obj.watch)) {
    throw new CapsValidationError('watch', `watch must be 'realtime' | 'poll' | 'none'`);
  }
  if (!isMirror(obj.mirror)) {
    throw new CapsValidationError('mirror', `mirror must be 'optional' | 'required' | 'disabled'`);
  }
  if (!isAuth(obj.auth)) {
    throw new CapsValidationError('auth', `auth must be 'none' | 'oauth' | 'keys'`);
  }
  if (!isPathStyle(obj.path_style)) {
    throw new CapsValidationError('path_style', `path_style must be 'posix' | 's3-key' | 'uri'`);
  }

  return {
    read: 'yes',
    write: obj.write,
    delete: obj.delete,
    watch: obj.watch,
    mirror: obj.mirror,
    auth: obj.auth,
    path_style: obj.path_style,
  };
};

/** D-118 Phase 4 — checker dispatcher.
 *
 *  `runCheck(spec, ctx, config)` is the only public entry point
 *  for the checker registry. The dispatcher:
 *
 *    1. Resolves `{{config.*}}` interpolations in every string
 *       leaf of the check spec (per spec line 490 — checks can
 *       reference instance config via `{{config.port}}` etc.).
 *    2. Refuses unknown kinds (closed registry — every legal
 *       kind lives in `SERVICE_CHECK_KINDS`).
 *    3. Validates params against the per-kind schema. Manifest
 *       authoring errors fail loud with `CheckerParamError`.
 *    4. Calls the right handler and returns the uniform
 *       `ServiceCheckResult`.
 *
 *  The `{ kind: "install_check" }` alias used by `health_check`
 *  (spec line 493) is resolved by the caller — the supervisor
 *  substitutes the declared `install_check` spec before reaching
 *  the dispatcher. This module treats it as an unknown kind.
 */
import {
  SERVICE_CHECK_KINDS,
  type ServiceCheckKind,
  type ServiceCheckResult,
} from '@recued/contracts';

import { binaryInPathChecker } from './binary-in-path.js';
import { execOkChecker } from './exec-ok.js';
import { fileExistsChecker } from './file-exists.js';
import { httpOkChecker } from './http-ok.js';
import { pidFileChecker } from './pid-file.js';
import { tcpOpenChecker } from './tcp-open.js';
import {
  CheckerParamError,
  type CheckerContext,
} from './types.js';
import { hasOwnSafe, setSafeKey } from '../key-safety.js';

/** Polymorphic registry entry — per-kind modules carry their
 *  narrow params type; the dispatcher routes them uniformly via
 *  `never` in the contravariant position (mirrors the installer
 *  dispatcher's pattern). Callers see the unified
 *  `runCheck(raw, ctx, config)` signature. */
interface RegistryEntry {
  validate: (raw: unknown) => unknown;
  check: (params: never, ctx: CheckerContext) => Promise<ServiceCheckResult>;
}

/** Registry — closed map from kind to module. New kinds: append
 *  here AND to `SERVICE_CHECK_KINDS` in contracts. The `satisfies`
 *  clause keeps the two in sync (every kind in the contract enum
 *  must have a registry entry). */
const REGISTRY = {
  binary_in_path: binaryInPathChecker,
  file_exists: fileExistsChecker,
  http_ok: httpOkChecker,
  tcp_open: tcpOpenChecker,
  pid_file: pidFileChecker,
  exec_ok: execOkChecker,
} satisfies Record<ServiceCheckKind, RegistryEntry>;

const isKnownKind = (kind: unknown): kind is ServiceCheckKind =>
  typeof kind === 'string' &&
  (SERVICE_CHECK_KINDS as readonly string[]).includes(kind);

/** `{{config.X}}` ref matcher. Only `config` is recognised —
 *  checker params never reference `vault` / `step` / `item` etc.
 *  per spec line 490. Unknown namespaces or interpolation of
 *  non-config refs are left as-is so the downstream validator
 *  surfaces the authoring error ("port must be a number" rather
 *  than "url contains unresolved {{step.foo}}"). */
const CONFIG_REF_PATTERN = /\{\{\s*config\.([^}:\s]+)(?:\s*:\s*([a-z]+))?\s*\}\}/g;

const interpolateString = (
  str: string,
  config: Record<string, unknown>,
): unknown => {
  // Pure ref — preserve type (`{{config.port}}` → 11434, not "11434").
  const pure = str.match(/^\s*\{\{\s*config\.([^}:\s]+)\s*\}\}\s*$/);
  if (pure) {
    const path = pure[1];
    const resolved = walkPath(config, path);
    return resolved === undefined ? str : resolved;
  }
  // Interpolation — replace each ref with its stringified value.
  return str.replace(CONFIG_REF_PATTERN, (match, path: string) => {
    const resolved = walkPath(config, path);
    if (resolved == null) return match;
    return typeof resolved === 'object'
      ? JSON.stringify(resolved)
      : String(resolved);
  });
};

/** Dot-walk helper. Mirrors `walkPath` in @recued/contracts but
 *  scoped here so the dispatcher doesn't need the full
 *  NamespaceStores machinery for one namespace. */
const walkPath = (obj: unknown, path: string): unknown => {
  let cur = obj;
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    if (!hasOwnSafe(cur as Record<string, unknown>, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
};

/** Recursively resolve every string leaf in the spec. Arrays +
 *  objects recurse; primitives pass through. Depth cap prevents
 *  stack overflow on malicious payloads (mirrors
 *  `resolveDeep`'s 50-level ceiling in contracts). */
const resolveConfigRefs = (
  value: unknown,
  config: Record<string, unknown>,
  depth = 0,
): unknown => {
  if (depth > 50) return value;
  if (typeof value === 'string') return interpolateString(value, config);
  if (Array.isArray(value)) {
    return value.map((v) => resolveConfigRefs(v, config, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      setSafeKey(out, k, resolveConfigRefs(v, config, depth + 1));
    }
    return out;
  }
  return value;
};

/** Public entry point. Accepts the raw check spec
 *  (`{ kind, ...params }`) plus the per-instance config used to
 *  resolve `{{config.*}}` refs. Closed registry — unknown kinds
 *  throw `CheckerParamError` rather than silently skipping. */
export const runCheck = async (
  rawSpec: unknown,
  ctx: CheckerContext = {},
  config: Record<string, unknown> = {},
): Promise<ServiceCheckResult> => {
  const resolved = resolveConfigRefs(rawSpec, config);
  if (resolved === null || typeof resolved !== 'object') {
    throw new CheckerParamError(
      'binary_in_path' as ServiceCheckKind,
      'check spec must be an object',
    );
  }
  const spec = resolved as Record<string, unknown>;
  const kind = spec.kind;
  if (!isKnownKind(kind)) {
    throw new CheckerParamError(
      // We don't know the kind yet, but surface a precise message.
      'binary_in_path' as ServiceCheckKind,
      `unknown check kind '${String(kind)}' — must be one of ${SERVICE_CHECK_KINDS.join(', ')}`,
    );
  }
  const entry = REGISTRY[kind];
  // strip `kind` so per-kind validators see only their params
  const { kind: _drop, ...rest } = spec;
  void _drop;
  const params = entry.validate(rest);
  // Type punning — validate's return shape always matches what
  // check expects for the same kind, by construction.
  const checkFn = entry.check as (
    p: unknown,
    c: CheckerContext,
  ) => Promise<ServiceCheckResult>;
  return checkFn(params, ctx);
};

export type { CheckerContext } from './types.js';
export { CheckerParamError } from './types.js';

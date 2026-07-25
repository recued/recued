import type { Namespace } from './namespaces.js';
import { NS } from './namespaces.js';
import {
  MEMORY_DATA_ALIAS_SUBNAMESPACE,
  MEMORY_DATA_SUBNAMESPACE,
} from './memory.js';
import { tryRewriteVendorEnrichmentAlias } from './connection-vendor-aliases.js';
import { tryRewriteCrmAlias } from './connection-vendor-crm-aliases.js';
import { activeVendorAliasRegistry } from './vendor-alias-registry.js';
import type { RefHint } from './values.js';
import { isRefHint, isRef, hasInterpolation } from './values.js';
import { soqlLikeOperand, soqlQuotedLiteral } from './soql.js';

const PROTOTYPE_SENSITIVE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** `account`, `prefs`, `shared`, `data`, `connection`, `item`, and
 *  `trigger` are optional — not every execution carries them. `account`
 *  may be missing on free-tier / ext-only / pre-sign-in runs (D-100).
 *  `prefs` is infrastructure-only and typically unused from
 *  ref-resolution (the cache/broadcast layers consume it directly);
 *  engines that don't wire it still type-check. `shared` + `data` (the
 *  D-103 `shared.*` and `data.shared.*` namespaces plus later-phase
 *  `data.{platform}.{slug}.*` warehouse families) are populated lazily
 *  by the pre-fetch resolver before each step — when a recipe doesn't
 *  reference them, the engine leaves the store undefined.
 *  `connection` (D-125 Phase 1.1) is hydrated at recipe-execution
 *  start from the per-pair connection store; recipes that don't
 *  reference `connection.*` resolve through an undefined store
 *  (`walkPath` is null-safe end-to-end). `item` is populated per-
 *  iteration inside a `foreach` loop. `trigger` (D-115 Phase 5) is
 *  populated by the executor after the `trigger_steps` phase passes
 *  the `should_run` gate — missing on manual / cron runs. Undefined
 *  reads resolve to undefined per walkPath's null-safety. `contract`
 *  (D-165/D-166) is gateway-internal storage and is NEVER hydrated into
 *  the resolver (it's absent from `NS`); it's optional here so callers
 *  needn't supply it, and any stray `{{contract.*}}` — already rejected
 *  by the validator — resolves to undefined. */
type OptionalNamespace = 'account' | 'prefs' | 'shared' | 'data' | 'connection' | 'item' | 'trigger' | 'contract';
type RequiredNamespace = Exclude<Namespace, OptionalNamespace>;
export type NamespaceStores =
  & Record<RequiredNamespace, Record<string, unknown>>
  & Partial<Record<OptionalNamespace, Record<string, unknown>>>;

/** Walk a dot-notation path through an object, null-safe. Numeric
 *  segments index arrays (e.g. `"items.0.name"` → `items[0].name`). */
export const walkPath = (obj: unknown, path: string): unknown => {
  let current = obj;
  for (const seg of path.split('.')) {
    if (PROTOTYPE_SENSITIVE_KEYS.has(seg)) return undefined;
    if (current == null) return undefined;
    const n = Number(seg);
    if (!isNaN(n) && Array.isArray(current)) {
      current = current[n];
      continue;
    }
    if (
      (typeof current !== 'object' && typeof current !== 'function') ||
      !Object.prototype.hasOwnProperty.call(current, seg)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
};

/** D-120 Phase 4 — `data.audit.*` ↔ `data.memory.*` alias. The audit
 *  sub-namespace is preserved for one release cycle so the published
 *  marketplace corpus migrates without a hard break; the validator
 *  emits a soft-warn on `data.audit.*` use. The alias collapse here
 *  is a pure path rewrite — hosts only ever populate
 *  `stores.data.memory`, and `walkPath` traverses the same backing
 *  object for both names without any extra plumbing.
 *
 *  `audit` already resolves to null inside `parseDataEntityRef`
 *  (`packages/contracts/src/links.ts`) so engine link emission also
 *  treats both names identically. */
const aliasDataMemoryPath = (path: string): string => {
  const dot = path.indexOf('.');
  if (dot === -1) {
    return path === MEMORY_DATA_ALIAS_SUBNAMESPACE
      ? MEMORY_DATA_SUBNAMESPACE
      : path;
  }
  return path.slice(0, dot) === MEMORY_DATA_ALIAS_SUBNAMESPACE
    ? MEMORY_DATA_SUBNAMESPACE + path.slice(dot)
    : path;
};

/** Parse "ns.path" or "ns.path:hint" into parts. Applies the canonical
 *  path rewrites (the `data.audit` → `data.memory` alias collapse + the
 *  D-129/D-130 vendor / CRM enrichment aliases), so consumers that
 *  CLASSIFY refs by namespace+path (the D-177 P5b open-projection walker)
 *  see the same canonical form the resolver walks. Exported for that
 *  walker; resolution-side callers keep using `resolveRef` / `resolveValue`. */
export const parseRef = (inner: string): { ns: string; path: string; hint?: RefHint } => {
  const dot = inner.indexOf('.');
  const ns = dot === -1 ? inner : inner.slice(0, dot);
  let path = dot === -1 ? '' : inner.slice(dot + 1);
  let hint: RefHint | undefined;
  const colon = path.lastIndexOf(':');
  if (colon !== -1) {
    const candidate = path.slice(colon + 1);
    if (isRefHint(candidate)) {
      hint = candidate;
      path = path.slice(0, colon);
    }
  }
  // D-120 Phase 4 — collapse `data.audit.*` onto `data.memory.*` at
  // the resolver boundary so hosts only populate one backing object.
  // D-129 Phase 7 — collapse the cosmetic vendor alias
  // `data.<vendor>.<entity>.<id>.enrichments[.<rest>]` onto canonical
  // `data.enrichment.connection.api.<vendor>.<entity>.<id>[.<rest>]`
  // so hosts populate only one backing object (the existing enrichment
  // store) and both forms walk the same tree.
  // D-130 Phase 7 — collapse the cross-vendor alias
  // `data.crm.<crm_alias>.<full_target_id>.enrichments[.<rest>]` onto
  // the canonical D-128 path via the registry's `crm_alias` annotation
  // and the `<full_target_id>`'s vendor-prefix discriminator.
  if (ns === 'data') {
    path = aliasDataMemoryPath(path);
    // D-192 unit-3 — dispatch both alias rewrites against the LIVE merged
    // registry (server binds it via `setVendorAliasRegistryResolver`) so a
    // pack-declared CRM's refs rewrite; unbound → frozen builtin.
    const registry = activeVendorAliasRegistry();
    const crmAliased = tryRewriteCrmAlias(path, registry);
    if (crmAliased !== null) path = crmAliased;
    else {
      const aliased = tryRewriteVendorEnrichmentAlias(path, registry);
      if (aliased !== null) path = aliased;
    }
  }
  return { ns, path, hint };
};

/** String form of a resolved value in TEXT position — interpolation
 *  fragments, the format-hint fallback, and `map`'s item-ref substitution.
 *
 *  Scalars keep `String()` verbatim, and a SCALAR-ONLY array keeps the
 *  legacy comma join ("a,b,c") — live consumers (http querystring
 *  interpolation, display lines) rely on that join and it was never
 *  garbage. Every value `String()` would garble into "[object Object]" —
 *  a plain object, or an array carrying any object element — renders as
 *  compact JSON instead, so structured data SURVIVES into prompt strings
 *  (pre-fix, ~15 shipped ai-prompt recipes egressed no payload at all).
 *  Compact JSON matches `resolveNested`'s object rendering, so nested and
 *  top-level interpolation now agree on objects; the nested path's
 *  scalar-array rendering ("[1,2]", dynamic-KEY position) keeps its
 *  pre-existing divergence from the join — see `resolveNested`. */
export const interpolationText = (value: unknown): string => {
  if (value == null) return '';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value) && value.every((el) => el === null || typeof el !== 'object')) {
    return String(value);
  }
  return JSON.stringify(value) ?? '';
};

/** Apply a value hint for string interpolation. Uses environment locale (browser or
 *  Node) for the display hints. */
export const formatHint = (value: unknown, hint: RefHint): string => {
  // Internal SOQL escape hints (build-generated by the connection-agnostic search
  // builder, B1) run BEFORE the null-guard: a SOQL value position needs a
  // syntactically valid literal even for a null/undefined ref (`''`), never the bare
  // empty string the display hints return — that would malform the query.
  if (hint === 'soql_string') return soqlQuotedLiteral(value);
  if (hint === 'soql_like') return soqlLikeOperand(value);
  if (value == null) return '';
  const n = Number(value);
  if (hint === 'number' && !isNaN(n)) return new Intl.NumberFormat().format(n);
  if (hint === 'currency' && !isNaN(n)) return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(n);
  if (hint === 'percent' && !isNaN(n)) return new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 }).format(n);
  if (hint === 'date' && typeof value === 'string') {
    const d = new Date(value);
    return isNaN(d.getTime()) ? String(value) : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(d);
  }
  if (hint === 'relative' && typeof value === 'string') {
    const d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days > 0) return `${days} days ago`;
    return `in ${Math.abs(days)} days`;
  }
  // A hint on a value its branch can't format falls through here — keep the
  // garble-aware text form so a hinted object never renders "[object Object]".
  return interpolationText(value);
};

/** Resolver options. `deferItem` leaves `{{item.*}}` refs intact (raw) so the
 *  consuming transform resolves them itself — `map` rebinds `item` per array
 *  element, so the engine must NOT pre-resolve item refs (it would clobber them
 *  against the unset `item` store, outside a `foreach`). Every OTHER namespace
 *  (config / step / …) still resolves. Default off — no behavior change. */
export interface ResolveOpts {
  deferItem?: boolean;
  /** D-177 P1b — leave `{{vault.*}}` refs intact (raw). The commit Gateway's
   *  action-identity hash basis is the RESOLVED-minus-vault payload (N.2):
   *  config / step / item / context resolve normally, but a vault ref must
   *  never decrypt into the hashed payload — the intact ref string is the
   *  stable, secret-free placeholder. A vault ref nested as a dynamic KEY
   *  inside another ref THROWS instead (codex P2 fold): normal dispatch
   *  resolves the secret first and then the outer path, so the hash path
   *  can neither reproduce the real payload (secret-free by design) nor
   *  substitute a faithful placeholder (the outer value is secret-SELECTED
   *  — resolving the outer ref literally would hash an under-specified
   *  payload that over-matches across different real values). A throw makes
   *  the call non-canonicalizable — the Gateway stamps nothing and the
   *  action can never be grant-matched (fail closed). Default off —
   *  dispatch-layer resolution still decrypts vault refs. */
  deferVault?: boolean;
}

/** Resolve a single {{ns.path}} reference to its value from namespace stores. */
export const resolveRef = (
  ref: string,
  stores: NamespaceStores,
  opts?: ResolveOpts,
): unknown => {
  const inner = ref.slice(2, -2).trim();
  const { ns, path } = parseRef(inner);
  // Defer `{{item.*}}` to the consuming transform (see ResolveOpts). Return the
  // raw ref so it survives to that transform's per-element resolver.
  if (opts?.deferItem && ns === 'item') return ref;
  // Defer `{{vault.*}}` — the intact ref is the secret-free placeholder the
  // D-177 hash basis pins on (see ResolveOpts).
  if (opts?.deferVault && ns === 'vault') return ref;
  if (!NS.has(ns as Namespace)) return undefined;
  const store = stores[ns as Namespace];
  if (store === undefined) return undefined;
  return path ? walkPath(store, path) : store;
};

/** Find the innermost `{{…}}` bounds in a string, or null.
 *
 *  Innermost is detected by starting from the last `{{` occurrence; any
 *  `{{` after it is either inside or part of a sibling that parses the
 *  same way on the next iteration. The matching `}}` is the first one
 *  that appears after that last `{{`. */
const findInnermostBounds = (str: string): { start: number; end: number } | null => {
  const lastOpen = str.lastIndexOf('{{');
  if (lastOpen === -1) return null;
  const close = str.indexOf('}}', lastOpen + 2);
  if (close === -1) return null;
  return { start: lastOpen, end: close + 2 };
};

/** Resolve ONLY the nested (inner) `{{…}}` portions of a template
 *  innermost-first. Stops as soon as no nested refs remain so that the
 *  outer ref is left intact for the caller to resolve with its normal
 *  type-preserving path. Unknown inner namespaces abort the pass so
 *  callers fall back to the original string unchanged. A vault inner ref
 *  under `deferVault` THROWS (see `ResolveOpts.deferVault`): the outer
 *  value is secret-selected, so the hash path has no faithful secret-free
 *  form — neither resolving the secret (leaks it into the hash basis) nor
 *  falling through (hashes an under-specified payload that over-matches)
 *  is sound. Only the hash path sets `deferVault`, so dispatch-time
 *  resolution never sees this throw. */
const resolveNested = (
  str: string,
  stores: NamespaceStores,
  opts?: ResolveOpts,
): string | null => {
  let current = str;
  for (let guard = 0; guard < 64; guard++) {
    if (!hasNestedRef(current)) return current;
    const bounds = findInnermostBounds(current);
    if (!bounds) return current;
    const inner = current.slice(bounds.start + 2, bounds.end - 2).trim();
    const { ns, path, hint } = parseRef(inner);
    if (!NS.has(ns as Namespace)) return null;
    if (opts?.deferVault && ns === 'vault') {
      throw new TypeError(
        'resolveNested: {{vault.*}} nested inside another ref has no '
          + 'secret-free canonical form under deferVault',
      );
    }
    const resolved = path
      ? walkPath(stores[ns as Namespace], path)
      : stores[ns as Namespace];
    const asStr = hint
      ? formatHint(resolved, hint)
      : resolved == null
        ? ''
        : typeof resolved === 'object'
          ? JSON.stringify(resolved)
          : String(resolved);
    current = current.slice(0, bounds.start) + asStr + current.slice(bounds.end);
  }
  return current;
};

/** True iff a `{{…}}` inside the first top-level ref contains another
 *  `{{` (unresolved nested template). Exported for the D-177 P5b
 *  open-projection walker: a dynamic nested key on an authority-bearing
 *  arg is statically unresolvable and refuses `grant_mode: 'open'`
 *  (N.11 rule 2). */
export const hasNestedRef = (str: string): boolean => {
  const open = str.indexOf('{{');
  if (open === -1) return false;
  const close = str.indexOf('}}', open + 2);
  if (close === -1) return false;
  return str.indexOf('{{', open + 2) !== -1 && str.indexOf('{{', open + 2) < close;
};

/** Resolve any value — literal passthrough, pure ref (type-preserved), or interpolation (→ string).
 *
 *  D-103 adds nested-template support. When the value contains nested
 *  `{{…{{…}}…}}`, the innermost refs are resolved first and substituted
 *  as strings; the outer ref is then resolved normally, preserving type
 *  when the original outer wrapper was a pure ref (e.g., dynamic-key
 *  lookup: `"{{data.shared.deal.{{item.id}}}}"` returns the deal object
 *  when found, not a stringified snapshot). */
export const resolveValue = (
  value: unknown,
  stores: NamespaceStores,
  opts?: ResolveOpts,
): unknown => {
  if (!isRef(value)) return value;
  let str = value as string;

  if (hasNestedRef(str)) {
    // `deferItem` intentionally does NOT touch nested resolution: a `{{item.*}}`
    // used as a dynamic KEY inside another ref (`{{data.shared.x.{{item.id}}}}`)
    // is not something a consuming transform can resolve, so it keeps the
    // pre-existing behavior (inner resolves; unset item → '') rather than
    // surfacing dangling braces. Only TOP-LEVEL item refs are deferred (below).
    // `deferVault` DOES reach the nested pass — see resolveNested's doc.
    const flattened = resolveNested(str, stores, opts);
    if (flattened === null) {
      // Inner resolution aborted (unknown namespace). Fall through to
      // the existing interpolation path with the original string so
      // unknown refs surface as the raw `{{…}}` fragment.
    } else {
      str = flattened;
    }
  }

  // Pure reference — preserve type
  if (!hasInterpolation(str)) return resolveRef(str, stores, opts);

  // Interpolation — replace all {{ref}} / {{ref:hint}}, return string
  return str.replace(/\{\{([^}]+)\}\}/g, (_match, inner: string) => {
    const { ns, path, hint } = parseRef(inner.trim());
    // Deferred `{{item.*}}` stays raw for the consuming transform.
    if (opts?.deferItem && ns === 'item') return _match;
    // Deferred `{{vault.*}}` stays raw — the secret-free placeholder.
    if (opts?.deferVault && ns === 'vault') return _match;
    if (!NS.has(ns as Namespace)) return _match;
    const resolved = walkPath(stores[ns as Namespace], path);
    if (hint) return formatHint(resolved, hint);
    return interpolationText(resolved);
  });
};

/** True when the value is a single `{{…}}` with no top-level text
 *  around it (ignoring nesting inside). */
const isOuterSingleRef = (str: string): boolean => {
  if (!(str.startsWith('{{') && str.endsWith('}}'))) return false;
  // Walk from position 2, tracking `{{`/`}}` depth. The first time depth
  // drops back to 0 should coincide with the final `}}` of the string.
  // Hitting depth 0 any sooner means the outer ref ended and more text
  // follows — that's not a pure outer ref.
  let depth = 1;
  let i = 2;
  while (i < str.length - 1) {
    if (str.startsWith('{{', i)) { depth++; i += 2; continue; }
    if (str.startsWith('}}', i)) {
      depth--;
      if (depth === 0) return i + 2 === str.length;
      i += 2; continue;
    }
    i++;
  }
  return false;
};

/** Collect every `{{ns.path}}` reference appearing inside a JSON value
 *  (step spec, recipe fragment, ingredient input, …). Returned list is:
 *    - de-duplicated by the ref's `ns.path` (format hints stripped)
 *    - sorted in first-occurrence order (stable across calls)
 *
 *  Walks strings for both pure refs (`"{{config.x}}"`) and interpolated
 *  fragments (`"Hello {{config.name}}!"`). Dives arrays + objects
 *  uniformly. Depth-capped to match `resolveDeep`. Used by the engine's
 *  step-cache seed parser to enumerate dependencies once at parse time
 *  and resolve them at execute time. */
export const collectRefs = (obj: unknown): Array<{ ns: string; path: string }> => {
  const seen = new Set<string>();
  const result: Array<{ ns: string; path: string }> = [];

  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_RESOLVE_DEPTH) return;
    if (typeof value === 'string') {
      // Match every `{{...}}` fragment — works for both pure refs and
      // interpolated substrings. The inner parseRef strips any format
      // hint so `{{config.x:currency}}` and `{{config.x}}` share an
      // entry (same dependency, different rendering).
      const matches = value.matchAll(/\{\{([^}]+)\}\}/g);
      for (const m of matches) {
        const { ns, path } = parseRef(m[1].trim());
        if (!NS.has(ns as Namespace)) continue;
        const key = `${ns}.${path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ ns, path });
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (value != null && typeof value === 'object') {
      for (const v of Object.values(value as Record<string, unknown>)) {
        visit(v, depth + 1);
      }
    }
  };

  visit(obj, 0);
  return result;
};

const MAX_RESOLVE_DEPTH = 50;

/** Recursively resolve all {{ref}} values in an object/array tree.
 *  Depth is capped at 50 levels to prevent stack overflow from
 *  deeply nested recipe output or malicious payloads. */
export const resolveDeep = (
  obj: unknown,
  stores: NamespaceStores,
  opts?: ResolveOpts,
  _depth = 0,
): unknown => {
  if (_depth > MAX_RESOLVE_DEPTH) return obj; // bail — too deep
  if (typeof obj === 'string') return resolveValue(obj, stores, opts);
  if (Array.isArray(obj)) return obj.map(item => resolveDeep(item, stores, opts, _depth + 1));
  if (obj != null && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      if (PROTOTYPE_SENSITIVE_KEYS.has(key)) continue;
      out[key] = resolveDeep(val, stores, opts, _depth + 1);
    }
    return out;
  }
  return obj;
};
